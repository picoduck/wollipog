import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { defaultLocalDeviceTokenPath, loadOrCreateLocalDeviceToken } from "../../control-plane/src/local-device-credential.js";

// The manager policy hook's credential registration was sent the way the Agent Control one was
// before #1841: once per provider launch. A provider relaunched after a runner restart holds a
// freshly minted credential, and its hook fails closed until the control plane acknowledges it.
// This drives a real control plane and runner through the loss #1841 reproduced: the registration
// is written into a frozen control plane that is then replaced, and the relaunched provider's hook
// must reach the control plane again after the runner reconnects, without any restart.

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const RUNNER_ID = "policy-hook-reregistration-runner";
const CONTROL_PLANE_TOKEN = "policy-hook-reregistration-control-plane-token";
const TRANSPORT_UNAVAILABLE = "Manager policy transport is unavailable.";

// A stand-in `claude`: it records each launch's argv and environment (renamed into place so a
// reader never sees it half-written), then answers every prompt with an immediate success.
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("2.1.205 (Claude Code)\n"); process.exit(0); }
if (args.includes("--help")) {
  process.stdout.write([
    "  --input-format <format>  text or stream-json",
    "  --output-format <format> text, json, stream-json",
    '  --permission-mode <mode> (choices: "acceptEdits", "auto", "plan")',
    "",
  ].join("\n"));
  process.exit(0);
}
if (args[0] === "auth") {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }) + "\n");
  process.exit(0);
}
const record = join(process.env.HOOK_LAUNCH_DIR, String(process.hrtime.bigint()));
writeFileSync(record + ".part", JSON.stringify({ args, env: process.env }));
renameSync(record + ".part", record + ".json");
const flag = Math.max(args.indexOf("--session-id"), args.indexOf("--resume"));
const sessionId = flag >= 0 ? args[flag + 1] : "fake-claude-session";
// A first turn can be slow to report its conversation id; the test opens that window on purpose.
const initDelayMs = args.includes("--session-id") ? Number(process.env.HOOK_FIRST_INIT_DELAY_MS ?? 0) : 0;
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
      send({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 });
    }, initDelayMs);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

// The dev machine exports RUNNER_*/CONTROL_PLANE_* env that would point these processes at a real
// stack. Strip every such key so they are driven only by this test's explicit config.
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
  child.kill("SIGCONT");
  child.kill("SIGTERM");
  const timer = delay(5_000, "timeout");
  if (await Promise.race([exited.then(() => "exited"), timer]) === "exited") return;
  child.kill("SIGKILL");
  await exited;
}

function launches(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
}

interface HookInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** The manager PreToolUse hook exactly as the launch was handed it, with the launch's environment. */
function managerPreToolUseHook(dir: string, launch: string): HookInvocation {
  const recorded = JSON.parse(readFileSync(join(dir, launch), "utf8")) as { args: string[]; env: NodeJS.ProcessEnv };
  const index = recorded.args.lastIndexOf("--settings");
  assert.ok(index >= 0, "the provider launched with a settings document");
  const settings = JSON.parse(recorded.args[index + 1]!) as {
    env?: Record<string, string>;
    hooks?: { PreToolUse?: { hooks: { command: string; args: string[] }[] }[] };
  };
  const manager = settings.hooks?.PreToolUse?.find((entry) => entry.hooks[0]?.args.includes("--policy-hook"))?.hooks[0];
  assert.ok(manager, "the provider launched with the manager policy hook");
  return { command: manager.command, args: manager.args, env: { ...recorded.env, ...settings.env } };
}

async function runHook(hook: HookInvocation): Promise<string> {
  const child = spawn(hook.command, hook.args, { cwd: REPO_ROOT, env: hook.env, stdio: ["pipe", "pipe", "pipe"] });
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

/** The control plane's policy answered: neither the fail-closed refusal nor an open circuit's pass. */
function answeredByControlPlane(hookOutput: string): boolean {
  return hookOutput.includes('"permissionDecision":"deny"') && !hookOutput.includes(TRANSPORT_UNAVAILABLE);
}

test("a relaunch whose policy-hook credential registration is lost recovers after the runner reconnects", {
  timeout: 240_000,
  // SIGSTOP freezes the control plane between the runner's send and its read; the relayed hook
  // transport this exercises is Linux-only.
  skip: process.platform !== "linux" ? "the Linux hook relay and POSIX job-control signals are required" : false,
}, async (t) => {
  const port = await reservePort();
  const httpBase = `http://127.0.0.1:${port}`;
  const temp = mkdtempSync(join(tmpdir(), "wollipog-policy-hook-reregistration-"));
  const databasePath = join(temp, "control-plane.db");
  const workspaceDir = join(temp, "workspace");
  const launchDir = join(temp, "launches");
  const runnerHome = join(temp, "home");
  const runnerBin = join(temp, "bin");
  const configPath = join(temp, "runner.config.json");
  // Named `claude` and first on PATH, so discovery verifies it as the configured launch target.
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
  const spawnControlPlane = () => capture(spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
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
  const spawnRunner = () => capture(spawn(process.execPath, ["--import", "tsx", "apps/runner/src/cli.ts", "--config", configPath], {
    cwd: REPO_ROOT,
    // An isolated HOME keeps the runner's provider-home lease and hook state off any real runner.
    env: {
      ...hermeticEnv(),
      WOLLIPOG_CLAUDE_HOOKS: "1",
      // Only the fake, node, and system tools: discovery must not find or probe a real harness.
      PATH: [runnerBin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      HOME: runnerHome,
      XDG_CONFIG_HOME: join(runnerHome, ".config"),
      XDG_DATA_HOME: join(runnerHome, ".local", "share"),
      XDG_STATE_HOME: join(runnerHome, ".local", "state"),
      XDG_CACHE_HOME: join(runnerHome, ".cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  }));

  let controlPlane = spawnControlPlane();
  let runner: ChildProcess | null = null;
  t.after(async () => {
    if (runner) await stopChild(runner);
    await stopChild(controlPlane);
    rmSync(temp, { recursive: true, force: true });
  });

  const waitForHealth = async () => {
    for (let attempt = 0; attempt < 400; attempt++) {
      assert.equal(controlPlane.exitCode, null, `control plane exited\n${output}`);
      try {
        if ((await fetch(`${httpBase}/healthz`)).ok) return;
      } catch { /* not listening yet */ }
      await delay(50);
    }
    throw new Error(`control plane never became healthy\n${output}`);
  };
  const waitForRunner = async (status: "online" | "offline") => {
    for (let attempt = 0; attempt < 600; attempt++) {
      try {
        const response = await fetch(`${httpBase}/api/runners`, { headers: owner });
        const runners = (await response.json() as { runners: { runnerId: string; status: string }[] }).runners;
        if (runners.find((candidate) => candidate.runnerId === RUNNER_ID)?.status === status) return;
      } catch { /* control plane restarting */ }
      await delay(100);
    }
    throw new Error(`runner never became ${status}\n${output}`);
  };
  const waitForLaunch = async (count: number) => {
    for (let attempt = 0; attempt < 300 && launches(launchDir).length < count; attempt++) await delay(100);
    assert.equal(launches(launchDir).length, count, `provider launch ${count} never happened\n${output}`);
    return launches(launchDir).at(-1)!;
  };
  let sessionId = "";
  const storedCredentialHash = () => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = db.prepare("SELECT token_hash FROM policy_hook_credentials WHERE session_id=?").get(sessionId) as
        { token_hash: string } | undefined;
      return row?.token_hash;
    } finally {
      db.close();
    }
  };

  await waitForHealth();
  const issued = await fetch(`${httpBase}/api/runner-credentials`, {
    method: "POST",
    headers: { ...owner, "content-type": "application/json" },
    body: JSON.stringify({ runnerId: RUNNER_ID, label: "Policy hook re-registration" }),
  });
  assert.equal(issued.status, 201, output);
  const runnerToken = (await issued.json() as { token: string }).token;
  // A policy only the control plane knows: its answer is a deny, distinct both from the hook's
  // fail-closed transport refusal and from the pass-through of an open circuit.
  const policy = await fetch(`${httpBase}/api/governance/policies/deny-read`, {
    method: "PUT",
    headers: { ...owner, "content-type": "application/json" },
    body: JSON.stringify({ policyId: "deny-read", name: "Deny Read", effect: "deny", priority: 100, enabled: true, scope: { toolName: "Read" } }),
  });
  assert.equal(policy.ok, true, await policy.text());
  writeFileSync(configPath, JSON.stringify({
    runnerId: RUNNER_ID,
    controlPlaneUrl: `ws://127.0.0.1:${port}/runner`,
    token: runnerToken,
    dataDir: join(temp, "runner-data"),
    workspaces: [{ id: "repo", name: "Repo", path: workspaceDir }],
    agents: [{
      id: "fake-claude",
      name: "Claude",
      command: fakeClaude,
      driver: "claude-code",
      context: { kind: "native" },
      env: {
        HOOK_LAUNCH_DIR: launchDir,
        // Open the window a loaded CI runner can open by chance (#2001): the first launch starts,
        // but its conversation id is not persisted until well after its launch record is visible,
        // so a restart that does not wait for the id would lose the relaunch.
        HOOK_FIRST_INIT_DELAY_MS: "1500",
      },
    }],
  }));
  runner = spawnRunner();

  // Created in `auto`, which keeps its stdio approval channel. The manager hook is provisioned by the
  // relaunches below, which switch the session to the fixed-rule `acceptEdits` mode.
  for (let attempt = 0; attempt < 300 && !sessionId; attempt++) {
    const created = await fetch(`${httpBase}/api/sessions`, {
      method: "POST",
      headers: { ...owner, "content-type": "application/json" },
      body: JSON.stringify({
        runnerId: RUNNER_ID,
        workspaceId: "repo",
        agentId: "fake-claude",
        useWorktree: false,
        config: { permissionMode: "auto" },
        prompt: "Note one",
      }),
    });
    if (created.status === 201) sessionId = (await created.json() as { id: string }).id;
    else await delay(100);
  }
  assert.ok(sessionId, `session was never created\n${output}`);
  await waitForLaunch(1);
  // Every relaunch below resumes the conversation the first launch established. A restarted runner
  // refuses to continue a Claude history that has events but no persisted provider conversation id,
  // rather than risk a replacement conversation, so restart it only once that id is durable in its
  // session store (#2001). Later restarts keep the id the first launch persisted.
  const firstLaunchMeta = join(temp, "runner-data", "sessions", sessionId, "meta.json");
  const providerSessionPersisted = () => {
    try {
      return (JSON.parse(readFileSync(firstLaunchMeta, "utf8")) as { agentSessionId?: string | null }).agentSessionId != null;
    } catch {
      return false;
    }
  };
  for (let attempt = 0; attempt < 300 && !providerSessionPersisted(); attempt++) await delay(100);
  assert.ok(providerSessionPersisted(), `the first launch never persisted its provider conversation id\n${output}`);

  // A runner restart forgets the in-memory credential; the next prompt relaunches the provider with
  // a freshly minted one whose registration the control plane must acknowledge.
  const relaunchAfterRunnerRestart = async (text: string) => {
    await stopChild(runner!);
    await waitForRunner("offline");
    runner = spawnRunner();
    await waitForRunner("online");
    // The mode is validated against discovered capabilities, which a fresh runner reports only once
    // its discovery completes.
    let prompted: Response | undefined;
    for (let attempt = 0; attempt < 300 && prompted?.status !== 200; attempt++) {
      if (attempt) await delay(100);
      prompted = await fetch(`${httpBase}/api/sessions/${sessionId}/prompt`, {
        method: "POST",
        headers: { ...owner, "content-type": "application/json" },
        body: JSON.stringify({ text, config: { permissionMode: "acceptEdits" } }),
      });
    }
    assert.equal(prompted?.status, 200, `${await prompted?.text()}\n${output}`);
  };

  await relaunchAfterRunnerRestart("Note two");
  const healthyLaunch = await waitForLaunch(2);
  for (let attempt = 0; attempt < 100 && !storedCredentialHash(); attempt++) await delay(100);
  const healthyHash = storedCredentialHash();
  assert.ok(healthyHash, `the relaunch registered its credential\n${output}`);
  // Healthy baseline: the hook reaches the control plane and returns its policy's answer.
  const baseline = await runHook(managerPreToolUseHook(launchDir, healthyLaunch));
  assert.ok(answeredByControlPlane(baseline), `baseline hook: ${baseline}\n${output}`);

  // Freeze the control plane before the relaunch registers: the frame lands in a socket no one
  // will ever read, and the replacement control plane never sees it. The prompt's response is no
  // barrier before that registration, so on a fast machine the frame can still be read first; such
  // a cycle proves nothing, and another one runs.
  let lastStoredHash: string | undefined = healthyHash;
  let relaunch = "";
  for (let cycle = 0; cycle < 3 && !relaunch; cycle++) {
    await relaunchAfterRunnerRestart(`Note three, cycle ${cycle + 1}`);
    controlPlane.kill("SIGSTOP");
    const launched = await waitForLaunch(3 + cycle);
    await delay(1_000);
    const exited = new Promise((resolvePromise) => controlPlane.once("exit", resolvePromise));
    controlPlane.kill("SIGKILL");
    await exited;
    const stored = storedCredentialHash();
    controlPlane = spawnControlPlane();
    await waitForHealth();
    await waitForRunner("online");
    if (stored === lastStoredHash) relaunch = launched;
    else lastStoredHash = stored;
  }
  assert.ok(relaunch, "no relaunch's registration was lost to the frozen control plane in three cycles");

  // A re-send lands within a few seconds of the reconnect. Until it does, each call waits out the
  // hook's 500 ms acknowledgement fence and fails closed, and three such failures open the circuit,
  // whose pass-through is no control-plane answer either. Its 30-second cooldown bounds the wait.
  const hook = managerPreToolUseHook(launchDir, relaunch);
  const results: string[] = [];
  let recovered = "";
  for (let attempt = 0; attempt < 90 && !answeredByControlPlane(recovered); attempt++) {
    if (attempt) await delay(500);
    recovered = await runHook(hook);
    results.push(recovered);
  }
  assert.ok(answeredByControlPlane(recovered),
    `the relaunched provider's hook never reached the control plane:\n${[...new Set(results)].join("\n")}\n${output}`);
  const recoveredHash = storedCredentialHash();
  assert.ok(recoveredHash && recoveredHash !== lastStoredHash,
    "the runner re-sent the relaunch's credential to the replacement control plane");
});
