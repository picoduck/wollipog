import { randomUUID } from "node:crypto";
import { runnerSupportsProtocol, type SessionEventsResponse, type SessionHistoryPreview } from "@wollipog/protocol";
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
  limit: number;
}

export class HistoryPreviewReader {
  private readonly inFlight = new Map<string, Promise<SessionHistoryPreview | null>>();
  private readonly runnerReads = new Map<string, number>();
  constructor(private readonly db: ControlPlaneDb, private readonly hub: Hub) {}

  async read(sessionId: string, eventEpoch: number, read: HistoryPreviewRead): Promise<SessionHistoryPreview | null> {
    const session = this.db.getSession(sessionId);
    const state = this.db.getRunnerHistoryState(sessionId);
    if (!session || !state || state.eventEpoch !== eventEpoch || !this.hub.isRunnerOnline(session.runnerId) ||
        !runnerSupportsProtocol(this.hub.runnerProtocolVersion(session.runnerId), "authoritativeHistoryWindow")) return null;
    const key = JSON.stringify([sessionId, eventEpoch, read]);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    // Preview requests do not join the forward hydration queue. Keep their independent admission
    // bounded so one reader cannot fan out arbitrary runner work behind that queue.
    const running = this.runnerReads.get(session.runnerId) ?? 0;
    if (running >= 2) return null;
    this.runnerReads.set(session.runnerId, running + 1);
    const pending = this.fetch(sessionId, session.runnerId, eventEpoch, read);
    this.inFlight.set(key, pending);
    try { return await pending; } finally {
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
          type: "session_history_page", requestId, sessionId, afterSeq, limit: span, indexedOnly: true,
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
            result.events.length > span || Buffer.byteLength(JSON.stringify(result.events)) > 256 * 1024 ||
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
  handoff(sessionId: string, eventEpoch: number, read: HistoryPreviewRead): SessionEventsResponse | null {
    const state = this.db.getRunnerHistoryState(sessionId);
    if (!state?.complete || state.eventEpoch !== eventEpoch || state.historyEpoch !== read.logEpoch ||
        read.handoffSeq === undefined || read.handoffSeq > (read.throughSeq ?? -1)) return null;
    const row = this.db.raw().prepare("SELECT seq FROM session_events WHERE session_id=? AND runner_seq=?")
      .get(sessionId, read.handoffSeq) as { seq: number } | undefined;
    if (!row) return null;
    const page = this.db.listCachedEventPage(sessionId, row.seq - 1, read.limit);
    const tail = this.db.listCachedEventTailPage(sessionId, undefined, 1).events.at(-1)?.seq ?? 0;
    return { events: page.events, eventEpoch, turnStartSeq: row.seq, nextAfter: page.nextAfterSeq,
      tailSeq: tail, hasMoreLater: page.hasMore, hasMoreOlder: row.seq > 1,
      turnAligned: page.events[0]?.payload.kind === "user_message", cacheComplete: true };
  }
}
