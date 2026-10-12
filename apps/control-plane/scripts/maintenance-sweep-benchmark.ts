import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { ControlPlaneDb } from "../src/db.js";
import { captureMaintenanceQueries, seedMaintenanceFixture } from "./maintenance-benchmark-fixture.js";

const { values } = parseArgs({ options: { dir: { type: "string" }, memory: { type: "boolean" } } });
// No database-path input: every invocation creates a fresh, disposable synthetic database.
const root = mkdtempSync(join(values.dir ?? tmpdir(), "wollipog-maintenance-sweeps-"));
const db = ControlPlaneDb.open(values.memory ? ":memory:" : join(root, "synthetic.db"));
try {
  const counts = seedMaintenanceFixture(db);
  const raw = db.raw();
  const plans = captureMaintenanceQueries(db).map(query => {
    const plan = raw.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.args);
    const samplesMs: number[] = [];
    const statement = raw.prepare(query.sql);
    for (let repetition = 0; repetition < 7; repetition++) {
      raw.exec("BEGIN");
      try {
        const started = performance.now();
        if (/^\s*(SELECT|WITH)/i.test(query.sql)) statement.all(...query.args);
        else statement.run(...query.args);
        samplesMs.push(performance.now() - started);
      } finally {
        raw.exec("ROLLBACK");
      }
    }
    return { ...query, plan, samplesMs, medianMs: [...samplesMs].sort((a, b) => a - b)[3] };
  });
  console.log(JSON.stringify({ node: process.version, memory: Boolean(values.memory), counts, plans }, null, 2));
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
