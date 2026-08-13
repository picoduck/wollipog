import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { customProperties, rulesWith, topLevelRule } from "./css-rules.js";
import { COLOR_SCHEMES } from "./theme.js";

/**
 * The light theme, checked by arithmetic rather than by inspection.
 *
 * Phase 4's premise is that components read only tokens, so a theme is defined in exactly one
 * place and the other theme derives. That premise is unenforceable by reading the CSS: a rule that
 * hardcodes `rgba(248, 81, 73, 0.14)` looks identical to one that derives, and the value is the
 * DARK theme's red, so light mode silently renders the wrong palette. Every `.st-*`, `.tool-*`,
 * `.atag.*` and `.tag-*` tint in the file was in that state.
 *
 * Two properties are checked here, and they fail for different reasons:
 *
 * 1. Text on a tinted fill clears WCAG AA, in BOTH themes, computed from the composited result
 *    rather than from the declared colour. A translucent tint is not the colour it names — it is
 *    that colour blended with whatever is behind it — so the declared value tells you nothing
 *    about legibility.
 * 2. No new hardcoded colour can appear outside the token blocks. Without this the first property
 *    decays the moment someone adds a rule, because a hardcoded pair can be perfectly legible in
 *    dark mode and still be the wrong palette in light.
 */

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

const DARK_SELECTOR = ':root,\n:root[data-theme="dark"]';
const LIGHT_SELECTOR = ':root[data-theme="light"]';

type Theme = "dark" | "light";
/**
 * A palette is a scheme AND a theme, because §6.5 made those two axes.
 *
 * The resolver already took a "theme" and looked its tokens up in a table. Widening that key is the
 * whole change: the same rendered-pair measurement then runs over all ten palettes instead of two,
 * which is the only version of this test that says anything about a scheme a user can actually
 * select. A separate token-by-surface matrix was tried and rejected — it asserts pairings no rule
 * produces, so it would force palette changes for combinations that never render.
 */
type Palette = `${string}:${Theme}`;
interface Rgba { r: number; g: number; b: number; a: number }

function tokenTable(selector: string): Map<string, string> {
  const table = new Map<string, string>();
  for (const [name, values] of customProperties(topLevelRule(css, selector))) {
    table.set(name, values[values.length - 1]!);
  }
  return table;
}

const SCHEMES = ["wollipog", ...COLOR_SCHEMES.map((entry) => entry.value).filter((value) => value !== "wollipog")];

const TOKENS: Record<string, Map<string, string>> = {};
for (const scheme of SCHEMES) {
  // The light block is a colour override, not a full table: anything it does not restate is
  // inherited from the shared `:root`. Resolving light without that fallback would report
  // "unresolvable" for every shared token and quietly shrink the test's coverage. A scheme block
  // is an override on top of that, for the same reason.
  const dark = tokenTable(DARK_SELECTOR);
  const light = new Map([...dark, ...tokenTable(LIGHT_SELECTOR)]);
  if (scheme === "wollipog") {
    TOKENS["wollipog:dark"] = dark;
    TOKENS["wollipog:light"] = light;
    continue;
  }
  TOKENS[`${scheme}:dark`] = new Map([...dark, ...tokenTable(`:root[data-scheme="${scheme}"][data-theme="dark"]`)]);
  TOKENS[`${scheme}:light`] = new Map([...light, ...tokenTable(`:root[data-scheme="${scheme}"][data-theme="light"]`)]);
}
const PALETTES = Object.keys(TOKENS) as Palette[];

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Splits a function's argument list on top-level commas. */
function args(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of inner) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) { out.push(current.trim()); current = ""; continue; }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * Resolves a declared colour to rgba in one theme, or null when it is not a colour this
 * understands. Null means "not checked" and is reported, never silently skipped.
 */
function resolve(value: string, theme: Palette, depth = 0, currentColor: Rgba | null = null): Rgba | null {
  const text = value.trim();
  if (depth > 8) return null;
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  // `currentColor` is the element's own computed `color`, which the caller supplies when it knows
  // it. Substituting --text unconditionally produced a DEFINITE WRONG ANSWER rather than a refusal:
  // `color: var(--bg); background: currentColor` renders 1:1 and was certified as --text on --bg.
  // A wrong number is worse than no number, so without context this is unresolved.
  if (text === "currentColor") return currentColor;
  // `inherit` is whatever an ancestor set, which the stylesheet alone cannot say. Substituting
  // --text was the same mistake as currentColor in a second place: `background: inherit` on a row
  // whose parent sets --bg renders 1:1 and was certified as --text on --bg. Refused, and reported.
  if (text === "inherit") return null;

  const hex = text.match(HEX);
  if (hex) {
    const digits = hex[1]!.length === 3 ? hex[1]!.split("").map((d) => d + d).join("") : hex[1]!;
    const n = Number.parseInt(digits, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }

  const rgb = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/);
  if (rgb) {
    // Chromium CLAMPS out-of-range components; `rgb(500 500 500)` is white. Keeping 500 produced a
    // luminance of 4.73 and certified 4.55:1 for a pairing that renders at 1:1.
    const clamp = (value: number, high: number) => Math.min(high, Math.max(0, value));
    const channels = [+rgb[1]!, +rgb[2]!, +rgb[3]!];
    const alpha = rgb[4] === undefined ? 1 : +rgb[4];
    if (![...channels, alpha].every(Number.isFinite)) return null;
    return {
      r: clamp(channels[0]!, 255), g: clamp(channels[1]!, 255), b: clamp(channels[2]!, 255),
      a: clamp(alpha, 1),
    };
  }

  const varMatch = text.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/);
  if (varMatch) {
    const declared = TOKENS[theme].get(varMatch[1]!);
    if (declared !== undefined) return resolve(declared, theme, depth + 1);
    return varMatch[2] ? resolve(varMatch[2], theme, depth + 1) : null;
  }

  const mix = text.match(/^color-mix\(\s*in\s+srgb\s*,\s*(.+)\)$/i);
  if (mix) {
    const parts = args(mix[1]!);
    if (parts.length !== 2) return null;
    const parsed = parts.map((part) => {
      const percent = part.match(/^(.*?)\s+([\d.]+)%$/);
      return percent
        ? { colour: resolve(percent[1]!, theme, depth + 1), weight: Number(percent[2]) / 100 }
        : { colour: resolve(part, theme, depth + 1), weight: null as number | null };
    });
    const [first, second] = parsed as [typeof parsed[0], typeof parsed[0]];
    if (!first.colour || !second.colour) return null;
    if ([first.weight, second.weight].some((w) => w !== null && (w < 0 || w > 1))) return null;
    // Exactly one weight given is the common form; the other takes the remainder.
    const w1 = first.weight ?? (second.weight === null ? 0.5 : 1 - second.weight);
    const w2 = second.weight ?? 1 - w1;
    const total = w1 + w2;
    if (total === 0) return null;
    // color-mix in srgb interpolates PREMULTIPLIED, which is what makes
    // `color-mix(in srgb, X n%, transparent)` equal to X at alpha n.
    const a = (first.colour.a * w1 + second.colour.a * w2) / total;
    const channel = (key: "r" | "g" | "b") => {
      const premultiplied = (first.colour!.a * first.colour![key] * w1 + second.colour!.a * second.colour![key] * w2) / total;
      return a === 0 ? 0 : premultiplied / a;
    };
    // When BOTH percentages are explicit and total under 100%, CSS normalises the proportions and
    // then multiplies the result's alpha by that total. Omitting the second step reported
    // `color-mix(in srgb, var(--accent) 9%, var(--on-accent) 1%)` as an opaque 7.75:1 fill when
    // Chromium renders it at 10% alpha and about 3.80:1 — a wrong number, presented as certified.
    const scale = first.weight !== null && second.weight !== null ? Math.min(total, 1) : 1;
    return { r: channel("r"), g: channel("g"), b: channel("b"), a: a * scale };
  }

  return null;
}

/**
 * The colour stops of a linear-gradient, or null when the value is not one.
 *
 * The leading angle or side keyword is dropped; a stop's optional position is dropped with it,
 * because the SET of colours along the sweep does not depend on where the stops sit.
 */
function gradientStops(value: string): string[] | null {
  const match = value.trim().match(/^linear-gradient\(\s*(.+)\)$/i);
  if (!match) return null;
  const parts = args(match[1]!);
  if (parts.length === 0) return null;
  const stops = /^(to\s|[\d.]+(deg|rad|turn|grad)\b)/i.test(parts[0]!) ? parts.slice(1) : parts;
  const colours = stops.map((part) => part.replace(/\s+-?[\d.]+%\s*$/, "").trim()).filter(Boolean);
  // Fewer than two stops is INVALID: Chromium drops the whole declaration and paints what is
  // underneath, so certifying the single stop describes a fill that never renders.
  return colours.length >= 2 ? colours : null;
}

/** How many points to sample between consecutive gradient stops, inclusive of both ends. */
const GRADIENT_SAMPLES = 257;

/**
 * Every colour a gradient paints, sampled — not just its stops.
 *
 * Checking endpoints only is unsound, and not by a technicality: relative luminance can have an
 * INTERIOR MINIMUM along an sRGB interpolation when channels move in opposite directions, so both
 * ends can clear AA while the middle does not. `linear-gradient(#ff00ff, #00ff00)` under near-black
 * text measures 5.28:1 and 12.07:1 at the ends and 4.16:1 at the midpoint that Chromium actually
 * paints under the label. The endpoint claim happened to hold for the four gradients in this file,
 * which is luck, not a bound.
 *
 * Sampling is not a proof either — it is a dense check with a stated resolution, which is an
 * honest thing to be. Interpolation is premultiplied, matching CSS.
 */
function sampleGradient(stops: Rgba[]): Rgba[] {
  const samples: Rgba[] = [];
  for (let index = 0; index + 1 < stops.length; index += 1) {
    const from = stops[index]!;
    const to = stops[index + 1]!;
    for (let step = 0; step < GRADIENT_SAMPLES; step += 1) {
      const t = step / (GRADIENT_SAMPLES - 1);
      const a = from.a * (1 - t) + to.a * t;
      const channel = (key: "r" | "g" | "b") => {
        const premultiplied = from.a * from[key] * (1 - t) + to.a * to[key] * t;
        return a === 0 ? 0 : premultiplied / a;
      };
      samples.push({ r: channel("r"), g: channel("g"), b: channel("b"), a });
    }
  }
  return samples.length > 0 ? samples : stops;
}

/** Composites a possibly-translucent colour over an opaque backdrop. */
function over(top: Rgba, bottom: Rgba): Rgba {
  return {
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  };
}

function luminance({ r, g, b }: Rgba): number {
  const channel = (raw: number) => {
    const value = raw / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The surfaces a tinted element can sit on.
 *
 * The stylesheet does not record which one any given rule lands on, and guessing a single surface
 * would make the check depend on the guess rather than on the CSS. Every candidate is tested and
 * the WORST is the one that must pass, so the assertion holds wherever the element is actually
 * used — including somewhere it is moved to later.
 */
const SURFACES = ["--bg", "--bg-elev", "--bg-elev-2", "--bg-elev-3"] as const;

const AA_NORMAL = 4.5;
const AA_NON_TEXT = 3;

/**
 * Rules whose `color` paints a GLYPH rather than text, where WCAG's bar is 3:1, not 4.5:1.
 *
 * Kept to selectors that render no text at all, each named individually — a pattern would quietly
 * grow to cover things that do have labels. Applying 4.5:1 everywhere is not "stricter", it is
 * wrong about the standard, and a wrong threshold gets relaxed rather than fixed the first time it
 * blocks something.
 */
const ICON_ONLY = new Set([
  // The microphone GLYPH, not the button: scoping the exemption to the svg makes it structurally
  // true, so giving the control a visible label later cannot silently inherit the looser bar.
  ".voice-btn.voice-recording > svg",
]);

/**
 * Properties that repaint glyphs after `color` has been resolved.
 *
 * `color: var(--text); -webkit-text-fill-color: var(--bg)` renders at 1:1 while every value is
 * token-derived, so both assertions passed. Rather than model these, a rule that uses one is
 * refused: the check's claim is about what renders, and it cannot make that claim here.
 */
const ALTERNATE_TEXT_PAINT = ["-webkit-text-fill-color", "-webkit-background-clip", "background-clip"];

/** The two token-block selector sets, which are definitions rather than component rules. */
const TOKEN_BLOCK_SELECTORS = new Set([DARK_SELECTOR, LIGHT_SELECTOR].map((s) => s.replace(/\s+/g, " ")));

/**
 * WHAT THIS PROVES, AND WHAT IT DOES NOT.
 *
 * Three review rounds established the boundary empirically, so it is stated rather than implied.
 *
 * It proves: every rule that declares BOTH a text colour and a fill resolves, in both themes, to a
 * pair clearing 4.5:1 over any of the four base surfaces. That is a real property, it caught 38
 * rules that had never been measured, and it fails when a token regresses.
 *
 * It does NOT prove that the app renders at AA. It reads declarations, so it cannot see the
 * cascade, an ancestor's tint, or a descendant inheriting one — and every round found production
 * text failing exactly there: the diff gutter, then `.slash-src`, `.approval-title`,
 * `.approval-text`, `.diff-syntax-comment`. Each was fixed; none was found BY this check.
 *
 * The gap is not a threshold to tighten. A static reader cannot compute what Chromium composites,
 * and patching it against that claim is what the last two rounds were. Closing it means measuring
 * rendered pixels on whole screens, which is §25 and §26's machinery and its own piece of work.
 */
test("every declared colour/fill pair clears WCAG AA in both themes", () => {
  const tinted = rulesWith(css, ["color", "background"], ALTERNATE_TEXT_PAINT)
    .concat(rulesWith(css, ["color", "background-color"], ALTERNATE_TEXT_PAINT))
    // Only the token blocks themselves. Filtering every selector STARTING WITH `:root` also
    // discarded theme-scoped component rules — `:root[data-theme="dark"] .btn.primary` carries the
    // exact pair this check exists to measure, and was silently dropped.
    .filter(({ selector }) => !TOKEN_BLOCK_SELECTORS.has(selector));

  assert.ok(tinted.length > 40,
    `expected the stylesheet to pair a colour and a fill in many rules, found ${tinted.length}`);

  const unresolved: string[] = [];
  const failures: string[] = [];
  let checked = 0;

  for (const { selector, declarations } of tinted) {
    const fillValue = declarations.background ?? declarations["background-color"]!;
    const repaint = ALTERNATE_TEXT_PAINT.filter((prop) => prop in declarations);
    if (repaint.length > 0) {
      unresolved.push(`${selector}: repaints glyphs via ${repaint.join(", ")}`);
      continue;
    }
    // No fill at all means the text sits on whatever is behind the element, which the surface
    // pairs in `theme.test.ts` already cover. There is no tint here to check.
    if (fillValue === "none" || fillValue === "transparent") continue;
    // An image is not a colour. Reported, not skipped: `background: linear-gradient(var(--bg),
    // var(--bg)), url("")` made a 1:1 button and simply left the loop.
    if (/url\(/i.test(fillValue)) {
      unresolved.push(`${selector}: fill contains an image — ${fillValue}`);
      continue;
    }

    // A gradient is sampled across its whole sweep, not just its stops. Skipping gradients
    // entirely left the two rules this phase exists to fix — .btn.primary and .user-bubble, both
    // gradients — covered only by the "no hardcoded colour" test, which cannot see contrast.
    const stopValues = gradientStops(fillValue);

    for (const theme of PALETTES) {
      const text = resolve(declarations.color!, theme);
      if (!text) {
        unresolved.push(`${selector} (${theme}): color=${declarations.color}`);
        continue;
      }
      let fills: Rgba[];
      if (stopValues) {
        const stops = stopValues.map((stop) => resolve(stop, theme, 0, text));
        if (stops.some((stop) => !stop)) {
          unresolved.push(`${selector} (${theme}): gradient stop in ${fillValue}`);
          continue;
        }
        fills = sampleGradient(stops as Rgba[]);
      } else {
        const fill = resolve(fillValue, theme, 0, text);
        if (!fill) {
          unresolved.push(`${selector} (${theme}): background=${fillValue}`);
          continue;
        }
        fills = [fill];
      }

      const floor = ICON_ONLY.has(selector) ? AA_NON_TEXT : AA_NORMAL;
      for (const fill of fills) {
        // An opaque fill is its own backdrop; a translucent one takes the surface behind it.
        const backdrops = fill.a >= 1
          ? [fill]
          : SURFACES.map((name) => resolve(`var(${name})`, theme)!).map((surface) => over(fill, surface));
        for (const backdrop of backdrops) {
          checked += 1;
          const ratio = contrast(over(text, backdrop), backdrop);
          if (ratio < floor) {
            failures.push(`${selector} (${theme}): ${ratio.toFixed(2)}:1, below ${floor}:1 [ink=${declarations.color} fill=${fillValue}]`);
          }
        }
      }
    }
  }

  assert.ok(checked > 200, `expected to check many pairs, checked ${checked}`);
  // Reported rather than tolerated: an unresolvable value is coverage this test does not have, and
  // a silent skip is how a check quietly stops checking anything.
  assert.deepEqual(unresolved, [], "every colour pair must be resolvable, or the check is not running");
  assert.deepEqual(failures, [],
    "a DECLARED colour/fill pair must clear 4.5:1 on any base surface — see the note above for what this does not cover");
});
