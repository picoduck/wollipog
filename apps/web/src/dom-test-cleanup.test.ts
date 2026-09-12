import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const SELF = "dom-test-cleanup.test.ts";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

const isTest = (path: string) => path.endsWith(".test.ts") || path.endsWith(".test.tsx");

/**
 * Modules that hand a caller a `StoreProvider` without the caller naming it.
 *
 * Derived, but only ONE level, and deliberately so. Three richer versions were tried and all three
 * were wrong. Matching the literal `StoreProvider` missed `InstanceRuntimeHost.dom.test.tsx`, which
 * mounts one through a wrapper. Closing the set transitively then contaminated it — `<App` matches
 * `<ApprovalBar`, so the closure swept in `ComposerControls` and `SessionApproval` and the guard
 * flagged thirty-two innocent files. Source text cannot tell a JSX tag from a longer identifier
 * that starts the same way, and a guard that cries wolf is worse than one with a stated limit.
 *
 * KNOWN LIMIT: a test mounting a SECOND-level wrapper — `App`, which renders `InstanceRuntimeHost`
 * — is not flagged. No such test exists today (no windowed test imports `App.js`), and the honest
 * fix if one appears is to add it here rather than to widen the matching until it lies again.
 */
function storeProviderModules(files: string[]): string[] {
  return files
    .filter((path) => !isTest(path) && !path.includes(`${SRC}e2e/`))
    .filter((path) => readFileSync(path, "utf8").includes("<StoreProvider"))
    .map((path) => basename(path));
}

/**
 * A happy-dom test that puts a `StoreProvider` on the page, directly or through such a module.
 *
 * Matched on IMPORT SPECIFIERS, never on bare component names: an import is the precise statement
 * that this file can mount that module, where a name is just a string that might be a prefix of
 * something else entirely.
 */
function storeProviderDomTests(files: string[]): string[] {
  const specifiers = ["store.js", ...storeProviderModules(files).map((name) => name.replace(/\.tsx?$/u, ".js"))];
  return files
    .filter((path) => isTest(path) && basename(path) !== SELF)
    .filter((path) => {
      const source = readFileSync(path, "utf8");
      if (!/^(?:const|let) \w+ = new Window\(/mu.test(source)) return false;
      return specifiers.some((specifier) => source.includes(`/${specifier}"`) || source.includes(`"./${specifier}"`));
    });
}

/**
 * Modules whose own effects start a REPEATING timer.
 *
 * The #690 guard keys on the store, but the store's stall clock was only one instance of the
 * hazard: any component that reschedules work and clears it in an effect teardown holds the
 * process open when an assertion throws before the test's trailing unmount. `UsageView` proved
 * that with a plain 30s `setInterval` and no `StoreProvider` anywhere near it (#899).
 *
 * Derived rather than listed, so a component that starts a timer tomorrow is covered without
 * anyone remembering this file. Two shapes hold the loop open: `setInterval`, and a `setTimeout`
 * that reschedules ITSELF — which is what #690's own root cause was, so excluding timeouts
 * outright would have missed the original bug. `AgentsPanel` does exactly that today.
 *
 * The self-rescheduling case is read from the AST, not matched as text, and the difference is not
 * academic: `setTimeout(<identifier>,` matches eight modules here and only one of them
 * reschedules. The other seven include `store.tsx` and `SessionDetail.tsx`, which are mounted all
 * over the suite, so a text match would have demanded the hook in files that never needed it.
 *
 * KNOWN LIMIT, the same one the set above carries: this matches a test's OWN imports, so a test
 * that reaches a timer-owning module through a wrapper is not flagged. The honest fix when one
 * appears is to name it here, not to widen the matching until it starts crying wolf.
 */
function timerOwningModules(files: string[]): string[] {
  return files
    .filter((path) => !isTest(path) && !path.includes(`${SRC}e2e/`))
    .filter((path) => {
      const source = readFileSync(path, "utf8");
      return /\bsetInterval\s*\(/u.test(source) || reschedulesItself(source, path);
    })
    .map((path) => basename(path));
}

/** The objects a timer is reached through. `window.setTimeout` is as repeating as the bare form. */
const TIMER_GLOBALS = new Set(["window", "globalThis", "self"]);

function isTimeoutCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === "setTimeout";
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "setTimeout"
    && ts.isIdentifier(callee.expression) && TIMER_GLOBALS.has(callee.expression.text);
}

/** Does this callback body call one of the functions it is written inside? */
function callsAnyOf(node: ts.Node, names: string[]): boolean {
  let calls = false;
  const walk = (inner: ts.Node): void => {
    if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && names.includes(inner.expression.text)) {
      calls = true;
    }
    ts.forEachChild(inner, walk);
  };
  walk(node);
  return calls;
}

/**
 * A `setTimeout` written INSIDE the body of a function it re-arms — a timer that never stops.
 *
 * Both ways of naming the function count, because both appear here: the function handed over
 * directly, as `AgentsPanel` and `store.tsx`'s reconnect loop do, and the function called from
 * inside an arrow, as `store.tsx`'s stall clock does — the very clock #690 was about, so a
 * derivation blind to it would not have caught the original bug.
 *
 * The repository happens to satisfy the first shape in more places than the second, so the test
 * below exercises all three shapes on synthetic sources rather than trusting that some file keeps
 * carrying each one.
 */
function reschedulesItself(source: string, path: string): boolean {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node, enclosing: string[]): void => {
    let names = enclosing;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      names = [...enclosing, node.name.text];
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      names = [...enclosing, node.name.text];
    }
    if (ts.isCallExpression(node) && isTimeoutCall(node)) {
      const callback = node.arguments[0];
      // Only the function whose body OWNS this timeout counts. Matching any ancestor would flag
      // `function outer() { function armOnce() { setTimeout(() => outer(), 10); } }`, where
      // arming happens once and nothing repeats — a file forced to install cleanup it never
      // needed, which is the crying-wolf failure this file exists to avoid.
      const owner = names.at(-1);
      if (callback && ts.isIdentifier(callback) && owner === callback.text) found = true;
      else if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        && owner !== undefined && callsAnyOf(callback, [owner])) found = true;
    }
    ts.forEachChild(node, (child) => visit(child, names));
  };
  visit(tree, []);
  return found;
}

/**
 * Does this file tear the window down from somewhere a thrown assertion cannot skip?
 *
 * Two mechanisms in this repo do that, and the guard accepts either rather than mandating one.
 * `installDomTestCleanup` is the shared helper; a `close()` on the window from a `node:test`
 * `after` hook reaches the same end, and `WorkingIndicator.dom.test.tsx` already did it that way —
 * measured, it fails in ~1s rather than hanging. Demanding the helper there would be crying wolf
 * at a file that is already correct, which is the failure mode this file exists to avoid.
 *
 * KNOWN LIMIT: this reads source text, so it sees that a teardown is PRESENT, not that it always
 * RUNS. A `close()` parked inside a test body would satisfy it and should not. That is the same
 * trade the set above makes, and the same answer applies — when it lies, name the file here.
 */
function hasWindowTeardown(source: string): boolean {
  if (source.includes("installDomTestCleanup(")) return true;
  // The close must be on THE WINDOW. A bare `/\.close\(\)/` would also accept a socket, a dialog
  // or a mock closing itself and wave through a file that genuinely hangs — a guard green for the
  // wrong reason, which is worse than no guard. Nothing does that today; this keeps it that way.
  const binding = /^(?:const|let) (\w+) = new Window\(/mu.exec(source);
  if (!binding) return false;
  return new RegExp(`\\b${binding[1]}\\.(?:happyDOM\\.)?(?:close|abort)\\(`, "u").test(source);
}

/** Happy-dom tests that import one of those modules directly. */
function timerOwningDomTests(files: string[]): string[] {
  const specifiers = timerOwningModules(files).map((name) => name.replace(/\.tsx?$/u, ".js"));
  return files
    .filter((path) => isTest(path) && basename(path) !== SELF)
    .filter((path) => {
      const source = readFileSync(path, "utf8");
      if (!/^(?:const|let) \w+ = new Window\(/mu.test(source)) return false;
      return specifiers.some((specifier) => source.includes(`/${specifier}"`) || source.includes(`"./${specifier}"`));
    });
}

/**
 * The guardrail for #899.
 *
 * Same failure as #690 — a failing assertion cannot stop a rescheduling timer, so the file stalls
 * past `--test-timeout` and a plain failure reads as a hung suite — reached by a different route.
 * The store is not the only thing that keeps time, so this checks the hazard rather than the store.
 */
test("every DOM test that mounts a timer-owning module installs the shared cleanup", () => {
  const offenders = timerOwningDomTests(sourceFiles(SRC))
    .filter((path) => !hasWindowTeardown(readFileSync(path, "utf8")))
    .map((path) => path.slice(SRC.length));

  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(", ")}: mounts a module that starts a repeating timer in a happy-dom ` +
    "window with no teardown outside the test bodies. Add installDomTestCleanup(domWindow) beside " +
    "the window, so a failing assertion cannot leave that timer rescheduling and hang the run " +
    "(#899). A close() on the window from an after hook satisfies this too.",
  );
});

/** Every shape of self-rescheduling timer this repository actually contains, on fixed input. */
test("the self-rescheduling detector reads each timer shape, and nothing else", () => {
  const detect = (source: string) => reschedulesItself(source, "probe.ts");
  // Bare call, function handed over directly.
  assert.ok(detect("const refresh = () => { setTimeout(refresh, 10); };"));
  // Reached through a global, which is how most of this app writes it.
  assert.ok(detect("const open = () => { window.setTimeout(open, 10); };"));
  assert.ok(detect("function poll() { globalThis.setTimeout(poll, 10); }"));
  // Called from inside a wrapper rather than handed over — #690's own stall clock.
  assert.ok(detect("const schedule = () => { window.setTimeout(() => { tick(); schedule(); }, 10); };"));
  assert.ok(detect("function schedule() { setTimeout(function () { schedule(); }, 10); }"));
  // A timeout that does not re-arm the function it sits in is not this hazard, and a guard that
  // said otherwise would demand cleanup from most of the app.
  assert.ok(!detect("const show = () => { setTimeout(hide, 10); };"));
  assert.ok(!detect("const show = () => { window.setTimeout(() => hide(), 10); };"));
  assert.ok(!detect("const show = () => { other.setTimeout(show, 10); };"));
  // A timeout inside a NESTED function re-arms that function, not its ancestor. Arming `armOnce`
  // schedules one call; nothing repeats, so demanding cleanup here would be crying wolf.
  assert.ok(!detect("function outer() { function armOnce() { setTimeout(() => outer(), 10); } return armOnce; }"));
  assert.ok(!detect("const outer = () => { const armOnce = () => { setTimeout(outer, 10); }; return armOnce; };"));
});

/**
 * The #899 guard passes trivially if its derivation stops finding candidates — a regex or a source
 * refactor could empty the set and nothing would say so. This states the set is non-empty and
 * still contains the file that motivated it, so the guard cannot go quiet without failing.
 */
test("the timer-owning derivation still finds the files it was built for", () => {
  const files = sourceFiles(SRC);
  assert.ok(timerOwningModules(files).includes("UsageView.tsx"),
    "UsageView owns a setInterval; a derivation that misses it is protecting nothing");
  assert.ok(timerOwningModules(files).includes("AgentsPanel.tsx"),
    "AgentsPanel hands a setTimeout its own function, the bare-identifier shape");
  assert.ok(timerOwningModules(files).includes("store.tsx"),
    "store.tsx is #690's own stall clock; a derivation that misses it would not have caught that bug");
  assert.ok(timerOwningModules(files).includes("SessionDetail.tsx"),
    "SessionDetail re-arms a window.setTimeout, the qualified-call shape");
  assert.ok(timerOwningDomTests(files).length > 0, "no candidate tests: the guard below is vacuous");
});

/**
 * The guardrail for #690.
 *
 * A DOM test that mounts `StoreProvider` starts the store's self-rescheduling stall clock, and a
 * file that does not install the shared cleanup cannot stop it when an assertion throws — the file
 * then stalls for minutes past `--test-timeout` and a plain test failure reads as a hung suite.
 * That is invisible in review unless something checks for it, so this checks for it.
 */
test("every DOM test that reaches a StoreProvider installs the shared cleanup", () => {
  const offenders = storeProviderDomTests(sourceFiles(SRC))
    .filter((path) => !readFileSync(path, "utf8").includes("installDomTestCleanup("))
    .map((path) => path.slice(SRC.length));

  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(", ")}: mounts a StoreProvider in a happy-dom window without ` +
    "installDomTestCleanup(domWindow). Add it beside the window so a failing assertion cannot leave " +
    "the store's stall clock running (#690).",
  );
});

test("the guardrail measures a real, non-empty set of files", () => {
  const files = sourceFiles(SRC);
  // This file names both markers in its own predicate and prose, so counting it would let the
  // check below pass on a set containing nothing but itself.
  const candidates = storeProviderDomTests(files).map((path) => path.slice(SRC.length));
  assert.ok(
    !candidates.some((path) => path.endsWith(SELF)),
    "the guardrail is inspecting itself, so its own markers could stand in for real coverage",
  );
  assert.ok(
    storeProviderModules(files).length > 0,
    "no module renders <StoreProvider any more; the derivation is measuring nothing",
  );
  assert.ok(
    candidates.length > 1,
    `only ${candidates.length} DOM test reaches a StoreProvider — too few for this guard to be ` +
    "meaningful. If that is genuinely correct, delete the guard rather than letting it pass vacuously.",
  );
});
