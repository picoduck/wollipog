import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import fc from "fast-check";
import type { PacedVideoReviewDelivery, PacedVideoTransportGrant } from "@wollipog/protocol";
import { reviewVideoEvidenceFrame, submitVideoEvidenceVerdict, type VideoReviewTransport } from "./video-evidence-review-transport.js";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
// Synthetic byte transport fixture only; no live Session, model or production receipt is created.
const bytes = Buffer.from("synthetic-frame-transport-bytes");
const grant: PacedVideoTransportGrant = {
  reviewId: "synthetic_review", reviewerSessionId: "worker", childSessionId: "child", occurrenceId: "workflow",
  policyRevision: 4, sourceArtifactId: "synthetic_source", sourceSha256: sha("source"),
  manifestSha256: sha("manifest"), bindingSha256: sha("binding"), criteriaSha256: sha("criteria"), expiresAt: 2_000,
  frames: [{ index: 0, ptsUs: 0, durationUs: 33_333, sha256: sha(bytes), sizeBytes: bytes.length }],
};
function fixture() {
  let now = 1_000, acknowledged = true;
  const calls: Array<{ action: string; body: Record<string, unknown> }> = [];
  const delivery: PacedVideoReviewDelivery = {
    mimeType: "image/png", sizeBytes: bytes.length, data: bytes.toString("base64"),
    receipt: { receiptId: "synthetic_receipt", occurrenceId: "workflow", reviewerSessionId: "worker", childSessionId: "child",
      policyRevision: 4, evidenceId: "synthetic_source:frame:0", artifactId: "synthetic_review:frame:0",
      sha256: sha(bytes), deliveredAt: 1_000, deliveryOrder: 1, bindingSha256: sha("binding"), criteriaSha256: sha("criteria"),
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
    "sha256", "bindingSha256", "criteriaSha256", "deliveryOrder"] as const;
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
