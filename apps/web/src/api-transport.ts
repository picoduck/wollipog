export interface ApiTransport {
  readonly instanceId: string;
  readonly publicOrigin: string;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): void;
}

export interface BrowserApiTransportOptions {
  instanceId: string;
  origin: string;
  token?: () => string | null;
  fetch?: typeof globalThis.fetch;
}

function canonicalOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("The control-plane origin must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      value.includes("?") || value.includes("#")) {
    throw new TypeError("The control-plane origin must not include credentials, a path, query, or fragment.");
  }
  return url.origin;
}

function apiUrl(origin: string, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("API paths must be absolute paths on the selected control plane.");
  }
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new TypeError("API paths cannot select another origin.");
  return url.href;
}

/**
 * A connection-scoped browser transport. Its origin is immutable and every request receives a
 * child abort signal, so closing an instance runtime cannot leave old work publishing into the
 * next instance.
 */
export function createBrowserApiTransport(options: BrowserApiTransportOptions): ApiTransport {
  const origin = canonicalOrigin(options.origin);
  const fetchImpl = options.fetch;
  const lifetime = new AbortController();
  let closed = false;

  return {
    instanceId: options.instanceId,
    publicOrigin: origin,
    async request(path, init = {}) {
      if (closed) throw new DOMException("The instance connection is closed.", "AbortError");
      const requestAbort = new AbortController();
      const abort = () => requestAbort.abort(lifetime.signal.reason);
      lifetime.signal.addEventListener("abort", abort, { once: true });
      const callerAbort = () => requestAbort.abort(init.signal?.reason);
      init.signal?.addEventListener("abort", callerAbort, { once: true });
      if (init.signal?.aborted) callerAbort();

      const headers = new Headers(init.headers);
      const token = options.token?.();
      if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
      const requestHeaders: Record<string, string> = {};
      headers.forEach((value, name) => { requestHeaders[name] = value; });

      try {
        return await (fetchImpl ?? globalThis.fetch)(apiUrl(origin, path), {
          ...init,
          headers: requestHeaders,
          signal: requestAbort.signal,
        });
      } finally {
        lifetime.signal.removeEventListener("abort", abort);
        init.signal?.removeEventListener("abort", callerAbort);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      lifetime.abort(new DOMException("The instance connection was replaced.", "AbortError"));
    },
  };
}
