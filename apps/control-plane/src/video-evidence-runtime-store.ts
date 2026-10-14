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
      "review_id TEXT PRIMARY KEY, binding_sha256 TEXT NOT NULL, record TEXT NOT NULL, " +
      "root_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, " +
      "child_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, " +
      "reviewer_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, status TEXT NOT NULL " +
      "CHECK(status IN ('pending','revoked','consumed')));" +
      "CREATE UNIQUE INDEX IF NOT EXISTS temporal_video_binding ON temporal_video_reviews(binding_sha256) WHERE status='pending';" +
      "CREATE TABLE IF NOT EXISTS temporal_video_receipts (" +
      "review_id TEXT NOT NULL REFERENCES temporal_video_reviews(review_id) ON DELETE CASCADE," +
      "frame_index INTEGER NOT NULL, receipt_id TEXT NOT NULL UNIQUE," +
      "receipt TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0," +
      "PRIMARY KEY(review_id, frame_index));" +
      "CREATE TABLE IF NOT EXISTS temporal_video_verdicts (" +
      "review_id TEXT PRIMARY KEY REFERENCES temporal_video_reviews(review_id) ON DELETE CASCADE,verdict TEXT NOT NULL,sha256 TEXT NOT NULL);");
    this.migrateSessionReferences();
  }
  private migrateSessionReferences(): void {
    const references = this.db.prepare("PRAGMA foreign_key_list(temporal_video_reviews)").all();
    if (["root_session_id", "child_session_id", "reviewer_session_id"].every((column) =>
      references.some((r) => r.from === column && r.table === "sessions" && r.to === "id" && r.on_delete === "CASCADE")) &&
      ["temporal_video_receipts", "temporal_video_verdicts"].every((table) =>
        this.db.prepare("PRAGMA foreign_key_list(" + table + ")").all().some((r) =>
          r.from === "review_id" && r.table === "temporal_video_reviews" && r.to === "review_id" && r.on_delete === "CASCADE"))) return;
    const columns = this.db.prepare("PRAGMA table_info(temporal_video_reviews)").all().map((r) => String(r.name)).sort();
    if (JSON.stringify(columns) !== JSON.stringify(["binding_sha256", "record", "review_id", "status"]) || this.db.isTransaction) {
      throw new Error("Temporal review schema migration requires its exact prior schema and an owning transaction.");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("CREATE TABLE temporal_video_reviews_next (review_id TEXT PRIMARY KEY,binding_sha256 TEXT NOT NULL," +
        "record TEXT NOT NULL,root_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE," +
        "child_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE," +
        "reviewer_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE," +
        "status TEXT NOT NULL CHECK(status IN ('pending','revoked','consumed')));" +
        "CREATE TABLE temporal_video_receipts_next (review_id TEXT NOT NULL REFERENCES temporal_video_reviews_next(review_id) ON DELETE CASCADE," +
        "frame_index INTEGER NOT NULL,receipt_id TEXT NOT NULL UNIQUE,receipt TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(review_id,frame_index));" +
        "CREATE TABLE temporal_video_verdicts_next (review_id TEXT PRIMARY KEY REFERENCES temporal_video_reviews_next(review_id) ON DELETE CASCADE,verdict TEXT NOT NULL,sha256 TEXT NOT NULL);");
      for (const row of this.db.prepare("SELECT * FROM temporal_video_reviews").all()) {
        const record = JSON.parse(String(row.record)) as VideoReviewRecord, binding = record.binding;
        if (record.reviewId !== row.review_id || videoReviewBindingDigest(binding) !== row.binding_sha256 ||
          ![binding.rootSessionId, binding.childSessionId, binding.reviewerSessionId].every((id) => typeof id === "string" && id.length > 0)) {
          throw new Error("Temporal review migration encountered invalid binding provenance.");
        }
        // Previously deleted owners leave private quality metadata, not live capacity. Remove
        // only those orphan quality rows; purpose/command/budget/effect history is untouched.
        if (![binding.rootSessionId, binding.childSessionId, binding.reviewerSessionId].every((id) =>
          this.db.prepare("SELECT 1 FROM sessions WHERE id=?").get(id))) continue;
        this.db.prepare("INSERT INTO temporal_video_reviews_next VALUES (?,?,?,?,?,?,?)")
          .run(row.review_id!, row.binding_sha256!, row.record!, binding.rootSessionId, binding.childSessionId, binding.reviewerSessionId, row.status!);
      }
      this.db.exec("INSERT INTO temporal_video_receipts_next SELECT r.* FROM temporal_video_receipts r JOIN temporal_video_reviews_next v USING(review_id);" +
        "INSERT INTO temporal_video_verdicts_next SELECT r.* FROM temporal_video_verdicts r JOIN temporal_video_reviews_next v USING(review_id);" +
        "DROP TABLE temporal_video_verdicts; DROP TABLE temporal_video_receipts; DROP TABLE temporal_video_reviews;" +
        "ALTER TABLE temporal_video_reviews_next RENAME TO temporal_video_reviews;" +
        "ALTER TABLE temporal_video_receipts_next RENAME TO temporal_video_receipts;" +
        "ALTER TABLE temporal_video_verdicts_next RENAME TO temporal_video_verdicts;" +
        "CREATE UNIQUE INDEX temporal_video_binding ON temporal_video_reviews(binding_sha256) WHERE status='pending';COMMIT");
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
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
      this.db.prepare("INSERT INTO temporal_video_reviews(review_id,binding_sha256,record,root_session_id,child_session_id,reviewer_session_id,status) VALUES (?,?,?,?,?,?,?)")
        .run(record.reviewId, videoReviewBindingDigest(record.binding), JSON.stringify(record), record.binding.rootSessionId,
          record.binding.childSessionId, record.binding.reviewerSessionId, record.status);
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
  recordBatch(reviewId: string, receipts: readonly TemporalVideoReceipt[]): void {
    this.db.exec("SAVEPOINT temporal_delivery_batch");
    try {
      for (const receipt of receipts) this.recordDelivery(reviewId, receipt);
      this.db.exec("RELEASE temporal_delivery_batch");
    } catch (error) {
      this.db.exec("ROLLBACK TO temporal_delivery_batch; RELEASE temporal_delivery_batch");
      throw error;
    }
  }
  acknowledgeBatch(reviewId: string, receipts: readonly { receiptId: string; sha256: string }[]): boolean {
    this.db.exec("SAVEPOINT temporal_ack_batch");
    try {
      for (const receipt of receipts) if (!this.acknowledge(reviewId, receipt.receiptId, receipt.sha256)) {
        this.db.exec("ROLLBACK TO temporal_ack_batch; RELEASE temporal_ack_batch");
        return false;
      }
      this.db.exec("RELEASE temporal_ack_batch");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK TO temporal_ack_batch; RELEASE temporal_ack_batch");
      throw error;
    }
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
