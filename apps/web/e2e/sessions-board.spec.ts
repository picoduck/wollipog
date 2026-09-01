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
  await expect(page.locator(".board .card")).toHaveCount(3);
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
