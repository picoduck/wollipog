import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion";

/**
 * The main column is the `app` size container (docs/design-system.md §2.10, #2105).
 *
 * At the build floor (Chrome 111–128, older Safari) `container-type` also applies layout
 * containment, which makes `.main` the box every `position: fixed` descendant resolves against.
 * Current Chromium no longer does that, so these tests force `contain: layout` on `.main` to stand in
 * for a floor engine. Each anchored surface must then open where it opens without containment, next
 * to its trigger, with and without the page banner that sits above the page inside `.main`.
 */
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;

const shell = (path: string, banner: boolean) =>
  `/command-inbox-projects-e2e.html?fullShell=1&reminders=1${banner ? "&offlineBanner=1" : ""}`
  + `&path=${encodeURIComponent(path)}`;

async function openShell(page: Page, path: string, title: string, banner: boolean) {
  await page.goto(shell(path, banner));
  await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
  // The offline banner is held back for 2s of disconnection (§12.5).
  if (banner) await expect(page.locator(".main > .notice.page-banner")).toBeVisible();
  else await expect(page.locator(".notice.page-banner")).toHaveCount(0);
}

/**
 * Stand in for a floor engine, and prove the stand-in took: a bare fixed element at the viewport's
 * corner now lands at the main column's corner instead, which is exactly what used to push every
 * anchored list right by the rail's width.
 */
async function forceFloorEngine(page: Page, container = ".main") {
  await page.addStyleTag({ content: `${container} { contain: layout !important; }` });
  const { probe, box } = await page.evaluate((selector) => {
    const host = document.querySelector(selector)!;
    const element = document.createElement("div");
    element.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px";
    host.appendChild(element);
    const rect = element.getBoundingClientRect();
    element.remove();
    const own = host.getBoundingClientRect();
    return { probe: { x: rect.left, y: rect.top }, box: { x: own.left, y: own.top } };
  }, container);
  expect(probe, `${container} is the fixed containing block`).toEqual(box);
  expect(box.x + box.y, `${container} is offset from the viewport, so an uncorrected surface would move`)
    .toBeGreaterThan(0);
}

interface Rect { left: number; right: number; top: number; bottom: number }

async function rectOf(locator: Locator): Promise<Rect> {
  return locator.evaluate((element) => {
    const { left, right, top, bottom } = element.getBoundingClientRect();
    return { left, right, top, bottom };
  });
}

/** The surface's rectangle, and the side of the trigger it opened on, 6px away (interactions.ts). */
async function anchoredTo(trigger: Locator, surface: Locator, gap = 6) {
  const [anchor, placed] = await Promise.all([rectOf(trigger), rectOf(surface)]);
  const below = Math.abs(placed.top - (anchor.bottom + gap)) <= 1;
  const above = Math.abs(placed.bottom - (anchor.top - gap)) <= 1;
  expect(below || above, `opens ${gap}px below or above its trigger: ${JSON.stringify({ anchor, placed })}`).toBe(true);
  return placed;
}

function expectSameRect(actual: Rect, expected: Rect, label: string) {
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    expect(Math.abs(actual[edge] - expected[edge]), `${label}: ${edge} ${actual[edge]} vs ${expected[edge]}`)
      .toBeLessThanOrEqual(1);
  }
}

async function evidence(page: Page, name: string) {
  if (!EVIDENCE_DIR) return;
  await page.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` });
}

test.use({ viewport: { width: 1280, height: 900 } });

for (const banner of [false, true]) {
  const variant = banner ? "with the page banner" : "without a page banner";
  const tag = banner ? "banner" : "no-banner";

  test(`the Select listbox stays on its trigger in a contained main column, ${variant}`, async ({ page }) => {
    await openShell(page, "/settings", "Settings", banner);
    const trigger = page.getByRole("button", { name: /^Color Scheme:/ });
    const list = page.getByRole("listbox", { name: "Color Scheme" });
    await trigger.click();
    const open = await anchoredTo(trigger, list);
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);

    await forceFloorEngine(page);
    await trigger.click();
    expectSameRect(await anchoredTo(trigger, list), open, "Select listbox");
    expect(Math.abs(open.left - (await rectOf(trigger)).left)).toBeLessThanOrEqual(1);
    await evidence(page, `select-listbox-contained-${tag}`);
    // Keyboard and dismissal are unchanged: arrows move, Escape closes and returns focus.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test(`the combobox list stays on its field in a contained main column, ${variant}`, async ({ page }) => {
    await openShell(page, "/inbox", "Sessions", banner);
    await forceFloorEngine(page);
    await page.locator(".page-header .page-primary").click();
    const dialog = page.getByRole("dialog", { name: /New Session/ });
    const input = dialog.getByRole("combobox", { name: "Project" });
    await dialogMotionSettled(page);
    await input.click();
    const list = dialog.getByRole("listbox", { name: "Project Options" });
    await expect(list).toBeVisible();
    const placed = await anchoredTo(input, list);
    expect(Math.abs(placed.left - (await rectOf(input)).left)).toBeLessThanOrEqual(1);
    await evidence(page, `combobox-list-contained-${tag}`);
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(input).toBeFocused();
  });

  test(`the Snooze suggestions stay on their field in a contained main column, ${variant}`, async ({ page }) => {
    await openShell(page, "/inbox", "Sessions", banner);
    await forceFloorEngine(page);
    await page.locator(".inbox-row-shell").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Snooze…", exact: true }).click();
    const expression = page.getByRole("combobox", { name: "Natural Language" });
    await dialogMotionSettled(page);
    await expression.fill("fri");
    const list = page.getByRole("listbox").filter({ has: page.getByRole("option") }).last();
    await expect(list.getByRole("option").first()).toBeVisible();
    const placed = await anchoredTo(expression, list);
    expect(Math.abs(placed.left - (await rectOf(expression)).left)).toBeLessThanOrEqual(1);
    await evidence(page, `snooze-suggestions-contained-${tag}`);
  });

  test(`the F6 zone line sits on the page's top edge in a contained main column, ${variant}`, async ({ page }) => {
    await openShell(page, "/settings", "Settings", banner);
    await forceFloorEngine(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // The rail, then the page.
    await page.keyboard.press("F6");
    await page.keyboard.press("F6");
    const root = page.locator(".main-body.zone-lit");
    await expect(root).toHaveCount(1);
    const line = await root.evaluate((element) => {
      // The line's box counts from `.main`'s padding box here; add it back to get viewport position.
      const main = document.querySelector(".main")!.getBoundingClientRect();
      const style = getComputedStyle(element, "::after");
      const edge = element.getBoundingClientRect();
      return {
        top: main.top + Number.parseFloat(style.top),
        left: main.left + Number.parseFloat(style.left),
        width: Number.parseFloat(style.width),
        edge: { top: edge.top, left: edge.left, width: edge.width },
      };
    });
    expect(Math.abs(line.top - line.edge.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(line.left - line.edge.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(line.width - line.edge.width)).toBeLessThanOrEqual(1);
  });
}

for (const banner of [false, true]) {
  const variant = banner ? "with the page banner" : "without a page banner";

  test(`the composer bar's usage popovers stay on their triggers in a contained main column, ${variant}`, async ({ page }) => {
    await page.goto(`/session-usage-e2e.html?width=1100&height=780&shell=1${banner ? "&banner=1" : ""}&composer=orchestrator`);
    if (banner) await expect(page.locator(".main > .notice.page-banner")).toBeVisible();
    const menu = page.locator('.menu[aria-label="Attach and Settings"]');
    const cases = [
      {
        name: "context window",
        open: async () => page.locator(".context-control > button").first().click(),
        trigger: page.locator(".context-control > button").first(),
        panel: page.locator(".context-popover").first(),
      },
      {
        name: "Session Usage",
        open: async () => page.locator(".session-usage > button").first().click(),
        trigger: page.locator(".session-usage > button").first(),
        panel: page.locator(".session-usage-popover").first(),
      },
    ];
    const opened: Rect[] = [];
    for (const surface of cases) {
      await surface.open();
      await expect(surface.panel).toBeVisible();
      opened.push(await anchoredTo(surface.trigger, surface.panel));
      await surface.trigger.press("Escape");
      await expect(surface.panel).toHaveCount(0);
    }
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    await forceFloorEngine(page);
    for (const [index, surface] of cases.entries()) {
      await surface.open();
      await expect(surface.panel).toBeVisible();
      expectSameRect(await anchoredTo(surface.trigger, surface.panel), opened[index]!, surface.name);
      await surface.trigger.press("Escape");
      await expect(surface.panel).toHaveCount(0);
    }
  });
}

/** Counts the containing-block probes fixed-containing-block.ts inserts, from now on. */
async function countProbes(page: Page) {
  await page.evaluate(() => {
    const counter = window as typeof window & { __probes?: number };
    counter.__probes = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.getAttribute("aria-hidden") === "true"
            && node.style.position === "fixed" && node.style.height === "100%") counter.__probes! += 1;
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  return () => page.evaluate(() => {
    const counter = window as typeof window & { __probes?: number };
    // MutationObserver records are delivered at the next microtask checkpoint.
    return new Promise<number>((resolve) => setTimeout(() => resolve(counter.__probes ?? 0), 0));
  });
}

test("an open list measures its containing block only when it opens or its field moves", async ({ page }) => {
  // Tall enough that the list opens below its field before and after the scroll.
  await page.setViewportSize({ width: 1280, height: 700 });
  await openShell(page, "/settings", "Settings", false);
  await forceFloorEngine(page);
  const trigger = page.getByRole("button", { name: /^Color Scheme:/ });
  const list = page.getByRole("listbox", { name: "Color Scheme" });
  const probes = await countProbes(page);
  await trigger.click();
  await expect(list).toBeVisible();
  expect(await probes(), "one measurement when it opens").toBe(1);
  // Resizes and scrolls that move nothing do not measure again.
  await page.evaluate(() => {
    for (let index = 0; index < 20; index += 1) {
      window.dispatchEvent(new Event("resize"));
      document.dispatchEvent(new Event("scroll"));
    }
  });
  expect(await probes()).toBe(1);
  // Scrolling the page moves the field, so the list is placed, and measured, again.
  const scrolled = await page.locator(".main-body").evaluate((body) => {
    const before = body.scrollTop;
    body.scrollTop += 40;
    return body.scrollTop - before;
  });
  expect(scrolled, "the settings page scrolls at this height").toBeGreaterThan(0);
  await expect.poll(probes).toBeGreaterThan(1);
  await expect(async () => {
    await anchoredTo(trigger, list);
    expect(Math.abs((await rectOf(list)).left - (await rectOf(trigger)).left)).toBeLessThanOrEqual(1);
  }).toPass({ timeout: 2000 });
});

test("the F6 zone line measures its containing block only when its zone moves", async ({ page }) => {
  await openShell(page, "/settings", "Settings", false);
  await forceFloorEngine(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("F6");
  await expect(page.locator(".app-rail.zone-lit, .app-rail .zone-lit, .zone-lit")).toHaveCount(1);
  const probes = await countProbes(page);
  await page.keyboard.press("F6");
  await expect(page.locator(".main-body.zone-lit")).toHaveCount(1);
  // The line is re-read every frame while lit; with nothing moving, it measured once.
  await page.waitForTimeout(400);
  expect(await probes()).toBe(1);
});

test.describe("the `app` container query", () => {
  const listPaneWidth = (page: Page) => page.locator(".project-manager-grid").evaluate((grid) =>
    Number.parseFloat(getComputedStyle(grid).gridTemplateColumns.split(" ")[0]!));

  // 761/834/940/1099 are compact by viewport and by column alike: unchanged by the move to @container.
  for (const width of [761, 834, 940, 1099]) {
    test(`the Projects list pane is 280px at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openShell(page, "/projects", "Projects", false);
      expect(await listPaneWidth(page)).toBe(280);
    });
  }

  for (const labelled of [false, true]) {
    test(`the Projects list pane answers to the main column with the labelled rail ${labelled ? "on" : "off"}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openShell(page, "/projects", "Projects", false);
      if (labelled) {
        await page.getByRole("navigation", { name: "Primary Navigation" })
          .getByRole("button", { name: "Expand Navigation", exact: true }).click();
        await expect(page.locator(".app-rail.labelled")).toBeVisible();
      }
      const rail = await page.locator(".app-rail").evaluate((element) => element.getBoundingClientRect().width);
      expect(await listPaneWidth(page)).toBe(310);
      // From 1100px to 1100px plus the rail, the viewport is desktop but the column is compact.
      for (const width of [1100, 1100 + Math.ceil(rail) - 1]) {
        await page.setViewportSize({ width, height: 900 });
        await expect.poll(() => page.locator(".main").evaluate((main) => main.getBoundingClientRect().width))
          .toBeLessThan(1100);
        await expect.poll(() => listPaneWidth(page), `280px at ${width}px`).toBe(280);
      }
      await evidence(page, `projects-list-pane-${labelled ? "labelled" : "icon"}-rail-${1100 + Math.ceil(rail) - 1}`);
      await page.setViewportSize({ width: 1100 + Math.ceil(rail), height: 900 });
      await expect.poll(() => listPaneWidth(page), "310px once the column reaches 1100px").toBe(310);
    });
  }

  test("a phone has no `app` container", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(shell("/settings", false));
    await expect(page.locator(".main")).toBeVisible();
    expect(await page.locator(".main").evaluate((main) => getComputedStyle(main).containerType)).toBe("normal");
  });
});
