import { expect, test } from "@playwright/test";

/**
 * #2949: a confirmation chosen from the shared ⋯ (docs/design-system.md §7.5) in a real browser. On a
 * phone it replaces the ⋯ sheet, with Back to More Actions, and Back brings the sheet back with focus
 * on the item that was chosen; on desktop it stacks with no Back.
 */

for (const theme of ["dark", "light"] as const) {
  test(`${theme} at 390px: the confirmation replaces the ⋯ sheet, and Back reopens it on the chosen item`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/primitives-e2e.html?view=actions-menu&theme=${theme}`);
    const sheet = page.getByRole("menu", { name: "More Actions" });
    const dialog = page.getByRole("dialog", { name: "Delete Automation" });

    await page.getByRole("button", { name: "More Actions" }).click();
    await expect(sheet).toBeVisible();
    await sheet.getByRole("menuitem", { name: "Delete Automation…" }).click();
    await expect(dialog).toBeVisible();
    await expect(sheet).toHaveCount(0);

    await dialog.getByRole("button", { name: "Back to More Actions" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("menuitem", { name: "Delete Automation…" })).toBeFocused();
    await expect(page.locator("[data-confirmation-answers]")).toHaveText("false");
  });

  test(`${theme} at 1440px: the confirmation stacks and draws no Back`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/primitives-e2e.html?view=actions-menu&theme=${theme}`);
    await page.getByRole("button", { name: "More Actions" }).click();
    await page.getByRole("menu", { name: "More Actions" }).getByRole("menuitem", { name: "Delete Automation…" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Automation" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Back to More Actions" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("[data-confirmation-answers]")).toHaveText("false");
  });
}
