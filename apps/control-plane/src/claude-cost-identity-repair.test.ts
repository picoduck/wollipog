import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";
import type { SessionSnapshot } from "@wollipog/protocol";
import { registerUsageRoutes } from "./usage-routes.js";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { SessionManager } from "../../runner/src/session-manager.js";
import { SessionStore } from "../../runner/src/session-store.js";
import { applyClaudeReconciliation, previewClaudeReconciliation, reconciliationCoordinate, observeReconciliationSnapshot,
  observedReconciliationRevision, normalizeReconciledSnapshot, reconciliationSnapshotAvailable } from "./claude-cost-reconciliation.js";
import { exportClaudeRepairCheckpoint, previewClaudeAcknowledgementRepair, applyClaudeAcknowledgementRepair, acknowledgementRepairFrame } from "./claude-cost-repair.js";

const principal: HumanPrincipal = { kind: "human", actorId: "owner", userId: "owner", userName: "Owner", organizationId: "org_personal", organizationName: "Personal", role: "owner", deviceId: "device", localBootstrap: false };
function fixture(path = ":memory:") {
  const db = ControlPlaneDb.open(path), now = Date.now();
  db.registerRunner({ runnerId: "runner", hostname: "host", os: "linux", version: "test", agents: [], workspaces: [] }, now, 210);
  db.createSession({ id: "session", runnerId: "runner", workspaceId: null, agentId: "claude", driver: "claude-code", title: "Fixture", useWorktree: false, config: {}, now });
  const events = [0.004, 0.006, 0.01, 0.02].map((costUsd, i) => db.appendEvent("session", { kind: "token_usage", model: "claude-test", costUsd, inputTokens: 10, outputTokens: 1 }, now + i, { accrueUsage: true, runnerSeq: i + 1, historyEpoch: 1 }));
  function evidence(offset: number) {
    const start = offset === 0 ? 0.004 : 0.01, end = offset === 0 ? 0.006 : 0.02;
    return { sessionId: "session", eventEpoch: 0, historyEpoch: 1, importAuthorized: true, sourceSha256: "a".repeat(64), records: [
      { eventId: events[offset]!.id, conversation: (offset ? "e" : "b").repeat(64), process: "c".repeat(64), boundary: "origin", startUsd: 0, endUsd: start, model: "claude-test", scope: "query-tree" },
      { eventId: events[offset + 1]!.id, conversation: (offset ? "e" : "b").repeat(64), process: "d".repeat(64), boundary: "resume", startUsd: start, endUsd: end, model: "claude-test", scope: "query-tree" } ] };
  }
  const snapshot: SessionSnapshot = { id: "session", agentId: "claude", workspaceId: null, driver: "claude-code", title: "Fixture", status: "idle", config: {}, useWorktree: false, worktreePath: null, preview: null, pendingApproval: null, costUsd: 0.04, tokensIn: 40, tokensOut: 4, seq: 4, historyEpoch: 1, createdAt: now, updatedAt: now };
  const correct = (offset: number) => { const input = evidence(offset); return applyClaudeReconciliation(db, principal, input, previewClaudeReconciliation(db, principal, input).digest); };
  return { db, now, snapshot, evidence, correct };
}
function repairEvidence(db: ControlPlaneDb, snapshot: SessionSnapshot) {
  return { ...exportClaudeRepairCheckpoint(db, principal, "session"), importAuthorized: true, sourceSha256: "f".repeat(64), runner: {
    revision: snapshot.costReconciliationRevision ?? 0, identity: snapshot.costReconciliationIdentity, deltaUsd: snapshot.costReconciliationDeltaUsd ?? 0,
    repairId: snapshot.costReconciliationRepairId, costUsd: snapshot.costUsd, tokensIn: snapshot.tokensIn, tokensOut: snapshot.tokensOut, seq: snapshot.seq, historyEpoch: snapshot.historyEpoch! } };
}

for (const corrected of [false, true]) for (const confirmed of [false, true]) test(`Claude Restart preserves cross-peer repair acknowledgement: corrected=${corrected}, confirmed=${confirmed}`, async () => {
  const f = fixture(), root = mkdtempSync(join(tmpdir(), "repair-restart-"));
  let manager: SessionManager | undefined;
  try {
    execFileSync("git", ["init", root]);
    if (corrected) f.correct(0);
    const target = reconciliationCoordinate(f.db, "session");
    const corrupt = { ...f.snapshot, costUsd: f.db.sessionCostUsd("session"), costReconciliationRevision: Number.MAX_SAFE_INTEGER,
      costReconciliationIdentity: target.identity, costReconciliationDeltaUsd: target.deltaUsd };
    observeReconciliationSnapshot(f.db, corrupt);
    const input = repairEvidence(f.db, corrupt), preview = previewClaudeAcknowledgementRepair(f.db, principal, input);
    applyClaudeAcknowledgementRepair(f.db, principal, input, preview.digest);
    const store = new SessionStore(join(root, "runner-sessions"));
    store.create({ sessionId: "session", agentId: "claude", workspaceId: "repo", repoPath: root,
      worktreePath: null, driver: "claude-code", command: "claude", args: [], env: {}, context: { kind: "native" },
      agentSessionId: "old-conversation", status: "idle", title: "Fixture", config: {},
      costUsd: corrupt.costUsd, tokensIn: corrupt.tokensIn, tokensOut: corrupt.tokensOut, seq: corrupt.seq, logEpoch: 1,
      costReconciliationRevision: corrupt.costReconciliationRevision, costReconciliationIdentity: corrupt.costReconciliationIdentity,
      costReconciliationDeltaUsd: corrupt.costReconciliationDeltaUsd, preview: null, pendingApproval: null, createdAt: f.now, updatedAt: f.now });
    const factory = () => ({ initialize: async () => {}, newSession: async () => {}, close: async () => {},
      prompt: async () => "end_turn", cancel() {}, dispose() {}, setConfig() {}, resolvePermission: () => false,
      agentSessionId: () => "fresh-conversation" });
    manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, factory as never, root, 1);
    // Use the actual runner CAS and snapshot projection, including a crash before CP confirmation.
    const frame = acknowledgementRepairFrame(f.db, "session")!;
    manager.syncPricedSessionCost("session", frame.costUsd, frame.costReconciliationRevision, frame.costReconciliationDeltaUsd, frame);
    if (confirmed) observeReconciliationSnapshot(f.db, manager.snapshotForControlPlane(store.readMeta("session")!));
    assert.equal(await manager.start({ sessionId: "session", agentId: "claude", workspaceId: "repo", workspacePath: root,
      driver: "claude-code", command: "claude", args: [], env: {}, context: { kind: "native" }, useWorktree: false }), true);
    const restarted = manager.snapshotForControlPlane(store.readMeta("session")!);
    assert.notEqual(store.readMeta("session")!.agentSessionId, "old-conversation");
    observeReconciliationSnapshot(f.db, restarted);
    assert.equal(reconciliationSnapshotAvailable(f.db, restarted), true);
    assert.equal(normalizeReconciledSnapshot(f.db, restarted).costUsd, corrupt.costUsd);
    assert.equal(acknowledgementRepairFrame(f.db, "session"), null, "pending repair confirms after Restart");
    const stale = { ...restarted, costReconciliationRepairId: undefined, costReconciliationRevision: Number.MAX_SAFE_INTEGER };
    observeReconciliationSnapshot(f.db, stale);
    assert.equal(reconciliationSnapshotAvailable(f.db, stale), false);
    assert.equal(observedReconciliationRevision(f.db, "session"), target.revision, "Restart does not weaken stale-generation fencing");
  } finally { manager?.shutdownAll(); f.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("different revision-1 identities after restore cannot resurrect the old total or clear their fence", () => {
  const original = fixture(), restored = fixture();
  try {
    original.correct(0); restored.correct(2);
    const old = reconciliationCoordinate(original.db, "session");
    const snapshot = { ...original.snapshot, costUsd: 0.036, costReconciliationRevision: 1, costReconciliationIdentity: old.identity, costReconciliationDeltaUsd: old.deltaUsd };
    assert.notEqual(old.identity, reconciliationCoordinate(restored.db, "session").identity);
    observeReconciliationSnapshot(restored.db, snapshot);
    assert.throws(() => restored.db.updateSessionFromSnapshot("session", snapshot, original.now), /identity/);
    assert.equal(restored.db.sessionCostUsd("session"), 0.03);
    observeReconciliationSnapshot(restored.db, { ...snapshot, costReconciliationRevision: 0 });
    assert.equal(reconciliationSnapshotAvailable(restored.db, { ...snapshot, costReconciliationRevision: 0 }), false);
    const good = reconciliationCoordinate(restored.db, "session");
    const matching = { ...snapshot, costUsd: 0.03, costReconciliationIdentity: good.identity, costReconciliationDeltaUsd: good.deltaUsd };
    observeReconciliationSnapshot(restored.db, matching);
    assert.equal(reconciliationSnapshotAvailable(restored.db, matching), false, "equal-number snapshots cannot clear conflicting provenance");
    assert.equal(previewClaudeReconciliation(restored.db, principal, restored.evidence(0)).deltaUsd, 0);
  } finally { original.db.close(); restored.db.close(); }
});

test("a conflicting same-number acknowledgement remains durable after an earlier valid one", () => {
  const { db, snapshot, correct } = fixture();
  try {
    correct(0); const target = reconciliationCoordinate(db, "session");
    const valid = { ...snapshot, costReconciliationRevision: target.revision, costReconciliationIdentity: target.identity, costReconciliationDeltaUsd: target.deltaUsd };
    observeReconciliationSnapshot(db, valid);
    assert.equal(reconciliationSnapshotAvailable(db, valid), true);
    observeReconciliationSnapshot(db, { ...valid, costReconciliationIdentity: "f".repeat(64) });
    observeReconciliationSnapshot(db, valid);
    assert.equal(reconciliationSnapshotAvailable(db, valid), false);
  } finally { db.close(); }
});

for (const corrected of [false, true]) test(`verified metadata-only repair survives reopen, replay and exact retry: corrected=${corrected}`, () => {
  const dir = mkdtempSync(join(tmpdir(), "cost-repair-")), path = join(dir, "state.sqlite");
  const fixtureData = fixture(path); let db = fixtureData.db;
  try {
    if (corrected) fixtureData.correct(0);
    const target = reconciliationCoordinate(db, "session");
    const corrupt = { ...fixtureData.snapshot, costUsd: db.sessionCostUsd("session"), costReconciliationRevision: Number.MAX_SAFE_INTEGER, costReconciliationIdentity: target.identity, costReconciliationDeltaUsd: target.deltaUsd };
    observeReconciliationSnapshot(db, corrupt);
    observeReconciliationSnapshot(db, { ...corrupt, costReconciliationRevision: 0 });
    assert.equal(observedReconciliationRevision(db, "session"), Number.MAX_SAFE_INTEGER);
    const input = repairEvidence(db, corrupt), before = db.raw().prepare("SELECT * FROM usage_session_state").all();
    const changes = db.raw().prepare("SELECT total_changes() AS n").get()?.n;
    const preview = previewClaudeAcknowledgementRepair(db, principal, input);
    assert.equal(preview.repairable, true, preview.unresolved.join(","));
    assert.equal(db.raw().prepare("SELECT total_changes() AS n").get()?.n, changes);
    const applied = applyClaudeAcknowledgementRepair(db, principal, input, preview.digest);
    assert.equal(applied.confirmed, false);
    assert.equal(observedReconciliationRevision(db, "session"), Number.MAX_SAFE_INTEGER, "approval alone cannot clear the fence");
    const frame = acknowledgementRepairFrame(db, "session")!;
    assert.deepEqual(frame.costReconciliationRepair!.expected, JSON.parse(JSON.stringify(input.runner)));
    db.close(); db = ControlPlaneDb.open(path);
    assert.deepEqual(acknowledgementRepairFrame(db, "session"), frame);
    const repaired = { ...corrupt, costReconciliationRevision: target.revision, costReconciliationIdentity: target.identity, costReconciliationRepairId: preview.digest };
    observeReconciliationSnapshot(db, { ...repaired, costReconciliationRepairId: "e".repeat(64) });
    assert.equal(observedReconciliationRevision(db, "session"), Number.MAX_SAFE_INTEGER);
    observeReconciliationSnapshot(db, repaired);
    assert.equal(observedReconciliationRevision(db, "session"), target.revision);
    assert.equal(normalizeReconciledSnapshot(db, repaired).costUsd, repaired.costUsd);
    observeReconciliationSnapshot(db, corrupt);
    assert.equal(observedReconciliationRevision(db, "session"), target.revision, "old repair generations cannot recreate the corrupt high-water mark");
    assert.equal(reconciliationSnapshotAvailable(db, corrupt), false);
    assert.equal(reconciliationSnapshotAvailable(db, repaired), true);
    assert.deepEqual(db.raw().prepare("SELECT * FROM usage_session_state").all(), before);
    assert.equal(applyClaudeAcknowledgementRepair(db, principal, input, preview.digest).applied, false);
    assert.equal(applyClaudeAcknowledgementRepair(db, principal, input, preview.digest).confirmed, true);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM usage_cost_reconciliation_repairs").get()?.n, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("repair refuses missing corrections and checkpoint conflicts; new state invalidates approval", () => {
  const { db, snapshot, correct, now } = fixture();
  try {
    correct(0);
    const target = reconciliationCoordinate(db, "session");
    const ahead = { ...snapshot, costUsd: 0.03, costReconciliationRevision: 2, costReconciliationIdentity: "e".repeat(64), costReconciliationDeltaUsd: -0.01 };
    observeReconciliationSnapshot(db, ahead);
    assert.equal(previewClaudeAcknowledgementRepair(db, principal, repairEvidence(db, ahead)).repairable, false);
    // A separate fixture observation models corrupt revision metadata with the established delta.
    db.raw().exec("DELETE FROM usage_cost_reconciliation_identity_observations; DELETE FROM usage_cost_reconciliation_observations");
    const corrupt = { ...snapshot, costUsd: db.sessionCostUsd("session"), costReconciliationRevision: Number.MAX_SAFE_INTEGER, costReconciliationIdentity: target.identity, costReconciliationDeltaUsd: target.deltaUsd };
    observeReconciliationSnapshot(db, corrupt);
    const input = repairEvidence(db, corrupt), preview = previewClaudeAcknowledgementRepair(db, principal, input);
    assert.equal(preview.repairable, true);
    assert.equal(previewClaudeAcknowledgementRepair(db, principal, { ...input, sourceSha256: "e".repeat(64), ledger: { ...input.ledger, costMicrousd: 1 } }).repairable, false);
    db.appendEvent("session", { kind: "token_usage", model: "claude-test", costUsd: 0.001 }, now + 4, { accrueUsage: true, runnerSeq: 5, historyEpoch: 1 });
    assert.throws(() => applyClaudeAcknowledgementRepair(db, principal, input, preview.digest), /changed/);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM usage_cost_reconciliation_repairs").get()?.n, 0);
  } finally { db.close(); }
});

test("repair intent and acknowledgement writes roll back on interruption", () => {
  const { db, snapshot } = fixture();
  try {
    const corrupt = { ...snapshot, costReconciliationRevision: Number.MAX_SAFE_INTEGER, costReconciliationDeltaUsd: 0 };
    observeReconciliationSnapshot(db, corrupt);
    const input = repairEvidence(db, corrupt), preview = previewClaudeAcknowledgementRepair(db, principal, input);
    db.raw().exec("CREATE TRIGGER interrupt_repair BEFORE INSERT ON usage_cost_reconciliation_repairs BEGIN SELECT RAISE(ABORT,'interrupted'); END");
    assert.throws(() => applyClaudeAcknowledgementRepair(db, principal, input, preview.digest), /interrupted/);
    assert.equal(acknowledgementRepairFrame(db, "session"), null);
    db.raw().exec("DROP TRIGGER interrupt_repair");
    applyClaudeAcknowledgementRepair(db, principal, input, preview.digest);
    db.raw().exec("CREATE TRIGGER interrupt_confirmation BEFORE UPDATE ON usage_cost_reconciliation_repairs BEGIN SELECT RAISE(ABORT,'interrupted'); END");
    const repaired = { ...snapshot, costReconciliationDeltaUsd: 0, costReconciliationRepairId: preview.digest };
    assert.throws(() => observeReconciliationSnapshot(db, repaired), /interrupted/);
    assert.equal(observedReconciliationRevision(db, "session"), Number.MAX_SAFE_INTEGER);
    db.raw().exec("DROP TRIGGER interrupt_confirmation");
    observeReconciliationSnapshot(db, repaired);
    assert.equal(reconciliationSnapshotAvailable(db, repaired), true);
  } finally { db.close(); }
});

test("repair routes require scoped human approval and expose an audited pending intent", async () => {
  const logs: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) { logs.push(String(chunk)); callback(); } });
  const { db, snapshot } = fixture(); const app = Fastify({ logger: { level: "info", stream } }); let actor = principal;
  try {
    const corrupt = { ...snapshot, costReconciliationRevision: Number.MAX_SAFE_INTEGER, costReconciliationDeltaUsd: 0 };
    observeReconciliationSnapshot(db, corrupt);
    const input = repairEvidence(db, corrupt), frames: unknown[] = [];
    registerUsageRoutes(app, db, () => actor, { requestFromRunner: async () => null as never, sendToRunner: (_runner, frame) => { frames.push(frame); return false; } });
    actor = { ...principal, role: "operator" };
    assert.equal((await app.inject({ method: "POST", url: "/api/usage/claude-reconciliation/repair/preview", payload: input })).statusCode, 403);
    actor = { ...principal, organizationId: "org_other" };
    assert.throws(() => previewClaudeAcknowledgementRepair(db, actor, input), /permission/);
    actor = principal;
    const preview = (await app.inject({ method: "POST", url: "/api/usage/claude-reconciliation/repair/preview", payload: input })).json();
    assert.equal(preview.repairable, true);
    const body = { evidence: input, approvedDigest: preview.digest, approved: true };
    assert.equal((await app.inject({ method: "POST", url: "/api/usage/claude-reconciliation/repair/apply", payload: { ...body, approved: false } })).statusCode, 400);
    const result = await app.inject({ method: "POST", url: "/api/usage/claude-reconciliation/repair/apply", payload: body });
    assert.equal(result.statusCode, 200); assert.equal(result.json().synchronized, false); assert.equal(frames.length, 1);
    const audit = (await app.inject({ method: "GET", url: "/api/usage/claude-reconciliation/audit?sessionId=session" })).json();
    assert.equal(audit.repairs.length, 1); assert.equal(audit.repairs[0].confirmed, 0); assert.equal(audit.repairs[0].sourceSha256, input.sourceSha256);
    assert.equal((await app.inject({ method: "POST", url: "/api/usage/claude-reconciliation/repair/apply", payload: { ...body, approvedDigest: "e".repeat(64) } })).statusCode, 409);
    const events = logs.flatMap((line) => line.trim().split("\n").map((row) => JSON.parse(row))).filter((event) => event.event?.startsWith("claude_cost_acknowledgement_repair_"));
    assert.deepEqual(events.map((event) => event.event), ["claude_cost_acknowledgement_repair_approved", "claude_cost_acknowledgement_repair_rejected"]);
    assert.ok(events.every((event) => event.entryPoint === "http" && typeof event.requestId === "string"));
    assert.ok(events.every((event) => !event.evidence && !event.sourceSha256));
  } finally { await app.close(); db.close(); }
});

test("missing identities and revision-zero adjusted baselines stay fenced; old peers cannot apply", () => {
  const { db, snapshot, correct, evidence } = fixture();
  try {
    db.raw().exec("UPDATE runners SET protocol_version=209");
    assert.ok(previewClaudeReconciliation(db, principal, evidence(0)).rows.every((row) => row.status === "unresolved"));
    db.raw().exec("UPDATE runners SET protocol_version=210");
    correct(0);
    assert.equal(reconciliationSnapshotAvailable(db, { ...snapshot, costReconciliationRevision: 1 }), false);
    assert.equal(reconciliationSnapshotAvailable(db, { ...snapshot, costReconciliationRevision: 0, costReconciliationDeltaUsd: -0.004 }), false);
    observeReconciliationSnapshot(db, { ...snapshot, costReconciliationRevision: 0, costReconciliationDeltaUsd: -0.004 });
    observeReconciliationSnapshot(db, snapshot);
    assert.equal(reconciliationSnapshotAvailable(db, snapshot), false);
  } finally { db.close(); }
});

test("verified repair can clear an old corrupt observation after the runner returns to a sane lower coordinate", () => {
  const { db, snapshot } = fixture();
  try {
    observeReconciliationSnapshot(db, { ...snapshot, costReconciliationRevision: Number.MAX_SAFE_INTEGER, costReconciliationDeltaUsd: 0 });
    observeReconciliationSnapshot(db, snapshot);
    assert.equal(observedReconciliationRevision(db, "session"), Number.MAX_SAFE_INTEGER);
    const input = repairEvidence(db, snapshot);
    const preview = previewClaudeAcknowledgementRepair(db, principal, input);
    assert.equal(preview.repairable, true, preview.unresolved.join(","));
    applyClaudeAcknowledgementRepair(db, principal, input, preview.digest);
    const frame = acknowledgementRepairFrame(db, "session")!;
    assert.equal(frame.costReconciliationRepair!.expected.revision, 0);
    observeReconciliationSnapshot(db, { ...snapshot, costReconciliationDeltaUsd: 0, costReconciliationRepairId: preview.digest });
    assert.equal(observedReconciliationRevision(db, "session"), 0);
    assert.equal(reconciliationSnapshotAvailable(db, { ...snapshot, costReconciliationDeltaUsd: 0, costReconciliationRepairId: preview.digest }), true);
  } finally { db.close(); }
});

test("an unconfirmed repair invalidated by concurrent usage can be superseded by a fresh verified preview", () => {
  const { db, snapshot, now } = fixture();
  try {
    const corrupt = { ...snapshot, costReconciliationRevision: Number.MAX_SAFE_INTEGER, costReconciliationDeltaUsd: 0 };
    observeReconciliationSnapshot(db, corrupt);
    const first = repairEvidence(db, corrupt), firstPreview = previewClaudeAcknowledgementRepair(db, principal, first);
    applyClaudeAcknowledgementRepair(db, principal, first, firstPreview.digest);
    db.appendEvent("session", { kind: "token_usage", model: "claude-test", costUsd: 0.001, inputTokens: 1 }, now + 5, { accrueUsage: true, runnerSeq: 5, historyEpoch: 1 });
    assert.equal(acknowledgementRepairFrame(db, "session"), null);
    const current = { ...corrupt, costUsd: db.sessionCostUsd("session"), tokensIn: 41, seq: 5 };
    const second = repairEvidence(db, current), secondPreview = previewClaudeAcknowledgementRepair(db, principal, second);
    assert.equal(secondPreview.repairable, true, secondPreview.unresolved.join(","));
    applyClaudeAcknowledgementRepair(db, principal, second, secondPreview.digest);
    assert.notEqual(secondPreview.digest, firstPreview.digest);
    assert.throws(() => applyClaudeAcknowledgementRepair(db, principal, first, firstPreview.digest), /superseded/);
    observeReconciliationSnapshot(db, { ...current, costReconciliationRevision: 0, costReconciliationRepairId: firstPreview.digest });
    assert.equal(observedReconciliationRevision(db, "session"), Number.MAX_SAFE_INTEGER);
    const repaired = { ...current, costReconciliationRevision: 0, costReconciliationRepairId: secondPreview.digest };
    observeReconciliationSnapshot(db, repaired);
    assert.equal(reconciliationSnapshotAvailable(db, repaired), true);
    assert.equal(db.sessionCostUsd("session"), current.costUsd);
  } finally { db.close(); }
});
