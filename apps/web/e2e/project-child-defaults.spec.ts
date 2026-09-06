import { expect, test } from "@playwright/test";

test.use({ video: "on" });

for (const width of [390, 1280]) for (const theme of ["light", "dark"]) {
  test(`project child defaults ${width} ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/command-inbox-projects-e2e.html");
    await page.evaluate(() => localStorage.clear());
    await page.goto("/command-inbox-projects-e2e.html");
    await expect(page.getByRole("tab", { name: /Alpha/ })).toBeVisible();
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", { childSessionDefaults: null });
    }, theme);
    await page.getByRole("tab", { name: /Alpha/ }).hover();
    await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
    await page.getByRole("menuitem", { name: /Manage Project/ }).click();
    const section = page.getByRole("region", { name: "Child Session Defaults" });
    await expect(section).toBeVisible();
    await section.screenshot({ path: testInfo.outputPath("before.png") });
    await section.getByLabel("Child Cost Limit (USD)").fill("2.5");
    await section.getByLabel("Child Tool-Call Limit").fill("30");
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha",
      { childSessionDefaults: { costBudgetUsd: 9, maxToolCalls: 90 } }));
    await expect(section.getByLabel("Child Cost Limit (USD)")).toHaveValue("2.5");
    await expect(section.getByLabel("Child Tool-Call Limit")).toHaveValue("30");
    await section.getByRole("button", { name: "Save Child Defaults" }).click();
    await expect(section.getByRole("button", { name: "Use Installation Defaults" })).toBeEnabled();
    await section.screenshot({ path: testInfo.outputPath("after.png") });
    await page.reload();
    await page.getByRole("tab", { name: /Alpha/ }).hover();
    await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
    await page.getByRole("menuitem", { name: /Manage Project/ }).click();
    await expect(section.getByLabel("Child Cost Limit (USD)")).toHaveValue("2.5");
    await expect(section.getByLabel("Child Tool-Call Limit")).toHaveValue("30");
    await section.getByRole("button", { name: "Use Installation Defaults" }).click();
    await expect(section.getByLabel("Child Cost Limit (USD)")).toHaveValue("5");
    await expect(section.getByLabel("Child Tool-Call Limit")).toHaveValue("100");
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha",
      { childSessionDefaults: { costBudgetUsd: 0.005, maxToolCalls: 10 } }));
    await expect(section.getByLabel("Child Cost Limit (USD)")).toHaveValue("0.005");
    await expect(section.getByLabel("Child Tool-Call Limit")).toHaveValue("10");
  });
}
