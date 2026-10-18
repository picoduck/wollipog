import { expect, test, type Page } from "@playwright/test";

/**
 * Add Location (#2966; docs/design-system.md §5.2, §7.1, §7.5, §8.4): the existing locations are
 * one surface of two-line radio rows, at least `--row-h-2` (56px with a mouse, 64px on touch),
 * with no scroller of their own; on a 390×844 phone sheet at least six show under the header
 * without scrolling it away, and the footer's two buttons are equal and 48px.
 */

const VIEWPORTS = [
  { name: "1440×900 with a mouse", viewport: { width: 1440, height: 900 }, coarse: false, rowHeight: 56 },
  { name: "390×844 on touch", viewport: { width: 390, height: 844 }, coarse: true, rowHeight: 64 },
] as const;

const addLocation = (page: Page, name = "Add Location to Storefront") => page.getByRole("dialog", { name });

/** Every element inside the dialog that scrolls its own overflow, by class. */
async function scrollers(page: Page): Promise<string[]> {
  return addLocation(page).evaluate((dialog) => [dialog, ...dialog.querySelectorAll("*")]
    .filter((element) => {
      const overflow = getComputedStyle(element).overflowY;
      return (overflow === "auto" || overflow === "scroll") && element.scrollHeight > element.clientHeight + 1;
    })
    .map((element) => element.className));
}

for (const { name, viewport, coarse, rowHeight } of VIEWPORTS) {
  test.describe(`at ${name}`, () => {
    test.use({ viewport, ...(coarse ? { hasTouch: true, isMobile: true } : {}) });

    test(`candidate rows are at least ${rowHeight}px with no scroller of their own`, async ({ page }) => {
      await page.goto("/add-location-e2e.html");
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(coarse);
      const dialog = addLocation(page);
      await expect(dialog).toBeVisible();
      const rows = dialog.locator(".add-location-list > .choice-row");
      await expect(rows).toHaveCount(11);
      const heights = await rows.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
      expect(heights.every((height) => height >= rowHeight - 0.5), `row heights ${heights.join(", ")}`).toBe(true);
      expect(await dialog.locator(".add-location-list").evaluate((element) => {
        const style = getComputedStyle(element);
        return { overflowY: style.overflowY, maxHeight: style.maxHeight };
      })).toEqual({ overflowY: "visible", maxHeight: "none" });
      expect((await scrollers(page)).every((className) => className === "modal-body"),
        "only the dialog body may scroll").toBe(true);
      await expect(dialog.locator(".add-location-list button")).toHaveCount(0);

      if (coarse) {
        // Six rows show under the sheet's header, and the header is still there.
        const header = await dialog.locator(".modal-head").boundingBox();
        const body = await dialog.locator(".modal-body").boundingBox();
        expect(header && header.y >= 0, "the header is on screen").toBe(true);
        const visible = await rows.evaluateAll((elements, bottom) => elements
          .filter((element) => element.getBoundingClientRect().bottom <= bottom + 0.5).length, body!.y + body!.height);
        expect(visible, "rows fully visible without scrolling").toBeGreaterThanOrEqual(6);
        const buttons = await dialog.locator(".modal-foot > .btn").evaluateAll((elements) =>
          elements.map((element) => ({ width: Math.round(element.getBoundingClientRect().width), height: element.getBoundingClientRect().height })));
        expect(buttons).toHaveLength(2);
        expect(buttons[0]!.width).toBe(buttons[1]!.width);
        expect(buttons.every((button) => button.height >= 47.5)).toBe(true);
      }
    });
  });
}

test("choosing a location and pressing Add Location adds it and closes", async ({ page }) => {
  await page.goto("/add-location-e2e.html");
  const dialog = addLocation(page);
  const add = dialog.getByRole("button", { name: "Add Location" });
  await expect(add).toBeDisabled();
  await expect(dialog.locator(".add-location-reason")).toHaveText("Choose a location or a folder.");
  await dialog.getByRole("radio", { name: /^Docs Site/ }).check();
  await add.click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.__ADD_LOCATION_E2E__.added)).toEqual([{ workspaceId: "docs-site", generateSetup: false }]);
});

test("a search with no match is one row, not a block", async ({ page }) => {
  await page.goto("/add-location-e2e.html");
  const dialog = addLocation(page);
  await dialog.getByRole("searchbox", { name: "Search Locations" }).fill("nothing-like-this");
  const row = dialog.locator(".surface > .row.add-location-empty");
  await expect(row).toHaveText("No locations match. Try a machine name, a folder or a path, or add a new folder.");
  const height = await row.evaluate((element) => element.getBoundingClientRect().height);
  expect(height).toBeLessThan(100);
});

test("an offline machine's location warns and still adds; a narrower one is fixed in a stacked Change Access", async ({ page }) => {
  await page.goto("/add-location-e2e.html");
  const dialog = addLocation(page);
  const add = dialog.getByRole("button", { name: "Add Location" });
  await dialog.getByRole("radio", { name: /^Infrastructure/ }).check();
  await expect(dialog.locator(".notice")).toContainText("Build Box is offline. You can add this location, but sessions can't start there until it reconnects.");
  await expect(add).toBeEnabled();

  await dialog.getByRole("radio", { name: /^Marketing Site/ }).check();
  const mismatch = dialog.locator(".notice").filter({ hasText: "Marketing Site Is Shared Only With Builders" });
  await expect(mismatch).toBeVisible();
  await expect(add).toBeDisabled();
  await expect(dialog.locator(".add-location-reason")).toHaveText("Match the access levels to continue.");
  await mismatch.getByRole("button", { name: "Broaden Location Access…" }).click();
  const change = page.getByRole("dialog", { name: "Change Location Access" });
  await expect(change).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(change.getByRole("radio", { name: /^Organization-Wide/ })).toBeChecked();
  await change.getByRole("button", { name: "Change Access" }).click();
  await expect(change).toHaveCount(0);
  await expect(mismatch).toHaveCount(0);
  await expect(add).toBeEnabled();
});

test("New Folder browses under Machine and names the folder in Title Case", async ({ page }) => {
  await page.goto("/add-location-e2e.html");
  const dialog = addLocation(page);
  await dialog.getByRole("radio", { name: "New Folder" }).click();
  await expect(dialog.locator("select")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Machine: Studio Mac" })).toBeVisible();
  await dialog.locator(".folder-picker-list > .row", { hasText: "acme-storefront" }).click();
  await expect(dialog.getByRole("textbox", { name: "Location Name" })).toHaveValue("Acme Storefront");
  await dialog.getByRole("button", { name: "Add Location" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.__ADD_LOCATION_E2E__.created)).toEqual([{
    runnerId: "runner-1", name: "Acme Storefront", path: "/home/ada/acme-storefront",
    owner: { kind: "organization", organizationId: "org-1" }, generateSetup: false,
  }]);
});

test.describe("from New Session on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a wrapped warning under a long list keeps its whole sentence inside its box", async ({ page }) => {
    await page.goto("/add-location-e2e.html");
    const dialog = addLocation(page);
    await dialog.getByRole("radio", { name: /^Infrastructure/ }).check();
    const notice = dialog.locator(".notice").filter({ hasText: "Build Box is offline." });
    await notice.scrollIntoViewIfNeeded();
    const box = await notice.evaluate((element) => {
      const body = element.querySelector(".notice-body")!.getBoundingClientRect();
      const own = element.getBoundingClientRect();
      return { lines: Math.round(body.height / 20), inside: body.bottom <= own.bottom + 0.5 };
    });
    expect(box.lines, "the sentence wraps at 390px").toBeGreaterThan(1);
    expect(box.inside, "a notice in an overflowing body never shrinks below its text").toBe(true);
  });

  test("Add Location replaces New Session's sheet content with Back", async ({ page }) => {
    await page.goto("/add-location-e2e.html?parent=1");
    const dialog = addLocation(page);
    await expect(dialog).toBeVisible();
    await expect(page.locator(".modal-backdrop")).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: "Back to New Session" })).toBeVisible();
  });
});
