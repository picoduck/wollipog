import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

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
