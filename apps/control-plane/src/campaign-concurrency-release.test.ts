import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, SESSION_EVENT_WIRE_EPOCH_FORMAT_OFFSET,
  RUNNER_CAPABILITY_MIN_PROTOCOL, SESSION_EVENT_WIRE_PROJECTION_VARIANTS, type CampaignBudgetAuthority, type RunnerMetadata,
  type SessionEventPayload, type SessionStatus } from "@wollipog/protocol";
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

function service(db: ControlPlaneDb, protocol = PROTOCOL_VERSION) {
  db.registerRunner(metadata, 1, protocol);
  db.setUsageRateTable(new Map([["claude-opus-5-5", { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001,
    cacheReadCostPerToken: 0.000001, cacheCreationCostPerToken: 0.000001 }]])); // Fixture rates, never live pricing.
  const hub = new Hub(db); hub.isRunnerOnline = () => true; hub.sessionChangedById = () => {};
  hub.sendToRunner = () => true;
  return new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
}

function harness(path = ":memory:", authority: CampaignBudgetAuthority = concurrencyOnly(2), protocol = PROTOCOL_VERSION) {
  const db = ControlPlaneDb.open(path);
  const identity = db.localIdentityContext();
  const principal: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId };
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.behavior.completion = "stop_and_archive";
  policy.issueScope = { repository: "picoduck/wollipog", issueNumbers: [2940], revision: 1, authorizedByUserId: principal.userId, authorizedAt: 1 };
  policy.issueNumbers = [2940];
  db.registerRunner(metadata, 1, protocol);
  db.createSession({ id: "root", runnerId: "r", workspaceId: "w", agentId: "claude", title: "root", useWorktree: false,
    creationActor: "human", scope: { organizationId: principal.organizationId, owner: { kind: "user", userId: principal.userId } },
    driver: "claude-code", config: { model: "claude-opus-5-5" }, now: 2, role: "orchestrator", orchestratorPolicy: policy,
    parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } });
  db.updateSessionStatus("root", "running", 3);
  const svc = service(db, protocol);
  const enabled = svc.setCampaignControl("root", { mode: "full_control", objective: "Implement #2940", operations: ["implementation_question"],
    delegatablePolicyIds: [], budgetAuthority: authority }, 1, principal);
  assert.ok(enabled.ok, enabled.error ?? "campaign control refused");
  return { db, svc, principal };
}

type Harness = { db: ControlPlaneDb; svc: SessionsService; principal?: HumanPrincipal };

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
    // This case tests pending reservation reuse, so explicitly reserve the remainder. Default
    // workers now leave review capacity (#4545), which a replacement could legitimately use.
    const allocation = h.db.campaignBudgets.allocation(child)!;
    const remaining = h.db.campaignBudgets.view("root")!.remaining.toolCalls!;
    assert.ok(h.svc.allocateCampaignBudget("root", { sessionId: child, toolCalls: allocation.toolCalls! + remaining }).ok);
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

test("a failure reported before its provider retires keeps the slot until retirement evidence arrives (#2940)", () => {
  const h = harness(":memory:", concurrencyOnly(1));
  try {
    const child = spawned(h);
    h.svc.onSessionStatus(child, "running", undefined, undefined, "r");
    // As a history-integrity failure reports: terminal, with no stop and no final checkpoint yet.
    h.svc.onSessionStatus(child, "failed", "session history failed integrity checks", undefined, "r");
    assert.equal(h.db.getSession(child)!.status, "failed");
    assert.equal(occupied(h), 1, "a failure is not proof that its provider retired");
    assert.match(spawn(h).error ?? "", /concurrency allowance reached/u, "so no replacement runs beside it");
    runnerEnds(h, child, 0, "failed");
    assert.equal(occupied(h), 0, "the final checkpoint proves retirement");
    assert.ok(spawned(h));
  } finally { h.db.close(); }
});

test("a reconnect without a confirmed-stopped child frees its slot and keeps its reservation (#2940)", () => {
  const h = harness(":memory:", { ...concurrencyOnly(1), toolCalls: 120 });
  try {
    const child = spawned(h);
    h.svc.onSessionStatus(child, "running", undefined, undefined, "r");
    // The runner reports the stop, which confirms it, but its final checkpoint never arrives.
    h.svc.onSessionStatus(child, "stopped", undefined, undefined, "r");
    assert.equal(h.db.sessionStopProvenance(child)?.confirmation, "runner_terminal");
    assert.equal(occupied(h), 1);
    assert.match(spawn(h).error ?? "", /concurrency allowance reached/u);
    const reserved = h.db.campaignBudgets.view("root")!.outstanding.toolCalls;

    h.svc.reconcileRunnerSessions("r", ["root"]);
    assert.equal(occupied(h), 0, "the runner no longer holds the child alive");
    assert.equal(h.db.sessionStopProvenance(child)?.confirmation, "runner_terminal", "the earlier confirmation stands");
    assert.equal(h.db.campaignBudgets.active(child), true, "absence settles no usage");
    assert.equal(h.db.campaignBudgets.view("root")!.outstanding.toolCalls, reserved, "the reservation stays");
    assert.deepEqual(settlements(h, child), []);
  } finally { h.db.close(); }
});

/** The newest runner protocol that cannot prove a provider retired (#3788). */
const OLDER_RUNNER = RUNNER_CAPABILITY_MIN_PROTOCOL.campaignProviderRetirementProof - 1;
const unprovable = (h: Harness, id: string) => (h.db.raw().prepare(
  "SELECT unprovable_generation IS generation AS marked FROM campaign_budget_members WHERE session_id=?").get(id) as { marked: number }).marked === 1;

test("a runner too old to prove retirement keeps its children's slots through its checkpoint and reconnect inventory (#3788)", () => {
  const h = harness(":memory:", { ...concurrencyOnly(2), toolCalls: 120 }, OLDER_RUNNER);
  try {
    const ended = spawned(h);
    const vanished = spawned(h);
    works(h, ended, 0.5);
    h.svc.onSessionStatus(vanished, "running", undefined, undefined, "r");
    const reserved = h.db.campaignBudgets.view("root")!.outstanding.toolCalls;

    // Its terminal checkpoint, with history that covers it, is an attestation, not proof.
    runnerEnds(h, ended, 0.5, "failed");
    assert.equal(occupied(h), 2, "the attested child keeps its slot");
    assert.match(spawn(h).error ?? "", /concurrency allowance reached/u, "so no replacement runs beside it");
    // A reconnect that holds neither child: one ended, one confirmed stopped by its absence.
    h.svc.reconcileRunnerSessions("r", ["root"]);
    assert.equal(h.db.getSession(vanished)!.status, "stopped");
    assert.equal(h.db.sessionStopProvenance(vanished)?.confirmation, "runner_absent");
    assert.equal(occupied(h), 2, "an older runner's absence frees neither slot");
    assert.match(spawn(h).error ?? "", /concurrency allowance reached/u);
    assert.equal(h.db.campaignBudgets.view("root")!.occupied, 2, "repeated reads do not release them");
    assert.deepEqual(settlements(h, ended), [], "nothing settles, so nothing can be counted twice");
    assert.deepEqual(settlements(h, vanished), []);
    assert.equal(h.db.campaignBudgets.view("root")!.outstanding.toolCalls, reserved, "both reservations stay outstanding");
  } finally { h.db.close(); }
});

test("a generation a runner served while too old to prove retirement keeps its slot after that runner upgrades; a new generation proves itself (#3788)", () => {
  const h = harness(":memory:", concurrencyOnly(1));
  try {
    const child = spawned(h);
    works(h, child, 0.5);
    assert.equal(unprovable(h, child), false, "a current runner's generation needs no person");
    // The runner reconnects as an older build and sends nothing about the child, then upgrades again.
    h.db.registerRunner(metadata, 10, OLDER_RUNNER);
    assert.equal(unprovable(h, child), true, "its registration marks every live generation it owns");
    h.db.registerRunner(metadata, 11, PROTOCOL_VERSION);
    runnerEnds(h, child, 0.5);
    h.svc.reconcileRunnerSessions("r", ["root"]);
    assert.equal(occupied(h), 1, "the upgraded runner cannot vouch for what the older one served");
    assert.match(spawn(h).error ?? "", /concurrency allowance reached/u);
    assert.deepEqual(settlements(h, child), []);

    // A relaunch replaces the generation; the current runner proves its own retirement.
    h.db.campaignBudgets.replaceDispatch(child);
    assert.equal(unprovable(h, child), false);
    h.svc.onSessionStatus(child, "running", undefined, undefined, "r");
    assert.equal(occupied(h), 1);
    runnerEnds(h, child, 0.7);
    assert.equal(occupied(h), 0, "the new generation's own proof frees the slot");
    assert.equal(settlements(h, child).length, 1, "and its spend settles once");
    assert.ok(spawned(h));
  } finally { h.db.close(); }
});

test("a generation sent to a runner too old to prove retirement is marked before it leaves, even if no report ever arrives (#3788)", () => {
  const h = harness(":memory:", concurrencyOnly(1), OLDER_RUNNER);
  try {
    // The older runner is sent the worker after it registered; its connection drops before any report.
    const child = spawned(h);
    assert.equal(unprovable(h, child), true, "the launch marks the generation it sends");
    h.db.registerRunner(metadata, 10, PROTOCOL_VERSION);
    h.svc.reconcileRunnerSessions("r", ["root"]);
    runnerEnds(h, child, 0, "failed");
    assert.equal(occupied(h), 1, "the upgraded runner's absence and relay free nothing");
    assert.match(spawn(h).error ?? "", /concurrency allowance reached/u);
    assert.deepEqual(settlements(h, child), []);
  } finally { h.db.close(); }
});

test("a relaunch sent to a runner too old to prove retirement is marked, and an unsent one restores the prior mark (#3788)", () => {
  const h = harness(":memory:", concurrencyOnly(1));
  try {
    const child = spawned(h);
    works(h, child, 0.5);
    // The control plane last saw the runner at an older build, without a registration in between.
    h.db.raw().prepare("UPDATE runners SET protocol_version=? WHERE runner_id='r'").run(OLDER_RUNNER);
    const prior = h.db.campaignBudgets.dispatchState(child);
    assert.equal(prior.unprovableGeneration, null);
    const relaunch = h.db.campaignBudgets.replaceDispatch(child);
    assert.notEqual(relaunch.generation, prior.generation);
    assert.equal(unprovable(h, child), true, "the relaunched generation is marked before it is sent");
    // The send proved nothing was enqueued: the prior generation and its own (absent) mark return.
    h.db.campaignBudgets.restoreUnsentDispatch(child, prior);
    assert.equal(h.db.campaignBudgets.dispatch(child)!.generation, prior.generation);
    assert.equal(unprovable(h, child), false);
  } finally { h.db.close(); }
});

test("a control-plane upgrade marks live members last served by a runner too old to prove retirement (#3788)", () => {
  for (const protocol of [OLDER_RUNNER, PROTOCOL_VERSION]) {
    const dir = mkdtempSync(join(tmpdir(), "campaign-slot-upgrade-"));
    const path = join(dir, "cp.sqlite");
    try {
      const h = harness(path, concurrencyOnly(1));
      const child = spawned(h);
      works(h, child, 0.5);
      // As stored before this column existed, with the runner version the control plane last saw.
      h.db.raw().exec("ALTER TABLE campaign_budget_members DROP COLUMN unprovable_generation");
      h.db.raw().prepare("UPDATE runners SET protocol_version=? WHERE runner_id='r'").run(protocol);
      h.db.close();
      const db = ControlPlaneDb.open(path);
      try {
        const reopened = { db, svc: service(db) };
        assert.equal(unprovable(reopened, child), protocol === OLDER_RUNNER, `protocol ${protocol}`);
        runnerEnds(reopened, child, 0.5);
        assert.equal(occupied(reopened), protocol === OLDER_RUNNER ? 1 : 0, `protocol ${protocol}`);
      } finally { db.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

const release = (h: Harness, sessionId: string, generation: string, reason = "Rebooted the host", principal = h.principal!) =>
  h.svc.releaseCampaignSlot("root", { sessionId, generation, reason }, principal);

test("the campaign's owner releases a slot an older runner holds, recorded, and its checkpoint settles exactly once (#4331)", () => {
  const dir = mkdtempSync(join(tmpdir(), "campaign-slot-release-"));
  const path = join(dir, "cp.sqlite");
  try {
    const h = harness(path, { ...concurrencyOnly(2), toolCalls: 120 }, OLDER_RUNNER);
    const held = spawned(h);
    const running = spawned(h);
    works(h, held, 0.5);
    runnerEnds(h, held, 0.7, "failed");
    h.svc.onSessionStatus(running, "running", undefined, undefined, "r");
    const generation = h.db.campaignBudgets.dispatch(held)!.generation;
    let view = h.db.campaignBudgets.view("root")!;
    assert.deepEqual(view.heldSlots?.map((slot) => [slot.sessionId, slot.generation, slot.reason, slot.status]),
      [[held, generation, "older_runner", "failed"]], "only the ended worker is offered; a running one never is");
    assert.equal(view.occupied, 2);
    assert.match(spawn(h).error ?? "", /concurrency allowance reached/u);

    // Refusals change nothing.
    const stranger: HumanPrincipal = { ...h.principal!, userId: "usr_someone_else", actorId: "usr_someone_else" };
    assert.equal(release(h, held, generation, "Rebooted", stranger).status, 404, "only the campaign's owner may release");
    assert.equal(release(h, held, generation, "   ").status, 400, "a reason is required");
    assert.equal(release(h, held, "another-generation").status, 409, "a release names the generation it was shown");
    assert.equal(release(h, running, h.db.campaignBudgets.dispatch(running)!.generation).status, 409, "a running worker is refused");
    assert.equal(occupied(h), 2);
    assert.deepEqual(settlements(h, held), []);

    const released = release(h, held, generation, "  Checked the host: no provider process remains  ");
    assert.ok(released.ok && released.data, String(released.error));
    assert.deepEqual({ ...released.data, releasedAt: 0 }, { sessionId: held, title: released.data.title, generation,
      releasedByUserId: h.principal!.userId, releasedByName: released.data.releasedByName, releasedAt: 0,
      reason: "Checked the host: no provider process remains", heldReason: "older_runner",
      settlement: { costUsd: 0.7, toolCalls: 1, source: "checkpoint" } }, "it records who, why, and settles from the runner's final usage");
    view = h.db.campaignBudgets.view("root")!;
    assert.equal(view.occupied, 1, "the slot is free");
    assert.equal(view.heldSlots, undefined);
    assert.deepEqual(view.slotReleases?.map((r) => r.sessionId), [held]);
    assert.deepEqual(settlements(h, held), [{ cost: 0.7, tools: 1 }]);
    assert.ok(spawned(h), "a replacement is admitted");

    // A repeated release, and a proof arriving later, change nothing further.
    const again = release(h, held, generation, "Second click");
    assert.ok(again.ok);
    assert.equal(again.data!.reason, "Checked the host: no provider process remains");
    runnerEnds(h, held, 0.9, "failed");
    assert.deepEqual(settlements(h, held), [{ cost: 0.7, tools: 1 }], "the reservation settled exactly once");
    const actual = h.db.campaignBudgets.view("root")!.actual.costUsd;
    h.db.close();

    // A control-plane restart keeps the record and settles nothing again.
    const db = ControlPlaneDb.open(path);
    try {
      const reopened = { db, svc: service(db, OLDER_RUNNER), principal: h.principal };
      assert.deepEqual(db.campaignBudgets.view("root")!.slotReleases?.map((r) => [r.sessionId, r.reason]),
        [[held, "Checked the host: no provider process remains"]]);
      assert.equal(release(reopened, held, generation).data?.settlement.costUsd, 0.7);
      assert.deepEqual(settlements(reopened, held), [{ cost: 0.7, tools: 1 }]);
      assert.equal(db.campaignBudgets.view("root")!.actual.costUsd, actual);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a person can't release a slot that is still stopping, already free, or awaiting a current runner's proof (#4331)", () => {
  const h = harness(":memory:", concurrencyOnly(3));
  try {
    // Ended on a current runner without its proof yet: the runner may still send it.
    const pending = spawned(h);
    h.svc.onSessionStatus(pending, "running", undefined, undefined, "r");
    h.svc.onSessionStatus(pending, "failed", "agent exited 3", undefined, "r");
    assert.equal(h.db.campaignBudgets.view("root")!.heldSlots, undefined);
    assert.equal(release(h, pending, h.db.campaignBudgets.dispatch(pending)!.generation).status, 409);
    // Proven and freed.
    const free = spawned(h);
    works(h, free, 0.2);
    runnerEnds(h, free, 0.2);
    assert.equal(release(h, free, h.db.campaignBudgets.dispatch(free)!.generation).status, 409);
    // Its runner reports a fence no process can lift, but a stop is still pending.
    const stopping = spawned(h);
    h.svc.onSessionStatus(stopping, "running", undefined, undefined, "r");
    const generation = h.db.campaignBudgets.dispatch(stopping)!.generation;
    assert.ok(h.svc.stop(stopping).ok);
    h.db.campaignBudgets.noteRetirementHold(stopping, "r", { generation, reason: "unsupported_location" });
    assert.equal(release(h, stopping, generation).status, 409, "a pending stop keeps it out");
    // Once the stop is confirmed, the reported fence makes it the person's to release.
    h.svc.onSessionStatus(stopping, "stopped", undefined, undefined, "r");
    assert.deepEqual(h.db.campaignBudgets.view("root")!.heldSlots?.map((slot) => [slot.sessionId, slot.reason]),
      [[stopping, "unsupported_location"]]);
    const released = release(h, stopping, generation);
    assert.ok(released.ok, String(released.error));
    assert.equal(released.data!.settlement.source, "recorded_usage");
    // A report from a runner that doesn't own the session is ignored.
    h.db.campaignBudgets.noteRetirementHold(pending, "another-runner", { generation: h.db.campaignBudgets.dispatch(pending)!.generation,
      reason: "fence_without_evidence" });
    assert.equal(h.db.campaignBudgets.view("root")!.heldSlots, undefined);
  } finally { h.db.close(); }
});
