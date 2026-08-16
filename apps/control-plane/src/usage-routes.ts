import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { runnerSupportsProtocol } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { AuthPrincipal } from "./identity.js";
import { canAdministerIdentity } from "./identity.js";
import {
  SUBSCRIPTION_USAGE_REFRESH_TIMEOUT_MS,
  SUBSCRIPTION_USAGE_STALE_AFTER_MS,
} from "./subscription-usage.js";
import { parseUsageAggregationQuery, parseUsageRetentionInput } from "./usage-aggregation.js";

export function registerUsageRoutes(
  app: FastifyInstance,
  db: ControlPlaneDb,
  requestPrincipal: (request: FastifyRequest) => AuthPrincipal | null,
  hub?: Pick<Hub, "requestFromRunner">,
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

  app.get("/api/usage/subscriptions", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human") {
      return reply.code(403).send({ error: "subscription usage is available to organization members only" });
    }
    return db.subscriptionUsageForPrincipal(principal, Date.now(), SUBSCRIPTION_USAGE_STALE_AFTER_MS);
  });

  app.post("/api/usage/subscriptions/refresh", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human") {
      return reply.code(403).send({ error: "subscription usage is available to organization members only" });
    }
    if (!hub) return reply.code(503).send({ error: "subscription usage refresh is unavailable" });
    const runners = db.listRunnersForPrincipal(principal).filter((runner) =>
      runner.status === "online" &&
      runnerSupportsProtocol(runner.protocolVersion, "subscriptionUsage") &&
      runner.agents.some((agent) => agent.driver === "codex-app-server" || agent.driver === "claude-code"));
    const results = await Promise.allSettled(runners.map(async (runner) => {
      const requestId = randomUUID();
      const result = await hub.requestFromRunner(
        runner.runnerId,
        requestId,
        { type: "refresh_subscription_usage", requestId },
        SUBSCRIPTION_USAGE_REFRESH_TIMEOUT_MS,
      );
      if (result.type !== "subscription_usage_refresh_result" || !result.ok) {
        throw new Error("runner could not refresh subscription usage");
      }
    }));
    const failed = results.filter((result) => result.status === "rejected").length;
    return {
      ...db.subscriptionUsageForPrincipal(principal, Date.now(), SUBSCRIPTION_USAGE_STALE_AFTER_MS),
      refresh: { attempted: runners.length, failed },
    };
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
