import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { expect, test, type Page } from "@playwright/test";

/**
 * #915: the transcript status strip retires its contextual actions below a hard-coded pane width.
 * That number is a budget — the centered context/follow/cost cluster, the strip's own padding and
 * gaps, and the hint in each of the two symmetric `1fr` tracks. Until now the derivation lived only
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
function readCutoffs(): Cutoff[] {
  const found: Cutoff[] = [];
  postcss.parse(STYLESHEET).walkAtRules("container", (rule) => {
    if (!rule.params.includes("transcript-pane")) return;
    const hidesActions = rule.nodes?.some(
      (node) => node.type === "rule"
        && node.selector.includes(".transcript-status-actions")
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
  /** Strip padding plus the two grid column gaps — fixed, in px. */
  readonly chrome: number;
  /** Natural width of the centered context + widest follow-state + cost cluster. */
  readonly centerWidest: number;
  /** Natural width of the trailing contextual actions track. */
  readonly trailingActions: number;
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
    const context = cluster.querySelector(".transcript-status-context") as HTMLElement;
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
    return {
      chrome: parseFloat(stripStyle.paddingLeft) + parseFloat(stripStyle.paddingRight)
        + parseFloat(stripStyle.columnGap) * 2,
      // `scrollWidth` is the width each wants, which is what the budget has to pay for — the
      // rendered width is already the result of the shrinking this rule exists to avoid.
      centerWidest: context.scrollWidth + followWidest + cost.scrollWidth + clusterGap * 2,
      // The actions wrapper deliberately fills its grid track; the hint is the track's natural
      // content width that the symmetric outer columns have to reserve.
      trailingActions: actionHint.scrollWidth,
    };
  });
}

/** Pane width at which all three tracks fit at their natural widths. */
function requiredWidth({ chrome, centerWidest, trailingActions }: StripParts): number {
  // The strip is `minmax(0,1fr) auto minmax(0,1fr)`: the two outer tracks are equal, so the trailing
  // track's needs are paid for twice.
  return chrome + centerWidest + trailingActions * 2;
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
      + `  measured: chrome ${parts.chrome}px + centered cluster ${parts.centerWidest.toFixed(1)}px `
      + `+ 2 x trailing actions ${parts.trailingActions}px = ${required.toFixed(1)}px required\n`
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
