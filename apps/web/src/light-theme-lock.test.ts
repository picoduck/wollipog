import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { allDeclarations, customProperties, topLevelRule } from "./css-rules.js";

/**
 * The regression lock, over the PARSED stylesheet rather than its source lines.
 *
 * `light-theme.test.ts` proves the colours that exist today are legible in both themes. Without a
 * lock it decays on the next commit: a new rule can hardcode a perfectly legible dark-mode pair and
 * still be the wrong palette in light, and nothing would notice.
 *
 * The first version of this scanned source lines, and every one of its three mechanisms was a hole:
 *
 * - It exempted a whole SOURCE LINE when any allowlist pattern matched it, so an allowed black
 *   shadow carried an unrelated fixed magenta border on the same line through with it.
 * - It recognised hex and lowercase `rgb()`/`rgba()` only, so `hsl()`, `HWB()`, `oklch()`,
 *   `color()` and every CSS named colour walked straight past.
 * - Its comment and `.hljs` tracking were string-unaware: a `content` value containing a comment
 *   opener hid the rest of the file until an unrelated closer, and a one-line highlight rule left
 *   the exemption latched on for whatever followed it.
 *
 * postcss already knows where a declaration starts and ends, which selector owns it, and what its
 * value is. Every colour occurrence is judged on its own now, against a (selector, property, value)
 * exemption rather than a line match. Phase 9 turns this into a Stylelint rule; it is a test first
 * because a test ships now.
 */

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

const DARK_SELECTOR = ':root,\n:root[data-theme="dark"]';
const LIGHT_SELECTOR = ':root[data-theme="light"]';
/**
 * The scheme blocks are token blocks too.
 *
 * §6.5 adds four alternative palettes, each a pair of `[data-scheme][data-theme]` blocks that
 * declare the SAME token names with different values. They are exactly what this test exists to
 * require — literals confined to a palette block — so they are recognised by shape rather than
 * listed by name, and a fifth scheme needs no edit here.
 */
const SCHEME_BLOCK = /^:root\[data-scheme="[a-z-]+"\]\[data-theme="(dark|light)"\]$/;
const TOKEN_BLOCKS = new Set([DARK_SELECTOR, LIGHT_SELECTOR].map((s) => s.replace(/\s+/g, " ")));
const isTokenBlock = (selector: string) =>
  TOKEN_BLOCKS.has(selector.replace(/\s+/g, " ")) || SCHEME_BLOCK.test(selector.trim());

const COLOUR_FUNCTION = "\\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\([^)]*\\)";
const HEX_LITERAL = "#[0-9a-fA-F]{3,8}\\b";

/** CSS named colours. `transparent` and `currentColor` are keywords, not palette data. */
const NAMED = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue "
  + "blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan "
  + "darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen "
  + "darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey "
  + "darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite "
  + "forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink "
  + "indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral "
  + "lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen "
  + "lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta "
  + "maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue "
  + "mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin "
  + "navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen "
  + "paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red "
  + "rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue "
  + "slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white "
  + "whitesmoke yellow yellowgreen").split(" "));

/** Properties whose value can carry a colour. Anything else cannot introduce palette data. */
const COLOUR_PROPS =
  /^(color|background|background-color|background-image|border(-(top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?-color|border|border-(top|right|bottom|left|block|inline)|outline|outline-color|box-shadow|text-shadow|text-emphasis-color|text-decoration|text-decoration-color|-webkit-text-stroke|-webkit-text-stroke-color|-webkit-text-fill-color|fill|stroke|flood-color|lighting-color|stop-color|caret-color|accent-color|column-rule|column-rule-color|scrollbar-color)$/;

/** `Background:` is the same property as `background:`; custom-property names ARE case-sensitive. */
function normalisedProp(prop: string): string {
  return prop.startsWith("--") ? prop : prop.toLowerCase();
}

const isColourProp = (prop: string) => prop.startsWith("--") || COLOUR_PROPS.test(normalisedProp(prop));

/** Colour-looking tokens in a value, with comments and `var()` calls removed first. */
/**
 * Strips CSS comments, leaving quoted strings and `url()` contents alone.
 *
 * A raw comment regex re-introduced exactly the bug the AST rewrite removed, one level down:
 * `url("/*")` … `url("*​/")` are two valid URL layers to postcss, and the regex deleted everything
 * between them — including a fixed gradient in the middle, which then rendered at 1:1 with the
 * scanner reporting no colour at all.
 */
function stripComments(value: string): string {
  let out = "";
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      out += char;
      if (char === quote && value[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; out += char; continue; }
    if (char === "/" && value[index + 1] === "*") {
      const close = value.indexOf("*/", index + 2);
      if (close === -1) return out;
      index = close + 1;
      out += " ";
      continue;
    }
    out += char;
  }
  return out;
}

export function literalColours(value: string): string[] {
  let text = stripComments(value);
  // Strip var() calls, keeping any FALLBACK so a literal hidden in one is still examined.
  for (let pass = 0; pass < 8 && /var\(/.test(text); pass += 1) {
    const before = text;
    text = text.replace(/var\(\s*--[\w-]+\s*\)/g, " ");
    text = text.replace(/var\(\s*--[\w-]+\s*,\s*([^()]*)\)/g, " $1 ");
    if (text === before) break;
  }
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(COLOUR_FUNCTION, "gi"))) found.push(match[0]);
  for (const match of text.matchAll(new RegExp(HEX_LITERAL, "g"))) found.push(match[0]);
  for (const word of text.match(/[a-zA-Z][\w-]*/g) ?? []) if (NAMED.has(word.toLowerCase())) found.push(word);
  return found;
}

interface Exemption {
  why: string;
  matches: (declaration: { selectors: string[]; prop: string; value?: string }, colour: string) => boolean;
}

/**
 * Each entry names the (selector, property, value) it covers and why that value is FIXED rather
 * than theme data. A pattern that matches anywhere is not an exception, it is a hole.
 */
const EXEMPTIONS: Exemption[] = [
  {
    // Restricted to depth: a neutral black is theme-agnostic as a SHADOW, and is not licence to
    // paint black text or a black surface, which the property check keeps out.
    why: "neutral black at low alpha reads as depth on either ground, so a shadow is not theme data",
    matches: (declaration, colour) => {
      const prop = normalisedProp(declaration.prop);
      const shadow = /^(box-shadow|text-shadow)$/.test(prop) || /^--(elev|shadow)/.test(prop);
      // A SCRIM is a named list, not "any background": `background: black` on a button is not depth.
      const scrim = /^(background|background-color)$/.test(prop)
        && declaration.selectors.every((selector) => new Set([".image-remove", ".menu-backdrop", ".palette-backdrop"]).has(selector));
      if (!shadow && !scrim) return false;
      // Low alpha is part of the rationale, so it is part of the rule. Opaque black is theme data.
      const rgba = colour.match(/^rgba?\(\s*0[\s,]+0[\s,]+0\s*[,/]\s*([\d.]+)\s*\)$/i);
      if (rgba) return Number(rgba[1]) <= 0.7;
      // `black` only inside a color-mix that dilutes it, which the value carries.
      return /^black$/i.test(colour) && /color-mix\(/i.test(declaration.value ?? "");
    },
  },
  {
    why: "white ON a saturated semantic fill, a black scrim, a scanner's quiet zone, or a frame "
      + "around externally-themed content",
    matches: (declaration, colour) =>
      /^#(fff|ffffff)$/i.test(colour)
      && declaration.selectors.length > 0
      // Each entry names the PROPERTY that needs white, not just the selector: a white background
      // on the voice button is a different claim from white text on it.
      && declaration.selectors.every((selector) => (new Map([
        [".voice-btn.voice-recording > svg", "color"],
        [".image-remove", "color"],
        // These frame an iframe carrying its own theme; tinting them shows through it.
        [".artifact-preview-frame", "background"],
        [".browser-web-frame", "background"],
        [".access-pairing-qr-frame", "background"],
      ]).get(selector)) === normalisedProp(declaration.prop)),
  },
  {
    why: "vendor brand marks — fixed by OpenAI, Anthropic and Google, not by us",
    matches: (declaration, colour) =>
      /^#(10a37f|d97757|4285f4)$/i.test(colour)
      && declaration.selectors.length > 0
      && declaration.selectors.every((selector) => /^\.agent-(openai|anthropic|google)$/.test(selector)),
  },
  {
    why: "the syntax-highlight palette is a deliberate PAIR of palettes, not one derived twice",
    // EVERY selector in the rule must be highlight-scoped, so a selector group cannot smuggle an
    // unrelated one in alongside `.hljs-keyword`.
    matches: (declaration) =>
      declaration.selectors.length > 0 && declaration.selectors.every((selector) => /\.hljs\b/.test(selector)),
  },
];

test("no colour is hardcoded outside the token blocks", () => {
  const offenders: string[] = [];
  let inspected = 0;
  for (const declaration of allDeclarations(css)) {
    // The token blocks ARE the theme data; the next test covers them instead.
    if (isTokenBlock(declaration.selector)) continue;
    if (!isColourProp(declaration.prop)) continue;
    inspected += 1;
    for (const colour of literalColours(declaration.value)) {
      if (EXEMPTIONS.some((exemption) => exemption.matches(declaration, colour))) continue;
      offenders.push(`${declaration.line}: ${declaration.selector} { ${declaration.prop}: ${colour} }`);
    }
  }
  assert.ok(inspected > 500, `expected to inspect most of the stylesheet, inspected ${inspected} declarations`);
  assert.deepEqual(offenders, [],
    "hardcoded colours are one theme's values; declare a token and reference it");
});

/**
 * A literal colour token declared only in the shared/dark block IS the dark theme's value, and the
 * light table inherits everything it does not restate. So `--new-panel-bg: #0d1117` in the shared
 * block, referenced by a component, renders the dark surface on a white page — with every rule
 * dutifully going through a token and the lock above green.
 *
 * Tokens whose value is DERIVED (a live `var()` or `color-mix()`) are exempt by construction: they
 * re-resolve per theme, which is the whole point of the `--*-on-tint` family.
 */
test("every literal colour token has a value in both themes", () => {
  // Two top-level blocks carry dark's values: the theme block and the additive design-token
  // `:root` that holds the elevation ramp. Reading only the first reported the ramp as light-only.
  const dark = new Map([
    ...customProperties(topLevelRule(css, ":root")),
    ...customProperties(topLevelRule(css, DARK_SELECTOR)),
  ]);
  const light = customProperties(topLevelRule(css, LIGHT_SELECTOR));

  /** Genuinely fixed across themes, each with its reason. */
  const CROSS_THEME = new Map([
    ["--on-accent-deep", "white text on a deep teal fill, in either theme"],
    ["--on-primary-pressed", "the pressed primary label, dark-on-teal in dark and white-on-teal in light — both blocks declare it"],
  ]);

  const missing: string[] = [];
  const check = (from: Map<string, string[]>, to: Map<string, string[]>, side: string) => {
    for (const [name, values] of from) {
      const value = values[values.length - 1]!;
      // A literal HIDDEN IN A FALLBACK is still a literal: `var(--maybe, #0d1117)` was skipped
      // because the value contained `var(`, and literalColours() keeps fallbacks for this reason.
      if (literalColours(value).length === 0) continue;
      if (to.has(name)) continue;
      if (CROSS_THEME.has(name)) continue;
      missing.push(`${side} only — ${name}: ${value}`);
    }
  };
  check(dark, light, "dark");
  // Both directions: a light-only literal token is the same defect mirrored, and dark inherits
  // nothing for it at all.
  check(light, dark, "light");
  assert.deepEqual(missing, [],
    "a literal colour token with no light value is the dark theme's palette leaking into light mode");
});

/**
 * Whole-subtree `opacity` is how a certified colour becomes an uncertified one.
 *
 * Every contrast check in this repo reads an element's OWN declarations. `opacity` on an ancestor
 * multiplies into everything beneath it and changes none of them, so a badge measured at 4.6:1 can
 * render at 2.8:1 with its own rule untouched — which is exactly what `opacity: 0.68` on resolved
 * review findings, and `0.62` on unavailable shortcut rows, were doing.
 *
 * Modelling that statically means resolving the whole ancestor chain for every element, which the
 * stylesheet cannot express. Forbidding the MECHANISM is enforceable and has a cheap alternative:
 * de-emphasise with a token. Genuinely inactive controls are exempt — WCAG 1.4.3 excludes them, and
 * a disabled button is not documentation.
 */
const re_keyframe = /^(from|to|[\d.]+%)$/;

test("nothing fades a subtree with opacity except an inactive control", () => {
  /**
   * Selectors allowed to dim, each because what it dims is NOT text a person has to read.
   * Curated deliberately: a pattern broad enough to cover them all would cover a paragraph too,
   * and this guard exists precisely because the arithmetic checks cannot see an ancestor.
   */
  // EXACT selectors, not substrings. `.disabled` matched `.disabled-explainer`, which is prose.
  const ALLOWED = new Map<string, string>([
    ["0%, 80%, 100%", "a keyframe step: the animation's REST state is what has to be readable"],
    ["50%", "a keyframe step"],
    [".subagent-icon", "a decorative glyph beside a label that is not itself dimmed"],
    [".dir-icon", "a decorative glyph beside a label that is not itself dimmed"],
    [".working-dots span", "three animated dots, purely decorative"],
    [".usage-cost-bar", "a bar chart's fill, not text"],
    [".ui-row-switch.is-busy .ui-switch",
      "the switch track and knob, non-text; #214 measured 0.85 to hold the track's 3:1 border"],
    [".loc-pick:disabled", "an inactive control, which WCAG 1.4.3 exempts"],
  ]);
  /** An inactive control, which WCAG 1.4.3 exempts from the contrast requirement. */
  const INACTIVE = [":disabled", "[disabled]", "[aria-disabled", ".is-disabled"];
  const isExempt = (selector: string) => ALLOWED.has(selector)
    || INACTIVE.some((marker) => selector.includes(marker))
    // A keyframe step: the animation's REST state is what has to be readable, and postcss reports
    // `0%, 80%, 100%` as three separate selectors.
    || re_keyframe.test(selector);
  const offenders: string[] = [];
  for (const declaration of allDeclarations(css)) {
    const prop = normalisedProp(declaration.prop);
    // `filter: opacity(.3)` dims a subtree exactly as `opacity` does, and was not looked at.
    const viaFilter = prop === "filter" && /opacity\(/i.test(declaration.value);
    if (prop !== "opacity" && !viaFilter) continue;
    const raw = declaration.value.trim();
    // A value this cannot read — calc(), var(), a percentage — is not evidence of anything, so it
    // is rejected rather than skipped. `opacity: var(--x)` slipped straight through Number.parseFloat.
    const numeric = /^[\d.]+$/.test(raw) ? Number.parseFloat(raw) : NaN;
    if (!viaFilter && Number.isFinite(numeric) && (numeric <= 0 || numeric >= 1)) continue;
    if (declaration.selectors.every(isExempt)) continue;
    offenders.push(`${declaration.line}: ${declaration.selector} { ${declaration.prop}: ${raw} }`);
  }
  assert.deepEqual(offenders, [],
    "subtree opacity silently un-certifies every colour beneath it; de-emphasise with a token instead");
});
