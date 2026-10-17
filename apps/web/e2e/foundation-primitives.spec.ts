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
      for (const height of await heights(page, ".tabs-bar .tab")) expect(height).toBe(tab);

      await page.goto(shell("/connections"));
      const tabs = page.getByRole("tablist", { name: "Connections" }).getByRole("tab");
      await expect(tabs.first()).toBeVisible();
      for (const height of await tabs.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))) {
        expect(height).toBe(tab);
      }
      const selected = page.getByRole("tablist", { name: "Connections" }).locator('[role="tab"][aria-selected="true"]');
      await expect(selected).toHaveCount(1);
      const look = await selected.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        underline: getComputedStyle(element, "::after").height,
        transform: getComputedStyle(element).textTransform,
      }));
      expect(look).toEqual({ background: "rgba(0, 0, 0, 0)", underline: "2px", transform: "none" });
    });

    test(`Files entries are ${dense}px dense rows, and Review has no separate file list`, async ({ page }) => {
      await page.goto("/files-panel-e2e.html");
      const files = await heights(page, ".files-list .row");
      expect(files.length).toBe(7);
      for (const height of files) expect(height).toBe(dense);
      // A file's size is trailing meta (§5.2): at the row's end edge, not after its name.
      const offsets = await page.locator(".files-list .row:has(.row-trail)").evaluateAll((rows) => rows.map((row) => {
        const trail = row.querySelector(".row-trail")!.getBoundingClientRect();
        return row.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(row).paddingRight) - trail.right;
      }));
      expect(offsets.length).toBeGreaterThan(0);
      for (const offset of offsets) expect(Math.abs(offset)).toBeLessThan(1);

      // Review's file sections are its list (#2846): the 12-row changed-file list is gone.
      await page.goto("/review-anchor-reload-e2e.html");
      await expect(page.locator(".dfile").first()).toBeVisible();
      await expect(page.locator(".git-files")).toHaveCount(0);
    });
  });
}

test.describe("at 1440px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the Archive State column shows every badge whole", async ({ page }) => {
    await page.goto(shell("/archived"));
    await expect(page.locator(".archive-state-badges .status").first()).toBeVisible();
    const clipped = await page.locator(".archive-state-badges .status").evaluateAll((badges) => badges
      .filter((badge) => {
        const cell = badge.closest("td")!.getBoundingClientRect();
        const box = badge.getBoundingClientRect();
        return badge.scrollWidth > badge.clientWidth + 0.5 || box.right > cell.right + 0.5 || box.left < cell.left - 0.5;
      })
      .map((badge) => badge.textContent));
    expect(clipped, "no badge is cut off by its cell").toEqual([]);
  });
});

// A menu inside a size container opens whole: the assignment rows' Surface is a size container, and
// it may neither become the menu's containing block nor clip it (#1982). On a desktop the menu opens
// against its trigger; on a phone it is the bottom sheet every menu becomes (§9.1).
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`an Invocation menu in the Skills assignment rows opens whole at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/skills-removals-e2e.html?assignment=1");
    await page.getByRole("button", { name: /code-review/i }).first().click();
    const trigger = page.locator(".skill-assignments").getByRole("button", { name: /^Invocation:/ });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    const list = page.getByRole("menu", { name: "Invocation" });
    await expect(list).toBeVisible();
    // A phone's sheet slides in; measure where it comes to rest.
    await page.waitForFunction(() => !document.getAnimations().some((animation) => animation.playState === "running"));
    const geometry = await list.evaluate((element) => {
      const trigger = document.querySelector<HTMLElement>('.skill-assignments [data-rule-control="invocation"]')!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const options = [...element.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      return {
        gap: Math.min(Math.abs(box.top - trigger.bottom), Math.abs(trigger.top - box.bottom)),
        overlapsHorizontally: box.left < trigger.right && box.right > trigger.left,
        inViewport: box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight,
        // Every option is where a pointer can reach it: the topmost element at its centre is it.
        reachable: options.every((option) => {
          const rect = option.getBoundingClientRect();
          return option.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
        }),
        count: options.length,
      };
    });
    expect(geometry.count).toBe(2);
    expect(geometry.inViewport, "the menu is whole").toBe(true);
    if (viewport.width > 760) {
      expect(geometry.gap, "the menu opens against its trigger").toBeLessThanOrEqual(8);
      expect(geometry.overlapsHorizontally).toBe(true);
    }
    expect(geometry.reachable, "no option is clipped or covered").toBe(true);
    await list.getByRole("menuitemradio", { name: "Manual Only" }).click();
    await expect(list).toBeHidden();
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

  test("the Usage breakdown keeps every driver's value on a phone, each named", async ({ page }) => {
    // No detail view holds the per-driver split, so the two-line row shows it on line 2 rather
    // than hiding it with the other extra columns.
    await page.goto("/usage-view-e2e.html");
    const table = page.locator(".usage-breakdown-section table").first();
    await expect(table).toBeVisible();
    const drivers = await table.evaluate((element) => {
      const headers = [...element.querySelectorAll("thead th")].map((th) => th.textContent?.trim() ?? "");
      const cells = [...element.querySelectorAll<HTMLElement>("tbody tr:first-child td[data-driver]")];
      return {
        count: cells.length,
        visible: cells.every((cell) => cell.getBoundingClientRect().height > 0 && getComputedStyle(cell).display !== "none"),
        named: cells.every((cell) => {
          const label = cell.querySelector(".cell-label");
          return !!label && getComputedStyle(label).display !== "none"
            && headers.some((header) => header && label.textContent?.startsWith(header));
        }),
      };
    });
    expect(drivers.count, "the fixture has a per-driver split").toBeGreaterThan(0);
    expect(drivers).toMatchObject({ visible: true, named: true });

    // The headers are off screen here, so every figure on a meta line carries its own name: the
    // period breakdown and Cost by User as the view opens, then the Model breakdown.
    const unnamed = () => page.locator(".usage-table tbody td.cell-meta").evaluateAll((cells) => cells
      .filter((cell) => getComputedStyle(cell).display !== "none" && cell.getBoundingClientRect().height > 0)
      .filter((cell) => {
        const label = cell.querySelector(".cell-label");
        // A word or a 14px icon (§5.2) names it.
          return !label || getComputedStyle(label).display === "none" || !(label.textContent?.trim() || label.querySelector("svg"));
      })
      .map((cell) => `${cell.closest("table")?.querySelector("caption")?.textContent}: ${cell.textContent}`));
    expect(await unnamed(), "no unlabelled figure on a phone").toEqual([]);
    await page.getByRole("radiogroup", { name: "Usage Breakdown" }).getByRole("radio", { name: "Model" }).click();
    await expect(page.locator(".usage-breakdown-section caption")).toHaveText("Usage by Model");
    expect(await unnamed(), "nor in the Model breakdown").toEqual([]);
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
  // Archive rows are exactly two lines. A Usage row keeps every driver's value on its meta line,
  // which may wrap, because no detail view holds the per-driver split.
  for (const [url, title, exact] of [[shell("/archived"), "Archived Sessions", true], ["/usage-view-e2e.html", "Usage and Cost", false]] as const) {
    test(`${title} tables become stacked rows without sideways scroll`, async ({ page }) => {
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
        // Line 1 holds only the row's name and its status or key figure.
        const firstLine = rows.every((element) => {
          const cells = [...element.children].filter((cell) => getComputedStyle(cell).display !== "none"
            && cell.getBoundingClientRect().height > 0);
          const nameBox = cells[0]!.getBoundingClientRect();
          return cells.slice(1).every((cell) => cell.classList.contains("cell-status")
            || cell.getBoundingClientRect().top >= nameBox.bottom - 0.5);
        });
        const head = document.querySelector(".table thead")!.getBoundingClientRect();
        const widest = Math.max(...[...document.querySelectorAll<HTMLElement>(".table-wrap")]
          .map((wrap) => wrap.scrollWidth - wrap.clientWidth));
        return {
          rows: rows.length,
          lines: [...new Set(lines)],
          firstLine,
          headHidden: head.width <= 1 && head.height <= 1,
          pageScroll: document.scrollingElement!.scrollWidth - innerWidth,
          tableScroll: widest,
        };
      });
      expect(layout.rows).toBeGreaterThan(0);
      if (exact) expect(layout.lines).toEqual([2]);
      else expect(Math.min(...layout.lines)).toBeGreaterThanOrEqual(2);
      expect(layout.firstLine, "line 1 is the name and its status or key figure").toBe(true);
      // The headers are off screen, so every figure on the meta line names itself.
      const unnamed = await page.locator(".table tbody td.cell-meta").evaluateAll((cells) => cells
        .filter((cell) => getComputedStyle(cell).display !== "none" && cell.getBoundingClientRect().height > 0)
        .filter((cell) => {
          const label = cell.querySelector(".cell-label");
          // A word or a 14px icon (§5.2) names it.
          return !label || getComputedStyle(label).display === "none" || !(label.textContent?.trim() || label.querySelector("svg"));
        })
        .map((cell) => cell.textContent));
      expect(unnamed, "no unlabelled figure on a phone").toEqual([]);
      // Each meta item, label or icon included, is one line of text.
      const tall = await page.locator(".table tbody td.cell-meta").evaluateAll((cells) => cells
        .filter((cell) => getComputedStyle(cell).display !== "none" && cell.getBoundingClientRect().height > 0)
        .filter((cell) => cell.getBoundingClientRect().height > Number.parseFloat(getComputedStyle(cell).lineHeight) * 1.5)
        .map((cell) => cell.textContent));
      expect(tall, "no meta item wraps onto a second line").toEqual([]);
      expect(layout.headHidden).toBe(true);
      expect(layout.pageScroll).toBeLessThanOrEqual(0);
      expect(layout.tableScroll).toBeLessThanOrEqual(0);
    });
  }
});

// The single-line code well (#2950, §11.7) in the primitives harness: a 400-character secret stays on
// one line and ends in an ellipsis at both widths, with its copy button centered on the value, while
// the wrapping well beside it still wraps the same value.
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const pointer of ["fine", "coarse"] as const) {
    test.describe(`the single-line code well at ${viewport.width}px with a ${pointer} pointer`, () => {
      test.use({ viewport, hasTouch: pointer === "coarse" });

      test("keeps a 400-character value on one line with an ellipsis and Copy centered on it", async ({ page }) => {
        await page.goto("/primitives-e2e.html?view=code-well");
        await expect(page.locator('[data-well="long"] .code-well.one-line')).toBeVisible();
        expect(await coarse(page)).toBe(pointer === "coarse");
        const measure = (well: string) => page.locator(`[data-well="${well}"] .code-well`).evaluate((element) => {
          const code = element.querySelector("code")!;
          const range = document.createRange();
          range.selectNodeContents(code);
          const value = code.getBoundingClientRect();
          const copy = element.querySelector("button")!.getBoundingClientRect();
          return {
            length: code.textContent!.length,
            // Each line of text is its own client rect, so distinct tops count lines.
            lines: new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size,
            clipped: code.scrollWidth > code.clientWidth,
            ellipsis: getComputedStyle(code).textOverflow,
            offCenter: Math.abs((copy.top + copy.bottom) / 2 - (value.top + value.bottom) / 2),
            copyInside: copy.left >= value.right && copy.right <= element.getBoundingClientRect().right,
            copyHeight: copy.height,
          };
        });
        const long = await measure("long");
        expect(long).toMatchObject({ length: 400, lines: 1, clipped: true, ellipsis: "ellipsis", copyInside: true });
        expect(long.offCenter, "the copy button is centered on the value").toBeLessThan(1);
        expect(long.copyHeight).toBe(pointer === "fine" ? 28 : 36);

        const short = await measure("short");
        expect(short).toMatchObject({ lines: 1, clipped: false, copyInside: true });
        expect(short.offCenter).toBeLessThan(1);

        const wrapping = await measure("wrapping");
        expect(wrapping.length).toBe(400);
        expect(wrapping.lines, "the wrapping well still wraps").toBeGreaterThan(1);
        expect(wrapping.clipped).toBe(false);

        expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth), "no sideways scroll")
          .toBeLessThanOrEqual(0);
      });

      if (pointer === "coarse") {
        test("Copy is a 44px target that copies the whole value", async ({ page, context }) => {
          await context.grantPermissions(["clipboard-read", "clipboard-write"]);
          await page.goto("/primitives-e2e.html?view=code-well");
          const copy = page.getByRole("button", { name: "Copy Signing Secret" });
          await expect(copy).toBeVisible();
          const hits = await copy.evaluate((button) => {
            const box = button.getBoundingClientRect();
            const x = box.left + box.width / 2;
            const y = box.top + box.height / 2;
            const at = (px: number, py: number) => button.contains(document.elementFromPoint(px, py));
            // 3.5px past each visible edge is inside the 4px it borrows on every side: 36 + 8 = 44.
            return {
              size: [box.width, box.height],
              above: at(x, box.top - 3.5),
              below: at(x, box.bottom + 3.5),
              left: at(box.left - 3.5, y),
              right: at(box.right + 3.5, y),
            };
          });
          expect(hits).toEqual({ size: [36, 36], above: true, below: true, left: true, right: true });
          // A tap in the borrowed band above the button still copies, and it copies all 400 characters.
          const box = (await copy.boundingBox())!;
          await page.touchscreen.tap(box.x + box.width / 2, box.y - 3);
          await expect(copy).toHaveClass(/copy-status-copied/);
          expect((await page.evaluate(() => navigator.clipboard.readText())).length).toBe(400);
        });
      }
    });
  }
}
