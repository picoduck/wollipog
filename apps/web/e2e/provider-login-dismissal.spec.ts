import { expect, test } from "@playwright/test";

for (const viewport of [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 390, height: 844 }]) {
  test(`failed machine sign-in dismissal and subsequent failure on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/runners/runner-1/provider-logins/*/dismiss", route =>
      route.fulfill({ json: { dismissed: true } }));
    await page.goto("/sessions-board-e2e.html?provider-logins");
    const work = page.getByRole("article", { name: "Work Provider Sign-In" });
    const team = page.getByRole("article", { name: "Team Provider Sign-In" });
    const dismiss = work.getByRole("button", { name: "Dismiss", exact: true });
    await expect(dismiss).toBeVisible();
    const box = await dismiss.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await expect(team.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    await expect(team.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
    await page.screenshot({ path: `test-results/provider-login-before-${viewport.name}.png`, fullPage: true });
    await dismiss.focus();
    await page.keyboard.press("Enter");
    await expect(work).toHaveCount(0);
    await expect(team).toBeVisible();
    expect(await page.evaluate(() => window.__providerLoginCalls)).toEqual(["dismiss:login_failed-first"]);
    await page.evaluate(() => window.__replayProviderLoginSnapshot());
    await expect(work).toHaveCount(0);
    await page.getByRole("link", { name: "Projects", exact: true }).click();
    await page.getByRole("link", { name: "Sessions", exact: true }).click();
    await expect(work).toHaveCount(0);
    await page.screenshot({ path: `test-results/provider-login-after-${viewport.name}.png`, fullPage: true });
    await page.evaluate(() => window.__publishProviderLogins([
      { operationId: "login_failed-next", accountId: "work", label: "Work", provider: "claude",
        status: "timed_out", expectsCode: false, startedAt: 3, error: "The sign-in attempt timed out." },
      { operationId: "login_active", accountId: "team", label: "Team", provider: "codex",
        status: "waiting_for_provider", expectsCode: false, startedAt: 2 },
    ]));
    await expect(work.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
    await expect(work).toContainText("Timed Out");
    await team.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(team).toHaveCount(0);
    await expect(work).toBeVisible();
    expect(await page.evaluate(() => window.__providerLoginCalls))
      .toEqual(["dismiss:login_failed-first", "cancel:login_active"]);
  });
}

test("failed acknowledgment stays visible and exposes a retryable error", async ({ page }) => {
  await page.route("**/api/runners/runner-1/provider-logins/*/dismiss", route =>
    route.fulfill({ status: 503, json: { error: "Notice could not be saved." } }));
  await page.goto("/sessions-board-e2e.html?provider-logins");
  const work = page.getByRole("article", { name: "Work Provider Sign-In" });
  await work.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(work.getByRole("alert").last()).toHaveText("Notice could not be saved.");
  await expect(work.getByRole("button", { name: "Dismiss", exact: true })).toBeEnabled();
});
