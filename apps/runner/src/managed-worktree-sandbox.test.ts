import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import {
  managedWorktreeGitWritableRoots,
  managedWorktreeReadOnlyPaths,
  RUNNER_OWNED_WORKTREE_ENTRIES,
} from "./managed-worktree-sandbox.js";

const repoPath = resolve("/projects/app");

function gitFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-codex-git-roots-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoPath = join(root, "repo");
  const worktreePath = join(root, "selected");
  const siblingPath = join(root, "sibling");
  const commonGitDir = join(repoPath, ".git");
  const worktreeGitDir = join(commonGitDir, "worktrees", "selected");
  for (const path of [worktreePath, siblingPath, worktreeGitDir,
    join(commonGitDir, "objects"), join(commonGitDir, "refs"), join(commonGitDir, "logs")]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(worktreePath, ".git"), `gitdir: ${worktreeGitDir}\n`);
  return { repoPath, worktreePath, siblingPath, commonGitDir, worktreeGitDir };
}

test("every managed worktree contributes its runner-owned link file and nothing else", () => {
  const first = resolve("/worktrees/app/s_one");
  const second = resolve("/worktrees/app/s_two");
  assert.deepEqual(
    managedWorktreeReadOnlyPaths([
      { worktreePath: first, repoPath },
      { worktreePath: second, repoPath },
    ]),
    [resolve(first, ".git"), resolve(second, ".git")],
  );
  assert.deepEqual([...RUNNER_OWNED_WORKTREE_ENTRIES], [".git"]);
});

test("the repository's shared administrative directory stays outside the read-only set", () => {
  // `<repo>/.git` is where Git writes refs, the index, and every worktree's real administrative
  // directory. Freezing it would break the commits this feature must keep working.
  assert.deepEqual(managedWorktreeReadOnlyPaths([{ worktreePath: repoPath, repoPath }]), []);
  const paths = managedWorktreeReadOnlyPaths([
    { worktreePath: resolve("/worktrees/app/s_one"), repoPath },
  ]);
  assert.equal(paths.some((path) => path.startsWith(resolve(repoPath, ".git"))), false);
});

test("repeated protections collapse to one entry per path", () => {
  const worktreePath = resolve("/worktrees/app/s_one");
  assert.deepEqual(
    managedWorktreeReadOnlyPaths([{ worktreePath, repoPath }, { worktreePath, repoPath }]),
    [resolve(worktreePath, ".git")],
  );
});

test("an empty protection list asks for no read-only rules at all", () => {
  // Unmanaged and attached worktrees never reach this function; an in-place session has no
  // worktree identity either. All three must leave the sandbox exactly as it is today.
  assert.deepEqual(managedWorktreeReadOnlyPaths([]), []);
});

test("the selected linked worktree grants only operation-specific Git administrative descendants", (t) => {
  const f = gitFixture(t);
  assert.deepEqual(managedWorktreeGitWritableRoots(f.worktreePath, [
    { worktreePath: f.worktreePath, repoPath: f.repoPath },
    { worktreePath: f.siblingPath, repoPath: f.repoPath },
    { worktreePath: f.worktreePath, repoPath: f.repoPath },
  ]), [
    f.worktreeGitDir,
    join(f.commonGitDir, "objects"),
    join(f.commonGitDir, "refs"),
    join(f.commonGitDir, "logs"),
  ]);
  assert.equal(
    managedWorktreeGitWritableRoots(f.worktreePath, [{ worktreePath: f.worktreePath, repoPath: f.repoPath }])
      .some((path) => path === f.repoPath || path === f.commonGitDir || path.startsWith(f.worktreePath)),
    false,
    "neither primary files, the common .git root, nor the managed .git link become writable roots",
  );
});

test("unmanaged, in-place, unrelated, and malformed workspace identities add no Git grant", (t) => {
  const f = gitFixture(t);
  assert.deepEqual(managedWorktreeGitWritableRoots(f.worktreePath, []), []);
  assert.deepEqual(
    managedWorktreeGitWritableRoots(f.repoPath, [{ worktreePath: f.repoPath, repoPath: f.repoPath }]),
    [],
    "an in-place checkout already owns its .git directory through cwd",
  );
  assert.deepEqual(
    managedWorktreeGitWritableRoots(f.worktreePath, [{ worktreePath: f.siblingPath, repoPath: f.repoPath }]),
    [],
  );
  assert.deepEqual(
    managedWorktreeGitWritableRoots(f.worktreePath, [{ worktreePath: "relative", repoPath: f.repoPath }]),
    [],
  );
  writeFileSync(join(f.worktreePath, ".git"), "gitdir: ../../escape\n");
  assert.deepEqual(
    managedWorktreeGitWritableRoots(f.worktreePath, [{ worktreePath: f.worktreePath, repoPath: f.repoPath }]),
    [],
    "a pointer outside the repository's registered worktree directory grants nothing",
  );
});
