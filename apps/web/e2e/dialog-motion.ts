import type { Locator, Page } from "@playwright/test";

/**
 * Wait for every open dialog's and menu's entrance motion to finish (docs/design-system.md §2.9).
 *
 * A dialog scales in from .98, a menu drops 4px, and a phone sheet (a dialog's or a menu's) slides
 * up from the bottom, so a bounding box read during the first few hundred milliseconds is a frame
 * of that motion, not the layout. Geometry assertions call this first; behaviour assertions do not
 * need to.
 */
export async function dialogMotionSettled(page: Page): Promise<void> {
  await page.locator(":root").evaluate(settle, { selector: ".modal-backdrop, .menu-backdrop, .menu, .popover", subtree: true });
}

/**
 * Wait for `locator`'s own animations and transitions (and, with `subtree`, its descendants') to
 * finish, so a measurement reads the resting state rather than a frame of the motion.
 */
export async function motionSettled(locator: Locator, { subtree = false } = {}): Promise<void> {
  await locator.evaluate(settle, { subtree });
}

/**
 * Runs in the page, so it must not close over anything. Settles the animations on `root`, or on the
 * elements under it that match `selector`, looked up afresh each round.
 */
async function settle(root: Element, { selector, subtree }: { selector?: string; subtree: boolean }): Promise<void> {
  const running = () => (selector ? [...root.querySelectorAll(selector)] : [root])
    .flatMap((element) => element.getAnimations({ subtree }))
    // An infinite animation (a Running status dot in a dialog) never finishes; it is not motion.
    .filter((animation) => animation.playState === "running"
      && animation.effect?.getComputedTiming().iterations !== Infinity);
  // A transition canceled before it finishes rejects `finished` with an AbortError. A hover
  // transition is, when an element slides or reflows out from under a stationary pointer (a sheet
  // under the pointer left where it was opened from), and the browser starts one back in its place.
  // So settle, then look again.
  for (let motion = running(); motion.length > 0; motion = running()) {
    await Promise.allSettled(motion.map((animation) => animation.finished));
  }
}
