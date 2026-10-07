import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The phone Board (#2216, docs/design-system.md §15.1): one column at a time under a strip of
 * column tabs, opening on the first column that needs the person, with the Machine and Agent filters
 * in a sheet behind the app bar's Filters button and a strip that says what is filtered. Measured
 * against the sessions-board harness: its `filters` scenario has 29 active sessions on two machines,
 * 10 of them Claude Code on Studio Mac, and nothing Done.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function openBoard(page: Page, scenario = "filters") {
  await page.goto(`/sessions-board-e2e.html?${scenario}&path=${encodeURIComponent("/board")}`);
  await expect(page.locator(".board .card").first()).toBeVisible();
}

const bar = (page: Page) => page.locator(".sessions-app-bar");
const columnTabs = (page: Page) => page.getByRole("tablist", { name: "Board Columns" });
const columnTab = (page: Page, name: string) => columnTabs(page).getByRole("tab", { name: new RegExp(`^${name}, \\d+$`) });
const panel = (page: Page) => page.getByRole("tabpanel");
const filtersButton = (page: Page) => bar(page).getByRole("button", { name: /^Filters/ });
const strip = (page: Page) => bar(page).locator(".board-filter-strip");

/** A sheet once it has slid in and docked to the bottom (§7.5). */
async function docked(sheet: Locator) {
  await expect(sheet).toBeVisible();
  await expect.poll(async () => {
    const box = (await sheet.boundingBox())!;
    return [box.x, box.width, Math.round(box.y + box.height)];
  }).toEqual([0, 390, 844]);
}

async function expectTargets(locator: Locator) {
  const targets = await locator.evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return [node.getAttribute("aria-label") ?? node.textContent ?? "", box.height, box.width] as const;
  }));
  expect(targets.length, "there are targets to measure").toBeGreaterThan(0);
  for (const [name, height, width] of targets) {
    expect(height, `${name} is 44px tall`).toBeGreaterThanOrEqual(44);
    expect(width, `${name} is 44px wide`).toBeGreaterThanOrEqual(44);
  }
}

/**
 * Every element of the page's Sessions view, app bar and Board, measured: none is wider than the
 * viewport, and none reaches past its right edge except a column tab scrolled inside its own row.
 */
async function overflowing(page: Page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const elements = [...document.querySelectorAll<HTMLElement>(".sessions-app-bar, .sessions-app-bar *, .board-wrap, .board-wrap *")];
    const offenders = elements.flatMap((element) => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return [];
      const scrolled = element.closest(".board-column-tabs") !== null && element !== element.closest(".board-column-tabs");
      const name = `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`;
      if (box.width > width + 0.5) return [`${name} is ${box.width}px wide`];
      if (!scrolled && (box.left < -0.5 || box.right > width + 0.5)) return [`${name} spans ${box.left}–${box.right}`];
      return [];
    });
    return { offenders, pageScrollWidth: document.scrollingElement!.scrollWidth, width };
  });
}

test("with sessions waiting, the Board opens on Needs Input, and nothing is wider than the viewport", async ({ page }) => {
  await openBoard(page);
  await expect(page.locator(".board .column")).toHaveCount(1);
  await expect(columnTabs(page).getByRole("tab")).toHaveText([/^Needs Input/, /^Running/, /^Review/, /^Done/, /^Queued/]);
  await expect(columnTab(page, "Needs Input")).toHaveAttribute("aria-selected", "true");
  await expect(panel(page)).toHaveAccessibleName(/^Needs Input/);
  for (const title of await panel(page).locator(".card .card-title").allTextContents()) {
    expect(title, "only Needs Input's cards").toMatch(/^(Approval Session|Claude Code Session (2|5|8))$/);
  }
  const card = (await panel(page).locator(".card").first().boundingBox())!;
  expect(card.x, "the card starts at the page gutter").toBe(16);
  expect(card.width, "and runs the width").toBe(390 - 32);

  const fit = await overflowing(page);
  expect(fit.offenders).toEqual([]);
  expect(fit.pageScrollWidth).toBe(fit.width);
  await page.screenshot({ path: test.info().outputPath("phone-board-opening.png") });
});

test("with nothing waiting, the Board opens on the first column with a card, in the stated order", async ({ page }) => {
  await openBoard(page, "no-input");
  await expect(columnTab(page, "Needs Input")).toHaveAccessibleName("Needs Input, 0");
  await expect(columnTab(page, "Running")).toHaveAttribute("aria-selected", "true");
  await expect(panel(page).locator(".card .card-title")).toHaveText(["Running Session"]);
});

test("each tab counts its column, Needs Input's as a warning badge, and choosing one shows only its cards", async ({ page }) => {
  await openBoard(page);
  const names = await columnTabs(page).getByRole("tab").evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-label")));
  expect(names).toEqual(["Needs Input, 4", "Running, 13", "Review, 11", "Done, 0", "Queued, 1"]);
  await expect(columnTab(page, "Needs Input").locator(".count-badge")).toHaveText("4");
  await expect(columnTab(page, "Needs Input").locator(".count")).toHaveCount(0);
  await expect(columnTab(page, "Running").locator(".count")).toHaveText("13");
  await expect(columnTabs(page).locator(".count-badge")).toHaveCount(1);
  await expectTargets(columnTabs(page).getByRole("tab"));

  await columnTab(page, "Queued").tap();
  await expect(columnTab(page, "Queued")).toHaveAttribute("aria-selected", "true");
  await expect(panel(page).locator(".card .card-title")).toHaveText(["Queued Session"]);
  expect((await columnTab(page, "Queued").boundingBox())!.x + 44, "the chosen tab scrolls into view").toBeLessThanOrEqual(390);

  await columnTab(page, "Done").tap();
  await expect(panel(page).locator(".card")).toHaveCount(0);
  await expect(panel(page)).toContainText("No sessions are in Done.");

  // The arrow keys move along the tabs and show the column they reach.
  await columnTab(page, "Done").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(columnTab(page, "Review")).toBeFocused();
  await expect(columnTab(page, "Review")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(columnTab(page, "Needs Input")).toBeFocused();
  await page.keyboard.press("End");
  await expect(columnTab(page, "Queued")).toHaveAttribute("aria-selected", "true");

  // The chosen column holds while the Board stays open, even when a filter empties it.
  await filtersButton(page).tap();
  await page.getByRole("menu", { name: "Filters" }).getByRole("group", { name: "Studio Mac" })
    .getByRole("menuitemradio", { name: "Claude Code" }).tap();
  await page.keyboard.press("Escape");
  await expect(columnTab(page, "Queued")).toHaveAttribute("aria-selected", "true");
  await expect(columnTab(page, "Queued")).toHaveAccessibleName("Queued, 0");
  await expect(panel(page)).toContainText("No sessions are in Queued.");
});

test("a filter set in the sheet shows the strip and presses Filters, and the strip's Clear Filters resets it", async ({ page }) => {
  await openBoard(page);
  await expect(page.locator(".sessions-app-bar-tools, .board-filter-note")).toHaveCount(0);
  await expect(filtersButton(page)).toHaveAccessibleName("Filters");
  await expect(filtersButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(strip(page)).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("phone-board-unfiltered.png") });

  await filtersButton(page).tap();
  const sheet = page.getByRole("menu", { name: "Filters" });
  await docked(sheet);
  await expect(sheet.locator(".menu-head")).toHaveText("Filters");
  await expect(sheet.locator(".menu-note")).toHaveText("Showing 29 of 29");
  await expect(sheet).toHaveAccessibleDescription("Showing 29 of 29");
  await expectTargets(sheet.locator('[role^="menuitem"]'));
  await expect(sheet.getByRole("menuitem", { name: "Clear Filters" })).toHaveCount(0);

  await sheet.getByRole("group", { name: "Studio Mac" }).getByRole("menuitemradio", { name: "Claude Code" }).tap();
  // The sheet stays open, so its count answers the choice.
  await expect(sheet.locator(".menu-note")).toHaveText("Showing 10 of 29");
  await expect(sheet.getByRole("group", { name: "Studio Mac" }).getByRole("menuitemradio", { name: "Claude Code" }))
    .toHaveAttribute("aria-checked", "true");
  await expect(sheet.getByRole("menuitem", { name: "Clear Filters" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("phone-board-filters-sheet.png") });

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(filtersButton(page)).toBeFocused();
  await expect(filtersButton(page)).toHaveAccessibleName("Filters, 1 Active");
  await expect(filtersButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(filtersButton(page).locator(".count")).toHaveText("1");
  await expect(strip(page)).toHaveText("Agent: Claude Code. Showing 10 of 29.Clear Filters");
  expect((await strip(page).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expectTargets(strip(page).getByRole("button", { name: "Clear Filters" }));
  await expectTargets(bar(page).locator("button"));
  await expect(columnTab(page, "Needs Input")).toHaveAccessibleName("Needs Input, 3");
  const fit = await overflowing(page);
  expect(fit.offenders).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("phone-board-filtered.png") });

  await strip(page).getByRole("button", { name: "Clear Filters" }).tap();
  await expect(strip(page)).toHaveCount(0);
  await expect(filtersButton(page)).toBeFocused();
  await expect(filtersButton(page)).toHaveAccessibleName("Filters");
  await expect(filtersButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(columnTab(page, "Needs Input")).toHaveAccessibleName("Needs Input, 4");
});

test("both filters and a long agent name: the name ends in an ellipsis, the count never does", async ({ page }) => {
  await openBoard(page);
  await filtersButton(page).tap();
  const sheet = page.getByRole("menu", { name: "Filters" });
  await sheet.getByRole("group", { name: "Machine" }).getByRole("menuitemradio", { name: "Studio Mac" }).tap();
  await sheet.getByRole("group", { name: "Studio Mac" })
    .getByRole("menuitemradio", { name: /^Research Agent With Extended/ }).tap();
  await expect(sheet.locator(".menu-note")).toHaveText("Showing 0 of 29");
  await sheet.getByRole("menuitem", { name: "Clear Filters" }).tap();
  // The row leaves with the filters, so focus lands on All Machines.
  await expect(sheet.getByRole("menuitemradio", { name: "All Machines" })).toBeFocused();
  await expect(sheet.locator(".menu-note")).toHaveText("Showing 29 of 29");

  await sheet.getByRole("group", { name: "Machine" }).getByRole("menuitemradio", { name: "Build Server 02" }).tap();
  await sheet.getByRole("group", { name: "Studio Mac" })
    .getByRole("menuitemradio", { name: /^Research Agent With Extended/ }).tap();
  await page.keyboard.press("Escape");
  await expect(filtersButton(page)).toHaveAccessibleName("Filters, 2 Active");
  await expect(strip(page).locator(".board-filter-strip-what"))
    .toHaveText("Machine: Build Server 02. Agent: Research Agent With Extended Repository Context and Staging Credentials.");
  const result = strip(page).locator(".board-filter-strip-result");
  await expect(result).toHaveText("Showing 0 of 29.");
  const clipped = await strip(page).evaluate((node) => {
    const what = node.querySelector<HTMLElement>(".board-filter-strip-what")!;
    const result = node.querySelector<HTMLElement>(".board-filter-strip-result")!;
    return { whatClipped: what.scrollWidth > what.clientWidth, resultClipped: result.scrollWidth > result.clientWidth };
  });
  expect(clipped).toEqual({ whatClipped: true, resultClipped: false });
  const fit = await overflowing(page);
  expect(fit.offenders).toEqual([]);
});
