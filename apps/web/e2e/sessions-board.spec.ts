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

test("Inbox rows name their pending request and F2 opens the session on it without approving", async ({ page }) => {
  await openHarness(page);
  const row = page.locator(".inbox-row-shell", { hasText: "Approval Session" });
  // No disclosure under the card (#896): the pill says what is pending, and F2 goes to it.
  await expect(row.locator(".attention-requests")).toHaveCount(0);
  await expect(row.locator(".inbox-status-pill.blocked")).toHaveAttribute("aria-label", "Attention: Approval Required");
  await row.locator(".inbox-row").click();
  const grid = page.getByRole("grid", { name: "Sessions", exact: true });
  await grid.focus();
  await grid.press("F2");
  expect(harnessPath(page)).toMatch(/\/attention\/~[^/]+\?epoch=0$/);
  expect(await page.evaluate(() => window.__approveCalls)).toEqual([]);
});

test("the reminder and mode controls use scoped badges and compact mobile icons", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openHarness(page);
  await expect(page.getByRole("radio", { name: "List" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Active, 4 Sessions" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Snoozed, 1 Session" })).toBeVisible();
  await expect(page.locator(".sessions-toolbar-option-text").first()).toBeVisible();
  await expect(page.locator(".sessions-toolbar-option-icon").first()).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ["List", "Board", "Active, 4 Sessions", "Snoozed, 1 Session"]) {
    const option = page.getByRole("radio", { name });
    await expect(option).toBeVisible();
    expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.locator(".sessions-toolbar-option-text").first()).toBeHidden();
  await expect(page.locator(".sessions-toolbar-option-icon").first()).toBeVisible();
  await expect(page.locator(".sessions-toolbar-count")).toHaveText(["4", "1"]);

  const geometry = await page.locator(".inbox-toolbar-actions").evaluate((actions) => {
    const search = actions.querySelector(".inbox-search")!.getBoundingClientRect();
    const options = [...actions.querySelectorAll<HTMLElement>(".ui-seg-option")]
      .map((option) => option.getBoundingClientRect());
    return {
      searchWidth: search.width,
      oneLine: options.every((option) => Math.abs(option.top - options[0]!.top) < 1),
      contained: actions.scrollWidth <= actions.clientWidth,
    };
  });
  expect(geometry.searchWidth).toBeGreaterThan(70);
  expect(geometry.oneLine).toBe(true);
  expect(geometry.contained).toBe(true);
});

test("the Inbox footer centers readable counts on phones and keeps shortcuts trailing on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openHarness(page);

  const footer = page.locator('footer[aria-label="Inbox Status and Shortcuts"]');
  const summary = footer.getByLabel("Inbox Activity Summary");
  const shortcuts = footer.locator(".inbox-shortcut-rail");
  await expect(shortcuts).toBeVisible();
  await expect(shortcuts.getByRole("button", { name: "Reply" })).toBeVisible();
  const desktopGeometry = await footer.evaluate((element) => {
    const rail = element.querySelector<HTMLElement>(".inbox-shortcut-rail")!.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return {
      contained: element.scrollWidth <= element.clientWidth,
      railTrailingGap: bounds.right - rail.right,
    };
  });
  expect(desktopGeometry.contained).toBe(true);
  expect(desktopGeometry.railTrailingGap).toBeLessThanOrEqual(9);

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(shortcuts).toBeHidden();
    await expect(summary.locator("span")).toHaveText([
      "0 Running",
      "0 Queued",
      "0 Starting",
      "1 Blocked",
      "0 Stalled",
    ]);

    const phoneGeometry = await footer.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const counts = element.querySelector<HTMLElement>(".inbox-activity-summary")!.getBoundingClientRect();
      return {
        centered: Math.abs((counts.left + counts.right) / 2 - (bounds.left + bounds.right) / 2),
        contained: element.scrollWidth <= element.clientWidth,
        height: bounds.height,
      };
    });
    expect(phoneGeometry.centered).toBeLessThanOrEqual(1);
    expect(phoneGeometry.contained).toBe(true);
    expect(phoneGeometry.height).toBe(34);
  }

  const wideFace = await page.evaluate(() => {
    const widthIn = (family: string) => {
      const probe = document.createElement("span");
      probe.textContent = "12 Running 24 Blocked 5 Stalled";
      probe.style.cssText =
        `position:absolute;visibility:hidden;white-space:nowrap;font-size:11px;font-family:${family}`;
      document.body.append(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    };
    const absent = widthIn('"a face no machine has, 96d10"');
    return ["DejaVu Sans", "Liberation Sans"].find((face) => widthIn(`"${face}"`) !== absent) ?? null;
  });
  expect(wideFace, "no wide face to measure: install fonts-dejavu-core (CI renders in DejaVu Sans)")
    .not.toBeNull();
  await page.addStyleTag({
    content: `.inbox-activity-footer, .inbox-activity-footer * { font-family: "${wideFace}" !important; }`,
  });
  const crowdedCounts = ["12 Running", "8 Queued", "3 Starting", "24 Blocked", "5 Stalled"];
  await summary.locator("span").evaluateAll((spans, values) => {
    for (const [index, span] of spans.entries()) span.textContent = values[index]!;
  }, crowdedCounts);
  await expect(summary.locator("span")).toHaveText(crowdedCounts);
  const crowdedGeometry = await footer.evaluate((element) => ({
    contained: element.scrollWidth <= element.clientWidth,
    summaryContained: element.querySelector<HTMLElement>(".inbox-activity-summary")!.scrollWidth <=
      element.querySelector<HTMLElement>(".inbox-activity-summary")!.clientWidth,
  }));
  expect(crowdedGeometry.contained).toBe(true);
  expect(crowdedGeometry.summaryContained).toBe(true);

  const overflowingCounts = ["1234 Running", "5678 Queued", "9012 Starting", "3456 Blocked", "7890 Stalled"];
  await summary.locator("span").evaluateAll((spans, values) => {
    for (const [index, span] of spans.entries()) span.textContent = values[index]!;
  }, overflowingCounts);
  const leadingOverflow = await footer.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const padding = Number.parseFloat(getComputedStyle(element).paddingInlineStart);
    const firstCount = element.querySelector<HTMLElement>(".inbox-activity-summary span")!.getBoundingClientRect();
    return bounds.left + padding - firstCount.left;
  });
  expect(leadingOverflow, "an over-wide summary keeps its leading count reachable").toBeLessThanOrEqual(0.5);

  await page.getByRole("radio", { name: "Board" }).click();
  await expect(footer).toHaveCount(0);
  await page.getByRole("radio", { name: "List" }).click();
  await expect(summary).toBeVisible();
  await expect(shortcuts).toBeHidden();
});

test("a returned session explains its snooze and offers state-aware actions", async ({ page }) => {
  await openHarness(page);
  const row = page.locator(".inbox-row-shell", { hasText: "Review Session" });
  const reminder = row.locator(".inbox-status-pill.reminder");
  await expect(reminder).toHaveText("Returned from Snooze");
  await expect(reminder).toHaveAttribute("aria-label", /Snooze ended/);
  await expect(reminder).not.toContainText("Overdue");

  await row.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Session Actions for Review Session" });
  await expect(menu.getByRole("menuitem", { name: "Snooze Again…" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Dismiss Reminder" }).click();
  await expect(reminder).toHaveCount(0);
});

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
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Hold until the press's OBSERVABLE effect (the menu) before releasing: the 500ms timer runs
 * in the renderer, and a fixed cross-process sleep races it under CI load. */
async function longPressUntilMenu(cdp: CDPSession, page: Page, point: { x: number; y: number }) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.locator('[role="menu"]').waitFor({ timeout: 5000 });
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

  await longPressUntilMenu(cdp, page, await centerOf(page.locator(".inbox-row-shell", { hasText: "Queued Session" })));
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

  await longPressUntilMenu(cdp, page, await centerOf(allow));
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
