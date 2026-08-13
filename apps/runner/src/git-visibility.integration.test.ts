import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitStatus, gitSummary, runGitAction } from "./git-ops.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Wollipog Test",
  GIT_AUTHOR_EMAIL: "wollipog@example.test",
  GIT_COMMITTER_NAME: "Wollipog Test",
  GIT_COMMITTER_EMAIL: "wollipog@example.test",
  GIT_TERMINAL_PROMPT: "0",
};

function git(cwd: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync("git", args, {
      cwd,
      env: GIT_ENV,
      encoding: "utf8",
      stdio: ["ignore", "pipe", allowFailure ? "pipe" : "inherit"],
    }).trim();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function initRepository(root: string, name: string): string {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "base"]);
  return repo;
}

test("Git facts distinguish synced upstream from default-branch divergence and classify worktrees", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-git-visibility-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  mkdirSync(remote);
  git(remote, ["init", "--bare", "--initial-branch=main"]);
  const repo = initRepository(root, "repo");
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);

  git(repo, ["checkout", "-b", "feature"]);
  writeFileSync(join(repo, "feature.txt"), "feature\n");
  git(repo, ["add", "feature.txt"]);
  git(repo, ["commit", "-m", "feature"]);
  git(repo, ["push", "-u", "origin", "feature"]);

  git(repo, ["checkout", "main"]);
  for (let index = 1; index <= 3; index++) {
    writeFileSync(join(repo, "tracked.txt"), "main " + index + "\n");
    git(repo, ["commit", "-am", "main " + index]);
  }
  git(repo, ["push", "origin", "main"]);
  git(repo, ["checkout", "feature"]);
  git(repo, ["fetch", "origin"]);
  git(repo, ["pack-refs", "--all", "--prune"]);

  const summary = await gitSummary(repo);
  assert.equal(summary.upstreamBranch, "origin/feature");
  assert.equal(summary.aheadUpstream, 0);
  assert.equal(summary.behindUpstream, 0);
  assert.equal(summary.baseRef, "origin/main");
  assert.equal(summary.ahead, 1);
  assert.equal(summary.behind, 3);
  assert.equal(summary.detached, false);
  assert.equal(summary.worktreeKind, "primary");
  assert.equal(summary.shallow, false);
  assert.ok((summary.remoteRefsAt ?? 0) > 0);
  const primaryRead = await runGitAction(repo, { kind: "status" }, { useWorktree: false });
  assert.equal(primaryRead.status?.worktreeKind, "primary");
  const nested = join(repo, "nested");
  mkdirSync(nested);
  await assert.rejects(
    () => runGitAction(nested, { kind: "status" }, { useWorktree: false }),
    (error: unknown) => {
      assert.equal(error instanceof Error && error.message.includes("authoritative repository root"), true);
      assert.equal(error instanceof Error && "code" in error && error.code === "GIT_NO_REPOSITORY", true);
      return true;
    },
  );
  await assert.rejects(
    () => runGitAction(repo, { kind: "commit", message: "must not run" }, { useWorktree: false }),
    /requires a runner-owned linked worktree/,
  );

  writeFileSync(join(repo, "tracked.txt"), "staged\n");
  git(repo, ["add", "tracked.txt"]);
  writeFileSync(join(repo, "tracked.txt"), "staged and modified\n");
  writeFileSync(join(repo, "untracked.txt"), "new\n");
  const dirty = await gitStatus(repo);
  assert.equal(dirty.stagedCount, 1);
  assert.equal(dirty.modifiedCount, 1);
  assert.equal(dirty.untrackedCount, 1);
  assert.equal(dirty.conflictedCount, 0);

  git(repo, ["reset", "--hard"]);
  rmSync(join(repo, "untracked.txt"));
  const linked = join(root, "linked");
  git(repo, ["worktree", "add", "-b", "linked-branch", linked, "main"]);
  const linkedStatus = await gitStatus(linked);
  assert.equal(linkedStatus.worktreeKind, "linked");
  assert.equal(linkedStatus.branch, "linked-branch");
  assert.equal(linkedStatus.remoteRefsAt, summary.remoteRefsAt);

  git(repo, ["checkout", "--detach"]);
  const detached = await gitStatus(repo);
  assert.equal(detached.branch, "HEAD");
  assert.equal(detached.detached, true);
  assert.match(detached.headSha ?? "", /^[0-9a-f]{12}$/);

  git(repo, ["checkout", "-b", "local-only"]);
  const noUpstream = await gitStatus(repo);
  assert.equal(noUpstream.upstreamBranch, null);
  assert.equal(noUpstream.aheadUpstream, null);
  assert.equal(noUpstream.behindUpstream, null);
});

test("Git facts preserve unborn, shallow, bare, rebase, and conflicted states", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-git-edge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const unborn = join(root, "unborn");
  mkdirSync(unborn);
  git(unborn, ["init", "-b", "main"]);
  const unbornStatus = await gitStatus(unborn);
  assert.equal(unbornStatus.branch, "main");
  assert.equal(unbornStatus.headSha, null);
  assert.equal(unbornStatus.detached, false);
  assert.equal(unbornStatus.baseRef, null);
  assert.equal(unbornStatus.upstreamBranch, null);
  assert.equal(unbornStatus.aheadUpstream, null);
  assert.equal(unbornStatus.behindUpstream, null);
  assert.equal(unbornStatus.remoteRefsAt, null);

  const source = initRepository(root, "source");
  for (let index = 1; index <= 2; index++) {
    writeFileSync(join(source, "tracked.txt"), "source " + index + "\n");
    git(source, ["commit", "-am", "source " + index]);
  }
  const shallow = join(root, "shallow");
  git(root, ["clone", "--depth", "1", "--no-local", source, shallow]);
  assert.equal((await gitStatus(shallow)).shallow, true);

  const bare = join(root, "bare.git");
  mkdirSync(bare);
  git(bare, ["init", "--bare", "--initial-branch=main"]);
  const bareStatus = await gitStatus(bare);
  assert.equal(bareStatus.worktreeKind, "primary");
  assert.equal(bareStatus.headSha, null);
  assert.equal(bareStatus.baseRef, null);
  assert.equal((await runGitAction(bare, { kind: "status" }, { useWorktree: false })).status?.worktreeKind, "primary");

  const rebase = initRepository(root, "rebase");
  git(rebase, ["checkout", "-b", "topic"]);
  writeFileSync(join(rebase, "tracked.txt"), "topic\n");
  git(rebase, ["commit", "-am", "topic"]);
  git(rebase, ["checkout", "main"]);
  writeFileSync(join(rebase, "tracked.txt"), "main\n");
  git(rebase, ["commit", "-am", "main"]);
  git(rebase, ["checkout", "topic"]);
  git(rebase, ["rebase", "main"], true);

  const rebasing = await gitStatus(rebase);
  assert.equal(rebasing.operation, "rebase");
  assert.equal(rebasing.conflictedCount, 1);
  assert.ok((rebasing.stagedCount ?? 0) >= 1);
  assert.ok((rebasing.modifiedCount ?? 0) >= 1);
});

test("legacy divergence falls back to the configured upstream without a default-base ref", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-git-upstream-fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  mkdirSync(remote);
  git(remote, ["init", "--bare", "--initial-branch=develop"]);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "develop"]);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "develop"]);
  writeFileSync(join(repo, "tracked.txt"), "ahead\n");
  git(repo, ["commit", "-am", "ahead"]);

  const status = await gitStatus(repo);
  assert.equal(status.baseRef, null);
  assert.equal(status.upstreamBranch, "origin/develop");
  assert.equal(status.aheadUpstream, 1);
  assert.equal(status.behindUpstream, 0);
  assert.equal(status.ahead, 1);
  assert.equal((await gitSummary(repo)).behind, 0);
});
