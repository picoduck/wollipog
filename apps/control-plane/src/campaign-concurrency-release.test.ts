import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, SESSION_EVENT_WIRE_EPOCH_FORMAT_OFFSET,
  SESSION_EVENT_WIRE_PROJECTION_VARIANTS, type CampaignBudgetAuthority, type RunnerMetadata, type SessionEventPayload,
  type SessionStatus } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import type { HumanPrincipal } from "./identity.js";

// A campaign's concurrency slot ends with its child's stop; its spend settles separately and once
// (#2940). Children launch, run, stop and archive through the real service routes. The runner is
// simulated by its authenticated status messages, and its history fetches are never answered,
// as an archived child's never are.

/** Concurrency alone, as the Full Control campaigns that leaked every slot were authorized. */
const concurrencyOnly = (concurrency: number): CampaignBudgetAuthority =>
  ({ version: 1, accounting: "managed_workers_only", unpriced: "stop", concurrency });

/** The wire epoch a current runner projects for its local log epoch, which the control plane stores. */
const wireEpoch = (localEpoch: number) => SESSION_EVENT_WIRE_EPOCH_FORMAT_OFFSET + localEpoch * SESSION_EVENT_WIRE_PROJECTION_VARIANTS;

const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
  workspaces: [{ id: "w", name: "Repo", path: "/repo" }],
  agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", available: true }] };

function service(db: ControlPlaneDb) {
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  db.setUsageRateTable(new Map([["claude-opus-5-5", { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001,
    cacheReadCostPerToken: 0.000001, cacheCreationCostPerToken: 0.000001 }]])); // Fixture rates, never live pricing.
  const hub = new Hub(db); hub.isRunnerOnline = () => true; hub.sessionChangedById = () => {};
  hub.sendToRunner = () => true;
  return new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
}

function harness(path = ":memory:", authority: CampaignBudgetAuthority = concurrencyOnly(2)) {
  const db = ControlPlaneDb.open(path);
  const identity = db.localIdentityContext();
  const principal: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId };
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.behavior.completion = "stop_and_archive";
  policy.issueScope = { repository: "picoduck/wollipog", issueNumbers: [2940], revision: 1, authorizedByUserId: principal.userId, authorizedAt: 1 };
  policy.issueNumbers = [2940];
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  db.createSession({ id: "root", runnerId: "r", workspaceId: "w", agentId: "claude", title: "root", useWorktree: false,
    creationActor: "human", scope: { organizationId: principal.organizationId, owner: { kind: "user", userId: principal.userId } },
    driver: "claude-code", config: { model: "claude-opus-5-5" }, now: 2, role: "orchestrator", orchestratorPolicy: policy,
    parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } });
  db.updateSessionStatus("root", "running", 3);
  const svc = service(db);
  const enabled = svc.setCampaignControl("root", { mode: "full_control", objective: "Implement #2940", operations: ["implementation_question"],
    delegatablePolicyIds: [], budgetAuthority: authority }, 1, principal);
  assert.ok(enabled.ok, enabled.error ?? "campaign control refused");
  return { db, svc };
}

type Harness = { db: ControlPlaneDb; svc: SessionsService };

function spawn(h: Harness) {
  return h.svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "claude", config: { model: "claude-opus-5-5" },
    prompt: "Implement authorized #2940" }, undefined, undefined, false, false, false, { parentSessionId: "root" });
}

function spawned(h: Harness): string {
  const result = spawn(h);
  assert.ok(result.ok && result.data, result.error ?? "child admission refused");
  return result.data.id;
}

const usage = (costUsd: number): SessionEventPayload => ({ kind: "token_usage", model: "claude-opus-5-5", inputTokens: 1, costUsd });

/** The child's runner reports one turn with priced usage and a tool call, and its final report. */
function works(h: Harness, id: string, costUsd: number): number {
  h.svc.onSessionStatus(id, "running", undefined, undefined, "r");
  h.db.appendEvent(id, usage(costUsd), 5, { accrueUsage: true });
  h.db.appendEvent(id, { kind: "tool_call", toolCallId: `${id}-read`, title: "Read", status: "completed" }, 5);
  const report = h.db.appendEvent(id, { kind: "agent_message", final: true, text: "Implemented; no follow-ups." }, 6);
  h.svc.onSessionStatus(id, "idle", undefined, undefined, "r");
  return report.seq;
}

/** The runner's terminal report. Its final checkpoint is in the runner's local coordinates (log
 * epoch 0); the control plane holds the history in the wire coordinates it was sent, and has
 * hydrated it through the checkpoint unless `hydrated` is false. */
function runnerEnds(h: Harness, id: string, costUsd: number, status: SessionStatus = "stopped", hydrated = true) {
  const throughSeq = 7;
  h.db.reconcileRunnerHistory(id, wireEpoch(0), throughSeq);
  if (hydrated) h.db.setHydratedSeq(id, throughSeq);
  h.svc.onSessionStatus(id, status, undefined, undefined, "r", undefined, undefined,
    { generation: h.db.campaignBudgets.dispatch(id)!.generation, historyEpoch: 0, throughSeq, costUsd });
}

const settlements = (h: Harness, id: string) => h.db.raw().prepare("SELECT cost, tools FROM campaign_budget_settlements WHERE session_id=?")
  .all(id).map((row) => ({ ...row }));

const occupied = (h: Harness) => h.db.campaignBudgets.view("root")!.occupied;

test("verified, stopped, archived and exited children free their campaign slots, and their spend settles exactly once (#2940)", () => {
  const h = harness();
  try {
    let spent = 0;
    const ended: Array<{ id: string; cost: number }> = [];
    const ends: Array<(id: string, cost: number) => void> = [
      // stop_and_archive verification, as a Full Control Orchestrator verifies each child.
      (id, cost) => {
        const reportEventSeq = works(h, id, cost);
        assert.ok(h.svc.verifyCampaignChild("root", { childSessionId: id, reportEventSeq, followUpsAccounted: true }).ok);
        assert.equal(h.db.getSession(id)!.archived, false, "archival waits for the runner's stop");
        runnerEnds(h, id, cost);
        assert.equal(h.db.getSession(id)!.archived, true);
      },
      // A manual Stop.
      (id, cost) => { works(h, id, cost); assert.ok(h.svc.stop(id).ok); runnerEnds(h, id, cost); },
      // A manual Archive of an idle child, which stops it first.
      (id, cost) => { works(h, id, cost); assert.ok(h.svc.setArchived(id, true).ok); runnerEnds(h, id, cost); },
      // The provider exits by itself.
      (id, cost) => { works(h, id, cost); runnerEnds(h, id, cost, "completed"); },
      (id, cost) => { works(h, id, cost); runnerEnds(h, id, cost, "failed"); },
    ];
    for (const [round, end] of ends.entries()) {
      const ids = [spawned(h), spawned(h)];
      const full = spawn(h);
      assert.equal(full.ok, false, `round ${round}: a full campaign refuses a third child`);
      assert.match(full.error ?? "", /concurrency allowance reached/u);
      for (const [index, id] of ids.entries()) {
        const cost = 0.25 * (index + 1);
        end(id, cost);
        spent += cost;
        ended.push({ id, cost });
        assert.equal(occupied(h), 1 - index, `round ${round}: the ended child's slot is free`);
      }
      assert.equal(h.db.campaignProjection("root")!.budget!.occupied, 0, "get_campaign reports the free slots");
    }
    const view = h.db.campaignBudgets.view("root")!;
    assert.deepEqual(view.authority, concurrencyOnly(2), "no allowance change was needed");
    assert.equal(view.actual.costUsd, spent, "every child's priced usage counts once");
    assert.equal(view.actual.toolCalls, ended.length);
    for (const { id, cost } of ended) {
      assert.deepEqual(settlements(h, id), [{ cost, tools: 1 }], `${id} settles its final usage once`);
      assert.equal(h.db.campaignBudgets.active(id), false);
    }
    // Ten verified children later, the campaign still admits its next two.
    spawned(h); spawned(h);
  } finally { h.db.close(); }
});

test("a stop during a running turn holds the slot until the runner confirms it, then frees it while spend is still pending (#2940)", () => {
  const h = harness(":memory:", { ...concurrencyOnly(1), toolCalls: 120 });
  try {
    const child = spawned(h);
    h.svc.onSessionStatus(child, "running", undefined, undefined, "r");
    h.db.appendEvent(child, { kind: "tool_call", toolCallId: "read", title: "Read", status: "completed" }, 5);
    // The turn's open live estimate, which settlement replaces rather than adds to (#3196).
    h.svc.onSessionEvent(child, { kind: "token_usage", model: "claude-opus-5-5", inputTokens: 100_000, outputTokens: 0,
      pricingContext: { requestInputTokens: 100_000 }, liveUsage: "provisional" });
    const reserved = h.db.campaignBudgets.view("root")!.outstanding.toolCalls;
    assert.ok(h.svc.stop(child).ok);
    assert.equal(occupied(h), 1, "a provisional stop may still have a running provider");
    assert.match(spawn(h).error ?? "", /concurrency allowance reached/u);

    // The runner confirms before the control plane has the turn's last events.
    runnerEnds(h, child, 0.05, "stopped", false);
    assert.equal(occupied(h), 0, "the confirmed stop frees the slot without a history reload");
    assert.equal(h.db.campaignBudgets.active(child), true, "the unsettled spend stays reserved");
    assert.equal(h.db.campaignBudgets.view("root")!.outstanding.toolCalls, reserved, "and its reservation is conservative");
    assert.match(spawn(h).error ?? "", /unreserved campaign allowance/u, "a reservation still pending cannot be spent twice");
    assert.deepEqual(settlements(h, child), []);

    // The settled turn and the rest of its history arrive; the next read settles it.
    h.svc.onSessionEvent(child, { kind: "token_usage", model: "claude-opus-5-5", inputTokens: 100_000, outputTokens: 0,
      costUsd: 0.05, liveUsage: "settled" });
    h.db.setHydratedSeq(child, 7);
    const next = spawned(h);
    assert.ok(next);
    assert.deepEqual(settlements(h, child), [{ cost: 0.05, tools: 1 }]);
    const view = h.db.campaignBudgets.view("root")!;
    assert.deepEqual(view.actual, { costUsd: 0.05, toolCalls: 1 }, "the provider total replaces the estimate, once");
    assert.equal(occupied(h), 1, "only the new child holds a slot");
  } finally { h.db.close(); }
});

test("a control-plane restart in the middle of a stop keeps the slot until the runner confirms it, then settles once (#2940)", () => {
  const dir = mkdtempSync(join(tmpdir(), "campaign-slot-restart-"));
  const path = join(dir, "cp.sqlite");
  try {
    const h = harness(path, concurrencyOnly(1));
    const child = spawned(h);
    const reportEventSeq = works(h, child, 0.5);
    assert.ok(h.svc.verifyCampaignChild("root", { childSessionId: child, reportEventSeq, followUpsAccounted: true }).ok);
    h.db.close();

    const db = ControlPlaneDb.open(path);
    try {
      db.settleStartupState();
      // The runner reconnects with its Orchestrator still live; startup settlement stopped it provisionally.
      db.updateSessionStatus("root", "running", 8);
      const restarted = { db, svc: service(db) };
      assert.equal(occupied(restarted), 1, "an unconfirmed stop still holds its slot after the restart");
      assert.match(spawn(restarted).error ?? "", /concurrency allowance reached/u);
      runnerEnds(restarted, child, 0.5);
      assert.equal(db.getSession(child)!.archived, true, "the interrupted stop_and_archive completes");
      assert.equal(occupied(restarted), 0);
      assert.ok(spawned(restarted));
      assert.deepEqual(settlements(restarted, child), [{ cost: 0.5, tools: 1 }]);
      assert.equal(db.campaignBudgets.view("root")!.actual.costUsd, 0.5);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a campaign whose ended children leaked their slots and reservations repairs on its next read (#2940)", () => {
  const dir = mkdtempSync(join(tmpdir(), "campaign-slot-repair-"));
  const path = join(dir, "cp.sqlite");
  try {
    const h = harness(path, { ...concurrencyOnly(2), toolCalls: 120 });
    const children = [spawned(h), spawned(h)];
    for (const [index, child] of children.entries()) {
      const reportEventSeq = works(h, child, index + 1);
      assert.ok(h.svc.verifyCampaignChild("root", { childSessionId: child, reportEventSeq, followUpsAccounted: true }).ok);
      runnerEnds(h, child, index + 1);
    }
    // The state the earlier ledger left every verified child in: archived and confirmed stopped,
    // its final checkpoint recorded but never settled, so it still counted as running.
    h.db.raw().exec(`INSERT INTO campaign_budget_checkpoints SELECT session_id, checkpoint FROM campaign_budget_settlements;
      DELETE FROM campaign_budget_settlements; UPDATE campaign_budget_members SET active=1 WHERE session_id<>'root'`);
    h.db.close();

    const db = ControlPlaneDb.open(path);
    try {
      db.settleStartupState();
      db.updateSessionStatus("root", "running", 8);
      const repaired = { db, svc: service(db) };
      const projection = db.campaignProjection("root")!;
      assert.equal(projection.budget!.occupied, 0, "the leaked slots are free");
      for (const [index, child] of children.entries()) {
        assert.equal(db.getSession(child)!.archived, true);
        assert.deepEqual(settlements(repaired, child), [{ cost: index + 1, tools: 1 }], "the leaked spend settles from its checkpoint, once");
      }
      const view = db.campaignBudgets.view("root")!;
      assert.deepEqual(view.actual, { costUsd: 3, toolCalls: 2 });
      assert.equal(db.campaignBudgets.view("root")!.actual.costUsd, 3, "repeated reads settle nothing again");
      assert.deepEqual(view.authority, { ...concurrencyOnly(2), toolCalls: 120 }, "repair needs no allowance change");
      spawned(repaired); spawned(repaired);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
