import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { ApiError } from "./api.js";
import { archiveAndStopMessage } from "./archive-actions.js";
import { lifecycleConflictPresentation } from "./components/RunnersView.js";

const SOURCE_ROOT = path.resolve("apps/web/src");
const MINOR_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "from",
  "in",
  "into",
  "nor",
  "of",
  "on",
  "or",
  "over",
  "per",
  "the",
  "to",
  "up",
  "via",
  "with",
]);
const LABEL_TAGS = new Set(["button", "caption", "dt", "h1", "h2", "h3", "h4", "h5", "h6", "legend", "summary", "th"]);
const LABEL_PROPERTIES = new Set(["actionLabel", "cancelLabel", "confirmLabel", "label", "paletteLabel"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const target = path.join(directory, entry);
    if (statSync(target).isDirectory()) return sourceFiles(target);
    if (!/\.(?:ts|tsx)$/.test(entry) || /\.test\.(?:ts|tsx)$/.test(entry) || entry.endsWith(".d.ts")) return [];
    return [target];
  });
}

function compactLabel(value: string): string | null {
  const normalized = value
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    !normalized ||
    normalized.split(/\s+/).length > 8 ||
    /[.!?]$/.test(normalized) ||
    !/[A-Za-z]/.test(normalized)
  ) return null;
  return normalized;
}

function isTitleCase(value: string): boolean {
  const words = value.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  return words.every((word, index) => {
    if (/^[A-Z0-9]+(?:[-/][A-Z0-9]+)*$/.test(word)) return true;
    const lower = word.toLowerCase();
    if (index > 0 && index < words.length - 1 && MINOR_WORDS.has(lower)) return word === lower;
    return /^[A-Z]/.test(word);
  });
}

test("static compact UI labels use Title Case", () => {
  const failures: string[] = [];
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const report = (node: ts.Node, kind: string, value: string) => {
      const label = compactLabel(value);
      if (!label || isTitleCase(label)) return;
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      failures.push(`${path.relative(SOURCE_ROOT, file)}:${line} ${kind}: ${JSON.stringify(label)}`);
    };
    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node) && ts.isJsxElement(node.parent)) {
        const tag = node.parent.openingElement.tagName.getText(sourceFile);
        if (LABEL_TAGS.has(tag)) report(node, `<${tag}>`, node.text);
      }
      if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
        const name = node.name.getText(sourceFile);
        const tag = ts.isJsxOpeningLikeElement(node.parent) ? node.parent.tagName.getText(sourceFile) : "";
        if (name === "aria-label" || name === "data-menu-label" || name === "label" || (name === "title" && (tag === "Empty" || tag === "Modal"))) {
          report(node, name, node.initializer.text);
        }
      }
      // A dialog title chosen by a condition is still a title (§7.2): read every branch.
      if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === "title" && node.initializer &&
          ts.isJsxExpression(node.initializer) && node.initializer.expression &&
          ts.isJsxOpeningLikeElement(node.parent.parent) && node.parent.parent.tagName.getText(sourceFile) === "Modal") {
        for (const branch of staticBranches(node.initializer.expression) ?? []) {
          // §17.1 capitalizes a phrasal-verb particle ("Set Up This Machine"), which the minor-word
          // list would otherwise read as a lowercase preposition.
          report(node, "Modal title", branch.replace(/\b(Set|Sign|Log|Back) Up\b/g, "$1 up"));
          if (branch.trim().endsWith("?")) failures.push(`${path.relative(SOURCE_ROOT, file)} Modal title is a question: ${JSON.stringify(branch)}`);
        }
      }
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        LABEL_PROPERTIES.has(node.name.text) &&
        ts.isStringLiteralLike(node.initializer)
      ) {
        report(node, node.name.text, node.initializer.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

/** Every string a title or label expression can produce; template holes read as a placeholder word. */
function staticBranches(node: ts.Expression): string[] | null {
  if (ts.isParenthesizedExpression(node)) return staticBranches(node.expression);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    return [node.head.text + node.templateSpans.map((span) => `Name${span.literal.text}`).join("")];
  }
  if (ts.isConditionalExpression(node)) {
    const whenTrue = staticBranches(node.whenTrue);
    const whenFalse = staticBranches(node.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  return null;
}

const MAX_BODY_BRANCHES = 256;

/**
 * Confirmation bodies built by a helper the static reader cannot follow. Each one has its own
 * sentence check below; a new unreadable body fails until it is listed here and tested.
 */
const COMPUTED_BODIES = [/^archiveAndStopMessage\(/, /^conflict\.message$/];

/**
 * Every text a confirmation body can produce: conditions, template holes and `+` concatenation are
 * followed, and a local constant is read through (`fenced` in the skill copy discard). A value this
 * cannot read — a message the server sends — is `null`: it is not static copy.
 */
function bodyBranches(node: ts.Expression, sourceFile: ts.SourceFile): string[] | null {
  const combine = (left: string[], right: string[]) =>
    left.flatMap((head) => right.map((tail) => head + tail)).slice(0, MAX_BODY_BRANCHES);
  const orPlaceholder = (branches: string[] | null) => branches ?? ["Name"];
  if (ts.isParenthesizedExpression(node)) return bodyBranches(node.expression, sourceFile);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    let branches = [node.head.text];
    for (const span of node.templateSpans) {
      branches = combine(combine(branches, orPlaceholder(bodyBranches(span.expression, sourceFile))), [span.literal.text]);
    }
    return branches;
  }
  if (ts.isConditionalExpression(node)) {
    const whenTrue = bodyBranches(node.whenTrue, sourceFile);
    const whenFalse = bodyBranches(node.whenFalse, sourceFile);
    if (!whenTrue && !whenFalse) return null;
    return [...(whenTrue ?? []), ...(whenFalse ?? [])];
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = bodyBranches(node.left, sourceFile);
    const right = bodyBranches(node.right, sourceFile);
    if (!left && !right) return null;
    return combine(orPlaceholder(left), orPlaceholder(right));
  }
  if (ts.isIdentifier(node)) {
    let found: ts.Expression | undefined;
    const find = (candidate: ts.Node) => {
      if (!found && ts.isVariableDeclaration(candidate) && ts.isIdentifier(candidate.name) &&
          candidate.name.text === node.text && candidate.initializer &&
          (candidate.parent.flags & ts.NodeFlags.Const) !== 0) {
        found = candidate.initializer;
      }
      ts.forEachChild(candidate, find);
    };
    find(sourceFile);
    return found ? bodyBranches(found, sourceFile) : null;
  }
  return null;
}

/**
 * A sentence ends at `.`, `!` or `?` followed by space and anything but a lowercase letter, or by the end:
 * "v0.1" and "e.g. a" do not split, "One. 2 files…" does. Trailing text with no final stop is a sentence too.
 */
function sentenceCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const ends = trimmed.match(/[.!?](?=\s+[^\sa-z]|\s*$)/g)?.length ?? 0;
  return /[.!?]$/.test(trimmed) ? ends : ends + 1;
}

function optionLiterals(node: ts.Expression): ts.ObjectLiteralExpression[] {
  if (ts.isParenthesizedExpression(node)) return optionLiterals(node.expression);
  if (ts.isObjectLiteralExpression(node)) return [node];
  if (ts.isConditionalExpression(node)) return [...optionLiterals(node.whenTrue), ...optionLiterals(node.whenFalse)];
  return [];
}

/**
 * docs/design-system.md §7.4 and §17: a confirmation's title is the action in Title Case with no question
 * mark, and its confirm button is required and repeats the title's verb. `ConfirmationOptions` makes the
 * label required for TypeScript; this reads every caller so the copy rule itself cannot drift.
 */
test("every confirmation names its action in the title and its outcome on the button", () => {
  const failures: string[] = [];
  let checked = 0;
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("confirm")) continue;
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const where = (node: ts.Node) =>
      `${path.relative(SOURCE_ROOT, file)}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sourceFile);
        if (callee === "window.confirm") failures.push(`${where(node)} window.confirm is banned; use useFeedback().confirm`);
        const isConfirm = callee === "confirm" || callee.endsWith(".confirm") || callee === "confirmWhileAllowed";
        if (isConfirm && callee !== "window.confirm") {
          for (const literal of node.arguments.flatMap(optionLiterals)) {
            const property = (name: string) => literal.properties.find((entry): entry is ts.PropertyAssignment =>
              ts.isPropertyAssignment(entry) && ts.isIdentifier(entry.name) && entry.name.text === name);
            const title = property("title");
            if (!title) continue;
            checked += 1;
            const label = property("confirmLabel");
            if (!label) {
              failures.push(`${where(literal)} confirmation has no confirmLabel`);
              continue;
            }
            const message = property("message");
            const bodies = message ? bodyBranches(message.initializer, sourceFile) : null;
            if (message && !bodies && !COMPUTED_BODIES.some((pattern) => pattern.test(message.initializer.getText(sourceFile)))) {
              failures.push(`${where(message)} body is not readable copy; add its helper to COMPUTED_BODIES and test it there`);
            }
            for (const body of bodies ?? []) {
              if (sentenceCount(body) > 2) {
                failures.push(`${where(message!)} body is longer than two sentences (§7.4): ${JSON.stringify(body)}`);
              }
            }
            const titles = staticBranches(title.initializer);
            const labels = staticBranches(label.initializer);
            if (!titles || !labels) {
              failures.push(`${where(literal)} confirmation title and label must be literal copy`);
              continue;
            }
            for (const value of titles) {
              if (value.trim().endsWith("?")) failures.push(`${where(title)} title ends in "?": ${JSON.stringify(value)}`);
              if (!isTitleCase(value)) failures.push(`${where(title)} title is not Title Case: ${JSON.stringify(value)}`);
              const verb = value.split(/\s+/)[0];
              if (!labels.some((candidate) => candidate.split(/\s+/)[0] === verb)) {
                failures.push(`${where(label)} no confirm label repeats the verb of ${JSON.stringify(value)}`);
              }
            }
            for (const value of labels) {
              if (/^(continue|ok|submit|yes)$/i.test(value.trim())) failures.push(`${where(label)} generic confirm label: ${JSON.stringify(value)}`);
              if (!isTitleCase(value)) failures.push(`${where(label)} label is not Title Case: ${JSON.stringify(value)}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  assert.ok(checked >= 38, `expected to read every confirmation caller, read ${checked}`);
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("the confirmation sentence count reads sentences, not every dot", () => {
  assert.equal(sentenceCount("“Fix rounding” stops now. You can restore it."), 2);
  assert.equal(sentenceCount("Version v0.1.2 of the skill, e.g. from Git, is kept."), 1);
  assert.equal(sentenceCount("It is deleted only if it still matches; if it changed, nothing is deleted."), 1);
  assert.equal(sentenceCount("One. Two! Three? "), 3);
  assert.equal(sentenceCount("One. 2 files are removed. This cannot be undone."), 3);
  assert.equal(sentenceCount("A fragment with no final stop"), 1);
  assert.equal(sentenceCount("Done. And a trailing fragment"), 2);
});

test("confirmation bodies built by a helper are one or two sentences too", () => {
  const bodies = [
    ...[null, "Fix the half-cent rounding bug"].flatMap((title) => [true, false].map((retrying) => archiveAndStopMessage(title, retrying))),
    ...(["update", "reconnect", "adopt"] as const).flatMap((action) => [undefined, 1, 3].map((count) =>
      lifecycleConflictPresentation(new ApiError("conflict", 409, "conflict", count === undefined ? {} : { activeSessionCount: count }), action).message)),
  ];
  assert.equal(bodies.length, 13);
  for (const body of bodies) assert.ok(sentenceCount(body) <= 2, JSON.stringify(body));
});
