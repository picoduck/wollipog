/**
 * Campaign Work Ledger contract (#2417). `docs/campaign-work-ledger.md` is the normative
 * description; this module is its wire shape. Every ledger row is keyed by the ROOT campaign
 * session, which nested Orchestrators resolve to before any read or write.
 *
 * Recording work never grants authority. No type in this module publishes an issue, dispatches a
 * child, merges a pull request, or resolves a typed workflow decision; those remain gated by their
 * existing operations.
 *
 * Fields that later delivery slices fill in are optional and documented with the slice that owns
 * them. A peer that omits them is reporting "not collected here", never a zero.
 */
import type {
  AgentHarnessIdentity,
  SessionStatus,
  UsageCostSource,
} from "./index.js";

/* ------------------------------ Identities and bounds ------------------------------ */

export const CAMPAIGN_WORK_ITEM_ID_PREFIX = "cwi_";
export const CAMPAIGN_ATTEMPT_ID_PREFIX = "catt_";
export const CAMPAIGN_WORK_VERIFICATION_ID_PREFIX = "cwv_";
/** Recommendations keep the existing follow-up row identity (`followup_…`). */
export const CAMPAIGN_RECOMMENDATION_ID_PREFIX = "followup_";

/** Server-enforced bounds. Requests exceeding them are refused, never truncated. */
export const CAMPAIGN_WORK_LEDGER_LIMITS = {
  /** Items accepted by one `record_campaign_plan` call. */
  planItemsPerCall: 100,
  /** Work items one campaign may hold, including cancelled and removed ones. */
  workItemsPerCampaign: 2_000,
  keyLength: 256,
  titleLength: 240,
  /** Reasons, notes, blockers, and next actions. */
  textLength: 1_000,
  dependsOn: 64,
  pullRequestsPerStage: 16,
  originWorkItemIds: 32,
  pageSizeDefault: 50,
  pageSizeMax: 100,
} as const;

/** `owner/repo` plus issue number. The repository is compared case-insensitively. */
export interface CampaignIssueRef {
  repository: string;
  number: number;
}

export interface CampaignPullRequestRef {
  repository: string;
  number: number;
}

/* ------------------------------ Work items ------------------------------ */

/** `original`: part of the campaign's initial scope, whether or not it has an issue.
 * `follow_up`: created by accepting a recommendation; `generation` counts the hops. */
export type CampaignWorkItemOrigin = "original" | "follow_up";

/** The Orchestrator's record of an undispatched item. `planned`: known scope, not yet ready to
 * dispatch. `queued`: ready, waiting for execution capacity or for dependencies to finish. */
export type CampaignWorkItemDispatchState = "planned" | "queued";

/** Cancelled and removed items stay visible and are never counted as committed or delivered. */
export type CampaignWorkItemCommitmentState = "committed" | "cancelled" | "scope_removed";

export interface CampaignWorkItemCommitment {
  state: CampaignWorkItemCommitmentState;
  /** Required for `cancelled` and `scope_removed`. */
  reason: string | null;
  changedAt: number;
  /** Orchestrator session that recorded the change; null once that session is deleted. */
  changedBySessionId: string | null;
}

/** Exactly one per item, derived (never stored) by the rules in docs/campaign-work-ledger.md. */
export const CAMPAIGN_WORK_ITEM_PRIMARY_STATES = [
  "planned",
  "queued",
  "running",
  "waiting",
  "blocked",
  "delivered",
  "cancelled",
  "removed",
] as const;
export type CampaignWorkItemPrimaryState = typeof CAMPAIGN_WORK_ITEM_PRIMARY_STATES[number];

/** States that count as unfinished committed work. `delivered`, `cancelled`, and `removed` are
 * the only finished states. */
export const CAMPAIGN_WORK_ITEM_UNFINISHED_STATES = [
  "planned",
  "queued",
  "running",
  "waiting",
  "blocked",
] as const satisfies readonly CampaignWorkItemPrimaryState[];

/** Why a derived state is `blocked` (or `waiting`). Several may hold; the first listed in
 * docs/campaign-work-ledger.md wins for display. */
export type CampaignWorkItemStateCause =
  | "recorded_blocker"
  | "dependency_blocked"
  | "dependency_unfinished"
  | "attempt_session_held"
  | "attempt_session_failed"
  | "attempt_session_stopped"
  /** Archived without a delivered verification; an archived session takes no further turns. */
  | "attempt_session_archived"
  | "attempt_session_unavailable"
  | "attempt_session_input_required"
  | "attempt_session_pending_decision"
  | "attempt_awaiting_verification";

export type CampaignResponsibleActor = "human" | "orchestrator" | "child" | "external";

/** An Orchestrator-recorded blocker. It describes; it does not resolve or own any request. */
export interface CampaignWorkItemBlocker {
  reason: string;
  responsibleActor: CampaignResponsibleActor;
  /** Optional link to the existing Request this blocker waits on. */
  requestOccurrenceId?: string;
  recordedAt: number;
  recordedBySessionId: string | null;
}

/** Stages the Orchestrator reports. They are claims with a source and time, not observations,
 * and none of them changes the primary state: `merged` does not mean `delivered`. */
export const CAMPAIGN_REPORTED_STAGES = [
  "implementing",
  "in_review",
  "awaiting_checks",
  "awaiting_approval",
  "merge_queued",
  "merged",
  "cleanup",
] as const;
export type CampaignReportedStageKind = typeof CAMPAIGN_REPORTED_STAGES[number];

export interface CampaignReportedStage {
  stage: CampaignReportedStageKind;
  note: string | null;
  pullRequests: CampaignPullRequestRef[];
  /** The reporting Orchestrator (root or nested); null once that session is deleted. */
  sourceSessionId: string | null;
  reportedAt: number;
}

/* ------------------------------ Observed facts ------------------------------ */

export type CampaignObservationUnavailableReason =
  /** This control plane does not collect the fact (feature or delivery slice absent). */
  | "not_collected"
  /** The session the fact belongs to was deleted; its snapshot remains on the attempt. */
  | "session_deleted"
  /** Forge observation: the repository's forge is not supported (GitHub only). */
  | "forge_unsupported"
  /** Forge observation: no runner with an authenticated `gh` could be reached. */
  | "forge_unauthenticated"
  | "forge_unreachable"
  | "forge_error";

/** A server-observed fact. `stale` keeps the last value with its age; `unavailable` never implies
 * a passing or otherwise favourable value. */
export type CampaignObservedFact<T> =
  | { availability: "fresh"; value: T; observedAt: number }
  | { availability: "stale"; value: T; observedAt: number }
  | {
    availability: "unavailable";
    reason: CampaignObservationUnavailableReason;
    /** Last value seen before the fact became unavailable, if any. Display only. */
    lastValue?: T;
    lastObservedAt?: number;
  };

export interface CampaignObservedSessionStatus {
  sessionId: string;
  status: SessionStatus;
  archived: boolean;
  /** The session is held from starting its next turn (existing #1650 holds). */
  held: boolean;
  /** Unresolved workflow decisions or provider requests on the session. */
  pendingRequests: number;
}

/** Worktree cleanup of an attempt's session, in the existing campaign cleanup vocabulary
 * (`OrchestratorCampaignProjection.cleanupWorktrees`), plus `retired` once nothing is held. */
export interface CampaignObservedCleanup {
  sessionId: string;
  worktrees: Array<{
    path: string;
    status: "pending" | "deferred" | "refused" | "retired";
    reason: string | null;
  }>;
}

/** Slice 8: GitHub pull-request observation read on a runner through its existing `gh` login. */
export interface CampaignForgePullRequestObservation {
  state: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string;
  baseRef: string;
  reviewDecision: "approved" | "changes_requested" | "review_required" | "none";
  checks: "passing" | "failing" | "pending" | "none";
  mergeQueue: { state: string; position: number | null } | null;
  mergeCommitSha: string | null;
}

/* ------------------------------ Attempts and verification ------------------------------ */

/** `delivered`: closed by a delivered work-item verification. `reassigned`: the session was
 * assigned to a different item. `superseded`: the item was assigned to a different session.
 * `abandoned`/`failed`: closed explicitly by the Orchestrator, or `abandoned` when the item was
 * cancelled or removed from scope. */
export type CampaignAttemptEndReason = "delivered" | "reassigned" | "superseded" | "abandoned" | "failed";

/** Position in the session's event history when an attempt boundary was recorded. Usage and
 * status attribution (slice 6) compare against it; null components were unknown at the time. */
export interface CampaignAttemptBoundary {
  eventEpoch: number | null;
  runnerHistoryEpoch: number | null;
  seq: number | null;
}

/** Copied at assignment so history survives the child's archive or deletion. */
export interface CampaignAttemptSessionSnapshot {
  title: string | null;
  harness: AgentHarnessIdentity | null;
  agentName: string | null;
  model: string | null;
  effort: string | null;
}

/** One work item executed by one session. A session has at most one open attempt. */
export interface CampaignAttempt {
  id: string;
  workItemId: string;
  /** 1-based order of this attempt within its work item. */
  ordinal: number;
  /** Null after the child session is deleted; `session` keeps its snapshot. */
  sessionId: string | null;
  session: CampaignAttemptSessionSnapshot;
  assignedBySessionId: string | null;
  startedAt: number;
  start: CampaignAttemptBoundary;
  endedAt: number | null;
  end: CampaignAttemptBoundary | null;
  endReason: CampaignAttemptEndReason | null;
  endNote: string | null;
}

export type CampaignWorkItemVerificationOutcome = "delivered" | "incomplete";

/** Delivery proof for one work item and attempt. Unlike session-level child verification, a later
 * execution of the same child does not invalidate it. */
export interface CampaignWorkItemVerification {
  id: string;
  workItemId: string;
  attemptId: string;
  childSessionId: string | null;
  outcome: CampaignWorkItemVerificationOutcome;
  report: {
    seq: number;
    eventEpoch: number | null;
    digest: string | null;
    ts: number | null;
  };
  /** The verifying Orchestrator, which may be nested; null once it is deleted. */
  verifiedBySessionId: string | null;
  verifiedAt: number;
}

/* ------------------------------ Recommendations ------------------------------ */

export type CampaignRecommendationDisposition =
  | "awaiting_adjudication"
  | "accepted"
  | "rejected"
  | "deferred"
  | "duplicate";

/** A record of whether an issue still needs to be published. It is never a publication grant:
 * `follow_up_issue_publication` remains a separate typed decision. */
export type CampaignRecommendationPublication = "not_required" | "awaiting_publication" | "published";

/** Extends an existing follow-up row; `id` is that row's id. */
export interface CampaignRecommendation {
  id: string;
  repository: string;
  title: string;
  recommendationKey?: string;
  /** Null once the origin session is deleted (origin history is preserved). */
  originSessionId: string | null;
  originWorkItemIds: string[];
  /** Server deduplication target when the normalized repository/title already existed. */
  duplicateOfId: string | null;
  disposition: CampaignRecommendationDisposition;
  dispositionReason: string | null;
  adjudicatedAt: number | null;
  adjudicatedBySessionId: string | null;
  publication: CampaignRecommendationPublication;
  resultingIssue: CampaignIssueRef | null;
  resultingWorkItemId: string | null;
  createdAt: number;
}

/* ------------------------------ Time and cost ------------------------------ */

export type CampaignMetricGapReason =
  /** This control plane does not record the measurement (feature or delivery slice absent). */
  | "not_collected"
  /** The interval predates recording, or its history was lost. */
  | "history_unavailable"
  /** Nothing has happened to measure yet (for example, no attempt has started). */
  | "not_started"
  /** Some usage could not be priced; the value is a lower bound. */
  | "unpriced_usage"
  /** The requesting principal may not see cost under the existing session-cost rule. */
  | "not_authorized";

/** A measurement with explicit availability. A known zero is `{ availability: "known", value: 0 }`;
 * missing data is `unavailable`, never 0. `partial` values are lower bounds. */
export type CampaignMetric<T> =
  | { availability: "known"; value: T }
  | { availability: "partial"; value: T; reason: CampaignMetricGapReason }
  | { availability: "unavailable"; reason: CampaignMetricGapReason };

export interface CampaignCostValue {
  usd: number;
  /** Existing provenance: provider-reported, rate-table priced, or partially unpriced. */
  source: UsageCostSource;
  unpricedRecords: number;
}

/** Slice 6. Each usage record is counted once across the three buckets. */
export interface CampaignCostSummary {
  total: CampaignMetric<CampaignCostValue>;
  workItems: CampaignMetric<CampaignCostValue>;
  /** Root and nested Orchestrator usage outside any attempt. */
  coordination: CampaignMetric<CampaignCostValue>;
  /** Campaign usage recorded while no attempt was open on a non-coordinating session. */
  unattributed: CampaignMetric<CampaignCostValue>;
  /** Earliest time from which attribution was recorded; earlier usage is not split. */
  attributedSince: number | null;
}

/** Wall-clock bounds. Elapsed is `(endedAt ?? now) - startedAt`, computed by the reader. */
export interface CampaignElapsed {
  startedAt: number | null;
  endedAt: number | null;
}

/** Slice 6. Durations in milliseconds over documented status intervals. */
export interface CampaignWorkItemTimes {
  /** First attempt start to delivery verification, including intervening waits. */
  elapsed: CampaignElapsed;
  queue: CampaignMetric<number>;
  waiting: CampaignMetric<number>;
  active: CampaignMetric<number>;
  /** Server time the open-ended intervals were measured to. */
  asOf: number;
}

/* ------------------------------ Read API ------------------------------ */

export type CampaignPlanState = "recorded" | "partial" | "not_recorded";

/** Lightweight campaign summary carried on `OrchestratorCampaignProjection.work` (slice 5). Every
 * ledger mutation increments `revision` once and re-sends the root session; reads never do. */
export interface CampaignWorkSummary {
  revision: number;
  planState: CampaignPlanState;
  coverage: {
    /** Campaign children with no attempt on any work item. */
    untrackedChildren: number;
    /** The campaign has history from before the ledger existed; earlier facts may be missing. */
    predatesLedger: boolean;
  };
  counts: {
    /** Items whose commitment is `committed`, delivered or not. */
    committed: number;
    delivered: number;
    /** Committed items by origin. */
    original: number;
    followUp: number;
    cancelled: number;
    removed: number;
    byState: Record<CampaignWorkItemPrimaryState, number>;
  };
  recommendations: Record<CampaignRecommendationDisposition, number>;
  obligations: {
    /** Open attempts whose session is idle or completed without a delivered verification. */
    verification: number;
    adjudication: number;
    publication: number;
    /** Existing campaign worktree cleanup still pending. */
    cleanup: number;
  };
  /** Root creation to verified campaign completion. Never a sum of item durations. */
  elapsed: CampaignElapsed;
  /** Slice 6. Omitted means not collected; see `CampaignCostSummary` for per-bucket gaps. */
  cost?: CampaignCostSummary;
}

/** `GET /api/sessions/:id/campaign/summary` (slice 5): the summary of the root campaign `:id`
 * resolves to, with cost hidden per the session-cost rule. */
export interface CampaignWorkSummaryResponse {
  campaignSessionId: string;
  summary: CampaignWorkSummary;
}

/** `SessionView.campaignMembership` for campaign descendants (slice 5). */
export interface CampaignMembershipView {
  /** The root campaign session. */
  campaignSessionId: string;
  currentWorkItemId: string | null;
  currentAttemptId: string | null;
}

export interface CampaignWorkItemSummary {
  id: string;
  key: string;
  title: string | null;
  issue: CampaignIssueRef | null;
  origin: CampaignWorkItemOrigin;
  /** 0 for original scope; one more than the highest origin item for an accepted follow-up, or 1
   * when its recommendation names no origin item. */
  generation: number;
  primaryState: CampaignWorkItemPrimaryState;
  stateCauses: CampaignWorkItemStateCause[];
  commitment: CampaignWorkItemCommitmentState;
  dispatchState: CampaignWorkItemDispatchState;
  queuePosition: number | null;
  currentAttempt: {
    id: string;
    sessionId: string | null;
    sessionTitle: string | null;
  } | null;
  attemptCount: number;
  stage: CampaignReportedStage | null;
  blocker: CampaignWorkItemBlocker | null;
  createdAt: number;
  updatedAt: number;
  /** Last ledger or observed-status change; drives the `activity` sort. */
  activityAt: number;
  elapsed: CampaignElapsed;
  /** Slice 6. Omitted means not collected. */
  cost?: CampaignMetric<CampaignCostValue>;
}

export interface CampaignWorkItemDetail extends CampaignWorkItemSummary {
  dependsOn: Array<{ id: string; key: string; title: string | null; primaryState: CampaignWorkItemPrimaryState }>;
  dependents: string[];
  nextAction: string | null;
  commitmentRecord: CampaignWorkItemCommitment;
  attempts: CampaignAttempt[];
  verifications: CampaignWorkItemVerification[];
  /** The recommendation this item was accepted from, if any. */
  sourceRecommendation: CampaignRecommendation | null;
  /** Recommendations naming this item as an origin. */
  recommendations: CampaignRecommendation[];
  observed: {
    session?: CampaignObservedFact<CampaignObservedSessionStatus>;
    /** Slice 5. Worktree cleanup of the latest attempt's session. Omitted means not collected. */
    cleanup?: CampaignObservedFact<CampaignObservedCleanup>;
    /** Slice 8. Omitted means not collected. */
    pullRequests?: Array<{
      ref: CampaignPullRequestRef;
      fact: CampaignObservedFact<CampaignForgePullRequestObservation>;
    }>;
  };
  /** Slice 6. Omitted means not collected. */
  times?: CampaignWorkItemTimes;
  /** Slice 6. Cost per attempt, in attempt order. Omitted means not collected. */
  attemptCosts?: Array<{ attemptId: string; cost: CampaignMetric<CampaignCostValue> }>;
}

export type CampaignWorkItemStateFilter = CampaignWorkItemPrimaryState | "unfinished" | "finished" | "all";
export type CampaignWorkItemSort = "queue" | "activity" | "elapsed" | "cost";

/** `GET /api/sessions/:id/campaign/work-items` query. The default state filter is `unfinished`
 * and the default sort is `queue`. */
export interface CampaignWorkItemsQuery {
  cursor?: string;
  limit?: number;
  origin?: CampaignWorkItemOrigin;
  state?: CampaignWorkItemStateFilter;
  sort?: CampaignWorkItemSort;
}

export interface CampaignWorkItemsPage {
  revision: number;
  items: CampaignWorkItemSummary[];
  /** Opaque, bound to the filter, sort, and revision. A stale cursor is refused with 409. */
  nextCursor: string | null;
  /** Items matching the filter at this revision. */
  total: number;
}

/** Error code returned with HTTP 409 when a cursor was minted at an older revision. */
export const CAMPAIGN_WORK_REVISION_CHANGED = "revision_changed" as const;

export interface CampaignWorkRevisionChangedError {
  error: string;
  code: typeof CAMPAIGN_WORK_REVISION_CHANGED;
  revision: number;
}

export type CampaignRecommendationDispositionFilter = CampaignRecommendationDisposition | "all";

/** Slice 5: `GET /api/sessions/:id/campaign/recommendations?cursor&limit&disposition`. The default
 * filter is `all`; order is awaiting adjudication first, then newest first. The cursor follows the
 * work-items page rules, including `revision_changed`. */
export interface CampaignRecommendationsQuery {
  cursor?: string;
  limit?: number;
  disposition?: CampaignRecommendationDispositionFilter;
}

export interface CampaignRecommendationsPage {
  revision: number;
  items: CampaignRecommendation[];
  nextCursor: string | null;
  total: number;
}

export interface CampaignWorkItemDetailResponse {
  revision: number;
  item: CampaignWorkItemDetail;
}

/* ------------------------------ Orchestrator operations ------------------------------ */

export interface CampaignPlanItemInput {
  /** Stable, Orchestrator-chosen identity for idempotent upsert, such as
   * `picoduck/wollipog#2417` or `plan:read-api`. */
  key: string;
  title?: string;
  issue?: CampaignIssueRef | null;
  /** Defaults to `original`. Follow-up items normally come from adjudication instead. */
  origin?: CampaignWorkItemOrigin;
  dispatchState?: CampaignWorkItemDispatchState;
  queuePosition?: number | null;
  /** Keys of items in this call or already in the ledger. */
  dependsOnKeys?: string[];
}

/** `record_campaign_plan`. Upserts by key: supplied fields replace, omitted fields are unchanged.
 * It never changes commitment, attempts, or verification. */
export interface RecordCampaignPlanRequest {
  items: CampaignPlanItemInput[];
  /** True when the ledger now lists the campaign's whole original scope. */
  planComplete: boolean;
}

export interface RecordCampaignPlanResponse {
  revision: number;
  planState: CampaignPlanState;
  items: Array<{ key: string; workItemId: string; created: boolean }>;
}

/** `update_campaign_work_item`. Omitted fields are unchanged; `null` clears. */
export interface UpdateCampaignWorkItemRequest {
  workItemId: string;
  title?: string | null;
  issue?: CampaignIssueRef | null;
  dispatchState?: CampaignWorkItemDispatchState;
  queuePosition?: number | null;
  dependsOn?: string[];
  commitment?: { state: CampaignWorkItemCommitmentState; reason?: string };
  stage?: { stage: CampaignReportedStageKind; note?: string; pullRequests?: CampaignPullRequestRef[] } | null;
  blocker?: { reason: string; responsibleActor: CampaignResponsibleActor; requestOccurrenceId?: string } | null;
  nextAction?: string | null;
  /** Closes the item's open attempt without delivery. */
  endAttempt?: { reason: "abandoned" | "failed"; note?: string };
}

export interface CampaignWorkItemMutationResponse {
  revision: number;
  item: CampaignWorkItemDetail;
}

/** `assign_campaign_work_item`. The child must be a descendant of the campaign. Opens a new
 * attempt; the session's other open attempt closes as `reassigned` and the item's other open
 * attempt closes as `superseded`. Repeating an assignment that is already open is a no-op. */
export interface AssignCampaignWorkItemRequest {
  workItemId: string;
  childSessionId: string;
}

export interface AssignCampaignWorkItemResponse {
  revision: number;
  attempt: CampaignAttempt;
  closedAttempts: Array<{ id: string; workItemId: string; endReason: CampaignAttemptEndReason }>;
  /** False when the identical attempt was already open. */
  created: boolean;
}

/** Optional addition to `VerifyOrchestratorChildRequest`. Records a work-item verification
 * against the child's open attempt on that item; `delivered` closes the attempt. */
export interface VerifyCampaignWorkItemInput {
  id: string;
  outcome: CampaignWorkItemVerificationOutcome;
}

/** `adjudicate_campaign_recommendation`. Re-adjudication replaces the previous disposition. */
export interface AdjudicateCampaignRecommendationRequest {
  recommendationId: string;
  disposition: Exclude<CampaignRecommendationDisposition, "awaiting_adjudication">;
  reason: string;
  /** For `accepted`: the follow-up work item to create or link. For `duplicate`: an existing
   * item this recommendation duplicates. */
  resultingWorkItemKey?: string;
  resultingIssue?: CampaignIssueRef;
  /** Accepted work that needs no published issue. Defaults to `awaiting_publication` until an
   * issue is recorded. */
  publicationRequired?: boolean;
}

export interface AdjudicateCampaignRecommendationResponse {
  revision: number;
  recommendation: CampaignRecommendation;
  workItem: CampaignWorkItemSummary | null;
}

/** `get_campaign_work_items`: the Orchestrator's own paginated read. */
export interface GetCampaignWorkItemsRequest extends CampaignWorkItemsQuery {
  /** Return one item's detail instead of a page. */
  workItemId?: string;
  /** Include recommendations, awaiting adjudication first (bounded by `limit`). */
  includeRecommendations?: boolean;
}

export interface GetCampaignWorkItemsResponse {
  summary: CampaignWorkSummary;
  page?: CampaignWorkItemsPage;
  item?: CampaignWorkItemDetail;
  recommendations?: CampaignRecommendation[];
}
