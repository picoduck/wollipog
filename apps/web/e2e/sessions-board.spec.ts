import { expect, test, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";

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
  await expect(page.locator(".page-tabs .tabs-bar")).toBeVisible();
}

function harnessPath(page: Page): string | null {
  return new URL(page.url()).searchParams.get("path");
}

/** The Sessions tab row's search field against its tabs, measured in the page. */
function toolbarGeometry(page: Page) {
  return page.locator(".page-tabs .tabs-bar").evaluate((toolbar) => {
    const input = toolbar.querySelector<HTMLInputElement>(".inbox-search input")!;
    const search = input.closest(".inbox-search")!.getBoundingClientRect();
    const tabs = toolbar.querySelector(".tabs")!.getBoundingClientRect();
    // An input's scrollWidth ignores its placeholder, so the placeholder is measured in the input's font.
    const style = getComputedStyle(input);
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = style.font;
    return {
      // The content box: the placeholder cannot draw into the input's own padding.
      inputWidth: input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      placeholderWidth: context.measureText(input.placeholder).width,
      searchOwnRow: search.bottom <= tabs.top || search.top >= tabs.bottom,
      // Every part of the bar is inside it. A touch target's hit area (`::after`) may reach into
      // the page gutter, so the parts are measured rather than the bar's scrollWidth.
      contained: [...toolbar.children].every((child) => {
        const box = child.getBoundingClientRect();
        const bar = toolbar.getBoundingClientRect();
        return box.left >= bar.left - 0.5 && box.right <= bar.right + 0.5;
      }),
    };
  });
}

test("Inbox rows name their pending request and F2 opens the session on it without approving", async ({ page }) => {
  await openHarness(page);
  const row = page.locator(".inbox-row-shell", { hasText: "Approval Session" });
  // No disclosure under the card (#896): the pill says what is pending, and F2 goes to it.
  await expect(row.locator(".attention-requests")).toHaveCount(0);
  await expect(row.locator(".status.t-warning")).toHaveAttribute("aria-label", "Status: Approval Required");
  await row.locator(".inbox-row").click();
  const grid = page.getByRole("grid", { name: "Sessions", exact: true });
  await grid.focus();
  await grid.press("F2");
  expect(harnessPath(page)).toMatch(/\/attention\/~[^/]+\?epoch=0$/);
  expect(await page.evaluate(() => window.__approveCalls)).toEqual([]);
});

test.describe("with a touch pointer", () => {
  // The 44px option height at phone width is a touch size, keyed to the pointer (#1799).
  test.use({ hasTouch: true });

  test("the header's view switch and Snoozed are touch-sized, and a phone draws List / Board as icons", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openHarness(page);
    await expect(page.getByRole("radio", { name: "List" })).toBeVisible();
    await expect(page.locator(".sessions-view-label").first()).toBeVisible();
    const snoozed = page.getByRole("button", { name: "Snoozed, 1", exact: true });
    await expect(snoozed).toHaveAttribute("aria-pressed", "false");
    expect((await snoozed.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    await page.setViewportSize({ width: 390, height: 844 });
    // The shared segmented control (§10.2) draws a 38px option inside a 44px track and gives each
    // option the track's inset as its hit area, so the TARGET is 44px: a tap 2.5px above or below
    // the visible option still lands on it.
    for (const name of ["List", "Board"]) {
      const option = page.getByRole("radio", { name });
      await expect(option).toBeVisible();
      const track = option.locator("xpath=ancestor::*[@role='radiogroup'][1]");
      expect((await track.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await option.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const x = box.left + box.width / 2;
        return [box.top - 2.5, box.bottom + 2.5].every((y) => element.contains(document.elementFromPoint(x, y)));
      }), `${name} is a 44px target`).toBe(true);
    }
    // Until the phone Sessions bar (#2211) the app bar draws List / Board as icons, and Snoozed is
    // in ⋯ as a checked item with its count.
    await expect(page.locator(".sessions-view-label").first()).toBeHidden();
    await expect(snoozed).toBeHidden();
    await page.locator(".page-header").getByRole("button", { name: "More Actions" }).click();
    const showSnoozed = page.getByRole("menuitemcheckbox", { name: "Show Snoozed Sessions, 1" });
    await expect(showSnoozed).toHaveAttribute("aria-checked", "false");
    expect((await showSnoozed.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Escape");

    // A search field sharing a row of controls was left 97px and cut its placeholder to "Sear"
    // (#2082). It takes a full-width row of its own instead.
    const geometry = await toolbarGeometry(page);
    expect(geometry.inputWidth).toBeGreaterThanOrEqual(160);
    expect(geometry.inputWidth, "the whole placeholder shows").toBeGreaterThanOrEqual(geometry.placeholderWidth);
    expect(geometry.searchOwnRow).toBe(true);
    expect(geometry.contained).toBe(true);
    const create = (await page.locator(".page-header").getByRole("button", { name: "New Session", exact: true }).boundingBox())!;
    expect(create.width).toBeGreaterThanOrEqual(44);
    expect(create.height).toBeGreaterThanOrEqual(44);

    // One pixel past the phone breakpoint the tab row is the desktop row again, search beside the tabs.
    await page.setViewportSize({ width: 761, height: 844 });
    expect((await toolbarGeometry(page)).searchOwnRow).toBe(false);
  });
});

test("pending snooze excludes attention from Active across list, board, search, and counts", async ({ page }) => {
  await openHarness(page);
  const snoozed = page.getByRole("button", { name: "Snoozed, 1", exact: true });
  await expect(page.locator(".inbox-row-shell", { hasText: "Snoozed Session" })).toHaveCount(0);

  const search = page.locator(".inbox-search input");
  await search.fill("Snoozed Session");
  await expect(page.locator(".inbox-row-shell", { hasText: "Snoozed Session" })).toHaveCount(0);

  await snoozed.click();
  const row = page.locator(".inbox-row-shell", { hasText: "Snoozed Session" });
  await expect(row).toBeVisible();
  await expect(row.locator('[aria-label^="Status: Approval Required"]')).toBeVisible();
  // #2209: a snoozed row says when it returns in its time cell, behind an alarm clock.
  await expect(row.locator(".inbox-row-time.snoozed svg")).toBeVisible();
  await expect(snoozed).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("radio", { name: "Board" }).click();
  const card = page.locator(".board .card", { hasText: "Snoozed Session" });
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Allow" })).toBeVisible();
  await expect(card.locator('[aria-label="Reminder: Snoozed"]')).toBeVisible();
});

test("the Sessions list runs to its pane's lower edge with no footer or shortcut rail at any width (#2214)", async ({ page }) => {
  await openHarness(page);
  for (const width of [1280, 834, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator(".inbox-row-shell").first()).toBeVisible();
    await expect(page.locator(".inbox-activity-footer, .inbox-shortcut-rail")).toHaveCount(0);
    const gap = await page.locator(".inbox-list-pane").evaluate((pane) => {
      const list = pane.querySelector<HTMLElement>(".inbox-list")!.getBoundingClientRect();
      return pane.getBoundingClientRect().bottom - list.bottom;
    });
    expect(gap, `at ${width}px nothing sits under the list`).toBeLessThanOrEqual(1);
  }
  await page.getByRole("radio", { name: "Board" }).click();
  await expect(page.locator(".inbox-activity-footer, .inbox-shortcut-rail")).toHaveCount(0);
});

test("a returned session explains its snooze and offers state-aware actions", async ({ page }) => {
  await openHarness(page);
  const row = page.locator(".inbox-row-shell", { hasText: "Review Session" });
  // A fired reminder is the row's one status when nothing outranks it (#2209), its instant in the tooltip.
  const reminder = row.locator(".status[aria-label=\"Status: Returned from Snooze\"]");
  await expect(reminder).toHaveText("Returned from Snooze");
  await expect(reminder).toHaveAttribute("title", /Snooze ended/);
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

  await page.getByRole("radiogroup", { name: "Sessions View" }).getByRole("radio", { name: /Board/ }).click();
  await expect(page.locator(".board-wrap")).toBeVisible();
  expect(harnessPath(page)).toBe("/board");
  await expect(page.locator(".board .card")).toHaveCount(4);
  await expect(page.locator(".board .card", { hasText: "Archived Session" })).toHaveCount(0);

  await page.getByRole("radiogroup", { name: "Sessions View" }).getByRole("radio", { name: /List/ }).click();
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
  // Nothing here matches "b", so No Matches stands in for the board (#2200); the mode is unchanged.
  await expect(page.getByRole("radiogroup", { name: "Sessions View" }).getByRole("radio", { name: /Board/ }))
    .toHaveAttribute("aria-checked", "true");
  expect(harnessPath(page)).toBe("/board");
  await expect(page.locator(".inbox-list")).toHaveCount(0);
});

test("a reload keeps board mode and activating the Sessions rail item reopens it", async ({ page }) => {
  await openHarness(page);
  await page.getByRole("radiogroup", { name: "Sessions View" }).getByRole("radio", { name: /Board/ }).click();
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

  await page.getByRole("radiogroup", { name: "Sessions View" }).getByRole("radio", { name: /List/ }).click();
  await expect(page.locator(".inbox-list")).toBeVisible();
  const row = page.locator(".inbox-row", { hasText: "Queued Session" });
  await row.click();
  await page.keyboard.press("Enter");
  await expect(page.locator(".inbox-view.expanded")).toBeVisible();
  await page.goBack();
  await expect(page.locator(".inbox-list")).toBeVisible();
  await expect(page.locator(".board-wrap")).toHaveCount(0);
});

/**
 * Drag a card onto a column the way a person does (#2201): press, start the drag, wait for the
 * empty strips to open to full width, then aim at the column where it now is and release.
 * `locator.dragTo` measures its target before the drag starts, so it aims at a 40px strip that
 * opens under the pointer mid-gesture.
 */
async function dragCardToColumn(page: Page, card: Locator, column: Locator) {
  const from = (await card.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + 16);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + 28, { steps: 2 });
  await expect(page.locator(".board")).toHaveClass(/is-dragging/);
  await column.scrollIntoViewIfNeeded();
  const to = (await column.boundingBox())!;
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(to.height / 2, 120), { steps: 4 });
  await page.mouse.up();
}

test("dragging a card to another column persists the move", async ({ page }) => {
  await openHarness(page, "/board");
  const card = page.locator(".board .card", { hasText: "Running Session" });
  await expect(card).toBeVisible();
  // An empty column is a strip (#2201) and the whole column is the drop target.
  await dragCardToColumn(page, card, page.locator(".column.col-done"));

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

test("a held finger on a row opens its menu, selecting the row on desktop but never opening it", async ({ page }) => {
  await openHarness(page);
  const cdp = await touchSession(page);
  const selectedBefore = await page.locator('.inbox-row-shell[aria-selected="true"] .inbox-row-title').textContent();

  await longPressUntilMenu(cdp, page, await centerOf(page.locator(".inbox-row-shell", { hasText: "Queued Session" })));
  await expect(page.locator('[role="menu"]')).toHaveAttribute("aria-label", "Session Actions for Queued Session");
  await expect(page.locator(".inbox-view.expanded")).toHaveCount(0, "a press is not an open");
  expect(harnessPath(page)).toBe("/");
  // A desktop row's menu selects its row first (#2214), so the menu, the preview and the keys share it.
  expect(selectedBefore).not.toBe("Queued Session");
  await expect(page.locator('.inbox-row-shell[aria-selected="true"] .inbox-row-title')).toHaveText("Queued Session");

  // Dismissal on touch is a tap on the backdrop — which must NOT be swallowed by the grace
  // that protected the menu from its own opening click.
  await tapAt(cdp, { x: 20, y: 500 });
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  await tapAt(cdp, await centerOf(page.locator(".inbox-row-shell", { hasText: "Running Session" }).locator(".inbox-row-title")));
  await expect(page.locator('.inbox-row-shell[aria-selected="true"] .inbox-row-title'))
    .toHaveText("Running Session", "the previous press's grace must not swallow the tap");
});

test("pin indicators keep their shape and card geometry across viewports, densities, and palettes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openHarness(page);
  const queued = page.locator(".inbox-row-shell", { hasText: "Queued Session" });
  await queued.click({ button: "right" });
  await page.getByRole("menu", { name: "Session Actions for Queued Session" })
    .getByRole("menuitem", { name: "Pin Session" }).click();

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const density of ["compact", "comfortable"] as const) {
      for (const theme of ["dark", "light"] as const) {
        for (const scheme of ["wollipog", "github", "one-dark", "dracula", "monokai"] as const) {
          await page.evaluate(({ density, theme, scheme }) => {
            if (density === "comfortable") document.documentElement.dataset.density = density;
            else delete document.documentElement.dataset.density;
            document.documentElement.dataset.theme = theme;
            if (scheme === "wollipog") delete document.documentElement.dataset.scheme;
            else document.documentElement.dataset.scheme = scheme;
          }, { density, theme, scheme });
          const geometry = await queued.evaluate((shell) => {
            const row = shell.querySelector<HTMLElement>(".inbox-row")!;
            const pin = shell.querySelector<HTMLElement>('[aria-label="Pinned Session"]')!;
            const icon = pin.querySelector<SVGElement>("svg")!;
            const pinBox = pin.getBoundingClientRect();
            const iconBox = icon.getBoundingClientRect();
            const siblings = [...pin.parentElement!.children]
              .filter((node) => node !== pin)
              .map((node) => node.getBoundingClientRect());
            return {
              rowHeight: row.getBoundingClientRect().height,
              pinWidth: pinBox.width,
              pinHeight: pinBox.height,
              iconWidth: iconBox.width,
              iconHeight: iconBox.height,
              overlapsSignal: siblings.some((box) => pinBox.left < box.right && pinBox.right > box.left),
            };
          });
          const peerHeight = await page.locator(".inbox-row-shell", { hasText: "Running Session" })
            .locator(".inbox-row").evaluate((row) => row.getBoundingClientRect().height);
          const context = `${width}/${density}/${scheme}/${theme}`;
          expect(geometry.pinWidth, context).toBe(18);
          expect(geometry.pinHeight, context).toBe(18);
          expect(geometry.iconWidth, context).toBe(14);
          expect(geometry.iconHeight, context).toBe(14);
          expect(geometry.overlapsSignal, context).toBe(false);
          expect(Math.abs(geometry.rowHeight - peerHeight), `${context}: pin does not change row height`).toBeLessThanOrEqual(0.5);
        }
      }
    }
  }

  await page.getByRole("radio", { name: "Board" }).click();
  const card = page.locator(".board .card", { hasText: "Queued Session" });
  await expect(card.getByLabel("Pinned Session")).toBeVisible();
  const cardHeight = await card.evaluate((node) => node.getBoundingClientRect().height);
  const peerCardHeight = await page.locator(".board .card", { hasText: "Running Session" })
    .evaluate((node) => node.getBoundingClientRect().height);
  expect(Math.abs(cardHeight - peerCardHeight), "the Board badge does not change card height").toBeLessThanOrEqual(0.5);
  await page.screenshot({ path: test.info().outputPath("pin-indicators-board.png"), fullPage: true });
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

test("long-pressed rows and cards pin their target, persist the state, and expose Unpin Session", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await openHarness(page);
  let cdp = await touchSession(page);
  const queued = page.locator(".inbox-row-shell", { hasText: "Queued Session" });

  await longPressUntilMenu(cdp, page, await centerOf(queued));
  let menu = page.getByRole("menu", { name: "Session Actions for Queued Session" });
  const pinRow = menu.getByRole("menuitem", { name: "Pin Session" });
  await expect(pinRow).toBeVisible();
  // At 390px the menu is a bottom sheet that slides up; measure its resting position, not a frame.
  await dialogMotionSettled(page);
  const menuBox = (await menu.boundingBox())!;
  expect(menuBox.y).toBeGreaterThanOrEqual(0);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(640);
  await pinRow.click();
  await expect(menu).toHaveCount(0, "the action dismisses the touch menu");
  await expect(queued.getByLabel("Pinned Session")).toBeVisible();
  await expect(queued.getByLabel("Pinned Session")).toHaveAttribute("title", "Pinned Session");
  await expect(page.locator('.inbox-row-shell[aria-rowindex="2"] .inbox-row-title')).toHaveText("Queued Session",
    "the exact long-pressed row moves to the top of the ordinary sessions, below the returned reminder");
  expect(harnessPath(page)).toBe("/");
  await expect(page.locator(".inbox-view.expanded")).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".page-tabs .tabs-bar")).toBeVisible();
  const persistedQueued = page.locator(".inbox-row-shell", { hasText: "Queued Session" });
  await expect(persistedQueued.getByLabel("Pinned Session")).toBeVisible();
  await persistedQueued.click({ button: "right" });
  menu = page.getByRole("menu", { name: "Session Actions for Queued Session" });
  await expect(menu.getByRole("menuitem", { name: "Unpin Session" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Unpin Session" }).click();
  await expect(persistedQueued.getByLabel("Pinned Session")).toHaveCount(0);
  await expect(page.locator('.inbox-row-shell[aria-rowindex="2"] .inbox-row-title')).toHaveText("Approval Session",
    "unpinning restores the existing Inbox ordering");

  await page.getByRole("radiogroup", { name: "Sessions View" }).getByRole("radio", { name: /Board/ }).click();
  cdp = await touchSession(page);
  const running = page.locator(".board .card", { hasText: "Running Session" });
  await longPressUntilMenu(cdp, page, await centerOf(running));
  menu = page.getByRole("menu", { name: "Session Actions for Running Session" });
  await menu.getByRole("menuitem", { name: "Pin Session" }).click();
  await expect(menu).toHaveCount(0);
  await expect(running.getByLabel("Pinned Session")).toBeVisible();
  expect(harnessPath(page)).toBe("/board");
  await expect(page.locator(".inbox-view.expanded")).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".board-wrap")).toBeVisible();
  const persistedRunning = page.locator(".board .card", { hasText: "Running Session" });
  await expect(persistedRunning.getByLabel("Pinned Session")).toBeVisible();
  await persistedRunning.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Session Actions for Running Session" })
    .getByRole("menuitem", { name: "Unpin Session" })).toBeVisible();
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

test.describe("on a touch tablet at 834×1112 (#2214)", () => {
  test.use({ viewport: { width: 834, height: 1112 }, hasTouch: true });

  test("the selected session's request decisions are fully visible in the preview without scrolling", async ({ page }) => {
    await openHarness(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await page.locator(".inbox-row", { hasText: "Approval Session" }).click();
    const preview = page.locator(".inbox-preview-pane");
    await expect(preview.locator(".session-preview-bar")).toContainText("Approval Session");
    // The request card at the top of the preview (#2210) holds the decisions that left the rail:
    // its primary and the ⋯ with every other choice, all wholly on screen without scrolling.
    const foot = preview.locator(".request-card-foot");
    await expect(foot.getByRole("button", { name: /^Allow/u })).toBeVisible();
    const controls = await foot.getByRole("button").evaluateAll((buttons) => buttons.map((element) => {
      const box = element.getBoundingClientRect();
      const pane = element.closest(".inbox-preview-pane")!.getBoundingClientRect();
      return {
        name: element.getAttribute("aria-label") ?? element.textContent,
        inside: box.top >= pane.top && box.bottom <= pane.bottom && box.bottom <= window.innerHeight,
      };
    }));
    expect(controls.length, JSON.stringify(controls)).toBeGreaterThanOrEqual(2);
    for (const control of controls) expect(control.inside, `${control.name} sits wholly on screen`).toBe(true);
    expect(await preview.locator(".detail-scroll").evaluate((element) => element.scrollTop)).toBe(0);
    // Each row shows only its ⋯ on touch, at least 44px, and no rail or footer takes the list's height.
    const shell = page.locator(".inbox-row-shell", { hasText: "Approval Session" });
    const more = shell.locator(".inbox-row-more");
    await expect(more).toBeVisible();
    const size = await more.evaluate((element) => element.getBoundingClientRect());
    expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(44);
    await expect(shell.locator(".inbox-row-action:not(.inbox-row-more)")).toHaveCount(2);
    for (const hidden of await shell.locator(".inbox-row-action:not(.inbox-row-more)").all()) await expect(hidden).toBeHidden();
    await expect(page.locator(".inbox-activity-footer, .inbox-shortcut-rail")).toHaveCount(0);
  });
});

test.describe("with a mouse at 1440×900 (#2214)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("hovering a row shows Snooze, Archive and ⋯ without hiding its status or time", async ({ page }) => {
    await openHarness(page);
    const row = page.locator(".inbox-row-shell", { hasText: "Review Session" });
    const actions = row.locator(".inbox-row-actions");
    await expect(actions).toBeHidden();
    await row.hover();
    await expect(actions).toBeVisible();
    const names = await actions.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
    expect(names[0]).toBe("Snooze");
    expect(names[1]).toMatch(/^(Archive|Archive and Stop…|Retry Stop…)$/u);
    expect(names[2]).toBe("More Actions");
    const overlap = await row.evaluate((shell) => {
      const actionsBox = shell.querySelector(".inbox-row-actions")!.getBoundingClientRect();
      const covered = (selector: string) => {
        const element = shell.querySelector(selector);
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return box.right > actionsBox.left && box.left < actionsBox.right && box.bottom > actionsBox.top && box.top < actionsBox.bottom;
      };
      return { status: covered(".inbox-row-status-line .row-status"), time: covered(".inbox-row-time") };
    });
    expect(overlap).toEqual({ status: false, time: false });
  });
});
