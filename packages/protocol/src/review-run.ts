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
 */
import type { ReviewReportFinding } from "./review-contract.js";

export type ReviewRoundMode = "full" | "delta" | "rebase";

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
  /** The epoch's most recent attempt, valid or not. */
  lastAttempt: { headSha: string; round: number; attempt: number; valid: boolean } | null;
  /** Valid rounds in the epoch. */
  validRounds: number;
  /** Consumed attempts in the most recent attempt's round. */
  consumedInLastRound: number;
  /** v237: a post-upvote grant forces delta scope until the next valid round. */
  postUpvoteExtension?: { headSha: string; upvotedHeadSha: string };
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
 * could not be proven, which counts as a rewrite, as missing objects do.
 */
export function planReviewRound(
  history: ReviewRunHistory,
  request: { headSha: string; fullReason?: string },
  descendsFromReference: boolean | null,
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
  const retry = !lastAttempt.valid && (!lastValid || lastAttempt.round > lastValid.round);
  let round: number;
  let attempt: number;
  if (retry) {
    if (history.consumedInLastRound >= history.attemptsPerRound) return { refusal: REVIEW_ROUND_REFUSALS.attemptLimit };
    round = lastAttempt.round;
    attempt = lastAttempt.attempt + 1;
  } else {
    if (history.validRounds >= history.roundBudget) return { refusal: REVIEW_ROUND_REFUSALS.roundLimit };
    round = lastAttempt.round + 1;
    attempt = 1;
  }
  const openFindings = origin?.findings ?? [];
  // Before the epoch's first valid round, a retry reviews what the epoch's first attempt did.
  if (!lastValid) return { epoch: history.epoch, round, attempt, ...fromOrigin(), openFindings };
  const postUpvote = history.postUpvoteExtension;
  if (request.fullReason && !(postUpvote && postUpvote.upvotedHeadSha === lastValid.headSha)) {
    return { epoch: history.epoch, round, attempt, mode: "full", openFindings };
  }
  if (lastValid.headSha === request.headSha) return { refusal: REVIEW_ROUND_REFUSALS.unchanged };
  return { epoch: history.epoch, round, attempt, mode: "delta", since: lastValid.headSha, openFindings };
}
