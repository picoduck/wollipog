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

test("a refused worktree gets a next step in words, never a command to run inside the agent-managed worktree", () => {
  for (const reason of REFUSALS) {
    const action = worktreeRefusalAction(reason);
    assert.deepEqual(Object.keys(action).sort(), ["kind", "text"], `${reason}: no command field`);
    assert.equal(action.kind, "person", reason);
    assert.ok(action.text.length > 0, `${reason}: says what settles it`);
    assert.doesNotMatch(action.text, /`|\bgit\b|\bgh\b|\bcd\b|\bpnpm\b|\bnpm\b|\bmake\b|-C\b|\$\(|\|/u,
      `${reason}: names no tool to run in the worktree`);
    assert.doesNotMatch(action.text, /--force|reset --hard|\bclean\b|\bprune\b|\bdiscard\b|worktree remove/u,
      `${reason}: never removes, resets, cleans or discards anything`);
  }
  // Each reason keeps its own guidance.
  assert.equal(worktreeRefusalAction(REFUSALS[4]!).text,
    "Review the child's work from its session in Wollipog. Ask its session or the Orchestrator to commit and push the " +
    "changes you want to keep, or confirm they are not needed. Then ask the Orchestrator to retire the worktree through Wollipog.");
  assert.match(worktreeRefusalAction("the branch has unpushed commits").text, /push the commits you want to keep/u);
  assert.match(worktreeRefusalAction("the branch has no upstream").text, /push the branch if its commits are needed/u);
  assert.match(worktreeRefusalAction("attached operator-owned worktrees are not retired").text, /Wollipog leaves it in place/u);
  assert.match(worktreeRefusalAction("the linked pull request is not verified as merged").text,
    /Wollipog retires the worktree once the forge reports the merge/u);
  assert.match(worktreeRefusalAction("a reason this version does not know").text, /Decide what to keep\. Then ask the Orchestrator/u);
  for (const reason of ["the worktree has uncommitted changes", "the branch has unpushed commits", "the branch has no upstream", "runner ownership could not be proven"]) {
    assert.match(worktreeRefusalAction(reason).text, /retire the worktree through Wollipog\.$/u, reason);
  }
});

test("cleanup reasons read as sentences, and a branch's deletion command names exactly that branch (#4146)", () => {
  assert.equal(cleanupReasonSentence("the worktree has uncommitted changes"), "The worktree has uncommitted changes.");
  assert.equal(cleanupReasonSentence("The merged branch is still on the remote."), "The merged branch is still on the remote.");
  assert.equal(cleanupReasonSentence("  "), "");
  assert.equal(mergedBranchDeletionCommand("picoduck/wollipog", "agent/s_1", 7),
    "gh api -X DELETE 'repos/picoduck/wollipog/git/refs/heads/agent/s_1'");
  assert.match(mergedBranchDeletionCommand("picoduck/wollipog", null, 7), /gh pr view 7 -R 'picoduck\/wollipog' --json headRefName/u);
});
