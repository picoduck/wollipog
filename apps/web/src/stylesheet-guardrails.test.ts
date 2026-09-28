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
    || ts.isFunctionDeclaration(owner) || ts.isImportSpecifier(owner) || ts.isImportClause(owner)
    || ts.isNamespaceImport(owner)) && owner.name !== name) return null;
  if (ts.isImportSpecifier(owner) || ts.isImportClause(owner) || ts.isNamespaceImport(owner)) return name.getSourceFile();
  if (ts.isFunctionDeclaration(owner)) return owner.parent;
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
  let scope: ts.Node = list;
  while (!ts.isSourceFile(scope) && !ts.isFunctionLike(scope)) scope = scope.parent;
  return scope;
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
    if (ts.isIdentifier(node) && node.text === "confirm") {
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
  ]) assert.deepEqual(nativeConfirmReferences(shadowed, "g.ts"), [], shadowed);
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
