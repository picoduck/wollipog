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
  type ProviderAccountDefinition,
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
import { providerAccountRef } from "./agent-account-view.js";

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
const accounts: ProviderAccountDefinition[] = [
  { id: "work", label: "Work Subscription", provider: "claude", authStatus: "authenticated", billing: "subscription" },
  { id: "studio", label: "Studio Subscription", provider: "claude", authStatus: "authenticated", billing: "subscription" },
  { id: "sign-in", label: "Sign-In Needed", provider: "claude", authStatus: "unauthenticated", billing: "subscription" },
  { id: "incompatible", label: "Other Environment", provider: "claude", authStatus: "authenticated", billing: "subscription" },
  { id: "credits", label: "Metered Account", provider: "claude", authStatus: "authenticated", billing: "api" },
  { id: "codex", label: "Codex Subscription", provider: "codex", authStatus: "authenticated", billing: "subscription" },
];
const accountRef = (id: string) => providerAccountRef("r", id);

async function harness(options: { protocolVersion?: number; agents?: AgentDefinition[]; accounts?: ProviderAccountDefinition[] } = {}) {
  const db = ControlPlaneDb.open(":memory:"), identity = db.localIdentityContext();
  const owner = db.operatingHumanPrincipal(identity.userId, identity.organizationId)!;
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "fixture", os: "linux", version: "fixture",
    workspaces: [{ id: "w", name: "Home", path: "/fixture/home" }], agents: options.agents ?? [claude],
    providerAccounts: options.accounts };
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
    assert.match(thread.connectionId ?? "", /^asst_/);
    const { accountChangeSupported, ...baseline } = thread;
    assert.equal(accountChangeSupported, true);
    assert.deepEqual({ ...baseline, id: undefined, sessionId: undefined, lastActivityAt: undefined, createdAt: undefined, connectionId: undefined }, {
      id: undefined, sessionId: undefined, lastActivityAt: undefined, createdAt: undefined, connectionId: undefined,
      assistant: "wollipog", title: "Weekly Cleanup", harness: "claude-code", status: "working",
      access: { level: "full_access", destructive: "ask" }, launchedSessionIds: [], archivedAt: null,
      usage: { launchedSessions: { used: 0, limit: 10 }, costUsd: { used: 0, limit: 25 } }, confirmations: [],
    });
    const session = h.db.getSession(thread.sessionId)!;
    assert.equal(session.role, "assistant");
    assert.equal(session.agentId, "claude");
    assert.equal(session.parentSessionId ?? null, null);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]!.spec.assistant?.threadId, thread.id);
    assert.equal(h.sent[0]!.spec.orchestrator, undefined);
    assert.ok(h.dashboard.threads().some((published) => published.id === thread.id));
    assert.deepEqual(h.stranger.threads(), []);
    // Another owner of the organization never receives the backing session either.
    h.hub.sessionChangedById(thread.sessionId);
    assert.ok(h.dashboard.messages.some((message) => message.type === "session_upsert" && message.session.id === thread.sessionId));
    assert.ok(!h.stranger.messages.some((message) => message.type === "session_upsert" && message.session.id === thread.sessionId));
    // Thread views never carry a credential value or hash.
    assert.doesNotMatch(created.raw, /wollipoga_|token/i);

    // A restart rebuilds the launch from the database and still marks it.
    h.db.updateSessionStatus(thread.sessionId, "completed", Date.now());
    const restarted = h.svc.restart(thread.sessionId, {});
    assert.equal(restarted.ok, true, restarted.error ?? "");
    assert.equal(h.sent.at(-1)!.spec.assistant?.threadId, thread.id);

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

test("only the thread's owner reaches its session, which never joins a Project", async () => {
  const h = await harness();
  try {
    // The Location belongs to a Project; an ordinary session there would join it.
    const project = h.db.createProject({ name: "Shared" });
    h.db.addProjectLocation(project.id, { runnerId: "r", workspaceId: "w" });
    const thread = (await h.call("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    const session = h.db.getSession(thread.sessionId)!;
    assert.equal(session.projectId ?? null, null);
    assert.deepEqual(h.db.sessionScope(thread.sessionId), { organizationId: h.owner.organizationId, owner: { kind: "user", userId: h.owner.userId } });
    assert.equal(h.db.canAccessSession(h.owner, thread.sessionId), true);
    assert.ok(h.db.listSessionSummaries(h.owner).some((listed) => listed.id === thread.sessionId));
    // Organization owners and admins reach every other user's sessions, but not this one.
    for (const other of [{ ...h.owner, userId: "usr_other_owner" }, { ...h.owner, userId: "usr_admin", role: "admin" }] as HumanPrincipal[]) {
      assert.equal(h.db.canAccessSession(other, thread.sessionId), false, other.role);
      assert.ok(!h.db.listSessionSummaries(other).some((listed) => listed.id === thread.sessionId), other.role);
      assert.ok(!h.db.listSessionsForPrincipal(other).some((listed) => listed.id === thread.sessionId), other.role);
    }
    // Access follows the thread record, not the session's mutable scope, which cannot be changed.
    const admin = { ...h.owner, userId: "usr_admin", role: "admin" } as HumanPrincipal;
    assert.equal(h.db.setResourceScope({ resource: "session", resourceId: thread.sessionId, now: Date.now(),
      scope: { organizationId: h.owner.organizationId, owner: { kind: "organization", organizationId: h.owner.organizationId } } }), false);
    h.db.raw().prepare("UPDATE session_ownership SET owner_kind='user', owner_id=? WHERE session_id=?").run(admin.userId, thread.sessionId);
    assert.equal(h.db.canAccessSession(admin, thread.sessionId), false);
    assert.ok(!h.db.listSessionSummaries(admin).some((listed) => listed.id === thread.sessionId));
    h.db.raw().prepare("UPDATE session_ownership SET owner_kind='user', owner_id=? WHERE session_id=?").run(h.owner.userId, thread.sessionId);
    // An ordinary user-owned session stays visible to an admin, as before.
    h.db.createSession({ id: "ordinary", runnerId: "r", workspaceId: "w", agentId: "claude", title: "Ordinary", driver: "claude-code",
      useWorktree: false, config: {}, now: Date.now(), scope: { organizationId: h.owner.organizationId, owner: { kind: "user", userId: h.owner.userId } } });
    assert.equal(h.db.canAccessSession({ ...h.owner, userId: "usr_admin", role: "admin" } as HumanPrincipal, "ordinary"), true);
  } finally { await h.close(); }
});

test("thread creation launches the Machine's selected harness installation", async () => {
  const installed = (id: string, installation: string): AgentDefinition => ({ ...claude, id,
    installation: { id: installation, path: `/opt/${installation}/claude`, via: "path" } });
  const h = await harness({ agents: [installed("claude-a", "first"), installed("claude-b", "second")] });
  try {
    assert.ok(h.db.selectHarnessInstallation("r", "claude-b", "second"));
    const { status, body, raw } = await h.call("POST", "/api/assistant-threads", {});
    assert.equal(status, 200, raw);
    assert.equal(h.db.getSession(body.thread.sessionId)!.agentId, "claude-b");
  } finally { await h.close(); }
});

test("a restart refuses an assistant whose agent was redefined to run inside WSL", async () => {
  const h = await harness();
  try {
    const thread = (await h.call("POST", "/api/assistant-threads", {})).body.thread as AssistantThread;
    h.db.updateSessionStatus(thread.sessionId, "completed", Date.now());
    h.db.registerRunner({ runnerId: "r", hostname: "fixture", os: "windows", version: "fixture",
      workspaces: [{ id: "w", name: "Home", path: "/fixture/home" }],
      agents: [{ ...claude, context: { kind: "wsl", distro: "Ubuntu" } }] }, Date.now(), PROTOCOL_VERSION);
    const sent = h.sent.length;
    const restarted = h.svc.restart(thread.sessionId, {});
    assert.equal(restarted.ok, false);
    assert.equal(restarted.status, 409);
    assert.match(restarted.error ?? "", /native Claude Code or Codex/);
    assert.equal(h.sent.length, sent, "nothing is launched");
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
      { id: "claude-code", label: "Claude Code", available: true,
        accountSelection: { runnerId: "r", workspaceId: "w", accounts: [] } },
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

test("creation previews the Machine's policy, validates an explicit reference, and keeps the fallback", async () => {
  const h = await harness({ accounts, agents: [{ ...claude,
    providerAccountReadiness: { defaultAuthStatus: "authenticated", readyAccountIds: ["work", "studio", "credits"] },
  }] });
  try {
    assert.ok(h.db.setMachineProviderAccountDefault("r", "claude", "work", 0, Date.now()).ok);
    const defaults = await h.call("GET", "/api/assistant-threads/defaults");
    const choices = defaults.body.harnesses[0].accountSelection;
    assert.equal(choices.policyAccountRef, accountRef("work"));
    assert.deepEqual(choices.accounts.map((account: { reason?: string }) => account.reason),
      [undefined, undefined, "signed_out", "context_incompatible", "api_billing"]);
    const chosen = await h.call("POST", "/api/assistant-threads", { providerAccountRef: accountRef("studio") });
    assert.equal(chosen.status, 200, chosen.raw);
    assert.equal(chosen.body.thread.providerAccountLabel, "Studio Subscription");
    assert.equal(h.sent[0]?.spec.providerAccountId, "studio");
    assert.equal(h.sent[0]?.spec.providerAccountSelection?.revalidateAtLaunch, true);
    const fallback = await h.call("POST", "/api/assistant-threads", {});
    assert.equal(fallback.status, 200, fallback.raw);
    assert.equal(fallback.body.thread.providerAccountLabel, "Work Subscription");
    assert.equal(h.sent[1]?.spec.providerAccountId, "work");
    for (const [id, reason] of [
      ["sign-in", /needs sign-in/], ["incompatible", /environment/], ["credits", /API credits/], ["codex", /not available/],
    ] as const) {
      const refusal = await h.call("POST", "/api/assistant-threads", { providerAccountRef: accountRef(id) });
      assert.equal(refusal.status, 409, refusal.raw);
      assert.match(refusal.body.error, reason);
    }
    assert.equal(h.sessionCount(), 2);
    assert.equal(h.sent.length, 2);
  } finally { await h.close(); }
});

test("thread account changes are owner-only, wait for idle, and address only the existing backing session", async () => {
  const h = await harness({ accounts });
  try {
    const created = await h.call("POST", "/api/assistant-threads", { providerAccountRef: accountRef("work") });
    const thread = created.body.thread as AssistantThread;
    const launched = h.svc.createSession({ runnerId: "r", workspaceId: "w", agentId: "claude", providerAccountId: "work" });
    assert.ok(launched.ok && launched.data);
    h.db.assistantThreads.recordLaunch(thread.id, launched.data.id, Date.now());
    const path = `/api/assistant-threads/${thread.id}/account`;
    const input = { providerAccountRef: accountRef("studio"), expectedProviderAccountRef: accountRef("work") };
    let dispatched = 0;
    h.hub.requestFromRunner = async (_runnerId, requestId, command) => {
      dispatched++;
      assert.deepEqual(command, { type: "switch_session_provider_account", requestId,
        sessionId: thread.sessionId, providerAccountId: "studio",
        assistantThread: { threadId: thread.id, expectedProviderAccountId: "work", freshConversation: false } });
      h.db.raw().prepare("UPDATE sessions SET provider_account_id=?,provider_account_label=? WHERE id=?")
        .run("studio", "Studio Subscription", thread.sessionId);
      return { type: "switch_session_provider_account_result", requestId, ok: true };
    };
    h.as({ ...h.owner, userId: "another-owner" });
    assert.equal((await h.call("GET", path)).status, 404);
    assert.equal((await h.call("POST", path, input)).status, 404);
    h.as(h.owner);
    assert.equal((await h.call("GET", path)).body.currentAccountRef, accountRef("work"));
    assert.match((await h.call("POST", path, input)).body.error, /Wait for the current turn/);
    h.db.updateSessionStatus(thread.sessionId, "idle", Date.now());
    assert.equal((await h.call("POST", path, { ...input, providerAccountRef: accountRef("credits") })).status, 409);
    assert.equal((await h.call("POST", path, { ...input, expectedProviderAccountRef: null })).status, 409);
    assert.equal(dispatched, 0);
    const changed = await h.call("POST", path, input);
    assert.equal(changed.status, 200, changed.raw);
    assert.equal(changed.body.thread.providerAccountLabel, "Studio Subscription");
    for (const key of ["id", "sessionId", "connectionId"] as const) {
      assert.deepEqual(changed.body.thread[key], thread[key]);
    }
    assert.deepEqual(changed.body.thread.launchedSessionIds, [launched.data.id]);
    assert.equal(h.db.getSession(launched.data.id)?.providerAccountId, "work");
    assert.equal(dispatched, 1);
    assert.equal(h.sessionCount(), 2);
  } finally { await h.close(); }
});

test("a runner that supports threads but predates account choices refuses both new account inputs", async () => {
  const h = await harness({ accounts, protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.assistantThreadProviderAccount - 1 });
  try {
    const input = { providerAccountRef: accountRef("studio") };
    const refused = await h.call("POST", "/api/assistant-threads", input);
    assert.equal(refused.status, 409, refused.raw);
    assert.equal(refused.body.requiredRunnerProtocolVersion, RUNNER_CAPABILITY_MIN_PROTOCOL.assistantThreadProviderAccount);
    assert.equal(h.sessionCount(), 0);
    const legacy = await h.call("POST", "/api/assistant-threads", {});
    assert.equal(legacy.status, 200, legacy.raw);
    const change = await h.call("POST", `/api/assistant-threads/${legacy.body.thread.id}/account`, {
      ...input, expectedProviderAccountRef: accountRef("work"),
    });
    assert.equal(change.status, 409, change.raw);
    assert.equal(change.body.requiredRunnerProtocolVersion, RUNNER_CAPABILITY_MIN_PROTOCOL.assistantThreadProviderAccount);
    assert.equal(h.sent.length, 1);
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

test("install adds the retirement columns to a membership table an earlier build created", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { AssistantThreadStore } = await import("./assistant-thread-store.js");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT);
      CREATE TABLE assistant_thread_members (session_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, root_session_id TEXT NOT NULL)`);
    AssistantThreadStore.install(db);
    AssistantThreadStore.install(db);
    const columns = (db.prepare("PRAGMA table_info(assistant_thread_members)").all() as Array<{ name: string }>).map((column) => column.name);
    assert.ok(columns.includes("retired_cost_usd") && columns.includes("retired_cap_usd"), columns.join(", "));
  } finally { db.close(); }
});
