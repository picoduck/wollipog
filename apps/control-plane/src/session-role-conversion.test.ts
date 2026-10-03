import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS, PROTOCOL_VERSION, type OrchestratorSettingsView,
  type PrepareSessionRoleMessage, type RunnerMetadata, type SessionRole, type SessionSnapshot,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { SessionRoleConversions, registerSessionRoleRoutes } from "./session-role-conversion.js";
import type { HumanPrincipal } from "./identity.js";
import { SessionsService } from "./sessions.js";
import { isAgentControlApiRouteAllowed } from "./auth.js";

function harness(role: SessionRole = "normal", protocol = PROTOCOL_VERSION) {
  const db = ControlPlaneDb.open(":memory:");
  const metadata: RunnerMetadata = {
    runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/test" }],
    agents: [{ id: "claude", name: "Claude", command: "claude", args: ["--verbose"], env: {},
      driver: "claude-code", context: { kind: "native" }, available: true,
      capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false,
        supportsApprovals: true, permissionModes: ["default", "auto", "acceptEdits"], orchestratorAdditive: true,
        claudeMutableSystemPromptFlag: "--system-prompt-recording" } }],
  };
  db.registerRunner(metadata, Date.now(), protocol);
  const defaults = { defaults: structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS), source: "system_default" } as OrchestratorSettingsView;
  defaults.defaults.execution.strictProjectIsolation = false;
  const policy = resolveOrchestratorCampaignPolicy(defaults.defaults, defaults.source, {});
  db.createSession({ id: "s", runnerId: "r", workspaceId: "w", agentId: "claude", title: "Preserved",
    driver: "claude-code", config: { permissionMode: "auto", model: "opus", effort: "high" },
    useWorktree: true, now: 10, role,
    ...(role === "orchestrator" ? { orchestratorPolicy: policy } : {}),
  });
  db.updateSessionStatus("s", "idle", 11);
  db.appendEvent("s", { kind: "user_message", text: "Keep this conversation" }, 12);
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  hub.sessionChangedById = () => {};
  const commands: unknown[] = [];
  hub.requestFromRunner = async (_runnerId, requestId, command) => {
    commands.push(command);
    if (command.type !== "prepare_session_role" && command.type !== "commit_session_role") throw new Error("unexpected command");
    return { type: "session_role_result", requestId, sessionId: command.sessionId,
      conversionId: command.conversionId, ok: true,
      receipt: { conversionId: command.conversionId, state: command.type === "prepare_session_role" ? "prepared" : "applied" } };
  };
  const events: string[] = [];
  const conversions = new SessionRoleConversions(db, hub, (event) => events.push(event));
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  return { db, hub, conversions, defaults, commands, events, svc, metadata };
}

for (const role of ["normal", "orchestrator"] as const) test(`role conversion from ${role} preserves identity, transcript, permissions and child links`, async () => {
  const { db, conversions, defaults, commands, events } = harness(role);
  try {
    db.createSession({ id: "done", runnerId: "r", workspaceId: "w", agentId: "claude", title: "Completed child",
      driver: "claude-code", config: {}, useWorktree: false, now: 13, parentSessionId: "s" });
    db.updateSessionStatus("done", "completed", 14);
    const before = db.getSession("s")!;
    const history = db.listEvents("s");
    assert.equal(db.setAgentControlCredential("s", "r", "a".repeat(64), 15), true);
    assert.equal(db.setPolicyHookCredential("s", "r", "b".repeat(64), 15), true);
    const target = role === "normal" ? "orchestrator" : "normal";
    await conversions.change("s", target, role, defaults, () => null);
    const after = db.getSession("s")!;
    assert.equal(after.role, target);
    for (const key of ["id", "title", "workspaceId", "providerAccountId", "projectId", "worktreePath", "useWorktree", "model", "effort", "permissionMode", "createdAt"] as const) {
      assert.equal(after[key], before[key], key);
    }
    assert.deepEqual(db.listEvents("s"), history);
    assert.equal(db.getSession("done")!.parentSessionId, "s");
    assert.equal(after.roleConversion, undefined);
    assert.equal(db.agentControlCredentialValid("s", "r", "a".repeat(64)), false);
    assert.equal(db.policyHookCredentialValid("s", "r", "b".repeat(64)), false);
    assert.equal(db.setAgentControlCredential("s", "r", "a".repeat(64), 16), false, "late old registration cannot resurrect authority");
    assert.equal(db.setPolicyHookCredential("s", "r", "b".repeat(64), 16), false);
    assert.equal(db.setAgentControlCredential("s", "r", "c".repeat(64), 16), true);
    assert.equal(Boolean(after.orchestratorPolicy), target === "orchestrator");
    assert.equal(commands.length, 2);
    assert.deepEqual(events, ["session_role_conversion_requested", "session_role_conversion_committed", "session_role_conversion_applied"]);
  } finally { db.close(); }
});

test("conversion is human-only: neither agent role can call the role routes", () => {
  for (const role of ["normal", "orchestrator"] as const) for (const method of ["GET", "POST"]) {
    assert.equal(isAgentControlApiRouteAllowed(method, "/api/sessions/:id/role", role), false);
  }
});

test("unsupported peers and incompatible permissions/isolation fail before dispatch or state change", async () => {
  const h = harness("normal", 196);
  try {
    const before = h.db.getSession("s");
    assert.match(h.conversions.preview("s", "orchestrator", h.defaults, () => null).reason!, /protocol v197/);
    await assert.rejects(h.conversions.change("s", "orchestrator", "normal", h.defaults, () => null), /protocol v197/);
    assert.deepEqual(h.db.getSession("s"), before);
    assert.equal(h.commands.length, 0);
  } finally { h.db.close(); }
  const current = harness();
  try {
    current.defaults.defaults.execution.strictProjectIsolation = true;
    assert.match(current.conversions.preview("s", "orchestrator", current.defaults, () => null).reason!, /Strict Project Isolation/);
    current.defaults.defaults.execution.strictProjectIsolation = false;
    current.db.updateSessionConfig("s", { permissionMode: "orchestrator" }, 20);
    assert.match(current.conversions.preview("s", "orchestrator", current.defaults, () => null).reason!, /preset couples/);
  } finally { current.db.close(); }
});

test("demotion retains current decision ownership until live children and unconsumed requests settle", async () => {
  const { db, conversions, defaults, svc, commands } = harness("orchestrator");
  try {
    db.createSession({ id: "child", runnerId: "r", workspaceId: "w", agentId: "claude", title: "Child",
      driver: "claude-code", config: {}, useWorktree: false, now: 20, parentSessionId: "s" });
    db.updateSessionStatus("child", "running", 21);
    assert.match(conversions.preview("s", "normal", defaults, () => null).reason!, /live child/);
    const ask = svc.createWorkflowDecision("child", { requestId: "ask", resourceKey: "scope",
      resourceSnapshot: { category: "implementation_question", question: "Which?",
        options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] } });
    assert.ok(ask.ok);
    db.updateSessionStatus("child", "completed", 22);
    const decision = db.unconsumedWorkflowDecisionsForController("s")[0]!;
    assert.equal(decision.controllingSessionId, "s");
    await assert.rejects(conversions.change("s", "normal", "orchestrator", defaults, () => null), /unconsumed decisions/);
    assert.equal(db.unconsumedWorkflowDecisionsForController("s")[0]!.controllingSessionId, "s");
    assert.equal(commands.length, 0);
  } finally { db.close(); }
});

test("a live Native TUI and Claude without mutable resumed instructions refuse conversion before dispatch", async () => {
  for (const boundary of ["tui", "instructions"]) {
    const h = harness();
    try {
      if (boundary === "tui") h.db.createShell({ shellId: "tui", sessionId: "s", runnerId: "r", name: "Agent TUI", createdAt: 20, kind: "agent_tui" });
      else {
        delete h.metadata.agents[0]!.capabilities!.claudeMutableSystemPromptFlag;
        h.db.registerRunner(h.metadata, 20, PROTOCOL_VERSION);
      }
      const before = h.db.getSession("s");
      await assert.rejects(h.conversions.change("s", "orchestrator", "normal", h.defaults, () => null), boundary === "tui" ? /Close the Native TUI/ : /rebuilding system instructions/);
      assert.deepEqual(h.db.getSession("s"), before);
      assert.equal(h.commands.length, 0);
    } finally { h.db.close(); }
  }
});

test("a lost prepare reply remains fenced and reconciles only the exact runner receipt", async () => {
  const h = harness();
  try {
    const normalRequest = h.hub.requestFromRunner.bind(h.hub);
    let prepared: PrepareSessionRoleMessage | undefined;
    h.hub.requestFromRunner = async (_runner, _request, command) => {
      assert.equal(command.type, "prepare_session_role");
      prepared = command as PrepareSessionRoleMessage;
      throw new Error("reply lost");
    };
    await assert.rejects(h.conversions.change("s", "orchestrator", "normal", h.defaults, () => null), /reply lost/);
    assert.equal(h.db.getSession("s")!.role, "normal");
    assert.equal(h.db.sessionRoleConversionPending("s"), true);
    assert.equal(h.svc.prompt("s", "must not start").ok, false);
    assert.equal(h.svc.restart("s").ok, false);
    assert.equal(h.svc.setConfig("s", { permissionMode: "default" }).ok, false);
    const snapshot = { id: "s", roleConversionReceipt: { conversionId: prepared!.conversionId, state: "prepared" } } as SessionSnapshot;
    h.hub.requestFromRunner = normalRequest;
    h.conversions.reconcile("wrong-runner", snapshot);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.db.getSession("s")!.role, "normal");
    h.conversions.reconcile("r", { ...snapshot, roleConversionReceipt: { conversionId: "stale", state: "prepared" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.db.getSession("s")!.role, "normal");
    h.conversions.reconcile("r", snapshot);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.db.getSession("s")!.role, "orchestrator");
    assert.equal(h.db.sessionRoleConversionPending("s"), false);
  } finally { h.db.close(); }
});

test("the actual human role routes enforce write authority, session scope and stale intent", async () => {
  const h = harness();
  const app = Fastify();
  const identity = h.db.localIdentityContext();
  const owner: HumanPrincipal = { kind: "human", actorId: identity.userId, ...identity };
  registerSessionRoleRoutes(app, {
    db: h.db, conversions: h.conversions,
    requestHuman: (req) => req.headers.authorization === "owner" ? owner
      : req.headers.authorization === "viewer" ? { ...owner, role: "viewer" }
      : req.headers.authorization === "foreign" ? { ...owner, userId: "foreign", actorId: "foreign", organizationId: "elsewhere", localBootstrap: false } : null,
    defaultsFor: () => h.defaults, validatePolicy: () => null,
  });
  try {
    await app.ready();
    const payload = { role: "orchestrator", expectedRole: "normal" };
    for (const authorization of [undefined, "agent", "viewer"]) {
      const response = await app.inject({ method: "POST", url: "/api/sessions/s/role", payload,
        headers: authorization ? { authorization } : {} });
      assert.equal(response.statusCode, 403);
    }
    assert.equal((await app.inject({ method: "POST", url: "/api/sessions/s/role", payload,
      headers: { authorization: "foreign" } })).statusCode, 404);
    const viewer = await app.inject({ method: "GET", url: "/api/sessions/s/role?role=orchestrator", headers: { authorization: "viewer" } });
    assert.equal(viewer.json().available, false);
    assert.equal(h.commands.length, 0);
    assert.equal((await app.inject({ method: "GET", url: "/api/sessions/s/role?role=orchestrator", headers: { authorization: "owner" } })).json().available, true);
    assert.equal((await app.inject({ method: "POST", url: "/api/sessions/s/role", payload: { role: "other" }, headers: { authorization: "owner" } })).statusCode, 400);
    const success = await app.inject({ method: "POST", url: "/api/sessions/s/role", payload, headers: { authorization: "owner" } });
    assert.equal(success.statusCode, 200, success.body);
    assert.equal(success.json().role, "orchestrator");
    const stale = await app.inject({ method: "POST", url: "/api/sessions/s/role", payload, headers: { authorization: "owner" } });
    assert.equal(stale.statusCode, 409);
    assert.equal(h.commands.length, 2);
  } finally { await app.close(); h.db.close(); }
});

test("an interrupted conversion cannot retry or reconcile through an older peer", async () => {
  const h = harness();
  try {
    let command: PrepareSessionRoleMessage | undefined;
    h.hub.requestFromRunner = async (_runner, _request, message) => {
      command = message as PrepareSessionRoleMessage;
      throw new Error("disconnected");
    };
    await assert.rejects(h.conversions.change("s", "orchestrator", "normal", h.defaults, () => null), /disconnected/);
    h.db.registerRunner(h.metadata, Date.now(), 196);
    h.conversions.reconcile("r", { id: "s", roleConversionReceipt: { conversionId: command!.conversionId, state: "prepared" } });
    await assert.rejects(h.conversions.change("s", "orchestrator", "normal", h.defaults, () => null), /protocol v197/);
    assert.equal(h.db.getSession("s")!.role, "normal");
    assert.equal(h.db.sessionRoleConversionPending("s"), true);
  } finally { h.db.close(); }
});

test("stale expected roles refuse and ordinary runner refusal leaves no half-applied role", async () => {
  const h = harness();
  try {
    await assert.rejects(h.conversions.change("s", "orchestrator", "orchestrator", h.defaults, () => null), /role changed/);
    h.hub.requestFromRunner = async (_runner, requestId, command) => {
      assert.equal(command.type, "prepare_session_role");
      const c = command as PrepareSessionRoleMessage;
      return { type: "session_role_result", requestId, sessionId: "s", conversionId: c.conversionId, ok: false, error: "provider is busy" };
    };
    await assert.rejects(h.conversions.change("s", "orchestrator", "normal", h.defaults, () => null), /provider is busy/);
    assert.equal(h.db.getSession("s")!.role, "normal");
    assert.equal(h.db.sessionRoleConversionPending("s"), false);
  } finally { h.db.close(); }
});
