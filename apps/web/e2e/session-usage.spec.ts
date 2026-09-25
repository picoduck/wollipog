import { expect, test, type Page } from "@playwright/test";
import { pinWidestFace } from "./font-geometry";

/**
 * Session-level usage (#602, #781): per-turn tokens and cost on the user message, the context ring
 * with its occupancy-only popover, and the separate session-cost control whose Session Usage
 * popover owns cumulative tokens and the per-model breakdown. Screenshots land in
 * `test-results/session-usage/` as the PR's visual evidence.
 */

test.use({ reducedMotion: "reduce" });
const SHOT = "test-results/session-usage";

test("desktop: Parent Control exposes five independent typed workflow authorities", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/session-usage-e2e.html?width=1180&height=860&composer=orchestrator");
  await page.getByRole("button", { name: "Add and Modes" }).click();

  await expect(page.getByRole("button", { name: "Implementation Questions: Orchestrator" })).toBeVisible();
  await expect(page.getByRole("button", { name: "PR Merge Approval: Human" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Merged Branch Deletion: Human" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Follow-Up Issue Publication: Orchestrator" })).toBeVisible();
  await expect(page.getByRole("button", { name: "UI Evidence Approval: Human" })).toBeVisible();
  await expect(page.getByText(/provider may retain them in provider-local transcripts or media logs/)).toBeVisible();
  await expect(page.getByText(/Existing unconsumed approvals are revoked/)).toBeVisible();
  await page.getByText(/provider may retain them in provider-local transcripts or media logs/).scrollIntoViewIfNeeded();
  await page.locator(".composer-plus-pop").evaluate((menu) => { menu.scrollTop = menu.scrollHeight; });
  await page.locator(".composer-plus-pop").screenshot({ path: `${SHOT}/desktop-typed-parent-control.png` });
});

for (const viewport of [
  { name: "desktop", width: 1200, height: 900, fixtureWidth: 1180, fixtureHeight: 860 },
  { name: "mobile", width: 393, height: 844, fixtureWidth: 393, fixtureHeight: 844 },
] as const) {
  test(`${viewport.name}: active campaign summary exposes status, revision, progress, and compatibility`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`/session-usage-e2e.html?width=${viewport.fixtureWidth}&height=${viewport.fixtureHeight}&composer=orchestrator&campaign-state=off`);
    await page.getByRole("button", { name: "Add and Modes" }).click();
    const beforeSummary = page.locator(".composer-plus-pop .active-campaign-policy");
    await expect(beforeSummary).toBeVisible();
    await expect(beforeSummary.getByText("Campaign Status", { exact: true })).toHaveCount(0);
    await beforeSummary.getByText("Child Model", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT}/${viewport.name}-campaign-before.png` });

    await page.goto(`/session-usage-e2e.html?width=${viewport.fixtureWidth}&height=${viewport.fixtureHeight}&composer=orchestrator`);
    await page.getByRole("button", { name: "Add and Modes" }).click();

    const menu = page.locator(".composer-plus-pop");
    const summary = menu.locator(".active-campaign-policy");
    await expect(summary.getByText("Campaign Behavior", { exact: true })).toBeVisible();
    await expect(summary).toContainText("Waiting for Human");
    await expect(summary).toContainText("Policy Revision 4");
    await expect(summary).toContainText("4");
    await expect(summary).toContainText("1 Verified · 2 Active · 1 Waiting for Human · 0 Blocked");
    await expect(summary).toContainText("2");
    await expect(summary).toContainText("1 Duplicates Skipped");
    const compatibility = summary.getByRole("status");
    await expect(compatibility).toContainText("is routed to a human. The Orchestrator model \"text-only\" does not accept image input.");
    await summary.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT}/${viewport.name}-campaign-summary.png` });
    await compatibility.scrollIntoViewIfNeeded();
    await expect(compatibility).toBeVisible();
    await page.screenshot({ path: `${SHOT}/${viewport.name}-campaign-progress.png` });
  });
}

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

test("desktop: an active Codex turn replaces a misleading small settled total before completion", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/session-usage-e2e.html?width=1180&height=780&active-usage=1");

  const settledCost = page.getByRole("button", { name: "Session Usage: $0.08" });
  await expect(settledCost).toBeVisible();
  await settledCost.click();
  const settledUsage = page.locator(".session-usage-popover").first();
  await expect(settledUsage.locator('dl > div:has(> dt:text-is("Output")) > dd')).toHaveText("21");
  await page.screenshot({ path: `${SHOT}/active-turn-before.png` });
  await page.keyboard.press("Escape");
  await expect(settledUsage).toHaveCount(0);
  await page.evaluate(() => window.publishLiveSessionUsage());

  const liveCost = page.getByRole("button", { name: "Session Usage: $0.30" });
  await expect(liveCost).toBeVisible();
  await liveCost.click();
  const usage = page.locator(".session-usage-popover").first();
  await expect(usage).toContainText("10k");
  await expect(usage).toContainText("40k");
  await expect(usage).toContainText("4.5k");
  await expect(usage).toContainText("55k");
  await expect(usage).not.toContainText("21");
  await page.screenshot({ path: `${SHOT}/active-turn-after.png` });
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

test("desktop: a provider-reported free session stays $0.00 through its model detail", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/session-usage-e2e.html?width=1180&height=780&cost=free");

  const cost = page.getByRole("button", { name: "Session Usage: $0.00" });
  await expect(cost).toBeVisible();
  await expect(cost).toHaveText("$0.00");
  await expect(cost).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".session-usage-popover")).toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/desktop-free-first-render.png` });

  await cost.click();
  const usage = page.locator(".session-usage-popover").first();
  await expect(usage.locator(".session-usage-head > span")).toHaveText("$0.00");
  await expect(usage).toContainText("Cost as reported by the provider.");
  const modelCosts = usage.locator(
    '.session-usage-model dl > div:has(> dt:text-is("Cost")) > dd',
  );
  await expect(modelCosts).toHaveCount(2);
  await expect(modelCosts).toHaveText(["$0.00", "$0.00"]);
  await expect(usage).not.toContainText("$1.21");
  await expect(usage).not.toContainText("$0.16");
  await page.screenshot({ path: `${SHOT}/desktop-free-detail.png` });
});

for (const detailState of ["pending", "failed"] as const) {
  test(`desktop: a provider-reported free heading stays $0.00 when detail is ${detailState}`, async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.goto(`/session-usage-e2e.html?width=1180&height=780&cost=free&usage-detail=${detailState}`);

    await page.getByRole("button", { name: "Session Usage: $0.00" }).click();
    const usage = page.locator(".session-usage-popover").first();
    await expect(usage.locator(".session-usage-head > span")).toHaveText("$0.00");
    await expect(usage.locator(".session-usage-models")).toHaveCount(0);
    if (detailState === "failed") {
      await expect(usage.getByRole("alert")).toHaveText("Usage detail unavailable");
    } else {
      await expect(usage.getByRole("alert")).toHaveCount(0);
    }
    await page.screenshot({ path: `${SHOT}/desktop-free-${detailState}.png` });
  });
}

test("desktop: an unknown context window hides the ring and keeps the cost control", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/session-usage-e2e.html?width=1180&height=780&window=none");

  await expect(page.locator(".context-ring-button")).toHaveCount(0);
  const cost = page.getByRole("button", { name: "Session Usage: $1.37" });
  await expect(cost).toBeVisible();
  const centering = await page.locator(".transcript-status-strip").evaluate((strip) => {
    const stripBox = strip.getBoundingClientRect();
    const follow = strip.querySelector(".follow-tail-chip")!.getBoundingClientRect();
    return {
      stripCenter: stripBox.left + stripBox.width / 2,
      followCenter: follow.left + follow.width / 2,
    };
  });
  expect(Math.abs(centering.followCenter - centering.stripCenter)).toBeLessThanOrEqual(1);
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

test("a cost checkpoint parks the session with a compact responsive-review request", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/session-usage-e2e.html?width=1180&height=780&approval=checkpoint");
  await expect(page.locator(".approval-bar")).toHaveCount(0);
  const card = page.getByRole("region", { name: "Pending Approval Request" });
  await expect(card).toContainText("Cost checkpoint — $2.61 of $2.50. Continue?");
  const trigger = page.getByRole("button", { name: "Review Request" });
  await expect(trigger).toBeVisible();
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
 * Session accounting stays out of the message composer and joins context usage directly beside
 * the live-output control. These cases pin the independently centered control across every cost
 * label while the context and action tracks consume only their own side.
 */
test.describe("desktop: context and cost flank the live-output control", () => {
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
        cluster: rect(".transcript-status-cluster"),
        meter: rect(".context-ring-button"),
        follow: { left: follow.left, right: follow.right, center: follow.left + follow.width / 2 },
        actions: rect(".transcript-status-actions"),
        cost: rect(".transcript-status-usage"),
        overflows: strip.scrollWidth > strip.clientWidth,
      };
    });

  for (const label of LABELS) {
    test(`${label.name} cost stays beside the centered follow control`, async ({ page }) => {
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
      // The contextual Reply hint is present, but occupies only trailing slack outside the cluster.
      expect(geometry.actions!.width).toBeGreaterThan(0);
      expect(geometry.meter!.right).toBeLessThanOrEqual(geometry.follow.left + 0.5);
      expect(geometry.follow.left - geometry.meter!.right).toBeLessThanOrEqual(8.5);
      expect(geometry.follow.right).toBeLessThanOrEqual(geometry.cost!.left + 0.5);
      expect(geometry.cost!.left - geometry.follow.right).toBeLessThanOrEqual(8.5);
      expect(geometry.cost!.right).toBeLessThanOrEqual(geometry.actions!.left + 0.5);
      expect(geometry.cost!.width).toBeGreaterThan(0);
      expect(geometry.overflows).toBe(false);
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
    // retires it. Because it lives outside the cluster, the cost must not shift by a pixel.
    await page.locator(".composer-input").focus();
    await expect(reply).toHaveCount(0);
    const withoutAction = await readStrip(page);

    expect(withoutAction.cost!.left).toBeCloseTo(withAction.cost!.left, 1);
    expect(withoutAction.cost!.right).toBeCloseTo(withAction.cost!.right, 1);
    expect(withoutAction.cluster!.left).toBeCloseTo(withAction.cluster!.left, 1);
    expect(withoutAction.cluster!.right).toBeCloseTo(withAction.cluster!.right, 1);

    // And the cost stays operable while the composer holds focus.
    await page.getByRole("button", { name: /^Session Usage: / }).click();
    await expect(page.locator(".session-usage-popover")).toHaveCount(1);
  });

  test("a cramped desktop pane keeps the cost readable by retiring the Reply hint", async ({ page }) => {
    // A desktop session beside an open side panel: the viewport is well above the mobile
    // breakpoint, but the transcript pane itself is narrow. With follow paused the follow-state
    // control roughly doubles while the symmetric side tracks still hold both usage indicators.
    await page.setViewportSize({ width: 900, height: 820 });
    await page.goto("/session-usage-e2e.html?width=440&height=780&cost=12345.67");
    await expect(page.locator(".follow-tail-chip")).toBeVisible();
    await page.mouse.move(220, 300);
    await page.mouse.wheel(0, -900);
    await expect(page.locator(".follow-tail-chip")).toContainText("Follow Live Output");

    // The trailing hint yields — its shortcut still works, and every cluster item stays readable.
    await expect(page.locator(".transcript-status-actions")).toBeHidden();
    const cost = page.locator(".transcript-status-usage .session-cost-button");
    const legibility = await cost.evaluate((button) => ({
      visible: button.getBoundingClientRect().width,
      needed: button.scrollWidth,
    }));
    expect(legibility.visible).toBeGreaterThanOrEqual(legibility.needed - 0.5);

    const geometry = await readStrip(page);
    expect(geometry.meter!.right).toBeLessThanOrEqual(geometry.follow.left + 0.5);
    expect(geometry.follow.right).toBeLessThanOrEqual(geometry.cost!.left + 0.5);
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
    const geometry = await readStrip(page);
    expect(geometry.meter!.left).toBeGreaterThanOrEqual(geometry.cluster!.left - 0.5);
    expect(geometry.overflows).toBe(false);
  });

  test("the widest follow-state label still leaves the cost legible just above the cutoff", async ({ page }) => {
    // `previewing` renders "Previewing, Follow Live Output" — about 20px wider than the "Paused"
    // the other specs produce — and it is what the cutoff has to be budgeted against. Reaching that
    // state needs a semantic-navigation reveal the usage fixture does not model, and the property
    // under test is the label's WIDTH, so the spec substitutes the text directly.
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto("/session-usage-e2e.html?width=600&height=780&cost=12345.67");
    await expect(page.locator(".follow-tail-chip")).toBeVisible();
    await page.mouse.move(300, 300);
    await page.mouse.wheel(0, -900);
    await expect(page.locator(".follow-tail-chip")).toContainText("Follow Live Output");

    const paused = await page.locator(".follow-tail-chip").evaluate((chip) => chip.getBoundingClientRect().width);
    await page.locator(".follow-tail-chip span").first().evaluate((label) => { label.textContent = "Previewing"; });
    const previewing = await page.locator(".follow-tail-chip").evaluate((chip) => chip.getBoundingClientRect().width);
    // Guard the premise: if the states ever converge, this spec stops testing anything.
    expect(previewing).toBeGreaterThan(paused + 10);

    // Above the cutoff the hint is still offered, and the widest centre control must not push the
    // cost below its own width. Calibrated on "Paused" this had ~2px of margin at 561px.
    await expect(page.locator(".transcript-status-actions")).toBeVisible();
    const legible = await page.locator(".transcript-status-usage .session-cost-button").evaluate((button) => ({
      visible: button.getBoundingClientRect().width,
      needed: button.scrollWidth,
    }));
    expect(legible.visible).toBeGreaterThanOrEqual(legible.needed - 0.5);

    // 580px sits between the cutoff calibrated on "Paused" (~556px) and the one budgeted for the
    // widest label (590px), so this is what actually fails if the budget regresses to the narrower
    // figure — the 600px pane above is inside neither cutoff and would pass either way.
    await page.goto("/session-usage-e2e.html?width=580&height=780&cost=12345.67");
    await expect(page.locator(".follow-tail-chip")).toBeVisible();
    await expect(page.locator(".transcript-status-actions")).toBeHidden();
  });

  test("the trailing usage track protects cost from Reply where the cutoff cannot run", async ({ page }) => {
    // Defence in depth, not a supported-engine requirement. When this was written the declared
    // browser floor was below the first version with size container queries, so the cutoff was
    // genuinely inert on a targeted engine; #914 has since raised the floor above it, and every
    // engine the bundle is now compiled for runs the cutoff. The guarantee does not depend on that:
    // whenever the cutoff does not apply — a future floor change, a rule lost to a stylesheet edit —
    // the trailing grid cell must still clip its optional hint without extending left across the
    // centered status cluster. Neutralising the cutoff is how that is exercised on its own.
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto("/session-usage-e2e.html?width=440&height=780&cost=12345.67");
    await page.addStyleTag({
      content: "@container transcript-pane (max-width: 99999px) { .transcript-status-actions { display: flex !important; } }",
    });
    await expect(page.locator(".follow-tail-chip")).toBeVisible();
    await page.mouse.move(220, 300);
    await page.mouse.wheel(0, -900);
    await expect(page.locator(".follow-tail-chip")).toContainText("Follow Live Output");

    const geometry = await page.locator(".transcript-status-strip").evaluate((strip) => {
      const button = strip.querySelector(".transcript-status-usage .session-cost-button") as HTMLElement;
      const actions = strip.querySelector(".transcript-status-actions") as HTMLElement;
      const follow = strip.querySelector(".follow-tail-chip") as HTMLElement;
      return {
        costRight: button.getBoundingClientRect().right,
        actionsLeft: actions.getBoundingClientRect().left,
        costVisible: button.getBoundingClientRect().width,
        costNeeded: button.scrollWidth,
        followCenter: follow.getBoundingClientRect().left + follow.getBoundingClientRect().width / 2,
        stripCenter: strip.getBoundingClientRect().left + strip.getBoundingClientRect().width / 2,
        overflows: strip.scrollWidth > strip.clientWidth,
      };
    });
    const costFraction = geometry.costVisible / geometry.costNeeded;
    expect(costFraction).toBeGreaterThan(0.9);
    expect(geometry.costRight).toBeLessThanOrEqual(geometry.actionsLeft + 0.5);
    expect(Math.abs(geometry.followCenter - geometry.stripCenter)).toBeLessThanOrEqual(1);
    expect(geometry.overflows).toBe(false);
  });

  test("an unpriced ledger keeps the placeholder and names itself in the popover", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.goto("/session-usage-e2e.html?width=1180&height=780&cost=none");

    const cost = page.getByRole("button", { name: "Session Usage: Cost Unavailable" });
    await cost.click();
    const usage = page.locator(".session-usage-popover").first();
    await expect(usage).toContainText("Not Priced");
    // The ledger has now answered "unpriced": the strip still refuses to invent a $0.00, and the
    // control remains in the centered track when the panel opens.
    await expect(cost).toHaveText("$\u2014");
    const geometry = await readStrip(page);
    expect(geometry.follow.right).toBeLessThanOrEqual(geometry.cost!.left + 0.5);
    expect(geometry.cost!.right).toBeLessThanOrEqual(geometry.actions!.left + 0.5);
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

for (const viewport of [
  { name: "desktop", width: 1200, pane: 1180, height: 820 },
  { name: "mobile", width: 390, pane: 390, height: 844 },
] as const) {
  test(`${viewport.name}: usage presence and width never move the live-output control`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const contexts = [
      { name: "known", query: "", present: true },
      { name: "unknown", query: "&window=none", present: false },
    ] as const;
    const costs = [
      { name: "priced", query: "", present: true },
      { name: "wide priced", query: "&cost=12345.67", present: true },
      { name: "unpriced", query: "&cost=none", present: true },
      { name: "unavailable", query: "&cost=unavailable", present: true },
      { name: "absent", query: "&usage=absent", present: false },
    ] as const;

    let invariantCenter: number | null = null;
    for (const context of contexts) {
      for (const cost of costs) {
        await page.goto(
          `/session-usage-e2e.html?width=${viewport.pane}&height=780${context.query}${cost.query}`,
        );
        const strip = page.locator(".transcript-status-strip");
        const meter = strip.locator(".context-ring-button");
        const usage = strip.locator(".transcript-status-usage");
        await expect(meter, `${context.name} context capacity`).toHaveCount(context.present ? 1 : 0);
        await expect(usage, `${cost.name} session cost`).toHaveCount(cost.present ? 1 : 0);

        const geometry = await strip.evaluate((element) => {
          const stripBox = element.getBoundingClientRect();
          const followBox = element.querySelector(".follow-tail-chip")!.getBoundingClientRect();
          const meterBox = element.querySelector(".context-ring-button")?.getBoundingClientRect();
          const costBox = element.querySelector(".transcript-status-usage")?.getBoundingClientRect();
          return {
            stripCenter: stripBox.left + stripBox.width / 2,
            followCenter: followBox.left + followBox.width / 2,
            followLeft: followBox.left,
            followRight: followBox.right,
            meterRight: meterBox?.right ?? null,
            costLeft: costBox?.left ?? null,
            overflows: element.scrollWidth > element.clientWidth,
          };
        });

        invariantCenter ??= geometry.followCenter;
        expect(
          Math.abs(geometry.followCenter - geometry.stripCenter),
          `${context.name} context with ${cost.name} cost`,
        ).toBeLessThanOrEqual(1);
        expect(geometry.followCenter).toBeCloseTo(invariantCenter, 1);
        if (geometry.meterRight !== null) {
          expect(geometry.meterRight).toBeLessThanOrEqual(geometry.followLeft + 0.5);
          expect(geometry.followLeft - geometry.meterRight).toBeLessThanOrEqual(8.5);
        }
        if (geometry.costLeft !== null) {
          expect(geometry.followRight).toBeLessThanOrEqual(geometry.costLeft + 0.5);
          expect(geometry.costLeft - geometry.followRight).toBeLessThanOrEqual(8.5);
        }
        expect(geometry.overflows).toBe(false);
      }
    }

    // Exercise the short following label, paused resume affordance, and widest previewing shape.
    await page.goto(`/session-usage-e2e.html?width=${viewport.pane}&height=780`);
    const follow = page.locator(".follow-tail-chip");
    const readOffset = () => page.locator(".transcript-status-strip").evaluate((strip) => {
      const stripBox = strip.getBoundingClientRect();
      const followBox = strip.querySelector(".follow-tail-chip")!.getBoundingClientRect();
      return followBox.left + followBox.width / 2 - (stripBox.left + stripBox.width / 2);
    });
    expect(Math.abs(await readOffset())).toBeLessThanOrEqual(1);
    await page.locator(".detail-scroll").hover();
    await page.mouse.wheel(0, -900);
    await expect(follow).toHaveAttribute("data-follow-tail-state", "paused");
    expect(Math.abs(await readOffset())).toBeLessThanOrEqual(1);
    await follow.locator("span").first().evaluate((label) => { label.textContent = "Previewing"; });
    expect(Math.abs(await readOffset())).toBeLessThanOrEqual(1);
  });
}

test("mobile: the ring and per-turn usage stay reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/session-usage-e2e.html?width=390&height=800");
  await expect(page.locator(".tl-turn-usage").first()).toBeVisible();
  await page.screenshot({ path: `${SHOT}/mobile-turn-usage.png` });
});

test("mobile: context and cost sit beside Live Output, and cost opens Session Usage", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/session-usage-e2e.html?width=390&height=800");

  const strip = page.locator(".transcript-status-strip").first();
  const trailing = strip.locator(".transcript-status-usage");
  await expect(trailing).toBeVisible();
  await expect(trailing).toHaveText("$1.37");
  // The cost remains its own control rather than repeating the context meter (#781).
  await expect(trailing).not.toContainText("context");
  await expect(strip.locator(".context-ring-button")).toBeVisible();
  await page.screenshot({ path: `${SHOT}/mobile-status-strip.png` });

  // Context and cost directly flank the independently centered follow-output control.
  const cluster = strip.locator(".transcript-status-cluster");
  const clusterBox = (await cluster.boundingBox())!;
  const follow = strip.locator(".follow-tail-chip");
  const followBox = (await follow.boundingBox())!;
  const costBox = (await trailing.boundingBox())!;
  const ringBox = (await strip.locator(".context-ring-button").boundingBox())!;
  expect(ringBox.x + ringBox.width).toBeLessThanOrEqual(followBox.x + 1);
  expect(followBox.x - (ringBox.x + ringBox.width)).toBeLessThanOrEqual(9);
  expect(followBox.x + followBox.width).toBeLessThanOrEqual(costBox.x + 1);
  expect(costBox.x - (followBox.x + followBox.width)).toBeLessThanOrEqual(9);
  expect(Math.abs(clusterBox.x + clusterBox.width / 2 - 195)).toBeLessThanOrEqual(1);
  expect(Math.abs(followBox.x + followBox.width / 2 - 195)).toBeLessThanOrEqual(1);
  expect(ringBox.x).toBeGreaterThan(8);
  expect(costBox.x + costBox.width).toBeLessThan(382);

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

test("mobile: widest status labels stay inside a 320px strip", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/session-usage-e2e.html?width=320&height=800&cost=12345.67");
  await pinWidestFace(page, page.locator(".transcript-status-strip"));
  await page.locator(".follow-tail-chip span").first().evaluate((label) => {
    label.textContent = "Previewing · Follow Live Output";
  });

  const geometry = await page.locator(".transcript-status-strip").evaluate((strip) => {
    const box = strip.getBoundingClientRect();
    const cluster = strip.querySelector(".transcript-status-cluster")!.getBoundingClientRect();
    const meter = strip.querySelector(".context-ring-button")!.getBoundingClientRect();
    const cost = strip.querySelector(".transcript-status-usage") as HTMLElement;
    const costBox = cost.getBoundingClientRect();
    return {
      strip: { left: box.left, right: box.right },
      cluster: { left: cluster.left, right: cluster.right },
      meter: { left: meter.left, right: meter.right },
      follow: {
        left: strip.querySelector(".follow-tail-chip")!.getBoundingClientRect().left,
        right: strip.querySelector(".follow-tail-chip")!.getBoundingClientRect().right,
        center: strip.querySelector(".follow-tail-chip")!.getBoundingClientRect().left
          + strip.querySelector(".follow-tail-chip")!.getBoundingClientRect().width / 2,
      },
      cost: { left: costBox.left, right: costBox.right, width: costBox.width, needed: cost.scrollWidth },
      overflows: strip.scrollWidth > strip.clientWidth,
    };
  });

  expect(geometry.cluster.left).toBeGreaterThanOrEqual(geometry.strip.left - 0.5);
  expect(geometry.cluster.right).toBeLessThanOrEqual(geometry.strip.right + 0.5);
  // The independently centered widest label may consume some decorative strip padding, but every
  // control remains fully inside the strip and the page still has no horizontal overflow.
  expect(geometry.meter.left).toBeGreaterThanOrEqual(geometry.strip.left - 0.5);
  expect(geometry.meter.right).toBeLessThanOrEqual(geometry.follow.left + 0.5);
  expect(geometry.follow.right).toBeLessThanOrEqual(geometry.cost.left + 0.5);
  expect(geometry.cost.right).toBeLessThanOrEqual(geometry.strip.right + 0.5);
  expect(Math.abs(geometry.follow.center - (geometry.strip.left + geometry.strip.right) / 2))
    .toBeLessThanOrEqual(1);
  expect(geometry.cost.width).toBeGreaterThan(0);
  expect(geometry.overflows).toBe(false);
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
