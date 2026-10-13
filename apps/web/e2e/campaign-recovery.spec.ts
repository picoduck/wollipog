import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

for (const theme of ["dark", "light"] as const) {
  for (const [device, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    test(`actionable exceptions fit ${device} ${theme} and preserve the existing request`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&recovery=missing_access&theme=${theme}`);
      const notice = page.locator(".campaign-status .notice", { hasText: "Human Input Required" });
      await expect(notice).toBeVisible();
      await expect(notice).toContainText("cannot grant access or expose credentials");
      await notice.getByRole("button", { name: "Show Details" }).click();
      await expect(notice).toContainText("Restore the required access through the existing human authentication flow.");
      await expect(notice).toContainText("0 of 4");
      await expect(notice.getByRole("button", { name: /approve|override|retry/i })).toHaveCount(0);
      const geometry = await page.locator(".campaign-status").evaluate(element => ({
        width: element.clientWidth, scroll: element.scrollWidth,
      }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
      const directory = process.env.CAMPAIGN_RECOVERY_EVIDENCE_DIR;
      if (directory) {
        mkdirSync(directory, { recursive: true });
        await notice.evaluate(element => element.scrollIntoView({ block: "start" }));
        await page.screenshot({ path: join(directory, `recovery-${device}-${theme}.png`) });
      }
      await page.locator(".campaign-work-row", { hasText: "Ledger Read API" }).click();
      await page.getByRole("button", { name: "Open Requests" }).click();
      await expect(page.locator(".request-panel-detail")).toContainText("Human Input Required");
      await expect(page.locator(".request-panel-detail")).toContainText("cannot grant access or expose credentials");
      if (directory) {
        const requestNotice = page.locator(".request-panel-detail .notice", { hasText: "Human Input Required" });
        await requestNotice.getByRole("button", { name: "Show Details" }).click();
        await requestNotice.evaluate(element => element.scrollIntoView({ block: "start" }));
        await page.screenshot({ path: join(directory, `request-${device}-${theme}.png`) });
      }
    });
    test(`verified children keep unfinished scoped repair active on ${device} ${theme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&recovery=failed_checks&completedChildren=1&theme=${theme}`);
      const summary = page.locator(".campaign-status-summary");
      await expect(summary.locator("dt", { hasText: /^State$/ }).locator("..")).toContainText("Active");
      await expect(summary).not.toContainText("Verified Complete");
      const notice = page.locator(".campaign-status .notice", { hasText: "Authorized Recovery" });
      await expect(notice).toBeVisible();
      await notice.getByRole("button", { name: "Show Details" }).click();
      await expect(notice).toContainText("Repair Checks");
      await expect(notice).toContainText("team/repo#123");
      await expect(notice).toContainText("1 of 4");
      await expect(notice.getByRole("button", { name: /approve|override|retry/i })).toHaveCount(0);
      const geometry = await page.locator(".campaign-status").evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
      const directory = process.env.CAMPAIGN_RECOVERY_EVIDENCE_DIR;
      if (directory) {
        mkdirSync(directory, { recursive: true });
        await notice.evaluate(element => element.scrollIntoView({ block: "start" }));
        await page.screenshot({ path: join(directory, `verified-repair-${device}-${theme}.png`) });
      }
    });
  }
}

test("denials and exhausted ceilings explain why no override is requested", async ({ page }) => {
  await page.goto("/campaign-status-e2e.html?scenario=campaign&recovery=attempts_exhausted");
  const notice = page.locator(".campaign-status .notice", { hasText: "Recovery Blocked" });
  await notice.getByRole("button", { name: "Show Details" }).click();
  await expect(notice).toContainText("4 of 4");
  await expect(notice).toContainText("No override is requested.");
  await expect(notice).toContainText("will not reset the ceiling");
  await expect(notice.getByRole("button", { name: /approve|override|retry/i })).toHaveCount(0);
});
