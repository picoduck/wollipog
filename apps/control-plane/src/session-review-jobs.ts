import { randomBytes, randomUUID } from "node:crypto";
import { REVIEW_JOBS_RETIRED_REASON } from "@wollipog/protocol";
import type { DatabaseSync } from "node:sqlite";
import {
  SESSION_REVIEW_ARTIFACT_LIMIT_BYTES, SESSION_REVIEW_SUMMARY_LIMIT_BYTES, sanitizedSessionReviewReason,
  type SessionReviewHarness, type SessionReviewJobArtifacts, type SessionReviewJobCommand, type SessionReviewJobRequest,
  type SessionReviewJobUpdate, type SessionReviewJobView, type SessionReviewJobsPage,
} from "@wollipog/protocol";

type Row = { job_id: string; session_id: string; runner_id: string; command: string; state: SessionReviewJobView["state"];
  round: number | null; attempt: number | null; reviewer: SessionReviewHarness | null; controller_digest: string | null;
  summary: string | null; reason: string | null; report: string | null; report_truncated: number; ledger: string | null;
  ledger_truncated: number; cancel_requested: number; created_at: number; updated_at: number };

const TERMINAL = new Set<string>(["completed", "failed", "not_launched"]);
const UPDATE_STATES = new Set<string>(["running", "completed", "failed", "not_launched"]);
const REVIEWERS = new Set<string>(["codex", "claude-code"]);

/** The longest prefix of `text` within `limit` UTF-8 bytes, or its tail for a ledger. */
function boundedText(text: string, limit: number, tail = false): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return { text, truncated: false };
  const slice = tail ? bytes.subarray(bytes.length - limit) : bytes.subarray(0, limit);
  return { text: slice.toString("utf8").replace(tail ? /^�+/u : /�+$/u, ""), truncated: true };
}

/**
 * Historical native review records. New admissions are retired; retained rows support archive
 * reads and cancellation-only recovery. Only the owning runner's updates carrying the job's
 * nonce are accepted, and a terminal state is final.
 */
export class SessionReviewJobs {
  constructor(private readonly sql: DatabaseSync) {
    sql.exec(`CREATE TABLE IF NOT EXISTS session_review_jobs (
      job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, runner_id TEXT NOT NULL, command TEXT NOT NULL,
      state TEXT NOT NULL, round INTEGER, attempt INTEGER, reviewer TEXT, controller_digest TEXT, summary TEXT,
      reason TEXT, report TEXT, report_truncated INTEGER NOT NULL DEFAULT 0, ledger TEXT,
      ledger_truncated INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_review_jobs_session ON session_review_jobs(session_id);
    CREATE INDEX IF NOT EXISTS session_review_jobs_runner ON session_review_jobs(runner_id,state);`);
  }

  private atomic<T>(work: () => T): T {
    this.sql.exec("SAVEPOINT session_review_job");
    try { const result = work(); this.sql.exec("RELEASE session_review_job"); return result; }
    catch (error) { this.sql.exec("ROLLBACK TO session_review_job; RELEASE session_review_job"); throw error; }
  }

  private row(jobId: string): Row | undefined {
    return this.sql.prepare("SELECT * FROM session_review_jobs WHERE job_id=?").get(jobId) as Row | undefined;
  }

  /** Historical record constructor; retired service admission must never call this. */
  create(sessionId: string, runnerId: string, request: SessionReviewJobRequest, now: number): SessionReviewJobCommand {
    return this.atomic(() => {
      if (this.sql.prepare("SELECT 1 FROM session_review_jobs WHERE session_id=? AND state IN ('requested','running')").get(sessionId)) {
        throw new Error("a historical review record for this session is still unsettled; retain it until the owning runner reports cancellation");
      }
      const command: SessionReviewJobCommand = {
        type: "session_review_job", jobId: `srj_${randomBytes(18).toString("base64url")}`, nonce: randomUUID(), sessionId, request,
      };
      this.sql.prepare(`INSERT INTO session_review_jobs(job_id,session_id,runner_id,command,state,created_at,updated_at)
        VALUES (?,?,?,?,'requested',?,?)`).run(command.jobId, sessionId, runnerId, JSON.stringify(command), now, now);
      return command;
    });
  }

  command(jobId: string): SessionReviewJobCommand | null {
    const row = this.row(jobId);
    return row ? JSON.parse(row.command) as SessionReviewJobCommand : null;
  }

  runnerId(jobId: string): string | null {
    return this.row(jobId)?.runner_id ?? null;
  }

  /** Unfinished jobs on a runner, oldest first, for cancellation after it reconnects. */
  unfinished(runnerId: string): Array<{ command: SessionReviewJobCommand; state: SessionReviewJobView["state"]; cancelRequested: boolean }> {
    return (this.sql.prepare(`SELECT command,state,cancel_requested FROM session_review_jobs
      WHERE runner_id=? AND state IN ('requested','running') ORDER BY rowid`).all(runnerId) as Array<Pick<Row, "command" | "state" | "cancel_requested">>)
      .map((row) => ({ command: JSON.parse(row.command) as SessionReviewJobCommand, state: row.state, cancelRequested: row.cancel_requested === 1 }));
  }

  view(jobId: string): SessionReviewJobView | null {
    const row = this.row(jobId);
    if (!row) return null;
    const { request } = JSON.parse(row.command) as SessionReviewJobCommand;
    return {
      jobId: row.job_id, sessionId: row.session_id, pullRequest: request.pullRequest, headSha: request.headSha,
      scope: request.scope ?? "delta", state: row.state, terminal: TERMINAL.has(row.state),
      round: row.round, attempt: row.attempt, reviewer: row.reviewer, controllerDigest: row.controller_digest,
      summary: row.summary, reason: row.reason, cancelRequested: row.cancel_requested === 1,
      hasReport: row.report !== null, reportTruncated: row.report_truncated === 1,
      hasLedger: row.ledger !== null, ledgerTruncated: row.ledger_truncated === 1,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  artifacts(jobId: string): SessionReviewJobArtifacts | null {
    const row = this.row(jobId);
    return row ? {
      jobId: row.job_id, summary: row.summary, report: row.report, reportTruncated: row.report_truncated === 1,
      ledger: row.ledger, ledgerTruncated: row.ledger_truncated === 1,
    } : null;
  }

  /** Newest first. `afterJobId` must name one of this session's jobs. */
  page(sessionId: string, afterJobId: string | undefined, limit: number): SessionReviewJobsPage | null {
    let before = Number.MAX_SAFE_INTEGER;
    if (afterJobId !== undefined) {
      const anchor = this.sql.prepare("SELECT rowid AS id FROM session_review_jobs WHERE job_id=? AND session_id=?").get(afterJobId, sessionId) as { id: number } | undefined;
      if (!anchor) return null;
      before = anchor.id;
    }
    const rows = this.sql.prepare(`SELECT job_id FROM session_review_jobs WHERE session_id=? AND rowid<?
      ORDER BY rowid DESC LIMIT ?`).all(sessionId, before, limit + 1) as Array<{ job_id: string }>;
    const visible = rows.slice(0, limit);
    return { jobs: visible.map((row) => this.view(row.job_id)!), nextAfterJobId: rows.length > limit ? visible.at(-1)!.job_id : null };
  }

  /** Mark an unfinished job for cancellation; false when it has already finished. */
  requestCancel(jobId: string, now: number): boolean {
    return Number(this.sql.prepare(`UPDATE session_review_jobs SET cancel_requested=1,reason=?,updated_at=?
      WHERE job_id=? AND state IN ('requested','running')`).run(REVIEW_JOBS_RETIRED_REASON, now, jobId).changes) > 0;
  }

  /** Finish a job the runner can no longer report on (it lost support for session reviews). */
  abandon(jobId: string, reason: string, now: number): void {
    this.sql.prepare(`UPDATE session_review_jobs SET state='failed',
      reason=?,updated_at=? WHERE job_id=? AND state IN ('requested','running')`).run(reason, now, jobId);
  }

  /** Apply one runner update. False for another runner, a wrong nonce, a malformed update, or any
   * update after the job finished (a re-sent final result changes nothing). */
  accept(runnerId: string, update: SessionReviewJobUpdate, now: number): boolean {
    return this.atomic(() => {
      if (!update || typeof update.jobId !== "string") return false;
      const row = this.sql.prepare("SELECT * FROM session_review_jobs WHERE job_id=? AND runner_id=?").get(update.jobId, runnerId) as Row | undefined;
      if (!row || TERMINAL.has(row.state)) return false;
      const command = JSON.parse(row.command) as SessionReviewJobCommand;
      const positive = (value: unknown) => value === undefined || (Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 1000);
      const text = (value: unknown) => value === undefined || typeof value === "string";
      if (update.nonce !== command.nonce || !UPDATE_STATES.has(update.state) || !positive(update.round) || !positive(update.attempt) ||
          (update.reviewer !== undefined && !REVIEWERS.has(update.reviewer)) ||
          (update.controllerDigest !== undefined && !/^[a-f0-9]{64}$/u.test(String(update.controllerDigest))) ||
          !text(update.summary) || !text(update.report) || !text(update.ledger) || !text(update.reason)) return false;
      const summary = update.summary === undefined ? undefined : boundedText(update.summary, SESSION_REVIEW_SUMMARY_LIMIT_BYTES);
      const report = update.report === undefined ? undefined : boundedText(update.report, SESSION_REVIEW_ARTIFACT_LIMIT_BYTES);
      const ledger = update.ledger === undefined ? undefined : boundedText(update.ledger, SESSION_REVIEW_ARTIFACT_LIMIT_BYTES, true);
      this.sql.prepare(`UPDATE session_review_jobs SET state=?,round=?,attempt=?,reviewer=?,controller_digest=?,summary=?,reason=?,
        report=?,report_truncated=?,ledger=?,ledger_truncated=?,updated_at=? WHERE job_id=?`).run(
        update.state, update.round ?? row.round, update.attempt ?? row.attempt, update.reviewer ?? row.reviewer,
        update.controllerDigest ?? row.controller_digest,
        summary && !summary.truncated ? summary.text : row.summary,
        update.reason === undefined ? row.reason : sanitizedSessionReviewReason(update.reason),
        report ? report.text : row.report, report ? Number(report.truncated || update.reportTruncated === true) : row.report_truncated,
        ledger ? ledger.text : row.ledger, ledger ? Number(ledger.truncated || update.ledgerTruncated === true) : row.ledger_truncated,
        now, update.jobId);
      return true;
    });
  }
}
