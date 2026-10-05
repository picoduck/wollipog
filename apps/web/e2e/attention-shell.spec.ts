import { expect, test, type Page } from "@playwright/test";
import { glyphUnderMark, ringAndFill } from "./rail-marks.js";
test.use({ video: "on" });

/** The app's opaque route segment: UTF-16LE, base64url, no padding (navigation.ts encodeOpaque). */
const opaque = (value: string) => Buffer.from(value, "utf16le").toString("base64url");
const fullShell = (path?: string) =>
  `/sessions-board-e2e.html?full-shell=1${path === undefined ? "" : `&path=${encodeURIComponent(path)}`}`;

test("the Sessions digit shortcut focuses the list after cross-destination navigation", async ({ page }) => {
  await page.goto(fullShell());
  const grid = page.getByRole("grid", { name: "Sessions", exact: true });
  await expect(grid).toBeVisible();
  const selectedId = await grid.getAttribute("aria-activedescendant");
  expect(selectedId).toBeTruthy();

  await page.getByRole("link", { name: /^Projects/ }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await page.keyboard.press("1");
  await expect(grid).toBeFocused();
  await expect(grid).toHaveAttribute("aria-activedescendant", selectedId!);
  await grid.press("ArrowDown");
  await expect(grid).not.toHaveAttribute("aria-activedescendant", selectedId!);
  const lastId = await grid.getByRole("row").last().getAttribute("id");
  expect(lastId).toBeTruthy();
  await grid.press("End");
  await expect(grid).toHaveAttribute("aria-activedescendant", lastId!);
});

test("the Sessions digit shortcut refocuses the already-active list", async ({ page }) => {
  await page.goto(fullShell());
  const grid = page.getByRole("grid", { name: "Sessions", exact: true });
  await expect(grid).toBeVisible();
  await grid.focus();
  await page.keyboard.press("F6");
  await expect(page.locator('.inbox-preview-pane[data-focus-zone="main"] :is(.detail-scroll, .inbox-preview-empty)')).toBeFocused();
  await page.keyboard.press("1");
  await expect(grid).toBeFocused();
  const lastId = await grid.getByRole("row").last().getAttribute("id");
  expect(lastId).toBeTruthy();
  await grid.press("End");
  await expect(grid).toHaveAttribute("aria-activedescendant", lastId!);
  await grid.press("ArrowUp");
  const firstId = await grid.getByRole("row").first().getAttribute("id");
  expect(firstId).toBeTruthy();
  await expect(grid).not.toHaveAttribute("aria-activedescendant", firstId!);
  await grid.press("Home");
  await expect(grid).toHaveAttribute("aria-activedescendant", firstId!);
});

test("the Sessions digit shortcut focuses the empty-list fallback", async ({ page }) => {
  await page.goto(`${fullShell("/projects")}&empty=1`);
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await page.keyboard.press("1");
  const emptyState = page.locator(".inbox-zero");
  await expect(emptyState).toHaveRole("status");
  await expect(emptyState.getByRole("button", { name: "New Session" })).toBeVisible();
  await expect(emptyState).toBeFocused();
});

test("the Sessions digit shortcut preserves and focuses remembered Board mode", async ({ page }) => {
  await page.goto(fullShell("/board"));
  const board = page.locator(".board-wrap");
  await expect(board).toBeVisible();
  await page.getByRole("link", { name: /^Projects/ }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await page.keyboard.press("1");
  await expect(board).toBeFocused();
  expect(new URL(page.url()).searchParams.get("path")).toBe("/board");
});

test("real shell preserves global shortcuts from the grid and F2 opens the selected session's top request", async ({ page }) => {
  await page.goto(fullShell());
  const grid = page.getByRole("grid", { name: "Sessions", exact: true });
  await expect(grid).toBeVisible();
  // Every row carries its attention as pills with counts, and none carries a disclosure (#896).
  await expect(grid.locator(".attention-requests")).toHaveCount(0);
  await expect(grid.locator(".inbox-row-shell", { hasText: "Snoozed Session" })).toHaveCount(0);
  await expect(grid.locator(".status-count")).toHaveCount(3);
  await expect(grid.locator(".status-count").first()).toHaveText("2");
  // One rail badge for Sessions: 4 blocked plus 4 stalled, red because a session is stalled (#1967).
  const sessions = page.getByRole("navigation", { name: "Primary Navigation" }).getByRole("link", { name: "Sessions", exact: true });
  await expect(sessions.locator(".count-badge")).toHaveCount(1);
  await expect(sessions.locator(".count-badge.danger.on-icon")).toHaveText("8");
  await expect(sessions).toHaveAccessibleDescription("4 waiting on you, 4 stalled");
  await grid.focus();
  // The primary requests in this fixture offer no options, so one-key approval has nothing safe to pick.
  await grid.press("a");
  expect(await page.evaluate(() => window.__approveCalls)).toEqual([]);
  for (const chord of ["Control+k", "Meta+k"]) {
    await grid.focus();
    await grid.press(chord);
    await expect(page.getByRole("dialog", { name: "Search", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await grid.focus();
  await grid.press("Shift+?");
  const shortcutDialog = page.getByRole("dialog", { name: "Keyboard Shortcuts", exact: true });
  await expect(shortcutDialog).toBeVisible();
  await expect(shortcutDialog.getByText("Toggle Thread", { exact: true })).toBeVisible();
  await expect(shortcutDialog.getByText("Next Session (Grid)", { exact: true })).toBeVisible();
  await expect(shortcutDialog.getByText("Previous Session (Grid)", { exact: true })).toBeVisible();
  await expect(shortcutDialog.getByText("First Session (Grid)", { exact: true })).toBeVisible();
  await expect(shortcutDialog.getByText("Last Session / Jump to Latest", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  // The modal owns global shortcuts until React has unmounted it. Refocusing the background and
  // sending F6 before that boundary settles races the app's intentional shortcut-layer guard on
  // slower runners. Wait for closure and the modal's asynchronous return-focus contract, then
  // send the global key from the element that actually owns focus.
  await expect(shortcutDialog).toBeHidden();
  await expect(grid).toBeFocused();
  await page.keyboard.press("F6");
  await expect(page.locator('.inbox-preview-pane[data-focus-zone="main"] :is(.detail-scroll, .inbox-preview-empty)')).toBeFocused();
  await grid.focus();
  const previousRow = await grid.getAttribute("aria-activedescendant");
  await grid.press("j");
  await expect(grid).not.toHaveAttribute("aria-activedescendant", previousRow!);
  await grid.press("/");
  await expect(page.locator(".inbox-search input")).toBeFocused();
  await page.locator(".inbox-search input").fill("Session");
  await page.locator(".inbox-search input").press("Escape");
  await expect(page.locator(".inbox-search input")).toHaveValue("");
  // F2 opens the selected session on its top-priority request; the session's own request is on its
  // request dock, which expands it and takes focus, with no Agents panel in the way (#2179).
  await page.locator(".inbox-row-shell", { hasText: "Running Session" }).locator(".inbox-row").click();
  await grid.focus();
  await grid.press("F2");
  const panel = page.getByRole("complementary", { name: "Agents", exact: true });
  const heading = page.locator(".request-dock .request-card").getByRole("heading");
  await expect(heading).toHaveText("Primary Request");
  await expect(heading).toBeFocused();
  await expect(panel).toHaveCount(0);
  await page.reload();
  await expect(heading).toBeFocused();
  await expect(panel).toHaveCount(0);
  await page.screenshot({ path: ".agents/tmp/attention-followup/keyboard-shell.png", fullPage: true });
});

test("search Enter hands the preserved filter to the Sessions grid for keyboard browsing", async ({ page }) => {
  await page.goto(fullShell());
  const grid = page.getByRole("grid", { name: "Sessions", exact: true });
  const search = page.locator(".inbox-search input");
  const selectedTitle = () => page.locator('.inbox-row-shell[aria-selected="true"] .inbox-row-title');
  await expect(grid).toBeVisible();

  // Keep a visible selection when the query still includes it.
  await page.locator(".inbox-row", { hasText: "Review Session" }).click();
  await grid.press("/");
  await expect(search).toBeFocused();
  await search.fill("Session");
  await search.press("Enter");
  await expect(grid).toBeFocused();
  await expect(search).toHaveValue("Session");
  await expect(selectedTitle()).toHaveText("Review Session");
  await expect(page.locator(".inbox-view")).not.toHaveClass(/expanded/);
  const retainedActiveId = await grid.getAttribute("aria-activedescendant");
  expect(retainedActiveId).toBeTruthy();
  await expect(page.locator(`#${retainedActiveId}`)).toBeAttached();
  await expect(page.locator(`#${retainedActiveId}`)).toBeInViewport();

  // The normal filtered-list keys work, and slash returns to the same query for refinement.
  await grid.press("j");
  await expect(selectedTitle()).not.toHaveText("Review Session");
  await grid.press("k");
  await expect(selectedTitle()).toHaveText("Review Session");
  await grid.press("/");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("Session");

  // If the old selection is hidden, the sole displayed row becomes the mounted active descendant.
  await search.fill("Queued");
  await search.press("Enter");
  await expect(grid).toBeFocused();
  await expect(grid).toHaveAttribute("aria-rowcount", "1");
  await expect(selectedTitle()).toHaveText("Queued Session");
  const repairedActiveId = await grid.getAttribute("aria-activedescendant");
  expect(repairedActiveId).toBeTruthy();
  await expect(page.locator(`#${repairedActiveId}`)).toBeAttached();
  await expect(page.locator(`#${repairedActiveId}`)).toBeInViewport();

  // An empty result set retains both input focus and the existing no-match announcement.
  await page.keyboard.press("/");
  await search.fill("nothing matches this");
  await search.press("Enter");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("nothing matches this");
  await expect(page.getByText("No Matching Sessions", { exact: true })).toBeVisible();
  await expect(page.getByRole("grid", { name: "Sessions", exact: true })).toHaveCount(0);
});

for (const width of [390, 1280]) test(`an attention route to the session's own request opens it on the dock, not the Agents panel, at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  // s-approval's own request is primary-3; its worker's child-3 waits in the Agents panel (#2179).
  await page.goto(fullShell(`/sessions/~${opaque("s-approval")}/attention/~${opaque("primary-3")}?epoch=7`));
  const heading = page.locator(".request-dock .request-card").getByRole("heading");
  await expect(heading).toHaveText("Primary Request");
  await expect(heading).toBeFocused();
  await expect(page.getByRole("complementary", { name: "Agents", exact: true })).toHaveCount(0);
});

for (const width of [390, 1280]) test(`real shell threads an exact attention route through the panel at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  // The list no longer offers a per-request target (#896); the exact child route is a deep link.
  await page.goto(fullShell(`/sessions/~${opaque("s-approval")}/attention/~${opaque("child-3")}?epoch=7`));
  const panel = page.getByRole("complementary", { name: "Agents", exact: true });
  await expect(panel).toBeVisible();
  const request = panel.getByRole("region", { name: "Selected Worker Request", exact: true });
  await expect(request).toBeFocused();
  await expect(request.getByText("Exact Child Request 3", { exact: true })).toBeVisible();
  await page.reload();
  await expect(panel).toBeVisible();
  await expect(request).toBeFocused();
  await expect(request.getByText("Exact Child Request 3", { exact: true })).toBeVisible();
  if (width === 1280) {
    const closePanel = page.getByRole("button", { name: "Close Panel", exact: true });
    // The bar's Session Status popover opens the top request through the same entry point (#2182);
    // the top request is the session's own, so it is the dock's card that takes focus (#2179).
    const status = page.locator(".session-bar .session-status-button");
    const reviewRequest = async () => {
      await status.click();
      await page.getByRole("dialog", { name: "Session Status" })
        .getByRole("button", { name: "Review Request" }).first().click();
    };
    const heading = page.locator(".request-dock .request-card").getByRole("heading");
    await closePanel.click();
    await reviewRequest();
    await expect(heading).toBeFocused();
    await expect(panel).toHaveCount(0);
    await reviewRequest();
    await expect(heading).toBeFocused();
  }
  await page.screenshot({ path: `.agents/tmp/attention-followup/shell-route-${width}.png`, fullPage: true });
});

for (const [label, device] of [
  ["at 1440×900 with a mouse", { viewport: { width: 1440, height: 900 } }],
  ["on an 834px coarse-pointer tablet", { viewport: { width: 834, height: 1112 }, hasTouch: true, isMobile: true }],
] as const) {
  test.describe(label, () => {
    test.use(device);

    test("Sessions carries one badge on the icon's shoulder, clear of the glyph and ringed in the item's fill (#1967)", async ({ page }) => {
      await page.goto(fullShell("/projects"));
      const rail = page.getByRole("navigation", { name: "Primary Navigation" });
      const sessions = rail.getByRole("link", { name: "Sessions", exact: true });
      // 4 blocked and 4 stalled: one red total, never two badges.
      await expect(sessions.locator(".count-badge")).toHaveCount(1);
      await expect(sessions.locator(".count-badge.danger.on-icon")).toHaveText("8");
      await expect(sessions).toHaveAccessibleName("Sessions");
      await expect(sessions).toHaveAccessibleDescription("4 waiting on you, 4 stalled");
      expect(await glyphUnderMark(page, sessions), "the badge and its ring cover none of the glyph").toBe(0);
      const rest = await ringAndFill(sessions);
      expect(rest.ring).toBe(`${rest.fill} 0px 0px 0px 2px`);

      // On the current item the ring follows the selected fill.
      await page.goto(fullShell());
      await expect(sessions).toHaveAttribute("aria-current", "page");
      expect(await glyphUnderMark(page, sessions)).toBe(0);
      const current = await ringAndFill(sessions);
      expect(current.ring).toBe(`${current.fill} 0px 0px 0px 2px`);
      expect(current.fill).not.toBe(rest.fill);
    });
  });
}

/**
 * A wide count stays inside the rail (#2110). Before it grew rightward from the icon's shoulder, and
 * "128" ended 5.4px past the rail, with even a two-digit ring notching its border. The fixture's 4
 * blocked and 4 stalled sessions make 8; `more-blocked` adds sessions waiting on the user.
 */
for (const [label, device] of [
  ["at 1440×900 with a mouse", { viewport: { width: 1440, height: 900 } }],
  ["in the compact tier at 940×600", { viewport: { width: 940, height: 600 } }],
  ["on an 834px coarse-pointer tablet", { viewport: { width: 834, height: 1112 }, hasTouch: true, isMobile: true }],
] as const) {
  test.describe(label, () => {
    test.use(device);

    const sessionsItem = (page: Page) =>
      page.getByRole("navigation", { name: "Primary Navigation" }).getByRole("link", { name: "Sessions", exact: true });
    const placement = (page: Page) => sessionsItem(page).evaluate((element) => {
      const badge = element.querySelector(".count-badge")!.getBoundingClientRect();
      const railElement = element.closest(".app-rail")!;
      const edge = railElement.getBoundingClientRect().right - parseFloat(getComputedStyle(railElement).borderRightWidth);
      // The glyph of the item above: a lifted badge may rise into that item's foot, never onto its glyph.
      const above = element.previousElementSibling?.querySelector("svg")?.getBoundingClientRect();
      // The ring is 2px outside the badge; it may meet the border but not cover it.
      return {
        width: badge.width,
        overhang: badge.right + 2 - edge,
        rise: element.getBoundingClientRect().top - (badge.top - 2),
        clearsAbove: above ? badge.top - 2 >= above.bottom : true,
      };
    });
    const expectPlaced = async (page: Page, what: string) => {
      const placed = await placement(page);
      expect(placed.overhang, `${what}: the badge and its ring end at or inside the rail's border`).toBeLessThanOrEqual(0);
      expect(placed.clearsAbove, `${what}: the ring stops short of the glyph of the item above`).toBe(true);
      // The lift is capped at 7px, on top of the shoulder's 1px to 3px.
      expect(placed.rise, `${what}: rises no more than the capped lift`).toBeLessThanOrEqual(10);
      expect(await glyphUnderMark(page, sessionsItem(page)), `${what}: the badge and its ring cover none of the glyph`).toBe(0);
      return placed;
    };

    for (const [extra, count] of [[0, "8"], [7, "15"], [120, "128"]] as const) {
      test(`a Sessions badge of ${count} and its ring stay inside the rail, clear of the glyph (#2110)`, async ({ page }) => {
        const sessions = sessionsItem(page);
        for (const path of ["/projects", undefined]) {
          await page.goto(`${fullShell(path)}&more-blocked=${extra}`);
          await expect(sessions.locator(".count-badge.danger.on-icon")).toHaveText(count);
          // At rest on Projects, then on the current item, whose ring follows the selected fill.
          if (path) await expect(sessions).not.toHaveAttribute("aria-current", "page");
          else await expect(sessions).toHaveAttribute("aria-current", "page");
          const placed = await expectPlaced(page, count);
          // One digit fits beside the glyph in any face and does not move. Three digits never fit, so
          // they rise out of the item: the one accepted exception (#2110).
          if (count === "8") expect(placed.rise).toBeLessThanOrEqual(3);
          if (count === "128") expect(placed.rise).toBeGreaterThan(3);
          const { ring, fill } = await ringAndFill(sessions);
          expect(ring).toBe(`${fill} 0px 0px 0px 2px`);
        }
      });
    }

    // A count's width depends on the face system-ui resolves to: "15" is 16.4px in Ubuntu or Arial
    // and 19.3px in DejaVu Sans, which CI's runner uses. The one-digit badge, whose text is narrower
    // than 16px in any face, is set to every width from 16px to 36px through its min-width with no
    // padding, so the sweep covers every one- to four-digit count in any face and does not itself
    // depend on the face.
    test("a badge of any width stays inside the rail and clear of the glyph (#2110)", async ({ page }) => {
      await page.goto(fullShell("/projects"));
      const badge = sessionsItem(page).locator(".count-badge");
      await expect(badge).toHaveText("8");
      for (let width = 16; width <= 36; width += 0.5) {
        await badge.evaluate((element, px) => {
          (element as HTMLElement).style.padding = "0";
          (element as HTMLElement).style.minWidth = `${px}px`;
        }, width);
        expect((await expectPlaced(page, `${width}px wide`)).width).toBeCloseTo(width, 1);
      }
    });
  });
}

test.describe("the rail tooltip at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("states the Sessions breakdown on a second line (#1967)", async ({ page }) => {
    await page.goto(fullShell("/projects"));
    const sessions = page.getByRole("navigation", { name: "Primary Navigation" }).getByRole("link", { name: "Sessions", exact: true });
    await sessions.hover();
    const tooltip = page.locator(".rail-tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator(".rail-tooltip-note")).toHaveText("4 waiting on you, 4 stalled");
    const lines = await tooltip.evaluate((element) => {
      const note = element.querySelector(".rail-tooltip-note")!.getBoundingClientRect();
      const keys = element.querySelector("kbd")!.getBoundingClientRect();
      return { below: note.top >= keys.bottom - 1, width: element.getBoundingClientRect().width };
    });
    expect(lines.below, "the breakdown is a second line under the name and keycap").toBe(true);
    expect(lines.width).toBeLessThanOrEqual(280);
  });
});
