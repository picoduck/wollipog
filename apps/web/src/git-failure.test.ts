import assert from "node:assert/strict";
import { test } from "node:test";
import { describeGitFailure } from "./git-failure.js";

const REJECTED = `Command failed: git push -u origin agent/fix
To github.com:acme/shop.git
 ! [rejected]        agent/fix -> agent/fix (fetch first)
error: failed to push some refs to 'github.com:acme/shop.git'
hint: Updates were rejected because the remote contains work that you do not have locally.`;

test("a rejected push says why in plain words and keeps Git's output for Show Details", () => {
  const failure = describeGitFailure("push", REJECTED);
  assert.equal(failure.sentence,
    "The remote rejected the push because it has commits this branch doesn't. Bring the branch up to date, then try again.");
  assert.equal(failure.detail, REJECTED);
});

test("a push refused by the remote itself is not read as an out-of-date branch", () => {
  const failure = describeGitFailure("push", ` ! [remote rejected] agent/fix -> agent/fix (pre-receive hook declined)
error: failed to push some refs to 'origin'`);
  assert.equal(failure.sentence, "The remote refused the push. Show Details has its reason.");
});

test("a missing remote and a failed sign-in each have their own sentence", () => {
  assert.equal(describeGitFailure("push", "Command failed: git remote get-url origin\nerror: No such remote 'origin'").sentence,
    "This branch has no remote to push to. Add a remote named origin, then try again.");
  for (const output of [
    "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/acme/shop.git/'",
    "git@github.com: Permission denied (publickey).",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  ]) {
    assert.equal(describeGitFailure("push", output).sentence,
      "Git couldn't sign in to the remote. Check this machine's Git credentials, then try again.", output);
  }
});

test("the runner's partial-stage refusal names the request kind", () => {
  const output = "this worktree has a partially staged change-set — press Commit first (it commits only the staged hunks), or stage/commit everything, then open the PR";
  assert.equal(describeGitFailure("push", output).sentence,
    "Some changes are staged and some aren't. Commit the staged changes first, then open the pull request.");
  assert.equal(describeGitFailure("push", output, "Merge Request").sentence,
    "Some changes are staged and some aren't. Commit the staged changes first, then open the merge request.");
});

test("an unknown failure falls back to what was being done, never the raw output", () => {
  assert.deepEqual(describeGitFailure("commit", "fatal: unable to write new index file"), {
    sentence: "Couldn't commit the changes. Try again.",
    detail: "fatal: unable to write new index file",
  });
  assert.equal(describeGitFailure("push", "runner is offline").sentence, "Couldn't push the branch. Try again.");
  assert.equal(describeGitFailure("commit", "nothing to commit — the worktree has no changes").sentence,
    "There's nothing to commit.");
});
