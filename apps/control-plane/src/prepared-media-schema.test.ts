import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { PreparedMediaActiveStops } from "./prepared-media-active-stops.js";
import { initializePreparedMediaSchema, PreparedMediaSessions, type PreparedMediaSessionPorts } from "./prepared-media-sessions.js";

// Schema-order tests for #3366. The ports are inert: nothing here materializes, dispatches or stops.
const unused = () => { throw new Error("Schema tests never reach a lifecycle port."); };
const stopPorts = { current: () => false, send: unused };
const ledgerPorts = (database: DatabaseSync): PreparedMediaSessionPorts => ({ database, materialize: unused,
  currentAdmission: () => null, currentIdentity: () => null, authorize: async () => false, send: unused,
  reconcile: async () => null, cancelNeverDispatched: unused });
const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
const rows = (db: DatabaseSync) => ({
  sessions: db.prepare("SELECT * FROM prepared_media_sessions ORDER BY admission_id").all(),
  stops: db.prepare("SELECT * FROM prepared_media_active_stops ORDER BY session_id").all(),
});
const expectedSessionColumns = ["root_id", "admission_id", "request_sha256", "state", "payload", "payload_sha256", "stop_operation_id"];

function open(t: { after(fn: () => void): void }): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  return db;
}

test("a fresh database constructs the dedicated Stop coordinator before the lifecycle ledger", (t) => {
  const db = open(t);
  const stops = new PreparedMediaActiveStops(db, stopPorts);
  assert.deepEqual(columns(db, "prepared_media_sessions"), expectedSessionColumns);
  assert.deepEqual(columns(db, "prepared_media_active_stops"), ["session_id", "record", "sha256"]);
  // A missing dependency table would read as quarantine; a complete schema reads as not owned.
  assert.equal(stops.owns("unknown-session"), false);
  assert.equal(stops.readback("unknown-session"), null);
  new PreparedMediaSessions(db, ledgerPorts(db));
  assert.deepEqual(columns(db, "prepared_media_sessions"), expectedSessionColumns);
});

test("the supported composition order and its reverse produce the same schema", (t) => {
  const ledgerFirst = open(t), stopsFirst = open(t), direct = open(t);
  new PreparedMediaSessions(ledgerFirst, ledgerPorts(ledgerFirst));
  new PreparedMediaActiveStops(ledgerFirst, stopPorts);
  new PreparedMediaActiveStops(stopsFirst, stopPorts);
  new PreparedMediaSessions(stopsFirst, ledgerPorts(stopsFirst));
  initializePreparedMediaSchema(direct);
  const schema = (db: DatabaseSync) => db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE 'prepared_media_%' ORDER BY name").all();
  assert.deepEqual(schema(stopsFirst), schema(ledgerFirst));
  assert.deepEqual(schema(direct), schema(ledgerFirst));
});

test("a prior ledger without Stop anchors migrates additively and keeps its records", (t) => {
  const db = open(t);
  db.exec("CREATE TABLE prepared_media_sessions (root_id TEXT NOT NULL, admission_id TEXT NOT NULL, request_sha256 TEXT NOT NULL," +
    "state TEXT NOT NULL, payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL, PRIMARY KEY(root_id,admission_id));");
  db.prepare("INSERT INTO prepared_media_sessions VALUES (?,?,?,?,?,?)")
    .run("root", "prior-admission", "a".repeat(64), "active", "{\"sessionId\":\"worker\"}", "b".repeat(64));
  const before = db.prepare("SELECT * FROM prepared_media_sessions").all();
  new PreparedMediaActiveStops(db, stopPorts);
  assert.deepEqual(columns(db, "prepared_media_sessions"), expectedSessionColumns);
  assert.deepEqual(db.prepare("SELECT root_id, admission_id, request_sha256, state, payload, payload_sha256 FROM prepared_media_sessions").all(), before);
  assert.equal(db.prepare("SELECT stop_operation_id FROM prepared_media_sessions").get()!.stop_operation_id, null);
});

test("repeated construction in either order preserves existing Stop provenance exactly", (t) => {
  const db = open(t);
  initializePreparedMediaSchema(db);
  db.prepare("INSERT INTO prepared_media_sessions VALUES (?,?,?,?,?,?,?)")
    .run("root", "anchored-admission", "c".repeat(64), "active", "{\"sessionId\":\"worker\"}", "d".repeat(64), "media_stop_existing");
  db.prepare("INSERT INTO prepared_media_active_stops VALUES (?,?,?)").run("worker", "{\"request\":{}}", "e".repeat(64));
  const before = rows(db);
  for (let round = 0; round < 3; round++) {
    new PreparedMediaActiveStops(db, stopPorts);
    new PreparedMediaSessions(db, ledgerPorts(db));
    new PreparedMediaActiveStops(db, stopPorts);
    initializePreparedMediaSchema(db);
  }
  assert.deepEqual(rows(db), before);
  assert.deepEqual(columns(db, "prepared_media_sessions"), expectedSessionColumns);
  // An existing anchor still keeps its session owned without any dedicated Stop being sent.
  assert.equal(new PreparedMediaActiveStops(db, stopPorts).owns("worker"), true);
});
