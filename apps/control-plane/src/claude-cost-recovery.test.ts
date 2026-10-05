import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import Fastify from "fastify";
import { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";
import type { SessionSnapshot } from "@wollipog/protocol";
import { registerUsageRoutes } from "./usage-routes.js";
import { applyClaudeReconciliation, previewClaudeReconciliation, exportClaudeReconciliations,
  applyClaudeReconciliationRecovery, previewClaudeReconciliationRecovery, reconciliationDeltaUsd,
  normalizeReconciledSnapshot, observeReconciliationRevision } from "./claude-cost-reconciliation.js";

const principal: HumanPrincipal = { kind: "human", actorId: "owner", userId: "owner", userName: "Owner",
  organizationId: "org_personal", organizationName: "Personal", role: "owner", deviceId: "device", localBootstrap: false };

function fixture(firstPico = 10_000_600_000, endPico = 20_001_200_000) {
  const db = ControlPlaneDb.open(":memory:");
  const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  db.registerRunner({ runnerId: "runner", hostname: "host", os: "linux", version: "test", agents: [], workspaces: [] }, now, 199);
  db.createSession({ id: "session", runnerId: "runner", workspaceId: null, agentId: "claude", driver: "claude-code",
    title: "Fixture", useWorktree: false, config: { model: "claude-test" }, now });
  const first = db.appendEvent("session", { kind: "token_usage", model: "claude-test", inputTokens: 100, costUsd: firstPico / 1e12 }, now,
    { accrueUsage: true, runnerSeq: 1, historyEpoch: 1 });
  const firstMicro = Number(db.raw().prepare("SELECT cost_microusd FROM usage_cost_receipts WHERE event_id=?").get(first.id)?.cost_microusd);
  const firstRemainder = firstPico - firstMicro * 1e6;
  const second = db.appendEvent("session", { kind: "token_usage", model: "claude-test", inputTokens: 200, costUsd: endPico / 1e12 }, now + 3_600_000,
    { accrueUsage: true, runnerSeq: 2, historyEpoch: 1 });
  const secondMicro = Number(db.raw().prepare("SELECT cost_microusd FROM usage_cost_receipts WHERE event_id=?").get(second.id)?.cost_microusd);
  const evidence = { sessionId: "session", eventEpoch: 0, historyEpoch: 1, importAuthorized: true, sourceSha256: "a".repeat(64), records: [
    { eventId: first.id, conversation: "b".repeat(64), process: "c".repeat(64), boundary: "origin", startUsd: 0, endUsd: firstPico / 1e12,
      model: "claude-test", scope: "query-tree", rounding: { originalMicro: firstMicro, beforePicousd: 0, afterPicousd: firstRemainder } },
    { eventId: second.id, conversation: "b".repeat(64), process: "d".repeat(64), boundary: "resume", startUsd: firstPico / 1e12, endUsd: endPico / 1e12,
      model: "claude-test", scope: "query-tree", rounding: { originalMicro: secondMicro, beforePicousd: firstRemainder, afterPicousd: firstPico + endPico - (firstMicro + secondMicro) * 1e6 } },
  ] };
  return { db, evidence, now, first, second };
}

function ledgerPico(db: ControlPlaneDb): number {
  const row = db.raw().prepare("SELECT cost_microusd, cost_remainder_picousd FROM usage_session_state WHERE session_id='session'").get()!;
  return Number(row.cost_microusd) * 1e6 + Number(row.cost_remainder_picousd);
}
function backup(db: ControlPlaneDb, path: string) { db.raw().prepare("VACUUM INTO ?").run(path); }
function recovery(db: ControlPlaneDb) { return { ...exportClaudeReconciliations(db, principal, "session"), importAuthorized: true, sourceSha256: "f".repeat(64) }; }
function snapshot(now: number, costUsd: number, revision?: number): SessionSnapshot {
  return { id: "session", agentId: "claude", workspaceId: null, driver: "claude-code", title: "Fixture", status: "idle", config: {},
    useWorktree: false, worktreePath: null, preview: null, pendingApproval: null, tokensIn: 300, tokensOut: 0, costUsd,
    seq: 2, historyEpoch: 1, createdAt: now, updatedAt: now, ...(revision === undefined ? {} : { costReconciliationRevision: revision }) };
}

test("fractional carry correction preserves unrelated contributions, rollups, exact cost and audit", () => {
  const { db, evidence, now } = fixture();
  try {
    db.createSession({ id: "parent", runnerId: "runner", workspaceId: null, agentId: "claude", driver: "claude-code", title: "Parent", useWorktree: false, config: {}, now });
    db.raw().exec("UPDATE sessions SET parent_session_id='parent', usage_peak_cost_usd=cost_usd, status='completed' WHERE id='session'");
    const extra = db.appendEvent("session", { kind: "token_usage", model: "other-model", costUsd: 0.0030007 }, now + 2 * 3_600_000,
      { accrueUsage: true, runnerSeq: 3, historyEpoch: 1 });
    const beforeOther = db.raw().prepare("SELECT * FROM usage_session_models WHERE model='other-model'").get();
    const priorCharge = Number(db.raw().prepare("SELECT parent_charged_cost_usd AS charge FROM sessions WHERE id='session'").get()?.charge);
    db.maintainUsageAggregation(now + 31 * 86_400_000);
    const preview = previewClaudeReconciliation(db, principal, evidence);
    assert.equal(preview.rows.filter((r) => r.status === "correctable").length, 2);
    assert.equal(preview.deltaUsd, -0.0100006);
    const result = applyClaudeReconciliation(db, principal, evidence, preview.digest);
    assert.equal(result.revision, 1);
    assert.equal(ledgerPico(db), 23_001_900_000);
    assert.ok(Math.abs(db.sessionCostUsd("session") - 0.0230019) < 1e-12);
    assert.equal(db.raw().prepare("SELECT SUM(cost_microusd) AS total FROM usage_daily").get()?.total, 23_002);
    assert.deepEqual(db.raw().prepare("SELECT * FROM usage_session_models WHERE model='other-model'").get(), beforeOther);
    assert.equal(db.raw().prepare("SELECT cost_microusd FROM usage_cost_receipts WHERE event_id=?").get(extra.id)?.cost_microusd, 3_001);
    assert.equal(reconciliationDeltaUsd(db, "session"), -0.0100006);
    assert.equal(normalizeReconciledSnapshot(db, snapshot(now, 0.0330025)).costUsd, 0.0230019);
    assert.equal(normalizeReconciledSnapshot(db, snapshot(now, 0.0230019, 1)).costUsd, 0.0230019);
    assert.equal(applyClaudeReconciliation(db, principal, evidence, preview.digest).applied, false);
    assert.ok(Math.abs(Number(db.raw().prepare("SELECT parent_charged_cost_usd AS charge FROM sessions WHERE id='session'").get()?.charge) - Math.max(priorCharge - 0.0100006, 0.0230019)) < 1e-12);
    db.appendEvent("session", { kind: "token_usage", model: "other-model", costUsd: 0.0000006 }, now + 3 * 3_600_000, { accrueUsage: true, runnerSeq: 4, historyEpoch: 1 });
    assert.equal(ledgerPico(db), 23_002_500_000);
  } finally { db.close(); }
});

test("fractional query-tree allocation supports multiple models and authorized old carry receipts", () => {
  const { db, evidence } = fixture();
  try {
    const input = { ...evidence, records: evidence.records.map((record, i) => ({ ...record,
      attribution: JSON.parse(String(db.raw().prepare("SELECT attribution_json FROM usage_cost_receipts WHERE event_id=?").get(record.eventId)?.attribution_json)),
      startByModelUsd: i === 0 ? {} : { "model-one": 0.0060003, "model-two": 0.0040003 },
      endByModelUsd: i === 0 ? { "model-one": 0.0060003, "model-two": 0.0040003 } : { "model-one": 0.0120006, "model-two": 0.0080006 } })) };
    db.raw().exec("DELETE FROM usage_cost_receipts");
    const preview = previewClaudeReconciliation(db, principal, input);
    applyClaudeReconciliation(db, principal, input, preview.digest);
    assert.equal(ledgerPico(db), 20_001_200_000);
    assert.equal(db.raw().prepare("SELECT SUM(cost_microusd) AS total FROM usage_session_models").get()?.total, 20_001);
    assert.equal(db.sessionUsageByModel("session").byModel.find((row) => row.model === "claude-test")?.inputTokens, 300);
    assert.equal(db.sessionUsageByModel("session").byModel.find((row) => row.model === "claude-test")?.costUsd, 0);
  } finally { db.close(); }
});

for (const fault of ["missing", "wrong-carry", "wrong-allocation", "discontinuous", "prefix", "unknown-field", "pruned"]) test(`fractional evidence rejects unsupported proof: ${fault}`, () => {
  const { db, evidence, now } = fixture();
  try {
    const input: any = structuredClone(evidence);
    if (fault === "missing") delete input.records[0].rounding;
    if (fault === "wrong-carry") input.records[0].rounding.afterPicousd++;
    if (fault === "wrong-allocation") input.records[0].rounding.originalMicro++;
    if (fault === "discontinuous") input.records[1].rounding.beforePicousd++;
    if (fault === "prefix") input.records[1].startUsd += 1e-7;
    if (fault === "unknown-field") input.records[0].rounding.prompt = "forbidden";
    if (fault === "pruned") db.maintainUsageAggregation(now + 366 * 86_400_000);
    if (fault === "unknown-field") assert.throws(() => previewClaudeReconciliation(db, principal, input), /fields/);
    else {
      const preview = previewClaudeReconciliation(db, principal, input);
      assert.ok(preview.rows.some((r) => r.status === "unresolved"));
      if (fault === "missing" || fault === "wrong-carry" || fault === "wrong-allocation" || fault === "pruned") assert.equal(preview.deltaUsd, 0);
    }
    assert.equal(ledgerPico(db), 30_001_800_000);
  } finally { db.close(); }
});

test("generated fractional corrections conserve provider cost and never move unrelated ledger units", () => {
  fc.assert(fc.property(fc.integer({ min: 5_000_000, max: 1_000_000_000 }), fc.integer({ min: 1, max: 1_000_000_000 }),
    fc.integer({ min: 5_000_000, max: 1_000_000_000 }), (prefix, work, unrelated) => {
      const end = prefix + work;
      const { db, evidence, now } = fixture(prefix, end);
      try {
        db.appendEvent("session", { kind: "token_usage", model: "other-model", costUsd: unrelated / 1e12 }, now + 2 * 3_600_000,
          { accrueUsage: true, runnerSeq: 3, historyEpoch: 1 });
        const other = db.raw().prepare("SELECT * FROM usage_session_models WHERE model='other-model'").get();
        const before = db.raw().prepare("SELECT payload FROM session_events ORDER BY seq").all();
        const preview = previewClaudeReconciliation(db, principal, evidence);
        assert.ok(preview.rows.every((r) => r.status === "correctable"));
        applyClaudeReconciliation(db, principal, evidence, preview.digest);
        assert.equal(ledgerPico(db), end + unrelated, "exact cost counts the inherited prefix only once");
        assert.deepEqual(db.raw().prepare("SELECT * FROM usage_session_models WHERE model='other-model'").get(), other);
        assert.deepEqual(db.raw().prepare("SELECT payload FROM session_events ORDER BY seq").all(), before);
        const state = db.raw().prepare("SELECT cost_microusd FROM usage_session_state WHERE session_id='session'").get();
        assert.equal(db.raw().prepare("SELECT SUM(cost_microusd) AS n FROM usage_session_models").get()?.n, state?.cost_microusd);
        assert.equal(db.raw().prepare("SELECT SUM(cost_microusd) AS n FROM usage_hourly").get()?.n, state?.cost_microusd);
        applyClaudeReconciliation(db, principal, evidence, preview.digest);
        assert.equal(ledgerPico(db), end + unrelated, "retry cannot repeat the correction");
      } finally { db.close(); }
    }), { numRuns: 100, seed: 26492650, examples: [[5_000_000, 499_999, 5_500_000], [5_500_000, 500_000, 5_499_999]] });
});

test("verified restore recovery preserves later usage, is read-only in preview and survives reopen and retries", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-cost-restore-"));
  const path = join(dir, "backup.sqlite");
  const { db, evidence, now } = fixture();
  let restored: ControlPlaneDb | undefined;
  try {
    backup(db, path);
    applyClaudeReconciliation(db, principal, evidence, previewClaudeReconciliation(db, principal, evidence).digest);
    const input = recovery(db);
    restored = ControlPlaneDb.open(path);
    observeReconciliationRevision(restored, "session", 1);
    const changes = restored.raw().prepare("SELECT total_changes() AS n").get()?.n;
    observeReconciliationRevision(restored, "session", 1);
    observeReconciliationRevision(restored, "session", 0);
    assert.equal(restored.raw().prepare("SELECT total_changes() AS n").get()?.n, changes, "unchanged/stale acknowledgement publication is read-only");
    assert.throws(() => normalizeReconciledSnapshot(restored!, snapshot(now, 0.0200012, 1)), /revision/);
    const ordinary = previewClaudeReconciliation(restored, principal, evidence);
    assert.equal(ordinary.deltaUsd, 0);
    assert.ok(ordinary.rows.every((row) => row.status === "unresolved"));
    restored.appendEvent("session", { kind: "token_usage", model: "new-model", costUsd: 0.0030003 }, now + 2 * 3_600_000,
      { accrueUsage: true, runnerSeq: 3, historyEpoch: 1 });
    const before = restored.raw().prepare("SELECT * FROM usage_session_state").all();
    const preview = previewClaudeReconciliationRecovery(restored, principal, input);
    assert.equal(preview.recoverable, true);
    assert.equal(preview.runnerAcknowledgedRevision, 1);
    assert.deepEqual(preview.recoveredRevisions, [1]);
    assert.deepEqual(restored.raw().prepare("SELECT * FROM usage_session_state").all(), before);
    assert.equal(restored.raw().prepare("SELECT COUNT(*) AS n FROM usage_cost_reconciliations").get()?.n, 0);
    const result = applyClaudeReconciliationRecovery(restored, principal, input, preview.digest);
    assert.equal(result.revision, 1);
    const audit = restored.raw().prepare("SELECT delta_microusd, result_json FROM usage_cost_reconciliations").get()!;
    assert.equal(audit.delta_microusd, -10001, "the original correction identity/delta is retained");
    assert.equal(JSON.parse(String(audit.result_json)).correction.deltaMicrousd, -10000, "new usage can change the integer allocation without changing the exact correction");
    assert.equal(ledgerPico(restored), 23_001_500_000);
    const acknowledged = snapshot(now, 0.0230015, 1);
    assert.equal(normalizeReconciledSnapshot(restored, acknowledged).costUsd, acknowledged.costUsd);
    assert.equal(normalizeReconciledSnapshot(restored, { ...acknowledged, costUsd: 0.0330021, costReconciliationRevision: 0 }).costUsd, 0.0230015);
    restored.close(); restored = ControlPlaneDb.open(path);
    assert.equal(applyClaudeReconciliationRecovery(restored, principal, input, preview.digest).applied, false);
    assert.equal(ledgerPico(restored), 23_001_500_000);
    assert.equal(restored.raw().prepare("SELECT COUNT(*) AS n FROM usage_cost_reconciliation_recoveries").get()?.n, 1);
  } finally { restored?.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("restore recovery handles a full or partial multi-revision backup atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-cost-chain-"));
  const { db, evidence, now } = fixture(10_000_000_000, 20_000_000_000);
  try {
    const third = db.appendEvent("session", { kind: "token_usage", model: "claude-test", costUsd: 0.004 }, now + 2 * 3_600_000, { accrueUsage: true, runnerSeq: 3, historyEpoch: 1 });
    const fourth = db.appendEvent("session", { kind: "token_usage", model: "claude-test", costUsd: 0.006 }, now + 3 * 3_600_000, { accrueUsage: true, runnerSeq: 4, historyEpoch: 1 });
    const all = join(dir, "all.sqlite"), partial = join(dir, "partial.sqlite");
    backup(db, all);
    applyClaudeReconciliation(db, principal, evidence, previewClaudeReconciliation(db, principal, evidence).digest);
    backup(db, partial);
    const later = { ...evidence, records: [
      { eventId: third.id, conversation: "e".repeat(64), process: "f".repeat(64), boundary: "origin", startUsd: 0, endUsd: 0.004, model: "claude-test", scope: "query-tree" },
      { eventId: fourth.id, conversation: "e".repeat(64), process: "1".repeat(64), boundary: "resume", startUsd: 0.004, endUsd: 0.006, model: "claude-test", scope: "query-tree" } ] };
    applyClaudeReconciliation(db, principal, later, previewClaudeReconciliation(db, principal, later).digest);
    const input = recovery(db);
    for (const path of [all, partial]) {
      const restored = ControlPlaneDb.open(path);
      try {
        const preview = previewClaudeReconciliationRecovery(restored, principal, input);
        assert.equal(preview.recoverable, true);
        assert.deepEqual(preview.recoveredRevisions, path === all ? [1, 2] : [2]);
        restored.raw().exec("CREATE TRIGGER interrupt_restore BEFORE INSERT ON usage_cost_reconciliation_recoveries BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
        assert.throws(() => applyClaudeReconciliationRecovery(restored, principal, input, preview.digest), /interrupted/);
        assert.equal(restored.raw().prepare("SELECT COUNT(*) AS n FROM usage_cost_reconciliations").get()?.n, path === all ? 0 : 1);
        restored.raw().exec("DROP TRIGGER interrupt_restore");
        applyClaudeReconciliationRecovery(restored, principal, input, preview.digest);
        assert.equal(restored.sessionCostUsd("session"), 0.026);
        assert.equal(reconciliationDeltaUsd(restored, "session"), -0.014);
        assert.equal(restored.raw().prepare("SELECT COUNT(*) AS n FROM usage_cost_reconciled_events").get()?.n, 4);
      } finally { restored.close(); }
    }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const fault of ["delta", "identity", "checkpoint", "missing-event", "unsupported-runner", "unproven-new-usage", "scope", "extra-field"]) test(`restore recovery refuses incomplete or conflicting evidence: ${fault}`, () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-cost-refusal-"));
  const path = join(dir, "backup.sqlite");
  const { db, evidence, now, second } = fixture();
  let restored: ControlPlaneDb | undefined;
  try {
    backup(db, path);
    applyClaudeReconciliation(db, principal, evidence, previewClaudeReconciliation(db, principal, evidence).digest);
    const input: any = recovery(db);
    restored = ControlPlaneDb.open(path);
    if (fault === "delta") input.revisions[0].deltaMicrousd--;
    if (fault === "identity") input.revisions[0].eventIds.pop();
    if (fault === "checkpoint") input.revisions[0].beforeLedger.costMicrousd++;
    if (fault === "missing-event") restored.raw().prepare("DELETE FROM session_events WHERE id=?").run(second.id);
    if (fault === "unsupported-runner") restored.raw().exec("UPDATE runners SET protocol_version=198");
    if (fault === "unproven-new-usage") restored.appendEvent("session", { kind: "token_usage", model: "claude-test", costUsd: 0.003, costIsEstimate: true }, now + 2 * 3_600_000, { accrueUsage: true, runnerSeq: 3, historyEpoch: 1 });
    if (fault === "scope") input.historyEpoch++;
    if (fault === "extra-field") input.prompt = "forbidden";
    const before = ledgerPico(restored);
    if (fault === "scope" || fault === "extra-field") assert.throws(() => previewClaudeReconciliationRecovery(restored!, principal, input));
    else {
      const preview = previewClaudeReconciliationRecovery(restored, principal, input);
      assert.equal(preview.recoverable, false);
      assert.throws(() => applyClaudeReconciliationRecovery(restored!, principal, input, preview.digest), /unresolved/);
    }
    assert.equal(ledgerPico(restored), before);
    assert.equal(restored.raw().prepare("SELECT COUNT(*) AS n FROM usage_cost_reconciliations").get()?.n, 0);
  } finally { restored?.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("loss of audit rows alone cannot make an already-corrected ledger recoverable", () => {
  const { db, evidence, now } = fixture();
  try {
    applyClaudeReconciliation(db, principal, evidence, previewClaudeReconciliation(db, principal, evidence).digest);
    const input = recovery(db);
    db.raw().exec("DELETE FROM usage_cost_reconciliations");
    for (let i = 0; i < 3; i++) db.appendEvent("session", { kind: "token_usage", model: "claude-test", costUsd: 0.05 }, now + (i + 2) * 3_600_000, { accrueUsage: true, runnerSeq: i + 3, historyEpoch: 1 });
    const before = ledgerPico(db);
    const preview = previewClaudeReconciliationRecovery(db, principal, input);
    assert.equal(preview.recoverable, false);
    assert.match(preview.unresolved[0]!.reason, /checkpoint/);
    assert.throws(() => applyClaudeReconciliationRecovery(db, principal, input, preview.digest));
    assert.equal(ledgerPico(db), before);
  } finally { db.close(); }
});

test("restore endpoints enforce exact approval, preserve committed results and expose audit with structured telemetry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-cost-http-"));
  const path = join(dir, "backup.sqlite");
  const { db, evidence, now } = fixture();
  let restored: ControlPlaneDb | undefined;
  const logs: Array<Record<string, unknown>> = [];
  const app = Fastify({ logger: { level: "info", stream: { write: (line: string) => { logs.push(JSON.parse(line)); } } } });
  let caller = principal;
  const sent: unknown[] = [];
  try {
    backup(db, path);
    applyClaudeReconciliation(db, principal, evidence, previewClaudeReconciliation(db, principal, evidence).digest);
    const input = recovery(db);
    restored = ControlPlaneDb.open(path);
    registerUsageRoutes(app, restored, () => caller, { requestFromRunner: async () => { throw new Error("not used"); },
      sendToRunner: (_runner, message) => { sent.push(message); throw new Error("disconnected"); } });
    caller = { ...principal, role: "viewer" };
    assert.equal((await app.inject({ method: "POST", url: "/api/usage/claude-reconciliation/recovery/preview", payload: input })).statusCode, 403);
    caller = principal;
    const preview = (await app.inject({ method: "POST", url: "/api/usage/claude-reconciliation/recovery/preview", payload: input })).json();
    assert.equal(preview.recoverable, true);
    assert.equal((await app.inject({ method: "POST", url: "/api/usage/claude-reconciliation/recovery/apply", payload: { evidence: input, approvedDigest: preview.digest } })).statusCode, 400);
    restored.appendEvent("session", { kind: "token_usage", model: "claude-test", costUsd: 0.003 }, now + 2 * 3_600_000, { accrueUsage: true, runnerSeq: 3, historyEpoch: 1 });
    assert.equal((await app.inject({ method: "POST", url: "/api/usage/claude-reconciliation/recovery/apply", payload: { evidence: input, approvedDigest: preview.digest, approved: true } })).statusCode, 409);
    const fresh = (await app.inject({ method: "POST", url: "/api/usage/claude-reconciliation/recovery/preview", payload: input })).json();
    const payload = { evidence: input, approvedDigest: fresh.digest, approved: true };
    const applied = await app.inject({ method: "POST", url: "/api/usage/claude-reconciliation/recovery/apply", payload });
    assert.equal(applied.statusCode, 200);
    assert.equal(applied.json().synchronized, false);
    assert.equal(applied.json().revision, 1);
    const retry = await app.inject({ method: "POST", url: "/api/usage/claude-reconciliation/recovery/apply", payload });
    assert.equal(retry.json().applied, false);
    assert.equal(sent.length, 2);
    const commits = logs.filter((entry) => entry.event === "claude_cost_reconciliation_recovery_applied");
    assert.equal(commits.length, 2);
    assert.ok(commits.every((entry) => entry.entryPoint === "http" && typeof entry.requestId === "string" && entry.revision === 1 && entry.synchronized === false));
    assert.ok(logs.some((entry) => entry.event === "claude_cost_reconciliation_recovery_rejected"));
    assert.ok(commits.every((entry) => !Object.hasOwn(entry, "evidence") && !Object.hasOwn(entry, "actorId")));
    const exported = await app.inject({ method: "GET", url: "/api/usage/claude-reconciliation/export?sessionId=session" });
    assert.equal(exported.statusCode, 200);
    assert.equal(exported.json().revisions[0].digest, input.revisions[0]!.digest);
    const audit = await app.inject({ method: "GET", url: "/api/usage/claude-reconciliation/audit?sessionId=session" });
    assert.equal(audit.statusCode, 200);
    assert.equal(audit.json().recoveries.length, 1);
    assert.equal(audit.json().reconciliations[0].deltaRemainderPicousd, input.revisions[0]!.deltaRemainderPicousd);
  } finally { await app.close(); restored?.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a newly observed higher acknowledgement invalidates recovery approval and stale snapshots cannot bypass the fence", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-cost-observation-"));
  const path = join(dir, "backup.sqlite");
  const { db, evidence, now } = fixture();
  let restored: ControlPlaneDb | undefined;
  try {
    backup(db, path);
    applyClaudeReconciliation(db, principal, evidence, previewClaudeReconciliation(db, principal, evidence).digest);
    const input = recovery(db);
    restored = ControlPlaneDb.open(path);
    observeReconciliationRevision(restored, "session", 1);
    const preview = previewClaudeReconciliationRecovery(restored, principal, input);
    observeReconciliationRevision(restored, "session", 2);
    observeReconciliationRevision(restored, "session", 1);
    assert.throws(() => applyClaudeReconciliationRecovery(restored!, principal, input, preview.digest), /changed/);
    const fresh = previewClaudeReconciliationRecovery(restored, principal, input);
    assert.equal(fresh.runnerAcknowledgedRevision, 2);
    assert.equal(fresh.recoverable, false);
    assert.match(fresh.unresolved[0]!.reason, /acknowledged revision/);
    assert.throws(() => normalizeReconciledSnapshot(restored!, snapshot(now, 0.0300018)), /revision/);
    assert.equal(ledgerPico(restored), 30_001_800_000);
  } finally { restored?.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});
