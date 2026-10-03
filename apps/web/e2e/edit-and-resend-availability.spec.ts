import { expect, test } from "@playwright/test";

test("an Edit as a New Turn that is temporarily blocked stays listed and says why (#1876)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const url = "/command-inbox-projects-e2e.html?scenario=edit-in-fork";
  await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(url);
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();

  const edit = page.getByRole("button", { name: "Edit as a New Turn" });
  await expect(edit).toHaveCount(2);

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("offline"));
  await expect(edit).toHaveCount(0);
  // Every message keeps it, in its own menu and in its turn's menu, disabled with the reason.
  for (const menuName of ["More Message Actions", "More Turn Actions"]) {
    const triggers = page.getByRole("button", { name: menuName });
    const count = await triggers.count();
    expect(count, menuName).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      const trigger = triggers.nth(index);
      await trigger.hover({ force: true });
      await trigger.click({ force: true });
      const item = page.getByRole("menu", { name: menuName }).getByRole("menuitem", { name: "Edit as a New Turn" });
      await expect(item).toBeDisabled();
      await expect(item).toHaveAccessibleDescription("Runner is offline.");
      await item.click({ force: true });
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
  }

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("online"));
  await expect(edit).toHaveCount(2);
  await edit.last().click({ force: true });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Load into Composer" })).toBeEnabled();

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("offline"));
  await expect(dialog.getByText("Runner is offline.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Load into Composer" })).toBeDisabled();
});
