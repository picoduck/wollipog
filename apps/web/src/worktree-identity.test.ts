import assert from "node:assert/strict";
import test from "node:test";
import {
  displayBaseRef,
  isConventionalDefaultBaseRef,
  matchesDefaultBranch,
  pullRequestStateLabel,
} from "./worktree-identity.js";

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

test("a reported default branch decides the base ref, whatever it is called", () => {
  // The case #679 exists for: `develop` is the default, so a deliberate `origin/main` base is
  // information the row must keep. The name heuristic alone suppressed it.
  assert.equal(displayBaseRef({ baseRef: "origin/main", defaultBranch: "develop" }), "origin/main");
  assert.equal(displayBaseRef({ baseRef: "origin/develop", defaultBranch: "develop" }), null);
  assert.equal(displayBaseRef({ baseRef: "develop", defaultBranch: "develop" }), null);
  assert.equal(displayBaseRef({ baseRef: "refs/heads/develop", defaultBranch: "develop" }), null);
  assert.equal(displayBaseRef({ baseRef: "refs/remotes/origin/develop", defaultBranch: "develop" }), null);
  assert.equal(displayBaseRef({ baseRef: "  origin/develop  ", defaultBranch: "  develop  " }), null);
});

test("a trunk-default repository hides trunk and shows main", () => {
  assert.equal(displayBaseRef({ baseRef: "origin/trunk", defaultBranch: "trunk" }), null);
  assert.equal(displayBaseRef({ baseRef: "origin/master", defaultBranch: "trunk" }), "origin/master");
});

test("a default branch containing a slash is compared whole", () => {
  // Never reduce `release/2027` to `2027` on the way to a comparison.
  assert.equal(displayBaseRef({ baseRef: "origin/release/2027", defaultBranch: "release/2027" }), null);
  assert.equal(displayBaseRef({ baseRef: "origin/release/2028", defaultBranch: "release/2027" }), "origin/release/2028");
  assert.equal(matchesDefaultBranch("2027", "release/2027"), false);
});

test("an unreported default branch falls back to the conventional guess, not to hiding", () => {
  // A runner older than this field, or a repository with no recorded remote HEAD. The row must
  // degrade to the behaviour shipped in #664 rather than start suppressing refs it cannot vouch for.
  assert.equal(displayBaseRef({ baseRef: "origin/main" }), null);
  assert.equal(displayBaseRef({ baseRef: "origin/develop" }), "origin/develop");
  assert.equal(displayBaseRef({ baseRef: "origin/main", defaultBranch: "" }), null);
  assert.equal(displayBaseRef({ baseRef: "origin/main", defaultBranch: "   " }), null);
  assert.equal(displayBaseRef({ baseRef: "origin/develop", defaultBranch: undefined }), "origin/develop");
});

test("matchesDefaultBranch accepts the spellings Git produces and nothing else", () => {
  for (const ref of ["main", "origin/main", "upstream/main", "refs/heads/main", "refs/remotes/origin/main"]) {
    assert.equal(matchesDefaultBranch(ref, "main"), true, ref);
  }
  for (const ref of ["mainline", "main-line", "fork/main", "origin/origin/main", "feature/main"]) {
    assert.equal(matchesDefaultBranch(ref, "main"), false, ref);
  }
});
