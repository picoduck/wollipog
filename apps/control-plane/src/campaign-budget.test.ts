import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION,
  validCampaignBudgetAuthority, type CampaignBudgetAuthority, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb, RUNNER_REPORTED_STOP } from "./db.js";
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
  db.setUsageRateTable(new Map([["claude-opus-5-5", { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001, cacheReadCostPerToken: 0.000001, cacheCreationCostPerToken: 0.000001 }]])); // Fixture rates, never live pricing.
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: "picoduck/wollipog", issueNumbers: [2936], revision: 1, authorizedByUserId: principal.userId, authorizedAt: 1 };
  policy.issueNumbers = [2936];
  const make = (id: string, parentSessionId?: string, config: { costBudgetUsd?: number; maxToolCalls?: number } = {}) => {
    db.createSession({ id, parentSessionId, runnerId: "r", workspaceId: "w", agentId: "claude", title: id, useWorktree: false,
      creationActor: parentSessionId ? "agent" : "human",
      scope:{organizationId:principal.organizationId,owner:{kind:"user",userId:principal.userId}},
      driver: "claude-code", config: { model: "claude-opus-5-5", ...config }, now: 2,
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
  return { db, hub, svc, make, tool, usage, enable, principal, sent, logs,metadata };
}

test("service launches use the exact reservation and agent reallocations preserve tighter limits", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ toolCalls: 120, costUsd: 120 })).ok);
    const result = h.svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "claude", config: { model: "claude-opus-5-5" }, prompt: "Implement authorized #2936" },
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
    assert.ok(h.svc.allocateCampaignBudget("root",{sessionId:id,toolCalls:allocation.toolCalls!+2}).ok,"omitting cost preserves the current reservation");
    assert.equal(h.svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "claude", launchSurface: "native_tui" },
      undefined, undefined, false, false, false, { parentSessionId: "root" }).ok, false);
  } finally { h.db.close(); }
});

test("budget authority accepts bounded contracts and rejects clearing, unknown accounting, and malformed limits", () => {
  assert.ok(validCampaignBudgetAuthority(allowance({ acceptedFollowUps: 0, costUsd: 10, checkpointsUsd: [2, 10] })));
  for (const value of [null, {}, allowance({ costUsd: 0 }), allowance({ toolCalls: 1.5 }), allowance({ concurrency: 0 }),
    allowance({ acceptedFollowUps: -1 }), allowance({ costUsd: 5, checkpointsUsd: [4, 3] }), { ...allowance(), accounting: "external" }, { ...allowance(), unknown: true }]) assert.equal(validCampaignBudgetAuthority(value), false);
});

test("run fanout carries exactly its admitted limits; downgraded peers refuse all new admission",()=>{
  const h=harness();
  try {
    assert.ok(h.enable(allowance({costUsd:100})).ok);
    const result=h.svc.createRun({runnerId:"r",workspaceId:"w",agentIds:["claude"],task:"Implement #2936",config:{model:"claude-opus-5-5"}},{parentSessionId:"root"});
    assert.ok(result.ok,result.error??"run admission failed");
    const member=result.data!.sessions[0]!;
    const start=h.sent.find((m)=>(m as any).type==="start_session") as any;
    assert.equal(start.spec.config.costBudgetUsd,h.db.campaignBudgets.allocation(member.id)!.costUsd);
    assert.equal(start.spec.config.maxToolCalls,h.db.campaignBudgets.allocation(member.id)!.toolCalls);
    h.db.registerRunner(h.metadata,10,217);
    assert.equal(h.svc.prompt("root","continue").ok,false);
    assert.equal(h.svc.campaignBudgetWorkerPreflight("root",{kind:"managed",sessionId:member.id}).ok,false);
    assert.equal(h.svc.allocateCampaignBudget("root",{sessionId:member.id,toolCalls:1}).ok,false);
  } finally {h.db.close();}
});

test("malformed control proposals refuse without changing the human revision",()=>{
  const h=harness();
  try {
    assert.equal(h.svc.setCampaignControl("root",{mode:"other"} as any,1,h.principal).ok,false);
    assert.equal(h.svc.setCampaignControl("root",{mode:"full_control",objective:"x",operations:["implementation_question"],delegatablePolicyIds:"invalid"} as any,1,h.principal).ok,false);
    assert.ok(h.enable().ok);
  } finally {h.db.close();}
});

test("human control updates compose issue and budget authority without bypassing their peer gates", () => {
  const h = harness();
  try {
    const issueAuthority = { epics: [2936], relatedFollowUps: true, maxIssues: 3, closureReasons: ["completed" as const] };
    const proposal = { mode: "full_control" as const, objective: "Implement #2936", operations: ["implementation_question" as const],
      delegatablePolicyIds: [], issueAuthority, budgetAuthority: allowance() };
    const enabled = h.svc.setCampaignControl("root", proposal, 1, h.principal);
    assert.ok(enabled.ok, enabled.error ?? "composed human authority was refused");
    const current = h.db.getSession("root")!.orchestratorPolicy!.control!;
    assert.equal(current.mode, "full_control");
    if (current.mode !== "full_control") throw new Error("missing Full Control");
    assert.deepEqual(current.boundary.issueAuthority, issueAuthority);
    assert.deepEqual(current.boundary.budgetAuthority, proposal.budgetAuthority);
    h.db.registerRunner(h.metadata, 10, 217);
    assert.equal(h.svc.setCampaignControl("root", proposal, 2, h.principal).ok, false);
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.control, current);
  } finally { h.db.close(); }
});

test("optional media reservation adapter refuses before its owned production tables exist", () => {
  const h = harness();
  try {
    assert.ok(h.enable().ok);
    h.make("child", "root");
    const before = h.db.campaignBudgets.view("root");
    const expected = { rootSessionId: "root", runnerId: "r", generation: h.db.campaignBudgets.dispatch("child")!.generation,
      commandSha256: "a".repeat(64), dispatchSha256: null };
    assert.equal(h.db.campaignBudgets.deactivateNeverDispatchedMediaReservation("child", expected), false);
    h.db.campaignBudgets.database.exec("BEGIN");
    try {
      assert.equal(h.db.campaignBudgets.deactivateNeverDispatchedMediaReservation("child", expected), false);
      assert.deepEqual(h.db.campaignBudgets.view("root"), before);
    } finally { h.db.campaignBudgets.database.exec("ROLLBACK"); }
  } finally { h.db.close(); }
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
  const old = harness(":memory:", 217);
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
    h.db.campaignBudgets.recordCheckpoint("worker", { generation: h.db.campaignBudgets.dispatch("worker")!.generation, historyEpoch: 0, throughSeq: 0, costUsd: 2 });
    assert.ok(h.db.campaignBudgets.settleCheckpoint("worker", { historyEpoch: 0, hydratedSeq: 0 }));
    h.db.deleteSession("worker");
    assert.equal(h.db.campaignBudgets.view("root")!.actual.costUsd, 6, "deletion never refunds spend or detaches reviewer accounting");
    h.make("replacement", "root", { maxToolCalls: 20, costBudgetUsd: 20 });
    assert.equal(h.db.campaignBudgets.view("root")!.occupied, 2);
    assert.ok(h.svc.campaignBudgetWorkerPreflight("root", { kind: "managed", sessionId: "reviewer" }).ok);
    h.db.updateSessionStatus("reviewer", "completed", 8);
    assert.equal(h.svc.campaignBudgetWorkerPreflight("root", { kind: "managed", sessionId: "reviewer" }).ok, false, "a completed worker is not a new admitted review launch");
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

test("a restart refused by occupied campaign slots preserves its stop fence",()=>{
  const h=harness();
  try {
    assert.ok(h.enable(allowance({costUsd:120})).ok);
    h.make("old","root",{costBudgetUsd:20,maxToolCalls:20});
    h.db.updateSessionStatus("old","stopped",7,RUNNER_REPORTED_STOP);
    h.db.campaignBudgets.recordCheckpoint("old",{generation:h.db.campaignBudgets.dispatch("old")!.generation,historyEpoch:0,throughSeq:0,costUsd:0});
    assert.ok(h.db.campaignBudgets.settleCheckpoint("old",{historyEpoch:0,hydratedSeq:0}));
    h.make("new1","root",{costBudgetUsd:20,maxToolCalls:20});
    h.make("new2","root",{costBudgetUsd:20,maxToolCalls:20});
    h.db.addSessionStopIntent("old","r",8);
    const dispatch=h.db.campaignBudgets.dispatch("old");
    const result=h.svc.restart("old");
    assert.equal(result.ok,false);assert.match(result.error!,/concurrency/);
    assert.equal(h.db.sessionStopRestartLaunchId("old"),null,"no launch was sent, so terminal stop evidence must still settle");
    assert.deepEqual(h.db.campaignBudgets.dispatch("old"),dispatch);
    assert.equal(h.db.campaignBudgets.active("old"),false);
    assert.equal(h.sent.some((m)=>(m as any).type==="start_session"),false);
  } finally {h.db.close();}
});

test("a definitively unsent restart restores its generation and pending final checkpoint",async()=>{
  const h=harness();
  try {
    assert.ok(h.enable(allowance({costUsd:120})).ok);
    h.make("worker","root",{costBudgetUsd:20,maxToolCalls:20});
    h.db.updateSessionStatus("worker","stopped",7,RUNNER_REPORTED_STOP);
    h.db.reconcileRunnerHistory("worker",0,0);
    const checkpoint={generation:h.db.campaignBudgets.dispatch("worker")!.generation,historyEpoch:0,throughSeq:0,costUsd:2};
    h.db.campaignBudgets.recordCheckpoint("worker",checkpoint);
    const before=h.db.campaignBudgets.dispatchState("worker");
    h.hub.sendToRunner=()=>false;
    assert.equal(h.svc.restart("worker").ok,false);
    assert.deepEqual(h.db.campaignBudgets.dispatchState("worker"),before,"a known-unsent dispatch cannot destroy old retirement evidence");
    h.hub.sendToRunner=()=>true;
    h.svc.onSessionStatus("worker","stopped",undefined,undefined,"r",undefined,undefined,checkpoint);
    await new Promise((r)=>setImmediate(r));
    assert.equal(h.db.campaignBudgets.active("worker"),false,"normal service hydration settles the restored old receipt");
    assert.equal(h.db.campaignBudgets.view("root")!.actual.costUsd,2);
  } finally {h.db.close();}
});

test("reconnect redelivers existing allocations without changing generation or admission",()=>{
  const h=harness();
  try {
    h.make("worker","root");
    h.hub.sendToRunner=()=>false;
    assert.ok(h.enable(allowance({costUsd:120})).ok);
    const before=h.db.campaignBudgets.dispatchState("worker");
    h.sent.length=0;
    h.hub.sendToRunner=(_,message)=>{h.sent.push(message);return true;};
    h.svc.recoverCampaignBudgetAllocations("r");
    const frame=h.sent.find((m)=>(m as any).type==="rearm_governance" && (m as any).sessionId==="worker") as any;
    assert.ok(frame);assert.equal(frame.campaignBudgetDispatch.generation,before.generation);
    assert.deepEqual(frame.config,{costBudgetUsd:h.db.campaignBudgets.allocation("worker")!.costUsd,maxToolCalls:h.db.campaignBudgets.allocation("worker")!.toolCalls});
    assert.deepEqual(h.db.campaignBudgets.dispatchState("worker"),before);
    h.db.registerRunner(h.metadata,10,217);
    h.sent.length=0;h.svc.recoverCampaignBudgetAllocations("r");
    assert.equal(h.sent.some((m)=>(m as any).type==="rearm_governance"),false,"unsupported peers receive no budget rearm");
  } finally {h.db.close();}
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
    assert.equal(h.db.campaignBudgets.view("root")!.occupied, 1, "status alone does not prove final usage");
    h.tool("worker", "late");
    assert.equal(h.db.campaignBudgets.view("root")!.actual.toolCalls, 1);
    const generation = h.db.campaignBudgets.dispatch("worker")!.generation;
    h.db.campaignBudgets.recordCheckpoint("worker", { generation, historyEpoch: 0, throughSeq: 2, costUsd: 0 });
    assert.equal(h.db.campaignBudgets.settleCheckpoint("worker", { historyEpoch: 0, hydratedSeq: 1 }), false);
    assert.ok(h.db.campaignBudgets.settleCheckpoint("worker", { historyEpoch: 0, hydratedSeq: 2 }));
    assert.equal(h.db.campaignBudgets.view("root")!.occupied, 0);
    assert.equal(h.db.campaignBudgets.settleCheckpoint("worker", { historyEpoch: 0, hydratedSeq: 2 }), false, "settlement is one-shot");
    h.db.campaignBudgets.admit("root", { sessionId: "worker", toolCalls: 20 }, {});
    h.db.campaignBudgets.replaceDispatch("worker");
    h.db.campaignBudgets.recordCheckpoint("worker", { generation, historyEpoch: 0, throughSeq: 2, costUsd: 0 });
    assert.equal(h.db.campaignBudgets.settleCheckpoint("worker", { historyEpoch: 0, hydratedSeq: 2 }), false, "old completion cannot release replacement admission");
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

test("native review reservations price failed attempts, survive replay and enforce exact review bounds",()=>{
  const h=harness();
  try {
    assert.ok(h.enable(allowance({costUsd:100,toolCalls:1000})).ok);
    const profile={profile:"native_opus_5_5_high_read_only",controllerSha256:"a".repeat(64),executableSha256:"b".repeat(64),cliVersion:"2.1.296",accounting:"provider_list_estimate",account:"runner_default_claude",agentId:"claude"} as const;
    const request={requestId:"r1",workItemId:"item",pullRequest:{repository:"picoduck/wollipog",number:3065},baseSha:"a".repeat(40),headSha:"b".repeat(40),costUsd:5,toolCalls:20,brief:"Review the exact head."};
    const job=h.db.campaignReviewJobs.reserve("root","r","root",2,profile,request);
    assert.equal(h.db.campaignBudgets.view("root")!.occupied,1);
    assert.deepEqual(h.db.campaignReviewJobs.reserve("root","r","root",2,profile,request),job);
    assert.throws(()=>h.db.campaignReviewJobs.reserve("root","r","root",2,profile,{...request,requestId:"parallel"}),/unsettled/);
    const receipt={type:"campaign_review_job_update",jobId:job.jobId,nonce:job.nonce,state:"completed",costUsd:2,toolCalls:3,
      attemptValid:false,attemptConsumed:true,vote:"INVALID",receiptSha256:"c".repeat(64)} as const;
    assert.equal(h.db.campaignReviewJobs.accept("foreign",receipt),false);
    assert.equal(h.db.campaignReviewJobs.accept("r",{...receipt,nonce:"changed"}),false);
    assert.ok(h.db.campaignReviewJobs.accept("r",receipt));
    assert.ok(h.db.campaignReviewJobs.accept("r",receipt));
    assert.equal(h.db.campaignReviewJobs.accept("r",{...receipt,costUsd:3}),false);
    assert.equal(h.db.campaignBudgets.view("root")!.actual.costUsd,2);
    assert.equal(h.db.campaignBudgets.view("root")!.occupied,0);
    const retry=h.db.campaignReviewJobs.reserve("root","r","root",2,profile,{...request,requestId:"r2"});
    assert.equal(h.db.campaignReviewJobs.view(retry.jobId)!.attempt,2);
    assert.ok(h.db.campaignReviewJobs.accept("r",{...receipt,jobId:retry.jobId,nonce:retry.nonce}));
    assert.throws(()=>h.db.campaignReviewJobs.reserve("root","r","root",2,profile,{...request,requestId:"r3"}),/limit reached/);
    for(let round=1;round<=4;round++) {
      const valid=h.db.campaignReviewJobs.reserve("root","r","root",2,profile,{...request,requestId:`valid${round}`,baseSha:"d".repeat(40)});
      assert.equal(h.db.campaignReviewJobs.view(valid.jobId)!.round,round);
      assert.ok(h.db.campaignReviewJobs.accept("r",{...receipt,jobId:valid.jobId,nonce:valid.nonce,attemptValid:true,vote:"DOWNVOTE"}));
    }
    assert.throws(()=>h.db.campaignReviewJobs.reserve("root","r","root",2,profile,{...request,requestId:"round5",baseSha:"d".repeat(40)}),/limit reached/);
  } finally {h.db.close();}
});

test("native service binds authority, assigned scope, canonical PR and server-only usage",()=>{
  const h=harness();
  try {
    const profile={profile:"native_opus_5_5_high_read_only",controllerSha256:"a".repeat(64),executableSha256:"b".repeat(64),cliVersion:"2.1.296",accounting:"provider_list_estimate",account:"runner_default_claude",agentId:"claude"} as const;
    const grant=allowance({costUsd:100,toolCalls:1000,controlledReview:profile});
    assert.equal(h.enable(grant).ok,false,"no supported profile may be advertised before discovery");
    h.metadata.runtime={dataDir:"/runner",worktreeRoot:"/runner/worktrees",maxConcurrentSessions:4,campaignReview:profile};
    h.db.registerRunner(h.metadata,10,PROTOCOL_VERSION);
    assert.ok(h.enable(grant).ok);
    h.make("worker","root");h.db.setWorktreePath("worker","/runner/worktrees/worker");
    const plan=h.svc.recordCampaignPlan("root",{planComplete:true,items:[{key:"picoduck/wollipog#2936",issue:{repository:"picoduck/wollipog",number:2936}}]});
    assert.ok(plan.ok,plan.error??"plan refused");
    const workItemId=plan.data!.items[0]!.workItemId;
    const assigned=h.svc.assignCampaignWorkItem("root",{workItemId,childSessionId:"worker"});
    assert.ok(assigned.ok,assigned.error??"assignment refused");
    assert.ok(h.svc.updateCampaignWorkItem("root",{workItemId,stage:{stage:"in_review",pullRequests:[{repository:"picoduck/wollipog",number:3065}]}}).ok);
    const request={requestId:"native",workItemId,pullRequest:{repository:"picoduck/wollipog",number:3065},baseSha:"a".repeat(40),headSha:"b".repeat(40),costUsd:5,toolCalls:20,brief:"Review the exact head."};
    assert.equal(h.svc.requestCampaignReviewJob("root",{...request,costJSON:{costUsd:0}} as any).ok,false);
    assert.equal(h.svc.requestCampaignReviewJob("root",{...request,pullRequest:{...request.pullRequest,number:999}}).ok,false);
    const result=h.svc.requestCampaignReviewJob("root",request);
    assert.ok(result.ok,result.error??"review refused");
    assert.equal(result.data!.state,"reserved");
    assert.equal(h.db.campaignWorkLedger.accounting.costSummary("root",Date.now()).total.availability,"unavailable","an unpriced native attempt is not displayed as free review");
    assert.ok(h.svc.campaignReviewJob("root",result.data!.jobId).ok);
    const command=h.db.campaignReviewJobs.command(result.data!.jobId)!;
    h.svc.onCampaignReviewJobUpdate("r",{type:"campaign_review_job_update",jobId:command.jobId,nonce:command.nonce,state:"completed",costUsd:2,toolCalls:3,attemptValid:true,attemptConsumed:true,vote:"UPVOTE",receiptSha256:"c".repeat(64),report:"UPVOTE"});
    const completed=h.svc.campaignReviewJob("root",command.jobId).data!;
    assert.equal(completed.attemptValid,true);
    assert.equal(completed.attemptConsumed,true);
    assert.equal(completed.usageSettlement,"settled");
    assert.equal("report" in completed,false);
    assert.equal(h.db.campaignReviewJobs.validatedReport(command.jobId),"UPVOTE");
    const page=h.svc.campaignReviewJobs("root",{limit:1});
    assert.ok(page.ok);assert.equal(page.data!.jobs.length,1);
    assert.equal(page.data!.jobs[0]!.terminalOutcome,"valid_review");
    assert.equal("brief" in page.data!.jobs[0]!.request,false);
    assert.equal(h.svc.campaignReviewJobs("root",{limit:101}).ok,false);
    assert.equal(h.svc.campaignReviewJob("root",command.jobId,(id)=>id!=="worker").ok,false);
    assert.equal(h.svc.campaignReviewReport("root",command.jobId).data!.reviewReport,"UPVOTE");
    const cost=h.db.campaignWorkLedger.accounting.costSummary("root",Date.now());
    assert.ok("value" in cost.total);
    assert.equal(cost.total.value.usd,2,"native review appears in total cost as well as the allowance ledger");
    const ownerScope=h.db.sessionScope("root")!;
    assert.equal(h.db.userCostTodayUsd(ownerScope.organizationId,h.principal.userId),2,"enabling a daily cap later cannot erase already recorded native spending");
    const listed=h.db.listUserCostWindows(ownerScope.organizationId).find((row)=>row.userId===h.principal.userId)!;
    assert.equal(listed.todayUsd,2);
    assert.equal(listed.last7DaysUsd,2);
    assert.equal(listed.last30DaysUsd,2);
    h.svc.onCampaignReviewJobUpdate("r",{type:"campaign_review_job_update",jobId:command.jobId,nonce:command.nonce,state:"completed",costUsd:2,toolCalls:3,attemptValid:true,attemptConsumed:true,vote:"UPVOTE",receiptSha256:"c".repeat(64),report:"UPVOTE"});
    assert.equal(h.db.userCostTodayUsd(ownerScope.organizationId,h.principal.userId),2,"receipt replay never charges a second time");
    const attemptCost=h.db.campaignWorkLedger.accounting.attemptUsage("root").get(command.lineage!.workItemAttemptId)!;
    assert.equal(attemptCost.costMicrousd,2_000_000);
  } finally {h.db.close();}
});

test("recording a planned follow-up cannot bypass the accepted-work allowance",()=>{
  const h=harness();
  try {
    assert.ok(h.enable(allowance({acceptedFollowUps:0})).ok);
    const result=h.svc.recordCampaignPlan("root",{planComplete:false,items:[{key:"followup",origin:"follow_up",title:"Follow-Up"}]});
    assert.equal(result.ok,false);
    assert.equal(h.db.campaignBudgets.view("root")!.acceptedFollowUps,0);
  } finally {h.db.close();}
});

test("native missing usage stops admission and retains the full outstanding reservation",()=>{
  const h=harness();
  try {
    assert.ok(h.enable(allowance({costUsd:100,toolCalls:1000})).ok);
    const p={profile:"native_opus_5_5_high_read_only",controllerSha256:"a".repeat(64),executableSha256:"b".repeat(64),cliVersion:"2.1.296",accounting:"provider_list_estimate",account:"runner_default_claude",agentId:"claude"} as const;
    const job=h.db.campaignReviewJobs.reserve("root","r","root",2,p,{requestId:"unknown",workItemId:"item",pullRequest:{repository:"picoduck/wollipog",number:3065},baseSha:"a".repeat(40),headSha:"b".repeat(40),costUsd:5,toolCalls:20,brief:"Review."});
    assert.ok(h.db.campaignReviewJobs.accept("r",{type:"campaign_review_job_update",jobId:job.jobId,nonce:job.nonce,state:"accounting_unavailable",toolCalls:1}));
    assert.equal(h.db.campaignBudgets.view("root")!.state,"accounting_unavailable");
    assert.equal(h.db.campaignBudgets.view("root")!.occupied,1);
    assert.equal(h.db.campaignReviewJobs.view(job.jobId)!.costUsd,null);
  } finally {h.db.close();}
});


test("native reconnect repeats current admission and never dispatches to an unsupported peer",()=>{

  const h=harness();
  try {
    const profile={profile:"native_opus_5_5_high_read_only",controllerSha256:"a".repeat(64),executableSha256:"b".repeat(64),cliVersion:"2.1.296",accounting:"provider_list_estimate",account:"runner_default_claude",agentId:"claude"} as const;
    const grant=allowance({costUsd:100,toolCalls:1000,controlledReview:profile});
    assert.equal(h.enable(grant).ok,false,"no supported profile may be advertised before discovery");
    h.metadata.runtime={dataDir:"/runner",worktreeRoot:"/runner/worktrees",maxConcurrentSessions:4,campaignReview:profile};
    h.db.registerRunner(h.metadata,10,PROTOCOL_VERSION);
    assert.ok(h.enable(grant).ok);
    h.make("worker","root");h.db.setWorktreePath("worker","/runner/worktrees/worker");
    const plan=h.svc.recordCampaignPlan("root",{planComplete:true,items:[{key:"picoduck/wollipog#2936",issue:{repository:"picoduck/wollipog",number:2936}}]});
    assert.ok(plan.ok,plan.error??"plan refused");
    const workItemId=plan.data!.items[0]!.workItemId;
    const assigned=h.svc.assignCampaignWorkItem("root",{workItemId,childSessionId:"worker"});
    assert.ok(assigned.ok,assigned.error??"assignment refused");
    assert.ok(h.svc.updateCampaignWorkItem("root",{workItemId,stage:{stage:"in_review",pullRequests:[{repository:"picoduck/wollipog",number:3065}]}}).ok);
    const request={requestId:"native",workItemId,pullRequest:{repository:"picoduck/wollipog",number:3065},baseSha:"a".repeat(40),headSha:"b".repeat(40),costUsd:5,toolCalls:20,brief:"Review the exact head."};
    assert.equal(h.svc.requestCampaignReviewJob("root",{...request,costJSON:{costUsd:0}} as any).ok,false);
    assert.equal(h.svc.requestCampaignReviewJob("root",{...request,pullRequest:{...request.pullRequest,number:999}}).ok,false);
    const result=h.svc.requestCampaignReviewJob("root",request);
    assert.ok(result.ok,result.error??"review refused");
    assert.equal(result.data!.state,"reserved");
    assert.equal(h.db.campaignWorkLedger.accounting.costSummary("root",Date.now()).total.availability,"unavailable","an unpriced native attempt is not displayed as free review");
    assert.ok(h.svc.campaignReviewJob("root",result.data!.jobId).ok);
    const command=h.db.campaignReviewJobs.command(result.data!.jobId)!;

    h.sent.length=0;h.svc.recoverCampaignReviewJobs("r");
    assert.equal(h.sent.filter((m)=>(m as any).type==="campaign_review_job").length,1);
    assert.equal(h.db.campaignReviewJobs.view(command.jobId)!.state,"reserved");
    h.db.registerRunner(h.metadata,11,217);
    h.sent.length=0;h.svc.recoverCampaignReviewJobs("r");
    assert.equal(h.sent.some((m)=>["campaign_review_job","cancel_campaign_review_job"].includes((m as any).type)),false);
    assert.equal(h.db.campaignBudgets.view("root")!.state,"accounting_unavailable");
    assert.equal(h.db.campaignBudgets.active(command.jobId),true);
    assert.equal(h.db.campaignReviewJobs.view(command.jobId)!.costUsd,null,"unsupported recovery does not fabricate zero spend");
    h.sent.length=0;
    h.svc.onCampaignReviewJobUpdate("r",{type:"campaign_review_job_update",jobId:command.jobId,nonce:command.nonce,
      state:"running",costUsd:1,toolCalls:1});
    assert.equal(h.sent.some((m)=>["campaign_review_job","cancel_campaign_review_job"].includes((m as any).type)),false,
      "late owned usage from a downgraded peer must not emit unnegotiated native cancellation frames");
    assert.equal(h.db.campaignBudgets.view("root")!.state,"accounting_unavailable");
    assert.equal(h.db.campaignBudgets.active(command.jobId),true);
    assert.equal(h.db.campaignReviewJobs.view(command.jobId)!.costUsd,1,"owned late usage remains charged without releasing unknown capacity");
  } finally {h.db.close();}
});

test("supported native reconnect cancels after human revocation without new admission",()=>{

  const h=harness();
  try {
    const profile={profile:"native_opus_5_5_high_read_only",controllerSha256:"a".repeat(64),executableSha256:"b".repeat(64),cliVersion:"2.1.296",accounting:"provider_list_estimate",account:"runner_default_claude",agentId:"claude"} as const;
    const grant=allowance({costUsd:100,toolCalls:1000,controlledReview:profile});
    assert.equal(h.enable(grant).ok,false,"no supported profile may be advertised before discovery");
    h.metadata.runtime={dataDir:"/runner",worktreeRoot:"/runner/worktrees",maxConcurrentSessions:4,campaignReview:profile};
    h.db.registerRunner(h.metadata,10,PROTOCOL_VERSION);
    assert.ok(h.enable(grant).ok);
    h.make("worker","root");h.db.setWorktreePath("worker","/runner/worktrees/worker");
    const plan=h.svc.recordCampaignPlan("root",{planComplete:true,items:[{key:"picoduck/wollipog#2936",issue:{repository:"picoduck/wollipog",number:2936}}]});
    assert.ok(plan.ok,plan.error??"plan refused");
    const workItemId=plan.data!.items[0]!.workItemId;
    const assigned=h.svc.assignCampaignWorkItem("root",{workItemId,childSessionId:"worker"});
    assert.ok(assigned.ok,assigned.error??"assignment refused");
    assert.ok(h.svc.updateCampaignWorkItem("root",{workItemId,stage:{stage:"in_review",pullRequests:[{repository:"picoduck/wollipog",number:3065}]}}).ok);
    const request={requestId:"native",workItemId,pullRequest:{repository:"picoduck/wollipog",number:3065},baseSha:"a".repeat(40),headSha:"b".repeat(40),costUsd:5,toolCalls:20,brief:"Review the exact head."};
    assert.equal(h.svc.requestCampaignReviewJob("root",{...request,costJSON:{costUsd:0}} as any).ok,false);
    assert.equal(h.svc.requestCampaignReviewJob("root",{...request,pullRequest:{...request.pullRequest,number:999}}).ok,false);
    const result=h.svc.requestCampaignReviewJob("root",request);
    assert.ok(result.ok,result.error??"review refused");
    assert.equal(result.data!.state,"reserved");
    assert.equal(h.db.campaignWorkLedger.accounting.costSummary("root",Date.now()).total.availability,"unavailable","an unpriced native attempt is not displayed as free review");
    assert.ok(h.svc.campaignReviewJob("root",result.data!.jobId).ok);
    const command=h.db.campaignReviewJobs.command(result.data!.jobId)!;

    h.sent.length=0;
    assert.ok(h.svc.setCampaignControl("root",{mode:"custom"},2,h.principal).ok);
    assert.ok(h.sent.some((m)=>(m as any).type==="cancel_campaign_review_job" && (m as any).jobId===command.jobId));
    assert.equal(h.sent.some((m)=>(m as any).type==="campaign_review_job"),false);
    assert.equal(h.db.campaignBudgets.active(command.jobId),true);
  } finally {h.db.close();}
});
