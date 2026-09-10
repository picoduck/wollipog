import { expect, test, type Page } from "@playwright/test";

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

test("desktop: a provider-reported free session shows $0.00 on first render", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/session-usage-e2e.html?width=1180&height=780&cost=free");

  const cost = page.getByRole("button", { name: "Session Usage: $0.00" });
  await expect(cost).toBeVisible();
  await expect(cost).toHaveText("$0.00");
  await expect(cost).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".session-usage-popover")).toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/desktop-free-first-render.png` });
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

/**
 * #893: the desktop session cost shares mobile's seat — the trailing track of the transcript
 * status strip — instead of sitting in the middle of the composer bar between the permission and
 * model controls. These cases pin the layout contract across every label the control can render.
 */
test.describe("desktop: the session cost occupies the status strip's trailing track", () => {
  /** Every shape `sessionCostLabel` can produce, widest to narrowest. */
  const LABELS = [
    { name: "a short priced", query: "", text: "$1.37" },
    { name: "a long priced", query: "&cost=12345.67", text: "$12345.67" },
    { name: "a sub-cent priced", query: "&cost=0.0007", text: "$0.0007" },
    { name: "an unavailable", query: "&cost=none", text: "$\u2014" },
  ];

  /** Geometry of the strip's three tracks, read in one pass so the boxes are mutually consistent. */
  const readStrip = (page: Page) =>
    page.locator(".transcript-status-strip").evaluate((strip) => {
      const rect = (selector: string) => {
        const element = strip.querySelector(selector);
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width };
      };
      const box = strip.getBoundingClientRect();
      const follow = strip.querySelector(".follow-tail-chip")!.getBoundingClientRect();
      return {
        strip: { left: box.left, right: box.right, center: box.left + box.width / 2 },
        meter: rect(".context-ring-button"),
        follow: { left: follow.left, right: follow.right, center: follow.left + follow.width / 2 },
        actions: rect(".transcript-status-actions"),
        cost: rect(".transcript-status-usage"),
        overflows: strip.scrollWidth > strip.clientWidth,
      };
    });

  for (const label of LABELS) {
    test(`${label.name} cost trails the follow control and leaves it centered`, async ({ page }) => {
      await page.setViewportSize({ width: 1200, height: 820 });
      await page.goto(`/session-usage-e2e.html?width=1180&height=780${label.query}`);

      const cost = page.locator(".transcript-status-usage");
      await expect(cost).toBeVisible();
      await expect(cost).toHaveText(label.text);

      // One seat, not two: the composer bar keeps outgoing-message controls only.
      await expect(page.locator(".cbar-usage")).toHaveCount(0);
      await expect(page.locator(".composer-bar").getByRole("button", { name: /^Session Usage/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Session Usage: / })).toHaveCount(1);

      const geometry = await readStrip(page);
      // The contextual Reply hint is present in this default (reader-active) state, so every
      // assertion below is made with another trailing action sharing the track.
      expect(geometry.actions!.width).toBeGreaterThan(0);
      expect(geometry.meter!.right).toBeLessThanOrEqual(geometry.follow.left + 0.5);
      expect(geometry.follow.right).toBeLessThanOrEqual(geometry.actions!.left + 0.5);
      expect(geometry.actions!.right).toBeLessThanOrEqual(geometry.cost!.left + 0.5);
      expect(geometry.cost!.right).toBeLessThanOrEqual(geometry.strip.right + 0.5);
      expect(geometry.cost!.width).toBeGreaterThan(0);
      expect(geometry.overflows).toBe(false);
      // The follow control stays optically centered no matter how wide the cost renders.
      expect(Math.abs(geometry.follow.center - geometry.strip.center)).toBeLessThanOrEqual(1);

      await page.screenshot({ path: `${SHOT}/desktop-status-strip-${label.name.replace(/[^a-z]+/g, "-")}.png` });
    });
  }

  test("a trailing action appearing or disappearing never moves the cost", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.goto("/session-usage-e2e.html?width=1180&height=780&cost=12345.67");

    const reply = page.locator(".transcript-status-actions").getByRole("button", { name: "Reply" });
    await expect(reply).toBeVisible();
    const withAction = await readStrip(page);

    // The Reply hint is offered only while the transcript owns focus; giving the composer focus
    // retires it. The cost is anchored to the strip edge, so it must not shift by a pixel.
    await page.locator(".composer-input").focus();
    await expect(reply).toHaveCount(0);
    const withoutAction = await readStrip(page);

    expect(withoutAction.cost!.left).toBeCloseTo(withAction.cost!.left, 1);
    expect(withoutAction.cost!.right).toBeCloseTo(withAction.cost!.right, 1);
    expect(Math.abs(withoutAction.follow.center - withoutAction.strip.center)).toBeLessThanOrEqual(1);

    // And the cost stays operable while the composer holds focus.
    await page.getByRole("button", { name: /^Session Usage: / }).click();
    await expect(page.locator(".session-usage-popover")).toHaveCount(1);
  });

  test("a cramped desktop pane keeps the cost readable by retiring the Reply hint", async ({ page }) => {
    // A desktop session beside an open side panel: the viewport is well above the mobile
    // breakpoint, but the transcript pane itself is narrow. With follow paused the follow-state
    // control roughly doubles, and the trailing track has to hold a wide cost as well.
    await page.setViewportSize({ width: 900, height: 820 });
    await page.goto("/session-usage-e2e.html?width=440&height=780&cost=12345.67");
    await expect(page.locator(".follow-tail-chip")).toBeVisible();
    await page.mouse.move(220, 300);
    await page.mouse.wheel(0, -900);
    await expect(page.locator(".follow-tail-chip")).toContainText("Follow Live Output");

    // The hint yields — its shortcut still works, and the cost is the permanent seat.
    await expect(page.locator(".transcript-status-actions")).toBeHidden();
    const cost = page.locator(".transcript-status-usage .session-cost-button");
    const legibility = await cost.evaluate((button) => ({
      visible: button.getBoundingClientRect().width,
      needed: button.scrollWidth,
    }));
    // Before the trailing track was allowed to shed the hint, this collapsed to ~14px, and to
    // literally zero at 400px, while the fixed-width hint kept every pixel it asked for.
    expect(legibility.visible).toBeGreaterThanOrEqual(legibility.needed - 0.5);

    const geometry = await readStrip(page);
    expect(geometry.follow.right).toBeLessThanOrEqual(geometry.cost!.left + 0.5);
    expect(geometry.cost!.right).toBeLessThanOrEqual(geometry.strip.right + 0.5);
    expect(geometry.overflows).toBe(false);
    expect(Math.abs(geometry.follow.center - geometry.strip.center)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${SHOT}/desktop-status-strip-cramped-pane.png` });
  });

  test("an enlarged root font retires the hint too, at a pane width that fits by pixels", async ({ page }) => {
    // Type is in rem so the browser's font-size preference actually does something (styles.css
    // "--- Type ---"). The follow-state control is px-sized and does not grow, but the hint and the
    // cost both do — so a pane wide enough at a 16px root can still be too narrow at 32px, and a
    // pixel-only cutoff would leave the hint showing while the cost fell below its own scrollWidth.
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto("/session-usage-e2e.html?width=561&height=780&cost=12345.67");
    await page.addStyleTag({ content: "html { font-size: 32px; }" });
    await expect(page.locator(".follow-tail-chip")).toBeVisible();
    await page.mouse.move(280, 300);
    await page.mouse.wheel(0, -900);
    await expect(page.locator(".follow-tail-chip")).toContainText("Follow Live Output");

    await expect(page.locator(".transcript-status-actions")).toBeHidden();
    const legibility = await page.locator(".transcript-status-usage .session-cost-button").evaluate((button) => ({
      visible: button.getBoundingClientRect().width,
      needed: button.scrollWidth,
    }));
    expect(legibility.visible).toBeGreaterThanOrEqual(legibility.needed - 0.5);
    expect((await readStrip(page)).overflows).toBe(false);
  });

  test("an unpriced ledger keeps the placeholder and names itself in the popover", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.goto("/session-usage-e2e.html?width=1180&height=780&cost=none");

    const cost = page.getByRole("button", { name: "Session Usage: Cost Unavailable" });
    await cost.click();
    const usage = page.locator(".session-usage-popover").first();
    await expect(usage).toContainText("Not Priced");
    // The ledger has now answered "unpriced": the strip still refuses to invent a $0.00, and the
    // control has not moved out of the trailing track to make room for the open panel.
    await expect(cost).toHaveText("$\u2014");
    const geometry = await readStrip(page);
    expect(geometry.actions!.right).toBeLessThanOrEqual(geometry.cost!.left + 0.5);
    expect(geometry.cost!.right).toBeLessThanOrEqual(geometry.strip.right + 0.5);
    expect(geometry.overflows).toBe(false);

    // The popover opens from the strip's right edge and still fits the viewport.
    const usageBox = (await usage.boundingBox())!;
    expect(usageBox.x).toBeGreaterThanOrEqual(0);
    expect(usageBox.x + usageBox.width).toBeLessThanOrEqual(1200);
    await page.screenshot({ path: `${SHOT}/desktop-status-strip-unpriced-popover.png` });

    await page.keyboard.press("Escape");
    await expect(page.locator(".session-usage-popover")).toHaveCount(0);
    await expect(cost).toHaveAttribute("aria-expanded", "false");
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
