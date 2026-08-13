export const THEME_STORAGE_KEY = "wollipog.theme";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export const THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  description: string;
}> = [
  { value: "system", label: "System", description: "Follow this device's appearance" },
  { value: "light", label: "Light", description: "Always use the light palette" },
  { value: "dark", label: "Dark", description: "Always use the dark palette" },
];

/**
 * The colour scheme, which is a different axis from light/dark.
 *
 * Wollipog is the default and is derived from the logo — the measured palette is a steel-blue
 * ground, the bill and belly's turquoise as the accent, and the headphones' orange beside it. The
 * other four are the most-installed themes in the VS Code Marketplace, by install count read from
 * its API rather than by reputation: Catppuccin and Nord are the ones people name, and both sit an
 * order of magnitude lower (1.3M each).
 */
export type ColorScheme = "wollipog" | "github" | "one-dark" | "dracula" | "monokai";

export const COLOR_SCHEMES: ReadonlyArray<{
  value: ColorScheme;
  label: string;
  description: string;
}> = [
  { value: "wollipog", label: "Wollipog", description: "The logo's teal and orange on slate" },
  { value: "github", label: "GitHub", description: "Primer's canvas and blue" },
  { value: "one-dark", label: "One Dark", description: "Atom's original, and VS Code's most installed" },
  { value: "dracula", label: "Dracula", description: "Purple and pink on charcoal" },
  { value: "monokai", label: "Monokai", description: "The Sublime classic" },
];

/**
 * Three colours per palette, so the picker can show a scheme it is not currently rendering.
 *
 * Every other palette read in this file goes through `paletteColor`, which asks the DOCUMENT — the
 * rule this codebase has spent three PRs enforcing, because a second description of the palette
 * drifts. That rule cannot apply here, and the reason is structural rather than a preference: the
 * scheme blocks are scoped `:root[data-scheme="x"][data-theme="y"]`, so exactly ONE scheme's tokens
 * are in the cascade at a time. Asking the document for Dracula's accent while Wollipog is applied
 * returns Wollipog's, and a picker showing five swatches needs four palettes that are not on screen.
 *
 * So this is a literal map, and the drift it invites is closed by a test rather than by a promise:
 * `colour-schemes.test.ts` resolves all five schemes in both themes with `tokensFor` and asserts
 * every hex below is character for character the stylesheet's value — and asserts the COUNT of
 * comparisons it made, so a scheme dropped from this map narrows the check loudly instead of
 * quietly.
 *
 * The three tokens are the ground, the accent and the secondary accent: enough to tell Dracula's
 * purple from Monokai's cyan and Wollipog's teal at 10px. All three are literal hexes in every
 * block, which several other candidates are not — the on-tint and border families are `color-mix()`
 * derived and have no hex to compare against.
 */
export const SWATCH_TOKENS = ["--bg", "--accent", "--accent-2"] as const;

export type SchemeSwatch = readonly [string, string, string];

export const SCHEME_SWATCHES: Readonly<Record<ColorScheme, Readonly<Record<ResolvedTheme, SchemeSwatch>>>> = {
  wollipog: {
    dark: ["#0b1118", "#45d6cc", "#ef8f3f"],
    light: ["#f6f8fa", "#055d56", "#bc4c00"],
  },
  github: {
    dark: ["#0d1117", "#4896f8", "#dc7b3e"],
    light: ["#ffffff", "#0b62cb", "#ac4804"],
  },
  "one-dark": {
    dark: ["#24272f", "#61afef", "#d19a66"],
    light: ["#fafafa", "#3d5ca6", "#7c5a14"],
  },
  dracula: {
    dark: ["#282a36", "#caaaf8", "#ffb86c"],
    light: ["#fffbeb", "#644ac9", "#9c4a15"],
  },
  monokai: {
    dark: ["#272822", "#66d9ef", "#fd971f"],
    light: ["#fdfdf6", "#0d6c7e", "#9d4d0c"],
  },
};

export const SCHEME_STORAGE_KEY = "wollipog.scheme";

export function parseColorScheme(value: string | null | undefined): ColorScheme {
  return COLOR_SCHEMES.some((scheme) => scheme.value === value) ? (value as ColorScheme) : "wollipog";
}

export function applySchemeToDocument(document: Document, scheme: ColorScheme): void {
  // Wollipog is the plain `[data-theme]` block, so it is the ABSENCE of the attribute rather than a
  // value of it. Setting `data-scheme="wollipog"` would need a fifth pair of blocks duplicating the
  // default, and duplicated tokens drift.
  if (scheme === "wollipog") delete document.documentElement.dataset.scheme;
  else document.documentElement.dataset.scheme = scheme;
}

/**
 * How much air a row of content sits in.
 *
 * COMPACT IS THE DEFAULT and is what ships today — §F8 found the app already dense, so "compact" is
 * a name for the existing spacing rather than a new tighter mode. That makes it the absence of the
 * attribute, exactly as Wollipog is for schemes, and the default renders byte for byte as before.
 * Comfortable is additive.
 */
export type Density = "compact" | "comfortable";

export const DENSITY_OPTIONS: ReadonlyArray<{ value: Density; label: string; description: string }> = [
  { value: "compact", label: "Compact", description: "More on screen at once" },
  { value: "comfortable", label: "Comfortable", description: "More room around each row" },
];

export const DENSITY_STORAGE_KEY = "wollipog.density";

export function parseDensity(value: string | null | undefined): Density {
  return value === "comfortable" ? "comfortable" : "compact";
}

export function applyDensityToDocument(document: Document, density: Density): void {
  if (density === "compact") delete document.documentElement.dataset.density;
  else document.documentElement.dataset.density = density;
}

export function parseThemePreference(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

/**
 * A palette token as the document currently renders it.
 *
 * The browser chrome and the terminal used hardcoded Wollipog values, so a Dracula user got
 * Wollipog's slate behind the address bar and Wollipog's teal cursor. The fix is NOT a per-scheme
 * table in JavaScript — that is a second description of the palette, and a second description
 * drifts. The stylesheet already holds the answer for whichever scheme is applied; this reads it.
 *
 * `fallback` is for a non-browser caller with no computed styles at all, not for a missing token:
 * a token that resolves to nothing in a real document is a bug the tests below catch.
 */
export function paletteColor(token: string, fallback: string, doc: Document | undefined = globalThis.document): string {
  try {
    const value = doc?.defaultView?.getComputedStyle(doc.documentElement).getPropertyValue(token).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

export function themeColor(theme: ResolvedTheme, doc?: Document): string {
  // The page's own ground, whatever scheme is on, so the address bar matches the app rather than
  // the app it used to be.
  return paletteColor("--bg", theme === "dark" ? "#0b1118" : "#f6f8fa", doc);
}

export function applyThemeToDocument(document: Document, theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", themeColor(theme));
}

export function terminalTheme(theme: ResolvedTheme, doc?: Document) {
  const token = (name: string, fallback: string) => paletteColor(name, fallback, doc);
  const base = theme === "dark"
    ? {
        background: "#0a0c10",
        foreground: "#e6edf3",
        cursor: "#45d6cc",
        cursorAccent: "#0a0c10",
        selectionBackground: "#274a50",
        black: "#151b23",
        red: "#f85149",
        green: "#3fb950",
        yellow: "#e3b341",
        blue: "#58a6ff",
        magenta: "#c6b0ff",
        cyan: "#45d6cc",
        white: "#e6edf3",
        brightBlack: "#6b7c89",
        brightRed: "#ff9a93",
        brightGreen: "#56d364",
        brightYellow: "#f2cc60",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#76e3dc",
        brightWhite: "#ffffff",
      }
    : {
        background: "#f7f9fc",
        foreground: "#17212b",
        cursor: "#087f78",
        cursorAccent: "#f7f9fc",
        selectionBackground: "#b6e6e2",
        black: "#24292f",
        red: "#cf222e",
        green: "#1a7f37",
        yellow: "#9a6700",
        blue: "#0969da",
        magenta: "#8250df",
        cyan: "#087f78",
        white: "#4f5d6a",
        brightBlack: "#57606a",
        brightRed: "#a40e26",
        brightGreen: "#116329",
        brightYellow: "#7d4e00",
        brightBlue: "#0550ae",
        brightMagenta: "#6639ba",
        brightCyan: "#055d56",
        brightWhite: "#17212b",
      };
  /**
   * Every channel measured against the terminal's OWN ground, and lightened or darkened until it
   * clears AA there.
   *
   * The first version combined each scheme's semantic colours with an independently derived
   * `--terminal-bg` and validated nothing, so ordinary ANSI output rendered below AA in every light
   * palette — GitHub's red, green and blue at about 3.4:1, Dracula's around 3.5:1, Monokai's around
   * 3.6:1. The app's tokens are derived against the app's SURFACES; the terminal is a different
   * ground and needs its own arithmetic rather than a shared assumption.
   */
  const parse = (hex: string) => {
    const h = hex.replace("#", "");
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  };
  const toHex = (rgb: number[]) =>
    `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
  const blend = (a: string, b: string, t: number) => toHex(parse(a).map((v, i) => v + (parse(b)[i]! - v) * t));
  const channel = (c: number) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const luminance = (hex: string) => {
    const [r, g, b] = parse(hex);
    return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  /** Nudge an ANSI colour until it is readable on the terminal ground; keep its hue as long as it can. */
  const legible = (hex: string, ground: string) => {
    if (!/^#[0-9a-f]{6}$/i.test(hex) || !/^#[0-9a-f]{6}$/i.test(ground)) return hex;
    if (ratio(hex, ground) >= 4.5) return hex;
    for (const toward of luminance(ground) > 0.5 ? ["#000000", "#ffffff"] : ["#ffffff", "#000000"]) {
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const candidate = blend(hex, toward, t);
        if (ratio(candidate, ground) >= 4.5) return candidate;
      }
    }
    return hex;
  };

  const ground = token("--terminal-bg", base.background);
  const readable = (name: string, fallback: string) => legible(token(name, fallback), ground);

  return {
    // The hand-tuned defaults go through the same measurement as the token-derived channels. They
    // were written for Wollipog's terminal ground and are inherited by every scheme, so a palette
    // with a lighter ground left brightBlue and brightCyan at about 4.4:1.
    ...Object.fromEntries(Object.entries(base).map(([name, value]) => [
      name,
      name === "background" || name === "cursorAccent" ? value : legible(value as string, ground),
    ])),
    background: ground,
    foreground: readable("--text", base.foreground),
    cursor: readable("--accent", base.cursor),
    cursorAccent: ground,
    black: readable("--bg-elev-2", base.black),
    red: readable("--red", base.red),
    green: readable("--green", base.green),
    yellow: readable("--yellow", base.yellow),
    blue: readable("--blue", base.blue),
    magenta: readable("--purple", base.magenta),
    cyan: readable("--teal", base.cyan),
    white: readable("--text-dim", base.white),
    brightBlack: readable("--text-faint", base.brightBlack),
    brightWhite: readable("--text", base.brightWhite),
  };
}
