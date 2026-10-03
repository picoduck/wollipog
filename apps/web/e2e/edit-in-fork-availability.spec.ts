import { expect, test } from "@playwright/test";

test("an Edit in a Fork that is temporarily blocked stays listed and says why (#1869)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const url = "/command-inbox-projects-e2e.html?scenario=edit-in-fork";
  await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(url);
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();

  // Only the second message has an earlier checkpoint to fork from.
  const message = page.locator(".tl-row.user").last();
  const openMenu = async () => {
    await message.hover();
    await message.getByRole("button", { name: "More Message Actions" }).click();
    return page.getByRole("menu", { name: "More Message Actions" });
  };
  let menu = await openMenu();
  const edit = menu.getByRole("menuitem", { name: "Edit in a Fork…" });
  await expect(edit).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("edit-in-fork-available.png") });
  await page.keyboard.press("Escape");

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("offline"));
  menu = await openMenu();
  await expect(edit).toBeDisabled();
  await expect(edit).toHaveAccessibleDescription("Reconnect the runner before creating a fork.");
  await expect(edit.locator(".menu-desc")).toHaveText("Reconnect the runner before creating a fork.");
  await edit.click({ force: true });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("edit-in-fork-unavailable.png") });
  await page.keyboard.press("Escape");

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("online"));
  menu = await openMenu();
  await expect(edit).toBeEnabled();
  await edit.click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
