import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitDiffFile, GitDiffInfo, GitHunk } from "@wollipog/protocol";
import {
  diffLineAttachRange,
  diffLineCopyText,
  diffLineLabel,
  diffLineStageTarget,
  EMPTY_LINE_SELECTION,
  extendDiffLineSelection,
  fileLineRefs,
  liveDiffLineSelection,
  placeDiffLineSelection,
  toggleDiffLine,
  type DiffLineRef,
  type DiffLineSelection,
} from "./diff-line-selection.js";

/** Review's Select Lines rules (#2849), apart from the DOM. */

const first: GitHunk = {
  header: "@@ -1,3 +1,5 @@",
  oldStart: 1, oldCount: 3, newStart: 1, newCount: 5,
  lines: [
    { status: " ", text: "one" },
    { status: "-", text: "two" },
    { status: "+", text: "TWO" },
    { status: "+", text: "TWO and a half" },
    { status: "+", text: "TWO and three quarters" },
    { status: " ", text: "three" },
  ],
};
const second: GitHunk = {
  header: "@@ -20,2 +22,2 @@",
  oldStart: 20, oldCount: 2, newStart: 22, newCount: 2,
  lines: [{ status: " ", text: "twenty" }, { status: "-", text: "old" }, { status: "+", text: "new" }],
};
const fileA: GitDiffFile = { path: "src/a.ts", status: "modified", binary: false, hunks: [first, second] };
const fileB: GitDiffFile = { path: "src/b.ts", status: "added", binary: false, hunks: [{
  header: "@@ -0,0 +1,1 @@", oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, lines: [{ status: "+", text: "b" }],
}] };
const diffOf = (...files: GitDiffFile[]): GitDiffInfo => ({
  scope: "uncommitted",
  diffHash: "a".repeat(64),
  stats: { filesChanged: files.length, insertions: 0, deletions: 0 },
  files,
});
const diff = diffOf(fileA, fileB);

const unified = fileLineRefs(fileA, "unified");
/** The unified line of src/a.ts with this label, as its number button names it. */
const line = (label: string, refs: DiffLineRef[] = unified): DiffLineRef => {
  const found = refs.find((ref) => diffLineLabel(ref) === label);
  assert.ok(found, `src/a.ts has ${label}`);
  return found;
};
const pick = (...refs: DiffLineRef[]) => refs.reduce<DiffLineSelection>(toggleDiffLine, EMPTY_LINE_SELECTION);
const placedOf = (selection: DiffLineSelection, on: GitDiffInfo = diff) => placeDiffLineSelection(selection, on);

test("lines are named as their number buttons are: the new side by number, the old side as removed or base", () => {
  assert.deepEqual(unified.map(diffLineLabel), [
    "Line 1", "Removed Line 2", "Line 2", "Line 3", "Line 4", "Line 5",
    "Line 22", "Removed Line 21", "Line 23",
  ]);
  assert.deepEqual(fileLineRefs(fileA, "left").slice(0, 3).map(diffLineLabel), ["Base Line 1", "Removed Line 2", "Base Line 3"]);
});

test("a click toggles one line and makes it the range anchor; a second click lets it go", () => {
  const two = line("Line 2");
  const once = toggleDiffLine(EMPTY_LINE_SELECTION, two);
  assert.deepEqual([...once.lines.keys()], [two.key]);
  assert.equal(once.anchor, two.key);
  const twice = toggleDiffLine(once, two);
  assert.equal(twice.lines.size, 0);
  assert.equal(twice.anchor, null);
});

test("Shift-click selects from the anchor to the line, in either direction and across hunks of one file", () => {
  const down = extendDiffLineSelection(pick(line("Line 2")), line("Line 4"), fileA);
  assert.deepEqual(placedOf(down).map(({ ref }) => diffLineLabel(ref)), ["Line 2", "Line 3", "Line 4"]);
  assert.equal(down.anchor, line("Line 2").key, "the anchor stays for the next Shift-click");

  const up = extendDiffLineSelection(pick(line("Line 23")), line("Line 5"), fileA);
  assert.deepEqual(placedOf(up).map(({ ref }) => diffLineLabel(ref)), ["Line 5", "Line 22", "Removed Line 21", "Line 23"]);
});

test("Shift-click with no anchor in its file or column picks the line on its own", () => {
  const otherFile = extendDiffLineSelection(pick(line("Line 2")), fileLineRefs(fileB, "unified")[0]!, fileB);
  assert.equal(otherFile.lines.size, 2);
  const left = fileLineRefs(fileA, "left");
  const otherColumn = extendDiffLineSelection(pick(line("Line 2")), line("Removed Line 2", left), fileA);
  assert.equal(otherColumn.lines.size, 2, "a Side by Side column never ranges into the unified list");
});

test("a refresh drops lines whose hunk it rewrote, keeps the rest, and re-reads their hunk's index", () => {
  const selection = pick(line("Line 2"), line("Line 23"));
  // The first hunk was staged away: the second is now hunk 0, and its line keeps its place.
  const refreshed = diffOf({ ...fileA, hunks: [second] });
  const placed = placedOf(selection, refreshed);
  assert.deepEqual(placed.map(({ ref, hunkIndex }) => [diffLineLabel(ref), hunkIndex]), [["Line 23", 0]]);
  const live = liveDiffLineSelection(selection, placed);
  assert.deepEqual([...live.lines.keys()], [line("Line 23").key]);
  assert.equal(live.anchor, line("Line 23").key);
  assert.equal(liveDiffLineSelection(selection, placedOf(selection)), selection, "nothing went, so nothing changes");
  assert.deepEqual(placedOf(selection, null as unknown as GitDiffInfo), []);
});

test("Attach to Prompt takes one continuous range on one side of one file", () => {
  assert.deepEqual(diffLineAttachRange(placedOf(pick(line("Line 2"), line("Line 3"), line("Line 4")))),
    { path: "src/a.ts", side: "right", startLine: 2, endLine: 4 });
  // Unchanged lines count toward the range: they are on the new side too.
  assert.deepEqual(diffLineAttachRange(placedOf(pick(line("Line 1"), line("Line 2")))),
    { path: "src/a.ts", side: "right", startLine: 1, endLine: 2 });
  assert.deepEqual(diffLineAttachRange(placedOf(pick(line("Removed Line 2")))),
    { path: "src/a.ts", side: "left", startLine: 2, endLine: 2 });
  assert.equal(diffLineAttachRange(placedOf(pick(line("Line 2"), line("Line 4")))), null, "a gap");
  assert.equal(diffLineAttachRange(placedOf(pick(line("Line 2"), line("Removed Line 2")))), null, "two sides");
  assert.equal(diffLineAttachRange(placedOf(pick(line("Line 2"), fileLineRefs(fileB, "unified")[0]!))), null, "two files");
  assert.equal(diffLineAttachRange([]), null);
});

test("Stage Lines ignores unchanged lines and needs the changed ones in one hunk", () => {
  assert.deepEqual(diffLineStageTarget(placedOf(pick(line("Line 1"), line("Removed Line 2"), line("Line 2")))),
    { kind: "lines", filePath: "src/a.ts", hunkIndex: 0, lineIndices: [1, 2] });
  assert.deepEqual(diffLineStageTarget(placedOf(pick(line("Line 23")))),
    { kind: "lines", filePath: "src/a.ts", hunkIndex: 1, lineIndices: [2] });
  assert.deepEqual(diffLineStageTarget(placedOf(pick(line("Line 1"), line("Line 5")))), { kind: "unchanged" });
  assert.deepEqual(diffLineStageTarget(placedOf(pick(line("Line 2"), line("Line 23")))), { kind: "spread" });
  // Side by Side's two copies of one changed line stage it once.
  const right = fileLineRefs(fileA, "right");
  const left = fileLineRefs(fileA, "left");
  assert.deepEqual(diffLineStageTarget(placedOf(pick(line("Removed Line 2", left), line("Line 2", right)))),
    { kind: "lines", filePath: "src/a.ts", hunkIndex: 0, lineIndices: [1, 2] });
});

test("Copy Lines copies the selection's text in reading order, unchanged lines included", () => {
  assert.equal(diffLineCopyText(placedOf(pick(line("Line 3"), line("Line 1"), line("Line 2")))), "one\nTWO\nTWO and a half");
});
