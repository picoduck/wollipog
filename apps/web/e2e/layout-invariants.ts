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

/** Compare the weakest visible text against its computed background. */
export async function expectTextContrast(root: Locator) {
  const contrast = () => root.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgb = (value: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const luminance = (color: number[]) => color.slice(0, 3).map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let weakest = { ratio: Infinity, text: "" };
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.trim() || !parent.getClientRects().length || parent.closest(':disabled, [aria-disabled="true"], .sr-only')) continue;
      const layers: number[][] = [];
      for (let layer: Element | null = parent; layer; layer = layer.parentElement) {
        const color = rgb(getComputedStyle(layer).backgroundColor);
        if (color[3]) layers.push(color);
        if (color[3] === 255) break;
      }
      const over = (bottom: number[], top: number[]) => {
        const alpha = top[3]! / 255;
        return [0, 1, 2].map(index => top[index]! * alpha + bottom[index]! * (1 - alpha));
      };
      const background = layers.reduceRight(over, [255, 255, 255]);
      const foreground = over(background, rgb(getComputedStyle(parent).color));
      const [a, b] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
      const ratio = (a! + 0.05) / (b! + 0.05);
      if (ratio < weakest.ratio) weakest = { ratio, text: node.textContent.trim() };
    }
    return weakest;
  });
  // A selection can enable a button whose foreground and background are still transitioning.
  await expect.poll(async () => (await contrast()).ratio).toBeGreaterThanOrEqual(4.5);
}
