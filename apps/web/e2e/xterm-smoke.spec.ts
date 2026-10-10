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

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title === SEARCH_DURING_FONT_LOAD_TEST || testInfo.title.startsWith("the active search match")) return;
  await waitForHarness(page);
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
