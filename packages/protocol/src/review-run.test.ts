import assert from "node:assert/strict";
import { test } from "node:test";
import { planReviewRound, REVIEW_ROUND_REFUSALS, type ReviewRunHistory } from "./review-run.js";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), BASE = "0".repeat(40);
const finding = { severity: "high" as const, blocking: true, file: "x.ts", line: 1, title: "t", scenario: "s", evidence: "e", verify: "v" };

function history(overrides: Partial<ReviewRunHistory> = {}): ReviewRunHistory {
  return {
    epoch: 1,
    lastValid: { headSha: A, baseSha: BASE, round: 1, vote: "DOWNVOTE", findings: [finding] },
    lastAttempt: { headSha: A, round: 1, attempt: 1, valid: true },
    validRounds: 1, consumedInLastRound: 1, roundBudget: 4, attemptsPerRound: 2,
    ...overrides,
  };
}

test("the first review of a pull request is a full round 1 of epoch 1", () => {
  assert.deepEqual(planReviewRound({ ...history(), epoch: 0, lastValid: null, lastAttempt: null, validRounds: 0, consumedInLastRound: 0 }, { headSha: A }, null),
    { epoch: 1, round: 1, attempt: 1, mode: "full", openFindings: [] });
});

test("a later round reviews the changes since the last valid head, with its findings", () => {
  assert.deepEqual(planReviewRound(history(), { headSha: B }, true),
    { epoch: 1, round: 2, attempt: 1, mode: "delta", since: A, openFindings: [finding] });
  assert.deepEqual(planReviewRound(history(), { headSha: B, fullReason: "contract changed" }, true),
    { epoch: 1, round: 2, attempt: 1, mode: "full", openFindings: [finding] });
});

test("an invalid attempt is retried in its round until the round's attempts are used", () => {
  const failed = history({ lastAttempt: { headSha: B, round: 2, attempt: 1, valid: false }, consumedInLastRound: 1 });
  assert.deepEqual(planReviewRound(failed, { headSha: B }, true),
    { epoch: 1, round: 2, attempt: 2, mode: "delta", since: A, openFindings: [finding] });
  assert.deepEqual(planReviewRound({ ...failed, consumedInLastRound: 2 }, { headSha: B }, true), { refusal: REVIEW_ROUND_REFUSALS.attemptLimit });
  // An unconsumed attempt (transport failure before any report) does not use the round's budget.
  assert.equal((planReviewRound({ ...failed, consumedInLastRound: 0, lastAttempt: { ...failed.lastAttempt!, attempt: 3 } }, { headSha: B }, true) as { attempt: number }).attempt, 4);
});

test("the round budget, an upvoted head and an unchanged head are refused", () => {
  assert.deepEqual(planReviewRound(history({ validRounds: 4, lastValid: { ...history().lastValid!, round: 4 }, lastAttempt: { headSha: A, round: 4, attempt: 1, valid: true } }), { headSha: B }, true),
    { refusal: REVIEW_ROUND_REFUSALS.roundLimit });
  assert.deepEqual(planReviewRound(history({ lastValid: { ...history().lastValid!, vote: "UPVOTE", findings: [] } }), { headSha: A }, true),
    { refusal: REVIEW_ROUND_REFUSALS.upvoted });
  assert.deepEqual(planReviewRound(history(), { headSha: A }, true), { refusal: REVIEW_ROUND_REFUSALS.unchanged });
  assert.equal((planReviewRound(history(), { headSha: A, fullReason: "recheck" }, true) as { mode: string }).mode, "full");
});

test("a head that does not descend from the reviewed one starts a new epoch over the range-diff", () => {
  const exhausted = history({ validRounds: 4 });
  assert.deepEqual(planReviewRound(exhausted, { headSha: C }, false), {
    epoch: 2, round: 1, attempt: 1, mode: "rebase", rebasedFrom: { baseSha: BASE, headSha: A }, openFindings: [finding],
  }, "the round count resets and findings carry forward");
  assert.equal((planReviewRound(history(), { headSha: C }, null) as { epoch: number }).epoch, 2, "unprovable ancestry counts as a rewrite");
  // Before any valid round, the reference is the last attempt, and the new epoch is a full review.
  const noValid = history({ lastValid: null, validRounds: 0, lastAttempt: { headSha: A, round: 1, attempt: 1, valid: false } });
  assert.deepEqual(planReviewRound(noValid, { headSha: C }, false), { epoch: 2, round: 1, attempt: 1, mode: "full", openFindings: [] });
  // A requested full review is full even across a rewrite; the findings still carry forward.
  assert.deepEqual(planReviewRound(history(), { headSha: C, fullReason: "review everything" }, false),
    { epoch: 2, round: 1, attempt: 1, mode: "full", openFindings: [finding] });
});

test("an invalid first attempt of a rebase epoch is retried over the same range-diff with the carried findings", () => {
  // Epoch 2 started from epoch 1's valid round at A; its first attempt at C was invalid.
  const retrying = history({
    epoch: 2, lastValid: null, carried: { headSha: A, baseSha: BASE, findings: [finding] },
    lastAttempt: { headSha: C, round: 1, attempt: 1, valid: false }, validRounds: 0, consumedInLastRound: 1,
  });
  assert.deepEqual(planReviewRound(retrying, { headSha: C }, true), {
    epoch: 2, round: 1, attempt: 2, mode: "rebase", rebasedFrom: { baseSha: BASE, headSha: A }, openFindings: [finding],
  });
  assert.deepEqual(planReviewRound(retrying, { headSha: C, fullReason: "all of it" }, true),
    { epoch: 2, round: 1, attempt: 2, mode: "full", openFindings: [finding] });
  // Another rewrite before any valid round of epoch 2 still diffs against the last valid review.
  assert.deepEqual(planReviewRound(retrying, { headSha: B }, false), {
    epoch: 3, round: 1, attempt: 1, mode: "rebase", rebasedFrom: { baseSha: BASE, headSha: A }, openFindings: [finding],
  });
});
