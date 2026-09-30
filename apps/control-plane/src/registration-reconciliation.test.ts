import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, PROTOCOL_VERSION, type SessionSnapshot } from "@wollipog/protocol";
import { ControlPlaneDb, RUNNER_REPORTED_STOP } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";

function fixture(children = 1000) {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner({ runnerId: "runner", hostname: "synthetic", os: "linux", version: "test",
    workspaces: [], agents: [] }, 1, PROTOCOL_VERSION);
  const hub = new Hub(db);
  const logs: string[] = [];
  const svc = new SessionsService(db, hub, { info: (s) => logs.push(s), warn: (s) => logs.push(s), error() {} });
  const base = { runnerId: "runner", workspaceId: "ws", agentId: "claude", title: "Synthetic",
    driver: "claude-code" as const, useWorktree: false, config: {}, now: 1 };
  const snapshots: SessionSnapshot[] = [];
  for (let i = 0; i < 10; i++) db.createSession({ ...base, id: `campaign-${i}`,
    orchestratorPolicy: resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default") });
  for (let i = 0; i < children; i++) {
    const id = `child-${i}`;
    db.createSession({ ...base, id, parentSessionId: `campaign-${i % 10}` });
    db.updateSessionStatus(id, "stopped", 2, RUNNER_REPORTED_STOP);
    snapshots.push({ id, workspaceId: "ws", agentId: "claude", title: "Synthetic", status: "stopped",
      driver: "claude-code", useWorktree: false, worktreePath: null, config: {}, preview: null,
      pendingApproval: null, tokensIn: 0, tokensOut: 0, costUsd: 0, seq: 0, createdAt: 1, updatedAt: 2 });
  }
  return { db, hub, svc, snapshots, logs };
}

test("registration attention scans scale with campaigns, not retained children", () => {
  const { db, svc, snapshots } = fixture();
  try {
    let scans = 0;
    const original = svc.descendantRequests.bind(svc);
    svc.descendantRequests = (...args) => { scans++; return original(...args); };
    svc.hydrateRunnerSessions("runner", snapshots);
    assert.equal(scans, 20, "each of ten campaigns needs one human and one orchestrator scan");
    // Replays may inspect durable identities, but must not grow continuation storage.
    const before = db.raw().prepare("SELECT COUNT(*) AS n FROM orchestrator_campaign_events").get();
    svc.hydrateRunnerSessions("runner", snapshots);
    assert.deepEqual(db.raw().prepare("SELECT COUNT(*) AS n FROM orchestrator_campaign_events").get(), before);
  } finally { db.close(); }
});

test("cooperative registration yields and cancellation never settles absent sessions", async () => {
  const { db, svc, snapshots, logs } = fixture(100);
  try {
    let current = true;
    let turns = 0;
    const drain = svc.hydrateRunnerSessionsCooperatively("runner", snapshots, {
      isCurrent: () => current,
      yieldToLoop: async () => { turns++; current = false; },
    });
    assert.equal(await drain, false);
    assert.equal(turns, 1);
    assert.equal(db.getSession("campaign-0")?.status, "queued", "cancelled inventory cannot stop an absent session");
    assert.match(logs.join("\n"), /runner_reconciliation_cancelled/);
    assert.doesNotMatch(logs.join("\n"), /Synthetic|child-\d/);
  } finally { db.close(); }
});

test("Stop, deletion, and new-session intents arriving between batches remain authoritative", async () => {
  const { db, svc, snapshots } = fixture(100);
  try {
    db.updateSessionStatus("child-80", "running", 3);
    snapshots[80] = { ...snapshots[80]!, status: "running" };
    db.setPendingApproval("child-82", { requestId: "answered", title: "Answer", options: [] });
    snapshots[82] = { ...snapshots[82]!, status: "running", pendingApproval: db.getSession("child-82")!.pendingApproval };
    let turns = 0;
    assert.equal(await svc.hydrateRunnerSessionsCooperatively("runner", snapshots, {
      isCurrent: () => true,
      yieldToLoop: async () => {
        if (++turns !== 1) return;
        assert.ok(svc.stop("child-80").ok);
        assert.ok(svc.delete("child-81").ok);
        db.setPendingApproval("child-82", null);
        db.updateSessionStatus("child-83", "starting", Date.now());
        db.updateSessionStatus("campaign-0", "starting", Date.now());
        db.setWorktreePath("child-84", "/synthetic/new-worktree");
        db.createSession({ id: "new", runnerId: "runner", workspaceId: "ws", agentId: "claude",
          title: "New", driver: "claude-code", useWorktree: false, config: {}, now: Date.now() });
        db.addTombstone("new-delete", "runner", Date.now());
      },
    }), true);
    assert.equal(db.getSession("child-80")?.status, "stopped");
    assert.ok(db.hasSessionStopIntent("child-80"));
    assert.equal(db.getSession("child-81"), null);
    assert.ok(db.isTombstoned("child-81"));
    assert.equal(db.getSession("child-82")?.pendingApproval, null, "an answered request must not be resurrected");
    assert.equal(db.getSession("child-83")?.status, "starting", "an old snapshot must not end a newly admitted launch");
    assert.equal(db.getSession("campaign-0")?.status, "starting", "an absent row relaunched during reconciliation is not stopped");
    assert.equal(db.getSession("child-84")?.worktreePath, "/synthetic/new-worktree", "worktree attachment has no updated_at bump but must survive");
    assert.equal(db.getSession("new")?.status, "queued");
    assert.ok(db.isTombstoned("new-delete"), "new deletion is not confirmed by an older inventory");
  } finally { db.close(); }
});

test("post-negotiation runtime replay coalesces campaign attention without deferring unrelated HTTP work", async () => {
  const { db, svc, snapshots } = fixture();
  try {
    svc.hydrateRunnerSessions("runner", snapshots);
    let scans = 0;
    const original = svc.descendantRequests.bind(svc);
    svc.descendantRequests = (...args) => { scans++; return original(...args); };
    const batch = svc.beginRunnerAttentionBatch("runner");
    for (const snap of snapshots) svc.applySessionRuntimeUpdate("runner", { ...snap, preview: "Negotiated" }, batch);
    assert.equal(scans, 0, "only this explicit frame batch defers campaign-wide scans");
    await svc.flushRunnerAttention("runner", () => true);
    assert.equal(scans, 20);
    assert.equal(db.getSession("child-999")?.preview, "Negotiated");
    scans = 0;
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[0]!, preview: "Live" });
    assert.equal(scans, 2, "ordinary callers retain immediate campaign publication");
  } finally { db.close(); }
});

test("cancelled registration carries the first campaign before-view into its replacement", async () => {
  const { db, svc, snapshots } = fixture(100);
  try {
    db.setPendingApproval("child-0", { requestId: "q", kind: "question", title: "Private question", options: [],
      questions: [{ id: "choice", question: "Private question", header: "Choice", options: [{ label: "Yes" }] }] });
    const before = db.getSession("campaign-0")?.orchestratorCampaign?.pendingRequests?.human;
    assert.equal(before, 1);
    let current = true;
    assert.equal(await svc.hydrateRunnerSessionsCooperatively("runner", snapshots, {
      isCurrent: () => current, yieldToLoop: async () => { current = false; },
    }), false);
    assert.equal(db.getSession("child-0")?.pendingApproval, null);
    assert.equal(await svc.hydrateRunnerSessionsCooperatively("runner", snapshots, { isCurrent: () => true }), true);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM orchestrator_campaign_events WHERE campaign_session_id=? AND kind='human_blockers_cleared'")
      .get("campaign-0")?.n, 1, "replacement emits the cleared-blocker wakeup exactly once");
    const beforeReplay = db.raw().prepare("SELECT seq FROM sqlite_sequence WHERE name='orchestrator_campaign_events'").get();
    svc.hydrateRunnerSessions("runner", snapshots);
    assert.deepEqual(db.raw().prepare("SELECT seq FROM sqlite_sequence WHERE name='orchestrator_campaign_events'").get(), beforeReplay,
      "duplicate continuation identities do not write or consume sequence numbers");
  } finally { db.close(); }
});

test("cancelled runtime attention flush carries cleared blockers into replacement registration", async () => {
  const { db, svc, snapshots } = fixture(100);
  try {
    db.setPendingApproval("child-0", { requestId: "q", kind: "question", title: "Private question", options: [],
      questions: [{ id: "choice", question: "Private question", header: "Choice", options: [{ label: "Yes" }] }] });
    assert.equal(db.getSession("campaign-0")?.orchestratorCampaign?.pendingRequests?.human, 1);
    const batch = svc.beginRunnerAttentionBatch("runner");
    svc.applySessionRuntimeUpdate("runner", snapshots[0]!, batch);
    await svc.flushRunnerAttention("runner", () => false);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM orchestrator_campaign_events WHERE kind='human_blockers_cleared'")
      .get()?.n, 0, "a stale socket cannot publish attention");
    await svc.hydrateRunnerSessionsCooperatively("runner", snapshots, { isCurrent: () => true });
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM orchestrator_campaign_events WHERE campaign_session_id=? AND kind='human_blockers_cleared'")
      .get("campaign-0")?.n, 1, "replacement publishes the partially committed runtime transition exactly once");
  } finally { db.close(); }
});

test("an immediate publication consumes human blocker transitions deferred by a runtime batch", async () => {
  const { db, svc, snapshots } = fixture(100);
  try {
    for (const id of ["child-0", "child-10"]) db.setPendingApproval(id, {
      requestId: `q-${id}`, kind: "question", title: "Private question", options: [],
      questions: [{ id: "choice", question: "Private question", header: "Choice", options: [{ label: "Yes" }] }],
    });
    assert.equal(db.getSession("campaign-0")?.orchestratorCampaign?.pendingRequests?.human, 2);
    const batch = svc.beginRunnerAttentionBatch("runner");
    svc.applySessionRuntimeUpdate("runner", snapshots[0]!, batch);
    // Direct callers, including HTTP decisions, publish immediately from the current before-view.
    svc.applySessionRuntimeUpdate("runner", snapshots[10]!);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM orchestrator_campaign_events WHERE kind='human_blockers_cleared'")
      .get()?.n, 1);
    await svc.flushRunnerAttention("runner", () => true);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM orchestrator_campaign_events WHERE kind='human_blockers_cleared'")
      .get()?.n, 1, "the older deferred token set must not create a second cleared-blocker wakeup");
  } finally { db.close(); }
});

test("a campaign deleted during reconciliation cannot receive stale attention publications", async () => {
  const { db, svc, snapshots } = fixture(100);
  try {
    db.setPendingApproval("child-0", { requestId: "q", kind: "question", title: "Private question", options: [],
      questions: [{ id: "choice", question: "Private question", header: "Choice", options: [{ label: "Yes" }] }] });
    let yielded = false;
    assert.equal(await svc.hydrateRunnerSessionsCooperatively("runner", snapshots, {
      isCurrent: () => true, yieldToLoop: async () => {
        if (yielded) return;
        yielded = true;
        assert.ok(svc.delete("campaign-0").ok);
      },
    }), true);
    assert.equal(db.getSession("campaign-0"), null);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM orchestrator_campaign_events WHERE campaign_session_id='campaign-0'")
      .get()?.n, 0);
  } finally { db.close(); }
});

test("registration refreshes the deferred before-view after a publication yield", async () => {
  const { db, svc, snapshots } = fixture(100);
  try {
    const ask = (requestId: string) => ({ requestId, kind: "question" as const, title: "Private question", options: [],
      questions: [{ id: "choice", question: "Private question", header: "Choice", options: [{ label: "Yes" }] }] });
    db.setPendingApproval("child-0", ask("old"));
    let intervened = false;
    await svc.hydrateRunnerSessionsCooperatively("runner", snapshots, {
      isCurrent: () => true, yieldToLoop: async () => {
        // All absent campaign rows settle before the first attention publication. At that yield,
        // an immediate answer must consume even a before-view already captured by the iterator.
        if (intervened || db.getSession("campaign-9")?.status !== "stopped") return;
        intervened = true;
        db.setPendingApproval("child-0", ask("new"));
        svc.applySessionRuntimeUpdate("runner", { ...snapshots[0]!, preview: "Immediate" });
      },
    });
    assert.equal(intervened, true);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM orchestrator_campaign_events WHERE kind='human_blockers_cleared'")
      .get()?.n, 1);
  } finally { db.close(); }
});
