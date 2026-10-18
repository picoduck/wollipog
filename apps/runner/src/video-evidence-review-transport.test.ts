import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import fc from "fast-check";
import type { PacedVideoReviewDelivery, PacedVideoTransportGrant } from "@wollipog/protocol";
import { reviewVideoEvidenceFrame, reviewVideoEvidenceFrames, submitVideoEvidenceVerdict, type VideoReviewTransport } from "./video-evidence-review-transport.js";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
// Synthetic byte transport fixture only; no live Session, model or production receipt is created.
const bytes = Buffer.from("synthetic-frame-transport-bytes");
const grant: PacedVideoTransportGrant = {
  reviewId: "synthetic_review", reviewerSessionId: "worker", childSessionId: "child", occurrenceId: "workflow",
  policyRevision: 4, sourceEvidenceId: "synthetic_evidence", sourceArtifactId: "synthetic_source", sourceSha256: sha("source"),
  manifestSha256: sha("manifest"), bindingSha256: sha("binding"), criteriaSha256: sha("criteria"), deliveryPlanSha256: sha("plan"), expiresAt: 2_000,
  frames: [{ index: 0, ptsUs: 0, durationUs: 33_333, sha256: sha(bytes), sizeBytes: bytes.length }],
};
function fixture() {
  let now = 1_000, acknowledged = true;
  const calls: Array<{ action: string; body: Record<string, unknown> }> = [];
  const delivery: PacedVideoReviewDelivery = {
    mimeType: "image/png", sizeBytes: bytes.length, data: bytes.toString("base64"),
    receipt: { receiptId: "synthetic_receipt", occurrenceId: "workflow", reviewerSessionId: "worker", childSessionId: "child",
      policyRevision: 4, evidenceId: "synthetic_evidence", artifactId: "synthetic_review:frame:0",
      sha256: sha(bytes), deliveredAt: 1_000, deliveryOrder: 1, bindingSha256: sha("binding"), criteriaSha256: sha("criteria"),
      deliveryPlanSha256: sha("plan"), windowIndex: 0,
      videoFrame: { profile: "paced-silent-complete-frames-v1", sourceArtifactId: "synthetic_source", sourceSha256: sha("source"),
        manifestSha256: sha("manifest"), index: 0, ptsMs: 0, ptsUs: 0, durationUs: 33_333 } },
  };
  const deps: VideoReviewTransport = { grant: structuredClone(grant), now: () => now,
    request: async (action, body) => {
      calls.push({ action, body });
      if (action === "frame") return delivery;
      if (action === "acknowledge") return { acknowledged };
      return { verdictId: "synthetic_verdict", reviewId: grant.reviewId, reviewerSessionId: "worker",
        bindingSha256: grant.bindingSha256, outcome: "accept" };
    } };
  return { deps, delivery, calls, setTime: (value: number) => { now = value; }, setAck: (value: boolean) => { acknowledged = value; } };
}
test("verified bytes are acknowledged before image handoff and receipts claim no quality verdict", async () => {
  const f = fixture();
  const result = await reviewVideoEvidenceFrame({ index: 0 }, f.deps);
  assert.equal(result.isError, undefined);
  assert.deepEqual(f.calls.map((call) => call.action), ["frame", "acknowledge"]);
  assert.equal(result.content[1]?.type, "image");
  assert.match(result.content[0].text, /"qualityVerdictRecorded":false/u);
  assert.equal(f.calls[0]!.body.reviewId, grant.reviewId);
  assert.equal(Object.hasOwn(f.calls[0]!.body, "sourceArtifactId"), false);
});
test("generated changes in every receipt binding, order, timing and content field withhold images before acknowledgement", async () => {
  const top = ["occurrenceId", "reviewerSessionId", "childSessionId", "policyRevision", "evidenceId", "artifactId",
    "sha256", "bindingSha256", "criteriaSha256", "deliveryPlanSha256", "deliveryOrder"] as const;
  const temporal = ["sourceArtifactId", "sourceSha256", "manifestSha256", "index", "ptsMs", "ptsUs", "durationUs", "profile"] as const;
  await fc.assert(fc.asyncProperty(fc.constantFrom(...top.map((key) => "top:" + key), ...temporal.map((key) => "time:" + key)),
    async (coordinate) => {
      const f = fixture();
      const [group, key] = coordinate.split(":");
      const target = (group === "top" ? f.delivery.receipt : f.delivery.receipt.videoFrame) as unknown as Record<string, unknown>;
      const value = target[key!];
      target[key!] = typeof value === "number" ? key === "deliveryOrder" ? 0 : value + 1 : String(value) + "_changed";
      const result = await reviewVideoEvidenceFrame({ index: 0 }, f.deps);
      assert.equal(result.isError, true);
      assert.equal(result.content.length, 1);
      assert.equal(f.calls.some((call) => call.action === "acknowledge"), false);
    }), { numRuns: 80 });
  const f = fixture(); f.delivery.data = Buffer.from("substituted").toString("base64");
  assert.equal((await reviewVideoEvidenceFrame({ index: 0 }, f.deps)).isError, true);
  assert.equal(f.calls.length, 1);
});
test("unacknowledged or expired delivery and caller-selected resources are never shown", async () => {
  const f = fixture(); f.setAck(false);
  assert.equal((await reviewVideoEvidenceFrame({ index: 0 }, f.deps)).content.length, 1);
  f.setTime(2_000);
  assert.equal((await reviewVideoEvidenceFrame({ index: 0 }, f.deps)).isError, true);
  const other = fixture();
  assert.equal((await reviewVideoEvidenceFrame({ index: 0, reviewId: "borrowed" }, other.deps)).isError, true);
  assert.equal(other.calls.length, 0);
  other.deps.request = async () => { throw new Error("bearer PRIVATE_TOKEN https://private/?secret=private"); };
  const result = await reviewVideoEvidenceFrame({ index: 0 }, other.deps);
  assert.doesNotMatch(result.content[0].text, /PRIVATE|bearer|https|secret/u);
});
test("a recorded worker verdict remains separate from exact typed decision resolution", async () => {
  const f = fixture();
  const result = await submitVideoEvidenceVerdict({ outcome: "accept", criteria: [], rationale: "synthetic transport test" }, f.deps);
  assert.match(result.content[0].text, /"typedDecisionResolved":false/u);
  assert.equal(f.calls[0]?.action, "verdict");
  assert.equal(f.calls[0]?.body.reviewId, grant.reviewId);
  assert.equal((await submitVideoEvidenceVerdict({ outcome: "accept", criteria: [], rationale: "test", evidenceReviewed: ["fake"] }, f.deps)).isError, true);
});

test("validation transport rejects missing, stripped or borrowed purpose and production transport cannot accept validation receipts", async () => {
  const purpose = { permitId: "synthetic-human-permit", scopeSha256: sha("synthetic scoped action") };
  for (const mismatch of ["missing", "borrowed", "foreign", "production"]) {
    const f = fixture();
    f.deps.grant.operatorValidation = purpose;
    if (mismatch !== "missing") f.delivery.receipt.operatorValidation = mismatch === "borrowed" ? { ...purpose, permitId: "other" } :
      mismatch === "foreign" ? { ...purpose, scopeSha256: sha("other source") } : purpose;
    if (mismatch === "production") delete f.deps.grant.operatorValidation;
    const result = await reviewVideoEvidenceFrame({ index: 0 }, f.deps);
    assert.equal(result.isError, true, mismatch);
    assert.equal(f.calls.some((c) => c.action === "acknowledge"), false);
  }
  const f = fixture(); f.deps.grant.operatorValidation = purpose; f.delivery.receipt.operatorValidation = purpose;
  assert.equal((await reviewVideoEvidenceFrame({ index: 0 }, f.deps)).isError, undefined);
  f.deps.request = async () => ({ verdictId: "synthetic-verdict", reviewId: f.deps.grant.reviewId,
    reviewerSessionId: "worker", bindingSha256: f.deps.grant.bindingSha256, outcome: "accept", operatorValidation: purpose });
  const report = { outcome: "accept", criteria: [], rationale: "Disclosed synthetic test only." };
  const result = await submitVideoEvidenceVerdict(report, f.deps);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /"productionProof":false/);
  f.deps.request = async () => ({ verdictId: "synthetic-verdict", reviewId: f.deps.grant.reviewId,
    reviewerSessionId: "worker", bindingSha256: f.deps.grant.bindingSha256, outcome: "accept" });
  assert.equal((await submitVideoEvidenceVerdict(report, f.deps)).isError, true);
});

test("consecutive batch handoff verifies every frame before one atomic acknowledgement and preserves model-visible source order", async () => {
  const f = fixture();
  const base = structuredClone(f.delivery);
  f.deps.grant.frames.push({ ...f.deps.grant.frames[0]!, index: 1, ptsUs: 33_333 });
  const second = structuredClone(base);
  second.receipt.receiptId = "synthetic_receipt_two";
  second.receipt.artifactId = "synthetic_review:frame:1";
  second.receipt.deliveryOrder = 2;
  second.receipt.videoFrame.index = 1;
  second.receipt.videoFrame.ptsUs = 33_333;
  second.receipt.videoFrame.ptsMs = 33.333;
  let acknowledged = false;
  f.deps.request = async (action) => {
    if (action === "frames") return { deliveries: [base, second], nextIndex: 2, frameCount: 2 };
    assert.equal(action, "acknowledge-frames"); acknowledged = true; return { acknowledged: true };
  };
  const result = await reviewVideoEvidenceFrames({ index: 0 }, f.deps);
  assert.equal(result.isError, undefined); assert.equal(acknowledged, true);
  assert.deepEqual(result.content.map((block) => block.type), ["text", "text", "image", "text", "image"]);
  assert.match(result.content[1]!.type === "text" ? result.content[1]!.text : "", /"index":0/u);
  assert.match(result.content[3]!.type === "text" ? result.content[3]!.text : "", /"ptsUs":33333/u);
  acknowledged = false; second.receipt.videoFrame.index = 0;
  const bad = await reviewVideoEvidenceFrames({ index: 0 }, f.deps);
  assert.equal(bad.isError, true); assert.equal(bad.content.length, 1);
  assert.equal(acknowledged, false, "one changed frame withholds the whole batch");
});
test("missing, skipped, reversed, oversized and unacknowledged frame windows never become model image handoffs", async () => {
  for (const mutation of ["skipped", "reversed", "missing", "oversized", "extra", "unacknowledged"]) {
    const f = fixture();
    f.deps.request = async (action) => {
      if (action === "acknowledge-frames") return { acknowledged: mutation !== "unacknowledged" };
      const delivery = structuredClone(f.delivery);
      if (mutation === "reversed") delivery.receipt.deliveryOrder = 0;
      const batch = { deliveries: mutation === "missing" ? [] : mutation === "oversized" ? Array.from({ length: 33 }, () => delivery) : [delivery],
        nextIndex: mutation === "skipped" ? 2 : 1, frameCount: 1 };
      return mutation === "extra" ? { ...batch, oracle: "unexpected hidden truth" } : batch;
    };
    const result = await reviewVideoEvidenceFrames({ index: 0 }, f.deps);
    assert.equal(result.isError, true, mutation); assert.equal(result.content.length, 1);
    assert.doesNotMatch(result.content[0].text, /unexpected hidden truth/u);
  }
});

test("encoded native frame window cannot exceed 8 MiB even when each individual frame fits", async () => {
  const f = fixture(), large = Buffer.alloc(2 * 1024 * 1024, 42);
  f.deps.grant.frames = Array.from({ length: 3 }, (_, index) => ({
    index, ptsUs: index * 33_333, durationUs: 33_333, sha256: sha(large), sizeBytes: large.length,
  }));
  const deliveries = f.deps.grant.frames.map((frame) => ({
    ...structuredClone(f.delivery), data: large.toString("base64"), sizeBytes: large.length,
    receipt: { ...structuredClone(f.delivery.receipt), sha256: frame.sha256,
      receiptId: "synthetic_large_" + frame.index, artifactId: "synthetic_review:frame:" + frame.index,
      deliveryOrder: frame.index + 1, videoFrame: { ...f.delivery.receipt.videoFrame,
        index: frame.index, ptsUs: frame.ptsUs, ptsMs: frame.ptsUs / 1000, durationUs: frame.durationUs } },
  }));
  let ack = false;
  f.deps.request = async (action) => {
    if (action === "frames") return { deliveries, nextIndex: 3, frameCount: 3 };
    ack = true; return { acknowledged: true };
  };
  const result = await reviewVideoEvidenceFrames({ index: 0 }, f.deps);
  assert.equal(result.isError, true); assert.equal(result.content.length, 1); assert.equal(ack, false);
});
