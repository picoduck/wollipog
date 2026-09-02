import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitDiffFile, GitDiffInfo, GitHunk } from "@wollipog/protocol";
import { GitDiffViewer, type StagingControls } from "./GitDiffViewer.js";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("diff source links expose current-file headers and right-side line coordinates only", () => {
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
  assert.match(html, /aria-label="Open src\/app\.ts"/);
  assert.match(html, /aria-label="Open src\/app\.ts line 20"/);
  assert.doesNotMatch(html, /aria-label="Open src\/app\.ts line 10"/);
  assert.doesNotMatch(html, /aria-label="Open src\/deleted\.ts"/);
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
const BINARY_NOTE = "Binary — Not Patchable";
const UNTRACKED_NOTE = "untracked file — included by Commit all, or by Commit when nothing is staged";
const RENAMED_NOTE = "renamed — stage/unstage isn't available for renames yet";
const UNCHANGED_NOTE = "no textual changes";

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
  return elementsWithClass(html, "div", "diff-note").map(({ text }) => text);
}

/** The file's status badge, or null. Class ORDER is not asserted; membership and label are. */
function badgeIn(html: string): { tokens: string[]; text: string } | null {
  return elementsWithClass(html, "span", "diff-badge")[0] ?? null;
}

/**
 * Whether the Discard control is offered.
 *
 * Token-matched because the absence assertions below are the load-bearing ones: against
 * `class="diff-discard"` as an exact attribute, adding any second class to the button would render
 * Discard for untracked files while those assertions still passed.
 */
function offersDiscard(html: string): boolean {
  return elementsWithClass(html, "button", "diff-discard").length > 0;
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
  // Rendered WITH staging on purpose. Suppression must key on untracked alone: relaxing the guard
  // to `file.status !== "untracked" || file.binary` offers Discard for a file with no HEAD state to
  // restore, and every other test here stays green through it.
  assert.equal(offersDiscard(both), false);
  // Git reports a changed binary that it detected as a rename with BOTH `rename from/to` and
  // `Binary files ... differ`, and git-ops.ts sets `status` and `binary` on independent branches —
  // so this shape is real, and only arm order keeps it on the binary note.
  assert.deepEqual(
    notesIn(renderDiff({ path: "art.png", status: "renamed", binary: true, hunks: [] })),
    [BINARY_NOTE],
    "binary must also win over renamed, which the fallback arm below handles",
  );
});

test("an untracked file renders its note and the ?? badge, and offers no Discard", () => {
  const html = renderDiff({ path: "new.txt", status: "untracked", binary: false, hunks: [] }, STAGING);
  assert.deepEqual(notesIn(html), [UNTRACKED_NOTE]);
  const badge = badgeIn(html);
  assert.ok(badge?.tokens.includes("diff-badge-untracked"), "the untracked badge class is load-bearing");
  assert.equal(badge?.text, "??");
  // Discard resets a tracked file to HEAD; an untracked file has no HEAD state to return to, so
  // the control is withheld rather than offered and failed.
  assert.equal(offersDiscard(html), false);
});

test("the Discard suppression is specific to untracked files, not blanket", () => {
  // Every tracked class, because `discardFile` handles each of them — it has dedicated `added` and
  // `renamed` branches (apps/runner/src/git-ops.ts:1955-1963). A guard narrowed to `modified`, or
  // one that also excluded binaries, would silently strip Discard from the rest.
  const tracked: GitDiffFile[] = [
    { path: "src/app.ts", status: "modified", binary: false, hunks: [TEXT_HUNK] },
    { path: "src/new.ts", status: "added", binary: false, hunks: [TEXT_HUNK] },
    { path: "src/gone.ts", status: "deleted", binary: false, hunks: [TEXT_HUNK] },
    { path: "src/moved.ts", status: "renamed", binary: false, hunks: [TEXT_HUNK] },
    { path: "logo.png", status: "modified", binary: true, hunks: [] },
  ];
  for (const file of tracked) {
    assert.ok(offersDiscard(renderDiff(file, STAGING)), `${file.status}/${file.binary}`);
  }
  assert.deepEqual(
    notesIn(renderDiff(tracked[0]!, STAGING)),
    [],
    "a file with hunks renders a patch, not a note",
  );
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
