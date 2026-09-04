import { expect, test } from "@playwright/test";

/**
 * #664: the activity strip is the row's only irreplaceable signal, and it used to be the first
 * thing pushed out of the row. These tests measure geometry rather than reading text, because the
 * regression was invisible to every assertion that only asked whether an element existed — the
 * strip was in the DOM the whole time, clipped past the row's right edge.
 */
const WIDTHS = [390, 1000, 1400] as const;

test.beforeEach(async ({ page }) => {
  await page.goto("/command-inbox-projects-e2e.html?scenario=inbox-row-layout");
  await expect(page.locator(".inbox-row")).toHaveCount(4);
});

for (const width of WIDTHS) {
  test(`every active row shows its whole activity strip at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const strips = await page.locator(".inbox-row").evaluateAll((rows) => rows.map((row) => {
      const strip = row.querySelector<HTMLElement>(".inbox-row-activity")!;
      const stripBox = strip.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      return {
        stripWidth: stripBox.width,
        renderedBars: strip.childElementCount,
        overflowRight: stripBox.right - (rowBox.right - parseFloat(style.paddingRight)),
        overflowLeft: (rowBox.left + parseFloat(style.paddingLeft)) - stripBox.left,
      };
    }));

    expect(strips).toHaveLength(4);
    for (const strip of strips) {
      expect(strip.renderedBars).toBe(30);
      expect(strip.stripWidth).toBeGreaterThan(50);
      expect(strip.overflowRight).toBeLessThanOrEqual(0.5);
      expect(strip.overflowLeft).toBeLessThanOrEqual(0.5);
    }
    // The strip never shrinks, so its width is identical on every row at a given width.
    expect(Math.max(...strips.map((s) => s.stripWidth)) - Math.min(...strips.map((s) => s.stripWidth)))
      .toBeLessThanOrEqual(0.5);
  });

  test(`a long title fades instead of displacing the strip at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const titles = await page.locator(".inbox-row-title").evaluateAll((nodes) => nodes.map((node) => ({
      text: node.textContent ?? "",
      clipped: node.scrollWidth > node.clientWidth + 1,
      mask: getComputedStyle(node).maskImage || getComputedStyle(node).webkitMaskImage,
      overflowX: getComputedStyle(node).overflowX,
      left: node.getBoundingClientRect().left,
    })));

    // The full title stays in the DOM for assistive technology and for the row's accessible name.
    expect(titles[0]!.text).toContain("Always Visible");
    // Fade, not ellipsis: a mask is applied and `text-overflow` is never asked to draw a glyph.
    for (const title of titles) {
      expect(title.mask).toContain("linear-gradient");
      expect(title.overflowX).toBe("hidden");
    }
    expect(titles.some((title) => title.clipped)).toBe(true);
    // Every title starts on the same reading axis, whatever the row's signals or worktree line.
    expect(Math.max(...titles.map((t) => t.left)) - Math.min(...titles.map((t) => t.left)))
      .toBeLessThanOrEqual(1);
  });
}

test("only sessions with a worktree take a third line, and the list measures both heights", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const rows = await page.locator(".inbox-row").evaluateAll((nodes) => nodes.map((node) => ({
    hasWorktreeLine: node.querySelector(".inbox-row-worktree") !== null,
    height: node.getBoundingClientRect().height,
    top: node.closest(".inbox-row-shell")!.getBoundingClientRect().top,
    bottom: node.closest(".inbox-row-shell")!.getBoundingClientRect().bottom,
  })));

  expect(rows.map((row) => row.hasWorktreeLine)).toEqual([true, true, false, false]);
  const threeLine = rows.filter((row) => row.hasWorktreeLine);
  const twoLine = rows.filter((row) => !row.hasWorktreeLine);
  expect(Math.min(...threeLine.map((row) => row.height)))
    .toBeGreaterThan(Math.max(...twoLine.map((row) => row.height)));
  // The virtualizer positions from measured heights, so mixed rows must not overlap or gap.
  for (let index = 1; index < rows.length; index += 1) {
    expect(rows[index]!.top).toBeGreaterThanOrEqual(rows[index - 1]!.bottom - 0.5);
    expect(rows[index]!.top - rows[index - 1]!.bottom).toBeLessThan(24);
  }
});

test("the worktree line hides a default base ref and keeps a stacked one", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const worktreeLines = page.locator(".inbox-row-worktree");
  await expect(worktreeLines.nth(0)).toContainText("fix/issue-664-restructure-inbox-rows");
  await expect(worktreeLines.nth(0).locator(".inbox-row-base")).toHaveCount(0);
  await expect(worktreeLines.nth(0).locator(".inbox-row-pr-pill")).toHaveText("Open PR");
  await expect(worktreeLines.nth(1).locator(".inbox-row-base")).toContainText("← fix/issue-664-restructure");
  await expect(worktreeLines.nth(1).locator(".inbox-row-pr-pill")).toHaveText("Merged PR");
});

test("a phone drops the base ref from the worktree line but keeps branch and PR state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const stacked = page.locator(".inbox-row-worktree").nth(1);
  await expect(stacked.locator(".inbox-row-branch")).toBeVisible();
  await expect(stacked.locator(".inbox-row-pr-pill")).toBeVisible();
  await expect(stacked.locator(".inbox-row-base")).toBeHidden();
});

test("the message preview no longer renders in Inbox rows", async ({ page }) => {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator(".inbox-row-snippet")).toHaveCount(0);
    await expect(page.locator(".inbox-row").first()).not.toContainText("preview");
  }
});
