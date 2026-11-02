import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { PROTOCOL_VERSION, WOLLIPOG_CONTROL_PLANE_SERVICE } from "@wollipog/protocol";
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

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: () => string): Promise<T> {
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

interface FakeControlPlane {
  instanceId: string;
  port: number;
  server: Server;
  wss: InstanceType<typeof WebSocketServer>;
  /** Every /runner socket the runner has opened, in connection order. */
  connections: import("ws").WebSocket[];
  pingCount(index: number): number;
  waitForConnection(index: number, timeoutMs: number, context: () => string): Promise<import("ws").WebSocket>;
  close(): Promise<void>;
}

// A minimal control plane that answers the attestation probe and upgrades /runner sockets. Crucially
// it runs with autoPong DISABLED, so it receives the runner's ws-level pings but never replies — the
// exact half-open signature (socket readable as OPEN, peer silent) the runner must detect.
export async function startFakeControlPlane(options: {
  pongAfterPingCount?: number;
  protocolVersion?: (connection: number) => number;
  onMessage?: (socket: import("ws").WebSocket, message: { type: string; barrierId?: number; snapshot?: { id: string } }, connection: number) => void;
} = {}): Promise<FakeControlPlane> {
  const port = await reservePort();
  const instanceId = randomUUID();
  const wss = new WebSocketServer({ noServer: true, autoPong: false });
  const connections: import("ws").WebSocket[] = [];
  const pingCounts: number[] = [];
  const waiters = new Map<number, () => void>();
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url && req.url.includes("/runner/attestation/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        service: WOLLIPOG_CONTROL_PLANE_SERVICE,
        instanceId,
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
      pingCounts[index] = 0;
      ws.on("ping", (data) => {
        const count = (pingCounts[index] ?? 0) + 1;
        pingCounts[index] = count;
        if (options.pongAfterPingCount !== undefined && count >= options.pongAfterPingCount) {
          ws.pong(data);
        }
      });
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
            protocolVersion: options.protocolVersion?.(index) ?? PROTOCOL_VERSION,
          }));
        }
        if (message && typeof message === "object" && "type" in message) {
          options.onMessage?.(ws, message as { type: string; barrierId?: number; snapshot?: { id: string } }, index);
        }
      });
      waiters.get(index)?.();
      waiters.delete(index);
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(port, "127.0.0.1", resolvePromise));
  return {
    instanceId,
    port,
    server,
    wss,
    connections,
    pingCount: (index) => pingCounts[index] ?? 0,
    waitForConnection(index, timeoutMs, context) {
      if (connections[index]) return Promise.resolve(connections[index]);
      const arrived = new Promise<import("ws").WebSocket>((resolvePromise) => {
        waiters.set(index, () => resolvePromise(connections[index]!));
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
