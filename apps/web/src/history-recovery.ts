import type { SessionEvent, SessionEventsResponse } from "@wollipog/protocol";

export const SESSION_EVENT_PAGE_LIMIT = 200;
export const SESSION_HISTORY_RECOVERY_CONCURRENCY = 6;
export const SESSION_HISTORY_FLEET_TURN_PAGES = 8;

/** Events in the first opening-window round trip. Rendered geometry may request bounded aligned
 * older pages afterward because many streamed events can collapse into one short timeline row. */
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

/**
 * Whether an open should read the bounded tail window rather than the forward gap chain.
 *
 * - `recoveryAfter` is the cursor frozen when the acknowledged subscription was sent. Anything
 *   above zero is a reconnect gap the forward chain owns.
 * - `historyEverCompleted` asks about fetched HISTORY, not about the event array: a live event
 *   delivered between the acknowledgement and the load would otherwise send a long session back to
 *   walking its log from seq 0. Live rows sit at the tail and merge into the window beside them.
 * - `hasSavedReadingPosition` keeps the full chain for a reader who paused somewhere, since that
 *   position can sit below the window and restoring it depends on those rows arriving.
 */
export function shouldReadOpeningWindow(input: {
  recoveryAfter: number;
  historyEverCompleted: boolean;
  hasSavedReadingPosition: boolean;
}): boolean {
  return input.recoveryAfter === 0 && !input.historyEverCompleted && !input.hasSavedReadingPosition;
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
    alignToTurn?: boolean,
  ) => Promise<SessionEventsResponse>;
  applyWindow: (
    sessionId: string,
    events: SessionEvent[],
    eventEpoch: number,
    recoveryRevision: number,
    complete: boolean,
    hasOlder: boolean,
    turnAligned?: boolean,
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
    // The opening window is the page whose first row the reader lands on, so it asks to begin at a
    // turn boundary: a mid-turn cut orphans tool updates from the invocation that explains them and
    // leaves an active turn with no derivable start.
    const page = await options.fetchTailPage(
      request.sessionId,
      undefined,
      request.eventEpoch,
      SESSION_EVENT_WINDOW_LIMIT,
      true,
    );
    if (!options.isCurrent()) return { supported: true, complete: false };
    if (!supportsBackwardRead(page)) return { supported: false, complete: false };
    const responseEpoch = page.eventEpoch ?? request.eventEpoch;
    if (responseEpoch !== request.eventEpoch) return { supported: true, complete: false };

    const applyPage = (complete: boolean) => options.applyWindow(
      request.sessionId,
      page.events,
      responseEpoch,
      request.recoveryRevision,
      complete,
      page.hasMoreOlder === true,
      page.turnAligned,
    );
    if (page.cacheComplete === true) {
      applyPage(true);
      return { supported: true, complete: true };
    }
    // The cache is still hydrating FORWARD from the runner, so its newest cached row can still be
    // an old prefix of the log. Painting that would reproduce the oldest-first open this window
    // exists to remove, so re-read the same window instead of showing it. Targeted WebSocket
    // delivery supplies live rows in the meantime, and the reader keeps its loading state.
    if (++idlePolls > maxIdlePolls) {
      // The cache never caught up. Show whatever it does hold rather than leaving the reader with
      // nothing, still reporting the load as incomplete so the transcript says so.
      applyPage(false);
      return { supported: true, complete: false };
    }
    await wait(idlePollMs);
  }
  return { supported: true, complete: false };
}

/** Fetch one page older than the loaded window. Opening fill opts into turn alignment; later
 * reader-driven pagination keeps exact count-bounded cursors. */
export async function loadOlderSessionEvents(
  sessionId: string,
  before: number,
  eventEpoch: number,
  fetchTailPage: SessionHistoryWindowOptions["fetchTailPage"],
  alignToTurn = false,
): Promise<{ events: SessionEvent[]; hasOlder: boolean; eventEpoch: number; turnAligned?: boolean } | null> {
  const page = await fetchTailPage(
    sessionId,
    before,
    eventEpoch,
    SESSION_EVENT_WINDOW_LIMIT,
    alignToTurn,
  );
  if (!supportsBackwardRead(page)) return null;
  const responseEpoch = page.eventEpoch ?? eventEpoch;
  if (responseEpoch !== eventEpoch) return null;
  return {
    events: page.events,
    hasOlder: page.hasMoreOlder === true,
    eventEpoch: responseEpoch,
    ...(page.turnAligned === undefined ? {} : { turnAligned: page.turnAligned }),
  };
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
