import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanupReasonSentence, mergedBranchDeletionCommand, worktreeRefusalAction } from "./campaign-activity.js";

/** Every reason the runner refuses a child worktree's retirement with (sessions.ts), plus one it may add later. */
const REFUSALS = [
  "attached operator-owned worktrees are not retired",
  "the worktree has a detached HEAD",
  "the worktree is checked out on branch main",
  "runner ownership could not be proven",
  "the worktree has uncommitted changes (2 paths): \"report.md\", \"notes.txt\"",
  "the branch has no upstream",
  "the branch has unpushed commits",
  "the worktree head is not on the default branch",
  "the linked pull request is not verified as merged",
  "a reason this version does not know",
];

test("a refused worktree is only inspected, and the person keeps or discards its work before Wollipog retires it (#4146)", () => {
  const path = "/home/dev/worktrees/it's here";
  for (const reason of REFUSALS) {
    const action = worktreeRefusalAction(path, reason);
    assert.equal(action.kind, "command", reason);
    assert.match(action.command, /^git -C '\/home\/dev\/worktrees\/it'\\''s here' (status|log --oneline)/u, reason);
    assert.doesNotMatch(action.command, /\b(remove|prune|clean|reset|checkout|restore|stash|rm|push|delete)\b|--force|-f\b/u,
      `${reason}: the command reads only`);
    assert.ok(action.then.length > 0, `${reason}: says what settles it`);
    assert.doesNotMatch(action.then, /--force|reset --hard|git clean/u, reason);
  }
  const dirty = worktreeRefusalAction(path, REFUSALS[4]!);
  assert.equal(dirty.command, "git -C '/home/dev/worktrees/it'\\''s here' status");
  assert.equal(dirty.then, "Commit and push the changes you want to keep, or discard them yourself. Then ask the Orchestrator to retire the worktree through Wollipog.");
  assert.equal(worktreeRefusalAction(path, "the branch has unpushed commits").command,
    "git -C '/home/dev/worktrees/it'\\''s here' log --oneline '@{upstream}..HEAD'");
  assert.match(worktreeRefusalAction(path, "attached operator-owned worktrees are not retired").then, /Wollipog leaves it in place/u);
});

test("cleanup reasons read as sentences, and a branch's deletion command names exactly that branch (#4146)", () => {
  assert.equal(cleanupReasonSentence("the worktree has uncommitted changes"), "The worktree has uncommitted changes.");
  assert.equal(cleanupReasonSentence("The merged branch is still on the remote."), "The merged branch is still on the remote.");
  assert.equal(cleanupReasonSentence("  "), "");
  assert.equal(mergedBranchDeletionCommand("picoduck/wollipog", "agent/s_1", 7),
    "gh api -X DELETE 'repos/picoduck/wollipog/git/refs/heads/agent/s_1'");
  assert.match(mergedBranchDeletionCommand("picoduck/wollipog", null, 7), /gh pr view 7 -R 'picoduck\/wollipog' --json headRefName/u);
});
