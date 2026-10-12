import type { UiEvidenceReviewReceipt } from "./index.js";

export const PACED_VIDEO_REVIEW_BATCH_LIMITS = Object.freeze({ frames: 32, responseBytes: 8 * 1024 * 1024 });

/** Server-derived complete-frame receipt. Types grant no media access or empirical readiness. */
export interface PacedVideoReviewReceipt extends UiEvidenceReviewReceipt {
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
