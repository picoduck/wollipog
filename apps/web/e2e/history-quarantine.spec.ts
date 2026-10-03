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

    const banner = page.locator('[aria-label="Conversation Quarantined"]');
    await expect(banner).toContainText("Conversation Quarantined");
    await expect(banner).toContainText("new messages can’t be sent here");
    await expect(banner).not.toContainText("Turn 1");
    await banner.getByRole("button", { name: "Show Details" }).click();
    await expect(banner).toContainText("after Turn 1");
    // The provider's own bounded account of the rejection, in a mono well.
    await expect(banner.locator(".code-well")).toContainText("history position 675");
    await expect(banner).not.toContainText("/compact");
    await expect(page.locator(".composer-input")).toBeDisabled();
    await expect(page.locator(".composer-input")).toHaveAttribute("placeholder", /quarantined/i);
    await expect(page.locator(".status", { hasText: "Quarantined" })).toBeVisible();
    // The provider's own rejection marks the point in the transcript as a Turn Failed notice; its
    // words, which name sizes and never content, wait behind Show Details (#2169).
    const turnFailed = page.locator(".timeline .notice", { has: page.locator(".notice-title", { hasText: "Turn Failed" }) });
    await expect(turnFailed).toHaveCount(1);
    await turnFailed.getByRole("button", { name: "Show Details" }).click();
    await expect(turnFailed.locator(".code-well")).toContainText("rejected this conversation's stored history");
    await page.screenshot({ path: test.info().outputPath("quarantined-session.png"), fullPage: true });

    await page.getByRole("button", { name: "Recover Session", exact: true }).click();
    // #2185: the confirmation names the turn and says the session stays to be inspected.
    await expect(page.getByRole("dialog")).toContainText("This session stays as it is so you can inspect it.");
    await expect(page.getByRole("dialog")).toContainText("Turn 1");
    await page.screenshot({ path: test.info().outputPath("recovery-confirm.png") });
    await page.getByRole("dialog").getByRole("button", { name: "Recover Session", exact: true }).click();

    // The recovered session opens with the retained prompt waiting in its composer, unsent.
    await expect(page.locator(".composer-input")).toBeEnabled();
    await expect(page.locator(".composer-input")).toHaveValue("Now scan every changed file.");
    await expect(page.locator('[aria-label="Conversation Quarantined"]')).toHaveCount(0);
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
  // #2185: one turn is named as "Turn 1", not a range.
  await expect(page.getByRole("dialog")).toContainText("starts a fresh conversation from a summary of Turn 1, with the files");
  await page.getByRole("dialog").getByRole("button", { name: "Recover Session", exact: true }).click();
  await expect(page.locator(".composer-input")).toHaveValue(/Summarize the release notes/);
  expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.recoveryRequests()))
    .toEqual([{ id: "session-alpha", turn: 1, handoff: { agentId: "codex", config: { model: "gpt-5", effort: "high" } } }]);
  expect(await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests())).toEqual([]);
});
