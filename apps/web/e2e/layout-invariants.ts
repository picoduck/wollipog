import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Layout invariants a pane must keep whatever it is given: long titles, many requests, narrow screens.
 * They measure the rendered page, so they hold for any markup that draws the same result.
 */

/**
 * Nothing in `pane` scrolls sideways: the pane itself and every scroll container inside it are no
 * wider than their own box. A truncated label (`overflow: hidden` with an ellipsis) is not a scroll
 * container and may be clipped; anything a person could scroll sideways may not.
 */
export async function expectNoHorizontalOverflow(pane: Locator, what = "The pane") {
  const overflowing = await pane.evaluate((root) => {
    const found: string[] = [];
    const describe = (element: Element) =>
      `${element.tagName.toLowerCase()}${element.className && typeof element.className === "string" ? `.${element.className.trim().split(/\s+/).join(".")}` : ""}`;
    const scrolls = (element: Element) => ["auto", "scroll"].includes(getComputedStyle(element).overflowX);
    for (const element of [root, ...root.querySelectorAll("*")]) {
      if (element !== root && !scrolls(element)) continue;
      if (element.scrollWidth > element.clientWidth + 1) {
        found.push(`${describe(element)} is ${element.scrollWidth}px wide in ${element.clientWidth}px`);
      }
    }
    return found;
  });
  expect(overflowing, `${what} has no horizontal overflow`).toEqual([]);
}

/** `target` is drawn whole on the screen: inside the viewport and unclipped by any scrolling ancestor. */
export async function expectFullyInViewport(target: Locator, what = "The element") {
  await expect(target, `${what} is fully in the viewport`).toBeInViewport({ ratio: 1 });
  const [box, viewport] = await Promise.all([
    target.boundingBox(),
    target.page().evaluate(() => ({ width: document.documentElement.clientWidth, height: window.innerHeight })),
  ]);
  expect(box, `${what} is rendered`).not.toBeNull();
  expect(box!.x, `${what} starts on the screen`).toBeGreaterThanOrEqual(0);
  expect(box!.y, `${what} starts on the screen`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${what} ends inside the screen's width`).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height, `${what} ends inside the screen's height`).toBeLessThanOrEqual(viewport.height + 1);
}

/** `target` lies within `container`'s width: it starts and ends between the container's left and right
 * edges. Vertical position is left out, so it holds for a row scrolled below a list's fold too. */
export async function expectWithinWidth(target: Locator, container: Locator, what = "The element") {
  const [inner, outer] = await Promise.all([target.boundingBox(), container.boundingBox()]);
  expect(inner, `${what} is rendered`).not.toBeNull();
  expect(outer, `${what}'s container is rendered`).not.toBeNull();
  expect(inner!.x, `${what} starts inside its container's width`).toBeGreaterThanOrEqual(outer!.x - 1);
  expect(inner!.x + inner!.width, `${what} ends inside its container's width`).toBeLessThanOrEqual(outer!.x + outer!.width + 1);
}

/** The document itself never scrolls sideways. Panes inside it that scroll sideways by design (a row
 * of cards) are theirs to check with `expectNoHorizontalOverflow`. */
export async function expectPageNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(widths.scroll, "The page has no horizontal overflow").toBeLessThanOrEqual(widths.client + 1);
}
