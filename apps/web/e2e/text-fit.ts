import { expect, type Locator } from "@playwright/test";

/**
 * Every rendered line of text in `box` lies inside its border box, and no ancestor in it clips.
 *
 * For a control whose option labels have a fixed box to fit — a pill, a listbox option, a picker's
 * trigger. Each text node's client rects are compared with the box, so a label drawn past its
 * border fails even though the element itself is the right size.
 */
export async function expectTextFits(box: Locator, what: string) {
  const misfits = await box.evaluate((element) => {
    const outer = element.getBoundingClientRect();
    const found: string[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      if (!text) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width === 0) continue;
        if (rect.left < outer.left - 0.5 || rect.right > outer.right + 0.5) {
          found.push(`"${text}" spans ${rect.left.toFixed(1)}-${rect.right.toFixed(1)} in ${outer.left.toFixed(1)}-${outer.right.toFixed(1)}`);
        }
      }
      // An ellipsis keeps the glyphs it shows inside the box while hiding the rest of the words.
      for (let parent = node.parentElement; parent && element.contains(parent); parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowX !== "visible" && parent.scrollWidth > parent.clientWidth) {
          found.push(`"${text}" is clipped by ${parent.className || parent.tagName}`);
        }
      }
    }
    return found;
  });
  expect(misfits, what).toEqual([]);
}
