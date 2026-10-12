import type { DatabaseSync } from "node:sqlite";
import type { TemporalVideoReceipt, VideoReviewRecord, VideoReviewStore, VideoReviewVerdict } from "./video-evidence-runtime.js";

export interface VideoReviewFrameStorage {
  writeFrame(review: VideoReviewRecord, index: number, bytes: Buffer): void;
  readFrame(review: VideoReviewRecord, index: number): Buffer | null;
  deleteFrame(review: VideoReviewRecord, index: number): void;
}

/** Metadata-only SQLite ledger. Frame bytes use the existing private artifact storage, never
 * audit payloads. Durable receipts and verdicts survive restart without self-attestation. */
export class SqliteVideoReviewStore implements VideoReviewStore {
  constructor(private readonly db: DatabaseSync, private readonly frames: VideoReviewFrameStorage) {
    db.exec("CREATE TABLE IF NOT EXISTS temporal_video_reviews (" +
      "review_id TEXT PRIMARY KEY, record TEXT NOT NULL, status TEXT NOT NULL " +
      "CHECK(status IN ('pending','revoked','consumed')));" +
      "CREATE TABLE IF NOT EXISTS temporal_video_receipts (" +
      "review_id TEXT NOT NULL REFERENCES temporal_video_reviews(review_id)," +
      "frame_index INTEGER NOT NULL, receipt_id TEXT NOT NULL UNIQUE," +
      "receipt TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0," +
      "PRIMARY KEY(review_id, frame_index));" +
      "CREATE TABLE IF NOT EXISTS temporal_video_verdicts (" +
      "review_id TEXT PRIMARY KEY REFERENCES temporal_video_reviews(review_id),verdict TEXT NOT NULL);");
  }
  saveDerived(record: VideoReviewRecord, images: readonly Buffer[]): void {
    if (images.length !== record.manifest.frames.length) throw new Error("Incomplete temporal frame storage");
    this.db.exec("SAVEPOINT video_derivation");
    const created: number[] = [];
    try {
      this.db.prepare("INSERT INTO temporal_video_reviews(review_id, record, status) VALUES (?,?,?)")
        .run(record.reviewId, JSON.stringify(record), record.status);
      for (const [index, bytes] of images.entries()) {
        created.push(index);
        this.frames.writeFrame(record, index, bytes);
      }
      this.db.exec("RELEASE video_derivation");
    } catch (error) {
      // Artifact bytes may be outside SQLite: remove only this failed derivation's new files.
      for (const index of created) {
        try { this.frames.deleteFrame(record, index); } catch { /* Retention sweep owns residual files. */ }
      }
      this.db.exec("ROLLBACK TO video_derivation");
      this.db.exec("RELEASE video_derivation");
      throw error;
    }
  }
  getReview(reviewId: string): VideoReviewRecord | null {
    const row = this.db.prepare("SELECT record,status FROM temporal_video_reviews WHERE review_id=?")
      .get(reviewId) as { record: string; status: VideoReviewRecord["status"] } | undefined;
    return row ? { ...JSON.parse(row.record) as VideoReviewRecord, status: row.status } : null;
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
    this.db.prepare("INSERT INTO temporal_video_verdicts(review_id,verdict) VALUES (?,?)")
      .run(verdict.reviewId, JSON.stringify(verdict));
  }
  getVerdict(reviewId: string): VideoReviewVerdict | null {
    const row = this.db.prepare("SELECT verdict FROM temporal_video_verdicts WHERE review_id=?")
      .get(reviewId) as { verdict: string } | undefined;
    return row ? JSON.parse(row.verdict) as VideoReviewVerdict : null;
  }
  settle(reviewId: string, status: "revoked" | "consumed"): void {
    this.db.prepare("UPDATE temporal_video_reviews SET status=? WHERE review_id=? AND status='pending'").run(status, reviewId);
  }
}
