import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A package's `tsconfig.test.json` typechecks its test files, minus an `exclude` list of files that
 * do not typecheck yet (#1435). That list is debt: it exists so the gate could be turned on before
 * every file was fixed, and it is only ever meant to shrink.
 *
 * An entry must be one of the package's own test files, with no whitespace in the path. Anything
 * else — production source, a directory, a glob — would widen what escapes the typecheck. */
const DEBT_ENTRY = /^src\/[^\s]*\.test\.tsx?$/;

/** The `exclude` list from a `tsconfig.test.json`. The config carries `//` comments explaining the
 * list, which plain JSON rejects, so whole-line comments are stripped before parsing. */
export function parseTestTypecheckDebt(configText: string): string[] {
  const config = JSON.parse(configText.replace(/^\s*\/\/.*$/gm, "")) as { exclude?: unknown };
  // Only an absent list means no debt; `?? []` would also read an explicit `null` as empty.
  const exclude = config.exclude === undefined ? [] : config.exclude;
  if (!Array.isArray(exclude) || !exclude.every((entry) => typeof entry === "string")) {
    throw new TypeError("tsconfig.test.json `exclude` must be an array of strings");
  }
  return exclude;
}

/** Register the tests that keep a package's typecheck debt list honest. A stale entry would silently
 * keep a fixed file unchecked, an unsorted list makes its diffs unreadable, and a non-test entry
 * could hide production source. Nothing here can force the list to shrink; that is review's job.
 *
 * Call it from a test file, passing the package root: `new URL("..", import.meta.url)` from a file
 * directly under `src/`. */
export function registerTypecheckDebtGuard(packageRoot: URL): void {
  const root = fileURLToPath(packageRoot);
  const excluded = () => parseTestTypecheckDebt(readFileSync(join(root, "tsconfig.test.json"), "utf8"));

  test("the typecheck debt list names only real, unfixed test files", () => {
    const entries = excluded();
    assert.ok(entries.length > 0, "an empty list means this guard and the list itself can be deleted");

    const missing = entries.filter((file) => !existsSync(join(root, file)));
    assert.deepEqual(missing, [], "these files no longer exist — drop them from tsconfig.test.json");

    const notTests = entries.filter((file) => !DEBT_ENTRY.test(file));
    assert.deepEqual(notTests, [],
      "only this package's own test files may be excluded, never production source");
  });

  test("the typecheck debt list stays sorted and free of duplicates", () => {
    const entries = excluded();
    assert.deepEqual(entries, [...entries].sort(), "keep the list sorted so its diffs stay readable");
    assert.equal(new Set(entries).size, entries.length, "the list contains a duplicate");
  });
}
