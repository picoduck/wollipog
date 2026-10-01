import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, type SessionSnapshot } from "@wollipog/protocol";
import { DatabaseSync } from "node:sqlite";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";
import { MAX_RUNNER_CLIENT_MESSAGE_BYTES, MAX_RUNNER_CONNECTIONS_PER_IP } from "./runner-channel.js";
import { RunnerFrameQueue, setRunnerReceivePressure } from "./runner-frame-queue.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const testRequire = createRequire(import.meta.url);
const websocketPluginRequire = createRequire(testRequire.resolve("@fastify/websocket"));
const StrictWebSocket = websocketPluginRequire("ws").WebSocket as new (url: string) => StrictSocket;

interface StrictSocket {
  readyState: number;
  readonly isPaused: boolean;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  pause(): void;
  resume(): void;
  ping(): void;
  once(event: "pong", listener: () => void): void;
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

async function openSocket(url: string): Promise<StrictSocket> {
  const socket = new StrictWebSocket(url);
  await new Promise<void>((resolvePromise, reject) => {
    socket.once("open", resolvePromise);
    socket.once("error", reject);
  });
  return socket;
}

function runnerToken(index: number): string {
  return `wollipogr_${String(index).padStart(43, "a")}`;
}

test("a real WebSocket closing under queue pressure completes its handshake without the close timer", { timeout: 10_000 }, async (t) => {
  const WebSocketServer = websocketPluginRequire("ws").WebSocketServer as new (options: { host: string; port: number }) => {
    address(): { port: number };
    once(event: "listening", listener: () => void): void;
    once(event: "connection", listener: (socket: StrictSocket) => void): void;
    close(callback: () => void): void;
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolvePromise) => server.once("listening", resolvePromise));
  const connected = new Promise<StrictSocket>((resolvePromise) => server.once("connection", resolvePromise));
  const client = await openSocket(`ws://127.0.0.1:${server.address().port}`);
  const peer = await connected;
  t.after(async () => {
    client.terminate();
    peer.terminate();
    await new Promise<void>((resolvePromise) => server.close(resolvePromise));
  });
  let release!: () => void;
  const held = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const queue = new RunnerFrameQueue<number>(async (n) => {
    if (n === 0) await held;
    if (n === 1) peer.close(1008, "Synthetic invalid frame");
  }, () => assert.fail("synthetic backlog must remain below hard limits"), { frames: 8, bytes: 100 }, undefined,
  (paused) => { setRunnerReceivePressure(peer, paused); });
  queue.enqueue(0, 1);
  for (let n = 1; n <= 5; n++) queue.enqueue(n, 10);
  assert.equal(peer.isPaused, true, "the failure starts on a receive-paused socket");
  const closed = waitForClose(peer, 2000);
  release();
  assert.equal((await closed).code, 1008, "the peer's close acknowledgement is read promptly");
  assert.equal(peer.isPaused, false);
  queue.close();
});

test("1500 retained campaign children reconcile while real HTTP and heartbeat pongs make progress", { timeout: 180_000 }, async (t) => {
  const port = await reservePort();
  const temp = mkdtempSync(join(tmpdir(), "wollipog-reconcile-responsive-"));
  const databasePath = join(temp, "control-plane.db");
  const seed = ControlPlaneDb.open(databasePath);
  // Only fixture construction skips fsync; the real server opens its own normally durable
  // connection. Thousands of setup commits should not dominate concurrent suite I/O.
  seed.raw().exec("PRAGMA synchronous=OFF");
  const identity = seed.localIdentityContext();
  const frame = JSON.parse(registerFrame(555));
  const runnerId = frame.runner.runnerId as string;
  seed.issueRunnerCredential({ credentialId: "rcred_reconcile_responsiveness_test", runnerId,
    organizationId: identity.organizationId, ownerKind: "organization", ownerId: identity.organizationId,
    label: "Synthetic", tokenHash: hashToken(runnerToken(555)), createdByUserId: identity.userId,
    now: Date.now(), expiresAt: Date.now() + 120_000 });
  seed.registerRunner(frame.runner, 1, PROTOCOL_VERSION);
  const base = { runnerId, workspaceId: "ws", agentId: "claude", title: "Synthetic",
    driver: "claude-code" as const, useWorktree: false, config: {}, now: 1 };
  for (let i = 0; i < 10; i++) seed.createSession({ ...base, id: `campaign-${i}`,
    orchestratorPolicy: resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default") });
  const snapshots: SessionSnapshot[] = [];
  for (let i = 0; i < 1500; i++) {
    const id = `child-${i}`;
    seed.createSession({ ...base, id, parentSessionId: `campaign-${i % 10}` });
    seed.updateSessionStatus(id, "completed", 2);
    snapshots.push({ id, workspaceId: "ws", agentId: "claude", title: "Synthetic", status: "completed",
      driver: "claude-code", useWorktree: false, worktreePath: null, config: {}, preview: null,
      pendingApproval: null, tokensIn: 0, tokensOut: 0, costUsd: 0, seq: 0, createdAt: 1, updatedAt: 2 });
  }
  seed.createShell({ shellId: "burst-shell", sessionId: "child-1499", runnerId, name: "Synthetic Burst", createdAt: 1 });
  seed.raw().exec("PRAGMA synchronous=FULL");
  seed.close();
  let output = "";
  let reconciliationCompleted = false;
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: REPO_ROOT, env: { ...process.env, CONTROL_PLANE_HOST: "127.0.0.1",
      CONTROL_PLANE_PORT: String(port), CONTROL_PLANE_DB: databasePath },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  child.stdout?.on("data", (chunk) => {
    output = (output + String(chunk)).slice(-128_000);
    reconciliationCompleted ||= output.includes("runner_reconciliation_completed");
  });
  child.stderr?.on("data", (chunk) => { output = (output + String(chunk)).slice(-128_000); });
  const sockets: StrictSocket[] = [];
  let read: DatabaseSync | undefined;
  t.after(async () => {
    for (const socket of sockets) if (socket.readyState < 2) socket.close();
    await stopChild(child);
    read?.close();
    rmSync(temp, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(url, child, () => output);
  read = new DatabaseSync(databasePath, { readOnly: true });
  let maxHealthMs = 0;
  let maxPongMs = 0;
  for (let pass = 0; pass < 3; pass++) {
    const socket = await openSocket(`ws://127.0.0.1:${port}/runner`);
    sockets.push(socket);
    // Behave like a real runner throughout the convergence wait, not just during probe samples.
    const heartbeat = setInterval(() => {
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: "heartbeat" }));
    }, 500);
    t.after(() => clearInterval(heartbeat));
    const registered = new Promise<void>((resolvePromise) => socket.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "registered") resolvePromise();
    }));
    socket.send(JSON.stringify({ ...frame, sessionSnapshots: pass === 2
      ? [...snapshots, { ...snapshots[0]!, id: "new-credential-session" }] : snapshots }));
    await registered;
    let newBindings: Promise<boolean[]> | undefined;
    if (pass === 2) {
      newBindings = new Promise<boolean[]>((resolvePromise) => {
        const answers: boolean[] = [];
        const timer = setTimeout(() => resolvePromise([false]), 60_000);
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString());
          if (message.sessionId !== "new-credential-session" || ![
            "agent_control_credential_registered", "policy_hook_credential_registered",
          ].includes(message.type)) return;
          answers.push(message.accepted);
          if (answers.length === 2) { clearTimeout(timer); resolvePromise(answers); }
        });
      });
      // Unlike existing-session handshakes, these bindings must wait for their first inventory
      // row instead of rejecting a valid runner-held session that has not been materialized yet.
      socket.send(JSON.stringify({ type: "agent_control_credential", sessionId: "new-credential-session", tokenHash: "b".repeat(64) }));
      socket.send(JSON.stringify({ type: "policy_hook_credential", sessionId: "new-credential-session", tokenHash: "c".repeat(64) }));
    }
    const credentialHandshake = new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("Agent Control handshake stalled during inventory")), 2000);
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "agent_control_credential_registered" || message.sessionId !== "child-1499") return;
        clearTimeout(timer);
        assert.equal(message.accepted, true);
        resolvePromise();
      });
    });
    socket.send(JSON.stringify({ type: "agent_control_credential", sessionId: "child-1499", tokenHash: "a".repeat(64) }));
    await credentialHandshake;
    // The real runner republishes negotiated metadata for every retained session immediately
    // after registration. Exercise that burst, not just one isolated live update.
    for (const snap of snapshots) socket.send(JSON.stringify({ type: "session_runtime_updated",
      snapshot: { ...snap, preview: `Negotiated ${pass}` } }));
    // A live update arriving during the inventory must win, even on a replacement socket.
    const liveSnapshot = {
      ...snapshots[1499], title: `Live ${pass}`, updatedAt: 3 + pass,
    };
    const fingerprint = createHash("sha256").update(JSON.stringify(liveSnapshot)).digest("hex");
    socket.send(JSON.stringify({ type: "session_runtime_updated", snapshot: liveSnapshot }));
    const probe = async () => {
      const start = performance.now();
      const pong = new Promise<void>((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error(`pong exceeded 2s during reconciliation\n${output}`)), 2000);
        socket.once("pong", () => { clearTimeout(timer); maxPongMs = Math.max(maxPongMs, performance.now() - start); resolvePromise(); });
      });
      socket.ping();
      socket.send(JSON.stringify({ type: "heartbeat" }));
      const [response] = await Promise.all([
        fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) }), pong,
      ]);
      assert.equal(response.status, 200);
      maxHealthMs = Math.max(maxHealthMs, performance.now() - start);
    };
    for (let sample = 0; sample < (pass === 0 ? 1 : 10); sample++) await probe();
    if (pass === 0) continue; // replace a still-reconciling socket, not just a settled runner
    // Pin application of the exact newer snapshot, not title projection: a CP-owned rename is
    // intentionally preserved even when newer runner state is successfully applied. Allow slow
    // file-backed test hosts to converge under full-suite fsync contention. Probe throughout the
    // entire replay, not just its first few steps; HTTP/pong deadlines remain two seconds.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (read.prepare("SELECT runner_snapshot_fingerprint FROM sessions WHERE id='child-1499'").get()?.runner_snapshot_fingerprint === fingerprint) break;
      await probe();
      await delay(50);
    }
    assert.equal(read.prepare("SELECT runner_snapshot_fingerprint FROM sessions WHERE id='child-1499'").get()?.runner_snapshot_fingerprint,
      fingerprint, `newer snapshot did not converge\n${output}`);
    if (newBindings) assert.deepEqual(await newBindings, [true, true], "new session bindings wait for materialization rather than being rejected");
  }
  // Shell output bypasses the runner outbox and legitimately exceeds the queue's byte ceiling
  // over time. Transport flow control must pace it, not disconnect every session on this runner.
  const burstSocket = sockets.at(-1)!;
  const data = "x".repeat(64 * 1024);
  let disconnected = false;
  burstSocket.once("close", () => { disconnected = true; });
  for (let seq = 1; seq <= 2000; seq++) burstSocket.send(JSON.stringify({ type: "shell_output",
    sessionId: "child-1499", shellId: "burst-shell", stream: "stdout", data, seq }));
  const burstDeadline = Date.now() + 60_000;
  while (Date.now() < burstDeadline && !disconnected) {
    if (read.prepare("SELECT output_end_seq FROM session_shells WHERE shell_id='burst-shell'").get()?.output_end_seq === 2000) break;
    const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    await delay(50);
  }
  assert.equal(disconnected, false, `ordinary shell output disconnected the runner\n${output}`);
  assert.equal(read.prepare("SELECT output_end_seq FROM session_shells WHERE shell_id='burst-shell'").get()?.output_end_seq, 2000,
    `the bounded shell tail did not reach the end of the burst\n${output}`);
  assert.ok(maxHealthMs < 2000, `health latency ${maxHealthMs}ms`);
  assert.ok(maxPongMs < 2000, `heartbeat latency ${maxPongMs}ms`);
  t.diagnostic(`Three registrations: max HTTP ${Math.round(maxHealthMs)}ms, max pong ${Math.round(maxPongMs)}ms`);
  assert.equal(reconciliationCompleted, true);
  t.diagnostic(`Reconciliation cancellation observed: ${/runner_reconciliation_cancelled/.test(output)}`);
  assert.doesNotMatch(output, /runner frame handler threw|runner_frame_queue_closed/);
});

function registerFrame(index: number): string {
  return JSON.stringify({
    type: "register",
    token: runnerToken(index),
    protocolVersion: PROTOCOL_VERSION,
    runner: {
      runnerId: `runner-limits-${index}`,
      hostname: `runner-limits-${index}`,
      os: "linux",
      version: "integration",
      workspaces: [],
      agents: [],
    },
    sessionSnapshots: [],
  });
}

async function openRegisteredSocket(url: string, index: number): Promise<StrictSocket> {
  const socket = await openSocket(url);
  const registered = new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for runner registration")), 5_000);
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type?: unknown };
      if (message.type !== "registered") return;
      clearTimeout(timer);
      resolvePromise();
    });
  });
  socket.send(registerFrame(index));
  await registered;
  return socket;
}

function waitForClose(socket: StrictSocket, timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for runner socket close")), timeoutMs);
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolvePromise({ code, reason: reason.toString("utf8") });
    });
  });
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

test("the real /runner route bounds unauthenticated sockets and payloads", { timeout: 45_000 }, async (t) => {
  const port = await reservePort();
  const temp = mkdtempSync(join(tmpdir(), "wollipog-runner-limits-"));
  const databasePath = join(temp, "control-plane.db");
  const seed = ControlPlaneDb.open(databasePath);
  const identity = seed.localIdentityContext();
  for (let index = 0; index <= MAX_RUNNER_CONNECTIONS_PER_IP; index++) {
    const now = Date.now();
    seed.issueRunnerCredential({
      credentialId: `rcred_runner_limits_${String(index).padStart(20, "0")}`,
      runnerId: `runner-limits-${index}`,
      organizationId: identity.organizationId,
      ownerKind: "organization",
      ownerId: identity.organizationId,
      label: `Runner limits ${index}`,
      tokenHash: hashToken(runnerToken(index)),
      createdByUserId: identity.userId,
      now,
      expiresAt: now + 60_000,
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
      CONTROL_PLANE_RUNNER_AUTH_TIMEOUT_MS: "2000",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const capture = (chunk: unknown) => { output = (output + String(chunk)).slice(-32_768); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const sockets = new Set<StrictSocket>();
  t.after(async () => {
    for (const socket of sockets) if (socket.readyState < 2) socket.close();
    await stopChild(child);
    rmSync(temp, { recursive: true, force: true });
  });

  const httpBase = `http://127.0.0.1:${port}`;
  const runnerUrl = `ws://127.0.0.1:${port}/runner`;
  await waitForHealth(httpBase, child, () => output);

  // Managed SSH runners reverse-tunnel into the control plane and therefore share loopback as
  // their transport source. Successful authentication must release only that pre-auth IP slot.
  for (let index = 0; index <= MAX_RUNNER_CONNECTIONS_PER_IP; index++) {
    sockets.add(await openRegisteredSocket(runnerUrl, index));
  }
  assert.equal(sockets.size, MAX_RUNNER_CONNECTIONS_PER_IP + 1);
  for (const socket of sockets) socket.close();
  sockets.clear();
  await delay(100);

  for (let i = 0; i < MAX_RUNNER_CONNECTIONS_PER_IP; i++) {
    sockets.add(await openSocket(runnerUrl));
  }
  const excessOpenedAt = Date.now();
  const excess = await openSocket(runnerUrl);
  const excessClosed = await waitForClose(excess);
  assert.deepEqual(excessClosed, { code: 1006, reason: "" }, "excess transport is force-dropped");
  assert.ok(Date.now() - excessOpenedAt < 1_000, "cap rejection occurs well before the auth timeout");

  for (const socket of sockets) socket.close();
  sockets.clear();
  await delay(100);

  const oversized = await openSocket(runnerUrl);
  sockets.add(oversized);
  const oversizedClosed = waitForClose(oversized);
  oversized.send(Buffer.alloc(MAX_RUNNER_CLIENT_MESSAGE_BYTES + 1));
  assert.equal((await oversizedClosed).code, 1009, "ws rejects an oversized frame while assembling it");
  sockets.delete(oversized);

  const idle = await openSocket(runnerUrl);
  sockets.add(idle);
  assert.deepEqual(await waitForClose(idle), { code: 1006, reason: "" }, "silent transport is force-dropped");
  sockets.delete(idle);

  assert.equal(child.exitCode, null, `control plane exited while enforcing runner limits\n${output}`);
  assert.equal((await fetch(`${httpBase}/healthz`)).status, 200);
}
);
