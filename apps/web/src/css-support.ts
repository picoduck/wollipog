/**
 * The browser floor the production bundle is compiled for, derived from the CSS the app actually
 * ships (#914).
 *
 * The floor used to be a hand-written list of versions. It drifted: the stylesheet adopted `:has()`,
 * `color-mix()`, and size container queries, and the declared floor stayed where it was. Nothing
 * complained, because a build target is not a validator — Lightning CSS downlevels what it knows how
 * to rewrite and passes everything else through untouched, with no warning. All three of those are
 * in the "pass through" category: there is no older syntax to compile them into. So the declared
 * floor said Firefox 104 while the bundle shipped rules Firefox could not parse until 121, and
 * every one of the other three declared versions was short too.
 *
 * The fix is to stop declaring the floor and start computing it. `CSS_FEATURES` below accounts for
 * every modern construct the stylesheet uses; `webviewTargets()` returns the maximum version the
 * non-downlevelable ones require. The declaration cannot drift from reality again, because the
 * declaration IS reality — adopting a newer feature raises the floor by construction, and
 * `css-support.test.ts` fails when the stylesheet uses something this file does not account for.
 */

/** The engines the production bundle is compiled for. Also the key order used in output. */
export const ENGINES = ["chrome", "edge", "firefox", "safari"] as const;

export type Engine = (typeof ENGINES)[number];

/** First supporting version per engine, as `[major, minor]`. */
export type SupportMatrix = Readonly<Record<Engine, readonly [number, number]>>;

interface FeatureBase {
  /** Stable id, also the name used in failure messages. */
  readonly id: string;
  /**
   * What to look for in the stylesheet source.
   *
   * Case-insensitive, always: CSS pseudo-class, function, and at-rule names are case-insensitive,
   * so `:HAS(` is the same selector as `:has(`. A case-sensitive detector would let that spelling
   * slip past accounting entirely — and worse, would report the registry entry as unused and invite
   * a maintainer to delete the very entry holding the floor up.
   */
  readonly detect: RegExp;
}

/** A feature no compiler can rewrite for an older engine, so it sets the floor. */
export interface RequiresFloor extends FeatureBase {
  readonly kind: "requires-floor";
  /** First version of each engine with full support. */
  readonly support: SupportMatrix;
  /** Where the support data came from, so a reviewer can re-check it rather than trust it. */
  readonly source: string;
  /** Why this cannot simply be compiled away. A downlevelable feature belongs in `Downlevelled`. */
  readonly whyNotDownlevelable: string;
}

/**
 * A construct the build compiles away before it reaches a browser.
 *
 * These are accounted for WITHOUT raising the floor, which is the whole reason the distinction
 * exists: treating them like the others would constrain the app on behalf of output no browser ever
 * receives. Adding an entry here is a claim about the toolchain, so it has to carry the evidence.
 */
export interface Downlevelled extends FeatureBase {
  readonly kind: "downlevelled";
  /** What rewrites it, and into what. */
  readonly by: string;
  /** How that was confirmed, so the claim can be re-tested when the toolchain moves. */
  readonly evidence: string;
}

export type CssFeature = RequiresFloor | Downlevelled;

/**
 * Every modern CSS construct the stylesheet is allowed to contain.
 *
 * `requires-floor` entries were verified against Lightning CSS 1.33.0 at the previously declared
 * targets: `color-mix()` with `var()` arguments, `:has()`, and `@container` size queries were all
 * emitted unchanged, with zero warnings. (`color-mix()` over literal colours IS folded to a static
 * colour — but the app's call sites all take `var()` arguments, which cannot be computed at build
 * time.)
 *
 * Deliberately absent, because they are older than every version below and so cannot raise the
 * floor: `:is()`, `content-visibility`, `accent-color`, `inert`, `dvh` units.
 */
export const CSS_FEATURES: readonly CssFeature[] = [
  {
    kind: "requires-floor",
    id: ":has()",
    detect: /:has\(/i,
    support: { chrome: [105, 0], edge: [105, 0], firefox: [121, 0], safari: [15, 4] },
    source: "caniuse.com/css-has, retrieved 2026-09-10",
    whyNotDownlevelable:
      "A relational selector has no equivalent in earlier CSS; matching a parent on its descendants "
      + "cannot be expressed without it.",
  },
  {
    kind: "requires-floor",
    id: "color-mix()",
    detect: /color-mix\(/i,
    support: { chrome: [111, 0], edge: [111, 0], firefox: [113, 0], safari: [16, 2] },
    source: "caniuse.com/mdn-css_types_color_color-mix, retrieved 2026-09-10",
    whyNotDownlevelable:
      "Every call site mixes `var()` references, whose values are not known until the cascade runs, "
      + "so the result cannot be folded to a static colour at build time.",
  },
  {
    kind: "requires-floor",
    id: "@container size query",
    detect: /@container\s/i,
    support: { chrome: [106, 0], edge: [106, 0], firefox: [110, 0], safari: [16, 0] },
    source: "caniuse.com/css-container-queries, retrieved 2026-09-10",
    whyNotDownlevelable:
      "Querying an ancestor's size is a layout-time question; no static rewrite can answer it, and "
      + "the media-query fallback measures the viewport rather than the container.",
  },
];

/**
 * Constructs that MUST be accounted for in `CSS_FEATURES` before they can ship.
 *
 * This is the half that keeps the registry honest: anything matched here without an entry would
 * silently repeat exactly the drift this file exists to end.
 *
 * **The bound worth being explicit about:** this is a curated list of constructs, not a general
 * compatibility oracle. CSS adopted after it was last extended can still slip through — closing
 * that gap properly needs real compatibility metadata (a `caniuse-lite`-style dependency), which the
 * project does not currently carry. What this does guarantee is that the constructs known to matter
 * cannot regress, and that the list is the one obvious place to extend when a new one appears.
 *
 * A match is not a verdict. The response to a failure is to add the right kind of entry —
 * `requires-floor` with support data, or `downlevelled` with evidence — not to delete the rule.
 */
export const ACCOUNTABLE_CONSTRUCTS: ReadonlyArray<{ id: string; detect: RegExp }> = [
  { id: ":has()", detect: /:has\(/i },
  { id: "color-mix()", detect: /color-mix\(/i },
  { id: "@container size query", detect: /@container\s/i },
  // Style queries are a separate feature from size queries, with a later floor, so they need their
  // own accounting rather than riding on the size-query entry above.
  { id: "@container style query", detect: /@container[^{]*\bstyle\(/i },
  { id: "@layer", detect: /@layer[\s{]/i },
  { id: "@property", detect: /@property\s/i },
  { id: "@scope", detect: /@scope[\s{]/i },
  { id: "@starting-style", detect: /@starting-style[\s{]/i },
  { id: "@view-transition", detect: /@view-transition[\s{]/i },
  { id: "@position-try", detect: /@position-try\s/i },
  { id: "oklch()", detect: /\boklch\(/i },
  { id: "oklab()", detect: /\boklab\(/i },
  { id: "lch()", detect: /(?<![-\w])lch\(/i },
  { id: "lab()", detect: /(?<![-\w])lab\(/i },
  { id: "subgrid", detect: /\bsubgrid\b/i },
  { id: "text-wrap", detect: /\btext-wrap\s*:/i },
  { id: "text-box", detect: /\btext-box(?:-trim|-edge)?\s*:/i },
  { id: "field-sizing", detect: /\bfield-sizing\s*:/i },
  { id: "anchor positioning", detect: /\banchor-name\s*:|\bposition-anchor\s*:/i },
  { id: "calc-size()", detect: /\bcalc-size\(/i },
  { id: "interpolate-size", detect: /\binterpolate-size\s*:/i },
  { id: "transition-behavior", detect: /\btransition-behavior\s*:/i },
  { id: ":user-valid / :user-invalid", detect: /:user-(?:in)?valid\b/i },
  { id: ":popover-open", detect: /:popover-open\b/i },
  { id: "popover attribute styling", detect: /\[popover[\]=]/i },
  { id: "scroll-driven animations", detect: /\b(?:animation|scroll|view)-timeline(?:-name|-axis)?\s*:/i },
  { id: "@scroll-timeline", detect: /@scroll-timeline[\s{]/i },
  { id: ":state()", detect: /:state\(/i },
  { id: "CSS nesting", detect: /^\s*&/m },
];

function compare(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

/** Only the entries that constrain the browser floor. */
export function floorSetting(features: readonly CssFeature[] = CSS_FEATURES): RequiresFloor[] {
  return features.filter((feature): feature is RequiresFloor => feature.kind === "requires-floor");
}

/** The highest version any floor-setting feature requires, per engine. */
export function requiredFloor(features: readonly CssFeature[] = CSS_FEATURES): SupportMatrix {
  const floor = Object.fromEntries(ENGINES.map((engine) => [engine, [0, 0] as const])) as
    Record<Engine, readonly [number, number]>;
  for (const feature of floorSetting(features)) {
    for (const engine of ENGINES) {
      if (compare(feature.support[engine], floor[engine]) > 0) floor[engine] = feature.support[engine];
    }
  }
  return floor;
}

/** `chrome111`, `safari16.2` — the spelling esbuild, Rolldown, and Lightning CSS all accept. */
export function formatTarget(engine: Engine, [major, minor]: readonly [number, number]): string {
  return minor === 0 ? `${engine}${major}` : `${engine}${major}.${minor}`;
}

/**
 * The build target for both JavaScript and CSS.
 *
 * It is computed from CSS requirements alone, and the JS output shares it. That is deliberate and
 * safe in one direction only: an engine new enough to parse the CSS is by construction new enough
 * for the JS this floor permits, so deriving from CSS can only ever be conservative for JS. If the
 * app ever needs a JS feature NEWER than every CSS feature here, that requirement belongs in this
 * registry too rather than in a second, separately drifting constant.
 */
export function webviewTargets(features: readonly CssFeature[] = CSS_FEATURES): string[] {
  const floor = requiredFloor(features);
  return ENGINES.map((engine) => formatTarget(engine, floor[engine]));
}
