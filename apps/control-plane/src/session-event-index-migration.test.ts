import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import type { SessionEventPayload } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID } from "./identity.js";

const PREFIX = "idx_session_events_tool_call";
const WIDER = "idx_session_events_tool_call_id";
const LEGACY_PREFIX_SQL = `CREATE INDEX ${PREFIX}
  ON session_events(session_id, json_extract(payload,'$.toolCallId')) WHERE kind='tool_call'`;
const DISTINCT_SQL = `SELECT COUNT(DISTINCT json_extract(payload,'$.toolCallId')) AS n
  FROM session_events WHERE session_id=? AND kind='tool_call'`;
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function seedSessions(db: ControlPlaneDb, count = 2): void {
  db.registerRunner({ runnerId: "index-migration", hostname: "synthetic", os: "linux",
    version: "test", workspaces: [], agents: [] }, 1);
  for (let i = 0; i < count; i++) {
    db.createSession({ id: `s${i}`, runnerId: "index-migration", workspaceId: null,
      agentId: "synthetic", title: "Synthetic", useWorktree: false, driver: "acp", config: {}, now: 1,
      scope: { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "user", userId: LOCAL_OWNER_USER_ID } } });
  }
}

function indexDefinitions(raw: DatabaseSync): Record<string, string> {
  return Object.fromEntries((raw.prepare(`SELECT name,sql FROM sqlite_master WHERE type='index'
    AND tbl_name='session_events' AND sql IS NOT NULL ORDER BY name`).all() as Array<{ name: string; sql: string }>)
    .map(row => [row.name, row.sql]));
}

function assertCounts(db: ControlPlaneDb): void {
  const sessions = db.raw().prepare("SELECT id FROM sessions ORDER BY id").all();
  for (const row of sessions) {
    const id = String(row.id);
    assert.equal(db.countToolCalls(id), Number(db.raw().prepare(DISTINCT_SQL).get(id)!.n), id);
  }
  assert.deepEqual(db.raw().prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.raw().prepare("PRAGMA secure_delete").get()!.secure_delete, 1);
}

/** Construct the persisted pre-counter shape through raw SQLite. The destination file has never
 * been opened by ControlPlaneDb; an in-memory template supplies unrelated table definitions/data.
 * No counter marker, counter trigger, FTS virtual/shadow table, or newer runtime trigger is copied. */
function writeLegacy(location: string, includeWider: boolean, sessionCount = 2): Record<string, string> {
  const template = ControlPlaneDb.open(":memory:");
  const legacy = new DatabaseSync(location);
  try {
    seedSessions(template, sessionCount);
    legacy.exec("PRAGMA foreign_keys=OFF");
    const names = new Set(template.raw().prepare("PRAGMA table_list").all()
      .filter(row => row.type === "table" && !String(row.name).startsWith("sqlite_")
        && row.name !== "session_tool_call_counts")
      .map(row => String(row.name)));
    const tables = template.raw().prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY rowid").all();
    for (const row of tables) {
      if (!names.has(String(row.name))) continue;
      legacy.exec(String(row.sql));
      const values = template.raw().prepare(`SELECT * FROM ${quote(String(row.name))}`).all();
      if (!values.length) continue;
      const columns = Object.keys(values[0]!);
      const insert = legacy.prepare(`INSERT INTO ${quote(String(row.name))}(${columns.map(quote).join(",")})
        VALUES(${columns.map(() => "?").join(",")})`);
      for (const value of values) insert.run(...columns.map(column => value[column] as SQLInputValue));
    }
    const definitions = indexDefinitions(template.raw());
    for (const [name, sql] of Object.entries(definitions)) {
      if (name !== WIDER || includeWider) legacy.exec(sql);
    }
    legacy.exec(LEGACY_PREFIX_SQL);
    const insert = legacy.prepare(`INSERT INTO session_events(session_id,seq,runner_seq,ts,kind,payload)
      VALUES('s0',?,?,1,?,?)`);
    for (const [i, id] of ["a", "a", "b", null, undefined, 1, true, "1"].entries()) {
      insert.run(i + 1, i + 1, "tool_call", JSON.stringify({ kind: "tool_call", toolCallId: id }));
    }
    insert.run(9, 9, "tool_call_update", '{"kind":"tool_call_update","toolCallId":"update-only"}');
    assert.equal(legacy.prepare("SELECT 1 FROM sqlite_master WHERE name='session_tool_call_counts'").get(), undefined);
    assert.equal(legacy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'").get()!.n, 0);
    return definitions;
  } finally {
    legacy.close();
    template.close();
  }
}

for (const includeWider of [false, true]) {
  test(`legacy prefix migration creates/preserves wider index (${includeWider}) and backfills exactly once`, () => {
    const root = mkdtempSync(join(tmpdir(), "wollipog-event-index-migration-"));
    const location = join(root, "synthetic.db");
    try {
      const expected = writeLegacy(location, includeWider);
      const db = ControlPlaneDb.open(location);
      try {
        assert.deepEqual(indexDefinitions(db.raw()), expected, "only the legacy prefix is retired");
        assert.equal(Object.keys(expected).length, 7);
        assert.equal(db.countToolCalls("s0"), 4);
        assertCounts(db);
        assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM session_events").get()!.n, 9);
        assert.throws(() => db.raw().prepare(`INSERT INTO session_events(session_id,seq,runner_seq,ts,kind,payload)
          VALUES('s0',99,1,1,'agent_message','{}')`).run(), /UNIQUE constraint/);
        db.raw().exec(`CREATE TRIGGER forbid_counter_recount BEFORE INSERT ON session_tool_call_counts
          BEGIN SELECT RAISE(ABORT,'unexpected counter recount'); END`);
      } finally { db.close(); }
      for (let repeat = 0; repeat < 3; repeat++) {
        const reopened = ControlPlaneDb.open(location);
        try {
          assert.deepEqual(indexDefinitions(reopened.raw()), expected);
          assert.equal(reopened.countToolCalls("s0"), 4);
          assertCounts(reopened);
        } finally { reopened.close(); }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("a failed counter installation rolls back the legacy DROP and permits a healthy retry", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-event-index-rollback-"));
  const location = join(root, "synthetic.db");
  try {
    writeLegacy(location, false);
    let raw = new DatabaseSync(location);
    raw.exec("CREATE VIEW session_tool_call_counts AS SELECT 's0' AS session_id, 4 AS tool_calls");
    raw.close();
    // Retain the deliberately failed fixture connection so cleanup is deterministic even on
    // builds whose pre-existing startup error path leaves that handle open until GC.
    const originalExec = DatabaseSync.prototype.exec;
    let failedHandle: DatabaseSync | undefined;
    DatabaseSync.prototype.exec = function(sql: string): void {
      if (sql.startsWith("CREATE TABLE session_tool_call_counts")) failedHandle = this;
      return originalExec.call(this, sql);
    };
    try { assert.throws(() => ControlPlaneDb.open(location), /already exists/); }
    finally {
      DatabaseSync.prototype.exec = originalExec;
      if (failedHandle?.isOpen) failedHandle.close();
    }
    raw = new DatabaseSync(location);
    try {
      assert.ok(indexDefinitions(raw)[PREFIX], "the failed transaction restored the prefix");
      assert.ok(indexDefinitions(raw)[WIDER], "schema created the replacement before attempting DROP");
      assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM session_events").get()!.n, 9);
      assert.equal(raw.prepare("SELECT type FROM sqlite_master WHERE name='session_tool_call_counts'").get()!.type, "view");
      raw.exec("DROP VIEW session_tool_call_counts");
    } finally { raw.close(); }
    const recovered = ControlPlaneDb.open(location);
    try {
      assert.equal(indexDefinitions(recovered.raw())[PREFIX], undefined);
      assert.equal(recovered.countToolCalls("s0"), 4);
      assertCounts(recovered);
    } finally { recovered.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("migrated counters preserve distinct IDs through updates, deletes, rollback and session cascades", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-event-index-counter-"));
  const location = join(root, "synthetic.db");
  try {
    writeLegacy(location, true);
    const db = ControlPlaneDb.open(location);
    try {
      const append = (id: string | null) => db.appendEvent("s0",
        { kind: "tool_call", toolCallId: id, title: "Synthetic", status: "pending" } as unknown as SessionEventPayload, 2);
      append("new"); append("new"); append(null);
      assert.equal(db.countToolCalls("s0"), 5);
      assertCounts(db);
      const raw = db.raw();
      raw.exec("BEGIN");
      raw.prepare(`INSERT INTO session_events(session_id,seq,ts,kind,payload)
        VALUES('s0',1000,2,'tool_call',?)`).run('{"kind":"tool_call","toolCallId":"rolled-back"}');
      raw.exec("DELETE FROM session_events WHERE session_id='s0' AND seq=1");
      assertCounts(db);
      raw.exec("ROLLBACK");
      assert.equal(db.countToolCalls("s0"), 5);
      assertCounts(db);
      raw.prepare("UPDATE session_events SET payload=? WHERE session_id='s0' AND seq=2")
        .run('{"kind":"tool_call","toolCallId":"changed"}');
      assert.equal(db.countToolCalls("s0"), 6);
      raw.exec("UPDATE session_events SET session_id='s1',runner_seq=NULL WHERE session_id='s0' AND seq=2");
      assertCounts(db);
      assert.equal(db.countToolCalls("s1"), 1);
      raw.exec("UPDATE session_events SET kind='tool_call_update' WHERE session_id='s1'");
      assertCounts(db);
      raw.exec("DELETE FROM session_events WHERE session_id='s0' AND seq=3");
      assertCounts(db);
      db.deleteSession("s0");
      assertCounts(db);
      assert.deepEqual(raw.prepare("SELECT * FROM session_tool_call_counts").all(), []);
      assert.equal(indexDefinitions(raw)[PREFIX], undefined);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an existing counter is preserved while retiring the prefix, without recounting history", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-event-index-existing-counter-"));
  const location = join(root, "synthetic.db");
  try {
    writeLegacy(location, true);
    const installed = ControlPlaneDb.open(location);
    try {
      // Persist the old build's index shape alongside its already-maintained counter marker.
      installed.raw().exec(LEGACY_PREFIX_SQL);
      installed.raw().exec(`CREATE TRIGGER forbid_counter_recount BEFORE INSERT ON session_tool_call_counts
        BEGIN SELECT RAISE(ABORT,'unexpected counter recount'); END`);
    } finally { installed.close(); }
    const migrated = ControlPlaneDb.open(location);
    try {
      assert.equal(indexDefinitions(migrated.raw())[PREFIX], undefined);
      assert.equal(migrated.countToolCalls("s0"), 4);
      assertCounts(migrated);
      migrated.raw().exec("DROP TRIGGER forbid_counter_recount");
      migrated.appendEvent("s0", { kind: "tool_call", toolCallId: "later", title: "Synthetic", status: "pending" }, 2);
      assert.equal(migrated.countToolCalls("s0"), 5);
      assertCounts(migrated);
    } finally { migrated.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


interface CapturedQuery { name: string; sql: string; args: SQLInputValue[] }

function captureProjectionQueries(db: ControlPlaneDb): CapturedQuery[] {
  const queries: CapturedQuery[] = [];
  const target = db as unknown as { stmt(sql: string): { all(...args: SQLInputValue[]): unknown[] } };
  const original = target.stmt;
  let name = "";
  target.stmt = sql => ({ all: (...args) => { queries.push({ name, sql, args }); return []; } });
  try {
    name = "actual structured agent candidates";
    db.listAgentToolCallIds("s0", 0, 100);
    name = "actual ordered child projection";
    db.listChildSessionProjectionPage("s0", ["tool7"], 0, 100, 30);
  } finally { target.stmt = original; }
  return queries;
}

/** Extract the actual trigger subqueries rather than duplicating their predicates in the test. */
function captureTriggerProbes(raw: DatabaseSync): CapturedQuery[] {
  const result: CapturedQuery[] = [];
  const triggers = raw.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger'
    AND name LIKE 'session_events_tool_call_count_%' ORDER BY name`).all();
  assert.equal(triggers.length, 3);
  for (const row of triggers) {
    const definition = String(row.sql);
    for (const match of definition.matchAll(/NOT EXISTS \((SELECT 1 FROM session_events[\s\S]*?)\)\s*(?:\n|;)/g)) {
      const args: SQLInputValue[] = [];
      const sql = match[1]!.replace(/(?:NEW|OLD)\.(session_id|payload|id)/g, (_text, column: string) => {
        args.push(column === "session_id" ? "s0" : column === "payload" ? '{"toolCallId":"tool7"}' : 1);
        return "?";
      });
      result.push({ name: `${String(row.name)} probe ${result.length}`, sql, args });
    }
  }
  assert.equal(result.length, 4, "insert/delete/update probes must all be guarded");
  return result;
}

test("actual counter and child callers retain indexed plans and ordered results at 200k events/2k sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-event-index-plans-"));
  const location = join(root, "synthetic.db");
  try {
    const expectedIndexes = writeLegacy(location, true, 2_000);
    const legacy = new DatabaseSync(location);
    try {
      legacy.exec("BEGIN; DELETE FROM session_events");
      const insert = legacy.prepare(`INSERT INTO session_events(session_id,seq,runner_seq,ts,kind,payload)
        VALUES(?,?,?,?,?,?)`);
      for (let i = 0; i < 200_000; i++) {
        const seq = Math.floor(i / 2_000) + 1;
        const kind = ["agent_message", "tool_call", "tool_call_update", "user_message"][seq % 4]!;
        const payload = { kind, text: "Synthetic", toolCallId: `tool${seq % 17}`,
          toolKind: seq % 8 === 1 ? "agent" : "shell", status: "completed",
          ...(seq % 9 === 0 ? { parentToolUseId: "tool7" } : {}) };
        insert.run(`s${i % 2_000}`, seq, i + 1, i, kind, JSON.stringify(payload));
      }
      legacy.exec("COMMIT");
    } finally { legacy.close(); }

    let backfill = "";
    const originalExec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql: string): void {
      if (sql.startsWith("INSERT INTO session_tool_call_counts")) backfill = sql;
      return originalExec.call(this, sql);
    };
    let db: ControlPlaneDb;
    try { db = ControlPlaneDb.open(location); }
    finally { DatabaseSync.prototype.exec = originalExec; }
    try {
      const raw = db.raw();
      assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM session_events").get()!.n, 200_000);
      assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n, 2_000);
      assertCounts(db);
      assert.deepEqual(indexDefinitions(raw), expectedIndexes);
      const queries = captureProjectionQueries(db);
      const counterQueries = captureTriggerProbes(raw);
      assert.ok(backfill.startsWith("INSERT INTO session_tool_call_counts"), "capture the real first-open backfill");
      const backfillSelect = backfill.slice(backfill.indexOf("SELECT session_id"));
      counterQueries.push({ name: "actual counter backfill", sql: backfillSelect, args: [] });
      counterQueries.push({ name: "independent distinct-count oracle", sql: DISTINCT_SQL, args: ["s0"] });
      const allQueries = [...queries, ...counterQueries];

      // Recreate the legacy prefix only in this synthetic fixture to compare the exact callers.
      raw.exec(LEGACY_PREFIX_SQL);
      const before = allQueries.map(query => raw.prepare(query.sql).all(...query.args));
      const originalCalls = { candidates: db.listAgentToolCallIds("s0", 0, 100),
        page: db.listChildSessionProjectionPage("s0", ["tool7"], 0, 100, 30) };
      assert.ok(originalCalls.candidates.length > 0);
      assert.ok(originalCalls.page.length > 0);
      raw.exec(`DROP INDEX ${PREFIX}`);
      for (const [i, query] of allQueries.entries()) {
        assert.deepEqual(raw.prepare(query.sql).all(...query.args), before[i], query.name);
        const plan = raw.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.args)
          .map(row => String(row.detail)).join("\n");
        assert.doesNotMatch(plan, /SCAN session_events(?! USING)/, `${query.name}: no retained-table scan`);
        if (counterQueries.includes(query)) {
          assert.match(plan, /USING (?:COVERING )?INDEX idx_session_events_tool_call_id\b/, query.name);
          // SQLite omits the COVERING label for expression indexes. Verify the actual VM does
          // not fetch event-table columns: all data needed by these counter queries is in the index.
          const rootpage = Number(raw.prepare("SELECT rootpage FROM sqlite_master WHERE name='session_events'").get()!.rootpage);
          const instructions = raw.prepare(`EXPLAIN ${query.sql}`).all(...query.args);
          const tableCursors = new Set(instructions.filter(row => row.opcode === "OpenRead" && Number(row.p2) === rootpage)
            .map(row => Number(row.p1)));
          assert.deepEqual(instructions.filter(row => row.opcode === "Column" && tableCursors.has(Number(row.p1))), [], query.name);
        } else if (query.name.includes("agent candidates")) {
          assert.match(plan, /USING (?:COVERING )?INDEX idx_session_events_agent_spawn_id\b/);
        } else {
          for (const name of [WIDER, "idx_session_events_tool_update_id", "idx_session_events_parent_tool_use_id"]) {
            assert.ok(plan.includes(name), `${query.name}: ${name}`);
          }
        }
      }
      assert.deepEqual(db.listAgentToolCallIds("s0", 0, 100), originalCalls.candidates);
      assert.deepEqual(db.listChildSessionProjectionPage("s0", ["tool7"], 0, 100, 30), originalCalls.page);
      assert.deepEqual(indexDefinitions(raw), expectedIndexes);
      assertCounts(db);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
