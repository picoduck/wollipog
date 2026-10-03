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

/**
 * A zero-height anchor between the reader and the composer column, with the control floating
 * --space-3 above it. The anchor is always mounted and takes no height, so showing or hiding the
 * control can never change the reader's height, its scroll position or the follow state.
 */
export function TranscriptTailControl({
  view,
  shortcut,
  onJump,
  onShowNotSent,
  onFocusLost,
}: {
  view: TranscriptTailView;
  /** The resume chord, when the reading keys are active on this surface. */
  shortcut: string | null;
  onJump: () => void;
  onShowNotSent: () => void;
  /** The focused control went away (jumped, or replaced by a status): keep focus in the reader. */
  onFocusLost: () => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const heldFocusRef = useRef(false);
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
