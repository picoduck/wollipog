import assert from "node:assert/strict";
import test from "node:test";
import type { SessionStatus } from "@wollipog/protocol";
import {
  archiveSessionsWithCompensation,
  sessionArchiveActionLabel,
  sessionArchiveRequiresStop,
  setArchivedForSessions,
} from "./archive-actions.js";

test("bulk archive applies every id and needs no compensation on success", async () => {
  const calls: Array<[string, boolean]> = [];
  const result = await archiveSessionsWithCompensation(["a", "b"], async (id, archived) => { calls.push([id, archived]); });
  assert.deepEqual(result, { ok: true, pendingSessionIds: [] });
  assert.deepEqual(calls, [["a", true], ["b", true]]);
});

test("bulk archive reports exact sessions still waiting for Stop evidence", async () => {
  const result = await archiveSessionsWithCompensation(["a", "b", "c"], async (id) => ({
    archived: id === "a",
    archiveStatus: id === "a" ? undefined : "stop_pending",
  }));

  assert.deepEqual(result, { ok: true, pendingSessionIds: ["b", "c"] });
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

test("archive action labels disclose when archiving will stop runtime work", () => {
  const statuses: SessionStatus[] = [
    "queued",
    "starting",
    "running",
    "input_required",
    "idle",
    "completed",
    "failed",
    "stopped",
  ];
  for (const status of statuses) {
    const requiresStop = !["completed", "failed", "stopped"].includes(status);
    const session = { archived: false, status };
    assert.equal(sessionArchiveRequiresStop(session, true), requiresStop, status);
    assert.equal(sessionArchiveActionLabel(session, true), requiresStop ? "Archive and Stop" : "Archive", status);
  }
});

test("older control planes do not receive unsupported Stop disclosure", () => {
  const session = { archived: false, status: "running" as const };
  assert.equal(sessionArchiveRequiresStop(session, false), false);
  assert.equal(sessionArchiveActionLabel(session, false), "Archive");
});

test("stop-pending and archived sessions retain truthful action labels", () => {
  assert.equal(
    sessionArchiveActionLabel({ archived: false, status: "stopped", archiveStatus: "stop_pending" }, false),
    "Archive and Stop",
  );
  assert.equal(
    sessionArchiveActionLabel({ archived: true, status: "running", archiveStatus: "stop_pending" }, false),
    "Unarchive",
  );
});
