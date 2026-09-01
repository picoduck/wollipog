import { expect, test, type Page } from "@playwright/test";

/**
 * The Sessions list/board merge (#499), pinned in a real browser (#527).
 *
 * The harness mounts the app's OWN mode glue — useSessionsViewToggleKey and
 * useSessionsViewModeMemory — plus the real Rail and InboxView against a fixture socket, so
 * these fail when the shipped behavior regresses, not when a fixture copy drifts. The SPA path
 * rides in `?path=` because the harness page is not the SPA (see sessions-board-main.tsx).
 */

const PAGE = "/sessions-board-e2e.html";

async function openHarness(page: Page, path = "/") {
  await page.goto(`${PAGE}?path=${encodeURIComponent(path)}`);
  await expect(page.locator(".inbox-toolbar")).toBeVisible();
}

function harnessPath(page: Page): string | null {
  return new URL(page.url()).searchParams.get("path");
}

test("the toggle switches modes, the URL follows, and archived sessions never reach the board", async ({ page }) => {
  await openHarness(page);
  await expect(page.locator(".inbox-list")).toBeVisible();

  await page.locator(".sessions-view-toggle button", { hasText: "Board" }).click();
  await expect(page.locator(".board-wrap")).toBeVisible();
  expect(harnessPath(page)).toBe("/board");
  await expect(page.locator(".board .card")).toHaveCount(4);
  await expect(page.locator(".board .card", { hasText: "Archived Session" })).toHaveCount(0);

  await page.locator(".sessions-view-toggle button", { hasText: "List" }).click();
  await expect(page.locator(".inbox-list")).toBeVisible();
  expect(harnessPath(page)).toBe("/");
});

test("bare b toggles the mode and stays inert while typing in the shared search", async ({ page }) => {
  await openHarness(page);
  await page.keyboard.press("b");
  await expect(page.locator(".board-wrap")).toBeVisible();
  await page.keyboard.press("b");
  await expect(page.locator(".inbox-list")).toBeVisible();

  await page.keyboard.press("b");
  await expect(page.locator(".board-wrap")).toBeVisible();
  const search = page.locator(".inbox-search input");
  await search.focus();
  await page.keyboard.press("b");
  await expect(search).toHaveValue("b");
  await expect(page.locator(".board-wrap")).toBeVisible();
});

test("a reload keeps board mode and activating the Sessions rail item reopens it", async ({ page }) => {
  await openHarness(page);
  await page.locator(".sessions-view-toggle button", { hasText: "Board" }).click();
  await expect(page.locator(".board-wrap")).toBeVisible();

  await page.reload();
  await expect(page.locator(".board-wrap")).toBeVisible();

  await page.locator('.rail-destinations a[href="/projects"]').click();
  await expect(page.locator(".fixture-projects")).toBeVisible();
  await page.locator('.rail-destinations a[href="/"]').click();
  await expect(page.locator(".board-wrap")).toBeVisible();
  expect(harnessPath(page)).toBe("/board");
});

test("history back returns to the mode the session was opened from, in both directions", async ({ page }) => {
  await openHarness(page, "/board");
  await expect(page.locator(".board-wrap")).toBeVisible();
  await page.locator(".board .card-title", { hasText: "Running Session" }).click();
  await expect(page.locator(".inbox-view.expanded")).toBeVisible();
  await page.goBack();
  await expect(page.locator(".board-wrap")).toBeVisible();

  await page.locator(".sessions-view-toggle button", { hasText: "List" }).click();
  await expect(page.locator(".inbox-list")).toBeVisible();
  const row = page.locator(".inbox-row", { hasText: "Queued Session" });
  await row.click();
  await page.keyboard.press("Enter");
  await expect(page.locator(".inbox-view.expanded")).toBeVisible();
  await page.goBack();
  await expect(page.locator(".inbox-list")).toBeVisible();
  await expect(page.locator(".board-wrap")).toHaveCount(0);
});

test("dragging a card to another column persists the move", async ({ page }) => {
  await openHarness(page, "/board");
  const card = page.locator(".board .card", { hasText: "Running Session" });
  await expect(card).toBeVisible();
  await card.dragTo(page.locator(".column.col-done .column-body"));

  await expect
    .poll(() => page.evaluate(() => window.__setColumnCalls))
    .toEqual([{ sessionId: "s-running", column: "done" }]);
  await expect(page.locator(".column.col-done .card", { hasText: "Running Session" })).toBeVisible();
  await expect(page.locator(".column.col-running .card")).toHaveCount(0);
});

/**
 * The long-press gesture in a REAL browser (#540): CDP touch injection exercises Chromium's own
 * touch → pointer → synthetic-click pipeline, which is exactly the gap where every one of the
 * gesture's review findings lived — DOM tests dispatch pointer events, but only the browser
 * decides what clicks and drags a held finger actually produces.
 */
import type { CDPSession, Locator } from "@playwright/test";

async function touchSession(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  // Without touch emulation Chromium swallows injected touch points instead of promoting them
  // to pointer events — the exact pipeline this spec exists to exercise.
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  return cdp;
}

async function centerOf(target: Locator): Promise<{ x: number; y: number }> {
  const box = (await target.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function longPressAt(cdp: CDPSession, point: { x: number; y: number }, holdMs = 650) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function tapAt(cdp: CDPSession, point: { x: number; y: number }) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("a held finger on a row opens its menu without selecting or opening it", async ({ page }) => {
  await openHarness(page);
  const cdp = await touchSession(page);
  const selectedBefore = await page.locator('.inbox-row-shell[aria-selected="true"] .inbox-row-title').textContent();

  await longPressAt(cdp, await centerOf(page.locator(".inbox-row-shell", { hasText: "Queued Session" })));
  await expect(page.locator('[role="menu"]')).toHaveAttribute("aria-label", "Session Actions for Queued Session");
  await expect(page.locator(".inbox-view.expanded")).toHaveCount(0, "a press is not an open");
  expect(harnessPath(page)).toBe("/");
  await expect(page.locator('.inbox-row-shell[aria-selected="true"] .inbox-row-title'))
    .toHaveText(selectedBefore!, "and not a select");

  // Dismissal on touch is a tap on the backdrop — which must NOT be swallowed by the grace
  // that protected the menu from its own opening click.
  await tapAt(cdp, { x: 20, y: 500 });
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  await tapAt(cdp, await centerOf(page.locator(".inbox-row-shell", { hasText: "Queued Session" })));
  await expect(page.locator('.inbox-row-shell[aria-selected="true"] .inbox-row-title'))
    .toHaveText("Queued Session", "the previous press's grace must not swallow the tap");
});

test("a held finger over a card's approval button opens the menu and never approves", async ({ page }) => {
  await openHarness(page, "/board");
  const cdp = await touchSession(page);
  const allow = page.locator(".card-approval button", { hasText: "Allow" });
  await expect(allow).toBeVisible();

  await longPressAt(cdp, await centerOf(allow));
  await expect(page.locator('[role="menu"]')).toHaveAttribute("aria-label", "Session Actions for Approval Session");
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__approveCalls)).toEqual([]);
  await expect(page.locator(".inbox-view.expanded")).toHaveCount(0, "and does not open the session either");
  await page.keyboard.press("Escape");
});

test("touch scrolling through the list never conjures a menu", async ({ page }) => {
  await openHarness(page);
  const cdp = await touchSession(page);
  const start = await centerOf(page.locator(".inbox-row-shell", { hasText: "Review Session" }));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
  for (const dy of [15, 35, 60]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x, y: start.y - dy }] });
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  await new Promise((resolve) => setTimeout(resolve, 650));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.locator('[role="menu"]')).toHaveCount(0,
    "movement past the slop is scrolling, not a menu request");
});

test("a drag begun from a card stands the pending press down", async ({ page }) => {
  await openHarness(page, "/board");
  const cdp = await touchSession(page);
  const card = page.locator(".board .card", { hasText: "Running Session" });
  const point = await centerOf(card);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  // Some platforms promote a held touch on a draggable straight into a drag; the press must
  // yield the moment the drag begins, whatever initiated it.
  await card.evaluate((element) => element.dispatchEvent(
    new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() }),
  ));
  await new Promise((resolve) => setTimeout(resolve, 700));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.locator('[role="menu"]')).toHaveCount(0, "the drag owns the gesture");
});
