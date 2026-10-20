// Synthetic-only FTS deletion benchmark (#3315). Measures the production search cleanup helper
// separately from unrelated session cascades, with secure-delete enabled by ControlPlaneDb.open.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { ControlPlaneDb } from "../src/db.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID } from "../src/identity.js";

const TARGET_ROWS = 200;
const TRIALS = 5;
for (const indexedRows of [20_000, 100_000, 400_000, 1_000_000]) {
  const db = ControlPlaneDb.open(":memory:");
  try {
    for (const id of ["target", "background"]) {
      db.createSession({ id, runnerId: "synthetic", workspaceId: null, agentId: "agent", title: id,
        useWorktree: false, driver: "claude-code", config: {}, now: 1,
        scope: { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "user", userId: LOCAL_OWNER_USER_ID } } });
    }
    const sql = db.raw();
    const event = sql.prepare(`INSERT INTO session_events(id,session_id,seq,ts,kind,payload)
      VALUES (?,?,?,1,'command_output','{"kind":"command_output","text":"synthetic"}')`);
    const search = sql.prepare("INSERT INTO session_events_fts(rowid,text,session_id,seq) VALUES (?,?,?,?)");
    sql.exec("BEGIN");
    for (let index = 1; index <= indexedRows; index++) {
      const sessionId = index <= TARGET_ROWS ? "target" : "background";
      event.run(index, sessionId, index);
      search.run(index, `synthetic output word${index % 997} group${index % 53}`, sessionId, index);
    }
    sql.exec("COMMIT");
    assert.equal(db.legacySearchRowsPending(), false);
    const cleanup = db as unknown as { deleteSessionSearchRows(sessionId: string): void };
    const scan = sql.prepare("DELETE FROM session_events_fts WHERE session_id=?");
    const samples = { scan: [] as number[], keyed: [] as number[] };
    for (let trial = -1; trial < TRIALS; trial++) {
      // Alternate order; roll back after each measurement so both methods remove identical rows.
      for (const method of trial % 2 ? ["keyed", "scan"] as const : ["scan", "keyed"] as const) {
        sql.exec("BEGIN");
        const started = performance.now();
        if (method === "scan") scan.run("target");
        else cleanup.deleteSessionSearchRows("target");
        const elapsed = performance.now() - started;
        assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM session_events_fts WHERE session_id='target'").get()!.n, 0);
        sql.exec("ROLLBACK");
        if (trial >= 0) samples[method].push(elapsed);
      }
    }
    const median = (values: number[]) => Number(values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!.toFixed(3));
    console.log(JSON.stringify({ indexedRows, targetRows: TARGET_ROWS, trials: TRIALS,
      scanMedianMs: median(samples.scan), keyedMedianMs: median(samples.keyed),
      scanSamplesMs: samples.scan, keyedSamplesMs: samples.keyed }));
  } finally { db.close(); }
}
