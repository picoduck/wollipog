import { expect, test, type Page } from "@playwright/test";

async function prepare(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/archived-sessions-e2e.html?browse&paged&toolbar");
  await page.getByRole("searchbox").fill("changelog");
  const compact = width < 1100;
  if (compact) await page.getByRole("button", { name: /^Filters/ }).click();
  const scope = compact ? page.getByRole("dialog") : page.locator(".toolbar");
  await scope.getByRole("radio", { name: "All", exact: true }).click();
  await scope.getByRole("button", { name: "Project: All Projects", exact: true }).click();
  await page.getByRole("option", { name: "Wollipog", exact: true }).click();
  if (compact) await scope.getByRole("button", { name: "Done", exact: true }).click();
  await expect.poll(() => page.evaluate(() => history.state?.wollipogArchiveBrowse?.filters.query)).toBe("changelog");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator(".archive-view > .count")).toHaveText("Page 2");
  await page.locator('[data-archive-row="archived-65"]').press("Enter");
  await expect(page.getByRole("heading", { name: "Session Detail" })).toBeVisible();
}

for (const width of [1440, 390]) {
  test(`Back and Forward preserve archive context at ${width}`, async ({ page }) => {
    await prepare(page, width);
    const before = await page.evaluate(() => ({ length: history.length, requests: (window as any).archiveBrowseFixture.requests }));
    await page.goBack();
    await expect(page.locator(".archive-view > .count")).toHaveText("Page 2");
    await expect(page.getByRole("searchbox")).toHaveValue("changelog");
    await expect(page.locator(".chips")).toContainText("Project: Wollipog");
    await expect(page.locator(".chips")).toContainText("Show: All");
    if (width === 1440) await expect(page.locator('[data-archive-row="archived-65"]')).toBeFocused();
    else await expect(page.locator('[data-archive-row="archived-65"]')).not.toBeFocused();
    expect(await page.evaluate(() => history.length)).toBe(before.length);
    expect(await page.evaluate(() => (window as any).archiveBrowseFixture.requests)).toBe(before.requests + 1);
    expect(page.url()).not.toContain("changelog");
    await page.goForward();
    await expect(page.getByRole("heading", { name: "Session Detail" })).toBeVisible();
    await page.goBack();
    await expect(page.locator(".archive-view > .count")).toHaveText("Page 2");
    await page.getByRole("button", { name: "Archived Sessions", exact: true }).click();
    await expect(page.getByRole("searchbox")).toHaveValue("");
    await expect(page.locator(".chips")).toHaveCount(0);
    await page.getByRole("button", { name: "Search Archived Sessions", exact: true }).click();
    await expect(page.getByRole("searchbox")).toHaveValue("release");
  });
}

test("invalid saved cursor falls back without an error and deleted rows stay absent", async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => { (window as any).archiveBrowseFixture.invalid = true; });
  await page.goBack();
  await expect(page.getByText("That page changed. Showing page 1.")).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveValue("changelog");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".archive-view > .count")).toHaveText("Page 1");
  await prepare(page);
  await page.evaluate(() => { (window as any).archiveBrowseFixture.deleted = true; });
  await page.goBack();
  await expect(page.locator(".archive-view > .count")).toHaveText("Page 2");
  await expect(page.locator('[data-archive-row="archived-65"]')).toHaveCount(0);
});
