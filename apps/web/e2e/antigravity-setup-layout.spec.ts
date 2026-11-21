import { expect, test } from "@playwright/test";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow } from "./layout-invariants.js";

/** Google Antigravity setup (#4780) holds a ready report's full model inventory, with long unbroken
 * names, inside its dialog at desktop, compact and phone widths, and Done stays reachable. */
const VIEWPORTS = [
  { width: 1440, height: 900, touch: false },
  { width: 834, height: 1112, touch: false },
  { width: 390, height: 844, touch: true },
] as const;

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.width}px`, () => {
    if (viewport.touch) test.use({ hasTouch: true, isMobile: true });

    test("the ready dialog contains 64 long model names and keeps Done reachable", async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/machine-management-e2e.html?machine=native-t14s&antigravity=ready&manyModels&longName");
      await page.locator('ul[aria-label="Agent Setup"] button.row').click();
      const dialog = page.getByRole("dialog", { name: "Google Antigravity" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("gemini-fixture-experimental-long-context-preview-model-63");
      await expectNoHorizontalOverflow(dialog, "The setup dialog");
      await expectPageNoHorizontalOverflow(page);
      const done = dialog.getByRole("button", { name: "Done" });
      await done.scrollIntoViewIfNeeded();
      await expectFullyInViewport(done, "Done");
      await expectFullyInViewport(dialog.getByRole("button", { name: "Check Again" }).first(), "Check Again");
    });
  });
}
