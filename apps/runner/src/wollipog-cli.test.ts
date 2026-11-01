import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "@wollipog/test-support/bounded-child-process";
import {
  PROTOCOL_VERSION,
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
} from "@wollipog/protocol";
import type { McpFetch } from "./session-management-mcp.js";
import {
  AGENT_CONTROL_RELAY_ENDPOINT_ENV,
  AGENT_CONTROL_RELAY_KEY_ENV,
} from "./agent-control-relay.js";
import type { GhOutcome, GhRunner } from "./campaign-forge-status.js";
import { runPullRequestCli, runWollipogCli, runWollipogInit } from "./wollipog-cli.js";
import { expandCommandAlias, resolveHelp } from "./wollipog-help.js";

test("MCP stays connected beyond the credential deadline and recovers typed decisions after acknowledgment", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-mcp-readiness-"));
  try {
    const script = `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import { PassThrough } from 'node:stream';
      import { rmSync, writeFileSync } from 'node:fs';
      import { createHash } from 'node:crypto';
      import { runAgentControlMcp } from ${JSON.stringify(new URL("./wollipog-cli.ts", import.meta.url).href)};
      const [tokenFile, readyFile] = process.argv.slice(1);
      const input = new PassThrough();
      const output = new PassThrough();
      Object.defineProperty(process, 'stdin', { value: input });
      Object.defineProperty(process, 'stdout', { value: output });
      const responses = new Map();
      output.on('data', chunk => {
        for (const line of chunk.toString().trim().split('\\n')) {
          const response = JSON.parse(line);
          responses.set(response.id, response);
        }
      });
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ url, headers: init.headers });
        return { ok: true, status: 200, text: async () => JSON.stringify({ decision: { occurrenceId: 'decision_1', state: 'approved' } }) };
      };
      const env = {
        WOLLIPOG_CONTROL_PLANE_URL: 'http://cp', WOLLIPOG_SESSION_ID: 's_test',
        WOLLIPOG_SESSION_TOKEN_FILE: tokenFile, WOLLIPOG_SESSION_CREDENTIAL_READY_FILE: readyFile,
      };
      writeFileSync(tokenFile, 'first-test-token');
      mock.timers.enable({ apis: ['Date', 'setTimeout'] });
      const serving = runAgentControlMcp(env);
      mock.timers.tick(11_000);
      await serving;
      const rpc = async (id, method, params) => {
        input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(responses.has(id), 'server must answer ' + method);
        return responses.get(id).result;
      };
      const call = id => rpc(id, 'tools/call', { name: 'get_workflow_decision', arguments: { occurrenceId: 'decision_1' } });
      assert.ok((await rpc(1, 'initialize')).capabilities.tools);
      assert.ok((await rpc(2, 'tools/list')).tools.some(tool => tool.name === 'get_workflow_decision'));
      assert.deepEqual(await rpc(3, 'ping'), {});
      const pending = await call(4);
      assert.equal(pending.isError, true);
      assert.match(pending.content[0].text, /credential.*retry/i);
      assert.equal(calls.length, 0, 'unacknowledged credentials must never reach the control plane');
      const acknowledge = token => writeFileSync(readyFile, createHash('sha256').update(token).digest('hex'));
      acknowledge('wrong-test-token');
      assert.equal((await call(5)).isError, true);
      assert.equal(calls.length, 0);
      acknowledge('first-test-token');
      assert.equal((await call(6)).isError, undefined);
      assert.equal(calls[0].headers.authorization, 'Bearer first-test-token');
      assert.equal(calls[0].headers[${JSON.stringify(WOLLIPOG_AGENT_ACTOR_SESSION_HEADER)}], 's_test');
      writeFileSync(tokenFile, 'second-test-token');
      assert.equal((await call(7)).isError, true, 'old fence cannot authorize a rotated credential');
      assert.equal(calls.length, 1);
      acknowledge('second-test-token');
      assert.equal((await call(8)).isError, undefined);
      assert.equal(calls[1].headers.authorization, 'Bearer second-test-token');
      rmSync(readyFile);
      assert.equal((await call(9)).isError, true, 're-registration removes the fence even for an unchanged token');
      assert.equal(calls.length, 2);
      acknowledge('second-test-token');
      assert.equal((await call(10)).isError, undefined);
      rmSync(tokenFile);
      assert.equal((await call(11)).isError, true, 'temporarily missing credential is retryable');
      assert.equal(calls.length, 3);
      writeFileSync(tokenFile, 'second-test-token');
      assert.equal((await call(12)).isError, undefined);
      assert.equal(calls.length, 4);
      assert.ok([...responses.values()].every(response => !JSON.stringify(response).includes('test-token')));
      mock.timers.reset();
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script,
      join(root, "token"), join(root, "ready")], { encoding: "utf8", timeout: 20_000 });
    assert.equal(child.status, 0, child.stderr);
    const events = child.stderr.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    assert.deepEqual(events.map((entry) => entry.event), [
      "mcp_credential_pending", "mcp_credential_ready", "mcp_credential_pending", "mcp_credential_ready",
      "mcp_credential_pending", "mcp_credential_ready", "mcp_credential_pending", "mcp_credential_ready",
    ]);
    assert.ok(events.every((entry) => entry.sessionId === "s_test" && entry.entryPoint === "mcp"));
    assert.ok(!child.stderr.includes("test-token"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function captureCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", ...argv],
    {},
    { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
    async () => assert.fail("help and fail-closed alias validation must not issue a request"),
  );
  return { code, stdout, stderr };
}

test("CLI root help is identical through help, --help, and -h and covers common operator workflows", async () => {
  const outputs = await Promise.all([["help"], ["--help"], ["-h"]].map(captureCli));
  assert.deepEqual(outputs.map(({ code }) => code), [0, 0, 0]);
  assert.ok(outputs.every(({ stderr }) => stderr === ""));
  assert.equal(outputs[0]!.stdout, outputs[1]!.stdout);
  assert.equal(outputs[0]!.stdout, outputs[2]!.stdout);
  assert.match(outputs[0]!.stdout, /Global Option: --version/u);
  assert.match(outputs[0]!.stdout, /Root Help Options: --help, -h/u);
  assert.match(outputs[0]!.stdout, /Help is always text/u);
  assert.doesNotMatch(outputs[0]!.stdout, /Global Options:.*--help/u);
  for (const expected of [
    "session", "worktree", "admin", "service", "help [topic]", "init", "doctor", "update", "pair <command>",
    "service install", "service status", "pair create", "pair list", "pair revoke", "service logs",
    "service restart", "runner-credential rotate", "service uninstall", "--version",
  ]) assert.match(outputs[0]!.stdout, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("CLI topic help is complete, successful, and side-effect free", async () => {
  const topics: Array<[string, string[]]> = [
    ["doctor", ["admin doctor", "--token-file", "--json"]],
    ["update", ["service upgrade", "--release", "--system", "--json"]],
    ["pair", ["pair create", "pair list", "pair revoke", "pair url", "one-time", "bootstrap"]],
    ["service", ["service install", "service status", "service restart", "service logs", "service upgrade", "service uninstall"]],
    ["admin", ["admin pairing-url", "admin status", "admin doctor", "admin device create", "admin runner-credential"]],
    ["session", ["session list", "session capabilities", "session create", "session wait", "session guardrails", "--effort"]],
    ["worktree", ["worktree create", "worktree attach", "worktree select", "worktree discard", "worktree delete-refs", "packed-refs.lock"]],
    ["issue-closure", ["request --proposal", "execute <occurrence-id>", "protocol v194+", "uncertain"]],
    ["campaign", ["plan --input", "update-item <work-item-id>", "assign <work-item-id>", "adjudicate <recommendation-id>", "work-items", "protocol v196+", "grant no authority"]],
    ["decision", ["decision request", "decision get", "decision consume", "decision reconcile", "request_workflow_decision", "--snapshot"]],
    ["init", ["wollipog init", ".wollipog.json", "does not run", "never overwritten"]],
    ["pr", ["pr wait", "--repo", "--head", "--timeout", "--interval", "--any-failure", "pending, never passing", "124 timeout", "needs no control plane",
      "pr closures", "--intended", "--file", "does not close #N", "Refs #N", "intendedClosures"]],
  ];
  for (const [topic, expected] of topics) {
    const result = await captureCli(["help", topic]);
    assert.equal(result.code, 0, topic);
    assert.equal(result.stderr, "", topic);
    for (const text of expected) assert.ok(result.stdout.includes(text), `${topic} help omits ${text}`);
  }

  assert.deepEqual(await captureCli(["help", "help"]), await captureCli(["help"]));
  const textWithJsonFlag = await captureCli(["help", "pair", "--json"]);
  assert.equal(textWithJsonFlag.code, 0);
  assert.match(textWithJsonFlag.stdout, /^Usage: wollipog pair/u);
});

test("pr wait runs locally through gh with outcome exit codes and never contacts the control plane", async () => {
  const head = "44579c6c25235598f1a28f8ccb0449cb8dbbc810";
  const json = (value: unknown): GhOutcome => ({ stdout: JSON.stringify(value), stderr: "", code: null, timedOut: false });
  const fakeGh = (conclusion: string | null, extra: Record<string, unknown> = {}, admitted = false) => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === "repo") return { stdout: "picoduck/wollipog\n", stderr: "", code: null, timedOut: false };
      if (args.includes("graphql")) {
        return json({ data: { repository: { defaultBranchRef: { name: "main" }, pullRequest: {
          url: "https://github.com/picoduck/wollipog/pull/7", state: "OPEN", isDraft: false, headRefOid: head, baseRefName: "main",
          mergeStateStatus: "BLOCKED", mergeCommit: null, mergeQueueEntry: null,
          createdAt: "2026-10-11T10:00:00Z", timelineItems: { nodes: [{ createdAt: "2026-10-12T09:00:00Z" }] },
          commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [
            { __typename: "CheckRun", name: "CI", status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion, startedAt: "t",
              ...(admitted ? { databaseId: 200 } : {}),
            },
            ...(conclusion === "SKIPPED" && !admitted ? [{ __typename: "CheckRun", name: "Browser", status: "QUEUED", conclusion: null }] : []),
          ] } } } }] },
          ...extra,
        } } } });
      }
      if (args.some((arg) => arg.includes("/rules/branches/"))) {
        return json([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "CI" }] } }]);
      }
      if (args.some((arg) => arg.includes("/check-runs/"))) return json({
        id: 200, head_sha: head, name: "CI", status: "completed", conclusion: "skipped", check_suite: { id: 100 },
      });
      if (args.some((arg) => arg.includes("/attempts/"))) return json({ total_count: 1, jobs: [{
        name: "CI", check_run_url: "https://api.github.com/repos/picoduck/wollipog/check-runs/200",
        run_attempt: 1, status: "completed", conclusion: "skipped",
      }] });
      if (args.some((arg) => arg.includes("/actions/runs?"))) return json({ total_count: 1, workflow_runs: [{
        id: 20, workflow_id: 30, check_suite_id: 100, head_sha: head, event: "pull_request", run_attempt: 1,
        created_at: "2026-10-12T10:00:00Z", status: "completed",
      }] });
      return json({});
    };
    return { gh, calls };
  };
  const run = async (args: string[], gh: GhRunner, graceMs?: number) => {
    let stdout = "";
    let stderr = "";
    const code = await runPullRequestCli(args, true, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
      gh, undefined, graceMs);
    return { code, stdout, stderr };
  };

  const passed = fakeGh("SUCCESS");
  const ok = await run(["pr", "wait", "7", "--json"], passed.gh);
  assert.equal(ok.code, 0);
  assert.equal(JSON.parse(ok.stdout).outcome, "checks_passed");
  assert.deepEqual(passed.calls[0], ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], "a bare number uses this checkout's repository");

  const explicit = fakeGh("FAILURE");
  const failedRun = await run(["pr", "wait", "7", "--repo", "picoduck/wollipog", "--head", head, "--json"], explicit.gh);
  assert.equal(failedRun.code, 3);
  assert.equal(JSON.parse(failedRun.stdout).outcome, "checks_failed");
  assert.equal(explicit.calls.some((args) => args[0] === "repo"), false);

  const pending = await run(["pr", "wait", "picoduck/wollipog#7", "--timeout", "1", "--json"], fakeGh(null).gh);
  assert.equal(pending.code, 124);
  assert.equal(JSON.parse(pending.stdout).outcome, "timeout");

  const skipped = await run(["pr", "wait", "picoduck/wollipog#7", "--head", head, "--timeout", "1", "--json"], fakeGh("SKIPPED").gh);
  assert.equal(skipped.code, 124, "an old skipped draft check cannot certify newly admitted CI");
  assert.equal(JSON.parse(skipped.stdout).outcome, "timeout");
  assert.deepEqual(JSON.parse(skipped.stdout).checks.required, [{ name: "CI", state: "pending", reported: true }]);

  const legitimateSkip = await run(["pr", "wait", "picoduck/wollipog#7", "--head", head, "--timeout", "1000", "--json"],
    fakeGh("SKIPPED", {}, true).gh);
  assert.equal(legitimateSkip.code, 0, "a current admitted skip satisfies the check wait behind an independent gate");
  assert.equal(JSON.parse(legitimateSkip.stdout).outcome, "checks_passed");
  assert.equal(JSON.parse(legitimateSkip.stdout).merged, false);

  const merged = await run(["pr", "wait", "https://github.com/picoduck/wollipog/pull/7", "--json"],
    fakeGh(null, { state: "MERGED", mergeCommit: { oid: head } }).gh);
  assert.equal(merged.code, 0);
  assert.equal(JSON.parse(merged.stdout).merged, true);

  const broken: GhRunner = async () => ({ stdout: "", stderr: "gh: To get started with GitHub CLI, please run:  gh auth login", code: 4, timedOut: false });
  const unreadable = await run(["pr", "wait", "picoduck/wollipog#7", "--json"], broken);
  assert.equal(unreadable.code, 1);
  assert.match(JSON.parse(unreadable.stdout).error, /forge_unauthenticated/u);

  // Resolving the repository is one more read in the wait's budget of the timeout plus the grace.
  // A lookup slower than the timeout but within the grace still yields one snapshot (#3121).
  const slowLookup = (milliseconds: number, rest: GhRunner): GhRunner => async (args, signal) => {
    if (args[0] !== "repo") return rest(args, signal);
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return { stdout: "picoduck/wollipog\n", stderr: "", code: null, timedOut: false };
  };
  const snapshot = await run(["pr", "wait", "7", "--timeout", "1", "--json"], slowLookup(150, fakeGh(null).gh));
  assert.equal(snapshot.code, 124);
  assert.equal(JSON.parse(snapshot.stdout).outcome, "timeout");
  assert.equal(JSON.parse(snapshot.stdout).repository, "picoduck/wollipog");

  // A lookup outlasting the timeout and the grace is killed with the existing --repo guidance.
  let startedAt = Date.now();
  let discoveryKilled = false;
  const hungDiscovery: GhRunner = (_args, signal) => new Promise((resolve) => {
    signal?.addEventListener("abort", () => {
      discoveryKilled = true;
      resolve({ stdout: "", stderr: "killed", code: "ABORT_ERR", timedOut: true });
    }, { once: true });
  });
  const slow = await run(["pr", "wait", "7", "--timeout", "100", "--json"], hungDiscovery, 100);
  assert.equal(slow.code, 1);
  assert.match(JSON.parse(slow.stdout).error, /pass --repo/u);
  assert.equal(discoveryKilled, true);
  const slowMs = Date.now() - startedAt;
  assert.ok(slowMs >= 190 && slowMs < 1_500, `discovery ran until the timeout plus the grace: ${slowMs} ms`);

  // The wait gets only what discovery left of both, so a hung read after it still ends in time.
  startedAt = Date.now();
  let readKilled = false;
  const hungRead: GhRunner = (_args, signal) => new Promise(() => {
    signal?.addEventListener("abort", () => { readKilled = true; }, { once: true });
  });
  const spent = await run(["pr", "wait", "7", "--timeout", "100", "--json"], slowLookup(150, hungRead), 200);
  assert.equal(spent.code, 1);
  assert.equal(readKilled, true);
  const spentMs = Date.now() - startedAt;
  assert.ok(spentMs >= 290 && spentMs < 1_500, `the command ended at the timeout plus the grace: ${spentMs} ms`);
  const fractional = await run(["pr", "wait", "7", "--timeout", "100.5", "--json"], passed.gh);
  assert.equal(fractional.code, 0, "a fractional timeout is floored, never a crash");
  assert.equal(JSON.parse(fractional.stdout).outcome, "checks_passed");

  for (const args of [["pr"], ["pr", "wait"], ["pr", "watch", "7"], ["pr", "wait", "7", "--timeout", "soon"]]) {
    const usage = await run(args, passed.gh);
    assert.equal(usage.code, 2, args.join(" "));
  }

  // The routed command needs no session credential, token, or control-plane URL (captureCli
  // fails any request and passes an empty environment).
  const routed = await captureCli(["pr", "wait", "--json"]);
  assert.equal(routed.code, 2);
  assert.match(JSON.parse(routed.stdout).error, /^Usage: wollipog pr wait/u);
  for (const argv of [["pr", "--help"], ["pr", "wait", "7", "--help"]]) {
    const help = await captureCli(argv);
    assert.equal(help.code, 0, argv.join(" "));
    assert.match(help.stdout, /^Usage: wollipog pr wait/u);
  }
});

test("pr closures reports what merging a pull request or a draft would close, against --intended (#3713)", async () => {
  const head = "44579c6c25235598f1a28f8ccb0449cb8dbbc810";
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "repo") return { stdout: "picoduck/wollipog\n", stderr: "", code: null, timedOut: false };
    return { stdout: JSON.stringify({ data: { repository: { nameWithOwner: "picoduck/wollipog", pullRequest: {
      number: 7, state: "OPEN", headRefOid: head, body: "Refs #3635. This PR does not close #3635.",
      closingIssuesReferences: { nodes: [{ number: 3713, repository: { nameWithOwner: "picoduck/wollipog" } }], pageInfo: { hasNextPage: false } },
    } } } }), stderr: "", code: null, timedOut: false };
  };
  const run = async (args: string[], runner: GhRunner = gh) => {
    let stdout = "";
    let stderr = "";
    const code = await runPullRequestCli(args, true, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } }, runner);
    return { code, stdout, stderr };
  };

  const flagged = await run(["pr", "closures", "picoduck/wollipog#7", "--intended", "https://github.com/picoduck/wollipog/issues/3713", "--json"]);
  assert.equal(flagged.code, 3, "an undeclared closure fails the check");
  assert.deepEqual(JSON.parse(flagged.stdout), {
    repository: "picoduck/wollipog", pullRequest: 7, state: "OPEN", headSha: head,
    closures: [
      { issue: "picoduck/wollipog#3635", sources: ["description"], excerpt: "Refs #3635. This PR does not close #3635." },
      { issue: "picoduck/wollipog#3713", sources: ["linked"] },
    ],
    undeclared: ["picoduck/wollipog#3635"], unmade: [],
  });
  assert.equal(calls.some((args) => args[0] === "repo"), false, "an owner/name reference needs no repository lookup");

  const matched = await run(["pr", "closures", "7", "--intended", "#3635", "--intended=#3713", "--json"]);
  assert.equal(matched.code, 0);
  assert.deepEqual(JSON.parse(matched.stdout).undeclared, []);
  assert.deepEqual(calls.at(-2), ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], "a bare number uses this checkout");

  const root = mkdtempSync(join(tmpdir(), "wollipog-cli-closures-"));
  try {
    const draft = join(root, "body.md");
    writeFileSync(draft, "Slice one. Refs #12.\n\n`closes #13` is how GitHub closes an issue.\n\nIt must not auto-close #14.\n");
    const fromFile = await run(["pr", "closures", "--file", draft, "--repo", "picoduck/wollipog", "--intended", "#15", "--json"]);
    assert.equal(fromFile.code, 3);
    assert.deepEqual(JSON.parse(fromFile.stdout), { repository: "picoduck/wollipog",
      closures: [{ issue: "picoduck/wollipog#14", sources: ["description"], excerpt: "It must not auto-close #14." }],
      undeclared: ["picoduck/wollipog#14"], unmade: ["picoduck/wollipog#15"] });
    writeFileSync(draft, "Refs #12 and #14.\n");
    assert.equal((await run(["pr", "closures", "--file", draft, "--json"])).code, 0, "a clean draft passes; the repository comes from gh");
    assert.equal((await run(["pr", "closures", "--file", join(root, "missing.md"), "--repo", "a/b", "--json"])).code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const unreadable: GhRunner = async () => ({ stdout: "", stderr: "HTTP 401: Bad credentials", code: 1, timedOut: false });
  const denied = await run(["pr", "closures", "picoduck/wollipog#7", "--json"], unreadable);
  assert.equal(denied.code, 1);
  assert.equal(JSON.parse(denied.stdout).error, "gh in this session's context is not signed in to github.com.");
  for (const args of [["pr", "closures"], ["pr", "closures", "7", "8"], ["pr", "closures", "--file"],
    ["pr", "closures", "7", "--intended"], ["pr", "closures", "7", "--repo", "a/b", "--intended", "nope"],
    ["pr", "closures", "gitlab.example.com/group/project!7"], ["pr", "closures", "--file", "body.md", "7", "--repo", "a/b"]]) {
    assert.equal((await run([...args, "--json"])).code, 2, args.join(" "));
  }
  const help = await captureCli(["pr", "closures", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /wollipog pr closures --file <description\.md>/u);
});

test("local init succeeds without control-plane credentials and emits stable content-safe JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-cli-init-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    let stdout = "";
    let stderr = "";
    const code = await runWollipogInit(root, true, {
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    });
    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), {
      status: "created",
      path: ".wollipog.json",
      detected: ["pnpm-lock.yaml"],
      executed: false,
      staged: false,
      committed: false,
    });
    const original = readFileSync(join(root, ".wollipog.json"), "utf8");
    stdout = "";
    assert.equal(await runWollipogInit(root, true, {
      stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; },
    }), 4);
    assert.match(JSON.parse(stdout).error, /already exists/u);
    assert.equal(readFileSync(join(root, ".wollipog.json"), "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new aliases accept --help without changing established canonical group help behavior", async () => {
  for (const alias of ["update", "doctor", "pair"]) {
    const result = await captureCli([alias, "--help"]);
    assert.equal(result.code, 0, alias);
    assert.equal(result.stderr, "", alias);
    assert.match(result.stdout, new RegExp(`Usage: wollipog ${alias}`, "u"));
  }

  const pairVerb = await captureCli(["pair", "create", "--help"]);
  assert.equal(pairVerb.code, 0);
  assert.match(pairVerb.stdout, /Usage: wollipog pair/u);

  for (const group of ["admin", "service"]) {
    const result = await captureCli([group, "--help"]);
    assert.equal(result.code, 2, group);
    assert.equal(result.stdout, "", group);
    assert.match(result.stderr, new RegExp(`Usage: wollipog ${group}`, "u"));
  }
});

test("CLI aliases preserve every argument while delegating to canonical commands", () => {
  const updateOptions = ["--system", "--release", "v1.2.3", "--force", "--yes", "--json"];
  assert.deepEqual(expandCommandAlias(["update", ...updateOptions]), ["service", "upgrade", ...updateOptions]);

  const adminOptions = ["--url", "http://127.0.0.1:4317", "--token-file", "/tmp/local-token", "--json"];
  assert.deepEqual(expandCommandAlias(["doctor", ...adminOptions]), ["admin", "doctor", ...adminOptions]);
  assert.deepEqual(
    expandCommandAlias(["pair", "create", "--name", "laptop", "--user", "u1", "--origin", "https://w.example", "--output", "/tmp/pair", ...adminOptions]),
    ["admin", "device", "create", "--name", "laptop", "--user", "u1", "--origin", "https://w.example", "--output", "/tmp/pair", ...adminOptions],
  );
  assert.deepEqual(expandCommandAlias(["pair", "list", ...adminOptions]), ["admin", "device", "list", ...adminOptions]);
  assert.deepEqual(expandCommandAlias(["pair", "revoke", "d1", "--yes", ...adminOptions]), ["admin", "device", "revoke", "d1", "--yes", ...adminOptions]);
  assert.deepEqual(expandCommandAlias(["pair", "url", ...adminOptions]), ["admin", "pairing-url", ...adminOptions]);
  assert.equal(resolveHelp(["pair", "create", "--name", "-h", "--output", "/tmp/pair"]), null);
});

test("aliases preserve canonical fail-closed output, JSON, and exit codes", async () => {
  const cases: Array<[string[], string[]]> = [
    [["doctor"], ["admin", "doctor"]],
    [["pair", "create", "--name", "laptop"], ["admin", "device", "create", "--name", "laptop"]],
    [["pair", "list"], ["admin", "device", "list"]],
    [["pair", "revoke", "d1", "--yes"], ["admin", "device", "revoke", "d1", "--yes"]],
    [["pair", "url"], ["admin", "pairing-url"]],
  ];
  for (const [alias, canonical] of cases) {
    const options = ["--url", "https://remote.example", "--json"];
    assert.deepEqual(await captureCli([...alias, ...options]), await captureCli([...canonical, ...options]), alias.join(" "));
  }

  const conflictingModes = ["--user", "--system", "--json"];
  assert.deepEqual(
    await captureCli(["update", ...conflictingModes]),
    await captureCli(["service", "upgrade", ...conflictingModes]),
  );
});

test("unknown help topics and pair verbs return usage without external work", async () => {
  const unknown = await captureCli(["help", "bogus"]);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /Unknown help topic `bogus`/u);

  const unknownJson = await captureCli(["help", "bogus", "--json"]);
  assert.equal(unknownJson.code, 2);
  assert.equal(unknownJson.stderr, "");
  assert.match(JSON.parse(unknownJson.stdout).error, /Unknown help topic `bogus`/u);

  const pair = await captureCli(["pair", "bogus", "--json"]);
  assert.equal(pair.code, 2);
  assert.equal(pair.stderr, "");
  assert.match(JSON.parse(pair.stdout).error, /Usage: wollipog pair/u);
});

test("unknown session and worktree verbs retain contextual command help", async () => {
  const session = await captureCli(["session", "bogus"]);
  assert.equal(session.code, 2);
  assert.match(session.stderr, /Usage: wollipog session/u);
  assert.match(session.stderr, /session guardrails/u);
  assert.doesNotMatch(session.stderr, /Common Workflows/u);

  const worktree = await captureCli(["worktree", "bogus"]);
  assert.equal(worktree.code, 2);
  assert.match(worktree.stderr, /Usage: wollipog worktree/u);
  assert.match(worktree.stderr, /worktree discard/u);
  assert.doesNotMatch(worktree.stderr, /Common Workflows/u);
});

test("CLI alias never reparses a later internal marker as its entry mode", async () => {
  for (const argv of [
    ["wollipog", "wollipog", "session", "prompt", "s_child", "--wollipog-cli"],
    ["node", "cli.js", "session", "prompt", "s_child", "--wollipog-cli"],
  ]) {
    let stderr = "";
    const code = await runWollipogCli(
      argv,
      {},
      { stdout: () => assert.fail("unexpected CLI output"), stderr: (text) => { stderr += text; } },
      async () => assert.fail("malformed prompt must not issue a request"),
    );
    assert.equal(code, 2);
    assert.match(stderr, /session prompt requires an id and text/u);
  }
});

test("CLI consumes an internal marker only at the SEA application boundary", async () => {
  let stdout = "";
  assert.equal(await runWollipogCli(
    ["wollipog-runner.exe", "wollipog-runner.exe", "--wollipog-cli", "--version"],
    {},
    { stdout: (text) => { stdout += text; }, stderr: () => assert.fail("unexpected CLI error") },
  ), 0);
  assert.match(stdout, /protocol v\d+/u);
});

test("CLI archive posts archived true and rejects self without issuing a mutation", async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const fetch: McpFetch = async (url, init) => {
    calls.push({ url, body: init?.body });
    const body = url.endsWith("/api/compatibility") ? { protocolVersion: PROTOCOL_VERSION }
      : { id: "child", archived: true };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "test-token", WOLLIPOG_SESSION_ID: "parent" };
  const io = { stdout: () => {}, stderr: () => {} };
  assert.equal(await runWollipogCli(["node", "cli.js", "--wollipog-cli", "session", "archive", "child", "--json"], env, io, fetch), 0);
  assert.equal(calls[1]!.url, "http://cp/api/sessions/child/archive");
  assert.deepEqual(JSON.parse(calls[1]!.body!), { archived: true });
  calls.length = 0;
  assert.equal(await runWollipogCli(["node", "cli.js", "--wollipog-cli", "session", "archive", "parent", "--json"], env, io, fetch), 1);
  assert.ok(calls.every((call) => call.url.endsWith("/api/compatibility")));
});

test("CLI archive JSON distinguishes pending, failed, completed and unknown progress", async () => {
  for (const archiveStatus of ["stop_pending", "stop_failed", null, undefined]) {
    let stdout = "";
    const fetch: McpFetch = async (url) => {
      const compatibility = url.endsWith("/api/compatibility");
      return { ok: true, status: compatibility || !archiveStatus ? 200 : 202,
        text: async () => JSON.stringify(compatibility ? { protocolVersion: PROTOCOL_VERSION }
          : { id: "child", archived: archiveStatus === null, archiveStatus }) };
    };
    const code = await runWollipogCli(["node", "cli.js", "--wollipog-cli", "session", "archive", "child", "--json"],
      { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "test-token", WOLLIPOG_SESSION_ID: "parent" },
      { stdout: (text) => { stdout += text; }, stderr: () => assert.fail("unexpected CLI error") }, fetch);
    assert.equal(code, 0);
    const session = JSON.parse(stdout).session;
    assert.equal(session.archiveStatus, archiveStatus);
    assert.equal(session.archived, archiveStatus === null);
  }
});

test("CLI emits stable JSON and authenticates list requests as the exact session", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-cli-"));
  try {
    const tokenFile = join(root, "token");
    const readyFile = join(root, "ready");
    writeFileSync(tokenFile, "session-secret", { mode: 0o600 });
    writeFileSync(readyFile, createHash("sha256").update("session-secret").digest("hex"), { mode: 0o600 });
    const calls: Array<{ url: string; init: Parameters<McpFetch>[1] }> = [];
    const fetch: McpFetch = async (url, init) => {
      calls.push({ url, init });
      const body = url.endsWith("/api/compatibility")
        ? { protocolVersion: PROTOCOL_VERSION }
        : { sessions: [{ id: "s_child", status: "running", runnerId: "r1", title: "Child" }] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    let stdout = "";
    let stderr = "";
    const code = await runWollipogCli(
      ["node", "cli.js", "--wollipog-cli", "session", "list", "--json"],
      {
        WOLLIPOG_CONTROL_PLANE_URL: "http://127.0.0.1:4317",
        WOLLIPOG_SESSION_ID: "s_parent",
        WOLLIPOG_SESSION_TOKEN_FILE: tokenFile,
        WOLLIPOG_SESSION_CREDENTIAL_READY_FILE: readyFile,
      },
      { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
      fetch,
    );
    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), {
      sessions: [{
        id: "s_child", title: "Child", status: "running", runnerId: "r1", workspaceId: null,
        agentId: null, runId: null, costBudgetUsd: null, costCheckpointsUsd: null, costCheckpointApprovedUsd: null, maxToolCalls: null, pendingApproval: null,
        archived: false,
        parentSessionId: null,
        maxChildSessions: null,
        liveChildCapacity: null,
        parentControl: "off",
      }],
    });
    assert.equal(calls[1]!.url, "http://127.0.0.1:4317/api/sessions");
    assert.equal(calls[0]!.url, "http://127.0.0.1:4317/api/compatibility");
    assert.equal(calls[0]!.init?.headers?.authorization, "Bearer session-secret");
    assert.equal(calls[0]!.init?.headers?.[WOLLIPOG_AGENT_ACTOR_SESSION_HEADER], "s_parent");
    assert.equal(calls[1]!.init?.headers?.authorization, "Bearer session-secret");
    assert.equal(calls[1]!.init?.headers?.[WOLLIPOG_AGENT_ACTOR_SESSION_HEADER], "s_parent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit CLI token file overrides an injected runner relay", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-cli-relay-override-"));
  try {
    const tokenFile = join(root, "device-token");
    writeFileSync(tokenFile, "explicit-device-token", { mode: 0o600 });
    const authorizations: string[] = [];
    const fetch: McpFetch = async (url, init) => {
      authorizations.push(init?.headers?.authorization ?? "");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(url.endsWith("/api/compatibility")
          ? { protocolVersion: PROTOCOL_VERSION }
          : { sessions: [] }),
      };
    };
    let stdout = "";
    const code = await runWollipogCli(
      ["node", "cli.js", "--wollipog-cli", "session", "list", "--token-file", tokenFile, "--json"],
      {
        WOLLIPOG_CONTROL_PLANE_URL: "http://cp",
        WOLLIPOG_SESSION_ID: "s_provider",
        [AGENT_CONTROL_RELAY_ENDPOINT_ENV]: "tcp://127.0.0.1:9",
        [AGENT_CONTROL_RELAY_KEY_ENV]: "k".repeat(32),
      },
      { stdout: (text) => { stdout += text; }, stderr: () => assert.fail("unexpected CLI error") },
      fetch,
    );
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), { sessions: [] });
    assert.deepEqual(authorizations, ["Bearer explicit-device-token", "Bearer explicit-device-token"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI exposes bounded agent capability discovery with exact targeting", async () => {
  const requests: Array<{ url: string; method?: string }> = [];
  const fetch: McpFetch = async (url, init) => {
    requests.push({ url, method: init?.method });
    const body = url.endsWith("/api/compatibility")
      ? { protocolVersion: PROTOCOL_VERSION }
      : { runners: [{ runnerId: "r1", agents: [{
          id: "codex", name: "Codex", capabilities: {
            modelSource: "live", effortLevels: ["high"], models: [{ id: "gpt", hidden: true }],
          },
        }] }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  let stdout = "";
  const code = await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "session", "capabilities", "--runner", "r1", "--agent", "codex", "--model", "gpt", "--json"],
    { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "paired-device" },
    { stdout: (text) => { stdout += text; }, stderr: () => assert.fail("unexpected CLI error") },
    fetch,
  );
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).models[0].id, "gpt");
  assert.equal(JSON.parse(stdout).models[0].hidden, true);
  assert.deepEqual(requests, [
    { url: "http://cp/api/compatibility", method: "GET" },
    { url: "http://cp/api/runners", method: "GET" },
  ]);
});

test("CLI capability discovery rejects malformed numbers and conflicting exact lookup options", async () => {
  for (const suffix of [
    ["--offset", "abc"],
    ["--offset="],
    ["--limit", "--json"],
    ["--model", "gpt", "--include-hidden"],
    ["--model", "gpt", "--offset", "1"],
    ["--model", "gpt", "--limit", "1"],
  ]) {
    const result = await captureCli([
      "session", "capabilities", "--runner", "r1", "--agent", "codex", ...suffix, "--json",
    ]);
    assert.equal(result.code, 2, suffix.join(" "));
    assert.equal(result.stderr, "", suffix.join(" "));
    assert.match(JSON.parse(result.stdout).error, /requires a number|cannot be combined/u, suffix.join(" "));
  }
});

test("CLI session events rejects a malformed --event-epoch instead of reading unpinned", async () => {
  for (const suffix of [
    ["--event-epoch", "NaN"],
    ["--event-epoch", "-1"],
    ["--event-epoch", "1.5"],
    ["--event-epoch="],
    ["--event-epoch", "--json"],
  ]) {
    const result = await captureCli(["session", "events", "s_child", "--after", "6", ...suffix, "--json"]);
    assert.equal(result.code, 2, suffix.join(" "));
    assert.equal(result.stderr, "", suffix.join(" "));
    assert.match(JSON.parse(result.stdout).error, /--event-epoch requires a non-negative integer/u, suffix.join(" "));
  }
});

test("CLI JSON create and prompt commands reuse the manager routes and reject incompatible control planes", async () => {
  const requests: Array<{ url: string; method?: string; body?: string; headers?: Record<string, string> }> = [];
  const fetch: McpFetch = async (url, init) => {
    requests.push({ url, method: init?.method, body: init?.body, headers: init?.headers });
    if (url.endsWith("/api/compatibility")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ protocolVersion: PROTOCOL_VERSION }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "s_new", status: "starting", runnerId: "r1", title: "New" }) };
  };
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "paired-device" };
  let output = "";
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "session", "create", "--runner", "r1", "--agent", "codex", "--workspace", "ws", "--prompt", "Do it", "--model", "gpt-5.6-sol", "--effort", "high", "--json"],
    env,
    { stdout: (text) => { output += text; }, stderr: () => {} },
    fetch,
  ), 0);
  assert.equal(JSON.parse(output).session.id, "s_new");
  assert.equal(requests[1]!.url, "http://cp/api/sessions");
  assert.deepEqual(JSON.parse(requests[1]!.body!), {
    runnerId: "r1", agentId: "codex", workspaceId: "ws", prompt: "Do it", useWorktree: false,
    config: { model: "gpt-5.6-sol", effort: "high" },
  });
  assert.equal(requests[1]!.headers?.[WOLLIPOG_AGENT_ACTOR_SESSION_HEADER], undefined,
    "paired-device CLI calls do not fabricate a session principal");

  let incompatible = "";
  const oldFetch: McpFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.sessionAgentControl - 1 }),
  });
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "session", "list", "--json"],
    env,
    { stdout: (text) => { incompatible += text; }, stderr: () => {} },
    oldFetch,
  ), 1);
  assert.match(JSON.parse(incompatible).error, /incompatible/);
});

test("CLI explains a refused session credential without device pairing instructions", async () => {
  for (const detail of ["unauthorized — open the startup pairing URL or pair this device", "session agent credential refused: runner reconnecting; retry after the runner reconnects"]) {
    let output = "";
    const code = await runWollipogCli(
      ["node", "cli.js", "--wollipog-cli", "session", "list", "--json"],
      { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "session-token", WOLLIPOG_SESSION_ID: "s_self" },
      { stdout: (text) => { output += text; }, stderr: () => {} },
      async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: detail }) }),
    );
    assert.equal(code, 1);
    assert.match(JSON.parse(output).error, /session agent credential refused:/);
    assert.match(JSON.parse(output).error, /Orchestrator|retry/);
    assert.doesNotMatch(JSON.parse(output).error, /pair/i);
    if (detail.startsWith("session agent")) assert.ok(JSON.parse(output).error.includes(detail));
  }
});

test("CLI rejects explicit effort against pre-v138 control planes without creating a session", async () => {
  const requests: string[] = [];
  const fetch: McpFetch = async (url) => {
    requests.push(url);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.sessionAgentControlReasoningEffort - 1,
      }),
    };
  };
  let output = "";
  const code = await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "session", "create", "--runner", "r1", "--agent", "codex", "--workspace", "ws", "--effort", "high", "--json"],
    { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "paired-device" },
    { stdout: (text) => { output += text; }, stderr: () => assert.fail("unexpected CLI error") },
    fetch,
  );
  assert.equal(code, 1);
  assert.match(JSON.parse(output).error, /requires v138/u);
  assert.deepEqual(requests, ["http://cp/api/compatibility"]);
});

test("CLI sends a campaign work item at creation only to a v220 control plane (#3106)", async () => {
  const create = ["node", "cli.js", "--wollipog-cli", "session", "create", "--runner", "r1", "--agent", "codex",
    "--workspace", "ws", "--effort", "high", "--work-item", "cwi_item", "--json"];
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "paired-device" };
  for (const protocolVersion of [RUNNER_CAPABILITY_MIN_PROTOCOL.campaignWorkItemAtCreation - 1, PROTOCOL_VERSION]) {
    const requests: Array<{ url: string; body?: string }> = [];
    const fetch: McpFetch = async (url, init) => {
      requests.push({ url, body: init?.body });
      return { ok: true, status: 200, text: async () => JSON.stringify(url.endsWith("/api/compatibility")
        ? { protocolVersion } : { id: "s_new", status: "starting", runnerId: "r1", title: "New" }) };
    };
    let output = "";
    const code = await runWollipogCli(create, env, { stdout: (text) => { output += text; }, stderr: () => {} }, fetch);
    if (protocolVersion < RUNNER_CAPABILITY_MIN_PROTOCOL.campaignWorkItemAtCreation) {
      assert.equal(code, 1);
      assert.match(JSON.parse(output).error, /requires v220/u, "an older control plane would ignore the item, so it is refused");
      assert.deepEqual(requests.map((request) => request.url), ["http://cp/api/compatibility"]);
    } else {
      assert.equal(code, 0);
      assert.equal(JSON.parse(requests[1]!.body!).campaignWorkItemId, "cwi_item");
    }
  }
  for (const suffix of [["--work-item"], ["--work-item="], ["--work-item", "  "], ["--work-item", "--json"]]) {
    const result = await captureCli(["session", "create", "--runner", "r1", "--agent", "codex", "--workspace", "ws", ...suffix]);
    assert.equal(result.code, 2, suffix.join(" "));
    assert.match(suffix.includes("--json") ? result.stdout : result.stderr, /--work-item requires a campaign work item ID/u);
  }
});

test("CLI rejects a missing or blank effort before compatibility or session creation", async () => {
  for (const suffix of [["--effort"], ["--effort="], ["--effort", "   "], ["--effort", "--json"]]) {
    const result = await captureCli([
      "session", "create", "--runner", "r1", "--agent", "codex", "--workspace", "ws", ...suffix,
    ]);
    assert.equal(result.code, 2, suffix.join(" "));
    const output = suffix.includes("--json") ? result.stdout : result.stderr;
    assert.equal(suffix.includes("--json") ? result.stderr : result.stdout, "", suffix.join(" "));
    assert.match(output, /--effort requires a non-empty value/u, suffix.join(" "));
  }
});

test("CLI exposes restart and all live guardrail controls", async () => {
  const requests: Array<{ url: string; body?: string }> = [];
  const fetch: McpFetch = async (url, init) => {
    requests.push({ url, body: init?.body });
    return { ok: true, status: 200, text: async () => JSON.stringify(
      url.endsWith("/api/compatibility") ? { protocolVersion: PROTOCOL_VERSION }
        : { id: "child", status: "starting", maxChildSessions: 9 },
    ) };
  };
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "token", WOLLIPOG_SESSION_ID: "parent" };
  const io = { stdout: () => {}, stderr: () => assert.fail("unexpected CLI error") };
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "session", "restart", "child", "--json"], env, io, fetch,
  ), 0);
  assert.equal(requests[1]!.url, "http://cp/api/sessions/child/restart");
  requests.length = 0;
  assert.equal(await runWollipogCli([
    "node", "cli.js", "--wollipog-cli", "session", "guardrails", "child",
    "--cost-budget", "0", "--max-tool-calls", "0", "--max-child-sessions", "9", "--json",
  ], env, io, fetch), 0);
  assert.equal(requests[1]!.url, "http://cp/api/sessions/child/config");
  assert.deepEqual(JSON.parse(requests[1]!.body!), {
    costBudgetUsd: 0, maxToolCalls: 0, maxChildSessions: 9,
  });
});

test("CLI keeps v100 core commands compatible while gating worktree commands on v101", async () => {
  const requests: string[] = [];
  const fetch: McpFetch = async (url) => {
    requests.push(url);
    if (url.endsWith("/api/compatibility")) {
      return { ok: false, status: 404, text: async () => "not found" };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(url.endsWith("/healthz")
        ? { protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.sessionAgentControl }
        : { sessions: [] }),
    };
  };
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "paired-device" };
  let output = "";
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "session", "list", "--json"],
    env,
    { stdout: (text) => { output += text; }, stderr: () => {} },
    fetch,
  ), 0);
  assert.deepEqual(JSON.parse(output), { sessions: [] });

  output = "";
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "worktree", "select", "--session", "s1", "--path", "/repo/wt", "--json"],
    env,
    { stdout: (text) => { output += text; }, stderr: () => {} },
    fetch,
  ), 1);
  assert.match(JSON.parse(output).error, /requires v101/);
  assert.deepEqual(requests, [
    "http://cp/api/compatibility",
    "http://cp/healthz",
    "http://cp/api/sessions",
    "http://cp/api/compatibility",
    "http://cp/healthz",
  ]);
});

test("CLI gates deferred worktree retirement on v159 without disabling v101 selection", async () => {
  const requests: string[] = [];
  const fetch: McpFetch = async (url) => {
    requests.push(url);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(url.endsWith("/api/compatibility")
        ? { protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.sessionWorktrees }
        : { session: { id: "s1" } }),
    };
  };
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "paired-device" };
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "worktree", "select", "--session", "s1", "--path", "/repo/wt", "--json"],
    env,
    { stdout: () => {}, stderr: () => {} },
    fetch,
  ), 0);
  let output = "";
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "worktree", "discard", "--session", "s1", "--path", "/repo/wt", "--json"],
    env,
    { stdout: (text) => { output += text; }, stderr: () => {} },
    fetch,
  ), 1);
  assert.match(JSON.parse(output).error, /requires v159/);
  assert.deepEqual(requests, [
    "http://cp/api/compatibility",
    "http://cp/api/sessions/s1/worktrees/select",
    "http://cp/api/compatibility",
  ]);
});

test("CLI emits JSON for get, events, prompt, wait, and stop core commands", async () => {
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "paired-device" };
  const cases = [
    { argv: ["session", "get", "s_child"], method: "GET", path: "/api/sessions/s_child" },
    { argv: ["session", "events", "s_child", "--after", "4", "--limit", "2"], method: "GET", path: "/api/sessions/s_child" },
    { argv: ["session", "prompt", "s_child", "Keep", "going"], method: "POST", path: "/api/sessions/s_child/prompt" },
    { argv: ["session", "wait", "s_child", "--for", "completed", "--timeout", "50"], method: "GET", path: "/api/sessions/s_child" },
    { argv: ["session", "stop", "s_child"], method: "POST", path: "/api/sessions/s_child/stop" },
    { argv: ["session", "stop-job", "s_child", "monitor-1"], method: "POST", path: "/api/sessions/s_child/background-jobs/monitor-1/stop" },
    { argv: ["session", "release-hold", "s_child", "worktree-rebind:5000"], method: "POST", path: "/api/sessions/s_child/queue-hold/release" },
    { argv: ["session", "steering", "s_child"], method: "GET", path: "/api/sessions/s_child/steering" },
    { argv: ["session", "steering-get", "s_child", "sub /1"], method: "GET", path: "/api/sessions/s_child/steering/sub%20%2F1" },
    { argv: ["session", "resolve-steering", "s_child", "sub /1", "queue_again"], method: "POST", path: "/api/sessions/s_child/steering/sub%20%2F1/resolve" },
    { argv: ["session", "resolve-steering", "s_child", "sub /1", "dismiss"], method: "POST", path: "/api/sessions/s_child/steering/sub%20%2F1/resolve" },
  ] as const;

  for (const testCase of cases) {
    const requests: Array<{ url: string; method?: string }> = [];
    const fetch: McpFetch = async (url, init) => {
      requests.push({ url, method: init?.method });
      if (url.endsWith("/api/compatibility")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ protocolVersion: PROTOCOL_VERSION }) };
      }
      const session = { id: "s_child", status: "completed", runnerId: "r1", title: "Child" };
      const body = url.includes("/events?")
        ? { events: [] }
        : url.endsWith("/api/sessions/s_child")
          ? { session }
          : session;
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    let output = "";
    assert.equal(await runWollipogCli(
      ["node", "cli.js", "--wollipog-cli", ...testCase.argv, "--json"],
      env,
      { stdout: (text) => { output += text; }, stderr: () => {} },
      fetch,
    ), 0, testCase.argv.join(" "));
    assert.doesNotThrow(() => JSON.parse(output), testCase.argv.join(" "));
    assert.equal(requests[1]!.method, testCase.method);
    assert.equal(requests[1]!.url, `http://cp${testCase.path}`);
  }
});

test("CLI session wait exits 124 on a timeout result and 1 on an unknown state", async () => {
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "paired-device" };
  const sessionReads: string[] = [];
  const fetch: McpFetch = async (url) => {
    if (url.endsWith("/api/compatibility")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ protocolVersion: PROTOCOL_VERSION }) };
    }
    sessionReads.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ session: { id: "s_child", status: "running", runnerId: "r1" } }) };
  };
  const run = async (...argv: string[]) => {
    let output = "";
    const code = await runWollipogCli(
      ["node", "cli.js", "--wollipog-cli", "session", "wait", "s_child", ...argv, "--json"],
      env,
      { stdout: (text) => { output += text; }, stderr: () => {} },
      fetch,
    );
    return { code, body: JSON.parse(output) };
  };

  const timedOut = await run("--for", "completed", "--timeout", "1", "--interval", "50");
  assert.equal(timedOut.code, 124);
  assert.equal(timedOut.body.outcome, "timeout");
  assert.deepEqual(timedOut.body.waitingFor, ["completed"]);
  assert.equal(timedOut.body.session.status, "running");

  const readsBefore = sessionReads.length;
  const refused = await run("--for", "needs_input");
  assert.equal(refused.code, 1);
  assert.match(refused.body.error, /^unknown session state needs_input; valid states: queued, starting, running, /);
  assert.equal(sessionReads.length, readsBefore, "the refusal happens before any session read");
});

test("CLI session events pages forward with --after and reads the newest events without it", async () => {
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "paired-device" };
  const events = Array.from({ length: 12 }, (_, i) => ({ seq: i + 1, ts: i, payload: { kind: "agent_message", text: `m${i + 1}` } }));
  for (const [argv, pagePath, seqs, lastSeq] of [
    [["--after", "4", "--limit", "2"], "/api/sessions/s_child/events?after=4&limit=2&eventEpoch=3", [5, 6], 6],
    [["--after", "6", "--event-epoch", "3", "--limit", "2"], "/api/sessions/s_child/events?after=6&limit=2&eventEpoch=3", [7, 8], 8],
    [["--event-epoch", "3", "--after", "8", "--limit", "2"], "/api/sessions/s_child/events?after=8&limit=2&eventEpoch=3", [9, 10], 10],
    [["--limit", "2"], "/api/sessions/s_child/events?direction=backward&limit=2&eventEpoch=3", [11, 12], 12],
  ] as const) {
    const requests: string[] = [];
    const fetch: McpFetch = async (url) => {
      requests.push(url);
      const query = new URL(url).searchParams;
      const limit = Number(query.get("limit"));
      const body = url.endsWith("/api/compatibility")
        ? { protocolVersion: PROTOCOL_VERSION }
        : url.endsWith("/api/sessions/s_child")
          ? { session: { id: "s_child", eventEpoch: 3 } }
          : query.get("direction") === "backward"
            ? { events: events.slice(-limit), eventEpoch: 3, hasMoreOlder: true, cacheComplete: true }
            : {
              events: events.filter((e) => e.seq > Number(query.get("after"))).slice(0, limit),
              eventEpoch: 3,
              hasMoreCached: true,
              cacheComplete: true,
            };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    let output = "";
    assert.equal(await runWollipogCli(
      // The option-first case puts every option before the session id, which must still parse as the id.
      ["node", "cli.js", "--wollipog-cli", "session", "events",
        ...(argv[0] === "--event-epoch" ? [...argv, "s_child"] : ["s_child", ...argv]), "--json"],
      env,
      { stdout: (text) => { output += text; }, stderr: () => {} },
      fetch,
    ), 0);
    assert.equal(requests.at(-1), `http://cp${pagePath}`);
    assert.equal(requests.includes("http://cp/api/sessions/s_child"), !argv.includes("--event-epoch" as never));
    const data = JSON.parse(output);
    assert.equal(data.eventEpoch, 3);
    assert.deepEqual(data.lines.map((line: string) => Number(/^\((\d+)\)/.exec(line)![1])), seqs);
    assert.equal(data.lastSeq, lastSeq);
  }
});

test("CLI recognizes installed POSIX and Windows alias invocation names", async () => {
  for (const executable of ["/opt/bin/wollipog", String.raw`C:\Users\agent\wollipog.exe`]) {
    const requests: string[] = [];
    const fetch: McpFetch = async (url) => {
      requests.push(url);
      const body = url.endsWith("/api/compatibility")
        ? { protocolVersion: PROTOCOL_VERSION }
        : { sessions: [] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    let output = "";
    assert.equal(await runWollipogCli(
      [executable, executable, "session", "list", "--json"],
      { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "paired-device" },
      { stdout: (text) => { output += text; }, stderr: () => {} },
      fetch,
    ), 0, executable);
    assert.deepEqual(JSON.parse(output), { sessions: [] });
    assert.deepEqual(requests, ["http://cp/api/compatibility", "http://cp/api/sessions"]);
  }
});

test("CLI worktree commands adapt to the shared MCP operations", async () => {
  const requests: Array<{ url: string; body?: string }> = [];
  const fetch: McpFetch = async (url, init) => {
    requests.push({ url, body: init?.body });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(url.endsWith("/api/compatibility")
        ? { protocolVersion: PROTOCOL_VERSION }
        : { worktree: { id: "wt", path: "/repo/wt", branch: "fix/583", source: "created" }, session: { id: "s1" } }),
    };
  };
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "paired-device" };
  let output = "";
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "worktree", "create", "--session", "s1", "--branch", "fix/583", "--base", "origin/main", "--json"],
    env,
    { stdout: (text) => { output += text; }, stderr: () => {} },
    fetch,
  ), 0);
  assert.equal(JSON.parse(output).worktree.branch, "fix/583");
  assert.equal(requests[1]!.url, "http://cp/api/sessions/s1/worktrees");
  assert.deepEqual(JSON.parse(requests[1]!.body!), {
    branch: "fix/583",
    baseRef: "origin/main",
    progress: true,
  });

  output = "";
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "worktree", "select", "--session", "s1", "--path", "/repo/wt", "--json"],
    env,
    { stdout: (text) => { output += text; }, stderr: () => {} },
    fetch,
  ), 0);
  assert.equal(requests[3]!.url, "http://cp/api/sessions/s1/worktrees/select");
  assert.deepEqual(JSON.parse(requests[3]!.body!), { path: "/repo/wt" });

  output = "";
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "worktree", "discard", "--session", "s1", "--path", "/repo/old", "--json"],
    env,
    { stdout: (text) => { output += text; }, stderr: () => {} },
    fetch,
  ), 0);
  assert.equal(requests[5]!.url, "http://cp/api/sessions/s1/worktrees/discard");
  assert.deepEqual(JSON.parse(requests[5]!.body!), { path: "/repo/old" });
});

test("CLI artifact attach uploads a file by path and prints only its metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-cli-artifact-"));
  const previous = process.cwd();
  try {
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("mobile-after")]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(root, "mobile-after.png"), bytes);
    const calls: Array<{ url: string; body?: string }> = [];
    let protocolVersion: number = PROTOCOL_VERSION;
    const fetch: McpFetch = async (url, init) => {
      calls.push({ url, body: init?.body });
      const body = url.endsWith("/api/compatibility") ? { protocolVersion } : {
        artifactId: "art_9", sessionId: "self", kind: "screenshot", name: JSON.parse(init!.body!).name,
        mimeType: "image/png", encoding: "base64", sizeBytes: bytes.length, sha256, createdAt: 1,
      };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "test-token", WOLLIPOG_SESSION_ID: "self" };
    let stdout = "";
    const io = { stdout: (text: string) => { stdout += text; }, stderr: () => {} };

    // A relative path means the caller's directory, which is the CLI's — not the MCP server's.
    process.chdir(root);
    assert.equal(await runWollipogCli(
      ["node", "cli.js", "--wollipog-cli", "artifact", "attach", "--file", "mobile-after.png", "--name", "Mobile After", "--json"],
      env, io, fetch), 0);
    const upload = calls.find((call) => call.url === "http://cp/api/sessions/self/artifacts/screenshots");
    assert.ok(upload, "the session-scoped attach route is used");
    assert.deepEqual(JSON.parse(upload.body!), { name: "Mobile After", mimeType: "image/png", data: bytes.toString("base64") });
    assert.deepEqual(JSON.parse(stdout), { artifact: {
      artifactId: "art_9", sessionId: "self", kind: "screenshot", name: "Mobile After",
      mediaType: "image/png", sizeBytes: bytes.length, sha256,
    } });
    assert.ok(!stdout.includes(bytes.toString("base64")), "command output never carries the file's bytes");

    stdout = "";
    calls.length = 0;
    assert.equal(await runWollipogCli(
      ["node", "cli.js", "--wollipog-cli", "artifact", "attach", "--file", "mobile-after.png", "--session", "other", "--json"],
      env, io, fetch), 1, "an injected session cannot attach to another session");
    assert.ok(calls.every((call) => call.url.endsWith("/api/compatibility")));

    stdout = "";
    calls.length = 0;
    protocolVersion = RUNNER_CAPABILITY_MIN_PROTOCOL.sessionArtifactFileAttach - 1;
    assert.equal(await runWollipogCli(
      ["node", "cli.js", "--wollipog-cli", "artifact", "attach", "--file", "mobile-after.png", "--json"],
      env, io, fetch), 1);
    assert.match(JSON.parse(stdout).error, new RegExp(`requires v${RUNNER_CAPABILITY_MIN_PROTOCOL.sessionArtifactFileAttach}`, "u"));
    assert.ok(calls.every((call) => call.url.endsWith("/api/compatibility")), "an older control plane receives no upload");
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI worktree delete-refs acts only on the injected session and checks the control plane first (#3316)", async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  let protocolVersion: number = PROTOCOL_VERSION;
  const fetch: McpFetch = async (url, init) => {
    calls.push({ url, body: init?.body });
    const body = url.endsWith("/api/compatibility") ? { protocolVersion }
      : { refDeletion: { worktreePath: "/repo/wt", deleted: ["CHERRY_PICK_HEAD"], absent: ["AUTO_MERGE"] } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "test-token", WOLLIPOG_SESSION_ID: "self" };
  let stdout = "";
  const io = { stdout: (text: string) => { stdout += text; }, stderr: () => {} };
  const pick = "a".repeat(40);
  const tree = "b".repeat(40);
  assert.equal(await runWollipogCli(["node", "cli.js", "--wollipog-cli", "worktree", "delete-refs",
    "--ref", `CHERRY_PICK_HEAD=${pick}`, `--ref=AUTO_MERGE=${tree}`, "--json"], env, io, fetch), 0);
  const request = calls.find((call) => call.url === "http://cp/api/sessions/self/worktrees/delete-refs");
  assert.ok(request, "the session's own route is used");
  assert.deepEqual(JSON.parse(request.body!), { refs: [{ ref: "CHERRY_PICK_HEAD", oldOid: pick }, { ref: "AUTO_MERGE", oldOid: tree }] });
  assert.deepEqual(JSON.parse(stdout), { worktreePath: "/repo/wt", deleted: ["CHERRY_PICK_HEAD"], absent: ["AUTO_MERGE"] });

  for (const argv of [
    ["worktree", "delete-refs", "--json"],
    ["worktree", "delete-refs", "--ref", "CHERRY_PICK_HEAD", "--json"],
    ["worktree", "delete-refs", "--ref", `=${pick}`, "--json"],
    ["worktree", "delete-refs", "--session", "other", "--ref", `CHERRY_PICK_HEAD=${pick}`, "--json"],
  ]) {
    calls.length = 0;
    stdout = "";
    assert.notEqual(await runWollipogCli(["node", "cli.js", "--wollipog-cli", ...argv], env, io, fetch), 0, argv.join(" "));
    assert.equal(calls.length, 0, `${argv.join(" ")} issues no request`);
  }

  calls.length = 0;
  stdout = "";
  protocolVersion = RUNNER_CAPABILITY_MIN_PROTOCOL.sessionWorktreeRefDeletion - 1;
  assert.equal(await runWollipogCli(["node", "cli.js", "--wollipog-cli", "worktree", "delete-refs",
    "--ref", `CHERRY_PICK_HEAD=${pick}`, "--json"], env, io, fetch), 1);
  assert.match(JSON.parse(stdout).error, new RegExp(`requires v${RUNNER_CAPABILITY_MIN_PROTOCOL.sessionWorktreeRefDeletion}`, "u"));
  assert.ok(calls.every((call) => call.url.endsWith("/api/compatibility")), "an older control plane receives no request");
});

test("CLI artifact help is discoverable and malformed artifact commands issue no request", async () => {
  const rootHelpText = await captureCli(["help"]);
  assert.match(rootHelpText.stdout, /^\s+artifact\s+Attach an image file/mu, "agent instructions detect the command from root help");
  const topic = await captureCli(["help", "artifact"]);
  assert.equal(topic.code, 0);
  for (const text of ["artifact attach --file", "--name", "--session", "never the file's bytes", "ui_evidence_approval"]) {
    assert.ok(topic.stdout.includes(text), `artifact help omits ${text}`);
  }
  assert.deepEqual(await captureCli(["help", "artifacts"]), topic);

  const unknown = await captureCli(["artifact", "upload"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /^Usage: wollipog artifact/u);
  const missing = await captureCli(["artifact", "attach", "--json"]);
  assert.equal(missing.code, 2);
  assert.deepEqual(JSON.parse(missing.stdout), { error: "artifact attach requires --file" });
});

test("CLI decision reads forward target and pagination with the caller identity and reject old servers", async () => {
  let version = PROTOCOL_VERSION;
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetch: McpFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    return { ok: true, status: 200, text: async () => JSON.stringify(url.endsWith("/api/compatibility")
      ? { protocolVersion: version } : { decisions: [], occurrenceId: "occ", status: "revoked" }) };
  };
  let stdout = "";
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "parent-token", WOLLIPOG_SESSION_ID: "parent" };
  const run = (args: string[]) => {
    stdout = "";
    calls.length = 0;
    return runWollipogCli(["node", "cli.js", "--wollipog-cli", ...args, "--json"], env,
      { stdout: (text) => { stdout += text; }, stderr: () => {} }, fetch);
  };
  assert.equal(await run(["decision", "get", "occ/id", "--session", "child/id"]), 0);
  assert.equal(calls.at(-1)?.url, "http://cp/api/sessions/child%2Fid/workflow-decisions/occ%2Fid");
  assert.equal(await run(["decision", "list", "--session", "child", "--limit", "2", "--cursor", "occ/id"]), 0);
  assert.equal(calls.at(-1)?.url, "http://cp/api/sessions/child/workflow-decisions?cursor=occ%2Fid&limit=2");
  assert.ok(calls.every((call) => call.headers?.[WOLLIPOG_AGENT_ACTOR_SESSION_HEADER] === "parent"));
  version = RUNNER_CAPABILITY_MIN_PROTOCOL.descendantWorkflowDecisionInspection - 1;
  for (const args of [["decision", "list"], ["decision", "get", "occ", "--session", "child"]]) {
    assert.equal(await run(args), 1);
    assert.match(JSON.parse(stdout).error, /requires v214/);
    assert.ok(calls.every((call) => call.url.endsWith("/api/compatibility")));
  }
  assert.equal(await run(["decision", "get", "occ"]), 0, "older self reads still work");
  assert.equal(calls.at(-1)?.url, "http://cp/api/sessions/parent/workflow-decisions/occ");
});

test("CLI typed decisions preserve exact snapshots while confining a child to itself", async () => {
  const calls: Array<{ url: string; method?: string; body?: string; headers?: Record<string, string> }> = [];
  const decisions = [
    { occurrenceId: "workflow_question", status: "pending" },
    { occurrenceId: "workflow_evidence", status: "pending" },
    { occurrenceId: "workflow_question", status: "approved" },
    { occurrenceId: "workflow_question", status: "consumed" },
  ];
  const fetch: McpFetch = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body, headers: init?.headers });
    const body = url.endsWith("/api/compatibility")
      ? { protocolVersion: PROTOCOL_VERSION }
      : decisions.shift();
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const env = {
    WOLLIPOG_CONTROL_PLANE_URL: "http://cp",
    WOLLIPOG_TOKEN: "child-token",
    WOLLIPOG_SESSION_ID: "codex-child",
  };
  const implementationQuestion = {
    category: "implementation_question",
    question: "Which bounded implementation should be used?",
    options: [
      { optionId: "cli", label: "CLI", description: "Reuse the session credential." },
      { optionId: "mcp", label: "MCP", description: "Add a launch-time server." },
    ],
  };
  const uiEvidence = {
    category: "ui_evidence_approval",
    evidence: [{ evidenceId: "desktop", uri: "https://evidence.invalid/desktop.png", sha256: "a".repeat(64) }],
  };
  const run = async (argv: string[]): Promise<unknown> => {
    let stdout = "";
    let stderr = "";
    assert.equal(await runWollipogCli(
      ["node", "cli.js", "--wollipog-cli", ...argv, "--json"],
      env,
      { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
      fetch,
    ), 0, stderr);
    return JSON.parse(stdout);
  };

  await run(["decision", "request", "--request-id", "question-1", "--resource-key", "implementation-1",
    "--snapshot", JSON.stringify(implementationQuestion)]);
  await run(["decision", "request", "--request-id", "evidence-1", "--resource-key", "evidence-1",
    "--snapshot", JSON.stringify(uiEvidence)]);
  await run(["decision", "get", "workflow_question"]);
  await run(["decision", "consume", "workflow_question", "--snapshot", JSON.stringify(implementationQuestion)]);

  const requests = calls.filter((call) => !call.url.endsWith("/api/compatibility"));
  assert.deepEqual(requests.map((call) => [call.method, call.url]), [
    ["POST", "http://cp/api/sessions/codex-child/workflow-decisions"],
    ["POST", "http://cp/api/sessions/codex-child/workflow-decisions"],
    ["GET", "http://cp/api/sessions/codex-child/workflow-decisions/workflow_question"],
    ["POST", "http://cp/api/sessions/codex-child/workflow-decisions/workflow_question/consume"],
  ]);
  assert.deepEqual(JSON.parse(requests[0]!.body!), {
    requestId: "question-1", resourceKey: "implementation-1", resourceSnapshot: implementationQuestion,
  });
  assert.deepEqual(JSON.parse(requests[1]!.body!), {
    requestId: "evidence-1", resourceKey: "evidence-1", resourceSnapshot: uiEvidence,
  });
  assert.deepEqual(JSON.parse(requests[3]!.body!), { resourceSnapshot: implementationQuestion });
  assert.ok(requests.every((call) => call.headers?.[WOLLIPOG_AGENT_ACTOR_SESSION_HEADER] === "codex-child"));
});

test("CLI reconciliation forwards only the original snapshot and preserves the server result or refusal", async () => {
  const snapshot = {
    category: "pr_merge", repository: "picoduck/wollipog", pullRequest: 42,
    headSha: "a".repeat(40), reviewResult: "merge",
    requiredChecks: { headSha: "a".repeat(40), status: "passed", checkedAt: 1,
      checks: [{ name: "Required", state: "passed" }] },
  };
  const calls: Array<{ url: string; method?: string; body?: string; headers?: Record<string, string> }> = [];
  let refused = false;
  const fetch: McpFetch = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body, headers: init?.headers });
    if (url.endsWith("/api/compatibility")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ protocolVersion: PROTOCOL_VERSION }) };
    }
    return refused
      ? { ok: false, status: 409, text: async () => JSON.stringify({ error: "workflow decision has no exact armed enqueue action to reconcile" }) }
      : { ok: true, status: 200, text: async () => JSON.stringify({ occurrenceId: "workflow_1", status: "consumed" }) };
  };
  const env = {
    WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "child-token", WOLLIPOG_SESSION_ID: "codex-child",
  };
  const run = async (): Promise<{ code: number; result: { decision?: unknown; error?: string } }> => {
    let stdout = "";
    const code = await runWollipogCli(
      ["node", "cli.js", "--wollipog-cli", "decision", "reconcile", "workflow_1", "--snapshot", JSON.stringify(snapshot), "--json"],
      env,
      { stdout: (text) => { stdout += text; }, stderr: () => assert.fail("JSON output belongs on stdout") },
      fetch,
    );
    return { code, result: JSON.parse(stdout) };
  };
  assert.deepEqual(await run(), { code: 0, result: { decision: { occurrenceId: "workflow_1", status: "consumed" } } });
  refused = true;
  assert.deepEqual(await run(), { code: 1, result: { error: "HTTP 409: workflow decision has no exact armed enqueue action to reconcile" } });
  const requests = calls.filter((call) => !call.url.endsWith("/api/compatibility"));
  assert.equal(requests.length, 2);
  assert.ok(requests.every((call) =>
    call.url === "http://cp/api/sessions/codex-child/workflow-decisions/workflow_1/reconcile" &&
    call.method === "POST" &&
    call.headers?.[WOLLIPOG_AGENT_ACTOR_SESSION_HEADER] === "codex-child" &&
    call.headers?.authorization === "Bearer child-token"));
  assert.ok(requests.every((call) => call.body === JSON.stringify({ resourceSnapshot: snapshot })),
    "reconciliation forwards no action or new admission");
});

test("CLI typed-decision help is discoverable and malformed or cross-session commands make no request", async () => {
  const rootHelpText = await captureCli(["help"]);
  assert.match(rootHelpText.stdout, /^\s+decision\s+Request, read, consume, and reconcile typed workflow decisions/mu);
  const topic = await captureCli(["help", "workflow-decisions"]);
  assert.equal(topic.code, 0);
  for (const text of [
    "decision request", "decision get", "decision consume", "decision reconcile", "request_workflow_decision",
    "get_workflow_decision", "consume_workflow_decision", "reconcile_workflow_decision",
    "protocol v153", "cannot resolve its own decision",
  ]) assert.ok(topic.stdout.includes(text), `decision help omits ${text}`);

  for (const malformed of [
    ["decision", "request", "--resource-key", "key", "--snapshot", "{}"],
    ["decision", "request", "--request-id", "id", "--resource-key", "key", "--snapshot", "not-json"],
    ["decision", "get"],
    ["decision", "consume", "--snapshot", "{}"],
    ["decision", "consume", "workflow_1", "--snapshot", "[]"],
    ["decision", "reconcile", "--snapshot", "{}"],
    ["decision", "reconcile", "workflow_1", "--snapshot", "[]"],
    ["decision", "reconcile", "workflow_1", "--snapshot", "not-json"],
    ["decision", "reconcile", "workflow_1", "--snapshot", "{}", "--action", "{}"],
    ["decision", "reconcile", "workflow_1", "--session", "other", "--snapshot", "{}"],
    ["decision", "get", "workflow_1", "--session"],
    ["decision", "list", "--limit", "101"],
    ["decision", "list", "--limit", "1.5"],
    ["decision", "list", "--cursor"],
    ["decision", "list", "unexpected"],
  ]) {
    const result = await captureCli([...malformed, "--json"]);
    assert.equal(result.code, 2, malformed.join(" "));
    assert.equal(result.stderr, "", malformed.join(" "));
    assert.match(JSON.parse(result.stdout).error, /requires|valid JSON|JSON object|not accept/u);
  }
});

test("CLI typed decisions fail closed before their protocol capability", async () => {
  let stdout = "";
  let calls = 0;
  const fetch: McpFetch = async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.typedWorkflowDecisionDelegation - 1,
      }),
    };
  };
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "decision", "get", "workflow_old", "--json"],
    { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "child-token", WOLLIPOG_SESSION_ID: "child" },
    { stdout: (text) => { stdout += text; }, stderr: () => {} },
    fetch,
  ), 1);
  assert.match(JSON.parse(stdout).error, new RegExp(
    `requires v${RUNNER_CAPABILITY_MIN_PROTOCOL.typedWorkflowDecisionDelegation}`, "u",
  ));
  assert.equal(calls, 1, "an old control plane receives only the compatibility probe");
});

test("CLI reconciliation requires protocol v153 before calling the endpoint", async () => {
  const calls: string[] = [];
  const fetch: McpFetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({
      protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.workflowDecisionActionReconciliation - 1,
    }) };
  };
  let stdout = "";
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "decision", "reconcile", "workflow_old", "--snapshot",
      JSON.stringify({ category: "pr_merge" }), "--json"],
    { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "child-token", WOLLIPOG_SESSION_ID: "child" },
    { stdout: (text) => { stdout += text; }, stderr: () => assert.fail("JSON output belongs on stdout") },
    fetch,
  ), 1);
  assert.match(JSON.parse(stdout).error, new RegExp(
    `requires v${RUNNER_CAPABILITY_MIN_PROTOCOL.workflowDecisionActionReconciliation}`, "u",
  ));
  assert.deepEqual(calls, ["http://cp/api/compatibility"]);
});

test("CLI issue closure preserves the exact proposal and refuses other sessions or old control planes", async () => {
  const proposal = { requestId: "close-123", issue: 123, reason: "completed", explanation: "Delivered.",
    evidence: ["Verified merged PR."], comment: "Exact\nclosing comment." };
  const calls: Array<{ url: string; body?: string }> = [];
  let version = PROTOCOL_VERSION;
  const fetch: McpFetch = async (url, init) => {
    calls.push({ url, body: init?.body });
    return { ok: true, status: 200, text: async () => JSON.stringify(url.endsWith("/api/compatibility")
      ? { protocolVersion: version } : { status: "consumed", issueClosureResult: { outcome: "closed" } }) };
  };
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "test-token",
    WOLLIPOG_SESSION_ID: "parent", WOLLIPOG_PERMISSION_PRESET: "orchestrator" };
  const io = { stdout: () => {}, stderr: () => {} };
  const invoke = (args: string[]) => runWollipogCli(["node", "cli.js", "--wollipog-cli", ...args], env, io, fetch);
  assert.equal(await invoke(["issue-closure", "request", "--proposal", JSON.stringify(proposal), "--json"]), 0);
  assert.deepEqual(JSON.parse(calls.at(-1)!.body!), proposal);
  assert.equal(calls.at(-1)!.url, "http://cp/api/sessions/parent/github-issue-closures");
  assert.equal(await invoke(["issue-closure", "execute", "gate-123", "--digest", "a".repeat(64), "--json"]), 0);
  assert.equal(calls.at(-1)!.url, "http://cp/api/sessions/parent/github-issue-closures/gate-123/execute");
  calls.length = 0;
  assert.equal(await invoke(["issue-closure", "execute", "gate-123", "--digest", "a".repeat(64), "--session", "other", "--json"]), 2);
  assert.equal(calls.length, 0);
  version = 193;
  assert.equal(await invoke(["issue-closure", "request", "--proposal", JSON.stringify(proposal), "--json"]), 1);
  assert.ok(calls.every((call) => call.url.endsWith("/api/compatibility")));
});

test("CLI automation proposals preserve configuration and expose read/execute without approval commands", async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  let version = PROTOCOL_VERSION;
  const fetch: McpFetch = async (url, init) => {
    calls.push({ url, body: init?.body });
    return { ok: true, status: 200, text: async () => JSON.stringify(url.endsWith("/api/compatibility")
      ? { protocolVersion: version } : { authority: "human", status: "pending" }) };
  };
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "test-token", WOLLIPOG_SESSION_ID: "self" };
  const invoke = (args: string[]) => runWollipogCli(["node", "cli.js", "--wollipog-cli", ...args, "--json"], env,
    { stdout() {}, stderr() {} }, fetch);
  const proposal = { requestId: "daily-1", resourceKey: "daily", spec: { name: "Daily", prompt: "Exact\ntext" } };
  assert.equal(await invoke(["automation", "request", "--proposal", JSON.stringify(proposal)]), 0);
  assert.deepEqual(JSON.parse(calls.at(-1)!.body!), proposal);
  assert.equal(await invoke(["automation", "get", "workflow_1"]), 0);
  assert.equal(calls.at(-1)!.url, "http://cp/api/sessions/self/automation-proposals/workflow_1");
  assert.equal(await invoke(["automation", "execute", "workflow_1", "--digest", "a".repeat(64)]), 0);
  assert.deepEqual(JSON.parse(calls.at(-1)!.body!), { resourceDigest: "a".repeat(64) });
  calls.length = 0;
  assert.equal(await invoke(["automation", "get", "workflow_1", "--session", "other"]), 2);
  assert.equal(calls.length, 0);
  assert.equal(await invoke(["automation", "approve", "workflow_1"]), 2);
  version = 231;
  assert.equal(await invoke(["automation", "request", "--proposal", JSON.stringify(proposal)]), 1);
  assert.ok(calls.every((call) => call.url.endsWith("/api/compatibility")));
  assert.match(resolveHelp(["help", "automation"])!.text, /human approval/);
});

test("CLI exact-result handoff forwards the descendant revision and refuses its own session", async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const output: string[] = [];
  const fetch: McpFetch = async (url, init) => {
    calls.push({ url, body: init?.body });
    return { ok: true, status: 200, text: async () => JSON.stringify(url.endsWith("/api/compatibility")
      ? { protocolVersion: PROTOCOL_VERSION } : { handedOff: true, session: { id: "child" } }) };
  };
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "test-token",
    WOLLIPOG_SESSION_ID: "parent", WOLLIPOG_PERMISSION_PRESET: "orchestrator" };
  const invoke = (args: string[]) => runWollipogCli(["node", "cli.js", "--wollipog-cli", ...args], env,
    { stdout: (text) => output.push(text), stderr: (text) => output.push(text) }, fetch);
  assert.equal(await invoke(["session", "handoff-result", "child", "--revision", "result-7", "--json"]), 0, output.join(""));
  assert.equal(calls.at(-1)!.url, "http://cp/api/sessions/child/result/handoff");
  assert.deepEqual(JSON.parse(calls.at(-1)!.body!), { revision: "result-7" });
  calls.length = 0;
  assert.equal(await invoke(["session", "handoff-result", "parent", "--revision", "result-7", "--json"]), 1);
  assert.ok(calls.every((call) => call.url.endsWith("/api/compatibility")));
});

test("CLI campaign ledger commands map to their tools and refuse other sessions or old control planes (#2417)", async () => {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  let version = PROTOCOL_VERSION;
  const fetch: McpFetch = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body });
    return { ok: true, status: 200, text: async () => JSON.stringify(url.endsWith("/api/compatibility")
      ? { protocolVersion: version } : { revision: 1 }) };
  };
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "test-token",
    WOLLIPOG_SESSION_ID: "parent", WOLLIPOG_PERMISSION_PRESET: "orchestrator" };
  const io = { stdout: () => {}, stderr: () => {} };
  const invoke = (args: string[]) => runWollipogCli(["node", "cli.js", "--wollipog-cli", ...args], env, io, fetch);
  const last = () => calls.filter((call) => !call.url.endsWith("/api/compatibility")).at(-1)!;
  const plan = { items: [{ key: "plan:a" }], planComplete: true };
  assert.equal(await invoke(["campaign", "plan", "--input", JSON.stringify(plan), "--json"]), 0);
  assert.equal(last().url, "http://cp/api/sessions/parent/orchestrator-campaign/plan");
  assert.deepEqual(JSON.parse(last().body!), plan);
  assert.equal(await invoke(["campaign", "update-item", "cwi_1", "--input", JSON.stringify({ nextAction: "Dispatch" }), "--json"]), 0);
  assert.equal(last().url, "http://cp/api/sessions/parent/orchestrator-campaign/work-items/cwi_1");
  assert.deepEqual(JSON.parse(last().body!), { nextAction: "Dispatch" });
  assert.equal(await invoke(["campaign", "assign", "cwi_1", "child", "--json"]), 0);
  assert.equal(last().url, "http://cp/api/sessions/parent/orchestrator-campaign/work-items/cwi_1/assign");
  assert.deepEqual(JSON.parse(last().body!), { childSessionId: "child" });
  assert.equal(await invoke(["campaign", "adjudicate", "followup_1", "--input",
    JSON.stringify({ disposition: "deferred", reason: "Later" }), "--json"]), 0);
  assert.equal(last().url, "http://cp/api/sessions/parent/orchestrator-campaign/recommendations/followup_1/adjudicate");
  assert.equal(await invoke(["campaign", "work-items", "--state", "all", "--limit", "5", "--recommendations", "--json"]), 0);
  assert.equal(last().url,
    "http://cp/api/sessions/parent/orchestrator-campaign/work-items?limit=5&state=all&includeRecommendations=true");
  assert.equal(await invoke(["campaign", "work-items", "--item", "cwi_1", "--json"]), 0);
  assert.equal(last().url, "http://cp/api/sessions/parent/orchestrator-campaign/work-items/cwi_1");
  calls.length = 0;
  assert.equal(await invoke(["campaign", "assign", "cwi_1", "child", "--session", "other", "--json"]), 2);
  assert.equal(await invoke(["campaign", "plan", "--json"]), 2, "plan requires --input");
  assert.equal(calls.length, 0);
  version = 195;
  assert.equal(await invoke(["campaign", "plan", "--input", JSON.stringify(plan), "--json"]), 1);
  assert.ok(calls.every((call) => call.url.endsWith("/api/compatibility")));

});

test("review session commands map to the session's own review session tools (#3368)", async () => {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  let version = PROTOCOL_VERSION;
  const fetch: McpFetch = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body });
    return { ok: true, status: 200, text: async () => JSON.stringify(url.endsWith("/api/compatibility")
      ? { protocolVersion: version } : { reviewSessionId: "s_review", terminal: false }) };
  };
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "test-token", WOLLIPOG_SESSION_ID: "self" };
  const io = { stdout: () => {}, stderr: () => {} };
  const invoke = (args: string[]) => runWollipogCli(["node", "cli.js", "--wollipog-cli", ...args], env, io, fetch);
  const last = () => calls.filter((call) => !call.url.endsWith("/api/compatibility")).at(-1)!;
  const root = mkdtempSync(join(tmpdir(), "wollipog-review-session-brief-"));
  try {
    const brief = join(root, "brief.md");
    writeFileSync(brief, "# Intent\nReview #3368.\n");
    const head = "c".repeat(40);
    assert.equal(await invoke(["review", "session", "run", "--repo", "picoduck/wollipog", "--pr", "3368", "--head", head, "--brief-file", brief, "--json"]), 0);
    assert.equal(last().method, "POST");
    assert.equal(last().url, "http://cp/api/sessions/self/review-sessions");
    assert.deepEqual(JSON.parse(last().body!), { pullRequest: { repository: "picoduck/wollipog", number: 3368 }, headSha: head, brief: "# Intent\nReview #3368.\n" });
    assert.equal(await invoke(["review", "session", "run", "--repo", "picoduck/wollipog", "--pr", "3368", "--head", head, "--brief-file", brief,
      "--full-reason", "Rebased onto main", "--json"]), 0);
    assert.equal(JSON.parse(last().body!).fullReason, "Rebased onto main");
    assert.equal(await invoke(["review", "session", "get", "s_review", "--json"]), 0);
    assert.equal(last().url, "http://cp/api/sessions/self/review-sessions/s_review");
    assert.equal(await invoke(["review", "session", "list", "--limit", "5", "--cursor", "s_review", "--json"]), 0);
    assert.equal(last().url, "http://cp/api/sessions/self/review-sessions?limit=5&afterReviewSessionId=s_review");
    assert.equal(await invoke(["review", "session", "cancel", "s_review", "--json"]), 0);
    assert.equal(last().url, "http://cp/api/sessions/self/review-sessions/s_review/cancel");

    calls.length = 0;
    for (const args of [
      ["review", "session", "run", "--repo", "picoduck/wollipog", "--pr", "1", "--head", head],
      ["review", "session", "run", "--repo", "picoduck/wollipog", "--pr", "0", "--head", head, "--brief-file", brief],
      ["review", "session", "run", "--repo", "picoduck/wollipog", "--pr", "1", "--head", head, "--brief-file", join(root, "missing.md")],
      ["review", "session", "run", "--repo", "picoduck/wollipog", "--pr", "1", "--head", head, "--brief-file", brief, "--full-reason", "--json"],
      ["review", "session", "get", "s_review", "--session", "other"],
      ["review", "session", "get"],
    ]) assert.equal(await invoke([...args, "--json"]), 2, args.join(" "));
    assert.equal(calls.length, 0);
    version = RUNNER_CAPABILITY_MIN_PROTOCOL.reviewSession - 1;
    assert.equal(await invoke(["review", "session", "list", "--json"]), 1);
    assert.ok(calls.every((call) => call.url.endsWith("/api/compatibility")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("retired review CLI spellings refuse with review-session guidance without contacting a control plane", async () => {
  for (const args of [["review", "run"], ["review", "get", "old"], ["review", "list"], ["review", "cancel", "old"],
    ["campaign", "review"], ["campaign", "review-job", "old"], ["campaign", "review-jobs"], ["campaign", "review-report", "old"]]) {
    let output = ""; let calls = 0;
    const result = await runWollipogCli(["node", "cli.js", "--wollipog-cli", ...args, "--json"], {},
      { stdout: text => { output += text; }, stderr: text => { output += text; } },
      async () => { calls++; throw Error("must not contact a retired endpoint"); });
    assert.equal(result, 2, args.join(" "));
    assert.match(output, /retired.*review session/u);
    assert.equal(calls, 0);
  }
  const help = resolveHelp(["help", "review"])!.text;
  assert.match(help, /review session run/u);
  assert.doesNotMatch(help, /review run|review get|review list|review cancel|cross_model_review/u);
  assert.doesNotMatch(resolveHelp(["help", "campaign"])!.text, /review-job|review-report|campaign review/u);
});
