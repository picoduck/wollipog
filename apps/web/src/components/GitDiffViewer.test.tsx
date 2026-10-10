import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitDiffFile, GitDiffInfo, GitHunk } from "@wollipog/protocol";
import { GitDiffViewer, type DiffPane, type StagingControls } from "./GitDiffViewer.js";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("diff source links expose right-side line coordinates only", () => {
  const diff: GitDiffInfo = {
    scope: "uncommitted",
    diffHash: "a".repeat(64),
    stats: { filesChanged: 2, insertions: 1, deletions: 2 },
    files: [
      {
        path: "src/app.ts",
        status: "modified",
        binary: false,
        hunks: [{
          header: "@@ -10 +20 @@",
          oldStart: 10,
          oldCount: 1,
          newStart: 20,
          newCount: 1,
          lines: [{ status: "-", text: "old" }, { status: "+", text: "new" }],
        }],
      },
      {
        path: "src/deleted.ts",
        status: "deleted",
        binary: false,
        hunks: [{
          header: "@@ -1 +0,0 @@",
          oldStart: 1,
          oldCount: 1,
          newStart: 0,
          newCount: 0,
          lines: [{ status: "-", text: "gone" }],
        }],
      },
    ],
  };
  const html = renderToStaticMarkup(React.createElement(GitDiffViewer, {
    diff,
    onOpenSourceLocation: () => undefined,
  }));
  // The file itself opens from its actions menu (GitDiffViewer.sections.dom.test.tsx), not a head link.
  assert.doesNotMatch(html, /aria-label="Open src\/app\.ts"/);
  assert.match(html, /aria-label="Open src\/app\.ts line 20"/);
  assert.doesNotMatch(html, /aria-label="Open src\/app\.ts line 10"/);
  assert.doesNotMatch(html, /aria-label="Open src\/deleted\.ts/);
});

test("diff source links fail closed for noncanonical paths", () => {
  const diff: GitDiffInfo = {
    scope: "uncommitted",
    diffHash: "b".repeat(64),
    stats: { filesChanged: 1, insertions: 1, deletions: 0 },
    files: [{
      path: "../outside.ts",
      status: "added",
      binary: false,
      hunks: [{
        header: "@@ -0,0 +1 @@",
        oldStart: 0,
        oldCount: 0,
        newStart: 1,
        newCount: 1,
        lines: [{ status: "+", text: "new" }],
      }],
    }],
  };
  const html = renderToStaticMarkup(React.createElement(GitDiffViewer, {
    diff,
    onOpenSourceLocation: () => undefined,
  }));
  assert.doesNotMatch(html, /aria-label="Open \.\.\/outside\.ts/);
});

/* -------------------------------------------------------------------------- */
/* File-body notes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The four file-body notes are one `? :` chain, so asserting only that the expected string appears
 * would stay green under a reordering — the intended note still renders for SOME input. Every test
 * below asserts the COMPLETE set of notes the render produced, which pins both the note and the
 * arms it has to beat.
 */
const BINARY_NOTE = "Binary file, so there is no text to show.";
const UNTRACKED_NOTE = "New file, not tracked yet. Commit All Changes includes it.";
const RENAMED_NOTE = "Renamed. Staging isn't available for renames yet.";
const UNCHANGED_NOTE = "No text changes.";

/** React escapes apostrophes in text nodes, and the rename note contains one. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
}

/**
 * The class tokens of a start tag's attribute string.
 *
 * Real token matching, not a `\b` probe: `\b` treats every hyphen as a word boundary, so
 * `/\bdiff-note\b/` also matches `diff-note-renamed` and `not-diff-note`, and a class rename that
 * silently breaks the `styles.css` selector would keep these tests green.
 */
function classTokens(attrs: string): string[] {
  const found = /\sclass="([^"]*)"/.exec(attrs);
  return found ? found[1]!.trim().split(/\s+/).filter(Boolean) : [];
}

/**
 * Every `<tag>` carrying `token` as a class, in document order, with its text entity-decoded.
 *
 * Membership, so reordering the class list and adding attributes stay green — neither is a
 * behavior change. The class NAME stays load-bearing on purpose: `styles.css` selects on it too,
 * so renaming it without updating both is a real defect and must turn these red.
 */
function elementsWithClass(
  html: string,
  tag: string,
  token: string,
): { tokens: string[]; text: string }[] {
  const found: { tokens: string[]; text: string }[] = [];
  // Anchored on the START tag, not a `<tag>...</tag>` pair: these elements are nested inside other
  // `<div>`s, and a lazy pair match would anchor on the enclosing tag and consume the note's own
  // start tag before the class filter ever saw it. Each is a leaf, so its text ends at the next
  // closing tag.
  // `(?=[\\s/>])`, not `\\b`, for the same reason the class match is token-based: `\\b` matches
  // between `button` and the hyphen of `<button-shell>`, so a custom element carrying the class
  // would be read as the native one.
  for (const open of html.matchAll(new RegExp(`<${tag}(?=[\\s/>])([^>]*)>`, "g"))) {
    const tokens = classTokens(open[1]!);
    if (!tokens.includes(token)) continue;
    const rest = html.slice(open.index + open[0].length);
    const end = rest.indexOf(`</${tag}>`);
    found.push({ tokens, text: decodeEntities(end === -1 ? "" : rest.slice(0, end)) });
  }
  return found;
}

/** Every rendered `.diff-note`, entity-decoded, in document order. */
function notesIn(html: string): string[] {
  return elementsWithClass(html, "p", "diff-note").map(({ text }) => text);
}

const TEXT_HUNK: GitHunk = {
  header: "@@ -1 +1 @@",
  oldStart: 1,
  oldCount: 1,
  newStart: 1,
  newCount: 1,
  lines: [{ status: "-", text: "old" }, { status: "+", text: "new" }],
};

/** Fine-grained staging on the combined pane — the only configuration that offers Discard at all. */
const STAGING: StagingControls = {
  onHunk: () => {},
  onLines: () => {},
  onDiscard: () => {},
  pane: "combined",
  fineGrained: true,
  busyKey: null,
};

function renderDiff(file: GitDiffFile, staging?: StagingControls): string {
  const diff: GitDiffInfo = {
    scope: "uncommitted",
    diffHash: "c".repeat(64),
    stats: { filesChanged: 1, insertions: 0, deletions: 0 },
    files: [file],
  };
  return renderToStaticMarkup(React.createElement(GitDiffViewer, { diff, staging }));
}

test("a binary file renders only the Binary note, and outranks the untracked arm below it", () => {
  assert.deepEqual(
    notesIn(renderDiff({ path: "logo.png", status: "modified", binary: true, hunks: [] })),
    [BINARY_NOTE],
  );
  // Untracked binaries are ordinary: `git ls-files --others` stamps `binary` from content, so this
  // pair reaches the chain together and only the arm ORDER decides which note a user sees.
  const both = renderDiff({ path: "blob.bin", status: "untracked", binary: true, hunks: [] }, STAGING);
  assert.deepEqual(notesIn(both), [BINARY_NOTE], "binary must win over untracked, the arm directly below it");
  // Git reports a changed binary that it detected as a rename with BOTH `rename from/to` and
  // `Binary files ... differ`, and git-ops.ts sets `status` and `binary` on independent branches —
  // so this shape is real, and only arm order keeps it on the binary note.
  assert.deepEqual(
    notesIn(renderDiff({ path: "art.png", status: "renamed", binary: true, hunks: [] })),
    [BINARY_NOTE],
    "binary must also win over renamed, which the fallback arm below handles",
  );
});

test("an untracked file renders its note in a sentence", () => {
  const html = renderDiff({ path: "new.txt", status: "untracked", binary: false, hunks: [] }, STAGING);
  assert.deepEqual(notesIn(html), [UNTRACKED_NOTE]);
});

/** The file's status letter: its tokens, the visible letter and the word that names it. */
function statusIn(html: string): { tokens: string[]; letter: string; word: string; title: string } | null {
  const open = /<span([^>]*)><span aria-hidden="true">([^<]*)<\/span><span class="sr-only">([^<]*)<\/span><\/span>/.exec(html);
  if (!open || !classTokens(open[1]!).includes("dfile-status")) return null;
  return {
    tokens: classTokens(open[1]!),
    letter: open[2]!,
    word: open[3]!,
    title: /\stitle="([^"]*)"/.exec(open[1]!)?.[1] ?? "",
  };
}

test("each change kind shows its letter, named by its word, and only Added and Deleted are tinted (#2848)", () => {
  const expected = [
    ["added", "A", "Added", "is-added"],
    ["modified", "M", "Modified", null],
    ["deleted", "D", "Deleted", "is-deleted"],
    ["renamed", "R", "Renamed", null],
    // Never "??": an untracked file is U, like every other letter.
    ["untracked", "U", "Untracked", null],
  ] as const;
  for (const [status, letter, word, tint] of expected) {
    const html = renderDiff({ path: "src/file.ts", status, binary: false, hunks: [] });
    const shown = statusIn(html);
    assert.ok(shown, status);
    assert.equal(shown.letter, letter, status);
    assert.equal(shown.word, word, `${status} is named by its word`);
    assert.equal(shown.title, word, `${status}'s tooltip is its word`);
    assert.deepEqual(shown.tokens.filter((token) => token.startsWith("is-")), tint ? [tint] : [], status);
    assert.doesNotMatch(html, /\?\?/, "no ?? anywhere");
  }
});

test("a path keeps its file name whole beside a faint folder, with the full path as its tooltip", () => {
  const html = renderDiff({ path: "apps/shop/src/checkout/CheckoutPage.tsx", status: "modified", binary: false, hunks: [] });
  assert.match(html, /<span class="dfile-path" title="apps\/shop\/src\/checkout\/CheckoutPage\.tsx"><span class="dfile-dir">apps\/shop\/src\/checkout\/<\/span><span class="dfile-name">CheckoutPage\.tsx<\/span><\/span>/);
  // A root-level file has no folder part to give way.
  assert.match(renderDiff({ path: "README.md", status: "modified", binary: false, hunks: [] }),
    /<span class="dfile-path" title="README\.md"><span class="dfile-name">README\.md<\/span><\/span>/);
});

test("a rename names its old path as quiet from text, with no arrow", () => {
  const html = renderDiff({ path: "src/cart/cart-totals.ts", oldPath: "src/cart/totals.ts", status: "renamed", binary: false, hunks: [] });
  assert.deepEqual(elementsWithClass(html, "span", "dfile-from").map(({ text }) => text), ["from src/cart/totals.ts"]);
  assert.doesNotMatch(html, /→/);
});

test("no text glyph stands in for an icon in the diff (#2848)", () => {
  const staged: GitHunk = { ...TEXT_HUNK, staged: true };
  const html = [
    renderDiff({ path: "src/app.ts", status: "modified", binary: false, hunks: [staged, TEXT_HUNK] }, STAGING),
    renderDiff({ path: "src/moved.ts", oldPath: "src/old.ts", status: "renamed", binary: false, hunks: [] }, STAGING),
    renderDiff({ path: "notes.md", status: "untracked", binary: false, hunks: [] }, STAGING),
  ].join("");
  for (const glyph of ["↗", "??", "▾", "▸", "→", "✓"]) assert.ok(!html.includes(glyph), `no ${glyph}`);
  assert.doesNotMatch(html, />Discard</, "no Discard button on the file");
});

/** The hunk header's buttons, in order, with React's text separators removed. */
function hunkActions(html: string): string[] {
  return elementsWithClass(html, "button", "btn").map(({ text }) => text.replace(/<!-- -->/g, ""));
}

test("line staging names a hunk's one button in Title Case on both index panes (#2096, #2848)", () => {
  const file: GitDiffFile = { path: "src/app.ts", status: "modified", binary: false, hunks: [TEXT_HUNK] };
  // Stage Selected appears once there is a selection, so the header is one line at rest.
  assert.deepEqual(hunkActions(renderDiff(file, { ...STAGING, pane: "unstaged" })), ["Stage Hunk"]);
  assert.deepEqual(hunkActions(renderDiff(file, { ...STAGING, pane: "staged" })), ["Unstage Hunk"]);
});

test("All Changes stages a hunk with Stage Hunk, and a staged hunk says Staged beside Unstage Hunk", () => {
  const staged: GitHunk = { ...TEXT_HUNK, staged: true };
  const html = renderDiff({ path: "src/app.ts", status: "modified", binary: false, hunks: [TEXT_HUNK, staged] }, STAGING);
  assert.deepEqual(hunkActions(html), ["Stage Hunk", "Unstage Hunk"]);
  const chip = elementsWithClass(html, "span", "hunk-staged");
  assert.equal(chip.length, 1);
  assert.match(chip[0]!.text, /<svg[^>]*class="[^"]*lucide-check[^"]*"[\s\S]*Staged$/, "a check icon, then Staged");
  // Both are the one ghost button the header reveals with a mouse.
  assert.equal(elementsWithClass(html, "button", "hunk-stage").length, 2);
  assert.ok(elementsWithClass(html, "button", "hunk-stage").every(({ tokens }) => tokens.includes("ghost") && tokens.includes("sm")));
});

test("a renamed file that also changed content renders its patch, not the rename note", () => {
  // `parseDiff` emits oldPath AND hunks for this (apps/runner/src/git-ops.test.ts:671). Hoisting the
  // renamed check above the `hunks.length === 0` arm would replace a real patch with the note.
  const html = renderDiff({ path: "src/moved.ts", status: "renamed", binary: false, hunks: [TEXT_HUNK] });
  assert.deepEqual(notesIn(html), []);
  assert.match(html, /diff-line|diff-hunk|@@/, "the patch body must still render");
});

test("a renamed file with no hunks explains that renames are not stageable", () => {
  assert.deepEqual(
    notesIn(renderDiff({ path: "renamed.ts", status: "renamed", binary: false, hunks: [] })),
    [RENAMED_NOTE],
  );
});

test("every tracked non-renamed status with no hunks reports no textual changes", () => {
  // Three real hunkless shapes, not one: a mode-only change stays `modified`, while an empty-file
  // add or delete carries `new file mode` / `deleted file mode` and never emits an `@@` hunk.
  // Covering only `modified` let a fallback narrowed to that status blank the other two cards.
  for (const status of ["modified", "added", "deleted"] as const) {
    assert.deepEqual(
      notesIn(renderDiff({ path: "empty.txt", status, binary: false, hunks: [] })),
      [UNCHANGED_NOTE],
      status,
    );
  }
});
