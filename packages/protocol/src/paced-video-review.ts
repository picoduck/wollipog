/** Unadvertised private minimum, independent of public221 retry/public222 event reads. */
export const PACED_VIDEO_REVIEW_MIN_PROTOCOL = 223;
export const PACED_VIDEO_REVIEW_CONTRACT_ID = "wollipog-paced-video-review-v1" as const;
/** Compatibility metadata only. This cannot attest runtime isolation, mint a grant or enable
 * production admission. Runners emit it only for a re-proven media-only reviewer installation;
 * the control plane's compatibility response still emits none until PR C registers the adapters. */
export interface PacedVideoReviewPeerContract {
  readonly id: typeof PACED_VIDEO_REVIEW_CONTRACT_ID;
  readonly revision: 1;
}
export function validPacedVideoReviewPeerContract(value: unknown): value is PacedVideoReviewPeerContract {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== 2) return false;
    const fields = Object.getOwnPropertyDescriptors(value);
    return Boolean(fields.id && "value" in fields.id && fields.id.value === PACED_VIDEO_REVIEW_CONTRACT_ID &&
      fields.revision && "value" in fields.revision && fields.revision.value === 1);
  } catch { return false; }
}
/** Numeric versions alone, including future public versions, never imply this private contract. */
export function supportsPacedVideoReviewPeer(protocolVersion: unknown, contract: unknown): boolean {
  return typeof protocolVersion === "number" && Number.isSafeInteger(protocolVersion) &&
    protocolVersion >= PACED_VIDEO_REVIEW_MIN_PROTOCOL && validPacedVideoReviewPeerContract(contract);
}
import type { UiEvidenceReviewReceipt } from "./index.js";

/** At most 20 frames per batch. Claude Code 2.1.296 estimates 1600 tokens per tool-result image and,
 * above its MCP output cap, DOWNSCALES images rather than failing. The media reviewer therefore
 * runs with a reviewer-scoped cap that keeps a full batch below the CLI's no-inspection half. */
export const PACED_VIDEO_REVIEW_BATCH_LIMITS = Object.freeze({ frames: 20, responseBytes: 8 * 1024 * 1024 });

/** Permanent experimental purpose. These observations never authorize a production UI gate. */
export interface OperatorVideoValidationPurpose { permitId: string; scopeSha256: string }

/** Server-derived complete-frame receipt. Types grant no media access or empirical readiness. */
export interface PacedVideoReviewReceipt extends UiEvidenceReviewReceipt {
  operatorValidation?: OperatorVideoValidationPurpose;
  bindingSha256: string;
  criteriaSha256: string;
  deliveryOrder: number;
  videoFrame: NonNullable<UiEvidenceReviewReceipt["videoFrame"]> & {
    profile: "paced-silent-complete-frames-v1";
    ptsUs: number;
    durationUs: number;
  };
}
export interface PacedVideoReviewDelivery {
  receipt: PacedVideoReviewReceipt;
  mimeType: "image/png";
  sizeBytes: number;
  /** Only the authenticated media response and image content block may carry these bytes. */
  data: string;
}
/** Trusted runner configuration from the exact server grant, never model tool arguments. */
export interface PacedVideoTransportGrant {
  operatorValidation?: OperatorVideoValidationPurpose;
  reviewId: string;
  reviewerSessionId: string;
  childSessionId: string;
  occurrenceId: string;
  policyRevision: number;
  sourceEvidenceId: string;
  sourceArtifactId: string;
  sourceSha256: string;
  manifestSha256: string;
  bindingSha256: string;
  criteriaSha256: string;
  expiresAt: number;
  frames: Array<{ index: number; ptsUs: number; durationUs: number; sha256: string; sizeBytes: number }>;
}

/** Actual media actor and quality proof, distinct from the owner's directly inspected images. */
export interface DelegatedVideoEvidenceReference {
  evidenceId: string;
  reviewId: string;
  verdictId: string;
  reviewerSessionId: string;
}

export interface PacedVideoReviewBatchDelivery {
  deliveries: PacedVideoReviewDelivery[];
  nextIndex: number;
  frameCount: number;
}
