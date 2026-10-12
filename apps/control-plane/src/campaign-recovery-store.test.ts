import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneDb } from "./db.js";
import type { CampaignRecoveryObservation } from "./campaign-recovery-store.js";

function database(path = ":memory:") {
  const db = ControlPlaneDb.open(path);
  db.registerRunner({ runnerId: "runner", hostname: "test", os: "linux", version: "test", workspaces: [], agents: [] }, 1);
  db.createSession({ id: "root", runnerId: "runner", workspaceId: null, agentId: "test", title: "Root", useWorktree: false,
    driver: "codex-app-server", now: 1, config: {} });
  return db;
}
const observation = (signal = "failure-1"): CampaignRecoveryObservation => ({
  action: "recover_hold", resource: { kind: "hold", sessionId: "root", occurrenceId: "hold-1" },
  owner: "orchestrator", reason: "transient_failure", signal,
});

test("backoff, atomic wakeup, duplicates, and attempt ceilings survive reopening", () => {
  const directory = mkdtempSync(join(tmpdir(), "campaign-recovery-"));
  const path = join(directory, "db.sqlite");
  let db = database(path);
  try {
    const store = db.campaignRecovery;
    assert.equal(store.synchronize("root", 2, true, [observation()], 100), true);
    assert.equal(store.synchronize("root", 2, true, [observation()], 200), false);
    assert.equal(store.projection("root").records[0]!.nextAttemptAt, 1100);
    assert.equal(store.dispatchDue("root", 2, 1099, () => assert.fail("too soon")), 0);
    assert.throws(() => store.dispatchDue("root", 2, 1100, () => { throw new Error("wake failed"); }));
    assert.equal(store.projection("root").records[0]!.attempts, 0, "transaction rolls reservation back");
    const wakes: string[] = [];
    store.dispatchDue("root", 2, 1100, (_record, id) => wakes.push(id));
    db.close(); db = ControlPlaneDb.open(path);
    assert.equal(db.campaignRecovery.synchronize("root", 2, true, [observation()], 2000), false);
    assert.equal(db.campaignRecovery.dispatchDue("root", 2, 3000, () => assert.fail("duplicate")), 0);
    for (let attempt = 2; attempt <= 4; attempt++) {
      const now = 10_000 * attempt;
      db.campaignRecovery.synchronize("root", 2, true, [observation(`failure-${attempt}`)], now);
      const due = db.campaignRecovery.projection("root").records[0]!.nextAttemptAt!;
      assert.equal(db.campaignRecovery.dispatchDue("root", 2, due, (_record, id) => wakes.push(id)), 1);
    }
    db.campaignRecovery.synchronize("root", 2, true, [observation("failure-5")], 100_000);
    const blocked = db.campaignRecovery.projection("root");
    assert.equal(blocked.blocked, 1); assert.equal(blocked.unattendedReady, false);
    assert.equal(blocked.records[0]!.reason, "attempts_exhausted");
    assert.equal(blocked.records[0]!.requiredInput, "none");
    assert.equal(blocked.records[0]!.attempts, 4);
    assert.equal(new Set(wakes).size, 4);
    db.campaignRecovery.synchronize("root", 3, true, [observation("override")], 200_000);
    assert.equal(db.campaignRecovery.dispatchDue("root", 3, 300_000, () => assert.fail("ceiling reset")), 0);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("revocation and policy changes cancel admission; human and denied requests never dispatch", () => {
  const db = database();
  try {
    const store = db.campaignRecovery;
    store.synchronize("root", 1, true, [observation()], 1);
    store.synchronize("root", 2, true, [observation()], 100);
    assert.equal(store.projection("root").blocked, 1, "live cancelled work remains visible without admission");
    store.synchronize("root", 2, true, [observation("new-event")], 200);
    assert.equal(store.dispatchDue("root", 2, 10000, () => assert.fail("rebound authority")), 0);
    const human = { ...observation(), resource: { ...observation().resource, occurrenceId: "auth-1" },
      owner: "human" as const, reason: "missing_access" as const };
    store.synchronize("root", 2, true, [human], 300);
    assert.equal(store.projection("root").waitingHuman, 1);
    assert.equal(store.projection("root").records[0]!.requiredInput, "restore_existing_access");
    assert.equal(store.dispatchDue("root", 2, 10000, () => assert.fail("human gate")), 0);
    store.synchronize("root", 2, true, [{ ...human, reason: "hard_denial", owner: "orchestrator", signal: "denied" }], 400);
    store.synchronize("root", 2, true, [{ ...human, reason: "transient_failure", owner: "orchestrator", signal: "again" }], 500);
    assert.equal(store.projection("root").records[0]!.reason, "hard_denial");
    store.synchronize("root", 2, true, [{ ...human, resolved: true }], 600);
    assert.equal(store.projection("root").records.length, 0, "authoritative resolution clears exception");
  } finally { db.close(); }
});

test("unknown outcomes instruct reconciliation and never authorize mutation replay", () => {
  const db = database();
  try {
    db.campaignRecovery.synchronize("root", 1, true, [{ ...observation(),
      action: "reconcile_outcome", reason: "uncertain_outcome" }], 1);
    db.campaignRecovery.dispatchDue("root", 1, 1, (record) => {
      assert.equal(record.action, "reconcile_outcome");
      assert.equal(record.requiredInput, "reconcile_original_outcome");
      assert.match(record.explanation, /does not authorize replay/);
    });
    db.campaignRecovery.synchronize("root", 1, false, [observation()], 2);
    assert.equal(db.campaignRecovery.projection("root").automatic, 0);
  } finally { db.close(); }
});

test("live human gates stay observable after policy changes and cancelled reservations", () => {
  const db = database();
  try {
    const store = db.campaignRecovery;
    const human = { ...observation(), owner: "human" as const, reason: "missing_access" as const };
    store.synchronize("root", 1, true, [human], 1);
    store.synchronize("root", 2, true, [human], 2);
    assert.equal(store.projection("root").waitingHuman, 1);
    assert.equal(store.projection("root").unattendedReady, false);
    store.synchronize("root", 2, false, [], 3);
    store.synchronize("root", 2, true, [human], 4);
    assert.equal(store.projection("root").waitingHuman, 1);
    assert.equal(store.synchronize("root", 2, true, [human], 5), false, "unchanged live gate remains quiet");
    assert.equal(store.dispatchDue("root", 2, 10000, () => assert.fail("human gate")), 0);
  } finally { db.close(); }
});

test("PR repair ceilings survive changing heads and resolved history", () => {
  const db = database();
  try {
    const store = db.campaignRecovery;
    const ids: string[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      store.synchronize("root", 1, true, [{ action: "repair_checks", owner: "orchestrator", reason: "failed_checks",
        resource: { kind: "pull_request", sessionId: "root", repository: "picoduck/wollipog", pullRequest: 42,
          occurrenceId: `head-${attempt}` }, signal: `head-${attempt}` }], attempt);
      assert.equal(store.dispatchDue("root", 1, attempt, record => ids.push(record.id)), 1);
    }
    assert.equal(new Set(ids).size, 1, "repair pushes retain one PR ceiling");
    store.synchronize("root", 1, true, [], 5);
    store.synchronize("root", 1, true, [{ action: "repair_checks", owner: "orchestrator", reason: "failed_checks",
      resource: { kind: "pull_request", sessionId: "root", repository: "picoduck/wollipog", pullRequest: 42,
        occurrenceId: "head-5" }, signal: "head-5" }], 6);
    assert.equal(store.projection("root").blocked, 1);
    assert.equal(store.projection("root").records[0]!.attempts, 4);
  } finally { db.close(); }
});

test("resolved worker exhaustion remains blocked when a replacement fails", () => {
  const db = database();
  try {
    const store = db.campaignRecovery;
    const worker = (n: number) => ({ action: "replace_worker" as const, owner: "orchestrator" as const,
      reason: "transient_failure" as const, resource: { kind: "worker" as const, sessionId: `worker-${n}`,
        occurrenceId: `epoch-${n}`, workItemId: "same-item" }, signal: `failure-${n}` });
    for (let n = 1; n <= 4; n++) {
      store.synchronize("root", 1, true, [worker(n)], n * 100000);
      store.dispatchDue("root", 1, n * 100000 + 30000, () => {});
    }
    store.synchronize("root", 1, true, [worker(5)], 600000);
    assert.equal(store.projection("root").blocked, 1);
    store.synchronize("root", 1, true, [], 700000);
    store.synchronize("root", 1, true, [worker(6)], 800000);
    assert.equal(store.projection("root").blocked, 1, "resolution never refunds exhausted attempts");
    assert.equal(store.projection("root").records[0]!.attempts, 4);
  } finally { db.close(); }
});
