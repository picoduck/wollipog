import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { EvidenceRecoveryExecutor, type RecoveryAuthority, type RecoveryCapture, type RecoveryExecutionPorts,
  type RecoveryReplacement, type RecoveryStage, type RecoveryStageReceipt,
  type RecoverySubject } from "./evidence-review-recovery-executor.js";
import { planEvidenceRecovery } from "./evidence-review-recovery.js";
const digest = "a".repeat(64), freshDigest = "b".repeat(64), criteria = "c".repeat(64);
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const subject: RecoverySubject = { rootSessionId: "root", childSessionId: "child", occurrenceId: "original",
  evidenceId: "video", sourceSha256: digest, resourceDigest: digest, policyRevision: 1,
  criteriaSha256: digest, workerAdmissionSha256: digest };
const split = (attempt = 0) => planEvidenceRecovery("full_control", "split_capture", attempt);
// All authority, allowance, provenance and stage receipts below are DISCLOSED SYNTHETIC fixtures.
// They test actual SQLite/CAS control flow only. None is a real Human grant, capture, settlement,
// provider launch, native model inspection, private oracle or production quality certificate.
function harness(t: { after(fn: () => void): void }, count = 3) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const frames = Array.from({ length: count }, (_, index) => ({ index, ptsUs: index * 33_000,
    durationUs: 33_000, sha256: digest, sizeBytes: 10 }));
  const expiry = Date.now() + 600_000;
  let authority: RecoveryAuthority | null = {
    subject, frames, lineage: { rootSessionId: "root", originalOccurrenceId: "original", originalEvidenceId: "video",
      sourceSha256: digest, criteriaSha256: digest, captureTraceSha256: digest, transientCoverageSha256: digest,
      actionSha256: digest, maxCostUsd: 2.5, maxToolCalls: 12, maxWorkUnits: 7200 },
    disposition: { kind: "recoverable_inadequate_evidence", ownerId: "actual-test-owner", actualOwnerId: "actual-test-owner",
      ownerKind: "orchestrator", occurrenceId: subject.occurrenceId, resourceDigest: subject.resourceDigest,
      policyRevision: 1, receiptSha256: digest, expiresAt: expiry },
    capture: { allowanceId: "independent-test-reservation", independent: true, actionSha256: digest, profileSha256: digest,
      expiresAt: expiry, maxCostUsd: 2.5, maxToolCalls: 12, maxWorkUnits: 7200, sourceSizeBytes: 10, lineageBudgetCurrent: true },
    freshGate: { ownerId: "actual-test-owner", authoritySha256: digest, boundarySha256: digest, scopeSha256: digest,
      audienceSha256: digest, criteriaSha256: criteria, expiresAt: expiry },
    current: { rootActive: true, admission: true, scope: true, privacy: true, denied: false, humanRequired: false, ownerRevoked: false },
  };
  let capture: RecoveryCapture | null = {
    artifacts: Array.from({ length: Math.ceil(count / 900) }, (_, i) => ({ artifactId: "new-artifact-" + i, sha256: freshDigest, sizeBytes: 10 })),
    frames: frames.map((f) => ({ ...f, segmentIndex: Math.floor(f.index / 900), index: f.index % 900,
      ptsUs: f.index % 900 * 33_000, originalIndex: f.index, originalPtsUs: f.ptsUs })),
    captureTraceSha256: digest, transientCoverageSha256: digest, actionSha256: digest,
  };
  const receipts = new Map<string, RecoveryStageReceipt>();
  const calls: RecoveryStage[] = [], reconciles: RecoveryStage[] = [];
  let loses: RecoveryStage | null = null;
  function subjects(): RecoveryReplacement["subjects"] {
    return capture!.artifacts.map((a, i) => ({ occurrenceId: "new-occurrence-" + i, evidenceId: "new-video-" + i,
      artifactId: a.artifactId, sha256: a.sha256, resourceDigest: freshDigest, criteriaSha256: criteria,
      profileSha256: authority!.capture.profileSha256, ownerId: authority!.freshGate.ownerId,
      authoritySha256: authority!.freshGate.authoritySha256 }));
  }
  const ports: RecoveryExecutionPorts = {
    current: (s) => authority ? { ...structuredClone(authority), subject: s, disposition: { ...authority.disposition,
      occurrenceId: s.occurrenceId, resourceDigest: s.resourceDigest, policyRevision: s.policyRevision } } : null,
    executeStage: async (stage, intent, operationId, prior) => {
      assert.equal(db.isTransaction, false, "external effects cannot borrow an uncommitted intent");
      assert.equal(db.prepare("SELECT state FROM evidence_recovery_stages WHERE operation_id=? AND stage=?")
        .get(intent.operationId, stage)?.state, "uncertain", "stage intent committed before every effect");
      assert.equal(prior.length, ["reject_original", "capture", "create_occurrences"].indexOf(stage));
      assert.equal(receipts.has(operationId), false, "no duplicate original mutation");
      calls.push(stage);
      const receipt: RecoveryStageReceipt = { stage, operationId, intentSha256: sha(intent), outcome: "completed",
        ...(stage === "reject_original" ? { rejectionSha256: digest } : stage === "capture" ? { artifacts: capture!.artifacts } : { subjects: subjects() }) };
      receipts.set(operationId, structuredClone(receipt));
      return loses === stage ? null : receipt;
    },
    reconcileStage: async (stage, _intent, operationId) => { reconciles.push(stage); return receipts.get(operationId) ?? null; },
    verifyStage: async (r) => sha(receipts.get(r.operationId)) === sha(r),
    verifyArtifacts: async () => structuredClone(capture),
    verifyOccurrences: async (s) => sha(subjects()) === sha(s),
  };
  return { db, ports, executor: new EvidenceRecoveryExecutor(db, ports), calls, reconciles, receipts,
    authority: () => authority!, capture: () => capture!, revoke: () => { authority = null; },
    unknownArtifacts: () => { capture = null; }, lose: (stage: RecoveryStage) => { loses = stage; } };
}
test("durable owner rejection, capture and new occurrence intents execute once; duplicate/restart reverify artifacts", async (t) => {
  const h = harness(t), result = await h.executor.execute(subject, split());
  assert.equal(result.state, "completed");
  assert.deepEqual(h.calls, ["reject_original", "capture", "create_occurrences"]);
  assert.deepEqual(await new EvidenceRecoveryExecutor(h.db, h.ports).execute(subject, split()), result);
  assert.equal(h.calls.length, 3); assert.equal(h.reconciles.length, 0);
  h.ports.verifyArtifacts = async () => null;
  assert.equal((await h.executor.execute(subject, split())).state, "uncertain");
  assert.equal((await h.executor.execute({ ...subject, occurrenceId: "different-id" }, split(1))).state, "uncertain");
  assert.equal(h.calls.length, 3);
  assert.equal((await h.executor.execute({ ...subject, unboundInput: "test-only" } as RecoverySubject, split())).state, "unsupported");
});
test("all three lost-response stages reconcile the exact original mutation before any further effects", async (t) => {
  for (const stage of ["reject_original", "capture", "create_occurrences"] as const) {
    const h = harness(t); h.lose(stage);
    assert.equal((await h.executor.execute(subject, split())).state, "uncertain");
    const mutations = h.calls.length;
    assert.equal((await h.executor.execute(subject, split(1))).state, "uncertain");
    assert.equal((await new EvidenceRecoveryExecutor(h.db, h.ports).execute(subject, split())).state, "completed");
    assert.deepEqual(h.calls, ["reject_original", "capture", "create_occurrences"]);
    assert.deepEqual(h.reconciles, [stage]); assert.ok(mutations <= 3);
  }
});
test("unconfirmed stage, artifact and fresh-gate outcomes retain uncertainty and cannot admit a new attempt", async (t) => {
  for (const change of [
    (h: ReturnType<typeof harness>) => { h.ports.verifyStage = async () => false; },
    (h: ReturnType<typeof harness>) => { h.ports.verifyArtifacts = async () => null; },
    (h: ReturnType<typeof harness>) => { h.ports.verifyOccurrences = async () => false; },
  ]) {
    const h = harness(t); change(h);
    assert.equal((await h.executor.execute(subject, split())).state, "uncertain");
    const before = h.calls.length;
    assert.equal((await h.executor.execute({ ...subject, occurrenceId: "fresh-attempt-id" }, split(1))).state, "uncertain");
    assert.equal(h.calls.length, before);
  }
});
test("generic/hard denial, Human Required, unknown, expiry, scope, owner revocation and missing independent allowance never mutate", async (t) => {
  const changes: Array<(a: RecoveryAuthority) => void> = [
    (a) => { a.disposition.kind = "permission_denied"; }, (a) => { a.disposition.kind = "human_required"; },
    (a) => { a.disposition.kind = "unknown"; }, (a) => { a.disposition.ownerKind = "human"; },
    (a) => { a.disposition.actualOwnerId = "other-owner"; }, (a) => { a.disposition.expiresAt = Date.now() - 1; },
    (a) => { a.capture.expiresAt = Date.now() - 1; }, (a) => { a.freshGate.expiresAt = Date.now() - 1; },
    (a) => { a.current.scope = false; }, (a) => { a.current.denied = true; },
    (a) => { a.current.humanRequired = true; }, (a) => { a.current.ownerRevoked = true; },
    (a) => { a.current.rootActive = false; }, (a) => { a.current.admission = false; }, (a) => { a.current.privacy = false; },
    (a) => { a.capture.independent = false; }, (a) => { a.capture.lineageBudgetCurrent = false; },
    (a) => { a.capture.maxCostUsd = 0; }, (a) => { a.capture.maxCostUsd = 3; },
    (a) => { a.capture.actionSha256 = freshDigest; }, (a) => { a.lineage.captureTraceSha256 = "unknown"; },
    (a) => { delete (a.current as Partial<RecoveryAuthority["current"]>).denied; },
  ];
  for (const change of changes) {
    const h = harness(t); change(h.authority());
    assert.equal((await h.executor.execute(subject, split())).state, "unsupported");
    assert.equal(h.calls.length, 0);
    assert.equal(h.db.prepare("SELECT count(*) AS n FROM evidence_recovery_attempts").get()?.n, 0);
  }
});
test("fresh IDs, profiles and admissions cannot reset durable original-lineage two-attempt or spending ceilings", async (t) => {
  const h = harness(t);
  assert.equal((await h.executor.execute(subject, split())).state, "completed");
  const fresh = { ...subject, occurrenceId: "fresh-id", evidenceId: "fresh-video", workerAdmissionSha256: freshDigest };
  h.authority().capture.profileSha256 = freshDigest;
  assert.equal((await new EvidenceRecoveryExecutor(h.db, h.ports).execute(fresh, split())).state, "rejected");
  assert.equal(h.calls.length, 3);
  assert.equal((await h.executor.execute(fresh, split(1))).state, "completed");
  const third = { ...fresh, occurrenceId: "third-id" };
  assert.equal((await h.executor.execute(third, split())).state, "rejected");
  assert.equal((await h.executor.execute(third, split(1))).state, "rejected");
  assert.equal(h.calls.length, 6);
  h.authority().lineage.maxCostUsd = 10;
  assert.equal((await h.executor.execute(third, split(1))).state, "rejected");
  assert.equal(h.calls.length, 6);
});
test("complete >900 original frames split into finite native segments without losing transients or time", async (t) => {
  const h = harness(t, 1801), result = await h.executor.execute(subject, split());
  assert.equal(result.state, "completed");
  if (result.state !== "completed") return;
  assert.equal(result.replacement.artifacts.length, 3); assert.equal(result.replacement.frames.length, 1801);
  assert.deepEqual(result.replacement.frames.map((f) => f.originalPtsUs), h.authority().frames.map((f) => f.ptsUs));
  const excessive = harness(t, 7201);
  assert.equal((await excessive.executor.execute(subject, split())).state, "unsupported");
  assert.equal(excessive.calls.length, 0);
});
test("specific oversized-frame recapture permits changed pixels only for independently bound fresh exact gates", async (t) => {
  const h = harness(t);
  h.authority().frames[1]!.sizeBytes = 2 * 1024 * 1024 + 1;
  h.capture().frames[1]!.sha256 = freshDigest; h.capture().frames[1]!.sizeBytes = 10;
  const frozen = structuredClone(subject), plan = planEvidenceRecovery("full_control", "recapture_frame_size", 0);
  assert.equal((await h.executor.execute(subject, plan)).state, "completed");
  assert.deepEqual(subject, frozen); assert.match(plan.reason, /splitting cannot repair/u);
  const forbiddenSplit = harness(t); forbiddenSplit.capture().frames[1]!.sha256 = freshDigest;
  assert.equal((await forbiddenSplit.executor.execute(subject, split())).state, "rejected");
  assert.equal(forbiddenSplit.calls.includes("create_occurrences"), false);
});
test("sampled, dropped, retimed, unbound or excessive segment coverage never creates fresh gates", async (t) => {
  for (const change of [
    (h: ReturnType<typeof harness>) => { h.capture().frames.splice(1, 1); },
    (h: ReturnType<typeof harness>) => { h.capture().frames[1]!.originalPtsUs++; },
    (h: ReturnType<typeof harness>) => { h.capture().frames[1]!.durationUs++; },
    (h: ReturnType<typeof harness>) => { h.capture().transientCoverageSha256 = freshDigest; },
    (h: ReturnType<typeof harness>) => { h.capture().frames[1]!.segmentIndex = 7; },
    (h: ReturnType<typeof harness>) => { h.capture().frames[1]!.sizeBytes = 2 * 1024 * 1024 + 1; },
    (h: ReturnType<typeof harness>) => { h.capture().artifacts[0]!.sizeBytes = 32 * 1024 * 1024 + 1; },
  ]) {
    const h = harness(t); change(h);
    assert.equal((await h.executor.execute(subject, split())).state, "rejected");
    assert.equal(h.calls.includes("create_occurrences"), false);
  }
});
test("revocation between actual mutation and response blocks subsequent effects and keeps intent uncertain", async (t) => {
  const h = harness(t), execute = h.ports.executeStage;
  h.ports.executeStage = async (...args) => { const r = await execute(...args); h.revoke(); return r; };
  assert.equal((await h.executor.execute(subject, split())).state, "unsupported");
  assert.deepEqual(h.calls, ["reject_original"]);
  assert.equal(h.db.prepare("SELECT state FROM evidence_recovery_attempts").get()?.state, "uncertain");
});
test("concurrent attempts cannot double-mutate and nested transactions cannot publish uncommitted intents", async (t) => {
  const h = harness(t), execute = h.ports.executeStage;
  let release!: () => void;
  const blocked = new Promise<void>((r) => { release = r; });
  h.ports.executeStage = async (...args) => { if (args[0] === "reject_original") await blocked; return execute(...args); };
  const first = h.executor.execute(subject, split());
  assert.equal((await h.executor.execute(subject, split())).state, "uncertain");
  release(); assert.equal((await first).state, "completed"); assert.equal(h.calls.length, 3);
  const nested = harness(t); nested.db.exec("BEGIN IMMEDIATE");
  assert.equal((await nested.executor.execute(subject, split())).state, "unsupported");
  nested.db.exec("ROLLBACK"); assert.equal(nested.calls.length, 0);
});
test("unmappable old execution rows remain conservative rather than inventing new lineage capacity", async (t) => {
  const h = harness(t);
  h.db.exec("CREATE TABLE evidence_recovery_execution (state TEXT); INSERT INTO evidence_recovery_execution VALUES ('uncertain')");
  assert.equal((await h.executor.execute(subject, split())).state, "uncertain"); assert.equal(h.calls.length, 0);
});
test("wrong original source/criteria, Custom and exhausted plans provide no new mutation authority", async (t) => {
  const h = harness(t);
  for (const s of [{ ...subject, sourceSha256: freshDigest }, { ...subject, criteriaSha256: criteria }]) {
    assert.equal((await h.executor.execute(s, split())).state, "unsupported");
  }
  assert.equal((await h.executor.execute(subject, planEvidenceRecovery("custom", "split_capture", 0))).state, "unsupported");
  assert.equal((await h.executor.execute(subject, { ...split(), nextAttempt: 3 } as ReturnType<typeof split>)).state, "exhausted");
  assert.equal(h.calls.length, 0);
});
test("wrong operation/gate/criteria and extra stage payload are uncertain, never replayed or approved", async (t) => {
  for (const change of [
    (r: RecoveryStageReceipt) => { r.operationId += "-wrong"; },
    (r: RecoveryStageReceipt) => { r.subjects![0]!.occurrenceId = subject.occurrenceId; },
    (r: RecoveryStageReceipt) => { r.subjects![0]!.criteriaSha256 = digest; },
    (r: RecoveryStageReceipt) => { Object.assign(r, { unboundInput: "test-only" }); },
  ]) {
    const h = harness(t), execute = h.ports.executeStage;
    h.ports.executeStage = async (...args) => {
      const r = await execute(...args);
      if (args[0] === "create_occurrences" && r) { change(r); h.receipts.set(args[2], structuredClone(r)); }
      return r;
    };
    assert.equal((await h.executor.execute(subject, split())).state, "uncertain");
    assert.equal((await h.executor.execute(subject, split(1))).state, "uncertain");
    assert.equal(h.calls.length, 3);
  }
});

test("CR2 Reproduction F3 refreshed expiry never reports an uncertain durable mutation as rejected", async (t) => {
  const h = harness(t); h.lose("capture");
  assert.equal((await h.executor.execute(subject, split())).state, "uncertain");
  const before = h.calls.length, reads = h.reconciles.length;
  h.authority().capture.expiresAt++;
  const resumed = await h.executor.execute(subject, split());
  assert.equal(h.db.prepare("SELECT state FROM evidence_recovery_attempts").get()?.state, "uncertain");
  assert.equal(h.calls.length, before, "renewal cannot authorize replay/another capture or refund");
  assert.equal(h.reconciles.length, reads, "renewed authority cannot read back the old effect");
  assert.equal(resumed.state, "uncertain", "truthful uncertainty must retain the exact original outcome fence");
});
