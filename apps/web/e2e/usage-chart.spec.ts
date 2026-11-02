import { expect, test, type Page } from "@playwright/test";

/**
 * The usage chart's time axis, Not Recorded band, readout and touch selection (#3012), drawn by the
 * real stylesheet and fonts. The DOM tests cover the same states without layout; these measure it.
 */

test.use({ reducedMotion: "reduce" });

type Granularity = "Hour" | "Day" | "Week";

/** Group By is a radio group on a wide toolbar and a section of the Range sheet on a phone. */
async function groupBy(page: Page, granularity: Granularity) {
  const group = page.getByRole("radiogroup", { name: "Group By" });
  if (await group.isVisible()) {
    await group.getByRole("radio", { name: granularity }).click();
  } else {
    await page.locator(".usage-toolbar").getByRole("button", { name: /^Range and Group By: / }).click();
    await page.getByRole("menu", { name: "Range and Group By" }).getByRole("menuitemradio", { name: granularity }).click();
    await page.keyboard.press("Escape");
  }
  const title = { Hour: "Hourly", Day: "Daily", Week: "Weekly" }[granularity];
  await expect(page.locator(".usage-chart-svg title")).toContainText(title);
}

/** Every axis label's box, left to right, and the chart's own box. */
async function axisBoxes(page: Page) {
  return page.locator(".usage-chart-svg").evaluate((svg) => ({
    chart: svg.getBoundingClientRect().toJSON() as DOMRect,
    labels: [...svg.querySelectorAll(".usage-chart-axis")]
      .map((label) => ({ text: label.textContent ?? "", box: label.getBoundingClientRect().toJSON() as DOMRect }))
      .sort((a, b) => a.box.left - b.box.left),
  }));
}

for (const [width, granularity] of [[390, "Hour"], [390, "Day"], [834, "Day"], [834, "Week"], [1440, "Hour"], [1440, "Week"]] as const) {
  test(`at ${width}px the ${granularity.toLowerCase()} axis labels never collide or leave the chart`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/usage-view-e2e.html");
    await expect(page.locator(".usage-chart-hit").first()).toBeAttached();
    if (granularity !== "Day") await groupBy(page, granularity);
    const { chart, labels } = await axisBoxes(page);
    expect(labels.length).toBeGreaterThanOrEqual(2);
    for (const { text, box } of labels) {
      expect(box.left, `${text} starts inside the chart`).toBeGreaterThanOrEqual(chart.left - 0.5);
      expect(box.right, `${text} ends inside the chart`).toBeLessThanOrEqual(chart.right + 0.5);
    }
    // Spacing is estimated, not measured, so it holds for CI's wider DejaVu face too; any two
    // neighbours keep a visible gap rather than reading as one run ("Sep 2Sep 3").
    for (let index = 1; index < labels.length; index += 1) {
      const [left, right] = [labels[index - 1]!, labels[index]!];
      expect(right.box.left - left.box.right, `${left.text} and ${right.text} keep apart`).toBeGreaterThanOrEqual(4);
    }
  });
}

test("recording that started ten days ago leaves one Not Recorded band that the keyboard skips", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/usage-view-e2e.html?coverageDays=10");
  const band = page.locator(".usage-chart-unrecorded");
  await expect(band).toHaveCount(1);
  await expect(band).toHaveText("Not Recorded");
  await expect(page.locator(".usage-chart-column")).toHaveCount(30);
  const hits = page.locator(".usage-chart-hit");
  await expect(hits).toHaveCount(10);
  // The band fills its share of the plot: two thirds of the columns.
  const bandBox = (await band.locator("rect").boundingBox())!;
  const firstHit = (await hits.first().boundingBox())!;
  expect(Math.abs(bandBox.x + bandBox.width - firstHit.x)).toBeLessThan(1);
  expect(bandBox.width / (bandBox.width + 10 * firstHit.width)).toBeCloseTo(2 / 3, 2);

  await page.keyboard.press("Tab");
  for (let presses = 0; presses < 40 && !(await hits.first().evaluate((hit) => hit === document.activeElement)); presses += 1) {
    await page.keyboard.press("Tab");
  }
  await expect(hits.first()).toBeFocused();
  const readout = page.locator(".usage-chart-readout");
  await expect(readout).toContainText("Aug 25, 2026");
  await page.keyboard.press("ArrowLeft");
  await expect(hits.first()).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(hits.nth(1)).toBeFocused();
  await expect(readout).toContainText("Aug 26, 2026");
  await page.keyboard.press("End");
  await expect(hits.last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(hits.last()).not.toBeFocused();
  await expect(readout).toContainText(/^Daily average \$[\d.]+ · Peak \$[\d.]+ on (Aug|Sep) \d+$/);
});

test("hovering a column replaces the resting line and recedes the others", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/usage-view-e2e.html?sparse=1");
  const readout = page.locator(".usage-chart-readout");
  await expect(readout).toHaveText(/^Daily average \$[\d.]+ · Peak \$[\d.]+ on (Aug|Sep) \d+$/);
  const resting = await readout.boundingBox();
  await page.locator(".usage-chart-hit").nth(17).hover();
  await expect(readout).toContainText("Aug 22, 2026");
  await expect(readout).toContainText("Claude Code");
  await expect(page.locator(".usage-chart-svg")).toHaveClass(/has-active/);
  const other = page.locator(".usage-chart-column").nth(4).locator(".usage-chart-segment").first();
  await expect.poll(() => other.evaluate((segment) => Number(getComputedStyle(segment).fillOpacity))).toBeCloseTo(0.45, 2);
  const axis = await page.locator(".usage-chart-axis").first().evaluate((label) => getComputedStyle(label).opacity);
  expect(axis, "the axis labels stay at full strength").toBe("1");
  await page.mouse.move(5, 5);
  await expect(readout).toContainText("Daily average");
  expect((await readout.boundingBox())!.y, "the readout line holds its place").toBe(resting!.y);
});

test("one ACP agent names the series in the driver list, readout and table", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  // The fixture's fleet advertises one ACP agent, Gemini CLI, which owns all the ACP usage.
  await page.goto("/usage-view-e2e.html");
  const names = page.getByRole("list", { name: "By Driver" }).locator(".usage-driver-name");
  await expect(names).toHaveText(["Claude Code", "Codex", "Gemini CLI"]);
  await page.locator(".usage-chart-hit").nth(17).hover();
  await expect(page.locator(".usage-chart-readout")).toContainText("Gemini CLI");
  await expect(page.locator(".usage-tables-section thead")).toContainText("Gemini CLI");
  await expect(page.locator(".usage-overview")).not.toContainText(/\bACP\b|Other Agents/);
  // With no fleet to name it, the series never claims an agent, and still never says ACP.
  await page.goto("/usage-view-e2e.html?anonymous=1");
  await expect(names).toHaveText(["Claude Code", "Codex", "Other Agents"]);
});

test.describe("under forced colors", () => {
  test.use({ forcedColors: "active" });

  test("the legend's swatches keep the series colours the bars keep", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/usage-view-e2e.html");
    const fills = (selector: string) => page.locator(selector).evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).fill));
    await expect(page.locator('[aria-label="By Driver"] .usage-series-swatch rect')).toHaveCount(3);
    const swatches = await fills('[aria-label="By Driver"] .usage-series-swatch rect');
    expect(swatches).toHaveLength(3);
    expect(new Set(swatches).size, "each driver's swatch is its own colour").toBe(3);
    // Each swatch matches the bars of its driver, which forced colors leaves alone.
    for (const [index, slot] of ["usage-series-2", "usage-series-1", "usage-series-4"].entries()) {
      const bar = (await fills(`.usage-chart-segment.${slot}`))[0];
      expect(swatches[index], `${slot} swatch`).toBe(bar);
    }
    const ground = await page.locator(".usage-overview").evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(swatches).not.toContain(ground);
  });
});

test.describe("with a touch pointer", () => {
  test.use({ hasTouch: true });

  test("a tap selects a column, a second tap or a tap outside clears it", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/usage-view-e2e.html?sparse=1");
    const readout = page.locator(".usage-chart-readout");
    await expect(readout).toContainText("Daily average");
    const column = page.locator(".usage-chart-hit").nth(17);
    await column.scrollIntoViewIfNeeded();
    await column.tap();
    await expect(readout).toContainText("Aug 22, 2026");
    await column.tap();
    await expect(readout).toContainText("Daily average");
    await column.tap();
    await expect(readout).toContainText("Aug 22, 2026");
    await page.locator(".usage-headline-value").tap();
    await expect(readout).toContainText("Daily average");
  });
});
