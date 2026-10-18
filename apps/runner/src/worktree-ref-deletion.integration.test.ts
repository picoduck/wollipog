import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import {
  deleteOwnedWorktreeRefs,
  findBubblewrap,
  MAX_WORKTREE_REF_DELETIONS,
  validateWorktreeRefDeletionRequests,
  WorktreeRefDeletionRefusal,
  type WorktreeRefDeletionScope,
} from "./worktree-ref-deletion.js";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

function git(args: string[], cwd: string, allowFailure = false): string {
  const result = spawnSync("git", ["-c", "user.email=runner@example.invalid", "-c", "user.name=Runner", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  });
  if (!allowFailure) assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stdout}${result.stderr}`);
  return String(result.stdout ?? "").trim();
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-ref-deletion-")));
  roots.push(root);
  const repoPath = join(root, "repo");
  const worktreePath = join(root, "worktrees", "s_owner");
  const otherPath = join(root, "worktrees", "s_other");
  mkdirSync(repoPath, { recursive: true });
  git(["init", "--quiet", "--initial-branch=main", "."], repoPath);
  writeFileSync(join(repoPath, "tracked.txt"), "base\n");
  git(["add", "tracked.txt"], repoPath);
  git(["commit", "--quiet", "-m", "base"], repoPath);
  git(["remote", "add", "origin", "https://example.invalid/repo.git"], repoPath);
  git(["worktree", "add", "--quiet", "-b", "agent/s_owner", worktreePath, "main"], repoPath);
  git(["worktree", "add", "--quiet", "-b", "agent/s_other", otherPath, "main"], repoPath);
  const commonGitDir = realpathSync(join(repoPath, ".git"));
  const admin = (path: string) => realpathSync(resolve(path, readFileSync(join(path, ".git"), "utf8").trim().replace(/^gitdir: /u, "")));
  const scope: WorktreeRefDeletionScope = {
    worktreePath,
    worktreeGitDir: admin(worktreePath),
    commonGitDir,
    ownedBranches: ["agent/s_owner", "agent/s_owner-old"],
  };
  return { root, repoPath, worktreePath, otherPath, commonGitDir, scope, otherAdmin: admin(otherPath) };
}

/** Leave a stopped cherry-pick's CHERRY_PICK_HEAD and AUTO_MERGE the way a sandboxed rebase does. */
function plantSequencerLeftovers(worktreePath: string, adminDir: string): { pick: string; tree: string } {
  const pick = git(["rev-parse", "HEAD"], worktreePath);
  const tree = git(["rev-parse", "HEAD^{tree}"], worktreePath);
  writeFileSync(join(adminDir, "CHERRY_PICK_HEAD"), `${pick}\n`);
  writeFileSync(join(adminDir, "AUTO_MERGE"), `${tree}\n`);
  return { pick, tree };
}

async function refused(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WorktreeRefDeletionRefusal, String(error));
    assert.match(error.message, pattern);
    return true;
  });
}

test("the runner clears a worktree's sequencer leftovers and the session's own loose and packed refs", async () => {
  const { repoPath, worktreePath, commonGitDir, scope, otherPath } = fixture();
  const { pick, tree } = plantSequencerLeftovers(worktreePath, scope.worktreeGitDir);
  const head = git(["rev-parse", "main"], repoPath);
  git(["branch", "agent/s_owner-old", "main"], repoPath);
  git(["update-ref", "refs/remotes/origin/agent/s_owner", head], repoPath);
  git(["pack-refs", "--all"], repoPath);
  git(["update-ref", "refs/remotes/origin/agent/s_other", head], repoPath);
  const configBefore = readFileSync(join(commonGitDir, "config"), "utf8");

  const result = await deleteOwnedWorktreeRefs(scope, [
    { ref: "CHERRY_PICK_HEAD", oldOid: pick },
    { ref: "AUTO_MERGE", oldOid: tree },
    { ref: "refs/heads/agent/s_owner-old", oldOid: head },
    { ref: "refs/remotes/origin/agent/s_owner", oldOid: head },
  ]);
  assert.deepEqual(result.deleted, ["CHERRY_PICK_HEAD", "AUTO_MERGE", "refs/heads/agent/s_owner-old", "refs/remotes/origin/agent/s_owner"]);
  assert.deepEqual(result.absent, []);
  assert.equal(existsSync(join(scope.worktreeGitDir, "CHERRY_PICK_HEAD")), false);
  assert.equal(existsSync(join(scope.worktreeGitDir, "AUTO_MERGE")), false);
  assert.doesNotMatch(git(["status"], worktreePath), /cherry-pick/iu);
  assert.equal(git(["for-each-ref", "--format=%(refname)", "refs/heads/agent/s_owner-old", "refs/remotes/origin/agent/s_owner"], repoPath), "");
  assert.equal(git(["rev-parse", "refs/remotes/origin/agent/s_other"], repoPath), head);
  assert.equal(git(["rev-parse", "agent/s_other"], otherPath), head);
  assert.equal(readFileSync(join(commonGitDir, "config"), "utf8"), configBefore);
  git(["fsck", "--no-progress", "--strict"], repoPath);

  // Repeating the same call is not an error: the refs are reported absent.
  const repeated = await deleteOwnedWorktreeRefs(scope, [
    { ref: "CHERRY_PICK_HEAD", oldOid: pick },
    { ref: "refs/remotes/origin/agent/s_owner", oldOid: head },
  ]);
  assert.deepEqual(repeated, { deleted: [], absent: ["CHERRY_PICK_HEAD", "refs/remotes/origin/agent/s_owner"] });
});

test("another session's refs and unrecorded branches are refused", async () => {
  const { repoPath, scope } = fixture();
  const head = git(["rev-parse", "main"], repoPath);
  git(["branch", "scratch", "main"], repoPath);
  git(["update-ref", "refs/remotes/origin/agent/s_other", head], repoPath);
  for (const ref of [
    "refs/heads/agent/s_other",
    "refs/remotes/origin/agent/s_other",
    "refs/heads/scratch",
    "refs/heads/main",
    "refs/heads/agent/*",
    "refs/remotes/upstream/agent/s_owner",
    "HEAD",
    "ORIG_HEAD",
    "refs/tags/v1",
  ]) {
    await refused(deleteOwnedWorktreeRefs(scope, [{ ref, oldOid: head }]), /only this worktree's/u);
  }
  assert.equal(git(["rev-parse", "agent/s_other"], repoPath), head);
  assert.equal(git(["rev-parse", "scratch"], repoPath), head);
  assert.equal(git(["rev-parse", "refs/remotes/origin/agent/s_other"], repoPath), head);
});

test("a branch checked out or being rebased in any worktree is refused", async () => {
  const { repoPath, scope, otherAdmin } = fixture();
  const head = git(["rev-parse", "main"], repoPath);
  // The session's own selected branch is checked out in its worktree.
  await refused(deleteOwnedWorktreeRefs(scope, [{ ref: "refs/heads/agent/s_owner", oldOid: head }]), /checked out/u);
  // A recorded branch another worktree has checked out, or is rebasing, is refused too.
  git(["branch", "agent/s_owner-old", "main"], repoPath);
  mkdirSync(join(otherAdmin, "rebase-merge"));
  writeFileSync(join(otherAdmin, "rebase-merge", "head-name"), "refs/heads/agent/s_owner-old\n");
  await refused(deleteOwnedWorktreeRefs(scope, [{ ref: "refs/heads/agent/s_owner-old", oldOid: head }]), /checked out or being rebased/u);
  rmSync(join(otherAdmin, "rebase-merge"), { recursive: true });
  assert.deepEqual(await deleteOwnedWorktreeRefs(scope, [{ ref: "refs/heads/agent/s_owner-old", oldOid: head }]),
    { deleted: ["refs/heads/agent/s_owner-old"], absent: [] });
});

test("sequencer leftovers stay while a rebase, merge or cherry-pick sequence is in progress", async () => {
  const { worktreePath, scope } = fixture();
  const { pick } = plantSequencerLeftovers(worktreePath, scope.worktreeGitDir);
  for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "sequencer"]) {
    const path = join(scope.worktreeGitDir, marker);
    if (marker === "MERGE_HEAD") writeFileSync(path, `${pick}\n`);
    else mkdirSync(path);
    await refused(deleteOwnedWorktreeRefs(scope, [{ ref: "CHERRY_PICK_HEAD", oldOid: pick }]),
      marker === "sequencer" ? /cherry-pick --quit/u : /rebase or merge is in progress/u);
    rmSync(path, { recursive: true });
  }
  assert.equal(existsSync(join(scope.worktreeGitDir, "CHERRY_PICK_HEAD")), true);
});

test("a stale expected value deletes nothing at all", async () => {
  const { repoPath, worktreePath, scope } = fixture();
  const { pick, tree } = plantSequencerLeftovers(worktreePath, scope.worktreeGitDir);
  git(["branch", "agent/s_owner-old", "main"], repoPath);
  await refused(deleteOwnedWorktreeRefs(scope, [
    { ref: "CHERRY_PICK_HEAD", oldOid: pick },
    { ref: "refs/heads/agent/s_owner-old", oldOid: tree },
  ]), /no longer has the expected value; nothing was deleted/u);
  assert.equal(existsSync(join(scope.worktreeGitDir, "CHERRY_PICK_HEAD")), true);
  assert.equal(git(["rev-parse", "agent/s_owner-old"], repoPath), pick);
});

test("a ref path redirected through a symlink is refused before Git runs", async () => {
  const { root, repoPath, commonGitDir, scope } = fixture();
  const head = git(["rev-parse", "main"], repoPath);
  const victim = join(root, "victim");
  mkdirSync(victim);
  writeFileSync(join(victim, "s_owner-old"), "keep\n");
  mkdirSync(join(commonGitDir, "refs", "remotes", "origin"), { recursive: true });
  symlinkSync(victim, join(commonGitDir, "refs", "remotes", "origin", "agent"));
  await refused(deleteOwnedWorktreeRefs(scope, [{ ref: "refs/remotes/origin/agent/s_owner-old", oldOid: head }]),
    /not a plain file or directory/u);
  assert.equal(readFileSync(join(victim, "s_owner-old"), "utf8"), "keep\n");
});

test("a ref is read by its exact name, never resolved like a revision", async () => {
  const { repoPath, scope } = fixture();
  const head = git(["rev-parse", "main"], repoPath);
  // `git rev-parse AUTO_MERGE` would fall back to this branch once the pseudo-ref is gone.
  git(["branch", "AUTO_MERGE", "main"], repoPath);
  git(["update-ref", "refs/heads/refs/heads/agent/s_owner-old", head], repoPath);
  assert.deepEqual(await deleteOwnedWorktreeRefs(scope, [
    { ref: "AUTO_MERGE", oldOid: head },
    { ref: "refs/heads/agent/s_owner-old", oldOid: head },
  ]), { deleted: [], absent: ["AUTO_MERGE", "refs/heads/agent/s_owner-old"] });
  assert.equal(git(["rev-parse", "refs/heads/AUTO_MERGE"], repoPath), head);
  writeFileSync(join(scope.worktreeGitDir, "AUTO_MERGE"), "ref: refs/heads/main\n");
  await refused(deleteOwnedWorktreeRefs(scope, [{ ref: "AUTO_MERGE", oldOid: head }]), /does not hold an object id/u);
});

test("requests are bounded and need a full expected object id", () => {
  const oid = "a".repeat(40);
  assert.throws(() => validateWorktreeRefDeletionRequests([]), WorktreeRefDeletionRefusal);
  assert.throws(() => validateWorktreeRefDeletionRequests(Array.from({ length: MAX_WORKTREE_REF_DELETIONS + 1 },
    (_, index) => ({ ref: `refs/heads/b${index}`, oldOid: oid }))), WorktreeRefDeletionRefusal);
  assert.throws(() => validateWorktreeRefDeletionRequests([{ ref: "CHERRY_PICK_HEAD" }]), WorktreeRefDeletionRefusal);
  assert.throws(() => validateWorktreeRefDeletionRequests([{ ref: "CHERRY_PICK_HEAD", oldOid: "abc123" }]), WorktreeRefDeletionRefusal);
  assert.throws(() => validateWorktreeRefDeletionRequests([
    { ref: "CHERRY_PICK_HEAD", oldOid: oid }, { ref: "CHERRY_PICK_HEAD", oldOid: oid },
  ]), WorktreeRefDeletionRefusal);
  assert.deepEqual(validateWorktreeRefDeletionRequests([{ ref: "AUTO_MERGE", oldOid: oid, extra: 1 }]),
    [{ ref: "AUTO_MERGE", oldOid: oid }]);
});

test("bubblewrap is found only as an executable file on an absolute PATH entry", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-ref-deletion-path-")));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  assert.equal(await findBubblewrap(`relative:${bin}`), undefined);
  writeFileSync(join(bin, "bwrap"), "#!/bin/sh\n", { mode: 0o644 });
  assert.equal(await findBubblewrap(bin), undefined, "not executable");
  chmodSync(join(bin, "bwrap"), 0o755);
  assert.equal(await findBubblewrap(`relative:${bin}`), join(bin, "bwrap"));
});
