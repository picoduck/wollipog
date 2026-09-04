import { expect, test } from "@playwright/test";

/**
 * The redesigned Usage & Cost view (#601): metric toggle, driver-stacked chart with a hover and
 * keyboard readout, totals tiles, Model/Day breakdown, and the coverage notice. Screenshots land
 * in `test-results/usage-view/` as the PR's visual evidence.
 */

test.use({ reducedMotion: "reduce" });

const SHOT = "test-results/usage-view";

test("desktop: metric toggle flips every figure, the chart answers hover and focus, and Model/Day swap", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/usage-view-e2e.html");
  const headline = page.locator(".usage-headline-value");
  await expect(headline).toContainText("$");
  await page.screenshot({ path: `${SHOT}/desktop-dark-cost.png`, fullPage: true });

  const cost = await headline.textContent();
  await page.getByRole("radio", { name: "Tokens" }).click();
  await expect(headline).not.toHaveText(cost ?? "");
  await expect(headline).toContainText("M");
  await expect(page.locator(".usage-chart-section h3")).toContainText("Processed Tokens");
  await expect(page.locator(".usage-breakdown-section .usage-table thead")).toContainText("Cost");
  await page.screenshot({ path: `${SHOT}/desktop-dark-tokens.png`, fullPage: true });
  await page.getByRole("radio", { name: "Cost" }).click();

  // Hover a column: the readout lists every driver plus a total.
  const hits = page.locator(".usage-chart-hit");
  await expect(hits).toHaveCount(30);
  await hits.nth(14).hover();
  const readout = page.locator(".usage-chart-readout");
  await expect(readout).toContainText("Claude Code");
  await expect(readout).toContainText("Codex");
  await expect(readout).toContainText("Total");
  await page.screenshot({ path: `${SHOT}/desktop-dark-hover.png`, clip: { x: 0, y: 0, width: 1280, height: 900 } });

  // Keyboard reaches the same readout.
  await hits.nth(3).focus();
  await expect(readout).toContainText("Total");
  const legend = page.locator(".usage-legend li");
  await expect(legend).toHaveCount(3);

  await page.getByRole("radio", { name: "Model" }).click();
  await expect(page.locator(".usage-breakdown-section .usage-table caption")).toHaveText("Usage by Model");
  await expect(page.locator(".usage-table tbody th").first()).toContainText("claude-fable-5-1");
  await page.screenshot({ path: `${SHOT}/desktop-dark-model.png`, fullPage: true });
  await page.getByRole("radio", { name: "Day" }).click();
  await expect(page.locator(".usage-breakdown-section .usage-table caption")).toContainText("Daily Usage in UTC");
});

test("per-user daily budget: the By User table names who is paused and admins can change the amount", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/usage-view-e2e.html");
  const section = page.locator(".usage-users-section");
  await expect(section).toContainText("Ada · paused by daily budget");
  await expect(section).toContainText("$26.40 of $25.00");
  await expect(section).toContainText("Each user may spend $25.00 per UTC day");
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOT}/desktop-dark-users.png`, fullPage: true });

  await page.getByLabel("Daily Budget per User ($)").fill("30");
  await page.getByRole("button", { name: "Save Daily Budget" }).click();
  await expect(section).toContainText("Daily budget saved.");
  await expect(section).not.toContainText("paused by daily budget");
  await expect(section).toContainText("$26.40 of $30.00");
});

test("light theme and the coverage notice for unpriced records and a cached rate table", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/usage-view-e2e.html?theme=light&unpriced=1");
  const notice = page.locator(".usage-notice");
  await expect(notice).toContainText("no price");
  await expect(notice).toContainText("could not be refreshed");
  await page.screenshot({ path: `${SHOT}/desktop-light-unpriced.png`, fullPage: true });

  await page.goto("/usage-view-e2e.html?theme=light&empty=1");
  await expect(page.locator(".usage-chart-empty")).toBeVisible();
  await expect(page.locator(".usage-notice")).toHaveCount(0);
});

test("mobile: the overview stacks and every control stays reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/usage-view-e2e.html");
  await expect(page.locator(".usage-headline-value")).toBeVisible();
  await page.getByRole("radio", { name: "Tokens" }).click();
  await expect(page.locator(".usage-headline-value")).toContainText("M");
  await page.screenshot({ path: `${SHOT}/mobile-dark-tokens.png`, fullPage: true });
});
