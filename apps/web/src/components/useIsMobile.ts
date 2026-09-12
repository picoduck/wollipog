import { useSyncExternalStore } from "react";
import { TOUCH_PHONE_MEDIA } from "../mobile-viewport.js";

/**
 * The phone-width breakpoint. One source of truth shared by the JS behavior and styles.css mobile
 * rail/right-panel geometry.
 */
export const MOBILE_BREAKPOINT_PX = 760;

/**
 * The tablet breakpoint, matching `--bp-tablet`. The Sessions list card stacks into three rows at or
 * below this width (#901): above the phone breakpoint but below this one there is not enough line to
 * hold the agent, the project, the Git identity, and the signals column at once, and the Git
 * identity is what gives way.
 *
 * Distinct from MOBILE_BREAKPOINT_PX on purpose. This is a layout-density threshold, not a claim
 * about the device — everything keyed on "this is a phone" still uses 760px.
 */
export const TABLET_BREAKPOINT_PX = 900;

const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX}px)`;
const TABLET_QUERY = `(max-width: ${TABLET_BREAKPOINT_PX}px)`;

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
  );
}

/** Live phone-width flag. */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

/**
 * Live flag for "at or below the tablet breakpoint" — inclusive, matching `max-width: 900px` in the
 * stylesheet. The Sessions list reads this to choose its card shape and the matching virtualization
 * estimate; the two must never disagree, so both come from this one answer.
 */
export function useIsTabletOrSmaller(): boolean {
  return useMediaQuery(TABLET_QUERY);
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
