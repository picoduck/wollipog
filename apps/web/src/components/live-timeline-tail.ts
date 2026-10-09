import { useMemo, useRef } from "react";
import type { SessionEvent } from "@wollipog/protocol";
import { useStoreSelector } from "../store.js";
import {
  continueStreamingText,
  publishTimelineSnapshotDelta,
  timelineItemIsStreaming,
  timelineSnapshotDelta,
  type TimelineItem,
} from "../timeline.js";

/**
 * Most streamed events only lengthen the reply or reasoning the transcript already ends with. The
 * session view derives everything else it shows from the transcript, but none of it depends on
 * that text, so it is not rendered for such an event (#2763). Only the transcript is, through
 * `useLiveTimelineTail`, which folds those chunks onto the item the session view derived.
 */

type AgentTextPayload = Extract<SessionEvent["payload"], { kind: "agent_message" | "agent_thought" }>;

function openTopLevelText(event: SessionEvent): AgentTextPayload | null {
  const payload = event.payload;
  if (payload.kind !== "agent_message" && payload.kind !== "agent_thought") return null;
  // Only an absent parent is top-level: the builder tells an empty one apart from none.
  if (payload.final || payload.parentToolUseId !== undefined || typeof payload.text !== "string") return null;
  return payload;
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
  let seq = last.seq;
  let ts = last.ts;
  for (let index = previous.length; index < next.length; index += 1) {
    const event = next[index]!;
    const chunk = openTopLevelText(event);
    // A chunk timed earlier than the one before it can move a governance decision anchored by time;
    // the session view derives that itself.
    if (!chunk || chunk.kind !== stream.kind || chunk.messageId !== stream.messageId ||
        event.sessionId !== last.sessionId || event.seq <= seq || !(event.ts >= ts)) return false;
    seq = event.seq;
    ts = event.ts;
  }
  return true;
}

/** Two generations of one item with the same fields and the same streaming state. */
function sameItem(previous: TimelineItem | undefined, next: TimelineItem): boolean {
  if (!previous || previous.kind !== next.kind || timelineItemIsStreaming(previous) !== timelineItemIsStreaming(next)) return false;
  const left = previous as unknown as Record<string, unknown>;
  const right = next as unknown as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/** `items` with the chunks `live` adds to `derivedFrom` folded onto the streaming item they continue,
 * or null when that item is not among them. */
function foldTrailingText(
  items: TimelineItem[],
  derivedFrom: readonly SessionEvent[],
  live: readonly SessionEvent[],
): TimelineItem[] | null {
  const last = derivedFrom[derivedFrom.length - 1]!;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const candidate = items[index]!;
    if ((candidate.kind !== "agent_message" && candidate.kind !== "agent_thought") ||
        candidate.kind !== last.payload.kind || candidate.sourceEndId !== last.seq ||
        candidate.parentToolUseId || !timelineItemIsStreaming(candidate)) continue;
    let item = candidate;
    for (let next = derivedFrom.length; next < live.length; next += 1) {
      const event = live[next]!;
      item = continueStreamingText(item, event.seq, (event.payload as AgentTextPayload).text, event.ts);
    }
    const folded = items.slice();
    folded[index] = item;
    return folded;
  }
  return null;
}

/**
 * The transcript's items: the session view's `items`, derived from `derivedFrom`, plus the chunks
 * the session's live events have added to its trailing reply since. Each result carries a snapshot
 * delta against the previous one, so the row projector updates only the rows that changed.
 */
export function useLiveTimelineTail(
  sessionId: string,
  derivedFrom: SessionEvent[] | undefined,
  items: TimelineItem[],
): TimelineItem[] {
  const live = useStoreSelector((state) => state.events.get(sessionId));
  const previousRef = useRef<TimelineItem[] | null>(null);
  return useMemo(() => {
    const previous = previousRef.current;
    const folded = live !== derivedFrom && onlyContinuesTrailingText(derivedFrom, live)
      ? foldTrailingText(items, derivedFrom!, live!)
      : null;
    // Without chunks to add, the session view's items pass through, unless the transcript last
    // showed its own generation: the projector then needs a delta against that one.
    if (!folded && (!previous || previous === items || timelineSnapshotDelta(items)?.previous === previous)) {
      previousRef.current = items;
      return items;
    }
    const next = folded ?? items.slice();
    if (previous) {
      const dirtyIndexes: number[] = [];
      let dirtyHasParentItems = false;
      for (let index = 0; index < Math.max(previous.length, next.length); index += 1) {
        if (previous[index] === next[index]) continue;
        // The session view re-deriving chunks the transcript already folded yields an equal item;
        // keep the one the row already shows, so it does not render (or parse) again.
        if (index < next.length && sameItem(previous[index], next[index]!)) {
          next[index] = previous[index]!;
          continue;
        }
        dirtyIndexes.push(index);
        for (const item of [previous[index], next[index]]) {
          if (item && "parentToolUseId" in item && item.parentToolUseId) dirtyHasParentItems = true;
        }
      }
      if (dirtyIndexes.length === 0) return previous;
      publishTimelineSnapshotDelta(next, { previous, dirtyFrom: dirtyIndexes[0]!, dirtyIndexes, dirtyHasParentItems });
    }
    previousRef.current = next;
    return next;
  }, [derivedFrom, items, live]);
}
