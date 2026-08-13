/**
 * Reduced-motion support for scrolling driven from JavaScript.
 *
 * The stylesheet's global guard collapses every CSS transition and animation, but it cannot reach
 * `element.scrollBy({ behavior: "smooth" })`: an explicit `ScrollToOptions.behavior` overrides the
 * `scroll-behavior` property entirely. So with reduce requested, the Inbox's Page Down / Page Up
 * still animated a viewport-length scroll — the single largest movement in the app, and exactly
 * the kind the setting exists to stop.
 */

/** Whether the user has asked their OS to minimise animation. */
export function prefersReducedMotion(): boolean {
  // Guarded for non-DOM environments (tests, SSR) where matchMedia is absent.
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The scroll behaviour to request right now.
 *
 * Returns "auto" under reduce — an instant jump — rather than omitting the field, because the
 * element's CSS `scroll-behavior` would otherwise still apply and could itself be smooth.
 */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
