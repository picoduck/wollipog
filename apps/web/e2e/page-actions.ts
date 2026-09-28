import type { Page } from "@playwright/test";

/**
 * Choose a page header secondary wherever the header's width put it (#1801, §3.3): a button while
 * it fits, otherwise an item in the header's ⋯ menu.
 */
export async function choosePageAction(page: Page, name: string): Promise<void> {
  const header = page.locator(".page-header");
  const button = header.getByRole("button", { name, exact: true });
  if (await button.isVisible()) {
    await button.click();
    return;
  }
  await header.getByRole("button", { name: "More Actions", exact: true }).click();
  await page.getByRole("menu", { name: "More Actions" }).getByRole("menuitem", { name, exact: true }).click();
}
