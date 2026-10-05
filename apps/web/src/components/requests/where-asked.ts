import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type { TimelineItem } from "../../timeline.js";
import { VIRTUAL_VIEWPORT_INTENT_EVENT } from "../../viewport-intent.js";
import { QUESTION_CARD_COPY } from "./QuestionStep.js";
import type { DockWhereAsked } from "./RequestDock.js";

/** The keys the reader scrolls with; one ends the marker's selection. */
const READER_SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "j", "k"]);

/** A question the dock is waiting on: its request, and the occurrence a provider may reuse it for. */
export interface PendingQuestionRef {
  requestId: string;
  occurrenceId?: string;
}

/** The transcript event of the pending question: still unanswered, and of its occurrence when both
 * name one, so an earlier answered occurrence of a reused request id is never taken for it. */
export function questionEventId(items: readonly TimelineItem[], question: PendingQuestionRef): number | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind !== "question" || item.requestId !== question.requestId || item.answered !== undefined) continue;
    if (question.occurrenceId && item.occurrenceId && item.occurrenceId !== question.occurrenceId) continue;
    return item.id;
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
  pendingQuestions,
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
  pendingQuestions: readonly PendingQuestionRef[];
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
  const pendingQuestion = useCallback((requestId: string): PendingQuestionRef =>
    pendingQuestions.find((question) => question.requestId === requestId) ?? { requestId }, [pendingQuestions]);
  const show = useCallback((requestId: string) => {
    // The latest request wins: a page still loading for another question no longer navigates.
    setSearch(null);
    setMissing(null);
    const eventId = questionEventId(items, pendingQuestion(requestId));
    if (eventId !== null) showMarker(requestId, eventId);
    else if (history.hasOlder) setSearch(requestId);
    else setMissing(requestId);
  }, [history.hasOlder, items, pendingQuestion, showMarker]);

  // One page at a time until the marker's event arrives or there is nothing older.
  useEffect(() => {
    if (search === null) return;
    const finish = (eventId: number | null) => {
      setSearch(null);
      if (eventId === null) setMissing(search);
      else showMarker(search, eventId);
    };
    if (!pendingQuestions.some((question) => question.requestId === search)) {
      setSearch(null);
      return;
    }
    const eventId = questionEventId(items, pendingQuestion(search));
    if (eventId !== null) finish(eventId);
    else if (!history.hasOlder) finish(null);
    else if (!history.loadingOlder && !loadOlder()) finish(null);
  }, [history.hasOlder, history.loadingOlder, items, loadOlder, pendingQuestion, pendingQuestions, search, showMarker]);

  // The selection lasts until the reader scrolls on their own (a wheel, a finger, a scroll key, the
  // scrollbar, or a reading shortcut's claim on the viewport), or returns to the live tail. The
  // reveal's own scrolling is none of these.
  useEffect(() => {
    const reader = readerRef.current;
    if (selected === null || !reader) return;
    const clear = () => setSelected(null);
    const clearOnScrollKey = (event: KeyboardEvent) => {
      if (READER_SCROLL_KEYS.has(event.key)) clear();
    };
    const clearOnScrollbar = (event: PointerEvent) => {
      if (event.target === reader) clear();
    };
    reader.addEventListener("wheel", clear, { passive: true });
    reader.addEventListener("touchmove", clear, { passive: true });
    reader.addEventListener("keydown", clearOnScrollKey);
    reader.addEventListener("pointerdown", clearOnScrollbar);
    reader.addEventListener(VIRTUAL_VIEWPORT_INTENT_EVENT, clear);
    return () => {
      reader.removeEventListener("wheel", clear);
      reader.removeEventListener("touchmove", clear);
      reader.removeEventListener("keydown", clearOnScrollKey);
      reader.removeEventListener("pointerdown", clearOnScrollbar);
      reader.removeEventListener(VIRTUAL_VIEWPORT_INTENT_EVENT, clear);
    };
  }, [readerRef, selected]);
  if (selected !== null && following) setSelected(null);

  const unavailableReason = useCallback((requestId: string): string | null =>
    questionEventId(items, pendingQuestion(requestId)) === null &&
      (missing === requestId || (history.complete && !history.hasOlder))
      ? QUESTION_CARD_COPY.whereAskedNotLoaded : null,
  [history.complete, history.hasOlder, items, missing, pendingQuestion]);
  const whereAsked = useMemo<DockWhereAsked>(() => ({
    show,
    unavailableReason,
    loadingRequestId: search,
  }), [search, show, unavailableReason]);
  return { whereAsked, selectedRequestId: selected };
}
