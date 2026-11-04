import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("populated Usage scrolls within the shell and keeps phone navigation anchored", async ({ page }) => {
  await page.goto("/usage-view-e2e.html?fullShell=1");
  const main = page.locator(".main-body");
  const rail = page.getByRole("navigation", { name: "Primary Navigation" });
  await expect(page.locator(".usage-headline-value")).toContainText("$");
  const table = page.locator(".usage-table");
  await expect(table.locator("tbody tr")).not.toHaveCount(0);

  // Hidden compact table headers must not extend the document beyond the shell (#4142).
  const assertAnchored = async () => {
    await page.evaluate(() => window.scrollTo(0, 350));
    const bounds = await rail.boundingBox();
    expect(bounds).not.toBeNull();
    expect(Math.abs(bounds!.y + bounds!.height - 844)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(844);
  };
  await assertAnchored();

  // Reach both ends through the actual content scroller, including the expanded daily table.
  await main.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const showAll = page.getByRole("button", { name: /Show All .* Days/ });
  await expect(showAll).toBeVisible();
  await showAll.click();
  await main.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(table.locator("tbody tr").last()).toBeInViewport();
  await assertAnchored();
  await main.evaluate((element) => { element.scrollTop = 0; });
  await expect(page.locator(".page-title")).toBeInViewport();
  await assertAnchored();
  // The visually hidden header remains available to assistive technology.
  await expect(table.getByRole("columnheader", { name: "Day (UTC)" })).toHaveCount(1);
});
