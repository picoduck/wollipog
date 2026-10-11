import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The terminal on a phone (#2866; docs/design-system.md §4.6, §15.1): a sheet in the composer's place,
 * one 48px head row, search on its own row and a height that follows the keyboard. The real Shell, so
 * the session bar, the composer and the tab bar are the app's own.
 */

/** Opens Alpha Session, whose machine has `shells` running shells. */
async function openSession(page: Page, shells: number): Promise<void> {
  const response = await page.goto(`/command-inbox-projects-e2e.html?fullShell=1&terminalShells=${shells}`);
  expect(response?.ok(), "fixture page should be served").toBe(true);
  await page.getByRole("button", { name: /Alpha Session/ }).first().click();
  // Wider than a phone, a row opens the preview first.
  if ((page.viewportSize()?.width ?? 0) > 760) await page.getByRole("button", { name: "Open Session" }).click();
  await expect(page.locator(".composer-box")).toBeVisible();
}

async function openTerminal(page: Page, shells: number): Promise<Locator> {
  await openSession(page, shells);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const dock = page.getByRole("region", { name: "Terminal" });
  await expect(dock.getByRole("tab")).toHaveCount(shells);
  return dock;
}

const head = (dock: Locator) => dock.locator(".shell-dock-head");

/** How far apart the tab label's text boxes sit vertically: under one line when nothing in it wraps. */
async function labelSpread(tab: Locator): Promise<{ spread: number; lineHeight: number }> {
  return tab.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const centers = [...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => rect.top + rect.height / 2);
    return {
      spread: Math.max(...centers) - Math.min(...centers),
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight) || 20,
    };
  });
}

test.describe("at 390px with touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the open terminal takes the composer's place and hiding it brings the composer back with its draft", async ({ page }) => {
    await openSession(page, 1);
    // The phone's idle composer is a capsule that opens into the field.
    await page.locator(".composer-idle-preview").click();
    const message = page.locator(".composer-input");
    await message.fill("check the failing total");
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    const dock = page.getByRole("region", { name: "Terminal" });
    await expect(dock.getByRole("tab")).toHaveCount(1);

    await expect(page.locator(".composer")).toBeHidden();
    for (const name of ["Message Codex", "Attach and Settings", "Dictate", "Send"]) {
      await expect(page.getByRole("button", { name, exact: true }), `${name} is not shown`).toHaveCount(0);
    }
    await expect(page.getByRole("textbox", { name: "Message Codex" })).toHaveCount(0);

    // A sheet on the tab bar: --radius-lg top corners and --elev-3.
    const sheet = await dock.evaluate((element) => {
      const style = getComputedStyle(element);
      const probe = document.createElement("div");
      probe.style.borderRadius = "var(--radius-lg)";
      probe.style.boxShadow = "var(--elev-3)";
      document.body.append(probe);
      const tokens = getComputedStyle(probe);
      const expected = { radius: tokens.borderTopLeftRadius, shadow: tokens.boxShadow };
      probe.remove();
      const rail = document.querySelector(".app-rail")!.getBoundingClientRect();
      return {
        topLeft: style.borderTopLeftRadius,
        topRight: style.borderTopRightRadius,
        bottomLeft: style.borderBottomLeftRadius,
        shadow: style.boxShadow,
        expected,
        bottom: element.getBoundingClientRect().bottom,
        railTop: rail.top,
      };
    });
    expect(sheet.topLeft).toBe(sheet.expected.radius);
    expect(sheet.topRight).toBe(sheet.expected.radius);
    expect(sheet.bottomLeft).toBe("0px");
    expect(sheet.shadow).toBe(sheet.expected.shadow);
    expect(Math.abs(sheet.bottom - sheet.railTop)).toBeLessThanOrEqual(1);

    await dock.getByRole("button", { name: "Hide Terminal" }).click();
    await expect(dock).toHaveCount(0);
    await expect(page.locator(".composer")).toBeVisible();
    await expect(message).toHaveValue("check the failing total");
    await expect(page.locator(".composer-box")).toContainText("check the failing total");
  });

  for (const shells of [2, 5, 10]) {
    test(`with ${shells} tabs the head is one 48px row, no label wraps and the active tab is in view`, async ({ page }) => {
      const dock = await openTerminal(page, shells);
      expect((await head(dock).boundingBox())?.height).toBe(48);
      for (const tab of await dock.getByRole("tab").all()) {
        expect((await tab.boundingBox())?.height).toBe(48);
        const { spread, lineHeight } = await labelSpread(tab);
        expect(spread, "the tab's label stays on one line").toBeLessThan(lineHeight / 2);
      }

      await dock.getByRole("tab", { name: /^Shell 1\b/ }).focus();
      await page.keyboard.press("End");
      const last = dock.getByRole("tab", { name: new RegExp(`^Shell ${shells}\\b`) });
      await expect(last).toHaveAttribute("aria-selected", "true");
      const strip = await dock.getByRole("tablist").boundingBox();
      await expect.poll(async () => {
        const box = await last.boundingBox();
        return box !== null && strip !== null && box.x >= strip.x - 1 && box.x + box.width <= strip.x + strip.width + 1;
      }, { message: "the selected tab is scrolled into the strip" }).toBe(true);
      expect((await head(dock).boundingBox())?.height).toBe(48);
    });
  }

  test("every head control has a 44px target", async ({ page }) => {
    const dock = await openTerminal(page, 2);
    const controls = head(dock).locator("button:not([role=tab]):visible");
    // Close Shell 1, Search Output, New Tab, More Terminal Actions and Hide Terminal.
    await expect(controls).toHaveCount(5);
    const boxes = await controls.evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      const after = getComputedStyle(element, "::after");
      const reach = (value: string) => (after.content !== "none" && after.position === "absolute"
        ? Math.max(0, -Number.parseFloat(value) || 0)
        : 0);
      return {
        name: element.getAttribute("aria-label"),
        height: box.height + reach(after.top) + reach(after.bottom),
        width: box.width + reach(after.left) + reach(after.right),
      };
    }));
    for (const box of boxes) {
      expect(box.height, `${box.name} is 44px tall`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${box.name} is 44px wide`).toBeGreaterThanOrEqual(44);
    }
  });

  test("search opens on its own row under the head, and the pressed Search Output closes it", async ({ page }) => {
    const dock = await openTerminal(page, 5);
    const toggle = dock.getByRole("button", { name: "Search Output" });
    await toggle.click();
    const row = dock.locator(".dock-search-row");
    const field = row.getByRole("textbox", { name: "Search Output" });
    await expect(field).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    for (const name of ["Previous Match", "Next Match", "Close Search"]) {
      await expect(row.getByRole("button", { name })).toBeVisible();
    }
    await field.fill("passed");
    await expect(row.getByRole("status")).toHaveText("1 of 1");

    // The head keeps its row and all its tabs' room.
    expect((await head(dock).boundingBox())?.height).toBe(48);
    await expect(head(dock).getByRole("textbox")).toHaveCount(0);
    const headBox = await head(dock).boundingBox();
    const rowBox = await row.boundingBox();
    expect(rowBox!.y).toBeGreaterThanOrEqual(headBox!.y + headBox!.height - 1);

    await toggle.click();
    await expect(row).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  test("crossing 760px with search open keeps the caret in the field, and leaves focus elsewhere alone", async ({ page }) => {
    const dock = await openTerminal(page, 2);
    await dock.getByRole("button", { name: "Search Output" }).click();
    const field = dock.getByRole("textbox", { name: "Search Output" });
    await expect(dock.locator(".dock-search-row").getByRole("textbox")).toBeFocused();

    // A phone turned sideways: the search moves into the head with its caret.
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(dock.locator(".dock-search-row")).toHaveCount(0);
    await expect(head(dock).getByRole("textbox", { name: "Search Output" })).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dock.locator(".dock-search-row").getByRole("textbox")).toBeFocused();

    // With focus in the terminal, the move leaves it there.
    await dock.locator(".shell-term:not(.is-hidden) .xterm-helper-textarea").focus();
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(head(dock).getByRole("textbox", { name: "Search Output" })).toBeVisible();
    await expect(field).not.toBeFocused();
    await expect(dock.locator(".shell-term:not(.is-hidden) .xterm-helper-textarea")).toBeFocused();
  });

  test("with the search field focused and the keyboard up, the sheet ends above it with the search row in view", async ({ page }) => {
    // A short screen and a tall keyboard, where half the screen no longer fits under the session bar.
    await page.setViewportSize({ width: 390, height: 700 });
    const dock = await openTerminal(page, 5);
    // A tall stored height, so the sheet has to give way.
    const grip = dock.getByRole("separator", { name: "Resize Terminal" });
    await grip.focus();
    for (let step = 0; step < 30; step += 1) await page.keyboard.press("ArrowUp");
    await dock.getByRole("button", { name: "Search Output" }).click();
    const field = dock.getByRole("textbox", { name: "Search Output" });
    await expect(field).toBeFocused();

    const inset = 360;
    await page.evaluate((value) => document.documentElement.style.setProperty("--keyboard-inset", `${value}px`), inset);
    const visibleBottom = 700 - inset;
    await expect.poll(async () => {
      const box = await dock.boundingBox();
      return box ? Math.round(box.y + box.height) : Number.POSITIVE_INFINITY;
    }, { message: "the sheet sits on the keyboard" }).toBeLessThanOrEqual(visibleBottom);

    const row = await dock.locator(".dock-search-row").boundingBox();
    expect(row!.y + row!.height).toBeLessThanOrEqual(visibleBottom);
    const sessionBar = await page.locator(".topbar").boundingBox();
    expect(sessionBar!.height, "the session bar keeps its height").toBe(48);
    expect(row!.y, "the search row is under the session bar, not behind it").toBeGreaterThanOrEqual(sessionBar!.y + sessionBar!.height);
    // The terminal keeps lines between the search row and the keyboard.
    const terminal = await dock.locator(".shell-term-stack").boundingBox();
    expect(terminal!.height).toBeGreaterThan(0);
    expect(terminal!.y + terminal!.height).toBeLessThanOrEqual(visibleBottom);
    await expect(field).toBeFocused();
  });

  test("the side panel's sheet covers the terminal sheet", async ({ page }) => {
    const dock = await openTerminal(page, 2);
    await page.getByRole("button", { name: "Side Panel" }).click();
    const panel = page.locator(".rpanel");
    await expect(panel).toBeVisible();
    const box = await dock.boundingBox();
    const topmost = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".rpanel, .shell-dock")?.className ?? null,
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
    expect(topmost).toContain("rpanel");
  });
});

test.describe("at 761px", () => {
  test.use({ viewport: { width: 761, height: 900 } });

  test("the dock stays under the composer with search in its head", async ({ page }) => {
    const dock = await openTerminal(page, 2);
    await expect(page.locator(".composer")).toBeVisible();
    const style = await dock.evaluate((element) => ({
      radius: getComputedStyle(element).borderTopLeftRadius,
      shadow: getComputedStyle(element).boxShadow,
    }));
    expect(style).toEqual({ radius: "0px", shadow: "none" });
    await dock.getByRole("button", { name: "Search Output" }).click();
    await expect(head(dock).getByRole("textbox", { name: "Search Output" })).toBeFocused();
    await expect(dock.locator(".dock-search-row")).toHaveCount(0);
    await expect(head(dock).getByRole("button", { name: "Search Output" })).toHaveCount(0);
  });
});
