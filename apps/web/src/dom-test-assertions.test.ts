import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import ts from "typescript";
import { assertNoDomNode, describeDomNode } from "./dom-test-assertions.js";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const WEB = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

/** Every `node:assert` comparison whose failure message is built by inspecting both operands. */
const INSPECTING_ASSERTIONS = new Set(["equal", "strictEqual", "deepEqual", "deepStrictEqual"]);

/**
 * Is this value a DOM node once `null` and `undefined` are set aside?
 *
 * Decided from the TYPE, not the text, because the text cannot tell: `assert.equal(badge, null)`
 * is a node in one file and a string in the next, and a guard matching `querySelector(` would miss
 * the first and flag nothing useful. Lib `Node` covers `document.querySelector`; happy-dom's own
 * `Element` is a separate type that is not assignable to it, so a type carrying both `nodeType` and
 * `parentNode` also counts — that is how `domWindow.document.querySelector(...)` is recognised.
 *
 * `any`, `unknown` and `never` are not nodes. Flagging them would fail files whose null checks are
 * legitimate, and a guard that cries wolf gets switched off.
 */
function isNodeValued(checker: ts.TypeChecker, nodeType: ts.Type, expression: ts.Expression): boolean {
  const type = checker.getNonNullableType(checker.getTypeAtLocation(expression));
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
  return checker.isTypeAssignableTo(type, nodeType)
    || Boolean(checker.getPropertyOfType(type, "nodeType") && checker.getPropertyOfType(type, "parentNode"));
}

/** `file:line` for every node-valued `assert.equal(..., null)` (or its variants) in `files`. */
function nodeNullAssertions(program: ts.Program, files: string[]): string[] {
  const checker = program.getTypeChecker();
  const nodeSymbol = checker.resolveName("Node", undefined, ts.SymbolFlags.Type, false);
  assert.ok(nodeSymbol, "the DOM lib must be loaded, or no node can be recognised");
  const nodeType = checker.getDeclaredTypeOfSymbol(nodeSymbol);
  const offenders: string[] = [];
  for (const file of files) {
    const sourceFile = program.getSourceFile(file);
    assert.ok(sourceFile, `${file} is part of the program`);
    const visit = (node: ts.Node): void => {
      const [first, second] = ts.isCallExpression(node) ? node.arguments : [];
      if (ts.isCallExpression(node) && first && second) {
        const callee = node.expression;
        const name = ts.isPropertyAccessExpression(callee) ? callee.name.text
          : ts.isIdentifier(callee) ? callee.text : "";
        const isNull = (argument: ts.Expression) => argument.kind === ts.SyntaxKind.NullKeyword;
        const subject = isNull(second) ? first : isNull(first) ? second : undefined;
        if (INSPECTING_ASSERTIONS.has(name) && subject && isNodeValued(checker, nodeType, subject)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          offenders.push(`${relative(WEB, file)}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return offenders;
}

function compilerOptions(): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(WEB, "tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  assert.ok(parsed, "apps/web/tsconfig.json parses");
  return { ...parsed.options, noEmit: true };
}

test("a failing absence check reports promptly, naming the element it found", () => {
  const domWindow = new Window();
  try {
    const menu = domWindow.document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.className = "menu editor-menu";
    menu.textContent = "  Open in\n   VS Code  ";
    domWindow.document.body.appendChild(menu);

    const started = performance.now();
    assert.throws(
      () => assertNoDomNode(domWindow.document.querySelector('[role="menu"]'), "selection closes the menu"),
      (error: Error) => {
        assert.equal(error.message,
          'selection closes the menu: found div.menu.editor-menu[role="menu"] with text "Open in VS Code"');
        return true;
      },
    );
    // `assert.equal(menu, null)` takes over ten seconds here and builds a 2.7-million-character
    // message. A second is orders of magnitude of headroom, not a tuned threshold.
    assert.ok(performance.now() - started < 1000, "the failure is reported without inspecting the node");

    assert.throws(() => assertNoDomNode(menu), {
      message: 'expected no element, found div.menu.editor-menu[role="menu"] with text "Open in VS Code"',
    });
  } finally {
    domWindow.close();
  }
});

test("only null passes, exactly as assert.equal(found, null) did", () => {
  assertNoDomNode(null);
  assertNoDomNode(null, "nothing rendered");
  // An optional chain that short-circuits yields `undefined`, which `assert.equal(x, null)` rejects
  // under `node:assert/strict`. The migration must not quietly turn that failure into a pass.
  assert.throws(() => assertNoDomNode(undefined, "the alert has no retry"), {
    message: "the alert has no retry: found undefined rather than null",
  });
});

test("the element description stays short whatever the element carries", () => {
  const domWindow = new Window();
  try {
    const button = domWindow.document.createElement("button");
    button.id = "retry";
    button.className = "a b c d";
    button.setAttribute("aria-label", "Retry");
    button.setAttribute("data-testid", "retry-button");
    button.textContent = "x".repeat(500);
    const description = describeDomNode(button);
    assert.ok(description.startsWith('button#retry.a.b.c…[data-testid="retry-button"][aria-label="Retry"] with text "'),
      description);
    assert.ok(description.length < 200, `bounded, got ${description.length} characters`);

    // Every part is bounded, not just the text: a long id, class or attribute value would otherwise
    // rebuild the oversized message this helper exists to avoid.
    const huge = "y".repeat(100_000);
    const noisy = domWindow.document.createElement("div");
    noisy.id = huge;
    noisy.className = `${huge} ${huge} ${huge} ${huge}`;
    for (const name of ["role", "data-testid", "aria-label", "name", "type"]) noisy.setAttribute(name, huge);
    noisy.textContent = huge;
    const noisyDescription = describeDomNode(noisy);
    assert.ok(noisyDescription.length < 1000, `bounded, got ${noisyDescription.length} characters`);
    assert.equal(describeDomNode(domWindow.document.createTextNode("  ")), "#text");
  } finally {
    domWindow.close();
  }
});

/**
 * The guardrail for #1943.
 *
 * `assert.equal(node, null)` failing on a happy-dom node takes seconds and megabytes to report, and
 * in a rendered test long enough for the file to be killed with no result. `assertNoDomNode` is the
 * replacement; this keeps the old shape from coming back.
 */
test("no DOM test compares a node with null through node:assert", () => {
  const files = sourceFiles(SRC);
  const offenders = nodeNullAssertions(ts.createProgram(files, compilerOptions()), files);
  assert.deepEqual(offenders, [],
    "use assertNoDomNode(found, message) from src/dom-test-assertions.ts: when assert.equal(node, null) "
    + "fails it inspects the whole node, which takes seconds and can get the test file killed (#1943)");
});

test("the guard flags node-valued null assertions and nothing else", () => {
  // A clean tree passes the test above whether or not the detector works. This is the other half:
  // the detector run on every shape the migration covered, and on legitimate null checks it must
  // leave alone. The fixture is virtual but sits in `src`, so `happy-dom` resolves as it does there.
  const fixture = join(SRC, "__dom-null-assertion-fixture__.ts");
  const lines = [
    'import assert from "node:assert/strict";',
    'import { Window } from "happy-dom";',
    "const domWindow = new Window();",
    "declare const container: HTMLElement;",
    "declare const label: string | null;",
    "declare const count: number | null | undefined;",
    "declare const loose: any;",
    "declare const opaque: unknown;",
    "declare const record: { nodeType: number } | null;",
    // Flagged, one per line from here.
    'assert.equal(container.querySelector(".menu"), null);',
    'assert.strictEqual(container.querySelector("button"), null, "a message");',
    'assert.equal(domWindow.document.querySelector(\'[role="menu"]\'), null);',
    'assert.equal(container.querySelectorAll("li")[2], null);',
    'assert.equal(container.closest("dialog")?.querySelector("button"), null);',
    "assert.equal(null, container.parentElement);",
    "assert.deepEqual(container.firstElementChild, null);",
    // Not flagged, from here.
    "assert.equal(label, null);",
    "assert.strictEqual(count, null);",
    "assert.equal(loose, null);",
    "assert.equal(opaque, null);",
    "assert.equal(record, null);",
    'assert.notEqual(container.querySelector(".menu"), null);',
    'assert.equal(container.querySelector(".menu"), container);',
    'assert.equal(container.getAttribute("role"), null);',
  ];
  const firstFlagged = lines.indexOf('assert.equal(container.querySelector(".menu"), null);') + 1;
  const flaggedCount = 7;
  const source = lines.join("\n");
  const host = ts.createCompilerHost(compilerOptions());
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (name, language, ...rest) => name === fixture
    ? ts.createSourceFile(name, source, language, true)
    : getSourceFile.call(host, name, language, ...rest);
  host.fileExists = (name) => name === fixture || fileExists.call(host, name);
  host.readFile = (name) => name === fixture ? source : readFile.call(host, name);
  const program = ts.createProgram([fixture], compilerOptions(), host);

  const expected = Array.from({ length: flaggedCount },
    (_, index) => `${relative(WEB, fixture)}:${firstFlagged + index}`);
  assert.deepEqual(nodeNullAssertions(program, [fixture]), expected);
});
