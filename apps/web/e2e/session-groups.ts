import { expect, type Page } from "@playwright/test";

/** The Sessions header: the group tab row, or on a phone the app bar (#2211). */
export const SESSIONS_HEADER = ".page-tabs .tabs-bar, .sessions-app-bar";

/** A phone has the Sessions app bar instead of the group tabs (#2211, §15.1). */
function isPhone(page: Page): Promise<boolean> {
  return page.evaluate(() => matchMedia("(max-width: 760px)").matches);
}

/** Selects a Sessions group: its tab, or on a phone the app bar's group picker. */
export async function chooseSessionGroup(page: Page, name: RegExp): Promise<void> {
  if (!await isPhone(page)) {
    await page.getByRole("tab", { name }).click();
    return;
  }
  const bar = page.locator(".sessions-app-bar");
  await expect(bar).toBeVisible();
  await bar.locator(".sessions-group-picker").click();
  await page.getByRole("menu", { name: "Session Groups" }).getByRole("menuitemradio", { name }).click();
}

/** Selects a project's group and opens its actions: ⋯ after its tab, or on a phone the app bar's ⋯. */
export async function openProjectActions(page: Page, name: RegExp, projectName: string): Promise<void> {
  await chooseSessionGroup(page, name);
  if (await isPhone(page)) await page.locator(".sessions-app-bar").getByRole("button", { name: "More Actions" }).click();
  else await page.getByRole("button", { name: `${projectName} Actions` }).click();
}
