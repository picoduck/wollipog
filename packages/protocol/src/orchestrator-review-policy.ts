import type { SessionReviewHarness } from "./session-review-job.js";

/** Null selects Automatic. These fields are copied into each campaign child's launch snapshot. */
export interface OrchestratorReviewPolicy {
  reviewHarness: SessionReviewHarness | null;
  reviewModel: string | null;
  reviewEffort: string | null;
  reviewRoundBudget: number | null;
}

export const DEFAULT_ORCHESTRATOR_REVIEW_POLICY: OrchestratorReviewPolicy = {
  reviewHarness: null, reviewModel: null, reviewEffort: null, reviewRoundBudget: null,
};

export const ORCHESTRATOR_REVIEW_POLICY_KEYS = ["reviewHarness", "reviewModel", "reviewEffort", "reviewRoundBudget"] as const;

export function parseOrchestratorReviewPolicy(value: unknown): OrchestratorReviewPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Partial<OrchestratorReviewPolicy>;
  const identifier = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max &&
    v === v.trim() && !/[\x00-\x1f\x7f]/u.test(v);
  if (input.reviewHarness != null && input.reviewHarness !== "codex" && input.reviewHarness !== "claude-code" ||
      input.reviewModel != null && !identifier(input.reviewModel, 256) ||
      input.reviewEffort != null && !identifier(input.reviewEffort, 64) ||
      input.reviewRoundBudget != null && (!Number.isSafeInteger(input.reviewRoundBudget) || input.reviewRoundBudget < 1 || input.reviewRoundBudget > 32)) return null;
  return { reviewHarness: input.reviewHarness ?? null, reviewModel: input.reviewModel ?? null,
    reviewEffort: input.reviewEffort ?? null, reviewRoundBudget: input.reviewRoundBudget ?? null };
}

/** Only the selected review fields are exposed on a shared session, never the user's full settings.
 * Same-family permission is deliberately absent: current human consent is checked at review time. */
export interface SessionReviewPolicySnapshot extends OrchestratorReviewPolicy {
  source: "system_default" | "user_default" | "project_override" | "campaign_policy";
  /** False preserves the built-in legacy launch when all policy fields are Automatic and no
   * personal settings existed at launch. */
  configured: boolean;
}
