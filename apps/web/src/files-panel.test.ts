import assert from "node:assert/strict";
import { test } from "node:test";
import {
  baseName,
  crumbsFor,
  editorSupportsSourceLocation,
  fileIconKind,
  fileLanguage,
  formatBytes,
  gitMarkers,
  isMarkdownPath,
  lineCountLabel,
  markSegments,
  parentPath,
  rankFuzzyWorkspacePaths,
  rankGoToFileResults,
  resolveSourceTarget,
  sourceLines,
  unquotePorcelainPath,
  inManagedWorktree,
  sessionRootName,
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
    line: 1, error: "No symbol named “missing” in this file.", missingSymbol: true,
  });
  assert.deepEqual(resolveSourceTarget("one\ntwo", { path: "a", line: 2, symbol: "missing" }), {
    line: 2, column: undefined, error: "No symbol named “missing” on line 2.", missingSymbol: true,
  });
  // The newline that ends the last line opens no line after it.
  assert.deepEqual(resolveSourceTarget("one\ntwo\n", { path: "a", line: 3 }), {
    line: 3, error: "Line 3 is outside this 2-line preview.",
  });
});

test("the viewer's lines: CR dropped, no empty row after the final newline, an empty file is one row (#2853)", () => {
  assert.deepEqual(sourceLines("a\r\nb\n"), ["a", "b"]);
  assert.deepEqual(sourceLines("a\n\n"), ["a", ""]);
  assert.deepEqual(sourceLines("a"), ["a"]);
  assert.deepEqual(sourceLines(""), [""]);
});

test("the meta line names the language and counts lines (#2853)", () => {
  assert.equal(fileLanguage("src/app.ts"), "TypeScript");
  assert.equal(fileLanguage("src/App.TSX"), "TSX");
  assert.equal(fileLanguage("README.md"), "Markdown");
  assert.equal(fileLanguage("ops/Dockerfile"), "Dockerfile");
  assert.equal(fileLanguage("LICENSE"), "Plain Text");
  assert.equal(fileLanguage(".env"), "Plain Text");
  assert.equal(lineCountLabel(1), "1 line");
  assert.equal(lineCountLabel(2000), "2,000 lines");
});

test("a mark splits highlighted segments without losing their kinds (#2853)", () => {
  const segments = [{ text: "const", kind: "keyword" }, { text: " total = ", kind: "plain" }, { text: "42", kind: "number" }];
  assert.deepEqual(markSegments(segments, 6, 11), [
    { text: "const", kind: "keyword", marked: false },
    { text: " ", kind: "plain", marked: false },
    { text: "total", kind: "plain", marked: true },
    { text: " = ", kind: "plain", marked: false },
    { text: "42", kind: "number", marked: false },
  ]);
  assert.deepEqual(markSegments(segments, 3, 15).filter((segment) => segment.marked).map((segment) => segment.text),
    ["st", " total = ", "4"]);
  assert.deepEqual(markSegments(segments, 20, 21).filter((segment) => segment.marked), []);
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

test("a managed worktree is named by its workspace, a folder of its own by the folder (#2852)", () => {
  const managedPath = "/home/me/.wollipog/worktrees/acme-storefront-1f2e/s_4de7e8705433";
  // Launched in a worktree, with no worktree records from an older control plane.
  const launched = { useWorktree: true, worktreePath: managedPath, workspaceName: "acme-storefront" };
  assert.equal(inManagedWorktree(launched), true);
  assert.equal(sessionRootName(launched), "acme-storefront");
  // The selected worktree's record decides: one Wollipog created is managed, an attached one is not.
  const created = { ...launched, useWorktree: false,
    worktrees: [{ id: "s_4de7e8705433", path: managedPath, branch: "agent/s_4de7e8705433", source: "created" as const }] };
  assert.equal(sessionRootName(created), "acme-storefront");
  const attached = { ...launched, worktreePath: "/home/me/src/storefront-checkout",
    worktrees: [{ id: "checkout", path: "/home/me/src/storefront-checkout", branch: "checkout", source: "attached" as const }] };
  assert.equal(inManagedWorktree(attached), false);
  assert.equal(sessionRootName(attached), "storefront-checkout");
  // A session working directly in its folder keeps the folder's name.
  const direct = { useWorktree: false, worktreePath: "/home/me/src/storefront", workspaceName: "acme-storefront" };
  assert.equal(sessionRootName(direct), "storefront");
  // With no workspace name to use, the folder's name stays.
  assert.equal(sessionRootName({ ...launched, workspaceName: "  " }), "s_4de7e8705433");
  assert.equal(sessionRootName({ useWorktree: true, worktreePath: null, workspaceName: "acme-storefront" }), "acme-storefront");
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
  // A name that starts with U+FEFF keeps it: the bytes are the name, not a byte order mark.
  assert.equal(unquotePorcelainPath("\"\\357\\273\\277check.ts\""), "\u{FEFF}check.ts");
});

test("Go to File: files only, changed or recent first, then the best fuzzy match (#1263)", () => {
  const ranked = rankGoToFileResults([
    { path: "checks", isDirectory: true },
    { path: "checks/run.ts", isDirectory: false },
    { path: "src/checkout.ts", isDirectory: false },
    { path: "docs/check-list.md", isDirectory: false },
    { path: "src/precheck.ts", isDirectory: false },
    { path: "src/unrelated.ts", isDirectory: false },
  ], "Check", new Set(["src/precheck.ts"]));
  assert.deepEqual(ranked.map((match) => match.path), [
    "src/precheck.ts",
    "src/checkout.ts",
    "docs/check-list.md",
    "checks/run.ts",
  ], "a file that does not match is dropped, even from an older runner's answer");
  assert.deepEqual(ranked[0], {
    path: "src/precheck.ts", name: "precheck.ts", folder: "src", nameRanges: [{ start: 3, end: 8 }], folderRanges: [],
  });
  assert.deepEqual(ranked[3], {
    path: "checks/run.ts", name: "run.ts", folder: "checks", nameRanges: [], folderRanges: [{ start: 0, end: 5 }],
  });
  // Scattered letters underline each run; a match across the folder and the name underlines both.
  assert.deepEqual(rankGoToFileResults([{ path: "apps/web/SessionDetail.tsx", isDirectory: false }], "sdtsx", new Set()), [{
    path: "apps/web/SessionDetail.tsx",
    name: "SessionDetail.tsx",
    folder: "apps/web",
    nameRanges: [{ start: 0, end: 1 }, { start: 7, end: 8 }, { start: 14, end: 17 }],
    folderRanges: [],
  }]);
  const across = rankGoToFileResults([{ path: "src/session.ts", isDirectory: false }], "src/se", new Set())[0];
  assert.deepEqual([across?.folderRanges, across?.nameRanges], [[{ start: 0, end: 3 }], [{ start: 0, end: 2 }]]);
});

test("Go to File lifts a changed file only on a clean match: a scatter never tops a strong name match", () => {
  const results = [
    { path: "apps/web/src/components/CheckBadge.tsx", isDirectory: false },
    { path: "apps/web/src/components/SessionDetail.tsx", isDirectory: false },
    { path: "src/unrelated.ts", isDirectory: false },
  ];
  const changed = new Set(["apps/web/src/components/CheckBadge.tsx"]);
  assert.deepEqual(rankGoToFileResults(results, "sdtsx", changed).map((match) => match.path), [
    "apps/web/src/components/SessionDetail.tsx",
    "apps/web/src/components/CheckBadge.tsx",
  ], "the changed file's scattered s…d…tsx ranks by score, below the word-start name match");
  assert.equal(rankGoToFileResults(results, "check", changed)[0]?.path, "apps/web/src/components/CheckBadge.tsx",
    "on a clean match the changed file still leads");
  assert.deepEqual(
    rankGoToFileResults([{ path: "src/session.ts", isDirectory: false }], "sdtsx", changed, true).map((match) => match.path),
    [],
    "a cut answer does not gain a priority file on a scattered match",
  );
});

test("Go to File adds matching priority files only when the runner's answer was cut short", () => {
  const results = [{ path: "src/session-list.ts", isDirectory: false }];
  const priority = new Set(["deep/nested/session-store.ts", "README.md", "untracked-dir/"]);
  assert.deepEqual(rankGoToFileResults(results, "session", priority).map((match) => match.path), ["src/session-list.ts"],
    "a complete answer without it means the file is gone");
  assert.deepEqual(rankGoToFileResults(results, "session", priority, true).map((match) => match.path), [
    "deep/nested/session-store.ts",
    "src/session-list.ts",
  ], "a cut answer gains the changed or recent file that matches, first; folders and non-matches stay out");
});

test("the @ picker ranks a fuzzy answer's files and folders by the Go to File scorer (#4129)", () => {
  const results = [
    { path: "apps/web/src/components/CheckBadge.tsx", isDirectory: false },
    { path: "docs/unrelated.md", isDirectory: false },
    { path: "apps/web/src/components/SessionDetail.tsx", isDirectory: false },
    { path: "docs/sdtsx-notes", isDirectory: true },
  ];
  assert.deepEqual(rankFuzzyWorkspacePaths(results, "sdtsx"), [results[3], results[2], results[0]],
    "folders stay in; a scattered match ranks last and a path without the letters drops out");
  const ties = [{ path: "src/b-item", isDirectory: true }, { path: "src/a-item", isDirectory: false }];
  assert.deepEqual(rankFuzzyWorkspacePaths(ties, "item"), ties, "equal matches keep the runner's order");
});
