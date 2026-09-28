import { expect, test, type Page } from "@playwright/test";

/**
 * #1990 (docs/design-system.md §13.1): on a phone an open menu hides the toast stack, and while it
 * is hidden no toast may expire. Each hidden toast reappears when the menu closes and then dismisses
 * after the time it had left. Measured in the real Shell against the shared menu primitive (the
 * rail's More Destinations sheet), with the page clock driving every timer.
 */

const SHELL = "/command-inbox-projects-e2e.html?fullShell=1";
const MORE_SHEET = '.menu[aria-label="More Destinations"]';

test.use({ reducedMotion: "reduce", viewport: { width: 390, height: 844 } });

// An installed clock keeps running in real time until it is paused, so every click and assertion
// would spend the toast's remaining time; on a loaded runner that alone expired it (#2003). The page
// clock therefore starts at a fixed instant and pauses at a fixed target a minute later. The target is
// not read from the page, so no delay between commands can put it in the past: the test's own
// 30-second timeout ends long before a minute of real time passes.
const CLOCK_START = new Date("2026-01-01T12:00:00Z");
const CLOCK_PAUSED_AT = new Date(CLOCK_START.getTime() + 60_000);

async function open(page: Page) {
  await page.clock.install({ time: CLOCK_START });
  await page.goto(SHELL);
  await expect(page.locator(".app-rail")).toBeVisible();
  await page.waitForFunction(() => Boolean(window.__WOLLIPOG_TOASTS_E2E__));
  // Paused, the page's time moves only through runFor, and the remaining-time checks are exact.
  await page.clock.pauseAt(CLOCK_PAUSED_AT);
}

async function show(page: Page, message: string) {
  await page.evaluate((text) => window.__WOLLIPOG_TOASTS_E2E__!.show(text), message);
}

test("at 390px a toast raised under an open menu outlasts it and then runs out its remaining time", async ({ page }) => {
  await open(page);
  await page.locator(".rail-more-trigger").click();
  await expect(page.locator(MORE_SHEET)).toBeVisible();

  await show(page, "Saved.");
  const toast = page.locator(".toast-region > .toast", { hasText: "Saved." });
  await expect(toast).toBeHidden();
  await expect(page.locator(".toast-region")).toHaveClass(/under-menu/);

  // Well past the info toast's five seconds, with the menu still open.
  await page.clock.runFor(6_000);
  await expect(page.locator(".toast-region > .toast")).toHaveCount(1);

  await page.locator(".menu-backdrop").click();
  await expect(page.locator(MORE_SHEET)).toHaveCount(0);
  await expect(toast).toBeVisible();

  // The pause took nothing away and restarted nothing: exactly five seconds, then gone.
  await page.clock.runFor(4_999);
  await expect(toast).toBeVisible();
  await page.clock.runFor(1);
  await expect(page.locator(".toast-region > .toast")).toHaveCount(0);
});
