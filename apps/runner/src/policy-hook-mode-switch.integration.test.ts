import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { defaultLocalDeviceTokenPath, loadOrCreateLocalDeviceToken } from "../../control-plane/src/local-device-credential.js";

// A Claude session launched in `auto` keeps its stdio-control approval channel, so it is provisioned
// without the manager PreToolUse policy hook. When a LATER prompt switches it to a fixed-rule mode
// (`acceptEdits`) on the same runner, the driver respawns the provider with the new
// `--permission-mode`. That respawn must carry the manager policy hook, exactly as a launch that
// started in `acceptEdits` does; otherwise governance deny/ask policies are not evaluated for it.

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const RUNNER_ID = "policy-hook-mode-switch-runner";
const CONTROL_PLANE_TOKEN = "policy-hook-mode-switch-control-plane-token";
const TRANSPORT_UNAVAILABLE = "Manager policy transport is unavailable.";

// A stand-in `claude`, as in policy-hook-credential-reregistration: it records each launch's argv,
// environment and (for a file-form `--settings`) the settings file contents as read at launch.
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("2.1.205 (Claude Code)\n"); process.exit(0); }
if (args.includes("--help")) {
  process.stdout.write([
    "  --input-format <format>  text or stream-json",
    "  --output-format <format> text, json, stream-json",
    '  --permission-mode <mode> (choices: "acceptEdits", "auto", "default", "plan", "bypassPermissions")',
    "",
  ].join("\n"));
  process.exit(0);
}
if (args[0] === "auth") {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }) + "\n");
  process.exit(0);
}
const settings = [];
for (let i = 0; i < args.length - 1; i++) {
  if (args[i] !== "--settings") continue;
  const value = args[i + 1];
  let contents = value;
  if (!value.trim().startsWith("{")) {
    try { contents = readFileSync(value, "utf8"); } catch { contents = null; }
  }
  settings.push({ value, contents });
}
const record = join(process.env.HOOK_LAUNCH_DIR, String(process.hrtime.bigint()));
writeFileSync(record + ".part", JSON.stringify({ args, env: process.env, settings }));
renameSync(record + ".part", record + ".json");
const flag = Math.max(args.indexOf("--session-id"), args.indexOf("--resume"));
const sessionId = flag >= 0 ? args[flag + 1] : "fake-claude-session";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    if (JSON.parse(line)?.type !== "user") continue;
    setTimeout(() => {
      send({ type: "system", subtype: "init", session_id: sessionId, model: "claude-test" });
      if (line.includes("start-test-background")) {
        send({ type: "system", subtype: "task_started", task_id: "test-watcher" });
      }
      if (line.includes("complete-test-background")) {
        send({ type: "system", subtype: "task_notification", task_id: "test-watcher", status: "completed" });
      }
      send({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 });
    }, 0);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

function hermeticEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(RUNNER_|CONTROL_PLANE_|WOLLIPOG_|MAM_)/u.test(key)) delete env[key];
  }
  return env;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
  return address.port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  child.kill("SIGTERM");
  const timer = delay(5_000, "timeout");
  if (await Promise.race([exited.then(() => "exited"), timer]) === "exited") return;
  child.kill("SIGKILL");
  await exited;
}

function launches(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
}

interface LaunchRecord {
  args: string[];
  env: NodeJS.ProcessEnv;
  settings: { value: string; contents: string | null }[];
}

interface SettingsDocument {
  env?: Record<string, string>;
  hooks?: { PreToolUse?: { matcher?: string; hooks: { command: string; args: string[] }[] }[] };
}

function readLaunch(dir: string, launch: string): LaunchRecord {
  return JSON.parse(readFileSync(join(dir, launch), "utf8")) as LaunchRecord;
}

/** The settings document Claude would apply (the LAST `--settings`), or null when none was passed. */
function effectiveSettings(record: LaunchRecord): SettingsDocument | null {
  const last = record.settings.at(-1);
  if (!last?.contents) return null;
  return JSON.parse(last.contents) as SettingsDocument;
}

function permissionModeArg(record: LaunchRecord): string | null {
  const index = record.args.indexOf("--permission-mode");
  return index >= 0 ? record.args[index + 1]! : null;
}

function managerHook(settings: SettingsDocument | null) {
  return settings?.hooks?.PreToolUse?.find((entry) => entry.hooks[0]?.args.includes("--policy-hook"))?.hooks[0];
}

/** A compact, secret-free description of a launch for the failure diagnostics. */
function describeLaunch(record: LaunchRecord): string {
  const settings = effectiveSettings(record);
  const preToolUse = (settings?.hooks?.PreToolUse ?? []).map((entry) => ({
    matcher: entry.matcher,
    command: entry.hooks[0]?.command,
    args: entry.hooks[0]?.args,
  }));
  return JSON.stringify({
    argv: record.args.map((arg, index) => record.args[index - 1] === "--settings" && arg.startsWith("{") ? "<inline settings JSON>" : arg),
    permissionMode: permissionModeArg(record),
    settingsArgs: record.settings.map((entry) => entry.value.startsWith("{") ? "<inline>" : entry.value),
    preToolUseHooks: preToolUse,
    hasManagerPolicyHook: managerHook(settings) !== undefined,
  }, null, 2);
}

async function runHook(record: LaunchRecord): Promise<string> {
  const settings = effectiveSettings(record);
  const manager = managerHook(settings)!;
  const child = spawn(manager.command, manager.args, {
    cwd: REPO_ROOT,
    env: { ...record.env, ...settings?.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdin.end(JSON.stringify({
    session_id: "fake-claude-session",
    hook_event_name: "PreToolUse",
    permission_mode: "acceptEdits",
    tool_name: "Read",
    tool_use_id: `tool-${Date.now()}`,
    tool_input: { file_path: join(REPO_ROOT, "package.json") },
  }));
  const code = await new Promise<number | null>((resolvePromise) => child.once("exit", resolvePromise));
  assert.equal(code, 0, `policy hook exited ${code}: ${stderr}`);
  return stdout.trim();
}

function answeredByControlPlane(hookOutput: string): boolean {
  return hookOutput.includes('"permissionDecision":"deny"') && !hookOutput.includes(TRANSPORT_UNAVAILABLE);
}

interface Stack {
  launchDir: string;
  output: () => string;
  createSession: (permissionMode: string, prompt: string) => Promise<string>;
  prompt: (sessionId: string, text: string, permissionMode: string) => Promise<void>;
  waitForLaunch: (count: number) => Promise<string>;
  waitForIdle: (sessionId: string) => Promise<void>;
  restart: (sessionId: string) => Promise<void>;
  waitForRegistrationWait: () => Promise<void>;
  waitForLocalEvent: (sessionId: string, kind: "error" | "stderr", message: string, count?: number) => Promise<void>;
  holdNextRegistration: () => Promise<void>;
  releaseRegistration: () => void;
  hookTransports: (sessionId: string, mode: string) => Promise<string[] | undefined>;
}

/** A real control plane and runner (WOLLIPOG_CLAUDE_HOOKS=1) driving the fake `claude`, with a
 * governance policy that denies every Read. */
async function startStack(t: TestContext, label: string, options: {
  holdRegistration?: boolean;
  persistent?: boolean;
} = {}): Promise<Stack> {
  const port = await reservePort();
  const httpBase = `http://127.0.0.1:${port}`;
  const temp = mkdtempSync(join(tmpdir(), `wollipog-policy-hook-mode-switch-${label}-`));
  const databasePath = join(temp, "control-plane.db");
  const workspaceDir = join(temp, "workspace");
  const launchDir = join(temp, "launches");
  const runnerHome = join(temp, "home");
  const runnerBin = join(temp, "bin");
  const configPath = join(temp, "runner.config.json");
  const fakeClaude = join(runnerBin, "claude");
  for (const dir of [workspaceDir, launchDir, runnerHome, runnerBin]) mkdirSync(dir, { recursive: true });
  writeFileSync(fakeClaude, FAKE_CLAUDE, { mode: 0o755 });
  const ownerToken = loadOrCreateLocalDeviceToken(defaultLocalDeviceTokenPath(databasePath));
  const owner = { authorization: `Bearer ${ownerToken}` };

  let output = "";
  const capture = (child: ChildProcess) => {
    const append = (chunk: unknown) => { output = (output + String(chunk)).slice(-65_536); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    return child;
  };
  const controlPlane = capture(spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...hermeticEnv(),
      CONTROL_PLANE_HOST: "127.0.0.1",
      CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: databasePath,
      CONTROL_PLANE_TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  let runner: ChildProcess | null = null;
  let lastSessionId = "";
  t.after(async () => {
    if (runner) await stopChild(runner);
    await stopChild(controlPlane);
    rmSync(temp, { recursive: true, force: true });
  });

  for (let attempt = 0; ; attempt++) {
    assert.equal(controlPlane.exitCode, null, `control plane exited\n${output}`);
    try {
      if ((await fetch(`${httpBase}/healthz`)).ok) break;
    } catch { /* not listening yet */ }
    assert.ok(attempt < 400, `control plane never became healthy\n${output}`);
    await delay(50);
  }
  const issued = await fetch(`${httpBase}/api/runner-credentials`, {
    method: "POST",
    headers: { ...owner, "content-type": "application/json" },
    body: JSON.stringify({ runnerId: RUNNER_ID, label: "Policy hook mode switch" }),
  });
  assert.equal(issued.status, 201, output);
  const runnerToken = (await issued.json() as { token: string }).token;
  const policy = await fetch(`${httpBase}/api/governance/policies/deny-read`, {
    method: "PUT",
    headers: { ...owner, "content-type": "application/json" },
    body: JSON.stringify({ policyId: "deny-read", name: "Deny Read", effect: "deny", priority: 100, enabled: true, scope: { toolName: "Read" } }),
  });
  assert.equal(policy.ok, true, await policy.text());
  // Delay only the runner's registration acknowledgement. The real CP can still dispatch a
  // launch, reproducing the unknown-protocol window without a real network outage.
  let heldRegistration: (() => void) | undefined;
  let holdRegistration = false;
  const proxyHttp = createHttpServer((incoming, outgoing) => {
    const request = httpRequest(`${httpBase}${incoming.url}`, {
      method: incoming.method, headers: incoming.headers,
    }, (response) => {
      outgoing.writeHead(response.statusCode!, response.headers);
      response.pipe(outgoing);
    });
    request.on("error", () => { outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(request);
  });
  const proxy = new WebSocketServer({ server: proxyHttp });
  await new Promise<void>((resolvePromise) => proxyHttp.listen(0, "127.0.0.1", resolvePromise));
  t.after(async () => {
    for (const client of proxy.clients) client.terminate();
    await new Promise<void>((resolvePromise) => proxy.close(() => resolvePromise()));
    await new Promise<void>((resolvePromise) => proxyHttp.close(() => resolvePromise()));
  });
  proxy.on("connection", (client) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${port}/runner`);
    const pending: string[] = [];
    client.on("message", (data) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
      else pending.push(data.toString());
    });
    upstream.on("open", () => { for (const data of pending) upstream.send(data); });
    upstream.on("message", (data) => {
      const send = () => { if (client.readyState === WebSocket.OPEN) client.send(data.toString()); };
      if (holdRegistration && JSON.parse(data.toString()).type === "registered") heldRegistration = send;
      else send();
    });
    client.on("close", () => upstream.close());
    upstream.on("error", () => client.close());
    upstream.on("close", () => client.close());
  });
  const proxyAddress = proxyHttp.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  writeFileSync(configPath, JSON.stringify({
    runnerId: RUNNER_ID,
    controlPlaneUrl: `ws://127.0.0.1:${options.holdRegistration ? proxyAddress.port : port}/runner`,
    token: runnerToken,
    dataDir: join(temp, "runner-data"),
    workspaces: [{ id: "repo", name: "Repo", path: workspaceDir }],
    agents: [{
      id: "fake-claude",
      name: "Claude",
      command: fakeClaude,
      driver: "claude-code",
      context: { kind: "native" },
      env: { HOOK_LAUNCH_DIR: launchDir },
    }],
  }));
  runner = capture(spawn(process.execPath, ["--import", "tsx", "apps/runner/src/cli.ts", "--config", configPath], {
    cwd: REPO_ROOT,
    env: {
      ...hermeticEnv(),
      WOLLIPOG_CLAUDE_HOOKS: "1",
      WOLLIPOG_CLAUDE_PERSISTENT: options.persistent === false ? "0" : "1",
      PATH: [runnerBin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      HOME: runnerHome,
      XDG_CONFIG_HOME: join(runnerHome, ".config"),
      XDG_DATA_HOME: join(runnerHome, ".local", "share"),
      XDG_STATE_HOME: join(runnerHome, ".local", "state"),
      XDG_CACHE_HOME: join(runnerHome, ".cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  }));

  return {
    launchDir,
    output: () => output,
    async hookTransports(sessionId, mode) {
      const response = await fetch(`${httpBase}/api/sessions/${sessionId}`, { headers: owner });
      assert.equal(response.ok, true);
      const body = await response.json() as { session: { agentCapabilities?: { elicitation?: Record<string, string[]> } } };
      return body.session.agentCapabilities?.elicitation?.[mode];
    },
    async holdNextRegistration() {
      heldRegistration = undefined;
      holdRegistration = true;
      for (const client of proxy.clients) client.close();
      for (let attempt = 0; attempt < 300; attempt++) {
        if (heldRegistration) return;
        await delay(50);
      }
      assert.fail(`runner never reconnected\n${output}`);
    },
    async waitForRegistrationWait() {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (heldRegistration && output.includes("waiting for control-plane registration")) return;
        await delay(50);
      }
      assert.fail(`launch never waited for registration\n${output}`);
    },
    async waitForLocalEvent(sessionId, kind, message, count = 1) {
      const eventsPath = join(temp, "runner-data", "sessions", sessionId, "events.ndjson");
      for (let attempt = 0; attempt < 300; attempt++) {
        const events = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean)
          .map((line) => JSON.parse(line) as { payload?: { kind?: string; message?: string; text?: string } });
        if (events.filter((event) => event.payload?.kind === kind &&
          (event.payload.message ?? event.payload.text)?.includes(message)).length >= count) return;
        await delay(50);
      }
      assert.fail(`runner never recorded ${kind} ${message}\n${output}`);
    },
    releaseRegistration() {
      assert.ok(heldRegistration, "the real CP registered the runner");
      heldRegistration();
      holdRegistration = false;
    },
    async createSession(permissionMode, prompt) {
      for (let attempt = 0; attempt < 300; attempt++) {
        const created = await fetch(`${httpBase}/api/sessions`, {
          method: "POST",
          headers: { ...owner, "content-type": "application/json" },
          body: JSON.stringify({
            runnerId: RUNNER_ID,
            workspaceId: "repo",
            agentId: "fake-claude",
            useWorktree: false,
            config: { permissionMode },
            prompt,
          }),
        });
        if (created.status === 201) return (lastSessionId = (await created.json() as { id: string }).id);
        if (attempt === 299) t.diagnostic(`create response ${created.status}: ${await created.text()}`);
        await delay(100);
      }
      throw new Error(`session was never created\n${output}`);
    },
    async prompt(sessionId, text, permissionMode) {
      let prompted: Response | undefined;
      for (let attempt = 0; attempt < 300 && prompted?.status !== 200; attempt++) {
        if (attempt) await delay(100);
        prompted = await fetch(`${httpBase}/api/sessions/${sessionId}/prompt`, {
          method: "POST",
          headers: { ...owner, "content-type": "application/json" },
          body: JSON.stringify({ text, config: { permissionMode } }),
        });
      }
      assert.equal(prompted?.status, 200, `${await prompted?.text()}\n${output}`);
    },
    async waitForLaunch(count) {
      for (let attempt = 0; attempt < 300 && launches(launchDir).length < count; attempt++) await delay(100);
      if (launches(launchDir).length < count && lastSessionId) {
        const session = await (await fetch(`${httpBase}/api/sessions/${lastSessionId}`, { headers: owner })).text();
        const events = await (await fetch(`${httpBase}/api/sessions/${lastSessionId}/events`, { headers: owner })).text();
        output += `\nSESSION ${session.slice(0, 4000)}\nEVENTS ${events.slice(0, 8000)}\n`;
      }
      assert.equal(launches(launchDir).length, count, `provider launch ${count} never happened\n${output}`);
      return launches(launchDir).at(-1)!;
    },
    async restart(sessionId) {
      const restarted = await fetch(`${httpBase}/api/sessions/${sessionId}/restart`, { method: "POST", headers: owner });
      assert.equal(restarted.ok, true, `${await restarted.text()}\n${output}`);
    },
    async waitForIdle(sessionId) {
      for (let attempt = 0; attempt < 300; attempt++) {
        const response = await fetch(`${httpBase}/api/sessions/${sessionId}`, { headers: owner });
        if (response.ok) {
          const body = await response.json() as { status?: string; session?: { status?: string } };
          if ((body.status ?? body.session?.status) === "idle") return;
        }
        await delay(100);
      }
      throw new Error(`session ${sessionId} never became idle\n${output}`);
    },
  };
}

const linuxOnly = process.platform !== "linux" ? "the Linux hook relay is required" : false;

test("a same-mode turn refuses while disconnected and refreshes after registration", {
  timeout: 120_000, skip: linuxOnly,
}, async (t) => {
  const stack = await startStack(t, "registration-refresh", { holdRegistration: true, persistent: false });
  const sessionId = await stack.createSession("acceptEdits", "Note one");
  await stack.waitForLaunch(1);
  await stack.waitForIdle(sessionId);
  await stack.holdNextRegistration();
  await stack.prompt(sessionId, "Must wait", "acceptEdits");
  await stack.waitForLocalEvent(sessionId, "error", "waiting for control-plane registration");
  assert.equal(launches(stack.launchDir).length, 1, "disconnected turn must not spawn");
  const refreshes = stack.output().split(`Claude hooks ${sessionId}: settings refreshed`).length - 1;
  stack.releaseRegistration();
  await stack.waitForIdle(sessionId);
  await stack.prompt(sessionId, "Note two", "acceptEdits");
  const launch = readLaunch(stack.launchDir, await stack.waitForLaunch(2));
  assert.equal(permissionModeArg(launch), "acceptEdits");
  assert.ok(managerHook(effectiveSettings(launch)));
  assert.ok(stack.output().split(`Claude hooks ${sessionId}: settings refreshed`).length - 1 > refreshes,
    "unchanged mode must refresh for the new registration generation");
  let answer = "";
  for (let attempt = 0; attempt < 40 && !answeredByControlPlane(answer); attempt++) {
    if (attempt) await delay(250);
    answer = await runHook(launch);
  }
  assert.ok(answeredByControlPlane(answer), `re-registered hook answer: ${answer}`);
});

test("a deferred switch keeps the running child's manager hook until background work completes", {
  timeout: 120_000, skip: linuxOnly,
}, async (t) => {
  const stack = await startStack(t, "background-refresh");
  const sessionId = await stack.createSession("acceptEdits", "start-test-background");
  const first = readLaunch(stack.launchDir, await stack.waitForLaunch(1));
  await stack.waitForIdle(sessionId);
  await stack.prompt(sessionId, "Keep working", "auto");
  await stack.waitForLocalEvent(sessionId, "stderr", "configuration change deferred");
  await stack.waitForIdle(sessionId);
  assert.equal(launches(stack.launchDir).length, 1, "background owner must stay alive");
  const settingsPath = effectiveSettings(first)!.env!.WOLLIPOG_POLICY_HOOK_SETTINGS_FILE!;
  assert.ok(managerHook(JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsDocument),
    "deferred preparation must preserve the running child's settings");
  assert.ok((await stack.hookTransports(sessionId, "acceptEdits"))?.includes("hook"));
  assert.ok(answeredByControlPlane(await runHook(first)), "running hook must still enforce the manager's deny");
  await stack.prompt(sessionId, "complete-test-background", "auto");
  await stack.waitForLocalEvent(sessionId, "stderr", "configuration change deferred", 2);
  await stack.waitForIdle(sessionId);
  await stack.prompt(sessionId, "Apply new mode", "auto");
  const replacement = readLaunch(stack.launchDir, await stack.waitForLaunch(2));
  assert.equal(permissionModeArg(replacement), "auto");
  assert.equal(managerHook(effectiveSettings(replacement)), undefined);
});

test("a fixed-rule launch waits while the protocol is unknown and provisions after registration (Path B)", {
  timeout: 120_000,
  skip: linuxOnly,
}, async (t) => {
  const stack = await startStack(t, "registration", { holdRegistration: true });
  const sessionId = await stack.createSession("acceptEdits", "Note one");
  await stack.waitForLaunch(1);
  await stack.waitForIdle(sessionId);
  await stack.holdNextRegistration();
  await stack.restart(sessionId);
  await stack.waitForRegistrationWait();
  assert.equal(launches(stack.launchDir).length, 1, "no replacement may spawn before registration");
  assert.ok(!stack.output().includes("control plane does not acknowledge protocol"), "unknown is not too old");
  stack.releaseRegistration();
  await stack.prompt(sessionId, "Note two", "acceptEdits");
  const launch = readLaunch(stack.launchDir, await stack.waitForLaunch(2));
  assert.equal(permissionModeArg(launch), "acceptEdits");
  assert.ok(managerHook(effectiveSettings(launch)), "registration must resume hook provisioning");
  let answer = "";
  for (let attempt = 0; attempt < 40 && !answeredByControlPlane(answer); attempt++) {
    if (attempt) await delay(250);
    answer = await runHook(launch);
  }
  assert.ok(answeredByControlPlane(answer), `post-registration hook answer: ${answer}`);
});

for (const [from, to, persistent] of [
  ["default", "plan", true],
  ["auto", "bypassPermissions", true],
  ["auto", "acceptEdits", false],
] as const) {
  test(`live ${from} to ${to} provisions hooks (${persistent ? "persistent" : "one-shot"})`, {
    timeout: 120_000,
    skip: linuxOnly,
  }, async (t) => {
    const stack = await startStack(t, `${from}-${to}-${persistent}`, { persistent });
    const sessionId = await stack.createSession(from, "Note one");
    await stack.waitForLaunch(1);
    await stack.waitForIdle(sessionId);
    await stack.prompt(sessionId, "Note two", to);
    const launch = readLaunch(stack.launchDir, await stack.waitForLaunch(2));
    assert.equal(permissionModeArg(launch), to);
    assert.ok(managerHook(effectiveSettings(launch)), describeLaunch(launch));
    let answer = "";
    for (let attempt = 0; attempt < 40 && !answeredByControlPlane(answer); attempt++) {
      if (attempt) await delay(250);
      answer = await runHook(launch);
    }
    assert.ok(answeredByControlPlane(answer), `post-switch hook answer: ${answer}`);
  });
}

test("control: after the switch, a session restart relaunches Claude with the manager policy hook", {
  timeout: 180_000,
  skip: linuxOnly,
}, async (t) => {
  // Validates the harness (the fake, the relay, the deny-read policy) and the restart workaround:
  // the same session, once restarted in acceptEdits, is provisioned with the manager hook.
  const stack = await startStack(t, "control");
  const sessionId = await stack.createSession("auto", "Note one");
  await stack.waitForLaunch(1);
  await stack.waitForIdle(sessionId);
  await stack.prompt(sessionId, "Note two", "acceptEdits");
  await stack.waitForLaunch(2);
  await stack.waitForIdle(sessionId);
  await stack.restart(sessionId);
  await stack.prompt(sessionId, "Note three", "acceptEdits");
  const launch = readLaunch(stack.launchDir, await stack.waitForLaunch(3));
  t.diagnostic(`launch 3 (after a session restart in acceptEdits):\n${describeLaunch(launch)}`);
  assert.equal(permissionModeArg(launch), "acceptEdits");
  assert.ok(managerHook(effectiveSettings(launch)),
    `a restarted acceptEdits launch carries the manager PreToolUse --policy-hook\n${describeLaunch(launch)}`);
  let answer = "";
  for (let attempt = 0; attempt < 40 && !answeredByControlPlane(answer); attempt++) {
    if (attempt) await delay(250);
    answer = await runHook(launch);
  }
  assert.ok(answeredByControlPlane(answer), `control hook answer: ${answer}`);
});

test("a live switch from auto to acceptEdits respawns Claude with the manager policy hook", {
  timeout: 120_000,
  skip: linuxOnly,
}, async (t) => {
  const stack = await startStack(t, "switch");
  const sessionId = await stack.createSession("auto", "Note one");
  const first = readLaunch(stack.launchDir, await stack.waitForLaunch(1));
  await stack.waitForIdle(sessionId);
  t.diagnostic(`launch 1 (created in auto):\n${describeLaunch(first)}`);
  assert.equal(permissionModeArg(first), "auto");

  // No runner restart, no stop/resume: the human picks a fixed-rule mode for the next prompt.
  await stack.prompt(sessionId, "Note two", "acceptEdits");
  const second = readLaunch(stack.launchDir, await stack.waitForLaunch(2));
  t.diagnostic(`launch 2 (after the live switch to acceptEdits):\n${describeLaunch(second)}`);
  assert.equal(permissionModeArg(second), "acceptEdits", "the switch respawned the provider in acceptEdits");

  assert.ok(managerHook(effectiveSettings(second)),
    "the respawned acceptEdits provider must carry the manager PreToolUse --policy-hook, as a restarted " +
    `acceptEdits launch does\n${describeLaunch(second)}`);
  // If the hook is present, it must actually reach the deny-read governance policy.
  let answer = "";
  for (let attempt = 0; attempt < 40 && !answeredByControlPlane(answer); attempt++) {
    if (attempt) await delay(250);
    answer = await runHook(second);
  }
  assert.ok(answeredByControlPlane(answer), `post-switch hook answer: ${answer}`);
  assert.ok((await stack.hookTransports(sessionId, "acceptEdits"))?.includes("hook"),
    "the session must advertise the re-provisioned hook transport");
});
