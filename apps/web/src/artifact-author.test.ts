import assert from "node:assert/strict";
import test from "node:test";
import { artifactAuthorName, type ArtifactAuthorNames } from "./artifact-author.js";
import type { ViewerIdentity } from "./resolver-identity.js";

const solo: ViewerIdentity = { userId: "usr_me", shared: false, names: new Map() };
const team: ViewerIdentity = { userId: "usr_me", shared: true, names: new Map([["usr_ada", "Ada Lovelace"]]) };
const names = (viewer: ViewerIdentity | null): ArtifactAuthorNames => ({
  viewer,
  sessionAgent: (sessionId) => (sessionId === "s_known" ? "Claude" : undefined),
});

test("an agent is named by its session's agent, and is Agent when that session is not loaded (#2855)", () => {
  assert.equal(artifactAuthorName({ kind: "agent", id: "s_known" }, names(solo)), "Claude");
  assert.equal(artifactAuthorName({ kind: "agent", id: "s_unknown" }, names(solo)), "Agent");
  assert.equal(artifactAuthorName({ kind: "agent" }, names(solo)), "Agent");
});

test("a person is You, a member's name or Another Member, and never a user id (#2855, #2527)", () => {
  assert.equal(artifactAuthorName({ kind: "human", id: "usr_me" }, names(solo)), "You");
  assert.equal(artifactAuthorName({ kind: "human", id: "usr_me" }, names(team)), "You");
  assert.equal(artifactAuthorName({ kind: "human", id: "usr_ada" }, names(team)), "Ada Lovelace");
  assert.equal(artifactAuthorName({ kind: "human", id: "usr_7f3a" }, names(team)), "Another Member");
  assert.equal(artifactAuthorName({ kind: "human", id: "usr_me" }, names(null)), null, "unsaid until the viewer is known");
  for (const viewer of [solo, team, null]) {
    for (const kind of ["agent", "human", "policy", "system"] as const) {
      assert.doesNotMatch(artifactAuthorName({ kind, id: "usr_7f3a" }, names(viewer)) ?? "", /usr_/u);
    }
  }
});

test("Wollipog and policies are named by what they are", () => {
  assert.equal(artifactAuthorName({ kind: "system", id: "video-review-v1" }, names(solo)), "Wollipog");
  assert.equal(artifactAuthorName({ kind: "policy", id: "rule_1" }, names(solo)), "Policy");
});
