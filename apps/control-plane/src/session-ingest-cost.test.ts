import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ControlPlaneToUi, RunnerMetadata, SessionEventPayload } from "@wollipog/protocol";
import { PROTOCOL_VERSION, runnerSupportsProtocol } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub, type Socket } from "./hub.js";
import { SessionsService } from "./sessions.js";

/**
 * #2761: per-event control-plane work stays constant. A streamed event builds its session view
 * once, when its change is published, and capability checks read the protocol version the runner
 * connection registered with instead of reloading the runner record.
 */

const RUNNER_ID = "ingest-runner";
const NOOP_LOG = { info() {}, warn() {}, error() {} };

function runnerMeta(): RunnerMetadata {
  return {
    runnerId: RUNNER_ID, hostname: "host", os: "linux", version: "1.0.0",
    workspaces: [{ id: "ws", name: "Repo", path: "/tmp/ingest" }],
    agents: [{ id: "agent", name: "Agent", command: "claude", args: [], env: {}, driver: "claude-code",
      available: true, context: { kind: "native" } }],
  };
}

class Dashboard implements Socket {
  readonly frames: ControlPlaneToUi[] = [];
  send(data: string): void {
    this.frames.push(JSON.parse(data) as ControlPlaneToUi);
  }
}

function harness(t: TestContext, protocolVersion = PROTOCOL_VERSION) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const db = ControlPlaneDb.open(":memory:");
  t.after(() => db.close());
  db.registerRunner(runnerMeta(), Date.now(), protocolVersion);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);
  hub.attachRunner(RUNNER_ID, { send() {} }, protocolVersion);
  const id = "s_ingest";
  db.createSession({ id, runnerId: RUNNER_ID, workspaceId: "ws", agentId: "agent", title: "Streaming",
    useWorktree: false, driver: "claude-code", config: {}, now: Date.now() });
  // A current runner's session has an indexed history generation; ingest checks its capability.
  db.reconcileRunnerHistory(id, 1, 0);
  svc.onSessionStatus(id, "running");
  const dashboard = new Dashboard();
  hub.addUiClient(dashboard);
  // Counts view builds and runner-record reads made while one event is ingested.
  const calls = { views: 0, runners: 0 };
  const getSession = db.getSession.bind(db);
  db.getSession = (sessionId) => {
    calls.views++;
    return getSession(sessionId);
  };
  const getRunner = db.getRunner.bind(db);
  db.getRunner = (runnerId) => {
    calls.runners++;
    return getRunner(runnerId);
  };
  const ingest = (payload: SessionEventPayload) => {
    calls.views = 0;
    calls.runners = 0;
    svc.onSessionEvent(id, payload, db.getHydratedSeq(id) + 1, Date.now());
    t.mock.timers.tick(10);
    return { ...calls };
  };
  return { db, hub, svc, id, dashboard, ingest };
}

const STREAMED: SessionEventPayload[] = [
  { kind: "agent_message", text: "streamed chunk " },
  { kind: "agent_thought", text: "thinking" },
  { kind: "tool_call", toolCallId: "call-1", title: "Run", status: "pending" } as SessionEventPayload,
  { kind: "tool_call_update", toolCallId: "call-1", status: "completed" } as SessionEventPayload,
  { kind: "agent_message", text: "done", final: true },
  { kind: "user_message", text: "next" },
  { kind: "agent_response_completed" },
];

test("each streamed event builds its session view once and reads no runner record", (t) => {
  const h = harness(t);
  for (const payload of STREAMED) {
    const calls = h.ingest(payload);
    assert.deepEqual(calls, { views: 1, runners: 0 }, `${payload.kind}${"final" in payload && payload.final ? " (final)" : ""}`);
  }
});

test("a guardrailed session's streamed events still build one view, with the maintained tool-call count", (t) => {
  const h = harness(t);
  h.db.raw().prepare("UPDATE sessions SET max_tool_calls=50, max_tool_calls_step=50 WHERE id=?").run(h.id);
  for (const [index, payload] of STREAMED.entries()) {
    assert.equal(h.ingest(payload).views, 1, `event ${index}`);
  }
  const upserts = h.dashboard.frames.filter((frame) => frame.type === "session_upsert");
  assert.equal(upserts.at(-1)?.type === "session_upsert" && upserts.at(-1)?.session.toolCallCount, 1);
});

test("a completed response publishes one upsert, after its event", (t) => {
  const h = harness(t);
  h.ingest({ kind: "agent_message", text: "answer" });
  t.mock.timers.tick(1_000);
  const before = h.dashboard.frames.length;
  const seq = h.db.getHydratedSeq(h.id) + 1;
  h.ingest({ kind: "agent_response_completed" });
  const frames = h.dashboard.frames.slice(before);
  assert.deepEqual(frames.map((frame) => frame.type), ["session_event", "session_upsert"]);
  assert.equal(frames[0]?.type === "session_event" && frames[0].event.seq, seq);
  assert.equal(frames[1]?.type === "session_upsert" && frames[1].session.messageCount, seq);
});

test("a runner's protocol version is the one its live connection registered with", (t) => {
  const h = harness(t);
  const older = 40;
  assert.equal(h.hub.runnerProtocolVersion(RUNNER_ID), PROTOCOL_VERSION);
  // The stored record alone does not change the live connection's version.
  h.db.registerRunner(runnerMeta(), Date.now(), older);
  assert.equal(h.hub.runnerProtocolVersion(RUNNER_ID), PROTOCOL_VERSION);
  // A replacement connection carries its own.
  const replacement = { send() {}, close() {} };
  h.hub.attachRunner(RUNNER_ID, replacement, older);
  assert.equal(h.hub.runnerProtocolVersion(RUNNER_ID), older);
  // Without a live connection, the stored version answers.
  assert.equal(h.hub.detachRunner(RUNNER_ID, replacement), true);
  h.db.registerRunner(runnerMeta(), Date.now(), 41);
  assert.equal(h.hub.runnerProtocolVersion(RUNNER_ID), 41);
  // A connection attached without a version (narrow callers) also reads the stored one.
  h.hub.attachRunner(RUNNER_ID, { send() {} });
  assert.equal(h.hub.runnerProtocolVersion(RUNNER_ID), 41);
});

test("ingest follows the connection's protocol: a runner without indexed history appends live events", (t) => {
  const legacy = 40;
  assert.equal(runnerSupportsProtocol(legacy, "indexedHistory"), false, "the fixture predates indexed history");
  const h = harness(t, legacy);
  const calls = h.ingest({ kind: "agent_message", text: "streamed" });
  assert.equal(calls.runners, 0);
  assert.equal(h.db.getHydratedSeq(h.id), 1, "the event was applied through the non-indexed path");
  assert.equal(h.dashboard.frames.filter((frame) => frame.type === "session_event").length, 1);
});
