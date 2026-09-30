import { expect, test, type Page } from "@playwright/test";

/** The desktop rail (#1958; docs/design-system.md §4.1, §9.3, §15.3), in the real Shell. */
const shell = (path: string) => `/command-inbox-projects-e2e.html?fullShell=1&path=${encodeURIComponent(path)}`;

async function openShell(page: Page, path = "/inbox") {
  await page.goto(shell(path));
  await expect(page.locator(".app-rail .rail-destinations")).toBeVisible();
}

const rail = (page: Page) => page.getByRole("navigation", { name: "Primary Navigation" });
const tooltip = (page: Page) => page.locator(".rail-tooltip");

test.describe("at 1440×900 with a mouse", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the rail is 64px with 40px items, 20px glyphs, Search first and two group hairlines", async ({ page }) => {
    await openShell(page);
    const geometry = await page.evaluate(() => {
      const box = (element: Element) => element.getBoundingClientRect();
      const items = [...document.querySelectorAll(".rail-destinations > .rail-item")];
      const settings = document.querySelector(".rail-settings > .rail-item")!;
      return {
        rail: box(document.querySelector(".app-rail")!).width,
        items: items.map((item) => `${box(item).width}x${box(item).height}`),
        glyphs: [...items, settings].map((item) => box(item.querySelector("svg")!).width),
        first: items[0]!.getAttribute("aria-label"),
        separators: [...document.querySelectorAll(".rail-separator")].map((line) => ({
          width: box(line).width,
          height: box(line).height,
          next: line.nextElementSibling?.getAttribute("aria-label"),
          gap: box(line.nextElementSibling!).top - box(line.previousElementSibling!).bottom,
        })),
        settingsBottom: box(document.querySelector(".app-rail")!).bottom - box(settings).bottom,
        filled: [...document.querySelectorAll(".app-rail svg")].filter((svg) => getComputedStyle(svg).fill !== "none").length,
      };
    });
    expect(geometry.rail).toBe(64);
    expect(new Set(geometry.items)).toEqual(new Set(["40x40"]));
    expect(new Set(geometry.glyphs)).toEqual(new Set([20]));
    expect(geometry.first).toBe("Search");
    expect(geometry.separators).toEqual([
      { width: 24, height: 1, next: "Multi-Agent Runs", gap: 13 },
      { width: 24, height: 1, next: "Archived Sessions", gap: 13 },
    ]);
    expect(geometry.settingsBottom, "Settings is pinned at the foot of the rail").toBeLessThanOrEqual(8);
    expect(geometry.filled, "no rail glyph is filled").toBe(0);
  });

  test("a hover shows the name and digit after the delay, and the next item's at once", async ({ page }) => {
    await openShell(page);
    await page.locator(".main").hover();
    const automations = rail(page).getByRole("link", { name: "Automations", exact: true });
    await expect(automations).toHaveAttribute("aria-keyshortcuts", "2");
    const started = Date.now();
    await automations.hover();
    await expect(tooltip(page)).toBeHidden();
    await expect(tooltip(page)).toHaveText("Automations2");
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    await expect(tooltip(page).locator("kbd")).toHaveText("2");
    const box = await tooltip(page).boundingBox();
    expect(box!.x, "it opens to the right of the rail").toBeGreaterThanOrEqual(64);

    await rail(page).getByRole("link", { name: "Projects", exact: true }).hover();
    await expect(tooltip(page)).toHaveText("Projects3", { timeout: 200 });

    // The pointer can move onto the tooltip without it closing (WCAG 1.4.13).
    const projectsTip = (await tooltip(page).boundingBox())!;
    await page.mouse.move(projectsTip.x + projectsTip.width / 2, projectsTip.y + projectsTip.height / 2, { steps: 6 });
    await expect(tooltip(page)).toHaveText("Projects3");
    await page.keyboard.press("Escape");
    await expect(tooltip(page)).toBeHidden();
  });

  test("keyboard focus shows the tooltip and a click does not", async ({ page }) => {
    await openShell(page);
    const search = rail(page).getByRole("button", { name: "Search", exact: true });
    await search.focus();
    await page.keyboard.press("Tab");
    const sessions = rail(page).getByRole("link", { name: "Sessions", exact: true });
    await expect(sessions).toBeFocused();
    await expect(tooltip(page)).toHaveText("Sessions1");

    await page.locator(".main").hover();
    await page.locator("#page-title").focus();
    await expect(tooltip(page)).toBeHidden();
    await rail(page).getByRole("link", { name: "Pods", exact: true }).click();
    await page.mouse.move(700, 450);
    await expect(tooltip(page)).toBeHidden();
  });

  test("Search opens the palette and gets focus back when it closes; Ctrl/Cmd+K opens the same palette", async ({ page }) => {
    await openShell(page);
    const search = rail(page).getByRole("button", { name: "Search", exact: true });
    await search.click();
    const palette = page.getByRole("dialog", { name: "Search" });
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await expect(search).toBeFocused();

    await page.locator("#page-title").focus();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(palette).toBeVisible();
  });

  test("Settings shows the current-page treatment when open", async ({ page }) => {
    await openShell(page, "/settings");
    const settings = rail(page).getByRole("button", { name: "Settings", exact: true });
    await expect(settings).toHaveAttribute("aria-current", "page");
    const look = await settings.evaluate((element) => {
      const style = getComputedStyle(element);
      const bar = getComputedStyle(element, "::before");
      const probe = document.createElement("span");
      probe.style.color = "var(--accent)";
      probe.style.backgroundColor = "var(--surface-selected)";
      document.body.append(probe);
      const expected = getComputedStyle(probe);
      const result = {
        color: style.color === expected.color,
        fill: style.backgroundColor === expected.backgroundColor,
        barWidth: bar.width,
        barColor: bar.backgroundColor === expected.color,
        barLeft: element.getBoundingClientRect().left + Number.parseFloat(bar.left),
      };
      probe.remove();
      return result;
    });
    expect(look).toEqual({ color: true, fill: true, barWidth: "3px", barColor: true, barLeft: 0 });
    await expect(page.locator('.app-rail [aria-current="page"]')).toHaveCount(1);
  });

  test("the brand is decoration and Tab skips it", async ({ page }) => {
    await openShell(page);
    const brand = page.locator(".rail-brand");
    await expect(brand).toHaveAttribute("aria-hidden", "true");
    expect(await brand.evaluate((element) => element.tagName)).toBe("DIV");
    await rail(page).focus();
    await page.keyboard.press("Tab");
    await expect(rail(page).getByRole("button", { name: "Search", exact: true })).toBeFocused();
  });
});

test.describe("on an 834px coarse-pointer tablet", () => {
  test.use({ viewport: { width: 834, height: 1112 }, hasTouch: true, isMobile: true });

  test("items are 48px, a tap never shows a tooltip, and no hover fill stays behind", async ({ page }) => {
    await openShell(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const sizes = await page.locator(".rail-destinations > .rail-item").evaluateAll((items) =>
      [...new Set(items.map((item) => `${item.getBoundingClientRect().width}x${item.getBoundingClientRect().height}`))]);
    expect(sizes).toEqual(["48x48"]);

    const pods = rail(page).getByRole("link", { name: "Pods", exact: true });
    await pods.tap();
    await expect(page.getByRole("heading", { level: 1, name: "Pods" })).toBeVisible();
    await page.waitForTimeout(700);
    await expect(tooltip(page)).toBeHidden();
    const automations = rail(page).getByRole("link", { name: "Automations", exact: true });
    await automations.tap();
    await expect(page.getByRole("heading", { level: 1, name: "Automations" })).toBeVisible();
    // Pods was tapped and left: its fill must be the rest fill, not the hover one.
    expect(await pods.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  });
});
