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
import { MAX_RUNNER_CLIENT_MESSAGE_BYTES, MAX_RUNNER_CONNECTIONS_PER_IP } from "./runner-channel.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const testRequire = createRequire(import.meta.url);
const websocketPluginRequire = createRequire(testRequire.resolve("@fastify/websocket"));
const StrictWebSocket = websocketPluginRequire("ws").WebSocket as new (url: string) => StrictSocket;

interface StrictSocket {
  readyState: number;
  send(data: string | Buffer): void;
  close(): void;
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
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CONTROL_PLANE_HOST: "127.0.0.1",
      CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_DB: join(temp, "control-plane.db"),
      CONTROL_PLANE_RUNNER_AUTH_TIMEOUT_MS: "750",
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

  for (let i = 0; i < MAX_RUNNER_CONNECTIONS_PER_IP; i++) {
    sockets.add(await openSocket(runnerUrl));
  }
  const excess = await openSocket(runnerUrl);
  const excessClosed = await waitForClose(excess);
  assert.deepEqual(excessClosed, { code: 1006, reason: "" }, "excess transport is force-dropped");

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
