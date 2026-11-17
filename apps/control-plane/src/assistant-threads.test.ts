import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS,
  PROTOCOL_VERSION,
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  type AgentDefinition,
  type AssistantThread,
  type ControlPlaneToUi,
  type RunnerMetadata,
  type StartSessionMessage,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService } from "./sessions.js";
import { createAssistantThreads } from "./assistant-threads.js";
import { assistantThreadStatus } from "./assistant-threads.js";
import { registerAssistantThreadRoutes } from "./assistant-thread-routes.js";
import { isAgentControlApiRouteAllowed } from "./auth.js";
import { SessionRoleConversions } from "./session-role-conversion.js";
import type { HumanPrincipal } from "./identity.js";

class Dashboard {
  readonly messages: ControlPlaneToUi[] = [];
  send(data: string): void { this.messages.push(JSON.parse(data) as ControlPlaneToUi); }
  threads(): AssistantThread[] {
    return this.messages.flatMap((message) => message.type === "assistant_thread_upsert" ? [message.thread] : []);
  }
}

const claude: AgentDefinition = { id: "claude", name: "Claude", driver: "claude-code", context: { kind: "native" }, command: "claude", args: [], env: {}, available: true,
  capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true, permissionModes: ["default"] } };
const codex: AgentDefinition = { id: "codex", name: "Codex", driver: "codex-app-server", context: { kind: "native" }, command: "codex", args: [], env: {}, available: true,
  capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true, permissionModes: ["default"] } };

async function harness(options: { protocolVersion?: number; agents?: AgentDefinition[] } = {}) {
  const db = ControlPlaneDb.open(":memory:"), identity = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(identity.userId, identity.organizationId)!;
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "fixture", os: "linux", version: "fixture",
    workspaces: [{ id: "w", name: "Home", path: "/fixture/home" }], agents: options.agents ?? [claude] };
  db.registerRunner(metadata, Date.now(), options.protocolVersion ?? PROTOCOL_VERSION);
  const hub = new Hub(db), sent: StartSessionMessage[] = [];
  hub.isRunnerOnline = () => true;
  hub.sendToRunner = (_id, message) => { if (message.type === "start_session") sent.push(message); return true; };
  // The owner's dashboard, and another owner's, which must never receive this owner's threads.
  const dashboard = new Dashboard(), stranger = new Dashboard();
  assert.ok(hub.addUiClient(dashboard, { deviceId: "owner-device", principal: owner, close() {} }));
  assert.ok(hub.addUiClient(stranger, { deviceId: "other-device", principal: { ...owner, userId: "usr_other_owner" }, close() {} }));
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const threads = createAssistantThreads(db, hub, svc);
  const app = Fastify();
  let principal: HumanPrincipal | null = owner;
  registerAssistantThreadRoutes(app, { threads, requestHuman: () => principal });
  await app.ready();
  const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: response.statusCode, body: response.json() as any, raw: response.body };
  };
  const sessionCount = () => (db.raw().prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
  return { db, owner, hub, svc, threads, app, sent, dashboard, stranger, call, sessionCount, as: (next: HumanPrincipal | null) => { principal = next; },
    close: async () => { await app.close(); db.close(); } };
}

test("a new thread launches an assistant-role session whose every launch carries the assistant marker", async () => {
  const h = await harness();
  try {
    const created = await h.call("POST", "/api/assistant-threads", { title: "Weekly Cleanup" });
    assert.equal(created.status, 200, created.raw);
    const thread = created.body.thread as AssistantThread;
    assert.match(thread.id, /^thr_/);
    assert.deepEqual({ ...thread, id: undefined, sessionId: undefined, lastActivityAt: undefined, createdAt: undefined }, {
      id: undefined, sessionId: undefined, lastActivityAt: undefined, createdAt: undefined,
      assistant: "wollipog", title: "Weekly Cleanup", harness: "claude-code", status: "working",
      access: { level: "full_access", destructive: "ask" }, connectionId: null, launchedSessionIds: [], archivedAt: null,
    });
    const session = h.db.getSession(thread.sessionId)!;
    assert.equal(session.role, "assistant");
    assert.equal(session.agentId, "claude");
    assert.equal(session.parentSessionId ?? null, null);
    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.sent[0]!.spec.assistant, { threadId: thread.id });
    assert.equal(h.sent[0]!.spec.orchestrator, undefined);
    assert.ok(h.dashboard.threads().some((published) => published.id === thread.id));
    assert.deepEqual(h.stranger.threads(), []);
    // Thread views never carry a credential value or hash.
    assert.doesNotMatch(created.raw, /wollipoga_|token/i);

    // A restart rebuilds the launch from the database and still marks it.
    h.db.updateSessionStatus(thread.sessionId, "completed", Date.now());
    const restarted = h.svc.restart(thread.sessionId, {});
    assert.equal(restarted.ok, true, restarted.error ?? "");
    assert.deepEqual(h.sent.at(-1)!.spec.assistant, { threadId: thread.id });

    const listed = await h.call("GET", "/api/assistant-threads");
    assert.deepEqual(listed.body.threads.map((t: AssistantThread) => t.id), [thread.id]);
    assert.doesNotMatch(listed.raw, /wollipoga_|token/i);
  } finally { await h.close(); }
});

test("an assistant session takes no agent-control routes and keeps its role", async () => {
  const h = await harness();
  try {
    for (const route of ["/api/sessions", "/api/runners", "/api/sessions/:id"]) {
      assert.equal(isAgentControlApiRouteAllowed("GET", route, "normal"), true, route);
      assert.equal(isAgentControlApiRouteAllowed("GET", route, "assistant"), false, route);
    }
    assert.equal(isAgentControlApiRouteAllowed("POST", "/api/sessions", "assistant"), false);
    const { body } = await h.call("POST", "/api/assistant-threads", {});
    const conversions = new SessionRoleConversions(h.db, h.hub);
    const preview = conversions.preview(body.thread.sessionId, "orchestrator", {
      defaults: structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS), source: "system_default", capabilities: {} as never,
    } as never, () => null);
    assert.equal(preview.available, false);
    assert.match(preview.reason!, /keeps its role/);
  } finally { await h.close(); }
});

test("request JSON can never create an assistant-role session", async () => {
  const h = await harness();
  try {
    const refused = h.svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "claude", role: "assistant" });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 400);
    assert.equal(h.sessionCount(), 0);
    assert.equal(h.sent.length, 0);
  } finally { await h.close(); }
});

test("an older runner or a missing harness refuses the thread with guidance and launches nothing", async () => {
  const old = await harness({ protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.assistantRole - 1 });
  try {
    for (const body of [{}, { runnerId: "r" }]) {
      const refused = await old.call("POST", "/api/assistant-threads", body);
      assert.equal(refused.status, 409);
      assert.match(refused.body.error, /needs a newer runner for Wollipog assistant threads/);
      assert.equal(refused.body.requiredRunnerProtocolVersion, RUNNER_CAPABILITY_MIN_PROTOCOL.assistantRole);
    }
    assert.equal(old.sessionCount(), 0);
    assert.equal(old.sent.length, 0);
    assert.deepEqual((await old.call("GET", "/api/assistant-threads?includeArchived=true")).body.threads, []);
    const defaults = (await old.call("GET", "/api/assistant-threads/defaults")).body;
    assert.deepEqual(defaults.harnesses.map((h: { available: boolean }) => h.available), [false, false]);
    assert.match(defaults.harnesses[0].reason, /Update a Machine's runner/);
  } finally { await old.close(); }

  const h = await harness();
  try {
    const refused = await h.call("POST", "/api/assistant-threads", { harness: "codex" });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /Install Codex/);
    assert.equal((await h.call("POST", "/api/assistant-threads", { harness: "pi" })).status, 400);
    assert.equal((await h.call("POST", "/api/assistant-threads", { role: "orchestrator" })).status, 400);
    assert.equal(h.sessionCount(), 0);
    const defaults = (await h.call("GET", "/api/assistant-threads/defaults")).body;
    assert.deepEqual(defaults, { harness: "claude-code", harnesses: [
      { id: "claude-code", label: "Claude Code", available: true },
      { id: "codex", label: "Codex", available: false, reason: "Install Codex on an online Machine to start a thread with it." },
    ] });
  } finally { await h.close(); }
});

test("the default harness follows the owner's saved Orchestrator Child Harness", async () => {
  const h = await harness({ agents: [claude, codex] });
  try {
    const defaults = structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS);
    defaults.behavior.childHarness = { agentId: "codex", driver: "codex-app-server", context: { kind: "native" } };
    h.db.setOrchestratorDefaults(h.owner.userId, defaults, Date.now());
    assert.equal((await h.call("GET", "/api/assistant-threads/defaults")).body.harness, "codex");
    const { body } = await h.call("POST", "/api/assistant-threads", {});
    assert.equal(body.thread.harness, "codex");
    assert.equal(h.db.getSession(body.thread.sessionId)!.agentId, "codex");
    const chosen = await h.call("POST", "/api/assistant-threads", { harness: "claude-code" });
    assert.equal(h.db.getSession(chosen.body.thread.sessionId)!.agentId, "claude");
  } finally { await h.close(); }
});

test("rename, archive and listing are owner-scoped; archive archives the backing session", async () => {
  const h = await harness();
  try {
    const first = (await h.call("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const second = (await h.call("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    assert.equal(first.title, "New Thread");
    h.db.updateSessionStatus(first.sessionId, "idle", Date.now() + 10_000);
    const listed = (await h.call("GET", "/api/assistant-threads")).body.threads as AssistantThread[];
    assert.deepEqual(listed.map((t) => t.id), [first.id, second.id], "newest activity first");
    assert.equal(listed[0]!.status, "done");

    const renamed = await h.call("PATCH", `/api/assistant-threads/${first.id}`, { title: "Release Notes" });
    assert.equal(renamed.body.thread.title, "Release Notes");
    assert.equal((await h.call("PATCH", `/api/assistant-threads/${first.id}`, { title: "" })).status, 400);

    const archived = await h.call("POST", `/api/assistant-threads/${first.id}/archive`);
    assert.equal(archived.status, 200, archived.raw);
    assert.equal(archived.body.thread.status, "archived");
    assert.equal(typeof archived.body.thread.archivedAt, "number");
    // The ordinary session archive runs: a provider that may still be live is stopped first, then archived.
    assert.ok(h.db.hasSessionStopIntent(first.sessionId));
    const live = await h.call("POST", `/api/assistant-threads/${second.id}/archive`);
    assert.equal(live.body.thread.status, "archived");
    assert.ok(h.db.getSession(second.sessionId)!.archived || h.db.hasSessionStopIntent(second.sessionId));
    assert.deepEqual((await h.call("GET", "/api/assistant-threads")).body.threads, []);
    const third = (await h.call("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const again = await h.call("POST", `/api/assistant-threads/${first.id}/archive`);
    assert.equal(again.body.thread.archivedAt, archived.body.thread.archivedAt);
    assert.deepEqual((await h.call("GET", "/api/assistant-threads")).body.threads.map((t: AssistantThread) => t.id), [third.id]);
    assert.deepEqual((await h.call("GET", "/api/assistant-threads?includeArchived=true")).body.threads.map((t: AssistantThread) => t.id).sort(),
      [first.id, second.id, third.id].sort());

    h.as({ ...h.owner, userId: "usr_other_owner" });
    assert.equal((await h.call("GET", `/api/assistant-threads/${third.id}`)).status, 404);
    assert.equal((await h.call("PATCH", `/api/assistant-threads/${third.id}`, { title: "Mine" })).status, 404);
    assert.equal((await h.call("POST", `/api/assistant-threads/${third.id}/archive`)).status, 404);
    assert.deepEqual((await h.call("GET", "/api/assistant-threads")).body.threads, []);
    h.as({ ...h.owner, role: "admin" } as HumanPrincipal);
    assert.equal((await h.call("GET", "/api/assistant-threads")).status, 403);
    h.as(null);
    assert.equal((await h.call("POST", "/api/assistant-threads", {})).status, 403);
  } finally { await h.close(); }
});

test("a thread's status follows its backing session and the thread republishes with it", async () => {
  const h = await harness();
  try {
    const thread = (await h.call("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const before = h.dashboard.threads().length;
    h.db.updateSessionStatus(thread.sessionId, "input_required", Date.now());
    h.hub.sessionChangedById(thread.sessionId);
    const latest = h.dashboard.threads().slice(before).at(-1);
    assert.equal(latest?.id, thread.id);
    assert.equal(latest?.status, "needs_you");
    const session = h.db.getSession(thread.sessionId)!;
    assert.equal(assistantThreadStatus("active", { ...session, status: "running", pendingApproval: null }), "working");
    assert.equal(assistantThreadStatus("active", { ...session, status: "completed", pendingApproval: null }), "done");
    assert.equal(assistantThreadStatus("active", null), "archived");
    assert.equal(assistantThreadStatus("archived", { ...session, status: "running" }), "archived");
  } finally { await h.close(); }
});
