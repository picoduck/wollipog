import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ORCHESTRATOR_REVIEW_POLICY, parseOrchestratorReviewPolicy } from "./orchestrator-review-policy.js";

test("missing review fields retain Automatic while fixed fields preserve their exact values", () => {
  assert.deepEqual(parseOrchestratorReviewPolicy({}), DEFAULT_ORCHESTRATOR_REVIEW_POLICY);
  const fixed = { reviewHarness: "codex", reviewModel: "gpt-6.1-sol", reviewEffort: "high", reviewRoundBudget: 6 };
  assert.deepEqual(parseOrchestratorReviewPolicy(fixed), fixed);
  assert.deepEqual(parseOrchestratorReviewPolicy({ ...fixed, reviewModel: null }), { ...fixed, reviewModel: null });
});

test("review policy rejects unrecognized harnesses, invalid budgets and malformed identifiers", () => {
  for (const invalid of [null, [], { reviewHarness: "shell" }, { reviewRoundBudget: 0 }, { reviewRoundBudget: 33 },
    { reviewRoundBudget: 1.5 }, { reviewRoundBudget: NaN }, { reviewEffort: "" }, { reviewModel: "model\ncommand" }]) {
    assert.equal(parseOrchestratorReviewPolicy(invalid), null);
  }
});
