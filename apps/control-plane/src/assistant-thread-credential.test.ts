import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import Fastify from "fastify";
import {
  ASSISTANT_THREAD_CREDENTIAL_TTL_MS,
  ASSISTANT_THREAD_LIMITS,
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
import { registerAssistantSessionOperations } from "./assistant-session-operations.js";
import { assistantCallContext } from "./assistant-connections.js";
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
  registerAssistantSessionOperations(operations, db, svc);
  // Operations a thread may not call; registered here only to reach the gate.
  for (const name of ["auto_create", "session_role", "session_adopt", "session_fork", "workflow_run"]) {
    operations.register({ name, description: "fixture", inputSchema: { type: "object" }, metadata: true,
      resolveTarget: () => ({ kind: "fixture", id: name }), ownerCanAccess: () => true, execute: () => ({ done: true }) });
  }
  const project = db.createProject({ name: "Work" });
  const location = db.addProjectLocation(project.id, { runnerId: "r", workspaceId: "w" });
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
  return { db, owner, svc, threads, toRunner, ownerCall, proxies, provision, callTools, location, operations, setRunner: (id: string) => { runnerId = id; },
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
    // Outside assistants read the same guide the thread's session was launched with.
    assert.equal(result.skill.name, "wollipog");
    assert.match(result.skill.content, /Never approve, confirm, answer or dismiss anything on the owner's behalf/u);
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

const launch = (id: number, locationId: string) => ({ jsonrpc: "2.0", id, method: "tools/call",
  params: { name: "session_launch", arguments: { commandId: `launch-${id}`, locationId, agentId: "claude", prompt: "Summarize the open pull requests" } } });
const resultOf = (reply: { result: { content: Array<{ text: string }> } }) => JSON.parse(reply.result.content[0]!.text);

test("a thread launches sessions within its limits and the assistant hears why it is stopped", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    // The assistant's own session is capped at the thread budget and carries the shared skill.
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, ASSISTANT_THREAD_LIMITS.costUsd);
    const start = h.toRunner.find((message) => message.type === "start_session" && message.spec.sessionId === thread.sessionId);
    assert.ok(start?.type === "start_session" && start.spec.assistant?.guide?.includes("## Discover First"));

    const env = await h.provision(thread.sessionId);
    const first = resultOf((await h.callTools(env, launch(1, h.location.id)))[0]);
    assert.equal(first.receipt.status, "succeeded", JSON.stringify(first));
    const launched = h.db.getSession(first.sessionId)!;
    assert.equal(launched.costBudgetUsd, ASSISTANT_THREAD_LIMITS.costUsd, "a launch is capped at what the thread has left");
    let view = (await h.ownerCall("GET", `/api/assistant-threads/${thread.id}`)).body.thread as AssistantThread;
    assert.deepEqual(view.launchedSessionIds, [first.sessionId]);
    assert.deepEqual(view.usage?.launchedSessions, { used: 1, limit: ASSISTANT_THREAD_LIMITS.launchedSessions });

    // Reaching the launch limit stops further launches with a clear message, and creates nothing.
    for (let index = 1; index < ASSISTANT_THREAD_LIMITS.launchedSessions; index++) h.db.assistantThreads.recordLaunch(thread.id, `s_prior_${index}`, Date.now());
    const sessionsBefore = h.db.listSessions({ includeArchived: true }).length;
    const refused = resultOf((await h.callTools(env, launch(2, h.location.id)))[0]);
    assert.equal(refused.receipt.status, "failed");
    assert.match(refused.error, /has launched 10 of the 10 sessions it may launch/);
    assert.equal(h.db.listSessions({ includeArchived: true }).length, sessionsBefore);

    // Spend and committed budgets stop launches too.
    const spender = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const spenderEnv = await h.provision(spender.sessionId);
    h.db.raw().prepare("UPDATE sessions SET cost_usd=? WHERE id=?").run(ASSISTANT_THREAD_LIMITS.costUsd - 8, spender.sessionId);
    // A zero or negative requested budget still gets a cap, never "no budget".
    const zero = { ...launch(3, h.location.id) };
    zero.params.arguments = { ...zero.params.arguments, config: { costBudgetUsd: 0 } } as typeof zero.params.arguments;
    const capped = resultOf((await h.callTools(spenderEnv, zero))[0]);
    assert.equal(h.db.getSession(capped.sessionId)!.costBudgetUsd, 8);
    // The cap is taken from the backing assistant's own allowance, so the two caps sum to the budget.
    assert.equal(h.db.getSession(spender.sessionId)!.costBudgetUsd, ASSISTANT_THREAD_LIMITS.costUsd - 8);
    // That cap is held: nothing is left for another launch even before the first one spends.
    const committed = resultOf((await h.callTools(spenderEnv, launch(4, h.location.id)))[0]);
    assert.match(committed.error, /has spent or committed its whole \$25 budget/);
    // A launched session's own children count against the thread's spend.
    h.db.createSession({ id: "s_grandchild", parentSessionId: capped.sessionId, runnerId: "r", workspaceId: "w", agentId: "claude",
      title: "Child", driver: "claude-code", useWorktree: false, config: {}, now: Date.now() });
    h.db.raw().prepare("UPDATE sessions SET cost_usd=? WHERE id=?").run(3, "s_grandchild");
    view = (await h.ownerCall("GET", `/api/assistant-threads/${spender.id}`)).body.thread as AssistantThread;
    assert.deepEqual(view.usage?.costUsd, { used: 20, limit: ASSISTANT_THREAD_LIMITS.costUsd });
  } finally { await h.close(); }
});

test("a thread cannot launch or create an Orchestrator, whose children it could not count", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    const orchestrator = { ...launch(5, h.location.id) };
    orchestrator.params.arguments = { ...orchestrator.params.arguments, config: { permissionMode: "orchestrator" } } as typeof orchestrator.params.arguments;
    const refused = resultOf((await h.callTools(env, orchestrator))[0]);
    assert.match(refused.error, /cannot start an Orchestrator/);
    assert.deepEqual(((await h.ownerCall("GET", `/api/assistant-threads/${thread.id}`)).body.thread as AssistantThread).launchedSessionIds, []);
  } finally { await h.close(); }
});

test("a thread cannot schedule work or start runs that would escape its limits", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    const [scheduled] = await h.callTools(env, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "auto_create", arguments: {} } });
    assert.equal(scheduled.result.isError, true);
    assert.match(scheduled.result.content[0].text, /cannot call auto_create/);
    const issued = h.db.assistantConnections.create(h.owner, "Outside Assistant", { operations: "all", projects: "all" });
    for (const name of ["session_role", "session_adopt", "session_fork", "workflow_run"]) {
      assert.throws(() => h.operations.authorize(thread.connectionId!, name, { kind: "fixture", id: name }), /Wollipog Assistant thread cannot call/u, name);
      assert.doesNotThrow(() => h.operations.authorize(issued.connection.id, name, { kind: "fixture", id: name }), name);
    }
    // The same operation is fine for an owner-issued connection.
    assert.equal(h.db.assistantConnections.get(issued.connection.id)!.threadId, undefined);
    const run = assistantCallContext.run({ connectionId: thread.connectionId! }, () => h.svc.createRun({
      runnerId: "r", workspaceId: "w", agentIds: ["claude"], task: "Fan out" }));
    assert.equal(run.status, 409);
    assert.match(run.error ?? "", /cannot start runs or workflows/);
    // Outside a thread's call the same request is not refused for this reason.
    const ordinary = h.svc.createRun({ runnerId: "r", workspaceId: "w", agentIds: ["claude"], task: "Fan out" });
    assert.doesNotMatch(ordinary.error ?? "", /cannot start runs or workflows/);
  } finally { await h.close(); }
});

test("launched caps come out of the assistant's own allowance, and deleting a session refunds nothing", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    h.db.raw().prepare("UPDATE sessions SET cost_usd=1 WHERE id=?").run(thread.sessionId);
    const worker = resultOf((await h.callTools(env, launch(11, h.location.id)))[0]);
    // $1 spent leaves $24 for the worker, and the assistant may now spend only up to $1 in all.
    assert.equal(h.db.getSession(worker.sessionId)!.costBudgetUsd, 24);
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, 1);
    assert.match(resultOf((await h.callTools(env, launch(12, h.location.id)))[0]).error, /whole \$25 budget/);

    // The worker spends $10 through a child of its own, then both are deleted: the spend stays.
    h.db.createSession({ id: "s_worker_child", parentSessionId: worker.sessionId, runnerId: "r", workspaceId: "w", agentId: "claude",
      title: "Child", driver: "claude-code", useWorktree: false, config: {}, now: Date.now() });
    h.db.raw().prepare("UPDATE sessions SET cost_usd=? WHERE id=?").run(6, worker.sessionId);
    h.db.raw().prepare("UPDATE sessions SET cost_usd=? WHERE id=?").run(4, "s_worker_child");
    const spent = () => ((h.db.assistantThreads.costs(thread.id)));
    assert.equal(spent().spentUsd, 11);
    assert.equal(h.svc.delete(worker.sessionId).ok, true);
    assert.equal(spent().spentUsd, 11, "the deleted worker's spend is kept");
    assert.equal(h.svc.delete("s_worker_child").ok, true);
    assert.equal(spent().spentUsd, 11, "a deleted descendant's spend is kept, even after its parent was deleted first");
    const view = (await h.ownerCall("GET", `/api/assistant-threads/${thread.id}`)).body.thread as AssistantThread;
    assert.deepEqual(view.usage?.costUsd, { used: 11, limit: ASSISTANT_THREAD_LIMITS.costUsd });
    // Deletion freed none of the budget: what the worker spent is still held.
    assert.ok(h.db.assistantThreads.costs(thread.id).launchedHeldUsd >= 10);
  } finally { await h.close(); }
});
