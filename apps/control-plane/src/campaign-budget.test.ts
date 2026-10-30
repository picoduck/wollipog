import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, projectSessionEventPayloadForProtocol,
  validCampaignBudgetAuthority, type CampaignBudgetAuthority, type RunnerMetadata, type SessionEventPayload } from "@wollipog/protocol";
import { ControlPlaneDb, RUNNER_REPORTED_STOP } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import type { HumanPrincipal } from "./identity.js";

const allowance = (extra: Partial<CampaignBudgetAuthority> = {}): CampaignBudgetAuthority => ({ version: 1,
  accounting: "managed_workers_only", unpriced: "stop", toolCalls: 120, concurrency: 2, ...extra });

function harness(path = ":memory:", protocol = PROTOCOL_VERSION, completion?: "retain" | "stop_and_archive") {
  const db = ControlPlaneDb.open(path);
  const identity = db.localIdentityContext();
  const principal: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repo" }],
    agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", available: true }] };
  db.registerRunner(metadata, 1, protocol);
  db.setUsageRateTable(new Map([["claude-opus-5-5", { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001, cacheReadCostPerToken: 0.000001, cacheCreationCostPerToken: 0.000001 }]])); // Fixture rates, never live pricing.
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  if (completion) policy.behavior.completion = completion;
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

test("a child creation refused or failing while recording its work item leaves no child, reservation, or parent charge (#3106)", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ toolCalls: 120, concurrency: 1 })).ok);
    h.db.updateSessionMaxToolCalls("root", 60, 4);
    const plan = h.svc.recordCampaignPlan("root", { items: [{ key: "item" }], planComplete: true });
    assert.ok(plan.ok && plan.data, plan.error ?? "plan refused");
    const workItemId = plan.data.items[0]!.workItemId;
    const request = { runnerId: "r", workspaceId: "w", agentId: "claude", config: { model: "claude-opus-5-5" },
      prompt: "Implement authorized #2936", campaignWorkItemId: workItemId };
    const create = () => h.svc.createSession(request, undefined, undefined, false, false, false, { parentSessionId: "root" });
    const sql = (h.db as unknown as { db: { prepare(query: string): { get(): unknown } } }).db;
    const state = () => ({
      occupied: h.db.campaignBudgets.view("root")!.occupied,
      members: h.db.campaignBudgets.members("root").filter((id) => id !== "root"),
      children: sql.prepare("SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id='root'").get(),
      reserved: sql.prepare("SELECT child_cost_reserved_usd AS cost, child_tool_calls_reserved AS tools FROM sessions WHERE id='root'").get(),
      launches: h.sent.length,
    });
    const before = JSON.stringify(state());
    const ledger = h.db.campaignWorkLedger;
    const assign = ledger.assign;
    for (const [label, replacement, status] of [
      ["returned refusal", () => ({ ok: false as const, status: 409, error: "ledger refused" }), 409],
      ["thrown failure", () => { throw new Error("SQLITE_ABORT: attempt insert failed"); }, 500],
    ] as const) {
      ledger.assign = replacement as unknown as typeof assign;
      const refused = create();
      ledger.assign = assign;
      assert.equal(refused.status, status, `${label}: ${refused.error}`);
      assert.match(refused.error ?? "", /cannot record the child's attempt on campaign work item/u, label);
      assert.equal(JSON.stringify(state()), before, `${label}: creation rolled back completely`);
    }
    const retried = create();
    assert.ok(retried.ok && retried.data, retried.error ?? "retry refused");
    assert.equal(retried.data.campaignMembership?.currentWorkItemId, workItemId);
  } finally { h.db.close(); }
});

test("a child creation refused while storing its prompt images releases its reservation and parent charge (#3183)", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ toolCalls: 120, concurrency: 1 })).ok);
    h.db.updateSessionMaxToolCalls("root", 60, 4);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const valid = { mimeType: "image/png", data: png.toString("base64") };
    const sha256 = createHash("sha256").update(png).digest("hex");
    h.db.createWorkflowArtifactBytes({ artifactId: "art_root", sessionId: "root", kind: "screenshot", name: "root-image",
      mimeType: "image/png", encoding: "base64", sizeBytes: png.byteLength, sha256, createdBy: { kind: "system", id: "test" },
      metadata: {}, createdAt: 4 }, png);
    const create = (images: Array<Record<string, unknown>>) => h.svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "claude",
      config: { model: "claude-opus-5-5" }, prompt: "Implement authorized #2936", images: images as never },
    undefined, undefined, false, false, false, { parentSessionId: "root" });
    const sql = (h.db as unknown as { db: { prepare(query: string): { get(): unknown } } }).db;
    const state = () => ({
      occupied: h.db.campaignBudgets.view("root")!.occupied,
      members: h.db.campaignBudgets.members("root").filter((id) => id !== "root"),
      children: sql.prepare("SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id='root'").get(),
      parent: sql.prepare(`SELECT child_spawn_count AS spawned, child_cost_reserved_usd AS cost,
        child_tool_calls_reserved AS tools FROM sessions WHERE id='root'`).get(),
      artifacts: sql.prepare("SELECT COUNT(*) AS n FROM artifacts").get(),
      launches: h.sent.length,
    });
    const before = JSON.stringify(state());
    const store = h.db.createWorkflowArtifactBytes;
    for (const [label, images, status, error, failStorage] of [
      ["invalid bytes after a stored image", [valid, { mimeType: "image/png", data: Buffer.from("not a png").toString("base64") }],
        400, /do not match the declared MIME type/u, false],
      ["unsupported image for the driver", [{ mimeType: "image/bmp", data: png.toString("base64") }], 400, /./u, false],
      ["missing prompt-image artifact", [valid, { artifactId: "art_missing", mimeType: "image/png", sizeBytes: png.byteLength, sha256 }],
        404, /prompt image artifact not found/u, false],
      ["artifact owned by another session", [{ artifactId: "art_root", mimeType: "image/png", sizeBytes: png.byteLength, sha256 }],
        404, /prompt image artifact not found/u, false],
      ["artifact storage failure", [valid], 500, /could not be stored/u, true],
    ] as const) {
      if (failStorage) h.db.createWorkflowArtifactBytes = () => { throw new Error("SQLITE_FULL: artifact write failed"); };
      const refused = create([...images]);
      h.db.createWorkflowArtifactBytes = store;
      assert.equal(refused.status, status, `${label}: ${refused.error}`);
      assert.match(refused.error ?? "", error, label);
      assert.equal(JSON.stringify(state()), before, `${label}: creation released everything it reserved`);
    }
    const retried = create([valid]);
    assert.ok(retried.ok && retried.data, retried.error ?? "retry refused");
    assert.ok(h.sent.slice(JSON.parse(before).launches).some((item) => (item as { type?: string; spec?: { sessionId?: string } }).type === "start_session" &&
      (item as { spec: { sessionId: string } }).spec.sessionId === retried.data!.id), "the retry's launch is sent");
    // A launched child keeps its reservation when deleted (#1496).
    const reservation = () => { const { occupied, members, parent } = state(); return JSON.stringify({ occupied, members, parent }); };
    const launched = reservation();
    assert.notEqual(launched, JSON.stringify({ occupied: 0, members: [], parent: JSON.parse(before).parent }));
    assert.ok(h.svc.delete(retried.data.id).ok);
    assert.equal(reservation(), launched, "deleting a launched child keeps its reservation");
  } finally { h.db.close(); }
});

test("deleting an unlaunched grandchild returns every ancestor's charge and refuses a launched session (#3183)", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ toolCalls: 120, concurrency: 2 })).ok);
    h.make("worker", "root", { maxToolCalls: 4 });
    const sql = (h.db as unknown as { db: { prepare(query: string): { get(): unknown } } }).db;
    const state = () => JSON.stringify({
      members: h.db.campaignBudgets.members("root").sort(),
      root: sql.prepare(`SELECT child_spawn_count AS spawned, child_cost_reserved_usd AS cost,
        child_tool_calls_reserved AS tools FROM sessions WHERE id='root'`).get(),
      worker: sql.prepare(`SELECT child_spawn_count AS spawned, child_cost_reserved_usd AS cost,
        child_tool_calls_reserved AS tools, parent_charged_tool_calls AS charged FROM sessions WHERE id='worker'`).get(),
    });
    const before = state();
    h.db.createSession({ id: "grandchild", parentSessionId: "worker", runnerId: "r", workspaceId: "w", agentId: "claude",
      title: "grandchild", useWorktree: false, creationActor: "agent", driver: "claude-code",
      config: { model: "claude-opus-5-5", maxToolCalls: 10 }, now: 5 });
    // The grandchild's charge exceeds the worker's own reservation, so it reaches the root too.
    assert.equal((JSON.parse(state()).root as { tools: number }).tools, (JSON.parse(before).root as { tools: number }).tools + 6);
    h.db.deleteUnlaunchedSession("grandchild");
    assert.equal(state(), before);
    assert.equal(h.db.getSession("grandchild"), null);
    assert.throws(() => h.db.deleteUnlaunchedSession("worker"), /launch was never sent/u);
    assert.ok(h.db.getSession("worker"), "a launched session is left in place");
    // Inside an outer transaction that rolls back, the rows return and so must their blobs.
    h.db.createSession({ id: "nested", parentSessionId: "worker", runnerId: "r", workspaceId: "w", agentId: "claude",
      title: "nested", useWorktree: false, creationActor: "agent", driver: "claude-code",
      config: { model: "claude-opus-5-5", maxToolCalls: 10 }, now: 6 });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    h.db.createWorkflowArtifactBytes({ artifactId: "art_nested", sessionId: "nested", kind: "screenshot", name: "nested-image",
      mimeType: "image/png", encoding: "base64", sizeBytes: png.byteLength, sha256: createHash("sha256").update(png).digest("hex"),
      createdBy: { kind: "system", id: "test" }, metadata: {}, createdAt: 6 }, png);
    assert.throws(() => h.db.campaignBudgetTransaction(() => {
      h.db.deleteUnlaunchedSession("nested");
      throw new Error("outer rollback");
    }), /outer rollback/u);
    assert.ok(h.db.getSession("nested"));
    assert.deepEqual(h.db.readWorkflowArtifactBytes("art_nested"), png);
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

test("a run on a runner without campaign budget admission is refused with the shared sentence and versions (#3457)",()=>{
  const h=harness();
  try {
    assert.ok(h.enable(allowance({costUsd:100})).ok);
    h.db.registerRunner({...h.metadata,runnerId:"older"},10,217);
    // Same campaign Project, so the run reaches the worker gate rather than Location admission.
    h.db.addProjectLocation(h.db.getSession("root")!.projectId!,{runnerId:"older",workspaceId:"w"});
    const members=h.db.campaignBudgets.members("root").length;
    const refused=h.svc.createRun({runnerId:"older",workspaceId:"w",agentIds:["claude"],task:"Implement #2936",config:{model:"claude-opus-5-5"}},{parentSessionId:"root"});
    assert.equal(refused.status,409);
    assert.equal(refused.error,"This machine needs a newer runner for campaign run workers. Update and restart the runner.");
    assert.deepEqual(refused.capabilityRequirement,{requiredRunnerProtocolVersion:218,runnerProtocolVersion:217});
    assert.equal(h.db.campaignBudgets.members("root").length,members,"a refused run leaves no reservation");
    assert.equal(h.sent.some((m)=>(m as {type?:string}).type==="start_session"),false);
  } finally {h.db.close();}
});

test("a campaign with limits on a downgraded runner refuses with the shared sentence and versions (#3803)",()=>{
  const h=harness();
  try {
    assert.ok(h.enable(allowance({costUsd:100})).ok);
    h.db.registerRunner(h.metadata,10,217);
    const error="This machine needs a newer runner for campaign limits. Update and restart the runner.";
    const versions={requiredRunnerProtocolVersion:218,runnerProtocolVersion:217};
    const child=h.svc.createSession({runnerId:"r",workspaceId:"w",agentId:"claude",config:{model:"claude-opus-5-5"},prompt:"Implement authorized #2936"},
      undefined,undefined,false,false,false,{parentSessionId:"root"});
    const run=h.svc.createRun({runnerId:"r",workspaceId:"w",agentIds:["claude"],task:"Implement #2936",config:{model:"claude-opus-5-5"}},{parentSessionId:"root"});
    const prompt=h.svc.prompt("root","continue");
    for (const [label,refused] of [["child",child],["run",run],["prompt",prompt]] as const) {
      assert.equal(refused.status,409,label);
      assert.equal(refused.error,error,label);
      assert.deepEqual(refused.capabilityRequirement,versions,label);
    }
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
    // The Human's next explicit grant resumes the allowance that Human revoked (#2940), never refunding usage.
    assert.ok(h.enable(allowance({ toolCalls: 1000 }), 3).ok);
    assert.equal(h.db.campaignBudgets.view("root")!.state, "active");
    assert.equal(h.db.campaignBudgets.view("root")!.actual.toolCalls, 1);
    h.db.campaignBudgets.stop("root", "exhausted", "Campaign allowance reached; unfinished work remains incomplete.");
    assert.ok(h.svc.setCampaignControl("root", { mode: "custom" }, 4, h.principal).ok);
    assert.equal(h.enable(allowance({ toolCalls: 2000 }), 5).ok, false, "a new grant cannot reset an exhausted ledger");
  } finally { h.db.close(); }
  const old = harness(":memory:", 217);
  try { assert.equal(old.enable().ok, false); } finally { old.db.close(); }
});

test("a worker that runs again under Custom counts against the allowance its Human authorizes again (#2940)", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ toolCalls: 120, concurrency: 1 })).ok);
    h.make("worker", "root", { maxToolCalls: 40 });
    h.db.updateSessionStatus("worker", "completed", 4);
    const settled = h.db.campaignBudgets.dispatch("worker")!.generation;
    h.db.campaignBudgets.recordCheckpoint("worker", { generation: settled, historyEpoch: 0, throughSeq: 0, costUsd: 0 });
    assert.ok(h.db.campaignBudgets.settleCheckpoint("worker", { historyEpoch: 0, hydratedSeq: 0 }));
    assert.equal(h.db.campaignBudgets.active("worker"), false);
    assert.ok(h.svc.setCampaignControl("root", { mode: "custom" }, 2, h.principal).ok);
    const restarted = h.svc.restart("worker");
    assert.ok(restarted.ok, restarted.error ?? "restart under Custom");
    assert.equal(h.db.campaignBudgets.active("worker"), false, "Custom admits no allowance");

    assert.ok(h.enable(allowance({ toolCalls: 120, concurrency: 1 }), 3).ok);
    assert.equal(h.db.campaignBudgets.active("worker"), true, "the running worker counts again");
    assert.notEqual(h.db.campaignBudgets.dispatch("worker")!.generation, settled, "with a fresh dispatch generation");
    assert.equal(h.db.campaignBudgets.view("root")!.occupied, 1);
    assert.throws(() => h.make("second", "root", { maxToolCalls: 10 }), /concurrency/);
  } finally { h.db.close(); }
});

test("a session limit the person lowers under Custom survives authorizing the allowance again (#2940)", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ toolCalls: 120, concurrency: 2 })).ok);
    h.make("worker", "root", { maxToolCalls: 40 });
    assert.equal(h.db.campaignBudgets.allocation("worker")!.toolCalls, 40);
    assert.ok(h.svc.setCampaignControl("root", { mode: "custom" }, 2, h.principal).ok);
    const lowered = h.svc.setConfig("worker", { maxToolCalls: 5 });
    assert.ok(lowered.ok, lowered.error ?? "lower the limit under Custom");
    h.sent.length = 0;

    assert.ok(h.enable(allowance({ toolCalls: 120, concurrency: 2 }), 3).ok);
    assert.equal(h.db.campaignBudgets.allocation("worker")!.toolCalls, 5);
    assert.equal(h.db.campaignBudgets.userLimits("worker")!.maxToolCalls, 5);
    assert.equal(h.db.getSession("worker")!.maxToolCalls, 5);
    const rearmed = h.sent.filter((message) => (message as { type: string; sessionId?: string }).type === "rearm_governance" &&
      (message as { sessionId?: string }).sessionId === "worker") as Array<{ config: { maxToolCalls?: number } }>;
    assert.ok(rearmed.length > 0 && rearmed.every((message) => (message.config.maxToolCalls ?? 0) <= 5), JSON.stringify(rearmed));
    assert.throws(() => h.db.campaignBudgets.admit("root", { sessionId: "worker", toolCalls: 6 }, {}), /tighter/);
  } finally { h.db.close(); }
});

test("an allowance stops governing only when its root's recorded control grants none (#2940)", () => {
  const h = harness();
  try {
    const control = (value: unknown) => {
      const stored = h.db.sessionOrchestratorPolicy("root")!;
      if (value === undefined) delete stored.control; else stored.control = value as typeof stored.control;
      h.db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id='root'").run(JSON.stringify(stored));
    };
    h.db.campaignBudgets.authorize("root", allowance());
    control(undefined);
    assert.equal(h.db.campaignBudgets.governingRoot("root"), "root", "a root with no control record keeps its allowance");
    assert.ok(h.enable().ok);
    assert.equal(h.db.campaignBudgets.governingRoot("root"), "root", "Full Control with an allowance governs");
    assert.ok(h.svc.setCampaignControl("root", { mode: "custom" }, 2, h.principal).ok);
    assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.control, { mode: "custom" }, "revoking records Custom explicitly");
    assert.equal(h.db.campaignBudgets.governingRoot("root"), null, "a revoked-to-Custom allowance never governs");
    assert.equal(h.db.campaignBudgets.admissionError("root"), null);
    assert.ok(h.svc.setCampaignControl("root", { mode: "full_control", objective: "Implement #2936", operations: ["implementation_question"],
      delegatablePolicyIds: [] }, 3, h.principal).ok);
    assert.equal(h.db.campaignBudgets.governingRoot("root"), null, "Full Control authorized without an allowance does not revive it");
  } finally { h.db.close(); }
});

/** An allowance with no personal limits, revoked to Custom, then the root lowered to 5 tool calls (#2940). */
function revokedAndLowered(before?: (h: ReturnType<typeof harness>) => void) {
  const h = harness();
  assert.ok(h.enable(allowance({ toolCalls: 120, concurrency: 2 })).ok);
  before?.(h);
  assert.ok(h.svc.setCampaignControl("root", { mode: "custom" }, 2, h.principal).ok);
  const lowered = h.svc.setConfig("root", { maxToolCalls: 5 });
  assert.ok(lowered.ok, lowered.error ?? "lower the root's limit under Custom");
  assert.equal(h.db.campaignBudgets.userLimits("root")!.maxToolCalls, null, "the retained record has no personal limit");
  return h;
}

test("under Custom, a child's creation is bounded by the parent's current limit, not the revoked allowance's record (#2940)", () => {
  const h = revokedAndLowered();
  try {
    const child = h.svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "claude", config: { model: "claude-opus-5-5", maxToolCalls: 10 },
      prompt: "Implement #2936" }, undefined, undefined, false, false, false, { parentSessionId: "root" });
    assert.ok(child.ok, child.error ?? "child creation");
    assert.ok(child.data!.maxToolCalls != null && child.data!.maxToolCalls <= 5, `creation: ${child.data!.maxToolCalls}`);
  } finally { h.db.close(); }
});

test("under Custom, a batch of children is bounded by the parent's current limit, not the revoked allowance's record (#2940)", () => {
  const h = revokedAndLowered();
  try {
    const run = h.svc.createRun({ runnerId: "r", workspaceId: "w", agentIds: ["claude"], task: "Implement #2936",
      config: { model: "claude-opus-5-5", maxToolCalls: 10 } }, { parentSessionId: "root" });
    assert.ok(run.ok, run.error ?? "batch admission");
    assert.ok(run.data!.sessions.every((member) => member.maxToolCalls != null && member.maxToolCalls <= 5),
      `batch: ${run.data!.sessions.map((member) => member.maxToolCalls).join(",")}`);
  } finally { h.db.close(); }
});

test("under Custom, a child's restart is bounded by the parent's current limit, not the revoked allowance's record (#2940)", () => {
  const h = revokedAndLowered((h) => {
    h.make("worker", "root", { maxToolCalls: 10 });
    h.db.updateSessionStatus("worker", "completed", 4);
  });
  try {
    const restarted = h.svc.restart("worker");
    assert.equal(restarted.ok, false, "restart re-reserves 10 tool calls against a current limit of 5");
    assert.match(restarted.error!, /re-reserves 10 tool calls/);
  } finally { h.db.close(); }
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
    // The final event is not hydrated yet, so the checkpoint is still pending evidence.
    h.db.reconcileRunnerHistory("worker",0,1);
    const checkpoint={generation:h.db.campaignBudgets.dispatch("worker")!.generation,historyEpoch:0,throughSeq:1,costUsd:2};
    h.db.campaignBudgets.recordCheckpoint("worker",checkpoint);
    const before=h.db.campaignBudgets.dispatchState("worker");
    h.hub.sendToRunner=()=>false;
    assert.equal(h.svc.restart("worker").ok,false);
    assert.deepEqual(h.db.campaignBudgets.dispatchState("worker"),before,"a known-unsent dispatch cannot destroy old retirement evidence");
    h.hub.sendToRunner=()=>true;
    h.db.setHydratedSeq("worker",1);
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

test("with no cost ceiling, unpriced usage leaves the campaign running, counting tool calls and admitting work (#2940)", () => {
  const h = harness();
  try {
    assert.ok(h.enable({ version: 1, accounting: "managed_workers_only", unpriced: "stop", concurrency: 2, acceptedFollowUps: 0 }).ok);
    h.make("worker", "root");
    // Settled and live unpriced records, through the real event path.
    h.svc.onSessionEvent("root", { kind: "token_usage", inputTokens: 100, outputTokens: 2, model: "unpriced-model" });
    h.svc.onSessionEvent("worker", liveRequest(100, "unrated-model"));
    h.svc.onSessionEvent("worker", { kind: "token_usage", inputTokens: 100, outputTokens: 2, model: "unpriced-model" });
    for (const id of ["a", "b", "c"]) h.svc.onSessionEvent("worker", { kind: "tool_call", toolCallId: id, title: "Read", status: "completed" });
    const view = h.db.campaignBudgets.view("root")!;
    assert.deepEqual([view.state, view.costAccounting], ["active", "unavailable"], "cost is reported unavailable, never as zero");
    assert.equal(view.actual.toolCalls, 3, "tool calls keep counting");
    assert.deepEqual(view.remaining, { costUsd: null, toolCalls: null });
    assert.equal(h.db.getSession("root")!.status, "running");
    assert.equal(h.db.getSession("worker")!.status, "running");
    assert.ok(h.svc.campaignBudgetWorkerPreflight("root", { kind: "managed", sessionId: "worker" }).ok);
    const child = h.svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "claude", config: { model: "claude-opus-5-5" }, prompt: "Implement authorized #2936" },
      undefined, undefined, false, false, false, { parentSessionId: "root" });
    assert.ok(child.ok, child.error ?? "child admission continues without a cost ceiling");
    // Unpriced final usage settles where no cost ceiling depends on it.
    h.db.updateSessionStatus("worker", "completed", 7);
    h.db.campaignBudgets.recordCheckpoint("worker", { generation: h.db.campaignBudgets.dispatch("worker")!.generation, historyEpoch: 0, throughSeq: 0, costUsd: 0 });
    assert.ok(h.db.campaignBudgets.settleCheckpoint("worker", { historyEpoch: 0, hydratedSeq: 0 }));
    assert.equal(h.db.campaignBudgets.view("root")!.state, "active");
  } finally { h.db.close(); }
});

test("a deleted unpriced worker leaves the campaign's cost unavailable, its tool calls recorded and the campaign running (#2940)", () => {
  const unbounded: CampaignBudgetAuthority = { version: 1, accounting: "managed_workers_only", unpriced: "stop", concurrency: 2, acceptedFollowUps: 0 };
  for (const path of ["service", "storage"] as const) {
    const h = harness();
    try {
      assert.ok(h.enable(unbounded).ok);
      h.make("worker", "root");
      h.usage("root", 1);
      const unpriced: SessionEventPayload = { kind: "token_usage", inputTokens: 100, outputTokens: 2, model: "unpriced-model" };
      if (path === "service") {
        h.svc.onSessionEvent("worker", unpriced);
        for (const id of ["a", "b"]) h.svc.onSessionEvent("worker", { kind: "tool_call", toolCallId: id, title: "Read", status: "completed" });
        assert.equal(h.db.campaignBudgets.view("root")!.costAccounting, "unavailable");
      } else {
        // Written straight to storage, so no view runs before the deletion: the marker alone must hold it.
        h.db.appendEvent("worker", unpriced, 5, { accrueUsage: true });
        h.tool("worker", "a"); h.tool("worker", "b");
      }
      h.db.updateSessionStatus("worker", "completed", 7);
      h.db.deleteSession("worker");
      assert.equal(h.db.getSession("worker"), null);
      const view = h.db.campaignBudgets.view("root")!;
      assert.deepEqual([view.state, view.costAccounting], ["active", "unavailable"], `${path}: deletion never makes unknown cost read as priced`);
      assert.equal(view.actual.toolCalls, 2, `${path}: the deleted worker's tool calls stay recorded`);
    } finally { h.db.close(); }
  }
});

test("under a cost ceiling, unpriced usage of a worker deleted before any read still stops protected admission", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ costUsd: 100 })).ok);
    h.make("worker", "root");
    h.db.appendEvent("worker", { kind: "token_usage", inputTokens: 100, outputTokens: 2, model: "unpriced-model" }, 5, { accrueUsage: true });
    h.db.updateSessionStatus("worker", "completed", 7);
    h.db.deleteSession("worker");
    assert.deepEqual([h.db.campaignBudgets.view("root")!.state, h.db.campaignBudgets.view("root")!.costAccounting], ["accounting_unavailable", "unavailable"]);
  } finally { h.db.close(); }
});

test("with only a tool-call ceiling, unpriced usage keeps the campaign running until that ceiling is reached (#2940)", () => {
  const h = harness();
  try {
    assert.ok(h.enable({ version: 1, accounting: "managed_workers_only", unpriced: "stop", toolCalls: 3, concurrency: 2, acceptedFollowUps: 0 }).ok);
    h.svc.onSessionEvent("root", { kind: "token_usage", inputTokens: 100, outputTokens: 2, model: "unpriced-model" });
    h.svc.onSessionEvent("root", { kind: "tool_call", toolCallId: "a", title: "Read", status: "completed" });
    assert.deepEqual([h.db.campaignBudgets.view("root")!.state, h.db.campaignBudgets.view("root")!.costAccounting], ["active", "unavailable"]);
    for (const id of ["b", "c"]) h.svc.onSessionEvent("root", { kind: "tool_call", toolCallId: id, title: "Read", status: "completed" });
    assert.equal(h.db.campaignBudgets.view("root")!.state, "exhausted", "the tool-call ceiling is still enforced");
    assert.equal(h.svc.campaignBudgetWorkerPreflight("root", { kind: "managed", sessionId: "root" }).ok, false);
    const child = h.svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "claude", config: { model: "claude-opus-5-5" }, prompt: "Implement authorized #2936" },
      undefined, undefined, false, false, false, { parentSessionId: "root" });
    assert.equal(child.ok, false, "an exhausted ceiling refuses admission");
  } finally { h.db.close(); }
});

test("with a cost ceiling, unpriced final usage still stops protected admission and retains the reservation", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ costUsd: 100 })).ok);
    h.make("worker", "root");
    h.db.updateSessionStatus("worker", "completed", 7);
    h.db.appendEvent("worker", { kind: "token_usage", inputTokens: 100, outputTokens: 2, model: "unpriced-model" }, 6, { accrueUsage: true });
    h.db.campaignBudgets.recordCheckpoint("worker", { generation: h.db.campaignBudgets.dispatch("worker")!.generation, historyEpoch: 0, throughSeq: 0, costUsd: 0 });
    assert.equal(h.db.campaignBudgets.settleCheckpoint("worker", { historyEpoch: 0, hydratedSeq: 0 }), false);
    assert.equal(h.db.campaignBudgets.view("root")!.state, "accounting_unavailable");
  } finally { h.db.close(); }
});

/** A running Claude turn's completed request, priced live at the fixture's $0.000001 per token. */
const liveRequest = (inputTokens: number, model = "claude-opus-5-5"): SessionEventPayload =>
  ({ kind: "token_usage", model, inputTokens, outputTokens: 0, pricingContext: { requestInputTokens: inputTokens }, liveUsage: "provisional" });
const settledTurn = (inputTokens: number, costUsd: number): SessionEventPayload =>
  ({ kind: "token_usage", model: "claude-opus-5-5", inputTokens, outputTokens: 0, costUsd, liveUsage: "settled" });

test("running turns' live estimates exhaust the campaign mid-turn and refuse new children; settlement books provider totals (#3196)", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ costUsd: 1, concurrency: 1 })).ok);
    h.make("worker", "root");
    const before = h.db.campaignBudgets.view("root")!;
    assert.equal(before.actual.costUsd, 0);

    h.svc.onSessionEvent("worker", liveRequest(100_000));
    let view = h.db.campaignBudgets.view("root")!;
    assert.equal(view.state, "active");
    assert.deepEqual(view.actual, { costUsd: 0.1, toolCalls: 0, includesEstimate: true });
    assert.equal(view.remaining.costUsd, before.remaining.costUsd, "an estimate inside its allocation is not reserved twice");
    assert.equal(h.db.getSession("worker")!.costUsd, 0, "the estimate is never accrued");

    h.svc.onSessionEvent("root", liveRequest(1_000_000));
    view = h.db.campaignBudgets.view("root")!;
    assert.equal(view.state, "exhausted", "the estimate alone crosses the campaign allowance");
    assert.deepEqual([h.db.getSession("root")!.status, h.db.getSession("worker")!.status], ["stopped", "stopped"],
      "protected workers stop mid-turn");
    assert.ok(h.logs.some((line) => JSON.parse(line).event === "campaign_budget_admission_stopped"));
    const child = h.svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "claude", config: { model: "claude-opus-5-5" }, prompt: "Implement authorized #2936" },
      undefined, undefined, false, false, false, { parentSessionId: "root" });
    assert.equal(child.ok, false, "child admission is refused");

    // The stopped turns settle lower than their estimates. Only the provider totals accrue.
    h.svc.onSessionEvent("worker", settledTurn(100_000, 0.05));
    h.svc.onSessionEvent("root", settledTurn(1_000_000, 0.6));
    view = h.db.campaignBudgets.view("root")!;
    assert.deepEqual(view.actual, { costUsd: 0.65, toolCalls: 0 }, "settled totals replace the estimates, once each");
    assert.equal(view.state, "exhausted", "a trip on the estimate stays tripped, like any exhausted allowance");
  } finally { h.db.close(); }
});

test("authorizing protection during a running turn sizes allocations above its live estimate (#3196)", () => {
  const h = harness();
  try {
    h.svc.onSessionEvent("root", liveRequest(40_000_000));
    assert.ok(h.enable(allowance({ costUsd: 100, concurrency: 1 })).ok);
    const allocation = h.db.campaignBudgets.allocation("root")!.costUsd!;
    assert.ok(allocation > 40, `the $${allocation} allocation leaves room past the $40 already estimated`);
    assert.equal(h.db.campaignBudgets.admissionError("root"), null);
    h.svc.onSessionEvent("root", liveRequest(1_000_000));
    assert.equal(h.db.getSession("root")!.status, "running", "the next request does not stop the root");
    assert.equal(h.db.campaignBudgets.view("root")!.state, "active");
  } finally { h.db.close(); }
});

test("an open live window that survives the upgrade adding its timestamp still counts toward today (#3196)", () => {
  const dir = mkdtempSync(join(tmpdir(), "live-observed-"));
  const path = join(dir, "cp.sqlite");
  try {
    const h = harness(path);
    h.svc.onSessionEvent("root", liveRequest(10_000));
    const owner = [h.principal.organizationId, h.principal.userId] as const;
    assert.equal(h.db.ownerLiveCostUsd(...owner), 0.01);
    h.db.raw().prepare("UPDATE sessions SET live_observed_at=NULL").run();
    assert.equal(h.db.ownerLiveCostUsd(...owner), 0, "as a window opened before the column existed");
    h.db.close();
    const reopened = ControlPlaneDb.open(path);
    try {
      assert.equal(reopened.ownerLiveCostUsd(...owner), 0.01, "the migration backfills it from its last provisional request");
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rounding a live estimate never manufactures spend beyond the reservations it moves (#3196)", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ costUsd: 10, concurrency: 1 })).ok);
    assert.ok(h.svc.allocateCampaignBudget("root", { sessionId: "root", costUsd: 10 }).ok);
    // $0.1000015 at the fixture's $0.000001 per token, split so the stored sum is not a micro-USD multiple.
    h.svc.onSessionEvent("root", liveRequest(100_000));
    h.db.raw().prepare("UPDATE sessions SET live_cost_usd=live_cost_usd+0.0000015 WHERE id='root'").run();
    const view = h.db.campaignBudgets.view("root")!;
    assert.equal(view.actual.costUsd + view.outstanding.costUsd, 10, "spend plus reservations is still the allocation");
    assert.ok(h.enable(allowance({ costUsd: 10, concurrency: 1 }), 2).ok, "the same human grant is still accepted");
  } finally { h.db.close(); }
});

test("a worker whose live estimate reaches its allocation stops, as a settled crossing does (#3196)", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ costUsd: 10 })).ok);
    h.make("worker", "root", { costBudgetUsd: 0.5 });
    assert.equal(h.db.campaignBudgets.allocation("worker")!.costUsd, 0.5);
    h.svc.onSessionEvent("worker", liveRequest(400_000));
    assert.equal(h.db.getSession("worker")!.status, "running");
    h.svc.onSessionEvent("worker", liveRequest(100_000));
    assert.equal(h.db.getSession("worker")!.status, "stopped", "$0.50 estimated reaches the $0.50 allocation");
    assert.equal(h.db.campaignBudgets.view("root")!.state, "active", "the campaign allowance is not reached");
    assert.equal(h.db.getSession("root")!.status, "running");
  } finally { h.db.close(); }
});

test("live tokens without a rate stop protected admission rather than reading as free (#3196)", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ costUsd: 100 })).ok);
    h.svc.onSessionEvent("root", liveRequest(100, "unrated-model"));
    const view = h.db.campaignBudgets.view("root")!;
    assert.deepEqual([view.state, view.costAccounting], ["accounting_unavailable", "unavailable"]);
    assert.equal(h.db.getSession("root")!.status, "stopped");
  } finally { h.db.close(); }
});

test("a stream without live records, as from a peer before v216, keeps the campaign gate on settled cost (#3196)", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance({ costUsd: 1 })).ok);
    const turn = [liveRequest(1_000_000), settledTurn(1_000_000, 1.2)].map((payload) => projectSessionEventPayloadForProtocol(payload, 215));
    assert.equal(turn[0], null, "an older peer never receives provisional records");
    assert.equal(h.db.campaignBudgets.view("root")!.state, "active");
    h.svc.onSessionEvent("root", turn[1]!);
    const view = h.db.campaignBudgets.view("root")!;
    assert.deepEqual([view.state, view.actual], ["exhausted", { costUsd: 1.2, toolCalls: 0 }]);
  } finally { h.db.close(); }
});

test("cancellation retains reservations until runner settlement; late spend still counts", () => {
  const h = harness();
  try {
    assert.ok(h.enable(allowance()).ok);
    h.make("worker", "root", { maxToolCalls: 20 });
    assert.ok(h.svc.stop("worker").ok);
    assert.equal(h.db.campaignBudgets.view("root")!.occupied, 1);
    const reserved = h.db.campaignBudgets.view("root")!.outstanding.toolCalls;
    h.svc.onSessionStatus("worker", "stopped");
    // A runner reports `stopped` while its provider still closes: status alone proves neither
    // retirement nor final usage (#2940).
    assert.equal(h.db.campaignBudgets.view("root")!.occupied, 1, "status alone does not prove provider retirement");
    assert.equal(h.db.campaignBudgets.view("root")!.outstanding.toolCalls, reserved, "status alone does not prove final usage");
    h.tool("worker", "late");
    assert.equal(h.db.campaignBudgets.view("root")!.actual.toolCalls, 1);
    const generation = h.db.campaignBudgets.dispatch("worker")!.generation;
    h.db.campaignBudgets.recordCheckpoint("worker", { generation, historyEpoch: 0, throughSeq: 2, costUsd: 0 });
    // The retired runner's final checkpoint frees the slot; the reservation waits for its history.
    assert.equal(h.db.campaignBudgets.view("root")!.occupied, 0, "the final checkpoint proves retirement");
    assert.equal(h.db.campaignBudgets.settleCheckpoint("worker", { historyEpoch: 0, hydratedSeq: 1 }), false);
    assert.equal(h.db.campaignBudgets.active("worker"), true, "the reservation stays until settlement");
    assert.ok(h.db.campaignBudgets.settleCheckpoint("worker", { historyEpoch: 0, hydratedSeq: 2 }));
    assert.equal(h.db.campaignBudgets.view("root")!.occupied, 0);
    assert.equal(h.db.campaignBudgets.view("root")!.outstanding.toolCalls, reserved - 20, "settlement releases the unspent reservation");
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

test("with no campaign ceiling, controlled review still reserves each job's own bound and meters its usage",()=>{
  const h=harness();
  try {
    const profile={profile:"native_opus_5_5_high_read_only",controllerSha256:"a".repeat(64),executableSha256:"b".repeat(64),cliVersion:"2.1.296",accounting:"provider_list_estimate",account:"runner_default_claude",agentId:"claude"} as const;
    const grant:CampaignBudgetAuthority={version:1,accounting:"managed_workers_only",unpriced:"stop",concurrency:2,acceptedFollowUps:0,controlledReview:profile};
    assert.ok(validCampaignBudgetAuthority(grant),"no cost or tool-call ceiling is a valid controlled-review envelope");
    assert.equal(validCampaignBudgetAuthority({...grant,concurrency:undefined}),false,"controlled review still needs a concurrency limit");
    h.metadata.runtime={dataDir:"/runner",worktreeRoot:"/runner/worktrees",maxConcurrentSessions:4,campaignReview:profile};
    h.db.registerRunner(h.metadata,10,PROTOCOL_VERSION);
    assert.ok(h.enable(grant).ok);
    h.make("worker","root");h.db.setWorktreePath("worker","/runner/worktrees/worker");
    const plan=h.svc.recordCampaignPlan("root",{planComplete:true,items:[{key:"picoduck/wollipog#2936",issue:{repository:"picoduck/wollipog",number:2936}}]});
    assert.ok(plan.ok,plan.error??"plan refused");
    const workItemId=plan.data!.items[0]!.workItemId;
    assert.ok(h.svc.assignCampaignWorkItem("root",{workItemId,childSessionId:"worker"}).ok);
    assert.ok(h.svc.updateCampaignWorkItem("root",{workItemId,stage:{stage:"in_review",pullRequests:[{repository:"picoduck/wollipog",number:3065}]}}).ok);
    const result=h.svc.requestCampaignReviewJob("root",{requestId:"unbounded",workItemId,pullRequest:{repository:"picoduck/wollipog",number:3065},
      baseSha:"a".repeat(40),headSha:"b".repeat(40),costUsd:5,toolCalls:20,brief:"Review the exact head."});
    assert.ok(result.ok,result.error??"review refused");
    assert.deepEqual(h.db.campaignBudgets.allocation(result.data!.jobId),{sessionId:result.data!.jobId,costUsd:5,toolCalls:20},"the job's own bound is reserved");
    const command=h.db.campaignReviewJobs.command(result.data!.jobId)!;
    h.svc.onCampaignReviewJobUpdate("r",{type:"campaign_review_job_update",jobId:command.jobId,nonce:command.nonce,state:"completed",costUsd:2,toolCalls:3,attemptValid:true,attemptConsumed:true,vote:"UPVOTE",receiptSha256:"c".repeat(64),report:"UPVOTE"});
    const view=h.db.campaignBudgets.view("root")!;
    assert.equal(view.state,"active");
    assert.deepEqual(view.remaining,{costUsd:null,toolCalls:null});
    assert.ok(view.actual.costUsd>=2,"the review's usage is metered against the unbounded campaign");
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

test("a review-required campaign refuses child ceilings at creation, so every admitted child can get its review (#2940)",()=>{
  const h=harness();
  try {
    const profile={profile:"native_opus_5_5_high_read_only",controllerSha256:"a".repeat(64),executableSha256:"b".repeat(64),cliVersion:"2.1.296",accounting:"provider_list_estimate",account:"runner_default_claude",agentId:"claude"} as const;
    h.metadata.runtime={dataDir:"/runner",worktreeRoot:"/runner/worktrees",maxConcurrentSessions:4,campaignReview:profile};
    h.db.registerRunner(h.metadata,10,PROTOCOL_VERSION);
    assert.ok(h.enable(allowance({costUsd:100,toolCalls:1000,controlledReview:profile})).ok);
    const child=(config:{costBudgetUsd?:number;maxToolCalls?:number})=>h.svc.createSession({runnerId:"r",workspaceId:"w",agentId:"claude",
      config:{model:"claude-opus-5-5",...config},prompt:"Implement authorized #2936"},undefined,undefined,false,false,false,{parentSessionId:"root"});
    const members=()=>h.db.campaignBudgets.members("root").length;
    const before=members();
    for (const ceiling of [{costBudgetUsd:5},{maxToolCalls:30},{costBudgetUsd:5,maxToolCalls:30}]) {
      const refused=child(ceiling);
      assert.equal(refused.ok,false,JSON.stringify(ceiling));
      assert.equal(refused.status,409);
      assert.match(refused.error!,/controlled cross-model review, which cannot run under a per-session cost or tool-call limit/);
      assert.match(refused.error!,/without costBudgetUsd or maxToolCalls/);
    }
    assert.equal(members(),before,"a refused child leaves no reservation");
    const runRefused=h.svc.createRun({runnerId:"r",workspaceId:"w",agentIds:["claude"],task:"Implement #2936",config:{model:"claude-opus-5-5",costBudgetUsd:5}},{parentSessionId:"root"});
    assert.equal(runRefused.ok,false,"run workers follow the same rule");

    // Project child-session defaults would become the same ceiling; they are refused with the same reason.
    const project=h.db.createProject({name:"Ceilings",scope:{organizationId:h.principal.organizationId,owner:{kind:"organization",organizationId:h.principal.organizationId}}});
    const location=h.db.addProjectLocation(project.id,{runnerId:"r",workspaceId:"w"});
    h.db.setSessionProject("root",project.id,location.id);
    h.db.updateProject(project.id,{childSessionDefaults:{costBudgetUsd:5,maxToolCalls:30}});
    const projectRefused=child({});
    assert.equal(projectRefused.ok,false);
    assert.match(projectRefused.error!,/clear them for this campaign's Project/);
    h.db.updateProject(project.id,{childSessionDefaults:null});

    const admitted=child({});
    assert.ok(admitted.ok,admitted.error??"an unconstrained child is admitted");
    const worker=admitted.data!.id;
    assert.deepEqual(h.db.campaignBudgets.userLimits(worker),{costBudgetUsd:null,maxToolCalls:null});
    h.db.updateSessionStatus(worker,"running",5);
    h.db.setWorktreePath(worker,"/runner/worktrees/worker");
    const plan=h.svc.recordCampaignPlan("root",{planComplete:true,items:[{key:"picoduck/wollipog#2936",issue:{repository:"picoduck/wollipog",number:2936}}]});
    assert.ok(plan.ok,plan.error??"plan refused");
    const workItemId=plan.data!.items[0]!.workItemId;
    assert.ok(h.svc.assignCampaignWorkItem("root",{workItemId,childSessionId:worker}).ok);
    assert.ok(h.svc.updateCampaignWorkItem("root",{workItemId,stage:{stage:"in_review",pullRequests:[{repository:"picoduck/wollipog",number:3065}]}}).ok);
    const review=h.svc.requestCampaignReviewJob("root",{requestId:"child-review",workItemId,pullRequest:{repository:"picoduck/wollipog",number:3065},
      baseSha:"a".repeat(40),headSha:"b".repeat(40),costUsd:5,toolCalls:20,brief:"Review the exact head."});
    assert.ok(review.ok,review.error??"the admitted child's required review is admissible");
  } finally {h.db.close();}
});

test("campaigns without required controlled review keep accepting child ceilings",()=>{
  const h=harness();
  try {
    assert.ok(h.enable(allowance({costUsd:100,toolCalls:1000})).ok);
    const result=h.svc.createSession({runnerId:"r",workspaceId:"w",agentId:"claude",config:{model:"claude-opus-5-5",costBudgetUsd:5,maxToolCalls:30},
      prompt:"Implement authorized #2936"},undefined,undefined,false,false,false,{parentSessionId:"root"});
    assert.ok(result.ok,result.error??"ceilings remain valid without required review");
  } finally {h.db.close();}
});
