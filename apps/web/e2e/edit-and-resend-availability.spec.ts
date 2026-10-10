import { waitForSessionPreview } from "./session-readiness.js";
import { expect, test } from "@playwright/test";

test("an Edit as a New Turn that is temporarily blocked stays listed and says why (#1876)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const url = "/command-inbox-projects-e2e.html?scenario=edit-in-fork";
  await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(url);
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Open Session", exact: true });
  await waitForSessionPreview(page);
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
      await expect(item).toHaveAccessibleDescription("runner-1 is offline. You can send again when it reconnects.");
      await item.click({ force: true });
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
  }

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("online"));
  await expect(edit).toHaveCount(2);
  const copied = (await page.locator(".tl-row.user .bubble-text").last().textContent()) ?? "";
  await edit.last().click({ force: true });
  // #2185: no dialog. The message is in the composer and the notice slot says it is a copy.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".composer-input")).toHaveValue(copied);
  await expect(page.locator('.session-notice-slot[data-notice-key="editing-copy"]')).toContainText("Editing a copy of your Turn");
});
