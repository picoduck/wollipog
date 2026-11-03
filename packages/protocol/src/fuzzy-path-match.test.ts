import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyPathMatch, fuzzyPathMatchIsClean, fuzzyPathNeedle, fuzzyPathPlacementScore, fuzzyPathScore } from "./index.js";

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

test("a shared alignment budget is spent per path and, once gone, still matches the same paths cheaply", () => {
  const needle = fuzzyPathNeedle("sdtsx");
  const path = "apps/web/src/components/SessionDetail.tsx";
  const budget = { cells: 1_000 };
  const full = fuzzyPathScore(path, needle, budget);
  assert.equal(full, fuzzyPathScore(path, needle), "within the budget the score is the full alignment's");
  assert.ok(budget.cells < 1_000, "the alignment's cells were charged");
  const spent = { cells: 0 };
  const cheap = fuzzyPathScore(path, needle, spent);
  assert.notEqual(cheap, null, "a spent budget still matches");
  assert.ok(cheap! <= full!, "the cheap placement never outscores the best one");
  assert.equal(spent.cells, 0);
  assert.equal(fuzzyPathScore("src/a.ts", needle, spent), null, "and still rejects a non-match");
});

test("a clean match starts each run at a word or types three letters of the name; a scatter is not clean", () => {
  const clean = (path: string, query: string) => fuzzyPathMatchIsClean(path, fuzzyPathMatch(path, fuzzyPathNeedle(query))!.positions);
  assert.equal(clean("apps/web/src/components/SessionDetail.tsx", "sdtsx"), true, "S, D and tsx each start a word");
  assert.equal(clean("docs/sidebar-details.tsx", "sdtsx"), true);
  assert.equal(clean("src/precheck.ts", "check"), true, "five letters of the name, mid-word");
  assert.equal(clean("apps/web/src/components/CheckBadge.tsx", "sdtsx"), false, "a lone mid-word d is a coincidence");
  assert.equal(clean("src/abcdefghijk.ts", "aek"), false);
  assert.equal(clean("src/xyabz.ts", "ab"), false, "two mid-word letters are too few");
  assert.equal(fuzzyPathMatchIsClean("src/a.ts", []), false);
});

test("the alignment keeps a lower-scoring run whose carried bonus wins later", () => {
  // At "b" both placements score the same, but only the one that jumped from the slash carries its
  // segment bonus into "c".
  const path = `a/${"x".repeat(21)}a/bc`;
  const found = fuzzyPathMatch(path, "a/bc");
  assert.deepEqual(found?.positions, [0, 1, 25, 26]);
  assert.equal(found?.score, fuzzyPathPlacementScore(path, [0, 1, 25, 26]));
  assert.equal(found?.score, 97);
});

test("the query and every path fold case the same way, whatever else the path holds", () => {
  // İ lower-cases to two units, and a whole-string fold turns a final Σ into ς.
  assert.deepEqual(fuzzyPathMatch("İ/ΟΣ.ts", fuzzyPathNeedle("ΟΣ"))?.positions, [2, 3]);
  assert.deepEqual(fuzzyPathMatch("src/ΟΣ.ts", fuzzyPathNeedle("ΟΣ"))?.positions, [4, 5]);
  assert.deepEqual(fuzzyPathMatch("src/οσ.ts", fuzzyPathNeedle("ΟΣ"))?.positions, [4, 5]);
});

test("the alignment finds the best placement: exhaustive check over short paths", () => {
  const NAME_ONLY = 40;
  const NAME_EXACT = 64;
  const NAME_PREFIX = 24;
  // A deterministic generator, so a failure names a reproducible case.
  let seed = 1263;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const alphabet = "aAbB/-._1";
  const placements = (path: string, needle: string): number[][] => {
    const found: number[][] = [];
    const walk = (i: number, from: number, taken: number[]) => {
      if (i === needle.length) return void found.push([...taken]);
      for (let j = from; j < path.length; j += 1) {
        if (path[j]!.toLowerCase() === needle[i]) walk(i + 1, j + 1, [...taken, j]);
      }
    };
    walk(0, 0, []);
    return found;
  };
  for (let trial = 0; trial < 3_000; trial += 1) {
    const path = Array.from({ length: 1 + Math.floor(next() * 12) }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
    const needle = fuzzyPathNeedle(Array.from({ length: 1 + Math.floor(next() * 4) }, () => "ab/.1"[Math.floor(next() * 5)]).join(""));
    const label = `${JSON.stringify(path)} / ${needle}`;
    const all = placements(path, needle);
    const found = fuzzyPathMatch(path, needle);
    if (all.length === 0) {
      assert.equal(found, null, label);
      continue;
    }
    const nameStart = path.lastIndexOf("/") + 1;
    const name = path.slice(nameStart).toLowerCase();
    const named = name === needle ? NAME_EXACT : name.startsWith(needle) ? NAME_PREFIX : 0;
    const total = (placement: readonly number[]) =>
      fuzzyPathPlacementScore(path, placement) + (placement[0]! >= nameStart ? NAME_ONLY : 0) + named;
    assert.equal(found?.score, Math.max(...all.map(total)), label);
    assert.equal(total(found!.positions), found!.score, `the positions earn the score: ${label}`);
  }
});
