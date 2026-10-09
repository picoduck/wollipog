import type { SessionEvent } from "@wollipog/protocol";
import { continueStreamingText, timelineItemIsStreaming, type TimelineItem } from "../timeline.js";

/**
 * Most streamed events only lengthen the reply or reasoning the transcript already ends with. The
 * session view and the timeline derive everything they show from the transcript, but none of it
 * depends on that text, so neither renders for such an event (#2763). Only the streaming row does:
 * it folds the chunks onto the item it was given with `foldLiveText`.
 */

type AgentTextPayload = Extract<SessionEvent["payload"], { kind: "agent_message" | "agent_thought" }>;
type AgentTextItem = Extract<TimelineItem, { kind: "agent_message" | "agent_thought" }>;

function openTopLevelText(event: SessionEvent): AgentTextPayload | null {
  const payload = event.payload;
  if (payload.kind !== "agent_message" && payload.kind !== "agent_thought") return null;
  // Only an absent parent is top-level: the builder tells an empty one apart from none.
  if (payload.final || payload.parentToolUseId !== undefined || typeof payload.text !== "string") return null;
  return payload;
}

/** A provider message id; the builder treats an empty one as none. */
const streamId = (messageId: string | undefined) => messageId || undefined;

/**
 * Whether `event` is one more chunk of the stream `last` belongs to, after `previous` in sequence
 * and time. A chunk timed earlier than the one before it can move a governance decision anchored
 * by time; the session view derives that itself.
 */
function continuesStream(last: SessionEvent, stream: AgentTextPayload, previous: SessionEvent, event: SessionEvent): boolean {
  const chunk = openTopLevelText(event);
  return chunk !== null && chunk.kind === stream.kind && streamId(chunk.messageId) === streamId(stream.messageId) &&
    event.sessionId === last.sessionId && event.seq > previous.seq && event.ts >= previous.ts;
}

/**
 * Whether `next` is `previous` with only more non-final chunks of the top-level reply or reasoning
 * stream `previous` ends with: same kind, same provider message id, no subagent, in sequence and time
 * order. `TimelineBuilder` folds each such chunk into the item that stream already has, and changes
 * nothing else.
 */
export function onlyContinuesTrailingText(
  previous: readonly SessionEvent[] | undefined,
  next: readonly SessionEvent[] | undefined,
): boolean {
  if (!previous || !next || next.length <= previous.length || previous.length === 0) return false;
  const last = previous[previous.length - 1]!;
  // The store appends by copying the array, so an unchanged prefix keeps its event objects.
  if (next[0] !== previous[0] || next[previous.length - 1] !== last) return false;
  const stream = openTopLevelText(last);
  if (!stream) return false;
  for (let index = previous.length; index < next.length; index += 1) {
    if (!continuesStream(last, stream, next[index - 1]!, next[index]!)) return false;
  }
  return true;
}

/**
 * A streaming top-level reply or reasoning item with the chunks `live` holds after the last one it
 * was derived from, or the item itself when there are none (or when anything else followed, which
 * the session view derives itself).
 */
export function foldLiveText(item: TimelineItem, live: readonly SessionEvent[] | undefined): TimelineItem {
  if (!live || !readsLiveText(item)) return item;
  const text = item as AgentTextItem;
  const end = text.sourceEndId;
  if (end === undefined) return item;
  let index = live.length - 1;
  while (index >= 0 && live[index]!.seq > end) index -= 1;
  const last = live[index];
  if (!last || last.seq !== end || index === live.length - 1) return item;
  const stream = openTopLevelText(last);
  if (!stream || stream.kind !== text.kind || streamId(stream.messageId) !== streamId(text.messageId)) return item;
  let folded: AgentTextItem = text;
  for (let next = index + 1; next < live.length; next += 1) {
    const event = live[next]!;
    if (!continuesStream(last, stream, live[next - 1]!, event)) return item;
    folded = continueStreamingText(folded, event.seq, (event.payload as AgentTextPayload).text, event.ts);
  }
  return folded;
}

/** Top-level reply or reasoning that can still gain chunks: the rows that read live text. */
export function readsLiveText(item: TimelineItem): boolean {
  return (item.kind === "agent_message" || item.kind === "agent_thought") && item.parentToolUseId === undefined &&
    timelineItemIsStreaming(item);
}
