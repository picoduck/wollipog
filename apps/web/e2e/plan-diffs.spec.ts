import { expect, test, type Page } from "@playwright/test";

/** Two turns through the timeline builder (#2187): a plan revised three times and two file edits,
 * then a later turn that revises the plan once more. */
async function openFixture(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/plan-diffs-e2e.html");
  for (const trigger of await page.locator(".tl-work > .disclosure-trigger").all()) await trigger.click();
  await expect(page.locator(".tl-plan")).toHaveCount(2);
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect.poll(() => page.getByTestId("reader").evaluate((reader) => reader.scrollWidth <= reader.clientWidth + 1)).toBe(true);
}

for (const width of [1440, 390]) {
  test(`each turn's plan is one card and its labels share one x at ${width}px`, async ({ page }) => {
    await openFixture(page, width);
    const [first, second] = [page.locator(".tl-plan").first(), page.locator(".tl-plan").nth(1)];
    await expect(first.locator(".tl-plan-head")).toHaveText("Plan2 of 3 Done");
    await expect(second.locator(".tl-plan-head")).toHaveText("Plan3 of 4 Done");
    const starts = await first.locator(".tl-plan-text").evaluateAll((labels) => labels.map((label) => Math.round(label.getBoundingClientRect().left)));
    expect(new Set(starts).size).toBe(1);
    await first.getByRole("button", { name: /Show Earlier Versions/ }).click();
    await expect(first.locator(".tl-plan-version")).toHaveCount(2);
    await expectNoHorizontalOverflow(page);
  });

  test(`a file edit's diff shows numbered lines, collapses after 8 and opens in Review at ${width}px`, async ({ page }) => {
    await openFixture(page, width);
    const created = page.locator("details.tl-step").filter({ hasText: "release-notes.ts" });
    await created.locator("summary").click();
    await expect(created.locator(".tl-diff-line")).toHaveCount(8);
    await expect(created.locator(".tl-diff")).not.toContainText("new file mode");
    await created.getByRole("button", { name: "Show 4 More Lines" }).click();
    await expect(created.locator(".tl-diff-line")).toHaveCount(12);
    await created.getByRole("button", { name: "Open in Review" }).click();
    await expect(page.getByTestId("opened-location")).toHaveText("Review: apps/web/src/release-notes.ts");
    await expectNoHorizontalOverflow(page);
  });
}
