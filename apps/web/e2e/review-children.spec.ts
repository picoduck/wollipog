import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`review sessions nest under their requester and disappear after disposal at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/sessions-states-e2e.html?state=review-children");
    const grid = page.getByRole("grid", { name: "Sessions", exact: true });
    const toggle = grid.locator(".inbox-thread-toggle");
    await expect(toggle).toHaveCount(1);
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(grid.getByRole("row")).toHaveCount(2);
    await expect(grid.getByRole("row").filter({ hasText: "Claude Review" })).toHaveClass(/thread-child/);
    await toggle.click();
    await expect(grid.getByRole("row")).toHaveCount(1);
    await page.goto("/sessions-states-e2e.html?state=review-disposed");
    await expect(grid.getByRole("row")).toHaveCount(1);
    await expect(grid).not.toContainText("Claude Review");
  });
}
