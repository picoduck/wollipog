/**
 * Pure view-model for the Campaign Status right-panel mode (#2417): who may open it, and how the
 * campaign work ledger reads as summary facts, list rows, and item details. No React, no fetches.
 *
 * Two rules run through everything here. A measurement nobody recorded reads "Unavailable", never
 * zero; and a cost says where it came from (provider-reported, estimated, partially priced).
 */
import type { OrchestratorCampaignProjection, SessionView } from "@wollipog/protocol";
import { formatCost, formatDuration, titleCaseLabel } from "./format.js";
import type {
  CampaignCost,
  CampaignIssueRef,
  CampaignMembership,
  CampaignWorkItem,
  CampaignWorkOrigin,
  CampaignWorkOriginFilter,
  CampaignWorkSort,
  CampaignWorkState,
  CampaignWorkStateFilter,
  CampaignWorkSummary,
} from "./campaign-work-contract.js";
import { CAMPAIGN_WORK_STATES } from "./campaign-work-contract.js";

export const UNAVAILABLE = "Unavailable";

/* ------------------------------------------------------------------------------------------------
 * Availability
 * ---------------------------------------------------------------------------------------------- */

export type CampaignStatusAvailability =
  | { kind: "hidden" }
  | { kind: "unavailable"; campaignSessionId: string; reason: string }
  | {
    kind: "available";
    campaignSessionId: string;
    /** "campaign" on the Orchestrator's own session, "member" on a child anywhere below it. */
    role: "campaign" | "member";
    currentWorkItemId: string | null;
  };

export const CAMPAIGN_STATUS_UNSUPPORTED_REASON =
  "This Wollipog server does not report campaign work. Update the server to see Campaign Status.";

type AvailabilitySession = Pick<SessionView, "id" | "orchestratorCampaign" | "parentSessionId"> & {
  campaignMembership?: CampaignMembership | null;
};

/**
 * Whether this session offers Campaign Status, and for which campaign.
 *
 * A campaign is recognized from the Orchestrator's own projection or from the membership the server
 * reports for a descendant. When the server cannot report work, a recognized campaign still gets an
 * entry that explains why it is unavailable instead of silently vanishing; a child it cannot
 * recognize as a member (no membership on an older server) is recognized through a parent that
 * carries a campaign, which is the only campaign signal such a server sends.
 */
export function campaignStatusAvailability(
  session: AvailabilitySession,
  serverSupportsCampaignWork: boolean,
  parentCarriesCampaign = false,
): CampaignStatusAvailability {
  const membership = session.campaignMembership ?? null;
  const campaignSessionId = session.orchestratorCampaign
    ? session.id
    : membership?.campaignSessionId ?? (parentCarriesCampaign ? session.parentSessionId ?? null : null);
  if (!campaignSessionId) return { kind: "hidden" };
  if (!serverSupportsCampaignWork) {
    return { kind: "unavailable", campaignSessionId, reason: CAMPAIGN_STATUS_UNSUPPORTED_REASON };
  }
  if (session.orchestratorCampaign) {
    return { kind: "available", campaignSessionId, role: "campaign", currentWorkItemId: null };
  }
  if (!membership) {
    // Only reachable through the parent fallback, which a supporting server never needs: it sends
    // membership for every authorized member, so its absence means this child is not one.
    return { kind: "hidden" };
  }
  return { kind: "available", campaignSessionId, role: "member", currentWorkItemId: membership.currentWorkItemId };
}

/* ------------------------------------------------------------------------------------------------
 * Cost and time
 * ---------------------------------------------------------------------------------------------- */

export interface CampaignCostView {
  /** The amount, or "Unavailable". Never a priced-looking $0.00 for missing data. */
  text: string;
  /** Title Case provenance: Provider-Reported, Estimated API Cost, Partially Priced, or null. */
  provenance: string | null;
  /** One sentence for an accessible description or a details line. */
  note: string | null;
  priced: boolean;
}

export function campaignCostView(cost: CampaignCost | null | undefined): CampaignCostView {
  if (!cost || cost.totalUsd === null || cost.coverage === "unavailable") {
    return { text: UNAVAILABLE, provenance: null, note: "No usage has been attributed here yet.", priced: false };
  }
  const partial = cost.source === "unpriced" || cost.unpricedRecords > 0 || cost.coverage === "partial";
  // formatCost renders nothing for zero. A known zero is a real amount and says so.
  const text = formatCost(cost.totalUsd) || "$0.00";
  if (partial) {
    const records = cost.unpricedRecords === 1 ? "1 record" : `${cost.unpricedRecords} records`;
    return {
      text,
      provenance: "Partially Priced",
      note: cost.unpricedRecords > 0
        ? `${records} could not be priced, so this cost is a lower bound.`
        : "Some usage is not attributed yet, so this cost is a lower bound.",
      priced: true,
    };
  }
  if (cost.source === "providerReported") {
    return { text, provenance: "Provider-Reported", note: "Cost as reported by the provider.", priced: true };
  }
  if (cost.source === "modelPriced") {
    return { text, provenance: "Estimated API Cost", note: "Estimated from the model rate table.", priced: true };
  }
  return { text, provenance: null, note: null, priced: true };
}

/** A duration, or "Unavailable" when its intervals were not recorded. Zero is a real zero. */
export function measuredDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return UNAVAILABLE;
  if (ms === 0) return "0s";
  return formatDuration(ms);
}

/** Campaign Elapsed: wall clock from creation to verified completion, or to now. Never a sum. */
export function campaignElapsedMs(elapsed: CampaignWorkSummary["elapsed"], now: number): number {
  return Math.max(0, (elapsed.completedAt ?? now) - elapsed.startedAt);
}

/**
 * The time a row shows. Work that has started shows Item Elapsed (first attempt to delivery, or to
 * now). Planned and queued work shows its recorded age instead, so it never looks like it is running.
 */
export function workItemTimeView(
  item: Pick<CampaignWorkItem, "startedAt" | "endedAt" | "recordedAt">,
  now: number,
): { label: "Elapsed" | "Age"; text: string } {
  if (item.startedAt === null) {
    return { label: "Age", text: measuredDuration(Math.max(0, now - item.recordedAt)) };
  }
  return { label: "Elapsed", text: measuredDuration(Math.max(0, (item.endedAt ?? now) - item.startedAt)) };
}

/* ------------------------------------------------------------------------------------------------
 * Labels
 * ---------------------------------------------------------------------------------------------- */

export function issueRefLabel(issue: CampaignIssueRef): string {
  return `${issue.repository}#${issue.number}`;
}

export function issueRefHref(issue: CampaignIssueRef, kind: "issues" | "pull" = "issues"): string | null {
  // Only owner/name repositories become links; anything else stays text rather than a guessed URL.
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(issue.repository)) return null;
  return `https://github.com/${issue.repository}/${kind}/${issue.number}`;
}

export function workItemTitle(item: Pick<CampaignWorkItem, "title" | "issue" | "key">): string {
  return item.title?.trim() || (item.issue ? issueRefLabel(item.issue) : item.key);
}

export function workItemOriginLabel(item: Pick<CampaignWorkItem, "origin" | "generation">): string {
  if (item.origin === "original") return "Original";
  return item.generation > 1 ? `Follow-Up · Generation ${item.generation}` : "Follow-Up";
}

export const CAMPAIGN_WORK_STATE_LABELS: Record<CampaignWorkState, string> = {
  planned: "Planned",
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  blocked: "Blocked",
  delivered: "Delivered",
  cancelled: "Canceled",
  removed: "Scope Removed",
};

const CAMPAIGN_LIFECYCLE_LABELS: Record<OrchestratorCampaignProjection["status"], string> = {
  waiting_human: "Waiting for Human",
  active: "Active",
  blocked: "Blocked",
  verified_complete: "Verified Complete",
};

export function campaignLifecycleLabel(status: string): string {
  return CAMPAIGN_LIFECYCLE_LABELS[status as OrchestratorCampaignProjection["status"]]
    ?? titleCaseLabel(status.replaceAll("_", " "));
}

/* ------------------------------------------------------------------------------------------------
 * Summary
 * ---------------------------------------------------------------------------------------------- */

export interface CampaignSummaryView {
  stateLabel: string;
  stateValue: string | null;
  planNotice: { title: string; body: string } | null;
  progress: { delivered: number; committed: number; text: string };
  scope: { original: number; followUp: number };
  stateCounts: { state: CampaignWorkState; label: string; count: number }[];
  /** Canceled and scope-removed work, shown so it is never silently erased. */
  withdrawn: number;
  capacity: string;
  elapsed: string;
  cost: CampaignCostView;
  costBreakdown: { label: string; text: string }[];
  budget: string | null;
  obligations: { label: string; count: number }[];
  recommendations: { awaiting: number; rejected: number; deferred: number; duplicate: number };
}

const SUMMARY_STATES: readonly CampaignWorkState[] = ["planned", "queued", "running", "waiting", "blocked", "delivered"];

export function campaignSummaryView(
  work: CampaignWorkSummary,
  campaign: { status: string; limits: Pick<OrchestratorCampaignProjection["limits"], "maximumConcurrentChildren" | "occupied" | "costBudgetUsd"> | null } | null,
  now: number,
): CampaignSummaryView {
  const planNotice = work.planState === "not_recorded"
    ? {
      title: "Plan Not Recorded",
      body: work.coverage.untrackedChildren > 0
        ? `The Orchestrator has not recorded a plan. ${childCount(work.coverage.untrackedChildren)} without a work item ${work.coverage.untrackedChildren === 1 ? "is" : "are"} not counted below.`
        : "The Orchestrator has not recorded a plan, so the work list may not show the whole campaign.",
    }
    : work.planState === "partial"
      ? {
        title: "Partial Coverage",
        body: work.coverage.untrackedChildren > 0
          ? `Some work predates the plan. ${childCount(work.coverage.untrackedChildren)} without a work item ${work.coverage.untrackedChildren === 1 ? "is" : "are"} not counted below.`
          : "Some work predates the plan, so counts may not cover the whole campaign.",
      }
      : null;
  const cost = campaignCostView(work.cost);
  const breakdown = work.cost && cost.priced ? [
    { label: "Work Items", text: amountOrUnavailable(work.cost.workItemsUsd) },
    { label: "Coordination", text: amountOrUnavailable(work.cost.coordinationUsd) },
    { label: "Unattributed", text: amountOrUnavailable(work.cost.unattributedUsd) },
  ] : [];
  const limits = campaign?.limits;
  return {
    stateLabel: campaign ? campaignLifecycleLabel(campaign.status) : UNAVAILABLE,
    stateValue: campaign?.status ?? null,
    planNotice,
    progress: {
      delivered: work.counts.delivered,
      committed: work.counts.committed,
      text: `${work.counts.delivered} of ${work.counts.committed} Delivered`,
    },
    scope: { original: work.counts.original, followUp: work.counts.followUp },
    stateCounts: SUMMARY_STATES.map((state) => ({
      state,
      label: CAMPAIGN_WORK_STATE_LABELS[state],
      count: work.counts.byState[state] ?? 0,
    })),
    withdrawn: (work.counts.byState.cancelled ?? 0) + (work.counts.byState.removed ?? 0),
    capacity: limits ? `${limits.occupied} of ${limits.maximumConcurrentChildren} Occupied` : UNAVAILABLE,
    elapsed: measuredDuration(campaignElapsedMs(work.elapsed, now)),
    cost,
    costBreakdown: breakdown,
    // The projection's budget is the Orchestrator session's own cap. Say so; it is not campaign-wide.
    budget: limits?.costBudgetUsd != null ? `${formatCost(limits.costBudgetUsd) || "$0.00"} Orchestrator Session Budget` : null,
    obligations: [
      { label: "Verification", count: work.obligations.verification },
      { label: "Recommendation Adjudication", count: work.obligations.adjudication },
      { label: "Cleanup", count: work.obligations.cleanup },
    ].filter((obligation) => obligation.count > 0),
    recommendations: {
      awaiting: work.recommendations.awaiting_adjudication ?? 0,
      rejected: work.recommendations.rejected ?? 0,
      deferred: work.recommendations.deferred ?? 0,
      duplicate: work.recommendations.duplicate ?? 0,
    },
  };
}

function childCount(count: number): string {
  return count === 1 ? "1 child session" : `${count} child sessions`;
}

function amountOrUnavailable(usd: number | null): string {
  if (usd === null) return UNAVAILABLE;
  return formatCost(usd) || "$0.00";
}

/* ------------------------------------------------------------------------------------------------
 * Filters and sorting
 * ---------------------------------------------------------------------------------------------- */

export const UNFINISHED_STATES: readonly CampaignWorkState[] = ["planned", "queued", "running", "waiting", "blocked"];
export const FINISHED_STATES: readonly CampaignWorkState[] = ["delivered", "cancelled", "removed"];

export interface CampaignWorkFilters {
  origin: CampaignWorkOriginFilter;
  state: CampaignWorkStateFilter;
  sort: CampaignWorkSort;
}

/** Unfinished work first, in the Orchestrator's queue order; completed work is one filter away. */
export const DEFAULT_CAMPAIGN_WORK_FILTERS: CampaignWorkFilters = { origin: "all", state: "unfinished", sort: "queue" };

export const CAMPAIGN_STATE_FILTER_OPTIONS: readonly { value: CampaignWorkStateFilter; label: string }[] = [
  { value: "unfinished", label: "Unfinished" },
  { value: "finished", label: "Finished" },
  { value: "all", label: "All States" },
  ...CAMPAIGN_WORK_STATES.map((state) => ({ value: state, label: CAMPAIGN_WORK_STATE_LABELS[state] })),
];

export const CAMPAIGN_ORIGIN_FILTER_OPTIONS: readonly { value: CampaignWorkOriginFilter; label: string }[] = [
  { value: "all", label: "All Origins" },
  { value: "original", label: "Original" },
  { value: "follow_up", label: "Follow-Up" },
];

export const CAMPAIGN_SORT_OPTIONS: readonly { value: CampaignWorkSort; label: string }[] = [
  { value: "queue", label: "Queue Order" },
  { value: "activity", label: "Recent Activity" },
  { value: "time", label: "Longest Time" },
  { value: "cost", label: "Highest Cost" },
];

export function stateMatchesFilter(state: CampaignWorkState, filter: CampaignWorkStateFilter): boolean {
  if (filter === "all") return true;
  if (filter === "unfinished") return UNFINISHED_STATES.includes(state);
  if (filter === "finished") return FINISHED_STATES.includes(state);
  return state === filter;
}

export function originMatchesFilter(origin: CampaignWorkOrigin, filter: CampaignWorkOriginFilter): boolean {
  return filter === "all" || origin === filter;
}

/** Query string for the paginated work-list endpoint. */
export function campaignWorkItemsQuery(filters: CampaignWorkFilters, cursor: string | null, limit: number): string {
  const query = new URLSearchParams({ limit: String(limit), sort: filters.sort });
  if (filters.origin !== "all") query.set("origin", filters.origin);
  query.set("state", filters.state);
  if (cursor) query.set("cursor", cursor);
  return query.toString();
}

/**
 * The server's ordering, reproduced for fixtures and for keeping a page stable when one item
 * changes in place. Unknown values sort last and ties fall back to the stable key, so two equal
 * rows never swap between renders.
 */
export function compareWorkItems(sort: CampaignWorkSort, now: number) {
  const elapsed = (item: CampaignWorkItem) => item.startedAt === null ? null : (item.endedAt ?? now) - item.startedAt;
  const descending = (value: (item: CampaignWorkItem) => number | null) =>
    (left: CampaignWorkItem, right: CampaignWorkItem) => nullsLast(value(left), value(right), -1);
  const byKey = (left: CampaignWorkItem, right: CampaignWorkItem) => left.key.localeCompare(right.key);
  const primary = sort === "queue"
    ? (left: CampaignWorkItem, right: CampaignWorkItem) => nullsLast(left.queuePosition, right.queuePosition)
    : sort === "activity" ? descending((item) => item.lastActivityAt)
      : sort === "time" ? descending(elapsed)
        : descending((item) => item.cost?.totalUsd ?? null);
  return (left: CampaignWorkItem, right: CampaignWorkItem) => primary(left, right) || byKey(left, right);
}

/** Unknown values sort last in either direction; `direction` -1 orders known values descending. */
function nullsLast(left: number | null, right: number | null, direction: 1 | -1 = 1): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return (left - right) * direction;
}

export function applyCampaignWorkFilters(
  items: readonly CampaignWorkItem[],
  filters: CampaignWorkFilters,
  now: number,
): CampaignWorkItem[] {
  return items
    .filter((item) => originMatchesFilter(item.origin, filters.origin) && stateMatchesFilter(item.state, filters.state))
    .sort(compareWorkItems(filters.sort, now));
}

export function filtersAreDefault(filters: CampaignWorkFilters): boolean {
  return filters.origin === DEFAULT_CAMPAIGN_WORK_FILTERS.origin && filters.state === DEFAULT_CAMPAIGN_WORK_FILTERS.state;
}
