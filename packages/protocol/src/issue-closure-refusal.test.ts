import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GITHUB_ISSUE_CLOSURE_FAILURE_REASONS, GITHUB_ISSUE_CLOSURE_REFUSAL_REASONS, GITHUB_ISSUE_CLOSURE_RESULT_REFUSAL_REASONS,
  GITHUB_ISSUE_CLOSURE_RUNNER_ERROR_MAX, githubIssueClosureRefusal, githubIssueClosureRefusalReasonText,
  normalizeGithubIssueClosureRefusal,
} from "./index.js";

test("every closure refusal says nothing was written and that a new request is needed", () => {
  for (const reason of GITHUB_ISSUE_CLOSURE_REFUSAL_REASONS) {
    const refusal = githubIssueClosureRefusal(reason);
    assert.equal(refusal.reason, reason);
    assert.equal(refusal.forgeWritten, false);
    assert.equal(refusal.nextStep, "request_new_closure");
    assert.match(refusal.summary, /\. Nothing was written; request a new closure to try again\.$/u);
  }
  // Each reason a runner sends is one of the fixed set.
  for (const reason of [...GITHUB_ISSUE_CLOSURE_RESULT_REFUSAL_REASONS, ...GITHUB_ISSUE_CLOSURE_FAILURE_REASONS]) {
    assert.ok(GITHUB_ISSUE_CLOSURE_REFUSAL_REASONS.includes(reason));
  }
});

test("a closure refusal names its pull requests and the runner's bounded message", () => {
  const refusal = githubIssueClosureRefusal("related_pull_requests_changed", { pullRequests: [78, 77, 78, 0, -1, 1.5] });
  assert.deepEqual(refusal.pullRequests, [77, 78]);
  assert.equal(refusal.summary,
    "The related open pull requests changed after the closure was requested: #77, #78. Nothing was written; request a new closure to try again.");
  const failed = githubIssueClosureRefusal("evidence_unavailable", { runnerError: `  ${"x".repeat(1000)}  ` });
  assert.equal(failed.runnerError?.length, GITHUB_ISSUE_CLOSURE_RUNNER_ERROR_MAX);
  assert.equal(githubIssueClosureRefusalReasonText(githubIssueClosureRefusal("runner_failed", { runnerError: "Repository differs" })),
    "The runner refused the closure. The runner said: Repository differs.");
  assert.equal(githubIssueClosureRefusal("issue_changed", { pullRequests: [] }).pullRequests, undefined);
});

test("a stored or received refusal is rebuilt canonically and an unknown reason reads as unspecified", () => {
  const forged = normalizeGithubIssueClosureRefusal({ reason: "closing_reference_changed", pullRequests: [12], forgeWritten: true,
    nextStep: "retry", summary: "Closed successfully." });
  assert.deepEqual(forged, githubIssueClosureRefusal("closing_reference_changed", { pullRequests: [12] }));
  for (const value of [undefined, null, "refused", { reason: "from_a_newer_peer" }]) {
    assert.equal(normalizeGithubIssueClosureRefusal(value).reason, "unspecified");
  }
});
