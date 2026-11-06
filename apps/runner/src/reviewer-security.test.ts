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
