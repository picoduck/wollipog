import { expect, test, type Page } from "@playwright/test";

/**
 * Review's layout in a real browser (#2846): the toolbar stays one row at the panel's narrowest,
 * the scroller is the only vertical scroller, and a branch with only committed work opens on
 * Branch. The DOM tests cover the rest of the behaviour; this covers what only layout can show.
 */

async function openReview(page: Page, query: string) {
  await page.goto(`/review-layout-e2e.html?${query}`);
  await expect(page.locator(".rpanel[data-mode='review'] .rpanel-scroll")).toBeVisible();
  await expect(page.locator(".review-summary")).toBeVisible();
}

/** The toolbar row's geometry: every control on one line, inside the row, and nothing clipped. */
async function toolbarGeometry(page: Page) {
  return page.locator(".rpanel-toolbar > .toolbar").evaluate((row) => {
    const box = row.getBoundingClientRect();
    const controls = [...row.children].map((child) => child.getBoundingClientRect());
    return {
      rowHeight: box.height,
      tops: controls.map((control) => Math.round(control.top)),
      overflow: row.scrollWidth - row.clientWidth,
      rightmost: Math.max(...controls.map((control) => control.right)) - box.right,
    };
  });
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} Review layout`, () => {
    test("the toolbar is one row with Scope and View Options at a 320px panel", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openReview(page, `theme=${theme}&width=320`);
      expect(await page.locator(".rpanel").evaluate((panel) => panel.getBoundingClientRect().width)).toBe(320);
      const row = page.locator(".rpanel-toolbar > .toolbar");
      await expect(row.getByRole("radiogroup", { name: "Scope" })).toBeVisible();
      await expect(row.getByRole("button", { name: "View Options" })).toBeVisible();
      const geometry = await toolbarGeometry(page);
      expect(new Set(geometry.tops).size, "every control starts on the same line").toBe(1);
      expect(geometry.overflow, "nothing overflows the row").toBeLessThanOrEqual(0);
      expect(geometry.rightmost, "View Options ends inside the row").toBeLessThanOrEqual(0);
    });

    test("the toolbar is one row on a 390px phone", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openReview(page, `theme=${theme}`);
      const geometry = await toolbarGeometry(page);
      expect(new Set(geometry.tops).size).toBe(1);
      expect(geometry.overflow).toBeLessThanOrEqual(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`the scroller is the only vertical scroller in Review at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openReview(page, "scenario=pr");
    const report = await page.locator(".rpanel").evaluate((panel) => {
      const scroller = panel.querySelector(".rpanel-scroll")!;
      const scrolls = (element: Element) => {
        const overflowY = getComputedStyle(element).overflowY;
        return (overflowY === "auto" || overflowY === "scroll") && element.scrollHeight > element.clientHeight + 1;
      };
      const nested = [...scroller.querySelectorAll("*")]
        .filter(scrolls)
        .map((element) => element.className || element.tagName);
      const body = panel.querySelector(".rpanel-body")!;
      return {
        nested,
        bodyOverflow: getComputedStyle(body).overflowY,
        scrollerScrolls: scroller.scrollHeight > scroller.clientHeight,
        scrollerOverflow: getComputedStyle(scroller).overflowY,
      };
    });
    expect(report.nested, "no element inside the scroller scrolls vertically on its own").toEqual([]);
    expect(report.bodyOverflow, "the body hands its scroll to the scroller").toBe("hidden");
    expect(report.scrollerOverflow).toBe("auto");
    expect(report.scrollerScrolls, "the fixture is long enough to scroll").toBe(true);

    // The toolbar stays put while the body scrolls.
    const toolbarTop = await page.locator(".rpanel-toolbar").evaluate((toolbar) => toolbar.getBoundingClientRect().top);
    await page.locator(".rpanel-scroll").evaluate((scroller) => { scroller.scrollTop = scroller.scrollHeight; });
    expect(await page.locator(".rpanel-toolbar").evaluate((toolbar) => toolbar.getBoundingClientRect().top)).toBe(toolbarTop);
  });
}

test("a branch with only committed work opens on Branch and reads only the Branch diff", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReview(page, "scenario=branch");
  await expect(page.getByRole("radio", { name: "Branch" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".diff-file").first()).toBeVisible();
  expect(await page.evaluate(() => window.__REVIEW_LAYOUT_E2E__.reads().filter((read) => read.startsWith("diff:"))))
    .toEqual(["diff:all_branch"]);
});

test("the header Refresh reloads status, diff and findings together", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReview(page, "scenario=uncommitted");
  await expect(page.locator(".diff-file").first()).toBeVisible();
  const before = await page.evaluate(() => window.__REVIEW_LAYOUT_E2E__.reads());
  await page.locator(".rpanel-head").getByRole("button", { name: "Refresh Review" }).click();
  await expect.poll(async () => (await page.evaluate(() => window.__REVIEW_LAYOUT_E2E__.reads())).length).toBe(before.length + 3);
  const added = (await page.evaluate(() => window.__REVIEW_LAYOUT_E2E__.reads())).slice(before.length).sort();
  expect(added).toEqual(["diff:uncommitted", "findings", "status"]);
});
