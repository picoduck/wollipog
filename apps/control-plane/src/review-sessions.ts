import type { DatabaseSync } from "node:sqlite";
import {
  REVIEW_SESSION_OUTPUT_LIMIT_BYTES, sanitizedReviewSessionReason,
  type ReviewSessionLink, type ReviewSessionState, type ReviewSessionUpdate, type ReviewSessionView, type ReviewSessionsPage,
  type SessionReviewHarness,
} from "@wollipog/protocol";

type Row = {
  review_session_id: string; requester_session_id: string; runner_id: string; repository: string; pr_number: number;
  head_sha: string; reviewer: SessionReviewHarness; state: ReviewSessionState; output: string | null;
  output_truncated: number; reason: string | null; cancel_requested: number; created_at: number; updated_at: number;
};

const TERMINAL = new Set<string>(["completed", "failed", "cancelled"]);
const UPDATE_STATES = new Set<string>(["running", "completed", "failed", "cancelled"]);
const ACTIVE = "('requested','running')";

/** The longest prefix of `text` within `limit` UTF-8 bytes. */
function boundedText(text: string, limit: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return { text, truncated: false };
  return { text: bytes.subarray(0, limit).toString("utf8").replace(/�+$/u, ""), truncated: true };
}

export interface NewReviewSession {
  reviewSessionId: string;
  requesterSessionId: string;
  runnerId: string;
  pullRequest: { repository: string; number: number };
  headSha: string;
  reviewer: SessionReviewHarness;
}

/**
 * Review sessions (#3368). A row exists exactly for a session the control plane created as a
 * review: that is what makes the session's kind "review", and it never changes. The row records
 * whom the review is for and its one outcome. Only the runner that owns the review session may
 * report it, and a terminal state is final. A requester has at most one active review.
 */
export class ReviewSessions {
  constructor(private readonly sql: DatabaseSync) {
    sql.exec(`CREATE TABLE IF NOT EXISTS review_sessions (
      review_session_id TEXT PRIMARY KEY, requester_session_id TEXT NOT NULL, runner_id TEXT NOT NULL,
      repository TEXT NOT NULL, pr_number INTEGER NOT NULL, head_sha TEXT NOT NULL,
      reviewer TEXT NOT NULL CHECK (reviewer IN ('codex','claude-code')),
      state TEXT NOT NULL CHECK (state IN ('requested','running','completed','failed','cancelled')),
      output TEXT, output_truncated INTEGER NOT NULL DEFAULT 0, reason TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS review_sessions_requester ON review_sessions(requester_session_id);
    CREATE INDEX IF NOT EXISTS review_sessions_runner ON review_sessions(runner_id,state);
    CREATE UNIQUE INDEX IF NOT EXISTS review_sessions_one_active ON review_sessions(requester_session_id)
      WHERE state IN ${ACTIVE};`);
  }

  private row(reviewSessionId: string): Row | undefined {
    return this.sql.prepare("SELECT * FROM review_sessions WHERE review_session_id=?").get(reviewSessionId) as Row | undefined;
  }

  /** The requester's active review session, if any. */
  activeFor(requesterSessionId: string): string | null {
    const row = this.sql.prepare(`SELECT review_session_id FROM review_sessions WHERE requester_session_id=? AND state IN ${ACTIVE}`)
      .get(requesterSessionId) as { review_session_id: string } | undefined;
    return row?.review_session_id ?? null;
  }

  record(input: NewReviewSession, now: number): void {
    this.sql.prepare(`INSERT INTO review_sessions(review_session_id,requester_session_id,runner_id,repository,pr_number,head_sha,
      reviewer,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'requested',?,?)`).run(
      input.reviewSessionId, input.requesterSessionId, input.runnerId, input.pullRequest.repository, input.pullRequest.number,
      input.headSha, input.reviewer, now, now,
    );
  }

  /** What every review session of a requester has cost so far, settled usage only. */
  spentFor(requesterSessionId: string): number {
    const row = this.sql.prepare(`SELECT COALESCE(SUM(s.cost_usd), 0) AS spent FROM review_sessions r
      JOIN sessions s ON s.id = r.review_session_id WHERE r.requester_session_id=?`).get(requesterSessionId) as { spent: number };
    return row.spent;
  }

  /** Drop the row of a review session whose launch was never delivered and whose session is gone. */
  forget(reviewSessionId: string): void {
    this.sql.prepare("DELETE FROM review_sessions WHERE review_session_id=?").run(reviewSessionId);
  }

  isReviewSession(sessionId: string): boolean {
    return !!this.sql.prepare("SELECT 1 FROM review_sessions WHERE review_session_id=?").get(sessionId);
  }

  link(sessionId: string): ReviewSessionLink | null {
    const row = this.row(sessionId);
    return row ? {
      requesterSessionId: row.requester_session_id,
      pullRequest: { repository: row.repository, number: row.pr_number },
      headSha: row.head_sha,
      reviewer: row.reviewer,
    } : null;
  }

  view(reviewSessionId: string): ReviewSessionView | null {
    const row = this.row(reviewSessionId);
    return row ? {
      reviewSessionId: row.review_session_id,
      requesterSessionId: row.requester_session_id,
      pullRequest: { repository: row.repository, number: row.pr_number },
      headSha: row.head_sha,
      reviewer: row.reviewer,
      state: row.state,
      terminal: TERMINAL.has(row.state),
      validated: false,
      output: row.output,
      outputTruncated: row.output_truncated === 1,
      reason: row.reason,
      cancelRequested: row.cancel_requested === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : null;
  }

  /** A requester's reviews, newest first. */
  page(requesterSessionId: string, afterReviewSessionId: string | undefined, limit: number): ReviewSessionsPage | null {
    let afterRowId: number | undefined;
    if (afterReviewSessionId !== undefined) {
      const after = this.sql.prepare("SELECT rowid AS r FROM review_sessions WHERE review_session_id=? AND requester_session_id=?")
        .get(afterReviewSessionId, requesterSessionId) as { r: number } | undefined;
      if (!after) return null;
      afterRowId = after.r;
    }
    const rows = this.sql.prepare(`SELECT review_session_id FROM review_sessions WHERE requester_session_id=?
      ${afterRowId === undefined ? "" : "AND rowid<?"} ORDER BY rowid DESC LIMIT ?`)
      .all(...(afterRowId === undefined ? [requesterSessionId, limit + 1] : [requesterSessionId, afterRowId, limit + 1])) as Array<{ review_session_id: string }>;
    const reviews = rows.slice(0, limit).map((row) => this.view(row.review_session_id)!);
    return { reviews, nextAfterReviewSessionId: rows.length > limit ? reviews.at(-1)!.reviewSessionId : null };
  }

  /** Mark the review running once its session launches; nothing else moves it out of `requested`. */
  markRunning(reviewSessionId: string, now: number): boolean {
    return this.sql.prepare("UPDATE review_sessions SET state='running', updated_at=? WHERE review_session_id=? AND state='requested'")
      .run(now, reviewSessionId).changes > 0;
  }

  requestCancel(reviewSessionId: string, now: number): void {
    this.sql.prepare(`UPDATE review_sessions SET cancel_requested=1, updated_at=? WHERE review_session_id=? AND state IN ${ACTIVE}`)
      .run(now, reviewSessionId);
  }

  /** Accept the owning runner's report. A terminal state is final; text is bounded and reasons are
   * fixed. Returns whether anything changed. */
  accept(runnerId: string, update: ReviewSessionUpdate, now: number): boolean {
    const row = this.row(update.sessionId);
    if (!row || row.runner_id !== runnerId || TERMINAL.has(row.state) || !UPDATE_STATES.has(update.state)) return false;
    if (update.state === "running") return this.markRunning(row.review_session_id, now);
    const output = update.state === "completed" && typeof update.output === "string"
      ? boundedText(update.output, REVIEW_SESSION_OUTPUT_LIMIT_BYTES) : null;
    // A completed review always has its output; anything else is not a completion.
    const state = update.state === "completed" && !output?.text ? "failed" : update.state;
    const reason = state === "completed" ? null
      : sanitizedReviewSessionReason(update.state === "completed" ? "the review ended without a result" : update.reason);
    this.sql.prepare(`UPDATE review_sessions SET state=?, output=?, output_truncated=?, reason=?, updated_at=?
      WHERE review_session_id=?`).run(
      state, state === "completed" ? output!.text : null, state === "completed" && (output!.truncated || update.outputTruncated === true) ? 1 : 0,
      reason, now, row.review_session_id,
    );
    return true;
  }

  /** Settle an unfinished review the runner can no longer report. */
  abandon(reviewSessionId: string, reason: string, now: number): boolean {
    return this.sql.prepare(`UPDATE review_sessions SET state='failed', reason=?, updated_at=?
      WHERE review_session_id=? AND state IN ${ACTIVE}`)
      .run(sanitizedReviewSessionReason(reason), now, reviewSessionId).changes > 0;
  }

  /** Unfinished reviews on a runner, oldest first. */
  unfinished(runnerId: string): string[] {
    return (this.sql.prepare(`SELECT review_session_id FROM review_sessions WHERE runner_id=? AND state IN ${ACTIVE} ORDER BY rowid`)
      .all(runnerId) as Array<{ review_session_id: string }>).map((row) => row.review_session_id);
  }
}
