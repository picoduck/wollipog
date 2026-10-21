import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const repoRoot = resolve(import.meta.dirname, "..");
// Measured at 0, 25, 40, 49, 50, 75, 100, 150, 153, 154, and higher floors.
// Forty includes the 49-character host-home mirror and the 382-character #419
// predicate, while leaving very short accessors/empty bodies out of this policy.
const minimumBodySize = 40;
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const debtDirectory = join(import.meta.dirname, "duplicate-exported-functions-debt");

function sourceFiles(directory) {
  return readdirSync(join(repoRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return sourceExtensions.has(extname(path)) ? [path] : [];
  });
}

function bodyTokens(node, sourceFile, result = []) {
  if (node.kind === ts.SyntaxKind.JSDocComment) return result;
  const children = node.getChildren(sourceFile);
  if (children.length) {
    for (const child of children) bodyTokens(child, sourceFile, result);
  } else if (node.kind !== ts.SyntaxKind.SyntaxList) {
    result.push(node.getText(sourceFile));
  }
  return result;
}

function exportedFunctions(path, source) {
  // A function declaration must contain this keyword. False matches in comments
  // or literals only cause an extra parse; they cannot hide a declaration.
  if (!/\bfunction\b/u.test(source)) return [];
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const namedExports = new Set(sourceFile.statements
    .filter(ts.isExportDeclaration)
    .filter((node) => !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause))
    .flatMap((node) => node.exportClause.elements.map((entry) => (entry.propertyName ?? entry.name).text)));
  return sourceFile.statements
    .filter((node) => ts.isFunctionDeclaration(node) && node.body)
    .filter((node) => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      || namedExports.has(node.name?.text))
    .map((node) => {
      const tokens = bodyTokens(node.body, sourceFile);
      return {
        path,
        symbol: node.name?.text ?? "<default>",
        package: path.split("/").slice(0, 2).join("/"),
        size: tokens.reduce((size, token) => size + token.length, 0),
        // Preserve token boundaries and literal contents. Removing trivia must
        // not confuse `a + ++b` with `a++ + b`, or change strings/regex/templates.
        body: JSON.stringify(tokens),
      };
    });
}

function declarationKey(declarations) {
  return JSON.stringify(declarations.map(({ path, symbol }) => [path, symbol])
    .sort(([aPath, aSymbol], [bPath, bSymbol]) => aPath.localeCompare(bPath) || aSymbol.localeCompare(bSymbol)));
}

function violations(declarations, debt) {
  const groups = new Map();
  for (const declaration of declarations) {
    if (declaration.size < minimumBodySize) continue;
    const group = groups.get(declaration.body) ?? [];
    group.push(declaration);
    groups.set(declaration.body, group);
  }
  const debtByKey = new Map();
  for (const entry of debt) {
    assert.ok(typeof entry.reason === "string" && entry.reason.trim(), `${entry.file}: debt needs a written reason`);
    assert.ok(Array.isArray(entry.declarations) && entry.declarations.length >= 2,
      `${entry.file}: debt needs the exact declarations`);
    for (const declaration of entry.declarations) {
      assert.ok(typeof declaration.path === "string" && typeof declaration.symbol === "string"
        && declaration.path && declaration.symbol, `${entry.file}: debt needs each path and symbol`);
    }
    const key = declarationKey(entry.declarations);
    assert.ok(!debtByKey.has(key), `${entry.file}: duplicate debt entry`);
    debtByKey.set(key, entry);
  }
  const matchedDebt = new Set();
  const problems = [];
  for (const group of groups.values()) {
    if (new Set(group.map((declaration) => declaration.package)).size < 2) continue;
    const key = declarationKey(group);
    if (debtByKey.has(key)) matchedDebt.add(key);
    else problems.push(`Unrecorded duplicate exported function body (${group[0].size} characters):\n`
      + group.map(({ path, symbol }) => `  ${symbol}: ${path}`).join("\n"));
  }
  for (const [key, entry] of debtByKey) {
    if (!matchedDebt.has(key)) problems.push(`Stale duplicate-function debt: ${entry.file}. Remove or update the entry:\n`
      + entry.declarations.map(({ path, symbol }) => `  ${symbol}: ${path}`).join("\n"));
  }
  return problems;
}

test("exported function bodies are shared across packages, except recorded debt", () => {
  const declarations = [];
  for (const directory of ["apps", "packages"]) {
    for (const entry of readdirSync(join(repoRoot, directory), { withFileTypes: true })) {
      const sourceRoot = `${directory}/${entry.name}/src`;
      if (!entry.isDirectory() || !existsSync(join(repoRoot, sourceRoot))) continue;
      for (const path of sourceFiles(sourceRoot)) {
        declarations.push(...exportedFunctions(path, readFileSync(join(repoRoot, path), "utf8")));
      }
    }
  }
  const debt = readdirSync(debtDirectory).filter((file) => file.endsWith(".json")).sort()
    .map((file) => ({ ...JSON.parse(readFileSync(join(debtDirectory, file), "utf8")), file }));
  assert.deepEqual(violations(declarations, debt), [],
    "Share duplicated exported functions instead of adding copies. Pay down recorded debt when possible.");
});

test("function normalization ignores trivia while preserving literals and token boundaries", () => {
  const [original] = exportedFunctions("apps/a/src/a.ts", 'export function original(a, b) { /** doc */ const text = "// keep  spaces"; return a + ++b + text; }');
  const [copy] = exportedFunctions("packages/b/src/b.ts", 'function copy(a,b){const text="// keep  spaces";/* trivia */return a+ ++b+text;} export { copy as renamed };');
  assert.equal(original.body, copy.body);
  for (const source of [
    'export function different(a,b){const text="// keep spaces";return a+ ++b+text;}',
    'export function different(a,b){const text="// keep  spaces";return a++ +b+text;}',
  ]) assert.notEqual(original.body, exportedFunctions("apps/a/src/a.ts", source)[0].body);
  const regexSource = String.raw`export default function(){return /https?:\/\//.test("http:  // literal");}`;
  assert.deepEqual(ts.createSourceFile("fixture.ts", regexSource, ts.ScriptTarget.Latest, true).parseDiagnostics, []);
  const [defaultFunction] = exportedFunctions("apps/a/src/a.ts", regexSource);
  assert.equal(defaultFunction.symbol, "<default>");
  const [template] = exportedFunctions("apps/a/src/a.ts", 'export function template(){return `hello  // literal`;}');
  assert.ok(template.body.includes("hello  // literal"));
  assert.equal(exportedFunctions("apps/a/src/a.ts", "function privateHelper() { return 1; } export { value } from './other.js';").length, 0);
});

test("debt covers only its exact duplicate group and fails after unification", () => {
  const source = "export function shared(value) { if (value === undefined) return null; return String(value); }";
  const first = exportedFunctions("apps/a/src/a.ts", source);
  const second = exportedFunctions("packages/b/src/b.ts", source);
  const debt = [{ file: "existing.json", reason: "Pre-existing duplication awaiting unification.", declarations: [...first, ...second] }];
  assert.deepEqual(violations([...first, ...second], debt), []);
  assert.match(violations(first, debt).join("\n"), /Stale duplicate-function debt: existing.json/u);
  const extra = exportedFunctions("apps/c/src/c.ts", source);
  const problems = violations([...first, ...second, ...extra], debt).join("\n");
  for (const declaration of [...first, ...second, ...extra]) {
    assert.ok(problems.includes(`${declaration.symbol}: ${declaration.path}`));
  }
  assert.match(problems, /Unrecorded duplicate exported function body/u);
  assert.match(problems, /Stale duplicate-function debt/u);
  const samePackage = exportedFunctions("apps/a/src/other.ts", source);
  assert.deepEqual(violations([...first, ...samePackage], []), []);
});
