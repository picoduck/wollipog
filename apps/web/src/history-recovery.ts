import type { SessionEvent, SessionEventsResponse } from "@wollipog/protocol";

export const SESSION_EVENT_PAGE_LIMIT = 200;
export const SESSION_HISTORY_RECOVERY_CONCURRENCY = 6;
export const SESSION_HISTORY_FLEET_TURN_PAGES = 8;

/** Events the opening window reads in its single round trip. Sized to fill a tall transcript
 * viewport well past its first screen, so a reader who opens a session and scrolls a little never
 * waits on a second request. Older turns load only when they actually scroll back to them. */
export const SESSION_EVENT_WINDOW_LIMIT = 200;

/** Stable scalar dependency for restarting a recovery when any selected timeline generation
 * changes in place. Length-prefix ids so arbitrary session names cannot collide. */
export function sessionHistoryEpochKey(
  sessionIds: readonly string[],
  epochFor: (sessionId: string) => number,
): string {
  return sessionIds.map((id) => `${id.length}:${id}:${epochFor(id)}`).join("|");
}

export interface SessionHistoryRecoveryRequest {
  sessionId: string;
  after: number;
  eventEpoch: number;
  recoveryRevision: number;
}

type SessionHistoryRecoveryTurnRequest = SessionHistoryRecoveryRequest & {
  initialPagePainted: boolean;
};

export interface SessionHistoryRecoveryOptions {
  fetchPage: (
    sessionId: string,
    after: number,
    eventEpoch: number,
    limit: number,
  ) => Promise<SessionEventsResponse>;
  applyPage: (
    sessionId: string,
    events: SessionEvent[],
    eventEpoch: number,
    recoveryRevision: number,
    complete: boolean,
  ) => void;
  isCurrent: () => boolean;
  wait?: (ms: number) => Promise<void>;
  idlePollMs?: number;
  maxIdlePolls?: number;
  /** Fleet chains can wait behind another same-runner index scan. Keep retrying with a bounded
   * backoff while the owning view/revision remains current instead of abandoning its cursor. */
  retryOnIdleTimeout?: boolean;
  idleRetryMs?: number;
  onRequestStart?: (request: SessionHistoryRecoveryRequest) => void;
  onRequestError?: (request: SessionHistoryRecoveryRequest, cause: unknown) => void;
  /** Optional cooperative page budget. Fleet recovery uses it to rotate advancing histories;
   * direct single-session recovery remains continuous unless a caller opts in. */
  maxPagesPerTurn?: number;
}

const defaultWait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** Walk bounded cached pages using only server-returned cursors. Live WebSocket events may race far
 * ahead, but can never move this local cursor past an outage gap. An old control plane returns the
 * legacy `{events}` shape; that single response is treated as the completed compatibility path. */
async function recoverSessionHistoryTurn(
  request: SessionHistoryRecoveryRequest & { initialPagePainted?: boolean },
  options: SessionHistoryRecoveryOptions,
): Promise<{ complete: boolean; after: number; yielded: boolean; initialPagePainted: boolean }> {
  const wait = options.wait ?? defaultWait;
  const idlePollMs = options.idlePollMs ?? 75;
  const maxIdlePolls = options.maxIdlePolls ?? 160;
  const idleRetryMs = options.idleRetryMs ?? 1_000;
  let after = request.after;
  let appliedAfter = request.after;
  let firstPage = request.initialPagePainted !== true;
  let initialPagePainted = request.initialPagePainted === true;
  let pendingEvents: SessionEvent[] = [];
  let idlePolls = 0;
  let pagesFetched = 0;

  const flushPending = (eventEpoch: number, complete: boolean) => {
    if (!pendingEvents.length && !complete) return;
    options.applyPage(
      request.sessionId,
      pendingEvents,
      eventEpoch,
      request.recoveryRevision,
      complete,
    );
    pendingEvents = [];
    appliedAfter = after;
  };

  while (options.isCurrent()) {
    const pageAfter = after;
    let page: SessionEventsResponse;
    try {
      page = await options.fetchPage(
        request.sessionId,
        after,
        request.eventEpoch,
        SESSION_EVENT_PAGE_LIMIT,
      );
    } catch (error) {
      if (!options.retryOnIdleTimeout) throw error;
      if (!options.isCurrent()) break;
      await wait(idleRetryMs);
      continue;
    }
    pagesFetched += 1;
    if (!options.isCurrent()) return { complete: false, after: appliedAfter, yielded: false, initialPagePainted };

    const responseEpoch = page.eventEpoch ?? request.eventEpoch;
    if (responseEpoch !== request.eventEpoch) return { complete: false, after: appliedAfter, yielded: false, initialPagePainted };
    const legacy = page.nextAfter === undefined && page.hasMoreCached === undefined && page.cacheComplete === undefined;
    const nextAfter = page.nextAfter ?? page.events.at(-1)?.seq ?? after;
    if (!Number.isSafeInteger(nextAfter) || nextAfter < after) return { complete: false, after: appliedAfter, yielded: false, initialPagePainted };
    const complete = legacy || (page.cacheComplete === true && page.hasMoreCached !== true);
    const wasFirstPage = firstPage;
    if (firstPage) {
      options.applyPage(
        request.sessionId,
        page.events,
        responseEpoch,
        request.recoveryRevision,
        complete,
      );
      firstPage = false;
      initialPagePainted = true;
      appliedAfter = nextAfter;
    } else {
      pendingEvents.push(...page.events);
    }
    after = nextAfter;
    if (complete) {
      // A later empty terminal page still owns the authoritative completion signal. The store
      // freezes its recovery cursor until it sees this exact `complete=true` application.
      if (!wasFirstPage) flushPending(responseEpoch, true);
      return { complete: true, after: nextAfter, yielded: false, initialPagePainted };
    }

    if (page.hasMoreCached === true) {
      if (nextAfter <= pageAfter) {
        flushPending(responseEpoch, false);
        return { complete: false, after: appliedAfter, yielded: false, initialPagePainted };
      }
      idlePolls = 0;
      if (options.maxPagesPerTurn != null && pagesFetched >= Math.max(1, options.maxPagesPerTurn)) {
        flushPending(responseEpoch, false);
        return { complete: false, after, yielded: true, initialPagePainted };
      }
      continue;
    }

    // The cache answered immediately and the bounded runner chain is still filling it. Poll the
    // same exact CP cursor; targeted WebSocket delivery supplies the same rows in the meantime.
    if (nextAfter > pageAfter) {
      idlePolls = 0;
      if (options.maxPagesPerTurn != null && pagesFetched >= Math.max(1, options.maxPagesPerTurn)) {
        flushPending(responseEpoch, false);
        return { complete: false, after, yielded: true, initialPagePainted };
      }
    } else if (++idlePolls > maxIdlePolls) {
      if (!options.retryOnIdleTimeout) {
        flushPending(responseEpoch, false);
        return { complete: false, after: appliedAfter, yielded: false, initialPagePainted };
      }
      idlePolls = 0;
      await wait(idleRetryMs);
      continue;
    }
    await wait(idlePollMs);
  }
  return { complete: false, after: appliedAfter, yielded: false, initialPagePainted };
}

export async function recoverSessionHistory(
  request: SessionHistoryRecoveryRequest,
  options: SessionHistoryRecoveryOptions,
): Promise<boolean> {
  return (await recoverSessionHistoryTurn(request, options)).complete;
}

export interface SessionHistoryWindowRequest {
  sessionId: string;
  eventEpoch: number;
  recoveryRevision: number;
}

export interface SessionHistoryWindowOptions {
  fetchTailPage: (
    sessionId: string,
    before: number | undefined,
    eventEpoch: number,
    limit: number,
  ) => Promise<SessionEventsResponse>;
  applyWindow: (
    sessionId: string,
    events: SessionEvent[],
    eventEpoch: number,
    recoveryRevision: number,
    complete: boolean,
    hasOlder: boolean,
  ) => void;
  isCurrent: () => boolean;
  wait?: (ms: number) => Promise<void>;
  idlePollMs?: number;
  maxIdlePolls?: number;
}

/** A control plane that predates backward reads ignores the unknown `direction` and answers with a
 * forward page from the start of the log — the exact content this window exists to avoid painting.
 * Every backward response carries `hasMoreOlder`, so its absence identifies that older server. */
function supportsBackwardRead(page: SessionEventsResponse): boolean {
  return page.hasMoreOlder !== undefined;
}

/**
 * Load the bounded window at the tail of a session's cached history.
 *
 * One request paints the newest events regardless of how long the session is. When the control
 * plane's cache is still hydrating forward from the runner, its tail is not yet the true tail, so
 * this re-reads the same bounded window until the cache reports itself complete instead of walking
 * the log. Older turns stay reachable through `loadOlderSessionEvents`.
 *
 * Returns `supported: false` without applying anything when the control plane cannot serve a
 * backward read, so the caller can fall back to the forward chain.
 */
export async function recoverSessionHistoryWindow(
  request: SessionHistoryWindowRequest,
  options: SessionHistoryWindowOptions,
): Promise<{ supported: boolean; complete: boolean }> {
  const wait = options.wait ?? defaultWait;
  const idlePollMs = options.idlePollMs ?? 75;
  const maxIdlePolls = options.maxIdlePolls ?? 160;
  let idlePolls = 0;

  while (options.isCurrent()) {
    const page = await options.fetchTailPage(
      request.sessionId,
      undefined,
      request.eventEpoch,
      SESSION_EVENT_WINDOW_LIMIT,
    );
    if (!options.isCurrent()) return { supported: true, complete: false };
    if (!supportsBackwardRead(page)) return { supported: false, complete: false };
    const responseEpoch = page.eventEpoch ?? request.eventEpoch;
    if (responseEpoch !== request.eventEpoch) return { supported: true, complete: false };

    const complete = page.cacheComplete === true;
    options.applyWindow(
      request.sessionId,
      page.events,
      responseEpoch,
      request.recoveryRevision,
      complete,
      page.hasMoreOlder === true,
    );
    if (complete) return { supported: true, complete: true };
    // The cache answered immediately while the bounded runner chain is still filling it. Re-read
    // the same window rather than paging forward: the newest cached rows are what the reader is
    // waiting for, and targeted WebSocket delivery supplies the same rows in the meantime.
    if (++idlePolls > maxIdlePolls) return { supported: true, complete: false };
    await wait(idlePollMs);
  }
  return { supported: true, complete: false };
}

/** Fetch one page of turns older than the loaded window. Reader-driven: never called on open. */
export async function loadOlderSessionEvents(
  sessionId: string,
  before: number,
  eventEpoch: number,
  fetchTailPage: SessionHistoryWindowOptions["fetchTailPage"],
): Promise<{ events: SessionEvent[]; hasOlder: boolean; eventEpoch: number } | null> {
  const page = await fetchTailPage(sessionId, before, eventEpoch, SESSION_EVENT_WINDOW_LIMIT);
  if (!supportsBackwardRead(page)) return null;
  const responseEpoch = page.eventEpoch ?? eventEpoch;
  if (responseEpoch !== eventEpoch) return null;
  return { events: page.events, hasOlder: page.hasMoreOlder === true, eventEpoch: responseEpoch };
}

/** Recover a fleet view without launching one HTTP/page chain per member at once. */
export async function recoverSessionHistories(
  requests: readonly SessionHistoryRecoveryRequest[],
  options: SessionHistoryRecoveryOptions,
  concurrency = SESSION_HISTORY_RECOVERY_CONCURRENCY,
): Promise<void> {
  const workerLimit = Math.max(1, concurrency);
  const wait = options.wait ?? defaultWait;
  const idleRetryMs = options.idleRetryMs ?? 1_000;
  let pending = requests.map((request) => ({ ...request, initialPagePainted: false }));
  let delayed: SessionHistoryRecoveryTurnRequest[] = [];

  while (pending.length && options.isCurrent()) {
    let next = 0;
    const immediateRetry: SessionHistoryRecoveryTurnRequest[] = [];
    const delayedRetry: SessionHistoryRecoveryTurnRequest[] = [];
    // A fleet turn stops at the normal idle budget even when the owning view wants persistent
    // retries. Otherwise the first `workerLimit` same-runner sessions can occupy every worker while
    // later members never issue even their first cache read. Incomplete members rotate to the next
    // round; direct single-session recovery retains its continuous retry behavior.
    const turnOptions = {
      ...options,
      retryOnIdleTimeout: options.retryOnIdleTimeout ? false : options.retryOnIdleTimeout,
      maxPagesPerTurn: options.maxPagesPerTurn ?? SESSION_HISTORY_FLEET_TURN_PAGES,
    };
    const workers = Array.from({ length: Math.min(workerLimit, pending.length) }, async () => {
      while (options.isCurrent()) {
        const request = pending[next++];
        if (!request) return;
        let result = { complete: false, after: request.after, yielded: false, initialPagePainted: request.initialPagePainted };
        try {
          options.onRequestStart?.(request);
          result = await recoverSessionHistoryTurn(request, turnOptions);
        } catch (cause: unknown) {
          if (options.isCurrent()) options.onRequestError?.(request, cause);
          // One member must not abort the fleet view. Persistent fleet recovery retries it in the
          // next fair round; one-shot callers retain the previous best-effort behavior.
        }
        if (!result.complete && (result.yielded || options.retryOnIdleTimeout) && options.isCurrent()) {
          const retry = { ...request, after: result.after, initialPagePainted: result.initialPagePainted };
          (result.yielded ? immediateRetry : delayedRetry).push(retry);
        }
      }
    });
    await Promise.all(workers);
    if (!options.isCurrent()) return;
    delayed.push(...delayedRetry);
    if (immediateRetry.length) {
      pending = immediateRetry;
      continue;
    }
    if (!delayed.length) return;
    pending = delayed;
    delayed = [];
    await wait(idleRetryMs);
  }
}
