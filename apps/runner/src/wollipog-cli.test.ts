import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  PROTOCOL_VERSION,
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
} from "@wollipog/protocol";
import type { McpFetch } from "./session-management-mcp.js";
import { runWollipogCli } from "./wollipog-cli.js";
import { expandCommandAlias, resolveHelp } from "./wollipog-help.js";

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
    "session", "worktree", "admin", "service", "help [topic]", "doctor", "update", "pair <command>",
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
    ["session", ["session list", "session create", "session wait", "session guardrails"]],
    ["worktree", ["worktree create", "worktree attach", "worktree select", "worktree discard"]],
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
    ["wollipog", "session", "prompt", "s_child", "--wollipog-cli"],
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
    ["wollipog-runner.exe", "--wollipog-cli", "--version"],
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
    ["node", "cli.js", "--wollipog-cli", "session", "create", "--runner", "r1", "--agent", "codex", "--workspace", "ws", "--prompt", "Do it", "--json"],
    env,
    { stdout: (text) => { output += text; }, stderr: () => {} },
    fetch,
  ), 0);
  assert.equal(JSON.parse(output).session.id, "s_new");
  assert.equal(requests[1]!.url, "http://cp/api/sessions");
  assert.deepEqual(JSON.parse(requests[1]!.body!), {
    runnerId: "r1", agentId: "codex", workspaceId: "ws", prompt: "Do it", useWorktree: false,
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

test("CLI gates destructive worktree discard on v102 without disabling v101 selection", async () => {
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
  assert.match(JSON.parse(output).error, /requires v102/);
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
    { argv: ["session", "events", "s_child", "--after", "4", "--limit", "2"], method: "GET", path: "/api/sessions/s_child/events?after=4" },
    { argv: ["session", "prompt", "s_child", "Keep", "going"], method: "POST", path: "/api/sessions/s_child/prompt" },
    { argv: ["session", "wait", "s_child", "--for", "completed", "--timeout", "50"], method: "GET", path: "/api/sessions/s_child" },
    { argv: ["session", "stop", "s_child"], method: "POST", path: "/api/sessions/s_child/stop" },
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
      [executable, "session", "list", "--json"],
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
