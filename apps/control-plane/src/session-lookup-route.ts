import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthPrincipal } from "./identity.js";
import type { ControlPlaneDb } from "./db.js";

export function registerSessionLookupRoute(
  app: FastifyInstance,
  deps: {
    db: Pick<ControlPlaneDb, "canAccessSession" | "getSession">;
    requestPrincipal: (req: FastifyRequest) => AuthPrincipal | null;
  },
): void {
  // Opaque ids may legally be ".", "..", or contain slash-plus-dot segments. A path parameter is
  // normalized before it reaches this handler, so direct-link hydration uses a bounded query value
  // and repeats the normal fail-closed authorization check explicitly.
  app.get("/api/sessions/lookup/by-id", async (req, reply) => {
    const id = (req.query as { id?: unknown }).id;
    if (typeof id !== "string" || !id.trim() || id.length > 256) {
      return reply.code(400).send({ error: "id must be one nonblank string of at most 256 characters" });
    }
    const principal = deps.requestPrincipal(req);
    if (!principal || !deps.db.canAccessSession(principal, id)) {
      return reply.code(404).send({ error: "session not found" });
    }
    const session = deps.db.getSession(id);
    return session ? { session } : reply.code(404).send({ error: "session not found" });
  });
}
