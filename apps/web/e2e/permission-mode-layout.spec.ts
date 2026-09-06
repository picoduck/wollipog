import { expect, test, type Locator, type Page } from "@playwright/test";

async function openApprovals(page: Page, theme: string) {
  await page.goto("/command-inbox-projects-e2e.html?scenario=permission-mode-layout");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await page.evaluate((theme) => {
    document.documentElement.dataset.theme = theme;
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([], [
      "default", "acceptEdits", "bypassPermissions",
      "An Unusually Long Permission Mode Label That Must Wrap on a Phone",
    ]);
  }, theme);
  const trigger = page.locator(".cbar-trigger").filter({ has: page.locator(".cbar-approvals") });
  await trigger.click();
  return trigger;
}

async function expectContained(target: Locator, container: Locator, horizontalOnly = false) {
  const box = await target.boundingBox();
  const bounds = await container.boundingBox();
  expect(box).not.toBeNull();
  expect(bounds).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(bounds!.x);
  expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 0.5);
  if (!horizontalOnly) {
    expect(box!.y).toBeGreaterThanOrEqual(bounds!.y);
    expect(box!.y + box!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 0.5);
  }
}

for (const width of [320, 390]) {
  for (const theme of ["light", "dark"]) {
    test.describe(`${width}px ${theme}`, () => {
      test.use({ viewport: { width, height: 844 }, hasTouch: true });

      test("permission details stay inside the pane and open without selecting", async ({ page }, testInfo) => {
        await openApprovals(page, theme);
        const popover = page.locator(".permission-mode-pop");
        const pane = page.locator(".main-body.inbox-main-body");
        await expect(popover).toBeVisible();
        await expectContained(popover, pane);
        await expectContained(popover, page.locator(".composer-bar"), true);
        const selected = await popover.getByRole("menuitemradio", { checked: true }).textContent();
        const details = popover.getByRole("menuitem");
        expect(await details.count()).toBeGreaterThan(3);
        for (let index = 0; index < await details.count(); index++) {
          const action = details.nth(index);
          await expectContained(action, pane);
          await expectContained(action, popover);
          // Check both edges: a partially clipped button can still pass
          // Playwright's ordinary centre-point actionability check.
          expect(await action.evaluate((element) => {
            const r = element.getBoundingClientRect();
            return [r.left + 1, r.left + r.width / 2, r.right - 1].every((x) =>
              element.contains(document.elementFromPoint(x, r.top + r.height / 2)));
          })).toBe(true);
          await action.tap();
          await expect(page.getByRole("dialog")).toBeVisible();
          await expect(popover).toBeVisible();
          await expect(popover.getByRole("menuitemradio", { checked: true })).toHaveText(selected!);
          await page.keyboard.press("Escape");
          await expect(page.getByRole("dialog")).toHaveCount(0);
          await expect(action).toBeFocused();
        }
        const longLabel = popover.locator(".cbar-permission-label").last();
        expect(await longLabel.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(30);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await page.screenshot({ path: testInfo.outputPath(`after-${width}-${theme}.png`) });
        // Synthetic lateral safe-area space: the containing bar must track
        // available pane width rather than assuming a full-width viewport.
        await pane.evaluate((element) => {
          element.style.paddingLeft = "20px";
          element.style.paddingRight = "20px";
        });
        await expectContained(popover, pane);
        await expectContained(popover, page.locator(".composer-bar"), true);
        for (const action of await details.all()) {
          await action.scrollIntoViewIfNeeded();
          await expectContained(action, popover);
          await expectContained(action, pane);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      });
    });
  }
}

test("desktop sizing, mouse disclosure, keyboard traversal, focus return and selection", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const trigger = await openApprovals(page, "dark");
  const menu = page.locator(".permission-mode-pop");
  expect((await menu.boundingBox())!.width).toBe(390);
  const details = menu.getByRole("menuitem").first();
  const selected = menu.getByRole("menuitemradio", { checked: true });
  const initial = await selected.textContent();
  await details.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(selected).toHaveText(initial!);
  await page.keyboard.press("Escape");
  await expect(details).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(selected).toHaveText(initial!);
  await page.keyboard.press("Escape");
  await expect(details).toBeFocused();
  await page.keyboard.press("Home");
  await expect(menu.getByRole("menuitemradio").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(details).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const choice = menu.getByRole("menuitemradio").nth(1);
  const label = await choice.locator(".cbar-permission-label").textContent();
  await choice.click();
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(menu.getByRole("menuitemradio", { checked: true })).toContainText(label!);
});
