import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse, type Declaration, type Rule } from "postcss";
import { declarationsOf } from "./css-rules.js";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

/**
 * The app had 21 hand-picked z-index values and no contract between them, which produced three
 * separate P1 review findings across two PRs:
 *
 *   - the toast region sat above modals, so a persistent toast covered the Settings dialog's Done
 *     button and the rail's More sheet;
 *   - `.instance-selector` was above every backdrop, so its trigger stayed hit-testable through an
 *     open dialog and could open a menu over an aria-modal dialog, moving focus outside that
 *     dialog's Tab trap;
 *   - the More backdrop landed under the mobile right panel.
 *
 * These tests pin the ordering so the next surface added has a contract to sit in rather than a
 * number to guess.
 *
 * Parsed with PostCSS, and every assertion is exhaustive over the declarations it covers. The
 * previous revision matched the FIRST textual occurrence of each rule and of each token, which made
 * the whole suite false-green under a later override: adding a second `.modal-backdrop { z-index:
 * var(--z-panel) }` left every assertion passing while the browser applied the panel-level value
 * and an open popover painted above dialogs — the exact bug this file exists to catch.
 */
/**
 * Every `--z-*` declaration in the sheet, with the rule that owns it.
 *
 * Reading only the canonical `:root` block was not enough: adding `--z-panel: 5` to the existing
 * `:root, :root[data-theme="dark"]` rule wins in dark mode on specificity, while the tests kept
 * reading 30 from the canonical block and stayed green.
 */
const tokenDecls: Array<{ selector: string; prop: string; value: string }> = [];
parse(css).walkDecls((decl: Declaration) => {
  if (!decl.prop.startsWith("--z-")) return;
  const parent = decl.parent;
  tokenDecls.push({
    selector: parent && parent.type === "rule" ? (parent as Rule).selector : "(not a rule)",
    prop: decl.prop,
    value: decl.value.trim(),
  });
});

const CANONICAL = ":root";

test("layer tokens are defined once, in one place, as plain integers", () => {
  const stray = tokenDecls
    .filter((decl) => decl.selector !== CANONICAL)
    .map((decl) => `${decl.selector} { ${decl.prop}: ${decl.value} }`);
  assert.deepEqual(stray, [],
    `layer tokens must be defined only on ${CANONICAL}; a themed or conditional definition wins ` +
    `on specificity while these tests keep reading the canonical value: ${stray.join(" / ")}`);

  const byName = new Map<string, string[]>();
  for (const decl of tokenDecls) byName.set(decl.prop, [...(byName.get(decl.prop) ?? []), decl.value]);
  for (const [name, values] of byName) {
    assert.equal(values.length, 1, `${name} is defined ${values.length} times; the last one wins`);
    // The COMPLETE value must be an integer. parseInt accepted "30px", "30.5" and "30garbage" as
    // 30, and each of those makes `z-index: var(--z-panel)` invalid — the element falls back to
    // auto and every positive layer paints above it, while the ladder test still passed.
    assert.match(values[0]!, /^-?\d+$/, `${name} must be a bare integer, got "${values[0]}"`);
  }
});

function tokenValue(name: string): number {
  const found = tokenDecls.filter((decl) => decl.prop === name);
  assert.equal(found.length, 1, `${name} must be defined exactly once`);
  const value = Number(found[0]!.value);
  assert.ok(Number.isSafeInteger(value), `${name} must be an integer, got "${found[0]!.value}"`);
  return value;
}

const LADDER = [
  "--z-sticky", "--z-dock", "--z-panel", "--z-popover", "--z-popovercontent",
  "--z-backdrop", "--z-modal", "--z-palette", "--z-toast",
] as const;

test("the layer scale is strictly ordered", () => {
  const values = LADDER.map(tokenValue);
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i]! > values[i - 1]!,
      `${LADDER[i]} (${values[i]}) must sit above ${LADDER[i - 1]} (${values[i - 1]})`);
  }
});

const zIndexDecls = declarationsOf(css, "z-index");

/**
 * The single effective layer expression for a selector.
 *
 * Collects EVERY declaration owned by that selector rather than the first, and fails when they
 * disagree — a duplicate rule later in the sheet is precisely how a bound surface silently drifts
 * off its token.
 */
function parts(selector: string): string[] {
  return selector.split(",").map((part) => part.trim());
}

function layerOf(selector: string): string {
  const owned = zIndexDecls.filter((decl) => parts(decl.selector).includes(selector));
  assert.ok(owned.length > 0, `${selector} must set a z-index`);
  const distinct = [...new Set(owned.map((decl) => decl.value))];
  assert.equal(distinct.length, 1,
    `${selector} declares conflicting layers (${distinct.join(" / ")}); the last one wins`);
  return distinct[0]!;
}

/**
 * Every rule that can set a layer on a guarded surface, not just the rule that names it exactly.
 *
 * `.foo .modal-backdrop` and `.modal-backdrop.is-open` override the bare rule in the browser while
 * being unequal to it, so exact matching alone left those overrides invisible. Rather than fold
 * them into layerOf — some, like the open-state instance selector, are deliberate — this pins the
 * complete set, so a new rule touching a guarded surface has to be acknowledged here.
 */
const GUARDED = [".modal-backdrop", ".menu-backdrop", ".palette-backdrop", ".toast-region",
  ".instance-selector", ".slash-palette", ".right-panel"];

test("no unacknowledged rule sets a layer on a guarded surface", () => {
  const EXPECTED = new Set([
    ".modal-backdrop", ".menu-backdrop", ".palette-backdrop", ".toast-region",
    ".slash-palette", ".right-panel", ".instance-selector",
    // The one deliberate state override: an OPEN selector rises just above the menu backdrop so
    // its own menu paints over it, while the closed trigger stays below every blocking backdrop.
    ".instance-selector:has(.instance-selector-pop)",
  ]);
  const touching = new Set<string>();
  for (const decl of zIndexDecls) {
    for (const part of parts(decl.selector)) {
      if (GUARDED.some((surface) => part === surface ||
        part.endsWith(` ${surface}`) || part.endsWith(`>${surface}`) ||
        part.startsWith(`${surface}.`) || part.startsWith(`${surface}:`) ||
        part.includes(`${surface}.`) || part.includes(`${surface}[`))) touching.add(part);
    }
  }
  const unexpected = [...touching].filter((selector) => !EXPECTED.has(selector));
  assert.deepEqual(unexpected, [],
    `these rules re-layer a guarded surface and are not accounted for: ${unexpected.join(", ")}`);
});

test("a dialog covers every popover and panel beneath it", () => {
  assert.equal(layerOf(".modal-backdrop"), "var(--z-backdrop)");
  assert.equal(layerOf(".menu-backdrop"), "var(--z-popover)");
  assert.equal(layerOf(".palette-backdrop"), "var(--z-palette)");
  assert.equal(layerOf(".toast-region"), "var(--z-toast)");

  assert.ok(tokenValue("--z-backdrop") > tokenValue("--z-popover"));
  assert.ok(tokenValue("--z-backdrop") > tokenValue("--z-panel"));
  assert.ok(tokenValue("--z-backdrop") > tokenValue("--z-dock"));
  assert.ok(tokenValue("--z-modal") > tokenValue("--z-backdrop"));
});

test("a closed instance selector sits below every blocking backdrop", () => {
  assert.equal(layerOf(".instance-selector"), "var(--z-sticky)",
    "above the backdrop its trigger was clickable through an open dialog");
  // Exact, not "contains": calc(var(--z-popover) + 1000) also contains the token text.
  assert.equal(layerOf(".instance-selector:has(.instance-selector-pop)"), "calc(var(--z-popover) + 1)");
});

test("the slash palette stays below the mobile right panel", () => {
  // The panel is a full-width fixed overlay; a popover that outranks it keeps painting and
  // receiving clicks through it. Both surfaces are bound to tokens so the comparison is real:
  // asserting only the palette left the panel free to drift to a lower layer.
  assert.equal(layerOf(".slash-palette"), "var(--z-sticky)");
  assert.equal(layerOf(".right-panel"), "var(--z-panel)");
  assert.ok(tokenValue("--z-sticky") < tokenValue("--z-panel"));
});

/**
 * Phone toasts and any open menu compete for the same screen, and no stacking order and no
 * relocation fixes it — there is no free edge. Bottom-anchored, the stack covers the Instance
 * Selector's menu; top-anchored, it covers the editor menu that opens from the topbar. While a
 * menu is open the stack is therefore hidden outright.
 *
 * Read from the AST rather than by regex. The first-match regex this replaced found the rule by
 * text and could not see a later rule re-showing the region, which is the whole failure mode this
 * suite was rewritten to eliminate — and it survived that rewrite.
 */
test("an open menu suppresses the phone toast stack entirely", () => {
  const guards: Rule[] = [];
  parse(css).walkRules((rule) => {
    if (rule.selectors.some((selector) => /body:has\(\.(instance-selector-pop|menu-pop)\)/.test(selector) &&
      selector.includes(".toast-region"))) guards.push(rule);
  });
  assert.ok(guards.length > 0, "an open menu must suppress the phone toast stack");

  for (const kind of ["instance-selector-pop", "menu-pop"]) {
    assert.ok(guards.some((rule) => rule.selectors.some((selector) => selector.includes(kind))),
      `.${kind} must suppress the toast stack too`);
  }

  // Exhaustive over every guard rule: one re-showing the region undoes the others.
  for (const rule of guards) {
    const declared = new Map((rule.nodes ?? [])
      .filter((node): node is Declaration => node.type === "decl")
      .map((decl) => [decl.prop, decl.value.trim()]));
    assert.equal(declared.get("visibility"), "hidden",
      "the stack must be hidden, not merely moved to another edge that is also occupied");
    // visibility:hidden already blocks hit-testing, but pointer-events states the intent and
    // survives a later rule restoring visibility for an animation.
    assert.equal(declared.get("pointer-events"), "none");
    // display:none would drop the cards out of the accessibility tree entirely.
    assert.notEqual(declared.get("display"), "none",
      "notifications are deferred while a menu is open, not destroyed");
  }
});


/**
 * Every layer in the sheet, checked against an allowlist of exact forms.
 *
 * `parseInt` cannot be used to judge these: it reads `calc(9 + 91)` as 9 and exempts a surface that
 * actually computes to 100. And accepting any expression beginning with `calc(var(` let
 * `calc(var(--z-sticky) + 1000)` through, which paints above dialogs and notifications alike.
 */
test("every stacking value is a token, a small offset from one, or a local integer", () => {
  const LOCAL = /^-?[0-9]$/;                        // 0-9: ordering siblings inside one component
  const TOKEN = /^var\((--z-[a-z]+)\)$/;
  const OFFSET = /^calc\(var\((--z-[a-z]+)\) [+-] [12]\)$/; // past one sibling, nothing more
  const defined = new Set(tokenDecls.map((decl) => decl.prop));

  const allowed = (value: string): boolean => {
    if (value === "auto" || LOCAL.test(value)) return true;
    const named = TOKEN.exec(value) ?? OFFSET.exec(value);
    // A var() naming a token that does not exist resolves to nothing: the declaration is invalid,
    // the element falls back to auto, and it silently leaves the scale while looking compliant.
    return named !== null && defined.has(named[1]!);
  };

  const offenders = zIndexDecls
    .filter(({ value }) => !allowed(value))
    .map(({ selector, value }) => `${selector} { z-index: ${value} }`);
  assert.deepEqual(offenders, [], `these stacking values bypass the scale:\n${offenders.join("\n")}`);
});
