import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

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

function registerFrame(runnerId: string, token: string): string {
  return JSON.stringify({
    type: "register",
    token,
    protocolVersion: PROTOCOL_VERSION,
    runner: {
      runnerId,
      hostname: "frame-isolation-host",
      os: "linux",
      version: "integration",
      workspaces: [],
      agents: [],
    },
    sessionSnapshots: [],
  });
}

async function openRegisteredRunner(
  wsBase: string,
  runnerId: string,
  token: string,
  sockets: Set<StrictSocket>,
): Promise<StrictSocket> {
  const socket = new StrictWebSocket(`${wsBase}/runner`);
  sockets.add(socket);
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
  socket.send(registerFrame(runnerId, token));
  await registered;
  return socket;
}

function waitForClose(socket: StrictSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for socket close")), 5_000);
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolvePromise({ code, reason: reason.toString("utf8") });
    });
  });
}

test(
  "runner persistence recovery is bounded and FIFO while malformed frames remain socket-isolated",
  { timeout: 60_000 },
  async (t) => {
    const port = await reservePort();
    const temp = mkdtempSync(join(tmpdir(), "wollipog-frame-isolation-"));
    const databasePath = join(temp, "control-plane.db");
    const runnerToken = `wollipogr_${"a".repeat(43)}`;

    const seed = ControlPlaneDb.open(databasePath);
    const identity = seed.localIdentityContext();
    const now = Date.now();
    seed.issueRunnerCredential({
      credentialId: "rcred_frameisolation0000000000000000",
      runnerId: "runner-frame-isolation",
      organizationId: identity.organizationId,
      ownerKind: "organization",
      ownerId: identity.organizationId,
      label: "Frame isolation fixture",
      tokenHash: hashToken(runnerToken),
      createdByUserId: identity.userId,
      now,
      expiresAt: now + 600_000,
    });
    seed.registerRunner(JSON.parse(registerFrame("runner-frame-isolation", runnerToken)).runner, now, PROTOCOL_VERSION);
    seed.createSession({ id: "locked-session", runnerId: "runner-frame-isolation", workspaceId: "ws",
      agentId: "claude", driver: "claude-code", title: "Before lock", useWorktree: false, config: {}, now });
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

    const sockets = new Set<StrictSocket>();
    let inspectionDb: DatabaseSync | undefined;
    t.after(async () => {
      for (const socket of sockets) {
        if (socket.readyState < 2) socket.close();
      }
      await stopChild(child);
      inspectionDb?.close();
      rmSync(temp, { recursive: true, force: true });
    });

    const httpBase = `http://127.0.0.1:${port}`;
    const wsBase = `ws://127.0.0.1:${port}`;
    await waitForHealth(httpBase, child, () => output);

    const lock = inspectionDb = new DatabaseSync(databasePath);
    const snapshot = { id: "locked-session", workspaceId: "ws", agentId: "claude", driver: "claude-code",
      title: "After lock", status: "idle", useWorktree: false, worktreePath: null, config: {}, preview: null,
      pendingApproval: null, tokensIn: 0, tokensOut: 0, costUsd: 0, seq: 0, createdAt: now, updatedAt: now };
    const waitUntil = async (predicate: () => boolean) => {
      for (let i = 0; i < 150; i++) {
        if (predicate()) return;
        await delay(20);
      }
      assert.fail(`condition did not become true\n${output}`);
    };
    const invalid = new StrictWebSocket(`${wsBase}/runner`);
    sockets.add(invalid);
    await new Promise<void>((resolvePromise, reject) => {
      invalid.once("open", resolvePromise);
      invalid.once("error", reject);
    });
    lock.exec("BEGIN IMMEDIATE");
    const invalidClosed = waitForClose(invalid);
    const invalidStarted = performance.now();
    invalid.send(registerFrame("runner-unknown", runnerToken));
    const invalidResult = await invalidClosed;
    lock.exec("COMMIT");
    assert.equal(invalidResult.code, 1008);
    assert.equal(invalidResult.reason, "invalid token");
    assert.ok(performance.now() - invalidStarted < 750, "invalid registrations do not wait for write intent");
    sockets.delete(invalid);
    const contender = new StrictWebSocket(`${wsBase}/runner`);
    sockets.add(contender);
    await new Promise<void>((resolvePromise, reject) => {
      contender.once("open", resolvePromise);
      contender.once("error", reject);
    });
    lock.exec("BEGIN IMMEDIATE");
    // The database commit and child stdout are separate transports. Hold log delivery until
    // registration persists to exercise the ordering hosted CI can observe.
    child.stdout?.pause();
    contender.send(JSON.stringify({ ...JSON.parse(registerFrame("runner-frame-isolation", runnerToken)),
      sessionSnapshots: [snapshot] }));
    await delay(550);
    lock.exec("COMMIT");
    await waitUntil(() => lock.prepare("SELECT title FROM sessions WHERE id=?").get(snapshot.id)?.title === "After lock");
    assert.equal(contender.readyState, 1, "registration survives a real lock longer than the busy timeout");
    child.stdout?.resume();
    await waitUntil(() => output.includes("runner_persistence_contention"));
    await waitUntil(() => output.includes("runner online: runner-frame-isolation"));

    lock.exec("BEGIN IMMEDIATE");
    contender.send(JSON.stringify({ type: "session_event", sessionId: snapshot.id, seq: 1,
      ts: Date.now(), payload: { kind: "assistant_message", text: "After event lock" } }));
    await delay(550);
    lock.exec("COMMIT");
    assert.equal(contender.readyState, 1, `event ingest survives a deferred-transaction lock upgrade\n${output}`);
    await waitUntil(() => Boolean(lock.prepare("SELECT 1 FROM session_events WHERE session_id=? AND runner_seq=1")
      .get(snapshot.id)));

    const agentsBefore = lock.prepare("SELECT agents_refreshed_at AS refreshed FROM runners WHERE runner_id=?")
      .get("runner-frame-isolation")?.refreshed;
    lock.exec("BEGIN IMMEDIATE");
    contender.send(JSON.stringify({ type: "agents_updated", runnerId: "runner-frame-isolation", agents: [] }));
    await delay(550);
    lock.exec("COMMIT");
    await waitUntil(() => lock.prepare("SELECT agents_refreshed_at AS refreshed FROM runners WHERE runner_id=?")
      .get("runner-frame-isolation")?.refreshed !== agentsBefore);
    assert.equal(contender.readyState, 1, "agent updates acquire write intent before reading protocol metadata");

    // Single and queued runtime updates share the same ordering and retry boundary. Last wins.
    lock.exec("BEGIN IMMEDIATE");
    contender.send(JSON.stringify({ type: "session_runtime_updated", snapshot: { ...snapshot, title: "First update" } }));
    contender.send(JSON.stringify({ type: "session_runtime_updated", snapshot: { ...snapshot, title: "Second update" } }));
    contender.send(JSON.stringify({ type: "session_runtime_updated", snapshot: { ...snapshot, title: "Last update" } }));
    await delay(550);
    lock.exec("COMMIT");
    await waitUntil(() => lock.prepare("SELECT title FROM sessions WHERE id=?").get(snapshot.id)?.title === "Last update");
    assert.equal(contender.readyState, 1, `runtime updates survive contention and remain FIFO\n${output}`);

    lock.exec("BEGIN IMMEDIATE");
    const exhausted = waitForClose(contender);
    const exhaustionStarted = performance.now();
    // Socket close and child stdout are separate transports. Exercise delayed log delivery:
    // hosted CI can observe the close before it receives the exhaustion log.
    child.stdout?.pause();
    contender.send(JSON.stringify({ type: "session_runtime_updated", snapshot }));
    const exhaustedClose = await exhausted;
    const exhaustionMs = performance.now() - exhaustionStarted;
    child.stdout?.resume();
    lock.exec("COMMIT");
    assert.equal(exhaustedClose.code, 1011);
    assert.equal(exhaustedClose.reason, "runner persistence unavailable");
    await waitUntil(() => output.includes("runner_persistence_exhausted"));
    assert.ok(exhaustionMs >= 700 && exhaustionMs < 3000, `bounded persistence close took ${exhaustionMs}ms`);
    assert.doesNotMatch(output, /malformed runner frame|runner frame handler threw/);
    sockets.delete(contender);

    // Each frame parses cleanly (cast-only parseMessage) but omits required fields, so the dispatch
    // throws — historically a fatal uncaughtException. Every one must instead close ONLY its socket.
    const malformedFrames = [
      JSON.stringify({ type: "session_event" }),
      JSON.stringify({ type: "session_status" }),
      JSON.stringify({ type: "shell_output" }),
      // Keyed into per-session lanes before any handler runs (#2794).
      JSON.stringify({ type: "session_runtime_updated" }),
      JSON.stringify({ type: "session_runtime_updated", snapshot: null }),
    ];

    for (const frame of malformedFrames) {
      const socket = await openRegisteredRunner(wsBase, "runner-frame-isolation", runnerToken, sockets);
      const closed = waitForClose(socket);
      socket.send(frame);
      const result = await closed;
      assert.equal(result.code, 1008, `expected policy close for frame ${frame} (got ${result.code})`);
      assert.equal(result.reason, "malformed runner frame");
      sockets.delete(socket);

      // The server process must still be alive and serving after the poisoned frame.
      assert.equal(child.exitCode, null, `control plane exited after frame ${frame}\n${output}`);
      const health = await fetch(`${httpBase}/healthz`);
      assert.equal(health.status, 200, `healthz failed after frame ${frame}`);
    }

    // Definitive proof the control plane survived: a brand-new runner can still register.
    const survivor = await openRegisteredRunner(wsBase, "runner-frame-isolation", runnerToken, sockets);
    assert.ok(survivor.readyState < 2, "a fresh runner registered after the malformed frames");
  },
);
