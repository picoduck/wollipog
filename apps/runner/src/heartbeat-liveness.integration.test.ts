import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, WOLLIPOG_CONTROL_PLANE_SERVICE } from "@wollipog/protocol";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

// The `ws` server the runner's own client talks to — resolve the exact copy the runner depends on.
const testRequire = createRequire(import.meta.url);
const { WebSocketServer } = testRequire("ws") as typeof import("ws");

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: () => string): Promise<T> {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(ms, undefined, { signal: controller.signal }).then(
        () => { throw new Error(message()); },
        () => undefined as never,
      ),
    ]);
  } finally {
    controller.abort();
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
}

async function waitForSocketClose(
  socket: import("ws").WebSocket,
  timeoutMs: number,
  context: () => string,
): Promise<void> {
  if (socket.readyState >= 2) return;
  await withTimeout(
    new Promise<void>((resolvePromise) => socket.once("close", () => resolvePromise())),
    timeoutMs,
    context,
  );
}

interface FakeControlPlane {
  port: number;
  server: Server;
  wss: InstanceType<typeof WebSocketServer>;
  /** Every /runner socket the runner has opened, in connection order. */
  connections: import("ws").WebSocket[];
  waitForConnection(index: number, timeoutMs: number, context: () => string): Promise<import("ws").WebSocket>;
  close(): Promise<void>;
}

// A minimal control plane that answers the attestation probe and upgrades /runner sockets. Crucially
// it runs with autoPong DISABLED, so it receives the runner's ws-level pings but never replies — the
// exact half-open signature (socket readable as OPEN, peer silent) the runner must detect.
async function startFakeControlPlane(): Promise<FakeControlPlane> {
  const port = await reservePort();
  const wss = new WebSocketServer({ noServer: true, autoPong: false });
  const connections: import("ws").WebSocket[] = [];
  const waiters = new Map<number, () => void>();
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url && req.url.includes("/runner/attestation/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        service: WOLLIPOG_CONTROL_PLANE_SERVICE,
        instanceId: randomUUID(),
        protocolVersion: PROTOCOL_VERSION,
      }));
      return;
    }
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url || !req.url.startsWith("/runner")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const index = connections.length;
      connections.push(ws);
      // Acknowledge registration with a short heartbeat so the runner pings quickly; never pong.
      ws.on("message", (data: Buffer) => {
        let message: unknown;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (message && typeof message === "object" && (message as { type?: unknown }).type === "register") {
          ws.send(JSON.stringify({
            type: "registered",
            ok: true,
            serverTime: Date.now(),
            heartbeatIntervalMs: 250,
            protocolVersion: PROTOCOL_VERSION,
          }));
        }
      });
      waiters.get(index)?.();
      waiters.delete(index);
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(port, "127.0.0.1", resolvePromise));
  return {
    port,
    server,
    wss,
    connections,
    waitForConnection(index, timeoutMs, context) {
      if (connections[index]) return Promise.resolve(connections[index]);
      const arrived = new Promise<import("ws").WebSocket>((resolvePromise) => {
        waiters.set(index, () => resolvePromise(connections[index]));
      });
      return withTimeout(arrived, timeoutMs, context);
    },
    close: () =>
      new Promise<void>((resolvePromise) => {
        wss.close();
        server.close(() => resolvePromise());
      }),
  };
}

test(
  "the runner terminates a half-open control-plane socket and reconnects when pongs stop",
  { timeout: 60_000 },
  async (t) => {
    const cp = await startFakeControlPlane();
    const temp = mkdtempSync(join(tmpdir(), "wollipog-runner-liveness-"));
    let output = "";
    const child = spawn(process.execPath, ["--import", "tsx", "apps/runner/src/cli.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        RUNNER_ID: "runner-liveness",
        RUNNER_TOKEN: "runner-liveness-token",
        CONTROL_PLANE_URL: `ws://127.0.0.1:${cp.port}/runner`,
        RUNNER_DATA_DIR: temp,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const capture = (chunk: unknown) => { output = (output + String(chunk)).slice(-65_536); };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    t.after(async () => {
      await stopChild(child);
      await cp.close();
      rmSync(temp, { recursive: true, force: true });
    });

    // First connection: the runner attests, registers, and starts heartbeating (pinging) at 250ms.
    // The server never pongs, so after MAX_MISSED_HEARTBEAT_PONGS (2) unanswered pings the runner
    // must terminate this socket rather than keep writing frames into it.
    const first = await cp.waitForConnection(0, 30_000, () => `runner never connected\n${output}`);
    for (let attempt = 0; attempt < 100 && !output.includes("terminating socket to reconnect"); attempt++) {
      assert.equal(child.exitCode, null, `runner exited before detecting the dead socket\n${output}`);
      await delay(100);
    }
    assert.match(
      output,
      /control plane heartbeat unanswered \(\d+ missed pongs\) — terminating socket to reconnect/,
      `runner did not terminate the half-open socket\n${output}`,
    );
    // The runner logs its local terminate before the close frame reaches this peer. Wait for the
    // server-side close event rather than assuming stdout and WebSocket propagation are ordered.
    await waitForSocketClose(
      first,
      30_000,
      () => `runner logged terminate but the original socket stayed open\n${output}`,
    );
    // ws marks a terminated socket CLOSED (readyState 3) rather than leaving it OPEN.
    assert.ok(first.readyState >= 2, "the runner's original socket was torn down");

    // The terminate must drop the runner into its existing reconnect path — a brand-new /runner
    // connection proves it recovered rather than wedging on the dead socket.
    await cp.waitForConnection(1, 30_000, () => `runner never reconnected after terminate\n${output}`);
    assert.equal(child.exitCode, null, `runner exited instead of reconnecting\n${output}`);
  },
);
