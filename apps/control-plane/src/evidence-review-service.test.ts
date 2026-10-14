import assert from "node:assert/strict";
import { test } from "node:test";
import { PACED_VIDEO_REVIEW_MIN_PROTOCOL } from "@wollipog/protocol";
import type { AuthPrincipal } from "./identity.js";
import type { VideoProfileLiveProof } from "./evidence-review-worker.js";
import { EvidenceReviewService, type EvidenceReviewAuditEvent, type ResolvedVideoReviewRequest } from "./evidence-review-service.js";
import type { VideoEvidenceRuntime, VideoReviewRecord, VideoReviewStore, VideoReviewVerdict } from "./video-evidence-runtime.js";

const digest = "a".repeat(64);
const agent = (id: string, orchestrator = false): AuthPrincipal => ({
  kind: "agent", actorId: id, credentialSessionId: id, orchestrator, organizationId: "org",
  delegatedScope: { organizationId: "org", owner: { kind: "user", userId: "owner" } },
});
const record: VideoReviewRecord = {
  reviewId: "review", binding: {
    rootSessionId: "root", childSessionId: "child", occurrenceId: "workflow", resourceDigest: digest,
    policyRevision: 4, boundaryRevision: 4, evidenceAuthorityRevision: 4, reviewerSessionId: "worker",
    reviewerDriver: "codex-app-server", reviewerModelId: "synthetic-model", providerId: "synthetic-provider",
    audienceSha256: digest, capabilitiesSha256: digest, sourceEvidenceId: "source_evidence", sourceArtifactId: "source", sourceSha256: digest,
    workerAdmissionSha256: digest, criteriaSha256: digest,
  },
  manifest: { schemaVersion: 1, purpose: "trusted_temporal_derivation", profile: "paced-silent-complete-frames-v1",
    sourceSha256: digest, sourceSizeBytes: 1, sourceMediaType: "video/webm", width: 1280, height: 720,
    durationUs: 1, frames: [], segments: [] }, manifestSha256: digest,
  criteria: [{ criterionId: "criterion", description: "Test criterion" }], criteriaSha256: digest,
  createdAt: 1_000, expiresAt: 1_001, status: "pending",
};
/** Credential/audit boundary test doubles only. Real derivation/provenance is tested separately
 * with all source frames; these values are never stored as an actual live proof or receipt. */
function fixture() {
  let invoked = 0, owner = true, protocol = PACED_VIDEO_REVIEW_MIN_PROTOCOL;
  let contract: unknown = { id: "wollipog-paced-video-review-v1", revision: 1 };
  let proof: VideoProfileLiveProof | null = null, settled = 0;
  const audit: EvidenceReviewAuditEvent[] = [];
  const pending: ResolvedVideoReviewRequest = {
    binding: record.binding, criteria: record.criteria, target: { agentId: "synthetic", driver: "codex-app-server",
      modelId: "synthetic-model", providerId: "synthetic-provider", runnerId: "runner", runnerProtocolVersion: PACED_VIDEO_REVIEW_MIN_PROTOCOL,
      pacedVideoReviewContract: { id: "wollipog-paced-video-review-v1", revision: 1 },
      capabilitiesSha256: digest, auditedAllFrameDelivery: true, reviewerNamespaceSha256: digest, mediaOnlyNamespaceVerified: true },
    mediaType: "video/webm", mode: "full_control", sourceGrantVerified: true,
  };
  const verdict = { verdictId: "verdict", outcome: "accept", rationale: "PRIVATE_SENTINEL_DO_NOT_LOG" } as VideoReviewVerdict;
  const runtime = {
    derive: async () => { invoked++; throw new Error("No actual runtime invocation is expected."); },
    deliver: () => { invoked++; return { receipt: { receiptId: "receipt" }, bytes: Buffer.from("PRIVATE_PIXELS_SENTINEL") }; },
    deliverBatch: () => { invoked++; return { deliveries: [] }; },
    acknowledgeBatch: () => { invoked++; },
    acknowledge: () => { invoked++; }, recordVerdict: () => { invoked++; return verdict; },
    approvalProvenance: () => { invoked++; return verdict; },
  } as unknown as VideoEvidenceRuntime;
  const store = {
    getReview: (id: string) => id === "review" ? record : null,
    settle: () => { settled++; },
  } as VideoReviewStore;
  const adapter = {
    resolvePending: () => pending, currentOwner: () => owner, liveProof: () => proof,
    reviewerProtocol: () => protocol, peerContract: (_sessionId: string) => contract,
    audit: (event: EvidenceReviewAuditEvent) => { audit.push(event); },
  };
  const service = new EvidenceReviewService(runtime, store, adapter);
  return { service, audit, pending, count: () => invoked, setOwner: (value: boolean) => { owner = value; },
    setProtocol: (value: number) => { protocol = value; }, setContract: (value: unknown) => { contract = value; }, adapter,
    runtime, settled: () => settled, setProof: (value: VideoProfileLiveProof | null) => { proof = value; } };
}
const request = { childSessionId: "child", occurrenceId: "workflow", evidenceId: "source" };
test("standalone service refuses absent metadata before private image delivery and owner provenance", () => {
  const f = fixture(); f.setContract(undefined);
  assert.throws(() => f.service.deliver(agent("worker"), "review", 0));
  assert.throws(() => f.service.ownerProvenance(agent("root", true), "review"));
  assert.equal(f.count(), 0);
  assert.deepEqual(f.audit, []);
});
test("every service entry rejects missing, malformed, revoked or throwing peer metadata before private effects", () => {
  for (const metadata of [undefined, { id: "other", revision: 1 }, { id: "wollipog-paced-video-review-v1", revision: 2 },
    { id: "wollipog-paced-video-review-v1", revision: 1, grant: true }]) {
    const f = fixture(); f.setContract(metadata);
    for (const action of [() => f.service.deliver(agent("worker"), "review", 0),
      () => f.service.deliverBatch(agent("worker"), "review", 0),
      () => f.service.acknowledgeBatch(agent("worker"), "review", [{ receiptId: "receipt", sha256: digest }]),
      () => f.service.acknowledge(agent("worker"), "review", "receipt", digest),
      () => f.service.verdict(agent("worker"), "review", { outcome: "accept", criteria: [], rationale: "synthetic" }),
      () => f.service.ownerProvenance(agent("root", true), "review")]) assert.throws(action);
    assert.equal(f.count(), 0); assert.deepEqual(f.audit, []);
  }
  for (const sessionId of ["root", "child", "worker"]) {
    const f = fixture();
    f.adapter.peerContract = (id: string) => id === sessionId ? undefined : { id: "wollipog-paced-video-review-v1", revision: 1 };
    assert.throws(() => f.service.deliver(agent("worker"), "review", 0));
    assert.throws(() => f.service.ownerProvenance(agent("root", true), "review"));
    assert.equal(f.count(), 0); assert.deepEqual(f.audit, []);
  }
  const f = fixture(); f.adapter.peerContract = () => { throw new Error("unknown current selection"); };
  assert.throws(() => f.service.deliver(agent("worker"), "review", 0));
  assert.equal(f.count(), 0); assert.deepEqual(f.audit, []);
  const absent = fixture();
  delete (absent.adapter as { peerContract?: unknown }).peerContract;
  assert.throws(() => absent.service.deliver(agent("worker"), "review", 0));
  assert.equal(absent.count(), 0); assert.deepEqual(absent.audit, []);
});
test("current peer revocation after synthetic derive prevents retries/recovery or successful publication", async () => {
  for (const outcome of ["success", "busy"] as const) {
    const f = fixture(); const target = f.pending.target;
    // Pure Source proof object, never an actual human-inspected validation record.
    f.setProof({ proofId: "synthetic-not-live", driver: target.driver, modelId: target.modelId, providerId: target.providerId,
      capabilitiesSha256: digest, reviewerNamespaceSha256: digest, oracleIsolationEvidenceSha256: digest,
      profile: "paced-silent-complete-frames-v1", validatedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000,
      candidateValidationRunId: "synthetic", pacedValidationRunId: "synthetic", maximumProfileValidationRunId: "synthetic",
      sourceSha256: digest, manifestSha256: digest, orderedReceiptSetSha256: digest, privateOracleCommitmentSha256: digest,
      blindTemporalVerdictSha256: digest, modelDeliveryEvidenceSha256: digest, usageEvidenceSha256: digest,
      pricingEvidenceSha256: digest, inputTokens: 1, outputTokens: 1, actualCostUsd: 1, latencyMs: 1,
      verifiedByUserId: "synthetic-human" });
    let derives = 0;
    f.runtime.derive = async () => { derives++; f.setContract(undefined);
      return outcome === "success" ? { ok: true, review: record } : { ok: false, code: "decoder_busy" }; };
    assert.deepEqual(await f.service.prepare(agent("root", true), request), { ok: false, code: "not_authorized" });
    assert.equal(derives, 1); assert.equal(f.settled(), outcome === "success" ? 1 : 0);
    assert.deepEqual(f.audit, []); assert.equal(f.count(), 0);
  }
});
test("implementer, ordinary Session and human request bodies cannot mint an agent review grant", async () => {
  const f = fixture();
  for (const principal of [agent("child", true), agent("worker", true), agent("root")]) {
    assert.deepEqual(await f.service.prepare(principal, request), { ok: false, code: "not_authorized" });
  }
  assert.equal(f.count(), 0);
  for (const id of ["child", "root", "unrelated"]) {
    assert.throws(() => f.service.deliver(agent(id, true), "review", 0), /credential cannot review/u);
    assert.throws(() => f.service.verdict(agent(id, true), "review", { outcome: "accept", criteria: [], rationale: "message" }),
      /credential cannot review/u);
  }
  assert.equal(f.count(), 0);
});
test("Custom/mixed-peer/missing-live-proof preflight never invokes a decoder or worker", async () => {
  const f = fixture();
  assert.deepEqual(await f.service.prepare(agent("root", true), request), { ok: false, code: "live_validation" });
  f.setProtocol(220);
  assert.deepEqual(await f.service.prepare(agent("root", true), request), { ok: false, code: "mixed_peer" });
  f.pending.mode = "custom";
  assert.deepEqual(await f.service.prepare(agent("root", true), request), { ok: false, code: "custom_fallback" });
  assert.equal(f.count(), 0);
});
test("worker cannot exercise typed-owner provenance, owner revocation prevents provenance", () => {
  const f = fixture();
  assert.throws(() => f.service.ownerProvenance(agent("worker", true), "review"), /current workflow decision owner/u);
  assert.equal(f.count(), 0);
  assert.equal(f.service.ownerProvenance(agent("root", true), "review").verdictId, "verdict");
  f.setOwner(false);
  assert.throws(() => f.service.ownerProvenance(agent("root", true), "review"), /current workflow decision owner/u);
  assert.equal(f.count(), 1);
});
test("lifecycle telemetry is correlated metadata and excludes media, rationale and report bodies", () => {
  const f = fixture();
  f.service.deliver(agent("worker"), "review", 0);
  f.service.acknowledge(agent("worker"), "review", "receipt", digest);
  f.service.verdict(agent("worker"), "review", { outcome: "accept", criteria: [], rationale: "PRIVATE_SENTINEL_DO_NOT_LOG" });
  f.service.ownerProvenance(agent("root", true), "review");
  assert.deepEqual(f.audit.map((event) => event.entryPoint), [
    "reviewer_media", "reviewer_media", "reviewer_verdict", "owner_provenance",
  ]);
  for (const event of f.audit) {
    assert.equal(event.occurrenceId, "workflow");
    assert.equal(event.reviewId, "review");
    assert.equal(event.manifestSha256, digest);
  }
  assert.doesNotMatch(JSON.stringify(f.audit), /PRIVATE|rationale|criteria|bytes|token|url/iu);
});
