import { randomUUID } from "node:crypto";
import { SESSION_HISTORY_PAGE_MAX_BYTES, SESSION_HISTORY_PREVIEW_BYTE_BUDGET, runnerSupportsProtocol, type SessionHistoryHandoff, type SessionHistoryPreview } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";

export interface HistoryPreviewRead {
  logEpoch?: number;
  throughSeq?: number;
  afterSeq?: number;
  beforeSeq?: number;
  /** Preserve the original semantic anchor across frozen older/later pages. */
  turnStartSeq?: number;
  handoffSeq?: number;
  handoffFirstSeq?: number;
  handoffLastSeq?: number;
  handoffAfter?: number;
  limit: number;
}

export class HistoryPreviewReader {
  private readonly inFlight = new Map<string, Promise<SessionHistoryPreview | null>>();
  private readonly runnerReads = new Map<string, number>();
  private readonly unavailable = new Map<string, number>();
  constructor(private readonly db: ControlPlaneDb, private readonly hub: Hub) {}

  async read(sessionId: string, eventEpoch: number, read: HistoryPreviewRead): Promise<SessionHistoryPreview | null> {
    const session = this.db.getSession(sessionId);
    const state = this.db.getRunnerHistoryState(sessionId);
    if (!session || !state || state.eventEpoch !== eventEpoch || !this.hub.isRunnerOnline(session.runnerId) ||
        !runnerSupportsProtocol(this.hub.runnerProtocolVersion(session.runnerId), "authoritativeHistoryWindow")) return null;
    const key = JSON.stringify([sessionId, eventEpoch, state.historyEpoch, state.tailSeq, read]);
    const retryAt = this.unavailable.get(key);
    if (retryAt !== undefined && retryAt > Date.now()) return null;
    this.unavailable.delete(key);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    // Preview requests do not join the forward hydration queue. Keep their independent admission
    // bounded so one reader cannot fan out arbitrary runner work behind that queue.
    const running = this.runnerReads.get(session.runnerId) ?? 0;
    if (running >= 2) return null;
    this.runnerReads.set(session.runnerId, running + 1);
    const pending = this.fetch(sessionId, session.runnerId, eventEpoch, read);
    this.inFlight.set(key, pending);
    try {
      const result = await pending;
      if (!result) {
        this.unavailable.set(key, Date.now() + 1_000);
        while (this.unavailable.size > 512) this.unavailable.delete(this.unavailable.keys().next().value!);
      }
      return result;
    } finally {
      this.inFlight.delete(key);
      const remaining = (this.runnerReads.get(session.runnerId) ?? 1) - 1;
      if (remaining) this.runnerReads.set(session.runnerId, remaining); else this.runnerReads.delete(session.runnerId);
    }
  }

  private async fetch(sessionId: string, runnerId: string, eventEpoch: number,
    read: HistoryPreviewRead): Promise<SessionHistoryPreview | null> {
    const first = read.logEpoch === undefined;
    let span = read.beforeSeq === undefined ? read.limit : Math.min(read.limit, read.beforeSeq - 1);
    if (span < 1) return null;
    const deadline = Date.now() + 10_000;
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        const requestId = `recent_${randomUUID()}`;
        const afterSeq = read.beforeSeq === undefined ? read.afterSeq ?? 0 : Math.max(0, read.beforeSeq - 1 - span);
        const result = await this.hub.requestFromRunner(runnerId, requestId, {
          type: "session_history_page", requestId, sessionId, afterSeq, limit: span, indexedOnly: true, maxBytes: SESSION_HISTORY_PREVIEW_BYTE_BUDGET,
          ...(first ? { opening: "current-turn" as const } : { logEpoch: read.logEpoch, throughSeq: read.throughSeq }),
        }, remaining);
        const state = this.db.getRunnerHistoryState(sessionId);
        if (!state || state.eventEpoch !== eventEpoch || result.type !== "session_history_page_result" ||
            result.requestId !== requestId || result.sessionId !== sessionId || !result.ok || !result.page || !result.events) return null;
        const page = result.page;
        const start = first ? page.turnStartSeq : read.turnStartSeq;
        if (![page.logEpoch, page.throughSeq, page.nextAfterSeq, start].every(value =>
          Number.isSafeInteger(value) && value! >= 0) ||
            (state.historyEpoch !== null && state.historyEpoch !== page.logEpoch) ||
            (!first && (read.logEpoch !== page.logEpoch || read.throughSeq !== page.throughSeq)) ||
            result.events.length > span || Buffer.byteLength(JSON.stringify(result.events)) > SESSION_HISTORY_PAGE_MAX_BYTES ||
            start! > page.throughSeq || (first && page.throughSeq < state.tailSeq) || page.nextAfterSeq > page.throughSeq || page.hasMore !== (page.nextAfterSeq < page.throughSeq)) return null;
        const base = first ? Math.max(0, start! - 1) : afterSeq;
        if (result.events.some((event, index) => event.seq !== base + index + 1 ||
              !Number.isSafeInteger(event.ts) || event.ts < 0 || event.seq > page.throughSeq) ||
            page.nextAfterSeq !== (result.events.at(-1)?.seq ?? base) ||
            (page.hasMore && !result.events.length)) return null;
        if (first && start! > 0 && (result.events[0]?.payload.kind !== "user_message" ||
            result.events[0].payload.deliveryIntent === "steer" || result.events[0].payload.commandInvocation !== undefined)) return null;
        // A byte-bounded forward read can stop before an older page's requested end. Shrink that
        // span, never claim the missing middle was read. At most eight indexed runner reads.
        if (read.beforeSeq !== undefined && page.nextAfterSeq !== read.beforeSeq - 1) {
          if (span === 1) return null;
          span = Math.max(1, Math.floor(span / 2));
          continue;
        }
        return { events: result.events, eventEpoch, logEpoch: page.logEpoch, throughSeq: page.throughSeq,
          turnStartSeq: start!, nextAfterSeq: page.nextAfterSeq, hasMore: page.hasMore };
      }
    } catch { return null; }
  }

  /** Convert a read-local position only after the contiguous cache proves its real CP identity.
   * Includes every CP-only row between runner rows. No inferred offsets or synthetic CP ids. */
  handoff(sessionId: string, eventEpoch: number, read: HistoryPreviewRead): SessionHistoryHandoff | null {
    const state = this.db.getRunnerHistoryState(sessionId);
    const first = read.handoffFirstSeq, last = read.handoffLastSeq, anchor = read.handoffSeq;
    if (!state?.complete || state.eventEpoch !== eventEpoch || state.historyEpoch !== read.logEpoch ||
        first === undefined || last === undefined || anchor === undefined || first < 1 ||
        first > anchor || anchor > last || last > (read.throughSeq ?? -1)) return null;
    const lookup = this.db.raw().prepare("SELECT seq FROM session_events WHERE session_id=? AND runner_seq=?");
    const start = (lookup.get(sessionId, first) as { seq: number } | undefined)?.seq;
    const end = (lookup.get(sessionId, last) as { seq: number } | undefined)?.seq;
    const position = (lookup.get(sessionId, anchor) as { seq: number } | undefined)?.seq;
    if (start === undefined || end === undefined || position === undefined) return null;
    const after = read.handoffAfter ?? start - 1;
    if (after < start - 1 || after >= end) return null;
    const page = this.db.listCachedEventPage(sessionId, after, read.limit);
    const events = [] as SessionHistoryHandoff["events"];
    let bytes = 0;
    for (const event of page.events) {
      if (event.seq > end) break;
      const size = Buffer.byteLength(JSON.stringify(event));
      if (size > SESSION_HISTORY_PAGE_MAX_BYTES || (events.length > 0 && bytes + size > SESSION_HISTORY_PREVIEW_BYTE_BUDGET)) break;
      events.push(event); bytes += size;
    }
    if (!events.length) return null;
    const next = events.at(-1)!.seq;
    const identities = this.db.raw().prepare(`SELECT runner_seq AS runnerSeq, seq FROM session_events
      WHERE session_id=? AND seq>? AND seq<=? AND runner_seq IS NOT NULL ORDER BY seq`)
      .all(sessionId, after, next) as { runnerSeq: number; seq: number }[];
    const tail = this.db.listCachedEventTailPage(sessionId, undefined, 1).events.at(-1)?.seq ?? 0;
    return { events, identities, eventEpoch, windowStartSeq: start, windowEndSeq: end, anchorSeq: position,
      hasMoreHandoff: next < end, turnStartSeq: start, nextAfter: next,
      tailSeq: tail, hasMoreLater: end < tail, hasMoreOlder: start > 1,
      turnAligned: events[0]?.payload.kind === "user_message", cacheComplete: true };
  }
}
