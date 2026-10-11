import { waitForSessionPreview } from "./session-readiness.js";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";

const LONG_LABEL = "An Unusually Long Permission Mode Label That Must Wrap on a Phone";

async function openApprovals(page: Page, theme: string) {
  await page.goto("/command-inbox-projects-e2e.html?scenario=permission-mode-layout");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Open Session", exact: true });
  await waitForSessionPreview(page);
  if (await expand.isVisible()) await expand.click();
  await page.evaluate(({ theme, longLabel }) => {
    document.documentElement.dataset.theme = theme;
    window.__WOLLIPOG_PROJECT_INBOX_E2E__.setSlashCommands([], [
      "default", "acceptEdits", "bypassPermissions", longLabel,
    ]);
  }, { theme, longLabel: LONG_LABEL });
  const idlePreview = page.locator(".composer-idle-preview");
  if (await idlePreview.isVisible()) await idlePreview.click();
  const trigger = page.locator(".cbar-trigger").filter({ has: page.locator(".cbar-approvals") });
  await trigger.click();
  return trigger;
}

async function expectContained(target: Locator, container: Locator) {
  const box = await target.boundingBox();
  const bounds = await container.boundingBox();
  expect(box).not.toBeNull();
  expect(bounds).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(bounds!.x);
  expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 0.5);
  expect(box!.y).toBeGreaterThanOrEqual(bounds!.y);
  expect(box!.y + box!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 0.5);
}

/** No row is a two-control row, and nothing in the menu is drawn in the danger red (#2190). */
async function expectPlainRows(page: Page, menu: Locator) {
  await expect(menu.getByRole("menuitem")).toHaveCount(0);
  const radios = menu.getByRole("menuitemradio");
  await expect(radios).toHaveCount(5);
  expect(await menu.locator("button").count()).toBe(5);
  await expect(menu.getByRole("dialog")).toHaveCount(0);
  const red = await menu.evaluate((surface) => {
    const probe = document.createElement("span");
    surface.append(probe);
    // Every red ink the themes define; an undefined token would inherit and match ordinary text.
    const reds = new Set(["--danger-text", "--danger-bg", "--red"].map((token) => {
      if (!getComputedStyle(probe).getPropertyValue(token).trim()) throw new Error(`${token} is undefined`);
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    }));
    probe.remove();
    return [surface, ...surface.querySelectorAll<HTMLElement | SVGElement>("*")].flatMap((element) => {
      const style = getComputedStyle(element);
      const inks = [style.color, style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor];
      return inks.some((ink) => reds.has(ink)) ? [element.className.toString() || element.tagName] : [];
    });
  });
  expect(red, "no element in the permission menu is drawn in red").toEqual([]);
  // Full Access alone carries the amber shield; the others keep an empty, aligned icon slot.
  const risky = menu.locator(".menu-icon .permission-mode-risk");
  await expect(risky).toHaveCount(1);
  await expect(menu.getByRole("menuitemradio", { name: "Full Access (No Checks)" }).locator(".permission-mode-risk")).toHaveCount(1);
  const amber = await risky.evaluate((icon) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--amber)";
    icon.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { glyph: getComputedStyle(icon.querySelector("svg")!).color, expected };
  });
  expect(amber.glyph).toBe(amber.expected);
  // Every mode says what it means on a visible second line (this fixture is Codex App Server).
  for (const name of ["Default (Approve for Me)", "Ask Every Time", "Auto-Accept Edits", "Full Access (No Checks)", LONG_LABEL]) {
    await expect(menu.getByRole("menuitemradio", { name, exact: true }).locator(".menu-desc")).toBeVisible();
  }
  await expect(menu.getByRole("menuitemradio", { name: "Full Access (No Checks)" }))
    .toContainText("Everything runs with no command approvals. Use only in isolated environments.");
  // Approval delivery is unreported for every mode here: one note, last, names the modes that ask.
  const note = menu.locator(".menu-note");
  await expect(note).toHaveCount(1);
  await expect(note).toHaveText(
    `Wollipog hasn't confirmed that approval prompts from Default (Approve for Me), Ask Every Time, Auto-Accept Edits, and ${LONG_LABEL} reach you here.`,
  );
  expect(await note.evaluate((element) => element === element.parentElement!.lastElementChild)).toBe(true);
}

for (const width of [320, 390]) {
  for (const theme of ["light", "dark"]) {
    test.describe(`${width}px ${theme}`, () => {
      test.use({ viewport: { width, height: 844 }, hasTouch: true });

      test("each mode is one 44px row inside the phone sheet with its meaning and one note", async ({ page }, testInfo) => {
        const trigger = await openApprovals(page, theme);
        // On a phone every menu is a bottom sheet with the dialog sheet's grabber (§9.2, #1803), so
        // it spans the screen and docks to its bottom edge instead of floating inside the composer.
        const popover = page.locator('.menu[aria-label="Permission Mode"]');
        await expect(popover).toBeVisible();
        await expect(popover.locator(".sheet-grabber")).toBeVisible();
        await dialogMotionSettled(page);
        const viewport = page.viewportSize()!;
        const sheet = (await popover.boundingBox())!;
        expect(sheet.x).toBeGreaterThanOrEqual(0);
        expect(sheet.x + sheet.width).toBeLessThanOrEqual(viewport.width + 0.5);
        expect(Math.abs(sheet.y + sheet.height - viewport.height)).toBeLessThanOrEqual(1);
        await expectPlainRows(page, popover);
        const rows = popover.getByRole("menuitemradio");
        for (let index = 0; index < await rows.count(); index++) {
          const row = rows.nth(index);
          await row.scrollIntoViewIfNeeded();
          await expectContained(row, popover);
          expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
          // Check both edges: a partially clipped row can still pass
          // Playwright's ordinary centre-point actionability check.
          expect(await row.evaluate((element) => {
            const r = element.getBoundingClientRect();
            return [r.left + 1, r.left + r.width / 2, r.right - 1].every((x) =>
              element.contains(document.elementFromPoint(x, r.top + r.height / 2)));
          })).toBe(true);
        }
        await popover.locator(".menu-note").scrollIntoViewIfNeeded();
        await expectContained(popover.locator(".menu-note"), popover);
        const longLabel = popover.locator(".menu-text").last();
        expect(await longLabel.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(30);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await page.screenshot({ path: testInfo.outputPath(`after-${width}-${theme}.png`) });

        // A tap chooses the mode and closes the sheet, as before.
        const choice = popover.getByRole("menuitemradio", { name: "Auto-Accept Edits", exact: true });
        await choice.scrollIntoViewIfNeeded();
        await choice.tap();
        await expect(popover).toHaveCount(0);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await trigger.tap();
        await expect(popover.getByRole("menuitemradio", { checked: true })).toHaveAccessibleName("Auto-Accept Edits");
      });
    });
  }
}

test("desktop sizing, upward placement, keyboard traversal, focus return and selection", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const trigger = await openApprovals(page, "dark");
  const menu = page.locator('.menu[aria-label="Permission Mode"]');
  await expect(menu).toBeVisible();
  await dialogMotionSettled(page);
  // A menu is at most 320px wide (§9.1), and this one fills it with its descriptions.
  expect((await menu.boundingBox())!.width).toBe(320);
  // It opens upward from the shield in the composer bar.
  expect((await menu.boundingBox())!.y + (await menu.boundingBox())!.height)
    .toBeLessThanOrEqual((await trigger.boundingBox())!.y + 0.5);
  await expectPlainRows(page, menu);
  const radios = menu.getByRole("menuitemradio");
  await page.keyboard.press("Home");
  await expect(radios.first()).toBeFocused();
  // Arrows move from mode to mode: no row holds a second stop.
  await page.keyboard.press("ArrowDown");
  await expect(radios.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(radios.nth(2)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const choice = menu.getByRole("menuitemradio").nth(1);
  const label = await choice.locator(".menu-text").textContent();
  await choice.click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveAccessibleName(label!);
  await expect(menu.getByRole("menuitemradio", { checked: true }).locator(".menu-check")).toBeVisible();
});
