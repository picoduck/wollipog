import assert from "node:assert/strict";
import { test } from "node:test";
import { diffFileIsPlain, diffLineCounts, hunkLabel, parseUnifiedDiff } from "./unified-diff.js";

const NEW_FILE = [
  "diff --git a/src/notes.ts b/src/notes.ts",
  "new file mode 100644",
  "index 0000000..3b18e51",
  "--- /dev/null",
  "+++ b/src/notes.ts",
  "@@ -0,0 +1,3 @@",
  "+export const a = 1;",
  "+",
  "+export const b = 2;",
  "",
].join("\n");

const EDIT = [
  "diff --git a/src/Header.tsx b/src/Header.tsx",
  "index 9f2c1aa..4e0b7d2 100644",
  "--- a/src/Header.tsx",
  "+++ b/src/Header.tsx",
  "@@ -12,3 +12,4 @@ export function Header({ title }: { title: string }) {",
  "   const version = useVersion();",
  "-  const label = title.toUpperCase();",
  "+  const label = title;",
  "+  const note = latest();",
  "   return (",
  "\\ No newline at end of file",
].join("\n");

test("a git diff drops its metadata lines and numbers each line on its own side", () => {
  const [file, ...rest] = parseUnifiedDiff(EDIT);
  assert.equal(rest.length, 0);
  assert.equal(file!.path, "src/Header.tsx");
  assert.equal(file!.isNew, false);
  const lines = file!.hunks[0]!.lines;
  assert.deepEqual(lines.map((line) => [line.kind, line.number, line.text]), [
    ["context", 12, "  const version = useVersion();"],
    ["removed", 13, "  const label = title.toUpperCase();"],
    ["added", 13, "  const label = title;"],
    ["added", 14, "  const note = latest();"],
    ["context", 15, "  return ("],
  ]);
  assert.ok(lines.every((line) => !/^(diff --git|index |---|\+\+\+|\\)/.test(line.text)));
});

test("a new file is recognised from its header and numbered from line 1", () => {
  const [file] = parseUnifiedDiff(NEW_FILE);
  assert.equal(file!.isNew, true);
  assert.equal(file!.path, "src/notes.ts");
  assert.deepEqual(file!.hunks[0]!.lines.map((line) => [line.kind, line.number, line.text]), [
    ["added", 1, "export const a = 1;"],
    ["added", 2, ""],
    ["added", 3, "export const b = 2;"],
  ]);
  assert.equal(diffFileIsPlain(parseUnifiedDiff(NEW_FILE)[0]!), true);
  assert.equal(diffFileIsPlain(parseUnifiedDiff(EDIT)[0]!), false);
});

test("inside a hunk a +++ or --- line is a change, not a header", () => {
  const [file] = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n---counter;\n+++counter;");
  assert.deepEqual(file!.hunks[0]!.lines.map((line) => [line.kind, line.text]), [
    ["removed", "--counter;"],
    ["added", "++counter;"],
  ]);
});

test("a body with no hunk header is one hunk numbered from line 1, and a pure addition is a new file", () => {
  const [edit] = parseUnifiedDiff("--- a/x\n+++ b/x\n-old\n+new");
  assert.equal(edit!.isNew, false);
  assert.equal(edit!.hunks[0]!.header, false);
  assert.deepEqual(edit!.hunks[0]!.lines.map((line) => [line.kind, line.number]), [["removed", 1], ["added", 1]]);
  const [created] = parseUnifiedDiff("--- a/x\n+++ b/x\n+one\n+two");
  assert.equal(created!.isNew, true);
});

test("a diff of several files keeps each file's path and hunks apart", () => {
  const files = parseUnifiedDiff(`${EDIT}\n${NEW_FILE}`);
  assert.deepEqual(files.map((file) => [file.path, file.isNew, file.hunks.length]), [
    ["src/Header.tsx", false, 1],
    ["src/notes.ts", true, 1],
  ]);
});

test("a hunk names its new-side lines and the function its header carries", () => {
  const [edit] = parseUnifiedDiff(EDIT);
  assert.equal(hunkLabel(edit!.hunks[0]!), "Lines 12–15 in Header()");
  const [created] = parseUnifiedDiff(NEW_FILE);
  assert.equal(hunkLabel(created!.hunks[0]!), "Lines 1–3");
  const [one] = parseUnifiedDiff("@@ -4 +4 @@ class Store:\n-a\n+b");
  assert.equal(hunkLabel(one!.hunks[0]!), "Line 4 in Store");
  const [removal] = parseUnifiedDiff("@@ -7,2 +6,0 @@\n-a\n-b");
  assert.equal(hunkLabel(removal!.hunks[0]!), "Lines 7–8");
  const [bare] = parseUnifiedDiff("-old\n+new");
  assert.equal(hunkLabel(bare!.hunks[0]!), null);
});

test("counts are the change lines of every file, never their headers", () => {
  assert.deepEqual(diffLineCounts(EDIT), { added: 2, removed: 1 });
  assert.deepEqual(diffLineCounts(`${EDIT}\n${NEW_FILE}`), { added: 5, removed: 1 });
  assert.equal(diffLineCounts(undefined), null);
});

test("an empty or headers-only diff has no lines", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
  assert.deepEqual(parseUnifiedDiff("diff --git a/x b/x\nindex 1..2 100644").flatMap((file) => file.hunks), []);
});
