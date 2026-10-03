/**
 * Pure view-model for the Campaign Status right-panel mode (#2417): who may open it, and how the
 * campaign work ledger (docs/campaign-work-ledger.md) reads as summary facts, list rows, and item
 * details. No React, no fetches.
 *
 * Two rules run through everything here. A measurement nobody recorded reads "Unavailable", never
 * zero; and a cost says where it came from (provider-reported, estimated, partially priced).
 */
import {
  CAMPAIGN_FORGE_OBSERVATION,
  CAMPAIGN_WORK_ITEM_PRIMARY_STATES,
  CAMPAIGN_WORK_ITEM_UNFINISHED_STATES,
  type CampaignCostValue,
  type CampaignElapsed,
  type CampaignForgeCheckRollup,
  type CampaignForgeMergeQueueState,
  type CampaignForgePullRequestObservation,
  type CampaignIssueRef,
  type CampaignMetric,
  type CampaignMetricGapReason,
  type CampaignObservationUnavailableReason,
  type CampaignObservedFact,
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
import { formatCost, formatRecordedRelativeTime, titleCaseLabel } from "./format.js";

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
  // Nothing was used: a known zero with no provenance to report.
  if (metric.availability === "known" && value.records === 0) {
    return { text, provenance: null, note: "No usage was recorded.", priced: true };
  }
  const unpriced = value.source === "unpriced" || value.unpricedRecords > 0 ||
    (metric.availability === "partial" && metric.reason === "unpriced_usage");
  if (unpriced) {
    const records = value.unpricedRecords === 1 ? "1 record" : `${value.unpricedRecords} records`;
    return {
      text,
      provenance: "Partially Priced",
      note: value.unpricedRecords > 0
        ? `${records} could not be priced, so this cost is a lower bound.`
        : metricGapNote("unpriced_usage"),
      priced: true,
    };
  }
  const provenance = value.source === "providerReported" ? "Provider-Reported" : "Estimated API Cost";
  // Every recorded amount is priced, but part of its history was never recorded: a lower bound
  // that keeps its real provenance, as a partial duration reads "At least".
  if (metric.availability === "partial") {
    // An empty bucket's source is a placeholder (docs/campaign-work-ledger.md): no records, no claim.
    return { text: `At least ${text}`, provenance: value.records === 0 ? null : provenance,
      note: metricGapNote(metric.reason), priced: true };
  }
  return provenance === "Provider-Reported"
    ? { text, provenance, note: "Cost as reported by the provider.", priced: true }
    : { text, provenance, note: "Estimated from the model rate table.", priced: true };
}

/** Provenance labels as they read inside sentence-case helper text. */
const PROVENANCE_IN_SENTENCE: Record<string, string> = {
  "Provider-Reported": "provider-reported",
  "Estimated API Cost": "estimated API cost",
  "Partially Priced": "partially priced",
};

/**
 * A cost inline in a list of costs: the amount, plus its provenance whenever that is not already
 * stated by `context` (the provenance of the figure it sits under). A lower bound always says so.
 */
export function costWithProvenance(view: CampaignCostView, context: string | null = null): string {
  // Inline costs sit in sentence-case helper text, so a lower bound reads "at least" there.
  const text = view.text.replace(/^At least /u, "at least ");
  if (!view.priced || !view.provenance) return text;
  return view.provenance === context && view.provenance !== "Partially Priced"
    ? text
    : `${text} (${PROVENANCE_IN_SENTENCE[view.provenance] ?? view.provenance})`;
}

/** A duration metric: its value, a lower bound, or "Unavailable" with why. Zero is a real zero. */
export function durationMetricView(metric: CampaignMetric<number> | undefined): { text: string; note: string | null } {
  if (!metric) return { text: UNAVAILABLE, note: metricGapNote("not_collected") };
  if (metric.availability === "unavailable") return { text: UNAVAILABLE, note: metricGapNote(metric.reason) };
  const text = measuredDuration(metric.value);
  return metric.availability === "partial"
    ? { text: `At least ${text}`, note: metricGapNote(metric.reason) }
    : { text, note: null };
}

/**
 * A duration in milliseconds, in at most two units and never a trailing zero unit: "45s", "50m",
 * "1h 35m", "3h", "2d 4h". Seconds appear only under a minute. Anything that is not a measurement
 * reads "Unavailable".
 */
export function measuredDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return UNAVAILABLE;
  if (ms === 0) return "0s";
  // Checked before rounding, so 500–999ms still reads as under a second rather than "1s".
  if (ms < 1_000) return "<1s";
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** A recorded time as it reads inside helper text: "just now", "5m ago" (sentence case). */
export function timeAgo(at: number, now: number): string {
  return formatRecordedRelativeTime(at, now).toLowerCase();
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
  not_authorized: "GitHub status is read through the campaign runner's GitHub CLI, and you don't have access to that runner.",
  not_observed: "GitHub hasn't been read for this pull request yet.",
  runner_disconnected: "The campaign's runner is disconnected, so GitHub can't be read.",
  runner_unsupported: "The campaign's runner is too old to read GitHub status. Update the runner.",
  forge_cli_missing: "The campaign's runner has no GitHub CLI (gh).",
  forge_unauthenticated: "The GitHub CLI on the campaign's runner isn't signed in to github.com.",
  forge_unreachable: "GitHub couldn't be reached from the campaign's runner.",
  forge_unsupported: "Only GitHub repositories of a campaign on its own runner are observed.",
  forge_not_found: "GitHub has no such pull request, or the runner's GitHub CLI can't see it.",
  forge_rate_limited: "GitHub's rate limit for the runner's GitHub CLI is used up. It will be read again later.",
  forge_error: "GitHub returned an error.",
};

export function observationUnavailableText(reason: CampaignObservationUnavailableReason): string {
  return OBSERVATION_UNAVAILABLE_TEXT[reason] ?? "It is not available.";
}

/* ------------------------------------------------------------------------------------------------
 * Observed GitHub status (slice 8)
 * ---------------------------------------------------------------------------------------------- */

const PR_STATE_LABELS: Record<CampaignForgePullRequestObservation["state"], string> = {
  open: "Open",
  closed: "Closed",
  merged: "Merged",
};
const REVIEW_LABELS: Record<CampaignForgePullRequestObservation["reviewDecision"], string> = {
  approved: "Approved",
  changes_requested: "Changes Requested",
  review_required: "Review Required",
  none: "No Review Decision",
};
const CHECK_STATE_LABELS: Record<CampaignForgeCheckRollup["state"], string> = {
  passing: "Passing",
  failing: "Failing",
  pending: "Pending",
  none: "None Reported",
  unknown: "Unknown",
};
const MERGE_QUEUE_LABELS: Record<CampaignForgeMergeQueueState, string> = {
  queued: "Queued",
  awaiting_checks: "Awaiting Checks",
  mergeable: "Mergeable",
  unmergeable: "Unmergeable",
  locked: "Locked",
  unknown: "In Queue",
};

export interface ForgeFactRow {
  label: string;
  text: string;
  note: string | null;
}

/** How one observed pull request reads. `current` is false for a stale observation: every value
 * then reads "Last Seen …", so nothing stale reads as passing, approved, or merged now. */
export type ForgePullRequestView =
  | { kind: "observed"; current: boolean; observedAt: number; status: string; rows: ForgeFactRow[] }
  | { kind: "unavailable"; reason: string; lastObservedAt: number | null };

function checkNote(rollup: CampaignForgeCheckRollup, required: boolean): string | null {
  if (rollup.state === "none") {
    return required
      ? "GitHub reports no required checks yet. This is not passing."
      : "GitHub reports no checks on this head.";
  }
  if (rollup.state === "unknown") {
    return required
      ? "GitHub hasn't confirmed that every required check has reported, so this isn't shown as passing."
      : "There are more checks than one read covers, so the result can't be confirmed.";
  }
  const parts = [
    rollup.failing > 0 ? `${rollup.failing} failing` : null,
    rollup.pending > 0 ? `${rollup.pending} pending` : null,
    rollup.passing > 0 ? `${rollup.passing} passing` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `${parts.join(", ")}.` : null;
}

/** A fresh observation older than the documented age reads as stale here too, so a client that has
 * not refetched never shows an old answer as current. */
export function forgePullRequestView(
  fact: CampaignObservedFact<CampaignForgePullRequestObservation>,
  now: number,
): ForgePullRequestView {
  if (fact.availability === "unavailable") {
    return { kind: "unavailable", reason: observationUnavailableText(fact.reason), lastObservedAt: fact.lastObservedAt ?? null };
  }
  const current = fact.availability === "fresh" && now - fact.observedAt <= CAMPAIGN_FORGE_OBSERVATION.staleAfterMs;
  const value = fact.value;
  const seen = (text: string) => current ? text : `Last Seen ${text}`;
  const status = value.state === "open" && value.draft ? "Draft" : PR_STATE_LABELS[value.state];
  const rows: ForgeFactRow[] = [
    { label: "Review", text: seen(REVIEW_LABELS[value.reviewDecision]), note: null },
    { label: "Required Checks", text: seen(CHECK_STATE_LABELS[value.requiredChecks.state]), note: checkNote(value.requiredChecks, true) },
    { label: "All Checks", text: seen(CHECK_STATE_LABELS[value.checks.state]), note: checkNote(value.checks, false) },
    {
      label: "Merge Queue",
      text: seen(value.mergeQueue
        ? `${MERGE_QUEUE_LABELS[value.mergeQueue.state]}${value.mergeQueue.position === null ? "" : `, Position ${value.mergeQueue.position}`}`
        : "Not Queued"),
      note: null,
    },
    // The head SHA says nothing about where the commit is; the base branch is only the target.
    { label: "Head", text: value.headSha.slice(0, 7), note: null },
    { label: "Base Branch", text: value.baseRef, note: null },
  ];
  if (value.mergeCommitSha) rows.push({ label: "Merge Commit", text: value.mergeCommitSha.slice(0, 7), note: null });
  return { kind: "observed", current, observedAt: fact.observedAt, status: seen(status), rows };
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
  costBreakdown: { phrase: string; text: string }[];
  budget: string | null;
  obligations: { phrase: string; count: number }[];
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
  // Each bucket keeps its own provenance where it differs from the total's, so an estimated or
  // partially priced bucket never reads as exact under a provider-reported total.
  const breakdown = work.cost && cost.priced ? [
    { phrase: "Work items", text: costWithProvenance(campaignCostView(work.cost.workItems), cost.provenance) },
    { phrase: "coordination", text: costWithProvenance(campaignCostView(work.cost.coordination), cost.provenance) },
    { phrase: "unattributed", text: costWithProvenance(campaignCostView(work.cost.unattributed), cost.provenance) },
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
      { phrase: "verification", count: work.obligations.verification },
      { phrase: "recommendation adjudication", count: work.obligations.adjudication },
      { phrase: "issue publication", count: work.obligations.publication },
      { phrase: "cleanup", count: work.obligations.cleanup },
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
