import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitDiffFile, GitDiffInfo, GitHunk, GitStatusInfo, ReviewFinding } from "@wollipog/protocol";
import {
  buildDiffAnchorIndex,
  changeSetSignature,
  diffAnchorKey,
  diffHunkContentKey,
  EMPTY_FINDING_ANCHOR_STORE,
  reanchorFindingStore,
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
/* Per-hunk content keys (hunk identity)                                      */
/* -------------------------------------------------------------------------- */

test("a hunk's content key ignores staging, so staging it cannot rebuild the hunk in hand", () => {
  // The bug this pins: `staged` flips without a single line of the combined diff changing, and
  // keying on anything that sees the flag rebuilds the hunk mid-interaction (#1203).
  assert.equal(diffHunkContentKey(hunk({ staged: false })), diffHunkContentKey(hunk({ staged: true })));
});

test("a hunk's content key changes for every edit that renumbers or rewrites it", () => {
  const base = diffHunkContentKey(hunk());
  const cases: Array<[string, GitHunk]> = [
    ["line text", hunk({ lines: [{ status: "+", text: "different" }] })],
    ["line status", hunk({ lines: [{ status: "-", text: "context" }] })],
    ["header", hunk({ header: "@@ -99,3 +99,3 @@" })],
    ["line count", hunk({ lines: [{ status: " ", text: "context" }] })],
  ];
  for (const [label, changed] of cases) {
    assert.notEqual(diffHunkContentKey(changed), base, label);
  }
});

test("distinct hunks of one file never share a content key, because the header carries their span", () => {
  // React keys only need to be unique among siblings, and siblings are one file's hunks. Two hunks
  // with identical BODIES still differ, because `@@ -a,b +c,d @@` differs.
  const body = [{ status: "+" as const, text: "same" }];
  assert.notEqual(
    diffHunkContentKey(hunk({ header: "@@ -1,1 +1,1 @@", lines: body })),
    diffHunkContentKey(hunk({ header: "@@ -9,1 +9,1 @@", lines: body })),
  );
});

test("a hunk's content key cannot be re-cut across its fields", () => {
  // Folding fields without a terminator makes "ab"+"c" and "a"+"bc" the same digest.
  assert.notEqual(
    diffHunkContentKey(hunk({ lines: [{ status: " ", text: "ab" }, { status: " ", text: "c" }] })),
    diffHunkContentKey(hunk({ lines: [{ status: " ", text: "a" }, { status: " ", text: "bc" }] })),
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
/* Re-anchoring with no client-side history (#1286)                           */
/* -------------------------------------------------------------------------- */

/** What a reload leaves behind: the stored findings, the current diff, and no carried state. */
const RELOADED = null;

test("a reloaded client re-anchors a finding from the line text stored on it", () => {
  // The reported failure: after a reload the client holds no previous index, so the carry chain of
  // #1203 has nothing to walk and every finding falls back to hash equality. The line the finding
  // was written against is byte-identical here, so it must stay anchored (#1286).
  const state = reanchorFindings(RELOADED, diff({ diffHash: HASH_B }), "uncommitted:combined", [
    finding({ anchorText: "after" }),
  ]);
  assert.deepEqual([...state.anchored], ["f1"]);
});

test("a reloaded client still calls a rewritten line stale", () => {
  const rewritten = diff({
    diffHash: HASH_B,
    files: [file({ hunks: [hunk({ lines: [
      { status: " ", text: "context" },
      { status: "-", text: "before" },
      { status: "+", text: "rewritten" },
      { status: " ", text: "tail" },
    ] })] })],
  });
  const state = reanchorFindings(RELOADED, rewritten, "uncommitted:combined", [finding({ anchorText: "after" })]);
  assert.deepEqual([...state.anchored], [], "line 11 no longer holds the reviewed text");
});

test("stored line text is matched at the finding's own anchor, never wherever the text turns up", () => {
  // Same content, different line: re-attaching there would move the comment onto code nobody
  // reviewed. File, side and line stay part of the identity; the text only proves it is unchanged.
  const moved = diff({
    diffHash: HASH_B,
    files: [file({ hunks: [hunk({
      header: "@@ -40,3 +40,3 @@", oldStart: 40, newStart: 40,
      lines: [{ status: " ", text: "context" }, { status: "+", text: "after" }],
    })] })],
  });
  const state = reanchorFindings(RELOADED, moved, "uncommitted:combined", [finding({ anchorText: "after" })]);
  assert.deepEqual([...state.anchored], []);
});

test("an empty anchored line is anchorable content, not a missing anchor", () => {
  const blank = diff({
    diffHash: HASH_B,
    files: [file({ hunks: [hunk({ lines: [{ status: " ", text: "context" }, { status: "+", text: "" }] })] })],
  });
  assert.deepEqual(
    [...reanchorFindings(RELOADED, blank, "uncommitted:combined", [finding({ anchorText: "" })]).anchored],
    ["f1"],
  );
  // And a stored blank must not anchor onto a line that simply is not in the diff at all.
  assert.deepEqual(
    [...reanchorFindings(RELOADED, diff({ diffHash: HASH_B, files: [] }), "uncommitted:combined", [
      finding({ anchorText: "" }),
    ]).anchored],
    [],
  );
});

test("a finding written before the field existed keeps the carried-history behaviour", () => {
  // Existing findings have no stored text. They must keep working exactly as they did: anchored
  // while this client can carry the chain, stale after a reload that leaves it nothing to carry.
  const carried = reanchorFindings(
    reanchorFindings(null, diff(), "uncommitted:combined", [finding()]),
    diff({ diffHash: HASH_B }), "uncommitted:combined", [finding()],
  );
  assert.deepEqual([...carried.anchored], ["f1"]);
  const reloaded = reanchorFindings(RELOADED, diff({ diffHash: HASH_B }), "uncommitted:combined", [finding()]);
  assert.deepEqual([...reloaded.anchored], [], "today's behaviour, unchanged, for a finding with no stored text");
});

test("the verdict on a stored anchor is the same with and without client-side history", () => {
  // The invariant that makes a reload boring: stored text is asked of the diff directly, so a
  // carried chain can neither rescue a changed line nor condemn an unchanged one.
  const stored = [finding({ anchorText: "after" })];
  const rewritten = diff({
    diffHash: HASH_B,
    files: [file({ hunks: [hunk({ lines: [
      { status: " ", text: "context" },
      { status: "+", text: "rewritten" },
    ] })] })],
  });
  const carried = reanchorFindings(null, diff(), "uncommitted:combined", stored);
  for (const [label, next] of [["unchanged", diff({ diffHash: HASH_B })], ["rewritten", rewritten]] as const) {
    assert.deepEqual(
      [...reanchorFindings(carried, next, "uncommitted:combined", stored).anchored],
      [...reanchorFindings(RELOADED, next, "uncommitted:combined", stored).anchored],
      label,
    );
  }
  // A line edited and then restored is once again the reviewed content, so it anchors again — which
  // is the only verdict a reloaded client could reach, and therefore the one both must reach. The
  // restored change set needs its own hash: an unchanged hash legitimately reuses the cached index.
  const away = reanchorFindings(carried, rewritten, "uncommitted:combined", stored);
  const restored = diff({ diffHash: "c".repeat(64) });
  assert.deepEqual([...reanchorFindings(away, restored, "uncommitted:combined", stored).anchored], ["f1"]);
  assert.deepEqual([...reanchorFindings(RELOADED, restored, "uncommitted:combined", stored).anchored], ["f1"]);
});

test("for a stored anchor, identical content replaces pane-locality as the guard", () => {
  // Pane-locality existed because a line NUMBER means different content in different panes. A
  // stored anchor compares the content itself, so a pane that shows byte-identical text at the same
  // file, side and line is showing exactly what was reviewed, and the finding renders there.
  //
  // This is not an optional relaxation: after a reload the pane resets to combined, and a finding
  // authored in the staged pane has no pane recorded to restrict it to. Restricting by pane would
  // reinstate the reported bug on the very view the reviewer lands on.
  const first = reanchorFindings(null, diff(), "uncommitted:unstaged", [finding({ anchorText: "after" })]);
  const other = reanchorFindings(first, diff({ diffHash: HASH_B }), "uncommitted:staged", [
    finding({ anchorText: "after" }),
  ]);
  assert.deepEqual([...other.anchored], ["f1"]);
  // A different scope is still never adopted: `scope` is recorded on the finding, and the lineage
  // it is being asked about is not the one it belongs to.
  const crossScope = reanchorFindings(null, diff(), "uncommitted:combined", [
    finding({ scope: "all_branch", diffHash: HASH_B, anchorText: "after" }),
  ]);
  assert.deepEqual([...crossScope.anchored], []);
});

/* -------------------------------------------------------------------------- */
/* Per-lineage anchor store                                                   */
/* -------------------------------------------------------------------------- */

const COMBINED = "uncommitted:combined";
const STAGED = "uncommitted:staged";

test("a lineage keeps what it carried while the reviewer is away in another pane", () => {
  // The single-slot bug: combined@H1 -> combined@H2 -> staged -> combined@H2. With one slot, the
  // staged visit overwrites the carry, and returning to an UNCHANGED H2 reports the finding stale
  // because its own authoring hash is H1.
  let store = reanchorFindingStore(EMPTY_FINDING_ANCHOR_STORE, diff(), COMBINED, [finding()]);
  const h2 = diff({ diffHash: HASH_B });
  store = reanchorFindingStore(store, h2, COMBINED, [finding()]);
  assert.deepEqual([...store.get(COMBINED)!.anchored], ["f1"]);

  store = reanchorFindingStore(store, diff({ diffHash: "c".repeat(64) }), STAGED, [finding()]);
  assert.deepEqual([...store.get(STAGED)!.anchored], [], "the other pane never adopts it");

  store = reanchorFindingStore(store, h2, COMBINED, [finding()]);
  assert.deepEqual([...store.get(COMBINED)!.anchored], ["f1"],
    "returning to an unchanged lineage must not invent a stale anchor");
});

test("the store is returned unchanged when nothing observable moved, so render-time commits settle", () => {
  // Load-bearing for the caller: it derives this during render and commits it with setState, so a
  // fresh Map for an unchanged result would re-render forever.
  const first = reanchorFindingStore(EMPTY_FINDING_ANCHOR_STORE, diff(), COMBINED, [finding()]);
  assert.notEqual(first, EMPTY_FINDING_ANCHOR_STORE);
  assert.equal(reanchorFindingStore(first, diff(), COMBINED, [finding()]), first);
  // Same for a lineage that has carried an anchor across a hash change and is then re-derived.
  const moved = reanchorFindingStore(first, diff({ diffHash: HASH_B }), COMBINED, [finding()]);
  assert.notEqual(moved, first);
  assert.equal(reanchorFindingStore(moved, diff({ diffHash: HASH_B }), COMBINED, [finding()]), moved);
});

test("the store changes identity whenever a finding's anchoring actually changes", () => {
  const first = reanchorFindingStore(EMPTY_FINDING_ANCHOR_STORE, diff(), COMBINED, [finding()]);
  const rewritten = diff({
    diffHash: HASH_B,
    files: [file({ hunks: [hunk({ lines: [{ status: "+", text: "rewritten" }] })] })],
  });
  const stale = reanchorFindingStore(first, rewritten, COMBINED, [finding()]);
  assert.notEqual(stale, first);
  assert.deepEqual([...stale.get(COMBINED)!.anchored], []);
  // And a new finding appearing under an unchanged diff must still be picked up.
  const withNew = reanchorFindingStore(stale, rewritten, COMBINED, [
    finding(),
    finding({ findingId: "f2", diffHash: HASH_B, line: 1 }),
  ]);
  assert.notEqual(withNew, stale);
  assert.deepEqual([...withNew.get(COMBINED)!.anchored], ["f2"]);
});

test("a freshly loaded store anchors stored findings on its very first derivation", () => {
  // What the panel actually does after a reload: it starts from the empty store and derives during
  // its first render. Nothing is carried, so this is the path #1286 reported as broken — and the
  // one that must now anchor without ever painting a stale frame to correct afterwards.
  const stored = [finding({ anchorText: "after" }), finding({ findingId: "f2", line: 10, anchorText: "context" })];
  const store = reanchorFindingStore(EMPTY_FINDING_ANCHOR_STORE, diff({ diffHash: HASH_B }), COMBINED, stored);
  assert.deepEqual([...store.get(COMBINED)!.anchored].sort(), ["f1", "f2"]);
  // And it settles immediately: the caller commits this with setState during render, so a second
  // derivation of the same inputs has to return the same store or the render loops.
  assert.equal(reanchorFindingStore(store, diff({ diffHash: HASH_B }), COMBINED, stored), store);
});

test("each lineage in the store is independent, and lineages are bounded by scope times pane", () => {
  let store: ReturnType<typeof reanchorFindingStore> = EMPTY_FINDING_ANCHOR_STORE;
  for (const lineage of [COMBINED, STAGED, "uncommitted:unstaged", "all_branch:combined", "last_turn:combined"]) {
    store = reanchorFindingStore(store, diff(), lineage, [finding()]);
  }
  assert.equal(store.size, 5);
  for (const lineage of store.keys()) {
    assert.equal(store.get(lineage)!.lineage, lineage);
  }
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
