import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import Fastify from "fastify";
import {
  ASSISTANT_THREAD_CREDENTIAL_TTL_MS,
  PROTOCOL_VERSION,
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  type AgentDefinition,
  type AssistantThread,
  type ControlPlaneToRunner,
} from "@wollipog/protocol";
import { AssistantProxies } from "../../runner/src/assistant-proxy.js";
import { runAssistantMcp } from "../../runner/src/assistant-mcp.js";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { createAssistantThreads } from "./assistant-threads.js";
import { registerAssistantThreadRoutes } from "./assistant-thread-routes.js";
import { createAssistantOperations, registerAssistantRoutes } from "./assistant-routes.js";
import type { HumanPrincipal } from "./identity.js";

const claude: AgentDefinition = { id: "claude", name: "Claude", driver: "claude-code", context: { kind: "native" }, command: "claude", args: [], env: {}, available: true,
  capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true, permissionModes: ["default"] } };

/** The real thread service, `/assistant/mcp` route and runner proxy, joined by an in-memory socket. */
async function harness(protocolVersion = PROTOCOL_VERSION) {
  const db = ControlPlaneDb.open(":memory:"), identity = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(identity.userId, identity.organizationId)!;
  db.registerRunner({ runnerId: "r", hostname: "fixture", os: "linux", version: "fixture",
    workspaces: [{ id: "w", name: "Home", path: "/fixture/home" }], agents: [claude] }, Date.now(), protocolVersion);
  const hub = new Hub(db), toRunner: ControlPlaneToRunner[] = [];
  hub.isRunnerOnline = () => true;
  hub.sendToRunner = (_id, message) => { toRunner.push(message); return true; };
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const threads = createAssistantThreads(db, hub, svc);
  const app = Fastify();
  const operations = createAssistantOperations(db);
  registerAssistantRoutes(app, { db, operations, requestHuman: (req) => req.headers.authorization === "Bearer owner" ? owner : null });
  registerAssistantThreadRoutes(app, { threads, requestHuman: (req) => req.headers.authorization === "Bearer owner" ? owner : null });
  await app.ready();
  const ownerCall = async (method: "GET" | "POST", url: string, payload?: object) => {
    const response = await app.inject({ method, url, headers: { authorization: "Bearer owner" }, ...(payload ? { payload } : {}) });
    return { status: response.statusCode, body: response.json() as any };
  };
  // The runner's proxy, talking to the real route.
  const proxyFetch = (async (url: URL, init?: RequestInit) => {
    const response = await app.inject({ method: "POST", url: url.pathname, headers: init?.headers as Record<string, string>, payload: String(init?.body) });
    return new Response(response.statusCode === 202 ? null : response.body, { status: response.statusCode });
  }) as unknown as typeof globalThis.fetch;
  let runnerId = "r";
  const proxies: AssistantProxies = new AssistantProxies({
    fetch: proxyFetch,
    ackTimeoutMs: 1_000,
    register: (sessionId, tokenHash) => queueMicrotask(() => {
      const answer = threads.registerCredential(runnerId, sessionId, tokenHash);
      proxies.acknowledge(sessionId, tokenHash, answer.accepted, answer.expiresAt, answer.error);
    }),
  });
  const callTools = async (env: Record<string, string>, ...messages: object[]) => {
    const input = new PassThrough(), output = new PassThrough();
    let written = "";
    output.on("data", (chunk) => { written += String(chunk); });
    const done = runAssistantMcp(env, input, output);
    for (const message of messages) input.write(`${JSON.stringify(message)}\n`);
    input.end();
    await done;
    return written.split("\n").filter(Boolean).map((line) => JSON.parse(line)).sort((a, b) => a.id - b.id);
  };
  const provision = async (sessionId: string) => {
    const relay = await proxies.provision(sessionId, "http://control-plane.invalid");
    return { WOLLIPOG_ASSISTANT_RELAY_ENDPOINT: relay.endpoint, WOLLIPOG_ASSISTANT_RELAY_KEY: relay.relayKey };
  };
  return { db, owner, svc, threads, toRunner, ownerCall, proxies, provision, callTools, setRunner: (id: string) => { runnerId = id; },
    close: async () => { await proxies.closeAll(); await app.close(); db.close(); } };
}

const discover = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "assistant_discover", arguments: {} } };

test("a thread's session calls its granted tools, authorized live and audited against its own connection", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    assert.match(thread.connectionId ?? "", /^asst_/);
    // Listed in the owner's Assistant connections, attributed to the thread, with no credential.
    const listed = (await h.ownerCall("GET", "/api/assistant-connections")).body.connections as Array<Record<string, unknown>>;
    const connection = listed.find((candidate) => candidate.id === thread.connectionId)!;
    assert.equal(connection.threadId, thread.id);
    assert.deepEqual(connection.grant, { operations: "all", projects: "all", destructiveConfirmation: "confirm" });
    assert.ok(!JSON.stringify(listed).match(/wollipoga_|token_hash|tokenHash/u));
    // The owner cannot rotate it out from under its proxy.
    assert.equal((await h.ownerCall("POST", `/api/assistant-connections/${thread.connectionId}/rotate`)).status, 400);

    const env = await h.provision(thread.sessionId);
    const [listedTools, discovered] = await h.callTools(env, { jsonrpc: "2.0", id: 1, method: "tools/list" }, discover);
    assert.ok(listedTools.result.tools.some((tool: { name: string }) => tool.name === "assistant_discover"));
    const result = JSON.parse(discovered.result.content[0].text);
    assert.equal(result.connection.id, thread.connectionId);
    assert.equal(result.connection.threadId, thread.id);
    const activity = h.db.assistantConnections.activity(thread.connectionId!);
    assert.deepEqual(activity.map((row) => [row.operation, row.outcome]), [["assistant_discover", "succeeded"]]);

    // The grant is read live: excluding the operation refuses the next call and audits it.
    h.db.assistantConnections.configure(thread.connectionId!, { operations: [], projects: "all" });
    const [refused] = await h.callTools(env, discover);
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /excluded/);
    assert.deepEqual(h.db.assistantConnections.activity(thread.connectionId!).map((row) => row.outcome), ["refused", "succeeded"]);
  } finally { await h.close(); }
});

test("only the thread's runner may bind a credential, and an expired one is refused", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    assert.deepEqual(h.threads.registerCredential("other-runner", thread.sessionId, "a".repeat(64)).accepted, false);
    assert.deepEqual(h.threads.registerCredential("r", "s_not_a_thread", "a".repeat(64)).accepted, false);
    const bound = h.threads.registerCredential("r", thread.sessionId, "b".repeat(64));
    assert.equal(bound.accepted, true);
    assert.ok(bound.expiresAt! > Date.now() && bound.expiresAt! <= Date.now() + ASSISTANT_THREAD_CREDENTIAL_TTL_MS);

    const env = await h.provision(thread.sessionId);
    assert.equal((await h.callTools(env, discover))[0].result.isError, undefined);
    // Expire the bound credential: the control plane refuses it, and the proxy binds a fresh one.
    const expiredHash = (h.db.raw().prepare("SELECT token_hash FROM assistant_connections WHERE id=?").get(thread.connectionId) as { token_hash: string }).token_hash;
    h.db.raw().prepare("UPDATE assistant_connections SET expires_at=? WHERE id=?").run(Date.now() - 1, thread.connectionId);
    assert.equal(h.db.assistantConnections.authenticate(null), null);
    const [recovered] = await h.callTools(env, discover);
    assert.equal(recovered.result.isError, undefined);
    const current = h.db.raw().prepare("SELECT token_hash, expires_at FROM assistant_connections WHERE id=?").get(thread.connectionId) as { token_hash: string; expires_at: number };
    assert.notEqual(current.token_hash, expiredHash);
    assert.ok(current.expires_at > Date.now());
    // A refusal of the replacement reaches the assistant: the connection is revoked meanwhile.
    h.db.raw().prepare("UPDATE assistant_connections SET expires_at=? WHERE id=?").run(Date.now() - 1, thread.connectionId);
    h.db.raw().prepare("UPDATE assistant_connections SET revoked=1 WHERE id=?").run(thread.connectionId);
    const [refused] = await h.callTools(env, discover);
    assert.match(refused.error.message, /revoked/);
  } finally { await h.close(); }
});

test("archiving or deleting a thread revokes its credential, stops the proxy and refuses later calls", async () => {
  const h = await harness();
  try {
    const archived = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(archived.sessionId);
    assert.equal((await h.callTools(env, discover))[0].result.isError, undefined);
    const before = h.toRunner.length;
    assert.equal((await h.ownerCall("POST", `/api/assistant-threads/${archived.id}/archive`)).status, 200);
    assert.equal(h.db.assistantConnections.get(archived.connectionId!)!.revoked, true);
    assert.ok(h.toRunner.slice(before).some((message) => message.type === "assistant_credential_revoked" && message.sessionId === archived.sessionId));
    // Even before the runner acts on the message, the control plane refuses the old credential and any new one.
    const [refused] = await h.callTools(env, discover);
    assert.match(refused.error.message, /archived|revoked/);
    await h.proxies.revoke(archived.sessionId);
    const [closed] = await h.callTools(env, discover);
    assert.match(closed.error.message, /proxy is unavailable/);

    const deleted = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const deletedEnv = await h.provision(deleted.sessionId);
    assert.equal((await h.callTools(deletedEnv, discover))[0].result.isError, undefined);
    assert.equal(h.svc.delete(deleted.sessionId).ok, true);
    assert.equal(h.db.assistantConnections.get(deleted.connectionId!)!.revoked, true);
    assert.equal((await h.ownerCall("GET", `/api/assistant-threads/${deleted.id}`)).body.thread.status, "archived");
    assert.ok((await h.callTools(deletedEnv, discover))[0].error);

    // The owner revoking the connection directly also tells the runner.
    const third = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const mark = h.toRunner.length;
    assert.equal((await h.ownerCall("POST", `/api/assistant-connections/${third.connectionId}/revoke`)).status, 200);
    assert.ok(h.toRunner.slice(mark).some((message) => message.type === "assistant_credential_revoked" && message.sessionId === third.sessionId));
  } finally { await h.close(); }
});

test("a runner without the proxy cannot start a thread", async () => {
  const h = await harness(RUNNER_CAPABILITY_MIN_PROTOCOL.assistantRole - 1);
  try {
    const refused = await h.ownerCall("POST", "/api/assistant-threads", {});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.requiredRunnerProtocolVersion, RUNNER_CAPABILITY_MIN_PROTOCOL.assistantRole);
    assert.deepEqual(h.db.assistantConnections.list(h.owner as HumanPrincipal), [], "no connection is left behind");
  } finally { await h.close(); }
});
