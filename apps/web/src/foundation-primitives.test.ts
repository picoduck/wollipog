import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { topLevelRule } from "./css-rules.js";
import { contrast, everyPalette, SCHEMES, THEMES } from "./palettes.js";

/**
 * The tab row, segmented control, rows and table of docs/design-system.md §10, §5.2 and §14 take
 * their size from the §2.8 tokens (pinned with their fine and touch values in control-heights), so
 * what is checked here is that each component reads the right token, and that the segmented
 * control's selected knob is visible in every palette without an accent.
 */

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBody(selector: string): Map<string, string> {
  const body = new Map<string, string>();
  for (const node of topLevelRule(css, selector).nodes) if (node.type === "decl") body.set(node.prop, node.value);
  return body;
}

test("tabs are 40px on a fine pointer and 48px on touch, through --control-h-lg (§10.1)", () => {
  assert.equal(ruleBody(".tab").get("height"), "var(--control-h-lg)");
  assert.equal(ruleBody('.tab[aria-selected="true"]::after').get("height"), "2px", "the selected underline is 2px");
});

test("rows read their height from the row tokens, never from padding (§5.2)", () => {
  const row = ruleBody(".row");
  assert.equal(row.get("height"), "var(--row-h)");
  assert.equal(row.get("padding"), "0 var(--space-3)", "padding is horizontal only");
  assert.equal(ruleBody(".row.row-2").get("height"), "var(--row-h-2)");
  // Dense rows are 32px with a mouse and 44px on touch: the coarse block resizes the token.
  assert.equal(ruleBody(".row.dense").get("height"), "var(--row-h-dense)");
});

test("table cells are one row tall under a 32px header (§14)", () => {
  assert.equal(ruleBody(".table :is(td, tbody th)").get("height"), "var(--row-h)");
  assert.equal(ruleBody(".table thead th").get("height"), "var(--space-8)");
  assert.equal(ruleBody(".table").get("table-layout"), "fixed");
});

test("the selected segment is a neutral knob that clears 3:1 against its track in every palette (§10.2)", () => {
  assert.equal(ruleBody(".seg").get("background"), "var(--bg)", "the track is the page ground");
  const knob = ruleBody('.seg-option[aria-checked="true"]');
  assert.equal(knob.get("background"), "var(--bg-elev)");
  assert.equal(knob.get("border-color"), "var(--control-outline)", "the knob's edge is the non-text control token");
  assert.doesNotMatch([...knob.values()].join(" "), /--accent/, "no accent: that reads as a primary action");

  const palettes = everyPalette(css);
  assert.equal(palettes.length, SCHEMES.length * THEMES.length, "every scheme in both themes");
  const failures: string[] = [];
  for (const palette of palettes) {
    const colour = (token: string) => palette.tokens.get(token)!;
    const edge = contrast(colour("--control-outline"), colour("--bg"));
    if (edge < 3) failures.push(`${palette.label}: knob edge ${edge.toFixed(2)}:1 on the track`);
    // The labels: selected on the knob, unselected on the track.
    const selected = contrast(colour("--text"), colour("--bg-elev"));
    if (selected < 4.5) failures.push(`${palette.label}: selected label ${selected.toFixed(2)}:1`);
    const unselected = contrast(colour("--text-dim"), colour("--bg"));
    if (unselected < 4.5) failures.push(`${palette.label}: unselected label ${unselected.toFixed(2)}:1`);
  }
  assert.deepEqual(failures, []);
});
