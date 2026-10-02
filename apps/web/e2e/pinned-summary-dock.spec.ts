import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";

// The Pinned Summary takes its own space (#2147): a 280px column while the reader keeps 560px
// beside it, a drawer over the reader otherwise, and a bottom sheet on a phone. The fixture's
// transcript holds a table as wide as the reading column and two code blocks, the content the
// floating card used to cover.

const FIXTURE = "/command-inbox-projects-e2e.html?fullShell=1&scenario=pinned-summary";

async function openSession(page: Page, width: number, storage: Record<string, string> = {}) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript((values) => {
    // Seed storage on the first document only, so a reload inside a test keeps what the app wrote.
    if (sessionStorage.getItem("pinned-summary-seeded")) return;
    sessionStorage.setItem("pinned-summary-seeded", "1");
    localStorage.clear();
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
  }, storage);
  await page.goto(FIXTURE);
  await page.getByRole("button", { name: /Alpha Session/ }).first().click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".md table")).toBeVisible();
}

const toggle = (page: Page) => page.getByRole("button", { name: "Pinned Summary", exact: true });
const summary = (page: Page) => page.locator('aside.ps[aria-label="Pinned Summary"]');

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) throw new Error("element has no box");
  return { ...value, right: value.x + value.width, bottom: value.y + value.height };
}

/** The reader's width whenever the summary is docked, across a sweep of window widths. */
async function readerBesideDockedSummary(page: Page) {
  return page.evaluate(() => {
    const aside = document.querySelector<HTMLElement>("aside.ps");
    const reader = document.querySelector<HTMLElement>(".detail-chat")!.getBoundingClientRect();
    if (!aside) return { docked: false, reader: reader.width, side: true };
    const docked = aside.dataset.presentation === "docked";
    const rect = aside.getBoundingClientRect();
    return { docked, reader: reader.width, side: rect.left >= reader.right - 0.5 };
  });
}

test("at 1440px the docked summary covers neither the widest table nor any Copy Code button", async ({ page }) => {
  await openSession(page, 1440, { "wollipog.pinned.open": "1" });
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  const aside = summary(page);
  await expect(aside).toHaveAttribute("data-presentation", "docked");
  const asideBox = await box(aside);
  expect(Math.abs(asideBox.width - 280)).toBeLessThanOrEqual(0.5);

  const reader = await box(page.locator(".detail-scroll"));
  const table = page.locator(".md-table-wrap");
  await table.scrollIntoViewIfNeeded();
  const tableBox = await box(table);
  expect(tableBox.right, "the table ends before the summary begins").toBeLessThanOrEqual(asideBox.x + 0.5);
  expect(tableBox.right, "the table's last column is inside the reader").toBeLessThanOrEqual(reader.right + 0.5);

  const copies = page.getByRole("button", { name: "Copy Code", exact: true });
  expect(await copies.count()).toBe(2);
  for (const copy of await copies.all()) {
    await copy.scrollIntoViewIfNeeded();
    const copyBox = await box(copy);
    expect(copyBox.right, "Copy Code ends before the summary begins").toBeLessThanOrEqual(asideBox.x + 0.5);
    // Nothing paints over it: the button itself is the topmost element at its centre.
    const hit = await copy.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return top !== null && element.contains(top);
    });
    expect(hit, "Copy Code is the topmost element at its centre").toBe(true);
  }
});

test("at 1440px the summary is a 280px column that gives its width back when toggled off", async ({ page }) => {
  await openSession(page, 1440, { "wollipog.pinned.open": "1" });
  const reader = page.locator(".detail-chat");
  const body = await box(page.locator(".detail-body"));
  const open = await box(reader);
  expect(Math.abs(open.width + 280 - body.width)).toBeLessThanOrEqual(0.5);

  const centred = () => page.locator(".detail-scroll").evaluate((element) => {
    const style = getComputedStyle(element);
    return { left: style.paddingLeft, right: style.paddingRight };
  });
  const openPadding = await centred();
  expect(openPadding.left).toBe(openPadding.right);

  await toggle(page).click();
  await expect(summary(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  const closed = await box(reader);
  expect(Math.abs(closed.width - body.width)).toBeLessThanOrEqual(0.5);
  const closedPadding = await centred();
  expect(closedPadding.left).toBe(closedPadding.right);
  expect(await page.evaluate(() => localStorage.getItem("wollipog.pinned.open"))).toBe("0");
});

test("a wide right panel turns the summary into a drawer, and the reader never drops under 560px docked", async ({ page }) => {
  // 640px asks for more than the 40% window cap, so the panel takes 576px at 1440: the session
  // body is then too narrow to keep 560px of reader beside a 280px summary.
  await openSession(page, 1440, {
    "wollipog.pinned.open": "1",
    "wollipog.rightpanel.open": "1",
    "wollipog.rightpanel.width": "640",
  });
  await expect(page.locator(".right-panel")).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(summary(page)).toHaveCount(0);
  await toggle(page).click();
  await expect(summary(page)).toHaveAttribute("data-presentation", "drawer");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".ps-scrim")).toBeVisible();
  await expect(summary(page)).toBeFocused();
  const drawer = await box(summary(page));
  const panel = await box(page.locator(".right-panel"));
  expect(drawer.right, "the drawer opens from the reader's right edge").toBeLessThanOrEqual(panel.x + 0.5);
  await toggle(page).click();
  await expect(summary(page)).toHaveCount(0);

  // Sweep the window with the default panel open: wherever the summary docks, the reader keeps
  // 560px and the summary sits beside it.
  await page.evaluate(() => localStorage.setItem("wollipog.rightpanel.width", "380"));
  await page.reload();
  await page.getByRole("button", { name: /Alpha Session/ }).first().click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  let docked = 0;
  let drawers = 0;
  for (let width = 1100; width <= 1440; width += 20) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => readerBesideDockedSummary(page).then((value) => value.side)).toBe(true);
    const state = await readerBesideDockedSummary(page);
    if (state.docked) {
      docked += 1;
      expect(state.reader, `reader at a ${width}px window`).toBeGreaterThanOrEqual(560);
    } else {
      drawers += 1;
    }
  }
  expect(docked, "the sweep reaches the docked layout").toBeGreaterThan(0);
  expect(drawers, "the sweep reaches the drawer layout").toBeGreaterThan(0);
});

test("at 834px the toggle opens a drawer under the session bar that Escape closes, with the bar still live", async ({ page }) => {
  await openSession(page, 834, { "wollipog.pinned.open": "1" });
  await expect(summary(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");

  await toggle(page).click();
  const aside = summary(page);
  await expect(aside).toHaveAttribute("data-presentation", "drawer");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(aside).toBeFocused();
  const bar = await box(page.locator(".session-bar"));
  const drawer = await box(aside);
  expect(drawer.y, "the drawer starts under the session bar").toBeGreaterThanOrEqual(bar.bottom - 0.5);
  expect(Math.abs(drawer.width - 280)).toBeLessThanOrEqual(0.5);
  const scrim = await box(page.locator(".ps-scrim"));
  const reader = await box(page.locator(".detail-chat"));
  expect(scrim.x).toBeGreaterThanOrEqual(reader.x - 0.5);
  expect(scrim.y).toBeGreaterThanOrEqual(bar.bottom - 0.5);

  // The bar stays live: More Actions and Share open over the drawer, and Escape peels the menu
  // before the drawer.
  await page.getByRole("button", { name: "More Actions" }).click();
  await expect(page.getByRole("menu", { name: "More Actions" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "More Actions" })).toHaveCount(0);
  await expect(aside).toBeVisible();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /Share Transcript/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(aside).toBeVisible();

  await aside.focus();
  await page.keyboard.press("Escape");
  await expect(aside).toHaveCount(0);
  await expect(toggle(page)).toBeFocused();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  // Still in the session: the drawer took the Escape.
  await expect(page.locator(".md table")).toBeVisible();

  // The scrim closes it too, and the pressed toggle.
  await toggle(page).click();
  await expect(aside).toBeVisible();
  await page.locator(".ps-scrim").click({ position: { x: 20, y: 200 } });
  await expect(aside).toHaveCount(0);
  await expect(toggle(page)).toBeFocused();
  await toggle(page).click();
  await expect(aside).toBeVisible();
  await toggle(page).click();
  await expect(aside).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("wollipog.pinned.open")), "the drawer is not persisted").toBe("1");
});

test("at 390px the summary starts closed and opens as a bottom sheet with Close", async ({ page }) => {
  await openSession(page, 390, { "wollipog.pinned.open": "1" });
  await expect(summary(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");

  // The transcript scrolls in the whole pane; nothing nests a scroll box above it.
  const scroller = page.locator(".detail-scroll");
  const before = await scroller.evaluate((element) => {
    element.scrollTop = 0;
    return { scrollable: element.scrollHeight > element.clientHeight, top: element.scrollTop };
  });
  expect(before.scrollable).toBe(true);
  await scroller.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(before.top);

  await toggle(page).click();
  const sheet = page.getByRole("dialog", { name: "Pinned Summary" });
  await expect(sheet).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".modal .sheet-grabber")).toBeVisible();
  await dialogMotionSettled(page);
  const sheetBox = await box(page.locator(".modal").filter({ has: sheet }));
  expect(Math.abs(sheetBox.bottom - 900)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(sheetBox.width - 390)).toBeLessThanOrEqual(0.5);
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(toggle(page)).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem("wollipog.pinned.open")), "the sheet is not persisted").toBe("1");
});

test("at 390px the sheet replaces the full-screen right panel and keeps focus", async ({ page }) => {
  await openSession(page, 390, { "wollipog.pinned.open": "1" });
  await page.getByRole("button", { name: "Side Panel", exact: true, pressed: false }).click();
  await expect(page.locator(".right-panel")).toBeVisible();

  await toggle(page).click();
  const sheet = page.getByRole("dialog", { name: "Pinned Summary" });
  await expect(sheet).toBeVisible();
  await expect(page.locator(".right-panel")).toHaveCount(0);
  // The closed panel's deferred focus restore runs on the next frames; it must not pull focus out
  // of the sheet behind its scrim.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await sheet.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(toggle(page)).toBeFocused();
});

test("loading and resizing pick the summary's state deterministically (#121)", async ({ page }) => {
  await openSession(page, 1440, { "wollipog.pinned.open": "0" });
  await expect(summary(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");

  await toggle(page).click();
  await expect(summary(page)).toHaveAttribute("data-presentation", "docked");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");

  await page.setViewportSize({ width: 834, height: 900 });
  await expect(summary(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(summary(page)).toHaveAttribute("data-presentation", "docked");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");

  // An open drawer does not survive a trip through the phone sheet.
  await page.setViewportSize({ width: 834, height: 900 });
  await toggle(page).click();
  await expect(summary(page)).toHaveAttribute("data-presentation", "drawer");
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.getByRole("dialog", { name: "Pinned Summary" })).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await page.setViewportSize({ width: 834, height: 900 });
  await expect(summary(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
});

for (const width of [834, 390]) {
  test(`at ${width}px the summary starts closed even when the preference is open`, async ({ page }) => {
    await openSession(page, width, { "wollipog.pinned.open": "1" });
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
    await expect(summary(page)).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Pinned Summary" })).toHaveCount(0);
  });
}
