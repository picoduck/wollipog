import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewAttemptVerdictView } from "@wollipog/protocol";
import {
  reportFindingDetail, reportFindingLocation, reviewRunProblem, reviewRunRound, reviewRunState, reviewRunTitle,
} from "./review-run-copy.js";

const verdict = (over: Partial<ReviewAttemptVerdictView> = {}): ReviewAttemptVerdictView => ({
  valid: true, consumed: true, effectiveVote: "UPVOTE", failureClass: null, validationErrors: [], ...over,
});

test("a review is named for its reviewer, the other model family", () => {
  assert.equal(reviewRunTitle("codex"), "Codex Review");
  assert.equal(reviewRunTitle("claude-code"), "Claude Review");
});

test("a review's one state is where it is while it runs, then its verdict", () => {
  assert.equal(reviewRunState({ state: "requested", verdict: null }), "requested");
  assert.equal(reviewRunState({ state: "running", verdict: null }), "running");
  assert.equal(reviewRunState({ state: "cancelled", verdict: null }), "canceled");
  assert.equal(reviewRunState({ state: "completed", verdict: verdict() }), "upvote");
  assert.equal(reviewRunState({ state: "completed", verdict: verdict({ effectiveVote: "DOWNVOTE" }) }), "downvote");
  assert.equal(reviewRunState({ state: "completed", verdict: verdict({ valid: false, effectiveVote: "INVALID" }) }), "invalid");
  assert.equal(reviewRunState({ state: "completed", verdict: null }), "unvalidated", "an older runner does not check reports");
  // A counted attempt with no usable report is invalid; a timeout or a failure before the reviewer ran is a failure.
  assert.equal(reviewRunState({ state: "failed", verdict: verdict({ valid: false, effectiveVote: "INVALID", failureClass: "evidence_contract" }) }), "invalid");
  assert.equal(reviewRunState({ state: "failed", verdict: verdict({ valid: false, consumed: false, effectiveVote: null, failureClass: "timeout" }) }), "failed");
  assert.equal(reviewRunState({ state: "failed", verdict: null }), "failed");
});

test("a review's round names its epoch, a retried attempt and what it reviewed", () => {
  assert.equal(reviewRunRound(null), null);
  const round = { epoch: 2, round: 1, attempt: 1, mode: "rebase" as const, baseSha: "b".repeat(40), scopeFiles: [] };
  assert.equal(reviewRunRound(round), "Round 1 · Epoch 2 · Range-Diff After Rewrite");
  assert.equal(reviewRunRound({ ...round, attempt: 2, mode: "full" }), "Round 1 · Epoch 2 · Attempt 2 · Full Review");
});

test("a review that ended without a vote says why: the contract's first reasons, or the runner's", () => {
  const errors = ["one", "two", "three", "four", "five"];
  assert.equal(reviewRunProblem({ state: "completed", verdict: verdict({ valid: false, validationErrors: errors }), reason: null }),
    "One; two; three; and 2 more.");
  assert.equal(reviewRunProblem({ state: "failed", verdict: null, reason: "the reviewer timed out" }), "The reviewer timed out.");
  assert.equal(reviewRunProblem({ state: "completed", verdict: verdict(), reason: null }), null);
  assert.equal(reviewRunProblem({ state: "running", verdict: null, reason: null }), null);
});

test("a finding points at its file and line, or the file alone", () => {
  assert.deepEqual(reportFindingLocation({ file: "src/checkout/Cart.tsx", line: 54 }),
    { label: "Cart.tsx:54", title: "src/checkout/Cart.tsx:54", source: { path: "src/checkout/Cart.tsx", line: 54 } });
  assert.deepEqual(reportFindingLocation({ file: "docs/guide.md", line: null }),
    { label: "guide.md", title: "docs/guide.md", source: { path: "docs/guide.md" } });
  assert.equal(reportFindingDetail({ scenario: "S.", evidence: "E.", verify: "V." }), "S. Evidence: E. Verify: V.");
});
