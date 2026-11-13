import { expect, test } from "@playwright/test";

for (const [name, viewport] of [["Desktop", { width: 1440, height: 1000 }], ["Phone", { width: 390, height: 844 }]] as const) {
  test.describe(name, () => {
    test.use({ viewport });
    test("Inbox exposes one explained owner relaunch action", async ({ page }) => {
      await page.goto("/command-inbox-projects-e2e.html?scenario=runner-recovery&fullShell=1");
      if (name === "Phone") await page.getByText("Orchestrator Recovery", { exact: true }).first().click();
      await expect(page.getByRole("button", { name: "Relaunch Orchestrator", exact: true })).toHaveCount(1);
      await expect(page.getByText("The runner restarted, so this Orchestrator needs a fresh connection for its tools.", { exact: false })).toBeVisible();
      if (name === "Phone") {
        await expect(page.getByText("Orchestrator Recovery", { exact: true })).toBeVisible();
        expect(await page.locator(".session-detail").evaluate((element) => element.scrollTop)).toBe(0);
      }
    });
    test("Campaign Status lists one root recovery under Waiting for You", async ({ page }) => {
      await page.goto("/campaign-status-e2e.html?runnerRecovery=1");
      const waiting = page.getByRole("region", { name: "Waiting for You", exact: true });
      await expect(waiting.getByRole("button", { name: "Open Request: Relaunch Orchestrator After Runner Restart", exact: true })).toHaveCount(1);
      await expect(waiting).toContainText("restore its tools and continue its pending work");
    });
  });
}
