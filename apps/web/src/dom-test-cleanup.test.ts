import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
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
