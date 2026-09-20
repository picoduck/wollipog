/**
 * Bounded loopback transport between provider-spawned Agent Control adapters and the runner.
 *
 * In provider isolation the adapter cannot hold the control-plane bearer: the provider runs as the
 * runner's OS user and can read every file it can read. The adapter therefore sends one already
 * constructed HTTP round-trip to this session-bound listener. The runner pins the destination and
 * adds its memory-held credential; the wire never carries bearer bytes in either direction.
 */

import { createServer, connect, type Server, type Socket } from "node:net";
import type { McpFetch } from "./session-management-mcp.js";
import { isSafeSessionFileId } from "./session-file-id.js";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_PATH_BYTES = 16 * 1024;
export const AGENT_CONTROL_RELAY_ENDPOINT_ENV = "WOLLIPOG_AGENT_CONTROL_RELAY_ENDPOINT";
export const AGENT_CONTROL_RELAY_KEY_ENV = "WOLLIPOG_AGENT_CONTROL_RELAY_KEY";

export interface AgentControlRelayRequest {
  key: string;
  method: "GET" | "POST";
  path: string;
  contentType?: "application/json";
  body?: string;
}

export interface AgentControlRelayResponse {
  status: number;
  body: string;
}

export type AgentControlRelayHandler = (
  sessionId: string,
  request: AgentControlRelayRequest,
  signal: AbortSignal,
) => Promise<AgentControlRelayResponse>;

function parseRequest(value: unknown): AgentControlRelayRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("relay request is not an object");
  const { key, method, path, contentType, body } = value as Record<string, unknown>;
  if (typeof key !== "string" || key.length < 16 || key.length > 256 ||
      (method !== "GET" && method !== "POST") || typeof path !== "string" ||
      Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES ||
      (contentType !== undefined && contentType !== "application/json") ||
      (body !== undefined && typeof body !== "string")) {
    throw new Error("relay request has an unexpected shape");
  }
  return {
    key,
    method,
    path,
    ...(contentType ? { contentType } : {}),
    ...(typeof body === "string" ? { body } : {}),
  };
}

function parseResponse(value: unknown): AgentControlRelayResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("relay response is not an object");
  const { status, body } = value as Record<string, unknown>;
  if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599 || typeof body !== "string") {
    throw new Error("relay response has an unexpected shape");
  }
  return { status: status as number, body };
}

function endpointPort(endpoint: string): number {
  const parsed = new URL(endpoint);
  const port = Number(parsed.port);
  if (parsed.protocol !== "tcp:" || parsed.hostname !== "127.0.0.1" || parsed.pathname !== "" ||
      parsed.search || parsed.hash || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid Agent Control relay endpoint");
  }
  return port;
}

function relayRoundTrip(
  endpoint: string,
  request: AgentControlRelayRequest,
  signal?: AbortSignal,
): Promise<AgentControlRelayResponse> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let total = 0;
    const chunks: Buffer[] = [];
    const socket = connect({ host: "127.0.0.1", port: endpointPort(endpoint) });
    const finish = (error: Error | null, response?: AgentControlRelayResponse) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", aborted);
      socket.destroy();
      if (error) reject(error);
      else resolvePromise(response!);
    };
    const aborted = () => finish(new Error("Agent Control relay request aborted"));
    if (signal?.aborted) {
      aborted();
      return;
    }
    signal?.addEventListener("abort", aborted, { once: true });
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_FRAME_BYTES) finish(new Error("Agent Control relay response is too large"));
      else chunks.push(chunk);
    });
    socket.on("end", () => {
      try {
        finish(null, parseResponse(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      } catch (error) {
        finish(new Error(`invalid Agent Control relay response: ${(error as Error).message}`));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("Agent Control relay closed without a response")));
  });
}

/** Fetch shape consumed by both the CLI and MCP tool table. Authorization headers are discarded:
 * only the runner may add the session credential. */
export function agentControlRelayFetch(endpoint: string, key: string): McpFetch {
  endpointPort(endpoint);
  return async (url, init) => {
    const parsed = new URL(url);
    const method = init?.method?.toUpperCase() ?? "GET";
    if (method !== "GET" && method !== "POST") throw new Error("Agent Control relay permits only GET and POST");
    const contentType = Object.entries(init?.headers ?? {})
      .find(([name]) => name.toLowerCase() === "content-type")?.[1];
    if (contentType !== undefined && contentType !== "application/json") {
      throw new Error("Agent Control relay permits only JSON request bodies");
    }
    const response = await relayRoundTrip(endpoint, {
      key,
      method,
      path: `${parsed.pathname}${parsed.search}`,
      ...(contentType ? { contentType: "application/json" as const } : {}),
      ...(init?.body !== undefined ? { body: init.body } : {}),
    }, init?.signal);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.body,
    };
  };
}

function serveConnection(socket: Socket, sessionId: string, handler: AgentControlRelayHandler): void {
  const chunks: Buffer[] = [];
  let total = 0;
  let handling = false;
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    if (handling) return;
    total += chunk.length;
    if (total > MAX_FRAME_BYTES) {
      socket.destroy();
      return;
    }
    chunks.push(chunk);
    if (!chunk.includes(0x0a)) return;
    const received = Buffer.concat(chunks);
    const newline = received.indexOf(0x0a);
    if (newline < 0) return;
    handling = true;
    const abort = new AbortController();
    socket.once("close", () => abort.abort());
    let request: AgentControlRelayRequest;
    try {
      request = parseRequest(JSON.parse(received.subarray(0, newline).toString("utf8")));
    } catch {
      socket.destroy();
      return;
    }
    handler(sessionId, request, abort.signal).then(
      (response) => {
        const frame = JSON.stringify(response);
        if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) socket.destroy();
        else if (!socket.destroyed) socket.end(frame);
      },
      () => socket.destroy(),
    );
  });
}

/** One random loopback port per live session. The relay key authenticates the provider process
 * tree; the endpoint itself grants no control-plane authority. */
export class AgentControlRelaySockets {
  private readonly servers = new Map<string, { server: Server; endpoint: string; sockets: Set<Socket> }>();
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly handler: AgentControlRelayHandler) {}

  private serialized<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(sessionId) ?? Promise.resolve()).then(operation, operation);
    const settled = next.then(() => undefined, () => undefined);
    this.pending.set(sessionId, settled);
    void settled.then(() => { if (this.pending.get(sessionId) === settled) this.pending.delete(sessionId); });
    return next;
  }

  ensure(sessionId: string): Promise<string> {
    return this.serialized(sessionId, async () => {
      if (!isSafeSessionFileId(sessionId)) throw new Error("unsafe session id for the Agent Control relay");
      const existing = this.servers.get(sessionId);
      if (existing?.server.listening) return existing.endpoint;
      await this.closeNow(sessionId);
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        serveConnection(socket, sessionId, this.handler);
      });
      await new Promise<void>((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
          server.off("error", reject);
          resolvePromise();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
        throw new Error("Agent Control relay did not bind a loopback port");
      }
      const endpoint = `tcp://127.0.0.1:${address.port}`;
      server.on("error", () => { /* Per-connection errors do not surrender the listener. */ });
      this.servers.set(sessionId, { server, endpoint, sockets });
      return endpoint;
    });
  }

  close(sessionId: string): Promise<void> {
    return this.serialized(sessionId, () => this.closeNow(sessionId));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((sessionId) => this.close(sessionId)));
  }

  private async closeNow(sessionId: string): Promise<void> {
    const entry = this.servers.get(sessionId);
    this.servers.delete(sessionId);
    if (!entry) return;
    for (const socket of entry.sockets) socket.destroy();
    await new Promise<void>((resolvePromise) => entry.server.close(() => resolvePromise()));
  }
}
