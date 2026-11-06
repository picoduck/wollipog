/**
 * Tracked waits (#1280, #4249): a `wait_session` or `wait_pull_request` call in progress. The
 * runner's Wollipog MCP server reports each call to the control plane when it starts, after
 * successful polls, and when it ends. The control plane decides whether the wait is healthy under
 * the liveness contract below and projects the result on the waiting session (`SessionView.waits`),
 * so every dashboard surface reads the same classification instead of comparing clocks itself.
 *
 * Elapsed time alone never makes a wait Stalled. A wait is Stalled only when its contract is broken:
 * - `progress_lost`: no successful poll was reported within `sessionWaitProgressBoundMs` of the
 *   last one, so the call is no longer making progress (its MCP server or runner stopped);
 * - `target_missing`: the session a `wait_session` call watches no longer exists;
 * - `target_reached`: that session has been in one of the requested states for longer than
 *   `SESSION_WAIT_TARGET_GRACE_MS`, so a working poll would already have returned;
 * - `deadline_passed`: the call is still reported in progress `SESSION_WAIT_DEADLINE_GRACE_MS`
 *   after its own timeout.
 *
 * Every time is measured on the control plane's clock: a report carries durations (elapsed and
 * remaining), never runner timestamps, so a runner clock offset cannot move a bound.
 */

export type SessionWaitKind = "wait_session" | "wait_pull_request";

export const SESSION_WAIT_KINDS: readonly SessionWaitKind[] = ["wait_session", "wait_pull_request"];

export type SessionWaitStallReason = "progress_lost" | "target_missing" | "target_reached" | "deadline_passed";

/** What a report names as the wait's target. A `wait_session` target is another session and the
 * states that end the wait; a `wait_pull_request` target is a pull request or merge request. */
export type SessionWaitReportTarget =
  | { kind: "session"; sessionId: string; states: string[] }
  | { kind: "pull_request"; repository: string; number: number };

/** Runner MCP server to control plane: `POST /api/sessions/:id/waits`, only for the calling
 * session itself. `active` registers or refreshes the wait and records one successful poll;
 * `ended` removes it. */
export interface SessionWaitReport {
  waitId: string;
  kind: SessionWaitKind;
  state: "active" | "ended";
  target: SessionWaitReportTarget;
  /** How long the call has been waiting, by the reporter's monotonic measure. */
  elapsedMs: number;
  /** How long until the call's own timeout. */
  remainingMs: number;
  /** The call's polling interval. Bounds how long progress may go unreported. */
  intervalMs: number;
}

/** What a dashboard may know about a wait's target. A watched session is never named: the viewer
 * of the waiting session may not have access to it. */
export type SessionWaitViewTarget =
  | { kind: "session"; /** The watched session is a child (or deeper descendant) of the waiter. */ child: boolean }
  | { kind: "pull_request"; repository: string; number: number };

/** One wait in progress on a session, as the control plane classified it. */
export interface SessionWaitView {
  waitId: string;
  kind: SessionWaitKind;
  target: SessionWaitViewTarget;
  /** When the wait started, on the control plane's clock. */
  since: number;
  /** When the call's own timeout passes, on the control plane's clock. */
  deadlineAt: number;
  health: "healthy" | "stalled";
  /** Which part of the liveness contract broke. Present only when `health` is `stalled`. */
  stalledReason?: SessionWaitStallReason;
  /** When the control plane classified it Stalled. */
  stalledSince?: number;
}

/** How often a reporter sends a successful poll at most. */
export const SESSION_WAIT_PROGRESS_REPORT_MS = 15_000;
/** Added to three report intervals: one poll's own read time and transport delay. */
export const SESSION_WAIT_PROGRESS_SLACK_MS = 30_000;
/** How long past its own timeout a call may still be reported in progress. */
export const SESSION_WAIT_DEADLINE_GRACE_MS = 60_000;
/** How long a watched session may sit in a requested state while the wait still runs. */
export const SESSION_WAIT_TARGET_GRACE_MS = 30_000;
/** A call's longest timeout: `wait_pull_request` allows three hours; one more minute of slack. */
export const SESSION_WAIT_MAX_TIMEOUT_MS = 3 * 60 * 60_000 + 60_000;
/** The longest polling interval a report may declare (`wait_pull_request`'s maximum). */
export const SESSION_WAIT_MAX_INTERVAL_MS = 600_000;
/** At most this many waits are tracked for one session at once. */
export const SESSION_WAIT_LIMIT_PER_SESSION = 8;

/** How long a wait polling every `intervalMs` may go without a reported successful poll: three
 * report intervals plus slack. `wait_session` (10 s at most) gets 75 s; `wait_pull_request` at its
 * 30 s default gets 120 s, and at its 10-minute maximum 30.5 minutes. */
export function sessionWaitProgressBoundMs(intervalMs: number): number {
  return 3 * Math.max(intervalMs, SESSION_WAIT_PROGRESS_REPORT_MS) + SESSION_WAIT_PROGRESS_SLACK_MS;
}
