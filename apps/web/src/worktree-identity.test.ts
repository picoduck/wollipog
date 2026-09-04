import assert from "node:assert/strict";
import test from "node:test";
import { displayBaseRef, isConventionalDefaultBaseRef, pullRequestStateLabel } from "./worktree-identity.js";

test("conventional default base refs are recognised through remote and ref prefixes", () => {
  for (const ref of [
    "main",
    "master",
    "origin/main",
    "upstream/master",
    "refs/heads/main",
    "refs/remotes/origin/main",
    "  origin/main  ",
  ]) assert.equal(isConventionalDefaultBaseRef(ref), true, ref);
});

test("anything a reader would not already assume is not a default", () => {
  for (const ref of [
    "develop",
    "fix/issue-664",
    "origin/release-2",
    "mainline",
    "main-line",
    "fork/main",
    "origin/team/main",
  ]) assert.equal(isConventionalDefaultBaseRef(ref), false, ref);
});

test("only one remote prefix is stripped, so a branch named after a remote survives", () => {
  // `origin/origin/main` is a branch literally called `origin/main` on the remote, not the default.
  assert.equal(isConventionalDefaultBaseRef("origin/origin/main"), false);
});

test("the displayed base ref is the one that carries information", () => {
  assert.equal(displayBaseRef({ baseRef: "origin/main" }), null);
  assert.equal(displayBaseRef({ baseRef: undefined }), null);
  assert.equal(displayBaseRef({ baseRef: "   " }), null);
  assert.equal(displayBaseRef({ baseRef: "fix/issue-664" }), "fix/issue-664");
  assert.equal(displayBaseRef({ baseRef: "  develop  " }), "develop");
});

test("pull request states read as Title Case labels", () => {
  assert.equal(pullRequestStateLabel("open"), "Open");
  assert.equal(pullRequestStateLabel("merged"), "Merged");
  assert.equal(pullRequestStateLabel("closed"), "Closed");
});
