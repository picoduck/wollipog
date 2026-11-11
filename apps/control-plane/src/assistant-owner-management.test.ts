import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { PROTOCOL_VERSION, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { createAssistantOperations, registerAssistantRoutes } from "./assistant-routes.js";
import { registerAssistantSessionOperations } from "./assistant-session-operations.js";
import { registerAssistantOwnerManagement, ASSISTANT_PROJECT_MANAGEMENT } from "./assistant-owner-management.js";
import { createOwnerProjectManagement } from "./owner-project-management.js";
import { createOwnerRunnerManagement } from "./owner-runner-management.js";
import { createSessionWorktreeManagement } from "./session-worktree-management.js";
import { WorktreeCreateCoordinator } from "./worktree-create-coordinator.js";

function harness() {
  const db = ControlPlaneDb.open(":memory:");
  const local = db.localIdentityContext(), owner = db.operatingHumanPrincipal(local.userId, local.organizationId)!;
  const metadata: RunnerMetadata = {runnerId: "runner", hostname: "fixture", os: "linux", version: "test",
    agents: [{id: "agent", name: "Agent", driver: "acp", command: "fixture", args: [], env: {}, available: true,
      capabilities: {models: [{id: "model-one"}, {id: "model-two"}], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true}}],
    workspaces: [{id: "repo", name: "Repo", path: "/fixture/repo"}]};
  db.registerRunner(metadata, Date.now(), PROTOCOL_VERSION);
  const project = db.createProject({name: "First"}), second = db.createProject({name: "Second"});
  const location = db.addProjectLocation(project.id, {runnerId: "runner", workspaceId: "repo"});
  db.createSession({id: "unrelated", runnerId: "runner", workspaceId: "repo", agentId: "agent", title: "Existing", driver: "acp", useWorktree: false, config: {}, now: Date.now()});
  db.setSessionProject("unrelated", project.id, location.id);
  db.updateSessionStatus("unrelated", "idle", Date.now());
  const hub = new Hub(db), sent: unknown[] = [];
  hub.isRunnerOnline = () => true;
  hub.sendToRunner = (_id, value) => {sent.push(value); return true;};
  const svc = new SessionsService(db, hub, {info() {}, warn() {}, error() {}});
  const operations = createAssistantOperations(db);
  const receipts = registerAssistantSessionOperations(operations, db, svc);
  const projects = createOwnerProjectManagement({db, hub, svc, locationAdded: async () => {}, runnerCapabilityError: () => null});
  const runners = createOwnerRunnerManagement(db, hub);
  const worktree = createSessionWorktreeManagement({db, hub, svc, worktreeCreates: new WorktreeCreateCoordinator(), runnerCapabilityError: () => null});
  registerAssistantOwnerManagement(operations, {db, svc, receipts, projects, runners, worktree});
  const issued = db.assistantConnections.create(owner, "Fixture", {operations: "all", projects: "all"});
  const credential = db.assistantConnections.authenticate(issued.token)!;
  const call = (name: string, args: unknown = {}) => operations.call(credential, name, args) as Promise<any>;
  return {db, owner, project, second, location, hub, svc, operations, receipts, projects, issued, call, sent};
}

test("shared project services expose every extracted owner operation, without long tool names", () => {
  const h = harness();
  try {
    assert.deepEqual(h.projects.keys().sort(), ASSISTANT_PROJECT_MANAGEMENT.map(([, route]) => route).sort());
    assert.ok(h.operations.list(h.issued.connection).every(op => op.name.length <= 32));
  } finally {h.db.close();}
});

test("Full Access configures an unrelated session, uses real lifecycle services and deduplicates", async () => {
  const h = harness();
  try {
    const args = {commandId: "config", sessionId: "unrelated", config: {model: "model-two"}};
    assert.equal((await h.call("session_config", args)).receipt.status, "succeeded");
    assert.equal(h.db.getSession("unrelated")!.model, "model-two");
    const sends = h.sent.length;
    assert.equal((await h.call("session_config", args)).receipt.status, "succeeded");
    assert.equal(h.sent.length, sends);
    assert.equal((await h.call("session_config", {...args, commandId: "human", config: {permissionMode: "auto"}})).receipt.status, "failed");
    assert.equal((await h.call("session_title", {commandId: "rename", sessionId: "unrelated", title: "New Name"})).receipt.status, "succeeded");
    assert.equal(h.db.getSession("unrelated")!.title, "New Name");
    assert.equal(h.db.getSession("unrelated")!.parentSessionId, null);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: ["session_get"], projects: "all"});
    await assert.rejects(h.call("session_title", {commandId: "denied", sessionId: "unrelated", title: "Denied"}), /excluded/);
    assert.equal(h.receipts.get(h.issued.connection.id, "denied"), null);
  } finally {h.db.close();}
});

test("project/Location writes share owner behavior, fence both sides of a move, and recheck before async writes", async () => {
  const h = harness();
  try {
    const created = await h.call("project_create", {commandId: "create", payload: {name: "Third"}});
    assert.equal(created.receipt.status, "succeeded");
    assert.equal((await h.call("project_create", {commandId: "create", payload: {name: "Third"}})).receipt.resourceId, created.receipt.resourceId);
    const renamed = await h.call("location_rename", {commandId: "rename", projectId: h.project.id, locationId: h.location.id, payload: {name: "Renamed"}});
    assert.equal(renamed.receipt.status, "succeeded");
    assert.equal(h.db.getProjectLocation(h.location.id)!.name, "Renamed");
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.second.id]});
    await assert.rejects(h.call("location_move", {commandId: "move", projectId: h.second.id, payload: {locationId: h.location.id}}), /excluded/);
    assert.equal(h.receipts.get(h.issued.connection.id, "move"), null);
    assert.equal(h.db.getProjectLocation(h.location.id)!.projectId, h.project.id);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all"});
    h.svc.listDirectory = async () => {
      h.db.assistantConnections.revoke(h.issued.connection.id);
      return {ok: true, status: 200, data: {path: "/fixture/new", parent: "/fixture", entries: []}};
    };
    const revoked = await h.call("location_create", {commandId: "revoke", projectId: h.project.id, payload: {name: "New", runnerId: "runner", path: "/fixture/new"}});
    assert.equal(revoked.receipt.status, "failed");
    assert.equal(h.db.getProject(h.project.id)!.locations.length, 1);
  } finally {h.db.close();}
});

test("destructive previews bind grant and affected scope; confirmed commands reserve once", async () => {
  const h = harness();
  try {
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
    const args = {commandId: "delete", projectId: h.second.id};
    const preview = await h.call("project_delete", args);
    assert.equal(preview.confirmationRequired, true);
    assert.ok(h.db.getProject(h.second.id));
    assert.equal(h.receipts.get(h.issued.connection.id, "delete"), null);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all"});
    await assert.rejects(h.call("project_delete", {...args, confirmationId: preview.confirmationId}), /confirmation/);
    const fresh = await h.call("project_delete", args);
    const accepted = await h.call("project_delete", {...args, confirmationId: fresh.confirmationId});
    assert.equal(accepted.receipt.status, "succeeded");
    assert.equal(h.db.getProject(h.second.id), null);
    const reconciled = await h.call("command_get", {commandId: "delete"});
    assert.equal(reconciled.resourceDeleted, true);
    assert.equal(reconciled.receipt.status, "succeeded");
    assert.equal(reconciled.receipt.target, undefined);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.project.id]});
    await assert.rejects(h.call("command_get", {commandId: "delete"}), /excluded/);
  } finally {h.db.close();}
});

test("HTTP owner and Assistant project adapters share validation, notifications and state readback", async () => {
  const h = harness(), app = Fastify();
  h.projects.registerHttp(app, () => h.owner);
  try {
    const request = {method: "PATCH" as const, url: `/api/projects/${h.project.id}`, payload: {name: ""}};
    assert.equal((await app.inject(request)).statusCode, 400);
    const refused = await h.call("project_update", {commandId: "invalid", projectId: h.project.id, payload: request.payload});
    assert.equal(refused.status, 400);
    assert.equal(refused.receipt.status, "failed");
    const saved = await app.inject({...request, payload: {name: "From Owner"}});
    assert.equal(saved.json().project.name, "From Owner");
    assert.equal((await h.call("project_list")).projects.find((p: {id: string}) => p.id === h.project.id).name, "From Owner");
    await h.call("project_update", {commandId: "valid", projectId: h.project.id, payload: {name: "From Assistant"}});
    assert.equal(h.db.getProject(h.project.id)!.name, "From Assistant");
  } finally {await app.close(); h.db.close();}
});

test("real MCP transport uses the same receipts and never retries an uncertain shared service", async () => {
  const h = harness(), app = Fastify();
  registerAssistantRoutes(app, {db: h.db, operations: h.operations, requestHuman: () => null});
  try {
    let attempts = 0;
    h.svc.setTitle = () => {attempts++; throw new Error("fixture private diagnostic");};
    const invoke = (token: string) => app.inject({method: "POST", url: "/assistant/mcp", headers: {authorization: `Bearer ${token}`},
      payload: {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "session_title", arguments: {sessionId: "unrelated", commandId: "lost", title: "Unknown"}}}});
    const response = await invoke(h.issued.token);
    assert.equal(JSON.parse(response.json().result.content[0].text).receipt.status, "uncertain");
    assert.ok(!response.body.includes("fixture private diagnostic"));
    await invoke(h.issued.token);
    assert.equal(attempts, 1);
    h.db.assistantConnections.revoke(h.issued.connection.id);
    assert.equal((await invoke(h.issued.token)).statusCode, 401);
    assert.equal(attempts, 1);
  } finally {await app.close(); h.db.close();}
});

test("runner capacity preserves revision checks and worktree refuses dirty retirement without replay", async () => {
  const h = harness();
  try {
    const changed = await h.call("runner_capacity", {commandId: "capacity", runnerId: "runner", configuredUnits: 4, expectedRevision: 0});
    assert.equal(changed.receipt.status, "succeeded");
    assert.equal((await h.call("runner_capacity_get", {runnerId: "runner"})).body.capacity.configuredUnits, 4);
    const conflict = await h.call("runner_capacity", {commandId: "stale", runnerId: "runner", configuredUnits: 8, expectedRevision: 0});
    assert.equal(conflict.receipt.status, "failed");
    assert.equal(h.db.machineRunnerCapacityConfiguration("runner")!.configuredUnits, 4);
    let requests = 0;
    h.hub.requestFromRunner = async (_runnerId, requestId) => {
      requests++;
      return {type: "session_worktree_result", requestId, sessionId: "unrelated", operation: "discard", ok: false, error: "Worktree has uncommitted changes; preserve them before retirement."};
    };
    const args = {commandId: "dirty", sessionId: "unrelated", path: "/fixture/tree"};
    const dirty = await h.call("worktree_discard", args);
    assert.equal(dirty.receipt.status, "failed");
    assert.match(dirty.body.error, /uncommitted/);
    await h.call("worktree_discard", args);
    assert.equal(requests, 1);
  } finally {h.db.close();}
});

test("project-scoped grants cannot import an excluded workspace or inspect/register arbitrary Machine folders", async () => {
  const h = harness();
  try {
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.second.id]});
    const added = await h.call("location_add", {commandId: "excluded-workspace", projectId: h.second.id, payload: {runnerId: "runner", workspaceId: "repo"}});
    assert.equal(added.receipt.status, "failed");
    assert.equal(h.db.getProject(h.second.id)!.locations.length, 0);
    let inspections = 0;
    h.svc.listDirectory = async () => {inspections++; return {ok: true, status: 200, data: {path: "/fixture/new", parent: "/fixture", entries: []}};};
    const created = await h.call("location_create", {commandId: "excluded-folder", projectId: h.second.id, payload: {runnerId: "runner", path: "/fixture/new", name: "New"}});
    assert.equal(created.receipt.status, "failed");
    assert.equal(inspections, 0);
    assert.equal(h.db.getProject(h.second.id)!.locations.length, 0);
  } finally {h.db.close();}
});

test("Location move preview binds the source project, Location and affected sessions", async () => {
  const h = harness();
  try {
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
    const args = {commandId: "scope-move", projectId: h.second.id, payload: {locationId: h.location.id}};
    const preview = await h.call("location_move", args);
    assert.equal(preview.confirmationRequired, true);
    assert.ok(JSON.stringify(preview.impact).includes("unrelated"));
    h.db.createSession({id: "new-source-work", runnerId: "runner", workspaceId: "repo", agentId: "agent", title: "Existing", driver: "acp", useWorktree: false, config: {}, now: Date.now()});
    h.db.setSessionProject("new-source-work", h.project.id, h.location.id);
    await assert.rejects(h.call("location_move", {...args, confirmationId: preview.confirmationId}), /confirmation/);
    assert.equal(h.db.getProjectLocation(h.location.id)!.projectId, h.project.id);
    assert.equal(h.receipts.get(h.issued.connection.id, args.commandId), null);
    const renewed = await h.call("location_move", args);
    assert.equal(renewed.impact.sourceLocation.id, h.location.id);
    assert.equal(renewed.impact.sourceLocation.projectId, h.project.id);
    const third = h.db.createProject({name: "Third"});
    h.db.moveProjectLocation(h.location.id, third.id, Date.now(), h.owner.userId);
    await assert.rejects(h.call("location_move", {...args, confirmationId: renewed.confirmationId}), /confirmation/);
    const current = await h.call("location_move", args);
    assert.equal(current.impact.sourceLocation.projectId, third.id);
    assert.equal((await h.call("location_move", {...args, confirmationId: current.confirmationId})).receipt.status, "succeeded");
    assert.equal(h.db.getProjectLocation(h.location.id)!.projectId, h.second.id);
  } finally {h.db.close();}
});

test("granted workspace linking stays available, while narrowing after folder inspection stops registration", async () => {
  const h = harness();
  try {
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.project.id, h.second.id]});
    const added = await h.call("location_add", {commandId: "granted-workspace", projectId: h.second.id, payload: {runnerId: "runner", workspaceId: "repo"}});
    assert.equal(added.receipt.status, "succeeded");
    const target = h.db.getProject(h.second.id)!.locations[0]!;
    assert.equal((await h.call("session_launch", {commandId: "granted-launch", locationId: target.id, agentId: "agent", useWorktree: false})).receipt.status, "succeeded");
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all"});
    let inspections = 0;
    h.svc.listDirectory = async () => {
      inspections++;
      h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.project.id]});
      return {ok: true, status: 200, data: {path: "/fixture/new", parent: "/fixture", entries: []}};
    };
    const narrowed = await h.call("location_create", {commandId: "narrow-during-inspection", projectId: h.project.id, payload: {runnerId: "runner", name: "New", path: "/fixture/new"}});
    assert.equal(narrowed.receipt.status, "failed");
    assert.match(narrowed.error, /all-project/);
    assert.equal(inspections, 1);
    assert.equal(h.db.getProject(h.project.id)!.locations.length, 1);
  } finally {h.db.close();}
});

test("destructive previews respect current source visibility rather than the global session table", async () => {
  const h = harness();
  try {
    // Active organization owners can read same-organization private sessions today. Model an
    // inaccessible resource explicitly rather than claiming that the current policy hides it.
    const original = h.db.canAccessSession.bind(h.db);
    h.db.canAccessSession = (principal, id) => id !== "unrelated" && original(principal, id);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
    await assert.rejects(h.call("project_delete", {commandId: "hidden-impact", projectId: h.project.id}), /sessions you cannot manage/);
    assert.equal(h.receipts.get(h.issued.connection.id, "hidden-impact"), null);
  } finally {h.db.close();}
});

test("background job and hold coordinates match owner bounds before runner dispatch", async () => {
  const h = harness();
  try {
    let requests = 0;
    h.hub.requestFromRunner = async () => {requests++; throw new Error("must not dispatch invalid coordinates");};
    for (const [name, key] of [["session_job_stop", "jobId"], ["session_hold_release", "holdId"]]) {
      for (const value of ["x".repeat(257), "invalid\ncoordinate"]) {
        const response = await h.call(name!, {sessionId: "unrelated", commandId: `invalid:${key}:${value.length}`, [key!]: value});
        assert.equal(response.receipt.status, "failed");
        assert.match(response.error, /coordinate|identifier/i);
      }
    }
    assert.equal(requests, 0);
  } finally {h.db.close();}
});
