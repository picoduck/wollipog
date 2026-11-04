import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { declarationsOf, rulesWith } from "./css-rules.js";
import { alphaOf, everyPalette, paint, parseFill } from "./palettes.js";

/**
 * Usage and Cost's Breakdown tables — §F8's "add zebra/hover", and since #3013 no inner scroll.
 *
 * What makes the hover more than styling is that it is colour, and this app has ten palettes: a
 * fixed grey zebra is a colour, and a colour that is not from the palette stops being right the
 * moment someone picks another scheme.
 */

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
const view = readFileSync(fileURLToPath(new URL("./components/UsageView.tsx", import.meta.url)), "utf8");

const ruleFor = (selector: string) =>
  rulesWith(css, ["background"], []).find(({ selector: found }) => found.replace(/\s+/g, " ").trim() === selector);

const WRAP = ".usage-table-wrap";
const HOVER = ".table tbody tr:hover";
const BAR = ".usage-cost-bar";

test("the table highlights the row under the pointer and draws no stripes", () => {
  // The §14 table recipe divides rows with hairlines and draws no zebra: a stripe is a second
  // meaning for a surface tint, and the hover row already carries the one a reader follows.
  assert.equal(rulesWith(css, ["background"], []).filter(({ selector }) => /tr:nth-child\((even|odd)\)/.test(selector)).length, 0,
    "no table stripes its rows (§14)");
  const hover = ruleFor(HOVER);
  assert.ok(hover, "the row under the pointer needs to be the one that stands out");
  // Ten palettes: a literal here is right for one of them and wrong for nine, and would pass every
  // contrast check because those measure declared TOKENS.
  assert.match(hover!.declarations.background!, /var\(--/,
    `${HOVER} paints a literal colour, which is right for one palette and wrong for nine`);
});

test("a Breakdown table grows with the page instead of scrolling inside it (#3013)", () => {
  // A long table ends in Show All. A bounded wrapper gave the page a second scrollbar, which needed
  // its own tab stop, focus ring and sticky header to be usable at all.
  for (const prop of ["max-height", "height", "overflow", "overflow-y"]) {
    assert.deepEqual(declarationsOf(css, prop).filter(({ selector }) => selector.includes(WRAP)).map(({ value }) => value), [],
      `${WRAP} declares ${prop}`);
  }
  assert.equal(declarationsOf(css, "position").filter(({ selector, value }) => selector.includes(".usage-table") && value === "sticky").length, 0,
    "no sticky header: there is no inner scroller for it to stick in");
  assert.doesNotMatch(view, /role="region"/, "a table that does not scroll is not a scroll region");
  // The tab names each table, so a caption would only repeat it.
  assert.doesNotMatch(view, /<caption/);
  assert.match(view, /<table className="table usage-table" aria-labelledby=\{labelledBy\}>/,
    "By Model, By Agent and By Machine share one table, named by the tab its caller passes");
  for (const tab of ["time", "model", "agent", "machine", "person"]) {
    assert.match(view, new RegExp(`(aria-labelledby|labelledBy)="usage-breakdown-${tab}-tab"`), `the ${tab} table is named by its tab`);
  }
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
