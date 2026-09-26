import { useEffect, useRef, useState } from "react";
import type { SessionEvent } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  placeRetainedAttachmentItems,
  publishTimelineSnapshotDelta,
  TimelineBuilder,
  type TimelineItem,
} from "../timeline.js";
import { isRebuiltEventsArray } from "../store.js";

interface RetainedAttachments {
  sessionId: string;
  eventEpoch: number;
  events: SessionEvent[];
}

interface BuilderState {
  sessionId: string;
  eventEpoch: number;
  builder: TimelineBuilder;
  count: number;
  lastEv: SessionEvent | null;
  lastRawArr: SessionEvent[] | null;
  timestampsBySeq: Map<number, number>;
  builderSnapshot: TimelineItem[] | null;
  displaySnapshot: TimelineItem[] | null;
  retainedSource: RetainedAttachments | null;
  displayWasOrdered: boolean;
}

/** Keep the reset-owned prefix available even when the ordinary opening page starts at a much
 * newer sequence. Each request is count-bounded and a changed epoch discards the whole chain. */
function useRetainedAttachments(sessionId: string, eventEpoch: number): RetainedAttachments | null {
  const api = useApi();
  const [loaded, setLoaded] = useState<RetainedAttachments | null>(null);
  useEffect(() => {
    if (eventEpoch <= 0) return;
    let current = true;
    void (async () => {
      const events: SessionEvent[] = [];
      let after = 0;
      for (let pageIndex = 0; pageIndex < 21; pageIndex++) {
        const page = await api.getRetainedAttachmentEventPage(sessionId, after, eventEpoch);
        if (!current || page.eventEpoch !== eventEpoch || page.nextAfter < after ||
            (page.hasMore && page.nextAfter === after)) return;
        events.push(...page.events);
        if (!page.hasMore) {
          setLoaded({ sessionId, eventEpoch, events });
          return;
        }
        after = page.nextAfter;
      }
    })().catch(() => { /* older control planes and offline sessions retain their streamed rows */ });
    return () => { current = false; };
  }, [api, sessionId, eventEpoch]);
  return loaded?.sessionId === sessionId && loaded.eventEpoch === eventEpoch ? loaded : null;
}

/** Fold live runner events incrementally. Only the control-plane attachment prefix retained by a
 * history reset is placed by timestamp; normal attachments stay at their durable sequence. The
 * placement moves existing item objects, so replay does not rebuild the entire TimelineBuilder
 * for every earlier runner event. */
export function useTimeline(sessionId: string, events: SessionEvent[] | undefined, eventEpoch = 0): TimelineItem[] {
  const retained = useRetainedAttachments(sessionId, eventEpoch);
  const ref = useRef<BuilderState | null>(null);
  const evs = events ?? [];
  const firstRawSeq = evs[0]?.seq ?? Number.MAX_SAFE_INTEGER;
  const firstRunnerAt = evs.find((event) => event.payload.kind !== "artifact_attached")?.ts;
  const supplemental = evs.length > 0
    ? retained?.events.filter((event) =>
      event.seq < firstRawSeq && (firstRunnerAt === undefined || event.ts >= firstRunnerAt)) ?? []
    : [];
  const source = supplemental.length > 0 ? [...supplemental, ...evs] : evs;

  const retainedSeqs = new Set(retained?.events.map((event) => event.seq) ?? []);

  let st = ref.current;
  const untrustworthy = evs !== st?.lastRawArr && isRebuiltEventsArray(evs);
  const extendsPrior = !untrustworthy && st != null && st.sessionId === sessionId &&
    st.eventEpoch === eventEpoch && source.length >= st.count &&
    (st.count === 0 || source[st.count - 1] === st.lastEv);
  if (!st || !extendsPrior) {
    st = {
      sessionId, eventEpoch, builder: new TimelineBuilder(), count: 0, lastEv: null,
      lastRawArr: null, timestampsBySeq: new Map(), builderSnapshot: null,
      displaySnapshot: null, retainedSource: null, displayWasOrdered: false,
    };
    ref.current = st;
  }
  for (let index = st.count; index < source.length; index++) {
    const event = source[index]!;
    st.builder.push(event);
    st.timestampsBySeq.set(event.seq, event.ts);
  }
  st.count = source.length;
  st.lastEv = source.at(-1) ?? null;
  st.lastRawArr = evs;

  const builderSnapshot = st.builder.snapshot();
  if (builderSnapshot === st.builderSnapshot && retained === st.retainedSource) {
    return st.displaySnapshot ?? builderSnapshot;
  }
  const previous = st.displaySnapshot;
  const wasOrdered = st.displayWasOrdered;
  const display = placeRetainedAttachmentItems(builderSnapshot, st.timestampsBySeq, retainedSeqs);
  if (previous && display !== previous && (display !== builderSnapshot || wasOrdered)) {
    const dirtyIndexes: number[] = [];
    for (let index = 0; index < Math.max(previous.length, display.length); index++) {
      if (previous[index] !== display[index]) dirtyIndexes.push(index);
    }
    publishTimelineSnapshotDelta(display, {
      previous,
      dirtyFrom: dirtyIndexes[0] ?? display.length,
      dirtyIndexes,
      dirtyHasParentItems: true,
    });
  }
  st.builderSnapshot = builderSnapshot;
  st.displaySnapshot = display;
  st.retainedSource = retained;
  st.displayWasOrdered = display !== builderSnapshot;
  return display;
}
