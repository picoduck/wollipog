import { expect, test } from "@playwright/test";

for (const theme of ["dark", "light"]) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    test(`campaign allowance has distinct spend, reservations and session limits at ${viewport.width} ${theme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&budget=1&theme=${theme}`);
      const summary = page.locator(".campaign-status-summary");
      await expect(summary).toContainText("Campaign Allowance");
      // The follow-up limit is an approval threshold, not an allowance ceiling (#2940): it has its own section.
      await expect(summary).toContainText("$100.00, 2000 tool calls, 4 concurrent workers");
      await expect(summary.locator("dt", { hasText: "Campaign Allowance" }).locator("+ dd")).not.toContainText("follow-ups");
      await expect(page.getByRole("region", { name: "Follow-Ups", exact: true })).toContainText("1 of 3 follow-ups without approval");
      await expect(summary).toContainText("Recorded Campaign Spend$12.00, 100 tool calls");
      await expect(summary).toContainText("Outstanding Allocations$50.00, 900 tool calls");
      await expect(summary).toContainText("Unallocated Allowance$38.00, 1000 tool calls");
      await expect(summary).toContainText("Session Limits");
      await expect(summary).toContainText("Session Limits$40.00, no session tool ceiling");
      await expect(summary).toContainText("Root Allocation$25.00, 500 tool calls");
      await expect(summary).toContainText("Managed Sessions and approved native review jobs.");
      await expect(summary).toContainText("Unmanaged reviewer invocations are unsupported.");
      await expect(summary).toContainText("This is not a hard billing cap.");
      const size = await summary.evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
      expect(size.scroll).toBeLessThanOrEqual(size.width + 1);
      if (process.env.CAMPAIGN_BUDGET_EVIDENCE_DIR) {
        await summary.screenshot({ path: `${process.env.CAMPAIGN_BUDGET_EVIDENCE_DIR}/campaign-budget-${viewport.width}-${theme}.png` });
        if (viewport.width < 500) {
          await summary.getByText("This is not a hard billing cap.", { exact: false }).scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${process.env.CAMPAIGN_BUDGET_EVIDENCE_DIR}/campaign-budget-${viewport.width}-${theme}-policy.png` });
        }
      }
    });
  }
}

for (const theme of ["dark", "light"]) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    test(`recorded campaign spend says when it includes running turns' estimates at ${viewport.width} ${theme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/campaign-status-e2e.html?scenario=campaign&budget=1&estimate=1&theme=${theme}`);
      const summary = page.locator(".campaign-status-summary");
      const spend = summary.locator("dt", { hasText: "Recorded Campaign Spend" }).locator("+ dd");
      await expect(spend).toHaveText("$12.00, 100 tool callsIncludes an estimate for running turns.");
      const size = await summary.evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
      expect(size.scroll).toBeLessThanOrEqual(size.width + 1);
      if (process.env.CAMPAIGN_BUDGET_EVIDENCE_DIR) {
        await spend.scrollIntoViewIfNeeded();
        await summary.screenshot({ path: `${process.env.CAMPAIGN_BUDGET_EVIDENCE_DIR}/campaign-budget-estimate-${viewport.width}-${theme}.png` });
      }
    });
  }
}
