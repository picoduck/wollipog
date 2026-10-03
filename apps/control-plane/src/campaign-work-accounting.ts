/**
 * Campaign time and cost accounting (#2417 slice 6, docs/campaign-work-ledger.md "Time Metrics"
 * and "Usage Attribution"). Two durable records, both independent of the event cache:
 *
 * - Intervals. Triggers record every change of a work item's dispatch state, commitment, and
 *   recorded blocker, and every status change of an attempt's session while the attempt is open.
 *   Attempts already store their start and end. Together they replay each item's derived state
 *   over time (campaign-work-times.ts).
 * - Usage attribution. Every usage ledger delta of a campaign member is added, in the same
 *   transaction as the delta itself, to exactly one bucket: the session's open attempt, otherwise
 *   coordination (the root or a nested Orchestrator), otherwise unattributed. Replay and epoch
 *   replacement never reach this code a second time, because the usage watermark already refused
 *   them before the delta was written.
 *
 * Rows are keyed by the root campaign, the attempt, or the work item, which all cascade only with
 * the root. Session references are SET NULL, so archiving or deleting a child keeps its accounting.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  CampaignCostSummary,
  CampaignCostValue,
  CampaignMetric,
  CampaignMetricGapReason,
  SessionStatus,
  UsageCostSource,
} from "@wollipog/protocol";
import type {
  CampaignAttemptStatusTransition,
  CampaignItemTransition,
} from "./campaign-work-times.js";

/** The control plane's clock inside SQL, for the one trigger that has no row time to use. */
const SQL_NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

export const CAMPAIGN_WORK_ACCOUNTING_SCHEMA = `
-- One row: when this control plane began recording intervals and usage attribution. Anything
-- earlier is history_unavailable, never zero.
CREATE TABLE IF NOT EXISTS campaign_work_accounting_meta (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  started_at  INTEGER NOT NULL
);

-- Each change of a work item's dispatch state, commitment, or recorded blocker. The store stamps
-- updated_at with the mutation time, so the trigger records the ledger's own clock.
CREATE TABLE IF NOT EXISTS campaign_work_item_transitions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id    TEXT NOT NULL,
  at              INTEGER NOT NULL,
  dispatch_state  TEXT NOT NULL,
  commitment      TEXT NOT NULL,
  blocked         INTEGER NOT NULL,
  FOREIGN KEY (work_item_id) REFERENCES campaign_work_items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_campaign_work_item_transitions_item
  ON campaign_work_item_transitions(work_item_id, id);
CREATE TRIGGER IF NOT EXISTS campaign_work_item_transition_created
  AFTER INSERT ON campaign_work_items
BEGIN
  INSERT INTO campaign_work_item_transitions (work_item_id, at, dispatch_state, commitment, blocked)
  VALUES (NEW.id, NEW.created_at, NEW.dispatch_state, NEW.commitment, NEW.blocker_reason IS NOT NULL);
END;
CREATE TRIGGER IF NOT EXISTS campaign_work_item_transition_changed
  AFTER UPDATE OF dispatch_state, commitment, blocker_reason ON campaign_work_items
  WHEN OLD.dispatch_state IS NOT NEW.dispatch_state OR OLD.commitment IS NOT NEW.commitment
    OR (OLD.blocker_reason IS NULL) <> (NEW.blocker_reason IS NULL)
BEGIN
  INSERT INTO campaign_work_item_transitions (work_item_id, at, dispatch_state, commitment, blocked)
  VALUES (NEW.id, NEW.updated_at, NEW.dispatch_state, NEW.commitment, NEW.blocker_reason IS NOT NULL);
END;

-- The status of an attempt's session while the attempt is open: one row when it opens (written by
-- the store, which already observes the session), one per status or archive change, and a null
-- status when the session is deleted. Keyed by the attempt, so the history outlives the session.
-- No trigger on another table reads sessions: a migration that rebuilds sessions must not
-- find a trigger body naming it while it is absent.
CREATE TABLE IF NOT EXISTS campaign_attempt_status_transitions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id  TEXT NOT NULL,
  at          INTEGER NOT NULL,
  status      TEXT,
  archived    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (attempt_id) REFERENCES campaign_work_attempts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_campaign_attempt_status_transitions_attempt
  ON campaign_attempt_status_transitions(attempt_id, id);
CREATE TRIGGER IF NOT EXISTS campaign_attempt_status_changed
  AFTER UPDATE OF status, archived ON sessions
  WHEN OLD.status IS NOT NEW.status OR OLD.archived IS NOT NEW.archived
BEGIN
  INSERT INTO campaign_attempt_status_transitions (attempt_id, at, status, archived)
  SELECT id, MAX(NEW.updated_at, started_at), NEW.status, NEW.archived
    FROM campaign_work_attempts WHERE session_id=NEW.id AND ended_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS campaign_attempt_status_session_deleted
  AFTER UPDATE OF session_id ON campaign_work_attempts
  WHEN OLD.session_id IS NOT NULL AND NEW.session_id IS NULL AND NEW.ended_at IS NULL
BEGIN
  INSERT INTO campaign_attempt_status_transitions (attempt_id, at, status, archived)
  VALUES (NEW.id, MAX(NEW.started_at, ${SQL_NOW_MS}), NULL, 0);
END;

-- Usage attributed to one bucket by one session: one row per attempt, and one per coordinating or
-- unattributed session. Integer micro-USD sums equal the members' usage ledger deltas exactly.
CREATE TABLE IF NOT EXISTS campaign_usage_attribution (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_session_id       TEXT NOT NULL,
  bucket                    TEXT NOT NULL CHECK (bucket IN ('attempt','coordination','unattributed')),
  attempt_id                TEXT,
  work_item_id              TEXT,
  session_id                TEXT,
  input_tokens              INTEGER NOT NULL DEFAULT 0,
  output_tokens             INTEGER NOT NULL DEFAULT 0,
  cost_microusd             INTEGER NOT NULL DEFAULT 0,
  provider_reported_records INTEGER NOT NULL DEFAULT 0,
  model_priced_records      INTEGER NOT NULL DEFAULT 0,
  unpriced_records          INTEGER NOT NULL DEFAULT 0,
  first_at                  INTEGER NOT NULL,
  last_at                   INTEGER NOT NULL,
  CHECK ((bucket = 'attempt') = (attempt_id IS NOT NULL)),
  FOREIGN KEY (campaign_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id) REFERENCES campaign_work_attempts(id) ON DELETE CASCADE,
  FOREIGN KEY (work_item_id) REFERENCES campaign_work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_usage_attribution_attempt
  ON campaign_usage_attribution(attempt_id) WHERE attempt_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_usage_attribution_session
  ON campaign_usage_attribution(campaign_session_id, bucket, session_id)
  WHERE attempt_id IS NULL AND session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_campaign_usage_attribution_campaign
  ON campaign_usage_attribution(campaign_session_id, bucket);
CREATE INDEX IF NOT EXISTS idx_campaign_usage_attribution_member
  ON campaign_usage_attribution(session_id);

-- What the campaign projection last observed since recording began: completed_at is when it first
-- observed verified_complete, or null while the campaign is unfinished (including after reopening).
-- A campaign with no row has not been observed since recording began.
CREATE TABLE IF NOT EXISTS campaign_work_completion (
  campaign_session_id TEXT PRIMARY KEY,
  completed_at        INTEGER,
  FOREIGN KEY (campaign_session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
`;

/** The part of a usage ledger delta that attribution keeps. */
export interface CampaignUsageDelta {
  inputTokens: number;
  outputTokens: number;
  costMicrousd: number;
  providerReportedRecords: number;
  modelPricedRecords: number;
  unpricedRecords: number;
}

/** Where a session's usage goes when it has no open attempt. */
export interface CampaignUsageMembership {
  campaignSessionId: string;
  /** The root or a nested Orchestrator: its usage outside an attempt is coordination. */
  coordinating: boolean;
}

/** Summed attribution. `records` counts usage records, so zero is a known zero, not missing data. */
export interface CampaignUsageAmount {
  costMicrousd: number;
  providerReported: number;
  modelPriced: number;
  unpriced: number;
}

export const CAMPAIGN_USAGE_NONE: CampaignUsageAmount = { costMicrousd: 0, providerReported: 0, modelPriced: 0, unpriced: 0 };

export function addCampaignUsage(a: CampaignUsageAmount, b: CampaignUsageAmount): CampaignUsageAmount {
  return {
    costMicrousd: a.costMicrousd + b.costMicrousd,
    providerReported: a.providerReported + b.providerReported,
    modelPriced: a.modelPriced + b.modelPriced,
    unpriced: a.unpriced + b.unpriced,
  };
}

/** Weakest provenance wins. With no records there is no provenance to weaken, so `records: 0`
 * says the zero is known and `source` keeps the strongest value. */
function costSource(amount: CampaignUsageAmount): UsageCostSource {
  if (amount.unpriced > 0) return "unpriced";
  if (amount.modelPriced > 0) return "modelPriced";
  return "providerReported";
}

/** A cost metric for summed attribution. `historyGap`: some of the measured span predates
 * attribution, so the value is a lower bound. Unpriced records make it a lower bound too. */
export function campaignCostMetric(
  amount: CampaignUsageAmount,
  historyGap: boolean,
): CampaignMetric<CampaignCostValue> {
  const value: CampaignCostValue = {
    usd: amount.costMicrousd / 1_000_000,
    source: costSource(amount),
    unpricedRecords: amount.unpriced,
    records: amount.providerReported + amount.modelPriced + amount.unpriced,
  };
  const reason: CampaignMetricGapReason | null = historyGap ? "history_unavailable"
    : amount.unpriced > 0 ? "unpriced_usage" : null;
  return reason ? { availability: "partial", value, reason } : { availability: "known", value };
}

const NOT_AUTHORIZED = { availability: "unavailable", reason: "not_authorized" } as const;

interface AttributionRow {
  bucket: "attempt" | "coordination" | "unattributed";
  attempt_id: string | null;
  session_id: string | null;
  cost_microusd: number;
  provider_reported_records: number;
  model_priced_records: number;
  unpriced_records: number;
}

function amountOf(row: AttributionRow): CampaignUsageAmount {
  return {
    costMicrousd: Number(row.cost_microusd),
    providerReported: Number(row.provider_reported_records),
    modelPriced: Number(row.model_priced_records),
    unpriced: Number(row.unpriced_records),
  };
}

export class CampaignWorkAccounting {
  private readonly statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  private readonly stampKey = randomBytes(32);
  /** Told which campaign each attributed delta reached, so its cost views can be refreshed. */
  private usageObserver: ((campaignSessionId: string) => void) | null = null;

  constructor(private readonly db: DatabaseSync) {}

  /**
   * Usage moves campaign cost without a ledger revision, so nothing else re-sends the views that
   * embed it. The observer runs inside the usage transaction, before it commits, so it must only
   * schedule work for later; a rolled-back delta then costs at most one needless refresh.
   */
  observeUsage(observer: (campaignSessionId: string) => void): void {
    this.usageObserver = observer;
  }

  private stmt(sql: string): ReturnType<DatabaseSync["prepare"]> {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** When recording began, or null on a database that has not started it. */
  startedAt(): number | null {
    const row = this.stmt("SELECT started_at FROM campaign_work_accounting_meta WHERE id=1").get() as
      { started_at: number } | undefined;
    return row?.started_at ?? null;
  }

  /**
   * Begin recording once per database. Items and open attempts that already exist get one
   * transition stamped now, so their intervals are measured from here on and the span before it
   * reads as history_unavailable. Triggers record everything after.
   */
  startRecording(now: number): void {
    if (this.startedAt() !== null) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.startedAt() === null) {
        this.stmt(
          `INSERT INTO campaign_work_item_transitions (work_item_id, at, dispatch_state, commitment, blocked)
           SELECT id, ?, dispatch_state, commitment, blocker_reason IS NOT NULL FROM campaign_work_items`,
        ).run(now);
        this.stmt(
          `INSERT INTO campaign_attempt_status_transitions (attempt_id, at, status, archived)
           SELECT attempt.id, ?, session.status, COALESCE(session.archived, 0)
             FROM campaign_work_attempts attempt LEFT JOIN sessions session ON session.id=attempt.session_id
            WHERE attempt.ended_at IS NULL`,
        ).run(now);
        this.stmt("INSERT INTO campaign_work_accounting_meta (id, started_at) VALUES (1, ?)").run(now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /* ------------------------------ Usage attribution ------------------------------ */

  /**
   * Attribute one usage ledger delta. Called inside the transaction that writes the delta, after
   * the replay watermark accepted it, so each usage record lands here exactly once. `membership`
   * is resolved only when the session has no open attempt.
   */
  attributeUsage(
    sessionId: string,
    delta: CampaignUsageDelta,
    occurredAt: number,
    membership: () => CampaignUsageMembership | null,
  ): void {
    const attempt = this.stmt(
      "SELECT id, campaign_session_id, work_item_id FROM campaign_work_attempts WHERE session_id=? AND ended_at IS NULL",
    ).get(sessionId) as { id: string; campaign_session_id: string; work_item_id: string } | undefined;
    let target: { campaignSessionId: string; bucket: AttributionRow["bucket"]; attemptId: string | null; workItemId: string | null };
    if (attempt) {
      target = { campaignSessionId: attempt.campaign_session_id, bucket: "attempt", attemptId: attempt.id, workItemId: attempt.work_item_id };
    } else {
      const member = membership();
      if (!member) return;
      target = {
        campaignSessionId: member.campaignSessionId,
        bucket: member.coordinating ? "coordination" : "unattributed",
        attemptId: null,
        workItemId: null,
      };
    }
    const values = [
      delta.inputTokens, delta.outputTokens, delta.costMicrousd,
      delta.providerReportedRecords, delta.modelPricedRecords, delta.unpricedRecords,
    ];
    const updated = this.stmt(
      `UPDATE campaign_usage_attribution SET
         input_tokens=input_tokens+?, output_tokens=output_tokens+?, cost_microusd=cost_microusd+?,
         provider_reported_records=provider_reported_records+?, model_priced_records=model_priced_records+?,
         unpriced_records=unpriced_records+?, first_at=MIN(first_at, ?), last_at=MAX(last_at, ?)
       WHERE ${target.attemptId ? "attempt_id=?" : "campaign_session_id=? AND bucket=? AND session_id=? AND attempt_id IS NULL"}`,
    ).run(...values, occurredAt, occurredAt,
      ...(target.attemptId ? [target.attemptId] : [target.campaignSessionId, target.bucket, sessionId]));
    this.usageAttributed(target.campaignSessionId);
    if (Number(updated.changes) > 0) return;
    this.stmt(
      `INSERT INTO campaign_usage_attribution
         (campaign_session_id, bucket, attempt_id, work_item_id, session_id, input_tokens, output_tokens,
          cost_microusd, provider_reported_records, model_priced_records, unpriced_records, first_at, last_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(target.campaignSessionId, target.bucket, target.attemptId, target.workItemId, sessionId, ...values,
      occurredAt, occurredAt);
  }

  /** A failing observer must never fail the usage write it rides on. */
  private usageAttributed(campaignSessionId: string): void {
    try {
      this.usageObserver?.(campaignSessionId);
    } catch {
      // The refresh is best effort; the next root upsert or reload reads the cost anyway.
    }
  }

  /** Binds a cost-sorted cursor to the exact order its reader saw. That order moves without a ledger
   * revision, both as usage arrives and as the reader's cost visibility changes, and an offset into
   * a different order would skip or repeat items. Keyed with a per-process secret, so it reveals
   * nothing about hidden costs; a restart only makes outstanding cursors restart. */
  orderStamp(campaignSessionId: string, orderedIds: readonly string[]): string {
    return createHmac("sha256", this.stampKey).update(`${campaignSessionId}:${orderedIds.join(",")}`)
      .digest("base64url").slice(0, 22);
  }

  /** Usage attributed to each attempt of the campaign. An attempt with no row has none yet. */
  attemptUsage(campaignSessionId: string): Map<string, CampaignUsageAmount> {
    const usage = new Map<string, CampaignUsageAmount>();
    for (const row of this.rows(campaignSessionId)) {
      if (row.attempt_id) usage.set(row.attempt_id, amountOf(row));
    }
    return usage;
  }

  private rows(campaignSessionId: string): AttributionRow[] {
    return this.stmt(
      `SELECT bucket, attempt_id, session_id, cost_microusd, provider_reported_records, model_priced_records,
              unpriced_records
         FROM campaign_usage_attribution WHERE campaign_session_id=?`,
    ).all(campaignSessionId) as unknown as AttributionRow[];
  }

  /**
   * The campaign's cost buckets. `campaignCreatedAt` before recording began means earlier usage was
   * never split, so every bucket is a lower bound. `canSeeSession`, when given, hides a bucket any of
   * whose contributing sessions the reader may not see; a deleted session's share stays visible.
   */
  costSummary(
    campaignSessionId: string,
    campaignCreatedAt: number,
    canSeeSession?: (sessionId: string) => boolean,
  ): CampaignCostSummary {
    const startedAt = this.startedAt();
    const historyGap = startedAt === null || campaignCreatedAt < startedAt;
    const sums = { attempt: CAMPAIGN_USAGE_NONE, coordination: CAMPAIGN_USAGE_NONE, unattributed: CAMPAIGN_USAGE_NONE };
    const hidden = { attempt: false, coordination: false, unattributed: false };
    for (const row of this.rows(campaignSessionId)) {
      sums[row.bucket] = addCampaignUsage(sums[row.bucket], amountOf(row));
      // A deleted contributor's share is visible to whoever may read the campaign itself.
      if (canSeeSession && !canSeeSession(row.session_id ?? campaignSessionId)) hidden[row.bucket] = true;
    }
    const metric = (bucket: keyof typeof sums) => hidden[bucket] ? NOT_AUTHORIZED : campaignCostMetric(sums[bucket], historyGap);
    const total = addCampaignUsage(addCampaignUsage(sums.attempt, sums.coordination), sums.unattributed);
    return {
      total: hidden.attempt || hidden.coordination || hidden.unattributed ? NOT_AUTHORIZED : campaignCostMetric(total, historyGap),
      workItems: metric("attempt"),
      coordination: metric("coordination"),
      unattributed: metric("unattributed"),
      attributedSince: startedAt === null ? null : Math.max(campaignCreatedAt, startedAt),
    };
  }

  /* ------------------------------ Intervals ------------------------------ */

  /** The session's status when an attempt opens; later changes are recorded by trigger. Called in
   * the assignment's transaction. */
  recordAttemptOpened(attemptId: string, at: number, session: { status: SessionStatus; archived: boolean } | null): void {
    this.stmt("INSERT INTO campaign_attempt_status_transitions (attempt_id, at, status, archived) VALUES (?, ?, ?, ?)")
      .run(attemptId, at, session?.status ?? null, session?.archived ? 1 : 0);
  }

  /** Each item's recorded transitions, in recording order. */
  itemTransitions(campaignSessionId: string): Map<string, CampaignItemTransition[]> {
    const transitions = new Map<string, CampaignItemTransition[]>();
    for (const row of this.stmt(
      `SELECT transition.work_item_id, transition.at, transition.dispatch_state, transition.commitment, transition.blocked
         FROM campaign_work_item_transitions transition
         JOIN campaign_work_items item ON item.id=transition.work_item_id
        WHERE item.campaign_session_id=? ORDER BY transition.id`,
    ).all(campaignSessionId) as Array<{
      work_item_id: string; at: number; dispatch_state: CampaignItemTransition["dispatchState"];
      commitment: CampaignItemTransition["commitment"]; blocked: number;
    }>) {
      const list = transitions.get(row.work_item_id) ?? [];
      list.push({ at: row.at, dispatchState: row.dispatch_state, commitment: row.commitment, blocked: row.blocked === 1 });
      transitions.set(row.work_item_id, list);
    }
    return transitions;
  }

  /** Each attempt's recorded session statuses, in recording order. */
  attemptStatuses(campaignSessionId: string): Map<string, CampaignAttemptStatusTransition[]> {
    const statuses = new Map<string, CampaignAttemptStatusTransition[]>();
    for (const row of this.stmt(
      `SELECT status.attempt_id, status.at, status.status, status.archived
         FROM campaign_attempt_status_transitions status
         JOIN campaign_work_attempts attempt ON attempt.id=status.attempt_id
        WHERE attempt.campaign_session_id=? ORDER BY status.id`,
    ).all(campaignSessionId) as Array<{
      attempt_id: string; at: number; status: CampaignAttemptStatusTransition["status"]; archived: number;
    }>) {
      const list = statuses.get(row.attempt_id) ?? [];
      list.push({ at: row.at, status: row.status, archived: row.archived === 1 });
      statuses.set(row.attempt_id, list);
    }
    return statuses;
  }

  /* ------------------------------ Completion ------------------------------ */

  /**
   * Record what the campaign projection observed: the first observation of verified_complete stamps
   * the completion time, and an observation of an unfinished campaign clears it, so a reopened
   * campaign runs again until it next completes. `legacyCompletedAt` replaces `now` only for a
   * campaign created before recording began whose very first observation is already complete:
   * it finished before anything here could see it. Every later completion is stamped `now`.
   */
  observeCompletion(
    campaignSessionId: string,
    complete: boolean,
    now: number,
    legacyCompletedAt: () => number | null,
  ): void {
    const row = this.stmt("SELECT completed_at FROM campaign_work_completion WHERE campaign_session_id=?")
      .get(campaignSessionId) as { completed_at: number | null } | undefined;
    if (complete && row?.completed_at == null) {
      let completedAt = now;
      if (!row) {
        const campaign = this.stmt("SELECT created_at FROM sessions WHERE id=?").get(campaignSessionId) as
          { created_at: number } | undefined;
        if (!campaign) return;
        const startedAt = this.startedAt();
        if (startedAt === null || campaign.created_at < startedAt) completedAt = legacyCompletedAt() ?? now;
      }
      this.stmt(
        `INSERT INTO campaign_work_completion (campaign_session_id, completed_at) VALUES (?, ?)
         ON CONFLICT(campaign_session_id) DO UPDATE SET completed_at=excluded.completed_at`,
      ).run(campaignSessionId, completedAt);
    } else if (!complete && (!row || row.completed_at !== null)) {
      this.stmt(
        `INSERT INTO campaign_work_completion (campaign_session_id, completed_at) VALUES (?, NULL)
         ON CONFLICT(campaign_session_id) DO UPDATE SET completed_at=NULL`,
      ).run(campaignSessionId);
    }
  }

  completedAt(campaignSessionId: string): number | null {
    const row = this.stmt("SELECT completed_at FROM campaign_work_completion WHERE campaign_session_id=?")
      .get(campaignSessionId) as { completed_at: number | null } | undefined;
    return row?.completed_at ?? null;
  }
}
