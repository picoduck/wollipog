import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { defaultLocalDeviceTokenPath, loadOrCreateLocalDeviceToken } from "../../control-plane/src/local-device-credential.js";

// Real control plane + real runner daemon + real mock-agent, end to end. This is the first test to
// exercise the runner's transport/reconnect module (apps/runner/src/index.ts) against a live control
// plane: a session created over the HTTP API drives a full mock-agent turn whose events must arrive
// on a real /ui subscription, and the session must survive a runner daemon restart (the historical
// "runner offline"/state-wipe locus).

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const MOCK_AGENT = fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url));
const RUNNER_ID = "e2e-pipeline-runner";
const CONTROL_PLANE_TOKEN = "e2e-pipeline-control-plane-token";

// This dev machine exports dev-stack RUNNER_*/CONTROL_PLANE_* env that parseEnv would let override
// the runner's config file (and would point it at the real dev control plane). Strip every such key
// so the spawned processes are driven only by this test's explicit config/flags.
function hermeticEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(RUNNER_|CONTROL_PLANE_)/u.test(key)) delete env[key];
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

// Race an exit against a timeout, cancelling the losing timer. A bare delay(ms) in the race would
// stay pending after a fast exit and keep the test worker alive for the full timeout (~5s/run).
async function exitedWithin(exited: Promise<void>, ms: number): Promise<boolean> {
  const controller = new AbortController();
  const timedOut = delay(ms, false, { signal: controller.signal }).catch(() => false);
  try {
    return await Promise.race([exited.then(() => true), timedOut]);
  } finally {
    controller.abort();
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  if (await exitedWithin(exited, 5_000)) return;
  child.kill("SIGKILL");
  await exitedWithin(exited, 3_000);
}

// A minimal /ui inbox: buffer every JSON frame and let callers await the first one matching a
// predicate. take() consumes its match so a second take of the same predicate waits for a NEW frame.
type JsonObject = Record<string, unknown>;
class JsonInbox {
  private readonly queued: JsonObject[] = [];
  private readonly waiters = new Set<{ predicate: (m: JsonObject) => boolean; resolve: (m: JsonObject) => void }>();
  constructor(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const object = message as JsonObject;
      for (const waiter of this.waiters) {
        if (!waiter.predicate(object)) continue;
        this.waiters.delete(waiter);
        waiter.resolve(object);
        return;
      }
      this.queued.push(object);
    });
  }
  take(predicate: (m: JsonObject) => boolean, timeoutMs = 30_000): Promise<JsonObject> {
    const existing = this.queued.findIndex(predicate);
    if (existing !== -1) return Promise.resolve(this.queued.splice(existing, 1)[0]!);
    return new Promise((resolvePromise, reject) => {
      const waiter = {
        predicate,
        resolve: (message: JsonObject) => {
          clearTimeout(timer);
          resolvePromise(message);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("timed out waiting for a /ui frame"));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }
}

function eventPayload(message: JsonObject): { sessionId?: string; payload?: { kind?: string; text?: string } } {
  return (message.event as { sessionId?: string; payload?: { kind?: string; text?: string } } | undefined) ?? {};
}

function isTerminalTurnMessage(message: JsonObject, sessionId: string): boolean {
  if (message.type !== "session_event") return false;
  const event = eventPayload(message);
  return (
    event.sessionId === sessionId &&
    event.payload?.kind === "agent_message" &&
    typeof event.payload.text === "string" &&
    event.payload.text.includes("MOCK_NOTES.md")
  );
}

async function openUiSocket(wsBase: string, token: string): Promise<{ socket: WebSocket; inbox: JsonInbox }> {
  const socket = new WebSocket(`${wsBase}/ui?token=${encodeURIComponent(token)}`);
  const inbox = new JsonInbox(socket);
  await new Promise<void>((resolvePromise, reject) => {
    socket.addEventListener("open", () => resolvePromise(), { once: true });
    socket.addEventListener("error", () => reject(new Error("the /ui socket failed to open")), { once: true });
  });
  return { socket, inbox };
}

async function waitForHealth(baseUrl: string, child: ChildProcess, logs: () => string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (child.exitCode !== null) throw new Error(`control plane exited early (${child.exitCode})\n${logs()}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      /* listen has not completed */
    }
    await delay(50);
  }
  throw new Error(`control plane did not become healthy\n${logs()}`);
}

test(
  "a session created over the control plane drives a mock-agent turn to /ui and survives a runner restart",
  { timeout: 120_000 },
  async (t) => {
    const port = await reservePort();
    const httpBase = `http://127.0.0.1:${port}`;
    const wsBase = `ws://127.0.0.1:${port}`;
    const temp = mkdtempSync(join(tmpdir(), "wollipog-e2e-pipeline-"));
    const databasePath = join(temp, "control-plane.db");
    const workspaceDir = join(temp, "workspace");
    const runnerDataDir = join(temp, "runner-data");
    const runnerHome = join(temp, "home");
    const configPath = join(temp, "runner.config.json");
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(runnerHome, { recursive: true });

    // The control plane loads-or-creates its local device (owner) token beside the DB. Materialize it
    // first so the test can authenticate owner HTTP calls and the /ui route with a known secret.
    const ownerToken = loadOrCreateLocalDeviceToken(defaultLocalDeviceTokenPath(databasePath));

    let cpOutput = "";
    const controlPlane = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...hermeticEnv(),
        CONTROL_PLANE_HOST: "127.0.0.1",
        CONTROL_PLANE_PORT: String(port),
        CONTROL_PLANE_DB: databasePath,
        CONTROL_PLANE_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const captureCp = (chunk: unknown) => {
      cpOutput = (cpOutput + String(chunk)).slice(-65_536);
    };
    controlPlane.stdout?.on("data", captureCp);
    controlPlane.stderr?.on("data", captureCp);

    let runner: ChildProcess | null = null;
    let runnerOutput = "";
    const captureRunner = (chunk: unknown) => {
      runnerOutput = (runnerOutput + String(chunk)).slice(-65_536);
    };
    const uiSockets = new Set<WebSocket>();

    const spawnRunner = (): ChildProcess => {
      const child = spawn(process.execPath, ["--import", "tsx", "apps/runner/src/cli.ts", "--config", configPath], {
        cwd: REPO_ROOT,
        // Isolate HOME so the runner's native provider-home lease targets this temp dir instead of the
        // shared user home — otherwise it collides with any real runner (e.g. a dev stack) on this box.
        env: {
          ...hermeticEnv(),
          HOME: runnerHome,
          USERPROFILE: runnerHome,
          XDG_CONFIG_HOME: join(runnerHome, ".config"),
          XDG_DATA_HOME: join(runnerHome, ".local", "share"),
          XDG_STATE_HOME: join(runnerHome, ".local", "state"),
          XDG_CACHE_HOME: join(runnerHome, ".cache"),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout?.on("data", captureRunner);
      child.stderr?.on("data", captureRunner);
      return child;
    };

    t.after(async () => {
      for (const socket of uiSockets) {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
      }
      if (runner) await stopChild(runner);
      await stopChild(controlPlane);
      rmSync(temp, { recursive: true, force: true });
    });

    await waitForHealth(httpBase, controlPlane, () => cpOutput);

    // Issue a runner credential the way an operator would: an owner POST for a brand-new runner id.
    const credentialResponse = await fetch(`${httpBase}/api/runner-credentials`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ runnerId: RUNNER_ID, label: "E2E pipeline" }),
    });
    assert.equal(credentialResponse.status, 201, `credential issue failed\n${cpOutput}`);
    const runnerToken = (await credentialResponse.json() as { token: string }).token;
    assert.match(runnerToken, /^wollipogr_[A-Za-z0-9_-]{43}$/u);

    // Point the runner daemon at the real control plane with the mock ACP agent as its only agent.
    writeFileSync(
      configPath,
      JSON.stringify({
        runnerId: RUNNER_ID,
        controlPlaneUrl: `${wsBase}/runner`,
        token: runnerToken,
        dataDir: runnerDataDir,
        workspaces: [{ id: "repo", name: "Repo", path: workspaceDir }],
        agents: [
          {
            id: "mock",
            name: "Mock",
            command: process.execPath,
            args: [MOCK_AGENT],
            driver: "acp",
            context: { kind: "native" },
            // Advertise ACP session resume so the persisted session can be continued (rather than
            // going read-only) after the runner daemon restarts and re-attaches to it.
            env: { WOLLIPOG_MOCK_SESSION_LIFECYCLE: "resume" },
          },
        ],
      }),
    );

    runner = spawnRunner();

    // Subscribe a real /ui client before we create the session, then target the session so live
    // events are delivered (the /ui route drops events for sessions a client has not subscribed to).
    const { socket: ui, inbox: uiInbox } = await openUiSocket(wsBase, ownerToken);
    uiSockets.add(ui);
    await uiInbox.take((m) => m.type === "snapshot");

    // Poll session creation until the runner has registered and is advertising its mock agent.
    let sessionId = "";
    for (let attempt = 0; attempt < 300; attempt++) {
      assert.equal(runner.exitCode, null, `runner exited before registering\n${runnerOutput}`);
      const created = await fetch(`${httpBase}/api/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ runnerId: RUNNER_ID, workspaceId: "repo", agentId: "mock", useWorktree: false, prompt: "Please jot a quick note about the pipeline" }),
      });
      if (created.status === 201) {
        sessionId = (await created.json() as { id: string }).id;
        break;
      }
      await delay(100);
    }
    assert.ok(sessionId, `session was never created (runner never registered)\n${runnerOutput}`);

    ui.send(JSON.stringify({ type: "session_subscriptions", revision: 1, sessionIds: [sessionId], podIds: [] }));
    await uiInbox.take(
      (m) => m.type === "session_subscriptions_applied" && (m.revision as number) === 1,
    );

    const sessionStatus = async (): Promise<string> => {
      const response = await fetch(`${httpBase}/api/sessions/${sessionId}`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(response.status, 200);
      return ((await response.json()) as { session: { status: string } }).session.status;
    };

    const waitForIdle = async (): Promise<void> => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if ((await sessionStatus()) === "idle") return;
        await delay(100);
      }
      throw new Error(`session never returned to idle\n${runnerOutput}`);
    };

    // Turn 1: the session was created with an initial prompt, so the runner drives a full mock-agent
    // turn. Its terminal agent message ("… wrote MOCK_NOTES.md …") must arrive on the /ui subscription.
    const firstTurn = await uiInbox
      .take((m) => isTerminalTurnMessage(m, sessionId))
      .catch((error) => {
        throw new Error(`${(error as Error).message}\n=== RUNNER OUTPUT ===\n${runnerOutput}`);
      });
    assert.match(
      eventPayload(firstTurn).payload?.text ?? "",
      /MOCK_NOTES\.md/,
      "the first turn's terminal agent message reached /ui",
    );
    await waitForIdle();

    // Restart the runner daemon. The session (persisted in the runner's store and the control plane
    // DB) must survive the restart: after the daemon reconnects and resumes it, a fresh prompt must
    // drive another full turn whose terminal message again reaches the /ui subscription.
    await stopChild(runner);

    // Wait until the control plane has fully processed the old socket's close (onGone -> offline)
    // BEFORE spawning the replacement. Otherwise the resume prompt below could be routed to the
    // still-mapped dead socket (hub.sendToRunner buffers into a closed socket and returns 200), be
    // lost, and time out the second turn. With no replacement running yet, the runner cannot flip
    // back online in the meantime, so this poll is race-free.
    let sawOffline = false;
    for (let attempt = 0; attempt < 300 && !sawOffline; attempt++) {
      const response = await fetch(`${httpBase}/api/runners`, { headers: { authorization: `Bearer ${ownerToken}` } });
      assert.equal(response.status, 200);
      const runners = (await response.json() as { runners: { runnerId: string; status: string }[] }).runners;
      sawOffline = runners.find((r) => r.runnerId === RUNNER_ID)?.status === "offline";
      if (!sawOffline) await delay(100);
    }
    assert.ok(sawOffline, `control plane never observed the old runner go offline after restart\n${runnerOutput}`);

    runner = spawnRunner();

    // The prompt can only be routed once the restarted daemon has re-registered; poll until accepted.
    let resumedPromptSent = false;
    for (let attempt = 0; attempt < 300 && !resumedPromptSent; attempt++) {
      assert.equal(runner.exitCode, null, `restarted runner exited before reconnecting\n${runnerOutput}`);
      const response = await fetch(`${httpBase}/api/sessions/${sessionId}/prompt`, {
        method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "Note again after the runner restart" }),
      });
      if (response.status === 200) resumedPromptSent = true;
      else await delay(100);
    }
    assert.ok(resumedPromptSent, `restarted runner never accepted a prompt\n${runnerOutput}`);

    const secondTurn = await uiInbox
      .take((m) => isTerminalTurnMessage(m, sessionId))
      .catch((error) => {
        throw new Error(`${(error as Error).message}\n=== RUNNER OUTPUT ===\n${runnerOutput}`);
      });
    assert.match(
      eventPayload(secondTurn).payload?.text ?? "",
      /MOCK_NOTES\.md/,
      "a full turn completes and reaches /ui after the runner restarts",
    );
    await waitForIdle();
  },
);
