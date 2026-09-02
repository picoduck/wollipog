import assert from "node:assert/strict";
import { test } from "node:test";
import { crumbsFor, editorSupportsSourceLocation, formatBytes, isMarkdownPath, resolveSourceTarget } from "./files-panel.js";

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
  assert.deepEqual(crumbsFor(""), [{ name: "root", path: "" }]);
  assert.deepEqual(crumbsFor("a/b/c"), [
    { name: "root", path: "" },
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
