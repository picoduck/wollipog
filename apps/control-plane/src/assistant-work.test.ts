import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneDb } from "./db.js";
import { createAssistantOperations, registerAssistantRoutes } from "./assistant-routes.js";
import { registerAssistantWorkOperations, registerAssistantWorkOwnerRoutes } from "./assistant-work-routes.js";
import { installAssistantOutboundScope } from "./assistant-outbound-schema.js";
import { isOrganizationAdministrationRoute } from "./identity.js";
import { OutboundEventsService, resolveOutboundTarget, validatePrivateCallbackAddresses } from "./outbound-events.js";

const destination = {requesterId: "requester-fixture", accountId: "account-fixture", conversationId: "conversation-fixture",
  destination: "channel:123", agentId: "fixture", sessionKey: "agent:fixture:discord:channel:123", projects: "all" as const};
const quiet = {info() {}, warn() {}};
function setup(path = ":memory:") {
  const db = ControlPlaneDb.open(path);
  db.registerRunner({runnerId: "runner-fixture", hostname: "fixture", os: "linux", version: "test",
    workspaces: [{id: "workspace-fixture", name: "Fixture", path: "/fixture"}], agents: []}, 1);
  const local = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(local.userId, local.organizationId)!;
  const connection = db.assistantConnections.create(owner, "Fixture", {operations: "all", projects: "all"});
  const operations = createAssistantOperations(db);
  registerAssistantWorkOperations(db, operations);
  const binding = db.assistantWork.createBinding(owner, connection.connection.id, destination);
  const session = db.createSession({id: "session-fixture", runnerId: "runner-fixture", workspaceId: "workspace-fixture",
    agentId: "agent-fixture", title: "Private Title Fixture", useWorktree: true, driver: "acp", config: {}, now: 2});
  const input = {workId: "work-fixture", sessionId: session.id, bindingId: binding.id};
  return {db, owner, connection, operations, binding, input, session};
}

test("owner bindings and connection-scoped work reject different owners, bindings and correlation reuse", () => {
  const {db, owner, connection, operations, binding, input} = setup();
  try {
    assert.throws(() => db.assistantWork.createBinding({...owner, userId: "another-owner"}, connection.connection.id, destination), /not found/);
    assert.throws(() => db.assistantWork.createBinding(owner, connection.connection.id, {...destination, destination: "arbitrary-url"}), /explicit Discord/);
    assert.throws(() => db.assistantWork.track(operations, connection.connection.id, {...input, bindingId: "missing"}), /binding not found/);
    const work = db.assistantWork.track(operations, connection.connection.id, input);
    assert.deepEqual(db.assistantWork.track(operations, connection.connection.id, input), work);
    assert.throws(() => db.assistantWork.track(operations, connection.connection.id, {...input, operationId: "changed"}), /reused/);
    const other = db.assistantConnections.create(owner, "Other", {operations: "all", projects: "all"});
    assert.equal(db.assistantWork.get(other.connection.id, input.workId), null);
    assert.throws(() => db.assistantWork.track(operations, other.connection.id, input), /binding not found/);
    db.assistantWork.revokeBinding(owner, connection.connection.id, binding.id);
    assert.throws(() => db.assistantWork.authorize(operations, connection.connection.id, input.workId), /binding is unavailable/);
  } finally { db.close(); }
});

test("durable state and uncertain/confirmed reply receipts survive reopen without repeating a send", () => {
  const root = mkdtempSync(join(tmpdir(), "assistant-work-"));
  const path = join(root, "state.sqlite");
  const {db, connection, operations, input} = setup(path);
  const id = connection.connection.id;
  db.assistantWork.track(operations, id, input);
  db.updateSessionStatus(input.sessionId, "completed", 10);
  const before = db.assistantWork.reconcile(operations, id).items[0]!;
  assert.equal(before.status, "completed");
  assert.ok(before.revision > 1);
  assert.deepEqual(db.assistantWork.beginReply(operations, id, input.workId, before.revision), {state: "send"});
  db.close();
  const reopened = ControlPlaneDb.open(path);
  try {
    const registry = createAssistantOperations(reopened);
    registerAssistantWorkOperations(reopened, registry);
    assert.deepEqual(reopened.assistantWork.get(id, input.workId), before);
    assert.deepEqual(reopened.assistantWork.beginReply(registry, id, input.workId, before.revision), {state: "uncertain"});
    assert.throws(() => reopened.assistantWork.confirmReply(registry, id, input.workId, before.revision, "no-receipt"), /message ID/);
    reopened.assistantWork.confirmReply(registry, id, input.workId, before.revision, "456");
    reopened.assistantWork.confirmReply(registry, id, input.workId, before.revision, "456");
    assert.throws(() => reopened.assistantWork.confirmReply(registry, id, input.workId, before.revision, "789"), /conflicts/);
    assert.deepEqual(reopened.assistantWork.beginReply(registry, id, input.workId, before.revision), {state: "confirmed"});
    reopened.assistantConnections.revoke(id);
    assert.throws(() => reopened.assistantWork.authorize(registry, id, input.workId), /revoked/);
  } finally { reopened.close(); rmSync(root, {recursive: true, force: true}); }
});

test("content-minimized work events wake only tracked connections and survive duplicate observations", () => {
  const {db, owner, connection, operations, input} = setup();
  try {
    db.assistantWork.track(operations, connection.connection.id, input);
    const other = db.assistantConnections.create(owner, "Other", {operations: "all", projects: "all"});
    for (const id of [connection.connection.id, other.connection.id]) {
      assert.ok(db.createOutboundEventSubscription({subscriptionId: id, callbackUrl: "http://127.0.0.1/hook", secret: "synthetic",
        scope: {kind: "assistant", connectionId: id}, eventKinds: ["session.completed", "session.input_required"],
        includeSessionName: false, includeQuestionTitle: false, actor: {kind: "human", id: owner.userId}, now: 3}));
    }
    db.setPendingApproval(input.sessionId, {requestId: "question-fixture", occurrenceId: "occurrence-fixture", kind: "question",
      title: "Private question fixture", options: [], async: true});
    const count = db.listOutboundEventDeliveries(connection.connection.id)!.length;
    assert.equal(count, 1, "an asynchronous question wakes tracked work without requiring input_required status");
    db.updateSessionStatus(input.sessionId, "completed", 10);
    db.updateSessionStatus(input.sessionId, "completed", 11);
    assert.equal(db.listOutboundEventDeliveries(connection.connection.id)!.length, count + 1);
    assert.equal(db.listOutboundEventDeliveries(other.connection.id)!.length, 0);
    assert.equal(db.listOutboundEventSubscriptions().length, 0, "global project/automation UI excludes connection-owned subscriptions");
    const payloads = db.raw().prepare("SELECT payload_json FROM outbound_event_deliveries").all() as {payload_json: string}[];
    assert.ok(payloads.every(row => !row.payload_json.includes("Private") && !row.payload_json.includes("requester-fixture") && !row.payload_json.includes("channel:123")));
    const envelope = JSON.parse(payloads.at(-1)!.payload_json);
    assert.equal(envelope.assistant.controlPlaneId, db.instanceId());
    assert.equal(envelope.assistant.work[0].workId, input.workId);
    assert.equal(db.assistantWork.authorizeDelivery(other.connection.id, JSON.stringify(envelope)), false);
    db.assistantConnections.configure(connection.connection.id, {operations: [], projects: "all"});
    assert.equal(db.assistantWork.authorizeDelivery(connection.connection.id, JSON.stringify(envelope)), false);
  } finally { db.close(); }
});

test("current authorization is checked after DNS and a revoked binding prevents any network send", async () => {
  const {db, owner, connection, operations, input, binding} = setup();
  try {
    db.assistantWork.track(operations, connection.connection.id, input);
    db.createOutboundEventSubscription({subscriptionId: "sub-fixture", callbackUrl: "https://events.example.test/hook", secret: "synthetic",
      scope: {kind: "assistant", connectionId: connection.connection.id}, eventKinds: ["session.completed"],
      includeSessionName: false, includeQuestionTitle: false, actor: {kind: "human", id: owner.userId}, now: 3});
    db.updateSessionStatus(input.sessionId, "completed", 10);
    let sent = false;
    const worker = new OutboundEventsService(db, quiet, (async () => {
      db.assistantWork.revokeBinding(owner, connection.connection.id, binding.id);
      return [{address: "93.184.216.34", family: 4}];
    }) as never, async () => { sent = true; return {statusCode: 204}; });
    await worker.tick(11);
    assert.equal(sent, false);
    assert.equal(db.listOutboundEventDeliveries("sub-fixture")![0]!.status, "failed");
    assert.equal(db.listOutboundEventDeliveries("sub-fixture")![0]!.statusCode, undefined, "local authorization failure is not a callback HTTP status");
  } finally { db.close(); }
});

test("private target exceptions require exact owner-configured addresses and never permit metadata or HTTP", async () => {
  assert.equal(validatePrivateCallbackAddresses(["10.23.45.67"]), true);
  for (const addresses of [["169.254.169.254"], ["100.100.100.200"], ["127.0.0.1"], ["0.0.0.0"], ["10.0.0.0/8"], ["10.1.2.3", "10.1.2.3"], ["::ffff:10.1.2.3"], ["0:0:0:0:0:ffff:a01:203"]]) {
    assert.equal(validatePrivateCallbackAddresses(addresses), false);
  }
  const lookup = (async () => [{address: "10.23.45.67", family: 4}]) as never;
  assert.equal((await resolveOutboundTarget("https://events.example.test/hook", lookup)).ok, false);
  assert.equal((await resolveOutboundTarget("https://events.example.test/hook", lookup, ["10.23.45.67"])).ok, true);
  assert.equal((await resolveOutboundTarget("https://events.example.test/hook", lookup, ["10.23.45.68"])).ok, false);
  assert.equal((await resolveOutboundTarget("http://events.example.test/hook", lookup, ["10.23.45.67"])).ok, false);
  const mixed = (async () => [{address: "10.23.45.67", family: 4}, {address: "93.184.216.34", family: 4}]) as never;
  assert.equal((await resolveOutboundTarget("https://events.example.test/hook", mixed, ["10.23.45.67"])).ok, false);
});

test("accepted command origins bind creation atomically and refuse a changed requester or revoked binding", () => {
  const {db, owner, connection, operations, input, binding, session} = setup();
  try {
    const id = connection.connection.id;
    const origin = {commandId: "command-fixture", workId: "launch-work-fixture", bindingId: binding.id, requesterId: destination.requesterId,
      ...(session.projectId ? {projectId: session.projectId} : {})};
    assert.throws(() => db.assistantWork.reserveOrigin(id, {...origin, requesterId: "unbound-requester"}), /authenticated requester/);
    db.raw().exec("SAVEPOINT fixture_receipt");
    db.assistantWork.reserveOrigin(id, origin);
    db.raw().exec("ROLLBACK TO fixture_receipt; RELEASE fixture_receipt");
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM assistant_work_origins").get()!.n, 0);
    db.assistantWork.reserveOrigin(id, origin);
    db.assistantWork.reserveOrigin(id, origin);
    assert.throws(() => db.assistantWork.reserveOrigin(id, {...origin, workId: "changed-work"}), /identity conflicts/);
    const request = {id: "launched-session-fixture", runnerId: "runner-fixture", workspaceId: "workspace-fixture",
      agentId: "agent-fixture", title: "Fixture", useWorktree: true, driver: "acp" as const, config: {}, now: 4,
      assistantWorkOrigin: {connectionId: id, commandId: origin.commandId}};
    const launched = db.createSession(request);
    assert.equal(db.assistantWork.get(id, origin.workId)!.sessionId, launched.id);
    assert.equal(db.assistantWork.get(id, origin.workId)!.operationId, origin.commandId);
    assert.throws(() => db.createSession({...request, id: "different-session-fixture"}), /accepted command origin/);
    assert.equal(db.getSession("different-session-fixture"), null);
    db.assistantWork.reserveOrigin(id, {...origin, commandId: "second-command", workId: "second-work"});
    db.assistantWork.revokeBinding(owner, id, binding.id);
    assert.throws(() => db.createSession({...request, id: "revoked-launch", assistantWorkOrigin: {connectionId: id, commandId: "second-command"}}), /authenticated requester/);
    assert.equal(db.getSession("revoked-launch"), null);
    assert.throws(() => db.assistantWork.authorize(operations, id, origin.workId), /binding is unavailable/);
    assert.equal(db.assistantWork.get(id, input.workId), null);
  } finally { db.close(); }
});

test("source deletion retains a content-free work identity tombstone and prevents late updates or work-ID reassignment", () => {
  const {db, connection, operations, input} = setup();
  try {
    const id = connection.connection.id;
    db.assistantWork.track(operations, id, input);
    const work = db.assistantWork.get(id, input.workId)!;
    db.assistantWork.beginReply(operations, id, input.workId, work.revision);
    assert.doesNotThrow(() => db.deleteSession(input.sessionId));
    assert.ok(db.assistantWork.get(id, input.workId), "the minimal identity survives source cleanup");
    assert.throws(() => db.assistantWork.authorize(operations, id, input.workId), /unavailable/);
    assert.equal(db.assistantWork.reconcile(operations, id).items.length, 0);
    assert.throws(() => db.assistantWork.track(operations, id, {...input, sessionId: "another-session"}), /reused/);
    assert.doesNotThrow(() => db.setPendingApproval(input.sessionId, {requestId: "late-fixture", kind: "question", title: "Stale fixture", options: []}));
  } finally {db.close();}
});

test("reconciliation advances through empty filtered pages without disclosing an unauthorized caller-chosen work ID", () => {
  const {db, owner, connection, operations, input, binding} = setup();
  try {
    const id = connection.connection.id;
    db.assistantWork.track(operations, id, {...input, workId: "private-work-name-fixture"});
    const second = db.assistantWork.createBinding(owner, id, {...destination, destination: "channel:456", sessionKey: "agent:fixture:discord:channel:456"});
    db.assistantWork.track(operations, id, {...input, workId: "visible-work-fixture", bindingId: second.id});
    db.assistantWork.revokeBinding(owner, id, binding.id);
    const first = db.assistantWork.reconcile(operations, id, "", 1);
    assert.deepEqual(first.items, []);
    assert.ok(first.nextAfter);
    assert.equal(first.nextAfter.includes("private"), false);
    // Database maintenance must not change a persisted pagination position.
    db.raw().exec("VACUUM");
    const next = db.assistantWork.reconcile(operations, id, first.nextAfter, 1);
    assert.equal(next.items[0]!.workId, "visible-work-fixture");
    assert.equal(next.nextAfter, null);
    assert.throws(() => db.assistantWork.reconcile(operations, id, "private-work-name-fixture", 1), /returned work cursor/);
  } finally {db.close();}
});

test("MCP work reads and owner callback configuration keep private coordinates out of model results", async () => {
  const {db, owner, connection, operations, input} = setup();
  const app = Fastify();
  const worker = new OutboundEventsService(db, quiet);
  const requestHuman = (req: {headers: {authorization?: string}}) => req.headers.authorization === "Bearer owner-fixture" ? owner : null;
  registerAssistantRoutes(app, {db, operations, requestHuman});
  registerAssistantWorkOwnerRoutes(app, {db, outboundEvents: worker, requestHuman});
  try {
    const bearer = {authorization: `Bearer ${connection.token}`};
    const call = (name: string, args: unknown) => app.inject({method: "POST", url: "/assistant/mcp", headers: bearer,
      payload: {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name, arguments: args}}});
    assert.equal((await call("assistant_work_track", input)).json().result.isError, undefined);
    db.setPendingApproval(input.sessionId, {requestId: "question-fixture", kind: "question", title: "Private question fixture", options: []});
    const response = (await call("assistant_work_read", {sessionId: input.sessionId, workId: input.workId})).json();
    const output = JSON.parse(response.result.content[0].text);
    assert.equal(output.resolution.ordinaryChatGrantsApproval, false);
    assert.ok(output.resolution.requests[0].path.includes("/attention/~"));
    assert.equal(JSON.stringify(output).includes("Private"), false);
    assert.equal(JSON.stringify(output).includes("channel:123"), false);
    assert.equal((await call("assistant_work_read", {sessionId: "wrong-session", workId: input.workId})).json().result.isError, true);
    const path = `/api/assistant-connections/${connection.connection.id}/event-subscriptions`;
    const payload = {callbackUrl: "http://127.0.0.1/hook", eventKinds: ["session.completed"]};
    assert.equal((await app.inject({method: "POST", url: path, headers: bearer, payload})).statusCode, 400);
    assert.equal((await app.inject({method: "POST", url: path, headers: {authorization: "Bearer owner-fixture"}, payload})).statusCode, 200);
    const listed = (await app.inject({method: "GET", url: path, headers: {authorization: "Bearer owner-fixture"}})).json();
    assert.equal(listed.subscriptions.length, 1);
    assert.equal("secret" in listed.subscriptions[0], false);
    const subscription = `${path}/${listed.subscriptions[0].subscriptionId}`;
    const ownerHeaders = {authorization: "Bearer owner-fixture"};
    assert.equal((await app.inject({method: "GET", url: subscription, headers: ownerHeaders})).statusCode, 200);
    assert.equal((await app.inject({method: "GET", url: `${subscription}/deliveries`, headers: ownerHeaders})).statusCode, 200);
    assert.equal((await app.inject({method: "POST", url: `${subscription}/rotate`, headers: ownerHeaders})).statusCode, 200);
    assert.equal((await app.inject({method: "POST", url: `${subscription}/resume`, headers: ownerHeaders})).statusCode, 200);
    const other = db.assistantConnections.create(owner, "Other", {operations: "all", projects: "all"});
    const wrong = `/api/assistant-connections/${other.connection.id}/event-subscriptions/${listed.subscriptions[0].subscriptionId}`;
    assert.equal((await app.inject({method: "POST", url: `${wrong}/rotate`, headers: ownerHeaders})).statusCode, 400);
    assert.equal((await app.inject({method: "DELETE", url: subscription, headers: ownerHeaders})).statusCode, 200);
    assert.equal((await app.inject({method: "GET", url: subscription, headers: ownerHeaders})).statusCode, 400);
  } finally { await app.close(); await worker.close(); db.close(); }
});

test("legacy subscription migration preserves queued delivery identities and foreign-key deletion behavior", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE assistant_connections(id TEXT PRIMARY KEY);
      CREATE TABLE projects(id TEXT PRIMARY KEY);
      CREATE TABLE automations(automation_id TEXT PRIMARY KEY);
      CREATE TABLE outbound_event_subscriptions (
        subscription_id TEXT PRIMARY KEY, scope_kind TEXT CHECK(scope_kind IN ('project','automation')),
        project_id            TEXT,
        automation_id TEXT,
        CHECK ((scope_kind='project' AND project_id IS NOT NULL AND automation_id IS NULL) OR
               (scope_kind='automation' AND automation_id IS NOT NULL AND project_id IS NULL)),
        FOREIGN KEY (project_id) REFERENCES projects(id), FOREIGN KEY (automation_id) REFERENCES automations(automation_id));
      CREATE TABLE outbound_event_deliveries(id TEXT PRIMARY KEY,subscription_id TEXT REFERENCES outbound_event_subscriptions(subscription_id) ON DELETE CASCADE);
      INSERT INTO projects VALUES ('project-fixture');
      INSERT INTO outbound_event_subscriptions VALUES ('subscription-fixture','project','project-fixture',NULL);
      INSERT INTO outbound_event_deliveries VALUES ('delivery-fixture','subscription-fixture');`);
    installAssistantOutboundScope(sql);
    installAssistantOutboundScope(sql);
    assert.equal(sql.prepare("SELECT subscription_id FROM outbound_event_deliveries").get()!.subscription_id, "subscription-fixture");
    assert.equal(sql.prepare("PRAGMA foreign_key_check").all().length, 0);
    sql.prepare("DELETE FROM outbound_event_subscriptions WHERE subscription_id=?").run("subscription-fixture");
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM outbound_event_deliveries").get()!.n, 0);
  } finally { sql.close(); }
});

test("non-personal organization owners can inspect and manage their exact private callback policy through scoped routes", async () => {
  const {db, owner} = setup();
  const app = Fastify();
  db.raw().prepare("INSERT INTO identity_organizations VALUES (?,?,?,?)").run("tenant-fixture", "Tenant Fixture", 1, 1);
  db.raw().prepare("INSERT INTO identity_memberships VALUES (?,?,?,?,?)").run("tenant-fixture", owner.userId, "owner", 1, 1);
  const tenant = db.operatingHumanPrincipal(owner.userId, "tenant-fixture")!;
  const connection = db.assistantConnections.create(tenant, "Tenant Connection", {operations: "all", projects: "all"}).connection;
  const worker = new OutboundEventsService(db, quiet, (async () => [{address: "10.23.45.67", family: 4}]) as never);
  registerAssistantWorkOwnerRoutes(app, {db, outboundEvents: worker, requestHuman: req => req.headers.authorization === "Bearer tenant-fixture" ? tenant : null});
  const path = `/api/assistant-connections/${connection.id}/event-subscriptions`, headers = {authorization: "Bearer tenant-fixture"};
  try {
    assert.equal(isOrganizationAdministrationRoute("/api/assistant-connections/:id/event-subscriptions/:subscriptionId/rotate"), true);
    const created = await app.inject({method: "POST", url: path, headers,
      payload: {callbackUrl: "https://events.example.test/hook", eventKinds: ["session.completed"], privateAddresses: ["10.23.45.67"]}});
    assert.equal(created.statusCode, 200);
    const subscription = `${path}/${created.json().subscription.subscriptionId}`;
    const read = await app.inject({method: "GET", url: subscription, headers});
    assert.deepEqual(read.json().privateAddresses, ["10.23.45.67"]);
    assert.equal("secret" in read.json(), false);
    const rotated = await app.inject({method: "POST", url: `${subscription}/rotate`, headers});
    assert.equal(rotated.statusCode, 200);
    assert.deepEqual(rotated.json().subscription.privateAddresses, ["10.23.45.67"]);
    assert.equal((await app.inject({method: "DELETE", url: subscription, headers})).statusCode, 200);
  } finally {await app.close(); await worker.close(); db.close();}
});
