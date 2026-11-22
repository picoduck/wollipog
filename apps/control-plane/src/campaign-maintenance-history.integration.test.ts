import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION,
  type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { fakeScreenRuntime } from "./credential-screen-test-fixture.js";

/** The retained shape from #4851: 38 dependent work items, 36 descendants of which 18 failed and
 * were superseded by verified successors, and thousands of recorded attempt status transitions. */
const ITEMS = 38;
const SUPERSEDED = 18;
const STATUS_TRANSITIONS = 3_800;

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
  return { db, svc, failed, items };
}

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
  try {
    const { port } = server.address() as AddressInfo;
    let sweeping = true;
    // The control plane's 5-second maintenance timers, back to back: each sweep yields only between runs.
    const sweeps = (async () => {
      let runs = 0;
      const started = Date.now();
      while (runs < 5 || Date.now() - started < 1_000) {
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
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 200);
      await response.text();
      latencies.push(performance.now() - sent);
    }
    assert.ok(await sweeps >= 5);
    assert.ok(latencies.length > 0, "a health request was served during the sweeps");
    // Before #4851 one sweep of this history held the event loop for seconds. Generous enough for a slow
    // CI machine, far below the 5-second health timeout that failed in the field.
    const worst = Math.max(...latencies);
    assert.ok(worst < 1_500, `slowest health response during maintenance took ${Math.round(worst)} ms`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    h.db.close();
  }
});
