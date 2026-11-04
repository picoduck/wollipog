import { expect, test } from "@playwright/test";

test("replacement search dims rows while busy and replaces them; failure removes them", async ({ page }) => {
  await page.goto("/archived-sessions-e2e.html?state=replacement");
  await expect(page.locator(".archive-item")).toHaveCount(4);
  await page.getByRole("searchbox").fill("Usage");
  const results = page.getByRole("region", { name: "Archived Session Results" });
  await expect(results).toHaveAttribute("aria-busy", "true");
  await expect(results.locator(".is-stale .archive-item")).toHaveCount(4);
  await expect(page.locator(".count")).toHaveText("Searching…");
  await expect(results.locator(".archive-item")).toHaveCount(1);
  await expect(results).toHaveAttribute("aria-busy", "false");
  await page.goto("/archived-sessions-e2e.html?state=failure");
  await expect(page.locator(".archive-item")).toHaveCount(4);
  await page.getByRole("searchbox").fill("Usage");
  await expect(results).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("Couldn't Load Archived Sessions", { exact: true })).toBeVisible();
  await expect(results.locator(".archive-item")).toHaveCount(0);
  await expect(page.locator(".count")).toHaveCount(0);
  await page.getByRole("button", { name: "Show Details", exact: true }).click();
  await expect(page.getByText("The replacement search failed.", { exact: true })).toBeVisible();
});

test("skeleton has five 56px rows after its delay", async ({ page }) => {
  await page.goto("/archived-sessions-e2e.html?state=loading");
  const rows = page.locator(".archive-skeleton-row");
  await expect(rows).toHaveCount(5);
  expect(await rows.first().evaluate((row) => row.getBoundingClientRect().height)).toBe(56);
  await expect(page.locator(".count")).toHaveCount(0);
});
