import { validReviewerBudgetAdmission, type EvidenceReviewerBudgetAdmission } from "./evidence-review-admission.js";
import { createHash, randomUUID } from "node:crypto";
import { PACED_VIDEO_REVIEW_MIN_PROTOCOL, PACED_VIDEO_REVIEW_BATCH_LIMITS, type PacedVideoReviewReceipt, type OperatorVideoValidationPurpose } from "@wollipog/protocol";
import { prepareVideoEvidence, prepareCandidateVideoEvidence, PACED_VIDEO_PREPARATION_PROFILE,
  type VideoPreparationManifest, type VideoPreparationResult } from "./video-evidence-preparation.js";

export const PRODUCTION_VIDEO_REVIEW_PROTOCOL = PACED_VIDEO_REVIEW_MIN_PROTOCOL;
export const VIDEO_REVIEW_BATCH = PACED_VIDEO_REVIEW_BATCH_LIMITS;
export const PACED_VIDEO_REVIEW_PROFILE = "paced-silent-complete-frames-v1" as const;
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

/** These values are resolved by the authenticated service, never accepted as child assertions.
 * Any change invalidates the pending review, including a runtime capability/audience change. */
export interface VideoReviewBinding {
  operatorValidation?: OperatorVideoValidationPurpose;
  rootSessionId: string;
  childSessionId: string;
  occurrenceId: string;
  resourceDigest: string;
  policyRevision: number;
  boundaryRevision: number;
  evidenceAuthorityRevision: number;
  reviewerSessionId: string;
  reviewerDriver: string;
  reviewerModelId: string;
  providerId: string;
  audienceSha256: string;
  capabilitiesSha256: string;
  sourceEvidenceId: string;
  sourceArtifactId: string;
  sourceSha256: string;
  workerAdmissionSha256: string;
  criteriaSha256: string;
}

export interface TemporalVideoManifest extends Omit<VideoPreparationManifest, "purpose" | "profile"> {
  purpose: "trusted_temporal_derivation";
  profile: typeof PACED_VIDEO_REVIEW_PROFILE;
  /** Candidate derivation is validation-only and never satisfies paced production coverage. */
  captureProfile?: "candidate";
}
export interface VideoReviewRecord {
  reviewId: string;
  binding: VideoReviewBinding;
  manifest: TemporalVideoManifest;
  manifestSha256: string;
  criteria: VideoReviewCriterion[];
  criteriaSha256: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "revoked" | "consumed";
}
export type TemporalVideoReceipt = PacedVideoReviewReceipt;
export interface VideoReviewCriterion { criterionId: string; description: string }
export interface VideoReviewVerdict {
  operatorValidation?: OperatorVideoValidationPurpose;
  verdictId: string;
  reviewId: string;
  reviewerSessionId: string;
  manifestSha256: string;
  bindingSha256: string;
  criteriaSha256: string;
  receiptIds: string[];
  outcome: "accept" | "reject";
  criteria: Array<{ criterionId: string; outcome: "pass" | "fail" | "blocked";
    observedFrameIndices: number[]; observation: string }>;
  rationale: string;
  recordedAt: number;
  workerAdmission: EvidenceReviewerBudgetAdmission;
}

/** Production adapter must implement atomic persistence and narrow artifact access. No in-memory
 * fallback: missing durable storage means unsupported readiness, not an approval. Bytes belong
 * only in private artifact storage; projections and audit logs receive metadata. */
export interface VideoReviewStore {
  saveDerived(record: VideoReviewRecord, images: readonly Buffer[]): void;
  getReview(reviewId: string): VideoReviewRecord | null;
  findPending(bindingSha256: string, now: number): VideoReviewRecord | null;
  readFrame(reviewId: string, index: number): Buffer | null;
  latestReceipts(reviewId: string): Array<{ receipt: TemporalVideoReceipt; acknowledged: boolean }>;
  recordDelivery(reviewId: string, receipt: TemporalVideoReceipt): void;
  recordBatch(reviewId: string, receipts: readonly TemporalVideoReceipt[]): void;
  acknowledgeBatch(reviewId: string, receipts: readonly { receiptId: string; sha256: string }[]): boolean;
  acknowledge(reviewId: string, receiptId: string, sha256: string): boolean;
  saveVerdict(verdict: VideoReviewVerdict): void;
  getVerdict(reviewId: string): VideoReviewVerdict | null;
  settle(reviewId: string, status: "revoked" | "consumed"): void;
}

export interface VideoReviewRuntimeAccess {
  /** Trusted current permit lookup. A validation binding cannot select its own decoder profile. */
  validationProfile?(review: VideoReviewBinding): "candidate" | "paced" | "maximum" | null;
  /** Re-resolves exact pending occurrence, authority, scope, capabilities, managed reviewer
   * identity and reservation on every operation. Returns null for stale/unavailable bindings. */
  currentBinding(review: VideoReviewBinding, phase: "derive" | "media" | "attest" | "resolve"): VideoReviewBinding | null;
  /** Active preflight for derive/media/attest; resolve verifies the durable historical snapshot
   * plus current denial/exhaustion/action constraints. Normal completion grants no fresh access. */
  /** True only after durable final usage/normal completion settlement, never revocation. */
  normalCompletion(review: VideoReviewBinding): boolean;
  workerAdmission(review: VideoReviewBinding, phase: "active" | "historical"): EvidenceReviewerBudgetAdmission | null;
  readSource(artifactId: string): Buffer | null;
}
export class VideoReviewRefused extends Error {
  constructor(readonly reason: "stale" | "source_mismatch" | "frame_mismatch" | "order" |
    "receipt" | "verdict" | "self_review" | "criteria") {
    super("Video evidence review refused: " + reason);
  }
}
export const videoReviewBindingDigest = (binding: VideoReviewBinding) => hash(JSON.stringify(binding));
const fresh = (binding: VideoReviewBinding, access: VideoReviewRuntimeAccess,
  phase: "derive" | "media" | "attest" | "resolve") => {
  const current = access.currentBinding(binding, phase);
  return current !== null && videoReviewBindingDigest(current) === videoReviewBindingDigest(binding);
};
const scopedId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/u.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function validBinding(b: VideoReviewBinding): boolean {
  if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).length !== (b.operatorValidation === undefined ? 18 : 19) ||
    Object.keys(b).some((key) => !["rootSessionId", "childSessionId", "occurrenceId", "resourceDigest",
      "policyRevision", "boundaryRevision", "evidenceAuthorityRevision", "reviewerSessionId",
      "reviewerDriver", "reviewerModelId", "providerId", "audienceSha256", "capabilitiesSha256",
      "sourceEvidenceId", "sourceArtifactId", "sourceSha256", "workerAdmissionSha256", "criteriaSha256", "operatorValidation"].includes(key))) return false;
  if (b.operatorValidation !== undefined && (!b.operatorValidation ||
    Object.keys(b.operatorValidation).length !== 2 || !scopedId(b.operatorValidation.permitId) || !digest(b.operatorValidation.scopeSha256))) return false;
  return [b.rootSessionId, b.childSessionId, b.occurrenceId, b.reviewerSessionId,
    b.reviewerDriver, b.reviewerModelId, b.providerId, b.sourceEvidenceId, b.sourceArtifactId].every(scopedId) &&
    [b.resourceDigest, b.audienceSha256, b.capabilitiesSha256, b.sourceSha256, b.workerAdmissionSha256, b.criteriaSha256].every(digest) &&
    [b.policyRevision, b.boundaryRevision, b.evidenceAuthorityRevision].every((n) => Number.isSafeInteger(n) && n > 0);
}

function validCriteria(criteria: readonly VideoReviewCriterion[]): boolean {
  return Array.isArray(criteria) && criteria.length > 0 && criteria.length <= 64 &&
    new Set(criteria.map((c) => c.criterionId)).size === criteria.length &&
    criteria.every((c) => c && typeof c === "object" && !Array.isArray(c) &&
      Object.keys(c).length === 2 && Object.keys(c).every((key) => ["criterionId", "description"].includes(key)) && scopedId(c.criterionId) && typeof c.description === "string" &&
      c.description.trim().length > 0 && c.description.length <= 4000 && !/[\x00-\x08\x0b-\x1f\x7f]/u.test(c.description));
}

/** All-source-frame runtime; no raw-video claim, sampled-still motion claim, quality verdict, or
 * live-validation proof is generated by derivation. Service admission must independently require
 * a verified production-profile live proof before exposing this runtime through the agent API. */
export class VideoEvidenceRuntime {
  private readonly inFlight = new Map<string, Promise<{ ok: true; review: VideoReviewRecord } | Extract<VideoPreparationResult, { ok: false }>>>();
  constructor(private readonly store: VideoReviewStore, private readonly access: VideoReviewRuntimeAccess,
    private readonly clock: () => number = Date.now) {}

  async derive(binding: VideoReviewBinding, mediaType: "video/webm" | "video/mp4",
    criteria: readonly VideoReviewCriterion[])
    : Promise<{ ok: true; review: VideoReviewRecord } | Extract<VideoPreparationResult, { ok: false }>> {
    if (!validBinding(binding) || !fresh(binding, this.access, "derive")) throw new VideoReviewRefused("stale");
    if (binding.childSessionId === binding.reviewerSessionId) throw new VideoReviewRefused("self_review");
    if (!validCriteria(criteria) || hash(JSON.stringify(criteria)) !== binding.criteriaSha256) throw new VideoReviewRefused("criteria");
    if (!validReviewerBudgetAdmission(this.access.workerAdmission(binding, "active"), binding)) throw new VideoReviewRefused("stale");
    const key = videoReviewBindingDigest(binding);
    const prior = this.inFlight.get(key);
    if (prior) return prior;
    const existing = this.store.findPending(key, this.clock());
    if (existing) {
      this.current(existing.reviewId, binding.reviewerSessionId);
      return { ok: true, review: existing };
    }
    const pending = this.deriveInner(binding, mediaType, criteria);
    this.inFlight.set(key, pending);
    try { return await pending; } finally { if (this.inFlight.get(key) === pending) this.inFlight.delete(key); }
  }

  private async deriveInner(binding: VideoReviewBinding, mediaType: "video/webm" | "video/mp4",
    criteria: readonly VideoReviewCriterion[])
    : Promise<{ ok: true; review: VideoReviewRecord } | Extract<VideoPreparationResult, { ok: false }>> {
    if (!validBinding(binding) || !fresh(binding, this.access, "derive")) throw new VideoReviewRefused("stale");
    if (binding.childSessionId === binding.reviewerSessionId) throw new VideoReviewRefused("self_review");
    if (!validCriteria(criteria)) throw new VideoReviewRefused("criteria");
    const pinnedCriteria = structuredClone([...criteria]);
    // Snapshot both context and exact source before awaiting bounded native conversion.
    const pinned = structuredClone(binding);
    if (!validReviewerBudgetAdmission(this.access.workerAdmission(pinned, "active"), pinned)) throw new VideoReviewRefused("stale");
    const bytes = this.access.readSource(pinned.sourceArtifactId);
    if (!bytes || hash(bytes) !== pinned.sourceSha256) throw new VideoReviewRefused("source_mismatch");
    const validationProfile = pinned.operatorValidation ? this.access.validationProfile?.(pinned) : undefined;
    if (pinned.operatorValidation && !validationProfile) throw new VideoReviewRefused("stale");
    const result = await (validationProfile === "candidate"
      ? prepareCandidateVideoEvidence(bytes, mediaType) : prepareVideoEvidence(bytes, mediaType));
    if (!result.ok) return result;
    if (!fresh(pinned, this.access, "derive") ||
      !validReviewerBudgetAdmission(this.access.workerAdmission(pinned, "active"), pinned)) throw new VideoReviewRefused("stale");
    const retained = this.access.readSource(pinned.sourceArtifactId);
    if (!retained || hash(retained) !== pinned.sourceSha256) throw new VideoReviewRefused("source_mismatch");
    if (pinned.operatorValidation && this.access.validationProfile?.(pinned) !== validationProfile) throw new VideoReviewRefused("stale");
    const manifest: TemporalVideoManifest = { ...result.manifest,
      ...(validationProfile === "candidate" ? { captureProfile: "candidate" as const } : {}),
      purpose: "trusted_temporal_derivation", profile: PACED_VIDEO_REVIEW_PROFILE };
    const now = this.clock();
    const review: VideoReviewRecord = {
      reviewId: "video_review_" + randomUUID().replaceAll("-", ""), binding: pinned,
      manifest, manifestSha256: hash(JSON.stringify(manifest)),
      criteria: pinnedCriteria, criteriaSha256: hash(JSON.stringify(pinnedCriteria)),
      createdAt: now, expiresAt: now + 60 * 60 * 1000, status: "pending",
    };
    this.store.saveDerived(review, result.images);
    return { ok: true, review };
  }

  private current(reviewId: string, authenticatedReviewerSessionId: string,
    phase: "media" | "attest" | "resolve" = "media"): VideoReviewRecord {
    const review = this.store.getReview(reviewId);
    if (!review || review.binding.reviewerSessionId !== authenticatedReviewerSessionId ||
      review.status !== "pending") throw new VideoReviewRefused("stale");
    if (review.expiresAt <= this.clock() || review.createdAt > this.clock()) {
      this.store.settle(reviewId, "revoked");
      throw new VideoReviewRefused("stale");
    }
    if (phase !== "resolve" && this.store.getVerdict(reviewId) &&
        (this.access.normalCompletion(review.binding) ||
          !fresh(review.binding, this.access, phase) && fresh(review.binding, this.access, "resolve"))) {
      // Normal worker completion or an already resolved gate has no fresh media/attestation grant. Its already recorded
      // quality proof remains subject to every current owner/authority/integrity check below.
      throw new VideoReviewRefused("stale");
    }
    if (!fresh(review.binding, this.access, phase) ||
      (review.manifest.captureProfile === "candidate" && !review.binding.operatorValidation) ||
      (review.binding.operatorValidation && (!this.access.validationProfile?.(review.binding) ||
        (this.access.validationProfile(review.binding) === "candidate") !== (review.manifest.captureProfile === "candidate"))) ||
      !validReviewerBudgetAdmission(this.access.workerAdmission(review.binding, phase === "resolve" ? "historical" : "active"), review.binding) || hash(JSON.stringify(review.manifest)) !== review.manifestSha256 ||
      !validCriteria(review.criteria) || hash(JSON.stringify(review.criteria)) !== review.criteriaSha256 ||
      review.criteriaSha256 !== review.binding.criteriaSha256) {
      this.store.settle(reviewId, "revoked");
      throw new VideoReviewRefused("stale");
    }
    const source = this.access.readSource(review.binding.sourceArtifactId);
    if (!source || hash(source) !== review.binding.sourceSha256) {
      this.store.settle(reviewId, "revoked");
      throw new VideoReviewRefused("source_mismatch");
    }
    return review;
  }

  deliver(reviewId: string, authenticatedReviewerSessionId: string, index: number)
    : { receipt: TemporalVideoReceipt; bytes: Buffer; mimeType: "image/png" } {
    const review = this.current(reviewId, authenticatedReviewerSessionId);
    const frame = review.manifest.frames[index];
    if (!Number.isSafeInteger(index) || !frame || index !== frame.index) throw new VideoReviewRefused("order");
    const receipts = this.store.latestReceipts(reviewId);
    const bindingDigest = videoReviewBindingDigest(review.binding);
    // Redelivery is permitted only for the current unacknowledged frame. Earlier replay cannot
    // replace provenance after a later frame or a verdict, so a fresh occurrence is required.
    if (this.store.getVerdict(reviewId) || receipts.some((r) => r.receipt.videoFrame.index > index) ||
      review.manifest.frames.slice(0, index).some((prior) => !receipts.some((r) =>
        r.acknowledged && this.matches(review, prior.index, r.receipt, bindingDigest)))) throw new VideoReviewRefused("order");
    const delivery = this.frameDelivery(review, index, receipts.reduce((max, r) => Math.max(max, r.receipt.deliveryOrder), 0) + 1);
    this.store.recordDelivery(reviewId, delivery.receipt);
    return delivery;
  }

  private frameDelivery(review: VideoReviewRecord, index: number, deliveryOrder: number)
    : { receipt: TemporalVideoReceipt; bytes: Buffer; mimeType: "image/png" } {
    const frame = review.manifest.frames[index]!;
    const reviewId = review.reviewId;
    const bytes = this.store.readFrame(reviewId, index);
    if (!bytes || bytes.length !== frame.sizeBytes || hash(bytes) !== frame.sha256 ||
      bytes.length > PACED_VIDEO_PREPARATION_PROFILE.frameBytes) {
      this.store.settle(reviewId, "revoked");
      throw new VideoReviewRefused("frame_mismatch");
    }
    const binding = review.binding;
    const receipt: TemporalVideoReceipt = {
      ...(binding.operatorValidation ? { operatorValidation: structuredClone(binding.operatorValidation) } : {}),
      bindingSha256: videoReviewBindingDigest(binding), criteriaSha256: review.criteriaSha256,
      receiptId: "uireceipt_" + randomUUID().replaceAll("-", ""),
      occurrenceId: binding.occurrenceId, reviewerSessionId: binding.reviewerSessionId,
      childSessionId: binding.childSessionId, policyRevision: binding.policyRevision,
      evidenceId: binding.sourceEvidenceId,
      artifactId: review.reviewId + ":frame:" + index, sha256: frame.sha256,
      deliveredAt: this.clock(), deliveryOrder,
      videoFrame: { sourceArtifactId: binding.sourceArtifactId, sourceSha256: binding.sourceSha256,
        manifestSha256: review.manifestSha256, profile: PACED_VIDEO_REVIEW_PROFILE,
        index, ptsMs: frame.ptsUs / 1000, ptsUs: frame.ptsUs, durationUs: frame.durationUs },
    };
    return { receipt, bytes, mimeType: "image/png" };
  }

  /** Consecutive bounded complete frames, not sampled stills. Unacknowledged redelivery may
   * replace only this exact window, never earlier provenance after a later window. */
  deliverBatch(reviewId: string, reviewerSessionId: string, firstIndex: number): {
    deliveries: Array<{ receipt: TemporalVideoReceipt; bytes: Buffer; mimeType: "image/png" }>;
    nextIndex: number; frameCount: number;
  } {
    const review = this.current(reviewId, reviewerSessionId);
    if (!Number.isSafeInteger(firstIndex) || firstIndex < 0 || firstIndex >= review.manifest.frames.length) throw new VideoReviewRefused("order");
    const existing = this.store.latestReceipts(reviewId);
    const bindingDigest = videoReviewBindingDigest(review.binding);
    if (this.store.getVerdict(reviewId) || review.manifest.frames.slice(0, firstIndex).some((frame) =>
      !existing.some((r) => r.acknowledged && this.matches(review, frame.index, r.receipt, bindingDigest)))) throw new VideoReviewRefused("order");
    let deliveryOrder = existing.reduce((max, r) => Math.max(max, r.receipt.deliveryOrder), 0);
    const deliveries: Array<{ receipt: TemporalVideoReceipt; bytes: Buffer; mimeType: "image/png" }> = [];
    let responseBytes = 4096;
    for (let index = firstIndex; index < review.manifest.frames.length && deliveries.length < VIDEO_REVIEW_BATCH.frames; index++) {
      const delivery = this.frameDelivery(review, index, ++deliveryOrder);
      const entryBytes = Buffer.byteLength(JSON.stringify({
        receipt: delivery.receipt, mimeType: delivery.mimeType, sizeBytes: delivery.bytes.length, data: "",
      })) + Math.ceil(delivery.bytes.length / 3) * 4 + 1;
      if (responseBytes + entryBytes > VIDEO_REVIEW_BATCH.responseBytes) break;
      responseBytes += entryBytes; deliveries.push(delivery);
    }
    if (!deliveries.length || existing.some((r) => r.receipt.videoFrame.index >= firstIndex + deliveries.length)) throw new VideoReviewRefused("order");
    this.store.recordBatch(reviewId, deliveries.map((delivery) => delivery.receipt));
    return { deliveries, nextIndex: firstIndex + deliveries.length, frameCount: review.manifest.frames.length };
  }

  acknowledgeBatch(reviewId: string, reviewerSessionId: string,
    receipts: readonly { receiptId: string; sha256: string }[]): void {
    this.current(reviewId, reviewerSessionId);
    if (!Array.isArray(receipts) || !receipts.length || receipts.length > VIDEO_REVIEW_BATCH.frames ||
      new Set(receipts.map((r) => r.receiptId)).size !== receipts.length ||
      receipts.some((r) => !scopedId(r.receiptId) || !digest(r.sha256)) ||
      !this.store.acknowledgeBatch(reviewId, receipts)) throw new VideoReviewRefused("receipt");
  }

  acknowledge(reviewId: string, authenticatedReviewerSessionId: string, receiptId: string, sha256: string): void {
    this.current(reviewId, authenticatedReviewerSessionId);
    if (!this.store.acknowledge(reviewId, receiptId, sha256)) throw new VideoReviewRefused("receipt");
  }

  private matches(review: VideoReviewRecord, index: number, receipt: TemporalVideoReceipt, bindingDigest: string): boolean {
    const f = review.manifest.frames[index];
    const b = review.binding;
    const v = receipt.videoFrame;
    return Boolean(f && JSON.stringify(receipt.operatorValidation) === JSON.stringify(b.operatorValidation) &&
      Number.isSafeInteger(receipt.deliveredAt) && receipt.deliveredAt >= review.createdAt &&
      receipt.deliveredAt <= this.clock() && receipt.deliveredAt < review.expiresAt && receipt.bindingSha256 === bindingDigest && receipt.criteriaSha256 === review.criteriaSha256 && receipt.occurrenceId === b.occurrenceId && receipt.reviewerSessionId === b.reviewerSessionId &&
      receipt.childSessionId === b.childSessionId && receipt.policyRevision === b.policyRevision &&
      receipt.artifactId === review.reviewId + ":frame:" + index && receipt.evidenceId === b.sourceEvidenceId &&
      receipt.sha256 === f.sha256 && v.sourceArtifactId === b.sourceArtifactId && v.sourceSha256 === b.sourceSha256 &&
      v.manifestSha256 === review.manifestSha256 && v.profile === PACED_VIDEO_REVIEW_PROFILE &&
      v.index === index && v.ptsUs === f.ptsUs && v.ptsMs === f.ptsUs / 1000 && v.durationUs === f.durationUs);
  }

  private completeReceipts(review: VideoReviewRecord): TemporalVideoReceipt[] {
    const delivered = this.store.latestReceipts(review.reviewId);
    let order = 0;
    const bindingDigest = videoReviewBindingDigest(review.binding);
    const complete = review.manifest.frames.map((frame) => {
      const matches = delivered.filter((r) => r.acknowledged && this.matches(review, frame.index, r.receipt, bindingDigest));
      if (matches.length !== 1 || matches[0]!.receipt.deliveryOrder <= order) throw new VideoReviewRefused("receipt");
      order = matches[0]!.receipt.deliveryOrder;
      return matches[0]!.receipt;
    });
    if (complete.length !== delivered.length) throw new VideoReviewRefused("receipt");
    return complete;
  }

  recordVerdict(reviewId: string, authenticatedReviewerSessionId: string,
    report: Pick<VideoReviewVerdict, "outcome" | "criteria" | "rationale">): VideoReviewVerdict {
    const review = this.current(reviewId, authenticatedReviewerSessionId, "attest");
    if (this.store.getVerdict(reviewId)) throw new VideoReviewRefused("verdict");
    const receipts = this.completeReceipts(review);
    const criteria = review.criteria;
    const boundedText = (value: unknown, max: number): value is string =>
      typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x08\x0b-\x1f\x7f]/u.test(value);
    if (!report || typeof report !== "object" || Array.isArray(report) ||
      Object.keys(report).length !== 3 || Object.keys(report).some((key) => !["outcome", "criteria", "rationale"].includes(key)) ||
      !Array.isArray(report.criteria) || !criteria.length || criteria.length > 64 || new Set(criteria.map((c) => c.criterionId)).size !== criteria.length ||
      criteria.some((c) => !scopedId(c.criterionId) || !boundedText(c.description, 4000)) ||
      report.criteria.length !== criteria.length || !boundedText(report.rationale, 8000) ||
      !["accept", "reject"].includes(report.outcome) ||
      report.criteria.some((c, i) => !c || typeof c !== "object" || Array.isArray(c) ||
        Object.keys(c).length !== 4 || Object.keys(c).some((key) => !["criterionId", "outcome", "observedFrameIndices", "observation"].includes(key)) ||
        !Array.isArray(c.observedFrameIndices) || c.criterionId !== criteria[i]!.criterionId ||
        !["pass", "fail", "blocked"].includes(c.outcome) || !boundedText(c.observation, 4000) ||
        c.observedFrameIndices.length === 0 || c.observedFrameIndices.length > review.manifest.frames.length ||
        new Set(c.observedFrameIndices).size !== c.observedFrameIndices.length ||
        c.observedFrameIndices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= review.manifest.frames.length)) ||
      (report.outcome === "accept" && report.criteria.some((c) => c.outcome !== "pass")) ||
      (report.outcome === "reject" && report.criteria.every((c) => c.outcome === "pass"))) throw new VideoReviewRefused("criteria");
    const workerAdmission = this.access.workerAdmission(review.binding, "active");
    if (!validReviewerBudgetAdmission(workerAdmission, review.binding)) throw new VideoReviewRefused("stale");
    const verdict: VideoReviewVerdict = { ...structuredClone(report), verdictId: "uiverdict_" + randomUUID().replaceAll("-", ""),
      ...(review.binding.operatorValidation ? { operatorValidation: structuredClone(review.binding.operatorValidation) } : {}),
      reviewId, reviewerSessionId: authenticatedReviewerSessionId, manifestSha256: review.manifestSha256,
      bindingSha256: videoReviewBindingDigest(review.binding), criteriaSha256: review.criteriaSha256,
      receiptIds: receipts.map((r) => r.receiptId), recordedAt: this.clock(),
      workerAdmission: structuredClone(workerAdmission) };
    this.store.saveVerdict(verdict);
    return verdict;
  }

  /** The controlling owner still resolves the existing typed decision. This only supplies
   * current server-verifiable provenance; it does not resolve or consume a workflow decision. */
  approvalProvenance(reviewId: string, authenticatedReviewerSessionId: string): VideoReviewVerdict {
    if (this.store.getReview(reviewId)?.binding.operatorValidation) throw new VideoReviewRefused("verdict");
    const verdict = this.verifiedObservation(reviewId, authenticatedReviewerSessionId);
    if (verdict.outcome !== "accept" || verdict.operatorValidation) throw new VideoReviewRefused("verdict");
    return verdict;
  }

  /** Metadata/quality observation only for the separate authenticated Human inspection ingress.
   * Never an approval/consumption or readiness proof; rejects non-validation observations. */
  validationObservation(reviewId: string, authenticatedReviewerSessionId: string): VideoReviewVerdict {
    if (!this.store.getReview(reviewId)?.binding.operatorValidation) throw new VideoReviewRefused("verdict");
    return this.verifiedObservation(reviewId, authenticatedReviewerSessionId);
  }

  private verifiedObservation(reviewId: string, authenticatedReviewerSessionId: string): VideoReviewVerdict {
    const review = this.current(reviewId, authenticatedReviewerSessionId, "resolve");
    const receipts = this.completeReceipts(review);
    for (const frame of review.manifest.frames) {
      const bytes = this.store.readFrame(reviewId, frame.index);
      if (!bytes || bytes.length !== frame.sizeBytes || hash(bytes) !== frame.sha256) {
        this.store.settle(reviewId, "revoked");
        throw new VideoReviewRefused("frame_mismatch");
      }
    }
    const verdict = this.store.getVerdict(reviewId);
    if (!verdict || !validReviewerBudgetAdmission(verdict.workerAdmission, review.binding) ||
      JSON.stringify(verdict.operatorValidation) !== JSON.stringify(review.binding.operatorValidation) || verdict.reviewerSessionId !== authenticatedReviewerSessionId ||
      verdict.manifestSha256 !== review.manifestSha256 || verdict.bindingSha256 !== videoReviewBindingDigest(review.binding) ||
      verdict.criteriaSha256 !== review.criteriaSha256 ||
      JSON.stringify(verdict.receiptIds) !== JSON.stringify(receipts.map((r) => r.receiptId))) throw new VideoReviewRefused("verdict");
    return verdict;
  }
}
