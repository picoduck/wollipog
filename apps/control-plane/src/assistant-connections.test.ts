import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { ASSISTANT_ACTIVITY_LIMIT, AssistantConnections, AssistantOperations } from "./assistant-connections.js";
import type { HumanPrincipal } from "./identity.js";
import { ControlPlaneDb } from "./db.js";
import { createAssistantOperations, registerAssistantRoutes } from "./assistant-routes.js";
import { hashToken, isAgentControlApiRouteAllowed } from "./auth.js";
import { registerAuthGate } from "./http-auth.js";

const owner: HumanPrincipal = {kind: "human", actorId: "owner", userId: "owner", userName: "Owner", organizationId: "org", organizationName: "Org", role: "owner", deviceId: null, localBootstrap: false};
const full = {operations: "all", projects: "all"} as const;

test("broad grants include new registrations; selected projects and operations refuse exactly", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    AssistantConnections.install(db);
    const store = new AssistantConnections(db);
    const issued = store.create(owner, "Remote Assistant", full);
    const credential = store.authenticate(issued.token)!;
    const operations = new AssistantOperations(store, () => owner);
    operations.register({name: "session_stop", description: "Stop", inputSchema: {}, resolveTarget: () => ({kind: "session", id: "unrelated", projectId: "other"}), ownerCanAccess: p => p.userId === owner.userId, execute: () => "stopped"});
    assert.equal(await operations.call(credential, "session_stop", {}), "stopped");
    store.configure(issued.connection.id, {operations: "all", projects: ["selected"]});
    await assert.rejects(operations.call(credential, "session_stop", {}), /target project is excluded/);
    store.configure(issued.connection.id, {operations: [], projects: "all"});
    await assert.rejects(operations.call(credential, "session_stop", {}), /Operation session_stop is excluded/);
    assert.equal(operations.list(store.current(credential)).length, 0);
    assert.deepEqual(store.activity(issued.connection.id).map(r => (r as {outcome: string}).outcome), ["refused", "refused", "succeeded"]);
    assert.ok(!JSON.stringify(store.activity(issued.connection.id)).includes(issued.token));
    assert.ok(!JSON.stringify(store.list(owner)).includes(hashToken(issued.token)));
  } finally { db.close(); }
});

test("queued work rechecks grants, owner access, rotation and revocation", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    AssistantConnections.install(db);
    const store = new AssistantConnections(db);
    let currentOwner: HumanPrincipal | null = owner;
    const operations = new AssistantOperations(store, () => currentOwner);
    let release!: () => void;
    let entered!: () => void;
    let mutated = false;
    let gate = new Promise<void>(resolve => { release = resolve; });
    let started = new Promise<void>(resolve => { entered = resolve; });
    operations.register({name: "queued_mutation", description: "Queued", inputSchema: {}, resolveTarget: () => ({kind: "session", id: "unrelated", projectId: "p"}), ownerCanAccess: () => true, execute: async (_args, context) => { entered(); await gate; await context.recheck(); mutated = true; }});
    const changes: string[] = [];
    store.onChange(id => changes.push(id));
    for (const action of ["narrow", "rotate", "revoke", "demote"] as const) {
      const issued = store.create(owner, action, full);
      gate = new Promise<void>(resolve => { release = resolve; });
      started = new Promise<void>(resolve => { entered = resolve; });
      const pending = operations.call(store.authenticate(issued.token)!, "queued_mutation", {});
      await started;
      if (action === "narrow") store.configure(issued.connection.id, {operations: [], projects: "all"});
      if (action === "rotate") { const rotated = store.rotate(issued.connection.id); assert.equal(store.authenticate(issued.token), null); assert.ok(store.authenticate(rotated)); }
      if (action === "revoke") { store.revoke(issued.connection.id); assert.equal(store.authenticate(issued.token), null); }
      if (action === "demote") currentOwner = {...owner, role: "viewer"};
      release();
      await assert.rejects(pending, /excluded|rotated or revoked|no longer an active owner/);
      assert.equal(mutated, false);
      currentOwner = owner;
    }
    assert.equal(changes.length, 3);
  } finally { db.close(); }
});

test("rotation refuses inactive IDs without notifications; activity is bounded and indexed per connection", () => {
  const db = new DatabaseSync(":memory:");
  try {
    AssistantConnections.install(db);
    const store = new AssistantConnections(db);
    const first = store.create(owner, "First", full).connection;
    const second = store.create(owner, "Second", full).connection;
    store.record(second, "read", {kind: "project", id: "other"}, "succeeded");
    for (let i = 0; i < ASSISTANT_ACTIVITY_LIMIT + 2; i++) store.record(first, "read", {kind: "project", id: String(i)}, "succeeded");
    assert.equal((db.prepare("SELECT count(*) AS n FROM assistant_activity WHERE connection_id=?").get(first.id) as {n: number}).n, ASSISTANT_ACTIVITY_LIMIT);
    assert.equal(store.activity(second.id).length, 1);
    assert.match(JSON.stringify(db.prepare("EXPLAIN QUERY PLAN SELECT * FROM assistant_activity WHERE connection_id=? ORDER BY id DESC LIMIT 100").all(first.id)), /assistant_activity_connection/);
    store.revoke(first.id);
    let changes = 0;
    store.onChange(() => { changes++; });
    assert.throws(() => store.rotate(first.id), /missing or revoked/);
    assert.throws(() => store.rotate("unknown"), /missing or revoked/);
    assert.equal(changes, 0);
  } finally { db.close(); }
});

test("real Fastify MCP discovery, owner lifecycle API, credential separation and multi-connection isolation", async () => {
  const db = ControlPlaneDb.open(":memory:");
  const app = Fastify();
  try {
    const local = db.localIdentityContext();
    const human = db.operatingHumanPrincipal(local.userId, local.organizationId)!;
    const requestHuman = (req: {headers: {authorization?: string}}) => req.headers.authorization === "Bearer owner-fixture" ? human : null;
    registerAuthGate(app, {authenticate: req => requestHuman(req) ? {id: "fixture", name: "Owner", principal: human} : null, isAllowedOrigin: () => false});
    const operations = createAssistantOperations(db);
    operations.register({name: "void_mutation", description: "Void test", inputSchema: {}, metadata: true, resolveTarget: () => ({kind: "control_plane", id: db.instanceId()}), ownerCanAccess: () => true, execute: () => undefined});
    registerAssistantRoutes(app, {db, operations, requestHuman});
    const created = await app.inject({method: "POST", url: "/api/assistant-connections", headers: {authorization: "Bearer owner-fixture"}, payload: {name: "OpenClaw One", grant: full}});
    assert.equal(created.statusCode, 201);
    assert.equal(created.headers["cache-control"], "no-store");
    const {token, connection} = created.json();
    const second = db.assistantConnections.create(human, "OpenClaw Two", full);
    const call = (method: string, params: unknown = {}, bearer = token) => app.inject({method: "POST", url: "/assistant/mcp", headers: {authorization: `Bearer ${bearer}`}, payload: {jsonrpc: "2.0", id: 1, method, params}});
    assert.equal((await call("initialize")).json().result.protocolVersion, "2025-06-18");
    assert.equal((await call("tools/list")).json().result.tools[0].name, "assistant_discover");
    const discovery = JSON.parse((await call("tools/call", {name: "assistant_discover"})).json().result.content[0].text);
    assert.equal(discovery.controlPlane.id, db.instanceId());
    assert.equal(discovery.connection.id, connection.id);
    assert.equal((await call("tools/list", {}, "owner-fixture")).statusCode, 401);
    assert.equal((await call("tools/list", {}, "session-fixture")).statusCode, 401);
    assert.equal(db.deviceByTokenHash(hashToken(token)), null);
    assert.equal(isAgentControlApiRouteAllowed("POST", "/api/assistant-connections", "orchestrator"), false);
    assert.equal((await app.inject({method: "GET", url: "/api/assistant-connections", headers: {authorization: `Bearer ${token}`}})).statusCode, 401);
    db.assistantConnections.configure(connection.id, {operations: [], projects: "all"});
    assert.equal((await call("tools/call", {name: "assistant_discover"})).json().result.isError, true);
    assert.equal((await call("tools/list")).json().result.tools.length, 0);
    assert.equal((await call("tools/list", {}, second.token)).json().result.tools.length, 2);
    assert.equal((await call("tools/call", {name: "void_mutation"}, second.token)).json().result.content[0].text, "null");
    const rotated = await app.inject({method: "POST", url: `/api/assistant-connections/${connection.id}/rotate`, headers: {authorization: "Bearer owner-fixture"}, payload: {}});
    assert.equal(rotated.statusCode, 200);
    assert.equal((await call("tools/list")).statusCode, 401);
    assert.equal((await call("tools/list", {}, rotated.json().token)).statusCode, 200);
    db.assistantConnections.revoke(connection.id);
    assert.equal((await call("tools/list", {}, rotated.json().token)).statusCode, 401);
    assert.equal((await call("tools/list", {}, second.token)).statusCode, 200);
    assert.equal((await app.inject({method: "GET", url: "/assistant/mcp", headers: {authorization: `Bearer ${second.token}`}})).statusCode, 405);
    const address = await app.listen({host: "127.0.0.1", port: 0});
    const network = await fetch(`${address}/assistant/mcp`, {method: "POST", headers: {authorization: `Bearer ${second.token}`, "content-type": "application/json", accept: "application/json, text/event-stream"}, body: JSON.stringify({jsonrpc: "2.0", id: 2, method: "tools/call", params: {name: "assistant_discover"}})});
    assert.equal(network.status, 200);
    const networkResult = await network.json() as {result: {content: {text: string}[]}};
    assert.equal(JSON.parse(networkResult.result.content[0]!.text).connection.id, second.connection.id);
    const foreignOrigin = await app.inject({method: "POST", url: "/assistant/mcp", headers: {authorization: `Bearer ${second.token}`, origin: "https://foreign.invalid"}, payload: {jsonrpc: "2.0", id: 1, method: "tools/list"}});
    assert.equal(foreignOrigin.statusCode, 403);
    assert.equal((await app.inject({method: "POST", url: "/assistant/mcp", headers: {authorization: `Bearer ${second.token}`, "mcp-protocol-version": "unsupported"}, payload: {jsonrpc: "2.0", id: 1, method: "tools/list"}})).statusCode, 400);
    const operatingHuman = db.operatingHumanPrincipal;
    db.operatingHumanPrincipal = () => ({...human, role: "viewer"});
    for (const method of ["initialize", "tools/list", "ping"]) {
      const refused = (await call(method, {}, second.token)).json();
      assert.equal(refused.error.code, -32001);
      assert.match(refused.error.message, /granting owner is no longer active/);
      assert.equal(refused.result, undefined);
    }
    db.operatingHumanPrincipal = operatingHuman;
  } finally { await app.close(); db.close(); }
});
