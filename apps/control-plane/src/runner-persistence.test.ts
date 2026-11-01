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
    assert.equal(calls, 2);
  }, () => {});
  calls = 0;
  await withRunnerPersistenceRetry(async () => {
    assert.throws(() => db.exec("BEGIN; SELECT 1; COMMIT"), (error) => error === busy);
    assert.equal(calls, 1);
  }, () => {});
});
