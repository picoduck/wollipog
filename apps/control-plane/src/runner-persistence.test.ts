import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { isSqliteBusy, runnerRetryConnection, withRunnerPersistenceRetry } from "./runner-persistence.js";

const busy = Object.assign(new Error("database is locked"), { errcode: 5 });

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
