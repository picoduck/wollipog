import { expect, test, type Page } from "@playwright/test";

/**
 * #2940 AC7: a Full Control campaign's normal, server-verified completion is informational. Its root
 * reads Campaign Complete and offers no Mark Reviewed, while a Custom campaign and a blocked Full
 * Control campaign with the same unacknowledged result keep Ready for Review.
 */
const PAGE = "/command-inbox-projects-e2e.html?scenario=campaign-complete";
const SHOT = process.env.CAMPAIGN_COMPLETE_SHOTS ?? "test-results/campaign-complete";
const complete = "Full Control Campaign Delivered";
const custom = "Custom Campaign Delivered";
const blocked = "Full Control Campaign Blocked";
const row = (page: Page, title: string) => page.locator(".inbox-row-shell", { hasText: title });
// Wait for finite animations only (a pulse never finishes); a cancelled one rejects `finished`.
const settle = (page: Page) => page.evaluate(() => Promise.allSettled(document.getAnimations()
  .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity).map((animation) => animation.finished))
  .then(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));

for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
  for (const theme of ["dark", "light"] as const) {
    test(`${viewport.name} ${theme}: a verified-complete Full Control root is informational`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(PAGE);
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await expect(page.getByRole("grid", { name: "Sessions", exact: true })).toBeVisible();
      // Review work sorts first; the informational completion sorts with quiet sessions.
      await expect.poll(() => page.locator(".inbox-row-title").allTextContents()).toEqual([custom, blocked, complete]);
      await expect(row(page, complete).locator(".status")).toHaveText("Campaign Complete");
      await expect(row(page, complete).getByText("Ready for Review", { exact: true })).toHaveCount(0);
      await expect(row(page, custom).locator(".status")).toHaveText("Ready for Review");
      await expect(row(page, blocked).locator(".status")).toHaveText("Ready for Review");
      await settle(page);
      await page.screenshot({ path: `${SHOT}/${viewport.name}-${theme}-list.png` });

      await row(page, complete).click({ button: "right" });
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Mark Reviewed", exact: true })).toHaveCount(0);
      await settle(page);
      await page.screenshot({ path: `${SHOT}/${viewport.name}-${theme}-complete-menu.png` });
      await page.keyboard.press("Escape");

      await row(page, custom).click({ button: "right" });
      await expect(page.getByRole("menuitem", { name: "Mark Reviewed", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    });
  }
}
