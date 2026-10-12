import type { DelegatedVideoEvidenceReference, WorkflowDecisionView } from "@wollipog/protocol";
import { VideoEvidenceRuntime, type VideoReviewRecord, type VideoReviewVerdict } from "./video-evidence-runtime.js";

type UiDecision = WorkflowDecisionView & {
  resourceSnapshot: Extract<WorkflowDecisionView["resourceSnapshot"], { category: "ui_evidence_approval" }>;
};
export interface VideoEvidenceGateAccess {
  /** Must re-read exact current stored decision, sole UI owner, Full Control authority, task/
   * scope/audience, provider disclosure, allowance denial and media capability on both phases. */
  decisionCurrent(decision: WorkflowDecisionView, phase: "resolve" | "consume"): boolean;
  /** Server-owned latest subject mapping, never a caller-selected review or worker identity. */
  linkedReview(decision: WorkflowDecisionView, evidenceId: string): VideoReviewRecord | null;
  /** Existing receipt path for images actually inspected by this controlling owner. */
  directImageReviewed(decision: WorkflowDecisionView, evidenceId: string): boolean;
}

/** The original artifact snapshot/resource digest never changes. Original video IDs are covered
 * by actual media-Session provenance; parent-received receipts are never manufactured. */
export class VideoEvidenceDecisionBridge {
  constructor(private readonly runtime: VideoEvidenceRuntime, private readonly access: VideoEvidenceGateAccess) {}
  approvalProvenance(decision: WorkflowDecisionView, evidenceReviewed: readonly string[],
    delegated: readonly DelegatedVideoEvidenceReference[], phase: "resolve" | "consume"): VideoReviewVerdict[] {
    if (decision.category !== "ui_evidence_approval" || decision.resourceSnapshot.category !== "ui_evidence_approval" ||
      decision.authority !== "orchestrator" || decision.status !== (phase === "resolve" ? "pending" : "approved") ||
      !this.access.decisionCurrent(decision, phase) || !Array.isArray(evidenceReviewed) || !Array.isArray(delegated) ||
      delegated.length > 32 || evidenceReviewed.length > 32 ||
      new Set(evidenceReviewed).size !== evidenceReviewed.length || new Set(delegated.map((r) => r.evidenceId)).size !== delegated.length) {
      throw new Error("The exact original UI gate has no current delegated approval provenance.");
    }
    const snapshot = (decision as UiDecision).resourceSnapshot;
    const videos = snapshot.evidence.filter((item) => item.mediaType === "video/webm" || item.mediaType === "video/mp4");
    const images = snapshot.evidence.filter((item) => item.mediaType?.startsWith("image/"));
    if (videos.length + images.length !== snapshot.evidence.length || videos.length !== delegated.length ||
      images.length !== evidenceReviewed.length ||
      evidenceReviewed.some((id) => !images.some((item) => item.evidenceId === id)) ||
      images.some((item) => !evidenceReviewed.includes(item.evidenceId) ||
        !this.access.directImageReviewed(decision, item.evidenceId))) {
      throw new Error("Directly inspected image IDs and delegated video IDs must truthfully cover every original artifact.");
    }
    const proofs = videos.map((item) => {
      const reference = delegated.find((r) => r.evidenceId === item.evidenceId);
      const review = this.access.linkedReview(decision, item.evidenceId);
      if (!reference || !review || !item.artifactId || review.binding.sourceEvidenceId !== item.evidenceId ||
        review.binding.rootSessionId !== decision.controllingSessionId || review.binding.childSessionId !== decision.sessionId ||
        review.binding.occurrenceId !== decision.occurrenceId || review.binding.resourceDigest !== decision.resourceDigest ||
        review.binding.policyRevision !== decision.policyRevision || review.binding.sourceArtifactId !== item.artifactId ||
        review.binding.sourceSha256 !== item.sha256 || review.manifest.sourceMediaType !== item.mediaType ||
        reference.reviewId !== review.reviewId || reference.reviewerSessionId !== review.binding.reviewerSessionId) {
        throw new Error("Delegated media provenance is not bound to this original evidence ID and exact decision.");
      }
      const verdict = this.runtime.approvalProvenance(review.reviewId, review.binding.reviewerSessionId);
      if (reference.verdictId !== verdict.verdictId || verdict.reviewerSessionId === decision.sessionId ||
        verdict.reviewerSessionId === decision.controllingSessionId) throw new Error("The actual non-self media reviewer verdict is required.");
      return verdict;
    });
    // The runtime rehashed original source and every native frame. This adapter rechecks the gate
    // after that work as well; final caller must commit resolution/consumption in the same turn.
    if (!this.access.decisionCurrent(decision, phase)) throw new Error("Original UI gate authority changed during provenance verification.");
    return proofs;
  }
}
