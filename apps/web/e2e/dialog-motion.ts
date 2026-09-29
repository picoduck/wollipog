import type { Page } from "@playwright/test";

/**
 * Wait for every open dialog's and menu's entrance motion to finish (docs/design-system.md §2.9).
 *
 * A dialog scales in from .98, a menu drops 4px, and a phone sheet (a dialog's or a menu's) slides
 * up from the bottom, so a bounding box read during the first few hundred milliseconds is a frame
 * of that motion, not the layout. Geometry assertions call this first; behaviour assertions do not
 * need to.
 */
export async function dialogMotionSettled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const running = () => [...document.querySelectorAll(".modal-backdrop, .menu-backdrop, .menu, .popover")]
      .flatMap((layer) => layer.getAnimations({ subtree: true }))
      // An infinite animation inside a layer (a Running status dot) never finishes; it is not motion.
      .filter((animation) => animation.playState === "running"
        && animation.effect?.getComputedTiming().iterations !== Infinity);
    // A transition canceled before it finishes rejects `finished` with an AbortError. A hover
    // transition is, when the sheet slides or reflows out from under a pointer left where the dialog
    // was opened from, and the browser starts one back in its place. So settle, then look again.
    for (let motion = running(); motion.length > 0; motion = running()) {
      await Promise.allSettled(motion.map((animation) => animation.finished));
    }
  });
}
