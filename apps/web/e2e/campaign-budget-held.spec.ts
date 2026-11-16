import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

for (const theme of ["dark", "light"]) {
  for (const [device, width] of [["desktop", 1440], ["phone", 390]] as const) {
    test(`budget hold explains its amounts on ${device} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&automation=budget&theme=${theme}`);
      await page.getByRole("button", { name: "Expand All", exact: true }).click();
      const notice = page.locator(".campaign-status .notice", { hasText: "Automatic continuation is blocked" });
      await expect(notice).toBeVisible();
      await expect(notice).toContainText("40 USD spent, 0 USD reserved, limit 120 USD");
      await expect(notice).toContainText("Session allocation: 40 USD, 40 tool calls");
      const geometry = await notice.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
      const directory = process.env.CAMPAIGN_RECOVERY_EVIDENCE_DIR;
      if (directory) {
        mkdirSync(directory, { recursive: true });
        await notice.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(directory, `budget-${device}-${theme}.png`) });
      }
    });
  }
}
