import { expect, test } from "@playwright/test";

test.use({ video: "on" });

for (const width of [390, 1280]) for (const theme of ["light", "dark"]) {
  test(`project child defaults failures recover ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/command-inbox-projects-e2e.html");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByRole("tab", { name: /Alpha/ })).toBeVisible();
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
      window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha", { childSessionDefaults: { costBudgetUsd: 5, maxToolCalls: 100 } });
    }, theme);
    await page.getByRole("tab", { name: /Alpha/ }).hover();
    await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
    await page.getByRole("menuitem", { name: /Manage Project/ }).click();
    const section = page.getByRole("region", { name: "Child Session Defaults" });
    const cost = section.getByLabel("Child Cost Limit (USD)");
    const tools = section.getByLabel("Child Tool-Call Limit");
    const save = section.getByRole("button", { name: "Save Child Defaults" });
    const reset = section.getByRole("button", { name: "Use Installation Defaults" });
    await cost.fill("2.5");
    await tools.fill("30");
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.failNextProjectUpdate());
    await save.click();
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expect(section.getByRole("alert")).toContainText("Please retry");
    await expect(cost).toHaveValue("2.5");
    await expect(tools).toHaveValue("30");
    await expect(cost).toBeEnabled();
    await expect(tools).toBeEnabled();
    await expect(save).toBeEnabled();
    await expect(reset).toBeEnabled();
    expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().projects.find((p) => p.id === "alpha")!.childSessionDefaults))
      .toEqual({ costBudgetUsd: 5, maxToolCalls: 100 });
    await save.click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().projects.find((p) => p.id === "alpha")!.childSessionDefaults))
      .toEqual({ costBudgetUsd: 2.5, maxToolCalls: 30 });
    await cost.fill("7");
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.failNextProjectUpdate());
    await reset.click();
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expect(section.getByRole("alert")).toContainText("Please retry");
    await expect(cost).toHaveValue("7");
    await expect(tools).toHaveValue("30");
    await expect(cost).toBeEnabled();
    await expect(tools).toBeEnabled();
    await expect(save).toBeEnabled();
    await expect(reset).toBeEnabled();
    expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.model().projects.find((p) => p.id === "alpha")!.childSessionDefaults))
      .toEqual({ costBudgetUsd: 2.5, maxToolCalls: 30 });
    await reset.click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(cost).toHaveValue("5");
    await expect(tools).toHaveValue("500");
    await expect(reset).toBeDisabled();
  });

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
    await expect(section.getByLabel("Child Tool-Call Limit")).toHaveValue("500");
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.updateProject("alpha",
      { childSessionDefaults: { costBudgetUsd: 0.005, maxToolCalls: 10 } }));
    await expect(section.getByLabel("Child Cost Limit (USD)")).toHaveValue("0.005");
    await expect(section.getByLabel("Child Tool-Call Limit")).toHaveValue("10");
  });
}
