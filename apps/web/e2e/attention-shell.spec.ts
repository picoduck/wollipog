import { expect, test } from "@playwright/test";
test.use({ video: "on" });

test("real shell preserves global shortcuts and selected-row request traversal", async ({ page }) => {
  await page.goto("/sessions-board-e2e.html?full-shell=1");
  const grid = page.getByRole("grid", { name: "Sessions", exact: true });
  await expect(grid).toBeVisible();
  await expect(grid.locator(".attention-requests > summary")).toHaveCount(5);
  await expect(grid.locator('.attention-requests > summary[tabindex="0"]')).toHaveCount(1);
  await grid.focus();
  await grid.press("F2");
  const summary = grid.locator('.attention-requests > summary[tabindex="0"]');
  await expect(summary).toBeFocused();
  await summary.press("a");
  expect(await page.evaluate(() => window.__approveCalls)).toEqual([]);
  for (const chord of ["Control+k", "Meta+k"]) {
    await summary.focus();
    await summary.press(chord);
    await expect(page.getByRole("dialog", { name: "Search", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await summary.focus();
  await summary.press("Shift+?");
  await expect(page.getByRole("dialog", { name: "Keyboard Shortcuts", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await summary.focus();
  await summary.press("F6");
  await expect(summary).not.toBeFocused();
  await summary.focus();
  await summary.press("Enter");
  await summary.press("Tab");
  const group = grid.locator('.inbox-row-shell[aria-selected="true"]').getByRole("group", { name: "Pending Requests" });
  await expect(group.getByRole("button").first()).toBeFocused();
  await group.getByRole("button").first().press("Control+k");
  await expect(page.getByRole("dialog", { name: "Search", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await group.getByRole("button").first().focus();
  await page.keyboard.press("Escape");
  await expect(summary).toBeFocused();
  await expect(grid.locator("details[open]")).toHaveCount(0);
  await summary.press("Shift+Tab");
  await expect(grid).toBeFocused();
  const previousRow = await grid.getAttribute("aria-activedescendant");
  await grid.press("j");
  await expect(grid).not.toHaveAttribute("aria-activedescendant", previousRow!);
  await expect(grid.locator('.attention-requests > summary[tabindex="0"]')).toHaveCount(1);
  await grid.press("F2");
  await expect(summary).toBeFocused();
  await summary.press("/");
  await expect(page.locator(".inbox-search input")).toBeFocused();
  await page.locator(".inbox-search input").fill("Session");
  await summary.focus();
  await summary.press("Escape");
  await expect(page.locator(".inbox-search input")).toHaveValue("");
  await page.screenshot({ path: ".agents/tmp/attention-followup/keyboard-shell.png", fullPage: true });
});

for (const width of [390, 1280]) test(`real shell threads an exact attention route through the panel at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/sessions-board-e2e.html?full-shell=1");
  const row = page.locator(".inbox-row-shell", { hasText: "Approval Session" });
  await row.locator("summary").click();
  // Focusing a nonselected picker must select it without expanding the mobile session.
  await expect(row).toHaveAttribute("aria-selected", "true");
  await row.getByRole("button", { name: "Request 2 · Child Approval Required", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Agents", exact: true });
  await expect(panel).toBeVisible();
  const request = panel.getByRole("region", { name: "Selected Worker Request", exact: true });
  await expect(request).toBeFocused();
  await expect(request.getByText("Exact Child Request 3", { exact: true })).toBeVisible();
  await page.reload();
  await expect(panel).toBeVisible();
  await expect(request).toBeFocused();
  await expect(request.getByText("Exact Child Request 3", { exact: true })).toBeVisible();
  await page.screenshot({ path: `.agents/tmp/attention-followup/shell-route-${width}.png`, fullPage: true });
});

test("the shell route effect opens Agents even without automatic child-attention entry", async ({ page }) => {
  await page.goto("/sessions-board-e2e.html?full-shell=1");
  const row = page.locator(".inbox-row-shell", { hasText: "Running Session" });
  await row.locator("summary").click();
  await row.getByRole("button", { name: "Request 1 · Approval Required", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Agents", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Open Request in Session", exact: true })).toBeFocused();
  await page.reload();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Open Request in Session", exact: true })).toBeFocused();
});
