/**
 * A session's cross-model review of its own pull request, run by the runner outside the session's
 * sandbox (#3306). A protected native session cannot run the review controller itself: its root is
 * read-only and a reviewer sandbox cannot nest inside its user namespace. The runner runs the
 * installed controller for the session's exact pushed head, from a private snapshot, and returns
 * the controller's own summary, report and ledger.
 */

export type SessionReviewHarness = "codex" | "claude-code";

/** What the runner can run; advertised with the runner's runtime metadata. */
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

export const SESSION_REVIEW_ARTIFACT_LIMIT_BYTES = 256 * 1024;
export const SESSION_REVIEW_SUMMARY_LIMIT_BYTES = 2 * 1024;
export const SESSION_REVIEW_BRIEF_LIMIT_BYTES = 100 * 1024;

const SESSION_REVIEW_REASONS = new Set([
  "the runner has no trusted cross-model review installation",
  "the reviewer for this session's harness is unavailable on this runner",
  "this session's harness has no cross-model reviewer",
  "the review must cover the session's own native managed worktree",
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
