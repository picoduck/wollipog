/**
 * Durable campaign work ledger (docs/campaign-work-ledger.md). Every row is keyed by the ROOT
 * campaign; callers resolve it first. Nothing here grants authority: no method admits a child,
 * publishes, merges, or touches a workflow decision.
 *
 * Every mutation that changes the ledger increments its revision exactly once, in the same
 * transaction. A repeated no-op changes nothing. Reads never write.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CAMPAIGN_ATTEMPT_ID_PREFIX,
  CAMPAIGN_REPORTED_STAGES,
  CAMPAIGN_WORK_DELIVERY_ID_PREFIX,
  CAMPAIGN_WORK_ITEM_ID_PREFIX,
  CAMPAIGN_WORK_ITEM_PRIMARY_STATES,
  CAMPAIGN_WORK_ITEM_UNFINISHED_STATES,
  CAMPAIGN_WORK_LEDGER_LIMITS,
  CAMPAIGN_WORK_REVISION_CHANGED,
  CAMPAIGN_WORK_VERIFICATION_ID_PREFIX,
  campaignRepositoryLocation,
  ISSUE_CLOSURE_EXCLUSION_ISSUES_MAX,
  type IssueClosureExclusionReason,
  type CampaignWorkRepositoryCounts,
  type AdjudicateCampaignRecommendationRequest,
  type AgentHarnessIdentity,
  type CampaignAttempt,
  type CampaignAttemptBoundary,
  type CampaignAttemptEndReason,
  type CampaignAttemptSessionSnapshot,
  type CampaignCostValue,
  type CampaignFollowUpSubject,
  type CampaignIssueRef,
  type CampaignObservedCleanup,
  type CampaignObservedFact,
  type CampaignObservedSessionStatus,
  type CampaignMetric,
  type CampaignPlanState,
  type CampaignPullRequestRef,
  type CampaignRecommendation,
  type CampaignRecommendationDisposition,
  type CampaignRecommendationsPage,
  type CampaignRecommendationsQuery,
  type CampaignReportedStage,
  type CampaignResponsibleActor,
  type CampaignWorkItemCommitmentState,
  type CampaignWorkItemDetail,
  type CampaignWorkItemDispatchState,
  type CampaignWorkItemHandoff,
  type CampaignWorkItemOrigin,
  type CampaignWorkItemPrimaryState,
  type CampaignWorkItemRecordedDelivery,
  type CampaignWorkItemSummary,
  type CampaignWorkItemTimes,
  type CampaignWorkItemVerification,
  type CampaignWorkItemVerificationOutcome,
  type CampaignWorkItemsPage,
  type CampaignWorkItemsQuery,
  type CampaignWorkSummary,
  type OrchestratorCampaignHandoff,
  type RecordCampaignPlanRequest,
  type RecordCampaignPlanResponse,
  type UpdateCampaignWorkItemRequest,
} from "@wollipog/protocol";
import {
  deriveCampaignWorkItemStates,
  type CampaignAttemptSessionObservation,
  type CampaignWorkItemDerivedState,
} from "./campaign-work-state.js";
import {
  CAMPAIGN_USAGE_NONE,
  CampaignWorkAccounting,
  addCampaignUsage,
  campaignCostMetric,
  type CampaignUsageAmount,
} from "./campaign-work-accounting.js";
import { campaignItemDurations, campaignItemTimelines } from "./campaign-work-times.js";
import {
  campaignItemRepository,
  campaignItemRepositories,
  campaignMergeDependencyStatus,
  campaignMergeDependencyView,
  isCampaignMergeDependency,
  type CampaignMergePrerequisite,
} from "./campaign-merge-dependencies.js";

/** Tables, in SCHEMA order. Child-session references are SET NULL so history survives a child's
 * deletion; the root campaign reference cascades, so deleting the root deletes its ledger. */
export const CAMPAIGN_WORK_LEDGER_SCHEMA = `
-- One row per root campaign that has ever recorded ledger state. The revision increments once per
-- ledger mutation and is the Read API's invalidation and cursor binding.
CREATE TABLE IF NOT EXISTS campaign_work_ledgers (
  campaign_session_id TEXT PRIMARY KEY,
  revision            INTEGER NOT NULL DEFAULT 0,
  plan_state          TEXT NOT NULL DEFAULT 'not_recorded'
                      CHECK (plan_state IN ('not_recorded','partial','recorded')),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (campaign_session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS campaign_fixed_by (
  campaign_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  issue_repository TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  work_item_ids TEXT NOT NULL,
  PRIMARY KEY (campaign_session_id, issue_repository, issue_number)
);

CREATE TABLE IF NOT EXISTS campaign_work_items (
  id                     TEXT PRIMARY KEY,
  campaign_session_id    TEXT NOT NULL,
  item_key               TEXT NOT NULL,
  title                  TEXT,
  issue_repository       TEXT,
  issue_number           INTEGER,
  origin                 TEXT NOT NULL CHECK (origin IN ('original','follow_up')),
  generation             INTEGER NOT NULL DEFAULT 0,
  dispatch_state         TEXT NOT NULL CHECK (dispatch_state IN ('planned','queued')),
  queue_position         INTEGER,
  commitment             TEXT NOT NULL DEFAULT 'committed'
                         CHECK (commitment IN ('committed','cancelled','scope_removed')),
  commitment_reason      TEXT,
  commitment_changed_at  INTEGER NOT NULL,
  commitment_changed_by  TEXT,
  stage                  TEXT CHECK (stage IN ('implementing','in_review','awaiting_checks',
                         'awaiting_approval','merge_queued','merged','cleanup')),
  stage_note             TEXT,
  stage_pull_requests    TEXT,
  stage_source_session_id TEXT,
  stage_reported_at      INTEGER,
  blocker_reason         TEXT,
  blocker_actor          TEXT CHECK (blocker_actor IN ('human','orchestrator','child','external')),
  blocker_request_occurrence_id TEXT,
  blocker_recorded_at    INTEGER,
  blocker_recorded_by    TEXT,
  next_action            TEXT,
  created_by_session_id  TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  UNIQUE (campaign_session_id, item_key),
  CHECK ((issue_repository IS NULL) = (issue_number IS NULL)),
  FOREIGN KEY (campaign_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (commitment_changed_by) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (stage_source_session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (blocker_recorded_by) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS campaign_work_item_dependencies (
  work_item_id  TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  PRIMARY KEY (work_item_id, depends_on_id),
  CHECK (work_item_id <> depends_on_id),
  FOREIGN KEY (work_item_id) REFERENCES campaign_work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_id) REFERENCES campaign_work_items(id) ON DELETE CASCADE
);

-- One work item executed by one session. Snapshots keep the attempt readable after the session
-- is deleted. The partial unique indexes enforce one open attempt per item and per session.
CREATE TABLE IF NOT EXISTS campaign_work_attempts (
  id                        TEXT PRIMARY KEY,
  campaign_session_id       TEXT NOT NULL,
  work_item_id              TEXT NOT NULL,
  ordinal                   INTEGER NOT NULL,
  session_id                TEXT,
  session_title             TEXT,
  harness                   TEXT,
  agent_name                TEXT,
  model                     TEXT,
  effort                    TEXT,
  assigned_by_session_id    TEXT,
  started_at                INTEGER NOT NULL,
  start_event_epoch         INTEGER,
  start_runner_history_epoch INTEGER,
  start_seq                 INTEGER,
  ended_at                  INTEGER,
  end_event_epoch           INTEGER,
  end_runner_history_epoch  INTEGER,
  end_seq                   INTEGER,
  end_reason                TEXT CHECK (end_reason IN ('delivered','reassigned','superseded','abandoned','failed')),
  end_note                  TEXT,
  UNIQUE (work_item_id, ordinal),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  FOREIGN KEY (campaign_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (work_item_id) REFERENCES campaign_work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (assigned_by_session_id) REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_work_attempts_open_item
  ON campaign_work_attempts(work_item_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_work_attempts_open_session
  ON campaign_work_attempts(session_id) WHERE ended_at IS NULL AND session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_campaign_work_attempts_session
  ON campaign_work_attempts(session_id);
CREATE INDEX IF NOT EXISTS idx_campaign_work_attempts_campaign
  ON campaign_work_attempts(campaign_session_id, work_item_id, ordinal);
-- Deleting an attempt's session changes what the ledger reads (the attempt loses its session and an
-- open one blocks its item), so it is a new revision whichever deletion path ran. Foreign-key
-- SET NULL actions fire update triggers. The campaign is also queued for a view refresh, since
-- after the deletion nothing else can name it; the next session removal drains the queue.
CREATE TABLE IF NOT EXISTS campaign_work_deleted_attempt_sessions (
  campaign_session_id TEXT PRIMARY KEY
);
CREATE TRIGGER IF NOT EXISTS campaign_work_attempt_session_deleted
  AFTER UPDATE OF session_id ON campaign_work_attempts
  WHEN OLD.session_id IS NOT NULL AND NEW.session_id IS NULL
BEGIN
  UPDATE campaign_work_ledgers SET revision=revision+1 WHERE campaign_session_id=NEW.campaign_session_id;
  -- An upsert, not OR IGNORE: the statement that fired the trigger would override that policy.
  INSERT INTO campaign_work_deleted_attempt_sessions (campaign_session_id)
    VALUES (NEW.campaign_session_id) ON CONFLICT(campaign_session_id) DO NOTHING;
END;

-- Delivery proof for one attempt. A later execution of the same child never invalidates it.
CREATE TABLE IF NOT EXISTS campaign_work_verifications (
  id                     TEXT PRIMARY KEY,
  campaign_session_id    TEXT NOT NULL,
  work_item_id           TEXT NOT NULL,
  attempt_id             TEXT NOT NULL,
  child_session_id       TEXT,
  outcome                TEXT NOT NULL CHECK (outcome IN ('delivered','incomplete')),
  report_seq             INTEGER NOT NULL,
  report_event_epoch     INTEGER,
  report_digest          TEXT,
  report_ts              INTEGER,
  verified_by_session_id TEXT,
  verified_at            INTEGER NOT NULL,
  FOREIGN KEY (campaign_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (work_item_id) REFERENCES campaign_work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id) REFERENCES campaign_work_attempts(id) ON DELETE CASCADE,
  FOREIGN KEY (child_session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (verified_by_session_id) REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_work_verifications_item
  ON campaign_work_verifications(work_item_id, verified_at);

-- v275 (#4070): an item's current handoff. Assigning the item again deletes it.
CREATE TABLE IF NOT EXISTS campaign_work_handoffs (
  work_item_id        TEXT PRIMARY KEY,
  campaign_session_id TEXT NOT NULL,
  responsible_actor   TEXT NOT NULL CHECK (responsible_actor IN ('human','orchestrator','child','external')),
  reason              TEXT NOT NULL,
  next_action         TEXT NOT NULL,
  recorded_at         INTEGER NOT NULL,
  recorded_by         TEXT,
  FOREIGN KEY (work_item_id) REFERENCES campaign_work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (campaign_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (recorded_by) REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_work_handoffs_campaign
  ON campaign_work_handoffs(campaign_session_id);

-- v275 (#4070): delivery recorded from checked evidence. It holds while no attempt was opened on the
-- item after it: after_ordinal is the item's highest attempt ordinal when it was recorded.
CREATE TABLE IF NOT EXISTS campaign_work_deliveries (
  id                      TEXT PRIMARY KEY,
  campaign_session_id     TEXT NOT NULL,
  work_item_id            TEXT NOT NULL,
  after_ordinal           INTEGER NOT NULL,
  pull_requests           TEXT NOT NULL,
  report_child_session_id TEXT,
  report_attempt_id       TEXT,
  report_seq              INTEGER,
  evidence_key            TEXT NOT NULL,
  note                    TEXT,
  recorded_by             TEXT,
  recorded_at             INTEGER NOT NULL,
  FOREIGN KEY (campaign_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (work_item_id) REFERENCES campaign_work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (report_child_session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (report_attempt_id) REFERENCES campaign_work_attempts(id) ON DELETE CASCADE,
  FOREIGN KEY (recorded_by) REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_work_deliveries_campaign
  ON campaign_work_deliveries(campaign_session_id, work_item_id, recorded_at);

-- Recommendation (follow-up) extensions. A missing disposition row means awaiting adjudication,
-- or duplicate for a row the server already deduplicated.
CREATE TABLE IF NOT EXISTS campaign_recommendation_origins (
  recommendation_id TEXT NOT NULL,
  work_item_id      TEXT NOT NULL,
  PRIMARY KEY (recommendation_id, work_item_id),
  FOREIGN KEY (recommendation_id) REFERENCES orchestrator_campaign_follow_ups(id) ON DELETE CASCADE,
  FOREIGN KEY (work_item_id) REFERENCES campaign_work_items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_campaign_recommendation_origins_item
  ON campaign_recommendation_origins(work_item_id);
CREATE TABLE IF NOT EXISTS campaign_recommendation_dispositions (
  recommendation_id         TEXT PRIMARY KEY,
  disposition               TEXT NOT NULL CHECK (disposition IN ('accepted','rejected','deferred','duplicate')),
  reason                    TEXT NOT NULL,
  publication_required      INTEGER NOT NULL DEFAULT 1,
  resulting_issue_repository TEXT,
  resulting_issue_number    INTEGER,
  resulting_work_item_id    TEXT,
  adjudicated_by_session_id TEXT,
  adjudicated_at            INTEGER NOT NULL,
  FOREIGN KEY (recommendation_id) REFERENCES orchestrator_campaign_follow_ups(id) ON DELETE CASCADE,
  FOREIGN KEY (resulting_work_item_id) REFERENCES campaign_work_items(id) ON DELETE SET NULL,
  FOREIGN KEY (adjudicated_by_session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

-- Issue-closure attribution history (#3084). Every issue an item has ever tracked, and every
-- follow-up link from an origin item to a resulting item ever recorded. Rows are only ever added
-- (as upserts: a trigger fired by an upsert would otherwise inherit its conflict policy), so a
-- later edit of an item's issue or a re-adjudication cannot make a child look unrelated.
-- History before this schema is unknown, so the first application marks every item that already
-- exists as legacy, and a legacy item never counts as unrelated. The marker row makes that a
-- one-time step; later applications mark nothing.
CREATE TABLE IF NOT EXISTS campaign_work_attribution_start (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
);
CREATE TABLE IF NOT EXISTS campaign_work_legacy_items (
  work_item_id TEXT PRIMARY KEY,
  FOREIGN KEY (work_item_id) REFERENCES campaign_work_items(id) ON DELETE CASCADE
);
INSERT INTO campaign_work_legacy_items (work_item_id)
  SELECT id FROM campaign_work_items WHERE NOT EXISTS (SELECT 1 FROM campaign_work_attribution_start)
  ON CONFLICT DO NOTHING;
INSERT INTO campaign_work_attribution_start (singleton) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS campaign_work_item_issue_history (
  work_item_id     TEXT NOT NULL,
  issue_repository TEXT NOT NULL,
  issue_number     INTEGER NOT NULL,
  PRIMARY KEY (work_item_id, issue_repository, issue_number),
  FOREIGN KEY (work_item_id) REFERENCES campaign_work_items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_campaign_work_item_issue_history_issue
  ON campaign_work_item_issue_history(issue_repository, issue_number);
CREATE TRIGGER IF NOT EXISTS campaign_work_item_issue_recorded
  AFTER INSERT ON campaign_work_items WHEN NEW.issue_number IS NOT NULL
BEGIN
  INSERT INTO campaign_work_item_issue_history (work_item_id, issue_repository, issue_number)
    VALUES (NEW.id, lower(NEW.issue_repository), NEW.issue_number)
    ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS campaign_work_item_issue_changed
  AFTER UPDATE OF issue_repository, issue_number ON campaign_work_items WHEN NEW.issue_number IS NOT NULL
BEGIN
  INSERT INTO campaign_work_item_issue_history (work_item_id, issue_repository, issue_number)
    VALUES (NEW.id, lower(NEW.issue_repository), NEW.issue_number)
    ON CONFLICT DO NOTHING;
END;

CREATE TABLE IF NOT EXISTS campaign_work_lineage_edges (
  origin_work_item_id TEXT NOT NULL,
  result_work_item_id TEXT NOT NULL,
  PRIMARY KEY (origin_work_item_id, result_work_item_id),
  FOREIGN KEY (origin_work_item_id) REFERENCES campaign_work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (result_work_item_id) REFERENCES campaign_work_items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_campaign_work_lineage_edges_result
  ON campaign_work_lineage_edges(result_work_item_id);
CREATE TRIGGER IF NOT EXISTS campaign_work_lineage_edge_origin
  AFTER INSERT ON campaign_recommendation_origins
BEGIN
  INSERT INTO campaign_work_lineage_edges (origin_work_item_id, result_work_item_id)
    SELECT NEW.work_item_id, resulting_work_item_id FROM campaign_recommendation_dispositions
    WHERE recommendation_id=NEW.recommendation_id AND resulting_work_item_id IS NOT NULL
    ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS campaign_work_lineage_edge_adjudicated
  AFTER INSERT ON campaign_recommendation_dispositions WHEN NEW.resulting_work_item_id IS NOT NULL
BEGIN
  INSERT INTO campaign_work_lineage_edges (origin_work_item_id, result_work_item_id)
    SELECT work_item_id, NEW.resulting_work_item_id FROM campaign_recommendation_origins
    WHERE recommendation_id=NEW.recommendation_id
    ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS campaign_work_lineage_edge_readjudicated
  AFTER UPDATE OF resulting_work_item_id ON campaign_recommendation_dispositions
  WHEN NEW.resulting_work_item_id IS NOT NULL
BEGIN
  INSERT INTO campaign_work_lineage_edges (origin_work_item_id, result_work_item_id)
    SELECT work_item_id, NEW.resulting_work_item_id FROM campaign_recommendation_origins
    WHERE recommendation_id=NEW.recommendation_id
    ON CONFLICT DO NOTHING;
END;
`;

/** `details` carries machine-readable fields a client acts on, such as `revision_changed`. */
export type LedgerResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; details?: Record<string, string | number> };

const fail = <T>(error: string, status = 400, details?: Record<string, string | number>): LedgerResult<T> =>
  ({ ok: false, status, error, ...(details ? { details } : {}) });
const done = <T>(data: T): LedgerResult<T> => ({ ok: true, data });

/** What a follow-up admission binds (#2940): the work item's title and the issue it tracks. */
export interface CampaignFollowUpContent { title: string | null; issue: CampaignIssueRef | null }

const itemIssue = (repository: string | null, number: number | null): CampaignIssueRef | null =>
  repository !== null && number !== null ? { repository, number } : null;

/** What the ledger needs from the rest of the control plane. Observations must read raw session
 * rows: a SessionView embeds the campaign projection, which would recurse. */
export interface CampaignWorkLedgerHooks {
  observeSession(sessionId: string): CampaignAttemptSessionObservation | null;
  /** How current the control plane's copy of a session is: fresh while its runner is connected,
   * otherwise last known as of the row's update time. Null when the session is gone. */
  observationFreshness(sessionId: string): { fresh: boolean; updatedAt: number } | null;
  /** The session's worktrees in the existing campaign cleanup vocabulary, plus `retired` for a
   * recorded worktree the session no longer holds. Null when the session is gone. */
  observeCleanup(sessionId: string): CampaignObservedCleanup["worktrees"] | null;
  boundary(sessionId: string): CampaignAttemptBoundary;
  atomic<T>(work: () => T): T;
  /** Why a child may not be dispatched on an item tracking this issue, or null when it may (#4062).
   * Recording the item is unaffected; only opening an attempt on it is checked. */
  admitDispatch?(campaignId: string, issue: CampaignIssueRef | null): string | null;
  /** Counts a new follow-up work item against the campaign allowance: null when accepted, else the
   * refusal, whose `details` name a follow-up that needs the Human's approval (#2940). */
  acceptFollowUp?(campaignId: string, workItemId: string, subject: CampaignFollowUpSubject, content: CampaignFollowUpContent):
    { error: string; details?: Record<string, string | number> } | null;
  /** A change to a follow-up item's title or issue: null when allowed, else the refusal. A follow-up
   * admitted past the approval limit stays bound to what the Human approved (#2940). */
  reviseFollowUp?(campaignId: string, workItemId: string, content: CampaignFollowUpContent):
    { error: string; details?: Record<string, string | number> } | null;
  /** Slice 8: the stored GitHub facts of these pull requests, one per ref in order. Status data
   * only; the read routes narrow it for readers who may not see the observing runner. */
  forgePullRequests?(campaignId: string, refs: readonly CampaignPullRequestRef[], now: number):
    NonNullable<CampaignWorkItemDetail["observed"]["pullRequests"]>;
  /** #4120: the consumed `pr_merge` gates these sessions passed, as closure proof reads them
   * (`deliveryCandidates`), so a dependent's own merge is judged the same way. */
  consumedPullRequestMerges?(sessionIds: readonly string[]): Array<{ sessionId: string; createdAt: number; repository: string;
    pullRequest: number; headSha: string; intendedClosures?: readonly string[] }>;
  /** #4120: the campaign repository whose Location this session is placed in, lower-cased, or null.
   * A server fact (#4119), never agent text. Reads rows only. */
  sessionRepository?(campaignId: string, sessionId: string): string | null;
  /** #4120: whether this session holds an approved `pr_merge` whose enqueue is armed and not yet
   * consumed. Its provider may run that command without asking the control plane again, so a
   * dependency added now could not hold it. */
  armedMerge?(sessionId: string): boolean;
  /** #4120: every armed, unconsumed `pr_merge` of this campaign: its occurrence, requester and pull request. */
  armedMerges?(campaignId: string): Array<{ occurrenceId: string; sessionId: string; pullRequest: CampaignPullRequestRef }>;
  /** #4120: the campaign's repositories, lower-cased, launch repository first; empty for a campaign
   * that records none (from before #4117). */
  campaignRepositories?(campaignId: string): string[];
}

/** What `summary` derives from the ledger alone. Cached per campaign under the revision plus the
 * observed status of every open attempt's session, which together determine it. */
interface LedgerSummaryPart {
  revision: number;
  planState: CampaignPlanState;
  ledgerCreatedAt: number | null;
  counts: CampaignWorkSummary["counts"];
  recommendations: CampaignWorkSummary["recommendations"];
  verification: number;
  publication: number;
  /** Unfinished committed items handed to `human` or `external`, oldest handoff first (#4070). */
  handoffs: OrchestratorCampaignHandoff[];
  /** Unfinished committed items without such a handoff: work an agent still owns. */
  agentUnfinished: Array<{ id: string; origin: CampaignWorkItemOrigin; issue: CampaignIssueRef | null }>;
}

/** Campaigns whose summary part stays cached. A miss only costs one recomputation. */
const SUMMARY_CACHE_CAMPAIGNS = 64;

interface ItemRow {
  id: string; campaign_session_id: string; item_key: string; title: string | null;
  issue_repository: string | null; issue_number: number | null; origin: CampaignWorkItemOrigin;
  generation: number; dispatch_state: CampaignWorkItemDispatchState; queue_position: number | null;
  commitment: CampaignWorkItemCommitmentState; commitment_reason: string | null;
  commitment_changed_at: number; commitment_changed_by: string | null;
  stage: CampaignReportedStage["stage"] | null; stage_note: string | null; stage_pull_requests: string | null;
  stage_source_session_id: string | null; stage_reported_at: number | null;
  blocker_reason: string | null; blocker_actor: CampaignResponsibleActor | null;
  blocker_request_occurrence_id: string | null; blocker_recorded_at: number | null;
  blocker_recorded_by: string | null; next_action: string | null; created_at: number; updated_at: number;
}

interface AttemptRow {
  id: string; campaign_session_id: string; work_item_id: string; ordinal: number; session_id: string | null; session_title: string | null;
  harness: string | null; agent_name: string | null; model: string | null; effort: string | null;
  assigned_by_session_id: string | null; started_at: number; start_event_epoch: number | null;
  start_runner_history_epoch: number | null; start_seq: number | null; ended_at: number | null;
  end_event_epoch: number | null; end_runner_history_epoch: number | null; end_seq: number | null;
  end_reason: CampaignAttemptEndReason | null; end_note: string | null;
}

interface VerificationRow {
  id: string; work_item_id: string; attempt_id: string; child_session_id: string | null;
  outcome: CampaignWorkItemVerificationOutcome; report_seq: number; report_event_epoch: number | null;
  report_digest: string | null; report_ts: number | null; verified_by_session_id: string | null; verified_at: number;
}

interface HandoffRow {
  work_item_id: string; responsible_actor: CampaignResponsibleActor; reason: string; next_action: string;
  recorded_at: number; recorded_by: string | null;
}

interface DeliveryRow {
  id: string; work_item_id: string; after_ordinal: number; pull_requests: string;
  report_child_session_id: string | null; report_attempt_id: string | null; report_seq: number | null;
  evidence_key: string; note: string | null; recorded_by: string | null; recorded_at: number;
}

/** Handoffs that let a campaign finish without the item (#4070). Any other one still blocks it. */
const TERMINAL_HANDOFF_ACTORS: ReadonlySet<CampaignResponsibleActor> = new Set(["human", "external"]);

/** Checked evidence for `recordDelivery`: the forge facts were read by the caller just before. */
export interface CampaignDeliveryEvidence {
  workItemId: string;
  pullRequests: Array<CampaignPullRequestRef & { mergeCommitSha: string; baseRef: string }>;
  report: { childSessionId: string; seq: number; eventEpoch: number | null; digest: string | null; ts: number | null } | null;
  note: string | null;
}

interface RecommendationRow {
  id: string; origin_session_id: string | null; repository: string; title: string;
  recommendation_key: string | null; duplicate_of: string | null; created_at: number;
  disposition: Exclude<CampaignRecommendationDisposition, "awaiting_adjudication"> | null;
  reason: string | null; publication_required: number | null; resulting_issue_repository: string | null;
  resulting_issue_number: number | null; resulting_work_item_id: string | null;
  adjudicated_by_session_id: string | null; adjudicated_at: number | null;
}

/** The ledger state of one campaign, loaded once per read and derived in memory. Bounded by
 * CAMPAIGN_WORK_LEDGER_LIMITS.workItemsPerCampaign. */
interface LedgerSnapshot {
  revision: number;
  planState: CampaignPlanState;
  ledgerCreatedAt: number | null;
  items: ItemRow[];
  dependencies: Map<string, string[]>;
  attempts: Map<string, AttemptRow[]>;
  verifications: Map<string, VerificationRow[]>;
  handoffs: Map<string, HandoffRow>;
  deliveries: Map<string, DeliveryRow[]>;
  derived: Map<string, CampaignWorkItemDerivedState>;
  /** #4120: items with a delivered verification whose state is not delivered, since their own pull
   * requests have not merged and a merge dependency holds them. */
  verifiedHeld: ReadonlySet<string>;
  /** #4120: each item's repository, and its prerequisites in other repositories. */
  repositories: Map<string, string | null>;
  mergePrerequisites: Map<string, CampaignMergePrerequisite[]>;
  /** An item's merge prerequisites as a dependent working in `dependentRepositories`. */
  prerequisitesOf(itemId: string, dependentRepositories: readonly string[]): CampaignMergePrerequisite[];
  /** A merge's prerequisites: those of every item naming the pull request and of `workItemId`, as
   * dependents in the pull request's repository. */
  prerequisitesForMerge(pullRequest: CampaignPullRequestRef, workItemId: string | null): CampaignMergePrerequisite[];
  observations: Map<string, CampaignAttemptSessionObservation | null>;
  /** Usage attributed to each attempt (slice 6). */
  usage: Map<string, CampaignUsageAmount>;
  /** When interval recording and usage attribution began; null before it has. */
  accountingStartedAt: number | null;
}

const L = CAMPAIGN_WORK_LEDGER_LIMITS;
/** The accepted ref shape, named in every refusal of one. */
const REF_SHAPE = `{repository: "owner/repo" or "<gitlab-host>/group/project", number}`;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !CONTROL.test(value);
}

function validIssue(value: unknown): value is CampaignIssueRef {
  const issue = value as CampaignIssueRef | null;
  return typeof issue === "object" && issue !== null && typeof issue.repository === "string" &&
    campaignRepositoryLocation(issue.repository) !== null &&
    Number.isSafeInteger(issue.number) && issue.number >= 1;
}

function validQueuePosition(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function validPullRequests(value: unknown): value is CampaignPullRequestRef[] {
  return Array.isArray(value) && value.length <= L.pullRequestsPerStage && value.every(validIssue);
}

/** Pull requests in first-seen order, one per repository (case-insensitive) and number. */
function uniquePullRequests(refs: readonly CampaignPullRequestRef[]): CampaignPullRequestRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.repository.toLowerCase()}#${ref.number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The pull requests an item's reported stage names (slice 8 observes these). */
function stagePullRequests(item: ItemRow): CampaignPullRequestRef[] {
  return uniquePullRequests(item.stage_pull_requests ? JSON.parse(item.stage_pull_requests) as CampaignPullRequestRef[] : []);
}

const forgeRefKeyOf = (ref: CampaignPullRequestRef) => `${ref.repository.toLowerCase()}#${ref.number}`;

/** Every pull request an item names (#4120): its reported stage's, then its recorded deliveries'. */
function namedPullRequests(item: ItemRow, deliveries: readonly DeliveryRow[] | undefined): CampaignPullRequestRef[] {
  return uniquePullRequests([...stagePullRequests(item), ...(deliveries ?? []).flatMap((row) =>
    (JSON.parse(row.pull_requests) as CampaignPullRequestRef[]).map((ref) => ({ repository: ref.repository, number: ref.number })))]);
}

function newId(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/gu, "")}`;
}

function issueOf(repository: string | null, number: number | null): CampaignIssueRef | null {
  return repository !== null && number !== null ? { repository, number } : null;
}

const FINISHED_STATES: ReadonlySet<CampaignWorkItemPrimaryState> = new Set(["delivered", "cancelled", "removed"]);

/** The item's latest recorded delivery while it still holds: no attempt opened after it (#4070). */
function currentDelivery(rows: readonly DeliveryRow[] | undefined, latest: AttemptRow | undefined): DeliveryRow | null {
  const delivery = rows?.at(-1);
  return delivery && delivery.after_ordinal === (latest?.ordinal ?? 0) ? delivery : null;
}

function handoffView(row: HandoffRow): CampaignWorkItemHandoff {
  return {
    responsibleActor: row.responsible_actor,
    reason: row.reason,
    nextAction: row.next_action,
    recordedAt: row.recorded_at,
    recordedBySessionId: row.recorded_by,
  };
}

function deliveryView(row: DeliveryRow): CampaignWorkItemRecordedDelivery {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    pullRequests: JSON.parse(row.pull_requests) as CampaignWorkItemRecordedDelivery["pullRequests"],
    report: row.report_attempt_id !== null && row.report_seq !== null
      ? { childSessionId: row.report_child_session_id, attemptId: row.report_attempt_id, seq: row.report_seq }
      : null,
    note: row.note,
    recordedBySessionId: row.recorded_by,
    recordedAt: row.recorded_at,
  };
}

function observationKey(observation: CampaignAttemptSessionObservation | null): string {
  return observation
    ? `${observation.status}:${observation.archived ? 1 : 0}:${observation.held ? 1 : 0}:${observation.pendingRequests}`
    : "deleted";
}

/** Whether a reader may see a session's cost (the existing session-cost rule: session access). */
export type SessionVisibility = (sessionId: string) => boolean;

const NOT_AUTHORIZED = { availability: "unavailable", reason: "not_authorized" } as const;

/** A deleted attempt session's share is visible to whoever may read the campaign itself. */
function visible(attempt: AttemptRow, canSeeSession: SessionVisibility | undefined): boolean {
  return !canSeeSession || canSeeSession(attempt.session_id ?? attempt.campaign_session_id);
}

/** #4120: each repository's counts by derived state, in the order its first item was recorded,
 * with items whose repository is unknown last. */
function repositoryCounts(snapshot: LedgerSnapshot): CampaignWorkRepositoryCounts[] {
  const counts = new Map<string | null, CampaignWorkRepositoryCounts>();
  for (const item of snapshot.items) {
    const repository = snapshot.repositories.get(item.id) ?? null;
    let entry = counts.get(repository);
    if (!entry) {
      entry = { repository, total: 0, byState: Object.fromEntries(CAMPAIGN_WORK_ITEM_PRIMARY_STATES.map((state) => [state, 0])) as CampaignWorkRepositoryCounts["byState"] };
      counts.set(repository, entry);
    }
    const state = snapshot.derived.get(item.id)?.state;
    if (state) entry.byState[state] += 1;
    entry.total += 1;
  }
  return [...counts.values()].sort((a, b) => Number(a.repository === null) - Number(b.repository === null));
}

function cursorKey(parts: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(parts).sort().map((key) => [key, parts[key] ?? null]));
}

/**
 * What a cursor binds besides its filter, sort, and revision, for orderings that move without a
 * ledger revision. `stamp` binds the exact order its reader saw (the cost sort, which moves as usage
 * arrives); a cursor minted under another stamp is refused like a stale revision. `at` is the time
 * the order was evaluated at (the elapsed sort, where every open item keeps growing): each later
 * page of the cursor is ordered at that same time, so within one revision its order cannot move.
 */
interface CursorBinding {
  stamp?: string;
  at?: number;
}

/** A cursor whose shape and filter key were checked; `null` is the first page. */
interface ParsedCursor {
  revision: number;
  offset: number;
  stamp: unknown;
  at: number | undefined;
}

function encodeCursor(revision: number, key: string, offset: number, binding: CursorBinding = {}): string {
  return Buffer.from(JSON.stringify({
    v: 1, r: revision, k: key, o: offset,
    ...(binding.stamp ? { s: binding.stamp } : {}),
    ...(binding.at !== undefined ? { t: binding.at } : {}),
  })).toString("base64url");
}

function parseCursor(cursor: string | undefined, key: string): LedgerResult<ParsedCursor | null> {
  if (cursor === undefined) return done(null);
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as
      { v?: unknown; r?: unknown; k?: unknown; o?: unknown; s?: unknown; t?: unknown };
    if (parsed.v !== 1 || !Number.isSafeInteger(parsed.r) || typeof parsed.k !== "string" ||
        !Number.isSafeInteger(parsed.o) || (parsed.o as number) < 0 ||
        (parsed.t !== undefined && (!Number.isSafeInteger(parsed.t) || (parsed.t as number) < 0))) {
      return fail("cursor is malformed");
    }
    if (parsed.k !== key) return fail("cursor belongs to a different filter or sort");
    return done({ revision: parsed.r as number, offset: parsed.o as number, stamp: parsed.s, at: parsed.t as number | undefined });
  } catch {
    return fail("cursor is malformed");
  }
}

function cursorOffset(cursor: ParsedCursor | null, revision: number, binding: CursorBinding = {}): LedgerResult<number> {
  if (!cursor) return done(0);
  if (cursor.revision !== revision || (cursor.stamp ?? undefined) !== binding.stamp || cursor.at !== binding.at) {
    return fail("the campaign ledger changed since this cursor was issued; restart from the first page", 409,
      { code: CAMPAIGN_WORK_REVISION_CHANGED, revision });
  }
  return done(cursor.offset);
}

function decodeCursor(cursor: string | undefined, revision: number, key: string): LedgerResult<number> {
  const parsed = parseCursor(cursor, key);
  return parsed.ok ? cursorOffset(parsed.data, revision) : parsed;
}

function pageLimit(limit: unknown): LedgerResult<number> {
  if (limit === undefined) return done(L.pageSizeDefault);
  return Number.isSafeInteger(limit) && (limit as number) >= 1 && (limit as number) <= L.pageSizeMax
    ? done(limit as number)
    : fail(`limit must be an integer from 1 to ${L.pageSizeMax}`);
}

export class CampaignWorkLedgerStore {
  private readonly statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  private readonly summaryCache = new Map<string, { key: string; part: LedgerSummaryPart }>();
  /** Time and cost (slice 6): durable intervals and usage attribution for the same campaigns. */
  readonly accounting: CampaignWorkAccounting;

  constructor(private readonly db: DatabaseSync, private readonly hooks: CampaignWorkLedgerHooks) {
    this.accounting = new CampaignWorkAccounting(db);
  }

  private stmt(sql: string): ReturnType<DatabaseSync["prepare"]> {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** #4120: for each armed, unconsumed merge of this campaign, the signature of everything that would
   * hold it: each merge prerequisite of the pull request (through the items naming it and its
   * requester's open attempt) with its commitment and the pull requests it names. One indexed read
   * when nothing is armed. */
  private armedMergeSignatures(campaignId: string, merges = this.hooks.armedMerges?.(campaignId) ?? []):
    Map<string, { pullRequest: CampaignPullRequestRef; signature: Set<string> }> {
    if (!merges.length) return new Map();
    const snapshot = this.snapshot(campaignId);
    return new Map(merges.map((merge) => {
      const prerequisites = snapshot.prerequisitesForMerge(merge.pullRequest, this.openAttemptItemFor(campaignId, merge.sessionId));
      const signature = new Set(prerequisites.map((prerequisite) => [prerequisite.id, prerequisite.commitment,
        ...prerequisite.pullRequests.map(({ ref }) => forgeRefKeyOf(ref)).sort()].join("|")));
      return [`${merge.occurrenceId}`, { pullRequest: merge.pullRequest, signature }];
    }));
  }

  private openAttemptItemFor(campaignId: string, sessionId: string): string | null {
    return (this.stmt(`SELECT work_item_id FROM campaign_work_attempts
      WHERE campaign_session_id=? AND session_id=? AND ended_at IS NULL LIMIT 1`).get(campaignId, sessionId) as { work_item_id: string } | undefined)?.work_item_id ?? null;
  }

  private itemKey(itemId: string): string {
    return (this.stmt("SELECT item_key FROM campaign_work_items WHERE id=?").get(itemId) as { item_key: string } | undefined)?.item_key ?? itemId;
  }

  /** Run one ledger mutation atomically. A refusal, returned or thrown, rolls back every write. */
  private transact<T>(campaignId: string, work: () => LedgerResult<T>): LedgerResult<T> {
    try {
      return this.hooks.atomic(() => {
        const merges = this.hooks.armedMerges?.(campaignId) ?? [];
        const armed = this.armedMergeSignatures(campaignId, merges);
        const result = work();
        if (!result.ok) throw new LedgerRefusal(result.error, result.status, result.details);
        // #4120: a merge already armed may run without asking the control plane again, so no mutation
        // may add anything that would hold it: a new merge prerequisite (a dependency, a prerequisite
        // moved into another repository, the armed child reassigned, an item newly naming the pull
        // request), or a change to a prerequisite's commitment or the pull requests it names. Removing
        // a prerequisite holds nothing more and stays allowed. The whole mutation is refused. Arming
        // never happens inside a ledger mutation, so the armed merges are the same afterwards.
        if (armed.size) {
          const after = this.armedMergeSignatures(campaignId, merges);
          for (const [occurrenceId, now] of after) {
            const before = armed.get(occurrenceId)!.signature;
            const gained = [...now.signature].find((entry) => !before.has(entry));
            if (gained) {
              throw new LedgerRefusal(`This change would add a hold to the merge of ${now.pullRequest.repository}#${now.pullRequest.number} ` +
                `(prerequisite ${this.itemKey(gained.split("|")[0]!)}), but that merge is already armed and nothing could hold it now. ` +
                "Make the change after that merge settles.", 409);
            }
          }
        }
        return result;
      });
    } catch (error) {
      if (error instanceof LedgerRefusal) return fail(error.message, error.status, error.details);
      throw error;
    }
  }

  /* ------------------------------ Revision ------------------------------ */

  revision(campaignId: string): number {
    const row = this.stmt("SELECT revision FROM campaign_work_ledgers WHERE campaign_session_id=?")
      .get(campaignId) as { revision: number } | undefined;
    return row?.revision ?? 0;
  }

  /** Increment the revision once; the caller is inside the mutation's transaction. */
  private bump(campaignId: string, now: number, planState?: CampaignPlanState): number {
    this.stmt(
      `INSERT INTO campaign_work_ledgers (campaign_session_id, revision, plan_state, created_at, updated_at)
       VALUES (?, 0, 'not_recorded', ?, ?) ON CONFLICT(campaign_session_id) DO NOTHING`,
    ).run(campaignId, now, now);
    this.stmt(
      `UPDATE campaign_work_ledgers SET revision=revision+1, updated_at=?,
         plan_state=COALESCE(?, plan_state) WHERE campaign_session_id=?`,
    ).run(now, planState ?? null, campaignId);
    return this.revision(campaignId);
  }

  /** A new revision for an observed change: an open attempt's session changed status, hold, or
   * pending requests. The ledger rows are unchanged, so the plan state is too. A campaign that has
   * never recorded anything has no cursor to invalidate and is left alone. */
  observedChanged(campaignId: string, now: number): number {
    this.stmt("UPDATE campaign_work_ledgers SET revision=revision+1, updated_at=? WHERE campaign_session_id=?")
      .run(now, campaignId);
    return this.revision(campaignId);
  }

  /** A new revision for every campaign with an open attempt, after something changed attempt
   * sessions in bulk without the hub observing it (startup settlement). */
  openAttemptsChanged(now: number): void {
    this.stmt(
      `UPDATE campaign_work_ledgers SET revision=revision+1, updated_at=?
       WHERE campaign_session_id IN (SELECT DISTINCT campaign_session_id FROM campaign_work_attempts WHERE ended_at IS NULL)`,
    ).run(now);
  }

  /** Campaigns whose attempt sessions were deleted since the last call, for a view refresh. */
  takeCampaignsWithDeletedAttemptSessions(): string[] {
    return (this.stmt("DELETE FROM campaign_work_deleted_attempt_sessions RETURNING campaign_session_id")
      .all() as Array<{ campaign_session_id: string }>).map((row) => row.campaign_session_id);
  }

  /** The open attempt a session is executing and a stable key for what the ledger observes of the
   * session, so a caller can tell when an observed change moves derived state. */
  observedAttempt(sessionId: string): { campaignSessionId: string; attemptId: string; key: string } | null {
    const assignment = this.currentAssignment(sessionId);
    if (!assignment) return null;
    return {
      campaignSessionId: assignment.campaignSessionId,
      attemptId: assignment.attemptId,
      key: observationKey(this.hooks.observeSession(sessionId)),
    };
  }

  /* ------------------------------ Lookups ------------------------------ */

  private item(campaignId: string, itemId: string): ItemRow | undefined {
    return this.stmt("SELECT * FROM campaign_work_items WHERE id=? AND campaign_session_id=?")
      .get(itemId, campaignId) as ItemRow | undefined;
  }

  /** A change to a follow-up item's title or issue, refused when it needs the Human (#2940). */
  private followUpRevision(campaignId: string, item: ItemRow, title: string | null, issueRepository: string | null,
    issueNumber: number | null): LedgerResult<never> | null {
    if (item.origin !== "follow_up" || title === item.title && issueRepository === item.issue_repository && issueNumber === item.issue_number) return null;
    const refused = this.hooks.reviseFollowUp?.(campaignId, item.id, { title, issue: itemIssue(issueRepository, issueNumber) });
    return refused ? fail<never>(refused.error, 409, refused.details) : null;
  }

  /** Retargeting dispatched work is a dispatch for its new issue, checked the same way (#4062). Linking
   * an accepted follow-up's published issue is not routed here: it must precede that issue's scope. */
  private retargetRefusal(campaignId: string, item: ItemRow, issueRepository: string | null,
    issueNumber: number | null): LedgerResult<never> | null {
    if (issueRepository === item.issue_repository && issueNumber === item.issue_number || !this.openAttemptForItem(item.id)) return null;
    const outside = this.hooks.admitDispatch?.(campaignId, itemIssue(issueRepository, issueNumber));
    return outside ? fail<never>(`work item ${item.item_key} has an open attempt, so it cannot be retargeted: ${outside}`, 409) : null;
  }

  private itemByKey(campaignId: string, key: string): ItemRow | undefined {
    return this.stmt("SELECT * FROM campaign_work_items WHERE campaign_session_id=? AND item_key=?")
      .get(campaignId, key) as ItemRow | undefined;
  }

  private openAttemptForItem(itemId: string): AttemptRow | undefined {
    return this.stmt("SELECT * FROM campaign_work_attempts WHERE work_item_id=? AND ended_at IS NULL")
      .get(itemId) as AttemptRow | undefined;
  }

  private openAttemptForSession(sessionId: string): AttemptRow | undefined {
    return this.stmt("SELECT * FROM campaign_work_attempts WHERE session_id=? AND ended_at IS NULL")
      .get(sessionId) as AttemptRow | undefined;
  }

  /** Ids that do not belong to this campaign are reported, never silently dropped. */
  missingItemIds(campaignId: string, ids: readonly string[]): string[] {
    return ids.filter((id) => !this.item(campaignId, id));
  }

  /** Membership seam for the Read API: the session's open attempt, if any. */
  currentAssignment(sessionId: string): { campaignSessionId: string; workItemId: string; attemptId: string } | null {
    const row = this.stmt(
      `SELECT campaign_session_id, work_item_id, id FROM campaign_work_attempts
       WHERE session_id=? AND ended_at IS NULL`,
    ).get(sessionId) as { campaign_session_id: string; work_item_id: string; id: string } | undefined;
    return row ? { campaignSessionId: row.campaign_session_id, workItemId: row.work_item_id, attemptId: row.id } : null;
  }

  /** Sessions with at least one attempt in this campaign, for coverage. */
  attemptedSessionIds(campaignId: string): Set<string> {
    return new Set((this.stmt(
      "SELECT DISTINCT session_id FROM campaign_work_attempts WHERE campaign_session_id=? AND session_id IS NOT NULL",
    ).all(campaignId) as Array<{ session_id: string }>).map((row) => row.session_id));
  }

  /** Each session's open attempt in this campaign, keyed by session. */
  openAttemptsBySession(campaignId: string): Map<string, string> {
    return new Map((this.stmt(
      `SELECT session_id, id FROM campaign_work_attempts
       WHERE campaign_session_id=? AND ended_at IS NULL AND session_id IS NOT NULL`,
    ).all(campaignId) as Array<{ session_id: string; id: string }>).map((row) => [row.session_id, row.id]));
  }

  /** Every attempt's session per item, in attempt order, for per-principal cost visibility. A
   * deleted attempt session is null. */
  attemptSessionIdsByItem(campaignId: string): Map<string, Array<string | null>> {
    const sessions = new Map<string, Array<string | null>>();
    for (const row of this.stmt(
      "SELECT work_item_id, session_id FROM campaign_work_attempts WHERE campaign_session_id=? ORDER BY work_item_id, ordinal",
    ).all(campaignId) as Array<{ work_item_id: string; session_id: string | null }>) {
      sessions.set(row.work_item_id, [...(sessions.get(row.work_item_id) ?? []), row.session_id]);
    }
    return sessions;
  }

  /** Sessions whose ledger history proves them unrelated to every listed issue of one repository
   * (#3084, #3914). A session qualifies only when it has an open attempt in this campaign and no
   * item it can reach is related. It reaches every item it has ever attempted, and from those every
   * item joined to one by follow-up lineage, followed transitively in both directions (an origin's
   * results, a result's origins, their results, and so on). An item is related when it has ever
   * tracked a listed issue, or when it predates attribution history (a legacy item, whose issues
   * and links are unknown). Lineage that never meets a related item, such as a follow-up for
   * another issue, does not bind.
   *
   * Every input is append-only history, so the reachable set only grows: a session can lose this
   * status but never regain it by a ledger edit. An empty list proves only that no legacy item is
   * reachable. Closures pass their one issue; callers comparing a set of issues pass them all. */
  sessionsUnrelatedToIssues(campaignId: string, repository: string, issueNumbers: readonly number[]): Set<string> {
    return new Set((this.stmt(`
      WITH RECURSIVE
        candidate(session_id) AS (
          SELECT session_id FROM campaign_work_attempts
          WHERE campaign_session_id=?1 AND session_id IS NOT NULL AND ended_at IS NULL),
        reach(session_id, work_item_id) AS (
          SELECT earlier.session_id, earlier.work_item_id FROM candidate
            JOIN campaign_work_attempts earlier ON earlier.session_id=candidate.session_id
          UNION
          SELECT reach.session_id, edge.result_work_item_id FROM reach
            JOIN campaign_work_lineage_edges edge ON edge.origin_work_item_id=reach.work_item_id
          UNION
          SELECT reach.session_id, edge.origin_work_item_id FROM reach
            JOIN campaign_work_lineage_edges edge ON edge.result_work_item_id=reach.work_item_id)
      SELECT candidate.session_id FROM candidate WHERE NOT EXISTS (
        SELECT 1 FROM reach WHERE reach.session_id=candidate.session_id AND (
          EXISTS (SELECT 1 FROM campaign_work_legacy_items legacy WHERE legacy.work_item_id=reach.work_item_id)
          OR EXISTS (SELECT 1 FROM campaign_work_item_issue_history history
            WHERE history.work_item_id=reach.work_item_id AND history.issue_repository=lower(?2)
              AND history.issue_number IN (SELECT value FROM json_each(?3)))))
    `).all(campaignId, repository, JSON.stringify(issueNumbers)) as Array<{ session_id: string }>).map((row) => row.session_id));
  }

  /** Campaigns with a committed work item for this issue (#4103). */
  campaignsWithCommittedIssue(repository: string, issue: number): string[] {
    return (this.stmt(`SELECT DISTINCT campaign_session_id FROM campaign_work_items
      WHERE lower(issue_repository)=lower(?) AND issue_number=? AND commitment='committed'`)
      .all(repository, issue) as Array<{ campaign_session_id: string }>).map((row) => row.campaign_session_id);
  }

  /** Sessions an issue closure may leave out: those {@link sessionsUnrelatedToIssues} proves
   * unrelated to the one issue being closed. */
  issueClosureExcludableSessions(campaignId: string, repository: string, issueNumber: number): Set<string> {
    return this.sessionsUnrelatedToIssues(campaignId, repository, [issueNumber]);
  }

  /** The ledger facts behind an exclusion (#3237), read from the same history
   * {@link sessionsUnrelatedToIssues} decides from: the issues every item the session has attempted
   * has ever tracked, how many of those items never tracked one, and how many items it reaches only
   * through follow-up lineage, in either direction. It states facts and decides nothing: a caller
   * asks only about sessions that function already excluded. */
  issueClosureExclusionReason(sessionId: string): IssueClosureExclusionReason {
    const attempted = `SELECT DISTINCT work_item_id FROM campaign_work_attempts WHERE session_id=?1`;
    const issues = this.stmt(`SELECT DISTINCT issue_repository, issue_number FROM campaign_work_item_issue_history
      WHERE work_item_id IN (${attempted}) ORDER BY issue_repository, issue_number`)
      .all(sessionId) as Array<{ issue_repository: string; issue_number: number }>;
    const { without } = this.stmt(`SELECT COUNT(*) AS without FROM (${attempted}) item WHERE NOT EXISTS
      (SELECT 1 FROM campaign_work_item_issue_history history WHERE history.work_item_id=item.work_item_id)`)
      .get(sessionId) as { without: number };
    const { linked } = this.stmt(`
      WITH RECURSIVE reach(work_item_id) AS (
        ${attempted}
        UNION
        SELECT edge.result_work_item_id FROM reach JOIN campaign_work_lineage_edges edge ON edge.origin_work_item_id=reach.work_item_id
        UNION
        SELECT edge.origin_work_item_id FROM reach JOIN campaign_work_lineage_edges edge ON edge.result_work_item_id=reach.work_item_id)
      SELECT COUNT(*) AS linked FROM reach WHERE work_item_id NOT IN (${attempted})`).get(sessionId) as { linked: number };
    return {
      attemptedIssues: issues.slice(0, ISSUE_CLOSURE_EXCLUSION_ISSUES_MAX).map((row) => ({ repository: row.issue_repository, number: row.issue_number })),
      attemptedIssueCount: issues.length, attemptedWithoutIssue: without, linkedWorkItems: linked,
    };
  }

  /* ------------------------------ Dependencies ------------------------------ */

  /** True when the dependency graph contains a cycle. */
  private hasCycle(edges: Map<string, string[]>): boolean {
    const state = new Map<string, "visiting" | "done">();
    const visit = (id: string): boolean => {
      const current = state.get(id);
      if (current === "done") return false;
      if (current === "visiting") return true;
      state.set(id, "visiting");
      for (const next of edges.get(id) ?? []) if (visit(next)) return true;
      state.set(id, "done");
      return false;
    };
    return [...edges.keys()].some((id) => visit(id));
  }

  private dependencyEdges(campaignId: string): Map<string, string[]> {
    const edges = new Map<string, string[]>();
    for (const row of this.stmt(
      `SELECT dependency.work_item_id, dependency.depends_on_id FROM campaign_work_item_dependencies dependency
       JOIN campaign_work_items item ON item.id=dependency.work_item_id WHERE item.campaign_session_id=?`,
    ).all(campaignId) as Array<{ work_item_id: string; depends_on_id: string }>) {
      edges.set(row.work_item_id, [...(edges.get(row.work_item_id) ?? []), row.depends_on_id]);
    }
    return edges;
  }

  /** Apply dependency replacements together: each set is validated, then the FINAL graph is
   * checked for cycles, so a valid batch never depends on the order it lists its items in.
   * Returns the ids whose set changed, or an error. */
  private replaceDependencies(
    campaignId: string,
    replacements: ReadonlyArray<{ itemId: string; label: string; dependsOn: readonly string[] }>,
  ): { changed: string[] } | { error: string; status: number } {
    const edges = this.dependencyEdges(campaignId);
    const changed: string[] = [];
    for (const { itemId, label, dependsOn } of replacements) {
      const unique = [...new Set(dependsOn)];
      if (unique.length > L.dependsOn) return { error: `${label}: an item may depend on at most ${L.dependsOn} items`, status: 400 };
      if (unique.includes(itemId)) return { error: `${label}: an item cannot depend on itself`, status: 409 };
      const missing = this.missingItemIds(campaignId, unique);
      if (missing.length) return { error: `${label}: unknown work items: ${missing.slice(0, 8).join(", ")}`, status: 404 };
      const before = edges.get(itemId) ?? [];
      if ([...before].sort().join("\n") === [...unique].sort().join("\n")) continue;
      // #4120: a new dependency is a promise to hold this item's merge, which an already armed enqueue
      // would not keep: its provider may run it without asking again. Refused rather than recorded.
      const session = unique.some((id) => !before.includes(id)) ? this.openAttemptForItem(itemId)?.session_id : null;
      if (session && this.hooks.armedMerge?.(session)) {
        return { error: `${label}: its child has already armed its approved merge, which a new dependency could not hold. ` +
          "Record dependencies before a merge is armed; after this merge settles, record it again if it still applies.", status: 409 };
      }
      edges.set(itemId, unique);
      changed.push(itemId);
    }
    if (!changed.length) return { changed };
    if (this.hasCycle(edges)) return { error: "the dependencies would create a cycle", status: 409 };
    for (const itemId of changed) {
      this.stmt("DELETE FROM campaign_work_item_dependencies WHERE work_item_id=?").run(itemId);
      for (const dependency of edges.get(itemId)!) {
        this.stmt("INSERT INTO campaign_work_item_dependencies (work_item_id, depends_on_id) VALUES (?, ?)")
          .run(itemId, dependency);
      }
    }
    return { changed };
  }

  /* ------------------------------ record_campaign_plan ------------------------------ */

  recordPlan(
    campaignId: string,
    actorSessionId: string,
    request: RecordCampaignPlanRequest,
    now: number,
  ): LedgerResult<RecordCampaignPlanResponse> {
    if (typeof request !== "object" || request === null || !Array.isArray(request.items) ||
        typeof request.planComplete !== "boolean") {
      return fail("items[] and planComplete are required");
    }
    if (request.items.length > L.planItemsPerCall) {
      return fail(`a plan call accepts at most ${L.planItemsPerCall} items`);
    }
    if (request.fixedBy !== undefined && (!Array.isArray(request.fixedBy) || request.fixedBy.length > 100 ||
        request.fixedBy.some((link) => !link || !validIssue(link.issue) || !Array.isArray(link.workItemKeys) ||
          !link.workItemKeys.length || link.workItemKeys.length > 100 ||
          !link.workItemKeys.every((key) => boundedText(key, L.keyLength))))) return fail("fixedBy must name issues and 1–100 work item keys");
    if (request.fixedBy?.length && (actorSessionId !== campaignId || this.stmt(
      "SELECT 1 FROM campaign_work_attempts WHERE campaign_session_id=? LIMIT 1").get(campaignId))) {
      return fail("fixedBy relationships require the root's plan before any campaign dispatch", 409);
    }
    const keys = new Set<string>();
    for (const [index, input] of request.items.entries()) {
      const at = `items[${index}]`;
      if (typeof input !== "object" || input === null || !boundedText(input.key, L.keyLength)) {
        return fail(`${at}.key is required and must be at most ${L.keyLength} characters`);
      }
      if (keys.has(input.key)) return fail(`${at}.key repeats ${input.key}`);
      keys.add(input.key);
      if (input.title !== undefined && !boundedText(input.title, L.titleLength)) {
        return fail(`${at}.title must be at most ${L.titleLength} characters`);
      }
      if (input.issue !== undefined && input.issue !== null && !validIssue(input.issue)) {
        return fail(`${at}.issue must be ${REF_SHAPE}`);
      }
      if (input.origin !== undefined && input.origin !== "original" && input.origin !== "follow_up") {
        return fail(`${at}.origin must be original or follow_up`);
      }
      if (input.dispatchState !== undefined && input.dispatchState !== "planned" && input.dispatchState !== "queued") {
        return fail(`${at}.dispatchState must be planned or queued`);
      }
      if (input.queuePosition !== undefined && !validQueuePosition(input.queuePosition)) {
        return fail(`${at}.queuePosition must be a non-negative integer or null`);
      }
      if (input.dependsOnKeys !== undefined && (!Array.isArray(input.dependsOnKeys) ||
          input.dependsOnKeys.length > L.dependsOn ||
          !input.dependsOnKeys.every((key) => boundedText(key, L.keyLength)))) {
        return fail(`${at}.dependsOnKeys must list at most ${L.dependsOn} keys`);
      }
    }
    return this.transact(campaignId, () => {
      const existingCount = Number((this.stmt(
        "SELECT COUNT(*) AS count FROM campaign_work_items WHERE campaign_session_id=?",
      ).get(campaignId) as { count: number }).count);
      const created = request.items.filter((input) => !this.itemByKey(campaignId, input.key)).length;
      if (existingCount + created > L.workItemsPerCampaign) {
        return fail(`a campaign may hold at most ${L.workItemsPerCampaign} work items`, 409);
      }
      const results: RecordCampaignPlanResponse["items"] = [];
      let changed = false;
      for (const input of request.items) {
        const existing = this.itemByKey(campaignId, input.key);
        if (!existing) {
          const id = newId(CAMPAIGN_WORK_ITEM_ID_PREFIX);
          const origin = input.origin ?? "original";
          if (origin === "follow_up") {
            const refused = this.hooks.acceptFollowUp?.(campaignId, id, { kind: "work_item", key: input.key },
              { title: input.title?.trim() ?? null, issue: input.issue ?? null });
            if (refused) return fail(refused.error, 409, refused.details);
          }
          this.stmt(
            `INSERT INTO campaign_work_items
             (id, campaign_session_id, item_key, title, issue_repository, issue_number, origin, generation,
              dispatch_state, queue_position, commitment, commitment_changed_at, commitment_changed_by,
              created_by_session_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?, ?, ?)`,
          ).run(
            id, campaignId, input.key, input.title?.trim() ?? null, input.issue?.repository ?? null,
            input.issue?.number ?? null, origin, origin === "follow_up" ? 1 : 0, input.dispatchState ?? "planned",
            input.queuePosition ?? null, now, actorSessionId, actorSessionId, now, now,
          );
          results.push({ key: input.key, workItemId: id, created: true });
          changed = true;
          continue;
        }
        if (input.origin !== undefined && input.origin !== existing.origin) {
          throw new LedgerRefusal(`item ${input.key} already has origin ${existing.origin}`, 409);
        }
        const next = {
          title: input.title !== undefined ? input.title.trim() : existing.title,
          issueRepository: input.issue !== undefined ? input.issue?.repository ?? null : existing.issue_repository,
          issueNumber: input.issue !== undefined ? input.issue?.number ?? null : existing.issue_number,
          dispatchState: input.dispatchState ?? existing.dispatch_state,
          queuePosition: input.queuePosition !== undefined ? input.queuePosition : existing.queue_position,
        };
        const revised = this.followUpRevision(campaignId, existing, next.title, next.issueRepository, next.issueNumber) ??
          this.retargetRefusal(campaignId, existing, next.issueRepository, next.issueNumber);
        if (revised) return revised;
        if (next.title !== existing.title || next.issueRepository !== existing.issue_repository ||
            next.issueNumber !== existing.issue_number || next.dispatchState !== existing.dispatch_state ||
            next.queuePosition !== existing.queue_position) {
          this.stmt(
            `UPDATE campaign_work_items SET title=?, issue_repository=?, issue_number=?, dispatch_state=?,
               queue_position=?, updated_at=? WHERE id=?`,
          ).run(next.title, next.issueRepository, next.issueNumber, next.dispatchState, next.queuePosition, now, existing.id);
          changed = true;
        }
        results.push({ key: input.key, workItemId: existing.id, created: false });
      }
      const replacements: Array<{ itemId: string; label: string; dependsOn: string[] }> = [];
      for (const input of request.items) {
        if (input.dependsOnKeys === undefined) continue;
        const ids: string[] = [];
        for (const key of input.dependsOnKeys) {
          const dependency = this.itemByKey(campaignId, key);
          if (!dependency) throw new LedgerRefusal(`item ${input.key} depends on unknown key ${key}`, 400);
          ids.push(dependency.id);
        }
        replacements.push({ itemId: this.itemByKey(campaignId, input.key)!.id, label: `item ${input.key}`, dependsOn: ids });
      }
      const dependencies = this.replaceDependencies(campaignId, replacements);
      if ("error" in dependencies) throw new LedgerRefusal(dependencies.error, dependencies.status);
      for (const itemId of dependencies.changed) {
        this.stmt("UPDATE campaign_work_items SET updated_at=? WHERE id=?").run(now, itemId);
        changed = true;
      }
      const planState: CampaignPlanState = request.planComplete ? "recorded" : "partial";
      for (const link of request.fixedBy ?? []) {
        const ids = [...new Set(link.workItemKeys.map((key) => {
          const item = this.itemByKey(campaignId, key);
          if (!item) throw new LedgerRefusal(`fixedBy cites missing work item ${key}`, 400);
          return item.id;
        }))].sort();
        const repository = link.issue.repository.toLowerCase();
        const previous = this.fixedBy(campaignId, repository, link.issue.number);
        if (previous && JSON.stringify(previous) !== JSON.stringify(ids)) throw new LedgerRefusal("fixedBy relationships are immutable", 409);
        if (!previous) {
          this.stmt("INSERT INTO campaign_fixed_by VALUES (?, ?, ?, ?)").run(campaignId, repository, link.issue.number, JSON.stringify(ids));
          changed = true;
        }
      }
      const previousPlanState = this.planState(campaignId);
      const revision = changed || previousPlanState !== planState
        ? this.bump(campaignId, now, planState)
        : this.revision(campaignId);
      return done({ revision, planState, items: results });
    });
  }

  planState(campaignId: string): CampaignPlanState {
    const row = this.stmt("SELECT plan_state FROM campaign_work_ledgers WHERE campaign_session_id=?")
      .get(campaignId) as { plan_state: CampaignPlanState } | undefined;
    return row?.plan_state ?? "not_recorded";
  }

  fixedBy(campaignId: string, repository: string, issue: number): string[] | null {
    const row = this.stmt("SELECT work_item_ids FROM campaign_fixed_by WHERE campaign_session_id=? AND issue_repository=? AND issue_number=?")
      .get(campaignId, repository.toLowerCase(), issue) as { work_item_ids: string } | undefined;
    return row ? JSON.parse(row.work_item_ids) as string[] : null;
  }

  /* ------------------------------ update_campaign_work_item ------------------------------ */

  updateItem(
    campaignId: string,
    actorSessionId: string,
    request: UpdateCampaignWorkItemRequest,
    now: number,
  ): LedgerResult<{ revision: number; itemId: string }> {
    if (typeof request !== "object" || request === null || !boundedText(request.workItemId, 256)) {
      return fail("workItemId is required");
    }
    const fields = ["title", "issue", "dispatchState", "queuePosition", "dependsOn", "commitment", "stage",
      "blocker", "nextAction", "handoff", "endAttempt"] as const;
    if (!fields.some((field) => request[field] !== undefined)) return fail("no field to update");
    if (request.title !== undefined && request.title !== null && !boundedText(request.title, L.titleLength)) {
      return fail(`title must be at most ${L.titleLength} characters`);
    }
    if (request.issue !== undefined && request.issue !== null && !validIssue(request.issue)) {
      return fail(`issue must be ${REF_SHAPE}`);
    }
    if (request.dispatchState !== undefined && request.dispatchState !== "planned" && request.dispatchState !== "queued") {
      return fail("dispatchState must be planned or queued");
    }
    if (request.queuePosition !== undefined && !validQueuePosition(request.queuePosition)) {
      return fail("queuePosition must be a non-negative integer or null");
    }
    if (request.dependsOn !== undefined && (!Array.isArray(request.dependsOn) ||
        !request.dependsOn.every((id) => boundedText(id, 256)))) {
      return fail("dependsOn must be a list of work item ids");
    }
    const commitment = request.commitment;
    if (commitment !== undefined) {
      if (typeof commitment !== "object" || commitment === null ||
          !["committed", "cancelled", "scope_removed"].includes(commitment.state)) {
        return fail("commitment.state must be committed, cancelled, or scope_removed");
      }
      if (commitment.reason !== undefined && !boundedText(commitment.reason, L.textLength)) {
        return fail(`commitment.reason must be at most ${L.textLength} characters`);
      }
      if (commitment.state !== "committed" && commitment.reason === undefined) {
        return fail("cancelling or removing an item requires commitment.reason");
      }
    }
    const stage = request.stage;
    if (stage !== undefined && stage !== null) {
      if (typeof stage !== "object" || !(CAMPAIGN_REPORTED_STAGES as readonly string[]).includes(stage.stage)) {
        return fail(`stage.stage must be one of ${CAMPAIGN_REPORTED_STAGES.join(", ")}`);
      }
      if (stage.note !== undefined && !boundedText(stage.note, L.textLength)) return fail("stage.note is too long");
      if (stage.pullRequests !== undefined && !validPullRequests(stage.pullRequests)) {
        return fail(`stage.pullRequests must list at most ${L.pullRequestsPerStage} refs, each ${REF_SHAPE}`);
      }
    }
    const blocker = request.blocker;
    if (blocker !== undefined && blocker !== null) {
      if (typeof blocker !== "object" || !boundedText(blocker.reason, L.textLength) ||
          !["human", "orchestrator", "child", "external"].includes(blocker.responsibleActor)) {
        return fail("blocker requires reason and responsibleActor (human, orchestrator, child, or external)");
      }
      if (blocker.requestOccurrenceId !== undefined && !boundedText(blocker.requestOccurrenceId, 256)) {
        return fail("blocker.requestOccurrenceId must be bounded");
      }
    }
    if (request.nextAction !== undefined && request.nextAction !== null &&
        !boundedText(request.nextAction, L.textLength)) {
      return fail(`nextAction must be at most ${L.textLength} characters`);
    }
    const handoff = request.handoff;
    if (handoff !== undefined && handoff !== null && (typeof handoff !== "object" ||
        !["human", "orchestrator", "child", "external"].includes(handoff.responsibleActor) ||
        !boundedText(handoff.reason, L.textLength) || !boundedText(handoff.nextAction, L.textLength))) {
      return fail("handoff requires responsibleActor (human, orchestrator, child, or external), reason, and nextAction, " +
        `each at most ${L.textLength} characters`);
    }
    const endAttempt = request.endAttempt;
    if (endAttempt !== undefined && (typeof endAttempt !== "object" || endAttempt === null ||
        (endAttempt.reason !== "abandoned" && endAttempt.reason !== "failed") ||
        (endAttempt.note !== undefined && !boundedText(endAttempt.note, L.textLength)))) {
      return fail("endAttempt.reason must be abandoned or failed");
    }
    return this.transact(campaignId, () => {
      const item = this.item(campaignId, request.workItemId);
      if (!item) return fail<{ revision: number; itemId: string }>("work item not found in this campaign", 404);
      const sets: string[] = [];
      const values: Array<string | number | null> = [];
      const set = (column: string, value: string | number | null, current: unknown) => {
        if (value === current) return;
        sets.push(`${column}=?`);
        values.push(value);
      };
      const issueRepository = request.issue !== undefined ? request.issue?.repository ?? null : item.issue_repository;
      const issueNumber = request.issue !== undefined ? request.issue?.number ?? null : item.issue_number;
      const revised = this.followUpRevision(campaignId, item, request.title !== undefined ? request.title?.trim() ?? null : item.title,
        issueRepository, issueNumber) ?? this.retargetRefusal(campaignId, item, issueRepository, issueNumber);
      if (revised) return revised;
      if (request.title !== undefined) set("title", request.title?.trim() ?? null, item.title);
      if (request.issue !== undefined) {
        set("issue_repository", request.issue?.repository ?? null, item.issue_repository);
        set("issue_number", request.issue?.number ?? null, item.issue_number);
      }
      if (request.dispatchState !== undefined) set("dispatch_state", request.dispatchState, item.dispatch_state);
      if (request.queuePosition !== undefined) set("queue_position", request.queuePosition, item.queue_position);
      if (request.nextAction !== undefined) set("next_action", request.nextAction?.trim() ?? null, item.next_action);
      if (commitment !== undefined && (commitment.state !== item.commitment ||
          (commitment.reason?.trim() ?? null) !== item.commitment_reason)) {
        sets.push("commitment=?", "commitment_reason=?", "commitment_changed_at=?", "commitment_changed_by=?");
        values.push(commitment.state, commitment.reason?.trim() ?? null, now, actorSessionId);
      }
      // Re-reporting the identical stage or blocker is a no-op; only a change is a ledger write.
      const sameStage = stage === null ? item.stage === null
        : stage !== undefined && item.stage === stage.stage && item.stage_note === (stage.note?.trim() ?? null) &&
          item.stage_pull_requests === JSON.stringify(stage.pullRequests ?? []);
      const sameBlocker = blocker === null ? item.blocker_reason === null
        : blocker !== undefined && item.blocker_reason === blocker.reason.trim() &&
          item.blocker_actor === blocker.responsibleActor &&
          item.blocker_request_occurrence_id === (blocker.requestOccurrenceId ?? null);
      if (stage !== undefined && !sameStage) {
        sets.push("stage=?", "stage_note=?", "stage_pull_requests=?", "stage_source_session_id=?", "stage_reported_at=?");
        values.push(...(stage === null ? [null, null, null, null, null]
          : [stage.stage, stage.note?.trim() ?? null, JSON.stringify(stage.pullRequests ?? []), actorSessionId, now]));
      }
      if (blocker !== undefined && !sameBlocker) {
        sets.push("blocker_reason=?", "blocker_actor=?", "blocker_request_occurrence_id=?", "blocker_recorded_at=?",
          "blocker_recorded_by=?");
        values.push(...(blocker === null ? [null, null, null, null, null]
          : [blocker.reason.trim(), blocker.responsibleActor, blocker.requestOccurrenceId ?? null, now, actorSessionId]));
      }
      let changed = sets.length > 0;
      if (handoff !== undefined) {
        const current = this.stmt("SELECT * FROM campaign_work_handoffs WHERE work_item_id=?").get(item.id) as HandoffRow | undefined;
        if (handoff === null) {
          if (current) {
            this.stmt("DELETE FROM campaign_work_handoffs WHERE work_item_id=?").run(item.id);
            changed = true;
          }
        } else if (!current || current.responsible_actor !== handoff.responsibleActor ||
            current.reason !== handoff.reason.trim() || current.next_action !== handoff.nextAction.trim()) {
          this.stmt(
            `INSERT INTO campaign_work_handoffs
               (work_item_id, campaign_session_id, responsible_actor, reason, next_action, recorded_at, recorded_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(work_item_id) DO UPDATE SET responsible_actor=excluded.responsible_actor,
               reason=excluded.reason, next_action=excluded.next_action, recorded_at=excluded.recorded_at,
               recorded_by=excluded.recorded_by`,
          ).run(item.id, campaignId, handoff.responsibleActor, handoff.reason.trim(), handoff.nextAction.trim(), now, actorSessionId);
          changed = true;
        }
      }
      if (request.dependsOn !== undefined) {
        const dependencies = this.replaceDependencies(campaignId,
          [{ itemId: item.id, label: "dependsOn", dependsOn: request.dependsOn }]);
        if ("error" in dependencies) throw new LedgerRefusal(dependencies.error, dependencies.status);
        if (dependencies.changed.length) changed = true;
      }
      const open = this.openAttemptForItem(item.id);
      if (endAttempt !== undefined) {
        if (!open) throw new LedgerRefusal("the work item has no open attempt to end", 409);
        this.closeAttempt(open, endAttempt.reason, now, endAttempt.note?.trim() ?? null);
        changed = true;
      }
      if (commitment !== undefined && commitment.state !== "committed" && open && endAttempt === undefined) {
        this.closeAttempt(open, "abandoned", now, null);
        changed = true;
      }
      if (!changed) return done({ revision: this.revision(campaignId), itemId: item.id });
      sets.push("updated_at=?");
      values.push(now);
      this.stmt(`UPDATE campaign_work_items SET ${sets.join(", ")} WHERE id=?`).run(...values, item.id);
      return done({ revision: this.bump(campaignId, now), itemId: item.id });
    });
  }

  private closeAttempt(attempt: AttemptRow, reason: CampaignAttemptEndReason, now: number, note: string | null): void {
    const boundary = attempt.session_id
      ? this.hooks.boundary(attempt.session_id)
      : { eventEpoch: null, runnerHistoryEpoch: null, seq: null };
    this.stmt(
      `UPDATE campaign_work_attempts SET ended_at=?, end_event_epoch=?, end_runner_history_epoch=?, end_seq=?,
         end_reason=?, end_note=? WHERE id=? AND ended_at IS NULL`,
    ).run(now, boundary.eventEpoch, boundary.runnerHistoryEpoch, boundary.seq, reason, note, attempt.id);
    this.stmt("UPDATE campaign_work_items SET updated_at=? WHERE id=?").run(now, attempt.work_item_id);
  }

  /* ------------------------------ assign_campaign_work_item ------------------------------ */

  /** The item checks `assign` applies, without writing, so child creation can refuse a work item
   * it could not record before any session exists. */
  assignableItem(campaignId: string, workItemId: string): LedgerResult<null> {
    const item = this.item(campaignId, workItemId);
    if (!item) return fail("work item not found in this campaign", 404);
    if (item.commitment !== "committed") {
      return fail(`a ${item.commitment === "cancelled" ? "cancelled" : "removed"} work item cannot be assigned; recommit it first`, 409);
    }
    const refused = this.hooks.admitDispatch?.(campaignId, itemIssue(item.issue_repository, item.issue_number));
    if (refused) return fail(refused, 409);
    return done(null);
  }

  assign(
    campaignId: string,
    actorSessionId: string,
    workItemId: string,
    childSessionId: string,
    snapshot: CampaignAttemptSessionSnapshot,
    now: number,
  ): LedgerResult<{
    revision: number;
    attempt: CampaignAttempt;
    closedAttempts: Array<{ id: string; workItemId: string; endReason: CampaignAttemptEndReason }>;
    created: boolean;
  }> {
    return this.transact(campaignId, () => {
      const assignable = this.assignableItem(campaignId, workItemId);
      if (!assignable.ok) return assignable;
      const item = this.item(campaignId, workItemId)!;
      const sessionOpen = this.openAttemptForSession(childSessionId);
      if (sessionOpen?.work_item_id === item.id) {
        // Reassigning the child that already holds the item keeps its attempt, but the agent still
        // takes the item back, so a handoff recorded meanwhile no longer describes who acts next.
        const cleared = this.stmt("DELETE FROM campaign_work_handoffs WHERE work_item_id=?").run(item.id).changes > 0;
        if (cleared) this.stmt("UPDATE campaign_work_items SET updated_at=? WHERE id=?").run(now, item.id);
        return done({
          revision: cleared ? this.bump(campaignId, now) : this.revision(campaignId),
          attempt: this.attemptView(sessionOpen),
          closedAttempts: [],
          created: false,
        });
      }
      if (sessionOpen && sessionOpen.campaign_session_id !== campaignId) {
        return fail("the session has an open attempt in another campaign", 409);
      }
      const closedAttempts: Array<{ id: string; workItemId: string; endReason: CampaignAttemptEndReason }> = [];
      if (sessionOpen) {
        this.closeAttempt(sessionOpen, "reassigned", now, null);
        closedAttempts.push({ id: sessionOpen.id, workItemId: sessionOpen.work_item_id, endReason: "reassigned" });
      }
      const itemOpen = this.openAttemptForItem(item.id);
      if (itemOpen) {
        this.closeAttempt(itemOpen, "superseded", now, null);
        closedAttempts.push({ id: itemOpen.id, workItemId: item.id, endReason: "superseded" });
      }
      const ordinal = Number((this.stmt(
        "SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM campaign_work_attempts WHERE work_item_id=?",
      ).get(item.id) as { ordinal: number }).ordinal) + 1;
      const boundary = this.hooks.boundary(childSessionId);
      const id = newId(CAMPAIGN_ATTEMPT_ID_PREFIX);
      this.stmt(
        `INSERT INTO campaign_work_attempts
         (id, campaign_session_id, work_item_id, ordinal, session_id, session_title, harness, agent_name, model,
          effort, assigned_by_session_id, started_at, start_event_epoch, start_runner_history_epoch, start_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, campaignId, item.id, ordinal, childSessionId, snapshot.title, snapshot.harness ? JSON.stringify(snapshot.harness) : null,
        snapshot.agentName, snapshot.model, snapshot.effort, actorSessionId, now, boundary.eventEpoch,
        boundary.runnerHistoryEpoch, boundary.seq,
      );
      this.accounting.recordAttemptOpened(id, now, this.hooks.observeSession(childSessionId));
      // An agent took the item back, so its handoff no longer describes who acts next (#4070).
      this.stmt("DELETE FROM campaign_work_handoffs WHERE work_item_id=?").run(item.id);
      this.stmt("UPDATE campaign_work_items SET updated_at=? WHERE id=?").run(now, item.id);
      const attempt = this.stmt("SELECT * FROM campaign_work_attempts WHERE id=?").get(id) as unknown as AttemptRow;
      return done({ revision: this.bump(campaignId, now), attempt: this.attemptView(attempt), closedAttempts, created: true });
    });
  }

  /* ------------------------------ Work-item verification ------------------------------ */

  /** Validation only, so the session-level verification is not recorded when this would fail.
   * Repeating an identical verification of the item's latest attempt (same child, exact report
   * identity, and outcome) resolves to the existing record, so a retried call is a no-op rather than a refusal
   * or a duplicate row. */
  verificationTarget(
    campaignId: string,
    workItemId: string,
    childSessionId: string,
    outcome: CampaignWorkItemVerificationOutcome,
    report: { seq: number; eventEpoch: number | null; digest: string | null },
  ): LedgerResult<{ attempt: AttemptRow; existing: VerificationRow | null }> {
    const item = this.item(campaignId, workItemId);
    if (!item) return fail("work item not found in this campaign", 404);
    const latest = this.stmt(
      "SELECT * FROM campaign_work_attempts WHERE work_item_id=? ORDER BY ordinal DESC LIMIT 1",
    ).get(item.id) as AttemptRow | undefined;
    if (latest && latest.session_id === childSessionId) {
      // The exact report identity, not just its sequence: replaced history can reuse a seq.
      const existing = this.stmt(
        `SELECT * FROM campaign_work_verifications WHERE attempt_id=? AND outcome=? AND report_seq=?
           AND report_event_epoch IS ? AND report_digest IS ?
         ORDER BY verified_at DESC LIMIT 1`,
      ).get(latest.id, outcome, report.seq, report.eventEpoch, report.digest) as VerificationRow | undefined;
      if (existing) return done({ attempt: latest, existing });
    }
    if (!latest || latest.ended_at !== null || latest.session_id !== childSessionId) {
      return fail("the child has no open attempt on this work item; assign it first", 409);
    }
    return done({ attempt: latest, existing: null });
  }

  recordVerification(
    campaignId: string,
    input: {
      workItemId: string;
      childSessionId: string;
      outcome: CampaignWorkItemVerificationOutcome;
      report: { seq: number; eventEpoch: number | null; digest: string | null; ts: number | null };
      verifiedBySessionId: string;
    },
    now: number,
  ): LedgerResult<{ revision: number; verification: CampaignWorkItemVerification }> {
    return this.transact(campaignId, () => {
      const target = this.verificationTarget(campaignId, input.workItemId, input.childSessionId, input.outcome,
        input.report);
      if (!target.ok) return target;
      if (target.data.existing) {
        return done({ revision: this.revision(campaignId), verification: this.verificationView(target.data.existing) });
      }
      const id = newId(CAMPAIGN_WORK_VERIFICATION_ID_PREFIX);
      this.stmt(
        `INSERT INTO campaign_work_verifications
         (id, campaign_session_id, work_item_id, attempt_id, child_session_id, outcome, report_seq,
          report_event_epoch, report_digest, report_ts, verified_by_session_id, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, campaignId, input.workItemId, target.data.attempt.id, input.childSessionId, input.outcome,
        input.report.seq, input.report.eventEpoch, input.report.digest, input.report.ts, input.verifiedBySessionId, now);
      if (input.outcome === "delivered") this.closeAttempt(target.data.attempt, "delivered", now, null);
      else this.stmt("UPDATE campaign_work_items SET updated_at=? WHERE id=?").run(now, input.workItemId);
      const row = this.stmt("SELECT * FROM campaign_work_verifications WHERE id=?").get(id) as unknown as VerificationRow;
      return done({ revision: this.bump(campaignId, now), verification: this.verificationView(row) });
    });
  }

  /* ------------------------------ Recorded delivery (#4070) ------------------------------ */

  /** The child's attempt on this item whose event window holds the exact report, or the refusal.
   * Any attempt the child had counts, open or closed as reassigned, superseded or delivered; one the
   * Orchestrator ended as abandoned or failed does not. A window whose history was replaced since
   * (another event epoch) proves nothing. */
  reportAttempt(
    campaignId: string,
    workItemId: string,
    report: { childSessionId: string; seq: number; eventEpoch: number | null },
  ): LedgerResult<{ attempt: AttemptRow; open: boolean; endSeq: number | null }> {
    const item = this.item(campaignId, workItemId);
    if (!item) return fail("work item not found in this campaign", 404);
    const attempts = this.stmt(
      "SELECT * FROM campaign_work_attempts WHERE work_item_id=? AND session_id=? ORDER BY ordinal",
    ).all(item.id, report.childSessionId) as unknown as AttemptRow[];
    if (!attempts.length) return fail("the child never had an attempt on this work item", 409);
    const sameEpoch = (epoch: number | null) => epoch !== null && report.eventEpoch !== null && epoch === report.eventEpoch;
    const attempt = attempts.find((candidate) => candidate.end_reason !== "abandoned" && candidate.end_reason !== "failed" &&
      sameEpoch(candidate.start_event_epoch) && report.seq > (candidate.start_seq ?? 0) &&
      (candidate.ended_at === null ||
        (sameEpoch(candidate.end_event_epoch) && candidate.end_seq !== null && report.seq <= candidate.end_seq)));
    if (!attempt) {
      return fail("the report is not inside the child's attempt on this work item (an attempt ended as abandoned or " +
        "failed does not count, and history replaced since the attempt cannot be matched)", 409);
    }
    return done({ attempt, open: attempt.ended_at === null, endSeq: attempt.end_seq });
  }

  /**
   * Records delivery from evidence the caller checked: pull requests the forge just reported merged,
   * and the child's exact report, already shown to be a completed top-level response. A report also
   * adds an ordinary delivered verification of its attempt. The item's open attempt closes as
   * delivered when it is the report's, else as superseded. Repeating the same evidence is a no-op.
   */
  recordDelivery(
    campaignId: string,
    actorSessionId: string,
    evidence: CampaignDeliveryEvidence,
    now: number,
  ): LedgerResult<{ revision: number; deliveryId: string; itemId: string }> {
    return this.transact(campaignId, () => {
      const item = this.item(campaignId, evidence.workItemId);
      if (!item) return fail<{ revision: number; deliveryId: string; itemId: string }>("work item not found in this campaign", 404);
      if (item.commitment !== "committed") {
        return fail(`a ${item.commitment === "cancelled" ? "cancelled" : "removed"} work item cannot be delivered; recommit it first`, 409);
      }
      const pullRequests = uniquePullRequests(evidence.pullRequests) as CampaignDeliveryEvidence["pullRequests"];
      if (!pullRequests.length && !evidence.report) return fail("delivery needs pull requests, a report, or both");
      const key = JSON.stringify([
        pullRequests.map((ref) => `${ref.repository.toLowerCase()}#${ref.number}`).sort(),
        evidence.report ? [evidence.report.childSessionId, evidence.report.seq, evidence.report.eventEpoch] : null,
      ]);
      const attempts = this.stmt("SELECT * FROM campaign_work_attempts WHERE work_item_id=? ORDER BY ordinal")
        .all(item.id) as unknown as AttemptRow[];
      const latest = attempts.at(-1);
      const current = currentDelivery(this.stmt(
        "SELECT * FROM campaign_work_deliveries WHERE work_item_id=? ORDER BY recorded_at, rowid",
      ).all(item.id) as unknown as DeliveryRow[], latest);
      if (current?.evidence_key === key) {
        return done({ revision: this.revision(campaignId), deliveryId: current.id, itemId: item.id });
      }
      if (current || (latest && this.stmt(
        "SELECT 1 FROM campaign_work_verifications WHERE attempt_id=? AND outcome='delivered'",
      ).get(latest.id))) {
        return fail("the work item is already delivered", 409);
      }
      let reportAttempt: AttemptRow | null = null;
      if (evidence.report) {
        const found = this.reportAttempt(campaignId, item.id, evidence.report);
        if (!found.ok) return found;
        reportAttempt = found.data.attempt;
      }
      const id = newId(CAMPAIGN_WORK_DELIVERY_ID_PREFIX);
      this.stmt(
        `INSERT INTO campaign_work_deliveries
           (id, campaign_session_id, work_item_id, after_ordinal, pull_requests, report_child_session_id,
            report_attempt_id, report_seq, evidence_key, note, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, campaignId, item.id, latest?.ordinal ?? 0,
        JSON.stringify(pullRequests.map(({ repository, number, mergeCommitSha, baseRef }) => ({ repository, number, mergeCommitSha, baseRef }))),
        evidence.report?.childSessionId ?? null, reportAttempt?.id ?? null, evidence.report?.seq ?? null, key,
        evidence.note, actorSessionId, now);
      if (evidence.report && reportAttempt) {
        const report = evidence.report;
        const existing = this.stmt(
          `SELECT 1 FROM campaign_work_verifications WHERE attempt_id=? AND outcome='delivered' AND report_seq=?
             AND report_event_epoch IS ? AND report_digest IS ?`,
        ).get(reportAttempt.id, report.seq, report.eventEpoch, report.digest);
        if (!existing) {
          this.stmt(
            `INSERT INTO campaign_work_verifications
             (id, campaign_session_id, work_item_id, attempt_id, child_session_id, outcome, report_seq,
              report_event_epoch, report_digest, report_ts, verified_by_session_id, verified_at)
             VALUES (?, ?, ?, ?, ?, 'delivered', ?, ?, ?, ?, ?, ?)`,
          ).run(newId(CAMPAIGN_WORK_VERIFICATION_ID_PREFIX), campaignId, item.id, reportAttempt.id, report.childSessionId,
            report.seq, report.eventEpoch, report.digest, report.ts, actorSessionId, now);
        }
      }
      const open = attempts.find((attempt) => attempt.ended_at === null);
      if (open) {
        const own = open.id === reportAttempt?.id;
        this.closeAttempt(open, own ? "delivered" : "superseded", now, own ? null : `delivery recorded as ${id}`);
      }
      this.stmt("UPDATE campaign_work_items SET updated_at=? WHERE id=?").run(now, item.id);
      return done({ revision: this.bump(campaignId, now), deliveryId: id, itemId: item.id });
    });
  }

  delivery(campaignId: string, deliveryId: string): CampaignWorkItemRecordedDelivery | null {
    const row = this.stmt("SELECT * FROM campaign_work_deliveries WHERE campaign_session_id=? AND id=?")
      .get(campaignId, deliveryId) as DeliveryRow | undefined;
    return row ? deliveryView(row) : null;
  }

  /** Items whose handoff to `human` or `external` lets the campaign finish without them (#4070).
   * Whether each is still unfinished is the caller's to check. */
  terminalHandoffItemIds(campaignId: string): Set<string> {
    return new Set((this.stmt(
      "SELECT work_item_id FROM campaign_work_handoffs WHERE campaign_session_id=? AND responsible_actor IN ('human','external')",
    ).all(campaignId) as Array<{ work_item_id: string }>).map((row) => row.work_item_id));
  }

  /** #4067: the committed work item naming each pull request (`owner/repo#N`, lowercased), through
   * its reported stage or a recorded delivery, with that item's handoff to `human` or `external`
   * when it has one. A pull request named by several items keeps one with such a handoff, else the
   * first. */
  pullRequestWorkItems(campaignId: string): Map<string, { workItemId: string; handoff: CampaignWorkItemHandoff | null }> {
    const handoffs = new Map((this.stmt(
      "SELECT * FROM campaign_work_handoffs WHERE campaign_session_id=? AND responsible_actor IN ('human','external')",
    ).all(campaignId) as unknown as HandoffRow[]).map((row) => [row.work_item_id, handoffView(row)]));
    const named: Array<{ id: string; refs: CampaignPullRequestRef[] }> = [];
    for (const item of this.stmt(
      "SELECT id, stage_pull_requests FROM campaign_work_items WHERE campaign_session_id=? AND commitment='committed' ORDER BY rowid",
    ).all(campaignId) as Array<{ id: string; stage_pull_requests: string | null }>) {
      named.push({ id: item.id, refs: item.stage_pull_requests ? JSON.parse(item.stage_pull_requests) as CampaignPullRequestRef[] : [] });
    }
    for (const delivery of this.stmt(
      `SELECT delivery.work_item_id, delivery.pull_requests FROM campaign_work_deliveries delivery
       JOIN campaign_work_items item ON item.id=delivery.work_item_id AND item.commitment='committed'
       WHERE delivery.campaign_session_id=? ORDER BY delivery.rowid`,
    ).all(campaignId) as Array<{ work_item_id: string; pull_requests: string }>) {
      named.push({ id: delivery.work_item_id, refs: JSON.parse(delivery.pull_requests) as CampaignPullRequestRef[] });
    }
    const result = new Map<string, { workItemId: string; handoff: CampaignWorkItemHandoff | null }>();
    for (const { id, refs } of named) {
      for (const ref of refs) {
        const key = `${ref.repository.toLowerCase()}#${ref.number}`;
        const known = result.get(key);
        if (!known || (!known.handoff && handoffs.has(id))) result.set(key, { workItemId: id, handoff: handoffs.get(id) ?? null });
      }
    }
    return result;
  }

  /** What campaign completion reads from the ledger (#4070): the handed-off items and how many
   * unfinished committed items an agent still owns. Shares the summary's cache. */
  completionFacts(campaignId: string): Pick<LedgerSummaryPart, "handoffs" | "agentUnfinished"> {
    const part = this.summaryPart(campaignId);
    return { handoffs: part.handoffs, agentUnfinished: part.agentUnfinished };
  }

  /* ------------------------------ Recommendations ------------------------------ */

  /** Called inside the follow-up recording transaction. */
  recordRecommendationOrigins(campaignId: string, recommendationId: string, originWorkItemIds: readonly string[], now: number): number {
    for (const itemId of new Set(originWorkItemIds)) {
      this.stmt(
        "INSERT OR IGNORE INTO campaign_recommendation_origins (recommendation_id, work_item_id) VALUES (?, ?)",
      ).run(recommendationId, itemId);
    }
    return this.bump(campaignId, now);
  }

  recommendationOrigins(recommendationId: string): string[] {
    return (this.stmt(
      "SELECT work_item_id FROM campaign_recommendation_origins WHERE recommendation_id=? ORDER BY work_item_id",
    ).all(recommendationId) as Array<{ work_item_id: string }>).map((row) => row.work_item_id);
  }

  adjudicate(
    campaignId: string,
    actorSessionId: string,
    request: AdjudicateCampaignRecommendationRequest,
    now: number,
  ): LedgerResult<{ revision: number; recommendationId: string; workItemId: string | null }> {
    if (typeof request !== "object" || request === null || !boundedText(request.recommendationId, 256)) {
      return fail("recommendationId is required");
    }
    if (!["accepted", "rejected", "deferred", "duplicate"].includes(request.disposition)) {
      return fail("disposition must be accepted, rejected, deferred, or duplicate");
    }
    if (!boundedText(request.reason, L.textLength)) return fail(`reason is required (at most ${L.textLength} characters)`);
    if (request.resultingWorkItemKey !== undefined && !boundedText(request.resultingWorkItemKey, L.keyLength)) {
      return fail("resultingWorkItemKey must be bounded");
    }
    if (request.resultingIssue !== undefined && !validIssue(request.resultingIssue)) {
      return fail(`resultingIssue must be ${REF_SHAPE}`);
    }
    if (request.publicationRequired !== undefined && typeof request.publicationRequired !== "boolean") {
      return fail("publicationRequired must be a boolean");
    }
    if (request.disposition !== "accepted" && (request.resultingIssue !== undefined || request.publicationRequired !== undefined)) {
      return fail("resultingIssue and publicationRequired apply only to an accepted recommendation");
    }
    if ((request.disposition === "rejected" || request.disposition === "deferred") && request.resultingWorkItemKey !== undefined) {
      return fail("a rejected or deferred recommendation has no resulting work item");
    }
    return this.transact(campaignId, () => {
      const recommendation = this.stmt(
        "SELECT id, title, duplicate_of FROM orchestrator_campaign_follow_ups WHERE id=? AND campaign_session_id=?",
      ).get(request.recommendationId, campaignId) as { id: string; title: string; duplicate_of: string | null } | undefined;
      if (!recommendation) return fail("recommendation not found in this campaign", 404);
      if (recommendation.duplicate_of && request.disposition !== "duplicate") {
        return fail(`this recommendation duplicates ${recommendation.duplicate_of}; adjudicate that one instead`, 409);
      }
      let workItemId: string | null = null;
      // Creating or completing the resulting item is a ledger change of its own, even when the
      // disposition row is identical to a previous adjudication.
      let itemChanged = false;
      if (request.disposition === "duplicate" && request.resultingWorkItemKey !== undefined) {
        const existing = this.itemByKey(campaignId, request.resultingWorkItemKey);
        if (!existing) return fail(`no work item has key ${request.resultingWorkItemKey}`, 404);
        workItemId = existing.id;
      }
      if (request.disposition === "accepted") {
        // Recording a published issue on an already accepted recommendation links the work item that
        // acceptance created, never a second one (#3918). An explicit key still chooses another.
        const linked = request.resultingWorkItemKey === undefined ? this.stmt(
          `SELECT item.item_key FROM campaign_recommendation_dispositions disposition
           JOIN campaign_work_items item ON item.id=disposition.resulting_work_item_id
           WHERE disposition.recommendation_id=? AND disposition.disposition='accepted'`,
        ).get(recommendation.id) as { item_key: string } | undefined : undefined;
        const key = request.resultingWorkItemKey ?? linked?.item_key ??
          (request.resultingIssue ? `${request.resultingIssue.repository}#${request.resultingIssue.number}` : `followup:${recommendation.id}`);
        const existing = this.itemByKey(campaignId, key);
        if (existing) {
          // Accepted work links only a follow-up item; a match in the original scope is a duplicate.
          if (existing.origin !== "follow_up") {
            return fail(`work item ${key} is original scope; adjudicate the recommendation as duplicate instead`, 409);
          }
          const resultingIssue = request.resultingIssue;
          if (resultingIssue && existing.issue_repository !== null &&
              (existing.issue_repository.toLowerCase() !== resultingIssue.repository.toLowerCase() ||
                existing.issue_number !== resultingIssue.number)) {
            return fail(`work item ${key} already tracks ${existing.issue_repository}#${existing.issue_number}`, 409);
          }
          workItemId = existing.id;
          // Accepting this recommendation below binds its issue, and its recommendation, to an admitted item.
          if (resultingIssue && existing.issue_repository === null) {
            this.stmt("UPDATE campaign_work_items SET issue_repository=?, issue_number=?, updated_at=? WHERE id=?")
              .run(resultingIssue.repository, resultingIssue.number, now, existing.id);
            itemChanged = true;
          }
        } else {
          const count = Number((this.stmt(
            "SELECT COUNT(*) AS count FROM campaign_work_items WHERE campaign_session_id=?",
          ).get(campaignId) as { count: number }).count);
          if (count >= L.workItemsPerCampaign) {
            return fail(`a campaign may hold at most ${L.workItemsPerCampaign} work items`, 409);
          }
          const originGeneration = this.stmt(
            `SELECT MAX(item.generation) AS generation FROM campaign_recommendation_origins origin
             JOIN campaign_work_items item ON item.id=origin.work_item_id WHERE origin.recommendation_id=?`,
          ).get(recommendation.id) as { generation: number | null };
          workItemId = newId(CAMPAIGN_WORK_ITEM_ID_PREFIX);
          this.stmt(
            `INSERT INTO campaign_work_items
             (id, campaign_session_id, item_key, title, issue_repository, issue_number, origin, generation,
              dispatch_state, commitment, commitment_changed_at, commitment_changed_by, created_by_session_id,
              created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'follow_up', ?, 'planned', 'committed', ?, ?, ?, ?, ?)`,
          ).run(
            workItemId, campaignId, key, recommendation.title.slice(0, L.titleLength),
            request.resultingIssue?.repository ?? null, request.resultingIssue?.number ?? null,
            (originGeneration.generation ?? 0) + 1, now, actorSessionId, actorSessionId, now, now,
          );
          itemChanged = true;
        }
      }
      if (request.disposition === "accepted" && workItemId) {
        const admitted = this.item(campaignId, workItemId)!;
        const refused = this.hooks.acceptFollowUp?.(campaignId, workItemId, { kind: "recommendation", recommendationId: recommendation.id },
          { title: admitted.title, issue: itemIssue(admitted.issue_repository, admitted.issue_number) });
        if (refused) return fail(refused.error, 409, refused.details);
      }
      const previous = this.stmt(
        `SELECT disposition, reason, publication_required, resulting_issue_repository, resulting_issue_number,
           resulting_work_item_id FROM campaign_recommendation_dispositions WHERE recommendation_id=?`,
      ).get(recommendation.id) as Record<string, unknown> | undefined;
      const next = {
        disposition: request.disposition,
        reason: request.reason.trim(),
        publication_required: request.publicationRequired === false ? 0 : 1,
        resulting_issue_repository: request.resultingIssue?.repository ?? null,
        resulting_issue_number: request.resultingIssue?.number ?? null,
        resulting_work_item_id: workItemId,
      };
      if (previous && Object.entries(next).every(([key, value]) => previous[key] === value)) {
        return done({
          revision: itemChanged ? this.bump(campaignId, now) : this.revision(campaignId),
          recommendationId: recommendation.id,
          workItemId,
        });
      }
      this.stmt(
        `INSERT INTO campaign_recommendation_dispositions
         (recommendation_id, disposition, reason, publication_required, resulting_issue_repository,
          resulting_issue_number, resulting_work_item_id, adjudicated_by_session_id, adjudicated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(recommendation_id) DO UPDATE SET disposition=excluded.disposition, reason=excluded.reason,
           publication_required=excluded.publication_required,
           resulting_issue_repository=excluded.resulting_issue_repository,
           resulting_issue_number=excluded.resulting_issue_number,
           resulting_work_item_id=excluded.resulting_work_item_id,
           adjudicated_by_session_id=excluded.adjudicated_by_session_id, adjudicated_at=excluded.adjudicated_at`,
      ).run(recommendation.id, next.disposition, next.reason, next.publication_required,
        next.resulting_issue_repository, next.resulting_issue_number, workItemId, actorSessionId, now);
      return done({ revision: this.bump(campaignId, now), recommendationId: recommendation.id, workItemId });
    });
  }

  private recommendationRows(campaignId: string): RecommendationRow[] {
    return this.stmt(
      `SELECT follow_up.id, follow_up.origin_session_id, follow_up.repository, follow_up.title,
         follow_up.recommendation_key, follow_up.duplicate_of, follow_up.created_at, disposition.disposition,
         disposition.reason, disposition.publication_required, disposition.resulting_issue_repository,
         disposition.resulting_issue_number, disposition.resulting_work_item_id,
         disposition.adjudicated_by_session_id, disposition.adjudicated_at
       FROM orchestrator_campaign_follow_ups follow_up
       LEFT JOIN campaign_recommendation_dispositions disposition ON disposition.recommendation_id=follow_up.id
       WHERE follow_up.campaign_session_id=? ORDER BY follow_up.created_at DESC, follow_up.id`,
    ).all(campaignId) as unknown as RecommendationRow[];
  }

  private recommendationView(row: RecommendationRow): CampaignRecommendation {
    const disposition: CampaignRecommendationDisposition = row.disposition ?? (row.duplicate_of ? "duplicate" : "awaiting_adjudication");
    const resultingIssue = issueOf(row.resulting_issue_repository, row.resulting_issue_number);
    const resultingItem = row.resulting_work_item_id
      ? this.stmt("SELECT issue_repository, issue_number FROM campaign_work_items WHERE id=?")
        .get(row.resulting_work_item_id) as { issue_repository: string | null; issue_number: number | null } | undefined
      : undefined;
    const itemIssue = resultingItem ? issueOf(resultingItem.issue_repository, resultingItem.issue_number) : null;
    return {
      id: row.id,
      repository: row.repository,
      title: row.title,
      ...(row.recommendation_key ? { recommendationKey: row.recommendation_key } : {}),
      originSessionId: row.origin_session_id,
      originWorkItemIds: this.recommendationOrigins(row.id),
      duplicateOfId: row.duplicate_of,
      disposition,
      dispositionReason: row.reason,
      adjudicatedAt: row.adjudicated_at,
      adjudicatedBySessionId: row.adjudicated_by_session_id,
      publication: disposition !== "accepted" || row.publication_required === 0 ? "not_required"
        : resultingIssue || itemIssue ? "published" : "awaiting_publication",
      resultingIssue: resultingIssue ?? itemIssue,
      resultingWorkItemId: row.resulting_work_item_id,
      createdAt: row.created_at,
    };
  }

  recommendationDisposition(recommendationId: string, duplicate: boolean): CampaignRecommendationDisposition {
    const row = this.stmt("SELECT disposition FROM campaign_recommendation_dispositions WHERE recommendation_id=?")
      .get(recommendationId) as { disposition: CampaignRecommendationDisposition } | undefined;
    return row?.disposition ?? (duplicate ? "duplicate" : "awaiting_adjudication");
  }

  recommendation(campaignId: string, recommendationId: string): CampaignRecommendation | null {
    const row = this.recommendationRows(campaignId).find((candidate) => candidate.id === recommendationId);
    return row ? this.recommendationView(row) : null;
  }

  recommendations(campaignId: string): CampaignRecommendation[] {
    return this.recommendationRows(campaignId).map((row) => this.recommendationView(row));
  }

  recommendationsPage(campaignId: string, query: CampaignRecommendationsQuery): LedgerResult<CampaignRecommendationsPage> {
    const limit = pageLimit(query.limit);
    if (!limit.ok) return limit;
    const disposition = query.disposition ?? "all";
    if (disposition !== "all" && !["awaiting_adjudication", "accepted", "rejected", "deferred", "duplicate"].includes(disposition)) {
      return fail("disposition filter is not recognized");
    }
    const revision = this.revision(campaignId);
    const key = cursorKey({ list: "recommendations", disposition });
    const offset = decodeCursor(query.cursor, revision, key);
    if (!offset.ok) return offset;
    const all = this.recommendationRows(campaignId).map((row) => this.recommendationView(row))
      .filter((recommendation) => disposition === "all" || recommendation.disposition === disposition)
      .sort((a, b) => Number(b.disposition === "awaiting_adjudication") - Number(a.disposition === "awaiting_adjudication") ||
        b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    const items = all.slice(offset.data, offset.data + limit.data);
    const end = offset.data + items.length;
    return done({ revision, items, nextCursor: end < all.length ? encodeCursor(revision, key, end) : null, total: all.length });
  }

  /* ------------------------------ Reads ------------------------------ */

  private snapshot(campaignId: string): LedgerSnapshot {
    const ledger = this.stmt(
      "SELECT revision, plan_state, created_at FROM campaign_work_ledgers WHERE campaign_session_id=?",
    ).get(campaignId) as { revision: number; plan_state: CampaignPlanState; created_at: number } | undefined;
    const items = this.stmt(
      "SELECT * FROM campaign_work_items WHERE campaign_session_id=? ORDER BY created_at, id",
    ).all(campaignId) as unknown as ItemRow[];
    const dependencies = this.dependencyEdges(campaignId);
    const attempts = new Map<string, AttemptRow[]>();
    for (const row of this.stmt(
      "SELECT * FROM campaign_work_attempts WHERE campaign_session_id=? ORDER BY work_item_id, ordinal",
    ).all(campaignId) as unknown as AttemptRow[]) {
      attempts.set(row.work_item_id, [...(attempts.get(row.work_item_id) ?? []), row]);
    }
    const verifications = new Map<string, VerificationRow[]>();
    for (const row of this.stmt(
      "SELECT * FROM campaign_work_verifications WHERE campaign_session_id=? ORDER BY verified_at, id",
    ).all(campaignId) as unknown as VerificationRow[]) {
      verifications.set(row.work_item_id, [...(verifications.get(row.work_item_id) ?? []), row]);
    }
    const handoffs = new Map((this.stmt("SELECT * FROM campaign_work_handoffs WHERE campaign_session_id=?")
      .all(campaignId) as unknown as HandoffRow[]).map((row) => [row.work_item_id, row]));
    const deliveries = new Map<string, DeliveryRow[]>();
    for (const row of this.stmt(
      "SELECT * FROM campaign_work_deliveries WHERE campaign_session_id=? ORDER BY work_item_id, recorded_at, rowid",
    ).all(campaignId) as unknown as DeliveryRow[]) {
      deliveries.set(row.work_item_id, [...(deliveries.get(row.work_item_id) ?? []), row]);
    }
    // #4120: where each item works, and which of its dependencies are in another repository.
    const placements = new Map<string, string | null>();
    const itemInputs = new Map(items.map((item) => {
      const sessionId = attempts.get(item.id)?.at(-1)?.session_id ?? null;
      if (sessionId && !placements.has(sessionId)) placements.set(sessionId, this.hooks.sessionRepository?.(campaignId, sessionId) ?? null);
      return [item.id, { placement: sessionId ? placements.get(sessionId)! : null,
        pullRequests: namedPullRequests(item, deliveries.get(item.id)), issue: issueOf(item.issue_repository, item.issue_number) }];
    }));
    // The repository shown and grouped by, and every repository the item may work in (fail closed).
    const repositories = new Map([...itemInputs].map(([id, input]) => [id, campaignItemRepository(input)]));
    const workRepositories = new Map([...itemInputs].map(([id, input]) => [id, campaignItemRepositories(input)]));
    const campaignRepositories = (this.hooks.campaignRepositories?.(campaignId) ?? []).map((repository) => repository.toLowerCase());
    const byId = new Map(items.map((item) => [item.id, item]));
    const now = Date.now();
    const prerequisiteOf = new Map<string, CampaignMergePrerequisite | null>();
    const prerequisite = (id: string): CampaignMergePrerequisite | null => {
      if (prerequisiteOf.has(id)) return prerequisiteOf.get(id)!;
      const row = byId.get(id);
      const refs = row ? namedPullRequests(row, deliveries.get(id)) : [];
      // A pull request in no repository of the campaign is read through the root's login at best,
      // which never proves it merged: its fact is unavailable here, whatever is stored (#4120).
      const inside = (ref: CampaignPullRequestRef) => !campaignRepositories.length || campaignRepositories.includes(ref.repository.toLowerCase());
      const readable = refs.filter(inside);
      const facts = new Map((readable.length ? this.hooks.forgePullRequests?.(campaignId, readable, now) ??
        readable.map((ref) => ({ ref, fact: { availability: "unavailable", reason: "not_collected" } as const })) : [])
        .map((entry) => [forgeRefKeyOf(entry.ref), entry]));
      const record = row ? { id, key: row.item_key, title: row.title, repository: repositories.get(id) ?? null, commitment: row.commitment,
        pullRequests: refs.map((ref) => inside(ref) ? facts.get(forgeRefKeyOf(ref))!
          : { ref, fact: { availability: "unavailable", reason: "forge_unsupported" } as const, outside: true as const }) } : null;
      prerequisiteOf.set(id, record);
      return record;
    };
    const prerequisitesOf = (itemId: string, dependentRepositories: readonly string[]): CampaignMergePrerequisite[] =>
      (dependencies.get(itemId) ?? []).flatMap((id) => {
        const record = isCampaignMergeDependency(dependentRepositories, workRepositories.get(id) ?? [], campaignRepositories) ? prerequisite(id) : null;
        return record ? [record] : [];
      });
    const mergePrerequisites = new Map(items.map((item) => [item.id, prerequisitesOf(item.id, workRepositories.get(item.id) ?? [])]));
    // A merge waits for the prerequisites of every item naming its pull request, and of its requester's
    // own item, whoever requests it (#4120): a worker, a child whose attempt ended, or the root.
    const prerequisitesForMerge = (pullRequest: CampaignPullRequestRef, workItemId: string | null): CampaignMergePrerequisite[] => {
      const key = forgeRefKeyOf(pullRequest);
      const dependents = new Set(items.filter((item) => itemInputs.get(item.id)!.pullRequests.some((ref) => forgeRefKeyOf(ref) === key)).map((item) => item.id));
      if (workItemId && byId.has(workItemId)) dependents.add(workItemId);
      const found = new Map<string, CampaignMergePrerequisite>();
      for (const itemId of dependents) for (const record of prerequisitesOf(itemId, [pullRequest.repository.toLowerCase()])) found.set(record.id, record);
      return [...found.values()];
    };
    // #4120: whether a dependent's own merge happened, which decides whether a verified report is
    // delivered or still waits on its prerequisites. It agrees with closure proof (`deliveryCandidates`,
    // `itemDelivered` in campaign-issue-authority.ts): the candidates are the pull requests the item
    // names and those a delivered attempt merged through a consumed gate; one closed without merging
    // is set aside, any other must have merged (a gated one at a head its gate approved), and at least
    // one must have. Unlike the proof it needs no fresh read: a merge stays a merge as it ages, and a
    // read that failed since doesn't undo the merged value stored. In a repository outside the proof's,
    // or never read, nothing is known merged.
    const ownPullRequestsMerged = (itemId: string): boolean => {
      const row = byId.get(itemId);
      if (!row) return false;
      const issue = issueOf(row.issue_repository, row.issue_number);
      const proof = new Set([...campaignRepositories, ...(issue ? [issue.repository.toLowerCase()] : [])]);
      const candidates = new Map<string, { ref: CampaignPullRequestRef; heads: string[] }>(
        itemInputs.get(itemId)!.pullRequests.map((ref) => [forgeRefKeyOf(ref), { ref, heads: [] }]));
      const itemAttempts = attempts.get(itemId) ?? [];
      const windows = (verifications.get(itemId) ?? []).flatMap((verification) => {
        const attempt = verification.outcome === "delivered" ? itemAttempts.find((candidate) => candidate.id === verification.attempt_id) : undefined;
        const until = verification.report_ts ?? attempt?.ended_at;
        return attempt?.session_id && attempt.session_id === verification.child_session_id && until !== null && until !== undefined
          ? [{ sessionId: attempt.session_id, from: attempt.started_at, until }] : [];
      });
      const issueKey = issue ? `${issue.repository}#${issue.number}`.toLowerCase() : null;
      for (const gate of windows.length ? this.hooks.consumedPullRequestMerges?.(windows.map((window) => window.sessionId)) ?? [] : []) {
        if (!proof.has(gate.repository.toLowerCase()) ||
            !windows.some((window) => window.sessionId === gate.sessionId && gate.createdAt >= window.from && gate.createdAt <= window.until) ||
            gate.intendedClosures?.length && !gate.intendedClosures.some((closure) => closure.toLowerCase() === issueKey)) continue;
        const ref = { repository: gate.repository, number: gate.pullRequest };
        candidates.set(forgeRefKeyOf(ref), { ref, heads: [...(candidates.get(forgeRefKeyOf(ref))?.heads ?? []), gate.headSha] });
      }
      const refs = [...candidates.values()].map(({ ref }) => ref);
      if (!refs.length || refs.some((ref) => proof.size && !proof.has(ref.repository.toLowerCase()))) return false;
      const facts = this.hooks.forgePullRequests?.(campaignId, refs, now) ?? [];
      if (facts.length !== refs.length) return false;
      let merged = 0;
      for (const { ref, fact } of facts) {
        const value = fact.availability === "unavailable" ? fact.lastValue : fact.value;
        if (!value) return false;
        if (value.state === "closed") continue;
        const heads = candidates.get(forgeRefKeyOf(ref))!.heads;
        if (value.state !== "merged" || !value.mergeCommitSha || (heads.length && !heads.includes(value.headSha))) return false;
        merged += 1;
      }
      return merged > 0;
    };
    const observations = new Map<string, CampaignAttemptSessionObservation | null>();
    const records = items.map((item) => {
      const latest = attempts.get(item.id)?.at(-1);
      const open = latest && latest.ended_at === null ? latest : undefined;
      if (open?.session_id && !observations.has(open.session_id)) {
        observations.set(open.session_id, this.hooks.observeSession(open.session_id));
      }
      return {
        id: item.id,
        commitment: item.commitment,
        dispatchState: item.dispatch_state,
        hasBlocker: item.blocker_reason !== null,
        dependsOn: dependencies.get(item.id) ?? [],
        latestAttempt: latest ? {
          open: latest.ended_at === null,
          delivered: (verifications.get(item.id) ?? [])
            .some((verification) => verification.attempt_id === latest.id && verification.outcome === "delivered"),
        } : null,
        openAttemptSession: open?.session_id ? observations.get(open.session_id) ?? null : null,
        recordedDelivery: currentDelivery(deliveries.get(item.id), latest) !== null,
        mergeDependencies: (mergePrerequisites.get(item.id) ?? []).map(campaignMergeDependencyStatus),
        ...(mergePrerequisites.get(item.id)?.length ? { ownPullRequestsMerged: ownPullRequestsMerged(item.id) } : {}),
      };
    });
    const derived = deriveCampaignWorkItemStates(records);
    const verifiedHeld = new Set(records.filter((record) => record.latestAttempt?.delivered && !record.recordedDelivery &&
      derived.get(record.id)?.state !== "delivered" && record.commitment === "committed").map((record) => record.id));
    return {
      revision: ledger?.revision ?? 0,
      planState: ledger?.plan_state ?? "not_recorded",
      ledgerCreatedAt: ledger?.created_at ?? null,
      items,
      dependencies,
      attempts,
      verifications,
      handoffs,
      deliveries,
      derived,
      verifiedHeld,
      repositories,
      mergePrerequisites,
      prerequisitesOf,
      prerequisitesForMerge,
      observations,
      usage: this.accounting.attemptUsage(campaignId),
      accountingStartedAt: this.accounting.startedAt(),
    };
  }

  /** An attempt's attributed cost. Usage before recording began was never attributed, so an
   * attempt that started earlier is a lower bound. Cost follows session access: a reader who may
   * not see the attempt's session sees `not_authorized`; a deleted session's share stays visible to
   * whoever reads the campaign. */
  private attemptCost(snapshot: LedgerSnapshot, attempt: AttemptRow, canSeeSession?: SessionVisibility): CampaignMetric<CampaignCostValue> {
    if (!visible(attempt, canSeeSession)) return NOT_AUTHORIZED;
    return campaignCostMetric(snapshot.usage.get(attempt.id) ?? CAMPAIGN_USAGE_NONE,
      snapshot.accountingStartedAt === null || attempt.started_at < snapshot.accountingStartedAt);
  }

  /** An item's cost sums its attempts, so it needs every attempt's session; an item never assigned
   * has nothing to measure yet. */
  private itemCost(snapshot: LedgerSnapshot, itemId: string, canSeeSession?: SessionVisibility): CampaignMetric<CampaignCostValue> {
    const attempts = snapshot.attempts.get(itemId) ?? [];
    if (!attempts.length) return { availability: "unavailable", reason: "not_started" };
    if (!attempts.every((attempt) => visible(attempt, canSeeSession))) return NOT_AUTHORIZED;
    const sum = attempts.reduce((total, attempt) =>
      addCampaignUsage(total, snapshot.usage.get(attempt.id) ?? CAMPAIGN_USAGE_NONE), CAMPAIGN_USAGE_NONE);
    return campaignCostMetric(sum, attempts.some((attempt) =>
      snapshot.accountingStartedAt === null || attempt.started_at < snapshot.accountingStartedAt));
  }

  /** Queue, Waiting, and Active Time of one item, replayed from the durable intervals of the item and
   * of everything it depends on. */
  private itemTimes(campaignId: string, snapshot: LedgerSnapshot, item: ItemRow, elapsed: CampaignWorkItemTimes["elapsed"],
    now: number): CampaignWorkItemTimes {
    const transitions = this.accounting.itemTransitions(campaignId);
    const statuses = this.accounting.attemptStatuses(campaignId);
    // #4120: a verified item held on a merge dependency since its verification (the live state says so).
    const heldAfterDelivery = (id: string): "unmerged" | "failed" | undefined => {
      const derived = snapshot.derived.get(id);
      if (!derived || derived.state === "delivered") return undefined;
      return derived.causes.includes("dependency_blocked") && derived.state === "blocked" && snapshot.verifiedHeld.has(id) ? "failed"
        : derived.causes.includes("dependency_unmerged") && snapshot.verifiedHeld.has(id) ? "unmerged" : undefined;
    };
    const timelines = campaignItemTimelines(snapshot.items.map((candidate) => ({
      id: candidate.id,
      createdAt: candidate.created_at,
      transitions: transitions.get(candidate.id) ?? [],
      dependsOn: snapshot.dependencies.get(candidate.id) ?? [],
      ...(heldAfterDelivery(candidate.id) ? { heldAfterDelivery: heldAfterDelivery(candidate.id) } : {}),
      attempts: (snapshot.attempts.get(candidate.id) ?? []).map((attempt) => ({
        ordinal: attempt.ordinal,
        startedAt: attempt.started_at,
        endedAt: attempt.ended_at,
        deliveredAt: (snapshot.verifications.get(candidate.id) ?? []).find((verification) =>
          verification.attempt_id === attempt.id && verification.outcome === "delivered")?.verified_at ?? null,
        statuses: statuses.get(attempt.id) ?? [],
      })),
    })));
    return {
      elapsed,
      ...campaignItemDurations(timelines.get(item.id) ?? [], snapshot.attempts.get(item.id)?.length ?? 0, now),
      asOf: now,
    };
  }

  private attemptView(row: AttemptRow): CampaignAttempt {
    return {
      id: row.id,
      workItemId: row.work_item_id,
      ordinal: row.ordinal,
      sessionId: row.session_id,
      session: {
        title: row.session_title,
        harness: row.harness ? JSON.parse(row.harness) as AgentHarnessIdentity : null,
        agentName: row.agent_name,
        model: row.model,
        effort: row.effort,
      },
      assignedBySessionId: row.assigned_by_session_id,
      startedAt: row.started_at,
      start: { eventEpoch: row.start_event_epoch, runnerHistoryEpoch: row.start_runner_history_epoch, seq: row.start_seq },
      endedAt: row.ended_at,
      end: row.ended_at === null ? null
        : { eventEpoch: row.end_event_epoch, runnerHistoryEpoch: row.end_runner_history_epoch, seq: row.end_seq },
      endReason: row.end_reason,
      endNote: row.end_note,
    };
  }

  private verificationView(row: VerificationRow): CampaignWorkItemVerification {
    return {
      id: row.id,
      workItemId: row.work_item_id,
      attemptId: row.attempt_id,
      childSessionId: row.child_session_id,
      outcome: row.outcome,
      report: { seq: row.report_seq, eventEpoch: row.report_event_epoch, digest: row.report_digest, ts: row.report_ts },
      verifiedBySessionId: row.verified_by_session_id,
      verifiedAt: row.verified_at,
    };
  }

  private summaryView(snapshot: LedgerSnapshot, item: ItemRow, canSeeSession?: SessionVisibility): CampaignWorkItemSummary {
    const attempts = snapshot.attempts.get(item.id) ?? [];
    const latest = attempts.at(-1);
    const open = latest && latest.ended_at === null ? latest : null;
    const derived = snapshot.derived.get(item.id)!;
    const deliveredAt = derived.state === "delivered"
      ? (snapshot.verifications.get(item.id) ?? []).filter((verification) =>
        verification.attempt_id === latest?.id && verification.outcome === "delivered").at(-1)?.verified_at ??
        currentDelivery(snapshot.deliveries.get(item.id), latest)?.recorded_at ?? null
      : null;
    const handoff = snapshot.handoffs.get(item.id);
    return {
      id: item.id,
      key: item.item_key,
      title: item.title,
      issue: issueOf(item.issue_repository, item.issue_number),
      origin: item.origin,
      generation: item.generation,
      primaryState: derived.state,
      stateCauses: derived.causes,
      commitment: item.commitment,
      dispatchState: item.dispatch_state,
      queuePosition: item.queue_position,
      currentAttempt: open ? { id: open.id, sessionId: open.session_id, sessionTitle: open.session_title } : null,
      attemptCount: attempts.length,
      stage: item.stage ? {
        stage: item.stage,
        note: item.stage_note,
        pullRequests: item.stage_pull_requests ? JSON.parse(item.stage_pull_requests) as CampaignPullRequestRef[] : [],
        sourceSessionId: item.stage_source_session_id,
        reportedAt: item.stage_reported_at!,
      } : null,
      blocker: item.blocker_reason !== null ? {
        reason: item.blocker_reason,
        responsibleActor: item.blocker_actor!,
        ...(item.blocker_request_occurrence_id ? { requestOccurrenceId: item.blocker_request_occurrence_id } : {}),
        recordedAt: item.blocker_recorded_at!,
        recordedBySessionId: item.blocker_recorded_by,
      } : null,
      handoff: handoff ? handoffView(handoff) : null,
      repository: snapshot.repositories.get(item.id) ?? null,
      ...(snapshot.mergePrerequisites.get(item.id)?.length
        ? { mergeDependencies: snapshot.mergePrerequisites.get(item.id)!.map(campaignMergeDependencyView) } : {}),
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      activityAt: item.updated_at,
      elapsed: {
        startedAt: attempts[0]?.started_at ?? null,
        endedAt: deliveredAt ?? (derived.state === "cancelled" || derived.state === "removed" ? item.commitment_changed_at : null),
      },
      cost: this.itemCost(snapshot, item.id, canSeeSession),
    };
  }

  summary(
    campaignId: string,
    context: {
      campaignCreatedAt: number;
      /** The campaign projection reports `verified_complete`. */
      complete: boolean;
      childSessionIds: readonly string[];
      /** Existing campaign worktree cleanup still pending. */
      cleanupPending: number;
      /** Session-cost visibility of whoever receives this summary; omitted means every session. */
      canSeeSession?: SessionVisibility;
    },
  ): CampaignWorkSummary {
    const ledger = this.summaryPart(campaignId);
    // Without a ledger row nothing was ever recorded: no child has an attempt, and any child's
    // history predates the ledger. Every campaign from before the ledger is in this state, and its
    // summary rides on every root upsert, so it reads nothing more.
    const recorded = ledger.ledgerCreatedAt !== null;
    const attempted = recorded ? this.attemptedSessionIds(campaignId) : new Set<string>();
    const untrackedChildren = context.childSessionIds.filter((id) => !attempted.has(id)).length;
    // Any child created before the ledger began has unrecorded history.
    const earliestChild = recorded && context.childSessionIds.length ? (this.stmt(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM sessions WHERE parent_session_id=?
         UNION SELECT child.id FROM sessions child JOIN descendants parent ON child.parent_session_id=parent.id
       ) SELECT MIN(sessions.created_at) AS at FROM sessions JOIN descendants USING (id)`,
    ).get(campaignId) as { at: number | null }).at : null;
    const predatesLedger = context.childSessionIds.length > 0 &&
      (!recorded || (earliestChild !== null && earliestChild < ledger.ledgerCreatedAt!));
    // The projection records when it first observed verified_complete and clears it on reopening.
    const completedAt = context.complete ? this.accounting.completedAt(campaignId) ?? this.lastVerifiedAt(campaignId) : null;
    return {
      revision: ledger.revision,
      planState: ledger.planState,
      coverage: { untrackedChildren, predatesLedger },
      counts: { ...ledger.counts, byState: { ...ledger.counts.byState } },
      recommendations: { ...ledger.recommendations },
      obligations: {
        verification: ledger.verification,
        adjudication: ledger.recommendations.awaiting_adjudication,
        publication: ledger.publication,
        cleanup: context.cleanupPending,
      },
      elapsed: { startedAt: context.campaignCreatedAt, endedAt: completedAt },
      // Usage moves without a ledger revision, so cost is read on every summary, outside the cached
      // part; it is one indexed read of the campaign's attribution rows.
      cost: this.accounting.costSummary(campaignId, context.campaignCreatedAt, context.canSeeSession),
    };
  }

  /**
   * The summary rides on every upsert of the root session, so the full ledger is read only when
   * what it derives from moved: the revision (every ledger write, and an attempt session's
   * deletion) or the observed status of an open attempt's session. Checking that costs one query
   * plus one observation per open attempt, which the live-child limit bounds.
   */
  private summaryPart(campaignId: string): LedgerSummaryPart {
    // Every ledger write creates the ledger row, so without one there are no items or attempts;
    // only follow-ups recorded before the ledger existed, none of them adjudicated.
    if (!this.stmt("SELECT 1 FROM campaign_work_ledgers WHERE campaign_session_id=?").get(campaignId)) {
      const followUps = this.stmt(
        `SELECT SUM(CASE WHEN duplicate_of IS NULL THEN 1 ELSE 0 END) AS awaiting,
                SUM(CASE WHEN duplicate_of IS NOT NULL THEN 1 ELSE 0 END) AS duplicate
         FROM orchestrator_campaign_follow_ups WHERE campaign_session_id=?`,
      ).get(campaignId) as { awaiting: number | null; duplicate: number | null };
      return {
        revision: 0,
        planState: "not_recorded",
        ledgerCreatedAt: null,
        counts: {
          committed: 0, delivered: 0, original: 0, followUp: 0, cancelled: 0, removed: 0,
          byState: Object.fromEntries(CAMPAIGN_WORK_ITEM_PRIMARY_STATES.map((state) => [state, 0])) as
            Record<CampaignWorkItemPrimaryState, number>,
        },
        recommendations: {
          awaiting_adjudication: Number(followUps.awaiting ?? 0), accepted: 0, rejected: 0, deferred: 0,
          duplicate: Number(followUps.duplicate ?? 0),
        },
        verification: 0,
        publication: 0,
        handoffs: [],
        agentUnfinished: [],
      };
    }
    const open = this.stmt(
      `SELECT id, session_id FROM campaign_work_attempts
       WHERE campaign_session_id=? AND ended_at IS NULL ORDER BY id`,
    ).all(campaignId) as Array<{ id: string; session_id: string | null }>;
    const key = `${this.revision(campaignId)}|${open.map((attempt) =>
      `${attempt.id}=${attempt.session_id ? observationKey(this.hooks.observeSession(attempt.session_id)) : "deleted"}`).join(",")}`;
    const cached = this.summaryCache.get(campaignId);
    if (cached?.key === key) {
      // Refresh recency so the busiest campaigns stay cached.
      this.summaryCache.delete(campaignId);
      this.summaryCache.set(campaignId, cached);
      return cached.part;
    }
    const snapshot = this.snapshot(campaignId);
    const byState = Object.fromEntries(CAMPAIGN_WORK_ITEM_PRIMARY_STATES.map((state) => [state, 0])) as
      Record<CampaignWorkItemPrimaryState, number>;
    let committed = 0, delivered = 0, original = 0, followUp = 0, cancelled = 0, removed = 0, verification = 0;
    const agentUnfinished: LedgerSummaryPart["agentUnfinished"] = [];
    const handoffs: OrchestratorCampaignHandoff[] = [];
    for (const item of snapshot.items) {
      const derived = snapshot.derived.get(item.id)!;
      byState[derived.state] += 1;
      if (item.commitment === "cancelled") cancelled += 1;
      else if (item.commitment === "scope_removed") removed += 1;
      else {
        committed += 1;
        if (item.origin === "original") original += 1;
        else followUp += 1;
        if (derived.state === "delivered") delivered += 1;
        else if (!FINISHED_STATES.has(derived.state)) {
          const handoff = snapshot.handoffs.get(item.id);
          if (handoff && TERMINAL_HANDOFF_ACTORS.has(handoff.responsible_actor)) {
            handoffs.push({ workItemId: item.id, key: item.item_key, title: item.title,
              issue: issueOf(item.issue_repository, item.issue_number), primaryState: derived.state, handoff: handoffView(handoff) });
          } else {
            agentUnfinished.push({ id: item.id, origin: item.origin, issue: issueOf(item.issue_repository, item.issue_number) });
          }
        }
      }
      if (derived.causes.includes("attempt_awaiting_verification")) verification += 1;
    }
    const recommendations = { awaiting_adjudication: 0, accepted: 0, rejected: 0, deferred: 0, duplicate: 0 };
    let publication = 0;
    for (const row of this.recommendationRows(campaignId)) {
      const view = this.recommendationView(row);
      recommendations[view.disposition] += 1;
      if (view.publication === "awaiting_publication") publication += 1;
    }
    const part: LedgerSummaryPart = {
      revision: snapshot.revision,
      planState: snapshot.planState,
      ledgerCreatedAt: snapshot.ledgerCreatedAt,
      counts: { committed, delivered, original, followUp, cancelled, removed, byState },
      recommendations,
      verification,
      publication,
      handoffs: handoffs.sort((a, b) => a.handoff.recordedAt - b.handoff.recordedAt || a.workItemId.localeCompare(b.workItemId)),
      agentUnfinished,
    };
    // The snapshot and the key were read in one synchronous call, so they describe the same state.
    // Inside a transaction they may yet roll back, and a later write would reuse the revision.
    if ((this.db as DatabaseSync & { isTransaction?: boolean }).isTransaction) return part;
    this.summaryCache.delete(campaignId);
    this.summaryCache.set(campaignId, { key, part });
    if (this.summaryCache.size > SUMMARY_CACHE_CAMPAIGNS) {
      this.summaryCache.delete(this.summaryCache.keys().next().value!);
    }
    return part;
  }

  /** When the latest child report or item delivery was verified: completion time for a campaign that
   * completed before the projection began recording it. */
  lastVerifiedAt(campaignId: string): number | null {
    return (this.stmt(
      `SELECT MAX(verified_at) AS at FROM (
         SELECT verified_at FROM orchestrator_campaign_child_reports WHERE campaign_session_id=?
         UNION ALL SELECT verified_at FROM campaign_work_verifications WHERE campaign_session_id=?
         UNION ALL SELECT recorded_at FROM campaign_work_deliveries WHERE campaign_session_id=?)`,
    ).get(campaignId, campaignId, campaignId) as { at: number | null }).at;
  }

  /** `canSeeSession` applies the session-cost rule for the reader; omitted means every session. */
  page(campaignId: string, query: CampaignWorkItemsQuery, now: number, canSeeSession?: SessionVisibility): LedgerResult<CampaignWorkItemsPage> {
    const limit = pageLimit(query.limit);
    if (!limit.ok) return limit;
    const state = query.state ?? "unfinished";
    if (!["unfinished", "finished", "all", ...CAMPAIGN_WORK_ITEM_PRIMARY_STATES].includes(state)) {
      return fail("state filter is not recognized");
    }
    if (query.origin !== undefined && query.origin !== "original" && query.origin !== "follow_up") {
      return fail("origin filter must be original or follow_up");
    }
    const sort = query.sort ?? "queue";
    if (!["queue", "activity", "elapsed", "cost"].includes(sort)) return fail("sort is not recognized");
    if (query.repository !== undefined && !campaignRepositoryLocation(query.repository)) {
      return fail("repository filter must be \"owner/repo\" or \"<gitlab-host>/group/project\"");
    }
    const repository = query.repository?.toLowerCase();
    const snapshot = this.snapshot(campaignId);
    const key = cursorKey({ list: "work-items", state, origin: query.origin, sort, ...(repository ? { repository } : {}) });
    const unfinished = new Set<string>(CAMPAIGN_WORK_ITEM_UNFINISHED_STATES);
    const rows = snapshot.items.map((item) => this.summaryView(snapshot, item, canSeeSession)).filter((summary) =>
      (query.origin === undefined || summary.origin === query.origin) &&
      (repository === undefined || summary.repository === repository) &&
      (state === "all" || (state === "unfinished" ? unfinished.has(summary.primaryState)
        : state === "finished" ? FINISHED_STATES.has(summary.primaryState) : summary.primaryState === state)));
    const cursor = parseCursor(query.cursor, key);
    if (!cursor.ok) return cursor;
    // Elapsed grows for every open item, so an open item overtakes a finished one with no revision
    // to show it. Every page of one cursor is therefore ordered at the time its first page was; a
    // cursor minted without that time orders at now and is refused as stale below.
    const at = sort === "elapsed" ? cursor.data?.at ?? now : undefined;
    // An item that never started shows its recorded age, so it sorts by that age too.
    const elapsed = (summary: CampaignWorkItemSummary) =>
      (summary.elapsed.endedAt ?? at ?? now) - (summary.elapsed.startedAt ?? summary.createdAt);
    const byQueue = (a: CampaignWorkItemSummary, b: CampaignWorkItemSummary) =>
      (a.queuePosition ?? Number.MAX_SAFE_INTEGER) - (b.queuePosition ?? Number.MAX_SAFE_INTEGER) ||
      a.createdAt - b.createdAt || a.id.localeCompare(b.id);
    // Highest known cost first; an item with nothing measured yet sorts after every measured one.
    const cost = (summary: CampaignWorkItemSummary) =>
      summary.cost && summary.cost.availability !== "unavailable" ? summary.cost.value.usd : -1;
    rows.sort(sort === "activity" ? (a, b) => b.activityAt - a.activityAt || byQueue(a, b)
      : sort === "elapsed" ? (a, b) => elapsed(b) - elapsed(a) || byQueue(a, b)
      : sort === "cost" ? (a, b) => cost(b) - cost(a) || byQueue(a, b)
      : byQueue);
    const binding: CursorBinding = {
      ...(sort === "cost" ? { stamp: this.accounting.orderStamp(campaignId, rows.map((row) => row.id)) } : {}),
      ...(at !== undefined ? { at } : {}),
    };
    const offset = cursorOffset(cursor.data, snapshot.revision, binding);
    if (!offset.ok) return offset;
    const items = rows.slice(offset.data, offset.data + limit.data);
    const end = offset.data + items.length;
    return done({
      revision: snapshot.revision,
      items,
      nextCursor: end < rows.length ? encodeCursor(snapshot.revision, key, end, binding) : null,
      total: rows.length,
      repositories: repositoryCounts(snapshot),
    });
  }

  detail(campaignId: string, itemId: string, now: number, canSeeSession?: SessionVisibility): CampaignWorkItemDetail | null {
    const snapshot = this.snapshot(campaignId);
    const item = snapshot.items.find((candidate) => candidate.id === itemId);
    if (!item) return null;
    const byId = new Map(snapshot.items.map((candidate) => [candidate.id, candidate]));
    const attempts = snapshot.attempts.get(item.id) ?? [];
    const latest = attempts.at(-1) ?? null;
    const open = latest?.ended_at === null ? latest : null;
    const recommendations = this.recommendationRows(campaignId).map((row) => this.recommendationView(row));
    const observation = open?.session_id ? snapshot.observations.get(open.session_id) : undefined;
    const summary = this.summaryView(snapshot, item, canSeeSession);
    return {
      ...summary,
      dependsOn: (snapshot.dependencies.get(item.id) ?? []).map((id) => ({
        id,
        key: byId.get(id)?.item_key ?? id,
        title: byId.get(id)?.title ?? null,
        primaryState: snapshot.derived.get(id)?.state ?? "blocked",
      })),
      dependents: [...snapshot.dependencies.entries()].filter(([, targets]) => targets.includes(item.id)).map(([id]) => id),
      nextAction: item.next_action,
      commitmentRecord: {
        state: item.commitment,
        reason: item.commitment_reason,
        changedAt: item.commitment_changed_at,
        changedBySessionId: item.commitment_changed_by,
      },
      attempts: attempts.map((attempt) => this.attemptView(attempt)),
      verifications: (snapshot.verifications.get(item.id) ?? []).map((row) => this.verificationView(row)),
      deliveries: (snapshot.deliveries.get(item.id) ?? []).map(deliveryView),
      sourceRecommendation: recommendations.find((recommendation) =>
        recommendation.disposition === "accepted" && recommendation.resultingWorkItemId === item.id) ?? null,
      recommendations: recommendations.filter((recommendation) => recommendation.originWorkItemIds.includes(item.id)),
      observed: {
        ...(latest ? this.observedFacts(latest.session_id, open ? observation : undefined, now) : {}),
        ...(this.hooks.forgePullRequests
          ? { pullRequests: this.hooks.forgePullRequests(campaignId, stagePullRequests(item), now) }
          : {}),
      },
      times: this.itemTimes(campaignId, snapshot, item, summary.elapsed, now),
      attemptCosts: attempts.map((attempt) => ({ attemptId: attempt.id, cost: this.attemptCost(snapshot, attempt, canSeeSession) })),
    };
  }

  /** Slice 8 background targets: the reported pull requests of every unfinished item, per campaign
   * whose root session is not archived, among campaigns naming any pull request at all. */
  forgeBackgroundTargets(
    include: (campaignId: string) => boolean = () => true,
  ): Array<{ campaignId: string; refs: CampaignPullRequestRef[] }> {
    const campaigns = (this.stmt(
      `SELECT DISTINCT item.campaign_session_id AS id FROM campaign_work_items item
       JOIN sessions root ON root.id=item.campaign_session_id AND root.archived=0
       WHERE item.commitment='committed' AND item.stage_pull_requests IS NOT NULL AND item.stage_pull_requests <> '[]'`,
    ).all() as Array<{ id: string }>).map((row) => row.id).filter(include);
    const unfinished = new Set<string>(CAMPAIGN_WORK_ITEM_UNFINISHED_STATES);
    return campaigns.map((campaignId) => {
      const snapshot = this.snapshot(campaignId);
      const open = snapshot.items.filter((item) => unfinished.has(snapshot.derived.get(item.id)?.state ?? "blocked"));
      // #4120: a delivered prerequisite is finished, but an unfinished dependent still waits for its
      // pull requests to merge, so they keep being read (a merged or closed one is then skipped).
      const refs = uniquePullRequests([...open.flatMap(stagePullRequests),
        ...open.flatMap((item) => (snapshot.mergePrerequisites.get(item.id) ?? []).flatMap((prerequisite) => prerequisite.pullRequests.flatMap((entry) => entry.outside ? [] : [entry.ref])))]);
      return { campaignId, refs };
    }).filter((target) => target.refs.length > 0);
  }

  /** #4120: what a merge of `pullRequest` waits for, with stored forge facts: the merge prerequisites
   * of every item that names the pull request (its stage or a recorded delivery) and of `workItemId`
   * (the requester's own open attempt, when it has one), as dependents in the pull request's repository.
   * The pull request decides, not who asks: a worker, a child whose attempt ended, and the root are
   * held alike. */
  mergePrerequisitesForMerge(campaignId: string, pullRequest: CampaignPullRequestRef, workItemId: string | null): CampaignMergePrerequisite[] {
    return this.snapshot(campaignId).prerequisitesForMerge(pullRequest, workItemId);
  }

  /** #4120: the item a session's open attempt works on in this campaign, or null. */
  openAttemptItem(campaignId: string, sessionId: string): string | null {
    return this.openAttemptItemFor(campaignId, sessionId);
  }

  /** Observed facts of the latest attempt's session, open or closed: a delivered item still shows
   * whether its child was archived and its worktrees retired. Forge facts belong to slice 8. */
  private observedFacts(
    sessionId: string | null,
    snapshotObservation: CampaignAttemptSessionObservation | null | undefined,
    now: number,
  ): CampaignWorkItemDetail["observed"] {
    const freshness = sessionId ? this.hooks.observationFreshness(sessionId) : null;
    const observation = snapshotObservation !== undefined ? snapshotObservation
      : sessionId ? this.hooks.observeSession(sessionId) : null;
    const worktrees = sessionId ? this.hooks.observeCleanup(sessionId) : null;
    if (!sessionId || !freshness || !observation || !worktrees) {
      return {
        session: { availability: "unavailable", reason: "session_deleted" },
        cleanup: { availability: "unavailable", reason: "session_deleted" },
      };
    }
    const fact = <T>(value: T): CampaignObservedFact<T> => freshness.fresh
      ? { availability: "fresh", value, observedAt: now }
      : { availability: "stale", value, observedAt: freshness.updatedAt };
    return {
      session: fact<CampaignObservedSessionStatus>({ sessionId, ...observation }),
      cleanup: fact<CampaignObservedCleanup>({ sessionId, worktrees }),
    };
  }
}

/** Thrown inside a ledger transaction to roll it back and surface a client error. */
export class LedgerRefusal extends Error {
  constructor(message: string, readonly status: number, readonly details?: Record<string, string | number>) {
    super(message);
  }
}
