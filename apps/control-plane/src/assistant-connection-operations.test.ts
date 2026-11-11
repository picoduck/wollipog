import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { ControlPlaneDb } from "./db.js";
import { createAssistantOperations, registerAssistantRoutes } from "./assistant-routes.js";
import { registerAssistantWorkOwnerRoutes, registerAssistantWorkOperations } from "./assistant-work-routes.js";
import { registerAssistantConnectionOperations, ASSISTANT_CONNECTION_OPERATIONS } from "./assistant-connection-operations.js";
import { registerAssistantSessionOperations } from "./assistant-session-operations.js";
import type { SessionsService } from "./sessions.js";
import { OutboundEventsService } from "./outbound-events.js";

const quiet = {info() {}, warn() {}};
function registry(db: ControlPlaneDb) {
  const operations = createAssistantOperations(db), outbound = new OutboundEventsService(db, quiet);
  const receipts = registerAssistantSessionOperations(operations, db, {} as SessionsService);
  registerAssistantWorkOperations(db, operations);
  registerAssistantConnectionOperations(operations, {db, outbound, receipts});
  return {operations, outbound, receipts};
}
function fixture(path = ":memory:") {
  const db = ControlPlaneDb.open(path), local = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(local.userId, local.organizationId)!;
  const issued = db.assistantConnections.create(owner, "Fixture Owner Connection", {operations: "all", projects: "all"});
  const second = db.assistantConnections.create(owner, "Fixture Second Connection", {operations: "all", projects: "all"});
  const {operations, outbound, receipts} = registry(db);
  const credential = db.assistantConnections.authenticate(issued.token)!;
  const binding = db.assistantWork.createBinding(owner, second.connection.id, {requesterId: "requester-fixture", accountId: "account-fixture",
    conversationId: "conversation-fixture", destination: "channel:123", agentId: "fixture", sessionKey: "agent:fixture:discord:channel:123", projects: "all"});
  for (const [subscriptionId, connectionId] of [["subscription-fixture", second.connection.id], ["own-subscription-fixture", issued.connection.id]]) {
    assert.ok(db.createOutboundEventSubscription({subscriptionId: subscriptionId!, callbackUrl: "https://receiver.example/wollipog/events",
      secret: "synthetic-signing-secret", scope: {kind: "assistant", connectionId: connectionId!}, eventKinds: ["session.completed"],
      includeSessionName: false, includeQuestionTitle: false, actor: {kind: "human", id: owner.userId}, now: 1}));
  }
  db.raw().exec("UPDATE outbound_event_subscriptions SET state='paused',pause_reason='delivery_failures',consecutive_failures=3");
  const args = {connectionId: second.connection.id, subscriptionId: "subscription-fixture"};
  const call = (name: string, args: unknown = {}) => operations.call(credential, name, args) as Promise<any>;
  return {db, owner, issued, second, binding, operations, outbound, receipts, args, call};
}

test("owner HTTP and MCP share connection, destination, subscription and delivery reads without credentials", async t => {
  const f = fixture(), app = Fastify();
  t.after(async () => {await app.close(); await f.outbound.close(); f.db.close();});
  const requestHuman = () => f.owner;
  registerAssistantRoutes(app, {db: f.db, operations: f.operations, requestHuman});
  registerAssistantWorkOwnerRoutes(app, {db: f.db, outboundEvents: f.outbound, requestHuman});
  const invoke = async (name: string, args = {}) => {
    const response = await app.inject({method: "POST", url: "/assistant/mcp", headers: {authorization: `Bearer ${f.issued.token}`},
      payload: {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name, arguments: args}}});
    assert.equal(response.json().result.isError, undefined);
    return JSON.parse(response.json().result.content[0].text);
  };
  const listed = await invoke("connection_list");
  assert.deepEqual(listed, (await app.inject({method: "GET", url: "/api/assistant-connections"})).json());
  assert.equal(listed.connections.length, 2);
  const base = `/api/assistant-connections/${f.second.connection.id}`;
  for (const [name, suffix, args] of [["dest_list", "/destination-bindings", {connectionId: f.second.connection.id}],
    ["sub_list", "/event-subscriptions", {connectionId: f.second.connection.id}],
    ["sub_get", "/event-subscriptions/subscription-fixture", f.args],
    ["delivery_list", "/event-subscriptions/subscription-fixture/deliveries", f.args]] as const) {
    const actual = await invoke(name, args);
    assert.deepEqual(actual, (await app.inject({method: "GET", url: base + suffix})).json());
    assert.equal(JSON.stringify(actual).includes("synthetic-signing-secret"), false);
    assert.equal(JSON.stringify(actual).includes(f.issued.token), false);
    assert.equal(JSON.stringify(actual).includes("token_hash"), false);
  }
  assert.equal((await invoke("dest_list", {connectionId: f.second.connection.id})).bindings[0].id, f.binding.id);
  const activity = await invoke("connection_activity", {connectionId: f.issued.connection.id});
  assert.ok(activity.activity.some((row: any) => row.operation === "connection_list"));
  assert.ok(activity.activity.every((row: any) => typeof row.targetLabel === "string" && !Object.hasOwn(row, "arguments")));
  assert.ok(ASSISTANT_CONNECTION_OPERATIONS.every(([name]) => f.operations.inventory().some(op => op.name === name && name.length <= 32)));
  for (const forbidden of ["connection_create", "connection_configure", "connection_rotate", "connector_create", "sub_create", "sub_rotate", "dest_create"]) {
    await assert.rejects(f.call(forbidden), /not registered/);
  }
});

test("current operation/project grants, owner and connection scope guard every observability and recovery path", async t => {
  const f = fixture();
  t.after(async () => {await f.outbound.close(); f.db.close();});
  const foreign = f.db.assistantConnections.create({...f.owner, userId: "different-owner-fixture"}, "Foreign", {operations: "all", projects: "all"});
  for (const [name] of ASSISTANT_CONNECTION_OPERATIONS) {
    if (name === "connection_list" || name === "install_name") continue;
    await assert.rejects(f.call(name, {...f.args, connectionId: foreign.connection.id}), /cannot access/);
  }
  await assert.rejects(f.call("sub_get", {...f.args, subscriptionId: "own-subscription-fixture"}), /not found/);
  await assert.rejects(f.call("delivery_list", {...f.args, subscriptionId: "own-subscription-fixture"}), /not found/);
  await assert.rejects(f.call("delivery_resume", {...f.args, subscriptionId: "own-subscription-fixture", commandId: "wrong"}), /not found/);
  assert.equal(f.receipts.get(f.issued.connection.id, "wrong"), null);
  f.db.assistantConnections.configure(f.issued.connection.id, {operations: ["connection_list"], projects: "all"});
  await assert.rejects(f.call("dest_list", {connectionId: f.second.connection.id}), /excluded/);
  assert.equal((await f.call("connection_list")).connections.length, 2);
  f.db.assistantConnections.configure(f.issued.connection.id, {operations: "all", projects: ["selected-project-fixture"]});
  await assert.rejects(f.call("connection_list"), /excluded/);
  await assert.rejects(f.call("delivery_resume", {...f.args, commandId: "scope"}), /excluded/);
  assert.equal(f.receipts.get(f.issued.connection.id, "scope"), null);
  f.db.assistantConnections.configure(f.issued.connection.id, {operations: "all", projects: "all"});
  f.db.assistantConnections.revoke(f.second.connection.id);
  assert.equal((await f.call("connection_list")).connections.find((c: any) => c.id === f.second.connection.id).revoked, true);
  await assert.rejects(f.call("sub_get", f.args), /cannot access/);
  await assert.rejects(f.call("delivery_resume", {...f.args, commandId: "revoked-target"}), /cannot access/);
  f.db.assistantConnections.rotate(f.issued.connection.id);
  await assert.rejects(f.call("connection_list"), /rotated or revoked/);
});

test("resume uses the owner service, preserves credentials/configuration and fences duplicates and changed previews", async t => {
  const f = fixture();
  t.after(async () => {await f.outbound.close(); f.db.close();});
  f.db.assistantConnections.configure(f.issued.connection.id, {operations: "all", projects: "all", destructiveConfirmation: "confirm"});
  const input = {...f.args, commandId: "resume-fixture"};
  const before = f.db.getOutboundEventSubscription(f.args.subscriptionId)!;
  const first = await f.call("delivery_resume", input);
  assert.equal(first.confirmationRequired, true);
  assert.equal(f.receipts.get(f.issued.connection.id, input.commandId), null);
  assert.equal(f.db.getOutboundEventSubscription(f.args.subscriptionId)!.state, "paused");
  f.db.raw().exec("UPDATE outbound_event_subscriptions SET pause_reason='changed-fixture'");
  await assert.rejects(f.call("delivery_resume", {...input, confirmationId: first.confirmationId}), /confirmation/);
  assert.equal(f.receipts.get(f.issued.connection.id, input.commandId), null);
  const fresh = await f.call("delivery_resume", input);
  const result = await f.call("delivery_resume", {...input, confirmationId: fresh.confirmationId});
  assert.equal(result.receipt.status, "succeeded");
  assert.equal(result.result.state, "active");
  assert.equal(f.db.getOutboundEventSubscriptionRecord(f.args.subscriptionId)!.consecutiveFailures, 0);
  assert.equal(result.result.callbackUrl, before.callbackUrl);
  assert.equal(result.result.generation, before.generation);
  assert.deepEqual(result.result.eventKinds, before.eventKinds);
  // If a completed duplicate ran resume again it would erase this later failure counter.
  f.db.raw().exec("UPDATE outbound_event_subscriptions SET consecutive_failures=2");
  assert.equal((await f.call("delivery_resume", input)).receipt.status, "succeeded");
  assert.equal(f.db.getOutboundEventSubscriptionRecord(f.args.subscriptionId)!.consecutiveFailures, 2);
  await assert.rejects(f.call("delivery_resume", {...input, subscriptionId: "own-subscription-fixture"}), /different operation or request/);
  assert.equal((await f.call("delivery_list", f.args)).length, 0, "resume does not fabricate successful deliveries");
});

test("receipt uncertainty survives reopen and never retries a resumed subscription", async () => {
  const root = mkdtempSync(join(tmpdir(), "assistant-connection-recovery-")), path = join(root, "fixture.sqlite");
  const f = fixture(path), original = f.outbound.resume.bind(f.outbound);
  const input = {...f.args, commandId: "uncertain-fixture"};
  try {
    f.outbound.resume = subscriptionId => {original(subscriptionId); throw new Error("synthetic lost acknowledgement");};
    const result = await f.call("delivery_resume", input);
    assert.equal(result.receipt.status, "uncertain");
    assert.ok(!JSON.stringify(result).includes("synthetic lost acknowledgement"));
    assert.equal(f.db.getOutboundEventSubscription(f.args.subscriptionId)!.state, "active");
    await f.outbound.close(); f.db.close();
    const reopened = ControlPlaneDb.open(path), next = registry(reopened);
    try {
      reopened.raw().exec("UPDATE outbound_event_subscriptions SET consecutive_failures=2");
      const again = await next.operations.call(reopened.assistantConnections.authenticate(f.issued.token)!, "delivery_resume", input) as any;
      assert.equal(again.receipt.status, "uncertain");
      assert.equal(reopened.getOutboundEventSubscriptionRecord(f.args.subscriptionId)!.consecutiveFailures, 2);
      const reconciled = await next.operations.call(reopened.assistantConnections.authenticate(f.issued.token)!, "command_get", {commandId: input.commandId}) as any;
      assert.equal(reconciled.receipt.status, "uncertain");
      assert.equal(reconciled.receipt.operation, "delivery_resume");
    } finally {await next.outbound.close(); reopened.close();}
  } finally {rmSync(root, {recursive: true, force: true});}
});

test("access lost after a resume hides its result but preserves the known effect receipt", async t => {
  const f = fixture(), original = f.outbound.resume.bind(f.outbound);
  t.after(async () => {await f.outbound.close(); f.db.close();});
  f.outbound.resume = subscriptionId => {
    const result = original(subscriptionId);
    f.db.assistantConnections.revoke(f.issued.connection.id);
    return result;
  };
  const result = await f.call("delivery_resume", {...f.args, commandId: "revoke-after-effect"});
  assert.equal(result.result, undefined);
  assert.equal(result.receipt.status, "succeeded");
  assert.equal(f.db.getOutboundEventSubscription(f.args.subscriptionId)!.state, "active");
  await assert.rejects(f.call("connection_list"), /rotated or revoked/);
});

test("delivery status returns real outbox coordinates without event bodies and rechecks target revocation", async t => {
  const f = fixture();
  t.after(async () => {await f.outbound.close(); f.db.close();});
  f.db.registerRunner({runnerId: "runner-fixture", hostname: "fixture", os: "linux", version: "fixture", agents: [], workspaces: []}, 1);
  f.db.createSession({id: "session-fixture", runnerId: "runner-fixture", workspaceId: "workspace-fixture", agentId: "agent-fixture",
    title: "Synthetic Private Task Marker", config: {}, driver: "acp", useWorktree: false, now: 2});
  f.db.assistantWork.track(f.operations, f.second.connection.id, {workId: "work-fixture", sessionId: "session-fixture", bindingId: f.binding.id});
  assert.equal(f.outbound.resume(f.args.subscriptionId).ok, true);
  f.db.updateSessionStatus("session-fixture", "completed", 3);
  const rows = await f.call("delivery_list", f.args);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "session.completed");
  assert.equal(rows[0].status, "pending");
  assert.ok(rows[0].deliveryId && rows[0].eventId);
  assert.ok(!JSON.stringify(rows).includes("Synthetic Private Task Marker"));
  assert.ok(!JSON.stringify(rows).includes("payload_json"));
  assert.ok(!JSON.stringify(rows).includes("synthetic-signing-secret"));
  const original = f.outbound.deliveries.bind(f.outbound);
  f.outbound.deliveries = subscriptionId => {
    const result = original(subscriptionId);
    f.db.assistantConnections.revoke(f.second.connection.id);
    return result;
  };
  await assert.rejects(f.call("delivery_list", f.args), /cannot access/);
});

test("installation rename matches owner validation and keeps a content-free durable receipt", async t => {
  const f = fixture(), app = Fastify();
  t.after(async () => {await app.close(); await f.outbound.close(); f.db.close();});
  registerAssistantRoutes(app, {db: f.db, operations: f.operations, requestHuman: () => f.owner});
  const result = await f.call("install_name", {name: "Fixture Renamed", commandId: "rename-fixture"});
  assert.equal(result.receipt.status, "succeeded");
  assert.equal(result.result.name, "Fixture Renamed");
  assert.ok(!JSON.stringify(f.receipts.get(f.issued.connection.id, "rename-fixture")).includes("Fixture Renamed"));
  await app.inject({method: "POST", url: "/api/assistant-connections/installation", payload: {name: "Owner Later"}});
  assert.equal((await f.call("install_name", {name: "Fixture Renamed", commandId: "rename-fixture"})).receipt.status, "succeeded");
  assert.equal(f.db.assistantConnections.installationName(), "Owner Later");
  assert.equal((await f.call("install_name", {name: "\u0000bad", commandId: "invalid-name"})).receipt.status, "failed");
});
