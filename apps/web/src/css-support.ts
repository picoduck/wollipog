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
 * The fix is to stop declaring the floor and start computing it. `FEATURE_SUPPORT` below records
 * which non-downlevelable features the stylesheet uses and the first browser version that supports
 * each; `webviewTargets()` returns their maximum. The declaration cannot drift from reality again,
 * because the declaration IS reality — adopting a newer feature raises the floor by construction,
 * and `css-support.test.ts` fails when the stylesheet uses something this registry does not list.
 */

/** The engines the production bundle is compiled for. Also the key order used in output. */
export const ENGINES = ["chrome", "edge", "firefox", "safari"] as const;

export type Engine = (typeof ENGINES)[number];

/** First supporting version per engine, as `[major, minor]`. */
export type SupportMatrix = Readonly<Record<Engine, readonly [number, number]>>;

export interface CssFeature {
  /** Stable id, also the name used in failure messages. */
  readonly id: string;
  /** What to look for in the stylesheet source. */
  readonly detect: RegExp;
  /** First version of each engine with full support. */
  readonly support: SupportMatrix;
  /** Where the support data came from, so a reviewer can re-check it rather than trust it. */
  readonly source: string;
  /**
   * Why this feature cannot simply be compiled away for an older engine. Every entry needs one:
   * a feature Lightning CSS CAN downlevel does not belong here, because including it would raise
   * the floor for output that never reaches the browser.
   */
  readonly whyNotDownlevelable: string;
}

/**
 * Features present in `styles.css` that no CSS compiler can rewrite for an older engine.
 *
 * Verified against Lightning CSS 1.33.0 at the previously declared targets: `color-mix()` with
 * `var()` arguments, `:has()`, and `@container` size queries were all emitted unchanged, with zero
 * warnings. (`color-mix()` over literal colours IS folded to a static colour — but the app's 244
 * call sites all take `var()` arguments, which cannot be computed at build time.)
 *
 * Deliberately NOT listed, because they are older than every version below and so cannot raise the
 * floor: `:is()`, `content-visibility`, `accent-color`, `inert`, `dvh` units.
 */
export const FEATURE_SUPPORT: readonly CssFeature[] = [
  {
    id: ":has()",
    detect: /:has\(/,
    support: { chrome: [105, 0], edge: [105, 0], firefox: [121, 0], safari: [15, 4] },
    source: "caniuse.com/css-has, retrieved 2026-09-10",
    whyNotDownlevelable:
      "A relational selector has no equivalent in earlier CSS; matching a parent on its descendants "
      + "cannot be expressed without it.",
  },
  {
    id: "color-mix()",
    detect: /color-mix\(/,
    support: { chrome: [111, 0], edge: [111, 0], firefox: [113, 0], safari: [16, 2] },
    source: "caniuse.com/mdn-css_types_color_color-mix, retrieved 2026-09-10",
    whyNotDownlevelable:
      "Every call site mixes `var()` references, whose values are not known until the cascade runs, "
      + "so the result cannot be folded to a static colour at build time.",
  },
  {
    id: "@container size query",
    detect: /@container\s/,
    support: { chrome: [106, 0], edge: [106, 0], firefox: [110, 0], safari: [16, 0] },
    source: "caniuse.com/css-container-queries, retrieved 2026-09-10",
    whyNotDownlevelable:
      "Querying an ancestor's size is a layout-time question; no static rewrite can answer it, and "
      + "the media-query fallback measures the viewport rather than the container.",
  },
];

/**
 * Constructs that MUST be accounted for before they can ship.
 *
 * This is the half of the guard that keeps the registry honest. Anything matched here has to appear
 * in `FEATURE_SUPPORT` — otherwise a newly adopted feature would silently repeat exactly the drift
 * this file exists to end. The list covers CSS that postdates, or sits near, the current floor;
 * older syntax is irrelevant because it cannot raise the floor.
 *
 * A match is not a verdict. Adding an entry here after checking its support data — or, when
 * Lightning CSS can compile the feature away for the floor, recording that instead — is the
 * intended response to a failure, not deleting the rule from the stylesheet.
 */
export const ACCOUNTABLE_CONSTRUCTS: ReadonlyArray<{ id: string; detect: RegExp }> = [
  { id: ":has()", detect: /:has\(/ },
  { id: "color-mix()", detect: /color-mix\(/ },
  { id: "@container size query", detect: /@container\s/ },
  { id: "@layer", detect: /@layer[\s{]/ },
  { id: "@property", detect: /@property\s/ },
  { id: "@scope", detect: /@scope[\s{]/ },
  { id: "@starting-style", detect: /@starting-style[\s{]/ },
  { id: "@view-transition", detect: /@view-transition[\s{]/ },
  { id: "@position-try", detect: /@position-try\s/ },
  { id: "oklch()", detect: /\boklch\(/ },
  { id: "oklab()", detect: /\boklab\(/ },
  { id: "lch()", detect: /(?<![-\w])lch\(/ },
  { id: "lab()", detect: /(?<![-\w])lab\(/ },
  { id: "subgrid", detect: /\bsubgrid\b/ },
  { id: "text-wrap", detect: /\btext-wrap\s*:/ },
  { id: "field-sizing", detect: /\bfield-sizing\s*:/ },
  { id: "anchor positioning", detect: /\banchor-name\s*:|\bposition-anchor\s*:/ },
  { id: "calc-size()", detect: /\bcalc-size\(/ },
  { id: "interpolate-size", detect: /\binterpolate-size\s*:/ },
  { id: "transition-behavior", detect: /\btransition-behavior\s*:/ },
  { id: ":user-valid / :user-invalid", detect: /:user-(?:in)?valid\b/ },
  { id: "CSS nesting", detect: /^\s*&/m },
];

function compare(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

/** The highest version any listed feature requires, per engine. */
export function requiredFloor(features: readonly CssFeature[] = FEATURE_SUPPORT): SupportMatrix {
  const floor = Object.fromEntries(ENGINES.map((engine) => [engine, [0, 0] as const])) as
    Record<Engine, readonly [number, number]>;
  for (const feature of features) {
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
export function webviewTargets(features: readonly CssFeature[] = FEATURE_SUPPORT): string[] {
  const floor = requiredFloor(features);
  return ENGINES.map((engine) => formatTarget(engine, floor[engine]));
}
