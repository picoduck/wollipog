import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { binaryMarkerSides, diffFileIsPlain, diffLineCounts, diffMaxLineNumber, hunkLabel, parseUnifiedDiff } from "./unified-diff.js";

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

test("a binary change or a pure rename keeps what Git says about it, and a binary patch is not lines", () => {
  const [image] = parseUnifiedDiff("diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ");
  assert.deepEqual([image!.path, image!.binary, image!.hunks.length], ["logo.png", true, 0]);
  const [patch, next] = parseUnifiedDiff([
    "diff --git a/icon.png b/icon.png",
    "GIT binary patch",
    "literal 12",
    "zcmZQzU|?ur",
    "",
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
  ].join("\n"));
  assert.deepEqual([patch!.binary, patch!.hunks.length], [true, 0]);
  assert.deepEqual(next!.hunks[0]!.lines.map((line) => line.kind), ["removed", "added"]);
  const [moved] = parseUnifiedDiff("diff --git a/src/old.ts b/src/new.ts\nsimilarity index 100%\nrename from src/old.ts\nrename to src/new.ts");
  assert.deepEqual([moved!.path, moved!.oldPath, moved!.hunks.length], ["src/new.ts", "src/old.ts", 0]);
  const [gone] = parseUnifiedDiff("diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-x");
  assert.equal(gone!.isDeleted, true);
});

test("binary metadata with no diff --git header still makes a binary file record", () => {
  const [marker, ...none] = parseUnifiedDiff("Binary files a/logo.png and b/logo.png differ");
  assert.equal(none.length, 0);
  assert.deepEqual([marker!.binary, marker!.path, marker!.hunks.length], [true, "logo.png", 0]);
  const [text, image] = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\nBinary files a/y.png and b/y.png differ");
  assert.deepEqual([text!.hunks[0]!.lines.length, image!.path, image!.binary], [2, "y.png", true],
    "after a finished hunk, a binary marker opens the next file");
  const [patch] = parseUnifiedDiff("GIT binary patch\nliteral 12\nzcmZQzU|?ur\n\nliteral 0\nHcmV?d00001");
  assert.deepEqual([patch!.binary, patch!.hunks.length], [true, 0], "the base85 data is not context lines");
});

test("each headerless binary marker is its own file, whatever follows it", () => {
  const two = parseUnifiedDiff("Binary files a/a.png and b/a.png differ\nBinary files a/b.png and b/b.png differ");
  assert.deepEqual(two.map((file) => [file.path, file.binary]), [["a.png", true], ["b.png", true]]);
  const mixed = parseUnifiedDiff("Binary files a/a.png and b/a.png differ\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b");
  assert.deepEqual(mixed.map((file) => [file.path, file.binary ?? false, file.hunks.length]), [["a.png", true, 0], ["x.ts", false, 1]]);
});

test("a binary marker's sides are read whole, and a null side names the operation", () => {
  assert.deepEqual(binaryMarkerSides("Binary files a/rock and roll.png and b/rock and roll.png differ"),
    { oldPath: "rock and roll.png", newPath: "rock and roll.png" });
  const [added] = parseUnifiedDiff("Binary files /dev/null and b/logo.png differ");
  assert.deepEqual([added!.path, added!.isNew, added!.isDeleted ?? false], ["logo.png", true, false]);
  const [deleted] = parseUnifiedDiff("Binary files a/logo.png and /dev/null differ");
  assert.deepEqual([deleted!.path, deleted!.isNew, deleted!.isDeleted], ["logo.png", false, true]);
  const [named] = parseUnifiedDiff("Binary files a/rock and roll.png and b/rock and roll.png differ");
  assert.equal(named!.path, "rock and roll.png");
  const [gitDeleted] = parseUnifiedDiff("diff --git a/x b/x\ndeleted file mode 100644\nBinary files a/x and /dev/null differ");
  assert.deepEqual([gitDeleted!.path, gitDeleted!.isDeleted], ["x", true]);
});

test("a diff --git header whose path contains \" b/\" keeps the whole path", () => {
  const [file] = parseUnifiedDiff("diff --git a/docs/a b/c.md b/docs/a b/c.md\nindex 1..2 100644\nBinary files a/docs/a b/c.md and b/docs/a b/c.md differ");
  assert.equal(file!.path, "docs/a b/c.md");
  const [moved] = parseUnifiedDiff("diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts");
  assert.equal(moved!.path, "new.ts");
});

test("a bare body that opens with ---/+++ lines keeps them as changes, not a second header", () => {
  // ACP's renderDiff for old text "-- counter;" and new text "++ counter;".
  const [file, ...rest] = parseUnifiedDiff("--- a/src/counter.cpp\n+++ b/src/counter.cpp\n--- counter;\n+++ counter;");
  assert.equal(rest.length, 0);
  assert.equal(file!.path, "src/counter.cpp");
  assert.deepEqual(file!.hunks[0]!.lines.map((line) => [line.kind, line.text]), [
    ["removed", "-- counter;"],
    ["added", "++ counter;"],
  ]);
});

test("every ACP diff parses back to exactly its old and new lines (property)", () => {
  // apps/runner/src/acp.ts renderDiff, verbatim in behaviour.
  const renderDiff = (path: string, oldText: string, newText: string) => {
    const minus = oldText ? oldText.split("\n").map((line) => `-${line}`).join("\n") + "\n" : "";
    const plus = newText.split("\n").map((line) => `+${line}`).join("\n");
    return `--- a/${path}\n+++ b/${path}\n${minus}${plus}`;
  };
  // Lines that look like diff syntax are the interesting ones.
  const line = fc.oneof(
    fc.constantFrom("", "-- x", "++ x", "--- a/y", "+++ b/y", "@@ -1 +1 @@", "diff --git a/y b/y", "index 1..2",
      "new file mode 100644", "Binary files a/y and b/y differ", "GIT binary patch", "\\ No newline at end of file", " ctx"),
    fc.string({ maxLength: 12 }).filter((text) => !/[\r\n]/.test(text)),
  );
  fc.assert(fc.property(fc.array(line, { maxLength: 6 }), fc.array(line, { minLength: 1, maxLength: 6 }), (oldLines, newLines) => {
    const oldText = oldLines.join("\n");
    const newText = newLines.join("\n");
    const files = parseUnifiedDiff(renderDiff("src/x.ts", oldText, newText));
    assert.equal(files.length, 1);
    assert.equal(files[0]!.path, "src/x.ts");
    const parsed = files[0]!.hunks.flatMap((hunk) => hunk.lines);
    const expected = [
      ...(oldText ? oldText.split("\n").map((text) => ["removed", text]) : []),
      ...newText.split("\n").map((text) => ["added", text]),
    ];
    assert.deepEqual(parsed.map((entry) => [entry.kind, entry.text]), expected);
  }), { numRuns: 500 });
});

test("every counted git hunk, in a diff of several files, parses back to its own lines (property)", () => {
  const content = fc.oneof(
    fc.constantFrom("", "-- x", "++ x", "-- a/y", "++ b/y", "@@ -1 +1 @@", "diff --git a/y b/y", "Binary files a/y and b/y differ"),
    fc.string({ maxLength: 10 }).filter((text) => !/[\r\n]/.test(text) && !text.startsWith("\\")),
  );
  const entry = fc.tuple(fc.constantFrom("added", "removed", "context") as fc.Arbitrary<"added" | "removed" | "context">, content);
  const file = fc.array(entry, { minLength: 1, maxLength: 6 });
  fc.assert(fc.property(fc.array(file, { minLength: 1, maxLength: 3 }), (bodies) => {
    const text = bodies.map((body, index) => {
      const oldCount = body.filter(([kind]) => kind !== "added").length;
      const newCount = body.filter(([kind]) => kind !== "removed").length;
      const sign = { added: "+", removed: "-", context: " " } as const;
      return [
        `diff --git a/f${index} b/f${index}`,
        `--- a/f${index}`,
        `+++ b/f${index}`,
        `@@ -1,${oldCount} +1,${newCount} @@`,
        ...body.map(([kind, line]) => `${sign[kind]}${line}`),
      ].join("\n");
    }).join("\n");
    const files = parseUnifiedDiff(text);
    assert.deepEqual(files.map((parsed) => parsed.path), bodies.map((_, index) => `f${index}`));
    files.forEach((parsed, index) => {
      assert.deepEqual(parsed.hunks.flatMap((hunk) => hunk.lines).map((line) => [line.kind, line.text]), bodies[index]);
    });
  }), { numRuns: 500 });
});

test("CRLF line endings are not part of a line's text", () => {
  const [file] = parseUnifiedDiff("--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n");
  assert.deepEqual(file!.hunks[0]!.lines.map((line) => line.text), ["a", "b"]);
});

test("the widest line number of a very large diff is found without a spread call", () => {
  const body = Array.from({ length: 200_000 }, (_, index) => `+${index}`).join("\n");
  const files = parseUnifiedDiff(`@@ -0,0 +1,200000 @@\n${body}`);
  assert.equal(diffMaxLineNumber(files), 200_000);
});

test("an empty or headers-only diff has no lines", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
  assert.deepEqual(parseUnifiedDiff("diff --git a/x b/x\nindex 1..2 100644").flatMap((file) => file.hunks), []);
});
