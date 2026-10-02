import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

/**
 * `runnerCapabilityRequirement` places its label mid-sentence ("This machine needs a newer runner
 * for directory browsing."), so every label is a lowercase noun phrase. Capitals are allowed only
 * for proper nouns and acronyms. The guard follows labels through the wrappers that forward them
 * (a function whose label parameter reaches a sink becomes a sink) and through `{ capability,
 * label }` requirement objects, and fails on any label it cannot read statically.
 */
const SOURCE_ROOTS = ["apps/web/src", "apps/control-plane/src", "packages/protocol/src"].map((root) =>
  path.resolve(root));
const SEED_SINKS = new Map([
  ["runnerCapabilityRequirement", 2],
  ["runnerCapabilityRequirementError", 2],
]);
/** Product, platform and harness names that stay capitalized in running prose. */
const PROPER_NOUNS = new Set([
  "Claude", "Codex", "Git", "GitHub", "GitLab", "Linux", "Orchestrator", "Pi", "Windows", "Wollipog", "macOS",
]);
/** Multi-word names whose first word is not a proper noun on its own. */
const PROPER_PHRASES = ["Native TUI"];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const target = path.join(directory, entry);
    if (statSync(target).isDirectory()) return sourceFiles(target);
    if (!/\.(?:ts|tsx)$/.test(entry) || /\.test\.(?:ts|tsx)$/.test(entry) || entry.endsWith(".d.ts")) return [];
    if (entry.endsWith(".generated.ts")) return [];
    return [target];
  });
}

function labelCasingProblem(label: string): string | null {
  let rest = label;
  for (const phrase of PROPER_PHRASES) rest = rest.split(phrase).join(" ");
  for (const word of rest.split(/[^A-Za-z0-9]+/u)) {
    if (!/[A-Z]/u.test(word) || PROPER_NOUNS.has(word)) continue;
    // Acronyms (TUI, ACP, MCP, WSL), including a plural "s".
    if (/^[A-Z][A-Z0-9]+s?$/u.test(word)) continue;
    return `"${word}" is capitalized but is not a proper noun or acronym`;
  }
  return null;
}

interface LabelSite {
  file: string;
  line: number;
  label: string;
}

interface LabelScan {
  labels: LabelSite[];
  unresolved: string[];
}

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function functionName(node: ts.SignatureDeclaration): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
    return ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name) ? node.name.text : null;
  }
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  return null;
}

type Binding =
  | { kind: "parameter"; owner: string | null; index: number }
  | { kind: "constant"; initializer: ts.Expression };

/** The declaration an identifier refers to, found by walking out through its enclosing scopes, so
 * a `label` in one function never resolves to another function's `label`. */
function binding(identifier: ts.Identifier): Binding | null {
  const declares = (statement: ts.Statement) => ts.isVariableStatement(statement)
    ? statement.declarationList.declarations.find((declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === identifier.text)
    : undefined;
  for (let node: ts.Node | undefined = identifier.parent; node; node = node.parent) {
    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseOrDefaultClause(node)) {
      for (const statement of node.statements) {
        const declaration = declares(statement);
        if (!declaration) continue;
        return declaration.initializer ? { kind: "constant", initializer: declaration.initializer } : null;
      }
    }
    if (ts.isFunctionLike(node)) {
      const index = node.parameters.findIndex((parameter) =>
        ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text);
      if (index >= 0) return { kind: "parameter", owner: functionName(node), index };
    }
  }
  return null;
}

/** Resolve a label expression to its literal text fragments, or report why it cannot be read. */
function labelTexts(
  expression: ts.Expression,
  wrappers: Map<string, number>,
): { texts: string[]; unresolved: string | null } {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return { texts: [expression.text], unresolved: null };
  }
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
    return labelTexts(expression.expression, wrappers);
  }
  if (ts.isConditionalExpression(expression)) {
    const whenTrue = labelTexts(expression.whenTrue, wrappers);
    const whenFalse = labelTexts(expression.whenFalse, wrappers);
    return {
      texts: [...whenTrue.texts, ...whenFalse.texts],
      unresolved: whenTrue.unresolved ?? whenFalse.unresolved,
    };
  }
  if (ts.isTemplateExpression(expression)) {
    // Each literal fragment is checked alone, and each substitution must itself resolve.
    const texts = [expression.head.text];
    for (const span of expression.templateSpans) {
      const inner = labelTexts(span.expression, wrappers);
      if (inner.unresolved) return { texts, unresolved: inner.unresolved };
      texts.push(...inner.texts, span.literal.text);
    }
    return { texts, unresolved: null };
  }
  if (ts.isIdentifier(expression)) {
    const bound = binding(expression);
    if (bound?.kind === "constant") return labelTexts(bound.initializer, wrappers);
    // A named function forwarding its parameter becomes a sink; its own callers are checked.
    if (bound?.kind === "parameter" && bound.owner) {
      wrappers.set(bound.owner, bound.index);
      return { texts: [], unresolved: null };
    }
  }
  // `{ capability, label }` requirement objects are checked where they are written.
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === "label") {
    return { texts: [], unresolved: null };
  }
  return { texts: [], unresolved: expression.getText() };
}

function scanRunnerCapabilityLabels(files: Array<{ file: string; text: string }>): LabelScan {
  const sources = files.map(({ file, text }) => ts.createSourceFile(
    file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  ));
  const sinks = new Map(SEED_SINKS);
  let labels: LabelSite[] = [];
  let unresolved: string[] = [];
  // Repeat until no new wrapper is discovered; each pass re-reads every call with the full sink set.
  for (let size = -1; size !== sinks.size;) {
    size = sinks.size;
    labels = [];
    unresolved = [];
    for (const sourceFile of sources) {
      const where = (node: ts.Node) =>
        `${path.relative(process.cwd(), sourceFile.fileName)}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
      const record = (node: ts.Node, expression: ts.Expression) => {
        const resolved = labelTexts(expression, sinks);
        if (resolved.unresolved) unresolved.push(`${where(node)}: ${resolved.unresolved}`);
        for (const label of resolved.texts.filter(Boolean)) {
          labels.push({ file: sourceFile.fileName, line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1, label });
        }
      };
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const name = calleeName(node.expression);
          const index = name === null ? undefined : sinks.get(name);
          if (index !== undefined) {
            const spread = node.arguments.find(ts.isSpreadElement);
            if (spread) unresolved.push(`${where(node)}: spread arguments hide the label`);
            else if (node.arguments[index]) record(node, node.arguments[index]);
            else unresolved.push(`${where(node)}: missing label argument`);
          }
        }
        if (ts.isObjectLiteralExpression(node)) {
          const property = (key: string) => node.properties.find((candidate) =>
            ts.isPropertyAssignment(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === key);
          const label = property("label");
          if (property("capability") && label && ts.isPropertyAssignment(label)) record(label, label.initializer);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }
  return { labels, unresolved };
}

test("label casing accepts lowercase phrases, proper nouns and acronyms only", () => {
  assert.equal(labelCasingProblem("directory browsing"), null);
  assert.equal(labelCasingProblem("GitHub review reconciliation"), null);
  assert.equal(labelCasingProblem("Orchestrator Native TUI"), null);
  assert.equal(labelCasingProblem("ACP MCP and additional-directory context"), null);
  assert.equal(labelCasingProblem("macOS machine skill adoption"), null);
  assert.match(labelCasingProblem("Directory browsing") ?? "", /"Directory"/);
  assert.match(labelCasingProblem("provider Sign-In") ?? "", /"Sign"/);
  assert.match(labelCasingProblem("native terminal") ?? "none", /none/);
  assert.match(labelCasingProblem("Native terminal") ?? "", /"Native"/);
});

test("the label scan follows wrappers, constants, conditionals and requirement objects", () => {
  const scan = scanRunnerCapabilityLabels([{
    file: "fixture.ts",
    text: `
      function wrap(id: string, capability: string, label: string) {
        return runnerCapabilityRequirement(1, capability, label);
      }
      class Service { private gate(id: string, capability: string, label: string) { return wrap(id, capability, label); } run() { return this.gate("r", "x", "Wrapped Label"); } }
      const fixed = "Constant Label";
      runnerCapabilityRequirement(1, "x", fixed);
      runnerCapabilityRequirementError(1, "x", flag ? "Branch One" : \`\${flag ? "GitLab" : "GitHub"} review\`);
      const requirement = { capability: "x", label: "Object Label" };
      runnerCapabilityRequirement(1, requirement.capability, requirement.label);
      runnerCapabilityRequirement(1, "x", labelFromSomewhere());
      wrap(...tuple);
    `,
  }]);
  assert.deepEqual(scan.labels.map((site) => site.label).sort(), [
    " review", "Branch One", "Constant Label", "GitHub", "GitLab", "Object Label", "Wrapped Label",
  ]);
  assert.deepEqual(scan.unresolved.map((entry) => entry.replace(/^[^ ]+ /u, "")), [
    "labelFromSomewhere()",
    "spread arguments hide the label",
  ]);
});

test("the label scan resolves each constant in its own scope", () => {
  const scan = scanRunnerCapabilityLabels([{
    file: "fixture.ts",
    text: `
      function first() { const label = "directory browsing"; return runnerCapabilityRequirement(1, "x", label); }
      function second() { const label = "Directory browsing"; return runnerCapabilityRequirement(1, "x", label); }
      [1].map((label) => runnerCapabilityRequirement(1, "x", label));
    `,
  }]);
  assert.deepEqual(scan.labels.map((site) => site.label), ["directory browsing", "Directory browsing"]);
  assert.deepEqual(scan.unresolved.map((entry) => entry.replace(/^[^ ]+ /u, "")), ["label"]);
});

test("every runner capability label in the web app and control plane is a lowercase noun phrase", () => {
  const files = SOURCE_ROOTS.flatMap(sourceFiles).map((file) => ({ file, text: readFileSync(file, "utf8") }));
  const scan = scanRunnerCapabilityLabels(files);
  assert.deepEqual(scan.unresolved, [], "pass each label as a literal so this guard can read it");
  // Guard against a scan that silently stops finding callers.
  assert.ok(scan.labels.length > 80, `expected the known callers, found ${scan.labels.length}`);
  const problems = scan.labels.flatMap(({ file, line, label }) => {
    const problem = labelCasingProblem(label);
    return problem ? [`${path.relative(process.cwd(), file)}:${line}: "${label}": ${problem}`] : [];
  });
  assert.deepEqual(problems, [], `lowercase these labels:\n${problems.join("\n")}`);
});
