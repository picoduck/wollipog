import { expect, test } from "@playwright/test";

test("an Edit & Resend that is temporarily blocked stays visible and says why (#1876)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const url = "/command-inbox-projects-e2e.html?scenario=edit-in-fork";
  await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(url);
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();

  const edit = page.getByRole("button", { name: "Edit User Message as a New Turn" });
  const unavailable = page.getByLabel("Edit User Message as a New Turn Unavailable");
  await expect(edit).toHaveCount(2);
  await expect(unavailable).toHaveCount(0);

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("offline"));
  await expect(edit).toHaveCount(0);
  await expect(unavailable).toHaveCount(2);
  await unavailable.last().click();
  await expect(page.locator(".tl-message-action-unavailable[open] > [role=status]"))
    .toContainText("Runner is offline.");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("online"));
  await expect(unavailable).toHaveCount(0);
  await edit.last().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Load into Composer" })).toBeEnabled();

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("offline"));
  await expect(dialog.getByText("Runner is offline.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Load into Composer" })).toBeDisabled();
});
