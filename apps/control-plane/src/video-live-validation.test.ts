import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { VideoLiveValidationRegistry, type InspectedVideoValidationRun } from "./video-live-validation.js";
import type { AuthPrincipal } from "./identity.js";
import type { EvidenceReviewerTarget } from "./evidence-review-worker.js";

const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const human: AuthPrincipal = {
  kind: "human", actorId: "human", userId: "human", userName: "Synthetic Test Human",
  organizationId: "org", organizationName: "Synthetic Org", role: "owner", deviceId: null, localBootstrap: false,
};
const target: EvidenceReviewerTarget = {
  agentId: "synthetic", driver: "codex-app-server", modelId: "synthetic-model", effort: "high", providerId: "synthetic-provider",
  runnerId: "isolated", runnerProtocolVersion: 221, capabilitiesSha256: digest("audited capability"),
  auditedAllFrameDelivery: true, reviewerNamespaceSha256: digest("narrowed namespace"), mediaOnlyNamespaceVerified: true,
};
/** Fake inputs in an in-memory test database only; not actual validated runs or live receipts. */
function runs(): InspectedVideoValidationRun[] {
  return ([
    { kind: "candidate", frameCount: 16, width: 640, height: 360, durationUs: 4_000_000 },
    { kind: "paced", frameCount: 360, width: 1280, height: 720, durationUs: 12_000_000 },
    { kind: "maximum", frameCount: 900, width: 1280, height: 720, durationUs: 30_000_000 },
  ] as const).map((profile) => ({
    ...profile, runId: "synthetic_" + profile.kind, target,
    sourceSha256: digest("source " + profile.kind), manifestSha256: digest("manifest " + profile.kind),
    orderedReceiptSetSha256: digest("ordered receipts " + profile.kind), privateOracleCommitmentSha256: digest("private oracle " + profile.kind),
    blindTemporalVerdictSha256: digest("blind verdict " + profile.kind),
    modelDeliveryEvidenceSha256: digest("model visible proof " + profile.kind),
    usageEvidenceSha256: digest("usage " + profile.kind), pricingEvidenceSha256: digest("official pricing " + profile.kind),
    oracleIsolationEvidenceSha256: digest("independent forbidden namespace probes"), oracleNamespaceInaccessibleVerified: true,
    actualInputTokens: 100, actualOutputTokens: 10, actualCostUsd: 0.1, latencyMs: 100,
    allSourceFramesDelivered: true, blindOracleMatched: true, privateOracleExcludedFromReviewerContext: true,
    providerUsageVerified: true, currentOfficialPricingVerified: true, sourceAndArtifactsStillMatch: true,
    inspectedByUserId: "human",
  }));
}
test("readiness has no default proof and agent credentials cannot record or revoke human validation", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const registry = new VideoLiveValidationRegistry(db);
  assert.equal(registry.current(target, 1_000), null);
  const agent: AuthPrincipal = { kind: "agent", actorId: "agent", credentialSessionId: "agent", organizationId: "org",
    delegatedScope: { organizationId: "org", owner: { kind: "user", userId: "human" } } };
  assert.equal(registry.recordInspectedRuns(agent, target, runs(), 1_000), null);
  assert.equal(registry.revoke(agent, "nonexistent"), false);
  assert.equal(registry.current(target, 1_000), null);
});
test("every run must establish complete actual delivery, blind oracle, actual usage and current pricing", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const registry = new VideoLiveValidationRegistry(db);
  for (const key of ["allSourceFramesDelivered", "blindOracleMatched", "privateOracleExcludedFromReviewerContext",
    "oracleNamespaceInaccessibleVerified", "providerUsageVerified", "currentOfficialPricingVerified", "sourceAndArtifactsStillMatch"] as const) {
    for (let index = 0; index < 3; index++) {
      const altered = runs(); altered[index]![key] = false;
      assert.equal(registry.recordInspectedRuns(human, target, altered, 1_000), null);
    }
  }
  const sampled = runs(); sampled[2]!.frameCount = 16;
  assert.equal(registry.recordInspectedRuns(human, target, sampled, 1_000), null);
  const unknownCost = runs(); unknownCost[0]!.actualCostUsd = 0;
  assert.equal(registry.recordInspectedRuns(human, target, unknownCost, 1_000), null);
  assert.equal(registry.recordInspectedRuns(human, target, runs().slice(1), 1_000), null);
  assert.equal(registry.current(target, 1_000), null);
});
test("human-inspected metadata is bound to exact model/capability and expires or revokes", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const registry = new VideoLiveValidationRegistry(db);
  const proof = registry.recordInspectedRuns(human, target, runs(), 1_000);
  assert.ok(proof);
  assert.equal(registry.current(target, 1_000)?.proofId, proof.proofId);
  assert.equal(registry.current({ ...target, capabilitiesSha256: digest("replacement capability") }, 1_000), null);
  assert.equal(registry.current({ ...target, reviewerNamespaceSha256: digest("changed namespace") }, 1_000), null);
  assert.equal(registry.current({ ...target, mediaOnlyNamespaceVerified: false }, 1_000), null);
  assert.equal(registry.current({ ...target, modelId: "other-model" }, 1_000), null);
  assert.equal(registry.current(target, proof.expiresAt), null);
  assert.equal(registry.revoke(human, proof.proofId), true);
  assert.equal(registry.current(target, 1_000), null);
});
test("only owners and admins list proofs; readiness counts only unrevoked proofs inside their window", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const registry = new VideoLiveValidationRegistry(db);
  const operator = { ...human, role: "operator" } as AuthPrincipal;
  const agent: AuthPrincipal = { kind: "agent", actorId: "agent", credentialSessionId: "agent", organizationId: "org",
    delegatedScope: { organizationId: "org", owner: { kind: "user", userId: "human" } } };
  assert.deepEqual(registry.list(human, 1_000), []);
  assert.equal(registry.list(operator, 1_000), null);
  assert.equal(registry.list(agent, 1_000), null);
  assert.equal(registry.recordInspectedRuns(operator, target, runs(), 1_000), null);
  assert.equal(registry.recordInspectedRuns(human, target, null as unknown as InspectedVideoValidationRun[], 1_000), null);
  const proof = registry.recordInspectedRuns(human, target, runs(), 1_000)!;
  assert.deepEqual(registry.unexpired(1_000).map((item) => item.proofId), [proof.proofId]);
  assert.deepEqual(registry.unexpired(999), [], "a proof is not current before it was validated");
  assert.deepEqual(registry.unexpired(proof.expiresAt), []);
  assert.deepEqual(registry.list(human, proof.expiresAt), [{ proofId: proof.proofId, driver: target.driver, modelId: target.modelId,
    providerId: target.providerId, capabilitiesSha256: target.capabilitiesSha256, validatedAt: 1_000, expiresAt: proof.expiresAt,
    verifiedByUserId: "human", revoked: false, expired: true }]);
  assert.equal(registry.revoke(operator, proof.proofId), false);
  assert.equal(registry.revoke(human, proof.proofId), true);
  assert.equal(registry.revoke(human, proof.proofId), false, "a revoked proof cannot be revoked twice");
  assert.deepEqual(registry.unexpired(1_000), []);
  assert.equal(registry.list(human, 1_000)![0]!.revoked, true);
});
