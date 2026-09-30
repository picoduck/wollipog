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
    const pane = document.querySelector(".project-manager-list");
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
          const search = box(pane.querySelector(".project-manager-search")!);
          const filter = box(pane.querySelector(".seg")!);
          return [filter.left - search.left, search.right - filter.right];
        })(),
      } : null,
      footerClipped: footerClipped(),
    };

    /** Sessions footer shortcuts the footer's hidden-scrollbar strip cuts off, even partly. */
    function footerClipped() {
      const strip = document.querySelector(".inbox-shortcut-rail");
      if (!strip || strip.getClientRects().length === 0) return [];
      const edge = box(strip);
      return [...strip.querySelectorAll("button")]
        .filter((button) => box(button).left < edge.left - 0.5 || box(button).right > edge.right + 0.5)
        .map((button) => button.getAttribute("aria-label"));
    }
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
        expect(chrome.footerClipped, `${where}: Sessions footer shortcuts cut off`).toEqual([]);
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
 * Page content the tier's audit found overflowing (#2106): the Archived Sessions table, the Usage
 * API card's controls and the Pod Orchestration Controls fields.
 */
async function checkPageContent(page: Page, where: string) {
  await open(page, "path=%2Farchived", "Archived Sessions");
  await expect(page.locator(".archive-table tbody tr").first()).toBeVisible();
  const archive = await page.evaluate(() => {
    const box = (element: Element) => element.getBoundingClientRect();
    const wrap = document.querySelector(".archive-table-wrap")!;
    const edge = box(wrap);
    return {
      scroll: wrap.scrollWidth - wrap.clientWidth,
      sessionColumn: box(document.querySelector(".archive-table thead th")!).width,
      rows: [...wrap.querySelectorAll("tbody tr")].map((row) => {
        const hidden = [".col-project", ".col-location", ".col-agent"].map((selector) => row.querySelector(selector)!);
        const meta = row.querySelector(".archive-session-meta")!;
        const cell = box(row.querySelector(".archive-session-cell")!);
        // Everything the row shows, cut off by its cell or by the wrapper.
        const clipped = [...row.querySelectorAll(".archive-session-meta > span, .archive-session-cell > a, .status, .actions-cell button, time")]
          .filter((element) => element.getClientRects().length > 0)
          .filter((element) => {
            const own = box(element);
            const td = box(element.closest("td")!);
            return own.left < Math.max(td.left, edge.left) - 0.5 || own.right > Math.min(td.right, edge.right) + 0.5;
          })
          .map((element) => element.textContent);
        return {
          columnsShown: hidden.map((element) => element.getClientRects().length > 0),
          values: hidden.map((element) => element.textContent),
          meta: meta.getClientRects().length > 0 ? (meta as HTMLElement).innerText : null,
          metaInside: box(meta).right <= cell.right + 0.5,
          clipped,
        };
      }),
    };
  });
  expect(archive.scroll, `${where}: the Archived Sessions table scrolls sideways`).toBeLessThanOrEqual(0);
  expect(archive.sessionColumn, `${where}: the Session column keeps room for a title`).toBeGreaterThanOrEqual(170);
  expect(archive.rows.length).toBeGreaterThan(0);
  for (const row of archive.rows) {
    expect(row.columnsShown, `${where}: Project, Location and Agent fold into the Session cell`).toEqual([false, false, false]);
    for (const value of row.values) expect(row.meta, `${where}: the Session cell shows ${value}`).toContain(value);
    expect(row.metaInside, `${where}: the meta line stays inside its cell`).toBe(true);
    expect(row.clipped, `${where}: row content cut off`).toEqual([]);
  }

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

  await open(page, "view=pod", "Active Collaboration Pod");
  const pod = await page.evaluate(() => {
    const box = (element: Element) => element.getBoundingClientRect();
    const card = document.querySelector(".pod-orchestration")!;
    const style = getComputedStyle(card);
    const inner = { left: box(card).left + parseFloat(style.paddingLeft), right: box(card).right - parseFloat(style.paddingRight) };
    return [...card.querySelectorAll(".pod-orchestration-grid > .field")].map((field) => {
      const label = field.querySelector("span")!;
      const control = field.querySelector("select, input") as HTMLSelectElement | HTMLInputElement;
      // A select is as wide as its longest option when nothing constrains it.
      const natural = control.cloneNode(true) as HTMLElement;
      natural.style.cssText = "position: absolute; width: auto; min-width: 0";
      field.append(natural);
      const needed = control instanceof HTMLSelectElement ? box(natural).width : 0;
      natural.remove();
      return {
        name: label.textContent,
        outside: Math.max(inner.left - box(field).left, box(field).right - inner.right),
        // The label's text on one line, and no wider than its field.
        labelClipped: (() => {
          const range = document.createRange();
          range.selectNodeContents(label);
          const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
          return lines !== 1 || range.getBoundingClientRect().right > box(field).right + 0.5;
        })(),
        valueClipped: box(control).width < needed - 0.5,
      };
    });
  });
  expect(pod.map((field) => field.name)).toEqual(["Arbitration", "Default Context Tokens", "Summary Tokens", "Turn Cap", "Repeated-Output Cap"]);
  for (const field of pod) {
    expectGeometry(field.outside, `${where}: ${field.name} reaches past the Orchestration Controls card`).toBeLessThanOrEqual(0.51);
    expect(field.labelClipped, `${where}: ${field.name} keeps its label on one line`).toBe(false);
    expect(field.valueClipped, `${where}: ${field.name} shows its longest option`).toBe(false);
  }
}

for (const width of [761, 834, 940, 1099]) {
  test(`at ${width}px, the Archived Sessions table, the Usage controls and the Pod Orchestration fields fit`, async ({ page }) => {
    await page.setViewportSize({ width, height: 860 });
    await checkPageContent(page, `at ${width}px`);
  });
}

test.describe("page content on an 834×1112 coarse-pointer tablet", () => {
  test.use({ viewport: { width: 834, height: 1112 }, hasTouch: true, isMobile: true });

  test("the same three surfaces fit with touch-sized controls", async ({ page }) => {
    await checkPageContent(page, "at 834px on touch");
  });
});

test("outside the tier the Archived Sessions table keeps its own Project, Location and Agent columns", async ({ page }) => {
  for (const width of [760, 1100]) {
    await page.setViewportSize({ width, height: 860 });
    await open(page, "path=%2Farchived", "Archived Sessions");
    const row = page.locator(".archive-table tbody tr").first();
    await expect(row.locator(".archive-session-meta"), `at ${width}px`).toBeHidden();
    // The phone rows show the project as line-2 meta and leave Location and Agent to the detail (§14).
    await expect(row.locator(".col-project"), `at ${width}px`).toBeVisible();
    if (width === 1100) {
      await expect(row.locator(".col-location")).toBeVisible();
      await expect(row.locator(".col-agent")).toBeVisible();
    }
  }
});

test.describe("either side of the tier", () => {
  test("the Projects list pane is 310px from 1100px, its filter inset like the search field", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 860 });
    await open(page, "path=%2Fprojects", "Projects");
    const chrome = await measureChrome(page);
    expect(chrome.pane!.width).toBe(310);
    expect(chrome.pane!.filterInset).toEqual([0, 0]);
  });

  test("a footer with room keeps every keycap and count", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 860 });
    await open(page, "path=%2Finbox", "Sessions");
    await expect(page.locator(".inbox-activity-footer")).not.toHaveAttribute("data-fit");
    await expect(page.locator(".inbox-shortcut-rail kbd").first()).toBeVisible();
    await expect(page.locator(".inbox-activity-minor").first()).toBeVisible();
  });
});

/**
 * The Sessions footer's shortcuts sit in a strip with a hidden scrollbar, so one that does not fit
 * is simply cut off. The labelled rail takes 144px of the footer's width, so both rails are checked.
 */
test.describe("the Sessions footer in the compact tier", () => {
  for (const [width, labelled] of [[940, false], [940, true], [761, true]] as const) {
    test(`no shortcut is cut off at ${width}px with the labelled rail ${labelled ? "on" : "off"}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 860 });
      await open(page, "path=%2Finbox", "Sessions");
      if (labelled) {
        await page.getByRole("navigation", { name: "Primary Navigation" })
          .getByRole("button", { name: "Expand Navigation", exact: true }).click();
        await expect(page.locator(".app-rail.labelled")).toBeVisible();
      }
      const shortcuts = page.locator(".inbox-shortcut-rail button");
      await expect(shortcuts.first()).toBeVisible();
      expect(await shortcuts.count()).toBeGreaterThanOrEqual(6);
      expect((await measureChrome(page)).footerClipped).toEqual([]);
      // Whatever the footer gave up, every shortcut and count keeps its accessible name.
      await expect(page.getByRole("group", { name: "Session Shortcuts" }).getByRole("button"))
        .toHaveCount(await shortcuts.count());
      await expect(page.getByLabel("Sessions Activity Summary")).toContainText("Running");
      await expect(page.getByLabel("Sessions Activity Summary")).toContainText("Stalled");
    });
  }
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
