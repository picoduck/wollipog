/** Merge-queue watches for parked sessions (#4071). The control plane owns each watch durably and
 * (re)sends `pull_request_watch_start` whenever this runner registers, so a runner restart resumes
 * every watch without state of its own. The runner keeps polling GitHub through its read-only `gh`
 * login, one `waitForPullRequest` call after another, and reports the first outcome once. */

import {
  PULL_REQUEST_WATCH_REASON_LIMIT,
  PULL_REQUEST_WATCH_SUMMARY_LIMIT_BYTES,
  type PullRequestWatchOutcome,
  type PullRequestWatchStartCommand,
  type PullRequestWatchUpdate,
} from "@wollipog/protocol";
import type { GhRunner } from "./campaign-forge-status.js";
import {
  cancellableSleep,
  PULL_REQUEST_WAIT_MAX_TIMEOUT_MS,
  waitForPullRequest,
  type PullRequestWaitSummary,
} from "./pull-request-wait.js";

/** Consecutive unreadable waits before a watch is reported lost rather than retried. */
export const PULL_REQUEST_WATCH_MAX_FAILURES = 6;
/** Pause after an unreadable wait; with the limit above, about half an hour of retrying. */
export const PULL_REQUEST_WATCH_RETRY_MS = 5 * 60_000;
/** Reported outcomes kept to answer a control plane that resends a start it missed the end of. */
const MAX_REPORTED = 500;

export interface PullRequestWatcherDeps {
  gh: GhRunner;
  send: (update: PullRequestWatchUpdate) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (message: string) => void;
  /** Each wait's timeout; tests shorten it. */
  waitTimeoutMs?: number;
  /** The wait itself; tests replace it. */
  wait?: typeof waitForPullRequest;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** The bounded wait summary, serialized within the protocol's limit. A summary over it (only
 * possible with unusually long names) keeps the outcome, head, queue and merge facts. */
export function serializedWatchSummary(summary: PullRequestWaitSummary): string {
  const full = JSON.stringify(summary);
  if (Buffer.byteLength(full) <= PULL_REQUEST_WATCH_SUMMARY_LIMIT_BYTES) return full;
  const { checks: _checks, requiredCheckNames: _names, mergeQueue, ...rest } = summary;
  return JSON.stringify({ ...rest, mergeQueue: mergeQueue ? { ...mergeQueue, checks: null } : null, truncated: true });
}

export class PullRequestWatcher {
  private readonly active = new Map<string, AbortController>();
  private readonly reported = new Map<string, PullRequestWatchUpdate>();

  constructor(private readonly deps: PullRequestWatcherDeps) {}

  /** Start watching, or answer at once with the outcome already reported for this id. */
  start(command: PullRequestWatchStartCommand): void {
    const reported = this.reported.get(command.watchId);
    if (reported) { this.deps.send(reported); return; }
    if (this.active.has(command.watchId)) return;
    const controller = new AbortController();
    this.active.set(command.watchId, controller);
    void this.watch(command, controller.signal)
      .catch((error: unknown) => {
        this.report({ type: "pull_request_watch_update", watchId: command.watchId, state: "lost",
          reason: clip(`the watch failed: ${error instanceof Error ? error.message : String(error)}`, PULL_REQUEST_WATCH_REASON_LIMIT) });
      })
      .finally(() => {
        if (this.active.get(command.watchId) === controller) this.active.delete(command.watchId);
      });
  }

  cancel(watchId: string): void {
    this.active.get(watchId)?.abort();
    this.active.delete(watchId);
  }

  stopAll(): void {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }

  /** Watch ids still polling, for tests and diagnostics. */
  watching(): string[] {
    return [...this.active.keys()];
  }

  private report(update: PullRequestWatchUpdate): void {
    this.reported.set(update.watchId, update);
    while (this.reported.size > MAX_REPORTED) this.reported.delete(this.reported.keys().next().value!);
    this.deps.send(update);
  }

  private async watch(command: PullRequestWatchStartCommand, signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      const result = await (this.deps.wait ?? waitForPullRequest)({
        repository: command.repository,
        number: command.number,
        headSha: command.headSha,
        timeoutMs: this.deps.waitTimeoutMs ?? PULL_REQUEST_WAIT_MAX_TIMEOUT_MS,
      }, {
        gh: this.deps.gh,
        signal,
        ...(this.deps.now ? { now: this.deps.now } : {}),
        ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      });
      if (signal.aborted) return;
      if (result.ok) {
        failures = 0;
        if (result.summary.outcome === "timeout") continue;
        this.report({
          type: "pull_request_watch_update",
          watchId: command.watchId,
          state: "fired",
          outcome: result.summary.outcome as PullRequestWatchOutcome,
          summary: serializedWatchSummary(result.summary),
        });
        return;
      }
      if (++failures >= PULL_REQUEST_WATCH_MAX_FAILURES) {
        this.report({ type: "pull_request_watch_update", watchId: command.watchId, state: "lost",
          reason: clip(`GitHub could not be read: ${result.error}`, PULL_REQUEST_WATCH_REASON_LIMIT) });
        return;
      }
      this.deps.log?.(`pull request watch ${command.watchId}: ${result.error}; retrying`);
      if (!await cancellableSleep({ ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}), signal }, PULL_REQUEST_WATCH_RETRY_MS)) return;
    }
  }
}
