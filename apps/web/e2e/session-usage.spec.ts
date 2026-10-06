import { expect, test, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion";
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

/** Every visible control in the composer card, checked pairwise for overlap. */
const composerOverlaps = (page: Page) =>
  page.locator(".composer-box").evaluate((card) => {
    const rects = [...card.querySelectorAll(".composer-bar > * > *, .composer-usage-row > *, .answer-foot > :not(.composer-answer-usage), .composer-answer-usage > *")]
      .map((element) => ({ name: element.className, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0);
    const overlaps: string[] = [];
    const box = card.getBoundingClientRect();
    for (const [index, a] of rects.entries()) {
      if (a.rect.left < box.left - 0.5 || a.rect.right > box.right + 0.5) overlaps.push(`${a.name} leaves the card`);
      for (const b of rects.slice(index + 1)) {
        if (a.rect.left < b.rect.right - 0.5 && b.rect.left < a.rect.right - 0.5
          && a.rect.top < b.rect.bottom - 0.5 && b.rect.top < a.rect.bottom - 0.5) overlaps.push(`${a.name} × ${b.name}`);
      }
    }
    return overlaps;
  });

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

test("a cost checkpoint parks the session with its Budget card docked above the composer", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/session-usage-e2e.html?width=1180&height=780&approval=checkpoint");
  await expect(page.locator(".approval-bar")).toHaveCount(0);
  const card = page.locator(".request-dock").getByRole("region", { name: "Cost checkpoint — $2.61 of $2.50. Continue?" });
  await expect(card).toHaveAttribute("data-request-kind", "budget");
  const foot = card.locator(".request-card-foot");
  await expect(foot.getByRole("button")).toHaveText([/^Stop/u, /^Continue/u]);
  await page.screenshot({ path: `${SHOT}/desktop-checkpoint-card.png` });
});

/**
 * Composer Response (#2212): the question shows once, as the dock's compact card while it waits and
 * in the composer while it is answered. Show Context shrinks the answer to its head.
 */
test.describe("Composer Response shows a question once", () => {
  const answerUrl = (width: number, height: number, extra = "") =>
    `/session-usage-e2e.html?width=${width}&height=${height}&approval=question${extra}`;

  test("waiting is the compact card, answering is the composer, and never both", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    // A kept message draft holds the question on the dock instead of opening Answer Mode.
    await page.goto(answerUrl(1180, 780, "&draft=Kept%20draft"));
    const card = page.locator(".request-dock .question-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Your message draft is kept while you answer.");
    await expect(page.locator(".composer-answer")).toHaveCount(0);
    await expect(page.locator(".composer-input")).toHaveValue("Kept draft");

    await card.getByRole("button", { name: "Answer", exact: true }).click();
    await expect(page.locator(".composer-answer")).toBeVisible();
    await expect(page.locator(".question-card")).toHaveCount(0);
    await expect(page.locator(".composer-answer-input")).toBeFocused();
    // The head: the kind, then Show Context and a 28px × named Exit Answer Mode.
    await expect(page.locator(".answer-kind")).toHaveText("Question");
    const exit = page.getByRole("button", { name: "Exit Answer Mode", exact: true });
    const exitBox = (await exit.boundingBox())!;
    expect(Math.round(exitBox.width)).toBe(28);
    expect(Math.round(exitBox.height)).toBe(28);

    await page.keyboard.press("Escape");
    await expect(card).toBeVisible();
    await expect(page.locator(".composer-answer")).toHaveCount(0);
    await expect(page.locator(".composer-input")).toHaveValue("Kept draft");
  });

  test("the R keycap shows on a fine pointer, and no sentence names a key", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.goto(answerUrl(1180, 780, "&draft=Kept%20draft"));
    const answer = page.locator(".request-dock").getByRole("button", { name: "Answer", exact: true });
    await expect(answer.locator("kbd")).toHaveText("R");
    await expect(answer.locator("kbd")).toBeVisible();
    await expect(page.locator(".request-dock .question-card")).not.toContainText(/Press|\/respond/);
  });

  test("at 1440px a four-option question shows whole, and the answer field reads in the reading font", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(answerUrl(1400, 860, "&questions=four"));
    const options = page.locator(".answer-options");
    await expect(options.getByRole("radio")).toHaveCount(5);
    const fits = await options.evaluate((element) => element.scrollHeight <= element.clientHeight + 1);
    expect(fits, "four options and Something Else fit under the 288px cap").toBe(true);

    const input = page.locator(".composer-answer-input");
    const fonts = await input.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.font = "var(--type-reading)";
      document.body.append(probe);
      const reading = getComputedStyle(probe);
      const field = getComputedStyle(element);
      const result = { field: field.fontFamily, reading: reading.fontFamily, fieldSize: field.fontSize, readingSize: reading.fontSize };
      probe.remove();
      return result;
    });
    expect(fonts.field).toBe(fonts.reading);
    expect(fonts.fieldSize).toBe(fonts.readingSize);
    expect(fonts.field).not.toMatch(/mono/i);
    await expect(input).toHaveAttribute("placeholder", "Type a number or an option");
  });

  test("an invalid answer turns the composer's edge red with one error and no ring on the field", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(answerUrl(1400, 860, "&questions=four"));
    const input = page.locator(".composer-answer-input");
    await input.focus();
    await input.press("Enter");
    await expect(page.locator(".field-error")).toHaveCount(1);
    await expect(page.locator(".field-error")).toHaveText("Choose an option.");
    await expect(input).toBeFocused();
    const styles = await input.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--red)";
      document.body.append(probe);
      const red = getComputedStyle(probe).color;
      probe.remove();
      const field = getComputedStyle(element);
      const card = getComputedStyle(element.closest(".composer-box")!);
      return {
        red,
        card: [card.borderTopColor, card.borderRightColor, card.borderBottomColor, card.borderLeftColor],
        outline: field.outlineStyle === "none" || field.outlineWidth === "0px",
        fieldBorder: field.borderTopStyle,
        shadow: field.boxShadow,
      };
    });
    expect(styles.card).toEqual([styles.red, styles.red, styles.red, styles.red]);
    expect(styles.outline, "no focus ring on the field inside the composer").toBe(true);
    expect(styles.fieldBorder).toBe("none");
    expect(styles.shadow).toBe("none");
  });

  test("at 390x844 Show Context leaves the transcript at least half of the chat column", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(answerUrl(390, 804, "&questions=four"));
    const options = page.locator(".answer-options");
    await expect(options).toBeVisible();
    expect((await options.boundingBox())!.height).toBeLessThanOrEqual(188.5);
    const toggle = page.getByRole("button", { name: "Show Context", exact: true });
    await expect(toggle.locator(".answer-context-label"), "icon-only below 760px, under the same name").toBeHidden();
    await toggle.click();
    await expect(page.getByRole("button", { name: "Show Answer", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".answer-summary")).toHaveText("Nothing chosen yet");
    const share = await page.evaluate(() => {
      const column = document.querySelector(".chat-reading")!.getBoundingClientRect();
      const reader = document.querySelector(".detail-scroll")!.getBoundingClientRect();
      return reader.height / column.height;
    });
    expect(share).toBeGreaterThanOrEqual(0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

test.describe("Composer Response placeholders at 390px", () => {
  // The placeholder says what to type (#2212), so it must be readable whole in a phone composer.
  for (const step of [
    { name: "a single choice", extra: "&questions=four", next: 0 },
    { name: "a single choice that takes the person's own answer", extra: "&questions=four&other=1", next: 0 },
    { name: "several choices", extra: "&questions=several", next: 1 },
    { name: "a free-text answer", extra: "&questions=several", next: 2 },
  ]) {
    test(`the placeholder for ${step.name} fits the field`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/session-usage-e2e.html?width=390&height=804&approval=question${step.extra}`);
      const input = page.locator(".composer-answer-input");
      for (let index = 0; index < step.next; index += 1) {
        await input.fill(index === 0 ? "1" : "1, 2");
        await input.press("Enter");
      }
      await expect(input).toHaveValue("");
      // Measured in the widest verified face, so a machine with a narrower one cannot pass copy that
      // another would cut off.
      const face = await pinWidestFace(page, page.locator(".composer-box"));
      const fit = await input.evaluate((element: HTMLInputElement) => {
        const style = getComputedStyle(element);
        const context = document.createElement("canvas").getContext("2d")!;
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const room = element.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
        return { text: element.placeholder, width: context.measureText(element.placeholder).width, room };
      });
      expect(fit.width, `"${fit.text}" fits in ${fit.room}px in ${face}`).toBeLessThanOrEqual(fit.room);
    });
  }
});

test.describe("Composer Response on a touch phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the R keycap is absent on a coarse pointer and the × keeps a 44px hit area", async ({ page }) => {
    await page.goto("/session-usage-e2e.html?width=390&height=804&approval=question&draft=Kept%20draft");
    const answer = page.locator(".request-dock").getByRole("button", { name: "Answer", exact: true });
    await expect(answer).toBeVisible();
    await expect(answer.locator("kbd")).toBeHidden();
    await answer.click();
    const exit = page.getByRole("button", { name: "Exit Answer Mode", exact: true });
    await expect(exit).toBeVisible();
    const hit = await exit.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const after = getComputedStyle(element, "::after");
      const width = Number.parseFloat(after.width) || box.width;
      const height = Number.parseFloat(after.height) || box.height;
      return { width: Math.max(width, box.width), height: Math.max(height, box.height), visible: box.height };
    });
    expect(hit.width).toBeGreaterThanOrEqual(44);
    expect(hit.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe("Answer Mode ownership", () => {
  test("Edit as a New Turn reveals the copied message and external resolution restores region focus", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.goto("/session-usage-e2e.html?width=1180&height=780&approval=question");

    await expect(page.locator(".composer-answer")).toBeVisible();
    await page.screenshot({ path: `${SHOT}/answer-mode-before.png` });
    const copied = (await page.locator(".tl-row.user .bubble-text").last().textContent()) ?? "";
    expect(copied).not.toBe("");
    await page.getByRole("button", { name: "Edit as a New Turn" }).last().click();
    // #2185: the message goes straight into the composer; there is no edit dialog to fill in.
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const composer = page.locator(".composer-input");
    await expect(composer).toHaveValue(copied);
    await expect(composer).toBeFocused();
    // The question waits on the dock's compact card again (#2212).
    const answer = page.locator(".request-dock").getByRole("button", { name: "Answer", exact: true });
    await expect(answer).toBeVisible();
    await page.screenshot({ path: `${SHOT}/answer-mode-after-load.png` });

    await answer.click();
    const choice = page.getByRole("radio", { name: /Staging/ });
    await choice.focus();
    await page.evaluate(() => window.resolveSessionUsageQuestion());
    await expect(composer).toBeFocused();
  });

  // Answer Mode replaces the composer bar, Model Settings included, so the figures come with it
  // (#2166): beside Submit in a wide column, on their own row above the buttons on a phone.
  for (const viewport of [
    { name: "desktop", width: 1200, height: 820, frame: 1180, ownRow: false, root: 16 },
    { name: "phone", width: 390, height: 844, frame: 390, ownRow: true, root: 16 },
    // 40rem, not 640px: twice the text in a column wide enough only at the default size.
    { name: "enlarged-text", width: 1200, height: 820, frame: 642, ownRow: true, root: 32 },
  ] as const) {
    test(`${viewport.name}: context and cost stay in reach while answering`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`/session-usage-e2e.html?width=${viewport.frame}&height=${viewport.height - 40}&approval=question&driver=claude-code`);
      if (viewport.root !== 16) await page.addStyleTag({ content: `html { font-size: ${viewport.root}px; }` });
      await expect(page.locator(".composer-answer")).toBeVisible();
      await expect(page.locator(".composer-bar")).toHaveCount(0);

      const usage = page.locator(".composer-answer-usage");
      const ring = usage.getByRole("button", { name: "Context Window 36% Used" });
      const cost = usage.getByRole("button", { name: "Session Usage: $1.37" });
      await expect(ring).toBeVisible();
      await expect(cost).toBeVisible();
      const [usageBox, actionsBox, submitBox] = await Promise.all([
        usage.boundingBox(),
        page.locator(".answer-foot").boundingBox(),
        page.getByRole("button", { name: "Submit Answers" }).boundingBox(),
      ]);
      if (viewport.ownRow) {
        expect(usageBox!.y + usageBox!.height).toBeLessThanOrEqual(actionsBox!.y + 0.5);
        expect(usageBox!.x + usageBox!.width).toBeCloseTo(actionsBox!.x + actionsBox!.width, 0);
      } else {
        expect(usageBox!.x + usageBox!.width).toBeLessThanOrEqual(submitBox!.x);
        expect(Math.abs((usageBox!.y + usageBox!.height / 2) - (submitBox!.y + submitBox!.height / 2))).toBeLessThan(2);
      }
      expect(await composerOverlaps(page)).toEqual([]);
      await page.locator(".composer-box").screenshot({ path: `${SHOT}/answer-mode-usage-${viewport.name}.png` });

      await cost.click();
      await expect(page.locator(".session-usage-popover")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".session-usage-popover")).toHaveCount(0);
      await expect(page.locator(".composer-answer")).toBeVisible();
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
      // Borderless ghost ComposerButtons, --composer-ctl tall (#2174), in the small type, dim until hovered.
      const look = await ring.evaluate((element) => {
        const style = getComputedStyle(element);
        return { border: style.borderTopColor, fontSize: style.fontSize, fontWeight: style.fontWeight, height: element.getBoundingClientRect().height };
      });
      expect(look.border).toBe("rgba(0, 0, 0, 0)");
      expect(look.fontSize).toBe("12px");
      expect(look.fontWeight).toBe("400");
      expect(look.height).toBe(32);
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
      const menu = page.getByRole("dialog", { name: "Model Settings" });
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
    // A pane short enough for the transcript to scroll: one that cannot scroll is already at its
    // tail and shows no Jump to Latest (#2526).
    await page.goto("/session-usage-e2e.html?width=1180&height=480");
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
    const menu = page.getByRole("dialog", { name: "Model Settings" });
    const group = menu.getByRole("group", { name: "Session Usage" });
    await expect(group).toBeVisible();
    await expect(group).toContainText("Context Window");
    await expect(group).toContainText("36%");
    await expect(group).toContainText("72K of 200K");
    await expect(group).toContainText("Session Cost");
    await expect(group).toContainText("$1.37");
    // The popover opens the breakdown in its own place too, never as a second floating layer (#2447).
    await group.getByRole("button", { name: "Session Cost" }).click();
    await expect(menu.locator(".menu-head-title")).toHaveText("Session Cost");
    await expect(menu.getByRole("group", { name: "Session Usage" }).locator(".session-usage-model")).toHaveCount(2);
    await expect(page.locator(".session-usage-popover")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu.getByRole("button", { name: "Session Cost" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  test("an agent without Model Settings gives them their own row above the bar", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.goto("/session-usage-e2e.html?width=600&height=780");
    await expect(page.getByRole("button", { name: /^Model Settings/ })).toHaveCount(0);
    await expect(page.locator(".composer-bar :is(.context-control, .session-usage)")).toHaveCount(0);
    const row = page.locator(".composer-usage-row");
    await expect(row.getByRole("button", { name: "Session Usage: $1.37" })).toBeVisible();
    const [rowBox, barBox] = await Promise.all([row.boundingBox(), page.locator(".composer-bar").boundingBox()]);
    expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(barBox!.y);
    const bar = await readBar(page);
    expect(bar.rows).toBe(1);
    expect(bar.overflow).toBeLessThanOrEqual(0);
    expect(await composerOverlaps(page)).toEqual([]);
  });

  test("an enlarged text size moves them out of a column that fits them only by pixels", async ({ page }) => {
    // 40rem, not 640px: at a 32px root a 900px column is narrow for text twice the size.
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.goto("/session-usage-e2e.html?width=900&height=780&driver=claude-code&cost=12345.67");
    await expect(page.locator(".composer-bar .session-usage")).toHaveCount(1);
    await page.addStyleTag({ content: "html { font-size: 32px; }" });
    await expect(page.locator(".composer-bar :is(.context-control, .session-usage)")).toHaveCount(0);
    await page.getByRole("button", { name: /^Model Settings/ }).click();
    await expect(page.getByRole("dialog", { name: "Model Settings" }).getByRole("group", { name: "Session Usage" })).toContainText("$12,345.67");
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
    await expect(input).toHaveAttribute("placeholder", /^Message \S/u);
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
  await page.locator(".composer-idle-preview").click();
  const bar = await readBar(page);
  expect(bar.rows, "the bar's controls share one row").toBe(1);
  expect(bar.overflow).toBeLessThanOrEqual(0);

  await page.getByRole("button", { name: /^Model Settings/ }).click();
  const menu = page.getByRole("dialog", { name: "Model Settings" });
  const group = menu.getByRole("group", { name: "Session Usage" });
  await expect(group).toBeVisible();
  await dialogMotionSettled(page);
  // First in the sheet, ahead of the model choices, and in view without scrolling (#2191).
  const order = await menu.evaluate((sheet) => [...sheet.querySelectorAll('[role="group"], [role="radiogroup"]')]
    .map((element) => element.getAttribute("aria-label")));
  expect(order).toEqual(["Session Usage", "Model", "Reasoning Effort"]);
  expect(await menu.evaluate((sheet) => sheet.scrollTop)).toBe(0);
  const [sheetBox, groupBox] = await Promise.all([menu.boundingBox(), group.boundingBox()]);
  expect(groupBox!.y).toBeGreaterThanOrEqual(sheetBox!.y);
  expect(groupBox!.y + groupBox!.height).toBeLessThanOrEqual(sheetBox!.y + sheetBox!.height);
  await expect(menu.locator(".model-settings-columns"), "one column on a phone").toHaveCount(0);
  // Each figure is a row named by its label alone, in this order (#2447).
  const rows = group.getByRole("button");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAccessibleName("Context Window");
  await expect(rows.first()).toHaveAccessibleDescription(/^36%\s*72K of 200K$/);
  await expect(rows.last()).toHaveAccessibleName("Session Cost");
  await expect(rows.last()).toHaveAccessibleDescription("$1.37");
  await page.screenshot({ path: `${SHOT}/mobile-model-settings-usage.png` });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

/**
 * #2447: on a phone the group's rows are the way to what the bar's popovers hold. Session Cost opens
 * the Session Usage breakdown in Model Settings' place (Context Window its own), with Back in the
 * title row, and each Escape closes one layer.
 */
test.describe("mobile: the Session Usage group opens its breakdowns inside Model Settings", () => {
  test.describe("with a touch pointer", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("by touch: the per-model rows, the pricing link and the Codex App Server note", async ({ page }) => {
      await page.goto("/session-usage-e2e.html?width=390&height=800&tiers=1");
      await page.locator(".composer-idle-preview").tap();
      await page.getByRole("button", { name: /^Model Settings/ }).tap();
      const menu = page.getByRole("dialog", { name: "Model Settings" });
      await menu.getByRole("button", { name: "Session Cost" }).tap();

      await expect(menu.locator(".menu-head-title")).toHaveText("Session Cost");
      await expect(menu.getByRole("radiogroup")).toHaveCount(0);
      const usage = menu.getByRole("group", { name: "Session Usage" });
      await expect(usage.locator(".session-usage-model-name")).toHaveText(["gpt-5.5-codex", "gpt-5.5-codex-mini"]);
      await expect(usage).toContainText("Total Processed");
      const link = usage.getByRole("link", { name: "Estimated API Costs" });
      await link.scrollIntoViewIfNeeded();
      await expect(link).toBeVisible();
      const note = usage.locator(".session-usage-info-detail");
      await expect(note).toBeHidden();
      await usage.getByRole("button", { name: "About Codex App Server Usage" }).tap();
      await expect(note).toBeVisible();
      await expect(note).toContainText("Usage recorded since then counts every response.");
      // The breakdown stays inside the sheet: no sideways scroll, nothing past the screen edge.
      const sheet = await menu.evaluate((element) => ({
        overflow: element.scrollWidth - element.clientWidth,
        right: element.getBoundingClientRect().right,
      }));
      expect(sheet.overflow).toBeLessThanOrEqual(0);
      expect(sheet.right).toBeLessThanOrEqual(390);

      await menu.getByRole("button", { name: "Back to Model Settings" }).tap();
      await expect(menu.locator(".menu-head-title")).toHaveText("Model Settings");
      await expect(menu.getByRole("radiogroup", { name: "Model" })).toBeVisible();

      await menu.getByRole("button", { name: "Context Window" }).tap();
      await expect(menu.locator(".menu-head-title")).toHaveText("Context Window");
      const occupancy = menu.getByRole("group", { name: "Context Window" });
      await expect(occupancy).toContainText("Capacity");
      await expect(occupancy).toContainText("Remaining");
    });
  });

  test("by keyboard, and Escape closes the breakdown, then Model Settings", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/session-usage-e2e.html?width=390&height=800&tiers=1");
    await page.locator(".composer-idle-preview").click();
    const chip = page.getByRole("button", { name: /^Model Settings/ });
    await chip.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("dialog", { name: "Model Settings" });
    await expect(menu.getByRole("radio", { name: "GPT Tiered" })).toBeFocused();
    // The group comes before the model choices, so Shift+Tab from the current model reaches it.
    await page.keyboard.press("Shift+Tab");
    const cost = menu.getByRole("button", { name: "Session Cost" });
    await expect(cost).toBeFocused();
    await page.keyboard.press("Enter");

    const back = menu.getByRole("button", { name: "Back to Model Settings" });
    await expect(back).toBeFocused();
    const usage = menu.getByRole("group", { name: "Session Usage" });
    await expect(usage.locator(".session-usage-model")).toHaveCount(2);
    await page.keyboard.press("Tab");
    await expect(menu.getByRole("button", { name: "Close Model Settings" })).toBeFocused();
    await page.keyboard.press("Tab");
    const about = usage.getByRole("button", { name: "About Codex App Server Usage" });
    await expect(about).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(usage.locator(".session-usage-info-detail")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(usage.getByRole("link", { name: "Estimated API Costs" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(back, "Tab stays inside the sheet").toBeFocused();

    // One layer per press: the breakdown, then Model Settings.
    await page.keyboard.press("Escape");
    await expect(menu).toBeVisible();
    await expect(menu.locator(".menu-head-title")).toHaveText("Model Settings");
    await expect(cost).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(chip).toBeFocused();
  });

  test("in the full shell, the next Escape leaves the composer and the one after leaves the session", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/command-inbox-projects-e2e.html?scenario=session-usage-model-settings&fullShell=1");
    await page.getByRole("button", { name: /Alpha Session/ }).click();
    const sessionHeading = page.getByRole("heading", { level: 1, name: "Alpha Session" });
    await expect(sessionHeading).toBeVisible();
    await page.locator(".composer-idle-preview").click();
    const chip = page.getByRole("button", { name: /^Model Settings/ });
    await chip.click();
    const menu = page.getByRole("dialog", { name: "Model Settings" });
    const cost = menu.getByRole("button", { name: "Session Cost" });
    await cost.click();
    await expect(menu.locator(".menu-head-title")).toHaveText("Session Cost");
    await expect(menu.getByRole("group", { name: "Session Usage" })).toContainText("Total Processed");

    await page.keyboard.press("Escape");
    await expect(menu.locator(".menu-head-title")).toHaveText("Model Settings");
    await expect(cost).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(chip).toBeFocused();
    await expect(sessionHeading).toBeVisible();
    // Then as from any composer control (#1796): out to the reader, and only then out of the session.
    await page.keyboard.press("Escape");
    await expect(page.locator(".main-body .detail-scroll")).toBeFocused();
    await expect(sessionHeading).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sessionHeading).toHaveCount(0);
  });
});

test("mobile: without Model Settings the figures take their own row, and cost opens Session Usage", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/session-usage-e2e.html?width=390&height=800");

  // The collapsed pill hides the row, as it hides Model Settings; opening the composer shows it.
  const row = page.locator(".composer-usage-row");
  await expect(row).toBeHidden();
  await page.locator(".composer-idle-preview").click();
  const cost = row.getByRole("button", { name: "Session Usage: $1.37" });
  await expect(cost).toHaveText("$1.37");
  // The cost remains its own control rather than repeating the context meter (#781).
  await expect(cost).not.toContainText("context");
  await expect(row.getByRole("button", { name: /^Context Window/ })).toBeVisible();
  const bar = await readBar(page);
  expect(bar.rows).toBe(1);
  expect(bar.overflow).toBeLessThanOrEqual(0);
  expect(await composerOverlaps(page)).toEqual([]);

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
    await page.locator(".composer-idle-preview").click();
    await page.locator(".composer-usage-row").getByRole("button", { name: /^Session Usage: / }).click();
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

for (const root of [16, 32]) {
  test(`mobile: the widest figures stay inside a 320px composer at a ${root}px root`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto("/session-usage-e2e.html?width=320&height=800&cost=12345.67");
    if (root !== 16) await page.addStyleTag({ content: `html { font-size: ${root}px; }` });
    await pinWidestFace(page, page.locator(".composer-box"));
    // Collapsed, and then open: neither state may crowd or overlap a control.
    await expect(page.locator(".composer-bar")).toBeVisible();
    expect(await composerOverlaps(page)).toEqual([]);
    expect((await readBar(page)).overflow).toBeLessThanOrEqual(0);
    await page.locator(".composer-idle-preview").click();
    const cost = page.locator(".composer-usage-row").getByRole("button", { name: "Session Usage: $12,345.67" });
    await expect(cost).toBeVisible();
    const legible = await cost.evaluate((button) => ({ visible: button.clientWidth, needed: button.scrollWidth }));
    expect(legible.visible).toBeGreaterThanOrEqual(legible.needed);
    const bar = await readBar(page);
    expect(bar.rows).toBe(1);
    expect(bar.overflow).toBeLessThanOrEqual(0);
    expect(await composerOverlaps(page)).toEqual([]);
  });
}

test("mobile light theme: the estimated cost source stays compact", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/session-usage-e2e.html?width=390&height=800");
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.locator(".composer-idle-preview").click();
  await page.getByRole("button", { name: "Session Usage: $1.37" }).click();
  const usage = page.locator(".session-usage-popover").first();
  await expect(usage.getByRole("link", { name: "Estimated API Costs" })).toBeVisible();
  expect(await usage.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(await usage.evaluate((element) => element.clientWidth));
  await page.screenshot({ path: `${SHOT}/mobile-session-usage-light.png` });
});
