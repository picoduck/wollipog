import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION, type RunnerMetadata, type SessionEvent, type SessionView } from "@wollipog/protocol";
import { ControlPlaneDb, type NewSessionInput } from "./db.js";
import type { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";

// An OS crash or power loss can roll back a relaxed runner-event commit
// (docs/control-plane-database-durability.md). These tests stand in for the crash by copying the
// database file from before the relaxed commits and reopening the copy on a different host boot.

const runner: RunnerMetadata = {
  runnerId: "runner-1", hostname: "host-1", os: "linux", version: "1.0.0", agents: [],
  workspaces: [{ id: "ws-1", name: "Repo", path: "/code/repo" }],
};

function newSession(overrides: Partial<NewSessionInput> = {}): NewSessionInput {
  return {
    id: "sess-1", runnerId: "runner-1", workspaceId: "ws-1", agentId: "agent", title: "Session",
    useWorktree: false, driver: "acp", config: {}, now: 1_000, ...overrides,
  };
}

const NOOP_LOG = { info() {}, warn() {}, error() {} };
const HISTORY_EPOCH = 7;
const prompt = { kind: "user_message", text: "prompt" } as const;
const streamedA = { kind: "agent_message", text: "A" } as const;
const streamedB = { kind: "agent_message", text: "B" } as const;
const reconnectNotice = { kind: "stderr", text: "runner reconnected — session restored" } as const;

/** The dashboard's slice of the web store this scenario drives. */
interface DashboardStore {
  dispatch(action: { type: "msg"; msg: unknown }): void;
  navigate(view: { name: "session"; id: string }): void;
  prepareSubscriptionRecovery(revision: number, sessionIds: string[]): void;
  beginEventHistoryLoad(sessionId: string, eventEpoch: number, recoveryRevision: number): void;
  loadEvents(sessionId: string, events: SessionEvent[], eventEpoch: number, recoveryRevision: number, complete: boolean): void;
  recoveryAfter(sessionId: string): number;
  eventEpoch(sessionId: string): number;
  getState(): { events: Map<string, SessionEvent[]> };
}

async function dashboardStore(): Promise<DashboardStore> {
  // Imported by URL so this package's typecheck does not pull in the web app's DOM and JSX sources.
  const store = await import(new URL("../../web/src/store.tsx", import.meta.url).href) as {
    Store: new () => DashboardStore;
  };
  return new store.Store();
}

const transcript = (events: readonly SessionEvent[] | undefined) =>
  (events ?? []).map((event) => `${event.seq}:${"text" in event.payload ? event.payload.text : event.payload.kind}`);

function eventEpoch(db: ControlPlaneDb, sessionId = "sess-1"): number {
  return db.getRunnerHistoryState(sessionId)!.eventEpoch;
}

/** What a dashboard does when its WebSocket reconnects: adopt the snapshot, then recover the
 * session's history above its cursor in the session's current event epoch. */
function reconnectDashboard(store: DashboardStore, db: ControlPlaneDb, revision: number): void {
  store.dispatch({ type: "msg", msg: {
    type: "snapshot",
    capabilities: { sessionSubscriptions: true, boundedDelivery: true },
    runners: [], boxes: [], runs: [], pods: [],
    sessions: [{ id: "sess-1", eventEpoch: eventEpoch(db) } as SessionView],
  } });
  store.prepareSubscriptionRecovery(revision, ["sess-1"]);
  store.dispatch({ type: "msg", msg: {
    type: "session_subscriptions_applied", revision, sessionIds: ["sess-1"], podIds: [],
  } });
  const epoch = store.eventEpoch("sess-1");
  store.beginEventHistoryLoad("sess-1", epoch, revision);
  assert.equal(epoch, eventEpoch(db), "the dashboard recovers in the server's current epoch");
  store.loadEvents("sess-1", db.listEvents("sess-1", store.recoveryAfter("sess-1")), epoch, revision, true);
}

/**
 * Builds the scenario up to the crash. Returns the database file as it was after the prompt (the
 * state a crash before the next WAL flush leaves) and a dashboard that saw the prompt and two
 * streamed runner events that the crash will roll back.
 */
async function streamThenCrash(root: string, campaign = false): Promise<{
  crashed: string; store: DashboardStore; reportSeq: number | null;
}> {
  const live = join(root, "control-plane.db");
  const crashed = join(root, "crashed.db");
  let db = ControlPlaneDb.open(live, { hostBootId: "boot-before-crash" });
  db.registerRunner(runner, 500, PROTOCOL_VERSION);
  let reportSeq: number | null = null;
  if (campaign) {
    db.createSession(newSession({ id: "campaign", config: { permissionMode: "orchestrator" } }));
    db.createSession(newSession({ parentSessionId: "campaign" }));
  } else {
    db.createSession(newSession());
  }
  db.reconcileRunnerHistory("sess-1", HISTORY_EPOCH, 0);
  db.appendEvent("sess-1", prompt, 1_001);
  if (campaign) {
    db.updateSessionStatus("sess-1", "idle", 1_002);
    const report = db.appendHydratedPage("sess-1", { afterSeq: 0, historyEpoch: HISTORY_EPOCH, eventEpoch: 0 }, [
      { seq: 1, ts: 1_003, payload: { kind: "agent_message", text: "Final report", final: true } },
    ]);
    reportSeq = report.events[0]!.seq;
    // A FULL commit: it also flushes every relaxed commit before it, so the report itself survives.
    db.verifyCampaignChildReport("campaign", "sess-1", reportSeq, 1_004);
    const ledger = db.campaignWorkLedger;
    const planned = ledger.recordPlan("campaign", "campaign", {
      items: [{ key: "item", dispatchState: "queued" }], planComplete: true,
    }, 1_005);
    assert.ok(planned.ok);
    const workItemId = planned.data.items[0]!.workItemId;
    assert.ok(ledger.assign("campaign", "campaign", workItemId, "sess-1",
      { title: null, harness: null, agentName: null, model: null, effort: null }, 1_006).ok);
    assert.ok(ledger.recordVerification("campaign", {
      workItemId, childSessionId: "sess-1", outcome: "delivered",
      report: db.campaignReportIdentity("sess-1", reportSeq), verifiedBySessionId: "campaign",
    }, 1_007).ok);
  }
  db.close();
  assert.equal(existsSync(`${live}-wal`), false, "closing checkpointed the WAL into the database file");
  copyFileSync(live, crashed);

  db = ControlPlaneDb.open(live, { hostBootId: "boot-before-crash" });
  const store = await dashboardStore();
  store.dispatch({ type: "msg", msg: {
    type: "snapshot",
    capabilities: { sessionSubscriptions: true, boundedDelivery: true },
    runners: [], boxes: [], runs: [], pods: [],
    sessions: [{ id: "sess-1", eventEpoch: eventEpoch(db) } as SessionView],
  } });
  store.navigate({ name: "session", id: "sess-1" });
  const after = db.getHydratedSeq("sess-1");
  for (const [index, payload] of [streamedA, streamedB].entries()) {
    const event = db.appendEvent("sess-1", payload, 1_010 + index, { runnerSeq: after + index + 1, historyEpoch: HISTORY_EPOCH });
    store.dispatch({ type: "msg", msg: { type: "session_event", event } });
  }
  store.loadEvents("sess-1", db.listEvents("sess-1"), eventEpoch(db), -1, true);
  db.close();
  return { crashed, store, reportSeq };
}

/** After the restart: the control plane writes its own event, then hydration replays the
 * runner's retained events the crash rolled back. */
function restartThenReplay(db: ControlPlaneDb): void {
  db.registerRunner(runner, 2_000, PROTOCOL_VERSION);
  db.appendEvent("sess-1", reconnectNotice, 2_001);
  const hydrated = db.getHydratedSeq("sess-1");
  const reconciled = db.reconcileRunnerHistory("sess-1", HISTORY_EPOCH, hydrated + 2)!;
  assert.equal(reconciled.complete, false, "the runner's retained tail is ahead of the rolled-back cache");
  const page = db.appendHydratedPage(
    "sess-1",
    { afterSeq: hydrated, historyEpoch: HISTORY_EPOCH, eventEpoch: reconciled.eventEpoch },
    [{ seq: hydrated + 1, ts: 1_010, payload: streamedA }, { seq: hydrated + 2, ts: 1_011, payload: streamedB }],
  );
  assert.equal(page.applied, true);
  assert.equal(db.getRunnerHistoryState("sess-1")!.complete, true);
}

test("an open dashboard adopts the server's order after a rolled-back event suffix replays behind a control-plane event", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-ingest-rollback-"));
  try {
    const { crashed, store } = await streamThenCrash(root);
    assert.deepEqual(transcript(store.getState().events.get("sess-1")), ["1:prompt", "2:A", "3:B"]);

    const db = ControlPlaneDb.open(crashed, { hostBootId: "boot-after-crash" });
    try {
      const upserts: string[] = [];
      new SessionsService(db, { sessionChangedById: (id: string) => upserts.push(id) } as unknown as Hub, NOOP_LOG);
      assert.deepEqual(transcript(db.listEvents("sess-1")), ["1:prompt"], "the crash rolled back A and B");
      restartThenReplay(db);
      const server = transcript(db.listEvents("sess-1"));
      assert.deepEqual(server, ["1:prompt", "2:runner reconnected — session restored", "3:A", "4:B"]);
      assert.equal(eventEpoch(db), 1, "the replay reassigned sequence numbers, so the event epoch advances");
      assert.deepEqual(upserts, ["sess-1"], "connected dashboards receive the session's new epoch once");
      reconnectDashboard(store, db, 1);
      assert.deepEqual(transcript(store.getState().events.get("sess-1")), server,
        "the open dashboard shows the server's history without a reload");
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an ordinary restart without a host reboot keeps the event epoch and the dashboard's cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-ingest-ordinary-restart-"));
  try {
    const live = join(root, "control-plane.db");
    let db = ControlPlaneDb.open(live, { hostBootId: "boot-1" });
    db.registerRunner(runner, 500, PROTOCOL_VERSION);
    db.createSession(newSession());
    db.reconcileRunnerHistory("sess-1", HISTORY_EPOCH, 0);
    db.appendEvent("sess-1", prompt, 1_001);
    db.appendEvent("sess-1", streamedA, 1_002, { runnerSeq: 1, historyEpoch: HISTORY_EPOCH });
    const store = await dashboardStore();
    store.navigate({ name: "session", id: "sess-1" });
    reconnectDashboard(store, db, 1);
    const cached = store.getState().events.get("sess-1");
    assert.deepEqual(transcript(cached), ["1:prompt", "2:A"]);
    db.close();

    // Same boot: no commit can have rolled back. The runner streamed B while the control plane was
    // down, and the reconnect notice lands before B is pulled, exactly the shape of a rollback.
    db = ControlPlaneDb.open(live, { hostBootId: "boot-1" });
    try {
      db.appendEvent("sess-1", reconnectNotice, 2_001);
      db.reconcileRunnerHistory("sess-1", HISTORY_EPOCH, 2);
      assert.equal(db.appendHydratedPage("sess-1", { afterSeq: 1, historyEpoch: HISTORY_EPOCH, eventEpoch: 0 },
        [{ seq: 2, ts: 2_002, payload: streamedB }]).applied, true);
      assert.equal(eventEpoch(db), 0, "an ordinary restart never advances the event epoch");

      reconnectDashboard(store, db, 2);
      const events = store.getState().events.get("sess-1")!;
      assert.deepEqual(transcript(events), ["1:prompt", "2:A", "3:runner reconnected — session restored", "4:B"]);
      assert.equal(events[0], cached![0], "the dashboard kept its cached events and fetched only the new ones");
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("after a reboot, a replay that continues the surviving history in order keeps the event epoch", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-ingest-rollback-in-order-"));
  try {
    const { crashed, store } = await streamThenCrash(root);
    const db = ControlPlaneDb.open(crashed, { hostBootId: "boot-after-crash" });
    try {
      // No control-plane event lands before the replay, so A and B return to their old numbers.
      const reconciled = db.reconcileRunnerHistory("sess-1", HISTORY_EPOCH, 2)!;
      db.appendHydratedPage("sess-1", { afterSeq: 0, historyEpoch: HISTORY_EPOCH, eventEpoch: reconciled.eventEpoch },
        [{ seq: 1, ts: 1_010, payload: streamedA }, { seq: 2, ts: 1_011, payload: streamedB }]);
      // Caught up with the runner: later control-plane events cannot collide with a lost number.
      db.appendEvent("sess-1", reconnectNotice, 2_001);
      db.appendEvent("sess-1", { kind: "agent_message", text: "C" }, 2_002, { runnerSeq: 3, historyEpoch: HISTORY_EPOCH });
      assert.equal(eventEpoch(db), 0);
      reconnectDashboard(store, db, 1);
      assert.deepEqual(transcript(store.getState().events.get("sess-1")),
        ["1:prompt", "2:A", "3:B", "4:runner reconnected — session restored", "5:C"]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a verified campaign report stays verified when a rollback replay advances the child's event epoch", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-ingest-rollback-campaign-"));
  try {
    const { crashed, reportSeq } = await streamThenCrash(root, true);
    const db = ControlPlaneDb.open(crashed, { hostBootId: "boot-after-crash" });
    try {
      assert.equal(db.campaignChildReportVerified("campaign", "sess-1"), true);
      restartThenReplay(db);
      assert.equal(eventEpoch(db), 1);
      assert.equal(db.campaignReportIdentity("sess-1", reportSeq!).eventEpoch, 1);
      const binding = db.raw().prepare(
        "SELECT report_event_seq, report_event_epoch FROM orchestrator_campaign_child_reports WHERE child_session_id='sess-1'",
      ).get() as { report_event_seq: number; report_event_epoch: number };
      assert.deepEqual({ ...binding }, { report_event_seq: reportSeq, report_event_epoch: 1 },
        "the binding follows the epoch because the report event kept its sequence number");
      db.finishCampaignReportHistoryHydration("sess-1");
      assert.equal(db.campaignChildReportVerified("campaign", "sess-1"), true,
        "completing hydration does not discard the restamped verification");

      // The delivered work-item proof moved too, so an identical retry still resolves to it.
      const { id: workItemId } = db.raw().prepare(
        "SELECT id FROM campaign_work_items WHERE campaign_session_id='campaign'",
      ).get() as { id: string };
      const retry = db.campaignWorkLedger.verificationTarget("campaign", workItemId, "sess-1", "delivered",
        db.campaignReportIdentity("sess-1", reportSeq!));
      assert.ok(retry.ok, "an identical verification retry is not refused after the epoch advance");
      assert.ok(retry.data.existing);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
