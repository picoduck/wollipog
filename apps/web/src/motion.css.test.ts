import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse, type AtRule } from "postcss";
import { customProperties, declarationsOf, topLevelRule } from "./css-rules.js";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

/**
 * Motion in this app was hand-tuned per component: 24 transition declarations used nine different
 * durations (0.12s, 130ms, 0.14s, 0.15s, 160ms, 180ms, 0.2s, 0.3s…) with no relationship between
 * them, so the same interaction felt different depending on which screen you were on.
 *
 * More seriously, `prefers-reduced-motion` was honoured in three component-scoped blocks covering
 * four of the seven keyframe animations. Every transition in the sheet, and the remaining
 * animations, kept playing for a user who had asked their OS to stop animation.
 */
const tokens = customProperties(topLevelRule(css, ":root"));

test("the motion scale is defined once and ordered", () => {
  const scale = ["--dur-instant", "--dur-fast", "--dur-base", "--dur-slow"];
  const ms = scale.map((name) => {
    const defined = tokens.get(name);
    assert.ok(defined?.length, `${name} must be defined on :root`);
    // A second definition wins in the cascade, so reading the first would read the wrong number.
    assert.equal(defined!.length, 1, `${name} is defined ${defined!.length} times`);
    const value = Number.parseInt(defined![0]!, 10);
    assert.ok(/ms$/.test(defined![0]!) && Number.isFinite(value), `${name} must be an ms integer`);
    return value;
  });
  for (let i = 1; i < ms.length; i += 1) {
    assert.ok(ms[i]! > ms[i - 1]!, `${scale[i]} (${ms[i]}ms) must be slower than ${scale[i - 1]}`);
  }
  // A "fast" tier a user perceives as instant, or a "slow" one that outlasts their attention,
  // would make the scale meaningless even while strictly ordered.
  assert.ok(ms[1]! >= 100 && ms[1]! <= 200, "--dur-fast should sit in the perceptible-but-quick band");
  assert.ok(ms[3]! <= 400, "--dur-slow must not outlast the interaction that triggered it");
  for (const easing of ["--ease-out", "--ease-spring"]) {
    assert.ok(tokens.get(easing)?.length, `${easing} must be defined`);
  }
});

test("every transition draws its duration and easing from the scale", () => {
  // Checked per comma-separated item, and by what each item MUST contain rather than what it must
  // not. Rejecting raw times and a written-out `ease` left an item with a duration token and no
  // timing function at all fully compliant — the browser then applies its default `ease` curve, so
  // retuning --ease-out silently skipped those controls while this test claimed otherwise.
  const offenders: string[] = [];
  for (const { selector, value } of declarationsOf(css, "transition")) {
    if (["none", "inherit", "initial", "unset"].includes(value)) continue;
    for (const item of value.split(",").map((part) => part.trim()).filter(Boolean)) {
      const problem = !/var\(--dur-[a-z]+\)/.test(item) ? "no duration token"
        : !/var\(--ease-[a-z]+\)/.test(item) ? "no easing token (the browser default `ease` applies)"
        : /\b\d*\.?\d+m?s\b/.test(item) ? "a raw duration"
        : /\bease\b(?!-)/.test(item) ? "a literal `ease` keyword"
        : null;
      if (problem) offenders.push(`${selector} { transition: … ${item} } — ${problem}`);
    }
  }
  assert.deepEqual(offenders, [], `these bypass the motion scale:\n${offenders.join("\n")}`);
});

/**
 * The guard is global and uses !important because it has to beat per-component declarations it
 * knows nothing about — a component-scoped opt-in is exactly the arrangement that let four
 * animations and every transition slip through.
 */
test("reduced motion is honoured globally, not per component", () => {
  const reduced: AtRule[] = [];
  parse(css).walkAtRules("media", (rule) => {
    if (/prefers-reduced-motion:\s*reduce/.test(rule.params)) reduced.push(rule);
  });
  assert.ok(reduced.length > 0, "the sheet must respond to prefers-reduced-motion");

  // The universal rule, found structurally rather than by text: a component-scoped block that
  // merely mentions "*" in a comment must not satisfy this.
  //
  // Requires the bare `*`, not merely `*::before`. Narrowing the element selector to one component
  // while leaving the pseudo-element selectors universal passed an earlier version of this check,
  // and that is exactly the per-component arrangement the guard replaced.
  const universal = reduced
    .flatMap((at) => at.nodes ?? [])
    .filter((node): node is import("postcss").Rule => node.type === "rule")
    .find((rule) => rule.selectors.some((selector) => selector.trim() === "*"));
  assert.ok(universal, "the guard must apply to every element, not just pseudo-elements");
  for (const pseudo of ["*::before", "*::after"]) {
    assert.ok(universal!.selectors.some((selector) => selector.trim() === pseudo),
      `${pseudo} must be covered too — generated content animates independently of its host`);
  }

  const declared = new Map(universal!.nodes
    ?.filter((node): node is import("postcss").Declaration => node.type === "decl")
    .map((decl) => [decl.prop, { value: decl.value, important: decl.important }]) ?? []);

  for (const property of ["animation-duration", "transition-duration"]) {
    const decl = declared.get(property);
    assert.ok(decl, `${property} must be forced off for every element`);
    // Without !important the guard loses to every per-component declaration in the sheet.
    assert.ok(decl!.important, `${property} must be !important to beat component rules`);
    // Exactly 1ms. Rejecting only the literal strings "0" and "0s" left "10s", "0ms", "none" and
    // any typo green — so CSS could restore prolonged motion, or suppress the very end events this
    // assertion claims to preserve, without CI noticing.
    //
    // Collapsed rather than removed because several components advance state on
    // transitionend/animationend, and a zero-length duration never fires those events.
    assert.equal(decl!.value, "1ms",
      `${property} must be exactly 1ms: long enough to fire the end events, short enough to be imperceptible`);
  }

  const iterations = declared.get("animation-iteration-count");
  assert.equal(iterations?.value, "1", "an infinite animation at 1ms still repeats forever");
  assert.ok(iterations?.important);
});
