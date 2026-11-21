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

    test("the pending sign-in keeps its code field full width with Submit Code below it", async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/machine-management-e2e.html?machine=native-t14s&antigravity=signin-pending&longName");
      await page.locator('ul[aria-label="Agent Setup"] button.row').click();
      const dialog = page.getByRole("dialog", { name: "Google Antigravity" });
      const field = dialog.getByLabel("Paste the Code Google Shows");
      const submit = dialog.getByRole("button", { name: "Submit Code" });
      await expect(field).toBeVisible();
      const [fieldBox, submitBox] = [await field.boundingBox(), await submit.boundingBox()];
      expect(fieldBox && submitBox).toBeTruthy();
      expect(submitBox!.y, "Submit Code sits below the field").toBeGreaterThanOrEqual(fieldBox!.y + fieldBox!.height);
      // Stacked, Submit Code spans the column with the field. Side by side it would be a fraction of
      // it. The tolerance absorbs border and font rendering differences between platforms.
      expect(submitBox!.width, "Submit Code spans the field's column").toBeGreaterThanOrEqual(fieldBox!.width * 0.95);
      await expectNoHorizontalOverflow(dialog, "The setup dialog");
      await expectPageNoHorizontalOverflow(page);
      await expectFullyInViewport(dialog.getByRole("button", { name: "Cancel" }), "Cancel");
    });

    test("a failed check wraps a long executable path inside its notice and keeps its actions reachable", async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/machine-management-e2e.html?machine=native-t14s&antigravity=verification-failed&longName");
      await page.locator('ul[aria-label="Agent Setup"] button.row').click();
      const dialog = page.getByRole("dialog", { name: "Google Antigravity" });
      const notice = dialog.locator(".notice", { hasText: "Check Failed" });
      await expect(notice).toContainText("Checked executable: /home/design-workstation-operator");
      await expectNoHorizontalOverflow(notice, "The Check Failed notice");
      await expectNoHorizontalOverflow(dialog, "The setup dialog");
      await expectPageNoHorizontalOverflow(page);
      await expectFullyInViewport(notice.getByRole("button", { name: "Check Again" }), "Check Again");
      const done = dialog.getByRole("button", { name: "Done" });
      await done.scrollIntoViewIfNeeded();
      await expectFullyInViewport(done, "Done");
    });
  });
}
