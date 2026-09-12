import { expect, test } from "@playwright/test";

const fixtureUrl = "/command-inbox-projects-e2e.html?scenario=composer-restart";

test("a stopped Session restarts from the composer action slot", async ({ page }) => {
  await page.goto(fixtureUrl);
  await page.evaluate(() => localStorage.clear());
  await page.goto(fixtureUrl);
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  await page.getByRole("button", { name: "Expand Session" }).click();

  const restart = page.getByRole("button", { name: "Restart Session" });
  await expect(restart).toBeVisible();
  await expect(restart).toBeEnabled();
  await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
  await expect(page.locator(".composer-input")).toBeDisabled();

  await restart.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() =>
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.restartRequests())).toEqual(["session-alpha"]);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.locator(".composer-input")).toBeEnabled();
});
