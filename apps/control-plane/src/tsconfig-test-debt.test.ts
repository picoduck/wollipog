import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `tsconfig.test.json` typechecks this package's test files, minus a list of files that do not
 * typecheck yet (#1435). That list is debt: it exists so the gate could be turned on before every
 * file was fixed, and it is only ever meant to shrink. These assertions keep it honest — a stale
 * entry would silently keep a fixed file unchecked, and an unsorted list makes its diffs unreadable.
 * Nothing here can force it to shrink; that is what review is for.
 *
 * This is the third near-copy of this guard (`apps/web`, `apps/runner`, here). Now that the shape
 * has settled across three packages, folding it into `@wollipog/test-support` is worth doing. */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function excludedTestFiles(): string[] {
  const raw = readFileSync(join(PACKAGE_ROOT, "tsconfig.test.json"), "utf8");
  // The config carries leading `//` comments explaining the list; strip them before parsing.
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as { exclude?: string[] };
  return config.exclude ?? [];
}

test("the typecheck debt list names only real, unfixed test files", () => {
  const excluded = excludedTestFiles();
  assert.ok(excluded.length > 0, "an empty list means this guard and the list itself can be deleted");

  const missing = excluded.filter((file) => !existsSync(join(PACKAGE_ROOT, file)));
  assert.deepEqual(missing, [], "these files no longer exist — drop them from tsconfig.test.json");

  const notTests = excluded.filter((file) => !/^src\/[^\s]*\.test\.ts$/.test(file));
  assert.deepEqual(notTests, [],
    "only this package's own test files may be excluded, never production source");
});

test("the typecheck debt list stays sorted and free of duplicates", () => {
  const excluded = excludedTestFiles();
  assert.deepEqual(excluded, [...excluded].sort(), "keep the list sorted so its diffs stay readable");
  assert.equal(new Set(excluded).size, excluded.length, "the list contains a duplicate");
});
