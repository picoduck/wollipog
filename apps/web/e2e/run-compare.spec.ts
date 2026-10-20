import { expect, test, type Page } from "@playwright/test";

/**
 * A comparison run's page (#2975; docs/design-system.md §4.3, §12.5, §15.1, §15.2), measured in a
 * real browser: flush member columns that fill the page's height with one-line heads at 1440px and
 * four agents, two columns at a time with a right-edge fade in the compact tier, and one member at a
 * time under member tabs on a phone, with the chosen member kept in the URL across a reload.
 */

async function open(page: Page, run: string, query = "") {
  await page.goto(`/run-compare-e2e.html?run=${run}${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "Index session search across machines" })).toBeVisible();
  // Every column has loaded what it did.
  await expect(page.locator(".compare-member-meta:empty")).toHaveCount(0);
}

test.describe("at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("four agents: flush columns fill the page's height, at least 320px each, with one-line heads", async ({ page }) => {
    await open(page, "four");
    await expect(page.locator(".compare-grid")).toHaveCount(0);
    await expect(page.locator('[style*="grid-template-columns"]')).toHaveCount(0);
    const geometry = await page.locator(".compare").evaluate((row) => {
      const columns = [...row.querySelectorAll<HTMLElement>(":scope > .compare-member")];
      return {
        rowBottom: row.getBoundingClientRect().bottom,
        scrolls: row.scrollWidth > row.clientWidth,
        columns: columns.map((column) => {
          const head = column.querySelector<HTMLElement>(".compare-member-head")!;
          const agent = head.querySelector<HTMLElement>(".compare-member-agent")!;
          const tops = [...head.children].map((child) => {
            const rect = child.getBoundingClientRect();
            return rect.top + rect.height / 2;
          });
          return {
            width: column.getBoundingClientRect().width,
            bottom: column.getBoundingClientRect().bottom,
            headHeight: head.getBoundingClientRect().height,
            centres: tops,
            agentTruncated: agent.scrollWidth > agent.clientWidth,
            border: getComputedStyle(column).borderLeftWidth,
          };
        }),
      };
    });
    expect(geometry.rowBottom, "the row reaches the bottom of the page").toBeGreaterThanOrEqual(899);
    expect(geometry.scrolls, "four columns fit at 1440px").toBe(false);
    expect(geometry.columns).toHaveLength(4);
    geometry.columns.forEach((column, index) => {
      expect(column.width).toBeGreaterThanOrEqual(320);
      expect(column.bottom).toBeGreaterThanOrEqual(899);
      // One line: every item of the head shares one centre line, and the head is one control tall.
      expect(Math.max(...column.centres) - Math.min(...column.centres)).toBeLessThanOrEqual(2);
      expect(column.headHeight).toBeLessThanOrEqual(40);
      expect(column.agentTruncated).toBe(false);
      expect(column.border, "hairlines between columns, no boxes").toBe(index === 0 ? "0px" : "1px");
    });
    await expect(page.locator(".compare-member").nth(0).locator(".compare-member-meta")).toHaveText("2 commands, 1 edit, 2 files read");
  });

  test("a running member says Working…, and the run reads Running", async ({ page }) => {
    await open(page, "running");
    await expect(page.locator(".detail-bar .status")).toHaveText("Running");
    await expect(page.locator(".compare-member").nth(1).locator(".compare-member-meta")).toHaveText("Working…");
  });
});

test.describe("at 834×1112 (compact)", () => {
  test.use({ viewport: { width: 834, height: 1112 } });

  test("three agents show two at a time and the row fades its right edge while more lie beyond", async ({ page }) => {
    await open(page, "three");
    const row = page.locator(".compare");
    const geometry = await row.evaluate((element) => ({
      rowWidth: element.clientWidth,
      columnWidths: [...element.querySelectorAll<HTMLElement>(":scope > .compare-member")].map((column) => column.getBoundingClientRect().width),
    }));
    for (const width of geometry.columnWidths) {
      expect(width).toBeGreaterThanOrEqual(320);
      expect(Math.abs(width - geometry.rowWidth / 2)).toBeLessThanOrEqual(1);
    }
    await expect(row).toHaveAttribute("data-clip-end", "");
    await row.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await expect(row).not.toHaveAttribute("data-clip-end", "");
  });
});

test.describe("at 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("one member at a time under member tabs; a tab updates ?member= and a reload keeps it", async ({ page }) => {
    await open(page, "three");
    const tabs = page.getByRole("tablist", { name: "Agents" }).getByRole("tab");
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".compare-member")).toHaveCount(1);
    await expect(page.locator(".compare")).toHaveCount(0);

    await tabs.nth(2).click();
    await expect(page).toHaveURL(/[?&]member=s-opencode(&|$)/u);
    await expect(page.getByRole("tabpanel").locator(".compare-member-agent")).toHaveText("OpenCode");

    await page.reload();
    await expect(page.getByRole("tablist", { name: "Agents" }).getByRole("tab").nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel").locator(".compare-member-agent")).toHaveText("OpenCode");

    // The member bar's ⋯ reaches every member action.
    await page.getByRole("button", { name: "OpenCode Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Open Session" })).toBeVisible();
  });

  test("a transcript table scrolls sideways rather than wrapping its headers", async ({ page }) => {
    await open(page, "three");
    const table = page.getByRole("tabpanel").locator(".md-table-wrap").first();
    await table.scrollIntoViewIfNeeded();
    const headers = await table.locator("th").evaluateAll((cells) => cells.map((cell) => ({
      text: cell.textContent ?? "",
      height: cell.getBoundingClientRect().height,
    })));
    const single = Math.min(...headers.map((header) => header.height));
    for (const header of headers) expect(header.height, `${header.text} stays on one line`).toBeLessThanOrEqual(single + 1);
  });
});
