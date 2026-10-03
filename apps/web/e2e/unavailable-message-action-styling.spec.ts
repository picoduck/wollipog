import { expect, test, type Page } from "@playwright/test";

async function openOfflineMessageMenu(page: Page, theme: "dark" | "light") {
  await page.setViewportSize({ width: 1280, height: 900 });
  const url = "/command-inbox-projects-e2e.html?scenario=edit-in-fork";
  await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(url);
  await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.setRunnerStatus("offline"));
  // The second message is the one with an earlier checkpoint, so it lists Edit in a Fork.
  const bubble = page.locator(".tl-row.user").last();
  await bubble.hover();
  await bubble.getByRole("button", { name: "More Message Actions" }).click();
  return page.getByRole("menu", { name: "More Message Actions" });
}

for (const theme of ["dark", "light"] as const) {
  test(`unavailable message actions are disabled menu items that say why (${theme})`, async ({ page }) => {
    const menu = await openOfflineMessageMenu(page, theme);
    const copy = menu.getByRole("menuitem", { name: "Copy Message" });
    const resend = menu.getByRole("menuitem", { name: "Edit as a New Turn" });
    const editInFork = menu.getByRole("menuitem", { name: "Edit in a Fork…" });
    await expect(copy).toBeEnabled();
    await expect(copy).toBeFocused();
    for (const [item, reason] of [[resend, "Runner is offline."], [editInFork, "Reconnect the runner before creating a fork."]] as const) {
      await expect(item).toBeDisabled();
      await expect(item).toHaveAccessibleDescription(reason);
      await expect(item.locator(".menu-desc")).toHaveText(reason);
    }
    // One shared treatment: both unavailable rows paint their words faint and their reason dim.
    const paint = (item: typeof resend) => item.evaluate((element) => ({
      label: getComputedStyle(element).color,
      icon: getComputedStyle(element.querySelector(".menu-icon")!).color,
      reason: getComputedStyle(element.querySelector(".menu-desc")!).color,
      cursor: getComputedStyle(element).cursor,
      background: getComputedStyle(element).backgroundColor,
    }));
    const tokens = await page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      const read = (token: string) => { probe.style.color = `var(${token})`; return getComputedStyle(probe).color; };
      const result = { faint: read("--text-faint"), dim: read("--text-dim"), text: read("--text") };
      probe.remove();
      return result;
    });
    const atRest = await paint(resend);
    expect(atRest).toMatchObject({ label: tokens.faint, icon: tokens.faint, reason: tokens.dim, cursor: "not-allowed" });
    expect(await paint(editInFork)).toEqual(atRest);
    expect(await copy.evaluate((element) => getComputedStyle(element).color)).toBe(tokens.text);

    // Hover raises nothing under an unavailable row, and pressing it opens nothing.
    await resend.hover({ force: true });
    expect(await paint(resend)).toEqual(atRest);
    await resend.click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(menu).toBeVisible();

    // The arrow keys skip unavailable rows.
    await copy.focus();
    await page.keyboard.press("ArrowDown");
    await expect(copy).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });
}

test.describe("forced colors", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`unavailable message actions read as GrayText in forced colors (${theme})`, async ({ page }) => {
      await page.emulateMedia({ forcedColors: "active" });
      const menu = await openOfflineMessageMenu(page, theme);
      expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
      const grayText = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "GrayText";
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      for (const name of ["Edit as a New Turn", "Edit in a Fork…"]) {
        const item = menu.getByRole("menuitem", { name });
        const inks = await item.evaluate((element) => [element, element.querySelector(".menu-icon")!, element.querySelector(".menu-desc")!]
          .map((part) => getComputedStyle(part).color));
        expect(inks, `${name}: label, icon and reason`).toEqual([grayText, grayText, grayText]);
      }
      const enabled = await menu.getByRole("menuitem", { name: "Copy Message" }).evaluate((element) => getComputedStyle(element).color);
      expect(enabled).not.toBe(grayText);
    });
  }
});
