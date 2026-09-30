import { expect, test, type Locator, type Page } from "@playwright/test";
import { instanceStorageKey } from "../src/instance-storage.js";
import { RAIL_PREFERENCES_STORAGE_KEY } from "../src/rail-preferences.js";
import { dialogMotionSettled } from "./dialog-motion.js";
import { expectGeometry } from "./geometry-margins.js";

/**
 * The labelled phone tab bar and the More sheet (#1959, docs/design-system.md §15.1, §5.2, §7.5).
 * Measured on the real Rail and stylesheet in the mobile-viewport harness, whose `onNavigate`
 * moves the current view the way production's router does.
 */

const MORE_SHEET = '.menu[aria-label="More Destinations"]';
const TABS = ".rail-destinations > .rail-item, .rail-more > .rail-item";

// A touch phone: no hover, a coarse pointer, and the density of a current device.
test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 3,
  reducedMotion: "reduce",
});

async function open(page: Page, { theme = "dark", view = "inbox" } = {}) {
  await page.goto(`/mobile-viewport-e2e.html?theme=${theme}&view=${view}&connections=1`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator(".app-rail")).toBeVisible();
}

async function openMore(page: Page) {
  await page.locator(".rail-more-trigger").tap();
  await expect(page.locator(MORE_SHEET)).toBeVisible();
  await dialogMotionSettled(page);
}

/** A token resolved to the computed colour the browser paints, so it compares with getComputedStyle. */
async function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

const style = (locator: Locator, property: string, pseudo?: string) =>
  locator.evaluate((element, [name, which]) => getComputedStyle(element, which ?? null).getPropertyValue(name!), [property, pseudo]);

/**
 * A computed style once it has settled. Reduced motion keeps a 1ms transition so transitionend still
 * fires, so a colour read in the same task as the class change can be mid-transition.
 */
const expectStyle = (locator: Locator, property: string, expected: string, message?: string) =>
  expect.poll(() => style(locator, property), { message }).toBe(expected);

const box = async (locator: Locator) => (await locator.boundingBox())!;

const TRANSPARENT = "rgba(0, 0, 0, 0)";

for (const theme of ["dark", "light"] as const) {
  test(`the bar is four labelled destinations and More, with a pill on the current tab (${theme})`, async ({ page }) => {
    await open(page, { theme });
    expect(await page.evaluate(() => matchMedia("(hover: hover)").matches), "a touch phone cannot hover").toBe(false);

    const tabs = page.locator(TABS);
    await expect(tabs.locator(".rail-tab-label")).toHaveText(["Sessions", "Projects", "Connections", "Automations", "More"]);
    for (let index = 0; index < 5; index += 1) {
      const tab = tabs.nth(index);
      const icon = await box(tab.locator(".rail-tab-pill svg"));
      const label = await box(tab.locator(".rail-tab-label"));
      expect(Math.round(icon.width), "a 24px icon").toBe(24);
      expectGeometry(label.y - (icon.y + icon.height), "the label sits under the icon").toBeGreaterThanOrEqual(0);
      // Title Case labels that fit a 390px bar in full.
      expect(await tab.locator(".rail-tab-label").evaluate((element) => element.scrollWidth <= element.clientWidth))
        .toBe(true);
    }

    // 56px, plus a bottom safe area this browser reports as 0.
    const rail = await box(page.locator(".app-rail"));
    expect(Math.round(rail.height)).toBe(56);
    expect(Math.round(rail.y + rail.height)).toBe(844);

    const current = tabs.first();
    await expect(current).toHaveAttribute("aria-current", "page");
    const pill = current.locator(".rail-tab-pill");
    const pillBox = await box(pill);
    expect([Math.round(pillBox.width), Math.round(pillBox.height)], "a 56×28 pill").toEqual([56, 28]);
    expect(await style(pill, "background-color")).toBe(await tokenColor(page, "--surface-selected"));
    const accent = await tokenColor(page, "--accent");
    expect(await style(current, "color"), "an accent icon and label").toBe(accent);
    expect(await style(current, "content", "::before"), "nothing is drawn below the icon").toBe("none");
    for (let index = 1; index < 5; index += 1) {
      expect(await style(tabs.nth(index).locator(".rail-tab-pill"), "background-color")).toBe(TRANSPARENT);
    }
  });
}

test("experiments and a hidden default tab do not hand the bar to an experiment", async ({ page }) => {
  // The harness turns every experiment on; hiding Projects then fills its slot, in place, with the
  // next visible non-experimental destination in rail order.
  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ v: 1, order: [], hidden: ["projects"] }));
  }, instanceStorageKey(RAIL_PREFERENCES_STORAGE_KEY));
  await open(page);
  await expect(page.locator(TABS).locator(".rail-tab-label"))
    .toHaveText(["Sessions", "Agent Skills", "Connections", "Automations", "More"]);
  await expect(page.locator(TABS).nth(1)).toHaveAttribute("aria-label", "Agent Skills");
});

test("a tap through More leaves More current with no ring and no hover fill", async ({ page }) => {
  await open(page);
  await openMore(page);
  await page.locator(`${MORE_SHEET} .menu-item`, { hasText: "Usage and Cost" }).tap();
  await expect(page.locator(MORE_SHEET)).toHaveCount(0);
  await expect(page.locator(".topbar h1")).toHaveText("Usage and Cost");

  const more = page.locator(".rail-more-trigger");
  await expect(more).toHaveAttribute("aria-current", "page");
  await expect(more).toHaveClass(/\bactive\b/);
  await expectStyle(more.locator(".rail-tab-pill"), "background-color", await tokenColor(page, "--surface-selected"));
  // Focus stayed off More, so there is no ring, and the tab behind the finger keeps no fill.
  expect(await more.evaluate((element) => document.activeElement === element)).toBe(false);
  expect(await more.evaluate((element) => element.matches(":focus-visible"))).toBe(false);
  await expectStyle(more, "outline-style", "none");
  await expectStyle(more, "background-color", TRANSPARENT);
  await expect(page.locator(TABS).first()).not.toHaveAttribute("aria-current", "page");

  // A tapped tab leaves no fill behind when the next one is tapped.
  const projects = page.locator(TABS).nth(1);
  await projects.tap();
  await page.locator(TABS).first().tap();
  await expect(page.locator(".topbar h1")).toHaveText("Sessions");
  await expectStyle(projects, "background-color", TRANSPARENT);
  await expectStyle(projects.locator(".rail-tab-pill"), "background-color", TRANSPARENT);
});

for (const theme of ["dark", "light"] as const) {
  test(`More is a sheet with a scrim, a title, a Close button and one current-row treatment (${theme})`, async ({ page }) => {
    await open(page, { theme, view: "usage" });
    await openMore(page);
    const sheet = page.locator(MORE_SHEET);

    expect(await style(page.locator(".menu-backdrop"), "background-color"), "the page is dimmed").not.toBe(TRANSPARENT);
    const grabber = await box(sheet.locator(".sheet-grabber"));
    expect([Math.round(grabber.width), Math.round(grabber.height)]).toEqual([36, 4]);
    await expect(sheet.locator(".menu-head-title")).toHaveText("More");
    const close = await box(sheet.getByRole("menuitem", { name: "Close More" }));
    expect([Math.round(close.width), Math.round(close.height)], "a 44px Close").toEqual([44, 44]);
    // Opened by a tap, the sheet holds focus itself: nothing inside is ringed.
    expect(await sheet.evaluate((element) => document.activeElement === element)).toBe(true);
    expect(await style(sheet, "outline-color")).toBe(TRANSPARENT);

    const rows = sheet.locator(".menu-item");
    await expect(rows.locator(".menu-text"))
      .toHaveText(["Multi-Agent Runs", "Pods", "Agent Skills", "Archived Sessions", "Usage and Cost", "Settings"]);
    const surfaceSelected = await tokenColor(page, "--surface-selected");
    const accent = await tokenColor(page, "--accent");
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      expect(Math.round((await box(row)).height), "48px rows").toBe(48);
      expect(Math.round((await box(row.locator(".menu-icon svg"))).width), "20px icons").toBe(20);
      const isCurrent = (await row.getAttribute("aria-current")) === "page";
      expect(isCurrent).toBe(index === 4);
      if (isCurrent) {
        expect(await style(row, "background-color")).toBe(surfaceSelected);
        expect(await style(row, "box-shadow"), "a 2px accent bar on the leading edge").toBe(`${accent} 2px 0px 0px 0px inset`);
        expect(await style(row.locator(".menu-icon"), "color")).toBe(accent);
        expect(await style(row, "outline-style"), "no ring after a tap").toBe("none");
      } else {
        expect(await style(row, "background-color")).toBe(TRANSPARENT);
      }
    }

    // Settings is last, after a separator that spans the sheet with 8px above and below.
    const separator = await box(sheet.locator('[role="separator"]'));
    const sheetBox = await box(sheet);
    expectGeometry(Math.abs(separator.width - sheetBox.width), "the separator spans the sheet").toBeLessThanOrEqual(0.61);
    const above = await box(rows.nth(4));
    const below = await box(rows.nth(5));
    expectGeometry(Math.abs(separator.y - (above.y + above.height) - 8), "8px above").toBeLessThanOrEqual(0.61);
    expectGeometry(Math.abs(below.y - (separator.y + separator.height) - 8), "8px below").toBeLessThanOrEqual(0.61);

    await sheet.getByRole("menuitem", { name: "Close More" }).tap();
    await expect(sheet).toHaveCount(0);
    expect(await page.locator(".rail-more-trigger").evaluate((element) => document.activeElement === element)).toBe(false);
  });
}

test("from the keyboard, Escape returns focus to More with a ring and the keys rove the rows", async ({ page }) => {
  await open(page);
  const more = page.locator(".rail-more-trigger");
  await more.focus();
  await page.keyboard.press("Enter");
  const sheet = page.locator(MORE_SHEET);
  await expect(sheet).toBeVisible();
  const focused = () => page.evaluate(() =>
    document.activeElement?.querySelector(".menu-text")?.textContent ?? document.activeElement?.getAttribute("aria-label"));

  await page.keyboard.press("End");
  expect(await focused()).toBe("Settings");
  await page.keyboard.press("Home");
  expect(await focused()).toBe("Close More");
  await page.keyboard.press("ArrowDown");
  expect(await focused()).toBe("Multi-Agent Runs");
  await page.keyboard.press("ArrowDown");
  expect(await focused()).toBe("Pods");

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(more).toBeFocused();
  expect(await more.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  await expectStyle(more, "outline-style", "solid", "a visible ring");
  expect(await style(more, "outline-color")).not.toBe(TRANSPARENT);
});

test.describe("on a phone on its side", () => {
  test.use({ viewport: { width: 568, height: 320 } });

  test("every More row, Settings included, is visible without scrolling", async ({ page }) => {
    await open(page);
    await openMore(page);
    const sheet = page.locator(MORE_SHEET);
    await expect(sheet).toHaveClass(/\btwo-column\b/);
    expect(await sheet.evaluate((element) => element.scrollHeight <= element.clientHeight), "the sheet does not scroll")
      .toBe(true);
    const sheetBox = await box(sheet);
    const rows = sheet.locator(".menu-item");
    expect(await rows.count()).toBe(6);
    for (let index = 0; index < 6; index += 1) {
      const row = await box(rows.nth(index));
      expectGeometry(row.y - sheetBox.y, "inside the sheet's top").toBeGreaterThanOrEqual(0);
      expectGeometry(sheetBox.y + sheetBox.height - (row.y + row.height), "inside the sheet's bottom").toBeGreaterThanOrEqual(0);
      expectGeometry(320 - (row.y + row.height), "on screen").toBeGreaterThanOrEqual(0);
    }
    await expect(rows.last().locator(".menu-text")).toHaveText("Settings");
  });
});

test.describe("at 760px", () => {
  test.use({ viewport: { width: 760, height: 900 } });

  test("the tabs keep a 480px centered measure", async ({ page }) => {
    await open(page);
    const tabs = page.locator(TABS);
    const first = await box(tabs.first());
    const last = await box(tabs.last());
    const left = first.x;
    const right = last.x + last.width;
    expectGeometry(Math.abs(right - left - 480), "the five tabs span 480px").toBeLessThanOrEqual(0.61);
    expectGeometry(Math.abs((left + right) / 2 - 380), "centered on the bar").toBeLessThanOrEqual(0.61);
  });
});
