import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import ts from "typescript";
import { KEYBOARD_EDITABLE } from "./mobile-viewport.js";

/**
 * Phase 9's guardrails — the four bug classes §F4 found, made unable to come back.
 *
 * The plan asks for Stylelint. These are node:test checks instead, and that is a deliberate
 * deviation worth stating rather than sliding past: this repo already enforces CSS invariants with
 * postcss tests (§26's hardcoded-colour lock, §27's contrast arithmetic, the scheme completeness
 * checks), and a second mechanism would mean two places to look when a rule fires and two configs
 * to keep in step. The acceptance criterion is that the bug classes become impossible to
 * reintroduce, not that a particular binary runs.
 *
 * Three of the four are RATCHETS rather than prohibitions: a PR that paid off every hardcoded
 * literal at once would be unreviewable, so the number is recorded, it can only come down, and a
 * new one fails.
 *
 * Round two of review found six ways the first version measured something adjacent to its claim:
 * a `var()` scan a CSS comment could walk past, a dead-class count that changed with filesystem
 * enumeration order, a rendered-class scan blind to `cond ? "a" : "b"`, a CSS class regex that
 * truncated at an underscore, literal budgets that counted declarations rather than literals, and
 * a duplicate-selector key that dropped ancestry. Every one of them is a way for a guard to stay
 * green while the thing it guards regresses. The helpers below are therefore written to be called
 * on synthetic input and are exercised on it at the bottom of this file — a guard that has only
 * ever seen the corpus it was written against has not been tested, only fitted.
 */

const WEB = fileURLToPath(new URL("..", import.meta.url));
const css = readFileSync(join(WEB, "src/styles.css"), "utf8");
const root = postcss.parse(css);

/** Split a selector list without treating commas inside :not(), attributes, or strings as members. */
export function topLevelSelectorMembers(selectorList: string): string[] {
  const members: string[] = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < selectorList.length; index += 1) {
    const char = selectorList[index]!;
    if (quote) {
      if (char === quote && selectorList[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "\"" || char === "'") quote = char;
    else if (char === "(") parentheses += 1;
    else if (char === ")") parentheses -= 1;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    else if (char === "," && parentheses === 0 && brackets === 0) {
      members.push(selectorList.slice(start, index));
      start = index + 1;
    }
  }
  members.push(selectorList.slice(start));
  return members.map((member) => member.trim()).filter(Boolean);
}

/** Compare the CSS focus selector with Element.matches() input on the controls they describe. */
export function keyboardEditableSelectorSet(selectorList: string): string[] {
  return topLevelSelectorMembers(selectorList)
    .map((member) => canonicalSelector(member.replaceAll(":focus", "")))
    .map((member) => member.replaceAll('"', "'"))
    .sort();
}

function functionalPseudoArgument(selector: string, pseudo: string): string | null {
  const marker = `${pseudo}(`;
  const start = selector.indexOf(marker);
  if (start < 0) return null;
  let depth = 1;
  for (let index = start + marker.length; index < selector.length; index += 1) {
    if (selector[index] === "(") depth += 1;
    else if (selector[index] === ")") depth -= 1;
    if (depth === 0) return selector.slice(start + marker.length, index);
  }
  return null;
}

export function assertKeyboardEditableSelectorsMatch(
  stylesheetSelectors: string,
  runtimeSelectors: string,
): void {
  const stylesheetMembers = topLevelSelectorMembers(stylesheetSelectors);
  assert.ok(
    stylesheetMembers.every((member) => member.includes(":focus")),
    "every styles.css while-typing selector must require :focus",
  );
  assert.deepEqual(
    keyboardEditableSelectorSet(stylesheetMembers.join(", ")),
    keyboardEditableSelectorSet(runtimeSelectors),
    "styles.css while-typing selectors must match mobile-viewport.ts KEYBOARD_EDITABLE",
  );
}

/** Comments are whitespace in CSS, so a scanner that has not removed them is reading a fiction. */
const stripComments = (value: string): string => value.replace(/\/\*[\s\S]*?\*\//g, " ");

/**
 * Every `var()` call in a declaration value, with its fallback if it has one.
 *
 * `color: var(/* typo *\/ --font-ui)` is a real undefined reference — the browser drops the
 * declaration — and the previous regex, which required the name immediately after plain
 * whitespace, could not see it. That is §F4's exact bug reintroduced past the check written to
 * make it impossible.
 */
export function varReads(rawValue: string): { name: string; fallback: string | null }[] {
  const value = stripComments(rawValue);
  const out: { name: string; fallback: string | null }[] = [];
  const pattern = /var\(\s*(--[A-Za-z0-9_-]+)\s*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    let index = pattern.lastIndex;
    if (value[index] !== ",") { out.push({ name: match[1]!, fallback: null }); continue; }
    // Walk to the matching close paren so a nested var() inside the fallback stays with it.
    let depth = 1;
    let cursor = index + 1;
    for (; cursor < value.length && depth > 0; cursor += 1) {
      if (value[cursor] === "(") depth += 1;
      else if (value[cursor] === ")") depth -= 1;
    }
    out.push({ name: match[1]!, fallback: value.slice(index + 1, cursor - 1).trim() });
  }
  return out;
}

/**
 * `--keyboard-inset` is published by `mobile-viewport.ts` at runtime and must read back as `0px`
 * until it is.
 *
 * The exemption is by NAME, with a reason, and now with the EXACT fallback the exemption depends
 * on. `var(--keyboard-inset, red)` satisfied "has a fallback" and makes every `calc()` around it
 * invalid — an exemption that only checks a comma is a hole with a comma in it.
 */
const RUNTIME_PROPERTIES = new Map([
  ["--keyboard-inset", { why: "published by mobile-viewport.ts before first paint", fallback: "0px" }],
  // indicateFocusZone (focus-zones.ts) sets these on the zone F6 entered; absent, no zone is lit.
  ["--zone-line-top", { why: "measured by indicateFocusZone while a zone is lit", fallback: "0px" }],
  ["--zone-line-left", { why: "measured by indicateFocusZone while a zone is lit", fallback: "0px" }],
  ["--zone-line-width", { why: "measured by indicateFocusZone while a zone is lit", fallback: "0px" }],
]);

/** Every declaration value in the stylesheet. */
function allValues(): string[] {
  const values: string[] = [];
  root.walkDecls((decl) => values.push(decl.value));
  return values;
}

test("styles.css is the only production stylesheet", () => {
  // Every check in this file parses ONE file. That is only an enforcement mechanism if it is also
  // the only stylesheet the app ships: a new `screen.css` imported from any component would carry
  // undefined variables, hardcoded literals, duplicate selectors and dead classes past all of them,
  // because none of them would ever read it.
  // Vendor CSS is exempt BY SPECIFIER, with a reason. `@xterm/xterm/css/xterm.css` ships with the
  // terminal emulator and is not ours to tokenise or de-duplicate; what matters is that the
  // exemption names it, so a NEW first-party stylesheet cannot arrive under the same allowance.
  const VENDOR = new Map([["@xterm/xterm/css/xterm.css", "ships with the terminal emulator"]]);
  const imported = new Set<string>();
  const vendorSeen = new Set<string>();
  for (const path of sourceFiles(join(WEB, "src"))) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/(?:import\s+["']|url\(["']?)([^"')]+\.css)/g)) {
      const specifier = match[1]!;
      if (VENDOR.has(specifier)) { vendorSeen.add(specifier); continue; }
      imported.add(basename(specifier));
    }
  }
  assert.deepEqual([...imported].sort(), ["styles.css"],
    "a second first-party stylesheet is invisible to every guardrail in this file; scan it too or fold it in");
  assert.deepEqual([...vendorSeen].sort(), [...VENDOR.keys()].sort(),
    "a vendor stylesheet is exempted here but no longer imported; drop the exemption");
});

test("the while-typing selector matches mobile-viewport.ts KEYBOARD_EDITABLE", () => {
  const rules: postcss.Rule[] = [];
  root.walkRules((candidate) => {
    if (candidate.selector.includes(".app:has(") && candidate.selector.endsWith(") .app-rail")) {
      rules.push(candidate);
    }
  });
  assert.equal(rules.length, 1, "styles.css must retain exactly one phone while-typing .app:has(...) rule");
  const rule = rules[0]!;
  const stylesheetSelectors = functionalPseudoArgument(rule.selector, ":has");
  assert.ok(stylesheetSelectors, "styles.css must expose the while-typing controls through :has()");
  assertKeyboardEditableSelectorsMatch(stylesheetSelectors, KEYBOARD_EDITABLE);
});

test("the while-typing selector guard rejects either one-sided edit", () => {
  const runtime = "textarea:not([readonly]), input:not([readonly], [type='button'])";
  const stylesheet = "textarea:focus:not([readonly]), input:focus:not([readonly], [type=\"button\"])";
  assert.doesNotThrow(() => assertKeyboardEditableSelectorsMatch(stylesheet, runtime));
  assert.throws(
    () => assertKeyboardEditableSelectorsMatch(`${stylesheet}, select:focus`, runtime),
    /styles\.css.*mobile-viewport\.ts/,
  );
  assert.throws(
    () => assertKeyboardEditableSelectorsMatch(stylesheet, `${runtime}, select`),
    /styles\.css.*mobile-viewport\.ts/,
  );
  assert.throws(
    () => assertKeyboardEditableSelectorsMatch(stylesheet.replaceAll(":focus", ""), runtime),
    /must require :focus/,
  );
});

test("the while-typing selector parser preserves nested commas", () => {
  assert.deepEqual(
    topLevelSelectorMembers("textarea:focus, input:focus:not([readonly], [type='a,b'])"),
    ["textarea:focus", "input:focus:not([readonly], [type='a,b'])"],
  );
});

test("virtualized scroll owners disable browser-native scroll anchoring", () => {
  const values: string[] = [];
  root.walkDecls("overflow-anchor", (decl) => values.push(decl.value));
  assert.deepEqual(values, ["none"],
    "MeasuredVirtualList owns anchor correction, so native anchoring must be disabled exactly once and never overridden");
});

test("every production virtual-list host marks its scroll owner", () => {
  const missing: string[] = [];
  // InboxList composes its local scroll ref with the forwarded grid ref through attachList.
  // Name the alias explicitly so the element-scoped audit remains honest and goes stale loudly.
  const hostRefAliases = new Map([["InboxList.tsx:listRef", "attachList"]]);
  for (const path of sourceFiles(join(WEB, "src"))) {
    const source = readFileSync(path, "utf8");
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const externalScrollRefs = new Set<string>();
    const hostElements = new Map<string, ts.JsxOpeningLikeElement[]>();

    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = node.tagName.getText(file);
        const attribute = (name: string) => node.attributes.properties.find((property) =>
          ts.isJsxAttribute(property) && property.name.getText(file) === name);
        const identifierValue = (name: string) => {
          const property = attribute(name);
          if (!property || !ts.isJsxAttribute(property) || !property.initializer ||
            !ts.isJsxExpression(property.initializer) || !property.initializer.expression ||
            !ts.isIdentifier(property.initializer.expression)) return null;
          return property.initializer.expression.text;
        };

        const ownsMeasuredList = tagName === "MeasuredVirtualList" && basename(path) !== "EventTimeline.tsx";
        if (ownsMeasuredList || tagName === "EventTimeline") {
          const ref = identifierValue("scrollRef");
          if (ref) externalScrollRefs.add(ref);
        } else if (/^[a-z]/.test(tagName)) {
          const ref = identifierValue("ref");
          if (ref) hostElements.set(ref, [...(hostElements.get(ref) ?? []), node]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);

    // EventTimeline owns the list but not its viewport; the second check audits each production
    // caller's actual ref-owning element instead of accepting a class elsewhere in the file.
    for (const ref of externalScrollRefs) {
      const hostRef = hostRefAliases.get(`${basename(path)}:${ref}`) ?? ref;
      const hosts = hostElements.get(hostRef) ?? [];
      if (hosts.length !== 1 || !hosts[0]!.getText(file).includes("measured-virtual-scroll")) {
        missing.push(`${basename(path)}:${ref}`);
      }
    }
  }
  assert.deepEqual(missing, [],
    "a production MeasuredVirtualList host must opt its external scroll container out of native anchoring");
});

test("custom properties are lowercase, which is what the scanners assume", () => {
  // Custom-property names are CASE-SENSITIVE, and the older shared-root scan in styles.test.ts
  // recognises references matching `[a-z0-9-]+` only. `--Local` declared in one scope and read in
  // another would be missed there and accepted here as "declared somewhere", while the browser
  // drops the consumer's declaration. Enforcing the naming policy is what makes that scan sound.
  const wrong = new Set<string>();
  root.walkDecls((decl) => { if (decl.prop.startsWith("--") && !/^--[a-z0-9-]+$/.test(decl.prop)) wrong.add(decl.prop); });
  for (const decl of allValues()) {
    for (const read of varReads(decl)) if (!/^--[a-z0-9-]+$/.test(read.name)) wrong.add(read.name);
  }
  assert.deepEqual([...wrong], [],
    "the scope-aware scanner in styles.test.ts cannot see a name outside [a-z0-9-]");
});

test("every var() reference resolves to a declared property", () => {
  const defined = new Set<string>();
  root.walkDecls((decl) => { if (decl.prop.startsWith("--")) defined.add(decl.prop); });

  const missing = new Map<string, number>();
  const runtimeReads = new Map<string, string[]>();
  root.walkDecls((decl) => {
    for (const read of varReads(decl.value)) {
      const runtime = RUNTIME_PROPERTIES.get(read.name);
      if (runtime) {
        runtimeReads.set(read.name, [...(runtimeReads.get(read.name) ?? []), read.fallback ?? "<none>"]);
        continue;
      }
      if (defined.has(read.name)) continue;
      missing.set(read.name, (missing.get(read.name) ?? 0) + 1);
    }
  });
  assert.deepEqual([...missing.keys()], [],
    "a var() with no declaration is silently dropped, which is how --font-mono and --font-ui " +
    "reached production looking like they worked");

  for (const [name, { fallback }] of RUNTIME_PROPERTIES) {
    const reads = runtimeReads.get(name) ?? [];
    assert.ok(reads.length > 0, `${name} is exempted but never read`);
    for (const actual of reads) {
      assert.equal(actual, fallback,
        `${name} must be read with exactly \`${fallback}\` as its fallback; found \`${actual}\``);
    }
  }
});

/**
 * A rule's full ancestry, in order — every enclosing at-rule AND every enclosing style rule.
 *
 * The previous version walked up only while each immediate parent was an at-rule, so native CSS
 * nesting under a style rule dropped the enclosing selector and everything above it: `.item` inside
 * `@scope (.panel)` under `.host-a` and under `.host-b` produced the same key and one of two valid
 * rules was reported as a duplicate.
 */
export function contextKey(rule: postcss.Rule): string {
  const chain: string[] = [];
  let node: postcss.Container | undefined = rule.parent as postcss.Container | undefined;
  while (node && (node.type === "atrule" || node.type === "rule")) {
    chain.unshift(node.type === "atrule"
      ? `@${(node as postcss.AtRule).name} ${(node as postcss.AtRule).params}`.trim()
      : (node as postcss.Rule).selector.replace(/\s+/g, " ").trim());
    node = node.parent as postcss.Container | undefined;
  }
  return `${chain.join(" / ")}|${canonicalSelector(rule.selector)}`;
}

/**
 * A selector reduced to the form the browser matches on.
 *
 * Collapsing whitespace runs is not enough to make two spellings of one selector compare equal:
 * `[data-x]>button` and `[data-x] > button` select exactly the same elements, and keying on raw text
 * gave each a count of one, so the later rule could shadow the earlier with both duplicate checks
 * green. Combinator spacing is removed and descendant spacing is normalised.
 */
export function canonicalSelector(selector: string): string {
  return selector
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*([>+~,])\s*/g, "$1")
    // `:nth-child( 2 )` and `:nth-child(2)` select the same elements, so padding inside a functional
    // pseudo-class is formatting too.
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
}

/** The members of a selector LIST, each canonicalised. */
export function selectorMembers(selector: string): string[] {
  // Split at the TOP level only. A comma inside `:where(a, b)` or `:not(a, b)` is an argument list,
  // not a second member: splitting there turned `:where([tabindex="-1"]:not(button, select)):focus`
  // into a bare `select` rule and reported it as shadowing the real one.
  const members: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of selector) {
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) { members.push(current); current = ""; continue; }
    current += char;
  }
  members.push(current);
  return members.map((part) => canonicalSelector(part)).filter(Boolean);
}

/**
 * Selector counts keyed by full ancestry.
 *
 * Two naive versions were wrong before this one. Counting every rule treated `50%` and `to` —
 * keyframe steps — as duplicated selectors. Counting by selector alone treated `.app-rail` in the
 * base plus two media queries as a triple definition, when that is how a responsive override is
 * written and nothing shadows anything. What shadows is the same selector twice in the same
 * context, which is what `.ws-path` did.
 */
function selectorCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  root.walkRules((rule) => {
    // Per (context, selector MEMBER, property) — because "the last one silently wins" is a claim
    // about a DECLARATION, and only this triple can make it.
    //
    // Counting whole selector lists missed both halves of the real problem: `[data-x]>button` and
    // `[data-x] > button` select the same elements and got different keys, and `[data-x], [data-y]`
    // followed by `[data-x]` defines `[data-x]` twice while each spelling counts once. Counting
    // members alone went too far the other way and flagged ordinary grouped authoring — three rules
    // for `.app-rail` setting three DIFFERENT properties shadow nothing at all.
    const prefix = contextKey(rule).split("|")[0];
    for (const member of selectorMembers(rule.selector)) {
      for (const node of rule.nodes) {
        if (node.type !== "decl") continue;
        const key = `${prefix}|${member}|${node.prop}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  });
  return counts;
}

/**
 * Every numeric literal in a value, signed, and counted even when the value also uses a token.
 *
 * Discarding any value containing `var(` was a hole with a name on it: `z-index: calc(var(--z-popover) + 999)`
 * and `border-radius: var(--radius) 7px` are hardcoded numbers sitting next to a token, and both
 * were free. It also meant the "exact" z-index debt already excluded five real literals, so the
 * number the budget claimed to pin was not the number in the file.
 *
 * The negative lookbehind that used to guard against matching inside an identifier also swallowed
 * the minus sign, so `z-index: -999` counted as `999` and, worse, could never be distinguished from
 * it. Custom-property NAMES are removed first — they are identifiers, not quantities — and what
 * remains is read with the sign attached.
 */
export function numericLiterals(rawValue: string): string[] {
  const value = stripComments(rawValue).replace(/--[A-Za-z0-9_-]+/g, " ");
  return value.match(/-?(?<![\w.])\d*\.?\d+/g) ?? [];
}

/**
 * The debt, by IDENTITY rather than by count.
 *
 * A total is not an enforcement mechanism, only a summary of one. Replacing one `font-size: 12px`
 * with a token while adding `font-size: 17px` to a clean component leaves the total at 371 and
 * passes; so does deleting one dead rule and writing a different one. Exact equality on a count
 * forces the number to be maintained, but cannot tell a payment from a trade.
 *
 * So the inventory records WHAT the debt is — the rule that carries it, the property, the value —
 * and the check is set equality. Paying debt down means deleting entries; incurring any new debt
 * fails, because its identity is not in the file. The totals below are still reported, as a
 * summary, and no longer as the guard.
 */
export interface DebtInventory extends CssRuleDebt {
  shadowedDeclarations: string[];
  deadClasses: string[];
  unstyledClasses: string[];
  emojiLiterals: string[];
}

/** The inventories read from the declarations of one style rule at a time. */
export interface CssRuleDebt {
  fontSizeLiterals: string[];
  radiusLiterals: string[];
  zIndexLiterals: string[];
  textTransform: string[];
  gapLiterals: string[];
  paddingLiterals: string[];
  monoStacks: string[];
  flexEndOverflow: string[];
}

/**
 * What each inventory's failure tells its author to do instead, and where the design system says so.
 *
 * A guard that only says "new debt" sends the author to the JSON, and the JSON is the one place the
 * fix is not: adding the identity there is how an inventory becomes a rubber stamp.
 */
const DEBT_GUIDANCE: Record<keyof DebtInventory, string> = {
  shadowedDeclarations: "the same selector sets the same property twice in one context and the last one silently " +
    "wins; merge the rules",
  fontSizeLiterals: "use a --text-* token (docs/design-system.md §2.3)",
  radiusLiterals: "use a --radius-* token (docs/design-system.md §2.5)",
  zIndexLiterals: "use a --z-* token",
  textTransform: "write the label in Title Case in the source, per AGENTS.md; never use text-transform " +
    "(docs/design-system.md §2.3, §17.1)",
  gapLiterals: "use a --space-* token (docs/design-system.md §2.4)",
  paddingLiterals: "use a --space-* token (docs/design-system.md §2.4)",
  monoStacks: "use var(--font-mono) instead of a hard-coded monospace stack (docs/design-system.md §2.3, §19.3)",
  flexEndOverflow: "an overflowing row justified to the end cannot scroll back to its start; align to the start, " +
    "or use margin-inline-start: auto on the first item (docs/design-system.md §19.3)",
  deadClasses: "render the class or delete the rule",
  unstyledClasses: "style the class or stop rendering it",
  emojiLiterals: "use an icon from components/Icons.tsx instead of an emoji (docs/design-system.md §18)",
};

const LITERAL_PROPERTIES = { "font-size": "fontSizeLiterals", "border-radius": "radiusLiterals", "z-index": "zIndexLiterals" } as const;

/** `grid-gap` and its longhands are the legacy spellings of the same properties, not a way around them. */
const GAP_PROPERTIES = new Set(["gap", "row-gap", "column-gap", "grid-gap", "grid-row-gap", "grid-column-gap"]);

/** `padding` and every longhand, physical and logical: `padding-top` through `padding-inline-end`. */
const isPaddingProperty = (prop: string) => /^padding(?:-|$)/.test(prop);

/**
 * The monospace tokens themselves. Every other declaration naming a monospace family is a second
 * copy of the stack, which is how the keycaps drifted to three different fonts.
 */
const MONO_TOKENS = new Set(["--font-mono", "--font-terminal"]);

/**
 * Every non-zero `px` literal in a value, signed, including one sitting beside or inside a token.
 *
 * `0px` is not a size choice, and `calc(var(--space-2) + 1px)` still hard-codes the 1px — the same
 * reasoning `numericLiterals` gives for reading through `var()`.
 */
export function pxLiterals(rawValue: string): string[] {
  const value = stripComments(rawValue).replace(/--[A-Za-z0-9_-]+/g, " ");
  return (value.match(/-?(?<![\w.])\d*\.?\d+px(?![\w-])/gi) ?? [])
    .map((literal) => literal.toLowerCase())
    .filter((literal) => Number.parseFloat(literal) !== 0);
}

/**
 * Whether a value names a monospace family: the generic keywords or a known monospace face.
 *
 * Custom-property NAMES are removed first, so `var(--font-mono)` is a token read and not a stack.
 */
export function namesMonospaceFamily(rawValue: string): boolean {
  const value = stripComments(rawValue).replace(/--[A-Za-z0-9_-]+/g, " ");
  // STATED LIMIT: a face list is never complete. It names the generic keywords, every face with
  // "Mono" in its name, and the common coding faces that lack it; a new one belongs here.
  return /\b(?:ui-)?monospace\b|mono\b|jetbrains|cascadia|consolas|menlo|monaco|courier|fira ?code|source code pro|lucida console|inconsolata|iosevka|\bhack\b|anonymous pro/i
    .test(value);
}

/** `justify-content` values that pack a row against its end edge. `safe` keeps the start reachable. */
const packsToEnd = (value: string) => {
  const words = value.toLowerCase().split(/\s+/);
  return !words.includes("safe") && words.some((word) => word === "flex-end" || word === "end" || word === "right");
};
/**
 * Whether a declaration makes the row scroll horizontally. `overflow: hidden auto` scrolls only
 * vertically: the shorthand's FIRST value is `overflow-x`, and the second is `overflow-y`.
 */
const scrollsHorizontally = (prop: string, value: string) => {
  const name = prop.toLowerCase();
  if (name !== "overflow" && name !== "overflow-x") return false;
  const x = value.trim().toLowerCase().split(/\s+/)[0];
  return x === "auto" || x === "scroll";
};

/**
 * The per-rule inventories of one stylesheet, by identity: rule context, selector, property and value.
 *
 * Takes the parsed sheet rather than reading `styles.css` itself, so the synthetic tests at the
 * bottom of this file drive exactly the code the real guard runs.
 */
export function cssRuleDebt(sheet: postcss.Root): CssRuleDebt {
  const debt: CssRuleDebt = {
    fontSizeLiterals: [], radiusLiterals: [], zIndexLiterals: [], textTransform: [],
    gapLiterals: [], paddingLiterals: [], monoStacks: [], flexEndOverflow: [],
  };
  sheet.walkRules((rule) => {
    const where = contextKey(rule);
    const declarations = rule.nodes.filter((node): node is postcss.Declaration => node.type === "decl");
    for (const node of declarations) {
      const bucket = LITERAL_PROPERTIES[node.prop as keyof typeof LITERAL_PROPERTIES];
      // One entry per LITERAL, so `7px` growing into `7px 7px 0 0` is three new identities rather
      // than the same declaration wearing a longer value.
      if (bucket) for (const literal of numericLiterals(node.value)) debt[bucket].push(`${where}|${node.prop}|${literal}`);

      const prop = node.prop.toLowerCase();
      const value = stripComments(node.value).replace(/\s+/g, " ").trim();
      if (prop === "text-transform" && value.toLowerCase() !== "none") debt.textTransform.push(`${where}|${prop}|${value}`);
      if (GAP_PROPERTIES.has(prop)) for (const literal of pxLiterals(node.value)) debt.gapLiterals.push(`${where}|${prop}|${literal}`);
      if (isPaddingProperty(prop)) for (const literal of pxLiterals(node.value)) debt.paddingLiterals.push(`${where}|${prop}|${literal}`);
      const fontValue = prop === "font-family" || prop === "font" || (prop.startsWith("--") && !MONO_TOKENS.has(prop));
      if (fontValue && namesMonospaceFamily(node.value)) debt.monoStacks.push(`${where}|${prop}|${value}`);
    }
    // One rule, because that is the unit the author wrote together; a cascade across rules is a
    // question for the browser, not for a scan of text.
    const justify = declarations.filter((node) => node.prop.toLowerCase() === "justify-content" && packsToEnd(node.value));
    const overflow = declarations.filter((node) => scrollsHorizontally(node.prop, node.value));
    for (const end of justify) {
      for (const scroller of overflow) {
        debt.flexEndOverflow.push(`${where}|justify-content: ${end.value.trim()}|${scroller.prop.toLowerCase()}: ${scroller.value.trim()}`);
      }
    }
  });
  for (const key of Object.keys(debt) as (keyof CssRuleDebt)[]) debt[key].sort();
  return debt;
}

export function measureDebt(): DebtInventory {
  const shadowedDeclarations = [...selectorCounts()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);
  const rules = cssRuleDebt(root);

  const rendered = new Set([...RENDERED, ...HELPER_CLASSES.keys()]);
  const sorted = (values: string[]) => [...values].sort();
  return {
    shadowedDeclarations: sorted(shadowedDeclarations),
    fontSizeLiterals: rules.fontSizeLiterals,
    radiusLiterals: rules.radiusLiterals,
    zIndexLiterals: rules.zIndexLiterals,
    textTransform: rules.textTransform,
    gapLiterals: rules.gapLiterals,
    paddingLiterals: rules.paddingLiterals,
    monoStacks: rules.monoStacks,
    flexEndOverflow: rules.flexEndOverflow,
    deadClasses: sorted([...STYLED].filter((name) => !rendered.has(name) && !emittedByLibrary(name))),
    unstyledClasses: sorted([...rendered].filter((name) => !STYLED.has(name))),
    emojiLiterals: sorted(productionSources().flatMap(({ file, source }) => emojiLiterals(source, file))),
  };
}

/**
 * `left` minus `right`, counting repeats.
 *
 * Set membership let a recorded identity vouch for any number of copies of itself: `padding: 6px`
 * growing into `padding: 6px 6px` added a literal and passed, because `…|padding|6px` was already
 * in the file. The inventory records one entry per literal, so the comparison has to as well.
 */
function withoutEach(left: readonly string[], right: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const identity of right) remaining.set(identity, (remaining.get(identity) ?? 0) + 1);
  return left.filter((identity) => {
    const count = remaining.get(identity) ?? 0;
    if (count > 0) remaining.set(identity, count - 1);
    return count === 0;
  });
}

/**
 * The ratchet: every measured inventory equals the recorded one, entry for entry.
 *
 * Keys are read from BOTH sides. Reading only the recorded keys meant deleting a key from the JSON
 * switched its check off, and reading only the measured keys would leave a stale key unnoticed.
 */
export function assertInventoryMatches(recorded: Record<string, readonly string[]>, measured: Record<string, readonly string[]>): void {
  for (const key of new Set([...Object.keys(measured), ...Object.keys(recorded)])) {
    assert.ok(key in measured, `${key}: stylesheet-debt.json records an inventory nothing measures; remove the key`);
    assert.ok(Array.isArray(recorded[key]),
      `${key}: stylesheet-debt.json has no ${key} inventory; regenerate it when the rule is introduced`);
    const guidance = DEBT_GUIDANCE[key as keyof DebtInventory] ?? "fix the source";
    const added = withoutEach(measured[key]!, recorded[key]!);
    assert.deepEqual(added, [],
      `${key}: new debt that is not in stylesheet-debt.json — ${guidance}. Adding it to the inventory is not the fix.`);
    const paid = withoutEach(recorded[key]!, measured[key]!);
    assert.deepEqual(paid, [],
      `${key}: ${paid.length} entries are recorded but no longer present. Good — regenerate ` +
      "stylesheet-debt.json in this commit so the inventory keeps matching the tree.");
  }
}

const RECORDED = JSON.parse(readFileSync(join(WEB, "src/stylesheet-debt.json"), "utf8")) as DebtInventory;

test("no debt is added, and none is traded for other debt", () => {
  assertInventoryMatches(RECORDED as unknown as Record<string, string[]>, measureDebt() as unknown as Record<string, string[]>);
});

test("window.confirm is never called; confirmations use the in-app dialog", () => {
  // A prohibition rather than an inventory: the last two calls were converted, so there is nothing
  // left to pay down and no reason to allow one.
  assertNoNativeConfirm(productionSources().flatMap(({ file, source }) => nativeConfirmReferences(source, file)));
});

test("no selector is defined more than twice", () => {
  const worst = [...selectorCounts()]
    .filter(([, count]) => count > 2)
    .map(([key, count]) => `${key.split("|").slice(1).join(" ")} ×${count}`);
  assert.deepEqual(worst, [],
    "a selector written three times is three people disagreeing, and the last one silently wins");
});

/**
 * The icon scale (§18): 14, 16 and 20px (`--icon-sm`, `--icon`, `--icon-lg`), and 24px for
 * empty-state tiles and the phone tab bar.
 *
 * #1955 guards the `size` prop, but a stylesheet rule overrides an SVG's width and height
 * attributes, so an off-scale rule undid the prop without a trace: the phone session header drew
 * its actions at 15px beside 16px icons everywhere else (#2081).
 */
const ICON_SCALE_PX = new Set([14, 16, 20, 24]);
const ICON_SIZE_PROPERTIES = /^(?:(?:min|max)-)?(?:width|height|inline-size|block-size)$/;

/**
 * Rules allowed to size an icon off the scale, by `contextKey`, each with the issue that owns it.
 *
 * Empty. #2081 was written to exempt the desktop rail's 26px glyphs (`.app-rail .rail-item >
 * .app-icon`, `.rail-settings .settings-trigger svg`) for #1958, which then deleted both rules and
 * drew the rail at 20px (#2073). An entry here must still name a rule that sizes an icon off the
 * scale; when the owner moves it onto the scale, the stale entry fails until it is removed.
 */
export const ICON_SIZE_EXEMPTIONS: ReadonlyMap<string, { owner: string; why: string }> = new Map();

/**
 * Each member of a selector list, reduced to the top-level simple selectors of its subject (its
 * last compound) as written: `svg`, `.name`, `#id`, `[attr]`, `:name(…)`, `::name`.
 *
 * One pass, because every split point has the same exceptions: an escaped character, a quoted
 * string, and anything in brackets or parentheses never splits, and a comment is dropped wherever
 * it sits. So `.a[title="x, .app-icon"]` is one member with no icon class, `svg[title="6\" x"] .b`
 * has `.b` as its subject, and `svg/* glyph *\/:hover` is `svg` then `:hover`.
 */
export function selectorSubjects(selectorList: string): string[][] {
  return selectorCompounds(selectorList).map(({ compounds }) => compounds.at(-1)!);
}

/**
 * Each member of a selector list as its compounds, each split into simple selectors as written,
 * and the combinator before each compound after the first (` `, `>`, `+` or `~`).
 *
 * The scan `selectorSubjects` reads its subjects from, so a compound boundary, the specificity
 * walk and the context a forced-colors counterpart must repeat (#2349) all split in one place.
 */
export function selectorCompounds(selectorList: string): { compounds: string[][]; combinators: string[] }[] {
  const members: { compounds: string[][]; combinators: string[] }[] = [];
  let compounds: string[][] = [];
  let combinators: string[] = [];
  let parts: string[] = [];
  let pending: string | null = null;
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  const flush = () => {
    if (current) parts.push(current);
    current = "";
  };
  const endCompound = () => {
    flush();
    if (parts.length > 0) {
      compounds.push(parts);
      parts = [];
      pending = " ";
    }
  };
  for (let index = 0; index < selectorList.length; index += 1) {
    const char = selectorList[index]!;
    if (!quote && char === "/" && selectorList[index + 1] === "*") {
      const end = selectorList.indexOf("*/", index + 2);
      index = end < 0 ? selectorList.length : end + 1;
      continue;
    }
    if (depth === 0 && !quote) {
      if (char === ",") {
        endCompound();
        members.push({ compounds, combinators });
        compounds = [];
        combinators = [];
        pending = null;
        continue;
      }
      if (/[\s>+~]/.test(char)) {
        endCompound();
        if (!/\s/.test(char)) pending = char;
        continue;
      }
      if (pending !== null && parts.length === 0 && !current) {
        if (compounds.length > 0) combinators.push(pending);
        pending = null;
      }
      if (char === "." || char === "#" || char === "[" || (char === ":" && current !== ":")) flush();
    }
    if (char === "\\") {
      // A hex escape takes one whitespace after it: `.app\2d icon` is one class.
      const escape = /^\\(?:[0-9a-f]{1,6}[ \t\n\f\r]?|[\s\S])?/i.exec(selectorList.slice(index))![0];
      current += escape;
      index += escape.length - 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "\"" || char === "'") quote = char;
    else if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    current += char;
  }
  endCompound();
  members.push({ compounds, combinators });
  return members.filter((member) => member.compounds.length > 0);
}

/** An identifier as the browser reads it: `\2d ` and `\-` are both `-`. */
function unescapeIdentifier(text: string): string {
  return text
    .replace(/\\([0-9a-f]{1,6})[ \t\n\f\r]?/gi, (_, hex: string) => {
      const point = Number.parseInt(hex, 16);
      return point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? "�" : String.fromCodePoint(point);
    })
    .replace(/\\([^0-9a-f\n])/gi, "$1");
}

/**
 * Whether a subject is an icon: an `svg` element or `.app-icon`.
 *
 * `:is()` and `:where()` offer alternatives for the subject, so an icon among any of them counts;
 * `:not()` and `:has()` only filter it, so theirs do not.
 */
function isIconSubject(parts: readonly string[]): boolean {
  return parts.some((part, index) => {
    const name = unescapeIdentifier(part);
    if (name === ".app-icon") return true;
    if (index === 0 && /^(?:(?:[\w-]*|\*)\|)?svg$/i.test(name)) return true;
    const alternatives = /^:(?:is|where)\(([\s\S]*)\)$/i.exec(part);
    return alternatives !== null && selectorSubjects(alternatives[1]!).some(isIconSubject);
  });
}

/** Whether any member of a selector list has an icon as its subject. */
export function targetsIcon(selectorList: string): boolean {
  return selectorSubjects(selectorList).some(isIconSubject);
}

/**
 * The style rule a declaration belongs to, its selector with native nesting resolved, and the
 * at-rules between them.
 *
 * `&` stands for the parent rule's selector, and a nested member without one is relative to it, so
 * `.app-icon { &:hover { … } }` and `svg { @media … { … } }` both size an icon.
 */
function declarationTarget(decl: postcss.Declaration): { rule: postcss.Rule; selector: string; conditions: string[] } | null {
  const rules: postcss.Rule[] = [];
  const conditions: string[] = [];
  for (let node = decl.parent as postcss.Node | undefined; node; node = node.parent as postcss.Node | undefined) {
    if (node.type === "rule") rules.unshift(node as postcss.Rule);
    else if (node.type === "atrule" && rules.length === 0) {
      conditions.unshift(`@${(node as postcss.AtRule).name} ${(node as postcss.AtRule).params}`.trim());
    }
  }
  if (rules.length === 0) return null;
  const selector = rules.map((rule) => rule.selector).reduce((parent, nested) => topLevelSelectorMembers(nested)
    .map((member) => member.includes("&") ? member.replaceAll("&", `:is(${parent})`) : `:is(${parent}) ${member}`)
    .join(", "));
  return { rule: rules.at(-1)!, selector, conditions };
}

/**
 * Every px literal a value can resolve to, through the custom properties it reads.
 *
 * A property declared anywhere in the sheet counts with every value it is given, so
 * `--phone-glyph: 15px` read as `width: var(--phone-glyph)` is as off the scale as `width: 15px`.
 * Signed and exponent forms count too: `calc(var(--icon) + -1px)` and `1.8e1px` are sizes.
 */
function resolvedPxSizes(value: string, declared: ReadonlyMap<string, string[]>, seen = new Set<string>()): number[] {
  const literals = [...stripComments(value).matchAll(/(?<![\w.-])([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)px\b/gi)]
    .map(([, px]) => Number(px));
  for (const { name } of varReads(value)) {
    if (seen.has(name)) continue;
    seen.add(name);
    for (const assigned of declared.get(name) ?? []) literals.push(...resolvedPxSizes(assigned, declared, seen));
  }
  return literals;
}

/** Every width or height declaration on an icon whose px literals are off the scale, by rule. */
export function offScaleIconSizes(sheet: postcss.Root): { rule: string; declaration: string }[] {
  const declared = new Map<string, string[]>();
  sheet.walkDecls((decl) => {
    if (decl.prop.startsWith("--")) declared.set(decl.prop, [...(declared.get(decl.prop) ?? []), decl.value]);
  });
  const found: { rule: string; declaration: string }[] = [];
  sheet.walkDecls((decl) => {
    if (!ICON_SIZE_PROPERTIES.test(decl.prop.toLowerCase())) return;
    const target = declarationTarget(decl);
    if (!target || !targetsIcon(target.selector)) return;
    if (resolvedPxSizes(decl.value, declared).some((px) => !ICON_SCALE_PX.has(px))) {
      const declaration = `${decl.prop}: ${decl.value}`;
      found.push({
        rule: contextKey(target.rule),
        declaration: target.conditions.length ? `${target.conditions.join(" / ")} { ${declaration} }` : declaration,
      });
    }
  });
  return found;
}

export function assertIconSizesOnScale(
  found: readonly { rule: string; declaration: string }[],
  exemptions: ReadonlyMap<string, { owner: string; why: string }>,
): void {
  const offScale = found.filter(({ rule }) => !exemptions.has(rule)).map(({ rule, declaration }) => `${rule} { ${declaration} }`);
  assert.deepEqual(offScale, [],
    "an icon is sized off the §18 scale (docs/design-system.md): use var(--icon-sm), var(--icon) or " +
    `var(--icon-lg) (14, 16 or 20px), or 24px for an empty-state tile or the phone tab bar:\n${offScale.join("\n")}`);
  for (const [rule, { owner }] of exemptions) {
    assert.ok(found.some((entry) => entry.rule === rule),
      `${rule}: exempted from the icon scale for ${owner}, but no longer sizes an icon off it; remove its ICON_SIZE_EXEMPTIONS entry`);
  }
}

test("every stylesheet icon size is on the §18 scale", () => {
  assertIconSizesOnScale(offScaleIconSizes(root), ICON_SIZE_EXEMPTIONS);
});

/*
 * Forced colors (#2269, #2349). Chromium gives an `svg` `forced-color-adjust: preserve-parent-color`,
 * so an icon whose own rule sets `color` keeps that author colour while the words beside it turn a
 * system colour. Every rule that colours an icon therefore needs a `@media (forced-colors: active)`
 * rule after it, at least as heavy, that hands the icon back its words' colour.
 *
 * Which classes are icons is read from production source rather than listed. The hand-written list
 * this replaced checked only the rules someone remembered, and its first audit had already missed
 * the AgentIcon marks, which reach their svg through a spread props object.
 */

/** Stands, inside a class string, for a value the scan cannot read. */
const UNREAD = "\u0000";
/** Stands for a prop, whose classes come from the call sites of the function that takes it. */
const FORWARDED = "\u0001";
/**
 * The svg element and the elements drawn inside one. Each inherits the svg's
 * `forced-color-adjust: preserve-parent-color`, so a `color` set on a path keeps its author colour
 * just as one set on the svg does.
 */
const SVG_ELEMENTS = new Set(["svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "text", "tspan", "use"]);
/** Stands for an array element that `filter()` may remove. */
const DROPPED = "\u0002";
/** Calls that hand back the function they are given. */
const FUNCTION_WRAPPERS = new Set(["memo", "forwardRef", "useCallback"]);
/** Another package's calls that create components which are not icons: a context (for its Provider), a lazy route. */
const COMPONENT_FACTORIES = new Set(["createContext", "lazy"]);
/** Calls that read the object they are given and never write it. */
const READING_CALLS = new Set(["Object.hasOwn", "Object.keys", "Object.values", "Object.entries", "Object.freeze",
  "Object.getOwnPropertyNames", "Array.isArray", "JSON.stringify"]);
/** Methods that change an array or collection in place. */
const MUTATING_METHODS = new Set(["push", "unshift", "splice", "fill", "copyWithin", "set", "add", "delete", "clear"]);
/** Past this many alternatives a value is read as all of them at once: more classes, never fewer. */
const MAX_ALTERNATIVES = 64;

type SourceFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
const isSourceFunction = (node: ts.Node | undefined): node is SourceFunction =>
  node !== undefined && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node));

/**
 * Every class that can reach an icon's element, with the first place it does, and every class value
 * on an icon the scan could not read.
 *
 * An icon is a raw `<svg>` or a lucide-react glyph. A class reaches one through its `className`, a
 * spread props object, a constant, a typed union (`agent-${provider}`) or a helper's return, and
 * through any prop of a function the value came from, which is followed to that function's call
 * sites: `<WarningIcon className="x" />` reaches LibraryIcon's `<Glyph>` that way, and so does a
 * `glyph` prop holding the glyph itself. A value it cannot read is reported rather than dropped,
 * because a class the scan misses is a rule the guard never checks.
 */
export function iconClasses(sources: readonly { file: string; source: string }[]): { classes: Map<string, string>; unread: string[] } {
  const files = new Map(sources.map(({ file, source }) => [`/src/${file}`, parseSource(source, `/src/${file}`)]));
  // A program over the sources alone: enough for the checker to follow imports between them and to
  // read a union type, without the libraries, which no class comes from.
  const program = ts.createProgram({
    rootNames: [...files.keys()],
    options: {
      noLib: true, noEmit: true, types: [], jsx: ts.JsxEmit.Preserve, strictNullChecks: true,
      module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
    host: {
      getSourceFile: (name) => files.get(name),
      fileExists: (name) => files.has(name),
      readFile: () => undefined,
      getDefaultLibFileName: () => "/lib.d.ts",
      writeFile: () => undefined,
      getCurrentDirectory: () => "/",
      getCanonicalFileName: (name) => name,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
    },
  });
  const checker = program.getTypeChecker();
  const where = (node: ts.Node) => {
    const file = node.getSourceFile();
    return `${file.fileName.slice("/src/".length)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  };

  const moduleOf = (declaration: ts.Node): string | null => {
    for (let node: ts.Node | undefined = declaration; node; node = node.parent) {
      if (ts.isImportDeclaration(node)) return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
    }
    return null;
  };
  /** What a name refers to, through imports; `glyph` for anything imported from lucide-react. */
  const declarationOf = (node: ts.Node): ts.Declaration | "glyph" | undefined => {
    let symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
    if (!symbol) return undefined;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      if (symbol.declarations?.some((declaration) => moduleOf(declaration) === "lucide-react")) return "glyph";
      symbol = checker.getAliasedSymbol(symbol);
    }
    return symbol.valueDeclaration ?? symbol.declarations?.[0];
  };
  const isConstant = (declaration: ts.Node): declaration is ts.VariableDeclaration =>
    ts.isVariableDeclaration(declaration) && Boolean(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const);
  /** `memo(fn)`, `forwardRef(fn)` and `useCallback(fn)` hand back the function they wrap; `useMemo` does not. */
  const isFunctionWrapper = (node: ts.Node): node is ts.CallExpression => ts.isCallExpression(node)
    && FUNCTION_WRAPPERS.has(ts.isIdentifier(node.expression) ? node.expression.text
      : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "");
  /**
   * The function a declaration names: itself, or what its constant holds, through `memo()`,
   * `forwardRef()` and `useCallback()`, whether they wrap the function or a name for it.
   */
  const functionOf = (declaration: ts.Node | "glyph" | undefined, seen = new Set<ts.Node>()): SourceFunction | undefined => {
    if (!declaration || declaration === "glyph" || seen.has(declaration)) return undefined;
    seen.add(declaration);
    if (isSourceFunction(declaration)) return declaration;
    if (!isConstant(declaration)) return undefined;
    let value = transparent(declaration.initializer);
    while (value && isFunctionWrapper(value)) value = transparent(value.arguments[0]);
    if (value && (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value))) return functionOf(declarationOf(value), seen);
    return isSourceFunction(value) ? value : undefined;
  };
  /** The name a function is declared under, directly or as a constant through its wrappers. */
  const declaredName = (fn: SourceFunction): ts.Identifier | undefined => {
    if (ts.isFunctionDeclaration(fn)) return fn.name;
    let node: ts.Node = fn.parent;
    while (isFunctionWrapper(node) || isTransparent(node)) node = node.parent;
    return isConstant(node) && ts.isIdentifier(node.name) ? node.name : undefined;
  };
  /** Whether a function is reached by name, so its call sites are all the values its parameters take. */
  const isNamed = (fn: SourceFunction) => declaredName(fn) !== undefined;
  /** The parameter a binding reads: its function, its position, and the prop it takes, or `rest` for the remainder. */
  const parameterOf = (declaration: ts.Node): { fn: SourceFunction; index: number; prop: string | null; rest: boolean } | null => {
    if (ts.isParameter(declaration) && ts.isIdentifier(declaration.name) && isSourceFunction(declaration.parent)) {
      return { fn: declaration.parent, index: declaration.parent.parameters.indexOf(declaration), prop: null, rest: false };
    }
    if (!ts.isBindingElement(declaration) || !ts.isObjectBindingPattern(declaration.parent)) return null;
    const parameter = declaration.parent.parent;
    if (!ts.isParameter(parameter) || !isSourceFunction(parameter.parent)) return null;
    const index = parameter.parent.parameters.indexOf(parameter);
    if (declaration.dotDotDotToken) return { fn: parameter.parent, index, prop: null, rest: true };
    const key = declaration.propertyName ?? declaration.name;
    return ts.isIdentifier(key) || ts.isStringLiteral(key) ? { fn: parameter.parent, index, prop: key.text, rest: false } : null;
  };
  /** `const { a, ...rest } = value`: the object a binding is taken from, and its key, or null for the rest. */
  const destructuredFrom = (declaration: ts.Node): { from: ts.Expression; key: string | null; taken: string[] } | null => {
    if (!ts.isBindingElement(declaration) || !ts.isObjectBindingPattern(declaration.parent)) return null;
    const variable = declaration.parent.parent;
    if (!ts.isVariableDeclaration(variable) || !variable.initializer) return null;
    const keyOf = (element: ts.BindingElement) => {
      const key = element.propertyName ?? element.name;
      return ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
    };
    const taken = declaration.parent.elements.filter((element) => !element.dotDotDotToken).map(keyOf)
      .filter((key): key is string => key !== null);
    if (declaration.dotDotDotToken) return { from: variable.initializer, key: null, taken };
    const key = keyOf(declaration);
    return key === null ? null : { from: variable.initializer, key, taken };
  };

  /** A finite set of strings a type allows, or null when it allows any string. */
  const literalsOf = (type: ts.Type): string[] | null => {
    const members = type.isUnion() ? type.types : [type];
    if (!members.some((member) => member.isStringLiteral())) return null;
    const out: string[] = [];
    for (const member of members) {
      if (member.isStringLiteral()) out.push(member.value);
      else if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.BooleanLiteral)) out.push("");
      else return null;
    }
    return out;
  };
  const limit = (alternatives: string[]): string[] => {
    const distinct = [...new Set(alternatives)];
    return distinct.length > MAX_ALTERNATIVES ? [distinct.join(" ")] : distinct;
  };
  const product = (left: string[], right: string[]) => limit(left.flatMap((head) => right.map((tail) => head + tail)));

  // Call sites, by the function they render or call.
  const jsxSites = new Map<SourceFunction, ts.JsxOpeningLikeElement[]>();
  const callSites = new Map<SourceFunction, ts.CallExpression[]>();
  const elements: ts.JsxOpeningLikeElement[] = [];
  const identifiers = new Map<string, ts.Identifier[]>();
  /** Names bound by an import or a variable declaration, which may name a function under another spelling. */
  const bindingNames: ts.Identifier[] = [];
  // React's createElement and cloneElement render, or add props to, an element without JSX, which is
  // where this scan reads classes; the DOM's createElementNS is how a script would draw an svg.
  const bypasses: ts.CallExpression[] = [];
  /** The module a name is imported from at its root (`React` of `React.createElement`), or null. */
  const importedFrom = (node: ts.Node): string | null => {
    let root: ts.Node = node;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    if (!ts.isIdentifier(root)) return null;
    return checker.getSymbolAtLocation(root)?.declarations?.map(moduleOf).find((name) => name !== null) ?? null;
  };
  /** The name a callee has where it is defined: `createElement` for `h` in `import { createElement as h }`. */
  const importedName = (callee: ts.Node): string => {
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    if (!ts.isIdentifier(callee)) return "";
    const specifier = checker.getSymbolAtLocation(callee)?.declarations?.find(ts.isImportSpecifier);
    return specifier ? (specifier.propertyName ?? specifier.name).text : callee.text;
  };
  for (const file of files.values()) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        identifiers.set(node.text, [...(identifiers.get(node.text) ?? []), node]);
        const parent = node.parent;
        if (((ts.isImportSpecifier(parent) || ts.isImportClause(parent)) && parent.name === node)
          || (ts.isVariableDeclaration(parent) && parent.name === node)) bindingNames.push(node);
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) elements.push(node);
      if (ts.isCallExpression(node)) {
        const fn = functionOf(declarationOf(node.expression));
        if (fn) callSites.set(fn, [...(callSites.get(fn) ?? []), node]);
        const callee = importedName(node.expression);
        if (((callee === "createElement" || callee === "cloneElement") && importedFrom(node.expression) === "react")
          || callee === "createElementNS") bypasses.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  /**
   * What is written into a constant object or array after it is declared: the properties assigned
   * or deleted by name, and `any` for a computed key, a mutating method or `Object.assign`. A
   * constant binding does not freeze what it holds, so a write makes its initializer incomplete.
   */
  const writesMemo = new Map<ts.Node, { props: Set<string>; any: boolean }>();
  const writesTo = (declaration: ts.VariableDeclaration) => {
    const known = writesMemo.get(declaration);
    if (known) return known;
    const writes = { props: new Set<string>(), any: false };
    writesMemo.set(declaration, writes);
    if (!ts.isIdentifier(declaration.name)) return writes;
    // Only an object or array can be changed through another name; a string cannot.
    const value = transparent(declaration.initializer);
    const type = checker.getTypeAtLocation(declaration.name);
    const mutable = (value && (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value) || ts.isNewExpression(value)))
      || (type.isUnion() ? type.types : [type]).some((member) => member.flags & ts.TypeFlags.Object);
    if (!mutable) return writes;
    const isWrite = (target: ts.Node) => {
      const parent = target.parent;
      return (ts.isBinaryExpression(parent) && parent.left === target && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
        || ts.isDeleteExpression(parent)
        || ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
          && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken));
    };
    for (const name of identifiers.get(declaration.name.text) ?? []) {
      if (name === declaration.name || declarationOf(name) !== declaration) continue;
      // `(common)` and `common as Props` are still `common`.
      let use: ts.Node = name;
      while (isTransparent(use.parent)) use = use.parent;
      const parent = use.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === use) {
        if (isWrite(parent)) writes.props.add(parent.name.text);
        else if (MUTATING_METHODS.has(parent.name.text) && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) writes.any = true;
      } else if (ts.isElementAccessExpression(parent) && parent.expression === use) {
        if (isWrite(parent)) writes.any = true;
      } else if (!(ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent) || ts.isJsxSpreadAttribute(parent)
        || ts.isTypeQueryNode(parent) || ts.isTypeOfExpression(parent) || ts.isExportSpecifier(parent)
        || ts.isImportSpecifier(parent) || ts.isImportClause(parent)
        || (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword && parent.right === use)
        || (ts.isCallExpression(parent) && READING_CALLS.has(parent.expression.getText())))) {
        // Handed on whole — aliased, passed to a function, stored, returned — the value can be
        // written through a name this scan does not follow.
        writes.any = true;
      }
    }
    return writes;
  };
  /** Whether a constant's value, or one property of it, may have been written after its declaration. */
  const written = (declaration: ts.VariableDeclaration, prop?: string) => {
    const writes = writesTo(declaration);
    return writes.any || (prop === undefined ? writes.props.size > 0 : writes.props.has(prop));
  };
  /** `obj.key` whose constant object has `key` written after it is declared. */
  const writtenMember = (node: ts.Node) => {
    if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression)) return false;
    const base = declarationOf(node.expression);
    return Boolean(base && base !== "glyph" && isConstant(base) && written(base, node.name.text));
  };
  /** What a prop of an object type can hold: its literals when every non-nullish member names it, or null when that cannot be told. */
  const propertyLiterals = (type: ts.Type, prop: string, at: ts.Node): string[] | null => {
    const out: string[] = [];
    for (const member of type.isUnion() ? type.types : [type]) {
      if (member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return null;
      if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.BooleanLiteral)) continue;
      const property = member.getProperty(prop);
      // An object type that does not name the prop is open: it may still carry one at run time.
      if (!property) return null;
      const values = literalsOf(checker.getTypeOfSymbolAtLocation(property, at));
      if (!values) return null;
      out.push(...values);
    }
    return out;
  };

  /** Functions whose call sites stood for all the values a parameter takes; each is checked for escapes. */
  const traced = new Set<SourceFunction>();
  const forwards = new Set<string>();
  const pending: { fn: SourceFunction; index: number; prop: string | null }[] = [];
  const forward = (fn: SourceFunction, index: number, prop: string | null): string[] => {
    traced.add(fn);
    const key = `${where(fn)}#${fn.pos}|${index}|${prop}`;
    if (!forwards.has(key)) {
      forwards.add(key);
      pending.push({ fn, index, prop });
    }
    return [FORWARDED];
  };

  /**
   * What an element's tag can render: a function in the sources, `icon` for an svg or a glyph,
   * `other` for a component whose props cannot reach an icon's class unread (another package's, or
   * a class component, whose `this.props` reads are reported where they meet an icon), or `unknown`. An unknown tag is reported,
   * because an icon behind a tag the scan cannot follow would carry classes nothing checks.
   */
  type Rendered = SourceFunction | "icon" | "other" | "unknown";
  /** Whether a name is imported, at its root, from a package other than lucide-react. */
  const fromLibrary = (node: ts.Node): boolean => {
    const module = importedFrom(node);
    return module !== null && !module.startsWith(".") && module !== "lucide-react";
  };
  /** The expressions a function returns: its concise body, or each `return` that is its own. */
  const returnedNodes = (fn: SourceFunction): ts.Node[] => {
    if (!fn.body) return [];
    if (!ts.isBlock(fn.body)) return [fn.body];
    const out: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      if (isSourceFunction(node)) return;
      if (ts.isReturnStatement(node)) { if (node.expression) out.push(node.expression); } else ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
    return out;
  };
  const componentsOf = (input: ts.Node | undefined, seen = new Set<ts.Node>()): Rendered[] => {
    const node = transparent(input);
    if (!node) return ["unknown"];
    if (seen.has(node)) return [];
    seen.add(node);
    // A tag that is a string names an element: `as="svg"`, or `` `h${level}` as "h1" | "h2" ``.
    const names = literalsOf(checker.getTypeAtLocation(input!));
    if (names) return names.some((name) => SVG_ELEMENTS.has(name)) ? ["icon"] : [];
    if (ts.isStringLiteralLike(node)) return SVG_ELEMENTS.has(node.text) ? ["icon"] : [];
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return ["other"];
    if (ts.isConditionalExpression(node)) return [...componentsOf(node.whenTrue, seen), ...componentsOf(node.whenFalse, seen)];
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      if (kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken) {
        return [...componentsOf(node.left, seen), ...componentsOf(node.right, seen)];
      }
      return kind === ts.SyntaxKind.AmpersandAmpersandToken ? componentsOf(node.right, seen) : ["unknown"];
    }
    if (isSourceFunction(node)) return [node];
    if (ts.isElementAccessExpression(node)) {
      // `ICONS[tone]` is any of the object's values.
      const values = objectValues(node.expression);
      return values ? values.flatMap((value) => componentsOf(value, seen)) : ["unknown"];
    }
    if (ts.isCallExpression(node)) {
      if (isFunctionWrapper(node)) return componentsOf(node.arguments[0], seen);
      // `const Icon = iconFor(tone)` renders whatever the helper returns, and `useMemo(() => Icon)`
      // whatever its callback does.
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      const fn = name === "useMemo" ? transparent(node.arguments[0]) : functionOf(declarationOf(callee));
      if (isSourceFunction(fn)) return returnedNodes(fn).flatMap((value) => componentsOf(value, seen));
      return fromLibrary(callee) && COMPONENT_FACTORIES.has(name) ? ["other"] : ["unknown"];
    }
    if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return ["unknown"];
    // A component passed as a prop is whatever the call sites pass, or its default: LibraryIcon's
    // `glyph`, however it is read — destructured in the signature, as `props.glyph`, or from `props`.
    const passed = propRead(node);
    if (passed) {
      return [...passedValues(passed.fn, passed.index, passed.prop).flatMap((value) => value === "unknown" ? [value] : componentsOf(value, seen)),
        ...(passed.fallback ? componentsOf(passed.fallback, seen) : [])];
    }
    const declaration = declarationOf(node);
    if (declaration === "glyph") return ["icon"];
    const fn = functionOf(declaration);
    if (fn) return [fn];
    if (fromLibrary(node)) return ["other"];
    if (declaration && (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))) return ["other"];
    if (!declaration && ts.isPropertyAccessExpression(node)) {
      // `ThemeContext.Provider`: a member of another package's object is that package's component.
      const owner = componentsOf(node.expression, seen);
      if (owner.length > 0 && owner.every((component) => component === "other")) return ["other"];
    }
    if (!declaration) return ["unknown"];
    if (writtenMember(node)) return ["unknown"];
    if (isConstant(declaration)) return componentsOf(declaration.initializer, seen);
    if (ts.isPropertyAssignment(declaration)) return componentsOf(declaration.initializer, seen);
    if (ts.isShorthandPropertyAssignment(declaration)) return componentsOf(declaration.name, seen);
    return ["unknown"];
  };
  /**
   * The parameter prop a name or property access reads, when it reads one — `glyph`, `props.glyph`,
   * or `const { glyph } = props` — with the default a binding gives it.
   */
  const propRead = (node: ts.Identifier | ts.PropertyAccessExpression):
    { fn: SourceFunction; index: number; prop: string; fallback?: ts.Expression } | null => {
    const wholeParameter = (base: ts.Node) => {
      const declaration = declarationOf(base);
      const parameter = declaration && declaration !== "glyph" ? parameterOf(declaration) : null;
      return parameter && parameter.prop === null ? parameter : null;
    };
    if (ts.isPropertyAccessExpression(node)) {
      const parameter = wholeParameter(node.expression);
      return parameter ? { fn: parameter.fn, index: parameter.index, prop: node.name.text } : null;
    }
    const declaration = declarationOf(node);
    if (!declaration || declaration === "glyph") return null;
    const fallback = ts.isBindingElement(declaration) ? declaration.initializer : undefined;
    const parameter = parameterOf(declaration);
    if (parameter && parameter.prop !== null) return { fn: parameter.fn, index: parameter.index, prop: parameter.prop, fallback };
    const destructured = destructuredFrom(declaration);
    const source = destructured?.key && transparent(destructured.from);
    const base = source && ts.isIdentifier(source) ? wholeParameter(source) : null;
    return base && destructured?.key ? { fn: base.fn, index: base.index, prop: destructured.key, fallback } : null;
  };
  /**
   * The expressions a function's call sites pass for one prop of one parameter: attributes, spread
   * objects, and through a wrapper that spreads its own props, that wrapper's call sites. `unknown`
   * stands for an object the scan cannot read that may hold the prop.
   */
  const passedValues = (fn: SourceFunction, index: number, prop: string, visited = new Set<string>()): (ts.Node | "unknown")[] => {
    traced.add(fn);
    const key = `${where(fn)}#${fn.pos}|${index}`;
    if (visited.has(key)) return [];
    visited.add(key);
    const fromObject = (input: ts.Node | undefined, seen = new Set<ts.Node>()): (ts.Node | "unknown")[] => {
      const node = transparent(input);
      if (!node || seen.has(node)) return [];
      seen.add(node);
      if (ts.isObjectLiteralExpression(node)) {
        return node.properties.flatMap((property) => {
          if (ts.isSpreadAssignment(property)) return fromObject(property.expression, seen);
          if (ts.isShorthandPropertyAssignment(property)) return property.name.text === prop ? [property.name] : [];
          if (!ts.isPropertyAssignment(property)) return [];
          if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text === prop ? [property.initializer] : [];
          return ["unknown" as const];
        });
      }
      if (ts.isConditionalExpression(node)) return [...fromObject(node.whenTrue, seen), ...fromObject(node.whenFalse, seen)];
      if (ts.isIdentifier(node)) {
        const declaration = declarationOf(node);
        if (declaration && declaration !== "glyph") {
          if (isConstant(declaration)) return written(declaration, prop) ? ["unknown" as const] : fromObject(declaration.initializer, seen);
          const destructured = destructuredFrom(declaration);
          if (destructured && destructured.key === null) {
            return destructured.taken.includes(prop) ? [] : fromObject(destructured.from, seen);
          }
          const parameter = parameterOf(declaration);
          if (parameter && parameter.prop === null) {
            const taken = parameter.rest && ts.isObjectBindingPattern(declaration.parent) && declaration.parent.elements
              .some((element) => !element.dotDotDotToken && (element.propertyName ?? element.name).getText() === prop);
            return taken ? [] : passedValues(parameter.fn, parameter.index, prop, visited);
          }
        }
      }
      // An object type is open, so one that does not name the prop may still carry it.
      return ["unknown"];
    };
    const fromElements = index !== 0 ? [] : (jsxSites.get(fn) ?? []).flatMap((site) => site.attributes.properties.flatMap((attribute) => {
      if (ts.isJsxSpreadAttribute(attribute)) return fromObject(attribute.expression);
      if (attribute.name.getText() !== prop || !attribute.initializer) return [];
      if (ts.isStringLiteral(attribute.initializer)) return [attribute.initializer];
      return ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression ? [attribute.initializer.expression] : ["unknown" as const];
    }));
    return [...fromElements, ...(callSites.get(fn) ?? []).flatMap((call) =>
      argumentsAt(call, fn, index).flatMap((argument) => argument === "unknown" ? [argument] : fromObject(argument)))];
  };
  /**
   * What a call passes for a parameter: every argument from its position on for a rest parameter,
   * and the parameter's default wherever the argument is missing or may be undefined.
   */
  const argumentsAt = (call: ts.CallExpression, fn: SourceFunction, index: number): (ts.Node | "unknown")[] => {
    const parameter = fn.parameters[index];
    const given = parameter?.dotDotDotToken ? call.arguments.slice(index) : call.arguments.slice(index, index + 1);
    // After a spread, positions are no longer known.
    if ([...call.arguments.slice(0, index), ...given].some(ts.isSpreadElement)) return ["unknown"];
    if (parameter?.dotDotDotToken) return [...given];
    const fallback = parameter?.initializer;
    const argument = given[0];
    if (!argument) return fallback ? [fallback] : [];
    const type = checker.getTypeAtLocation(argument);
    const mayBeUndefined = [type, ...(type.isUnion() ? type.types : [])]
      .some((member) => member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown));
    return fallback && mayBeUndefined ? [argument, fallback] : [argument];
  };
  /** Every value an object can hold, for an access whose key is not known, or null when the object cannot be read. */
  const objectValues = (input: ts.Node): ts.Node[] | null => {
    const node = transparent(input);
    if (!node) return null;
    if (ts.isObjectLiteralExpression(node)) {
      const values: ts.Node[] = [];
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) values.push(property.initializer);
        else if (ts.isShorthandPropertyAssignment(property)) values.push(property.name);
        else if (ts.isSpreadAssignment(property)) {
          const spread = objectValues(property.expression);
          if (!spread) return null;
          values.push(...spread);
        }
      }
      return values;
    }
    if (!ts.isIdentifier(node)) return null;
    const declaration = declarationOf(node);
    return declaration && declaration !== "glyph" && isConstant(declaration) && declaration.initializer && !written(declaration)
      ? objectValues(declaration.initializer) : null;
  };

  const memo = new Map<ts.Node, string[]>();
  /** Every string an expression can evaluate to, with UNREAD and FORWARDED standing in for what it reads. */
  const strings = (node: ts.Node | undefined): string[] => {
    if (!node) return [UNREAD];
    const known = memo.get(node);
    if (known) return known;
    memo.set(node, [UNREAD]);
    const result = limit(evaluate(node));
    memo.set(node, result);
    return result;
  };
  const typed = (node: ts.Node): string[] | null => literalsOf(checker.getTypeAtLocation(node));
  const evaluate = (node: ts.Node): string[] => {
    if (isTransparent(node)) return strings(node.expression);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.reduce((heads, span) =>
        product(product(heads, strings(span.expression)), [span.literal.text]), [node.head.text]);
    }
    if (ts.isConditionalExpression(node)) return [...strings(node.whenTrue), ...strings(node.whenFalse)];
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      if (kind === ts.SyntaxKind.PlusToken) return product(strings(node.left), strings(node.right));
      if (kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken) {
        return [...strings(node.left), ...strings(node.right)];
      }
      if (kind === ts.SyntaxKind.AmpersandAmpersandToken) return [...strings(node.right), ""];
      // A comparison is a boolean, which renders no class.
      return [""];
    }
    // The elements of a class array and the arguments of a class helper all render together.
    if (ts.isArrayLiteralExpression(node)) {
      return [node.elements.map((element) => strings(ts.isSpreadElement(element) ? element.expression : element).join(" ")).join(" ")];
    }
    if (ts.isObjectLiteralExpression(node)) {
      // `clsx({ "is-on": on })`: the keys are the classes.
      return [node.properties.map((property) => property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        ? property.name.text : UNREAD).join(" ")];
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      if (ts.isPropertyAccessExpression(callee) && name === "join") return joined(callee.expression, node.arguments[0]);
      if (ts.isPropertyAccessExpression(callee) && RELAY_METHODS.has(name)) return strings(callee.expression);
      if (ts.isPropertyAccessExpression(callee) && MAPPING_METHODS.has(name)) return results(node.arguments[0]);
      // A helper defined in the sources is read; only a package's clsx-style helper is assumed to
      // render its arguments and nothing else.
      const fn = functionOf(declarationOf(callee));
      if (fn) return results(fn);
      if (CLASS_HELPERS.has(name) && fromLibrary(callee)) return [node.arguments.map((argument) => strings(argument).join(" ")).join(" ")];
      return typed(node) ?? [UNREAD];
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return reference(node);
    return typed(node) ?? [UNREAD];
  };
  /**
   * `array.join(separator)`. Joined by whitespace, every element renders as its own classes; joined
   * by anything else, elements compose one name, so each combination is built — with an element
   * `filter()` may drop left out — or the value is unread when the elements cannot be listed.
   */
  const joined = (array: ts.Node, separator: ts.Node | undefined): string[] => {
    const separators = separator ? strings(separator) : [","];
    if (separators.every((text) => /^\s+$/.test(text))) return strings(array);
    const elements = arrayElements(array);
    if (!elements || separators.some((text) => text.includes(UNREAD) || text.includes(FORWARDED))) return [UNREAD];
    let combinations: string[][] = [[]];
    for (const alternatives of elements) {
      combinations = combinations.flatMap((head) => alternatives.map((alternative) => alternative === DROPPED ? head : [...head, alternative]));
      if (combinations.length > MAX_ALTERNATIVES) return [UNREAD];
    }
    return limit(separators.flatMap((text) => combinations.map((parts) => parts.join(text))));
  };
  /** Each element of an array as its alternatives, DROPPED where `filter()` may remove it, or null when they cannot be listed. */
  const arrayElements = (input: ts.Node, seen = new Set<ts.Node>()): string[][] | null => {
    const node = transparent(input);
    if (!node || seen.has(node)) return null;
    seen.add(node);
    if (ts.isArrayLiteralExpression(node)) {
      const out: string[][] = [];
      for (const element of node.elements) {
        if (!ts.isSpreadElement(element)) { out.push(strings(element)); continue; }
        const spread = arrayElements(element.expression, seen);
        if (!spread) return null;
        out.push(...spread);
      }
      return out;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "filter") {
      const receiver = arrayElements(node.expression.expression, seen);
      const predicate = node.arguments[0];
      // `filter(Boolean)` drops the empty values; any other predicate may drop anything.
      const byTruth = predicate && ts.isIdentifier(predicate) && predicate.text === "Boolean";
      return receiver?.map((alternatives) => byTruth
        ? alternatives.map((alternative) => alternative === "" ? DROPPED : alternative)
        : [...alternatives, DROPPED]) ?? null;
    }
    if (!ts.isIdentifier(node)) return null;
    const declaration = declarationOf(node);
    return declaration && declaration !== "glyph" && isConstant(declaration) && declaration.initializer && !written(declaration)
      ? arrayElements(declaration.initializer, seen) : null;
  };
  /** What a function returns: its concise body, or each `return` that is its own. */
  const results = (input: ts.Node | undefined): string[] => {
    const fn = transparent(input);
    if (!isSourceFunction(fn) || !fn.body) return [UNREAD];
    if (!ts.isBlock(fn.body)) return strings(fn.body);
    const out: string[] = [];
    const visit = (node: ts.Node): void => {
      if (isSourceFunction(node)) return;
      if (ts.isReturnStatement(node)) out.push(...(node.expression ? strings(node.expression) : [""]));
      else ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
    return out;
  };
  const reference = (node: ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression): string[] => {
    const narrowed = typed(node);
    if (narrowed) return narrowed;
    if (ts.isElementAccessExpression(node)) {
      const values = objectValues(node.expression);
      return values && values.length > 0 ? values.flatMap(strings) : [UNREAD];
    }
    if (ts.isPropertyAccessExpression(node)) {
      // `props.className`, or a prop of the rest.
      const base = declarationOf(node.expression);
      const parameter = base && base !== "glyph" ? parameterOf(base) : null;
      if (parameter && parameter.prop === null) {
        return isNamed(parameter.fn) ? forward(parameter.fn, parameter.index, node.name.text) : [UNREAD];
      }
    }
    if (writtenMember(node)) return [UNREAD];
    const declaration = declarationOf(node);
    if (!declaration || declaration === "glyph") return [UNREAD];
    if (isConstant(declaration) && declaration.initializer) return written(declaration) ? [UNREAD] : strings(declaration.initializer);
    if (ts.isPropertyAssignment(declaration)) return strings(declaration.initializer);
    if (ts.isShorthandPropertyAssignment(declaration)) return strings(declaration.name);
    const destructured = destructuredFrom(declaration);
    if (destructured?.key) {
      const fallback = ts.isBindingElement(declaration) && declaration.initializer ? strings(declaration.initializer) : [];
      return [...objectProp(destructured.from, destructured.key), ...fallback];
    }
    const parameter = parameterOf(declaration);
    if (!parameter || parameter.rest || !isNamed(parameter.fn)) return [UNREAD];
    const fallback = (ts.isParameter(declaration) || ts.isBindingElement(declaration)) && declaration.initializer
      ? strings(declaration.initializer) : [];
    return [...forward(parameter.fn, parameter.index, parameter.prop), ...fallback];
  };
  /** The values a prop can take from an object: its literal, through spreads and constants, or the call sites' values. */
  const reading = new Set<string>();
  const objectProp = (input: ts.Node, prop: string): string[] => {
    const node = transparent(input);
    if (!node) return [UNREAD];
    // Reading an object while already reading it (`<Mark attrs={attrs} />` inside Mark, a helper
    // that returns its own call) adds nothing the outer read does not already collect.
    const key = `${where(node)}#${node.pos}|${prop}`;
    if (reading.has(key)) return [];
    reading.add(key);
    try {
      return objectPropOf(node, prop);
    } finally {
      reading.delete(key);
    }
  };
  const objectPropOf = (node: ts.Node, prop: string): string[] => {
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.flatMap((property) => {
        if (ts.isSpreadAssignment(property)) return objectProp(property.expression, prop);
        if (ts.isShorthandPropertyAssignment(property)) return property.name.text === prop ? strings(property.name) : [];
        const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null;
        if (name === null) return [UNREAD];
        if (name !== prop) return [];
        // A getter or method of that name computes the class rather than holding it.
        return ts.isPropertyAssignment(property) ? strings(property.initializer) : [UNREAD];
      });
    }
    if (ts.isConditionalExpression(node)) return [...objectProp(node.whenTrue, prop), ...objectProp(node.whenFalse, prop)];
    if (ts.isCallExpression(node)) {
      // `<svg {...iconProps(tone)} />`: whatever object the helper returns.
      const fn = functionOf(declarationOf(node.expression));
      if (fn) return returnedNodes(fn).flatMap((value) => objectProp(value, prop));
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      // `function Mark({ attrs }) { return <svg {...attrs} />; }`: whatever objects the call sites pass.
      const passed = propRead(node);
      if (passed) {
        return [...passedValues(passed.fn, passed.index, passed.prop).flatMap((value) => value === "unknown" ? [UNREAD] : objectProp(value, prop)),
          ...(passed.fallback ? objectProp(passed.fallback, prop) : [])];
      }
    }
    if (ts.isIdentifier(node)) {
      const declaration = declarationOf(node);
      if (declaration && declaration !== "glyph") {
        if (isConstant(declaration) && declaration.initializer) {
          return written(declaration, prop) ? [UNREAD] : objectProp(declaration.initializer, prop);
        }
        const destructured = destructuredFrom(declaration);
        if (destructured && destructured.key === null) {
          return destructured.taken.includes(prop) ? [] : objectProp(destructured.from, prop);
        }
        const parameter = parameterOf(declaration);
        // `({ className, ...props })`: the rest no longer holds what was taken out of it.
        const taken = parameter?.rest && ts.isObjectBindingPattern(declaration.parent) && declaration.parent.elements
          .some((element) => !element.dotDotDotToken && (element.propertyName ?? element.name).getText() === prop);
        if (taken) return [];
        if (parameter && parameter.prop === null && isNamed(parameter.fn)) return forward(parameter.fn, parameter.index, prop);
      }
    }
    // A type that names the prop bounds its values. One that does not proves nothing: TypeScript's
    // object types are open, so `{ width: number }` may hold a className at run time.
    const type = checker.getTypeAtLocation(node);
    const values = propertyLiterals(type, prop, node);
    if (values && values.length > 0) return values;
    // Only `undefined` or `null` itself certainly holds nothing.
    const nullish = (type.isUnion() ? type.types : [type]).every((member) => member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null));
    return nullish ? [] : [UNREAD];
  };
  /**
   * The values a prop takes at one element, in attribute order: an explicit attribute replaces
   * everything before it, and a spread after it may or may not replace it, so it adds its values.
   */
  const elementProp = (element: ts.JsxOpeningLikeElement, prop: string): string[] => {
    // Nothing before the last explicit attribute reaches the element, so it is not even read: reading
    // a spread of props would follow its call sites and collect classes this element never gets.
    const attributes = element.attributes.properties;
    const last = attributes.findLastIndex((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText() === prop);
    let values: string[] = [];
    for (const attribute of attributes.slice(Math.max(last, 0))) {
      if (ts.isJsxSpreadAttribute(attribute)) { values = [...values, ...objectProp(attribute.expression, prop)]; continue; }
      if (attribute.name.getText() !== prop) continue;
      const value = attribute.initializer;
      values = !value ? [""] : ts.isStringLiteral(value) ? [value.text] : ts.isJsxExpression(value) ? strings(value.expression) : [UNREAD];
    }
    return values;
  };

  const classes = new Map<string, string>();
  const unread = new Set<string>();
  const collect = (alternatives: string[], at: ts.Node) => {
    for (const token of alternatives.flatMap((alternative) => alternative.split(/\s+/))) {
      if (!token || [...token].every((char) => char === FORWARDED)) continue;
      if (token.includes(UNREAD) || token.includes(FORWARDED)) {
        unread.add(`${where(at)} ${token.replaceAll(UNREAD, "${…}").replaceAll(FORWARDED, "${prop}")}`);
      } else if (!/^-?[_a-z][\w-]*$/i.test(token)) {
        // `a,b` from a comma join, or a name CSS can only select escaped: nothing here checks it.
        unread.add(`${where(at)} ${token}`);
      } else if (!classes.has(token)) classes.set(token, where(at));
    }
  };

  // Which function each element renders, to a fixed point: a component passed as a prop is known
  // only once the call sites of the function taking it are.
  const rendered = new Map<ts.JsxOpeningLikeElement, Set<Rendered>>();
  for (let changed = true; changed;) {
    changed = false;
    for (const element of elements) {
      const known = rendered.get(element) ?? new Set();
      rendered.set(element, known);
      const tag = element.tagName;
      const found: Rendered[] = ts.isIdentifier(tag) && /^[a-z]/.test(tag.text) ? (SVG_ELEMENTS.has(tag.text) ? ["icon"] : []) : componentsOf(tag);
      for (const component of found) {
        if (known.has(component)) continue;
        known.add(component);
        changed = true;
        if (typeof component !== "string") jsxSites.set(component, [...(jsxSites.get(component) ?? []), element]);
      }
    }
  }
  for (const [element, components] of rendered) {
    if (components.has("unknown")) unread.add(`${where(element)} <${element.tagName.getText()}>`);
  }
  for (const call of bypasses) unread.add(`${where(call)} ${call.expression.getText()}() bypasses JSX`);
  for (const [element, components] of rendered) {
    if (components.has("icon")) collect(elementProp(element, "className"), element);
  }
  /** The other spellings each function is bound under, by an import or a constant, read once. */
  let aliases: Map<SourceFunction, Set<string>> | undefined;
  const bindings = new Set(bindingNames);
  const aliasesOf = () => {
    if (aliases) return aliases;
    aliases = new Map();
    for (const binding of bindingNames) {
      const fn = functionOf(declarationOf(binding));
      if (fn) aliases.set(fn, new Set([...(aliases.get(fn) ?? []), binding.text]));
    }
    return aliases;
  };
  /**
   * Where a function is used other than by calling it or rendering it: passed to `map()`, handed to
   * another package, aliased. Its call sites are then not all the values its parameters take. A
   * component may also travel to a tag — through a constant, an object of components, a prop or a
   * return — because `componentsOf` follows those to where it renders.
   */
  const escapes = (fn: SourceFunction): ts.Identifier | undefined => {
    const name = declaredName(fn);
    if (!name) return undefined;
    const component = jsxSites.has(fn);
    // Every spelling: the declaration's, and each import or constant that names the same function.
    const spellings = new Set([name.text, ...(aliasesOf().get(fn) ?? [])]);
    return [...spellings].flatMap((spelling) => identifiers.get(spelling) ?? []).find((use) => {
      if (use === name || bindings.has(use) || functionOf(declarationOf(use)) !== fn) return false;
      let node: ts.Node = use;
      while (isTransparent(node.parent)) node = node.parent;
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.expression === node) return false;
      if (isFunctionWrapper(parent) && parent.arguments[0] === node) return false;
      if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isExportSpecifier(parent)
        || ts.isExportAssignment(parent) || ts.isTypeQueryNode(parent)) return false;
      if ((ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) && parent.tagName === node) return false;
      if (!component) return true;
      const toTag = (isConstant(parent) && parent.initializer === node)
        || (ts.isPropertyAssignment(parent) && parent.initializer === node) || ts.isShorthandPropertyAssignment(parent)
        || (ts.isConditionalExpression(parent) && parent.condition !== node)
        || (ts.isBinaryExpression(parent) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.AmpersandAmpersandToken].includes(parent.operatorToken.kind))
        || (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent))
        || ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === node);
      return !toTag;
    });
  };
  while (pending.length > 0) {
    const { fn, index, prop } = pending.shift()!;
    if (index === 0 && prop !== null) for (const site of jsxSites.get(fn) ?? []) collect(elementProp(site, prop), site);
    for (const call of callSites.get(fn) ?? []) {
      for (const argument of argumentsAt(call, fn, index)) {
        if (argument === "unknown") collect([UNREAD], call);
        else collect(prop === null ? strings(argument) : objectProp(argument, prop), argument);
      }
    }
  }
  for (const fn of traced) {
    const escape = escapes(fn);
    if (escape) unread.add(`${where(escape)} ${escape.text} is used as a value, so its arguments cannot be traced`);
  }
  return { classes, unread: [...unread].sort() };
}

const SYSTEM_COLOURS = new Set(["accentcolor", "accentcolortext", "activetext", "buttonborder", "buttonface",
  "buttontext", "canvas", "canvastext", "field", "fieldtext", "graytext", "highlight", "highlighttext", "linktext",
  "mark", "marktext", "selecteditem", "selecteditemtext", "visitedtext"]);

/** Whether a colour hands an icon its words' colour in forced colors: it inherits, or it is a system colour. */
export function followsWords(value: string): boolean {
  const colour = stripComments(value).trim().toLowerCase();
  return colour === "inherit" || colour === "currentcolor" || colour === "unset" || SYSTEM_COLOURS.has(colour);
}

type Specificity = readonly [number, number, number];
const compareSpecificity = (left: Specificity, right: Specificity) =>
  left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
const heaviest = (weights: Specificity[]): Specificity =>
  weights.reduce((best, weight) => compareSpecificity(weight, best) > 0 ? weight : best, [0, 0, 0] as Specificity);
const addSpecificity = (left: Specificity, right: Specificity): Specificity =>
  [left[0] + right[0], left[1] + right[1], left[2] + right[2]];

/** One simple selector's weight. `:is()`, `:not()` and `:has()` weigh their heaviest argument and `:where()` nothing. */
function simpleSpecificity(part: string): Specificity {
  const functional = /^:([\w-]+)\(([\s\S]*)\)$/.exec(part);
  if (functional) {
    const name = functional[1]!.toLowerCase();
    if (name === "where") return [0, 0, 0];
    const heaviestOf = (list: string) => heaviest(selectorCompounds(list).map(memberSpecificity));
    if (["is", "not", "has", "matches", "-webkit-any"].includes(name)) return heaviestOf(functional[2]!);
    const of = /^nth-(?:last-)?child$/.test(name) ? /\sof\s+([\s\S]+)$/i.exec(functional[2]!) : null;
    return of ? addSpecificity([0, 1, 0], heaviestOf(of[1]!)) : [0, 1, 0];
  }
  if (part.startsWith("::") || /^:(?:before|after|first-line|first-letter)$/i.test(part)) return [0, 0, 1];
  if (part.startsWith("#")) return [1, 0, 0];
  if (/^[.[:]/.test(part)) return [0, 1, 0];
  return /^(?:(?:[\w-]*|\*)\|)?\*$/.test(part) ? [0, 0, 0] : [0, 0, 1];
}

type ParsedMember = { compounds: string[][]; combinators: string[] };
const memberSpecificity = (member: ParsedMember): Specificity =>
  member.compounds.flat().map(simpleSpecificity).reduce(addSpecificity, [0, 0, 0]);
/** The weight of each member of a selector list, as (ids, classes, types). */
export const selectorSpecificity = (selectorList: string): Specificity[] => selectorCompounds(selectorList).map(memberSpecificity);
/** A member as one canonical string: comments dropped, combinators spaced. */
const memberText = (member: ParsedMember) => member.compounds
  .map((parts, index) => `${index === 0 ? "" : member.combinators[index - 1] === " " ? " " : ` ${member.combinators[index - 1]} `}${parts.join("")}`)
  .join("");
/** Everything before the subject, which a counterpart must repeat exactly unless it has none. */
const memberContext = (member: ParsedMember) =>
  memberText({ compounds: [...member.compounds.slice(0, -1), []], combinators: member.combinators });
/** A simple selector as the browser compares it: escapes read, and case folded where CSS ignores it. */
const normalSimple = (part: string) => /^[.#]/.test(part) ? part[0] + unescapeIdentifier(part.slice(1))
  : /^\[/.test(part) ? canonicalSelector(part) : /^:/.test(part) ? canonicalSelector(part).replace(/^::?[\w-]+/, (name) => name.toLowerCase())
    : part.toLowerCase();

/**
 * A subject narrowed to the icon it can be: as written when one of its own simple selectors names the
 * icon, or else once per icon alternative of an `:is()` or `:where()`, so `.row > :is(.ps-icon, .v)`
 * is the icon `.row > .ps-icon` and its words `.row > .v` are not. Empty when the subject is no icon.
 */
function iconSubjects(parts: readonly string[], icons: ReadonlySet<string>): string[][] {
  const isIcon = (part: string, index: number) => {
    const name = unescapeIdentifier(part);
    const element = /^(?:(?:[\w-]*|\*)\|)?([a-z]+)$/i.exec(name)?.[1]?.toLowerCase();
    return (name.startsWith(".") && icons.has(name.slice(1))) || (index === 0 && element !== undefined && SVG_ELEMENTS.has(element));
  };
  if (parts.some(isIcon)) return [parts.map(normalSimple)];
  return parts.flatMap((part, index) => {
    const alternatives = /^:(?:is|where)\(([\s\S]*)\)$/i.exec(part);
    if (!alternatives) return [];
    const others = parts.filter((_, other) => other !== index).map(normalSimple);
    return selectorCompounds(alternatives[1]!).flatMap((alternative) => {
      const narrowed = iconSubjects(alternative.compounds.at(-1)!, icons);
      if (narrowed.length === 0) return [];
      // An alternative with its own combinators cannot be flattened into the subject; a counterpart
      // then has to repeat the whole `:is()`.
      return alternative.compounds.length > 1 ? [parts.map(normalSimple)] : narrowed.map((subject) => [...others, ...subject]);
    });
  });
}

/** A subject's simple selectors once each `:is()` and `:where()` of single compounds is expanded: any one of them matches. */
function expandedSubjects(parts: readonly string[]): string[][] {
  const index = parts.findIndex((part) => /^:(?:is|where)\(/i.test(part));
  if (index < 0) return [parts.map(normalSimple)];
  const alternatives = selectorCompounds(/^:(?:is|where)\(([\s\S]*)\)$/i.exec(parts[index]!)![1]!);
  if (alternatives.some((alternative) => alternative.compounds.length > 1)) {
    return expandedSubjects(parts.filter((_, other) => other !== index)).map((rest) => [normalSimple(parts[index]!), ...rest]);
  }
  return alternatives.flatMap((alternative) =>
    expandedSubjects([...parts.slice(0, index), ...alternative.compounds[0]!, ...parts.slice(index + 1)]));
}

/**
 * Whether a counterpart selects every element an icon subject does: its own subject is a subset of
 * the icon's, and it has no context or exactly the icon rule's context. A counterpart that matches
 * more broadly (`.icon` for `.row .icon`) counts; one that relies on different ancestors does not,
 * because nothing proves it reaches the same icons.
 */
function covers(counterpart: ParsedMember, context: string, subject: readonly string[]): boolean {
  const counterpartContext = memberContext(counterpart);
  if (counterpartContext !== "" && counterpartContext !== context) return false;
  return expandedSubjects(counterpart.compounds.at(-1)!).some((parts) => parts.every((part) => subject.includes(part)));
}

/** One media query that is forced colors and nothing else. */
const FORCED_ONLY = /^\(\s*forced-colors\s*:\s*active\s*\)$/i;
/**
 * Whether one media query matches only in forced colors: it requires `(forced-colors: active)`, and
 * nothing negates that requirement. A `not` elsewhere — `(forced-colors: active) and (not (pointer:
 * coarse))` — negates only its own condition; a query opening with `not` negates all of it, and one
 * with `or` (Media Queries 4) can match without it.
 */
const requiresForcedColors = (query: string) => !/^\s*not\b|\bor\b/i.test(query)
  && /(?<!\bnot\s*)\(\s*forced-colors\s*:\s*active\s*\)/i.test(query);
/** Whether one media query can never match in forced colors: it requires `(forced-colors: none)` or `not (forced-colors: active)`. */
const excludesForcedColors = (query: string) => !/^\s*not\b|\bor\b/i.test(query)
  && (/(?<!\bnot\s*)\(\s*forced-colors\s*:\s*none\s*\)/i.test(query) || /\bnot\s*\(\s*forced-colors\s*:\s*active\s*\)/i.test(query));

export interface SelfColouredIcon { rule: string; at: string; problem: string }

/**
 * Every rule that sets an icon's `color` to an author colour and is not undone in forced colors: by
 * a later `@media (forced-colors: active)` rule, at least as heavy, that selects the same icon and
 * sets `color` to `inherit`, `currentColor` or a system colour. A rule inside forced colors that
 * sets an author colour on an icon is reported outright, since nothing can undo it there.
 */
export function selfColouredIcons(sheet: postcss.Root, icons: ReadonlySet<string>): SelfColouredIcon[] {
  type Entry = {
    rule: postcss.Rule; declaration: postcss.Declaration; members: ParsedMember[]; forced: boolean;
    conditions: string[]; order: number; follows: boolean;
  };
  const entries: Entry[] = [];
  sheet.walkDecls((declaration) => {
    if (declaration.prop.toLowerCase() !== "color") return;
    const target = declarationTarget(declaration);
    if (!target) return;
    const atRules: postcss.AtRule[] = [];
    for (let node = declaration.parent as postcss.Node | undefined; node; node = node.parent as postcss.Node | undefined) {
      if (node.type === "atrule") atRules.push(node as postcss.AtRule);
    }
    if (atRules.some((atRule) => /keyframes$/i.test(atRule.name))) return;
    const queries = (atRule: postcss.AtRule) => atRule.name.toLowerCase() === "media" ? topLevelSelectorMembers(atRule.params) : [];
    const forcedMedia = atRules.filter((atRule) => queries(atRule).some(requiresForcedColors));
    // A query that adds a condition to forced colors (`… and (max-width: 760px)`) is still a condition.
    const onlyForced = forcedMedia.filter((atRule) => queries(atRule).some((query) => FORCED_ONLY.test(query)));
    // Media that cannot match in forced colors never applies where the icon would keep its colour.
    if (atRules.some((atRule) => queries(atRule).length > 0 && queries(atRule).every(excludesForcedColors))) return;
    entries.push({
      rule: target.rule,
      declaration,
      members: selectorCompounds(target.selector),
      forced: forcedMedia.length > 0,
      conditions: atRules.filter((atRule) => !onlyForced.includes(atRule))
        .map((atRule) => `@${atRule.name} ${atRule.params}`.replace(/\s+/g, " ").trim()),
      order: declaration.source?.start?.offset ?? 0,
      follows: followsWords(declaration.value),
    });
  });

  const found: SelfColouredIcon[] = [];
  for (const entry of entries) {
    if (entry.follows) continue;
    const line = entry.declaration.source?.start?.line ?? 0;
    const value = `color: ${entry.declaration.value}${entry.declaration.important ? " !important" : ""}`;
    for (const member of entry.members) {
      const subjects = iconSubjects(member.compounds.at(-1)!, icons);
      if (subjects.length === 0) continue;
      const report = (problem: string) =>
        found.push({ rule: contextKey(entry.rule), at: `styles.css:${line} ${memberText(member)} { ${value} }`, problem });
      if (entry.forced) {
        report("it sets an author colour inside forced colors, where an svg keeps it");
        continue;
      }
      const weight = memberSpecificity(member);
      const context = memberContext(member);
      let lighter: string | null = null;
      const undone = (subject: readonly string[]) => entries.some((counterpart) => {
        if (!counterpart.forced || !counterpart.follows || counterpart.order <= entry.order) return false;
        if (entry.declaration.important && !counterpart.declaration.important) return false;
        if (!counterpart.conditions.every((condition) => entry.conditions.includes(condition))) return false;
        return counterpart.members.some((candidate) => {
          if (!covers(candidate, context, subject)) return false;
          if ((counterpart.declaration.important && !entry.declaration.important)
            || compareSpecificity(memberSpecificity(candidate), weight) >= 0) return true;
          lighter ??= `${memberText(candidate)} (styles.css:${counterpart.declaration.source?.start?.line ?? 0})`;
          return false;
        });
      });
      // Each alternative of a functional selector left in the subject is an icon of its own to undo.
      if (subjects.flatMap(expandedSubjects).every(undone)) continue;
      report(lighter
        ? `its forced-colors rule ${lighter} is lighter, so the icon keeps this colour`
        : "no later @media (forced-colors: active) rule sets this icon's color to inherit or a system colour");
    }
  }
  return found;
}

/**
 * Rules allowed to colour an icon with no forced-colors counterpart, by `contextKey`, each with why.
 *
 * Empty: every rule #2269 found is undone. An entry must still name a rule the guard reports, so
 * one whose rule is fixed or deleted fails until it is removed.
 */
export const SELF_COLOURED_ICON_EXEMPTIONS: ReadonlyMap<string, string> = new Map();

export function assertIconsFollowWords(found: readonly SelfColouredIcon[], exemptions: ReadonlyMap<string, string>): void {
  const reported = found.filter(({ rule }) => !exemptions.has(rule)).map(({ at, problem }) => `${at}: ${problem}`);
  assert.deepEqual(reported, [],
    "an icon sets its own colour, which it keeps in forced colors while its words turn a system colour " +
    "(Chromium gives an svg forced-color-adjust: preserve-parent-color). Add a later @media (forced-colors: active) " +
    "rule with the same selector that sets color: inherit (or a system colour), or let the icon inherit its " +
    `colour in normal mode:\n${reported.join("\n")}`);
  for (const [rule] of exemptions) {
    assert.ok(found.some((entry) => entry.rule === rule),
      `${rule}: exempted as a self-coloured icon, but the guard no longer reports it; remove its SELF_COLOURED_ICON_EXEMPTIONS entry`);
  }
}

/** Read once, on first use: the scan reads every production source through the TypeScript checker. */
let iconClassScan: ReturnType<typeof iconClasses> | undefined;
const productionIconClasses = () => iconClassScan ??= iconClasses(productionSources());

test("every icon class in production source is read", () => {
  assert.deepEqual(productionIconClasses().unread, [],
    "a class value on an icon could not be read, so a rule colouring that icon would go unchecked; " +
    "write it as a literal, a constant, a typed union or a prop the scan follows");
});

test("every icon that sets its own colour follows its words in forced colors", () => {
  assertIconsFollowWords(selfColouredIcons(root, new Set(productionIconClasses().classes.keys())), SELF_COLOURED_ICON_EXEMPTIONS);
});

/**
 * PRODUCTION source only, in a STABLE order, read one file at a time.
 *
 * Three separate defects lived here. `src/e2e` reproduces production markup on purpose, which
 * makes it the worst possible corpus for "is this class rendered" — the guard was certifying dead
 * CSS from the evidence written to check it. `readdirSync` returns entries in filesystem order, so
 * the same checkout measured 179 dead classes in one enumeration order and 248 in another. And
 * concatenating every file before matching template literals paired a backtick in one file with a
 * backtick in the next, so the scanner read across the join and produced garbage for everything
 * after it. Files are sorted, and each is scanned alone.
 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of [...readdirSync(dir)].sort()) {
    const path = join(dir, entry);
    if (entry === "e2e" && statSync(path).isDirectory()) continue;
    if (statSync(path).isDirectory()) { sourceFiles(path, out); continue; }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    out.push(path);
  }
  return out;
}

/** Production sources with their `src`-relative, forward-slash path — the identity a file has in the inventory. */
function productionSources(): { file: string; source: string }[] {
  const src = join(WEB, "src");
  return sourceFiles(src).map((path) => ({
    file: relative(src, path).split(sep).join("/"),
    source: readFileSync(path, "utf8"),
  }));
}

function parseSource(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

const namedEntities = new Map<string, string>();

/**
 * JSX character references as the JSX transform renders them. Numeric ones are decoded here;
 * named ones are asked of the TypeScript emitter, which carries the XHTML entity table JSX uses,
 * so this never keeps a second copy of it. An unknown name stays as written, as it does in JSX.
 */
export function decodeJsxEntities(text: string): string {
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));/gi, (whole, hex?: string, decimal?: string, name?: string) => {
    if (hex || decimal) {
      const codePoint = Number.parseInt(hex ?? decimal!, hex ? 16 : 10);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : whole;
    }
    if (!namedEntities.has(name!)) {
      const emitted = ts.transpileModule(`<b>&${name};</b>`, { compilerOptions: { jsx: ts.JsxEmit.React } }).outputText;
      const literal = /, "((?:[^"\\]|\\.)*)"\)/.exec(emitted)?.[1];
      namedEntities.set(name!, literal === undefined ? whole : JSON.parse(`"${literal}"`) as string);
    }
    return namedEntities.get(name!)!;
  });
}

/**
 * Every emoji in a string literal, template chunk or JSX text, by identity: file, character and
 * the enclosing literal's text.
 *
 * The AST decides what is a literal, so comments are ignored and an escaped `"✅"` is read as
 * the character it renders. `Extended_Pictographic` is the emoji property, so text glyphs such as
 * ✓, ✕ and × are not reported here; §18 retires those through the area issues.
 *
 * No production file is exempt: every emoji the scan finds today stands in for an icon. Should a
 * fixture or user-content file arrive, exempt it by NAME with a reason, as the library classes are.
 */
export function emojiLiterals(source: string, fileName: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      // JSX text and JSX attribute strings keep `&#x1F512;` spelled out in the AST, while the
      // browser renders 🔒; read them as rendered, or an entity walks past the rule.
      const jsx = ts.isJsxText(node) || (ts.isStringLiteral(node) && ts.isJsxAttribute(node.parent));
      const text = (jsx ? decodeJsxEntities(node.text) : node.text).replace(/\s+/g, " ").trim();
      for (const char of text) if (PICTOGRAPHIC.test(char)) out.push(`${fileName}|${char}|${text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parseSource(source, fileName));
  return out;
}

const NATIVE_GLOBALS = new Set(["window", "globalThis", "self"]);

/**
 * The node a declaration of `name` is visible throughout, or null when `name` declares nothing.
 *
 * Lexical scoping without the type checker: `let`/`const` and a function declaration live in their
 * enclosing block, `var` in its enclosing function, a parameter in its function, an import in the
 * file. That is what decides whether a bare `confirm(...)` reaches the global.
 */
function declarationScope(name: ts.Identifier): ts.Node | null {
  let owner: ts.Node = name.parent;
  if ((ts.isBindingElement(owner) || ts.isVariableDeclaration(owner) || ts.isParameter(owner)
    || ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner) || ts.isImportSpecifier(owner)
    || ts.isImportClause(owner) || ts.isNamespaceImport(owner)) && owner.name !== name) return null;
  if (ts.isImportSpecifier(owner) || ts.isImportClause(owner) || ts.isNamespaceImport(owner)) return name.getSourceFile();
  if (ts.isFunctionDeclaration(owner)) return owner.parent;
  // A named function expression binds its name inside itself only.
  if (ts.isFunctionExpression(owner)) return owner;
  // Climb a destructuring pattern to the declaration or parameter that owns it.
  while (ts.isBindingElement(owner) || ts.isObjectBindingPattern(owner) || ts.isArrayBindingPattern(owner)) owner = owner.parent;
  if (ts.isParameter(owner)) return owner.parent;
  if (!ts.isVariableDeclaration(owner)) return null;
  if (ts.isCatchClause(owner.parent)) return owner.parent;
  const list = owner.parent;
  if (list.flags & ts.NodeFlags.BlockScoped) {
    const statement = list.parent;
    return ts.isForStatement(statement) || ts.isForOfStatement(statement) || ts.isForInStatement(statement)
      ? statement : statement.parent;
  }
  // `var` hoists to its function's BODY: a parameter default runs before the body and cannot see it.
  let scope: ts.Node = list;
  while (!ts.isSourceFile(scope) && !ts.isFunctionLike(scope)) scope = scope.parent;
  return ts.isSourceFile(scope) ? scope : (scope as ts.FunctionLikeDeclaration).body ?? scope;
}

/** `{ confirm }` or `{ confirm: ask }` destructured straight from `window`, `globalThis` or `self`. */
function destructuresNativeConfirm(node: ts.Node, isGlobal: (node: ts.Node) => boolean): boolean {
  if (!ts.isBindingElement(node) || !ts.isObjectBindingPattern(node.parent)) return false;
  const key = node.propertyName ?? node.name;
  if (!(ts.isIdentifier(key) || ts.isStringLiteralLike(key)) || key.text !== "confirm") return false;
  const declaration = node.parent.parent;
  return ts.isVariableDeclaration(declaration) && Boolean(declaration.initializer) && isGlobal(declaration.initializer!);
}

/**
 * Every reference to the browser's native `confirm`, as `file:line: code`.
 *
 * `window.confirm`, `globalThis.confirm`, `window["confirm"]`, and a bare `confirm(...)` that no
 * enclosing scope rebinds. Binding the dialog's `confirm` in one component does not vouch for a
 * bare call in another component of the same file: that call still reaches the global.
 */
export function nativeConfirmReferences(source: string, fileName: string): string[] {
  const file = parseSource(source, fileName);
  const found: ts.Node[] = [];
  const scopes: ts.Node[] = [];
  const calls: ts.CallExpression[] = [];
  const isGlobal = (node: ts.Node) => {
    const inner = transparent(node);
    return Boolean(inner && ts.isIdentifier(inner) && NATIVE_GLOBALS.has(inner.text));
  };
  const visit = (node: ts.Node): void => {
    // Destructuring the native confirm is a reference to it, reported where it happens; the local
    // name it creates then shadows nothing that matters, because the damage is already reported.
    if (destructuresNativeConfirm(node, isGlobal)) found.push(node);
    else if (ts.isIdentifier(node) && node.text === "confirm") {
      const scope = declarationScope(node);
      if (scope) scopes.push(scope);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "confirm") calls.push(node);
    if (ts.isPropertyAccessExpression(node) && node.name.text === "confirm" && isGlobal(node.expression)) found.push(node);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
      && node.argumentExpression.text === "confirm" && isGlobal(node.expression)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  const bare = calls.filter((call) => !scopes.some((scope) => scope.pos <= call.pos && call.end <= scope.end));
  return [...found, ...bare].map((node) =>
    `${fileName}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${node.getText(file)}`);
}

export function assertNoNativeConfirm(references: string[]): void {
  assert.deepEqual(references, [],
    "window.confirm: the browser's native confirm is banned — use the confirmation dialog, " +
    "useFeedback().confirm, with an action title and a verb-matched confirm label (docs/design-system.md §7.4)");
}

/**
 * Class names from the TypeScript AST, at the positions a class can actually reach the DOM.
 *
 * Three text-scanning versions were wrong before this one, each in a way the corpus hid. Taking
 * every string literal in a file made `type="checkbox"` certify the `.checkbox` rule as live.
 * Recognising only a quoted `className` or a whole-value template deleted every interpolation, so
 * `className={readOnly ? "is-readonly" : ""}` contributed nothing. And reading every literal inside
 * a balanced `className={...}` took COMPARISON OPERANDS as classes: `mode === "parallel"` recorded
 * `parallel`, which can certify a dead `.parallel` rule as rendered — the false-evidence direction,
 * not the conservative one the comment claimed.
 *
 * The parser knows which positions produce a value and which are predicates, so it is what asks.
 */
/**
 * Functions whose string arguments become class output.
 *
 * A named producer beats an inventory entry. `ui-row-nav` was carried as a hand-written exemption
 * whose staleness check was `source.includes(name)` — which `root.querySelector(".ui-row-nav")`
 * satisfies, so deleting the actual producer left the exemption looking valid. Reading `rowClass`
 * makes the class genuinely rendered, and removing the producer now removes the evidence with it.
 */
const CLASS_HELPERS = new Set(["clsx", "cn", "classNames", "classnames", "rowClass"]);

/**
 * Array methods whose OUTPUT elements are their receiver's elements.
 *
 * `["row", on ? "is-on" : ""].filter(Boolean).join(" ")` renders exactly the classes the array
 * literal holds, but the `.join()` reader only followed its immediate receiver, so one chained
 * call hid every class in the expression and reported all of them as dead CSS. Reading through
 * these makes a chained `.join()` yield what a direct one yields, however many links deep.
 *
 * Kept separate from `CLASS_HELPERS`: those compose classes from their ARGUMENTS, these pass a
 * RECEIVER along, and conflating the two would read a `.filter()` predicate as class text.
 */
const RELAY_METHODS = new Set(["filter", "flat"]);

/**
 * Array methods that REPLACE each element with whatever their callback returns.
 *
 * The receiver's own strings are therefore NOT rendered — `["ghost"].map(() => "row")` renders
 * `row` and never `ghost` — so reading the receiver here would certify a dead `.ghost` rule as
 * live, the exact inverse of the bug this fix exists to close. The one exception is a callback
 * that hands the element straight back, which is how `.map((c) => c)` is used.
 */
const MAPPING_METHODS = new Set(["map", "flatMap"]);

/** Nodes that wrap a value without changing it: parentheses and the type-only TypeScript forms. */
function isTransparent(node: ts.Node): node is ts.ParenthesizedExpression | ts.AsExpression
  | ts.SatisfiesExpression | ts.NonNullExpression | ts.TypeAssertion {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node);
}

/** Strip those wrappers so a check on the node's KIND sees what the value actually is. */
function transparent(node: ts.Node | undefined): ts.Node | undefined {
  let inner = node;
  while (inner && isTransparent(inner)) inner = inner.expression;
  return inner;
}

/** An async or generator function wraps its return value, so the value is not what it maps to. */
function isWrappedResult(node: ts.ArrowFunction | ts.FunctionExpression): boolean {
  const asyncModifier = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  return Boolean(asyncModifier) || (!ts.isArrowFunction(node) && Boolean(node.asteriskToken));
}

export function classTokens(source: string, fileName = "input.tsx"): Set<string> {
  const out = new Set<string>();
  const add = (text: string) => {
    for (const token of text.split(/[\s,]+/)) {
      // A trailing hyphen is the STEM of a composed name — `driver-${id}` leaves `driver-`, which
      // no element ever carries. Counting it as rendered would let it vouch for a `.driver-` rule
      // that does not exist, and counting it as unstyled reports a class nothing renders.
      if (/^[a-z][a-z0-9_-]*$/i.test(token) && !token.endsWith("-")) out.add(token);
    }
  };

  /** Collect from an expression in a VALUE position — never from a predicate. */
  const fromValue = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) { add(node.text); return; }
    if (ts.isNoSubstitutionTemplateLiteral(node)) { add(node.text); return; }
    if (ts.isTemplateExpression(node)) {
      // The literal chunks are class text, and so is whatever each `${...}` evaluates to — that is
      // where `${mode === "parallel" ? "on" : ""}` puts a real class. Recursing through `fromValue`
      // keeps the arms and still drops the comparison, which a text scan could not tell apart.
      add(node.head.text);
      for (const span of node.templateSpans) { add(span.literal.text); fromValue(span.expression); }
      return;
    }
    if (isTransparent(node)) return fromValue(node.expression);
    if (ts.isConditionalExpression(node)) {
      // Both arms are values. The CONDITION is not, and that is the whole point.
      fromValue(node.whenTrue);
      fromValue(node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      // `+`, `||`, `??` and `&&` all yield one of their operands as the value. A comparison yields a
      // boolean, so neither side is ever class text.
      if (kind === ts.SyntaxKind.PlusToken || kind === ts.SyntaxKind.BarBarToken
        || kind === ts.SyntaxKind.QuestionQuestionToken) { fromValue(node.left); fromValue(node.right); return; }
      if (kind === ts.SyntaxKind.AmpersandAmpersandToken) { fromValue(node.right); return; }
      return;
    }
    if (ts.isArrayLiteralExpression(node)) { for (const element of node.elements) fromValue(element); return; }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      // `[...].join(" ")` and the class-composition helpers pass their arguments through.
      if (name === "join") { fromValue(callee as ts.Node); return; }
      const relays = RELAY_METHODS.has(name);
      const maps = MAPPING_METHODS.has(name);
      if ((relays || maps) && ts.isPropertyAccessExpression(callee)) {
        // Only the FIRST argument is the callback. `map`/`flatMap` take a `thisArg` second, and
        // reading that as class text would collect from something that never renders.
        const callback = maps ? transparent(node.arguments[0]) : undefined;
        // A relay passes its receiver's elements through, so keep reading down the chain — the
        // next link is another relay, an array literal, or nothing, each already handled.
        //
        // A mapping does NOT relay, however its callback is written. Deciding whether one hands
        // elements back means proving the parameter is the one returned, unshadowed, unreassigned
        // and not overridden by a later completion — and getting that wrong certifies dead CSS as
        // live, silently, because an over-collecting scan leaves the suite green.
        //
        // STATED LIMIT: this covers every pass-through, not only `(c) => c`. A callback returning
        // the element on SOME paths — `(c) => keep ? c : ""` — also loses the receiver's classes,
        // which are then reported as dead CSS. Nothing here pays that cost: the app has zero
        // identity mapping callbacks and zero className expressions using map or flatMap at all.
        // Under-reporting is recoverable by reading the failure; over-reporting is not, because
        // nothing fails.
        if (relays) fromValue(callee.expression);
        // A mapping CALLBACK BODY is class text: `names.map((n) => classFor(n))` writes the class
        // there and nowhere else. A `.filter()` PREDICATE is not — `c === "hidden"` names no class
        // it renders — and `.flat()` takes a depth, so only mapping callbacks are read and the
        // value-not-predicate rule stays intact.
        if (callback) fromCallbackResult(callback);
        return;
      }
      if (CLASS_HELPERS.has(name)) { for (const argument of node.arguments) fromValue(argument); return; }
      return;
    }
    if (ts.isPropertyAccessExpression(node)) return fromValue(node.expression);
    if (ts.isObjectLiteralExpression(node)) {
      // `clsx({ "is-on": enabled })` — the KEYS are the classes.
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.name)) add(property.name.text);
      }
    }
  };

  /** Collect from what a callback RETURNS — its concise body, or each `return` in its block. */
  const fromCallbackResult = (input: ts.Node): void => {
    const node = transparent(input);
    if (!node || (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node))) return;
    // An async or generator callback does not map to what it returns: the element becomes a promise
    // or an iterator, so `items.map(async () => "ghost")` renders neither `ghost` nor anything else
    // a class scan should believe.
    if (isWrappedResult(node)) return;
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) { fromValue(node.body); return; }
    const fromReturns = (inner: ts.Node): void => {
      // A nested function returns to its own caller, not to the `.map()`, so stop at its boundary.
      if (inner !== node.body && ts.isFunctionLike(inner)) return;
      if (ts.isReturnStatement(inner)) { if (inner.expression) fromValue(inner.expression); return; }
      ts.forEachChild(inner, fromReturns);
    };
    fromReturns(node.body);
  };

  const walk = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)
      && (node.name.text === "className" || node.name.text === "class")) {
      const value = node.initializer;
      if (value && ts.isStringLiteral(value)) add(value.text);
      else if (value && ts.isJsxExpression(value) && value.expression) fromValue(value.expression);
    }
    // `document.body.classList.toggle("shell-dock-dragging", dragging)` reaches the DOM exactly as a
    // JSX attribute does, and no text scan of `className=` could ever see it — so the live rule it
    // styles was being counted as dead.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const target = node.expression.expression;
      const onClassList = ts.isPropertyAccessExpression(target) && target.name.text === "classList";
      if (onClassList && (method === "add" || method === "remove" || method === "toggle" || method === "replace")) {
        for (const argument of node.arguments) if (ts.isStringLiteralLike(argument)) add(argument.text);
      }
    }
    // `element.className = "..."` and `element.className += " ..."`.
    if (ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left)
      && node.left.name.text === "className"
      && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)) {
      fromValue(node.right);
    }
    ts.forEachChild(node, walk);
  };

  walk(ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
  return out;
}

/**
 * Classes produced by helpers rather than written at a call site.
 *
 * An explicit inventory, because the alternative is either missing them (the previous version did)
 * or accepting every string in the file as a class (the version before that did). Each entry is
 * checked to still exist in the source, so a stale exemption fails rather than silently widening
 * the corpus.
 */
const HELPER_CLASSES = new Map<string, string>([
  // The usage chart's series slot classes come from `seriesClass()` in usage-view-model.ts, which
  // picks one literal per driver slot so a driver keeps its colour in every chart, legend, and row.
  ["usage-series-1", "usage-view-model.ts seriesClass"],
  ["usage-series-2", "usage-view-model.ts seriesClass"],
  ["usage-series-3", "usage-view-model.ts seriesClass"],
  ["usage-series-4", "usage-view-model.ts seriesClass"],
  ["usage-series-5", "usage-view-model.ts seriesClass"],
]);

/**
 * Classes emitted by a LIBRARY at runtime, which no scan of this repo can ever attribute.
 *
 * These are not debt and counting them as dead was wrong: `rehype-highlight` adds `hljs-*` tokens to
 * highlighted code fences and `remark-gfm` adds the task-list classes, both inside markdown this app
 * renders. The rules styling them are live; nothing here produces the names.
 *
 * Each entry names the dependency that emits it, and the test below fails if that dependency is
 * gone — so an exemption cannot outlive the reason for it.
 */
const LIBRARY_CLASSES = new Map([
  // highlight.js token scopes, by exact name rather than by `hljs-` prefix. A prefix would exempt
  // anything starting with it — an unused `.hljs-toolbar` rule added later would be hidden behind
  // "a library might emit it", which is the opposite of what an exemption is for.
  ["hljs-addition", "rehype-highlight"],
  ["hljs-attr", "rehype-highlight"],
  ["hljs-attribute", "rehype-highlight"],
  ["hljs-built_in", "rehype-highlight"],
  ["hljs-bullet", "rehype-highlight"],
  ["hljs-comment", "rehype-highlight"],
  ["hljs-deletion", "rehype-highlight"],
  ["hljs-doctag", "rehype-highlight"],
  ["hljs-emphasis", "rehype-highlight"],
  ["hljs-keyword", "rehype-highlight"],
  ["hljs-link", "rehype-highlight"],
  ["hljs-literal", "rehype-highlight"],
  ["hljs-meta", "rehype-highlight"],
  ["hljs-name", "rehype-highlight"],
  ["hljs-number", "rehype-highlight"],
  ["hljs-quote", "rehype-highlight"],
  ["hljs-regexp", "rehype-highlight"],
  ["hljs-section", "rehype-highlight"],
  ["hljs-selector-class", "rehype-highlight"],
  ["hljs-selector-id", "rehype-highlight"],
  ["hljs-selector-tag", "rehype-highlight"],
  ["hljs-string", "rehype-highlight"],
  ["hljs-strong", "rehype-highlight"],
  ["hljs-symbol", "rehype-highlight"],
  ["hljs-template-tag", "rehype-highlight"],
  ["hljs-template-variable", "rehype-highlight"],
  ["hljs-title", "rehype-highlight"],
  ["hljs-type", "rehype-highlight"],
  ["hljs-variable", "rehype-highlight"],
  ["function_", "rehype-highlight"],
  // remark-gfm's task lists.
  ["contains-task-list", "remark-gfm"],
  ["task-list-item", "remark-gfm"],
]);

const emittedByLibrary = (name: string) => LIBRARY_CLASSES.has(name);

test("every library-class exemption still has a library behind it", () => {
  // An exemption whose dependency is gone is a hole, not an exemption.
  const manifest = JSON.parse(readFileSync(join(WEB, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const installed = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
  for (const [name, dependency] of LIBRARY_CLASSES) {
    assert.ok(installed.has(dependency),
      `${name} is exempted because ${dependency} emits it, and ${dependency} is no longer a dependency`);
    // And the exemption must still be doing something: a name nothing styles is a stale entry, not
    // a protected one, and leaving it here would quietly exempt it again if a rule came back.
    assert.ok(STYLED.has(name), `${name} is exempted but nothing styles it; drop the entry`);
  }
});

test("the library exemption matches names, not namespaces", () => {
  // Exact names only. A `hljs-` prefix would exempt anything starting with it, so an unused
  // `.hljs-toolbar` rule added later would be hidden behind "a library might emit it" — which is
  // the direction that lets dead CSS accumulate invisibly.
  assert.equal(emittedByLibrary("hljs-keyword"), true, "a token highlight.js really emits");
  assert.equal(emittedByLibrary("hljs-toolbar"), false, "not a highlight.js token, so not exempt");
  assert.equal(emittedByLibrary("hljs-"), false);
  assert.equal(emittedByLibrary("task-list-item"), true);
  assert.equal(emittedByLibrary("task-list-item-extra"), false);
  assert.equal(emittedByLibrary("empty"), false, "an ordinary app class is never exempt");
});

/**
 * Why a selector list is invalid, or null if it is fine.
 *
 * Counting openers against closers is not enough and fails in both directions: `:is(h2]` balances
 * one against one and is still rejected by the browser, while a valid `[title="a,b)"]` would be
 * called broken by a counter that cannot see quoting. So this is a stack that tracks WHICH
 * delimiter is open, respects escapes and quoted strings, and only treats a comma as a member
 * boundary at depth zero.
 *
 * The stakes are that an invalid selector list silently disables its ENTIRE rule — live members
 * included — and neither of the tools in this pipeline can see it. Browsers drop the rule without a
 * word, and postcss keeps the prelude as opaque text without validating selector grammar.
 */
export function malformedSelector(selector: string): string | null {
  const closerFor: Record<string, string> = { "(": ")", "[": "]" };
  const stack: string[] = [];
  let quote: string | null = null;
  let escaped = false;
  let members = 1;
  let currentHasContent = false;

  for (const ch of selector) {
    if (escaped) { escaped = false; currentHasContent = true; continue; }
    if (ch === "\\") { escaped = true; continue; }

    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; currentHasContent = true; continue; }

    if (ch === "(" || ch === "[") { stack.push(closerFor[ch]!); currentHasContent = true; continue; }
    if (ch === ")" || ch === "]") {
      const expected = stack.pop();
      if (expected === undefined) return `unexpected "${ch}"`;
      if (expected !== ch) return `expected "${expected}" but found "${ch}"`;
      currentHasContent = true;
      continue;
    }
    if (ch === "," && stack.length === 0) {
      if (!currentHasContent) return "empty selector member";
      members += 1;
      currentHasContent = false;
      continue;
    }
    if (!/\s/.test(ch)) currentHasContent = true;
  }

  if (escaped) return "trailing escape";
  if (quote) return `unterminated ${quote} string`;
  if (stack.length) return `unclosed "${stack[stack.length - 1] === ")" ? "(" : "["}"`;
  if (!currentHasContent) return "empty selector member";
  return members > 0 ? null : "no selector members";
}

test("a selector list is never left malformed", () => {
  // An invalid selector list disables everything else in its rule. A purge that split `:is(h2, h3)`
  // on its inner comma produced exactly that, and every other test here stayed green.
  const malformed: string[] = [];
  root.walkRules((rule) => {
    const why = malformedSelector(rule.selector);
    if (why) malformed.push(`${why} in: ${rule.selector.replace(/\s+/g, " ").trim()}`);
  });
  assert.deepEqual(malformed, [],
    "an invalid selector member silently disables everything else in its rule");
});

test("the selector check reads grammar, not delimiter counts", () => {
  // On synthetic input, because the corpus is currently clean — a check that has only ever seen
  // valid selectors has not been tested, only run.
  for (const valid of [
    ".a",
    ".a, .b",
    ".runner-id h2,\n.runner-card .runner-id:is(h2)",
    ".x:is(h2, h3)",
    ".y:not(.a, .b) > .c",
    '[title="a,b)"]',
    "[data-x='(']",
    ".availability-runner\\:offline",
    ".a:nth-child( 2 )",
  ]) {
    assert.equal(malformedSelector(valid), null, `rejected valid selector: ${valid}`);
  }

  // The count-based version passed the first two of these, which is why it is gone.
  for (const invalid of [
    ".runner-card .runner-id:is(h2]",
    ".a:is(h2)) , .b",
    ".runner-id h2,\nh3)",
    ".a:is(h2",
    ".a, , .b",
    ".a,",
    ",.a",
    '.a[title="unterminated',
  ]) {
    assert.notEqual(malformedSelector(invalid), null, `accepted invalid selector: ${invalid}`);
  }
});

/** Complete CSS class identifiers — underscores and escapes included. */
export function cssClasses(selector: string): string[] {
  return [...selector.matchAll(/\.((?:[A-Za-z_-]|\\.)(?:[\w-]|\\.)*)/g)].map((match) => match[1]!);
}

const STYLED = (() => {
  const styled = new Set<string>();
  root.walkRules((rule) => { for (const name of cssClasses(rule.selector)) styled.add(name); });
  return styled;
})();

const RENDERED = (() => {
  const rendered = new Set<string>();
  for (const path of sourceFiles(join(WEB, "src"))) {
    for (const token of classTokens(readFileSync(path, "utf8"))) rendered.add(token);
  }
  return rendered;
})();

/*
 * Both class directions are non-zero, for reasons that are not the same, and both are recorded by
 * identity in `stylesheet-debt.json` rather than by count.
 *
 * A static scan cannot resolve a COMPOSED class: `status-${state}`, `agent-${provider}` and
 * `col-${id}` reach the DOM as real names and the stem matches nothing. So the dead list mixes
 * genuinely dead CSS — §F4's `.field-label` and `.input` were exactly that — with names this check
 * cannot see. The unstyled list includes classes that legitimately carry no CSS, such as inert
 * query hooks like `ui-row-nav`.
 *
 * Dead classes rose to 234 when the class scan moved to the TypeScript AST, and that rise is the
 * measure of the previous version's error: every string inside a `className={...}` expression was
 * being taken as a class, so a comparison operand like `mode === "parallel"` certified a `.parallel`
 * rule as rendered. Unstyled fell to 34 for the same reason, in the other direction.
 */

test("the helper-class inventory is not stale", () => {
  const sources = sourceFiles(join(WEB, "src")).map((path) => readFileSync(path, "utf8"));
  for (const [name, where] of HELPER_CLASSES) {
    assert.ok(sources.some((source) => source.includes(name)),
      `${name} is listed as helper-produced (${where}) but no longer appears in the source`);
  }
});

test("the class scan reports both directions", () => {
  // Not an assertion on the totals — `no debt is added` owns enforcement, by identity. This exists
  // so a reader of a failing run can see the size of each list without opening the JSON.
  const debt = measureDebt();
  assert.ok(debt.deadClasses.length > 0 && debt.unstyledClasses.length > 0,
    "reporting zero in either direction would mean the scan stopped seeing the corpus");
  console.log(`      ${debt.deadClasses.length} styled-but-unrendered, ${debt.unstyledClasses.length} rendered-but-unstyled`);
});

/**
 * The helpers, on synthetic input.
 *
 * Every defect round two found was invisible to a check run only against the current corpus: the
 * corpus happened not to contain a commented `var()`, a conditional className, or an underscored
 * selector, so the helpers were fitted rather than tested. These are the inputs that would have
 * caught all six.
 */
test("varReads sees through comments, whitespace and nesting", () => {
  assert.deepEqual(varReads("var(--a)"), [{ name: "--a", fallback: null }]);
  assert.deepEqual(varReads("color: var(/* typo */ --font-ui)"), [{ name: "--font-ui", fallback: null }]);
  assert.deepEqual(varReads("var( --keyboard-inset )"), [{ name: "--keyboard-inset", fallback: null }]);
  assert.deepEqual(varReads("calc(100dvh - var(--keyboard-inset, 0px))"),
    [{ name: "--keyboard-inset", fallback: "0px" }]);
  // A nested var() inside a fallback belongs to the fallback, not to the outer call's argument list.
  assert.deepEqual(varReads("var(--a, var(--b, 2px))"),
    [{ name: "--a", fallback: "var(--b, 2px)" }, { name: "--b", fallback: "2px" }]);
});

test("cssClasses keeps whole identifiers", () => {
  assert.deepEqual(cssClasses(".availability-runner_offline"), ["availability-runner_offline"]);
  assert.deepEqual(cssClasses(".hljs-title.function_"), ["hljs-title", "function_"]);
  assert.deepEqual(cssClasses(".a .b > .c"), ["a", "b", "c"]);
});

test("classTokens reads class contexts and not prose", () => {
  assert.deepEqual([...classTokens('<input type="checkbox" />')], []);
  assert.deepEqual([...classTokens('<div className="card" />')], ["card"]);
  assert.deepEqual([...classTokens('<div className={readOnly ? "is-readonly" : "is-live"} />')],
    ["is-readonly", "is-live"]);
  assert.deepEqual([...classTokens("<div className={`row ${kind}`} />")], ["row"]);
});

test("classTokens takes values and refuses predicates", () => {
  // A comparison operand can never become class output, and taking it as one is FALSE EVIDENCE:
  // `mode === "parallel"` recorded `parallel`, which certifies a dead `.parallel` rule as rendered.
  assert.deepEqual([...classTokens('<b className={`preset ${mode === "parallel" ? "on" : ""}`} />')],
    ["preset", "on"]);
  assert.deepEqual([...classTokens('<b className={kind === "secondary" ? "card" : "card"} />')], ["card"]);
  assert.deepEqual([...classTokens('<b className={enabled && "is-on"} />')], ["is-on"]);
  assert.deepEqual([...classTokens('<b className={label ?? "untitled-row"} />')], ["untitled-row"]);
  assert.deepEqual([...classTokens('<b className={clsx("row", { "is-on": enabled })} />')], ["row", "is-on"]);
  assert.deepEqual([...classTokens('<b className={["row", "is-on"].join(" ")} />')], ["row", "is-on"]);
});

test("classTokens never takes a mapped-away element as a rendered class", () => {
  // A mapping REPLACES each element, so the receiver's strings do not render and reading them
  // would certify a dead rule as live — silently, because the suite stays green.
  assert.deepEqual([...classTokens('<b className={["ghost"].map(() => "row").join(" ")} />')], ["row"]);
  assert.deepEqual([...classTokens('<b className={["ghost"].flatMap(() => ["row"]).join(" ")} />')], ["row"]);
  // STATED LIMIT: this holds even for an identity mapping, so `["row"].map((c) => c)` reports
  // nothing. Recognising identity means proving the parameter is returned unshadowed,
  // unreassigned and not overridden by a later completion, and every wrong answer there
  // certifies dead CSS as live. Nothing here writes one: the app has zero identity mapping
  // callbacks and zero className expressions using map at all. A limit that under-reports is
  // worth more than reasoning that can silently over-report.
  assert.deepEqual([...classTokens('<b className={["row"].map((c) => c).join(" ")} />')], []);
  // The callback RESULT is still read, which is where a mapping writes its classes.
  assert.deepEqual([...classTokens('<b className={kinds.map((k) => k ? "is-on" : "is-off").join(" ")} />')],
    ["is-on", "is-off"]);
  // The second argument is a `thisArg`, not another callback.
  assert.deepEqual(
    [...classTokens('<b className={["x"].map((c) => "row", function () { return "ghost"; }).join(" ")} />')],
    ["row"]);
  // An async callback maps to a promise and a generator to an iterator, so neither return renders.
  assert.deepEqual([...classTokens('<b className={items.map(async () => "ghost").join(" ")} />')], []);
  assert.deepEqual([...classTokens('<b className={items.map(function* () { return "ghost"; }).join(" ")} />')], []);
});

test("classTokens sees through wrappers that do not change a value", () => {
  // `as`, `satisfies`, `!` and parentheses are type-level or grouping only. A scan that stops at
  // them reports a rendered class as dead, which is the failure this whole relay fix addresses.
  assert.deepEqual([...classTokens('<b className={["row"].filter(Boolean).join(" ") as string} />')], ["row"]);
  assert.deepEqual([...classTokens('<b className={kinds.map((k) => "is-on" as const).join(" ")} />')], ["is-on"]);
  assert.deepEqual([...classTokens('<b className={kinds.map((k) => "is-on" satisfies string).join(" ")} />')], ["is-on"]);
  // A literal under the wrapper, so removing the non-null branch changes the RESULT, not just the
  // route to it — an assertion that reads the same either way pins nothing.
  assert.deepEqual([...classTokens('<b className={kinds.map((k) => "is-on"!).join(" ")} />')], ["is-on"]);
  // `<string>x` is a type assertion only outside TSX, where the same text is a JSX element. A
  // non-JSX file reaches the DOM by assigning className, which is a context the scanner reads.
  assert.deepEqual(
    [...classTokens('el.className = ["row"].filter(Boolean).join(" ") as string;', "input.ts")], ["row"]);
  assert.deepEqual([...classTokens('el.className = <string>"is-on";', "input.ts")], ["is-on"]);
  // A wrapper around the CALLBACK itself must not stop it being recognised as one.
  assert.deepEqual([...classTokens('<b className={kinds.map(((k) => "is-on")).join(" ")} />')], ["is-on"]);
});

test("classTokens reads through array methods that relay class text", () => {
  // A chained `.join()` has to yield what a direct one yields. It did not: the `.join()` reader
  // followed exactly one link, so `.filter(Boolean)` in between made every class in the expression
  // look like dead CSS — the single most common way this app builds a className.
  const direct = [...classTokens('<b className={["row", on ? "is-on" : ""].join(" ")} />')];
  assert.deepEqual(direct, ["row", "is-on"]);
  assert.deepEqual([...classTokens('<b className={["row", on ? "is-on" : ""].filter(Boolean).join(" ")} />')],
    direct);
  assert.deepEqual([...classTokens('<b className={["row", ["is-on"]].flat().join(" ")} />')], direct);
  // More than one link deep, in either order.
  assert.deepEqual([...classTokens('<b className={["row", ["is-on"]].flat().filter(Boolean).join(" ")} />')],
    direct);
  // A mapping callback is where the class is written when the receiver holds data, not names.
  assert.deepEqual([...classTokens('<b className={kinds.map((k) => k === "warn" ? "is-warn" : "is-calm").join(" ")} />')],
    ["is-warn", "is-calm"]);
  assert.deepEqual([...classTokens('<b className={kinds.map((k) => { if (k) { return "is-on"; } return "is-off"; }).join(" ")} />')],
    ["is-on", "is-off"]);
  assert.deepEqual([...classTokens('<b className={kinds.flatMap((k) => ["cell", k.wide ? "is-wide" : ""]).join(" ")} />')],
    ["cell", "is-wide"]);
  // The stem rule still holds through a relay: `driver-${id}` leaves `driver-`, which nothing renders.
  assert.deepEqual([...classTokens('<b className={ids.map((id) => `driver-${id}`).join(" ")} />')], []);
  // A bare `map(...)` is not an array relay, and reading its receiver would be reading nothing.
  assert.deepEqual([...classTokens('<b className={map("row").join(" ")} />')], []);
});

test("classTokens refuses a filter predicate", () => {
  // Reading through `.filter()` must stay a read of its RECEIVER. Its PREDICATE decides which
  // classes survive; it does not name one. Taking `c === "hidden"` as class text would certify a
  // dead `.hidden` rule as rendered — the same false evidence a comparison operand gives anywhere.
  assert.deepEqual([...classTokens('<b className={["row"].filter((c) => c === "hidden").join(" ")} />')], ["row"]);
  assert.deepEqual([...classTokens('<b className={["row"].filter((c) => c.startsWith("is-live")).join(" ")} />')],
    ["row"]);
  // The two above pass even if the predicate IS read, because `fromValue` already drops a
  // comparison and a call. This one does not: `||` yields an operand, so `fromValue` would take
  // "ghost" as class text. It is the case that tells a receiver-only read from an argument read.
  assert.deepEqual([...classTokens('<b className={["row"].filter((c) => c || "ghost").join(" ")} />')], ["row"]);
});

test("classTokens sees producers that never touch a className attribute", () => {
  // `shell-dock-dragging` is applied through `document.body.classList` and its live rules were being
  // counted as dead, because no scan of `className=` could ever reach it.
  assert.deepEqual([...classTokens('document.body.classList.toggle("shell-dock-dragging", dragging);', "a.ts")],
    ["shell-dock-dragging"]);
  assert.deepEqual([...classTokens('node.classList.add("is-live");', "a.ts")], ["is-live"]);
  assert.deepEqual([...classTokens('el.className = "board-wrap";', "a.ts")], ["board-wrap"]);
  // Not a class producer, and never was: a query selector describes what is already there.
  assert.deepEqual([...classTokens('root.querySelector(".ui-row-nav");', "a.ts")], []);
});

test("numericLiterals reads through tokens and keeps the sign", () => {
  // Discarding a whole value because it mentioned `var()` made both of these free.
  assert.deepEqual(numericLiterals("calc(var(--z-popover) + 999)"), ["999"]);
  assert.deepEqual(numericLiterals("var(--radius) 7px"), ["7"]);
  assert.deepEqual(numericLiterals("-999"), ["-999"]);
  assert.deepEqual(numericLiterals("calc(var(--text-base) + 2px)"), ["2"]);
  // A token whose NAME carries a digit is an identifier, not a quantity.
  assert.deepEqual(numericLiterals("var(--bg-elev-2)"), []);
});

test("canonicalSelector and selectorMembers compare on what the browser matches", () => {
  assert.equal(canonicalSelector("[data-x]>button"), canonicalSelector("[data-x] > button"));
  assert.equal(canonicalSelector("td:nth-child( 2 )"), canonicalSelector("td:nth-child(2)"));
  assert.equal(canonicalSelector(".a  .b"), ".a .b");
  assert.notEqual(canonicalSelector(".a .b"), canonicalSelector(".a>.b"));
  assert.deepEqual(selectorMembers("[data-x], [data-y]"), ["[data-x]", "[data-y]"]);
  assert.deepEqual(selectorMembers(":where(.a, .b) > *, :not(button, select):focus"),
    [":where(.a,.b)>*", ":not(button,select):focus"]);
});

test("a shadowed declaration is counted, and grouped authoring is not", () => {
  const shadow = postcss.parse("[data-x]>button { color: red } [data-x] > button { color: blue }");
  const counts = new Map<string, number>();
  shadow.walkRules((rule) => {
    for (const member of selectorMembers(rule.selector)) {
      for (const node of rule.nodes) {
        if (node.type !== "decl") continue;
        const key = `|${member}|${node.prop}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  });
  assert.deepEqual([...counts.values()], [2],
    "two spellings of one selector setting one property is one shadowed declaration");

  const grouped = postcss.parse(".app-rail { padding: 4px } .app-rail { gap: 2px }");
  const groupedCounts = new Map<string, number>();
  grouped.walkRules((rule) => {
    for (const member of selectorMembers(rule.selector)) {
      for (const node of rule.nodes) {
        if (node.type !== "decl") continue;
        const key = `|${member}|${node.prop}`;
        groupedCounts.set(key, (groupedCounts.get(key) ?? 0) + 1);
      }
    }
  });
  assert.deepEqual([...groupedCounts.values()], [1, 1],
    "the same selector setting DIFFERENT properties shadows nothing");
});

test("contextKey carries the whole ancestry", () => {
  const nested = postcss.parse(
    "@media (width > 40em) { .host-a { @scope (.panel) { .item { color: red } } } " +
    ".host-b { @scope (.panel) { .item { color: blue } } } }",
  );
  const keys: string[] = [];
  nested.walkRules((rule) => { if (rule.selector === ".item") keys.push(contextKey(rule)); });
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1], "two different hosts are not one duplicated selector");
});

test("numericLiterals counts every literal in a value", () => {
  assert.deepEqual(numericLiterals("12px"), ["12"]);
  assert.deepEqual(numericLiterals("clamp(12px, 5vw, 20px)"), ["12", "5", "20"]);
  assert.deepEqual(numericLiterals("7px 7px 0 0"), ["7", "7", "0", "0"]);
  assert.deepEqual(numericLiterals("var(--radius)"), []);
});

/**
 * The design-system rules, on synthetic input, through the same assertion the real inventory uses.
 *
 * Each case starts from a clean rule or component, records its (empty) inventory, adds ONE
 * violation, and requires the ratchet to fail with a message naming the rule and what to use
 * instead. A rule only ever run against `styles.css` would pass for a scanner that sees nothing.
 */
const CLEAN_RULE = ".clean { display: flex; gap: var(--space-2); padding: var(--space-3); font-family: var(--font-mono); }";
const cssDebtOf = (sheet: string) => cssRuleDebt(postcss.parse(sheet)) as unknown as Record<string, string[]>;
const failsNaming = (...parts: string[]) => (error: unknown) => {
  assert.ok(error instanceof Error);
  for (const part of parts) assert.ok(error.message.includes(part), `expected "${part}" in: ${error.message}`);
  return true;
};

test("each style rule fails a clean rule that breaks it, naming the rule and its replacement", () => {
  const recorded = cssDebtOf(CLEAN_RULE);
  assert.doesNotThrow(() => assertInventoryMatches(recorded, cssDebtOf(CLEAN_RULE)));
  const cases: [addition: string, key: string, ...message: string[]][] = [
    ["text-transform: uppercase", "textTransform", "Title Case", "§17.1"],
    ["gap: 6px", "gapLiterals", "--space-*", "§2.4"],
    ["padding: 10px", "paddingLiterals", "--space-*", "§2.4"],
    ['font-family: "Cascadia Code", monospace', "monoStacks", "var(--font-mono)"],
    ["justify-content: flex-end; overflow-x: auto", "flexEndOverflow", "margin-inline-start: auto"],
    ["font-size: 13px", "fontSizeLiterals", "--text-*"],
    ["border-radius: 6px", "radiusLiterals", "--radius-*"],
  ];
  for (const [addition, key, ...message] of cases) {
    const measured = cssDebtOf(CLEAN_RULE.replace(" }", ` ${addition}; }`));
    assert.throws(() => assertInventoryMatches(recorded, measured),
      failsNaming(`${key}: new debt`, ...message), `${addition} must fail ${key}`);
  }
});

test("the ratchet checks identity and multiplicity, not totals", () => {
  const recorded = cssDebtOf(".a { gap: 6px; padding: 6px; } .b { color: red; }");
  // Paying one literal while adding another elsewhere leaves every total unchanged, and still fails.
  const traded = cssDebtOf(".a { gap: var(--space-2); padding: 6px; } .b { color: red; gap: 8px; }");
  assert.equal(traded.gapLiterals!.length, recorded.gapLiterals!.length);
  assert.throws(() => assertInventoryMatches(recorded, traded), failsNaming("gapLiterals: new debt"));
  // A recorded identity vouches for one literal, not for every copy of it.
  const doubled = cssDebtOf(".a { gap: 6px; padding: 6px 6px; } .b { color: red; }");
  assert.throws(() => assertInventoryMatches(recorded, doubled), failsNaming("paddingLiterals: new debt"));
  // Paying debt without regenerating fails with the regenerate instruction.
  const paid = cssDebtOf(".a { gap: var(--space-2); padding: 6px; } .b { color: red; }");
  assert.throws(() => assertInventoryMatches(recorded, paid),
    failsNaming("gapLiterals: 1 entries are recorded but no longer present", "regenerate stylesheet-debt.json in this commit"));
  // Deleting an inventory's key does not switch its check off.
  const withoutGap = { ...recorded };
  delete withoutGap.gapLiterals;
  assert.throws(() => assertInventoryMatches(withoutGap, recorded), failsNaming("stylesheet-debt.json has no gapLiterals"));
});

test("the literal rules read px sizes only, and read them wherever they sit in a value", () => {
  assert.deepEqual(pxLiterals("6px 10px"), ["6px", "10px"]);
  assert.deepEqual(pxLiterals("0 0px 4px"), ["4px"], "zero is not a size choice");
  assert.deepEqual(pxLiterals("calc(var(--space-2) + 1px)"), ["1px"]);
  assert.deepEqual(pxLiterals("var(--space-2, 8px)"), ["8px"], "a fallback literal is still a literal");
  assert.deepEqual(pxLiterals("-2px"), ["-2px"]);
  assert.deepEqual(pxLiterals("var(--space-12) 1.5rem 2em 10%"), [], "token names and other units are not px");
  assert.deepEqual(pxLiterals("/* 6px */ var(--space-2)"), [], "a comment is not a value");
  const debt = cssDebtOf(".x { padding-inline: 6px; padding-block-start: 3px; row-gap: 2px; grid-gap: 5px; " +
    "margin: 7px; --local-pad: 9px; }");
  assert.deepEqual(debt.paddingLiterals, ["|.x|padding-block-start|3px", "|.x|padding-inline|6px"]);
  assert.deepEqual(debt.gapLiterals, ["|.x|grid-gap|5px", "|.x|row-gap|2px"],
    "margin and custom-property declarations are outside these two rules");
});

test("text-transform reports every value except none", () => {
  const debt = cssDebtOf(".a { text-transform: none; } .b { text-transform: capitalize; } .c { TEXT-TRANSFORM: Uppercase; }");
  assert.deepEqual(debt.textTransform, ["|.b|text-transform|capitalize", "|.c|text-transform|Uppercase"]);
});

test("the mono-stack rule exempts only the two font tokens and reads only styles.css", () => {
  const debt = cssDebtOf(":root { --font-mono: \"Cascadia Code\", ui-monospace, monospace; " +
    "--font-terminal: \"JetBrainsMono Nerd Font\", monospace; --font-ui: system-ui, sans-serif; " +
    "--code-font: Consolas, monospace; } " +
    ".token { font-family: var(--font-mono); } .kbd { font: 9px \"Cascadia Code\", Consolas, monospace; } " +
    ".sf { font-family: SFMono-Regular, Menlo; } .ui { font-family: var(--font-ui); }");
  assert.deepEqual(debt.monoStacks, [
    "|.kbd|font|9px \"Cascadia Code\", Consolas, monospace",
    "|.sf|font-family|SFMono-Regular, Menlo",
    "|:root|--code-font|Consolas, monospace",
  ]);
  for (const face of ["\"FiraCode Nerd Font\"", "\"Fira Code\"", "Inconsolata", "\"JetBrainsMono Nerd Font\"",
    "\"Iosevka Term\"", "Hack", "\"Roboto Mono\"", "\"SF Mono\"", "SFMono-Regular"]) {
    assert.equal(namesMonospaceFamily(face), true, face);
  }
  for (const face of ["var(--font-mono)", "system-ui, sans-serif", "Monotype Corsiva", "Hackney"]) {
    assert.equal(namesMonospaceFamily(face), false, face);
  }
  // The TypeScript xterm stack in terminal-font.ts is out of scope by construction: the rule takes a
  // parsed stylesheet, and the production guard hands it styles.css and nothing else.
  assert.ok(RECORDED.monoStacks.every((identity) => !identity.includes("terminal-font")));
});

test("flex-end with horizontal overflow is reported per rule, and the safe keyword is not", () => {
  const debt = cssDebtOf(".a { justify-content: end; overflow: auto hidden; } .b { justify-content: safe flex-end; overflow-x: auto; } " +
    ".c { justify-content: flex-end; overflow-x: hidden; } .d { justify-content: flex-end; } .d { overflow-x: scroll; } " +
    ".e { justify-content: flex-end; overflow: scroll; } .f { justify-content: flex-end; overflow: hidden auto; }");
  // `.f` scrolls vertically only: the shorthand's first value is overflow-x.
  assert.deepEqual(debt.flexEndOverflow, [
    "|.a|justify-content: end|overflow: auto hidden",
    "|.e|justify-content: flex-end|overflow: scroll",
  ]);
});

test("window.confirm fails in a clean component, naming the dialog to use instead", () => {
  const clean = "export function A() { const { confirm } = useFeedback(); " +
    "return <button onClick={async () => { if (await confirm({ title: \"Delete Key\" })) remove(); }}>Delete Key</button>; }";
  assert.deepEqual(nativeConfirmReferences(clean, "A.tsx"), []);
  assert.doesNotThrow(() => assertNoNativeConfirm(nativeConfirmReferences(clean, "A.tsx")));
  for (const call of ["window.confirm(\"Delete?\")", "globalThis.confirm(\"Delete?\")", "window[\"confirm\"](\"Delete?\")"]) {
    const found = nativeConfirmReferences(clean.replace("remove();", `remove(); ${call};`), "A.tsx");
    assert.equal(found.length, 1, call);
    assert.throws(() => assertNoNativeConfirm(found), failsNaming("window.confirm", "confirmation dialog", "§7.4"));
  }
  // A bare call reaches the global unless an enclosing scope rebinds `confirm`.
  assert.equal(nativeConfirmReferences("export const ok = () => confirm(\"Sure?\");", "b.ts").length, 1);
  assert.equal(nativeConfirmReferences("const { confirm: ask } = f(); ask(); confirm(\"Sure?\");", "c.ts").length, 1);
  // A binding in one component does not vouch for a bare call in another component of the file.
  assert.deepEqual(nativeConfirmReferences("function panel() { const { confirm } = useFeedback(); confirm({}); }\n" +
    "export const accidental = () => confirm(\"Delete?\");", "e.tsx"), ["e.tsx:2: confirm(\"Delete?\")"]);
  assert.deepEqual(nativeConfirmReferences("function a() { if (x) { const { confirm } = useFeedback(); } confirm(\"y\"); }", "f.ts"),
    ["f.ts:1: confirm(\"y\")"], "a block-scoped binding ends with its block");
  for (const shadowed of [
    "function a() { if (x) { var { confirm } = useFeedback(); } confirm(\"y\"); }",
    "const run = (confirm: Ask) => confirm(\"y\");",
    "import { confirm } from \"./ask\"; confirm(\"y\");",
    "function a() { confirm(\"y\"); function confirm(t: string) { return t; } }",
    "try { f(); } catch (confirm) { confirm(\"y\"); }",
    "const run = function confirm(n: number): number { return n ? confirm(n - 1) : 0; };",
  ]) assert.deepEqual(nativeConfirmReferences(shadowed, "g.ts"), [], shadowed);
  // A named function expression's name is not visible outside it.
  assert.equal(nativeConfirmReferences("const run = function confirm() { return 1; }; confirm(\"y\");", "h.ts").length, 1);
  // A body `var` is not visible in a parameter default, which runs first.
  assert.equal(nativeConfirmReferences("function f(x = confirm(\"y\")) { var confirm = () => true; }", "i.ts").length, 1);
  // Destructuring the native confirm out of a global is a reference to it, however it is renamed.
  for (const extracted of [
    "const { confirm } = window; confirm(\"Delete?\");",
    "const { confirm: ask } = globalThis; ask(\"Delete?\");",
    "const { \"confirm\": ask } = self as Window; ask(\"Delete?\");",
  ]) assert.equal(nativeConfirmReferences(extracted, "j.ts").length, 1, extracted);
  // Text that merely mentions it is not a call.
  assert.deepEqual(nativeConfirmReferences("// window.confirm(\"x\")\nconst s = \"window.confirm\";", "d.ts"), []);
});

test("an emoji in a clean component fails, and glyphs, comments and escapes are read correctly", () => {
  const clean = "export function A() { return <span title=\"Done\">Done</span>; }";
  const recorded = { emojiLiterals: emojiLiterals(clean, "A.tsx") };
  assert.deepEqual(recorded.emojiLiterals, []);
  for (const component of [
    "export function A() { return <span title=\"Done\">Done ✅</span>; }",
    "export function A() { return <span title=\"⚠ Done\">Done</span>; }",
    "export function A() { return <span title={`Done ${n} 🔐`}>Done</span>; }",
    "export function A() { return <span title=\"Done\">{\"\\u2705\"}</span>; }",
    // JSX character references render as the character, so they are read as it.
    "export function A() { return <span title=\"Done\">Locked &#x1F512;</span>; }",
    "export function A() { return <span title=\"&#128274; Locked\">Done</span>; }",
    "export function A() { return <span title=\"Done\">&hearts; Done</span>; }",
  ]) {
    const measured = { emojiLiterals: emojiLiterals(component, "A.tsx") };
    assert.equal(measured.emojiLiterals.length, 1, component);
    assert.throws(() => assertInventoryMatches(recorded, measured),
      failsNaming("emojiLiterals: new debt", "components/Icons.tsx", "§18"));
  }
  assert.deepEqual(emojiLiterals("export const A = () => <span>Saved ✓ ✕ ×</span>;", "A.tsx"), [],
    "text glyphs are §18's area work, not the emoji rule");
  assert.deepEqual(emojiLiterals("// ✅ done\nexport const A = 1; /* 🔐 */", "a.ts"), []);
  // Only JSX decodes references; in an ordinary string `&#x1F512;` is nine plain characters.
  assert.deepEqual(emojiLiterals("export const label = \"&#x1F512;\";", "a.ts"), []);
  assert.equal(decodeJsxEntities("Save &amp; Close &nope; &#x1F512;"), "Save & Close &nope; 🔒");
  assert.deepEqual(emojiLiterals("export const A = () => <b>  Thinking\n  💭  </b>;", "A.tsx"), ["A.tsx|💭|Thinking 💭"]);
});

test("an icon sized off the scale fails, naming the rule and §18, and a stale exemption fails", () => {
  const sizesOf = (sheet: string) => offScaleIconSizes(postcss.parse(sheet));
  const clean = ":root { --icon: 16px; --icon-lg: 20px; --pad: 6px; }\n" +
    ".notice-icon svg { width: var(--icon); height: var(--icon); }\n.big svg { width: var(--missing, var(--icon-lg)); }\n" +
    ".state-icon svg { width: 24px; height: 24px; }\n.menu-icon, .menu-icon svg { width: 20px; }\n" +
    ".usage-chart-svg { height: 260px; }\n.qr svg { width: 100%; height: auto; }\n" +
    ".row:has(> svg) { height: 36px; }\n.icon-btn:not(svg) { width: 36px; }\n.app-icon-tile { width: 40px; }\n" +
    // Filters and attribute values name an icon without making it the subject.
    ".row:has(:is(svg, .app-icon)) { width: 36px; }\n.x[data-label=\".app-icon\"] { width: 36px; }\n" +
    ".x:is(.a, .b):not(.app-icon) { height: 36px; }\n.x svg:hover { width: var(--icon-sm); }\n" +
    // Strings and escapes do not end a compound or a member early.
    "svg[data-label=\"6\\\" screen\"] .label { width: 18px; }\n.a[title=\"x, .app-icon\"] { width: 36px; }\n" +
    // Nested rules whose subject is not the icon: a descendant of it, or an ancestor-qualified parent.
    ".app-icon { & .label { width: 36px; } }\n.bar { .app-icon & { width: 36px; } }";
  assert.deepEqual(sizesOf(clean), []);
  assert.doesNotThrow(() => assertIconSizesOnScale(sizesOf(clean), new Map()));
  for (const [rule, key] of [
    [".access-section-title > .app-icon { width: 18px; }", "|.access-section-title>.app-icon"],
    ["@media (max-width: 760px) { .session-header-action svg { height: 15px; } }", "@media (max-width: 760px)|.session-header-action svg"],
    [".a, .b svg:hover { min-width: calc(var(--icon) + 2px); }", "|.a,.b svg:hover"],
    [".bar :is(.x, svg) { inline-size: 18px; }", "|.bar :is(.x,svg)"],
    [".rail .app-icon.active { max-height: 26px; }", "|.rail .app-icon.active"],
    // Every :is() in the subject offers alternatives, not only the first.
    [":is(.active, .selected):is(svg, .app-icon) { width: 18px; }", "|:is(.active,.selected):is(svg,.app-icon)"],
    ["*|svg::before { height: 18px; }", "|*|svg::before"],
    // Property names are case-insensitive, and a signed or exponent px literal is still a size.
    [".c svg { WIDTH: 18px; }", "|.c svg"],
    [".d svg { width: calc(var(--icon) + -1px); }", "|.d svg"],
    [".e svg { height: 1.8e1px; }", "|.e svg"],
    // A comment between simple selectors is dropped, and an escaped identifier is still the icon's.
    ["svg/**/:hover { width: 18px; }", "|svg/**/:hover"],
    [".app-icon/* glyph */:hover { width: 18px; }", "|.app-icon/* glyph */:hover"],
    [".row[data-label=\"6\\\" screen\"] svg { width: 18px; }", "|.row[data-label=\"6\\\" screen\"] svg"],
    [".f .app\\2d icon { height: 18px; }", "|.f .app\\2d icon"],
    // Native nesting: `&` is the parent, a member without it is relative, and an at-rule between
    // the declaration and its rule does not hide it.
    [".app-icon { &:hover { width: 18px; } }", ".app-icon|&:hover"],
    [".x { svg { height: 15px; } }", ".x|svg"],
    ["svg { @media (max-width: 760px) { width: 18px; } }", "|svg"],
    [".g { .h &, & > svg { max-width: 26px; } }", ".g|.h &,&>svg"],
    // A custom property carries its value: declared anywhere, read directly, as a fallback, or through
    // another property.
    [":root { --phone-glyph: 15px; }\n.i svg { width: var(--phone-glyph); }", "|.i svg"],
    [".j svg { height: var(--nope, 18px); }", "|.j svg"],
    [":root { --a: var(--b); --b: 18px; }\n.k svg { width: var(--a); }", "|.k svg"],
    [":root { --glyph: 16px; }\n@media (pointer: coarse) { :root { --glyph: 18px; } }\n.l svg { width: var(--glyph); }", "|.l svg"],
  ] as const) {
    const found = sizesOf(`${clean}\n${rule}`);
    assert.deepEqual(found.map((entry) => entry.rule), [key], rule);
    assert.throws(() => assertIconSizesOnScale(found, new Map()), failsNaming(key, "§18", "var(--icon)"));
    assert.doesNotThrow(() => assertIconSizesOnScale(found, new Map([[key, { owner: "#1", why: "test" }]])));
  }
  assert.equal(targetsIcon(".a :where(.b, svg)"), true);
  assert.equal(targetsIcon(".a svg\\"), false, "a trailing backslash is read, not thrown on");
  assert.throws(() => assertIconSizesOnScale(sizesOf(clean), new Map([["|.gone svg", { owner: "#1958", why: "test" }]])),
    failsNaming("|.gone svg", "#1958", "remove its ICON_SIZE_EXEMPTIONS entry"));
});

test("icon classes are read from every way a class reaches an icon, and an unread value is reported", () => {
  const scanOf = (files: Record<string, string>) => {
    const scan = iconClasses(Object.entries(files).map(([file, source]) => ({ file, source })));
    return { classes: [...scan.classes.keys()].sort(), unread: scan.unread };
  };
  // AgentIcon's shape: a spread props object, and a class composed from a typed union.
  assert.deepEqual(scanOf({ "Mark.tsx": [
    "type Provider = \"openai\" | \"other\";",
    "function providerOf(name: string): Provider { return name ? \"openai\" : \"other\"; }",
    "export function Mark({ name }: { name: string }) {",
    "  const p = providerOf(name);",
    "  const common = { className: `mark mark-${p}`, viewBox: \"0 0 24 24\" } as const;",
    "  return <svg {...common}><path /></svg>;",
    "}",
  ].join("\n") }), { classes: ["mark", "mark-openai", "mark-other"], unread: [] });

  // Icons.tsx's shape: a lucide glyph passed as a prop, wrappers that spread their props (whole or
  // the rest), a component picked from a map, and a class handed down through another prop.
  const icons = [
    "import { Check as LucideCheck, type LucideIcon } from \"lucide-react\";",
    "type Props = { className?: string; size?: number };",
    "function LibraryIcon({ glyph: Glyph, className, ...props }: Props & { glyph: LucideIcon }) {",
    "  return <Glyph className={`app-icon${className ? ` ${className}` : \"\"}`} {...props} />;",
    "}",
    "export function CheckIcon(props: Props) { return <LibraryIcon glyph={LucideCheck} {...props} />; }",
    "export function StopIcon(props: Props) { const { size, ...rest } = props; return <LibraryIcon glyph={LucideCheck} {...rest} />; }",
  ].join("\n");
  const row = [
    "import { CheckIcon, StopIcon } from \"./Icons.js\";",
    "const TONES = { done: CheckIcon, stop: StopIcon } as const;",
    "export function Row({ tone, iconClass }: { tone: \"done\" | \"stop\"; iconClass: string }) {",
    "  const Icon = TONES[tone];",
    "  return <div className=\"row\"><CheckIcon className=\"row-check\" /><Icon className={iconClass} /><StopIcon className=\"row-stop\" /></div>;",
    "}",
    "export function List() { return <Row tone=\"done\" iconClass=\"row-tone\" />; }",
    "function Plain({ className }: { className: string }) { return <span className={className} />; }",
    "export function Page() { return <Plain className=\"not-an-icon\" />; }",
  ].join("\n");
  assert.deepEqual(scanOf({ "components/Icons.tsx": icons, "components/Row.tsx": row }),
    { classes: ["app-icon", "row-check", "row-stop", "row-tone"], unread: [] });

  // A memoised name for a component, and a glyph prop read as `props.glyph` or destructured from
  // `props` in the body, are followed like LibraryIcon's signature (#2387 review).
  assert.deepEqual(scanOf({ "Wrapped.tsx": [
    "import { memo } from \"react\";",
    "import { Check, type LucideIcon } from \"lucide-react\";",
    "function MarkInner(props: { className?: string }) { return <svg className={props.className} />; }",
    "export const Mark = memo(MarkInner);",
    "function ByAccess(props: { glyph: LucideIcon; className?: string }) { const Glyph = props.glyph; return <Glyph className={props.className} />; }",
    "function ByBody(props: { glyph: LucideIcon; className?: string }) { const { glyph: Glyph, className } = props; return <Glyph className={className} />; }",
    "export function Uses() {",
    "  return <><Mark className=\"memo-mark\" /><ByAccess glyph={Check} className=\"by-access\" /><ByBody glyph={Check} className=\"by-body\" /></>;",
    "}",
  ].join("\n") }), { classes: ["by-access", "by-body", "memo-mark"], unread: [] });

  // A glyph forwarded through a wrapper's spread, a glyph prop's default, and a tag a helper returns.
  assert.deepEqual(scanOf({ "Relay.tsx": [
    "import { Check } from \"lucide-react\";",
    "type P = { glyph?: typeof Check; className?: string };",
    "function GlyphSlot({ glyph: Glyph = Check, className }: P) { return <Glyph className={className} />; }",
    "function Relay(props: P) { return <GlyphSlot {...props} />; }",
    "function pick(warning: boolean) { return warning ? Check : GlyphSlot; }",
    "export function Uses({ warning }: { warning: boolean }) {",
    "  const Picked = pick(warning);",
    "  return <><Relay glyph={Check} className=\"relay-icon\" /><GlyphSlot className=\"default-icon\" /><Picked className=\"picked-icon\" /></>;",
    "}",
  ].join("\n") }), { classes: ["default-icon", "picked-icon", "relay-icon"], unread: [] });

  // A tag the scan cannot resolve is reported, since an icon behind it would go unchecked; one from
  // another package, a context provider, a class component or an element name is not.
  assert.deepEqual(scanOf({ "Dynamic.tsx": [
    "import { createContext, Suspense } from \"react\";",
    "import { Component } from \"react\";",
    "declare const makeIcon: () => unknown;",
    "const Theme = createContext(null);",
    "class Boundary extends Component { render() { return null; } }",
    "function Slot({ Icon }: { Icon: any }) { return <Icon className=\"dynamic-icon\" />; }",
    "export function Uses({ level }: { level: 1 | 2 }) {",
    "  const Heading = `h${level}` as \"h1\" | \"h2\";",
    "  return <Theme.Provider value={null}><Suspense><Boundary><Heading /><Slot Icon={makeIcon()} /></Boundary></Suspense></Theme.Provider>;",
    "}",
  ].join("\n") }), { classes: [], unread: ["Dynamic.tsx:6 <Icon>"] });

  // A useMemo result, a helper returning one of several props objects, a name joined from parts, a
  // helper's whole-parameter default, and a constant props object written after it is declared.
  assert.deepEqual(scanOf({ "Computed.tsx": [
    "import { useMemo } from \"react\";",
    "function Warn(props: { className?: string }) { return <svg className={props.className} />; }",
    "function iconProps(warning: boolean): { className: \"union-icon\" } | { \"aria-hidden\": true } {",
    "  return warning ? { className: \"union-icon\" } : { \"aria-hidden\": true };",
    "}",
    "function iconClass({ className }: { className?: string } = { className: \"default-arg-icon\" }) { return className; }",
    "export function Uses({ warning, status }: { warning: boolean; status: \"copied\" | \"failed\" }) {",
    "  const Icon = useMemo(() => Warn, []);",
    "  const common = { className: \"mark\" };",
    "  if (warning) common.className += \" mark-warning\";",
    "  return <>",
    "    <Icon className=\"memo-result-icon\" />",
    "    <svg {...iconProps(warning)} />",
    "    <svg {...common} />",
    "    <Warn className={[\"copy\", status].join(\"-\")} />",
    "    <svg className={iconClass()} />",
    "  </>;",
    "}",
  ].join("\n") }), {
    classes: ["copy-copied", "copy-failed", "default-arg-icon", "memo-result-icon", "union-icon"],
    unread: ["Computed.tsx:14 ${…}"],
  });

  // A helper used as a value has call sites the scan cannot see; a spread argument has no position;
  // and a token that is not a class name (a comma join) is not something a rule here can check.
  assert.deepEqual(scanOf({ "Escapes.tsx": [
    "function cls(name: string) { return name; }",
    "export function Uses({ names, rest }: { names: string[]; rest: string[] }) {",
    "  const all = names.map(cls);",
    "  return <><svg className={cls(\"seen\")} /><svg className={cls(...rest)} /><svg className={[\"a\", \"b\"].join(\",\")} /></>;",
    "}",
  ].join("\n") }), {
    classes: ["seen"],
    unread: ["Escapes.tsx:3 cls is used as a value, so its arguments cannot be traced", "Escapes.tsx:4 ${…}", "Escapes.tsx:4 a,b"],
  });

  // A shape inside an svg inherits its forced-color-adjust, so its classes count; React's
  // createElement and cloneElement give classes outside JSX, and the DOM's document.createElement does not.
  assert.deepEqual(scanOf({ "Shapes.tsx": [
    "import { cloneElement, createElement } from \"react\";",
    "export function Chart({ mark }: { mark: JSX.Element }) {",
    "  const node = document.createElement(\"div\");",
    "  return <div className=\"chart\"><svg><path className=\"chart-segment\" /></svg>{cloneElement(mark, { className: \"x\" })}{createElement(\"svg\")}</div>;",
    "}",
  ].join("\n") }), {
    classes: ["chart-segment"],
    unread: ["Shapes.tsx:4 cloneElement() bypasses JSX", "Shapes.tsx:4 createElement() bypasses JSX"],
  });

  // Every argument a rest parameter takes; a default for an argument passed as undefined; an object
  // prop handed down whose declared type does not name className; a source helper that shadows a
  // clsx-style name.
  assert.deepEqual(scanOf({ "Arguments.tsx": [
    "function classes(...tokens: string[]) { return tokens.filter(Boolean).join(\" \"); }",
    "function cls({ className }: { className?: string } = { className: \"default-icon\" }) { return className; }",
    "function Mark({ attrs }: { attrs: { width: number } }) { return <svg {...attrs} />; }",
    "function cn(extra: string) { return \"status-icon \" + extra; }",
    "export function Uses() {",
    "  return <><svg className={classes(\"base\", \"rest-icon\")} /><svg className={cls(undefined)} /><Mark attrs={{ width: 16, className: \"open-type-icon\" }} /><svg className={cn(\"cn-arg\")} /></>;",
    "}",
  ].join("\n") }), { classes: ["base", "cn-arg", "default-icon", "open-type-icon", "rest-icon", "status-icon"], unread: [] });

  // A constant written through an alias, React's createElement under another name, and a component
  // also invoked by map() are reported rather than read from their declarations alone.
  assert.deepEqual(scanOf({ "Aliases.tsx": [
    "import { createElement as h } from \"react\";",
    "function Icon({ className }: { className?: string }) { return <svg className={className} />; }",
    "export function Uses() {",
    "  const common = { className: \"base\" };",
    "  const alias = common;",
    "  alias.className += \" aliased-icon\";",
    "  const extra = [{ className: \"mapped-icon\" }].map(Icon);",
    "  return <><svg {...common} /><Icon className=\"rendered\" />{h(\"svg\", { className: \"factory-icon\" })}</>;",
    "}",
  ].join("\n") }), {
    classes: ["rendered"],
    unread: ["Aliases.tsx:7 Icon is used as a value, so its arguments cannot be traced", "Aliases.tsx:8 ${…}", "Aliases.tsx:8 h() bypasses JSX"],
  });

  // A joined class string kept in a constant and a parenthesised spread are read, not taken as
  // escapes; a default applies where an argument may be undefined; a recursive component passing its
  // own object along terminates; an explicit attribute overrides an earlier spread; and a component
  // mapped under an import alias is still caught.
  assert.deepEqual(scanOf({
    "Icon.tsx": "export function Icon({ className }: { className?: string }) { return <svg className={className} />; }",
    "Final.tsx": [
      "import { Icon as Alias } from \"./Icon.js\";",
      "type P = { attrs: { className?: string }; depth: number };",
      "function Mark({ attrs, depth }: P) { return <><svg {...attrs} />{depth > 0 && <Mark attrs={attrs} depth={depth - 1} />}</>; }",
      "function cls(p = { className: \"default-icon\" }) { return p.className; }",
      "export function Uses({ on }: { on: boolean }) {",
      "  const joined = [\"mark\", on && \"hot\"].filter(Boolean).join(\" \");",
      "  const common = { className: \"wrapped\" };",
      "  const label = { className: \"label\" };",
      "  const mapped = [{ className: \"mapped-icon\" }].map(Alias);",
      "  return <>",
      "    <svg className={joined} />",
      "    <svg {...(common)} />",
      "    <svg className={cls(on ? { className: \"given-icon\" } : undefined)} />",
      "    <Mark attrs={{ className: \"recursive-icon\" }} depth={3} />",
      "    <span {...label} /><svg {...label} className=\"override\" />",
      "    <Alias className=\"rendered\" />",
      "  </>;",
      "}",
    ].join("\n"),
  }), {
    classes: ["default-icon", "given-icon", "hot", "mark", "override", "recursive-icon", "rendered", "wrapped"],
    unread: ["Final.tsx:9 Alias is used as a value, so its arguments cannot be traced"],
  });

  // An explicit className after a spread of props (Menu.tsx's order) is all the svg gets, so the
  // caller's class never counts as the icon's.
  assert.deepEqual(scanOf({ "Override.tsx": [
    "function Mark(props: { className?: string }) { return <svg {...props} className=\"fixed\" />; }",
    "export function Uses() { return <><Mark className=\"label\" /><span className=\"label\" /></>; }",
  ].join("\n") }), { classes: ["fixed"], unread: [] });

  // A union member that does not name className is an open object type, like any other.
  assert.deepEqual(scanOf({ "Open.tsx": [
    "export function U({ on }: { on: boolean }) {",
    "  const extra = { width: 16, className: \"two\" };",
    "  let attrs: { className: \"one\" } | { width: number } = { className: \"one\" };",
    "  if (on) attrs = extra;",
    "  return <svg {...attrs} />;",
    "}",
  ].join("\n") }), { classes: [], unread: ["Open.tsx:5 ${…}"] });

  // A value the scan cannot follow is reported, alone or inside a composed name.
  assert.deepEqual(scanOf({ "A.tsx": "export function A(props: { data: { c: string } }) { return <svg className={props.data.c} />; }" }),
    { classes: [], unread: ["A.tsx:1 ${…}"] });
  assert.deepEqual(scanOf({ "B.tsx": "export function B({ tone }: { tone: string }) { return <svg className={`b b-${tone}`} />; }" }),
    { classes: ["b"], unread: ["B.tsx:1 b-${prop}"] });
});

test("a rule that colours an icon needs a later forced-colors rule, at least as heavy, that hands back its words' colour", () => {
  const found = (sheet: string) => selfColouredIcons(postcss.parse(sheet), new Set(["mark", "app-icon"]));
  const forced = (rules: string) => `@media (forced-colors: active) {\n${rules}\n}`;
  const clean = [
    ".mark { color: var(--amber); }", forced(".mark { color: inherit; }"),
    // Words, filters and descendants of an icon are not the icon.
    ".label { color: var(--red); }\n.row:has(> svg) { color: var(--red); }\nsvg .label { color: var(--red); }",
    ".row:not(.mark) { color: var(--red); }\n.mark { & .label { color: var(--red); } }",
    // Colours that already follow the words.
    ".a svg { color: inherit; }\n.b .mark { color: currentColor; }\n.c .app-icon { color: GrayText; }",
    // A counterpart may name only the icon among an :is() subject's alternatives.
    ".row > :is(.mark, .label) { color: var(--warning); }", forced(".row > .mark { color: inherit; }"),
    // A nested rule, a conditional rule and an !important one, each undone at their own weight.
    ".mark { &:hover { color: var(--accent); } }", forced(".mark:hover { color: CanvasText; }"),
    "@media (max-width: 760px) { .tile svg { color: var(--accent); } }", forced(".tile svg { color: inherit; }"),
    ".hot .app-icon { color: var(--red) !important; }", forced(".hot .app-icon { color: inherit !important; }"),
    // A functional selector left in the subject is undone by the same selector, alternative by alternative.
    ".stat .mark:is(:hover, :focus-visible) { color: var(--accent); }", forced(".stat .mark:is(:hover, :focus-visible) { color: inherit; }"),
    // Media that never matches in forced colors needs no counterpart.
    "@media (forced-colors: none) { .cold .mark { color: var(--blue); } }",
  ].join("\n");
  assert.deepEqual(found(clean), []);
  assert.doesNotThrow(() => assertIconsFollowWords(found(clean), new Map()));

  for (const [rules, at, problem] of [
    [".tile .mark { color: var(--amber); }", ".tile .mark { color: var(--amber) }", "no later @media (forced-colors: active)"],
    // Before the rule it should undo, an equal weight loses.
    [`${forced(".tile .mark { color: inherit; }")}\n.tile .mark { color: var(--amber); }`, ".tile .mark { color: var(--amber) }", "no later"],
    // A counterpart lighter than the rule never wins, even though it matches the icon.
    [`.tile .mark { color: var(--amber); }\n${forced(".mark { color: inherit; }")}`, ".tile .mark { color: var(--amber) }",
      "its forced-colors rule .mark (styles.css:"],
    [`.tile > :is(.mark, .label) { color: var(--amber); }\n${forced(":is(.mark) { color: inherit; }")}`,
      ".tile > :is(.mark, .label) { color: var(--amber) }", "is lighter"],
    // Every icon alternative needs undoing, not only the first.
    [`.row > :is(.mark, svg) { color: var(--amber); }\n${forced(".row > .mark { color: inherit; }")}`,
      ".row > :is(.mark, svg) { color: var(--amber) }", "no later"],
    // Other ancestors do not prove the counterpart reaches the same icons.
    [`.tile .mark { color: var(--amber); }\n${forced(".card .mark { color: inherit; }")}`, ".tile .mark", "no later"],
    // A counterpart that only applies under a further condition, or loses to !important.
    [`.tile svg { color: var(--amber); }\n@media (forced-colors: active) and (max-width: 760px) { .tile svg { color: inherit; } }`,
      ".tile svg { color: var(--amber) }", "no later"],
    [`.tile svg { color: var(--amber) !important; }\n${forced(".tile svg { color: inherit; }")}`,
      ".tile svg { color: var(--amber) !important }", "no later"],
    // Unconditional or not, nested or not, and spelled with an escape, a rule colouring an icon counts.
    ["@media (max-width: 760px) { .tile .app-icon { color: var(--amber); } }", ".tile .app-icon { color: var(--amber) }", "no later"],
    [".tile { .mark { color: var(--amber); } }", ":is(.tile) .mark { color: var(--amber) }", "no later"],
    [".tile .m\\61 rk { color: var(--amber); }", ".tile .m\\61 rk { color: var(--amber) }", "no later"],
    // A counterpart for only one alternative leaves the other.
    [`.tile .mark:is(:hover, :focus-visible) { color: var(--amber); }\n${forced(".tile .mark:hover { color: inherit; }")}`,
      ".tile .mark:is(:hover, :focus-visible) { color: var(--amber) }", "no later"],
    // A `not` that negates another condition still leaves the query in forced colors (#2387 review).
    ["@media (forced-colors: active) and (not (pointer: coarse)) { .tile .mark { color: var(--amber); } }",
      ".tile .mark { color: var(--amber) }", "inside forced colors"],
    ["@media (max-width: 760px) and (not (pointer: coarse)) { .tile .mark { color: var(--amber); } }",
      ".tile .mark { color: var(--amber) }", "no later"],
    // A shape drawn inside an svg keeps its colour just as the svg does.
    [".chart path { color: var(--amber); }", ".chart path { color: var(--amber) }", "no later"],
    // Inside forced colors an author colour cannot be undone at all.
    [forced(".tile .mark { color: var(--amber); }"), ".tile .mark { color: var(--amber) }", "inside forced colors"],
  ] as const) {
    const reported = found(`${clean}\n${rules}`);
    assert.equal(reported.length, 1, `${rules}: ${JSON.stringify(reported)}`);
    assert.ok(reported[0]!.at.includes(at) && reported[0]!.problem.includes(problem), `${rules}: ${JSON.stringify(reported)}`);
    assert.throws(() => assertIconsFollowWords(reported, new Map()),
      failsNaming(at, "@media (forced-colors: active)", "color: inherit", "inherit its colour in normal mode"));
    assert.doesNotThrow(() => assertIconsFollowWords(reported, new Map([[reported[0]!.rule, "test"]])));
  }
  assert.throws(() => assertIconsFollowWords(found(clean), new Map([["|.gone", "test"]])),
    failsNaming("|.gone", "remove its SELF_COLOURED_ICON_EXEMPTIONS entry"));
});

test("selector weights follow the cascade's rules for :is(), :where(), :not() and pseudo-elements", () => {
  assert.deepEqual(selectorSpecificity(".a > :is(.b, #c) .d, :where(#x) .y"), [[1, 2, 0], [0, 1, 0]]);
  assert.deepEqual(selectorSpecificity("svg::before, *|svg:hover, li:nth-child(2 of .x), *, .a:not(.b, .c)"),
    [[0, 0, 2], [0, 1, 1], [0, 2, 1], [0, 0, 0], [0, 2, 0]]);
  assert.deepEqual(selectorSpecificity(".row:has(> svg) .m\\61 rk/* c */:after"), [[0, 2, 2]]);
});

test("the guard fails the #2349 reproduction and a removed counterpart, naming the rule", () => {
  // A new production component colours a new icon class, with no forced-colors rule.
  const scan = iconClasses([...productionSources(), {
    file: "components/SomeNewThing.tsx",
    source: "import { WarningIcon } from \"./Icons.js\";\nexport function SomeNewThing() { return <WarningIcon className=\"some-new-icon\" />; }",
  }]);
  assert.equal(scan.classes.get("some-new-icon"), "components/SomeNewThing.tsx:2");
  const icons = new Set(scan.classes.keys());
  assert.throws(
    () => assertIconsFollowWords(selfColouredIcons(postcss.parse(`${css}\n.some-new-icon { color: var(--amber); }`), icons),
      SELF_COLOURED_ICON_EXEMPTIONS),
    failsNaming(".some-new-icon { color: var(--amber) }", "no later @media (forced-colors: active)"));

  // One of today's counterparts removed: AgentIcon's OpenAI mark, whose class only a spread carries.
  const sheet = postcss.parse(css);
  let removed = 0;
  sheet.walkRules((rule) => {
    if (rule.parent?.type !== "atrule" || !/forced-colors/.test((rule.parent as postcss.AtRule).params)) return;
    if (!rule.selectors.includes(".agent-openai")) return;
    rule.selectors = rule.selectors.filter((selector) => selector !== ".agent-openai");
    removed += 1;
  });
  assert.equal(removed, 1);
  assert.throws(() => assertIconsFollowWords(selfColouredIcons(sheet, icons), SELF_COLOURED_ICON_EXEMPTIONS),
    failsNaming(".agent-openai { color: #10a37f }"));
});
