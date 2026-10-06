import { expect, test, type Page } from "@playwright/test";

/**
 * Toast anatomy, placement and stacking (docs/design-system.md §13.1, §1.3): toasts sit at the
 * bottom and never cover the app bar; on a phone they sit above the tab bar or the composer and the
 * software keyboard (#280); three are visible on desktop and one on a phone, newest on top, and the
 * rest stay reachable behind "+N More".
 */

const SHELL = "/command-inbox-projects-e2e.html?fullShell=1";

// Geometry is read at rest: a toast enters with an 8px translate, which reduced motion removes.
test.use({ reducedMotion: "reduce" });

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: width < 760 ? 844 : 900 });
  await page.goto(SHELL);
  await expect(page.locator(".app-rail")).toBeVisible();
  await page.waitForFunction(() => Boolean(window.__WOLLIPOG_TOASTS_E2E__));
}

async function show(page: Page, message: string, options: Record<string, unknown> = {}) {
  await page.evaluate(({ message, options }) => window.__WOLLIPOG_TOASTS_E2E__!.show(message, options), { message, options });
}

const box = (page: Page, selector: string) => page.locator(selector).first().evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
});

test("a toast carries a tone icon and an icon close, and no coloured stripe", async ({ page }) => {
  await open(page, 1440);
  await show(page, "Session archived.", { tone: "success", durationMs: 0, detail: "It stays in Archived Sessions." });
  const toast = page.locator(".toast-region .toast");
  await expect(toast).toHaveCount(1);
  await expect(toast.locator(".toast-icon svg")).toBeVisible();
  await expect(toast.locator(".toast-detail")).toHaveText("It stays in Archived Sessions.");
  const close = toast.getByRole("button", { name: "Dismiss Notification" });
  await expect(close.locator("svg")).toBeVisible();
  await expect(close).not.toHaveText("×");
  const edges = await toast.evaluate((element) => {
    const style = getComputedStyle(element);
    return { left: style.borderLeftWidth, right: style.borderRightWidth, leftColor: style.borderLeftColor, rightColor: style.borderRightColor };
  });
  expect(edges.left).toBe(edges.right);
  expect(edges.leftColor).toBe(edges.rightColor);
  await close.click();
  await expect(toast).toHaveCount(0);
});

test("at 1440px the stack is anchored bottom right, clear of the app bar, three deep", async ({ page }) => {
  await open(page, 1440);
  // The oldest is a persistent recovery toast: it must stay reachable, however many arrive after it.
  await show(page, "Bulk archive partially completed.", { tone: "error", actionLabel: "Restore Sessions" });
  for (const index of [2, 3, 4, 5]) await show(page, `Notice ${index}`, { durationMs: 0 });

  const visible = page.locator(".toast-region > .toast");
  await expect(visible).toHaveCount(3);
  await expect(visible.first()).toContainText("Notice 5");
  const more = page.getByRole("button", { name: "+2 More" });
  await expect(more).toBeVisible();

  const region = await box(page, ".toast-region");
  const viewport = page.viewportSize()!;
  expect(viewport.width - region.right).toBeGreaterThanOrEqual(15.5);
  expect(viewport.width - region.right).toBeLessThanOrEqual(16.5);
  expect(viewport.height - region.bottom).toBeGreaterThanOrEqual(15.5);
  const bar = page.locator(".topbar, .session-bar").first();
  if (await bar.count()) {
    const barBox = await bar.evaluate((element) => element.getBoundingClientRect().bottom);
    const firstToast = await box(page, ".toast-region > .toast, .toast-region > .toast-more");
    expect(firstToast.top).toBeGreaterThan(barBox);
  }

  await more.click();
  const older = page.getByRole("list", { name: "Older Notifications" });
  await expect(older.locator(".toast")).toHaveCount(2);
  await expect(older.getByRole("button", { name: "Restore Sessions" })).toBeVisible();
});

test("at 390px one toast shows, above the tab bar, with the rest behind +N More", async ({ page }) => {
  await open(page, 390);
  for (const index of [1, 2, 3, 4, 5]) await show(page, `Notice ${index}`, { durationMs: 0 });
  await expect(page.locator(".toast-region > .toast")).toHaveCount(1);
  await expect(page.locator(".toast-region > .toast")).toContainText("Notice 5");
  await expect(page.getByRole("button", { name: "+4 More" })).toBeVisible();

  const toast = await box(page, ".toast-region > .toast");
  const rail = await box(page, ".app-rail");
  const clear = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--toast-clear"));
  expect(toast.bottom, `toast above the tab bar (--toast-clear ${clear})`).toBeLessThanOrEqual(rail.top - 0.5);
  expect(toast.left).toBeGreaterThanOrEqual(7.5);
  expect(390 - toast.right).toBeGreaterThanOrEqual(7.5);
});

test("at 390px in a session, a toast sits above the composer", async ({ page }) => {
  await open(page, 390);
  await page.getByRole("button", { name: /Alpha Session/ }).first().click();
  const expand = page.getByRole("button", { name: "Open Session", exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".composer")).toBeVisible();
  await show(page, "Session renamed.", { durationMs: 0 });
  const toast = page.locator(".toast-region > .toast");
  await expect(toast).toBeVisible();
  await expect.poll(async () => {
    const [toastBox, composer] = await Promise.all([box(page, ".toast-region > .toast"), box(page, ".composer")]);
    return composer.top - toastBox.bottom;
  }).toBeGreaterThanOrEqual(0);
});

test("a toast clears the software keyboard where only the visual viewport shrinks (#280)", async ({ page }) => {
  await open(page, 390);
  await show(page, "Attached image.", { durationMs: 0 });
  const before = await box(page, ".toast-region > .toast");
  // The inset installMobileViewportFallback publishes for an occluded band at the bottom.
  await page.evaluate(() => document.documentElement.style.setProperty("--keyboard-inset", "300px"));
  await expect.poll(async () => before.bottom - (await box(page, ".toast-region > .toast")).bottom).toBeGreaterThanOrEqual(299.5);
  const after = await box(page, ".toast-region > .toast");
  expect(after.bottom).toBeLessThanOrEqual(844 - 300);
});

test("a toast over a dialog clears the dialog's footer where they share a column", async ({ page }) => {
  // Toasts sit above dialogs. A desktop dialog's footer floats above the bottom edge, so it is not
  // docked chrome, but a toast in the same column would still cover its buttons.
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.goto(SHELL);
  await page.waitForFunction(() => Boolean(window.__WOLLIPOG_TOASTS_E2E__));
  await page.getByRole("tab", { name: /Alpha/ }).click();
  await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
  await page.getByRole("menuitem", { name: "New Session Here" }).click();
  await expect(page.getByRole("dialog", { name: "New Session" })).toBeVisible();
  await show(page, "Copied link to clipboard.", { durationMs: 0 });
  await expect(page.locator(".toast-region > .toast")).toBeVisible();
  const foot = await box(page, ".modal-foot");
  const toast = await box(page, ".toast-region > .toast");
  // The case under test: the footer sits in the lower half, clear of the bottom edge, in the
  // toast's column.
  expect(foot.top).toBeGreaterThan(760 / 2);
  expect(foot.bottom).toBeLessThan(760 - 2);
  expect(foot.right).toBeGreaterThan(toast.left);
  await expect.poll(async () => foot.top - (await box(page, ".toast-region > .toast")).bottom).toBeGreaterThanOrEqual(0);
});

test("an expanded stack above a dialog footer stays on screen and scrolls its older list", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(SHELL);
  await page.waitForFunction(() => Boolean(window.__WOLLIPOG_TOASTS_E2E__));
  await page.getByRole("tab", { name: /Alpha/ }).click();
  await page.getByRole("button", { name: "Project Actions for Alpha" }).click();
  await page.getByRole("menuitem", { name: "New Session Here" }).click();
  await expect(page.getByRole("dialog", { name: "New Session" })).toBeVisible();
  for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    await show(page, `Bulk archive ${index} partially completed. Some sessions could not be archived.`, {
      tone: "error", actionLabel: "Restore Sessions",
    });
  }
  await page.getByRole("button", { name: "+7 More" }).click();
  const list = page.getByRole("list", { name: "Older Notifications" });
  await expect(list).toBeVisible();
  // Every part of the stack stays inside the viewport; the older list scrolls instead of growing.
  await expect.poll(async () => (await box(page, ".toast-region")).top).toBeGreaterThanOrEqual(0);
  expect((await box(page, ".toast-more-list")).top).toBeGreaterThanOrEqual(0);
  const scroll = await list.evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight }));
  expect(scroll.scroll).toBeGreaterThan(scroll.client);
});
