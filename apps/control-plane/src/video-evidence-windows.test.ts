import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { pacedVideoReviewWindowPlan } from "@wollipog/protocol";
import { reviewerBudgetAdmissionDigest } from "./evidence-review-admission.js";
import { SqliteVideoReviewStore, type VideoReviewFrameStorage } from "./video-evidence-runtime-store.js";
import { VideoEvidenceRuntime, VideoReviewRefused, videoReviewDeliveryPlanSha256, type VideoReviewBinding,
  type VideoReviewRecord } from "./video-evidence-runtime.js";

/** Decoder-free window binding tests (#1321). Synthetic frame bytes stand in for decoded PNGs: the
 * runtime checks their digest and size, never their pixels, so no media claim is made here. */
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const FRAMES = 130;
const images = Array.from({ length: FRAMES }, (_, i) => Buffer.from(`synthetic frame ${i}`));
const criteria = [{ criterionId: "transition", description: "Inspect every frame for transient visual defects." }];
const admission = { rootSessionId: "root", authorityRevision: 4,
  dispatch: { rootSessionId: "root", generation: "synthetic-generation" },
  allocation: { sessionId: "reviewer", costUsd: 1, toolCalls: 1000 },
  worker: { sessionId: "reviewer", driver: "claude-code", model: "claude-opus-5-5", effort: "high" } };
const workerAdmission = { ...admission, allocationDigest: reviewerBudgetAdmissionDigest(admission) };
const binding: VideoReviewBinding = {
  rootSessionId: "root", childSessionId: "child", occurrenceId: "workflow_one", resourceDigest: hash("decision"),
  policyRevision: 4, boundaryRevision: 4, evidenceAuthorityRevision: 4, reviewerSessionId: "reviewer",
  reviewerDriver: "claude-code", reviewerModelId: "claude-opus-5-5", providerId: "synthetic-provider",
  audienceSha256: hash("audience"), capabilitiesSha256: hash("attestation"), sourceEvidenceId: "source_evidence",
  sourceArtifactId: "art_video", sourceSha256: hash("source"), workerAdmissionSha256: workerAdmission.allocationDigest,
  criteriaSha256: hash(JSON.stringify(criteria)),
};
function record(reviewId = "windowed"): VideoReviewRecord {
  const manifest = { schemaVersion: 1 as const, purpose: "trusted_temporal_derivation" as const,
    profile: "paced-silent-complete-frames-v1" as const, sourceSha256: hash("source"), sourceSizeBytes: 1,
    sourceMediaType: "video/webm" as const, width: 1280, height: 720, durationUs: FRAMES * 33_334,
    frames: images.map((bytes, index) => ({ index, ptsUs: index * 33_334, durationUs: 33_334, sha256: hash(bytes), sizeBytes: bytes.length })),
    segments: [{ index: 0, firstFrame: 0, frameCount: FRAMES, startUs: 0, endUs: FRAMES * 33_334 }] };
  return { reviewId, binding, manifest, manifestSha256: hash(JSON.stringify(manifest)), criteria,
    criteriaSha256: hash(JSON.stringify(criteria)),
    deliveryPlanSha256: videoReviewDeliveryPlanSha256(pacedVideoReviewWindowPlan(manifest.frames)),
    createdAt: 1_000, expiresAt: 3_601_000, status: "pending" };
}
const report = { outcome: "accept" as const, criteria: [{ criterionId: "transition", outcome: "pass" as const,
  observedFrameIndices: [60], observation: "Synthetic deterministic observation, not a model claim." }],
  rationale: "Synthetic window binding test only." };
const refused = (reason: VideoReviewRefused["reason"]) => (error: unknown) =>
  error instanceof VideoReviewRefused && error.reason === reason;
const storage = (): VideoReviewFrameStorage => ({
  writeFrame: () => {}, readFrame: (_record, index) => images[index] ?? null, deleteFrame: () => {},
});
function fixture(t: { after(fn: () => void): void }, db = new DatabaseSync(":memory:")) {
  db.exec("CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY); INSERT OR IGNORE INTO sessions VALUES ('root'),('child'),('reviewer');");
  t.after(() => { if (db.isOpen) db.close(); });
  const store = new SqliteVideoReviewStore(db, storage());
  let completed = false;
  const runtime = new VideoEvidenceRuntime(store, { currentBinding: () => binding, readSource: () => Buffer.from("source"),
    workerAdmission: () => workerAdmission, normalCompletion: () => completed }, () => 1_000);
  return { db, store, runtime, complete: () => { completed = true; } };
}
const plan = pacedVideoReviewWindowPlan(record().manifest.frames);
const ack = (runtime: VideoEvidenceRuntime, reviewId: string, batch: ReturnType<VideoEvidenceRuntime["deliverBatch"]>) =>
  runtime.acknowledgeBatch(reviewId, "reviewer", batch.deliveries.map((d) => ({ receiptId: d.receipt.receiptId, sha256: d.receipt.sha256 })));
function deliverWindow(runtime: VideoEvidenceRuntime, reviewId: string, window: { firstIndex: number; endIndex: number }) {
  for (let cursor = window.firstIndex; cursor < window.endIndex;) {
    const batch = runtime.deliverBatch(reviewId, "reviewer", cursor, window.endIndex);
    ack(runtime, reviewId, batch); cursor = batch.nextIndex;
  }
}

test("the synthetic capture spans three overlapping fresh-context windows", () => {
  assert.deepEqual(plan.windows.map((w) => [w.firstIndex, w.endIndex]), [[0, 60], [59, 119], [118, 130]]);
});

test("a batch must end exactly at a planned window boundary that contains its first frame", (t) => {
  const f = fixture(t); f.store.saveDerived(record(), images);
  assert.throws(() => f.runtime.deliverBatch("windowed", "reviewer", 0), refused("order"), "an open-ended batch names no window");
  assert.throws(() => f.runtime.deliverBatch("windowed", "reviewer", 0, 59), refused("order"));
  assert.throws(() => f.runtime.deliverBatch("windowed", "reviewer", 0, 130), refused("order"));
  assert.throws(() => f.runtime.deliverBatch("windowed", "reviewer", 60, 60), refused("order"));
  assert.throws(() => f.runtime.deliver("windowed", "reviewer", 0), refused("order"), "single frames carry no window");
  const batch = f.runtime.deliverBatch("windowed", "reviewer", 0, 60);
  assert.ok(batch.deliveries.every((d) => d.receipt.windowIndex === 0 && d.receipt.deliveryPlanSha256 === record().deliveryPlanSha256));
});

test("window k+1 cannot start from window k's acknowledgement of the shared overlap frame", (t) => {
  const f = fixture(t); f.store.saveDerived(record(), images);
  assert.throws(() => f.runtime.deliverBatch("windowed", "reviewer", 59, 119), refused("order"), "window 0 is not yet acknowledged");
  deliverWindow(f.runtime, "windowed", plan.windows[0]!);
  assert.throws(() => f.runtime.deliverBatch("windowed", "reviewer", 60, 119), refused("order"),
    "starting past the overlap borrows window 0's acknowledgement of frame 59");
  const overlap = f.runtime.deliverBatch("windowed", "reviewer", 59, 119);
  assert.equal(overlap.deliveries[0]!.receipt.videoFrame.index, 59);
  assert.equal(overlap.deliveries[0]!.receipt.windowIndex, 1);
  ack(f.runtime, "windowed", overlap);
  assert.equal(f.store.latestReceipts("windowed").filter((r) => r.receipt.videoFrame.index === 59).length, 2,
    "the overlap frame keeps one receipt per window");
  assert.throws(() => f.runtime.deliverBatch("windowed", "reviewer", 0, 60), refused("order"), "an earlier window cannot reopen");
});

test("a verdict needs every window's receipts, including each overlap frame per window", (t) => {
  const f = fixture(t); f.store.saveDerived(record(), images);
  for (const window of plan.windows) deliverWindow(f.runtime, "windowed", window);
  // Drop window 1's receipt of the overlap frame: window 0's receipt of frame 59 cannot stand in.
  f.db.prepare("DELETE FROM temporal_video_receipts WHERE review_id='windowed' AND window_index=1 AND frame_index=59").run();
  assert.throws(() => f.runtime.recordVerdict("windowed", "reviewer", report), refused("receipt"));
  const complete = fixture(t); complete.store.saveDerived(record(), images);
  for (const window of plan.windows) deliverWindow(complete.runtime, "windowed", window);
  const verdict = complete.runtime.recordVerdict("windowed", "reviewer", report);
  assert.equal(verdict.receiptIds.length, FRAMES + plan.windows.length - 1);
  assert.equal(verdict.deliveryPlanSha256, record().deliveryPlanSha256);
  complete.complete();
  assert.equal(complete.runtime.approvalProvenance("windowed", "reviewer").verdictId, verdict.verdictId);
});

test("a receipt moved to another window or plan does not count", (t) => {
  for (const tamper of ["$.windowIndex", "$.deliveryPlanSha256"]) {
    const f = fixture(t); f.store.saveDerived(record(), images);
    for (const window of plan.windows) deliverWindow(f.runtime, "windowed", window);
    f.db.prepare(`UPDATE temporal_video_receipts SET receipt=json_set(receipt,'${tamper}',?) WHERE review_id='windowed' AND window_index=2 AND frame_index=120`)
      .run(tamper === "$.windowIndex" ? 1 : hash("other plan"));
    assert.throws(() => f.runtime.recordVerdict("windowed", "reviewer", report), refused("receipt"));
  }
});

test("a verdict bound to another delivery plan is an irreversible negative", (t) => {
  const f = fixture(t); f.store.saveDerived(record(), images);
  for (const window of plan.windows) deliverWindow(f.runtime, "windowed", window);
  f.runtime.recordVerdict("windowed", "reviewer", report);
  f.complete();
  const row = f.db.prepare("SELECT verdict FROM temporal_video_verdicts WHERE review_id='windowed'").get() as { verdict: string };
  const verdict = JSON.stringify({ ...JSON.parse(row.verdict), deliveryPlanSha256: hash("other plan") });
  f.db.prepare("UPDATE temporal_video_verdicts SET verdict=?,sha256=? WHERE review_id='windowed'").run(verdict, hash(verdict));
  assert.throws(() => f.runtime.approvalProvenance("windowed", "reviewer"), refused("verdict"));
  assert.equal(f.store.getReview("windowed")?.status, "revoked");
});

test("a review recorded without a delivery plan is never current", (t) => {
  const f = fixture(t);
  const legacy = record("legacy") as Partial<VideoReviewRecord>;
  delete legacy.deliveryPlanSha256;
  f.store.saveDerived(legacy as VideoReviewRecord, images);
  assert.throws(() => f.runtime.deliverBatch("legacy", "reviewer", 0, 60), refused("stale"));
  assert.equal(f.store.getReview("legacy")?.status, "revoked");
});

test("an acknowledged window receipt is never replaced in storage", (t) => {
  const f = fixture(t); f.store.saveDerived(record(), images);
  const batch = f.runtime.deliverBatch("windowed", "reviewer", 0, 60);
  ack(f.runtime, "windowed", batch);
  assert.throws(() => f.store.recordDelivery("windowed", { ...batch.deliveries[0]!.receipt, receiptId: "replacement" }), /cannot be replaced/u);
  assert.throws(() => f.store.recordDelivery("windowed", { ...batch.deliveries[0]!.receipt, receiptId: "unwindowed",
    windowIndex: undefined as unknown as number }), /delivery window/u);
});

test("legacy per-frame receipts migrate: pending reviews are revoked, settled history becomes window 0", (t) => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('root'),('child'),('reviewer');" +
    "CREATE TABLE temporal_video_reviews (review_id TEXT PRIMARY KEY, binding_sha256 TEXT NOT NULL, record TEXT NOT NULL, " +
    "root_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, child_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, " +
    "reviewer_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('pending','revoked','consumed')));" +
    "CREATE TABLE temporal_video_receipts (review_id TEXT NOT NULL REFERENCES temporal_video_reviews(review_id) ON DELETE CASCADE," +
    "frame_index INTEGER NOT NULL, receipt_id TEXT NOT NULL UNIQUE, receipt TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0," +
    "PRIMARY KEY(review_id, frame_index));" +
    "CREATE TABLE temporal_video_verdicts (review_id TEXT PRIMARY KEY REFERENCES temporal_video_reviews(review_id) ON DELETE CASCADE,verdict TEXT NOT NULL,sha256 TEXT NOT NULL);");
  for (const [id, status] of [["pending_review", "pending"], ["consumed_review", "consumed"]] as const) {
    db.prepare("INSERT INTO temporal_video_reviews VALUES (?,?,?,?,?,?,?)").run(id, hash(id), JSON.stringify({ ...record(id), status }),
      "root", "child", "reviewer", status);
    db.prepare("INSERT INTO temporal_video_receipts VALUES (?,?,?,?,1)").run(id, 0, id + "_receipt", JSON.stringify({ receiptId: id + "_receipt" }));
  }
  const f = fixture(t, db);
  assert.equal(f.store.getReview("pending_review")?.status, "revoked");
  assert.equal(f.store.getReview("consumed_review")?.status, "consumed");
  assert.deepEqual(db.prepare("SELECT review_id,window_index,frame_index,acknowledged FROM temporal_video_receipts ORDER BY review_id").all()
    .map((row) => ({ ...row })), [
    { review_id: "consumed_review", window_index: 0, frame_index: 0, acknowledged: 1 },
    { review_id: "pending_review", window_index: 0, frame_index: 0, acknowledged: 1 },
  ]);
  assert.doesNotThrow(() => new SqliteVideoReviewStore(db, storage()), "the migration is idempotent");
});
