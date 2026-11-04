import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { isSqliteBusy, runnerRetryConnection, withRunnerPersistenceRetry } from "./runner-persistence.js";

const busy = Object.assign(new Error("database is locked"), { errcode: 5 });

test("savepoint stores wait for a real writer, preserving nested rollback and outer commit", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "runner-savepoint-"));
  const path = join(dir, "state.db");
  const native = new DatabaseSync(path, { timeout: 250 });
  native.exec("PRAGMA journal_mode=WAL; CREATE TABLE runners(runner_id TEXT PRIMARY KEY)");
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData);
    db.exec('BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    parentPort.once('message', () => setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300));
  `, { eval: true, workerData: path });
  const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
  t.after(async () => {
    await worker.terminate();
    native.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => { worker.once("message", () => resolve()); worker.once("error", reject); });
  const db = runnerRetryConnection(native);
  const reports: boolean[] = [];
  await withRunnerPersistenceRetry(async () => {
    db.exec("SAVEPOINT outer_store");
    db.prepare("SELECT * FROM runners").all();
    db.prepare("INSERT INTO runners VALUES (?)").run("committed");
    db.exec("SAVEPOINT nested_store");
    db.prepare("INSERT INTO runners VALUES (?)").run("rolled-back");
    db.exec("ROLLBACK TO nested_store; RELEASE nested_store");
    db.exec("RELEASE outer_store");
  }, (_, exhausted) => {
    if (reports.length === 0) worker.postMessage("release after first busy wait");
    reports.push(exhausted);
  });
  assert.equal(await exited, 0);
  assert.deepEqual(reports, [false, false]);
  assert.deepEqual(db.prepare("SELECT runner_id FROM runners").all().map((row) => row.runner_id), ["committed"]);
  db.exec("BEGIN IMMEDIATE; ROLLBACK"); // RELEASE left no enclosing transaction behind.

  // Admission happens before the component store enters its try/catch. Exhaustion must unwind
  // that unopened store scope itself.
  const secondWriter = new DatabaseSync(path);
  try {
    secondWriter.exec("BEGIN IMMEDIATE");
    db.exec("PRAGMA busy_timeout=1");
    const exhausted: boolean[] = [];
    await withRunnerPersistenceRetry(async () => {
      assert.throws(() => db.exec("SAVEPOINT refused_store"), isSqliteBusy);
    }, (_, value) => exhausted.push(value));
    assert.equal(exhausted.at(-1), true);
    db.exec("BEGIN; ROLLBACK"); // No leaked root savepoint despite failed admission.
  } finally {
    secondWriter.close();
  }
});

test("only base SQLITE_BUSY is retried, with a shared three-retry budget across awaits", async () => {
  assert.equal(isSqliteBusy(busy), true);
  for (const error of [null, new Error("database is locked"), { errcode: 517 }, { errcode: 6 }]) {
    assert.equal(isSqliteBusy(error), false);
  }
  let calls = 0;
  let failures = 2;
  const db = runnerRetryConnection({
    exec() { calls++; if (failures-- > 0) throw busy; },
  } as unknown as DatabaseSync);
  assert.throws(() => db.exec("BEGIN IMMEDIATE"), (error) => error === busy);
  calls = 0;
  failures = 2;
  const reports: Array<[number, boolean]> = [];
  await withRunnerPersistenceRetry(async () => {
    db.exec("BEGIN IMMEDIATE");
    await Promise.resolve();
    failures = 10;
    assert.throws(() => db.exec("BEGIN IMMEDIATE"), (error) => error === busy);
  }, (retries, exhausted) => reports.push([retries, exhausted]));
  assert.equal(calls, 5);
  assert.deepEqual(reports, [[0, false], [1, false], [2, false], [3, true]]);
});

test("elapsed time stops retries even before the count is spent; scripts never replay", async (t) => {
  let clock = 1;
  t.mock.method(performance, "now", () => clock);
  let calls = 0;
  const db = runnerRetryConnection({ exec() { calls++; clock += 1001; throw busy; } } as unknown as DatabaseSync);
  await withRunnerPersistenceRetry(async () => {
    assert.throws(() => db.exec("BEGIN IMMEDIATE"), (error) => error === busy);
    assert.equal(calls, 1);
  }, () => {});
  calls = 0;
  await withRunnerPersistenceRetry(async () => {
    assert.throws(() => db.exec("BEGIN; SELECT 1; COMMIT"), (error) => error === busy);
    assert.equal(calls, 1);
  }, () => {});
});

test("cooperative processing time does not consume the cumulative contention budget", async (t) => {
  let clock = 1;
  t.mock.method(performance, "now", () => clock);
  let failures = 1;
  const db = runnerRetryConnection({ exec() { clock += 50; if (failures-- > 0) throw busy; } } as unknown as DatabaseSync);
  const reports: boolean[] = [];
  await withRunnerPersistenceRetry(async () => {
    db.exec("BEGIN");
    await Promise.resolve();
    clock += 20_000;
    failures = 1;
    db.exec("BEGIN");
  }, (_, exhausted) => reports.push(exhausted));
  assert.deepEqual(reports, [false, false]);
});

test("only runner-scoped deferred transaction boundaries acquire write intent", async () => {
  const calls: string[] = [];
  const db = runnerRetryConnection({ exec(sql: string) { calls.push(sql); } } as unknown as DatabaseSync);
  db.exec("BEGIN");
  await withRunnerPersistenceRetry(async () => {
    db.exec("BEGIN");
    db.exec("BEGIN DEFERRED TRANSACTION;");
    db.exec("BEGIN; SELECT 1; COMMIT");
  }, () => {});
  assert.deepEqual(calls, ["BEGIN", "BEGIN IMMEDIATE", "BEGIN IMMEDIATE", "BEGIN; SELECT 1; COMMIT"]);
});
