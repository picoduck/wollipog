import { expect, test, type Locator, type Page } from "@playwright/test";

function terminalRows(terminal: Locator): Locator {
  return terminal.locator(".xterm-rows");
}

async function waitForHarness(page: Page): Promise<void> {
  const response = await page.goto("/xterm-smoke-e2e.html");
  expect(response?.ok(), "xterm fixture page should be served").toBe(true);
  await expect.poll(() => page.evaluate(() => typeof window.__WOLLIPOG_XTERM_E2E__)).toBe("object");
}

const SEARCH_DURING_FONT_LOAD_TEST = "applies search entered while the terminal font is still loading @production";
/** Tests that drive the real Shell's terminal hosts rather than this fixture page. */
const HOST_MOVES = "terminal hosts in the Shell";

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title === SEARCH_DURING_FONT_LOAD_TEST || testInfo.title.startsWith("the active search match") ||
    testInfo.titlePath.includes(HOST_MOVES)) return;
  await waitForHarness(page);
});

test.describe(HOST_MOVES, () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  // #2868: the side panel's Terminal tool and the dock show the same session terminals, so moving
  // between them reparents each xterm; the shell, its process and its scrollback never restart.
  test("a process started in a panel shell is still running in the same dock tab after Move to Bottom Dock, with its scrollback", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("wollipog.terminal.placement", "panel"));
    const response = await page.goto("/command-inbox-projects-e2e.html?fullShell=1&terminalShells=2");
    expect(response?.ok(), "fixture page should be served").toBe(true);
    await page.getByRole("button", { name: /Alpha Session/ }).first().click();
    await page.getByRole("button", { name: "Open Session" }).click();
    await page.getByRole("button", { name: "Side Panel", exact: true }).first().click();
    const panel = page.locator("#right-panel");
    await panel.locator('.session-tool[data-tool="terminal"]').click();
    const panelRows = panel.locator(".shell-term:not(.is-hidden) .xterm-rows");
    await expect(panelRows).toContainText("24 files passed");
    const calls = () => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.shellCalls());

    // `sleep 60` in Shell 1: the shell echoes it, so it is part of the scrollback.
    await panel.locator(".shell-term:not(.is-hidden) .xterm-helper-textarea").focus();
    await page.keyboard.type("sleep 60");
    await page.keyboard.press("Enter");
    await expect(panelRows).toContainText("sleep 60");
    // Typing reaches the shell in batches, however the keys fall into them: only what arrives counts.
    await expect.poll(async () => {
      const { input } = await calls();
      return { shells: [...new Set(input.map((entry) => entry.shellId))], typed: input.map((entry) => entry.data).join("") };
    }).toEqual({ shells: ["shell-1"], typed: "sleep 60\r" });

    await panel.getByRole("button", { name: "More Terminal Actions" }).click();
    await page.getByRole("menuitem", { name: /Move to Bottom Dock/ }).click();

    const dock = page.getByRole("region", { name: "Terminal" });
    await expect(dock).toBeVisible();
    await expect(panel).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("wollipog.terminal.placement"))).toBe("dock");
    await expect(dock.getByRole("tab", { name: /Shell 1/ })).toHaveAttribute("aria-selected", "true");
    const dockTerminal = dock.locator(".shell-term:not(.is-hidden)");
    await expect(dockTerminal.locator(".xterm-rows")).toContainText("sleep 60");
    await expect(dockTerminal.locator(".xterm-rows")).toContainText("24 files passed");
    // Focus moved with it, so the next key reaches the same shell: its process was never restarted.
    await expect(dockTerminal.locator(".xterm-helper-textarea")).toBeFocused();
    await page.keyboard.press("Control+c");
    await expect.poll(async () => (await calls()).input.at(-1)).toEqual({ shellId: "shell-1", data: "\u0003" });
    const { opens, closes } = await calls();
    expect({ opens, closes }, "no shell was opened or closed by the move").toEqual({ opens: 0, closes: [] });
  });

  // #2869: Move to Right Panel from the dock, then Move to Bottom Dock from the panel, is the same
  // terminal the whole way: the process, its tab and scrollback, and no history is read again.
  test("a process started in a dock shell is still running in the same tab after Move to Right Panel and Move to Bottom Dock, with no history read again", async ({ page }) => {
    const response = await page.goto("/command-inbox-projects-e2e.html?fullShell=1&terminalShells=2");
    expect(response?.ok(), "fixture page should be served").toBe(true);
    await page.getByRole("button", { name: /Alpha Session/ }).first().click();
    await page.getByRole("button", { name: "Open Session" }).click();
    await page.getByRole("button", { name: "Terminal", exact: true }).first().click();
    const dock = page.getByRole("region", { name: "Terminal" });
    const dockRows = dock.locator(".shell-term:not(.is-hidden) .xterm-rows");
    await expect(dockRows).toContainText("24 files passed");
    const calls = () => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.shellCalls());
    // Both shells' history, read once when the dock first showed them.
    await expect.poll(async () => [...(await calls()).histories].sort()).toEqual(["shell-1", "shell-2"]);

    await dock.locator(".shell-term:not(.is-hidden) .xterm-helper-textarea").focus();
    await page.keyboard.type("sleep 60");
    await page.keyboard.press("Enter");
    await expect(dockRows).toContainText("sleep 60");
    await expect.poll(async () => {
      const { input } = await calls();
      return { shells: [...new Set(input.map((entry) => entry.shellId))], typed: input.map((entry) => entry.data).join("") };
    }).toEqual({ shells: ["shell-1"], typed: "sleep 60\r" });

    await dock.getByRole("button", { name: "More Terminal Actions" }).click();
    await page.getByRole("menuitem", { name: /Move to Right Panel/ }).click();

    const panel = page.locator("#right-panel");
    await expect(panel).toHaveAttribute("data-mode", "terminal");
    await expect(dock).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("wollipog.terminal.placement"))).toBe("panel");
    await expect(panel.getByRole("tab", { name: /Shell 1/ })).toHaveAttribute("aria-selected", "true");
    const panelTerminal = panel.locator(".shell-term:not(.is-hidden)");
    await expect(panelTerminal.locator(".xterm-rows")).toContainText("sleep 60");
    await expect(panelTerminal.locator(".xterm-rows")).toContainText("24 files passed");
    await expect(panelTerminal.locator(".xterm-helper-textarea")).toBeFocused();
    await expect(page.getByRole("button", { name: "Terminal", exact: true }).first()).toHaveAttribute("aria-pressed", "true");

    await panel.getByRole("button", { name: "More Terminal Actions" }).click();
    await page.getByRole("menuitem", { name: /Move to Bottom Dock/ }).click();

    await expect(dock).toBeVisible();
    await expect(panel).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("wollipog.terminal.placement"))).toBe("dock");
    await expect(dock.getByRole("tab", { name: /Shell 1/ })).toHaveAttribute("aria-selected", "true");
    await expect(dockRows).toContainText("sleep 60");
    await expect(dockRows).toContainText("24 files passed");
    // Focus came back with it, so the next key reaches the same shell: its process never restarted.
    await expect(dock.locator(".shell-term:not(.is-hidden) .xterm-helper-textarea")).toBeFocused();
    await page.keyboard.press("Control+c");
    await expect.poll(async () => (await calls()).input.at(-1)).toEqual({ shellId: "shell-1", data: "\u0003" });
    const { opens, closes, histories } = await calls();
    expect({ opens, closes }, "no shell was opened or closed by either move").toEqual({ opens: 0, closes: [] });
    expect([...histories].sort(), "no history was read again by either move").toEqual(["shell-1", "shell-2"]);
  });

  // A move's focus request waits for its destination to mount, however long its code takes to arrive:
  // the first Move to Right Panel on a slow network still lands focus in the moved terminal.
  test("the first Move to Right Panel focuses the moved terminal even when the Terminal tool's code is slow to arrive", async ({ page }) => {
    let toolRequested = false;
    await page.route(/\/src\/components\/TerminalTool\.tsx/u, async (route) => {
      toolRequested = true;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });
    const response = await page.goto("/command-inbox-projects-e2e.html?fullShell=1&terminalShells=2");
    expect(response?.ok(), "fixture page should be served").toBe(true);
    await page.getByRole("button", { name: /Alpha Session/ }).first().click();
    await page.getByRole("button", { name: "Open Session" }).click();
    await page.getByRole("button", { name: "Terminal", exact: true }).first().click();
    const dock = page.getByRole("region", { name: "Terminal" });
    await expect(dock.locator(".shell-term:not(.is-hidden) .xterm-rows")).toContainText("24 files passed");
    expect(toolRequested, "nothing has asked for the Terminal tool's code before the move").toBe(false);

    await dock.getByRole("button", { name: "More Terminal Actions" }).click();
    await page.getByRole("menuitem", { name: /Move to Right Panel/ }).click();
    const panel = page.locator("#right-panel");
    await expect(panel.getByText("Loading terminal…")).toBeVisible();
    expect(toolRequested).toBe(true);
    await expect(panel.locator(".shell-term:not(.is-hidden) .xterm-helper-textarea")).toBeFocused();
  });

  // A move abandoned before its destination mounts takes no focus later: closing the panel while the
  // Terminal tool loads, then typing in the composer, keeps the keys out of the shell when another window
  // puts the terminal back in the dock.
  test("an abandoned Move to Right Panel never moves focus later, so typing in the composer stays there", async ({ page, context }) => {
    await page.route(/\/src\/components\/TerminalTool\.tsx/u, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });
    const response = await page.goto("/command-inbox-projects-e2e.html?fullShell=1&terminalShells=2");
    expect(response?.ok(), "fixture page should be served").toBe(true);
    await page.getByRole("button", { name: /Alpha Session/ }).first().click();
    await page.getByRole("button", { name: "Open Session" }).click();
    await page.getByRole("button", { name: "Terminal", exact: true }).first().click();
    const dock = page.getByRole("region", { name: "Terminal" });
    await expect(dock.locator(".shell-term:not(.is-hidden) .xterm-rows")).toContainText("24 files passed");

    await dock.getByRole("button", { name: "More Terminal Actions" }).click();
    await page.getByRole("menuitem", { name: /Move to Right Panel/ }).click();
    const panel = page.locator("#right-panel");
    await expect(panel.getByText("Loading terminal…")).toBeVisible();
    await page.getByRole("button", { name: "Side Panel", exact: true }).first().click();
    await expect(panel).toHaveCount(0);

    const composer = page.locator(".composer-input");
    await composer.click();
    await page.keyboard.type("draft");
    // Another window puts the terminal back in the dock, which shows again (its visibility was kept).
    const other = await context.newPage();
    await other.goto(`/command-inbox-projects-e2e.html?fullShell=1&path=${encodeURIComponent("/settings/appearance")}`);
    await other.getByRole("radiogroup", { name: "Terminal Placement" }).getByRole("radio", { name: "Bottom Dock" }).click();
    await expect(dock.locator(".shell-term:not(.is-hidden) .xterm-rows")).toContainText("24 files passed");
    // Past the frame the dock's host would have moved focus in.
    await page.waitForTimeout(500);
    await expect(composer).toBeFocused();
    await page.keyboard.type(" more");
    await expect(composer).toHaveValue("draft more");
    const { input } = await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.shellCalls());
    expect(input, "no key reached a shell").toEqual([]);
    await other.close();
  });

  // Turning to the composer while the moved terminal loads ends the move's claim on focus: the
  // Terminal tool arriving afterwards leaves the composer focused, so its keys never reach the shell.
  test("typing in the composer while a moved terminal loads keeps focus there when it arrives", async ({ page }) => {
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
    await page.route(/\/src\/components\/TerminalTool\.tsx/u, async (route) => {
      await toolGate;
      await route.continue();
    });
    const response = await page.goto("/command-inbox-projects-e2e.html?fullShell=1&terminalShells=2");
    expect(response?.ok(), "fixture page should be served").toBe(true);
    await page.getByRole("button", { name: /Alpha Session/ }).first().click();
    await page.getByRole("button", { name: "Open Session" }).click();
    await page.getByRole("button", { name: "Terminal", exact: true }).first().click();
    const dock = page.getByRole("region", { name: "Terminal" });
    await expect(dock.locator(".shell-term:not(.is-hidden) .xterm-rows")).toContainText("24 files passed");

    await dock.getByRole("button", { name: "More Terminal Actions" }).click();
    await page.getByRole("menuitem", { name: /Move to Right Panel/ }).click();
    const panel = page.locator("#right-panel");
    await expect(panel.getByText("Loading terminal…")).toBeVisible();

    const composer = page.locator(".composer-input");
    await composer.click();
    await page.keyboard.type("draft");
    releaseTool();
    await expect(panel.locator(".shell-term:not(.is-hidden) .xterm-rows")).toContainText("24 files passed");
    // Past the frame the tool's host would have moved focus in.
    await page.waitForTimeout(500);
    await expect(composer).toBeFocused();
    await page.keyboard.type(" more");
    await expect(composer).toHaveValue("draft more");
    const { input } = await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.shellCalls());
    expect(input, "no key reached a shell").toEqual([]);
  });
});

test(SEARCH_DURING_FONT_LOAD_TEST, async ({ page }) => {
  let releaseFont!: () => void;
  const fontGate = new Promise<void>((resolve) => { releaseFont = resolve; });
  await page.route(/WollipogJetBrainsMonoNerd-Regular.*\.woff2$/u, async (route) => {
    await fontGate;
    await route.continue();
  });
  const response = await page.goto("/xterm-smoke-e2e.html");
  expect(response?.ok()).toBe(true);
  await expect.poll(() => page.evaluate(() => typeof window.__WOLLIPOG_XTERM_E2E__)).toBe("object");
  await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.setSearchTerm("Initial terminal"));
  releaseFont();

  const terminal = page.getByRole("region", { name: "Interactive Terminal Fixture" });
  await expect(terminal.locator(".xterm")).toBeVisible();
  await expect(terminal.locator(".xterm-selection div")).not.toHaveCount(0);
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
  const readonly = page.getByRole("region", { name: "Read-Only Terminal Fixture" });
  await expect(terminalRows(terminal)).toContainText("Glyphs:   󰊢 │ ─ é Ж 日本語");
  await expect(terminalRows(readonly)).toContainText("Glyphs:   󰊢 │ ─ é Ж 日本語");
  const fontState = await page.evaluate(async () => {
    await document.fonts.ready;
    const family = "Wollipog JetBrainsMono Nerd Font";
    const resources = performance.getEntriesByType("resource").map((entry) => entry.name);
    return {
      loaded: document.fonts.check(`12.5px "${family}"`, "  󰊢 │ ─ é Ж"),
      terminalFamily: getComputedStyle(document.querySelector(".shell-term:not(.is-readonly) .xterm-rows")!).fontFamily,
      readonlyFamily: getComputedStyle(document.querySelector(".shell-term.is-readonly .xterm-rows")!).fontFamily,
      promptFamily: getComputedStyle(document.querySelector(".shell-prompt")!).fontFamily,
      inputFamily: getComputedStyle(document.querySelector(".shell-input")!).fontFamily,
      fontResources: resources.filter((url) => /WollipogJetBrainsMonoNerd-Regular.*\.woff2$/u.test(url)),
      origin: location.origin,
    };
  });
  expect(fontState.loaded).toBe(true);
  for (const stack of [fontState.terminalFamily, fontState.readonlyFamily, fontState.promptFamily, fontState.inputFamily]) {
    expect(stack).toContain("Wollipog JetBrainsMono Nerd Font");
  }
  expect(fontState.fontResources).toHaveLength(1);
  expect(new URL(fontState.fontResources[0]!).origin).toBe(fontState.origin);

  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.logs().interactive.resizes.at(-1)))
    .toMatchObject({ cols: expect.any(Number), rows: expect.any(Number) });
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.logs().interactive.resizes.length))
    .toBe(1);
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

test("searches output with a match count, Previous and Next, Enter, Shift+Enter and Escape (#2864) @production", async ({ page }) => {
  const terminal = page.getByRole("region", { name: "Interactive Terminal Fixture" });
  await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.appendInteractive(
    "test one\r\ntest two\r\nthe test three\r\nlast test\r\ntest\r\n",
  ));
  await expect(terminalRows(terminal)).toContainText("last test");

  await page.getByRole("button", { name: "Search Output" }).click();
  const search = page.getByRole("group", { name: "Search Output" });
  const field = search.getByRole("textbox", { name: "Search Output" });
  await expect(field).toBeFocused();
  await field.fill("test");
  const count = search.getByRole("status");
  await expect(count).toHaveText("1 of 5");
  await search.getByRole("button", { name: "Next Match" }).click();
  await expect(count).toHaveText("2 of 5");
  await field.press("Enter");
  await expect(count).toHaveText("3 of 5");
  await search.getByRole("button", { name: "Previous Match" }).click();
  await expect(count).toHaveText("2 of 5");
  await field.press("Shift+Enter");
  await expect(count).toHaveText("1 of 5");
  // Previous from the first match wraps to the last.
  await field.press("Shift+Enter");
  await expect(count).toHaveText("5 of 5");
  // Output that arrives while searching is counted without moving the selected match.
  await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.appendInteractive("one more test\r\n"));
  await expect(count).toHaveText("5 of 6");

  await field.fill("absent-term");
  await expect(count).toHaveText("No matches");
  await expect(search.getByRole("button", { name: "Next Match" })).toBeDisabled();

  await field.press("Escape");
  await expect(terminal.locator(".xterm-helper-textarea")).toBeFocused();
  await expect(page.getByRole("button", { name: "Search Output" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Search Output" })).toHaveCount(0);
});

test("switching from a scrolled-up tab to another and back keeps its scroll position (#2865) @production", async ({ page }) => {
  const fixture = page.getByRole("region", { name: "Tabbed Terminal Fixture" });
  const tabA = fixture.locator(".shell-term").nth(0);
  await expect(terminalRows(tabA)).toContainText("tab-a-line-199");
  await tabA.locator(".xterm").hover();
  await page.mouse.wheel(0, -1200);
  await expect(terminalRows(tabA)).not.toContainText("tab-a-line-199");
  const scrolled = await terminalRows(tabA).innerText();

  await fixture.getByRole("button", { name: "Tab B" }).click();
  await expect(tabA).toHaveClass(/is-hidden/);
  await expect(terminalRows(fixture.locator(".shell-term").nth(1))).toContainText("tab-b-ready");
  await fixture.getByRole("button", { name: "Tab A" }).click();
  await expect(tabA).not.toHaveClass(/is-hidden/);
  await expect.poll(() => terminalRows(tabA).innerText()).toBe(scrolled);
});

test("a history revision replaces the scrollback after output still being parsed, and a half-read escape (#2865)", async ({ page }) => {
  const terminal = page.getByRole("region", { name: "Interactive Terminal Fixture" });
  await expect(terminalRows(terminal)).toContainText("Initial terminal output");
  // In one task, so xterm has parsed none of it when the history arrives.
  await page.evaluate(() => {
    const harness = window.__WOLLIPOG_XTERM_E2E__;
    harness.appendInteractive("pending-before-reset\r\n");
    harness.appendInteractive("\u001b[31");
    harness.replaceInteractive("restored history line\r\n");
  });
  await expect(terminalRows(terminal)).toContainText("restored history line");
  const text = await terminalRows(terminal).innerText();
  expect(text).not.toContain("pending-before-reset");
  expect(text).not.toContain("Initial terminal output");
  expect(text.match(/restored history line/g)).toHaveLength(1);
  await expect(terminalRows(terminal).locator("span").filter({ hasText: "restored" })).not.toHaveClass(/xterm-fg-1/);
});

test("a shell that takes input again reports its size again, unchanged or after a history reload (#2865)", async ({ page }) => {
  const logs = () => page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.logs().interactive.resizes);
  await expect.poll(async () => (await logs()).length).toBe(1);
  const [size] = await logs();
  await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.clearLogs());

  await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.setInteractiveMode(false));
  await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.setInteractiveMode(true));
  await expect.poll(logs, { message: "a report that may not have arrived is sent again" }).toEqual([size]);

  await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.replaceInteractive("restored after reconnect\r\n"));
  await expect.poll(logs, { message: "a history reload reports the size, as a remount did" }).toEqual([size, size]);
});

test("a terminal listed as a pipe and corrected to a PTY writes the PTY's stream as is (#2865)", async ({ page }) => {
  await page.goto("/xterm-smoke-e2e.html?pty=0");
  await expect.poll(() => page.evaluate(() => typeof window.__WOLLIPOG_XTERM_E2E__)).toBe("object");
  const terminal = page.getByRole("region", { name: "Interactive Terminal Fixture" });
  await expect(terminalRows(terminal)).toContainText("Initial terminal output");
  // The registry corrects the shell to a PTY, and the history reload that follows replays it.
  await page.evaluate(() => {
    window.__WOLLIPOG_XTERM_E2E__.setPtyMode(true);
    window.__WOLLIPOG_XTERM_E2E__.replaceInteractive("abc\nX");
  });
  await expect(terminalRows(terminal)).toContainText("abc");
  // A PTY's bare LF moves down without returning, so X lands under the column after "abc".
  const second = await terminalRows(terminal).locator(":scope > div").nth(1).innerText();
  expect(second.replace(/\u00a0/g, " ")).toMatch(/^ {3}X/);
});

test("a manual selection over the active match takes the active wash with it (#2865)", async ({ page }) => {
  const terminal = page.getByRole("region", { name: "Interactive Terminal Fixture" });
  await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.appendInteractive("test one\r\ntest two\r\n"));
  await expect(terminalRows(terminal)).toContainText("test two");
  await page.getByRole("button", { name: "Search Output" }).click();
  await page.getByRole("textbox", { name: "Search Output" }).fill("test");
  await expect(page.getByRole("group", { name: "Search Output" }).getByRole("status")).toHaveText("1 of 2");
  const washed = () => terminalRows(terminal).evaluate((rows) => [...rows.querySelectorAll<HTMLElement>("span.xterm-decoration-top")]
    .map((span) => span.style.backgroundColor));
  const wash = (await washed())[0];
  expect(wash, "the active match has its wash").toBeTruthy();

  const row = (await terminalRows(terminal).locator(":scope > div").filter({ hasText: "test one" }).boundingBox())!;
  await page.mouse.click(row.x + 40, row.y + row.height / 2, { clickCount: 3 });
  await expect.poll(async () => (await washed()).filter((color) => color === wash).length).toBe(0);
});

test("changing the theme recolours every search highlight, keeping the selected match (#2865)", async ({ page }) => {
  const terminal = page.getByRole("region", { name: "Interactive Terminal Fixture" });
  await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.appendInteractive("test one\r\ntest two\r\nthe test three\r\n"));
  await expect(terminalRows(terminal)).toContainText("the test three");
  await page.getByRole("button", { name: "Search Output" }).click();
  await page.getByRole("textbox", { name: "Search Output" }).fill("test");
  const count = page.getByRole("group", { name: "Search Output" }).getByRole("status");
  await expect(count).toHaveText("1 of 3");
  await page.getByRole("button", { name: "Next Match" }).click();
  await expect(count).toHaveText("2 of 3");
  const fills = () => terminalRows(terminal).evaluate((rows) => [...rows.querySelectorAll<HTMLElement>("span[style*='background-color']")]
    .map((span) => span.style.backgroundColor));
  const dark = new Set(await fills());

  await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.setTheme("light"));
  await expect.poll(async () => (await fills()).filter((color) => dark.has(color)).length, {
    message: "no highlight keeps a dark-theme colour",
  }).toBe(0);
  expect((await fills()).length).toBeGreaterThan(0);
  await expect(count).toHaveText("2 of 3");
});

/** The most common colour in a screenshot, decoded by the page's own canvas. */
async function dominantColor(page: Page, png: Buffer): Promise<[number, number, number]> {
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, image.width, image.height);
    const counts = new Map<string, number>();
    for (let index = 0; index < data.length; index += 4) {
      const key = `${data[index]},${data[index + 1]},${data[index + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const [top] = [...counts].sort((left, right) => right[1] - left[1]);
    return top![0].split(",").map(Number) as [number, number, number];
  }, png.toString("base64"));
}

const colorDistance = (left: readonly number[], right: readonly number[]) =>
  left.reduce((sum, channel, index) => sum + Math.abs(channel - right[index]!), 0);

for (const theme of ["dark", "light"] as const) {
  test(`the active search match is visibly different from the other matches in ${theme} (#2865) @production`, async ({ page }) => {
    const response = await page.goto(`/xterm-smoke-e2e.html?theme=${theme}`);
    expect(response?.ok()).toBe(true);
    await expect.poll(() => page.evaluate(() => typeof window.__WOLLIPOG_XTERM_E2E__)).toBe("object");
    const terminal = page.getByRole("region", { name: "Interactive Terminal Fixture" });
    await page.evaluate(() => window.__WOLLIPOG_XTERM_E2E__.appendInteractive("test one\r\ntest two\r\nthe test three\r\n"));
    await expect(terminalRows(terminal)).toContainText("the test three");
    await page.getByRole("button", { name: "Search Output" }).click();
    await page.getByRole("textbox", { name: "Search Output" }).fill("test");
    await expect(page.getByRole("group", { name: "Search Output" }).getByRole("status")).toHaveText("1 of 3");

    // Each match's box, the active one being the match with the outline.
    const matches = await terminal.locator(".xterm-find-result-decoration").evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { active: (element as HTMLElement).style.outline !== "", x: box.x, y: box.y, width: box.width, height: box.height };
    }));
    const active = matches.find((match) => match.active)!;
    const other = matches.find((match) => !match.active && Math.abs(match.y - active.y) >= active.height)!;
    expect(active, "the active match has its outline").toBeTruthy();
    expect(other, "another match is highlighted").toBeTruthy();
    // Inside the outline, so each clip is the match's own wash and glyphs.
    const inner = (box: typeof active) => ({ x: box.x + 2, y: box.y + 2, width: box.width - 4, height: box.height - 4 });
    const activeColor = await dominantColor(page, await page.screenshot({ clip: inner(active) }));
    const otherColor = await dominantColor(page, await page.screenshot({ clip: inner(other) }));
    const termBox = (await terminal.locator(".xterm-screen").boundingBox())!;
    const ground = await dominantColor(page, await page.screenshot({
      clip: { x: termBox.x + termBox.width - 40, y: termBox.y + termBox.height - 24, width: 32, height: 16 },
    }));

    // The active wash is --accent's, the others the text's: a different colour, not only a different edge.
    expect(colorDistance(otherColor, ground), `${theme}: every match has a wash (${otherColor} on ${ground})`).toBeGreaterThan(30);
    expect(colorDistance(activeColor, ground), `${theme}: the active match has a wash (${activeColor})`).toBeGreaterThan(30);
    expect(colorDistance(activeColor, otherColor), `${theme}: the active wash differs (${activeColor} vs ${otherColor})`)
      .toBeGreaterThan(20);
    // And the active match alone has the 1px --accent outline: the row of pixels above each match.
    const accent = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color.match(/\d+/g)!.slice(0, 3).map(Number);
      probe.remove();
      return color;
    });
    const edge = (box: typeof active) => ({ x: box.x + 2, y: box.y - 1, width: box.width - 4, height: 1 });
    const activeEdge = await dominantColor(page, await page.screenshot({ clip: edge(active) }));
    const otherEdge = await dominantColor(page, await page.screenshot({ clip: edge(other) }));
    expect(colorDistance(activeEdge, accent), `${theme}: the active match is outlined in --accent (${activeEdge})`).toBeLessThan(40);
    expect(colorDistance(otherEdge, accent), `${theme}: other matches have no outline (${otherEdge})`).toBeGreaterThan(100);
  });
}
