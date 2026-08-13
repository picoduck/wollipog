import assert from "node:assert/strict";
import test from "node:test";
import { archiveSessionsWithCompensation, setArchivedForSessions } from "./archive-actions.js";

test("bulk archive applies every id and needs no compensation on success", async () => {
  const calls: Array<[string, boolean]> = [];
  const result = await archiveSessionsWithCompensation(["a", "b"], async (id, archived) => { calls.push([id, archived]); });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [["a", true], ["b", true]]);
});

test("bulk archive compensates every exact id after any rejected response", async () => {
  const calls: Array<[string, boolean]> = [];
  const result = await archiveSessionsWithCompensation(["a", "b", "c"], async (id, archived) => {
    calls.push([id, archived]);
    if (archived && id === "b") throw new Error("archive failed");
    if (!archived && id === "c") throw new Error("rollback failed");
  });
  assert.deepEqual(result, { ok: false, archiveFailures: 1, rollbackFailures: 1 });
  assert.deepEqual(calls, [
    ["a", true], ["b", true], ["c", true],
    ["a", false], ["b", false], ["c", false],
  ]);
});

test("idempotent restore attempts every id and returns the exact failure count", async () => {
  const attempted: string[] = [];
  const failures = await setArchivedForSessions(["a", "b", "c"], false, async (id) => {
    attempted.push(id);
    if (id !== "b") throw new Error("offline");
  });
  assert.equal(failures, 2);
  assert.deepEqual(attempted, ["a", "b", "c"]);
});
