import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { managedWorktreeReadOnlyPaths, RUNNER_OWNED_WORKTREE_ENTRIES } from "./managed-worktree-sandbox.js";

const repoPath = resolve("/projects/app");

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
