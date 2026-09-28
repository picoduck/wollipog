import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import postcss, { type AtRule, type Rule } from "postcss";
import { customProperties, topLevelRule } from "./css-rules.js";

/**
 * docs/design-system.md §2.8, §3.1 and §15.3 (#1799): every core control takes one of the control
 * heights, and touch sizing lives in ONE coarse-pointer block keyed to the pointer rather than the
 * viewport. Before this, 53 `min-height: 44px` patches keyed to three widths gave a narrow mouse
 * window 44px buttons and a touch tablet 26px ones, and every new control needed another patch.
 */

const raw = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
const root = postcss.parse(css);

function ruleBody(selector: string): Map<string, string> {
  const body = new Map<string, string>();
  for (const node of topLevelRule(css, selector).nodes) if (node.type === "decl") body.set(node.prop, node.value);
  return body;
}

const mediaOf = (node: postcss.Node): string[] => {
  const out: string[] = [];
  for (let parent = node.parent; parent && parent.type !== "root"; parent = parent.parent) {
    if (parent.type === "atrule") out.unshift(`@${(parent as AtRule).name} ${(parent as AtRule).params}`);
  }
  return out;
};

/** The one `@media (pointer: coarse)` block that resizes the control tokens. */
function coarseBlock(): AtRule {
  const blocks: AtRule[] = [];
  root.walkAtRules("media", (atRule) => {
    if (atRule.params !== "(pointer: coarse)") return;
    let resizes = false;
    atRule.walkDecls("--control-h", () => { resizes = true; });
    if (resizes) blocks.push(atRule);
  });
  assert.equal(blocks.length, 1, "exactly one coarse-pointer block resizes the control tokens");
  return blocks[0]!;
}

function coarseRule(selector: string): Map<string, string> {
  const body = new Map<string, string>();
  coarseBlock().each((node) => {
    if (node.type !== "rule" || (node as Rule).selector.replace(/\s+/g, " ").trim() !== selector) return;
    (node as Rule).walkDecls((decl) => { body.set(decl.prop, decl.value); });
  });
  assert.ok(body.size > 0, `the coarse-pointer block must contain ${selector}`);
  return body;
}

test("the control, row and icon tokens hold the §2.8 values, and touch resizes them once", () => {
  const shared = customProperties(topLevelRule(css, ":root"));
  const fine = {
    "--control-h-sm": "28px", "--control-h": "32px", "--control-h-lg": "40px",
    "--row-h": "40px", "--row-h-2": "56px", "--row-h-dense": "32px",
    "--icon-sm": "14px", "--icon": "16px", "--icon-lg": "20px",
    "--switch-w": "32px", "--switch-h": "18px", "--switch-thumb": "12px",
  };
  for (const [name, value] of Object.entries(fine)) assert.deepEqual(shared.get(name), [value], name);

  const coarse = coarseRule(":root");
  const touch = {
    "--control-h": "44px", "--control-h-lg": "48px", "--control-h-sm": "36px",
    "--row-h": "48px", "--row-h-2": "64px", "--row-h-dense": "44px",
    "--switch-w": "40px", "--switch-h": "24px", "--switch-thumb": "18px",
  };
  for (const [name, value] of Object.entries(touch)) assert.equal(coarse.get(name), value, `${name} on touch`);
  assert.ok(!coarse.has("--icon") && !coarse.has("--icon-sm") && !coarse.has("--icon-lg"),
    "icon sizes are the same on every pointer");
});

test("the coarse-pointer block comes after every control rule it resizes", () => {
  const at = coarseBlock().source!.start!.offset;
  for (const selector of [".btn", ".icon-btn", ".ui-switch", ".ui-seg-option", ".ui-select-trigger, .ui-searchable-combobox-input"]) {
    assert.ok(topLevelRule(css, selector).source!.start!.offset < at, `${selector} precedes the block`);
  }
  assert.ok(at < css.indexOf("/* --- COLOUR SCHEMES, GENERATED --- */") || !css.includes("COLOUR SCHEMES"),
    "the block sits above the generated scheme section, which regeneration replaces");
});

test("every core control is one control height, never sized by its padding", () => {
  const btn = ruleBody(".btn");
  assert.equal(btn.get("height"), "var(--control-h)");
  assert.equal(btn.get("padding"), "0 var(--space-3)");
  assert.equal(btn.get("gap"), "var(--space-2)");
  assert.equal(btn.get("font"), "var(--type-body-strong)");
  assert.equal(btn.get("white-space"), "nowrap", "a button label never wraps (§3.1)");
  assert.equal(btn.get("flex"), "none", "a button never shrinks or grows in a flex row (§3.1)");
  assert.equal(ruleBody(".btn.sm").get("height"), "var(--control-h-sm)");
  assert.equal(ruleBody(".btn.sm").get("padding"), "0 var(--space-2)");
  assert.equal(ruleBody(".btn.sm").get("gap"), "var(--space-1)");
  assert.equal(ruleBody(".btn.lg").get("height"), "var(--control-h-lg)");

  for (const [selector, size] of [[".icon-btn", "--control-h"], [".icon-btn.sm", "--control-h-sm"], [".icon-btn.lg", "--control-h-lg"]]) {
    const body = ruleBody(selector!);
    assert.equal(body.get("width"), `var(${size})`, `${selector} is square`);
    assert.equal(body.get("height"), `var(${size})`, `${selector} is square`);
  }
  assert.equal(ruleBody(".icon-btn").get("font-size"), "var(--icon)", "a glyph icon is the 16px icon size");

  const field = ruleBody(':where(input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"], [type="color"]), select)');
  assert.equal(field.get("height"), "var(--control-h)", "text inputs and native selects");
  // `input, select, textarea` also names the base layer's weight reset, so find the field recipe.
  const fieldLook = new Map<string, string>();
  root.each((node) => {
    if (node.type !== "rule" || (node as Rule).selectors.join(",") !== "select,input,textarea") return;
    (node as Rule).walkDecls((decl) => { fieldLook.set(decl.prop, decl.value); });
  });
  assert.equal(fieldLook.get("background"), "var(--field-bg)");
  assert.equal(fieldLook.get("border"), "1px solid var(--control-outline)");
  assert.equal(fieldLook.get("border-radius"), "var(--radius-sm)");
  assert.equal(ruleBody("select, input").get("padding"), "0 var(--space-3)");

  const trigger = ruleBody(".ui-select-trigger, .ui-searchable-combobox-input");
  assert.equal(trigger.get("height"), "var(--control-h)");
  assert.equal(trigger.get("width"), "100%", "a select trigger fills its field (§8.3)");
  assert.equal(trigger.get("background"), "var(--field-bg)");
  assert.ok(!trigger.has("min-width"), "the 160px minimum is gone");

  for (const track of [".ui-seg", ".seg", ".scope-seg"]) {
    assert.equal(ruleBody(track).get("height"), "var(--control-h)", `${track} is one track height`);
  }
  assert.ok(!ruleBody(".seg").has("flex-wrap"), "the legacy segmented control no longer wraps its options");

  // Fields framed by a component take the same height as the controls beside them.
  assert.equal(ruleBody(".source-symbol-form input, .source-editor-select").get("height"), "var(--control-h)");
  assert.equal(ruleBody(".archive-search > div").get("height"), "var(--control-h)");
  // Small buttons borrow 4px a side on touch, so a row of them keeps them at least 8px apart.
  assert.equal(ruleBody(".approval-actions").get("gap"), "var(--space-2)");

  const track = ruleBody(".ui-switch");
  assert.equal(track.get("width"), "var(--switch-w)");
  assert.equal(track.get("height"), "var(--switch-h)");
});

/**
 * The declarations that still set a literal 44px after the patches were deleted. Each is a bar, a
 * row or a container, not a control, and stays for the area issue that redesigns it.
 */
const REMAINING_MIN_HEIGHT_44 = [
  // The phone Session header row; its geometry is asserted in styles.test.ts (#1801 detail bar).
  "@media (max-width: 760px)|.session-detail > .detail-head",
  // A project row on touch (#1803 rows).
  "@media (hover: none), (pointer: coarse)|.project-manager-item",
  // The Settings rail-order row (#1803 rows).
  "|.rail-order-row",
];

const CORE_CONTROL = /\.btn\b|\.icon-btn\b|(^|[\s>+~(])(input|select|textarea)\b|\.ui-select-trigger|\.ui-searchable-combobox-input|\.ui-seg-option|\.seg-btn|\.scope-opt|\.ui-switch|\.menu-item|\.plus-item|\.ui-select-option/;

test("no per-selector 44px patch remains on a control; only listed bars, rows and containers", () => {
  const minHeights: string[] = [];
  const onControls: string[] = [];
  root.walkDecls((decl) => {
    if (!/^(min-|max-)?(height|width)$/.test(decl.prop) || !/\b44px\b/.test(decl.value)) return;
    const rule = decl.parent as Rule;
    const key = `${mediaOf(decl).join(" > ")}|${rule.selector.replace(/\s+/g, " ").trim()}`;
    if (decl.prop === "min-height" && decl.value === "44px") minHeights.push(key);
    if (rule.selectors.some((selector) => CORE_CONTROL.test(selector))) onControls.push(`${key}|${decl.prop}`);
  });
  assert.deepEqual(minHeights.sort(), [...REMAINING_MIN_HEIGHT_44].sort());
  assert.equal(raw.match(/min-height: 44px/g)?.length, REMAINING_MIN_HEIGHT_44.length,
    "`grep -c \"min-height: 44px\"` counts the same declarations, comments included");
  assert.deepEqual(onControls, [], "a core control takes its touch size from the tokens");
});

test("the hit areas are drawn once, in the coarse-pointer block", () => {
  // Each inset is measured from the control's PADDING edge, so a 1px border adds a pixel: the
  // target still ends 4px past the visible edge (e2e specs check it with elementFromPoint).
  assert.equal(coarseRule(":is(.btn.sm, .icon-btn.sm, button.chip)::after").get("inset"), "-4px");
  assert.equal(coarseRule(":is(.btn.sm, button.chip)::after").get("inset"), "-5px", "bordered small controls");
  assert.equal(coarseRule(":where(.btn.sm, .icon-btn.sm, button.chip)").get("position"), "relative");
  assert.equal(coarseRule(".ui-seg-option::after").get("inset"), "-4px 0",
    "38px option + 2px inset + 1px edge on each side, from inside the option's 1px border");
  assert.equal(coarseRule(".seg-btn::after").get("inset"), "-2px 0");
  assert.equal(coarseRule(".ui-switch::before").get("inset"), "-11px -3px",
    "40×24 grows to 44×44 from inside its 1px border; the thumb is ::after");
  assert.equal(coarseRule(".link::after").get("inset"), "calc(50% - 22px) -4px", "a 44px band on the line");

  // Nothing else keys a control's size to the viewport: a width query misses touch tablets.
  const widthKeyed: string[] = [];
  root.walkDecls(/^(min-)?height$/, (decl) => {
    const media = mediaOf(decl).join(" ");
    if (!/max-width/.test(media) || /pointer/.test(media)) return;
    const rule = decl.parent as Rule;
    if (rule.selectors.some((selector) => /(^|\s)\.btn\b[^ ]*$|\.icon-btn\b[^ ]*$|\.ui-seg-option$/.test(selector.trim()))
      && /44px|--control-h/.test(decl.value)) widthKeyed.push(`${media}|${rule.selector}`);
  });
  assert.deepEqual(widthKeyed, []);
});

test("button variants follow §3.1: flat primary, solid danger, text-only disabled, hover only on hover", () => {
  const primary = ruleBody(".btn.primary");
  assert.equal(primary.get("background"), "var(--primary-bg)");
  assert.equal(primary.get("color"), "var(--primary-fg)");
  const danger = ruleBody(".btn.danger");
  assert.equal(danger.get("background"), "var(--danger-bg)");
  assert.equal(danger.get("color"), "var(--danger-fg)");
  const ghost = ruleBody(".btn.ghost");
  assert.equal(ghost.get("background"), "transparent");
  assert.equal(ghost.get("color"), "var(--text-dim)");
  assert.equal(ruleBody('.btn:disabled, .btn[aria-disabled="true"]').get("color"), "var(--text-faint)");
  // The quiet danger's red is for the enabled button only: at (0,3,0) an unqualified
  // `.btn.ghost.danger` outranked `.btn:disabled` and kept a disabled delete red.
  assert.equal(ruleBody('.btn.ghost.danger:not(:disabled, [aria-disabled="true"])').get("color"), "var(--danger-text)");
  assert.throws(() => ruleBody(".btn.ghost.danger"), /found 0/, "no unqualified quiet-danger colour rule");
  assert.equal(ruleBody('.btn[aria-pressed="true"]').get("border-color"), "var(--control-outline)",
    "a toggle that is on carries an edge, so on and hovered do not look alike");

  const gradients: string[] = [];
  const opacity: string[] = [];
  const unwrappedHover: string[] = [];
  root.walkRules((rule) => {
    const buttons = rule.selectors.filter((selector) => /\.(btn|icon-btn)\b/.test(selector));
    if (buttons.length === 0) return;
    rule.walkDecls((decl) => {
      if (/^background/.test(decl.prop) && /gradient/.test(decl.value)) gradients.push(rule.selector);
      if (decl.prop === "opacity") opacity.push(rule.selector);
      const hover = buttons.some((selector) => /\.(btn|icon-btn)\b[^\s,]*:hover/.test(selector));
      if (hover && /^(background|border-color|box-shadow)/.test(decl.prop)
        && !mediaOf(rule).some((media) => /hover: hover/.test(media))) unwrappedHover.push(rule.selector);
    });
  });
  assert.deepEqual(gradients, [], "the primary is a flat fill");
  assert.deepEqual(opacity, [], "a disabled button is --text-faint, never faded");
  assert.deepEqual(unwrappedHover, [], "a hover fill that is not inside (hover: hover) sticks after a tap");
});

/** Every `btn … danger` class list rendered by production TSX, with the file it is in. */
function solidDangerButtons(): string[] {
  const src = fileURLToPath(new URL(".", import.meta.url));
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== "e2e") walk(path); continue; }
      if (!/\.tsx$/.test(name) || /\.test\./.test(name)) continue;
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(/className=(\{`[^`]*`\}|"[^"]*")/g)) {
        const value = match[1]!;
        if (!/\bbtn\b/.test(value) || !/"danger"|\bdanger\b(?![-\w])/.test(value)) continue;
        if (/ghost danger|danger ghost/.test(value)) continue;
        found.push(`${name}: ${value.replace(/\s+/g, " ")}`);
      }
    }
  };
  walk(src);
  return found.sort();
}

test("a solid danger button is only ever the confirm of a destructive confirmation", () => {
  // Everything else — an inline Delete, Revoke or Stop, a Deny decision — is `.btn.ghost.danger`
  // or a menu item (§3.1, §7.4). Each of these confirms something the user has already asked for:
  // a checkbox- or name-gated dialog, an inline "Confirm Stop", or the shared confirmation dialog.
  assert.deepEqual(solidDangerButtons(), [
    'BackgroundWorkPanel.tsx: "btn danger sm"',
    'FeedbackProvider.tsx: {`btn ${request.tone === "danger" ? "danger" : "primary"}`}',
    'ProjectsView.tsx: "btn danger"',
    'SkillMachineImportDialog.tsx: "btn danger"',
    'SkillMachineImportDialog.tsx: "btn danger"',
  ]);
});
