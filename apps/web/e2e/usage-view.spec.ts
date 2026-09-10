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
  await expect(page.locator(".usage-coverage", { hasText: "Codex App Server" })).toContainText(
    "Codex App Server records written by runners before protocol v127 include only the final model response and are incomplete",
  );
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

test("Claude subscription cards show used and remaining allowance per window (#224)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/usage-view-e2e.html?subscriptions=1");
  const cards = page.locator(".subscription-source");
  await expect(cards).toHaveCount(3);

  // A current Claude build: every window it tracks is listed independently, with real percentages
  // rather than the bare "Allowance Reported" fallback.
  const current = cards.filter({ hasText: "Claude Code on build-box" }).first();
  const buckets = current.locator(".subscription-bucket");
  await expect(buckets).toHaveCount(3);
  await expect(buckets.nth(0)).toContainText("Five-Hour Window");
  await expect(buckets.nth(0)).toContainText("17% Remaining");
  await expect(buckets.nth(0)).toContainText("83% Used");
  await expect(buckets.nth(0)).toContainText("Approaching Limit");
  await expect(buckets.nth(1)).toContainText("Weekly — All Models");
  await expect(buckets.nth(1)).toContainText("54% Remaining");
  await expect(buckets.nth(2)).toContainText("Weekly — Extra Usage");
  await expect(buckets.nth(2)).toContainText("88% Remaining");
  await expect(current).not.toContainText("Allowance Reported");

  // A build that reports resets but no utilization says so, instead of reading as a source that
  // has not answered yet.
  const resetOnly = cards.filter({ hasText: "Claude Code (Ubuntu)" }).first();
  await expect(resetOnly).toContainText("Allowance Reported");
  await expect(resetOnly).toContainText("without utilization percentages");
  await expect(resetOnly).not.toContainText("after the first provider response");

  // A source that answered without allowance headers gets its own explanation.
  const noHeaders = cards.filter({ hasText: "Claude Code (Debian)" }).first();
  await expect(noHeaders).toContainText("Temporarily Unavailable");
  await expect(noHeaders).toContainText("answered without reporting subscription allowances");
  await expect(noHeaders).not.toContainText("after the first provider response");

  await page.locator(".subscription-source-grid").screenshot({ path: `${SHOT}/subscription-claude-dark.png` });
  await page.goto("/usage-view-e2e.html?subscriptions=1&theme=light");
  await expect(page.locator(".subscription-bucket").first()).toContainText("17% Remaining");
  await page.locator(".subscription-source-grid").screenshot({ path: `${SHOT}/subscription-claude-light.png` });
});
