import { expect, test, type Page } from "@playwright/test";

/**
 * #2270: field anatomy (docs/design-system.md §8.1) in a real browser. The label sits 8px above the
 * control and the helper 4px below it; the field error takes the helper's place (§8.5), and a field
 * warning sits 4px under the helper. Every form of the label is --type-label in --text. Distances
 * are between boxes, so the machine's font stack cancels out.
 */

/** A token's computed colour, read the way the browser paints it. */
async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((property) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${property})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
}

/** Vertical gaps between a field's parts, each named by a selector inside the field. */
function gaps(page: Page, state: string, parts: string[]) {
  return page.locator(`.field[data-state="${state}"]`).evaluate((field, selectors) => {
    const boxes = selectors.map((selector) => field.querySelector(selector)!.getBoundingClientRect());
    return boxes.slice(1).map((box, index) => box.top - boxes[index]!.bottom);
  }, parts);
}

for (const theme of ["dark", "light"] as const) {
  for (const width of [1440, 390]) {
    test(`${theme} at ${width}px: label 8px above the control, helper or error 4px below, warning 4px under the helper`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/primitives-e2e.html?theme=${theme}`);
      await expect(page.locator('.field[data-state="warn"] .field-warn')).toBeVisible();

      const [labelToControl, controlToHelper] = await gaps(page, "helper", ["span", "input", ".field-helper"]);
      expect(labelToControl, "bare span label to control").toBeCloseTo(8, 1);
      expect(controlToHelper, "control to helper").toBeCloseTo(4, 1);

      const [, controlToError] = await gaps(page, "invalid", ["span", "input", ".field-error"]);
      expect(controlToError, "control to the error that replaces the helper").toBeCloseTo(4, 1);

      const [headToControl, headControlToHelper] = await gaps(page, "head", [".field-head", "input", ".field-helper"]);
      expect(headToControl, ".field-head label row to control").toBeCloseTo(8, 1);
      expect(headControlToHelper).toBeCloseTo(4, 1);

      const [, , helperToWarning] = await gaps(page, "warn", ["span", "input", ".field-helper", ".field-warn"]);
      expect(helperToWarning, "helper to field warning").toBeCloseTo(4, 1);

      const text = await token(page, "--text");
      for (const label of ['.field[data-state="helper"] > span', '.field[data-state="head"] .field-head > label']) {
        const look = await page.locator(label).evaluate((element) => {
          const style = getComputedStyle(element);
          return { color: style.color, size: style.fontSize, lineHeight: style.lineHeight, weight: style.fontWeight };
        });
        expect(look, `${label} is --type-label (12/16, 500) in --text`).toEqual({ color: text, size: "12px", lineHeight: "16px", weight: "500" });
      }
    });
  }
}
