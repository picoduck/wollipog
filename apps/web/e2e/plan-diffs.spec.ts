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
    // The directory gives way before the file name, which stays whole.
    const name = created.locator(".tl-step-head .tl-path-name");
    await expect(name).toHaveText("release-notes.ts");
    await expect.poll(() => name.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await created.locator("summary").click();
    await expect(created.locator(".tl-diff-line")).toHaveCount(8);
    await expect(created.locator(".tl-diff")).not.toContainText("new file mode");
    await created.getByRole("button", { name: "Show 4 More Lines" }).click();
    await expect(created.locator(".tl-diff-line")).toHaveCount(12);
    await created.getByRole("button", { name: "Open in Review" }).click();
    await expect(page.getByTestId("opened-location")).toHaveText("Review: apps/web/src/release-notes.ts");
    await expectNoHorizontalOverflow(page);
  });

  test(`read, delete and move steps keep their file name whole, and a command keeps its trailing ellipsis at ${width}px (#2523)`, async ({ page }) => {
    await openFixture(page, width);
    const clipped = (element: import("@playwright/test").Locator) => element.evaluate((node) => node.scrollWidth > node.clientWidth);
    for (const [verb, path, name] of [
      ["Read", "apps/web/src/components/Header.tsx", "Header.tsx"],
      ["Delete", "apps/web/src/components/legacy/ReleaseBanner.tsx", "ReleaseBanner.tsx"],
      ["Move", "apps/web/src/version.ts → apps/web/src/release/version.ts", "version.ts"],
    ] as const) {
      const row = page.locator(".tl-step-head").filter({ has: page.locator(".tl-step-verb", { hasText: new RegExp(`^${verb}$`) }) });
      const label = row.locator(".tl-step-object > .tl-path");
      await expect(label).toHaveAttribute("title", path);
      await expect(row.locator(".tl-step-title")).toHaveText(`${verb} ${path}`);
      await expect(label.locator(".tl-path-name")).toHaveText(name);
      await expect.poll(() => clipped(label.locator(".tl-path-name")), `${verb}'s file name is not clipped`).toBe(false);
      // A phone row shortens the directory first; a desktop row has room for the whole path.
      await expect.poll(() => clipped(label.locator(".tl-path-dir"))).toBe(width === 390);
    }
    const command = page.locator(".tl-step-head").filter({ has: page.locator(".tl-step-verb", { hasText: /^Run$/ }) }).locator(".tl-step-object");
    await expect(command.locator(".tl-path")).toHaveCount(0);
    await expect(command).toHaveCSS("text-overflow", "ellipsis");
    await expect.poll(() => clipped(command)).toBe(width === 390);
    await expectNoHorizontalOverflow(page);
  });
}
