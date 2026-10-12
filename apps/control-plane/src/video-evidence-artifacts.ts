import { createHash } from "node:crypto";
import type { WorkflowArtifactView } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { SqliteVideoReviewStore, type VideoReviewFrameStorage } from "./video-evidence-runtime-store.js";
import { PACED_VIDEO_REVIEW_PROFILE, videoReviewBindingDigest, type VideoReviewRecord } from "./video-evidence-runtime.js";
import { PACED_VIDEO_PREPARATION_PROFILE } from "./video-evidence-preparation.js";

const artifactId = (review: VideoReviewRecord, index: number) => review.reviewId + ":frame:" + index;
const metadata = (review: VideoReviewRecord, index: number) => ({
  purpose: "temporal_video_review_frame",
  profile: PACED_VIDEO_REVIEW_PROFILE,
  reviewId: review.reviewId,
  sourceArtifactId: review.binding.sourceArtifactId,
  sourceSha256: review.binding.sourceSha256,
  bindingSha256: videoReviewBindingDigest(review.binding),
  manifestSha256: review.manifestSha256,
  frameIndex: index,
  ptsUs: review.manifest.frames[index]!.ptsUs,
  durationUs: review.manifest.frames[index]!.durationUs,
  expiresAt: review.expiresAt,
});

/** Internal frame storage uses the existing private verified content-addressed artifact backend.
 * A public attachment or caller-authored screenshot cannot impersonate a derived frame. */
export class ControlPlaneVideoFrameStorage implements VideoReviewFrameStorage {
  private readonly created = new Set<string>();
  constructor(private readonly db: ControlPlaneDb) {}
  writeFrame(review: VideoReviewRecord, index: number, bytes: Buffer): void {
    const frame = review.manifest.frames[index];
    const id = artifactId(review, index);
    if (!frame || frame.index !== index || bytes.length !== frame.sizeBytes ||
      bytes.length > PACED_VIDEO_PREPARATION_PROFILE.frameBytes ||
      createHash("sha256").update(bytes).digest("hex") !== frame.sha256 ||
      this.db.workflowArtifactExportPreflight(id)?.artifact) throw new Error("Derived video frame storage identity is invalid.");
    const artifact: WorkflowArtifactView = {
      artifactId: id, sessionId: review.binding.childSessionId, kind: "screenshot",
      name: "Video Frame " + (index + 1) + ".png", mimeType: "image/png", encoding: "base64",
      sizeBytes: bytes.length, sha256: frame.sha256, createdBy: { kind: "system", id: "video-review-v2" },
      metadata: metadata(review, index), createdAt: review.createdAt,
    };
    this.db.createWorkflowArtifactBytes(artifact, bytes);
    this.created.add(id);
  }
  readFrame(review: VideoReviewRecord, index: number): Buffer | null {
    const frame = review.manifest.frames[index];
    const id = artifactId(review, index);
    const artifact = this.db.workflowArtifactExportPreflight(id)?.artifact;
    if (!frame || !artifact || artifact.sessionId !== review.binding.childSessionId ||
      artifact.kind !== "screenshot" || artifact.encoding !== "base64" || artifact.mimeType !== "image/png" ||
      artifact.sha256 !== frame.sha256 || artifact.sizeBytes !== frame.sizeBytes ||
      artifact.createdBy.kind !== "system" || artifact.createdBy.id !== "video-review-v2" ||
      JSON.stringify(artifact.metadata) !== JSON.stringify(metadata(review, index))) return null;
    try { return this.db.readWorkflowArtifactBytes(id); } catch { return null; }
  }
  finishDerivation(review: VideoReviewRecord): void {
    for (const frame of review.manifest.frames) this.created.delete(artifactId(review, frame.index));
  }
  deleteFrame(review: VideoReviewRecord, index: number): void {
    const id = artifactId(review, index);
    // Failure rollback removes only rows this instance successfully created, never a colliding
    // pre-existing artifact. Content-addressed bytes shared with another row remain retained.
    if (this.created.delete(id)) this.db.deleteWorkflowArtifact(id);
  }
}
export function createControlPlaneVideoReviewStore(db: ControlPlaneDb): SqliteVideoReviewStore {
  return new SqliteVideoReviewStore(db.raw(), new ControlPlaneVideoFrameStorage(db));
}
