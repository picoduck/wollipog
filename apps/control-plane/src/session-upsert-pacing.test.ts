import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type {
  ControlPlaneToRunner,
  ControlPlaneToUi,
  RunnerMetadata,
  SessionEventPayload,
  SessionSnapshot,
  SessionView,
} from "@wollipog/protocol";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub, SESSION_STREAMING_UPSERT_INTERVAL_MS, type Socket } from "./hub.js";
import { SessionsService } from "./sessions.js";

/**
 * #2760: streaming-only session changes reach dashboards at a bounded rate, transitions are sent
 * at once, and on every delivery path a session upsert arrives after the event that caused it.
 * Every event moves `messageCount` to its own seq, so a dashboard that has seen events through
 * seq N must never hold an upsert claiming more than N.
 */

const RUNNER_ID = "pacing-runner";
const NOOP_LOG = { info() {}, warn() {}, error() {} };
/** About 30 streamed chunks per second, the audit's streaming scenario. */
const CHUNK_MS = 33;

function runnerMeta(): RunnerMetadata {
  return {
    runnerId: RUNNER_ID, hostname: "host", os: "linux", version: "1.0.0",
    workspaces: [{ id: "ws", name: "Repo", path: "/tmp/pacing" }],
    agents: [{ id: "agent", name: "Agent", command: "claude", args: [], env: {}, driver: "claude-code",
      available: true, context: { kind: "native" } }],
  };
}

/** A dashboard socket that checks the ordering rule on every frame it actually receives. A slow
 * dashboard holds frames until drained, so the hub's per-client queue and coalescing are exercised. */
class Dashboard implements Socket {
  readonly asyncDelivery: boolean;
  readonly frames: ControlPlaneToUi[] = [];
  readonly receivedAt: number[] = [];
  readonly violations: string[] = [];
  private readonly held: Array<{ data: string; complete?: (error?: Error) => void }> = [];
  private readonly seenSeq = new Map<string, number>();

  constructor(private readonly slow = false) {
    this.asyncDelivery = slow;
  }

  send(data: string, complete?: (error?: Error) => void): void {
    if (this.slow) this.held.push({ data, complete });
    else this.receive(data);
  }

  /** Deliver up to `limit` held frames; each completion lets the hub's writer send the next. */
  drain(limit = Number.POSITIVE_INFINITY): void {
    while (limit-- > 0) {
      const frame = this.held.shift();
      if (!frame) return;
      this.receive(frame.data);
      frame.complete?.();
    }
  }

  upserts(sessionId: string): SessionView[] {
    return this.frames.flatMap((frame) =>
      frame.type === "session_upsert" && frame.session.id === sessionId ? [frame.session] : []);
  }

  upsertTimes(sessionId: string): number[] {
    return this.frames.flatMap((frame, index) =>
      frame.type === "session_upsert" && frame.session.id === sessionId ? [this.receivedAt[index]!] : []);
  }

  eventSeqs(sessionId: string): number[] {
    return this.frames.flatMap((frame) =>
      frame.type === "session_event" && frame.event.sessionId === sessionId ? [frame.event.seq] : []);
  }

  private receive(data: string): void {
    const frame = JSON.parse(data) as ControlPlaneToUi;
    this.frames.push(frame);
    this.receivedAt.push(Date.now());
    if (frame.type === "snapshot") {
      // A reconnecting dashboard starts from the snapshot and loads earlier history over REST.
      for (const session of frame.sessions) this.seenSeq.set(session.id, session.messageCount);
    } else if (frame.type === "session_event") {
      const id = frame.event.sessionId;
      this.seenSeq.set(id, Math.max(this.seenSeq.get(id) ?? 0, frame.event.seq));
    } else if (frame.type === "session_upsert") {
      const seen = this.seenSeq.get(frame.session.id) ?? 0;
      if (frame.session.messageCount > seen) {
        this.violations.push(`upsert claiming event ${frame.session.messageCount} arrived after only event ${seen}`);
      }
    }
  }
}

function harness(t: TestContext, protocolVersion = PROTOCOL_VERSION) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const db = ControlPlaneDb.open(":memory:");
  t.after(() => db.close());
  db.registerRunner(runnerMeta(), Date.now(), protocolVersion);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);
  return { db, hub, svc };
}

function startSession(h: ReturnType<typeof harness>, id = "s_stream"): string {
  h.hub.attachRunner(RUNNER_ID, { send() {} });
  h.db.createSession({ id, runnerId: RUNNER_ID, workspaceId: "ws", agentId: "agent", title: "Streaming",
    useWorktree: false, driver: "claude-code", config: {}, now: Date.now() });
  h.svc.onSessionStatus(id, "running");
  return id;
}

/** Streams `count` runner events at 30 per second with contiguous runner seqs. */
function stream(t: TestContext, h: ReturnType<typeof harness>, id: string, count: number,
  payload: (index: number) => SessionEventPayload = (index) => ({ kind: "agent_message", text: `chunk ${index} ` })): void {
  for (let i = 0; i < count; i++) {
    h.svc.onSessionEvent(id, payload(i), h.db.getHydratedSeq(id) + 1, Date.now());
    t.mock.timers.tick(CHUNK_MS);
  }
}

test("steady streaming sends each dashboard at most four session upserts per second", (t) => {
  const h = harness(t);
  const dashboard = new Dashboard();
  h.hub.addUiClient(dashboard);
  const id = startSession(h);
  const before = dashboard.upserts(id).length;

  stream(t, h, id, 90); // three seconds at 30 chunks per second
  t.mock.timers.tick(SESSION_STREAMING_UPSERT_INTERVAL_MS);

  const times = dashboard.upsertTimes(id).slice(before);
  assert.ok(times.length >= 8 && times.length <= 13, `about four per second over three seconds, got ${times.length}`);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i]! - times[i - 1]! >= SESSION_STREAMING_UPSERT_INTERVAL_MS,
      `streaming upserts ${i - 1} and ${i} are ${times[i]! - times[i - 1]!} ms apart`);
  }
  assert.equal(dashboard.eventSeqs(id).length, 90, "every event is still delivered losslessly");
  const last = dashboard.upserts(id).at(-1)!;
  assert.equal(last.messageCount, 90, "the trailing flush converges on the final record");
  assert.equal(last.preview, h.db.getSession(id)!.preview);
  assert.deepEqual(dashboard.violations, []);
});

test("status, attention and request transitions are sent at once, after their causing event", (t) => {
  const h = harness(t);
  const dashboard = new Dashboard();
  h.hub.addUiClient(dashboard);
  const id = startSession(h);
  stream(t, h, id, 3);
  // Inside a pacing window: the next streaming change would wait, a transition must not.
  h.svc.onSessionEvent(id, { kind: "agent_message", text: "streamed" }, h.db.getHydratedSeq(id) + 1, Date.now());

  const permission = h.db.getHydratedSeq(id) + 1;
  h.svc.onSessionEvent(id, { kind: "permission_request", requestId: "perm-1", title: "Run tests",
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } as SessionEventPayload, permission, Date.now());
  let last = dashboard.frames.at(-1)!;
  assert.equal(last.type, "session_upsert", "the request transition is sent without waiting");
  assert.equal(last.type === "session_upsert" && last.session.status, "input_required");
  assert.equal(last.type === "session_upsert" && last.session.pendingApproval?.requestId, "perm-1");
  assert.equal(last.type === "session_upsert" && last.session.messageCount, permission,
    "the immediate upsert carries every streamed change before it");

  h.svc.onSessionEvent(id, { kind: "permission_resolved", requestId: "perm-1", optionId: "allow" } as SessionEventPayload,
    h.db.getHydratedSeq(id) + 1, Date.now());
  h.svc.onSessionStatus(id, "running");
  stream(t, h, id, 2);
  const completedSeq = h.db.getHydratedSeq(id) + 1;
  const attentionBefore = JSON.stringify(dashboard.upserts(id).at(-1)?.attention);
  h.svc.onSessionEvent(id, { kind: "agent_response_completed" }, completedSeq, Date.now());
  last = dashboard.frames.at(-1)!;
  assert.equal(last.type, "session_upsert", "the attention transition is sent without waiting");
  assert.notEqual(JSON.stringify(last.type === "session_upsert" && last.session.attention), attentionBefore);
  const eventIndex = dashboard.frames.findIndex((frame) =>
    frame.type === "session_event" && frame.event.seq === completedSeq);
  assert.ok(eventIndex !== -1 && eventIndex < dashboard.frames.length - 1, "the causing event came first");

  const beforeIdle = dashboard.frames.length;
  h.svc.onSessionStatus(id, "idle");
  assert.ok(dashboard.frames.slice(beforeIdle).some((frame) =>
    frame.type === "session_upsert" && frame.session.id === id && frame.session.status === "idle"),
  "a status transition is sent at once");
  assert.deepEqual(dashboard.violations, []);
});

test("a slow dashboard's queue keeps every upsert behind its causing event", (t) => {
  const h = harness(t);
  const dashboard = new Dashboard(true);
  h.hub.addUiClient(dashboard);
  dashboard.drain();
  const id = startSession(h);
  dashboard.drain();

  for (let burst = 0; burst < 12; burst++) {
    stream(t, h, id, 8);
    // The socket drains only part of its backlog, so paced upserts replace queued ones mid-queue.
    dashboard.drain(3);
  }
  h.svc.onSessionStatus(id, "idle");
  t.mock.timers.tick(SESSION_STREAMING_UPSERT_INTERVAL_MS);
  dashboard.drain();

  const seqs = dashboard.eventSeqs(id);
  assert.deepEqual(seqs, Array.from({ length: 96 }, (_, index) => index + 1), "events stay lossless and ordered");
  assert.equal(dashboard.upserts(id).at(-1)?.status, "idle");
  assert.equal(dashboard.upserts(id).at(-1)?.messageCount, 96);
  assert.deepEqual(dashboard.violations, []);
});

test("a dashboard that reconnects mid-stream receives pending upserts only behind their events", (t) => {
  const h = harness(t);
  const first = new Dashboard();
  h.hub.addUiClient(first);
  const id = startSession(h);
  stream(t, h, id, 10);
  // A paced flush is pending when the replacement connection arrives and subscribes.
  h.svc.onSessionEvent(id, { kind: "agent_message", text: "pending" }, h.db.getHydratedSeq(id) + 1, Date.now());
  h.hub.removeUiClient(first);
  const reconnected = new Dashboard();
  assert.ok(h.hub.addUiClient(reconnected));
  assert.equal(h.hub.setUiSessionSubscriptions(reconnected, 1, [id], []).ok, true);

  stream(t, h, id, 30);
  t.mock.timers.tick(SESSION_STREAMING_UPSERT_INTERVAL_MS);

  assert.equal(reconnected.upserts(id).at(-1)?.messageCount, h.db.getSession(id)!.messageCount);
  assert.deepEqual(reconnected.violations, []);
  assert.deepEqual(first.violations, []);
});

test("events replayed through gap hydration still precede the paced upsert that reflects them", async (t) => {
  const h = harness(t, 53);
  const snapshot: SessionSnapshot = {
    id: "s_box", workspaceId: "ws", agentId: "agent", title: "Boxed", status: "running", driver: "claude-code",
    useWorktree: false, worktreePath: null, config: {}, preview: null, pendingApproval: null,
    tokensIn: 0, tokensOut: 0, costUsd: 0, seq: 0, createdAt: 1, updatedAt: 2,
  };
  h.svc.hydrateRunnerSessions(RUNNER_ID, [snapshot]);
  const requests: Array<{ requestId: string; afterSeq: number }> = [];
  h.hub.attachRunner(RUNNER_ID, { send(data: string) {
    const message = JSON.parse(data) as ControlPlaneToRunner;
    if (message.type === "session_history") requests.push({ requestId: message.requestId, afterSeq: message.afterSeq });
  } });
  const dashboard = new Dashboard();
  h.hub.addUiClient(dashboard);

  // Live seq 6 arrives ahead of the cursor: the control plane pulls 1-6 from the runner.
  h.svc.onSessionEvent("s_box", { kind: "agent_message", text: "six" }, 6, Date.now());
  assert.equal(requests.length, 1);
  h.hub.resolveRunnerRequest({ type: "session_history_result", requestId: requests[0]!.requestId,
    sessionId: "s_box", ok: true, events: Array.from({ length: 6 }, (_, index) => ({
      seq: index + 1, ts: 1_000 + index, payload: { kind: "agent_message", text: `m${index + 1}` } })) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.db.getHydratedSeq("s_box"), 6);
  stream(t, h, "s_box", 12);
  t.mock.timers.tick(SESSION_STREAMING_UPSERT_INTERVAL_MS);

  assert.deepEqual(dashboard.eventSeqs("s_box"), Array.from({ length: 18 }, (_, index) => index + 1));
  assert.equal(dashboard.upserts("s_box").at(-1)?.messageCount, 18);
  assert.deepEqual(dashboard.violations, []);
});

test("a dashboard not viewing a streaming session pays a bounded rate, not a per-token cost", (t) => {
  const h = harness(t);
  const elsewhere = new Dashboard();
  h.hub.addUiClient(elsewhere);
  assert.equal(h.hub.setUiSessionSubscriptions(elsewhere, 1, [], []).ok, true);
  const id = startSession(h);
  const before = elsewhere.frames.length;

  stream(t, h, id, 60);
  t.mock.timers.tick(SESSION_STREAMING_UPSERT_INTERVAL_MS);

  const received = elsewhere.frames.slice(before);
  assert.equal(received.filter((frame) => frame.type === "session_event").length, 0);
  const upserts = received.filter((frame) => frame.type === "session_upsert");
  assert.ok(upserts.length <= 9, `two seconds of streaming cost ${upserts.length} upserts, not 60`);
  assert.equal(upserts.at(-1)?.type === "session_upsert" && upserts.at(-1)?.session.messageCount, 60,
    "the session list still converges on the latest preview and counters");
});

test("an upsert whose only change is a nested timestamp is a transition, not a streaming update", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 5_000 });
  const db = { listRunners: () => [], listSessions: () => [], listProjects: () => [], listBoxes: () => [],
    listRuns: () => [], listPods: () => [], listSessionReminders: () => [], worktreeSetupNoticeDismissals: () => [],
    getSession: () => null } as unknown as ControlPlaneDb;
  const hub = new Hub(db);
  const dashboard = new Dashboard();
  hub.addUiClient(dashboard);
  const view = (jobUpdatedAt: number, preview: string) => ({ id: "s", title: "T", preview, messageCount: 0,
    backgroundJobs: [{ jobId: "j", updatedAt: jobUpdatedAt }] }) as unknown as SessionView;
  hub.sessionChanged(view(1, "a"));
  hub.sessionChanged(view(1, "b"));
  assert.equal(dashboard.upserts("s").length, 1, "a top-level streaming field alone is paced");
  hub.sessionChanged(view(2, "c"));
  assert.equal(dashboard.upserts("s").length, 2, "a nested record's own timestamp is sent at once");
  assert.equal(dashboard.upserts("s").at(-1)?.preview, "c");
});

test("republishing an unchanged record is a deliberate resend and is not paced", (t) => {
  const h = harness(t);
  const dashboard = new Dashboard();
  h.hub.addUiClient(dashboard);
  const id = startSession(h);
  const before = dashboard.upserts(id).length;
  // A per-viewer projection (permissions, an acknowledgment) can change while the record does not.
  h.hub.sessionChangedById(id);
  h.hub.sessionChangedById(id);
  assert.equal(dashboard.upserts(id).length, before + 2);
});

test("a paced flush that finds the database closing neither throws nor sends", (t) => {
  const h = harness(t);
  const dashboard = new Dashboard();
  h.hub.addUiClient(dashboard);
  const id = startSession(h);
  stream(t, h, id, 2);
  h.svc.onSessionEvent(id, { kind: "agent_message", text: "pending" }, h.db.getHydratedSeq(id) + 1, Date.now());
  const frames = dashboard.frames.length;
  // What a closed database's prepared statements throw at shutdown.
  h.db.getSession = () => { throw new Error("statement has been finalized"); };
  assert.doesNotThrow(() => t.mock.timers.tick(SESSION_STREAMING_UPSERT_INTERVAL_MS));
  assert.equal(dashboard.frames.length, frames);
});
