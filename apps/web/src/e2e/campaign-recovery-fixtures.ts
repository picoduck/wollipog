import { CAMPAIGN_RECOVERY_EXPLANATIONS, type CampaignRecoveryReason, type CampaignRecoveryRecord } from "@wollipog/protocol";

/** Deterministic content-safe evidence for the real Campaign Status / Requests components. */
export function campaignRecoveryFixture(reason: CampaignRecoveryReason, now: number): CampaignRecoveryRecord {
  const blocked = reason === "hard_denial" || reason === "attempts_exhausted";
  const automatic = ["failed_checks", "reviewer_objection", "transient_failure", "uncertain_outcome"].includes(reason);
  const requiredInput: CampaignRecoveryRecord["requiredInput"] = reason === "missing_access" ? "restore_existing_access"
    : reason === "missing_human_information" ? "answer_existing_request"
    : reason === "boundary_enlargement" ? "authorize_exact_boundary_change"
    : reason === "unsupported_capability" ? "use_supported_capability"
    : reason === "human_required_rule" ? "perform_human_required_action"
    : reason === "uncertain_outcome" ? "reconcile_original_outcome" : "none";
  const action = reason === "failed_checks" ? "repair_checks" : reason === "reviewer_objection" ? "rereview"
    : reason === "uncertain_outcome" ? "reconcile_outcome" : "answer_request";
  return { id: "recovery_fixture", action,
    resource: { kind: "request", sessionId: "s_child_3", occurrenceId: `sha256:${"a".repeat(64)}` }, reason,
    state: blocked ? "blocked" : automatic ? "dispatched" : "waiting_human", effectiveOwner: automatic || blocked ? "orchestrator" : "human",
    policyRevision: 1, attempts: reason === "attempts_exhausted" ? 4 : automatic ? 1 : 0, maxAttempts: 4,
    attemptedRecovery: reason === "attempts_exhausted" ? [action, action, action, action] : automatic ? [action] : [],
    requiredInput, explanation: CAMPAIGN_RECOVERY_EXPLANATIONS[reason], createdAt: now, updatedAt: now };
}
