import type { DatabaseSync } from "node:sqlite";
import {
  REVIEW_ATTEMPTS_PER_ROUND, REVIEW_ROUND_BUDGET, REVIEW_SESSION_OUTPUT_LIMIT_BYTES, sanitizedReviewSessionReason, validateReviewReport,
  type ReviewAttemptRound, type ReviewAttemptVerdictView, type ReviewContinuationState, type ReviewFailureClass, type ReviewReport, type ReviewReportFinding,
  type ReviewRunHistory, type ReviewSessionLink, type ReviewSessionState, type ReviewSessionUpdate, type ReviewSessionView,
  type ReviewRunsSummary, type ReviewSessionsPage, type SessionReviewHarness,
} from "@wollipog/protocol";

type Row = {
  review_session_id: string; requester_session_id: string; runner_id: string; repository: string; pr_number: number;
  head_sha: string; reviewer: SessionReviewHarness; state: ReviewSessionState; output: string | null;
  output_truncated: number; reason: string | null; cancel_requested: number; created_at: number; updated_at: number;
  round_json: string | null; verdict_json: string | null; findings_json: string | null;
  continuation_state: string | null;
};

const TERMINAL = new Set<string>(["completed", "failed", "cancelled"]);
const UPDATE_STATES = new Set<string>(["running", "completed", "failed", "cancelled"]);
const ACTIVE = "('requested','running')";
const SHA = /^[0-9a-f]{40}$/u;
const MODES = new Set<string>(["full", "delta", "rebase"]);
const VOTES = new Set<string>(["UPVOTE", "DOWNVOTE", "INVALID"]);
const FAILURE_CLASSES = new Set<string>([
  "runner_config", "snapshot", "sandbox", "transport", "timeout", "malformed_output", "tool_policy", "evidence_contract",
]);
const MAX_SCOPE_FILES = 5000;
const MAX_VALIDATION_ERRORS = 8;
const VALIDATION_ERROR_LIMIT = 300;

const isCount = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max;
const isPath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;

/** A runner's planned round, or null when it is malformed. */
function parsedRound(value: unknown): ReviewAttemptRound | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const round = value as Partial<ReviewAttemptRound>;
  if (!isCount(round.epoch, 10_000) || !isCount(round.round, 1000) || !isCount(round.attempt, 1000) ||
      typeof round.mode !== "string" || !MODES.has(round.mode) || typeof round.baseSha !== "string" || !SHA.test(round.baseSha) ||
      !Array.isArray(round.scopeFiles) || round.scopeFiles.length > MAX_SCOPE_FILES || !round.scopeFiles.every(isPath)) return null;
  const since = round.mode === "delta" ? round.since : undefined;
  if (round.mode === "delta" && (typeof since !== "string" || !SHA.test(since))) return null;
  const from = round.mode === "rebase" ? round.rebasedFrom : undefined;
  if (round.mode === "rebase" && !(from && typeof from === "object" && typeof from.baseSha === "string" && SHA.test(from.baseSha) &&
      typeof from.headSha === "string" && SHA.test(from.headSha))) return null;
  return {
    epoch: round.epoch, round: round.round, attempt: round.attempt, mode: round.mode, baseSha: round.baseSha, scopeFiles: [...round.scopeFiles],
    ...(since ? { since } : {}),
    ...(from ? { rebasedFrom: { baseSha: from.baseSha, headSha: from.headSha } } : {}),
  };
}

/** A runner's verdict, or null when it is malformed. */
function parsedVerdict(value: unknown): ReviewAttemptVerdictView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const verdict = value as Partial<ReviewAttemptVerdictView>;
  if (typeof verdict.valid !== "boolean" || typeof verdict.consumed !== "boolean" ||
      !(verdict.effectiveVote === null || typeof verdict.effectiveVote === "string" && VOTES.has(verdict.effectiveVote)) ||
      !(verdict.failureClass === null || typeof verdict.failureClass === "string" && FAILURE_CLASSES.has(verdict.failureClass)) ||
      !Array.isArray(verdict.validationErrors) || !verdict.validationErrors.every((error) => typeof error === "string")) return null;
  return {
    valid: verdict.valid, consumed: verdict.consumed, effectiveVote: verdict.effectiveVote, failureClass: verdict.failureClass,
    validationErrors: boundedErrors(verdict.validationErrors),
  };
}

function boundedErrors(errors: string[]): string[] {
  return errors.slice(0, MAX_VALIDATION_ERRORS).map((error) => error.slice(0, VALIDATION_ERROR_LIMIT));
}

function invalidVerdict(failureClass: ReviewFailureClass, errors: string[]): ReviewAttemptVerdictView {
  return { valid: false, consumed: true, effectiveVote: "INVALID", failureClass, validationErrors: boundedErrors(errors) };
}

/**
 * The verdict the control plane records for a finished attempt. The runner judged the attempt with
 * evidence only it has (the checkout and its tree); a valid verdict is checked again here against
 * the stored head and planned scope, so only a report this control plane validated carries a vote
 * and findings. A valid verdict needs a completed state with the whole output.
 */
function settledVerdict(row: Row, state: ReviewSessionState, round: ReviewAttemptRound | null, verdict: ReviewAttemptVerdictView | null,
  output: { text: string; truncated: boolean } | null): { verdict: ReviewAttemptVerdictView | null; findings: ReviewReportFinding[] } {
  if (!verdict?.valid) return { verdict: verdict ? { ...verdict, valid: false } : null, findings: [] };
  if (state !== "completed" || !output || output.truncated || !round) {
    return { verdict: invalidVerdict("evidence_contract", ["the report could not be validated by the control plane"]), findings: [] };
  }
  let report: unknown;
  try { report = JSON.parse(output.text); } catch { report = null; }
  const errors = validateReviewReport(report, { headSha: row.head_sha, scopeFiles: round.scopeFiles });
  if (errors.length) return { verdict: invalidVerdict("evidence_contract", errors), findings: [] };
  const valid = report as ReviewReport;
  return {
    verdict: { valid: true, consumed: true, effectiveVote: valid.vote, failureClass: null, validationErrors: [] },
    findings: valid.findings,
  };
}

function json<T>(text: string | null): T | null {
  if (text === null) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}

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
    // v228 (#3369): each attempt's planned round, its contract verdict and a valid report's findings.
    const columns = new Set((sql.prepare("PRAGMA table_info(review_sessions)").all() as Array<{ name: string }>).map((c) => c.name));
    // #3369: the one continuation each finished review owes its requester, and the durable prompt
    // command that carries it: held -> delivering -> delivered | uncertain | failed, or abandoned.
    for (const column of ["round_json", "verdict_json", "findings_json", "continuation_state", "continuation_command_id"]) {
      if (!columns.has(column)) sql.exec(`ALTER TABLE review_sessions ADD COLUMN ${column} TEXT`);
    }
    if (!columns.has("continuation_updated_at")) sql.exec("ALTER TABLE review_sessions ADD COLUMN continuation_updated_at INTEGER");
    sql.exec(`CREATE INDEX IF NOT EXISTS review_sessions_run ON review_sessions(requester_session_id,repository,pr_number);
      CREATE INDEX IF NOT EXISTS review_sessions_continuation_held ON review_sessions(requester_session_id)
        WHERE continuation_state='held';
      CREATE INDEX IF NOT EXISTS review_sessions_continuation_command ON review_sessions(continuation_command_id)
        WHERE continuation_state='delivering';`);
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

  /** The requester's reviews summarized for its own view, or null when it has none. */
  summaryFor(requesterSessionId: string): ReviewRunsSummary | null {
    const row = this.sql.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(state IN ${ACTIVE}), 0) AS active,
      MAX(updated_at) AS updated_at FROM review_sessions WHERE requester_session_id=?`)
      .get(requesterSessionId) as { count: number; active: number; updated_at: number | null };
    return row.count > 0 ? { count: row.count, active: row.active, updatedAt: row.updated_at ?? 0 } : null;
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
    if (!row) return null;
    const verdict = json<ReviewAttemptVerdictView>(row.verdict_json);
    // A review of a head the pull request has since moved past.
    const stale = !!this.sql.prepare(`SELECT 1 FROM review_sessions WHERE requester_session_id=? AND repository=? AND pr_number=?
      AND rowid>(SELECT rowid FROM review_sessions WHERE review_session_id=?) AND head_sha<>? LIMIT 1`)
      .get(row.requester_session_id, row.repository, row.pr_number, row.review_session_id, row.head_sha);
    return {
      reviewSessionId: row.review_session_id,
      requesterSessionId: row.requester_session_id,
      pullRequest: { repository: row.repository, number: row.pr_number },
      headSha: row.head_sha,
      reviewer: row.reviewer,
      state: row.state,
      terminal: TERMINAL.has(row.state),
      round: json<ReviewAttemptRound>(row.round_json),
      validated: verdict !== null,
      verdict,
      findings: verdict?.valid ? json<ReviewReportFinding[]>(row.findings_json) ?? [] : [],
      stale,
      continuation: row.continuation_state === null ? null
        : row.continuation_state === "held" || row.continuation_state === "delivering" ? "pending"
        : row.continuation_state as ReviewContinuationState,
      output: row.output,
      outputTruncated: row.output_truncated === 1,
      reason: row.reason,
      cancelRequested: row.cancel_requested === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * The current epoch of a requester's review run on one pull request, from its attempts that
   * reached the reviewer (those with a planned round). An attempt without a verdict (cancelled, or
   * lost with its runner) is neither valid nor consumed.
   */
  history(requesterSessionId: string, pullRequest: { repository: string; number: number }): ReviewRunHistory {
    const rows = this.sql.prepare(`SELECT head_sha, round_json, verdict_json, findings_json FROM review_sessions
      WHERE requester_session_id=? AND repository=? AND pr_number=? AND round_json IS NOT NULL ORDER BY rowid`)
      .all(requesterSessionId, pullRequest.repository, pullRequest.number) as Array<Pick<Row, "head_sha" | "round_json" | "verdict_json" | "findings_json">>;
    const attempts = rows.flatMap((row) => {
      const round = json<ReviewAttemptRound>(row.round_json);
      return round ? [{ headSha: row.head_sha, round, verdict: json<ReviewAttemptVerdictView>(row.verdict_json), findings: row.findings_json }] : [];
    });
    const history: ReviewRunHistory = {
      epoch: 0, lastValid: null, lastAttempt: null, validRounds: 0, consumedInLastRound: 0,
      roundBudget: REVIEW_ROUND_BUDGET, attemptsPerRound: REVIEW_ATTEMPTS_PER_ROUND,
    };
    const epoch = Math.max(0, ...attempts.map((attempt) => attempt.round.epoch));
    if (!epoch) return history;
    const current = attempts.filter((attempt) => attempt.round.epoch === epoch);
    const last = current.at(-1)!;
    history.epoch = epoch;
    history.lastAttempt = { headSha: last.headSha, round: last.round.round, attempt: last.round.attempt, valid: !!last.verdict?.valid };
    const validVote = (attempt: typeof attempts[number]) => {
      const vote = attempt.verdict?.effectiveVote;
      return attempt.verdict?.valid && (vote === "UPVOTE" || vote === "DOWNVOTE") ? vote : null;
    };
    for (const attempt of current) {
      if (attempt.round.round === last.round.round && attempt.verdict?.consumed) history.consumedInLastRound += 1;
      const vote = validVote(attempt);
      if (!vote) continue;
      history.validRounds += 1;
      history.lastValid = {
        headSha: attempt.headSha, baseSha: attempt.round.baseSha, round: attempt.round.round, vote,
        findings: json<ReviewReportFinding[]>(attempt.findings) ?? [],
      };
    }
    // Until the epoch has a valid round, the last valid review before it still stands.
    const earlier = history.lastValid ? undefined : attempts.filter((attempt) => attempt.round.epoch < epoch && validVote(attempt)).at(-1);
    if (earlier) {
      history.carried = {
        headSha: earlier.headSha, baseSha: earlier.round.baseSha, findings: json<ReviewReportFinding[]>(earlier.findings) ?? [],
      };
    }
    return history;
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
    // The round is planned once; a later report cannot move the attempt to another round.
    const round = json<ReviewAttemptRound>(row.round_json) ?? (update.round === undefined ? null : parsedRound(update.round));
    if (update.state === "running") {
      const planned = row.round_json === null && round !== null && this.sql.prepare(
        "UPDATE review_sessions SET round_json=?, updated_at=? WHERE review_session_id=? AND round_json IS NULL",
      ).run(JSON.stringify(round), now, row.review_session_id).changes > 0;
      return this.markRunning(row.review_session_id, now) || planned;
    }
    const output = update.state === "completed" && typeof update.output === "string"
      ? boundedText(update.output, REVIEW_SESSION_OUTPUT_LIMIT_BYTES) : null;
    // A completed review always has its output; anything else is not a completion.
    const state = update.state === "completed" && !output?.text ? "failed" : update.state;
    const reason = state === "completed" ? null
      : sanitizedReviewSessionReason(update.state === "completed" ? "the review ended without a result" : update.reason);
    const truncated = state === "completed" && (output!.truncated || update.outputTruncated === true);
    const reported = update.verdict === undefined ? null : parsedVerdict(update.verdict);
    // A verdict that does not parse still means the reviewer ran: its attempt is invalid.
    const judged = update.verdict !== undefined && !reported
      ? invalidVerdict("evidence_contract", ["the runner's verdict was malformed"]) : reported;
    const { verdict, findings } = settledVerdict(row, state, round,
      judged, state === "completed" ? { text: output!.text, truncated } : null);
    // The requester is owed one continuation, recorded with the outcome so a crash cannot lose it.
    // A cancellation is the requester's own, so it is owed nothing.
    this.sql.prepare(`UPDATE review_sessions SET state=?, output=?, output_truncated=?, reason=?, round_json=?, verdict_json=?,
      findings_json=?, continuation_state=?, continuation_updated_at=?, updated_at=? WHERE review_session_id=?`).run(
      state, state === "completed" ? output!.text : null, truncated ? 1 : 0, reason,
      round ? JSON.stringify(round) : null, verdict ? JSON.stringify(verdict) : null, findings.length ? JSON.stringify(findings) : null,
      state === "cancelled" ? null : "held", now, now, row.review_session_id,
    );
    return true;
  }

  /** Settle an unfinished review the runner can no longer report. Its requester is owed a
   * continuation unless the requester ended it (`owed` false). */
  abandon(reviewSessionId: string, reason: string, now: number, owed = true): boolean {
    return this.sql.prepare(`UPDATE review_sessions SET state='failed', reason=?, continuation_state=?, continuation_updated_at=?,
      updated_at=? WHERE review_session_id=? AND state IN ${ACTIVE}`)
      .run(sanitizedReviewSessionReason(reason), owed ? "held" : null, now, now, reviewSessionId).changes > 0;
  }

  /** The finished reviews still owed to this requester as a continuation, oldest first. */
  heldContinuations(requesterSessionId: string): ReviewSessionView[] {
    return (this.sql.prepare(`SELECT review_session_id FROM review_sessions WHERE requester_session_id=? AND continuation_state='held'
      ORDER BY rowid`).all(requesterSessionId) as Array<{ review_session_id: string }>)
      .map((row) => this.view(row.review_session_id)!);
  }

  /** Unfinished reviews on a runner, oldest first. */
  unfinished(runnerId: string): string[] {
    return (this.sql.prepare(`SELECT review_session_id FROM review_sessions WHERE runner_id=? AND state IN ${ACTIVE} ORDER BY rowid`)
      .all(runnerId) as Array<{ review_session_id: string }>).map((row) => row.review_session_id);
  }
}
