import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * A browser end-to-end spec may not PIN a measurement to a number.
 *
 * A rendered element's size is a sum of line boxes, so it follows the font stack of whatever machine
 * rasterises it. #877 wrote `expect(phone).toBeGreaterThanOrEqual(85)` and `toBeLessThanOrEqual(87)`
 * around a card that measures 86px on a developer machine and 83px on the CI runner. The browser job
 * failed with 628 of 629 tests passing, and the one failure named a layout regression that did not
 * exist. That job takes over twenty minutes, so learning this costs a third of an hour a time (#902).
 *
 * WHAT THIS CATCHES, and what it deliberately does not.
 *
 * A scanner cannot see a font, so it cannot decide which values are text-derived. What it can
 * recognise is the SHAPE of an assertion that only holds on the machine that wrote it:
 *
 *   1. Equality against a number — `toBe(86)`, `toBeCloseTo(24)`. There is no headroom in an
 *      equality, so it survives a renderer change only if the value came from CSS rather than text.
 *   2. A narrow two-sided range over one subject — `>= 85` with `<= 87`. This is #877's exact
 *      signature: a bound pair tight enough that a few percent of font drift falls outside it.
 *
 * A one-sided bound is left alone. `expect(branch.width).toBeGreaterThan(40)` against a real 340px
 * tolerates any plausible drift, and a scanner cannot tell a generous bound from a tight one without
 * running the browser. That is what the convention note in `apps/web/e2e/README.md` is for: keep
 * one-sided bounds generous, because nothing here will catch it when they are not.
 *
 * Containment tolerances are also left alone. `expect(overflowRight).toBeLessThanOrEqual(0.5)` says
 * "nothing spills past the edge", not "this thing is N pixels", and a half-pixel tolerance means the
 * same thing on every renderer.
 *
 * Legitimate exceptions — a value fixed by a stylesheet, an icon's declared box, a spacing token —
 * live in `e2e-geometry-debt.json` with a written reason, so adding one is a deliberate act that a
 * reviewer sees in the diff.
 */

const WEB = fileURLToPath(new URL("..", import.meta.url));
const E2E = join(WEB, "e2e");

/**
 * Sorted, and read one file at a time.
 *
 * `readdirSync` returns entries in filesystem order, so an unsorted scan reports a different
 * inventory from the same checkout depending on how the directory happens to be laid out — the
 * stylesheet guard learned this measuring 179 dead classes in one enumeration order and 248 in
 * another.
 */
export function specFiles(): string[] {
  return readdirSync(E2E)
    .filter((name) => name.endsWith(".spec.ts"))
    .sort()
    .map((name) => join(E2E, name));
}

const EQUALITY_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual", "toBeCloseTo"]);
const LOWER_BOUND_MATCHERS = new Set(["toBeGreaterThan", "toBeGreaterThanOrEqual"]);
const UPPER_BOUND_MATCHERS = new Set(["toBeLessThan", "toBeLessThanOrEqual"]);
const ALL_MATCHERS = new Set([...EQUALITY_MATCHERS, ...LOWER_BOUND_MATCHERS, ...UPPER_BOUND_MATCHERS]);

/**
 * A window this tight around a measurement is a pin, not a bound.
 *
 * #877's `85..87` is 2.3% of its midpoint. CI renders roughly 3.5% smaller than a developer machine,
 * so anything inside about a tenth is asserting the renderer rather than the layout.
 */
const NARROW_RANGE = 0.10;

/**
 * Values whose magnitude makes them a tolerance rather than a size.
 *
 * `toBe(0)` is a collapse check — the element has no width — and `toBeCloseTo(0.5)` is a half-pixel
 * agreement. Neither claims a size, and both mean the same thing on every renderer.
 */
const TOLERANCE = 1;

/**
 * Names whose value is a quantity of things rather than the size of something.
 *
 * A count is exact on every machine: five badges are five badges whatever the font. The `Count` and
 * `Length` suffixes matter as much as the bare names — `totalBadgeCount` is no more a measurement
 * than `count` is, and allowlisting it would have put a non-geometry number in an inventory that is
 * supposed to be about geometry.
 */
const COUNT_NAMES = /(^(length|size|count|renderedBars|index|position|rowIndex|innerWidth|innerHeight)$|(Count|Length|Index)$)/i;

const stripWrappers = (node: ts.Expression): ts.Expression => {
  let inner = node;
  while (ts.isNonNullExpression(inner) || ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
};

const isCountExpression = (node: ts.Expression): boolean => {
  const inner = stripWrappers(node);
  if (ts.isPropertyAccessExpression(inner)) return COUNT_NAMES.test(inner.name.text);
  if (ts.isIdentifier(inner)) return COUNT_NAMES.test(inner.text);
  if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)) {
    return COUNT_NAMES.test(inner.expression.name.text);
  }
  return false;
};

/**
 * True when an expression is built from numeric literals and nothing else.
 *
 * `40` is a bare number. `-0.5` is. `desktop + 15` is not, because `desktop` is another measurement
 * and the comparison is therefore relative — which is exactly what this file is asking authors to
 * write.
 */
export function bareNumber(node: ts.Expression): string | null {
  const inner = stripWrappers(node);
  if (ts.isNumericLiteral(inner)) return inner.text;
  if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.MinusToken) {
    const operand = bareNumber(inner.operand);
    return operand === null ? null : `-${operand}`;
  }
  if (ts.isBinaryExpression(inner)) {
    const left = bareNumber(inner.left);
    const right = bareNumber(inner.right);
    if (left === null || right === null) return null;
    return `${left}${inner.operatorToken.getText(inner.getSourceFile())}${right}`;
  }
  return null;
}

/** `expect(x)` / `expect(x, "message")`, reached through any number of `.not` / `.resolves` hops. */
function expectArgument(node: ts.LeftHandSideExpression): ts.Expression | null {
  let current: ts.Expression = node;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  if (!ts.isCallExpression(current)) return null;
  const callee = current.expression;
  // `expect.poll(fn)` and `expect.soft(…)` take a function or a locator, not a measurement.
  if (!ts.isIdentifier(callee) || callee.text !== "expect") return null;
  return current.arguments[0] ?? null;
}

interface Comparison {
  subject: string;
  matcher: string;
  literal: string;
  value: number;
  line: number;
  /** The enclosing `test(…)` callback, so two tests bounding the same subject are not merged. */
  scope: number;
}

export interface GeometryFinding {
  /** Content-addressed, so an edit elsewhere in the file does not rewrite every identity. */
  id: string;
  file: string;
  line: number;
  kind: "equality" | "narrow-range";
  detail: string;
}

const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();

function comparisons(parsed: ts.SourceFile): Comparison[] {
  const found: Comparison[] = [];
  const visit = (node: ts.Node, scope: number): void => {
    let nextScope = scope;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "test") {
      nextScope = node.getStart(parsed);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const matcher = node.expression.name.text;
      if (ALL_MATCHERS.has(matcher)) {
        const subject = expectArgument(node.expression.expression);
        const literal = node.arguments[0] ? bareNumber(node.arguments[0]) : null;
        if (subject && literal !== null && !isCountExpression(subject)) {
          found.push({
            subject: collapse(subject.getText(parsed)),
            matcher,
            literal,
            value: Number(literal),
            line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
            scope: nextScope,
          });
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, nextScope));
  };
  visit(parsed, 0);
  return found;
}

export function scanSpec(file: string, source: string): GeometryFinding[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const relative = `apps/web/e2e/${file.slice(E2E.length + 1)}`;
  const all = comparisons(parsed);
  const findings: GeometryFinding[] = [];

  for (const comparison of all) {
    if (!EQUALITY_MATCHERS.has(comparison.matcher)) continue;
    if (Math.abs(comparison.value) <= TOLERANCE) continue;
    findings.push({
      id: `${relative}|${comparison.subject}|${comparison.matcher}|${comparison.literal}`,
      file: relative,
      line: comparison.line,
      kind: "equality",
      detail: `expect(${comparison.subject}).${comparison.matcher}(${comparison.literal})`,
    });
  }

  // A lower and an upper bound over the same subject, inside the same test, close enough together
  // that they pin it. #877's `85..87` is this shape.
  const bySubject = new Map<string, Comparison[]>();
  for (const comparison of all) {
    const key = `${comparison.scope}|${comparison.subject}`;
    bySubject.set(key, [...(bySubject.get(key) ?? []), comparison]);
  }
  for (const group of bySubject.values()) {
    const lower = group.filter((one) => LOWER_BOUND_MATCHERS.has(one.matcher)).map((one) => one.value);
    const upper = group.filter((one) => UPPER_BOUND_MATCHERS.has(one.matcher)).map((one) => one.value);
    if (lower.length === 0 || upper.length === 0) continue;
    const floor = Math.max(...lower);
    const ceiling = Math.min(...upper);
    const midpoint = (floor + ceiling) / 2;
    if (!(ceiling > floor) || midpoint <= TOLERANCE) continue;
    if ((ceiling - floor) / Math.abs(midpoint) >= NARROW_RANGE) continue;
    const first = group[0]!;
    findings.push({
      id: `${relative}|${first.subject}|range|${floor}..${ceiling}`,
      file: relative,
      line: Math.min(...group.map((one) => one.line)),
      kind: "narrow-range",
      detail: `${first.subject} is pinned to ${floor}..${ceiling}`,
    });
  }

  return findings.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export function measureGeometry(): GeometryFinding[] {
  return specFiles().flatMap((file) => scanSpec(file, readFileSync(file, "utf8")));
}

interface AllowedEntry {
  id: string;
  reason: string;
}

/** Written into a regenerated entry so an unexplained exception cannot pass review silently. */
export const UNEXPLAINED = "TODO: explain why this number is stable on every renderer";

const RECORDED = JSON.parse(
  readFileSync(join(WEB, "src/e2e-geometry-debt.json"), "utf8"),
) as { allowed: AllowedEntry[] };

const describe = (finding: GeometryFinding): string => `${finding.file}:${finding.line} — ${finding.detail}`;

test("no end-to-end spec pins a measurement to a number", () => {
  const allowed = new Set(RECORDED.allowed.map((entry) => entry.id));
  const added = measureGeometry().filter((finding) => !allowed.has(finding.id));
  assert.deepEqual(added.map(describe), [],
    "compare this against another measurement instead: two elements, or the same element before " +
    "and after, or a structural fact such as the resolved grid-template-rows track count. A " +
    "rendered size follows the font stack, so a number measured on one machine is not a layout " +
    "invariant. If the value comes from CSS rather than from text, record it in " +
    "apps/web/src/e2e-geometry-debt.json with the reason it holds everywhere.");
});

test("every recorded exception is still in the specs", () => {
  const present = new Set(measureGeometry().map((finding) => finding.id));
  const stale = RECORDED.allowed.map((entry) => entry.id).filter((id) => !present.has(id));
  assert.deepEqual(stale, [],
    "these exceptions are recorded but no longer present. Good — run " +
    "`node scripts/regenerate-e2e-geometry-debt.mjs` in this commit so the list keeps matching " +
    "the specs.");
});

test("every recorded exception carries a reason", () => {
  const unexplained = RECORDED.allowed
    .filter((entry) => entry.reason.trim().length === 0 || entry.reason.startsWith("TODO"))
    .map((entry) => entry.id);
  assert.deepEqual(unexplained, [],
    "regenerating the list adds a placeholder reason on purpose. Replace it with why this " +
    "particular number is stable on every renderer, or make the assertion relative.");
});

// --- The scanner's own behaviour, on sources written here rather than on the tree ---

const sample = (source: string) => scanSpec(join(E2E, "sample.spec.ts"), source);

test("the exact assertion that failed CI in #877 is caught", () => {
  const source = [
    'test("a desktop card is shorter than a phone card", async ({ page }) => {',
    "  const phone = await heightAt(390);",
    "  expect(phone).toBeGreaterThanOrEqual(85);",
    "  expect(phone).toBeLessThanOrEqual(87);",
    "});",
  ].join("\n");
  assert.deepEqual(sample(source).map((finding) => finding.detail), ["phone is pinned to 85..87"]);
});

test("a comparison against another measurement is not a finding", () => {
  const source = [
    "expect(after.height).toBeCloseTo(before.height, 0);",
    "expect(phone).toBeGreaterThan(desktop + 15);",
    "expect(Math.abs(a.top - b.top)).toBeLessThanOrEqual(tolerance);",
  ].join("\n");
  assert.deepEqual(sample(source), []);
});

test("counts and containment tolerances are not findings", () => {
  const source = [
    "expect(rows).toHaveLength(11);",
    "expect(strip.renderedBars).toBe(30);",
    "expect(nodes.length).toBe(4);",
    "expect(overflowRight).toBeLessThanOrEqual(0.5);",
    "expect(sender.width).toBe(0);",
  ].join("\n");
  assert.deepEqual(sample(source), []);
});

test("a one-sided bound is left to the author, and to the convention note", () => {
  // A scanner cannot tell a generous bound from a tight one without running the browser, so this
  // shape is documented rather than enforced. Flagging it would mean allowlisting a hundred honest
  // sanity checks, which is how an inventory becomes a rubber stamp.
  assert.deepEqual(sample("expect(branch.width).toBeGreaterThan(40);"), []);
});

test("equality against a size is a finding, however it is written", () => {
  const source = [
    "expect(card.height).toBe(86);",
    "expect(box.width).toBeCloseTo(70 + 2);",
  ].join("\n");
  assert.deepEqual(
    sample(source).map((finding) => finding.detail),
    ["expect(box.width).toBeCloseTo(70+2)", "expect(card.height).toBe(86)"],
  );
});

test("two tests bounding the same subject differently are not merged into a narrow range", () => {
  const source = [
    'test("wide", () => { expect(card.height).toBeGreaterThanOrEqual(80); });',
    'test("narrow", () => { expect(card.height).toBeLessThanOrEqual(82); });',
  ].join("\n");
  assert.deepEqual(sample(source), []);
});

test("a wide two-sided range is a real bound and is left alone", () => {
  const source = 'test("x", () => { expect(card.height).toBeGreaterThan(40); expect(card.height).toBeLessThan(400); });';
  assert.deepEqual(sample(source), []);
});

test("identity is content-addressed, so unrelated edits do not rewrite the inventory", () => {
  const source = 'test("x", () => { expect(box.width).toBe(15); });';
  const padded = ["", "// a comment added above", source].join("\n");
  const [first] = sample(source);
  const [second] = sample(padded);
  assert.equal(first?.id, second?.id);
  assert.notEqual(first?.line, second?.line, "the reported line still follows the code");
});
