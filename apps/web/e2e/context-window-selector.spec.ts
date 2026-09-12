import { expect, test } from "@playwright/test";

/**
 * Selectable context windows (#11): the composer's model menu collapses `opus` / `opus[1m]` into
 * one Model entry plus a Context Window group, the meter states where its capacity came from, and
 * a served window that differs from the advertised one is named. Screenshots land in
 * `test-results/context-window/` as the PR's visual evidence.
 */

test.use({ reducedMotion: "reduce" });
const SHOT = "test-results/context-window";

test("desktop: one Opus entry, a Context Window group, and catalog-sourced capacity", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/session-usage-e2e.html?width=1180&height=780&context=choice&used=150000");
  const trigger = page.locator(".cbar-trigger", { hasText: "Opus 5" }).first();
  await expect(trigger).toContainText("1M");
  await expect(trigger).toHaveAttribute("title", /context window/);
  await trigger.click();
  const modelGroup = page.getByRole("group", { name: "Model" });
  await expect(modelGroup.getByRole("menuitemradio", { name: "Opus 5", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(modelGroup.getByRole("menuitemradio", { name: /1M Context/ })).toHaveCount(0);
  const windowGroup = page.getByRole("group", { name: "Context Window" });
  await expect(windowGroup.getByRole("menuitemradio", { name: "200K" })).toHaveAttribute("aria-checked", "false");
  await expect(windowGroup.getByRole("menuitemradio", { name: "1M" })).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: `${SHOT}/desktop-menu.png` });
  await page.keyboard.press("Escape");

  const ring = page.locator(".context-ring-button").first();
  await expect(ring).toHaveAttribute("aria-label", /Context Window 15% Used/);
  await ring.click();
  const popover = page.locator(".context-popover").first();
  await expect(popover).toContainText("1M · Model Catalog");
  await expect(popover.locator(".context-popover-discrepancy")).toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/desktop-popover-catalog.png` });
});

test("desktop: a served 200K window against an advertised 1M is named in the popover", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/session-usage-e2e.html?width=1180&height=780&context=choice&used=150000&served=200000");
  const ring = page.locator(".context-ring-button").first();
  await expect(ring).toHaveAttribute("aria-label", /Context Window 75% Used/);
  await ring.click();
  const popover = page.locator(".context-popover").first();
  await expect(popover).toContainText("200K · Provider Reported");
  await expect(popover.locator(".context-popover-discrepancy")).toContainText(
    "The provider is serving a 200K context window, not the 1M the selected model advertises.",
  );
  await page.screenshot({ path: `${SHOT}/desktop-popover-downgrade.png` });
});

test("no Context Window group when the catalog offers a single window for the base", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/session-usage-e2e.html?width=1180&height=780&context=choice&model=sonnet");
  const trigger = page.locator(".cbar-trigger", { hasText: "Sonnet 5" }).first();
  await expect(trigger).not.toContainText("1M");
  await trigger.click();
  await expect(page.getByRole("group", { name: "Model" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Context Window" })).toHaveCount(0);
  // Sonnet's catalog entry states no window and nothing was served yet: no meter, no guess.
  await expect(page.locator(".context-ring-button")).toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/desktop-menu-no-choice.png` });
});

test("mobile: the Context Window group in the composer menu", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/session-usage-e2e.html?width=390&height=800&context=choice&used=150000");
  const trigger = page.locator(".cbar-trigger", { hasText: "Opus 5" }).first();
  await trigger.click();
  await expect(page.getByRole("group", { name: "Context Window" }).getByRole("menuitemradio", { name: "1M" })).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: `${SHOT}/mobile-menu.png` });
  await page.keyboard.press("Escape");
  await page.locator(".context-ring-button").first().click();
  await expect(page.locator(".context-popover").first()).toContainText("Model Catalog");
  await page.screenshot({ path: `${SHOT}/mobile-popover.png` });
});
