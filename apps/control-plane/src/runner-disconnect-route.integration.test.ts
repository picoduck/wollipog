import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  type RunnerMetadata,
  type RunnerView,
  type SessionView,
  type ShellView,
} from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const OWNER_TOKEN = "runner-disconnect-owner-token";
const MODERN_TOKEN = `wollipogr_${"m".repeat(43)}`;
const LEGACY_TOKEN = `wollipogr_${"l".repeat(43)}`;

type JsonObject = Record<string, unknown>;

class JsonInbox {
  private readonly queued: JsonObject[] = [];
  private readonly waiters = new Set<{
    predicate: (message: JsonObject) => boolean;
    resolve: (message: JsonObject) => void;
  }>();

  constructor(private readonly socket: WebSocket) {
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

  take(predicate: (message: JsonObject) => boolean, timeoutMs = 5_000): Promise<JsonObject> {
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
        reject(new Error("timed out waiting for runner websocket message"));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }
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

async function waitForLog(logs: () => string, needle: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!logs().includes(needle)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for log: ${needle}\n${logs()}`);
    await delay(10);
  }
}

async function openRegisteredRunner(
  wsBase: string,
  runner: RunnerMetadata,
  token: string,
  protocolVersion: number,
  liveSessionId: string,
): Promise<WebSocket> {
  const socket = new WebSocket(`${wsBase}/runner`);
  const inbox = new JsonInbox(socket);
  await new Promise<void>((resolvePromise, reject) => {
    socket.addEventListener("open", () => resolvePromise(), { once: true });
    socket.addEventListener("error", () => reject(new Error("runner websocket failed to open")), { once: true });
  });
  socket.send(JSON.stringify({
    type: "register",
    token,
    protocolVersion,
    runner,
    liveSessions: [liveSessionId],
  }));
  await inbox.take((message) => message.type === "registered");
  return socket;
}

function closed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolvePromise) => socket.addEventListener("close", () => resolvePromise(), { once: true }));
}

function publishRunningShell(socket: WebSocket, sessionId: string, shellId: string): void {
  socket.send(JSON.stringify({
    type: "shell_snapshot",
    sessionId,
    shellId,
    name: "Shell 1",
    createdAt: 1,
    pty: true,
    kind: "shell",
    status: "running",
    exitCode: null,
    outputStartSeq: 1,
    outputEndSeq: 0,
    outputTruncated: false,
    chunks: [],
  }));
}

interface RouteState {
  runnerStatus?: RunnerView["status"];
  sessionStatus?: SessionView["status"];
  shellStatus?: ShellView["status"];
}

async function readRouteState(
  httpBase: string,
  runnerId: string,
  sessionId: string,
  shellId: string,
): Promise<RouteState> {
  const headers = { authorization: `Bearer ${OWNER_TOKEN}` };
  const [runnersResponse, sessionResponse, shellsResponse] = await Promise.all([
    fetch(`${httpBase}/api/runners`, { headers }),
    fetch(`${httpBase}/api/sessions/${sessionId}`, { headers }),
    fetch(`${httpBase}/api/sessions/${sessionId}/shells`, { headers }),
  ]);
  const runners = runnersResponse.ok
    ? await runnersResponse.json() as { runners: RunnerView[] }
    : { runners: [] };
  const session = sessionResponse.ok
    ? await sessionResponse.json() as { session: SessionView }
    : undefined;
  const shells = shellsResponse.ok
    ? await shellsResponse.json() as { shells: ShellView[] }
    : { shells: [] };
  return {
    runnerStatus: runners.runners.find((runner) => runner.runnerId === runnerId)?.status,
    sessionStatus: session?.session.status,
    shellStatus: shells.shells.find((shell) => shell.shellId === shellId)?.status,
  };
}

async function waitForRouteState(
  httpBase: string,
  runnerId: string,
  sessionId: string,
  shellId: string,
  expected: RouteState,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  let state = await readRouteState(httpBase, runnerId, sessionId, shellId);
  while (Object.entries(expected).some(([key, value]) => state[key as keyof RouteState] !== value)) {
    if (Date.now() >= deadline) {
      assert.deepEqual(state, expected, `timed out waiting for ${runnerId} disconnect state`);
    }
    await delay(20);
    state = await readRouteState(httpBase, runnerId, sessionId, shellId);
  }
}

function runnerMetadata(runnerId: string, workspaceId: string): RunnerMetadata {
  return {
    runnerId,
    hostname: `${runnerId}-host`,
    os: "linux",
    version: "integration",
    agents: [],
    workspaces: [{ id: workspaceId, name: workspaceId, path: `/workspaces/${workspaceId}` }],
  };
}

test("real /runner disconnect applies protocol-gated cleanup and ignores a replaced socket", { timeout: 45_000 }, async (t) => {
  const port = await reservePort();
  const temp = mkdtempSync(join(tmpdir(), "wollipog-runner-disconnect-"));
  const databasePath = join(temp, "control-plane.db");
  const modernRunner = runnerMetadata("runner-modern-disconnect", "workspace-modern-disconnect");
  const legacyRunner = runnerMetadata("runner-legacy-disconnect", "workspace-legacy-disconnect");
  const now = Date.now();
  const seed = ControlPlaneDb.open(databasePath);
  const identity = seed.localIdentityContext();
  seed.createDevice({
    id: "device_runner_disconnect",
    name: "Runner Disconnect Device",
    tokenHash: hashToken(OWNER_TOKEN),
    now,
  });
  for (const [runner, token, protocolVersion, sessionId] of [
    [modernRunner, MODERN_TOKEN, 57, "session-modern-disconnect"],
    [legacyRunner, LEGACY_TOKEN, 56, "session-legacy-disconnect"],
  ] as const) {
    seed.registerRunner(runner, now, protocolVersion);
    seed.issueRunnerCredential({
      credentialId: `rcred_${runner.runnerId.replaceAll("-", "").padEnd(32, "0").slice(0, 32)}`,
      runnerId: runner.runnerId,
      organizationId: identity.organizationId,
      ownerKind: "organization",
      ownerId: identity.organizationId,
      label: `${runner.runnerId} fixture`,
      tokenHash: hashToken(token),
      createdByUserId: identity.userId,
      now,
      expiresAt: now + 60_000,
    });
    seed.createSession({
      id: sessionId,
      runnerId: runner.runnerId,
      workspaceId: runner.workspaces[0]!.id,
      agentId: null,
      title: sessionId,
      titleSource: "user",
      useWorktree: false,
      driver: "acp",
      config: {},
      now,
    });
  }
  seed.close();

  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CONTROL_PLANE_HOST: "127.0.0.1",
      CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: databasePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const capture = (chunk: unknown) => { output = (output + String(chunk)).slice(-32_768); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const sockets = new Set<WebSocket>();
  t.after(async () => {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    }
    await stopChild(child);
    rmSync(temp, { recursive: true, force: true });
  });

  const httpBase = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;
  await waitForHealth(httpBase, child, () => output);

  const firstModern = await openRegisteredRunner(
    wsBase,
    modernRunner,
    MODERN_TOKEN,
    57,
    "session-modern-disconnect",
  );
  sockets.add(firstModern);
  publishRunningShell(firstModern, "session-modern-disconnect", "shell-modern-disconnect");
  await waitForRouteState(httpBase, modernRunner.runnerId, "session-modern-disconnect", "shell-modern-disconnect", {
    runnerStatus: "online",
    sessionStatus: "idle",
    shellStatus: "running",
  });

  const firstModernClosed = closed(firstModern);
  const replacementModern = await openRegisteredRunner(
    wsBase,
    modernRunner,
    MODERN_TOKEN,
    57,
    "session-modern-disconnect",
  );
  sockets.add(replacementModern);
  await firstModernClosed;
  await waitForLog(() => output, `stale socket closed for ${modernRunner.runnerId}`);
  assert.deepEqual(
    await readRouteState(httpBase, modernRunner.runnerId, "session-modern-disconnect", "shell-modern-disconnect"),
    { runnerStatus: "online", sessionStatus: "idle", shellStatus: "running" },
    "the replaced socket's stale close must not run any durable disconnect cleanup",
  );

  const replacementClosed = closed(replacementModern);
  replacementModern.close();
  await replacementClosed;
  await waitForRouteState(httpBase, modernRunner.runnerId, "session-modern-disconnect", "shell-modern-disconnect", {
    runnerStatus: "offline",
    sessionStatus: "stopped",
    shellStatus: "reconnecting",
  });

  const legacy = await openRegisteredRunner(
    wsBase,
    legacyRunner,
    LEGACY_TOKEN,
    56,
    "session-legacy-disconnect",
  );
  sockets.add(legacy);
  publishRunningShell(legacy, "session-legacy-disconnect", "shell-legacy-disconnect");
  await waitForRouteState(httpBase, legacyRunner.runnerId, "session-legacy-disconnect", "shell-legacy-disconnect", {
    runnerStatus: "online",
    sessionStatus: "idle",
    shellStatus: "running",
  });
  const legacyClosed = closed(legacy);
  legacy.close();
  await legacyClosed;
  await waitForRouteState(httpBase, legacyRunner.runnerId, "session-legacy-disconnect", "shell-legacy-disconnect", {
    runnerStatus: "offline",
    sessionStatus: "stopped",
    shellStatus: "exited",
  });
});
