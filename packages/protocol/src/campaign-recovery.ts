import type { CampaignPublicationAdmissionFailure } from "./campaign-issue-publication.js";

/** Content-safe recovery metadata. These records describe work; none is an authorization or
 * a receipt proving an external effect. Resource identities never contain commands, media or URLs. */
export type CampaignRecoveryAction = "answer_request" | "review_evidence" | "recover_hold" |
  "replace_worker" | "reformulate_request" | "repair_checks" | "rereview" | "reconcile_outcome" | "continue_campaign" |
  "continue_without_request";
export type CampaignRecoveryReason = "authorized_action" | "transient_failure" | "failed_checks" | "reviewer_objection" |
  "uncertain_outcome" | "missing_human_information" | "missing_access" | "boundary_enlargement" |
  "human_required_rule" | "follow_up_limit" | "owner_approval_required" | "unsupported_capability" | "hard_denial" | "attempts_exhausted" | "authority_changed" |
  "request_declined" |
  /** #4065: a person-owned follow-up publication the server could not admit; `admissionFailure` names why. */
  "publication_not_admitted" |
  /** #4065: the server refused a member's publication request for a condition it can correct. */
  "correctable_refusal" |
  /** #3362: a worker ended by a recorded Stop or archive request, not by a denial. Blocked like one. */
  "intentional_stop" |
  /** #3362: a stopped worker whose recorded provenance proves neither a Stop request nor a denial. */
  "unverified_stop";
export type CampaignRecoveryState = "ready" | "backoff" | "dispatched" | "waiting_human" |
  "blocked" | "resolved" | "cancelled";
export interface CampaignRecoveryResource {
  kind: "request" | "hold" | "worker" | "continuation" | "steering" | "pull_request" | "review_job";
  sessionId: string;
  /** Exact original occurrence, hold, command, steering attempt, or PR head identity. */
  occurrenceId: string;
  repository?: string;
  pullRequest?: number;
  /** Keeps replacement-worker recovery ceilings on the same ledger item. */
  workItemId?: string;
}
export type CampaignRecoveryInput = "answer_existing_request" | "restore_existing_access" |
  "authorize_exact_boundary_change" | "perform_human_required_action" | "use_supported_capability" |
  "reconcile_original_outcome" | "none";
export interface CampaignRecoveryRecord {
  id: string;
  action: CampaignRecoveryAction;
  resource: CampaignRecoveryResource;
  reason: CampaignRecoveryReason;
  state: CampaignRecoveryState;
  effectiveOwner: "human" | "orchestrator";
  policyRevision: number;
  /** An old reservation cannot dispatch after cancellation even if its live exception is shown. */
  dispatchFenced?: boolean;
  attempts: number;
  maxAttempts: number;
  attemptedRecovery: CampaignRecoveryAction[];
  requiredInput: CampaignRecoveryInput;
  /** Fixed server explanation; never an exception's raw message. */
  explanation: string;
  /** With `publication_not_admitted` or `correctable_refusal`: the recorded admission failure (#4065). */
  admissionFailure?: CampaignPublicationAdmissionFailure;
  nextAttemptAt?: number;
  createdAt: number;
  updatedAt: number;
}
export interface CampaignRecoveryProjection {
  /** False whenever authority/capability or an unresolved exception prevents unattended completion. */
  unattendedReady: boolean;
  /** Live admission fallback. Missing authority/capability never advertises unattended readiness. */
  automation?: { state: "available" | "authority_unavailable" | "unsupported_capability" | "lifecycle_held" | "budget_held"; reason?: string };
  automatic: number;
  waitingHuman: number;
  blocked: number;
  records: CampaignRecoveryRecord[];
  truncated: boolean;
}
/** The fixed reasons the control plane gives with a `lifecycle_held` automation. `complete` is an
 * intentional stop, not a blocker: every original scoped obligation is done, so there is nothing to
 * recover. Campaign Status shows it as neutral (#3361); the other two still explain a real hold. */
export const CAMPAIGN_AUTOMATION_HOLD_REASONS = {
  lifecycle: "Automatic continuation is held by the campaign's current lifecycle or pending recovery.",
  complete: "The campaign has no unfinished original scoped recovery obligation.",
  recoveryHeld: "Original scoped work remains unfinished, but no current known recovery is eligible. Reconcile its original obligation before continuing.",
} as const;
export const CAMPAIGN_RECOVERY_LIMITS = { maxAttempts: 4, baseBackoffMs: 1_000,
  maxBackoffMs: 30_000, visibleRecords: 64, dispatchPerPass: 16 } as const;

export const CAMPAIGN_RECOVERY_EXPLANATIONS: Record<CampaignRecoveryReason, string> = {
  authorized_action: "This action is owned by the Orchestrator under current authority. Its existing exact approval and execution gates still apply.",
  transient_failure: "Retry only a known undelivered operation within the bounded recovery policy.",
  failed_checks: "Repair the failing checks, then verify the exact new head before requesting merge approval.",
  reviewer_objection: "Adjudicate the review findings and repair verified blockers before re-reviewing within the review limit.",
  uncertain_outcome: "Inspect and reconcile the original occurrence before any retry. An unknown result does not authorize replay.",
  missing_human_information: "The existing request requires information that the campaign cannot infer within its authority.",
  missing_access: "The existing operation requires human authentication or access. Recovery cannot grant access or expose credentials.",
  boundary_enlargement: "The exact operation falls outside current human-authorized scope. Recovery cannot enlarge that boundary.",
  human_required_rule: "This operation is governed by a Human Required rule. A generic answer or tool approval cannot override it.",
  follow_up_limit: "This follow-up needs your approval because it is past the follow-up limit you set, or changes a follow-up you admitted past that limit. Approve the exact follow-up or change the limit in Campaign Status.",
  owner_approval_required: "This operation requires the owner's exact approval under the current campaign controls. A generic answer or tool approval cannot authorize it.",
  unsupported_capability: "The current provider path cannot safely perform this operation. Use a supported capability without changing campaign preferences automatically.",
  hard_denial: "The operation was denied. It remains blocked and recovery will not request repeated overrides.",
  attempts_exhausted: "The recovery ceiling was exhausted. It remains blocked and recovery will not reset the ceiling or request repeated overrides.",
  authority_changed: "The original recovery reservation was cancelled. This live resource remains blocked until a fresh exact occurrence is available; no override is requested.",
  request_declined: "Full Control declined a request for credentials, sign-in, wider provider access or a lasting permission grant. The campaign cannot supply these, so the work that needed it stays blocked while unrelated work continues. Nobody is asked and the request is never replayed.",
  publication_not_admitted: "The server could not admit this follow-up publication under the campaign's issue boundary, so a person reviews it. Recovery cannot admit it.",
  correctable_refusal: "The server refused a member's follow-up publication request for a condition the member can correct, and created nothing. Have it correct the request as the refusal says and request it again.",
  intentional_stop: "The worker was stopped on purpose by a recorded Stop or archive request; nothing was denied. It remains blocked and recovery will not replace or restart it automatically.",
  unverified_stop: "The worker stopped without a recorded Stop request, denial or failure that explains why, so the cause is unverified. It remains blocked and recovery will not replace or restart it automatically.",
};
