import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlPlaneDb } from "./db.js";
import {
  MutationAuditArchiveRetention, MUTATION_AUDIT_ARCHIVE_RETENTION_ENV as ENV,
  MUTATION_AUDIT_ARCHIVE_STARTUP_MS, MUTATION_AUDIT_ARCHIVE_INTERVAL_MS,
  parseMutationAuditArchiveRetention,
} from "./mutation-audit-archive-retention.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
function seed(db: ControlPlaneDb, id: string, createdAt: number, archivedAt = T0): void {
  db.raw().prepare(`INSERT INTO mutation_audit_archive
    (audit_id, actor_kind, organization_id, method, route, status_code, created_at, archived_at)
    VALUES (?, 'anonymous', NULL, 'POST', '/api/sessions', 200, ?, ?)`).run(id, createdAt, archivedAt);
}
function ids(db: ControlPlaneDb): string[] {
  return (db.raw().prepare("SELECT audit_id FROM mutation_audit_archive ORDER BY audit_id").all() as
    { audit_id: string }[]).map((row) => row.audit_id);
}
function setup(db: ControlPlaneDb, value?: string, sleep: (ms: number) => Promise<void> = async () => {}) {
  const clock = { now: T0 };
  const logs: { level: string; details: Record<string, unknown>; message: string }[] = [];
  const worker = new MutationAuditArchiveRetention(db, { env: value === undefined ? {} : { [ENV]: value },
    now: () => clock.now, sleep,
    log: { info: (details, message) => logs.push({ level: "info", details: { ...details }, message }),
      warn: (details, message) => logs.push({ level: "warn", details: { ...details }, message }) } });
  return { clock, logs, worker };
}

test("host retention parsing is off by default and rejects values outside whole 7–3650 days", async () => {
  for (const value of [undefined, "", " ", "0", "6", "3651", "1.5", "-90", "90 days", "1e2", "NaN"]) {
    assert.equal(parseMutationAuditArchiveRetention(value).retentionDays, null);
    const db = ControlPlaneDb.open(":memory:");
    try {
      seed(db, "old", 1);
      const { clock, logs, worker } = setup(db, value);
      clock.now += 10_000 * DAY;
      assert.equal((await worker.runPass()).removed, 0);
      assert.deepEqual(ids(db), ["old"]);
      assert.equal(logs.some((entry) => entry.details.event === "mutation_audit_archive_retention_invalid"),
        parseMutationAuditArchiveRetention(value).invalid);
      assert.match(logs.find((entry) => entry.details.event === "mutation_audit_archive_retention")!.message, /off/);
    } finally { db.close(); }
  }
  for (const days of [7, 90, 3650]) assert.deepEqual(parseMutationAuditArchiveRetention(` ${days} `),
    { retentionDays: days, invalid: false });
});

test("arming survives reopening; shortening waits 24h, lengthening and off apply immediately", async () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-retention-"));
  const path = join(dir, "db.sqlite");
  let db = ControlPlaneDb.open(path);
  try {
    let h = setup(db, "90");
    assert.equal(db.getMutationAuditArchiveRetention().prunesFrom, T0 + DAY);
    seed(db, "old", T0 - 400 * DAY);
    h.clock.now = T0 + DAY - 1;
    assert.equal((await h.worker.runPass()).removed, 0);
    db.close(); db = ControlPlaneDb.open(path);
    h = setup(db, "90");
    assert.equal(db.getMutationAuditArchiveRetention().prunesFrom, T0 + DAY);
    h.clock.now = T0 + DAY;
    assert.equal((await h.worker.runPass()).removed, 1);
    h.worker.stop();
    h = setup(db, "30");
    assert.equal(db.getMutationAuditArchiveRetention().prunesFrom, T0 + DAY);
    // Move startup forward to distinguish the new 24-hour delay from the previous deadline.
    h.worker.stop();
    db.saveMutationAuditArchiveRetentionPolicy(90, T0 - DAY);
    new MutationAuditArchiveRetention(db, { env: { [ENV]: "30" }, now: () => T0 + 2 * DAY,
      log: { info() {}, warn() {} } });
    assert.equal(db.getMutationAuditArchiveRetention().prunesFrom, T0 + 3 * DAY);
    setup(db, "180");
    assert.equal(db.getMutationAuditArchiveRetention().prunesFrom, T0 + 3 * DAY,
      "lengthening adds no further delay and preserves an existing pending deadline");
    const off = setup(db);
    assert.equal(db.getMutationAuditArchiveRetention().prunesFrom, null);
    seed(db, "kept-off", 1);
    off.clock.now += 1000 * DAY;
    assert.equal((await off.worker.runPass()).removed, 0);
    setup(db, "90");
    assert.equal(db.getMutationAuditArchiveRetention().prunesFrom, T0 + DAY, "reenabling arms anew");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("only strictly old archive rows go; hot completed rows and crash intents are unchanged", async () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const h = setup(db, "90"); h.clock.now += DAY;
    const cutoff = h.clock.now - 90 * DAY;
    seed(db, "old", cutoff - 1, h.clock.now); // Newly archived, originally old.
    seed(db, "boundary", cutoff, 1);
    seed(db, "newer", cutoff + 1, 1);
    for (const statusCode of [0, 200]) db.recordMutationAudit({ auditId: `hot-${statusCode}`,
      principal: null, method: "POST", route: "/api/sessions", statusCode, now: T0 });
    // Arrange old hot rows without invoking the existing unrelated archive sweep.
    db.raw().prepare("UPDATE mutation_audit SET created_at=1").run();
    const hot = db.raw().prepare("SELECT * FROM mutation_audit ORDER BY row_id").all();
    assert.equal((await h.worker.runPass()).removed, 1);
    assert.deepEqual(ids(db), ["boundary", "newer"]);
    assert.deepEqual(db.raw().prepare("SELECT * FROM mutation_audit ORDER BY row_id").all(), hot);
    assert.equal(db.completeMutationAudit("hot-0", 503), true);
    assert.equal(db.getMutationAuditArchiveRetention().removedTotal, 1);
    assert.equal(db.getMutationAuditArchiveRetention().lastRemoved, 1);
    assert.equal(db.getMutationAuditArchiveRetention().lastCutoff, cutoff);
    const pass = h.logs.find((entry) => entry.details.event === "mutation_audit_archive_pruned")!;
    assert.equal(pass.details.removed, 1);
    assert.equal(typeof pass.details.runId, "string");
  } finally { db.close(); }
});

test("bounded batches yield, share concurrent passes, stop and resume without losing totals", async () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    for (let i = 0; i < 1600; i++) seed(db, `row-${i}`, 1);
    let worker: MutationAuditArchiveRetention;
    const sleeps: number[] = [];
    const h = setup(db, "7", async (ms) => { sleeps.push(ms); worker.stop(); });
    worker = h.worker; h.clock.now += DAY;
    const first = worker.runPass();
    assert.equal(worker.runPass(), first);
    assert.equal((await first).removed, 100);
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0]! >= 1);
    assert.equal(db.getMutationAuditArchiveRetention().removedTotal, 100);
    const calls: number[] = [];
    const prune = db.pruneMutationAuditArchiveBatch.bind(db);
    db.pruneMutationAuditArchiveBatch = (cutoff, limit) => { calls.push(limit); return prune(cutoff, limit); };
    const next = setup(db, "7", async () => { assert.ok(ids(db).length < 1500); });
    next.clock.now += DAY;
    assert.equal((await next.worker.runPass()).removed, 1500);
    assert.ok(calls.every((limit) => limit >= 1 && limit <= 500));
    assert.equal(db.getMutationAuditArchiveRetention().removedTotal, 1600);
    assert.equal(db.raw().prepare("SELECT * FROM mutation_audit_archive_retention").all().length, 1);
    assert.equal((await next.worker.runPass()).removed, 0);
    assert.equal(db.getMutationAuditArchiveRetention().removedTotal, 1600);
  } finally { db.close(); }
});

test("delete and cumulative counter roll back together; a failed pass retries later", async () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    seed(db, "old", 1);
    const h = setup(db, "7"); h.clock.now += DAY;
    db.raw().exec(`CREATE TRIGGER fail_summary BEFORE UPDATE OF removed_total ON mutation_audit_archive_retention
      BEGIN SELECT RAISE(ABORT, 'injected summary failure'); END;`);
    assert.equal((await h.worker.runPass()).removed, 0);
    assert.deepEqual(ids(db), ["old"]);
    assert.equal(db.getMutationAuditArchiveRetention().removedTotal, 0);
    assert.equal(h.logs.at(-1)!.details.event, "mutation_audit_archive_retention_deferred");
    db.raw().exec("DROP TRIGGER fail_summary");
    assert.equal((await h.worker.runPass()).removed, 1);
    for (const limit of [0, -1, 501, 1.5, NaN]) assert.throws(() => db.pruneMutationAuditArchiveBatch(T0, limit));
    const plan = db.raw().prepare(`EXPLAIN QUERY PLAN SELECT row_id FROM mutation_audit_archive
      WHERE created_at < ? ORDER BY created_at, row_id LIMIT ?`).all(T0, 500);
    assert.match(JSON.stringify(plan), /idx_mutation_audit_archive_age/);
  } finally { db.close(); }
});

test("maintenance waits ten minutes, repeats hourly and stops scheduling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const db = ControlPlaneDb.open(":memory:");
  try {
    const h = setup(db, "7"); h.clock.now += DAY;
    seed(db, "first", 1);
    h.worker.start(); h.worker.start();
    t.mock.timers.tick(MUTATION_AUDIT_ARCHIVE_STARTUP_MS - 1);
    assert.deepEqual(ids(db), ["first"]);
    t.mock.timers.tick(1);
    await h.worker.runPass();
    assert.deepEqual(ids(db), []);
    seed(db, "second", 1);
    t.mock.timers.tick(MUTATION_AUDIT_ARCHIVE_INTERVAL_MS);
    await h.worker.runPass();
    assert.deepEqual(ids(db), []);
    h.worker.stop(); seed(db, "after-stop", 1);
    t.mock.timers.tick(MUTATION_AUDIT_ARCHIVE_INTERVAL_MS * 2);
    assert.deepEqual(ids(db), ["after-stop"]);
  } finally { db.close(); }
});

test("upgrading a populated archive adds the policy/index without deleting historical rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-retention-upgrade-"));
  const path = join(dir, "db.sqlite");
  let db = ControlPlaneDb.open(path);
  try {
    seed(db, "legacy", 1);
    db.raw().exec("DROP INDEX idx_mutation_audit_archive_age; DROP TABLE mutation_audit_archive_retention;");
    db.close(); db = ControlPlaneDb.open(path);
    assert.deepEqual(ids(db), ["legacy"]);
    assert.equal(db.getMutationAuditArchiveRetention().retentionDays, null);
    assert.equal(db.getMutationAuditArchiveRetention().removedTotal, 0);
    assert.equal((db.raw().prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete, 1);
    const plan = db.raw().prepare(`EXPLAIN QUERY PLAN SELECT row_id FROM mutation_audit_archive
      WHERE created_at < ? ORDER BY created_at, row_id LIMIT ?`).all(T0, 500);
    assert.match(JSON.stringify(plan), /idx_mutation_audit_archive_age/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
