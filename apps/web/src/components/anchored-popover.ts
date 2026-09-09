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
  const [placement, setPlacement] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<Root | null>(null);
  const anchorRef = useRef<Anchor | null>(null);

  useLayoutEffect(() => {
    if (!open) { setPlacement(null); return; }
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const below = rect.bottom + 6 + height <= window.innerHeight;
      setPlacement({ top: below ? rect.bottom + 6 : Math.max(8, rect.top - 6 - height), left });
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
    style: placement ? { position: "fixed", top: placement.top, left: placement.left } : undefined,
  };
}
