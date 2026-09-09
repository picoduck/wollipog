import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

export interface AnchoredPopover<Root extends HTMLElement, Anchor extends HTMLElement> {
  open: boolean;
  toggle: () => void;
  close: () => void;
  /** Wrap the trigger AND the panel: an outside pointer is anything outside this element. */
  rootRef: RefObject<Root | null>;
  /** The trigger the panel is measured against. */
  anchorRef: RefObject<Anchor | null>;
  /** Fixed-position style for the panel; undefined until the first placement pass has measured. */
  style: CSSProperties | undefined;
}

/** Gap between the trigger and the panel, and the panel's minimum clearance from a screen edge. */
const GAP = 6;
const MARGIN = 8;
/** Below this, a side is too cramped to host the panel at all and anchoring is abandoned. */
const MIN_HEIGHT = 120;

export interface Placement {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * Where a viewport-anchored panel goes, given the trigger's rectangle.
 *
 * Below when the panel's design footprint fits there, otherwise whichever side has more room. The
 * CHOSEN SIDE bounds the panel's height, not the viewport: a panel taller than its footprint — a
 * session with many per-model rows — must scroll inside itself rather than run off the screen
 * edge, where a `position: fixed` element leaves no way to reach its last rows. Growing upward is
 * anchored by `bottom` because the real height is unknown until the panel has rendered.
 *
 * Pure so the geometry is testable without a layout engine.
 */
export function placePanel(
  rect: { top: number; bottom: number; left: number },
  viewport: { width: number; height: number },
  size: { width: number; height: number },
): Placement {
  const left = Math.max(MARGIN, Math.min(rect.left, viewport.width - size.width - MARGIN));
  const spaceBelow = viewport.height - rect.bottom - GAP - MARGIN;
  const spaceAbove = rect.top - GAP - MARGIN;
  const below = spaceBelow >= size.height || spaceBelow >= spaceAbove;
  const clearance = below ? spaceBelow : spaceAbove;
  // Neither side can host a usable panel — a short screen, or a trigger pinned mid-viewport. Stop
  // anchoring and fill the viewport within its margins: a panel that is merely detached from its
  // trigger is recoverable, one whose tail hangs off a fixed element is not, because no ancestor
  // is left to scroll and the panel's own scrollport is partly outside the screen.
  if (clearance < MIN_HEIGHT) {
    return { left, top: MARGIN, maxHeight: Math.max(0, viewport.height - MARGIN * 2) };
  }
  return below
    ? { left, top: rect.bottom + GAP, maxHeight: clearance }
    : { left, bottom: viewport.height - rect.top + GAP, maxHeight: clearance };
}

/**
 * Click-to-open popover anchored to a small control inside a clipped strip.
 *
 * Status-strip controls live in overflow-hidden rows, so the panel is positioned against the
 * VIEWPORT from the trigger's rectangle rather than flowing inside an ancestor that would cut it
 * off. Placed below when there is room, else above. Escape and an outside pointer close it, both
 * on the capture phase so a view-level Escape handler that stops propagation (the composer's, the
 * menus') cannot swallow the key while this panel is the thing the user is trying to close.
 *
 * Placement runs in a LAYOUT effect: the panel's un-placed fallback position is absolute, and a
 * status-strip track clips overflow, so a passive effect would let one clipped frame paint.
 *
 * `size` is the panel's design footprint, used only to choose a side and keep the panel on screen;
 * the panel's own CSS still bounds it.
 */
export function useAnchoredPopover<Root extends HTMLElement, Anchor extends HTMLElement>(
  size: { width: number; height: number },
): AnchoredPopover<Root, Anchor> {
  const { width, height } = size;
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const rootRef = useRef<Root | null>(null);
  const anchorRef = useRef<Anchor | null>(null);

  useLayoutEffect(() => {
    if (!open) { setPlacement(null); return; }
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPlacement(placePanel(
        rect,
        { width: window.innerWidth, height: window.innerHeight },
        { width, height },
      ));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, width, height]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open]);

  return {
    open,
    toggle: useCallback(() => setOpen((current) => !current), []),
    close: useCallback(() => setOpen(false), []),
    rootRef,
    anchorRef,
    // `top`/`bottom` are both stated so the un-placed CSS fallback (`top: calc(100% + 6px)`) cannot
    // combine with an inline `bottom` and stretch the panel between the two edges.
    style: placement
      ? {
          position: "fixed",
          left: placement.left,
          top: placement.top ?? "auto",
          bottom: placement.bottom ?? "auto",
          maxHeight: placement.maxHeight,
        }
      : undefined,
  };
}
