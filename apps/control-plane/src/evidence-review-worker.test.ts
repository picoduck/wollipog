import { reviewerBudgetAdmissionDigest } from "./evidence-review-admission.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { admitEvidenceReviewer, reviewerAdmissionReadiness, type EvidenceReviewerTarget,
  type ReviewerAdmissionContext, type ReviewerAdmissionDependencies, type VideoProfileLiveProof } from "./evidence-review-worker.js";
import { PACED_VIDEO_REVIEW_PROFILE } from "./video-evidence-runtime.js";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const target: EvidenceReviewerTarget = {
  agentId: "synthetic-agent", driver: "codex-app-server", modelId: "synthetic-model", providerId: "synthetic-provider",
  runnerId: "isolated-runner", runnerProtocolVersion: 218, capabilitiesSha256: hash("all-frame-attestation"),
  auditedAllFrameDelivery: true,
};
const evidence = {
  version: 1 as const, revision: 4, authorizedByUserId: "synthetic-human", authorizedAt: 1_000,
  campaignRootSessionId: "root", repository: "owner/repo", objective: "Review issue 1321", issueScopeRevision: 1,
  scope: "relevant_task_evidence_only" as const, destination: { kind: "session_artifacts" as const,
    configurationId: "synthetic-private-config", organizationId: "synthetic-org", privacy: "private" as const, disclosureRevision: 1 },
  providers: [{ providerId: target.providerId, disclosureRevision: 1, retentionDisclosure: "Synthetic test disclosure.",
    reviewers: [{ driver: "codex-app-server" as const, modelId: target.modelId }] }],
};
const context: ReviewerAdmissionContext = {
  mode: "full_control", rootSessionId: "root", childSessionId: "child", repository: "owner/repo", issue: 1321,
  issueScopeRevision: 1, policyRevision: 4,
  boundary: { version: 1, revision: 4, issueScopeRevision: 1, repository: "owner/repo", objective: "Review issue 1321",
    authorizedByUserId: "synthetic-human", authorizedAt: 1_000, operations: ["ui_evidence_approval"],
    delegatablePolicyIds: [], evidenceAuthority: evidence },
  evidenceAuthority: evidence, uiEvidenceOwner: "orchestrator", taskEvidenceVerified: true,
  destinationConfigurationId: evidence.destination.configurationId, organizationId: evidence.destination.organizationId,
  audienceSha256: hash("private audience"), controllerProtocolVersion: 218, childProtocolVersion: 218,
  boundaryCurrent: true, scopeCurrent: true, destinationPrivateVerified: true,
};
/** Test-only fake proof exercises admission guards. It is never written as a live validation record. */
const proof = (): VideoProfileLiveProof => ({
  proofId: "synthetic-proof-not-live", driver: target.driver, modelId: target.modelId, providerId: target.providerId,
  capabilitiesSha256: target.capabilitiesSha256, profile: PACED_VIDEO_REVIEW_PROFILE, validatedAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000,
  candidateValidationRunId: "synthetic-candidate", pacedValidationRunId: "synthetic-paced",
  maximumProfileValidationRunId: "synthetic-maximum", sourceSha256: hash("source"), manifestSha256: hash("manifest"),
  orderedReceiptSetSha256: hash("receipts"), privateOracleCommitmentSha256: hash("private challenge"),
  blindTemporalVerdictSha256: hash("temporal answer"), modelDeliveryEvidenceSha256: hash("model-visible frame evidence"),
  usageEvidenceSha256: hash("usage"), pricingEvidenceSha256: hash("pricing"), inputTokens: 100, outputTokens: 10,
  actualCostUsd: 0.1, latencyMs: 10, verifiedByUserId: "synthetic-human",
});
const workerBudget = { rootSessionId: "root", authorityRevision: 4,
  allocation: { sessionId: "worker", costUsd: 1, toolCalls: 1000 },
  worker: { sessionId: "worker", driver: target.driver, model: target.modelId, effort: "high" } };
const workerAdmission = { ...workerBudget, allocationDigest: reviewerBudgetAdmissionDigest(workerBudget) };
function fixture() {
  let current = structuredClone(context);
  let verifiedProof: VideoProfileLiveProof | null = proof();
  let dispatchStatus: "launched" | "uncertain" | "not_launched" | "throw" = "launched";
  let found: ReturnType<NonNullable<ReviewerAdmissionDependencies["dispatcher"]>["find"]> = null;
  let launches = 0, reservations = 0, releases = 0;
  const begun = new Map<string, string>();
  const deps: ReviewerAdmissionDependencies = {
    context: () => current, liveProof: () => verifiedProof,
    begin: (id, binding) => {
      const prior = begun.get(id);
      if (prior) return prior === binding ? "existing" : "mismatch";
      begun.set(id, binding); return "created";
    },
    finish: () => {},
    allowance: {
      reserve: (request) => { reservations++; return { reservationId: "reserved", reviewerSessionId: "worker", rootSessionId: "root",
        policyRevision: 4, admissionId: request.admissionId, status: "reserved" }; },
      current: () => ({ reservationId: "reserved", reviewerSessionId: "worker", rootSessionId: "root", policyRevision: 4,
        admissionId: "admission", status: "active" }),
      preflight: () => workerAdmission,
      releaseUnlaunched: () => { releases++; },
    },
    dispatcher: {
      launch: async (request) => {
        launches++;
        if (dispatchStatus === "throw") throw new Error("lost response");
        if (dispatchStatus === "launched") found = { reviewerSessionId: "worker", rootSessionId: "root",
          reservationId: "reserved", audienceSha256: current.audienceSha256, target: request.target, status: "running" };
        return dispatchStatus === "launched" ? { status: "launched", reviewerSessionId: "worker" } : { status: dispatchStatus };
      },
      find: () => found,
    },
  };
  return { deps, setContext: (value: ReviewerAdmissionContext) => { current = value; },
    setProof: (value: VideoProfileLiveProof | null) => { verifiedProof = value; },
    setStatus: (value: typeof dispatchStatus) => { dispatchStatus = value; },
    setFound: (value: typeof found) => { found = value; },
    counts: () => ({ launches, reservations, releases }) };
}
test("unknown actual media delivery/cost and absent allowance refuse before reservations or dispatch", async () => {
  const f = fixture(); f.setProof(null);
  assert.deepEqual(await admitEvidenceReviewer("admission", target, f.deps), { ok: false, reason: "live_validation" });
  assert.deepEqual(f.counts(), { launches: 0, reservations: 0, releases: 0 });
  f.setProof({ ...proof(), actualCostUsd: 0 });
  assert.deepEqual(await admitEvidenceReviewer("admission", target, f.deps), { ok: false, reason: "live_validation" });
  f.setProof(proof()); delete f.deps.allowance;
  assert.deepEqual(await admitEvidenceReviewer("admission", target, f.deps), { ok: false, reason: "allowance_unsupported" });
  assert.equal(f.counts().launches, 0);
});
test("Custom, authority revocation, undisclosed provider/destination and mixed peers fail closed", () => {
  for (const [patch, reason] of [
    [{ mode: "custom" }, "custom_fallback"], [{ uiEvidenceOwner: "human" }, "human_required"],
    [{ destinationPrivateVerified: false }, "destination"], [{ boundaryCurrent: false }, "boundary"],
    [{ scopeCurrent: false }, "scope"], [{ taskEvidenceVerified: false }, "scope"],
    [{ childProtocolVersion: 217 }, "mixed_peer"], [{ controllerProtocolVersion: 217 }, "mixed_peer"],
    [{ destinationConfigurationId: "arbitrary-files" }, "destination"],
  ] as const) {
    assert.deepEqual(reviewerAdmissionReadiness({ ...context, ...patch }, target, proof(), Date.now()), { ok: false, reason });
  }
  assert.deepEqual(reviewerAdmissionReadiness(context, { ...target, providerId: "undisclosed" }, proof(), Date.now()),
    { ok: false, reason: "provider" });
  assert.deepEqual(reviewerAdmissionReadiness(context, { ...target, auditedAllFrameDelivery: false }, proof(), Date.now()),
    { ok: false, reason: "capability" });
});
test("reservation precedes authenticated managed dispatch and exact duplicate reconciles without replay", async () => {
  const f = fixture();
  const result = await admitEvidenceReviewer("admission", target, f.deps);
  assert.deepEqual(result, { ok: true, admissionId: "admission", reviewerSessionId: "worker", reservationId: "reserved", workerAdmission });
  assert.deepEqual(await admitEvidenceReviewer("admission", target, f.deps), result);
  assert.deepEqual(f.counts(), { launches: 1, reservations: 1, releases: 0 });
  f.setContext({ ...context, issue: 1448 });
  assert.deepEqual(await admitEvidenceReviewer("admission", target, f.deps), { ok: false, reason: "boundary" });
  assert.equal(f.counts().launches, 1);
});
test("uncertain launch retains allocation and reconciles durable identity without starting a replacement", async () => {
  const f = fixture(); f.setStatus("throw");
  assert.deepEqual(await admitEvidenceReviewer("admission", target, f.deps), { ok: false, reason: "launch_uncertain" });
  assert.deepEqual(f.counts(), { launches: 1, reservations: 1, releases: 0 });
  f.setFound({ reviewerSessionId: "worker", rootSessionId: "root", reservationId: "reserved",
    audienceSha256: context.audienceSha256, target, status: "running" });
  assert.equal((await admitEvidenceReviewer("admission", target, f.deps)).ok, true);
  assert.equal(f.counts().launches, 1);
});
test("confirmed unlaunched work releases allocation, self-review identity cannot be reconciled", async () => {
  const f = fixture(); f.setStatus("not_launched");
  assert.deepEqual(await admitEvidenceReviewer("admission", target, f.deps), { ok: false, reason: "launch_failed" });
  assert.deepEqual(f.counts(), { launches: 1, reservations: 1, releases: 1 });
  f.setFound({ reviewerSessionId: "child", rootSessionId: "root", reservationId: "reserved",
    audienceSha256: context.audienceSha256, target, status: "running" });
  assert.deepEqual(await admitEvidenceReviewer("admission", target, f.deps), { ok: false, reason: "launch_uncertain" });
  assert.equal(f.counts().launches, 1);
});
test("policy changed during launch never yields approval readiness or releases potentially live capacity", async () => {
  const f = fixture();
  const launch = f.deps.dispatcher!.launch;
  f.deps.dispatcher!.launch = async (request) => {
    const result = await launch(request);
    f.setContext({ ...context, uiEvidenceOwner: "human" });
    return result;
  };
  assert.deepEqual(await admitEvidenceReviewer("admission", target, f.deps), { ok: false, reason: "human_required" });
  assert.equal(f.counts().releases, 0);
});
