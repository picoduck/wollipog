import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { ApiError } from "./api.js";
import { archiveAndStopMessage } from "./archive-actions.js";
import { closeWarning } from "./components/DesktopCloseGuard.js";
import { heldUpdateMessage } from "./desktop-updates.js";
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
/**
 * AGENTS.md and docs/design-system.md §17.1: the particle of a phrasal verb is part of the verb and
 * is capitalized ("Set Up This Project", "Sign In", "Start Over"), although "up", "in", "on" and
 * "over" are otherwise lowercase prepositions. A particle counts as one when it directly follows a
 * verb from this list; a preposition after any other word keeps the minor-word rule ("Open in
 * Browser"). The list is the verbs this app's labels actually use, so it is closed on purpose.
 */
const PHRASAL_PARTICLES = new Set(["down", "in", "off", "on", "out", "over", "up"]);
const PHRASAL_VERBS = new Set([
  "back", "check", "clean", "follow", "hand", "log", "look", "opt", "pick", "set", "sign", "start",
  "take", "turn",
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
    if (index > 0 && PHRASAL_PARTICLES.has(lower) && PHRASAL_VERBS.has(words[index - 1]!.toLowerCase())) {
      return /^[A-Z]/.test(word);
    }
    if (index > 0 && index < words.length - 1 && MINOR_WORDS.has(lower)) return word === lower;
    return /^[A-Z]/.test(word);
  });
}

/**
 * A consent checkbox's label is a sentence the user agrees to (§8.4, §17.1): the first word is
 * capitalized and the rest stay lowercase, apart from acronyms and proper names in capitals.
 */
function isSentenceCase(value: string): boolean {
  const words = value.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  return words.every((word, index) => index === 0
    ? /^[A-Z]/.test(word)
    : word === word.toLowerCase() || /^[A-Z0-9]+(?:[-/][A-Z0-9]+)*$/.test(word));
}

/** Whether a JSX element carries a bare boolean attribute such as `consent`. */
function hasFlag(owner: ts.JsxOpeningLikeElement, name: string, sourceFile: ts.SourceFile): boolean {
  return owner.attributes.properties.some((property) => ts.isJsxAttribute(property)
    && property.name.getText(sourceFile) === name
    && (!property.initializer || (ts.isJsxExpression(property.initializer)
      && property.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword)));
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
        // A JsxAttribute sits in JsxAttributes; the element that owns it is one level further up.
        const owner = node.parent.parent;
        const tag = ts.isJsxOpeningLikeElement(owner) ? owner.tagName.getText(sourceFile) : "";
        const consent = tag === "Checkbox" && ts.isJsxOpeningLikeElement(owner) && hasFlag(owner, "consent", sourceFile);
        if (consent && name === "label") {
          // Checked below as a sentence instead.
        } else if (name === "aria-label" || name === "ariaLabel" || name === "data-menu-label" || name === "label" || (name === "title" && (tag === "State" || tag === "Notice" || tag === "Modal"))) {
          report(node, name, node.initializer.text);
        }
      }
      // A ChoiceRow's title is its label (§8.4): every static title in a ChoiceRows `options` list.
      if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === "options" && node.initializer &&
          ts.isJsxExpression(node.initializer) && node.initializer.expression &&
          ts.isJsxOpeningLikeElement(node.parent.parent) && node.parent.parent.tagName.getText(sourceFile) === "ChoiceRows") {
        const titles = (inner: ts.Node) => {
          if (ts.isPropertyAssignment(inner) && ts.isIdentifier(inner.name) && inner.name.text === "title") {
            for (const branch of staticBranches(inner.initializer) ?? []) report(inner, "ChoiceRow title", branch);
          }
          ts.forEachChild(inner, titles);
        };
        titles(node.initializer.expression);
      }
      // A dialog title chosen by a condition is still a title (§7.2): read every branch.
      if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === "title" && node.initializer &&
          ts.isJsxExpression(node.initializer) && node.initializer.expression &&
          ts.isJsxOpeningLikeElement(node.parent.parent) && node.parent.parent.tagName.getText(sourceFile) === "Modal") {
        for (const branch of staticBranches(node.initializer.expression) ?? []) {
          report(node, "Modal title", branch);
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

test("consent checkbox labels are sentences, and every other checkbox label is Title Case", () => {
  const failures: string[] = [];
  let consents = 0;
  let labels = 0;
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("<Checkbox")) continue;
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningLikeElement(node) && node.tagName.getText(sourceFile) === "Checkbox") {
        const consent = hasFlag(node, "consent", sourceFile);
        const label = node.attributes.properties.find((property): property is ts.JsxAttribute =>
          ts.isJsxAttribute(property) && property.name.getText(sourceFile) === "label");
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const where = `${path.relative(SOURCE_ROOT, file)}:${line}`;
        if (!label?.initializer) failures.push(`${where} Checkbox has no visible label`);
        else {
          const expression = ts.isStringLiteral(label.initializer) ? label.initializer
            : ts.isJsxExpression(label.initializer) ? label.initializer.expression : undefined;
          // A template's holes are data (a skill name), so only its static words are read.
          const branches = expression && ts.isTemplateExpression(expression)
            ? [expression.head.text + expression.templateSpans.map((span) => ` x${span.literal.text}`).join("")]
            : expression ? staticBranches(expression) : null;
          for (const branch of branches ?? []) {
            labels += 1;
            if (consent) {
              consents += 1;
              if (!isSentenceCase(branch)) failures.push(`${where} consent label is not a sentence: ${JSON.stringify(branch)}`);
            } else if (!isTitleCase(branch.replace(/ x\b/g, " X"))) {
              failures.push(`${where} checkbox label is not Title Case: ${JSON.stringify(branch)}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  assert.deepEqual(failures, [], failures.join("\n"));
  // Not vacuous: the scan found the consent labels in the Skills review dialogs and ordinary ones.
  assert.ok(consents >= 8, `found ${consents} consent labels`);
  assert.ok(labels - consents >= 8, `found ${labels - consents} ordinary checkbox labels`);
});

test("the copy rules tell a sentence from a title", () => {
  assert.equal(isSentenceCase("Accept version diff and update existing assignments"), true);
  assert.equal(isSentenceCase("Accept Version Diff and Update Existing Assignments"), false);
  assert.equal(isSentenceCase("Open the PR after creating it"), true);
  assert.equal(isTitleCase("Include Session Name"), true);
  assert.equal(isTitleCase("Include session name"), false);
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
const COMPUTED_BODIES = [/^archiveAndStopMessage\(/, /^conflict\.message$/, /^closeWarning\(/, /^heldUpdateMessage\(/];

/**
 * Every text a confirmation body can produce: conditions, template holes and `+` concatenation are
 * followed, and a local constant is read through (`fenced` in the skill copy discard). A template
 * hole the reader cannot follow is a name (`“${target.name}”`). A condition branch or `+` operand it
 * cannot follow is copy it cannot see, so the whole body is unreadable (`null`) and must be a known,
 * separately tested helper (COMPUTED_BODIES).
 */
function bodyBranches(node: ts.Expression, sourceFile: ts.SourceFile): string[] | null {
  const unreadable = { found: false };
  const branches = readBody(node, sourceFile, unreadable);
  return unreadable.found ? null : branches;
}

function readBody(node: ts.Expression, sourceFile: ts.SourceFile, unreadable: { found: boolean }): string[] | null {
  const bodyBranches = (inner: ts.Expression, file: ts.SourceFile) => readBody(inner, file, unreadable);
  const required = (branches: string[] | null) => {
    if (!branches) unreadable.found = true;
    return branches ?? ["Name"];
  };
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
    return [...required(bodyBranches(node.whenTrue, sourceFile)), ...required(bodyBranches(node.whenFalse, sourceFile))];
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return combine(required(bodyBranches(node.left, sourceFile)), required(bodyBranches(node.right, sourceFile)));
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
    if (!found) return null;
    // A constant that is not fully readable copy (`sessionCount`) is a value, like any other name.
    const inner = { found: false };
    const branches = readBody(found, sourceFile, inner);
    return inner.found ? null : branches;
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
 * mark, and its confirm button is required and repeats the title's verb. A cancel label and a secondary
 * action's label are button labels too: literal Title Case copy. `ConfirmationOptions` makes the confirm
 * label required for TypeScript; this reads every caller so the copy rule itself cannot drift.
 */
function confirmationCopyFailures(file: string, source: string): { failures: string[]; checked: number } {
  const failures: string[] = [];
  let checked = 0;
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
          const property = (name: string, owner = literal) => owner.properties.find((entry): entry is ts.PropertyAssignment =>
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
          // The safe choice and the harmless extra action are buttons: literal Title Case labels.
          const cancelLabel = property("cancelLabel");
          const secondary = property("secondaryAction");
          const secondaryLabel = secondary && ts.isObjectLiteralExpression(secondary.initializer)
            ? property("label", secondary.initializer)
            : undefined;
          if (secondary && !secondaryLabel) failures.push(`${where(secondary)} secondary action label must be literal copy`);
          for (const [name, assignment] of [["cancel label", cancelLabel], ["secondary action label", secondaryLabel]] as const) {
            if (!assignment) continue;
            const values = staticBranches(assignment.initializer);
            if (!values) {
              failures.push(`${where(assignment)} ${name} must be literal copy`);
              continue;
            }
            for (const value of values) {
              if (!isTitleCase(value)) failures.push(`${where(assignment)} ${name} is not Title Case: ${JSON.stringify(value)}`);
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
  return { failures, checked };
}

test("every confirmation names its action in the title and its outcome on the button", () => {
  const failures: string[] = [];
  let checked = 0;
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("confirm")) continue;
    const result = confirmationCopyFailures(file, source);
    failures.push(...result.failures);
    checked += result.checked;
  }
  assert.ok(checked >= 38, `expected to read every confirmation caller, read ${checked}`);
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("a confirmation's cancel label and secondary action label are literal Title Case copy", () => {
  const read = (options: string) => confirmationCopyFailures(path.join(SOURCE_ROOT, "fixture.tsx"),
    `confirm({ title: "Quit Wollipog", message: "Sessions on this computer stop.", confirmLabel: "Quit Wollipog", ${options} });`).failures;
  assert.deepEqual(read(`cancelLabel: "Keep Open", secondaryAction: { label: "Show Sessions", run: showSessions }`), []);
  assert.deepEqual(read(`cancelLabel: held ? "Install Later" : "Keep Open"`), []);
  assert.deepEqual(read(`cancelLabel: "keep open"`), ['fixture.tsx:1 cancel label is not Title Case: "keep open"']);
  assert.deepEqual(read(`cancelLabel: serverCopy`), ["fixture.tsx:1 cancel label must be literal copy"]);
  assert.deepEqual(read(`secondaryAction: { label: "Show sessions", run: showSessions }`),
    ['fixture.tsx:1 secondary action label is not Title Case: "Show sessions"']);
  assert.deepEqual(read(`secondaryAction: { label: serverCopy, run: showSessions }`),
    ["fixture.tsx:1 secondary action label must be literal copy"]);
  assert.deepEqual(read(`secondaryAction: showSessionsAction`), ["fixture.tsx:1 secondary action label must be literal copy"]);
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
    ...[0, 1, 3].map((count) => closeWarning(count)),
    ...["0.29.0", null].flatMap((version) => [0, 1, 3].map((count) => heldUpdateMessage(version, count))),
  ];
  assert.equal(bodies.length, 22);
  for (const body of bodies) assert.ok(sentenceCount(body) <= 2, JSON.stringify(body));
});

test("the confirmation body reader treats copy it cannot see as unreadable, and names as names", () => {
  const read = (source: string) => {
    const file = ts.createSourceFile("body.ts", source, ts.ScriptTarget.Latest, true);
    const statement = file.statements.at(-1)!;
    assert.ok(ts.isExpressionStatement(statement));
    return bodyBranches(statement.expression, file);
  };
  assert.equal(read(`useServerCopy ? serverCopy : "Safe."`), null, "an unreadable condition branch");
  assert.equal(read(`"Delivery stops. " + serverCopy`), null, "an unreadable concatenation operand");
  assert.deepEqual(read(`\`“\${target.name}” is removed.\``), ["“Name” is removed."], "a name in a template hole");
  assert.deepEqual(read(`const fenced = "It is kept."; \`Gone. \${fenced}\``), ["Gone. It is kept."], "a local constant");
  assert.deepEqual(read(`const count = a ? b.length : c.length; \`All \${count} are removed.\``), ["All Name are removed."],
    "a constant holding a value is a name");
});
