import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PROTOCOL_VERSION, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { registerAssistantRoutes } from "./assistant-routes.js";
import { registerAssistantDiscordIngress } from "./assistant-discord-ingress.js";
import { createAssistantManagement } from "./assistant-composition.js";

function harness(path = ":memory:") {
  const db = ControlPlaneDb.open(path);
  const local = db.localIdentityContext(), owner = db.operatingHumanPrincipal(local.userId, local.organizationId)!;
  const runner: RunnerMetadata = {runnerId: "runner-fixture", hostname: "fixture", os: "linux", version: "fixture",
    agents: [{id: "agent-fixture", name: "Fixture", command: "fixture", args: [], env: {}, driver: "acp", available: true,
      capabilities: {models: [{id: "fixture", default: true}], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true}}],
    workspaces: [{id: "workspace-fixture", name: "Fixture", path: "/fixture/repo"}]};
  db.registerRunner(runner, Date.now(), PROTOCOL_VERSION);
  const project = db.createProject({name: "Fixture"}), second = db.createProject({name: "Second Fixture"});
  const location = db.addProjectLocation(project.id, {runnerId: runner.runnerId, workspaceId: "workspace-fixture"});
  const secondLocation = db.addProjectLocation(second.id, {runnerId: runner.runnerId, workspaceId: "workspace-fixture"});
  const issued = db.assistantConnections.create(owner, "Fixture", {operations: "all", projects: "all"});
  const binding = db.assistantWork.createBinding(owner, issued.connection.id, {requesterId: "requester-fixture",
    accountId: "account-fixture", conversationId: "conversation-fixture", destination: "channel:123", agentId: "agent-fixture",
    sessionKey: "agent:agent-fixture:discord:channel:123", projects: [project.id]});
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  const sends: string[] = [];
  let beforeSend = () => {};
  hub.sendToRunner = (_runnerId, message) => {beforeSend(); sends.push(message.type); return true;};
  const svc = new SessionsService(db, hub, {info() {}, warn() {}, error() {}});
  const {operations, ingress, receipts} = createAssistantManagement(db, svc);
  const connector = ingress.issue(owner, issued.connection.id, binding.id, ["session_launch", "session_prompt"]);
  const app = Fastify();
  registerAssistantRoutes(app, {db, operations, requestHuman: () => null});
  registerAssistantDiscordIngress(app, {db, ingress, requestHuman: req => req.headers.authorization === "Bearer owner-fixture" ? owner : null});
  db.createOutboundEventSubscription({subscriptionId: "subscription-fixture", callbackUrl: "http://127.0.0.1/hook", secret: "synthetic-fixture",
    scope: {kind: "assistant", connectionId: issued.connection.id}, eventKinds: ["session.created", "session.completed", "session.input_required"],
    includeSessionName: false, includeQuestionTitle: false, actor: {kind: "human", id: owner.userId}, now: Date.now()});
  const args = {commandId: "command-fixture", locationId: location.id, agentId: "agent-fixture", useWorktree: false};
  const headers = {authorization: `Bearer ${issued.token}`, "x-wollipog-connector-token": connector.token};
  const command = (payload: Record<string, unknown>, override = headers) => app.inject({method: "POST", url: "/assistant/discord/commands", headers: override, payload});
  return {db, owner, project, second, location, secondLocation, issued, binding, operations, ingress, connector, hub, svc,
    receipts, app, sends, args, headers, command, beforeSend: (fn: () => void) => {beforeSend = fn;},
    credential: db.assistantConnections.authenticate(issued.token)!, close: async () => {await app.close(); db.close();}};
}

test("real session launch attaches authenticated work before session.created and runner dispatch; duplicates dispatch once", async () => {
  const h = harness();
  try {
    h.beforeSend(() => {
      const receipt = h.receipts.get(h.issued.connection.id, h.args.commandId);
      assert.equal(receipt?.status, "accepted", "reservation precedes runner dispatch");
      const origin = h.db.assistantWork.origin(h.issued.connection.id, h.args.commandId)!;
      assert.equal(origin.requesterId, "requester-fixture");
      assert.ok(origin.sessionId);
      const work = h.db.assistantWork.get(h.issued.connection.id, "work-fixture")!;
      assert.equal(work.sessionId, origin.sessionId);
      const payloads = h.db.raw().prepare("SELECT payload_json FROM outbound_event_deliveries WHERE subscription_id=?")
        .all("subscription-fixture") as {payload_json: string}[];
      assert.equal(payloads.length, 1, "created wakeup is already staged before runner dispatch");
      const event = JSON.parse(payloads[0]!.payload_json);
      assert.equal(event.kind, "session.created");
      assert.equal(event.sessionId, work.sessionId);
      assert.equal(event.assistant.work[0].workId, work.workId);
      assert.equal(event.assistant.connectionId, h.issued.connection.id);
      assert.equal(h.db.raw().isTransaction, false, "session plus event transaction commits before external IO");
    });
    const payload = {operation: "session_launch", arguments: h.args, workId: "work-fixture"};
    const response = await h.command(payload);
    assert.equal(response.statusCode, 200, response.body);
    const first = response.json();
    assert.equal(first.receipt.status, "succeeded", response.body);
    assert.equal(h.db.getSession(first.sessionId)?.parentSessionId, null);
    const count = h.sends.length;
    assert.ok(count > 0);
    const duplicate = await h.command(payload);
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.deepEqual(duplicate.json().receipt, first.receipt);
    assert.equal(h.sends.length, count);
    const recovered = await h.app.inject({method: "GET", url: `/assistant/discord/commands/${h.args.commandId}`, headers: h.headers});
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.deepEqual(recovered.json().receipt, first.receipt);
  } finally {await h.close();}
});

test("follow-up reuses work without rerouting and attaches its accepted origin before real prompt dispatch", async () => {
  const h = harness();
  try {
    const launch = (await h.command({operation: "session_launch", arguments: h.args, workId: "work-fixture"})).json();
    h.db.updateSessionStatus(launch.sessionId, "idle", Date.now());
    h.beforeSend(() => {
      assert.equal(h.db.assistantWork.origin(h.issued.connection.id, "follow-up-fixture")?.sessionId, launch.sessionId);
      assert.equal(h.db.assistantWork.get(h.issued.connection.id, "work-fixture")!.operationId, h.args.commandId,
        "the initial operation remains the work anchor while each command has its own origin");
    });
    const payload = {operation: "session_prompt", arguments: {commandId: "follow-up-fixture", sessionId: launch.sessionId, text: "Synthetic follow-up"}, workId: "work-fixture"};
    const followup = await h.command(payload);
    assert.equal(followup.statusCode, 200, followup.body);
    assert.equal(followup.json().receipt.status, "succeeded", followup.body);
    const sends = h.sends.length;
    await h.command(payload);
    assert.equal(h.sends.length, sends);
    assert.equal(h.db.assistantWork.forSession(launch.sessionId).length, 1);
  } finally {await h.close();}
});

test("model-only MCP claims and connector identity/target tampering fail closed before reservation", async () => {
  const h = harness();
  try {
    const forged = await h.app.inject({method: "POST", url: "/assistant/mcp", headers: {authorization: h.headers.authorization},
      payload: {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "session_launch", arguments: {...h.args, workOriginId: "work-fixture",
        requesterId: "requester-fixture", bindingId: h.binding.id, authenticatedOrigin: {requesterId: "requester-fixture"}}}}});
    assert.equal(forged.json().result.isError, true);
    assert.equal(h.receipts.get(h.issued.connection.id, h.args.commandId), null);
    assert.equal(h.sends.length, 0);
    const payload = {operation: "session_launch", arguments: h.args, workId: "work-fixture"};
    assert.equal((await h.command(payload, {authorization: h.headers.authorization, "x-wollipog-connector-token": "invalid"})).statusCode, 403);
    assert.equal((await h.command({...payload, requesterId: "forged"})).statusCode, 403);
    assert.equal((await h.command({...payload, arguments: {...h.args, workOriginId: "another-work"}})).statusCode, 403);
    assert.equal((await h.command({...payload, arguments: {...h.args, locationId: h.secondLocation.id}})).statusCode, 403);
    assert.equal(h.receipts.get(h.issued.connection.id, h.args.commandId), null);
    assert.equal(h.sends.length, 0);
    const changed = h.operations.list(h.issued.connection).find(operation => operation.name === "session_launch")!;
    const resolve = changed.resolveTarget;
    let calls = 0;
    changed.resolveTarget = value => {
      const resolved = resolve(value);
      if (++calls === 2) h.ingress.revoke(h.owner, h.issued.connection.id, h.connector.id);
      return resolved;
    };
    assert.equal((await h.command(payload)).statusCode, 403);
    assert.equal(h.receipts.get(h.issued.connection.id, h.args.commandId), null);
    assert.equal(h.sends.length, 0);
  } finally {await h.close();}
});

test("concurrent requester contexts stay isolated and replay cannot adopt another binding's accepted command", async () => {
  const h = harness();
  try {
    const otherBinding = h.db.assistantWork.createBinding(h.owner, h.issued.connection.id, {requesterId: "another-requester-fixture",
      accountId: "account-fixture", conversationId: "another-conversation-fixture", destination: "channel:456", agentId: "agent-fixture",
      sessionKey: "agent:agent-fixture:discord:channel:456", projects: [h.project.id]});
    const other = h.ingress.issue(h.owner, h.issued.connection.id, otherBinding.id, ["session_launch"]);
    const first = {operation: "session_launch", arguments: h.args, workId: "work-fixture"};
    const second = {operation: "session_launch", arguments: {...h.args, commandId: "another-command-fixture"}, workId: "another-work-fixture"};
    const [a, b] = await Promise.all([h.command(first), h.command(second, {...h.headers, "x-wollipog-connector-token": other.token})]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.equal(h.db.assistantWork.origin(h.issued.connection.id, h.args.commandId)!.bindingId, h.binding.id);
    assert.equal(h.db.assistantWork.origin(h.issued.connection.id, "another-command-fixture")!.bindingId, otherBinding.id);
    const sends = h.sends.length;
    assert.equal((await h.command(first, {...h.headers, "x-wollipog-connector-token": other.token})).statusCode, 403);
    assert.equal(h.sends.length, sends);
    const deniedReceipt = await h.app.inject({method: "GET", url: `/assistant/discord/commands/${h.args.commandId}`,
      headers: {...h.headers, "x-wollipog-connector-token": other.token}});
    assert.equal(deniedReceipt.statusCode, 403);
    h.db.setSessionProject(a.json().sessionId, h.second.id, h.secondLocation.id);
    const movedReceipt = await h.app.inject({method: "GET", url: `/assistant/discord/commands/${h.args.commandId}`, headers: h.headers});
    assert.equal(movedReceipt.statusCode, 403);
  } finally {await h.close();}
});

test("connector credentials require owner issuance and current Assistant authority; binding revocation stops correlated requests", async () => {
  const h = harness();
  try {
    const issuePath = `/api/assistant-connections/${h.issued.connection.id}/discord-connectors`;
    assert.equal((await h.app.inject({method: "POST", url: issuePath, headers: {authorization: h.headers.authorization},
      payload: {bindingId: h.binding.id, operations: ["session_launch"]}})).statusCode, 403);
    assert.throws(() => h.ingress.issue({...h.owner, role: "viewer"}, h.issued.connection.id, h.binding.id, ["session_launch"]), /current owner/);
    const payload = {operation: "session_launch", arguments: h.args, workId: "work-fixture"};
    const rotated = h.db.assistantConnections.rotate(h.issued.connection.id);
    assert.equal((await h.command(payload)).statusCode, 401);
    const headers = {...h.headers, authorization: `Bearer ${rotated}`};
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: ["assistant_work_read"], projects: "all"});
    assert.equal((await h.command(payload, headers)).statusCode, 403);
    h.db.assistantConnections.configure(h.issued.connection.id, {operations: "all", projects: "all"});
    h.db.assistantWork.revokeBinding(h.owner, h.issued.connection.id, h.binding.id);
    assert.equal((await h.command(payload, headers)).statusCode, 403);
    assert.equal(h.sends.length, 0);
  } finally {await h.close();}
});

test("authenticated envelope binds connection, operation, argument digest and resolved target inside receipt reservation", async () => {
  const h = harness();
  const authenticate = h.ingress.authenticatedOrigin.bind(h.ingress);
  try {
    for (const change of [
      {connectionId: "another-connection-fixture"}, {operation: "session_prompt"},
      {argumentsDigest: "another-digest"}, {target: {kind: "project", id: h.second.id, projectId: h.second.id}},
    ]) {
      h.ingress.authenticatedOrigin = receipt => authenticate({...receipt, ...change});
      const denied = await h.command({operation: "session_launch", arguments: h.args, workId: "work-fixture"});
      assert.equal(denied.statusCode, 403, denied.body);
      assert.equal(h.receipts.get(h.issued.connection.id, h.args.commandId), null);
      assert.equal(h.db.assistantWork.origin(h.issued.connection.id, h.args.commandId), null);
      assert.equal(h.sends.length, 0);
    }
    h.ingress.authenticatedOrigin = authenticate;
    assert.equal((await h.command({operation: "session_launch", arguments: h.args, workId: "work-fixture"})).statusCode, 200);
  } finally {await h.close();}
});

test("accepted command, connector binding and work correlation reconcile after control-plane reopen without redispatch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "assistant-connector-")), path = join(directory, "state.sqlite");
  const h = harness(path);
  const payload = {operation: "session_launch", arguments: h.args, workId: "work-fixture"};
  const first = await h.command(payload);
  assert.equal(first.statusCode, 200, first.body);
  const accepted = first.json();
  await h.close();
  const db = ControlPlaneDb.open(path), app = Fastify();
  try {
    const hub = new Hub(db);
    let dispatches = 0;
    hub.isRunnerOnline = () => true;
    hub.sendToRunner = () => {dispatches++; return true;};
    const svc = new SessionsService(db, hub, {info() {}, warn() {}, error() {}});
    const {ingress} = createAssistantManagement(db, svc);
    registerAssistantDiscordIngress(app, {db, ingress, requestHuman: () => null});
    const response = await app.inject({method: "POST", url: "/assistant/discord/commands", headers: h.headers, payload});
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().receipt, accepted.receipt);
    assert.equal(dispatches, 0);
    const recovered = await app.inject({method: "GET", url: `/assistant/discord/commands/${h.args.commandId}`, headers: h.headers});
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.equal(db.assistantWork.get(h.issued.connection.id, "work-fixture")!.sessionId, accepted.sessionId);
  } finally {await app.close(); db.close(); rmSync(directory, {recursive: true, force: true});}
});
