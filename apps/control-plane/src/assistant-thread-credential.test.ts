import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import Fastify from "fastify";
import {
  ASSISTANT_THREAD_CREDENTIAL_TTL_MS,
  DEFAULT_ASSISTANT_THREAD_LIMITS,
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
  for (const name of ["auto_create", "session_role", "session_adopt", "session_fork"]) {
    operations.register({ name, description: "fixture", inputSchema: { type: "object" }, metadata: true,
      resolveTarget: () => ({ kind: "fixture", id: name }), ownerCanAccess: () => true, execute: () => ({ done: true }) });
  }
  const project = db.createProject({ name: "Work" });
  const location = db.addProjectLocation(project.id, { runnerId: "r", workspaceId: "w" });
  registerAssistantRoutes(app, { db, operations, requestHuman: (req) => req.headers.authorization === "Bearer owner" ? owner : null });
  registerAssistantThreadRoutes(app, { threads, requestHuman: (req) => req.headers.authorization === "Bearer owner" ? owner : null });
  await app.ready();
  const ownerCall = async (method: "GET" | "POST" | "PUT", url: string, payload?: object) => {
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
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd);
    const start = h.toRunner.find((message) => message.type === "start_session" && message.spec.sessionId === thread.sessionId);
    assert.ok(start?.type === "start_session" && start.spec.assistant?.guide?.includes("## Discover First"));

    const env = await h.provision(thread.sessionId);
    const first = resultOf((await h.callTools(env, launch(1, h.location.id)))[0]);
    assert.equal(first.receipt.status, "succeeded", JSON.stringify(first));
    const launched = h.db.getSession(first.sessionId)!;
    assert.equal(launched.costBudgetUsd, DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd, "a launch is capped at what the thread has left");
    assert.equal(first.threadBudget.costBudgetUsd, 25);
    assert.match(first.threadBudget.explanation, /\$25\.00 cost cap.*thread's budget/);
    let view = (await h.ownerCall("GET", `/api/assistant-threads/${thread.id}`)).body.thread as AssistantThread;
    assert.deepEqual(view.launchedSessionIds, [first.sessionId]);
    assert.deepEqual(view.usage?.launchedSessions, { used: 1, limit: DEFAULT_ASSISTANT_THREAD_LIMITS.launchedSessions });

    // Reaching the launch limit stops further launches with a clear message, and creates nothing.
    for (let index = 1; index < DEFAULT_ASSISTANT_THREAD_LIMITS.launchedSessions; index++) h.db.assistantThreads.recordLaunch(thread.id, `s_prior_${index}`, Date.now());
    const sessionsBefore = h.db.listSessions({ includeArchived: true }).length;
    const refused = resultOf((await h.callTools(env, launch(2, h.location.id)))[0]);
    assert.equal(refused.receipt.status, "failed");
    assert.match(refused.error, /has launched 10 of the 10 sessions it may launch/);
    assert.equal(h.db.listSessions({ includeArchived: true }).length, sessionsBefore);

    // Spend and committed budgets stop launches too.
    const spender = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const spenderEnv = await h.provision(spender.sessionId);
    h.db.raw().prepare("UPDATE sessions SET cost_usd=? WHERE id=?").run(DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd - 8, spender.sessionId);
    // A zero or negative requested budget still gets a cap, never "no budget".
    const zero = { ...launch(3, h.location.id) };
    zero.params.arguments = { ...zero.params.arguments, config: { costBudgetUsd: 0 } } as typeof zero.params.arguments;
    const capped = resultOf((await h.callTools(spenderEnv, zero))[0]);
    assert.equal(h.db.getSession(capped.sessionId)!.costBudgetUsd, 8);
    assert.equal(capped.threadBudget.costBudgetUsd, 8);
    // The cap is taken from the backing assistant's own allowance, so the two caps sum to the budget.
    assert.equal(h.db.getSession(spender.sessionId)!.costBudgetUsd, DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd - 8);
    // That cap is held: nothing is left for another launch even before the first one spends.
    const committed = resultOf((await h.callTools(spenderEnv, launch(4, h.location.id)))[0]);
    assert.match(committed.error, /has spent or committed its whole \$25 budget/);
    // A launched session's own children count against the thread's spend.
    h.db.createSession({ id: "s_grandchild", parentSessionId: capped.sessionId, runnerId: "r", workspaceId: "w", agentId: "claude",
      title: "Child", driver: "claude-code", useWorktree: false, config: {}, now: Date.now() });
    h.db.raw().prepare("UPDATE sessions SET cost_usd=? WHERE id=?").run(3, "s_grandchild");
    view = (await h.ownerCall("GET", `/api/assistant-threads/${spender.id}`)).body.thread as AssistantThread;
    assert.deepEqual(view.usage?.costUsd, { used: 20, limit: DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd });
  } finally { await h.close(); }
});

test("the owner can raise exhausted thread limits, but cannot lower the budget past commitments", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const edit = `/api/assistant-threads/${thread.id}/limits`;
    const env = await h.provision(thread.sessionId);
    const run = async (id: number) => resultOf((await h.callTools(env, launch(id, h.location.id)))[0]);
    assert.equal((await h.ownerCall("PUT", edit, { costUsd: 10, launchedSessions: 1 })).status, 200);
    h.db.raw().prepare("UPDATE sessions SET cost_usd=1.13 WHERE id=?").run(thread.sessionId);
    const first = await run(51);
    assert.equal(first.threadBudget.costBudgetUsd, 8.87);
    assert.equal(h.db.getSession(first.sessionId)!.costBudgetUsd, 8.87);
    assert.match((await run(52)).error, /1 of the 1 sessions/);
    assert.equal((await h.ownerCall("PUT", edit, { costUsd: 10, launchedSessions: null })).status, 200);
    assert.match((await run(53)).error, /whole \$10 budget/);
    const tooLow = await h.ownerCall("PUT", edit, { costUsd: 9.99, launchedSessions: 0 });
    assert.equal(tooLow.status, 409);
    assert.match(tooLow.body.error, /already spent or committed \$10\.00/);
    assert.equal(h.threads.get(h.owner, thread.id).usage!.launchedSessions.limit, null, "a refused budget leaves both limits intact");
    assert.equal((await h.ownerCall("PUT", edit, { costUsd: 14, launchedSessions: null })).status, 200);
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, 5.13);
    const next = await run(54);
    assert.equal(next.threadBudget.costBudgetUsd, 4);
    assert.equal(h.db.getSession(next.sessionId)!.costBudgetUsd, 4);
    assert.deepEqual(h.threads.get(h.owner, thread.id).usage, {
      costUsd: { used: 1.13, limit: 14 }, launchedSessions: { used: 2, limit: null },
    });
  } finally { await h.close(); }
});

test("removing a thread budget removes implicit caps and keeps explicitly requested caps", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const edit = `/api/assistant-threads/${thread.id}/limits`;
    const env = await h.provision(thread.sessionId);
    assert.equal((await h.ownerCall("PUT", edit, { costUsd: null, launchedSessions: 2 })).status, 200);
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, null);
    assert.ok(h.toRunner.some((message) => message.type === "rearm_governance" &&
      message.sessionId === thread.sessionId && message.config.costBudgetUsd === null));
    const unbounded = resultOf((await h.callTools(env, launch(61, h.location.id)))[0]);
    assert.equal(unbounded.threadBudget.costBudgetUsd, null);
    assert.match(unbounded.threadBudget.explanation, /thread has no budget and none was requested/);
    assert.equal(h.db.getSession(unbounded.sessionId)!.costBudgetUsd, null);
    const explicit = launch(62, h.location.id);
    Object.assign(explicit.params.arguments, { config: { costBudgetUsd: 7.50 } });
    const capped = resultOf((await h.callTools(env, explicit))[0]);
    assert.equal(h.db.getSession(capped.sessionId)!.costBudgetUsd, 7.50);
    assert.equal(capped.threadBudget, undefined);
    assert.match(resultOf((await h.callTools(env, launch(63, h.location.id)))[0]).error, /2 of the 2 sessions/);

    const refused = await h.ownerCall("PUT", edit, { costUsd: 20, launchedSessions: null });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /work launched without a cost cap/);
    // A root capped later can still have descendants launched before it acquired that cap.
    assert.equal(h.svc.setConfig(unbounded.sessionId, { costBudgetUsd: 5 }).ok, true);
    assert.equal((await h.ownerCall("PUT", edit, { costUsd: 20, launchedSessions: null })).status, 409);
    h.db.deleteSession(unbounded.sessionId);
    // A capped launch might predate allowance persistence. Its current cap is still proof.
    h.db.raw().prepare("UPDATE assistant_thread_members SET allowance_usd=NULL WHERE session_id=?").run(capped.sessionId);
    const restored = await h.ownerCall("PUT", edit, { costUsd: 20, launchedSessions: null });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, 12.50);
    assert.equal(restored.body.thread.usage.launchedSessions.used, 2, "deletion does not refund a launch");
  } finally { await h.close(); }
});

test("restoring a thread budget preserves the owner's backing session cap", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const edit = `/api/assistant-threads/${thread.id}/limits`;
    assert.equal((await h.ownerCall("PUT", edit, { costUsd: null, launchedSessions: 10 })).status, 200);
    assert.equal(h.svc.setConfig(thread.sessionId, { costBudgetUsd: 25 }).ok, true);
    assert.equal((await h.ownerCall("PUT", edit, { costUsd: 60, launchedSessions: 10 })).status, 200);
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, 25);
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

test("a thread cannot schedule work or use owner-only session operations", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    const [scheduled] = await h.callTools(env, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "auto_create", arguments: {} } });
    assert.equal(scheduled.result.isError, true);
    assert.match(scheduled.result.content[0].text, /cannot call auto_create/);
    const issued = h.db.assistantConnections.create(h.owner, "Outside Assistant", { operations: "all", projects: "all" });
    for (const name of ["session_role", "session_adopt", "session_fork"]) {
      assert.throws(() => h.operations.authorize(thread.connectionId!, name, { kind: "fixture", id: name }), /Wollipog Assistant thread cannot call/u, name);
      assert.doesNotThrow(() => h.operations.authorize(issued.connection.id, name, { kind: "fixture", id: name }), name);
    }
    // The same operation is fine for an owner-issued connection.
    assert.equal(h.db.assistantConnections.get(issued.connection.id)!.threadId, undefined);
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
    assert.deepEqual(view.usage?.costUsd, { used: 11, limit: DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd });
    // Deletion freed none of the budget: what the worker spent is still held.
    assert.ok(h.db.assistantThreads.costs(thread.id).launchedHeldUsd >= 10);
  } finally { await h.close(); }
});

const launchWith = (id: number, locationId: string, extra: Record<string, unknown>) => {
  const message = launch(id, locationId);
  message.params.arguments = { ...message.params.arguments, ...extra } as typeof message.params.arguments;
  return message;
};

test("a refused launch reserves nothing, and an unspent deleted launch gives its cap back", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    const refused = resultOf((await h.callTools(env, launchWith(21, h.location.id, { agentId: "no-such-agent" })))[0]);
    assert.equal(refused.receipt.status, "failed");
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd, "the backing allowance is untouched");
    const worker = resultOf((await h.callTools(env, launchWith(22, h.location.id, { config: { costBudgetUsd: 10 } })))[0]);
    assert.equal(h.db.getSession(worker.sessionId)!.costBudgetUsd, 10, "the corrected launch gets its full request");
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, 15);
    // Deleting the worker before it spent anything releases its cap at the next admission.
    assert.equal(h.svc.delete(worker.sessionId).ok, true);
    const next = resultOf((await h.callTools(env, launch(23, h.location.id)))[0]);
    assert.equal(h.db.getSession(next.sessionId)!.costBudgetUsd, DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd);
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, 0.01, "the new launch holds the rest; the assistant keeps nothing extra");
  } finally { await h.close(); }
});

test("a deleted descendant's spend stays inside its tree's commitment", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    const worker = resultOf((await h.callTools(env, launchWith(31, h.location.id, { config: { costBudgetUsd: 10 } })))[0]);
    h.db.createSession({ id: "s_tree_child", parentSessionId: worker.sessionId, runnerId: "r", workspaceId: "w", agentId: "claude",
      title: "Child", driver: "claude-code", useWorktree: false, config: {}, now: Date.now() });
    h.db.raw().prepare("UPDATE sessions SET cost_usd=5 WHERE id=?").run("s_tree_child");
    assert.deepEqual(h.db.assistantThreads.costs(thread.id), { spentUsd: 5, backingSpentUsd: 0, launchedHeldUsd: 10 });
    assert.equal(h.svc.delete("s_tree_child").ok, true);
    assert.deepEqual(h.db.assistantThreads.costs(thread.id), { spentUsd: 5, backingSpentUsd: 0, launchedHeldUsd: 10 });
    const other = resultOf((await h.callTools(env, launch(32, h.location.id)))[0]);
    assert.equal(h.db.getSession(other.sessionId)!.costBudgetUsd, 15, "the other $15 is still available");
  } finally { await h.close(); }
});

test("removing a worker's Machine keeps the thread's spend", async () => {
  const h = await harness();
  try {
    h.db.registerRunner({ runnerId: "r2", hostname: "second", os: "linux", version: "fixture",
      workspaces: [{ id: "w2", name: "Other", path: "/fixture/other" }], agents: [claude] }, Date.now(), PROTOCOL_VERSION);
    const project = h.db.createProject({ name: "Elsewhere" });
    const remote = h.db.addProjectLocation(project.id, { runnerId: "r2", workspaceId: "w2" });
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    const worker = resultOf((await h.callTools(env, launch(41, remote.id)))[0]);
    assert.equal(h.db.getSession(worker.sessionId)!.runnerId, "r2");
    h.db.raw().prepare("UPDATE sessions SET cost_usd=7 WHERE id=?").run(worker.sessionId);
    assert.ok(h.db.deleteRunner("r2"));
    assert.equal(h.db.getSession(worker.sessionId), null);
    assert.equal(h.db.assistantThreads.costs(thread.id).spentUsd, 7);
  } finally { await h.close(); }
});

test("a deleted root keeps its cap held while its tree lives, and the owner's ceiling is never raised", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    const worker = resultOf((await h.callTools(env, launchWith(51, h.location.id, { config: { costBudgetUsd: 10 } })))[0]);
    h.db.createSession({ id: "s_live_child", parentSessionId: worker.sessionId, runnerId: "r", workspaceId: "w", agentId: "claude",
      title: "Child", driver: "claude-code", useWorktree: false, config: {}, now: Date.now() });
    assert.equal(h.svc.delete(worker.sessionId).ok, true);
    assert.equal(h.db.assistantThreads.costs(thread.id).launchedHeldUsd, 10, "the child still runs under the deleted root's cap");
    assert.equal(h.svc.delete("s_live_child").ok, true);
    assert.equal(h.db.assistantThreads.costs(thread.id).launchedHeldUsd, 0, "with no member left, only spend is held");

    // The owner sets their own lower ceiling; the thread lowers below it but never raises above it.
    assert.equal(h.svc.setConfig(thread.sessionId, { costBudgetUsd: 12 }).ok, true);
    const small = resultOf((await h.callTools(env, launchWith(52, h.location.id, { config: { costBudgetUsd: 5 } })))[0]);
    assert.equal(h.db.getSession(small.sessionId)!.costBudgetUsd, 5);
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, 12, "25 - 5 = 20 would exceed the owner's 12");
    assert.equal(h.svc.delete(small.sessionId).ok, true);
    const next = resultOf((await h.callTools(env, launchWith(53, h.location.id, { config: { costBudgetUsd: 1 } })))[0]);
    assert.equal(next.receipt.status, "succeeded");
    assert.ok(h.db.getSession(thread.sessionId)!.costBudgetUsd! <= 12, "the owner's ceiling still holds after rebalancing");
  } finally { await h.close(); }
});

test("round-4 scenario: the owner's $10 ceiling survives two launches, their deletion and an invalid launch", async () => {
  const h = await harness();
  try {
    const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const env = await h.provision(thread.sessionId);
    assert.equal(h.svc.setConfig(thread.sessionId, { costBudgetUsd: 10 }).ok, true);
    const first = resultOf((await h.callTools(env, launchWith(61, h.location.id, { config: { costBudgetUsd: 10 } })))[0]);
    const second = resultOf((await h.callTools(env, launchWith(62, h.location.id, { config: { costBudgetUsd: 10 } })))[0]);
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, 5);
    assert.equal(h.svc.delete(first.sessionId).ok, true);
    assert.equal(h.svc.delete(second.sessionId).ok, true);
    const invalid = resultOf((await h.callTools(env, launchWith(63, h.location.id, { agentId: "no-such-agent" })))[0]);
    assert.equal(invalid.receipt.status, "failed");
    assert.ok(h.db.getSession(thread.sessionId)!.costBudgetUsd! <= 10, "the owner's ceiling is never exceeded");
    assert.equal(h.db.getSession(thread.sessionId)!.costBudgetUsd, 10, "and the unspent launches' caps come back up to it");
  } finally { await h.close(); }
});

/** A thread with one launched worker, and agent-created children allowed without an approval card. */
async function treeHarness(workerConfig: Record<string, unknown>) {
  const h = await harness();
  const thread = (await h.ownerCall("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
  const env = await h.provision(thread.sessionId);
  const worker = resultOf((await h.callTools(env, launchWith(71, h.location.id, { config: workerConfig })))[0]).sessionId as string;
  h.db.updateSessionStatus(worker, "running", Date.now());
  assert.ok(h.svc.upsertGovernancePolicy({ policyId: "allow-child-spawn", name: "Allow Child Sessions", effect: "allow", priority: 100,
    enabled: true, scope: { toolName: "wollipog.create_session" } }).ok);
  const spawn = (parentSessionId: string, config?: Record<string, unknown>) => {
    const created = h.svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "claude", ...(config ? { config } : {}) },
      undefined, undefined, false, false, false, { parentSessionId });
    if (created.ok) h.db.updateSessionStatus(created.data!.id, "running", Date.now());
    return created;
  };
  const cap = (id: string) => h.db.getSession(id)!.costBudgetUsd!;
  // Every cap in the thread: its backing assistant's and every member of every launched tree's.
  const capsTotal = () => {
    const members = h.db.raw().prepare("SELECT session_id FROM assistant_thread_members WHERE thread_id=?").all(thread.id) as Array<{ session_id: string }>;
    return Math.round((cap(thread.sessionId) + members.reduce((sum, member) => sum + cap(member.session_id), 0)) * 100) / 100;
  };
  return { ...h, thread, env, worker, spawn, cap, capsTotal };
}

test("#4671: a launched worker's children are carved out of its own cap, so the thread's caps total its budget", async () => {
  // Before #4671: backing $15 + worker $10 + two $5 children = $35 of caps under a $25 thread.
  const h = await treeHarness({ costBudgetUsd: 10, maxChildSessions: 2 });
  try {
    assert.equal(h.cap(h.thread.sessionId), 15);
    const first = h.spawn(h.worker), second = h.spawn(h.worker);
    assert.ok(first.ok && second.ok, first.error ?? second.error ?? "");
    // Each default child takes one share, and the worker keeps one for its own spending.
    assert.equal(first.data!.costBudgetUsd, 3.33);
    assert.equal(second.data!.costBudgetUsd, 3.33);
    assert.equal(h.cap(h.worker), 3.34);
    assert.equal(h.capsTotal(), DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd);
    assert.equal(h.db.assistantThreads.costs(h.thread.id).launchedHeldUsd, 10, "the tree still holds its whole launched cap");

    // Another launch must not reclaim what the carved worker gave its children.
    const another = resultOf((await h.callTools(h.env, launchWith(72, h.location.id, { config: { costBudgetUsd: 1 } })))[0]);
    assert.equal(another.receipt.status, "succeeded", JSON.stringify(another));
    assert.equal(h.cap(h.thread.sessionId), 14);
    assert.equal(h.db.assistantThreads.costs(h.thread.id).launchedHeldUsd, 11);
    assert.equal(h.capsTotal(), DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd);

    // Deleting the carved worker while its children run keeps their part held too.
    assert.equal(h.svc.delete(h.worker).ok, true);
    assert.equal(h.db.assistantThreads.costs(h.thread.id).launchedHeldUsd, 11);
    const after = resultOf((await h.callTools(h.env, launchWith(73, h.location.id, {})))[0]);
    assert.equal(after.receipt.status, "succeeded", JSON.stringify(after));
    assert.equal(h.cap(after.sessionId), 14, "only the backing assistant's unheld $14 is launched");
    assert.equal(h.cap(h.thread.sessionId), 0.01);
  } finally { await h.close(); }
});

test("#4671: children created anywhere in a thread's tree never take the caps above its budget", async () => {
  const h = await treeHarness({ costBudgetUsd: 10 });
  try {
    // Three generations below the worker, each session creating a default child and a $2 request.
    const created: string[] = [];
    let generation = [h.worker];
    for (let depth = 0; depth < 3; depth++) {
      const next: string[] = [];
      for (const parent of generation) {
        for (const config of [{ maxChildSessions: 2 }, { costBudgetUsd: 2, maxChildSessions: 2 }]) {
          const child = h.spawn(parent, config);
          assert.ok(child.ok, child.error ?? "");
          created.push(child.data!.id);
          next.push(child.data!.id);
          assert.ok(h.capsTotal() <= DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd + 1e-9, `caps total ${h.capsTotal()} after ${created.length} children`);
        }
      }
      generation = next;
    }
    assert.equal(created.length, 14);
    // Every creation moved cents from its creator to the child, so nothing was lost or added.
    assert.equal(h.capsTotal(), DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd);
    for (const id of created) assert.ok(h.cap(id) >= 0.01, "every child is capped");
  } finally { await h.close(); }
});

test("#4671: a fully reserved creator is refused clearly, and a finished child's unspent cap comes back", async () => {
  const h = await treeHarness({ costBudgetUsd: 10, maxChildSessions: 2 });
  try {
    const child = h.spawn(h.worker, { costBudgetUsd: 3 });
    assert.ok(child.ok, child.error ?? "");
    assert.equal(h.cap(h.worker), 7);
    // The worker spends what it kept: nothing is left to share with another child.
    h.db.addSessionUsage(h.worker, { costUsd: 7 }, Date.now());
    const refused = h.spawn(h.worker);
    assert.equal(refused.status, 409);
    assert.match(refused.error ?? "", /insufficient remaining budget to create a child: \$0\.00 of its \$10\.00 cost budget/);
    assert.match(refused.error ?? "", /Wollipog Assistant thread, whose budget its whole session tree shares/);
    assert.equal(h.capsTotal(), DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd, "the refusal reserved nothing");

    // The child finishes having spent $1: its unspent $2 returns to the worker at the next creation.
    h.db.addSessionUsage(child.data!.id, { costUsd: 1 }, Date.now());
    h.svc.onSessionStatus(child.data!.id, "completed");
    const next = h.spawn(h.worker);
    assert.ok(next.ok, next.error ?? "");
    assert.equal(next.data!.costBudgetUsd, 0.66, "($10 - $7 spent - $1 charged) shared with the worker");
    assert.equal(h.cap(h.worker), 8.34, "$10 less the finished child's $1 and the new child's $0.66");
  } finally { await h.close(); }
});

test("#4671: restarting a finished child takes its unspent cap back out of its creator's", async () => {
  const h = await treeHarness({ costBudgetUsd: 10, maxChildSessions: 2 });
  try {
    const child = h.spawn(h.worker, { costBudgetUsd: 3 });
    assert.ok(child.ok, child.error ?? "");
    h.db.addSessionUsage(child.data!.id, { costUsd: 1 }, Date.now());
    h.svc.onSessionStatus(child.data!.id, "stopped");
    // While the worker has spent most of what it kept, it cannot cover the child's unspent $2.
    h.db.addSessionUsage(h.worker, { costUsd: 7.5 }, Date.now());
    const refused = h.svc.restart(child.data!.id);
    assert.equal(refused.status, 409);
    assert.match(refused.error ?? "", /restarting this child re-reserves \$2\.00/);
    assert.equal(h.cap(h.worker), 9, "the refusal only settled the finished child's $1");

    const other = await treeHarness({ costBudgetUsd: 10, maxChildSessions: 2 });
    try {
      const finished = other.spawn(other.worker, { costBudgetUsd: 3 });
      assert.ok(finished.ok, finished.error ?? "");
      other.db.addSessionUsage(finished.data!.id, { costUsd: 1 }, Date.now());
      other.svc.onSessionStatus(finished.data!.id, "stopped");
      const restarted = other.svc.restart(finished.data!.id);
      assert.ok(restarted.ok, restarted.error ?? "");
      assert.equal(other.cap(other.worker), 7, "the restarted child holds its $3 again");
      assert.equal(other.capsTotal(), DEFAULT_ASSISTANT_THREAD_LIMITS.costUsd);
    } finally { await other.close(); }
  } finally { await h.close(); }
});

test("#4671: the owner's lower cap on a worker is kept, and agents cannot raise a tree member's cap", async () => {
  const h = await treeHarness({ costBudgetUsd: 10 });
  try {
    assert.ok(h.svc.setConfig(h.worker, { costBudgetUsd: 6 }).ok);
    const child = h.spawn(h.worker, { costBudgetUsd: 1 });
    assert.ok(child.ok, child.error ?? "");
    assert.equal(h.cap(h.worker), 6, "$10 - $1 = $9 would exceed the owner's $6");
    const agent = { kind: "agent" as const, id: h.worker };
    const raised = h.svc.setConfig(child.data!.id, { costBudgetUsd: 50 }, agent);
    assert.equal(raised.status, 403);
    assert.match(raised.error ?? "", /An agent may only lower its cost budget/);
    assert.equal(h.svc.setConfig(child.data!.id, { costBudgetUsd: 0 }, agent).status, 403, "nor clear it");
    assert.ok(h.svc.setConfig(child.data!.id, { costBudgetUsd: 0.5 }, agent).ok, "lowering is allowed");
  } finally { await h.close(); }
});
