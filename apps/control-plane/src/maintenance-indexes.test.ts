import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlPlaneDb } from "./db.js";
import { installMaintenanceIndexes } from "./maintenance-indexes.js";
import { captureMaintenanceQueries, seedMaintenanceFixture } from "../scripts/maintenance-benchmark-fixture.js";

const NEW_INDEXES = [
  "idx_workflow_attempts_deadline_active", "idx_session_stop_intents_pending",
  "idx_session_command_invocations_expiry", "idx_session_prompt_commands_expiry",
  "idx_session_prompt_commands_retention", "idx_outbound_event_deliveries_lease",
  "idx_outbound_event_deliveries_retention", "idx_outbound_event_deliveries_retry",
];
const TRIGGERS = [
  "outbound_events_orphan_insert", "outbound_deliveries_orphan_insert",
  "outbound_deliveries_orphan_delete", "outbound_deliveries_orphan_update",
];

function fixture(location = ":memory:"): ControlPlaneDb {
  const db = ControlPlaneDb.open(location);
  db.registerRunner({ runnerId: "bench", hostname: "synthetic", os: "linux", version: "test", workspaces: [], agents: [] }, 1);
  db.createSession({ id: "session", runnerId: "bench", workspaceId: null, agentId: "bench",
    title: "Synthetic", useWorktree: false, driver: "acp", config: {}, now: 1 });
  const project = db.createProject({ name: "Synthetic", now: 1 });
  for (const subscriptionId of ["sub-1", "sub-2"]) {
    db.createOutboundEventSubscription({ subscriptionId, callbackUrl: "https://example.invalid/synthetic",
      secret: "synthetic", scope: { kind: "project", projectId: project.id }, eventKinds: ["session.idle"],
      includeSessionName: false, includeQuestionTitle: false, actor: { kind: "human", id: "synthetic" }, now: 1 });
  }
  return db;
}

function addEvent(db: ControlPlaneDb, id: string): void {
  db.raw().prepare(`INSERT INTO outbound_events(event_id,source_key,kind,session_id,occurred_at,created_at)
    VALUES(?,?,'session.idle','session',1,1)`).run(id, id);
}

function addDelivery(db: ControlPlaneDb, id: string, event: string, subscription = "sub-1",
  status = "pending", updatedAt = 1, nextAttemptAt = 1, createdAt = 1): void {
  db.raw().prepare(`INSERT INTO outbound_event_deliveries
    (delivery_id,subscription_id,event_id,kind,status,payload_json,next_attempt_at,created_at,updated_at)
    VALUES(?,?,?,'session.idle',?,'{}',?,?,?)`).run(id, subscription, event, status, nextAttemptAt, createdAt, updatedAt);
}

function assertOrphans(db: ControlPlaneDb, expected: string[]): void {
  const projected = db.raw().prepare("SELECT event_id FROM outbound_event_orphans ORDER BY event_id").all();
  const reference = db.raw().prepare(`SELECT event_id FROM outbound_events WHERE NOT EXISTS (
    SELECT 1 FROM outbound_event_deliveries d WHERE d.event_id=outbound_events.event_id
  ) ORDER BY event_id`).all();
  assert.deepEqual(projected, reference, "projection agrees with the independent anti-join definition");
  assert.deepEqual(projected.map(row => row.event_id), expected);
  assert.deepEqual(db.raw().prepare("PRAGMA foreign_key_check").all(), []);
}

test("orphan projection tracks multiple deliveries, event reassignment, rollback, replacement and cascades", () => {
  const db = fixture();
  try {
    addEvent(db, "a"); addEvent(db, "b");
    assertOrphans(db, ["a", "b"]);
    addDelivery(db, "d1", "a"); addDelivery(db, "d2", "a", "sub-2");
    assertOrphans(db, ["b"]);
    db.raw().prepare("DELETE FROM outbound_event_deliveries WHERE delivery_id='d1'").run();
    assertOrphans(db, ["b"]);
    db.raw().prepare("UPDATE outbound_event_deliveries SET event_id='b' WHERE delivery_id='d2'").run();
    assertOrphans(db, ["a"]);
    db.raw().exec("BEGIN");
    db.raw().prepare("UPDATE outbound_event_deliveries SET event_id='a' WHERE delivery_id='d2'").run();
    assertOrphans(db, ["b"]);
    db.raw().exec("ROLLBACK");
    assertOrphans(db, ["a"]);
    db.raw().exec("BEGIN");
    db.raw().prepare("DELETE FROM outbound_event_deliveries WHERE delivery_id='d2'").run();
    assertOrphans(db, ["a", "b"]);
    db.raw().exec("ROLLBACK");
    assertOrphans(db, ["a"]);
    db.raw().exec("BEGIN"); addEvent(db, "rolled-back"); addDelivery(db, "rolled-back", "a");
    db.raw().exec("ROLLBACK");
    assertOrphans(db, ["a"]);
    db.raw().exec(`INSERT OR REPLACE INTO outbound_event_deliveries
      (delivery_id,subscription_id,event_id,kind,status,payload_json,next_attempt_at,created_at,updated_at)
      VALUES('d2','sub-2','a','session.idle','pending','{}',1,1,1)`);
    assertOrphans(db, ["b"]);
    db.raw().prepare("DELETE FROM outbound_event_subscriptions WHERE subscription_id='sub-2'").run();
    assertOrphans(db, ["a", "b"]);
    addDelivery(db, "cascade", "a");
    db.raw().prepare("DELETE FROM outbound_events WHERE event_id='a'").run();
    assertOrphans(db, ["b"]);
    addEvent(db, "session-cascade"); addDelivery(db, "session-cascade", "session-cascade");
    db.raw().prepare("DELETE FROM sessions WHERE id='session'").run();
    assertOrphans(db, []);
  } finally { db.close(); }
});

test("compaction preserves pending, recent and multiply referenced events and deletes real orphan sets", () => {
  const db = fixture();
  try {
    const now = 50 * 86_400_000;
    for (const id of ["old", "pending", "recent", "shared", "orphan"]) addEvent(db, id);
    addDelivery(db, "old", "old", "sub-1", "delivered");
    addDelivery(db, "pending", "pending");
    addDelivery(db, "recent", "recent", "sub-1", "failed", now);
    addDelivery(db, "shared-old", "shared", "sub-1", "dropped");
    addDelivery(db, "shared-live", "shared", "sub-2");
    assertOrphans(db, ["orphan"]);
    assert.equal(db.compactOutboundEventDeliveries(now), 2);
    assertOrphans(db, []);
    assert.deepEqual(db.raw().prepare("SELECT event_id FROM outbound_events ORDER BY event_id").all()
      .map(row => row.event_id), ["pending", "recent", "shared"]);
    assert.equal(db.compactOutboundEventDeliveries(now), 0);
  } finally { db.close(); }
});

test("indexed outbound retry preserves due ordering, limits, subscription filters and lease recovery", () => {
  const db = fixture();
  try {
    for (const id of ["a", "b", "c", "future", "paused", "recover", "leased"]) addEvent(db, id);
    addDelivery(db, "c", "c", "sub-1", "pending", 1, 10, 2);
    addDelivery(db, "b", "b", "sub-1", "retrying", 1, 10, 1);
    addDelivery(db, "a", "a", "sub-1", "pending", 1, 9, 1);
    addDelivery(db, "future", "future", "sub-1", "pending", 1, 200, 1);
    addDelivery(db, "paused", "paused", "sub-2");
    db.raw().exec("UPDATE outbound_event_subscriptions SET state='paused' WHERE subscription_id='sub-2'");
    assert.deepEqual(db.claimOutboundEventDeliveries(100, 2, 30_000).map(d => d.deliveryId), ["a", "b"]);
    assert.deepEqual(db.claimOutboundEventDeliveries(100, 2, 30_000).map(d => d.deliveryId), ["c"]);
    addDelivery(db, "recover", "recover", "sub-1", "delivering");
    addDelivery(db, "leased", "leased", "sub-1", "delivering");
    db.raw().exec(`UPDATE outbound_event_deliveries SET next_attempt_at=NULL,
      lease_expires_at=CASE delivery_id WHEN 'recover' THEN 99 ELSE 101 END
      WHERE delivery_id IN ('recover','leased')`);
    assert.deepEqual(db.claimOutboundEventDeliveries(100, 16, 30_000).map(d => d.deliveryId), ["recover"]);
    assertOrphans(db, []);
  } finally { db.close(); }
});

test("existing DB migration preserves content and event indexes, backfills once, and reopens idempotently", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-maintenance-upgrade-"));
  const location = join(root, "synthetic.db");
  let db = fixture(location);
  try {
    const eventIndexes = db.raw().prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='session_events' ORDER BY name").all();
    db.appendEvent("session", { kind: "agent_message", text: "preserved transcript" }, 2, { runnerSeq: 1 });
    const sessionEvents = db.raw().prepare("SELECT * FROM session_events ORDER BY id").all();
    for (const name of TRIGGERS) db.raw().exec(`DROP TRIGGER ${name}`);
    db.raw().exec("DROP TABLE outbound_event_orphans");
    for (const name of NEW_INDEXES) db.raw().exec(`DROP INDEX ${name}`);
    addEvent(db, "legacy-orphan"); addEvent(db, "legacy-delivered"); addDelivery(db, "legacy", "legacy-delivered");
    const events = db.raw().prepare("SELECT * FROM outbound_events ORDER BY event_id").all();
    const deliveries = db.raw().prepare("SELECT * FROM outbound_event_deliveries ORDER BY delivery_id").all();
    db.close(); db = ControlPlaneDb.open(location);
    assertOrphans(db, ["legacy-orphan"]);
    assert.deepEqual(db.raw().prepare("SELECT * FROM outbound_events ORDER BY event_id").all(), events);
    assert.deepEqual(db.raw().prepare("SELECT * FROM outbound_event_deliveries ORDER BY delivery_id").all(), deliveries);
    assert.deepEqual(db.raw().prepare("SELECT * FROM session_events ORDER BY id").all(), sessionEvents);
    assert.throws(() => db.raw().prepare(`INSERT INTO session_events(session_id,seq,runner_seq,ts,kind,payload)
      VALUES('session',2,1,2,'agent_message','{}')`).run(), /UNIQUE constraint failed/);
    assert.deepEqual(db.raw().prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='session_events' ORDER BY name").all(), eventIndexes);
    // The legacy orphan remains eligible. A repeated backfill would try another orphan insert
    // and fire this aborting trigger, proving reopen does not rescan old events.
    db.raw().exec(`CREATE TRIGGER forbid_orphan_rebackfill BEFORE INSERT ON outbound_event_orphans
      BEGIN SELECT RAISE(ABORT,'orphan backfill repeated'); END;`);
    db.close(); db = ControlPlaneDb.open(location);
    assertOrphans(db, ["legacy-orphan"]);
    assert.equal(db.raw().prepare("PRAGMA secure_delete").get()?.secure_delete, 1);
    for (const name of NEW_INDEXES) assert.ok(db.raw().prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name));
    db.raw().exec("DROP TRIGGER forbid_orphan_rebackfill");
    addEvent(db, "new-orphan"); addDelivery(db, "new", "new-orphan");
    assertOrphans(db, ["legacy-orphan"]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("failed migration rolls back indexes, table and triggers before a successful retry", () => {
  const db = fixture();
  try {
    for (const name of TRIGGERS) db.raw().exec(`DROP TRIGGER ${name}`);
    db.raw().exec("DROP TABLE outbound_event_orphans");
    for (const name of NEW_INDEXES) db.raw().exec(`DROP INDEX ${name}`);
    addEvent(db, "legacy-orphan");
    const raw = db.raw(); const original = raw.exec.bind(raw);
    raw.exec = sql => {
      if (sql.startsWith("INSERT INTO outbound_event_orphans")) throw new Error("synthetic upgrade interruption");
      return original(sql);
    };
    try { assert.throws(() => installMaintenanceIndexes(raw), /synthetic upgrade interruption/); }
    finally { raw.exec = original; }
    assert.equal(raw.isTransaction, false);
    assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE name='outbound_event_orphans'").get(), undefined);
    for (const name of [...NEW_INDEXES, ...TRIGGERS]) assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name), undefined);
    installMaintenanceIndexes(raw);
    assertOrphans(db, ["legacy-orphan"]);
  } finally { db.close(); }
});

test("six periodic sweeps and retry maintenance use indexes at 200,000 events and 2,000 sessions", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const counts = seedMaintenanceFixture(db);
    assert.equal(counts.session_events, 200_000); assert.equal(counts.sessions, 2_000);
    const queries = captureMaintenanceQueries(db);
    assert.ok(queries.length >= 22);
    for (const query of queries) {
      const details = (db.raw().prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.args) as Array<{ detail: string }>)
        .map(row => row.detail);
      assert.ok(details.some(detail => /USING (?:COVERING )?INDEX|USING PRIMARY KEY/.test(detail)), `${query.method}: ${details.join("; ")}`);
      for (const detail of details) {
        // Iterating the compact active partial indexes is intentional (all held resumes/stops).
        // The orphan projection is itself the eligible set, stored by primary key without rowid.
        if (/^SCAN /.test(detail) && !detail.startsWith("SCAN outbound_event_orphans")) {
          assert.match(detail, /USING (?:COVERING )?INDEX/, `${query.method} scanned retained history: ${detail}`);
        }
      }
    }
  } finally { db.close(); }
});
