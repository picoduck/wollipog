import assert from "node:assert/strict";
import {test} from "node:test";
import {PROTOCOL_VERSION, DEFAULT_ORCHESTRATOR_DEFAULTS, type RunnerMetadata, type SessionSnapshot} from "@wollipog/protocol";
import {ControlPlaneDb} from "./db.js";
import {Hub} from "./hub.js";
import {SessionsService} from "./sessions.js";
import {ShellRegistry} from "./shell-registry.js";
import {createAssistantOperations} from "./assistant-routes.js";
import {registerAssistantSessionOperations} from "./assistant-session-operations.js";
import {createSessionLifecycleManagement} from "./session-lifecycle-management.js";
import {registerAssistantSessionLifecycle, ASSISTANT_SESSION_LIFECYCLE_ROUTES} from "./assistant-session-lifecycle.js";
import {SessionRoleConversions} from "./session-role-conversion.js";
import {resolveOrchestratorCampaignPolicy} from "./orchestrator-settings.js";
import {OwnerManagement} from "./owner-management.js";

function harness(orchestrator = false) {
  const db = ControlPlaneDb.open(":memory:"), identity = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(identity.userId, identity.organizationId)!;
  const metadata: RunnerMetadata = {runnerId: "r", hostname: "fixture", os: "linux", version: "fixture",
    workspaces: [{id: "w", name: "Repository", path: "/fixture/repo"}, {id: "other", name: "Other", path: "/fixture/other"}],
    agents: [{id: "claude", name: "Claude", driver: "claude-code", context: {kind: "native"}, command: "claude", args: [], env: {}, available: true,
      capabilities: {models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
        permissionModes: ["default"], supportsConversationFork: true, orchestratorAdditive: true, claudeMutableSystemPromptFlag: "--system-prompt-recording"}}]};
  db.registerRunner(metadata, Date.now(), PROTOCOL_VERSION);
  const first = db.createProject({name: "First"}), second = db.createProject({name: "Second"});
  const location = db.addProjectLocation(first.id, {runnerId: "r", workspaceId: "w"});
  db.addProjectLocation(second.id, {runnerId: "r", workspaceId: "w"});
  const defaults = structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS); defaults.execution.strictProjectIsolation = false;
  db.createSession({id: "s", runnerId: "r", workspaceId: "w", agentId: "claude", title: "Existing", driver: "claude-code",
    useWorktree: true, config: {permissionMode: "default"}, now: Date.now(), role: orchestrator ? "orchestrator" : "normal",
    ...(orchestrator ? {orchestratorPolicy: resolveOrchestratorCampaignPolicy(defaults, "system_default", {})} : {})});
  db.raw().prepare("UPDATE sessions SET worktree_path=? WHERE id=?").run("/fixture/worktree", "s");
  db.setSessionProject("s", first.id, location.id); db.updateSessionStatus("s", "idle", Date.now());
  const hub = new Hub(db), sent: unknown[] = [];
  hub.isRunnerOnline = () => true; hub.sendToRunner = (_id, message) => {sent.push(message); return true;};
  const svc = new SessionsService(db, hub, {info() {}, warn() {}, error() {}}), roles = new SessionRoleConversions(db, hub);
  const lifecycle = createSessionLifecycleManagement({db, hub, svc, shellRegistry: new ShellRegistry(db), locationAdded: async () => {}, runnerCapabilityError: () => null});
  const operations = createAssistantOperations(db), receipts = registerAssistantSessionOperations(operations, db, svc);
  registerAssistantSessionLifecycle(operations, {db, svc, receipts, lifecycle, roles});
  const issued = db.assistantConnections.create(owner, "Fixture", {operations: "all", projects: "all"});
  const credential = db.assistantConnections.authenticate(issued.token)!;
  const call = (name: string, args: Record<string, unknown> = {}) => operations.call(credential, name, {sessionId: "s", ...args}) as Promise<any>;
  const snapshot = (id = "fork"): SessionSnapshot => ({id, workspaceId: "w", agentId: "claude", title: "Fork", titleSource: "provider", status: "idle", driver: "claude-code", useWorktree: true,
    worktreePath: "/fixture/fork", config: {permissionMode: "default"}, preview: null, pendingApproval: null, tokensIn: 0, tokensOut: 0, costUsd: 0, seq: 0, createdAt: Date.now(), updatedAt: Date.now()});
  return {db, owner, first, second, location, hub, svc, roles, lifecycle, operations, receipts, issued, credential, call, sent, snapshot};
}

test("lifecycle registrations stay short, share owner placement service and fence source/destination grants", async () => {
  const h = harness();
  try {
    for (const tool of Object.values(ASSISTANT_SESSION_LIFECYCLE_ROUTES)) assert.ok(h.operations.inventory().some(t => t.name === tool && tool.length <= 32));
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.first.id]});
    await assert.rejects(h.call("session_project", {commandId: "denied", projectId: h.second.id}), /Destination project is excluded/);
    await assert.rejects(h.call("session_project", {commandId: "detach", projectId: null}), /all-project/);
    await assert.rejects(h.call("session_workspace", {commandId: "other", workspaceId: "other"}), /excluded|all-project/);
    assert.equal(h.receipts.get(h.issued.connection.id, "denied"), null);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.first.id, h.second.id]});
    assert.equal((await h.call("session_project", {commandId: "move", projectId: h.second.id})).receipt.status, "succeeded");
    assert.equal(h.db.getSession("s")!.projectId, h.second.id);
    assert.equal(h.db.getSession("s")!.workspaceId, "w");
    assert.equal(h.db.getSession("s")!.worktreePath, "/fixture/worktree");
    const ownerService = new OwnerManagement();
    ownerService.define("POST", "/project", (_input, reply) => h.lifecycle.project("s", {projectId: h.first.id}, h.owner, reply));
    assert.equal((await ownerService.execute("POST /project", {principal: h.owner, params: {}, body: {}, query: {}})).status, 200);
    assert.equal(h.db.getSession("s")!.projectId, h.first.id);
    assert.equal((await h.call("session_column", {commandId: "column", column: "review"})).receipt.status, "succeeded");
    assert.equal(h.db.getSession("s")!.column, "review");
    await assert.rejects(h.call("session_column", {commandId: "invalid", column: "inbox"}), /column must/);
  } finally {h.db.close();}
});

test("rewind confirms an exact checkpoint scope, keeps owner busy-worktree checks and never repeats", async () => {
  const h = harness(); let requests = 0;
  h.hub.requestFromRunner = async (_id, requestId, message) => {requests++; assert.equal(message.type, "rewind_session"); return {type: "rewind_result", requestId, ok: true};};
  try {
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
    const args = {commandId: "rewind", turn: 1}, preview = await h.call("session_rewind", args);
    assert.equal(preview.confirmationRequired, true); assert.equal(requests, 0);
    h.db.updateSessionStatus("s", "running", Date.now());
    await assert.rejects(h.call("session_rewind", {...args, confirmationId: preview.confirmationId}), /confirmation/);
    h.db.updateSessionStatus("s", "idle", Date.now());
    const fresh = await h.call("session_rewind", args);
    assert.equal((await h.call("session_rewind", {...args, confirmationId: fresh.confirmationId})).receipt.status, "succeeded");
    await h.call("session_rewind", args); assert.equal(requests, 1);
  } finally {h.db.close();}
});

test("fork shares authoritative snapshot identity, preserves ownership and deduplicates", async () => {
  const h = harness(); let forks = 0;
  h.hub.requestFromRunner = async (_id, requestId, message) => {
    assert.equal(message.type, "fork_session"); forks++;
    return {type: "fork_result", requestId, ok: true, snapshot: h.snapshot(message.targetSessionId), events: []};
  };
  try {
    const args = {commandId: "fork", turn: 1};
    const fork = await h.call("session_fork", args);
    assert.equal(fork.receipt.status, "succeeded");
    assert.equal(fork.result.projectId, h.first.id);
    assert.equal(h.db.sessionScope(fork.result.id)!.organizationId, h.owner.organizationId);
    await h.call("session_fork", args); assert.equal(forks, 1);
    await assert.rejects(h.call("session_fork", {commandId: "privilege", turn: 1, handoff: {agentId: "claude", config: {permissionMode: "auto"}}}), /cannot change permission/);
  } finally {h.db.close();}
});

test("fork grant loss after runner creation prevents cache commit and retains cleanup tombstone", async () => {
  const h = harness(); let target = "";
  h.hub.requestFromRunner = async (_id, requestId, message) => {
    assert.equal(message.type, "fork_session"); target = message.targetSessionId;
    h.db.assistantConnections.revoke(h.issued.connection.id);
    return {type: "fork_result", requestId, ok: true, snapshot: h.snapshot(target), events: []};
  };
  try {
    await assert.rejects(h.call("session_fork", {commandId: "revoked-fork", turn: 1}), /revoked/);
    assert.equal(h.db.getSession(target), null); assert.equal(h.db.isTombstoned(target), true);
    assert.notEqual(h.receipts.get(h.issued.connection.id, "revoked-fork")!.status, "succeeded");
  } finally {h.db.close();}
});

test("a fork carrying its source's approved Location switch is discarded on the runner, never adopted", async () => {
  const h = harness(); let target = ""; let state: "pending" | "failed" = "pending";
  h.hub.requestFromRunner = async (_id, requestId, message) => {
    assert.equal(message.type, "fork_session"); target = message.targetSessionId;
    // What a runner built before forks cleared the source's switch returns (#4138).
    return {type: "fork_result", requestId, ok: true, events: [], snapshot: {...h.snapshot(target),
      locationSwitch: {state, repository: "acme/docs", workspaceId: "other", locationName: "Docs", at: 1,
        ...(state === "failed" ? {reason: "the target worktree could not be prepared"} : {})}}};
  };
  try {
    // The route answers 502 with the reason; an assistant command reports that as an uncertain outcome.
    await assert.rejects(h.call("session_fork", {commandId: "inherited-switch", turn: 1}), /Outcome uncertain/);
    assert.equal(h.db.getSession(target), null, "the fork is not adopted");
    assert.equal(h.db.isTombstoned(target), true);
    assert.ok(h.sent.some((message) => JSON.stringify(message) === JSON.stringify({type: "delete_session", sessionId: target})),
      "and the runner is told to delete it, so it never carries the switch out");
    // A failed switch is only shown, never carried out: such a fork is adopted.
    state = "failed";
    const fork = await h.call("session_fork", {commandId: "failed-switch", turn: 1});
    assert.equal(fork.receipt.status, "succeeded");
    assert.equal(h.db.getSession(fork.result.id)!.workspaceId, "w");
  } finally {h.db.close();}
});

test("session deletion confirms then reconciles content-free receipts after the resource is gone", async () => {
  const h = harness();
  try {
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
    const preview = await h.call("session_delete", {commandId: "delete"});
    assert.ok(h.db.getSession("s")); assert.equal(preview.confirmationRequired, true);
    assert.equal((await h.call("session_delete", {commandId: "delete", confirmationId: preview.confirmationId})).status, "succeeded");
    assert.equal(h.db.getSession("s"), null); assert.equal(h.db.isTombstoned("s"), true);
    const receipt = await h.operations.call(h.credential, "command_get", {commandId: "delete"}) as any;
    assert.equal(receipt.receipt.status, "succeeded"); assert.equal(receipt.resourceDeleted, true);
    assert.equal(receipt.receipt.target, undefined);
  } finally {h.db.close();}
});

test("deletion cannot preview or remove a side chat outside the current Project grant", async () => {
  const h = harness();
  try {
    h.db.createSession({id: "side", runnerId: "r", workspaceId: "w", agentId: "claude", title: "Side", driver: "claude-code", useWorktree: false, config: {}, now: Date.now()});
    h.db.setSessionProject("side", h.second.id, null);
    h.db.recordSideChat("s", "side", Date.now(), false);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.first.id], destructiveConfirmation: "confirm"});
    await assert.rejects(h.call("session_delete", {commandId: "unseen-child"}), /excluded/);
    assert.equal(h.receipts.get(h.issued.connection.id, "unseen-child"), null);
    assert.ok(h.db.getSession("s")); assert.ok(h.db.getSession("side"));
  } finally {h.db.close();}
});

test("reprocessing cannot replace cached history after its grant is revoked during runner work", async () => {
  const h = harness();
  h.db.raw().prepare("UPDATE sessions SET adopted=1 WHERE id=?").run("s");
  h.db.appendEvent("s", {kind: "user_message", text: "Keep this cached history"}, Date.now());
  h.hub.requestFromRunner = async (_id, requestId, message) => {
    assert.equal(message.type, "reprocess_session");
    h.db.assistantConnections.revoke(h.issued.connection.id);
    return {type: "reprocess_session_result", requestId, sessionId: "s", ok: true, events: []};
  };
  try {
    await assert.rejects(h.call("session_reprocess", {commandId: "reprocess-revoked"}), /revoked/);
    assert.equal(h.db.listCachedEventPage("s", 0, 100).events.length, 1);
    assert.equal(h.receipts.get(h.issued.connection.id, "reprocess-revoked")!.status, "uncertain");
  } finally {h.db.close();}
});

test("reprocess confirmation expires when the observed history grows before execution", async () => {
  const h = harness();
  try {
    h.db.raw().prepare("UPDATE sessions SET adopted=1 WHERE id=?").run("s");
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
    const args = {commandId: "confirm-history"};
    const preview = await h.call("session_reprocess", args);
    h.db.appendEvent("s", {kind: "user_message", text: "New history after preview"}, Date.now());
    await assert.rejects(h.call("session_reprocess", {...args, confirmationId: preview.confirmationId}), /confirmation/);
    assert.equal(h.receipts.get(h.issued.connection.id, "confirm-history"), null);
  } finally {h.db.close();}
});

test("role changes share the durable two-phase service and refuse policy/permission overrides", async () => {
  const h = harness(true); let phases = 0;
  h.hub.requestFromRunner = async (_id, requestId, message) => {
    assert.ok(message.type === "prepare_session_role" || message.type === "commit_session_role"); phases++;
    return {type: "session_role_result", requestId, sessionId: "s", conversionId: message.conversionId, ok: true,
      receipt: {conversionId: message.conversionId, state: message.type === "prepare_session_role" ? "prepared" : "applied"}};
  };
  try {
    assert.equal((await h.call("session_role_get", {role: "normal"})).available, true);
    const result = await h.call("session_role", {commandId: "demote", role: "normal", expectedRole: "orchestrator"});
    assert.equal(result.receipt.status, "succeeded"); assert.equal(phases, 2);
    assert.equal(h.db.getSession("s")!.role, "normal");
    assert.equal(h.db.getSession("s")!.permissionMode, "default");
    await assert.rejects(h.call("session_role", {commandId: "overrides", role: "orchestrator", expectedRole: "normal", orchestrator: {execution: {strictProjectIsolation: false}}}), /Unknown argument/);
  } finally {h.db.close();}
});

test("adoption requires all projects, trusts the runner descriptor and rechecks before materialization", async () => {
  const h = harness(); let requests = 0;
  const descriptor = {agentSessionId: "external", driver: "claude-code" as const, cwd: "/fixture/repo", context: {kind: "native" as const}, title: "External", createdAt: 1, updatedAt: 2, messageCount: 1};
  h.hub.requestFromRunner = async (_id, requestId, message) => {
    assert.equal(message.type, "adopt_session"); requests++;
    return {type: "adopt_session_result", requestId, ok: true, descriptor,
      snapshot: {...h.snapshot(message.sessionId), agentId: null, adopted: true, workspacePath: descriptor.cwd}};
  };
  const args = {commandId: "adopt", runnerId: "r", descriptor};
  try {
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.first.id]});
    await assert.rejects(h.operations.call(h.credential, "session_adopt", args), /excluded/); assert.equal(requests, 0);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all"});
    const result = await h.operations.call(h.credential, "session_adopt", args) as any;
    assert.equal(result.receipt.status, "succeeded"); assert.equal(result.result.adopted, true);
    await h.operations.call(h.credential, "session_adopt", args); assert.equal(requests, 1);
  } finally {h.db.close();}
});
