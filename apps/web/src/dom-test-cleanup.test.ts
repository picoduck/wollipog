import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) out.push(path);
  }
  return out;
}

/**
 * The guardrail for #690.
 *
 * A DOM test that mounts `StoreProvider` starts the store's self-rescheduling stall clock, and a
 * file that does not install the shared cleanup cannot stop it when an assertion throws — the file
 * then stalls for minutes past `--test-timeout` and a plain test failure reads as a hung suite.
 * That is invisible in review unless something checks for it, so this checks for it.
 */
test("every DOM test that mounts StoreProvider installs the shared cleanup", () => {
  const offenders = sourceFiles(SRC)
    .filter((path) => {
      const source = readFileSync(path, "utf8");
      return source.includes("StoreProvider") && source.includes("new Window(")
        && !source.includes("installDomTestCleanup(");
    })
    .map((path) => path.slice(SRC.length));

  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(", ")}: mounts StoreProvider in a happy-dom window without installDomTestCleanup(domWindow). ` +
    "Add it beside the window so a failing assertion cannot leave the store's stall clock running (#690).",
  );
});

test("the guardrail reads the marker it claims to, so it cannot pass vacuously", () => {
  // Both halves of the predicate matter: a file that mounts StoreProvider is only exempt because it
  // installs the cleanup, never because the scan failed to find any files at all.
  const scanned = sourceFiles(SRC);
  assert.ok(scanned.length > 0, "the source scan found no test files, so the guardrail proves nothing");
  const storeProviderTests = scanned.filter((path) => {
    const source = readFileSync(path, "utf8");
    return source.includes("StoreProvider") && source.includes("new Window(");
  });
  assert.ok(
    storeProviderTests.length > 0,
    "no DOM test mounts StoreProvider any more; delete this guardrail rather than letting it pass on an empty set",
  );
});
