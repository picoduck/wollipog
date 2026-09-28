import type { Page } from "@playwright/test";

/**
 * Wait for every open dialog's entrance motion to finish (docs/design-system.md §2.9).
 *
 * A dialog scales in from .98 and a phone sheet slides up from the bottom, so a bounding box read
 * during the first few hundred milliseconds is a frame of that motion, not the layout. Geometry
 * assertions call this first; behaviour assertions do not need to.
 */
export async function dialogMotionSettled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const layers = [...document.querySelectorAll(".modal-backdrop")];
    await Promise.all(layers.flatMap((layer) => layer.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  });
}
