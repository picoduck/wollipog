import { expect, test } from "@playwright/test";
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
  await expect(page.locator('[data-focus-zone="detail"] .detail-scroll, [data-focus-zone="detail"] .inbox-preview-empty')).toBeFocused();
  await page.keyboard.press("1");
  await expect(grid).toBeFocused();
  await grid.press("ArrowUp");
  const firstId = await grid.getByRole("row").first().getAttribute("id");
  expect(firstId).toBeTruthy();
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
  await expect(grid.locator(".inbox-status-pill-count")).toHaveCount(4);
  await expect(grid.locator(".inbox-status-pill-count").first()).toHaveText("2");
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
  await page.keyboard.press("Escape");
  // The modal owns global shortcuts until React has unmounted it. Refocusing the background and
  // sending F6 before that boundary settles races the app's intentional shortcut-layer guard on
  // slower runners. Wait for closure and the modal's asynchronous return-focus contract, then
  // send the global key from the element that actually owns focus.
  await expect(shortcutDialog).toBeHidden();
  await expect(grid).toBeFocused();
  await page.keyboard.press("F6");
  await expect(page.locator('[data-focus-zone="detail"] .detail-scroll, [data-focus-zone="detail"] .inbox-preview-empty')).toBeFocused();
  await grid.focus();
  const previousRow = await grid.getAttribute("aria-activedescendant");
  await grid.press("j");
  await expect(grid).not.toHaveAttribute("aria-activedescendant", previousRow!);
  await grid.press("/");
  await expect(page.locator(".inbox-search input")).toBeFocused();
  await page.locator(".inbox-search input").fill("Session");
  await page.locator(".inbox-search input").press("Escape");
  await expect(page.locator(".inbox-search input")).toHaveValue("");
  // F2 opens the selected session on its top-priority request; the session's own request card
  // takes a primary request, and the Agents panel offers the way there.
  await page.locator(".inbox-row-shell", { hasText: "Running Session" }).locator(".inbox-row").click();
  await grid.focus();
  await grid.press("F2");
  const panel = page.getByRole("complementary", { name: "Agents", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Open Request in Session", exact: true })).toBeFocused();
  await page.reload();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Open Request in Session", exact: true })).toBeFocused();
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
    const headerAttention = page.getByRole("button", { name: "Attention: 2 Actions Required", exact: true });
    await closePanel.click();
    await headerAttention.click();
    await expect(panel).toBeVisible();
    await closePanel.click();
    await headerAttention.click();
    await expect(panel).toBeVisible();
  }
  await page.screenshot({ path: `.agents/tmp/attention-followup/shell-route-${width}.png`, fullPage: true });
});
