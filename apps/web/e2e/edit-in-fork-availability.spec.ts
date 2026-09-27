import { expect, test } from "@playwright/test";

test("an Edit in Fork that is temporarily blocked stays visible and says why (#1869)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const url = "/command-inbox-projects-e2e.html?scenario=edit-in-fork";
  await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(url);
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();

  const edit = page.getByRole("button", { name: "Edit User Message in a New Conversation Fork" });
  const unavailable = page.getByLabel("Edit User Message in a New Conversation Fork Unavailable");
  await expect(edit).toHaveCount(1);
  await expect(unavailable).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("edit-in-fork-available.png") });

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("offline"));
  await expect(edit).toHaveCount(0);
  await expect(unavailable).toHaveCount(1);
  await unavailable.click();
  await expect(page.locator(".tl-message-action-unavailable[open] > [role=status]"))
    .toContainText("Reconnect the runner before creating a fork.");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("edit-in-fork-unavailable.png") });

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("online"));
  await expect(unavailable).toHaveCount(0);
  await edit.click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
