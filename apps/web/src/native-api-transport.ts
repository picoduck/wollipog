import { invoke } from "@tauri-apps/api/core";
import type { ApiTransport } from "./api-transport.js";
import { decodeNativeHttpResponse, encodeNativeHttpRequest } from "./native-ipc-codec.js";

export interface NativeInvokeRuntime {
  invoke<T>(command: string, args?: Record<string, unknown> | Uint8Array): Promise<T>;
}

const runtime: NativeInvokeRuntime = { invoke };
const encoder = new TextEncoder();
export const NATIVE_API_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"] as const);

async function requestBody(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body == null) return new Uint8Array();
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new TypeError("The native transport supports string, binary, and Blob request bodies.");
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

export interface NativeApiTransportOptions {
  instanceId: string;
  runtimeKey: string;
  publicOrigin: string;
  desktop?: NativeInvokeRuntime;
}

export function createNativeApiTransport(options: NativeApiTransportOptions): ApiTransport {
  const desktop = options.desktop ?? runtime;
  const lifetime = new AbortController();
  let closed = false;
  let nextRequest = 0;

  return {
    instanceId: options.instanceId,
    publicOrigin: options.publicOrigin,
    async request(path, init = {}) {
      if (closed) throw abortError("The instance connection is closed.");
      if (init.signal?.aborted) throw abortError("The remote request was cancelled.");
      const body = await requestBody(init.body);
      if (closed || init.signal?.aborted) throw abortError("The remote request was cancelled.");
      const headers = new Headers(init.headers);
      const method = (init.method ?? "GET").toUpperCase();
      if (!NATIVE_API_METHODS.has(method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE")) {
        throw new TypeError("The native transport does not support this HTTP method.");
      }
      const allowedHeaders: Array<[string, string]> = [];
      headers.forEach((value, name) => {
        const lower = name.toLowerCase();
        if (lower === "content-type" || lower === "accept") allowedHeaders.push([lower, value]);
      });
      const requestId = `request-${++nextRequest}`;
      const frame = encodeNativeHttpRequest({
        runtimeKey: options.runtimeKey,
        requestId,
        method,
        path,
        headers: allowedHeaders,
      }, body);
      const native = desktop.invoke<ArrayBuffer | Uint8Array | number[]>("remote_http_request", frame);
      let rejectAbort!: (reason?: unknown) => void;
      const abort = () => {
        void desktop.invoke("remote_http_cancel", {
          runtimeKey: options.runtimeKey,
          requestId,
        }).catch(() => {});
        rejectAbort(abortError("The remote request was cancelled."));
      };
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = reject;
        lifetime.signal.addEventListener("abort", abort, { once: true });
        init.signal?.addEventListener("abort", abort, { once: true });
        if (lifetime.signal.aborted || init.signal?.aborted) abort();
      });
      let raw: ArrayBuffer | Uint8Array | number[];
      try {
        raw = await Promise.race([native, cancelled]);
      } finally {
        lifetime.signal.removeEventListener("abort", abort);
        init.signal?.removeEventListener("abort", abort);
      }
      if (closed || init.signal?.aborted) throw abortError("The remote request was cancelled.");
      const { meta, body: responseBody } = decodeNativeHttpResponse(raw);
      const noBody = meta.status === 204 || meta.status === 205 || meta.status === 304;
      const responseBuffer = responseBody.buffer.slice(
        responseBody.byteOffset,
        responseBody.byteOffset + responseBody.byteLength,
      ) as ArrayBuffer;
      return new Response(noBody ? null : responseBuffer, {
        status: meta.status,
        statusText: meta.statusText,
        headers: meta.headers,
      });
    },
    close() {
      if (closed) return;
      closed = true;
      lifetime.abort();
      void desktop.invoke("remote_transport_close", { runtimeKey: options.runtimeKey }).catch(() => {});
    },
  };
}
