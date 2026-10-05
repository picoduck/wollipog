import React, { useEffect, useState } from "react";
import type { PendingApproval, WorkflowDecisionView } from "@wollipog/protocol";
import { useInstanceScope } from "../../instance-scope.js";
import {
  clearEvidenceReviewDraft,
  loadEvidenceReviewDraft,
  saveEvidenceReviewDraft,
} from "../../evidence-review-drafts.js";
import { Checkbox } from "../ui/ChoiceControls.js";
import {
  EvidenceArtifactView,
  EvidenceSecureContextNotice,
  evidenceStatusBlocksReview,
  isArtifactBackedEvidence,
  isRenderableEvidence,
  UnrenderableEvidenceArtifact,
  type EvidenceArtifactStatus,
} from "../EvidenceArtifactView.js";

type EvidenceSnapshot = Extract<WorkflowDecisionView["resourceSnapshot"], { category: "ui_evidence_approval" }>;
type EvidenceItem = EvidenceSnapshot["evidence"][number];

export interface EvidenceReview {
  decision: WorkflowDecisionView;
  evidence: EvidenceItem[];
  /** Whether an item cannot be marked reviewed in this browser. */
  blocked: (item: EvidenceItem) => boolean;
  reviewed: (item: EvidenceItem) => boolean;
  setReviewed: (evidenceId: string, checked: boolean) => void;
  reviewedCount: number;
  complete: boolean;
  onArtifactStatus: (evidenceId: string, status: EvidenceArtifactStatus) => void;
  /** The approve route's review proof for this exact occurrence. */
  approval: () => { evidenceReviewed?: string[]; evidenceReviewDigest?: string };
  clearDraft: () => void;
}

/**
 * The review state of a UI evidence decision: which items were seen, kept per occurrence in this
 * browser so a reload or a narrower layout does not lose it (#1107). Only a workflow decision whose
 * snapshot is UI evidence has one; every other request gets null.
 */
export function useEvidenceReview(sessionId: string, request: PendingApproval): EvidenceReview | null {
  const instanceScope = useInstanceScope();
  const workflowDecision = request.kind === "workflow_decision" ? request.workflowDecision : undefined;
  const decision = workflowDecision?.resourceSnapshot.category === "ui_evidence_approval" ? workflowDecision : null;
  const evidence = decision?.resourceSnapshot.category === "ui_evidence_approval" ? decision.resourceSnapshot.evidence : [];
  const evidenceIds = evidence.map((item) => item.evidenceId);
  const load = () => decision
    ? loadEvidenceReviewDraft(instanceScope, sessionId, request.requestId, decision.resourceDigest, evidenceIds)
    : [];
  const [reviewedIds, setReviewedIds] = useState<string[]>(load);
  // An artifact-backed item counts as reviewed only once its verified image was actually shown. A
  // saved mark from an earlier visit does not survive the artifact turning out missing, mismatched,
  // or uncheckable in this browser. An artifact's `uri`, if any, never stands in for the checked
  // bytes, so an artifact of a media type the card cannot show stays blocked.
  const [artifactStatus, setArtifactStatus] = useState<Record<string, EvidenceArtifactStatus>>({});

  useEffect(() => {
    setReviewedIds(load());
    setArtifactStatus({});
  // The ids and digest are the immutable identity of this exact review occurrence.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.requestId, decision?.resourceDigest, instanceScope, sessionId]);

  if (!decision) return null;
  const blocked = (item: EvidenceItem) => {
    if (!isRenderableEvidence(item)) return isArtifactBackedEvidence(item) || !item.uri;
    return evidenceStatusBlocksReview(artifactStatus[item.evidenceId] ?? "pending");
  };
  const reviewed = (item: EvidenceItem) => reviewedIds.includes(item.evidenceId) && !blocked(item);
  // The total counts what the checkboxes show, so a saved mark on an item this page cannot show is
  // not reported as reviewed.
  const reviewedCount = evidence.filter(reviewed).length;
  return {
    decision,
    evidence,
    blocked,
    reviewed,
    setReviewed: (evidenceId, checked) => setReviewedIds((current) => {
      const next = checked
        ? [...new Set([...current, evidenceId])]
        : current.filter((candidate) => candidate !== evidenceId);
      saveEvidenceReviewDraft(instanceScope, sessionId, request.requestId, decision.resourceDigest, next);
      return next;
    }),
    reviewedCount,
    complete: reviewedCount === evidence.length,
    onArtifactStatus: (evidenceId, status) => setArtifactStatus((current) =>
      current[evidenceId] === status ? current : { ...current, [evidenceId]: status }),
    approval: () => evidence.length === 0 ? {} : ({
      evidenceReviewed: reviewedIds,
      ...(evidence.some((item) => item.uri === undefined) ? { evidenceReviewDigest: decision.resourceDigest } : {}),
    }),
    clearDraft: () => clearEvidenceReviewDraft(instanceScope, sessionId, request.requestId, decision.resourceDigest),
  };
}

/**
 * The evidence of a UI evidence decision, each item shown in place with its Reviewed mark. The
 * Request Card's body for this kind; #2197 rebuilds it as a grid of named tiles.
 */
export function EvidenceReviewBody({ review, reasonId }: {
  review: EvidenceReview;
  /** The sentence the disabled Approve refers to. */
  reasonId: string;
}) {
  const { decision, evidence } = review;
  return (
    <div className="evidence-review">
      <div className="evidence-review-summary">
        <p id={reasonId}>Review every artifact before approving this request.</p>
        <strong role="status" aria-live="polite">
          {review.reviewedCount} of {evidence.length} Reviewed
        </strong>
      </div>
      {decision.humanFallback && <p className="muted">
        UI Evidence Approval is assigned to the Orchestrator, but this request needs a human. {decision.humanFallback.reason}
      </p>}
      <div className="evidence-review-list" aria-label="Evidence Items">
        <EvidenceSecureContextNotice evidence={evidence} />
        {evidence.map((item, index) => (
          <article className="evidence-review-item" key={item.evidenceId}>
            <div className="evidence-review-item-main">
              <span className="evidence-review-index" aria-hidden="true">{index + 1}</span>
              <div>
                <strong>{item.evidenceId}</strong>
                {!isArtifactBackedEvidence(item) && item.uri && (
                  <a
                    className="btn ghost sm"
                    href={item.uri}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`View External Evidence: ${item.evidenceId}`}
                  >
                    View External Evidence
                  </a>
                )}
                {!isArtifactBackedEvidence(item) && !item.uri && (
                  <p className="form-error" role="alert">This evidence has no viewable artifact or external link.</p>
                )}
              </div>
            </div>
            {isRenderableEvidence(item)
              ? <EvidenceArtifactView item={item} onStatusChange={review.onArtifactStatus} />
              : isArtifactBackedEvidence(item) && <UnrenderableEvidenceArtifact item={item} />}
            <Checkbox
              label="Reviewed"
              ariaLabel={`Mark ${item.evidenceId} as Reviewed`}
              checked={review.reviewed(item)}
              disabled={review.blocked(item)}
              onChange={(checked) => review.setReviewed(item.evidenceId, checked)}
            />
          </article>
        ))}
        <details className="evidence-review-details">
          <summary>Advanced Details</summary>
          <dl className="facts">
            <div><dt>Resource Key</dt><dd>{decision.resourceKey}</dd></div>
            <div><dt>Resource Digest</dt><dd>{decision.resourceDigest}</dd></div>
          </dl>
        </details>
      </div>
    </div>
  );
}
