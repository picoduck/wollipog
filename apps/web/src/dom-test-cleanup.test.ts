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
 * Components that put a `StoreProvider` on the page without the caller naming it.
 *
 * Derived rather than hardcoded, because the first version of this guard matched the literal string
 * `StoreProvider` and therefore missed `InstanceRuntimeHost.dom.test.tsx`, which mounts one through
 * a wrapper. That file still had the original bug while the guard reported everything clean — a
 * false negative is worse than no guard, because it looks like coverage.
 *
 * The e2e fixtures under `src/e2e` are excluded: they are browser entry points, not `node:test`
 * files, so they never register a Node hook.
 */
function storeProviderWrappers(files: string[]): string[] {
  return files
    .filter((path) => !isTest(path) && !path.includes(`${SRC}e2e/`))
    .filter((path) => readFileSync(path, "utf8").includes("<StoreProvider"))
    .map((path) => basename(path).replace(/\.tsx?$/u, ""));
}

/** A happy-dom test that reaches a `StoreProvider`, directly or through one of those wrappers. */
function storeProviderDomTests(files: string[]): string[] {
  const wrappers = storeProviderWrappers(files);
  return files
    .filter((path) => isTest(path) && basename(path) !== SELF)
    .filter((path) => {
      const source = readFileSync(path, "utf8");
      if (!source.includes("new Window(")) return false;
      return source.includes("StoreProvider") || wrappers.some((name) => source.includes(name));
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
    storeProviderWrappers(files).length > 0,
    "no module renders <StoreProvider any more; the wrapper derivation is measuring nothing",
  );
  assert.ok(
    candidates.length > 1,
    `only ${candidates.length} DOM test reaches a StoreProvider — too few for this guard to be ` +
    "meaningful. If that is genuinely correct, delete the guard rather than letting it pass vacuously.",
  );
});
