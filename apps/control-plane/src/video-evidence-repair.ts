import { planEvidenceRecovery, type EvidenceRecoveryPlan } from "./evidence-review-recovery.js";
import type { VideoPreparationFailureCode } from "./video-evidence-preparation.js";

/** One initial capture plus at most two replacement captures per evidence lineage (#2938). */
export const VIDEO_EVIDENCE_REPAIR_LIMIT = 2;

/** The repair route for inadequate video evidence under Full Control (#2938). The trusted
 * EvidenceRecoveryExecutor stays unregistered until trusted capture ports exist, so repair runs
 * through the existing typed gate. The Orchestrator owns ui_evidence_approval, declines the exact
 * occurrence with this reason, and the child splits or recaptures and requests a fresh occurrence
 * under the same resource key. Every field is a server enum, identifier, count or fixed planner
 * sentence, never frame bytes, paths, request bodies or credentials. */
export interface VideoEvidenceRepairException {
  blockedAction: "delegated_video_review";
  occurrenceId: string;
  evidenceId: string;
  childSessionId: string;
  preparationCode: VideoPreparationFailureCode;
  /** `split` and `recapture` route to the child, `reject` means the lineage's repairs are exhausted,
   * `wait` means the decoder is busy, and `human` means automation cannot verify this evidence. */
  action: "split" | "recapture" | "reject" | "wait" | "human";
  owner: "orchestrator" | "human";
  /** Replacement captures this lineage has already been asked for, this one included. */
  repairAttempt: number;
  repairLimit: number;
  /** Whether preparing this exact occurrence again can produce a different outcome. */
  reprepare: boolean;
  reason: string;
  requiredInput: string;
  summary: string;
}

/** Inadequate captures count toward the lineage cap; a busy or unavailable decoder does not. */
export const countsTowardRepairLimit = (exception: VideoEvidenceRepairException | undefined) =>
  exception?.action === "split" || exception?.action === "recapture" || exception?.action === "reject";

/** The exception for one refused preparation, given how many earlier occurrences of the same
 * lineage were already refused as inadequate. The cap overrides the planner's split or recapture:
 * a third inadequate capture is exhausted, so it is declined, not repaired again. */
export function videoEvidenceRepairException(subject: { occurrenceId: string; evidenceId: string; childSessionId: string },
  code: VideoPreparationFailureCode, plan: EvidenceRecoveryPlan, priorInadequate: number): VideoEvidenceRepairException {
  const exhausted = (plan.action === "split" || plan.action === "recapture") && priorInadequate >= VIDEO_EVIDENCE_REPAIR_LIMIT;
  const effective = exhausted ? planEvidenceRecovery("full_control", code, VIDEO_EVIDENCE_REPAIR_LIMIT) : plan;
  const action = effective.action === "retry" ? "wait" : effective.action;
  const decline = `Decline occurrence ${subject.occurrenceId} with resolve_descendant_workflow_decision (deny) and give this reason as childMessage`;
  const requiredInput = action === "split"
    ? `${decline}. The child then records ordered adjacent shorter clips covering the same interval and requests a fresh ui_evidence_approval occurrence under the same resourceKey. Do not prepare this occurrence again; its source cannot change.`
    : action === "recapture"
      ? `${decline}. The child then recaptures within the readable profile and requests a fresh ui_evidence_approval occurrence under the same resourceKey. Do not prepare this occurrence again; its source cannot change.`
      : action === "reject"
        ? `${decline}. This evidence lineage already used its ${VIDEO_EVIDENCE_REPAIR_LIMIT} replacement captures, so no further capture is prepared; report the evidence requirement as an exhausted exception instead of requesting another capture.`
        : action === "wait"
          ? "None. Prepare this occurrence again later; unrelated campaign work may continue."
          : "A Human must review this video evidence; automation cannot verify its coverage.";
  const repairAttempt = action === "split" || action === "recapture" ? priorInadequate + 1 : Math.min(priorInadequate, VIDEO_EVIDENCE_REPAIR_LIMIT);
  return { blockedAction: "delegated_video_review", occurrenceId: subject.occurrenceId, evidenceId: subject.evidenceId,
    childSessionId: subject.childSessionId, preparationCode: code, action, owner: action === "human" ? "human" : "orchestrator",
    repairAttempt, repairLimit: VIDEO_EVIDENCE_REPAIR_LIMIT, reprepare: action === "wait" || action === "human",
    reason: effective.reason, requiredInput,
    summary: `Video review preparation was refused (${code}): ${effective.reason} Next: ${requiredInput}` };
}

/** A fresh occurrence of a lineage whose repairs are exhausted is refused before any reviewer is
 * reserved, so the ceiling holds without repeatedly asking anyone to override it. */
export function exhaustedVideoEvidenceLineage(subject: { occurrenceId: string; evidenceId: string; childSessionId: string },
  last: VideoEvidenceRepairException): VideoEvidenceRepairException {
  const requiredInput = `Decline occurrence ${subject.occurrenceId} with resolve_descendant_workflow_decision (deny). This evidence lineage already used its ${VIDEO_EVIDENCE_REPAIR_LIMIT} replacement captures, so no reviewer is reserved for it; report the evidence requirement as an exhausted exception instead of requesting another capture.`;
  const reason = "The bounded replacement captures for this evidence are exhausted.";
  return { blockedAction: "delegated_video_review", occurrenceId: subject.occurrenceId, evidenceId: subject.evidenceId,
    childSessionId: subject.childSessionId, preparationCode: last.preparationCode, action: "reject", owner: "orchestrator",
    repairAttempt: VIDEO_EVIDENCE_REPAIR_LIMIT, repairLimit: VIDEO_EVIDENCE_REPAIR_LIMIT, reprepare: false, reason, requiredInput,
    summary: `Video review preparation was refused: ${reason} Next: ${requiredInput}` };
}
