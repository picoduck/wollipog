import { expect, test, type Page } from "@playwright/test";

/**
 * One Sessions state per situation (#2220) in the real Shell: an empty group replaces both panes,
 * a syncing group shows skeleton rows, and a lost connection dims the last list under Reconnecting.
 * The per-situation copy and actions are the DOM half, InboxView.states.dom.test.tsx.
 */
const fixture = (state: string, path?: string) =>
  `/sessions-states-e2e.html?state=${state}${path === undefined ? "" : `&path=${encodeURIComponent(path)}`}`;
const DOCS_TAB = "/?tab=project%3Aproject-docs";

async function open(page: Page, url: string, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto(url);
  await expect(page.locator(".inbox-view")).toBeVisible();
}

test("with zero sessions at 1440×900 the page shows one state under the tab row and no preview", async ({ page }) => {
  await open(page, fixture("first-run"), { width: 1440, height: 900 });
  const state = page.locator(".inbox-state");
  await expect(state.getByRole("heading", { name: "No Sessions Yet", level: 2 })).toBeVisible();
  await expect(page.locator(".inbox-state")).toHaveCount(1);
  await expect(page.locator(".inbox-preview-pane")).toHaveCount(0);
  await expect(page.locator(".master-detail-resize")).toHaveCount(0);
  await expect(page.getByText("Select a Session")).toHaveCount(0);
  await expect(page.getByText("All Agents Unblocked")).toHaveCount(0);
  // One New Session on the page: the state's, not the header's too.
  await expect(page.getByRole("button", { name: "New Session", exact: true })).toHaveCount(1);
  await expect(state.getByRole("button", { name: "New Session", exact: true })).toBeVisible();
  await expect(page.locator(".page-header .page-primary")).toHaveCount(0);
  // Under the tab row, top-left on the page grid: its title starts where the page title does.
  const [tabs, title, pageTitle] = await Promise.all([
    page.locator(".page-header .tabs-bar").boundingBox(),
    state.locator(".state-title").boundingBox(),
    page.locator("#page-title").boundingBox(),
  ]);
  expect(title!.y).toBeGreaterThanOrEqual(tabs!.y + tabs!.height);
  expect(Math.abs(title!.x - pageTitle!.x)).toBeLessThanOrEqual(1);
});

test("a state's actions are full width and 44px tall at 390×844", async ({ page }) => {
  await open(page, fixture("first-run"), { width: 390, height: 844 });
  const state = page.locator(".inbox-state .state");
  await expect(state.getByRole("heading", { name: "No Sessions Yet" })).toBeVisible();
  const actions = state.locator(".actions");
  const actionsBox = (await actions.boundingBox())!;
  const stateBox = (await state.boundingBox())!;
  expect(Math.abs(actionsBox.width - stateBox.width)).toBeLessThanOrEqual(1);
  const buttons = actions.getByRole("button");
  await expect(buttons).toHaveCount(2);
  for (const button of await buttons.all()) {
    const box = (await button.boundingBox())!;
    expect(box.height).toBe(44);
    expect(Math.abs(box.width - actionsBox.width)).toBeLessThanOrEqual(1);
  }
});

test("a Project with unsynced sessions shows skeleton rows and Loading 8 sessions…, then rows, with no state between", async ({ page }) => {
  await open(page, fixture("syncing", DOCS_TAB), { width: 1440, height: 900 });
  const skeleton = page.locator(".inbox-skeleton");
  await expect(skeleton.getByRole("status")).toHaveText("Loading 8 sessions…");
  const rows = skeleton.locator(".inbox-skeleton-row");
  await expect(rows).toHaveCount(6);
  const rowHeight = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-h-2")));
  for (const row of await rows.all()) expect((await row.boundingBox())!.height).toBe(rowHeight);
  await expect(page.locator(".inbox-preview-pane .inbox-preview-skeleton .skeleton-bar")).toBeVisible();
  await expect(page.locator(".inbox-state")).toHaveCount(0);
  // Watch every mutation from here to the rows: a state card must never mount in between.
  await page.evaluate(() => {
    (window as unknown as { __stateSeen: boolean }).__stateSeen = false;
    new MutationObserver(() => {
      if (document.querySelector(".inbox-state")) (window as unknown as { __stateSeen: boolean }).__stateSeen = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.evaluate(() => window.__deliverSessions());
  const grid = page.getByRole("grid", { name: "Sessions", exact: true });
  await expect(grid.getByRole("row")).toHaveCount(8);
  await expect(skeleton).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __stateSeen: boolean }).__stateSeen)).toBe(false);
});

test("disconnecting keeps the rows visible and dimmed under Reconnecting…, and reconnecting removes the dimming", async ({ page }) => {
  await open(page, fixture("sessions", DOCS_TAB), { width: 1440, height: 900 });
  const grid = page.getByRole("grid", { name: "Sessions", exact: true });
  const title = grid.locator(".inbox-row-title").first();
  await expect(title).toBeVisible();
  const colors = await page.evaluate(() => {
    const probe = document.createElement("span");
    document.body.append(probe);
    probe.style.color = "var(--text)";
    const text = getComputedStyle(probe).color;
    probe.style.color = "var(--text-dim)";
    const dim = getComputedStyle(probe).color;
    probe.remove();
    return { text, dim };
  });
  expect(colors.text).not.toBe(colors.dim);
  await expect(title).toHaveCSS("color", colors.text);
  await expect(page.locator(".inbox-list-status")).toHaveCount(0);

  await page.evaluate(() => window.__dropConnection());
  const line = page.locator(".inbox-list-pane > .inbox-list-status");
  await expect(line).toHaveText("Reconnecting…");
  await expect(line).toHaveCSS("color", colors.dim);
  await expect(grid.getByRole("row")).toHaveCount(5);
  await expect(title).toBeVisible();
  await expect(title).toHaveCSS("color", colors.dim);
  await expect(page.locator(".inbox-state")).toHaveCount(0);
  await expect(page.getByText(/No Sessions Yet|All Agents Unblocked/)).toHaveCount(0);
  // Readable and operable: the list still takes focus and moves its selection.
  await grid.focus();
  const before = await grid.getAttribute("aria-activedescendant");
  await grid.press("ArrowDown");
  await expect(grid).not.toHaveAttribute("aria-activedescendant", before!);

  // The store retries on a new socket (1.5s after the drop); the restore answers that one.
  await expect.poll(() => page.evaluate(() => window.__retryPending()), { timeout: 10_000 }).toBe(true);
  await page.evaluate(() => window.__restoreConnection());
  await expect(line).toHaveCount(0);
  await expect(title).toHaveCSS("color", colors.text);
  await expect(grid.getByRole("row")).toHaveCount(5);
});
