/**
 * Minimal JSON-RPC 2.0 peer over a pair of streams (a child process's stdio).
 * ACP uses newline-delimited JSON-RPC, which is what this implements: one JSON
 * object per line. Supports outgoing requests/notifications and incoming
 * requests (the agent calls back into us, e.g. session/request_permission) and
 * notifications (session/update).
 */

import type { Readable, Writable } from "node:stream";
import { BoundedNdjsonBuffer } from "./bounded-ndjson.js";

type Params = unknown;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
  /** Local-only marker: this error was synthesized by the Wollipog transport, not returned by an agent. */
  transportFailure?: true;
  /** Local-only marker: this request exhausted its caller-supplied deadline. */
  requestTimeout?: true;
}

export type RequestHandler = (params: Params, requestId: number | string) => Promise<unknown> | unknown;
export type NotificationHandler = (params: Params) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: RpcError) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Params;
  result?: unknown;
  error?: RpcError;
}

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly input: BoundedNdjsonBuffer;
  private closed = false;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly onTransportError?: (err: Error) => void,
    maxLineBytes?: number,
  ) {
    this.input = new BoundedNdjsonBuffer(
      (line) => this.processLine(line),
      () => this.onTransportError?.(new Error("discarded oversized JSON-RPC stdout record")),
      maxLineBytes,
    );
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => this.input.push(chunk));
    // A write after the child closes stdin emits an async 'error' (EPIPE) on the
    // stream; without a listener Node would crash the runner. Route it instead.
    stdin.on("error", (err: Error) => {
      this.failTransport(err);
    });
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  request<T = unknown>(method: string, params?: Params): Promise<T> {
    return this.requestInternal<T>(method, params);
  }

  /** Send a request that is removed from the pending map if its absolute deadline expires. */
  requestWithDeadline<T = unknown>(method: string, params: Params, deadlineAt: number): Promise<T> {
    return this.requestInternal<T>(method, params, deadlineAt);
  }

  private requestInternal<T>(method: string, params?: Params, deadlineAt?: number): Promise<T> {
    // Reject immediately if the transport is gone — otherwise the pending promise
    // would be stored and never settle (write() silently no-ops when closed).
    if (this.closed) {
      return Promise.reject<T>({
        code: -32000,
        message: `connection closed (cannot call ${method})`,
        transportFailure: true,
      });
    }
    if (deadlineAt !== undefined && (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now())) {
      return Promise.reject<T>({
        code: -32002,
        message: `request deadline exceeded (cannot call ${method})`,
        requestTimeout: true,
      });
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (deadlineAt !== undefined) {
        const remainingMs = Math.max(0, deadlineAt - Date.now());
        pending.timer = setTimeout(() => {
          if (this.pending.get(id) !== pending) return;
          this.pending.delete(id);
          reject({
            code: -32002,
            message: `request deadline exceeded (${method})`,
            requestTimeout: true,
          });
        }, Math.min(remainingMs, 2_147_483_647));
      }
      this.pending.set(id, pending);
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: Params): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Reject all in-flight requests (e.g. the process died). */
  dispose(reason: string): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject({ code: -32000, message: reason, transportFailure: true });
    }
    this.pending.clear();
  }

  private write(obj: RpcMessage): void {
    if (this.closed) return;
    try {
      this.stdin.write(JSON.stringify(obj) + "\n");
    } catch (err) {
      this.failTransport(err as Error);
    }
  }

  /** A broken writable invalidates every outstanding request, not just the next one. Without
   * this, an async EPIPE leaves initialize/read/resume promises parked forever. */
  private failTransport(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    const rpcError: RpcError = {
      code: -32000,
      message: `transport failed: ${err.message}`,
      transportFailure: true,
    };
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(rpcError);
    }
    this.pending.clear();
    this.onTransportError?.(err);
  }

  private processLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      return; // skip non-JSON noise (some agents print logs to stdout)
    }
    this.dispatch(msg);
  }

  private dispatch(msg: RpcMessage): void {
    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) pending.reject(msg.error);
      else pending.resolve(msg.result);
      return;
    }

    // Incoming request (needs a response).
    if (msg.method && msg.id !== undefined) {
      const handler = this.requestHandlers.get(msg.method);
      const reqId = msg.id;
      if (!handler) {
        this.write({ jsonrpc: "2.0", id: reqId, error: { code: -32601, message: "method not found" } });
        return;
      }
      Promise.resolve()
        .then(() => handler(msg.params, reqId))
        .then((result) => this.write({ jsonrpc: "2.0", id: reqId, result: result ?? null }))
        .catch((err) =>
          this.write({
            jsonrpc: "2.0",
            id: reqId,
            error: { code: -32000, message: err?.message ?? String(err) },
          }),
        );
      return;
    }

    // Incoming notification.
    if (msg.method) {
      const handler = this.notificationHandlers.get(msg.method);
      // Preserve wire ordering relative to request continuations even when several NDJSON frames
      // arrive in one stream chunk. A notification before a response queues first; one after the
      // response queues after the promise continuation that establishes the response boundary.
      if (handler) queueMicrotask(() => handler(msg.params));
    }
  }
}
