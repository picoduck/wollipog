import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { allDeclarations, mediaBlocks, topLevelRule } from "./css-rules.js";
import { contrast, everyPalette, SCHEMES, THEMES } from "./palettes.js";

/**
 * The keycap of docs/design-system.md §11.5: one `kbd` rule for inline hints, menus and the
 * Keyboard Shortcuts reference (#1956). The browser half, computed sizes and the coarse-pointer
 * hide, is apps/web/e2e/keycap.spec.ts.
 */

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The classes that name a keycap element rather than the surface around it. */
const KEYCAP_CLASSES = ["rp-kbd", "follow-tail-kbd"];

/** True when the rule's subject — the last compound of the selector — is a keycap. */
function targetsKeycap(selector: string): boolean {
  const subject = selector.replace(/:not\([^)]*\)/g, "").trim().split(/\s+|>|\+|~/).at(-1) ?? "";
  return /^kbd\b/.test(subject) || KEYCAP_CLASSES.some((name) => subject.includes(`.${name}`));
}

/** Declarations that make up the recipe; a surface may place a keycap but never restate these. */
const RECIPE = /^(font|font-size|font-family|font-weight|line-height|height|min-width|padding|padding-.*|border|border-width|border-color|border-radius|border-bottom-width|background|background-color|color)$/;

test("one kbd rule draws the keycap from tokens (§11.5)", () => {
  const body = new Map<string, string>();
  for (const node of topLevelRule(css, "kbd").nodes) if (node.type === "decl") body.set(node.prop, node.value);
  assert.equal(body.get("font"), "500 var(--text-xs)/16px var(--font-mono)", "11px monospace from the tokens");
  // A px box like every control's (§2.8): the fixed 34px Sessions footer holds these at any root.
  assert.equal(body.get("height"), "18px");
  assert.equal(body.get("min-width"), "18px");
  assert.equal(body.get("box-sizing"), "border-box", "the 18px includes the border");
  assert.equal(body.get("padding"), "0 var(--space-1)");
  assert.equal(body.get("border"), "1px solid var(--border-strong)");
  assert.equal(body.get("border-radius"), "var(--radius-xs)");
  assert.equal(body.get("background"), "var(--bg-elev-2)");
  assert.equal(body.get("color"), "var(--text-dim)");
});

test("no other rule sizes a keycap or sets its font, border or colours", () => {
  const offenders = allDeclarations(css)
    .filter((declaration) => declaration.selector !== "kbd" && declaration.selectors.some(targetsKeycap))
    .filter((declaration) => RECIPE.test(declaration.prop))
    // The unavailable row's dashed edge is a state cue in the shortcut reference, not a second recipe.
    .filter((declaration) => !(declaration.selector === ".shortcut-row.is-unavailable kbd" && declaration.prop === "border-style"))
    .map((declaration) => `${declaration.selector} { ${declaration.prop}: ${declaration.value} } (line ${declaration.line})`);
  assert.deepEqual(offenders, []);
});

/**
 * Bordered monospace boxes that are not keycaps, each with why. A keycap drawn on a `<span>` escapes
 * every `kbd` selector above (the Sessions search `/` did, with its own 10px stack), so any new rule
 * that draws a bordered monospace box fails here until it is a `<kbd>` or is listed with a reason.
 */
const MONO_BOXES_THAT_ARE_NOT_KEYCAPS = new Map([
  [".composer-answer-input", "a text field for a typed answer"],
  [".dir-path-input", "a path text field"],
  [".onboard-recommended-skill-names > li", "skill identifiers in a list"],
  [".tl-step-output", "a transcript step's command output in a neutral well"],
]);

test("every bordered monospace box is a kbd keycap or a listed non-keycap", () => {
  const MONO = /--font-mono|--mono\b|monospace|Cascadia|Consolas|SFMono|Menlo/i;
  const found = new Set<string>();
  postcss.parse(css).walkRules((rule) => {
    const declarations = rule.nodes.filter((node): node is postcss.Declaration => node.type === "decl");
    const mono = declarations.some((node) => /^(font|font-family)$/.test(node.prop) && MONO.test(node.value));
    const bordered = declarations.some((node) => /^border(-width|-style)?$/.test(node.prop) && !/^(0|none)\b/.test(node.value.trim()));
    if (mono && bordered) found.add(rule.selector.replace(/\s+/g, " ").trim());
  });
  const unexplained = [...found].filter((selector) => selector !== "kbd" && !MONO_BOXES_THAT_ARE_NOT_KEYCAPS.has(selector));
  assert.deepEqual(unexplained, [], "draw a keycap with <kbd> and the one kbd rule (§11.5)");
  const stale = [...MONO_BOXES_THAT_ARE_NOT_KEYCAPS.keys()].filter((selector) => !found.has(selector));
  assert.deepEqual(stale, [], "remove exemptions whose rule is gone");
});

test("a keycap-named class is only ever put on a kbd element", () => {
  const components = fileURLToPath(new URL("./components/", import.meta.url));
  const offenders: string[] = [];
  for (const name of readdirSync(components).filter((file) => file.endsWith(".tsx") && !file.includes(".test."))) {
    const source = readFileSync(`${components}${name}`, "utf8");
    for (const match of source.matchAll(/<([a-zA-Z]+)\b[^<>]*?className="([^"]*)"/g)) {
      const keycapClass = match[2]!.split(/\s+/).some((token) => /(kbd|keycap|key-hint)|-key$/.test(token));
      if (keycapClass && match[1] !== "kbd") offenders.push(`${name}: <${match[1]} className="${match[2]}">`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the subject check reads the keycap, not the surface around it", () => {
  assert.ok(targetsKeycap(".shortcut-hint kbd"));
  assert.ok(targetsKeycap(".menu-trail > kbd"));
  assert.ok(targetsKeycap(".follow-tail-kbd"));
  assert.ok(targetsKeycap("kbd:not(.shortcut-list kbd)"));
  assert.ok(!targetsKeycap(".shortcut-hint"));
  assert.ok(!targetsKeycap(".kbd-legend .label"));
});

test("hint labels beside a keycap use the small type token in --text-dim", () => {
  for (const selector of [".shortcut-hint"]) {
    const body = new Map<string, string>();
    for (const node of topLevelRule(css, selector).nodes) if (node.type === "decl") body.set(node.prop, node.value);
    assert.equal(body.get("font"), "var(--type-small)", selector);
    assert.equal(body.get("color"), "var(--text-dim)", selector);
  }
});

test("keycaps and hints hide on a coarse pointer, never by width, except in the shortcut reference", () => {
  const coarse = mediaBlocks(css).filter((block) => block.params.trim() === "(pointer: coarse)");
  assert.ok(coarse.some((block) => block.declarationsForSelector("kbd:not(.shortcut-list kbd)").get("display")?.includes("none")),
    "a coarse pointer hides every keycap outside the Keyboard Shortcuts reference");
  assert.ok(coarse.some((block) => block.declarationsForSelector(".shortcut-hint").get("display")?.includes("none")),
    "and the hints those keycaps label");
  // Same specificity as `.shortcut-hint { display: inline-flex }`, so the hide must come after it.
  const hide = css.search(/@media \(pointer: coarse\)\s*\{\s*kbd:not\(\.shortcut-list kbd\),\s*\.shortcut-hint\s*\{/);
  const hint = css.search(/(^|\})\s*\.shortcut-hint\s*\{/);
  assert.ok(hint >= 0 && hide > hint, "the coarse-pointer hide follows the hint rule it overrides");
  // A max-width block may place or show a keycap (the phone's open search field shows its `/`), but
  // never hides one.
  const keycapSelectors = [...new Set(allDeclarations(css).flatMap((declaration) => declaration.selectors).filter(targetsKeycap))];
  const widthHides = mediaBlocks(css)
    .filter((block) => block.maxWidths.length > 0)
    .flatMap((block) => keycapSelectors.filter((selector) =>
      block.declarationsForSelector(selector).get("display")?.includes("none")));
  assert.deepEqual(widthHides, [], "a narrow window with a mouse still has a keyboard");
});

test("keycap text is --text-dim on --bg-elev-2 at 4.5:1 or better in every palette (§2.11)", () => {
  const palettes = everyPalette(css);
  assert.equal(palettes.length, SCHEMES.length * THEMES.length, "every scheme in both themes");
  const failures = palettes
    .map((palette) => ({ label: palette.label, ratio: contrast(palette.tokens.get("--text-dim")!, palette.tokens.get("--bg-elev-2")!) }))
    .filter(({ ratio }) => ratio < 4.5)
    .map(({ label, ratio }) => `${label}: ${ratio.toFixed(2)}:1`);
  assert.deepEqual(failures, []);
});
