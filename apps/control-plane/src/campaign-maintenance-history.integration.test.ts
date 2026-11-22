import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION,
  type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb, RUNNER_REPORTED_STOP } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { fakeScreenRuntime } from "./credential-screen-test-fixture.js";

/** The retained shape from #4851: 38 dependent work items, 36 descendants of which 18 failed and
 * were superseded by verified successors, and a long recorded attempt status history. The field's
 * largest campaign had 3,781 transitions; this fixture records more so that rebuilding timelines
 * exceeds the 5-second health timeout even on a fast machine, while the fixed check never reads them. */
const ITEMS = 38;
const SUPERSEDED = 18;
const STATUS_TRANSITIONS = 20_000;

function retainedCampaign() {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/test" }], agents: [{ id: "agent", name: "Agent",
      command: "codex", args: [], env: {}, driver: "codex-app-server", available: true }] };
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.behavior.completion = "retain";
  policy.issueScope = { repository: "picoduck/wollipog", issueNumbers: [4851], revision: 1,
    authorizedByUserId: identity.userId, authorizedAt: 1 };
  policy.issueNumbers = [4851];
  const failed = Array.from({ length: SUPERSEDED }, (_, i) => `failed-${i}`);
  const successors = Array.from({ length: SUPERSEDED }, (_, i) => `successor-${i}`);
  for (const id of ["root", ...failed, ...successors]) {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "agent", title: id,
      useWorktree: false, driver: "codex-app-server", config: { model: "gpt-6.1-sol" }, now: 1,
      scope: { organizationId: identity.organizationId, owner: { kind: "user", userId: identity.userId } },
      ...(id !== "root" ? { parentSessionId: "root" } : { role: "orchestrator", orchestratorPolicy: policy,
        parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } }) });
    db.updateSessionStatus(id, "running", 2);
  }
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  hub.sessionChangedById = () => {};
  hub.sendToRunner = () => true;
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  svc.setDecisionRuntime(fakeScreenRuntime(db, () => ({ verdict: "discusses" })).runtime);
  const enabled = svc.setCampaignControl("root", { mode: "full_control", objective: "Implement #4851",
    operations: ["implementation_question", "question", "tool_approval"], delegatablePolicyIds: [] }, 1,
  { ...identity, kind: "human", actorId: identity.userId });
  assert.ok(enabled.ok, enabled.error ?? "admission failed");
  svc.hydrateHistory = async () => {};
  const plan = svc.recordCampaignPlan("root", { planComplete: true, items: Array.from({ length: ITEMS }, (_, i) => ({
    key: `original:4851:slice-${i}`, title: `Slice ${i}`, issue: { repository: "picoduck/wollipog", number: 4851 },
    ...(i > 0 ? { dependsOnKeys: [`original:4851:slice-${i - 1}`] } : {}),
  })) });
  assert.ok(plan.ok, plan.error ?? "plan refused");
  const items = plan.data!.items.map((item) => item.workItemId);
  for (let i = 0; i < SUPERSEDED; i += 1) {
    const item = items[i]!;
    assert.ok(svc.assignCampaignWorkItem("root", { workItemId: item, childSessionId: failed[i]! }).ok);
    db.updateSessionStatus(failed[i]!, "failed", Date.now());
    assert.ok(svc.updateCampaignWorkItem("root", { workItemId: item, endAttempt: { reason: "failed" } }).ok);
    assert.ok(svc.assignCampaignWorkItem("root", { workItemId: item, childSessionId: successors[i]! }).ok);
    db.updateSessionStatus(successors[i]!, "completed", Date.now());
    const seq = db.appendEvent(successors[i]!, { kind: "agent_message", text: "Done.", final: true }, Date.now()).seq;
    const verified = svc.verifyCampaignChild("root", { childSessionId: successors[i]!, reportEventSeq: seq,
      followUpsAccounted: true, workItem: { id: item, outcome: "delivered" } });
    assert.ok(verified.ok, verified.error ?? "verification refused");
  }
  // Retained status history, spread over every recorded attempt as a long-lived campaign accrues it.
  const attempts = (db.raw().prepare("SELECT id FROM campaign_work_attempts WHERE campaign_session_id='root'")
    .all() as Array<{ id: string }>).map((row) => row.id);
  const insert = db.raw().prepare(
    "INSERT INTO campaign_attempt_status_transitions (attempt_id, at, status, archived) VALUES (?, ?, ?, 0)");
  db.raw().exec("BEGIN");
  for (let i = 0; i < STATUS_TRANSITIONS; i += 1) {
    insert.run(attempts[i % attempts.length]!, 10_000 + i, i % 2 ? "idle" : "running");
  }
  db.raw().exec("COMMIT");
  db.updateSessionStatus("root", "idle", Date.now());
  return { db, svc, hub, failed, items };
}

test("prompt retry maintenance avoids full session reads across retained campaigns (#4857)", async (t) => {
  const { db, svc, hub } = retainedCampaign();
  try {
    const identity = db.localIdentityContext();
    const scope = { organizationId: identity.organizationId, owner: { kind: "user" as const, userId: identity.userId } };
    const now = Date.now();
    const refused: string[] = [];
    for (let campaign = 0; campaign < 7; campaign++) {
      const root = `campaign-${campaign}`;
      const policy = db.sessionOrchestratorPolicy("root")!;
      policy.control = undefined; // Enable a fresh boundary for this campaign through the service.
      policy.behavior.completion = "stop_and_archive";
      const session = { runnerId: "r", workspaceId: "w", agentId: "agent", useWorktree: false,
        driver: "codex-app-server" as const, config: { model: "gpt-6.1-sol" }, now, scope };
      db.createSession({ ...session, id: root, title: root, role: "orchestrator", orchestratorPolicy: policy,
        parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } });
      db.updateSessionStatus(root, "running", now);
      const enabled = svc.setCampaignControl(root, { mode: "full_control", objective: "Implement #4851",
        operations: ["implementation_question", "question", "tool_approval"], delegatablePolicyIds: [] }, 1,
      { ...identity, kind: "human", actorId: identity.userId });
      assert.ok(enabled.ok, enabled.error ?? "admission failed");
      for (let index = 0; index < 14; index++) {
        const id = `${root}-child-${index}`;
        db.createSession({ ...session, id, title: id, parentSessionId: root });
        if (index >= (campaign < 5 ? 4 : 3)) {
          db.updateSessionStatus(id, "idle", now);
          if (index % 2) db.setSessionArchived(id, true, now);
          continue;
        }
        const path = `/worktrees/${id}`;
        db.setWorktreePath(id, path);
        db.raw().prepare("UPDATE sessions SET worktrees=? WHERE id=?")
          .run(JSON.stringify([{ id, path, branch: "fix/fixture", source: "created" }]), id);
        db.updateSessionStatus(id, "stopped", now, RUNNER_REPORTED_STOP);
        const seq = db.appendEvent(id, { kind: "agent_message", text: "Done.", final: true }, now).seq;
        db.verifyCampaignChildReport(root, id, seq, now);
        db.setSessionArchived(id, true, now);
        db.recordCampaignWorktreeCleanup(id, path, id, "refused", "the worktree has uncommitted changes", now);
        refused.push(id);
      }
      db.updateSessionStatus(root, "idle", now);
    }
    assert.equal(refused.length, 26);
    assert.deepEqual(db.archivedChildrenWithRefusedWorktrees(""), refused);
    const reconciled: string[] = [];
    hub.requestFromRunner = async (_runner, requestId, message) => {
      assert.equal(message.type, "session_worktree");
      assert.equal(message.operation, "reconcile_removal");
      reconciled.push(message.sessionId);
      return { type: "session_worktree_result", requestId, sessionId: message.sessionId,
        operation: "reconcile_removal", ok: false, error: "The worktree is still present." };
    };
    const childIds = new Set(db.listOrchestratorCampaignSessionIds().flatMap(id => db.campaignDescendantIds(id)));
    let calls: Array<{ id: string; full: boolean }> = [];
    const getSession = db.getSession.bind(db);
    db.getSession = (id, options) => {
      calls.push({ id, full: options?.includeCampaignProjection !== false });
      return getSession(id, options);
    };
    const samples = [];
    for (const elapsed of [0, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000]) {
      calls = [];
      const started = performance.now();
      svc.retryDuePrompts(now + elapsed);
      samples.push({ elapsed, ms: Math.round((performance.now() - started) * 10) / 10, calls: calls.length,
        full: calls.filter(call => call.full).length, children: calls.filter(call => childIds.has(call.id)).length });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    t.diagnostic(JSON.stringify(samples));
    assert.deepEqual(reconciled, [...refused, ...refused], "both worktree sweeps reconcile the same refused generations");
    for (const id of refused) assert.equal(db.campaignWorktreeCleanup(id)[0]?.status, "refused");
    assert.ok(samples.every(sample => sample.full === 0 && sample.children === 0), JSON.stringify(samples));
  } finally { db.close(); }
});

test("supersession checks read no timing history and keep their verdicts (#4851)", () => {
  const h = retainedCampaign();
  try {
    const accounting = h.db.campaignWorkLedger.accounting;
    const ledger = h.db.campaignWorkLedger;
    const calls = { transitions: 0, statuses: 0, detail: 0 };
    const transitions = accounting.itemTransitions.bind(accounting);
    const statuses = accounting.attemptStatuses.bind(accounting);
    const detail = ledger.detail.bind(ledger);
    accounting.itemTransitions = (id) => { calls.transitions += 1; return transitions(id); };
    accounting.attemptStatuses = (id) => { calls.statuses += 1; return statuses(id); };
    ledger.detail = (...args) => { calls.detail += 1; return detail(...args); };
    for (const child of h.failed) assert.equal(h.db.campaignChildFailureSuperseded("root", child), true, child);
    // A failed child is superseded only by a verified successor's delivery; the successors themselves
    // never failed, so they are not.
    assert.equal(h.db.campaignChildFailureSuperseded("root", "successor-0"), false);
    assert.deepEqual(calls, { transitions: 0, statuses: 0, detail: 0 });
  } finally { h.db.close(); }
});

test("work-item detail still reports its timing metrics (#4851)", () => {
  const h = retainedCampaign();
  try {
    const detail = h.db.campaignWorkLedger.detail("root", h.items[0]!, Date.now())!;
    assert.equal(detail.primaryState, "delivered");
    assert.ok(detail.times, "detail keeps its timing metrics");
    const facts = h.db.campaignWorkLedger.deliveryFacts("root", [h.items[0]!, "missing"]);
    assert.deepEqual([...facts.keys()], [h.items[0]!]);
    assert.deepEqual(facts.get(h.items[0]!), {
      primaryState: detail.primaryState,
      attempts: detail.attempts.map((attempt) => ({ id: attempt.id, ordinal: attempt.ordinal, sessionId: attempt.sessionId })),
      verifications: detail.verifications.map((verification) => ({ attemptId: verification.attemptId, outcome: verification.outcome })),
    });
  } finally { h.db.close(); }
});

test("local health requests stay responsive while periodic maintenance sweeps retained history (#4851)", async () => {
  const h = retainedCampaign();
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/healthz" ? 200 : 404, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let sweeping = true;
  let sweeps: Promise<number> = Promise.resolve(0);
  try {
    const { port } = server.address() as AddressInfo;
    // The control plane's 5-second maintenance timers, back to back: each sweep yields only between runs.
    sweeps = (async () => {
      // Yield first, so the first health request is already timed when the first sweep starts.
      await new Promise((resolve) => setImmediate(resolve));
      let runs = 0;
      const started = Date.now();
      while (sweeping && (runs < 5 || Date.now() - started < 1_000)) {
        h.svc.retryDuePrompts(Date.now());
        h.db.campaignProjection("root");
        runs += 1;
        await new Promise((resolve) => setImmediate(resolve));
      }
      sweeping = false;
      return runs;
    })();
    const latencies: number[] = [];
    while (sweeping) {
      const sent = performance.now();
      // The field's local health check gave up after 5 seconds.
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 200);
      await response.text();
      latencies.push(performance.now() - sent);
    }
    assert.ok(await sweeps >= 5);
    assert.ok(latencies.length > 0, "a health request was served during the sweeps");
    // Before #4851 a sweep of this history held the event loop past the 5-second health timeout; after it
    // the slowest response took about 0.6 s locally and about three times that on a loaded CI runner.
    const worst = Math.max(...latencies);
    assert.ok(worst < 4_000, `slowest health response during maintenance took ${Math.round(worst)} ms`);
  } finally {
    // A failed probe must not leave a sweep running against the closed database.
    sweeping = false;
    await sweeps.catch(() => 0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    h.db.close();
  }
});
