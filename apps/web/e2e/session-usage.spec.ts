import { expect, test } from "@playwright/test";

/**
 * Session-level usage (#602): per-turn tokens and cost on the user message, the context ring with
 * its popover, and the per-model breakdown inside it. Screenshots land in
 * `test-results/session-usage/` as the PR's visual evidence.
 */

test.use({ reducedMotion: "reduce" });
const SHOT = "test-results/session-usage";

test("desktop: per-turn usage, the ring popover with totals and the per-model split", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/session-usage-e2e.html?width=1180&height=780");
  const turnUsage = page.locator(".tl-turn-usage");
  await expect(turnUsage.first()).toBeVisible();
  await expect(turnUsage).toHaveCount(4);
  await expect(turnUsage.nth(0)).toContainText("$0.18");
  await expect(turnUsage.nth(2)).not.toContainText("$");
  await page.screenshot({ path: `${SHOT}/desktop-turn-usage.png` });

  const ring = page.locator(".context-ring-button").first();
  await expect(ring).toHaveAttribute("aria-label", /Context Window 36% Used/);
  await ring.click();
  const popover = page.locator(".context-popover").first();
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("Total Processed");
  await expect(popover).toContainText("205k");
  await expect(popover).toContainText("compacts automatically");
  await expect(popover).toContainText("By Model");
  await expect(popover).toContainText("gpt-5.5-codex-mini");
  await page.screenshot({ path: `${SHOT}/desktop-popover.png` });
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
});

test("the warning state above the threshold", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/session-usage-e2e.html?width=1180&height=780&used=186000&driver=claude-code");
  const meter = page.locator(".context-meter").first();
  await expect(meter).toHaveClass(/is-full/);
  await expect(page.locator(".context-ring-button").first()).toHaveAttribute("aria-label", /93% Used/);
  await page.locator(".context-ring-button").first().click();
  await expect(page.locator(".context-popover").first()).toContainText("claude-fable-5-1");
  await page.screenshot({ path: `${SHOT}/desktop-warning.png` });
});

test("mobile: the ring and per-turn usage stay reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/session-usage-e2e.html?width=390&height=800");
  await expect(page.locator(".tl-turn-usage").first()).toBeVisible();
  await page.screenshot({ path: `${SHOT}/mobile-turn-usage.png` });
});
