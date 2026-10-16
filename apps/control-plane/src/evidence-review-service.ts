import type { AuthPrincipal } from "./identity.js";
import { supportsPacedVideoReviewPeer } from "@wollipog/protocol";
import type { VideoProfileLiveProof, EvidenceReviewerTarget } from "./evidence-review-worker.js";
import { validVideoLiveProof } from "./evidence-review-worker.js";
import { VideoEvidenceRuntime, type VideoReviewBinding,
  type VideoReviewCriterion, type VideoReviewRecord, type VideoReviewStore, type VideoReviewVerdict } from "./video-evidence-runtime.js";
import { planEvidenceRecovery, type EvidenceRecoveryPlan } from "./evidence-review-recovery.js";
import type { EvidenceRecoveryExecutor, RecoveryExecutionResult } from "./evidence-review-recovery-executor.js";

export interface PendingVideoReviewRequest {
  childSessionId: string;
  occurrenceId: string;
  evidenceId: string;
}
/** Only the final service adapter resolves these values from authenticated current DB records.
 * A child/worker request body cannot supply a grant, target, criteria or binding. */
export interface ResolvedVideoReviewRequest {
  binding: VideoReviewBinding;
  criteria: VideoReviewCriterion[];
  target: EvidenceReviewerTarget;
  mediaType: "video/webm" | "video/mp4";
  mode: "custom" | "full_control";
  sourceGrantVerified: boolean;
}
export interface EvidenceReviewAuditEvent {
  event: "video_evidence_prepared" | "video_evidence_recovery" | "video_evidence_delivery" |
    "video_evidence_acknowledged" | "video_evidence_verdict" | "video_evidence_provenance";
  entryPoint: "owner_prepare" | "reviewer_media" | "reviewer_verdict" | "owner_provenance";
  occurrenceId: string;
  rootSessionId: string;
  childSessionId: string;
  reviewerSessionId: string;
  policyRevision: number;
  reviewId?: string;
  manifestSha256?: string;
  durationMs?: number;
  attempt?: number;
  outcome?: "accept" | "reject";
  receiptId?: string;
  verdictId?: string;
  frameIndex?: number;
  preparationCode?: string;
  recoveryAction?: EvidenceRecoveryPlan["action"];
}

export interface EvidenceReviewServiceAdapter {
  /** Installed trusted bounded capture adapter; omission preserves unsupported execution. */
  recovery?: EvidenceRecoveryExecutor;
  resolvePending(rootSessionId: string, request: PendingVideoReviewRequest): ResolvedVideoReviewRequest | null;
  currentOwner(binding: VideoReviewBinding): boolean;
  liveProof(target: EvidenceReviewerTarget): VideoProfileLiveProof | null;
  reviewerProtocol(sessionId: string): number | null;
  /** Read-only current authenticated selected-installation metadata by exact Session identity.
   * No registered implementation is supplied. Missing/throwing lookup means unsupported;
   * compatibility never attests native isolation or mints an admission or real delivery receipt. */
  peerContract?(sessionId: string): unknown;
  /** Allowlisted lifecycle metadata only; never images, request/report bodies or credentials. */
  audit(event: EvidenceReviewAuditEvent): void;
}
export type PrepareEvidenceReviewResult =
  | { ok: true; review: VideoReviewRecord }
  | { ok: false; code: "not_authorized" | "custom_fallback" | "live_validation" | "mixed_peer" |
      "preparation"; recovery?: EvidenceRecoveryPlan; execution?: RecoveryExecutionResult };
const agentSession = (principal: AuthPrincipal) => principal.kind === "agent" ? principal.credentialSessionId : null;

/** Authenticated service boundary for the independent runtime. Agent routes/MCP exposure and
 * the concrete workflow/artifact/allowance adapters are added only after preceding contracts land.
 * The implementing child never acquires a reviewer credential by choosing an id in request JSON. */
export class EvidenceReviewService {
  constructor(private readonly runtime: VideoEvidenceRuntime, private readonly store: VideoReviewStore,
    private readonly adapter: EvidenceReviewServiceAdapter,
    private readonly clock: () => number = Date.now,
    private readonly delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {}

  private currentPeers(binding: VideoReviewBinding): boolean {
    try {
      return [binding.rootSessionId, binding.childSessionId, binding.reviewerSessionId].every((id) =>
        supportsPacedVideoReviewPeer(this.adapter.reviewerProtocol(id), this.adapter.peerContract?.(id)));
    } catch { return false; }
  }

  async prepare(principal: AuthPrincipal, request: PendingVideoReviewRequest): Promise<PrepareEvidenceReviewResult> {
    const root = agentSession(principal);
    if (!root || principal.kind !== "agent" || principal.orchestrator !== true) return { ok: false, code: "not_authorized" };
    const pending = this.adapter.resolvePending(root, request);
    if (pending?.binding.operatorValidation) return { ok: false, code: "not_authorized" };
    if (!pending || pending.binding.rootSessionId !== root || pending.binding.childSessionId !== request.childSessionId ||
      pending.binding.occurrenceId !== request.occurrenceId || !pending.sourceGrantVerified ||
      !this.adapter.currentOwner(pending.binding)) return { ok: false, code: "not_authorized" };
    if (pending.mode === "custom") return { ok: false, code: "custom_fallback" };
    if (!this.currentPeers(pending.binding) ||
      !supportsPacedVideoReviewPeer(pending.target.runnerProtocolVersion, pending.target.pacedVideoReviewContract)) {
      return { ok: false, code: "mixed_peer" };
    }
    if (!validVideoLiveProof(this.adapter.liveProof(pending.target), pending.target, this.clock())) {
      return { ok: false, code: "live_validation" };
    }
    for (let attempt = 0; attempt <= 2; attempt++) {
      // Each retry must re-resolve the exact resource and authority; a revocation while queued
      // cannot borrow a previous successful preflight.
      const current = this.adapter.resolvePending(root, request);
      if (!current || JSON.stringify(current) !== JSON.stringify(pending) || !this.adapter.currentOwner(current.binding) ||
        !this.currentPeers(current.binding) ||
        !supportsPacedVideoReviewPeer(current.target.runnerProtocolVersion, current.target.pacedVideoReviewContract) ||
        !validVideoLiveProof(this.adapter.liveProof(current.target), current.target, this.clock())) {
        return { ok: false, code: "not_authorized" };
      }
      const started = this.clock();
      const result = await this.runtime.derive(current.binding, current.mediaType, current.criteria);
      const retained = this.adapter.resolvePending(root, request);
      if (!retained || JSON.stringify(retained) !== JSON.stringify(pending) ||
        !this.adapter.currentOwner(retained.binding) || !this.currentPeers(retained.binding) ||
        !supportsPacedVideoReviewPeer(retained.target.runnerProtocolVersion, retained.target.pacedVideoReviewContract) ||
        !validVideoLiveProof(this.adapter.liveProof(retained.target), retained.target, this.clock())) {
        if (result.ok) this.store.settle(result.review.reviewId, "revoked");
        return { ok: false, code: "not_authorized" };
      }
      if (result.ok) {
        this.audit(result.review, "video_evidence_prepared", "owner_prepare", {
          durationMs: Math.max(0, this.clock() - started), attempt });
        return result;
      }
      const recovery = planEvidenceRecovery(current.mode, result.code, attempt);
      this.adapter.audit({ event: "video_evidence_recovery", entryPoint: "owner_prepare",
        occurrenceId: current.binding.occurrenceId, rootSessionId: current.binding.rootSessionId,
        childSessionId: current.binding.childSessionId, reviewerSessionId: current.binding.reviewerSessionId,
        policyRevision: current.binding.policyRevision, attempt, preparationCode: result.code,
        recoveryAction: recovery.action, durationMs: Math.max(0, this.clock() - started) });
      if (recovery.action !== "retry") {
        const b = current.binding;
        const execution = this.adapter.recovery && (recovery.action === "split" || recovery.action === "recapture")
          ? await this.adapter.recovery.execute({ rootSessionId: b.rootSessionId, childSessionId: b.childSessionId,
            occurrenceId: b.occurrenceId, evidenceId: b.sourceEvidenceId, resourceDigest: b.resourceDigest,
            policyRevision: b.policyRevision, sourceSha256: b.sourceSha256,
            criteriaSha256: b.criteriaSha256, workerAdmissionSha256: b.workerAdmissionSha256 }, recovery) : undefined;
        // Replacement subjects start new exact occurrences; this original snapshot cannot be
        // rewritten or approved with substituted media. Unknown operations reconcile only.
        return { ok: false, code: "preparation", recovery, ...(execution ? { execution } : {}) };
      }
      await this.delay(recovery.delayMs);
    }
    return { ok: false, code: "preparation" };
  }

  private authenticatedReviewer(principal: AuthPrincipal, reviewId: string): string {
    const sessionId = agentSession(principal);
    const review = this.store.getReview(reviewId);
    if (!sessionId || !review || sessionId !== review.binding.reviewerSessionId ||
      sessionId === review.binding.childSessionId ||
      !this.currentPeers(review.binding)) {
      throw new Error("This credential cannot review this exact evidence grant.");
    }
    return sessionId;
  }

  private audit(review: VideoReviewRecord, event: EvidenceReviewAuditEvent["event"],
    entryPoint: EvidenceReviewAuditEvent["entryPoint"], fields: Partial<EvidenceReviewAuditEvent>): void {
    this.adapter.audit({ ...fields, event, entryPoint, occurrenceId: review.binding.occurrenceId,
      rootSessionId: review.binding.rootSessionId, childSessionId: review.binding.childSessionId,
      reviewerSessionId: review.binding.reviewerSessionId, policyRevision: review.binding.policyRevision,
      reviewId: review.reviewId, manifestSha256: review.manifestSha256 });
  }

  deliver(principal: AuthPrincipal, reviewId: string, index: number) {
    const delivery = this.runtime.deliver(reviewId, this.authenticatedReviewer(principal, reviewId), index);
    this.audit(this.store.getReview(reviewId)!, "video_evidence_delivery", "reviewer_media",
      { receiptId: delivery.receipt.receiptId, frameIndex: index });
    return delivery;
  }
  deliverBatch(principal: AuthPrincipal, reviewId: string, index: number) {
    const result = this.runtime.deliverBatch(reviewId, this.authenticatedReviewer(principal, reviewId), index);
    for (const delivery of result.deliveries) this.audit(this.store.getReview(reviewId)!, "video_evidence_delivery", "reviewer_media",
      { receiptId: delivery.receipt.receiptId, frameIndex: delivery.receipt.videoFrame.index });
    return result;
  }
  acknowledgeBatch(principal: AuthPrincipal, reviewId: string, receipts: readonly { receiptId: string; sha256: string }[]): void {
    this.runtime.acknowledgeBatch(reviewId, this.authenticatedReviewer(principal, reviewId), receipts);
    for (const receipt of receipts) this.audit(this.store.getReview(reviewId)!, "video_evidence_acknowledged", "reviewer_media",
      { receiptId: receipt.receiptId });
  }
  acknowledge(principal: AuthPrincipal, reviewId: string, receiptId: string, sha256: string): void {
    this.runtime.acknowledge(reviewId, this.authenticatedReviewer(principal, reviewId), receiptId, sha256);
    this.audit(this.store.getReview(reviewId)!, "video_evidence_acknowledged", "reviewer_media", { receiptId });
  }
  verdict(principal: AuthPrincipal, reviewId: string,
    report: Pick<VideoReviewVerdict, "outcome" | "criteria" | "rationale">): VideoReviewVerdict {
    const verdict = this.runtime.recordVerdict(reviewId, this.authenticatedReviewer(principal, reviewId), report);
    this.audit(this.store.getReview(reviewId)!, "video_evidence_verdict", "reviewer_verdict",
      { verdictId: verdict.verdictId, outcome: verdict.outcome });
    return verdict;
  }
  ownerProvenance(principal: AuthPrincipal, reviewId: string): VideoReviewVerdict {
    const root = agentSession(principal);
    const review = this.store.getReview(reviewId);
    if (principal.kind !== "agent" || principal.orchestrator !== true || !root || !review ||
      review.binding.rootSessionId !== root || root === review.binding.childSessionId ||
      !this.adapter.currentOwner(review.binding) || !this.currentPeers(review.binding)) {
      throw new Error("Only the exact current workflow decision owner with supported private peers can inspect approval provenance.");
    }
    // Server chooses the authenticated admitted reviewer from the stored grant, not owner JSON.
    const verdict = this.runtime.approvalProvenance(reviewId, review.binding.reviewerSessionId);
    this.audit(review, "video_evidence_provenance", "owner_provenance", { verdictId: verdict.verdictId });
    return verdict;
  }
}
