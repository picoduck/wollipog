import { expect, test, type Page } from "@playwright/test";

/**
 * The #1803 foundation measured in a browser: tabs (§10.1), the dense row (§5.2), the table's
 * narrow fallback (§14) and the neutral flag badge (§11.3). Sizes come from tokens that the
 * coarse-pointer block resizes, so each is read with a mouse and again on touch.
 */
const shell = (path: string) => `/command-inbox-projects-e2e.html?fullShell=1&path=${encodeURIComponent(path)}`;

async function heights(page: Page, selector: string): Promise<number[]> {
  await expect(page.locator(selector).first()).toBeVisible();
  return page.locator(selector).evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
}

async function coarse(page: Page): Promise<boolean> {
  return page.evaluate(() => matchMedia("(pointer: coarse)").matches);
}

for (const pointer of ["fine", "coarse"] as const) {
  test.describe(`with a ${pointer} pointer`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, hasTouch: pointer === "coarse" });
    const tab = pointer === "fine" ? 40 : 48;
    const dense = pointer === "fine" ? 32 : 44;

    test(`the Sessions and Connections tabs are ${tab}px, underlined rather than filled`, async ({ page }) => {
      await page.goto(shell("/inbox"));
      expect(await coarse(page)).toBe(pointer === "coarse");
      for (const height of await heights(page, ".inbox-tabs .tab")) expect(height).toBe(tab);

      await page.goto(shell("/connections"));
      const tabs = page.getByRole("tablist", { name: "Connection Settings" }).getByRole("tab");
      await expect(tabs.first()).toBeVisible();
      for (const height of await tabs.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))) {
        expect(height).toBe(tab);
      }
      const selected = page.getByRole("tablist", { name: "Connection Settings" }).locator('[role="tab"][aria-selected="true"]');
      await expect(selected).toHaveCount(1);
      const look = await selected.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        underline: getComputedStyle(element, "::after").height,
        transform: getComputedStyle(element).textTransform,
      }));
      expect(look).toEqual({ background: "rgba(0, 0, 0, 0)", underline: "2px", transform: "none" });
    });

    test(`Files entries and Review changed files are ${dense}px dense rows`, async ({ page }) => {
      await page.goto("/files-panel-e2e.html");
      const files = await heights(page, ".files-list .row");
      expect(files.length).toBe(7);
      for (const height of files) expect(height).toBe(dense);

      await page.goto("/review-anchor-reload-e2e.html");
      const changed = await heights(page, ".git-files .row");
      expect(changed.length).toBe(2);
      for (const height of changed) expect(height).toBe(dense);
    });
  });
}

test("a required finding shows a neutral Required badge beside its severity", async ({ page }) => {
  await page.goto("/review-anchor-reload-e2e.html");
  const badge = page.locator(".status", { hasText: /^Required$/ }).first();
  await expect(badge).toBeVisible();
  expect(await badge.evaluate((element) => ({
    neutral: element.classList.contains("t-neutral"),
    noDot: element.classList.contains("no-dot"),
    transform: getComputedStyle(element).textTransform,
    dot: getComputedStyle(element, "::before").content,
  }))).toEqual({ neutral: true, noDot: true, transform: "none", dot: "none" });
});

test.describe("at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("an Archive row's inline action and ⋯ are separate 44px touch targets", async ({ page }) => {
    await page.goto(shell("/archived"));
    const actions = page.locator(".archive-row-actions").first();
    await expect(actions).toBeVisible();
    const hits = await actions.evaluate((element) => {
      const [inline, more] = [...element.querySelectorAll<HTMLElement>("button")];
      const a = inline!.getBoundingClientRect();
      const b = more!.getBoundingClientRect();
      const y = a.top + a.height / 2;
      const at = (x: number, yy: number) => document.elementFromPoint(x, yy);
      return {
        gap: b.left - a.right,
        // 3px past each visible edge, inside its own borrowed area and not the neighbour's.
        inlineRight: inline!.contains(at(a.right + 3, y)),
        moreLeft: more!.contains(at(b.left - 3, y)),
        // The borrowed area above and below is not clipped by the actions container.
        inlineAbove: inline!.contains(at(a.left + a.width / 2, a.top - 3)),
        moreBelow: more!.contains(at(b.left + b.width / 2, b.bottom + 3)),
      };
    });
    expect(hits.gap, "neighbours sit at least 8px apart (§2.8)").toBeGreaterThanOrEqual(8);
    expect(hits).toMatchObject({ inlineRight: true, moreLeft: true, inlineAbove: true, moreBelow: true });
  });

  test("a long trailing value gives way to the row's title", async ({ page }) => {
    await page.goto("/colour-schemes-e2e.html");
    const row = page.locator(".surface > .row.row-2");
    await expect(row).toBeVisible();
    const widths = await row.evaluate((element) => ({
      row: element.getBoundingClientRect().width,
      title: element.querySelector(".row-title")!.getBoundingClientRect().width,
      trail: element.querySelector(".row-trail")!.getBoundingClientRect().width,
    }));
    expect(widths.trail, "the trailing slot is at most half the row").toBeLessThanOrEqual(widths.row / 2);
    expect(widths.title, "the title keeps its room").toBeGreaterThan(widths.row * 0.4);
  });

  // The Archive in the real shell; the Usage breakdowns in their own fixture, which serves usage.
  for (const [url, title] of [[shell("/archived"), "Archived Sessions"], ["/usage-view-e2e.html", "Usage & Cost"]] as const) {
    test(`${title} tables become two-line rows without sideways scroll`, async ({ page }) => {
      await page.goto(url);
      const row = page.locator(".table tbody tr").first();
      await expect(row).toBeVisible();
      const layout = await page.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>(".table tbody tr")]
          .filter((element) => element.getBoundingClientRect().height > 0 && element.children.length > 1);
        // Lines, not tops: cells on one line are centred on it, so a button and a line of meta text
        // share a line while starting at different heights. A cell whose centre sits below every
        // earlier cell's box starts a new line.
        const lines = rows.map((element) => {
          const boxes = [...element.children]
            .filter((cell) => getComputedStyle(cell).display !== "none" && cell.getBoundingClientRect().height > 0)
            .map((cell) => cell.getBoundingClientRect())
            .sort((a, b) => a.top - b.top);
          let count = 0;
          let bottom = -Infinity;
          for (const box of boxes) {
            if (box.top + box.height / 2 > bottom) count += 1;
            bottom = Math.max(bottom, box.bottom);
          }
          return count;
        });
        const head = document.querySelector(".table thead")!.getBoundingClientRect();
        const widest = Math.max(...[...document.querySelectorAll<HTMLElement>(".table-wrap")]
          .map((wrap) => wrap.scrollWidth - wrap.clientWidth));
        return {
          rows: rows.length,
          lines: [...new Set(lines)],
          headHidden: head.width <= 1 && head.height <= 1,
          pageScroll: document.scrollingElement!.scrollWidth - innerWidth,
          tableScroll: widest,
        };
      });
      expect(layout.rows).toBeGreaterThan(0);
      expect(layout.lines).toEqual([2]);
      expect(layout.headHidden).toBe(true);
      expect(layout.pageScroll).toBeLessThanOrEqual(0);
      expect(layout.tableScroll).toBeLessThanOrEqual(0);
    });
  }
});
