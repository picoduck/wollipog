import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, type AtRule, type Rule } from "postcss";
import { topLevelRule } from "./css-rules.js";

/**
 * Page anatomy (#1801; docs/design-system.md §2.7, §4.2–§4.5, §15.1). Browser geometry lives in
 * e2e/page-anatomy.spec.ts; this pins the declarations that geometry is computed from.
 */
const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

function declarations(rule: Rule): Record<string, string> {
  const out: Record<string, string> = {};
  for (const node of rule.nodes) if (node.type === "decl") out[node.prop] = node.value.trim();
  return out;
}

function inAtRule(name: string, params: string, selector: string): Record<string, string> {
  let found: Record<string, string> | null = null;
  parse(css).walkAtRules(name, (atRule: AtRule) => {
    if (atRule.params !== params) return;
    atRule.walkRules((rule) => {
      if (rule.selector.replace(/\s+/g, " ").trim() === selector) found = { ...found, ...declarations(rule) };
    });
  });
  assert.ok(found, `missing ${selector} in @${name} ${params}`);
  return found;
}

const SPACE: Record<string, number> = { "var(--space-1)": 4, "var(--space-3)": 12, "var(--space-4)": 16, "var(--space-5)": 20 };

test("the layout tokens are the spec's values, with a 16px gutter on phones", () => {
  const root = parse(css).nodes.filter((node): node is Rule => node.type === "rule" && node.selector === ":root");
  const tokens = Object.assign({}, ...root.map(declarations)) as Record<string, string>;
  assert.equal(tokens["--bar-h"], "48px");
  assert.equal(tokens["--page-gutter"], "24px");
  assert.equal(tokens["--page-max"], "960px");
  assert.equal(tokens["--page-max-wide"], "1200px");
  assert.equal(tokens["--page-max-form"], "760px");
  assert.equal(inAtRule("media", "(max-width: 760px)", ":root")["--page-gutter"], "16px");
});

test("the page container is left-aligned and capped per kind", () => {
  const page = declarations(topLevelRule(css, ".page"));
  assert.equal(page["padding"], "0 var(--page-gutter) var(--space-16)");
  assert.equal(page["max-width"], "calc(var(--page-max) + 2 * var(--page-gutter))");
  assert.equal(page["margin"], "0");
  assert.equal(declarations(topLevelRule(css, ".page.wide"))["max-width"], "calc(var(--page-max-wide) + 2 * var(--page-gutter))");
  assert.equal(declarations(topLevelRule(css, ".page.form"))["max-width"], "calc(var(--page-max-form) + 2 * var(--page-gutter))");
  assert.equal(declarations(topLevelRule(css, ".page.full"))["max-width"], "none");
  // No page container is centred, and the retired per-view containers are gone.
  assert.doesNotMatch(css, /\.(skills|automations|usage|projects)-view \{[^}]*(max-width|margin: 0 auto)/);
  assert.doesNotMatch(css, /\.page[^{]*\{[^}]*margin:[^;]*auto/);
  // One scroll container per column: .main-body scrolls; Settings and Archived no longer do.
  assert.doesNotMatch(declarations(topLevelRule(css, ".settings-view"))["overflow-y"] ?? "", /auto|scroll/);
  assert.equal(declarations(topLevelRule(css, ".archive-view"))["overflow"], undefined);
  assert.equal(declarations(topLevelRule(css, ".main-body"))["padding"], undefined, "the page container is the only gutter");
  // The instance recovery screen is not a routed page, so it keeps its own inset.
  assert.equal(declarations(topLevelRule(css, ".main-body.instance-recovery-body"))["padding"],
    "var(--space-5) var(--page-gutter) var(--space-8)");
  // Not a query container on phones, so the app bar never contains the switcher's fixed menu.
  assert.equal(inAtRule("media", "(max-width: 760px)", ".page-header")["container"], "none");
});

test("the page header is 64px, 88px with a description and 124px with tabs", () => {
  const header = declarations(topLevelRule(css, ".page-header"));
  assert.equal(header["padding"], "var(--space-5) 0 var(--space-4)");
  assert.equal(header["background"], "var(--bg)");
  assert.doesNotMatch(Object.values(header).join(";"), /gradient/);
  assert.match(header["box-shadow"] ?? "", /^inset 0 -1px 0 var\(--border\)$/, "the hairline adds no height");
  assert.equal(declarations(topLevelRule(css, ".page-header:has(> .page-tabs)"))["padding-bottom"], "0");
  const title = declarations(topLevelRule(css, ".page-title"));
  assert.equal(title["font"], "var(--type-page-title)");
  assert.equal(title["white-space"], "nowrap");
  const desc = declarations(topLevelRule(css, ".page-desc"));
  assert.equal(desc["font"], "var(--type-body)");
  assert.equal(desc["white-space"], "nowrap");
  assert.equal(desc["text-overflow"], "ellipsis");
  const heading = declarations(topLevelRule(css, ".page-heading"));
  const tabs = declarations(topLevelRule(css, ".page-tabs"));
  assert.equal(tabs["height"], "var(--control-h-lg)");

  const [top, , bottom] = header["padding"]!.split(" ");
  const titleLine = 28; // --type-page-title's line height
  const descLine = 20; // --type-body's line height
  const tabRow = 40; // --control-h-lg on a fine pointer
  assert.equal(SPACE[top!]! + titleLine + SPACE[bottom!]!, 64);
  assert.equal(SPACE[top!]! + titleLine + SPACE[heading["gap"]!]! + descLine + SPACE[bottom!]!, 88);
  assert.equal(SPACE[top!]! + titleLine + SPACE[heading["gap"]!]! + descLine + SPACE[tabs["margin-top"]!]! + tabRow, 124);
  // Actions centre on the 28px title line, so a 32px control never grows the row.
  const actions = declarations(topLevelRule(css, ".page-actions"));
  assert.equal(actions["margin-top"], "calc((28px - var(--control-h)) / 2)");
  assert.equal(actions["margin-bottom"], "calc((28px - var(--control-h)) / 2)");
});

test("secondaries overflow into ⋯ by tier and header width, and phones show a 48px app bar", () => {
  assert.equal(inAtRule("media", "(max-width: 1099px)", '.page-actions > .page-action[data-slot="2"]')["display"], "none");
  assert.equal(inAtRule("container", "page-header (max-width: 600px)", '.page-actions > .page-action[data-slot="2"]')["display"], "none");
  assert.equal(inAtRule("container", "page-header (max-width: 440px)", ".page-actions > .page-action")["display"], "none");
  const phone = (selector: string) => inAtRule("media", "(max-width: 760px)", selector);
  assert.equal(phone(".page-actions > .page-action")["display"], "none");
  assert.equal(phone(".page-header-row")["height"], "var(--bar-h)");
  assert.equal(phone(".page-title")["font"], "var(--type-title)");
  assert.equal(phone(".page-desc")["display"], "none");
  assert.equal(phone(".page-actions > .page-primary")["width"], "var(--control-h)");
  assert.equal(phone(".page-primary-label")["clip-path"], "inset(50%)",
    "the label is clipped, not removed, so it stays the accessible name");
  // The instance switcher is icon-only in both phone bars, so a long name never takes the title's room.
  assert.equal(declarations(topLevelRule(css,
    ":is(.page-actions, .detail-bar-actions) .instance-selector-label, :is(.page-actions, .detail-bar-actions) .instance-selector-chevron",
  ))["display"], "none");
});

test("the detail bar is one 48px bar on --bg with a hairline and a truncating title", () => {
  const bar = declarations(topLevelRule(css, ".detail-bar"));
  assert.equal(bar["height"], "var(--bar-h)");
  assert.equal(bar["background"], "var(--bg)");
  assert.equal(bar["border-bottom"], "1px solid var(--border)");
  const title = declarations(topLevelRule(css, ".detail-bar-title"));
  assert.equal(title["font"], "var(--type-title)");
  assert.equal(title["text-overflow"], "ellipsis");
  assert.equal(title["min-width"], "0");
  assert.equal(declarations(topLevelRule(css, ".detail-bar-heading"))["flex"], "1");
});
