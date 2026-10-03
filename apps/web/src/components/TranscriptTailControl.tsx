import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Spinner } from "./common.js";
import { RECEIPT_ROW_ATTRIBUTE, receiptRowIds } from "./TranscriptReceipt.js";

export const JUMP_TO_LATEST_LABEL = "Jump to Latest";
export const RECOVERY_CHECKING_TEXT = "Checking for missed activity…";
export const RECOVERY_DONE_TEXT = "Caught up on missed activity.";

/** What the one floating control at the reader's lower edge says, highest priority first. */
export type TranscriptTailView =
  | { kind: "not-sent"; count: number }
  | { kind: "recovering" }
  | { kind: "jump"; newRows: number }
  | null;

/**
 * The control is silent unless it has something to say (#2153): a message that failed to send and
 * is off-screen, recovery in progress, or a reader away from the tail. A transcript that is
 * loading, empty or failed to load has no tail, so it shows nothing.
 */
export function transcriptTailView(input: {
  hasTail: boolean;
  offscreenNotSent: number;
  recovering: boolean;
  following: boolean;
  newRows: number;
}): TranscriptTailView {
  if (!input.hasTail) return null;
  if (input.offscreenNotSent > 0) return { kind: "not-sent", count: input.offscreenNotSent };
  if (input.recovering) return { kind: "recovering" };
  if (!input.following) return { kind: "jump", newRows: input.newRows };
  return null;
}

export function notSentLabel(count: number): string {
  return count === 1 ? "1 Message Not Sent" : `${count} Messages Not Sent`;
}

export function newRowsLabel(count: number): string {
  return `${count} New`;
}

/**
 * The reader's one polite announcement of reconnect recovery: the check while it runs, then its
 * completion. A check that ends in a load error says nothing here, since the error notice speaks
 * for itself. The text is independent of the control, which may be showing something else.
 */
export function useRecoveryAnnouncement(
  notice: "refreshing" | "stale" | "error" | null,
  sessionId: string,
): string {
  const recovering = notice === "refreshing";
  const [announcement, setAnnouncement] = useState(recovering ? RECOVERY_CHECKING_TEXT : "");
  const previousRef = useRef({ recovering, sessionId });
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { recovering, sessionId };
    if (recovering) setAnnouncement(RECOVERY_CHECKING_TEXT);
    else if (previous.sessionId === sessionId && previous.recovering && notice === null) {
      setAnnouncement(RECOVERY_DONE_TEXT);
    } else setAnnouncement("");
  }, [notice, recovering, sessionId]);
  return announcement;
}

/**
 * The ids among `ids` whose receipt row (`[data-receipt-id]` inside the scroller) is not on screen.
 * Visibility is the browser's own intersection with the scroller, so it tracks scrolling, resizing
 * and late layout without the reader's scroll handler doing any measuring. A folded group's row
 * stands for each message in it.
 */
export function useOffscreenReceipts(
  scrollRef: RefObject<HTMLElement | null>,
  ids: readonly string[],
  enabled: boolean,
): string[] {
  const [offscreen, setOffscreen] = useState<string[]>([]);
  const idsKey = ids.join("\n");
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!enabled || !root || ids.length === 0 || typeof IntersectionObserver === "undefined") {
      setOffscreen((current) => current.length === 0 ? current : []);
      return;
    }
    const visible = new Map<string, boolean>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        for (const id of receiptRowIds(entry.target)) visible.set(id, entry.isIntersecting);
      }
      const next = ids.filter((id) => visible.get(id) === false);
      setOffscreen((current) => current.length === next.length && current.every((id, index) => id === next[index])
        ? current
        : next);
    }, { root });
    for (const row of root.querySelectorAll<HTMLElement>(`[${RECEIPT_ROW_ATTRIBUTE}]`)) {
      if (receiptRowIds(row).some((id) => ids.includes(id))) observer.observe(row);
    }
    return () => observer.disconnect();
    // `idsKey` stands in for `ids`, whose identity changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, idsKey, scrollRef]);
  return offscreen;
}

/** Pixels per wheel line or page, for browsers that report the wheel in those units (Firefox). */
const WHEEL_LINE_PX = 40;
/** How far a touch may wander before it is a drag rather than a tap. */
const TOUCH_SLOP_PX = 8;
/** A drag that ends on the control is not a tap on it, whatever click the browser sends after. */
const DRAG_CLICK_SUPPRESS_MS = 600;

function wheelPixelsY(event: WheelEvent, reader: HTMLElement): number {
  if (event.deltaMode === 1) return event.deltaY * WHEEL_LINE_PX;
  if (event.deltaMode === 2) return event.deltaY * reader.clientHeight;
  return event.deltaY;
}

/**
 * The control floats over the reader without being inside its scroller, so on its own a wheel or a
 * touch drag that starts on it has nothing to scroll (#2425). Hand that input to the reader: the
 * reader's listeners receive the same wheel and touch pointer events they would have received
 * beside the control, so following pauses and resumes and earlier activity loads exactly as it
 * does there, and the reader then scrolls by the input's distance. Clicks, taps and keys still
 * belong to the control.
 */
function useScrollPassThrough(
  anchorRef: RefObject<HTMLElement | null>,
  readerRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const anchor = anchorRef.current;
    const view = anchor?.ownerDocument.defaultView;
    if (!anchor || !view) return;

    const onWheel = (event: WheelEvent) => {
      const reader = readerRef.current;
      // Ctrl+wheel and a trackpad pinch zoom the page; they never scroll the reader.
      if (!reader || event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      const relayed = new view.WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        buttons: event.buttons,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      });
      if (!reader.dispatchEvent(relayed)) return;
      reader.scrollBy({ top: wheelPixelsY(event, reader) });
    };

    // CSS gives the control `touch-action: none`, so the browser leaves a touch on it to us for
    // the whole gesture, and we play the part of the browser's own pan. The reader hears every
    // step of the touch as pointer events, which drive its touch handling (following pauses on the
    // press; earlier activity loads when the drag pulls at the head). The gesture is followed on
    // the window, not the anchor: the control can vanish mid-drag (the drag reaches the tail, or
    // recovery ends) and the rest of it then lands on whatever is under the finger.
    let drag: { pointerId: number; startY: number; lastY: number; dragging: boolean } | null = null;
    let suppressClickUntil = 0;
    const relayed = new WeakSet<Event>();
    const relayPointer = (reader: HTMLElement, event: PointerEvent) => {
      // Input that already landed in the reader reached its listeners on its own.
      if (event.target instanceof view.Node && reader.contains(event.target)) return;
      const copy = new view.PointerEvent(event.type, {
        bubbles: true,
        cancelable: true,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        isPrimary: event.isPrimary,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        button: event.button,
        buttons: event.buttons,
        width: event.width,
        height: event.height,
        pressure: event.pressure,
      });
      relayed.add(copy);
      reader.dispatchEvent(copy);
    };
    const onPointerMove = (event: PointerEvent) => {
      const reader = readerRef.current;
      if (!drag || relayed.has(event) || event.pointerId !== drag.pointerId || !reader) return;
      relayPointer(reader, event);
      if (!drag.dragging && Math.abs(event.clientY - drag.startY) < TOUCH_SLOP_PX) return;
      drag.dragging = true;
      reader.scrollBy({ top: drag.lastY - event.clientY });
      drag.lastY = event.clientY;
    };
    const endDrag = () => {
      drag = null;
      view.removeEventListener("pointermove", onPointerMove);
      view.removeEventListener("pointerup", onPointerEnd);
      view.removeEventListener("pointercancel", onPointerEnd);
    };
    const onPointerEnd = (event: PointerEvent) => {
      if (!drag || relayed.has(event) || event.pointerId !== drag.pointerId) return;
      const reader = readerRef.current;
      if (reader) relayPointer(reader, event);
      if (drag.dragging) suppressClickUntil = event.timeStamp + DRAG_CLICK_SUPPRESS_MS;
      endDrag();
    };
    const onPointerDown = (event: PointerEvent) => {
      suppressClickUntil = 0;
      const reader = readerRef.current;
      if (!reader || event.pointerType !== "touch" || !event.isPrimary) return;
      endDrag();
      drag = { pointerId: event.pointerId, startY: event.clientY, lastY: event.clientY, dragging: false };
      relayPointer(reader, event);
      view.addEventListener("pointermove", onPointerMove);
      view.addEventListener("pointerup", onPointerEnd);
      view.addEventListener("pointercancel", onPointerEnd);
    };
    const onClickCapture = (event: MouseEvent) => {
      // A keyboard activation (detail 0) is always the person's own choice.
      if (event.detail === 0 || event.timeStamp > suppressClickUntil) return;
      suppressClickUntil = 0;
      event.preventDefault();
      event.stopPropagation();
    };

    anchor.addEventListener("wheel", onWheel, { passive: false });
    anchor.addEventListener("pointerdown", onPointerDown);
    anchor.addEventListener("click", onClickCapture, true);
    return () => {
      endDrag();
      anchor.removeEventListener("wheel", onWheel);
      anchor.removeEventListener("pointerdown", onPointerDown);
      anchor.removeEventListener("click", onClickCapture, true);
    };
  }, [anchorRef, readerRef]);
}

/**
 * A zero-height anchor between the reader and the composer column, with the control floating
 * --space-3 above it. The anchor is always mounted and takes no height, so showing or hiding the
 * control can never change the reader's height, its scroll position or the follow state.
 */
export function TranscriptTailControl({
  view,
  shortcut,
  readerRef,
  onJump,
  onShowNotSent,
  onFocusLost,
}: {
  view: TranscriptTailView;
  /** The resume chord, when the reading keys are active on this surface. */
  shortcut: string | null;
  /** The transcript scroller the control floats over, which scrolling on the control moves. */
  readerRef: RefObject<HTMLElement | null>;
  onJump: () => void;
  onShowNotSent: () => void;
  /** The focused control went away (jumped, or replaced by a status): keep focus in the reader. */
  onFocusLost: () => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const heldFocusRef = useRef(false);
  useScrollPassThrough(anchorRef, readerRef);
  // Runs after every commit. If the control held focus at the last commit and this one removed or
  // replaced it, focus has fallen to the page; hand it to the reader. Focus the person moved
  // elsewhere themselves is left alone.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const active = anchor.ownerDocument.activeElement;
    if (heldFocusRef.current && !anchor.contains(active) &&
        (active === null || active === anchor.ownerDocument.body)) {
      onFocusLost();
    }
    heldFocusRef.current = anchor.contains(anchor.ownerDocument.activeElement);
  });
  return (
    <div
      ref={anchorRef}
      className="transcript-tail-anchor"
      data-tail-control={view?.kind}
      onFocus={() => { heldFocusRef.current = true; }}
      // Leaving on purpose (Tab, a click elsewhere) blurs; a removed element does not.
      onBlur={() => { heldFocusRef.current = false; }}
    >
      {view?.kind === "not-sent" ? (
        <button type="button" className="btn sm transcript-tail-control is-not-sent" onClick={onShowNotSent}>
          {notSentLabel(view.count)}
        </button>
      ) : view?.kind === "recovering" ? (
        // Not a control: it says what is happening and cannot be focused. The reader's single
        // polite live region announces it, so this copy stays out of the live tree.
        <div className="btn sm transcript-tail-control is-recovering" role="status" aria-live="off">
          <Spinner decorative />
          <span>{RECOVERY_CHECKING_TEXT}</span>
        </div>
      ) : view?.kind === "jump" ? (
        <button
          type="button"
          className="btn sm transcript-tail-control"
          aria-label={view.newRows > 0 ? `${newRowsLabel(view.newRows)}, ${JUMP_TO_LATEST_LABEL}` : undefined}
          title={shortcut ? `${JUMP_TO_LATEST_LABEL} (${shortcut})` : JUMP_TO_LATEST_LABEL}
          onClick={onJump}
        >
          {view.newRows > 0 ? newRowsLabel(view.newRows) : JUMP_TO_LATEST_LABEL}
          {shortcut && <kbd aria-hidden="true">{shortcut}</kbd>}
        </button>
      ) : null}
    </div>
  );
}
