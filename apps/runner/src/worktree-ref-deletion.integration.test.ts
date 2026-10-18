import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import {
  deleteOwnedWorktreeRefs,
  findBubblewrap,
  MAX_WORKTREE_REF_DELETIONS,
  RefDeletionLockJournal,
  refDeletionGitRunner,
  unconfinedGitRunnerForTests,
  type GitRunner,
  validateWorktreeRefDeletionRequests,
  WorktreeRefDeletionRefusal,
  type WorktreeLockKeeper,
  type WorktreeRefDeletionRequest,
  type WorktreeRefDeletionScope,
} from "./worktree-ref-deletion.js";

/** These fixtures are changed by nobody but the test, so the unconfined host Git is safe here. */
function deleteRefs(scope: WorktreeRefDeletionScope, requests: WorktreeRefDeletionRequest[],
  git: GitRunner = unconfinedGitRunnerForTests, locks?: WorktreeLockKeeper) {
  return deleteOwnedWorktreeRefs(scope, requests, git, locks);
}

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

  const result = await deleteRefs(scope, [
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
  const repeated = await deleteRefs(scope, [
    { ref: "CHERRY_PICK_HEAD", oldOid: pick },
    { ref: "refs/remotes/origin/agent/s_owner", oldOid: head },
  ]);
  assert.deepEqual(repeated, { deleted: [], deletedRefs: [], absent: ["CHERRY_PICK_HEAD", "refs/remotes/origin/agent/s_owner"] });
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
    await refused(deleteRefs(scope, [{ ref, oldOid: head }]), /only this worktree's/u);
  }
  assert.equal(git(["rev-parse", "agent/s_other"], repoPath), head);
  assert.equal(git(["rev-parse", "scratch"], repoPath), head);
  assert.equal(git(["rev-parse", "refs/remotes/origin/agent/s_other"], repoPath), head);
});

test("a branch checked out or being rebased in any worktree is refused", async () => {
  const { repoPath, scope, otherAdmin } = fixture();
  const head = git(["rev-parse", "main"], repoPath);
  // The session's own selected branch is checked out in its worktree.
  await refused(deleteRefs(scope, [{ ref: "refs/heads/agent/s_owner", oldOid: head }]), /checked out/u);
  // A recorded branch another worktree has checked out, or is rebasing, is refused too.
  git(["branch", "agent/s_owner-old", "main"], repoPath);
  mkdirSync(join(otherAdmin, "rebase-merge"));
  writeFileSync(join(otherAdmin, "rebase-merge", "head-name"), "refs/heads/agent/s_owner-old\n");
  await refused(deleteRefs(scope, [{ ref: "refs/heads/agent/s_owner-old", oldOid: head }]), /checked out or being rebased/u);
  rmSync(join(otherAdmin, "rebase-merge"), { recursive: true });
  assert.deepEqual(await deleteRefs(scope, [{ ref: "refs/heads/agent/s_owner-old", oldOid: head }]),
    { deleted: ["refs/heads/agent/s_owner-old"], deletedRefs: [{ ref: "refs/heads/agent/s_owner-old", oldOid: head }], absent: [] });
});

test("sequencer leftovers stay while a rebase, merge or cherry-pick sequence is in progress", async () => {
  const { worktreePath, scope } = fixture();
  const { pick } = plantSequencerLeftovers(worktreePath, scope.worktreeGitDir);
  for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "sequencer"]) {
    const path = join(scope.worktreeGitDir, marker);
    if (marker === "MERGE_HEAD") writeFileSync(path, `${pick}\n`);
    else mkdirSync(path);
    await refused(deleteRefs(scope, [{ ref: "CHERRY_PICK_HEAD", oldOid: pick }]),
      marker === "sequencer" ? /cherry-pick --quit/u : /rebase or merge is in progress/u);
    rmSync(path, { recursive: true });
  }
  assert.equal(existsSync(join(scope.worktreeGitDir, "CHERRY_PICK_HEAD")), true);
});

test("a stale expected value deletes nothing at all", async () => {
  const { repoPath, worktreePath, scope } = fixture();
  const { pick, tree } = plantSequencerLeftovers(worktreePath, scope.worktreeGitDir);
  git(["branch", "agent/s_owner-old", "main"], repoPath);
  await refused(deleteRefs(scope, [
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
  await refused(deleteRefs(scope, [{ ref: "refs/remotes/origin/agent/s_owner-old", oldOid: head }]),
    /not a plain file or directory/u);
  assert.equal(readFileSync(join(victim, "s_owner-old"), "utf8"), "keep\n");
});

test("a ref is read by its exact name, never resolved like a revision", async () => {
  const { repoPath, scope } = fixture();
  const head = git(["rev-parse", "main"], repoPath);
  // `git rev-parse AUTO_MERGE` would fall back to this branch once the pseudo-ref is gone.
  git(["branch", "AUTO_MERGE", "main"], repoPath);
  git(["update-ref", "refs/heads/refs/heads/agent/s_owner-old", head], repoPath);
  assert.deepEqual(await deleteRefs(scope, [
    { ref: "AUTO_MERGE", oldOid: head },
    { ref: "refs/heads/agent/s_owner-old", oldOid: head },
  ]), { deleted: [], deletedRefs: [], absent: ["AUTO_MERGE", "refs/heads/agent/s_owner-old"] });
  assert.equal(git(["rev-parse", "refs/heads/AUTO_MERGE"], repoPath), head);
  writeFileSync(join(scope.worktreeGitDir, "AUTO_MERGE"), "ref: refs/heads/main\n");
  await refused(deleteRefs(scope, [{ ref: "AUTO_MERGE", oldOid: head }]), /does not hold an object id/u);
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

test("a runner that cannot confine its Git refuses before any Git runs (#3316)", async () => {
  const { scope } = fixture();
  for (const platform of ["darwin", "win32", "freebsd"] as const) {
    await assert.rejects(refDeletionGitRunner(scope, { platform, findBwrap: async () => "/usr/bin/bwrap" }),
      /only Linux runners provide/u, platform);
  }
  await assert.rejects(refDeletionGitRunner(scope, { platform: "linux", findBwrap: async () => undefined }),
    /bubblewrap is required/u);
  assert.equal(typeof await refDeletionGitRunner(scope, { platform: "linux", findBwrap: async () => "/usr/bin/bwrap" }), "function");
});

/** Runs `between` once, the first time the deletion reads a shared ref's value. */
function interleaved(between: () => void): GitRunner {
  let done = false;
  return async (args, options) => {
    if (!done && args.includes("for-each-ref")) {
      done = true;
      between();
    }
    return unconfinedGitRunnerForTests(args, options);
  };
}

test("a checkout racing the deletion is refused by Git while the runner holds every HEAD and index lock", async () => {
  const { repoPath, otherPath, otherAdmin, scope } = fixture();
  const head = git(["rev-parse", "main"], repoPath);
  git(["branch", "agent/s_owner-old", "main"], repoPath);
  let raced: ReturnType<typeof spawnSync> | undefined;
  const result = await deleteRefs(scope, [{ ref: "refs/heads/agent/s_owner-old", oldOid: head }], interleaved(() => {
    raced = spawnSync("git", ["switch", "-q", "agent/s_owner-old"], { cwd: otherPath, encoding: "utf8", timeout: 60_000 });
  }));
  assert.notEqual(raced?.status, 0, "the racing checkout fails on a held lock");
  assert.match(String(raced?.stderr), /(?:HEAD|index)\.lock/u);
  assert.deepEqual(result, { deleted: ["refs/heads/agent/s_owner-old"],
    deletedRefs: [{ ref: "refs/heads/agent/s_owner-old", oldOid: head }], absent: [] });
  assert.equal(readFileSync(join(otherAdmin, "HEAD"), "utf8"), "ref: refs/heads/agent/s_other\n");
  assert.equal(git(["rev-parse", "HEAD"], otherPath), head, "the other checkout stays valid");
  for (const admin of [scope.commonGitDir, scope.worktreeGitDir, otherAdmin]) {
    for (const lock of ["HEAD.lock", "index.lock"]) assert.equal(existsSync(join(admin, lock)), false, "every lock is released");
  }
});

test("a HEAD pointed at the branch without Git's lock during the deletion gets the branch back", async () => {
  const { repoPath, otherPath, otherAdmin, worktreePath, scope } = fixture();
  const { pick } = plantSequencerLeftovers(worktreePath, scope.worktreeGitDir);
  const head = git(["rev-parse", "main"], repoPath);
  git(["branch", "agent/s_owner-old", "main"], repoPath);
  await refused(deleteRefs(scope, [
    { ref: "CHERRY_PICK_HEAD", oldOid: pick },
    { ref: "refs/heads/agent/s_owner-old", oldOid: head },
  ], interleaved(() => writeFileSync(join(otherAdmin, "HEAD"), "ref: refs/heads/agent/s_owner-old\n"))),
  /was checked out while it was being deleted; every ref was restored/u);
  assert.equal(git(["rev-parse", "refs/heads/agent/s_owner-old"], repoPath), head, "the branch is back");
  assert.equal(git(["rev-parse", "HEAD"], otherPath), head, "and the checkout on it is valid");
  assert.equal(readFileSync(join(scope.worktreeGitDir, "CHERRY_PICK_HEAD"), "utf8").trim(), pick,
    "the refusal leaves the call's other refs in place too");
  git(["fsck", "--no-progress", "--strict"], repoPath);
});

test("a worktree whose HEAD is already locked refuses the branch deletion and leaves its lock alone", async () => {
  const { repoPath, otherAdmin, scope } = fixture();
  const head = git(["rev-parse", "main"], repoPath);
  git(["branch", "agent/s_owner-old", "main"], repoPath);
  writeFileSync(join(otherAdmin, "HEAD.lock"), "busy\n");
  await refused(deleteRefs(scope, [{ ref: "refs/heads/agent/s_owner-old", oldOid: head }]), /HEAD or index is locked/u);
  assert.equal(readFileSync(join(otherAdmin, "HEAD.lock"), "utf8"), "busy\n");
  for (const admin of [scope.commonGitDir, scope.worktreeGitDir]) {
    for (const lock of ["HEAD.lock", "index.lock"]) assert.equal(existsSync(join(admin, lock)), false, lock);
  }
  assert.equal(existsSync(join(otherAdmin, "index.lock")), false);
  assert.equal(git(["rev-parse", "agent/s_owner-old"], repoPath), head);
});

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return;
    await delay(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}

const LOCK_NAMES = ["HEAD.lock", "index.lock"] as const;
function heldLocks(...admins: string[]): string[] {
  return admins.flatMap((admin) => LOCK_NAMES.filter((name) => existsSync(join(admin, name))).map((name) => join(admin, name)));
}

test("a checkout paused in a smudge filter holds index.lock, so the deletion is refused (CR-2.1)", async () => {
  const { root, repoPath, otherPath, otherAdmin, scope } = fixture();
  const started = join(root, "smudge-started");
  const go = join(root, "smudge-go");
  // The branch to delete carries a file whose checkout runs a smudge filter that waits.
  git(["switch", "-q", "-c", "agent/s_owner-old"], repoPath);
  writeFileSync(join(repoPath, ".gitattributes"), "*.slow filter=slow\n");
  writeFileSync(join(repoPath, "payload.slow"), "payload\n");
  git(["add", ".gitattributes", "payload.slow"], repoPath);
  git(["commit", "-qm", "slow"], repoPath);
  git(["switch", "-q", "main"], repoPath);
  const branchOid = git(["rev-parse", "agent/s_owner-old"], repoPath);
  git(["config", "filter.slow.smudge",
    `sh -c 'touch ${started}; while [ ! -e ${go} ]; do sleep 0.05; done; cat'`], repoPath);
  // The other worktree resolves the branch and stops while rewriting its working tree.
  const checkout = spawn("git", ["switch", "-q", "agent/s_owner-old"], { cwd: otherPath, stdio: "ignore" });
  const exited = new Promise<number | null>((resolve) => checkout.once("exit", resolve));
  try {
    await until(() => existsSync(started), "the smudge filter to start");
    assert.ok(existsSync(join(otherAdmin, "index.lock")), "Git holds the paused worktree's index.lock");
    assert.equal(existsSync(join(otherAdmin, "HEAD.lock")), false, "but not its HEAD.lock yet");
    await refused(deleteRefs(scope, [{ ref: "refs/heads/agent/s_owner-old", oldOid: branchOid }]), /HEAD or index is locked/u);
  } finally {
    writeFileSync(go, "");
  }
  assert.equal(await exited, 0, "the checkout finishes");
  assert.equal(readFileSync(join(otherAdmin, "HEAD"), "utf8"), "ref: refs/heads/agent/s_owner-old\n");
  assert.equal(git(["rev-parse", "refs/heads/agent/s_owner-old"], repoPath), branchOid, "the branch survives");
  assert.equal(git(["rev-parse", "HEAD"], otherPath), branchOid, "and the checkout on it is valid");
  assert.deepEqual(heldLocks(scope.commonGitDir, scope.worktreeGitDir, otherAdmin), []);
});

test("startup recovery removes this runner's marked stale locks and never an unmarked one (CR-2.2)", async () => {
  const { root, otherAdmin, scope } = fixture();
  const journalDir = join(root, "journal");
  mkdirSync(journalDir);
  const operation = randomUUID();
  const marker = `wollipog-ref-deletion runner=runner-a operation=${operation}\n`;
  const ours = join(otherAdmin, "HEAD.lock");
  const gits = join(scope.worktreeGitDir, "index.lock");
  const anotherOperation = join(otherAdmin, "index.lock");
  writeFileSync(ours, marker);
  writeFileSync(gits, "DIRC index Git is writing\n");
  writeFileSync(anotherOperation, `wollipog-ref-deletion runner=runner-a operation=${randomUUID()}\n`);
  writeFileSync(join(journalDir, `${operation}.json`), JSON.stringify({ runnerId: "runner-a", paths: [ours, gits, anotherOperation] }));
  // Another runner's journal is not this runner's to act on, and its marker would not match.
  const foreign = randomUUID();
  const foreignLock = join(scope.commonGitDir, "HEAD.lock");
  writeFileSync(foreignLock, `wollipog-ref-deletion runner=runner-b operation=${foreign}\n`);
  writeFileSync(join(journalDir, `${foreign}.json`), JSON.stringify({ runnerId: "runner-b", paths: [foreignLock] }));

  await new RefDeletionLockJournal(journalDir, "runner-a").recover();
  assert.equal(existsSync(ours), false, "the marked stale lock is removed");
  assert.equal(readFileSync(gits, "utf8"), "DIRC index Git is writing\n", "Git's own lock stays");
  assert.ok(existsSync(anotherOperation), "a lock marked for another operation stays");
  assert.ok(existsSync(foreignLock), "another runner's lock stays");
  assert.equal(existsSync(join(journalDir, `${operation}.json`)), false);
});

function pausedAt(): { reached: () => boolean; wait: () => Promise<void>; resume: () => void } {
  let reached = false;
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  return { reached: () => reached, wait: async () => { reached = true; await paused; }, resume };
}

function wollipogFiles(...admins: string[]): string[] {
  return admins.flatMap((admin) => readdirSync(admin).filter((name) => name.endsWith(".wollipog") ||
    ((name === "HEAD.lock" || name === "index.lock") && readFileSync(join(admin, name), "utf8").startsWith("wollipog-ref-deletion"))));
}

test("a drain cancels a paused deletion before its transaction and joins it, leaving no lock (CR-2.2)", async () => {
  const { root, repoPath, otherAdmin, scope } = fixture();
  const head = git(["rev-parse", "main"], repoPath);
  git(["branch", "agent/s_owner-old", "main"], repoPath);
  const journal = new RefDeletionLockJournal(join(root, "journal"), "runner-a");
  const pause = pausedAt();
  let paused = false;
  const pausing: GitRunner = async (args, options) => {
    if (args.includes("for-each-ref") && !paused) {
      paused = true;
      await pause.wait();
    }
    return unconfinedGitRunnerForTests(args, options);
  };
  const running = journal.run((locks) => deleteRefs(scope, [{ ref: "refs/heads/agent/s_owner-old", oldOid: head }], pausing, locks));
  const settled = running.then(() => "done", (error: Error) => error.message);
  await until(pause.reached, "the deletion to pause with its locks held");
  assert.equal(heldLocks(scope.commonGitDir, scope.worktreeGitDir, otherAdmin).length, 6);
  setTimeout(pause.resume, 30);
  assert.equal(await journal.drain(5_000), true, "the drain joins the cancelled deletion");
  assert.match(await settled, /shutting down/u, "cancelled before its transaction");
  assert.equal(git(["rev-parse", "agent/s_owner-old"], repoPath), head, "so the branch was not deleted");
  assert.deepEqual(heldLocks(scope.commonGitDir, scope.worktreeGitDir, otherAdmin), [], "no lock outlives the drain");
  assert.deepEqual(readdirSync(join(root, "journal")), [], "and nothing is left to recover");
  await assert.rejects(journal.run(async () => "never"), /shutting down/u);
});

test("a deletion paused between journaling and locking creates no lock after an expired drain (CR-3.2)", async () => {
  const { root, repoPath, otherAdmin, scope } = fixture();
  const head = git(["rev-parse", "main"], repoPath);
  git(["branch", "agent/s_owner-old", "main"], repoPath);
  const journalDir = join(root, "journal");
  const journal = new RefDeletionLockJournal(journalDir, "runner-a");
  const pause = pausedAt();
  const running = journal.run((locks) => deleteRefs(scope, [{ ref: "refs/heads/agent/s_owner-old", oldOid: head }],
    unconfinedGitRunnerForTests, {
      marker: locks.marker,
      record: async (paths) => {
        await locks.record(paths);
        await pause.wait();
      },
      release: () => locks.release(),
      assertActive: () => locks.assertActive(),
    }));
  const settled = running.then(() => "done", (error: Error) => error.message);
  await until(pause.reached, "the deletion to journal its locks and pause before creating them");
  assert.equal(await journal.drain(0), false, "an expired drain cannot join it");
  assert.equal(readdirSync(journalDir).length, 1, "its recovery metadata stays while acquisition may still run");
  assert.deepEqual(wollipogFiles(scope.commonGitDir, scope.worktreeGitDir, otherAdmin), []);
  pause.resume();
  assert.match(await settled, /shutting down/u);
  assert.deepEqual(wollipogFiles(scope.commonGitDir, scope.worktreeGitDir, otherAdmin), [],
    "the resumed acquisition created no lock and no temporary file");
  assert.deepEqual(readdirSync(journalDir), [], "and removed its journal entry only once it had stopped");
  assert.equal(git(["rev-parse", "agent/s_owner-old"], repoPath), head);
});
