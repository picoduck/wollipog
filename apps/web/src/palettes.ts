import { customProperties, topLevelRule } from "./css-rules.js";
import { COLOR_SCHEMES } from "./theme.js";

/**
 * Resolve the stylesheet's palettes the way the cascade does, for the invariant tests.
 *
 * Every contrast check in this app has to run against ALL of them, because a token name is the
 * only thing those checks name: `--accent` is one value in Wollipog and another in Dracula, and a
 * ratio measured against the first says nothing about the second. Two tests had grown their own
 * block readers for this; the weaker one matched `:root` blocks with a regex, took whichever
 * `#rrggbb` it found, and silently produced Wollipog's values for a scheme whose block it failed to
 * parse — a false pass that looks exactly like a real one. There is one reader now, and it counts
 * what it resolved so a scheme that goes missing is an error rather than a quiet inheritance.
 */

export const BASE_SELECTOR = {
  dark: ':root,\n:root[data-theme="dark"]',
  light: ':root[data-theme="light"]',
} as const;

export type Theme = keyof typeof BASE_SELECTOR;
export const THEMES = Object.keys(BASE_SELECTOR) as Theme[];

/** Wollipog is the base block itself, so it has no `[data-scheme]` pair to read. */
export const ALTERNATIVES = COLOR_SCHEMES.map((s) => s.value).filter((value) => value !== "wollipog");
export const SCHEMES = ["wollipog", ...ALTERNATIVES];

/**
 * Custom properties of one rule, flattened — and a duplicate is an error, not a last-wins read.
 *
 * CSS applies the last of two declarations for the same name, so a block that declares one twice is
 * two people disagreeing about a token. Reporting the first is how that disagreement stays hidden.
 */
export function declaredTokens(rule: Parameters<typeof customProperties>[0], label: string): Map<string, string> {
  const flat = new Map<string, string>();
  for (const [name, values] of customProperties(rule)) {
    if (values.length !== 1) throw new Error(`${label} declares ${name} ${values.length} times`);
    flat.set(name, values[0]!);
  }
  return flat;
}

/** The tokens in force for one scheme and theme: the theme's base block, overlaid by the scheme's. */
export function tokensFor(css: string, scheme: string, theme: Theme): Map<string, string> {
  const merged = declaredTokens(topLevelRule(css, BASE_SELECTOR[theme]), `${theme} base`);
  if (scheme !== "wollipog") {
    const block = topLevelRule(css, `:root[data-scheme="${scheme}"][data-theme="${theme}"]`);
    for (const [name, value] of declaredTokens(block, `${scheme}/${theme}`)) merged.set(name, value);
  }
  if (merged.size <= 40) throw new Error(`${scheme}/${theme} resolved only ${merged.size} tokens`);
  return merged;
}

export interface Palette {
  scheme: string;
  theme: Theme;
  label: string;
  tokens: Map<string, string>;
}

/**
 * Every scheme in every theme — the full set a colour invariant has to hold across.
 *
 * Callers assert on `.length`: a check that iterates whatever it happened to find passes vacuously
 * when it finds nothing, and passes partially when a block stops parsing.
 */
export function everyPalette(css: string): Palette[] {
  return SCHEMES.flatMap((scheme) =>
    THEMES.map((theme) => ({ scheme, theme, label: `${scheme}/${theme}`, tokens: tokensFor(css, scheme, theme) })));
}

const hexToRgb = (hex: string) => {
  const h = hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };

export const luminance = (hex: string) => {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
};

export const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** `over` composited onto `ground` at alpha `t` — what a translucent fill actually renders as. */
export const composite = (ground: string, over: string, t: number) => {
  const g = hexToRgb(ground);
  const o = hexToRgb(over);
  return `#${g.map((v, i) => Math.round(v + (o[i]! - v) * t)).map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

export interface Fill {
  /** Token whose value is being painted, e.g. `--accent`. */
  token: string;
  /** 1 for an opaque paint; the mix percentage for `color-mix(... N%, transparent)`. */
  alpha: number;
}

/**
 * Read a declared `background` as the fill it paints.
 *
 * Only the two forms this stylesheet uses are accepted, and anything else throws rather than
 * defaulting: a background the reader does not understand must not silently resolve to "opaque
 * accent", which is how a check ends up measuring a colour the page never renders.
 */
export function parseFill(value: string): Fill {
  const mixed = /^color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*([\d.]+)%,\s*transparent\)$/.exec(value.trim());
  if (mixed) return { token: mixed[1]!, alpha: alphaOf(`${Number.parseFloat(mixed[2]!) / 100}`, value) };
  const plain = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (plain) return { token: plain[1]!, alpha: 1 };
  throw new Error(`cannot resolve background "${value}" to a fill`);
}

/**
 * A declared `opacity`, as a number — and an error for anything this cannot resolve.
 *
 * `Number.parseFloat` is the wrong reader here and fails OPEN in both directions. It reads `1%` as
 * `1`, so a bar rendered at one per cent measures as fully opaque and clears every contrast floor;
 * and it reads `calc(.6)` as `NaN`, after which `NaN < 3` is false and the failure list stays empty.
 * Either one recreates the exact defect this file exists to catch, with every assertion green.
 */
export function alphaOf(declared: string, context: string): number {
  const trimmed = declared.trim();
  // `Number("")` is 0, not NaN — an empty declaration would otherwise resolve to fully transparent
  // and be accepted as a legitimate alpha.
  const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`cannot resolve opacity "${declared}" in "${context}" to a fraction between 0 and 1`);
  }
  return parsed;
}

/** Resolve a fill against a ground, in one palette. */
export function paint(palette: Palette, fill: Fill, ground: string): string {
  const colour = palette.tokens.get(fill.token);
  // Six-digit hex ONLY, and an error otherwise. A token can carry its own alpha — `--diff-add-bg` is
  // `rgba(63, 185, 80, .14)` in Wollipog dark — and treating every `var()` as opaque is how a
  // see-through fill measures as a solid one.
  if (!colour || !/^#[0-9a-fA-F]{6}$/.test(colour)) {
    throw new Error(`${palette.label}: ${fill.token} is "${colour ?? "undeclared"}", not an opaque literal colour`);
  }
  return fill.alpha === 1 ? colour : composite(ground, colour, fill.alpha);
}
