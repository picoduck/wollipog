/**
 * Real-git integration tests for PR-B per-hunk staging + the last_turn scope. A throwaway repo
 * stands in for a session worktree (ctx.useWorktree=false skips the linked-worktree assertion).
 * Skips gracefully when `git` isn't available.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitOpError, captureWorktreeTree, commitAll, discardFile, gitDiff, runGitAction, stageHunk, stageLines } from "./git-ops.js";
import { worktreeDiff } from "./worktree.js";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const GIT = gitAvailable();
const CTX = { useWorktree: false };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo(cwd: string): void {
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  git(cwd, ["config", "core.autocrlf", "false"]);
}

/** A 12-line file whose top and bottom edits produce two separate hunks at unified=3. */
const BASE = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
const EDITED = BASE.replace("line2", "TOP-EDIT").replace("line11", "BOTTOM-EDIT");

function seedTwoHunkRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-stage-"));
  initRepo(repo);
  writeFileSync(join(repo, "f.txt"), BASE);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "baseline"]);
  writeFileSync(join(repo, "f.txt"), EDITED);
  return repo;
}

test("stageHunk (real git): stages one hunk into the index; the second stages with the ORIGINAL hash", { skip: !GIT }, async () => {
  const repo = seedTwoHunkRepo();
  try {
    const before = await gitDiff(repo, "uncommitted", CTX);
    assert.equal(before.files[0]!.hunks.length, 2);
    assert.equal(before.files[0]!.hunks[0]!.staged, undefined);

    const afterFirst = await stageHunk(repo, { direction: "stage", filePath: "f.txt", hunkIndex: 0, diffHash: before.diffHash }, CTX);
    // The index holds ONLY the first hunk's change.
    const cached = git(repo, ["diff", "--cached"]);
    assert.ok(cached.includes("+TOP-EDIT"), "hunk 0 staged");
    assert.ok(!cached.includes("BOTTOM-EDIT"), "hunk 1 not staged");
    // The worktree-vs-HEAD diff (and so the hash) is unchanged — staging doesn't touch the worktree.
    assert.equal(afterFirst.diff!.diffHash, before.diffHash);
    assert.equal(afterFirst.diff!.files[0]!.hunks[0]!.staged, true, "hunk 0 marked staged");
    assert.equal(afterFirst.diff!.files[0]!.hunks[1]!.staged, undefined, "hunk 1 unmarked");
    assert.equal(afterFirst.status!.stagedCount, 1);

    // The offset case: hunk 1's patch still applies against the ORIGINAL identity.
    const afterSecond = await stageHunk(repo, { direction: "stage", filePath: "f.txt", hunkIndex: 1, diffHash: before.diffHash }, CTX);
    assert.ok(git(repo, ["diff", "--cached"]).includes("+BOTTOM-EDIT"));
    assert.equal(afterSecond.diff!.files[0]!.hunks[1]!.staged, true);

    // Re-staging an already-staged hunk converges silently.
    const noop = await stageHunk(repo, { direction: "stage", filePath: "f.txt", hunkIndex: 0, diffHash: before.diffHash }, CTX);
    assert.equal(noop.diff!.files[0]!.hunks[0]!.staged, true);

    // Unstage round-trip empties the index.
    await stageHunk(repo, { direction: "unstage", filePath: "f.txt", hunkIndex: 0, diffHash: before.diffHash }, CTX);
    await stageHunk(repo, { direction: "unstage", filePath: "f.txt", hunkIndex: 1, diffHash: before.diffHash }, CTX);
    assert.equal(git(repo, ["diff", "--cached"]), "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("stageHunk (real git): an external edit invalidates the hash — GIT_STALE, index untouched", { skip: !GIT }, async () => {
  const repo = seedTwoHunkRepo();
  try {
    const before = await gitDiff(repo, "uncommitted", CTX);
    writeFileSync(join(repo, "f.txt"), EDITED.replace("line6", "MID-EDIT"));
    await assert.rejects(
      () => stageHunk(repo, { direction: "stage", filePath: "f.txt", hunkIndex: 0, diffHash: before.diffHash }, CTX),
      (err: unknown) => err instanceof GitOpError && err.code === "GIT_STALE",
    );
    assert.equal(git(repo, ["diff", "--cached"]), "", "index untouched");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("stageLines + discardFile (real git): one replacement pair moves between canonical panes and discard restores HEAD", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-lines-"));
  try {
    initRepo(repo);
    const path = join(repo, "a.txt");
    writeFileSync(path, "one\ntwo\nthree\nfour\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-qm", "base"]);
    writeFileSync(path, "ONE\nTWO\nthree\nfour\n");

    const before = await gitDiff(repo, "uncommitted", CTX);
    assert.equal(before.stagedFiles?.length, 0);
    const hunk = before.unstagedFiles?.[0]?.hunks[0];
    assert.ok(hunk);
    const firstPair = hunk.lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => (line.status === "-" && line.text === "one") || (line.status === "+" && line.text === "ONE"))
      .map(({ index }) => index);
    assert.equal(firstPair.length, 2);

    const staged = await stageLines(repo, {
      direction: "stage", filePath: "a.txt", hunkIndex: 0, lineIndices: firstPair, diffHash: before.fineDiffHash!,
    }, CTX);
    assert.match(git(repo, ["diff", "--cached", "--", "a.txt"]), /ONE/);
    assert.doesNotMatch(git(repo, ["diff", "--cached", "--", "a.txt"]), /TWO/);
    assert.match(git(repo, ["diff", "--", "a.txt"]), /TWO/);

    const stagedDiff = staged.diff!;
    const stagedHunk = stagedDiff.stagedFiles?.[0]?.hunks[0];
    assert.ok(stagedHunk);
    const stagedIndices = stagedHunk.lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.status !== " ")
      .map(({ index }) => index);
    const unstaged = await stageLines(repo, {
      direction: "unstage", filePath: "a.txt", hunkIndex: 0, lineIndices: stagedIndices, diffHash: stagedDiff.fineDiffHash!,
    }, CTX);
    assert.equal(git(repo, ["diff", "--cached", "--", "a.txt"]), "");

    await discardFile(repo, { filePath: "a.txt", diffHash: unstaged.diff!.fineDiffHash! }, CTX);
    assert.equal(git(repo, ["status", "--porcelain"]), "");
    assert.equal(readFileSync(path, "utf8"), "one\ntwo\nthree\nfour\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("stageLines (real git): partial unstage preserves unselected additions and deletions in one hunk", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-partial-unstage-"));
  try {
    initRepo(repo);
    const path = join(repo, "a.txt");
    writeFileSync(path, "one\ntwo\nthree\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-qm", "base"]);
    writeFileSync(path, "ONE\ntwo\nadded\nthree\n");
    git(repo, ["add", "a.txt"]);

    const before = await gitDiff(repo, "uncommitted", CTX);
    const hunk = before.stagedFiles?.[0]?.hunks[0];
    assert.ok(hunk);
    const selected = hunk.lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.status === "+" && line.text === "ONE")
      .map(({ index }) => index);
    assert.equal(selected.length, 1);

    await stageLines(repo, {
      direction: "unstage", filePath: "a.txt", hunkIndex: 0,
      lineIndices: selected, diffHash: before.fineDiffHash!,
    }, CTX);

    const cached = git(repo, ["diff", "--cached", "--", "a.txt"]);
    assert.match(cached, /^-one$/m, "the unselected deletion remains staged");
    assert.match(cached, /^\+added$/m, "the unselected addition remains staged");
    assert.doesNotMatch(cached, /^\+ONE$/m, "the selected addition was unstaged");
    assert.match(git(repo, ["diff", "--", "a.txt"]), /^\+ONE$/m, "the selected line moved to the worktree pane");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("stageLines (real git): context-free deletion emits a valid zero-count partial patch", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-zero-count-"));
  try {
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "old\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-qm", "base"]);
    writeFileSync(join(repo, "a.txt"), "new\n");

    const before = await gitDiff(repo, "uncommitted", CTX);
    const hunk = before.unstagedFiles?.[0]?.hunks[0];
    assert.ok(hunk);
    assert.equal(hunk.lines.some((line) => line.status === " "), false, "fixture has no context lines");
    const deletion = hunk.lines.findIndex((line) => line.status === "-");
    assert.ok(deletion >= 0);
    await stageLines(repo, {
      direction: "stage", filePath: "a.txt", hunkIndex: 0,
      lineIndices: [deletion], diffHash: before.fineDiffHash!,
    }, CTX);

    assert.match(git(repo, ["diff", "--cached", "--", "a.txt"]), /^-old$/m);
    assert.equal(git(repo, ["show", ":a.txt"]), "", "the selected deletion alone is staged");
    assert.match(git(repo, ["diff", "--", "a.txt"]), /^\+new$/m, "the unselected addition remains unstaged");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("discardFile (real git): restores renames and staged additions, but never deletes untracked content", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-discard-"));
  try {
    initRepo(repo);
    writeFileSync(join(repo, "old.txt"), "original\n");
    git(repo, ["add", "old.txt"]);
    git(repo, ["commit", "-qm", "base"]);

    git(repo, ["mv", "old.txt", "new.txt"]);
    let diff = await gitDiff(repo, "uncommitted", CTX);
    await discardFile(repo, { filePath: "new.txt", diffHash: diff.fineDiffHash! }, CTX);
    assert.equal(readFileSync(join(repo, "old.txt"), "utf8"), "original\n");
    assert.equal(existsSync(join(repo, "new.txt")), false);
    assert.equal(git(repo, ["status", "--porcelain"]), "");

    writeFileSync(join(repo, "added.txt"), "staged addition\n");
    git(repo, ["add", "added.txt"]);
    diff = await gitDiff(repo, "uncommitted", CTX);
    await discardFile(repo, { filePath: "added.txt", diffHash: diff.fineDiffHash! }, CTX);
    assert.equal(existsSync(join(repo, "added.txt")), false);
    assert.equal(git(repo, ["status", "--porcelain"]), "");

    writeFileSync(join(repo, "untracked.txt"), "not reviewed bytes\n");
    diff = await gitDiff(repo, "uncommitted", CTX);
    await assert.rejects(
      () => discardFile(repo, { filePath: "untracked.txt", diffHash: diff.fineDiffHash! }, CTX),
      /untracked files cannot be discarded/,
    );
    assert.equal(readFileSync(join(repo, "untracked.txt"), "utf8"), "not reviewed bytes\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("discardFile (real git): removes a force-added ignored file after resetting the index", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-discard-ignored-"));
  try {
    initRepo(repo);
    writeFileSync(join(repo, ".gitignore"), "dist/\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-qm", "ignore dist"]);
    mkdirSync(join(repo, "dist"));
    writeFileSync(join(repo, "dist", "generated.js"), "generated\n");
    git(repo, ["add", "-f", "dist/generated.js"]);

    const before = await gitDiff(repo, "uncommitted", CTX);
    await discardFile(repo, { filePath: "dist/generated.js", diffHash: before.fineDiffHash! }, CTX);
    assert.equal(existsSync(join(repo, "dist", "generated.js")), false);
    assert.equal(git(repo, ["status", "--porcelain"]), "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("commitAll (real git): a partial stage commits ONLY the staged hunk; the worktree stays dirty", { skip: !GIT }, async () => {
  const repo = seedTwoHunkRepo();
  try {
    const before = await gitDiff(repo, "uncommitted", CTX);
    await stageHunk(repo, { direction: "stage", filePath: "f.txt", hunkIndex: 0, diffHash: before.diffHash }, CTX);

    const info = await commitAll(repo, "top edit only");
    assert.equal(info.stagedOnly, true);
    const committed = git(repo, ["show", "HEAD:f.txt"]);
    assert.ok(committed.includes("TOP-EDIT"), "staged hunk committed");
    assert.ok(!committed.includes("BOTTOM-EDIT"), "unstaged hunk NOT committed");
    const remaining = await gitDiff(repo, "uncommitted", CTX);
    assert.equal(remaining.files.length, 1, "worktree still dirty with the bottom edit");
    assert.notEqual(remaining.diffHash, before.diffHash, "identity moved with HEAD");

    // The pre-commit hash is now stale for staging.
    await assert.rejects(
      () => stageHunk(repo, { direction: "stage", filePath: "f.txt", hunkIndex: 0, diffHash: before.diffHash }, CTX),
      (err: unknown) => err instanceof GitOpError && err.code === "GIT_STALE",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("stageHunk (real git): unstaging an added file's only hunk turns it untracked and changes the hash", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-stage-add-"));
  try {
    initRepo(repo);
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "baseline"]);
    writeFileSync(join(repo, "new.txt"), "brand new\n");
    git(repo, ["add", "new.txt"]); // staged add → shows as one 'added' hunk in diff HEAD

    const before = await gitDiff(repo, "uncommitted", CTX);
    const added = before.files.find((f) => f.path === "new.txt")!;
    assert.equal(added.status, "added");
    assert.equal(added.hunks[0]!.staged, true, "the staged add is marked");

    const after = await stageHunk(repo, { direction: "unstage", filePath: "new.txt", hunkIndex: 0, diffHash: before.diffHash }, CTX);
    const nowUntracked = after.diff!.files.find((f) => f.path === "new.txt")!;
    assert.equal(nowUntracked.status, "untracked", "left the index — now untracked");
    assert.notEqual(after.diff!.diffHash, before.diffHash, "raw shrank + manifest grew");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("last_turn (real git): shows exactly the turn's changes; untouched pre-existing untracked files stay out", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-lastturn-"));
  try {
    initRepo(repo);
    git(repo, ["config", "core.trustctime", "false"]);
    const trackedPath = join(repo, "tracked.txt");
    writeFileSync(trackedPath, "v1\n");
    writeFileSync(join(repo, "doomed.txt"), "delete me\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "baseline"]);
    // Put the cached entry and real index on the exact same timestamp. With ctime deliberately
    // ignored, rewriting the same-size file onto this timestamp exercises Git's racy-clean guard
    // deterministically instead of depending on the CI filesystem's timestamp granularity.
    const racyTime = new Date(1_700_000_000_000);
    utimesSync(trackedPath, racyTime, racyTime);
    git(repo, ["update-index", "--refresh"]);
    utimesSync(join(repo, ".git", "index"), racyTime, racyTime);
    writeFileSync(join(repo, "pre-untracked.txt"), "was here before the turn\n");
    writeFileSync(join(repo, "pre-edited.txt"), "untracked v1\n");

    // Mirror production status reads: optional-lock suppression keeps the deliberately racy index
    // timestamp intact instead of letting an observation rewrite the fixture's cache metadata.
    const porcelainBefore = git(repo, ["--no-optional-locks", "status", "--porcelain"]);
    const snap = await captureWorktreeTree(repo);
    assert.equal(git(repo, ["--no-optional-locks", "status", "--porcelain"]), porcelainBefore, "capture leaves the real index untouched");

    // "The turn": modify tracked, edit a pre-existing untracked file, create a file, delete one.
    writeFileSync(trackedPath, "v2\n");
    utimesSync(trackedPath, racyTime, racyTime);
    writeFileSync(join(repo, "pre-edited.txt"), "untracked v2\n");
    writeFileSync(join(repo, "born-this-turn.txt"), "new content\n");
    rmSync(join(repo, "doomed.txt"));

    const info = await gitDiff(repo, "last_turn", { useWorktree: false, lastTurnBaseTree: snap });
    const byPath = new Map(info.files.map((f) => [f.path, f]));
    assert.equal(byPath.get("tracked.txt")?.status, "modified");
    assert.equal(byPath.get("pre-edited.txt")?.status, "modified", "untracked edit shows with real hunks");
    assert.ok(byPath.get("pre-edited.txt")!.hunks.length > 0);
    assert.equal(byPath.get("born-this-turn.txt")?.status, "added");
    assert.equal(byPath.get("doomed.txt")?.status, "deleted");
    assert.ok(!byPath.has("pre-untracked.txt"), "untouched pre-existing untracked file is NOT listed");
    assert.equal(info.files.length, 4);
    assert.equal(git(repo, ["status", "--porcelain"]).includes("pre-untracked.txt"), true, "still untracked on disk");

    // A commit mid-"turn" keeps the last_turn view while the uncommitted view empties.
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "turn work"]);
    const after = await gitDiff(repo, "last_turn", { useWorktree: false, lastTurnBaseTree: snap });
    assert.equal(after.files.length, 4, "last_turn still shows the turn's changes after a commit");
    const uncommitted = await gitDiff(repo, "uncommitted", CTX);
    assert.equal(uncommitted.files.length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("last_turn (real git): an empty turn yields no files and a stable hash", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-lastturn-empty-"));
  try {
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "baseline"]);
    const snap = await captureWorktreeTree(repo);
    const one = await gitDiff(repo, "last_turn", { useWorktree: false, lastTurnBaseTree: snap });
    const two = await gitDiff(repo, "last_turn", { useWorktree: false, lastTurnBaseTree: snap });
    assert.deepEqual(one.files, []);
    assert.equal(one.diffHash, two.diffHash);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktreeDiff (real git): captures tracked + untracked changes without touching the real index", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-wtdiff-"));
  try {
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "baseline"]);
    writeFileSync(join(repo, "a.txt"), "two\n");
    writeFileSync(join(repo, "new.txt"), "fresh\n");

    const diff = await worktreeDiff(repo);
    assert.ok(diff.includes("+two"), "tracked change captured");
    assert.ok(diff.includes("new.txt"), "untracked file captured");
    assert.equal(git(repo, ["diff", "--cached"]), "", "real index untouched (no add -A side effect)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("stageHunk (real git): staging an added-then-edited file succeeds via git add", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-stage-addedit-"));
  try {
    initRepo(repo);
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "baseline"]);
    writeFileSync(join(repo, "new.txt"), "v1\n");
    git(repo, ["add", "new.txt"]);
    writeFileSync(join(repo, "new.txt"), "v2 edited after add\n"); // index holds v1, worktree v2

    const before = await gitDiff(repo, "uncommitted", CTX);
    const added = before.files.find((f) => f.path === "new.txt")!;
    assert.equal(added.status, "added");
    assert.equal(added.hunks[0]!.staged, undefined, "index copy differs from worktree — not staged");

    // `git apply --cached` would refuse the new-file patch ("already exists in index"); the
    // added-file path must go through `git add` instead and stage the WORKTREE content.
    const after = await stageHunk(repo, { direction: "stage", filePath: "new.txt", hunkIndex: 0, diffHash: before.diffHash }, CTX);
    assert.equal(after.diff!.files.find((f) => f.path === "new.txt")!.hunks[0]!.staged, true);
    assert.ok(git(repo, ["diff", "--cached"]).includes("+v2 edited after add"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("captureWorktreeTree (real git): force-added ignored files stay in the snapshot", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-forceadd-"));
  try {
    initRepo(repo);
    writeFileSync(join(repo, ".gitignore"), "dist/\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "baseline"]);
    mkdirSync(join(repo, "dist"));
    writeFileSync(join(repo, "dist", "x.js"), "artifact\n");
    git(repo, ["add", "-f", "dist/x.js"]); // tracked in the REAL index, invisible to a HEAD-seeded add -A

    const tree = await captureWorktreeTree(repo);
    const listed = git(repo, ["ls-tree", "-r", "--name-only", tree]);
    assert.ok(listed.includes("dist/x.js"), "force-added ignored file captured (index-copy seed)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("commitAll (real git): expectStaged guard via runGitAction is exercised end-to-end", { skip: !GIT }, async () => {
  // runGitAction asserts a LINKED worktree, so run inside a real one (like production sessions).
  const repo = seedTwoHunkRepo();
  try {
    const wt = join(repo, ".agent-worktrees", "s1");
    git(repo, ["worktree", "add", "-q", "-B", "agent/s1", wt, "HEAD"]);
    writeFileSync(join(wt, "f.txt"), EDITED);

    const before = await gitDiff(wt, "uncommitted", { useWorktree: true });
    await stageHunk(wt, { direction: "stage", filePath: "f.txt", hunkIndex: 0, diffHash: before.diffHash }, { useWorktree: true });
    // Panel believed nothing was staged (stale snapshot) — the commit must refuse.
    await assert.rejects(
      () => runGitAction(wt, { kind: "commit", message: "m", expectStaged: false }, { useWorktree: true }),
      (err: unknown) => err instanceof GitOpError && err.code === "GIT_STALE",
    );
    // Correct belief commits the staged subset.
    const data = await runGitAction(wt, { kind: "commit", message: "m", expectStaged: true }, { useWorktree: true });
    assert.equal(data.commit!.stagedOnly, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
