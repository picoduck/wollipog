import { expect, test, type Page } from "@playwright/test";

/** Panel pages, the About popover and the panel notice slot (#2856), at the three widths. */
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, presentation: "docked" },
  { name: "compact", width: 834, height: 1112, presentation: "overlay" },
  { name: "phone", width: 390, height: 844, presentation: undefined },
] as const;
/** A capture once every opening animation (a popover's fade, a sheet's slide) has finished. */
async function shot(page: Page, name: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
  await page.screenshot({ path: `.agents/tmp/panel-pages/${name}.png` });
}

for (const viewport of VIEWPORTS) for (const theme of ["dark", "light"] as const) {
  test(`a row far down Agents opens its page and Back returns to it on ${viewport.name} ${theme}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/panel-pages-e2e.html?theme=${theme}`);
    const panel = page.getByRole("complementary", { name: "Side Panel" });
    if (viewport.presentation) await expect(panel).toHaveAttribute("data-presentation", viewport.presentation);
    const rows = panel.getByRole("list", { name: "Agents" }).getByRole("button");
    await expect(rows).toHaveCount(6);
    // Six are still running; History holds the other twenty-four.
    await panel.getByRole("radio", { name: /^All/ }).click();
    await expect(rows).toHaveCount(30);
    const last = rows.last();
    await last.scrollIntoViewIfNeeded();
    const body = panel.locator(".rpanel-body");
    const listScroll = await body.evaluate((element) => element.scrollTop);
    expect(listScroll).toBeGreaterThan(0);
    await shot(page, `${viewport.name}-${theme}-1-list`);

    await last.click();
    const title = panel.locator(".rpanel-page-title");
    await expect(title).toHaveText("Profile Payouts 30");
    await expect(title).toBeFocused();
    const back = panel.getByRole("button", { name: "Back to Agents", exact: true });
    await expect(back).toBeVisible();
    await expect(panel.locator(".rpanel-switcher")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Back to Session", exact: true })).toHaveCount(0);
    await expect(panel.locator(".subagent-detail")).toBeVisible();
    await shot(page, `${viewport.name}-${theme}-2-page`);

    await back.click();
    await expect(last).toBeFocused();
    await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(listScroll);
    await expect(panel.locator(".rpanel-switcher")).toBeVisible();
    await shot(page, `${viewport.name}-${theme}-3-returned`);

    // Escape pops a page as Back does, and on the list closes the panel.
    await last.click();
    await expect(title).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(last).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`the About popover and the panel notice slot on ${viewport.name} ${theme}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/panel-pages-e2e.html?theme=${theme}&extras=1`);
    const panel = page.getByRole("complementary", { name: "Side Panel" });
    const about = panel.getByRole("button", { name: "About Agents", exact: true });
    await expect(about).toHaveAttribute("title", "About Agents");
    await about.click();
    const dialog = page.getByRole("dialog", { name: "About Agents" });
    await expect(dialog).toBeVisible();
    const grabber = dialog.locator(".sheet-grabber");
    if (viewport.name === "phone") {
      await expect(grabber).toBeVisible();
      // A bottom sheet the width of the screen, measured once it has slid in (§7.5).
      await expect.poll(async () => {
        const box = (await dialog.boundingBox())!;
        return [Math.round(box.width), Math.round(box.y + box.height)];
      }).toEqual([viewport.width, viewport.height]);
    } else {
      await expect(grabber).toBeHidden();
      const [dialogBox, aboutBox] = [(await dialog.boundingBox())!, (await about.boundingBox())!];
      expect(dialogBox.y).toBeGreaterThan(aboutBox.y + aboutBox.height);
    }
    await shot(page, `${viewport.name}-${theme}-4-about`);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(about).toBeFocused();
    await expect(panel).toBeVisible();

    const slot = panel.locator(".rpanel-notices .panel-notice-slot");
    await expect(slot).toHaveAttribute("data-notice-key", "offline");
    await slot.getByRole("button", { name: "+2 More", exact: true }).click();
    const menu = page.getByRole("menu", { name: "Panel Notices" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Background Work Unavailable", "2 Workers Not Listed"]);
    await shot(page, `${viewport.name}-${theme}-5-notices`);
    await menu.getByRole("menuitem", { name: "2 Workers Not Listed" }).click();
    await expect(slot).toHaveAttribute("data-notice-key", "identity");
  });
}

test("the transcript's Open lands on that worker's page with its title focused", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/panel-pages-e2e.html");
  const panel = page.getByRole("complementary", { name: "Side Panel" });
  await expect(panel.getByRole("list", { name: "Agents" })).toBeVisible();
  await page.getByRole("button", { name: "Open Worker 27", exact: true }).click();
  const title = panel.locator(".rpanel-page-title");
  await expect(title).toHaveText("Review Ledger 27");
  await expect(title).toBeFocused();
  await panel.getByRole("button", { name: "Back to Agents", exact: true }).click();
  await expect(panel.locator('[data-panel-page-key="subagent:worker-27"]')).toBeFocused();
});
