import assert from "node:assert/strict";
import { test } from "node:test";
import { ReviewerSecurity } from "./reviewer-security.js";

test("reviewer security defaults Strict and ignores stale or malformed control-plane updates", () => {
  const state = new ReviewerSecurity();
  assert.equal(state.policy, "strict");
  assert.equal(state.apply({ policy: "personal_machine", revision: 1 }), true);
  assert.equal(state.policy, "personal_machine");
  assert.equal(state.apply({ policy: "strict", revision: 0 }), false);
  assert.equal(state.apply({ policy: "strict", revision: 1 }), false);
  assert.equal(state.apply({ policy: "strict", revision: NaN }), false);
  assert.equal(state.policy, "personal_machine");
  assert.equal(state.apply({ policy: "strict", revision: 2 }), true);
  assert.equal(state.policy, "strict");
});

test("registration replaces an earlier connection's policy even after the server revision resets", () => {
  const state = new ReviewerSecurity();
  state.apply({ policy: "personal_machine", revision: 8 });
  assert.equal(state.register({ policy: "strict", revision: 0 }), true);
  assert.equal(state.policy, "strict");
  assert.equal(state.apply({ policy: "personal_machine", revision: 1 }), true);
  assert.equal(state.policy, "personal_machine");
  assert.equal(state.register(), true, "an older server has no policy and restores Strict");
  assert.equal(state.policy, "strict");
  state.apply({ policy: "personal_machine", revision: 4 });
  state.register({ policy: "personal_machine", revision: NaN });
  assert.equal(state.policy, "strict", "malformed registration never retains a relaxed policy");
});
