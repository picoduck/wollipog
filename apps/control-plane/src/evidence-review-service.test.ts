import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthPrincipal } from "./identity.js";
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
    audienceSha256: digest, capabilitiesSha256: digest, sourceArtifactId: "source", sourceSha256: digest,
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
  let invoked = 0, owner = true, protocol = 218;
  const audit: EvidenceReviewAuditEvent[] = [];
  const pending: ResolvedVideoReviewRequest = {
    binding: record.binding, criteria: record.criteria, target: { agentId: "synthetic", driver: "codex-app-server",
      modelId: "synthetic-model", providerId: "synthetic-provider", runnerId: "runner", runnerProtocolVersion: 218,
      capabilitiesSha256: digest, auditedAllFrameDelivery: true, reviewerNamespaceSha256: digest, mediaOnlyNamespaceVerified: true },
    mediaType: "video/webm", mode: "full_control", sourceGrantVerified: true,
  };
  const verdict = { verdictId: "verdict", outcome: "accept", rationale: "PRIVATE_SENTINEL_DO_NOT_LOG" } as VideoReviewVerdict;
  const runtime = {
    derive: async () => { invoked++; throw new Error("No actual runtime invocation is expected."); },
    deliver: () => { invoked++; return { receipt: { receiptId: "receipt" }, bytes: Buffer.from("PRIVATE_PIXELS_SENTINEL") }; },
    acknowledge: () => { invoked++; }, recordVerdict: () => { invoked++; return verdict; },
    approvalProvenance: () => { invoked++; return verdict; },
  } as unknown as VideoEvidenceRuntime;
  const store = {
    getReview: (id: string) => id === "review" ? record : null,
  } as VideoReviewStore;
  const service = new EvidenceReviewService(runtime, store, {
    resolvePending: () => pending, currentOwner: () => owner, liveProof: () => null,
    reviewerProtocol: () => protocol, audit: (event) => { audit.push(event); },
  });
  return { service, audit, pending, count: () => invoked, setOwner: (value: boolean) => { owner = value; },
    setProtocol: (value: number) => { protocol = value; } };
}
const request = { childSessionId: "child", occurrenceId: "workflow", evidenceId: "source" };
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
  f.setProtocol(217);
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
