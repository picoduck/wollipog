import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as React from "react";
import ts from "typescript";
import type { SessionReminderView } from "@wollipog/protocol";
import { ApiError } from "./api.js";
import { archiveAndStopMessage } from "./archive-actions.js";
import { projectArchiveMessage } from "./project-actions.js";
import { deleteSessionMessage, signOutOfAgentMessage, stopArchivedSessionMessage, stopSessionMessage } from "./session-confirmation-copy.js";
import { STOP_JOB_OUTCOME } from "./background-job-stop.js";
import { closeWarning } from "./components/DesktopCloseGuard.js";
import { heldUpdateMessage } from "./desktop-updates.js";
import { HIDDEN_IDENTIFIER_TEXT } from "./components/PersonalIdentifier.js";
import { lifecycleConflictPresentation } from "./components/RunnersView.js";
import { backLabel } from "./navigation.js";
import { reminderMenuActionLabel } from "./session-reminders.js";
import {
  DEPLOY_TO_TRACKING_MACHINES_CONSENT,
  deployToAssignmentsConsent,
  switchAgentsConsent,
} from "./components/ReviewConsent.js";
import { copyShortcutHelper, includeTitleHelper, TRANSCRIPT_SHARE_COPY } from "./components/TranscriptShareDialog.js";
import {
  CHOOSE_DESTINATION_LABEL,
  DESTINATION_MENU_LABEL,
  offlineDestinationNote,
  openDestinationLabel,
} from "./components/EditorSelect.js";
import { TERMINAL_UPDATE_NOTE } from "./components/SessionPanelToggles.js";
import { messageActions, turnActions } from "./components/EventTimeline.js";
import { shareCreatedLabel, shareExpiryLabel, shareMoment } from "./transcript-share-time.js";
import {
  moreRequestsLabel,
  pendingRequestsTitle,
  REQUEST_CARD_COPY,
  requestKindMeta,
  requestPolicyLine,
} from "./components/requests/request-meta.js";
import { ASK_MARKER_COPY } from "./components/requests/AskMarker.js";
import { QUESTION_CARD_COPY, questionStepLabel } from "./components/requests/QuestionStep.js";
import { SIGN_IN_COPY } from "./components/AuthenticationRecoveryPanel.js";

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
  "back", "check", "clean", "follow", "hand", "log", "look", "opt", "pick", "set", "sign", "signed", "start",
  "take", "turn",
]);
const LABEL_TAGS = new Set(["button", "caption", "dt", "h1", "h2", "h3", "h4", "h5", "h6", "legend", "summary", "th"]);
const LABEL_PROPERTIES = new Set(["actionLabel", "cancelLabel", "confirmLabel", "label"]);

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

function parseSource(file: string, source = readFileSync(file, "utf8")): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** One static string a person reads. `label` marks the compact labels held to Title Case (§17.1). */
interface UiCopy {
  node: ts.Node;
  kind: string;
  value: string;
  label: boolean;
}

/** Attributes whose text is shown or announced beyond the label attributes: tooltips, placeholders, alt text. */
const TEXT_ATTRIBUTES = new Set(["alt", "aria-description", "placeholder", "title", ...LABEL_PROPERTIES]);
/** Elements whose text is a literal value (a command, a path, a status), not copy. */
const LITERAL_TAGS = new Set(["code", "kbd", "pre", "samp"]);

/**
 * The literal copy an expression can show, read word by word rather than as a whole label. Branches
 * and fallbacks (`??`, `||`, the right of `&&`) are copy; a condition's test and a call's arguments
 * are code (`status === "cancelled"`, `statusMeta("cancelled")`), so they are never read. A template
 * hole reads as a placeholder word.
 */
function copyLiterals(node: ts.Expression): string[] {
  if (ts.isParenthesizedExpression(node)) return copyLiterals(node.expression);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [node.head.text + node.templateSpans.map((span) => `Name${span.literal.text}`).join("")];
  if (ts.isConditionalExpression(node)) return [...copyLiterals(node.whenTrue), ...copyLiterals(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return copyLiterals(node.right);
    if (operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.PlusToken) return [...copyLiterals(node.left), ...copyLiterals(node.right)];
  }
  return [];
}

function isConfirmCall(callee: string): boolean {
  return callee === "confirm" || (callee.endsWith(".confirm") && callee !== "window.confirm") || callee === "confirmWhileAllowed";
}

/**
 * Every static UI string in a source file. The labels are label-tag text, label attributes and
 * properties, ChoiceRow titles and dialog titles. The rest of the copy is other JSX text and JSX
 * expressions (`{done ? "Saved" : "Saving…"}`), text attributes, consent sentences, and confirmation
 * titles and bodies. Comments, identifiers, class names and values that are compared or stored
 * (`status === "cancelled"`) are never read.
 */
function uiCopy(sourceFile: ts.SourceFile): UiCopy[] {
  const copy: UiCopy[] = [];
  const parentTag = (node: ts.Node) =>
    ts.isJsxElement(node.parent) ? node.parent.openingElement.tagName.getText(sourceFile) : "";
  // Markup inside a literal element (`<code><span>cancelled</span></code>`) is still a literal value.
  const insideLiteral = (node: ts.Node): boolean => {
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (ts.isJsxElement(ancestor) && LITERAL_TAGS.has(ancestor.openingElement.tagName.getText(sourceFile))) return true;
    }
    return false;
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && !node.containsOnlyTriviaWhiteSpaces) {
      const tag = parentTag(node);
      const label = LABEL_TAGS.has(tag);
      if (label || !insideLiteral(node)) copy.push({ node, kind: `<${tag}>`, value: node.text, label });
    }
    // A label tag's text built in `{…}` is a label too (#2098): every branch and template it can show.
    if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      const tag = parentTag(node);
      const label = LABEL_TAGS.has(tag);
      if (label || !insideLiteral(node)) {
        for (const value of copyLiterals(node.expression)) copy.push({ node, kind: `<${tag}>`, value, label });
      }
    }
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sourceFile);
      // A JsxAttribute sits in JsxAttributes; the element that owns it is one level further up.
      const owner = node.parent.parent;
      const tag = ts.isJsxOpeningLikeElement(owner) ? owner.tagName.getText(sourceFile) : "";
      // A consent checkbox's label is a sentence, which its own test checks. A skill review's
      // `ReviewConsent` is always one.
      const consent = tag === "ReviewConsent" ||
        (tag === "Checkbox" && ts.isJsxOpeningLikeElement(owner) && hasFlag(owner, "consent", sourceFile));
      const label = !(consent && name === "label") && (name === "aria-label" || name === "ariaLabel" ||
        name === "data-menu-label" || name === "label" || (name === "title" && (tag === "State" || tag === "Notice" || tag === "Modal")));
      const text = label || TEXT_ATTRIBUTES.has(name);
      if (ts.isStringLiteral(node.initializer)) {
        if (text) copy.push({ node, kind: name, value: node.initializer.text, label });
      } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        const expression = node.initializer.expression;
        // A dialog title chosen by a condition is still a title (§7.2): read every branch.
        const modalTitles = name === "title" && tag === "Modal" ? staticBranches(expression) : null;
        if (modalTitles) {
          for (const value of modalTitles) copy.push({ node, kind: "Modal title", value, label: true });
        } else if (text) {
          for (const value of copyLiterals(expression)) copy.push({ node, kind: name, value, label: false });
        }
        // A ChoiceRow's title is its label (§8.4): every static title in a ChoiceRows `options` list.
        if (name === "options" && tag === "ChoiceRows") {
          const titles = (inner: ts.Node) => {
            if (ts.isPropertyAssignment(inner) && ts.isIdentifier(inner.name) && inner.name.text === "title") {
              // A title the Title Case check cannot read whole is still read word by word for spelling.
              const branches = staticBranches(inner.initializer);
              for (const value of branches ?? copyLiterals(inner.initializer)) {
                copy.push({ node: inner, kind: "ChoiceRow title", value, label: branches !== null });
              }
            }
            ts.forEachChild(inner, titles);
          };
          titles(expression);
        }
      }
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && LABEL_PROPERTIES.has(node.name.text)) {
      if (ts.isStringLiteralLike(node.initializer)) {
        copy.push({ node, kind: node.name.text, value: node.initializer.text, label: true });
      } else {
        for (const value of copyLiterals(node.initializer)) copy.push({ node, kind: node.name.text, value, label: false });
      }
    }
    // A confirmation's title and body; its button labels are label properties above. A template hole
    // stays a placeholder even when it names a constant, which may hold a status (`${status}`).
    if (ts.isCallExpression(node) && isConfirmCall(node.expression.getText(sourceFile))) {
      for (const literal of node.arguments.flatMap(optionLiterals)) {
        for (const property of literal.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
          if (property.name.text !== "title" && property.name.text !== "message") continue;
          for (const value of copyLiterals(property.initializer)) {
            copy.push({ node: property, kind: `confirmation ${property.name.text}`, value, label: false });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return copy;
}

/** A source file's path under SOURCE_ROOT with `/` separators on every platform, as LABEL_FRAGMENTS names it. */
function sourcePath(fileName: string): string {
  return path.relative(SOURCE_ROOT, fileName).split(path.sep).join("/");
}

function copyLine(sourceFile: ts.SourceFile, node: ts.Node): string {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return `${sourcePath(sourceFile.fileName)}:${line}`;
}

/** A piece of label-tag text that is not a label on its own, with the reason it is exempt. */
interface LabelFragment {
  file: string;
  fragment: string;
  reason: string;
}

/**
 * Label-tag text built in a `{…}` expression that is only part of a label (#2098). The Title Case
 * check reads each branch of such an expression as a whole label, so a fragment joined to the text
 * beside it is exempt only through this list. Each entry names its file, the fragment as the check
 * reads it, and why it is not a label. An entry that no longer matches anything fails the check.
 */
const LABEL_FRAGMENTS: readonly LabelFragment[] = [
  {
    file: "components/GitDiffViewer.tsx",
    fragment: "s",
    reason: 'the plural suffix of "{hiddenCount} More Hunk{…}", which reads "3 More Hunks"',
  },
  {
    file: "components/UsageView.tsx",
    fragment: "· unpriced",
    reason: "a status note after the model name in its row header, not part of the name",
  },
  {
    file: "components/UsageView.tsx",
    fragment: "· paused by daily budget",
    reason: "a status note after the user's name in its row header, not part of the name",
  },
];

/**
 * Every label in `sourceFile` that is not Title Case, less the exempt fragments, and the
 * `fragments` entries that exempted something, so the caller can report the ones that never did.
 */
function titleCaseFailures(
  sourceFile: ts.SourceFile,
  fragments: readonly LabelFragment[] = LABEL_FRAGMENTS,
): { failures: string[]; used: Set<LabelFragment> } {
  const file = sourcePath(sourceFile.fileName);
  const failures: string[] = [];
  const used = new Set<LabelFragment>();
  for (const { node, kind, value, label } of uiCopy(sourceFile)) {
    if (!label) continue;
    const compact = compactLabel(value);
    if (compact && !isTitleCase(compact)) {
      const exempt = fragments.find((entry) => entry.file === file && entry.fragment === compact);
      if (exempt) used.add(exempt);
      else failures.push(`${copyLine(sourceFile, node)} ${kind}: ${JSON.stringify(compact)}`);
    }
    if (kind === "Modal title" && value.trim().endsWith("?")) {
      failures.push(`${file} Modal title is a question: ${JSON.stringify(value)}`);
    }
  }
  return { failures, used };
}

test("static compact UI labels use Title Case", () => {
  const failures: string[] = [];
  const used = new Set<LabelFragment>();
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const result = titleCaseFailures(parseSource(file));
    failures.push(...result.failures);
    for (const entry of result.used) used.add(entry);
  }
  for (const entry of LABEL_FRAGMENTS) {
    if (!used.has(entry)) failures.push(`${entry.file} exempt fragment ${JSON.stringify(entry.fragment)} no longer matches; remove it`);
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("the Title Case check reads label-tag text built in expressions and templates (#2098)", () => {
  const read = (source: string, fragments: readonly LabelFragment[] = []) =>
    titleCaseFailures(parseSource(path.join(SOURCE_ROOT, "fixture.tsx"), source), fragments);
  assert.deepEqual(read(`<button>{busy ? "Committing…" : staged ? "Commit staged" : "Commit"}</button>`).failures,
    ['fixture.tsx:1 <button>: "Commit staged"']);
  assert.deepEqual(read(`<button>{loaded ? \`Hide full \${label}\` : \`Load Full \${label} (\${size})\`}</button>`).failures,
    ['fixture.tsx:1 <button>: "Hide full Name"'], "a template hole reads as a placeholder word");
  assert.deepEqual(read(`<th scope="row">{name}{over ? " · paused" : ""}</th>`).failures,
    ['fixture.tsx:1 <th>: "· paused"']);
  assert.deepEqual(read(`<button>{busy ? "Committing…" : "Commit Staged"}</button>`).failures, []);
  assert.deepEqual(read(`<span>{done ? "all set" : "not yet"}</span>`).failures, [], "text outside a label tag is not a label");
  assert.deepEqual(read(`<button><code>{"npm run build"}</code></button>`).failures, [], "a literal value inside a label");

  // A fragment is exempt only in the file its entry names, and an entry that matches reports itself used.
  const plural: LabelFragment = { file: "fixture.tsx", fragment: "s", reason: "a plural suffix" };
  const elsewhere: LabelFragment = { file: "other.tsx", fragment: "s", reason: "a plural suffix" };
  const suffix = `<button>{count} More Hunk{count === 1 ? "" : "s"}</button>`;
  const exempt = read(suffix, [plural]);
  assert.deepEqual(exempt.failures, []);
  assert.deepEqual([...exempt.used], [plural]);
  const unused = read(suffix, [elsewhere]);
  assert.deepEqual(unused.failures, ['fixture.tsx:1 <button>: "s"']);
  assert.deepEqual([...unused.used], []);
});

test("reverting any label fixed for #2096 or #2098 fails the Title Case check", () => {
  const reverts = [
    ["components/GitDiffViewer.tsx", '"Unstage"} Hunk`', '"Unstage"} hunk`', '"Name hunk"'],
    ["components/ReviewPanel.tsx", '"Commit Staged"', '"Commit staged"', '"Commit staged"'],
    ["components/EventPayloadContent.tsx", "`Hide Full ${label}`", "`Hide full ${label}`", '"Hide full Name"'],
    ["components/EventPayloadContent.tsx", "`Loading Full ${label}…`", "`Loading full ${label}…`", '"Loading full Name…"'],
    ["components/EventPayloadContent.tsx", "`Load Full ${label} (", "`Load full ${label} (", '"Load full Name (Name)"'],
  ];
  for (const [file, fixed, reverted, reported] of reverts) {
    const target = path.join(SOURCE_ROOT, file!);
    const source = readFileSync(target, "utf8");
    assert.ok(source.includes(fixed!), `${file} still reads ${fixed}`);
    assert.deepEqual(titleCaseFailures(parseSource(target)).failures, [], `${file} passes as it is`);
    const { failures } = titleCaseFailures(parseSource(target, source.replace(fixed!, reverted!)));
    assert.equal(failures.length, 1, `${file} with ${reverted}: ${failures.join("\n")}`);
    assert.match(failures[0]!, new RegExp(`^${file!.replace(/\./g, "\\.")}:\\d+ <button>: ${reported!.replace(/[()]/g, "\\$&")}$`));
  }
});

/**
 * docs/design-system.md §17.2: visible copy is US English. #2026 and #2059 each swept British
 * spellings out by hand; this keeps them out. The list is the British words UI copy is likely to
 * reach for, so it is closed on purpose. Each entry matches only whole words that are not also US
 * English: "cancellation", "dialogue", "analyses" and "organism" stay legal.
 */
const BRITISH_SPELLINGS: [RegExp, string][] = [
  [/\bcolour\w*/gi, "color"],
  [/\bbehaviour\w*/gi, "behavior"],
  [/\bfavourite\w*/gi, "favorite"],
  [/\bgrey(?:s|ed|ing|ish)?\b/gi, "gray"],
  [/\bcancell(?:ed|ing)\b/gi, "canceled, canceling"],
  [/\blabell(?:ed|ing)\b/gi, "labeled, labeling"],
  [/\blicences?\b/gi, "license"],
  [/\bcentre[ds]?\b/gi, "center"],
  [/\banalys(?:e|ed|ing)\b/gi, "analyze"],
  [
    /\b(?:apologi|authori|categori|customi|finali|initiali|maximi|minimi|normali|optimi|organi|personali|prioriti|recogni|summari|synchroni|visuali)s(?:e[ds]?|ing|ations?)\b/gi,
    "-ize, -ization",
  ],
];

/** Each British word in `text`, with its US spelling. */
function britishSpellings(text: string): [string, string][] {
  return BRITISH_SPELLINGS.flatMap(([pattern, us]) =>
    [...text.matchAll(pattern)].map((match): [string, string] => [match[0], us]));
}

function spellingFailures(sourceFile: ts.SourceFile): string[] {
  return uiCopy(sourceFile).flatMap(({ node, kind, value }) => britishSpellings(value).map(([word, us]) =>
    `${copyLine(sourceFile, node)} ${kind}: ${JSON.stringify(value.trim())} spells "${word}" the British way; US English (§17.2) is "${us}"`));
}

test("visible UI copy uses US English spelling", () => {
  // The e2e harness pages are test-only fixtures, out of scope like every other test file.
  const failures = sourceFiles(SOURCE_ROOT)
    .filter((file) => !file.includes(`${path.sep}e2e${path.sep}`))
    .flatMap((file) => spellingFailures(parseSource(file)));
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("the US spelling check reads visible copy, not comments, identifiers or status values", () => {
  const sourceFile = parseSource(path.join(SOURCE_ROOT, "fixture.tsx"), `
    // The colour of a cancelled row is grey.
    const cancelled = status === "cancelled" || code === "COMMAND_CANCELLED";
    const colour = cancelled ? "grey" : "green";
    const actions = [{ label: "Favourite Colour", value: "cancelled" }];
    const remove = () => confirm({ title: "Remove Row", message: \`Its queued work is cancelled.\`, confirmLabel: "Remove Row" });
    export const Row = () => (
      <div className="grey" data-status="cancelled" title="Behaviour">
        Colour {cancelled ? "Cancelled" : "Running"} <code>cancelled</code>
        <span title={refusal ?? "Nothing is cancelled"}>{ready && "Greyed"}{statusMeta("cancelled")}</span>
      </div>
    );`);
  const failures = spellingFailures(sourceFile);
  assert.deepEqual(failures.map((failure) => failure.match(/spells "(\w+)"/)?.[1]),
    ["Colour", "Favourite", "cancelled", "Behaviour", "Colour", "Cancelled", "cancelled", "Greyed"]);
  assert.equal(failures[0], 'fixture.tsx:5 label: "Favourite Colour" spells "Colour" the British way; US English (§17.2) is "color"');
  assert.deepEqual(britishSpellings("Cancellation, dialogue, analyses, organism, gray, canceled, realize, supervise"), []);
  assert.deepEqual(britishSpellings("Customise the colours; initialising… Organisation, Summarised").map(([word]) => word),
    ["colours", "Customise", "initialising", "Organisation", "Summarised"]);
  const words = (source: string) => spellingFailures(parseSource(path.join(SOURCE_ROOT, "fixture.tsx"), source))
    .map((failure) => failure.match(/spells "(\w+)"/)?.[1]);
  assert.deepEqual(words(`const status = "cancelled"; confirm({ title: "Stop Run", message: \`Status: \${status}.\`, confirmLabel: "Stop Run" });`),
    [], "a constant in a template hole may hold a status");
  assert.deepEqual(words(`<code><span>cancelled</span> {"cancelled"}</code>`), [], "markup inside a literal element");
  assert.deepEqual(words(`<ChoiceRows options={[{ title: done ? "Colour" : computedTitle }]} />`), ["Colour"],
    "a ChoiceRow title with one readable branch");
});

test("a masked identifier's words and every reveal control's name are Title Case (#1954)", () => {
  assert.deepEqual(Object.values(HIDDEN_IDENTIFIER_TEXT), ["Email Hidden", "Hidden"]);
  for (const text of Object.values(HIDDEN_IDENTIFIER_TEXT)) assert.ok(isTitleCase(text), text);
  // A reveal control's name is "Show" or "Hide" and the label its caller passes.
  const REVEALS = new Set(["PersonalIdentifier", "PersonalIdentifierRevealButton", "AccountIdentifier", "AccountIdentifierRevealButton"]);
  const names: string[] = [];
  const failures: string[] = [];
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const source = readFileSync(file, "utf8");
    // The component forwards its own `label`; its callers supply the copy.
    if ((!source.includes("<PersonalIdentifier") && !source.includes("<AccountIdentifier")) ||
        file.endsWith(`${path.sep}PersonalIdentifier.tsx`) || file.endsWith(`${path.sep}AccountIdentifier.tsx`)) continue;
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningLikeElement(node) && REVEALS.has(node.tagName.getText(sourceFile))) {
        const label = node.attributes.properties.find((property): property is ts.JsxAttribute =>
          ts.isJsxAttribute(property) && property.name.getText(sourceFile) === "label");
        const where = `${path.relative(SOURCE_ROOT, file)}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`;
        if (!label?.initializer || !ts.isStringLiteral(label.initializer)) {
          failures.push(`${where} reveal label is not literal copy`);
        } else {
          for (const action of ["Show", "Hide"]) {
            const name = `${action} ${label.initializer.text}`;
            names.push(name);
            if (!isTitleCase(name)) failures.push(`${where} ${JSON.stringify(name)}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  assert.deepEqual(failures, [], failures.join("\n"));
  for (const name of ["Show Emails", "Hide Emails", "Show Account Email", "Hide Account Email"]) {
    assert.ok(names.includes(name), `${name} is one of the scanned reveal names`);
  }
});

test("consent checkbox labels are sentences, and every other checkbox label is Title Case", () => {
  const failures: string[] = [];
  let consents = 0;
  let labels = 0;
  // Every label read, with its data holes as `#`, so the icon-only names below are known to be scanned.
  const scanned = new Set<string>();
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
            scanned.add(branch.replace(/\b(?:x|Name)\b/g, "#").replace(/\s+/g, " ").trim());
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
  // Every sentence a skill review's `ReviewConsent` can show is computed, not written in JSX (#1948).
  for (const sentence of [
    deployToAssignmentsConsent(1), deployToAssignmentsConsent(2), DEPLOY_TO_TRACKING_MACHINES_CONSENT,
    switchAgentsConsent(3, "the latest version"), switchAgentsConsent(1, "version skillv_0123"),
    switchAgentsConsent(null, "the latest version"),
  ]) {
    consents += 1;
    if (!isSentenceCase(sentence)) failures.push(`ReviewConsent label is not a sentence: ${JSON.stringify(sentence)}`);
  }
  // Not vacuous: the scan found the consent labels in the Skills review dialogs and ordinary ones.
  // (Manage Groups' one consent checkbox became per-change confirmations in #1985.)
  assert.ok(consents >= 7, `found ${consents} consent labels`);
  assert.ok(labels - consents >= 8, `found ${labels - consents} ordinary checkbox labels`);
  // An icon-only box's label is its accessible name, held to the same convention (#2044): the diff's
  // line selectors and the review findings' selectors.
  for (const name of [
    "Select Added Line #", "Select Removed Line #",
    "Select Finding on # Line #", "Select File-Level Finding on #", "Select Remote Discussion",
  ]) {
    assert.ok(scanned.has(name), `${name} is one of the scanned checkbox labels`);
  }
});

/**
 * A picker's no-match row is a message (§12.2), "No projects match “wolipog”.", built by the
 * primitive from the caller's noun. "No Matching Projects" was a Title Case label standing in for
 * it: it named no search and offered no next step. So no picker copy may say "No Matching", and every
 * `noun` is the lowercase plural the sentence reads with.
 */
test("picker no-match copy is a sentence built from a lowercase noun", () => {
  const failures: string[] = [];
  let nouns = 0;
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("<SearchableCombobox") && !source.includes("<Select")) continue;
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningLikeElement(node) && ["SearchableCombobox", "Select"].includes(node.tagName.getText(sourceFile))) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const where = `${path.relative(SOURCE_ROOT, file)}:${line}`;
        for (const property of node.attributes.properties) {
          if (!ts.isJsxAttribute(property) || !property.initializer || !ts.isStringLiteral(property.initializer)) continue;
          const name = property.name.getText(sourceFile);
          const text = property.initializer.text;
          if (/^No Matching\b/i.test(text)) failures.push(`${where} ${name} is a "No Matching" label: ${JSON.stringify(text)}`);
          if (name === "noun") {
            nouns += 1;
            if (text !== text.toLowerCase()) failures.push(`${where} noun is not lowercase: ${JSON.stringify(text)}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  assert.deepEqual(failures, [], failures.join("\n"));
  // Not vacuous: New Session's Project and Agent pickers each pass a noun on both of their forms.
  assert.ok(nouns >= 4, `found ${nouns} picker nouns`);
});

test("no production screen calls Sessions the Inbox", () => {
  // docs/design-system.md §4.1: the destination is Sessions, and "Inbox" is retired from all visible
  // and accessible copy (#1945). The internal `inbox` view name, the "/" route and stored keys keep
  // it, so the scan reads only JSX text and string copy, where the capitalised word would show.
  const failures: string[] = [];
  let scanned = 0;
  for (const file of sourceFiles(SOURCE_ROOT)) {
    if (!file.endsWith(".tsx") || file.includes(`${path.sep}e2e${path.sep}`)) continue;
    scanned += 1;
    const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const check = (node: ts.Node, text: string) => {
      if (!/\bInbox\b/.test(text)) return;
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      failures.push(`${path.relative(SOURCE_ROOT, file)}:${line} ${JSON.stringify(text.trim())}`);
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (ts.isJsxText(node) || ts.isStringLiteralLike(node)) check(node, node.text);
      if (ts.isTemplateExpression(node)) {
        check(node, [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" "));
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  assert.ok(scanned > 50, `scanned ${scanned} production TSX files`);
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("the session bar's navigation and project labels are Title Case (#2146)", () => {
  // Back is named by a helper, so read its result; the project items are menu text, which the
  // label-tag scan above does not hold to Title Case, so read them from the components themselves.
  assert.equal(backLabel("inbox"), "Back to Sessions");
  const menuItems = (file: string) => uiCopy(parseSource(path.join(SOURCE_ROOT, file)))
    .filter((copy) => copy.kind === "<MenuItem>")
    .map((copy) => copy.value.replace(/\s+/g, " ").trim());
  const projectMenu = menuItems("components/SessionDetail.tsx");
  const moreActions = menuItems("components/SessionHeader.tsx");
  const labels = [
    ["Back to Sessions", [backLabel("inbox")]],
    ["Open Project", projectMenu],
    ["Move to Another Project…", projectMenu],
    ["Move to a Project…", projectMenu],
    // More Actions names the Project or the legacy Workspace through a template hole.
    ["Move to Another Name…", moreActions],
    ["Move to a Name…", moreActions],
  ] as const;
  for (const [label, found] of labels) {
    assert.ok(found.includes(label), `${label} is rendered (found ${JSON.stringify(found)})`);
    assert.ok(isTitleCase(label), `${label} is Title Case`);
  }
  for (const retired of ["Manage Project", "Move Session…", "Project Actions"]) {
    assert.ok(![...projectMenu, ...moreActions].includes(retired), `${retired} is gone from the bar's menus`);
  }
});

test("the session bar's panel toggles and Open control are Title Case, and their notes are sentences (#2164)", () => {
  // The toggles' names and tooltips are literals in SessionPanelToggles; read them from the source so
  // a renamed toggle cannot slip past, then hold each to Title Case.
  const toggles = uiCopy(parseSource(path.join(SOURCE_ROOT, "components/SessionPanelToggles.tsx")))
    .map((copy) => copy.value.trim());
  for (const label of ["Panels", "Pinned Summary", "Terminal", "Side Panel"]) {
    assert.ok(toggles.includes(label), `${label} is rendered (found ${JSON.stringify(toggles)})`);
    assert.ok(isTitleCase(label), `${label} is Title Case`);
  }
  for (const retired of [/^Show\b/, /^Hide\b/, /^Toggle\b/]) {
    assert.ok(!toggles.some((label) => retired.test(label)), `no toggle copy matches ${retired}`);
  }
  for (const label of [
    CHOOSE_DESTINATION_LABEL,
    DESTINATION_MENU_LABEL,
    openDestinationLabel({ kind: "reveal", name: "File Manager" }, true),
    openDestinationLabel({ kind: "reveal", name: "File Manager" }, false),
    openDestinationLabel({ kind: "editor", name: "VS Code" }, false),
  ]) assert.ok(isTitleCase(label), `${label} is Title Case`);
  assert.equal(openDestinationLabel({ kind: "reveal", name: "Finder" }, true), "Open Folder");
  // Machine and editor names are proper names, so each sentence is checked around a placeholder.
  for (const sentence of [offlineDestinationNote("Machine"), TERMINAL_UPDATE_NOTE, "Couldn't open the folder in it."]) {
    assert.ok(/[.]$/.test(sentence) && sentence.split(/(?<=[.!?])\s+/).every(isSentenceCase), sentence);
  }
  const editorSource = readFileSync(path.join(SOURCE_ROOT, "components/EditorSelect.tsx"), "utf8");
  assert.match(editorSource, /showToast\(`Couldn't open the folder in \$\{destination\.name\}\.`/,
    "the launch failure toast is the sentence checked above");
});

test("Share Transcript's titles, labels and buttons are Title Case, and its sentences are sentence case (#2148)", () => {
  const titles = ["title", "expiryLabel", "create", "linkLabel", "copy", "unavailableTitle", "linksTitle", "loadErrorTitle",
    "createErrorTitle", "revoke"] as const;
  const sentences = ["description", "expiryHelper", "creating", "linkHelper", "copied", "unavailableBody", "loading", "empty",
    "loadErrorBody", "revoking", "revoked", "untitled"] as const;
  // The title consent label (§8.4) and the link row's fact (#2189) are sentence case without a period.
  const phrases = ["includeTitle", "includesTitle"] as const;
  assert.deepEqual([...titles, ...sentences, ...phrases].sort(), Object.keys(TRANSCRIPT_SHARE_COPY).sort(),
    "every string is classified");
  for (const key of phrases) {
    const value = TRANSCRIPT_SHARE_COPY[key];
    assert.ok(isSentenceCase(value) && !isTitleCase(value) && !/[.!?…]$/.test(value), `${key}: ${JSON.stringify(value)}`);
  }
  for (const key of titles) {
    const value = TRANSCRIPT_SHARE_COPY[key];
    assert.ok(isTitleCase(value) && !/[.!?]$/.test(value), `${key}: ${JSON.stringify(value)}`);
  }
  // Product and service names, and a key's name, keep their capitals inside a sentence.
  const names = new Set(["Wollipog", "Tailscale", "Ctrl+C"]);
  const sentence = (value: string) => /[.…]$/.test(value) && value.split(/(?<=[.!?])\s+/).every((part) =>
    isSentenceCase(part.split(/\s+/).map((word, index) => index > 0 && names.has(word.replace(/\W+$/, "")) ? "name" : word).join(" ")));
  for (const key of sentences) assert.ok(sentence(TRANSCRIPT_SHARE_COPY[key]), `${key}: ${JSON.stringify(TRANSCRIPT_SHARE_COPY[key])}`);
  for (const mac of [true, false]) assert.ok(sentence(copyShortcutHelper(mac)), copyShortcutHelper(mac));
  // The quoted session title is user content; the sentence around it is checked with a lowercase one.
  assert.ok(sentence(includeTitleHelper("“fix login”")), includeTitleHelper("“fix login”"));

  // The rows and the Revoke… name are built from times: line one is a title-like label, line two a
  // sentence-case fact, and the button's accessible name is Title Case like its visible label.
  const now = new Date(2026, 8, 30, 0, 26).getTime();
  const expiresAt = new Date(2026, 9, 2, 0, 26).getTime();
  assert.ok(isTitleCase(`Revoke Link That Expires ${shareMoment(expiresAt, now)}`));
  assert.equal(shareExpiryLabel({ status: "active", expiresAt }, now), "Expires in 2 days");
  assert.ok(isSentenceCase(shareCreatedLabel(now, now).replace(/\d.*$/, "").trim()));
});

test("the pending-question marker's labels are Title Case (#2205)", () => {
  for (const value of Object.values(ASK_MARKER_COPY)) assert.ok(isTitleCase(value) && !/[.!?…]$/.test(value), value);
});

test("the Request Card's labels and names are Title Case, and its foot-notes are sentences (#2179)", () => {
  const titles = ["moreChoices", "copyDetails", "requestDetails", "policyMatch", "pendingRequests", "waitingRequests",
    "pendingRequestTitle", "expand", "expandRequest"] as const;
  const sentences = ["runnerOffline", "signInOwner", "notSent", "sending"] as const;
  assert.deepEqual([...titles, ...sentences].sort(), Object.keys(REQUEST_CARD_COPY).sort(), "every string is classified");
  for (const key of titles) {
    assert.ok(isTitleCase(REQUEST_CARD_COPY[key]) && !/[.!?…]$/.test(REQUEST_CARD_COPY[key]), `${key}: ${REQUEST_CARD_COPY[key]}`);
  }
  for (const key of sentences) {
    const value = REQUEST_CARD_COPY[key];
    assert.ok(/[.…]$/.test(value) && isSentenceCase(value.replace(/^Only the machine owner or an organization admin/, "Only")),
      `${key}: ${value}`);
  }
  const kinds = ["permission", "cost_budget", "max_tool_calls", "authentication", "question", "workflow_decision"] as const;
  for (const kind of kinds) {
    for (const category of kind === "workflow_decision" ? ["pr_merge", "ui_evidence_approval"] : [undefined]) {
      const label = requestKindMeta({ kind, workflowDecision: category ? { category } as never : undefined }).label;
      assert.ok(isTitleCase(label), `${kind} ${category ?? ""}: ${label}`);
    }
  }
  for (const label of [moreRequestsLabel(1), moreRequestsLabel(3), pendingRequestsTitle(1), pendingRequestsTitle(3)]) {
    assert.ok(isTitleCase(label), label);
  }
  // The policy line is a sentence fragment: "Asked by Deploy Guard · Rejects automatically in 9:42", with
  // the policy's name as written by its author.
  for (const part of requestPolicyLine("guard", 582_000).split(" · ")) assert.ok(isSentenceCase(part), part);
  // Every label written into the card and dock's markup is Title Case too.
  const failures = ["RequestCard.tsx", "RequestDock.tsx", "EvidenceReview.tsx", "WorkflowDecisionSummary.tsx"]
    .flatMap((file) => titleCaseFailures(parseSource(path.join(SOURCE_ROOT, "components/requests", file))).failures);
  assert.deepEqual(failures, []);
});

test("the question card's labels and buttons are Title Case, and its hints and errors are sentences (#2196)", () => {
  const titles = ["agentQuestions", "question", "asyncQuestion", "recoveryRequired", "dismiss", "dismissAndContinue",
    "back", "next", "submitAnswers", "tryAgain", "somethingElse", "somethingElseField", "showWhereAsked",
    "showFullQuestion", "showLess"] as const;
  // "Choose one", "Choose any" and "Optional" are the dim line above a question: sentence fragments.
  const fragments = ["chooseOne", "chooseAny", "optional"] as const;
  const sentences = ["noDetails", "required", "chooseOption", "chooseOptions", "optionalSentence", "notSent",
    "notDismissed", "alreadySending", "sending", "dismissing", "runnerOffline", "unsupported", "answerInComposer",
    "recoveryResume", "recoveryDismiss", "findingWhereAsked", "whereAskedNotLoaded"] as const;
  assert.deepEqual([...titles, ...fragments, ...sentences].sort(), Object.keys(QUESTION_CARD_COPY).sort(),
    "every string is classified");
  for (const key of titles) {
    // "Something Else…" keeps its ellipsis: choosing it asks for more input before anything is sent (§3.1).
    const value = QUESTION_CARD_COPY[key].replace(/…$/, "");
    assert.ok(isTitleCase(value) && !/[.!?…]$/.test(value), `${key}: ${QUESTION_CARD_COPY[key]}`);
  }
  for (const key of fragments) {
    assert.ok(isSentenceCase(QUESTION_CARD_COPY[key]) && !/[.!?]$/.test(QUESTION_CARD_COPY[key]), key);
  }
  for (const key of sentences) {
    const value = QUESTION_CARD_COPY[key];
    // "Answer Mode" is the feature's name and "Press R" names the key.
    const parts = value.replace("Answer Mode", "answer mode").replace(/Press R\b/, "Press r").split(/(?<=[.…])\s+/);
    assert.ok(/[.…]$/.test(value) && parts.every(isSentenceCase), `${key}: ${value}`);
  }
  // The step count is a foot-note, written as the issue words it.
  assert.equal(questionStepLabel(1, 3), "Question 2 of 3");
});

test("the sign-in card's labels are Title Case and its help lines are sentences (#2198)", () => {
  const sentences = ["rechecking", "labelHelp", "defaultHelp"] as const;
  for (const [key, value] of Object.entries(SIGN_IN_COPY)) {
    if ((sentences as readonly string[]).includes(key)) {
      assert.ok(/[.…]$/.test(value) && isSentenceCase(value), `${key}: ${value}`);
    } else {
      assert.ok(isTitleCase(value) && !/[.!?]$/.test(value), `${key}: ${value}`);
    }
  }
  // The labels the issue names, exactly.
  for (const label of ["This Session Uses", "Signed In Now", "Last Checked", "Check Again", "Start Sign-In",
    "Choose Another Account…"]) {
    assert.ok(Object.values(SIGN_IN_COPY).includes(label as never), label);
  }
  assert.equal(REQUEST_CARD_COPY.signInOwner, "Only a machine owner or organization admin can sign in on this machine.");
  assert.deepEqual(titleCaseFailures(parseSource(path.join(SOURCE_ROOT, "components/AuthenticationRecoveryPanel.tsx"))).failures,
    []);
});

test("the session menus' labels are Title Case, with an ellipsis only where a dialog or confirmation follows (#2161)", () => {
  const sourceFile = parseSource(path.join(SOURCE_ROOT, "components/SessionHeader.tsx"));
  const items = uiCopy(sourceFile)
    .filter((copy) => copy.kind === "<MenuItem>")
    .map((copy) => copy.value.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  // Each item, and whether a dialog or a confirmation follows it.
  const expected: ReadonlyArray<readonly [string, boolean]> = [
    ["Share Transcript…", true],
    ["Copy Session Link", false],
    ["Export as Markdown", false],
    ["Export as JSON", false],
    ["Rename…", true],
    ["Dismiss Reminder", false],
    ["Fork Conversation…", true],
    ["Switch Account…", true],
    ["Reprocess Transcript", false],
    ["Sign Out of Agent…", true],
    ["Restart Session", false],
    ["Retry Stop", false],
    ["Stop Session…", true],
    ["Delete Session…", true],
  ];
  for (const [label, opensDialog] of expected) {
    assert.ok(items.includes(label), `${label} is rendered (found ${JSON.stringify(items)})`);
    assert.ok(isTitleCase(label), `${label} is Title Case`);
    assert.equal(label.endsWith("…"), opensDialog, `${label} ends in an ellipsis only before a dialog or confirmation`);
  }
  // The reminder item reads the same in both session menus; the archive item confirms only when it stops.
  for (const label of [reminderMenuActionLabel(), reminderMenuActionLabel({ state: "pending" } as SessionReminderView),
    reminderMenuActionLabel({ state: "fired" } as SessionReminderView)]) {
    assert.ok(isTitleCase(label) && label.endsWith("…"), `${label} opens the Snooze dialog`);
  }
  assert.deepEqual([reminderMenuActionLabel(), reminderMenuActionLabel({ state: "pending" } as SessionReminderView),
    reminderMenuActionLabel({ state: "fired" } as SessionReminderView)], ["Snooze…", "Change Reminder…", "Snooze Again…"]);
  for (const retired of ["Rename Session…", "Restart", "Sign Out", "↻ Reprocess Transcript", "Export Markdown",
    "Export JSON", "Copy Internal Session Link"]) {
    assert.ok(!items.includes(retired), `${retired} is gone from the session menus`);
  }
  assert.doesNotMatch(sourceFile.text, /<MenuLabel>/, "the session menus have no section labels");

  // Second lines and the note are sentences; Wollipog is a name.
  const sentences: string[] = [];
  const visit = (node: ts.Node) => {
    const collect = (child: ts.Node) => {
      if (ts.isStringLiteralLike(child) && /\s/.test(child.text)) sentences.push(child.text);
      if (ts.isTemplateExpression(child)) {
        sentences.push([child.head.text, ...child.templateSpans.map((span) => span.literal.text)].join("X"));
        return;
      }
      ts.forEachChild(child, collect);
    };
    if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === "description" && node.initializer) {
      collect(node.initializer);
    }
    // The reasons an item is unavailable are named `…Reason` (or `…_REASON`, `…_HINT`) before they reach it.
    if (ts.isVariableDeclaration(node) && /(?:reason|_HINT)$/i.test(node.name.getText(sourceFile)) && node.initializer
      && !/Refusal/.test(node.initializer.getText(sourceFile))) collect(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  sentences.push(...uiCopy(sourceFile).filter((copy) => copy.kind === "<MenuNote>").map((copy) => copy.value));
  assert.ok(sentences.length >= 8, `read ${sentences.length} second lines`);
  // A template made only of other reasons (each read on its own) holds no copy of its own.
  for (const sentence of sentences.filter((text) => !/^[X\s]*$/.test(text))) {
    assert.ok(isSentenceCase(sentence.replace(/\bWollipog\b/g, "wollipog")), `${sentence} is sentence case`);
    assert.match(sentence, /\.$/, `${sentence} is a full sentence`);
  }
});

test("message and turn action names are Title Case, with an ellipsis only before a dialog or confirmation (#2167)", () => {
  // The actions carry their icons as elements; direct Node rendering needs the classic JSX global.
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const prompt = { kind: "user_message", id: 1, text: "Prompt" } as const;
  const yourMessage = messageActions(prompt, {
    onRewind: () => {},
    rewindTurn: 1,
    onEditAndResend: () => {},
    onEditInFork: () => {},
    editInForkAvailability: { available: true, forkTurn: 1 },
  });
  const thisTurn = turnActions({
    responseText: "Answer",
    forkAvailability: { available: true, forkTurn: 1 },
    onFork: () => {},
    forkTurn: 1,
    handoff: { open: () => {} },
  });
  // Each name, and whether a dialog or a confirmation follows it. Edit as a New Turn loads the
  // composer (#2185), so it takes no ellipsis.
  const expected: ReadonlyArray<readonly [string, boolean]> = [
    ["Copy Message", false],
    ["Edit as a New Turn", false],
    ["Edit in a Fork…", true],
    ["Rewind Files to Before This Turn…", true],
    ["Copy Response", false],
    ["Copy Response as Markdown", false],
    ["Fork After This Turn…", true],
    ["Hand Off After This Turn…", true],
  ];
  assert.deepEqual([...yourMessage, ...thisTurn].map((action) => action.label), expected.map(([label]) => label));
  for (const [label, opensDialog] of expected) {
    assert.ok(isTitleCase(label.replace(/…$/, "")), `${label} is Title Case`);
    assert.equal(label.endsWith("…"), opensDialog, `${label} ends in an ellipsis only before a dialog or confirmation`);
  }
  for (const label of ["More Message Actions", "More Turn Actions", "Your Message", "This Turn", "Fork After This Turn"]) {
    assert.ok(isTitleCase(label), `${label} is Title Case`);
  }

  // A reason the turn's own copy supplies, and each copy toast, is a sentence.
  const empty = { kind: "user_message", id: 2, text: "" } as const;
  const sentences = [
    messageActions(empty, {})[0]!.unavailableReason!,
    turnActions({ responseText: "" })[0]!.unavailableReason!,
    ...[...yourMessage, ...thisTurn].flatMap((action) => action.copy ? [action.copy.copied, action.copy.failed] : []),
  ];
  for (const sentence of sentences) {
    assert.ok(isSentenceCase(sentence.replace(/\bMarkdown\b/g, "markdown")) && /\.$/.test(sentence), `${sentence} is a sentence`);
  }
});

test("the copy rules tell a sentence from a title", () => {
  assert.equal(isSentenceCase("Deploy to 2 existing assignments"), true);
  assert.equal(isSentenceCase("Deploy to 2 Existing Assignments"), false);
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
const COMPUTED_BODIES = [/^archiveAndStopMessage\(/, /^projectArchiveMessage\(/, /^conflict\.message$/, /^closeWarning\(/, /^heldUpdateMessage\(/,
  /^stopSessionMessage\(/, /^stopArchivedSessionMessage\(/, /^deleteSessionMessage\(/, /^signOutOfAgentMessage\(/,
  /^STOP_JOB_OUTCOME$/];

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
      if (isConfirmCall(callee)) {
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
    ...[null, "Fix the half-cent rounding bug.\nRequirements:\n- keep cents"].flatMap((title) => [
      ...[0, 1, 3].map((count) => stopSessionMessage(title, count)),
      ...[0, 1, 3].map((count) => stopArchivedSessionMessage(title, count)),
      deleteSessionMessage(title),
    ]),
    ...["Studio Mac", null].map((machine) => signOutOfAgentMessage("Gemini CLI", machine)),
    STOP_JOB_OUTCOME,
    ...[1, 3].flatMap((count) => [true, false].flatMap((stops) => [true, false].map((onProjectPage) =>
      projectArchiveMessage({ projectName: "Payments Service", count, stops, onProjectPage })))),
  ];
  assert.equal(bodies.length, 47);
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
