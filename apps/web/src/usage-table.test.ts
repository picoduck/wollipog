import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { allDeclarations, declarationsOf, rulesWith } from "./css-rules.js";
import { alphaOf, contrast, everyPalette, paint, parseFill, SCHEMES, THEMES } from "./palettes.js";

/**
 * Phase 8's Usage table — §F8's "add zebra/hover/sticky-header".
 *
 * The table is the one place in the app where a reader tracks a value ACROSS a wide row, and it had
 * none of the three. What makes this more than styling is that all three are colour, and this app
 * now has ten palettes: a fixed grey zebra is a colour, and a colour that is not from the palette
 * stops being right the moment someone picks another scheme.
 */

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

const ruleFor = (selector: string) =>
  rulesWith(css, ["background"], []).find(({ selector: found }) => found.replace(/\s+/g, " ").trim() === selector);

/** The declared value of `prop` on `selector`, last-wins — which is the one the cascade applies. */
const valueOf = (prop: string, selector: string) =>
  declarationsOf(css, prop)
    .filter(({ selector: found }) => found.replace(/\s+/g, " ").trim() === selector)
    .at(-1)?.value.trim();

/**
 * The EFFECTIVE background of `selector`, read as the fill it paints.
 *
 * `background` is a shorthand and `background-color` a longhand that overrides its colour, so a
 * later `background-color: color-mix(…, transparent)` beside an opaque `background: var(--accent)`
 * is what the browser paints. Reading only the shorthand let that pair recreate the translucent bar
 * this file exists to reject, with every assertion green.
 */
const fillOf = (selector: string) => {
  // Whichever of the two comes LAST in the stylesheet, by line, is the one that wins.
  const declared = allDeclarations(css)
    .filter(({ prop }) => prop === "background" || prop === "background-color")
    .filter(({ selector: found }) => found.replace(/\s+/g, " ").trim() === selector)
    .sort((a, b) => a.line - b.line)
    .at(-1)?.value.trim();
  assert.ok(declared, `${selector} declares no background`);
  return parseFill(declared!);
};

const WRAP = ".usage-table-wrap";
const ZEBRA = ".usage-table tbody tr:nth-child(even)";
const HOVER = ".usage-table tbody tr:hover";
const HEADER = ".usage-table thead th";
const BAR = ".usage-cost-bar";

test("the table stripes, highlights, and keeps its header in view", () => {
  const zebra = ruleFor(".usage-table tbody tr:nth-child(even)");
  assert.ok(zebra, "alternating rows need a tint to track a value across a wide row");
  const hover = ruleFor(".usage-table tbody tr:hover");
  assert.ok(hover, "and the row under the pointer needs to be the one that stands out");

  // Every part of what makes a header stick, not just the word. `position: sticky` with no `top` is
  // inert; so is a `top` with no bounded, overflowing ancestor to stick inside. Each of the four is
  // read last-wins, because a later declaration is the one the cascade applies and a first-match
  // read reports a value the page never uses.
  assert.equal(valueOf("position", HEADER), "sticky", "a header that scrolls away is a header you lose");
  assert.equal(valueOf("top", HEADER), "0", "sticky with no offset never leaves the flow");
  assert.match(valueOf("overflow", WRAP) ?? "", /^(auto|scroll)$/,
    "sticky needs an ancestor that actually scrolls");
  assert.ok(valueOf("max-height", WRAP), "and one that is bounded, or it never overflows to scroll");
});

test("every added colour comes from the palette", () => {
  // Ten palettes: a literal here is right for one of them and wrong for nine, and would pass every
  // contrast check because those measure declared TOKENS.
  for (const selector of [
    ".usage-table tbody tr:nth-child(even)",
    ".usage-table tbody tr:hover",
    ".usage-table thead th",
  ]) {
    const rule = ruleFor(selector);
    assert.ok(rule, `${selector} must declare a background`);
    assert.match(rule!.declarations.background!, /var\(--/,
      `${selector} paints a literal colour, which is right for one palette and wrong for nine`);
  }
});

test("the sticky header is opaque", () => {
  // A translucent header over scrolling rows is unreadable in exactly the moment it exists for.
  // Asserting the word `transparent` is absent is not the same claim: an alpha in the token, a
  // `color-mix` against another colour, or a separate `opacity` on the same rule all read as opaque
  // to that test and render see-through. The fill's own alpha is the property that matters.
  const header = fillOf(HEADER);
  assert.equal(header.alpha, 1, "rows scrolling under a translucent header show through it");
  assert.equal(valueOf("opacity", HEADER), undefined, "and `opacity` makes it translucent just the same");
  // The token itself can carry the alpha. `--diff-add-bg` is `rgba(63, 185, 80, .14)` in Wollipog
  // dark, so `background: var(--diff-add-bg)` reads as an opaque `var()` and renders see-through.
  // `paint` accepts only a six-digit hex, so resolving the fill in every palette is the check.
  for (const palette of everyPalette(css)) paint(palette, header, "#000000");
});

test("the scroll region is reachable and shows focus", () => {
  const view = readFileSync(fileURLToPath(new URL("./components/UsageView.tsx", import.meta.url)), "utf8");
  // The max-height that makes the sticky header work also gives this its own scrollbar, and a plain
  // overflow div is not in the sequential focus order in WebKit — so the rows inside it were
  // unreachable by keyboard.
  // Scoped to the wrapper's own attributes. Reading these off the whole file matches whichever
  // element declares them first — `aria-labelledby` appears three times in this view, and the first
  // belongs to the page heading, so a file-wide read would have checked the wrong element.
  const region = /className="usage-table-wrap"[\s\S]{0,800}?\n\s*>/.exec(view)?.[0];
  assert.ok(region, "the wrapper's opening tag has to be findable to be checked");
  assert.match(region!, /tabIndex=\{0\}/);
  assert.match(region!, /role="region"/, "a scroll region needs a name as well as a tab stop");
  // The name has to BE the caption, not a second copy of it that can drift. The first version said
  // "Usage by Day" while the caption said "Hourly Usage in UTC" — and hourly is what the default
  // range returns, so a screen reader announced the wrong interval on the screen as it first loads.
  const labelledBy = /aria-labelledby="([\w-]+)"/.exec(region!)?.[1];
  assert.ok(labelledBy, "a fixed aria-label is a copy of the caption, and copies drift");
  assert.ok(view.includes(`<caption id="${labelledBy}">`),
    `aria-labelledby points at "${labelledBy}", which is not the caption's id`);
  assert.doesNotMatch(region!, /aria-label="/, "a stray aria-label would override the caption it points at");
  assert.ok(declarationsOf(css, "outline").some(({ selector }) => selector.includes(".usage-table-wrap")),
    "a focusable region that shows no focus is a trap for the person using it");
});

test("the fill and opacity readers fail closed on CSS they cannot resolve", () => {
  // Exercised on synthetic input rather than only on the stylesheet they were fitted to. Every case
  // below is valid CSS that the previous readers turned into a vacuous pass: `1%` parsed as fully
  // opaque, `calc(.6)` as NaN — and `NaN < 3` is false, so the failure list stayed empty.
  assert.deepEqual(parseFill("var(--accent)"), { token: "--accent", alpha: 1 });
  assert.deepEqual(parseFill("color-mix(in srgb, var(--text) 3%, transparent)"), { token: "--text", alpha: 0.03 });
  for (const unresolvable of ["red", "#ff0000", "var(--a) var(--b)", "color-mix(in srgb, var(--a) 3%, var(--b))"]) {
    assert.throws(() => parseFill(unresolvable), /cannot resolve background/, `parseFill accepted "${unresolvable}"`);
  }

  assert.equal(alphaOf(".6", BAR), 0.6);
  assert.equal(alphaOf("1", BAR), 1);
  assert.equal(alphaOf("0", BAR), 0);
  for (const bad of ["1%", "60%", "calc(.6)", "inherit", "", "1.5", "-0.2", "0.6 0.7"]) {
    assert.throws(() => alphaOf(bad, BAR), /cannot resolve opacity/, `alphaOf accepted "${bad}"`);
  }
});

test("a token that carries its own alpha is not an opaque fill", () => {
  // `paint` is the only place a token becomes a colour, so it is the only place that can reject one
  // whose value is `rgba(...)`. Every caller measuring contrast goes through it.
  const palette = everyPalette(css).find((p) => p.label === "wollipog/dark")!;
  assert.throws(() => paint(palette, { token: "--diff-add-bg", alpha: 1 }, "#000000"),
    /not an opaque literal colour/);
  assert.throws(() => paint(palette, { token: "--not-a-token", alpha: 1 }, "#000000"), /undeclared/);
});
