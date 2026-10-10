import assert from "node:assert/strict";
import { test } from "node:test";
import {
  baseName,
  crumbsFor,
  editorSupportsSourceLocation,
  fileIconKind,
  formatBytes,
  gitMarkers,
  isMarkdownPath,
  parentPath,
  rankGoToFileResults,
  resolveSourceTarget,
  unquotePorcelainPath,
  workspaceFolderName,
} from "./files-panel.js";

test("isMarkdownPath matches md/markdown/mdx case-insensitively", () => {
  assert.equal(isMarkdownPath("README.md"), true);
  assert.equal(isMarkdownPath("docs/Guide.MD"), true);
  assert.equal(isMarkdownPath("a/b/notes.markdown"), true);
  assert.equal(isMarkdownPath("page.mdx"), true);
  assert.equal(isMarkdownPath("script.ts"), false);
  assert.equal(isMarkdownPath("md"), false);
  assert.equal(isMarkdownPath("archive.md.gz"), false);
});

test("formatBytes: unknown, bytes, KB/MB thresholds, ≥100 rounds", () => {
  assert.equal(formatBytes(undefined), "");
  assert.equal(formatBytes(-1), "");
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(150 * 1024), "150 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), "3.0 GB");
});

test("crumbsFor builds cumulative root-relative paths from the root crumb", () => {
  assert.deepEqual(crumbsFor("", "wollipog"), [{ name: "wollipog", path: "" }]);
  assert.deepEqual(crumbsFor("a/b/c", "wollipog"), [
    { name: "wollipog", path: "" },
    { name: "a", path: "a" },
    { name: "b", path: "a/b" },
    { name: "c", path: "a/b/c" },
  ]);
  assert.deepEqual(crumbsFor("src", "my-repo")[0], { name: "my-repo", path: "" });
});

test("source targets resolve exact lines, columns, and first symbol occurrences", () => {
  const content = "const first = 1;\r\nfunction renderApp() {\n  return first;\n}";
  assert.deepEqual(resolveSourceTarget(content, { path: "a.ts", line: 3, column: 3 }), {
    line: 3, column: 3, matchLength: 1,
  });
  assert.deepEqual(resolveSourceTarget(content, { path: "a.ts", symbol: "renderApp" }), {
    line: 2, column: 10, matchLength: 9,
  });
  assert.deepEqual(resolveSourceTarget(content, { path: "a.ts", line: 2, symbol: "renderApp" }), {
    line: 2, column: 10, matchLength: 9,
  });
  assert.equal(resolveSourceTarget(content, { path: "a.ts" }), null);
});

test("source target failures stay explicit instead of clamping or fabricating a match", () => {
  assert.deepEqual(resolveSourceTarget("one\ntwo", { path: "a", line: 3 }), {
    line: 3, error: "Line 3 is outside this 2-line preview.",
  });
  assert.deepEqual(resolveSourceTarget("one\ntwo", { path: "a", line: 2, column: 9 }), {
    line: 2, column: 9, error: "Column 9 is outside line 2.",
  });
  assert.deepEqual(resolveSourceTarget("one\ntwo", { path: "a", symbol: "missing" }), {
    line: 1, error: "Symbol “missing” was not found in this preview.",
  });
});

test("editor source affordances require advertised precision", () => {
  const editor = { id: "code", name: "VS Code", locations: { native: "line" as const } };
  assert.equal(editorSupportsSourceLocation(editor, { path: "a.ts" }), true);
  assert.equal(editorSupportsSourceLocation(editor, { path: "a.ts", line: 2 }), true);
  assert.equal(editorSupportsSourceLocation(editor, { path: "a.ts", line: 2, column: 3 }), false);
  assert.equal(editorSupportsSourceLocation({ id: "windsurf", name: "Devin Desktop" }, { path: "a.ts" }), false);
});

test("the root is named by its working folder, POSIX or Windows, else the workspace (#2852)", () => {
  assert.equal(workspaceFolderName("/home/me/.agent-worktrees/wollipog-fix/"), "wollipog-fix");
  assert.equal(workspaceFolderName("C:\\Users\\me\\src\\site"), "site");
  assert.equal(workspaceFolderName(null, "Docs Site"), "Docs Site");
  assert.equal(workspaceFolderName("", "  "), "Workspace");
  assert.equal(parentPath("a/b/c.ts"), "a/b");
  assert.equal(parentPath("c.ts"), "");
  assert.equal(parentPath(""), "");
  assert.equal(baseName("a/b/c.ts"), "c.ts");
});

test("rows name their icon by kind, never by emoji", () => {
  assert.equal(fileIconKind("src", true), "folder");
  assert.equal(fileIconKind("index.TSX", false), "code");
  assert.equal(fileIconKind("Dockerfile", false), "code");
  assert.equal(fileIconKind("logo.svg", false), "image");
  assert.equal(fileIconKind("README.md", false), "file");
  assert.equal(fileIconKind(".env", false), "file", "a dotfile has no extension");
});

test("git markers: untracked U, added or renamed A, everything else changed M, deletions none", () => {
  const markers = gitMarkers([
    { status: "M", path: "src/a.ts" },
    { status: "MM", path: "src/b.ts" },
    { status: "AM", path: "src/new.ts" },
    { status: "??", path: "notes.txt" },
    { status: "R", path: "old.ts -> src/moved.ts" },
    { status: "D", path: "gone.ts" },
    { status: "UU", path: "conflict.ts" },
    { status: "??", path: "\"with space\\ttab.txt\"" },
    // Git's default quoting writes non-ASCII as octal escapes of the UTF-8 bytes.
    { status: "M", path: "\"src/caf\\303\\251.ts\"" },
    { status: "R", path: "\"old \\303\\251.ts\" -> \"docs/r\\303\\251sum\\303\\251.md\"" },
    // Only a rename or copy has an arrow; an ordinary name may contain one.
    { status: "M", path: "old -> new.ts" },
  ]);
  assert.deepEqual(Object.fromEntries(markers), {
    "src/a.ts": "M",
    "src/b.ts": "M",
    "src/new.ts": "A",
    "notes.txt": "U",
    "src/moved.ts": "A",
    "conflict.ts": "M",
    "with space\ttab.txt": "U",
    "src/café.ts": "M",
    "docs/résumé.md": "A",
    "old -> new.ts": "M",
  });
  assert.equal(gitMarkers(null).size, 0);
  assert.equal(unquotePorcelainPath("\"a\\\"b\\\\c\""), "a\"b\\c");
  assert.equal(unquotePorcelainPath("plain.ts"), "plain.ts");
  assert.equal(unquotePorcelainPath("\"bad\\q\""), "\"bad\\q\"", "an unknown escape leaves the path as written");
  // With `core.quotePath` off, git keeps literal non-ASCII inside a path it still quotes.
  assert.equal(unquotePorcelainPath("\"emoji\u{1F600}\\\".ts\""), "emoji\u{1F600}\".ts");
});

test("Go to File: files only, changed or recent first, then name matches before path matches", () => {
  const ranked = rankGoToFileResults([
    { path: "checks", isDirectory: true },
    { path: "checks/run.ts", isDirectory: false },
    { path: "src/checkout.ts", isDirectory: false },
    { path: "docs/check-list.md", isDirectory: false },
    { path: "src/precheck.ts", isDirectory: false },
  ], "Check", (path) => path === "src/precheck.ts");
  assert.deepEqual(ranked.map((match) => match.path), [
    "src/precheck.ts",
    "src/checkout.ts",
    "docs/check-list.md",
    "checks/run.ts",
  ]);
  assert.deepEqual(ranked[0], {
    path: "src/precheck.ts", name: "precheck.ts", folder: "src", matchIn: "name", range: { start: 3, end: 8 },
  });
  assert.deepEqual(ranked[3], {
    path: "checks/run.ts", name: "run.ts", folder: "checks", matchIn: "folder", range: { start: 0, end: 5 },
  });
  // A match across the folder and the name underlines nothing rather than the wrong letters.
  assert.equal(rankGoToFileResults([{ path: "src/session.ts", isDirectory: false }], "src/se", () => false)[0]?.matchIn, "path");
});
