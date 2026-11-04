/**
 * Delegated image evidence review (#4074). An Orchestrator that owns a pending
 * `ui_evidence_approval` decision hands its images to a managed reviewer Session with a fresh
 * context, so the images never enter the Orchestrator's own conversation. The reviewer receives
 * every image through the same digest-verified delivery as `review_descendant_ui_evidence`; the
 * server records those receipts against the reviewer, not the Orchestrator. The reviewer returns a
 * bounded structured verdict, and the Orchestrator resolves the decision through the existing
 * typed path with the exact reference below, which the server verifies against its own records.
 */

/** Text the Orchestrator gives the reviewer: the child's claims and the UI acceptance criteria. */
export const DELEGATED_IMAGE_REVIEW_BRIEF_MAX_CHARS = 16_000;
export const DELEGATED_IMAGE_REVIEW_SUMMARY_MAX_CHARS = 2_000;
export const DELEGATED_IMAGE_REVIEW_DEFECT_MAX_CHARS = 500;
export const DELEGATED_IMAGE_REVIEW_MAX_DEFECTS = 10;

/** The reviewer's only two tools. Its launch exposes nothing else. */
export const DELEGATED_IMAGE_REVIEW_TOOLS = ["review_evidence_image", "submit_evidence_verdict"] as const;

/** `running`: the reviewer was launched and has not submitted a verdict. `verdict`: its verdict is
 * recorded. `consumed`: an approval spent it. `ended`: it can no longer back an approval (the
 * reviewer stopped without a verdict, or the decision was resolved, revoked or superseded). */
export type DelegatedImageReviewState = "running" | "verdict" | "consumed" | "ended";

export interface DelegatedImageReviewItemVerdict {
  evidenceId: string;
  outcome: "pass" | "fail";
  /** Observed defects. Required for `fail`, empty for `pass`. */
  defects: string[];
}

/** What the reviewer submits. `approve` requires every item to pass; `deny` at least one failure. */
export interface DelegatedImageReviewReport {
  recommendation: "approve" | "deny";
  summary: string;
  items: DelegatedImageReviewItemVerdict[];
}

export interface DelegatedImageReviewVerdict extends DelegatedImageReviewReport {
  verdictId: string;
  reviewerSessionId: string;
  submittedAt: number;
  /** The reviewer's receipts this verdict rests on, one per evidence item. */
  receiptIds: string[];
}

/** Exact reviewer provenance an Orchestrator passes to `resolve_descendant_workflow_decision`. */
export interface DelegatedImageReviewReference {
  reviewId: string;
  verdictId: string;
  reviewerSessionId: string;
}

export interface DelegatedImageReviewView {
  reviewId: string;
  occurrenceId: string;
  childSessionId: string;
  reviewerSessionId: string;
  policyRevision: number;
  state: DelegatedImageReviewState;
  evidenceIds: string[];
  createdAt: number;
  updatedAt: number;
  /** Why a review ended without backing an approval. */
  endedReason?: string;
  verdict?: DelegatedImageReviewVerdict;
  /** Present only while an approving verdict can still back an approval of this decision. */
  delegatedImageReview?: DelegatedImageReviewReference;
}

export interface PrepareDelegatedImageReviewRequest {
  /** The child that requested the decision. */
  sessionId: string;
  occurrenceId: string;
  /** The child's claims and the UI acceptance criteria to check each image against. */
  brief: string;
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max &&
    // Control characters other than tab and newline have no place in a verdict.
    !/[\x00-\x08\x0b-\x1f\x7f]/u.test(value);
}

/** Validates a reviewer report against the exact evidence identifiers of its decision. Returns the
 * reason it is invalid, or null. Shared by the runner (before sending) and the control plane. */
export function delegatedImageReviewReportError(report: unknown, evidenceIds: readonly string[]): string | null {
  if (!report || typeof report !== "object" || Array.isArray(report)) return "report must be an object";
  const value = report as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "items,recommendation,summary") {
    return "report must have exactly recommendation, summary, and items";
  }
  if (value.recommendation !== "approve" && value.recommendation !== "deny") {
    return "recommendation must be approve or deny";
  }
  if (!boundedText(value.summary, DELEGATED_IMAGE_REVIEW_SUMMARY_MAX_CHARS)) {
    return `summary must be non-empty text of at most ${DELEGATED_IMAGE_REVIEW_SUMMARY_MAX_CHARS} characters`;
  }
  if (!Array.isArray(value.items) || value.items.length !== evidenceIds.length) {
    return `items must list each of the ${evidenceIds.length} evidence items exactly once`;
  }
  const seen = new Set<string>();
  let failed = 0;
  for (const item of value.items as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "each item must be an object";
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).sort().join(",") !== "defects,evidenceId,outcome") {
      return "each item must have exactly evidenceId, outcome, and defects";
    }
    if (typeof entry.evidenceId !== "string" || !evidenceIds.includes(entry.evidenceId) || seen.has(entry.evidenceId)) {
      return "items must list each of the decision's evidence items exactly once";
    }
    seen.add(entry.evidenceId);
    if (entry.outcome !== "pass" && entry.outcome !== "fail") return "each item outcome must be pass or fail";
    if (!Array.isArray(entry.defects) || entry.defects.length > DELEGATED_IMAGE_REVIEW_MAX_DEFECTS ||
        entry.defects.some((defect) => !boundedText(defect, DELEGATED_IMAGE_REVIEW_DEFECT_MAX_CHARS))) {
      return `defects must be at most ${DELEGATED_IMAGE_REVIEW_MAX_DEFECTS} non-empty texts of at most ${DELEGATED_IMAGE_REVIEW_DEFECT_MAX_CHARS} characters`;
    }
    if (entry.outcome === "fail" && entry.defects.length === 0) return "a failed item must name the defects observed";
    if (entry.outcome === "pass" && entry.defects.length > 0) return "a passing item cannot list defects; fail it instead";
    if (entry.outcome === "fail") failed++;
  }
  if (value.recommendation === "approve" && failed > 0) return "approve requires every item to pass";
  if (value.recommendation === "deny" && failed === 0) return "deny requires at least one failed item";
  return null;
}
