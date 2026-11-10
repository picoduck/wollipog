import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS, PROTOCOL_VERSION,
  type AutomationSessionRequest, type AutomationSpec, type ControlPlaneToRunner, type RunnerMetadata,
} from "@wollipog/protocol";
import type { AgentPrincipal, HumanPrincipal } from "./identity.js";
import { AutomationCreationService } from "./automation-creation.js";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { OrchestratorSettings } from "./orchestrator-settings.js";
import { AutomationsService, validateAutomationSpec } from "./automations.js";
import { ScheduledCampaignRuntime, scheduledCampaignPrompt } from "./scheduled-campaigns.js";
import { signAutomationTrigger } from "./automation-trigger-ingress.js";

function fixture() {
  const db = ControlPlaneDb.open(":memory:");
  const human: HumanPrincipal = { ...db.localIdentityContext(), kind: "human", actorId: db.localIdentityContext().userId };
  const capabilities = { models: [{ id: "claude-opus-5-5", default: true, efforts: ["high", "medium"] }],
    effortLevels: ["high", "medium"], permissionModes: ["default", "orchestrator"],
    slashCommands: [], supportsImages: true, supportsApprovals: true, orchestratorAdditive: true };
  const meta: RunnerMetadata = { runnerId: "r", hostname: "fixture", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repository", path: "/fixture/repo" }],
    agents: [{ id: "parent", name: "Parent", command: "claude", args: [], env: {}, available: true,
      driver: "claude-code", context: { kind: "native" }, capabilities },
    { id: "child", name: "Child", command: "codex", args: [], env: {}, available: true,
      driver: "codex-app-server", context: { kind: "native" }, capabilities: { ...capabilities,
        models: [{ id: "codex-fixture-model", default: true, efforts: ["high", "medium"] }],
        permissionModes: ["auto-review"] } }],
    runtime: { dataDir: "/fixture/data", worktreeRoot: "/fixture/worktrees", maxConcurrentSessions: 4,
      campaignLaunchInspection: { version: 3 }, executionIsolation: { mode: "provider", network: "inherit" } } };
  db.registerRunner(meta, Date.now(), PROTOCOL_VERSION);
  const rate = { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001, cacheReadCostPerToken: 0.000001, cacheCreationCostPerToken: 0.000001 };
  db.setUsageRateTable(new Map([["claude-opus-5-5", rate], ["codex-fixture-model", rate]]));
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  const sent: ControlPlaneToRunner[] = [];
  let repository = "owner/repo";
  hub.sendToRunner = (runnerId, message) => {
    sent.push(message);
    if (message.type === "campaign_launch_inspect") queueMicrotask(() => hub.resolveRunnerRequest({
      type: "campaign_launch_inspection_result", requestId: message.requestId, workspaceId: message.workspaceId,
      ok: true, repository, issueNumbers: [], digest: "d".repeat(64),
    }, runnerId));
    return true;
  };
  const sessions = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const runtime = new ScheduledCampaignRuntime(db, hub, sessions, new OrchestratorSettings(db));
  const service = new AutomationsService(db, hub, sessions, { info() {}, warn() {} }, undefined, runtime);
  const spec = (mode: "custom" | "full_control" = "full_control"): AutomationSpec => ({
    name: "Daily Campaign", cron: "* * * * *", timezone: "UTC", enabled: true,
    action: { kind: "create_session", request: { runnerId: "r", workspaceId: "w", projectId: null, projectLocationId: null, agentId: "parent", role: "orchestrator",
      prompt: "Review maintenance findings and implement accepted follow-ups.", useWorktree: false,
      config: { model: "claude-opus-5-5", effort: "high", permissionMode: "orchestrator" },
      orchestrator: { behavior: { ...DEFAULT_ORCHESTRATOR_DEFAULTS.behavior, maximumConcurrentChildren: 2, followUps: "execute_approved",
        childHarness: { agentId: "codex-app-server", driver: "codex-app-server", context: { kind: "native" } },
        childModel: "codex-fixture-model", childEffort: "medium" },
        delegation: DEFAULT_ORCHESTRATOR_DEFAULTS.delegation, execution: { strictProjectIsolation: false, integrationIsolation: true } },
      campaign: { controlMode: mode, repository: "owner/repo", tasks: [
        { key: "maintenance", title: "Maintenance", prompt: "Investigate stale flags." },
        { key: "coverage", title: "Coverage", prompt: "Investigate meaningful coverage gaps." },
      ] } } },
    misfirePolicy: { kind: "skip" }, runnerPolicy: { kind: "wait" }, concurrencyPolicy: "wait",
    limits: { maxCostUsd: 20, maxToolCalls: 200 }, notifications: { pushEvents: [] },
  });
  const actor = { kind: "human" as const, id: human.userId };
  const drain = async () => { for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
  return { db, hub, sent, sessions, runtime, service, spec, actor, human, meta, drain,
    changeRepository: (value: string) => { repository = value; } };
}

for (const mode of ["custom", "full_control"] as const) test(`${mode} occurrence atomically creates a campaign, allowance, task ledger and durable command`, async () => {
  const f = fixture();
  try {
    const saved = f.service.create(f.spec(mode), f.actor);
    assert.equal(saved.ok, true, saved.error ?? "Schedule saved");
    f.service.tick(saved.data!.nextFireAt!);
    await f.drain();
    const execution = f.service.get(saved.data!.automationId).data!.executions[0]!;
    assert.notEqual(execution.status, "failed", execution.error ?? "Campaign started");
    const root = f.db.getSession(execution.sessionId!)!;
    assert.equal(root.role, "orchestrator");
    assert.equal(root.model, "claude-opus-5-5");
    assert.equal(root.effort, "high");
    assert.equal(root.orchestratorPolicy!.control?.mode ?? "custom", mode);
    assert.equal(f.db.campaignBudgets.view(root.id)!.authority.costUsd, 20);
    const command = f.db.listAutomationCommands(execution.executionId)[0]!;
    const payload = JSON.parse(command.payloadJson);
    assert.equal(payload.spec.campaignBudgetDispatch.rootSessionId, root.id);
    assert.ok(root.costBudgetUsd! > 0);
    assert.ok(root.maxToolCalls! > 0);
    assert.ok(payload.spec.config.costBudgetUsd > 0);
    assert.ok(payload.spec.config.maxToolCalls > 0);
    f.service.onDurableCommandReceipt("r", { type: "durable_session_command_update", commandId: command.commandId,
      sessionId: root.id, state: "started", revision: 1 }, Date.now());
    assert.match(payload.initialPrompt, /Investigate stale flags/);
    assert.match(payload.initialPrompt, /Investigate meaningful coverage gaps/);
    assert.equal(f.db.raw().prepare("SELECT COUNT(*) AS n FROM campaign_work_items WHERE campaign_session_id=?").get(root.id)!.n, 2);
    // The parent finishing its first planning turn cannot release the automation's overlap lock.
    f.db.updateSessionStatus(root.id, "idle", Date.now());
    f.service.tick(saved.data!.nextFireAt! + 60_000);
    await f.drain();
    assert.equal(f.db.listSessions().length, 1);
    assert.notEqual(f.service.get(saved.data!.automationId).data!.executions.find(e => e.executionId === execution.executionId)!.status, "succeeded");
    f.service.recover();
    await f.drain();
    assert.equal(f.db.listSessions().length, 1, "recovery retains the root and never resets the campaign");
    f.db.updateSessionStatus(root.id, "running", Date.now());
    const item = f.db.raw().prepare("SELECT id FROM campaign_work_items WHERE campaign_session_id=? AND item_key=?").get(root.id, "maintenance");
    assert.ok(item);
    const child = f.sessions.createSession({ runnerId: "r", workspaceId: "w", agentId: "child", prompt: "Investigate stale flags.",
      config: { model: "codex-fixture-model", effort: "medium", permissionMode: "auto-review" }, campaignWorkItemId: String(item.id) },
    undefined, undefined, false, false, false, { parentSessionId: root.id });
    assert.equal(child.ok, true, child.error ?? "Child created");
    assert.equal(child.data!.driver, "codex-app-server");
    assert.equal(child.data!.model, "codex-fixture-model");
    assert.equal(child.data!.effort, "medium");
    assert.equal(f.db.campaignBudgets.governingRoot(child.data!.id), root.id);
    const outstanding = f.db.campaignBudgets.view(root.id)!;
    assert.ok(outstanding.outstanding.costUsd <= 20);
    assert.ok(outstanding.outstanding.toolCalls <= 200);
    f.db.updateSessionStatus(root.id, "stopped", Date.now(), { cause: "guardrail" });
    f.service.tick(saved.data!.nextFireAt! + 120_000);
    await f.drain();
    assert.equal(f.db.listSessions().length, 2, "a stopped root does not release overlap while a child is unfinished");
    assert.equal(f.db.getAutomationExecution(execution.executionId)!.status, "running");
    f.db.updateSessionStatus(root.id, "running", Date.now());
    const wrong = f.sessions.createSession({ runnerId: "r", workspaceId: "w", agentId: "parent", prompt: "Wrong harness" },
      undefined, undefined, false, false, false, { parentSessionId: root.id });
    assert.equal(wrong.ok, false, "Fixed child settings are enforced rather than falling back to the parent harness");
  } finally { f.db.close(); }
});

async function start(f: ReturnType<typeof fixture>, input = f.spec()) {
  const saved = f.service.create(input, f.actor);
  assert.equal(saved.ok, true, saved.error ?? "Schedule created");
  f.service.tick(saved.data!.nextFireAt!);
  await f.drain();
  const execution = f.db.listAutomationExecutions(saved.data!.automationId)[0]!;
  assert.notEqual(execution.status, "failed", execution.error ?? "Campaign started");
  const root = f.db.getSession(execution.sessionId!)!;
  const command = f.db.listAutomationCommands(execution.executionId)[0]!;
  f.db.updateSessionStatus(root.id, "running", Date.now());
  f.service.onDurableCommandReceipt("r", { type: "durable_session_command_update", commandId: command.commandId,
    sessionId: root.id, state: "started", revision: 1 }, execution.createdAt + 1);
  return { saved: saved.data!, execution, root, command };
}

function createChild(f: ReturnType<typeof fixture>, rootId: string) {
  const item = f.db.raw().prepare("SELECT id FROM campaign_work_items WHERE campaign_session_id=? LIMIT 1").get(rootId)!;
  const child = f.sessions.createSession({ runnerId: "r", workspaceId: "w", agentId: "child", prompt: "Investigate stale flags.",
    config: { model: "codex-fixture-model", effort: "medium", permissionMode: "auto-review" }, campaignWorkItemId: String(item.id) },
  undefined, undefined, false, false, false, { parentSessionId: rootId });
  assert.equal(child.ok, true, child.error ?? "Child created");
  return child.data!;
}

test("a validated governance pause holds the campaign overlap lock while a child is unfinished", async t => {
  const f = fixture();
  try {
    const { saved, execution, root, command } = await start(f);
    t.mock.method(Date, "now", () => execution.createdAt + 10);
    createChild(f, root.id);
    const threshold = f.db.getSession(root.id)!.costBudgetUsd!;
    assert.equal(f.sessions.onGovernanceTripped("r", { type: "governance_tripped", sessionId: root.id,
      tripId: "root-allocation", kind: "cost_budget", threshold, observed: threshold + 1, commandId: command.commandId }), true);
    f.service.onGovernanceTripped(root.id, Date.now());
    f.service.onDurableCommandReceipt("r", { type: "durable_session_command_update", commandId: command.commandId,
      sessionId: root.id, state: "failed", revision: 2, error: "provider cancelled" }, Date.now());
    assert.equal(f.db.getSession(root.id)!.status, "input_required");
    assert.equal(f.db.getAutomationCommand(command.commandId)!.state, "rejected", "retain the actual transport outcome");
    // The owner can answer and resume the existing session; its cleared card must not erase
    // the classification of the first command on the next reconnect.
    f.db.setPendingApproval(root.id, null);
    f.db.updateSessionStatus(root.id, "idle", Date.now());
    const restarted = new AutomationsService(f.db, f.hub, f.sessions, { info() {}, warn() {} }, undefined, f.runtime);
    restarted.recover();
    restarted.onDurableCommandReceipt("r", { type: "durable_session_command_update", commandId: command.commandId,
      sessionId: root.id, state: "failed", revision: 3, error: "Service temporarily unavailable, please retry later" }, Date.now());
    assert.equal(f.db.listAutomationCommands(execution.executionId).length, 1, "a pause never creates a replacement launch");
    assert.equal(f.db.getSession(root.id)!.status, "idle");
    f.service.tick(saved.nextFireAt! + 60_000);
    await f.drain();
    assert.equal(f.db.getAutomationExecution(execution.executionId)!.status, "running");
    assert.equal(f.db.listSessions().length, 2, "a waiting root and live child keep one campaign");
  } finally { f.db.close(); }
});

test("terminal-first governance replay keeps its campaign active without replacing the launch", async t => {
  const f = fixture();
  try {
    const saved = f.service.create(f.spec("custom"), f.actor).data!;
    f.service.tick(saved.nextFireAt!);
    await f.drain();
    const execution = f.db.listAutomationExecutions(saved.automationId)[0]!;
    const root = f.db.getSession(execution.sessionId!)!;
    const command = f.db.listAutomationCommands(execution.executionId)[0]!;
    assert.equal(command.startedAt, undefined, "the start receipt was lost");
    t.mock.method(Date, "now", () => execution.createdAt + 10);
    f.db.updateSessionStatus(root.id, "running", Date.now());
    const threshold = root.maxToolCalls!;
    const trip = { type: "governance_tripped" as const, sessionId: root.id, tripId: "terminal-first",
      kind: "max_tool_calls" as const, threshold, observed: threshold + 1, commandId: command.commandId };
    assert.equal(f.db.recordAutomationCampaignCommandPause(command.commandId, trip, Date.now()), false,
      "an unvalidated claim cannot classify a launch");
    assert.equal(f.sessions.onGovernanceTripped("r", trip), true);
    // Reconnect reports the stored trip then the terminal receipt; the original automation
    // callback and its started receipt were both lost.
    const restarted = new AutomationsService(f.db, f.hub, f.sessions, { info() {}, warn() {} }, undefined, f.runtime);
    restarted.onDurableCommandReceipt("r", { type: "durable_session_command_update", commandId: command.commandId,
      sessionId: root.id, state: "failed", revision: 2, error: "Service temporarily unavailable, please retry later" }, Date.now());
    assert.equal(f.db.getAutomationExecution(execution.executionId)!.status, "running");
    assert.equal(f.db.getSession(root.id)!.status, "input_required");
    assert.equal(f.db.listAutomationCommands(execution.executionId).length, 1);
    assert.equal(f.db.getAutomationCommand(command.commandId)!.state, "rejected");
  } finally { f.db.close(); }
});

test("a genuine provider failure after delegation holds overlap without repeatedly stopping its root", async t => {
  const f = fixture();
  try {
    const { saved, execution, root, command } = await start(f);
    const child = createChild(f, root.id);
    const changes = t.mock.method(f.hub, "sessionChangedById");
    f.service.onDurableCommandReceipt("r", { type: "durable_session_command_update", commandId: command.commandId,
      sessionId: root.id, state: "failed", revision: 2, error: "Service temporarily unavailable, please retry later" }, Date.now());
    assert.equal(f.db.listAutomationCommands(execution.executionId).length, 1, "a campaign that delegated work cannot retry its initial prompt");
    assert.equal(f.db.getSession(root.id)!.status, "stopped");
    const stoppedAt = f.db.getSession(root.id)!.updatedAt;
    const broadcastCount = changes.mock.callCount();
    f.service.tick(saved.nextFireAt! + 60_000);
    f.service.tick(saved.nextFireAt! + 60_001);
    await f.drain();
    assert.equal(f.db.getAutomationExecution(execution.executionId)!.status, "running");
    assert.equal(f.db.listSessions().length, 2);
    assert.equal(f.db.getSession(root.id)!.updatedAt, stoppedAt, "reconciliation does not rewrite a terminal root");
    assert.equal(changes.mock.callCount(), broadcastCount, "no redundant stopped broadcasts");
    // A late provider status also remains the actual terminal result.
    f.db.updateSessionStatus(root.id, "failed", Date.now());
    f.service.tick(saved.nextFireAt! + 60_002);
    assert.equal(f.db.getSession(root.id)!.status, "failed");
    f.db.updateSessionStatus(child.id, "completed", Date.now());
    f.service.tick(execution.createdAt + 1);
    assert.equal(f.db.getAutomationExecution(execution.executionId)!.status, "failed");
  } finally { f.db.close(); }
});

for (const status of ["completed", "failed", "stopped"] as const) test(`a ${status} root with unfinished tasks and no live children fails the occurrence`, async () => {
  const f = fixture();
  try {
    const { execution, root } = await start(f);
    if (status === "stopped") f.db.updateSessionStatus(root.id, status, Date.now(), { cause: "guardrail" });
    else f.db.updateSessionStatus(root.id, status, Date.now());
    f.service.tick(execution.createdAt + 2);
    assert.equal(f.db.getAutomationExecution(execution.executionId)!.status, "failed");
    assert.match(f.db.getAutomationExecution(execution.executionId)!.error!, /before verified completion/);
  } finally { f.db.close(); }
});

test("Custom success requires finished ledger work even when the legacy projection says verified complete", async () => {
  const f = fixture();
  try {
    const { execution, root } = await start(f, f.spec("custom"));
    const projection = f.db.campaignProjection.bind(f.db);
    f.db.campaignProjection = id => { const value = projection(id); return value ? { ...value, status: "verified_complete" } : value; };
    f.db.updateSessionStatus(root.id, "idle", Date.now());
    f.service.tick(execution.createdAt + 2);
    assert.equal(f.db.getAutomationExecution(execution.executionId)!.status, "running");
    const rows = f.db.raw().prepare("SELECT id FROM campaign_work_items WHERE campaign_session_id=?").all(root.id);
    for (const row of rows) assert.equal(f.db.campaignWorkLedger.updateItem(root.id, root.id, { workItemId: String(row.id),
      commitment: { state: "cancelled", reason: "The owner no longer needs this check" } }, Date.now()).ok, true);
    f.service.tick(execution.createdAt + 3);
    assert.equal(f.db.getAutomationExecution(execution.executionId)!.status, "succeeded");
  } finally { f.db.close(); }
});

test("generated UUID task keys do not hold Custom delegation behind an issue-scope reading", async () => {
  const f = fixture();
  try {
    const input = f.spec("custom");
    if (input.action.kind !== "create_session") assert.fail();
    input.action.request.campaign!.tasks[0]!.key = "a1b2-c3";
    const { root } = await start(f, input);
    assert.equal(root.orchestratorPolicy!.issueScopeSeed?.state, "none");
    createChild(f, root.id);
  } finally { f.db.close(); }
});

test("recovery after materialization reuses the exact command and allowance generation", async () => {
  const f = fixture();
  try {
    const saved = f.service.create(f.spec(), f.actor).data!;
    const activate = f.db.activateAutomationCommands.bind(f.db);
    f.db.activateAutomationCommands = () => { throw new Error("Synthetic crash before activation"); };
    f.service.tick(saved.nextFireAt!);
    await f.drain();
    const execution = f.db.listAutomationExecutions(saved.automationId)[0]!;
    assert.equal(execution.status, "dispatching");
    const before = f.db.listAutomationCommands(execution.executionId)[0]!;
    assert.equal(before.state, "staged");
    const allowance = f.db.campaignBudgets.view(execution.sessionId!);
    const generation = f.db.campaignBudgets.dispatchTo(execution.sessionId!);
    f.db.activateAutomationCommands = activate;
    const restarted = new AutomationsService(f.db, f.hub, f.sessions, { info() {}, warn() {} }, undefined, f.runtime);
    restarted.recover();
    await f.drain();
    const after = f.db.listAutomationCommands(execution.executionId)[0]!;
    assert.equal(after.payloadSha256, before.payloadSha256);
    assert.equal(after.payloadJson, before.payloadJson);
    assert.equal(after.state, "sent");
    assert.equal(f.db.listSessions().length, 1);
    assert.deepEqual(f.db.campaignBudgets.view(execution.sessionId!), allowance);
    assert.deepEqual(f.db.campaignBudgets.dispatchTo(execution.sessionId!), generation);
  } finally { f.db.close(); }
});

test("repository drift refuses authority and starts no provider", async () => {
  const f = fixture();
  try {
    const saved = f.service.create(f.spec(), f.actor);
    assert.equal(saved.ok, true, saved.error ?? "Schedule saved");
    f.changeRepository("another/repository");
    f.service.tick(saved.data!.nextFireAt!);
    await f.drain();
    const execution = f.service.get(saved.data!.automationId).data!.executions[0]!;
    assert.equal(execution.status, "failed");
    assert.match(execution.error!, /approved repository/);
    assert.equal(f.db.listSessions().length, 0);
    assert.equal(f.sent.some(m => m.type === "durable_session_command"), false);
  } finally { f.db.close(); }
});

test("trusted installation pinning retains campaign authorization while another author's edit refuses conversion", async () => {
  const f = fixture();
  try {
    const input = f.spec();
    const saved = f.service.create(input, f.actor).data!;
    assert.ok(f.db.pinLegacyAutomationSpec(saved, input, Date.now()));
    assert.equal(f.db.automationSoleHumanAuthor(saved.automationId), null, "ordinary attribution retains its existing rule");
    assert.equal(f.db.automationSoleHumanAuthor(saved.automationId, true), f.human.userId);
    const updated = f.service.update(saved.automationId, input, f.actor);
    assert.equal(updated.ok, true, updated.error ?? "Same-author campaign update");
    f.service.tick(updated.data!.nextFireAt!);
    await f.drain();
    assert.notEqual(f.db.listAutomationExecutions(saved.automationId)[0]!.status, "failed");

    const ordinary = f.spec();
    if (ordinary.action.kind !== "create_session") assert.fail();
    delete ordinary.action.request.campaign;
    delete ordinary.action.request.orchestrator;
    delete ordinary.action.request.role;
    const other = f.service.create(ordinary, f.actor).data!;
    f.db.updateAutomation({ automationId: other.automationId, spec: ordinary, nextFireAt: other.nextFireAt ?? null,
      actor: { kind: "human", id: "another-author" }, now: Date.now() });
    const refused = f.service.update(other.automationId, input, f.actor);
    assert.equal(refused.ok, false);
    assert.match(refused.error!, /Recreate/);
  } finally { f.db.close(); }
});

test("revoked-owner recovery rejects the staged command and stops its materialized root", async () => {
  const f = fixture();
  try {
    const saved = f.service.create(f.spec(), f.actor).data!;
    const activate = f.db.activateAutomationCommands.bind(f.db);
    f.db.activateAutomationCommands = () => { throw new Error("Synthetic crash before activation"); };
    f.service.tick(saved.nextFireAt!);
    await f.drain();
    const execution = f.db.listAutomationExecutions(saved.automationId)[0]!;
    assert.equal(f.db.listAutomationCommands(execution.executionId)[0]!.state, "staged");
    f.db.raw().prepare("UPDATE identity_memberships SET role='viewer' WHERE user_id=? AND organization_id=?")
      .run(f.human.userId, f.human.organizationId);
    f.db.activateAutomationCommands = activate;
    new AutomationsService(f.db, f.hub, f.sessions, { info() {}, warn() {} }, undefined, f.runtime).recover();
    await f.drain();
    assert.equal(f.db.listAutomationCommands(execution.executionId)[0]!.state, "rejected");
    assert.equal(f.db.getAutomationExecution(execution.executionId)!.status, "failed");
    assert.equal(f.db.getSession(execution.sessionId!)!.status, "stopped");
    assert.equal(f.sent.some(message => message.type === "durable_session_command"), false);
  } finally { f.db.close(); }
});

test("signed triggers launch the approved campaign and retain its history marker without accepting prompt replacement", async () => {
  const f = fixture();
  try {
    const saved = f.service.create(f.spec(), f.actor).data!;
    assert.equal(f.service.createTrigger(saved.automationId, { kind: "webhook", name: "Unsafe",
      deliveryPolicy: { allowPrompt: true, parameterNames: [], missingReferences: "reject" } }, f.actor).ok, false);
    const credential = f.service.createTrigger(saved.automationId, { kind: "webhook", name: "Run Campaign" }, f.actor).data!;
    const now = Date.now();
    const body = Buffer.from('{"eventId":"campaign-trigger"}');
    const timestamp = String(Math.floor(now / 1000));
    const nonce = "campaign_nonce_12345";
    const result = f.service.receiveTrigger(credential.trigger.triggerId, { timestamp, nonce,
      signature: signAutomationTrigger(credential.secret, credential.trigger.triggerId, timestamp, nonce, body) }, body, now);
    assert.equal(result.ok, true, result.error ?? "Trigger accepted");
    await f.drain();
    const execution = f.service.get(saved.automationId).data!.executions[0]!;
    assert.notEqual(execution.status, "failed", execution.error ?? "Campaign started");
    assert.equal(execution.campaignSessionId, execution.sessionId);
    assert.equal(f.db.getSession(execution.sessionId!)!.role, "orchestrator");
    const ledger = f.db.campaignWorkLedger.page(execution.sessionId!, { state: "unfinished", limit: 10 }, now);
    assert.ok(ledger.ok);
    assert.equal(ledger.data.items.length, 2);
  } finally { f.db.close(); }
});

test("Custom campaigns preserve explicit root ceilings inside the aggregate allowance", async () => {
  const f = fixture();
  try {
    const input = f.spec("custom");
    Object.assign(input.action.request.config!, { costBudgetUsd: 3, maxToolCalls: 30, costCheckpointsUsd: [1] });
    const saved = f.service.create(input, f.actor).data!;
    f.service.tick(saved.nextFireAt!);
    await f.drain();
    const execution = f.db.listAutomationExecutions(saved.automationId)[0]!;
    assert.notEqual(execution.status, "failed", execution.error ?? "Campaign started");
    const root = f.db.getSession(execution.sessionId!)!;
    assert.equal(root.costBudgetUsd, 3);
    assert.equal(root.maxToolCalls, 30);
    assert.deepEqual(root.costCheckpointsUsd, [1]);
    assert.equal(f.db.campaignBudgets.view(root.id)!.authority.costUsd, 20);
    assert.deepEqual(f.db.campaignBudgets.userLimits(root.id), { costBudgetUsd: 3, maxToolCalls: 30 });
  } finally { f.db.close(); }
});

test("unsupported parent and child selections fail at save without substitution", () => {
  const f = fixture();
  try {
    const parent = f.spec();
    parent.action.request.config!.model = "unavailable-parent";
    assert.equal(f.service.create(parent, f.actor).ok, false);
    const child = f.spec();
    if (child.action.kind !== "create_session") assert.fail();
    child.action.request.orchestrator!.behavior!.childModel = "unavailable-child";
    assert.equal(f.service.create(child, f.actor).ok, false);
    assert.equal(f.db.listAutomations().length, 0);
  } finally { f.db.close(); }
});

test("agent campaign proposals preserve the complete configuration and require exact human approval", () => {
  const f = fixture();
  try {
    const scope = { organizationId: f.human.organizationId, owner: { kind: "user" as const, userId: f.human.userId } };
    f.db.createSession({ id: "requester", runnerId: "r", workspaceId: "w", agentId: "parent", title: "Requester", useWorktree: false,
      driver: "claude-code", config: {}, scope, launcherUserId: f.human.userId, now: Date.now() });
    f.db.updateSessionStatus("requester", "running", Date.now());
    const agent: AgentPrincipal = { kind: "agent", actorId: "requester", credentialSessionId: "requester",
      organizationId: scope.organizationId, delegatedScope: scope };
    const service = new AutomationCreationService(f.db, f.sessions, f.hub, f.runtime);
    const proposed = service.request("requester", { requestId: "campaign-proposal", resourceKey: "daily-campaign", spec: f.spec() }, agent);
    assert.equal(proposed.ok, true, proposed.error ?? "Proposal created");
    const occurrence = proposed.data!;
    assert.equal(occurrence.authority, "human");
    assert.equal(occurrence.resourceSnapshot.category, "automation_creation");
    if (occurrence.resourceSnapshot.category !== "automation_creation") assert.fail();
    assert.deepEqual(occurrence.resourceSnapshot.spec.action, f.spec().action);
    assert.equal(service.execute("requester", occurrence.occurrenceId, occurrence.resourceDigest, agent).ok, false);
    const approved = f.sessions.resolveWorkflowDecision("requester", "requester", occurrence.occurrenceId,
      { outcome: "approve" }, "human", f.actor, () => true);
    assert.equal(approved.ok, true, approved.error ?? "Human approved");
    const executed = service.execute("requester", occurrence.occurrenceId, occurrence.resourceDigest, agent);
    assert.equal(executed.ok, true, executed.error ?? "Schedule created");
    assert.equal(f.db.listAutomations().length, 1);
    assert.deepEqual(f.db.listAutomations()[0]!.action, occurrence.resourceSnapshot.spec.action);
  } finally { f.db.close(); }
});

test("editing the schedule while inspection is pending cannot admit the previous launch", async () => {
  const f = fixture();
  try {
    const input = f.spec();
    const saved = f.service.create(input, f.actor).data!;
    const send = f.hub.sendToRunner.bind(f.hub);
    f.hub.sendToRunner = (runnerId, message) => {
      if (message.type === "campaign_launch_inspect") f.db.updateAutomation({ automationId: saved.automationId,
        spec: { ...input, enabled: false }, nextFireAt: null, actor: f.actor, now: Date.now() });
      return send(runnerId, message);
    };
    f.service.tick(saved.nextFireAt!);
    await f.drain();
    assert.equal(f.db.listSessions().length, 0);
    assert.match(f.db.listAutomationExecutions(saved.automationId)[0]!.error!, /changed during launch/);
  } finally { f.db.close(); }
});

test("revoking the author's membership during inspection refuses the launch", async () => {
  const f = fixture();
  try {
    const saved = f.service.create(f.spec(), f.actor).data!;
    const send = f.hub.sendToRunner.bind(f.hub);
    f.hub.sendToRunner = (runnerId, message) => {
      if (message.type === "campaign_launch_inspect") f.db.raw().prepare(
        "UPDATE identity_memberships SET role='viewer' WHERE user_id=? AND organization_id=?").run(f.human.userId, f.human.organizationId);
      return send(runnerId, message);
    };
    f.service.tick(saved.nextFireAt!);
    await f.drain();
    assert.equal(f.db.listSessions().length, 0);
    assert.match(f.db.listAutomationExecutions(saved.automationId)[0]!.error!, /no longer authorized/);
  } finally { f.db.close(); }
});

test("campaign input refuses forged authority, duplicate tasks and an ordinary role", () => {
  const f = fixture();
  try {
    const changes: Array<(request: AutomationSessionRequest) => void> = [
      r => { Object.assign(r.campaign!, { authorizedByUserId: "forged" }); },
      r => { r.campaign!.tasks.push(r.campaign!.tasks[0]!); },
      r => { r.role = "normal"; },
      r => { Object.assign(r.orchestrator!, { control: { mode: "full_control" } }); },
      r => { Object.assign(r.campaign!, { fullControl: { session: {} } }); },
    ];
    for (const change of changes) {
      const input = f.spec();
      if (input.action.kind !== "create_session") assert.fail();
      change(input.action.request);
      assert.equal(validateAutomationSpec(input).ok, false);
    }
    const campaign = f.spec().action;
    assert.equal(campaign.kind, "create_session");
    if (campaign.kind === "create_session") assert.match(scheduledCampaignPrompt("Objective", campaign.request.campaign!), /human-owned decision/);
    assert.equal(f.service.create(f.spec(), { kind: "agent", id: "forged" }).ok, false);
  } finally { f.db.close(); }
});
