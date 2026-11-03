import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyPathMatch, fuzzyPathNeedle, fuzzyPathScore } from "./index.js";

const score = (path: string, query: string) => fuzzyPathScore(path, fuzzyPathNeedle(query));
const matched = (path: string, query: string) =>
  fuzzyPathMatch(path, fuzzyPathNeedle(query))?.positions.map((at) => path[at]).join("");

test("a query matches when its characters appear in the path in order, ignoring case and spaces", () => {
  assert.equal(fuzzyPathNeedle("  SD tsx "), "sdtsx");
  assert.notEqual(score("apps/web/src/components/SessionDetail.tsx", "sdtsx"), null);
  assert.notEqual(score("apps/web/src/components/SessionDetail.tsx", "Session Detail"), null);
  assert.equal(score("apps/web/src/components/SessionDetail.tsx", "xstd"), null, "out of order");
  assert.equal(score("src/a.ts", "src/a.tsx"), null, "longer than what is there");
  assert.equal(score("src/a.ts", "   "), null, "an empty needle matches nothing");
});

test("the match underlines the characters that start words in the file name", () => {
  const path = "apps/web/src/components/SessionDetail.tsx";
  const positions = fuzzyPathMatch(path, "sdtsx")!.positions;
  assert.deepEqual(positions, [24, 31, 38, 39, 40]);
  assert.equal(matched(path, "sdtsx"), "SDtsx");
  assert.equal(matched("src/checks/check-list.ts", "check"), "check", "a whole run, not scattered letters");
  assert.equal(fuzzyPathMatch("src/check-list.ts", "check")!.positions[0], 4, "the run in the name, not the folder");
});

test("name matches, word starts and runs outrank scattered and folder-only matches", () => {
  const ranked = (query: string, paths: string[]) =>
    [...paths].sort((a, b) => (score(b, query) ?? -Infinity) - (score(a, query) ?? -Infinity));
  assert.deepEqual(ranked("index", ["src/indexer/a.ts", "src/index.ts", "src/main-index-utils.ts"]), [
    "src/index.ts",
    "src/main-index-utils.ts",
    "src/indexer/a.ts",
  ]);
  assert.deepEqual(ranked("check", ["checks/run.ts", "src/precheck.ts", "src/checkout.ts"]), [
    "src/checkout.ts",
    "src/precheck.ts",
    "checks/run.ts",
  ]);
  assert.ok(score("README.md", "readme.md")! > score("docs/README.md.bak", "readme.md")!, "an exact name wins");
  assert.ok(score("lib/widget-index.ts", "index")! > score("lib/binder-example.ts", "index")!, "a run beats scattered letters");
  assert.ok(score("src/ShellDock.tsx", "sdtsx")! > score("src/sidebar-details.tsx", "sdtsx")!, "fewer skipped letters win");
});

test("offsets stay aligned with the path when a character lower-cases to two", () => {
  const path = "İ/data.ts";
  assert.equal("İ".toLowerCase().length, 2);
  assert.equal(matched(path, "data"), "data");
});

test("a very long path is matched without the full alignment and still ends in the name", () => {
  const path = `${"a/".repeat(40_000)}deep-name.ts`;
  const found = fuzzyPathMatch(path, fuzzyPathNeedle("dn"));
  assert.ok(found);
  assert.deepEqual(found.positions.map((at) => path[at]), ["d", "n"]);
  assert.ok(found.positions[0]! > path.lastIndexOf("/"), "the characters land in the file name");
  assert.equal(fuzzyPathScore(path, "zz"), null);
});
