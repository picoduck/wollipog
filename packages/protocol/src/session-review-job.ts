import { REVIEW_JOBS_RETIRED_REASON } from "./review-retirement.js";
/**
 * Retired native review bridge wire records. Keep these types for historical reads and terminal
 * cancellation receipts across mixed versions. New requests use review sessions; no current
 * runner may launch or resume the legacy controller.
 */

export type SessionReviewHarness = "codex" | "claude-code";

/** Historical runtime metadata, retained for older peers and archived runner records. */
export interface SessionReviewCapability {
  /** sha256 over the installed controller's files; provenance, not an allowlist. */
  controllerDigest?: string;
  /** Reviewer harnesses whose CLI passed the runner's trust checks. */
  reviewers: SessionReviewHarness[];
  /** Why a reviewer (or the whole feature) is unavailable, for display. */
  unavailable?: Partial<Record<SessionReviewHarness | "controller", string>>;
}

export interface SessionReviewJobRequest {
  pullRequest: { repository: string; number: number };
  /** The exact head the review must cover; it must be the pull request's pushed head. */
  headSha: string;
  /** Intent, acceptance criteria and verification. Required for a pull request's first round;
   * later rounds reuse the stored brief unless a new one is sent. */
  brief?: string;
  /** "full" re-reviews the whole pull request (with `fullReason`); otherwise a later round
   * reviews only the changes since the last valid round. */
  scope?: "delta" | "full";
  fullReason?: string;
}

export interface SessionReviewJobCommand {
  type: "session_review_job";
  jobId: string;
  nonce: string;
  sessionId: string;
  request: SessionReviewJobRequest;
}

export interface CancelSessionReviewJobCommand {
  type: "cancel_session_review_job";
  jobId: string;
  nonce: string;
}

export type SessionReviewJobState = "running" | "completed" | "failed" | "not_launched";

export interface SessionReviewJobUpdate {
  type: "session_review_job_update";
  jobId: string;
  nonce: string;
  state: SessionReviewJobState;
  round?: number;
  attempt?: number;
  reviewer?: SessionReviewHarness;
  controllerDigest?: string;
  /** The controller's one-line JSON summary (at most 2 KiB). */
  summary?: string;
  /** report.json, at most SESSION_REVIEW_ARTIFACT_LIMIT_BYTES; the full file stays on the runner. */
  report?: string;
  reportTruncated?: boolean;
  /** The ledger's tail, at most SESSION_REVIEW_ARTIFACT_LIMIT_BYTES. */
  ledger?: string;
  ledgerTruncated?: boolean;
  /** A fixed, path-free reason when the job did not complete. */
  reason?: string;
}

/** A session's review job as the control plane records it. `requested` is durable intent the
 * runner has not reported on yet; every other state is the runner's latest update. */
export interface SessionReviewJobView {
  jobId: string;
  sessionId: string;
  pullRequest: { repository: string; number: number };
  headSha: string;
  scope: "delta" | "full";
  state: SessionReviewJobState | "requested";
  /** True once `state` can no longer change. */
  terminal: boolean;
  round: number | null;
  attempt: number | null;
  reviewer: SessionReviewHarness | null;
  controllerDigest: string | null;
  /** The controller's one-line JSON summary, when the attempt wrote one. */
  summary: string | null;
  reason: string | null;
  cancelRequested: boolean;
  hasReport: boolean;
  reportTruncated: boolean;
  hasLedger: boolean;
  ledgerTruncated: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A job's review artifacts, read separately from its metadata. */
export interface SessionReviewJobArtifacts {
  jobId: string;
  summary: string | null;
  report: string | null;
  reportTruncated: boolean;
  ledger: string | null;
  ledgerTruncated: boolean;
}

export interface SessionReviewJobsPage { jobs: SessionReviewJobView[]; nextAfterJobId: string | null }

export const SESSION_REVIEW_JOB_ID_PATTERN = /^srj_[A-Za-z0-9_-]{8,64}$/u;

export const SESSION_REVIEW_ARTIFACT_LIMIT_BYTES = 256 * 1024;
export const SESSION_REVIEW_SUMMARY_LIMIT_BYTES = 2 * 1024;
export const SESSION_REVIEW_BRIEF_LIMIT_BYTES = 100 * 1024;

const SESSION_REVIEW_REASONS = new Set([
  REVIEW_JOBS_RETIRED_REASON,
  "the runner has no trusted cross-model review installation",
  "the reviewer for this session's harness is unavailable on this runner",
  "this session's harness has no cross-model reviewer",
  "the review must cover the session's own native managed worktree",
  "resume this session once so the runner can verify its automatic worktree before requesting a review",
  "the automatic worktree is no longer registered on this session's expected branch; restore it before requesting a review",
  "the pull request is not this session's open, same-repository pull request",
  "the requested head is not the pull request's pushed head",
  "the first review of a pull request needs a brief",
  "the brief exceeds its size limit",
  "this pull request has reached its review round limit",
  "this review round has used its attempts",
  "a review of this session is already running",
  "the runner is at its review concurrency limit",
  "the review snapshot could not be prepared",
  "the review was cancelled",
  "the review process ended without a result",
  "the review exceeded its time limit",
]);

export function sanitizedSessionReviewReason(value: unknown): string {
  return typeof value === "string" && SESSION_REVIEW_REASONS.has(value)
    ? value
    : "the review could not be completed; see the runner log";
}
