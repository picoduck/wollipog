import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, type RunnerView, type SessionView } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const RUNNER_ID = "runner-liveness";
const WORKSPACE_ID = "workspace-liveness";
const SESSION_ID = "session-liveness";
const DEVICE_TOKEN = "liveness-device-token";
const RUNNER_TOKEN = `wollipogr_${"b".repeat(43)}`;

// Use the exact `ws` implementation @fastify/websocket depends on so close codes match the server's.
const testRequire = createRequire(import.meta.url);
const websocketPluginRequire = createRequire(testRequire.resolve("@fastify/websocket"));
const StrictWebSocket = websocketPluginRequire("ws").WebSocket as new (url: string) => StrictSocket;

interface StrictSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "message", listener: (data: Buffer) => void): void;
  once(event: "open", listener: () => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number, reason: Buffer) => void): void;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  if (await Promise.race([exited.then(() => true), delay(3_000).then(() => false)])) return;
  child.kill("SIGKILL");
  await Promise.race([exited, delay(3_000)]);
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

async function fetchAsPairedDevice<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      authorization: `Bearer ${DEVICE_TOKEN}`,
      // The production auth gate treats a proxy-forwarding header as non-loopback, so this exercises
      // paired-device authentication without depending on the host's LAN adapters.
      "x-forwarded-for": "203.0.113.42",
    },
  });
  if (response.status !== 200) {
    const body = await response.text();
    assert.equal(response.status, 200, body);
  }
  return await response.json() as T;
}

function registerFrame(): string {
  return JSON.stringify({
    type: "register",
    token: RUNNER_TOKEN,
    protocolVersion: PROTOCOL_VERSION,
    runner: {
      runnerId: RUNNER_ID,
      hostname: "liveness-host",
      os: "linux",
      version: "integration",
      workspaces: [{ id: WORKSPACE_ID, name: "Liveness Workspace", path: `/workspaces/${WORKSPACE_ID}` }],
      agents: [],
    },
    // Reconcile (not hydrate) path: keep the seeded session alive so the sweep is what fails it.
    liveSessions: [SESSION_ID],
  });
}

async function openRegisteredRunner(wsBase: string): Promise<StrictSocket> {
  const socket = new StrictWebSocket(`${wsBase}/runner`);
  await new Promise<void>((resolvePromise, reject) => {
    socket.once("open", resolvePromise);
    socket.once("error", reject);
  });
  const registered = new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for registered")), 5_000);
    socket.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message && typeof message === "object" && (message as { type?: unknown }).type === "registered") {
        clearTimeout(timer);
        resolvePromise();
      }
    });
  });
  socket.send(registerFrame());
  await registered;
  return socket;
}

test(
  "the control plane sweeps a runner offline when its heartbeats stop, without a clean socket close",
  { timeout: 60_000 },
  async (t) => {
    const port = await reservePort();
    const temp = mkdtempSync(join(tmpdir(), "wollipog-liveness-sweep-"));
    const databasePath = join(temp, "control-plane.db");

    const seed = ControlPlaneDb.open(databasePath);
    const identity = seed.localIdentityContext();
    const now = Date.now();
    seed.registerRunner({
      runnerId: RUNNER_ID,
      hostname: "liveness-host",
      os: "linux",
      version: "integration",
      agents: [],
      workspaces: [{ id: WORKSPACE_ID, name: "Liveness Workspace", path: `/workspaces/${WORKSPACE_ID}` }],
    }, now);
    seed.createSession({
      id: SESSION_ID,
      runnerId: RUNNER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: null,
      title: "Liveness Session",
      titleSource: "user",
      useWorktree: false,
      driver: "acp",
      config: {},
      now: now + 1,
    });
    seed.issueRunnerCredential({
      credentialId: "rcred_liveness00000000000000000000000",
      runnerId: RUNNER_ID,
      organizationId: identity.organizationId,
      ownerKind: "organization",
      ownerId: identity.organizationId,
      label: "Liveness fixture",
      tokenHash: hashToken(RUNNER_TOKEN),
      createdByUserId: identity.userId,
      now,
      expiresAt: now + 600_000,
    });
    seed.createDevice({
      id: "device_liveness",
      name: "Liveness Device",
      tokenHash: hashToken(DEVICE_TOKEN),
      now: now + 2,
    });
    seed.close();

    let output = "";
    const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CONTROL_PLANE_HOST: "127.0.0.1",
        CONTROL_PLANE_PORT: String(port),
        CONTROL_PLANE_DB: databasePath,
        // Short heartbeat ⇒ the sweep runs every 250ms and its 3× staleness threshold is 750ms, so a
        // runner that never heartbeats is reaped within ~1s instead of the production ~30s.
        CONTROL_PLANE_HEARTBEAT_MS: "250",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const capture = (chunk: unknown) => { output = (output + String(chunk)).slice(-32_768); };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    let socket: StrictSocket | undefined;
    t.after(async () => {
      if (socket && socket.readyState < 2) socket.close();
      await stopChild(child);
      rmSync(temp, { recursive: true, force: true });
    });

    const httpBase = `http://127.0.0.1:${port}`;
    const wsBase = `ws://127.0.0.1:${port}`;
    await waitForHealth(httpBase, child, () => output);

    // Register the runner (marks it online) but NEVER send a heartbeat, mimicking a socket that went
    // half-open after a sleep/Wi-Fi drop: readyState stays OPEN and no FIN/RST ever arrives.
    socket = await openRegisteredRunner(wsBase);
    const closed = new Promise<{ code: number }>((resolvePromise) => {
      socket!.once("close", (code) => resolvePromise({ code }));
    });

    // The server — not this client — must tear the socket down, and specifically via terminate():
    // a real half-open socket never completes a graceful close handshake, so the sweep MUST force a
    // termination. A terminated socket reaches this (responsive) peer as abnormal close 1006 (no
    // close frame); a graceful close(1008) would read as 1008. Asserting 1006 makes this test fail
    // if closeRunner ever regresses to a graceful close that a dead peer would never acknowledge.
    const closeResult = await Promise.race([
      closed,
      delay(15_000).then(() => { throw new Error(`sweep never closed the runner socket\n${output}`); }),
    ]);
    assert.equal(closeResult.code, 1006, `expected a forced terminate (abnormal 1006), got ${closeResult.code}`);

    // The sweep must drive the SAME onGone cleanup a clean disconnect does: runner → offline and its
    // non-terminal session → stopped.
    let runnerOffline = false;
    let sessionStopped = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const runners = await fetchAsPairedDevice<{ runners: RunnerView[] }>(httpBase, "/api/runners");
      const runner = runners.runners.find((r) => r.runnerId === RUNNER_ID);
      runnerOffline = runner?.status === "offline";
      const lookup = await fetchAsPairedDevice<{ session: SessionView }>(
        httpBase,
        `/api/sessions/lookup/by-id?id=${encodeURIComponent(SESSION_ID)}`,
      );
      sessionStopped = lookup.session.status === "stopped";
      if (runnerOffline && sessionStopped) break;
      await delay(100);
    }
    assert.ok(runnerOffline, `runner never transitioned offline via the sweep\n${output}`);
    assert.ok(sessionStopped, `runner's session was never failed by the sweep\n${output}`);
    assert.match(output, /runner heartbeat timed out/, `the sweep did not log the stale runner\n${output}`);

    // The control plane must still be serving after reaping the dead socket.
    assert.equal(child.exitCode, null, `control plane exited after the sweep\n${output}`);
    const health = await fetch(`${httpBase}/healthz`);
    assert.equal(health.status, 200, "healthz still serves after the sweep");
  },
);
