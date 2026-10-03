import { randomUUID } from "node:crypto";
import { applyClaudeReconciliation, previewClaudeReconciliation, reconciliationDeltaUsd, reconciliationRevision } from "./claude-cost-reconciliation.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { runnerSupportsProtocol } from "@wollipog/protocol";
import { HourlyUsageUnavailableError, type ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { AuthPrincipal } from "./identity.js";
import { canAdministerIdentity } from "./identity.js";
import {
  SUBSCRIPTION_USAGE_STALE_AFTER_MS,
  subscriptionUsageRefreshTimeoutMs,
} from "./subscription-usage.js";
import { parseUsageAggregationQuery, parseUsageRetentionInput } from "./usage-aggregation.js";
import type { UsageRateTableService } from "./usage-rate-table.js";

const SUPPORTED_USAGE_GRANULARITIES = ["hour", "day", "week"] as const;

export function registerUsageRoutes(
  app: FastifyInstance,
  db: ControlPlaneDb,
  requestPrincipal: (request: FastifyRequest) => AuthPrincipal | null,
  hub?: Pick<Hub, "requestFromRunner"> & Partial<Pick<Hub, "sendToRunner" | "sessionChangedById">>,
  pricing?: Pick<UsageRateTableService, "ensure" | "status">,
): void {
  // Accounting-only imports are explicit, human-admin scoped, bounded and preview-bound.
  // They never read a provider directory, prompt, transcript, credential, or current rate table.
  app.post("/api/usage/claude-reconciliation/preview", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human" || !canAdministerIdentity(principal.role)) {
      return reply.code(403).send({ error: "organization owner or admin permission is required" });
    }
    try { return previewClaudeReconciliation(db, principal, request.body); }
    catch { return reply.code(400).send({ error: "invalid or unavailable accounting evidence" }); }
  });
  app.get("/api/usage/claude-reconciliation/audit", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human" || !canAdministerIdentity(principal.role)) {
      return reply.code(403).send({ error: "organization owner or admin permission is required" });
    }
    const query = request.query as { sessionId?: unknown };
    if (typeof query.sessionId !== "string" || !db.canAccessSession(principal, query.sessionId)) {
      return reply.code(404).send({ error: "accounting audit is unavailable" });
    }
    return { reconciliations: db.raw().prepare(`SELECT digest, revision, delta_microusd AS deltaMicrousd,
      actor_id AS actorId, source_sha256 AS sourceSha256, evidence_json AS evidenceJson,
      result_json AS resultJson, created_at AS createdAt FROM usage_cost_reconciliations
      WHERE session_id=? AND organization_id=? ORDER BY revision DESC LIMIT 20`).all(query.sessionId, principal.organizationId) };
  });
  app.post("/api/usage/claude-reconciliation/apply", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human" || !canAdministerIdentity(principal.role)) {
      return reply.code(403).send({ error: "organization owner or admin permission is required" });
    }
    const body = request.body as { evidence?: unknown; approvedDigest?: unknown; approved?: unknown } | undefined;
    if (!body || body.approved !== true || typeof body.approvedDigest !== "string" ||
        Object.keys(body).some((key) => !["evidence", "approvedDigest", "approved"].includes(key))) {
      return reply.code(400).send({ error: "explicit approval of an exact reconciliation preview is required" });
    }
    if (!hub?.sendToRunner) return reply.code(503).send({ error: "revision-aware cost synchronization is unavailable" });
    let result: ReturnType<typeof applyClaudeReconciliation>;
    try { result = applyClaudeReconciliation(db, principal, body.evidence, body.approvedDigest); }
    catch { return reply.code(409).send({ error: "reconciliation is unavailable or changed; review a fresh preview" }); }
    const session = db.getSession(result.sessionId)!;
    // A durable revision makes resend safe after interruption or a disconnected runner.
    // Replays of an older apply use the latest total and revision, never its old amount.
    let synchronized = false;
    try {
      synchronized = hub.sendToRunner(session.runnerId, {
        type: "priced_session_cost", sessionId: session.id, costUsd: db.sessionCostUsd(session.id),
        costReconciliationRevision: reconciliationRevision(db, session.id),
        costReconciliationDeltaUsd: reconciliationDeltaUsd(db, session.id),
      });
    } catch { /* The correction committed. Reconnect or exact retry resends its revision. */ }
    hub.sessionChangedById?.(session.id);
    return { ...result, synchronized, costUsd: db.sessionCostUsd(session.id),
      revision: reconciliationRevision(db, session.id) };
  });

  app.get("/api/usage", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human") {
      return reply.code(403).send({ error: "usage accounting is available to organization members only" });
    }
    const retention = db.getUsageRetentionPolicy(principal.organizationId);
    try {
      const query = parseUsageAggregationQuery((request.query ?? {}) as Record<string, unknown>, retention);
      const aggregation = db.queryUsageAggregation(principal, query);
      return {
        ...aggregation,
        supportedGranularities: SUPPORTED_USAGE_GRANULARITIES,
        ...(pricing ? { pricing: pricing.status() } : {}),
      };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "invalid usage query",
        ...(error instanceof HourlyUsageUnavailableError ? { code: error.code } : {}),
      });
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
    const body = request.body as { runnerId?: unknown; providerAccountId?: unknown } | undefined;
    const targeted = body?.runnerId !== undefined || body?.providerAccountId !== undefined;
    if (targeted && (typeof body?.runnerId !== "string" || typeof body.providerAccountId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.providerAccountId))) {
      return reply.code(400).send({ error: "runnerId and providerAccountId are required for an account refresh" });
    }
    if (targeted) {
      const visibleSources = db.subscriptionUsageForPrincipal(
        principal,
        Date.now(),
        SUBSCRIPTION_USAGE_STALE_AFTER_MS,
      ).sources;
      if (!visibleSources.some((source) => source.runnerId === body!.runnerId &&
          source.providerAccountId === body!.providerAccountId)) {
        return reply.code(404).send({ error: "subscription account source not found" });
      }
    }
    const runners = db.listRunnersForPrincipal(principal).filter((runner) =>
      runner.status === "online" &&
      (!targeted || runner.runnerId === body!.runnerId) &&
      runnerSupportsProtocol(runner.protocolVersion, "subscriptionUsage") &&
      (!runner.harnessSelections?.length ||
        runnerSupportsProtocol(runner.protocolVersion, "harnessSelectionBackgroundConsumers")) &&
      runner.agents.some((agent) => agent.driver === "codex-app-server" || agent.driver === "claude-code"));
    const results = await Promise.allSettled(runners.map(async (runner) => {
      const codexAccounts = runner.providerAccounts
        ?.filter((account) => account.provider === "codex") ?? [];
      const unmappedLegacyCodexCount = runner.agents.filter((agent) =>
        agent.driver === "codex-app-server" &&
        !codexAccounts.some((account) =>
          (agent.context?.kind ?? "native") === "native" ||
          agent.defaultProviderAccountId === account.id)).length;
      const codexSourceCount = codexAccounts.length + unmappedLegacyCodexCount;
      const requestId = randomUUID();
      const result = await hub.requestFromRunner(
        runner.runnerId,
        requestId,
        { type: "refresh_subscription_usage", requestId,
          ...(targeted ? { providerAccountId: body!.providerAccountId as string } : {}) },
        subscriptionUsageRefreshTimeoutMs(
          targeted
            ? 1
            : codexSourceCount,
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
    if (value !== null && db.hasUserOwnedActiveAgentTui(principal.organizationId)) {
      return reply.code(409).send({
        error: "Daily cost budgets cannot be enabled while a user-owned Agent TUI is running because provider TUI activity is not reported to Wollipog. Close every Agent TUI or leave the daily budget disabled.",
      });
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
