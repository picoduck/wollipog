import { expect, test } from "@playwright/test";

for (const width of [390, 1440]) {
  test(`full shell closes permission layers one Escape at a time at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/command-inbox-projects-e2e.html?scenario=permission-mode-layout&fullShell=1");
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const expand = page.getByRole("button", { name: "Expand Session" });
    if (await expand.isVisible()) await expand.click();
    await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([], ["default", "acceptEdits", "bypassPermissions"]));
    const trigger = page.locator(".cbar-trigger").filter({ has: page.locator(".cbar-approvals") });
    await trigger.click();
    const menu = page.locator(".permission-mode-pop");
    const selected = await menu.getByRole("menuitemradio", { checked: true }).textContent();
    const details = menu.getByRole("menuitem").first();
    await details.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(menu).toBeVisible();
    await expect(details).toBeFocused();
    await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveText(selected!);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveText(selected!);
  });
}
