import { expect, test, type Locator, type Page } from "@playwright/test";

function terminalRows(terminal: Locator): Locator {
  return terminal.locator(".xterm-rows");
}

async function waitForHarness(page: Page): Promise<void> {
  const response = await page.goto("/xterm-smoke-e2e.html");
  expect(response?.ok(), "xterm fixture page should be served").toBe(true);
  await expect.poll(() => page.evaluate(() => typeof window.__WOLLIPOG_XTERM_E2E__)).toBe("object");
}

test.beforeEach(async ({ page }) => {
  await waitForHarness(page);
});

test("renders initial and incremental raw output once, including split ANSI input @production", async ({ page }) => {
  const terminal = page.getByRole("region", { name: "Interactive Terminal Fixture" });
  await expect(terminal.locator(".xterm")).toBeVisible();
  await expect(terminalRows(terminal)).toContainText("Initial terminal output");

  await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.appendInteractive("Incremental output\r\n"));
  await expect(terminalRows(terminal)).toContainText("Incremental output");
  await expect.poll(async () => (await terminalRows(terminal).innerText()).match(/Initial terminal output/g)?.length ?? 0)
    .toBe(1);
  await expect.poll(async () => (await terminalRows(terminal).innerText()).match(/Incremental output/g)?.length ?? 0)
    .toBe(1);

  const rowsBeforePartialEscape = await terminalRows(terminal).innerText();
  await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.appendInteractive("\u001b[31"));
  await expect.poll(() => terminalRows(terminal).innerText()).toBe(rowsBeforePartialEscape);
  await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.appendInteractive("mSplit red\u001b[0m survives\r\n"));
  await expect(terminalRows(terminal)).toContainText("Split red survives");
  await expect(terminalRows(terminal)).not.toContainText("mSplit red survives");
  await expect(terminalRows(terminal).locator("span").filter({ hasText: "Split red" })).toHaveClass(/xterm-fg-1/);

  await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.setSearchTerm("survives"));
  await expect(terminal.locator(".xterm-selection div")).not.toHaveCount(0);
});

test("sends interactive input once and keeps the read-only terminal inert @production", async ({ page }) => {
  const interactive = page.getByRole("region", { name: "Interactive Terminal Fixture" });
  const readonly = page.getByRole("region", { name: "Read-Only Terminal Fixture" });
  await expect(interactive.locator(".xterm-helper-textarea")).toBeAttached();
  await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.clearLogs());

  await interactive.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("q");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.logs().interactive.input)).toEqual(["q"]);

  await readonly.locator(".xterm-helper-textarea").focus();
  await expect(readonly.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type("blocked");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.logs().readonly.input)).toEqual([]);
});

test("reports fitted dimensions, refits on resize, and preserves usable scrollback @production", async ({ page }) => {
  const terminal = page.getByRole("region", { name: "Interactive Terminal Fixture" });
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.logs().interactive.resizes.at(-1)))
    .toMatchObject({ cols: expect.any(Number), rows: expect.any(Number) });
  const initial = await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.logs().interactive.resizes.at(-1)!);
  expect(initial.cols).toBeGreaterThan(0);
  expect(initial.rows).toBeGreaterThan(0);

  await page.evaluate(() => {
    window.__WOLLIPOG_XTERM_E2E__.clearLogs();
    window.__WOLLIPOG_XTERM_E2E__.resizeInteractive(360, 120);
  });
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.logs().interactive.resizes.at(-1)))
    .toMatchObject({ cols: expect.any(Number), rows: expect.any(Number) });
  const resized = await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.logs().interactive.resizes.at(-1)!);
  expect(resized.cols).toBeGreaterThan(0);
  expect(resized.rows).toBeGreaterThan(0);
  expect(resized.cols).toBeLessThan(initial.cols);
  expect(resized.rows).toBeLessThan(initial.rows);

  const output = Array.from({ length: 120 }, (_, index) => `scrollback-${index}\r\n`).join("");
  await page.evaluate((chunk) => window.__WOLLIPOG_XTERM_E2E__.appendInteractive(chunk), output);
  await expect(terminalRows(terminal)).toContainText("scrollback-119");
  const bottomRows = await terminalRows(terminal).innerText();
  await terminal.locator(".xterm").hover();
  await page.mouse.wheel(0, -500);
  await expect.poll(() => terminalRows(terminal).innerText()).not.toBe(bottomRows);
  await expect(terminalRows(terminal)).not.toContainText("scrollback-119");
  await page.mouse.wheel(0, 1_000);
  await expect(terminalRows(terminal)).toContainText("scrollback-119");
});

test("keeps terminal shortcuts in xterm and supports the terminal-exit shortcut", async ({ page }) => {
  const terminal = page.getByRole("region", { name: "Interactive Terminal Fixture" });
  const textarea = terminal.locator(".xterm-helper-textarea");
  await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.clearLogs());

  const exitTarget = page.locator(".detail-scroll");
  await exitTarget.focus();
  await page.keyboard.press("c");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.logs().appShortcutCount)).toBe(1);

  await textarea.focus();
  await page.keyboard.press("c");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.logs())).toMatchObject({
    interactive: { input: ["c"] },
    appShortcutCount: 1,
  });

  await page.keyboard.press("Escape");
  await expect(textarea).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.logs().interactive.input)).toEqual(["c", "\u001b"]);

  await page.keyboard.press("Control+Escape");
  await expect(page.locator(".detail-scroll")).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.logs().interactive.input)).toEqual(["c", "\u001b"]);
});
