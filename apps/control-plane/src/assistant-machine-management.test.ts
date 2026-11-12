import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL, type RunnerMetadata, type ExecutionTargetDefinition } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub, RunnerRequestNotSentError, RunnerRequestTimeoutError } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { createAssistantOperations, registerAssistantRoutes } from "./assistant-routes.js";
import { registerAssistantSessionOperations } from "./assistant-session-operations.js";
import { AssistantCommandReceipts } from "./assistant-command-receipts.js";
import { createOwnerMachineManagement } from "./owner-machine-management.js";
import { ASSISTANT_MACHINE_MANAGEMENT, registerAssistantMachineManagement } from "./assistant-machine-management.js";
import { renameAssistantInstallation } from "./owner-installation-management.js";
import { registerAssistantConnectionOperations } from "./assistant-connection-operations.js";
import { OutboundEventsService } from "./outbound-events.js";

function harness(path = ":memory:") {
  const db = ControlPlaneDb.open(path), identity = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(identity.userId, identity.organizationId)!;
  const metadata: RunnerMetadata = {runnerId: "fixture-runner", hostname: "fixture", os: "linux", version: "test", agents: [],
    workspaces: [{id: "repo", name: "Repo", path: "/fixture/repo"}, {id: "spare", name: "Spare", path: "/fixture/spare"}]};
  db.registerRunner(metadata, Date.now(), PROTOCOL_VERSION);
  // Runner registration seeds default Projects; this fixture explicitly selects its test links.
  for (const project of db.listProjects(true)) db.deleteProject(project.id);
  const project = db.createProject({name: "First"}), second = db.createProject({name: "Second"});
  db.addProjectLocation(project.id, {runnerId: metadata.runnerId, workspaceId: "repo"});
  const hub = new Hub(db), sent: unknown[] = [];
  let online = true;
  hub.isRunnerOnline = () => online;
  hub.sendToRunner = (_id, message) => {sent.push(message); return true;};
  const svc = new SessionsService(db, hub, {info() {}, warn() {}, error() {}});
  const service = createOwnerMachineManagement(db, hub, svc), operations = createAssistantOperations(db);
  const receipts = registerAssistantSessionOperations(operations, db, svc);
  registerAssistantMachineManagement(operations, db, service, receipts);
  const issued = db.assistantConnections.create(owner, "Machine Fixture", {operations: "all", projects: "all"});
  const credential = db.assistantConnections.authenticate(issued.token)!;
  const call = (name: string, args: unknown = {}) => operations.call(credential, name, args) as Promise<any>;
  return {db, owner, metadata, hub, svc, service, operations, receipts, issued, call, sent, project, second,
    offline: () => {online = false;}};
}

test("discovered harness choices retain exact candidates, protocol fences and durable deduplication", async () => {
  const h = harness();
  const candidate = {id: "codex", name: "Codex", command: "/fixture/codex", args: [], env: {}, driver: "codex" as const, available: true,
    installation: {id: "fixture-installation", path: "/fixture/codex", via: "path" as const}};
  const target: ExecutionTargetDefinition = {id: "runner:fixture-runner:container:test", runnerId: h.metadata.runnerId, name: "Test",
    kind: "container", adapter: "container", workspaceStrategy: "worktree",
    boundaries: {filesystem: "container", network: "deny", secrets: "none", billing: "none"},
    environment: {id: "test", revision: 1, image: `example/agent@sha256:${"a".repeat(64)}`, setupCheckDigest: "b".repeat(64)},
    compatibleAgentIds: ["codex"], available: true,
    harnessInstallations: [{agentId: "codex", id: "a".repeat(24), path: "/fixture/codex", provenance: "container-image",
      authentication: "unknown", capability: "unknown", available: true}]};
  const metadata = {...h.metadata, agents: [candidate], executionTargets: [target]};
  try {
    h.db.registerRunner(metadata, Date.now(), PROTOCOL_VERSION);
    const args = {runnerId: h.metadata.runnerId, commandId: "harness", payload: {agentId: candidate.id, installationId: candidate.installation.id}};
    const wrong = await h.call("harness_select", {...args, commandId: "wrong", payload: {...args.payload, installationId: "not-discovered"}});
    assert.equal(wrong.receipt.status, "failed");
    assert.deepEqual(h.db.getRunner(h.metadata.runnerId)?.harnessSelections, []);
    const selected = await h.call("harness_select", args);
    assert.equal(selected.receipt.status, "succeeded");
    assert.equal(selected.body.selection.installationId, candidate.installation.id);
    const dispatches = h.sent.length;
    await h.call("harness_select", args);
    assert.equal(h.sent.length, dispatches);
    const targetArgs = {runnerId: h.metadata.runnerId, commandId: "target", payload: {targetId: target.id, agentId: "codex", installationId: "a".repeat(24)}};
    assert.equal((await h.call("target_harness_select", {...targetArgs, commandId: "wrong-target", payload: {...targetArgs.payload, targetId: "absent"}})).receipt.status, "failed");
    assert.equal((await h.call("target_harness_select", targetArgs)).receipt.status, "succeeded");
    assert.equal(h.db.getRunner(h.metadata.runnerId)?.targetHarnessSelections?.[0]?.targetId, target.id);
    h.db.registerRunner(metadata, Date.now(), RUNNER_CAPABILITY_MIN_PROTOCOL.harnessInstallations - 1);
    const old = await h.call("harness_select", {...args, commandId: "old"});
    assert.equal(old.receipt.status, "failed");
    assert.equal(old.body.capabilityRequirement.requiredRunnerProtocolVersion, RUNNER_CAPABILITY_MIN_PROTOCOL.harnessInstallations);
    const oldTarget = await h.call("target_harness_select", {...targetArgs, commandId: "old-target"});
    assert.equal(oldTarget.receipt.status, "failed");
    assert.equal(oldTarget.body.capabilityRequirement.requiredRunnerProtocolVersion, RUNNER_CAPABILITY_MIN_PROTOCOL.targetHarnessInstallations);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.project.id]});
    await assert.rejects(h.call("harness_select", {...args, commandId: "scoped"}), /excluded/);
  } finally {h.db.close();}
});

test("installation rename shares owner validation and preserves identity, grants and current authority", async () => {
  const h = harness(), app = Fastify();
  registerAssistantRoutes(app, {db: h.db, operations: h.operations, requestHuman: () => h.owner});
  try {
    const instanceId = h.db.instanceId(), grant = h.db.assistantConnections.get(h.issued.connection.id);
    const owner = await app.inject({method: "POST", url: "/api/assistant-connections/installation", payload: {name: "Owner Label"}});
    assert.equal(owner.statusCode, 200);
    assert.equal(h.db.assistantConnections.installationName(), "Owner Label");
    const args = {commandId: "label", payload: {name: "Assistant Label"}};
    assert.equal((await h.call("installation_rename", args)).receipt.status, "succeeded");
    assert.equal(h.db.assistantConnections.installationName(), "Assistant Label");
    assert.equal(h.db.instanceId(), instanceId);
    assert.deepEqual(h.db.assistantConnections.get(h.issued.connection.id), grant);
    assert.equal(renameAssistantInstallation(h.db, {...h.owner, organizationId: "different"}, "Denied").status, 403);
    assert.equal((await h.call("installation_rename", {commandId: "invalid", payload: {name: "\u0001"}})).receipt.status, "failed");
    await h.call("installation_rename", args);
    assert.equal(h.db.assistantConnections.installationName(), "Assistant Label");
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: ["command_get"], projects: "all"});
    await assert.rejects(h.call("installation_rename", {commandId: "revoked", payload: {name: "Denied"}}), /excluded/);
  } finally {await app.close(); h.db.close();}
});

test("installation rename aliases retain one command namespace and the same owner service", async () => {
  const h = harness(), app = Fastify(), outbound = new OutboundEventsService(h.db, {info() {}, warn() {}});
  registerAssistantConnectionOperations(h.operations, {db: h.db, outbound, receipts: h.receipts});
  registerAssistantRoutes(app, {db: h.db, operations: h.operations, requestHuman: () => h.owner});
  try {
    const first = await h.call("installation_rename", {commandId: "machine-alias", payload: {name: "Machine Alias"}});
    assert.equal(first.receipt.status, "succeeded");
    const second = await h.call("install_name", {commandId: "connection-alias", name: "Connection Alias"});
    assert.equal(second.receipt.status, "succeeded");
    assert.equal(h.db.assistantConnections.installationName(), "Connection Alias");
    const response = await app.inject({method: "POST", url: "/api/assistant-connections/installation", payload: {name: "HTTP Label"}});
    assert.equal(response.statusCode, 200);
    assert.equal(h.db.assistantConnections.installationName(), "HTTP Label");
    await assert.rejects(h.call("installation_rename", {commandId: "connection-alias", payload: {name: "Must Not Apply"}}), /already bound/);
    assert.equal(h.db.assistantConnections.installationName(), "HTTP Label");
  } finally {await app.close(); await outbound.close(); h.db.close();}
});

test("account preview uses the real selection service but returns only opaque account references", async () => {
  const h = harness(), app = Fastify();
  h.service.registerHttp(app, () => h.owner);
  const account = {id: "fixture-person-example-com", label: "fixture-person@example.com", provider: "claude" as const,
    authStatus: "authenticated" as const, billing: "subscription" as const};
  const agent = {id: "claude", name: "Claude", command: "/fixture/claude", args: [], env: {}, driver: "claude-code" as const,
    available: true, version: "2.1.300"};
  try {
    h.db.registerRunner({...h.metadata, agents: [agent], providerAccounts: [account]}, Date.now(), PROTOCOL_VERSION);
    assert.ok(h.db.setMachineProviderAccountPolicy(h.metadata.runnerId, "claude",
      {mode: "priority", fixedAccountId: null, priorityAccountIds: [account.id]}, 0, Date.now()).ok);
    const url = `/api/runners/${h.metadata.runnerId}/provider-account-selection?agentId=claude`;
    const owner = await app.inject({method: "GET", url});
    assert.equal(owner.statusCode, 200);
    assert.equal(owner.json().accountId, account.id);
    const result = await h.call("account_selection_get", {runnerId: h.metadata.runnerId, payload: {agentId: agent.id}});
    assert.equal(result.status, 200);
    assert.equal(result.body.status, "selected");
    assert.equal(result.body.accountId, undefined);
    assert.equal(result.body.candidates, undefined);
    assert.ok(result.body.choices[0].accountRef);
    assert.equal(JSON.stringify(result).includes(account.id), false);
    assert.equal(JSON.stringify(result).includes(account.label), false);
    assert.deepEqual(h.db.machineProviderAccountDefault(h.metadata.runnerId, "claude")?.priorityAccountIds, [account.id]);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.project.id]});
    await assert.rejects(h.call("account_selection_get", {runnerId: h.metadata.runnerId, payload: {provider: "claude"}}), /excluded/);
  } finally {await app.close(); h.db.close();}
});

test("real owner HTTP and MCP share Machine/Workspace mutations, stable receipts and short names", async () => {
  const h = harness(), app = Fastify();
  h.service.registerHttp(app, () => h.owner, 403, ["POST /api/assistant-connections/installation"]);
  registerAssistantRoutes(app, {db: h.db, operations: h.operations, requestHuman: () => h.owner});
  try {
    assert.deepEqual(h.service.keys().sort(), ASSISTANT_MACHINE_MANAGEMENT.map(([, route]) => route).sort());
    assert.ok(ASSISTANT_MACHINE_MANAGEMENT.every(([name]) => name.length <= 32));
    const renamed = await app.inject({method: "PATCH", url: "/api/runners/fixture-runner", payload: {displayName: "Owner Name"}});
    assert.equal(renamed.statusCode, 200);
    const mcp = async (name: string, args: unknown) => {
      const response = await app.inject({method: "POST", url: "/assistant/mcp", headers: {authorization: `Bearer ${h.issued.token}`},
        payload: {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name, arguments: args}}});
      const result = response.json().result;
      assert.equal(result.isError, undefined);
      return JSON.parse(result.content[0].text);
    };
    const input = {runnerId: h.metadata.runnerId, commandId: "register", payload: {name: "Managed", path: "/fixture/managed"}};
    const registered = await mcp("workspace_register", input);
    assert.equal(registered.receipt.status, "succeeded");
    const workspaceId = registered.body.workspace.id;
    assert.equal(h.db.workspaceSource(h.metadata.runnerId, workspaceId), "managed");
    assert.equal((await mcp("workspace_register", input)).receipt.resourceId, workspaceId);
    assert.equal(h.db.getRunner(h.metadata.runnerId)!.workspaces.filter(workspace => workspace.path === "/fixture/managed").length, 1);
    const updated = await mcp("workspace_rename", {runnerId: h.metadata.runnerId, workspaceId, commandId: "rename", payload: {name: "Changed"}});
    assert.equal(updated.receipt.status, "succeeded");
    assert.equal(h.db.getRunner(h.metadata.runnerId)!.workspaces.find(workspace => workspace.id === workspaceId)!.name, "Changed");
    assert.equal((await h.call("workspace_create", {runnerId: h.metadata.runnerId, commandId: "create", payload: {name: "Created", path: "/fixture/created"}})).receipt.status, "succeeded");
    assert.equal((await h.call("runner_rename", {runnerId: h.metadata.runnerId, commandId: "machine-name", payload: {displayName: "Assistant Name"}})).receipt.status, "succeeded");
    assert.equal(h.db.getRunner(h.metadata.runnerId)!.displayName, "Assistant Name");
    await assert.rejects(h.call("runner_rename", {runnerId: h.metadata.runnerId, commandId: "machine-name", payload: {displayName: "Reused"}}), /already bound/);
    assert.equal((await h.call("runner_rediscover", {runnerId: h.metadata.runnerId, commandId: "discover"})).receipt.status, "succeeded");
    await h.call("runner_rediscover", {runnerId: h.metadata.runnerId, commandId: "discover"});
    assert.equal(h.sent.length, 1);
  } finally {await app.close(); h.db.close();}
});

test("current project grants fence shared workspaces, arbitrary registration and host-wide discovery", async () => {
  const h = harness();
  try {
    h.db.addProjectLocation(h.second.id, {runnerId: h.metadata.runnerId, workspaceId: "repo"});
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.project.id]});
    await assert.rejects(h.call("workspace_rename", {runnerId: h.metadata.runnerId, workspaceId: "repo", commandId: "rename", payload: {name: "Denied"}}), /excluded|outside/);
    assert.equal(h.receipts.get(h.issued.connection.id, "rename"), null);
    assert.equal(h.db.getRunner(h.metadata.runnerId)!.workspaces.find(workspace => workspace.id === "repo")!.name, "Repo");
    for (const name of ["workspace_register", "runner_rename", "runner_external_sessions", "runner_directory"]) {
      await assert.rejects(h.call(name, {runnerId: h.metadata.runnerId, commandId: name, payload: {name: "Denied", path: "/fixture/no"}}), /excluded/);
    }
    assert.equal(h.db.getRunner(h.metadata.runnerId)!.workspaces.length, 2);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.project.id, h.second.id]});
    assert.equal((await h.call("workspace_rename", {runnerId: h.metadata.runnerId, workspaceId: "repo", commandId: "allowed", payload: {name: "Allowed"}})).receipt.status, "succeeded");
    const scope = await h.call("workspace_scope_get", {runnerId: h.metadata.runnerId, workspaceId: "repo"});
    assert.ok(scope.body.scope);
    assert.equal(JSON.stringify(scope).includes("confirmationToken"), false);
    const projectScope = await h.call("project_scope_get", {projectId: h.project.id});
    assert.deepEqual(projectScope.body.scope, h.db.projectScope(h.project.id));
    assert.equal(JSON.stringify(projectScope).includes("confirmationToken"), false);
  } finally {h.db.close();}
});

test("non-personal organization owners cannot bypass global Machine HTTP restrictions through MCP", async () => {
  const h = harness(), app = Fastify();
  const organizationId = "org_machine_fixture", runnerId = "org-runner";
  h.db.raw().prepare("INSERT INTO identity_organizations (organization_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(organizationId, "Machine Fixture", 1, 1);
  h.db.createIdentityMember({userId: "usr_machine_fixture", displayName: "Machine Owner", organizationId, role: "owner", now: 1});
  const owner = h.db.operatingHumanPrincipal("usr_machine_fixture", organizationId)!;
  h.db.registerRunner({...h.metadata, runnerId}, Date.now(), PROTOCOL_VERSION,
    {organizationId, owner: {kind: "organization", organizationId}});
  const connection = h.db.assistantConnections.create(owner, "Organization Fixture", {operations: "all", projects: "all"});
  const credential = h.db.assistantConnections.authenticate(connection.token)!;
  const call = (name: string, args: unknown) => h.operations.call(credential, name, args) as Promise<any>;
  h.service.registerHttp(app, () => owner);
  try {
    assert.equal(h.db.canManageRunner(owner, runnerId), true, "resource ownership alone is insufficient for global routes");
    for (const [method, url, payload] of [
      ["PATCH", `/api/runners/${runnerId}`, {displayName: "Denied"}],
      ["GET", `/api/runners/${runnerId}/list-directory`, undefined],
      ["POST", `/api/runners/${runnerId}/workspaces/register`, {name: "Denied", path: "/fixture/denied"}],
    ] as const) {
      const response = await app.inject({method, url, payload});
      assert.equal(response.statusCode, 403);
      assert.match(response.json().error, /personal control-plane organization/);
    }
    for (const [name, , kind] of ASSISTANT_MACHINE_MANAGEMENT) {
      if (kind !== "runner" && name !== "workspace_remove" && name !== "installation_rename") continue;
      await assert.rejects(call(name, {runnerId, workspaceId: "repo", commandId: name,
        payload: {name: "Denied", path: "/fixture/denied", displayName: "Denied"}}), /cannot access/);
      assert.equal(h.receipts.get(connection.connection.id, name), null, "refuse before reserving a command");
    }
    assert.equal(h.sent.length, 0);
    assert.equal(h.db.getRunner(runnerId)?.displayName, undefined);
    // These two routes are member-scoped in the same owner HTTP gate and remain usable.
    const renamed = await call("workspace_rename", {runnerId, workspaceId: "repo", commandId: "member-rename", payload: {name: "Org Workspace"}});
    assert.equal(renamed.receipt.status, "succeeded");
    assert.ok((await call("workspace_scope_get", {runnerId, workspaceId: "repo"})).body.scope);
  } finally {await app.close(); h.db.close();}
});

test("directory and external-session owner HTTP retain flat capability refusal fields", async () => {
  const h = harness(), app = Fastify();
  h.service.registerHttp(app, () => h.owner);
  try {
    const version = Math.min(RUNNER_CAPABILITY_MIN_PROTOCOL.directoryListing, RUNNER_CAPABILITY_MIN_PROTOCOL.externalSessions) - 1;
    h.db.registerRunner(h.metadata, Date.now(), version);
    for (const [path, capability] of [["list-directory", "directoryListing"], ["external-sessions", "externalSessions"]] as const) {
      const response = await app.inject({method: "GET", url: `/api/runners/${h.metadata.runnerId}/${path}`});
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().requiredRunnerProtocolVersion, RUNNER_CAPABILITY_MIN_PROTOCOL[capability]);
      assert.equal(response.json().runnerProtocolVersion, version);
      assert.equal(response.json().capabilityRequirement, undefined);
    }
    assert.equal(h.sent.length, 0);
  } finally {await app.close(); h.db.close();}
});

test("directory and external-session reads reuse real runner services and refuse results after grant loss", async () => {
  const h = harness();
  try {
    const requests: string[] = [];
    h.hub.requestFromRunner = async (_runnerId, _requestId, request) => {
      requests.push(request.type);
      if (request.type === "list_directory") return {type: "list_directory_result", requestId: request.requestId, ok: true, path: "/fixture", parent: "/", entries: []};
      if (request.type === "list_external_sessions") return {type: "list_external_sessions_result", requestId: request.requestId, ok: true, sessions: []};
      throw new Error("unexpected fixture request");
    };
    assert.equal((await h.call("runner_directory", {runnerId: h.metadata.runnerId, payload: {path: "/fixture"}})).body.path, "/fixture");
    assert.deepEqual((await h.call("runner_external_sessions", {runnerId: h.metadata.runnerId})).body.sessions, []);
    assert.deepEqual(requests, ["list_directory", "list_external_sessions"]);
    const old = h.hub.requestFromRunner;
    h.hub.requestFromRunner = async (...args) => {
      const result = await old(...args);
      h.db.assistantConnections.configure(h.issued.connection.id, {operations: ["assistant_discover"], projects: "all"});
      return result;
    };
    await assert.rejects(h.call("runner_directory", {runnerId: h.metadata.runnerId}), /excluded/);
  } finally {h.db.close();}
});

test("destructive removal previews bind exact current impact and consume once before dispatch", async () => {
  const h = harness();
  try {
    let removals = 0;
    h.hub.requestFromRunner = async (_id, requestId) => {removals++; return {type: "remove_workspace_result", requestId, ok: true};};
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
    const args = {runnerId: h.metadata.runnerId, workspaceId: "spare", commandId: "remove"};
    const preview = await h.call("workspace_remove", args);
    assert.equal(preview.confirmationRequired, true);
    assert.equal(preview.impact.workspace.name, "Spare");
    assert.equal(removals, 0);
    assert.equal(h.receipts.get(h.issued.connection.id, "remove"), null);
    h.db.renameWorkspace(h.metadata.runnerId, "spare", "Changed Impact");
    await assert.rejects(h.call("workspace_remove", {...args, confirmationId: preview.confirmationId}), /confirmation/);
    assert.equal(removals, 0);
    const current = await h.call("workspace_remove", args);
    const removed = await h.call("workspace_remove", {...args, confirmationId: current.confirmationId});
    assert.equal(removed.receipt.status, "succeeded");
    assert.equal(h.db.workspaceSource(h.metadata.runnerId, "spare"), null);
    assert.equal(removals, 1);
    assert.equal((await h.call("command_get", {commandId: "remove"})).resourceDeleted, true);
    assert.equal((await h.call("workspace_remove", {...args, confirmationId: current.confirmationId})).receipt.status, "succeeded");
    assert.equal(removals, 1);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: ["command_get"], projects: "all"});
    await assert.rejects(h.call("command_get", {commandId: "remove"}), /excluded/);
  } finally {h.db.close();}
});

test("configured removal preserves known-not-sent rollback and persists uncertainty without replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "assistant-machines-")), path = join(root, "fixture.db"), h = harness(path);
  let closed = false;
  try {
    h.hub.requestFromRunner = async () => {throw new RunnerRequestNotSentError();};
    const args = {runnerId: h.metadata.runnerId, workspaceId: "spare", commandId: "not-sent"};
    assert.equal((await h.call("workspace_remove", args)).receipt.status, "failed");
    assert.equal(h.db.workspaceSource(h.metadata.runnerId, "spare"), "configured");
    h.hub.requestFromRunner = async () => {throw new RunnerRequestTimeoutError();};
    assert.equal((await h.call("workspace_remove", {...args, commandId: "uncertain"})).receipt.status, "uncertain");
    assert.equal(h.db.workspaceSource(h.metadata.runnerId, "spare"), null);
    assert.equal((await h.call("command_get", {commandId: "uncertain"})).receipt.status, "uncertain");
    let repeated = false;
    h.hub.requestFromRunner = async () => {repeated = true; throw new Error("must not redispatch");};
    assert.equal((await h.call("workspace_remove", {...args, commandId: "uncertain"})).receipt.status, "uncertain");
    assert.equal(repeated, false);
    h.db.close(); closed = true;
    const reopened = ControlPlaneDb.open(path);
    try {assert.equal(new AssistantCommandReceipts(reopened.raw()).get(h.issued.connection.id, "uncertain")!.status, "uncertain");}
    finally {reopened.close();}
  } finally {if (!closed) h.db.close(); rmSync(root, {recursive: true, force: true});}
});

test("runner removal preserves online refusal then removes through owner service and reconciles deletion", async () => {
  const h = harness();
  try {
    const online = await h.call("runner_remove", {runnerId: h.metadata.runnerId, commandId: "online"});
    assert.equal(online.receipt.status, "failed");
    assert.equal(h.db.assistantConnections.activity(h.issued.connection.id)[0]!.outcome, "failed");
    assert.match(online.body.error, /online/);
    assert.ok(h.db.getRunner(h.metadata.runnerId));
    h.offline();
    const removed = await h.call("runner_remove", {runnerId: h.metadata.runnerId, commandId: "offline"});
    assert.equal(removed.receipt.status, "succeeded");
    assert.equal(h.db.getRunner(h.metadata.runnerId), null);
    const recovered = await h.call("command_get", {commandId: "offline"});
    assert.equal(recovered.resourceDeleted, true);
    assert.equal(recovered.receipt.status, "succeeded");
    assert.equal("target" in recovered.receipt, false);
  } finally {h.db.close();}
});

test("committed mutations followed by access loss stay uncertain and raw runner failures stay private", async () => {
  const h = harness();
  try {
    const execute = h.service.execute.bind(h.service);
    h.service.execute = async (...args) => {
      const result = await execute(...args);
      h.db.assistantConnections.configure(h.issued.connection.id, {operations: ["command_get"], projects: "all"});
      return result;
    };
    const args = {runnerId: h.metadata.runnerId, commandId: "committed", payload: {displayName: "Committed"}};
    assert.equal((await h.call("runner_rename", args)).receipt.status, "uncertain");
    assert.equal(h.db.getRunner(h.metadata.runnerId)!.displayName, "Committed");
    h.service.execute = execute;
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all"});
    assert.equal((await h.call("runner_rename", args)).receipt.status, "uncertain");
    h.hub.requestFromRunner = async () => {throw new Error("synthetic-private-runner-error");};
    const failed = await h.call("runner_directory", {runnerId: h.metadata.runnerId});
    assert.equal(failed.status, 504);
    assert.equal(h.db.assistantConnections.activity(h.issued.connection.id)[0]!.outcome, "failed");
    assert.equal(JSON.stringify(failed).includes("synthetic-private-runner-error"), false);
    assert.equal(JSON.stringify(h.db.assistantConnections.activity(h.issued.connection.id)).includes("synthetic-private-runner-error"), false);
  } finally {h.db.close();}
});

test("workspace dependency and old-runner refusals preserve state and send no removal command", async () => {
  const h = harness();
  try {
    let requests = 0;
    h.hub.requestFromRunner = async () => {requests++; throw new Error("must not dispatch");};
    const blocked = await h.call("workspace_remove", {runnerId: h.metadata.runnerId, workspaceId: "repo", commandId: "blocked"});
    assert.equal(blocked.receipt.status, "failed");
    assert.equal(blocked.body.blockers[0].kind, "project_location");
    assert.ok(h.db.workspaceSource(h.metadata.runnerId, "repo"));
    h.db.registerRunner(h.metadata, Date.now(), 1);
    const old = await h.call("workspace_remove", {runnerId: h.metadata.runnerId, workspaceId: "spare", commandId: "old"});
    assert.equal(old.receipt.status, "failed");
    assert.ok(old.body.capabilityRequirement);
    assert.ok(h.db.workspaceSource(h.metadata.runnerId, "spare"));
    assert.equal(requests, 0);
  } finally {h.db.close();}
});
