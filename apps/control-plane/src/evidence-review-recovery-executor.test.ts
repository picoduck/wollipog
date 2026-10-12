import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { EvidenceRecoveryExecutor, type RecoveryExecutionPorts, type RecoveryReplacement,
  type RecoverySubject } from "./evidence-review-recovery-executor.js";
import { planEvidenceRecovery } from "./evidence-review-recovery.js";
const digest = "a".repeat(64);
const subject: RecoverySubject = { rootSessionId: "root", childSessionId: "child", occurrenceId: "original",
  evidenceId: "video", sourceSha256: digest, resourceDigest: digest, policyRevision: 1,
  criteriaSha256: digest, workerAdmissionSha256: digest };
// Synthetic capture/derivation ports exercise the durable execution contract only. They do not
// certify an actual capture, operator grant, provider launch, namespace or model-visible media.
function harness(t: { after(fn: () => void): void }) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const frames = Array.from({ length: 3 }, (_, index) => ({ index, ptsUs: index * 33_000,
    durationUs: 33_000, sha256: digest, sizeBytes: 10 }));
  let current: typeof frames | null = frames, launches = 0, reconciles = 0, derives = 0;
  let replacement: RecoveryReplacement | null = { subjects: [{ occurrenceId: "new-occurrence", evidenceId: "new-video",
    artifactId: "new-artifact", sha256: digest }], frames: frames.map((f) => ({ ...f, originalIndex: f.index, originalPtsUs: f.ptsUs })) };
  const ports: RecoveryExecutionPorts = { current: () => current,
    execute: async () => { launches++; return replacement?.subjects ?? null; },
    reconcile: async () => { reconciles++; return replacement?.subjects ?? null; },
    verifyReplacement: async () => { derives++; return replacement; } };
  return { db, ports, executor: new EvidenceRecoveryExecutor(db, ports),
    revoke: () => { current = null; }, replacement: () => replacement!,
    unknown: () => { replacement = null; }, counts: () => ({ launches, reconciles, derives }) };
}
test("exact duplicate and restart reuse the completed original capture operation without another launch", async (t) => {
  const h = harness(t), plan = planEvidenceRecovery("full_control", "split_capture", 0);
  const result = await h.executor.execute(subject, plan);
  assert.equal(result.state, "completed");
  assert.deepEqual(await new EvidenceRecoveryExecutor(h.db, h.ports).execute(subject, plan), result);
  assert.deepEqual(h.counts(), { launches: 1, reconciles: 0, derives: 2 });
});
test("completed readback re-verifies actual replacement artifacts and excludes unbound input fields", async (t) => {
  const h = harness(t), plan = planEvidenceRecovery("full_control", "split_capture", 0);
  assert.equal((await h.executor.execute(subject, plan)).state, "completed");
  h.ports.verifyReplacement = async () => null;
  assert.equal((await h.executor.execute(subject, plan)).state, "rejected");
  assert.equal((await h.executor.execute({ ...subject, extraInput: "private test sentinel" } as RecoverySubject, plan)).state, "unsupported");
  assert.equal(h.counts().launches, 1);
});
test("unknown capture cannot replay or spend on a replacement; same operation only reconciles", async (t) => {
  const h = harness(t); h.unknown();
  assert.equal((await h.executor.execute(subject, planEvidenceRecovery("full_control", "split_capture", 0))).state, "uncertain");
  assert.equal((await h.executor.execute(subject, planEvidenceRecovery("full_control", "split_capture", 1))).state, "uncertain");
  assert.equal((await h.executor.execute(subject, planEvidenceRecovery("full_control", "split_capture", 0))).state, "uncertain");
  assert.deepEqual(h.counts(), { launches: 1, reconciles: 1, derives: 0 });
});
test("dropped, sampled, retimed or substituted transient frames and original occurrence reuse fail closed", async (t) => {
  for (const change of [
    (h: ReturnType<typeof harness>) => { h.replacement().frames.splice(1, 1); },
    (h: ReturnType<typeof harness>) => { h.replacement().frames[1]!.originalPtsUs++; },
    (h: ReturnType<typeof harness>) => { h.replacement().frames[1]!.sha256 = "b".repeat(64); },
    (h: ReturnType<typeof harness>) => { h.replacement().subjects[0]!.occurrenceId = subject.occurrenceId; },
    (h: ReturnType<typeof harness>) => { h.ports.verifyReplacement = async () => { h.revoke(); return h.replacement(); }; },
  ]) {
    const h = harness(t); change(h);
    assert.equal((await h.executor.execute(subject, planEvidenceRecovery("full_control", "split_capture", 0))).state, "rejected");
    assert.equal(h.counts().launches, 1);
  }
});
test("oversized frame gets recapture specifically, and denial/Custom/exhaustion executes no capture", async (t) => {
  const h = harness(t);
  let action = "", reason = "";
  h.ports.execute = async (_subject, selected, _operation, why) => { action = selected; reason = why; return h.replacement().subjects; };
  assert.equal((await h.executor.execute(subject, planEvidenceRecovery("full_control", "recapture_frame_size", 0))).state, "completed");
  assert.equal(action, "recapture"); assert.match(reason, /splitting cannot repair/u);
  const refused = harness(t); refused.revoke();
  for (const plan of [planEvidenceRecovery("full_control", "recapture_frame_size", 0),
    planEvidenceRecovery("custom", "split_capture", 0), planEvidenceRecovery("full_control", "split_capture", 2)]) {
    assert.equal((await refused.executor.execute(subject, plan)).state, "unsupported");
  }
  assert.equal(refused.counts().launches, 0);
});
