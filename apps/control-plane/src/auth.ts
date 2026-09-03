/**
 * Per-device bearer auth for the UI-facing surface (REST + /ui socket).
 *
 * Threat model: the control plane historically bound to loopback and relied on that plus a
 * localhost-only Origin gate. Binding beyond loopback (LAN, Tailscale) exposes every mutating
 * route, so every caller must present a device token. The local dashboard uses a protected
 * startup credential; other clients use tokens minted from an authenticated local dashboard.
 * /runner keeps its own registration token.
 *
 * Tokens are stored HASHED (sha256) — a leaked DB doesn't leak live credentials. The plaintext
 * is shown exactly once at pairing time.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256-bit URL-safe token; rides in an Authorization header or a WS `?token=` param. */
export function newDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenMatchesHash(token: string, expectedHash: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(expectedHash)) return false;
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Which requests must present a device token, given the CANONICAL route path (the Fastify
 * matched-route pattern, e.g. `/api/sessions/:id/stop`, NOT the raw request URL). Feeding the
 * raw URL here would be exploitable: Fastify routes `/%61pi/sessions` to the `/api/...` handler
 * after percent-decoding, but a raw-string `startsWith("/api/")` check would see `/%61pi/` and
 * skip auth. Always pass req.routeOptions.url (see index.ts).
 *
 * /runner authenticates with its own registration token; /healthz stays open (the desktop shell
 * probes it before any pairing exists). Everything else that matters is
 * /api/* and the /ui socket. Non-API paths (the static app shell, when served) must load BEFORE
 * a device can present a token — the pairing token travels in the URL fragment, never sent to
 * the server.
 */
export function requiresDeviceAuth(routePath: string): boolean {
  if (routePath === "/runner" || routePath === "/healthz") return false;
  return routePath === "/ui" || routePath === "/api" || routePath.startsWith("/api/");
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function extractBearer(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1]!.trim() : null;
}

/** Authenticate the manager MCP sidecar without turning a runner credential into a general REST
 * credential. The active token must belong to the runner hosting the exact actively executing
 * conductor session; idle, terminal, worker, and fabricated claims fail closed. */
export function isAuthenticatedConductorClaim(input: {
  credentialValid: boolean;
  claimedSessionId: unknown;
  session: { id: string; agentId: string | null; status: string } | null | undefined;
}): boolean {
  return input.credentialValid &&
    typeof input.claimedSessionId === "string" &&
    input.claimedSessionId.length > 0 &&
    input.claimedSessionId.length <= 256 &&
    input.session?.id === input.claimedSessionId &&
    input.session.agentId === "conductor" &&
    ["starting", "running", "input_required"].includes(input.session.status);
}

/** Authenticate a runner-minted exact-session credential used by the general CLI/MCP surface. */
export function isAuthenticatedAgentControlClaim(input: {
  credentialValid: boolean;
  claimedSessionId: unknown;
  session: { id: string; status: string } | null | undefined;
}): boolean {
  return input.credentialValid &&
    typeof input.claimedSessionId === "string" &&
    input.claimedSessionId.length > 0 &&
    input.claimedSessionId.length <= 256 &&
    input.session?.id === input.claimedSessionId &&
    ["starting", "running", "input_required"].includes(input.session.status);
}

/** Authenticate one hook sidecar with a credential independently bound to its live Claude session. */
export function isAuthenticatedPolicyHookClaim(input: {
  credentialValid: boolean;
  claimedSessionId: unknown;
  session: { id: string; driver: string; status: string } | null | undefined;
}): boolean {
  return input.credentialValid &&
    typeof input.claimedSessionId === "string" &&
    input.claimedSessionId.length > 0 &&
    input.claimedSessionId.length <= 256 &&
    input.session?.id === input.claimedSessionId &&
    input.session.driver === "claude-code" &&
    ["idle", "starting", "running", "input_required"].includes(input.session.status);
}

export function isPolicyHookApiRouteAllowed(method: string, routePath: string): boolean {
  return method.toUpperCase() === "POST" && routePath === "/api/sessions/:id/policy-hook";
}

/**
 * Exact HTTP surface the manager conductor may reach with the runner/control-plane token.
 *
 * The conductor sidecar needs enough read/write access to inspect the fabric and operate the
 * workflow tools it exposes, but a runner registration secret must never become a
 * device-equivalent credential. Match Fastify's canonical route pattern (not the raw URL) and
 * the HTTP method so a newly-added API is denied until it is deliberately added here.
 */
const CONDUCTOR_API_ROUTES = new Set([
  "GET /api/runners",
  "GET /api/sessions",
  "GET /api/sessions/:id",
  "GET /api/sessions/:id/events",
  "POST /api/sessions",
  "POST /api/sessions/:id/config",
  "POST /api/sessions/:id/prompt",
  "POST /api/sessions/:id/stop",
  "GET /api/runs",
  "POST /api/runs",
  "GET /api/governance/policies",
  "PUT /api/governance/policies/:policyId",
  "DELETE /api/governance/policies/:policyId",
  "GET /api/workflows",
  "POST /api/workflows",
  "GET /api/workflows/:workflowId",
  "POST /api/workflows/:workflowId/versions",
  "POST /api/workflow-runs",
  "GET /api/workflow-instances",
  "GET /api/workflow-instances/:instanceId",
  "POST /api/workflow-instances/:instanceId/nodes/:nodeId/dispatch",
  "POST /api/workflow-instances/:instanceId/nodes/:nodeId/resolve",
  "POST /api/workflow-attempts/:attemptId/complete",
  "POST /api/artifacts",
  "POST /api/artifacts/screenshots",
]);

export function isConductorApiRouteAllowed(method: string, routePath: string): boolean {
  return CONDUCTOR_API_ROUTES.has(`${method.toUpperCase()} ${routePath}`);
}

/** The general surface deliberately reuses the reviewed manager allowlist. Worktree additions are
 * made once here when #583 lands, so the CLI and MCP server cannot diverge. */
export function isAgentControlApiRouteAllowed(method: string, routePath: string): boolean {
  return isConductorApiRouteAllowed(method, routePath);
}

/**
 * Proxy/client-IP headers whose presence means a request reached us through some fronting layer
 * (nginx, `tailscale serve`, cloudflared, a CDN). We trust NO proxy, so any of these means the
 * socket peer IP (`req.ip`) is the proxy's, not the client's — it can't be used as a loopback
 * signal. Broad on purpose: a missed header would let a fronted request present the local startup
 * credential. Direct connections carry none of these, so authenticated local bootstrap still works.
 */
export const PROXY_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "x-client-ip",
] as const;

/**
 * A same-host reverse proxy forwarding to 127.0.0.1 makes every remote client look loopback to us.
 * Treat a request carrying any proxy header as untrusted for the local startup credential. The
 * request may still authenticate with an ordinary paired-device token.
 *
 * A bare `proxy_pass` that sets no forwarding header is indistinguishable from a direct local
 * client, so the local credential file must remain unreadable to proxy users and tenants.
 */
export function isTrustedLoopback(
  ip: string | undefined | null,
  headers: Record<string, unknown>,
  loopbackFn: (ip: string | undefined | null) => boolean,
): boolean {
  if (!loopbackFn(ip)) return false;
  return !PROXY_HEADERS.some((h) => headers[h]);
}

/** Update last_seen at most once a minute — auth runs on every request, and a busy dashboard
 * would otherwise turn each poll into a write. */
export function shouldTouchDevice(lastSeenAt: number | null, now: number): boolean {
  return lastSeenAt === null || now - lastSeenAt > 60_000;
}

/** The query portion of a URL (between `?` and any `#`), or "". */
function queryOf(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return "";
  const after = url.slice(q + 1);
  const h = after.indexOf("#");
  return h === -1 ? after : after.slice(0, h);
}

/**
 * Does a query-parameter KEY denote the device token? Compared AFTER percent-decoding and
 * case-insensitively, so detection matches what `/ui` auth actually accepts: that path reads the
 * token with `URLSearchParams`, which decodes keys — so `to%6ben=` authenticates as `token=`. A
 * raw-substring check would let such a spelling authenticate while escaping the leak guards.
 */
function isTokenKey(rawKey: string): boolean {
  let key = rawKey;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    /* malformed escape — compare the raw form */
  }
  return key.toLowerCase() === "token";
}

/** True if the URL carries a device-token query param in any spelling `URLSearchParams` accepts
 * (`token=`, `to%6ben=`, `TOKEN=`). The `/ui` socket authenticates from this param, so a shell
 * navigation or a log line must treat every such spelling as sensitive. */
export function carriesTokenParam(url: string): boolean {
  const q = queryOf(url);
  return q !== "" && q.split("&").some((pair) => isTokenKey(pair.split("=", 1)[0] ?? ""));
}

/**
 * Redact every device-token query value before a URL is logged. Matches keys the decode-aware way
 * (so `to%6ben=<secret>` is caught, not just literal `token=`), preserves the original key
 * spelling, and leaves any fragment untouched. Used by the request-log serializer AND the
 * not-found handler (whose default log emits the raw URL).
 */
export function redactTokenInUrl(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const head = url.slice(0, q);
  const after = url.slice(q + 1);
  const h = after.indexOf("#");
  const query = h === -1 ? after : after.slice(0, h);
  const frag = h === -1 ? "" : after.slice(h);
  const redacted = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      const key = eq === -1 ? pair : pair.slice(0, eq);
      return isTokenKey(key) ? `${key}=<redacted>` : pair;
    })
    .join("&");
  return `${head}?${redacted}${frag}`;
}
