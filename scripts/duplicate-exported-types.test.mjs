import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const repoRoot = resolve(import.meta.dirname, "..");
const debtDirectory = join(import.meta.dirname, "duplicate-exported-types-debt");
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

// Policy: identical independently declared structural types with the SAME name
// across packages. No size floor. Keep type parameters and inheritance in the
// signature; ignore trivia, preserving token boundaries and literal contents.
// Derived/utility/indexed aliases, callback/generic aliases and empty extensions
// are excluded categories, not debt. Anonymous inline type literals are outside
// this declaration-level policy (including the two historical #618 inline copies).
// Measured renamed duplicates deliberately missed:
// SessionTitleMessage / SessionNamingPromptMessage;
// ReviewRepository / CampaignRepositoryLocation;
// WorktreeRefDeletionRequest / SessionWorktreeRefDeletion;
// ComposerCommandSubmission / InvokeSessionCommandRequest.
// No semantic name resolution, member reordering, interface/type equivalence or
// re-export traversal. A token match is a review signal, not semantic equivalence.
// A separate scan preserves the function guard's behavior and parallel ownership;
// Node's per-file test processes cannot share parsed SourceFiles through a module.
function sourceFiles(directory) {
  return readdirSync(join(repoRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return sourceExtensions.has(extname(path)) ? [path] : [];
  });
}

function tokens(node, sourceFile, result = []) {
  if (node.kind === ts.SyntaxKind.JSDocComment) return result;
  const children = node.getChildren(sourceFile);
  if (children.length) {
    for (const child of children) tokens(child, sourceFile, result);
  } else if (node.kind !== ts.SyntaxKind.SyntaxList) {
    result.push(node.getText(sourceFile));
  }
  return result;
}

function exportedTypes(path, source) {
  if (!/\b(type|interface)\b/u.test(source)) return [];
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const namedExports = new Set(sourceFile.statements
    .filter(ts.isExportDeclaration)
    .filter((node) => !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause))
    .flatMap((node) => node.exportClause.elements.map((entry) => (entry.propertyName ?? entry.name).text)));
  return sourceFile.statements
    .filter((node) => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
    .filter((node) => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      || namedExports.has(node.name.text))
    .filter((node) => ts.isInterfaceDeclaration(node) ? node.members.length > 0
      : !node.typeParameters?.length && (ts.isTypeLiteralNode(node.type) || ts.isUnionTypeNode(node.type)))
    .map((node) => ({
      path,
      symbol: node.name.text,
      package: path.split("/").slice(0, 2).join("/"),
      signature: JSON.stringify([
        node.name.text,
        ts.isInterfaceDeclaration(node) ? "interface" : "type",
        node.typeParameters?.map((parameter) => tokens(parameter, sourceFile)) ?? [],
        node.heritageClauses?.map((clause) => tokens(clause, sourceFile)) ?? [],
        ts.isInterfaceDeclaration(node)
          ? node.members.flatMap((member) => tokens(member, sourceFile))
          : tokens(node.type, sourceFile),
      ]),
    }));
}

function declarationKey(declarations) {
  return JSON.stringify(declarations.map(({ path, symbol }) => [path, symbol])
    .sort(([aPath, aSymbol], [bPath, bSymbol]) => aPath.localeCompare(bPath) || aSymbol.localeCompare(bSymbol)));
}

function violations(declarations, debt) {
  const groups = new Map();
  for (const declaration of declarations) {
    const group = groups.get(declaration.signature) ?? [];
    group.push(declaration);
    groups.set(declaration.signature, group);
  }
  const debtByKey = new Map();
  for (const entry of debt) {
    assert.ok(typeof entry.reason === "string" && entry.reason.trim(), `${entry.file}: debt needs a written reason`);
    assert.ok(Array.isArray(entry.declarations) && entry.declarations.length >= 2,
      `${entry.file}: debt needs the exact declarations`);
    for (const declaration of entry.declarations) {
      assert.ok(typeof declaration.path === "string" && declaration.path
        && typeof declaration.symbol === "string" && declaration.symbol,
      `${entry.file}: debt needs each path and symbol`);
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
    else problems.push("Unrecorded duplicate exported type declaration:\n"
      + group.map(({ path, symbol }) => `  ${symbol}: ${path}`).join("\n"));
  }
  for (const [key, entry] of debtByKey) {
    if (!matchedDebt.has(key)) problems.push(`Stale duplicate-type debt: ${entry.file}. Remove or update the entry:\n`
      + entry.declarations.map(({ path, symbol }) => `  ${symbol}: ${path}`).join("\n"));
  }
  return problems;
}

test("same-name exported structural types are shared across packages, except recorded debt", () => {
  const declarations = [];
  for (const directory of ["apps", "packages"]) {
    for (const entry of readdirSync(join(repoRoot, directory), { withFileTypes: true })) {
      const sourceRoot = `${directory}/${entry.name}/src`;
      if (!entry.isDirectory() || !existsSync(join(repoRoot, sourceRoot))) continue;
      for (const path of sourceFiles(sourceRoot)) {
        declarations.push(...exportedTypes(path, readFileSync(join(repoRoot, path), "utf8")));
      }
    }
  }
  const debt = readdirSync(debtDirectory).filter((file) => file.endsWith(".json")).sort()
    .map((file) => ({ ...JSON.parse(readFileSync(join(debtDirectory, file), "utf8")), file }));
  assert.deepEqual(violations(declarations, debt), [],
    "Share duplicated same-name exported types instead of adding copies. Pay down recorded debt when possible.");
});

test("type signatures retain heritage, generics, names, literals and token boundaries", () => {
  const extract = (source) => exportedTypes("apps/a/src/a.ts", source)[0]?.signature;
  const original = extract('export interface Shape<T extends string> extends Base { value: T; label: "keep  spaces"; }');
  assert.equal(original, extract('interface Shape<T extends string> extends Base{/**doc*/value:T;label:"keep  spaces";} export {Shape};'));
  for (const source of [
    'export interface Shape<T extends number> extends Base { value: T; label: "keep  spaces"; }',
    'export interface Shape<T extends string> extends Other { value: T; label: "keep  spaces"; }',
    'export interface Renamed<T extends string> extends Base { value: T; label: "keep  spaces"; }',
    'export interface Shape<T extends string> extends Base { value: T; label: "keep spaces"; }',
  ]) assert.notEqual(original, extract(source));
  assert.notEqual(extract('export type Value = { value: typeof a.b };'), extract('export type Value = { value: typeof ab };'));
  assert.equal(exportedTypes("apps/a/src/a.ts", 'export type Alias = Protocol["value"]; export type Utility = Pick<Protocol,"id">; export type Callback = (message: string) => void; export type Generic<T> = { value: T }; export interface Empty extends Base {}').length, 0);
  assert.equal(exportedTypes("apps/a/src/a.ts", 'export function f(): { value: string } { throw 0; }').length, 0);
  assert.equal(exportedTypes("apps/a/src/a.ts", 'export { Shape } from "./elsewhere.js"; interface Shape { value: string; }').length, 0);
});

test("type debt is exact, refuses extra copies, and becomes stale after unification", () => {
  const source = 'export interface ArchiveSessionMetadata { project: string; location: string; agent: string; }';
  const first = exportedTypes("apps/a/src/a.ts", source);
  const second = exportedTypes("packages/b/src/b.ts", source);
  const debt = [{ file: "existing.json", reason: "Pre-existing shared contract awaiting unification.", declarations: [...first, ...second] }];
  assert.deepEqual(violations([...first, ...second], debt), []);
  assert.match(violations(first, debt).join("\n"), /Stale duplicate-type debt/u);
  const third = exportedTypes("apps/c/src/c.ts", source);
  const problems = violations([...first, ...second, ...third], debt).join("\n");
  assert.match(problems, /Unrecorded duplicate exported type declaration/u);
  assert.match(problems, /Stale duplicate-type debt/u);
  for (const { symbol, path } of [...first, ...second, ...third]) assert.ok(problems.includes(`${symbol}: ${path}`));
  assert.deepEqual(violations([...first, ...exportedTypes("apps/a/src/other.ts", source)], []), []);
  const union = 'export type Ref = { kind: "kept"; id: string } | { kind: "deleted"; name: string };';
  assert.equal(violations([...exportedTypes("apps/a/src/a.ts", union), ...exportedTypes("apps/b/src/b.ts", union)], []).length, 1);
});
