import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { ControlPlaneDb } from "./db.js";
import { seedDelegatedUiEvidence } from "../../web/e2e/fixtures/delegated-ui-evidence-seed.js";

test("live evidence seeding waits at registration admission before reading a WAL snapshot", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "remote-evidence-contention-"));
  const database = join(root, "state.db");
  ControlPlaneDb.open(database).close();
  const writer = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData);
    db.exec('BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    parentPort.once('message', () => setTimeout(() => { db.exec('COMMIT'); db.close(); parentPort.close(); }, 300));
  `, { eval: true, workerData: database });
  const exited = new Promise<number>((resolve) => writer.once("exit", resolve));
  t.after(async () => { await writer.terminate(); rmSync(root, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => { writer.once("message", () => resolve()); writer.once("error", reject); });
  // Release independently of this thread's synchronous SQLite calls. Deferred registration
  // can read here but its subsequent upgrade fails immediately, bypassing the busy timeout.
  const register = ControlPlaneDb.prototype.registerRunner;
  t.mock.method(ControlPlaneDb.prototype, "registerRunner", function(this: ControlPlaneDb,
    ...args: Parameters<ControlPlaneDb["registerRunner"]>) {
    writer.postMessage("release");
    return register.apply(this, args);
  });
  const seeded = seedDelegatedUiEvidence(database, root, "human", { live: true });
  assert.equal(await exited, 0);
  const db = ControlPlaneDb.attach(database);
  try {
    assert.equal(db.getSession(seeded.childId)?.title, "Evidence Child");
    assert.equal(db.raw().prepare("SELECT status FROM workflow_decisions WHERE occurrence_id=?").get(seeded.occurrenceId)?.status, "pending");
    assert.equal(db.raw().prepare("SELECT count(*) AS n FROM runners").get()?.n, 1);
    db.raw().exec("BEGIN IMMEDIATE; ROLLBACK");
  } finally { db.close(); }
});

test("evidence seed succeeds without a competing writer and closes on registration failure", (t) => {
  const root = mkdtempSync(join(tmpdir(), "remote-evidence-control-"));
  const database = join(root, "state.db");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seeded = seedDelegatedUiEvidence(database, root, "human");
  const db = ControlPlaneDb.attach(database);
  try { assert.equal(db.getSession(seeded.childId)?.title, "Evidence Child"); }
  finally { db.close(); }
  let opened: ControlPlaneDb | undefined;
  const failure = new Error("inert seed failure");
  t.mock.method(ControlPlaneDb.prototype, "registerRunner", function(this: ControlPlaneDb) { opened = this; throw failure; });
  assert.throws(() => seedDelegatedUiEvidence(database, root, "human", { live: true }), (error) => error === failure);
  assert.ok(opened);
  assert.throws(() => opened!.raw().prepare("SELECT 1"), /not open|closed/i);
});

test("exhausted registration admission leaves no partial fixture or open connection", (t) => {
  const root = mkdtempSync(join(tmpdir(), "remote-evidence-exhaustion-"));
  const database = join(root, "state.db");
  ControlPlaneDb.open(database).close();
  const writer = new DatabaseSync(database);
  t.after(() => { writer.close(); rmSync(root, { recursive: true, force: true }); });
  const attach = ControlPlaneDb.attach.bind(ControlPlaneDb);
  let attached: ControlPlaneDb | undefined;
  t.mock.method(ControlPlaneDb, "attach", (path: string) => {
    attached = attach(path);
    // Exercise timeout exhaustion quickly, without changing the product's timeout or retries.
    attached.raw().exec("PRAGMA busy_timeout=1");
    return attached;
  });
  writer.exec("BEGIN IMMEDIATE");
  assert.throws(() => seedDelegatedUiEvidence(database, root, "human", { live: true }),
    (error: unknown) => (error as { errcode?: number }).errcode === 5);
  assert.ok(attached);
  assert.throws(() => attached!.raw().prepare("SELECT 1"), /not open|closed/i);
  assert.equal(writer.prepare("SELECT count(*) AS n FROM runners").get()?.n, 0);
  assert.equal(writer.prepare("SELECT count(*) AS n FROM sessions").get()?.n, 0);
  writer.exec("ROLLBACK");
});

test("registration inside an existing transaction leaves commit and rollback to its caller", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    db.raw().exec("BEGIN IMMEDIATE");
    db.registerRunner({ runnerId: "outer", hostname: "fixture", os: "linux", version: "test", workspaces: [], agents: [] },
      Date.now(), null, undefined, false);
    assert.equal(db.raw().isTransaction, true);
    assert.equal(db.raw().prepare("SELECT count(*) AS n FROM runners").get()?.n, 1);
    db.raw().exec("ROLLBACK");
    assert.equal(db.raw().prepare("SELECT count(*) AS n FROM runners").get()?.n, 0);
  } finally { db.close(); }
});
