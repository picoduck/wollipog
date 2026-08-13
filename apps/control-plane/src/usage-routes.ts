import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ControlPlaneDb } from "./db.js";
import type { AuthPrincipal } from "./identity.js";
import { canAdministerIdentity } from "./identity.js";
import { parseUsageAggregationQuery, parseUsageRetentionInput } from "./usage-aggregation.js";

export function registerUsageRoutes(
  app: FastifyInstance,
  db: ControlPlaneDb,
  requestPrincipal: (request: FastifyRequest) => AuthPrincipal | null,
): void {
  app.get("/api/usage", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human") {
      return reply.code(403).send({ error: "usage accounting is available to organization members only" });
    }
    const retention = db.getUsageRetentionPolicy(principal.organizationId);
    try {
      const query = parseUsageAggregationQuery((request.query ?? {}) as Record<string, unknown>, retention);
      return db.queryUsageAggregation(principal, query);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid usage query" });
    }
  });

  app.put("/api/usage/retention", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human" || !canAdministerIdentity(principal.role)) {
      return reply.code(403).send({ error: "organization owner or admin permission is required" });
    }
    try {
      const input = parseUsageRetentionInput(request.body);
      return { retention: db.setUsageRetentionPolicy(principal.organizationId, input) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid retention policy" });
    }
  });
}
