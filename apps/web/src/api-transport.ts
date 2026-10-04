import apiRequestBudgets from "./api-request-budgets.json";

export interface ApiTransport {
  readonly instanceId: string;
  readonly publicOrigin: string;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): void;
}

/** The native transport reported a retryable request failure before an HTTP response. */
export class TransportRequestError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "TransportRequestError";
  }
}

/**
 * A request passed its client deadline without a response (#2522). Deliberately not an
 * `AbortError`: callers that treat an abort as a quiet cancellation must still show this as a
 * failure. The server may still apply a timed-out mutation, so treat it as "not known to be saved"
 * and reconcile by reloading, never as "not applied".
 */
export class RequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`The Wollipog server didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`);
    this.name = "TimeoutError";
  }
}

/**
 * Client deadlines for browser API requests, all in one place (#2522). A request that reaches its
 * deadline rejects with `RequestTimeoutError` instead of staying pending until the page reloads.
 *
 * The default follows the desktop transport's budgets (apps/desktop/src-tauri/src/remote_transport.rs:
 * 5s connect, 20s read, 60s total): it stays within that 60s total, and it outlasts the server-side
 * deadlines it wraps, such as the runner's 30s `GIT_TIMEOUT_MS` behind `/api/sessions/:id/git` and
 * the control plane's 30s default runner wait, so the client never gives up first on an operation
 * the server is still bounding.
 */
export const API_REQUEST_DEADLINE_MS = 45_000;

/**
 * Session retitle waits on the session-naming deadline chain (packages/protocol/src/index.ts), up to
 * 33s with a custom endpoint. It gets 60s, the desktop's retitle budget too, so a slow title is never
 * cut off by the default.
 */
export const SESSION_RETITLE_DEADLINE_MS = 60_000;

export type ApiRequestBudget =
  "sessionRetitle" | "serverBoundUpTo60s" | "serverBoundUpTo150s" | "unboundedServerWait" | "unboundedDownload";

/**
 * Deadlines for the budgets in api-request-budgets.json, the route table this transport shares with
 * the desktop's (#2577). `null` opts out: the request keeps only its caller's signal and the instance
 * connection's. Every other value is the server's bound plus a margin.
 */
const API_REQUEST_BUDGET_DEADLINES_MS: Readonly<Record<ApiRequestBudget, number | null>> = {
  sessionRetitle: SESSION_RETITLE_DEADLINE_MS,
  // Server bounds of at most 60s and 150s, each plus a 30s margin.
  serverBoundUpTo60s: 90_000,
  serverBoundUpTo150s: 180_000,
  unboundedServerWait: null,
  unboundedDownload: null,
};

/**
 * The slowest upload the deadline allows for: a request body adds its size at this rate, because the
 * body is sent before any response can arrive. 64 KiB/s keeps an 8 MB prompt image (+128s) uploading
 * on a poor phone connection, while a JSON body under 64 KiB adds nothing.
 */
export const API_UPLOAD_FLOOR_BYTES_PER_SECOND = 64 * 1024;

/** One request that legitimately outlasts the default, read from api-request-budgets.json. */
interface ApiRequestBudgetRoute {
  method: string;
  route: RegExp;
  /** Narrows the entry to requests without this query parameter. */
  unlessQuery?: string;
  deadlineMs: number | null;
}

/**
 * The shared table, checked as it loads so a budget this transport cannot map fails at once rather
 * than turning into a `NaN` deadline.
 */
export function apiRequestBudgetRoutes(
  table: { routes: ReadonlyArray<{ method: string; route: string; unlessQuery?: string; budget: string }> },
): ApiRequestBudgetRoute[] {
  return table.routes.map((entry) => {
    if (!Object.hasOwn(API_REQUEST_BUDGET_DEADLINES_MS, entry.budget)) {
      throw new TypeError(`Unknown API request budget ${JSON.stringify(entry.budget)}.`);
    }
    return {
      method: entry.method,
      route: new RegExp(`^${entry.route.replaceAll(":id", "[^/]+")}$`),
      ...(entry.unlessQuery === undefined ? {} : { unlessQuery: entry.unlessQuery }),
      deadlineMs: API_REQUEST_BUDGET_DEADLINES_MS[entry.budget as ApiRequestBudget],
    };
  });
}

const API_REQUEST_DEADLINE_OVERRIDES = apiRequestBudgetRoutes(apiRequestBudgets);

/** The UTF-8 bytes fetch sends for `text`, counted without encoding it. */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit < 0xdc00 && index + 1 < text.length &&
      (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      // A surrogate pair is one four-byte code point.
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** The bytes a request body sends, or `null` when its size cannot be known in advance. */
function requestBodyBytes(body: BodyInit | null | undefined): number | null {
  if (body === undefined || body === null) return 0;
  if (typeof body === "string") return utf8ByteLength(body);
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof URLSearchParams) return utf8ByteLength(body.toString());
  return null;
}

/**
 * The deadline for one request, or `null` for none: its route's deadline, extended for its body at
 * `API_UPLOAD_FLOOR_BYTES_PER_SECOND`. A body of unknown size (a stream or form data) opts out.
 */
export function apiRequestDeadlineMs(method: string, path: string, body?: BodyInit | null): number | null {
  const [pathname, search = ""] = path.split("?", 2) as [string, string?];
  const query = new URLSearchParams(search);
  const verb = method.toUpperCase();
  const override = API_REQUEST_DEADLINE_OVERRIDES.find((entry) =>
    entry.method === verb && entry.route.test(pathname) &&
    (entry.unlessQuery === undefined || !query.has(entry.unlessQuery)));
  const deadlineMs = override ? override.deadlineMs : API_REQUEST_DEADLINE_MS;
  const bytes = requestBodyBytes(body);
  if (deadlineMs === null || bytes === null) return null;
  // Whole seconds, so a body under 64 KiB keeps the route's exact deadline.
  return deadlineMs + Math.floor(bytes / API_UPLOAD_FLOOR_BYTES_PER_SECOND) * 1000;
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

      // The deadline rejects on its own as well as aborting, so a fetch that ignores its signal
      // still fails on time. It rejects before aborting: a fetch that answers its abort with a
      // fresh AbortError must not win the race and pass the timeout off as a cancellation. It runs
      // until the response arrives, like the abort listeners above.
      const deadlineMs = apiRequestDeadlineMs(init.method ?? "GET", path, init.body);
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = deadlineMs === null ? null : new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimeout(() => {
          const timeout = new RequestTimeoutError(deadlineMs);
          reject(timeout);
          requestAbort.abort(timeout);
        }, deadlineMs);
      });

      try {
        const response = (fetchImpl ?? globalThis.fetch)(apiUrl(origin, path), {
          ...init,
          headers: requestHeaders,
          signal: requestAbort.signal,
        });
        return await (deadline ? Promise.race([response, deadline]) : response);
      } finally {
        clearTimeout(deadlineTimer);
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
