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

test("a proven base merge with a conflict resolution gets a delta round that does not use the epoch's budget (#4075)", () => {
  const exhausted = history({ validRounds: 4, lastValid: { ...history().lastValid!, round: 4 },
    lastAttempt: { headSha: A, round: 4, attempt: 1, valid: true }, baseMergeRounds: true });
  assert.deepEqual(planReviewRound(exhausted, { headSha: B }, true, "resolution"),
    { epoch: 1, round: 5, attempt: 1, mode: "delta", since: A, openFindings: [finding], baseMerge: true });
  // The same with rounds left: still free, still scoped to the merge.
  assert.deepEqual(planReviewRound(history({ baseMergeRounds: true }), { headSha: B }, true, "resolution"),
    { epoch: 1, round: 2, attempt: 1, mode: "delta", since: A, openFindings: [finding], baseMerge: true });
  // A retry of an invalid base-merge attempt keeps its round and the attempt limit.
  const retrying = { ...exhausted, lastAttempt: { headSha: B, round: 5, attempt: 1, valid: false }, consumedInLastRound: 1 };
  assert.deepEqual(planReviewRound(retrying, { headSha: B }, true, "resolution"),
    { epoch: 1, round: 5, attempt: 2, mode: "delta", since: A, openFindings: [finding], baseMerge: true });
  assert.deepEqual(planReviewRound({ ...retrying, consumedInLastRound: 2 }, { headSha: B }, true, "resolution"),
    { refusal: REVIEW_ROUND_REFUSALS.attemptLimit });
  // An ordinary fix pushed after an invalid base-merge attempt cannot inherit its free round.
  const freeRetry = { ...retrying, lastAttempt: { ...retrying.lastAttempt, baseMerge: true as const } };
  assert.deepEqual(planReviewRound(freeRetry, { headSha: C }, true, null), { refusal: REVIEW_ROUND_REFUSALS.roundLimit });
  assert.equal((planReviewRound(freeRetry, { headSha: B }, true, "resolution") as { attempt: number }).attempt, 2);
  // With rounds left, the ordinary head simply retries the round, as any retry does.
  assert.equal((planReviewRound({ ...freeRetry, validRounds: 3 }, { headSha: C }, true, null) as { round: number }).round, 5);
});

test("a pure base merge onto an upvoted head records an equivalence instead of a review (#4075)", () => {
  const upvoted = history({ validRounds: 4, lastValid: { ...history().lastValid!, round: 4, vote: "UPVOTE", findings: [] },
    lastAttempt: { headSha: A, round: 4, attempt: 1, valid: true }, baseMergeRounds: true });
  assert.deepEqual(planReviewRound(upvoted, { headSha: B }, true, "equivalent"),
    { epoch: 1, round: 5, attempt: 1, mode: "equivalent", equivalentTo: A, baseMerge: true, openFindings: [] });
  // After a downvote there is nothing to carry: the free round reviews the merge (an empty delta is refused by the runner).
  assert.deepEqual(planReviewRound({ ...upvoted, lastValid: { ...upvoted.lastValid!, vote: "DOWNVOTE", findings: [finding] } }, { headSha: B }, true, "equivalent"),
    { epoch: 1, round: 5, attempt: 1, mode: "delta", since: A, openFindings: [finding], baseMerge: true });
});

test("anything but a proven base merge on the last valid head counts as before (#4075)", () => {
  const exhausted = history({ validRounds: 4, lastValid: { ...history().lastValid!, round: 4 },
    lastAttempt: { headSha: A, round: 4, attempt: 1, valid: true }, baseMergeRounds: true });
  // A non-merge fix after the budget is used still needs an extension.
  assert.deepEqual(planReviewRound(exhausted, { headSha: B }, true, null), { refusal: REVIEW_ROUND_REFUSALS.roundLimit });
  // A control plane that does not count base merges (an older peer) keeps counting them.
  assert.deepEqual(planReviewRound({ ...exhausted, baseMergeRounds: undefined }, { headSha: B }, true, "resolution"),
    { refusal: REVIEW_ROUND_REFUSALS.roundLimit });
  assert.deepEqual(planReviewRound({ ...exhausted, baseMergeRounds: undefined }, { headSha: B }, true, "equivalent"),
    { refusal: REVIEW_ROUND_REFUSALS.roundLimit });
  // A requested full review is never a base-merge round.
  assert.deepEqual(planReviewRound(exhausted, { headSha: B, fullReason: "all of it" }, true, "resolution"),
    { refusal: REVIEW_ROUND_REFUSALS.roundLimit });
  // Unproven ancestry is a rewrite, whatever the runner claimed.
  assert.equal((planReviewRound(exhausted, { headSha: B }, null, "resolution") as { epoch: number }).epoch, 2);
  // Before any valid round there is no reviewed head to merge onto.
  const noValid = history({ lastValid: null, validRounds: 0, lastAttempt: { headSha: A, round: 1, attempt: 1, valid: false }, baseMergeRounds: true });
  assert.equal((planReviewRound(noValid, { headSha: B }, true, "equivalent") as { mode: string }).mode, "full");
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


test("a post-upvote grant forces its first round and retry to review only the approved delta", () => {
  const run = history({ validRounds: 4, roundBudget: 5, postUpvoteExtension: { headSha: B, upvotedHeadSha: A },
    lastValid: { headSha: A, baseSha: BASE, round: 4, vote: "UPVOTE", findings: [] },
    lastAttempt: { headSha: A, round: 4, attempt: 1, valid: true } });
  assert.deepEqual(planReviewRound({ ...run, roundBudget: 4 }, { headSha: B }, true), { refusal: REVIEW_ROUND_REFUSALS.roundLimit });
  assert.deepEqual(planReviewRound(run, { headSha: B, fullReason: "all files" }, true),
    { epoch: 1, round: 5, attempt: 1, mode: "delta", since: A, openFindings: [] });
  const retry = { ...run, lastAttempt: { headSha: B, round: 5, attempt: 1, valid: false }, consumedInLastRound: 1 };
  assert.deepEqual(planReviewRound(retry, { headSha: B, fullReason: "all files" }, true),
    { epoch: 1, round: 5, attempt: 2, mode: "delta", since: A, openFindings: [] });
  assert.deepEqual(planReviewRound(retry, { headSha: C, fullReason: "all files" }, true),
    { epoch: 1, round: 5, attempt: 2, mode: "delta", since: A, openFindings: [] });
  assert.deepEqual(planReviewRound({ ...retry, consumedInLastRound: 2 }, { headSha: B }, true), { refusal: REVIEW_ROUND_REFUSALS.attemptLimit });
  assert.deepEqual(planReviewRound(run, { headSha: A }, true), { refusal: REVIEW_ROUND_REFUSALS.upvoted });
});
