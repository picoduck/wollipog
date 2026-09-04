/**
 * Generate the four alternative colour schemes.
 *
 * Each scheme states ANCHORS — the colours its published palette actually defines — and every other
 * token is derived from them by one rule, so a scheme is a dozen decisions rather than forty-eight.
 * Hand-picking 48 tokens × 4 schemes × 2 themes would be 384 unverified guesses; this way the
 * guesses are twelve per theme and the rest is arithmetic that `colour-schemes.test.ts` checks.
 *
 * Wollipog's own blocks are NOT regenerated. They are hand-tuned and every pixel baseline in the
 * suite is committed against them; deriving them would change rendering for no user-visible reason.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The stylesheet the demands are read from, which is also the one written to in write mode. */
const STYLES = fileURLToPath(new URL("../styles.css", import.meta.url));

const hexToRgb = (hex) => {
  // Validated, because `parseInt` does not complain: a typo that left `#9d9mad` in an anchor parsed
  // as a real colour and generated a whole scheme around it. A silent wrong answer is the worst
  // kind, so this is a throw rather than a fallback.
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`not a 6-digit hex colour: ${JSON.stringify(hex)}`);
  const h = hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const rgbToHex = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
const mix = (a, b, t) => rgbToHex(hexToRgb(a).map((v, i) => v + (hexToRgb(b)[i] - v) * t));
const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (hex) => { const [r, g, b] = hexToRgb(hex); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/**
 * Nudge `colour` toward `toward` until it clears `ratio` against `on`.
 *
 * THROWS when the endpoint still misses. The first version returned `toward` regardless, so a
 * palette whose text could not reach 4.5:1 on its own surfaces silently shipped the closest miss —
 * One Dark's #abb2bf on its third elevation, at 4.4949:1, which is a fail reported as a pass. A
 * generator that cannot meet its contract has to say so, not round it.
 */
function reach(colour, on, ratio, toward, label = "colour") {
  for (let t = 0; t <= 1.0001; t += 0.002) {
    const candidate = mix(colour, toward, t);
    if (contrast(candidate, on) >= ratio) return candidate;
  }
  throw new Error(
    `${label}: ${colour} cannot reach ${ratio}:1 on ${on} even at ${toward} ` +
    `(best ${contrast(toward, on).toFixed(3)}:1)`,
  );
}

/**
 * Move a BACKGROUND away from a fixed ink until the ink clears `ratio` on it.
 *
 * The primary button's gradient stops were fixed mixes that nothing validated: white on GitHub
 * light's active stop measured 3.41:1, and a user pressing an ordinary primary action saw sub-AA
 * label text. The ink is chosen first here and the fill yields to it.
 */
function carry(background, ink, ratio, label = "fill") {
  // BOTH directions, and the nearer one wins. A luminance cutoff picked the direction wrong for
  // any mid-toned ink: One Dark's #abb2bf sits at 0.44, so "lighten the background" was chosen for
  // a light foreground and the search ran away from the target it was trying to reach.
  let best = null;
  for (const away of ["#000000", "#ffffff"]) {
    for (let t = 0; t <= 1.0001; t += 0.002) {
      const candidate = mix(background, away, t);
      if (contrast(candidate, ink) >= ratio) {
        if (!best || t < best.t) best = { t, candidate };
        break;
      }
    }
  }
  if (best) return best.candidate;
  throw new Error(`${label}: no shade of ${background} carries ${ink} at ${ratio}:1`);
}

/**
 * Push an INK, in whichever direction reaches, until it clears `ratio` on a fixed background.
 *
 * The `-on-tint` inks were pushed toward `--text`, which is itself only just readable on the plain
 * surface — so on a TINTED surface, which is lighter, the text colour is the wrong destination and
 * the search ran out of room. The ink has to be free to go past the text, in either direction.
 */
function readable(ink, backgrounds, ratio, label = "ink") {
  // EVERY background it is used over, not one representative. Deriving against the strongest tint
  // alone chose, for Dracula, an ink that reached the dark 34% fill by going darker — and that same
  // ink then sat at 1.78:1 on the 10% fill the running-status pill actually uses. A tinted token is
  // used across a RANGE of tints and has to clear all of them.
  const on = Array.isArray(backgrounds) ? backgrounds : [backgrounds];
  let best = null;
  for (const toward of ["#000000", "#ffffff"]) {
    for (let t = 0; t <= 1.0001; t += 0.002) {
      const candidate = mix(ink, toward, t);
      if (on.every((background) => contrast(candidate, background) >= ratio)) {
        if (!best || t < best.t) best = { t, candidate };
        break;
      }
    }
  }
  if (best) return best.candidate;
  throw new Error(`${label}: no shade of ${ink} is readable on ${on.join(", ")} at ${ratio}:1`);
}

/**
 * The tint strengths each family is actually used over.
 *
 * TWO ranges, because there are two families and they do not overlap: the status pills and badges
 * fill at about 10-16% and read `--x-on-tint`, while the danger button's three states fill at
 * 14/22/30% and read `--red-on-strong-tint` — which exists precisely because the weaker ink could
 * not carry the stronger fill. Deriving both against one 8-34% span asked a single ink to be
 * readable across surfaces spanning dark to mid, which nothing is.
 */
const TINTS = [0.08, 0.12, 0.16, 0.22];
const STRONG_TINTS = [0.14, 0.22, 0.30, 0.34];
const tintRange = (surface, hue) => TINTS.map((strength) => mix(surface, hue, strength));
const strongTintRange = (surface, hue) => STRONG_TINTS.map((strength) => mix(surface, hue, strength));

const luminanceOf = (hex) => {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/**
 * What the stylesheet ACTUALLY pairs, read from the stylesheet.
 *
 * Three rounds of this were spent guessing which surface a token would be used over and deriving
 * against that guess: a representative tint, then a range of tints, then a different range. Each
 * guess fixed the failures it anticipated and missed the next ones, because the pairings are a
 * property of the component rules and not of the palette.
 *
 * So they are read instead. Every rule that sets `color: var(--ink)` beside a fill built from
 * `var(--hue)` at N% contributes one demand: this ink must clear 4.5:1 over that hue at that
 * strength, on every surface. The derivation then satisfies the demands rather than a model of
 * them, and a new component rule changes the palette without anyone remembering to update a range.
 */
function readDemands(cssPath) {
  // Comments stripped FIRST. The declaration patterns below anchor on `;` or the start of the
  // body, and a comment between two declarations is neither — so explaining a pair in a comment
  // silently removed it from the inventory of pairs, which is a spectacular way for a check to
  // stop checking the thing it was just documented to check.
  const source = readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
  const demands = new Map();
  // Rule bodies, shallow: the shapes in play are `color: var(--x)` beside `background[-color]:`
  // either a bare token or a `color-mix(in srgb, var(--y) N%, transparent)`.
  for (const [, body] of source.matchAll(/\{([^{}]*)\}/g)) {
    const ink = /(?:^|;)\s*color:\s*var\((--[\w-]+)\)/.exec(body)?.[1];
    if (!ink) continue;
    const fill = /(?:^|;)\s*background(?:-color)?:\s*([^;]+)/.exec(body)?.[1];
    if (!fill) continue;
    const mixed = /color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*([\d.]+)%/.exec(fill);
    // Three fill shapes, because the stylesheet uses three.
    //
    //   color-mix(… var(--hue) N%, transparent)   a tint over whatever surface it lands on
    //   color-mix(… var(--hue) N%, var(--base))   a tint over a NAMED base
    //   var(--token)                              an opaque fill, e.g. --code-bg
    //
    // Only the first was read at first, so `--code-muted` on `--code-bg` (3.95:1) and `--text-dim`
    // on an amber tint of `--bg-elev` (4.33:1) were never demands at all. A pairing the stylesheet
    // declares is a pairing regardless of how the fill is spelled.
    const over = /color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*([\d.]+)%\s*,\s*var\((--[\w-]+)\)/.exec(fill);
    const opaque = /^\s*var\((--[\w-]+)\)\s*$/.exec(fill);
    const entry = mixed && /transparent/.test(fill)
      ? { hue: mixed[1], strength: Number(mixed[2]) / 100 }
      : over
      ? { hue: over[1], strength: Number(over[2]) / 100, base: over[3] }
      : opaque
      ? { hue: opaque[1], strength: 1, base: opaque[1] }
      : null;
    if (!entry) continue;
    const list = demands.get(ink) ?? [];
    if (!list.some((d) => d.hue === entry.hue && d.strength === entry.strength && d.base === entry.base)) {
      list.push(entry);
    }
    demands.set(ink, list);
  }
  return demands;
}

/**
 * A scheme's anchors, per theme.
 *
 * `bg`, `surface`, `text` and `accent` come from the published palette; the semantic six do too
 * wherever the palette names them. Everything else below is derived.
 */
const SCHEMES = {
  // GitHub Theme — 19.6M installs, the most-installed colour theme in the VS Code marketplace.
  // Primer's canvas/fg/accent scale.
  github: {
    dark: {
      bg: "#0d1117", surface: "#161b22", text: "#e6edf3", dim: "#8d96a0",
      accent: "#4493f8", accent2: "#db6d28",
      red: "#f85149", green: "#3fb950", amber: "#d29922", blue: "#4493f8",
      teal: "#39c5cf", purple: "#a371f7", yellow: "#e3b341",
    },
    light: {
      bg: "#ffffff", surface: "#f6f8fa", text: "#1f2328", dim: "#59636e",
      accent: "#0969da", accent2: "#bc4c00",
      red: "#cf222e", green: "#1a7f37", amber: "#9a6700", blue: "#0969da",
      teal: "#1b7c83", purple: "#8250df", yellow: "#7d4e00",
    },
  },
  // One Dark — 12.5M as One Dark Pro plus 7.3M as Atom One Dark, the same palette twice. HSL from
  // atom/one-dark-syntax, converted; the light variant is One Light's counterpart.
  "one-dark": {
    dark: {
      bg: "#282c34", surface: "#31353f", text: "#abb2bf", dim: "#828997",
      accent: "#61afef", accent2: "#d19a66",
      red: "#e06c75", green: "#98c379", amber: "#d19a66", blue: "#61afef",
      teal: "#56b6c2", purple: "#c678dd", yellow: "#e5c07b",
    },
    light: {
      bg: "#fafafa", surface: "#eaeaeb", text: "#383a42", dim: "#696c77",
      accent: "#4078f2", accent2: "#986801",
      red: "#ca1243", green: "#50a14f", amber: "#986801", blue: "#4078f2",
      teal: "#0184bc", purple: "#a626a4", yellow: "#7c5c00",
    },
  },
  // Dracula — 10.7M installs. The official spec's twelve colours; Alucard is the published light
  // counterpart.
  dracula: {
    dark: {
      bg: "#282a36", surface: "#343746", text: "#f8f8f2", dim: "#8f9bc4",
      accent: "#bd93f9", accent2: "#ffb86c",
      red: "#ff5555", green: "#50fa7b", amber: "#ffb86c", blue: "#8be9fd",
      teal: "#8be9fd", purple: "#bd93f9", yellow: "#f1fa8c",
    },
    light: {
      bg: "#fffbeb", surface: "#f5f0dc", text: "#1f1f1f", dim: "#635d52",
      accent: "#644ac9", accent2: "#a34d14",
      red: "#cb3a2a", green: "#14710a", amber: "#a34d14", blue: "#036a96",
      teal: "#036a96", purple: "#644ac9", yellow: "#846e15",
    },
  },
  // Monokai — 4.1M as Monokai Pro plus 2.9M as One Monokai, and it also ships built into VS Code
  // and Sublime, so its real reach is larger than either number. The classic palette.
  monokai: {
    dark: {
      bg: "#272822", surface: "#31322b", text: "#f8f8f2", dim: "#75715e",
      accent: "#66d9ef", accent2: "#fd971f",
      red: "#f92672", green: "#a6e22e", amber: "#fd971f", blue: "#66d9ef",
      teal: "#66d9ef", purple: "#ae81ff", yellow: "#e6db74",
    },
    light: {
      bg: "#fdfdf6", surface: "#f2f2e8", text: "#2c2c26", dim: "#5f5f52",
      accent: "#0b7285", accent2: "#a8500a",
      red: "#c2185b", green: "#4f7a0e", amber: "#a8500a", blue: "#0b7285",
      teal: "#0b7285", purple: "#7048b8", yellow: "#7a6a10",
    },
  },
};

/** Every token a theme block declares as a literal, derived from the anchors. */
function tokens(a, theme) {
  const dark = theme === "dark";
  // Surfaces step AWAY from the ground, toward the text, so the ramp works in both directions
  // without a per-theme sign.
  const step = (t) => mix(a.bg, a.text, t);
  // The surfaces yield to the TEXT, not the other way round. `--text` is the palette's published
  // foreground and the whole point of choosing that scheme; the elevations are derived, so when the
  // ramp climbs far enough to break AA it is the ramp that is wrong. One Dark's #abb2bf on a third
  // elevation of #414550 measured 4.4949:1 — and the first version answered that by moving the
  // TEXT, which is the one value in the block that is not ours to move.
  // HEADROOM, not the bare minimum. Components tint these surfaces — a status pill at 10%, a
  // selected row at 16%, a danger button at 30% — and every tint moves the surface toward the hue.
  // Deriving the ramp to exactly 4.5:1 left One Dark's text at the limit with nothing to spend, so
  // the first tint laid over it broke a guarantee the ramp had only just met. 5.5:1 is the margin
  // the strongest tint in the stylesheet needs.
  const SURFACE_HEADROOM = 7;
  const bgElev = carry(a.surface, a.text, SURFACE_HEADROOM, "--bg-elev");
  const bgElev3 = carry(mix(bgElev, a.text, 0.09), a.text, SURFACE_HEADROOM, "--bg-elev-3");
  // Spaced between the two ends rather than derived independently, so the ramp stays monotonic
  // after either end has been pushed.
  const bgElev2 = mix(bgElev, bgElev3, 0.5);
  const border = mix(bgElev3, a.text, 0.08);
  // Control boundaries carry state — an empty radio ring, an off switch track — so WCAG's 3:1
  // non-text rule applies to them against the surface BEHIND them, which is the elevated one.
  const controlOutline = reach(mix(bgElev3, a.text, 0.35), bgElev3, 3, a.text, "--control-outline");
  // The faint tier carries counts, key hints and timestamps, all small. It has to clear 4.5:1 on
  // every surface in the app, so it is measured against the lightest one rather than the ground.
  const faint = reach(a.dim, bgElev3, 4.5, a.text, "--text-dim");
  // The FINAL accent, before anything is derived from it. `--on-accent` used to be chosen against
  // the anchor and then paired with the adjusted accent, which is how One Dark light ended up with
  // #091122 on #3c599a at 2.77:1 — an ink picked for a colour that never rendered.
  const accent = reach(a.accent, bgElev3, 4.5, a.text, "--accent");
  const onAccentInk = contrast(accent, "#ffffff") >= contrast(accent, "#000000") ? "#ffffff" : "#0b0b0b";
  // The fill yields to the ink rather than the other way round: the accent is the brand colour and
  // has already been fixed above, so the ACCENT-FILLED surfaces are what move.
  const accentFill = carry(accent, onAccentInk, 4.5, "--accent fill");
  const accentDeep = carry(dark ? mix(accent, "#000000", 0.55) : mix(accent, "#000000", 0.3),
    "#ffffff", 4.5, "--accent-deep");
  return {
    "--bg": carry(a.bg, a.text, SURFACE_HEADROOM, "--bg"),
    "--bg-elev": bgElev,
    "--bg-elev-2": bgElev2,
    "--bg-elev-3": bgElev3,
    "--bg-elev-1": bgElev,
    "--bg-secondary": bgElev,
    "--border": border,
    "--border-strong": mix(bgElev3, a.text, 0.22),
    "--control-outline": controlOutline,
    "--text": a.text,
    // Measured on the LIGHTEST surface it actually sits on, which is the status pills' 10% tint of
    // itself over the third elevation — not the elevation alone. `.st-queued` was 3.86:1.
    "--text-dim": readable(reach(a.dim, bgElev3, 4.5, a.text, "--text-dim"),
      // The status pills tint at 10%, and only there — the 34% end of TINTS belongs to the button
      // states, and applying it here asked one ink to be readable across a span of mid-greys that
      // nothing is readable across.
      [bgElev3, mix(bgElev3, reach(a.dim, bgElev3, 4.5, a.text, "--text-dim"), 0.12)], 4.5, "--text-dim"),
    "--text-faint": faint,
    "--accent": accent,
    "--accent-2": reach(a.accent2, bgElev3, 4.5, a.text, "--accent-2"),
    "--on-accent": onAccentInk,
    // Every gradient stop carries the SAME ink, so every one of them has to clear 4.5:1 with it —
    // including the middle of the gradient, which is why the two stops are pulled to the same side
    // of the requirement rather than averaged into it.
    "--primary-from": carry(mix(accentFill, a.bg, 0.14), onAccentInk, 4.5, "--primary-from"),
    "--primary-to": carry(mix(accentFill, a.text, 0.16), onAccentInk, 4.5, "--primary-to"),
    "--primary-border": carry(mix(accentFill, a.bg, 0.08), onAccentInk, 4.5, "--primary-border"),
    "--primary-hover-from": carry(mix(accentFill, a.text, 0.06), onAccentInk, 4.5, "--primary-hover-from"),
    "--primary-hover-to": carry(mix(accentFill, a.text, 0.26), onAccentInk, 4.5, "--primary-hover-to"),
    "--primary-hover-border": carry(mix(accentFill, a.text, 0.14), onAccentInk, 4.5, "--primary-hover-border"),
    "--primary-active-from": carry(mix(accentFill, a.bg, 0.24), onAccentInk, 4.5, "--primary-active-from"),
    "--primary-active-to": carry(mix(accentFill, a.bg, 0.06), onAccentInk, 4.5, "--primary-active-to"),
    "--primary-active-border": carry(mix(accentFill, a.bg, 0.18), onAccentInk, 4.5, "--primary-active-border"),
    "--on-primary-pressed": onAccentInk,
    "--accent-deep": accentDeep,
    "--accent-deep-2": carry(mix(accentDeep, accent, 0.35), "#ffffff", 4.5, "--accent-deep-2"),
    "--on-accent-deep": "#ffffff",
    "--green": reach(a.green, bgElev3, 4.5, a.text, "--green"),
    "--teal": reach(a.teal, bgElev3, 4.5, a.text, "--teal"),
    "--red": reach(a.red, bgElev3, 4.5, a.text, "--red"),
    "--amber": reach(a.amber, bgElev3, 4.5, a.text, "--amber"),
    "--blue": reach(a.blue, bgElev3, 4.5, a.text, "--blue"),
    "--code-bg": mix(a.bg, a.text, dark ? 0.04 : 0.05),
    "--code-text": a.text,
    "--code-muted": faint,
    "--code-accent": accent,
    "--danger-text": reach(a.red, bgElev3, 4.5, a.text, "--red"),
    "--positive-text": reach(a.green, bgElev3, 4.5, a.text, "--green"),
    "--agent-claude": reach(a.accent2, bgElev3, 4.5, a.text, "--accent-2"),
    "--purple": reach(a.purple, bgElev3, 4.5, a.text, "--purple"),
    "--selected-accent-text": accent,
    "--dropzone-bg": mix(a.accent, a.bg, dark ? 0.86 : 0.9),
    "--dropzone-text": reach(a.accent, mix(a.accent, a.bg, dark ? 0.86 : 0.9), 4.5, a.text),
    "--terminal-bg": mix(a.bg, dark ? "#000000" : a.text, 0.25),
    "--warning": reach(a.amber, bgElev3, 4.5, a.text, "--amber"),
    // The dim tiers for text on a TINTED row — a diff gutter, a slash-menu source, a syntax
    // comment. Each declares only a colour and inherits its ground from a container painting a 16%
    // wash, which lightens the surface enough to drop the flat-surface tiers under AA. Derived
    // against every wash the app paints as well as the flat surfaces, so hierarchy survives without
    // readability depending on which row you are looking at.
    ...(() => {
      const washes = [];
      for (const hue of [accent, reach(a.green, bgElev3, 4.5, a.text, "--green"), reach(a.red, bgElev3, 4.5, a.text, "--red")]) {
        for (const surface of [a.bg, bgElev, bgElev2, bgElev3]) {
          // 16% only, and the reason is measured rather than assumed.
          //
          // Round three asked for the 20% ground to be dropped as invented. That premise is wrong —
          // `--red` IS painted at 20%, and washes in this file run to 85%. The right reason is
          // stronger: on a 20% wash over the lightest surface, One Dark's PRIMARY ink (#abb2bf)
          // falls under 4.5:1 itself. A ground the primary cannot clear cannot carry a three-tier
          // hierarchy at all, and including it did active harm — it dragged the dim tier up past
          // the primary it is supposed to sit beneath, which is the inversion this round reported.
          //
          // The heavy washes are not unreadable; they are BADGES, which carry their own ink and
          // never these tiers. What this set must contain is the grounds these three tiers land on.
          washes.push(mix(surface, hue, 0.16));
        }
      }
      const grounds = [...washes, a.bg, bgElev, bgElev2, bgElev3];
      return {
        // JOINTLY, and ordered. Deriving each from its own anchor independently landed both on the
        // same value in every palette — One Dark dark got #b2b7bf twice — so the tinted hierarchy
        // was two names for one colour. That is the exact defect this branch retired --text-muted
        // for, reintroduced one tier down by the tokens meant to fix it.
        //
        // Dim is derived first; faint is then pushed AWAY from it until it is measurably quieter on
        // every wash while still clearing AA on all of them. Quieter means closer to the ground, so
        // the search runs toward the ground rather than toward black or white.
        ...(() => {
          // 5.1, not 4.6. A tier needs ROOM BELOW IT for the tier below to exist: derived to the
          // bare minimum, dim-on-tint left nothing above 4.5 for faint-on-tint to occupy, and the
          // generator correctly refused. The headroom is what makes a three-step hierarchy possible
          // on a tinted ground rather than a two-step one with three names.
          // The full triple, PER GROUND: primary ink > dim > faint, every step >= 4.5.
          //
          // The previous version constrained only dim above faint, and compared each against its
          // WORST ground. Both halves were wrong. Nothing held dim under the primary ink it
          // annotates, so on a 16% accent wash One Dark dark rendered a line number at 6.15:1
          // beside the source it numbers at 5.21:1 — the label louder than the thing labelled. And
          // a worst-ground comparison is a comparison across two different backgrounds, which is
          // not what a reader sees: they see one row, one ground, three inks. So every constraint
          // below is evaluated on each ground separately and must hold on all of them.
          // Bottom-up, and the search runs AWAY from the ground.
          //
          // The first attempt walked each candidate TOWARD the ground to make it quieter, which can
          // only lower contrast — so a candidate starting under its own floor could never climb to
          // it, and the generator reported the hierarchy as impossible when it is not. The primary
          // ink clears 8.26:1 on the worst wash in the tightest palette; there is room for three
          // tiers, and the search just could not travel in the direction where they live.
          //
          // So: faint is settled first, as quiet as its own AA floor allows. Dim is then made
          // LOUDER until it clears faint by a visible margin on every ground — and is checked
          // against the primary's contrast on that SAME ground, which is what a reader actually
          // compares. A worst-ground comparison pits two different backgrounds against each other.
          // The path runs to the theme's EXTREME, not to `--text`.
          //
          // Stopping at `--text` made One Dark unsatisfiable for a reason that had nothing to do
          // with the hierarchy: its `--text` is #abb2bf, dim enough that the faint tier has to climb
          // most of the way to it just to clear AA on a 16% wash, leaving no room above for the two
          // tiers that must outrank it. The ceiling was the search path, not the design.
          const extreme = dark ? "#ffffff" : "#000000";
          const louden = (start, floorOn, ceilingOn, label) => {
            for (let t = 0; t <= 1.0001; t += 0.002) {
              const candidate = mix(start, extreme, t);
              if (grounds.every((ground) => contrast(candidate, ground) >= floorOn(ground)
                && contrast(candidate, ground) <= ceilingOn(ground))) return candidate;
            }
            throw new Error(
              `${a.text}: ${label} has no value that clears its floor on every wash while staying ` +
              `under the tier above it on the same wash — weaken the fill or give the primary ink ` +
              `its own on-tint token`,
            );
          };

          // All three tiers, bottom-up, each floored on the one below it — so the ordering holds by
          // CONSTRUCTION rather than by a check that can pass while the rendering inverts.
          //
          // The primary needs its own on-tint value, which is what round three concluded and it is
          // right: One Dark's `--text` clears only ~4.9:1 on a 16% wash, leaving under half a point
          // of headroom for the two tiers that must fit beneath it. Derived, the primary moves up
          // and the tiers below it have somewhere to be.
          const faintOnTint = louden(faint, () => 4.5, () => Infinity, "--text-faint-on-tint");
          const dimOnTint = louden(reach(a.dim, bgElev3, 4.5, a.text, "--text-dim"),
            (ground) => contrast(faintOnTint, ground) + 0.25, () => Infinity, "--text-dim-on-tint");
          const textOnTint = louden(a.text,
            (ground) => contrast(dimOnTint, ground) + 0.25, () => Infinity, "--text-on-tint");
          return {
            "--text-on-tint": textOnTint,
            "--text-dim-on-tint": dimOnTint,
            "--text-faint-on-tint": faintOnTint,
          };
        })(),
      };
    })(),
    // The `-on-tint` family, as LITERALS per scheme rather than one shared `color-mix`.
    //
    // The base declares them as a fixed 70% (or 50%) mix of the hue with the text, which happens to
    // clear on Wollipog's tints and does not on every palette: One Dark's danger button measured
    // 3.57:1. The mix ratio was a value that worked once, so it is a constant standing in for a
    // measurement. Here each one is pushed toward the text until it actually clears on the tint it
    // is used over, at the strongest tint the button states reach.
    ...Object.fromEntries(
      [["red", 0.34], ["green", 0.34], ["amber", 0.34], ["blue", 0.34], ["teal", 0.34],
       ["purple", 0.34], ["yellow", 0.34], ["warning", 0.34]].map(([name, tint]) => {
        const hue = reach(a[name === "warning" ? "amber" : name], bgElev3, 4.5, a.text, `--${name}`);
        const over = tintRange(bgElev3, hue);
        return [`--${name}-on-tint`, readable(mix(hue, a.text, 0.3), over, 4.5, `--${name}-on-tint`)];
      }),
    ),
    "--accent-on-tint": readable(mix(accent, a.text, 0.3), tintRange(bgElev3, accent), 4.5, "--accent-on-tint"),
    "--accent-2-on-tint": readable(
      mix(reach(a.accent2, bgElev3, 4.5, a.text, "--accent-2"), a.text, 0.3),
      tintRange(bgElev3, reach(a.accent2, bgElev3, 4.5, a.text, "--accent-2")), 4.5, "--accent-2-on-tint"),
    "--red-on-strong-tint": (() => {
      const hue = reach(a.red, bgElev3, 4.5, a.text, "--red");
      return readable(mix(hue, a.text, 0.5), strongTintRange(bgElev3, hue), 4.5, "--red-on-strong-tint");
    })(),
    "--yellow": reach(a.yellow, bgElev3, 4.5, a.text, "--yellow"),
    // Usage chart series slots: fixed categorical hues (dataviz palette, validated for adjacent-pair
    // CVD and normal-vision separation on both surfaces), shared by every scheme so a driver reads
    // the same colour everywhere. Chart marks only — never text, never status — so they are not
    // derived toward any ink and carry no WCAG text demand.
    "--usage-series-1": dark ? "#d95926" : "#eb6834",
    "--usage-series-2": dark ? "#3987e5" : "#2a78d6",
    "--usage-series-3": "#199e70",
    "--usage-series-4": dark ? "#9085e9" : "#4a3aa7",
    // The four remaining palette literals. Left out of the first version, they were inherited from
    // Wollipog — so a GitHub diff showed Wollipog's green wash behind GitHub's green text, which is
    // both wrong and, at 3.85:1, unreadable. A token is palette data whether it is written as a hex
    // or as an rgba.
    "--diff-add-bg": carry(mix(a.bg, reach(a.green, bgElev3, 4.5, a.text, "--green"), 0.16),
      reach(a.green, bgElev3, 4.5, a.text, "--green"), 4.5, "--diff-add-bg"),
    "--diff-delete-bg": carry(mix(a.bg, reach(a.red, bgElev3, 4.5, a.text, "--red"), 0.16),
      reach(a.red, bgElev3, 4.5, a.text, "--red"), 4.5, "--diff-delete-bg"),
    // The scrim behind a modal, dark in both themes because its job is to recede the page.
    "--modal-backdrop": dark
      ? `rgba(${hexToRgb(mix(a.bg, "#000000", 0.5)).join(", ")}, 0.62)`
      : `rgba(${hexToRgb(mix(a.text, "#000000", 0.1)).join(", ")}, 0.32)`,
    "--primary-hover-inset": dark ? "rgb(255 255 255 / 0.16)" : "rgb(0 0 0 / 0.12)",
  };
}

/**
 * Make every declared pair clear 4.5:1, by moving whichever side is ours to move.
 *
 * The INK moves when it is derived. When the ink is `--text` — the palette's published foreground,
 * the reason someone chose the scheme — the FILL's hue moves instead: a tint that a scheme's own
 * text cannot sit on is a wrong tint, not wrong text.
 */
function satisfyDemands(map, demands, anchors, label = "?") {
  // To a FIXED POINT. Satisfying one demand moves a token that another demand's tint is built
  // from, so a single pass leaves the second demand measured against a surface that no longer
  // exists — which is how sixteen pairs survived the first version of this loop.
  let previous = "";
  for (let round = 0; round < 12; round += 1) {
    const current = JSON.stringify(map);
    if (current === previous) {
      // A STABLE state is not a satisfied one. `satisfyOnce` can move a dependent and
      // `rederiveDependents` can put it back, leaving the net map unchanged with the demand still
      // unmet — and the loop then called that convergence. Stability is only the stopping
      // condition; the postcondition is checked separately and is what decides we are done.
      assertDemandsMet(map, demands, label);
      return map;
    }
    previous = current;
    satisfyOnce(map, demands, anchors, label);
    rederiveDependents(map, demands);
  }
  throw new Error(`${label}: the demands did not settle in twelve rounds; two of them are pulling apart`);
}

/**
 * Everything that is a function of `--accent`, recomputed after the loop may have moved it.
 *
 * `--on-accent` and the primary ramp were derived once, from the accent as it stood before the
 * demands were satisfied. When a demand then moved the accent, the ink stayed where it was and
 * ended at 2.19:1 on the fill it is supposed to sit on — the same "derived from a value that never
 * rendered" mistake the review found in the first version, reintroduced one level up.
 */
/*
 * ALSO not covered by the pair test, and kept anyway.
 *
 * Deleting the call leaves every test green today, because the demand loop happens to move the
 * accent very little in these four palettes and the primary ramp is a gradient — which is not one
 * of the fill shapes the demand reader understands, so those stops are not demands. A fifth scheme
 * whose accent has to travel further would expose it. "No test failed" is not the same as "not
 * needed", and the difference is worth writing down rather than discovering later.
 */
function rederiveDependents(map, demands = new Map()) {
  const accent = map["--accent"];
  // EVERY token derived from the accent, not just the button ramp. The first version updated the
  // inks and the primary stops and left `--accent-deep`, `--code-accent`, `--selected-accent-text`,
  // `--accent-on-tint` and the drop zone on the value the accent had BEFORE the demand loop moved
  // it — stale, deterministic, and therefore invisible to the drift check, which compares the
  // committed output against the same stale computation.
  const surfaces = ["--bg", "--bg-elev", "--bg-elev-2", "--bg-elev-3"].map((name) => map[name]);
  const worst = surfaces[surfaces.length - 1];
  // Tokens the DEMAND loop owns are not touched here: it derives them against the grounds the
  // stylesheet declares, and overwriting them with a plain accent put `--code-accent` back to
  // 3.84:1 on its own tint. This function is for the accent dependants nothing else re-derives.
  for (const name of ["--code-accent", "--selected-accent-text", "--accent-on-tint"]) {
    if (!demands.has(name)) map[name] = accent;
  }
  const deep = carry(mix(accent, "#000000", 0.45), "#ffffff", 4.5, "--accent-deep");
  map["--accent-deep"] = deep;
  map["--accent-deep-2"] = carry(mix(deep, accent, 0.35), "#ffffff", 4.5, "--accent-deep-2");
  map["--on-accent-deep"] = "#ffffff";
  const dropzone = mix(accent, map["--bg"], 0.88);
  map["--dropzone-bg"] = dropzone;
  map["--dropzone-text"] = readable(accent, [dropzone], 4.55, "--dropzone-text");
  const ink = contrast(accent, "#ffffff") >= contrast(accent, "#000000") ? "#ffffff" : "#0b0b0b";
  const fill = carry(accent, ink, 4.5, "--accent fill");
  map["--on-accent"] = ink;
  map["--on-primary-pressed"] = ink;
  const bg = map["--bg"];
  const text = map["--text"];
  for (const [token, base] of [
    ["--primary-from", mix(fill, bg, 0.14)],
    ["--primary-to", mix(fill, text, 0.16)],
    ["--primary-border", mix(fill, bg, 0.08)],
    ["--primary-hover-from", mix(fill, text, 0.06)],
    ["--primary-hover-to", mix(fill, text, 0.26)],
    ["--primary-hover-border", mix(fill, text, 0.14)],
    ["--primary-active-from", mix(fill, bg, 0.24)],
    ["--primary-active-to", mix(fill, bg, 0.06)],
    ["--primary-active-border", mix(fill, bg, 0.18)],
  ]) {
    map[token] = carry(base, ink, 4.5, token);
  }
  return map;
}

/** Every demand, re-measured against the FINAL map. The loop is not trusted to have met them. */
function assertDemandsMet(map, demands, label) {
  const surfaces = ["--bg", "--bg-elev", "--bg-elev-2", "--bg-elev-3"].map((name) => map[name]);
  const unmet = [];
  const skipped = [];
  let measured = 0;
  let total = 0;
  for (const [inkName, list] of demands) {
    const ink = map[inkName];
    for (const { hue, strength, base } of list) {
      total += 1;
      const hueValue = map[hue];
      // FAIL CLOSED. Silently continuing on a value this cannot parse meant the solver's invariant
      // was "every demand I happened to understand", which is not the invariant it claimed. Today
      // every recognised demand is hex; `--modal-backdrop` is an rgba away from not being, and the
      // check would have gone quiet rather than loud.
      if (!ink || !/^#[0-9a-f]{6}$/i.test(ink)) { skipped.push(`${inkName} is ${ink ?? "undeclared"}`); continue; }
      if (!hueValue || !/^#[0-9a-f]{6}$/i.test(hueValue)) { skipped.push(`${hue} is ${hueValue ?? "undeclared"}`); continue; }
      if (base && !/^#[0-9a-f]{6}$/i.test(map[base] ?? "")) {
        // A named base that cannot be parsed is NOT the four generic surfaces: substituting them
        // measures a different backdrop from the one the rule declares.
        skipped.push(`${inkName} sits on ${base}, which is ${map[base] ?? "undeclared"}`);
        continue;
      }
      const grounds = base ? [map[base]] : surfaces;
      measured += 1;
      for (const ground of grounds) {
        const background = strength >= 1 ? hueValue : mix(ground, hueValue, strength);
        const ratio = contrast(ink, background);
        if (ratio < 4.5) unmet.push(`${inkName} on ${hue} at ${strength * 100}% is ${ratio.toFixed(3)}:1`);
      }
    }
  }
  if (unmet.length > 0) throw new Error(`${label}: converged with demands unmet — ${unmet.join("; ")}`);
  if (skipped.length > 0) {
    throw new Error(
      `${label}: ${skipped.length} of ${total} demands could not be measured, so the solver's ` +
      `guarantee does not cover them — ${[...new Set(skipped)].join("; ")}`,
    );
  }
  if (measured !== total) throw new Error(`${label}: measured ${measured} of ${total} demands`);
}

function satisfyOnce(map, demands, anchors, label = "?") {
  const surfaces = ["--bg", "--bg-elev", "--bg-elev-2", "--bg-elev-3"].map((name) => map[name]);
  // A demand with a named base composites over THAT, not over every surface: the rule already says
  // which ground the tint sits on, so measuring it against four is measuring three fictions.
  const backgroundsFor = (hue, strength, base) => {
    const grounds = base && /^#[0-9a-f]{6}$/i.test(map[base] ?? "") ? [map[base]] : surfaces;
    return grounds.map((ground) => (strength >= 1 ? hue : mix(ground, hue, strength)));
  };

  /**
   * A hair above the target.
   *
   * The search steps through 8-bit colours, so a candidate that first satisfies 4.5 can quantize to
   * 4.4951 — and twelve of the fourteen survivors were between 4.48 and 4.50. Aiming a little past
   * the line costs nothing visible and stops the rounding deciding whether a guarantee holds.
   */
  const TARGET = 4.55;

  for (const [inkName, list] of demands) {
    const ink = map[inkName];
    if (!ink || !/^#[0-9a-f]{6}$/i.test(ink)) continue;
    const relevant = list.filter(({ hue }) => /^#[0-9a-f]{6}$/i.test(map[hue] ?? ""));
    if (relevant.length === 0) continue;

    if (anchors.has(inkName)) {
      // The text cannot move, so each offending fill does.
      for (const { hue, strength, base } of relevant) {
        let value = map[hue];
        if (backgroundsFor(value, strength, base).every((bg) => contrast(ink, bg) >= TARGET)) continue;
        // The hue has TWO roles: it tints this fill, and elsewhere it is an ink on the plain
        // surfaces. Moving it for the fill alone drove One Dark's accent to 1.08:1 on the third
        // elevation — a constraint satisfied by breaking the one next to it.
        const alsoReadable = (candidate) => surfaces.every((surface) => contrast(candidate, surface) >= TARGET);
        let fixed = null;
        for (const toward of ["#000000", "#ffffff"]) {
          for (let t = 0; t <= 1.0001; t += 0.002) {
            const candidate = mix(value, toward, t);
            if (backgroundsFor(candidate, strength, base).every((bg) => contrast(ink, bg) >= TARGET)
              && alsoReadable(candidate)) {
              if (!fixed || t < fixed.t) fixed = { t, candidate };
              break;
            }
          }
        }
        if (!fixed) throw new Error(`${label}: ${hue} has no shade that both stays readable on the surfaces and lets ${inkName} sit on its ${strength * 100}% tint (currently ${value})`);
        map[hue] = fixed.candidate;
      }
      continue;
    }

    // The FOUR SURFACES as well as the demanded tints. Re-deriving against the tints alone let the
    // shortest move be "toward the background", so One Dark's accent settled at 1.21:1 on the very
    // surface the first derivation had already made it clear. A later constraint must not be
    // allowed to undo an earlier one.
    // NOT covered by the pair test, and kept anyway.
    //
    // A mutation that deletes this line leaves every test green, because the pair test measures
    // rules that declare a colour AND a fill — and this constraint exists for the other case: a
    // token used with no fill declared beside it, sitting on whatever surface the page provides.
    // That is most of the app's text. The honest statement is that this is load-bearing and
    // unverified by the suite, not that it is redundant because nothing failed without it.
    //
    // The four surfaces are added only for tokens that are USED on a bare surface. The `-on-tint`
    // family is not — it exists precisely because the plain ink cannot carry a strong fill — and
    // requiring both asked one colour to be readable on a near-black surface and a mid-brown tint
    // at once, which nothing is. The demands say where a token is used; that is the answer.
    // Tokens that are GROUNDS are exempt from the surface constraint too, along with the tint
    // family. `--bg` appears as an ink on the inverted chips, and demanding that it be readable on
    // the four surfaces is demanding that it be readable on ITSELF.
    // The surface constraint applies to a token used as an ink ON THE PAGE. Three families are not:
    // the `-on-tint` inks, which exist because the plain ink cannot carry a strong fill; every
    // `--on-*` ink, which is named for the one fill it sits on; and the grounds, for which the
    // constraint would demand readability against themselves.
    const onlyOnTints = /-on-(strong-)?tint$/.test(inkName) || /^--on-/.test(inkName)
      || /^--bg($|-)/.test(inkName) || /-bg$/.test(inkName);
    const backgrounds = [
      ...(onlyOnTints ? [] : surfaces),
      ...relevant.flatMap(({ hue, strength, base }) => backgroundsFor(map[hue], strength, base)),
    ];
    map[inkName] = readable(ink, backgrounds, TARGET, inkName);
  }
  return map;
}

const LABELS = {
  github: "GitHub — the most-installed colour theme in the VS Code marketplace (19.6M).",
  "one-dark": "One Dark — 12.5M as One Dark Pro plus 7.3M as Atom One Dark, one palette twice.",
  dracula: "Dracula — 10.7M installs, and its own published specification.",
  monokai: "Monokai — 4.1M as Monokai Pro plus 2.9M as One Monokai, and built into VS Code and Sublime.",
};

/** The sentinel that makes the write idempotent: everything from here to the marker is replaced. */
const BEGIN = "/* --- COLOUR SCHEMES, GENERATED --- */";

let css = `\n${BEGIN}\n/* ------------------------------------------------------------------------------------------------
 * Colour schemes (§6.5).
 *
 * Wollipog is the default and is declared above, in the plain \`[data-theme]\` blocks. These four are
 * the most-installed alternatives, chosen by measured install count from the VS Code Marketplace API
 * rather than by reputation — Catppuccin and Nord are the community favourites people name, and are
 * an order of magnitude behind these on installs (1.3M each).
 *
 * Each scheme states its published anchors — ground, surface, text, accent and the semantic six —
 * and everything else is DERIVED: surfaces step from the ground toward the text, and every colour
 * that carries text or state is nudged until it clears its WCAG ratio on the surface it sits on.
 * That is why these values look arbitrary: they are outputs, not choices. \`colour-schemes.test.ts\`
 * re-derives them and fails if a committed value drifts from the rule that produced it.
 * ---------------------------------------------------------------------------------------------- */\n`;

const DEMANDS = readDemands(process.argv[2] === "--emit" ? STYLES : process.argv[2] ?? STYLES);
const ANCHORS = new Set(["--text"]);

for (const [name, themes] of Object.entries(SCHEMES)) {
  css += `\n/* ${LABELS[name]} */\n`;
  for (const theme of ["dark", "light"]) {
    css += `:root[data-scheme="${name}"][data-theme="${theme}"] {\n`;
    for (const [token, value] of Object.entries(satisfyDemands(tokens(themes[theme], theme), DEMANDS, ANCHORS, `${name}/${theme}`))) {
      css += `  ${token}: ${value};\n`;
    }
    css += "}\n";
  }
}

// `--emit` prints the blocks instead of writing them, so `colour-schemes.test.ts` can re-derive and
// compare. The CSS claims these values are outputs of a rule rather than choices; a claim like that
// is only worth making if something checks it.
if (process.argv[2] === "--emit") {
  process.stdout.write(css);
} else {
  const path = process.argv[2];
  const source = readFileSync(path, "utf8");
  const marker = "/* ---------------------------------------------------------------------------\n   iOS focus-zoom guard";
  // Ordered, unique sentinels — checked BEFORE anything is written. The previous version mutated
  // the file and validated afterwards, so a marker that had moved above BEGIN left `slice(-1)`
  // keeping one character of the file and the broad `[data-scheme=` count still satisfied. A
  // validation that runs after the damage is a report, not a guard.
  const markerAt = source.lastIndexOf(marker);
  if (markerAt === -1) {
    throw new Error("the insertion point is gone from styles.css; refusing to report a write that did not happen");
  }
  if (source.split(marker).length !== 2) throw new Error("the insertion point is not unique");
  const start = source.indexOf(BEGIN);
  if (start !== -1) {
    if (source.split(BEGIN).length !== 2) throw new Error("the generated-section sentinel is not unique");
    if (start > markerAt) throw new Error("the generated section starts after its insertion point");
  }
  const from = start === -1 ? -1 : source.lastIndexOf(String.fromCharCode(10), start);
  const cleaned = from === -1 ? source : source.slice(0, from) + source.slice(markerAt);
  const written = cleaned.replace(marker, css + String.fromCharCode(10) + marker);
  // The palette BLOCKS, not every mention of the attribute: a component rule scoped to a scheme is
  // a legitimate use of `[data-scheme=` and would have inflated the old count.
  const blocks = (written.match(/^:root\[data-scheme="[a-z-]+"\]\[data-theme="(dark|light)"\] \{$/gm) ?? []).length;
  const expected = Object.keys(SCHEMES).length * 2;
  if (blocks !== expected) throw new Error(`expected ${expected} palette blocks, the result would have ${blocks}`);
  writeFileSync(path, written, "utf8");
  console.log("wrote", blocks, "scheme blocks");
}
