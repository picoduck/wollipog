/**
 * Campaign Status read routes for the browser (#2417, docs/campaign-work-ledger.md "Read API").
 *
 * Every route accepts the root campaign or any member as `:id` and reads the root's ledger. A human
 * needs access to the root session; an Orchestrator agent may read only the campaign its own
 * credential resolves to; every other agent is refused. Reads never change the ledger revision.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  CampaignCostSummary,
  CampaignCostValue,
  CampaignForgeRefreshResponse,
  CampaignMetric,
  CampaignPullRequestRef,
  CampaignRecommendationsQuery,
  CampaignWorkItemDetail,
  CampaignWorkItemDetailResponse,
  CampaignWorkItemSummary,
  CampaignWorkItemsQuery,
  CampaignWorkSummary,
  CampaignWorkSummaryResponse,
} from "@wollipog/protocol";
import { FORGE_NOT_AUTHORIZED } from "./campaign-forge-observations.js";
import type { ControlPlaneDb } from "./db.js";
import type { AuthPrincipal } from "./identity.js";

/* ------------------------------ Cost visibility ------------------------------ */

/**
 * Cost follows the existing session-cost rule, which is session access. These apply it to whatever
 * cost the ledger carries; until usage attribution (slice 6) fills cost in, there is none to hide.
 */
const NOT_AUTHORIZED: CampaignMetric<CampaignCostValue> = { availability: "unavailable", reason: "not_authorized" };

/** A campaign bucket is hidden unless the principal can see every session that may contribute. */
export function campaignSummaryForPrincipal(summary: CampaignWorkSummary, everySessionVisible: boolean): CampaignWorkSummary {
  if (!summary.cost || everySessionVisible) return summary;
  const cost: CampaignCostSummary = {
    ...summary.cost,
    total: NOT_AUTHORIZED,
    workItems: NOT_AUTHORIZED,
    coordination: NOT_AUTHORIZED,
    unattributed: NOT_AUTHORIZED,
  };
  return { ...summary, cost };
}

/** An item's cost sums its attempts, so it needs every attempt session; a deleted attempt session
 * counts as visible when the root is (`canSee(null)`). */
export function workItemForPrincipal<T extends CampaignWorkItemSummary>(
  item: T,
  attemptSessionIds: ReadonlyArray<string | null>,
  canSee: (sessionId: string | null) => boolean,
): T {
  const detail = item as T & Partial<Pick<CampaignWorkItemDetail, "attemptCosts" | "attempts">>;
  const itemVisible = attemptSessionIds.every(canSee);
  const attemptCosts = detail.attemptCosts?.map((entry) => {
    const attempt = detail.attempts?.find((candidate) => candidate.id === entry.attemptId);
    return attempt && canSee(attempt.sessionId) ? entry : { ...entry, cost: NOT_AUTHORIZED };
  });
  if (itemVisible && !attemptCosts) return item;
  return {
    ...item,
    ...(item.cost && !itemVisible ? { cost: NOT_AUTHORIZED } : {}),
    ...(attemptCosts ? { attemptCosts } : {}),
  };
}

/* ------------------------------ Forge visibility ------------------------------ */

/**
 * Forge facts are read through the `gh` login of the runner hosting the root campaign. Reading the
 * campaign is not enough to see them: a human also needs access to that runner, so a shared
 * campaign never extends a personal runner owner's GitHub visibility. An agent reaches these routes
 * only as the campaign's own Orchestrator. Everyone else gets `unavailable{not_authorized}`, with
 * no last value; reported stages and pull-request references stay visible to every reader.
 */
export function forgeFactsForPrincipal<T extends CampaignWorkItemDetail>(item: T, visible: boolean): T {
  if (visible || !item.observed.pullRequests) return item;
  return {
    ...item,
    observed: {
      ...item.observed,
      pullRequests: item.observed.pullRequests.map((entry) => ({ ref: entry.ref, fact: FORGE_NOT_AUTHORIZED })),
    },
  };
}

/* ------------------------------ Routes ------------------------------ */

interface CampaignReader {
  principal: AuthPrincipal;
  rootId: string;
  /** Session-cost visibility for this principal; null is a deleted attempt session. */
  canSee(sessionId: string | null): boolean;
  /** Whether this principal may see forge facts read by the runner hosting the root. */
  forgeVisible(): boolean;
}

function text(query: Record<string, unknown>, name: string): string | undefined {
  return typeof query[name] === "string" ? query[name] as string : undefined;
}

function limitOf(query: Record<string, unknown>): { limit?: number } {
  const limit = text(query, "limit");
  // A malformed limit reaches the ledger as NaN, which refuses it with the bounds.
  return limit === undefined ? {} : { limit: /^\d{1,4}$/u.test(limit) ? Number(limit) : Number.NaN };
}

export function registerCampaignStatusRoutes(
  app: FastifyInstance,
  deps: {
    db: ControlPlaneDb;
    requestPrincipal(req: FastifyRequest): AuthPrincipal | null;
    /** Slice 8: read these pull requests now, subject to the rate limit; never rejects. */
    refreshForge?(campaignId: string, refs: readonly CampaignPullRequestRef[]): Promise<void>;
  },
): void {
  const { db } = deps;

  /** Resolve the root campaign for `:id` and authorize the reader, or send the refusal. */
  const reader = (req: FastifyRequest, reply: FastifyReply, id: string): CampaignReader | null => {
    const principal = deps.requestPrincipal(req);
    if (!principal) {
      void reply.code(401).send({ error: "authentication required" });
      return null;
    }
    const rootId = db.campaignRootForMember(id);
    if (principal.kind === "agent") {
      const own = principal.orchestrator && principal.credentialSessionId
        ? db.resolvedCampaignSessionId(principal.credentialSessionId)
        : null;
      if (!own || own !== rootId) {
        void reply.code(403).send({ error: "an Orchestrator credential may read only its own campaign" });
        return null;
      }
    } else {
      if (!db.canAccessSession(principal, id)) {
        void reply.code(404).send({ error: "session not found" });
        return null;
      }
      if (rootId && !db.canAccessSession(principal, rootId)) {
        void reply.code(403).send({ error: "access to the campaign's Orchestrator session is required" });
        return null;
      }
    }
    if (!rootId) {
      void reply.code(404).send({ error: "this session is not part of an Orchestrator campaign" });
      return null;
    }
    const visible = new Map<string, boolean>();
    const canSee = (sessionId: string | null): boolean => {
      const target = sessionId ?? rootId;
      let result = visible.get(target);
      if (result === undefined) {
        result = db.canAccessSession(principal, target);
        visible.set(target, result);
      }
      return result;
    };
    let forge: boolean | undefined;
    const forgeVisible = (): boolean => {
      if (forge === undefined) {
        // The agent branch above already limited an agent to its own campaign's Orchestrator.
        const runner = principal.kind === "agent" ? null : db.campaignForgeObservingRunner(rootId);
        forge = principal.kind === "agent" || (runner !== null && db.canAccessRunner(principal, runner.runnerId));
      }
      return forge;
    };
    return { principal, rootId, canSee, forgeVisible };
  };

  const everySessionVisible = (read: CampaignReader) =>
    read.canSee(read.rootId) && db.campaignDescendantIds(read.rootId).every((id) => read.canSee(id));

  app.get("/api/sessions/:id/campaign/summary", async (req, reply) => {
    const { id } = req.params as { id: string };
    const read = reader(req, reply, id);
    if (!read) return reply;
    const summary = db.campaignProjection(read.rootId)?.work;
    if (!summary) return reply.code(404).send({ error: "this session is not part of an Orchestrator campaign" });
    const response: CampaignWorkSummaryResponse = {
      campaignSessionId: read.rootId,
      summary: campaignSummaryForPrincipal(summary, !summary.cost || everySessionVisible(read)),
    };
    return reply.send(response);
  });

  app.get("/api/sessions/:id/campaign/work-items", async (req, reply) => {
    const { id } = req.params as { id: string };
    const read = reader(req, reply, id);
    if (!read) return reply;
    const query = req.query as Record<string, unknown>;
    const request: CampaignWorkItemsQuery = {
      ...(text(query, "cursor") !== undefined ? { cursor: text(query, "cursor") } : {}),
      ...limitOf(query),
      ...(text(query, "origin") !== undefined ? { origin: text(query, "origin") as CampaignWorkItemsQuery["origin"] } : {}),
      ...(text(query, "state") !== undefined ? { state: text(query, "state") as CampaignWorkItemsQuery["state"] } : {}),
      ...(text(query, "sort") !== undefined ? { sort: text(query, "sort") as CampaignWorkItemsQuery["sort"] } : {}),
    };
    const ledger = db.campaignWorkLedger;
    const page = ledger.page(read.rootId, request, Date.now());
    if (!page.ok) return reply.code(page.status).send({ ...page.details, error: page.error });
    const attempts = page.data.items.some((item) => item.cost) ? ledger.attemptSessionIdsByItem(read.rootId) : null;
    return reply.send({
      ...page.data,
      items: attempts
        ? page.data.items.map((item) => workItemForPrincipal(item, attempts.get(item.id) ?? [], read.canSee))
        : page.data.items,
    });
  });

  app.get("/api/sessions/:id/campaign/work-items/:itemId", async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const read = reader(req, reply, id);
    if (!read) return reply;
    const ledger = db.campaignWorkLedger;
    const item = itemId.length <= 256 ? ledger.detail(read.rootId, itemId, Date.now()) : null;
    if (!item) return reply.code(404).send({ error: "work item not found in this campaign" });
    const response: CampaignWorkItemDetailResponse = {
      revision: ledger.revision(read.rootId),
      item: forgeFactsForPrincipal(
        workItemForPrincipal(item, item.attempts.map((attempt) => attempt.sessionId), read.canSee),
        read.forgeVisible(),
      ),
    };
    return reply.send(response);
  });

  /** Slice 8 on-demand read, sent while the details are visible. A reader who may not see forge
   * facts cannot cause a forge read either. The wait is bounded; the read itself runs off the
   * session-update path and later changes reach readers through the revision. */
  app.post("/api/sessions/:id/campaign/work-items/:itemId/forge-refresh", async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const read = reader(req, reply, id);
    if (!read) return reply;
    if (!read.forgeVisible()) {
      return reply.code(403).send({ error: "forge status requires access to the runner that reads it" });
    }
    const ledger = db.campaignWorkLedger;
    const before = itemId.length <= 256 ? ledger.detail(read.rootId, itemId, Date.now()) : null;
    if (!before) return reply.code(404).send({ error: "work item not found in this campaign" });
    const refs = before.observed.pullRequests?.map((entry) => entry.ref) ?? [];
    if (refs.length > 0 && deps.refreshForge) await deps.refreshForge(read.rootId, refs);
    const item = ledger.detail(read.rootId, itemId, Date.now());
    const response: CampaignForgeRefreshResponse = {
      revision: ledger.revision(read.rootId),
      pullRequests: item?.observed.pullRequests ?? [],
    };
    return reply.send(response);
  });

  app.get("/api/sessions/:id/campaign/recommendations", async (req, reply) => {
    const { id } = req.params as { id: string };
    const read = reader(req, reply, id);
    if (!read) return reply;
    const query = req.query as Record<string, unknown>;
    const request: CampaignRecommendationsQuery = {
      ...(text(query, "cursor") !== undefined ? { cursor: text(query, "cursor") } : {}),
      ...limitOf(query),
      ...(text(query, "disposition") !== undefined
        ? { disposition: text(query, "disposition") as CampaignRecommendationsQuery["disposition"] }
        : {}),
    };
    const page = db.campaignWorkLedger.recommendationsPage(read.rootId, request);
    if (!page.ok) return reply.code(page.status).send({ ...page.details, error: page.error });
    return reply.send(page.data);
  });
}
