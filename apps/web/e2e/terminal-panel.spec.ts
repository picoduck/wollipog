import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The terminal as a side panel tool (#2868; docs/design-system.md §4.6, §4.9). With
 * `wollipog.terminal.placement` set to "panel" the side panel's Terminal tool hosts the session's
 * terminals and no dock is shown; unset (Bottom Dock, the default), Terminal opens the dock. The real
 * Shell, whose machine has two running shells, Shell 1 with a test run's output.
 */

type Placement = "panel" | "dock" | null;

async function openSession(page: Page, placement: Placement, shells = 2): Promise<void> {
  if (placement) {
    await page.addInitScript((value) => localStorage.setItem("wollipog.terminal.placement", value), placement);
  }
  const response = await page.goto(`/command-inbox-projects-e2e.html?fullShell=1&terminalShells=${shells}`);
  expect(response?.ok(), "fixture page should be served").toBe(true);
  await page.getByRole("button", { name: /Alpha Session/ }).first().click();
  // Wider than a phone, a row opens the preview first.
  if ((page.viewportSize()?.width ?? 0) > 760) await page.getByRole("button", { name: "Open Session" }).click();
  await expect(page.locator(".composer-box")).toBeAttached();
}

const sidePanel = (page: Page) => page.locator("#right-panel");
const dock = (page: Page) => page.locator(".shell-dock");
const terminalRow = (page: Page) => sidePanel(page).locator('.session-tool[data-tool="terminal"]');
const shellCalls = (page: Page) => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.shellCalls());

/** Opens the side panel on Session Tools. */
async function openSidePanel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Side Panel", exact: true }).first().click();
  await expect(sidePanel(page).locator(".session-tools")).toBeVisible();
}

/** Opens the Terminal tool from Session Tools (opening the panel first unless it is) and waits for Shell 1's output. */
async function openTerminalTool(page: Page, { panelOpen = false } = {}): Promise<Locator> {
  if (!panelOpen) await openSidePanel(page);
  await terminalRow(page).click();
  await expect(sidePanel(page)).toHaveAttribute("data-mode", "terminal");
  const shown = sidePanel(page).locator(".term-host .shell-term:not(.is-hidden) .xterm-rows");
  await expect(shown).toContainText("24 files passed");
  return shown;
}

/** The last size reported for one shell, once the batched resizes have settled. */
async function lastColumns(page: Page, shellId: string): Promise<number> {
  let settled = -1;
  await expect.poll(async () => {
    const sizes = (await shellCalls(page)).resizes.filter((size) => size.shellId === shellId);
    const last = sizes.at(-1)?.cols ?? -1;
    const stable = last === settled;
    settled = last;
    return stable && last > 0;
  }, { intervals: [400] }).toBe(true);
  return settled;
}

for (const viewport of [
  { name: "1440px", width: 1440, height: 900, touch: false, presentation: "docked" },
  { name: "834px", width: 834, height: 1112, touch: false, presentation: "overlay" },
  { name: "390px", width: 390, height: 844, touch: true, presentation: null },
] as const) {
  test.describe(`at ${viewport.name}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      ...(viewport.touch ? { hasTouch: true, isMobile: true } : {}),
    });

    test("in Right Panel placement Session Tools and the switcher open the Terminal tool, and no dock renders", async ({ page }) => {
      await openSession(page, "panel");
      await openSidePanel(page);
      await expect(terminalRow(page)).toContainText("2 shells open");
      await expect(terminalRow(page)).not.toContainText("pnpm");
      await openTerminalTool(page, { panelOpen: true });
      if (viewport.presentation) await expect(sidePanel(page)).toHaveAttribute("data-presentation", viewport.presentation);
      await expect(sidePanel(page).getByRole("tab")).toHaveCount(2);
      await expect(dock(page)).toHaveCount(0);

      // The switcher's Terminal is a tool like the rest: checked while it shows, and it opens the tool.
      const switcher = sidePanel(page).locator(".rpanel-switcher");
      await expect(switcher).toHaveText("Terminal");
      await switcher.click();
      await expect(page.getByRole("menuitemradio", { name: "Terminal" })).toHaveAttribute("aria-checked", "true");
      await page.getByRole("menuitemradio", { name: "Review" }).click();
      await expect(sidePanel(page)).toHaveAttribute("data-mode", "review");
      await switcher.click();
      await page.getByRole("menuitemradio", { name: "Terminal" }).click();
      await expect(sidePanel(page)).toHaveAttribute("data-mode", "terminal");
      await expect(sidePanel(page).locator(".term-host .shell-term:not(.is-hidden) .xterm-rows")).toContainText("24 files passed");
      await expect(dock(page)).toHaveCount(0);

      // The switcher's name is whole, even with five buttons in a 320px overlay.
      expect(await switcher.locator(".rpanel-switcher-name").evaluate((name) => name.scrollWidth <= name.clientWidth)).toBe(true);

      // No tab or fact names the command a shell runs.
      await expect(sidePanel(page).getByRole("tablist", { name: "Terminal Tabs" })).not.toContainText("pnpm");
    });
  });
}

test.describe("at 390px with touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the sheet has one 48px bar with Back and no Close, the tab strip is 48px, and the composer is hidden", async ({ page }) => {
    await openSession(page, "panel");
    await openTerminalTool(page);
    const head = sidePanel(page).locator(".rpanel-head");
    expect((await head.boundingBox())!.height).toBeCloseTo(48, 0);
    await expect(head.getByRole("button", { name: "Back to Session" })).toBeVisible();
    for (const name of ["Search Output", "New Tab", "More Terminal Actions"]) {
      await expect(head.getByRole("button", { name, exact: true })).toBeVisible();
    }
    await expect(head.getByRole("button", { name: "Close Panel" })).toHaveCount(0);
    await expect(head.getByRole("button", { name: "Expand Panel" })).toHaveCount(0);
    await expect(sidePanel(page).locator(".rpanel-head")).toHaveCount(1);
    expect((await sidePanel(page).locator(".term-tabs").boundingBox())!.height).toBeCloseTo(48, 0);
    await expect(page.locator(".composer")).toBeHidden();

    // More Terminal Actions opens as a sheet.
    await head.getByRole("button", { name: "More Terminal Actions" }).click();
    const menu = page.getByRole("menu", { name: "More Terminal Actions" });
    await expect(menu).toBeVisible();
    await expect(menu.locator(".sheet-grabber")).toBeAttached();
    await expect(menu.getByRole("menuitem", { name: /Move to Bottom Dock/ })).toBeVisible();
  });
});

test.describe("at 1440px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("in Bottom Dock placement Session Tools and the switcher open the dock, and the row says so", async ({ page }) => {
    await openSession(page, null);
    await openSidePanel(page);
    await expect(terminalRow(page)).toContainText("Opens in the dock below the conversation");
    await terminalRow(page).click();
    await expect(dock(page)).toBeVisible();
    await expect(sidePanel(page)).toHaveAttribute("data-mode", "launcher");
    await dock(page).getByRole("button", { name: "Hide Terminal" }).click();
    await expect(dock(page)).toHaveCount(0);

    await sidePanel(page).locator(".rpanel-switcher").click();
    await page.getByRole("menuitem", { name: "Terminal" }).click();
    await expect(dock(page)).toBeVisible();
    await expect(sidePanel(page)).toHaveAttribute("data-mode", "launcher");
  });

  test("Search Output opens the search row, whose count, Previous and Next work as in the dock", async ({ page }) => {
    await openSession(page, "panel");
    await openTerminalTool(page);
    const search = sidePanel(page).getByRole("button", { name: "Search Output" });
    await expect(search).toHaveAttribute("aria-pressed", "false");
    await search.click();
    await expect(search).toHaveAttribute("aria-pressed", "true");
    const row = sidePanel(page).locator(".rpanel-toolbar.term-search");
    const field = row.getByRole("textbox", { name: "Search Output" });
    await expect(field).toBeFocused();
    await field.fill("test");
    const count = row.getByRole("status");
    // "pnpm test", "alpha@1.4.0 test" and the 24 test files.
    await expect(count).toHaveText("1 of 26");
    await row.getByRole("button", { name: "Next Match" }).click();
    await expect(count).toHaveText("2 of 26");
    await field.press("Enter");
    await expect(count).toHaveText("3 of 26");
    await row.getByRole("button", { name: "Previous Match" }).click();
    await expect(count).toHaveText("2 of 26");
    await field.press("Shift+Enter");
    await expect(count).toHaveText("1 of 26");

    await field.press("Escape");
    await expect(row).toHaveCount(0);
    await expect(search).toHaveAttribute("aria-pressed", "false");
    await expect(sidePanel(page).locator(".term-host .shell-term:not(.is-hidden) .xterm-helper-textarea")).toBeFocused();
    await expect(sidePanel(page)).toBeVisible();
  });

  test("Escape typed in a focused panel shell reaches the shell and leaves the panel open; Ctrl+Esc leaves the terminal", async ({ page }) => {
    await openSession(page, "panel");
    await openTerminalTool(page);
    const textarea = sidePanel(page).locator(".term-host .shell-term:not(.is-hidden) .xterm-helper-textarea");
    await textarea.focus();
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await shellCalls(page)).input.filter((entry) => entry.shellId === "shell-1").map((entry) => entry.data))
      .toEqual(["\u001b"]);
    await expect(sidePanel(page)).toBeVisible();
    await expect(textarea).toBeFocused();

    await page.keyboard.press("Control+Escape");
    await expect(page.locator(".detail-scroll")).toBeFocused();
    await expect(sidePanel(page)).toBeVisible();
    expect((await shellCalls(page)).input.map((entry) => entry.data)).toEqual(["\u001b"]);
  });

  test("resizing the panel and toggling Expand Panel change the terminal's column count", async ({ page }) => {
    await openSession(page, "panel");
    await openTerminalTool(page);
    const docked = await lastColumns(page, "shell-1");

    // Dragging the panel's edge 200px wider.
    const resizer = page.locator(".rpanel-resizer");
    const box = (await resizer.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2, { steps: 4 });
    await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    const wider = await lastColumns(page, "shell-1");
    expect(wider, `dragging wider adds columns (${docked} → ${wider})`).toBeGreaterThan(docked + 10);

    await sidePanel(page).getByRole("button", { name: "Expand Panel" }).click();
    await expect(sidePanel(page)).toHaveAttribute("data-presentation", "expanded");
    const expanded = await lastColumns(page, "shell-1");
    expect(expanded, `expanding adds columns (${wider} → ${expanded})`).toBeGreaterThan(wider + 10);

    await sidePanel(page).getByRole("button", { name: "Restore Panel" }).click();
    await expect(sidePanel(page)).toHaveAttribute("data-presentation", "docked");
    await expect.poll(() => lastColumns(page, "shell-1")).toBe(wider);
  });
});
