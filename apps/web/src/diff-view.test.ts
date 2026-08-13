import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitDiffFile, GitHunk } from "@wollipog/protocol";
import {
  buildDiffHunkRows,
  buildSplitDiffRows,
  groupHunksForDisplay,
  highlightDiffLine,
  wordDiff,
} from "./diff-view.js";

function hunk(newStart: number): GitHunk {
  return {
    header: `@@ -${newStart},1 +${newStart},1 @@`,
    oldStart: newStart,
    oldCount: 1,
    newStart,
    newCount: 1,
    lines: [{ status: "+", text: `line ${newStart}` }],
  };
}

function file(overrides: Partial<GitDiffFile> & { path: string }): GitDiffFile {
  return {
    status: "modified",
    binary: false,
    hunks: [],
    ...overrides,
  };
}

test("groupHunksForDisplay: empty input ⇒ empty output", () => {
  assert.deepEqual(groupHunksForDisplay([], 3), []);
});

test("groupHunksForDisplay: fewer hunks than threshold are all expanded", () => {
  const f = file({ path: "a.ts", hunks: [hunk(1), hunk(2)] });
  const [df] = groupHunksForDisplay([f], 3);
  assert.equal(df.hunks.length, 2);
  assert.equal(df.hiddenCount, 0);
  assert.deepEqual(
    df.hunks.map((h) => h.isCollapsed),
    [false, false],
  );
});

test("groupHunksForDisplay: exactly threshold hunks stay expanded, hiddenCount 0", () => {
  const f = file({ path: "a.ts", hunks: [hunk(1), hunk(2), hunk(3)] });
  const [df] = groupHunksForDisplay([f], 3);
  assert.equal(df.hiddenCount, 0);
  assert.deepEqual(
    df.hunks.map((h) => h.isCollapsed),
    [false, false, false],
  );
});

test("groupHunksForDisplay: hunks past the threshold collapse; hiddenCount is the tail length", () => {
  const f = file({ path: "a.ts", hunks: [hunk(1), hunk(2), hunk(3), hunk(4), hunk(5)] });
  const [df] = groupHunksForDisplay([f], 3);
  assert.equal(df.hunks.length, 5);
  assert.equal(df.hiddenCount, 2);
  assert.deepEqual(
    df.hunks.map((h) => h.isCollapsed),
    [false, false, false, true, true],
  );
});

test("groupHunksForDisplay: original index is preserved through collapse", () => {
  const f = file({ path: "a.ts", hunks: [hunk(1), hunk(2), hunk(3), hunk(4)] });
  const [df] = groupHunksForDisplay([f], 2);
  // Index tracks the source position, not the display position, so a later collapsed hunk
  // still reports its true index into file.hunks.
  assert.deepEqual(
    df.hunks.map((h) => h.index),
    [0, 1, 2, 3],
  );
  const collapsed = df.hunks.filter((h) => h.isCollapsed);
  assert.deepEqual(
    collapsed.map((h) => h.index),
    [2, 3],
  );
  // The collapsed hunks are the actual source hunks at those indices.
  assert.equal(collapsed[0].hunk, f.hunks[2]);
  assert.equal(collapsed[1].hunk, f.hunks[3]);
});

test("groupHunksForDisplay: binary file has no hunks and no hidden count", () => {
  const f = file({ path: "logo.png", binary: true, hunks: [] });
  const [df] = groupHunksForDisplay([f], 3);
  assert.deepEqual(df.hunks, []);
  assert.equal(df.hiddenCount, 0);
});

test("groupHunksForDisplay: untracked file has no hunks and no hidden count", () => {
  const f = file({ path: "new.txt", status: "untracked", hunks: [] });
  const [df] = groupHunksForDisplay([f], 3);
  assert.deepEqual(df.hunks, []);
  assert.equal(df.hiddenCount, 0);
});

test("groupHunksForDisplay: threshold of 0 collapses everything", () => {
  const f = file({ path: "a.ts", hunks: [hunk(1), hunk(2)] });
  const [df] = groupHunksForDisplay([f], 0);
  assert.equal(df.hiddenCount, 2);
  assert.deepEqual(
    df.hunks.map((h) => h.isCollapsed),
    [true, true],
  );
});

test("groupHunksForDisplay: maps every file, preserving order", () => {
  const files = [
    file({ path: "a.ts", hunks: [hunk(1)] }),
    file({ path: "b.ts", hunks: [hunk(1), hunk(2), hunk(3), hunk(4)] }),
  ];
  const result = groupHunksForDisplay(files, 3);
  assert.equal(result.length, 2);
  assert.equal(result[0].file.path, "a.ts");
  assert.equal(result[0].hiddenCount, 0);
  assert.equal(result[1].file.path, "b.ts");
  assert.equal(result[1].hiddenCount, 1);
});

test("buildDiffHunkRows anchors deletions left and additions/context right", () => {
  const rows = buildDiffHunkRows({
    header: "@@ -10,3 +20,3 @@",
    oldStart: 10,
    oldCount: 3,
    newStart: 20,
    newCount: 3,
    lines: [
      { status: " ", text: "context" },
      { status: "-", text: "old" },
      { status: "+", text: "new" },
      { status: " ", text: "tail" },
    ],
  });
  assert.deepEqual(rows.map((row) => ({ oldNo: row.oldNo, newNo: row.newNo, anchor: row.anchor })), [
    { oldNo: "10", newNo: "20", anchor: { side: "right", line: 20 } },
    { oldNo: "11", newNo: "", anchor: { side: "left", line: 11 } },
    { oldNo: "", newNo: "21", anchor: { side: "right", line: 21 } },
    { oldNo: "12", newNo: "22", anchor: { side: "right", line: 22 } },
  ]);
  assert.deepEqual(rows.map((row) => row.sourceIndex), [0, 1, 2, 3]);
  assert.ok(rows[1]?.wordSegments?.some((part) => part.changed));
  assert.ok(rows[2]?.wordSegments?.some((part) => part.changed));
});

test("wordDiff preserves shared tokens and emphasizes only replacements", () => {
  const result = wordDiff("const retryCount = 2;", "const retryLimit = 3;");
  assert.equal(result.old.map((part) => part.text).join(""), "const retryCount = 2;");
  assert.equal(result.new.map((part) => part.text).join(""), "const retryLimit = 3;");
  assert.deepEqual(result.old.filter((part) => part.changed).map((part) => part.text), ["retryCount", "2"]);
  assert.deepEqual(result.new.filter((part) => part.changed).map((part) => part.text), ["retryLimit", "3"]);
});

test("buildSplitDiffRows aligns replacement blocks and keeps one-sided insertions", () => {
  const split = buildSplitDiffRows({
    header: "@@ -1,3 +1,4 @@",
    oldStart: 1,
    oldCount: 3,
    newStart: 1,
    newCount: 4,
    lines: [
      { status: " ", text: "same" },
      { status: "-", text: "before" },
      { status: "+", text: "after" },
      { status: "+", text: "extra" },
      { status: " ", text: "tail" },
    ],
  });
  assert.equal(split.length, 4);
  assert.equal(split[0]?.left?.text, "same");
  assert.equal(split[0]?.right?.text, "same");
  assert.equal(split[1]?.left?.text, "before");
  assert.equal(split[1]?.right?.text, "after");
  assert.equal(split[2]?.left, null);
  assert.equal(split[2]?.right?.text, "extra");
});

test("highlightDiffLine returns safe syntax segments without generating HTML", () => {
  const segments = highlightDiffLine("src/example.ts", "const answer = 42; // <script>");
  assert.equal(segments.map((segment) => segment.text).join(""), "const answer = 42; // <script>");
  assert.equal(segments.find((segment) => segment.text === "const")?.kind, "keyword");
  assert.equal(segments.find((segment) => segment.text === "42")?.kind, "number");
  assert.equal(segments.at(-1)?.kind, "comment");
  assert.deepEqual(highlightDiffLine("notes.txt", "const x = 1"), [{ text: "const x = 1", kind: "plain" }]);
});
