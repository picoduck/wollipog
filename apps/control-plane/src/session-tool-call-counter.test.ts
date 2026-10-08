import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import type { RunnerMetadata, SessionEventPayload } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";

/**
 * #2761: a session's tool-call count is a maintained counter, not a COUNT(DISTINCT ...) over its
 * history on every view. It must equal the query it replaced after any write to session_events:
 * duplicate ids, ids SQLite compares by value, missing ids, history replacement, clearing, deletion,
 * and direct row updates and deletes that bypass the database's own methods.
 */

const RUNNER_ID = "counter-runner";
const SESSIONS = ["s-a", "s-b", "s-c"] as const;

/** The query the counter replaced, verbatim. */
const PREVIOUS_COUNT_SQL =
  "SELECT COUNT(DISTINCT json_extract(payload,'$.toolCallId')) AS c FROM session_events WHERE session_id=? AND kind='tool_call'";

function runnerMeta(): RunnerMetadata {
  return {
    runnerId: RUNNER_ID, hostname: "host", os: "linux", version: "1.0.0",
    workspaces: [{ id: "ws", name: "Repo", path: "/tmp/counter" }],
    agents: [{ id: "agent", name: "Agent", command: "claude", args: [], env: {}, driver: "claude-code",
      available: true, context: { kind: "native" } }],
  };
}

function createSession(db: ControlPlaneDb, id: string): void {
  db.createSession({ id, runnerId: RUNNER_ID, workspaceId: "ws", agentId: "agent", title: id,
    useWorktree: false, driver: "claude-code", config: {}, now: 1_000 });
}

function openWithSessions(location = ":memory:"): ControlPlaneDb {
  const db = ControlPlaneDb.open(location);
  db.registerRunner(runnerMeta(), 1_000);
  for (const id of SESSIONS) createSession(db, id);
  return db;
}

function previousCount(db: ControlPlaneDb, sessionId: string): number {
  return Number((db.raw().prepare(PREVIOUS_COUNT_SQL).get(sessionId) as { c: number }).c);
}

function assertCountsMatch(db: ControlPlaneDb, context: string): void {
  for (const id of SESSIONS) {
    assert.equal(db.countToolCalls(id), previousCount(db, id), `${context}: ${id}`);
  }
  const strays = db.raw().prepare(
    `SELECT session_id, tool_calls FROM session_tool_call_counts
      WHERE tool_calls<=0 OR session_id NOT IN (SELECT DISTINCT session_id FROM session_events WHERE kind='tool_call')`,
  ).all();
  assert.deepEqual(strays, [], `${context}: no counter row outlives its session's tool calls`);
}

// Ids that SQLite's DISTINCT and `=` compare by value: 1, 1.0 and true are one id; 1 and "1" are
// two; an object id is its JSON text; a missing or null id never counts.
const TOOL_CALL_IDS: unknown[] = ["a", "b", "c", 1, 1.0, true, "1", 2.5, null, undefined, { x: 1 }, "{\"x\":1}"];

function toolCallPayload(id: unknown, kind: "tool_call" | "tool_call_update" = "tool_call"): SessionEventPayload {
  return (id === undefined
    ? { kind, title: "Run", status: "pending" }
    : { kind, toolCallId: id, title: "Run", status: "pending" }) as unknown as SessionEventPayload;
}

type Operation =
  | { op: "append"; session: number; id: number; runner: boolean }
  | { op: "appendOther"; session: number; id: number; kind: "tool_call_update" | "agent_message" }
  | { op: "deleteRow"; pick: number }
  | { op: "setId"; pick: number; id: number }
  | { op: "setKind"; pick: number; kind: "tool_call" | "tool_call_update" }
  | { op: "move"; pick: number; session: number }
  | { op: "clear"; session: number }
  | { op: "replaceHistory"; session: number }
  | { op: "recreate"; session: number };

const session = fc.nat({ max: SESSIONS.length - 1 });
const toolCallId = fc.nat({ max: TOOL_CALL_IDS.length - 1 });
const pick = fc.nat({ max: 1_000 });
const operation: fc.Arbitrary<Operation> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ op: fc.constant("append" as const), session, id: toolCallId, runner: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("appendOther" as const), session, id: toolCallId,
    kind: fc.constantFrom("tool_call_update" as const, "agent_message" as const) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("deleteRow" as const), pick }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("setId" as const), pick, id: toolCallId }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("setKind" as const), pick,
    kind: fc.constantFrom("tool_call" as const, "tool_call_update" as const) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("move" as const), pick, session }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("clear" as const), session }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("replaceHistory" as const), session }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("recreate" as const), session }) },
);

/** A row chosen deterministically from every event currently stored. */
function pickRow(db: ControlPlaneDb, index: number): { id: number; payload: string } | undefined {
  const rows = db.raw().prepare("SELECT id, payload FROM session_events ORDER BY id").all() as
    Array<{ id: number; payload: string }>;
  return rows.length ? rows[index % rows.length] : undefined;
}

function apply(db: ControlPlaneDb, step: Operation, epochs: Map<string, number>): void {
  const raw = db.raw();
  switch (step.op) {
    case "append": {
      const id = SESSIONS[step.session]!;
      const payload = toolCallPayload(TOOL_CALL_IDS[step.id]);
      if (step.runner) {
        const epoch = epochs.get(id) ?? 1;
        if (!epochs.has(id)) {
          db.reconcileRunnerHistory(id, epoch, 0);
          epochs.set(id, epoch);
        }
        db.appendEvent(id, payload, 2_000, { runnerSeq: db.getHydratedSeq(id) + 1, historyEpoch: epoch });
      } else {
        db.appendEvent(id, payload, 2_000);
      }
      return;
    }
    case "appendOther": {
      const id = SESSIONS[step.session]!;
      db.appendEvent(id, step.kind === "agent_message"
        ? { kind: "agent_message", text: "streamed" }
        : toolCallPayload(TOOL_CALL_IDS[step.id], "tool_call_update"), 2_000);
      return;
    }
    case "deleteRow": {
      const row = pickRow(db, step.pick);
      if (row) raw.prepare("DELETE FROM session_events WHERE id=?").run(row.id);
      return;
    }
    case "setId": {
      const row = pickRow(db, step.pick);
      if (!row) return;
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const next = TOOL_CALL_IDS[step.id];
      if (next === undefined) delete payload.toolCallId;
      else payload.toolCallId = next;
      raw.prepare("UPDATE session_events SET payload=? WHERE id=?").run(JSON.stringify(payload), row.id);
      return;
    }
    case "setKind": {
      const row = pickRow(db, step.pick);
      if (!row) return;
      const payload = { ...(JSON.parse(row.payload) as Record<string, unknown>), kind: step.kind };
      raw.prepare("UPDATE session_events SET kind=?, payload=? WHERE id=?").run(step.kind, JSON.stringify(payload), row.id);
      return;
    }
    case "move": {
      const row = pickRow(db, step.pick);
      // A moved row leaves its runner sequence behind, which the target may already use.
      if (row) raw.prepare("UPDATE session_events SET session_id=?, runner_seq=NULL WHERE id=?").run(SESSIONS[step.session]!, row.id);
      return;
    }
    case "clear":
      db.clearSessionEvents(SESSIONS[step.session]!);
      return;
    case "replaceHistory": {
      // A new runner history generation (event epoch) replaces the runner-owned rows.
      const id = SESSIONS[step.session]!;
      const epoch = (epochs.get(id) ?? 0) + 1;
      db.reconcileRunnerHistory(id, epoch, 0);
      epochs.set(id, epoch);
      return;
    }
    case "recreate": {
      const id = SESSIONS[step.session]!;
      db.deleteSession(id); // cascades its events
      epochs.delete(id);
      createSession(db, id);
      return;
    }
  }
}

test("the tool-call counter equals the COUNT(DISTINCT ...) query it replaced after any sequence of writes", () => {
  fc.assert(fc.property(fc.array(operation, { minLength: 1, maxLength: 60 }), (steps) => {
    const db = openWithSessions();
    try {
      const epochs = new Map<string, number>();
      for (const [index, step] of steps.entries()) {
        apply(db, step, epochs);
        assertCountsMatch(db, `after step ${index} ${JSON.stringify(step)}`);
      }
    } finally {
      db.close();
    }
  }), { numRuns: 150 });
});

test("duplicate tool-call frames, id-less frames and updates count once per distinct id", () => {
  const db = openWithSessions();
  try {
    for (const status of ["pending", "in_progress", "completed"]) {
      db.appendEvent("s-a", { ...toolCallPayload("call-1"), status } as SessionEventPayload, 2_000);
    }
    db.appendEvent("s-a", toolCallPayload(undefined), 2_000);
    db.appendEvent("s-a", toolCallPayload("call-2", "tool_call_update"), 2_000);
    db.appendEvent("s-a", toolCallPayload("call-2"), 2_000);
    assert.equal(db.countToolCalls("s-a"), 2);
    assert.equal(db.countToolCalls("s-b"), 0, "a session with no tool calls counts zero");
    assertCountsMatch(db, "duplicates");
  } finally {
    db.close();
  }
});

test("the first open of a database written before the counter counts its existing history", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-tool-call-counter-"));
  const location = join(root, "control-plane.db");
  try {
    let db = openWithSessions(location);
    db.appendEvent("s-a", toolCallPayload("call-1"), 2_000);
    db.appendEvent("s-a", toolCallPayload("call-1"), 2_000);
    db.appendEvent("s-b", toolCallPayload(7), 2_000);
    // Return the file to its pre-counter shape, then let an older build keep writing history.
    db.raw().exec(`DROP TRIGGER session_events_tool_call_count_insert;
      DROP TRIGGER session_events_tool_call_count_delete;
      DROP TRIGGER session_events_tool_call_count_update;
      DROP TABLE session_tool_call_counts;`);
    const insert = db.raw().prepare(
      "INSERT INTO session_events (session_id, seq, ts, kind, payload) VALUES (?, ?, 2000, 'tool_call', ?)",
    );
    insert.run("s-a", 100, JSON.stringify(toolCallPayload("call-2")));
    insert.run("s-c", 100, JSON.stringify(toolCallPayload("call-3")));
    db.close();

    db = ControlPlaneDb.open(location);
    try {
      assert.deepEqual(SESSIONS.map((id) => db.countToolCalls(id)), [2, 1, 1]);
      assertCountsMatch(db, "after migration");
      db.appendEvent("s-c", toolCallPayload("call-4"), 3_000);
      assert.equal(db.countToolCalls("s-c"), 2, "the reinstalled triggers keep counting");
    } finally {
      db.close();
    }
    // Reopening never recounts or double-counts an installed counter.
    db = ControlPlaneDb.open(location);
    try {
      assert.deepEqual(SESSIONS.map((id) => db.countToolCalls(id)), [2, 1, 2]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each counter trigger finds a duplicate id through the tool-call index, not a scan of history", () => {
  const db = openWithSessions();
  try {
    const plan = (db.raw().prepare(
      `EXPLAIN QUERY PLAN SELECT 1 FROM session_events WHERE session_id='s-a' AND kind='tool_call'
         AND json_extract(payload,'$.toolCallId')='call-1' AND id<>1`,
    ).all() as Array<{ detail: string }>).map((row) => row.detail).join("\n");
    assert.match(plan, /USING (COVERING )?INDEX idx_session_events_tool_call/);
    assert.doesNotMatch(plan, /SCAN session_events/);
  } finally {
    db.close();
  }
});
