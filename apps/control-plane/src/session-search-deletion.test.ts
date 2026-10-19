import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlPlaneDb } from "./db.js";

const paths = ["deleteSession", "clearSessionEvents", "reconcileRunnerHistory", "deleteRunner", "deleteBox"] as const;
for (const path of paths) {
  for (const pending of [false, true]) {
    test(`${path} removes keyed, legacy and collision-fallback search rows (mapping pending: ${pending})`, () => {
      const db = ControlPlaneDb.open(":memory:");
      try {
        db.createBox({ boxId: "box", runnerId: "runner", sshTarget: "synthetic", sshPort: 22,
          workspaces: [], autoReconnect: false, runnerDataDir: null, now: 1 });
        for (const runnerId of ["runner", "other"]) {
          db.registerRunner({ runnerId, hostname: "synthetic", os: "linux", version: "test", workspaces: [], agents: [] }, 1);
        }
        for (const [id, runnerId] of [["target", "runner"], ["sibling", "runner"], ["keeper", "other"]] as const) {
          db.createSession({ id, runnerId, workspaceId: null, agentId: "agent", title: id,
            useWorktree: false, driver: "claude-code", config: {}, now: 1 });
        }
        const sql = db.raw();
        const legacy = db.appendEvent("target", { kind: "command_output", text: "legacysecret" }, 2);
        sql.prepare("UPDATE session_events_fts SET rowid=900001 WHERE rowid=?").run(legacy.id);
        sql.prepare("INSERT OR REPLACE INTO control_plane_metadata VALUES ('session_events_fts_legacy_scan', ?)")
          .run(JSON.stringify({ cursor: 0, end: 900001 }));
        db.appendEvent("target", { kind: "user_message", text: "keyedsecret" }, 3);
        // Another session's legacy row occupies the id of an event with no searchable text.
        const keeper = db.appendEvent("keeper", { kind: "user_message", text: "keepword" }, 4);
        const nextId = Number(keeper.id) + 1;
        sql.prepare("UPDATE session_events_fts SET rowid=CAST(? AS INTEGER) WHERE rowid=?").run(nextId, keeper.id);
        sql.prepare("INSERT INTO session_events_fts_legacy_rowids VALUES (?, ?)").run(keeper.id, nextId);
        db.appendEvent("target", { kind: "token_usage", inputTokens: 1, outputTokens: 1 }, 5);
        const collisionId = nextId + 1;
        // Force insertSearchRow's recorded fallback, then remove the temporary occupant.
        sql.prepare("INSERT INTO session_events_fts(rowid,text,session_id,seq) VALUES (?,'temporary','keeper',999)")
          .run(collisionId);
        const collision = db.appendEvent("target", { kind: "command_output", text: "fallbacksecret" }, 6);
        assert.equal(Number(collision.id), collisionId);
        sql.prepare("DELETE FROM session_events_fts WHERE rowid=?").run(collisionId);
        db.appendEvent("sibling", { kind: "user_message", text: "siblingword" }, 7);
        db.reconcileRunnerHistory("target", 1, 4);
        if (!pending) {
          while (db.mapLegacySearchRows(2).pending) { /* complete the real legacy mapping */ }
          assert.equal(sql.prepare("SELECT fts_rowid FROM session_events_fts_legacy_rowids WHERE event_id=?").get(legacy.id)!.fts_rowid, 900001);
        }
        assert.equal(db.legacySearchRowsPending(), pending);
        // Exercise the real paths while guarding against the UNINDEXED session predicate.
        const target = db as unknown as { stmt: (query: string) => ReturnType<typeof sql.prepare> };
        const original = target.stmt;
        const scans: string[] = [];
        target.stmt = function(query) {
          if (/DELETE FROM session_events_fts WHERE session_id/.test(query)) scans.push(query);
          return original.call(this, query);
        };
        if (path === "reconcileRunnerHistory") db.reconcileRunnerHistory("target", 2, 0);
        else if (path === "deleteRunner") db.deleteRunner("runner");
        else if (path === "deleteBox") db.deleteBox("box");
        else db[path]("target");
        assert.equal(scans.length, pending ? 1 : 0,
          "mapping pending permits one scan total, including runner/box deletion with multiple sessions");
        assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM session_events_fts WHERE session_id='target'").get()!.n, 0);
        for (const term of ["legacysecret", "keyedsecret", "fallbacksecret"]) {
          assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM session_events_fts WHERE session_events_fts MATCH ?").get(term)!.n, 0);
        }
        assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM session_events_fts WHERE session_events_fts MATCH 'keepword'").get()!.n, 1);
        const bulk = path === "deleteRunner" || path === "deleteBox";
        assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM session_events_fts WHERE session_id='sibling'").get()!.n, bulk ? 0 : 1);
        assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM session_events_fts_legacy_rowids WHERE event_id=?").get(legacy.id)!.n, 0);
        if (pending) {
          while (db.mapLegacySearchRows(2).pending) { /* finish mapping after deletion */ }
          assert.equal(db.legacySearchRowsPending(), false);
        }
      } finally { db.close(); }
    });
  }
}
