import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The session's terminals outlive the dock (#2867; docs/design-system.md §4.6): Hide Terminal unmounts
 * the dock, and reopening it shows the same tab, the same search and each tab's scrollback and scroll
 * position, from the same terminals, without fetching any history again.
 */

const shownTerminal = (dock: Locator) => dock.locator(".shell-term:not(.is-hidden)");
const historyRequests = (page: Page) => page.evaluate(() => window.__WOLLIPOG_SHELL_DOCK_E2E__.historyRequests());

test.use({ viewport: { width: 1440, height: 900 } });

test("hiding and reopening the dock keeps the tab, the search and each tab's scrollback and scroll position", async ({ page }) => {
  const response = await page.goto("/shell-dock-e2e.html?long=1&toggle=1");
  expect(response?.ok(), "shell dock fixture page should be served").toBe(true);
  const dock = page.getByRole("region", { name: "Terminal" });
  const rows = () => shownTerminal(dock).locator(".xterm-rows");
  await expect(rows()).toContainText("3 files passed");

  // Shell 1 scrolled back, then Shell 2 selected and searched.
  await shownTerminal(dock).locator(".xterm").hover();
  await page.mouse.wheel(0, -1200);
  await expect(rows()).not.toContainText("3 files passed");
  const scrolled = await rows().innerText();
  await dock.getByRole("tab", { name: /Shell 2/ }).click();
  await expect(rows()).toContainText("VITE ready");
  await dock.getByRole("button", { name: "Search Output" }).click();
  await dock.getByRole("textbox", { name: "Search Output" }).fill("VITE");
  await expect(dock.locator(".shell-search-count")).toHaveText("1 of 1");
  const shell2Text = await rows().innerText();
  const fetched = await historyRequests(page);

  await dock.getByRole("button", { name: "Hide Terminal" }).click();
  await expect(dock).toHaveCount(0);
  await page.getByRole("button", { name: "Show Terminal" }).click();

  await expect(dock.getByRole("tab", { name: /Shell 2/ })).toHaveAttribute("aria-selected", "true");
  await expect(dock.getByRole("textbox", { name: "Search Output" })).toHaveValue("VITE");
  await expect(dock.locator(".shell-search-count")).toHaveText("1 of 1");
  await expect.poll(() => rows().innerText()).toBe(shell2Text);
  await dock.getByRole("tab", { name: /Shell 1/ }).click();
  await expect.poll(() => rows().innerText(), { message: "Shell 1 is where it was scrolled to" }).toBe(scrolled);
  expect(await historyRequests(page), "reopening fetches no history").toBe(fetched);
});
