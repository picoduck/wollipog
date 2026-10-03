import { expect, test, type Page } from "@playwright/test";

/** A failed turn is one Turn Failed notice with Retry Turn; a stop is a footer fact (#2169). */

const turnFailed = (page: Page) =>
  page.locator(".timeline .notice", { has: page.locator(".notice-title", { hasText: "Turn Failed" }) });

for (const width of [1440, 390]) {
  for (const theme of ["dark", "light"]) {
    test(`a failed and a stopped turn at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/turn-outcomes-e2e.html?theme=${theme}`);
      const notice = turnFailed(page);
      await expect(notice).toHaveCount(1);
      await expect(notice.locator(".notice-body")).toHaveText("The provider's usage limit was reached. Wait for it to reset, then retry.");
      await expect(page.locator(".timeline")).not.toContainText("⚠");
      await expect(page.locator(".timeline")).not.toContainText("Interrupted");
      await expect(page.locator(".timeline")).not.toContainText("Rate limit reached for");

      // The notice ends its turn; only that turn's footer follows it, at the transcript's tail.
      const lastRow = page.locator(".timeline [data-virtual-row]").last();
      await expect(lastRow.locator(".notice-title")).toHaveText("Turn Failed");
      await expect(lastRow.locator(".tl-turn-footer")).toHaveCount(1);

      const stopped = page.locator(".tl-turn-stopped");
      await expect(stopped).toHaveCount(1);
      await expect(stopped.locator("time")).toHaveText(/^\d{1,2}:\d{2} [AP]M$/u);
      await expect(stopped).toContainText(/^Stopped at \d{1,2}:\d{2} [AP]M/u);
      await expect(stopped.locator("svg")).toHaveAttribute("width", "14");
      const footerLefts = await page.locator(".tl-turn-footer").evaluateAll((footers) =>
        footers.map((footer) => Math.round(footer.getBoundingClientRect().left)));
      expect(footerLefts).toHaveLength(3);
      expect(new Set(footerLefts).size, "every footer starts on the same column edge").toBe(1);
      await page.screenshot({ path: test.info().outputPath(`turn-outcomes-${width}-${theme}.png`), fullPage: true });

      await notice.getByRole("button", { name: "Show Details" }).click();
      await expect(notice.locator(".notice-details-body .code-well pre"))
        .toHaveText("Rate limit reached for claude-opus-5-5. Your limit resets at 1:00 AM.");
      await expect(notice.locator(".code-well pre")).toHaveCSS("font-family", /mono/iu);
      await page.screenshot({ path: test.info().outputPath(`turn-outcomes-${width}-${theme}-details.png`), fullPage: true });
    });
  }
}

test("Retry Turn submits the failed turn's prompt again", async ({ page }) => {
  await page.goto("/turn-outcomes-e2e.html");
  const retry = turnFailed(page).getByRole("button", { name: "Retry Turn" });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect.poll(() => page.evaluate(() => window.turnOutcomesE2E.retried()))
    .toEqual(["Summarize the release notes for 0.30."]);
});

test("with the runner offline Retry Turn is disabled with a visible reason it references", async ({ page }) => {
  await page.goto("/turn-outcomes-e2e.html?runner=offline");
  const notice = turnFailed(page);
  const retry = notice.getByRole("button", { name: "Retry Turn" });
  await expect(retry).toBeDisabled();
  const reasonId = await retry.getAttribute("aria-describedby");
  expect(reasonId).toBeTruthy();
  const reason = page.locator(`[id="${reasonId}"]`);
  await expect(reason).toBeVisible();
  await expect(reason).toHaveText("Runner is offline.");
  await expect(retry).toHaveAccessibleDescription("Runner is offline.");
});

test("where a restart would start a new conversation, Retry Turn says so instead", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/turn-outcomes-e2e.html?restart=fresh");
  const retry = turnFailed(page).getByRole("button", { name: "Retry Turn" });
  await expect(retry).toBeDisabled();
  await expect(retry).toHaveAccessibleDescription(
    "Restarting starts a new conversation. Restart the session, then send the message again.");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "the reason wraps inside the phone column").toBe(0);
});
