import { useRef } from "react";
import type { SessionEvent } from "@wollipog/protocol";
import { TimelineBuilder, type TimelineItem } from "../timeline.js";
import { isRebuiltEventsArray } from "../store.js";

interface BuilderState {
  sessionId: string;
  builder: TimelineBuilder;
  /** How many of `events` have been pushed. */
  count: number;
  /** Identity of the last pushed event — detects in-place extension vs wholesale replacement. */
  lastEv: SessionEvent | null;
  /** The exact array last folded — a REBUILT (merged/reset) array may replace prefix elements
   * while preserving length + tail identity, so tail checks alone can't vouch for it. */
  lastArr: SessionEvent[] | null;
}

/**
 * Incrementally derived timeline. The store appends live events (`[...arr, e]`), so when the
 * new array EXTENDS what we've folded (same element identity at the old tail), only the new
 * events are pushed — re-folding the whole stream per streamed chunk was O(n²) over a session's
 * life. Arrays produced by a store MERGE or reset (which may replace prefix elements without
 * changing the tail) are tagged by the store and always trigger a clean rebuild. Idempotent
 * across re-renders (the count guard makes a repeated render with the same array a no-op), and
 * keyed by sessionId so navigation resets the builder.
 */
export function useTimeline(sessionId: string, events: SessionEvent[] | undefined): TimelineItem[] {
  const ref = useRef<BuilderState | null>(null);
  const evs = events ?? [];
  let st = ref.current;
  // Pure appends are never tagged, so streaming stays O(delta); a rebuilt array is only
  // trusted when it is the very array we already folded (repeat render).
  const untrustworthy = evs !== st?.lastArr && isRebuiltEventsArray(evs);
  const extendsPrior =
    !untrustworthy &&
    st != null &&
    st.sessionId === sessionId &&
    evs.length >= st.count &&
    (st.count === 0 || evs[st.count - 1] === st.lastEv);
  if (!st || !extendsPrior) {
    st = { sessionId, builder: new TimelineBuilder(), count: 0, lastEv: null, lastArr: null };
    ref.current = st;
  }
  for (let i = st.count; i < evs.length; i++) st.builder.push(evs[i]!);
  st.count = evs.length;
  st.lastEv = evs[evs.length - 1] ?? null;
  st.lastArr = evs;
  return st.builder.snapshot();
}
