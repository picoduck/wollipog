import { expect, test, type Page } from "@playwright/test";
import { pinWidestFace } from "./font-geometry";

/**
 * Session-level usage (#602, #781): per-turn tokens and cost on the user message, the context ring
 * with its occupancy-only popover, and the separate session-cost control whose Session Usage
 * popover owns cumulative tokens and the per-model breakdown. Both triggers live in the composer
 * bar, or in Model Settings when the bar has no room for them (#2166). Screenshots land in
 * `test-results/session-usage/` as the PR's visual evidence.
 */

test.use({ reducedMotion: "reduce" });
const SHOT = "test-results/session-usage";

/**
 * The composer bar and its usage triggers, read in one pass so the boxes are mutually consistent.
 * `rows` counts the distinct vertical centres of the bar's visible controls; `trailing` is the first
 * control after the cost (the mic, or Send where dictation is unsupported).
 */
const readBar = (page: Page) =>
  page.locator(".composer-bar").evaluate((bar) => {
    const box = (element: Element | null | undefined) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
    };
    const controls = [...bar.querySelectorAll(":scope > * > *")]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const cost = bar.querySelector(".session-usage");
    let trailing = cost?.nextElementSibling ?? null;
    while (trailing && trailing.getBoundingClientRect().width === 0) trailing = trailing.nextElementSibling;
    return {
      box: box(bar)!,
      meter: box(bar.querySelector(".context-control")),
      cost: box(cost),
      trailing: box(trailing),
      rows: new Set(controls.map((rect) => Math.round(rect.top + rect.height / 2))).size,
      overflow: bar.scrollWidth - bar.clientWidth,
    };
  });

test("desktop: Parent Control exposes five independent typed workflow authorities", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/session-usage-e2e.html?width=1180&height=860&composer=orchestrator");
  await page.getByRole("button", { name: "Add and Modes" }).click();

  await expect(page.getByRole("button", { name: "Implementation Questions: Orchestrator" })).toBeVisible();
  await expect(page.getByRole("button", { name: "PR Merge Approval: Human" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Merged Branch Deletion: Human" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Follow-Up Issue Publication: Orchestrator" })).toBeVisible();
  await expect(page.getByRole("button", { name: "UI Evidence Approval: Human" })).toBeVisible();
  await expect(page.getByText(/provider may retain images in provider-local transcripts or media logs/)).toBeVisible();
  await expect(page.getByText(/Existing unconsumed approvals are revoked/)).toBeVisible();
  await page.getByText(/provider may retain images in provider-local transcripts or media logs/).scrollIntoViewIfNeeded();
  await page.locator('.menu[aria-label="Session Attachments, Modes, and Guardrails"]').evaluate((menu) => { menu.scrollTop = menu.scrollHeight; });
  await page.locator('.menu[aria-label="Session Attachments, Modes, and Guardrails"]').screenshot({ path: `${SHOT}/desktop-typed-parent-control.png` });
});

for (const viewport of [
  { name: "desktop", width: 1200, height: 900, fixtureWidth: 1180, fixtureHeight: 860 },
  { name: "mobile", width: 393, height: 844, fixtureWidth: 393, fixtureHeight: 844 },
] as const) {
  test(`${viewport.name}: active campaign summary exposes status, revision, progress, and compatibility`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`/session-usage-e2e.html?width=${viewport.fixtureWidth}&height=${viewport.fixtureHeight}&composer=orchestrator&campaign-state=off`);
    await page.getByRole("button", { name: "Add and Modes" }).click();
    const beforeSummary = page.locator('.menu[aria-label="Session Attachments, Modes, and Guardrails"] .active-campaign-policy');
    await expect(beforeSummary).toBeVisible();
    await expect(beforeSummary.getByText("Campaign Status", { exact: true })).toHaveCount(0);
    await beforeSummary.getByText("Child Model", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT}/${viewport.name}-campaign-before.png` });

    await page.goto(`/session-usage-e2e.html?width=${viewport.fixtureWidth}&height=${viewport.fixtureHeight}&composer=orchestrator`);
    await page.getByRole("button", { name: "Add and Modes" }).click();

    const menu = page.locator('.menu[aria-label="Session Attachments, Modes, and Guardrails"]');
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

  const ring = page.locator(".context-control > button").first();
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
  await expect(protocolDetail).toContainText("before the machine's Wollipog update includes only the final response");

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

  await expect(page.locator(".context-control > button")).toHaveCount(0);
  const cost = page.getByRole("button", { name: "Session Usage: $1.37" });
  await expect(cost).toBeVisible();
  // With no meter the cost alone keeps its seat before the mic, and no gap is left for the ring.
  const geometry = await readBar(page);
  expect(geometry.meter).toBeNull();
  expect(geometry.cost!.right).toBeLessThanOrEqual(geometry.trailing!.left);
  await cost.click();
  await expect(page.locator(".session-usage-popover").first()).toContainText("Total Processed");
  await page.screenshot({ path: `${SHOT}/desktop-unknown-context.png` });
});

test("the warning state above the threshold", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/session-usage-e2e.html?width=1180&height=780&used=186000&driver=claude-code");
  const meter = page.locator(".composer-bar .context-control");
  await expect(meter).toHaveClass(/t-danger/);
  await expect(page.locator(".context-control > button").first()).toHaveAttribute("aria-label", /93% Used/);
  await page.locator(".context-control > button").first().click();
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

  // Answer Mode replaces the composer bar, Model Settings included, so the figures come with it
  // (#2166): beside Submit in a wide column, on their own row above the buttons on a phone.
  for (const viewport of [
    { name: "desktop", width: 1200, height: 820, frame: 1180, ownRow: false },
    { name: "phone", width: 390, height: 844, frame: 390, ownRow: true },
  ] as const) {
    test(`${viewport.name}: context and cost stay in reach while answering`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`/session-usage-e2e.html?width=${viewport.frame}&height=${viewport.height - 40}&approval=question&driver=claude-code`);
      await expect(page.getByText("Answer Mode", { exact: true })).toBeVisible();
      await expect(page.locator(".composer-bar")).toHaveCount(0);

      const usage = page.locator(".composer-answer-usage");
      const ring = usage.getByRole("button", { name: "Context Window 36% Used" });
      const cost = usage.getByRole("button", { name: "Session Usage: $1.37" });
      await expect(ring).toBeVisible();
      await expect(cost).toBeVisible();
      const [usageBox, actionsBox, submitBox] = await Promise.all([
        usage.boundingBox(),
        page.locator(".composer-answer-actions").boundingBox(),
        page.getByRole("button", { name: "Submit Answers" }).boundingBox(),
      ]);
      if (viewport.ownRow) {
        expect(usageBox!.y + usageBox!.height).toBeLessThanOrEqual(actionsBox!.y + 0.5);
        expect(usageBox!.x + usageBox!.width).toBeCloseTo(actionsBox!.x + actionsBox!.width, 0);
      } else {
        expect(usageBox!.x + usageBox!.width).toBeLessThanOrEqual(submitBox!.x);
        expect(Math.abs((usageBox!.y + usageBox!.height / 2) - (submitBox!.y + submitBox!.height / 2))).toBeLessThan(2);
      }
      await page.locator(".composer-box").screenshot({ path: `${SHOT}/answer-mode-usage-${viewport.name}.png` });

      await cost.click();
      await expect(page.locator(".session-usage-popover")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".session-usage-popover")).toHaveCount(0);
      await expect(page.getByText("Answer Mode", { exact: true })).toBeVisible();
    });
  }
});

/**
 * Live usage sits in the composer bar's trailing cluster (#2166): the context ring, then the cost,
 * just before the mic. The bar never wraps, so on a phone or in a composer column under 640px the
 * two triggers leave it, and Model Settings opens with a read-only Session Usage group instead.
 */
test.describe("desktop: context and cost sit in the composer bar before the mic", () => {
  for (const viewport of [
    { name: "1440", width: 1440, height: 900, frame: 1360 },
    { name: "834", width: 834, height: 1000, frame: 774 },
  ] as const) {
    test(`at ${viewport.name}px both triggers open their popovers and Escape closes each`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`/session-usage-e2e.html?width=${viewport.frame}&height=${viewport.height - 40}&driver=claude-code`);

      const ring = page.locator(".composer-bar .cbar-right").getByRole("button", { name: "Context Window 36% Used" });
      const cost = page.locator(".composer-bar .cbar-right").getByRole("button", { name: "Session Usage: $1.37" });
      await expect(ring).toBeVisible();
      await expect(cost).toHaveText("$1.37");
      await expect(page.locator("[class*='transcript-status']")).toHaveCount(0);
      // One seat each: the bar holds them, and Model Settings does not repeat them.
      await expect(page.getByRole("button", { name: /^Context Window .* Used$/ })).toHaveCount(1);
      await expect(page.getByRole("button", { name: /^Session Usage: / })).toHaveCount(1);

      const bar = await readBar(page);
      expect(bar.rows, "the bar's controls share one row").toBe(1);
      expect(bar.overflow).toBeLessThanOrEqual(0);
      expect(bar.meter!.right).toBeLessThanOrEqual(bar.cost!.left);
      expect(bar.cost!.right).toBeLessThanOrEqual(bar.trailing!.left);
      // Borderless small ghost buttons in the small type, dim until hovered.
      const look = await ring.evaluate((element) => {
        const style = getComputedStyle(element);
        return { border: style.borderTopColor, fontSize: style.fontSize, fontWeight: style.fontWeight, height: element.getBoundingClientRect().height };
      });
      expect(look.border).toBe("rgba(0, 0, 0, 0)");
      expect(look.fontSize).toBe("12px");
      expect(look.fontWeight).toBe("400");
      expect(look.height).toBe(28);
      expect(await ring.locator("svg").getAttribute("width")).toBe("14");
      await page.locator(".composer-box").screenshot({ path: `${SHOT}/composer-bar-${viewport.name}.png` });

      await ring.click();
      const context = page.locator(".context-popover");
      await expect(context).toContainText("Capacity");
      await page.keyboard.press("Escape");
      await expect(context).toHaveCount(0);
      // Escape closed only the popover (#1796): the session and its composer are still here.
      await expect(ring).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator(".composer-box")).toBeVisible();

      await cost.click();
      const usage = page.locator(".session-usage-popover");
      await expect(usage).toContainText("Total Processed");
      // Opening upward from the bar, it stays on screen.
      const usageBox = (await usage.boundingBox())!;
      expect(usageBox.y).toBeGreaterThanOrEqual(0);
      expect(usageBox.y + usageBox.height).toBeLessThanOrEqual(viewport.height);
      await page.keyboard.press("Escape");
      await expect(usage).toHaveCount(0);
      await expect(cost).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator(".composer-box")).toBeVisible();

      // While the bar shows them, Model Settings opens on its model choices with no usage group.
      await page.getByRole("button", { name: /^Model Settings/ }).click();
      const menu = page.getByRole("menu", { name: "Model Settings" });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("group", { name: "Session Usage" })).toHaveCount(0);
    });
  }

  /** Every shape `sessionCostLabel` can produce, widest to narrowest. */
  const LABELS = [
    { name: "a short priced", query: "", text: "$1.37" },
    { name: "a long priced", query: "&cost=12345.67", text: "$12,345.67" },
    { name: "a sub-cent priced", query: "&cost=0.0007", text: "$0.0007" },
    { name: "an unavailable", query: "&cost=none", text: "$—" },
  ];
  for (const label of LABELS) {
    test(`${label.name} cost fits the bar beside the ring`, async ({ page }) => {
      await page.setViewportSize({ width: 1200, height: 820 });
      await page.goto(`/session-usage-e2e.html?width=1180&height=780${label.query}`);
      const cost = page.locator(".composer-bar .cbar-usage").filter({ hasText: label.text });
      await expect(cost).toHaveText(label.text);
      const legible = await cost.evaluate((button) => ({ visible: button.clientWidth, needed: button.scrollWidth }));
      expect(legible.visible).toBeGreaterThanOrEqual(legible.needed);
      const bar = await readBar(page);
      expect(bar.rows).toBe(1);
      expect(bar.overflow).toBeLessThanOrEqual(0);
    });
  }

  test("a session without usage yet shows neither trigger and leaves no gap", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.goto("/session-usage-e2e.html?width=1180&height=780&usage=absent&used=0");
    await expect(page.locator(".composer-bar")).toBeVisible();
    await expect(page.locator(".composer-bar :is(.context-control, .session-usage)")).toHaveCount(0);
    const gap = await page.locator(".cbar-right").evaluate((cluster) => {
      const first = [...cluster.children].find((child) => child.getBoundingClientRect().width > 0)!;
      return first.getBoundingClientRect().left - cluster.getBoundingClientRect().left;
    });
    expect(gap).toBeCloseTo(0, 1);
  });

  test("the reader runs to the composer card: nothing sits between them", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/session-usage-e2e.html?width=1360&height=860");
    await expect(page.locator("[data-virtual-row]").first()).toBeVisible();
    const [reader, composer] = await Promise.all([
      page.locator(".detail-reader").boundingBox(),
      page.locator(".composer").boundingBox(),
    ]);
    expect(composer!.y).toBeCloseTo(reader!.y + reader!.height, 0);
  });

  test("reading away from the tail never moves the triggers", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.goto("/session-usage-e2e.html?width=1180&height=780");
    const followState = page.locator(".detail-scroll[data-follow-tail-state]");
    await expect(followState).toHaveAttribute("data-follow-tail-state", "following");
    const following = await readBar(page);
    await page.locator(".detail-scroll").hover();
    await page.mouse.wheel(0, -900);
    await expect(followState).toHaveAttribute("data-follow-tail-state", "paused");
    await expect(page.locator(".transcript-tail-anchor > .transcript-tail-control")).toBeVisible();
    const paused = await readBar(page);
    expect(paused.meter!.left).toBeCloseTo(following.meter!.left, 1);
    expect(paused.cost!.left).toBeCloseTo(following.cost!.left, 1);
  });
});

test.describe("a composer column under 640px moves the figures into Model Settings", () => {
  test("at a desktop width, beside a narrow pane", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.goto("/session-usage-e2e.html?width=600&height=780&driver=claude-code");
    await expect(page.locator(".composer-bar")).toBeVisible();
    await expect(page.locator(".composer-bar :is(.context-control, .session-usage)")).toHaveCount(0);
    const bar = await readBar(page);
    expect(bar.rows).toBe(1);
    expect(bar.overflow).toBeLessThanOrEqual(0);

    await page.getByRole("button", { name: /^Model Settings/ }).click();
    const menu = page.getByRole("menu", { name: "Model Settings" });
    const group = menu.getByRole("group", { name: "Session Usage" });
    await expect(group).toBeVisible();
    await expect(group).toContainText("Context Window");
    await expect(group).toContainText("36%");
    await expect(group).toContainText("72K of 200K");
    await expect(group).toContainText("Session Cost");
    await expect(group).toContainText("$1.37");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  test("an agent without Model Settings keeps the figures in the bar", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.goto("/session-usage-e2e.html?width=600&height=780");
    await expect(page.getByRole("button", { name: /^Model Settings/ })).toHaveCount(0);
    await expect(page.locator(".composer-bar").getByRole("button", { name: "Session Usage: $1.37" })).toBeVisible();
    const bar = await readBar(page);
    expect(bar.rows).toBe(1);
    expect(bar.overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("the Reply keycap with a fine pointer", () => {
  test("the idle composer shows R, and R from the reader focuses the composer at the end of the draft", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/session-usage-e2e.html?width=1360&height=860");
    const keycap = page.locator(".composer-reply-hint kbd");
    const input = page.locator(".composer-input");
    await expect(keycap).toHaveText("R");
    // At the end of the placeholder's row, which it does not displace.
    const [cap, field] = await Promise.all([keycap.boundingBox(), input.boundingBox()]);
    expect(cap!.x + cap!.width).toBeCloseTo(field!.x + field!.width, 0);
    expect(cap!.y).toBeGreaterThanOrEqual(field!.y);
    expect(cap!.y + cap!.height).toBeLessThanOrEqual(field!.y + 24);
    await expect(input).toHaveAttribute("placeholder", "Do anything");
    await page.locator(".composer-box").screenshot({ path: `${SHOT}/composer-reply-keycap.png` });

    await page.getByRole("region", { name: "Session Activity" }).focus();
    await page.keyboard.press("r");
    await expect(input).toBeFocused();
    await expect(keycap).toHaveCount(0);
  });

  test("with a draft, R places the caret at its end", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/session-usage-e2e.html?width=1360&height=860&draft=Half%20a%20thought");
    const input = page.locator(".composer-input");
    await expect(input).toHaveValue("Half a thought");
    // A draft replaces the placeholder, and with it the keycap.
    await expect(page.locator(".composer-reply-hint")).toHaveCount(0);
    await page.getByRole("region", { name: "Session Activity" }).focus();
    await page.keyboard.press("r");
    await expect(input).toBeFocused();
    expect(await input.evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd]))
      .toEqual([14, 14]);
  });
});

test("mobile: the ring and per-turn usage stay reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/session-usage-e2e.html?width=390&height=800");
  await expect(page.locator(".tl-turn-usage").first()).toBeVisible();
  await page.screenshot({ path: `${SHOT}/mobile-turn-usage.png` });
});

test("mobile: Model Settings opens with the Session Usage group, and the bar stays one row", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/session-usage-e2e.html?width=390&height=800&driver=claude-code");
  await expect(page.locator(".composer-bar")).toBeVisible();
  await expect(page.locator(".composer-bar :is(.context-control, .session-usage)")).toHaveCount(0);
  // The idle phone composer is a pill; opening it shows Model Settings in the bar.
  await page.getByRole("button", { name: /^Edit Message/ }).click();
  const bar = await readBar(page);
  expect(bar.rows, "the bar's controls share one row").toBe(1);
  expect(bar.overflow).toBeLessThanOrEqual(0);

  await page.getByRole("button", { name: /^Model Settings/ }).click();
  const menu = page.getByRole("menu", { name: "Model Settings" });
  const group = menu.getByRole("group", { name: "Session Usage" });
  await expect(group).toBeVisible();
  // First in the sheet, ahead of the model choices.
  const order = await menu.evaluate((sheet) => [...sheet.querySelectorAll('[role="group"]')].map((element) => element.getAttribute("aria-label")));
  expect(order[0]).toBe("Session Usage");
  await expect(group.locator("dt")).toHaveText(["Context Window", "Session Cost"]);
  await expect(group.locator("dd").first()).toHaveText("36%72K of 200K");
  await expect(group.locator("dd").last()).toHaveText("$1.37");
  await page.screenshot({ path: `${SHOT}/mobile-model-settings-usage.png` });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("mobile: without Model Settings the figures keep their bar seats, and cost opens Session Usage", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/session-usage-e2e.html?width=390&height=800");

  const cost = page.locator(".composer-bar").getByRole("button", { name: "Session Usage: $1.37" });
  await expect(cost).toHaveText("$1.37");
  // The cost remains its own control rather than repeating the context meter (#781).
  await expect(cost).not.toContainText("context");
  await expect(page.locator(".composer-bar").getByRole("button", { name: /^Context Window/ })).toBeVisible();
  const bar = await readBar(page);
  expect(bar.rows).toBe(1);
  expect(bar.overflow).toBeLessThanOrEqual(0);

  await cost.click();
  const usage = page.locator(".session-usage-popover").first();
  await expect(usage).toBeVisible();
  await expect(usage).toContainText("Input");
  await expect(usage).toContainText("Output");
  const protocolInfo = usage.getByRole("button", { name: "About Codex App Server Usage" });
  const protocolDetail = usage.locator(".session-usage-info-detail");
  await expect(protocolDetail).toBeHidden();
  await protocolInfo.click();
  await expect(protocolDetail).toBeVisible();
  await expect(protocolDetail).toContainText("Usage recorded since then counts every response.");
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
  await page.keyboard.press("Escape");
  await expect(usage).toHaveCount(0);
});

test.describe("with a touch pointer", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("mobile: the pricing source link is a 44px touch target inside the popover", async ({ page }) => {
    // #1799: an inline link gets a 44px band centred on its line from the one coarse-pointer block.
    await page.goto("/session-usage-e2e.html?width=390&height=800");
    await page.locator(".composer-bar").getByRole("button", { name: /^Session Usage: / }).click();
    const usage = page.locator(".session-usage-popover").first();
    const link = usage.getByRole("link", { name: "Estimated API Costs" });
    await expect(link).toBeVisible();
    const band = await link.evaluate((element) => {
      element.scrollIntoView({ block: "center" });
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const middle = rect.top + rect.height / 2;
      return {
        textHeight: rect.height,
        reaches: [middle - 21, middle + 21].every((y) => element.contains(document.elementFromPoint(x, y))),
      };
    });
    expect(band.textHeight).toBeLessThan(44);
    expect(band.reaches, "the link's hit area spans 44px around its line").toBe(true);
    expect(await usage.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(await usage.evaluate((element) => element.clientWidth));
  });

  test("a coarse pointer shows no Reply keycap in the idle composer", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/session-usage-e2e.html?width=1360&height=860");
    await expect(page.locator(".composer-input")).toBeVisible();
    await expect(page.locator(".composer-reply-hint kbd")).toBeHidden();
  });
});

test("mobile: the widest figures stay inside a 320px composer bar", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/session-usage-e2e.html?width=320&height=800&cost=12345.67");
  await pinWidestFace(page, page.locator(".composer-bar"));
  const cost = page.locator(".composer-bar").getByRole("button", { name: "Session Usage: $12,345.67" });
  await expect(cost).toBeVisible();
  const legible = await cost.evaluate((button) => ({ visible: button.clientWidth, needed: button.scrollWidth }));
  expect(legible.visible).toBeGreaterThanOrEqual(legible.needed);
  const bar = await readBar(page);
  expect(bar.rows).toBe(1);
  expect(bar.overflow).toBeLessThanOrEqual(0);
  expect(bar.meter!.left).toBeGreaterThanOrEqual(bar.box.left - 0.5);
  expect(bar.cost!.right).toBeLessThanOrEqual(bar.box.right + 0.5);
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
