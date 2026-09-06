import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) for (const theme of ["dark", "light"]) {
  test(`checkpoint handoff remains unsent and reviewable at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const url = "/command-inbox-projects-e2e.html?scenario=conversation-handoff";
    await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(url);
    await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme);
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const expand = page.getByRole("button", { name: "Expand Session" });
    if (await expand.isVisible()) await expand.click();
    const action = page.getByRole("button", { name: "Hand Off to Another Agent" });
    await expect(action).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("handoff-source.png") });
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(109));
    await expect(action).toBeDisabled();
    await expect(action).toHaveAttribute("title", /Update the runner/);
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerProtocolVersion(110));
    await action.click();
    await expect(page.getByRole("dialog")).toContainText("Creating the handoff sends nothing");
    await page.getByRole("dialog").getByRole("button", { name: "Effort: Default", exact: true }).click();
    await page.getByRole("option", { name: "High", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Permissions: Default", exact: true }).click();
    await page.getByRole("option", { name: "Plan Only (Read-Only)", exact: true }).click();
    await page.screenshot({ path: test.info().outputPath("handoff-settings.png") });
    await page.getByRole("button", { name: "Create Handoff", exact: true }).click();
    await expect(page.locator(".composer-input")).toHaveValue(/Keep the interface accessible on mobile/);
    await expect(page.locator(".tl-checkpoint.restored")).toContainText("fresh provider conversation");
    expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests())).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("handoff-draft.png") });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(1);
  });
}
