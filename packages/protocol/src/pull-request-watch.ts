/** A parked session's merge-queue watch (#4071): the session registers its own enqueued pull
 * request and exact head, ends its turn, and is prompted once when the entry reaches an outcome.
 * The runner polls GitHub through its read-only `gh` login, so no model request happens while the
 * session is parked. The wake is an ordinary prompt: it grants no authority. */

/** What ends a watch. Anything `wait_pull_request` returns except `timeout`: a pull request that is
 * not in the queue at all reports its own checks at once, so a session never stays parked on it. */
export type PullRequestWatchOutcome =
  | "merged"
  | "closed"
  | "queue_failed"
  | "queue_ejected"
  | "head_changed"
  | "checks_passed"
  | "checks_failed"
  | "no_required_checks";

export const PULL_REQUEST_WATCH_OUTCOMES: readonly PullRequestWatchOutcome[] = [
  "merged", "closed", "queue_failed", "queue_ejected", "head_changed",
  "checks_passed", "checks_failed", "no_required_checks",
];

/** `watching` until the runner reports; `fired` with an outcome; `lost` when no runner can keep
 * watching (its reason says why); `cancelled` when the session replaced, stopped or archived it. */
export type PullRequestWatchState = "watching" | "fired" | "lost" | "cancelled";

/** The wake prompt's delivery, as review continuations track theirs. */
export type PullRequestWatchContinuationState =
  | "none" | "held" | "delivering" | "delivered" | "uncertain" | "failed" | "abandoned";

export interface PullRequestWatchView {
  watchId: string;
  repository: string;
  number: number;
  headSha: string;
  state: PullRequestWatchState;
  /** When the session parked. */
  since: number;
  outcome?: PullRequestWatchOutcome;
  endedAt?: number;
  /** A fixed, path-free reason for a lost or cancelled watch. */
  reason?: string;
  continuation: PullRequestWatchContinuationState;
}

/** Control plane to runner: start (or, after a reconnect, resume) watching. Idempotent per id. */
export interface PullRequestWatchStartCommand {
  type: "pull_request_watch_start";
  watchId: string;
  sessionId: string;
  repository: string;
  number: number;
  headSha: string;
}

export interface PullRequestWatchCancelCommand {
  type: "pull_request_watch_cancel";
  watchId: string;
}

/** Runner to control plane: the watch's end. Accepted only from the watch's runner, only while it
 * is still watching; the first report wins, so a runner re-reporting after a reconnect is harmless. */
export interface PullRequestWatchUpdate {
  type: "pull_request_watch_update";
  watchId: string;
  state: "fired" | "lost";
  outcome?: PullRequestWatchOutcome;
  /** `wait_pull_request`'s bounded summary, serialized; at most PULL_REQUEST_WATCH_SUMMARY_LIMIT_BYTES. */
  summary?: string;
  reason?: string;
}

export const PULL_REQUEST_WATCH_SUMMARY_LIMIT_BYTES = 16 * 1024;
export const PULL_REQUEST_WATCH_REASON_LIMIT = 300;

/** The newest watches `get_campaign` lists for parked children. */
export const CAMPAIGN_PARKED_CHILDREN_LIMIT = 50;

export interface CampaignParkedChild {
  sessionId: string;
  watch: PullRequestWatchView;
}
