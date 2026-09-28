import { expect, test, type Page } from "@playwright/test";

/**
 * Page anatomy (#1801; docs/design-system.md §4.2 page header, §4.3 detail bar, §4.5 page
 * container, §15.1 phone app bar), measured in the real Shell.
 */
const shell = (path: string) => `/command-inbox-projects-e2e.html?fullShell=1&path=${encodeURIComponent(path)}`;

const DESTINATIONS = [
  { path: "/inbox", title: "Sessions" },
  { path: "/automations", title: "Automations", description: true, max: 960 },
  { path: "/projects", title: "Projects", description: true },
  { path: "/runs", title: "Multi-Agent Runs", max: 960 },
  { path: "/pods", title: "Collaboration Pods", max: 960 },
  { path: "/connections", title: "Connections", max: 960 },
  { path: "/skills", title: "Agent Skills", description: true },
  { path: "/archived", title: "Archived Sessions", max: 1200 },
  { path: "/usage", title: "Usage & Cost", description: true, max: 1200 },
  { path: "/settings", title: "Settings" },
] as const;

async function openDestination(page: Page, path: string, title: string) {
  await page.goto(shell(path));
  await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
}

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const destination of DESTINATIONS) {
    test(`${destination.title} has one left-aligned page header and container`, async ({ page }) => {
      await openDestination(page, destination.path, destination.title);
      const geometry = await page.evaluate(() => {
        const title = document.getElementById("page-title")!;
        const header = title.closest(".page-header")!;
        const container = header.closest(".page")!;
        const content = [...container.children].find((child) => child !== header && child.getBoundingClientRect().height > 0)!;
        const rail = document.querySelector(".app-rail")!.getBoundingClientRect();
        const style = getComputedStyle(title);
        const texts = [...document.querySelectorAll<HTMLElement>(".main *")].filter((element) =>
          [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim()) &&
          element.getClientRects().length > 0);
        return {
          h1s: document.querySelectorAll("h1").length,
          id: title.id,
          tabIndex: title.tabIndex,
          railRight: rail.right,
          titleX: title.getBoundingClientRect().x,
          contentX: content.getBoundingClientRect().x,
          containerX: container.getBoundingClientRect().x,
          containerWidth: container.getBoundingClientRect().width,
          marginLeft: getComputedStyle(container).marginLeft,
          headerHeight: header.getBoundingClientRect().height,
          font: `${style.fontSize}/${style.lineHeight} ${style.fontWeight}`,
          largest: Math.max(...texts.map((element) => Number.parseFloat(getComputedStyle(element).fontSize))),
          topbar: document.querySelectorAll(".topbar").length,
          description: header.querySelector(".page-desc")?.textContent ?? null,
        };
      });
      expect(geometry.h1s).toBe(1);
      expect(geometry.tabIndex).toBe(-1);
      expect(geometry.topbar, "no top bar title beside the page header").toBe(0);
      expect(geometry.titleX).toBe(geometry.railRight + 24);
      // Sessions keeps its edge-to-edge tab row, list and preview; only its header takes the gutter.
      if (destination.path !== "/inbox") expect(geometry.contentX).toBe(geometry.titleX);
      expect(geometry.marginLeft, "containers are never centred").toBe("0px");
      expect(geometry.containerX).toBe(geometry.railRight);
      if ("max" in destination) expect(geometry.containerWidth).toBe(destination.max + 48);
      expect(geometry.headerHeight).toBe("description" in destination ? 88 : 64);
      expect(geometry.font).toBe("20px/28px 600");
      expect(geometry.largest, "the page title is the largest text on the page").toBeLessThanOrEqual(20);
      if (geometry.description !== null) {
        expect(geometry.description.length).toBeLessThanOrEqual(80);
        expect(geometry.description).not.toMatch(/control plane|durable|runtime capacity|snapshot|projection/i);
      }
    });
  }

  test("Multi-Agent Runs and Collaboration Pods create from a 32px primary with a plus icon", async ({ page }) => {
    for (const [path, title, label] of [
      ["/runs", "Multi-Agent Runs", "New Multi-Agent Run"],
      ["/pods", "Collaboration Pods", "New Collaboration Pod"],
    ] as const) {
      await openDestination(page, path, title);
      const primary = page.locator(".page-header").getByRole("button", { name: label, exact: true });
      await expect(primary).toBeVisible();
      await expect(primary).toHaveClass(/\bbtn\b.*\bprimary\b/);
      await expect(primary.locator("svg")).toHaveCount(1);
      const box = await primary.boundingBox();
      expect(box!.height, `${label} is one line at the control height`).toBe(32);
    }
  });

  test("Settings content is a form-width column that scrolls with the page, once", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 420 });
    await openDestination(page, "/settings", "Settings");
    const scrollers = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".main, .main *")]
      .filter((element) => /(auto|scroll)/.test(getComputedStyle(element).overflowY) &&
        element.scrollHeight > element.clientHeight + 1)
      .map((element) => element.className));
    expect(scrollers).toEqual(["main-body"]);
    const panel = await page.locator(".settings-panel").boundingBox();
    expect(panel!.width).toBeLessThanOrEqual(760);
    await page.locator(".main-body").evaluate((element) => element.scrollBy(0, 200));
    expect(await page.locator(".main-body").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  });

  test("route changes focus the page title without a ring, and Archived is labelled by it", async ({ page }) => {
    await openDestination(page, "/inbox", "Sessions");
    await page.getByRole("link", { name: /^Automations/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Automations" })).toBeVisible();
    // A digit shortcut from <body> changes the route with nothing focused, so the shell's rescue
    // puts focus on the new page's title (a clicked rail link keeps focus, by design).
    await page.locator("body").evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const digit = await page.getByRole("link", { name: /^Archived/ }).locator(".rail-number").textContent();
    await page.keyboard.press(digit!.trim());
    const title = page.getByRole("heading", { level: 1, name: "Archived Sessions" });
    await expect(title).toBeFocused();
    expect(await title.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
    await expect(page.getByRole("region", { name: "Archived Sessions" })).toBeVisible();
  });
});

test.describe("page header actions follow the width tiers", () => {
  const visibleSecondaries = (page: Page) => page.locator(".page-header .page-action:visible");
  const primaryRight = (page: Page) => page.locator(".page-header .page-primary").evaluate((element) => {
    const header = element.closest(".page-header-row")!.getBoundingClientRect();
    return Math.round(header.right - element.getBoundingClientRect().right);
  });
  const menuItems = async (page: Page) => {
    await page.locator(".page-header").getByRole("button", { name: "More Actions", exact: true }).click();
    const items = await page.getByRole("menu", { name: "More Actions" }).getByRole("menuitem").evaluateAll((elements) =>
      elements.filter((element) => getComputedStyle(element).display !== "none").map((element) => element.textContent));
    await page.keyboard.press("Escape");
    return items;
  };

  test("desktop shows two secondaries, compact one, and the rest move into ⋯ from the left", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDestination(page, "/skills", "Agent Skills");
    await expect(visibleSecondaries(page)).toHaveText(["Manage Groups", "Import from Git"]);
    expect(await menuItems(page)).toEqual(["Import from Machine"]);
    expect(await primaryRight(page)).toBe(0);

    await page.setViewportSize({ width: 900, height: 800 });
    await expect(visibleSecondaries(page)).toHaveText(["Import from Git"]);
    expect(await menuItems(page)).toEqual(["Import from Machine", "Manage Groups"]);
    expect(await primaryRight(page)).toBe(0);
    const heights = await page.locator(".page-header .page-actions > :visible").evaluateAll((elements) =>
      elements.map((element) => Math.round(element.getBoundingClientRect().height)));
    expect(new Set(heights)).toEqual(new Set([32]));
  });

  test("⋯ opens under its trigger, over the whole page, and closes from outside", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await openDestination(page, "/skills", "Agent Skills");
    const trigger = page.locator(".page-header").getByRole("button", { name: "More Actions", exact: true });
    await trigger.click();
    const menu = page.getByRole("menu", { name: "More Actions" });
    const [triggerBox, menuBox] = [await trigger.boundingBox(), await menu.boundingBox()];
    expect(Math.round(menuBox!.x + menuBox!.width)).toBe(Math.round(triggerBox!.x + triggerBox!.width));
    expect(menuBox!.y).toBeGreaterThan(triggerBox!.y + triggerBox!.height - 1);
    expect(await page.locator(".menu-backdrop").evaluate((element) => {
      const box = element.getBoundingClientRect();
      return [box.width, box.height];
    })).toEqual([900, 800]);
    await page.mouse.click(450, 700);
    await expect(menu).toHaveCount(0);

    // Keyboard: Tab out of ⋯ reaches the primary beside it, not the end of the document.
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(menu).toHaveCount(0);
    await expect(page.locator(".page-header").getByRole("button", { name: "New Skill", exact: true })).toBeFocused();
  });

  test("⋯ follows a resize: it re-reads its list, and closes when it has nothing left", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDestination(page, "/skills", "Agent Skills");
    const trigger = page.locator(".page-header").getByRole("button", { name: "More Actions", exact: true });
    await trigger.click();
    const items = page.getByRole("menu", { name: "More Actions" }).getByRole("menuitem");
    await expect(items).toHaveText(["Import from Machine", "Manage Groups", "Import from Git"]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(items).toHaveText(["Import from Machine"]);

    // Connections has one secondary, so ⋯ exists only while that button is hidden: widening past
    // the phone tier hides ⋯ itself, and its menu and backdrop must go with it.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(shell("/connections"));
    await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
    await expect(page.locator(".page-header .page-action")).toHaveText(["Add Native Runner"]);
    await page.locator(".page-header").getByRole("button", { name: "More Actions", exact: true }).click();
    await expect(page.getByRole("menu", { name: "More Actions" }).getByRole("menuitem")).toHaveText(["Add Native Runner"]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole("menu", { name: "More Actions" })).toHaveCount(0);
    await expect(page.locator(".menu-backdrop")).toHaveCount(0);
    await expect(page.locator(".page-header").getByRole("button", { name: "Add Native Runner", exact: true })).toBeVisible();
  });

  test.describe("on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("an open Project's detail bar is full-bleed like every detail bar", async ({ page }) => {
      await page.goto(shell(`/projects/~${Buffer.from("alpha", "utf16le").toString("base64url")}`));
      const bar = page.locator(".detail-bar");
      await expect(bar.getByRole("heading", { level: 1, name: "Alpha" })).toBeVisible();
      await expect(page.locator("h1")).toHaveCount(1);
      const geometry = await bar.evaluate((element) => ({
        bar: element.getBoundingClientRect().toJSON(),
        back: element.querySelector(".detail-bar-back")!.getBoundingClientRect().toJSON(),
      }));
      expect([geometry.bar.x, geometry.bar.width, geometry.bar.height]).toEqual([0, 390, 48]);
      expect(geometry.back.x).toBe(16);
    });

    test("the header is a 48px app bar with a 44px plus primary and ⋯", async ({ page }) => {
      await openDestination(page, "/skills", "Agent Skills");
      const bar = await page.locator(".page-header-row").boundingBox();
      expect(bar!.height).toBe(48);
      const title = page.locator("#page-title");
      expect(await title.evaluate((element) => getComputedStyle(element).fontSize)).toBe("16px");
      await expect(page.locator(".page-desc")).toBeHidden();
      await expect(visibleSecondaries(page)).toHaveCount(0);
      const primary = page.locator(".page-header").getByRole("button", { name: "New Skill", exact: true });
      const box = await primary.boundingBox();
      expect([box!.width, box!.height]).toEqual([44, 44]);
      await expect(primary).toHaveAccessibleName("New Skill");
      expect(await menuItems(page)).toEqual(["Import from Machine", "Manage Groups", "Import from Git"]);
    });
  });
});
