import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { RunnerMetadata, WorkflowInstanceStatus } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { BUILD_REVIEW_WORKFLOW } from "./workflow-graphs.js";
import { WorkflowEventRetention, parseWorkflowEventRetentionEnvironment } from "./workflow-event-retention.js";
import { WorkflowEventRetentionStore } from "./workflow-event-retention-store.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const ORG = "org_personal";
const actor = { kind: "human" as const, id: "owner" };
function fixture(location = ":memory:") {
  const db = ControlPlaneDb.open(location);
  db.registerRunner({ runnerId: "runner", hostname: "host", os: "linux", version: "test", workspaces: [], agents: [] } as RunnerMetadata, T0);
  db.createRun({ id: "run", title: "Workflow", prompt: "test", runnerId: "runner", workspaceId: null, now: T0 });
  const definition = db.createWorkflowDefinition({ workflowId: "wf", ...BUILD_REVIEW_WORKFLOW,
    source: "custom", createdBy: actor, createdAt: T0 });
  const instance = (id: string, status: WorkflowInstanceStatus = "succeeded", completedAt: number | null = T0, count = 1, payload = "detail") => {
    db.createWorkflowInstance({ instanceId: id, definition, runId: "run", createdBy: actor, now: T0 });
    const insert = db.raw().prepare(`INSERT INTO workflow_events(instance_id,seq,kind,actor_kind,detail,created_at)
      VALUES(?,?,'transition','system',?,?)`);
    db.raw().exec("BEGIN");
    for (let seq = 2; seq <= count; seq++) insert.run(id, seq, JSON.stringify({ text: payload }), T0 + seq);
    db.raw().prepare("UPDATE workflow_instances SET status=?,completed_at=? WHERE instance_id=?").run(status, completedAt, id);
    db.raw().exec("COMMIT");
  };
  let now = T0 + 100 * DAY;
  let onSleep: () => void = () => {};
  const sleeps: number[] = [];
  const logs: object[] = [];
  const worker = (env: NodeJS.ProcessEnv = {}) => new WorkflowEventRetention(db, { env, now: () => now,
    sleep: async (ms) => { sleeps.push(ms); onSleep(); },
    log: { info: (details) => logs.push(details), warn: (details) => logs.push(details) } });
  return { db, instance, worker, sleeps, logs, setNow: (value: number) => { now = value; },
    onSleep: (fn: () => void) => { onSleep = fn; } };
}

test("off by default; preview is read-only; enable/shorten arms for 24 hours and relaxations apply immediately", async () => {
  const f = fixture(); const r = f.worker();
  try {
    f.instance("old");
    assert.equal(r.policy(ORG).retentionDays, null);
    assert.equal((await r.runPass()).events, 0);
    assert.deepEqual(r.view(ORG, true, 90).preview?.eligible, { instances: 1, events: 1 });
    assert.equal(r.policy(ORG).retentionDays, null);
    const armed = r.update(ORG, 90, "owner").prunesFrom!;
    assert.equal(armed, T0 + 101 * DAY);
    f.setNow(armed - 1); assert.equal((await r.runPass()).events, 0);
    f.setNow(armed); assert.equal((await r.runPass()).events, 1);
    const shortened = r.update(ORG, 30, "owner").prunesFrom!;
    assert.equal(shortened, armed + DAY);
    assert.equal(r.update(ORG, 365, "owner").prunesFrom, shortened);
    assert.equal(r.update(ORG, null, "owner").prunesFrom, null);
    assert.ok(f.logs.some((entry) => (entry as { event?: string }).event === "workflow_events_pruned"));
  } finally { f.db.close(); }
});

test("environment arming survives restart; invalid defaults fail closed; saved off overrides host opt-in", () => {
  const f = fixture();
  try {
    for (const value of [undefined, "", "0", " 0 "]) assert.deepEqual(parseWorkflowEventRetentionEnvironment(value), { retentionDays: null, invalid: false });
    for (const value of ["6", "3651", "7.5", "NaN", "1e2", "-1"]) assert.deepEqual(parseWorkflowEventRetentionEnvironment(value), { retentionDays: null, invalid: true });
    for (const value of ["7", "90", "3650"]) assert.equal(parseWorkflowEventRetentionEnvironment(value).retentionDays, Number(value));
    const r = f.worker({ CONTROL_PLANE_WORKFLOW_EVENT_RETENTION_DAYS: "90" });
    const armed = r.policy(ORG).prunesFrom;
    f.setNow(T0 + 102 * DAY);
    assert.equal(f.worker({ CONTROL_PLANE_WORKFLOW_EVENT_RETENTION_DAYS: "90" }).policy(ORG).prunesFrom, armed);
    assert.equal(f.worker({ CONTROL_PLANE_WORKFLOW_EVENT_RETENTION_DAYS: "30" }).policy(ORG).prunesFrom, T0 + 103 * DAY);
    r.update(ORG, null, "owner");
    assert.equal(f.worker({ CONTROL_PLANE_WORKFLOW_EVENT_RETENTION_DAYS: "7" }).policy(ORG).retentionDays, null);
    assert.equal(f.worker({ CONTROL_PLANE_WORKFLOW_EVENT_RETENTION_DAYS: "invalid" }).view(ORG, true).environmentDays, null);
  } finally { f.db.close(); }
});

test("only old terminal events go; summaries, node outcomes, attempts, artifacts, decisions and receipt replay protection survive", async () => {
  const f = fixture(); const r = f.worker();
  try {
    for (const status of ["succeeded", "failed", "stopped"] as const) f.instance(status, status, T0, 1_203);
    for (const status of ["running", "queued", "waiting_gate"] as const) f.instance(status, status, T0, 4);
    f.instance("recent", "succeeded", T0 + 99 * DAY, 4);
    f.instance("boundary", "failed", T0 + 11 * DAY, 4);
    f.instance("no-completion", "succeeded", null, 4);
    f.db.raw().prepare("UPDATE workflow_node_states SET status='succeeded',outcome='success',completed_at=? WHERE instance_id='succeeded' AND node_id='build'").run(T0);
    f.db.createWorkflowAttempt({ attemptId: "attempt", instanceId: "succeeded", nodeId: "build", attempt: 1,
      status: "succeeded", dispatchKey: "unique", startedAt: T0 - 1, deadlineAt: T0, completedAt: T0 });
    f.db.createWorkflowArtifact({ artifactId: "artifact", runId: "run", name: "output.txt", kind: "test_log",
      mimeType: "text/plain", encoding: "utf8", data: "kept", sizeBytes: 4,
      sha256: createHash("sha256").update("kept").digest("hex"), createdAt: T0, createdBy: actor });
    f.db.raw().prepare("INSERT INTO workflow_attempt_artifacts VALUES('attempt','output','artifact')").run();
    f.db.createSession({ id: "session", runnerId: "runner", workspaceId: null, agentId: "agent", title: "Authority",
      driver: "claude-code", useWorktree: false, config: {}, now: T0 });
    const decisionInput = { requestId: "request", occurrenceId: "occurrence", sessionId: "session", controllingSessionId: "session",
      category: "implementation_question" as const, resourceKey: "key", resourceSnapshot: { category: "implementation_question" as const,
        question: "Choice?", options: [{ optionId: "a", label: "A" }] }, resourceDigest: "a".repeat(64), policyRevision: 1,
      authority: "human" as const, createdAt: T0 };
    f.db.createWorkflowDecision(decisionInput);
    assert.equal(f.db.claimWorkflowDecisionActionReceipt("session", "receipt", "command", T0), true);
    const keptTables = ["workflow_instances", "workflow_node_states", "workflow_attempts", "workflow_attempt_artifacts",
      "workflow_definitions", "workflow_decisions", "workflow_decision_action_receipts", "multi_agent_runs", "artifacts"];
    const before = keptTables.map((table) => f.db.raw().prepare(`SELECT * FROM ${table}`).all());
    r.update(ORG, 90, "owner"); f.setNow(T0 + 101 * DAY);
    const result = await r.runPass();
    assert.deepEqual([result.instances, result.events], [3, 3_609]);
    assert.ok(result.batches > 3 && f.sleeps.length === result.batches);
    assert.deepEqual(keptTables.map((table) => f.db.raw().prepare(`SELECT * FROM ${table}`).all()), before);
    for (const status of ["succeeded", "failed", "stopped"]) {
      const view = f.db.getWorkflowInstance(status)!;
      assert.equal(view.events.length, 0);
      assert.deepEqual(view.eventHistoryPruned, { prunedAt: T0 + 101 * DAY, eventCount: 1_203, retentionDays: 90 });
    }
    for (const id of ["running", "queued", "waiting_gate", "recent", "boundary", "no-completion"]) {
      assert.equal(f.db.listWorkflowEvents(id).length, 4, id);
      assert.equal(f.db.getWorkflowInstance(id)?.eventHistoryPruned, undefined);
    }
    assert.equal(f.db.createWorkflowDecision(decisionInput)?.replay, true);
    assert.equal(f.db.claimWorkflowDecisionActionReceipt("session", "receipt", "command", T0 + 102 * DAY), false);
    assert.equal(f.db.appendWorkflowEvent({ instanceId: "succeeded", kind: "instance_status_changed", actor, createdAt: T0 + 101 * DAY }).seq, 1_204);
    assert.equal((await r.runPass()).events, 1);
    assert.equal(f.db.getWorkflowInstance("succeeded")?.eventHistoryPruned?.eventCount, 1_204);
  } finally { f.db.close(); }
});

test("turning off, lengthening or retrying between paced batches stops deletion; partial work resumes safely", async () => {
  for (const change of ["off", "lengthen", "retry", "stop"] as const) {
    const f = fixture(); let r = f.worker();
    try {
      f.instance("old", "failed", T0, 1_200);
      r.update(ORG, 90, "owner"); f.setNow(T0 + 101 * DAY);
      f.onSleep(() => {
        if (change === "off") r.update(ORG, null, "owner");
        if (change === "lengthen") r.update(ORG, 365, "owner");
        if (change === "retry") f.db.raw().prepare("UPDATE workflow_instances SET status='running',completed_at=NULL WHERE instance_id='old'").run();
        if (change === "stop") r.stop();
      });
      const result = await r.runPass();
      assert.equal(result.events, 100, change);
      assert.equal(f.db.getWorkflowInstance("old")?.eventHistoryPruned?.eventCount, 100);
      f.onSleep(() => {});
      f.db.raw().prepare("UPDATE workflow_instances SET status='failed',completed_at=? WHERE instance_id='old'").run(T0);
      r = f.worker(); r.update(ORG, 90, "owner"); f.setNow(T0 + 103 * DAY);
      assert.equal((await r.runPass()).events, 1_100);
      assert.equal(f.db.appendWorkflowEvent({ instanceId: "old", kind: "instance_status_changed", actor, createdAt: T0 + 103 * DAY }).seq, 1_201);
    } finally { f.db.close(); }
  }
});

test("batches respect row/payload ceilings, sparse candidates advance fifty at a time, and foreign/unowned runs are retained", () => {
  const f = fixture(); const store = new WorkflowEventRetentionStore(f.db.raw());
  try {
    f.instance("big", "succeeded", T0, 7, "x".repeat(600_000));
    const batch = store.pruneBatch(ORG, T0 + DAY, 90, T0 + 100 * DAY, 500);
    assert.equal(batch.removed, 4); // The created event plus three 600 KB payloads.
    assert.ok(batch.bytes <= 2 * 1024 * 1024);
    assert.equal(f.db.getWorkflowInstance("big")?.eventHistoryPruned?.eventCount, 4);
    f.db.raw().prepare("UPDATE workflow_instances SET status='running' WHERE instance_id='big'").run();
    for (let n = 0; n < 110; n++) f.instance(`sparse-${String(n).padStart(3, "0")}`);
    f.db.raw().prepare("DELETE FROM workflow_events WHERE instance_id LIKE 'sparse-%'").run();
    let cursor = null; let pages = 0;
    for (;;) {
      const next = store.pruneBatch(ORG, T0 + DAY, 90, T0 + 100 * DAY, 500, cursor);
      pages++; cursor = next.cursor;
      assert.equal(next.removed, 0);
      if (next.finished) break;
    }
    assert.equal(pages, 3);
    f.instance("foreign");
    assert.equal(store.pruneBatch("other-org", T0 + DAY, 90, T0 + 100 * DAY, 500).removed, 0);
    f.db.raw().prepare("DELETE FROM runner_ownership WHERE runner_id='runner'").run();
    assert.equal(store.pruneBatch(ORG, T0 + DAY, 90, T0 + 100 * DAY, 500).removed, 0);
  } finally { f.db.close(); }
});

test("disk restart keeps partial prune metadata and sequence high-water; repeated cycles reuse database pages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "workflow-retention-"));
  const path = join(dir, "control-plane.db");
  const f = fixture(path);
  try {
    f.instance("restart", "failed", T0, 1_200);
    new WorkflowEventRetentionStore(f.db.raw()).pruneBatch(ORG, T0 + DAY, 90, T0 + 100 * DAY, 100);
    f.db.close();
    const reopened = ControlPlaneDb.open(path);
    try {
      assert.equal(reopened.getWorkflowInstance("restart")?.eventHistoryPruned?.eventCount, 100);
      const r = new WorkflowEventRetention(reopened, { env: {}, now: () => T0 + 103 * DAY,
        sleep: async () => {}, log: { info() {}, warn() {} } });
      r.update(ORG, 90, "owner");
      // Direct batches also allow measurement without waiting through an arming delay.
      const store = new WorkflowEventRetentionStore(reopened.raw());
      let pagesAfterWarmup = 0;
      for (let cycle = 0; cycle < 12; cycle++) {
        const seq = reopened.appendWorkflowEvent({ instanceId: "restart", kind: "instance_status_changed", actor, createdAt: T0 }).seq;
        reopened.raw().exec("BEGIN");
        const insert = reopened.raw().prepare("INSERT INTO workflow_events(instance_id,seq,kind,actor_kind,detail,created_at) VALUES('restart',?,'transition','system',?,?)");
        for (let n = 1; n <= 2_000; n++) insert.run(seq + n, '{"text":"' + "x".repeat(500) + '"}', T0);
        reopened.raw().exec("COMMIT");
        while (!store.pruneBatch(ORG, T0 + DAY, 90, T0 + 103 * DAY, 100).finished) { /* bounded batches */ }
        reopened.raw().exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const pages = (reopened.raw().prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
        if (cycle === 2) pagesAfterWarmup = pages;
        if (cycle > 2) assert.ok(pages <= pagesAfterWarmup + 10, `cycle ${cycle} reuses pages`);
      }
      assert.equal(reopened.listWorkflowEvents("restart").length, 0);
      assert.equal(reopened.getWorkflowInstance("restart")?.eventHistoryPruned?.eventCount, 1_200 + 12 * 2_001);
      assert.ok(reopened.appendWorkflowEvent({ instanceId: "restart", kind: "instance_status_changed", actor, createdAt: T0 }).seq > 25_000);
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("WAL batches restore FULL mode and roll back events if the atomic prune marker cannot be saved", () => {
  const dir = mkdtempSync(join(tmpdir(), "workflow-retention-atomic-"));
  const f = fixture(join(dir, "control-plane.db"));
  try {
    f.instance("atomic", "failed", T0, 200);
    const store = new WorkflowEventRetentionStore(f.db.raw(), (work) => f.db.workflowEventRetentionCommit(() => {
      assert.equal((f.db.raw().prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous, 1);
      return work();
    }));
    f.db.raw().exec("CREATE TRIGGER fail_prune BEFORE INSERT ON workflow_event_prunes BEGIN SELECT RAISE(ABORT,'marker refused'); END");
    assert.throws(() => store.pruneBatch(ORG, T0 + DAY, 90, T0 + 100 * DAY, 100), /marker refused/);
    assert.equal(f.db.listWorkflowEvents("atomic").length, 200);
    assert.equal(f.db.getWorkflowInstance("atomic")?.eventHistoryPruned, undefined);
    assert.equal((f.db.raw().prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous, 2);
    f.db.raw().exec("DROP TRIGGER fail_prune");
    assert.equal(store.pruneBatch(ORG, T0 + DAY, 90, T0 + 100 * DAY, 100).removed, 100);
    store.recordRun(ORG, T0 + 100 * DAY, { instances: 1, events: 100 });
    assert.equal((f.db.raw().prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous, 2);
  } finally { f.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("malformed persisted environment arming fails closed and re-arms the host default", () => {
  const f = fixture();
  try {
    for (const value of ["{", "null", "[]", '{"retentionDays":"90","prunesFrom":0}',
      '{"retentionDays":90,"prunesFrom":-1}', '{"retentionDays":1,"prunesFrom":0}']) {
      f.db.raw().prepare("INSERT OR REPLACE INTO control_plane_metadata(key,value) VALUES('workflow_event_environment_policy',?)").run(value);
      const r = f.worker({ CONTROL_PLANE_WORKFLOW_EVENT_RETENTION_DAYS: "90" });
      assert.deepEqual(r.policy(ORG), { retentionDays: 90, prunesFrom: T0 + 101 * DAY, source: "environment" });
    }
  } finally { f.db.close(); }
});

test("a sleeping pass stopped during shutdown never touches the closed database", async () => {
  const f = fixture(); const r = f.worker();
  f.instance("shutdown", "failed", T0, 1200);
  r.update(ORG, 90, "owner"); f.setNow(T0 + 101 * DAY);
  f.onSleep(() => { r.stop(); f.db.close(); });
  const result = await r.runPass();
  assert.equal(result.events, 100);
  assert.equal(f.logs.some((entry) => (entry as { event?: string }).event === "workflow_event_retention_deferred"), false);
});
