import {
  FULL_CONTROL_HUMAN_REQUIRED_LABELS,
  FULL_CONTROL_STANDING_HUMAN_REQUIRED_REASON,
  WORKFLOW_DECISION_CATEGORIES,
  type CampaignAuthorityOperation,
  type DelegatableWorkflowDecisionCategory,
  type OrchestratorCampaignProjection,
} from "@wollipog/protocol";

/** Full Control's one line wherever it is chosen (#2940): it adds nothing to fill in. It describes the
 * mode; a running campaign states its readiness with `fullControlReadiness` instead. */
export const FULL_CONTROL_LINE = "The Orchestrator runs this campaign end to end.";

export const WORKFLOW_DECISION_LABELS: Record<DelegatableWorkflowDecisionCategory, string> = {
  implementation_question: "Implementation Questions",
  pr_merge: "PR Merge Approval",
  merged_branch_deletion: "Merged Branch Deletion",
  follow_up_issue_publication: "Follow-Up Issue Publication",
  ui_evidence_approval: "UI Evidence Approval",
  review_round_extension: "Review Round Extensions",
};

/** One readiness fact: what it concerns and, in a sentence, why. */
export interface ReadinessFact {
  key: string;
  label: string;
  reason: string;
}

/**
 * Whether a running Full Control campaign can finish unattended, from the server's live facts only
 * (#2940 criterion 8). It never claims more than the projection proves:
 *
 * - `unattended`: the server reports no Human Required rule, every decision and request class the
 *   campaign makes is the Orchestrator's, no recovery item waits for the person or is blocked, and no
 *   capability it needs is limited.
 * - `qualified`: something comes to a person (`humanRequired`) or a needed capability is limited
 *   (`limited`); the line says so.
 * - `unknown`: the server doesn't report enough to tell, so nothing claims readiness.
 *
 * Video the Orchestrator can't watch is not a limit: it asks for screenshots instead. A launch's
 * recorded capabilities describe that moment and never count as live readiness.
 */
export interface FullControlReadiness {
  state: "unattended" | "qualified" | "unknown";
  humanRequired: ReadinessFact[];
  limited: ReadinessFact[];
  /** Campaign Status's line, beside the facts it refers to. */
  line: string;
  /** The same line for a surface that doesn't list the facts, naming where they are listed. */
  elsewhereLine: string;
}

/** The projection facts readiness reads. */
export type ReadinessCampaign = Pick<OrchestratorCampaignProjection, "control" | "decisionOwners" | "uiEvidenceReview" |
  "fullControlHumanRequired" | "recovery">;
/** The projection facts Campaign Status's Full Control section reads. */
export type CampaignAuthorityView = ReadinessCampaign &
  Pick<OrchestratorCampaignProjection, "videoEvidenceReview" | "launchDisclosure" | "maxIssuesSource">;

const ISSUE_OPERATIONS = [
  ["issue_closure", "Issue Closure"],
  ["campaign_issue_scope", "Issue Scope Changes"],
] as const satisfies ReadonlyArray<readonly [CampaignAuthorityOperation, string]>;

/** Descendant requests outside the typed gates: a boundary that leaves one out sends it to the person
 * (`outside_boundary`). */
const REQUEST_OPERATIONS = [
  ["question", "Questions"],
  ["tool_approval", "Tool Approvals"],
  ["policy_ask", "Policy Asks"],
] as const satisfies ReadonlyArray<readonly [CampaignAuthorityOperation, string]>;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function fullControlReadiness(campaign: ReadinessCampaign | undefined): FullControlReadiness {
  const control = campaign?.control;
  const recovery = campaign?.recovery;
  const automation = recovery?.automation;
  // Every fact readiness reads must be reported; a missing one never reads as ready.
  if (!campaign || control?.mode !== "full_control" || !Array.isArray(campaign.fullControlHumanRequired) ||
      !campaign.decisionOwners || !campaign.uiEvidenceReview || !recovery || !automation) {
    const line = "Full Control is in effect, but whether anything still needs you isn't reported here.";
    return { state: "unknown", humanRequired: [], limited: [], line, elsewhereLine: line };
  }
  const boundary = control.boundary;
  const humanRequired: ReadinessFact[] = campaign.fullControlHumanRequired.map((requestClass) => ({
    key: requestClass,
    label: FULL_CONTROL_HUMAN_REQUIRED_LABELS[requestClass] ?? requestClass,
    reason: FULL_CONTROL_STANDING_HUMAN_REQUIRED_REASON,
  }));
  for (const category of WORKFLOW_DECISION_CATEGORIES) {
    if (campaign.decisionOwners[category] !== "human") continue;
    humanRequired.push({ key: category, label: WORKFLOW_DECISION_LABELS[category], reason: category === "review_round_extension"
      ? "This campaign's machine can't enforce the per-pull-request cap on extra review rounds, so each one comes to you."
      : boundary.operations.includes(category)
        ? "Wollipog can't currently enforce Full Control for this decision on the campaign's machines, so it comes to you."
        : "This campaign's Full Control authorization leaves it out, so it comes to you." });
  }
  for (const [operation, label] of ISSUE_OPERATIONS) {
    if (boundary.operations.includes(operation) && boundary.issueAuthority) continue;
    humanRequired.push({ key: operation, label, reason: boundary.operations.includes(operation)
      ? "This campaign has no issue authority, so it comes to you."
      : "This campaign's Full Control authorization leaves it out, so it comes to you." });
  }
  for (const [operation, label] of REQUEST_OPERATIONS) {
    if (boundary.operations.includes(operation)) continue;
    humanRequired.push({ key: operation, label,
      reason: "This campaign's Full Control authorization leaves these requests out, so they come to you." });
  }
  // Recovery records waiting for the person, or blocked, keep the campaign from finishing unattended
  // (`unattendedReady`), whatever its standing rules say.
  if (recovery.waitingHuman > 0) {
    humanRequired.push({ key: "recovery_waiting", label: "Recovery Waiting for You",
      reason: `${count(recovery.waitingHuman, "recovery item needs", "recovery items need")} your input; Campaign Status shows each one.` });
  }
  const limited: ReadinessFact[] = [];
  if (recovery.blocked > 0) {
    limited.push({ key: "recovery_blocked", label: "Blocked Recovery",
      reason: `${count(recovery.blocked, "recovery item is", "recovery items are")} blocked; Campaign Status shows why.` });
  }
  if (campaign.decisionOwners.ui_evidence_approval === "orchestrator" && campaign.uiEvidenceReview.status === "unavailable") {
    limited.push({ key: "image_evidence", label: "Screenshot Evidence Review",
      reason: campaign.uiEvidenceReview.reason ?? "The Orchestrator can't view evidence images, so it denies UI evidence it can't inspect." });
  }
  if (automation.state === "authority_unavailable" || automation.state === "unsupported_capability") {
    limited.push({ key: "recovery", label: "Automatic Recovery",
      reason: automation.reason ?? "Wollipog can't recover this campaign's interrupted work automatically." });
  }
  // Campaign Status lists both beside its line; elsewhere the line says where they are listed.
  const lines = (elsewhere: boolean) => {
    const listed = elsewhere ? "the decisions Campaign Status lists under Human Required" : "the decisions listed under Human Required";
    return humanRequired.length && limited.length
      ? `The Orchestrator runs this campaign, except ${listed}, and some capabilities it needs are limited, so it may not finish unattended.`
      : humanRequired.length ? `The Orchestrator runs this campaign end to end, except ${listed}.`
      : limited.length ? `The Orchestrator runs this campaign, but some capabilities it needs are limited, so it may not finish unattended.${elsewhere ? " Campaign Status lists them." : ""}`
      : FULL_CONTROL_LINE;
  };
  return { state: humanRequired.length || limited.length ? "qualified" : "unattended", humanRequired, limited,
    line: lines(false), elsewhereLine: lines(true) };
}

/** The Campaign Active row's description (#2938): it says "continues automatically" without
 * qualification only while the campaign is ready to finish unattended. */
export function campaignActiveDescription(campaign: ReadinessCampaign | undefined): string {
  const readiness = fullControlReadiness(campaign);
  return readiness.state === "unattended"
    ? "This Full Control campaign continues automatically. Its intermediate results are informational."
    : readiness.state === "qualified"
      ? "This Full Control campaign continues automatically, except the decisions and limits Campaign Status lists under Full Control. Its intermediate results are informational."
      : "This Full Control campaign continues automatically where it can; Campaign Status shows anything it still needs from you. Its intermediate results are informational.";
}
