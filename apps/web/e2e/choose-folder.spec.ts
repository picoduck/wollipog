import { expect, test, type Page } from "@playwright/test";

/**
 * #2956: Choose Folder's folder rows are `--row-h` (40px with a mouse, 48px on a coarse pointer),
 * and the list has no height or scroller of its own, so the dialog body is the only thing that
 * scrolls, on a desktop dialog and on a phone sheet alike (docs/design-system.md §5.2, §7.1).
 */

const VIEWPORTS = [
  { name: "1440×900 with a mouse", viewport: { width: 1440, height: 900 }, coarse: false, rowHeight: 40 },
  { name: "390×844 on touch", viewport: { width: 390, height: 844 }, coarse: true, rowHeight: 48 },
] as const;

/** Every element inside the dialog that scrolls its own overflow, by class. */
async function scrollers(page: Page): Promise<string[]> {
  return page.getByRole("dialog", { name: "Choose Folder" }).evaluate((dialog) => [dialog, ...dialog.querySelectorAll("*")]
    .filter((element) => {
      const overflow = getComputedStyle(element).overflowY;
      return (overflow === "auto" || overflow === "scroll") && element.scrollHeight > element.clientHeight + 1;
    })
    .map((element) => element.className));
}

for (const { name, viewport, coarse, rowHeight } of VIEWPORTS) {
  test.describe(`at ${name}`, () => {
    test.use({ viewport, ...(coarse ? { hasTouch: true, isMobile: true } : {}) });

    test(`folder rows are ${rowHeight}px and the dialog body is the only scroller`, async ({ page }) => {
      await page.goto("/choose-folder-e2e.html?open=1");
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(coarse);
      const chooser = page.getByRole("dialog", { name: "Choose Folder" });
      await expect(chooser).toHaveAccessibleDescription("On Build Box");
      const rows = chooser.locator(".folder-picker-list > .row");
      await expect(rows).toHaveCount(17);
      await expect(rows.first()).toHaveText("Up One Level");

      const heights = await rows.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
      expect(heights.every((height) => Math.abs(height - rowHeight) < 0.5), `row heights ${heights.join(", ")}`).toBe(true);

      const list = await chooser.locator(".folder-picker-list").evaluate((element) => {
        const style = getComputedStyle(element);
        return { overflowY: style.overflowY, maxHeight: style.maxHeight, clipped: element.scrollHeight > element.clientHeight + 1 };
      });
      expect(list).toEqual({ overflowY: "visible", maxHeight: "none", clipped: false });
      // Sixteen folders overflow either viewport, so the body scrolls, and nothing inside it does.
      expect(await scrollers(page)).toEqual(["modal-body"]);

      await chooser.locator(".folder-picker-list > .row", { hasText: "notes" }).click();
      await expect(chooser.locator(".folder-picker-empty")).toHaveText("No subfolders here. You can still use this folder.");
      const empty = await chooser.locator(".folder-picker-empty").evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        fontSize: getComputedStyle(element).fontSize,
        rowFontSize: getComputedStyle(element.parentElement!.querySelector(".row-title")!).fontSize,
      }));
      expect(empty.height).toBeGreaterThanOrEqual(rowHeight - 0.5);
      expect(empty.fontSize, "the empty line is at the row's type size").toBe(empty.rowFontSize);

      await chooser.getByRole("button", { name: "Edit Path" }).click();
      const field = chooser.getByRole("textbox", { name: "Path" });
      await expect(field).toBeFocused();
      await expect(field).toHaveValue("/home/ada/notes");
      if (coarse) {
        expect(await field.evaluate((element) => getComputedStyle(element).fontSize), "16px text keeps iOS from zooming").toBe("16px");
      }
    });
  });
}

test("a long trail wraps on a phone, so the current folder stays in view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/choose-folder-e2e.html?open=1");
  const chooser = page.getByRole("dialog", { name: "Choose Folder" });
  await chooser.getByRole("button", { name: "Up One Level" }).click();
  await chooser.getByRole("button", { name: "Up One Level" }).click();
  await chooser.getByRole("button", { name: "home", exact: true }).click();
  await chooser.getByRole("button", { name: "ada", exact: true }).click();
  await chooser.getByRole("button", { name: "repos", exact: true }).click();
  await chooser.getByRole("button", { name: "wollipog", exact: true }).click();
  await expect(chooser.locator(".crumbs .crumb")).toHaveText(["Home", "repos", "wollipog"]);
  const fits = await chooser.locator(".crumbs").evaluate((trail) => {
    const current = trail.querySelector(".crumb.is-current")!.getBoundingClientRect();
    const box = trail.getBoundingClientRect();
    return current.right <= box.right + 0.5 && trail.scrollWidth <= trail.clientWidth;
  });
  expect(fits).toBe(true);
});
