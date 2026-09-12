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

const EQUALITY_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual", "toBeCloseTo", "toMatchObject", "toContainEqual"]);
/** `toHaveProperty("height", 86)` puts the key in the FIRST argument and the value in the second. */
const KEYED_MATCHER = "toHaveProperty";
const LOWER_BOUND_MATCHERS = new Set(["toBeGreaterThan", "toBeGreaterThanOrEqual"]);
const UPPER_BOUND_MATCHERS = new Set(["toBeLessThan", "toBeLessThanOrEqual"]);
const INCLUSIVE_MATCHERS = new Set(["toBeGreaterThanOrEqual", "toBeLessThanOrEqual"]);
const ALL_MATCHERS = new Set([...EQUALITY_MATCHERS, ...LOWER_BOUND_MATCHERS, ...UPPER_BOUND_MATCHERS]);

/**
 * A window this tight around a measurement is a pin, not a bound.
 *
 * #877's `85..87` is 2.3% of its midpoint. The drift this guard exists for is ONE-DIRECTIONAL — CI
 * renders smaller, so it is the lower bound that gives way — which means a symmetric window is the
 * wrong measure of safety. A true 86 becomes 83 on the runner, so a floor set anywhere above 83
 * fails however generous the ceiling above it is. The threshold is therefore deliberately wide.
 */
const NARROW_RANGE = 0.25;

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
 * Matched on PROPERTY ACCESS only, never on a bare identifier. `set.size` and `nodes.length` are
 * counts; a local called `size` or `position` is just as likely to hold a measurement, and exempting
 * it by name was a direct false negative — `const size = box.height; expect(size).toBe(86)` walked
 * straight through.
 */
const COUNT_NAMES = /(^(length|size|count|renderedBars|index|position|rowIndex|innerWidth|innerHeight)$|(Count|Length|Index)$)/i;

/**
 * Names bound to something measured, so a rename is not a hiding place.
 *
 * `const size = box.height; expect(size).toBe(86)` pins a measurement, but the subject is a bare
 * identifier with nothing geometric about it. Recording what each local was assigned FROM closes
 * that without having to treat every `toBe(n)` in the suite as geometry — which was the previous
 * rule, and which buried four real findings under thirty call counts and cursor offsets.
 */
const FILE_SCOPE = -1;

function measuredNames(parsed: ts.SourceFile): Map<number, Set<string>> {
  // Keyed by the enclosing `test(...)`, because a file-wide set conflates locals that merely share a
  // name: one test's `const value = box.height` made another test's `const value = await
  // requestCount()` read as geometry, and reported a count as a pinned measurement.
  // -1, not 0. A `test(` call at the very start of a file has `getStart() === 0`, so using 0 as the
  // file-scope sentinel merged the first test's locals into every other test's scope — which is
  // precisely the conflation this scoping was added to prevent, reintroduced by the sentinel.
  const byScope = new Map<number, Set<string>>();
  const visit = (node: ts.Node, scope: number): void => {
    let nextScope = scope;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "test") {
      nextScope = node.getStart(parsed);
    }
    if (ts.isVariableDeclaration(node) && node.initializer
      && measuresGeometry(node.initializer.getText(parsed))) {
      const names = byScope.get(nextScope) ?? new Set<string>();
      // Every name the declaration BINDS, not only a plain identifier. `const { height: value } =
      // box` renames a measurement, and recording nothing for it let the alias pass as unrelated.
      const bind = (name: ts.BindingName): void => {
        if (ts.isIdentifier(name)) { names.add(name.text); return; }
        for (const element of name.elements) {
          if (ts.isBindingElement(element)) bind(element.name);
        }
      };
      bind(node.name);
      byScope.set(nextScope, names);
    }
    ts.forEachChild(node, (child) => visit(child, nextScope));
  };
  visit(parsed, FILE_SCOPE);
  return byScope;
}

/** Does this source text read a position or a size? */
function measuresGeometry(text: string): boolean {
  if (MEASURING.test(text)) return true;
  return text.split(/[^A-Za-z]+/).some((word) => word.length > 0 && GEOMETRY_NAMES.test(word));
}

const stripWrappers = (node: ts.Expression): ts.Expression => {
  let inner = node;
  // `as const`, `satisfies number` and a type assertion all leave the value untouched at runtime, so
  // `toBeGreaterThanOrEqual(85 as const)` is the original #877 pin wearing a type annotation.
  while (
    ts.isNonNullExpression(inner) || ts.isParenthesizedExpression(inner) || ts.isAwaitExpression(inner)
    || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner) || ts.isTypeAssertionExpression(inner)
  ) {
    inner = inner.expression;
  }
  return inner;
};

const isCountExpression = (node: ts.Expression): boolean => {
  const inner = stripWrappers(node);
  if (ts.isPropertyAccessExpression(inner)) return COUNT_NAMES.test(inner.name.text);
  if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)) {
    return COUNT_NAMES.test(inner.expression.name.text);
  }
  return false;
};

/** A number the scanner could resolve, with the text to record it under. */
export interface ResolvedNumber {
  value: number;
  text: string;
}

/**
 * Module-scope `const` numbers, so a named bound is not a hiding place.
 *
 * `const CARD_HEIGHT = 86; expect(card.height).toBe(CARD_HEIGHT)` pins exactly as hard as the
 * literal does, and naming things is what a careful author does — this suite already declares
 * `RAIL_HEIGHT = { min: 48, max: 96 }` and bounds a measured height by both members. One level of
 * object nesting is resolved for that shape; deeper indirection is out of reach and is recorded in
 * the limits note below rather than pretended away.
 */
function constantNumbers(parsed: ts.SourceFile): Map<string, number> {
  const constants = new Map<string, number>();
  const literal = (node: ts.Expression): number | null => {
    const inner = stripWrappers(node);
    if (ts.isNumericLiteral(inner)) return Number(inner.text);
    if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.MinusToken) {
      const operand = literal(inner.operand);
      return operand === null ? null : -operand;
    }
    if (ts.isAsExpression(inner)) return literal(inner.expression);
    return null;
  };
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const name = declaration.name.text;
      const direct = literal(declaration.initializer);
      if (direct !== null) {
        constants.set(name, direct);
        continue;
      }
      const initializer = stripWrappers(
        ts.isAsExpression(declaration.initializer) ? declaration.initializer.expression : declaration.initializer,
      );
      if (!ts.isObjectLiteralExpression(initializer)) continue;
      for (const property of initializer.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
        const member = literal(property.initializer);
        if (member !== null) constants.set(`${name}.${property.name.text}`, member);
      }
    }
  }
  return constants;
}

const accessPath = (node: ts.Expression): string | null => {
  const inner = stripWrappers(node);
  if (ts.isIdentifier(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner)) {
    const object = accessPath(inner.expression);
    return object === null ? null : `${object}.${inner.name.text}`;
  }
  return null;
};

/**
 * The number an expression denotes, or null when it denotes a measurement.
 *
 * CONSTANT-FOLDED, not stringified. An earlier version returned the source text and called
 * `Number()` on it, so `toBeGreaterThanOrEqual(80 + 5)` produced the text `80+5`, `Number("80+5")`
 * gave `NaN`, and every comparison against it was quietly false — a pair of arithmetic bounds could
 * pin a measurement and the range check would not see it.
 *
 * `desktop + 15` still resolves to null, because `desktop` is another measurement and the comparison
 * is therefore relative — which is exactly what this file asks authors to write.
 */
export function bareNumber(node: ts.Expression, constants: Map<string, number> = new Map()): ResolvedNumber | null {
  const inner = stripWrappers(node);
  if (ts.isNumericLiteral(inner)) return { value: Number(inner.text), text: inner.text };
  if (ts.isPrefixUnaryExpression(inner)) {
    const operand = bareNumber(inner.operand, constants);
    if (operand === null) return null;
    if (inner.operator === ts.SyntaxKind.MinusToken) return { value: -operand.value, text: `-${operand.text}` };
    if (inner.operator === ts.SyntaxKind.PlusToken) return operand;
    return null;
  }
  if (ts.isBinaryExpression(inner)) {
    const left = bareNumber(inner.left, constants);
    const right = bareNumber(inner.right, constants);
    if (left === null || right === null) return null;
    const operator = inner.operatorToken.kind;
    const value = operator === ts.SyntaxKind.PlusToken ? left.value + right.value
      : operator === ts.SyntaxKind.MinusToken ? left.value - right.value
        : operator === ts.SyntaxKind.AsteriskToken ? left.value * right.value
          : operator === ts.SyntaxKind.SlashToken ? left.value / right.value
            : null;
    if (value === null || !Number.isFinite(value)) return null;
    return { value, text: `${left.text}${inner.operatorToken.getText(inner.getSourceFile())}${right.text}` };
  }
  const path = accessPath(inner);
  if (path !== null && constants.has(path)) return { value: constants.get(path)!, text: path };
  return null;
}

/**
 * `expect(x)`, `expect.soft(x)`, and `expect.poll(() => x)`.
 *
 * `soft` and `poll` are ordinary Playwright and both pin a measurement exactly as hard as `expect`
 * does — `poll`'s callback returns the very value the matcher compares. An earlier comment here
 * claimed otherwise and excluded both, which made "write it with `expect.soft`" a one-word bypass.
 */
function expectArgument(node: ts.LeftHandSideExpression, parsed: ts.SourceFile): ts.Expression | null {
  let current: ts.Expression = node;
  // `.not` REJECTS the value rather than pinning it, so reporting `not.toBe(86)` as a pin was a
  // false positive — and the only remedy on offer would have been a misleading allowlist entry.
  while (ts.isPropertyAccessExpression(current)) {
    if (current.name.text === "not") return null;
    current = current.expression;
  }
  if (!ts.isCallExpression(current)) return null;
  const callee = current.expression;
  const named = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "expect"
      ? `expect.${callee.name.text}`
      : null;
  if (named !== "expect" && named !== "expect.soft" && named !== "expect.poll") return null;
  const argument = current.arguments[0];
  if (!argument) return null;
  // `expect.poll(() => box.height)` — the subject is what the callback yields. A block-bodied
  // callback has no single expression to name, so it is left alone rather than reported under the
  // text of the whole function.
  if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
    if (ts.isArrowFunction(argument) && !ts.isBlock(argument.body)) return argument.body;
    // A BLOCK body still yields the value the matcher compares; it just says so in a `return`.
    // Returning null here skipped the assertion entirely, which is how two live pins in
    // `remote-instances.spec.ts` went unseen. The last return wins for naming purposes; any of them
    // being a measurement is what matters.
    const returned: ts.Expression[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) && node.expression) returned.push(node.expression);
      // Do not descend into a nested function: its `return` belongs to that function, not this one.
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) return;
      ts.forEachChild(node, walk);
    };
    ts.forEachChild(argument.body, walk);
    // ANY return that measures something, not just the last one written. A fallback-shaped callback
    // — `if (box) return box.height; return fallback;` — compares the height at runtime, and taking
    // only the final return read `fallback` and reported nothing.
    return returned.find((value) => measuresGeometry(value.getText(parsed))) ?? returned.at(-1) ?? null;
  }
  return argument;
}

/**
 * Names that denote a position or a size.
 *
 * Needed only where the scanner reaches PAST the matcher's argument — into an object literal's keys,
 * or into the subject's own expression. A direct `expect(x).toBe(86)` is judged by its shape alone,
 * because anything a spec compares to a number that way is worth a second look. But `toEqual({...})`
 * and arithmetic inside a subject are everyday non-geometry idioms in this suite — request ids,
 * protocol fields, retry counts — and flagging those taught nothing and cost 63 exemptions.
 */
const GEOMETRY_NAMES = /(^(x|y|top|bottom|left|right|width|height)$|[a-z](Width|Height|Top|Bottom|Left|Right|X|Y)$)/;
const MEASURING = /getBoundingClientRect|boundingBox|offset(Width|Height|Top|Left)|scroll(Width|Height|Top|Left)|client(Width|Height|Top|Left)/;

/** Every numeric GEOMETRY member of an object or array literal, so `toEqual({ height: 86 })` is not a gap. */
function structuredNumbers(node: ts.Expression, constants: Map<string, number>): Array<{ path: string; number: ResolvedNumber }> {
  const inner = stripWrappers(node);
  if (ts.isObjectLiteralExpression(inner)) {
    return inner.properties.flatMap((property) => {
      // `{ ...{ height: 86 } }` — a spread carries the same pins, one level in.
      if (ts.isSpreadAssignment(property)) {
        return structuredNumbers(property.expression, constants);
      }
      if (!ts.isPropertyAssignment(property)) return [];
      const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
      if (key === null) return [];
      const number = bareNumber(property.initializer, constants);
      if (number !== null) return GEOMETRY_NAMES.test(key) ? [{ path: `.${key}`, number }] : [];
      // `{ card: { height: 86 } }` — the geometry name is on the INNER key, so recurse rather than
      // requiring this level to be geometric.
      return structuredNumbers(property.initializer, constants)
        .map(({ path, number: nested }) => ({ path: `.${key}${path}`, number: nested }));
    });
  }
  // An array of shapes, as in `toEqual([{ x: 12, y: 5 }, { x: 12, y: 12 }])`, which pins two SVG
  // coordinates per element. Live at `command-inbox-projects.spec.ts` and `session-header.spec.ts`,
  // and invisible until now because only object literals were walked.
  if (ts.isArrayLiteralExpression(inner)) {
    return inner.elements.flatMap((element, index) =>
      structuredNumbers(element, constants).map(({ path, number }) => ({ path: `[${index}]${path}`, number })));
  }
  return [];
}

/**
 * A bare number hidden inside the SUBJECT, as in `expect(Math.abs(card.height - 86))`.
 *
 * Only when the subject is measuring something. The guard's own prose — tolerances are fine,
 * one-sided bounds are fine — steers an author straight into writing the pin on this side of the
 * comparison, where the matcher's argument is an innocent `1`.
 */
function subjectLiterals(node: ts.Expression, constants: Map<string, number>): ResolvedNumber[] {
  if (!measuresGeometry(node.getText(node.getSourceFile()))) return [];

  // ADDED or SUBTRACTED only. `card.height - 86` is a pin wearing a tolerance; `box.width / 2` is a
  // midpoint and `box.x * 2` is a ratio, and neither says anything about how many pixels tall
  // something is. Flagging every literal in a geometric expression reported the `2` in a dozen
  // honest centre-alignment checks.
  const found: ResolvedNumber[] = [];
  const visit = (current: ts.Node): void => {
    // `/` and `*` count only against a LARGE literal. `box.width / 2` is a midpoint and `x * 2` a
    // ratio — the idiom every centring check in this suite uses — but `card.height / 86` normalises
    // the measurement so the matcher can compare it to 1, which pins it exactly as hard as equality.
    // Ten is the line: no centring or doubling uses a divisor that big, and no pinned size is that
    // small.
    const NORMALISING = 10;
    const scaling = ts.isBinaryExpression(current)
      && (current.operatorToken.kind === ts.SyntaxKind.SlashToken
        || current.operatorToken.kind === ts.SyntaxKind.AsteriskToken);
    if (ts.isBinaryExpression(current)
      && (current.operatorToken.kind === ts.SyntaxKind.PlusToken
        || current.operatorToken.kind === ts.SyntaxKind.MinusToken
        || scaling)) {
      for (const [operand, other] of [[current.left, current.right], [current.right, current.left]] as const) {
        const resolved = bareNumber(operand, constants);
        const floor = scaling ? NORMALISING : TOLERANCE;
        if (!resolved || Math.abs(resolved.value) <= floor) continue;
        // The other side has to be the measurement; `86 - 1` is arithmetic, not a comparison.
        if (bareNumber(other, constants) !== null) continue;
        found.push(resolved);
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

interface Comparison {
  subject: string;
  key: string;
  matcher: string;
  number: ResolvedNumber;
  line: number;
  scope: number;
}

export interface GeometryFinding {
  /** Content-addressed, and made unique per occurrence so one exemption cannot cover two sites. */
  id: string;
  file: string;
  line: number;
  kind: "equality" | "narrow-range" | "literal-in-subject";
  detail: string;
}

const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();
/** `box?.height` and `box.height` are the same subject; only the source text differs. */
const groupingKey = (subject: string): string => subject.replace(/\?\./g, ".").replace(/\s+/g, "");

function comparisons(parsed: ts.SourceFile, constants: Map<string, number>, measured: Map<number, Set<string>>): {
  bounds: Comparison[];
  equalities: GeometryFinding[];
  subjectPins: Array<{ subject: string; number: ResolvedNumber; line: number }>;
} {
  const bounds: Comparison[] = [];
  const equalities: GeometryFinding[] = [];
  const subjectPins: Array<{ subject: string; number: ResolvedNumber; line: number }> = [];

  const visit = (node: ts.Node, scope: number): void => {
    let nextScope = scope;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "test") {
      nextScope = node.getStart(parsed);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const matcher = node.expression.name.text;
      // `toHaveProperty("height", 86)` names the key and the value in separate arguments, so it
      // reads as neither a bare number nor an object literal. Rewritten here into the object form
      // the rest of this function already understands.
      if (matcher === KEYED_MATCHER && node.arguments.length >= 2) {
        const key = node.arguments[0];
        const subject = expectArgument(node.expression.expression, parsed);
        const number = bareNumber(node.arguments[1]!, constants);
        if (subject && number && ts.isStringLiteral(key) && GEOMETRY_NAMES.test(key.text)
          && Math.abs(number.value) > TOLERANCE) {
          const subjectText = collapse(subject.getText(parsed));
          equalities.push({
            id: `${subjectText}.${key.text}|${matcher}|${number.text}`,
            file: "",
            line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
            kind: "equality",
            detail: `expect(${subjectText}).${matcher}("${key.text}", ${number.text})`,
          });
        }
      }
      if (ALL_MATCHERS.has(matcher)) {
        const subject = expectArgument(node.expression.expression, parsed);
        const argument = node.arguments[0];
        if (subject && argument && !isCountExpression(subject)) {
          const subjectText = collapse(subject.getText(parsed));
          // An equality is only interesting when the thing being pinned is a measurement. A narrow
          // two-sided RANGE is left unfiltered below: it is rare, it is the shape that broke CI, and
          // a range that tight on anything at all is worth a look.
          // Any measured local ANYWHERE in the subject, not only a subject that IS one. Testing the
          // whole expression meant `Math.round(size)` discarded what `size` was assigned from —
          // and `mobile-viewport.spec.ts` pins a rounded height difference in exactly that shape.
          // The enclosing test's locals, plus any declared at file scope.
          const inScope = new Set([...(measured.get(nextScope) ?? []), ...(measured.get(FILE_SCOPE) ?? [])]);
          const mentionsMeasuredLocal = [...subjectText.matchAll(/[A-Za-z_$][\w$]*/g)]
            .some((match) => inScope.has(match[0]));
          const subjectIsGeometry = measuresGeometry(subjectText) || mentionsMeasuredLocal;
          const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
          const direct = bareNumber(argument, constants);

          for (const pin of subjectLiterals(subject, constants)) {
            subjectPins.push({ subject: subjectText, number: pin, line });
          }

          if (direct !== null) {
            if (EQUALITY_MATCHERS.has(matcher) && Math.abs(direct.value) > TOLERANCE && subjectIsGeometry) {
              equalities.push({
                id: `${subjectText}|${matcher}|${direct.text}`,
                file: "",
                line,
                kind: "equality",
                detail: `expect(${subjectText}).${matcher}(${direct.text})`,
              });
            }
            if (!EQUALITY_MATCHERS.has(matcher)) {
              bounds.push({ subject: subjectText, key: groupingKey(subjectText), matcher, number: direct, line, scope: nextScope });
            }
          } else if (EQUALITY_MATCHERS.has(matcher)) {
            // `toEqual({ width: 30, height: 30 })` pins two measurements at once. NOT gated on the
            // subject: here the geometry is named by the object's keys, and `geometry.button` says
            // nothing either way.
            for (const member of structuredNumbers(argument, constants)) {
              if (Math.abs(member.number.value) <= TOLERANCE) continue;
              equalities.push({
                id: `${subjectText}${member.path}|${matcher}|${member.number.text}`,
                file: "",
                line,
                kind: "equality",
                detail: `expect(${subjectText}).${matcher}({ … ${member.path.replace(".", "")}: ${member.number.text} … })`,
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, nextScope));
  };
  visit(parsed, FILE_SCOPE);
  return { bounds, equalities, subjectPins };
}

export function scanSpec(file: string, source: string): GeometryFinding[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const relative = `apps/web/e2e/${file.slice(E2E.length + 1)}`;
  const constants = constantNumbers(parsed);
  const { bounds, equalities, subjectPins } = comparisons(parsed, constants, measuredNames(parsed));
  const findings: GeometryFinding[] = equalities.map((finding) => ({ ...finding, file: relative }));

  for (const pin of subjectPins) {
    findings.push({
      id: `${pin.subject}|subject|${pin.number.text}`,
      file: relative,
      line: pin.line,
      kind: "literal-in-subject",
      detail: `expect(${pin.subject}) measures against ${pin.number.text}`,
    });
  }

  // A lower and an upper bound over the same subject, inside the same test, close enough together
  // that they pin it. #877's `85..87` is this shape.
  const bySubject = new Map<string, Comparison[]>();
  for (const bound of bounds) {
    const key = `${bound.scope}|${bound.key}`;
    bySubject.set(key, [...(bySubject.get(key) ?? []), bound]);
  }
  for (const group of bySubject.values()) {
    const lower = group.filter((one) => LOWER_BOUND_MATCHERS.has(one.matcher));
    const upper = group.filter((one) => UPPER_BOUND_MATCHERS.has(one.matcher));
    if (lower.length === 0 || upper.length === 0) continue;
    const floor = Math.max(...lower.map((one) => one.number.value));
    const ceiling = Math.min(...upper.map((one) => one.number.value));
    const midpoint = (floor + ceiling) / 2;
    // MAGNITUDE. A card pinned to -87..-85 is pinned exactly as hard as one pinned to 85..87, and
    // comparing the signed midpoint to the tolerance discarded every range over a negative
    // coordinate — which is most of the ones that matter, since offsets go both ways.
    if (Math.abs(midpoint) <= TOLERANCE) continue;
    // `>= 86` with `<= 86` pins harder than #877's range did, and `ceiling > floor` used to let it
    // through. An inclusive pair may be equal; only a genuinely inverted pair is not a range.
    const inclusivePair = lower.some((one) => INCLUSIVE_MATCHERS.has(one.matcher))
      && upper.some((one) => INCLUSIVE_MATCHERS.has(one.matcher));
    if (ceiling < floor || (ceiling === floor && !inclusivePair)) continue;
    if ((ceiling - floor) / Math.abs(midpoint) >= NARROW_RANGE) continue;
    const first = group[0]!;
    findings.push({
      id: `${first.subject}|range|${floor}..${ceiling}`,
      file: relative,
      line: Math.min(...group.map((one) => one.line)),
      kind: "narrow-range",
      detail: `${first.subject} is pinned to ${floor}..${ceiling}`,
    });
  }

  // Two identical assertions in one file are two sites, and one exemption must not cover both.
  const seen = new Map<string, number>();
  return findings
    .map((finding) => {
      const occurrence = (seen.get(finding.id) ?? 0) + 1;
      seen.set(finding.id, occurrence);
      return { ...finding, id: `${relative}|${finding.id}${occurrence > 1 ? `|#${occurrence}` : ""}` };
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
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
    .filter((entry) => {
      // TRIMMED, and case-insensitive. Checking the raw string meant a leading space turned the
      // placeholder into an accepted reason, which is the one thing this test exists to prevent.
      const reason = entry.reason.trim();
      return reason.length === 0 || reason.toUpperCase().startsWith("TODO");
    })
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

// --- Every route two reviewers found through the first version of this scanner ---
//
// The first cut matched literal shapes only, and each of these walked straight past it. They are
// kept as tests rather than as a changelog because a scanner's value is exactly the set of things it
// cannot be talked out of, and every one of these is an idiom already present in this suite.

test("a bound named by a constant is still a bound", () => {
  const source = 'const CARD = 86;\ntest("t", () => { expect(card.height).toBe(CARD); });';
  assert.deepEqual(sample(source).map((finding) => finding.detail), ["expect(card.height).toBe(CARD)"]);
});

test("a range whose bounds are object members is still a range", () => {
  const source = [
    "const RAIL = { min: 85, max: 87 } as const;",
    'test("t", () => {',
    "  expect(rail.height).toBeGreaterThanOrEqual(RAIL.min);",
    "  expect(rail.height).toBeLessThanOrEqual(RAIL.max);",
    "});",
  ].join("\n");
  assert.deepEqual(sample(source).map((finding) => finding.kind), ["narrow-range"]);
});

test("arithmetic bounds are folded, not stringified", () => {
  // `Number("80+5")` is NaN, which silently disabled the range check for every computed bound.
  const source = 'test("t", () => { expect(h).toBeGreaterThanOrEqual(80 + 5); expect(h).toBeLessThanOrEqual(90 - 3); });';
  assert.deepEqual(sample(source).map((finding) => finding.detail), ["h is pinned to 85..87"]);
});

test("an inclusive pair on one value is a pin, even with no width at all", () => {
  // Stricter than the 85..87 that motivated this file, and `ceiling > floor` used to let it through.
  const source = 'test("t", () => { expect(h).toBeGreaterThanOrEqual(86); expect(h).toBeLessThanOrEqual(86); });';
  assert.deepEqual(sample(source).map((finding) => finding.detail), ["h is pinned to 86..86"]);
});

test("expect.soft and expect.poll pin exactly as hard as expect", () => {
  assert.deepEqual(sample("expect.soft(card.height).toBe(86);").map((finding) => finding.detail),
    ["expect(card.height).toBe(86)"]);
  assert.deepEqual(sample("await expect.poll(() => box.height).toBe(86);").map((finding) => finding.detail),
    ["expect(box.height).toBe(86)"]);
});

test("a size nested in an object comparison is not a hiding place", () => {
  const source = "expect(geometry.button).toEqual({ width: 30, height: 30 });";
  assert.deepEqual(sample(source).map((finding) => finding.kind), ["equality", "equality"]);
});

test("a literal subtracted inside the subject is a pin wearing a tolerance", () => {
  const source = "expect(Math.abs(card.height - 86)).toBeLessThanOrEqual(1);";
  assert.deepEqual(sample(source).map((finding) => finding.kind), ["literal-in-subject"]);
});

test("a measurement renamed to a count word is still a measurement", () => {
  // `size` and `position` were exempt by name, whatever they held.
  const source = 'test("t", () => { const size = box.height; expect(size).toBe(86); });';
  assert.deepEqual(sample(source).map((finding) => finding.detail), ["expect(size).toBe(86)"]);
});

test("one exemption does not cover a second identical assertion", () => {
  const source = [
    'test("a", () => { expect(icon.width).toBe(15); });',
    'test("b", () => { expect(icon.width).toBe(15); });',
  ].join("\n");
  const ids = sample(source).map((finding) => finding.id);
  assert.equal(new Set(ids).size, 2, "two sites are two identities");
});

test("a midpoint divisor is not a pin", () => {
  // `/ 2` is how every centre-alignment check in the suite is written; reading it as a pinned size
  // reported a dozen honest assertions and taught nothing.
  const source = "expect(Math.abs((a.x + a.width / 2) - (b.x + b.width / 2))).toBeLessThanOrEqual(1);";
  assert.deepEqual(sample(source), []);
});

test("a number that is not a measurement is left alone", () => {
  // The equality rule is gated on the subject being geometric. Without that gate this file reported
  // thirty call counts, cursor offsets and device pixel ratios, and buried the four real findings.
  const source = [
    "expect(await page.evaluate(() => window.__calls)).toBe(3);",
    "expect(await composer.evaluate((el) => el.selectionStart)).toBe(8);",
    "expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1.25);",
  ].join("\n");
  assert.deepEqual(sample(source), []);
});

// --- Round two's routes. Three of these had live instances in the suite that the scanner could not
// see, which is the only evidence that matters about whether a guard like this is working. ---

test("a poll callback with a block body still yields the value the matcher compares", () => {
  // Live at remote-instances.spec.ts, twice, and invisible: returning null for a block body skipped
  // the assertion rather than reading its `return`.
  const source = "await expect.poll(async () => { const box = await card.boundingBox(); return box!.height; }).toBe(86);";
  assert.deepEqual(sample(source).map((finding) => finding.detail), ["expect(box!.height).toBe(86)"]);
});

test("an array of shapes pins every coordinate in it", () => {
  // Live at command-inbox-projects.spec.ts and session-header.spec.ts. The comment claimed arrays
  // were walked; only objects were.
  const source = "expect(dotGeometry).toEqual([{ x: 12, y: 5 }, { x: 12, y: 12 }]);";
  assert.equal(sample(source).length, 4, "two elements, two geometry keys each");
});

test("wrapping a measured local does not launder it", () => {
  // Live at mobile-viewport.spec.ts. Provenance was tested against the WHOLE subject, so `size`
  // alone was recognised and `Math.round(size)` was not.
  const source = 'test("t", () => { const size = (await card.boundingBox())!.height; expect(Math.round(size)).toBe(86); });';
  assert.deepEqual(sample(source).map((finding) => finding.detail), ["expect(Math.round(size)).toBe(86)"]);
});

test("a type assertion does not hide a bound", () => {
  for (const suffix of ["as const", "satisfies number"]) {
    const source = `test("t", () => { expect(phone).toBeGreaterThanOrEqual(85 ${suffix}); expect(phone).toBeLessThanOrEqual(87 ${suffix}); });`;
    assert.deepEqual(sample(source).map((finding) => finding.detail), ["phone is pinned to 85..87"], suffix);
  }
});

test("a range over a negative coordinate is still a range", () => {
  // Offsets go both ways, and comparing the SIGNED midpoint to the tolerance discarded every range
  // centred below zero however tight it was.
  const source = 'test("t", () => { expect(card.x).toBeGreaterThanOrEqual(-87); expect(card.x).toBeLessThanOrEqual(-85); });';
  assert.deepEqual(sample(source).map((finding) => finding.detail), ["card.x is pinned to -87..-85"]);
});

test("two tests may reuse a local name without one lending the other its meaning", () => {
  // The file-wide set read `value` in the second test as geometry because the first test measured
  // into a local of that name. The sentinel for file scope was 0, and a `test(` call at the start of
  // a file starts at 0 — so the first test's locals leaked into every scope through the sentinel.
  const source = [
    'test("a", () => { const value = box.height; expect(value).toBe(86); });',
    'test("b", () => { const value = requestCount(); expect(value).toBe(3); });',
  ].join("\n");
  assert.deepEqual(sample(source).map((finding) => finding.detail), ["expect(value).toBe(86)"]);
});

// --- Round three. Every one of these is an ordinary way to write an assertion, which is the point:
// the routes that matter are the ones an author reaches for without thinking. ---

test("a negated assertion rejects a value rather than pinning it", () => {
  // This was a FALSE positive, and the only remedy on offer would have been an allowlist entry
  // claiming a legitimate assertion was a pin.
  assert.deepEqual(sample("expect(card.height).not.toBe(86);"), []);
});

test("toHaveProperty names the key and the value separately, and still pins", () => {
  const source = 'expect((await card.boundingBox())!).toHaveProperty("height", 86);';
  assert.equal(sample(source).length, 1);
});

test("toContainEqual and a nested object are both reached", () => {
  assert.equal(sample("expect(boxes).toContainEqual({ height: 86 });").length, 1);
  assert.equal(sample("expect(layout).toMatchObject({ card: { height: 86 } });").length, 1);
  assert.equal(sample("expect(box).toMatchObject({ ...{ height: 86 } });").length, 1);
});

test("a destructured alias carries its provenance", () => {
  const source = 'test("t", () => { const { height: value } = (await card.boundingBox())!; expect(value).toBe(86); });';
  assert.deepEqual(sample(source).map((finding) => finding.detail), ["expect(value).toBe(86)"]);
});

test("a poll callback is read for ANY returned measurement, not only its last return", () => {
  const source = "await expect.poll(async () => { const box = await card.boundingBox(); if (box) return box.height; return fallback; }).toBe(86);";
  assert.deepEqual(sample(source).map((finding) => finding.detail), ["expect(box.height).toBe(86)"]);
});

test("a large divisor normalises a measurement; a small one centres it", () => {
  // `card.height / 86` compares to 1 and pins the height exactly as hard as equality would.
  assert.equal(sample("expect(card.height / 86).toBeCloseTo(1);").length, 1);
  // `/ 2` is how every centring check in this suite is written and must stay clean.
  assert.deepEqual(sample("expect(Math.abs((a.x + a.width / 2) - (b.x + b.width / 2))).toBeLessThanOrEqual(1);"), []);
});
