import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { customProperties, rulesWith, topLevelRule } from "./css-rules.js";
import {
  ALTERNATIVES, BASE_SELECTOR as BASE, composite as mixHex, contrast,
  declaredTokens as declared, SCHEMES, THEMES, type Theme, tokensFor as resolveTokens,
} from "./palettes.js";
import { SCHEME_SWATCHES, SWATCH_TOKENS, type ColorScheme } from "./theme.js";

/**
 * Four alternative palettes, and the properties every one of them has to hold.
 *
 * §6.5. Wollipog stays the default — its palette is the logo's, measured rather than eyeballed: a
 * steel-blue ground at 43% of the artwork's pixels, the bill and belly's turquoise as the accent,
 * the headphones' orange beside it. The other four are the most-INSTALLED themes in the VS Code
 * Marketplace, taken from its API rather than from a listicle, because "most popular" is a
 * measurable claim: GitHub 19.6M, One Dark 12.5M + 7.3M for the same palette under two names,
 * Dracula 10.7M, Monokai 4.1M + 2.9M and also built into VS Code and Sublime. Catppuccin and Nord
 * are the two people name first and both sit at 1.3M.
 *
 * What these tests check is not taste. A scheme is a set of token values, and the app's contrast
 * guarantees are written against token NAMES — so a scheme that omits a token silently inherits
 * Wollipog's value into a foreign palette, and a scheme whose accent is too light for its ground
 * breaks AA everywhere that accent carries text. Both are invisible to a screenshot.
 */

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

/*
 * The block reader, the token merge and the contrast maths used to live here, and a weaker copy of
 * all three had grown in `usage-table.test.ts`: it matched `:root` blocks with a regex and silently
 * produced Wollipog's colours for any block it failed to parse. Two readers for one stylesheet is
 * two chances to resolve a palette differently, and the copy that loses does it quietly. Both are
 * `palettes.ts` now, which counts what it resolved so a missing scheme is an error.
 *
 * One lesson from that reader is worth keeping next to its users. `customProperties` returns a Map
 * of name to the LIST of values declared for it, and the first version of this file passed that Map
 * to `Object.entries()`, which returns `[]` for a Map — so every token map below was empty, every
 * contrast check skipped, and the whole file passed while measuring nothing. It survived a mutation
 * pass because the mutations were caught by the generator-drift check instead: a mutation has to be
 * able to reach the test it is aimed at, or it certifies a different one.
 */
const tokensFor = (scheme: string, theme: Theme) => resolveTokens(css, scheme, theme);

/** Only literal hexes are compared; anything derived with color-mix is checked by the theme tests. */
const literal = (tokens: Map<string, string>, name: string) => {
  const value = tokens.get(name)?.trim();
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
};

test("every scheme declares every colour the base theme declares", () => {
  // A missing token is not a missing colour — it is WOLLIPOG'S colour, inherited into a foreign
  // palette. Dracula with Wollipog's teal accent looks deliberate and is not.
  for (const theme of THEMES) {
    const base = [...declared(topLevelRule(css, BASE[theme]), `${theme} base`)]
      .filter(([, value]) => /^#[0-9a-fA-F]{6}$/.test(value.trim()))
      .map(([name]) => name);
    assert.ok(base.length > 40, `the ${theme} base declares only ${base.length} literal colours`);
    for (const scheme of ALTERNATIVES) {
      const block = topLevelRule(css, `:root[data-scheme="${scheme}"][data-theme="${theme}"]`);
      assert.ok(block, `${scheme}/${theme} has no token block`);
      const names = new Set(declared(block, `${scheme}/${theme}`).keys());
      const missing = base.filter((name) => !names.has(name));
      assert.deepEqual(missing, [], `${scheme}/${theme} would inherit these from Wollipog`);
    }
  }
});

/** The surfaces anything can sit on. A colour has to clear its ratio on ALL of them, not the ground. */
const SURFACES = ["--bg", "--bg-elev", "--bg-elev-2", "--bg-elev-3"] as const;

/** Tokens that carry TEXT, so 4.5:1. */
const TEXT_TOKENS = [
  "--text", "--text-dim", "--text-faint", "--accent", "--accent-2",
  "--green", "--teal", "--red", "--amber", "--blue", "--purple", "--yellow", "--warning",
  "--danger-text", "--positive-text", "--code-accent", "--selected-accent-text", "--agent-claude",
];

/**
 * Tokens that carry STATE without text — a radio ring, an off switch track — so 3:1.
 *
 * `--border-strong` is NOT here: §26 documents it as decorative and deliberately below 3:1, which
 * is why `--control-outline` was introduced. Requiring it would be requiring the wrong thing of the
 * wrong token.
 */
const NON_TEXT_TOKENS = ["--control-outline"];

/*
 * The token-by-surface matrix that used to live here has been REMOVED, deliberately.
 *
 * It measured every colour token against every surface token, which is both stronger and weaker
 * than what matters: stronger because it demands ratios for pairings no rule produces — a red on
 * the third elevation that nothing ever renders — and weaker because it cannot see a rule that
 * composites a tint, which is where the real failures were. `light-theme.test.ts` is parameterized
 * over all ten palettes now and measures the pairs the STYLESHEET declares, composited. That is the
 * check; two overlapping ones would have meant tuning the palette to satisfy the wrong one.
 */

test("text on a filled accent clears AA in every scheme", () => {
  // `--on-accent` is the one pair the surface loop cannot check, because its background is the
  // accent itself rather than a surface. It flips with the theme, so it is exactly the kind of pair
  // that gets set once and left.
  const failures: string[] = [];
  for (const scheme of [...ALTERNATIVES, "wollipog"]) {
    for (const theme of THEMES) {
      const tokens = tokensFor(scheme, theme);
      for (const [ink, ground] of [["--on-accent", "--accent"], ["--on-accent-deep", "--accent-deep"],
        ["--dropzone-text", "--dropzone-bg"], ["--code-text", "--code-bg"]] as const) {
        const [a, b] = [literal(tokens, ink), literal(tokens, ground)];
        if (!a || !b) continue;
        const measured = contrast(a, b);
        if (measured < 4.5) failures.push(`${scheme}/${theme}: ${ink} on ${ground} is ${measured.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(failures, [], "a fill that carries text has to be readable in every scheme");
});

test("the committed schemes are what the generator produces", () => {
  // The CSS says these values are derived rather than chosen. That claim is only worth making if it
  // is checked: a hand-edit to one hex would leave the block looking generated and no longer be.
  const generator = fileURLToPath(new URL("./scheme-gen/generate.mjs", import.meta.url));
  const emitted = execFileSync(process.execPath, [generator, "--emit"], { encoding: "utf8" });
  for (const scheme of ALTERNATIVES) {
    for (const theme of THEMES) {
      const committed = customProperties(topLevelRule(css, `:root[data-scheme="${scheme}"][data-theme="${theme}"]`));
      const generated = customProperties(topLevelRule(emitted, `:root[data-scheme="${scheme}"][data-theme="${theme}"]`));
      assert.deepEqual(committed, generated,
        `${scheme}/${theme} has drifted from the rule that produced it; re-run the generator`);
    }
  }
});

test("the scheme list and the stylesheet agree", () => {
  // A scheme in the picker with no block renders Wollipog under a different name; a block with no
  // entry in the picker is unreachable. Both look like nothing is wrong.
  for (const scheme of ALTERNATIVES) {
    for (const theme of THEMES) {
      assert.ok(topLevelRule(css, `:root[data-scheme="${scheme}"][data-theme="${theme}"]`),
        `${scheme} is offered in Settings but has no ${theme} block`);
    }
  }
  const declared = [...css.matchAll(/:root\[data-scheme="([a-z-]+)"\]/g)].map((m) => m[1]!);
  for (const scheme of new Set(declared)) {
    assert.ok(ALTERNATIVES.includes(scheme as never), `${scheme} has a block but is not offered in Settings`);
  }
});

test("the picker's swatches are the palettes' own colours", () => {
  /*
   * The one place a palette is RESTATED in JavaScript, and the test that makes restating it safe.
   *
   * Everywhere else the rule is absolute — `paletteColor` asks the document, because a second
   * description of the palette drifts, and this campaign has spent three PRs on what that costs.
   * The picker cannot follow it: scheme tokens are scoped `:root[data-scheme][data-theme]`, so
   * exactly one scheme is ever in the cascade, and a list showing five swatches needs the four
   * palettes that are not applied. Reading them from the document returns the applied scheme's
   * colours five times over — five identical rows that look deliberate and are not.
   *
   * So the map is allowed to exist and is pinned here instead: character for character against the
   * stylesheet, for every scheme in both themes.
   */
  assert.deepEqual(Object.keys(SCHEME_SWATCHES).sort(), [...SCHEMES].sort(),
    "a scheme offered in the picker with no swatch shows another palette's colours under its name");

  let compared = 0;
  for (const scheme of SCHEMES) {
    for (const theme of THEMES) {
      const tokens = tokensFor(scheme, theme);
      const swatch = SCHEME_SWATCHES[scheme as ColorScheme][theme];
      assert.equal(swatch.length, SWATCH_TOKENS.length, `${scheme}/${theme} has the wrong number of dots`);
      SWATCH_TOKENS.forEach((name, index) => {
        // A token that is not a literal hex cannot be pinned by comparison, so it may not be a
        // swatch token at all — `literal` returning null here is the check, not a skip.
        const value = literal(tokens, name);
        assert.ok(value, `${scheme}/${theme} declares ${name} as something other than a literal hex`);
        assert.equal(swatch[index], value,
          `${scheme}/${theme}'s ${name} swatch has drifted from the stylesheet`);
        compared += 1;
      });
    }
  }
  /*
   * The COUNT, because every assertion above lives inside a loop: a scheme dropped from the map, or
   * a token dropped from SWATCH_TOKENS, makes the loop shorter rather than making it fail.
   *
   * A LITERAL, not `SCHEMES.length * THEMES.length * SWATCH_TOKENS.length`. That derives the
   * expectation from the same three enumerators the loop derives its work from, so a change that
   * shrinks an enumerator and its map together — dropping `--accent-2` and each third swatch entry
   * — shrinks both sides, and the guard against a shorter loop passes on a shorter loop. Five
   * schemes, two themes, three dots each; adding a scheme moves this by six, deliberately, in the
   * commit that adds it.
   */
  assert.equal(compared, 30,
    "the swatch check has to cover five schemes in both themes, three tokens each");
});

test("the browser chrome and the terminal follow the scheme", () => {
  const theme = readFileSync(fileURLToPath(new URL("./theme.ts", import.meta.url)), "utf8");
  const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
  // Both were hardcoded to Wollipog, so a Dracula user got Wollipog's slate behind the address bar
  // and Wollipog's teal cursor in the terminal. The fix is NOT a per-scheme table in JavaScript:
  // that is a second description of the palette, and this campaign has spent three PRs on what a
  // second description costs. The stylesheet already holds the answer for whichever scheme is on.
  assert.match(theme, /getComputedStyle\(doc\.documentElement\)\.getPropertyValue\(token\)/,
    "the palette is read from the document, not restated");
  assert.match(theme, /return paletteColor\("--bg",/, "the chrome colour is the page's own ground");
  // `readable(...)`, not `token(...)`: every channel is measured against the terminal's own ground
  // and nudged until it clears AA there, because the app's tokens are derived against the app's
  // surfaces and the terminal is a different ground. Whether that arithmetic is CORRECT is not a
  // question source text can answer — `colour-schemes.spec.ts` measures all eighteen channels in
  // all ten palettes, and this only checks the wiring reaches them.
  for (const [channel, token] of [["red", "--red"], ["green", "--green"], ["blue", "--blue"],
    ["cyan", "--teal"], ["magenta", "--purple"], ["cursor", "--accent"]] as const) {
    assert.ok(theme.includes(`${channel}: readable("${token}"`),
      `the terminal's ${channel} has to move with the scheme`);
  }
  assert.match(html, /getPropertyValue\("--bg"\)/,
    "and the pre-paint chrome colour is corrected once the stylesheet has parsed");
});

test("the generator refuses to report a write it did not make", () => {
  const gen = readFileSync(fileURLToPath(new URL("./scheme-gen/generate.mjs", import.meta.url)), "utf8");
  // `String.replace` with a missing needle returns the string unchanged, so the run printed
  // "wrote 8 scheme blocks" and wrote nothing. And without a sentinel a second run APPENDED a
  // second copy of every block, which is why each regeneration needed a manual delete first.
  assert.match(gen, /refusing to report a write that did not happen/);
  assert.match(gen, /const BEGIN = /, "an idempotent write needs a mark to replace from");
  assert.match(gen, /const blocks = \(written\.match/, "and the count is checked against the file, not assumed");
});

test("running the generator twice changes nothing", () => {
  // Without a sentinel to replace from, a second run APPENDED a second copy of every block, and
  // every regeneration during this PR needed the previous one deleted by hand. Forgetting once
  // would have left two blocks per scheme with the later one quietly winning.
  const styles = fileURLToPath(new URL("./styles.css", import.meta.url));
  const generator = fileURLToPath(new URL("./scheme-gen/generate.mjs", import.meta.url));
  const before = readFileSync(styles, "utf8");
  try {
    execFileSync(process.execPath, [generator, styles], { encoding: "utf8" });
    const once = readFileSync(styles, "utf8");
    execFileSync(process.execPath, [generator, styles], { encoding: "utf8" });
    assert.equal(readFileSync(styles, "utf8"), once, "the second run must be a no-op");
    // And the committed file is already what the generator produces, or the check above would be
    // comparing two wrong states to each other.
    assert.equal(once, before, "the committed stylesheet is out of date; re-run the generator");
  } finally {
    writeFileSync(styles, before, "utf8");
  }
});

test("the derivation refuses a pair it cannot satisfy", async () => {
  // `reach()` used to return its endpoint whether or not the endpoint cleared, which is how a
  // 4.4949:1 pair shipped as a pass. The demand loop would now correct most near-misses downstream,
  // so this is asserted DIRECTLY: a guard that only holds because something later cleans up after
  // it is a guard nobody can rely on.
  const { reach } = await import("./scheme-gen/generate.mjs?probe=1" as string).catch(() => ({ reach: null }));
  const gen = readFileSync(fileURLToPath(new URL("./scheme-gen/generate.mjs", import.meta.url)), "utf8");
  assert.equal(reach, null, "the generator is a script, so its refusal is asserted from the source");
  assert.match(gen, /cannot reach \$\{ratio\}:1 on \$\{on\} even at \$\{toward\}/,
    "the endpoint has to be checked, not returned");
  assert.doesNotMatch(gen.slice(gen.indexOf("function reach("), gen.indexOf("function carry(")), /return toward;/,
    "returning the endpoint unchecked is the defect this replaced");
});

test("the installed-PWA launch colours are the default palette's, deliberately", () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../public/manifest.webmanifest", import.meta.url)), "utf8"));
  const dark = declared(topLevelRule(css, BASE.dark), "dark base");
  // A manifest is STATIC — it is read by the OS before the app runs, so it cannot follow a scheme
  // stored in localStorage. What it can do is match the default rather than drift from it: these
  // are the splash and task-switcher colours, and a stale value here shows a colour the app never
  // renders. `applyThemeToDocument` handles the live chrome, which does follow the scheme.
  assert.equal(manifest.background_color, dark.get("--bg"),
    "the splash colour must be the default palette's ground");
  assert.equal(manifest.theme_color, dark.get("--bg"),
    "and so must the task-switcher colour");
});

test("the text hierarchy is three distinct steps in every palette", () => {
  // §F8: `--text-dim` and `--text-muted` held the SAME value in both base themes, so the intended
  // three-step hierarchy was two steps under three names — and it was worse than that. The
  // generated schemes aliased `--text-muted` to `--text-faint` instead, so one token meant a
  // different tier depending on which palette the user had selected. The alias is retired; this
  // keeps the remaining three genuinely separate.
  const failures: string[] = [];
  for (const scheme of [...ALTERNATIVES, "wollipog"]) {
    for (const theme of THEMES) {
      const tokens = tokensFor(scheme, theme);
      const [text, dim, faint] = ["--text", "--text-dim", "--text-faint"].map((name) => literal(tokens, name));
      if (!text || !dim || !faint) { failures.push(`${scheme}/${theme} is missing a tier`); continue; }
      // EVERY surface, not the ground alone. Measuring against `--bg` only, Monokai light's dim and
      // faint sit 0.60 apart and passed — but a hovered inbox row renders both on `--bg-elev-3`,
      // where they are 0.46 apart, so a real rendered state violated the threshold the test
      // declares while the test stayed green. A hierarchy that holds on one surface is not a
      // hierarchy.
      for (const surfaceName of SURFACES) {
      const ground = literal(tokens, surfaceName)!;
      const [a, b, c] = [contrast(text, ground), contrast(dim, ground), contrast(faint, ground)];
      // ORDERED: each step must be quieter than the one above it. A hierarchy whose middle step is
      // louder than its top reads as an emphasis, not as a tier.
      if (!(a > b && b > c)) failures.push(`${scheme}/${theme} on ${surfaceName} is out of order: ${a.toFixed(2)} / ${b.toFixed(2)} / ${c.toFixed(2)}`);
      // And SEPARATED: two tiers a tenth of a ratio apart are the same tier with two names, which
      // is the defect this replaces.
      // Thresholds set just under the tightest MEASURED margin across all ten palettes and all
      // four surfaces: 1.343 for text-to-dim, and 0.463 for dim-to-faint in Monokai light on
      // `--bg-elev-3`. They are read from the palettes rather than chosen to make this pass, and
      // that distinction is the whole point — a threshold well below everything does not fail when
      // a tier drifts toward its neighbour, only when they land on top of each other.
      //
      // The floors are 1.34 and 0.46 — the measured minimums to two decimals, not rounded DOWN to
      // 1.3 and 0.45. Rounding down let the thing the comment claimed to prevent happen anyway:
      // Monokai light's faint could move from #5f5f52 to #5f5f50, shrinking the tightest gap from
      // 0.4629 to 0.4539, and the test stayed green while the sentence above said it could not.
      //
      // 0.46 is thin and this test ACCEPTS it as an empirical regression baseline rather than as an
      // accessibility standard, which it is not. Widening it means retuning Monokai's derived
      // tiers — a palette change, not this PR.
      if (a - b < 1.34) failures.push(`${scheme}/${theme} on ${surfaceName}: text and dim differ by only ${(a - b).toFixed(2)}`);
      if (b - c < 0.46) failures.push(`${scheme}/${theme} on ${surfaceName}: dim and faint differ by only ${(b - c).toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(failures, [], "three named tiers have to be three visible tiers");
});

test("the retired alias is gone everywhere", () => {
  // A token that still exists is a token something will use again. The stylesheet keeps one
  // mention, in the comment explaining why it went.
  assert.doesNotMatch(css, /--text-muted:/, "no palette may still declare it");
  assert.doesNotMatch(css, /var\(--text-muted\)/, "and no rule may still read it");
});

test("the tinted tiers are distinct too", () => {
  // The flat-token test above measures `--text`, `--text-dim` and `--text-faint` against flat
  // surfaces, and passed while `--text-dim-on-tint` and `--text-faint-on-tint` held the SAME value
  // in every generated palette — One Dark dark was #b2b7bf twice. So the tinted hierarchy was two
  // names for one colour, which is the defect this PR retired `--text-muted` for, reintroduced one
  // tier down by the tokens meant to fix it. Nothing looked at them because nothing measured the
  // grounds they are used on.
  // The grounds are READ FROM THE STYLESHEET, not listed here.
  //
  // A hardcoded [0.16, 0.20] was wrong in both directions at once. It included a 20% wash over the
  // lightest surface, where One Dark's own PRIMARY ink measures under 4.5:1 — a ground no
  // three-tier hierarchy can live on, which dragged the dim tier up past the primary it annotates
  // and produced exactly the inversion this test claims to prevent. And a list written by hand
  // stops matching the stylesheet the moment a wash changes, which is the failure mode of every
  // check on this campaign that measured something adjacent to its claim.
  //
  // So: find the rules that paint a wash, find the rules that spend an on-tint token, and match
  // them by selector prefix. The ground set is whatever that pairing yields.
  const washes = new Map<string, number>();
  for (const rule of rulesWith(css, ["background"])) {
    const match = /^color-mix\(in srgb, var\((?:--accent|--green|--red)\) (\d+)%/.exec(rule.declarations.background ?? "");
    if (match) washes.set(rule.selector, Number(match[1]) / 100);
  }
  const TIERS = ["--text-on-tint", "--text-dim-on-tint", "--text-faint-on-tint"] as const;
  const grounds = new Map<number, string>();
  for (const rule of rulesWith(css, ["color"])) {
    if (!/--text(-dim|-faint)?-on-tint/.test(rule.declarations.color ?? "")) continue;
    for (const selector of rule.selector.split(",").map((part) => part.trim())) {
      for (const [washSelector, strength] of washes) {
        // The consumer either IS the element painting the wash, or sits inside it.
        if (selector === washSelector || selector.startsWith(`${washSelector} `)) {
          grounds.set(strength, `${selector} over ${washSelector}`);
        }
      }
    }
  }
  // The scan has to have found something. #223 shipped a contrast test that compared nothing at
  // all because a Map went into Object.entries, and it passed a six-mutation audit doing it.
  assert.ok(grounds.size > 0,
    "no on-tint consumer could be matched to a wash; the pairing above has stopped working");

  const failures: string[] = [];
  for (const scheme of [...ALTERNATIVES, "wollipog"]) {
    for (const theme of THEMES) {
      const tokens = tokensFor(scheme, theme);
      const values = TIERS.map((name) => literal(tokens, name));
      if (values.some((value) => !value)) { failures.push(`${scheme}/${theme} is missing a tinted tier`); continue; }
      const [primary, dim, faint] = values as [string, string, string];
      if (new Set([primary, dim, faint]).size < 3) {
        failures.push(`${scheme}/${theme}: the tinted tiers are not three distinct colours`);
        continue;
      }

      for (const hue of ["--accent", "--green", "--red"]) {
        const hueValue = literal(tokens, hue);
        if (!hueValue) continue;
        for (const surfaceName of ["--bg", "--bg-elev", "--bg-elev-2", "--bg-elev-3"]) {
          const surface = literal(tokens, surfaceName);
          if (!surface) continue;
          for (const [strength, where] of grounds) {
            const ground = mixHex(surface, hueValue, strength);
            const [top, mid, low] = [primary, dim, faint].map((ink) => contrast(ink, ground));
            const at = `${scheme}/${theme} on ${hue} at ${Math.round(strength * 100)}% (${where})`;
            // The whole triple, on ONE ground. Comparing each tier against its own worst-case
            // background compares two different backgrounds, which is not what a reader sees.
            if (low < 4.5) failures.push(`${at}: faint-on-tint is ${low.toFixed(2)}:1`);
            if (mid - low < 0.2) failures.push(`${at}: dim is only ${(mid - low).toFixed(2)} above faint`);
            if (top - mid < 0.2) failures.push(`${at}: the primary is only ${(top - mid).toFixed(2)} above dim`);
          }
        }
      }
    }
  }
  assert.deepEqual(failures, [], "a tinted hierarchy has to be a hierarchy on the tint");
});
