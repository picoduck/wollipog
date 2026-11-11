import type {ControlPlaneDb} from "./db.js";
import type {SessionsService} from "./sessions.js";
import type {HistoryPreviewReader} from "./history-preview.js";
import type {OwnerManagementReply} from "./owner-management.js";

/** Shared bounded history-window/retained-attachment reads for HTTP and Assistant transports.
 * Preserve epoch/cursor contracts; a partial cache never becomes a completed transcript. */
export function createSessionContentManagement(deps: {db: ControlPlaneDb; svc: SessionsService; historyPreviews: HistoryPreviewReader}) {
  const {db, svc, historyPreviews} = deps;

  async function retained(id: string, input: unknown, reply: OwnerManagementReply) {
    const query = input as { after?: string; limit?: string; eventEpoch?: string };
    const after = Number(query.after ?? 0);
    const limit = Number(query.limit);
    const eventEpoch = Number(query.eventEpoch);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
        !Number.isSafeInteger(eventEpoch) || eventEpoch < 0) {
      return reply.code(400).send({ error: "after, limit, and eventEpoch must be bounded non-negative integers" });
  }
  const state = db.getRunnerHistoryState(id);
  if (!state) return reply.code(404).send({ error: "session not found" });
  if (state.eventEpoch !== eventEpoch) {
    return reply.code(409).send({ error: "session event history was replaced", code: "stale_event_epoch",
      eventEpoch: state.eventEpoch });
  }
  const page = eventEpoch > 0
    ? db.listRetainedAttachmentEventPage(id, after, limit)
    : { events: [], nextAfterSeq: after, hasMore: false };
  return { events: page.events, eventEpoch, nextAfter: page.nextAfterSeq, hasMore: page.hasMore };
  }

  async function preview(id: string, input: unknown, reply: OwnerManagementReply) {
    const query = input as Record<string, string | undefined>;
    const values: Record<string, number> = {};
    for (const key of ["eventEpoch", "logEpoch", "throughSeq", "turnStartSeq", "afterSeq", "beforeSeq", "handoffSeq", "handoffFirstSeq", "handoffLastSeq", "handoffAfter", "limit"]) {
      if (query[key] === undefined) continue;
      const value = Number(query[key]);
      if (!Number.isSafeInteger(value) || value < 0) return reply.code(400).send({ error: "invalid history preview cursor" });
      values[key] = value;
  }
  if (["eventEpoch", "logEpoch", "throughSeq", "turnStartSeq", "limit"].some(key => values[key] === undefined) ||
      values.limit! < 1 || values.limit! > 200 || values.turnStartSeq! > values.throughSeq! ||
      (values.afterSeq !== undefined && values.beforeSeq !== undefined) ||
      [values.afterSeq, values.beforeSeq, values.handoffSeq, values.handoffFirstSeq, values.handoffLastSeq].some(value => value !== undefined && value > values.throughSeq! + 1)) {
    return reply.code(400).send({ error: "invalid history preview cursor" });
  }
  const state = db.getRunnerHistoryState(id);
  if (!state) return reply.code(404).send({ error: "session not found" });
  if (state.eventEpoch !== values.eventEpoch || (state.historyEpoch !== null && state.historyEpoch !== values.logEpoch)) {
    return reply.code(409).send({ error: "session event history was replaced", code: "stale_event_epoch", eventEpoch: state.eventEpoch });
  }
  // A ready preview ends opening recovery polls. Continue the existing deduplicated maintenance
  // path if an earlier hydration RPC timed out; private rows never supply its cursor or writes.
  if (!state.complete) void svc.hydrateHistory(id);
  const read = { ...values, limit: values.limit! };
  if (values.handoffSeq !== undefined) return { handoff: historyPreviews.handoff(id, values.eventEpoch!, read) };
  return { preview: await historyPreviews.read(id, values.eventEpoch!, read) };
  }

  return {retained, preview};
}
