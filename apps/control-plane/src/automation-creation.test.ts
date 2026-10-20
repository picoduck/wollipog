import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { PROTOCOL_VERSION, type AutomationSpec, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { AgentPrincipal, AuthPrincipal } from "./identity.js";
import { SessionsService } from "./sessions.js";
import { AutomationCreationService } from "./automation-creation.js";
import { registerAutomationCreationRoutes } from "./automation-creation-routes.js";
import { isAgentControlApiRouteAllowed } from "./auth.js";

const metadata: RunnerMetadata = { runnerId: "runner", hostname: "test", os: "linux", version: "test",
  workspaces: [{ id: "repo", name: "Example", path: "/example" }], agents: [{ id: "agent", name: "Agent",
    command: "agent", args: [], env: {}, available: true, driver: "acp", context: { kind: "native" },
    capabilities: { models: [{ id: "model", default: true, efforts: ["high"] }], effortLevels: ["high"],
      permissionModes: ["default"], slashCommands: [], supportsImages: false, supportsApprovals: true } }] };
const spec = (): AutomationSpec => ({ name: "Weekly Health", cron: "0 8 * * 2", timezone: "UTC", enabled: true,
  action: { kind: "create_session", request: { runnerId: "runner", workspaceId: "repo", agentId: "agent", useWorktree: true, prompt: "Read CI outcomes; report without changes." } },
  misfirePolicy: { kind: "skip" }, runnerPolicy: { kind: "wait" }, concurrencyPolicy: "wait",
  limits: { maxCostUsd: 5, maxToolCalls: 50 }, notifications: { pushEvents: ["failed"] } });

function harness(file = ":memory:", seed = true) {
  const db = ControlPlaneDb.open(file);
  const hub = { isRunnerOnline: () => false, sessionChangedById() {}, sessionEvent() {}, sessionChanged() {} } as unknown as Hub;
  if (seed) {
    db.registerRunner(metadata, Date.now(), PROTOCOL_VERSION);
    db.createSession({ id: "self", runnerId: "runner", workspaceId: "repo", agentId: "agent", title: "Requester",
      driver: "acp", useWorktree: false, config: {}, now: Date.now() });
    db.updateSessionStatus("self", "running", Date.now());
  }
  const sessions = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const service = new AutomationCreationService(db, sessions, hub);
  const scope = db.sessionScope("self")!;
  const principal: AgentPrincipal = { kind: "agent", actorId: "self", credentialSessionId: "self", organizationId: scope.organizationId, delegatedScope: scope };
  const owner = db.localIdentityContext().userId;
  const request = (requestId = "request", resourceKey = "weekly", input = spec()) => service.request("self", { requestId, resourceKey, spec: input }, principal);
  const resolve = (occurrence: string, outcome: "approve" | "deny" = "approve") => sessions.resolveWorkflowDecision("self", "self", occurrence,
    { outcome }, "human", { kind: "human", id: owner }, () => true);
  return { db, hub, sessions, service, principal, owner, request, resolve };
}

test("Normal sessions require human approval, preview inherited defaults and create exactly once", () => {
  const h = harness();
  try {
    const proposal = h.request();
    assert.equal(proposal.status, 201, proposal.error ?? "Proposal should be admitted");
    const decision = proposal.data!;
    assert.equal(decision.authority, "human");
    assert.equal(decision.controllingSessionId, "self");
    assert.equal(decision.status, "pending");
    assert.equal(h.db.getSession("self")!.status, "input_required");
    assert.equal(decision.resourceSnapshot.category, "automation_creation");
    if (decision.resourceSnapshot.category !== "automation_creation") assert.fail();
    assert.equal(decision.resourceSnapshot.spec.action.request.config, undefined);
    assert.deepEqual(decision.resourceSnapshot.effectiveTargets[0]!.config, { model: "model", effort: "high", permissionMode: "default" });
    assert.equal(h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal).ok, false);
    assert.equal(h.db.listAutomations().length, 0);
    assert.equal(h.resolve(decision.occurrenceId).ok, true);
    assert.equal(h.service.execute("self", decision.occurrenceId, "0".repeat(64), h.principal).ok, false);
    const created = h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal);
    assert.equal(created.status, 201, created.error ?? "Approved creation should succeed");
    assert.equal(created.data!.status, "consumed");
    const receipt = created.data!.automationCreationResult!;
    assert.match(receipt.navigationPath, /^\/automations\/~[A-Za-z0-9_-]+$/);
    const saved = h.db.getAutomation(receipt.automationId)!;
    assert.equal(saved.name, "Weekly Health");
    assert.equal(saved.createdBy.id, h.owner);
    assert.equal(h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal).data!.automationCreationResult!.automationId, receipt.automationId);
    assert.equal(h.request().data!.occurrenceId, decision.occurrenceId);
    assert.equal(h.db.listAutomations().length, 1);
    assert.equal(h.db.listAutomationEvents(receipt.automationId)[0]!.actor.id, h.owner);
  } finally { h.db.close(); }
});

test("Orchestrator and descendant agents cannot approve automation creation through another decision path", async () => {
  const h = harness();
  try {
    h.db.raw().prepare("UPDATE sessions SET session_role='orchestrator' WHERE id='self'").run();
    const decision = h.request().data!;
    const agentAnswer = h.sessions.resolveWorkflowDecision("self", "self", decision.occurrenceId, { outcome: "approve" }, "orchestrator", { kind: "agent", id: "self" }, () => true);
    assert.equal(agentAnswer.ok, false);
    assert.equal(h.sessions.resolveWorkflowDecision("other", "self", decision.occurrenceId, { outcome: "approve" }, "human", { kind: "human", id: h.owner }, () => true).ok, false);
    assert.equal(h.sessions.resolveWorkflowDecision("self", "self", decision.occurrenceId, { outcome: "approve" }, "human", { kind: "agent", id: "self" }, () => true).ok, false);
    assert.equal(h.sessions.resolveWorkflowDecision("self", "self", decision.occurrenceId, { outcome: "approve" }, "human", { kind: "human", id: "different-user" }, () => true).ok, false);
    assert.equal(h.sessions.createWorkflowDecision("self", { requestId: "forged", resourceKey: "forged", resourceSnapshot: decision.resourceSnapshot }).status, 403);
    assert.equal(h.resolve(decision.occurrenceId).ok, true);
    assert.equal((await h.sessions.consumeWorkflowDecision("self", decision.occurrenceId, { resourceSnapshot: decision.resourceSnapshot })).status, 403);
    assert.equal(h.db.listAutomations().length, 0);
  } finally { h.db.close(); }
});

test("expired pending proposals cannot be approved but can still be denied and cleared", () => {
  const h = harness();
  try {
    const proposed = h.service.request("self", { requestId: "expired", resourceKey: "expired", spec: spec() }, h.principal, Date.now() - 25 * 60 * 60_000);
    assert.equal(proposed.ok, true);
    assert.equal(h.resolve(proposed.data!.occurrenceId).status, 409);
    assert.equal(h.resolve(proposed.data!.occurrenceId, "deny").ok, true);
    assert.equal(h.db.getSession("self")!.pendingApproval, null);
    assert.equal(h.db.listAutomations().length, 0);
  } finally { h.db.close(); }
});

for (const scenario of ["deny", "expired", "revoked", "capability", "workspace", "owner", "stopped", "membership-removed", "suspended", "viewer"] as const) {
  test(`creation refuses ${scenario} without leaving an automation`, () => {
    const h = harness();
    try {
      const decision = h.request().data!;
      assert.equal(h.resolve(decision.occurrenceId, scenario === "deny" ? "deny" : "approve").ok, true);
      if (scenario === "revoked") h.db.raw().prepare("UPDATE workflow_decisions SET status='revoked' WHERE occurrence_id=?").run(decision.occurrenceId);
      if (scenario === "capability") h.db.registerRunner({ ...metadata, agents: [{ ...metadata.agents[0]!, capabilities: { ...metadata.agents[0]!.capabilities!, models: [{ id: "different", efforts: ["high"] }] } }] }, Date.now(), PROTOCOL_VERSION);
      if (scenario === "workspace") h.db.registerRunner({ ...metadata, workspaces: [{ ...metadata.workspaces[0]!, path: "/changed" }] }, Date.now(), PROTOCOL_VERSION);
      if (scenario === "owner") h.db.raw().prepare("UPDATE session_ownership SET owner_id='different' WHERE session_id='self'").run();
      if (scenario === "stopped") h.db.raw().prepare("UPDATE sessions SET status='stopped' WHERE id='self'").run();
      if (scenario === "membership-removed") h.db.raw().prepare("DELETE FROM identity_memberships WHERE user_id=?").run(h.owner);
      if (scenario === "suspended") h.db.raw().prepare("UPDATE identity_users SET status='suspended' WHERE user_id=?").run(h.owner);
      if (scenario === "viewer") h.db.raw().prepare("UPDATE identity_memberships SET role='viewer' WHERE user_id=?").run(h.owner);
      const result = h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal,
        scenario === "expired" ? Date.now() + 31 * 60_000 : Date.now());
      assert.equal(result.ok, false, scenario);
      assert.equal(h.db.listAutomations().length, 0);
    } finally { h.db.close(); }
  });
}

test("changed proposals need a fresh human decision and supersede prior unconsumed approval", () => {
  const h = harness();
  try {
    const first = h.request().data!;
    assert.equal(h.resolve(first.occurrenceId).ok, true);
    const changed = spec(); changed.cron = "0 9 * * 2";
    assert.equal(h.request("request", "weekly", changed).status, 409);
    const next = h.request("request-2", "weekly", changed).data!;
    assert.equal(next.status, "pending");
    assert.equal(h.db.workflowDecisionByOccurrence(first.occurrenceId)!.status, "superseded");
    assert.equal(h.service.execute("self", first.occurrenceId, first.resourceDigest, h.principal).ok, false);
    assert.equal(h.db.listAutomations().length, 0);
  } finally { h.db.close(); }
});

test("unchanged runner registration preserves an approved automation target", () => {
  const h = harness();
  try {
    const decision = h.request().data!;
    assert.equal(h.resolve(decision.occurrenceId).ok, true);
    h.db.registerRunner(metadata, Date.now() + 5, PROTOCOL_VERSION);
    const executed = h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal);
    assert.equal(executed.ok, true, executed.error ?? "An unchanged registration is not target drift");
  } finally { h.db.close(); }
});

test("calendar-impossible schedules fail as a validation result before creating a decision", () => {
  const h = harness();
  try {
    const input = spec(); input.cron = "0 0 30 2 *";
    const result = h.request("impossible", "impossible", input);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(h.db.pendingWorkflowDecisionsForSession("self").length, 0);
  } finally { h.db.close(); }
});

test("workflow roles resolve disjoint defaults independently without storing shared overrides", () => {
  const h = harness();
  try {
    h.db.registerRunner({ ...metadata, agents: [...metadata.agents, { ...metadata.agents[0]!, id: "second-agent",
      capabilities: { ...metadata.agents[0]!.capabilities!, models: [{ id: "second-model", default: true, efforts: ["high"] }] } }] }, Date.now(), PROTOCOL_VERSION);
    h.db.createWorkflowDefinition({ workflowId: "mixed-workflow", name: "Mixed Defaults", maxTransitions: 3,
      nodes: ["agent", "second-agent"].map((agentId, index) => ({ nodeId: `inspect-${index}`, kind: "agent" as const,
        role: `inspector-${index}`, agentId, inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 })),
      edges: [], source: "custom", createdBy: { kind: "system", id: "test" }, createdAt: Date.now() });
    const input = spec(); input.action = { kind: "workflow_run", request: { runnerId: "runner", workspaceId: "repo", workflowId: "mixed-workflow", task: "Inspect" } };
    const result = h.request("mixed-workflow", "mixed-workflow", input);
    assert.equal(result.ok, true, result.error ?? "Disjoint defaults should not be chained");
    const snapshot = result.data!.resourceSnapshot;
    if (snapshot.category !== "automation_creation") assert.fail();
    assert.equal(snapshot.spec.action.request.config, undefined);
    assert.deepEqual(snapshot.effectiveTargets.map((target) => target.config.model), ["model", "second-model"]);
    assert.equal(h.resolve(result.data!.occurrenceId).ok, true);
    assert.equal(h.service.execute("self", result.data!.occurrenceId, result.data!.resourceDigest, h.principal).ok, true);
  } finally { h.db.close(); }
});

test("prompt automation defaults stay inherited after the target owner changes session settings", () => {
  const h = harness();
  try {
    h.db.createSession({ id: "target", runnerId: "runner", workspaceId: "repo", agentId: "agent", title: "Target", driver: "acp",
      useWorktree: false, config: { model: "model", effort: "high", permissionMode: "default" }, now: Date.now() });
    h.db.updateSessionStatus("target", "idle", Date.now());
    const input = spec(); input.action = { kind: "prompt_session", sessionId: "target", request: { text: "Inspect" } };
    const decision = h.request("inherit", "inherit", input).data!;
    assert.equal(h.resolve(decision.occurrenceId).ok, true);
    const executed = h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal);
    assert.equal(executed.ok, true);
    h.db.raw().prepare("UPDATE sessions SET permission_mode='read-only' WHERE id='target'").run();
    const saved = h.db.getAutomation(executed.data!.automationCreationResult!.automationId)!;
    assert.equal(saved.action.request.config, undefined, "Future normal prompts must not reapply the previous permission mode");
  } finally { h.db.close(); }
});

test("an interrupted post-commit acknowledgement reconciles the same durable receipt", () => {
  const h = harness();
  try {
    const decision = h.request().data!;
    assert.equal(h.resolve(decision.occurrenceId).ok, true);
    const create = h.db.createAutomation.bind(h.db);
    h.db.createAutomation = (input) => { create(input); throw new Error("Interrupted acknowledgement after commit"); };
    const recovered = h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal);
    assert.equal(recovered.ok, true);
    assert.equal(h.db.listAutomations().length, 1);
    assert.equal(h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal).data!.automationCreationResult!.automationId,
      recovered.data!.automationCreationResult!.automationId);
  } finally { h.db.close(); }
});

test("paused, alternate-machine and prompt-session configurations preserve normal automation semantics", () => {
  const h = harness();
  try {
    const alternate = structuredClone(metadata); alternate.runnerId = "alternate";
    h.db.registerRunner(alternate, Date.now(), PROTOCOL_VERSION);
    const input = spec(); input.enabled = false;
    if (input.action.kind !== "create_session") assert.fail();
    input.action.request.projectId = null;
    input.action.request.projectLocationId = null;
    input.runnerPolicy = { kind: "alternate", targets: [{ runnerId: "alternate", workspaceId: "repo", agentId: "agent", projectId: null, projectLocationId: null }], expireAfterMinutes: 60 };
    const proposed = h.request("alternate", "alternate", input);
    assert.equal(proposed.ok, true, proposed.error ?? "Alternate placement must validate");
    const decision = proposed.data!;
    assert.equal(h.resolve(decision.occurrenceId).ok, true);
    const executed = h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal);
    assert.equal(executed.ok, true, executed.error ?? "Alternate placement must remain stable");
    const saved = h.db.getAutomation(executed.data!.automationCreationResult!.automationId)!;
    assert.equal(saved.enabled, false);
    assert.equal(saved.nextFireAt, undefined);
    h.db.createSession({ id: "target", runnerId: "runner", workspaceId: "repo", agentId: "agent", title: "Target",
      driver: "acp", useWorktree: false, config: { model: "model", effort: "high", permissionMode: "default" }, now: Date.now() });
    h.db.updateSessionStatus("target", "idle", Date.now());
    const prompt = spec(); prompt.action = { kind: "prompt_session", sessionId: "target", request: { text: "Inspect current CI" } };
    const promptDecision = h.request("prompt", "prompt", prompt).data!;
    assert.equal(h.resolve(promptDecision.occurrenceId).ok, true);
    assert.equal(h.service.execute("self", promptDecision.occurrenceId, promptDecision.resourceDigest, h.principal).ok, true);
  } finally { h.db.close(); }
});

test("workflow proposals pin the reviewed definition version and validate all agent roles", () => {
  const h = harness();
  try {
    h.db.createWorkflowDefinition({ workflowId: "workflow", name: "Health", maxTransitions: 2,
      nodes: [{ nodeId: "inspect", kind: "agent", role: "inspector", agentId: "agent", inputs: [], outputs: [],
        retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 }], edges: [], source: "custom",
      createdBy: { kind: "system", id: "test" }, createdAt: Date.now() });
    const input = spec(); input.action = { kind: "workflow_run", request: { runnerId: "runner", workspaceId: "repo", workflowId: "workflow", task: "Inspect CI" } };
    const proposed = h.request("workflow", "workflow", input);
    assert.equal(proposed.ok, true, proposed.error ?? "Workflow should be admitted");
    const decision = proposed.data!;
    assert.equal(decision.resourceSnapshot.category, "automation_creation");
    if (decision.resourceSnapshot.category !== "automation_creation" || decision.resourceSnapshot.spec.action.kind !== "workflow_run") assert.fail();
    assert.equal(decision.resourceSnapshot.spec.action.request.workflowVersion, 1);
    assert.equal(decision.resourceSnapshot.spec.action.request.useWorktree, true);
    assert.equal(h.resolve(decision.occurrenceId).ok, true);
    const executed = h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal);
    assert.equal(executed.ok, true, executed.error ?? "Pinned workflow should be stable");
  } finally { h.db.close(); }
});

test("invalid explicit configuration cannot be replaced silently with a default model", () => {
  const h = harness();
  try {
    const input = spec(); input.action.request.config = { model: "unsupported", permissionMode: "default" };
    assert.equal(h.request("bad-model", "weekly", input).ok, false);
    assert.equal(h.db.listAutomations().length, 0);
    assert.equal(h.db.pendingWorkflowDecisionsForSession("self").length, 0);
  } finally { h.db.close(); }
});

test("consumed receipts survive restart and cannot create again after deletion", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-creation-"));
  let h = harness(join(root, "state.db"));
  try {
    const decision = h.request().data!;
    assert.equal(h.resolve(decision.occurrenceId).ok, true);
    const result = h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal).data!.automationCreationResult!;
    h.db.close();
    h = harness(join(root, "state.db"), false);
    assert.deepEqual(h.service.get("self", decision.occurrenceId, h.principal).data!.automationCreationResult, result);
    h.db.deleteAutomation(result.automationId, { kind: "human", id: h.owner }, Date.now());
    assert.deepEqual(h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal).data!.automationCreationResult, result);
    assert.equal(h.db.listAutomations().length, 0);
  } finally { h.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("creation transaction rolls back consumption and receipt if insertion fails", () => {
  const h = harness();
  try {
    const decision = h.request().data!;
    assert.equal(h.resolve(decision.occurrenceId).ok, true);
    h.db.raw().exec("CREATE TRIGGER fail_automation BEFORE INSERT ON automations BEGIN SELECT RAISE(ABORT, 'test insertion failure'); END");
    assert.throws(() => h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal), /test insertion failure/);
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!.status, "approved");
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!.automationCreationResult, undefined);
    assert.equal(h.db.listAutomations().length, 0);
    h.db.raw().exec("DROP TRIGGER fail_automation");
    assert.equal(h.service.execute("self", decision.occurrenceId, decision.resourceDigest, h.principal).ok, true);
  } finally { h.db.close(); }
});

test("route and credential boundaries reject impersonation and configuration overrides", async () => {
  const h = harness(); const app = Fastify();
  let principal: AuthPrincipal = h.principal;
  registerAutomationCreationRoutes(app, { service: h.service, requestPrincipal: () => principal });
  try {
    for (const role of ["normal", "orchestrator"]) {
      assert.equal(isAgentControlApiRouteAllowed("POST", "/api/sessions/:id/automation-proposals", role), true);
      assert.equal(isAgentControlApiRouteAllowed("POST", "/api/automations", role), false);
      assert.equal(isAgentControlApiRouteAllowed("PUT", "/api/automations/:id", role), false);
    }
    const decision = h.request().data!;
    assert.equal((await app.inject({ method: "POST", url: `/api/sessions/other/automation-proposals/${decision.occurrenceId}/execute`, payload: { resourceDigest: decision.resourceDigest } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: `/api/sessions/self/automation-proposals/${decision.occurrenceId}/execute`, payload: { resourceDigest: decision.resourceDigest, spec: spec() } })).statusCode, 400);
    principal = { ...h.principal, credentialSessionId: "descendant", actorId: "descendant" };
    assert.equal((await app.inject({ method: "GET", url: `/api/sessions/self/automation-proposals/${decision.occurrenceId}` })).statusCode, 403);
  } finally { await app.close(); h.db.close(); }
});
