import { useSyncExternalStore } from "react";

/**
 * The phone-width breakpoint. One source of truth shared by the JS behavior and styles.css mobile
 * rail/right-panel geometry.
 */
export const MOBILE_BREAKPOINT_PX = 760;

const QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX}px)`;

/** Live phone-width flag; re-renders on breakpoint crossings only (not every resize pixel —
 * the snapshot is a boolean, so useSyncExternalStore ignores same-value notifications).
 * `resize` is subscribed as well: emulated/automated viewports can deliver the resize before
 * the MediaQueryList change event, and the flag must track the layout the CSS already shows. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(QUERY);
      mq.addEventListener("change", onChange);
      window.addEventListener("resize", onChange);
      return () => {
        mq.removeEventListener("change", onChange);
        window.removeEventListener("resize", onChange);
      };
    },
    () => window.matchMedia(QUERY).matches,
  );
}
