import type { FastifyInstance, FastifyRequest } from "fastify";
import { AGENT_UNARCHIVE_ERROR, type AuthPrincipal } from "./identity.js";
import type { ControlPlaneDb } from "./db.js";
import type { SessionsService } from "./sessions.js";
import { failureBody } from "./capability-refusal.js";

/** Plain unarchive restores visibility only. Restart keeps its independent launch checks. */
export function registerSessionArchiveRoute(app: FastifyInstance, deps: {
  db: ControlPlaneDb;
  svc: SessionsService;
  requestPrincipal: (req: FastifyRequest) => AuthPrincipal | null;
}): void {
  app.post("/api/sessions/:id/archive", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { archived?: unknown };
    if (typeof body.archived !== "boolean") return reply.code(400).send({ error: "archived must be a boolean" });
    const principal = deps.requestPrincipal(req);
    if (principal?.kind === "agent" && !body.archived) {
      const target = deps.db.getSession(id);
      if (!principal.orchestrator || !principal.credentialSessionId || target?.parentSessionId !== principal.credentialSessionId) {
        return reply.code(403).send({ error: AGENT_UNARCHIVE_ERROR });
      }
      const refusal = deps.db.campaignWorktreeRecoveryError(id);
      if (refusal) return reply.code(409).send({ error: refusal });
    }
    const result = deps.svc.setArchived(id, body.archived);
    return reply.code(result.status).send(result.ok ? result.data : failureBody(result));
  });
}
