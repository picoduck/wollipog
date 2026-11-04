import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  for (const outcome of ["approve", "deny"]) {
    test(`automation creation exposes the exact human decision and ${outcome} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/request-surfaces-e2e.html?scenario=automation-creation");
      const details = page.getByRole("region", { name: "Create Automation Details" });
      await expect(details).toBeVisible();
      for (const text of ["Daily CI Reliability Review", "0 6 * * *", "UTC", "example-model", "example-machine", "$5", "50",
        "Inspect CI outcomes and report reliability.", "Keep all repository protections unchanged."]) await expect(details).toContainText(text);
      await details.getByText("Full Configuration", { exact: true }).click();
      for (const text of ["example-installation", "example-location", "notifications", "misfirePolicy", "concurrencyPolicy"]) await expect(details).toContainText(text);
      const foot = page.locator(".request-dock .request-card-foot");
      await foot.getByRole("button", { name: outcome === "approve" ? /^Approve/ : /^Deny/ }).click();
      await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_REQUEST_SURFACES_E2E__.submissions())).toEqual([
        { requestId: "evidence-occurrence", optionId: outcome },
      ]);
      await expect(page.locator("details.tl-decision .tl-decision-outcome")).toHaveText(outcome === "approve" ? "Allowed" : "Rejected");
    });
  }
}

for (const width of [1440, 390]) for (const action of ["prompt", "workflow"]) {
  test(`automation ${action} identity and inheritance remain visible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/request-surfaces-e2e.html?scenario=automation-creation&action=${action}`);
    const details = page.getByRole("region", { name: "Create Automation Details" });
    await expect(details).toContainText("Inherit at Run Time");
    await expect(details).toContainText("does not override future session settings");
    if (action === "prompt") {
      await expect(details).toContainText("/inspect-ci");
      await expect(details).toContainText("example-target-session");
      await expect(details).toContainText("read-only");
    } else {
      await expect(details).toContainText("example-health-workflow");
      await expect(details.locator("div").filter({ has: page.locator("dt", { hasText: /^Workflow Version$/ }) })).toContainText("3");
    }
    await expect(details.locator("details")).not.toHaveAttribute("open");
  });
}
