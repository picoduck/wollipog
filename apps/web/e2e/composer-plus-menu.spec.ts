import { waitForSessionPreview } from "./session-readiness.js";
import { devices, expect, test, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";

/**
 * The composer's + button as one plain Attach and Settings menu (#2203): where it opens on a desktop,
 * and Reference a File… opening the @ picker in one tap on a phone.
 */

const phone = devices["Pixel 7"];
const MENU = "Attach and Settings";

test("at 1440×900 the menu opens above +, from its left edge, inside the viewport and without scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/session-usage-e2e.html?width=1440&height=900&composer=orchestrator");
  const plus = page.getByRole("button", { name: MENU });
  await expect(plus).toHaveAttribute("title", MENU);
  await plus.click();
  const menu = page.getByRole("menu", { name: MENU });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Orchestrator Controls…" })).toBeVisible();

  const [trigger, surface] = await Promise.all([plus.boundingBox(), menu.boundingBox()]);
  expect(surface!.y + surface!.height, "the menu sits above +").toBeLessThanOrEqual(trigger!.y);
  expect(Math.abs(surface!.x - trigger!.x), "and starts at its left edge").toBeLessThanOrEqual(1);
  expect(surface!.y).toBeGreaterThanOrEqual(0);
  expect(surface!.x + surface!.width).toBeLessThanOrEqual(1440);
  const overflow = await menu.evaluate((element) => element.scrollHeight - element.clientHeight);
  expect(overflow, "every row is in view without scrolling").toBeLessThanOrEqual(0);
});

test.describe("on a phone", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    userAgent: phone.userAgent,
    deviceScaleFactor: phone.deviceScaleFactor,
  });

  async function openSession(page: Page) {
    await page.goto("/command-inbox-projects-e2e.html");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const expand = page.getByRole("button", { name: "Open Session", exact: true });
    await waitForSessionPreview(page);
    if (await expand.isVisible()) await expand.click();
    await expect(page.locator(".composer-input")).toBeEnabled();
  }

  test("the menu is the bottom sheet with 44px rows", async ({ page }) => {
    await openSession(page);
    await page.getByRole("button", { name: MENU }).tap();
    const menu = page.getByRole("menu", { name: MENU });
    await expect(menu).toBeVisible();
    await expect(menu.locator(".menu-head")).toHaveText(MENU);
    await dialogMotionSettled(page);
    const heights = await menu.locator(".menu-item").evaluateAll((rows) =>
      rows.map((row) => row.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(0);
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
    const box = await menu.boundingBox();
    expect(Math.round(box!.y + box!.height), "docked to the bottom").toBeGreaterThanOrEqual(843);
    expect(await menu.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(0);
  });

  test("one tap on Reference a File… types @ at the caret and opens the @ picker in the focused composer", async ({ page }) => {
    await openSession(page);
    const composer = page.locator(".composer-input");
    // The idle phone composer is a capsule; tapping its preview expands and focuses it.
    await page.locator(".composer-idle-preview").tap();
    await composer.fill("look at");
    await expect(composer).toBeFocused();

    await page.getByRole("button", { name: MENU }).tap();
    await page.getByRole("menuitem", { name: "Reference a File…" }).tap();

    await expect(page.getByRole("menu", { name: MENU })).toHaveCount(0);
    await expect(composer).toHaveValue("look at @");
    await expect(composer).toBeFocused();
    expect(await composer.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(9);
    // The @ picker, before a query: it asks for a file or folder name.
    await expect(composer).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".picker .picker-empty")).toContainText("Type a file or folder name.");
  });
});
