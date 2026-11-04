import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ControlPlaneDb } from "../src/db.js";
import { IncrementalVacuum, INCREMENTAL_VACUUM_ENV } from "../src/incremental-vacuum.js";

const dirIndex = process.argv.indexOf("--dir");
const parent = dirIndex < 0 ? tmpdir() : resolve(process.argv[dirIndex + 1] ?? ".");
// --dir chooses a fixture parent only. Never accept a production database filename.
const dir = mkdtempSync(join(parent, "incremental-vacuum-benchmark-"));
const path = join(dir, "control-plane.db");
const db = ControlPlaneDb.open(path, { incrementalVacuum: true });
let traffic: ReturnType<typeof setInterval> | undefined;
let worker: IncrementalVacuum | undefined;
try {
  db.raw().exec(`CREATE TABLE vacuum_fixture(id INTEGER PRIMARY KEY, bucket INTEGER, content TEXT);
    CREATE INDEX vacuum_fixture_bucket ON vacuum_fixture(bucket); BEGIN`);
  const insert = db.raw().prepare("INSERT INTO vacuum_fixture VALUES (?,?,?)");
  for (let i = 0; i < 16_000; i++) insert.run(i, i % 100, `record-${i}-` + "x".repeat(2048));
  db.raw().exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE); DELETE FROM vacuum_fixture WHERE id%5<>0; PRAGMA wal_checkpoint(TRUNCATE)");
  const before = db.incrementalVacuumStats();
  const bytesBefore = statSync(path).size;
  const rowsBefore = db.raw().prepare("SELECT id,bucket,content FROM vacuum_fixture ORDER BY id").all();
  const checkpointWorker = db.startWalCheckpoints();
  let writes = 0;
  db.raw().exec("CREATE TABLE vacuum_traffic(id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO vacuum_traffic VALUES (1,0)");
  traffic = setInterval(() => { db.raw().prepare("UPDATE vacuum_traffic SET value=? WHERE id=1").run(++writes); }, 5);
  const durations: number[] = [];
  const budgets: number[] = [];
  const original = db.incrementalVacuumStep.bind(db);
  db.incrementalVacuumStep = (pages) => {
    const start = performance.now();
    const result = original(pages);
    durations.push(performance.now() - start); budgets.push(pages);
    return result;
  };
  let now = Date.UTC(2026, 0, 1);
  let deferred = false;
  worker = new IncrementalVacuum(db, { env: { [INCREMENTAL_VACUUM_ENV]: "1" }, now: () => now,
    log: { info() {}, warn(details) { if ((details as { event?: string }).event === "incremental_vacuum_deferred") deferred = true; } } });
  now += 86_400_000;
  const started = performance.now();
  const result = await worker.runPass();
  const durationMs = performance.now() - started;
  clearInterval(traffic); traffic = undefined;
  assert.equal(deferred, false);
  assert.ok(durations.length >= 100, "collect enough real complete steps for a useful p95");
  assert.ok(writes > 0, "ordinary FULL writes make progress between vacuum steps");
  assert.ok(budgets.every((pages) => pages >= 1 && pages <= 32));
  // A slow disk may keep the adaptive budget small and hit the approved 1000-step cap.
  // Partial progress is expected; a benchmark must not demand an entire backlog in one pass.
  assert.ok(result.reclaimedPages > 0);
  db.raw().exec("PRAGMA wal_checkpoint(PASSIVE)");
  assert.ok(statSync(path).size < bytesBefore, "ordinary checkpoint returns reclaimed space to the filesystem");
  assert.deepEqual(db.raw().prepare("SELECT id,bucket,content FROM vacuum_fixture ORDER BY id").all(), rowsBefore);
  assert.equal(db.raw().prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  durations.sort((a, b) => a - b);
  const percentile = (p: number) => durations[Math.ceil(durations.length * p) - 1]!;
  console.log(JSON.stringify({ rows: 16_000, steps: durations.length, writes, checkpointWorker: checkpointWorker !== null,
    freePagesBefore: before.freePages, reclaimedPages: result.reclaimedPages, bytesBefore, bytesAfter: statSync(path).size,
    maxPagesPerStep: Math.max(...budgets), pagesPerStep: result.reclaimedPages / result.steps,
    reclaimedMiB: result.reclaimedBytes / 1024 ** 2, durationMs,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: durations.at(-1) }));
  assert.ok(percentile(0.95) < 16, "complete incremental vacuum step p95 must stay below 16 ms");
} finally {
  if (traffic) clearInterval(traffic);
  worker?.stop(); db.close(); rmSync(dir, { recursive: true, force: true });
}
