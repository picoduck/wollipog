import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION,
  validCampaignBudgetAuthority, type CampaignBudgetAuthority, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import type { HumanPrincipal } from "./identity.js";

const allowance = (extra: Partial<CampaignBudgetAuthority> = {}): CampaignBudgetAuthority => ({ version: 1,
  accounting: "managed_workers_only", unpriced: "stop", toolCalls: 120, concurrency: 2, ...extra });

function harness(path = ":memory:", protocol = PROTOCOL_VERSION) {
  const db = ControlPlaneDb.open(path);
  const identity = db.localIdentityContext();
  const principal: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repo" }],
    agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", available: true }] };
  db.registerRunner(metadata, 1, protocol);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: "picoduck/wollipog", issueNumbers: [2936], revision: 1, authorizedByUserId: principal.userId, authorizedAt: 1 };
  policy.issueNumbers = [2936];
  const make = (id: string, parentSessionId?: string, config: { costBudgetUsd?: number; maxToolCalls?: number } = {}) => {
    db.createSession({ id, parentSessionId, runnerId: "r", workspaceId: "w", agentId: "claude", title: id, useWorktree: false,
      creationActor: parentSessionId ? "agent" : "human",
      driver: "claude-code", config, now: 2,
      ...(!parentSessionId ? { role: "orchestrator", orchestratorPolicy: policy,
        parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } } : {}) });
    db.updateSessionStatus(id, "running", 3);
  };
  make("root");
  const hub = new Hub(db); hub.isRunnerOnline = () => true; hub.sessionChangedById = () => {};
  const sent: unknown[] = [], logs: string[] = [];
  hub.sendToRunner = (_, message) => { sent.push(message); return true; };
  const svc = new SessionsService(db, hub, { info: (s) => logs.push(String(s)), warn() {}, error() {} });
  const enable = (budgetAuthority = allowance(), expectedRevision = 1) => svc.setCampaignControl("root", {
    mode: "full_control", objective: "Implement #2936", operations: ["implementation_question"], delegatablePolicyIds: [], budgetAuthority }, expectedRevision, principal);
  const tool = (id: string, toolCallId: string) => db.appendEvent(id, { kind: "tool_call", toolCallId, title: "Read", status: "completed" }, 5);
  const usage = (id: string, costUsd: number) => db.appendEvent(id, { kind: "token_usage", inputTokens: 1, costUsd }, 5, { accrueUsage: true });
  return { db, hub, svc, make, tool, usage, enable, principal, sent, logs };
}

test("service launches use the exact reservation and agent reallocations preserve tighter limits", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ toolCalls: 120, costUsd: 120 })).ok);
    const result = h.svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "claude", prompt: "Implement authorized #2936" },
      undefined, undefined, false, false, false, { parentSessionId: "root" });
    assert.ok(result.ok, result.error ?? "launch admission failed");
    const id = result.data!.id;
    const allocation = h.db.campaignBudgets.allocation(id)!;
    const start = [...h.sent].reverse().find((item) => (item as { type?: string }).type === "start_session") as { spec: { config: { costBudgetUsd?: number; maxToolCalls?: number } } };
    assert.equal(start.spec.config.costBudgetUsd, allocation.costUsd);
    assert.equal(start.spec.config.maxToolCalls, allocation.toolCalls);
    const increase = h.svc.allocateCampaignBudget("root", { sessionId: id, costUsd: allocation.costUsd! + 1, toolCalls: allocation.toolCalls! + 1 });
    assert.ok(increase.ok, increase.error ?? "within-envelope allocation needs no human confirmation");
    const decrease = h.svc.allocateCampaignBudget("root", { sessionId: id, costUsd: allocation.costUsd! - 1, toolCalls: allocation.toolCalls! });
    assert.equal(decrease.ok, false, "in-flight capacity cannot be recycled without settlement");
    assert.equal(h.svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "claude", launchSurface: "native_tui" },
      undefined, undefined, false, false, false, { parentSessionId: "root" }).ok, false);
  } finally { h.db.close(); }
});

test("budget authority accepts bounded contracts and rejects clearing, unknown accounting, and malformed limits", () => {
  assert.ok(validCampaignBudgetAuthority(allowance({ acceptedFollowUps: 0, costUsd: 10, checkpointsUsd: [2, 10] })));
  for (const value of [null, {}, allowance({ costUsd: 0 }), allowance({ toolCalls: 1.5 }), allowance({ concurrency: 0 }),
    allowance({ acceptedFollowUps: -1 }), allowance({ costUsd: 5, checkpointsUsd: [4, 3] }), { ...allowance(), accounting: "external" }, { ...allowance(), unknown: true }]) assert.equal(validCampaignBudgetAuthority(value), false);
});

test("human-only grant, CAS, runner compatibility, and revocation preserve usage", () => {
  const h = harness();
  try {
    assert.equal(h.db.campaignBudgets.view("root"), undefined, "Custom remains unbounded");
    assert.ok(h.enable().ok);
    h.tool("root", "a");
    assert.equal(h.enable(allowance(), 1).ok, false);
    assert.equal(h.svc.setCampaignControl("root", { mode: "custom" }, 2, { ...h.principal, kind: "agent" } as unknown as HumanPrincipal).ok, false);
    assert.ok(h.svc.setCampaignControl("root", { mode: "custom" }, 2, h.principal).ok);
    assert.equal(h.db.campaignBudgets.view("root")!.state, "revoked");
    assert.equal(h.db.campaignBudgets.view("root")!.actual.toolCalls, 1);
    assert.equal(h.enable(allowance({ toolCalls: 1000 }), 3).ok, false, "a new grant cannot reset an exhausted/revoked ledger");
  } finally { h.db.close(); }
  const old = harness(":memory:", 216);
  try { assert.equal(old.enable().ok, false); } finally { old.db.close(); }
});

test("root, nested reviewers and replacements share reservations without double counting", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ costUsd: 100 })).ok);
    h.make("worker", "root", { maxToolCalls: 20, costBudgetUsd: 20 });
    h.make("reviewer", "worker", { maxToolCalls: 20, costBudgetUsd: 20 });
    assert.throws(() => h.make("third", "root", { maxToolCalls: 1, costBudgetUsd: 1 }), /concurrency/);
    assert.equal(h.db.getSession("third"), null, "failed admission rolls back creation");
    h.usage("root", 1); h.usage("worker", 2); h.usage("reviewer", 3);
    h.tool("worker", "read"); h.tool("worker", "read");
    const v = h.db.campaignBudgets.view("root")!;
    assert.equal(v.actual.costUsd, 6); assert.equal(v.actual.toolCalls, 1);
    assert.equal(v.occupied, 2);
    h.db.updateSessionStatus("worker", "completed", 7);
    h.db.deleteSession("worker");
    assert.equal(h.db.campaignBudgets.view("root")!.actual.costUsd, 6, "deletion never refunds spend or detaches reviewer accounting");
    h.make("replacement", "root", { maxToolCalls: 20, costBudgetUsd: 20 });
    assert.equal(h.db.campaignBudgets.view("root")!.occupied, 2);
    assert.ok(h.svc.campaignBudgetWorkerPreflight("root", { kind: "managed", sessionId: "reviewer" }).ok);
    assert.equal(h.svc.campaignBudgetWorkerPreflight("root", { kind: "external" }).ok, false);
  } finally { h.db.close(); }
});

test("competing reservations cannot both spend the same remaining allowance", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ costUsd: 90 })).ok);
    const before = h.db.campaignBudgets.view("root")!;
    assert.equal(before.remaining.costUsd, 60);
    h.make("first", "root", { costBudgetUsd: 50, maxToolCalls: 10 });
    assert.throws(() => h.make("second", "root", { costBudgetUsd: 50, maxToolCalls: 10 }), /unreserved/);
    assert.equal(h.db.campaignBudgets.view("root")!.outstanding.costUsd, 80);
    assert.equal(h.db.getSession("second"), null);
  } finally { h.db.close(); }
});

test("preauthorized checkpoints do not ask; tighter session ceilings cannot be enlarged", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ costUsd: 90, checkpointsUsd: [1, 2] })).ok);
    h.make("worker", "root", { costBudgetUsd: 5, maxToolCalls: 10 });
    h.usage("worker", 2);
    assert.deepEqual(h.db.campaignBudgets.view("root")!.reachedCheckpointsUsd, [1, 2]);
    assert.equal(h.db.getSession("worker")!.pendingApproval, null);
    assert.throws(() => h.db.campaignBudgets.admit("root", { sessionId: "worker", costUsd: 6, toolCalls: 10 }, {}), /tighter/);
    assert.equal(h.svc.setConfig("root", { maxToolCalls: 1000 }, { kind: "agent", id: "root" }).ok, false);
    assert.equal(h.svc.prompt("worker", "keep working", [], undefined, { costBudgetUsd: 100 }).ok, false);
  } finally { h.db.close(); }
});

test("exhaustion stops protected workers without repeated human continuation cards", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ toolCalls: 6 })).ok);
    h.make("worker", "root", { maxToolCalls: 4 });
    for (let i = 0; i < 6; i++) h.svc.onSessionEvent("worker", { kind: "tool_call", toolCallId: String(i), title: "Read", status: "completed" });
    assert.equal(h.db.campaignBudgets.view("root")!.state, "exhausted");
    assert.equal(h.db.getSession("root")!.status, "stopped");
    assert.equal(h.db.getSession("root")!.pendingApproval, null);
    assert.equal(h.db.getSession("worker")!.pendingApproval, null);
    assert.equal(h.svc.restart("worker").ok, false);
    assert.equal(h.svc.prompt("root", "continue").ok, false);
    assert.ok(h.logs.some((line) => JSON.parse(line).event === "campaign_budget_admission_stopped"));
  } finally { h.db.close(); }
});

test("mixed priced and unpriced usage is unavailable rather than zero, even after priced spend", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ costUsd: 100 })).ok);
    h.usage("root", 1);
    h.svc.onSessionEvent("root", { kind: "token_usage", inputTokens: 100, outputTokens: 2, model: "unpriced-model" });
    assert.equal(h.db.campaignBudgets.view("root")!.state, "accounting_unavailable");
    assert.equal(h.svc.campaignBudgetWorkerPreflight("root", { kind: "managed", sessionId: "root" }).ok, false);
    assert.match(h.db.campaignBudgetAccountingError("codex-app-server", "missing-model", true)!, /unpriced/);
    assert.match(h.db.campaignBudgetAccountingError("codex-exec", "anything", true)!, /unsupported/);
  } finally { h.db.close(); }
});

test("cancellation retains reservations until runner settlement; late spend still counts", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance()).ok);
    h.make("worker", "root", { maxToolCalls: 20 });
    assert.ok(h.svc.stop("worker").ok);
    assert.equal(h.db.campaignBudgets.view("root")!.occupied, 1);
    h.svc.onSessionStatus("worker", "stopped");
    assert.equal(h.db.campaignBudgets.view("root")!.occupied, 0);
    h.tool("worker", "late");
    assert.equal(h.db.campaignBudgets.view("root")!.actual.toolCalls, 1);
    assert.throws(() => h.db.campaignBudgets.admit("root", { sessionId: "worker", toolCalls: 0 }, {}), /spent/);
  } finally { h.db.close(); }
});

test("accepted follow-up reservations are permanent and idempotent, including failed writes", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ acceptedFollowUps: 1 })).ok);
    assert.throws(() => h.db.campaignBudgets.acceptFollowUp("root", "failed", () => { throw new Error("fail"); }), /fail/);
    assert.equal(h.db.campaignBudgets.view("root")!.acceptedFollowUps, 0);
    h.db.campaignBudgets.acceptFollowUp("root", "one", () => null);
    h.db.campaignBudgets.acceptFollowUp("root", "one", () => null);
    assert.equal(h.db.campaignBudgets.view("root")!.acceptedFollowUps, 1);
    assert.throws(() => h.db.campaignBudgets.acceptFollowUp("root", "two", () => null), /follow-up/);
  } finally { h.db.close(); }
});

test("durable accounting survives reconnect/reopen, transcript clearing, and replay", () => {
  const dir = mkdtempSync(join(tmpdir(), "campaign-budget-"));
  const path = join(dir, "db.sqlite");
  const h = harness(path);
  try {
    assert.ok(h.enable().ok); h.tool("root", "one"); h.tool("root", "two");
    h.db.clearSessionEvents("root");
    assert.equal(h.db.campaignBudgets.view("root")!.actual.toolCalls, 2);
    h.tool("root", "one");
    assert.equal(h.db.campaignBudgets.view("root")!.actual.toolCalls, 2);
    h.tool("root", "three");
    assert.equal(h.db.campaignBudgets.view("root")!.actual.toolCalls, 3, "a fresh call after history reset still consumes allowance");
  } finally { h.db.close(); }
  const reopened = ControlPlaneDb.open(path);
  try { assert.equal(reopened.campaignBudgets.view("root")!.actual.toolCalls, 3); }
  finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("generated competing tool reservations always conserve the immutable envelope", () => {
  fc.assert(fc.property(fc.integer({ min: 3, max: 1000 }), fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 5 }), (ceiling, requests) => {
    const h = harness();
    try {
      assert.ok(h.enable(allowance({ toolCalls: ceiling, concurrency: 5 })).ok);
      requests.forEach((toolCalls, i) => {
        try { h.make(`worker-${i}`, "root", { maxToolCalls: toolCalls }); } catch { /* A refusal must conserve capacity too. */ }
        const v = h.db.campaignBudgets.view("root")!;
        assert.ok(v.actual.toolCalls + v.outstanding.toolCalls <= ceiling);
        assert.ok(v.occupied <= 5);
      });
    } finally { h.db.close(); }
  }), { numRuns: 40 });
});
