/**
 * Pure view-model for the Campaign Status right-panel mode (#2417): who may open it, and how the
 * campaign work ledger (docs/campaign-work-ledger.md) reads as summary facts, list rows, and item
 * details. No React, no fetches.
 *
 * Two rules run through everything here. A measurement nobody recorded reads "Unavailable", never
 * zero; and a cost says where it came from (provider-reported, estimated, partially priced).
 */
import {
  CAMPAIGN_WORK_ITEM_PRIMARY_STATES,
  CAMPAIGN_WORK_ITEM_UNFINISHED_STATES,
  type CampaignCostValue,
  type CampaignElapsed,
  type CampaignIssueRef,
  type CampaignMetric,
  type CampaignMetricGapReason,
  type CampaignObservationUnavailableReason,
  type CampaignReportedStageKind,
  type CampaignResponsibleActor,
  type CampaignWorkItemOrigin,
  type CampaignWorkItemPrimaryState,
  type CampaignWorkItemSort,
  type CampaignWorkItemStateCause,
  type CampaignWorkItemStateFilter,
  type CampaignWorkItemSummary,
  type CampaignWorkSummary,
  type OrchestratorCampaignProjection,
  type SessionView,
} from "@wollipog/protocol";
import { formatCost, formatDuration, titleCaseLabel } from "./format.js";

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
    /** "campaign" on the root Orchestrator's own session, "member" on any descendant. */
    role: "campaign" | "member";
    currentWorkItemId: string | null;
  };

export const CAMPAIGN_STATUS_UNSUPPORTED_REASON =
  "This Wollipog server does not report campaign work. Update the server to see Campaign Status.";

type AvailabilitySession = Pick<SessionView, "id" | "orchestratorCampaign" | "campaignMembership">;

/**
 * Whether this session offers Campaign Status, and for which campaign.
 *
 * The presence of `work` on a campaign projection is the server's capability signal: a server that
 * keeps the ledger always sends it, and an older one never does. So a campaign whose projection has
 * no `work` is recognized but unavailable, and says why instead of showing an empty plan.
 *
 * A descendant is a member only when the server says so (`campaignMembership`), which also covers a
 * nested Orchestrator: its work belongs to the root campaign. An older server sends no membership,
 * so a child is recognized through a parent whose campaign carries no `work`; a parent whose
 * campaign does carry it would have reported membership for an authorized member.
 */
export function campaignStatusAvailability(
  session: AvailabilitySession,
  parent: Pick<SessionView, "id" | "orchestratorCampaign"> | null = null,
): CampaignStatusAvailability {
  const membership = session.campaignMembership;
  if (membership) {
    return {
      kind: "available",
      campaignSessionId: membership.campaignSessionId,
      role: membership.campaignSessionId === session.id ? "campaign" : "member",
      currentWorkItemId: membership.currentWorkItemId,
    };
  }
  if (session.orchestratorCampaign) {
    return session.orchestratorCampaign.work
      ? { kind: "available", campaignSessionId: session.id, role: "campaign", currentWorkItemId: null }
      : { kind: "unavailable", campaignSessionId: session.id, reason: CAMPAIGN_STATUS_UNSUPPORTED_REASON };
  }
  if (parent?.orchestratorCampaign && !parent.orchestratorCampaign.work) {
    return { kind: "unavailable", campaignSessionId: parent.id, reason: CAMPAIGN_STATUS_UNSUPPORTED_REASON };
  }
  return { kind: "hidden" };
}

/* ------------------------------------------------------------------------------------------------
 * Cost and time
 * ---------------------------------------------------------------------------------------------- */

export interface CampaignCostView {
  /** The amount, or "Unavailable". Never a priced-looking $0.00 for missing data. */
  text: string;
  /** Title Case provenance: Provider-Reported, Estimated API Cost, Partially Priced, or null. */
  provenance: string | null;
  /** One sentence for a details line. */
  note: string | null;
  priced: boolean;
}

const GAP_NOTES: Record<CampaignMetricGapReason, string> = {
  not_collected: "This server does not record it yet.",
  history_unavailable: "It was not recorded for this part of the campaign.",
  not_started: "Nothing has run yet.",
  unpriced_usage: "Some usage could not be priced, so this is a lower bound.",
  not_authorized: "You cannot see the cost of every session it includes.",
};

export function metricGapNote(reason: CampaignMetricGapReason): string {
  return GAP_NOTES[reason] ?? "It is not available.";
}

/** A cost metric, or its absence (`undefined`: not collected by this server). */
export function campaignCostView(metric: CampaignMetric<CampaignCostValue> | undefined): CampaignCostView {
  if (!metric) return { text: UNAVAILABLE, provenance: null, note: metricGapNote("not_collected"), priced: false };
  if (metric.availability === "unavailable") {
    return { text: UNAVAILABLE, provenance: null, note: metricGapNote(metric.reason), priced: false };
  }
  const value = metric.value;
  // formatCost renders nothing for zero. A known zero is a real amount and says so.
  const text = formatCost(value.usd) || "$0.00";
  if (metric.availability === "partial" || value.source === "unpriced" || value.unpricedRecords > 0) {
    const records = value.unpricedRecords === 1 ? "1 record" : `${value.unpricedRecords} records`;
    return {
      text,
      provenance: "Partially Priced",
      note: value.unpricedRecords > 0
        ? `${records} could not be priced, so this cost is a lower bound.`
        : metric.availability === "partial" ? metricGapNote(metric.reason) : metricGapNote("unpriced_usage"),
      priced: true,
    };
  }
  if (value.source === "providerReported") {
    return { text, provenance: "Provider-Reported", note: "Cost as reported by the provider.", priced: true };
  }
  return { text, provenance: "Estimated API Cost", note: "Estimated from the model rate table.", priced: true };
}

/** A duration metric: its value, a lower bound, or "Unavailable" with why. Zero is a real zero. */
export function durationMetricView(metric: CampaignMetric<number> | undefined): { text: string; note: string | null } {
  if (!metric) return { text: UNAVAILABLE, note: metricGapNote("not_collected") };
  if (metric.availability === "unavailable") return { text: UNAVAILABLE, note: metricGapNote(metric.reason) };
  const text = measuredDuration(metric.value);
  return metric.availability === "partial"
    ? { text: `At Least ${text}`, note: metricGapNote(metric.reason) }
    : { text, note: null };
}

/** A duration in milliseconds; anything that is not a measurement reads "Unavailable". */
export function measuredDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return UNAVAILABLE;
  if (ms === 0) return "0s";
  return formatDuration(ms);
}

/** Wall-clock span `(endedAt ?? now) - startedAt`. Never a sum of parallel item durations. */
export function elapsedMs(elapsed: CampaignElapsed, now: number): number | null {
  if (elapsed.startedAt === null) return null;
  return Math.max(0, (elapsed.endedAt ?? now) - elapsed.startedAt);
}

/**
 * The time a row shows. Work that has started shows Item Elapsed (first attempt to delivery, or to
 * now). Work without an attempt shows its recorded age, so it never looks like it is running.
 */
export function workItemTimeView(
  item: Pick<CampaignWorkItemSummary, "elapsed" | "createdAt">,
  now: number,
): { label: "Elapsed" | "Age"; text: string } {
  const elapsed = elapsedMs(item.elapsed, now);
  if (elapsed === null) return { label: "Age", text: measuredDuration(Math.max(0, now - item.createdAt)) };
  return { label: "Elapsed", text: measuredDuration(elapsed) };
}

/* ------------------------------------------------------------------------------------------------
 * Labels
 * ---------------------------------------------------------------------------------------------- */

export function issueRefLabel(issue: CampaignIssueRef): string {
  return `${issue.repository}#${issue.number}`;
}

/** A GitHub link for an `owner/name` reference; anything else stays text rather than a guessed URL. */
export function issueRefHref(issue: CampaignIssueRef, kind: "issues" | "pull" = "issues"): string | null {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(issue.repository) || !Number.isSafeInteger(issue.number) || issue.number < 1) {
    return null;
  }
  return `https://github.com/${issue.repository}/${kind}/${issue.number}`;
}

export function workItemTitle(item: { title: string | null; issue?: CampaignIssueRef | null; key: string }): string {
  return item.title?.trim() || (item.issue ? issueRefLabel(item.issue) : item.key);
}

export function workItemOriginLabel(item: { origin: CampaignWorkItemOrigin; generation: number }): string {
  if (item.origin === "original") return "Original";
  return item.generation > 1 ? `Follow-Up · Generation ${item.generation}` : "Follow-Up";
}

export const CAMPAIGN_WORK_STATE_LABELS: Record<CampaignWorkItemPrimaryState, string> = {
  planned: "Planned",
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  blocked: "Blocked",
  delivered: "Delivered",
  cancelled: "Canceled",
  removed: "Scope Removed",
};

/** Why an item is blocked or waiting, as a sentence. The first cause is the one the ledger shows. */
const STATE_CAUSE_TEXT: Record<CampaignWorkItemStateCause, string> = {
  recorded_blocker: "The Orchestrator recorded a blocker.",
  dependency_blocked: "A dependency is blocked, canceled, or removed.",
  dependency_unfinished: "Waiting for dependencies to finish.",
  attempt_session_held: "The child session is held.",
  attempt_session_failed: "The child session failed.",
  attempt_session_stopped: "The child session was stopped.",
  attempt_session_archived: "The child session was archived before delivery was verified.",
  attempt_session_unavailable: "The child session no longer exists.",
  attempt_session_input_required: "The child session needs input.",
  attempt_session_pending_decision: "The child session is waiting for a decision.",
  attempt_awaiting_verification: "The Orchestrator has not verified delivery yet.",
};

export function stateCauseText(cause: CampaignWorkItemStateCause): string {
  return STATE_CAUSE_TEXT[cause] ?? "The reason was not reported.";
}

/** Causes a person resolves through Requests. */
export function causeNeedsRequests(cause: CampaignWorkItemStateCause): boolean {
  return cause === "attempt_session_input_required" || cause === "attempt_session_pending_decision";
}

export const RESPONSIBLE_ACTOR_LABELS: Record<CampaignResponsibleActor, string> = {
  human: "You",
  orchestrator: "Orchestrator",
  child: "Child Session",
  external: "External",
};

export const REPORTED_STAGE_LABELS: Record<CampaignReportedStageKind, string> = {
  implementing: "Implementing",
  in_review: "In Review",
  awaiting_checks: "Awaiting Checks",
  awaiting_approval: "Awaiting Approval",
  merge_queued: "Merge Queued",
  merged: "Merged",
  cleanup: "Cleanup",
};

const OBSERVATION_UNAVAILABLE_TEXT: Record<CampaignObservationUnavailableReason, string> = {
  not_collected: "This server does not observe it.",
  session_deleted: "The session was deleted.",
  forge_unsupported: "Only GitHub repositories are observed.",
  forge_unauthenticated: "No runner has a signed-in GitHub CLI.",
  forge_unreachable: "GitHub could not be reached.",
  forge_error: "GitHub returned an error.",
};

export function observationUnavailableText(reason: CampaignObservationUnavailableReason): string {
  return OBSERVATION_UNAVAILABLE_TEXT[reason] ?? "It is not available.";
}

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
  planNotice: { title: string; body: string } | null;
  progressText: string;
  scope: { original: number; followUp: number };
  stateCounts: { state: CampaignWorkItemPrimaryState; label: string; count: number }[];
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

const SUMMARY_STATES: readonly CampaignWorkItemPrimaryState[] = ["planned", "queued", "running", "waiting", "blocked", "delivered"];

function childCount(count: number): string {
  return count === 1 ? "1 child session" : `${count} child sessions`;
}

function planNoticeFor(work: CampaignWorkSummary): CampaignSummaryView["planNotice"] {
  // Two sentences at most (§13.2): what is missing, then which gaps the counts below carry.
  const untracked = work.coverage.untrackedChildren;
  const untrackedPhrase = untracked > 0
    ? `${childCount(untracked)} without a work item ${untracked === 1 ? "is" : "are"} not counted`
    : null;
  const gaps = untrackedPhrase && work.coverage.predatesLedger
    ? ` ${untrackedPhrase}, and work from before the ledger existed may be missing.`
    : untrackedPhrase ? ` ${untrackedPhrase} below.`
      : work.coverage.predatesLedger ? " Work from before the ledger existed may be missing." : "";
  if (work.planState === "not_recorded") {
    return { title: "Plan Not Recorded", body: `The Orchestrator has not recorded a plan, so this may not be the whole campaign.${gaps}` };
  }
  if (work.planState === "partial" || gaps) {
    return {
      title: "Partial Coverage",
      body: (work.planState === "partial" ? "The Orchestrator has recorded only part of its plan." : "Some campaign work is not in the plan.") + gaps,
    };
  }
  return null;
}

export function campaignSummaryView(
  work: CampaignWorkSummary,
  campaign: Pick<OrchestratorCampaignProjection, "status" | "limits"> | null,
  now: number,
): CampaignSummaryView {
  const cost = campaignCostView(work.cost?.total);
  const breakdown = work.cost && cost.priced ? [
    { label: "Work Items", text: campaignCostView(work.cost.workItems).text },
    { label: "Coordination", text: campaignCostView(work.cost.coordination).text },
    { label: "Unattributed", text: campaignCostView(work.cost.unattributed).text },
  ] : [];
  const limits = campaign?.limits;
  return {
    stateLabel: campaign ? campaignLifecycleLabel(campaign.status) : UNAVAILABLE,
    planNotice: planNoticeFor(work),
    progressText: `${work.counts.delivered} of ${work.counts.committed} Delivered`,
    scope: { original: work.counts.original, followUp: work.counts.followUp },
    stateCounts: SUMMARY_STATES.map((state) => ({
      state,
      label: CAMPAIGN_WORK_STATE_LABELS[state],
      count: work.counts.byState[state] ?? 0,
    })),
    withdrawn: work.counts.cancelled + work.counts.removed,
    capacity: limits ? `${limits.occupied} of ${limits.maximumConcurrentChildren} Occupied` : UNAVAILABLE,
    elapsed: measuredDuration(elapsedMs(work.elapsed, now)),
    cost,
    costBreakdown: breakdown,
    // The projection's budget caps the Orchestrator's own session. Say so; it is not campaign-wide.
    budget: limits?.costBudgetUsd != null ? `${formatCost(limits.costBudgetUsd) || "$0.00"} Orchestrator Session Budget` : null,
    obligations: [
      { label: "Verification", count: work.obligations.verification },
      { label: "Recommendation Adjudication", count: work.obligations.adjudication },
      { label: "Issue Publication", count: work.obligations.publication },
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

/* ------------------------------------------------------------------------------------------------
 * Filters and sorting
 * ---------------------------------------------------------------------------------------------- */

export type CampaignWorkOriginFilter = "all" | CampaignWorkItemOrigin;

export interface CampaignWorkFilters {
  origin: CampaignWorkOriginFilter;
  state: CampaignWorkItemStateFilter;
  sort: CampaignWorkItemSort;
}

/** Unfinished work first, in the Orchestrator's queue order; finished work is one filter away. */
export const DEFAULT_CAMPAIGN_WORK_FILTERS: CampaignWorkFilters = { origin: "all", state: "unfinished", sort: "queue" };

export const CAMPAIGN_STATE_FILTER_OPTIONS: readonly { value: CampaignWorkItemStateFilter; label: string }[] = [
  { value: "unfinished", label: "Unfinished" },
  { value: "finished", label: "Finished" },
  { value: "all", label: "All States" },
  ...CAMPAIGN_WORK_ITEM_PRIMARY_STATES.map((state) => ({ value: state, label: CAMPAIGN_WORK_STATE_LABELS[state] })),
];

export const CAMPAIGN_ORIGIN_FILTER_OPTIONS: readonly { value: CampaignWorkOriginFilter; label: string }[] = [
  { value: "all", label: "All Origins" },
  { value: "original", label: "Original" },
  { value: "follow_up", label: "Follow-Up" },
];

export const CAMPAIGN_SORT_OPTIONS: readonly { value: CampaignWorkItemSort; label: string }[] = [
  { value: "queue", label: "Queue Order" },
  { value: "activity", label: "Recent Activity" },
  { value: "elapsed", label: "Longest Elapsed" },
  { value: "cost", label: "Highest Cost" },
];

export function stateMatchesFilter(state: CampaignWorkItemPrimaryState, filter: CampaignWorkItemStateFilter): boolean {
  if (filter === "all") return true;
  const unfinished = (CAMPAIGN_WORK_ITEM_UNFINISHED_STATES as readonly string[]).includes(state);
  if (filter === "unfinished") return unfinished;
  if (filter === "finished") return !unfinished;
  return state === filter;
}

/** Query string for `GET /campaign/work-items`. */
export function campaignWorkItemsQuery(filters: CampaignWorkFilters, cursor: string | null, limit: number): string {
  const query = new URLSearchParams({ limit: String(limit), sort: filters.sort, state: filters.state });
  if (filters.origin !== "all") query.set("origin", filters.origin);
  if (cursor) query.set("cursor", cursor);
  return query.toString();
}

/** Unknown values sort last in either direction; `direction` -1 orders known values descending. */
function nullsLast(left: number | null, right: number | null, direction: 1 | -1 = 1): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return (left - right) * direction;
}

function knownCost(item: CampaignWorkItemSummary): number | null {
  return item.cost && item.cost.availability !== "unavailable" ? item.cost.value.usd : null;
}

/**
 * The documented server ordering (queue position, then creation), reproduced for fixtures and the
 * evidence harness. Unknown values sort last and ties fall back to creation, then id, so two equal
 * rows never swap between renders.
 */
export function compareWorkItems(sort: CampaignWorkItemSort, now: number) {
  const tie = (left: CampaignWorkItemSummary, right: CampaignWorkItemSummary) =>
    left.createdAt - right.createdAt || left.id.localeCompare(right.id);
  const descending = (value: (item: CampaignWorkItemSummary) => number | null) =>
    (left: CampaignWorkItemSummary, right: CampaignWorkItemSummary) => nullsLast(value(left), value(right), -1);
  const primary = sort === "queue"
    ? (left: CampaignWorkItemSummary, right: CampaignWorkItemSummary) => nullsLast(left.queuePosition, right.queuePosition)
    : sort === "activity" ? descending((item) => item.activityAt)
      : sort === "elapsed" ? descending((item) => elapsedMs(item.elapsed, now))
        : descending(knownCost);
  return (left: CampaignWorkItemSummary, right: CampaignWorkItemSummary) => primary(left, right) || tie(left, right);
}

export function applyCampaignWorkFilters(
  items: readonly CampaignWorkItemSummary[],
  filters: CampaignWorkFilters,
  now: number,
): CampaignWorkItemSummary[] {
  return items
    .filter((item) => (filters.origin === "all" || item.origin === filters.origin) && stateMatchesFilter(item.primaryState, filters.state))
    .sort(compareWorkItems(filters.sort, now));
}

export function filtersAreDefault(filters: CampaignWorkFilters): boolean {
  return filters.origin === DEFAULT_CAMPAIGN_WORK_FILTERS.origin && filters.state === DEFAULT_CAMPAIGN_WORK_FILTERS.state;
}
