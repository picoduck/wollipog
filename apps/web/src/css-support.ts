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
 *
 * JavaScript the compiler cannot lower is accounted for here as well (`JS_FEATURES`, #3213), and
 * `js-floor.ts` holds the emitted bundle to the result.
 */

import { REGEX_SYNTAX, type RegexSyntaxId } from "./regex-syntax.js";

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

/** What every floor-setting entry carries, whether the stylesheet or the JavaScript needs it. */
export interface FloorRequirement {
  readonly kind: "requires-floor";
  /** Stable id, also the name used in failure messages. */
  readonly id: string;
  /** First version of each engine with full support. */
  readonly support: SupportMatrix;
  /** Where the support data came from, so a reviewer can re-check it rather than trust it. */
  readonly source: string;
  /** Why this cannot simply be compiled away. A downlevelable feature belongs in `Downlevelled`. */
  readonly whyNotDownlevelable: string;
}

/** A CSS feature no compiler can rewrite for an older engine, so it sets the floor. */
export interface RequiresFloor extends FeatureBase, FloorRequirement {}

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

/**
 * A construct whose absence costs nothing anyone would notice.
 *
 * An engine that does not know a property simply drops the declaration, so the app stays correct
 * and merely looks slightly plainer. Raising the compilation floor for one of these would be the
 * opposite of the point: it would drop support for browsers that run the app perfectly well, in
 * exchange for cosmetics. This class exists because an audit of the surface found exactly such a
 * case, and treating it like the others would have pushed the floor to Safari 18.2 for scrollbar
 * styling.
 */
export interface Degrades extends FeatureBase {
  readonly kind: "degrades";
  /** First supporting versions, recorded even though they do not bind, so the call can be re-judged. */
  readonly support: SupportMatrix;
  readonly source: string;
  /** Exactly what a reader loses where it is unsupported. If that is not trivial, it is not this. */
  readonly fallback: string;
}

export type CssFeature = RequiresFloor | Downlevelled | Degrades;

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
 * floor: `:is()`, `:where()`, `content-visibility`, `accent-color`, `inert`, `dvh` units, and `@layer`
 * (cascade layers: Chrome and Edge 99, Firefox 97, Safari 15.4; emitted unchanged by the build).
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
  {
    kind: "degrades",
    id: "scrollbar-width / scrollbar-color",
    detect: /\bscrollbar-(?:width|color)\s*:/i,
    support: { chrome: [121, 0], edge: [121, 0], firefox: [64, 0], safari: [18, 2] },
    source: "caniuse.com/mdn-css_properties_scrollbar-width, retrieved 2026-09-10",
    fallback:
      "The engine ignores the declaration and paints its own scrollbars. Nothing moves, nothing "
      + "becomes unreachable, and the only difference is that the scrollbar is the platform's "
      + "default rather than the app's thinner tinted one.",
  },
  {
    kind: "degrades",
    id: "field-sizing",
    detect: /\bfield-sizing\s*:/i,
    support: { chrome: [123, 0], edge: [123, 0], firefox: [152, 0], safari: [26, 2] },
    source: "caniuse.com/mdn-css_properties_field-sizing, retrieved 2026-10-03",
    fallback:
      "The composer's textarea is grown to its content by the existing JS autosize instead "
      + "(composer-autogrow.ts), which runs only where the engine reports no support. The card grows "
      + "the same way; nothing moves or becomes unreachable.",
  },
  {
    kind: "degrades",
    id: "text-wrap",
    detect: /\btext-wrap\s*:/i,
    support: { chrome: [114, 0], edge: [114, 0], firefox: [121, 0], safari: [17, 5] },
    source: "caniuse.com/css-text-wrap-balance, retrieved 2026-10-13",
    fallback:
      "Connected To's address (#3159) wraps greedily instead of on lines of even length: it still "
      + "breaks only after `.`, `/` and `:` and every character stays on screen, but a phone may "
      + "leave a short last piece such as `net` on a line of its own.",
  },
];

/**
 * A JavaScript construct no compiler can rewrite for an older engine (#3213).
 *
 * Found in the BUILD OUTPUT by `js-floor.ts`, not in source, because dependencies ship them too.
 * The support data is the scanner's own (`REGEX_SYNTAX`), so the floor and the check cannot
 * disagree about what a construct needs.
 */
export interface JsRequiresFloor extends FloorRequirement {
  readonly id: RegexSyntaxId;
}

/**
 * The JavaScript the bundle is allowed to need above what the stylesheet already requires.
 *
 * Regex lookbehind raised the Safari floor from 16.2 to 16.4. Below 16.4 the build turned every
 * lookbehind literal into a `RegExp(...)` call without a warning, and one of them ran at module
 * scope in the shared entry chunk, so the app could not start at all on the engines the floor
 * promised. Removing it was weighed and declined: `remark-gfm`'s email autolinking needs it, so the
 * floor would have rested on a maintained dependency patch, and installed iOS push already needed
 * 16.4.
 */
export const JS_FEATURES: readonly JsRequiresFloor[] = [
  {
    kind: "requires-floor",
    id: "regex lookbehind",
    support: REGEX_SYNTAX["regex lookbehind"].support,
    source: REGEX_SYNTAX["regex lookbehind"].source,
    whyNotDownlevelable:
      "A lookbehind assertion matches on text before the current position without consuming it; "
      + "no regex an older engine accepts expresses that, so the build can only defer the "
      + "SyntaxError to run time. First-party previews, SKILL.md quoting and Markdown table code "
      + "use it, and so does remark-gfm's email autolinking (mdast-util-gfm-autolink-literal).",
  },
];

/** Everything the floor is computed from: the stylesheet's requirements and the JavaScript's. */
export const FLOOR_FEATURES: readonly (CssFeature | JsRequiresFloor)[] = [...CSS_FEATURES, ...JS_FEATURES];

/**
 * The CSS surface the stylesheet is allowed to use.
 *
 * This is an ALLOWLIST, and that inversion is the whole design. The first version of this guard
 * enumerated dangerous constructs instead, and review found hole after hole in it — `@scope(...)`
 * in its compact parenthesised form, `position-area` and bare `anchor()`, `view-transition-name`
 * and the `::view-transition-*` pseudo-elements. Every one was a real bypass, and finding three
 * more would only have proved the approach wrong more slowly: a denylist has to predict what CSS
 * will be invented, which is unbounded, while an allowlist is bounded by what this stylesheet
 * actually contains.
 *
 * So anything the stylesheet uses that is not named here fails the guard — including syntax nobody
 * anticipated. The failure is not an accusation; it asks for one decision, recorded in
 * `CSS_FEATURES`: does this break where it is unsupported (raise the floor), get compiled away, or
 * degrade harmlessly?
 *
 * **How this list was seeded, stated plainly:** it was generated from the shipping stylesheet, not
 * audited property by property against compatibility data. Auditing all of it was out of proportion
 * to the change; what was checked is every entry plausibly newer than the computed floor, which
 * found exactly one thing — the `scrollbar-*` pair, now recorded as `degrades` below. The guarantee
 * starts here: from this commit on, nothing joins the surface without someone looking at it.
 */
export const CSS_SURFACE = {
  atRules: [
  "container", "font-face", "keyframes", "layer", "media",
  ],
  properties: [
  "-webkit-box-orient", "-webkit-font-smoothing", "-webkit-line-clamp",
  "-webkit-tap-highlight-color", "accent-color", "align-content",
  "align-items", "align-self",
  "animation", "animation-delay", "animation-duration", "animation-iteration-count",
  "appearance", "background", "background-clip", "background-position",
  "background-size", "border", "border-bottom", "border-bottom-left-radius",
  "border-bottom-right-radius", "border-collapse", "border-color",
  "border-inline-start", "border-left",
  "border-radius", "border-right", "border-style", "border-top", "border-top-color",
  "border-top-left-radius", "border-top-right-radius", "bottom", "box-shadow", "box-sizing",
  "clip", "clip-path", "color", "color-scheme", "column-gap", "container", "container-type", "content",
  "counter-increment", "counter-reset", "cursor", "direction", "display", "field-sizing", "fill", "filter", "flex",
  "flex-basis", "flex-direction", "flex-shrink", "flex-wrap", "font", "font-display",
  "font-family", "font-size", "font-style", "font-variant-numeric", "font-weight", "gap",
  "grid-area", "grid-auto-columns", "grid-auto-flow", "grid-column", "grid-row",
  "grid-template-columns", "grid-template-rows", "height", "image-rendering", "inset", "isolation",
  "inset-inline-end", "inset-inline-start", "justify-content",
  "justify-items", "justify-self", "left", "letter-spacing", "line-height", "list-style",
  "margin", "margin-bottom", "margin-inline-start", "margin-left",
  "margin-right", "margin-top", "mask-image", "max-height", "max-width", "min-height",
  "min-inline-size", "min-width", "object-fit", "opacity", "order", "outline", "outline-offset",
  "overflow", "overflow-anchor", "overflow-wrap", "overflow-x", "overflow-y",
  "overscroll-behavior", "padding", "padding-block", "padding-bottom", "padding-inline",
  "padding-inline-end", "padding-inline-start", "padding-left", "padding-right", "padding-top",
  "place-items", "pointer-events", "position", "resize", "right", "row-gap",
  "scroll-behavior", "scroll-margin-bottom", "scroll-margin-inline-end", "scroll-padding-inline",
  "scrollbar-color", "scrollbar-width", "src", "stroke", "stroke-linecap", "stroke-width",
  "table-layout", "text-align", "text-decoration", "text-overflow", "text-transform", "text-wrap", "top",
  "touch-action", "transform", "transform-origin", "transition", "transition-duration", "transition-property",
  "user-select", "vertical-align", "visibility", "white-space", "width", "word-break", "writing-mode", "z-index",
  ],
  /** Pseudo-classes and pseudo-elements, without their leading colons. */
  pseudos: [
  "active", "after", "before", "checked", "disabled", "empty", "first-child", "first-of-type", "focus",
  "focus-visible", "focus-within", "has", "hover", "is", "last-child", "not", "nth-child",
  "placeholder", "root", "where",
  ],
  /** Function names appearing in declaration values. */
  functions: [
  "attr", "calc", "color-mix", "conic-gradient", "counter",
  "cubic-bezier", "env", "format", "inset", "linear-gradient", "max", "min", "minmax", "rect",
  "repeat", "rgb", "rgba", "rotate", "scale", "scaley", "translatex", "translatey", "url", "var",
  ],
} as const;

/** The CSS surface a parsed stylesheet actually uses, in the same shape as `CSS_SURFACE`. */
export interface StylesheetSurface {
  readonly atRules: string[];
  readonly properties: string[];
  readonly pseudos: string[];
  readonly functions: string[];
}

/**
 * Strip the parts of a value that are text, not grammar.
 *
 * Everything inside a string is data — a filename, a `content:` glyph, an attribute value — and
 * scanning it for CSS syntax invents features that are not there. `url("foo(bar).svg")` reported a
 * function called `foo`, which would have FAILED the guard on ordinary CSS: a check that rejects
 * valid stylesheets is worse than one that misses an exotic case, because the first stops work and
 * the second only fails to start it.
 */
function withoutStrings(value: string): string {
  return value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
}

/** Stands in for an escaped character: not a letter, digit, hyphen, or colon, so it starts nothing. */
const ESCAPED = "\u0000";

/**
 * Blank backslash escapes before scanning a selector.
 *
 * An escaped character is part of an identifier, not syntax: `.foo\:new-token` is one class whose
 * name contains a colon, and reading that colon as a pseudo invented `:new-token` — valid CSS the
 * guard would have rejected.
 *
 * Blanked, not deleted. Deleting the pair was the first attempt and it merely moved the bug: for
 * `:\hover`, which is a legal spelling of `:hover`, removing `\h` leaves `:over` and invents a
 * pseudo called `over`. Substituting a character that cannot begin an identifier means an escaped
 * name matches nothing at all, which is the right way to be incomplete — the scan produces nothing
 * rather than something wrong. Hex escapes (`:\70 opover-open`) are still unresolved and likewise
 * yield nothing.
 */
function withoutEscapes(selector: string): string {
  return selector.replace(/\\./g, ESCAPED);
}

/**
 * Extract that surface from a parsed stylesheet.
 *
 * Everything is lower-cased, because CSS identifiers are case-insensitive and the allowlist would
 * otherwise be defeated by spelling. `postcss` is passed in structurally rather than imported so
 * this module stays dependency-free for the Vite config that imports it at build time.
 *
 * **What this does NOT see, stated so nobody mistakes the guard for complete.** It reads four
 * dimensions: at-rule names, property names, pseudos, and function names. New grammar that reuses
 * an existing name is invisible to it — a new keyword (`display: masonry`), a new unit (`1rex`), a
 * new at-rule parameter (`@container style(...)`, which is a different feature from a size query
 * and has a later floor), or a new media feature. Escaped identifiers (`:\70 opover-open`) and
 * vendor-prefixed functions are read as text and can also slip.
 *
 * Closing that needs token-aware parsing rather than these scans. Lightning CSS's visitor API can
 * do it and is already in the dependency tree; doing it properly is tracked separately rather than
 * grown further inside the change that fixed the floor. What IS guaranteed here: no new at-rule,
 * property, pseudo, or function reaches the bundle unreviewed, which covers every way the floor has
 * actually gone stale so far.
 */
export function stylesheetSurface(root: {
  walkAtRules(cb: (rule: { name: string }) => void): unknown;
  walkDecls(cb: (decl: { prop: string; value: string }) => void): unknown;
  walkRules(cb: (rule: { selector: string }) => void): unknown;
}): StylesheetSurface {
  const atRules = new Set<string>();
  const properties = new Set<string>();
  const pseudos = new Set<string>();
  const functions = new Set<string>();
  root.walkAtRules((rule) => atRules.add(rule.name.toLowerCase()));
  root.walkDecls((decl) => {
    // Custom property NAMES are the app's own and are case-sensitive, so they are not surface. Their
    // values are scanned like any other, since `--x: oklch(...)` reaches the browser just the same.
    if (!decl.prop.startsWith("--")) properties.add(decl.prop.toLowerCase());
    for (const match of withoutStrings(decl.value).matchAll(/(?<![-\w])([a-z][a-z0-9-]*)\(/gi)) {
      functions.add(match[1]!.toLowerCase());
    }
  });
  root.walkRules((rule) => {
    // Attribute values are data too: `[data-state="x:new-token"]` is not a pseudo-class, and nor is
    // the colon inside an escaped class name.
    for (const match of withoutEscapes(withoutStrings(rule.selector)).matchAll(/::?([a-z][a-z0-9-]*)/gi)) {
      pseudos.add(match[1]!.toLowerCase());
    }
  });
  const sorted = (set: Set<string>) => [...set].sort();
  return {
    atRules: sorted(atRules),
    properties: sorted(properties),
    pseudos: sorted(pseudos),
    functions: sorted(functions),
  };
}

/** Orders two `[major, minor]` versions. */
export function compareVersions(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

type FloorFeature = CssFeature | JsRequiresFloor;

/** Only the entries that constrain the browser floor. */
export function floorSetting(features: readonly FloorFeature[] = FLOOR_FEATURES): FloorRequirement[] {
  return features.filter((feature): feature is RequiresFloor | JsRequiresFloor => feature.kind === "requires-floor");
}

/** The highest version any floor-setting feature requires, per engine. */
export function requiredFloor(features: readonly FloorFeature[] = FLOOR_FEATURES): SupportMatrix {
  const floor = Object.fromEntries(ENGINES.map((engine) => [engine, [0, 0] as const])) as
    Record<Engine, readonly [number, number]>;
  for (const feature of floorSetting(features)) {
    for (const engine of ENGINES) {
      if (compareVersions(feature.support[engine], floor[engine]) > 0) floor[engine] = feature.support[engine];
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
 * One floor for both, computed from `FLOOR_FEATURES`. The compiler lowers most JavaScript to
 * whatever floor this returns, so most JS needs no entry; what it cannot lower — regex syntax above
 * all, #3213 — is registered in `JS_FEATURES` and raises the floor like any CSS requirement, and
 * `js-floor.ts` fails the build when the emitted JavaScript needs anything the floor does not cover.
 */
export function webviewTargets(features: readonly FloorFeature[] = FLOOR_FEATURES): string[] {
  const floor = requiredFloor(features);
  return ENGINES.map((engine) => formatTarget(engine, floor[engine]));
}
