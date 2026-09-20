/**
 * Measure whether a Codex `PreToolUse` hook actually runs, and still denies an already-APPROVED
 * escalated command, under `codex app-server` (#1499).
 *
 *   pnpm probe:codex-guard-hook            # needs a real `codex` on PATH; nothing else
 *   CODEX_BIN=/path/to/codex pnpm probe:codex-guard-hook
 *
 * This is NOT part of `pnpm test`: it spawns a real `codex app-server` and takes about a minute.
 * It is the evidence behind `codexGuardTrustOverride`, `codexHookTrustVerdict`, and the reviewer
 * gate in `buildCodexTurnParams`, kept runnable so a future codex-cli is re-measured, not re-argued.
 *
 * Two facts it pins, both of which the runner's behaviour now depends on:
 *
 *   1. `--dangerously-bypass-hook-trust` does NOTHING on `codex app-server`. A session-flags hook
 *      stays `untrusted` and is skipped silently, so a launch that passes the flag and believes it
 *      has a guard has no guard. A `hooks.state` trust override keyed on the hook's own
 *      `currentHash` does work, and `hooks/list` then reports it `trusted` — which is what makes
 *      the claim readable back instead of assumed.
 *   2. With the hook trusted, a protected command is denied whoever approves: with no escalation,
 *      with an escalation this client accepts, and with `approvalsReviewer: "auto_review"`. The
 *      denial lands BEFORE the approval is raised, so a protected command never becomes a prompt.
 *
 * Nothing here reaches the real network or a real model: the model is a scripted local
 * Responses-API server behind a throwaway `CODEX_HOME`, and the "guard" is a stand-in hook that
 * writes the same deny payload `managedWorktreeGuardDenyPayload` writes and logs every invocation,
 * so "never fired" is always distinguishable from "fired and allowed".
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CODEX = process.env.CODEX_BIN || "codex";
const TURN_TIMEOUT_MS = 90_000;
const MARKER = "PROTECTED-WORKTREE-MARKER";
const MATCHER = "Bash|apply_patch|exec_command|unified_exec|shell";

type Json = Record<string, unknown>;

interface Case {
  name: string;
  /** `bypass` is the pre-#1499 mechanism; `trust` is the hash override; `none` installs no hook. */
  trust: "bypass" | "trust" | "none";
  protected: boolean;
  escalate: boolean;
  guardian: boolean;
  /** `denied` means the hook blocked it; `ran` means the command produced output. */
  expect: "denied" | "ran";
  /** How many times the hook process must have been invoked. */
  hookCalls: number;
}

const CASES: Case[] = [
  // 1. The bypass flag is inert here: the hook never runs and the protected command executes.
  { name: "bypass flag · protected · no escalation", trust: "bypass", protected: true, escalate: false, guardian: false, expect: "ran", hookCalls: 0 },
  { name: "bypass flag · protected · escalated", trust: "bypass", protected: true, escalate: true, guardian: false, expect: "ran", hookCalls: 0 },
  // 2. The trust override makes the hook run, and it denies whoever approves.
  { name: "trust override · protected · no escalation", trust: "trust", protected: true, escalate: false, guardian: false, expect: "denied", hookCalls: 1 },
  { name: "trust override · protected · escalated, client accepts", trust: "trust", protected: true, escalate: true, guardian: false, expect: "denied", hookCalls: 1 },
  { name: "trust override · protected · escalated, Guardian reviews", trust: "trust", protected: true, escalate: true, guardian: true, expect: "denied", hookCalls: 1 },
  // 3. No false positives: a benign command still runs with the hook in force.
  { name: "trust override · benign · escalated", trust: "trust", protected: false, escalate: true, guardian: false, expect: "ran", hookCalls: 1 },
  // 4. Control: with no hook at all, the protected command runs.
  { name: "no hook · protected · escalated", trust: "none", protected: true, escalate: true, guardian: false, expect: "ran", hookCalls: 0 },
];

interface Fixture { repo: string; codexHome: string; hook: string; hookLog: string; modelPort: number }

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

function message(text: string): Json {
  return { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text }] };
}

/** One scripted agent turn, plus scripted Guardian verdicts on the same provider. */
function modelServer(state: { tool: Json | null; calls: number }): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body: Json = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json; } catch { /* keep {} */ }
      const guardian = String(body.model ?? "").startsWith("codex-auto-review");
      const step = guardian ? -1 : state.calls++;
      const item: Json = guardian
        ? message(JSON.stringify({ outcome: "allow", risk_level: "low", user_authorization: "high", rationale: "scripted" }))
        : step === 0 && state.tool
          ? { type: "function_call", id: "fc", call_id: "call", name: "exec_command", arguments: JSON.stringify(state.tool), status: "completed" }
          : message("finished");
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (event: string, data: Json) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("response.created", { type: "response.created", response: { id: "r", status: "in_progress", output: [] } });
      send("response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
      send("response.completed", { type: "response.completed", response: { id: "r", status: "completed", output: [item] } });
      response.end();
    });
  });
}

function killTree(child: ChildProcess): void {
  if (typeof child.pid === "number") {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group is already gone */ }
  }
  try { child.kill("SIGKILL"); } catch { /* already exited */ }
}

/** Drive one real `codex app-server` turn and report what the command did. */
function runTurn(
  fixture: Fixture,
  args: readonly string[],
  turnExtras: Json,
  accept: boolean,
): Promise<string> {
  const child = spawn(CODEX, [...args, "app-server"], {
    cwd: fixture.repo,
    env: { ...process.env, CODEX_HOME: fixture.codexHome, PROBE_KEY: "x" },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  return new Promise<string>((resolve) => {
    let settled = false;
    let outcome = "no command ran";
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child);
      resolve(value);
    };
    const timer = setTimeout(() => finish("TIMED OUT"), TURN_TIMEOUT_MS);
    const send = (payload: Json) => {
      if (settled || child.stdin.destroyed) return;
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };
    child.stdin.on("error", (error: Error) => { outcome = `STDIN FAILED: ${error.message}`; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { if (process.env.PROBE_DEBUG) process.stderr.write(chunk); });
    child.on("error", (error) => finish(`SPAWN FAILED: ${error.message}`));
    child.on("close", () => finish(outcome));

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let msg: Json & { id?: unknown; method?: string; params?: Json; result?: Json };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method?.endsWith("/requestApproval") && msg.id !== undefined) {
          send({ jsonrpc: "2.0", id: msg.id, result: { decision: accept ? "accept" : "decline" } });
          continue;
        }
        if (msg.method === "item/completed") {
          const item = (msg.params?.item ?? {}) as Json;
          if (item.type === "commandExecution") {
            outcome = item.status === "declined"
              ? "declined"
              : String(item.aggregatedOutput ?? item.output ?? "").trim() || "(no output)";
          }
          continue;
        }
        if (msg.method === "turn/completed" || msg.method === "turn/failed") { finish(outcome); return; }
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { cwd: fixture.repo } });
          continue;
        }
        if (msg.id === 2) {
          const threadId = ((msg.result?.thread ?? {}) as Json).id;
          send({ jsonrpc: "2.0", id: 3, method: "turn/start", params: {
            threadId,
            input: [{ type: "text", text: "go" }],
            approvalPolicy: "on-request",
            sandboxPolicy: { type: "workspaceWrite" },
            cwd: fixture.repo,
            ...turnExtras,
          } });
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "wollipog-guard-probe", version: "0" } } });
  });
}

/** Ask a throwaway app-server what hooks this argv installs, and how it rates their trust. */
function readInventory(fixture: Fixture, args: readonly string[]): Promise<Json[]> {
  const child = spawn(CODEX, [...args, "app-server"], {
    cwd: fixture.repo,
    env: { ...process.env, CODEX_HOME: fixture.codexHome, PROBE_KEY: "x" },
    stdio: ["pipe", "pipe", "ignore"],
    detached: true,
  });
  return new Promise<Json[]>((resolve) => {
    let settled = false;
    const finish = (value: Json[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child);
      resolve(value);
    };
    const timer = setTimeout(() => finish([]), 30_000);
    const send = (payload: Json) => {
      if (settled || child.stdin.destroyed) return;
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };
    child.stdin.on("error", () => {});
    child.on("error", () => finish([]));
    child.on("close", () => finish([]));
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let msg: Json & { id?: unknown; result?: Json };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 2) continue;
        const groups = ((msg.result ?? {}).data ?? []) as { hooks?: Json[] }[];
        finish(groups.flatMap((group) => group.hooks ?? []));
        return;
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "wollipog-guard-probe", version: "0" } } });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "hooks/list", params: { cwds: [fixture.repo] } });
  });
}

function hookArgs(fixture: Fixture): string[] {
  return ["-c", `hooks.PreToolUse=[{matcher="${MATCHER}",hooks=[{type="command",command="/bin/bash ${fixture.hook}"}]}]`];
}

async function main(): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), "wollipog-guard-hook-probe-"));
  const fixture: Fixture = {
    repo: join(root, "repo"),
    codexHome: join(root, "codex-home"),
    hook: join(root, "guard.sh"),
    hookLog: join(root, "hook-calls.log"),
    modelPort: 0,
  };
  const model = { tool: null as Json | null, calls: 0 };
  const models = modelServer(model);
  let failures = 0;
  try {
    mkdirSync(fixture.repo, { recursive: true });
    mkdirSync(fixture.codexHome, { recursive: true });
    writeFileSync(fixture.hook,
      "#!/bin/bash\n" +
      'input=$(cat)\n' +
      `printf 'call\\n' >> ${JSON.stringify(fixture.hookLog)}\n` +
      `case "$input" in\n  *${MARKER}*)\n` +
      `    printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse",` +
      `"permissionDecision":"deny","permissionDecisionReason":"MANAGED_WORKTREE_REFUSAL: probe"}}'\n` +
      "    exit 0\n    ;;\nesac\nexit 0\n", { mode: 0o755 });
    writeFileSync(fixture.hookLog, "");
    await gitInit(fixture.repo);

    fixture.modelPort = await listen(models);
    writeFileSync(join(fixture.codexHome, "config.toml"),
      'model = "probe-model"\nmodel_provider = "probe"\napproval_policy = "on-request"\n\n' +
      '[model_providers.probe]\nname = "Probe"\n' +
      `base_url = "http://127.0.0.1:${fixture.modelPort}/v1"\n` +
      'wire_api = "responses"\nenv_key = "PROBE_KEY"\n');

    // The hash is Codex's own digest of the hook's definition, so it is read rather than computed.
    const installed = await readInventory(fixture, hookArgs(fixture));
    const ours = installed.find((hook) => String(hook.command ?? "").includes(fixture.hook));
    if (!ours || typeof ours.currentHash !== "string") {
      process.stdout.write("FAIL  the probe hook was not installed, or reported no currentHash\n");
      return 1;
    }
    const trustOverride =
      `hooks.state={${JSON.stringify(String(ours.key))}={trusted_hash=${JSON.stringify(ours.currentHash)}}}`;
    process.stdout.write(`installed hook ${String(ours.key)} trustStatus=${String(ours.trustStatus)}\n`);

    // The read-back the runner relies on: with the override present, the hook reports trusted.
    const trusted = await readInventory(fixture, [...hookArgs(fixture), "-c", trustOverride]);
    const trustedOurs = trusted.find((hook) => String(hook.command ?? "").includes(fixture.hook));
    const trustedOk = String(trustedOurs?.trustStatus) === "trusted";
    if (!trustedOk) failures++;
    process.stdout.write(
      `${trustedOk ? "ok  " : "FAIL"}  the trust override makes hooks/list report it trusted ` +
      `(got ${String(trustedOurs?.trustStatus)})\n\n`);

    for (const testCase of CASES) {
      writeFileSync(fixture.hookLog, "");
      model.tool = {
        cmd: testCase.protected ? `echo ${MARKER}` : "echo BENIGN-OK",
        yield_time_ms: 5000,
        ...(testCase.escalate
          ? { sandbox_permissions: "require_escalated", justification: "the probe needs it" }
          : {}),
      };
      model.calls = 0;
      const args = testCase.trust === "none"
        ? []
        : testCase.trust === "bypass"
          ? [...hookArgs(fixture), "--dangerously-bypass-hook-trust"]
          : [...hookArgs(fixture), "-c", trustOverride];
      const output = await runTurn(
        fixture, args, testCase.guardian ? { approvalsReviewer: "auto_review" } : {}, true,
      );
      const calls = readFileSync(fixture.hookLog, "utf8").split("\n").filter(Boolean).length;
      const denied = output === "declined" || output === "no command ran";
      const ok = (testCase.expect === "denied" ? denied : !denied) && calls === testCase.hookCalls;
      if (!ok) failures++;
      process.stdout.write(
        `${ok ? "ok  " : "FAIL"}  ${testCase.name.padEnd(50)} ` +
        `${testCase.expect.padEnd(7)} hook×${calls} ${JSON.stringify(output.slice(0, 40))}\n`);
    }
  } finally {
    models.close();
    rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write(failures === 0
    ? `\nAll ${CASES.length + 1} checks matched the recorded measurement.\n`
    : `\n${failures} check(s) did NOT match. Codex's hook behaviour has moved; re-read ADR 0012 ` +
      "before changing code.\n");
  return failures === 0 ? 0 : 1;
}

const FIXTURE_TIMEOUT_MS = 30_000;

/** The throwaway repository, bounded and stripped of the developer's own Git configuration. */
function gitInit(repo: string): Promise<void> {
  const run = (args: string[]): Promise<void> => new Promise((resolve, reject) => {
    const child: ChildProcess = spawn("git", [
      "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false",
      "-c", "user.email=probe@example.invalid", "-c", "user.name=probe", ...args,
    ], { cwd: repo, stdio: "ignore", detached: true });
    const timer = setTimeout(() => {
      killTree(child);
      reject(new Error(`git ${args[0]} did not finish within ${FIXTURE_TIMEOUT_MS}ms`));
    }, FIXTURE_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0]} exited ${String(code)}`));
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
  writeFileSync(join(repo, "file.txt"), "hello\n");
  return run(["init", "-q", "."])
    .then(() => run(["add", "-A"]))
    .then(() => run(["commit", "-qm", "init"]));
}

main().then((code) => { process.exitCode = code; }, (error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
