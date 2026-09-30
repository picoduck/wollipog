import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { expect, test, type Page } from "@playwright/test";

/**
 * #915: the transcript status strip retires its contextual actions below a hard-coded pane width.
 * That number is a budget — the independently centered follow control, the larger natural side
 * track, and the strip's own padding and gaps. Until now the derivation lived only
 * in a CSS comment, so retuning any of those controls moved the real budget without moving the
 * constant, and the failure was silent: a session cost squeezed below its own width, not a red test.
 *
 * Container queries cannot read custom properties, so the cutoff cannot be *composed* from the
 * values it depends on — it has to stay a literal. This spec closes the loop from the other end: it
 * reads the literal back out of the stylesheet, measures what the strip's parts actually render at,
 * and fails when the constant no longer covers them.
 */

const STYLESHEET = readFileSync(
  fileURLToPath(new URL("../src/styles.css", import.meta.url)),
  "utf8",
);

/** A `@container` cutoff that hides the trailing actions, as written in the stylesheet. */
interface Cutoff {
  /** The raw length expression, e.g. `590px` or `calc(330px + 16rem)`. */
  readonly source: string;
  /** Width in px at a given root font size. */
  evaluate(rootPx: number): number;
}

/**
 * Every rule that retires `.transcript-status-actions` on a pane width.
 *
 * Parsed rather than regex-matched against a remembered shape: the point of this spec is to track
 * the stylesheet, so it has to read what is actually there, including a rule someone adds later.
 */
function readCutoffs(selector = ".transcript-status-actions"): Cutoff[] {
  const found: Cutoff[] = [];
  postcss.parse(STYLESHEET).walkAtRules("container", (rule) => {
    if (!rule.params.includes("transcript-pane")) return;
    const hidesActions = rule.nodes?.some(
      (node) => node.type === "rule"
        && node.selector.includes(selector)
        && node.nodes?.some((decl) => decl.type === "decl" && decl.prop === "display" && decl.value === "none"),
    );
    if (!hidesActions) return;
    const width = /max-width:\s*(.+?)\s*\)\s*$/.exec(rule.params);
    if (!width) return;
    found.push({ source: width[1]!, evaluate: (rootPx) => evaluateLength(width[1]!, rootPx) });
  });
  return found;
}

/**
 * The two length forms the cutoff uses today: a plain px length, and `calc(<px> + <rem>)`.
 *
 * Anything else throws rather than guessing. A cutoff written in a form this cannot evaluate is not
 * a reason to skip the check — it is a reason to teach the evaluator the new form, because an
 * unevaluated cutoff is exactly the unverified constant #915 is about.
 */
function evaluateLength(expression: string, rootPx: number): number {
  const plain = /^(-?[\d.]+)px$/.exec(expression);
  if (plain) return Number(plain[1]);
  const sum = /^calc\(\s*(-?[\d.]+)px\s*\+\s*(-?[\d.]+)rem\s*\)$/.exec(expression);
  if (sum) return Number(sum[1]) + Number(sum[2]) * rootPx;
  throw new Error(
    `status-strip cutoff "${expression}" is in a form this spec cannot evaluate. Extend `
    + "evaluateLength() so the budget stays verified rather than dropping the check.",
  );
}

/** Widest pane width at which the actions are still shown, across all cutoff rules. */
function effectiveCutoff(cutoffs: readonly Cutoff[], rootPx: number): number {
  // Each rule independently hides the actions, so the widest one wins.
  return Math.max(...cutoffs.map((cutoff) => cutoff.evaluate(rootPx)));
}

interface StripParts {
  /** Strip padding plus the centered grid's two column gaps — fixed, in px. */
  readonly chrome: number;
  /** Natural width of the widest follow-state control. */
  readonly followWidest: number;
  /** Larger natural width of the context side or cost-plus-actions side. */
  readonly sideWidest: number;
}

/**
 * What the strip's parts actually measure, with the follow-state control forced to its widest label.
 *
 * `previewing` renders "Previewing, Follow Live Output" and is ~20px wider than the `paused` state
 * a scroll produces. Reaching it needs a semantic-navigation reveal the usage fixture does not
 * model, and the property under test is the label's WIDTH, so the text is substituted directly.
 */
async function measureParts(page: Page, rootPx: number): Promise<StripParts> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/session-usage-e2e.html?width=1360&height=840&cost=12345.67");
  await page.addStyleTag({ content: `html { font-size: ${rootPx}px; }` });
  await expect(page.locator(".follow-tail-chip")).toBeVisible();
  // Pause follow so the control renders its resume affordance, then widen its label further.
  await page.mouse.move(680, 300);
  await page.mouse.wheel(0, -900);
  await expect(page.locator(".follow-tail-chip")).toContainText("Follow Live Output");

  return page.locator(".transcript-status-strip").evaluate((strip) => {
    const stripStyle = getComputedStyle(strip);
    const cluster = strip.querySelector(".transcript-status-cluster") as HTMLElement;
    const context = cluster.querySelector(".context-control") as HTMLElement;
    const chip = strip.querySelector(".follow-tail-chip") as HTMLElement;
    const stateLabel = chip.querySelector("span")!;

    const paused = chip.getBoundingClientRect().width;
    const original = stateLabel.textContent;
    stateLabel.textContent = "Previewing";
    const followWidest = chip.getBoundingClientRect().width;
    stateLabel.textContent = original;
    if (followWidest <= paused) {
      throw new Error("`previewing` is no longer the widest follow-state label; re-derive the budget");
    }

    const actions = strip.querySelector(".transcript-status-actions") as HTMLElement;
    const actionHint = actions.querySelector(".shortcut-hint") as HTMLElement;
    const cost = strip.querySelector(".transcript-status-usage .session-cost-button") as HTMLElement;
    const clusterGap = parseFloat(getComputedStyle(cluster).columnGap);
    const trailingGap = parseFloat(getComputedStyle(
      strip.querySelector(".transcript-status-trailing")!,
    ).columnGap);
    return {
      chrome: parseFloat(stripStyle.paddingLeft) + parseFloat(stripStyle.paddingRight)
        + clusterGap * 2,
      // `scrollWidth` is the width each wants, which is what the budget has to pay for — the
      // rendered width is already the result of the shrinking this rule exists to avoid.
      followWidest,
      sideWidest: Math.max(
        context.scrollWidth,
        cost.scrollWidth + trailingGap + actionHint.scrollWidth,
      ),
    };
  });
}

/** Pane width at which all three tracks fit at their natural widths. */
function requiredWidth({ chrome, followWidest, sideWidest }: StripParts): number {
  // The centered grid uses equal side tracks, so the larger side's needs are paid for twice.
  return chrome + followWidest + sideWidest * 2;
}

test.use({ reducedMotion: "reduce" });

test("the stylesheet declares a cutoff this spec can evaluate", () => {
  const cutoffs = readCutoffs();
  expect(cutoffs.length).toBeGreaterThan(0);
  for (const cutoff of cutoffs) expect(() => cutoff.evaluate(16)).not.toThrow();
});

// The px part of the budget is fixed and the rem part scales, so one root size cannot prove the
// decomposition. 16 is the default; 24 and 32 are the enlarged text-size preferences the app's rem
// type exists to serve.
for (const rootPx of [16, 24, 32]) {
  test(`the declared cutoff covers what the strip measures at a ${rootPx}px root`, async ({ page }) => {
    const parts = await measureParts(page, rootPx);
    const required = requiredWidth(parts);
    const declared = effectiveCutoff(readCutoffs(), rootPx);

    // The contract: below the cutoff the hint is gone, so every pane ABOVE it must fit all three
    // tracks. A cutoff under the required width leaves a band where the hint is still shown and the
    // cost is already being squeezed — the #893 regression, reintroduced by a stale constant.
    expect(
      declared,
      `the status-strip cutoff no longer covers the strip's own parts at a ${rootPx}px root.\n`
      + `  measured: chrome ${parts.chrome}px + follow control ${parts.followWidest.toFixed(1)}px `
      + `+ 2 x widest side ${parts.sideWidest}px = ${required.toFixed(1)}px required\n`
      + `  declared: ${declared}px, from ${readCutoffs().map((c) => c.source).join(" and ")}\n`
      + "  Raise the cutoff in apps/web/src/styles.css to cover the new measurement.",
    ).toBeGreaterThanOrEqual(required);

    // And not wildly beyond it: a budget bumped far past what the strip needs retires the hint on
    // panes that could comfortably show it, which is the cost of "just make the test pass".
    expect(
      declared - required,
      `the cutoff now exceeds the measured requirement by ${(declared - required).toFixed(1)}px at a `
      + `${rootPx}px root. Headroom is deliberate, but this much means the budget no longer `
      + "describes the strip — re-derive it rather than padding it.",
    ).toBeLessThan(200);
  });
}

/**
 * #1956: the follow control's resume keycap is the shared rem keycap, and since #2041 the control's
 * label is rem type too, so both grow with the reader's text size. With the Reply hint already
 * retired, the cluster needs the chip WITH its keycap plus the larger side paid twice; below that
 * the keycap yields. Same contract as the actions cutoff: every pane above it must fit.
 */
async function clusterWithKeycap(page: Page, rootPx: number, keycap = true): Promise<number> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/session-usage-e2e.html?width=1360&height=840&cost=12345.67");
  await page.addStyleTag({ content: `html { font-size: ${rootPx}px; }` });
  await expect(page.locator(".follow-tail-chip")).toBeVisible();
  await page.mouse.move(680, 300);
  await page.mouse.wheel(0, -900);
  await expect(page.locator(".follow-tail-chip .follow-tail-kbd")).toBeVisible();

  return page.locator(".transcript-status-strip").evaluate((strip, withKeycap) => {
    const stripStyle = getComputedStyle(strip);
    const cluster = strip.querySelector(".transcript-status-cluster") as HTMLElement;
    const context = cluster.querySelector(".context-control") as HTMLElement;
    const chip = strip.querySelector(".follow-tail-chip") as HTMLElement;
    const stateLabel = chip.querySelector("span")!;
    const kbd = chip.querySelector(".follow-tail-kbd") as HTMLElement;
    const original = stateLabel.textContent;
    stateLabel.textContent = "Previewing";
    if (!withKeycap) kbd.style.display = "none";
    const chipWidest = chip.getBoundingClientRect().width;
    kbd.style.display = "";
    stateLabel.textContent = original;
    const cost = strip.querySelector(".transcript-status-usage .session-cost-button") as HTMLElement;
    const clusterGap = parseFloat(getComputedStyle(cluster).columnGap);
    return parseFloat(stripStyle.paddingLeft) + parseFloat(stripStyle.paddingRight) + clusterGap * 2
      + chipWidest + Math.max(context.scrollWidth, cost.scrollWidth) * 2;
  }, keycap);
}

for (const rootPx of [16, 24, 32]) {
  test(`the resume keycap's cutoff covers the cluster it widens at a ${rootPx}px root`, async ({ page }) => {
    const cutoffs = readCutoffs(".follow-tail-kbd");
    expect(cutoffs.length, "a transcript-pane rule retires the follow control's keycap").toBeGreaterThan(0);
    const required = await clusterWithKeycap(page, rootPx);
    const declared = effectiveCutoff(cutoffs, rootPx);
    expect(
      declared,
      `the resume keycap cutoff (${cutoffs.map((c) => c.source).join(" and ")} = ${declared}px) no longer `
      + `covers the ${required.toFixed(1)}px the cluster needs with it at a ${rootPx}px root.`,
    ).toBeGreaterThanOrEqual(required);
    expect(declared - required, "re-derive the keycap cutoff rather than padding it").toBeLessThan(200);
  });
}

/**
 * #2041: the control's label is on the small type role, so it grows with the reader's text size in
 * step with its neighbours rather than staying 12px while its own keycap and the Reply hint grow.
 * Rendered widths, not just computed sizes: a px override anywhere down the cascade would pass a
 * font-size check on the button and still draw the label at 12px.
 */
test("the follow control's label grows with the root in step with the Reply hint", async ({ page }) => {
  const widths: Record<number, { label: number; hint: number; fontSize: number }> = {};
  for (const rootPx of [16, 24, 32]) {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/session-usage-e2e.html?width=1360&height=840&cost=12345.67");
    await page.addStyleTag({ content: `html { font-size: ${rootPx}px; }` });
    await expect(page.locator(".follow-tail-chip")).toBeVisible();
    await page.mouse.move(680, 300);
    await page.mouse.wheel(0, -900);
    await expect(page.locator(".follow-tail-chip .follow-tail-action")).toBeVisible();
    widths[rootPx] = await page.locator(".transcript-status-strip").evaluate((strip) => {
      const action = strip.querySelector(".follow-tail-chip .follow-tail-action") as HTMLElement;
      const hint = strip.querySelector(".transcript-status-actions .shortcut-hint-label") as HTMLElement;
      return {
        label: action.getBoundingClientRect().width,
        hint: hint.getBoundingClientRect().width,
        fontSize: parseFloat(getComputedStyle(action).fontSize),
      };
    });
  }

  for (const rootPx of [24, 32]) {
    const scale = rootPx / 16;
    expect(widths[rootPx]!.fontSize, `the label's size at a ${rootPx}px root`).toBeCloseTo(12 * scale, 1);
    const labelGrowth = widths[rootPx]!.label / widths[16]!.label;
    const hintGrowth = widths[rootPx]!.hint / widths[16]!.hint;
    // Glyph widths round per size, so proportional is within a few percent rather than exact.
    expect(labelGrowth, `the label grew ${labelGrowth.toFixed(3)}x at a ${rootPx}px root`).toBeGreaterThan(scale * 0.95);
    expect(labelGrowth).toBeLessThan(scale * 1.05);
    expect(Math.abs(labelGrowth - hintGrowth), "the label and the Reply hint grow together").toBeLessThan(0.1);
  }
});

/**
 * The last step of the strip's yield order (#2041). Once the label grows with the root, at an
 * enlarged root the whole " · Follow Live Output" label can outgrow a narrow pane on its own, so
 * below the width the cluster needs WITH it (and without the already-retired keycap) the control
 * keeps only its state word. At the default root the cutoff is inert: the phone strip's own 340px
 * compact rule owns that layout, so the rule must never fire in a supported pane at 16px.
 */
const NARROWEST_PANE = 320;

for (const rootPx of [16, 24, 32]) {
  test(`the action text's cutoff fits the yield order at a ${rootPx}px root`, async ({ page }) => {
    const cutoffs = readCutoffs(".follow-tail-action");
    expect(cutoffs.length, "a transcript-pane rule retires the follow control's action text").toBeGreaterThan(0);
    const declared = effectiveCutoff(cutoffs, rootPx);

    // Reply hint, then keycap, then action text: each cutoff sits at or below the one before it,
    // and every rule that retires the action text retires the keycap with it, so the action text
    // never hides while the keycap still shows, at any root.
    const keycap = effectiveCutoff(readCutoffs(".follow-tail-kbd"), rootPx);
    expect(effectiveCutoff(readCutoffs(), rootPx), "the Reply hint yields before the keycap")
      .toBeGreaterThanOrEqual(keycap);
    expect(keycap, "the keycap yields before the action text").toBeGreaterThanOrEqual(declared);
    postcss.parse(STYLESHEET).walkAtRules("container", (rule) => {
      rule.walkRules((inner) => {
        if (!inner.selector.includes(".follow-tail-action")) return;
        expect(inner.selector, "a rule that hides the action text hides the keycap too").toContain(".follow-tail-kbd");
      });
    });

    if (rootPx === 16) {
      expect(declared, `the action text cutoff must not fire in a ${NARROWEST_PANE}px pane at 16px`)
        .toBeLessThan(NARROWEST_PANE);
      return;
    }
    const required = await clusterWithKeycap(page, rootPx, false);
    expect(
      declared,
      `the action text cutoff (${cutoffs.map((c) => c.source).join(" and ")} = ${declared}px) no longer `
      + `covers the ${required.toFixed(1)}px the cluster needs with it at a ${rootPx}px root.`,
    ).toBeGreaterThanOrEqual(required);
    expect(declared - required, "re-derive the action text cutoff rather than padding it").toBeLessThan(200);
  });
}

test("below the action text's cutoff the control keeps its state word and its name", async ({ page }) => {
  const declared = effectiveCutoff(readCutoffs(".follow-tail-action"), 32);
  await page.setViewportSize({ width: 1400, height: 900 });
  for (const [pane, shown] of [[Math.round(declared) - 4, false], [Math.round(declared) + 4, true]] as const) {
    await page.goto(`/session-usage-e2e.html?width=${pane}&height=840&cost=12345.67`);
    await page.addStyleTag({ content: "html { font-size: 32px; }" });
    const chip = page.locator(".follow-tail-chip");
    await expect(chip).toBeVisible();
    await page.mouse.move(pane / 2, 300);
    await page.mouse.wheel(0, -900);
    await expect(chip).toHaveAttribute("data-follow-tail-state", "paused");
    // Above the cutoff the keycap has already yielded; only the action text is decided here.
    await expect(chip.locator(".follow-tail-kbd")).toBeHidden();
    const action = chip.locator(".follow-tail-action");
    if (shown) {
      await expect(action, `action text visible just above the ${declared}px cutoff`).toBeVisible();
      continue;
    }
    await expect(action, `action text hidden just below the ${declared}px cutoff`).toBeHidden();

    // Label in name: the visible state word leads the accessible name, which still names the
    // action; the tooltip still names the chord.
    expect((await chip.innerText()).trim()).toBe("Paused");
    await expect(chip).toHaveAccessibleName("Paused, Follow Live Output");
    await expect(chip).toHaveAccessibleDescription(/^Follow Live Output \(.+\)$/);

    const cost = await page.locator(".transcript-status-usage .session-cost-button").evaluate((button) => ({
      visible: button.getBoundingClientRect().width,
      needed: button.scrollWidth,
    }));
    expect(cost.visible, "the cost keeps its full width").toBeGreaterThanOrEqual(cost.needed - 0.5);
  }
});

test("the cutoff is what decides whether the hint is shown, at the boundary", async ({ page }) => {
  // Ties the arithmetic above to observable behaviour: the same constant the budget check reads is
  // the one the browser acts on, verified a pixel either side of it.
  const cutoffs = readCutoffs();
  const declared = effectiveCutoff(cutoffs, 16);

  await page.setViewportSize({ width: 1400, height: 900 });
  for (const [pane, shown] of [[Math.round(declared) - 4, false], [Math.round(declared) + 4, true]] as const) {
    await page.goto(`/session-usage-e2e.html?width=${pane}&height=840&cost=12345.67`);
    await expect(page.locator(".follow-tail-chip")).toBeVisible();
    const actions = page.locator(".transcript-status-actions");
    if (shown) await expect(actions, `actions visible just above the ${declared}px cutoff`).toBeVisible();
    else await expect(actions, `actions hidden just below the ${declared}px cutoff`).toBeHidden();
  }
});
