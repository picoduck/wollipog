import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent } from "react";

/** §9.3: a first hover waits this long before the tooltip opens. */
export const RAIL_TOOLTIP_DELAY_MS = 500;
/** Once a tooltip has shown, the next item's opens at once for this long after it closes. */
export const RAIL_TOOLTIP_WARM_MS = 1000;
/**
 * Leaving an item closes its tooltip only after this pause, so the pointer can cross the gap onto
 * the tooltip itself without it vanishing (WCAG 1.4.13: content shown on hover is hoverable).
 */
export const RAIL_TOOLTIP_GRACE_MS = 100;
/** The tooltip sits this far to the right of the rail's edge; styles.css bridges the same gap. */
const RAIL_TOOLTIP_OFFSET_PX = 8;

/**
 * Anything in the rail that carries `data-rail-tip` gets a tooltip: its name, and the keycap from
 * `data-rail-keys` when it has one, or the dimmer detail from `data-rail-detail` (the instance tile's
 * status). Settings and the instance tile are rendered by the shell and passed in, so the rail reads
 * these attributes rather than owning a list of what may be tipped.
 */
interface RailTip {
  anchor: HTMLElement;
  name: string;
  keys: string | null;
  detail: string | null;
  /** A focus tip stays while its item has focus, whatever the pointer does. */
  source: "pointer" | "focus";
  top: number;
  left: number;
}

function tipAnchor(target: EventTarget | null): HTMLElement | null {
  return (target as Element | null)?.closest?.<HTMLElement>("[data-rail-tip]") ?? null;
}

function focusVisible(element: HTMLElement): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    // An engine without :focus-visible cannot tell keyboard focus from a click, so it treats every
    // focus as keyboard focus rather than never showing the tooltip to keyboard users.
    return true;
  }
}

/**
 * The rail's one tooltip (docs/design-system.md §4.1, §9.3). It opens on hover with a mouse and on
 * keyboard focus, never on touch, and it is `aria-hidden`: every item's accessible name already is
 * the name it shows, and its digit is in `aria-keyshortcuts`.
 */
export function useRailTooltip(enabled: boolean) {
  const [tip, setTip] = useState<RailTip | null>(null);
  const shownRef = useRef<RailTip | null>(null);
  const pendingRef = useRef<HTMLElement | null>(null);
  // The keyboard-focused item, tracked apart from the pointer: hovering elsewhere borrows the
  // tooltip, and it returns to this item when the pointer lets go.
  const focusAnchorRef = useRef<HTMLElement | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const warmUntilRef = useRef(0);

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current != null) window.clearTimeout(showTimerRef.current);
    showTimerRef.current = null;
    pendingRef.current = null;
  }, []);
  const cancelHide = useCallback(() => {
    if (hideTimerRef.current != null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const commit = useCallback((next: RailTip | null) => {
    if (shownRef.current && !next) warmUntilRef.current = Date.now() + RAIL_TOOLTIP_WARM_MS;
    shownRef.current = next;
    setTip(next);
  }, []);

  /** The tip an item shows now, read from the item itself; null once it has left the rail. */
  const measure = useCallback((anchor: HTMLElement, source: RailTip["source"]): RailTip | null => {
    const name = anchor.dataset["railTip"];
    if (!name || !anchor.isConnected) return null;
    const item = anchor.getBoundingClientRect();
    const railEdge = anchor.closest(".app-rail")?.getBoundingClientRect().right ?? item.right;
    return {
      anchor,
      name,
      keys: anchor.dataset["railKeys"] || null,
      detail: anchor.dataset["railDetail"] || null,
      source,
      top: item.top + item.height / 2,
      left: railEdge + RAIL_TOOLTIP_OFFSET_PX,
    };
  }, []);

  /** What shows once the pointer lets go: the focused item's tip, if one still has focus. */
  const settle = useCallback((): RailTip | null => {
    const focused = focusAnchorRef.current;
    const next = focused ? measure(focused, "focus") : null;
    if (!next) focusAnchorRef.current = null;
    return next;
  }, [measure]);

  /** Escape, a press, or leaving the desktop layout: nothing shows until the next hover or focus. */
  const hide = useCallback(() => {
    clearShowTimer();
    cancelHide();
    focusAnchorRef.current = null;
    commit(null);
  }, [cancelHide, clearShowTimer, commit]);

  const show = useCallback((anchor: HTMLElement, source: RailTip["source"]) => {
    clearShowTimer();
    cancelHide();
    commit(measure(anchor, source) ?? settle());
  }, [cancelHide, clearShowTimer, commit, measure, settle]);

  const scheduleHide = useCallback(() => {
    if (!shownRef.current && !pendingRef.current) return;
    clearShowTimer();
    if (shownRef.current?.source === "focus" || hideTimerRef.current != null) return;
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      commit(settle());
    }, RAIL_TOOLTIP_GRACE_MS);
  }, [clearShowTimer, commit, settle]);

  /** Re-read the open tooltip's item, and let the tooltip go with an item that has left. */
  const sync = useCallback(() => {
    const current = shownRef.current;
    if (!current) return;
    const next = measure(current.anchor, current.source);
    if (!next) {
      if (current.anchor === focusAnchorRef.current) focusAnchorRef.current = null;
      commit(settle());
      return;
    }
    if (next.name !== current.name || next.keys !== current.keys || next.detail !== current.detail || next.top !== current.top || next.left !== current.left) {
      commit(next);
    }
  }, [commit, measure, settle]);
  // Rail preferences can hide, renumber or move the item under an open tooltip (Settings ›
  // Navigation, with the pointer resting on the rail), so it is re-read after every rail render.
  useLayoutEffect(sync);
  // A resize moves the bottom-pinned Settings item without re-rendering the rail: a height-only
  // change leaves useIsMobile() as it was.
  useEffect(() => {
    if (!tip) return;
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [tip, sync]);
  useEffect(() => {
    if (!enabled) hide();
  }, [enabled, hide]);
  useEffect(() => () => {
    if (showTimerRef.current != null) window.clearTimeout(showTimerRef.current);
    if (hideTimerRef.current != null) window.clearTimeout(hideTimerRef.current);
  }, []);
  // Dismissible without moving the pointer or focus (WCAG 1.4.13). The press is not consumed: the
  // tooltip is not a layer, so the shell's Escape ladder still gets it.
  useEffect(() => {
    if (!tip) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tip, hide]);

  const handlers = {
    onPointerOver: (event: PointerEvent<HTMLElement>) => {
      // A mouse only: touch and pen report hover inconsistently, and a tap must never leave one open.
      if (!enabled || event.pointerType !== "mouse") return;
      if ((event.target as Element).closest?.(".rail-tooltip")) return cancelHide();
      const anchor = tipAnchor(event.target);
      if (!anchor) return scheduleHide();
      cancelHide();
      if (anchor === shownRef.current?.anchor || anchor === pendingRef.current) return;
      if (shownRef.current || Date.now() < warmUntilRef.current) return show(anchor, "pointer");
      clearShowTimer();
      pendingRef.current = anchor;
      showTimerRef.current = window.setTimeout(() => show(anchor, "pointer"), RAIL_TOOLTIP_DELAY_MS);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse") scheduleHide();
    },
    // Pressing an item navigates; its tooltip has done its job.
    onPointerDown: () => hide(),
    onFocus: (event: FocusEvent<HTMLElement>) => {
      const anchor = tipAnchor(event.target);
      if (!enabled || !anchor || anchor !== event.target || !focusVisible(anchor)) return;
      focusAnchorRef.current = anchor;
      show(anchor, "focus");
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      const anchor = tipAnchor(event.target);
      if (!anchor || anchor !== focusAnchorRef.current) return;
      focusAnchorRef.current = null;
      if (shownRef.current?.anchor === anchor && shownRef.current.source === "focus") commit(null);
    },
  };

  const tooltip = enabled && tip ? (
    <div
      className="rail-tooltip"
      aria-hidden="true"
      style={{ top: tip.top, left: tip.left }}
    >
      {tip.name}
      {tip.detail && <span className="rail-tooltip-detail">{tip.detail}</span>}
      {tip.keys && <kbd>{tip.keys}</kbd>}
    </div>
  ) : null;

  return { handlers, tooltip };
}
