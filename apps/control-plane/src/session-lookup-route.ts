import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthPrincipal } from "./identity.js";
import type { ControlPlaneDb } from "./db.js";
import type { SessionView } from "@wollipog/protocol";
import { withSessionCommandPermissions } from "./session-command-permissions.js";
import type { OwnerManagementResult } from "./owner-management.js";

type LookupDb = Pick<ControlPlaneDb, "canAccessSession" | "getSession" | "isSessionOwner" | "isSessionDescendant" | "sessionHoldRecords">;

/** Shared opaque-id read. Validate the query before authentication just as the owner API does. */
export function lookupSessionById(db: LookupDb, principal: AuthPrincipal | null, id: unknown,
  withQueue?: (session: SessionView) => SessionView): OwnerManagementResult {
  if (typeof id !== "string" || !id.trim() || id.length > 256) return {status: 400, body: {error: "id must be one nonblank string of at most 256 characters"}};
  if (!principal || !db.canAccessSession(principal, id)) return {status: 404, body: {error: "session not found"}};
  const session = db.getSession(id);
  return session ? {status: 200, body: {session: withSessionCommandPermissions(db, principal, withQueue?.(session) ?? session)}}
    : {status: 404, body: {error: "session not found"}};
}

export function registerSessionLookupRoute(
  app: FastifyInstance,
  deps: {
    db: Pick<ControlPlaneDb, "canAccessSession" | "getSession" | "isSessionOwner" | "isSessionDescendant" |
      "sessionHoldRecords">;
    requestPrincipal: (req: FastifyRequest) => AuthPrincipal | null;
    withQueue?: (session: SessionView) => SessionView;
  },
): void {
  // Opaque ids may legally be ".", "..", or contain slash-plus-dot segments. A path parameter is
  // normalized before it reaches this handler, so direct-link hydration uses a bounded query value
  // and repeats the normal fail-closed authorization check explicitly.
  app.get("/api/sessions/lookup/by-id", async (req, reply) => {
    const id = (req.query as { id?: unknown }).id;
    const principal = deps.requestPrincipal(req);
    const result = lookupSessionById(deps.db, principal, id, deps.withQueue);
    return reply.code(result.status).send(result.body);
  });
}
