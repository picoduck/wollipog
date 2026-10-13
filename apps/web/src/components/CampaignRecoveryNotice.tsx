import type { CampaignRecoveryRecord } from "@wollipog/protocol";
import { Notice } from "./Notice.js";
import { titleCaseLabel } from "../format.js";

const actions: Record<CampaignRecoveryRecord["action"], string> = {
  answer_request: "Answer Request", review_evidence: "Review Evidence", recover_hold: "Recover Held Work",
  replace_worker: "Replace Failed Worker", reformulate_request: "Reformulate Request", repair_checks: "Repair Checks",
  rereview: "Repair and Re-Review", reconcile_outcome: "Reconcile Original Outcome", continue_campaign: "Continue Campaign",
};
const inputs: Record<CampaignRecoveryRecord["requiredInput"], string> = {
  answer_existing_request: "Answer the existing request with the missing information.",
  restore_existing_access: "Restore the required access through the existing human authentication flow.",
  authorize_exact_boundary_change: "Review the exact proposed boundary change through its human approval gate.",
  perform_human_required_action: "Complete the existing human-owned action without changing its authority.",
  use_supported_capability: "Provide a supported execution or review capability for this operation.",
  reconcile_original_outcome: "Inspect the original operation's receipt and establish its outcome before any retry.",
  none: "No override is requested.",
};

/** Informational metadata beside the existing request. It offers no generic override controls. */
export function CampaignRecoveryNotice({ record }: { record: CampaignRecoveryRecord }) {
  const human = record.state === "waiting_human";
  const blocked = record.state === "blocked";
  return (
    <Notice tone={human || blocked ? "warning" : "neutral"}
      title={human ? "Human Input Required" : blocked ? "Recovery Blocked" : "Authorized Recovery"}
      details={(
        <dl className="facts">
          <div><dt>Action</dt><dd>{actions[record.action]}</dd></div>
          <div><dt>Resource</dt><dd>{record.resource.repository && record.resource.pullRequest
            ? `${record.resource.repository}#${record.resource.pullRequest}` : record.resource.sessionId}
            <span className="campaign-status-meta">{record.resource.occurrenceId}</span></dd></div>
          <div><dt>Effective Owner</dt><dd>{record.effectiveOwner === "human" ? "Human" : "Orchestrator"}</dd></div>
          <div><dt>Reason</dt><dd>{titleCaseLabel(record.reason.replaceAll("_", " "))}</dd></div>
          <div><dt>Recovery Attempts</dt><dd>{record.attempts} of {record.maxAttempts}</dd></div>
          <div><dt>Attempted Recovery</dt><dd>{record.attemptedRecovery.length
            ? record.attemptedRecovery.map(action => actions[action]).join(", ")
            : "No authorized recovery attempt is available yet."}</dd></div>
          <div><dt>Required Input</dt><dd>{inputs[record.requiredInput]}</dd></div>
        </dl>
      )}
    >
      {record.explanation}
    </Notice>
  );
}
