import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";
import { buildAuthorizedWorkflowArtifactExport } from "./artifact-exports.js";

export function registerWorkflowArtifactExportRoute(
  app: FastifyInstance,
  deps: { db: ControlPlaneDb; requestHuman(req: FastifyRequest): HumanPrincipal | null },
): void {
  app.get("/api/artifacts/:artifactId/export", async (req, reply) => {
    const principal = deps.requestHuman(req);
    if (!principal) return reply.code(401).send({ error: "authentication required" });
    const result = buildAuthorizedWorkflowArtifactExport(
      deps.db,
      principal,
      (req.params as { artifactId: string }).artifactId,
    );
    if (!result.ok) return reply.code(result.status).send({ error: result.error, code: result.code });
    return reply.headers(result.headers).send(result.body);
  });
}
