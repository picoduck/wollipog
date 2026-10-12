import { VideoEvidenceDecisionBridge } from "./video-evidence-decision-bridge.js";
import type { WorkflowDecisionView } from "@wollipog/protocol";
import { reviewerBudgetAdmissionDigest } from "./evidence-review-admission.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { before, test } from "node:test";
import fc from "fast-check";
import { SqliteVideoReviewStore, type VideoReviewFrameStorage } from "./video-evidence-runtime-store.js";
import { VideoEvidenceRuntime, VideoReviewRefused, type VideoReviewBinding, type VideoReviewRecord,
  type VideoReviewRuntimeAccess } from "./video-evidence-runtime.js";
import { prepareVideoEvidence, videoPreparationDecoderAvailable } from "./video-evidence-preparation.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const source = readFileSync(new URL("../test-fixtures/video-preparation-paced.webm", import.meta.url));
const admission = { rootSessionId: "root", authorityRevision: 4,
  dispatch: { rootSessionId: "root", generation: "synthetic-dispatch-generation" },
  allocation: { sessionId: "reviewer", costUsd: 1, toolCalls: 1000 },
  worker: { sessionId: "reviewer", driver: "codex-app-server", model: "test-image-model", effort: "high" } };
const workerAdmission = { ...admission, allocationDigest: reviewerBudgetAdmissionDigest(admission) };
const binding: VideoReviewBinding = {
  rootSessionId: "root", childSessionId: "child", occurrenceId: "workflow_one",
  resourceDigest: hash("decision"), policyRevision: 4, boundaryRevision: 4, evidenceAuthorityRevision: 4,
  reviewerSessionId: "reviewer", reviewerDriver: "codex-app-server", reviewerModelId: "test-image-model",
  providerId: "test-provider", audienceSha256: hash("private-audience"), capabilitiesSha256: hash("exact-attestation"),
  sourceEvidenceId: "source_evidence", sourceArtifactId: "art_video", sourceSha256: hash(source), workerAdmissionSha256: workerAdmission.allocationDigest,
  criteriaSha256: hash(JSON.stringify([{ criterionId: "transition", description: "Inspect every frame for transient visual defects." }])),
};
let images: Buffer[] = [];
let template: VideoReviewRecord | null = null;
before(async () => {
  if (!await videoPreparationDecoderAvailable()) {
    assert.notEqual(process.env.CI, "true", "CI must provision isolated decoder");
    return;
  }
  const result = await prepareVideoEvidence(source, "video/webm");
  assert.ok(result.ok);
  if (!result.ok) return;
  images = result.images;
  const manifest = { ...result.manifest, purpose: "trusted_temporal_derivation" as const,
    profile: "paced-silent-complete-frames-v1" as const };
  template = { reviewId: "video_test", binding, manifest, manifestSha256: hash(JSON.stringify(manifest)),
    criteria, criteriaSha256: hash(JSON.stringify(criteria)), createdAt: 1_000, expiresAt: 3_601_000, status: "pending" };
});
function fixture(t: { skip(reason: string): void; after(fn: () => void): void }) {
  if (!template) { t.skip("isolated decoder unavailable"); return null; }
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const frameBytes = new Map<number, Buffer>();
  const frames: VideoReviewFrameStorage = {
    writeFrame: (_record, index, bytes) => { frameBytes.set(index, Buffer.from(bytes)); },
    readFrame: (_record, index) => frameBytes.get(index) ?? null,
    deleteFrame: (_record, index) => { frameBytes.delete(index); },
  };
  const store = new SqliteVideoReviewStore(db, frames);
  store.saveDerived(structuredClone(template), images);
  let current: VideoReviewBinding | null = structuredClone(binding);
  let retained: Buffer | null = source;
  let now = 1_000;
  const access: VideoReviewRuntimeAccess = {
    validationProfile: () => "paced",
    currentBinding: () => current,
    readSource: () => retained,
    workerAdmission: () => workerAdmission,
    normalCompletion: () => false,
  };
  const runtime = new VideoEvidenceRuntime(store, access, () => now);
  return { db, frames, store, runtime, frameBytes, access,
    setCurrent: (b: VideoReviewBinding | null) => { current = b; },
    setSource: (s: Buffer | null) => { retained = s; }, setTime: (value: number) => { now = value; } };
}
function refused(reason: VideoReviewRefused["reason"]) {
  return (error: unknown) => error instanceof VideoReviewRefused && error.reason === reason;
}
const criteria = [{ criterionId: "transition", description: "Inspect every frame for transient visual defects." }];
const report = { outcome: "accept" as const, criteria: [{
  criterionId: "transition", outcome: "pass" as const, observedFrameIndices: [157],
  observation: "Synthetic deterministic test observation, not live-model proof.",
}], rationale: "Test verdict exercises the server provenance contract only." };

test("distinct candidate permit derives and hands off every native frame, while production approval stays refused", async (t) => {
  const f = fixture(t); if (!f) return;
  const candidate = readFileSync(new URL("../test-fixtures/video-review-max-profile.webm", import.meta.url));
  const admitted = { ...binding, occurrenceId: "candidate-validation", sourceSha256: hash(candidate),
    operatorValidation: { permitId: "disclosed-candidate-permit", scopeSha256: hash("synthetic candidate scope") } };
  f.setCurrent(admitted); f.setSource(candidate);
  f.access.validationProfile = () => "candidate";
  const derived = await f.runtime.derive(admitted, "video/webm", criteria);
  assert.ok(derived.ok); if (!derived.ok) return;
  assert.equal(derived.review.manifest.captureProfile, "candidate");
  assert.equal(derived.review.manifest.frames.length, 16);
  assert.equal(derived.review.manifest.width, 640);
  const batch = f.runtime.deliverBatch(derived.review.reviewId, "reviewer", 0);
  assert.equal(batch.frameCount, 16);
  assert.deepEqual(batch.deliveries.map((d) => d.receipt.videoFrame.ptsUs), Array.from({ length: 16 }, (_, i) => i * 250_000));
  f.runtime.acknowledgeBatch(derived.review.reviewId, "reviewer", batch.deliveries.map((d) => d.receipt));
  f.runtime.recordVerdict(derived.review.reviewId, "reviewer", { ...report,
    criteria: [{ ...report.criteria[0]!, observedFrameIndices: [0, 15] }] });
  assert.equal(f.runtime.validationObservation(derived.review.reviewId, "reviewer").receiptIds.length, 16);
  assert.throws(() => f.runtime.approvalProvenance(derived.review.reviewId, "reviewer"), refused("verdict"));
  f.access.validationProfile = () => "paced";
  assert.throws(() => f.runtime.validationObservation(derived.review.reviewId, "reviewer"), refused("stale"));
});

test("Human validation observations retain their purpose on every frame and verdict and cannot become production approval", (t) => {
  const f = fixture(t); if (!f || !template) return;
  const record = structuredClone(template);
  record.reviewId = "synthetic_validation_observation";
  record.binding = { ...binding, operatorValidation: { permitId: "synthetic-permit", scopeSha256: hash("synthetic-human-scope") } };
  f.setCurrent(record.binding);
  f.store.saveDerived(record, images);
  for (let index = 0; index < record.manifest.frames.length;) {
    const batch = f.runtime.deliverBatch(record.reviewId, "reviewer", index);
    for (const delivered of batch.deliveries) assert.deepEqual(delivered.receipt.operatorValidation, record.binding.operatorValidation);
    f.runtime.acknowledgeBatch(record.reviewId, "reviewer", batch.deliveries.map((d) => d.receipt));
    index = batch.nextIndex;
  }
  const verdict = f.runtime.recordVerdict(record.reviewId, "reviewer", report);
  assert.deepEqual(verdict.operatorValidation, record.binding.operatorValidation);
  assert.deepEqual(f.runtime.validationObservation(record.reviewId, "reviewer"), verdict);
  assert.throws(() => f.runtime.approvalProvenance(record.reviewId, "reviewer"), refused("verdict"));
  assert.throws(() => f.runtime.validationObservation("video_test", "reviewer"), refused("verdict"));
  const decision = { category: "ui_evidence_approval", authority: "orchestrator", status: "pending",
    controllingSessionId: binding.rootSessionId, sessionId: binding.childSessionId, occurrenceId: binding.occurrenceId,
    policyRevision: binding.policyRevision, resourceDigest: binding.resourceDigest,
    resourceSnapshot: { category: "ui_evidence_approval", evidence: [{ evidenceId: binding.sourceEvidenceId,
      artifactId: binding.sourceArtifactId, sha256: binding.sourceSha256, mediaType: "video/webm" }] } } as WorkflowDecisionView;
  const bridge = new VideoEvidenceDecisionBridge(f.runtime, { decisionCurrent: () => true, linkedReview: () => record,
    directImageReviewed: () => false });
  assert.throws(() => bridge.approvalProvenance(decision, [], [{ evidenceId: binding.sourceEvidenceId,
    reviewId: record.reviewId, verdictId: verdict.verdictId, reviewerSessionId: "reviewer" }], "resolve"), /not bound/);
  f.db.prepare("UPDATE temporal_video_receipts SET receipt=json_remove(receipt,'$.operatorValidation') WHERE review_id=? AND frame_index=157")
    .run(record.reviewId);
  assert.throws(() => f.runtime.validationObservation(record.reviewId, "reviewer"), refused("receipt"));
});

test("actual trusted runtime derivation snapshots source and rejects implementer self-review", async (t) => {
  const f = fixture(t); if (!f) return;
  const freshBinding = { ...binding, occurrenceId: "workflow_fresh" };
  f.setCurrent(freshBinding);
  const [result, concurrent] = await Promise.all([
    f.runtime.derive(freshBinding, "video/webm", criteria),
    f.runtime.derive(freshBinding, "video/webm", criteria),
  ]);
  assert.ok(concurrent.ok);
  if (result.ok && concurrent.ok) assert.equal(result.review.reviewId, concurrent.review.reviewId);
  assert.ok(result.ok);
  if (result.ok) {
    assert.notEqual(result.review.reviewId, "video_test");
    assert.equal(result.review.manifest.frames.length, 360);
    const resumed = new VideoEvidenceRuntime(f.store, f.access, () => 1_000);
    const recovered = await resumed.derive(freshBinding, "video/webm", criteria);
    assert.ok(recovered.ok);
    if (recovered.ok) assert.equal(recovered.review.reviewId, result.review.reviewId);
    await assert.rejects(resumed.derive(freshBinding, "video/webm", [{ criterionId: "changed", description: "Changed criteria" }]), refused("criteria"));
    assert.equal(result.review.manifest.purpose, "trusted_temporal_derivation");
    assert.equal(Object.hasOwn(result.review, "verdict"), false);
    assert.equal(f.store.getVerdict(result.review.reviewId), null);
  }
  const self = { ...binding, reviewerSessionId: "child" };
  f.setCurrent(self);
  await assert.rejects(f.runtime.derive(self, "video/webm", criteria), refused("self_review"));
  f.setCurrent(binding); f.setSource(Buffer.from("substitution"));
  await assert.rejects(f.runtime.derive(binding, "video/webm", criteria), refused("source_mismatch"));
});

test("durable ordered all-frame acknowledgement is necessary but insufficient for approval", (t) => {
  const f = fixture(t); if (!f || !template) return;
  assert.throws(() => f.runtime.deliver("video_test", "reviewer", 1), refused("order"));
  assert.throws(() => f.runtime.recordVerdict("video_test", "reviewer", report), refused("receipt"));
  for (const frame of template.manifest.frames) {
    const delivery = f.runtime.deliver("video_test", "reviewer", frame.index);
    assert.equal(hash(delivery.bytes), frame.sha256);
    assert.equal(delivery.receipt.videoFrame.ptsUs, frame.ptsUs);
    assert.equal(delivery.receipt.videoFrame.durationUs, frame.durationUs);
    assert.throws(() => f.runtime.acknowledge("video_test", "reviewer", delivery.receipt.receiptId, hash("wrong")), refused("receipt"));
    f.runtime.acknowledge("video_test", "reviewer", delivery.receipt.receiptId, delivery.receipt.sha256);
  }
  assert.throws(() => f.runtime.approvalProvenance("video_test", "reviewer"), refused("verdict"));
  assert.throws(() => f.runtime.recordVerdict("video_test", "reviewer", { ...report, oracle: "unexpected truth" } as typeof report), refused("criteria"));
  assert.throws(() => f.runtime.recordVerdict("video_test", "reviewer", { ...report, criteria: [{ ...report.criteria[0]!, secret: "extra input" } as typeof report.criteria[number]] }), refused("criteria"));
  const verdict = f.runtime.recordVerdict("video_test", "reviewer", report);
  assert.equal(verdict.receiptIds.length, 360);
  assert.equal(f.runtime.approvalProvenance("video_test", "reviewer").verdictId, verdict.verdictId);
  assert.throws(() => f.runtime.deliver("video_test", "reviewer", 359), refused("order"));
  assert.throws(() => f.runtime.recordVerdict("video_test", "reviewer", report), refused("verdict"));
  assert.throws(() => f.runtime.approvalProvenance("video_test", "child"), refused("stale"));
  f.db.prepare("UPDATE temporal_video_verdicts SET verdict=json_set(verdict, '$.rationale', 'substituted') WHERE review_id=?").run("video_test");
  assert.equal(f.store.getVerdict("video_test"), null);
  assert.throws(() => f.runtime.approvalProvenance("video_test", "reviewer"), refused("verdict"));
});

test("a replaced delivery cannot acknowledge or stand in for a new frame", (t) => {
  const f = fixture(t); if (!f) return;
  const first = f.runtime.deliver("video_test", "reviewer", 0);
  const replaced = f.runtime.deliver("video_test", "reviewer", 0);
  assert.throws(() => f.runtime.acknowledge("video_test", "reviewer", first.receipt.receiptId, first.receipt.sha256), refused("receipt"));
  f.runtime.acknowledge("video_test", "reviewer", replaced.receipt.receiptId, replaced.receipt.sha256);
  const second = f.runtime.deliver("video_test", "reviewer", 1);
  f.runtime.acknowledge("video_test", "reviewer", second.receipt.receiptId, second.receipt.sha256);
  assert.throws(() => f.runtime.deliver("video_test", "reviewer", 0), refused("order"));
});

test("generated changes in every immutable context field fail closed and revoke review", (t) => {
  const f = fixture(t); if (!f || !template) return;
  const keys = Object.keys(binding) as Array<keyof VideoReviewBinding>;
  let sequence = 0;
  fc.assert(fc.property(fc.constantFrom(...keys), fc.integer({ min: 1, max: 100_000 }), (key, delta) => {
    const original = structuredClone(template!);
    original.reviewId = "review_" + sequence++;
    original.binding = { ...binding, occurrenceId: original.reviewId };
    f.store.saveDerived(original, images);
    const changed = { ...original.binding };
    const value = changed[key];
    Object.assign(changed, { [key]: typeof value === "number" ? value + delta : value + "_" + delta });
    f.setCurrent(changed);
    assert.throws(() => f.runtime.deliver(original.reviewId, "reviewer", 0), refused("stale"));
    assert.equal(f.store.getReview(original.reviewId)?.status, "revoked");
  }), { numRuns: 50 });
});

test("frame mutation revokes unconsumed grants and repairing pixels cannot revive them", (t) => {
  const f = fixture(t); if (!f) return;
  f.frameBytes.set(0, Buffer.from("different pixels"));
  assert.throws(() => f.runtime.deliver("video_test", "reviewer", 0), refused("frame_mismatch"));
  assert.equal(f.store.getReview("video_test")?.status, "revoked");
  // No revival from a repaired source or capability.
  f.frameBytes.set(0, images[0]!);
  assert.throws(() => f.runtime.deliver("video_test", "reviewer", 0), refused("stale"));
});

test("SQLite receipts and verdict absence survive process restart", async (t) => {
  if (!template) { t.skip("isolated decoder unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "video-runtime-store-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "ledger.sqlite");
  const bytes = new Map<number, Buffer>();
  const frames: VideoReviewFrameStorage = {
    writeFrame: (_r, i, b) => { bytes.set(i, b); }, readFrame: (_r, i) => bytes.get(i) ?? null,
    deleteFrame: (_r, i) => { bytes.delete(i); },
  };
  let db = new DatabaseSync(path);
  let store = new SqliteVideoReviewStore(db, frames);
  store.saveDerived(template, images);
  const access = { currentBinding: () => binding, readSource: () => source, workerAdmission: () => workerAdmission, normalCompletion: () => false };
  const delivery = new VideoEvidenceRuntime(store, access, () => 1_000).deliver("video_test", "reviewer", 0);
  db.close();
  db = new DatabaseSync(path); t.after(() => db.close());
  store = new SqliteVideoReviewStore(db, frames);
  assert.equal(store.latestReceipts("video_test")[0]?.acknowledged, false);
  const runtime = new VideoEvidenceRuntime(store, access, () => 1_000);
  runtime.acknowledge("video_test", "reviewer", delivery.receipt.receiptId, delivery.receipt.sha256);
  assert.equal(store.latestReceipts("video_test")[0]?.acknowledged, true);
  assert.equal(store.getVerdict("video_test"), null);
  assert.throws(() => runtime.approvalProvenance("video_test", "reviewer"), refused("receipt"));
});

test("failed frame storage rolls back metadata and removes only its own new partial frames", (t) => {
  if (!template) { t.skip("isolated decoder unavailable"); return; }
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const bytes = new Map<number, Buffer>();
  const store = new SqliteVideoReviewStore(db, {
    writeFrame: (_r, i, b) => { bytes.set(i, b); if (i === 1) throw new Error("storage refused"); },
    readFrame: (_r, i) => bytes.get(i) ?? null, deleteFrame: (_r, i) => { bytes.delete(i); },
  });
  assert.throws(() => store.saveDerived(template!, images), /storage refused/u);
  assert.equal(store.getReview("video_test"), null);
  assert.equal(bytes.size, 0);
});

test("normally settled worker cannot read or attest again but owner can use its exact completed quality proof", (t) => {
  const f = fixture(t); if (!f || !template) return;
  for (const frame of template.manifest.frames) {
    const delivery = f.runtime.deliver("video_test", "reviewer", frame.index);
    f.runtime.acknowledge("video_test", "reviewer", delivery.receipt.receiptId, delivery.receipt.sha256);
  }
  const verdict = f.runtime.recordVerdict("video_test", "reviewer", report);
  f.access.normalCompletion = () => true;
  f.access.currentBinding = (_b, phase) => phase === "resolve" ? binding : null;
  f.access.workerAdmission = (_b, phase) => phase === "historical" ? workerAdmission : null;
  assert.throws(() => f.runtime.deliver("video_test", "reviewer", 359), refused("stale"));
  assert.throws(() => f.runtime.recordVerdict("video_test", "reviewer", report), refused("stale"));
  assert.equal(f.store.getReview("video_test")?.status, "pending");
  assert.equal(f.runtime.approvalProvenance("video_test", "reviewer").verdictId, verdict.verdictId);
  // Explicit current revocation or a hard allowance denial invalidates historical quality proof.
  f.access.currentBinding = () => null;
  assert.throws(() => f.runtime.approvalProvenance("video_test", "reviewer"), refused("stale"));
  assert.equal(f.store.getReview("video_test")?.status, "revoked");
});

test("expired, replaced admission and removed source cannot reuse a completed verdict grant", (t) => {
  const f = fixture(t); if (!f) return;
  f.setTime(3_601_000);
  assert.throws(() => f.runtime.deliver("video_test", "reviewer", 0), refused("stale"));
  assert.equal(f.store.getReview("video_test")?.status, "revoked");
  f.setTime(1_000);
  assert.throws(() => f.runtime.deliver("video_test", "reviewer", 0), refused("stale"));
  const replacement = fixture(t); if (!replacement) return;
  replacement.access.workerAdmission = () => ({ ...workerAdmission, worker: { ...workerAdmission.worker, sessionId: "replacement" } });
  assert.throws(() => replacement.runtime.deliver("video_test", "reviewer", 0), refused("stale"));
  assert.equal(replacement.store.getReview("video_test")?.status, "revoked");
});

test("current source removal and completed quality proof frame substitution fail closed", (t) => {
  const missing = fixture(t); if (!missing) return;
  missing.setSource(null);
  assert.throws(() => missing.runtime.deliver("video_test", "reviewer", 0), refused("source_mismatch"));
  assert.equal(missing.store.getReview("video_test")?.status, "revoked");
  const f = fixture(t); if (!f || !template) return;
  for (const frame of template.manifest.frames) {
    const delivery = f.runtime.deliver("video_test", "reviewer", frame.index);
    f.runtime.acknowledge("video_test", "reviewer", delivery.receipt.receiptId, delivery.receipt.sha256);
  }
  f.runtime.recordVerdict("video_test", "reviewer", report);
  f.frameBytes.set(157, Buffer.from("transient substituted after model delivery"));
  assert.throws(() => f.runtime.approvalProvenance("video_test", "reviewer"), refused("frame_mismatch"));
  assert.equal(f.store.getReview("video_test")?.status, "revoked");
});

test("bounded consecutive batches preserve all 360 native frames and acknowledge each window atomically", (t) => {
  const f = fixture(t); if (!f || !template) return;
  const seen: number[] = [];
  let cursor = 0;
  while (cursor < template.manifest.frames.length) {
    const batch: ReturnType<VideoEvidenceRuntime["deliverBatch"]> = f.runtime.deliverBatch("video_test", "reviewer", cursor);
    assert.ok(batch.deliveries.length > 0 && batch.deliveries.length <= 32);
    const encoded = { deliveries: batch.deliveries.map((d) => ({
      receipt: d.receipt, mimeType: d.mimeType, sizeBytes: d.bytes.length, data: d.bytes.toString("base64"),
    })), nextIndex: batch.nextIndex, frameCount: batch.frameCount };
    assert.ok(Buffer.byteLength(JSON.stringify(encoded)) <= 8 * 1024 * 1024);
    const receipts = batch.deliveries.map((d) => ({ receiptId: d.receipt.receiptId, sha256: d.receipt.sha256 }));
    if (cursor === 0) {
      assert.throws(() => f.runtime.acknowledgeBatch("video_test", "reviewer",
        receipts.map((r, i) => i === receipts.length - 1 ? { ...r, sha256: hash("wrong") } : r)), refused("receipt"));
      assert.equal(f.store.latestReceipts("video_test").some((r) => r.acknowledged), false, "no partial acknowledgement survives");
      assert.throws(() => f.runtime.deliverBatch("video_test", "reviewer", batch.nextIndex), refused("order"));
      const replacement = f.runtime.deliverBatch("video_test", "reviewer", 0);
      assert.throws(() => f.runtime.acknowledgeBatch("video_test", "reviewer", receipts), refused("receipt"));
      f.runtime.acknowledgeBatch("video_test", "reviewer", replacement.deliveries.map((d) => ({
        receiptId: d.receipt.receiptId, sha256: d.receipt.sha256,
      })));
    } else f.runtime.acknowledgeBatch("video_test", "reviewer", receipts);
    for (const delivery of batch.deliveries) {
      assert.equal(hash(delivery.bytes), template.manifest.frames[delivery.receipt.videoFrame.index]!.sha256);
      assert.equal(delivery.receipt.evidenceId, binding.sourceEvidenceId, "original evidence ID retained with actual worker actor");
      seen.push(delivery.receipt.videoFrame.index);
    }
    cursor = batch.nextIndex;
  }
  assert.deepEqual(seen, template.manifest.frames.map((frame) => frame.index));
  assert.throws(() => f.runtime.deliverBatch("video_test", "reviewer", 0), refused("order"));
  const verdict = f.runtime.recordVerdict("video_test", "reviewer", report);
  assert.equal(verdict.receiptIds.length, 360);
  assert.equal(f.runtime.approvalProvenance("video_test", "reviewer").verdictId, verdict.verdictId);
});

test("original gate distinguishes parent-inspected images from exact worker video provenance at resolution and consumption", (t) => {
  const f = fixture(t); if (!f || !template) return;
  let cursor = 0;
  while (cursor < template.manifest.frames.length) {
    const batch: ReturnType<VideoEvidenceRuntime["deliverBatch"]> = f.runtime.deliverBatch("video_test", "reviewer", cursor);
    f.runtime.acknowledgeBatch("video_test", "reviewer", batch.deliveries.map((d) => ({
      receiptId: d.receipt.receiptId, sha256: d.receipt.sha256,
    })));
    cursor = batch.nextIndex;
  }
  const verdict = f.runtime.recordVerdict("video_test", "reviewer", report);
  const snapshot = { category: "ui_evidence_approval", evidence: [{
    evidenceId: binding.sourceEvidenceId, artifactId: binding.sourceArtifactId, sha256: binding.sourceSha256, mediaType: "video/webm",
  }] };
  const decision = {
    category: "ui_evidence_approval", authority: "orchestrator", status: "pending", resourceSnapshot: snapshot,
    controllingSessionId: "root", sessionId: "child", occurrenceId: binding.occurrenceId,
    resourceDigest: binding.resourceDigest, policyRevision: binding.policyRevision,
  } as unknown as WorkflowDecisionView;
  let current = true;
  const phases: string[] = [];
  const bridge = new VideoEvidenceDecisionBridge(f.runtime, {
    decisionCurrent: (_decision, phase) => { phases.push(phase); return current; },
    linkedReview: () => f.store.getReview("video_test"), directImageReviewed: () => false,
  });
  const reference = { evidenceId: binding.sourceEvidenceId, reviewId: "video_test",
    verdictId: verdict.verdictId, reviewerSessionId: "reviewer" };
  const original = JSON.stringify(snapshot);
  assert.equal(bridge.approvalProvenance(decision, [], [reference], "resolve")[0]?.reviewerSessionId, "reviewer");
  assert.throws(() => bridge.approvalProvenance(decision, [binding.sourceEvidenceId], [reference], "resolve"), /truthfully cover/u);
  assert.throws(() => bridge.approvalProvenance(decision, [], [{ ...reference, reviewerSessionId: "root" }], "resolve"), /original evidence/u);
  decision.status = "approved";
  assert.equal(bridge.approvalProvenance(decision, [], [reference], "consume")[0]?.verdictId, verdict.verdictId);
  current = false;
  assert.throws(() => bridge.approvalProvenance(decision, [], [reference], "consume"), /no current delegated/u);
  assert.ok(phases.includes("resolve") && phases.includes("consume"));
  assert.equal(JSON.stringify(snapshot), original, "no source snapshot rewrite or synthetic parent receipt");
});

test("attempted fresh reads after typed resolution do not destroy otherwise current unconsumed quality provenance", (t) => {
  const f = fixture(t); if (!f || !template) return;
  let cursor = 0;
  while (cursor < template.manifest.frames.length) {
    const batch: ReturnType<VideoEvidenceRuntime["deliverBatch"]> = f.runtime.deliverBatch("video_test", "reviewer", cursor);
    f.runtime.acknowledgeBatch("video_test", "reviewer", batch.deliveries.map((d) => ({
      receiptId: d.receipt.receiptId, sha256: d.receipt.sha256,
    }))); cursor = batch.nextIndex;
  }
  const verdict = f.runtime.recordVerdict("video_test", "reviewer", report);
  // Exact gate is approved: its owner can consume current provenance, worker has no new access.
  f.access.currentBinding = (_binding, phase) => phase === "resolve" ? binding : null;
  assert.throws(() => f.runtime.deliverBatch("video_test", "reviewer", 0), refused("stale"));
  assert.equal(f.store.getReview("video_test")?.status, "pending");
  assert.equal(f.runtime.approvalProvenance("video_test", "reviewer").verdictId, verdict.verdictId);
  f.access.currentBinding = () => null;
  assert.throws(() => f.runtime.approvalProvenance("video_test", "reviewer"), refused("stale"));
  assert.equal(f.store.getReview("video_test")?.status, "revoked");
});
