import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { PROTOCOL_VERSION, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { createAssistantOperations, registerAssistantRoutes } from "./assistant-routes.js";
import { registerAssistantSessionOperations } from "./assistant-session-operations.js";
import { registerAssistantSessionWork, ASSISTANT_SESSION_WORK_ROUTES } from "./assistant-session-work.js";
import { createSessionQueueManagement } from "./session-queue-management.js";
import { capabilityRefusal } from "./capability-refusal.js";
import { assistantRequestDigest } from "./assistant-command-receipts.js";

function harness(path = ":memory:") {
  const db = ControlPlaneDb.open(path);
  const local = db.localIdentityContext(), owner = db.operatingHumanPrincipal(local.userId, local.organizationId)!;
  const metadata: RunnerMetadata = {runnerId: "runner", hostname: "fixture", os: "linux", version: "test",
    agents: [{id: "agent", name: "Agent", driver: "codex-app-server", command: "fixture", args: [], env: {}, available: true,
      capabilities: {models: [], effortLevels: [], slashCommands: [], supportsSteering: true, supportsImages: false, supportsApprovals: true}}],
    workspaces: [{id: "repo", name: "Repo", path: "/fixture/repo"}]};
  db.registerRunner(metadata, Date.now(), PROTOCOL_VERSION);
  const project = db.createProject({name: "First"}), other = db.createProject({name: "Other"});
  const location = db.addProjectLocation(project.id, {runnerId: "runner", workspaceId: "repo"});
  db.createSession({id: "existing", runnerId: "runner", workspaceId: "repo", agentId: "agent", title: "Existing", driver: "codex-app-server", useWorktree: false, config: {}, now: Date.now()});
  db.setSessionProject("existing", project.id, location.id);
  db.updateSessionStatus("existing", "running", Date.now());
  db.raw().prepare("UPDATE sessions SET agent_capabilities=? WHERE id=?").run(JSON.stringify({supportsSteering: true,
    slashCommands: [{name: "compact", description: "Compact", source: "builtin", invocation: {id: "compact-id", catalogRevision: "catalog-1", executionMode: "passthrough"}}]}), "existing");
  const hub = new Hub(db), sent: unknown[] = [];
  hub.isRunnerOnline = () => true;
  hub.sendToRunner = (_id, value) => {sent.push(value); return true;};
  hub.setSessionQueue("existing", [{id: "prompt", text: "Before", editable: true, editRevision: "rev-1"}], false, "turn");
  const svc = new SessionsService(db, hub, {info() {}, warn() {}, error() {}});
  const operations = createAssistantOperations(db), receipts = registerAssistantSessionOperations(operations, db, svc);
  const queue = createSessionQueueManagement({db, hub, svc, runnerCapabilityError: () => null, warn() {}});
  registerAssistantSessionWork(operations, {db, svc, receipts, queue});
  const issued = db.assistantConnections.create(owner, "Fixture", {operations: "all", projects: "all"});
  const credential = db.assistantConnections.authenticate(issued.token)!;
  const call = (name: string, args: Record<string, unknown> = {}) => operations.call(credential, name, {sessionId: "existing", ...args}) as Promise<any>;
  return {db, hub, svc, queue, operations, receipts, issued, call, sent, project, other};
}

test("all slice tools use short names; current queue/turn/catalog and invocation readback support management", async () => {
  const h = harness();
  try {
    for (const name of Object.values(ASSISTANT_SESSION_WORK_ROUTES)) assert.ok(h.operations.inventory().some(tool => tool.name === name && name.length <= 32));
    const state = await h.call("session_work_get");
    assert.equal(state.activeTurnId, "turn");
    assert.equal(state.queued[0].id, "prompt");
    assert.equal(state.commands[0].invocation.catalogRevision, "catalog-1");
    assert.equal(h.db.getSession("existing")!.parentSessionId, null);
    const invocation = await h.call("session_invoke", {commandId: "invoke", submissionId: "invocation", providerCommandId: "compact-id", catalogRevision: "catalog-1", argumentText: ""});
    assert.equal(invocation.receipt.status, "succeeded");
    assert.equal(invocation.result.state, "sent");
    assert.equal((await h.call("session_work_get")).invocations[0].submissionId, "invocation");
    const before = h.sent.length;
    assert.equal((await h.call("session_invoke", {commandId: "invoke", submissionId: "invocation", providerCommandId: "compact-id", catalogRevision: "catalog-1", argumentText: ""})).result, undefined);
    assert.equal(h.sent.length, before);
    await assert.rejects(h.call("session_invoke", {commandId: "stale", submissionId: "stale", providerCommandId: "compact-id", catalogRevision: "old", argumentText: ""}), /catalog changed/);
    assert.equal(h.receipts.get(h.issued.connection.id, "stale")!.status, "failed");
  } finally {h.db.close();}
});

test("queue read/edit use shared runner correlation, revision checks and content-free dedup receipts", async () => {
  const h = harness();
  let calls = 0;
  h.hub.requestFromRunner = async (_runner, requestId, message) => {
    calls++;
    assert.equal(h.receipts.get(h.issued.connection.id, "edit")?.status, message.type === "edit_queued_prompt" ? "accepted" : undefined);
    if (message.type === "read_queued_prompt") return {type: "read_queued_prompt_result", requestId, sessionId: "existing", promptId: "prompt", ok: true,
      prompt: {promptId: "prompt", text: "Before", images: [], editRevision: "rev-1"}};
    assert.equal(message.type, "edit_queued_prompt");
    assert.equal(message.expectedRevision, "rev-1");
    return {type: "edit_queued_prompt_result", requestId, sessionId: "existing", promptId: "prompt", submissionId: message.submissionId, applied: true,
      prompt: {promptId: "prompt", text: "After", images: [], editRevision: "rev-2"}};
  };
  try {
    assert.equal((await h.call("queue_get", {promptId: "prompt"})).prompt.editRevision, "rev-1");
    const args = {commandId: "edit", promptId: "prompt", submissionId: "edit-submission", expectedRevision: "rev-1", text: "After"};
    assert.equal((await h.call("queue_edit", args)).result.prompt.editRevision, "rev-2");
    const duplicate = await h.call("queue_edit", args);
    assert.equal(duplicate.result, undefined);
    assert.equal(calls, 2);
    assert.ok(!JSON.stringify(duplicate).includes("After"));
    await assert.rejects(h.call("queue_edit", {...args, text: "Different"}), /different operation or request/);
    await assert.rejects(h.call("queue_edit", {...args, commandId: "empty", text: ""}), /cannot be empty/);
    assert.equal(calls, 2);
    assert.equal(h.receipts.get(h.issued.connection.id, "empty")!.status, "failed");
  } finally {h.db.close();}
});

test("destructive queue cancellation and provider commands confirm exact target/grant/queue before one dispatch", async () => {
  const h = harness();
  try {
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
    const args = {commandId: "cancel", promptId: "prompt"};
    const preview = await h.call("queue_cancel", args);
    assert.equal(preview.confirmationRequired, true);
    assert.equal(h.sent.length, 0);
    assert.equal(h.receipts.get(h.issued.connection.id, "cancel"), null);
    h.hub.setSessionQueue("existing", [{id: "prompt", text: "Changed", editRevision: "rev-2"}], false, "turn");
    await assert.rejects(h.call("queue_cancel", {...args, confirmationId: preview.confirmationId}), /confirmation/);
    const fresh = await h.call("queue_cancel", args);
    assert.equal((await h.call("queue_cancel", {...args, confirmationId: fresh.confirmationId})).receipt.status, "succeeded");
    assert.equal(h.sent.length, 1);
    await h.call("queue_cancel", {...args, confirmationId: fresh.confirmationId});
    assert.equal(h.sent.length, 1);
    const invoke = {commandId: "confirm-invoke", submissionId: "command", providerCommandId: "compact-id", catalogRevision: "catalog-1", argumentText: ""};
    assert.equal((await h.call("session_invoke", invoke)).confirmationRequired, true);
    assert.equal(h.sent.length, 1);
  } finally {h.db.close();}
});

test("steering preserves shared durable state and refuses forged human result-review fields", async () => {
  const h = harness();
  let calls = 0;
  h.hub.requestFromRunner = async (_runner, requestId, message) => {
    assert.equal(message.type, "steer_session"); calls++;
    assert.equal(h.db.findSteeringAttemptBySubmission("existing", "steer")!.attempt.state, "pending");
    return {type: "steer_session_result", requestId, sessionId: "existing", submissionId: "steer", turnId: "turn", disposition: "accepted", reason: "accepted"};
  };
  try {
    const args = {commandId: "steer", submissionId: "steer", turnId: "turn", text: "Narrow the change"};
    assert.equal((await h.call("session_steer", args)).result.state, "accepted");
    assert.equal(h.db.findSteeringAttemptBySubmission("existing", "steer")!.attempt.state, "accepted");
    await h.call("session_steer", args);
    assert.equal(calls, 1);
    await assert.rejects(h.call("session_steer", {...args, commandId: "forge", reviewedResultRevision: "human-review"}), /Unknown arguments/);
    assert.equal(h.receipts.get(h.issued.connection.id, "forge"), null);
  } finally {h.db.close();}
});

test("uncertain runner effects never redispatch, reveal raw diagnostics or cache prompt results", async () => {
  const h = harness();
  let attempts = 0;
  h.hub.requestFromRunner = async () => {attempts++; throw new Error("private runner diagnostic");};
  try {
    const args = {commandId: "lost", promptId: "prompt", submissionId: "lost-edit", expectedRevision: "rev-1", text: "Private Prompt"};
    const result = await h.call("queue_edit", args);
    assert.equal(result.receipt.status, "uncertain");
    assert.ok(!JSON.stringify(result).includes("private runner diagnostic"));
    await h.call("queue_edit", args);
    assert.equal(attempts, 1);
    assert.ok(!JSON.stringify(await h.call("command_get", {commandId: "lost"})).includes("Private Prompt"));
    assert.equal((await h.call("session_steer", {commandId: "lost-steer", submissionId: "lost-steer", turnId: "turn", text: "Continue"})).receipt.status, "uncertain");
  } finally {h.db.close();}
});

test("current source projects, operation grants and revocation fence reads and post-await private responses", async () => {
  const h = harness();
  try {
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.other.id]});
    await assert.rejects(h.call("session_work_get"), /excluded/);
    await assert.rejects(h.call("queue_cancel", {commandId: "denied", promptId: "prompt"}), /excluded/);
    assert.equal(h.receipts.get(h.issued.connection.id, "denied"), null);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: ["session_work_get"], projects: "all"});
    await assert.rejects(h.call("queue_get", {promptId: "prompt"}), /excluded/);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.project.id]});
    h.hub.requestFromRunner = async (_runner, requestId) => {
      h.db.setSessionProject("existing", h.other.id, null);
      return {type: "read_queued_prompt_result", requestId, sessionId: "existing", promptId: "prompt", ok: true,
        prompt: {promptId: "prompt", text: "Private", images: [], editRevision: "rev-1"}};
    };
    await assert.rejects(h.call("queue_get", {promptId: "prompt"}), /excluded/);
    h.db.assistantConnections.revoke(h.issued.connection.id);
    await assert.rejects(h.call("session_work_get"), /revoked/);
  } finally {h.db.close();}
});

test("applied edits keep a known receipt but withhold results after revocation; original project fences duplicate receipts", async () => {
  const h = harness();
  try {
    const args = {commandId: "applied", promptId: "prompt", submissionId: "applied", expectedRevision: "rev-1", text: "Private result"};
    h.hub.requestFromRunner = async (_runner, requestId) => {
      h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: [h.other.id]});
      return {type: "edit_queued_prompt_result", requestId, sessionId: "existing", promptId: "prompt", submissionId: "applied", applied: true,
        prompt: {promptId: "prompt", text: "Private result", images: [], editRevision: "rev-2"}};
    };
    await assert.rejects(h.call("queue_edit", args), /excluded/);
    assert.equal(h.receipts.get(h.issued.connection.id, "applied")!.status, "succeeded");
    h.db.setSessionProject("existing", h.other.id, null);
    // Its current placement is allowed; the receipt's original project still is not.
    await assert.rejects(h.call("queue_edit", args), /excluded/);
  } finally {h.db.close();}
});

test("mismatched edit replies and stale revisions cannot become successful edits", async () => {
  const h = harness();
  try {
    const args = {promptId: "prompt", submissionId: "sub", expectedRevision: "rev-1", text: "After"};
    h.hub.requestFromRunner = async (_runner, requestId) => ({type: "edit_queued_prompt_result", requestId, sessionId: "other-session", promptId: "prompt", submissionId: "sub", applied: true,
      prompt: {promptId: "prompt", text: "Other session's private text", images: [], editRevision: "rev-2"}});
    const mismatch = await h.call("queue_edit", {...args, commandId: "mismatch"});
    assert.equal(mismatch.receipt.status, "uncertain");
    assert.ok(!JSON.stringify(mismatch).includes("private text"));
    h.hub.requestFromRunner = async (_runner, requestId) => ({type: "edit_queued_prompt_result", requestId, sessionId: "existing", promptId: "prompt", submissionId: "sub", applied: false, reason: "queue_item_changed", error: "queued item changed"});
    await assert.rejects(h.call("queue_edit", {...args, commandId: "stale-edit"}), /queued item changed/);
    assert.equal(h.receipts.get(h.issued.connection.id, "stale-edit")!.status, "failed");
  } finally {h.db.close();}
});

test("MCP and SQLite reopen retain receipts and grant refusals without runner replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "assistant-session-work-")), file = join(dir, "db.sqlite");
  const h = harness(file), app = Fastify();
  registerAssistantRoutes(app, {db: h.db, operations: h.operations, requestHuman: () => null});
  try {
    const invoke = () => app.inject({method: "POST", url: "/assistant/mcp", headers: {authorization: `Bearer ${h.issued.token}`},
      payload: {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "queue_cancel", arguments: {sessionId: "existing", commandId: "mcp", promptId: "prompt"}}}});
    const first = await invoke();
    assert.equal(JSON.parse(first.json().result.content[0].text).receipt.status, "succeeded");
    await invoke();
    assert.equal(h.sent.length, 1);
    const pendingArgs = {sessionId: "existing", commandId: "crash", promptId: "prompt"};
    h.receipts.reserve({controlPlaneId: h.db.instanceId(), connectionId: h.issued.connection.id,
      operationId: "crash", operation: "queue_cancel", argumentsDigest: assistantRequestDigest(pendingArgs),
      grantRevision: h.issued.connection.revision, target: {kind: "session", id: "existing", projectId: h.project.id}});
    await app.close(); h.db.close();
    const reopened = ControlPlaneDb.open(file);
    try {
      const hub = new Hub(reopened), svc = new SessionsService(reopened, hub, {info() {}, warn() {}, error() {}});
      hub.sendToRunner = () => {throw new Error("replay forbidden");};
      const ops = createAssistantOperations(reopened), receipts = registerAssistantSessionOperations(ops, reopened, svc);
      registerAssistantSessionWork(ops, {db: reopened, svc, receipts, queue: createSessionQueueManagement({db: reopened, hub, svc, runnerCapabilityError: () => null, warn() {}})});
      const receipt = await ops.call(reopened.assistantConnections.authenticate(h.issued.token)!, "queue_cancel", {sessionId: "existing", commandId: "mcp", promptId: "prompt"}) as any;
      assert.equal(receipt.receipt.status, "succeeded");
      const interrupted = await ops.call(reopened.assistantConnections.authenticate(h.issued.token)!, "queue_cancel", pendingArgs) as any;
      assert.equal(interrupted.receipt.status, "accepted", "reservation at interruption must reconcile, never redispatch");
    } finally {reopened.close();}
  } finally {await app.close(); if (h.db.raw().isOpen) h.db.close(); rmSync(dir, {recursive: true, force: true});}
});

test("shared queue service retains version/offline refusals before sending", async () => {
  const h = harness();
  try {
    const queue = createSessionQueueManagement({db: h.db, hub: h.hub, svc: h.svc,
      runnerCapabilityError: (_id, capability, label) => capabilityRefusal(1, capability, label), warn() {}});
    const result = queue.cancel("existing", "prompt");
    assert.equal(result.status, 409);
    assert.deepEqual(result.body, {error: capabilityRefusal(1, "queuedPromptCancellation", "queued prompt cancellation").error,
      ...capabilityRefusal(1, "queuedPromptCancellation", "queued prompt cancellation").capabilityRequirement});
    h.hub.isRunnerOnline = () => false;
    await assert.rejects(h.call("queue_cancel", {commandId: "offline", promptId: "prompt"}), /runner is offline/);
    assert.equal(h.receipts.get(h.issued.connection.id, "offline")!.status, "failed");
    assert.equal(h.sent.length, 0);
  } finally {h.db.close();}
});
