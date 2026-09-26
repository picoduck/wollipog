import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { defaultLocalDeviceTokenPath, loadOrCreateLocalDeviceToken } from "../../control-plane/src/local-device-credential.js";
import {
  AGENT_CONTROL_RELAY_ENDPOINT_ENV,
  AGENT_CONTROL_RELAY_KEY_ENV,
  agentControlRelayFetch,
} from "./agent-control-relay.js";

// #1841: a provider relaunched after a runner restart registers a fresh in-memory Agent Control
// credential, and its relay holds every request until the control plane acknowledges it. When that
// one registration frame was lost, nothing sent it again, so every Agent Control call from the
// provider failed after the 10-second acknowledgement wait for the rest of its life. This drives a
// real control plane and runner through exactly that loss: the registration is written into a
// frozen control plane that is then replaced, and the relaunched provider must recover after the
// runner reconnects, without any session, provider, or runner restart.

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const MOCK_AGENT = fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url));
const RUNNER_ID = "relay-reregistration-runner";
const CONTROL_PLANE_TOKEN = "relay-reregistration-control-plane-token";
// Each provider launch records its runner-injected Agent Control environment, then becomes the
// ordinary mock ACP agent. Only the relay coordinates are read back; they carry no bearer. The
// record is renamed into place so a reader never sees it half-written.
const RECORDING_AGENT = String.raw`record="$RELAY_LAUNCH_DIR/$(date +%s%N)"; env | grep '^WOLLIPOG_AGENT_CONTROL_RELAY_' > "$record.part" && mv "$record.part" "$record.env"; exec "$RELAY_NODE" "$RELAY_MOCK_AGENT"`;

// The dev machine exports RUNNER_*/CONTROL_PLANE_* env that would point these processes at a real
// stack. Strip every such key so they are driven only by this test's explicit config.
function hermeticEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(RUNNER_|CONTROL_PLANE_|WOLLIPOG_)/u.test(key)) delete env[key];
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
  return readdirSync(dir).filter((name) => name.endsWith(".env")).sort();
}

function relayCoordinates(dir: string, launch: string): { endpoint: string; key: string } {
  const env = Object.fromEntries(readFileSync(join(dir, launch), "utf8").split("\n").filter(Boolean)
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  const endpoint = env[AGENT_CONTROL_RELAY_ENDPOINT_ENV];
  const key = env[AGENT_CONTROL_RELAY_KEY_ENV];
  assert.ok(endpoint && key, "the provider launched with runner relay coordinates");
  return { endpoint, key };
}

test("a relaunch whose credential registration is lost recovers after the runner reconnects (#1841)", {
  timeout: 180_000,
  // SIGSTOP freezes the control plane between the runner's send and its read.
  skip: process.platform === "win32" ? "POSIX job-control signals are required" : false,
}, async (t) => {
  const port = await reservePort();
  const httpBase = `http://127.0.0.1:${port}`;
  const temp = mkdtempSync(join(tmpdir(), "wollipog-relay-reregistration-"));
  const databasePath = join(temp, "control-plane.db");
  const workspaceDir = join(temp, "workspace");
  const launchDir = join(temp, "launches");
  const runnerHome = join(temp, "home");
  const configPath = join(temp, "runner.config.json");
  for (const dir of [workspaceDir, launchDir, runnerHome]) mkdirSync(dir, { recursive: true });
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
    // An isolated HOME keeps the runner's provider-home lease off any real runner on this machine.
    env: {
      ...hermeticEnv(),
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
      const row = db.prepare("SELECT token_hash FROM agent_control_credentials WHERE session_id=?").get(sessionId) as
        { token_hash: string } | undefined;
      return row?.token_hash;
    } finally {
      db.close();
    }
  };
  const relayRequest = async (coordinates: { endpoint: string; key: string }) => {
    const started = Date.now();
    const response = await agentControlRelayFetch(coordinates.endpoint, coordinates.key)(`${httpBase}/api/compatibility`, {
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: await response.text(), ms: Date.now() - started };
  };

  await waitForHealth();
  const issued = await fetch(`${httpBase}/api/runner-credentials`, {
    method: "POST",
    headers: { ...owner, "content-type": "application/json" },
    body: JSON.stringify({ runnerId: RUNNER_ID, label: "Relay re-registration" }),
  });
  assert.equal(issued.status, 201, output);
  const runnerToken = (await issued.json() as { token: string }).token;
  writeFileSync(configPath, JSON.stringify({
    runnerId: RUNNER_ID,
    controlPlaneUrl: `ws://127.0.0.1:${port}/runner`,
    token: runnerToken,
    dataDir: join(temp, "runner-data"),
    // The default execution isolation is `provider`: the credential stays in runner memory and the
    // provider reaches Agent Control only through the runner relay.
    workspaces: [{ id: "repo", name: "Repo", path: workspaceDir }],
    agents: [{
      id: "mock",
      name: "Mock",
      command: "/bin/sh",
      args: ["-c", RECORDING_AGENT],
      driver: "acp",
      context: { kind: "native" },
      env: {
        WOLLIPOG_MOCK_SESSION_LIFECYCLE: "resume",
        RELAY_LAUNCH_DIR: launchDir,
        RELAY_NODE: process.execPath,
        RELAY_MOCK_AGENT: MOCK_AGENT,
      },
    }],
  }));
  runner = spawnRunner();

  for (let attempt = 0; attempt < 300 && !sessionId; attempt++) {
    const created = await fetch(`${httpBase}/api/sessions`, {
      method: "POST",
      headers: { ...owner, "content-type": "application/json" },
      body: JSON.stringify({ runnerId: RUNNER_ID, workspaceId: "repo", agentId: "mock", useWorktree: false, prompt: "Note one" }),
    });
    if (created.status === 201) sessionId = (await created.json() as { id: string }).id;
    else await delay(100);
  }
  assert.ok(sessionId, `session was never created\n${output}`);
  const firstLaunch = await waitForLaunch(1);
  for (let attempt = 0; attempt < 100 && !storedCredentialHash(); attempt++) await delay(100);
  const firstHash = storedCredentialHash();
  assert.ok(firstHash, "the first launch registered its credential");
  // Healthy baseline: the relay forwards at once and returns the control plane's own answer.
  const baseline = await relayRequest(relayCoordinates(launchDir, firstLaunch));
  assert.notEqual(baseline.status, 503, baseline.body);
  assert.ok(baseline.ms < 5_000, `baseline relay round-trip took ${baseline.ms}ms`);

  // A runner restart loses the in-memory credential; the next prompt relaunches the provider with a
  // freshly minted one whose registration the control plane must acknowledge.
  await stopChild(runner);
  await waitForRunner("offline");
  runner = spawnRunner();
  await waitForRunner("online");
  const prompted = await fetch(`${httpBase}/api/sessions/${sessionId}/prompt`, {
    method: "POST",
    headers: { ...owner, "content-type": "application/json" },
    body: JSON.stringify({ text: "Note two" }),
  });
  assert.equal(prompted.status, 200, output);
  // Freeze the control plane before the relaunch registers: the frame lands in a socket no one
  // will ever read, and the replacement control plane never sees it.
  controlPlane.kill("SIGSTOP");
  const relaunch = await waitForLaunch(2);
  await delay(1_000);
  const exited = new Promise((resolvePromise) => controlPlane.once("exit", resolvePromise));
  controlPlane.kill("SIGKILL");
  await exited;
  assert.equal(storedCredentialHash(), firstHash, "the relaunch's registration never reached the control plane");

  controlPlane = spawnControlPlane();
  await waitForHealth();
  await waitForRunner("online");

  const recovered = await relayRequest(relayCoordinates(launchDir, relaunch));
  assert.notEqual(recovered.status, 503,
    `the relaunched provider's relay still waits on an unacknowledged credential: ${recovered.body}\n${output}`);
  assert.ok(recovered.ms < 5_000, `the relaunched provider's relay took ${recovered.ms}ms`);
  const recoveredHash = storedCredentialHash();
  assert.ok(recoveredHash && recoveredHash !== firstHash,
    "the runner re-sent the relaunch's credential to the replacement control plane");
});
