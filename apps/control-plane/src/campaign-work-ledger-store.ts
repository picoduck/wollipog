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
  CAMPAIGN_WORK_ITEM_ID_PREFIX,
  CAMPAIGN_WORK_ITEM_PRIMARY_STATES,
  CAMPAIGN_WORK_ITEM_UNFINISHED_STATES,
  CAMPAIGN_WORK_LEDGER_LIMITS,
  CAMPAIGN_WORK_REVISION_CHANGED,
  CAMPAIGN_WORK_VERIFICATION_ID_PREFIX,
  type AdjudicateCampaignRecommendationRequest,
  type AgentHarnessIdentity,
  type CampaignAttempt,
  type CampaignAttemptBoundary,
  type CampaignAttemptEndReason,
  type CampaignAttemptSessionSnapshot,
  type CampaignIssueRef,
  type CampaignObservedCleanup,
  type CampaignObservedFact,
  type CampaignObservedSessionStatus,
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
  type CampaignWorkItemOrigin,
  type CampaignWorkItemPrimaryState,
  type CampaignWorkItemSummary,
  type CampaignWorkItemVerification,
  type CampaignWorkItemVerificationOutcome,
  type CampaignWorkItemsPage,
  type CampaignWorkItemsQuery,
  type CampaignWorkSummary,
  type RecordCampaignPlanRequest,
  type RecordCampaignPlanResponse,
  type UpdateCampaignWorkItemRequest,
} from "@wollipog/protocol";
import {
  deriveCampaignWorkItemStates,
  type CampaignAttemptSessionObservation,
  type CampaignWorkItemDerivedState,
} from "./campaign-work-state.js";

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
`;

/** `details` carries machine-readable fields a client acts on, such as `revision_changed`. */
export type LedgerResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; details?: Record<string, string | number> };

const fail = <T>(error: string, status = 400, details?: Record<string, string | number>): LedgerResult<T> =>
  ({ ok: false, status, error, ...(details ? { details } : {}) });
const done = <T>(data: T): LedgerResult<T> => ({ ok: true, data });

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
  derived: Map<string, CampaignWorkItemDerivedState>;
  observations: Map<string, CampaignAttemptSessionObservation | null>;
}

const L = CAMPAIGN_WORK_LEDGER_LIMITS;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !CONTROL.test(value);
}

function validIssue(value: unknown): value is CampaignIssueRef {
  const issue = value as CampaignIssueRef | null;
  return typeof issue === "object" && issue !== null && typeof issue.repository === "string" &&
    issue.repository.length <= 256 && REPOSITORY.test(issue.repository) &&
    Number.isSafeInteger(issue.number) && issue.number >= 1;
}

function validQueuePosition(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function validPullRequests(value: unknown): value is CampaignPullRequestRef[] {
  return Array.isArray(value) && value.length <= L.pullRequestsPerStage && value.every(validIssue);
}

function newId(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/gu, "")}`;
}

function issueOf(repository: string | null, number: number | null): CampaignIssueRef | null {
  return repository !== null && number !== null ? { repository, number } : null;
}

const FINISHED_STATES: ReadonlySet<CampaignWorkItemPrimaryState> = new Set(["delivered", "cancelled", "removed"]);

function observationKey(observation: CampaignAttemptSessionObservation | null): string {
  return observation
    ? `${observation.status}:${observation.archived ? 1 : 0}:${observation.held ? 1 : 0}:${observation.pendingRequests}`
    : "deleted";
}

function cursorKey(parts: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(parts).sort().map((key) => [key, parts[key] ?? null]));
}

function encodeCursor(revision: number, key: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, r: revision, k: key, o: offset })).toString("base64url");
}

function decodeCursor(
  cursor: string | undefined,
  revision: number,
  key: string,
): LedgerResult<number> {
  if (cursor === undefined) return done(0);
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as
      { v?: unknown; r?: unknown; k?: unknown; o?: unknown };
    if (parsed.v !== 1 || !Number.isSafeInteger(parsed.r) || typeof parsed.k !== "string" ||
        !Number.isSafeInteger(parsed.o) || (parsed.o as number) < 0) {
      return fail("cursor is malformed");
    }
    if (parsed.k !== key) return fail("cursor belongs to a different filter or sort");
    if (parsed.r !== revision) {
      return fail("the campaign ledger changed since this cursor was issued; restart from the first page", 409,
        { code: CAMPAIGN_WORK_REVISION_CHANGED, revision });
    }
    return done(parsed.o as number);
  } catch {
    return fail("cursor is malformed");
  }
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

  constructor(private readonly db: DatabaseSync, private readonly hooks: CampaignWorkLedgerHooks) {}

  private stmt(sql: string): ReturnType<DatabaseSync["prepare"]> {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** Run one ledger mutation atomically. A refusal, returned or thrown, rolls back every write. */
  private transact<T>(work: () => LedgerResult<T>): LedgerResult<T> {
    try {
      return this.hooks.atomic(() => {
        const result = work();
        if (!result.ok) throw new LedgerRefusal(result.error, result.status, result.details);
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
      if ([...(edges.get(itemId) ?? [])].sort().join("\n") === [...unique].sort().join("\n")) continue;
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
        return fail(`${at}.issue must be {repository: "owner/repo", number}`);
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
    return this.transact(() => {
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
      "blocker", "nextAction", "endAttempt"] as const;
    if (!fields.some((field) => request[field] !== undefined)) return fail("no field to update");
    if (request.title !== undefined && request.title !== null && !boundedText(request.title, L.titleLength)) {
      return fail(`title must be at most ${L.titleLength} characters`);
    }
    if (request.issue !== undefined && request.issue !== null && !validIssue(request.issue)) {
      return fail("issue must be {repository: \"owner/repo\", number}");
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
        return fail(`stage.pullRequests must list at most ${L.pullRequestsPerStage} {repository, number} refs`);
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
    const endAttempt = request.endAttempt;
    if (endAttempt !== undefined && (typeof endAttempt !== "object" || endAttempt === null ||
        (endAttempt.reason !== "abandoned" && endAttempt.reason !== "failed") ||
        (endAttempt.note !== undefined && !boundedText(endAttempt.note, L.textLength)))) {
      return fail("endAttempt.reason must be abandoned or failed");
    }
    return this.transact(() => {
      const item = this.item(campaignId, request.workItemId);
      if (!item) return fail<{ revision: number; itemId: string }>("work item not found in this campaign", 404);
      const sets: string[] = [];
      const values: Array<string | number | null> = [];
      const set = (column: string, value: string | number | null, current: unknown) => {
        if (value === current) return;
        sets.push(`${column}=?`);
        values.push(value);
      };
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
    return this.transact(() => {
      const item = this.item(campaignId, workItemId);
      if (!item) return fail("work item not found in this campaign", 404);
      if (item.commitment !== "committed") {
        return fail(`a ${item.commitment === "cancelled" ? "cancelled" : "removed"} work item cannot be assigned; recommit it first`, 409);
      }
      const sessionOpen = this.openAttemptForSession(childSessionId);
      if (sessionOpen?.work_item_id === item.id) {
        return done({ revision: this.revision(campaignId), attempt: this.attemptView(sessionOpen), closedAttempts: [], created: false });
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
    return this.transact(() => {
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
      return fail("resultingIssue must be {repository: \"owner/repo\", number}");
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
    return this.transact(() => {
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
        const key = request.resultingWorkItemKey ??
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
      };
    });
    return {
      revision: ledger?.revision ?? 0,
      planState: ledger?.plan_state ?? "not_recorded",
      ledgerCreatedAt: ledger?.created_at ?? null,
      items,
      dependencies,
      attempts,
      verifications,
      derived: deriveCampaignWorkItemStates(records),
      observations,
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

  private summaryView(snapshot: LedgerSnapshot, item: ItemRow): CampaignWorkItemSummary {
    const attempts = snapshot.attempts.get(item.id) ?? [];
    const latest = attempts.at(-1);
    const open = latest && latest.ended_at === null ? latest : null;
    const derived = snapshot.derived.get(item.id)!;
    const deliveredAt = derived.state === "delivered"
      ? (snapshot.verifications.get(item.id) ?? []).filter((verification) =>
        verification.attempt_id === latest?.id && verification.outcome === "delivered").at(-1)?.verified_at ?? null
      : null;
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
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      activityAt: item.updated_at,
      elapsed: {
        startedAt: attempts[0]?.started_at ?? null,
        endedAt: deliveredAt ?? (derived.state === "cancelled" || derived.state === "removed" ? item.commitment_changed_at : null),
      },
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
    // Completion is verified when the last child report or item delivery was verified.
    const completedAt = context.complete ? (this.stmt(
      `SELECT MAX(verified_at) AS at FROM (
         SELECT verified_at FROM orchestrator_campaign_child_reports WHERE campaign_session_id=?
         UNION ALL SELECT verified_at FROM campaign_work_verifications WHERE campaign_session_id=?)`,
    ).get(campaignId, campaignId) as { at: number | null }).at : null;
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

  page(campaignId: string, query: CampaignWorkItemsQuery, now: number): LedgerResult<CampaignWorkItemsPage> {
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
    const snapshot = this.snapshot(campaignId);
    const key = cursorKey({ list: "work-items", state, origin: query.origin, sort });
    const offset = decodeCursor(query.cursor, snapshot.revision, key);
    if (!offset.ok) return offset;
    const unfinished = new Set<string>(CAMPAIGN_WORK_ITEM_UNFINISHED_STATES);
    const rows = snapshot.items.map((item) => this.summaryView(snapshot, item)).filter((summary) =>
      (query.origin === undefined || summary.origin === query.origin) &&
      (state === "all" || (state === "unfinished" ? unfinished.has(summary.primaryState)
        : state === "finished" ? FINISHED_STATES.has(summary.primaryState) : summary.primaryState === state)));
    // An item that never started shows its recorded age, so it sorts by that age too.
    const elapsed = (summary: CampaignWorkItemSummary) =>
      (summary.elapsed.endedAt ?? now) - (summary.elapsed.startedAt ?? summary.createdAt);
    const byQueue = (a: CampaignWorkItemSummary, b: CampaignWorkItemSummary) =>
      (a.queuePosition ?? Number.MAX_SAFE_INTEGER) - (b.queuePosition ?? Number.MAX_SAFE_INTEGER) ||
      a.createdAt - b.createdAt || a.id.localeCompare(b.id);
    // Cost attribution arrives with the Time and Cost slice; until then `cost` sorts by queue order.
    rows.sort(sort === "activity" ? (a, b) => b.activityAt - a.activityAt || byQueue(a, b)
      : sort === "elapsed" ? (a, b) => elapsed(b) - elapsed(a) || byQueue(a, b)
      : byQueue);
    const items = rows.slice(offset.data, offset.data + limit.data);
    const end = offset.data + items.length;
    return done({
      revision: snapshot.revision,
      items,
      nextCursor: end < rows.length ? encodeCursor(snapshot.revision, key, end) : null,
      total: rows.length,
    });
  }

  detail(campaignId: string, itemId: string, now: number): CampaignWorkItemDetail | null {
    const snapshot = this.snapshot(campaignId);
    const item = snapshot.items.find((candidate) => candidate.id === itemId);
    if (!item) return null;
    const byId = new Map(snapshot.items.map((candidate) => [candidate.id, candidate]));
    const attempts = snapshot.attempts.get(item.id) ?? [];
    const latest = attempts.at(-1) ?? null;
    const open = latest?.ended_at === null ? latest : null;
    const recommendations = this.recommendationRows(campaignId).map((row) => this.recommendationView(row));
    const observation = open?.session_id ? snapshot.observations.get(open.session_id) : undefined;
    return {
      ...this.summaryView(snapshot, item),
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
      sourceRecommendation: recommendations.find((recommendation) =>
        recommendation.disposition === "accepted" && recommendation.resultingWorkItemId === item.id) ?? null,
      recommendations: recommendations.filter((recommendation) => recommendation.originWorkItemIds.includes(item.id)),
      observed: latest ? this.observedFacts(latest.session_id, open ? observation : undefined, now) : {},
    };
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
