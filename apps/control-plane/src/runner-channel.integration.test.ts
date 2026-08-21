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
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";
import { MAX_RUNNER_CLIENT_MESSAGE_BYTES, MAX_RUNNER_CONNECTIONS_PER_IP } from "./runner-channel.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const testRequire = createRequire(import.meta.url);
const websocketPluginRequire = createRequire(testRequire.resolve("@fastify/websocket"));
const StrictWebSocket = websocketPluginRequire("ws").WebSocket as new (url: string) => StrictSocket;

interface StrictSocket {
  readyState: number;
  send(data: string | Buffer): void;
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
