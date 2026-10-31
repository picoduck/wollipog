import { expect, test, type Page } from "@playwright/test";
import { expectGeometry } from "./geometry-margins.js";

/**
 * The compact desktop tier, 761–1099px (#1969; docs/design-system.md §2.10, §15.2), in the real
 * Shell: the widths between a phone and the full desktop layout, including the desktop app's
 * 940×600 minimum window and an iPad in portrait.
 */
const fixture = (query: string) => `/command-inbox-projects-e2e.html?fullShell=1&${query}`;

const ROUTES = [
  { query: "path=%2Finbox", title: "Sessions" },
  { query: "path=%2Fautomations", title: "Automations" },
  { query: "path=%2Fprojects", title: "Projects" },
  { query: "path=%2Fruns", title: "Multi-Agent Runs" },
  { query: "path=%2Fpods", title: "Pods" },
  { query: "path=%2Fconnections", title: "Connections" },
  { query: "path=%2Fskills", title: "Agent Skills" },
  { query: "path=%2Farchived", title: "Archived Sessions" },
  { query: "path=%2Fusage", title: "Usage and Cost" },
  { query: "path=%2Fsettings", title: "Settings" },
  { query: "view=run", title: "Final QA Run" },
  { query: "view=pod", title: "Active Collaboration Pod" },
] as const;

async function open(page: Page, query: string, title: string) {
  await page.goto(fixture(query));
  await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
  await expect(page.locator("[data-route-loading]")).toBeHidden();
}

/**
 * Everything the tier promises about the shell's own chrome, measured at once: the page header or
 * detail bar, the rail and the Projects list pane. Page content (a table, a form) is not the shell's.
 */
async function measureChrome(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element) => element.getBoundingClientRect();
    const shown = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).position !== "absolute";
    const overlaps = (a: DOMRect, b: DOMRect) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
    /** For a row: how far any shown child reaches past it, and which pairs of children overlap. */
    const row = (element: Element | null) => {
      if (!element) return null;
      const outer = box(element);
      const children = [...element.children].filter(shown);
      const escape = Math.max(0, ...children.map((child) => Math.max(box(child).right - outer.right, outer.left - box(child).left)));
      const overlapping: string[] = [];
      // A wrapped row puts one child wholly below another; a row shares at least some height.
      const stacked: string[] = [];
      children.forEach((a, i) => children.slice(i + 1).forEach((b) => {
        if (overlaps(box(a), box(b))) overlapping.push(`${a.className} / ${b.className}`);
        if (box(b).top >= box(a).bottom - 0.5 || box(a).top >= box(b).bottom - 0.5) stacked.push(`${a.className} / ${b.className}`);
      }));
      return { height: outer.height, escape, overlapping, stacked };
    };
    const rail = document.querySelector(".app-rail")!;
    const pane = document.querySelector('.master-detail-list[aria-label="Projects"]');
    return {
      pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      mainScroll: (() => {
        const body = document.querySelector(".main-body")!;
        return body.scrollWidth - body.clientWidth;
      })(),
      header: row(document.querySelector(".page-header-row")),
      actions: row(document.querySelector(".page-actions")),
      bar: row(document.querySelector(".detail-bar")),
      barHeading: row(document.querySelector(".detail-bar-heading")),
      barActions: row(document.querySelector(".detail-bar-actions")),
      railOverflow: rail.scrollHeight - rail.clientHeight,
      railItemsOutside: [...rail.querySelectorAll(".rail-item")]
        .filter((item) => box(item).top < 0 || box(item).bottom > window.innerHeight)
        .map((item) => item.getAttribute("aria-label")),
      pane: pane ? {
        width: box(pane).width,
        scroll: pane.scrollWidth - pane.clientWidth,
        // The visibility filter keeps the search field's inset on both sides.
        filterInset: (() => {
          const search = box(pane.querySelector(".input-affix")!);
          const filter = box(pane.querySelector(".seg")!);
          return [filter.left - search.left, search.right - filter.right];
        })(),
      } : null,
      // The Sessions shortcut rail and activity footer are retired (#2214) at every width.
      retiredFooter: document.querySelectorAll(".inbox-shortcut-rail, .inbox-activity-footer").length,
    };
  });
}

for (const width of [761, 834, 940, 1099]) {
  test.describe(`at ${width}px wide`, () => {
    test.use({ viewport: { width, height: 860 } });

    test("no page header, detail bar, rail item or list pane wraps, overlaps or scrolls sideways", async ({ page }) => {
      expect(await page.evaluate(() => matchMedia("(min-width: 761px) and (max-width: 1099px)").matches)).toBe(true);
      for (const route of ROUTES) {
        await open(page, route.query, route.title);
        const chrome = await measureChrome(page);
        const where = `${route.title} at ${width}px`;
        expect(chrome.pageScroll, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(0);
        expect(chrome.mainScroll, `${where}: the main column scrolls sideways`).toBeLessThanOrEqual(0);
        expect(chrome.railOverflow, `${where}: the rail scrolls`).toBeLessThanOrEqual(0);
        expect(chrome.railItemsOutside, `${where}: rail items off screen`).toEqual([]);
        expect(chrome.retiredFooter, `${where}: no shortcut rail or activity footer`).toBe(0);
        if (route.query.startsWith("view=")) {
          expect(chrome.bar, `${where}: a detail bar`).not.toBeNull();
          expect(chrome.bar!.height, `${where}: the detail bar is one 48px row`).toBe(48);
          for (const part of [chrome.bar!, chrome.barHeading!, ...(chrome.barActions ? [chrome.barActions] : [])]) {
            expectGeometry(part.escape, `${where}: nothing in the detail bar reaches past its row`).toBeLessThanOrEqual(0.51);
            expect(part.overlapping, `${where}: detail bar parts overlap`).toEqual([]);
            expect(part.stacked, `${where}: the detail bar wraps`).toEqual([]);
          }
        } else {
          expect(chrome.header, `${where}: a page header`).not.toBeNull();
          expectGeometry(chrome.header!.escape, `${where}: nothing in the page header reaches past it`).toBeLessThanOrEqual(0.51);
          expect(chrome.header!.overlapping, `${where}: the title and the actions overlap`).toEqual([]);
          expect(chrome.header!.stacked, `${where}: the actions wrapped below the title`).toEqual([]);
          if (chrome.actions) {
            expect(chrome.actions.stacked, `${where}: the page actions wrap`).toEqual([]);
            expect(chrome.actions.overlapping, `${where}: page actions overlap`).toEqual([]);
          }
        }
        if (route.title === "Projects") {
          expect(chrome.pane, "the Projects list pane").not.toBeNull();
          expect(chrome.pane!.width, `the Projects list pane at ${width}px`).toBe(280);
          expect(chrome.pane!.scroll, "the Projects list pane scrolls sideways").toBeLessThanOrEqual(0);
          expect(chrome.pane!.filterInset, "the visibility filter is inset like the search field").toEqual([0, 0]);
        }
      }
    });
  });
}

/**
 * Fixed archive rows never scroll sideways, and their native title links keep readable width.
 */
async function checkArchivedTable(page: Page, where: string, { minSession }: { folded: boolean; minSession: number }) {
  await expect(page.locator(".archive-item").first()).toBeVisible();
  const rows = await page.locator(".archive-item").evaluateAll((items) => items.map((row) => ({
    height: row.getBoundingClientRect().height,
    title: row.querySelector("a")!.getBoundingClientRect().width,
    overflow: row.scrollWidth - row.clientWidth,
  })));
  for (const row of rows) {
    expect(row.height, where).toBe(56);
    expect(row.title, where).toBeGreaterThanOrEqual(minSession);
    expect(row.overflow, where).toBeLessThanOrEqual(0);
  }
  await expect(page.locator(".archive-table")).toHaveCount(0);
}

/**
 * Page content the tier's audit found overflowing (#2106): the Archived Sessions table and the Usage
 * API card's controls.
 */
async function checkPageContent(page: Page, where: string) {
  await open(page, "path=%2Farchived", "Archived Sessions");
  await checkArchivedTable(page, where, { folded: true, minSession: 200 });

  await open(page, "path=%2Fusage", "Usage and Cost");
  const usage = await page.evaluate(() => {
    const box = (element: Element) => element.getBoundingClientRect();
    const card = document.querySelector(".usage-api-controls")!;
    const description = card.querySelector(".usage-api-controls-heading p")!;
    const controls = [...card.querySelectorAll(".usage-desktop-controls > .seg")];
    const style = getComputedStyle(description);
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const text = description.textContent!;
    const overlaps = (a: DOMRect, b: DOMRect) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
    return {
      count: controls.length,
      rows: new Set(controls.map((control) => Math.round(box(control).top))).size,
      overlapping: controls.flatMap((a, i) => [description, ...controls.slice(i + 1)]
        .filter((b) => overlaps(box(a), box(b))).map((b) => `${a.getAttribute("aria-label")} / ${b.textContent}`)),
      escape: Math.max(...controls.map((control) => box(control).right)) - box(card).right,
      charactersPerLine: box(description).width / (context.measureText(text).width / text.length),
    };
  });
  expect(usage.count).toBe(3);
  expect(usage.rows, `${where}: the Usage controls stay on one row`).toBe(1);
  expect(usage.overlapping, `${where}: the Usage controls overlap`).toEqual([]);
  expectGeometry(usage.escape, `${where}: the Usage controls stay inside their card`).toBeLessThanOrEqual(0.51);
  expect(usage.charactersPerLine, `${where}: the Usage description keeps a readable measure`).toBeGreaterThanOrEqual(30);
}

for (const width of [761, 834, 940, 1099]) {
  test(`at ${width}px, the Archived Sessions table and the Usage controls fit`, async ({ page }) => {
    await page.setViewportSize({ width, height: 860 });
    await checkPageContent(page, `at ${width}px`);
  });
}

test.describe("page content on an 834×1112 coarse-pointer tablet", () => {
  test.use({ viewport: { width: 834, height: 1112 }, hasTouch: true, isMobile: true });

  test("the same two surfaces fit with touch-sized controls", async ({ page }) => {
    await checkPageContent(page, "at 834px on touch");
  });
});

async function expandRail(page: Page) {
  await page.getByRole("navigation", { name: "Primary Navigation" })
    .getByRole("button", { name: "Expand Navigation", exact: true }).click();
  await expect(page.locator(".app-rail.labelled")).toBeVisible();
}

test("a phone keeps the Archived Sessions table's own rows, with the project on line 2", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 860 });
  await open(page, "path=%2Farchived", "Archived Sessions");
  const row = page.locator(".archive-item").first();
  await expect(row.locator(".archive-item-meta")).toBeVisible();
  await expect(row.locator(".archive-project")).toBeVisible();
  await expect(row.locator("time")).toBeHidden();
});

test.describe("Archived Sessions rows across compact and desktop widths", () => {
  const cases = [
    ...[761, 834, 940, 1099].flatMap((width) => [false, true].map((labelled) => ({ width, labelled, folded: false }))),
    { width: 1100, labelled: false, folded: true },
    { width: 1280, labelled: false, folded: true },
    { width: 1439, labelled: false, folded: false },
    { width: 1100, labelled: true, folded: true },
    { width: 1280, labelled: true, folded: true },
    { width: 1439, labelled: true, folded: false },
  ];
  for (const { width, labelled, folded } of cases) {
    test(`at ${width}px with the labelled rail ${labelled ? "on" : "off"}, the Session column keeps 200px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 860 });
      await open(page, "path=%2Farchived", "Archived Sessions");
      if (labelled) await expandRail(page);
      await checkArchivedTable(page, `at ${width}px, labelled rail ${labelled ? "on" : "off"}`, { folded, minSession: 200 });
    });
  }

  test("the full layout returns exactly where it fits", async ({ page }) => {
    await open(page, "path=%2Farchived", "Archived Sessions");
    for (const [width, folded] of [[1283, true], [1284, false]] as const) {
      await page.setViewportSize({ width, height: 860 });
      await checkArchivedTable(page, `at ${width}px`, { folded, minSession: 200 });
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "Archived Sessions", exact: true })).toBeVisible();
    }
  });
});

test.describe("either side of the tier", () => {
  test("the Projects list pane is 320px once the main column is 1100px, its filter inset like the search field", async ({ page }) => {
    // The pane answers to the main column (`@container app`, #2105), so the tier ends where the
    // column, not the window, reaches 1100px: the window is 1100px plus the rail.
    await page.setViewportSize({ width: 1440, height: 860 });
    await open(page, "path=%2Fprojects", "Projects");
    const rail = await page.locator(".app-rail").evaluate((element) => element.getBoundingClientRect().width);
    await page.setViewportSize({ width: 1100 + Math.ceil(rail), height: 860 });
    await expect.poll(() => page.locator(".main").evaluate((main) => main.getBoundingClientRect().width))
      .toBeGreaterThanOrEqual(1100);
    const chrome = await measureChrome(page);
    expect(chrome.pane!.width).toBe(320);
    expect(chrome.pane!.filterInset).toEqual([0, 0]);
  });

  test("a wide Sessions list has no shortcut rail or activity footer either (#2214)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 860 });
    await open(page, "path=%2Finbox", "Sessions");
    expect((await measureChrome(page)).retiredFooter).toBe(0);
  });
});

test.describe("at 940×600 with a mouse, the desktop app's minimum window", () => {
  test.use({ viewport: { width: 940, height: 600 } });

  test("every rail item, Search and Settings included, fits without the rail scrolling", async ({ page }) => {
    await open(page, "path=%2Finbox", "Sessions");
    expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(true);
    const chrome = await measureChrome(page);
    expect(chrome.railOverflow).toBeLessThanOrEqual(0);
    expect(chrome.railItemsOutside).toEqual([]);
    const rail = await page.evaluate(() => {
      const box = (element: Element) => element.getBoundingClientRect();
      const items = [...document.querySelectorAll(".app-rail .rail-item")];
      const settings = document.querySelector(".rail-settings > .rail-item")!;
      const destinations = document.querySelector(".rail-destinations")!;
      return {
        names: items.map((item) => item.getAttribute("aria-label")),
        sizes: [...new Set(items.map((item) => `${box(item).width}x${box(item).height}`))],
        gap: getComputedStyle(destinations).rowGap,
        separatorGaps: [...document.querySelectorAll(".rail-separator")].map((line) => [
          box(line).top - box(line.previousElementSibling!).bottom,
          box(line.nextElementSibling!).top - box(line).bottom,
        ]),
        // What is left under the last destination for #1970's instance tile and #1968's toggle.
        slack: box(settings).top - box(destinations).bottom,
      };
    });
    expect(rail.names[0]).toBe("Search");
    expect(rail.names.at(-1)).toBe("Settings");
    expect(rail.names).toHaveLength(11);
    expect(rail.sizes, "36px items at a short height").toEqual(["36x36"]);
    expect(rail.gap).toBe("2px");
    expect(rail.separatorGaps, "4px either side of a group hairline").toEqual([[4, 4], [4, 4]]);
    expectGeometry(rail.slack, "room for the instance tile and the labels toggle")
      .toBeGreaterThanOrEqual(2 * (36 + 2));
  });

  test("the labelled rail fits too, and switching labels moves no icon at the short size", async ({ page }) => {
    await open(page, "path=%2Finbox", "Sessions");
    const icons = () => page.evaluate(() => {
      const centre = (element: Element) => {
        const box = element.getBoundingClientRect();
        return box.left + box.width / 2;
      };
      return [
        centre(document.querySelector(".rail-brand")!),
        // A destination's glyph sits in its icon box in the 64px rail (#1967).
        ...[...document.querySelectorAll(".app-rail .rail-item > svg, .app-rail .rail-item > .rail-icon > svg")].map(centre),
        centre(document.querySelector(".rail-foot > button")!),
      ];
    });
    const before = await icons();
    await page.getByRole("navigation", { name: "Primary Navigation" })
      .getByRole("button", { name: "Expand Navigation", exact: true }).click();
    await expect(page.locator(".app-rail.labelled")).toBeVisible();
    expect(await icons(), "each icon stays where the 64px rail centres it").toEqual(before);
    const chrome = await measureChrome(page);
    expect(chrome.railOverflow).toBeLessThanOrEqual(0);
    expect(chrome.railItemsOutside).toEqual([]);
    const foot = (await page.locator(".rail-foot > button").boundingBox())!;
    expect(foot.y + foot.height, "the labels toggle is on screen").toBeLessThanOrEqual(600);
  });

  test("a detail bar that would leave its title unreadable shows its status as a dot", async ({ page }) => {
    await open(page, "view=pod", "Active Collaboration Pod");
    const badge = page.locator(".detail-bar-status");
    await expect(badge).not.toHaveAttribute("data-dot");
    await expect(badge).not.toHaveAttribute("title");
    const full = (await badge.boundingBox())!.width;
    // Squeeze the heading the way a bar full of actions would: the title's room drops under 200px.
    await page.addStyleTag({ content: ".detail-bar-heading { flex: 0 0 240px; }" });
    await expect(badge).toHaveAttribute("data-dot", "");
    await expect(badge).toHaveAttribute("title", "Active");
    const dot = (await badge.boundingBox())!.width;
    expect(dot).toBe(22);
    expectGeometry(full - dot, "the title gains the label's room").toBeGreaterThan(20);
    await expect(badge).toHaveText("Active");
    // The label starts at the clip edge, so none of it shows.
    const clip = await badge.locator(".status").evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().left - element.getBoundingClientRect().right;
    });
    expectGeometry(clip, "the label begins at or past the badge's clipped edge").toBeGreaterThanOrEqual(-0.39);
  });
});

test.describe("at 940×860 with a mouse", () => {
  test.use({ viewport: { width: 940, height: 860 } });

  test("the rail keeps its normal 40px items", async ({ page }) => {
    await open(page, "path=%2Finbox", "Sessions");
    const sizes = await page.locator(".app-rail .rail-item").evaluateAll((items) =>
      [...new Set(items.map((item) => `${item.getBoundingClientRect().width}x${item.getBoundingClientRect().height}`))]);
    expect(sizes).toEqual(["40x40"]);
  });
});

test.describe("on an 834×1112 coarse-pointer tablet", () => {
  test.use({ viewport: { width: 834, height: 1112 }, hasTouch: true, isMobile: true });

  test("targets stay 44px or larger; the short-height rule is for a mouse only", async ({ page }) => {
    await open(page, "path=%2Fprojects", "Projects");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const targets = async () => page.evaluate(() => [
      ...document.querySelectorAll(".app-rail .rail-item, .page-actions button, .detail-bar button"),
    ].filter((element) => element.getClientRects().length > 0).map((element) => ({
      name: element.getAttribute("aria-label") ?? element.textContent,
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    })));
    for (const target of await targets()) {
      expect(target.height, `${target.name} is tall enough to tap`).toBeGreaterThanOrEqual(44);
      expect(target.width, `${target.name} is wide enough to tap`).toBeGreaterThanOrEqual(44);
    }
    await open(page, "view=pod", "Active Collaboration Pod");
    for (const target of await targets()) {
      expect(target.height, `${target.name} is tall enough to tap`).toBeGreaterThanOrEqual(44);
      expect(target.width, `${target.name} is wide enough to tap`).toBeGreaterThanOrEqual(44);
    }
    // Even on a short tablet in landscape, touch keeps its 48px rail items.
    await page.setViewportSize({ width: 1112, height: 600 });
    const sizes = await page.locator(".app-rail .rail-destinations > .rail-item").evaluateAll((items) =>
      [...new Set(items.map((item) => `${item.getBoundingClientRect().width}x${item.getBoundingClientRect().height}`))]);
    expect(sizes).toEqual(["48x48"]);
  });
});
