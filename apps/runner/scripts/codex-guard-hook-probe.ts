/**
 * Measure whether a Codex `PreToolUse` hook actually runs, and still denies an already-APPROVED
 * escalated command, under `codex app-server` (#1499), and measure hash trust on exec/TUI (#1488).
 *
 *   pnpm probe:codex-guard-hook            # real `codex`, Git, POSIX shell and Python 3 (PTY)
 *   pnpm probe:codex-guard-hook --cli-only # exec + real TUI, including foreign-hook controls
 *   pnpm probe:codex-guard-hook --exec-only
 *   pnpm probe:codex-guard-hook --tui-only
 *   CODEX_BIN=/path/to/codex pnpm probe:codex-guard-hook
 *
 * This is NOT part of `pnpm test`: it spawns real Codex entry points and takes about a minute.
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
 * The CLI matrix proves a matching hash fires and allows/denies, while foreign untrusted hooks
 * stay gated. Untrusted/stale-hash controls skip ours; a bypass control fires both hooks. TUI
 * onboarding explicitly continues WITHOUT trusting hooks. Each CLI case checks an execution file,
 * invocation logs and deny evidence; a timeout or missing turn is a failure.
 *
 * Nothing here reaches the external network or a real model: the model is a scripted local
 * Responses-API server behind a throwaway `CODEX_HOME`, and the "guard" is a stand-in hook that
 * writes the same deny payload `managedWorktreeGuardDenyPayload` writes and logs every invocation,
 * so "never fired" is always distinguishable from "fired and allowed".
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Never inherit a provider home, credential, Git config, or app-server endpoint from the host. */
function probeEnv(fixture: Fixture): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: fixture.codexHome, CODEX_HOME: fixture.codexHome,
    XDG_CONFIG_HOME: fixture.codexHome, XDG_DATA_HOME: fixture.codexHome,
    XDG_STATE_HOME: fixture.codexHome, XDG_CACHE_HOME: fixture.codexHome,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    PROBE_KEY: "scripted-local-provider", TERM: "xterm-256color", LANG: "C.UTF-8",
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

function message(text: string): Json {
  return { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text }] };
}

/** One scripted agent turn, plus scripted Guardian verdicts on the same provider. */
function modelServer(state: { tool: Json | null; calls: number; input: string }): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body: Json = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json; } catch { /* keep {} */ }
      const guardian = String(body.model ?? "").startsWith("codex-auto-review");
      if (!guardian) state.input += JSON.stringify(body.input);
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
    env: probeEnv(fixture),
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
    env: probeEnv(fixture),
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
        if (msg.id === 1 && process.env.PROBE_DEBUG) process.stderr.write(`initialize: ${JSON.stringify(msg.result)}\n`);
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

/** A real interactive terminal, including the cursor-position handshake Codex requires. */
function runCliTurn(fixture: Fixture, args: string[], entry: "exec" | "tui"): Promise<string> {
  const common = [...args, "-a", "never", "-s", "danger-full-access"];
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let stopping = false;
    let ending = "";
    let stop: () => void = () => {};
    const finish = (suffix = "") => {
      if (stopping || settled) return;
      stopping = true;
      ending = suffix;
      stop();
    };
    const complete = (suffix = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(output + ending + suffix);
    };
    const timer = setTimeout(() => finish("\nTIMED OUT"), TURN_TIMEOUT_MS);
    if (entry === "exec") {
      const child = spawn(CODEX, [...common, "exec", "--json", "go"], {
        cwd: fixture.repo, env: probeEnv(fixture), stdio: ["ignore", "pipe", "pipe"], detached: true,
      });
      stop = () => killTree(child);
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.on("error", (error) => complete(`\nSPAWN FAILED: ${error.message}`));
      child.on("close", (code) => complete(code === 0 ? "" : `\nEXIT ${code}`));
    } else {
      // Python's standard-library PTY avoids a native node-pty build prerequisite for this probe.
      const terminal = spawn("python3", ["-u", "-c", PTY_DRIVER,
        CODEX, ...common, "--no-alt-screen", "go"], {
        cwd: fixture.repo, env: probeEnv(fixture), stdio: ["ignore", "pipe", "pipe"],
      });
      stop = () => { terminal.kill("SIGTERM"); };
      terminal.stdout.on("data", (chunk: Buffer) => {
        if (process.env.PROBE_DEBUG) process.stderr.write(chunk);
        output += chunk.toString();
        if (output.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "").includes("finished")) finish();
      });
      terminal.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      terminal.on("error", (error) => complete(`\nSPAWN FAILED: ${error.message}`));
      terminal.on("close", (code) => complete(`\nEXIT ${code}`));
    }
  });
}

const PTY_DRIVER = String.raw`
import fcntl, os, pty, signal, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
def stop(*_):
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    os.waitpid(pid, 0)
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
pending = b""
skipped_review = False
try:
    while True:
        data = os.read(fd, 65536)
        if not data: break
        os.write(1, data)
        pending += data
        if b"Hooks need review" in pending and not skipped_review:
            # Continue without granting trust to either hook. Existing hash trust must suffice.
            time.sleep(0.2)
            os.write(fd, b"3")
            time.sleep(0.2)
            os.write(fd, b"\r")
            skipped_review = True
        for query, answer in [(b"\x1b[6n", b"\x1b[1;1R"), (b"\x1b[c", b"\x1b[?1;2c")]:
            if query in pending:
                os.write(fd, answer)
                pending = pending.replace(query, b"")
        pending = pending[-16384:]
except OSError:
    pass
stop()
`;

/** Controls prove silent skipping separately from a hook that fires and allows the command. */
async function cliMeasurements(fixture: Fixture, model: { tool: Json | null; calls: number; input: string }): Promise<number> {
  const foreignLog = join(fixture.codexHome, "foreign-calls.log");
  const foreignHook = join(fixture.codexHome, "foreign.sh");
  const executed = join(fixture.repo, "executed");
  writeFileSync(foreignHook, `#!/bin/sh\ncat >/dev/null\nprintf 'call\\n' >> '${foreignLog}'\n`, { mode: 0o755 });
  const args = ["-c", `hooks.PreToolUse=[{matcher="${MATCHER}",hooks=[` +
    `{type="command",command="/bin/bash ${fixture.hook}"},` +
    `{type="command",command="/bin/sh ${foreignHook}"}]}]`];
  const inventory = await readInventory(fixture, args);
  const ours = inventory.find((hook) => String(hook.command ?? "").includes(fixture.hook));
  const foreign = inventory.find((hook) => String(hook.command ?? "").includes(foreignHook));
  if (!ours?.currentHash || !ours.key || foreign?.trustStatus !== "untrusted") {
    throw new Error("CLI measurement cannot identify its own hash and the foreign untrusted hook");
  }
  const override = (hash: string) => `hooks.state={${JSON.stringify(ours.key)}={trusted_hash=${JSON.stringify(hash)}}}`;
  const trustedArgs = [...args, "-c", override(String(ours.currentHash))];
  const readback = await readInventory(fixture, trustedArgs);
  if (readback.find((hook) => hook.key === ours.key)?.trustStatus !== "trusted" ||
      readback.find((hook) => hook.key === foreign.key)?.trustStatus !== "untrusted") {
    throw new Error("CLI measurement trust read-back did not confirm trusted own / untrusted foreign hooks");
  }
  process.stdout.write("\nCLI inventory read-back: own=trusted, foreign=untrusted, bypass absent\n");
  let failures = 0;
  for (const entry of ["exec", "tui"] as const) {
    if (process.argv.includes("--exec-only") && entry !== "exec") continue;
    if (process.argv.includes("--tui-only") && entry !== "tui") continue;
    for (const test of [
      { name: "untrusted", args, protected: true, calls: 0, foreign: 0, ran: true },
      { name: "matching hash, deny", args: trustedArgs, protected: true, calls: 1, foreign: 0, ran: false },
      { name: "matching hash, allow", args: trustedArgs, protected: false, calls: 1, foreign: 0, ran: true },
      { name: "stale hash", args: [...args, "-c", override("stale")], protected: true, calls: 0, foreign: 0, ran: true },
      { name: "bypass control", args: [...args, "--dangerously-bypass-hook-trust"], protected: false, calls: 1, foreign: 1, ran: true },
    ]) {
      writeFileSync(fixture.hookLog, "");
      writeFileSync(foreignLog, "");
      rmSync(executed, { force: true });
      model.calls = 0;
      model.input = "";
      model.tool = { cmd: `echo ${test.protected ? MARKER : "BENIGN-OK"} > '${executed}'`, yield_time_ms: 1000 };
      const output = await runCliTurn(fixture, test.args, entry);
      const calls = readFileSync(fixture.hookLog, "utf8").split("\n").filter(Boolean).length;
      const foreignCalls = readFileSync(foreignLog, "utf8").split("\n").filter(Boolean).length;
      const ran = existsSync(executed);
      const denied = model.input.includes("MANAGED_WORKTREE_REFUSAL");
      const ok = calls === test.calls && foreignCalls === test.foreign && ran === test.ran &&
        (test.ran || denied) && model.calls >= 2 && !output.includes("TIMED OUT");
      if (!ok) failures++;
      process.stdout.write(`${ok ? "ok  " : "FAIL"}  ${entry} · ${test.name}: own×${calls} foreign×${foreignCalls} ran=${ran} denied=${denied} model×${model.calls}\n`);
      if (!ok || process.env.PROBE_DEBUG) process.stderr.write(output.slice(-6000) + "\n");
      if (output.includes("TIMED OUT")) throw new Error(`${entry} did not complete a real turn`);
    }
  }
  return failures;
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
  const model = { tool: null as Json | null, calls: 0, input: "" };
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
    await gitInit(fixture);
    process.stdout.write(execFileSync(CODEX, ["--version"], { env: probeEnv(fixture), encoding: "utf8", timeout: 30_000 }));

    fixture.modelPort = await listen(models);
    writeFileSync(join(fixture.codexHome, "config.toml"),
      'model = "probe-model"\nmodel_provider = "probe"\napproval_policy = "on-request"\n\n' +
      '[model_providers.probe]\nname = "Probe"\n' +
      `base_url = "http://127.0.0.1:${fixture.modelPort}/v1"\n` +
      'wire_api = "responses"\nenv_key = "PROBE_KEY"\n' +
      `\n[projects.${JSON.stringify(fixture.repo)}]\ntrust_level = "trusted"\n`);

    failures += await cliMeasurements(fixture, model);
    if (process.argv.includes("--cli-only") || process.argv.includes("--exec-only") || process.argv.includes("--tui-only")) return failures ? 1 : 0;

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
      model.input = "";
      const args = testCase.trust === "none"
        ? []
        : testCase.trust === "bypass"
          ? [...hookArgs(fixture), "--dangerously-bypass-hook-trust"]
          : [...hookArgs(fixture), "-c", trustOverride];
      const output = await runTurn(
        fixture, args, {
          ...(testCase.guardian ? { approvalsReviewer: "auto_review" } : {}),
          // No sandbox is needed to measure hook trust, and this also works on a host where
          // unprivileged namespaces are unavailable. Escalated cases still request approval.
          ...(!testCase.escalate ? { sandboxPolicy: { type: "dangerFullAccess" } } : {}),
        }, true,
      );
      const calls = readFileSync(fixture.hookLog, "utf8").split("\n").filter(Boolean).length;
      const denied = model.input.includes("MANAGED_WORKTREE_REFUSAL") &&
        (output === "declined" || output === "no command ran");
      const ran = output === (testCase.protected ? MARKER : "BENIGN-OK");
      const ok = (testCase.expect === "denied" ? denied : ran) && calls === testCase.hookCalls && model.calls >= 2;
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
    ? `\nAll CLI cases and ${CASES.length + 1} app-server checks matched the recorded measurement.\n`
    : `\n${failures} check(s) did NOT match. Codex's hook behaviour has moved; re-read ADR 0012 ` +
      "before changing code.\n");
  return failures === 0 ? 0 : 1;
}

const FIXTURE_TIMEOUT_MS = 30_000;

/** The throwaway repository, bounded and stripped of the developer's own Git configuration. */
function gitInit(fixture: Fixture): Promise<void> {
  const { repo } = fixture;
  const run = (args: string[]): Promise<void> => new Promise((resolve, reject) => {
    const child: ChildProcess = spawn("git", [
      "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false",
      "-c", "user.email=probe@example.invalid", "-c", "user.name=probe", ...args,
    ], { cwd: repo, env: probeEnv(fixture), stdio: "ignore", detached: true });
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
