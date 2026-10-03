import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";
import { previewClaudeReconciliation, applyClaudeReconciliation, normalizeReconciledSnapshot } from "./claude-cost-reconciliation.js";
import type { SessionSnapshot } from "@wollipog/protocol";
import Fastify from "fastify";
import { registerUsageRoutes } from "./usage-routes.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const principal: HumanPrincipal = {
  kind: "human", actorId: "owner", userId: "owner", userName: "Owner",
  organizationId: "org_personal", organizationName: "Personal", role: "owner",
  deviceId: "device", localBootstrap: false,
};

function fixture(path = ":memory:") {
  const db = ControlPlaneDb.open(path);
  db.registerRunner({ runnerId: "runner", hostname: "host", os: "linux", version: "test", agents: [], workspaces: [] }, Date.now(), 198);
  const now = Date.now();
  db.createSession({ id: "session", runnerId: "runner", workspaceId: null, agentId: "claude",
    driver: "claude-code", title: "Fixture", useWorktree: false, config: { model: "claude-test" }, now });
  const first = db.appendEvent("session", { kind: "token_usage", model: "claude-test", inputTokens: 100, outputTokens: 10, costUsd: 0.01 }, now, { accrueUsage: true, runnerSeq: 1, historyEpoch: 1 });
  const second = db.appendEvent("session", { kind: "token_usage", model: "claude-test", inputTokens: 200, outputTokens: 20, costUsd: 0.02 }, now + 1, { accrueUsage: true, runnerSeq: 2, historyEpoch: 1 });
  const evidence = { sessionId: "session", eventEpoch: 0, historyEpoch: 1,
    importAuthorized: true, sourceSha256: "a".repeat(64),
    records: [
      { eventId: first.id, conversation: "b".repeat(64), process: "c".repeat(64), boundary: "origin", startUsd: 0, endUsd: 0.01, model: "claude-test", scope: "query-tree" },
      { eventId: second.id, conversation: "b".repeat(64), process: "d".repeat(64), boundary: "resume", startUsd: 0.01, endUsd: 0.02, model: "claude-test", scope: "query-tree" },
    ],
  };
  return { db, now, first, second, evidence };
}

test("Claude reconciliation previews and corrects a verified restored prefix exactly once", () => {
  const { db, evidence } = fixture();
  try {
    const before = db.sessionUsageByModel("session");
    const preview = previewClaudeReconciliation(db, principal, evidence);
    assert.equal(preview.originalUsd, 0.03);
    assert.equal(preview.proposedUsd, 0.02);
    assert.equal(db.sessionCostUsd("session"), 0.03, "preview must not mutate totals");
    const result = applyClaudeReconciliation(db, principal, evidence, preview.digest);
    assert.equal(result.applied, true);
    assert.equal(db.sessionCostUsd("session"), 0.02);
    assert.equal(db.sessionUsageByModel("session").totals.costUsd, 0.02);
    assert.equal(db.sessionUsageByModel("session").totals.inputTokens, before.totals.inputTokens);
    assert.equal(db.raw().prepare("SELECT covered_through_seq AS seq FROM usage_session_state").get()?.seq, 2);
    assert.equal(db.raw().prepare("SELECT SUM(cost_microusd) AS cost FROM usage_hourly").get()?.cost, 20_000);
    assert.equal(db.raw().prepare("SELECT SUM(provider_reported_records) AS n FROM usage_hourly").get()?.n, 0);
    assert.equal(applyClaudeReconciliation(db, principal, evidence, preview.digest).applied, false);
    assert.equal(db.sessionCostUsd("session"), 0.02);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM usage_cost_reconciliations").get()?.n, 1);
    assert.deepEqual(db.raw().prepare("SELECT payload FROM session_events WHERE session_id='session' ORDER BY seq").all().map((event) => JSON.parse(String(event.payload))), [
      { kind: "token_usage", model: "claude-test", inputTokens: 100, outputTokens: 10, costUsd: 0.01 },
      { kind: "token_usage", model: "claude-test", inputTokens: 200, outputTokens: 20, costUsd: 0.02 },
    ], "original accounting events are immutable");
  } finally { db.close(); }
});

test("reconciliation uses retained daily receipts and survives reopen and interrupted retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-reconciliation-"));
  const path = join(dir, "accounting.sqlite");
  const { db, now, evidence } = fixture(path);
  let opened = db;
  try {
    db.maintainUsageAggregation(now + 31 * 86_400_000);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM usage_hourly").get()?.n, 0);
    const preview = previewClaudeReconciliation(db, principal, evidence);
    applyClaudeReconciliation(db, principal, evidence, preview.digest);
    assert.equal(db.raw().prepare("SELECT SUM(cost_microusd) AS cost FROM usage_daily").get()?.cost, 20_000);
    db.close();
    opened = ControlPlaneDb.open(path);
    assert.equal(opened.sessionCostUsd("session"), 0.02);
    assert.equal(applyClaudeReconciliation(opened, principal, evidence, preview.digest).applied, false);
    assert.equal(opened.raw().prepare("SELECT covered_through_seq AS seq FROM usage_session_state").get()?.seq, 2);
  } finally { opened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("complete per-model checkpoints move cost while preserving original token attribution", () => {
  const { db, evidence } = fixture();
  try {
    const records = [
      { ...evidence.records[0]!, startByModelUsd: {}, endByModelUsd: { "model-one": 0.006, "model-two": 0.004 } },
      { ...evidence.records[1]!, startByModelUsd: { "model-one": 0.006, "model-two": 0.004 }, endByModelUsd: { "model-one": 0.013, "model-two": 0.007 } },
    ];
    const input = { ...evidence, records };
    const preview = previewClaudeReconciliation(db, principal, input);
    applyClaudeReconciliation(db, principal, input, preview.digest);
    const models = db.sessionUsageByModel("session").byModel;
    assert.equal(models.find((m) => m.model === "model-one")?.costUsd, 0.013);
    assert.equal(models.find((m) => m.model === "model-two")?.costUsd, 0.007);
    assert.equal(models.find((m) => m.model === "claude-test")?.inputTokens, 300);
    assert.equal(models.find((m) => m.model === "claude-test")?.costUsd, 0);
    assert.equal(db.sessionCostUsd("session"), 0.02);
  } finally { db.close(); }
});

for (const scenario of ["missing-receipt", "ambiguous-prefix", "wrong-scope", "parent-included", "mixed-version", "stale-runner", "pruned"]) {
  test(`unsupported historical evidence stays unresolved: ${scenario}`, () => {
    const { db, evidence, second, now } = fixture();
    try {
      if (scenario === "missing-receipt") db.raw().exec("DELETE FROM usage_cost_receipts");
      if (scenario === "ambiguous-prefix") evidence.records[1]!.startUsd = 0.009;
      if (scenario === "wrong-scope") (evidence.records[1] as any).scope = "main-loop";
      if (scenario === "parent-included" || scenario === "mixed-version") {
        db.raw().prepare("UPDATE session_events SET payload=json_set(payload, ?, ?) WHERE id=?").run(
          scenario === "parent-included" ? "$.parentToolUseId" : "$.costIsEstimate", scenario === "parent-included" ? "parent" : 1, second.id);
      }
      if (scenario === "stale-runner") db.raw().exec("UPDATE runners SET protocol_version=197");
      if (scenario === "pruned") db.maintainUsageAggregation(now + 366 * 86_400_000);
      if (scenario === "wrong-scope") assert.throws(() => previewClaudeReconciliation(db, principal, evidence), /scope/);
      else {
        const preview = previewClaudeReconciliation(db, principal, evidence);
        assert.equal(preview.rows[1]?.status, "unresolved");
        assert.equal(preview.proposedUsd, 0.03);
        assert.ok(preview.unresolvedRecords > 0 || scenario === "mixed-version" || scenario === "parent-included");
      }
      assert.equal(db.sessionCostUsd("session"), 0.03);
    } finally { db.close(); }
  });
}

test("authorized accounting receipt import supports old records without importing content", () => {
  const { db, evidence } = fixture();
  try {
    const records = evidence.records.map((r) => ({ ...r, attribution: JSON.parse(String(db.raw().prepare("SELECT attribution_json FROM usage_cost_receipts WHERE event_id=?").get(r.eventId)?.attribution_json)) }));
    db.raw().exec("DELETE FROM usage_cost_receipts");
    const input = { ...evidence, records };
    assert.throws(() => previewClaudeReconciliation(db, principal, { ...input, importAuthorized: false }), /authorization/);
    assert.throws(() => previewClaudeReconciliation(db, principal, { ...input, prompt: "forbidden" }), /fields/);
    const preview = previewClaudeReconciliation(db, principal, input);
    assert.equal(preview.proposedUsd, 0.02);
    applyClaudeReconciliation(db, principal, input, preview.digest);
    assert.equal(db.sessionCostUsd("session"), 0.02);
  } finally { db.close(); }
});

test("correction rollback is atomic and a stale preview cannot change new usage", () => {
  const { db, evidence, now } = fixture();
  try {
    const preview = previewClaudeReconciliation(db, principal, evidence);
    db.raw().exec("CREATE TRIGGER fail_reconciliation BEFORE INSERT ON usage_cost_reconciled_events BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
    assert.throws(() => applyClaudeReconciliation(db, principal, evidence, preview.digest), /interrupted/);
    assert.equal(db.sessionCostUsd("session"), 0.03);
    assert.equal(db.raw().prepare("SELECT SUM(cost_microusd) AS cost FROM usage_hourly").get()?.cost, 30_000);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM usage_cost_reconciliations").get()?.n, 0);
    db.raw().exec("DROP TRIGGER fail_reconciliation");
    db.appendEvent("session", { kind: "token_usage", model: "claude-test", costUsd: 0.003, costIsEstimate: true }, now + 2, { accrueUsage: true, runnerSeq: 3, historyEpoch: 1 });
    assert.throws(() => applyClaudeReconciliation(db, principal, evidence, preview.digest), /preview changed/);
    const current = previewClaudeReconciliation(db, principal, evidence);
    applyClaudeReconciliation(db, principal, evidence, current.digest);
    assert.equal(db.sessionCostUsd("session"), 0.023);
  } finally { db.close(); }
});

test("old and acknowledged snapshots reconcile without resurrecting or subtracting the prefix twice", () => {
  const { db, evidence, now } = fixture();
  try {
    const preview = previewClaudeReconciliation(db, principal, evidence);
    applyClaudeReconciliation(db, principal, evidence, preview.digest);
    const snapshot: SessionSnapshot = { id: "session", agentId: "claude", workspaceId: null, driver: "claude-code",
      title: "Fixture", status: "idle", config: { model: "claude-test" }, useWorktree: false, worktreePath: null,
      preview: null, pendingApproval: null, tokensIn: 300, tokensOut: 30, costUsd: 0.03,
      seq: 2, historyEpoch: 1, createdAt: now, updatedAt: now };
    assert.equal(normalizeReconciledSnapshot(db, snapshot).costUsd, 0.02);
    db.updateSessionFromSnapshot("session", snapshot, now + 1);
    assert.equal(db.sessionCostUsd("session"), 0.02);
    db.updateSessionFromSnapshot("session", { ...snapshot, costUsd: 0.02, costReconciliationRevision: 1 }, now + 2);
    assert.equal(db.sessionCostUsd("session"), 0.02);
    assert.equal(db.raw().prepare("SELECT covered_through_seq AS seq FROM usage_session_state").get()?.seq, 2);
    db.raw().exec("UPDATE runners SET protocol_version=197");
    assert.throws(() => db.updateSessionFromSnapshot("session", snapshot, now + 3), /revision-aware runner/);
    assert.equal(db.sessionCostUsd("session"), 0.02);
  } finally { db.close(); }
});

test("historical correction releases the proven child peak but preserves live reservations", () => {
  const { db, evidence, now } = fixture();
  try {
    db.createSession({ id: "parent", runnerId: "runner", workspaceId: null, agentId: "claude", driver: "claude-code", title: "Parent", useWorktree: false, config: {}, now });
    db.createSession({ id: "grandparent", runnerId: "runner", workspaceId: null, agentId: "claude", driver: "claude-code", title: "Grandparent", useWorktree: false, config: {}, now });
    db.raw().exec("UPDATE sessions SET parent_session_id='parent', parent_reserved_cost_usd=0.1, parent_charged_cost_usd=0.03, usage_peak_cost_usd=0.03, status='completed' WHERE id='session'");
    db.raw().exec("UPDATE sessions SET child_cost_reserved_usd=0.03 WHERE id='parent'");
    db.raw().exec("UPDATE sessions SET parent_session_id='grandparent', parent_charged_cost_usd=0.03, status='completed' WHERE id='parent'");
    db.raw().exec("UPDATE sessions SET child_cost_reserved_usd=0.03 WHERE id='grandparent'");
    const preview = previewClaudeReconciliation(db, principal, evidence);
    applyClaudeReconciliation(db, principal, evidence, preview.digest);
    const child = db.raw().prepare("SELECT usage_peak_cost_usd AS peak, parent_charged_cost_usd AS charge FROM sessions WHERE id='session'").get();
    assert.equal(child?.peak, 0.02);
    assert.equal(child?.charge, 0.02);
    assert.ok(Math.abs(Number(db.raw().prepare("SELECT child_cost_reserved_usd AS cost FROM sessions WHERE id='parent'").get()?.cost) - 0.02) < 1e-12);
    assert.ok(Math.abs(Number(db.raw().prepare("SELECT child_cost_reserved_usd AS cost FROM sessions WHERE id='grandparent'").get()?.cost) - 0.02) < 1e-12);
    db.raw().exec("UPDATE sessions SET status='running' WHERE id='session'");
    assert.equal(db.raw().prepare("SELECT parent_charged_cost_usd AS charge FROM sessions WHERE id='session'").get()?.charge, 0.1);
    assert.ok(Math.abs(Number(db.raw().prepare("SELECT child_cost_reserved_usd AS cost FROM sessions WHERE id='grandparent'").get()?.cost) - 0.1) < 1e-12);
  } finally { db.close(); }
});

test("reconciliation endpoints enforce human administration and exact explicit approval", async () => {
  const { db, evidence } = fixture();
  const app = Fastify();
  const sent: unknown[] = [];
  registerUsageRoutes(app, db, (request) => request.headers.authorization === "owner" ? principal :
    request.headers.authorization === "foreign" ? { ...principal, organizationId: "foreign" } :
    request.headers.authorization === "viewer" ? { ...principal, role: "viewer" } : null,
    { requestFromRunner: async () => { throw new Error("unused"); }, sendToRunner: (_, frame) => { sent.push(frame); return true; } });
  try {
    const url = "/api/usage/claude-reconciliation/preview";
    for (const authorization of [undefined, "viewer"]) assert.equal((await app.inject({ method: "POST", url, headers: authorization ? { authorization } : {}, payload: evidence })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url, headers: { authorization: "foreign" }, payload: evidence })).statusCode, 400);
    const preview = await app.inject({ method: "POST", url, headers: { authorization: "owner" }, payload: evidence });
    assert.equal(preview.statusCode, 200);
    const approvedDigest = preview.json().digest;
    const applyUrl = "/api/usage/claude-reconciliation/apply";
    assert.equal((await app.inject({ method: "POST", url: applyUrl, headers: { authorization: "owner" }, payload: { evidence, approvedDigest } })).statusCode, 400);
    const applied = await app.inject({ method: "POST", url: applyUrl, headers: { authorization: "owner" }, payload: { evidence, approvedDigest, approved: true } });
    assert.equal(applied.statusCode, 200);
    assert.equal(applied.json().costUsd, 0.02);
    assert.deepEqual(sent, [{ type: "priced_session_cost", sessionId: "session", costUsd: 0.02, costReconciliationRevision: 1, costReconciliationDeltaUsd: -0.01 }]);
    const auditUrl = "/api/usage/claude-reconciliation/audit?sessionId=session";
    assert.equal((await app.inject({ url: auditUrl, headers: { authorization: "viewer" } })).statusCode, 403);
    assert.equal((await app.inject({ url: auditUrl, headers: { authorization: "foreign" } })).statusCode, 404);
    const audit = await app.inject({ url: auditUrl, headers: { authorization: "owner" } });
    assert.equal(audit.json().reconciliations[0].digest, approvedDigest);
    assert.equal(audit.json().reconciliations[0].deltaMicrousd, -10_000);
  } finally { await app.close(); db.close(); }
});

test("a committed correction remains successful when synchronization throws and exact retry resends it", async () => {
  const { db, evidence } = fixture();
  const app = Fastify();
  let disconnected = true;
  const frames: unknown[] = [];
  registerUsageRoutes(app, db, () => principal, {
    requestFromRunner: async () => { throw new Error("unused"); },
    sendToRunner: (_, frame) => {
      if (disconnected) throw new Error("disconnected");
      frames.push(frame); return true;
    },
  });
  try {
    const approvedDigest = previewClaudeReconciliation(db, principal, evidence).digest;
    const request = { method: "POST" as const, url: "/api/usage/claude-reconciliation/apply", payload: { evidence, approvedDigest, approved: true } };
    const first = await app.inject(request);
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().applied, true);
    assert.equal(first.json().synchronized, false);
    disconnected = false;
    const retry = await app.inject(request);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().applied, false);
    assert.equal(retry.json().synchronized, true);
    assert.deepEqual(frames, [{ type: "priced_session_cost", sessionId: "session", costUsd: 0.02, costReconciliationRevision: 1, costReconciliationDeltaUsd: -0.01 }]);
    assert.equal(db.sessionCostUsd("session"), 0.02);
  } finally { await app.close(); db.close(); }
});

test("fork, continuing query, and reset checkpoints reconcile independently without losing tokens", () => {
  const { db, evidence, now } = fixture();
  try {
    evidence.records[1]!.boundary = "fork";
    evidence.records[1]!.conversation = "e".repeat(64);
    const third = db.appendEvent("session", { kind: "token_usage", model: "claude-test", costUsd: 0.005 }, now + 2, { accrueUsage: true, runnerSeq: 3, historyEpoch: 1 });
    const fourth = db.appendEvent("session", { kind: "token_usage", model: "claude-test", costUsd: 0.004 }, now + 3, { accrueUsage: true, runnerSeq: 4, historyEpoch: 1 });
    evidence.records.push(
      { ...evidence.records[1]!, eventId: third.id, boundary: "continue", startUsd: 0.02, endUsd: 0.025 },
      { ...evidence.records[0]!, eventId: fourth.id, boundary: "reset", conversation: "f".repeat(64), process: "e".repeat(64), startUsd: 0, endUsd: 0.004 },
    );
    const preview = previewClaudeReconciliation(db, principal, evidence);
    assert.ok(preview.rows.every((r) => r.status === "correctable"));
    applyClaudeReconciliation(db, principal, evidence, preview.digest);
    assert.equal(db.sessionCostUsd("session"), 0.029);
    assert.equal(db.sessionUsageByModel("session").totals.inputTokens, 300);
  } finally { db.close(); }
});

test("a fresh proven reset can be repaired after an unresolved earlier boundary", () => {
  const { db, evidence, now } = fixture();
  try {
    evidence.records[1]!.startUsd = 0.009;
    const third = db.appendEvent("session", { kind: "token_usage", model: "claude-test", costUsd: 0.004 }, now + 2, { accrueUsage: true, runnerSeq: 3, historyEpoch: 1 });
    const fourth = db.appendEvent("session", { kind: "token_usage", model: "claude-test", costUsd: 0.008 }, now + 3, { accrueUsage: true, runnerSeq: 4, historyEpoch: 1 });
    evidence.records.push(
      { ...evidence.records[0]!, eventId: third.id, boundary: "reset", conversation: "f".repeat(64), process: "e".repeat(64), startUsd: 0, endUsd: 0.004 },
      { ...evidence.records[0]!, eventId: fourth.id, boundary: "resume", conversation: "f".repeat(64), process: "f".repeat(64), startUsd: 0.004, endUsd: 0.008 },
    );
    const preview = previewClaudeReconciliation(db, principal, evidence);
    assert.equal(preview.rows[1]?.status, "unresolved");
    assert.equal(preview.rows[3]?.status, "correctable");
    applyClaudeReconciliation(db, principal, evidence, preview.digest);
    assert.equal(db.sessionCostUsd("session"), 0.038);
    assert.equal(preview.unresolvedRecords, 1);
  } finally { db.close(); }
});

test("a rolled-up receipt targets its daily contribution even when late usage creates another hourly bucket", () => {
  const { db, evidence, now } = fixture();
  try {
    db.maintainUsageAggregation(now + 31 * 86_400_000);
    db.appendEvent("session", { kind: "token_usage", model: "claude-test", costUsd: 0.003, costIsEstimate: true }, now + 2, { accrueUsage: true, runnerSeq: 3, historyEpoch: 1 });
    const preview = previewClaudeReconciliation(db, principal, evidence);
    applyClaudeReconciliation(db, principal, evidence, preview.digest);
    assert.equal(db.raw().prepare("SELECT SUM(cost_microusd) AS cost FROM usage_daily").get()?.cost, 20_000);
    assert.equal(db.raw().prepare("SELECT SUM(cost_microusd) AS cost FROM usage_hourly").get()?.cost, 3_000);
  } finally { db.close(); }
});

test("fractional micro-dollars without original carry proof remain unresolved", () => {
  const { db, evidence, first } = fixture();
  try {
    evidence.records[0]!.endUsd = 0.0100001;
    db.raw().prepare("UPDATE session_events SET payload=json_set(payload,'$.costUsd',?) WHERE id=?").run(0.0100001, first.id);
    const preview = previewClaudeReconciliation(db, principal, evidence);
    assert.equal(preview.rows[0]?.status, "unresolved");
    assert.match(preview.rows[0]?.reason ?? "", /sub-micro/);
    assert.equal(db.sessionCostUsd("session"), 0.03);
  } finally { db.close(); }
});

test("observation and reconciliation metadata follow aggregate pruning and session deletion", () => {
  const { db, evidence, now } = fixture();
  try {
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM usage_cost_receipts").get()?.n, 2);
    applyClaudeReconciliation(db, principal, evidence, previewClaudeReconciliation(db, principal, evidence).digest);
    db.maintainUsageAggregation(now + 366 * 86_400_000);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM usage_cost_receipts").get()?.n, 0);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM usage_cost_reconciliations").get()?.n, 1);
    db.raw().exec("DELETE FROM sessions WHERE id='session'");
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM usage_cost_reconciliations").get()?.n, 0);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM usage_cost_reconciled_events").get()?.n, 0);
  } finally { db.close(); }
});
