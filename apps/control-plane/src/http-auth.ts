/**
 * The request gate for the UI-facing surface, extracted from index.ts so it can be exercised by
 * `app.inject` against REAL Fastify routing (the round-1 P0 was a routing/percent-encoding
 * interaction — a pure-string unit test would never have caught it, and index.ts opens the DB
 * and starts the SSH orchestrator at import, so it can't be injected directly).
 *
 * Two boundaries, in order:
 *  1. **Device auth** for every `/api/*` + `/ui` client. Keys off `req.routeOptions.url` — the
 *     MATCHED ROUTE PATTERN, never the raw URL: Fastify routes `/%61pi/x` to the `/api/x`
 *     handler after percent-decoding, so a raw `startsWith("/api/")` check would skip auth.
 *  2. **Server-side Origin check** for `/api/*`. `@fastify/cors` only withholds *readable*
 *     response headers; it does not block a cross-origin `no-cors` POST from reaching the
 *     handler. A present-but-disallowed Origin is rejected unless the caller supplied a valid
 *     device token (possession beats Origin — a paired device is not a CSRF vector).
 *
 * Static serving relies on an invariant this gate depends on: every sensitive route is an
 * EXPLICIT `/api/...` route, and Fastify prefers explicit routes over the static plugin's
 * wildcard — so a wildcard match (`routeOptions.url === "/*"`) can only ever be a public asset.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { requiresDeviceAuth } from "./auth.js";
import type { AuthPrincipal } from "./identity.js";

export interface AuthedDevice {
  id: string;
  name: string;
  principal?: AuthPrincipal;
}

export interface AuthGateDeps {
  /** Resolve the device a request authenticates as. `allowQueryToken` is true only for `/ui`
   * (browsers cannot set headers on a WebSocket upgrade). */
  authenticate: (req: FastifyRequest, allowQueryToken?: boolean) => AuthedDevice | null;
  /** Optional organization-role authorization layered after authentication/origin checks. */
  authorize?: (req: FastifyRequest, principal: AuthedDevice | null) =>
    string | { statusCode: number; error: string } | null;
  /** Browser-origin policy shared with the CORS config and the `/ui` upgrade. */
  isAllowedOrigin: (origin: string | undefined | null) => boolean;
}

export const UNAUTHORIZED = "unauthorized — open the startup pairing URL or pair this device from an authenticated local dashboard";
export const CROSS_ORIGIN_BLOCKED = "cross-origin request blocked";
export const FORBIDDEN = "forbidden";

/**
 * The methods the CORS preflight advertises, stated here rather than inherited from
 * `@fastify/cors`. Its v10 default is exactly this list, but v11 narrows the default to the
 * CORS-safelisted methods (GET, HEAD, POST). Inheriting that default would silently stop browsers
 * from issuing the PUT/PATCH/DELETE requests this API serves — cross-origin in development, where
 * the app is on :5173 and the control plane on :4317 — and nothing in the build, typecheck, or
 * unit suite exercises a real preflight, so there would be no failure to signal it. Writing the
 * policy down makes that upgrade a no-op.
 *
 * This is not a widening: it is the set v10 already permits. CORS is also not what protects these
 * routes — see the Origin gate in (2) above — so inheriting the narrower default would buy no
 * security, only breakage.
 */
export const CORS_METHODS = ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"] as const;

/** True for the API surface, given a matched route pattern. */
export function isApiRoute(routePath: string): boolean {
  return routePath === "/api" || routePath.startsWith("/api/");
}

/** The one unauthenticated API route. It still requires its own share capability in-handler. */
export function isPublicTranscriptShareRead(method: string, routePath: string): boolean {
  return method === "GET" && routePath === "/api/public/transcript-share";
}

/** Service workers acknowledge an encrypted push through a high-entropy per-delivery capability. */
export function isPublicPushReceiptAck(method: string, routePath: string): boolean {
  return method === "POST" && routePath === "/api/public/push-receipt";
}

export function registerAuthGate(app: FastifyInstance, deps: AuthGateDeps): void {
  app.addHook("onRequest", async (req, reply) => {
    const routePath = req.routeOptions?.url ?? req.url.split("?")[0] ?? "";
    if (requiresDeviceAuth(routePath) && !isPublicTranscriptShareRead(req.method, routePath) &&
        !isPublicPushReceiptAck(req.method, routePath)) {
      if (routePath === "/ui") return; // authenticated inside the /ui upgrade handler
      const principal = deps.authenticate(req);
      if (!principal) return reply.code(401).send({ error: UNAUTHORIZED });
      return; // token-authed non-loopback API call: Origin is moot (possession beats Origin)
    }

    // Independently protect the capability-authenticated public transcript route from a foreign
    // browser Origin. The push-receipt route is different: its HMAC is scoped to one delivery,
    // its response is non-oracular, and a service worker legitimately posts through a same-origin
    // reverse-proxy hostname (for example Tailscale Serve) that is not in the loopback allowlist.
    // Device-authenticated API calls returned above: possession beats Origin.
    if (isApiRoute(routePath) && !isPublicPushReceiptAck(req.method, routePath)) {
      const origin = req.headers.origin;
      if (origin && !deps.isAllowedOrigin(origin) && !deps.authenticate(req)) {
        return reply.code(403).send({ error: CROSS_ORIGIN_BLOCKED });
      }
    }
  });
  app.addHook("preHandler", async (req, reply) => {
    if (!deps.authorize) return;
    const routePath = req.routeOptions?.url ?? req.url.split("?")[0] ?? "";
    const presented = deps.authenticate(req);
    const denial = deps.authorize(req, presented);
    if (typeof denial === "string") return reply.code(403).send({ error: denial || FORBIDDEN });
    if (denial) return reply.code(denial.statusCode).send({ error: denial.error });
  });
}
