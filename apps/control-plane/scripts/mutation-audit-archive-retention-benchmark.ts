import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ControlPlaneDb } from "../src/db.js";
import { MutationAuditArchiveRetention, MUTATION_AUDIT_ARCHIVE_RETENTION_ENV } from "../src/mutation-audit-archive-retention.js";

const dirIndex = process.argv.indexOf("--dir");
const parent = dirIndex < 0 ? tmpdir() : resolve(process.argv[dirIndex + 1] ?? ".");
const dir = mkdtempSync(join(parent, "mutation-audit-benchmark-"));
const db = ControlPlaneDb.open(join(dir, "control-plane.db"));
const ROWS = 50_000;
try {
  const insert = db.raw().prepare(`INSERT INTO mutation_audit_archive
    (audit_id, actor_kind, actor_id, user_id, device_id, organization_id,
     method, route, target_id, status_code, created_at, archived_at)
    VALUES (?, 'human', ?, ?, ?, ?, 'POST', ?, ?, 200, 1, 2)`);
  db.raw().exec("BEGIN");
  for (let i = 0; i < ROWS; i++) insert.run(`audit-${i}`, "a".repeat(64), "u".repeat(64),
    "d".repeat(64), `org-${i % 100}`, "/" + "r".repeat(255), "t".repeat(256));
  db.raw().exec("COMMIT");
  const durations: number[] = [];
  const original = db.pruneMutationAuditArchiveBatch.bind(db);
  db.pruneMutationAuditArchiveBatch = (cutoff, limit) => {
    const start = performance.now();
    const removed = original(cutoff, limit);
    if (removed) durations.push(performance.now() - start);
    return removed;
  };
  let now = Date.UTC(2026, 0, 1);
  const worker = new MutationAuditArchiveRetention(db, {
    env: { [MUTATION_AUDIT_ARCHIVE_RETENTION_ENV]: "90" }, now: () => now,
    log: { info() {}, warn(details, message) { throw new Error(`${message}: ${JSON.stringify(details)}`); } },
  });
  now += 86_400_000;
  const result = await worker.runPass();
  assert.equal(result.removed, ROWS);
  assert.equal(db.getMutationAuditArchiveRetention().removedTotal, ROWS);
  durations.sort((a, b) => a - b);
  const percentile = (p: number) => durations[Math.ceil(durations.length * p) - 1]!;
  console.log(JSON.stringify({ rows: ROWS, batches: durations.length,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: durations.at(-1) }));
  assert.ok(percentile(0.95) < 16, "archive deletion batch p95 must stay below 16 ms");
} finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
