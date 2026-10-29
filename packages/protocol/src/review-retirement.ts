/** Legacy names remain recognizable solely to produce migration refusals, never admission. */
export const RETIRED_REVIEW_TOOL_NAMES = [
  "request_cross_model_review", "get_cross_model_review", "list_cross_model_reviews", "cancel_cross_model_review",
  "run_campaign_review_job", "get_campaign_review_job", "list_campaign_review_jobs", "get_campaign_review_report",
] as const;

export const REVIEW_JOBS_RETIRED_REASON = "The review bridge and campaign review jobs are retired. Update Wollipog and the runner, then use request_review_session or wollipog review session run for your own pushed PR.";

export const REVIEW_SESSION_ONLY_MIN_PROTOCOL = 246;

/** Upgrade the control plane first: old servers sanitize unknown job refusals and can replay
 * legacy dispatch. Refuse that pairing explicitly before registration can resume any work. */
export function reviewRetirementPeerRefusal(protocol: unknown): string | null {
  return typeof protocol === "number" && Number.isInteger(protocol) && protocol >= REVIEW_SESSION_ONLY_MIN_PROTOCOL
    ? null : `This runner requires a review-session-aware control plane (protocol ${REVIEW_SESSION_ONLY_MIN_PROTOCOL}+). ${REVIEW_JOBS_RETIRED_REASON}`;
}
