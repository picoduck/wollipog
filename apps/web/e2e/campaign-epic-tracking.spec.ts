import { expect, test } from "@playwright/test";

for (const [device, width, height, theme] of [["desktop", 1440, 1200, "dark"], ["phone", 390, 844, "light"]] as const) {
  test(`#4403 epic tracking and delivery gaps stay coherent on ${device}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.clock.setFixedTime(new Date("2026-01-01T12:00:00Z"));
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const mode of ["complete", "delivery"] as const) {
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&epicTracking=${mode}&theme=${theme}`);
      const panel = page.locator(".campaign-status");
      const summary = page.locator(".campaign-status-summary");
      await expect(summary).toContainText(mode === "complete" ? "Campaign Complete" : "Campaign Stuck");
      await expect(summary).toContainText(mode === "complete" ? "2 of 2 Delivered" : "1 of 2 Delivered");
      await page.getByRole("button", { name: /^State:/ }).click();
      await page.getByRole("option", { name: "All States" }).click();
      const rows = page.locator(".campaign-work-row");
      await expect(rows).toHaveCount(2);
      const epic = rows.filter({ hasText: mode === "complete" ? "Epic Tracking" : "Epic With Delivery Work" });
      await expect(epic).toHaveAttribute("data-state", mode === "complete" ? "delivered" : "planned");
      const geometry = await panel.evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
      if (process.env.CAMPAIGN_EPIC_TRACKING_EVIDENCE_DIR) {
        await panel.evaluate((element) => { element.scrollTop = 0; });
        await page.screenshot({ path: `${process.env.CAMPAIGN_EPIC_TRACKING_EVIDENCE_DIR}/epic-${mode}-${device}-${theme}.png` });
        if (device === "phone") {
          await rows.last().scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${process.env.CAMPAIGN_EPIC_TRACKING_EVIDENCE_DIR}/epic-${mode}-${device}-${theme}-work.png` });
        }
      }
      await epic.click();
      await expect(page.locator("h3.campaign-detail-title")).toHaveText(mode === "complete" ? "Epic Tracking" : "Epic With Delivery Work");
      await expect(panel).toContainText("Previous Attempts");
      await expect(panel).toContainText("Failed");
      expect(errors).toEqual([]);
    }
  });
}
