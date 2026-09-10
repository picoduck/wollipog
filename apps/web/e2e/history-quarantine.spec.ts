import { expect, test } from "@playwright/test";

/**
 * A quarantined provider conversation is a dead end. The dashboard has to say so where the user
 * would otherwise type, and offer the one action that can continue the work — never a retry.
 */
for (const width of [1280, 390]) for (const theme of ["dark", "light"]) {
  test(`a quarantined conversation closes the composer and offers recovery at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const url = "/command-inbox-projects-e2e.html?scenario=history-quarantine";
    await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(url);
    await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme);
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const expand = page.getByRole("button", { name: "Expand Session" });
    if (await expand.isVisible()) await expand.click();

    const banner = page.locator(".quarantine-banner");
    await expect(banner).toContainText("Conversation Quarantined");
    await expect(banner).toContainText("cannot repair it");
    await expect(banner).toContainText("turn 1");
    await expect(page.locator(".composer-input")).toBeDisabled();
    await expect(page.locator(".composer-input")).toHaveAttribute("placeholder", /quarantined/i);
    await expect(page.locator(".tl-checkpoint.quarantine")).toContainText("recovery starts from turn 1");
    await expect(page.locator(".status-badge", { hasText: "Quarantined" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("quarantined-session.png"), fullPage: true });

    await page.getByRole("button", { name: "Recover Session", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("left untouched for inspection");
    await page.screenshot({ path: test.info().outputPath("recovery-confirm.png") });
    await page.getByRole("dialog").getByRole("button", { name: "Recover Session", exact: true }).click();

    // The recovered session opens with the retained prompt waiting in its composer, unsent.
    await expect(page.locator(".composer-input")).toBeEnabled();
    await expect(page.locator(".composer-input")).toHaveValue("Now scan every changed file.");
    await expect(page.locator(".quarantine-banner")).toHaveCount(0);
    expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.recoveryRequests()))
      .toEqual([{ id: "session-alpha", turn: 1 }]);
    expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests())).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("recovered-session.png"), fullPage: true });
  });
}

test("a quarantine without a safe provider fork recovers through a fresh conversation", async ({ page }) => {
  const url = "/command-inbox-projects-e2e.html?scenario=history-quarantine-handoff";
  await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(url);
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole("button", { name: "Recover Session", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("fresh provider conversation");
  await page.getByRole("dialog").getByRole("button", { name: "Recover Session", exact: true }).click();
  await expect(page.locator(".composer-input")).toHaveValue(/Summarize the release notes/);
  expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.recoveryRequests()))
    .toEqual([{ id: "session-alpha", turn: 1, handoff: { agentId: "codex", config: { model: "gpt-5", effort: "high" } } }]);
  expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests())).toEqual([]);
});
