import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitDiffFile, GitDiffInfo, GitHunk, GitStatusInfo, ReviewFinding } from "@wollipog/protocol";
import {
  buildDiffAnchorIndex,
  changeSetSignature,
  diffAnchorKey,
  diffFileContentKey,
  reanchorFindings,
} from "./review-anchors.js";

function hunk(over: Partial<GitHunk> = {}): GitHunk {
  return {
    header: "@@ -10,3 +10,3 @@",
    oldStart: 10,
    oldCount: 3,
    newStart: 10,
    newCount: 3,
    lines: [
      { status: " ", text: "context" },
      { status: "-", text: "before" },
      { status: "+", text: "after" },
      { status: " ", text: "tail" },
    ],
    ...over,
  };
}

function file(over: Partial<GitDiffFile> = {}): GitDiffFile {
  return { path: "src/a.ts", status: "modified", binary: false, hunks: [hunk()], ...over };
}

function diff(over: Partial<GitDiffInfo> = {}): GitDiffInfo {
  return {
    scope: "uncommitted",
    diffHash: "a".repeat(64),
    stats: { filesChanged: 1, insertions: 1, deletions: 1 },
    files: [file()],
    ...over,
  };
}

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    findingId: "f1",
    sessionId: "s1",
    scope: "uncommitted",
    diffHash: "a".repeat(64),
    filePath: "src/a.ts",
    side: "right",
    line: 11,
    body: "fix this",
    severity: "major",
    required: true,
    status: "open",
    source: "local",
    author: { kind: "human", id: "reviewer" },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/* Anchor index                                                               */
/* -------------------------------------------------------------------------- */

test("the anchor index carries the text of every line a comment can attach to, on both sides", () => {
  const index = buildDiffAnchorIndex(diff());
  // Unified anchoring: deletions left at the old number, additions and context right at the new one.
  assert.equal(index.get(diffAnchorKey({ filePath: "src/a.ts", side: "right", line: 10 })), "context");
  assert.equal(index.get(diffAnchorKey({ filePath: "src/a.ts", side: "left", line: 11 })), "before");
  assert.equal(index.get(diffAnchorKey({ filePath: "src/a.ts", side: "right", line: 11 })), "after");
  // A context line also carries a LEFT anchor, numbered from the old gutter — that is the anchor the
  // split layout renders, and the one an imported forge thread on an unchanged line uses. Indexing
  // only the unified anchors would report every such finding as stale forever.
  assert.equal(index.get(diffAnchorKey({ filePath: "src/a.ts", side: "left", line: 10 })), "context");
  assert.equal(index.get(diffAnchorKey({ filePath: "src/a.ts", side: "left", line: 12 })), "tail");
});

test("anchor keys distinguish files whose paths differ only where the key is joined", () => {
  // A path may contain any byte but NUL and `/`, so a printable separator could be forged: these two
  // files must not share a key for line 1.
  const a = diffAnchorKey({ filePath: "a:1", side: "right", line: 2 });
  const b = diffAnchorKey({ filePath: "a", side: "right", line: 12 });
  assert.notEqual(a, b);
});

/* -------------------------------------------------------------------------- */
/* Per-file content keys (file card identity)                                 */
/* -------------------------------------------------------------------------- */

test("a file's content key ignores staging, so staging a hunk cannot reset the card it is in", () => {
  // The bug this pins: `staged` flips on a hunk without a single line of the combined diff changing,
  // and keying the card on anything that sees the flag collapses the card mid-interaction (#1203).
  const unstaged = file({ hunks: [hunk({ staged: false })] });
  const staged = file({ hunks: [hunk({ staged: true })] });
  assert.equal(diffFileContentKey(unstaged), diffFileContentKey(staged));
});

test("a file's content key changes for every edit that renumbers or rewrites its hunks", () => {
  const base = diffFileContentKey(file());
  const cases: Array<[string, GitDiffFile]> = [
    ["line text", file({ hunks: [hunk({ lines: [{ status: "+", text: "different" }] })] })],
    ["line status", file({ hunks: [hunk({ lines: [{ status: "-", text: "context" }] })] })],
    ["hunk header", file({ hunks: [hunk({ header: "@@ -99,3 +99,3 @@" })] })],
    ["hunk count", file({ hunks: [hunk(), hunk()] })],
    ["change kind", file({ status: "added" })],
    ["rename source", file({ oldPath: "src/old.ts" })],
    ["binary flag", file({ binary: true })],
  ];
  for (const [label, changed] of cases) {
    assert.notEqual(diffFileContentKey(changed), base, label);
  }
});

test("a file's content key cannot be re-cut across its fields", () => {
  // Folding fields without a terminator makes "ab"+"c" and "a"+"bc" the same digest, which would let
  // a rename to a suffix of the old path reuse the card.
  assert.notEqual(
    diffFileContentKey(file({ hunks: [hunk({ lines: [{ status: " ", text: "ab" }, { status: " ", text: "c" }] })] })),
    diffFileContentKey(file({ hunks: [hunk({ lines: [{ status: " ", text: "a" }, { status: " ", text: "bc" }] })] })),
  );
});

/* -------------------------------------------------------------------------- */
/* Re-anchoring findings                                                      */
/* -------------------------------------------------------------------------- */

/** The fixtures above are authored against `"a"*64`; every refresh below moves to this one. */
const HASH_B = "b".repeat(64);

test("a finding authored against the diff on screen is anchored", () => {
  const state = reanchorFindings(null, diff(), "uncommitted:combined", [finding()]);
  assert.deepEqual([...state.anchored], ["f1"]);
});

test("a finding on an unchanged line survives an unrelated change-set hash change", () => {
  // Exactly the reported failure: staging a hunk in src/b.ts rehashes the whole change set, and
  // src/a.ts line 11 is byte-identical either side of it (#1203).
  const before = diff({
    files: [file(), file({ path: "src/b.ts" })],
  });
  const first = reanchorFindings(null, before, "uncommitted:combined", [finding()]);
  const after = diff({
    diffHash: HASH_B,
    files: [file(), file({ path: "src/b.ts", hunks: [hunk({ staged: true })] })],
  });
  const second = reanchorFindings(first, after, "uncommitted:combined", [finding()]);
  assert.deepEqual([...second.anchored], ["f1"], "the finding's own line never moved");
});

test("a finding goes stale exactly when its own anchored line changes", () => {
  const first = reanchorFindings(null, diff(), "uncommitted:combined", [finding()]);
  const rewritten = diff({
    diffHash: HASH_B,
    files: [file({ hunks: [hunk({ lines: [
      { status: " ", text: "context" },
      { status: "-", text: "before" },
      { status: "+", text: "rewritten" },
      { status: " ", text: "tail" },
    ] })] })],
  });
  const second = reanchorFindings(first, rewritten, "uncommitted:combined", [finding()]);
  assert.deepEqual([...second.anchored], [], "line 11's text changed under the finding");
});

test("a finding whose anchored line disappeared goes stale", () => {
  const first = reanchorFindings(null, diff(), "uncommitted:combined", [finding()]);
  const gone = reanchorFindings(first, diff({ diffHash: HASH_B, files: [] }), "uncommitted:combined", [finding()]);
  assert.deepEqual([...gone.anchored], []);
});

test("anchors carry through a chain of refreshes, not just the one after authoring", () => {
  // The active-turn cadence (#1204) rehashes the change set repeatedly while the reviewer reads, so
  // carrying only one generation would still lose the anchor on the second refresh.
  let state = reanchorFindings(null, diff(), "uncommitted:combined", [finding()]);
  for (const hash of ["b", "c", "d"]) {
    state = reanchorFindings(state, diff({ diffHash: hash.repeat(64) }), "uncommitted:combined", [finding()]);
  }
  assert.deepEqual([...state.anchored], ["f1"]);
});

test("anchors are never carried between panes, even at an identical line", () => {
  // Pane-local anchor identities exist so a finding authored against the staged pane is not
  // re-attached to the same numeric line of the unstaged one. Same content, different lineage.
  const first = reanchorFindings(null, diff(), "uncommitted:combined", [finding()]);
  const other = reanchorFindings(first, diff({ diffHash: HASH_B }), "uncommitted:staged", [finding()]);
  assert.deepEqual([...other.anchored], [], "a pane switch is a different lineage");
});

test("a finding from another scope is never adopted by this one", () => {
  const cross = reanchorFindings(null, diff(), "uncommitted:combined", [
    finding({ findingId: "branch-scoped", scope: "all_branch", diffHash: HASH_B }),
  ]);
  assert.deepEqual([...cross.anchored], []);
});

test("re-anchoring is idempotent in its own output, so it is safe to run during render", () => {
  const first = reanchorFindings(null, diff(), "uncommitted:combined", [finding()]);
  const moved = reanchorFindings(first, diff({ diffHash: HASH_B }), "uncommitted:combined", [finding()]);
  const again = reanchorFindings(moved, diff({ diffHash: HASH_B }), "uncommitted:combined", [finding()]);
  assert.deepEqual([...again.anchored], [...moved.anchored]);
  assert.equal(again.index, moved.index, "an unchanged hash reuses the index instead of rebuilding it");
});

test("a finding created after a refresh anchors without resurrecting a stale sibling", () => {
  const first = reanchorFindings(null, diff(), "uncommitted:combined", [finding()]);
  const rewritten = diff({
    diffHash: HASH_B,
    files: [file({ hunks: [hunk({ lines: [{ status: "+", text: "rewritten" }] })] })],
  });
  const stale = reanchorFindings(first, rewritten, "uncommitted:combined", [finding()]);
  assert.deepEqual([...stale.anchored], []);
  const withNew = reanchorFindings(stale, rewritten, "uncommitted:combined", [
    finding(),
    finding({ findingId: "f2", diffHash: HASH_B, line: 10 }),
  ]);
  assert.deepEqual([...withNew.anchored], ["f2"], "the new finding anchors; the stale one stays stale");
});

/* -------------------------------------------------------------------------- */
/* Change-set signature (#1204)                                              */
/* -------------------------------------------------------------------------- */

function status(over: Partial<GitStatusInfo> = {}): GitStatusInfo {
  return {
    branch: "agent/s1",
    files: [{ status: "M", path: "src/a.ts" }],
    hasChanges: true,
    ahead: 0,
    remoteUrl: null,
    headSha: "abc1234",
    stagedCount: 0,
    addedLines: 3,
    deletedLines: 1,
    ...over,
  };
}

test("an unobserved status is null, and a repeated observation of the same change set is equal", () => {
  assert.equal(changeSetSignature(null), null);
  assert.equal(changeSetSignature(undefined), null);
  // The ordinary 60s poll must cost no diff request when nothing moved.
  assert.equal(changeSetSignature(status()), changeSetSignature(status()));
});

test("the signature moves for every change the header or the file list would show", () => {
  const base = changeSetSignature(status());
  const cases: Array<[string, GitStatusInfo]> = [
    ["a new file", status({ files: [{ status: "M", path: "src/a.ts" }, { status: "??", path: "src/new.ts" }] })],
    ["a file's status", status({ files: [{ status: "A", path: "src/a.ts" }] })],
    ["a file's path", status({ files: [{ status: "M", path: "src/b.ts" }] })],
    ["staging", status({ stagedCount: 1 })],
    ["line totals", status({ addedLines: 4 })],
    ["deleted totals", status({ deletedLines: 2 })],
    ["a commit", status({ ahead: 1 })],
    ["a new HEAD", status({ headSha: "def5678" })],
    ["a branch switch", status({ branch: "main" })],
    ["a cleaned worktree", status({ files: [], hasChanges: false })],
    ["truncation", status({ filesTruncated: true })],
  ];
  for (const [label, moved] of cases) {
    assert.notEqual(changeSetSignature(moved), base, label);
  }
});

test("the signature cannot be forged across the file list join", () => {
  assert.notEqual(
    changeSetSignature(status({ files: [{ status: "M", path: "a" }, { status: "M", path: "b" }] })),
    changeSetSignature(status({ files: [{ status: "M", path: "a\u0000M" }, { status: "", path: "b" }] })),
  );
});
