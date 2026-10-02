import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ControlPlaneToRunner,
  RunnerMetadata,
  SessionEventPayload,
  SessionHistoryResultMessage,
  SessionSnapshot,
} from "@wollipog/protocol";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, PROTOCOL_VERSION } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { RUNNER_REPORTED_STOP } from "./db.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";

type StoredSessionEvent = { seq: number; ts: number; payload: SessionEventPayload };

/**
 * Phase 2 integration: the lazy-history round-trip across the REAL Hub. A scripted fake runner
 * socket answers `session_history` requests, exercising hub.requestFromRunner +
 * resolveRunnerRequest + svc.hydrateHistory + db append/seq together (the one async seam the
 * pure-unit hydrate tests in sessions.test.ts don't cover).
 */

const RUNNER_ID = "runner-1";
const NOOP_LOG = { info() {}, warn() {}, error() {} };

function runnerMeta(): RunnerMetadata {
  return {
    runnerId: RUNNER_ID,
    hostname: "host",
    os: "linux",
    version: "1.0.0",
    workspaces: [{ id: "ws-1", name: "Demo", path: "/repos/demo" }],
    agents: [
      {
        id: "claude",
        name: "Claude",
        command: "claude",
        args: [],
        env: {},
        driver: "claude-code",
        available: true,
        context: { kind: "native" },
      },
    ],
  };
}

function snapshot(): SessionSnapshot {
  return {
    id: "s_box1",
    workspaceId: "ws-1",
    agentId: "claude",
    title: "boxed",
    status: "idle",
    driver: "claude-code",
    useWorktree: false,
    worktreePath: null,
    config: {},
    preview: null,
    pendingApproval: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    seq: 2,
    createdAt: 1,
    updatedAt: 2,
  };
}

/** A fake runner websocket that replies to session_history with `events`, recording the request. */
function scriptedRunnerSocket(hub: Hub, events: StoredSessionEvent[], seen: ControlPlaneToRunner[]) {
  return {
    send(data: string) {
      const msg = JSON.parse(data) as ControlPlaneToRunner;
      seen.push(msg);
      if (msg.type !== "session_history") return;
      // Reply asynchronously — requestFromRunner registers the pending entry only AFTER send() returns.
      queueMicrotask(() => {
        const reply: SessionHistoryResultMessage = {
          type: "session_history_result",
          requestId: msg.requestId,
          sessionId: msg.sessionId,
          ok: true,
          events: events.filter((e) => e.seq > msg.afterSeq),
        };
        hub.resolveRunnerRequest(reply);
      });
    },
  };
}

function campaignHistoryHarness(protocolVersion = PROTOCOL_VERSION, warnings: string[] = []) {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), 500, protocolVersion);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, { ...NOOP_LOG, warn: (message) => warnings.push(message) });
  const base = { runnerId: RUNNER_ID, workspaceId: "ws-1", agentId: "claude", title: "Campaign",
    driver: "claude-code" as const, useWorktree: false, config: {}, now: 500 };
  db.createSession({ ...base, id: "campaign",
    orchestratorPolicy: resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default") });
  db.createSession({ ...base, id: "child", parentSessionId: "campaign" });
  db.updateSessionStatus("child", "idle", 999);
  db.reconcileRunnerHistory("child", 1, 1);
  return { db, hub, svc };
}

for (const advertisedTail of [0, 1]) {
test(`campaign verification hydrates a dropped cache with advertised tail ${advertisedTail} before checking the stopped-child report`, async () => {
  const { db, hub, svc } = campaignHistoryHarness();
  try {
    db.updateSessionStatus("child", "stopped", 999, RUNNER_REPORTED_STOP);
    const payload = { kind: "agent_message", text: "Completed report", final: true } as const;
    db.appendEvent("child", payload, 1_000, { runnerSeq: 1 });
    db.reconcileRunnerHistory("child", 2, advertisedTail);
    const seen: ControlPlaneToRunner[] = [];
    hub.attachRunner(RUNNER_ID, { send(data: string) {
      const msg = JSON.parse(data) as ControlPlaneToRunner;
      seen.push(msg);
      if (msg.type !== "session_history_page") return;
      queueMicrotask(() => hub.resolveRunnerRequest({ type: "session_history_page_result",
        requestId: msg.requestId, sessionId: msg.sessionId, ok: true,
        events: [{ seq: 1, ts: 1_000, payload }],
        page: { logEpoch: 2, throughSeq: 1, nextAfterSeq: 1, hasMore: false } }));
    } });
    assert.equal(db.listEvents("child").length, 0);
    const result = await svc.verifyCampaignChildWithHistory("campaign", {
      childSessionId: "child", reportEventSeq: 1, followUpsAccounted: true,
    });
    assert.ok(result.ok, result.error);
    assert.equal(result.data?.campaign.children.verified, 1);
    assert.equal(seen.filter((message) => message.type === "session_history_page").length, 1);
  } finally { db.close(); }
});
}

test("campaign reads recover ambiguous legacy history for exact re-verification, and leave active children lazy", async () => {
  const { db, hub, svc } = campaignHistoryHarness();
  try {
    const payload = { kind: "agent_message", text: "Completed report", final: true } as const;
    db.raw().prepare(`INSERT INTO orchestrator_campaign_child_reports
      (campaign_session_id, child_session_id, report_event_seq, verified_at) VALUES ('campaign','child',1,1001)`)
      .run();
    db.clearSessionEvents("child");
    db.createSession({ id: "active", runnerId: RUNNER_ID, workspaceId: "ws-1", agentId: "claude",
      title: "Active", driver: "claude-code", useWorktree: false, config: {}, now: 500, parentSessionId: "campaign" });
    const seen: ControlPlaneToRunner[] = [];
    hub.attachRunner(RUNNER_ID, { send(data: string) {
      const msg = JSON.parse(data) as ControlPlaneToRunner;
      seen.push(msg);
      if (msg.type !== "session_history_page") return;
      queueMicrotask(() => hub.resolveRunnerRequest({ type: "session_history_page_result",
        requestId: msg.requestId, sessionId: msg.sessionId, ok: true,
        events: [{ seq: 1, ts: 1_000, payload }],
        page: { logEpoch: 1, throughSeq: 1, nextAfterSeq: 1, hasMore: false } }));
    } });
    assert.equal(db.campaignProjection("campaign")?.children.verified, 0);
    const projection = await svc.campaignProjectionWithHistory("campaign");
    assert.equal(projection.data?.children.verified, 0);
    assert.deepEqual(seen.filter((message) => message.type === "session_history_page")
      .map((message) => message.sessionId), ["child"]);
    await svc.campaignProjectionWithHistory("campaign");
    assert.equal(seen.filter((message) => message.type === "session_history_page").length, 1);
    const verified = await svc.verifyCampaignChildWithHistory("campaign", {
      childSessionId: "child", reportEventSeq: 1, followUpsAccounted: true,
    });
    assert.ok(verified.ok, verified.error);
    assert.equal(verified.data?.campaign.children.verified, 1);
  } finally { db.close(); }
});

for (const protocolVersion of [53, PROTOCOL_VERSION]) {
  test(`protocol ${protocolVersion} legacy recovery rejects sequence reuse and retries after a failed reload`, async () => {
    const { db, hub, svc } = campaignHistoryHarness(protocolVersion);
    try {
      db.reconcileRunnerHistory("child", 2, 2);
      db.raw().prepare(`INSERT INTO orchestrator_campaign_child_reports
        (campaign_session_id, child_session_id, report_event_seq, verified_at) VALUES ('campaign','child',2,1001)`).run();
      const events: StoredSessionEvent[] = [
        { seq: 1, ts: 1000, payload: { kind: "agent_message", text: "Original", final: true } },
        { seq: 2, ts: 2000, payload: { kind: "agent_message", text: "Different", final: true } },
      ];
      let attempts = 0;
      hub.attachRunner(RUNNER_ID, { send(data: string) {
        const msg = JSON.parse(data) as ControlPlaneToRunner;
        if (msg.type !== "session_history_page" && msg.type !== "session_history") return;
        const ok = ++attempts > 1;
        queueMicrotask(() => hub.resolveRunnerRequest(msg.type === "session_history_page"
          ? { type: "session_history_page_result", requestId: msg.requestId, sessionId: msg.sessionId, ok,
            ...(ok ? { events, page: { logEpoch: 2, throughSeq: 2, nextAfterSeq: 2, hasMore: false } }
              : { error: "retry later" }) }
          : { type: "session_history_result", requestId: msg.requestId, sessionId: msg.sessionId, ok,
            ...(ok ? { events } : { error: "retry later" }) }));
      } });
      const failed = await svc.campaignProjectionWithHistory("campaign");
      assert.equal(failed.data?.children.verified, 0);
      assert.deepEqual(db.campaignReportRecoverySessionIds("campaign"), ["child"]);
      const recovered = await svc.campaignProjectionWithHistory("campaign");
      assert.equal(recovered.data?.children.verified, 0);
      assert.equal(db.hasCompletedAgentReportAt("child", 2), true);
      assert.deepEqual(db.campaignReportRecoverySessionIds("campaign"), []);
      await svc.campaignProjectionWithHistory("campaign");
      assert.equal(attempts, 2, "complete recovery must stop repeated campaign fetches");
      const verified = await svc.verifyCampaignChildWithHistory("campaign", {
        childSessionId: "child", reportEventSeq: 2, followUpsAccounted: true,
      });
      assert.ok(verified.ok, verified.error);
      assert.equal(verified.data?.campaign.children.verified, 1);
    } finally { db.close(); }
  });
}

test("verification does not fetch inaccessible or unrelated child history", async () => {
  const { db, hub, svc } = campaignHistoryHarness();
  try {
    const seen: ControlPlaneToRunner[] = [];
    hub.attachRunner(RUNNER_ID, scriptedRunnerSocket(hub, [], seen));
    const result = await svc.verifyCampaignChildWithHistory("campaign", {
      childSessionId: "child", reportEventSeq: 1, followUpsAccounted: true,
    }, (id) => id !== "child");
    assert.equal(result.status, 404);
    assert.deepEqual(seen, []);
  } finally { db.close(); }
});

test("a new live report arriving after a gap invalidates proof before its old cache is reloaded", async () => {
  const { db, hub, svc } = campaignHistoryHarness();
  try {
    const payload = { kind: "agent_message", text: "Original", final: true } as const;
    const report = db.appendEvent("child", payload, 1_000, { runnerSeq: 1 });
    db.verifyCampaignChildReport("campaign", "child", report.seq, 1_001);
    db.reconcileRunnerHistory("child", 2, 1);
    let reply: (() => void) | undefined;
    hub.attachRunner(RUNNER_ID, { send(data: string) {
      const msg = JSON.parse(data) as ControlPlaneToRunner;
      if (msg.type !== "session_history_page") return;
      reply = () => hub.resolveRunnerRequest({ type: "session_history_page_result",
        requestId: msg.requestId, sessionId: msg.sessionId, ok: false, error: "retry later" });
    } });
    svc.onSessionEvent("child", { kind: "agent_message", text: "New report", final: true }, 3, 2_000);
    assert.equal(db.campaignChildReportVerified("campaign", "child"), false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(reply);
    reply();
    await svc.hydrateHistory("child");
  } finally { db.close(); }
});

test("a complete runner reload without a legacy report stops repeated campaign recovery requests", async () => {
  const { db, hub, svc } = campaignHistoryHarness();
  try {
    db.raw().prepare(`INSERT INTO orchestrator_campaign_child_reports
      (campaign_session_id, child_session_id, report_event_seq, verified_at) VALUES ('campaign','child',2,1001)`).run();
    let requests = 0;
    hub.attachRunner(RUNNER_ID, { send(data: string) {
      const msg = JSON.parse(data) as ControlPlaneToRunner;
      if (msg.type !== "session_history_page") return;
      requests++;
      queueMicrotask(() => hub.resolveRunnerRequest({ type: "session_history_page_result",
        requestId: msg.requestId, sessionId: msg.sessionId, ok: true,
        events: [{ seq: 1, ts: 1_000, payload: { kind: "agent_thought", text: "No final report" } }],
        page: { logEpoch: 1, throughSeq: 1, nextAfterSeq: 1, hasMore: false } }));
    } });
    await svc.campaignProjectionWithHistory("campaign");
    await svc.campaignProjectionWithHistory("campaign");
    assert.equal(requests, 1);
    assert.equal(db.campaignChildReportVerified("campaign", "child"), false);
  } finally { db.close(); }
});

for (const protocolVersion of [53, PROTOCOL_VERSION]) {
  test(`protocol ${protocolVersion} history failures are reported without transcript data and retry on the next read`, async () => {
    const warnings: string[] = [];
    const { db, hub, svc } = campaignHistoryHarness(protocolVersion, warnings);
    try {
      const payload = { kind: "agent_message", text: "Private completed report", final: true } as const;
      const report = db.appendEvent("child", payload, 1_000, { runnerSeq: 1 });
      db.verifyCampaignChildReport("campaign", "child", report.seq, 1_001);
      db.reconcileRunnerHistory("child", 2, 1);
      let attempts = 0;
      hub.attachRunner(RUNNER_ID, { send(data: string) {
        const msg = JSON.parse(data) as ControlPlaneToRunner;
        if (msg.type !== "session_history_page" && msg.type !== "session_history") return;
        const ok = ++attempts > 1;
        queueMicrotask(() => hub.resolveRunnerRequest(msg.type === "session_history_page"
          ? { type: "session_history_page_result", requestId: msg.requestId, sessionId: msg.sessionId, ok,
            ...(ok ? { events: [{ seq: 1, ts: 1_000, payload }],
              page: { logEpoch: 2, throughSeq: 1, nextAfterSeq: 1, hasMore: false } }
              : { error: "Private runner error" }) }
          : { type: "session_history_result", requestId: msg.requestId, sessionId: msg.sessionId, ok,
            ...(ok ? { events: [{ seq: 1, ts: 1_000, payload }] } : { error: "Private runner error" }) }));
      } });
      await svc.hydrateHistory("child");
      assert.equal(db.campaignChildReportVerified("campaign", "child"), true);
      assert.equal(db.getHydratedSeq("child"), 0);
      assert.equal(warnings.length, 1);
      const warning = JSON.parse(warnings[0]!);
      assert.equal(warning.event, "history_hydration_failed");
      assert.equal(warning.sessionId, "child");
      assert.equal(warning.runnerId, RUNNER_ID);
      assert.ok(warning.requestId);
      assert.equal(warning.reason, "invalid_runner_response");
      assert.doesNotMatch(warnings.join("\n"), /Private/);
      await svc.hydrateHistory("child");
      assert.equal(attempts, 2);
      assert.equal(db.getHydratedSeq("child"), 1);
      assert.equal(db.campaignChildReportVerified("campaign", "child"), true);
    } finally { db.close(); }
  });
}

test("hydrateHistory pulls the box's event log over the hub and advances the high-water", async () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), 53);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);

  // Materialize the session from a snapshot (no events yet), then attach the scripted runner.
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot()]);
  const events: StoredSessionEvent[] = [
    { seq: 1, ts: 1000, payload: { kind: "user_message", text: "hi" } },
    { seq: 2, ts: 1001, payload: { kind: "agent_message", text: "hello there" } },
  ];
  const seen: ControlPlaneToRunner[] = [];
  hub.attachRunner(RUNNER_ID, scriptedRunnerSocket(hub, events, seen));

  await svc.hydrateHistory("s_box1");

  // The request asked for everything past the current high-water (0).
  const req = seen.find((m) => m.type === "session_history");
  assert.ok(req && req.type === "session_history");
  assert.equal(req.afterSeq, 0);

  // Both events landed in the cache, in order, and the high-water advanced to the box's seq.
  const cached = db.listEvents("s_box1", 0);
  assert.deepEqual(cached.map((e) => e.payload.kind), ["user_message", "agent_message"]);
  assert.equal(db.getHydratedSeq("s_box1"), 2);
});

test("re-hydrating quiescent terminal runner snapshots uses one durable commit for the batch", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);
  const snapshots = Array.from({ length: 12 }, (_, index): SessionSnapshot => ({
    ...snapshot(),
    id: `stopped-${index}`,
    status: "stopped",
    seq: 0,
    historyEpoch: 1,
  }));
  svc.hydrateRunnerSessions(RUNNER_ID, snapshots);

  const sqlite = (db as unknown as { db: { exec(sql: string): void } }).db;
  const exec = sqlite.exec.bind(sqlite);
  let commits = 0;
  sqlite.exec = (sql: string) => {
    if (sql.trim().toUpperCase() === "COMMIT") commits++;
    exec(sql);
  };

  svc.hydrateRunnerSessions(RUNNER_ID, snapshots);

  assert.equal(commits, 1);

  exec("BEGIN");
  try {
    assert.throws(
      () => db.updateSessionFromSnapshot(snapshots[0]!.id, snapshots[0]!, Date.now()),
      /requires an autocommit connection/,
    );
  } finally {
    exec("ROLLBACK");
  }
});

test("identical quiescent terminal snapshots do not rewrite durable state", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);
  const snapshots = Array.from({ length: 12 }, (_, index): SessionSnapshot => ({
    ...snapshot(),
    id: `unchanged-${index}`,
    status: "stopped",
    seq: 0,
    historyEpoch: 1,
  }));
  svc.hydrateRunnerSessions(RUNNER_ID, snapshots);

  const sqlite = (db as unknown as {
    db: { prepare(sql: string): { get(): { changes: number } } };
  }).db;
  const totalChanges = () => sqlite.prepare("SELECT total_changes() AS changes").get().changes;
  const before = totalChanges();

  svc.hydrateRunnerSessions(RUNNER_ID, snapshots);

  assert.equal(totalChanges(), before, "an exact reconnect replay must be read-only");

  const changed = snapshots.with(0, { ...snapshots[0]!, preview: "new terminal preview", updatedAt: 3 });
  svc.hydrateRunnerSessions(RUNNER_ID, changed);
  assert.ok(totalChanges() > before, "a changed terminal snapshot must still reconcile");
  assert.equal(db.getSession(changed[0]!.id)?.preview, "new terminal preview");
});

test("registration and negotiated terminal snapshot identities remain independently replayable", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);
  const registration: SessionSnapshot = {
    ...snapshot(),
    id: "dual-wire-identity",
    status: "stopped",
    seq: 0,
    historyEpoch: undefined,
  };
  const negotiated: SessionSnapshot = {
    ...registration,
    config: { serviceTier: "fast" },
    backgroundWorkTracking: "managed",
    seq: 2,
    historyEpoch: 9,
  };
  svc.hydrateRunnerSessions(RUNNER_ID, [registration]);
  db.updateSessionFromSnapshot(negotiated.id, negotiated, 10);

  const sqlite = (db as unknown as {
    db: { prepare(sql: string): { get(): { changes: number } } };
  }).db;
  const totalChanges = () => sqlite.prepare("SELECT total_changes() AS changes").get().changes;
  const beforeRegistrationReplay = totalChanges();

  svc.hydrateRunnerSessions(RUNNER_ID, [registration]);

  assert.equal(totalChanges(), beforeRegistrationReplay,
    "the pre-negotiation identity survives a following negotiated runtime snapshot");
  const beforeRuntimeReplay = totalChanges();

  db.updateSessionFromSnapshot(negotiated.id, negotiated, 20);

  assert.equal(totalChanges(), beforeRuntimeReplay,
    "the full runtime identity survives a following registration snapshot replay");
});

test("terminal snapshot fast path yields to history reset and durable cleanup", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);
  const historySnapshot: SessionSnapshot = {
    ...snapshot(),
    id: "history-reset",
    status: "stopped",
    preview: "runner preview",
    historyEpoch: 7,
  };
  const promptSnapshot: SessionSnapshot = {
    ...snapshot(),
    id: "prompt-cleanup",
    status: "stopped",
    seq: 0,
    historyEpoch: 1,
  };
  const settlementSnapshot: SessionSnapshot = {
    ...snapshot(),
    id: "settlement-cleanup",
    status: "stopped",
    seq: 0,
    historyEpoch: 1,
  };
  svc.hydrateRunnerSessions(RUNNER_ID, [historySnapshot, promptSnapshot, settlementSnapshot]);

  db.clearSessionEvents(historySnapshot.id);
  db.stageSessionPromptCommand({
    commandId: "pending-terminal-prompt",
    sessionId: promptSnapshot.id,
    runnerId: RUNNER_ID,
    payloadJson: JSON.stringify({ text: "must be fenced" }),
    payloadSha256: "0".repeat(64),
    expiresAt: 100_000,
    now: 10,
  });
  const sqlite = (db as unknown as {
    db: {
      prepare(sql: string): {
        run(...values: unknown[]): unknown;
        get(...values: unknown[]): { pending: number | null };
      };
    };
  }).db;
  sqlite.prepare(
    `INSERT INTO managed_background_deliveries
       (session_id,continuation_id,parent_turn_id,status_settlement_pending_at,updated_at)
     VALUES (?,?,?,?,?)`,
  ).run(settlementSnapshot.id, "continuation-1", "turn-1", 11, 11);

  svc.hydrateRunnerSessions(RUNNER_ID, [historySnapshot, promptSnapshot, settlementSnapshot]);

  assert.deepEqual(db.getRunnerHistoryState(historySnapshot.id), {
    historyEpoch: 7,
    tailSeq: 2,
    hydratedSeq: 0,
    eventEpoch: 1,
    complete: false,
  });
  assert.equal(db.getSession(historySnapshot.id)?.preview, "runner preview");
  assert.equal(db.getSessionPromptCommand("pending-terminal-prompt")?.state, "failed");
  const settlement = sqlite.prepare(
    `SELECT status_settlement_pending_at AS pending
       FROM managed_background_deliveries WHERE session_id=? AND continuation_id=?`,
  ).get(settlementSnapshot.id, "continuation-1");
  assert.equal(settlement.pending, null);
});

test("terminal snapshot batching excludes sessions with durable reconciliation work", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);
  const snapshots: SessionSnapshot[] = [
    { ...snapshot(), id: "quiescent", status: "stopped", seq: 0, historyEpoch: 1 },
    { ...snapshot(), id: "resume-marker", status: "stopped", seq: 0, historyEpoch: 1 },
  ];
  svc.hydrateRunnerSessions(RUNNER_ID, snapshots);
  db.notePolicyResumeStatus("resume-marker", "idle");

  const updateBatch = db.updateSessionsFromSnapshots.bind(db);
  const batched: string[] = [];
  db.updateSessionsFromSnapshots = (batch, now) => {
    batched.push(...batch.map(({ id }) => id));
    return updateBatch(batch, now);
  };

  svc.hydrateRunnerSessions(RUNNER_ID, snapshots);

  assert.deepEqual(batched, ["quiescent"]);
  assert.equal(db.policyResumeStatus("resume-marker"), null);
});

test("hydrateHistory is incremental — only fetches events past what's already cached", async () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), 53);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);

  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot()]);
  // Pretend events 1 + 2 are already ingested (e.g. arrived live on the driving dashboard).
  svc.onSessionEvent("s_box1", { kind: "user_message", text: "hi" }, 1, 1000);
  svc.onSessionEvent("s_box1", { kind: "agent_message", text: "hello" }, 2, 1001);
  assert.equal(db.getHydratedSeq("s_box1"), 2);

  const events: StoredSessionEvent[] = [
    { seq: 1, ts: 1000, payload: { kind: "user_message", text: "hi" } },
    { seq: 2, ts: 1001, payload: { kind: "agent_message", text: "hello" } },
    { seq: 3, ts: 1002, payload: { kind: "agent_message", text: "more" } },
  ];
  const seen: ControlPlaneToRunner[] = [];
  hub.attachRunner(RUNNER_ID, scriptedRunnerSocket(hub, events, seen));

  await svc.hydrateHistory("s_box1");

  const req = seen.find((m) => m.type === "session_history");
  assert.ok(req && req.type === "session_history");
  assert.equal(req.afterSeq, 2); // only asked for seq > 2
  assert.equal(db.getHydratedSeq("s_box1"), 3);
  // No duplicate of seq 1/2 — exactly three events total cached.
  assert.equal(db.listEvents("s_box1", 0).length, 3);
});

test("v54 hydration joins one bounded frozen-tail chain and reconciles an ask across pages", async () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);
  svc.hydrateRunnerSessions(RUNNER_ID, [{
    ...snapshot(),
    status: "input_required",
    seq: 3,
    historyEpoch: 7,
  }]);
  const events: StoredSessionEvent[] = [
    {
      seq: 1,
      ts: 1_001,
      payload: {
        kind: "permission_request",
        requestId: "perm-page",
        title: "Continue?",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
    },
    { seq: 2, ts: 1_002, payload: { kind: "agent_message", text: "between pages" } },
    { seq: 3, ts: 1_003, payload: { kind: "policy_transport", state: "open", openedAt: 900 } },
  ];
  const seen: ControlPlaneToRunner[] = [];
  hub.attachRunner(RUNNER_ID, {
    send(data: string) {
      const msg = JSON.parse(data) as ControlPlaneToRunner;
      seen.push(msg);
      if (msg.type !== "session_history_page") return;
      const pageEvents = events.filter((event) => event.seq > msg.afterSeq).slice(0, 2);
      const nextAfterSeq = pageEvents.at(-1)?.seq ?? msg.afterSeq;
      queueMicrotask(() => hub.resolveRunnerRequest({
        type: "session_history_page_result",
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        ok: true,
        events: pageEvents,
        page: { logEpoch: 7, throughSeq: 3, nextAfterSeq, hasMore: nextAfterSeq < 3 },
      }));
    },
  });

  const first = svc.hydrateHistory("s_box1");
  const joined = svc.hydrateHistory("s_box1");
  await Promise.all([first, joined]);

  const pageRequests = seen.filter((message) => message.type === "session_history_page");
  assert.equal(pageRequests.length, 2, "the joining caller must not launch or extend a page chain");
  assert.deepEqual(pageRequests.map((message) => message.afterSeq), [0, 2]);
  assert.equal(seen.some((message) => message.type === "session_history"), false);
  assert.deepEqual(db.listEvents("s_box1").map((event) => event.seq), [1, 2, 3]);
  assert.equal(db.getRunnerHistoryState("s_box1")?.complete, true);
  assert.equal(db.getSession("s_box1")?.pendingApproval?.requestId, "perm-page");
  assert.equal(
    svc.governanceAudit("s_box1").filter((entry) =>
      entry.requestId === "policy-hook-transport:900" &&
      entry.outcome === "delivery_failed").length,
    1,
    "indexed hydration records the same minimized transport audit as live ingestion",
  );
});

test("legacy hydration records policy transport audit exactly once", async () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), 53);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);
  svc.hydrateRunnerSessions(RUNNER_ID, [{ ...snapshot(), seq: 1 }]);
  const events: StoredSessionEvent[] = [{
    seq: 1,
    ts: 1_000,
    payload: {
      kind: "policy_transport",
      state: "recovered",
      openedAt: 700,
      restoresElicitation: true,
    },
  }];
  hub.attachRunner(RUNNER_ID, scriptedRunnerSocket(hub, events, []));

  await svc.hydrateHistory("s_box1");
  await svc.hydrateHistory("s_box1");

  const audit = svc.governanceAudit("s_box1").filter((entry) =>
    entry.requestId === "policy-hook-transport:700");
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.outcome, "allowed");
  assert.equal(audit[0]?.contentDigest?.length, 64);
});

test("v54 hydration rejects a non-contiguous page without advancing or broadcasting it", async () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);
  svc.hydrateRunnerSessions(RUNNER_ID, [{ ...snapshot(), seq: 2, historyEpoch: 4 }]);
  hub.attachRunner(RUNNER_ID, {
    send(data: string) {
      const msg = JSON.parse(data) as ControlPlaneToRunner;
      if (msg.type !== "session_history_page") return;
      queueMicrotask(() => hub.resolveRunnerRequest({
        type: "session_history_page_result",
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        ok: true,
        events: [{ seq: 2, ts: 2, payload: { kind: "agent_message", text: "skips one" } }],
        page: { logEpoch: 4, throughSeq: 2, nextAfterSeq: 2, hasMore: false },
      }));
    },
  });

  await svc.hydrateHistory("s_box1");
  assert.equal(db.getHydratedSeq("s_box1"), 0);
  assert.deepEqual(db.listEvents("s_box1"), []);
});

test("a v54 live gap advances the known tail and fetches even when the prior cache was complete", async () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);
  svc.hydrateRunnerSessions(RUNNER_ID, [{ ...snapshot(), seq: 0, historyEpoch: 6 }]);
  for (let seq = 1; seq <= 5; seq++) {
    svc.onSessionEvent("s_box1", { kind: "agent_message", text: `event-${seq}` }, seq, 1_000 + seq);
  }
  assert.equal(db.getRunnerHistoryState("s_box1")?.complete, true);
  const seen: ControlPlaneToRunner[] = [];
  hub.attachRunner(RUNNER_ID, {
    send(data: string) {
      const msg = JSON.parse(data) as ControlPlaneToRunner;
      seen.push(msg);
      if (msg.type !== "session_history_page") return;
      queueMicrotask(() => hub.resolveRunnerRequest({
        type: "session_history_page_result",
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        ok: true,
        events: [
          { seq: 6, ts: 1_006, payload: { kind: "agent_message", text: "event-6" } },
          { seq: 7, ts: 1_007, payload: { kind: "agent_message", text: "event-7" } },
        ],
        page: { logEpoch: 6, throughSeq: 7, nextAfterSeq: 7, hasMore: false },
      }));
    },
  });

  svc.onSessionEvent("s_box1", { kind: "agent_message", text: "event-7" }, 7, 1_007);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  const request = seen.find((message) => message.type === "session_history_page");
  assert.ok(request && request.type === "session_history_page");
  assert.equal(request.afterSeq, 5);
  assert.deepEqual(db.listEvents("s_box1").map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(db.getRunnerHistoryState("s_box1")?.complete, true);
});

test("a register snapshot epoch reset racing an old chain runs one fresh pass", async () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);
  svc.hydrateRunnerSessions(RUNNER_ID, [{ ...snapshot(), seq: 0, historyEpoch: 1 }]);
  svc.onSessionEvent("s_box1", { kind: "agent_message", text: "old-1" }, 1, 101);
  svc.onSessionEvent("s_box1", { kind: "agent_message", text: "old-2" }, 2, 102);

  let rejectOld!: () => void;
  let oldStarted!: () => void;
  const oldReady = new Promise<void>((resolvePromise) => { oldStarted = resolvePromise; });
  hub.attachRunner(RUNNER_ID, {
    send(data: string) {
      const msg = JSON.parse(data) as ControlPlaneToRunner;
      if (msg.type !== "session_history_page") return;
      if (msg.afterSeq === 2) {
        oldStarted();
        rejectOld = () => hub.resolveRunnerRequest({
          type: "session_history_page_result",
          requestId: msg.requestId,
          sessionId: msg.sessionId,
          ok: false,
          code: "history_epoch_changed",
          error: "reset",
        });
        return;
      }
      queueMicrotask(() => hub.resolveRunnerRequest({
        type: "session_history_page_result",
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        ok: true,
        events: [{ seq: 1, ts: 201, payload: { kind: "agent_message", text: "new-1" } }],
        page: { logEpoch: 2, throughSeq: 1, nextAfterSeq: 1, hasMore: false },
      }));
    },
  });

  svc.hydrateRunnerSessions(RUNNER_ID, [{ ...snapshot(), seq: 3, historyEpoch: 1 }]);
  await oldReady;
  svc.hydrateRunnerSessions(RUNNER_ID, [{ ...snapshot(), seq: 1, historyEpoch: 2 }]);
  rejectOld();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.deepEqual(db.listEvents("s_box1").map((event) => event.payload), [
    { kind: "agent_message", text: "new-1" },
  ]);
  assert.equal(db.getRunnerHistoryState("s_box1")?.historyEpoch, 2);
  assert.equal(db.getRunnerHistoryState("s_box1")?.complete, true);
});

test("listExternalSessions round-trips the runner's enumeration over the hub (Phase 3)", async () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);

  const descriptors = [
    {
      agentSessionId: "codex-1",
      driver: "codex" as const,
      cwd: "C:\\proj",
      context: { kind: "native" as const },
      title: "Build the thing",
      createdAt: 1,
      updatedAt: 9,
      messageCount: 12,
    },
  ];
  // A runner socket that answers a list_external_sessions request.
  hub.attachRunner(RUNNER_ID, {
    send(data: string) {
      const m = JSON.parse(data) as ControlPlaneToRunner;
      if (m.type !== "list_external_sessions") return;
      queueMicrotask(() =>
        hub.resolveRunnerRequest({
          type: "list_external_sessions_result",
          requestId: m.requestId,
          ok: true,
          sessions: descriptors,
        }),
      );
    },
  });

  const res = await svc.listExternalSessions(RUNNER_ID);
  assert.ok(res.ok);
  assert.deepEqual(res.data, descriptors);
});

test("listExternalSessions sends the selected agent and filters broad legacy runner results", async () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);
  let requestedAgentId: string | undefined;

  hub.attachRunner(RUNNER_ID, {
    send(data: string) {
      const message = JSON.parse(data) as ControlPlaneToRunner;
      if (message.type !== "list_external_sessions") return;
      requestedAgentId = message.agentId;
      queueMicrotask(() =>
        hub.resolveRunnerRequest({
          type: "list_external_sessions_result",
          requestId: message.requestId,
          ok: true,
          sessions: [
            {
              agentSessionId: "claude-native",
              driver: "claude-code",
              cwd: "/repos/demo",
              context: { kind: "native" },
              title: "Claude Session",
              createdAt: 1,
              updatedAt: 2,
              messageCount: 3,
            },
            {
              agentSessionId: "codex-native",
              driver: "codex",
              cwd: "/repos/demo",
              context: { kind: "native" },
              title: "Codex Session",
              createdAt: 1,
              updatedAt: 3,
              messageCount: 2,
            },
          ],
        }),
      );
    },
  });

  const res = await svc.listExternalSessions(RUNNER_ID, "claude");
  assert.ok(res.ok);
  assert.equal(requestedAgentId, "claude");
  assert.deepEqual(res.data?.map((session) => session.agentSessionId), ["claude-native"]);
});

test("listExternalSessions requires a newer runner for Codex App Server discovery", async () => {
  const db = ControlPlaneDb.open(":memory:");
  const meta = runnerMeta();
  const appServer = {
    id: "codex-app",
    name: "Codex",
    command: "codex",
    args: ["app-server"],
    env: {},
    driver: "codex-app-server" as const,
    available: true,
    context: { kind: "native" as const },
  };
  meta.agents.push(appServer);
  db.registerRunner(meta, Date.now(), 62);
  const hub = new Hub(db);
  let sent = false;
  hub.attachRunner(RUNNER_ID, { send() { sent = true; } });
  const svc = new SessionsService(db, hub, NOOP_LOG);

  const res = await svc.listExternalSessions(RUNNER_ID, appServer.id);

  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  const error = res.error ?? "";
  assert.equal(
    error,
    "This machine needs a newer runner for Codex app server session discovery. Update and restart the runner.",
  );
  assert.deepEqual(res.capabilityRequirement, { requiredRunnerProtocolVersion: 63, runnerProtocolVersion: 62 });
  assert.equal(sent, false, "an old runner must not return a misleading empty App Server result");
});

test("listExternalSessions fails 409 when the runner is offline", async () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const hub = new Hub(db); // no runner attached
  const svc = new SessionsService(db, hub, NOOP_LOG);
  const res = await svc.listExternalSessions(RUNNER_ID);
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
});

test("listExternalSessions fails fast when an online runner cannot prove protocol v6", async () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), null);
  const hub = new Hub(db);
  let sent = false;
  hub.attachRunner(RUNNER_ID, { send() { sent = true; } });
  const svc = new SessionsService(db, hub, NOOP_LOG);
  const res = await svc.listExternalSessions(RUNNER_ID);
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.equal(
    res.error,
    "This machine needs a newer runner for finding agent sessions. Update and restart the runner.",
  );
  assert.deepEqual(res.capabilityRequirement, { requiredRunnerProtocolVersion: 6, runnerProtocolVersion: null });
  assert.equal(sent, false, "unsupported requests must not start the 20 second runner timeout");
});

test("a gap arriving mid-backfill forces a second pass so the later event isn't dropped", async () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), 53);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot()]); // cursor 0, no events cached

  // A runner socket that RECORDS each history request so the test replies on demand (interleaving a
  // second gap while the first fetch is in flight).
  const requests: { requestId: string; afterSeq: number }[] = [];
  hub.attachRunner(RUNNER_ID, {
    send(data: string) {
      const m = JSON.parse(data) as ControlPlaneToRunner;
      if (m.type === "session_history") requests.push({ requestId: m.requestId, afterSeq: m.afterSeq });
    },
  });
  const tick = () => new Promise((r) => setImmediate(r));
  const reply = (requestId: string, events: StoredSessionEvent[]) =>
    hub.resolveRunnerRequest({ type: "session_history_result", requestId, sessionId: "s_box1", ok: true, events });
  const msgs = (...seqs: number[]): StoredSessionEvent[] =>
    seqs.map((seq) => ({ seq, ts: 1000 + seq, payload: { kind: "agent_message", text: `m${seq}` } }));

  // Live seq 5 (gap) starts backfill request #1 (in flight).
  svc.onSessionEvent("s_box1", { kind: "agent_message", text: "five" }, 5, 1005);
  assert.equal(requests.length, 1);
  // Live seq 6 arrives WHILE #1 is in flight — coalesced (no new request yet).
  svc.onSessionEvent("s_box1", { kind: "agent_message", text: "six" }, 6, 1006);
  assert.equal(requests.length, 1);

  // Reply to #1 with only 1-5 (the runner's snapshot for that reply didn't include 6).
  reply(requests[0].requestId, msgs(1, 2, 3, 4, 5));
  await tick();
  // The mid-fetch gap forced a second pass that asks for events past 5.
  assert.equal(requests.length, 2);
  assert.equal(requests[1].afterSeq, 5);

  // Reply to #2 with event 6 — nothing dropped.
  reply(requests[1].requestId, msgs(6));
  await tick();

  assert.equal(db.getHydratedSeq("s_box1"), 6);
  assert.equal(db.listEvents("s_box1", 0).length, 6);
});
