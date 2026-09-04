import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { runnerSupportsProtocol } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { AuthPrincipal } from "./identity.js";
import { canAdministerIdentity } from "./identity.js";
import {
  SUBSCRIPTION_USAGE_STALE_AFTER_MS,
  subscriptionUsageRefreshTimeoutMs,
} from "./subscription-usage.js";
import { parseUsageAggregationQuery, parseUsageRetentionInput } from "./usage-aggregation.js";
import type { UsageRateTableService } from "./usage-rate-table.js";

export function registerUsageRoutes(
  app: FastifyInstance,
  db: ControlPlaneDb,
  requestPrincipal: (request: FastifyRequest) => AuthPrincipal | null,
  hub?: Pick<Hub, "requestFromRunner">,
  pricing?: Pick<UsageRateTableService, "ensure" | "status">,
): void {
  app.get("/api/usage", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human") {
      return reply.code(403).send({ error: "usage accounting is available to organization members only" });
    }
    const retention = db.getUsageRetentionPolicy(principal.organizationId);
    try {
      const query = parseUsageAggregationQuery((request.query ?? {}) as Record<string, unknown>, retention);
      const aggregation = db.queryUsageAggregation(principal, query);
      return pricing ? { ...aggregation, pricing: pricing.status() } : aggregation;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid usage query" });
    }
  });

  // Refetches the rate table ahead of its TTL so a model released since the last daily fetch is
  // priced from now on. Already-recorded buckets keep their provenance; nothing is re-priced.
  app.post("/api/usage/pricing/refresh", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human") {
      return reply.code(403).send({ error: "usage accounting is available to organization members only" });
    }
    if (!pricing) return reply.code(503).send({ error: "usage pricing is unavailable" });
    return { pricing: await pricing.ensure(true) };
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
        subscriptionUsageRefreshTimeoutMs(
          runner.agents.filter((agent) => agent.driver === "codex-app-server").length,
        ),
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

  // The organization's per-user daily allowance. Members can read it (it is what parks their
  // sessions); only owners and admins set it. `null` clears it.
  app.get("/api/usage/daily-budget", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human") {
      return reply.code(403).send({ error: "usage accounting is available to organization members only" });
    }
    return { dailyBudget: db.getUsageDailyBudget(principal.organizationId) };
  });

  app.put("/api/usage/daily-budget", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human" || !canAdministerIdentity(principal.role)) {
      return reply.code(403).send({ error: "organization owner or admin permission is required" });
    }
    const body = (request.body ?? {}) as { perUserUsd?: unknown };
    const value = body.perUserUsd;
    const rounded = typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : Number.NaN;
    if (value !== null && (!Number.isFinite(rounded) || rounded < 0.01 || rounded > 1_000_000)) {
      return reply.code(400).send({ error: "perUserUsd must be at least one cent, or null to clear" });
    }
    return { dailyBudget: db.setUsageDailyBudget(principal.organizationId, value === null ? null : rounded, Date.now()) };
  });

  // Per-user spend windows. Owners and admins see every user with usage; a member sees only
  // their own row, which is also what the daily budget gates on.
  app.get("/api/usage/users", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human") {
      return reply.code(403).send({ error: "usage accounting is available to organization members only" });
    }
    const users = canAdministerIdentity(principal.role)
      ? db.listUserCostWindows(principal.organizationId)
      : [db.userCostWindows(principal.organizationId, principal.userId)];
    return { users };
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
