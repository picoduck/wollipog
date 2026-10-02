import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, PROTOCOL_VERSION, type SessionSnapshot } from "@wollipog/protocol";
import { ControlPlaneDb, RUNNER_REPORTED_STOP } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { pushDecision } from "./push-decision.js";

function fixture(children = 1000, file = ":memory:") {
  const db = ControlPlaneDb.open(file);
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

const question = (requestId: string) => ({ requestId, kind: "question" as const,
  title: "Private synthetic question", options: [],
  questions: [{ id: "choice", question: "Private synthetic question", header: "Choice", options: [{ label: "Yes" }] }],
});

test("overlapping batches report each new human occurrence once even while a push is in flight", async () => {
  const { db, hub, snapshots } = fixture(30);
  const inFlight: string[] = [];
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} }, (before, after) => {
    const decision = pushDecision(before, after);
    // Deliberately retain every decision as in-flight, with no queue coalescing or completion.
    if (decision?.sessionId === "campaign-0" && decision.urgency === "high") inFlight.push(decision.title);
  });
  try {
    const first = svc.beginRunnerAttentionBatch("runner");
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[0]!, preview: "Deferred" }, first);
    const overlapping = svc.beginRunnerAttentionBatch("runner");
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[20]!, preview: "Overlapping" }, overlapping);
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[10]!, pendingApproval: question("first") });
    assert.equal(inFlight.length, 1);
    await svc.flushRunnerAttention("runner", () => false);
    assert.equal(inFlight.length, 1, "cancelled socket cannot consume or repeat the alert");
    svc.beginRunnerAttentionBatch("runner"); // replacement inherits the before-view and notification identity
    await svc.flushRunnerAttention("runner", () => true);
    assert.equal(inFlight.length, 1, "flush cannot repeat an already in-flight occurrence");
    const next = svc.beginRunnerAttentionBatch("runner");
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[0]!, preview: "Another batch" }, next);
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[10]!, pendingApproval: question("replacement") });
    assert.equal(inFlight.length, 2, "a same-count new occurrence still notifies");
    await svc.flushRunnerAttention("runner", () => true);
    assert.equal(inFlight.length, 2);
  } finally { db.close(); }
});

test("a reported new sibling occurrence does not consume an older unreported deferred question", async () => {
  const { db, hub, snapshots } = fixture(20);
  const messages: string[] = [];
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} }, (before, after) => {
    const decision = pushDecision(before, after);
    if (decision?.sessionId === "campaign-0" && decision.urgency === "high") messages.push(decision.title);
  });
  try {
    const batch = svc.beginRunnerAttentionBatch("runner");
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[0]!, pendingApproval: question("deferred") }, batch);
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[10]!, pendingApproval: question("immediate") });
    assert.equal(messages.length, 1);
    await svc.flushRunnerAttention("runner", () => true);
    assert.equal(messages.length, 2, "the older unreported question still notifies separately");
    await svc.flushRunnerAttention("runner", () => true);
    assert.equal(messages.length, 2);
  } finally { db.close(); }
});

test("reported occurrence identities survive until every overlapping runner batch retires", async () => {
  const { db, hub, snapshots } = fixture(20);
  db.registerRunner({ runnerId: "other", hostname: "synthetic", os: "linux", version: "test",
    agents: [], workspaces: [] }, 1, PROTOCOL_VERSION);
  db.raw().prepare("UPDATE sessions SET runner_id='other' WHERE id='child-10'").run();
  let urgent = 0;
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} }, (before, after) => {
    if (pushDecision(before, after)?.sessionId === "campaign-0" && pushDecision(before, after)?.urgency === "high") urgent++;
  });
  try {
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[0]!, preview: "First" }, svc.beginRunnerAttentionBatch("runner"));
    svc.applySessionRuntimeUpdate("other", { ...snapshots[10]!, preview: "Second" }, svc.beginRunnerAttentionBatch("other"));
    svc.applySessionRuntimeUpdate("other", { ...snapshots[10]!, pendingApproval: question("new") });
    assert.equal(urgent, 1);
    await svc.flushRunnerAttention("runner", () => true);
    await svc.flushRunnerAttention("other", () => false);
    svc.beginRunnerAttentionBatch("other"); // replacement of the second socket
    await svc.flushRunnerAttention("other", () => true);
    assert.equal(urgent, 1);
    assert.equal(db.deferredCampaignAttentionIds("runner").length, 0);
    assert.equal(db.deferredCampaignAttentionIds("other").length, 0);
  } finally { db.close(); }
});

test("a failed write-ahead checkpoint cannot commit an unprotected deferred runtime mutation", () => {
  const { db, svc, snapshots } = fixture(10);
  try {
    db.setPendingApproval("child-0", question("protected"));
    db.retainCampaignAttentionCheckpoint = () => { throw new Error("Synthetic checkpoint failure"); };
    const batch = svc.beginRunnerAttentionBatch("runner");
    assert.throws(() => svc.applySessionRuntimeUpdate("runner", snapshots[0]!, batch), /checkpoint failure/);
    assert.equal(db.getSession("child-0")?.pendingApproval?.requestId, "protected");
  } finally { db.close(); }
});

for (const crashPoint of ["after_session_commit", "during_publication", "after_human_event"] as const) {
  test(`SIGKILL ${crashPoint} preserves owed campaign wakeups across database reopen and replay`, async () => {
    const root = mkdtempSync(join(tmpdir(), "campaign-attention-crash-"));
    const file = join(root, "control-plane.db");
    let db: ControlPlaneDb | undefined;
    try {
      // Real process loss: no close(), finally block, or graceful service shutdown runs. All
      // mutation/checkpoint/publication code below is the same service used by registration.
      const script = `
        import { ControlPlaneDb, RUNNER_REPORTED_STOP } from ${JSON.stringify(new URL("./db.ts", import.meta.url).href)};
        import { Hub } from ${JSON.stringify(new URL("./hub.ts", import.meta.url).href)};
        import { SessionsService } from ${JSON.stringify(new URL("./sessions.ts", import.meta.url).href)};
        import { resolveOrchestratorCampaignPolicy } from ${JSON.stringify(new URL("./orchestrator-settings.ts", import.meta.url).href)};
        import { DEFAULT_ORCHESTRATOR_DEFAULTS, PROTOCOL_VERSION } from ${JSON.stringify(new URL("../../../packages/protocol/src/index.ts", import.meta.url).href)};
        const __name = value => value; // tsx may annotate names in the stringified fixture
        ${fixture.toString()}
        const { db, svc, snapshots } = fixture(70, ${JSON.stringify(file)});
        db.updateSessionStatus('campaign-0', 'idle', 3);
        db.raw().prepare("UPDATE sessions SET parent_session_id='campaign-0' WHERE id LIKE 'child-%'").run();
        db.raw().prepare("UPDATE sessions SET parent_control='questions_and_approvals' WHERE id='campaign-0'").run();
        const ask = ${question.toString()};
        for (const snap of snapshots) db.setPendingApproval(snap.id, ask('ask-' + snap.id));
        db.setPendingApproval('child-0', { requestId: 'auth-human', kind: 'authentication', title: 'Private auth', options: [] });
        const before = db.getSession('campaign-0').orchestratorCampaign.pendingRequests;
        if (before.human !== 1 || before.orchestrator !== 69) throw new Error(JSON.stringify(before));
        const batch = svc.beginRunnerAttentionBatch('runner');
        for (const snap of snapshots) svc.applySessionRuntimeUpdate('runner', snap, batch);
        const crash = () => process.kill(process.pid, 'SIGKILL');
        if (${JSON.stringify(crashPoint)} === 'after_session_commit') crash();
        const record = db.recordCampaignContinuationEvent.bind(db);
        let writes = 0;
        db.recordCampaignContinuationEvent = input => {
          if (${JSON.stringify(crashPoint)} === 'during_publication' && ++writes === 33) crash();
          const result = record(input);
          return result;
        };
        if (${JSON.stringify(crashPoint)} === 'after_human_event') {
          const notify = db.recordCampaignContinuationEvents.bind(db);
          db.recordCampaignContinuationEvents = inputs => { notify(inputs); crash(); };
        }
        await svc.flushRunnerAttention('runner', () => true);
        throw new Error('crash point was not reached');
      `;
      const killed = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script],
        { encoding: "utf8" });
      assert.equal(killed.signal, "SIGKILL", killed.stderr);
      db = ControlPlaneDb.open(file);
      db.settleStartupState();
      assert.equal(db.getSession("child-0")?.pendingApproval, null, "authoritative mutation survived");
      const pending = db.campaignAttentionCheckpoint?.("runner", "campaign-0");
      const events = () => db!.raw().prepare(`SELECT kind,COUNT(*) AS n FROM orchestrator_campaign_events
        WHERE campaign_session_id='campaign-0' GROUP BY kind ORDER BY kind`).all();
      if (crashPoint === "during_publication") assert.equal(
        db.raw().prepare("SELECT COUNT(*) AS n FROM orchestrator_campaign_events").get()?.n, 32,
        "earlier event chunk committed; interrupted next chunk rolled back");
      const hub = new Hub(db);
      const logs: string[] = [];
      const svc = new SessionsService(db, hub, { info: s => logs.push(s), warn() {}, error() {} });
      svc.beginRunnerAttentionBatch("runner");
      await svc.flushRunnerAttention("runner", () => true);
      assert.deepEqual(events().map(row => [row.kind, row.n]), [
        ["child_ready", 70], ["human_blockers_cleared", 1], ["request_resolved", 69],
      ]);
      assert.ok(pending, "checkpoint survives abrupt process loss");
      assert.equal(pending.pendingRequests.human, crashPoint === "after_human_event" ? 0 : 1);
      assert.doesNotMatch(JSON.stringify(pending), /Private|ask-child|auth-human/, "checkpoint retains only hashes and counts");
      assert.equal(db.deferredCampaignAttentionIds("runner").length, 0);
      const sequence = db.raw().prepare("SELECT seq FROM sqlite_sequence WHERE name='orchestrator_campaign_events'").get()?.seq;
      svc.beginRunnerAttentionBatch("runner");
      await svc.flushRunnerAttention("runner", () => true);
      assert.equal(db.raw().prepare("SELECT seq FROM sqlite_sequence WHERE name='orchestrator_campaign_events'").get()?.seq, sequence);
      assert.match(logs.join("\n"), /campaign_attention_checkpoints_recovered/);
      assert.doesNotMatch(logs.join("\n"), /Private|ask-child|auth-human/);
    } finally { db?.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

for (const boundary of ["active", "stopped", "archived", "deleted", "reparented", "new_human_question"] as const) {
  test(`recovered attention respects ${boundary} campaign authority and continuation admission`, async () => {
    const root = mkdtempSync(join(tmpdir(), "campaign-attention-boundary-"));
    const file = join(root, "control-plane.db");
    let db: ControlPlaneDb | undefined;
    try {
      const initial = fixture(10, file);
      db = initial.db;
      db.updateSessionStatus("campaign-0", "idle", 3);
      db.setPendingApproval("child-0", question("old-human"));
      const batch = initial.svc.beginRunnerAttentionBatch("runner");
      initial.svc.applySessionRuntimeUpdate("runner", initial.snapshots[0]!, batch);
      if (boundary === "stopped") assert.ok(initial.svc.stop("campaign-0").ok);
      if (boundary === "archived") db.raw().prepare("UPDATE sessions SET archived=1 WHERE id='campaign-0'").run();
      if (boundary === "deleted") assert.ok(initial.svc.delete("campaign-0").ok);
      if (boundary === "reparented") db.raw().prepare("UPDATE sessions SET parent_session_id='campaign-1' WHERE id='campaign-0'").run();
      if (boundary === "new_human_question") db.setPendingApproval("child-0", question("new-human"));
      db.close();
      db = ControlPlaneDb.open(file);
      db.settleStartupState();
      db.registerRunner({ runnerId: "runner", hostname: "synthetic", os: "linux", version: "test",
        agents: [], workspaces: [] }, Date.now(), PROTOCOL_VERSION);
      const hub = new Hub(db);
      let sent = 0;
      hub.isRunnerOnline = () => true;
      hub.sendToRunner = () => { sent++; return true; };
      const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
      svc.beginRunnerAttentionBatch("runner");
      await svc.flushRunnerAttention("runner", () => true);
      assert.equal(db.deferredCampaignAttentionIds("runner").length, 0, "completed or stale checkpoints retire");
      // An explicit Stop stays stopped; other sessions regain the runner's idle state normally.
      if (boundary !== "stopped" && boundary !== "deleted") db.updateSessionStatus("campaign-0", "idle", Date.now());
      svc.retryDuePrompts(Date.now() + 3_000);
      if (boundary === "active") {
        assert.equal(sent, 1, "owed event resumes an exited idle parent without user prompting");
        svc.retryDuePrompts(Date.now() + 3_001);
        assert.equal(sent, 1, "existing single-flight continuation admission remains authoritative");
      } else {
        assert.equal(sent, 0, "recovery is not permission to bypass the current campaign boundary");
        if (boundary === "new_human_question") assert.equal(db.getSession("child-0")?.pendingApproval?.requestId, "new-human");
      }
    } finally { db?.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("a campaign's own runtime transition does not repeat its notification at batch flush", async () => {
  const { db, hub, snapshots } = fixture(10);
  const messages: string[] = [];
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} }, (before, after) => {
    const message = pushDecision(before, after);
    if (message?.sessionId === "campaign-0") messages.push(message.title);
  });
  try {
    db.updateSessionStatus("campaign-0", "running", 3);
    db.setPendingApproval("child-0", { requestId: "pending", kind: "question", title: "Synthetic question", options: [],
      questions: [{ id: "choice", question: "Synthetic question", header: "Choice", options: [{ label: "Yes" }] }] });
    const batch = svc.beginRunnerAttentionBatch("runner");
    svc.applySessionRuntimeUpdate("runner", snapshots[0]!, batch);
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[0]!, id: "campaign-0", status: "idle" }, batch);
    assert.equal(messages.length, 1, "the own-session idle transition notifies immediately");
    await svc.flushRunnerAttention("runner", () => true);
    assert.equal(messages.length, 1, "the deferred attention publication must not notify the same transition twice");
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM orchestrator_campaign_events WHERE campaign_session_id=? AND kind='human_blockers_cleared'")
      .get("campaign-0")?.n, 1, "consuming status notifications must preserve the cleared-request before-view");
  } finally { db.close(); }
});

test("own campaign status notifications never suppress deferred urgent child attention", async () => {
  const { db, hub, snapshots } = fixture(10);
  const messages: string[] = [];
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} }, (before, after) => {
    const message = pushDecision(before, after);
    if (message?.sessionId === "campaign-0") messages.push(`${message.urgency}:${message.title}`);
  });
  const ask = (requestId: string) => ({ requestId, kind: "question" as const, title: "Synthetic question", options: [],
    questions: [{ id: "choice", question: "Synthetic question", header: "Choice", options: [{ label: "Yes" }] }] });
  try {
    db.updateSessionStatus("campaign-0", "running", 3);
    const batch = svc.beginRunnerAttentionBatch("runner");
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[0]!, pendingApproval: ask("first") }, batch);
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[0]!, id: "campaign-0", status: "idle" }, batch);
    assert.match(messages[0]!, /^normal:.*awaiting a prompt$/, "the own frame reports only its status, not the already-present request");
    await svc.flushRunnerAttention("runner", () => true);
    assert.equal(messages.length, 2, "the unreported child request still needs a distinct urgent notification");
    assert.match(messages[1]!, /^high:.*needs your input$/);
    const next = svc.beginRunnerAttentionBatch("runner");
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[0]!, pendingApproval: ask("second") }, next);
    await svc.flushRunnerAttention("runner", () => true);
    assert.equal(messages.length, 3, "consumption ends with the batch; a later distinct request still notifies");
  } finally { db.close(); }
});

test("fresh continuation publications use durable batched commits, not one fsync per child", () => {
  const { db, svc, snapshots } = fixture(1500);
  try {
    let records = 0;
    const original = db.recordCampaignContinuationEvent.bind(db);
    db.recordCampaignContinuationEvent = (input) => {
      records++;
      assert.equal((db.raw() as ReturnType<ControlPlaneDb["raw"]> & { isTransaction: boolean }).isTransaction, true,
        "a fresh campaign's event burst must be inside a bounded transaction");
      return original(input);
    };
    svc.hydrateRunnerSessions("runner", snapshots);
    assert.equal(records, 1500);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM orchestrator_campaign_events").get()?.n, 1500);
  } finally { db.close(); }
});

test("continuation batches roll back a failed chunk and replay without duplicate writes", () => {
  const { db } = fixture(0);
  try {
    const inputs = Array.from({ length: 70 }, (_, i) => ({
      eventId: `batched-${i}`, campaignSessionId: "campaign-0", kind: "child_ready" as const, now: 3,
    }));
    const raw = db.raw();
    const originalExec = raw.exec.bind(raw);
    const transactions: string[] = [];
    raw.exec = (sql: string) => { transactions.push(sql); return originalExec(sql); };
    const record = db.recordCampaignContinuationEvent.bind(db);
    db.recordCampaignContinuationEvent = (input) => {
      if (input.eventId === "batched-34") throw new Error("Synthetic write failure");
      return record(input);
    };
    assert.throws(() => db.recordCampaignContinuationEvents(inputs), /Synthetic write failure/);
    assert.deepEqual(transactions, ["BEGIN IMMEDIATE", "COMMIT", "BEGIN IMMEDIATE", "ROLLBACK"]);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM orchestrator_campaign_events").get()?.n, 32,
      "the earlier committed chunk survives; no partial failed chunk remains");
    db.recordCampaignContinuationEvent = record;
    db.recordCampaignContinuationEvents(inputs);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM orchestrator_campaign_events").get()?.n, 70);
    assert.equal(raw.prepare("SELECT seq FROM sqlite_sequence WHERE name='orchestrator_campaign_events'").get()?.seq, 70);
    transactions.length = 0;
    db.recordCampaignContinuationEvents(inputs);
    assert.deepEqual(transactions, [], "duplicate-only replay must not begin a write transaction");
    assert.equal(raw.prepare("SELECT seq FROM sqlite_sequence WHERE name='orchestrator_campaign_events'").get()?.seq, 70);
  } finally { db.close(); }
});

test("an interleaved immediate publication never consumes an unreported deferred child question", async () => {
  const { db, hub, snapshots } = fixture(20);
  const messages: string[] = [];
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} }, (before, after) => {
    const message = pushDecision(before, after);
    if (message?.sessionId === "campaign-0") messages.push(`${message.urgency}:${message.title}`);
  });
  try {
    db.updateSessionStatus("campaign-0", "running", 3);
    const batch = svc.beginRunnerAttentionBatch("runner");
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[0]!, pendingApproval: {
      requestId: "deferred", kind: "question", title: "Synthetic question", options: [],
      questions: [{ id: "choice", question: "Synthetic question", header: "Choice", options: [{ label: "Yes" }] }],
    } }, batch);
    // A direct caller starts from a view already containing the deferred question. It must not
    // consume that question's notification merely by publishing unrelated current state.
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[10]!, preview: "Immediate" });
    assert.equal(messages.length, 0);
    await svc.flushRunnerAttention("runner", () => true);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /^high:.*needs your input$/);
    await svc.flushRunnerAttention("runner", () => true);
    assert.equal(messages.length, 1, "the reported question does not notify twice");
  } finally { db.close(); }
});

test("registration attention scans scale with campaigns, not retained children", () => {
  const { db, svc, snapshots } = fixture();
  try {
    let scans = 0;
    let checkpoints = 0;
    const retain = db.retainCampaignAttentionCheckpoint.bind(db);
    db.retainCampaignAttentionCheckpoint = (...args) => { checkpoints++; retain(...args); };
    const original = svc.descendantRequests.bind(svc);
    svc.descendantRequests = (...args) => { scans++; return original(...args); };
    svc.hydrateRunnerSessions("runner", snapshots);
    assert.equal(scans, 20, "each of ten campaigns needs one human and one orchestrator scan");
    assert.equal(checkpoints, 10, "write-ahead checkpoints scale with campaigns, never children");
    // Replays may inspect durable identities, but must not grow continuation storage.
    const before = db.raw().prepare("SELECT COUNT(*) AS n FROM orchestrator_campaign_events").get();
    svc.hydrateRunnerSessions("runner", snapshots);
    assert.deepEqual(db.raw().prepare("SELECT COUNT(*) AS n FROM orchestrator_campaign_events").get(), before);
  } finally { db.close(); }
});

test("cleared-human event and checkpoint consumption roll back together on a write failure", () => {
  const { db } = fixture(10);
  try {
    db.setPendingApproval("child-0", question("human"));
    db.retainCampaignAttentionCheckpoint("runner", db.getSession("campaign-0")!);
    db.raw().exec(`CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON orchestrator_campaign_attention_checkpoints
      BEGIN SELECT RAISE(ABORT,'Synthetic checkpoint write failure'); END`);
    const event = { eventId: "cleared-atomic", campaignSessionId: "campaign-0", kind: "human_blockers_cleared" as const, now: 3 };
    assert.throws(() => db.recordCampaignContinuationEvent(event), /checkpoint write failure/);
    assert.equal(db.hasPendingCampaignContinuationEvents("campaign-0"), false);
    assert.equal(db.campaignAttentionCheckpoint("runner", "campaign-0")?.pendingRequests.human, 1);
    db.raw().exec("DROP TRIGGER fail_checkpoint");
    assert.equal(db.recordCampaignContinuationEvent(event), true);
    assert.equal(db.campaignAttentionCheckpoint("runner", "campaign-0")?.pendingRequests.human, 0);
    assert.equal(db.recordCampaignContinuationEvent(event), false, "replaying the event is read-only");
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

for (const initiallyEmpty of [false, true]) {
test(`successive human blocker groups retain distinct wakeups inside one ${initiallyEmpty ? "initially empty" : "blocked"} runtime batch`, async () => {
  const { db, svc, snapshots } = fixture(20);
  try {
    if (!initiallyEmpty) {
      db.setPendingApproval("child-0", question("first-0"));
      db.setPendingApproval("child-10", question("first-10"));
    }
    const batch = svc.beginRunnerAttentionBatch("runner");
    if (initiallyEmpty) {
      svc.applySessionRuntimeUpdate("runner", { ...snapshots[0]!, pendingApproval: question("first") }, batch);
      svc.applySessionRuntimeUpdate("runner", snapshots[0]!);
    } else {
      svc.applySessionRuntimeUpdate("runner", snapshots[0]!, batch);
      svc.applySessionRuntimeUpdate("runner", snapshots[10]!);
    }
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[0]!, pendingApproval: question("second") });
    svc.applySessionRuntimeUpdate("runner", snapshots[0]!, batch);
    await svc.flushRunnerAttention("runner", () => true);
    const clears = db.raw().prepare("SELECT event_id FROM orchestrator_campaign_events WHERE kind='human_blockers_cleared'").all();
    assert.equal(clears.length, 2);
    assert.notEqual(clears[0]?.event_id, clears[1]?.event_id);
    await svc.flushRunnerAttention("runner", () => true);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM orchestrator_campaign_events WHERE kind='human_blockers_cleared'").get()?.n, 2);
  } finally { db.close(); }
});
}

test("rearming spent wakeups does not consume an unreported deferred question's urgent alert", async () => {
  const { db, hub, snapshots } = fixture(30);
  let urgent = 0;
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} }, (before, after) => {
    if (pushDecision(before, after)?.sessionId === "campaign-0" && pushDecision(before, after)?.urgency === "high") urgent++;
  });
  try {
    db.setPendingApproval("child-0", question("first"));
    const batch = svc.beginRunnerAttentionBatch("runner");
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[20]!, preview: "Capture" }, batch);
    svc.applySessionRuntimeUpdate("runner", snapshots[0]!);
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[10]!, pendingApproval: question("deferred") }, batch);
    svc.applySessionRuntimeUpdate("runner", { ...snapshots[20]!, pendingApproval: question("immediate") });
    assert.equal(urgent, 1);
    await svc.flushRunnerAttention("runner", () => true);
    assert.equal(urgent, 2, "wakeup rearm must not mark the deferred question as already notified");
    await svc.flushRunnerAttention("runner", () => true);
    assert.equal(urgent, 2);
  } finally { db.close(); }
});

for (const restartPoint of ["before_publication", "before_clear", "after_clear"] as const) {
  test(`successive blocker identity survives restart ${restartPoint}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "successive-attention-"));
    let db: ControlPlaneDb | undefined;
    try {
      const file = join(root, "control-plane.db");
      const initial = fixture(20, file);
      db = initial.db;
      db.setPendingApproval("child-0", question("first-0"));
      db.setPendingApproval("child-10", question("first-10"));
      const batch = initial.svc.beginRunnerAttentionBatch("runner");
      initial.svc.applySessionRuntimeUpdate("runner", initial.snapshots[0]!, batch);
      initial.svc.applySessionRuntimeUpdate("runner", initial.snapshots[10]!);
      const rearm = db.rearmCampaignHumanAttention.bind(db);
      if (restartPoint === "before_publication") {
        db.rearmCampaignHumanAttention = () => { throw new Error("publication interrupted"); };
        assert.throws(() => initial.svc.applySessionRuntimeUpdate("runner", {
          ...initial.snapshots[0]!, pendingApproval: question("fresh"),
        }), /publication interrupted/);
        db.rearmCampaignHumanAttention = rearm;
      } else initial.svc.applySessionRuntimeUpdate("runner", { ...initial.snapshots[0]!, pendingApproval: question("fresh") });
      const fresh = db.campaignAttentionCheckpoint("runner", "campaign-0");
      assert.equal(fresh?.pendingRequests.human, 0, "notification baseline remains empty");
      assert.equal(fresh?.humanWakeupBaseline?.human ?? 0, restartPoint === "before_publication" ? 0 : 1);
      assert.doesNotMatch(JSON.stringify(fresh), /Private|fresh|first-/, "only occurrence hashes are retained");
      if (restartPoint !== "before_publication") assert.match(initial.logs.join("\n"), /campaign_human_attention_rearmed/);
      assert.doesNotMatch(initial.logs.join("\n"), /Private|fresh|first-/);
      if (restartPoint === "after_clear") initial.svc.applySessionRuntimeUpdate("runner", initial.snapshots[0]!, batch);
      db.close();
      db = ControlPlaneDb.open(file);
      db.settleStartupState();
      db.registerRunner({ runnerId: "runner", hostname: "synthetic", os: "linux", version: "test",
        agents: [], workspaces: [] }, Date.now(), PROTOCOL_VERSION);
      const hub = new Hub(db);
      let sent = 0;
      hub.isRunnerOnline = () => true;
      hub.sendToRunner = () => { sent++; return true; };
      const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
      const replacement = svc.beginRunnerAttentionBatch("runner");
      if (restartPoint !== "after_clear") svc.applySessionRuntimeUpdate("runner", initial.snapshots[0]!, replacement);
      await svc.flushRunnerAttention("runner", () => false);
      assert.equal(db.deferredCampaignAttentionIds("runner").length, 1, "cancelled socket retains the fresh group");
      svc.beginRunnerAttentionBatch("runner");
      await svc.flushRunnerAttention("runner", () => true);
      const events = db.raw().prepare("SELECT event_id FROM orchestrator_campaign_events WHERE kind='human_blockers_cleared'").all();
      assert.equal(events.length, 2);
      assert.notEqual(events[0]?.event_id, events[1]?.event_id);
      const sequence = db.raw().prepare("SELECT seq FROM sqlite_sequence WHERE name='orchestrator_campaign_events'").get()?.seq;
      svc.beginRunnerAttentionBatch("runner");
      await svc.flushRunnerAttention("runner", () => true);
      assert.equal(db.raw().prepare("SELECT seq FROM sqlite_sequence WHERE name='orchestrator_campaign_events'").get()?.seq, sequence);
      db.updateSessionStatus("campaign-0", "idle", Date.now());
      svc.retryDuePrompts(Date.now() + 3_000);
      assert.equal(sent, 1, "eligible idle parent continues without another user prompt");
      svc.retryDuePrompts(Date.now() + 3_001);
      assert.equal(sent, 1, "coalesced continuation is single-flight");
    } finally { db?.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("a fresh question committed before publication still receives an urgent alert after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "successive-alert-"));
  let db: ControlPlaneDb | undefined;
  try {
    const file = join(root, "control-plane.db");
    const initial = fixture(20, file);
    db = initial.db;
    db.setPendingApproval("child-0", question("first"));
    initial.svc.applySessionRuntimeUpdate("runner", { ...initial.snapshots[10]!, preview: "Capture" },
      initial.svc.beginRunnerAttentionBatch("runner"));
    initial.svc.applySessionRuntimeUpdate("runner", initial.snapshots[0]!);
    db.rearmCampaignHumanAttention = () => { throw new Error("interrupted publication"); };
    assert.throws(() => initial.svc.applySessionRuntimeUpdate("runner", {
      ...initial.snapshots[0]!, pendingApproval: question("fresh"),
    }), /interrupted publication/);
    db.close();
    db = ControlPlaneDb.open(file);
    let urgent = 0;
    const svc = new SessionsService(db, new Hub(db), { info() {}, warn() {}, error() {} }, (before, after) => {
      if (pushDecision(before, after)?.sessionId === "campaign-0" && pushDecision(before, after)?.urgency === "high") urgent++;
    });
    svc.beginRunnerAttentionBatch("runner");
    await svc.flushRunnerAttention("runner", () => true);
    assert.equal(urgent, 1, "recovering the wakeup baseline must not consume an unanswered question's alert");
    assert.equal(db.getSession("campaign-0")?.orchestratorCampaign?.pendingRequests?.human, 1);
    await svc.flushRunnerAttention("runner", () => true);
    assert.equal(urgent, 1);
  } finally { db?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("rearming overlapping checkpoints preserves orchestrator baselines and initial notification baselines", () => {
  const { db } = fixture(10);
  try {
    db.registerRunner({ runnerId: "other", hostname: "synthetic", os: "linux", version: "test",
      agents: [], workspaces: [] }, 1, PROTOCOL_VERSION);
    const before = db.getSession("campaign-0")!;
    const pending = { human: 2, orchestrator: 1, humanRequestTokens: ["old-0", "old-1"], orchestratorRequestTokens: ["owned"] };
    for (const runnerId of ["runner", "other"]) db.retainCampaignAttentionCheckpoint(runnerId, {
      ...before, orchestratorCampaign: { ...before.orchestratorCampaign!, pendingRequests: pending },
    });
    db.recordCampaignContinuationEvent({ eventId: "first-clear", campaignSessionId: before.id, kind: "human_blockers_cleared", now: 3 });
    db.registerRunner({ runnerId: "initially-empty", hostname: "synthetic", os: "linux", version: "test",
      agents: [], workspaces: [] }, 1, PROTOCOL_VERSION);
    db.retainCampaignAttentionCheckpoint("initially-empty", before);
    const fresh = { human: 1, humanRequestTokens: ["fresh-hash"], orchestrator: 99, orchestratorRequestTokens: ["different"] };
    assert.equal(db.rearmCampaignHumanAttention(before.id, fresh), 2);
    for (const runnerId of ["runner", "other"]) {
      assert.deepEqual(db.campaignAttentionCheckpoint(runnerId, before.id)?.pendingRequests, {
        ...pending, human: 0, humanRequestTokens: [],
      });
      assert.deepEqual(db.campaignAttentionCheckpoint(runnerId, before.id)?.humanWakeupBaseline, {
        human: 1, humanRequestTokens: ["fresh-hash"],
      });
      assert.equal(db.campaignAttentionCheckpoint(runnerId, before.id)?.capturedAt, before.updatedAt);
    }
    assert.equal(db.campaignAttentionCheckpoint("initially-empty", before.id)?.pendingRequests.human, 0);
    assert.equal(db.rearmCampaignHumanAttention(before.id, fresh), 0, "repeated publication does not rearm an unconsumed baseline");
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
