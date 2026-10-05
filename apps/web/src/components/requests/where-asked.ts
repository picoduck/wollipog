import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type { TimelineItem } from "../../timeline.js";
import { QUESTION_CARD_COPY } from "./QuestionStep.js";
import type { DockWhereAsked } from "./RequestDock.js";

/** The keys the reader scrolls with; one ends the marker's selection. */
const READER_SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "j", "k"]);

/** The latest transcript event of the question asked under `requestId`. */
export function questionEventId(items: readonly TimelineItem[], requestId: string): number | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "question" && item.requestId === requestId) return item.id;
  }
  return null;
}

/**
 * Show Where Asked for the request dock's questions (docs/design-system.md §13.2; #2205).
 *
 * The question's marker is revealed in the transcript (`reveal`, which also puts the reader in its
 * reading-back state, so the dock takes its strip) and selected until the reader next scrolls on
 * their own or returns to the live tail. A marker older than the loaded history is loaded back to,
 * one page at a time; when the history has nothing older and the marker is not in it, its place
 * can't be shown, and the card says so.
 */
export function useQuestionWhereAsked({
  items,
  history,
  loadOlder,
  pendingRequestIds,
  reveal,
  readerRef,
  following,
  resetKey,
}: {
  items: readonly TimelineItem[];
  /** `hasOlder`: an earlier page can be loaded. `loadingOlder`: one is being loaded. `complete`: the
   * loaded history is authoritative, so a marker missing from it is missing. */
  history: { hasOlder: boolean; loadingOlder: boolean; complete: boolean };
  /** Starts loading the next earlier page; false when none can be loaded. */
  loadOlder: () => boolean;
  /** The questions the dock holds; a search for one that resolves meanwhile stops. */
  pendingRequestIds: readonly string[];
  /** Scrolls the transcript to an event, as reading back does. */
  reveal: (eventId: number) => void;
  readerRef: RefObject<HTMLElement | null>;
  /** The reader is at the live tail. */
  following: boolean;
  /** The transcript's history: a new one forgets every search and selection. */
  resetKey: string;
}): { whereAsked: DockWhereAsked; selectedRequestId: string | null } {
  const [search, setSearch] = useState<string | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    setSearch(null);
    setMissing(null);
    setSelected(null);
  }, [resetKey]);

  const showMarker = useCallback((requestId: string, eventId: number) => {
    reveal(eventId);
    setSelected(requestId);
  }, [reveal]);
  const show = useCallback((requestId: string) => {
    setMissing(null);
    const eventId = questionEventId(items, requestId);
    if (eventId !== null) showMarker(requestId, eventId);
    else if (history.hasOlder) setSearch(requestId);
    else setMissing(requestId);
  }, [history.hasOlder, items, showMarker]);

  // One page at a time until the marker's event arrives or there is nothing older.
  const pending = pendingRequestIds.join("\n");
  useEffect(() => {
    if (search === null) return;
    const finish = (eventId: number | null) => {
      setSearch(null);
      if (eventId === null) setMissing(search);
      else showMarker(search, eventId);
    };
    if (!pending.split("\n").includes(search)) {
      setSearch(null);
      return;
    }
    const eventId = questionEventId(items, search);
    if (eventId !== null) finish(eventId);
    else if (!history.hasOlder) finish(null);
    else if (!history.loadingOlder && !loadOlder()) finish(null);
  }, [history.hasOlder, history.loadingOlder, items, loadOlder, pending, search, showMarker]);

  // The selection lasts until the reader scrolls on their own, or returns to the live tail.
  useEffect(() => {
    const reader = readerRef.current;
    if (selected === null || !reader) return;
    const clear = () => setSelected(null);
    const clearOnScrollKey = (event: KeyboardEvent) => {
      if (READER_SCROLL_KEYS.has(event.key)) clear();
    };
    reader.addEventListener("wheel", clear, { passive: true });
    reader.addEventListener("touchmove", clear, { passive: true });
    reader.addEventListener("keydown", clearOnScrollKey);
    return () => {
      reader.removeEventListener("wheel", clear);
      reader.removeEventListener("touchmove", clear);
      reader.removeEventListener("keydown", clearOnScrollKey);
    };
  }, [readerRef, selected]);
  if (selected !== null && following) setSelected(null);

  const unavailableReason = useCallback((requestId: string): string | null =>
    questionEventId(items, requestId) === null &&
      (missing === requestId || (history.complete && !history.hasOlder))
      ? QUESTION_CARD_COPY.whereAskedNotLoaded : null,
  [history.complete, history.hasOlder, items, missing]);
  const whereAsked = useMemo<DockWhereAsked>(() => ({
    show,
    unavailableReason,
    loadingRequestId: search,
  }), [search, show, unavailableReason]);
  return { whereAsked, selectedRequestId: selected };
}
