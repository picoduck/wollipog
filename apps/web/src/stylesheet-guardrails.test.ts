import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import ts from "typescript";

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
  return selector.split(",").map((part) => canonicalSelector(part)).filter(Boolean);
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
export interface DebtInventory {
  shadowedDeclarations: string[];
  fontSizeLiterals: string[];
  radiusLiterals: string[];
  zIndexLiterals: string[];
  deadClasses: string[];
  unstyledClasses: string[];
}

const LITERAL_PROPERTIES = { "font-size": "fontSizeLiterals", "border-radius": "radiusLiterals", "z-index": "zIndexLiterals" } as const;

export function measureDebt(): DebtInventory {
  const shadowedDeclarations = [...selectorCounts()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);

  const literals: Record<string, string[]> = { fontSizeLiterals: [], radiusLiterals: [], zIndexLiterals: [] };
  root.walkRules((rule) => {
    const where = contextKey(rule);
    for (const node of rule.nodes) {
      if (node.type !== "decl") continue;
      const bucket = LITERAL_PROPERTIES[node.prop as keyof typeof LITERAL_PROPERTIES];
      if (!bucket) continue;
      // One entry per LITERAL, so `7px` growing into `7px 7px 0 0` is three new identities rather
      // than the same declaration wearing a longer value.
      for (const literal of numericLiterals(node.value)) literals[bucket]!.push(`${where}|${node.prop}|${literal}`);
    }
  });

  const rendered = new Set([...RENDERED, ...HELPER_CLASSES.keys()]);
  const sorted = (values: string[]) => [...values].sort();
  return {
    shadowedDeclarations: sorted(shadowedDeclarations),
    fontSizeLiterals: sorted(literals.fontSizeLiterals!),
    radiusLiterals: sorted(literals.radiusLiterals!),
    zIndexLiterals: sorted(literals.zIndexLiterals!),
    deadClasses: sorted([...STYLED].filter((name) => !rendered.has(name) && !emittedByLibrary(name))),
    unstyledClasses: sorted([...rendered].filter((name) => !STYLED.has(name))),
  };
}

const RECORDED = JSON.parse(readFileSync(join(WEB, "src/stylesheet-debt.json"), "utf8")) as DebtInventory;

test("no debt is added, and none is traded for other debt", () => {
  const measured = measureDebt();
  for (const key of Object.keys(RECORDED) as (keyof DebtInventory)[]) {
    const added = measured[key].filter((identity) => !RECORDED[key].includes(identity));
    assert.deepEqual(added, [],
      `${key}: new debt that is not in stylesheet-debt.json — use a token, or style the class, ` +
      "or delete the rule. Adding it to the inventory is not the fix.");
    const paid = RECORDED[key].filter((identity) => !measured[key].includes(identity));
    assert.deepEqual(paid, [],
      `${key}: ${paid.length} entries are recorded but no longer present. Good — regenerate ` +
      "stylesheet-debt.json in this commit so the inventory keeps matching the tree.");
  }
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
    if (ts.isParenthesizedExpression(node)) return fromValue(node.expression);
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
