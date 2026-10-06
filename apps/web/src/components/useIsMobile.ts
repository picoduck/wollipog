import { useSyncExternalStore } from "react";
import { TOUCH_PHONE_MEDIA } from "../mobile-viewport.js";

/**
 * The phone-width breakpoint. One source of truth shared by the JS behavior and styles.css mobile
 * rail/right-panel geometry.
 */
export const MOBILE_BREAKPOINT_PX = 760;

/**
 * The compact desktop tier (docs/design-system.md §2.10, §15.2) is wider than a phone and narrower
 * than this. It holds the desktop app's 940×600 minimum window, an iPad in portrait and a
 * half-screen laptop window: the rail stays, while bars and panes tighten. Mirrored by `--bp-compact`.
 */
export const COMPACT_BREAKPOINT_PX = 1100;

/** The wide tier starts here; only the list pane may widen (§2.10). Mirrored by `--bp-wide`. */
export const WIDE_BREAKPOINT_PX = 1440;

/**
 * A layout-density threshold inside the compact tier, not a claim about the device: everything keyed
 * on "this is a phone" uses 760px. The Shortcut Reference drops to one column at or below it. Sessions
 * rows no longer use it: tablets draw the two-line row and only phones the three-line card (#2209).
 */
export const TABLET_BREAKPOINT_PX = 900;

/**
 * A phone on its side: at or below this height the More sheet lays its rows out in two columns so
 * every row, Settings included, fits a 568×320 screen without scrolling (#1959).
 */
export const SHORT_VIEWPORT_PX = 420;

const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX}px)`;
const TABLET_QUERY = `(max-width: ${TABLET_BREAKPOINT_PX}px)`;
/** 761px through 1099px: the one definition of the compact tier. */
export const COMPACT_QUERY = `(min-width: ${MOBILE_BREAKPOINT_PX + 1}px) and (max-width: ${COMPACT_BREAKPOINT_PX - 1}px)`;
const SHORT_QUERY =`(max-height: ${SHORT_VIEWPORT_PX}px)`;

/** Live width flag; re-renders on breakpoint crossings only (not every resize pixel —
 * the snapshot is a boolean, so useSyncExternalStore ignores same-value notifications).
 * `resize` is subscribed as well: emulated/automated viewports can deliver the resize before
 * the MediaQueryList change event, and the flag must track the layout the CSS already shows. */
function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      window.addEventListener("resize", onChange);
      return () => {
        mq.removeEventListener("change", onChange);
        window.removeEventListener("resize", onChange);
      };
    },
    () => window.matchMedia(query).matches,
    // A server render has no viewport; it renders the desktop layout.
    () => false,
  );
}

/** Live phone-width flag. */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

/** Live compact-tier flag (COMPACT_QUERY): the rail stays while bars and panes tighten (§15.2). */
export function useIsCompact(): boolean {
  return useMediaQuery(COMPACT_QUERY);
}

/** Live flag for "at or below the tablet breakpoint" — inclusive, matching `max-width: 900px`. */
export function useIsTabletOrSmaller(): boolean {
  return useMediaQuery(TABLET_QUERY);
}

/** Live coarse-pointer flag: the stylesheet hides keycaps under this query (§11.5), and a tooltip
 * that would name a chord leaves it out to match. */
export function useIsCoarsePointer(): boolean {
  return useMediaQuery("(pointer: coarse)");
}

/** Live flag for a viewport at most SHORT_VIEWPORT_PX tall. */
export function useIsShortViewport(): boolean {
  return useMediaQuery(SHORT_QUERY);
}

/** Live touch-phone flag — the layout where typing means a software keyboard (TOUCH_PHONE_MEDIA).
 * Distinct from useIsMobile: a narrow desktop window is mobile-wide but has a hardware keyboard,
 * so copy and behavior keyed on the SOFTWARE keyboard must not follow width alone. */
export function useIsTouchPhone(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(TOUCH_PHONE_MEDIA);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(TOUCH_PHONE_MEDIA).matches,
  );
}
