import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { protectedWorktreeGitConfig } from "./spawn.js";

/**
 * Ordinary Git in a repository with a protected worktree's shape: the worktree, its admin directory
 * and the common objects, refs and logs are writable; the common directory, its config and
 * packed-refs are not. Permissions stand in for the read-only binds so this runs without bubblewrap;
 * `managed-worktree-sandbox.integration.test.ts` runs the same flows in a real sandbox.
 */
const CANNOT_EMULATE = process.platform === "win32" ? "POSIX permissions are required"
  : process.getuid?.() === 0 ? "root ignores the permissions this fixture relies on" : false;

const ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: "true", GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function fixture(t: { after(fn: () => void): void }, inherited?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-protected-worktree-git-")));
  const repo = join(root, "repo"), worktree = join(root, "worktree"), common = join(repo, ".git");
  const run = (cwd: string, args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"], env: { ...ENV, ...env } });
    return { status: result.status, signal: result.signal, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };
  const setup = (args: string[]) => {
    const result = run(repo, args);
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.output}`);
  };
  mkdirSync(repo);
  setup(["init", "--quiet", "--initial-branch=main", "."]);
  setup(["config", "rerere.enabled", "true"]);
  writeFileSync(join(repo, "f.txt"), "base\n");
  setup(["add", "f.txt"]);
  setup(["commit", "--quiet", "-m", "base"]);
  setup(["branch", "side"]);
  setup(["branch", "feature"]);
  setup(["switch", "--quiet", "side"]);
  writeFileSync(join(repo, "f.txt"), "side\n");
  setup(["commit", "--quiet", "-am", "side"]);
  setup(["switch", "--quiet", "main"]);
  setup(["worktree", "add", "--quiet", worktree, "feature"]);
  setup(["pack-refs", "--all"]);
  // A resolution someone recorded earlier: it must neither change nor grow.
  const recorded = join(common, "rr-cache", "0".repeat(40));
  mkdirSync(recorded, { recursive: true });
  writeFileSync(join(recorded, "postimage"), "recorded\n");
  const readOnly = [common, join(common, "worktrees"), join(common, "rr-cache"), recorded];
  for (const path of readOnly) chmodSync(path, 0o555);
  for (const path of [join(common, "config"), join(common, "packed-refs")]) chmodSync(path, 0o444);
  t.after(() => {
    for (const path of readOnly) chmodSync(path, 0o755);
    rmSync(root, { recursive: true, force: true });
  });
  const admin = join(common, "worktrees", "worktree");
  // Each command as a process inside the boundary runs it.
  const git = (...args: string[]) => run(worktree, args, { GIT_CONFIG_PARAMETERS: protectedWorktreeGitConfig(inherited) });
  const edit = (content: string) => writeFileSync(join(worktree, "f.txt"), `${content}\n`);
  const log = () => run(worktree, ["log", "--format=%s", "-3"]).output.trim().split("\n");
  const recordedResolutions = () => readdirSync(join(common, "rr-cache"));
  assert.equal(git("commit", "--quiet", "--allow-empty", "-m", "start").status, 0);
  edit("feature");
  assert.equal(git("commit", "--quiet", "-am", "feature").status, 0);
  return { common, admin, worktree, git, edit, log, recordedResolutions };
}

test("a conflicted merge commits cleanly, and so does every commit after it", { skip: CANNOT_EMULATE }, (t) => {
  const f = fixture(t);
  assert.equal(f.git("merge", "--no-edit", "side").status, 1, "the conflict");
  f.edit("resolved");
  assert.equal(f.git("add", "f.txt").status, 0);
  const merged = f.git("commit", "--no-edit");
  assert.equal(merged.signal, null, merged.output);
  assert.equal(merged.status, 0, merged.output);
  assert.equal(f.log()[0], "Merge branch 'side' into feature");
  assert.equal(existsSync(join(f.admin, "MERGE_RR.lock")), false, "no lock is left to fail later commits");
  f.edit("later");
  const later = f.git("commit", "--quiet", "-am", "later");
  assert.equal(later.status, 0, later.output);
  assert.deepEqual(f.recordedResolutions(), ["0".repeat(40)], "the shared resolutions are untouched");
});

test("a conflicted rebase and cherry-pick finish, leaving only refs the runner can clear", { skip: CANNOT_EMULATE }, (t) => {
  const rebase = fixture(t);
  assert.equal(rebase.git("rebase", "side").status, 1, "the conflict");
  rebase.edit("resolved");
  assert.equal(rebase.git("add", "f.txt").status, 0);
  const rebased = rebase.git("rebase", "--continue");
  assert.equal(rebased.signal, null, rebased.output);
  assert.equal(rebased.status, 0, rebased.output);
  assert.match(rebased.output, /packed-refs\.lock/u, "the documented lock error remains");
  assert.equal(existsSync(join(rebase.admin, "rebase-merge")), false, "the rebase ended");
  assert.equal(rebase.log()[0], "feature");
  assert.equal(existsSync(join(rebase.admin, "MERGE_RR.lock")), false);

  const pick = fixture(t);
  assert.equal(pick.git("cherry-pick", "side").status, 1, "the conflict");
  pick.edit("resolved");
  assert.equal(pick.git("add", "f.txt").status, 0);
  const picked = pick.git("cherry-pick", "--continue");
  assert.equal(picked.signal, null, picked.output);
  assert.equal(picked.status, 0, picked.output);
  assert.equal(pick.log()[0], "side");
  assert.equal(existsSync(join(pick.admin, "MERGE_RR.lock")), false);
});

test("a lock an earlier launch left behind no longer fails commits", { skip: CANNOT_EMULATE }, (t) => {
  const f = fixture(t);
  writeFileSync(join(f.admin, "MERGE_RR.lock"), "");
  f.edit("after the lock");
  const committed = f.git("commit", "--quiet", "-am", "after the lock");
  assert.equal(committed.status, 0, committed.output);
});

test("settings the launch already carried still apply, and a conflict still commits", { skip: CANNOT_EMULATE }, (t) => {
  const f = fixture(t, "'core.hooksPath=/dev/null' 'core.fsmonitor=false' 'rerere.enabled=true'");
  assert.equal(f.git("config", "--get", "core.hooksPath").output.trim(), "/dev/null");
  assert.equal(f.git("config", "--type=bool", "--get", "core.fsmonitor").output.trim(), "false");
  assert.equal(f.git("config", "--type=bool", "--get", "rerere.enabled").output.trim(), "false", "rerere stays off even when asked for");
  assert.equal(f.git("merge", "--no-edit", "side").status, 1, "the conflict");
  f.edit("resolved");
  assert.equal(f.git("add", "f.txt").status, 0);
  const merged = f.git("commit", "--no-edit");
  assert.equal(merged.status, 0, merged.output);
});

test("a command that asks for its own configuration keeps it, beside rerere staying off", { skip: CANNOT_EMULATE }, (t) => {
  const f = fixture(t);
  const read = f.git("-c", "user.name=Someone", "config", "--get", "user.name");
  assert.equal(read.output.trim(), "Someone");
  assert.equal(f.git("-c", "user.name=Someone", "config", "--type=bool", "--get", "rerere.enabled").output.trim(), "false");
});
