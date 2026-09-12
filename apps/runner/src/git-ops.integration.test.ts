/**
 * Real-git integration test for gitDiff. Initializes a throwaway repo, commits a baseline, edits a
 * file, and asserts the parsed file/hunk shape plus a deterministic diffHash. The whole suite skips
 * gracefully when `git` isn't available (CI images without git, sandboxes) rather than failing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptLegacyCheckpointRefs, anchorForkRef, anchorTurnRef, captureWorktreeTree, clearGhPrCacheForTests, computeDiffHash, deleteTurnRef, deleteTurnRefs, gitDiff, gitStatus, gitSummary, readTurnRef, restoreWorktreeToTree, runPodReconcile, synchronizeCheckpointRefs } from "./git-ops.js";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const GIT = gitAvailable();

/** Run git in `cwd`, returning stdout (throws on non-zero, like production `git()`). */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Init a repo with a deterministic identity + config so diff output is stable across environments. */
function initRepo(cwd: string): void {
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  git(cwd, ["config", "core.autocrlf", "false"]);
}

function usesLooseRefFiles(cwd: string): boolean {
  try {
    return git(cwd, ["rev-parse", "--show-ref-format"]).trim() === "files";
  } catch {
    // Git versions predating reftable support use the files backend exclusively.
    return true;
  }
}

test("gitDiff (real git): uncommitted diff of a modified file has the right shape + a stable hash", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-gitdiff-"));
  try {
    initRepo(repo);
    // Baseline commit.
    writeFileSync(join(repo, "a.txt"), "line1\nline2\nline3\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "baseline"]);

    // Modify the middle line and add a brand-new untracked file.
    writeFileSync(join(repo, "a.txt"), "line1\nCHANGED\nline3\n");
    writeFileSync(join(repo, "untracked.txt"), "hello\n");

    // useWorktree=false: this is a normal repo, not a linked session worktree, so skip the
    // linked-worktree assertion (which is meant for real session worktrees).
    const info = await gitDiff(repo, "uncommitted", { useWorktree: false });

    assert.equal(info.scope, "uncommitted");

    // The tracked, modified file.
    const changed = info.files.find((f) => f.path === "a.txt");
    assert.ok(changed, "modified file is present");
    assert.equal(changed!.status, "modified");
    assert.equal(changed!.binary, false);
    assert.equal(changed!.hunks.length, 1);
    const lines = changed!.hunks[0]!.lines;
    assert.ok(lines.some((l) => l.status === "-" && l.text === "line2"), "removed old line");
    assert.ok(lines.some((l) => l.status === "+" && l.text === "CHANGED"), "added new line");
    assert.ok(lines.some((l) => l.status === " " && l.text === "line1"), "kept context line");

    // The untracked file is synthesized name-only.
    const untracked = info.files.find((f) => f.path === "untracked.txt");
    assert.ok(untracked, "untracked file is present");
    assert.equal(untracked!.status, "untracked");
    assert.deepEqual(untracked!.hunks, []);

    // Stats reflect the one changed tracked file plus the untracked one.
    assert.equal(info.stats.filesChanged, 2);
    assert.equal(info.stats.insertions, 1);
    assert.equal(info.stats.deletions, 1);

    // diffHash is a sha256 hex and is deterministic: it matches an independent hash of the same
    // `git diff` output plus the name-only untracked manifest, and repeats across calls.
    assert.match(info.diffHash, /^[0-9a-f]{64}$/);
    const rawDiff = git(repo, ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--"]);
    assert.equal(info.diffHash, computeDiffHash(`${rawDiff}?? untracked.txt\n`));
    const again = await gitDiff(repo, "uncommitted", { useWorktree: false });
    assert.equal(again.diffHash, info.diffHash);

    // An untracked-only change alters the change-set identity: removing the untracked file must
    // change the hash even though the tracked `git diff` output is byte-identical.
    rmSync(join(repo, "untracked.txt"));
    const without = await gitDiff(repo, "uncommitted", { useWorktree: false });
    assert.equal(git(repo, ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--"]), rawDiff);
    assert.notEqual(without.diffHash, info.diffHash);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("gitDiff (real git): a clean tree yields no files and empty stats", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-gitdiff-clean-"));
  try {
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "baseline"]);

    const info = await gitDiff(repo, "uncommitted", { useWorktree: false });
    assert.deepEqual(info.files, []);
    assert.deepEqual(info.stats, { filesChanged: 0, insertions: 0, deletions: 0 });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("gitStatus (real git): numstat line totals cover staged + unstaged; clean tree is 0/0", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-gitstatus-"));
  try {
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "line1\nline2\nline3\n");
    writeFileSync(join(repo, "b.txt"), "keep\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "baseline"]);

    const clean = await gitStatus(repo);
    assert.equal(clean.addedLines, 0);
    assert.equal(clean.deletedLines, 0);

    // One staged edit (+1/-1), one unstaged edit (+2/-1 on another file): totals combine both.
    writeFileSync(join(repo, "a.txt"), "line1\nCHANGED\nline3\n");
    git(repo, ["add", "a.txt"]);
    writeFileSync(join(repo, "b.txt"), "keep2\nmore\nlines\n");

    const dirty = await gitStatus(repo);
    assert.equal(dirty.addedLines, 1 + 3);
    assert.equal(dirty.deletedLines, 1 + 1);
    assert.equal(dirty.hasChanges, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("gitSummary (real git): status bits flow through; no GitHub remote → pr/checks null, never a throw", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-gitsummary-"));
  try {
    initRepo(repo);
    clearGhPrCacheForTests();
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "baseline"]);
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");

    const s = await gitSummary(repo);
    assert.equal(s.hasChanges, true);
    assert.equal(s.addedLines, 1);
    assert.equal(s.deletedLines, 0);
    assert.equal(s.behind, 0, "no base/upstream → behind is unknown ⇒ 0");
    assert.equal(s.remoteUrl, null);
    // No GitHub remote: gh pr view fails (or gh is absent) — both must degrade to nulls.
    assert.equal(s.pr, null);
    assert.equal(s.checks, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("gitSummary (real git): ahead/behind fall back to origin/main when origin/HEAD is unset", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-gitbehind-"));
  try {
    initRepo(repo);
    clearGhPrCacheForTests();
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "c1"]);
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "c2"]);
    // Simulate a clone whose default branch moved: origin/main points at c2 (no origin/HEAD,
    // no upstream), and the local checkout steps back to c1.
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(repo, ["reset", "--hard", "-q", "HEAD~1"]);

    const s = await gitSummary(repo);
    assert.equal(s.behind, 1, "origin/main-without-origin/HEAD must still count behind");
    assert.equal(s.ahead, 0, "nothing local beyond the base yet");

    // A local commit diverging from the moved base: ahead must count it (this was the gap —
    // gitStatus's ahead only knew origin/HEAD/@{upstream}, so it reported 0 and the pinned
    // summary hid the Push affordance).
    writeFileSync(join(repo, "b.txt"), "local\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "c3"]);

    const s2 = await gitSummary(repo);
    assert.equal(s2.ahead, 1, "origin/main-without-origin/HEAD must still count ahead");
    assert.equal(s2.behind, 1, "the diverged base commit stays counted");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

function seedReconciliationWorktrees(): { root: string; repo: string; source: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), "wollipog-pod-reconcile-"));
  const repo = join(root, "repo");
  const source = join(root, "source");
  const target = join(root, "target");
  mkdirSync(repo);
  initRepo(repo);
  writeFileSync(join(repo, "shared.txt"), "baseline\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "baseline"]);
  git(repo, ["branch", "source"]);
  git(repo, ["branch", "target"]);
  git(repo, ["worktree", "add", "-q", source, "source"]);
  git(repo, ["worktree", "add", "-q", target, "target"]);
  return { root, repo, source, target };
}

test("pod reconciliation (real git): creates an exact non-FF audit merge and converges on retry", { skip: !GIT }, async () => {
  const fixture = seedReconciliationWorktrees();
  try {
    writeFileSync(join(fixture.source, "source.txt"), "committed source work\n");
    git(fixture.source, ["add", "-A"]);
    git(fixture.source, ["commit", "-q", "-m", "source change"]);
    writeFileSync(join(fixture.target, "target.txt"), "independent target work\n");
    git(fixture.target, ["add", "-A"]);
    git(fixture.target, ["commit", "-q", "-m", "target change"]);
    const sourceHead = git(fixture.source, ["rev-parse", "HEAD"]).trim();
    const targetHead = git(fixture.target, ["rev-parse", "HEAD"]).trim();

    const applied = await runPodReconcile(fixture.target, fixture.source, {
      kind: "pod_reconcile",
      sourceSessionId: "source-session",
      message: "Merge source into integration target",
    });
    assert.equal(applied.status, "applied");
    assert.equal(applied.sourceHead, sourceHead);
    assert.equal(applied.targetHead, targetHead);
    assert.deepEqual(git(fixture.target, ["rev-parse", "HEAD^1", "HEAD^2"]).trim().split(/\s+/), [targetHead, sourceHead]);
    assert.equal(
      git(fixture.target, ["log", "-1", "--format=%an <%ae>"]).trim(),
      "Wollipog <wollipog@localhost>",
    );
    assert.equal(readFileSync(join(fixture.target, "source.txt"), "utf8"), "committed source work\n");
    assert.equal(git(fixture.target, ["status", "--porcelain"]), "");

    const converged = await runPodReconcile(fixture.target, fixture.source, {
      kind: "pod_reconcile",
      sourceSessionId: "source-session",
      message: "Retry the same immutable source",
    });
    assert.equal(converged.status, "already_applied");
    assert.equal(converged.resultHead, applied.resultHead);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("pod reconciliation (real git): reports conflicts only after proving the target restored clean", { skip: !GIT }, async () => {
  const fixture = seedReconciliationWorktrees();
  try {
    writeFileSync(join(fixture.source, "shared.txt"), "source version\n");
    git(fixture.source, ["add", "-A"]);
    git(fixture.source, ["commit", "-q", "-m", "source conflict"]);
    writeFileSync(join(fixture.target, "shared.txt"), "target version\n");
    git(fixture.target, ["add", "-A"]);
    git(fixture.target, ["commit", "-q", "-m", "target conflict"]);
    const targetHead = git(fixture.target, ["rev-parse", "HEAD"]).trim();

    const result = await runPodReconcile(fixture.target, fixture.source, {
      kind: "pod_reconcile",
      sourceSessionId: "source-session",
      message: "Expected conflict",
    });
    assert.equal(result.status, "conflicted");
    assert.deepEqual(result.conflictPaths, ["shared.txt"]);
    assert.equal(git(fixture.target, ["rev-parse", "HEAD"]).trim(), targetHead);
    assert.equal(git(fixture.target, ["status", "--porcelain"]), "");
    assert.equal(readFileSync(join(fixture.target, "shared.txt"), "utf8"), "target version\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("pod reconciliation (real git): rejects dirty source and target worktrees before merging", { skip: !GIT }, async () => {
  const fixture = seedReconciliationWorktrees();
  try {
    writeFileSync(join(fixture.source, "untracked.txt"), "not committed\n");
    await assert.rejects(
      runPodReconcile(fixture.target, fixture.source, {
        kind: "pod_reconcile", sourceSessionId: "source-session", message: "must not merge",
      }),
      /source member worktree must be clean and committed/,
    );
    rmSync(join(fixture.source, "untracked.txt"));
    writeFileSync(join(fixture.target, "shared.txt"), "dirty target\n");
    await assert.rejects(
      runPodReconcile(fixture.target, fixture.source, {
        kind: "pod_reconcile", sourceSessionId: "source-session", message: "must not merge",
      }),
      /target member worktree must be clean/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("pod reconciliation (real git): rejects clean linked worktrees from different repositories", { skip: !GIT }, async () => {
  const first = seedReconciliationWorktrees();
  const second = seedReconciliationWorktrees();
  try {
    await assert.rejects(
      runPodReconcile(first.target, second.source, {
        kind: "pod_reconcile", sourceSessionId: "other-repo", message: "must not cross repositories",
      }),
      /same git repository/,
    );
    assert.equal(git(first.target, ["status", "--porcelain"]), "");
    assert.equal(git(second.source, ["status", "--porcelain"]), "");
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

test("checkpoints (real git): anchor, read, restore (incl. deleting post-checkpoint files), delete refs", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-ckpt-"));
  try {
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "original\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    // Checkpoint the pristine state as turn 1.
    const tree = await captureWorktreeTree(repo);
    await anchorTurnRef(repo, "s_test", 1, tree);
    assert.equal(await readTurnRef(repo, "s_test", 1), tree);
    assert.equal(git(repo, ["rev-parse", "refs/wollipog/s_test/turn-1"]).trim(), tree);
    assert.equal(git(repo, ["rev-parse", "refs/mam/s_test/turn-1"]).trim(), tree);
    assert.equal(await readTurnRef(repo, "s_test", 2), null);

    // "The agent works": modifies a file and creates a new one.
    writeFileSync(join(repo, "a.txt"), "mutated by the agent\n");
    writeFileSync(join(repo, "b.txt"), "brand new file\n");

    await restoreWorktreeToTree(repo, tree);
    assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "original\n", "modified file reverted");
    assert.equal(existsSync(join(repo, "b.txt")), false, "post-checkpoint file deleted");

    // The anchored ref survives gc (it's a real ref)...
    git(repo, ["gc", "--prune=now", "-q"]);
    assert.equal(await readTurnRef(repo, "s_test", 1), tree);
    // ...and cleanup drops every ref for the session.
    await deleteTurnRefs(repo, "s_test");
    assert.equal(await readTurnRef(repo, "s_test", 1), null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("checkpoint refs isolate identical turns by durable worktree identity", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-ckpt-worktree-"));
  try {
    initRepo(repo);
    writeFileSync(join(repo, "state.txt"), "first worktree\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    const firstTree = await captureWorktreeTree(repo);
    writeFileSync(join(repo, "state.txt"), "second worktree\n");
    const secondTree = await captureWorktreeTree(repo);

    await anchorTurnRef(repo, "s_scoped", 1, firstTree, undefined, "wt_first");
    await anchorTurnRef(repo, "s_scoped", 1, secondTree, undefined, "wt_second");
    assert.equal(await readTurnRef(repo, "s_scoped", 1, undefined, "wt_first"), firstTree);
    assert.equal(await readTurnRef(repo, "s_scoped", 1, undefined, "wt_second"), secondTree);
    assert.equal(await readTurnRef(repo, "s_scoped", 1), null,
      "an unscoped lookup must not fall through to either worktree");
    assert.equal(git(repo, ["rev-parse", "refs/wollipog/s_scoped/worktrees/wt_first/turn-1"]).trim(), firstTree);
    assert.equal(git(repo, ["rev-parse", "refs/wollipog/s_scoped/worktrees/wt_second/turn-1"]).trim(), secondTree);

    await deleteTurnRefs(repo, "s_scoped");
    assert.equal(git(repo, ["for-each-ref", "--format=%(refname)", "refs/wollipog/s_scoped/"]).trim(), "");
    assert.equal(git(repo, ["for-each-ref", "--format=%(refname)", "refs/mam/s_scoped/"]).trim(), "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("checkpoints (real git): capture and restore do not renormalize an untouched tracked file", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-ckpt-filter-"));
  try {
    initRepo(repo);
    const trackedPath = join(repo, "tracked.txt");
    writeFileSync(trackedPath, "legacy content\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-q", "-m", "baseline before filter"]);
    const nonRacyTime = new Date(1_600_000_000_000);
    utimesSync(trackedPath, nonRacyTime, nonRacyTime);
    git(repo, ["update-index", "--refresh"]);

    const baselineBlob = git(repo, ["rev-parse", "HEAD:tracked.txt"]).trim();
    git(repo, ["config", "filter.snapshot.clean",
      `node -e "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(s.replaceAll('legacy','current')))"`,
    ]);
    writeFileSync(join(repo, ".gitattributes"), "tracked.txt filter=snapshot\n");

    const currentFilterBlob = git(repo, ["hash-object", "--path=tracked.txt", "tracked.txt"]).trim();
    assert.notEqual(currentFilterBlob, baselineBlob, "the current clean filter would replace the indexed blob");
    assert.equal(readFileSync(trackedPath, "utf8"), "legacy content\n", "the tracked worktree file is untouched");

    const indexBefore = readFileSync(join(repo, ".git", "index"));
    const statusBefore = git(repo, ["--no-optional-locks", "status", "--porcelain"]);
    const tree = await captureWorktreeTree(repo);

    assert.equal(git(repo, ["rev-parse", `${tree}:tracked.txt`]).trim(), baselineBlob,
      "capture preserves the existing blob instead of renormalizing an untouched path");
    assert.match(git(repo, ["rev-parse", `${tree}:.gitattributes`]).trim(), /^[0-9a-f]{40,64}$/,
      "the complete snapshot still includes the untracked attributes file");
    assert.deepEqual(readFileSync(join(repo, ".git", "index")), indexBefore,
      "capture leaves the real index byte-for-byte unchanged");
    assert.equal(git(repo, ["--no-optional-locks", "status", "--porcelain"]), statusBefore,
      "capture leaves worktree status unchanged");

    writeFileSync(trackedPath, "mutated after checkpoint\n");
    await restoreWorktreeToTree(repo, tree);
    assert.equal(readFileSync(trackedPath, "utf8"), "legacy content\n",
      "restore writes the checkpoint's original content through the unchanged smudge behavior");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("checkpoint namespace compatibility mirrors one-sided refs and fails closed on rollback divergence", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-ckpt-compat-"));
  try {
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "first\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    const firstTree = await captureWorktreeTree(repo);
    writeFileSync(join(repo, "a.txt"), "second\n");
    const secondTree = await captureWorktreeTree(repo);

    // Old runner state: only the legacy namespace exists.
    git(repo, ["update-ref", "refs/mam/s_upgrade/turn-1", firstTree]);
    git(repo, ["update-ref", "refs/mam/s_upgrade/fork-1", firstTree]);
    assert.equal(await readTurnRef(repo, "s_upgrade", 1), firstTree);

    // Current-only state is also readable and is mirrored back for rollback visibility.
    git(repo, ["update-ref", "refs/wollipog/s_upgrade/turn-2", secondTree]);
    assert.equal(await readTurnRef(repo, "s_upgrade", 2), secondTree);

    // Simulate downgrade after a dual-written checkpoint: the old runner changes only refs/mam.
    git(repo, ["update-ref", "refs/wollipog/s_upgrade/turn-3", firstTree]);
    git(repo, ["update-ref", "refs/mam/s_upgrade/turn-3", secondTree]);
    await assert.rejects(
      readTurnRef(repo, "s_upgrade", 3),
      /checkpoint refs diverged.*s_upgrade turn 3/,
    );

    const synchronized = await synchronizeCheckpointRefs(repo, "s_upgrade");
    assert.deepEqual(synchronized, {
      mirroredToCurrent: 2,
      mirroredToLegacy: 1,
      conflicts: ["turn-3"],
    });
    assert.equal(git(repo, ["rev-parse", "refs/wollipog/s_upgrade/turn-1"]).trim(), firstTree);
    assert.equal(git(repo, ["rev-parse", "refs/wollipog/s_upgrade/fork-1"]).trim(), firstTree);
    assert.equal(git(repo, ["rev-parse", "refs/mam/s_upgrade/turn-2"]).trim(), secondTree);
    assert.equal(git(repo, ["rev-parse", "refs/wollipog/s_upgrade/turn-3"]).trim(), firstTree);
    assert.equal(git(repo, ["rev-parse", "refs/mam/s_upgrade/turn-3"]).trim(), secondTree);

    // Single-turn rollback removes both names, while session cleanup removes turn and fork refs
    // from both namespaces without touching a neighboring session.
    await deleteTurnRef(repo, "s_upgrade", 1);
    assert.equal(await readTurnRef(repo, "s_upgrade", 1), null);
    git(repo, ["update-ref", "refs/mam/s_neighbor/turn-1", firstTree]);
    git(repo, ["update-ref", "refs/wollipog/s_neighbor/turn-1", firstTree]);
    await deleteTurnRefs(repo, "s_upgrade");
    assert.equal(git(repo, ["for-each-ref", "--format=%(refname)", "refs/mam/s_upgrade/"]).trim(), "");
    assert.equal(git(repo, ["for-each-ref", "--format=%(refname)", "refs/wollipog/s_upgrade/"]).trim(), "");
    assert.equal(git(repo, ["rev-parse", "refs/mam/s_neighbor/turn-1"]).trim(), firstTree);
    assert.equal(git(repo, ["rev-parse", "refs/wollipog/s_neighbor/turn-1"]).trim(), firstTree);

    // Fork producers are dual-written too; their refs are GC pins even though metadata supplies
    // the tree to the fork operation.
    await anchorForkRef(repo, "s_fork", 4, secondTree);
    assert.equal(git(repo, ["rev-parse", "refs/mam/s_fork/fork-4"]).trim(), secondTree);
    assert.equal(git(repo, ["rev-parse", "refs/wollipog/s_fork/fork-4"]).trim(), secondTree);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("checkpoint owner namespaces isolate identical session ids and exact cleanup", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-ckpt-owner-"));
  const ownerA = "a".repeat(64);
  const ownerB = "b".repeat(64);
  try {
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "first\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    const firstTree = await captureWorktreeTree(repo);
    writeFileSync(join(repo, "a.txt"), "second\n");
    const secondTree = await captureWorktreeTree(repo);

    await anchorTurnRef(repo, "same-session", 1, firstTree, ownerA);
    await anchorTurnRef(repo, "same-session", 1, secondTree, ownerB);
    assert.equal(await readTurnRef(repo, "same-session", 1, ownerA), firstTree);
    assert.equal(await readTurnRef(repo, "same-session", 1, ownerB), secondTree);
    assert.equal(await readTurnRef(repo, "same-session", 1), null, "owned refs never populate the legacy root");

    await deleteTurnRefs(repo, "same-session", ownerA);
    assert.equal(await readTurnRef(repo, "same-session", 1, ownerA), null);
    assert.equal(await readTurnRef(repo, "same-session", 1, ownerB), secondTree,
      "one owner cleanup cannot enumerate or remove its sibling");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("explicit checkpoint adoption verifies and preserves legacy source refs", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-ckpt-adopt-"));
  const owner = "c".repeat(64);
  try {
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "checkpoint\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    const tree = await captureWorktreeTree(repo);
    await anchorTurnRef(repo, "legacy-session", 1, tree);
    assert.equal(await adoptLegacyCheckpointRefs(repo, "legacy-session", owner), 1);
    assert.equal(await readTurnRef(repo, "legacy-session", 1), tree, "legacy rollback source remains");
    assert.equal(await readTurnRef(repo, "legacy-session", 1, owner), tree);
    assert.equal(await adoptLegacyCheckpointRefs(repo, "legacy-session", owner), 0, "retry is idempotent");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("single-turn cleanup deletes either one-sided checkpoint namespace", { skip: !GIT }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-ckpt-one-sided-delete-"));
  try {
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "checkpoint\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    const tree = await captureWorktreeTree(repo);

    for (const [sessionId, root] of [
      ["s_legacy_only", "refs/mam"],
      ["s_current_only", "refs/wollipog"],
    ] as const) {
      git(repo, ["update-ref", `${root}/${sessionId}/turn-1`, tree]);
      await deleteTurnRef(repo, sessionId, 1);
      assert.equal(git(repo, ["for-each-ref", "--format=%(refname)", `refs/mam/${sessionId}/`]).trim(), "");
      assert.equal(git(repo, ["for-each-ref", "--format=%(refname)", `refs/wollipog/${sessionId}/`]).trim(), "");
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("checkpoint dual-write transaction leaves both namespaces unchanged when either ref is locked", { skip: !GIT }, async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-ckpt-atomic-"));
  try {
    initRepo(repo);
    if (!usesLooseRefFiles(repo)) {
      t.skip("loose-ref lock injection requires the files ref backend");
      return;
    }
    writeFileSync(join(repo, "a.txt"), "first\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    const firstTree = await captureWorktreeTree(repo);
    await anchorTurnRef(repo, "s_atomic", 1, firstTree);
    writeFileSync(join(repo, "a.txt"), "second\n");
    const secondTree = await captureWorktreeTree(repo);

    const lockDir = join(repo, ".git", "refs", "wollipog", "s_atomic");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "turn-1.lock"), "locked");
    await assert.rejects(anchorTurnRef(repo, "s_atomic", 1, secondTree));

    assert.equal(git(repo, ["rev-parse", "refs/mam/s_atomic/turn-1"]).trim(), firstTree);
    assert.equal(git(repo, ["rev-parse", "refs/wollipog/s_atomic/turn-1"]).trim(), firstTree);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("checkpoint cleanup transaction never partially deletes when one ref is locked", { skip: !GIT }, async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "wollipog-ckpt-delete-atomic-"));
  try {
    initRepo(repo);
    if (!usesLooseRefFiles(repo)) {
      t.skip("loose-ref lock injection requires the files ref backend");
      return;
    }
    writeFileSync(join(repo, "a.txt"), "checkpoint\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    const tree = await captureWorktreeTree(repo);
    await anchorTurnRef(repo, "s_delete_atomic", 1, tree);
    await anchorForkRef(repo, "s_delete_atomic", 1, tree);

    const lockDir = join(repo, ".git", "refs", "wollipog", "s_delete_atomic");
    const lockPath = join(lockDir, "turn-1.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, "locked");
    await assert.rejects(deleteTurnRefs(repo, "s_delete_atomic"));

    for (const root of ["refs/mam", "refs/wollipog"]) {
      assert.equal(git(repo, ["rev-parse", `${root}/s_delete_atomic/turn-1`]).trim(), tree);
      assert.equal(git(repo, ["rev-parse", `${root}/s_delete_atomic/fork-1`]).trim(), tree);
    }

    rmSync(lockPath, { force: true });
    await deleteTurnRefs(repo, "s_delete_atomic");
    assert.equal(git(repo, ["for-each-ref", "--format=%(refname)", "refs/mam/s_delete_atomic/"]).trim(), "");
    assert.equal(git(repo, ["for-each-ref", "--format=%(refname)", "refs/wollipog/s_delete_atomic/"]).trim(), "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
