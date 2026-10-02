/**
 * PROVISIONAL: the campaign work ledger read contract (#2417), transcribed from the campaign plan
 * until the protocol package publishes it. Every Campaign Status module imports these names from
 * here and nowhere else, so binding to `@wollipog/protocol` is a change to this one file.
 */

export const CAMPAIGN_WORK_STATES = [
  "planned", "queued", "running", "waiting", "blocked", "delivered", "cancelled", "removed",
] as const;
export type CampaignWorkState = (typeof CAMPAIGN_WORK_STATES)[number];

export type CampaignWorkOrigin = "original" | "follow_up";
export type CampaignPlanState = "recorded" | "not_recorded" | "partial";
export type CampaignCostSource = "providerReported" | "modelPriced" | "unpriced";
export type CampaignCostCoverage = "complete" | "partial" | "unavailable";
export type CampaignRecommendationDisposition =
  "awaiting_adjudication" | "accepted" | "rejected" | "deferred" | "duplicate";

export interface CampaignIssueRef {
  repository: string;
  number: number;
}

export interface CampaignCost {
  /** Null when nothing could be attributed; a known zero is 0. */
  totalUsd: number | null;
  workItemsUsd: number | null;
  coordinationUsd: number | null;
  unattributedUsd: number | null;
  source: CampaignCostSource | null;
  unpricedRecords: number;
  coverage: CampaignCostCoverage;
}

export interface CampaignWorkSummary {
  revision: number;
  planState: CampaignPlanState;
  coverage: { untrackedChildren: number };
  counts: {
    committed: number;
    delivered: number;
    original: number;
    followUp: number;
    byState: Record<CampaignWorkState, number>;
  };
  recommendations: Record<CampaignRecommendationDisposition, number>;
  obligations: { verification: number; adjudication: number; cleanup: number };
  elapsed: { startedAt: number; completedAt: number | null };
  /** Null when the viewer may not see cost, or the server has no accounting yet. */
  cost: CampaignCost | null;
}

export interface CampaignMembership {
  campaignSessionId: string;
  currentWorkItemId: string | null;
}

export interface CampaignWorkItem {
  id: string;
  key: string;
  issue: CampaignIssueRef | null;
  title: string | null;
  origin: CampaignWorkOrigin;
  generation: number;
  state: CampaignWorkState;
  queuePosition: number | null;
  /** Latest recorded activity on the item, for the Activity sort. */
  lastActivityAt: number | null;
  /** First execution attempt start; null for work that has not started. */
  startedAt: number | null;
  /** Verified delivery (or cancellation) time; null while unfinished. */
  endedAt: number | null;
  /** When the item was recorded, so planned work can show its age instead of an elapsed time. */
  recordedAt: number;
  cost: CampaignCost | null;
  currentSessionId: string | null;
}

export type CampaignWorkSort = "queue" | "activity" | "time" | "cost";
export type CampaignWorkStateFilter = "unfinished" | "finished" | "all" | CampaignWorkState;
export type CampaignWorkOriginFilter = "all" | CampaignWorkOrigin;

export interface CampaignWorkItemPage {
  revision: number;
  items: CampaignWorkItem[];
  nextCursor: string | null;
}

export type CampaignFactFreshness =
  | { state: "fresh" }
  | { state: "stale" }
  | { state: "unavailable"; reason: string };

export interface CampaignObservedFact {
  kind: "session_status" | "pull_request" | "review" | "checks" | "merge_queue";
  value: string;
  observedAt: number | null;
  freshness: CampaignFactFreshness;
}

export type CampaignReportedStageKind =
  "implementing" | "in_review" | "awaiting_checks" | "awaiting_approval" | "merge_queued" | "merged" | "cleanup";

export interface CampaignReportedStage {
  stage: CampaignReportedStageKind;
  note: string | null;
  pullRequests: CampaignIssueRef[];
  sourceSessionId: string;
  reportedAt: number;
}

export interface CampaignAttempt {
  id: string;
  sessionId: string | null;
  sessionTitle: string;
  harness: string | null;
  model: string | null;
  effort: string | null;
  startedAt: number;
  endedAt: number | null;
  endReason: "delivered" | "reassigned" | "superseded" | "abandoned" | "failed" | null;
  cost: CampaignCost | null;
}

export interface CampaignWorkItemVerification {
  attemptId: string;
  outcome: "delivered" | "incomplete";
  verifiedBySessionId: string;
  verifiedAt: number;
}

export interface CampaignWorkItemDetail extends CampaignWorkItem {
  commitment: { state: "committed" | "cancelled" | "scope_removed"; reason: string | null };
  dependsOn: { id: string; title: string | null; issue: CampaignIssueRef | null; state: CampaignWorkState }[];
  originWorkItems: { id: string; title: string | null; issue: CampaignIssueRef | null }[];
  pullRequests: CampaignIssueRef[];
  blocker: string | null;
  responsibleActor: string | null;
  nextAction: string | null;
  reportedStage: CampaignReportedStage | null;
  observed: CampaignObservedFact[];
  attempts: CampaignAttempt[];
  verification: CampaignWorkItemVerification | null;
  /** Each measurement is null when its intervals were not recorded; 0 is a real zero. */
  time: { queueMs: number | null; waitingMs: number | null; activeMs: number | null };
}

/** The snapshot capability that says the control plane serves the work ledger to browsers. */
export function snapshotSupportsCampaignWork(capabilities: object | undefined): boolean {
  return (capabilities as { campaignWork?: unknown } | undefined)?.campaignWork === true;
}

/** The lightweight summary the root session carries in its campaign projection. */
export function campaignWorkSummaryOf(campaign: object | null | undefined): CampaignWorkSummary | null {
  return (campaign as { work?: CampaignWorkSummary } | null | undefined)?.work ?? null;
}

/** A descendant's campaign membership as the server reports it on its session view. */
export function campaignMembershipOf(session: object): CampaignMembership | null {
  return (session as { campaignMembership?: CampaignMembership | null }).campaignMembership ?? null;
}

/** `GET /campaign/summary`: the summary plus the projection facts a member cannot read itself. */
export interface CampaignWorkSummaryResponse {
  campaignSessionId: string;
  campaignTitle: string;
  status: string;
  limits: { maximumConcurrentChildren: number; occupied: number; remaining: number; costBudgetUsd: number | null } | null;
  work: CampaignWorkSummary;
}
