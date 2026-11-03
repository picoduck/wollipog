/**
 * Review runs (#3369): the rounds and epochs of one requester's reviews of one pull request.
 *
 * The control plane records every attempt; the runner, which can prove commit ancestry from its
 * mirror, plans each new attempt from that history with `planReviewRound`. The policy is the
 * cross-model-review skill's: at most `roundBudget` valid rounds per epoch and `attemptsPerRound`
 * consumed attempts per round; an invalid attempt is retried in the same round; a later round
 * reviews only the changes since the last valid head, with its open findings; and a head that no
 * longer descends from the reviewed one (a rebase or force-push) starts a new epoch whose first
 * round reviews the range-diff and carries the open findings forward.
 *
 * v277 (#4075): a head whose only change since the last valid round is one merge of the moved base
 * branch is reviewed like a rebase is, without using the epoch's budget. The runner proves that
 * strictly (`ReviewBaseMerge`); anything it cannot prove is an ordinary commit. Such a round reviews
 * only the merge's effect on the pull request's own diff, and a merge that leaves that diff
 * byte-identical to an upvoted head needs no reviewer at all: its equivalence is recorded instead.
 */
import type { ReviewReportFinding } from "./review-contract.js";

/** `equivalent`: no reviewer ran; the head was proven equivalent to an upvoted head (v277). */
export type ReviewRoundMode = "full" | "delta" | "rebase" | "equivalent";

/**
 * What the runner proved about a head relative to the epoch's last valid head (v277): it is a single
 * two-parent merge whose first parent is that head and whose second is a moved commit of the pull
 * request's base branch, and the merge's tree differs from Git's own merge only inside conflicted
 * hunks. `equivalent` also proves the pull request's own diff is unchanged, file for file and byte
 * for byte; `resolution` is every other such merge.
 */
export type ReviewBaseMerge = "equivalent" | "resolution";

/** What the control plane knows of a run's current epoch, sent with each new review session. */
export interface ReviewRunHistory {
  /** 0 before the first attempt. */
  epoch: number;
  /** The epoch's last valid attempt. */
  lastValid: {
    headSha: string;
    baseSha: string;
    round: number;
    vote: "UPVOTE" | "DOWNVOTE";
    /** Its findings, carried into the next round's prompt. */
    findings: ReviewReportFinding[];
  } | null;
  /** Before the epoch's first valid round: the earlier epoch's last valid round it started from.
   * Its findings stay open, and a retry of the epoch's first round still reviews the range-diff. */
  carried?: { headSha: string; baseSha: string; findings: ReviewReportFinding[] } | null;
  /** The epoch's most recent attempt, valid or not. `baseMerge` (v277): its round was a base-merge
   * round, which the budget never admitted. */
  lastAttempt: { headSha: string; round: number; attempt: number; valid: boolean; baseMerge?: true } | null;
  /** Valid rounds in the epoch. */
  validRounds: number;
  /** Consumed attempts in the most recent attempt's round. */
  consumedInLastRound: number;
  /** v237: a post-upvote grant forces delta scope until the next valid round. */
  postUpvoteExtension?: { headSha: string; upvotedHeadSha: string };
  /** v277: the control plane counts base-merge rounds outside the budget and records
   * equivalences. Without it, a base merge is an ordinary delta round. */
  baseMergeRounds?: true;
  roundBudget: number;
  attemptsPerRound: number;
}

export interface ReviewRoundPlan {
  epoch: number;
  round: number;
  attempt: number;
  mode: ReviewRoundMode;
  /** Delta rounds review the changes since this head. */
  since?: string;
  /** Rebase rounds review the range-diff from this earlier base and head. */
  rebasedFrom?: { baseSha: string; headSha: string };
  /** Findings carried into the prompt for the reviewer to report again or drop. */
  openFindings: ReviewReportFinding[];
  /** v277: a base-merge round, which does not count against the epoch's budget. */
  baseMerge?: true;
  /** v277, with mode `equivalent`: the upvoted head this head is equivalent to. */
  equivalentTo?: string;
}

/** Fixed refusal reasons for a round that cannot start. */
export const REVIEW_ROUND_REFUSALS = {
  upvoted: "this head already has an upvote",
  unchanged: "the head has not changed since the last valid round",
  roundLimit: "this pull request has reached its review round limit",
  attemptLimit: "this review round has used its attempts",
} as const;

/**
 * Plan the next attempt. `descendsFromReference` says whether `headSha` descends from the epoch's
 * reference head (its last valid head, or its last attempt's before any valid round); null means it
 * could not be proven, which counts as a rewrite, as missing objects do. `baseMerge` is what the
 * runner proved about `headSha` relative to the last valid head (v277); it applies only when the
 * control plane counts base-merge rounds, and never to a requested full review.
 */
export function planReviewRound(
  history: ReviewRunHistory,
  request: { headSha: string; fullReason?: string },
  descendsFromReference: boolean | null,
  baseMerge: ReviewBaseMerge | null = null,
): ReviewRoundPlan | { refusal: string } {
  if (history.epoch === 0 || !history.lastAttempt) {
    return { epoch: Math.max(1, history.epoch), round: 1, attempt: 1, mode: "full", openFindings: [] };
  }
  const { lastValid, lastAttempt } = history;
  // The last valid review: this epoch's, or the earlier one this epoch has not yet replaced.
  const origin = lastValid ?? history.carried ?? null;
  // A requested full review always reviews in full; otherwise a rewrite reviews its range-diff.
  const fromOrigin = () => origin && !request.fullReason
    ? { mode: "rebase" as const, rebasedFrom: { baseSha: origin.baseSha, headSha: origin.headSha } }
    : { mode: "full" as const };
  const reference = lastValid ?? lastAttempt;
  if (reference.headSha !== request.headSha && descendsFromReference !== true) {
    return { epoch: history.epoch + 1, round: 1, attempt: 1, ...fromOrigin(), openFindings: origin?.findings ?? [] };
  }
  if (lastValid?.vote === "UPVOTE" && lastValid.headSha === request.headSha) return { refusal: REVIEW_ROUND_REFUSALS.upvoted };
  // A base merge counts only directly on the last valid head, and only when the control plane says
  // it does not use the budget. Every other head, including any commit after the merge, is ordinary.
  const merge = history.baseMergeRounds && lastValid && lastValid.headSha !== request.headSha &&
    descendsFromReference === true && !request.fullReason ? baseMerge : null;
  const retry = !lastAttempt.valid && (!lastValid || lastAttempt.round > lastValid.round);
  let round: number;
  let attempt: number;
  if (retry) {
    if (history.consumedInLastRound >= history.attemptsPerRound) return { refusal: REVIEW_ROUND_REFUSALS.attemptLimit };
    // A base-merge round was never admitted by the budget, so an ordinary head cannot inherit it.
    if (lastAttempt.baseMerge && !merge && history.validRounds >= history.roundBudget) return { refusal: REVIEW_ROUND_REFUSALS.roundLimit };
    round = lastAttempt.round;
    attempt = lastAttempt.attempt + 1;
  } else {
    if (!merge && history.validRounds >= history.roundBudget) return { refusal: REVIEW_ROUND_REFUSALS.roundLimit };
    round = lastAttempt.round + 1;
    attempt = 1;
  }
  const openFindings = origin?.findings ?? [];
  // Before the epoch's first valid round, a retry reviews what the epoch's first attempt did.
  if (!lastValid) return { epoch: history.epoch, round, attempt, ...fromOrigin(), openFindings };
  // The pull request's own diff is unchanged since an upvote: record the equivalence, review nothing.
  if (merge === "equivalent" && lastValid.vote === "UPVOTE") {
    return { epoch: history.epoch, round, attempt, mode: "equivalent", equivalentTo: lastValid.headSha, baseMerge: true, openFindings };
  }
  const postUpvote = history.postUpvoteExtension;
  if (request.fullReason && !(postUpvote && postUpvote.upvotedHeadSha === lastValid.headSha)) {
    return { epoch: history.epoch, round, attempt, mode: "full", openFindings };
  }
  if (lastValid.headSha === request.headSha) return { refusal: REVIEW_ROUND_REFUSALS.unchanged };
  return { epoch: history.epoch, round, attempt, mode: "delta", since: lastValid.headSha, openFindings, ...(merge ? { baseMerge: true as const } : {}) };
}
