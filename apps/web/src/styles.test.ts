import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { customProperties, mediaBlocks, topLevelRule } from "./css-rules.js";

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
  const lastMedia = css.lastIndexOf("@media (max-width: 760px)");
  assert.ok(lastMedia !== -1 && lastMedia < guard,
    "the guard must live inside the phone-width media query");
  const guardedRule = css.slice(lastMedia);
  for (const selector of [":root select", ":root input", ":root textarea", ":root .composer-input"]) {
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
  ]);

  const unresolved = [...referenced]
    .filter((name) => !shared.has(name) && !RUNTIME_PUBLISHED.has(name))
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
  const body = soleRuleBody(":focus-visible");
  assert.match(body, /outline:/);
  assert.doesNotMatch(body, /border-radius/,
    "border-radius in :focus-visible changes the element's shape, not the outline's");
});

test("the permission-mode popover gives visible descriptions readable inline space", () => {
  assert.equal(soleRuleBody(".cbar-pop.permission-mode-pop"),
    "width: min(360px, calc(100vw - 64px));");
  assert.match(soleRuleBody(".cbar-permission-copy"), /flex: 1 1 0;/);
  assert.match(soleRuleBody(".cbar-permission-description"), /overflow-wrap: anywhere;/);
  const phoneRule = mediaBlocks(css).find((block) =>
    block.maxWidths.includes(760) && block.containsSelector(".cbar-opt.permission-mode"));
  assert.ok(phoneRule, "the permission-mode row must stack inside the 760px phone query");
  assert.deepEqual(phoneRule.declarationsForSelector(".cbar-opt.permission-mode").get("flex-direction"), ["column"]);
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
    [".governance-audit-heading", "--bg"],
    [".governance-audit-outcome span", "--bg"],
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
