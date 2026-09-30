import assert from "node:assert/strict";
import { test } from "node:test";
import type { SkillFile } from "@wollipog/protocol";
import { buildDiffHunkRows, buildSplitDiffRows } from "./diff-view.js";
import { diffSkillFiles, diffTextLines, formatBytes, lineEditScript } from "./skill-file-diff.js";

const text = (path: string, content: string): SkillFile => ({ path, content, encoding: "utf8" });
const binary = (path: string, bytes: number[]): SkillFile =>
  ({ path, content: Buffer.from(bytes).toString("base64"), encoding: "base64" });
const numbered = (count: number, change?: { at: number; text: string }) =>
  Array.from({ length: count }, (_, index) => change && index + 1 === change.at ? change.text : `line ${index + 1}`).join("\n") + "\n";

/** Apply an edit script to `a` and check it produces `b`: every script must be a valid transcript. */
function replay(a: string[], b: string[]) {
  const script = lineEditScript(a, b);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  for (const op of script) {
    if (op === " ") { assert.equal(a[i], b[j]); out.push(a[i]!); i += 1; j += 1; }
    else if (op === "-") i += 1;
    else { out.push(b[j]!); j += 1; }
  }
  assert.equal(i, a.length);
  assert.deepEqual(out, b);
  return script;
}

test("an unchanged file is Unchanged with no hunks", () => {
  const [entry] = diffSkillFiles([text("SKILL.md", "# Review\nSame\n")], [text("SKILL.md", "# Review\nSame\n")]);
  assert.equal(entry!.change, "unchanged");
  assert.deepEqual(entry!.hunks, []);
  assert.equal(entry!.added, 0);
  assert.equal(entry!.removed, 0);
});

test("one changed line in a 200-line SKILL.md is one hunk with three context lines on each side", () => {
  const before = numbered(200);
  const after = numbered(200, { at: 100, text: "line 100, reworded" });
  const [entry] = diffSkillFiles([text("SKILL.md", before)], [text("SKILL.md", after)]);
  assert.equal(entry!.change, "changed");
  assert.equal(entry!.hunks.length, 1);
  const hunk = entry!.hunks[0]!;
  assert.equal(hunk.header, "@@ -97,7 +97,7 @@");
  assert.deepEqual(hunk.lines.map((line) => line.status).join(""), "   -+   ");
  assert.deepEqual(hunk.lines.map((line) => line.text), [
    "line 97", "line 98", "line 99", "line 100", "line 100, reworded", "line 101", "line 102", "line 103",
  ]);
  assert.equal(entry!.added, 1);
  assert.equal(entry!.removed, 1);
  // The existing row builder numbers it: the − line keeps its old number, the + line gets its new one.
  const rows = buildDiffHunkRows(hunk);
  assert.deepEqual(rows.map((row) => [row.status, row.oldNo, row.newNo]), [
    [" ", "97", "97"], [" ", "98", "98"], [" ", "99", "99"],
    ["-", "100", ""], ["+", "", "100"],
    [" ", "101", "101"], [" ", "102", "102"], [" ", "103", "103"],
  ]);
  const split = buildSplitDiffRows(hunk);
  assert.equal(split.length, 7);
  assert.equal(split[3]!.left?.text, "line 100");
  assert.equal(split[3]!.right?.text, "line 100, reworded");
});

test("a change at the first line has no leading context and starts at line 1", () => {
  const { hunks } = diffTextLines("a\nb\nc\nd\ne\n", "A\nb\nc\nd\ne\n");
  assert.equal(hunks[0]!.header, "@@ -1,4 +1,4 @@");
  assert.equal(hunks[0]!.lines[0]!.status, "-");
});

test("changes further apart than twice the context are separate hunks; closer ones merge", () => {
  const far = diffTextLines(numbered(40), numbered(40, { at: 30, text: "x" }).replace("line 5\n", "five\n"));
  assert.deepEqual(far.hunks.map((hunk) => hunk.header), ["@@ -2,7 +2,7 @@", "@@ -27,7 +27,7 @@"]);
  const near = diffTextLines(numbered(40), numbered(40, { at: 11, text: "x" }).replace("line 5\n", "five\n"));
  assert.equal(near.hunks.length, 1);
  assert.equal(near.hunks[0]!.header, "@@ -2,13 +2,13 @@");
});

test("an added file is all + lines and a removed file all − lines", () => {
  const entries = diffSkillFiles(
    [text("old.md", "one\ntwo\n")],
    [text("new.md", "alpha\nbeta\ngamma\n")],
  );
  const added = entries.find((entry) => entry.path === "new.md")!;
  const removed = entries.find((entry) => entry.path === "old.md")!;
  assert.equal(added.change, "added");
  assert.equal(added.hunks.length, 1);
  assert.equal(added.hunks[0]!.header, "@@ -0,0 +1,3 @@");
  assert.ok(added.hunks[0]!.lines.every((line) => line.status === "+"));
  assert.deepEqual(buildDiffHunkRows(added.hunks[0]!).map((row) => row.newNo), ["1", "2", "3"]);
  assert.equal(added.added, 3);
  assert.equal(removed.change, "removed");
  assert.equal(removed.hunks[0]!.header, "@@ -1,2 +0,0 @@");
  assert.ok(removed.hunks[0]!.lines.every((line) => line.status === "-"));
  assert.equal(removed.removed, 2);
});

test("a new skill with no previous files lists every file as Added, sorted by path", () => {
  const entries = diffSkillFiles([], [text("scripts/run.sh", "echo hi\n"), text("SKILL.md", "# A\n")]);
  assert.deepEqual(entries.map((entry) => [entry.path, entry.change]), [["SKILL.md", "added"], ["scripts/run.sh", "added"]]);
});

test("a changed script carries the Script flag and its +N −M counts", () => {
  const [entry] = diffSkillFiles(
    [text("scripts/check.sh", "#!/bin/sh\necho one\necho two\n")],
    [text("scripts/check.sh", "#!/bin/sh\necho uno\necho two\necho three\n")],
  );
  assert.equal(entry!.script, true);
  assert.equal(entry!.added, 2);
  assert.equal(entry!.removed, 1);
  // Executable mode alone makes a plainly named file a script, as does a shebang.
  assert.equal(diffSkillFiles([], [text("helper", "plain\n")], ["helper"])[0]!.script, true);
  assert.equal(diffSkillFiles([], [text("notes", "#!/usr/bin/env python3\n")])[0]!.script, true);
  assert.equal(diffSkillFiles([], [text("notes.md", "plain\n")])[0]!.script, false);
});

test("CRLF lines diff by content and show without the carriage return", () => {
  const { hunks, added, removed, endings } = diffTextLines("a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n");
  assert.equal(added, 1);
  assert.equal(removed, 1);
  assert.deepEqual(hunks[0]!.lines, [
    { status: " ", text: "a" }, { status: "-", text: "b" }, { status: "+", text: "B" }, { status: " ", text: "c" },
  ]);
  assert.deepEqual(endings, { before: "crlf", after: "crlf" });
});

test("a CRLF to LF conversion is a change on every line and is named as a line-ending change", () => {
  const [entry] = diffSkillFiles([text("SKILL.md", "a\r\nb\r\n")], [text("SKILL.md", "a\nb\n")]);
  assert.equal(entry!.change, "changed");
  assert.equal(entry!.added, 2);
  assert.equal(entry!.removed, 2);
  assert.deepEqual(entry!.lineEndings, { before: "crlf", after: "lf" });
  // Same visible text on both sides, which is why the note is needed.
  assert.deepEqual(entry!.hunks[0]!.lines.map((line) => line.text), ["a", "b", "a", "b"]);
  // No note when the ending style is unchanged.
  assert.equal(diffSkillFiles([text("a", "x\n")], [text("a", "y\n")])[0]!.lineEndings, undefined);
});

test("a missing trailing newline changes the last line and is reported per side", () => {
  const added = diffTextLines("a\nb", "a\nb\n");
  assert.equal(added.oldNoEol, true);
  assert.equal(added.newNoEol, false);
  assert.deepEqual(added.hunks[0]!.lines, [
    { status: " ", text: "a" }, { status: "-", text: "b" }, { status: "+", text: "b" },
  ]);
  const removed = diffTextLines("a\nb\n", "a\nb");
  assert.equal(removed.oldNoEol, false);
  assert.equal(removed.newNoEol, true);
  assert.equal(removed.added, 1);
  assert.equal(removed.removed, 1);
  // Both sides without a final newline, and only an earlier line changed: the last line is context.
  const both = diffTextLines("a\nb", "A\nb");
  assert.deepEqual(both.hunks[0]!.lines.map((line) => line.status).join(""), "-+ ");
  assert.equal(both.oldLineCount, 2);
  assert.equal(both.newLineCount, 2);
});

test("an empty file and a file of one empty line are different", () => {
  const { hunks, added } = diffTextLines("", "\n");
  assert.equal(added, 1);
  assert.equal(hunks[0]!.lines[0]!.text, "");
  assert.deepEqual(diffTextLines("", "").hunks, []);
});

test("binary files have no hunks and report both sizes", () => {
  const [changed] = diffSkillFiles([binary("logo.png", [0x89, 0x50, 0x4e, 0x47])], [binary("logo.png", [0x89, 0x50, 0x4e, 0x47, 1, 2])]);
  assert.equal(changed!.change, "changed");
  assert.deepEqual(changed!.binary, { beforeBytes: 4, afterBytes: 6 });
  assert.deepEqual(changed!.hunks, []);
  const [added] = diffSkillFiles([], [binary("tool", [0x7f, 0x45, 0x4c, 0x46, 2])]);
  assert.deepEqual(added!.binary, { beforeBytes: null, afterBytes: 5 });
  assert.equal(added!.script, true, "an ELF executable is a script whatever it is named");
  // Text replaced by binary content is binary, with the text side measured in UTF-8 bytes.
  const [mixed] = diffSkillFiles([text("data", "héllo")], [binary("data", [1, 2])]);
  assert.deepEqual(mixed!.binary, { beforeBytes: 6, afterBytes: 2 });
  assert.equal(formatBytes(1), "1 byte");
  assert.equal(formatBytes(2048), "2.0 KB");
});

test("every edit script replays exactly, including repeated and reordered lines", () => {
  replay([], []);
  replay(["a"], []);
  replay([], ["a"]);
  replay(["a", "b", "c", "a", "b", "b", "a"], ["c", "b", "a", "b", "a", "c"]);
  replay(["x", "x", "x"], ["x", "y", "x"]);
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 200; round++) {
    const pick = () => Array.from({ length: Math.floor(random() * 12) }, () => "abcd"[Math.floor(random() * 4)]!);
    const a = pick();
    const b = pick();
    const script = replay(a, b);
    // Shortest: exactly the edits a longest common subsequence leaves.
    const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    assert.equal(script.filter((op) => op !== " ").length, a.length + b.length - 2 * lcs[0]![0]!);
  }
});

test("a one-line change in a long file is minimal", () => {
  const a = Array.from({ length: 5000 }, (_, index) => `row ${index}`);
  const b = [...a];
  b[2500] = "changed";
  const script = replay(a, b);
  assert.equal(script.filter((op) => op !== " ").length, 2);
});

test("files too different to align are shown as fully replaced", () => {
  const a = Array.from({ length: 3000 }, (_, index) => `old ${index}`);
  const b = Array.from({ length: 3000 }, (_, index) => `new ${index}`);
  const script = replay(a, b);
  assert.equal(script.filter((op) => op === "-").length, 3000);
  assert.equal(script.filter((op) => op === "+").length, 3000);
});
