import type { Page } from "@playwright/test";

/**
 * Choose a page header secondary wherever the header's width put it (#1801, §3.3): a button while
 * it fits, otherwise an item in the header's ⋯ menu. An item of a menu-button secondary (#1947)
 * names that button as `menu`: while the button shows, the item is in its menu; once it folds, the
 * item is in ⋯ on its own.
 */
export async function choosePageAction(page: Page, name: string, menu?: string): Promise<void> {
  const header = page.locator(".page-header");
  const button = header.getByRole("button", { name: menu ?? name, exact: true });
  if (await button.isVisible()) {
    await button.click();
    if (menu) await page.getByRole("menu", { name: menu }).getByRole("menuitem", { name, exact: true }).click();
    return;
  }
  await header.getByRole("button", { name: "More Actions", exact: true }).click();
  await page.getByRole("menu", { name: "More Actions" }).getByRole("menuitem", { name, exact: true }).click();
}
