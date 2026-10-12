import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { EvidenceReviewBudgetProvenance, type CompletedMediaBudgetAttestation, type MediaBudgetProvenancePorts } from "./evidence-review-budget-provenance.js";
import { reviewerBudgetAdmissionDigest, type EvidenceReviewerBudgetAdmission } from "./evidence-review-admission.js";
import { videoReviewBindingDigest, type VideoReviewBinding, type VideoReviewVerdict } from "./video-evidence-runtime.js";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = "a".repeat(64);
function fixture() {
  const raw = { rootSessionId: "root", authorityRevision: 4,
    allocation: { sessionId: "worker", costUsd: 2, toolCalls: 1000 },
    dispatch: { rootSessionId: "root", generation: "original-generation" },
    worker: { sessionId: "worker", driver: "codex-app-server", model: "synthetic-model", effort: "high" } };
  const admission: EvidenceReviewerBudgetAdmission = { ...raw, allocationDigest: reviewerBudgetAdmissionDigest(raw) };
  const binding: VideoReviewBinding = {
    rootSessionId: "root", childSessionId: "child", occurrenceId: "original-occurrence",
    resourceDigest: digest, policyRevision: 4, boundaryRevision: 4, evidenceAuthorityRevision: 4,
    reviewerSessionId: "worker", reviewerDriver: "codex-app-server", reviewerModelId: "synthetic-model",
    providerId: "synthetic-provider", audienceSha256: digest, capabilitiesSha256: digest,
    sourceEvidenceId: "original-source", sourceArtifactId: "artifact", sourceSha256: digest,
    workerAdmissionSha256: admission.allocationDigest, criteriaSha256: digest,
  };
  const verdict = { reviewerSessionId: "worker", bindingSha256: videoReviewBindingDigest(binding),
    workerAdmission: admission } as VideoReviewVerdict;
  const rawReceipt = { rootSessionId: "root", sessionId: "worker",
    checkpoint: { generation: "original-generation", historyEpoch: 0, throughSeq: 42, costUsd: 0.5 },
    actual: { costUsd: 0.5, toolCalls: 15 } };
  const receipt: CompletedMediaBudgetAttestation = { ...rawReceipt, settlementDigest: sha(rawReceipt) };
  let active = true, allowed = true;
  const worker = { rootSessionId: "root", driver: "codex-app-server", model: "synthetic-model",
    effort: "high", generation: "original-generation", normalCompletion: false };
  const ports: MediaBudgetProvenancePorts = {
    preflight: () => active ? admission : null, completedAttestation: () => receipt,
    verdict: () => verdict, worker: () => worker, currentOwnerActionAllowed: () => allowed,
  };
  return { provenance: new EvidenceReviewBudgetProvenance(ports), binding, verdict, admission, worker, receipt, ports,
    complete: () => { active = false; worker.normalCompletion = true; }, deny: () => { allowed = false; } };
}
// Test doubles only. They are never published as Session identities, usage, live proof or receipts.
test("normal final settlement supports only the original historical verdict, never fresh active access", () => {
  const f = fixture();
  assert.deepEqual(f.provenance.active(f.binding), f.admission);
  assert.deepEqual(f.provenance.historical(f.binding), f.admission);
  assert.equal(f.provenance.normalCompletion(f.binding), false);
  f.complete();
  assert.equal(f.provenance.active(f.binding), null);
  assert.equal(f.provenance.normalCompletion(f.binding), true);
  assert.deepEqual(f.provenance.historical(f.binding), f.admission);
  for (const field of ["occurrenceId", "sourceEvidenceId", "sourceArtifactId"] as const) {
    assert.equal(f.provenance.historical({ ...f.binding, [field]: "replacement" }), null);
  }
});
test("replacement generations, model/effort or campaign identities invalidate completed proof without resetting allowance", () => {
  for (const mutation of [
    (f: ReturnType<typeof fixture>) => { f.worker.generation = "replacement"; },
    (f: ReturnType<typeof fixture>) => { f.worker.model = "another-model"; },
    (f: ReturnType<typeof fixture>) => { f.worker.effort = "low"; },
    (f: ReturnType<typeof fixture>) => { f.worker.rootSessionId = "other-root"; },
    (f: ReturnType<typeof fixture>) => { f.receipt.sessionId = "another-session"; },
    (f: ReturnType<typeof fixture>) => { f.receipt.checkpoint.generation = "old-generation"; },
  ]) {
    const f = fixture(); f.complete(); mutation(f);
    assert.equal(f.provenance.normalCompletion(f.binding), false);
    assert.equal(f.provenance.historical(f.binding), null);
  }
});
test("terminal state, code-job-shaped proof, changed settlement, missing final checkpoint and overspent ceilings do not establish completion", () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.ports.completedAttestation = () => null; },
    (f: ReturnType<typeof fixture>) => { f.ports.completedAttestation = () => ({ jobId: "native-code-job" }) as unknown as CompletedMediaBudgetAttestation; },
    (f: ReturnType<typeof fixture>) => { f.receipt.actual.costUsd += 1; },
    (f: ReturnType<typeof fixture>) => { f.receipt.checkpoint.throughSeq = -1; },
    (f: ReturnType<typeof fixture>) => {
      f.receipt.actual.toolCalls = 1001;
      const { settlementDigest: _digest, ...raw } = f.receipt; f.receipt.settlementDigest = sha(raw);
    },
  ];
  for (const mutation of mutations) {
    const f = fixture(); f.complete(); mutation(f);
    assert.equal(f.provenance.normalCompletion(f.binding), false);
    assert.equal(f.provenance.historical(f.binding), null);
  }
  const f = fixture(); f.ports.preflight = () => null;
  assert.equal(f.provenance.historical(f.binding), null, "terminal without normal settlement is insufficient");
});
test("current root denial blocks historical owner action after settlement while completed worker still loses fresh access", () => {
  const f = fixture(); f.complete(); f.deny();
  assert.equal(f.provenance.historical(f.binding), null);
  assert.equal(f.provenance.normalCompletion(f.binding), true, "normal completion status is historical, not a new grant");
  assert.equal(f.provenance.active(f.binding), null);
});
