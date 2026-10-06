import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import postcss from "postcss";
import { allDeclarations, containerBlocks, customProperties, declarationsOf, mediaBlocks, topLevelRule } from "./css-rules.js";
import { PINNED_SUMMARY_DOCK_MIN_PX, PINNED_SUMMARY_WIDTH_PX } from "./components/pinned-summary-state.js";

const raw = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
/** Comments carry example declarations and prose; every check below reasons about real rules. */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Declarations of the one top-level rule with this selector list, via a real CSS parser.
 * The previous regex version could be satisfied by a rule nested inside an @media block, and was
 * defeated by whitespace differences in an equivalent selector list.
 */
function soleRuleProps(selector: string): Map<string, string[]> {
  return customProperties(topLevelRule(css, selector));
}

/** Raw declaration text of that rule, for the checks that inspect non-custom properties. */
function soleRuleBody(selector: string): string {
  return topLevelRule(css, selector).nodes
    .map((node) => (node.type === "decl" ? `${node.prop}: ${node.value};` : ""))
    .join("\n");
}

/**
 * Safari zooms the viewport when a control smaller than 16px takes focus, and the user cannot zoom
 * back out. Two earlier attempts at this guard were defeated by the cascade: first by specificity
 * (a bare-element selector is (0,0,1) and loses to every class-scoped rule), then by document
 * order (`:root input` only TIES with `.automation-form-grid input` and `.usage-retention input`,
 * which appear later). Its position at the very end of the file is load-bearing.
 */
test("the iOS focus-zoom guard is the final rule in the stylesheet", () => {
  const guard = css.lastIndexOf(":root .composer-input {");
  assert.notEqual(guard, -1, "the 16px form-text guard must exist");
  assert.match(css.slice(guard), /font-size:\s*16px/, "the guard must set 16px");

  // Scope as well as position: checking only for the composer selector would stay green if the
  // other three selectors were dropped, or if the rule were moved outside the phone media query,
  // while Automation and Usage controls silently went back to zooming on focus.
  // Phones AND every coarse pointer (#1799): a touch tablet zooms on focus exactly as a phone does,
  // and the coarse-pointer block is what sizes its fields.
  const lastMedia = css.lastIndexOf("@media (max-width: 760px), (pointer: coarse)");
  assert.ok(lastMedia !== -1 && lastMedia < guard,
    "the guard must live inside the phone-width and coarse-pointer media query");
  const guardedRule = css.slice(lastMedia);
  for (const selector of [":root select", ":root input", ":root textarea", ":root .ui-select-trigger", ":root .composer-input"]) {
    assert.ok(guardedRule.includes(selector),
      `the focus-zoom guard must still cover ${selector}`);
  }

  // Structural, not declaration-specific: NOTHING may follow the guard. A later rule could defeat
  // it with `font-size` or with the `font` shorthand (which also resets size) at equal
  // specificity, so rejecting only `font-size` would let the shorthand through.
  const closingBrace = css.indexOf("}", css.indexOf("font-size:", guard));
  const afterRule = css.slice(closingBrace + 1);
  const remainder = afterRule.replace(/[\s}]/g, "");
  assert.equal(remainder, "",
    `the focus-zoom guard must be the last rule; found trailing CSS: ${remainder.slice(0, 120)}`);
});

test("known late form rules cannot outrank the focus-zoom guard", () => {
  // These are the rules that beat the previous attempt. They must appear BEFORE the guard so the
  // specificity tie resolves in the guard's favour on document order.
  const guard = css.lastIndexOf(":root .composer-input {");
  for (const selector of [".automation-form-grid input", ".usage-retention input"]) {
    const at = css.indexOf(selector);
    assert.notEqual(at, -1, `${selector} should still exist`);
    assert.ok(at < guard, `${selector} must appear before the focus-zoom guard`);
  }
});

/**
 * These custom properties were referenced across the stylesheet before they were ever defined, so
 * the declarations using them were invalid and dropped — "paused"/"conflicted" states rendered
 * with no colour and commit SHAs rendered in the proportional UI face.
 */
test("every referenced custom property is defined in the shared root scope", () => {
  // Scope matters, not merely "declared somewhere": a token defined only under the light theme
  // leaves every dark-theme consumer unresolved, and one defined inside a component scope does
  // not reach global consumers.
  // Two global scopes, both theme-agnostic in effect: the palette block (which also carries the
  // dark values) and the design-token block. A plain `:root` applies under both themes, so a token
  // declared there resolves everywhere.
  const paletteNames = new Set(soleRuleProps(':root,\n:root[data-theme="dark"]').keys());
  const tokenNames = new Set(soleRuleProps(":root").keys());
  const lightNames = new Set(soleRuleProps(':root[data-theme="light"]').keys());

  // A name in BOTH root scopes resolves inconsistently: the palette selector
  // `:root[data-theme="dark"]` is (0,2,0) and wins under an explicit dark theme, while the plain
  // `:root` token block wins under light. The union below would hide that, so check it first.
  const collisions = [...paletteNames].filter((name) => tokenNames.has(name)).sort();
  assert.deepEqual(collisions, [],
    `declared in both root scopes, so dark and light resolve differently: ${collisions.join(", ")}`);

  const shared = new Set([...paletteNames, ...tokenNames]);
  const light = lightNames;
  const referenced = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]!));

  // Published at runtime by JS rather than declared in the sheet, and always read through a
  // var() fallback, so an undefined value is the normal case rather than a defect. Each entry
  // must be genuinely runtime-set — this is not a place to silence a real missing token.
  const RUNTIME_PUBLISHED = new Set([
    "--keyboard-inset", // installMobileViewportFallback; absent means no occlusion
    // indicateFocusZone measures the lit zone's top edge; absent means no zone is lit.
    "--zone-line-top",
    "--zone-line-left",
    "--zone-line-width",
    // InboxView's stacked list row count (#2217); absent means the three-row minimum.
    "--sessions-list-rows",
  ]);

  // Component-local by design (docs/design-system.md §19.4 rejects promoting them): each is
  // declared on the one component rule that owns it, and only that component reads it.
  const COMPONENT_LOCAL = new Map([
    ["--summary-w", ".detail-body"], // the Pinned Summary's width, read by the body grid and `.ps`
    ["--composer-ctl", ".composer-box"], // the composer bar's control height (#2174), read by `.composer-btn`
    ["--tl-diff-digits", ".tl-diff"], // a transcript diff's widest line number, set per diff (#2187)
    // The stacked Sessions list track (§6.3, #2217), whole rows of the stored ratio; a drag sets it.
    ["--sessions-list-h", ".master-detail.sessions-md"],
  ]);
  for (const [name, owner] of COMPONENT_LOCAL) {
    assert.ok(soleRuleProps(owner).has(name), `${name} is declared on ${owner}`);
  }

  const unresolved = [...referenced]
    .filter((name) => !shared.has(name) && !RUNTIME_PUBLISHED.has(name) && !COMPONENT_LOCAL.has(name))
    .sort();
  assert.deepEqual(unresolved, [],
    `used but not defined in the shared :root scope: ${unresolved.join(", ")}`);

  // The light block may only OVERRIDE tokens the shared block already establishes; a light-only
  // definition would silently break the dark theme.
  const lightOnly = [...light].filter((name) => !shared.has(name)).sort();
  assert.deepEqual(lightOnly, [],
    `defined only under the light theme, so dark is unresolved: ${lightOnly.join(", ")}`);
});

/**
 * `:focus-visible` must not declare border-radius: that restyles the focused ELEMENT, not its
 * outline, so pills, cards, and the circular send button visibly changed shape on keyboard focus.
 */
test("the global focus ring does not restyle the focused element", () => {
  // Anchored to the complete selector: a substring search matches the tail of component rules such
  // as `.rail-brand:focus-visible`, which would leave this test green if the global rule regressed.
  const body = soleRuleBody(":where(:focus-visible)");
  assert.match(body, /outline:/);
  assert.doesNotMatch(body, /border-radius/,
    "border-radius in :focus-visible changes the element's shape, not the outline's");
});

/** The one top-level rule whose selector, with all whitespace removed, is exactly this. */
function baseRule(selector: string): string {
  const squash = (text: string) => text.replace(/\s+/g, "");
  const matches = allDeclarations(css).filter((declaration) => squash(declaration.selector) === squash(selector));
  assert.ok(matches.length > 0, `the base layer must contain a rule for ${selector}`);
  return matches.map((declaration) => `${declaration.prop}: ${declaration.value};`).join("\n");
}

/**
 * Focus is neutral (docs/design-system.md §16.1). The global ring is `--focus` at zero specificity,
 * programmatic targets (`tabIndex={-1}`: the page title, a dialog card, the Settings panel heading)
 * show none, and text fields show focus on their own edge.
 */
test("the global focus ring is neutral, zero-specificity and absent on programmatic targets", () => {
  assert.equal(soleRuleBody(":where(:focus-visible)"),
    "outline: var(--focus-width) solid var(--focus);\noutline-offset: var(--focus-offset);");
  const programmatic = allDeclarations(css).filter((declaration) =>
    /^:where\(\[tabindex="-1"\]/.test(declaration.selector) && /\):focus$/.test(declaration.selector));
  assert.equal(programmatic.length, 1, "exactly one programmatic-focus suppression");
  assert.equal(`${programmatic[0]!.prop}: ${programmatic[0]!.value}`, "outline: none");
  // A roving group focuses options that keep tabIndex -1 (an aria-disabled choice card is focused but
  // never checked). Suppressing the ring on controls would make that keyboard focus invisible.
  // A keyboard-opened Select focuses its tabIndex -1 listbox, which may have no option to highlight.
  for (const control of ["button", "a[href]", "input", "select", "textarea", '[role="radio"]', '[role="option"]',
    '[role="tab"]', '[role="menuitem"]', '[role="checkbox"]', '[role="switch"]', '[role="listbox"]', '[role="menu"]',
    '[role="grid"]', '[role="tree"]', '[role="combobox"]']) {
    assert.ok(programmatic[0]!.selector.includes(control),
      `the programmatic-focus suppression must exclude ${control}`);
  }
  // A digit or a handoff also focuses these tabIndex -1 Sessions containers, where no zone line
  // appears, so the ring is their only cue and is restored after the suppression (equal
  // specificity, later wins). Zone roots stay ringless: the F6 zone line is their cue.
  const zoneRing = ":where(.board-wrap, .inbox-zero):focus-visible";
  assert.equal(baseRule(zoneRing),
    "outline: var(--focus-width) solid var(--focus);\noutline-offset: calc(-1 * var(--focus-width));");
  assert.ok(css.indexOf(zoneRing) > css.indexOf(':where([tabindex="-1"]:not('),
    "the Sessions landing ring must follow the programmatic-focus suppression to win the tie");
  assert.equal(allDeclarations(css).filter((declaration) =>
    /data-focus-zone|zone-lit/.test(declaration.selector) && /focus/.test(declaration.selector)).length, 0,
  "a zone root takes no ring when F6 lands on it");
  // The palette search suppresses its outline, so the bar's bottom edge is its only focus cue.
  assert.equal(soleRuleBody(".palette-bar:has(.palette-input:focus-visible)"), "border-color: var(--focus);");
  assert.equal(soleRuleBody(".clip-focus :focus-visible"), "outline-offset: calc(-1 * var(--focus-width));");
  // A bare `:focus-visible` is (0,1,0) and would outrank component rules that draw their own focus.
  assert.throws(() => topLevelRule(css, ":focus-visible"), /found 0/,
    "the global ring must stay inside :where() so it never outranks a component");

  const field = baseRule(':where(input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"], ' +
    '[type="color"]), textarea, select, .ui-select-trigger, .ui-searchable-combobox-input):focus-visible');
  assert.match(field, /border-color: var\(--focus\);/);
  assert.match(field, /outline: 1px solid var\(--focus\);/);
});

test("no focus ring anywhere is drawn in the accent colour", () => {
  // Teal marks selection. A component that restates the ring restates it neutral; the components
  // that draw focus another way (a field's border, the composer card) are not outlines.
  const accentRings = allDeclarations(css).filter((declaration) =>
    /:focus/.test(declaration.selector) && /^outline/.test(declaration.prop) && /--accent\b/.test(declaration.value));
  assert.deepEqual(accentRings.map((declaration) => `${declaration.line}: ${declaration.selector}`), []);
});

/**
 * Selected, unread and focused Sessions rows (#2076, #2209, docs/design-system.md §5.2): selection is
 * the selected fill and a leading accent bar, unread is a dot and a heavier title with no accent fill,
 * border or bar, and the focused grid draws one inset neutral ring on its active row.
 */
test("a Sessions row's selection, unread state and focus are three different treatments", () => {
  assert.match(soleRuleBody(".inbox-row-shell.selected .inbox-row"), /^background: var\(--surface-selected\);$/);
  const bar = soleRuleBody(".inbox-row-shell.selected .inbox-row-primary-cell::after");
  assert.match(bar, /background: var\(--accent\);/);
  assert.match(bar, /width: var\(--space-0-5\);/, "a 2px bar");
  assert.match(bar, /left: 0;/, "on the leading edge");
  const ring = soleRuleBody('.inbox-list:focus-visible .inbox-row-shell[aria-selected="true"] .inbox-row');
  assert.match(ring, /outline: var\(--focus-width\) solid var\(--focus\);/);
  assert.match(ring, /outline-offset: calc\(-1 \* var\(--focus-width\)\);/, "inset");
  assert.match(soleRuleBody(".inbox-row-shell.unread .inbox-row-title"), /^font-weight: 600;$/);
  assert.match(soleRuleBody(".inbox-unread-dot"), /background: var\(--blue\);/);
  // Nothing about unread touches the row's box, and nothing draws the old --text selection ring.
  for (const declaration of allDeclarations(css)) {
    if (/\.inbox-row-shell\.unread/.test(declaration.selector)) {
      assert.doesNotMatch(declaration.prop, /^(background|border|box-shadow|outline)/, declaration.selector);
    }
    if (/\.inbox-row/.test(declaration.selector)) {
      assert.doesNotMatch(declaration.value, /--accent\b.*inset|inset.*--accent\b|linear-gradient/, declaration.selector);
      assert.doesNotMatch(`${declaration.prop}: ${declaration.value}`, /^(box-shadow|border-color): .*var\(--text\)/,
        declaration.selector);
    }
  }
  assert.doesNotMatch(css, /\.inbox-unread-badge\b/);
});

/**
 * F6 zones (docs/design-system.md §16.1): no pane is framed on focus, and the zone F6 enters shows a
 * 2px --focus line on its top edge that fades out, without the fade under reduced motion.
 */
/** The rule that lets a container's gap space a `.field-label`, and the field label rule (§8.1). */
const STACKED_FIELD_LABELS = [".field > .field-label", ".archive-filter > .field-label", ".automation-field > .field-label"];
/** Labels of two forms that stack them over the control outside a `.field` (#2366). */
const OUTSIDE_FIELD_LABELS = [".archive-search > span", ".archive-filter > .field-label", ".automation-form-grid > label",
  ".automation-field > .field-label", ".automation-form-grid legend"];
const FIELD_LABEL = [".field > span:first-child", ".field > .field-label", ...OUTSIDE_FIELD_LABELS, ".new-session-field-label"].join(",\n");

/** The line under a field's control (§8.1): the helper, the error that replaces it, or a `.field-foot`. */
const FIELD_LINE = ".field > :is(.field-helper, .field-error, .field-foot)";

/**
 * Field anatomy (docs/design-system.md §8.1, #2270): the parts stack --space-2 apart, so the label
 * sits 8px above the control, and the line under the control pulls up by --space-1 to sit 4px under
 * it. A field warning pulls up by the same --space-1, 4px under the helper (§8.5). Every form of the
 * label is --type-label in --text. e2e/field-error.spec.ts measures the result in a browser.
 */
test("a field stacks 8px apart, its helper or error 4px under the control, and its label is --type-label in --text", () => {
  assert.match(soleRuleBody(".field"), /gap: var\(--space-2\);/);
  assert.equal(soleRuleBody(FIELD_LINE), "margin-top: calc(-1 * var(--space-1));",
    "the helper and the error share one offset, so one replacing the other does not move the field");
  assert.match(soleRuleBody(".field-warn"), /margin: calc\(-1 \* var\(--space-1\)\) 0 0;/);
  for (const label of [FIELD_LABEL, ".field-head > :is(label, span):first-child"]) {
    assert.match(soleRuleBody(label), /color: var\(--text\);/, `${label} is in --text`);
    assert.match(soleRuleBody(label), /font: var\(--type-label\);/, `${label} is --type-label`);
  }
  assert.equal(soleRuleBody(STACKED_FIELD_LABELS.join(",\n")), "margin-bottom: 0;", "the field's gap spaces a .field-label");
});

/**
 * #2538: related fields share a `.field-row` of two equal columns, and every row is one column under
 * 480px (§8.1). One shared rule does it: a track's floor is half of 480px less the 12px gap, so the
 * second column fits only from 480px. Hand Off and Import from Git used to carry their own container
 * copies while Connect via SSH, New Run and Onboard Runner kept two 169px fields on a phone. The row
 * sizes itself rather than asking a size container: at the build floor (§2.10) a size container is
 * the box `position: fixed` resolves against, and around a dialog's scrolling body it would clip the
 * Select lists placed in it. e2e/field-row-collapse.spec.ts measures the rows.
 */
test("every field row is one column under 480px, by one shared rule and no size container", () => {
  assert.equal(soleRuleBody(".field-row"),
    "display: grid;\ngrid-template-columns: repeat(auto-fit, minmax(min(100%, calc((480px - 12px) / 2)), 1fr));\ngap: 12px;");
  const columns = allDeclarations(css)
    .filter((declaration) => declaration.prop === "grid-template-columns" && declaration.selectors.some((selector) => /\.field-row\b/.test(selector)))
    .map((declaration) => declaration.selector);
  assert.deepEqual(columns, [".field-row"], "no dialog sets a row's columns, or its collapse, on its own");
  assert.deepEqual(containerBlocks(css).filter((block) => block.containsSelector(".field-row")).map((block) => block.params), [],
    "the collapse is the row's own, not a container query");
  const bodies = allDeclarations(css)
    .filter((declaration) => /^container(-type)?$/.test(declaration.prop) && declaration.selectors.some((selector) => /\.modal-body\b/.test(selector)));
  assert.deepEqual(bodies, [], "a dialog's scrolling body is never a size container");
});

/**
 * #2366: Archived Sessions and the Automations editor stack their labels over the control outside a
 * `.field`. Those labels share the §8.1 rule above, their containers space them by --space-2, and no
 * other rule gives them a colour or type of their own (the old weight-600 overrides are gone). A grid
 * label's helper is dim, 4px under the control. e2e/field-label-outside-field.spec.ts measures them.
 */
test("a label stacked outside a .field is the §8.1 label, 8px above its control", () => {
  for (const container of [".archive-search", ".archive-filter"]) {
    assert.match(soleRuleBody(container), /gap: var\(--space-2\);/, `${container} spaces label and control by --space-2`);
  }
  for (const container of [".automation-form-grid > label", ".automation-form-grid > .automation-field"]) {
    assert.equal(soleRuleBody(container), "display: grid;\ngap: var(--space-2);", `${container} spaces label and control by --space-2`);
  }
  assert.equal(soleRuleBody(".automation-form-grid > label > small"),
    "margin-top: calc(-1 * var(--space-1));\ncolor: var(--text-dim);\nfont: var(--type-small);");
  const overrides: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (rule.selector === FIELD_LABEL) return;
    const owns = rule.selectors.some((selector) => OUTSIDE_FIELD_LABELS.includes(selector.replace(/\s+/g, " ").trim()));
    if (owns && rule.nodes.some((node) => node.type === "decl" && /^(color|font|line-height)/.test(node.prop))) {
      overrides.push(rule.selector);
    }
  });
  assert.deepEqual(overrides, [], "no other rule gives those labels a colour or type of their own");
});

/**
 * #2365: the dim rule for a field's later spans takes only BARE spans. As `.field > span` its
 * (0,1,1) out-ranked `.form-error` and `.muted`, so a field error read dim instead of red and a note
 * took the label's 12px/500. e2e/field-tone-spans.spec.ts reads the result in both dialogs.
 */
test("a field's dim later-span rule leaves classed spans their own colour, size and weight", () => {
  assert.match(soleRuleBody(".field > span:not([class]),\n.field-label"), /color: var\(--text-dim\);/);
  const unscoped = postcss.parse(css).nodes.filter((node) => node.type === "rule" &&
    node.selectors.some((selector) => /^\.field\s*>\s*span$/.test(selector.trim())));
  assert.deepEqual(unscoped.map((node) => (node as postcss.Rule).selector), [],
    "no top-level rule styles every direct span of a .field");
});

/**
 * The invalid field (docs/design-system.md §8.5): one `.field-error` recipe, and one rule that turns
 * the edge of any invalid control in a `.field` red. The rule sets only the edge, so the ring the
 * focus rule above draws (an outline in --focus) is the same on an invalid field.
 */
test("one field error rule, and invalid controls in a field draw a red edge under the standard focus ring", () => {
  const owners = (pattern: RegExp) => [...new Set(allDeclarations(css)
    .filter((declaration) => declaration.selectors.some((selector) => pattern.test(selector)))
    .map((declaration) => declaration.selector))];
  assert.deepEqual(owners(/\.field-error\b/), [FIELD_LINE, ".field-error", ".field-error-icon"],
    "the recipe is written once, beside .field-warn; its place under the control is the helper's rule");
  assert.match(soleRuleBody(".field-error"), /color: var\(--danger-text\);/);
  assert.match(soleRuleBody(".field-error"), /font: var\(--type-small\);/);
  assert.match(soleRuleBody(".field-error"), /margin: 0;/, "it takes the helper's place, with no offset of its own");
  assert.match(soleRuleBody(".field-error-icon"), /width: var\(--icon-sm\);/);
  assert.doesNotMatch(soleRuleBody(".field-error-icon"), /(^|\n)color:/,
    "the icon inherits the words' colour, so forced colors repaints it with them");

  const invalid = '.field [aria-invalid="true"],\n.field [aria-invalid="true"]:hover,\n.composer-answer-input[aria-invalid="true"]';
  assert.equal(soleRuleBody(invalid), "border-color: var(--red);", "the edge only: the focus ring stays --focus");
  assert.deepEqual(owners(/\[aria-invalid/), [invalid.replace(/\s+/g, " ")],
    "every invalid edge is this one rule; a control does not draw its own");
  assert.ok(css.indexOf(invalid) > css.indexOf(".composer-answer-input:focus {"),
    "the composer answer keeps its red edge while focused: equal specificity, so the later rule wins");
});

test("focus never frames a pane, and the F6 zone line is a brief neutral top edge", () => {
  const paneFrames = allDeclarations(css).filter((declaration) =>
    /focus/.test(declaration.selector) && /^(border|box-shadow)/.test(declaration.prop) && /--accent\b/.test(declaration.value)
    && /::?(after|before)|pane/.test(declaration.selector));
  assert.deepEqual(paneFrames.map((declaration) => `${declaration.line}: ${declaration.selector}`), []);
  assert.doesNotMatch(css, /\.inbox-preview-pane:has\(\.detail-scroll:focus-visible\)::after/);
  assert.doesNotMatch(css, /\.inbox-list-pane:has\(> \.inbox-list:focus-visible\)::after/);

  const line = soleRuleBody(".zone-lit::after");
  for (const declaration of ["position: fixed;", "top: var(--zone-line-top, 0px);", "left: var(--zone-line-left, 0px);",
    "width: var(--zone-line-width, 0px);", "height: 0;", "border-top: var(--focus-width) solid var(--focus);", "pointer-events: none;"]) {
    assert.ok(line.includes(declaration), `the zone line needs ${declaration}`);
  }
  assert.match(line, /animation: zone-line-fade 1\.5s /, "the line lasts the 1.5s ZONE_INDICATOR_MS holds the class");
  assert.ok(mediaBlocks(css).some((block) => block.params === "(prefers-reduced-motion: reduce)"
    && block.containsSelector(".zone-lit::after")), "reduced motion shows the line without the fade");
});

/**
 * The base resets (docs/design-system.md §2.3 and §2.4). Without them inputs render in the browser's
 * Arial, unsized buttons at 13.333px, a field inside a bold label renders bold, and a button with no
 * class renders as a gray browser button.
 */
test("form controls and buttons inherit the app's type, and bare buttons reset", () => {
  assert.equal(baseRule("body").split("\n").find((line) => line.startsWith("font:")), "font: var(--type-body);");
  assert.doesNotMatch(baseRule("body"), /font-size|font-family/, "body type comes from --type-body alone");
  assert.equal(baseRule("button, input, select, textarea"), "font: inherit;");
  assert.equal(baseRule("input, select, textarea").split("\n")[0], "font-weight: 400;");
  assert.equal(baseRule(":where(button)"),
    ["background: none;", "border: 0;", "color: inherit;", "font: inherit;", "padding: 0;"].join("\n"));
  // The Automation form's fields inherited 600 from their label through a local `font: inherit`.
  assert.doesNotMatch(soleRuleBody(".automation-form-grid input, .automation-form-grid select, .automation-form-grid textarea"),
    /font:/, "a local font shorthand would re-inherit the label's weight");
});

/**
 * At phone width the iOS focus-zoom guard lifts fields to 16px. That rule may change a control's SIZE
 * only: a family (or a `font` shorthand, which resets the family) inside a phone-width block would put
 * phone fields back on a face other than the app's, which is the defect the base reset exists to fix.
 */
test("phone-width rules resize controls but never change their font family", () => {
  const offenders: string[] = [];
  let phoneBlocks = 0;
  let guard: string[] | null = null;
  postcss.parse(css).walkAtRules("media", (block) => {
    const widths = [...block.params.matchAll(/max-width:\s*(\d+)px/g)].map((match) => Number(match[1]));
    if (!widths.some((width) => width <= 760)) return;
    phoneBlocks += 1;
    block.walkRules((rule) => {
      const controls = /\b(input|select|textarea|button)\b|composer-input/.test(rule.selector);
      const declarations = rule.nodes.flatMap((node) => (node.type === "decl" ? [node] : []));
      if (rule.selector.includes(":root .composer-input")) {
        guard = declarations.map((declaration) => `${declaration.prop}: ${declaration.value}`);
      }
      if (!controls) return;
      for (const declaration of declarations) {
        if (declaration.prop === "font-family" || (declaration.prop === "font" && declaration.value !== "inherit")) {
          offenders.push(`${rule.selector.replace(/\s+/g, " ")} { ${declaration.prop}: ${declaration.value} }`);
        }
      }
    });
  });
  assert.ok(phoneBlocks > 0, "the phone-width media blocks must be found");
  assert.deepEqual(offenders, [], "a phone rule must not change a control's font family");
  assert.deepEqual(guard, ["font-size: 16px"], "the focus-zoom guard sets the size and nothing else");
});

test("a connection banner takes the top safe area only at the very top of the main area", () => {
  // On a phone page route the banner sits above the page header, which gives up its safe-area
  // padding (#1801); on the phone Session route it sits below the Session bar, which keeps it.
  const phone = mediaBlocks(css).filter((block) => block.maxWidths.includes(760));
  const first = phone.flatMap((block) => block.declarationsForSelector(".main > .notice.page-banner:first-child").get("padding-top") ?? []);
  assert.deepEqual(first, ["max(var(--space-1), env(safe-area-inset-top, 0px))"]);
  const bare = phone.flatMap((block) => block.declarationsForSelector(".notice.page-banner").get("padding-top") ?? []);
  assert.deepEqual(bare, [], "a bare page-banner inset would clear the safe area twice under the Session bar");
});

test("a crashed route's error notice lines up with its page header", () => {
  // ErrorBoundary puts the notice in `.page` under the route's PageHeader (#1801); the page supplies
  // the gutter, so the notice's own standalone margin would push it right of the header.
  assert.match(topLevelRule(css, ".page > .notice.view-error").toString(), /margin: 0/);
});

test("links, native controls and code use the base recipes", () => {
  assert.equal(baseRule("html"), "accent-color: var(--accent);");
  assert.equal(baseRule("a, .link"), "color: var(--accent);");
  assert.equal(baseRule("a.btn"), "text-decoration: none;");
  assert.equal(baseRule("code, pre"), "font-family: var(--font-mono);");
  assert.match(baseRule(":not(pre) > code"), /border: 1px solid var\(--border\);/);
  // The chip belongs to inline code only. A bare `code` rule would put it back inside `pre`.
  assert.throws(() => topLevelRule(css, "code"), /found 0/, "the chip must stay scoped to :not(pre) > code");
  // #1800 adds `.modal-body` together with its 16px body gap (§2.4, §7.2).
  assert.equal(baseRule(":where(.form, .section, .surface, .modal-body, .notice, .state) > *"), "margin: 0;");
});

test("the permission-mode menu is plain shared menu rows with amber only on the risk icon", () => {
  // Each mode is one shared two-line menu row (#2190); a row with a second line (the mode's
  // meaning) wraps its label instead of truncating it.
  assert.match(soleRuleBody(".menu-item:has(.menu-desc) .menu-text"), /overflow-wrap: anywhere;/);
  // The per-row outcome label, details button and details dialog are gone, red text with them.
  for (const retired of [
    "cbar-permission-row",
    "cbar-permission-details-trigger",
    "cbar-elicitation-state",
    "permission-mode-details-copy",
    "cbar-permission-description",
  ]) {
    assert.doesNotMatch(css, new RegExp(`\\.${retired}\\b`), `.${retired} is retired`);
  }
  // A mode that skips approvals is a risk warning: amber on its icon only (§21 item 5).
  assert.match(soleRuleBody(".menu-icon > .permission-mode-risk"), /^color: var\(--amber\);$/m);
});

test("message and turn actions use the shared small icon button and never size themselves", () => {
  // .icon-btn.sm is 28px on a fine pointer and 36px with a 44px hit area on a coarse one (§2.8);
  // a local width, height or margin would undo that, or overlap neighbouring hit areas again.
  const sized = allDeclarations(css).filter((declaration) =>
    ["width", "height", "min-width", "min-height", "margin", "margin-left", "margin-right", "margin-inline-start"]
      .includes(declaration.prop) &&
    declaration.selectors.some((selector) => /\.tl-(message-actions|user-actions|more-actions|hover-action)\b[^,]*$/.test(selector)));
  assert.deepEqual(sized, [], "transcript actions take their size from .icon-btn.sm");
  assert.doesNotMatch(css, /\.tl-message-icon|\.tl-message-action-unavailable/, "the old 24px targets are gone");
});

test("hover clusters take no height and show on hover, focus within or an open menu", () => {
  const user = soleRuleBody(".tl-user-actions, .tl-user-menu");
  assert.match(user, /position: absolute;/, "the user cluster sits beside the bubble, not under it");
  assert.match(user, /bottom: 0;/, "bottom-aligned with the bubble");
  assert.match(user, /inset-inline-end: calc\(100% \+ var\(--space-1\)\);/, "to the bubble's left");
  assert.match(soleRuleBody(".tl-user-actions, .tl-hover-action"), /opacity: 0;/);
  assert.equal(soleRuleBody([
    ".tl-row.user:is(:hover, :focus-within) .tl-user-actions",
    ".tl-user-actions:has([aria-expanded=\"true\"])",
    ".tl-turn-footer:is(:hover, :focus-within) .tl-hover-action",
    ".tl-turn-footer:has([aria-expanded=\"true\"]) .tl-hover-action",
  ].join(", ")), "opacity: 1;");
  // More Turn Actions is never part of a hover cluster: it stays visible at rest, quietly (#599).
  assert.equal(soleRuleBody(".tl-more-actions"), "color: var(--text-faint);");
  const hidesMenu = allDeclarations(css).filter((declaration) =>
    ["opacity", "visibility", "display"].includes(declaration.prop) &&
    declaration.selectors.some((selector) => /\.tl-(more-actions|user-menu)\b/.test(selector)));
  assert.deepEqual(hidesMenu, [], "nothing hides More Turn Actions, or a touch screen's More Message Actions");
});

test("the phone Session status control leads its line without pushing the fixed actions", () => {
  // Changes are a Git fact in the Pinned Summary now (#2160), not a status group in the bar.
  assert.doesNotMatch(css, /\.change-status-indicators\b/);
  // One status control replaced the measured badge row and its "+N" disclosure (#2182).
  assert.doesNotMatch(css, /\.session-header-statuses\b|\.session-status-overflow-trigger\b|\.status-label-narrow\b/);
  const phoneRule = mediaBlocks(css).find((block) =>
    block.maxWidths.includes(760) &&
    block.containsSelector(".session-bar > .session-status-button"));
  assert.ok(phoneRule, "the phone layout must place the Session status control");
  const status = phoneRule.declarationsForSelector(".session-bar > .session-status-button");
  assert.deepEqual(status.get("grid-column"), ["1"],
    "the status control must stop before the dedicated action track");
  assert.deepEqual(status.get("justify-self"), ["start"], "it leads the line");
  assert.deepEqual(status.get("min-width"), ["0"]);
  assert.deepEqual(status.get("max-width"), ["100%"],
    "a long label must not widen its track into Share and More Actions");
  assert.deepEqual(status.get("height"), ["36px"], "the control is the line's small size, like Share");
  assert.equal(status.has("overflow"), false, "clipping the button would clip its borrowed touch target");
  assert.deepEqual(phoneRule.declarationsForSelector(".session-bar > .session-status-button > .status")
    .get("overflow"), ["hidden"], "the badge clips inside its track instead");
  // The header badge is the one `.status` recipe (docs/design-system.md §11.1), so the phone keeps
  // its 11px type rather than dropping to the retired 10px `--text-2xs`.
  assert.equal(phoneRule.declarationsForSelector(".session-bar > .session-status-button > .status").has("font-size"),
    false, "the phone keeps the shared badge recipe's size");
  assert.match(soleRuleBody(".status"), /^font: var\(--type-micro\);$/m,
    "the status recipe sets 11px/500 through --type-micro");
  // `.sm` is also a 12px text utility later in the sheet; the badge's own size class has to win.
  assert.match(soleRuleBody(".status.sm"), /^font-size: var\(--text-xs\);$/m,
    "the small badge keeps 11px against the older `.sm` utility");
  assert.deepEqual(
    phoneRule.declarationsForSelector(".session-bar").get("min-height"),
    ["44px"],
    "the compact status/action row must override the desktop 48px bar",
  );
  assert.deepEqual(
    phoneRule.declarationsForSelector(".session-bar").get("row-gap"),
    ["0"],
    "a single-row bar must not leave an empty second-row gap",
  );
  assert.deepEqual(
    phoneRule.declarationsForSelector(
      ".session-bar > .detail-actions",
    ).get("align-self"),
    ["center"],
    "status and action centers must remain aligned if the single row grows",
  );
});

test("mobile Session chrome keeps its coupled offsets and compact action icons", () => {
  const phoneRule = mediaBlocks(css).find((block) =>
    block.maxWidths.includes(760) &&
    block.containsSelector(".topbar") &&
    block.containsSelector(".right-panel") &&
    block.containsSelector(".topbar:has(.mobile-session-back)") &&
    block.containsSelector(".app:has(.mobile-session-back) .right-panel"));
  assert.ok(phoneRule, "the phone layout must define both default and Session chrome geometry");

  const sharedTokens = soleRuleProps(":root");
  assert.deepEqual(sharedTokens.get("--mobile-session-action-gap"), ["var(--space-2)"],
    "8px apart, so each 36px button keeps its whole borrowed 44px hit area");
  assert.deepEqual(sharedTokens.get("--mobile-session-trailing-inset"),
    ["calc(12px + env(safe-area-inset-right, 0px))"]);

  const sessionTopbar = phoneRule.declarationsForSelector(".topbar:has(.mobile-session-back)");
  const paneActions = phoneRule.declarationsForSelector(
    ".topbar:has(.mobile-session-back) .topbar-mobile-controls",
  );
  const sessionHeader = phoneRule.declarationsForSelector(".session-bar");
  const sessionActions = phoneRule.declarationsForSelector(
    ".session-bar > .detail-actions",
  );
  assert.deepEqual(sessionTopbar.get("padding-right"), ["var(--mobile-session-trailing-inset)"]);
  assert.deepEqual(sessionHeader.get("padding-right"), ["var(--mobile-session-trailing-inset)"]);
  assert.deepEqual(paneActions.get("gap"), ["var(--mobile-session-action-gap)"]);
  assert.deepEqual(sessionActions.get("gap"), ["var(--mobile-session-action-gap)"]);

  const defaultTopbarHeight = phoneRule.declarationsForSelector(".topbar").get("height");
  const defaultPanelTop = phoneRule.declarationsForSelector(".right-panel").get("top");
  assert.deepEqual(defaultTopbarHeight,
    ["calc(50px + env(safe-area-inset-top, 0px))"]);
  assert.deepEqual(defaultPanelTop, defaultTopbarHeight,
    "the default right panel must begin at the default topbar's bottom edge");

  const sessionTopbarHeight = phoneRule
    .declarationsForSelector(".topbar:has(.mobile-session-back)").get("height");
  const sessionPanelTop = phoneRule
    .declarationsForSelector(".app:has(.mobile-session-back) .right-panel").get("top");
  assert.deepEqual(sessionTopbarHeight,
    ["calc(var(--bar-h) + env(safe-area-inset-top, 0px))"]);
  assert.deepEqual(sessionPanelTop, sessionTopbarHeight,
    "the Session right panel must begin at the compact Session topbar's bottom edge");

  const actionIcon = phoneRule.declarationsForSelector(".session-bar .session-header-action svg");
  assert.deepEqual(actionIcon.get("width"), ["var(--icon)"]);
  assert.deepEqual(actionIcon.get("height"), ["var(--icon)"]);
});

/**
 * The floating tail control (#2153) replaces the always-mounted recovery band and the follow chip.
 * Its "never moves the reader" guarantee is structural: the control floats from a zero-height flow
 * anchor below the reader, so whether it shows, and what it says, cannot change the reader's
 * height, its scroll position or the follow state.
 */
test("the tail control floats from a zero-height anchor and never takes the reader's height", () => {
  const anchor = soleRuleBody(".transcript-tail-anchor");
  assert.match(anchor, /position:\s*relative;/);
  assert.match(anchor, /flex:\s*none;/);
  assert.match(anchor, /height:\s*0;/, "the anchor reserves no band below the reader");

  const control = soleRuleBody(".transcript-tail-anchor > .btn.transcript-tail-control");
  assert.match(control, /position:\s*absolute;/, "the control is an overlay, never a flow box");
  assert.match(control, /bottom:\s*var\(--space-3\);/);
  assert.match(control, /right:\s*var\(--space-3\);[\s\S]*left:\s*var\(--space-3\);[\s\S]*width:\s*fit-content;[\s\S]*margin-right:\s*auto;[\s\S]*margin-left:\s*auto;/,
    "centered on the reading column, and never wider than the pane's gutters");
  assert.match(control, /border-radius:\s*var\(--radius-sm\);/, "an action, so a control radius, never a pill");
  assert.match(control, /box-shadow:\s*var\(--elev-2\);/);
  assert.match(control, /touch-action:\s*none;/,
    "a touch drag starting on the control is handed to the reader rather than lost (#2425)");

  // No state may take the control out of its absolute layer.
  for (const declaration of allDeclarations(css)) {
    if (!declaration.selectors.some((selector) => selector.includes("transcript-tail-control"))) continue;
    if (declaration.prop === "position") assert.equal(declaration.value, "absolute", declaration.selector);
  }

  // The band and the chip are gone, with every rule that reserved or echoed them.
  assert.doesNotMatch(css, /transcript-recovery-|follow-tail-/);
  assert.doesNotMatch(css, /@container transcript-pane \(max-height:/,
    "no short-pane mode remains: nothing below the reader needs to collapse");
});

test("the reader extends to the composer, which seats context and cost in its bar (#2166)", () => {
  // The status strip, its seat rules and the pane container its cutoffs measured are gone.
  assert.doesNotMatch(css, /transcript-status-|transcript-pane/);
  assert.doesNotMatch(soleRuleBody(".detail-main"), /container/);
  // Both triggers are fixed seats in the trailing cluster: the bar never wraps, the model label
  // is what truncates, and the triggers leave for Model Settings before the bar runs out of room.
  assert.match(soleRuleBody(".cbar-right > :is(.context-control, .session-usage)"), /flex:\s*none;/);
  assert.match(soleRuleBody(".btn.cbar-usage"), /font:\s*var\(--type-small\);/);
  // The Reply keycap's row takes no height, so the textarea never moves when it comes and goes.
  const hint = soleRuleBody(".composer-reply-hint");
  assert.match(hint, /height:\s*0;/);
  assert.match(hint, /margin-bottom:\s*calc\(-1 \* var\(--space-2\)\);/);
  assert.match(soleRuleBody(".composer-box"), /gap:\s*8px;/, "the negative margin returns exactly this gap");

  // The reader region clips: in panes shorter than the scroller's own padding floor, the
  // scroller would otherwise overflow the reader down over the composer and swallow its clicks.
  assert.match(soleRuleBody(".detail-reader"), /overflow:\s*clip;/,
    "nothing inside the reader may paint or intercept below its bounds");
});

/**
 * The Pinned Summary takes its own space (#2147): a column beside the reader while the reader keeps
 * 560px, otherwise a drawer in the reader's grid cell, and on a phone a sheet dialog. The floating
 * card (absolutely positioned over the transcript) and its 35vh phone scroll box must not return.
 */
test("the Pinned Summary docks beside the reader only while the reader keeps 560px", () => {
  const summaryRule = (selector: string) => /\.(ps|ps-scrim|ps-body)(?![\w-])/.test(selector);
  for (const declaration of allDeclarations(css)) {
    assert.ok(!declaration.selectors.some((selector) => selector.includes("pinned-summary")),
      `the floating card's rules are gone (line ${declaration.line}: ${declaration.selector})`);
    if (!declaration.selectors.some(summaryRule)) continue;
    assert.notEqual(declaration.prop, "position",
      `the summary is laid out by the grid, never positioned (line ${declaration.line}: ${declaration.selector})`);
    assert.ok(!(declaration.prop === "max-height" && /vh/.test(declaration.value)),
      `the summary is never a viewport-capped scroll box (line ${declaration.line}: ${declaration.selector})`);
    assert.notEqual(declaration.prop, "order",
      `the summary is never reordered above the transcript (line ${declaration.line}: ${declaration.selector})`);
  }

  // One width, held equal to the JS constant the toggle and the docking rule use.
  assert.deepEqual(soleRuleProps(".detail-body").get("--summary-w"), [`${PINNED_SUMMARY_WIDTH_PX}px`]);
  assert.match(soleRuleBody(".detail-body"), /grid-auto-columns:\s*var\(--summary-w\);/);
  assert.match(soleRuleBody(".ps"), /width:\s*var\(--summary-w\);/);
  assert.match(soleRuleBody(".ps"), /overflow-y:\s*auto;/, "the summary scrolls on its own");
  assert.match(soleRuleBody(".ps-body"), /padding:\s*var\(--space-3\) var\(--space-3\) var\(--space-6\);/,
    "24px of bottom padding, so the last row is never clipped");

  // The body is a named size container on desktop and compact, so docking follows the room the
  // right panel leaves rather than the viewport; a phone keeps viewport coordinates for its sheet.
  const containerMedia = mediaBlocks(css).filter((block) =>
    block.declarationsForSelector(".detail-body").get("container")?.includes("session-body / inline-size"));
  assert.deepEqual(containerMedia.map((block) => block.params), ["(min-width: 761px)"]);

  // Docked from exactly the reader minimum plus the summary width, mirrored by the JS presentation.
  const docked = containerBlocks(css).filter((block) => block.params.startsWith("session-body"));
  assert.equal(docked.length, 1, "one docking rule");
  assert.equal(docked[0]!.params, `session-body (min-width: ${PINNED_SUMMARY_DOCK_MIN_PX}px)`);
  assert.deepEqual(docked[0]!.declarationsForSelector(".ps").get("grid-area"), ["1 / 2"],
    "docked, the summary takes the column after the reader");
  assert.deepEqual(docked[0]!.declarationsForSelector(".ps-scrim").get("display"), ["none"]);
});

test("wrapped code blocks break long prose instead of scrolling sideways", () => {
  // The default stays non-wrapping for source code…
  assert.match(soleRuleBody(".md pre code"), /white-space: pre;/);
  assert.match(soleRuleBody(".md pre"), /overflow-x: auto;/);
  // …and `.md-code-wrap` (prose default or the Wrap Lines toggle) must both wrap preserved
  // newlines and break unbroken runs, or narrow viewports still get a horizontal scrollbar.
  const wrapped = soleRuleBody(".md .md-code-wrap pre code");
  assert.match(wrapped, /white-space: pre-wrap;/);
  assert.match(wrapped, /overflow-wrap: anywhere;/);
});

/** Relative luminance per WCAG 2.1, from a `#rrggbb` token value. */
function luminance(hex: string): number {
  const channel = (raw: number) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Resolve a token to its literal hex in one theme, falling back to the shared root. */
function token(name: string, theme: "dark" | "light"): string {
  const scope = theme === "light"
    ? soleRuleBody(':root[data-theme="light"]')
    : soleRuleBody(':root,\n:root[data-theme="dark"]');
  const shared = soleRuleBody(':root,\n:root[data-theme="dark"]');
  const find = (body: string) => body.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  const value = find(scope) ?? find(shared);
  assert.ok(value, `${name} must resolve to a hex value in the ${theme} theme`);
  return value!.toLowerCase();
}

/**
 * Small muted text is the easiest place to drift below AA, and it already happened once: mapping
 * the undefined --muted to --text-faint put 11px governance text at ~4.4:1. These pairs are the
 * ones that render small text directly on a base surface.
 */
test("small muted text clears WCAG AA against its surface in both themes", () => {
  const pairs: Array<[string, string, string]> = [
            ["--text-dim", "--bg", "secondary body text"],
  ];
  for (const theme of ["dark", "light"] as const) {
    for (const [fg, bg, what] of pairs) {
      const ratio = contrast(token(fg, theme), token(bg, theme));
      assert.ok(ratio >= 4.5,
        `${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below AA 4.5 — ${what}`);
    }
  }
});

/**
 * The check above proves the TOKENS are safe; this one proves the small-text CONSUMERS actually
 * reference a safe token. Without it, a rule could be pointed back at --text-faint and stay green
 * — which is exactly how the governance regression reached review.
 */
test("small-text consumers reference a token that clears AA on their surface", () => {
  const consumers: Array<[string, string]> = [
    [".tl-decision-detail", "--bg"],
    [".tl-decision-time", "--bg"],
    [".facts dt", "--bg"],
  ];
  for (const [selector, surface] of consumers) {
    const rule = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, "s").exec(css);
    assert.ok(rule, `${selector} must exist`);
    const used = rule![1]!.match(/color:\s*var\((--[a-z0-9-]+)\)/)?.[1];
    assert.ok(used, `${selector} must set colour through a token, not a literal`);
    for (const theme of ["dark", "light"] as const) {
      const ratio = contrast(token(used!, theme), token(surface, theme));
      assert.ok(ratio >= 4.5,
        `${theme}: ${selector} uses ${used} on ${surface} at ${ratio.toFixed(2)}:1, below AA 4.5`);
    }
  }
});
