import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ControlPlaneDb } from "./db.js";

function snapshot(raw: DatabaseSync) {
  return {
    events: raw.prepare("SELECT * FROM session_events ORDER BY id").all(),
    accounting: raw.prepare(`SELECT id,parent_session_id,status,cost_usd,
      child_cost_reserved_usd,child_tool_calls_reserved,parent_reserved_cost_usd,
      parent_reserved_tool_calls,parent_charged_cost_usd,parent_charged_tool_calls,
      usage_peak_cost_usd,usage_peak_tool_calls FROM sessions ORDER BY id`).all(),
    triggers: raw.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger'
      AND name LIKE 'sessions_%charge' ORDER BY name`).all(),
    indexes: raw.prepare(`SELECT name,sql FROM sqlite_master WHERE type='index'
      AND tbl_name='session_events' AND sql IS NOT NULL ORDER BY name`).all(),
    counters: raw.prepare("SELECT * FROM session_tool_call_counts ORDER BY session_id").all(),
  };
}

function seed(location: string): void {
  const db = ControlPlaneDb.open(location);
  try {
    db.registerRunner({ runnerId: "synthetic", hostname: "synthetic", os: "linux",
      version: "test", workspaces: [], agents: [] }, 1);
    for (const id of ["parent", "child"]) {
      db.createSession({ id, runnerId: "synthetic", workspaceId: null, agentId: "synthetic",
        title: "Synthetic", useWorktree: false, driver: "acp", config: {}, now: 1 });
    }
    db.raw().exec(`UPDATE sessions SET status='running',parent_session_id='parent',
      parent_reserved_cost_usd=5,parent_reserved_tool_calls=7,
      parent_charged_cost_usd=5,parent_charged_tool_calls=7 WHERE id='child';
      UPDATE sessions SET child_cost_reserved_usd=5,child_tool_calls_reserved=7 WHERE id='parent';`);
    for (const toolCallId of ["a", "a", "b"]) {
      db.appendEvent("child", { kind: "tool_call", toolCallId, title: "Synthetic", status: "pending" }, 2);
    }
  } finally { db.close(); }
}

for (const rollbackFails of [false, true]) {
  for (const closeFailure of ["none", "before", "after"] as const) {
    test(`child-charge startup preserves its native error and recovery (rollback=${rollbackFails}, close=${closeFailure})`, () => {
      const root = mkdtempSync(join(tmpdir(), "wollipog-child-charge-startup-"));
      const location = join(root, "synthetic.db");
      const originalExec = DatabaseSync.prototype.exec;
      const originalClose = DatabaseSync.prototype.close;
      const failedHandles: DatabaseSync[] = [];
      const closeFixtureHandle = (handle: DatabaseSync): void => {
        if (handle.isOpen) originalClose.call(handle);
        assert.equal(handle.isOpen, false);
      };
      try {
        seed(location);
        const reader = new DatabaseSync(location);
        let expected: ReturnType<typeof snapshot>;
        try { expected = snapshot(reader); }
        finally { reader.close(); }
        assert.equal(expected.events.length, 3);
        assert.equal(expected.triggers.length, 4);
        assert.ok(expected.indexes.some(row => row.name === "idx_session_events_tool_call_id"));
        assert.ok(!expected.indexes.some(row => row.name === "idx_session_events_tool_call"));

        for (let attempt = 0; attempt < 3; attempt++) {
          let failedHandle: DatabaseSync | undefined;
          let installationError: unknown;
          let rollbackAttempts = 0;
          let closeAttempts = 0;
          let rollbackFaults = 0;
          let closeFaults = 0;
          const rollbackError = new Error("synthetic rollback failure");
          const closeError = new Error("synthetic close failure");
          DatabaseSync.prototype.exec = function(sql: string): void {
            if (sql.trimStart().startsWith("DROP TRIGGER IF EXISTS sessions_settle_child_charge;")) {
              failedHandle = this;
              failedHandles.push(this);
              assert.equal(this.isTransaction, true);
              assert.deepEqual(snapshot(this), expected);
              // Deliberate transaction-local instrumentation, not a persisted corruption case.
              // Forward production SQL unchanged: SQLite itself must reject the AFTER trigger.
              originalExec.call(this, `ALTER TABLE sessions RENAME TO synthetic_sessions;
                CREATE VIEW sessions AS SELECT * FROM synthetic_sessions;`);
              try { return originalExec.call(this, sql); }
              catch (error) { installationError = error; throw error; }
            }
            if (this === failedHandle && sql === "ROLLBACK") {
              rollbackAttempts++;
              if (rollbackFails) { rollbackFaults++; throw rollbackError; }
            }
            return originalExec.call(this, sql);
          };
          DatabaseSync.prototype.close = function(): void {
            if (this !== failedHandle) return originalClose.call(this);
            closeAttempts++;
            assert.equal(this.isTransaction, rollbackFails,
              "successful rollback ends the transaction before close");
            if (closeFailure === "before") { closeFaults++; throw closeError; }
            originalClose.call(this);
            if (closeFailure === "after") { closeFaults++; throw closeError; }
          };
          try {
            assert.throws(() => ControlPlaneDb.open(location), error => {
              assert.ok(installationError instanceof Error);
              assert.equal((installationError as NodeJS.ErrnoException).code, "ERR_SQLITE_ERROR");
              assert.match(installationError.message, /cannot create AFTER trigger on view: sessions/);
              assert.equal(error, installationError, "cleanup must preserve the native exception object");
              assert.ok(failedHandle);
              assert.equal(rollbackAttempts, 1);
              assert.equal(closeAttempts, 1, "close must be attempted before open throws, even if rollback fails");
              assert.equal(rollbackFaults, Number(rollbackFails));
              assert.equal(closeFaults, Number(closeFailure !== "none"));
              if (closeFailure === "before") {
                assert.equal(failedHandle.prepare("SELECT 1 AS n").get()!.n, 1,
                  "the pre-close fault control must really leave the native handle open");
              } else {
                assert.throws(() => failedHandle!.prepare("SELECT 1"), /database is not open/,
                  "native cleanup must release the connection without GC");
                assert.equal(failedHandle.isOpen, false);
              }
              return true;
            });
          } finally {
            DatabaseSync.prototype.exec = originalExec;
            DatabaseSync.prototype.close = originalClose;
            // A deliberately blocked close is test-owned; never rely on GC to clean it up.
            if (failedHandle) closeFixtureHandle(failedHandle);
          }
          assert.ok(failedHandles.every(handle => !handle.isOpen), "repeated failures retain no open handles");
          const persisted = new DatabaseSync(location);
          try {
            assert.deepEqual(snapshot(persisted), expected);
            assert.equal(persisted.prepare("SELECT type FROM sqlite_master WHERE name='sessions'").get()!.type, "table");
            assert.equal(persisted.prepare("SELECT 1 FROM sqlite_master WHERE name='synthetic_sessions'").get(), undefined);
            assert.deepEqual(persisted.prepare("PRAGMA foreign_key_check").all(), []);
          } finally { persisted.close(); }
        }

        // Retry needs no schema repair after either rollback or native close rolled back the fault.
        const recovered = ControlPlaneDb.open(location);
        try {
          const raw = recovered.raw();
          assert.deepEqual(snapshot(raw), expected);
          assert.equal(raw.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
          assert.equal(raw.prepare("PRAGMA secure_delete").get()!.secure_delete, 1);
          assert.equal(recovered.countToolCalls("child"), 2);
          recovered.appendEvent("child", { kind: "tool_call", toolCallId: "after-retry", title: "Synthetic", status: "pending" }, 3);
          assert.equal(recovered.countToolCalls("child"), 3);
          assert.equal(raw.prepare("SELECT child_tool_calls_reserved AS n FROM sessions WHERE id='parent'").get()!.n, 7);
          raw.exec("UPDATE sessions SET status='completed' WHERE id='child'");
          assert.equal(raw.prepare("SELECT child_tool_calls_reserved AS n FROM sessions WHERE id='parent'").get()!.n, 3);
          assert.equal(raw.prepare("SELECT parent_charged_tool_calls AS n FROM sessions WHERE id='child'").get()!.n, 3);
          assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
        } finally { recovered.close(); }
      } finally {
        DatabaseSync.prototype.exec = originalExec;
        DatabaseSync.prototype.close = originalClose;
        for (const handle of failedHandles) closeFixtureHandle(handle);
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
