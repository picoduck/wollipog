import { expect, test } from "@playwright/test";

/**
 * Session-level usage (#602, #781): per-turn tokens and cost on the user message, the context ring
 * with its occupancy-only popover, and the separate session-cost control whose Session Usage
 * popover owns cumulative tokens and the per-model breakdown. Screenshots land in
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
  // Occupancy and capacity only: cumulative usage and billing moved to the cost control (#781).
  await expect(popover).toContainText("Used");
  await expect(popover).toContainText("72k");
  // #806's capacity provenance survives the split — which window is being measured against is an
  // occupancy fact, not billing.
  await expect(popover).toContainText("Capacity");
  await expect(popover).toContainText("200K · Provider Reported");
  await expect(popover).toContainText("Remaining");
  await expect(popover).toContainText("128k");
  await expect(popover).toContainText("compacts automatically");
  await expect(popover).not.toContainText("By Model");
  await expect(popover).not.toContainText("Total Processed");
  await expect(popover).not.toContainText("Session Cost");
  await page.screenshot({ path: `${SHOT}/desktop-popover.png` });
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
});

test("desktop: the cost control opens Session Usage with cumulative tokens and the model split", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/session-usage-e2e.html?width=1180&height=780");

  const cost = page.getByRole("button", { name: "Session Usage: $1.37" });
  await expect(cost).toBeVisible();
  await expect(cost).toHaveText("$1.37");
  // The always-visible figure is the cost alone — never the context summary it replaced (#781).
  await expect(cost).not.toContainText("context");

  await cost.click();
  const usage = page.locator(".session-usage-popover").first();
  await expect(usage).toBeVisible();
  await expect(usage).toContainText("Session Usage");
  await expect(usage).toContainText("Input");
  await expect(usage).toContainText("Output");
  await expect(usage).toContainText("Cache Read");
  await expect(usage).toContainText("Total Processed");
  await expect(usage).toContainText("205k");
  await expect(usage).toContainText("By Model");
  await expect(usage).toContainText("gpt-5.5-codex-mini");
  await expect(usage).toContainText("$0.16");
  await expect(usage).not.toContainText("Not Priced");
  const protocolInfo = usage.getByRole("button", { name: "About Codex App Server Usage" });
  const protocolDetail = usage.locator(".session-usage-info-detail");
  await expect(protocolInfo).toBeVisible();
  await expect(protocolDetail).toBeHidden();
  const pricingSource = usage.getByRole("link", { name: "Estimated API Costs" });
  await expect(pricingSource).toHaveAttribute(
    "href",
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  );
  await expect(usage).not.toContainText("raw.githubusercontent.com");
  // The usage panel never repeats the context meter's occupancy or capacity.
  await expect(usage).not.toContainText("Capacity");
  await expect(usage).not.toContainText("Remaining");
  await page.screenshot({ path: `${SHOT}/desktop-session-usage.png` });
  await protocolInfo.hover();
  await expect(protocolDetail).toBeVisible();
  await expect(protocolDetail).toContainText("before protocol v127 is incomplete");

  await page.keyboard.press("Escape");
  await expect(usage).toHaveCount(0);
  await expect(cost).toHaveAttribute("aria-expanded", "false");
});

test("desktop: the two controls have distinct accessible names and open independently", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/session-usage-e2e.html?width=1180&height=780");

  const ring = page.getByRole("button", { name: /^Context Window .* Used$/ });
  const cost = page.getByRole("button", { name: "Session Usage: $1.37" });
  await expect(ring).toHaveCount(1);
  await expect(cost).toHaveCount(1);

  // Keyboard activation works for both, and opening one leaves the other closed.
  await cost.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".session-usage-popover")).toHaveCount(1);
  await expect(page.locator(".context-popover")).toHaveCount(0);
  await ring.click();
  await expect(page.locator(".context-popover")).toHaveCount(1);
  await expect(page.locator(".session-usage-popover")).toHaveCount(0);
});

test("desktop: an unpriced session says so instead of showing $0.00", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/session-usage-e2e.html?width=1180&height=780&cost=none");

  const cost = page.getByRole("button", { name: "Session Usage: Cost Unavailable" });
  await expect(cost).toBeVisible();
  await expect(cost).toHaveText("$—");
  await expect(page.locator(".session-detail").first()).not.toContainText("$0.00");

  await cost.click();
  const usage = page.locator(".session-usage-popover").first();
  await expect(usage).toContainText("Not Priced");
  await expect(usage).toContainText("could not be priced");
  await expect(usage).not.toContainText("$0.00");
  await page.screenshot({ path: `${SHOT}/desktop-unpriced.png` });
});

test("desktop: an unknown context window hides the ring and keeps the cost control", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/session-usage-e2e.html?width=1180&height=780&window=none");

  await expect(page.locator(".context-ring-button")).toHaveCount(0);
  const cost = page.getByRole("button", { name: "Session Usage: $1.37" });
  await expect(cost).toBeVisible();
  await cost.click();
  await expect(page.locator(".session-usage-popover").first()).toContainText("Total Processed");
  await page.screenshot({ path: `${SHOT}/desktop-unknown-context.png` });
});

test("the warning state above the threshold", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/session-usage-e2e.html?width=1180&height=780&used=186000&driver=claude-code");
  const meter = page.locator(".context-meter").first();
  await expect(meter).toHaveClass(/is-full/);
  await expect(page.locator(".context-ring-button").first()).toHaveAttribute("aria-label", /93% Used/);
  await page.locator(".context-ring-button").first().click();
  await expect(page.locator(".context-popover").first()).toContainText("compacts automatically");
  await page.screenshot({ path: `${SHOT}/desktop-warning.png` });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Session Usage: $1.37" }).click();
  await expect(page.locator(".session-usage-popover").first()).toContainText("claude-fable-5-1");
});

test("a cost checkpoint parks the session with a Continue/Stop card", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/session-usage-e2e.html?width=1180&height=780&approval=checkpoint");
  const card = page.locator(".approval-bar").first();
  await expect(card).toContainText("Cost checkpoint — $2.61 of $2.50. Continue?");
  await expect(card.getByRole("button", { name: "Continue" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.screenshot({ path: `${SHOT}/desktop-checkpoint-card.png` });
});

test.describe("Answer Mode ownership", () => {
  test("Load into Composer reveals the prepared draft and external resolution restores region focus", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.goto("/session-usage-e2e.html?width=1180&height=780&approval=question");

    await expect(page.getByText("Answer Mode", { exact: true })).toBeVisible();
    await page.screenshot({ path: `${SHOT}/answer-mode-before.png` });
    await page.getByRole("button", { name: "Edit User Message as a New Turn" }).last().click();
    await page.getByLabel("Message", { exact: true }).fill("Prepared follow-up from an earlier turn");
    await page.getByRole("button", { name: "Load into Composer" }).click();

    const composer = page.locator(".composer-input");
    await expect(composer).toHaveValue("Prepared follow-up from an earlier turn");
    await expect(composer).toBeFocused();
    await expect(page.getByText("Question Waiting", { exact: true })).toBeVisible();
    await page.screenshot({ path: `${SHOT}/answer-mode-after-load.png` });

    await page.getByRole("button", { name: "Respond", exact: true }).click();
    const choice = page.getByRole("radio", { name: /Staging/ });
    await choice.focus();
    await page.evaluate(() => window.resolveSessionUsageQuestion());
    await expect(composer).toBeFocused();
  });
});

test("mobile: the ring and per-turn usage stay reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/session-usage-e2e.html?width=390&height=800");
  await expect(page.locator(".tl-turn-usage").first()).toBeVisible();
  await page.screenshot({ path: `${SHOT}/mobile-turn-usage.png` });
});

test("mobile: the strip trails the cost alone, and it opens Session Usage", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/session-usage-e2e.html?width=390&height=800");

  const strip = page.locator(".transcript-status-strip").first();
  const trailing = strip.locator(".transcript-status-usage");
  await expect(trailing).toBeVisible();
  await expect(trailing).toHaveText("$1.37");
  // The reported regression: the trailing slot no longer repeats the context meter (#781).
  await expect(trailing).not.toContainText("context");
  await expect(strip.locator(".context-ring-button")).toBeVisible();
  await page.screenshot({ path: `${SHOT}/mobile-status-strip.png` });

  // The cost, the ring, and the follow-output control share the strip without overlapping.
  const follow = strip.locator(".follow-tail-chip");
  const followBox = (await follow.boundingBox())!;
  const costBox = (await trailing.boundingBox())!;
  const ringBox = (await strip.locator(".context-ring-button").boundingBox())!;
  expect(ringBox.x + ringBox.width).toBeLessThanOrEqual(followBox.x + 1);
  expect(followBox.x + followBox.width).toBeLessThanOrEqual(costBox.x + 1);
  expect(costBox.x + costBox.width).toBeLessThanOrEqual(390);

  await trailing.locator("button").click();
  const usage = page.locator(".session-usage-popover").first();
  await expect(usage).toBeVisible();
  await expect(usage).toContainText("Input");
  await expect(usage).toContainText("Output");
  const protocolInfo = usage.getByRole("button", { name: "About Codex App Server Usage" });
  const protocolDetail = usage.locator(".session-usage-info-detail");
  await expect(protocolDetail).toBeHidden();
  await protocolInfo.click();
  await expect(protocolDetail).toBeVisible();
  await expect(protocolDetail).toContainText("Protocol v127+ counts every response in each turn");
  await page.screenshot({ path: `${SHOT}/mobile-session-usage-info.png` });
  await protocolInfo.click();
  await page.mouse.move(0, 0);
  await expect(protocolDetail).toBeHidden();
  await expect(usage.getByRole("link", { name: "Estimated API Costs" })).toBeVisible();
  await expect(usage).not.toContainText("raw.githubusercontent.com");
  const usageBox = (await usage.boundingBox())!;
  expect(usageBox.x).toBeGreaterThanOrEqual(0);
  expect(usageBox.x + usageBox.width).toBeLessThanOrEqual(390);
  expect(await usage.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(await usage.evaluate((element) => element.clientWidth));
  await page.screenshot({ path: `${SHOT}/mobile-session-usage.png` });
});

test("mobile light theme: the estimated cost source stays compact", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/session-usage-e2e.html?width=390&height=800");
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Session Usage: $1.37" }).click();
  const usage = page.locator(".session-usage-popover").first();
  await expect(usage.getByRole("link", { name: "Estimated API Costs" })).toBeVisible();
  expect(await usage.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(await usage.evaluate((element) => element.clientWidth));
  await page.screenshot({ path: `${SHOT}/mobile-session-usage-light.png` });
});
