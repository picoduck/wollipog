import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, PROTOCOL_VERSION, type CampaignLaunchProposal, type CreateSessionRequest } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { OrchestratorSettings, resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { authorizeFullControl } from "./campaign-authority.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import { registerFullControlLaunchRoutes } from "./full-control-launch-route.js";

const proposal: CampaignLaunchProposal = { repository: "owner/repo", issueNumbers: [12], objective: "Deliver #12",
  operations: ["implementation_question", "pr_merge"], delegatablePolicyIds: [],
  issueAuthority: { epics: [12], relatedFollowUps: false, maxIssues: 10, closureReasons: ["completed"] },
  budgetAuthority: { version: 1, costUsd: 20, toolCalls: 200, concurrency: 2, acceptedFollowUps: 0,
    accounting: "managed_workers_only", unpriced: "stop" } };
const request: CreateSessionRequest = { runnerId: "r", workspaceId: "w", projectId: null, projectLocationId: null,
  agentId: "claude", role: "orchestrator", config: { model: "claude-opus-5-5", permissionMode: "orchestrator", costBudgetUsd: 50, maxToolCalls: 500 } };

function fixture() {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const human: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId };
  db.registerRunner({ runnerId: "r", hostname: "fixture", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Fixture Repo", path: "/fixture/repository" }],
    agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", context: { kind: "native" }, available: true,
      capabilities: { models: [{ id: "claude-opus-5-5", default: true }], effortLevels: [], slashCommands: [],
        permissionModes: ["default", "orchestrator"], supportsImages: true, supportsApprovals: true } }] }, Date.now(), PROTOCOL_VERSION);
  db.setUsageRateTable(new Map([["claude-opus-5-5", { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001,
    cacheReadCostPerToken: 0.000001, cacheCreationCostPerToken: 0.000001 }]])); // Fixture pricing only.
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  const starts: unknown[] = [];
  hub.sendToRunner = (_, message) => { starts.push(message); return true; };
  const sessions = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const scope = { organizationId: human.organizationId, owner: { kind: "user" as const, userId: human.userId } };
  const settings = new OrchestratorSettings(db);
  return { db, hub, starts, sessions, human, scope, settings };
}

test("Human-only preflight shares normalized launch validation without writes and production admission stays blocked", async () => {
  const f = fixture();
  const logs: string[] = [];
  const app = Fastify({ logger: { level: "info", stream: { write(line: string) { logs.push(line); } } } });
  const agent: AuthPrincipal = { kind: "agent", actorId: "fixture-agent", organizationId: f.human.organizationId, delegatedScope: f.scope };
  registerFullControlLaunchRoutes(app, { ...f, requestPrincipal: (req) => req.headers.authorization === "Bearer human" ? f.human
    : req.headers.authorization === "Bearer agent" ? agent : null });
  try {
    const body = { session: request, proposal };
    const before = f.db.raw().prepare("SELECT total_changes() AS n").get()!.n;
    const preview = await app.inject({ method: "POST", url: "/api/full-control-campaigns/preflight", headers: { authorization: "Bearer human" }, payload: body });
    assert.equal(preview.statusCode, 200, preview.body);
    const { preflight } = preview.json();
    assert.equal(preflight.supported, false);
    assert.equal(preflight.plan.config.model, request.config!.model);
    assert.equal(preflight.plan.config.permissionMode, "orchestrator");
    assert.equal(preflight.plan.policy.behavior.completion, DEFAULT_ORCHESTRATOR_DEFAULTS.behavior.completion);
    assert.equal(f.db.raw().prepare("SELECT total_changes() AS n").get()!.n, before, "preparation performs no SQL writes");
    assert.equal(preview.headers["cache-control"], "private, no-store");
    for (const auth of [undefined, "Bearer agent"]) {
      assert.equal((await app.inject({ method: "POST", url: "/api/full-control-campaigns", headers: auth ? { authorization: auth } : {},
        payload: { ...body, requestId: "launch-1", preflightDigest: preflight.digest } })).statusCode, 403);
    }
    const admit = await app.inject({ method: "POST", url: "/api/full-control-campaigns", headers: { authorization: "Bearer human" },
      payload: { ...body, requestId: "launch-1", preflightDigest: preflight.digest } });
    assert.equal(admit.statusCode, 409);
    assert.match(admit.json().error, /blocked until every mandatory/);
    assert.deepEqual(f.starts, []);
    assert.equal(f.db.raw().prepare("SELECT count(*) AS n FROM sessions").get()!.n, 0);
    assert.equal(f.db.raw().prepare("SELECT count(*) AS n FROM human_campaign_launches").get()!.n, 0);
    const injected = await app.inject({ method: "POST", url: "/api/full-control-campaigns/preflight", headers: { authorization: "Bearer human" },
      payload: { ...body, proposal: { ...proposal, authorizedByUserId: "injected" } } });
    assert.equal(injected.statusCode, 400);
    const event = logs.map((line) => JSON.parse(line)).find((entry) => entry.event === "full_control_launch_preflight");
    assert.equal(event.entryPoint, "human_launch_preflight");
    assert.equal(event.supported, false);
    assert.ok(event.requestId);
    assert.equal(typeof event.durationMs, "number");
    assert.ok(event.missingCapabilities.includes("Complete Execution Enforcement"));
    assert.doesNotMatch(logs.join("\n"), /Deliver #12|Bearer human|authorizedByUserId/);
  } finally { await app.close(); f.db.close(); }
});

test("fixture Human atomic admission commits scope/control/budget before its one provider start and never replays", () => {
  const f = fixture();
  try {
    const issueScope = { repository: proposal.repository, issueNumbers: [12], revision: 1, authorizedByUserId: f.human.userId, authorizedAt: 1 };
    const control = authorizeFullControl(f.human, issueScope, proposal, 1, 1)!;
    assert.equal(control.mode, "full_control");
    if (control.mode !== "full_control") throw new Error("fixture Full control expected");
    let starts = 0;
    f.hub.sendToRunner = (_, message) => {
      if (message.type !== "start_session") return true;
      starts++;
      assert.equal(f.db.raw().isTransaction, false, "provider start is after COMMIT");
      const root = f.db.getSession(message.spec.sessionId)!;
      assert.deepEqual(root.orchestratorPolicy!.control, control);
      assert.deepEqual(message.spec.orchestrator!.issueNumbers, [12]);
      assert.deepEqual(message.spec.orchestrator!.control, control);
      assert.equal(message.initialPrompt, "Deliver #12");
      const budget = f.db.campaignBudgets.view(root.id)!;
      assert.equal(budget.state, "active");
      assert.equal(budget.sessionLimits!.costBudgetUsd, 50);
      assert.equal(budget.sessionLimits!.maxToolCalls, 500);
      assert.equal(message.spec.config!.costBudgetUsd, budget.rootAllocation!.costUsd);
      assert.ok(message.spec.campaignBudgetDispatch);
      return true;
    };
    const context = { defaultOwnerUserId: f.human.userId, humanCampaignLaunch: { principal: f.human, requestId: "launch-1", digest: "a".repeat(64), control, issueScope } };
    const first = f.sessions.createSession(request, undefined, f.scope, false, false, false, context);
    assert.equal(first.ok, true, first.error ?? "fixture admission succeeded");
    assert.equal(first.data!.parentControlPolicy!.revision, 1);
    assert.equal(starts, 1);
    const repeated = f.sessions.createSession(request, undefined, f.scope, false, false, false, context);
    assert.equal(repeated.ok, true, repeated.error ?? "fixture duplicate read succeeded");
    assert.equal(repeated.data!.id, first.data!.id);
    assert.equal(starts, 1);
    const changed = f.sessions.createSession(request, undefined, f.scope, false, false, false,
      { ...context, humanCampaignLaunch: { ...context.humanCampaignLaunch, digest: "b".repeat(64) } });
    assert.equal(changed.ok, false);
    assert.equal(starts, 1);
  } finally { f.db.close(); }
});

test("an admission failure rolls back the root, scope, allowance and launch identity and sends nothing", () => {
  const f = fixture();
  try {
    const issueScope = { repository: proposal.repository, issueNumbers: [12], revision: 1, authorizedByUserId: f.human.userId, authorizedAt: 1 };
    const control = authorizeFullControl(f.human, issueScope, proposal, 1, 1)!;
    if (control.mode !== "full_control") throw new Error("fixture control expected");
    f.db.raw().exec("CREATE TRIGGER fail_human_launch BEFORE INSERT ON human_campaign_launches BEGIN SELECT RAISE(ABORT,'fixture admission failure'); END");
    const result = f.sessions.createSession(request, undefined, f.scope, false, false, false, {
      defaultOwnerUserId: f.human.userId, humanCampaignLaunch: { principal: f.human, requestId: "launch-1", digest: "a".repeat(64), control, issueScope },
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /fixture admission failure/);
    for (const table of ["sessions", "campaign_budgets", "campaign_budget_members", "human_campaign_launches"]) {
      assert.equal(f.db.raw().prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0, `${table} rolled back`);
    }
    assert.deepEqual(f.starts, []);
  } finally { f.db.close(); }
});

test("uncertain dispatch retains the root reservation and identity without retrying or refunding", () => {
  const f = fixture();
  try {
    const issueScope = { repository: proposal.repository, issueNumbers: [12], revision: 1, authorizedByUserId: f.human.userId, authorizedAt: 1 };
    const control = authorizeFullControl(f.human, issueScope, proposal, 1, 1)!;
    if (control.mode !== "full_control") throw new Error("fixture control expected");
    let sends = 0;
    f.hub.sendToRunner = () => { sends++; return false; };
    const context = { defaultOwnerUserId: f.human.userId, humanCampaignLaunch: {
      principal: f.human, requestId: "launch-1", digest: "a".repeat(64), control, issueScope,
    } };
    const first = f.sessions.createSession(request, undefined, f.scope, true, false, false, context);
    assert.equal(first.ok, false);
    assert.equal(first.errorDetails!.code, "FULL_CONTROL_LAUNCH_RETAINED");
    const id = String(first.errorDetails!.sessionId);
    assert.ok(f.db.getSession(id));
    assert.equal(f.db.campaignBudgets.view(id)!.outstanding.costUsd > 0, true);
    assert.equal(f.db.raw().prepare("SELECT dispatch_state FROM human_campaign_launches").get()!.dispatch_state, "uncertain");
    const again = f.sessions.createSession(request, undefined, f.scope, false, false, false, context);
    assert.equal(again.data!.id, id);
    assert.equal(sends, 1);
    assert.equal(f.db.claimHumanCampaignDispatch(id), false);
  } finally { f.db.close(); }
});
