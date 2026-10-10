import { expect, test, type Locator, type Page } from "@playwright/test";

/** The terminal dock's one head (#2864; docs/design-system.md §4.6, §10.1, §2.8). */

async function openDock(page: Page, query = ""): Promise<Locator> {
  const response = await page.goto(`/shell-dock-e2e.html${query}`);
  expect(response?.ok(), "shell dock fixture page should be served").toBe(true);
  const dock = page.getByRole("region", { name: "Terminal" });
  await expect(dock.getByRole("tab")).not.toHaveCount(0);
  return dock;
}

const head = (dock: Locator) => dock.locator(".shell-dock-head");

/** The box a pointer can hit: the control plus any absolutely positioned ::after that extends it. */
async function hitBoxes(controls: Locator) {
  return controls.evaluateAll((elements) => elements.filter((element) => element.getClientRects().length > 0).map((element) => {
    const box = element.getBoundingClientRect();
    const after = getComputedStyle(element, "::after");
    const borrow = (value: string) => (after.content !== "none" && after.position === "absolute"
      ? Math.max(0, -Number.parseFloat(value) || 0)
      : 0);
    return {
      name: element.getAttribute("aria-label") ?? element.textContent ?? "",
      visual: box.height,
      height: box.height + borrow(after.top) + borrow(after.bottom),
      width: box.width + borrow(after.left) + borrow(after.right),
    };
  }));
}

test.describe("at 1440px with a fine pointer", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the head is 40px and every control in it 28px, with SVG icons and no text glyphs", async ({ page }) => {
    const dock = await openDock(page);
    await expect(dock.getByRole("tab", { name: /Shell 1/ })).toHaveAttribute("aria-selected", "true");
    await dock.getByRole("button", { name: "Search Output" }).click();
    const field = dock.getByRole("textbox", { name: "Search Output" });
    await expect(field).toBeFocused();

    expect((await head(dock).boundingBox())?.height).toBe(40);
    const controls = head(dock).locator(".icon-btn");
    // Close Shell 1, Search's Previous, Next and Close, New Tab and Hide Terminal at least.
    expect(await controls.count()).toBeGreaterThanOrEqual(6);
    for (const box of await hitBoxes(controls)) {
      expect(box.visual, `${box.name} is 28px tall`).toBe(28);
      expect(box.width, `${box.name} is square`).toBe(28);
    }
    expect((await field.boundingBox())?.height).toBe(28);
    // Tabs are §10.1 tabs: the head's full height, so the underline sits on its hairline.
    for (const tab of await dock.getByRole("tab").all()) expect((await tab.boundingBox())?.height).toBe(40);

    const text = await head(dock).innerText();
    for (const glyph of ["❯", "×", "+"]) expect(text, `no "${glyph}" in the head`).not.toContain(glyph);
    const iconless = await head(dock).locator("button.icon-btn").evaluateAll((buttons) =>
      buttons.filter((button) => !button.querySelector("svg") && !button.querySelector(".spinner")).length);
    expect(iconless).toBe(0);
    await expect(dock.locator(".shell-dock-label")).toHaveCount(0);
  });

  test("tabs read Shell N and the folder, with the full path, an Exited status and the accent underline", async ({ page }) => {
    const dock = await openDock(page);
    const first = dock.getByRole("tab", { name: "Shell 1 acme-storefront" });
    await expect(first).toHaveAttribute("title", "/home/dev/worktrees/acme-storefront");
    await expect(first.locator(".shell-tab-folder")).toHaveText("acme-storefront");
    const exited = dock.getByRole("tab", { name: "Shell 3 acme-storefront Exited" });
    await expect(exited.locator(".status")).toHaveText("Exited");
    await expect(dock.getByRole("tab", { name: /Exited/ })).toHaveCount(1);

    const underline = await first.evaluate((tab) => {
      const after = getComputedStyle(tab, "::after");
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      const probe = document.createElement("span");
      probe.style.color = accent;
      document.body.append(probe);
      const accentColor = getComputedStyle(probe).color;
      probe.remove();
      return { height: after.height, color: after.backgroundColor, accentColor };
    });
    expect(underline.height).toBe("2px");
    expect(underline.color).toBe(underline.accentColor);
    await expect(dock.getByRole("tab", { name: /Shell 2/ })).toHaveAttribute("aria-selected", "false");
  });

  test("a tab's Close shows on hover, focus and the selected tab, and is named for the tab", async ({ page }) => {
    const dock = await openDock(page);
    const visibility = (name: string) => dock.getByRole("button", { name, includeHidden: true })
      .evaluate((button) => getComputedStyle(button).visibility);
    expect(await visibility("Close Shell 1")).toBe("visible");
    expect(await visibility("Close Shell 2")).toBe("hidden");
    await dock.getByRole("tab", { name: /Shell 2/ }).hover();
    expect(await visibility("Close Shell 2")).toBe("visible");
    await page.mouse.move(0, 0);
    expect(await visibility("Close Shell 2")).toBe("hidden");

    await dock.getByRole("tab", { name: /Shell 1/ }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(dock.getByRole("tab", { name: /Shell 2/ })).toBeFocused();
    expect(await visibility("Close Shell 2")).toBe("visible");

    await dock.getByRole("button", { name: "Close Shell 2" }).click();
    await expect(dock.getByRole("tab", { name: /Shell 2/ })).toHaveCount(0);
  });

  test("New Tab lists New Shell and New Agent TUI with its second line", async ({ page }) => {
    const dock = await openDock(page);
    const newTab = dock.getByRole("button", { name: "New Tab" });
    await expect(newTab).toHaveAttribute("title", "New Tab");
    await newTab.click();
    const menu = page.getByRole("menu", { name: "New Tab" });
    await expect(menu.getByRole("menuitem")).toHaveText([/New Shell/, /New Agent TUI/]);
    const tuiItem = menu.getByRole("menuitem", { name: "New Agent TUI" });
    await expect(tuiItem).toHaveAccessibleDescription("Claude Code's own terminal interface, outside Wollipog's tracking.");
    await expect(tuiItem).not.toHaveAttribute("aria-disabled", "true");
    await menu.getByRole("menuitem", { name: "New Shell" }).click();
    await expect(newTab).toHaveAttribute("aria-busy", "true");
    await expect(dock.getByRole("tab", { name: /Shell 4/ })).toHaveAttribute("aria-selected", "true");
    await expect(newTab).not.toHaveAttribute("aria-busy", "true");
  });

  for (const [tui, reason] of [
    ["open", "An Agent TUI is already open for this session."],
    ["guardrail", "Unavailable while this session has a cost budget, cost checkpoint or tool-call limit."],
    ["offline", "Build Box is offline."],
  ] as const) {
    test(`an unavailable Agent TUI says why as its second line (${tui})`, async ({ page }) => {
      const dock = await openDock(page, `?tui=${tui}`);
      await dock.getByRole("button", { name: "New Tab" }).click();
      const item = page.getByRole("menu", { name: "New Tab" }).getByRole("menuitem", { name: "New Agent TUI" });
      await expect(item).toHaveAttribute("aria-disabled", "true");
      await expect(item).toHaveAccessibleDescription(reason);
      await expect(item.locator(".menu-desc")).toBeVisible();
    });
  }

  test("without an Agent TUI, New Tab opens a shell directly", async ({ page }) => {
    const dock = await openDock(page, "?tui=unsupported");
    const newTab = dock.getByRole("button", { name: "New Tab" });
    await expect(newTab).not.toHaveAttribute("aria-haspopup");
    await newTab.click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(dock.getByRole("tab", { name: /Shell 4/ })).toHaveAttribute("aria-selected", "true");
  });

  test("search shows the standard focus ring, and Escape closes it and focuses the terminal", async ({ page }) => {
    const dock = await openDock(page);
    await dock.getByRole("button", { name: "Search Output" }).click();
    const field = dock.getByRole("textbox", { name: "Search Output" });
    await expect(field).toBeFocused();
    const ring = await field.evaluate((input) => {
      const style = getComputedStyle(input);
      return { style: style.outlineStyle, width: style.outlineWidth };
    });
    expect(ring.style).toBe("solid");
    expect(ring.width).toBe("1px");

    await field.fill("test");
    await expect(dock.getByRole("group", { name: "Search Output" }).getByRole("status")).toHaveText("1 of 5");
    await field.press("Escape");
    await expect(dock.locator(".xterm-helper-textarea")).toBeFocused();
    await expect(dock.getByRole("button", { name: "Search Output" })).toBeVisible();
  });

  test("Hide Terminal is named Hide Terminal, and no name says Detach", async ({ page }) => {
    const dock = await openDock(page);
    const hide = dock.getByRole("button", { name: "Hide Terminal" });
    await expect(hide).toHaveAttribute("title", "Hide Terminal (Ctrl+`)\nShells keep running.");
    const names = await dock.locator("[aria-label]").evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label") ?? ""));
    expect(names.filter((name) => /Detach/i.test(name))).toEqual([]);
    await hide.click();
    expect(await page.evaluate(() => window.__WOLLIPOG_SHELL_DOCK_E2E__.hideCount())).toBe(1);
  });
});

test.describe("on a coarse pointer at 834px", () => {
  test.use({ viewport: { width: 834, height: 1112 }, hasTouch: true, isMobile: true });

  test("every control in the head is a 44px target, and only the selected tab has Close", async ({ page }) => {
    const dock = await openDock(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await dock.getByRole("button", { name: "Search Output" }).click();

    expect((await head(dock).boundingBox())?.height).toBe(48);
    for (const box of await hitBoxes(head(dock).locator(".icon-btn"))) {
      expect(box.height, `${box.name} is a 44px target`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${box.name} is a 44px target`).toBeGreaterThanOrEqual(44);
    }
    expect((await dock.locator(".shell-search-field").boundingBox())?.height).toBeGreaterThanOrEqual(44);
    for (const tab of await dock.getByRole("tab").all()) {
      expect((await tab.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
    await expect(dock.getByRole("button", { name: "Close Shell 1" })).toBeVisible();
    await expect(dock.getByRole("button", { name: "Close Shell 2" })).toHaveCount(0);
  });
});
