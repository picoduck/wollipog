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
    const layers = [...document.querySelectorAll(".modal-backdrop, .menu-backdrop, .menu, .popover")];
    // An infinite animation inside a layer (a Running status dot) never finishes; it is not motion.
    await Promise.all(layers.flatMap((layer) => layer.getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map((animation) => animation.finished)));
  });
}
