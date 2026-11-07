/**
 * Merge closure watch (#4323, protocol v328). A `pr_merge` decision is checked against what the
 * forge would close when it is requested, when it is armed and before Wollipog's own enqueue
 * (#3713 for GitHub, #3762 for GitLab). The forge closes issues when the merge lands, from the
 * description it has then, which in a merge queue or merge train is often much later. So after the
 * decision is consumed the control plane keeps reading what the merge would close through the
 * child's runner, with the same reads as those checks:
 *
 * - while the pull request is open at the approved head, a set of closures that differs from the
 *   snapshot's `intendedClosures` removes it from the merge queue (GitHub `dequeuePullRequest`) or
 *   the merge train (GitLab's cancel of the merge request's auto-merge), and the decision no longer
 *   covers it;
 * - once it merged, every issue it closed that `intendedClosures` does not list is reported to the
 *   campaign's owner, with the pull request and the text that closed it.
 *
 * Read and dequeue are one message with an `operation`, answered through the child session's own
 * forge login from a neutral directory, as forge actions are. A runner below v328 is never sent
 * one, and its merges keep the checks they had before.
 */
import type { PullRequestClosingReferenceCheck, PullRequestClosure } from "./index.js";

/** Control plane to the child's runner. `read` reports the pull request's state, head and closures
 * in any state; `dequeue` removes it from the merge queue or train when it is open at `headSha`. */
export interface MergeClosureWatchMessage {
  type: "merge_closure_watch";
  requestId: string;
  sessionId: string;
  operation: "read" | "dequeue";
  /** `owner/repo` on GitHub, `host/group/project` on GitLab. */
  repository: string;
  pullRequest: number;
  headSha: string;
}

export type MergeClosureWatchPullRequestState = "open" | "merged" | "closed";

/** What a dequeue did. `dequeued` and `not_queued` leave the pull request open and out of the
 * queue; `merged` and `closed` mean it is no longer open; `head_changed` means the pull request is
 * open at another head, which the decision never covered; `refused` means the forge refused or
 * could not be reached and nothing changed; `uncertain` means a write was sent and its answer
 * proved nothing. */
export type MergeClosureDequeueOutcome = "dequeued" | "not_queued" | "merged" | "closed" | "head_changed" | "refused" | "uncertain";

export const MERGE_CLOSURE_DEQUEUE_OUTCOMES: readonly MergeClosureDequeueOutcome[] = [
  "dequeued", "not_queued", "merged", "closed", "head_changed", "refused", "uncertain",
];

/** `ok: false` with a fixed `reason` (never forge output) when the forge could not be read; an
 * unread forge never counts as unchanged. */
export interface MergeClosureWatchResultMessage {
  type: "merge_closure_watch_result";
  requestId: string;
  sessionId: string;
  operation: "read" | "dequeue";
  ok: boolean;
  reason?: string;
  /** `read`: the pull request's state and head, and the closures it would make or made. */
  state?: MergeClosureWatchPullRequestState;
  headSha?: string;
  check?: PullRequestClosingReferenceCheck;
  /** `dequeue`. */
  outcome?: MergeClosureDequeueOutcome;
}

/**
 * The watch a consumed `pr_merge` decision carries (`WorkflowDecisionView.closureWatch`).
 *
 * - `watching`: read until the pull request merges or closes.
 * - `invalidated`: its closures changed after approval while it was open; Wollipog removes it from
 *   the queue while it stays open at the approved head, and the decision no longer covers it.
 * - `verified`: it merged closing exactly the approved issues.
 * - `landed_unapproved`: it merged closing an issue the decision did not approve; reported.
 * - `unverified`: what it closed could not be read before the watch gave up; reported.
 * - `ended`: closed without merging, moved to another head, or superseded by a newer decision.
 * - `not_watched`: the child's runner predates v328, or the merge predates this watch.
 */
export type MergeClosureWatchState =
  | "watching" | "invalidated" | "verified" | "landed_unapproved" | "unverified" | "ended" | "not_watched";

export interface MergeClosureWatch {
  state: MergeClosureWatchState;
  since: number;
  updatedAt: number;
  /** The last successful read. */
  checkedAt?: number;
  /** The first of the reads that have failed since the last successful one, and why. */
  unreadSince?: number;
  failure?: string;
  /** When its closures were first found to differ from `intendedClosures`. Kept once set. */
  invalidatedAt?: number;
  /** What the read found then, and the sentence that says how it differs. */
  mismatch?: { message: string; closures: PullRequestClosure[] };
  /** The latest dequeue attempt. */
  dequeue?: { outcome: MergeClosureDequeueOutcome; at: number; attempts: number };
  /** The issues a landed merge closed that the decision did not approve. */
  unapprovedClosures?: PullRequestClosure[];
  /** The child was told why its decision no longer covers the merge. */
  childNotifiedAt?: number;
  /** The owner was told, through this owner question on the campaign's root, or why not. */
  report?: { occurrenceId?: string; reportedAt: number; unreported?: string };
  endReason?: string;
}

/** Cadence and limits of the watch. */
export const MERGE_CLOSURE_WATCH = {
  /** How often the background pass runs. */
  tickMs: 30_000,
  /** How often one open pull request is read. */
  readIntervalMs: 60_000,
  /** How often a pull request still open after `slowAfterMs` is read. */
  slowReadIntervalMs: 10 * 60_000,
  slowAfterMs: 6 * 60 * 60_000,
  /** A pull request still open this long after approval is no longer watched. */
  expireAfterMs: 14 * 24 * 60 * 60_000,
  /** Reads failing this long are reported to the owner once (the watch goes on). */
  unreadReportAfterMs: 30 * 60_000,
  /** A merge whose closures could not be read for this long after it was seen merged, or whose
   * runner was gone this long, is given up as `unverified`. */
  giveUpAfterMs: 24 * 60 * 60_000,
  /** Reads one pass starts at most. */
  readsPerTick: 8,
  requestTimeoutMs: 60_000,
  /** Dequeue attempts per decision. */
  maxDequeueAttempts: 10,
} as const;
