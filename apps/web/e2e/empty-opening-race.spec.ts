import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) for (const theme of ["dark", "light"]) for (const recovery of ["live", "http", "later"] as const) {
  test(`an empty opening recovers the racing current prompt through ${recovery} at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/transcript-states-e2e.html?state=empty-opening-race&theme=${theme}`);
    await expect(page.locator("body")).toHaveAttribute("data-opening-requested", "true");
    await expect(page.locator("body")).toHaveAttribute("data-subscription-applied", "true");
    const reader = page.getByRole("region", { name: "Session Activity", exact: true });
    // Pause before the held response resolves so recovery is an explicit reader action.
    await reader.evaluate((element) => element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 })));
    await expect(reader).toHaveAttribute("data-follow-tail-state", "paused");
    await page.evaluate((recovery) => {
      // Sparse live delivery forces Jump to Latest to fetch an authoritative HTTP tail.
      window.__emptyOpeningRace.emit(recovery === "http" ? [3] : [1, 2, 3]);
      window.__emptyOpeningRace.release();
    }, recovery);
    await expect.poll(() => page.evaluate(() => window.__emptyOpeningRace.sequences())).toEqual([]);
    const loadLater = page.getByRole("button", { name: "Load Later Activity", exact: true });
    await expect(loadLater).toBeVisible();
    if (recovery === "later") await loadLater.click();
    else await page.getByRole("button", { name: "Jump to Latest", exact: true }).click();
    await expect(reader.getByText("Current prompt: recover the empty opening.", { exact: true })).toBeVisible();
    await expect(reader.getByText("The first live response follows the current prompt.", { exact: true })).toBeVisible();
    await expect(reader.getByText("The second live response completes this synthetic turn.", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__emptyOpeningRace.sequences())).toEqual([1, 2, 3]);
    await expect(reader).toHaveAttribute("aria-busy", "false");
    await expect(loadLater).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    expect(await page.locator("body").getAttribute("data-tail-request-count")).toBe(recovery === "http" ? "1" : null);
    if (recovery === "live") await page.screenshot({ path: test.info().outputPath("recovered-empty-opening.png") });
  });
}
