import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { videoReviewBindingDigest } from "./video-evidence-runtime.js";
import type { TemporalVideoReceipt, VideoReviewRecord, VideoReviewStore, VideoReviewVerdict } from "./video-evidence-runtime.js";

export interface VideoReviewFrameStorage {
  writeFrame(review: VideoReviewRecord, index: number, bytes: Buffer): void;
  readFrame(review: VideoReviewRecord, index: number): Buffer | null;
  deleteFrame(review: VideoReviewRecord, index: number): void;
  /** Non-throwing bookkeeping only; no authority or storage mutation. */
  finishDerivation?(review: VideoReviewRecord): void;
}

/** Metadata-only SQLite ledger. Frame bytes use the existing private artifact storage, never
 * audit payloads. Durable receipts and verdicts survive restart without self-attestation. */
export class SqliteVideoReviewStore implements VideoReviewStore {
  constructor(private readonly db: DatabaseSync, private readonly frames: VideoReviewFrameStorage) {
    db.exec("CREATE TABLE IF NOT EXISTS temporal_video_reviews (" +
      "review_id TEXT PRIMARY KEY, binding_sha256 TEXT NOT NULL, record TEXT NOT NULL, status TEXT NOT NULL " +
      "CHECK(status IN ('pending','revoked','consumed')));" +
      "CREATE UNIQUE INDEX IF NOT EXISTS temporal_video_binding ON temporal_video_reviews(binding_sha256) WHERE status='pending';" +
      "CREATE TABLE IF NOT EXISTS temporal_video_receipts (" +
      "review_id TEXT NOT NULL REFERENCES temporal_video_reviews(review_id)," +
      "frame_index INTEGER NOT NULL, receipt_id TEXT NOT NULL UNIQUE," +
      "receipt TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0," +
      "PRIMARY KEY(review_id, frame_index));" +
      "CREATE TABLE IF NOT EXISTS temporal_video_verdicts (" +
      "review_id TEXT PRIMARY KEY REFERENCES temporal_video_reviews(review_id),verdict TEXT NOT NULL,sha256 TEXT NOT NULL);");
  }
  saveDerived(record: VideoReviewRecord, images: readonly Buffer[]): void {
    if (images.length !== record.manifest.frames.length) throw new Error("Incomplete temporal frame storage");
    if (this.getReview(record.reviewId)) throw new Error("Temporal derivation already exists");
    const created: number[] = [];
    try {
      // Existing private artifact writers own their SQLite transactions. Stage complete verified
      // frame rows first; without a review row these internal frames cannot acquire media grants.
      for (const [index, bytes] of images.entries()) {
        created.push(index);
        this.frames.writeFrame(record, index, bytes);
      }
      this.db.prepare("INSERT INTO temporal_video_reviews(review_id, binding_sha256, record, status) VALUES (?,?,?,?)")
        .run(record.reviewId, videoReviewBindingDigest(record.binding), JSON.stringify(record), record.status);
    } catch (error) {
      // Artifact bytes may be outside SQLite: remove only this failed derivation's new files.
      for (const index of created) {
        try { this.frames.deleteFrame(record, index); } catch { /* Retention sweep owns residual files. */ }
      }
      throw error;
    } finally {
      this.frames.finishDerivation?.(record);
    }
  }
  getReview(reviewId: string): VideoReviewRecord | null {
    const row = this.db.prepare("SELECT record,status FROM temporal_video_reviews WHERE review_id=?")
      .get(reviewId) as { record: string; status: VideoReviewRecord["status"] } | undefined;
    return row ? { ...JSON.parse(row.record) as VideoReviewRecord, status: row.status } : null;
  }
  findPending(bindingSha256: string, now: number): VideoReviewRecord | null {
    const row = this.db.prepare("SELECT review_id FROM temporal_video_reviews WHERE binding_sha256=? AND status='pending'")
      .get(bindingSha256) as { review_id: string } | undefined;
    const review = row ? this.getReview(row.review_id) : null;
    if (review && review.expiresAt <= now) { this.settle(review.reviewId, "revoked"); return null; }
    return review;
  }
  readFrame(reviewId: string, index: number): Buffer | null {
    const review = this.getReview(reviewId);
    return review ? this.frames.readFrame(review, index) : null;
  }
  latestReceipts(reviewId: string): Array<{ receipt: TemporalVideoReceipt; acknowledged: boolean }> {
    return (this.db.prepare("SELECT receipt,acknowledged FROM temporal_video_receipts WHERE review_id=? ORDER BY frame_index")
      .all(reviewId) as Array<{ receipt: string; acknowledged: number }>).map((row) => ({
        receipt: JSON.parse(row.receipt) as TemporalVideoReceipt, acknowledged: row.acknowledged === 1,
      }));
  }
  recordDelivery(reviewId: string, receipt: TemporalVideoReceipt): void {
    const review = this.getReview(reviewId);
    if (!review || review.status !== "pending") throw new Error("Temporal review is no longer pending");
    this.db.prepare("INSERT INTO temporal_video_receipts(review_id, frame_index, receipt_id, receipt) " +
      "VALUES (?,?,?,?) ON CONFLICT(review_id,frame_index) DO UPDATE SET " +
      "receipt_id=excluded.receipt_id,receipt=excluded.receipt,acknowledged=0")
      .run(reviewId, receipt.videoFrame.index, receipt.receiptId, JSON.stringify(receipt));
  }
  acknowledge(reviewId: string, receiptId: string, sha256: string): boolean {
    const row = this.db.prepare("SELECT r.receipt FROM temporal_video_receipts r " +
      "JOIN temporal_video_reviews v ON v.review_id=r.review_id " +
      "WHERE r.review_id=? AND r.receipt_id=? AND v.status='pending'").get(reviewId, receiptId) as { receipt: string } | undefined;
    if (!row || (JSON.parse(row.receipt) as TemporalVideoReceipt).sha256 !== sha256) return false;
    return Number(this.db.prepare("UPDATE temporal_video_receipts SET acknowledged=1 WHERE review_id=? AND receipt_id=?")
      .run(reviewId, receiptId).changes) === 1;
  }
  saveVerdict(verdict: VideoReviewVerdict): void {
    if (this.getReview(verdict.reviewId)?.status !== "pending") throw new Error("Temporal review is no longer pending");
    const encoded = JSON.stringify(verdict);
    this.db.prepare("INSERT INTO temporal_video_verdicts(review_id,verdict,sha256) VALUES (?,?,?)")
      .run(verdict.reviewId, encoded, createHash("sha256").update(encoded).digest("hex"));
  }
  getVerdict(reviewId: string): VideoReviewVerdict | null {
    const row = this.db.prepare("SELECT verdict,sha256 FROM temporal_video_verdicts WHERE review_id=?")
      .get(reviewId) as { verdict: string; sha256: string } | undefined;
    return row && createHash("sha256").update(row.verdict).digest("hex") === row.sha256
      ? JSON.parse(row.verdict) as VideoReviewVerdict : null;
  }
  settle(reviewId: string, status: "revoked" | "consumed"): void {
    this.db.prepare("UPDATE temporal_video_reviews SET status=? WHERE review_id=? AND status='pending'").run(status, reviewId);
  }
}
