import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type {
  ControlPlaneToRunner,
  DurableSessionCommand,
  GitSummaryInfo,
  PodContextEntry,
  PodView,
  ProjectView,
  QueuedPromptView,
  ResourceScope,
  RunnerMetadata,
  RunView,
  SessionEvent,
  SessionSnapshot,
  SessionView,
  SteerRequest,
  SteerSessionResultMessage,
  WorkflowDefinitionSpec,
} from "@wollipog/protocol";
import {
  EVENT_PAYLOAD_PREVIEW_BYTES,
  MAX_UI_SESSION_SUBSCRIPTIONS,
  POLICY_HOOK_ABANDONMENT_MS,
  PROTOCOL_VERSION,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { automationCommandDigest, canonicalAutomationCommandJson } from "./automation-command-outbox.js";
import { Hub, RunnerRequestNotSentError, type RunnerRequestResult } from "./hub.js";
import { agentDelegationAuthorizationError, type AgentPrincipal } from "./identity.js";
import { pushDecision } from "./push-decision.js";
import {
  SessionsService,
  EXTERNAL_SESSION_ADOPTION_TIMEOUT_MS,
  EXTERNAL_SESSION_ENUMERATION_TIMEOUT_MS,
  budgetDecision,
  capabilityConfigError,
  claudeModelConfigForValidation,
  normalizeClaudePersistedConfig,
  sessionBlocksConversationFork,
  type PreStagedDeliveryPlan,
} from "./sessions.js";

test("conversation forks fail closed for every in-progress source lifecycle", () => {
  for (const status of ["queued", "starting", "running", "input_required"] as const) {
    assert.equal(sessionBlocksConversationFork(status), true, status);
  }
  for (const status of ["idle", "completed", "failed", "stopped"] as const) {
    assert.equal(sessionBlocksConversationFork(status), false, status);
  }
});

test("capability config validation rejects unverified effort and permission modes", () => {
  const caps = {
    models: [], effortLevels: ["low"], slashCommands: [], supportsImages: false,
    supportsApprovals: false, permissionModes: ["acceptEdits"],
  };
  assert.match(capabilityConfigError({ effort: "max" }, caps)!, /effort/);
  assert.match(capabilityConfigError({ model: "missing" }, { ...caps, models: [{ id: "known" }] })!, /model/);
  assert.match(capabilityConfigError({ permissionMode: "auto" }, caps)!, /permission mode/);
  assert.equal(capabilityConfigError({ effort: "low", permissionMode: "acceptEdits" }, caps), null);
});

test("persisted Claude config normalization drops stale knobs and preserves the conductor gate", () => {
  const caps = {
    models: [], effortLevels: ["low"], slashCommands: [], supportsImages: false,
    supportsApprovals: true, permissionModes: ["default", "acceptEdits"],
  };
  assert.deepEqual(
    normalizeClaudePersistedConfig({ model: "opus", effort: "max", permissionMode: "auto" }, caps, AGENT_ID, "claude-code"),
    { model: "opus", effort: undefined, permissionMode: undefined },
  );
  assert.equal(
    normalizeClaudePersistedConfig({ permissionMode: "auto" }, caps, CONDUCTOR_ID, "claude-code").permissionMode,
    "default",
  );
  const liveCaps = {
    ...caps,
    models: [
      { id: "default", displayName: "Default (Opus 5)", default: true },
      { id: "opus[1m]", displayName: "Opus 5 (1M Context)" },
      { id: "claude-fable-5[1m]", displayName: "Fable 5" },
    ],
  };
  assert.equal(
    claudeModelConfigForValidation({ model: "opus" }, liveCaps, "claude-code").model,
    "opus[1m]",
  );
  assert.equal(
    claudeModelConfigForValidation({ model: "fable" }, liveCaps, "claude-code").model,
    "claude-fable-5[1m]",
  );
  assert.equal(
    claudeModelConfigForValidation(
      { model: "opus[1m]" }, { ...caps, models: [{ id: "opus" }] }, "claude-code",
    ).model,
    "opus",
  );
  assert.equal(
    claudeModelConfigForValidation({ model: "unknown" }, liveCaps, "claude-code").model,
    "unknown",
  );
  assert.equal(
    claudeModelConfigForValidation({ model: "claude-opus-5" }, liveCaps, "claude-code").model,
    "claude-opus-5",
  );
  assert.equal(
    claudeModelConfigForValidation({ model: "claude-opus-4-5-20251101" }, liveCaps, "claude-code").model,
    "claude-opus-4-5-20251101",
  );
});

/* -------------------------------------------------------------------------- */
/* Test fixtures                                                              */
/* -------------------------------------------------------------------------- */

const RUNNER_ID = "runner-1";
const WORKSPACE_ID = "ws-1";
const WORKSPACE_PATH = "/repos/demo";
const AGENT_ID = "claude";
const CODEX_APP_AGENT_ID = "codex";
const CODEX_AGENT_ID = "codex-exec";
const ACP_AGENT_ID = "gemini-acp";
// The conductor's contract agent id (must match the runner's synthesis + the CP clamp).
const CONDUCTOR_ID = "conductor";

/** A recording, controllable stand-in for the real connection Hub. */
class FakeHub {
  online = true;
  /** Toggle: sendToRunner returns this (mirrors the real "delivered?" boolean). */
  deliver = true;

  calls: { method: string; args: unknown[] }[] = [];
  sentToRunner: { runnerId: string; msg: ControlPlaneToRunner }[] = [];
  sessionChangedCalls: SessionView[] = [];
  sessionChangedByIdCalls: string[] = [];
  sessionEventCalls: SessionEvent[] = [];
  sessionEventsResetCalls: { sessionId: string; events: SessionEvent[]; eventEpoch?: number }[] = [];
  sessionRemovedCalls: string[] = [];
  runChangedCalls: RunView[] = [];
  podChangedCalls: PodView[] = [];
  podContextEntryCalls: PodContextEntry[] = [];
  projectChangedByIdCalls: string[] = [];
  runnerChangedCalls: string[] = [];
  deliveryHandler?: (runnerId: string, msg: ControlPlaneToRunner) => boolean;
  requestHandler?: (msg: ControlPlaneToRunner) => RunnerRequestResult | Promise<RunnerRequestResult>;
  activeTurnIds = new Map<string, string>();

  isRunnerOnline(runnerId: string): boolean {
    this.calls.push({ method: "isRunnerOnline", args: [runnerId] });
    return this.online;
  }

  sendToRunner(runnerId: string, msg: ControlPlaneToRunner): boolean {
    this.calls.push({ method: "sendToRunner", args: [runnerId, msg] });
    this.sentToRunner.push({ runnerId, msg });
    return this.deliveryHandler?.(runnerId, msg) ?? this.deliver;
  }

  async requestFromRunner(
    runnerId: string,
    _requestId: string,
    msg: ControlPlaneToRunner,
    _timeoutMs?: number,
  ): Promise<RunnerRequestResult> {
    if (!this.sendToRunner(runnerId, msg)) throw new RunnerRequestNotSentError();
    if (!this.requestHandler && msg.type === "interrupt_turn") {
      return {
        type: "interrupt_turn_result",
        requestId: msg.requestId!,
        sessionId: msg.sessionId,
        applied: true,
        reason: "applied",
      };
    }
    if (!this.requestHandler) throw new Error("runner did not respond in time");
    return await this.requestHandler(msg);
  }

  async waitForRunnerRequest(): Promise<RunnerRequestResult> {
    throw new Error("runner request is no longer in flight");
  }

  resolveRunnerRequest(): boolean {
    return false;
  }

  activeTurnIdForSession(sessionId: string): string | undefined {
    return this.activeTurnIds.get(sessionId);
  }

  setSessionQueue(sessionId: string, queue: QueuedPromptView[], held = false, activeTurnId?: string): void {
    this.calls.push({ method: "setSessionQueue", args: [sessionId, queue, held, activeTurnId] });
    if (activeTurnId) this.activeTurnIds.set(sessionId, activeTurnId);
    else this.activeTurnIds.delete(sessionId);
  }

  sessionChanged(session: SessionView): void {
    this.calls.push({ method: "sessionChanged", args: [session] });
    this.sessionChangedCalls.push(session);
    if (session.projectId) this.projectChangedById(session.projectId);
  }

  sessionChangedById(sessionId: string): void {
    this.calls.push({ method: "sessionChangedById", args: [sessionId] });
    this.sessionChangedByIdCalls.push(sessionId);
  }

  sessionEvent(event: SessionEvent): void {
    this.calls.push({ method: "sessionEvent", args: [event] });
    this.sessionEventCalls.push(event);
  }

  sessionEventsReset(sessionId: string, events: SessionEvent[], eventEpoch?: number): void {
    this.calls.push({ method: "sessionEventsReset", args: [sessionId, events, eventEpoch] });
    this.sessionEventsResetCalls.push({ sessionId, events, eventEpoch });
  }

  sessionRemoved(sessionId: string): void {
    this.calls.push({ method: "sessionRemoved", args: [sessionId] });
    this.sessionRemovedCalls.push(sessionId);
  }

  runChanged(run: RunView): void {
    this.calls.push({ method: "runChanged", args: [run] });
    this.runChangedCalls.push(run);
  }

  podChanged(pod: PodView): void {
    this.calls.push({ method: "podChanged", args: [pod] });
    this.podChangedCalls.push(pod);
  }

  podContextEntry(entry: PodContextEntry): void {
    this.calls.push({ method: "podContextEntry", args: [entry] });
    this.podContextEntryCalls.push(entry);
  }

  projectChanged(_project: ProjectView): void {}

  projectChangedById(projectId: string): void {
    this.calls.push({ method: "projectChangedById", args: [projectId] });
    this.projectChangedByIdCalls.push(projectId);
  }

  runnerChanged(runnerId: string): void {
    this.calls.push({ method: "runnerChanged", args: [runnerId] });
    this.runnerChangedCalls.push(runnerId);
  }

  /** Last message routed to a runner (the most interesting one to assert on). */
  lastSent(): ControlPlaneToRunner | undefined {
    return this.sentToRunner.at(-1)?.msg;
  }

  sentOfType<T extends ControlPlaneToRunner["type"]>(
    type: T,
  ): Extract<ControlPlaneToRunner, { type: T }>[] {
    return this.sentToRunner
      .map((s) => s.msg)
      .filter((m): m is Extract<ControlPlaneToRunner, { type: T }> => m.type === type);
  }
}

function sentPromptCommands(hub: FakeHub) {
  return hub.sentToRunner.flatMap(({ msg }) => {
    if (msg.type === "prompt_session") return [msg];
    if (msg.type === "durable_session_command" && msg.command.type === "prompt_session") return [msg.command];
    return [];
  });
}

const NOOP_LOG = { info() {}, warn() {}, error() {} };

function runnerMeta(): RunnerMetadata {
  return {
    runnerId: RUNNER_ID,
    hostname: "host",
    os: "linux",
    version: "1.0.0",
    workspaces: [{ id: WORKSPACE_ID, name: "Demo", path: WORKSPACE_PATH, additionalDirectoryGrants: ["/repos/shared"] }],
    agents: [
      {
        id: AGENT_ID,
        name: "Claude",
        command: "claude",
        args: ["--flag"],
        env: { FOO: "bar" },
        driver: "claude-code",
        context: { kind: "native" },
        version: "2.1.0",
      },
      {
        id: CODEX_AGENT_ID,
        name: "Codex Exec",
        command: "codex",
        args: ["exec"],
        env: {},
        driver: "codex",
        context: { kind: "native" },
      },
      {
        id: CODEX_APP_AGENT_ID,
        name: "Codex App Server",
        command: "codex",
        args: [],
        env: {},
        driver: "codex-app-server",
        context: { kind: "native" },
        capabilities: {
          models: [
            { id: "image-model", default: true, inputModalities: ["text", "image"] },
            { id: "text-model", inputModalities: ["text"] },
          ],
          modelSource: "live",
          effortLevels: ["low", "high"],
          slashCommands: [],
          supportsImages: true,
          supportsApprovals: true,
          supportsSteering: true,
        },
      },
      {
        id: ACP_AGENT_ID,
        name: "Gemini ACP",
        command: "gemini",
        args: ["--acp"],
        env: {},
        driver: "acp",
        context: { kind: "native" },
      },
      {
        id: CONDUCTOR_ID,
        name: "Conductor (agent manager)",
        command: "claude",
        args: [],
        env: {},
        driver: "claude-code",
        context: { kind: "native" },
      },
    ],
  };
}

/** Fresh in-memory DB seeded with one online-capable runner + its agent/workspace. */
function makeHarness() {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const hub = new FakeHub();
  hub.requestHandler = (message) => {
    if (message.type === "interrupt_turn") {
      return {
        type: "interrupt_turn_result",
        requestId: message.requestId!,
        sessionId: message.sessionId,
        applied: true,
        reason: "applied",
      };
    }
    if (message.type !== "adopt_session") throw new Error("runner did not respond in time");
    const descriptor = message.descriptor;
    return {
      type: "adopt_session_result",
      requestId: message.requestId!,
      ok: true,
      descriptor,
      snapshot: snapshot({
        id: message.sessionId,
        workspaceId: null,
        workspacePath: descriptor.cwd,
        agentId: descriptor.agentId ?? null,
        title: descriptor.title || "(adopted session)",
        titleSource: "provider",
        driver: descriptor.driver,
        useWorktree: false,
        worktreePath: null,
        config: {},
        adopted: true,
        seq: 0,
        createdAt: descriptor.createdAt,
        updatedAt: descriptor.updatedAt,
      }),
    };
  };
  const svc = new SessionsService(db, hub as unknown as Hub, NOOP_LOG);
  return { db, hub, svc };
}

function makeTeamOwnedProject(db: ControlPlaneDb): {
  project: ProjectView;
  location: ProjectView["locations"][number];
  scope: ResourceScope;
} {
  const local = db.localIdentityContext();
  const scope: ResourceScope = {
    organizationId: local.organizationId,
    owner: { kind: "team", teamId: "team-project" },
  };
  db.createIdentityTeam({
    teamId: "team-project",
    organizationId: local.organizationId,
    name: "Project Team",
    memberUserIds: [local.userId],
    now: 1,
  });
  const project = db.listProjects(true)[0]!;
  assert.equal(db.setResourceScope({ resource: "project", resourceId: project.id, scope, now: 2 }), true);
  const updated = db.getProject(project.id)!;
  return { project: updated, location: updated.locations[0]!, scope };
}

/** Create a session through the service (runner online) and return its id. */
function seedSession(
  svc: SessionsService,
  hub: FakeHub,
  overrides: Partial<Parameters<SessionsService["createSession"]>[0]> = {},
): string {
  hub.online = true;
  const res = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    ...overrides,
  });
  assert.ok(res.ok && res.data, "seed createSession should succeed");
  return res.data!.id;
}

function seedReadyPodSession(
  db: ControlPlaneDb,
  svc: SessionsService,
  hub: FakeHub,
  title: string,
): string {
  const id = seedSession(svc, hub, { useWorktree: true, title });
  db.setWorktreePath(id, `/worktrees/${id}`);
  db.updateSessionStatus(id, "idle", Date.now());
  return id;
}

/* -------------------------------------------------------------------------- */
/* createSession                                                             */
/* -------------------------------------------------------------------------- */

test("createSession fails 409 when the runner is offline", () => {
  const { hub, svc, db } = makeHarness();
  hub.online = false;

  const res = svc.createSession({ runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID });

  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.match(res.error ?? "", /offline/);
  // Nothing should have been routed to the runner, and no session persisted.
  assert.equal(hub.sentToRunner.length, 0);
  assert.equal(db.listSessions().length, 0);
});

test("createSession infers the durable Project from the exact runner/workspace Location", () => {
  const { db, hub, svc } = makeHarness();
  const location = db.findProjectLocation(RUNNER_ID, WORKSPACE_ID)!;

  const id = seedSession(svc, hub);
  const session = db.getSession(id)!;

  assert.equal(session.projectId, location.projectId);
  assert.equal(session.projectLocationId, location.id);
  assert.ok(hub.projectChangedByIdCalls.includes(location.projectId));
});

test("createSession validates an explicit Project Location without falling back by name", () => {
  const { db, svc } = makeHarness();
  const unrelated = db.createProject({ name: "Unrelated" });
  const location = db.findProjectLocation(RUNNER_ID, WORKSPACE_ID)!;

  const mismatch = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    projectId: unrelated.id,
    projectLocationId: location.id,
    agentId: AGENT_ID,
  });
  assert.equal(mismatch.status, 409);

  const incomplete = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    projectId: location.projectId,
    agentId: AGENT_ID,
  });
  assert.equal(incomplete.status, 400);
});

test("direct createSession adopts an explicit team Project scope for automation callers", () => {
  const { db, svc } = makeHarness();
  const { project, location, scope } = makeTeamOwnedProject(db);

  const result = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    projectId: project.id,
    projectLocationId: location.id,
    agentId: AGENT_ID,
  });

  assert.ok(result.ok && result.data);
  assert.equal(result.data!.projectId, project.id);
  assert.deepEqual(db.sessionScope(result.data!.id), scope);
});

test("createSession rejects a detached Location after runner identity reuse", () => {
  const { db, svc } = makeHarness();
  const location = db.findProjectLocation(RUNNER_ID, WORKSPACE_ID)!;
  assert.ok(db.deleteRunner(RUNNER_ID));
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);

  const result = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    projectId: location.projectId,
    projectLocationId: location.id,
    agentId: AGENT_ID,
  });

  assert.equal(result.status, 409);
  assert.match(result.error ?? "", /no longer available/);
});

test("public createSession still rejects an explicitly removed Project Location", () => {
  const { db, svc } = makeHarness();
  const location = db.findProjectLocation(RUNNER_ID, WORKSPACE_ID)!;
  db.removeProjectLocation(location.id, Date.now());

  const result = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    projectId: location.projectId,
    projectLocationId: location.id,
    agentId: AGENT_ID,
  });

  assert.equal(result.status, 409);
  assert.equal(db.listSessions({ includeArchived: true }).length, 0);
});

test("side chat is an idempotent hidden session with no implicit context or fork ancestry", () => {
  const { db, hub, svc } = makeHarness();
  const parentId = seedSession(svc, hub, {
    title: "Primary investigation",
    prompt: "private primary prompt",
    config: {
      model: "opus",
      effort: "high",
      permissionMode: "acceptEdits",
      costBudgetUsd: 20,
      maxToolCalls: 50,
    },
  });
  const startsBefore = hub.sentOfType("start_session").length;

  const created = svc.createSideChat(parentId);

  assert.ok(created.ok && created.data);
  const child = created.data!.session;
  assert.equal(created.status, 201);
  assert.equal(child.archived, true, "the auxiliary session stays out of normal session lists");
  assert.equal(child.useWorktree, true, "writes are isolated from the primary checkout");
  assert.equal(child.model, "opus");
  assert.equal(child.effort, "high");
  assert.equal(child.permissionMode, "acceptEdits");
  assert.equal(child.costBudgetUsd, null, "primary accounting limits are not copied implicitly");
  assert.equal(child.maxToolCalls, null, "primary tool limits are not copied implicitly");
  assert.deepEqual(db.sessionScope(child.id), db.sessionScope(parentId), "ownership is derived from the authorized parent");
  assert.equal(db.listEvents(child.id, 0).length, 0, "no primary transcript content is copied");
  assert.equal(db.sessionForkIncludesAncestor(child.id, parentId), false, "side chat grants no fork artifact ancestry");
  assert.deepEqual(db.listSessions().map((session) => session.id), [parentId]);
  assert.equal(hub.sentOfType("start_session").length, startsBefore + 1);
  const childStart = hub.sentOfType("start_session").at(-1)!;
  assert.equal(childStart.spec.sessionId, child.id);
  assert.equal(childStart.initialPrompt, undefined);
  assert.equal(childStart.initialImages, undefined);
  assert.equal(childStart.spec.acpSessionContext, undefined);
  assert.deepEqual(childStart.spec.config, { model: "opus", effort: "high", permissionMode: "acceptEdits" });

  const retried = svc.createSideChat(parentId);
  assert.ok(retried.ok && retried.data);
  assert.equal(retried.status, 200);
  assert.equal(retried.data!.session.id, child.id);
  assert.equal(hub.sentOfType("start_session").length, startsBefore + 1, "retry does not launch another child");
  assert.equal(svc.createSideChat(child.id).status, 409, "auxiliary sessions cannot recursively spawn side chats");
  assert.equal(svc.setArchived(child.id, false).status, 409, "the hidden child cannot leak into ordinary lists");
});

test("a side-chat launch disconnect removes the undelivered child instead of orphaning it", () => {
  const { db, hub, svc } = makeHarness();
  const parentId = seedSession(svc, hub);
  hub.deliveryHandler = () => false;

  const result = svc.createSideChat(parentId);

  assert.equal(result.status, 409);
  assert.equal(db.getSideChat(parentId), null);
  assert.deepEqual(db.listSessions({ includeArchived: true }).map((session) => session.id), [parentId]);
  assert.equal(hub.sessionRemovedCalls.length, 1);
});

test("side chats retain the parent Project after its historical Location is removed", () => {
  const { db, hub, svc } = makeHarness();
  const parentId = seedSession(svc, hub);
  const parent = db.getSession(parentId)!;
  db.removeProjectLocation(parent.projectLocationId!, Date.now());

  const result = svc.createSideChat(parentId);

  assert.ok(result.ok && result.data);
  assert.equal(result.data!.session.projectId, parent.projectId);
  assert.equal(result.data!.session.projectLocationId, null);
});

test("deleting a primary session also tombstones and removes its side chat", () => {
  const { db, hub, svc } = makeHarness();
  const parentId = seedSession(svc, hub);
  const childId = svc.createSideChat(parentId).data!.session.id;

  const removed = svc.delete(parentId);

  assert.ok(removed.ok);
  assert.equal(db.getSession(parentId), null);
  assert.equal(db.getSession(childId), null);
  assert.equal(db.getSideChat(parentId), null);
  assert.equal(db.isTombstoned(parentId), true);
  assert.equal(db.isTombstoned(childId), true);
  assert.deepEqual(
    hub.sentOfType("delete_session").slice(-2).map((message) => message.sessionId),
    [childId, parentId],
  );
});

test("side chat creation is driver-neutral across Codex app-server, Claude, and ACP", () => {
  for (const [agentId, driver] of [
    [CODEX_APP_AGENT_ID, "codex-app-server"],
    [AGENT_ID, "claude-code"],
    [ACP_AGENT_ID, "acp"],
  ] as const) {
    const { hub, svc } = makeHarness();
    const parentId = seedSession(svc, hub, { agentId });
    const result = svc.createSideChat(parentId);
    assert.ok(result.ok && result.data, agentId);
    assert.equal(result.data!.session.driver, driver, agentId);
    assert.equal(result.data!.session.agentId, agentId, agentId);
    assert.equal(result.data!.session.useWorktree, true, agentId);
    assert.equal(hub.sentOfType("start_session").at(-1)!.initialPrompt, undefined, agentId);
  }
});

test("createSession fails closed when the runner disconnects after preflight", () => {
  const { hub, svc, db } = makeHarness();
  hub.deliveryHandler = () => false;

  const res = svc.createSession({ runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID });

  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.match(res.error ?? "", /disconnected while launching/);
  const persisted = db.listSessions({ includeArchived: true });
  assert.equal(persisted.length, 1, "the durable failure remains visible for diagnosis");
  assert.equal(persisted[0]!.status, "stopped");
});

test("partial workflow launch rollback retains legacy cancel_session semantics", () => {
  const { hub, svc, db } = makeHarness();
  let starts = 0;
  hub.deliveryHandler = (_runnerId, message) => message.type !== "start_session" || (starts += 1) === 1;

  const result = svc.createWorkflowRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: "builtin:build-review",
    task: "Rollback a partial launch",
    agentBindings: { claude: AGENT_ID, codex: CODEX_APP_AGENT_ID },
  });

  assert.equal(result.status, 409);
  assert.equal(hub.sentOfType("cancel_session").length, 1);
  assert.equal(hub.sentOfType("interrupt_turn").length, 0);
  assert.equal(db.listSessions({ includeArchived: true }).every((session) => session.status === "stopped"), true);
});

test("ACP context is validated, persisted as references, forwarded, and restored on restart", () => {
  const { db, hub, svc } = makeHarness();
  const acpSessionContext = {
    mcpServers: [{
      type: "http" as const,
      name: "github",
      url: "https://mcp.example/rpc",
      headers: { Authorization: { fromEnv: "GITHUB_MCP_AUTH" } },
    }],
    additionalDirectories: ["/repos/shared"],
  };
  const created = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: ACP_AGENT_ID,
    acpSessionContext,
  });
  assert.equal(created.ok, true, created.error);
  const first = hub.lastSent();
  assert.ok(first?.type === "start_session");
  assert.deepEqual(first.spec.acpSessionContext, acpSessionContext);
  assert.deepEqual(db.getAcpSessionContext(created.data!.id), acpSessionContext);
  assert.equal(JSON.stringify(db.getAcpSessionContext(created.data!.id)).includes("Bearer"), false);

  const restarted = svc.restart(created.data!.id);
  assert.equal(restarted.ok, true, restarted.error);
  const second = hub.lastSent();
  assert.ok(second?.type === "start_session");
  assert.deepEqual(second.spec.acpSessionContext, acpSessionContext);
});

test("ACP context rejects plaintext-shaped secrets, cleartext remote URLs, and non-ACP agents", () => {
  const { svc } = makeHarness();
  const malformed = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: ACP_AGENT_ID,
    acpSessionContext: { mcpServers: [{
      type: "http",
      name: "bad",
      url: "http://remote.example/rpc",
      headers: { Authorization: "plaintext-secret" as never },
    }] },
  });
  assert.equal(malformed.status, 400);
  const hiddenSecret = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: ACP_AGENT_ID,
    acpSessionContext: { mcpServers: [{ type: "sse", name: "bad", url: "https://mcp.example/sse", token: "secret" } as never] },
  });
  assert.equal(hiddenSecret.status, 400);
  assert.match(hiddenSecret.error!, /unsupported fields/);
  const wrongDriver = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    acpSessionContext: { additionalDirectories: ["/repos/shared"] },
  });
  assert.equal(wrongDriver.status, 400);
  assert.match(wrongDriver.error!, /only be used with an ACP agent/);
  const relativeCommand = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: ACP_AGENT_ID,
    acpSessionContext: { mcpServers: [{ type: "stdio", name: "relative", command: "mcp-server" }] },
  });
  assert.equal(relativeCommand.status, 400);
  assert.match(relativeCommand.error!, /command must be absolute/);
  const relativeDirectory = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: ACP_AGENT_ID,
    acpSessionContext: { additionalDirectories: ["../shared"] },
  });
  assert.equal(relativeDirectory.status, 400);
  assert.match(relativeDirectory.error!, /must be absolute/);
  const ungrantedDirectory = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: ACP_AGENT_ID,
    acpSessionContext: { additionalDirectories: ["/repos/not-granted"] },
  });
  assert.equal(ungrantedDirectory.status, 400);
  assert.match(ungrantedDirectory.error!, /not granted/);
});

test("ACP context fails closed against a pre-v38 runner instead of being silently ignored", () => {
  const { db, hub, svc } = makeHarness();
  db.registerRunner(runnerMeta(), Date.now(), 37);
  const result = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: ACP_AGENT_ID,
    acpSessionContext: { mcpServers: [{ type: "sse", name: "docs", url: "https://mcp.example/sse" }] },
  });
  assert.equal(result.status, 409);
  assert.match(result.error!, /requires protocol v38/);
  assert.equal(db.listSessions().length, 0);
  assert.equal(hub.sentToRunner.length, 0);
});

test("createSession rejects unsupported image input before creating or sending", () => {
  const { hub, svc, db } = makeHarness();
  const before = db.listSessions().length;
  const res = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: CODEX_APP_AGENT_ID,
    prompt: "look",
    images: [{ mimeType: "image/gif", data: "eA==" }],
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.match(res.error!, /unsupported MIME.*image\/png.*image\/jpeg.*image\/webp/);
  assert.equal(db.listSessions().length, before);
  assert.equal(hub.sentToRunner.length, 0);
});

test("createSession accepts a compatible Claude family alias without rewriting the selection", () => {
  const { db, hub, svc } = makeHarness();
  db.updateRunnerAgents(
    RUNNER_ID,
    runnerMeta().agents.map((agent) => agent.id === AGENT_ID ? {
      ...agent,
      capabilities: {
        models: [
          { id: "default", default: true },
          { id: "claude-fable-5[1m]", displayName: "Fable 5" },
        ],
        effortLevels: ["low"],
        slashCommands: [],
        supportsImages: true,
        supportsApprovals: true,
        permissionModes: ["default", "acceptEdits"],
      },
    } : agent),
    Date.now(),
  );

  const result = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    config: { model: "fable" },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data?.model, "fable");
  assert.equal(hub.sentOfType("start_session").at(-1)?.spec.config.model, "fable");
});

test("Claude sessions retain existing GIF attachment compatibility", () => {
  const { hub, svc } = makeHarness();
  const res = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    prompt: "look",
    images: [{ mimeType: "image/gif", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" }],
  });
  assert.equal(res.ok, true, res.error);
  const sent = hub.lastSent();
  assert.ok(sent?.type === "start_session");
  assert.equal(sent.initialImages?.[0]?.mimeType, "image/gif");
  assert.ok(sent.initialImages?.[0] && "artifactId" in sent.initialImages[0]);
  assert.equal(JSON.stringify(sent).includes("R0lGODlh"), false);
});

test("createSession rejects images for an explicitly text-only live model", () => {
  const { db, hub, svc } = makeHarness();
  const res = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: CODEX_APP_AGENT_ID,
    prompt: "look",
    config: { model: "text-model" },
    images: [{ mimeType: "image/png", data: "iVBORw==" }],
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.match(res.error!, /text-model.*does not support image input/);
  assert.equal(db.listSessions().length, 0);
  assert.equal(hub.sentToRunner.length, 0);
});

test("Codex exec sessions retain existing JPG attachment compatibility", () => {
  const { hub, svc } = makeHarness();
  const res = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: CODEX_AGENT_ID,
    prompt: "look",
    images: [{ mimeType: "image/jpg", data: "/9j/2Q==" }],
  });
  assert.equal(res.ok, true, res.error);
  const sent = hub.lastSent();
  assert.ok(sent?.type === "start_session");
  assert.equal(sent.initialImages?.[0]?.mimeType, "image/jpg");
  assert.ok(sent.initialImages?.[0] && "artifactId" in sent.initialImages[0]);
  assert.equal(JSON.stringify(sent).includes("/9j/2Q=="), false);
  assert.equal(sent.spec.codexExecFallbackReason, "explicit_exec");
});

test("prompt images fail closed against a pre-v56 runner", () => {
  const { db, hub, svc } = makeHarness();
  db.registerRunner(runnerMeta(), Date.now(), 55);
  const result = svc.createSession({
    runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID, prompt: "look",
    images: [{ mimeType: "image/jpeg", data: "/9j/2Q==" }],
  });
  assert.equal(result.status, 409);
  assert.match(result.error ?? "", /requires protocol v56/);
  assert.equal(db.listSessions().length, 0);
  assert.equal(hub.sentToRunner.length, 0);
});

test("Codex exec telemetry is compatibility usage when same-context app-server is unavailable", () => {
  const { db, hub, svc } = makeHarness();
  db.updateRunnerAgents(
    RUNNER_ID,
    runnerMeta().agents.map((agent) =>
      agent.id === CODEX_APP_AGENT_ID ? { ...agent, available: false } : agent,
    ),
    Date.now(),
  );
  const res = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: CODEX_AGENT_ID,
  });
  assert.equal(res.ok, true, res.error);
  const sent = hub.lastSent();
  assert.ok(sent?.type === "start_session");
  assert.equal(sent.spec.codexExecFallbackReason, "compatibility_exec");
});

test("createSession fails 404 for an unknown agent", () => {
  const { svc } = makeHarness();
  const res = svc.createSession({ runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "nope" });
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
});

test("explicitly unavailable agents cannot create sessions or runs", () => {
  const { db, hub, svc } = makeHarness();
  const unavailable = runnerMeta().agents.map((agent) =>
    agent.id === CODEX_APP_AGENT_ID
      ? {
          ...agent,
          available: false,
          codexAppServer: {
            status: "unavailable" as const,
            appServerAvailable: false,
            failure: {
              code: "codex_unavailable" as const,
              message: "Codex is not installed in this runner context.",
              retryable: false,
            },
          },
        }
      : agent,
  );
  db.updateRunnerAgents(RUNNER_ID, unavailable, Date.now());
  const stored = db.getRunner(RUNNER_ID)!.agents.find((agent) => agent.id === CODEX_APP_AGENT_ID)!;
  assert.equal(stored.codexAppServer?.appServerAvailable, false);
  assert.equal(stored.codexAppServer?.failure?.code, "codex_unavailable");

  const session = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: CODEX_APP_AGENT_ID,
  });
  assert.equal(session.ok, false);
  assert.equal(session.status, 404);

  const run = svc.createRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentIds: [CODEX_APP_AGENT_ID],
    task: "try the unavailable target",
  });
  assert.equal(run.ok, false);
  assert.equal(run.status, 404);
  assert.equal(db.listSessions({ includeArchived: true }).length, 0);
  assert.equal(db.listRuns().length, 0);
  assert.equal(hub.sentOfType("start_session").length, 0);
});

test("createSession fails 404 for an unknown workspace", () => {
  const { svc } = makeHarness();
  const res = svc.createSession({ runnerId: RUNNER_ID, workspaceId: "nope", agentId: AGENT_ID });
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
});

test("createRun preserves an exact Project Location for every member and keeps legacy inference", () => {
  const { svc, db } = makeHarness();
  const location = db.findProjectLocation(RUNNER_ID, WORKSPACE_ID)!;

  const explicit = svc.createRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    projectId: location.projectId,
    projectLocationId: location.id,
    agentIds: [AGENT_ID, CODEX_APP_AGENT_ID],
    task: "Build in this Project",
  });
  assert.ok(explicit.ok && explicit.data);
  for (const session of explicit.data!.sessions) {
    assert.equal(session.projectId, location.projectId);
    assert.equal(session.projectLocationId, location.id);
  }

  const legacy = svc.createRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentIds: [AGENT_ID],
    task: "Legacy exact-Location inference",
  });
  assert.equal(legacy.data!.sessions[0]!.projectId, location.projectId);
  assert.equal(legacy.data!.sessions[0]!.projectLocationId, location.id);
});

test("createRun rejects incomplete Project identity before persisting a run", () => {
  const { svc, db } = makeHarness();
  const location = db.findProjectLocation(RUNNER_ID, WORKSPACE_ID)!;

  const result = svc.createRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    projectId: location.projectId,
    agentIds: [AGENT_ID],
    task: "Invalid Project assignment",
  });

  assert.equal(result.status, 400);
  assert.equal(db.listRuns().length, 0);
  assert.equal(db.listSessions({ includeArchived: true }).length, 0);
});

test("createRun adopts a team Project scope on an organization-visible Location", () => {
  const { svc, db } = makeHarness();
  const { project, location, scope } = makeTeamOwnedProject(db);

  const result = svc.createRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    projectId: project.id,
    projectLocationId: location.id,
    agentIds: [AGENT_ID, CODEX_APP_AGENT_ID],
    task: "Build for the Project team",
  });

  assert.ok(result.ok && result.data);
  for (const session of result.data!.sessions) {
    assert.equal(session.projectId, project.id);
    assert.equal(session.projectLocationId, location.id);
    assert.deepEqual(db.sessionScope(session.id), scope);
  }
});

test("createRun rejects member counts that cannot be represented by the live UI subscription", () => {
  const { svc, db, hub } = makeHarness();
  const res = svc.createRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentIds: Array.from({ length: MAX_UI_SESSION_SUBSCRIPTIONS + 1 }, () => AGENT_ID),
    task: "too many members",
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.match(res.error ?? "", new RegExp(`at most ${MAX_UI_SESSION_SUBSCRIPTIONS}`));
  assert.equal(db.listRuns().length, 0);
  assert.equal(db.listSessions({ includeArchived: true }).length, 0);
  assert.equal(hub.sentOfType("start_session").length, 0);
});

test("createSession online → 201 and sends start_session with the right launch spec", () => {
  const { hub, svc, db } = makeHarness();

  const res = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    prompt: "hello there",
    config: { model: "opus", effort: "high", permissionMode: "plan" },
  });

  assert.ok(res.ok);
  assert.equal(res.status, 201);
  const id = res.data!.id;

  // Session persisted with the supplied config.
  const stored = db.getSession(id)!;
  assert.equal(stored.model, "opus");
  assert.equal(stored.effort, "high");
  assert.equal(stored.permissionMode, "plan");
  assert.equal(stored.driver, "claude-code");
  assert.equal(stored.titleSource, "generated");

  // start_session routed to the owning runner with the resolved spec.
  const starts = hub.sentOfType("start_session");
  assert.equal(starts.length, 1);
  const msg = starts[0];
  assert.equal(hub.sentToRunner[0].runnerId, RUNNER_ID);
  assert.equal(msg.spec.sessionId, id);
  assert.equal(msg.spec.workspaceId, WORKSPACE_ID);
  assert.equal(msg.spec.workspacePath, WORKSPACE_PATH);
  assert.equal(msg.spec.agentId, AGENT_ID);
  assert.equal(msg.spec.agentVersion, "2.1.0");
  assert.equal(msg.spec.command, "claude");
  assert.deepEqual(msg.spec.args, ["--flag"]);
  assert.deepEqual(msg.spec.env, {}, "v54 launch specs carry no agent environment values");
  assert.equal(msg.spec.driver, "claude-code");
  assert.deepEqual(msg.spec.context, { kind: "native" });
  assert.deepEqual(msg.spec.config, { model: "opus", effort: "high", permissionMode: "plan" });
  assert.equal(msg.spec.title, "hello there"); // title flows to the box store for cross-dashboard display
  assert.equal(msg.spec.titleSource, "generated");
  assert.equal(msg.initialPrompt, "hello there");

  // A session_upsert broadcast was emitted; the user_message is now emitted by the runner (box) into
  // its store + stream, not appended by the control plane.
  assert.equal(hub.sessionChangedCalls.length, 1);
  assert.equal(hub.sessionEventCalls.length, 0);
});

test("createSession selects and persists an exact compatible container environment", () => {
  const { db, hub, svc } = makeHarness();
  const image = `example/agent@sha256:${"3".repeat(64)}`;
  const container = {
    id: `runner:${RUNNER_ID}:container:offline-tools`, runnerId: RUNNER_ID, name: "host · Offline tools",
    kind: "container" as const, workspaceStrategy: "worktree" as const, adapter: "container" as const,
    boundaries: { filesystem: "container" as const, network: "deny" as const, secrets: "none" as const, billing: "none" as const },
    environment: { id: "offline-tools", revision: 1, image, setupCheckDigest: "4".repeat(64) },
    compatibleAgentIds: [AGENT_ID, ACP_AGENT_ID], available: true,
  };
  db.registerRunner({ ...runnerMeta(), executionTargets: [container] }, Date.now(), PROTOCOL_VERSION);
  assert.deepEqual(db.getRunner(RUNNER_ID)!.executionTargets?.at(-1)?.environment, container.environment);

  const result = svc.createSession({
    runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID,
    executionTargetId: container.id, useWorktree: true,
  });
  assert.ok(result.ok && result.data, result.error);
  assert.deepEqual(hub.sentOfType("start_session").at(-1)!.spec.executionTarget, {
    id: container.id, runnerId: RUNNER_ID, kind: "container", workspaceStrategy: "worktree",
    adapter: "container", boundaries: container.boundaries, environment: container.environment,
  });
  assert.deepEqual(db.getSession(result.data!.id)!.executionTarget, hub.sentOfType("start_session").at(-1)!.spec.executionTarget);

  const incompatible = svc.createSession({
    runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: CODEX_AGENT_ID,
    executionTargetId: container.id, useWorktree: true,
  });
  assert.equal(incompatible.ok, false);
  assert.match(incompatible.error ?? "", /does not configure/);

  const hostContext = svc.createSession({
    runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: ACP_AGENT_ID,
    executionTargetId: container.id, useWorktree: true,
    acpSessionContext: { additionalDirectories: ["/host/secret"] },
  });
  assert.equal(hostContext.ok, false);
  assert.match(hostContext.error ?? "", /do not permit ACP/);
});

test("createSession resolves cloud artifact provenance and enforces the target cost budget", () => {
  const { db, hub, svc } = makeHarness();
  const cloud = {
    id: `runner:${RUNNER_ID}:cloud:metered-tools`, runnerId: RUNNER_ID, name: "host · Metered tools",
    kind: "cloud" as const, workspaceStrategy: "snapshot" as const, adapter: "cloud" as const,
    boundaries: { filesystem: "snapshot" as const, network: "policy" as const, secrets: "references" as const, billing: "target_metered" as const },
    environment: {
      id: "metered-tools", revision: 1, image: `example/cloud@sha256:${"5".repeat(64)}`,
      setupCheckDigest: "6".repeat(64),
    },
    policy: {
      cost: { currency: "USD" as const, estimatedHourlyRateUsd: 1.25, minimumBudgetUsd: 0.5, maximumBudgetUsd: 20 },
      admission: { maxConcurrentSessions: 2, queue: "fifo" as const },
    },
    compatibleAgentIds: [AGENT_ID], available: true,
  };
  db.registerRunner({ ...runnerMeta(), executionTargets: [cloud] }, Date.now(), 62);
  const sourceId = seedSession(svc, hub, { useWorktree: true });
  db.updateSessionStatus(sourceId, "idle", Date.now());
  const artifact = svc.createWorkflowArtifact({
    sessionId: sourceId,
    kind: "patch",
    name: "handoff.patch",
    mimeType: "text/x-diff",
    encoding: "utf8",
    data: "diff --git a/a b/a\n",
  }).data!;
  const created = svc.createSession({
    runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID,
    executionTargetId: cloud.id, useWorktree: true, config: { costBudgetUsd: 5 },
    executionHandoff: { sourceSessionId: sourceId, artifactIds: [artifact.artifactId] },
  });
  assert.ok(created.ok && created.data, created.error);
  const spec = hub.sentOfType("start_session").at(-1)!.spec;
  assert.equal(spec.executionTarget?.workspaceStrategy, "snapshot");
  assert.deepEqual(spec.executionTarget?.policy, cloud.policy);
  assert.deepEqual(spec.executionHandoff, {
    sourceSessionId: sourceId,
    artifacts: [{
      artifactId: artifact.artifactId, kind: "patch", sizeBytes: artifact.sizeBytes, sha256: artifact.sha256,
    }],
  });
  assert.deepEqual(db.getSession(created.data.id)!.executionTarget?.policy, cloud.policy);
  assert.deepEqual(db.getExecutionHandoffRequest(created.data.id), spec.executionHandoff);

  const missingBudget = svc.createSession({
    runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID,
    executionTargetId: cloud.id, useWorktree: true,
  });
  assert.equal(missingBudget.ok, false);
  assert.match(missingBudget.error ?? "", /cost budget/);
  const overBudget = svc.createSession({
    runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID,
    executionTargetId: cloud.id, useWorktree: true, config: { costBudgetUsd: 25 },
  });
  assert.equal(overBudget.ok, false);
  assert.match(overBudget.error ?? "", /cost budget/);

  const malformedArtifacts = svc.createSession({
    runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID,
    executionTargetId: cloud.id, useWorktree: true, config: { costBudgetUsd: 5 },
    executionHandoff: { artifactIds: "not-an-array" } as never,
  });
  assert.equal(malformedArtifacts.ok, false);
  assert.match(malformedArtifacts.error ?? "", /artifact ids are invalid/);

  const wrongOwner = svc.createSession({
    runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID,
    executionTargetId: cloud.id, useWorktree: true, config: { costBudgetUsd: 5 },
    executionHandoff: { sourceSessionId: sourceId },
  }, undefined, {
    organizationId: "org-other",
    owner: { kind: "organization", organizationId: "org-other" },
  });
  assert.equal(wrongOwner.ok, false);
  assert.match(wrongOwner.error ?? "", /ownership does not match/);

  db.updateSessionStatus(created.data.id, "failed", Date.now());
  const restarted = svc.restart(created.data.id);
  assert.ok(restarted.ok, restarted.error);
  assert.deepEqual(hub.sentOfType("start_session").at(-1)!.spec.executionHandoff, spec.executionHandoff);
});

test("createSession stages an exact deterministic launch before materialization and activates after it", () => {
  const { db, hub, svc } = makeHarness();
  const order: string[] = [];
  let staged: PreStagedDeliveryPlan | undefined;
  const request = {
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    prompt: "durable hello",
    config: { costBudgetUsd: 7, maxToolCalls: 3.9 },
  };
  const delivery = {
    sessionId: "s_automation_exact",
    stage(plan: PreStagedDeliveryPlan) {
      order.push("stage");
      const firstMaterialization = staged === undefined;
      staged = plan;
      if (firstMaterialization) {
        assert.equal(db.getSession("s_automation_exact"), null, "stage precedes the session insert");
      }
    },
    activate(plan: PreStagedDeliveryPlan) {
      order.push("activate");
      assert.strictEqual(plan, staged);
      assert.ok(db.getSession("s_automation_exact"), "activation follows materialization");
    },
  };

  const created = svc.createSession(request, delivery);
  assert.equal(created.status, 201);
  assert.equal(created.data!.id, "s_automation_exact");
  assert.deepEqual(order, ["stage", "activate"]);
  assert.equal(staged!.sessionId, "s_automation_exact");
  assert.equal(staged!.commands.length, 1);
  const command = staged!.commands[0]!;
  assert.equal(command.type, "start_session");
  assert.equal(command.spec.sessionId, "s_automation_exact");
  assert.equal(command.initialPrompt, "durable hello");
  assert.equal(command.spec.config.maxToolCalls, 3);
  assert.equal(hub.sentOfType("start_session").length, 0, "durable delivery skips the legacy hub send");

  order.length = 0;
  const recovered = svc.createSession(request, delivery);
  assert.equal(recovered.status, 201, "the same deterministic materialization is re-entrant");
  assert.deepEqual(order, ["stage", "activate"]);
  assert.equal(db.listSessions({ includeArchived: true }).filter((session) => session.id === created.data!.id).length, 1);

  let conflictingStaged = false;
  const conflict = svc.createSession({ ...request, title: "different" }, {
    ...delivery,
    stage() { conflictingStaged = true; },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflictingStaged, false, "resource conflicts fail before staging");
  db.close();
});

test("createSession recovery materializes from the staged launch snapshot after discovery changes", () => {
  const { db, svc } = makeHarness();
  const request = {
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    prompt: "snapshot-stable launch",
    config: { maxToolCalls: 5 },
  };
  let staged: PreStagedDeliveryPlan | undefined;
  assert.throws(() => svc.createSession(request, {
    sessionId: "s_snapshot_recovery",
    stage(plan) {
      staged = plan;
      throw new Error("simulated crash after durable staging");
    },
    activate() { assert.fail("must not activate before materialization"); },
  }), /simulated crash/);
  assert.equal(db.getSession("s_snapshot_recovery"), null);
  const original = staged!.commands[0]!;
  assert.equal(original.type, "start_session");
  assert.equal(original.spec.command, "claude");
  assert.deepEqual(original.spec.args, ["--flag"]);

  const changed = runnerMeta();
  const changedAgent = changed.agents.find((agent) => agent.id === AGENT_ID)!;
  changedAgent.command = "claude-next";
  changedAgent.args = ["--new-launch-contract"];
  changedAgent.env = { CHANGED: "yes" };
  changedAgent.driver = "acp";
  changedAgent.version = "99.0.0";
  db.registerRunner(changed, 500, PROTOCOL_VERSION);

  let recoveryPlan: PreStagedDeliveryPlan | undefined;
  const recovered = svc.createSession(request, {
    sessionId: "s_snapshot_recovery",
    commandSnapshots: staged!.commands,
    stage(plan) { recoveryPlan = plan; },
    activate() {},
  });
  assert.equal(recovered.status, 201);
  assert.deepEqual(recoveryPlan!.commands, staged!.commands,
    "recovery must restage the exact persisted command instead of current discovery metadata");
  assert.equal(recovered.data!.driver, "claude-code");
  assert.equal(recovered.data!.maxToolCalls, 5);
  db.close();
});

test("createSession recovery cannot resurrect a conductor removed from current discovery", () => {
  const { db, svc } = makeHarness();
  const request = {
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: CONDUCTOR_ID,
    prompt: "resume orchestration",
  };
  let staged: PreStagedDeliveryPlan | undefined;
  assert.throws(() => svc.createSession(request, {
    sessionId: "s_disabled_conductor",
    stage(plan) {
      staged = plan;
      throw new Error("simulated crash after durable staging");
    },
    activate() { assert.fail("must not activate before materialization"); },
  }), /simulated crash/);
  assert.equal(db.getSession("s_disabled_conductor"), null);

  const current = runnerMeta();
  current.agents = current.agents.filter((agent) => agent.id !== CONDUCTOR_ID);
  db.updateRunnerAgents(RUNNER_ID, current.agents, 500);

  let restaged = false;
  const recovered = svc.createSession(request, {
    sessionId: "s_disabled_conductor",
    commandSnapshots: staged!.commands,
    stage() { restaged = true; },
    activate() { assert.fail("disabled conductor recovery must not activate"); },
  });
  assert.equal(recovered.status, 404);
  assert.match(recovered.error ?? "", /unknown agent 'conductor'/);
  assert.equal(restaged, false);
  assert.equal(db.getSession("s_disabled_conductor"), null);
  db.close();
});

test("createSession recovery defers the conductor decision while runner discovery is pending", () => {
  const { db, svc } = makeHarness();
  const request = {
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: CONDUCTOR_ID,
    prompt: "resume orchestration",
  };
  let staged: PreStagedDeliveryPlan | undefined;
  assert.throws(() => svc.createSession(request, {
    sessionId: "s_pending_conductor_discovery",
    stage(plan) {
      staged = plan;
      throw new Error("simulated crash after durable staging");
    },
    activate() { assert.fail("must not activate before materialization"); },
  }), /simulated crash/);

  const registering = runnerMeta();
  registering.agents = registering.agents.filter((agent) => agent.id !== CONDUCTOR_ID);
  db.registerRunner(registering, 500, PROTOCOL_VERSION);
  assert.equal(db.getRunner(RUNNER_ID)?.agentsRefreshed, false);

  const recovered = svc.createSession(request, {
    sessionId: "s_pending_conductor_discovery",
    commandSnapshots: staged!.commands,
    stage() {},
    activate() {},
  });
  assert.equal(recovered.status, 201,
    "the runner-side flag guard decides until a completed discovery result proves removal");
  db.close();
});

test("createSession does not materialize when durable staging throws", () => {
  const { db, svc } = makeHarness();
  assert.throws(() => svc.createSession({
    runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID,
  }, {
    sessionId: "s_stage_failure",
    stage() { throw new Error("outbox unavailable"); },
    activate() { assert.fail("must not activate"); },
  }), /outbox unavailable/);
  assert.equal(db.getSession("s_stage_failure"), null);
  db.close();
});

test("createSession with no prompt does not emit a user_message event", () => {
  const { hub, svc } = makeHarness();
  svc.createSession({ runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID });
  assert.equal(hub.sessionEventCalls.length, 0);
  const start = hub.sentOfType("start_session")[0];
  assert.equal(start.initialPrompt, undefined);
});

/* -------------------------------------------------------------------------- */
/* prompt                                                                    */
/* -------------------------------------------------------------------------- */

test("provider command invocation resolves live authority server-side and reconciles receipts", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "idle", Date.now());
  db.raw().prepare("UPDATE sessions SET agent_capabilities=? WHERE id=?").run(JSON.stringify({
    slashCommands: [{
      name: "deploy",
      source: "project",
      description: "Deploy the application",
      invocation: {
        id: "command-live",
        catalogRevision: "catalog-live",
        executionMode: "passthrough",
      },
    }],
  }), id);
  hub.sentToRunner.length = 0;

  const staged = svc.invokeSessionCommand(id, {
    submissionId: "submission-command",
    providerCommandId: "command-live",
    catalogRevision: "catalog-live",
    argumentText: "production",
  });
  assert.equal(staged.ok, true);
  assert.equal(staged.status, 202);
  assert.equal(staged.data?.state, "sent");
  assert.equal(staged.data?.commandName, "deploy");
  const wire = hub.sentOfType("invoke_session_command")[0];
  assert.ok(wire);
  assert.equal(wire.expectedExecutionMode, "passthrough");
  assert.equal(wire.argumentText, "production");

  const duplicate = svc.invokeSessionCommand(id, {
    submissionId: "submission-command",
    providerCommandId: "command-live",
    catalogRevision: "catalog-live",
    argumentText: "production",
  });
  assert.equal(duplicate.data?.invocationId, staged.data?.invocationId);
  assert.equal(hub.sentOfType("invoke_session_command").length, 1);
  assert.equal(svc.invokeSessionCommand(id, {
    submissionId: "submission-command",
    providerCommandId: "command-live",
    catalogRevision: "catalog-live",
    argumentText: "staging",
  }).status, 409);
  assert.equal(svc.invokeSessionCommand(id, {
    submissionId: "submission-stale",
    providerCommandId: "command-live",
    catalogRevision: "catalog-stale",
    argumentText: "",
  }).status, 409);

  assert.equal(svc.onSessionCommandInvocationReceipt("wrong-runner", {
    type: "session_command_invocation_result",
    requestId: wire.requestId,
    invocationId: wire.invocationId,
    submissionId: wire.submissionId,
    sessionId: wire.sessionId,
    state: "accepted",
    revision: 1,
    duplicate: false,
  }), false);
  assert.equal(svc.onSessionCommandInvocationReceipt(RUNNER_ID, {
    type: "session_command_invocation_result",
    requestId: wire.requestId,
    invocationId: wire.invocationId,
    submissionId: wire.submissionId,
    sessionId: wire.sessionId,
    state: "accepted",
    revision: 1,
    duplicate: false,
  }), true);
  assert.equal(svc.onSessionCommandInvocationReceipt(RUNNER_ID, {
    type: "session_command_invocation_update",
    invocationId: wire.invocationId,
    submissionId: wire.submissionId,
    sessionId: wire.sessionId,
    state: "completed",
    revision: 4,
    userEventSeq: 9,
  }), true);
  assert.equal(db.getSession(id)?.commandInvocations?.[0]?.state, "completed");
  assert.equal(db.getSession(id)?.commandInvocations?.[0]?.userEventSeq, 9);
});

test("offline provider commands remain durable and capability loss settles them fail-closed", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "idle", Date.now());
  db.raw().prepare("UPDATE sessions SET agent_capabilities=? WHERE id=?").run(JSON.stringify({
    slashCommands: [{
      name: "review",
      source: "user",
      invocation: {
        id: "command-review",
        catalogRevision: "catalog-review",
        executionMode: "passthrough",
      },
    }],
  }), id);
  hub.online = false;
  hub.sentToRunner.length = 0;
  const staged = svc.invokeSessionCommand(id, {
    submissionId: "submission-offline-command",
    providerCommandId: "command-review",
    catalogRevision: "catalog-review",
    argumentText: "storage",
  });
  assert.equal(staged.ok, true);
  assert.equal(staged.data?.state, "pending");
  assert.equal(hub.sentOfType("invoke_session_command").length, 0);

  hub.online = true;
  assert.equal(svc.recoverPendingSessionCommands(RUNNER_ID), 1);
  assert.equal(db.getSession(id)?.commandInvocations?.[0]?.state, "sent");
  db.registerRunner(runnerMeta(), Date.now(), 74);
  assert.equal(svc.recoverPendingSessionCommands(RUNNER_ID), 1);
  assert.equal(db.getSession(id)?.commandInvocations?.[0]?.state, "uncertain");
});

test("steer persists before dispatch, relays an accepted receipt, and is idempotent", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID, config: { model: "image-model", effort: "high" } });
  db.updateSessionStatus(id, "running", Date.now());
  hub.activeTurnIds.set(id, "turn-live");
  hub.sentToRunner.length = 0;
  let observedPending = false;
  hub.requestHandler = (message) => {
    assert.equal(message.type, "steer_session");
    observedPending = db.getSession(id)?.steeringAttempts?.[0]?.state === "pending";
    return {
      type: "steer_session_result",
      requestId: message.requestId,
      submissionId: message.submissionId,
      sessionId: id,
      turnId: "turn-live",
      disposition: "accepted",
      reason: "accepted",
      providerTurnId: "provider-turn",
    };
  };
  const before = db.getSession(id)!;
  const first = await svc.steer(id, {
    submissionId: "submission-direct", turnId: "turn-live", text: "Use the narrower implementation",
  });
  assert.equal(first.ok, true);
  assert.equal(first.data?.state, "accepted");
  assert.equal(observedPending, true, "the durable outbox row exists before runner dispatch");
  assert.equal(hub.sentOfType("steer_session").length, 1);
  assert.equal(db.getSession(id)?.status, before.status, "steering does not optimistically mutate lifecycle state");
  assert.equal(db.getSession(id)?.model, before.model, "steering does not mutate persisted configuration");

  const duplicate = await svc.steer(id, {
    submissionId: "submission-direct", turnId: "turn-live", text: "Use the narrower implementation",
  });
  assert.equal(duplicate.data?.state, "accepted");
  assert.equal(hub.sentOfType("steer_session").length, 1, "identical terminal duplicates never redispatch");
  const conflict = await svc.steer(id, {
    submissionId: "submission-direct", turnId: "turn-live", text: "Different content",
  });
  assert.equal(conflict.status, 409);
});

test("steer fails closed on capability and turn gates and records ambiguous delivery", async () => {
  const { db, hub, svc } = makeHarness();
  const unsupported = seedSession(svc, hub, { agentId: AGENT_ID });
  db.updateSessionStatus(unsupported, "running", Date.now());
  hub.activeTurnIds.set(unsupported, "turn-unsupported");
  assert.equal((await svc.steer(unsupported, {
    submissionId: "submission-unsupported", turnId: "turn-unsupported", text: "continue",
  })).status, 409);

  const id = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  hub.activeTurnIds.set(id, "turn-current");
  for (const status of ["idle", "queued", "starting", "completed"] as const) {
    db.updateSessionStatus(id, status, Date.now());
    assert.equal((await svc.steer(id, {
      submissionId: `submission-${status}`, turnId: "turn-current", text: "continue",
    })).status, 409, `${status} is not an active steering lifecycle`);
  }
  db.updateSessionStatus(id, "running", Date.now());
  db.registerRunner(runnerMeta(), Date.now(), 72);
  assert.equal((await svc.steer(id, {
    submissionId: "submission-v72", turnId: "turn-current", text: "continue",
  })).status, 409, "protocol v72 fails closed");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  assert.equal((await svc.steer(id, {
    submissionId: "submission-stale", turnId: "turn-old", text: "continue",
  })).status, 409);
  hub.requestHandler = () => { throw new Error("runner did not respond in time"); };
  const uncertain = await svc.steer(id, {
    submissionId: "submission-uncertain", turnId: "turn-current", text: "continue",
  });
  assert.equal(uncertain.ok, true);
  assert.equal(uncertain.data?.state, "uncertain");
  assert.equal(db.getSession(id)?.steeringAttempts?.[0]?.reason, "transport_uncertain");
  const requestId = (db.raw().prepare(
    "SELECT request_id FROM session_steering_attempts WHERE session_id=? AND submission_id=?",
  ).get(id, "submission-uncertain") as unknown as { request_id: string }).request_id;
  assert.equal(svc.onSteerSessionResult("wrong-runner", {
    type: "steer_session_result", requestId, submissionId: "submission-uncertain", sessionId: id,
    turnId: "turn-current", disposition: "accepted", reason: "accepted",
  }), false);
  assert.equal(svc.onSteerSessionResult(RUNNER_ID, {
    type: "steer_session_result", requestId, submissionId: "submission-uncertain", sessionId: id,
    turnId: "turn-current", disposition: "accepted", reason: "accepted",
  }), true, "a late authoritative runner result reconciles after the HTTP timeout");
  assert.equal(db.getSession(id)?.steeringAttempts?.[0]?.state, "accepted");
});

test("an invalid steering receipt remains pending until timeout and becomes durably recoverable", async () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const sent: ControlPlaneToRunner[] = [];
  const hub = new Hub(db);
  hub.attachRunner(RUNNER_ID, {
    send(data) { sent.push(JSON.parse(data) as ControlPlaneToRunner); },
  });
  const svc = new SessionsService(db, hub, NOOP_LOG, undefined, 30);
  const created = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: CODEX_APP_AGENT_ID,
  });
  assert.ok(created.ok && created.data, created.error);
  const id = created.data!.id;
  db.updateSessionStatus(id, "running", Date.now());
  hub.setSessionQueue(id, [], false, "turn-invalid-receipt");

  const pending = svc.steer(id, {
    submissionId: "submission-invalid-receipt",
    turnId: "turn-invalid-receipt",
    text: "remain recoverable",
  });
  const command = sent.findLast((message) => message.type === "steer_session");
  assert.ok(command && command.type === "steer_session");
  let joinedSettled = false;
  const joined = hub.waitForRunnerRequest(RUNNER_ID, command.requestId).then(
    () => "resolved" as const,
    () => "rejected" as const,
  ).finally(() => { joinedSettled = true; });
  const invalid = {
    type: "steer_session_result",
    requestId: command.requestId,
    submissionId: command.submissionId,
    sessionId: id,
    turnId: command.turnId,
    disposition: "accepted",
    reason: "accepted",
    queuedPromptId: "illegal-for-accepted",
  } as SteerSessionResultMessage;
  assert.equal(svc.onSteerSessionResult(RUNNER_ID, invalid), false);
  await Promise.resolve();
  assert.equal(joinedSettled, false, "an invalid receipt cannot resolve the correlated hub waiter");

  const result = await pending;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data?.state, "uncertain");
  assert.equal(await joined, "rejected", "the request remains pending until the real timeout");
  const durable = db.findSteeringAttemptBySubmission(id, "submission-invalid-receipt")?.attempt;
  assert.equal(durable?.state, "uncertain");
  assert.equal(durable?.reason, "transport_uncertain");
  assert.equal(db.steeringRecoveryAdmissionCount(id), 1);
  db.close();
});

test("a fresh steering submission id is independent from a promoted queue id", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  db.updateSessionStatus(id, "running", Date.now());
  hub.activeTurnIds.set(id, "turn-current");
  hub.requestHandler = (message) => {
    assert.equal(message.type, "steer_session");
    assert.equal(message.submissionId, "submission-promote");
    assert.equal(message.promotePromptId, "queue-existing");
    return {
      type: "steer_session_result", requestId: message.requestId, submissionId: message.submissionId,
      sessionId: id, turnId: "turn-current", disposition: "rejected",
      reason: "configuration_mismatch",
    };
  };
  const result = await svc.steer(id, {
    submissionId: "submission-promote", turnId: "turn-current", promotePromptId: "queue-existing",
  });
  assert.equal(result.data?.sourceQueueId, "queue-existing");
  assert.equal(result.data?.submissionId, "submission-promote");
  assert.equal(result.data?.state, "rejected");
});

test("steering fails closed for policy, workflow, and active pod ownership", async () => {
  const policyHarness = makeHarness();
  const policyId = seedSession(policyHarness.svc, policyHarness.hub, { agentId: CODEX_APP_AGENT_ID });
  policyHarness.db.updateSessionStatus(policyId, "input_required", Date.now());
  policyHarness.db.setPendingApproval(policyId, {
    requestId: "cost-budget", kind: "cost_budget", title: "Over Budget", options: [],
  });
  policyHarness.hub.activeTurnIds.set(policyId, "turn-policy");
  assert.equal((await policyHarness.svc.steer(policyId, {
    submissionId: "submission-policy", turnId: "turn-policy", text: "continue",
  })).status, 409);

  const workflowHarness = makeHarness();
  const workflowId = seedSession(workflowHarness.svc, workflowHarness.hub, { agentId: CODEX_APP_AGENT_ID });
  workflowHarness.db.updateSessionStatus(workflowId, "running", Date.now());
  workflowHarness.hub.activeTurnIds.set(workflowId, "turn-workflow");
  const activeAttempts = workflowHarness.db.activeWorkflowAttemptsForSession.bind(workflowHarness.db);
  Object.defineProperty(workflowHarness.db, "activeWorkflowAttemptsForSession", {
    configurable: true,
    value: (sessionId: string) => sessionId === workflowId ? [{ attemptId: "attempt-steer" }] : activeAttempts(sessionId),
  });
  assert.equal((await workflowHarness.svc.steer(workflowId, {
    submissionId: "submission-workflow", turnId: "turn-workflow", text: "continue",
  })).status, 409);

  const automationHarness = makeHarness();
  const automationId = seedSession(automationHarness.svc, automationHarness.hub, { agentId: CODEX_APP_AGENT_ID });
  automationHarness.db.updateSessionStatus(automationId, "running", Date.now());
  automationHarness.hub.activeTurnIds.set(automationId, "turn-automation");
  Object.defineProperty(automationHarness.db, "hasActiveAutomationCommandForSession", {
    configurable: true,
    value: (sessionId: string) => sessionId === automationId,
  });
  automationHarness.hub.sentToRunner.length = 0;
  assert.equal((await automationHarness.svc.steer(automationId, {
    submissionId: "submission-automation", turnId: "turn-automation", text: "continue",
  })).status, 409);
  assert.equal(automationHarness.hub.sentToRunner.length, 0, "automation ownership rejects before dispatch");
  assert.equal((automationHarness.db.raw().prepare(
    "SELECT COUNT(*) AS count FROM session_steering_attempts WHERE session_id=?",
  ).get(automationId) as unknown as { count: number }).count, 0, "automation ownership rejects before persistence");

  const podHarness = makeHarness();
  const first = seedSession(podHarness.svc, podHarness.hub, {
    agentId: CODEX_APP_AGENT_ID, useWorktree: true, title: "Steering Lead",
  });
  const second = seedSession(podHarness.svc, podHarness.hub, {
    agentId: CODEX_APP_AGENT_ID, useWorktree: true, title: "Steering Builder",
  });
  podHarness.db.setWorktreePath(first, `/worktrees/${first}`);
  podHarness.db.setWorktreePath(second, `/worktrees/${second}`);
  podHarness.db.updateSessionStatus(first, "idle", Date.now());
  podHarness.db.updateSessionStatus(second, "idle", Date.now());
  const pod = podHarness.svc.createPod({ title: "Steering Pod", sessionIds: [first, second] }).data!.pod;
  assert.ok(podHarness.svc.updatePodOrchestration(pod.id, {
    mode: "round_robin", contextTokenBudget: 4096, summaryTokenBudget: 128,
    maxTurns: 2, maxRepeatedOutputs: 2,
  }).ok);
  assert.equal(podHarness.svc.startPodOrchestration(
    pod.id, { instruction: "Start", firstSessionId: first }, "device-1",
  ).status, 201);
  podHarness.hub.activeTurnIds.set(first, "turn-pod");
  assert.equal((await podHarness.svc.steer(first, {
    submissionId: "submission-pod", turnId: "turn-pod", text: "continue",
  })).status, 409);
});

test("steering admission cannot create more recovery obligations than the dashboard projects", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  db.updateSessionStatus(id, "running", Date.now());
  hub.activeTurnIds.set(id, "turn-cap");
  for (let index = 0; index < 50; index++) {
    const requestId = `cap-${index}`;
    db.createSteeringAttempt({
      requestId, sessionId: id, submissionId: requestId, turnId: "turn-cap", source: "direct",
      requestSha256: index.toString(16).padStart(64, "0"), text: `recover ${index}`, now: index,
    });
    db.markSteeringAttemptUncertain(requestId, 100 + index);
  }
  hub.sentToRunner.length = 0;
  const rejected = await svc.steer(id, {
    submissionId: "cap-overflow", turnId: "turn-cap", text: "one too many",
  });
  assert.equal(rejected.status, 409);
  assert.match(rejected.error ?? "", /resolve an uncertain steering attempt/i);
  assert.equal(hub.sentToRunner.length, 0);
  assert.equal(db.findSteeringAttemptBySubmission(id, "cap-overflow"), null);
  assert.equal(db.getSession(id)?.steeringAttempts?.length, 50);
});

test("steering pre-send failure is a definite rejection and consumes no recovery slot", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  db.updateSessionStatus(id, "running", Date.now());
  hub.activeTurnIds.set(id, "turn-not-sent");
  hub.deliver = false;
  const result = await svc.steer(id, {
    submissionId: "submission-not-sent", turnId: "turn-not-sent", text: "do not lose me",
  });
  assert.equal(result.status, 409);
  assert.equal(db.findSteeringAttemptBySubmission(id, "submission-not-sent")?.attempt.state, "rejected");
  assert.equal(db.steeringRecoveryAdmissionCount(id), 0);
});

test("a pending duplicate safely replays its durable steering command after the hub waiter left", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  db.updateSessionStatus(id, "running", Date.now());
  hub.activeTurnIds.set(id, "turn-replay");
  const requestSha256 = createHash("sha256").update(JSON.stringify({
    turnId: "turn-replay", source: "direct", text: "replay safely", images: [], promotePromptId: null,
  })).digest("hex");
  db.createSteeringAttempt({
    requestId: "steer-replay", sessionId: id, submissionId: "submission-replay", turnId: "turn-replay",
    source: "direct", requestSha256, text: "replay safely", now: 1,
  });
  hub.requestHandler = (message) => {
    assert.equal(message.type, "steer_session");
    assert.equal(message.requestId, "steer-replay");
    return {
      type: "steer_session_result", requestId: message.requestId, sessionId: id,
      submissionId: "submission-replay", turnId: "turn-replay", disposition: "accepted", reason: "accepted",
    };
  };
  const replayed = await svc.steer(id, {
    submissionId: "submission-replay", turnId: "turn-replay", text: "replay safely",
  });
  assert.equal(replayed.ok, true, replayed.error);
  assert.equal(replayed.data?.state, "accepted");
  assert.equal(hub.sentOfType("steer_session").length, 1);
});

test("uncertain steering resolution is correlated, idempotent, conflict-safe, and projected", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  db.createSteeringAttempt({
    requestId: "steer-resolve", sessionId: id, submissionId: "submission-resolve", turnId: "turn-resolve",
    source: "direct", requestSha256: "a".repeat(64), text: "recover", now: 1,
  });
  db.markSteeringAttemptUncertain("steer-resolve", 2);
  hub.requestHandler = (message) => {
    assert.equal(message.type, "resolve_steering_attempt");
    return {
      type: "resolve_steering_attempt_result", requestId: message.requestId, sessionId: id,
      submissionId: "submission-resolve", action: "queue_again", applied: true,
      queuedPromptId: "queued-again",
    };
  };
  const resolved = await svc.resolveSteeringAttempt(id, "submission-resolve", "queue_again");
  assert.equal(resolved.ok, true, resolved.error);
  assert.deepEqual(resolved.data?.resolution, {
    action: "queue_again", state: "applied", queuedPromptId: "queued-again",
  });
  assert.equal(db.steeringRecoveryAdmissionCount(id), 0);
  const sent = hub.sentOfType("resolve_steering_attempt");
  assert.equal(sent.length, 1);
  hub.online = false;
  assert.equal((await svc.resolveSteeringAttempt(id, "submission-resolve", "queue_again")).ok, true);
  assert.equal(hub.sentOfType("resolve_steering_attempt").length, 1,
    "applied retries are local and do not require an online runner");
  assert.equal((await svc.resolveSteeringAttempt(id, "submission-resolve", "dismiss")).status, 409);
});

test("a lost steering-resolution reply preserves one action and safely replays its request id", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  db.createSteeringAttempt({
    requestId: "steer-resolve-lost", sessionId: id, submissionId: "submission-resolve-lost",
    turnId: "turn-resolve", source: "direct", requestSha256: "b".repeat(64), text: "recover", now: 1,
  });
  db.markSteeringAttemptUncertain("steer-resolve-lost", 2);
  hub.requestHandler = () => { throw new Error("runner disconnected after send"); };
  const uncertain = await svc.resolveSteeringAttempt(id, "submission-resolve-lost", "dismiss");
  assert.equal(uncertain.status, 202);
  assert.deepEqual(uncertain.data?.resolution, { action: "dismiss", state: "pending" });
  const firstRequestId = hub.sentOfType("resolve_steering_attempt")[0]!.requestId;
  assert.equal((await svc.resolveSteeringAttempt(id, "submission-resolve-lost", "queue_again")).status, 409);
  hub.requestHandler = (message) => ({
    type: "resolve_steering_attempt_result", requestId: message.requestId, sessionId: id,
    submissionId: "submission-resolve-lost", action: "dismiss", applied: true,
  });
  const retried = await svc.resolveSteeringAttempt(id, "submission-resolve-lost", "dismiss");
  assert.equal(retried.ok, true, retried.error);
  assert.equal(hub.sentOfType("resolve_steering_attempt").at(-1)!.requestId, firstRequestId);
  assert.equal(retried.data?.resolution?.state, "applied");
});

test("steering resolution rejection after session deletion returns 404 without throwing", async () => {
  for (const failure of [new RunnerRequestNotSentError(), new Error("runner disconnected after send")]) {
    const { db, hub, svc } = makeHarness();
    const id = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
    const suffix = failure instanceof RunnerRequestNotSentError ? "not-sent" : "disconnect";
    db.createSteeringAttempt({
      requestId: `steer-delete-race-${suffix}`,
      sessionId: id,
      submissionId: `submission-delete-race-${suffix}`,
      turnId: "turn-resolve",
      source: "direct",
      requestSha256: (suffix === "not-sent" ? "1" : "2").repeat(64),
      text: "recover",
      now: 1,
    });
    db.markSteeringAttemptUncertain(`steer-delete-race-${suffix}`, 2);
    hub.requestHandler = () => {
      db.deleteSession(id);
      throw failure;
    };
    const result = await svc.resolveSteeringAttempt(id, `submission-delete-race-${suffix}`, "dismiss");
    assert.equal(result.status, 404);
    assert.match(result.error ?? "", /session not found/i);
    assert.equal(db.findSteeringAttemptBySubmission(id, `submission-delete-race-${suffix}`), null);
  }
});

test("offline steering resolution survives a control-plane restart and runner registry loss", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  db.createSteeringAttempt({
    requestId: "steer-offline-resolve", sessionId: id, submissionId: "submission-offline-resolve",
    turnId: "turn-resolve", source: "direct", requestSha256: "c".repeat(64), text: "recover", now: 1,
  });
  db.markSteeringAttemptUncertain("steer-offline-resolve", 2);
  hub.online = false;
  const staged = await svc.resolveSteeringAttempt(id, "submission-offline-resolve", "dismiss");
  assert.equal(staged.status, 202);
  assert.deepEqual(staged.data?.resolution, { action: "dismiss", state: "pending" });
  const durable = db.pendingSteeringResolutionMessages(RUNNER_ID);
  assert.equal(durable.length, 1);
  assert.equal((await svc.resolveSteeringAttempt(id, "submission-offline-resolve", "queue_again")).status, 409,
    "the opposite action cannot race a permanently offline pending resolution");
  assert.equal(db.steeringRecoveryAdmissionCount(id), 1, "staging alone cannot clear the recovery cap");

  hub.deliver = false;
  assert.equal(svc.recoverPendingSteeringResolutions(RUNNER_ID), 0);
  assert.deepEqual(db.pendingSteeringResolutionMessages(RUNNER_ID), durable,
    "a failed reconnect send preserves the exact durable operation");

  const restarted = new SessionsService(db, hub as unknown as Hub, NOOP_LOG);
  hub.online = true;
  hub.deliver = true;
  assert.equal(restarted.recoverPendingSteeringResolutions(RUNNER_ID), 1);
  const replay = hub.sentOfType("resolve_steering_attempt").at(-1)!;
  assert.deepEqual(replay, durable[0]);
  assert.equal(restarted.onResolveSteeringAttemptResult(RUNNER_ID, {
    type: "resolve_steering_attempt_result",
    requestId: replay.requestId,
    sessionId: id,
    submissionId: "submission-offline-resolve",
    action: "dismiss",
    applied: false,
    reason: "attempt_not_found",
  }), true);
  assert.deepEqual(db.findSteeringAttemptBySubmission(id, "submission-offline-resolve")?.attempt.resolution, {
    action: "dismiss", state: "applied",
  });
  assert.equal(db.steeringRecoveryAdmissionCount(id), 0,
    "a safe local dismiss clears the cap after the runner loses its operation registry");
});

test("a missing queue-again operation fails safely and leaves a later dismiss actionable", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  db.createSteeringAttempt({
    requestId: "steer-missing-queue", sessionId: id, submissionId: "submission-missing-queue",
    turnId: "turn-resolve", source: "direct", requestSha256: "d".repeat(64), text: "recover", now: 1,
  });
  db.markSteeringAttemptUncertain("steer-missing-queue", 2);
  hub.requestHandler = (message) => {
    assert.equal(message.type, "resolve_steering_attempt");
    return {
      type: "resolve_steering_attempt_result",
      requestId: message.requestId,
      sessionId: id,
      submissionId: "submission-missing-queue",
      action: message.action,
      applied: false,
      reason: message.action === "queue_again" ? "attempt_not_found" : "attempt_not_uncertain",
    };
  };
  const queueAgain = await svc.resolveSteeringAttempt(id, "submission-missing-queue", "queue_again");
  assert.equal(queueAgain.status, 409);
  assert.equal(db.findSteeringAttemptBySubmission(id, "submission-missing-queue")?.attempt.resolution, undefined);
  assert.equal(db.steeringRecoveryAdmissionCount(id), 1);

  const dismissed = await svc.resolveSteeringAttempt(id, "submission-missing-queue", "dismiss");
  assert.equal(dismissed.ok, true, dismissed.error);
  assert.deepEqual(dismissed.data?.resolution, { action: "dismiss", state: "applied" });
  assert.equal(db.steeringRecoveryAdmissionCount(id), 0);
  const messages = hub.sentOfType("resolve_steering_attempt");
  assert.deepEqual(messages.map((message) => message.action), ["queue_again", "dismiss"]);
  assert.notEqual(messages[0]!.requestId, messages[1]!.requestId);
});

test("queue overlays remain live when steering snapshot bookkeeping rejects an oversized frame", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  const oversized = Array.from({ length: 101 }, (_, index) => ({
    id: `overflow-${index}`,
    text: `Prompt ${index}`,
  }));
  assert.equal(svc.onSessionQueue(RUNNER_ID, id, oversized, true, "turn-overflow"), true);
  const firstOverlay = hub.calls.findLast((call) => call.method === "setSessionQueue")!;
  assert.deepEqual(firstOverlay.args, [id, oversized, true, "turn-overflow"]);
  assert.equal(db.raw().prepare(
    "SELECT 1 FROM session_steering_queue_snapshots WHERE session_id=?",
  ).get(id), undefined);

  const valid = [{ id: "later-valid", text: "Later Valid" }];
  assert.equal(svc.onSessionQueue(RUNNER_ID, id, valid, false, "turn-valid"), true);
  const laterOverlay = hub.calls.findLast((call) => call.method === "setSessionQueue")!;
  assert.deepEqual(laterOverlay.args, [id, valid, false, "turn-valid"]);
  const snapshot = db.raw().prepare(
    "SELECT revision,prompt_ids_json FROM session_steering_queue_snapshots WHERE session_id=?",
  ).get(id) as unknown as { revision: number; prompt_ids_json: string };
  assert.equal(snapshot.revision, 1);
  assert.deepEqual(JSON.parse(snapshot.prompt_ids_json), ["later-valid"]);
});

test("malformed steering images are rejected before hashing or persistence", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  db.updateSessionStatus(id, "running", Date.now());
  hub.activeTurnIds.set(id, "turn-malformed-image");
  const invalidImages: unknown[] = [
    null,
    [null],
    [{ mimeType: "image/jpeg", data: null }],
    [{ mimeType: "image/jpeg", data: 7 }],
  ];
  for (const [index, images] of invalidImages.entries()) {
    const result = await svc.steer(id, {
      submissionId: `submission-malformed-image-${index}`,
      turnId: "turn-malformed-image",
      text: "inspect",
      images,
    } as unknown as SteerRequest);
    assert.equal(result.status, 400);
    assert.equal(db.findSteeringAttemptBySubmission(id, `submission-malformed-image-${index}`), null);
  }
  assert.equal(hub.sentOfType("steer_session").length, 0);
});

test("direct steering externalizes images before persistence and runner delivery", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID, config: { model: "image-model" } });
  db.updateSessionStatus(id, "running", Date.now());
  hub.activeTurnIds.set(id, "turn-image");
  hub.requestHandler = (message) => {
    assert.equal(message.type, "steer_session");
    assert.ok(message.images?.[0] && "artifactId" in message.images[0]);
    assert.equal(JSON.stringify(message).includes("/9j/2Q=="), false);
    return {
      type: "steer_session_result", requestId: message.requestId, submissionId: message.submissionId,
      sessionId: id, turnId: "turn-image", disposition: "accepted", reason: "accepted",
    };
  };
  const result = await svc.steer(id, {
    submissionId: "submission-image", turnId: "turn-image", text: "Inspect this",
    images: [{ mimeType: "image/jpeg", data: "/9j/2Q==" }],
  });
  assert.equal(result.ok, true);
  const row = db.raw().prepare(
    "SELECT images_json FROM session_steering_attempts WHERE session_id=? AND submission_id=?",
  ).get(id, "submission-image") as unknown as { images_json: string };
  assert.equal(row.images_json.includes("/9j/2Q=="), false);
  assert.match(row.images_json, /artifactId/);
  const ownedReference = (JSON.parse(row.images_json) as Array<{
    artifactId: string; mimeType: string; sizeBytes: number; sha256: string;
  }>)[0]!;
  const ownedArtifactId = ownedReference.artifactId;
  assert.equal(Number((db.raw().prepare(
    "SELECT COUNT(*) AS count FROM session_steering_attempt_artifacts WHERE artifact_id=?",
  ).get(ownedArtifactId) as unknown as { count: number }).count), 1);
  svc.onSessionEvent(id, {
    kind: "user_message", text: "Inspect this", images: [ownedReference], turnId: "turn-image",
    submissionId: "submission-image", deliveryIntent: "steer",
  });
  svc.onSessionEvent(id, {
    kind: "user_message", text: "Reuse the accepted image", images: [ownedReference],
  });
  assert.equal(Number((db.raw().prepare(
    "SELECT COUNT(*) AS count FROM session_event_artifacts WHERE artifact_id=?",
  ).get(ownedArtifactId) as unknown as { count: number }).count), 2,
  "the same prompt image may be referenced by multiple committed live events");
  db.raw().prepare(
    "UPDATE session_steering_attempts SET terminal_at=0 WHERE session_id=? AND submission_id=?",
  ).run(id, "submission-image");
  assert.equal(db.compactSteeringAttempts(30 * 24 * 60 * 60_000), 1);
  assert.ok(db.raw().prepare("SELECT id FROM artifacts WHERE id=?").get(ownedArtifactId),
    "the accepted event owns its image after attempt compaction");
  const firstOwnedEvent = db.raw().prepare(
    "SELECT event_id FROM session_event_artifacts WHERE artifact_id=? ORDER BY event_id LIMIT 1",
  ).get(ownedArtifactId) as unknown as { event_id: number };
  db.raw().prepare("DELETE FROM session_events WHERE id=?").run(firstOwnedEvent.event_id);
  assert.equal(db.collectOrphanedSteeringPromptImages(), 0);
  assert.ok(db.raw().prepare("SELECT id FROM artifacts WHERE id=?").get(ownedArtifactId),
    "provenance GC retains an owned image until its final event reference is removed");

  const reusable = svc.createPromptImageArtifact(
    id, "image/jpeg", Buffer.from("/9j/2Q==", "base64"), { kind: "human", id: "u1" },
  );
  assert.ok(reusable.ok && reusable.data, reusable.error);
  const borrowed = await svc.steer(id, {
    submissionId: "submission-borrowed-image", turnId: "turn-image", text: "Inspect the reusable image",
    images: [reusable.data!],
  });
  assert.equal(borrowed.ok, true, borrowed.error);
  svc.onSessionEvent(id, {
    kind: "user_message", text: "Inspect the reusable image", images: [reusable.data!], turnId: "turn-image",
    submissionId: "submission-borrowed-image", deliveryIntent: "steer",
  });
  db.raw().prepare(
    "UPDATE session_steering_attempts SET terminal_at=0 WHERE session_id=? AND submission_id=?",
  ).run(id, "submission-borrowed-image");
  assert.equal(db.compactSteeringAttempts(30 * 24 * 60 * 60_000), 1);
  assert.ok(db.raw().prepare("SELECT id FROM artifacts WHERE id=?").get(reusable.data!.artifactId),
    "compaction must retain a reusable artifact borrowed by a steering attempt");
  db.raw().prepare("DELETE FROM session_events WHERE session_id=? AND kind='user_message'").run(id);
  assert.equal(db.collectOrphanedSteeringPromptImages(), 1);
  assert.equal(db.raw().prepare("SELECT id FROM artifacts WHERE id=?").get(ownedArtifactId), undefined,
    "maintenance collects the steering-owned image after its accepted event is removed");
  assert.ok(db.raw().prepare("SELECT id FROM artifacts WHERE id=?").get(reusable.data!.artifactId),
    "a borrowed upload is never treated as steering-owned provenance");
});

test("invalid runner image echoes retain live history, advance cursors, and never gain artifact reachability", () => {
  const { db, hub, svc } = makeHarness();
  const owner = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  const unrelated = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  const uploaded = svc.createPromptImageArtifact(
    owner, "image/jpeg", Buffer.from("/9j/2Q==", "base64"), { kind: "human", id: "u1" },
  );
  assert.ok(uploaded.ok && uploaded.data, uploaded.error);
  assert.doesNotThrow(() => svc.onSessionEvent(unrelated, {
    kind: "user_message", text: "cross scope", images: [uploaded.data!],
  }, 1));
  svc.onSessionEvent(unrelated, { kind: "agent_message", text: "after cross scope" }, 2);
  assert.doesNotThrow(() => svc.onSessionEvent(owner, {
    kind: "user_message", text: "tampered", images: [{ ...uploaded.data!, sha256: "0".repeat(64) }],
  }, 1));
  assert.doesNotThrow(() => svc.onSessionEvent(owner, {
    kind: "user_message", text: "malformed", images: [{ mimeType: "image/jpeg", data: "not-base64" }],
  }, 2));
  svc.onSessionEvent(owner, { kind: "agent_message", text: "after invalid images" }, 3);
  assert.equal(db.getHydratedSeq(unrelated), 2);
  assert.equal(db.getHydratedSeq(owner), 3);
  assert.equal(db.listEvents(unrelated).length, 2);
  assert.equal(db.listEvents(owner).length, 3);
  assert.equal(Number((db.raw().prepare(
    "SELECT COUNT(*) AS count FROM session_event_artifacts WHERE artifact_id=?",
  ).get(uploaded.data!.artifactId) as unknown as { count: number }).count), 0);

  const appendEvent = db.appendEvent.bind(db);
  db.appendEvent = () => { throw new Error("unrelated database failure"); };
  try {
    assert.throws(() => svc.onSessionEvent(owner, {
      kind: "user_message", text: "must not be swallowed", images: [uploaded.data!],
    }, 4), /unrelated database failure/);
  } finally {
    db.appendEvent = appendEvent;
  }
  assert.equal(db.getHydratedSeq(owner), 3, "a real persistence failure cannot advance the cursor");
});

test("runner-owned steered user history resolves a lost receipt and suppresses recovery", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  db.createSteeringAttempt({
    requestId: "steer-history", sessionId: id, submissionId: "submission-history",
    turnId: "turn-history", source: "direct", requestSha256: "f".repeat(64), text: "persist me", now: 1,
  });
  db.markSteeringAttemptUncertain("steer-history", 2);
  svc.onSessionEvent(id, {
    kind: "user_message", text: "ordinary replay", submissionId: "submission-history", turnId: "turn-history",
  });
  assert.equal(db.getSession(id)?.steeringAttempts?.[0]?.state, "uncertain",
    "submissionId alone is not steering evidence");
  svc.onSessionEvent(id, {
    kind: "user_message", text: "wrong turn", submissionId: "submission-history",
    turnId: "turn-other", deliveryIntent: "steer",
  });
  assert.equal(db.getSession(id)?.steeringAttempts?.[0]?.state, "uncertain",
    "steering intent from another turn cannot reconcile the attempt");
  svc.onSessionEvent(id, {
    kind: "user_message", text: "persist me", submissionId: "submission-history",
    turnId: "turn-history", deliveryIntent: "steer",
  });
  assert.equal(db.getSession(id)?.steeringAttempts?.[0]?.state, "accepted");
  assert.equal(hub.sessionChangedByIdCalls.includes(id), true);
});

test("prompt fails 404 for an unknown session", () => {
  const { svc } = makeHarness();
  const res = svc.prompt("does-not-exist", "hi");
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
});

test("admission-queued prompts fail closed for a released v77 runner before mutation", () => {
  const { db, hub, svc } = makeHarness();
  db.registerRunner(runnerMeta(), Date.now(), 77);
  const id = seedSession(svc, hub, { prompt: "initial" });
  assert.equal(db.getSession(id)?.status, "queued");
  hub.sentToRunner.length = 0;

  const result = svc.prompt(id, "must wait for a compatible runner");

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error ?? "", /requires protocol v78/);
  assert.equal(hub.sentToRunner.length, 0);
  assert.equal(db.getSession(id)?.queued, undefined);
  assert.equal(db.getSession(id)?.status, "queued");
  const count = db.raw().prepare("SELECT COUNT(*) AS count FROM session_prompt_commands").get() as { count: number };
  assert.equal(count.count, 0);
});

test("admission-queued prompts persist before success, survive service restart, and retain FIFO", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { prompt: "initial" });
  assert.equal(db.getSession(id)?.status, "queued");
  hub.sentToRunner.length = 0;

  assert.equal(svc.prompt(id, "first while queued").ok, true);
  assert.equal(svc.prompt(id, "second while queued").ok, true);

  const firstDelivery = hub.sentOfType("durable_session_command");
  assert.deepEqual(
    firstDelivery.map((message) => message.command.type === "prompt_session" ? message.command.text : ""),
    ["first while queued", "second while queued"],
  );
  assert.deepEqual(
    db.getSession(id)?.queued?.map((prompt) => prompt.text),
    ["first while queued", "second while queued"],
    "durable commands are immediately visible before runner admission",
  );

  const commandIds = firstDelivery.map((message) => message.commandId);
  hub.sentToRunner.length = 0;
  const restarted = new SessionsService(db, hub as unknown as Hub, NOOP_LOG);
  restarted.retryDuePrompts(Date.now() + 60_000);
  const replay = hub.sentOfType("durable_session_command");
  assert.deepEqual(replay.map((message) => message.commandId), commandIds);
  assert.deepEqual(
    replay.map((message) => message.command.type === "prompt_session" ? message.command.text : ""),
    ["first while queued", "second while queued"],
  );

  assert.equal(restarted.onDurablePromptReceipt(RUNNER_ID, {
    type: "durable_session_command_update",
    commandId: commandIds[0]!,
    sessionId: id,
    state: "queued",
    revision: 2,
  }), true);
  assert.deepEqual(
    db.getSession(id)?.queued?.map((prompt) => prompt.text),
    ["first while queued", "second while queued"],
    "runner acceptance does not make the durable queue disappear before turn start",
  );
  assert.equal(db.getSessionPromptCommand(commandIds[0]!)?.state, "queued");
  assert.equal(restarted.onDurablePromptReceipt(RUNNER_ID, {
    type: "durable_session_command_update",
    commandId: commandIds[0]!,
    sessionId: id,
    state: "accepted",
    revision: 1,
  }), true);
  assert.equal(db.getSessionPromptCommand(commandIds[0]!)?.state, "queued", "late retries cannot regress state");

  assert.equal(svc.setArchived(id, true).ok, true);
  assert.equal(db.getSessionPromptCommand(commandIds[1]!)?.state, "sent",
    "archiving is display-only and preserves queued delivery");
  assert.equal(restarted.stop(id).ok, true);
  assert.equal(db.getSessionPromptCommand(commandIds[0]!)?.state, "uncertain");
  assert.equal(db.getSessionPromptCommand(commandIds[1]!)?.state, "uncertain");
  hub.sentToRunner.length = 0;
  restarted.retryDuePrompts(Date.now() + 120_000);
  assert.equal(hub.sentOfType("durable_session_command").length, 0,
    "stopped sessions never replay retained prompts");
});

test("a staged admission prompt fails closed instead of replaying after runner downgrade", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { prompt: "initial" });
  hub.sentToRunner.length = 0;
  hub.deliver = false;

  assert.equal(svc.prompt(id, "do not replay to v77").ok, true);
  const staged = db.getSession(id)?.queued?.[0];
  assert.ok(staged);

  db.registerRunner(runnerMeta(), Date.now(), 77);
  hub.deliver = true;
  hub.sentToRunner.length = 0;
  const restarted = new SessionsService(db, hub as unknown as Hub, NOOP_LOG);
  assert.equal(restarted.retryDuePrompts(Date.now() + 60_000), 0);
  assert.equal(hub.sentOfType("durable_session_command").length, 0);
  assert.equal(db.getSessionPromptCommand(staged.id)?.state, "uncertain");
  assert.match(
    db.getSessionPromptCommand(staged.id)?.error ?? "",
    /no longer supports durable queued prompt identity/,
  );
});

test("pending prompt cancellation is definite before send and wins late admission receipts", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { prompt: "initial" });
  hub.sentToRunner.length = 0;
  const command: DurableSessionCommand = {
    type: "prompt_session", sessionId: id, text: "cancel before delivery",
  };
  const commandId = "prompt-cancel-before-send";
  const now = Date.now();
  db.stageSessionPromptCommand({
    commandId,
    sessionId: id,
    runnerId: RUNNER_ID,
    payloadJson: canonicalAutomationCommandJson(command),
    payloadSha256: automationCommandDigest(command),
    expiresAt: now + 30 * 24 * 60 * 60_000,
    now,
  });

  const before = db.getSession(id)?.pendingPrompts?.[0];
  assert.ok(before);
  assert.equal(before.commandId, commandId);
  assert.equal(before.state, "pending");
  assert.equal(before.canCancel, true);
  assert.equal(before.attemptCount, 0);

  const restarted = new SessionsService(db, hub as unknown as Hub, NOOP_LOG);
  assert.equal(db.getSession(id)?.pendingPrompts?.[0]?.commandId, before.commandId,
    "reload preserves the durable bubble identity");
  assert.equal(restarted.cancelPendingPrompt(id, before.commandId).ok, true);
  const cancelled = db.getSession(id)?.pendingPrompts?.[0];
  assert.equal(cancelled?.commandId, before.commandId);
  assert.equal(cancelled?.state, "failed");
  assert.equal(cancelled?.errorCode, "COMMAND_CANCELLED");
  assert.equal(cancelled?.canDismiss, true);
  assert.equal(cancelled?.canCancel, undefined);
  assert.ok(db.getSessionPromptCommand(commandId)!.expiresAt <= now + 7 * 24 * 60 * 60_000 + 1_000,
    "terminal cancellation shortens the retained row to the seven-day horizon");
  assert.ok(db.getSessionPromptCommand(commandId)!.expiresAt >= now + 7 * 24 * 60 * 60_000,
    "terminal cancellation retains its outcome for the full seven-day horizon");

  assert.equal(restarted.retryDuePrompts(Date.now() + 60_000), 0,
    "a definitely cancelled prompt never enters the send lane");
  assert.equal(restarted.onDurablePromptReceipt(RUNNER_ID, {
    type: "durable_session_command_update",
    commandId: before.commandId,
    sessionId: id,
    state: "queued",
    revision: 10,
  }), true);
  assert.equal(db.getSessionPromptCommand(before.commandId)?.state, "failed",
    "a late runner receipt cannot resurrect a terminal local cancellation");

  assert.equal(restarted.dismissPendingPrompt(id, before.commandId).ok, true);
  assert.equal(db.getSession(id)?.pendingPrompts, undefined);
  assert.equal(db.getSessionPromptCommand(before.commandId)?.payloadJson, "null",
    "dismissal scrubs retained prompt content without deleting the outcome tombstone");
});

test("pending prompt cancel loses safely once the send boundary is crossed", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { prompt: "initial" });
  hub.sentToRunner.length = 0;
  const command: DurableSessionCommand = {
    type: "prompt_session", sessionId: id, text: "race admission",
  };
  const commandId = "prompt-send-wins-cancel";
  const now = Date.now();
  db.stageSessionPromptCommand({
    commandId,
    sessionId: id,
    runnerId: RUNNER_ID,
    payloadJson: canonicalAutomationCommandJson(command),
    payloadSha256: automationCommandDigest(command),
    expiresAt: now + 60_000,
    now,
  });

  assert.equal(svc.retryDuePrompts(Date.now() + 1), 1);
  const sent = db.getSession(id)?.pendingPrompts?.[0];
  assert.equal(sent?.commandId, commandId);
  assert.equal(sent?.state, "sent");
  assert.equal(sent?.attemptCount, 1);
  const cancelled = svc.cancelPendingPrompt(id, commandId);
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) assert.equal(cancelled.status, 409);
  assert.equal(db.getSessionPromptCommand(commandId)?.state, "sent");

  assert.equal(svc.onDurablePromptReceipt(RUNNER_ID, {
    type: "durable_session_command_update",
    commandId,
    sessionId: id,
    state: "queued",
    revision: 2,
  }), true);
  assert.equal(db.getSession(id)?.pendingPrompts?.[0]?.state, "queued");
  assert.equal(svc.cancelPendingPrompt(id, commandId).ok, false,
    "control-plane cancellation remains unavailable after durable runner admission");

  assert.equal(svc.onDurablePromptReceipt(RUNNER_ID, {
    type: "durable_session_command_update",
    commandId,
    sessionId: id,
    state: "failed",
    revision: 3,
    error: "queued command was cancelled",
    code: "COMMAND_CANCELLED",
  }), true);
  assert.equal(db.getSession(id)?.pendingPrompts?.[0]?.state, "failed");
  assert.equal(db.getSession(id)?.pendingPrompts?.[0]?.error, "queued command was cancelled");
});

test("durable queued prompts accept revision-zero failures and stop retrying after terminal status", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { prompt: "initial" });
  hub.sentToRunner.length = 0;

  assert.equal(svc.prompt(id, "journal capacity prompt").ok, true);
  const rejected = hub.sentOfType("durable_session_command")[0]!;
  assert.equal(svc.onDurablePromptReceipt(RUNNER_ID, {
    type: "durable_session_command_result",
    requestId: rejected.requestId,
    commandId: rejected.commandId,
    sessionId: id,
    state: "failed",
    revision: 0,
    duplicate: false,
    error: "durable command receipt store is full",
    code: "RECEIPT_STORE_FULL",
  }), true);
  assert.equal(db.getSessionPromptCommand(rejected.commandId)?.state, "failed");
  assert.ok(db.getSessionPromptCommand(rejected.commandId)!.expiresAt <=
    Date.now() + 7 * 24 * 60 * 60_000 + 1_000,
    "runner-authoritative terminal receipts shorten retention to seven days");
  assert.equal(db.dueSessionPromptCommands(Date.now() + 60_000, RUNNER_ID).length, 0);

  hub.sentToRunner.length = 0;
  assert.equal(svc.prompt(id, "prompt before launch failure").ok, true);
  const stranded = hub.sentOfType("durable_session_command")[0]!;
  svc.onSessionStatus(id, "failed", "provider launch failed", RUNNER_ID);
  assert.equal(db.getSessionPromptCommand(stranded.commandId)?.state, "uncertain");
  assert.ok(db.getSessionPromptCommand(stranded.commandId)!.expiresAt <=
    Date.now() + 7 * 24 * 60 * 60_000 + 1_000,
    "session terminality shortens conservative outcomes to seven days");
  assert.equal(db.dueSessionPromptCommands(Date.now() + 60_000, RUNNER_ID).length, 0,
    "terminal sessions fence every durable retry path");

  const uncertainRecord = db.getSessionPromptCommand(stranded.commandId)!;
  const uncertainRevision = uncertainRecord.revision;
  assert.equal(svc.onDurablePromptReceipt(RUNNER_ID, {
    type: "durable_session_command_update",
    commandId: stranded.commandId,
    sessionId: id,
    state: "completed",
    revision: uncertainRevision + 1,
  }), true);
  assert.equal(db.getSessionPromptCommand(stranded.commandId)?.state, "completed",
    "a later authoritative terminal receipt narrows conservative status uncertainty");
  assert.ok(db.getSessionPromptCommand(stranded.commandId)!.expiresAt <=
    uncertainRecord.expiresAt,
    "authoritative refinement does not extend terminal retention");

  db.raw().prepare("UPDATE session_prompt_commands SET expires_at=? WHERE command_id IN (?,?)")
    .run(Date.now() - 1, rejected.commandId, stranded.commandId);
  svc.maintainPrompts();
  assert.equal(db.getSessionPromptCommand(rejected.commandId), null);
  assert.equal(db.getSessionPromptCommand(stranded.commandId), null);
});

test("durable prompt retry attempt identities stay bounded while recent receipts remain valid", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { prompt: "initial" });
  hub.sentToRunner.length = 0;
  const command: DurableSessionCommand = {
    type: "prompt_session", sessionId: id, text: "bounded retry journal",
  };
  const commandId = "prompt-bounded-attempts";
  const now = Date.now();
  db.stageSessionPromptCommand({
    commandId,
    sessionId: id,
    runnerId: RUNNER_ID,
    payloadJson: canonicalAutomationCommandJson(command),
    payloadSha256: automationCommandDigest(command),
    expiresAt: now + 60_000,
    now,
  });

  for (let attempt = 0; attempt < 160; attempt++) {
    assert.ok(db.markSessionPromptCommandSent(
      commandId,
      `bounded-attempt-${attempt}`,
      now + attempt,
      now + attempt + 30_000,
    ));
  }
  const count = db.raw().prepare(
    "SELECT COUNT(*) AS count FROM session_prompt_command_attempts WHERE command_id=?",
  ).get(commandId) as { count: number };
  assert.equal(count.count, 128);
  const attemptIndexes = db.raw().prepare(
    "PRAGMA index_list('session_prompt_command_attempts')",
  ).all() as Array<{ name: string }>;
  assert.ok(attemptIndexes.some((index) => index.name === "idx_session_prompt_command_attempts_command"),
    "bounded per-command trimming has a command-scoped index");
  assert.equal(svc.onDurablePromptReceipt(RUNNER_ID, {
    type: "durable_session_command_result",
    requestId: "bounded-attempt-159",
    commandId,
    sessionId: id,
    state: "accepted",
    revision: 1,
    duplicate: true,
  }), true, "the newest retained request identity still authenticates its receipt");
  assert.equal(db.getSessionPromptCommand(commandId)?.state, "accepted");
});

test("completed durable prompts compact their retained content", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { prompt: "initial" });
  hub.sentToRunner.length = 0;
  assert.equal(svc.prompt(id, "content that should be compacted").ok, true);
  const sent = hub.sentOfType("durable_session_command")[0]!;

  assert.equal(svc.onDurablePromptReceipt(RUNNER_ID, {
    type: "durable_session_command_update",
    commandId: sent.commandId,
    sessionId: id,
    state: "completed",
    revision: 3,
  }), true);
  const raw = db.raw().prepare("SELECT payload_json FROM session_prompt_commands WHERE command_id=?")
    .get(sent.commandId) as { payload_json: string };
  assert.equal(raw.payload_json, "null");
  assert.equal(db.getSession(id)?.queued, undefined);
});

test("receipt-horizon uncertainty remains visible for a bounded terminal window", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { prompt: "initial" });
  hub.sentToRunner.length = 0;
  assert.equal(svc.prompt(id, "prompt with a lost receipt").ok, true);
  const sent = hub.sentOfType("durable_session_command")[0]!;
  const horizon = Date.now();
  db.raw().prepare("UPDATE session_prompt_commands SET expires_at=? WHERE command_id=?")
    .run(horizon, sent.commandId);

  svc.maintainPrompts(horizon);
  const retained = db.getSessionPromptCommand(sent.commandId)!;
  assert.equal(retained.state, "uncertain");
  assert.ok(retained.expiresAt > horizon);
  assert.equal(db.getSession(id)?.queued?.[0]?.durableDeliveryState, "uncertain");

  svc.maintainPrompts(retained.expiresAt);
  assert.equal(db.getSessionPromptCommand(sent.commandId), null);
});

test("prompt stages its exact merged config before mutations and skips the legacy hub send", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { config: { permissionMode: "plan" } });
  hub.sentToRunner.length = 0;
  let staged: PreStagedDeliveryPlan | undefined;
  const beforeStatus = db.getSession(id)!.status;
  const result = svc.prompt(id, "durable turn", [], "review", {
    model: "opus", costBudgetUsd: 8, maxToolCalls: 4.9,
  }, {
    stage(plan) {
      staged = plan;
      assert.equal(db.getSession(id)!.status, beforeStatus);
      assert.equal(db.getSession(id)!.model, null);
    },
    activate(plan) {
      assert.strictEqual(plan, staged);
      assert.equal(db.getSession(id)!.status, "running");
      assert.equal(db.getSession(id)!.model, "opus");
    },
  });
  assert.equal(result.ok, true);
  const command = staged!.commands[0]!;
  assert.equal(command.type, "prompt_session");
  assert.equal(command.sessionId, id);
  assert.equal(command.text, "durable turn");
  assert.equal(command.slashCommand, "review");
  assert.deepEqual(command.config, {
    model: "opus", effort: undefined, permissionMode: "plan", costBudgetUsd: 8, maxToolCalls: 4,
  });
  assert.equal(hub.sentOfType("prompt_session").length, 0);
  db.close();
});

test("prompt recovery validates and persists the exact staged snapshot after session drift", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { config: { permissionMode: "plan" } });
  db.updateSessionStatus(id, "idle", 1);
  let staged: PreStagedDeliveryPlan | undefined;
  assert.throws(() => svc.prompt(id, "durable turn", [], "review", {
    model: "opus", costBudgetUsd: 8, maxToolCalls: 4.9,
  }, {
    stage(plan) { staged = plan; throw new Error("simulated crash after staging"); },
    activate() { assert.fail("must not activate before materialization"); },
  }), /simulated crash/);

  db.updateSessionConfig(id, { model: "drifted", effort: "low", permissionMode: "acceptEdits" }, 2);
  db.updateSessionCostBudget(id, 99, 2);
  db.updateSessionMaxToolCalls(id, 99, 2);
  let recoveryPlan: PreStagedDeliveryPlan | undefined;
  const recovered = svc.prompt(id, "different mutable call", [], undefined, { model: "drifted" }, {
    commandSnapshots: staged!.commands,
    stage(plan) { recoveryPlan = plan; },
    activate() {},
  });
  assert.equal(recovered.ok, true, recovered.error);
  assert.deepEqual(recoveryPlan!.commands, staged!.commands);
  const session = db.getSession(id)!;
  assert.equal(session.model, "opus");
  assert.equal(session.permissionMode, "plan");
  assert.equal(session.costBudgetUsd, 8);
  assert.equal(session.maxToolCalls, 4);
  db.close();
});

test("prompt rejects malformed image input without changing status or sending", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  hub.sentToRunner.length = 0;
  const before = db.getSession(id)!.status;
  const res = svc.prompt(id, "look", [{ mimeType: "image/png", data: "bad" }]);
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.match(res.error!, /valid base64/);
  assert.equal(db.getSession(id)!.status, before);
  assert.equal(hub.sentToRunner.length, 0);
});

test("raw prompt image artifacts produce metadata-only commands and reject cross-session reuse", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  const other = seedSession(svc, hub);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const uploaded = svc.createPromptImageArtifact(id, "image/png", png, { kind: "human", id: "u1" });
  assert.ok(uploaded.ok && uploaded.data, uploaded.error);
  const row = db.raw().prepare("SELECT data, blob_key FROM artifacts WHERE id=?").get(uploaded.data!.artifactId) as unknown as
    { data: string; blob_key: string };
  assert.equal(row.data, "");
  assert.equal(row.blob_key, uploaded.data!.sha256);

  hub.sentToRunner.length = 0;
  const prompted = svc.prompt(id, "inspect", [uploaded.data!]);
  assert.equal(prompted.ok, true, prompted.error);
  const sent = sentPromptCommands(hub).find((command) => command.sessionId === id);
  assert.ok(sent?.type === "prompt_session");
  assert.deepEqual(sent.images, [uploaded.data!]);
  assert.equal(JSON.stringify(sent).includes("data"), false);

  const crossSession = svc.prompt(other, "steal", [uploaded.data!]);
  assert.equal(crossSession.status, 404);
  assert.match(crossSession.error ?? "", /artifact not found/);
  db.recordSessionFork(other, id, 1, Date.now());
  const inherited = svc.prompt(other, "edit inherited image", [uploaded.data!]);
  assert.equal(inherited.ok, true, inherited.error);
  assert.deepEqual(sentPromptCommands(hub).at(-1)?.images, [uploaded.data!]);
  const descendant = seedSession(svc, hub);
  db.recordSessionFork(descendant, other, 1, Date.now());
  const transitive = svc.prompt(descendant, "edit image from an earlier fork", [uploaded.data!]);
  assert.equal(transitive.ok, true, transitive.error);
  const tampered = svc.prompt(id, "tamper", [{ ...uploaded.data!, sha256: "b".repeat(64) }]);
  assert.equal(tampered.status, 404);
});

test("legacy inline prompt images externalize atomically and clean partial conversion failures", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  hub.sentToRunner.length = 0;
  const success = svc.prompt(id, "legacy", [{ mimeType: "image/jpeg", data: "/9j/2Q==" }]);
  assert.equal(success.ok, true, success.error);
  const sent = sentPromptCommands(hub).at(-1);
  assert.ok(sent?.type === "prompt_session" && sent.images?.[0] && "artifactId" in sent.images[0]);
  assert.equal(JSON.stringify(sent).includes("/9j/2Q=="), false);
  const before = Number((db.raw().prepare("SELECT COUNT(*) AS count FROM artifacts").get() as unknown as { count: number }).count);

  db.updateSessionStatus(id, "idle", Date.now());
  const partial = svc.prompt(id, "bad second", [
    { mimeType: "image/jpeg", data: "/9j/2Q==" },
    { mimeType: "image/png", data: "eA==" },
  ]);
  assert.equal(partial.status, 400);
  assert.match(partial.error ?? "", /bytes do not match/);
  const after = Number((db.raw().prepare("SELECT COUNT(*) AS count FROM artifacts").get() as unknown as { count: number }).count);
  assert.equal(after, before, "the first artifact from a failed conversion must be removed");
});

test("prompt rejects an image when its atomic model change selects a text-only model", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID, config: { model: "image-model" } });
  hub.sentToRunner.length = 0;
  const statusBefore = db.getSession(id)!.status;
  const res = svc.prompt(
    id,
    "look",
    [{ mimeType: "image/png", data: "iVBORw==" }],
    undefined,
    { model: "text-model" },
  );
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.match(res.error!, /text-model.*does not support image input/);
  assert.equal(db.getSession(id)!.model, "image-model", "rejection is atomic and does not persist the model change");
  assert.equal(db.getSession(id)!.status, statusBefore);
  assert.equal(hub.sentToRunner.length, 0);
});

test("prompt fails 409 once the session is terminal", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "completed", Date.now());

  const before = hub.sentToRunner.length;
  const res = svc.prompt(id, "again");

  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.match(res.error ?? "", /completed/);
  // Guard fired before any runner traffic.
  assert.equal(hub.sentToRunner.length, before);
});

test("prompt fails 409 when the runner is offline", () => {
  const { hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  hub.online = false;

  const before = hub.sentToRunner.length;
  const res = svc.prompt(id, "hi");

  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.match(res.error ?? "", /offline/);
  assert.equal(hub.sentToRunner.length, before);
});

test("prompt sends prompt_session carrying the session's stored config", () => {
  const { hub, svc } = makeHarness();
  const id = seedSession(svc, hub, {
    config: { model: "sonnet", effort: "low", permissionMode: "default", costBudgetUsd: 5, maxToolCalls: 3 },
  });

  const res = svc.prompt(id, "go", [], "review");
  assert.ok(res.ok);
  assert.equal(res.status, 200);

  const prompts = sentPromptCommands(hub);
  assert.equal(prompts.length, 1);
  const msg = prompts[0];
  assert.equal(msg.sessionId, id);
  assert.equal(msg.text, "go");
  assert.equal(msg.slashCommand, "review");
  // Config echoed from the persisted session row.
  assert.deepEqual(msg.config, {
    model: "sonnet", effort: "low", permissionMode: "default", costBudgetUsd: 5, maxToolCalls: 3,
  });

  // The user_message is now emitted by the runner (box) into its store + stream, not by the control
  // plane; prompt just marks the session running and broadcasts the change.
  assert.ok(hub.sessionChangedByIdCalls.includes(id));
});

test("prompt status moves the session to running", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "idle", Date.now());

  svc.prompt(id, "go");
  assert.equal(db.getSession(id)!.status, "running");
});

test("prompt with a config arg merges + persists it BEFORE sending (atomic change+send)", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { config: { model: "sonnet", effort: "low" } });

  // Only override the model; effort should be preserved from the stored config.
  const res = svc.prompt(id, "go", [], undefined, { model: "opus", costBudgetUsd: 8, maxToolCalls: 4.9 });
  assert.ok(res.ok);

  // Persisted before send: the stored row reflects the merge.
  const stored = db.getSession(id)!;
  assert.equal(stored.model, "opus");
  assert.equal(stored.effort, "low");
  assert.equal(stored.costBudgetUsd, 8);
  assert.equal(stored.maxToolCalls, 4);

  // And the prompt_session sent to the runner carries the merged config.
  const msg = sentPromptCommands(hub).at(-1)!;
  assert.equal(msg.config!.model, "opus");
  assert.equal(msg.config!.effort, "low");
  assert.equal(msg.config!.costBudgetUsd, 8);
  assert.equal(msg.config!.maxToolCalls, 4);
});

test("prompt heals persisted Claude knobs without rewriting a compatible model alias", () => {
  const { db, hub, svc } = makeHarness();
  // Pre-v30 creation accepted this catalog value. A later CLI update narrows effort/modes.
  const id = seedSession(svc, hub, { config: { model: "opus", effort: "max", permissionMode: "auto" } });
  db.updateRunnerAgents(
    RUNNER_ID,
    runnerMeta().agents.map((agent) => agent.id === AGENT_ID ? {
      ...agent,
      capabilities: {
        models: [
          { id: "default", default: true },
          { id: "opus[1m]", displayName: "Opus 5 (1M Context)" },
        ],
        effortLevels: ["low"], slashCommands: [], supportsImages: true,
        supportsApprovals: true, permissionModes: ["default", "acceptEdits"],
      },
    } : agent),
    Date.now(),
  );
  hub.sentToRunner.length = 0;

  const res = svc.prompt(id, "continue");
  assert.equal(res.ok, true);
  assert.equal(db.getSession(id)!.model, "opus");
  assert.equal(db.getSession(id)!.effort, null);
  assert.equal(db.getSession(id)!.permissionMode, null);
  assert.deepEqual(sentPromptCommands(hub)[0]!.config, { model: "opus" });
});

test("explicit unsupported Claude effort and permission values still fail capability validation", () => {
  const { db, hub, svc } = makeHarness();
  db.updateRunnerAgents(
    RUNNER_ID,
    runnerMeta().agents.map((agent) => agent.id === AGENT_ID ? {
      ...agent,
      capabilities: {
        models: [{ id: "default", default: true }, { id: "opus[1m]" }],
        effortLevels: ["low"],
        slashCommands: [],
        supportsImages: true,
        supportsApprovals: true,
        permissionModes: ["acceptEdits"],
      },
    } : agent),
    Date.now(),
  );

  const create = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    config: { effort: "max" },
  });
  assert.equal(create.status, 409);
  const invalidModel = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    config: { model: "claude-opus-3" },
  });
  assert.equal(invalidModel.status, 409);

  const id = seedSession(svc, hub, { config: { effort: "low", permissionMode: "acceptEdits" } });
  db.updateSessionStatus(id, "idle", Date.now());
  assert.equal(svc.prompt(id, "go", [], undefined, { effort: "max" }).status, 409);
  assert.equal(svc.setConfig(id, { permissionMode: "plan" }).status, 409);
  assert.equal(db.getSession(id)?.effort, "low");
  assert.equal(db.getSession(id)?.permissionMode, "acceptEdits");
});

test("fallback family compatibility never rewrites a persisted live Claude model id", () => {
  const { db, hub, svc } = makeHarness();
  db.updateRunnerAgents(
    RUNNER_ID,
    runnerMeta().agents.map((agent) => agent.id === AGENT_ID ? {
      ...agent,
      capabilities: {
        models: [{ id: "default", default: true }, { id: "opus" }],
        effortLevels: ["low"],
        slashCommands: [],
        supportsImages: true,
        supportsApprovals: true,
        permissionModes: ["acceptEdits"],
      },
    } : agent),
    Date.now(),
  );
  const id = seedSession(svc, hub, { config: { model: "opus[1m]" } });
  db.updateSessionStatus(id, "idle", Date.now());
  hub.sentToRunner.length = 0;

  const result = svc.prompt(id, "continue");
  assert.equal(result.ok, true, result.error);
  assert.equal(db.getSession(id)?.model, "opus[1m]");
  assert.equal(hub.sentOfType("prompt_session")[0]?.config?.model, "opus[1m]");
});

test("prompt is rejected while a cost-budget approval is pending (no bypass)", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.setPendingApproval(id, { requestId: "cb1", kind: "cost_budget", title: "over budget", options: [] });
  db.updateSessionStatus(id, "input_required", Date.now());

  const before = hub.sentToRunner.length;
  const res = svc.prompt(id, "keep going anyway");
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.match(res.error ?? "", /cost budget/i);
  assert.equal(hub.sentToRunner.length, before, "no prompt forwarded to the runner");
  assert.ok(db.getSession(id)!.pendingApproval, "the budget pause is left intact");
});

test("ad-hoc workspace: spec carries null workspaceId + the ad-hoc path, and restart re-launches from it", () => {
  const { db, hub, svc } = makeHarness();
  const res = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    workspacePath: "/repos/adhoc",
  });
  assert.ok(res.ok);
  const id = res.data!.id;

  // Stored as workspace-less with the ad-hoc path (not the stale configured workspace id).
  assert.equal(db.getSession(id)!.workspaceId, null);
  assert.equal(db.getAdHocWorkspacePath(id), "/repos/adhoc");
  const start = hub.sentOfType("start_session").at(-1)!;
  assert.equal(start.spec.workspaceId, null); // must NOT send the stale configured id to the runner
  assert.equal(start.spec.workspacePath, "/repos/adhoc");

  // Restart re-launches from the ad-hoc path rather than rejecting the null-workspace session.
  const r = svc.restart(id);
  assert.ok(r.ok);
  const restarted = hub.sentOfType("start_session").at(-1)!;
  assert.equal(restarted.spec.workspacePath, "/repos/adhoc");
  assert.equal(restarted.spec.workspaceId, null);
});

test("cold-hydrating an ad-hoc session (workspaceId null) carries the runner's path so restart works", () => {
  const { db, hub, svc } = makeHarness();
  // The box is the source of truth: a fresh control plane hydrates the session from its snapshot,
  // which now carries the runner's launch directory even though there's no configured workspace.
  svc.hydrateRunnerSessions(RUNNER_ID, [
    snapshot({ id: "s_adhoc", workspaceId: null, workspacePath: "/repos/adhoc", agentId: AGENT_ID }),
  ]);
  assert.equal(db.getSession("s_adhoc")!.workspaceId, null);
  assert.equal(db.getAdHocWorkspacePath("s_adhoc"), "/repos/adhoc");

  const r = svc.restart("s_adhoc");
  assert.ok(r.ok, r.error);
  assert.equal(hub.sentOfType("start_session").at(-1)!.spec.workspacePath, "/repos/adhoc");
});

/* -------------------------------------------------------------------------- */
/* Untitled sessions are named by their first message (Codex-style)          */
/* -------------------------------------------------------------------------- */

test("a session created without a prompt is Untitled", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub); // no prompt
  assert.equal(db.getSession(id)!.title, "Untitled session");
  assert.equal(db.getSession(id)!.titleSource, "generated");
});

test("an explicit session title is user-owned and reaches the runner", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { title: "My named session" });
  assert.equal(db.getSession(id)!.titleSource, "user");
  const start = hub.sentOfType("start_session").at(-1)!;
  assert.equal(start.spec.title, "My named session");
  assert.equal(start.spec.titleSource, "user");
});

test("setTitle persists a normalized user override and broadcasts while the runner is offline", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { title: "Original" });
  hub.online = false;
  hub.sessionChangedCalls.length = 0;

  const result = svc.setTitle(id, "  Renamed\n   session  ");

  assert.ok(result.ok, result.error);
  assert.equal(result.data?.title, "Renamed session");
  assert.equal(result.data?.titleSource, "user");
  assert.equal(db.getSession(id)?.title, "Renamed session");
  assert.equal(hub.sessionChangedCalls.length, 1);
  assert.equal(hub.sessionChangedCalls[0]?.title, "Renamed session");
  assert.equal(hub.sentOfType("start_session").length, 1, "rename does not require a runner command");
});

test("setTitle rejects malformed titles without mutating or broadcasting", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { title: "Original" });
  hub.sessionChangedCalls.length = 0;

  for (const value of [undefined, "   ", "x".repeat(121)]) {
    const result = svc.setTitle(id, value);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(db.getSession(id)?.title, "Original");
  }
  assert.equal(hub.sessionChangedCalls.length, 0);
  assert.equal(svc.setTitle("missing", "Name").status, 404);
});

test("an explicit rename to the placeholder is not replaced by a later user message", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  assert.ok(svc.setTitle(id, "Untitled session").ok);

  svc.onSessionEvent(id, { kind: "user_message", text: "Do not take ownership" });

  assert.equal(db.getSession(id)?.title, "Untitled session");
  assert.equal(db.getSession(id)?.titleSource, "user");
});

test("onSessionEvent names an Untitled session from its first user message", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);

  svc.onSessionEvent(id, { kind: "user_message", text: "Fix the parser bug\nplus more detail" });
  assert.equal(db.getSession(id)!.title, "Fix the parser bug"); // first non-empty line only

  // A later message must not rename it.
  svc.onSessionEvent(id, { kind: "user_message", text: "and now do the next thing" });
  assert.equal(db.getSession(id)!.title, "Fix the parser bug");
});

test("onSessionEvent does not title an Untitled session from a provider command", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);

  svc.onSessionEvent(id, {
    kind: "user_message",
    text: "/review focus on storage",
    commandInvocation: {
      invocationId: "ci-1",
      submissionId: "submission-1",
      providerCommandId: "command-1",
      catalogRevision: "catalog-1",
      commandName: "review",
      executionMode: "passthrough",
    },
  });
  assert.equal(db.getSession(id)?.title, "Untitled session");
  assert.equal(db.getSession(id)?.titleSource, "generated");
});

test("onSessionEvent does not rename a session that already has a title", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { prompt: "original prompt" });
  assert.equal(db.getSession(id)!.title, "original prompt");

  svc.onSessionEvent(id, { kind: "user_message", text: "different text" });
  assert.equal(db.getSession(id)!.title, "original prompt");
});

test("onSessionEvent ignores a streamed (non-final) user_message chunk for the title", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);

  svc.onSessionEvent(id, { kind: "user_message", text: "partial", final: false });
  assert.equal(db.getSession(id)!.title, "Untitled session");

  svc.onSessionEvent(id, { kind: "user_message", text: "the whole message", final: true });
  assert.equal(db.getSession(id)!.title, "the whole message");
});

test("onSessionEvent truncates a long first message into a title", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);

  svc.onSessionEvent(id, { kind: "user_message", text: "x".repeat(200) });
  const title = db.getSession(id)!.title;
  assert.ok(title.length <= 80, `title should be truncated, got length ${title.length}`);
  assert.ok(title.endsWith("…"));
});

/* -------------------------------------------------------------------------- */
/* setConfig                                                                 */
/* -------------------------------------------------------------------------- */

test("setConfig merges the patch over the stored config and broadcasts", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, {
    config: { model: "sonnet", effort: "low", permissionMode: "default" },
  });

  const res = svc.setConfig(id, { model: "opus" });
  assert.ok(res.ok);
  assert.equal(res.status, 200);

  const stored = db.getSession(id)!;
  assert.equal(stored.model, "opus"); // overridden
  assert.equal(stored.effort, "low"); // preserved
  assert.equal(stored.permissionMode, "default"); // preserved

  // setConfig broadcasts via sessionChanged (full view), not sessionChangedById.
  assert.equal(hub.sessionChangedCalls.at(-1)!.id, id);
  // No runner traffic — config is applied to the next turn, not pushed now.
  assert.equal(hub.sentOfType("prompt_session").length, 0);
});

test("setConfig fails 404 for an unknown session", () => {
  const { svc } = makeHarness();
  const res = svc.setConfig("nope", { model: "opus" });
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
});

test("native setConfig uses the live runner catalog over a hydrated frozen capability copy", () => {
  const { db, svc } = makeHarness();
  const liveCapabilities = {
    models: [{ id: "opus-next" }],
    effortLevels: ["high"],
    slashCommands: [],
    supportsImages: true,
    supportsApprovals: true,
    permissionModes: ["default", "acceptEdits"],
    elicitation: { acceptEdits: ["hook" as const] },
  };
  db.registerRunner({
    ...runnerMeta(),
    agents: runnerMeta().agents.map((agent) =>
      agent.id === AGENT_ID ? { ...agent, capabilities: liveCapabilities } : agent),
  }, Date.now(), PROTOCOL_VERSION);
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({
    id: "native-catalog-session",
    agentCapabilities: {
      ...liveCapabilities,
      models: [{ id: "old-opus" }],
      elicitation: { acceptEdits: ["hook"] },
    },
  })]);

  const result = svc.setConfig("native-catalog-session", { model: "opus-next" });
  assert.equal(result.ok, true, result.error);
  assert.equal(db.getSession("native-catalog-session")!.model, "opus-next");
});

test("setConfig persists a cost budget without clobbering model/effort, and clears on 0", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { config: { model: "opus", effort: "high" } });
  svc.setConfig(id, { costBudgetUsd: 5 });
  let s = db.getSession(id)!;
  assert.equal(s.costBudgetUsd, 5);
  assert.equal(s.costBudgetStepUsd, 5);
  assert.equal(s.model, "opus"); // untouched
  assert.equal(s.effort, "high");
  // A later config write that omits the budget must NOT clear it (separate column).
  svc.setConfig(id, { model: "sonnet" });
  s = db.getSession(id)!;
  assert.equal(s.costBudgetUsd, 5);
  assert.equal(s.model, "sonnet");
  // 0 clears it (unlimited).
  svc.setConfig(id, { costBudgetUsd: 0 });
  assert.equal(db.getSession(id)!.costBudgetUsd, null);
  assert.equal(db.getSession(id)!.costBudgetStepUsd, null);
});

/* -------------------------------------------------------------------------- */
/* Conductor permissionMode clamp (three seams)                                */
/* -------------------------------------------------------------------------- */

test("createSession for the conductor with no config forces permissionMode 'default' (persisted + spec)", () => {
  const { db, hub, svc } = makeHarness();

  // The New Session dialog sends NO config — without the clamp the driver would fall back to
  // "acceptEdits" and every mcp__manager__ mutation would run ungated.
  const res = svc.createSession({ runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: CONDUCTOR_ID });
  assert.ok(res.ok);
  const id = res.data!.id;

  assert.equal(db.getSession(id)!.permissionMode, "default");
  const start = hub.sentOfType("start_session").at(-1)!;
  assert.equal(start.spec.config!.permissionMode, "default");
});

test("createSession for the conductor rejects any explicit non-default permissionMode with 409", () => {
  const { db, hub, svc } = makeHarness();
  for (const permissionMode of ["acceptEdits", "auto", "plan", "bypassPermissions"]) {
    const before = hub.sentToRunner.length;
    const res = svc.createSession({
      runnerId: RUNNER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: CONDUCTOR_ID,
      config: { permissionMode },
    });
    assert.equal(res.ok, false, permissionMode);
    assert.equal(res.status, 409, permissionMode);
    assert.match(res.error ?? "", /conductor/, permissionMode);
    assert.equal(hub.sentToRunner.length, before, "nothing routed to the runner");
  }
  assert.equal(db.listSessions().length, 0, "no session persisted on rejection");

  // An explicit "default" is fine (it IS the clamp value).
  const ok = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: CONDUCTOR_ID,
    config: { permissionMode: "default", model: "opus" },
  });
  assert.ok(ok.ok);
  assert.equal(db.getSession(ok.data!.id)!.model, "opus");
});

test("createSession clamp does not touch non-conductor agents", () => {
  const { db, hub, svc } = makeHarness();
  const res = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    config: { permissionMode: "acceptEdits" },
  });
  assert.ok(res.ok);
  assert.equal(db.getSession(res.data!.id)!.permissionMode, "acceptEdits");
});

test("setConfig on a conductor session rejects a permissionMode change; guardrail-only writes pass", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CONDUCTOR_ID });

  const res = svc.setConfig(id, { permissionMode: "auto" });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.equal(db.getSession(id)!.permissionMode, "default", "the clamped mode is untouched");

  // Guardrails ride their own columns — arming a budget on the conductor itself must work
  // (the recommended runaway-conductor protection).
  const budget = svc.setConfig(id, { costBudgetUsd: 5, maxToolCalls: 50 });
  assert.ok(budget.ok);
  const s = db.getSession(id)!;
  assert.equal(s.costBudgetUsd, 5);
  assert.equal(s.maxToolCalls, 50);
  assert.equal(s.permissionMode, "default");
});

test("prompt-time config with a non-default permissionMode on a conductor session -> 409; plain prompt passes", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CONDUCTOR_ID });

  const before = hub.sentOfType("prompt_session").length;
  const res = svc.prompt(id, "go wild", [], undefined, { permissionMode: "acceptEdits" });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.equal(hub.sentOfType("prompt_session").length, before, "no prompt forwarded");
  assert.equal(db.getSession(id)!.permissionMode, "default", "nothing persisted before the guard");

  // A plain prompt (and one that echoes "default") sails through with the clamped config.
  const plain = svc.prompt(id, "what is running?");
  assert.ok(plain.ok);
  const msg = sentPromptCommands(hub).at(-1)!;
  assert.equal(msg.config!.permissionMode, "default");
  const explicit = svc.prompt(id, "list sessions", [], undefined, { permissionMode: "default" });
  assert.ok(explicit.ok);
});

test("pods group isolated sessions and manual relay preflights every target before delivery", () => {
  const { db, hub, svc } = makeHarness();
  const first = seedSession(svc, hub, { useWorktree: true, title: "Builder" });
  const second = seedSession(svc, hub, { useWorktree: true, title: "Reviewer" });
  db.setWorktreePath(first, `/worktrees/${first}`);
  db.updateSessionStatus(first, "idle", Date.now());
  db.updateSessionStatus(second, "idle", Date.now());
  hub.sentToRunner.length = 0;

  const created = svc.createPod({
    title: "Patch huddle",
    objective: "Build and review one patch",
    sessionIds: [first, second],
  });
  assert.equal(created.ok, true);
  assert.deepEqual(created.data!.pod.members.map((member) => member.sessionId), [first, second]);
  assert.equal(hub.podChangedCalls.at(-1)?.id, created.data!.pod.id);

  const blocked = svc.relayPod(created.data!.pod.id, { text: "Review the current approach." });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error ?? "", /active isolated worktree/);
  assert.equal(hub.sentOfType("prompt_session").length, 0, "preflight failure sends to no members");

  db.setWorktreePath(second, `/worktrees/${second}`);
  const relayed = svc.relayPod(created.data!.pod.id, { text: "Review the current approach." });
  assert.equal(relayed.ok, true);
  assert.deepEqual(relayed.data!.receipts.map((receipt) => receipt.status), ["delivered", "delivered"]);
  assert.equal(relayed.data!.appendedEntry?.source.kind, "human");
  const prompts = hub.sentOfType("prompt_session");
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts.map((prompt) => prompt.sessionId), [first, second]);
  assert.match(prompts[0]!.text, new RegExp(`^\\[Manual relay from pod "Patch huddle" \\(${created.data!.pod.id}\\)\\]`));
  const coordination = JSON.parse(prompts[0]!.text.split("\n").at(-1)!) as Record<string, unknown>;
  assert.deepEqual(coordination, {
    kind: "coordination_note",
    source: { kind: "human", actorId: "local" },
    content: "Review the current approach.",
  });

  hub.sentToRunner.length = 0;
  let sends = 0;
  hub.deliveryHandler = () => (sends += 1) === 1;
  const partial = svc.relayPod(created.data!.pod.id, {
    contextEntryIds: [relayed.data!.appendedEntry!.id],
    sessionIds: [first, second],
  });
  assert.equal(partial.ok, true, "a mid-delivery disconnect returns exact receipts instead of hiding the partial");
  assert.deepEqual(partial.data!.receipts.map((receipt) => receipt.status), ["delivered", "failed"]);
  assert.equal(partial.data!.sessions.length, 1);
  const relayedContext = JSON.parse(hub.sentOfType("prompt_session")[0]!.text.split("\n").at(-1)!);
  assert.equal(relayedContext.kind, "huddle_context");
  assert.deepEqual(relayedContext.source, { kind: "human", actorId: "local" });
  const sentBeforeInvalid = hub.sentOfType("prompt_session").length;
  const invalidContext = svc.relayPod(created.data!.pod.id, { contextEntryIds: ["not-in-pod"] });
  assert.equal(invalidContext.status, 409);
  assert.equal(hub.sentOfType("prompt_session").length, sentBeforeInvalid, "invalid context sends nothing");
});

test("pod reconciliation records before delivery and preserves exact runner provenance", async () => {
  const { db, hub, svc } = makeHarness();
  const target = seedReadyPodSession(db, svc, hub, "Integration");
  const source = seedReadyPodSession(db, svc, hub, "Builder");
  const pod = svc.createPod({ title: "Merge pod", sessionIds: [target, source] }).data!.pod;
  hub.podChangedCalls.length = 0;
  const sourceHead = "a".repeat(40);
  const targetHead = "b".repeat(40);
  const mergeBase = "c".repeat(40);
  const resultHead = "d".repeat(40);
  hub.requestHandler = (msg) => {
    assert.equal(msg.type, "git_action");
    if (msg.type !== "git_action") throw new Error("unexpected request");
    assert.equal(msg.sessionId, target);
    assert.equal(msg.worktreePath, `/worktrees/${target}`);
    assert.deepEqual(msg.action, {
      kind: "pod_reconcile",
      sourceSessionId: source,
      message: `Merge pod member ${source} into ${target}`,
    });
    assert.equal(db.getPod(pod.id)?.reconciliations?.[0]?.status, "running",
      "the durable receipt exists before runner delivery");
    return {
      type: "git_result",
      requestId: msg.requestId,
      ok: true,
      data: { podReconciliation: { status: "applied", sourceHead, targetHead, mergeBase, resultHead } },
    };
  };

  const applied = await svc.reconcilePod(pod.id, { sourceSessionId: source, targetSessionId: target }, "device-7");
  assert.equal(applied.status, 201);
  assert.equal(applied.data?.reconciliation.actorId, "device-7");
  assert.equal(applied.data?.reconciliation.status, "applied");
  assert.equal(applied.data?.reconciliation.resultHead, resultHead);
  assert.deepEqual(hub.podChangedCalls.map((changed) => changed.reconciliations?.[0]?.status), ["running", "applied"]);

  hub.requestHandler = (msg) => ({
    type: "git_result",
    requestId: msg.type === "git_action" ? msg.requestId : "unexpected",
    ok: true,
    data: {
      podReconciliation: {
        status: "conflicted",
        sourceHead: "e".repeat(40),
        targetHead: resultHead,
        mergeBase,
        conflictPaths: ["src/shared.ts"],
      },
    },
  });
  const conflicted = await svc.reconcilePod(pod.id, { sourceSessionId: target, targetSessionId: source }, "device-7");
  assert.equal(conflicted.status, 200);
  assert.equal(conflicted.data?.reconciliation.status, "conflicted");
  assert.deepEqual(conflicted.data?.reconciliation.conflictPaths, ["src/shared.ts"]);

  hub.requestHandler = (msg) => ({
    type: "git_result",
    requestId: msg.type === "git_action" ? msg.requestId : "unexpected",
    ok: true,
    data: { podReconciliation: { status: "applied", sourceHead, targetHead, mergeBase } },
  });
  const malformed = await svc.reconcilePod(pod.id, { sourceSessionId: source, targetSessionId: target }, "device-7");
  assert.equal(malformed.status, 409);
  assert.equal(db.getPod(pod.id)?.reconciliations?.[0]?.status, "failed");
  assert.match(db.getPod(pod.id)?.reconciliations?.[0]?.error ?? "", /malformed reconciliation provenance/);
});

test("an active pod reconciliation locks both sessions and service restart fails it without replay", () => {
  const { db, hub, svc } = makeHarness();
  const target = seedReadyPodSession(db, svc, hub, "Integration");
  const source = seedReadyPodSession(db, svc, hub, "Builder");
  const pod = svc.createPod({ title: "Locked pod", sessionIds: [target, source] }).data!.pod;
  assert.ok(svc.updatePodOrchestration(pod.id, { mode: "round_robin" }).ok);
  assert.ok(db.beginPodReconciliation({
    reconciliationId: "reconcile-lock",
    podId: pod.id,
    sourceSessionId: source,
    targetSessionId: target,
    actorId: "device-1",
    now: 1_000,
  }));
  const sentBefore = hub.sentToRunner.length;

  assert.match(svc.podReconciliationMutationError(source) ?? "", /locked by pod reconciliation/);
  assert.equal(svc.prompt(source, "overlap").status, 409);
  assert.equal(svc.restart(target).status, 409);
  assert.equal(svc.delete(source).status, 409);
  assert.equal(svc.updatePodMember(pod.id, source, { role: "reviewer" }).status, 409);
  assert.equal(svc.removePodMember(pod.id, source).status, 409);
  assert.equal(svc.relayPod(pod.id, { text: "overlap" }).status, 409);
  assert.equal(svc.startPodOrchestration(pod.id, { firstSessionId: source }).status, 409);
  assert.equal(svc.closePod(pod.id).status, 409);
  assert.equal(hub.sentToRunner.length, sentBefore, "blocked mutations never reach the runner");

  new SessionsService(db, hub as unknown as Hub, NOOP_LOG);
  const failed = db.getPodReconciliation("reconcile-lock");
  assert.equal(failed?.status, "failed");
  assert.match(failed?.error ?? "", /restart.*uncertain/);
  assert.equal(hub.sentToRunner.length, sentBefore, "recovery never replays an uncertain merge");
});

test("pod context is append-only, attributed, idempotent for selected output, and survives source deletion", () => {
  const { db, hub, svc } = makeHarness();
  const first = seedSession(svc, hub, { useWorktree: true, title: "Builder" });
  const second = seedSession(svc, hub, { useWorktree: true, title: "Reviewer" });
  db.updateSessionStatus(first, "idle", Date.now());
  db.updateSessionStatus(second, "idle", Date.now());
  const pod = svc.createPod({ title: "Context pod", sessionIds: [first, second] }).data!.pod;
  db.appendEvent(first, { kind: "user_message", text: "Build it", final: true }, 100);
  db.appendEvent(first, { kind: "agent_message", text: "Patch " }, 101);
  db.appendEvent(first, { kind: "agent_message", text: "ready" }, 102);

  db.updateSessionStatus(first, "running", 103);
  assert.equal(
    svc.appendPodContext(pod.id, { kind: "member_output", sessionId: first }, "device-1").status,
    409,
    "streaming output cannot be frozen as if it were a settled turn",
  );
  db.updateSessionStatus(first, "idle", 104);
  assert.equal(svc.appendPodContext(pod.id, { kind: "note", text: "   " }, "device-1").status, 400);

  const shared = svc.appendPodContext(pod.id, { kind: "member_output", sessionId: first }, "device-1");
  assert.equal(shared.status, 201);
  assert.equal(shared.data!.entry.content, "Patch ready");
  assert.deepEqual(shared.data!.entry.source, {
    kind: "session",
    sessionId: first,
    sessionTitle: "Builder",
    agentLabel: "Claude",
    fromSeq: 2,
    toSeq: 3,
  });
  assert.equal(hub.podContextEntryCalls.at(-1)?.id, shared.data!.entry.id);

  const duplicate = svc.appendPodContext(pod.id, { kind: "member_output", sessionId: first }, "device-1");
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data!.created, false);
  assert.equal(duplicate.data!.entry.id, shared.data!.entry.id);
  assert.equal(hub.podContextEntryCalls.length, 1, "idempotent selection is not broadcast twice");

  const note = svc.appendPodContext(pod.id, { kind: "note", text: "Check edge cases" }, "device-1");
  assert.equal(note.data!.entry.seq, 2);
  assert.deepEqual(note.data!.entry.source, { kind: "human", actorId: "device-1" });
  assert.equal(svc.delete(first).ok, true);
  assert.equal(db.listPodContextEntries(pod.id)[0]?.content, "Patch ready", "frozen context survives source deletion");
  assert.equal(svc.appendPodContext(pod.id, { kind: "note", text: "late" }, "device-1").status, 409);
});

test("round-robin pod orchestration captures outputs, advances target cursors, and stops at the durable turn cap", () => {
  const { db, hub, svc } = makeHarness();
  const first = seedReadyPodSession(db, svc, hub, "Lead");
  const second = seedReadyPodSession(db, svc, hub, "Builder");
  const pod = svc.createPod({ title: "Automatic pod", objective: "Produce and review a patch", sessionIds: [first, second] }).data!.pod;
  assert.deepEqual(pod.members.map((member) => member.role), ["lead", "worker"]);
  assert.equal(svc.updatePodOrchestration(pod.id, {
    mode: "round_robin",
    contextTokenBudget: 4096,
    summaryTokenBudget: 128,
    maxTurns: 2,
    maxRepeatedOutputs: 2,
  }).ok, true);
  hub.sentToRunner.length = 0;

  const started = svc.startPodOrchestration(pod.id, { instruction: "Start with the smallest safe change", firstSessionId: first }, "device-1");
  assert.equal(started.status, 201);
  assert.equal(started.data!.pod.orchestration!.state.status, "running");
  assert.equal(started.data!.pod.orchestration!.state.currentSessionId, first);
  assert.equal(started.data!.step!.turn, 1);
  assert.equal(hub.sentOfType("prompt_session").at(-1)?.sessionId, first);
  assert.ok(started.data!.step!.estimatedTokens <= 4096);
  assert.equal(db.getPod(pod.id)!.members[0]!.lastContextSeq, 1, "seed note was represented to the first target");
  assert.equal(svc.updatePodMember(pod.id, second, { role: "reviewer" }).status, 409);
  assert.equal(svc.removePodMember(pod.id, second).status, 409);
  assert.equal(svc.relayPod(pod.id, { text: "overlap" }).status, 409);

  svc.onSessionEvent(first, { kind: "agent_message", text: "Implemented the parser fix", final: true });
  svc.onSessionStatus(first, "idle");
  let current = db.getPod(pod.id)!;
  assert.equal(current.orchestration!.state.currentSessionId, second);
  assert.equal(current.orchestration!.state.turnsUsed, 2);
  assert.equal(db.getPod(pod.id)!.members[1]!.lastContextSeq, 2, "the next target saw the note and captured lead output");
  assert.deepEqual(hub.sentOfType("prompt_session").map((message) => message.sessionId), [first, second]);

  svc.onSessionEvent(second, { kind: "agent_message", text: "Reviewed the parser fix", final: true });
  svc.onSessionStatus(second, "idle");
  current = db.getPod(pod.id)!;
  assert.equal(current.orchestration!.state.status, "stopped");
  assert.equal(current.orchestration!.state.stopReason, "max_turns");
  const steps = db.podOrchestrationSteps(pod.id, current.orchestration!.state.runId!);
  assert.deepEqual(steps.map((step) => [step.turn, step.targetSessionId, step.status]), [
    [1, first, "settled"],
    [2, second, "settled"],
  ]);
  assert.deepEqual(db.listPodContextEntries(pod.id).map((entry) => entry.source.kind), ["human", "session", "session"]);
});

test("pod orchestration stops exact normalized ping-pong loops before another prompt", () => {
  const { db, hub, svc } = makeHarness();
  const first = seedReadyPodSession(db, svc, hub, "One");
  const second = seedReadyPodSession(db, svc, hub, "Two");
  const pod = svc.createPod({ title: "Loop guard", sessionIds: [first, second] }).data!.pod;
  assert.ok(svc.updatePodOrchestration(pod.id, { mode: "round_robin", maxTurns: 10, maxRepeatedOutputs: 2 }).ok);
  hub.sentToRunner.length = 0;
  assert.ok(svc.startPodOrchestration(pod.id, { firstSessionId: first }).ok);
  svc.onSessionEvent(first, { kind: "agent_message", text: "Same  answer", final: true });
  svc.onSessionStatus(first, "idle");
  svc.onSessionEvent(second, { kind: "agent_message", text: "  SAME\nANSWER  ", final: true });
  svc.onSessionStatus(second, "idle");

  const stopped = db.getPod(pod.id)!;
  assert.equal(stopped.orchestration!.state.status, "stopped");
  assert.match(stopped.orchestration!.state.stopReason ?? "", /^repeated_output:/);
  assert.equal(hub.sentOfType("prompt_session").length, 2, "loop guard stops before dispatching turn three");
});

test("lead-driven and event-triggered arbitration honor roles and explicit human checkpoints", () => {
  const { db, hub, svc } = makeHarness();
  const lead = seedReadyPodSession(db, svc, hub, "Lead");
  const worker = seedReadyPodSession(db, svc, hub, "Worker");
  const reviewer = seedReadyPodSession(db, svc, hub, "Reviewer");
  const pod = svc.createPod({ title: "Roles", sessionIds: [lead, worker, reviewer] }).data!.pod;
  assert.ok(svc.updatePodMember(pod.id, reviewer, { role: "reviewer", contextTokenBudget: 4096 }).ok);
  assert.ok(svc.updatePodOrchestration(pod.id, { mode: "lead_driven", maxTurns: 4 }).ok);
  hub.sentToRunner.length = 0;
  assert.ok(svc.startPodOrchestration(pod.id, {}).ok);
  assert.equal(hub.sentOfType("prompt_session").at(-1)?.sessionId, lead);
  svc.onSessionEvent(lead, { kind: "agent_message", text: "Delegate implementation", final: true });
  svc.onSessionStatus(lead, "idle");
  assert.equal(hub.sentOfType("prompt_session").at(-1)?.sessionId, worker);
  svc.onSessionEvent(worker, { kind: "agent_message", text: "Implementation complete", final: true });
  svc.onSessionStatus(worker, "idle");
  assert.equal(hub.sentOfType("prompt_session").at(-1)?.sessionId, lead, "non-lead output returns to the lead");
  assert.ok(svc.stopPodOrchestration(pod.id).ok);

  // Settle the already-delivered lead turn before starting a fresh event-triggered cycle.
  svc.onSessionEvent(lead, { kind: "agent_message", text: "Lead stopped", final: true });
  svc.onSessionStatus(lead, "idle");
  assert.ok(svc.updatePodOrchestration(pod.id, { mode: "event_triggered", maxTurns: 4 }).ok);
  hub.sentToRunner.length = 0;
  assert.ok(svc.startPodOrchestration(pod.id, { firstSessionId: reviewer }).ok);
  svc.onSessionEvent(reviewer, { kind: "agent_message", text: "Review found one issue", final: true });
  svc.onSessionStatus(reviewer, "idle");
  assert.equal(hub.sentOfType("prompt_session").at(-1)?.sessionId, lead, "member completion triggers the lead");
  svc.onSessionEvent(lead, { kind: "agent_message", text: "Decision recorded", final: true });
  svc.onSessionStatus(lead, "idle");
  const paused = db.getPod(pod.id)!;
  assert.equal(paused.orchestration!.state.status, "paused");
  assert.equal(paused.orchestration!.state.stopReason, "lead_turn_complete");
});

test("an interrupted automatic dispatch pauses on service restart instead of replaying", () => {
  const { db, hub, svc } = makeHarness();
  const first = seedReadyPodSession(db, svc, hub, "One");
  const second = seedReadyPodSession(db, svc, hub, "Two");
  const pod = svc.createPod({ title: "Restart-safe", sessionIds: [first, second] }).data!.pod;
  assert.ok(svc.updatePodOrchestration(pod.id, { mode: "round_robin" }).ok);
  assert.ok(svc.startPodOrchestration(pod.id, { firstSessionId: first }).ok);
  const sentBeforeRestart = hub.sentOfType("prompt_session").length;

  new SessionsService(db, hub as unknown as Hub, NOOP_LOG);
  const recovered = db.getPod(pod.id)!;
  assert.equal(recovered.orchestration!.state.status, "paused");
  assert.equal(recovered.orchestration!.state.stopReason, "control_plane_restart");
  assert.equal(recovered.orchestration!.lastStep?.status, "failed");
  assert.equal(hub.sentOfType("prompt_session").length, sentBeforeRestart, "constructor recovery never replays delivery");
});

test("automatic delivery failure stops durably and a settle-time guardrail captures output before pausing", () => {
  const { db, hub, svc } = makeHarness();
  const first = seedReadyPodSession(db, svc, hub, "One");
  const second = seedReadyPodSession(db, svc, hub, "Two");
  const pod = svc.createPod({ title: "Failure boundaries", sessionIds: [first, second] }).data!.pod;
  assert.ok(svc.updatePodOrchestration(pod.id, { mode: "round_robin" }).ok);

  hub.deliveryHandler = () => false;
  const failed = svc.startPodOrchestration(pod.id, { firstSessionId: first });
  assert.equal(failed.status, 409);
  assert.equal(db.getPod(pod.id)!.orchestration!.state.status, "stopped");
  assert.match(db.getPod(pod.id)!.orchestration!.state.stopReason ?? "", /did not receive/);
  assert.equal(db.getSession(first)!.status, "idle", "failed prompt restores the pre-dispatch session status");

  hub.deliveryHandler = undefined;
  assert.ok(svc.startPodOrchestration(pod.id, { firstSessionId: first }).ok);
  assert.ok(svc.setConfig(first, { maxToolCalls: 1 }).ok);
  svc.onSessionEvent(first, { kind: "agent_message", text: "Work completed before the gate", final: true });
  svc.onSessionEvent(first, { kind: "tool_call", toolCallId: "tool-1", title: "Edit", status: "completed" });
  svc.onSessionStatus(first, "idle");
  const paused = db.getPod(pod.id)!;
  assert.equal(paused.orchestration!.state.status, "paused");
  assert.equal(paused.orchestration!.state.stopReason, "member_requires_human_decision");
  assert.equal(paused.orchestration!.lastStep?.status, "settled", "completed output remains auditable, not a failed step");
  assert.equal(db.listPodContextEntries(pod.id).at(-1)?.content, "Work completed before the gate");
  assert.equal(hub.sentOfType("prompt_session").filter((message) => message.sessionId === second).length, 0);
});

test("pod orchestration policy rejects unsafe bounds and ambiguous lead arbitration", () => {
  const { db, hub, svc } = makeHarness();
  const first = seedReadyPodSession(db, svc, hub, "One");
  const second = seedReadyPodSession(db, svc, hub, "Two");
  const pod = svc.createPod({ title: "Policy", sessionIds: [first, second] }).data!.pod;
  assert.equal(svc.updatePodOrchestration(pod.id, { contextTokenBudget: 1024 }).status, 400);
  assert.equal(svc.updatePodOrchestration(pod.id, { summaryTokenBudget: 4096 }).status, 400);
  assert.ok(svc.updatePodMember(pod.id, first, { role: "worker" }).ok);
  const ambiguous = svc.updatePodOrchestration(pod.id, { mode: "lead_driven" });
  assert.equal(ambiguous.status, 409);
  assert.match(ambiguous.error ?? "", /exactly one lead/);
});

test("pod membership is exclusive, bounded, mutable only while active, and closes durably", () => {
  const { db, hub, svc } = makeHarness();
  const ids = [
    seedSession(svc, hub, { useWorktree: true, title: "One" }),
    seedSession(svc, hub, { useWorktree: true, title: "Two" }),
    seedSession(svc, hub, { useWorktree: true, title: "Three" }),
  ];
  const pod = svc.createPod({ title: "Pod", sessionIds: ids.slice(0, 2) }).data!.pod;
  const duplicate = svc.createPod({ title: "Other", sessionIds: [ids[0]!, ids[2]!] });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.error ?? "", /already belongs/);

  const added = svc.addPodMember(pod.id, { sessionId: ids[2]! });
  assert.equal(added.ok, true);
  assert.equal(added.data!.pod.members.length, 3);
  assert.equal(svc.removePodMember(pod.id, ids[2]!).data!.pod.members.length, 2);
  assert.equal(svc.removePodMember(pod.id, ids[1]!).status, 409);

  const closed = svc.closePod(pod.id);
  assert.equal(closed.data!.pod.status, "closed");
  assert.equal(db.getPod(pod.id)?.status, "closed");
  assert.equal(svc.addPodMember(pod.id, { sessionId: ids[2]! }).status, 409);
  assert.equal(svc.relayPod(pod.id, { text: "late" }).status, 409);
  const next = svc.createPod({ title: "Next pod", sessionIds: [ids[0]!, ids[2]!] });
  assert.equal(next.ok, true, "closed history does not lock a session out of a future active pod");
  assert.equal(svc.delete(ids[0]!).ok, true);
  assert.equal(db.getPod(next.data!.pod.id)?.status, "closed", "session deletion closes an undersized active pod");
  const nextPodBroadcast = hub.podChangedCalls.filter((changed) => changed.id === next.data!.pod.id).at(-1);
  assert.equal(nextPodBroadcast?.status, "closed");
});

test("pod membership spans runners without conflating their workspace ownership", () => {
  const { db, hub, svc } = makeHarness();
  db.registerRunner({ ...runnerMeta(), runnerId: "runner-2", hostname: "other-host" }, Date.now(), PROTOCOL_VERSION);
  const local = seedSession(svc, hub, { useWorktree: true, title: "Local" });
  const remote = svc.createSession({
    runnerId: "runner-2",
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    useWorktree: true,
    title: "Remote",
  }).data!.id;
  const result = svc.createPod({ title: "Cross-box pod", sessionIds: [local, remote] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data!.sessions.map((session) => session.runnerId), [RUNNER_ID, "runner-2"]);
});

test("createRun clamps a conductor member to 'default' (persisted + spec + later prompt echo)", () => {
  const { db, hub, svc } = makeHarness();
  // NewRunDialog default-selects EVERY agent, so a run routinely includes the conductor.
  const res = svc.createRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentIds: [AGENT_ID, CONDUCTOR_ID],
    task: "compare approaches",
  });
  assert.ok(res.ok && res.data);

  const conductorMember = res.data!.sessions.find((s) => s.agentId === CONDUCTOR_ID)!;
  assert.ok(conductorMember, "the conductor member session was created");
  // Persisted row carries "default" — a NULL row would echo undefined on the next prompt and
  // the driver's "acceptEdits" fallback would run the manager tools ungated from turn 2 on.
  assert.equal(db.getSession(conductorMember.id)!.permissionMode, "default");
  const start = hub.sentOfType("start_session").find((m) => m.spec.agentId === CONDUCTOR_ID)!;
  assert.equal(start.spec.config!.permissionMode, "default");

  // The follow-up prompt's config echo (re-read from the DB) carries the gate too.
  db.updateSessionStatus(conductorMember.id, "idle", Date.now());
  assert.ok(svc.prompt(conductorMember.id, "carry on").ok);
  const echoed = hub.sentOfType("prompt_session").at(-1)!;
  assert.equal(echoed.config!.permissionMode, "default");

  // Non-conductor members keep the shared config untouched (none sent here -> null).
  const worker = res.data!.sessions.find((s) => s.agentId === AGENT_ID)!;
  assert.equal(db.getSession(worker.id)!.permissionMode, null);
});

test("createRun with a conductor member and an explicit non-default mode -> 409, atomically", () => {
  const { db, hub, svc } = makeHarness();
  const res = svc.createRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentIds: [AGENT_ID, CONDUCTOR_ID],
    task: "own the manager",
    config: { permissionMode: "bypassPermissions" },
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.match(res.error ?? "", /conductor/);
  // Atomic reject: validated pre-persist, so no partial run and no orphan member sessions.
  assert.equal(db.listSessions({ includeArchived: true }).length, 0);
  assert.equal(db.listRuns().length, 0);
  assert.equal(hub.sentToRunner.length, 0);

  // Without the conductor, the same run config is legitimate (workers may use acceptEdits).
  const workersOnly = svc.createRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentIds: [AGENT_ID],
    task: "normal work",
    config: { permissionMode: "acceptEdits" },
  });
  assert.ok(workersOnly.ok && workersOnly.data);
  assert.equal(db.getSession(workersOnly.data!.sessions[0]!.id)!.permissionMode, "acceptEdits");
});

/* -------------------------------------------------------------------------- */
/* Cost-budget policy cards + v47 runner re-arm                               */
/* -------------------------------------------------------------------------- */

test("budgetDecision: asks at/over budget, ok below / no-budget / terminal", () => {
  assert.equal(budgetDecision(6, 5, "running"), "ask");
  assert.equal(budgetDecision(5, 5, "running"), "ask"); // >= is the trigger
  assert.equal(budgetDecision(4.99, 5, "running"), "ok");
  assert.equal(budgetDecision(100, null, "running"), "ok"); // no budget
  assert.equal(budgetDecision(100, 0, "running"), "ok"); // 0 = unlimited
  assert.equal(budgetDecision(100, 5, "completed"), "ok"); // terminal never gates
});

test("token_usage crossing the budget parks the session with a cost_budget approval", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { costBudgetUsd: 5 });
  db.updateSessionStatus(id, "running", Date.now());

  svc.onSessionEvent(id, { kind: "token_usage", costUsd: 6 });

  const s = db.getSession(id)!;
  assert.equal(s.status, "input_required");
  assert.equal(s.column, "input_required"); // derived from status by columnForStatus
  assert.ok(s.pendingApproval);
  assert.equal(s.pendingApproval!.kind, "cost_budget");
  assert.match(s.pendingApproval!.title, /Cost budget reached/);
  assert.deepEqual(
    s.pendingApproval!.options.map((o) => o.optionId),
    ["continue", "cancel"],
  );
});

test("parented token_usage remains in the timeline but does not inflate authoritative session totals or gates", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { costBudgetUsd: 5 });
  db.updateSessionStatus(id, "running", Date.now());

  svc.onSessionEvent(id, { kind: "token_usage", inputTokens: 90, outputTokens: 10, costUsd: 99, parentToolUseId: "task-1" });
  let session = db.getSession(id)!;
  assert.equal(session.tokensIn, 0);
  assert.equal(session.tokensOut, 0);
  assert.equal(session.costUsd, 0);
  assert.equal(session.pendingApproval, null, "display-only subagent usage cannot trip the session budget");
  assert.equal(db.listEvents(id).at(-1)!.payload.kind, "token_usage", "the attributed event remains available to the timeline");

  svc.onSessionEvent(id, { kind: "token_usage", inputTokens: 9, outputTokens: 2, costUsd: 1 });
  session = db.getSession(id)!;
  assert.equal(session.tokensIn, 9);
  assert.equal(session.tokensOut, 2);
  assert.equal(session.costUsd, 1);
});

test("a second token_usage does not re-ask while already parked on the budget", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { costBudgetUsd: 5 });
  db.updateSessionStatus(id, "running", Date.now());

  svc.onSessionEvent(id, { kind: "token_usage", costUsd: 6 });
  const first = db.getSession(id)!.pendingApproval!.requestId;
  svc.onSessionEvent(id, { kind: "token_usage", costUsd: 4 }); // now $10, still parked
  assert.equal(db.getSession(id)!.pendingApproval!.requestId, first); // unchanged, not re-asked
});

test("token_usage on a terminal session never gates", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { costBudgetUsd: 5 });
  db.updateSessionStatus(id, "completed", Date.now());

  svc.onSessionEvent(id, { kind: "token_usage", costUsd: 100 });
  assert.equal(db.getSession(id)!.pendingApproval, null);
});

test("approve(continue) re-arms the next cost window and resumes the v47 runner", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { costBudgetUsd: 5 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "token_usage", costUsd: 6 });
  const reqId = db.getSession(id)!.pendingApproval!.requestId;

  const before = hub.sentOfType("resolve_permission").length;
  const res = svc.approve(id, reqId, "continue");
  assert.ok(res.ok);

  const s = db.getSession(id)!;
  assert.equal(s.pendingApproval, null);
  assert.equal(s.costBudgetUsd, 11); // observed $6 + the original $5 allowance window
  assert.equal(s.costBudgetStepUsd, 5);
  assert.equal(s.status, "idle");
  const rearm = hub.sentOfType("rearm_governance").at(-1)!;
  assert.deepEqual(rearm.config, { costBudgetUsd: 11 });
  // Policy cards never masquerade as provider permission requests.
  assert.equal(hub.sentOfType("resolve_permission").length, before);
});

test("approve(cancel) on a cost-budget pause stops the session", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { costBudgetUsd: 5 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "token_usage", costUsd: 6 });
  const reqId = db.getSession(id)!.pendingApproval!.requestId;

  svc.approve(id, reqId, "cancel");
  const s = db.getSession(id)!;
  assert.equal(s.status, "stopped");
  assert.equal(s.pendingApproval, null);
  assert.equal(hub.sentOfType("stop_session").filter((m) => m.sessionId === id).length, 1);
});

test("pre-v47 runners use the re-armed threshold on the next prompt without an unknown command", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { costBudgetUsd: 5 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "token_usage", costUsd: 6 });
  const reqId = db.getSession(id)!.pendingApproval!.requestId;
  db.registerRunner(runnerMeta(), Date.now(), 46);
  hub.sentToRunner.length = 0;

  assert.ok(svc.approve(id, reqId, "continue").ok);
  assert.equal(hub.sentOfType("rearm_governance").length, 0);
  assert.equal(db.getSession(id)!.costBudgetUsd, 11);
  assert.ok(svc.prompt(id, "next turn").ok);
  assert.equal(hub.sentOfType("prompt_session").at(-1)!.config?.costBudgetUsd, 11);
});

test("a v47 re-arm delivery failure preserves the parked policy card and threshold", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { maxToolCalls: 1 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "tool_call", toolCallId: "t1", title: "Read", status: "completed" });
  svc.onSessionStatus(id, "idle");
  const pending = db.getSession(id)!.pendingApproval!;
  hub.deliver = false;

  const res = svc.approve(id, pending.requestId, "continue");
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.equal(db.getSession(id)!.pendingApproval?.requestId, pending.requestId);
  assert.equal(db.getSession(id)!.maxToolCalls, 1);
});

test("a trailing idle status does not wipe the cost-budget pause (re-applied at turn-settle)", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { costBudgetUsd: 5 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "token_usage", costUsd: 6 }); // parks on the budget
  assert.equal(db.getSession(id)!.status, "input_required");

  // The runner then reports the turn settled (status: idle). updateSessionStatus clears the card, so
  // the settle-time gate must re-park it — otherwise the budget pause silently vanishes.
  svc.onSessionStatus(id, "idle");
  const s = db.getSession(id)!;
  assert.equal(s.status, "input_required");
  assert.equal(s.pendingApproval?.kind, "cost_budget");
});

test("turn-settle gate parks an over-budget session when idle is the trigger (usage arrived first)", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "token_usage", costUsd: 6 }); // no budget set yet → no gate
  assert.equal(db.getSession(id)!.pendingApproval, null);

  svc.setConfig(id, { costBudgetUsd: 5 }); // budget set after the cost already accrued
  svc.onSessionStatus(id, "idle"); // settle → gate fires
  const s = db.getSession(id)!;
  assert.equal(s.status, "input_required");
  assert.equal(s.pendingApproval?.kind, "cost_budget");
});

/* -------------------------------------------------------------------------- */
/* approve                                                                   */
/* -------------------------------------------------------------------------- */

test("approve fails 409 when the runner is offline (online guard)", () => {
  const { hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  hub.online = false;

  const before = hub.sentToRunner.length;
  const res = svc.approve(id, "req-1", "opt-1");
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.equal(hub.sentToRunner.length, before);
});

test("approve fails 409 if the runner does not actually receive the message", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  // Online by the guard's reckoning, but delivery fails.
  hub.online = true;
  hub.deliver = false;
  db.setPendingApproval(id, { requestId: "req-1", title: "t", options: [] });

  const res = svc.approve(id, "req-1", "opt-1");
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  // State must NOT be mutated when delivery failed: pending approval is intact.
  assert.ok(db.getSession(id)!.pendingApproval);
  const audit = svc.governanceAudit(id);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.outcome, "delivery_failed");
  assert.deepEqual(audit[0]!.actor, { kind: "human", id: "local" });
});

test("approve delivers resolve_permission and clears the pending approval", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.setPendingApproval(id, { requestId: "req-1", title: "t", options: [] });
  db.updateSessionStatus(id, "input_required", Date.now());

  const res = svc.approve(id, "req-1", "opt-1");
  assert.ok(res.ok);

  const msg = hub.sentOfType("resolve_permission").at(-1)!;
  assert.equal(msg.sessionId, id);
  assert.equal(msg.requestId, "req-1");
  assert.equal(msg.optionId, "opt-1");

  const stored = db.getSession(id)!;
  assert.equal(stored.pendingApproval, null);
  // optionId present → running.
  assert.equal(stored.status, "running");
  // The runner owns the timeline now — approve() must NOT append its own permission_resolved event
  // (the runner emits it into the box log and streams it back), else the resolution shows twice.
  assert.equal(hub.sessionEventCalls.filter((e) => e.payload.kind === "permission_resolved").length, 0);
});

test("approve with a null optionId returns the session to idle", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.setPendingApproval(id, { requestId: "req-1", title: "t", options: [] });
  db.updateSessionStatus(id, "input_required", Date.now());

  svc.approve(id, "req-1", null);
  assert.equal(db.getSession(id)!.status, "idle");
});

test("governance audit records permission request and device resolution without raw context", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  const secret = "TOKEN=super-secret";
  svc.onSessionEvent(id, {
    kind: "permission_request",
    requestId: "perm-audit",
    title: "Run shell?",
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    context: { toolName: "shell", input: secret },
  });
  svc.approve(id, "perm-audit", "allow", { kind: "human", id: "device-42" });

  const entries = svc.governanceAudit(id);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => [entry.stage, entry.outcome]), [
    ["request", "pending"],
    ["resolution", "allowed"],
  ]);
  assert.deepEqual(entries[0]!.actor, { kind: "agent", id: AGENT_ID });
  assert.equal(entries[0]!.scope.toolName, "shell");
  assert.match(entries[0]!.contentDigest ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(entries[1]!.actor, { kind: "human", id: "device-42" });
  assert.equal(JSON.stringify(entries).includes(secret), false);
  assert.equal(db.getSession(id)!.pendingApproval, null);
});

test("governance audit records reviewer decisions and human escalation provenance without rationale", () => {
  const { hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  const rationale = "contains sensitive reviewer context";

  svc.onSessionEvent(id, {
    kind: "review_decision",
    reviewId: "review-1",
    requestId: "perm-review",
    reviewer: { kind: "agent", id: "codex-guardian" },
    outcome: "denied",
    riskLevel: "high",
    rationale,
  });
  svc.onSessionEvent(id, {
    kind: "review_decision",
    reviewId: "forged-human-review",
    reviewer: { kind: "human", id: "not-a-reviewer" },
    outcome: "allowed",
  } as unknown as Parameters<typeof svc.onSessionEvent>[1]);
  svc.onSessionEvent(id, {
    kind: "permission_request",
    requestId: "perm-escalated",
    title: "Deploy?",
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    context: { toolName: "shell", input: "deploy --prod", escalatedBy: { kind: "agent", id: "codex-guardian" } },
  });
  svc.approve(id, "perm-escalated", "allow", { kind: "human", id: "device-reviewer" });

  const audit = svc.governanceAudit(id);
  assert.equal(audit.some((entry) => entry.requestId === "forged-human-review"), false);
  const decision = audit.find((entry) => entry.requestId === "perm-review")!;
  assert.deepEqual([decision.stage, decision.outcome, decision.actor], [
    "review", "denied", { kind: "agent", id: "codex-guardian" },
  ]);
  assert.match(decision.contentDigest ?? "", /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(decision).includes(rationale), false);
  assert.deepEqual(
    audit.filter((entry) => entry.requestId === "perm-escalated").map((entry) => [entry.stage, entry.outcome, entry.actor]),
    [
      ["review", "escalated", { kind: "agent", id: "codex-guardian" }],
      ["request", "pending", { kind: "agent", id: CODEX_APP_AGENT_ID }],
      ["resolution", "allowed", { kind: "human", id: "device-reviewer" }],
    ],
  );
});

test("scoped allow policy auto-resolves a matching permission with durable policy provenance", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "tool_call", toolCallId: "prior", title: "Read", status: "completed" });
  assert.ok(svc.upsertGovernancePolicy({
    policyId: "allow-scoped-shell",
    name: "Allow scoped shell",
    effect: "allow",
    priority: 50,
    enabled: true,
    scope: {
      organizationId: "local",
      runnerId: RUNNER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      toolName: "Bash",
      path: "/repos/demo/**",
      network: "*.example.com",
      branch: "feature/*",
    },
    conditions: { statuses: ["running"], minToolCalls: 1, maxCostUsd: 1 },
  }).ok);

  svc.onSessionEvent(id, {
    kind: "permission_request",
    requestId: "scoped-allow",
    title: "Run tests?",
    options: [
      { optionId: "allow-once", name: "Allow", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
    context: { toolName: "Bash", input: "pnpm test", path: "/repos/demo/src/a.ts", network: "api.example.com", branch: "feature/x" },
  });

  assert.deepEqual(hub.sentOfType("resolve_permission").at(-1), {
    type: "resolve_permission",
    sessionId: id,
    requestId: "scoped-allow",
    optionId: "allow-once",
  });
  assert.equal(db.getSession(id)!.pendingApproval, null);
  assert.equal(db.getSession(id)!.status, "running");
  const audit = svc.governanceAudit(id).filter((entry) => entry.requestId === "scoped-allow");
  assert.deepEqual(audit.map((entry) => [entry.stage, entry.outcome]), [
    ["request", "pending"],
    ["policy_decision", "allowed"],
    ["resolution", "allowed"],
  ]);
  assert.equal(audit[1]!.governancePolicyId, "allow-scoped-shell");
  assert.equal(audit[1]!.scope.organizationId, "local");
  assert.equal(audit[1]!.scope.path, "/repos/demo/src/a.ts");
  assert.deepEqual(audit[2]!.actor, { kind: "policy", id: "allow-scoped-shell" });
});

test("Claude policy hook defers on no match and durably resolves non-interactive asks", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  let countQueries = 0;
  const originalCountToolCalls = db.countToolCalls.bind(db);
  db.countToolCalls = ((sessionId: string) => {
    countQueries++;
    return originalCountToolCalls(sessionId);
  }) as typeof db.countToolCalls;
  const request = {
    hookEventName: "PreToolUse",
    providerSessionId: "provider-1",
    permissionMode: "bypassPermissions",
    toolUseId: "tool-1",
    context: { toolName: "Read", path: "/repos/demo/secret.txt" },
  };
  assert.deepEqual(svc.evaluatePolicyHook(id, request).data, {
    decision: "defer",
    reason: "No manager policy matched; defer to provider permissions.",
  });
  assert.equal(countQueries, 0, "scope-only policies do not scan session history");

  assert.ok(svc.upsertGovernancePolicy({
    policyId: "deny-hook-secret",
    name: "Deny Hook Secret",
    effect: "deny",
    priority: 10,
    enabled: true,
    scope: { toolName: "Read", path: "/repos/demo/**" },
  }).ok);
  assert.equal(svc.evaluatePolicyHook(id, { ...request, toolUseId: "tool-deny" }).data?.decision, "deny");
  assert.ok(svc.governanceAudit(id).some((entry) =>
    entry.outcome === "denied" &&
    entry.governancePolicyId === "deny-hook-secret"));

  assert.ok(svc.upsertGovernancePolicy({
    policyId: "ask-hook-secret",
    name: "Ask Hook Secret",
    effect: "ask",
    priority: 20,
    enabled: true,
    scope: { toolName: "Read", path: "/repos/demo/**" },
  }).ok);
  const askRequest = { ...request, toolUseId: "tool-ask" };
  const asked = svc.evaluatePolicyHook(id, askRequest, true).data!;
  assert.equal(asked.decision, "ask");
  assert.ok(asked.approvalRequestId);
  assert.equal(db.getSession(id)!.pendingApproval?.kind, "policy_hook");
  assert.equal(svc.evaluatePolicyHook(id, {
    ...askRequest,
    approvalRequestId: asked.approvalRequestId,
  }).data?.decision, "ask");
  assert.equal(hub.sentOfType("resolve_permission").length, 0);
  assert.ok(svc.approve(id, asked.approvalRequestId!, "allow").ok);
  assert.equal(svc.evaluatePolicyHook(id, {
    ...askRequest,
    approvalRequestId: asked.approvalRequestId,
  }).data?.decision, "allow");
  assert.equal(hub.sentOfType("resolve_permission").length, 0, "hook approval never cancels or resolves the provider turn");
  assert.equal(svc.evaluatePolicyHook(id, { ...request, hookEventName: "PostToolUse" }).data?.decision, "defer");
  assert.equal(svc.evaluatePolicyHook(id, {
    ...request,
    permissionMode: "default",
    toolUseId: "tool-interactive",
  }).data?.decision, "provider_ask");
  assert.equal(countQueries, 0, "scope-only allow/deny/ask rules remain O(1)");
  assert.ok(svc.upsertGovernancePolicy({
    policyId: "tool-count-hook",
    name: "Tool Count Hook",
    effect: "deny",
    priority: 30,
    enabled: true,
    scope: { toolName: "Read" },
    conditions: { minToolCalls: 1 },
  }).ok);
  assert.equal(svc.evaluatePolicyHook(id, {
    ...request,
    toolUseId: "tool-count",
  }, true).data?.decision, "ask");
  assert.equal(countQueries, 1, "history is counted lazily only when a rule needs it");
  assert.equal(svc.evaluatePolicyHook(id, { ...request, raw: "not allowed" }).status, 400);

  const codex = seedSession(svc, hub, { agentId: CODEX_AGENT_ID });
  db.updateSessionStatus(codex, "running", Date.now());
  assert.equal(svc.evaluatePolicyHook(codex, request).status, 409);

  assert.equal(svc.evaluatePolicyHook(id, { ...request, transportRecoveredFrom: 123 }).status, 200);
  assert.equal(
    svc.governanceAudit(id).filter((entry) => entry.requestId === "policy-hook-transport:123").length,
    0,
    "the later runner lifecycle event is the one authoritative recovery audit",
  );
});

test("hook requests without a stable tool id still evaluate non-durable policy outcomes", () => {
  const { db, hub, svc } = makeHarness();
  const evaluate = (
    sessionId: string,
    toolName: string,
    permissionMode: "default" | "plan" = "plan",
  ) => svc.evaluatePolicyHook(sessionId, {
    hookEventName: "PreToolUse",
    providerSessionId: `provider-${toolName}`,
    permissionMode,
    context: { toolName },
  });

  const noMatch = seedSession(svc, hub);
  db.updateSessionStatus(noMatch, "running", Date.now());
  assert.equal(evaluate(noMatch, "NoStableIdNoMatch").data?.decision, "defer");

  for (const effect of ["allow", "deny", "ask"] as const) {
    const id = seedSession(svc, hub);
    db.updateSessionStatus(id, "running", Date.now());
    const toolName = `NoStableId-${effect}`;
    assert.ok(svc.upsertGovernancePolicy({
      policyId: `no-stable-id-${effect}`,
      name: `No Stable Id ${effect}`,
      effect,
      priority: 100,
      enabled: true,
      scope: { toolName },
    }).ok);
    const fixed = evaluate(id, toolName).data!;
    assert.equal(fixed.decision, effect === "ask" ? "deny" : effect, effect);
    assert.equal(db.getSession(id)!.pendingApproval, null, `${effect} must not create a durable card`);
    assert.equal(db.listOpenPolicyHookApprovals(id).length, 0, `${effect} must not create a durable row`);
    const audit = svc.governanceAudit(id);
    assert.deepEqual(
      audit.map((entry) => [entry.stage, entry.outcome]),
      [
        ["request", "pending"],
        ["policy_decision", effect === "ask" ? "asked" : effect === "allow" ? "allowed" : "denied"],
        ["resolution", effect === "allow" ? "allowed" : "denied"],
      ],
      `${effect} retains minimized governance provenance`,
    );
    assert.ok(audit.every((entry) => entry.requestId.startsWith("hook_nondurable_")));
    assert.equal(new Set(audit.map((entry) => entry.requestId)).size, 1);
    assert.ok(audit.every((entry) => entry.contentDigest?.length === 64));
    assert.ok(audit.every((entry) =>
      !JSON.stringify(entry).includes(`provider-${toolName}`)));

    const repeated = evaluate(id, toolName).data!;
    assert.equal(repeated.decision, fixed.decision);
    const repeatedAudit = svc.governanceAudit(id);
    assert.equal(repeatedAudit.length, 6);
    assert.equal(
      new Set(repeatedAudit.map((entry) => entry.requestId)).size,
      2,
      "identical non-durable invocations retain distinct audit identities",
    );

    if (effect === "ask") {
      assert.equal(evaluate(id, toolName, "default").data?.decision, "provider_ask");
    }
  }
});

test("a no-tool-id turn-barrier denial emits a complete minimized audit triple", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { costBudgetUsd: 1 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "token_usage", costUsd: 2 });
  assert.equal(db.getSession(id)!.pendingApproval?.kind, "cost_budget");

  const evaluate = () => svc.evaluatePolicyHook(id, {
    hookEventName: "PreToolUse",
    providerSessionId: "provider-barrier-secret",
    permissionMode: "plan",
    context: { toolName: "UnmatchedWithoutId" },
  }).data!;
  assert.equal(evaluate().decision, "deny");
  assert.equal(evaluate().decision, "deny");

  const audit = svc.governanceAudit(id).filter((entry) =>
    entry.requestId.startsWith("hook_nondurable_"));
  assert.deepEqual(
    audit.map((entry) => [entry.stage, entry.outcome, entry.actor.kind, entry.actor.id]),
    [
      ["request", "pending", "agent", AGENT_ID],
      ["policy_decision", "denied", "system", "policy-hook-turn-barrier"],
      ["resolution", "denied", "system", "policy-hook-turn-barrier"],
      ["request", "pending", "agent", AGENT_ID],
      ["policy_decision", "denied", "system", "policy-hook-turn-barrier"],
      ["resolution", "denied", "system", "policy-hook-turn-barrier"],
    ],
  );
  assert.equal(new Set(audit.map((entry) => entry.requestId)).size, 2);
  assert.ok(audit.every((entry) => entry.requestId.startsWith("hook_nondurable_")));
  assert.ok(audit.every((entry) => !JSON.stringify(entry).includes("provider-barrier-secret")));
});

test("the hook request plus driver recovery lifecycle creates exactly one content-free audit", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  assert.equal(svc.evaluatePolicyHook(id, {
    hookEventName: "PreToolUse",
    providerSessionId: "provider-recovery",
    permissionMode: "plan",
    toolUseId: "tool-recovery",
    transportRecoveredFrom: 456,
    context: { toolName: "Read", path: "/repos/demo/a.ts" },
  }).status, 200);
  assert.equal(
    svc.governanceAudit(id).filter((entry) => entry.requestId === "policy-hook-transport:456").length,
    0,
  );
  svc.onSessionEvent(id, { kind: "policy_transport", state: "open", openedAt: 456 }, 1);
  svc.onSessionEvent(id, {
    kind: "policy_transport",
    state: "recovered",
    openedAt: 456,
    restoresElicitation: true,
  }, 2);
  svc.onSessionEvent(id, {
    kind: "policy_transport",
    state: "recovered",
    openedAt: 456,
    restoresElicitation: true,
  }, 2);
  const audit = svc.governanceAudit(id).find((entry) =>
    entry.requestId === "policy-hook-transport:456" && entry.outcome === "allowed");
  assert.equal(audit?.outcome, "allowed");
  assert.equal(audit?.contentDigest?.length, 64);
  assert.deepEqual(audit?.actor, { kind: "system", id: "policy-hook-transport" });
  assert.equal(
    svc.governanceAudit(id).filter((entry) =>
      entry.requestId === "policy-hook-transport:456" && entry.outcome === "allowed").length,
    1,
    "the full request-to-driver path emits one authoritative recovery row",
  );
  assert.equal(svc.governanceAudit(id).filter((entry) =>
    entry.requestId === "policy-hook-transport:456" && entry.outcome === "delivery_failed").length, 1);
});

test("policy transport audit remains deduplicated when a new runner history epoch replays it", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  assert.ok(db.reconcileRunnerHistory(id, 10, 0));
  const opened = { kind: "policy_transport" as const, state: "open" as const, openedAt: 789 };
  const recovered = {
    kind: "policy_transport" as const,
    state: "recovered" as const,
    openedAt: 789,
    restoresElicitation: true,
  };
  svc.onSessionEvent(id, opened, 1, 1_000);
  svc.onSessionEvent(id, recovered, 2, 1_001);
  assert.equal(svc.governanceAudit(id).filter((entry) =>
    entry.requestId === "policy-hook-transport:789").length, 2);

  const reset = db.reconcileRunnerHistory(id, 11, 0);
  assert.equal(reset?.reset, true);
  svc.onSessionEvent(id, opened, 1, 2_000);
  svc.onSessionEvent(id, recovered, 2, 2_001);
  assert.equal(
    svc.governanceAudit(id).filter((entry) =>
      entry.requestId === "policy-hook-transport:789").length,
    2,
    "governance provenance survives event-cache replacement without duplicate audit rows",
  );
});

test("Claude hook policy matrix covers every permission mode without changing interactive asks", () => {
  const { db, hub, svc } = makeHarness();
  const modes = ["default", "auto", "acceptEdits", "plan", "bypassPermissions"] as const;
  const effects = ["allow", "deny", "ask"] as const;
  for (const mode of modes) {
    for (const effect of effects) {
      const id = seedSession(svc, hub);
      db.updateSessionStatus(id, "running", Date.now());
      const toolName = `${mode}-${effect}`;
      const policyId = `matrix:${mode}:${effect}`;
      assert.ok(svc.upsertGovernancePolicy({
        policyId,
        name: `Matrix ${mode} ${effect}`,
        effect,
        priority: 100,
        enabled: true,
        scope: { toolName },
      }).ok);
      const result = svc.evaluatePolicyHook(id, {
        hookEventName: "PreToolUse",
        providerSessionId: `provider-${mode}-${effect}`,
        permissionMode: mode,
        toolUseId: `tool-${mode}-${effect}`,
        context: { toolName },
      }, true).data!;
      const interactiveAsk = effect === "ask" && (mode === "default" || mode === "auto");
      assert.equal(result.decision, interactiveAsk ? "provider_ask" : effect, `${mode}/${effect}`);
      if (interactiveAsk) {
        assert.equal(db.getSession(id)!.pendingApproval, null, `${mode} stays on provider stdio`);
        svc.onSessionEvent(id, {
          kind: "permission_request",
          requestId: `stdio-${mode}`,
          title: "Allow Tool?",
          options: [
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
          context: { toolName },
        });
      }
      assert.equal(
        db.getSession(id)!.pendingApproval != null,
        effect === "ask",
        `${mode}/${effect} card presence`,
      );
      const audit = svc.governanceAudit(id);
      assert.ok(
        audit.some((entry) =>
          entry.governancePolicyId === policyId &&
          entry.stage === "policy_decision" &&
          entry.outcome === (effect === "ask" ? "asked" : effect === "allow" ? "allowed" : "denied")),
        `${mode}/${effect} audit`,
      );
    }
  }
});

test("hook asks are idempotent, serialize through one slot, and audit human and timeout outcomes", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  assert.ok(svc.upsertGovernancePolicy({
    policyId: "ask-all-shells",
    name: "Ask for Shells",
    effect: "ask",
    priority: 100,
    enabled: true,
    scope: { toolName: "Shell*" },
    askTimeout: 1,
  }).ok);
  const request = (toolUseId: string, toolName: string) => ({
    hookEventName: "PreToolUse" as const,
    providerSessionId: "provider-queue",
    permissionMode: "bypassPermissions",
    toolUseId,
    context: { toolName },
  });

  const first = svc.evaluatePolicyHook(id, request("tool-1", "ShellOne"), true).data!;
  const retry = svc.evaluatePolicyHook(id, request("tool-1", "ShellOne")).data!;
  assert.equal(retry.approvalRequestId, first.approvalRequestId, "lost initial response is idempotent");
  assert.equal(svc.governanceAudit(id).filter((entry) => entry.requestId === first.approvalRequestId).length, 2);

  const second = svc.evaluatePolicyHook(id, request("tool-2", "ShellTwo"), true).data!;
  assert.equal(second.decision, "ask");
  assert.equal(db.getPolicyHookApproval(id, second.approvalRequestId!)?.status, "queued");
  assert.equal(db.getSession(id)!.pendingApproval?.requestId, first.approvalRequestId);

  assert.ok(svc.approve(id, first.approvalRequestId!, "allow", { kind: "human", id: "device-a" }).ok);
  assert.equal(db.getSession(id)!.pendingApproval?.requestId, second.approvalRequestId, "oldest queued ask promoted");
  assert.equal(hub.sentOfType("resolve_permission").length, 0);

  svc.reconcilePolicyHookTimeouts(Date.now() + 2_000, id);
  assert.equal(db.getSession(id)!.pendingApproval, null);
  assert.equal(svc.evaluatePolicyHook(id, {
    ...request("tool-2", "ShellTwo"),
    approvalRequestId: second.approvalRequestId,
  }).data?.decision, "deny");
  const audit = svc.governanceAudit(id);
  assert.ok(audit.some((entry) =>
    entry.requestId === first.approvalRequestId &&
    entry.outcome === "allowed" &&
    entry.actor.id === "device-a"));
  assert.ok(audit.some((entry) =>
    entry.requestId === second.approvalRequestId &&
    entry.outcome === "timed_out" &&
    entry.actor.id === "policy-ask-timeout"));
  assert.equal(svc.approve(id, second.approvalRequestId!, "allow").status, 409, "timeout wins a late click");
});

test("live hook polling heartbeats preserve an indefinite ask and abandonment terminates it", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  assert.ok(svc.upsertGovernancePolicy({
    policyId: "ask-without-human-deadline",
    name: "Ask Without Human Deadline",
    effect: "ask",
    priority: 100,
    enabled: true,
    scope: { toolName: "IndefiniteWrite" },
  }).ok);
  const request = {
    hookEventName: "PreToolUse" as const,
    providerSessionId: "provider-indefinite",
    permissionMode: "plan",
    toolUseId: "indefinite-write-1",
    context: { toolName: "IndefiniteWrite" },
  };
  const asked = svc.evaluatePolicyHook(id, request, true).data!;
  assert.equal(asked.decision, "ask");
  assert.equal(asked.expiresAt, undefined);
  const initial = db.getPolicyHookApproval(id, asked.approvalRequestId!)!;

  let touches = 0;
  const originalTouch = db.touchPolicyHookApproval.bind(db);
  db.touchPolicyHookApproval = ((sessionId: string, requestId: string, now: number) => {
    touches++;
    return originalTouch(sessionId, requestId, now);
  }) as typeof db.touchPolicyHookApproval;
  assert.equal(svc.evaluatePolicyHook(id, {
    ...request,
    approvalRequestId: asked.approvalRequestId,
  }).data?.decision, "ask");
  assert.equal(touches, 1, "each accepted poll persists a liveness heartbeat");
  const polled = db.getPolicyHookApproval(id, asked.approvalRequestId!)!;
  assert.ok(polled.lastPolledAt >= initial.lastPolledAt);

  const laterHeartbeat = polled.lastPolledAt + POLICY_HOOK_ABANDONMENT_MS + 1_000;
  assert.equal(originalTouch(id, asked.approvalRequestId!, laterHeartbeat), true);
  svc.onSessionStatus(id, "idle");
  assert.equal(db.getSession(id)!.status, "input_required", "the hook card keeps the UI parked");
  assert.equal(db.getPolicyHookApproval(id, asked.approvalRequestId!)?.resumeStatus, "idle");
  assert.equal(
    svc.reconcilePolicyHookTimeouts(laterHeartbeat + POLICY_HOOK_ABANDONMENT_MS - 1, id),
    0,
    "a live heartbeat keeps a no-timeout approval pending",
  );
  assert.equal(db.getPolicyHookApproval(id, asked.approvalRequestId!)?.status, "pending");

  assert.equal(
    svc.reconcilePolicyHookTimeouts(laterHeartbeat + POLICY_HOOK_ABANDONMENT_MS, id),
    1,
    "the transport-failure horizon terminates an abandoned poller",
  );
  assert.equal(db.getSession(id)!.pendingApproval, null);
  assert.equal(db.getSession(id)!.status, "idle", "abandonment restores the swallowed runner settle");
  assert.equal(db.getPolicyHookApproval(id, asked.approvalRequestId!)?.status, "denied");
  assert.ok(svc.governanceAudit(id).some((entry) =>
    entry.requestId === asked.approvalRequestId &&
    entry.outcome === "aborted" &&
    entry.actor.id === "policy-hook-abandoned"));
  assert.equal(svc.evaluatePolicyHook(id, {
    ...request,
    approvalRequestId: asked.approvalRequestId,
  }).data?.decision, "deny");
  assert.equal(svc.approve(id, asked.approvalRequestId!, "allow").status, 409);
});

test("a hook timeout restores swallowed idle and immediately re-gates a tripped guardrail", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { costBudgetUsd: 1 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.upsertGovernancePolicy({
    policyId: "ask-before-budget-regate",
    name: "Ask Before Budget Re-gate",
    effect: "ask",
    priority: 100,
    enabled: true,
    scope: { toolName: "Write" },
    askTimeout: 1,
  });
  const asked = svc.evaluatePolicyHook(id, {
    hookEventName: "PreToolUse",
    providerSessionId: "provider-budget-regate",
    permissionMode: "plan",
    toolUseId: "budget-regate-tool",
    context: { toolName: "Write" },
  }, true).data!;
  svc.onSessionEvent(id, { kind: "token_usage", costUsd: 2 });
  svc.onSessionStatus(id, "idle");

  const approval = db.getPolicyHookApproval(id, asked.approvalRequestId!)!;
  assert.equal(approval.resumeStatus, "idle");
  assert.equal(svc.reconcilePolicyHookTimeouts(approval.expiresAt!, id), 1);
  assert.equal(db.getPolicyHookApproval(id, asked.approvalRequestId!)?.status, "timed_out");
  assert.equal(db.getSession(id)!.status, "input_required");
  assert.equal(db.getSession(id)!.pendingApproval?.kind, "cost_budget");
});

test("orphaned pending hook rows are re-parked before insert and queue promotion", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  assert.ok(svc.upsertGovernancePolicy({
    policyId: "ask-repair-pending",
    name: "Ask and Repair Pending",
    effect: "ask",
    priority: 100,
    enabled: true,
    scope: { toolName: "Repair*" },
  }).ok);
  const request = (toolUseId: string, toolName: string) => ({
    hookEventName: "PreToolUse" as const,
    providerSessionId: "provider-repair",
    permissionMode: "plan",
    toolUseId,
    context: { toolName },
  });
  const first = svc.evaluatePolicyHook(id, request("repair-1", "RepairOne"), true).data!;
  db.updateSessionStatus(id, "running", Date.now());

  const second = svc.evaluatePolicyHook(id, request("repair-2", "RepairTwo"), true).data!;
  assert.equal(second.decision, "ask", "inserting behind an orphaned pending row does not violate the unique index");
  assert.equal(db.getPolicyHookApproval(id, first.approvalRequestId!)?.status, "pending");
  assert.equal(db.getPolicyHookApproval(id, second.approvalRequestId!)?.status, "queued");
  assert.equal(db.getSession(id)!.pendingApproval?.requestId, first.approvalRequestId);

  db.updateSessionStatus(id, "running", Date.now());
  assert.doesNotThrow(() => svc.approvalQueue());
  assert.equal(db.getPolicyHookApproval(id, first.approvalRequestId!)?.status, "pending");
  assert.equal(db.getPolicyHookApproval(id, second.approvalRequestId!)?.status, "queued");
  assert.equal(db.getSession(id)!.pendingApproval?.requestId, first.approvalRequestId);
});

test("guardrail Continue promotes a queued hook ask even though the session settles through idle", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { costBudgetUsd: 1 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "token_usage", costUsd: 2 });
  const guardrail = db.getSession(id)!.pendingApproval!;
  assert.equal(guardrail.kind, "cost_budget");
  svc.upsertGovernancePolicy({
    policyId: "ask-write-after-budget",
    name: "Ask Write After Budget",
    effect: "ask",
    priority: 100,
    enabled: true,
    scope: { toolName: "Write" },
  });
  const asked = svc.evaluatePolicyHook(id, {
    hookEventName: "PreToolUse",
    providerSessionId: "provider-idle-queue",
    permissionMode: "plan",
    toolUseId: "write-after-budget",
    context: { toolName: "Write" },
  }, true).data!;
  assert.equal(db.getPolicyHookApproval(id, asked.approvalRequestId!)?.status, "queued");

  svc.onSessionStatus(id, "idle");
  assert.equal(db.getSession(id)!.status, "input_required");
  assert.equal(db.getPolicyHookApproval(id, asked.approvalRequestId!)?.resumeStatus, "idle");
  assert.ok(svc.approve(id, guardrail.requestId, "continue").ok);
  assert.equal(db.getSession(id)!.status, "input_required");
  assert.equal(db.getSession(id)!.pendingApproval?.kind, "policy_hook");
  assert.equal(db.getSession(id)!.pendingApproval?.requestId, asked.approvalRequestId);
  assert.ok(svc.approve(id, asked.approvalRequestId!, "allow").ok);
  assert.equal(db.getSession(id)!.status, "idle");
  assert.equal(db.getSession(id)!.pendingApproval, null);
});

test("guardrail Stop aborts queued hooks and cannot leave swallowed idle behind", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { costBudgetUsd: 1 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "token_usage", costUsd: 2 });
  const guardrail = db.getSession(id)!.pendingApproval!;
  svc.upsertGovernancePolicy({
    policyId: "ask-write-before-budget-stop",
    name: "Ask Write Before Budget Stop",
    effect: "ask",
    priority: 100,
    enabled: true,
    scope: { toolName: "Write" },
  });
  const asked = svc.evaluatePolicyHook(id, {
    hookEventName: "PreToolUse",
    providerSessionId: "provider-budget-stop",
    permissionMode: "plan",
    toolUseId: "write-before-budget-stop",
    context: { toolName: "Write" },
  }, true).data!;
  assert.equal(db.getPolicyHookApproval(id, asked.approvalRequestId!)?.status, "queued");
  svc.onSessionStatus(id, "idle");
  assert.equal(db.getPolicyHookApproval(id, asked.approvalRequestId!)?.resumeStatus, "idle");

  assert.ok(svc.approve(id, guardrail.requestId, "stop").ok);
  assert.equal(db.getSession(id)!.status, "stopped");
  assert.equal(db.listOpenPolicyHookApprovals(id).length, 0);
  assert.equal(db.getPolicyHookApproval(id, asked.approvalRequestId!)?.status, "denied");
  assert.equal(
    (db.raw().prepare("SELECT policy_resume_status FROM sessions WHERE id=?").get(id) as {
      policy_resume_status: string | null;
    }).policy_resume_status,
    null,
  );
  assert.ok(svc.governanceAudit(id).some((entry) =>
    entry.requestId === asked.approvalRequestId &&
    entry.outcome === "aborted" &&
    entry.actor.id === "guardrail-stopped"));
});

test("a hook ask is a turn-wide barrier and session termination aborts it fail-closed", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  svc.upsertGovernancePolicy({
    policyId: "ask-danger",
    name: "Ask for Danger",
    effect: "ask",
    priority: 100,
    enabled: true,
    scope: { toolName: "Danger" },
  });
  const dangerous = {
    hookEventName: "PreToolUse" as const,
    providerSessionId: "provider-barrier",
    permissionMode: "plan",
    toolUseId: "danger-1",
    context: { toolName: "Danger" },
  };
  const asked = svc.evaluatePolicyHook(id, dangerous, true).data!;
  const harmless = {
    ...dangerous,
    toolUseId: "safe-1",
    context: { toolName: "Unmatched" },
  };
  const waiting = svc.evaluatePolicyHook(id, harmless).data!;
  assert.equal(waiting.decision, "ask", "no-match invocation waits behind the suspended turn");
  assert.ok(svc.approve(id, asked.approvalRequestId!, "deny").ok);
  assert.equal(svc.evaluatePolicyHook(id, {
    ...harmless,
    approvalRequestId: waiting.approvalRequestId,
  }).data?.decision, "defer");

  const next = svc.evaluatePolicyHook(id, { ...dangerous, toolUseId: "danger-2" }, true).data!;
  svc.stop(id);
  assert.equal(svc.evaluatePolicyHook(id, {
    ...dangerous,
    toolUseId: "danger-2",
    approvalRequestId: next.approvalRequestId,
  }).status, 409);
  assert.ok(svc.governanceAudit(id).some((entry) =>
    entry.requestId === next.approvalRequestId &&
    entry.outcome === "aborted" &&
    entry.actor.id === "session-stopped"));
});

test("a provider question cannot overwrite a parked policy-hook card", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  svc.upsertGovernancePolicy({
    policyId: "ask-before-question",
    name: "Ask Before Question",
    effect: "ask",
    priority: 100,
    enabled: true,
    scope: { toolName: "Write" },
  });
  const asked = svc.evaluatePolicyHook(id, {
    hookEventName: "PreToolUse",
    providerSessionId: "provider-question-barrier",
    permissionMode: "plan",
    toolUseId: "write-before-question",
    context: { toolName: "Write" },
  }, true).data!;

  svc.onSessionEvent(id, {
    kind: "question_request",
    requestId: "parallel-question",
    questions: [{ id: "choice", question: "Which option?", options: [{ label: "A" }] }],
  });

  assert.equal(db.getSession(id)!.pendingApproval?.kind, "policy_hook");
  assert.equal(db.getSession(id)!.pendingApproval?.requestId, asked.approvalRequestId);
  assert.deepEqual(hub.sentOfType("answer_question").at(-1), {
    type: "answer_question",
    sessionId: id,
    requestId: "parallel-question",
    answers: {},
  });
  assert.ok(svc.governanceAudit(id).some((entry) =>
    entry.requestId === "parallel-question" &&
    entry.outcome === "dismissed" &&
    entry.actor.id === "policy-hook-turn-barrier"));
});

test("protocol-v65 hook asks fail closed without parking an unpollable card", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.registerRunner(runnerMeta(), Date.now(), 65);
  db.updateSessionStatus(id, "running", Date.now());
  svc.upsertGovernancePolicy({
    policyId: "ask-old-runner",
    name: "Ask on Old Runner",
    effect: "ask",
    priority: 100,
    enabled: true,
    scope: { toolName: "Write" },
  });
  for (const stableId of [true, false]) {
    for (const permissionMode of ["acceptEdits", "default", "auto", undefined] as const) {
      const result = svc.evaluatePolicyHook(id, {
        hookEventName: "PreToolUse",
        providerSessionId: "provider-old",
        ...(permissionMode ? { permissionMode } : {}),
        ...(stableId ? { toolUseId: `tool-old-${permissionMode ?? "omitted"}` } : {}),
        context: { toolName: "Write" },
      }, true);
      assert.equal(result.data?.decision, "deny", `${stableId ? "stable" : "no"} id / ${permissionMode ?? "omitted"}`);
    }
  }
  assert.equal(db.getSession(id)!.pendingApproval, null);
  const deniedResolutions = svc.governanceAudit(id).filter((entry) =>
    entry.stage === "resolution" &&
    entry.outcome === "denied");
  assert.equal(deniedResolutions.length, 8);
  assert.equal(deniedResolutions.filter((entry) =>
    entry.actor.id === "runner-upgrade-required").length, 7);
  assert.equal(deniedResolutions.filter((entry) =>
    entry.actor.id === "stable-tool-id-required").length, 1);
});

test("a later live running frame invalidates swallowed idle before a repaired hook resolves", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  svc.upsertGovernancePolicy({
    policyId: "ask-resume-invalidation-frame",
    name: "Ask Before a New Live Frame",
    effect: "ask",
    priority: 100,
    enabled: true,
    scope: { toolName: "Write" },
  });
  const request = {
    hookEventName: "PreToolUse" as const,
    providerSessionId: "provider-resume-frame",
    permissionMode: "plan" as const,
    toolUseId: "resume-frame-tool",
    context: { toolName: "Write" },
  };
  const asked = svc.evaluatePolicyHook(id, request, true).data!;
  svc.onSessionStatus(id, "idle");
  assert.equal(db.getPolicyHookApproval(id, asked.approvalRequestId!)?.resumeStatus, "idle");

  svc.onSessionStatus(id, "running");
  assert.equal(db.getPolicyHookApproval(id, asked.approvalRequestId!)?.resumeStatus, undefined);
  assert.equal(db.getSession(id)!.pendingApproval, null);
  assert.equal(svc.evaluatePolicyHook(id, {
    ...request,
    approvalRequestId: asked.approvalRequestId,
  }).data?.decision, "ask", "poll repairs the card cleared by the live frame");
  assert.ok(svc.approve(id, asked.approvalRequestId!, "allow").ok);
  assert.equal(db.getSession(id)!.status, "running");
});

test("a non-idle runtime snapshot invalidates swallowed idle before hook repair and resolution", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  svc.upsertGovernancePolicy({
    policyId: "ask-resume-invalidation-snapshot",
    name: "Ask Before a New Runtime Snapshot",
    effect: "ask",
    priority: 100,
    enabled: true,
    scope: { toolName: "Write" },
  });
  const request = {
    hookEventName: "PreToolUse" as const,
    providerSessionId: "provider-resume-snapshot",
    permissionMode: "plan" as const,
    toolUseId: "resume-snapshot-tool",
    context: { toolName: "Write" },
  };
  const asked = svc.evaluatePolicyHook(id, request, true).data!;
  svc.onSessionStatus(id, "idle");
  assert.equal(db.getPolicyHookApproval(id, asked.approvalRequestId!)?.resumeStatus, "idle");

  svc.applySessionRuntimeUpdate(RUNNER_ID, snapshot({
    id,
    status: "running",
    pendingApproval: null,
    driver: "claude-code",
    agentId: AGENT_ID,
  }));
  assert.equal(db.getPolicyHookApproval(id, asked.approvalRequestId!)?.resumeStatus, undefined);
  assert.equal(svc.evaluatePolicyHook(id, {
    ...request,
    approvalRequestId: asked.approvalRequestId,
  }).data?.decision, "ask");
  assert.ok(svc.approve(id, asked.approvalRequestId!, "allow").ok);
  assert.equal(db.getSession(id)!.status, "running");
});

test("a protocol-v66 hook without exact poll proof cannot park a fixed-rule ask", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  svc.upsertGovernancePolicy({
    policyId: "ask-unmarked-hook",
    name: "Ask on Unmarked Hook",
    effect: "ask",
    priority: 100,
    enabled: true,
    scope: { toolName: "Write" },
  });
  const result = svc.evaluatePolicyHook(id, {
    hookEventName: "PreToolUse",
    providerSessionId: "provider-unmarked",
    permissionMode: "plan",
    toolUseId: "tool-unmarked",
    context: { toolName: "Write" },
  });
  assert.equal(result.data?.decision, "deny");
  assert.equal(db.getSession(id)!.pendingApproval, null);
  assert.equal(db.listOpenPolicyHookApprovals(id).length, 0);
  assert.ok(svc.governanceAudit(id).some((entry) =>
    entry.stage === "resolution" &&
    entry.outcome === "denied" &&
    entry.actor.id === "hook-polling-unavailable"));
});

test("scoped deny policy selects the provider reject option and never parks a human card", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.upsertGovernancePolicy({
    policyId: "deny-prod-network",
    name: "Deny production network",
    effect: "deny",
    priority: 100,
    enabled: true,
    scope: { network: "https://prod.example.com/*" },
  });
  svc.onSessionEvent(id, {
    kind: "permission_request",
    requestId: "scoped-deny",
    title: "Deploy?",
    options: [
      { optionId: "yes", name: "Allow", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
    context: { toolName: "WebFetch", network: "https://prod.example.com/deploy" },
  });
  assert.equal(hub.sentOfType("resolve_permission").at(-1)?.optionId, "no");
  assert.equal(db.getSession(id)!.pendingApproval, null);
  assert.ok(svc.governanceAudit(id).some(
    (entry) => entry.requestId === "scoped-deny" && entry.stage === "resolution" && entry.outcome === "denied",
  ));
});

test("auto-resolution immediately re-parks a guardrail card displaced by the runner ask", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { costBudgetUsd: 1 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "token_usage", costUsd: 2 });
  assert.equal(db.getSession(id)!.pendingApproval?.kind, "cost_budget");
  svc.upsertGovernancePolicy({
    policyId: "allow-read",
    name: "Allow read",
    effect: "allow",
    priority: 10,
    enabled: true,
    scope: { toolName: "Read" },
  });
  svc.onSessionEvent(id, {
    kind: "permission_request",
    requestId: "auto-displaced-guardrail",
    title: "Read?",
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
    context: { toolName: "Read" },
  });
  assert.equal(hub.sentOfType("resolve_permission").at(-1)?.requestId, "auto-displaced-guardrail");
  assert.equal(db.getSession(id)!.status, "input_required");
  assert.equal(db.getSession(id)!.pendingApproval?.kind, "cost_budget");
});

test("policy auto-resolution fails safe to a human card when delivery or option shape is unusable", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.upsertGovernancePolicy({
    policyId: "allow-bash",
    name: "Allow Bash",
    effect: "allow",
    priority: 1,
    enabled: true,
    scope: { toolName: "Bash" },
  });

  svc.onSessionEvent(id, {
    kind: "permission_request",
    requestId: "missing-kind",
    title: "Run?",
    options: [{ optionId: "always", name: "Always allow", kind: "allow_always" }],
    context: { toolName: "Bash" },
  });
  assert.equal(db.getSession(id)!.pendingApproval?.requestId, "missing-kind");
  assert.equal(hub.sentOfType("resolve_permission").length, 0);
  assert.ok(svc.governanceAudit(id).some((entry) => entry.requestId === "missing-kind" && entry.outcome === "asked"));

  db.setPendingApproval(id, null);
  hub.deliver = false;
  svc.onSessionEvent(id, {
    kind: "permission_request",
    requestId: "delivery-failed",
    title: "Run?",
    options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }],
    context: { toolName: "Bash" },
  });
  assert.equal(db.getSession(id)!.pendingApproval?.requestId, "delivery-failed");
  assert.ok(svc.governanceAudit(id).some((entry) => entry.requestId === "delivery-failed" && entry.outcome === "delivery_failed"));
});

test("hard deny cancels when a provider offers only persistent or no reject option", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.upsertGovernancePolicy({
    policyId: "deny-bash",
    name: "Deny Bash",
    effect: "deny",
    priority: 10,
    enabled: true,
    scope: { toolName: "Bash" },
  });
  svc.onSessionEvent(id, {
    kind: "permission_request",
    requestId: "deny-no-once",
    title: "Run?",
    options: [{ optionId: "forever", name: "Reject forever", kind: "reject_always" }],
    context: { toolName: "Bash" },
  });
  assert.equal(hub.sentOfType("resolve_permission").at(-1)?.optionId, null);
  assert.equal(db.getSession(id)!.pendingApproval, null);
  const audit = svc.governanceAudit(id).filter((entry) => entry.requestId === "deny-no-once");
  assert.ok(audit.some((entry) => entry.stage === "policy_decision" && entry.outcome === "denied"));
  assert.ok(audit.some((entry) => entry.stage === "resolution" && entry.outcome === "denied"));
});

test("built-in conductor safety policy cannot be overridden by a stored auto-allow", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CONDUCTOR_ID });
  svc.upsertGovernancePolicy({
    policyId: "allow-all-conductor",
    name: "Attempted conductor bypass",
    effect: "allow",
    priority: 100_000,
    enabled: true,
    scope: { agentId: CONDUCTOR_ID },
  });
  svc.onSessionEvent(id, {
    kind: "permission_request",
    requestId: "conductor-gate",
    title: "Mutate repository?",
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
    context: { toolName: "mcp__manager__git_commit" },
  });
  assert.equal(hub.sentOfType("resolve_permission").length, 0);
  assert.equal(db.getSession(id)!.pendingApproval?.requestId, "conductor-gate");
  const decision = svc.governanceAudit(id).find((entry) => entry.requestId === "conductor-gate" && entry.stage === "policy_decision")!;
  assert.deepEqual([decision.outcome, decision.governancePolicyId], ["asked", "builtin:conductor-human-gate"]);
  assert.equal(svc.deleteGovernancePolicy("builtin:conductor-human-gate").status, 409);
});

test("governance policy writes reject typo-broadened selectors and support deletion", () => {
  const { svc } = makeHarness();
  const invalid = svc.upsertGovernancePolicy({
    policyId: "typo",
    name: "Typo",
    effect: "allow",
    priority: 1,
    enabled: true,
    scope: { workspaceID: WORKSPACE_ID },
  } as never);
  assert.equal(invalid.status, 400);
  const valid = svc.upsertGovernancePolicy({
    policyId: "delete-me",
    name: "Delete me",
    effect: "deny",
    priority: 1,
    enabled: true,
    scope: { runnerId: RUNNER_ID },
  });
  assert.ok(valid.ok);
  assert.ok(svc.governancePolicies().some((policy) => policy.policyId === "delete-me"));
  assert.ok(svc.deleteGovernancePolicy("delete-me").ok);
  assert.equal(svc.deleteGovernancePolicy("delete-me").status, 404);
});

test("approval queue aggregates pending asks across sessions with audit provenance and fallback", () => {
  const { db, hub, svc } = makeHarness();
  const first = seedSession(svc, hub);
  const second = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  const auth = seedSession(svc, hub, { agentId: ACP_AGENT_ID });
  const archived = seedSession(svc, hub);
  svc.onSessionEvent(first, {
    kind: "permission_request",
    requestId: "queue-a",
    title: "Run tests?",
    options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
    context: { toolName: "Bash", path: "/repos/demo/a.ts" },
  });
  const fallbackApproval = {
    requestId: "queue-legacy",
    title: "Legacy ask",
    options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
  };
  db.setPendingApproval(second, fallbackApproval);
  db.updateSessionStatus(second, "input_required", Date.now());
  svc.onSessionEvent(auth, {
    kind: "permission_request",
    requestId: "queue-auth",
    title: "Choose sign-in method",
    options: [{ optionId: "browser", name: "Browser" }],
    purpose: "authentication",
  });
  db.setPendingApproval(archived, { requestId: "queue-archived", title: "Archived ask", options: [] });
  db.updateSessionStatus(archived, "input_required", Date.now());
  db.setSessionArchived(archived, true, Date.now());

  const queue = svc.approvalQueue();
  assert.deepEqual(new Set(queue.map((item) => item.requestId)), new Set(["queue-a", "queue-legacy"]));
  assert.equal(queue.some((item) => item.requestId === "queue-auth" || item.requestId === "queue-archived"), false);
  const audited = queue.find((item) => item.requestId === "queue-a")!;
  assert.equal(audited.provenance.source, "audit");
  assert.deepEqual(audited.provenance.actor, { kind: "agent", id: AGENT_ID });
  assert.equal(audited.provenance.scope.toolName, "Bash");
  assert.equal(audited.provenance.scope.path, "/repos/demo/a.ts");
  assert.deepEqual(audited.bulkActions, ["reject"]);
  const fallback = queue.find((item) => item.requestId === "queue-legacy")!;
  assert.equal(fallback.provenance.source, "session");
  assert.equal(fallback.runnerOnline, true);
});

test("inline review findings are stale-safe, bundle through the owning session, and gate publish completion", async () => {
  const { db, hub, svc } = makeHarness();
  const sessionId = seedSession(svc, hub);
  db.setWorktreePath(sessionId, `/worktrees/${sessionId}`);
  db.updateSessionStatus(sessionId, "idle", Date.now());
  const base = {
    scope: "uncommitted",
    diffHash: "a".repeat(64),
    filePath: "src/example.ts",
    side: "right",
    line: 12,
    body: "Preserve the retry invariant.",
    severity: "major",
    required: true,
  } as const;
  const required = svc.createReviewFinding(sessionId, base, { kind: "human", id: "device-1" });
  assert.equal(required.status, 201);
  const optional = svc.createReviewFinding(sessionId, {
    ...base, line: 18, body: "Clarify this name.", severity: "nit", required: false,
  }, { kind: "human", id: "device-2" });
  assert.equal(optional.ok, true);
  const findings = svc.reviewFindings(sessionId).data!;
  assert.equal(findings.summary.completion, "blocked");
  assert.deepEqual(new Set(findings.findings.map((finding) => finding.author.id)), new Set(["device-1", "device-2"]));

  const first = findings.findings[0]!;
  assert.equal(svc.updateReviewFinding(sessionId, first.findingId, {
    status: "resolved", expectedUpdatedAt: first.updatedAt - 1,
  }).status, 409);

  const bundled = svc.bundleReviewFindings(sessionId, {
    findings: findings.findings.map((finding) => ({ findingId: finding.findingId, expectedUpdatedAt: finding.updatedAt })),
  });
  assert.equal(bundled.ok, true, bundled.error);
  assert.equal(bundled.data!.summary.sent, 2);
  const prompt = hub.sentOfType("prompt_session").at(-1);
  assert.match(prompt?.text ?? "", /\[REQUIRED\] \[MAJOR\] src\/example\.ts:12/);
  assert.match(prompt?.text ?? "", /\[OPTIONAL\] \[NIT\] src\/example\.ts:18/);

  db.updateSessionStatus(sessionId, "idle", Date.now());
  hub.requestHandler = (msg) => {
    assert.equal(msg.type, "git_action");
    if (msg.type !== "git_action") throw new Error("unexpected request");
    return {
      type: "git_result",
      requestId: msg.requestId,
      ok: true,
      data: { summary: {
        branch: "codex/change", ahead: 0, behind: 0, hasChanges: false,
        addedLines: 0, deletedLines: 0, remoteUrl: null, pr: null, checks: null,
      } },
    };
  };
  let queue = await svc.reviewQueue();
  assert.equal(queue[0]?.sessionId, sessionId);
  assert.equal(queue[0]?.completion, "blocked");
  assert.deepEqual(queue[0]?.blockers, [{ kind: "findings_required", count: 1 }]);

  const sentFindings = svc.reviewFindings(sessionId).data!.findings;
  const requiredSent = sentFindings.find((finding) => finding.required)!;
  const resolvedRequired = svc.updateReviewFinding(sessionId, requiredSent.findingId, {
    status: "resolved", expectedUpdatedAt: requiredSent.updatedAt,
  }, { kind: "human", id: "reviewer" });
  assert.equal(resolvedRequired.ok, true);
  queue = await svc.reviewQueue();
  assert.equal(queue[0]?.completion, "needs_review", "optional unresolved feedback remains visible without blocking publish");
  assert.deepEqual(queue[0]?.blockers, []);

  const optionalSent = svc.reviewFindings(sessionId).data!.findings.find((finding) => !finding.required)!;
  assert.equal(svc.updateReviewFinding(sessionId, optionalSent.findingId, {
    status: "dismissed", expectedUpdatedAt: optionalSent.updatedAt,
  }).ok, true);
  assert.deepEqual(await svc.reviewQueue(), [], "a quiet session leaves the queue once every finding is terminal");
});

test("GitHub review findings can be bundled to the agent but cannot be resolved locally", () => {
  const { db, hub, svc } = makeHarness();
  const sessionId = seedSession(svc, hub);
  db.setWorktreePath(sessionId, `/worktrees/${sessionId}`);
  db.updateSessionStatus(sessionId, "idle", Date.now());
  const sync = svc.reconcileGitHubReviewFindings(sessionId, {
    repository: "acme/repo",
    pullRequestNumber: 7,
    pullRequestUrl: "https://github.com/acme/repo/pull/7",
    pullRequestHeadOid: "a".repeat(40),
    pullRequestBaseOid: "e".repeat(40),
    localHeadOid: "a".repeat(40),
    diffHash: "d".repeat(64),
    synchronizedAt: 2_000,
    threads: [{
      threadId: "PRRT_1", commentId: 101,
      url: "https://github.com/acme/repo/pull/7#discussion_r101",
      path: "src/a.ts", side: "right", line: 4, body: "Remote issue", author: "reviewer",
      createdAt: 1_000, updatedAt: 1_100, commitId: "b".repeat(40), subjectType: "line", resolved: false, outdated: false,
    }],
  });
  assert.equal(sync.ok, true);
  const finding = sync.data!.findings[0]!;
  const localResolve = svc.updateReviewFinding(sessionId, finding.findingId, {
    status: "resolved", expectedUpdatedAt: finding.updatedAt,
  });
  assert.equal(localResolve.status, 409);
  assert.match(localResolve.error ?? "", /remote-owned/);

  const bundled = svc.bundleReviewFindings(sessionId, {
    findings: [{ findingId: finding.findingId, expectedUpdatedAt: finding.updatedAt }],
  });
  assert.equal(bundled.ok, true, bundled.error);
  assert.match(hub.sentOfType("prompt_session").at(-1)?.text ?? "", /Remote issue/);
});

test("review queue combines live changes, approvals, checks, and the latest reviewer verdict", async () => {
  const { db, hub, svc } = makeHarness();
  const needsReview = seedSession(svc, hub);
  const blocked = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  const ready = seedSession(svc, hub, { agentId: ACP_AGENT_ID });
  const quiet = seedSession(svc, hub);
  const unavailable = seedSession(svc, hub);
  const permissionAllowed = seedSession(svc, hub);
  for (const id of [needsReview, blocked, ready, quiet, unavailable, permissionAllowed]) {
    db.setWorktreePath(id, `/worktrees/${id}`);
    db.updateSessionStatus(id, "idle", Date.now());
  }

  db.setPendingApproval(blocked, {
    requestId: "review-approval",
    title: "Approve deploy",
    options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
  });
  db.updateSessionStatus(blocked, "input_required", Date.now());
  db.appendEvent(blocked, {
    kind: "review_decision",
    reviewId: "review-obsolete",
    reviewer: { kind: "agent", id: "guardian" },
    outcome: "allowed",
  }, 900);
  db.appendEvent(blocked, {
    kind: "review_decision",
    reviewId: "review-blocked",
    reviewer: { kind: "agent", id: "guardian" },
    outcome: "denied",
    riskLevel: "high",
    rationale: "Unsafe change",
  }, 1_000);
  db.appendEvent(ready, {
    kind: "review_decision",
    reviewId: "review-ready",
    reviewer: { kind: "agent", id: "guardian" },
    outcome: "allowed",
    riskLevel: "low",
  }, 2_000);
  db.appendEvent(permissionAllowed, {
    kind: "review_decision",
    reviewId: "review-one-command",
    requestId: "provider-permission",
    reviewer: { kind: "agent", id: "guardian" },
    outcome: "allowed",
    riskLevel: "low",
  }, 2_100);

  const summary = (overrides: Partial<GitSummaryInfo> = {}): GitSummaryInfo => ({
    branch: "codex/change",
    ahead: 0,
    behind: 0,
    hasChanges: false,
    addedLines: 0,
    deletedLines: 0,
    remoteUrl: "https://github.com/example/repo",
    pr: null,
    checks: null,
    ...overrides,
  });
  const summaries = new Map([
    [needsReview, summary({ hasChanges: true, addedLines: 4 })],
    [blocked, summary({
      ahead: 1,
      pr: { number: 12, title: "Blocked", url: "https://github.com/example/repo/pull/12", state: "OPEN" },
      checks: { failing: 2, pending: 1, passing: 3, failingNames: ["test", "lint"], url: null },
    })],
    [ready, summary({
      pr: { number: 13, title: "Ready", url: "https://github.com/example/repo/pull/13", state: "OPEN" },
      checks: { failing: 0, pending: 0, passing: 5, failingNames: [], url: null },
    })],
    [permissionAllowed, summary({ hasChanges: true })],
    [quiet, summary()],
  ]);
  hub.requestHandler = (msg) => {
    assert.equal(msg.type, "git_action");
    if (msg.type !== "git_action") throw new Error("unexpected request");
    return {
      type: "git_result",
      requestId: msg.requestId,
      ok: true,
      data: { summary: summaries.get(msg.sessionId)! },
    };
  };

  const queue = await svc.reviewQueue();
  assert.deepEqual(new Set(queue.map((item) => item.sessionId)), new Set([needsReview, blocked, ready, unavailable, permissionAllowed]));
  assert.equal(queue[0]!.completion, "blocked", "blocked work sorts before needs-review and ready work");
  assert.deepEqual(queue.find((item) => item.sessionId === needsReview)!.blockers, [
    { kind: "review_incomplete", count: 1 },
  ]);
  assert.equal(queue.find((item) => item.sessionId === needsReview)!.completion, "needs_review");
  assert.deepEqual(queue.find((item) => item.sessionId === blocked)!.blockers.map((item) => item.kind), [
    "approval_pending",
    "checks_failing",
    "checks_pending",
    "review_denied",
  ]);
  assert.equal(queue.find((item) => item.sessionId === blocked)!.reviewerVerdict?.reviewId, "review-blocked");
  assert.equal(queue.find((item) => item.sessionId === ready)!.completion, "ready");
  assert.equal(queue.find((item) => item.sessionId === permissionAllowed)!.completion, "needs_review");
  assert.deepEqual(queue.find((item) => item.sessionId === unavailable)!.blockers, [
    { kind: "git_unavailable", count: 1 },
  ]);
});

test("review queue requests primary-checkout summaries without a caller-selected path", async () => {
  const { db, hub, svc } = makeHarness();
  const sessionId = seedSession(svc, hub, { useWorktree: false });
  db.updateSessionStatus(sessionId, "idle", Date.now());
  hub.requestHandler = (message) => {
    assert.equal(message.type, "git_action");
    if (message.type !== "git_action") throw new Error("unexpected request");
    assert.equal(message.sessionId, sessionId);
    assert.equal(message.action.kind, "summary");
    assert.equal(message.worktreePath, undefined);
    return {
      type: "git_result",
      requestId: message.requestId,
      ok: true,
      data: {
        summary: {
          branch: "main",
          ahead: 0,
          behind: 0,
          hasChanges: true,
          addedLines: 1,
          deletedLines: 0,
          remoteUrl: null,
          pr: null,
          checks: null,
        },
      },
    };
  };

  const queue = await svc.reviewQueue();
  assert.equal(queue[0]?.sessionId, sessionId);
  assert.equal(queue[0]?.summary?.branch, "main");

  db.registerRunner(runnerMeta(), Date.now(), 75);
  let requestedFromOldRunner = false;
  hub.requestHandler = () => {
    requestedFromOldRunner = true;
    throw new Error("pre-v76 primary summary must not be requested");
  };
  assert.deepEqual(await svc.reviewQueue(), []);
  assert.equal(requestedFromOldRunner, false);
});

test("review queue deduplicates primary checkouts and bounds per-runner Git fanout", async () => {
  const cleanSummary: GitSummaryInfo = {
    branch: "main", ahead: 0, behind: 0, hasChanges: false,
    addedLines: 0, deletedLines: 0, remoteUrl: null, pr: null, checks: null,
  };
  const primary = makeHarness();
  for (let index = 0; index < 6; index++) {
    const id = seedSession(primary.svc, primary.hub, { useWorktree: false, title: `Primary ${index}` });
    primary.db.updateSessionStatus(id, "idle", Date.now() + index);
  }
  let primaryRequests = 0;
  primary.hub.requestHandler = (message) => {
    if (message.type !== "git_action") throw new Error("unexpected request");
    primaryRequests++;
    return { type: "git_result", requestId: message.requestId, ok: true, data: { summary: cleanSummary } };
  };
  const [firstPrimary, concurrentPrimary] = await Promise.all([
    primary.svc.reviewQueue(),
    primary.svc.reviewQueue(),
  ]);
  assert.deepEqual(firstPrimary, []);
  assert.deepEqual(concurrentPrimary, []);
  assert.equal(primaryRequests, 1, "one runner-authoritative primary checkout is sampled once per workspace");

  const linked = makeHarness();
  for (let index = 0; index < 20; index++) {
    const id = seedSession(linked.svc, linked.hub, { useWorktree: true, title: `Linked ${index}` });
    linked.db.setWorktreePath(id, `/worktrees/linked-${index}`);
    linked.db.updateSessionStatus(id, "idle", Date.now() + index);
  }
  let linkedRequests = 0;
  const linkedSessionIds: string[] = [];
  linked.hub.requestHandler = (message) => {
    if (message.type !== "git_action") throw new Error("unexpected request");
    linkedRequests++;
    linkedSessionIds.push(message.sessionId);
    return { type: "git_result", requestId: message.requestId, ok: true, data: { summary: cleanSummary } };
  };
  assert.deepEqual(await linked.svc.reviewQueue(), []);
  assert.equal(linkedRequests, 12, "one refresh cannot fan out beyond the per-runner sample budget");
  linkedRequests = 0;
  await linked.svc.reviewQueue();
  assert.equal(linkedRequests, 12);
  assert.equal(new Set(linkedSessionIds).size, 20, "the bounded window rotates so every checkout is eventually sampled");
});

test("review queue deduplicates primary samples by execution path after a session is re-filed", async () => {
  const { db, hub, svc } = makeHarness();
  const moved = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    workspacePath: "/repos/adhoc",
    agentId: AGENT_ID,
    useWorktree: false,
  });
  assert.ok(moved.ok && moved.data);
  const movedId = moved.data!.id;
  assert.equal(db.getAdHocWorkspacePath(movedId), "/repos/adhoc");
  assert.ok(svc.setWorkspace(movedId, WORKSPACE_ID).ok);

  const workspaceId = seedSession(svc, hub, { useWorktree: false });
  for (const id of [movedId, workspaceId]) db.updateSessionStatus(id, "idle", Date.now());

  const requested: string[] = [];
  hub.requestHandler = (message) => {
    if (message.type !== "git_action") throw new Error("unexpected request");
    requested.push(message.sessionId);
    return {
      type: "git_result",
      requestId: message.requestId,
      ok: true,
      data: {
        summary: {
          branch: message.sessionId === movedId ? "adhoc-branch" : "workspace-branch",
          ahead: 0,
          behind: 0,
          hasChanges: true,
          addedLines: 1,
          deletedLines: 0,
          remoteUrl: null,
          pr: null,
          checks: null,
        },
      },
    };
  };

  const queue = await svc.reviewQueue();
  assert.deepEqual(new Set(requested), new Set([movedId, workspaceId]));
  assert.equal(queue.find((item) => item.sessionId === movedId)?.summary?.branch, "adhoc-branch");
  assert.equal(queue.find((item) => item.sessionId === workspaceId)?.summary?.branch, "workspace-branch");
});

test("review queue distinguishes no repository, failed sampling, and budget truncation", async () => {
  const noRepo = makeHarness();
  const noRepoId = seedSession(noRepo.svc, noRepo.hub, { useWorktree: false });
  noRepo.db.updateSessionStatus(noRepoId, "idle", Date.now());
  noRepo.hub.requestHandler = (message) => {
    if (message.type !== "git_action") throw new Error("unexpected request");
    return {
      type: "git_result", requestId: message.requestId, ok: false,
      code: "GIT_NO_REPOSITORY", error: "not the authoritative repository root",
    };
  };
  assert.deepEqual(await noRepo.svc.reviewQueue(), [], "a session without a Git surface is not actionable review work");
  noRepo.hub.online = false;
  assert.deepEqual(
    await noRepo.svc.reviewQueue(),
    [],
    "an authoritative no-repository result remains non-actionable while its runner is offline",
  );
  noRepo.hub.online = true;
  assert.ok(noRepo.svc.restart(noRepoId).ok);
  noRepo.db.updateSessionStatus(noRepoId, "idle", Date.now());
  let restartedRequests = 0;
  noRepo.hub.requestHandler = (message) => {
    if (message.type !== "git_action") throw new Error("unexpected request");
    restartedRequests++;
    return {
      type: "git_result",
      requestId: message.requestId,
      ok: true,
      data: { summary: {
        branch: "main", ahead: 0, behind: 0, hasChanges: false,
        addedLines: 0, deletedLines: 0, remoteUrl: null, pr: null, checks: null,
      } },
    };
  };
  assert.deepEqual(await noRepo.svc.reviewQueue(), []);
  assert.equal(restartedRequests, 1, "restart invalidates the remembered repository classification");

  const noRepoBudget = makeHarness();
  for (let index = 0; index < 10; index++) {
    const result = noRepoBudget.svc.createSession({
      runnerId: RUNNER_ID,
      workspaceId: WORKSPACE_ID,
      workspacePath: `/repos/no-repository-${index}`,
      agentId: AGENT_ID,
      useWorktree: false,
    });
    assert.ok(result.ok && result.data);
    noRepoBudget.db.updateSessionStatus(result.data!.id, "idle", Date.now() + index);
  }
  noRepoBudget.hub.requestHandler = (message) => {
    if (message.type !== "git_action") throw new Error("unexpected request");
    return {
      type: "git_result", requestId: message.requestId, ok: false,
      code: "GIT_NO_REPOSITORY", error: "not the authoritative repository root",
    };
  };
  assert.deepEqual(await noRepoBudget.svc.reviewQueue(), []);
  const repoBacked = new Set<string>();
  for (let index = 0; index < 12; index++) {
    const id = seedSession(noRepoBudget.svc, noRepoBudget.hub, { useWorktree: true, title: `Repo ${index}` });
    noRepoBudget.db.setWorktreePath(id, `/worktrees/repo-${index}`);
    noRepoBudget.db.updateSessionStatus(id, "idle", Date.now() + 100 + index);
    repoBacked.add(id);
  }
  const sampledRepoBacked = new Set<string>();
  noRepoBudget.hub.requestHandler = (message) => {
    if (message.type !== "git_action") throw new Error("unexpected request");
    sampledRepoBacked.add(message.sessionId);
    return {
      type: "git_result", requestId: message.requestId, ok: true,
      data: { summary: {
        branch: "main", ahead: 0, behind: 0, hasChanges: false,
        addedLines: 0, deletedLines: 0, remoteUrl: null, pr: null, checks: null,
      } },
    };
  };
  assert.deepEqual(await noRepoBudget.svc.reviewQueue(), []);
  assert.deepEqual(sampledRepoBacked, repoBacked, "known non-repositories no longer consume the sample budget");

  const capped = makeHarness();
  const ids: string[] = [];
  for (let index = 0; index < 14; index++) {
    const id = seedSession(capped.svc, capped.hub, { useWorktree: true, title: `Priority ${index}` });
    capped.db.setWorktreePath(id, `/worktrees/priority-${index}`);
    capped.db.updateSessionStatus(id, "idle", Date.now() + index);
    capped.db.setPendingApproval(id, {
      requestId: `approval-${index}`,
      title: "Approve review",
      options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
    });
    ids.push(id);
  }
  capped.hub.requestHandler = (message) => {
    if (message.type !== "git_action") throw new Error("unexpected request");
    return {
      type: "git_result", requestId: message.requestId, ok: true,
      data: { summary: { branch: "main", ahead: 0, behind: 0, hasChanges: false,
        addedLines: 0, deletedLines: 0, remoteUrl: null, pr: null, checks: null } },
    };
  };
  const queue = await capped.svc.reviewQueue();
  const notSampled = queue.filter((item) => item.summaryState === "not_sampled");
  assert.equal(notSampled.length, 2);
  assert.ok(notSampled.every((item) => !item.blockers.some((blocker) => blocker.kind === "git_unavailable")));
  assert.ok(queue.filter((item) => item.summaryState === "available")
    .every((item) => !item.blockers.some((blocker) => blocker.kind === "git_unavailable")));
});

test("bulk queue rejection is stale-safe, selects only reject_once, and attributes the device", () => {
  const { db, hub, svc } = makeHarness();
  const permission = seedSession(svc, hub);
  const question = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  const authentication = seedSession(svc, hub, { agentId: ACP_AGENT_ID });
  svc.onSessionEvent(permission, {
    kind: "permission_request",
    requestId: "bulk-permission",
    title: "Deploy?",
    options: [
      { optionId: "allow-forever", name: "Always allow", kind: "allow_always" },
      { optionId: "deny-once", name: "Reject", kind: "reject_once" },
      { optionId: "deny-forever", name: "Always reject", kind: "reject_always" },
    ],
  });
  svc.onSessionEvent(question, {
    kind: "question_request",
    requestId: "bulk-question",
    questions: [{ id: "choice", question: "Choose?", options: [{ label: "A" }] }],
  });
  svc.onSessionEvent(authentication, {
    kind: "permission_request",
    requestId: "bulk-auth",
    title: "Sign in",
    options: [{ optionId: "browser", name: "Browser" }],
    purpose: "authentication",
  });

  const result = svc.rejectApprovalQueue([
    { sessionId: permission, requestId: "bulk-permission" },
    { sessionId: question, requestId: "bulk-question" },
    { sessionId: authentication, requestId: "bulk-auth" },
    { sessionId: "missing-session", requestId: "stale" },
  ], { kind: "human", id: "device-bulk" });
  assert.ok(result.ok);
  assert.deepEqual(result.data!.results.map((item) => [item.requestId, item.ok, item.status]), [
    ["bulk-permission", true, 200],
    ["bulk-question", true, 200],
    ["bulk-auth", false, 409],
    ["stale", false, 409],
  ]);
  assert.equal(hub.sentOfType("resolve_permission").at(-1)?.optionId, "deny-once");
  assert.deepEqual(hub.sentOfType("answer_question").at(-1)?.answers, {});
  assert.equal(db.getSession(permission)!.pendingApproval, null);
  assert.equal(db.getSession(question)!.pendingApproval, null);
  assert.equal(db.getSession(authentication)!.pendingApproval?.requestId, "bulk-auth");
  const resolution = svc.governanceAudit(permission).find(
    (entry) => entry.requestId === "bulk-permission" && entry.stage === "resolution",
  )!;
  assert.deepEqual(resolution.actor, { kind: "human", id: "device-bulk" });
  assert.equal(resolution.outcome, "denied");
});

test("bulk queue validation is atomic and rejects duplicates/unsupported fields", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.setPendingApproval(id, { requestId: "still-pending", title: "Ask", options: [] });
  db.updateSessionStatus(id, "input_required", Date.now());
  const before = hub.sentToRunner.length;
  const duplicate = svc.rejectApprovalQueue([
    { sessionId: id, requestId: "still-pending" },
    { sessionId: id, requestId: "still-pending" },
  ]);
  assert.equal(duplicate.status, 400);
  assert.equal(hub.sentToRunner.length, before);
  assert.equal(db.getSession(id)!.pendingApproval?.requestId, "still-pending");
  assert.equal(svc.rejectApprovalQueue([{ sessionId: id, requestId: "still-pending", action: "allow" }]).status, 400);
});

test("workflow artifact service validates ownership, binds run membership, and broadcasts run updates", () => {
  const { db, hub, svc } = makeHarness();
  const created = svc.createRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentIds: [AGENT_ID],
    task: "Build and review",
  });
  assert.ok(created.ok);
  const run = created.data!.run;
  const session = created.data!.sessions[0]!;
  const broadcastsBefore = hub.runChangedCalls.length;
  const result = svc.createWorkflowArtifact({
    runId: run.id,
    sessionId: session.id,
    kind: "verdict",
    name: "review-verdict.json",
    mimeType: "application/json",
    encoding: "json",
    data: '{ "verdict": "upvote", "round": 1 }',
    metadata: { reviewer: "codex", round: 1 },
  }, { kind: "human", id: "device-artifacts" });
  assert.equal(result.status, 201);
  const artifact = result.data!;
  assert.equal(artifact.data, '{"verdict":"upvote","round":1}');
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(artifact.createdBy, { kind: "human", id: "device-artifacts" });
  assert.equal(hub.runChangedCalls.length, broadcastsBefore + 1);
  assert.deepEqual(svc.workflowArtifact(artifact.artifactId).data, artifact);
  const listed = svc.runWorkflowArtifacts(run.id).data!.artifacts;
  assert.equal(listed.length, 1);
  assert.equal("data" in listed[0]!, false);
  assert.equal(svc.sessionWorkflowArtifacts(session.id).data!.artifacts[0]!.artifactId, artifact.artifactId);
  assert.ok(db.getRun(run.id)!.updatedAt >= artifact.createdAt);
  for (const name of ["tests-1.log", "tests-2.log"]) {
    assert.ok(svc.createWorkflowArtifact({
      runId: run.id,
      sessionId: session.id,
      kind: "test_log",
      name,
      mimeType: "text/plain",
      encoding: "utf8",
      data: `${name}: passed`,
    }).ok);
  }
  const firstPage = svc.runWorkflowArtifacts(run.id, undefined, 2).data!;
  assert.equal(firstPage.artifacts.length, 2);
  assert.ok(firstPage.nextCursor);
  const secondPage = svc.runWorkflowArtifacts(run.id, firstPage.nextCursor, 2).data!;
  assert.equal(secondPage.artifacts.length, 1);
  assert.equal(secondPage.nextCursor, undefined);
  assert.equal(new Set([...firstPage.artifacts, ...secondPage.artifacts].map((item) => item.artifactId)).size, 3);
  assert.equal(svc.runWorkflowArtifacts(run.id, "not-a-cursor").status, 400);
  assert.equal(svc.runWorkflowArtifacts(run.id, undefined, 101).status, 400);
});

test("workflow artifact service rejects cross-run association, unknown owners, and malformed content", () => {
  const { hub, svc } = makeHarness();
  const run = svc.createRun({ runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentIds: [AGENT_ID], task: "Run" }).data!.run;
  const outsider = seedSession(svc, hub);
  const body = {
    runId: run.id,
    sessionId: outsider,
    kind: "test_log",
    name: "tests.log",
    mimeType: "text/plain",
    encoding: "utf8",
    data: "ok",
  };
  assert.equal(svc.createWorkflowArtifact(body).status, 409);
  assert.equal(svc.createWorkflowArtifact({ ...body, runId: "missing" }).status, 404);
  assert.equal(svc.createWorkflowArtifact({ ...body, runId: undefined, sessionId: "missing" }).status, 404);
  assert.equal(svc.createWorkflowArtifact({ ...body, runId: undefined, sessionId: outsider, name: "../escape" }).status, 400);
  assert.equal(svc.workflowArtifact("missing").status, 404);
  assert.equal(svc.runWorkflowArtifacts("missing").status, 404);
  assert.equal(svc.sessionWorkflowArtifacts("missing").status, 404);
});

test("governance audit distinguishes authentication, question answers, and policy decisions", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);

  svc.onSessionEvent(id, {
    kind: "permission_request",
    requestId: "auth-1",
    title: "Sign in",
    options: [{ optionId: "browser", name: "Browser" }],
    purpose: "authentication",
  });
  assert.equal(db.getSession(id)!.pendingApproval?.kind, "authentication");
  svc.approve(id, "auth-1", "browser");

  svc.onSessionEvent(id, {
    kind: "question_request",
    requestId: "question-1",
    questions: [{ id: "color", question: "Choose a color", options: [{ label: "Blue" }] }],
  });
  svc.answerQuestion(id, "question-1", { color: "Blue" }, { kind: "human", id: "device-9" });

  svc.setConfig(id, { costBudgetUsd: 1 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "token_usage", costUsd: 2 });
  const policy = db.getSession(id)!.pendingApproval!;
  svc.approve(id, policy.requestId, "continue", { kind: "human", id: "device-9" });

  const entries = svc.governanceAudit(id);
  const authRequest = entries.find((entry) => entry.requestId === "auth-1" && entry.stage === "request")!;
  assert.equal(authRequest.approvalKind, "authentication");
  const answer = entries.find((entry) => entry.requestId === "question-1" && entry.stage === "resolution")!;
  assert.equal(answer.outcome, "answered");
  assert.match(answer.contentDigest ?? "", /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(answer).includes("Blue"), false);
  const policyAsk = entries.find((entry) => entry.stage === "policy_decision")!;
  assert.equal(policyAsk.outcome, "asked");
  assert.deepEqual(policyAsk.actor, { kind: "policy", id: "cost_budget" });
  assert.deepEqual(policyAsk.policyRule, { kind: "cost_budget", budgetUsd: 1 });
  const policyResolution = entries.find((entry) => entry.requestId === policy.requestId && entry.stage === "resolution")!;
  assert.equal(policyResolution.outcome, "allowed");
});

test("approve fails 409 when there is no pending approval (stale/duplicate click)", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  const before = hub.sentToRunner.length;

  const res = svc.approve(id, "req-1", "opt-1");
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  // Nothing forwarded to the runner; session untouched.
  assert.equal(hub.sentToRunner.length, before);
});

test("approve fails 409 when the requestId does not match the pending one", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.setPendingApproval(id, { requestId: "req-1", title: "t", options: [] });
  db.updateSessionStatus(id, "input_required", Date.now());
  const before = hub.sentToRunner.length;

  const res = svc.approve(id, "req-STALE", "opt-1");
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.equal(hub.sentToRunner.length, before);
  // The real pending approval is preserved and the session stays parked.
  const stored = db.getSession(id)!;
  assert.ok(stored.pendingApproval);
  assert.equal(stored.status, "input_required");
});

/* -------------------------------------------------------------------------- */
/* stop / restart                                                            */
/* -------------------------------------------------------------------------- */

test("stop sends stop_session and marks the session stopped", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);

  const res = svc.stop(id);
  assert.ok(res.ok);

  const msg = hub.sentOfType("stop_session").at(-1)!;
  assert.equal(msg.sessionId, id);
  assert.equal(db.getSession(id)!.status, "stopped");
  assert.ok(hub.sessionChangedByIdCalls.includes(id));
});

test("stop fails 404 for an unknown session", () => {
  const { svc } = makeHarness();
  const res = svc.stop("nope");
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
});

test("cancelTurn uses the v72 live coordinate and requires an applied runner acknowledgement", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.appendEvent(id, { kind: "user_message", text: "active", turnId: "turn-active" }, Date.now());
  db.updateSessionStatus(id, "running", Date.now());
  hub.activeTurnIds.set(id, "turn-live");
  const before = db.getSession(id)!.status;

  const result = await svc.cancelTurn(id);

  assert.ok(result.ok);
  assert.deepEqual(hub.sentOfType("interrupt_turn").at(-1), {
    type: "interrupt_turn",
    requestId: hub.sentOfType("interrupt_turn").at(-1)!.requestId,
    sessionId: id,
    turnId: "turn-live",
  });
  assert.equal(hub.sentOfType("cancel_session").length, 0);
  assert.equal(db.getSession(id)!.status, before);
});

test("cancelTurn remains compatible with the uncorrelated v71 interruption contract", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.appendEvent(id, { kind: "user_message", text: "legacy active turn" }, Date.now());
  db.updateSessionStatus(id, "running", Date.now());
  db.registerRunner(runnerMeta(), Date.now(), 71);

  assert.ok((await svc.cancelTurn(id)).ok);
  assert.deepEqual(hub.sentOfType("interrupt_turn").at(-1), {
    type: "interrupt_turn", sessionId: id,
  });
});

test("cancelTurn rejects a v72 running snapshot without a live runner coordinate", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.appendEvent(id, { kind: "user_message", text: "stale transcript", turnId: "turn-stale" }, Date.now());
  db.updateSessionStatus(id, "running", Date.now());

  const result = await svc.cancelTurn(id);

  assert.equal(result.status, 409);
  assert.match(result.error ?? "", /no active turn/i);
  assert.equal(hub.sentOfType("interrupt_turn").length, 0);
});

test("cancelTurn surfaces a stale v72 runner rejection instead of claiming success", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  hub.activeTurnIds.set(id, "turn-a");
  hub.requestHandler = (msg) => {
    assert.equal(msg.type, "interrupt_turn");
    return {
      type: "interrupt_turn_result",
      requestId: msg.requestId!,
      sessionId: id,
      applied: false,
      reason: "stale_turn",
    };
  };

  const result = await svc.cancelTurn(id);

  assert.equal(result.status, 409);
  assert.match(result.error ?? "", /active turn changed/i);
});

test("cancelTurn rejects a parked policy decision without contacting the runner", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "input_required", Date.now());
  db.setPendingApproval(id, {
    kind: "cost_budget",
    requestId: "budget-1",
    title: "Cost Budget Reached",
    options: [],
  });
  hub.activeTurnIds.set(id, "turn-policy");

  const result = await svc.cancelTurn(id);

  assert.equal(result.status, 409);
  assert.match(result.error ?? "", /guardrail decision/i);
  assert.equal(hub.sentOfType("interrupt_turn").length, 0);
});

test("cancelTurn is an idempotent no-op when no turn is active", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "idle", Date.now());
  const before = hub.sentOfType("interrupt_turn").length;

  assert.ok((await svc.cancelTurn(id)).ok);
  assert.ok((await svc.cancelTurn(id)).ok);
  assert.equal(hub.sentOfType("interrupt_turn").length, before);
});

test("cancelTurn rejects queued and starting launches instead of discarding their initial prompt", async () => {
  for (const status of ["queued", "starting"] as const) {
    const { db, hub, svc } = makeHarness();
    const id = seedSession(svc, hub);
    db.updateSessionStatus(id, status, Date.now());

    const result = await svc.cancelTurn(id);

    assert.equal(result.status, 409, status);
    assert.match(result.error ?? "", /only after the active turn starts/i);
    assert.equal(hub.sentOfType("interrupt_turn").length, 0);
  }
});

test("cancelTurn rejects workflow-owned sessions so an interruption cannot advance partial output", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  const original = db.activeWorkflowAttemptsForSession.bind(db);
  Object.defineProperty(db, "activeWorkflowAttemptsForSession", {
    configurable: true,
    value: (sessionId: string) => sessionId === id ? [{ attemptId: "attempt-1" }] : original(sessionId),
  });

  const result = await svc.cancelTurn(id);

  assert.equal(result.status, 409);
  assert.match(result.error ?? "", /workflow-owned sessions/i);
  assert.equal(hub.sentOfType("interrupt_turn").length, 0);
});

test("cancelTurn rejects the active auto-orchestrated pod member so truncated output cannot advance", async () => {
  const { db, hub, svc } = makeHarness();
  const first = seedReadyPodSession(db, svc, hub, "Lead");
  const second = seedReadyPodSession(db, svc, hub, "Builder");
  const pod = svc.createPod({ title: "Interrupt Guard", sessionIds: [first, second] }).data!.pod;
  assert.ok(svc.updatePodOrchestration(pod.id, {
    mode: "round_robin",
    contextTokenBudget: 4096,
    summaryTokenBudget: 128,
    maxTurns: 2,
    maxRepeatedOutputs: 2,
  }).ok);
  assert.equal(svc.startPodOrchestration(pod.id, { instruction: "Start", firstSessionId: first }, "device-1").status, 201);
  hub.sentToRunner.length = 0;

  const result = await svc.cancelTurn(first);

  assert.equal(result.status, 409);
  assert.match(result.error ?? "", /pod-orchestrated sessions/i);
  assert.equal(hub.sentOfType("interrupt_turn").length, 0);
  assert.equal(db.getPod(pod.id)?.orchestration?.state.currentSessionId, first);

  db.updateSessionStatus(second, "running", Date.now());
  hub.activeTurnIds.set(second, "turn-second");
  assert.ok((await svc.cancelTurn(second)).ok, "pod membership alone does not block a non-current member");
  assert.equal(hub.sentOfType("interrupt_turn").at(-1)?.sessionId, second);
});

test("a new control plane fails closed instead of sending interrupt_turn to a v70 runner", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  db.registerRunner(runnerMeta(), Date.now(), 70);

  const result = await svc.cancelTurn(id);

  assert.equal(result.status, 409);
  assert.match(result.error ?? "", /requires protocol v71/i);
  assert.equal(hub.sentOfType("interrupt_turn").length, 0);
  assert.equal(hub.sentOfType("cancel_session").length, 0);
});

test("cancelTurn reports interrupt_turn delivery failure without changing lifecycle state", async () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  hub.deliver = false;
  hub.activeTurnIds.set(id, "turn-active");
  const before = db.getSession(id)!.status;

  const result = await svc.cancelTurn(id);

  assert.equal(result.status, 409);
  assert.match(result.error ?? "", /offline/i);
  assert.equal(db.getSession(id)!.status, before);
});

test("restart re-sends start_session, clears pending approval, and goes to starting", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { title: "My restart title", config: { model: "opus", effort: "high" } });
  db.beginPolicyHookApproval({
    sessionId: id,
    requestId: "req-1",
    requestFingerprint: "a".repeat(64),
    governancePolicyId: "restart-policy",
    approval: {
      requestId: "req-1",
      title: "Approve Tool?",
      kind: "policy_hook",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      governancePolicyId: "restart-policy",
    },
    now: Date.now(),
  });

  const startsBefore = hub.sentOfType("start_session").length;
  const res = svc.restart(id);
  assert.ok(res.ok);

  const starts = hub.sentOfType("start_session");
  assert.equal(starts.length, startsBefore + 1);
  const msg = starts.at(-1)!;
  assert.equal(msg.spec.sessionId, id);
  // Restart spec rebuilds config from the stored session row.
  assert.equal(msg.spec.config!.model, "opus");
  assert.equal(msg.spec.config!.effort, "high");
  assert.equal(msg.spec.title, "My restart title");
  assert.equal(msg.spec.titleSource, "user");
  // restart sends a bare start_session (no initialPrompt).
  assert.equal(msg.initialPrompt, undefined);

  const stored = db.getSession(id)!;
  assert.equal(stored.status, "starting");
  assert.equal(stored.pendingApproval, null);
  assert.equal(db.getPolicyHookApproval(id, "req-1")?.status, "denied");
  assert.ok(svc.governanceAudit(id).some((entry) =>
    entry.requestId === "req-1" &&
    entry.outcome === "aborted" &&
    entry.actor.id === "session-restarted"));
});

test("restart backfills a pre-v60 session with the runner's current execution target", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { useWorktree: true });
  db.raw().prepare("UPDATE sessions SET execution_target=NULL WHERE id=?").run(id);

  const legacy = db.getSession(id)!;
  assert.equal(legacy.executionTarget?.id, `runner:${RUNNER_ID}:host:worktree`);

  const result = svc.restart(id);
  assert.ok(result.ok, result.error);
  const restart = hub.sentOfType("start_session").at(-1)!;
  assert.deepEqual(restart.spec.executionTarget, legacy.executionTarget);
  assert.equal(restart.spec.useWorktree, true);
});

test("restart preserves a persisted legacy codex driver after the codex id becomes app-server", () => {
  const { db, hub, svc } = makeHarness();
  const id = "legacy-codex-session";
  db.createSession({
    id,
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: "codex",
    title: "Legacy Codex",
    useWorktree: false,
    driver: "codex",
    config: {},
    now: Date.now(),
  });

  const res = svc.restart(id);
  assert.ok(res.ok, res.error);
  const start = hub.sentOfType("start_session").at(-1)!;
  assert.equal(start.spec.agentId, "codex", "persisted identity is not rewritten");
  assert.equal(start.spec.driver, "codex", "stored exec driver wins over the new exact-id app-server row");
  assert.equal(start.spec.command, "codex");
  assert.deepEqual(start.spec.args, ["exec"]);
});

test("restart routes a persisted codex-native exec session to the native compatibility row", () => {
  const { db, hub, svc } = makeHarness();
  const id = "legacy-codex-native-session";
  db.createSession({
    id,
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: "codex-native",
    title: "Legacy Native Codex",
    useWorktree: false,
    driver: "codex",
    config: {},
    now: Date.now(),
  });

  const res = svc.restart(id);
  assert.ok(res.ok, res.error);
  const start = hub.sentOfType("start_session").at(-1)!;
  assert.equal(start.spec.agentId, "codex-native");
  assert.equal(start.spec.driver, "codex");
  assert.deepEqual(start.spec.args, ["exec"]);
});

test("restart routes a persisted WSL exec session to its distro compatibility row", () => {
  const { db, hub, svc } = makeHarness();
  db.updateRunnerAgents(
    RUNNER_ID,
    [
      ...runnerMeta().agents,
      {
        id: "codex-wsl-Ubuntu",
        name: "Codex App Server (WSL: Ubuntu)",
        command: "wsl.exe",
        args: ["-d", "Ubuntu", "--", "codex"],
        env: {},
        driver: "codex-app-server",
        context: { kind: "wsl", distro: "Ubuntu" },
      },
      {
        id: "codex-exec-wsl-Ubuntu",
        name: "Codex Exec (WSL: Ubuntu)",
        command: "wsl.exe",
        args: ["-d", "Ubuntu", "--", "codex", "exec"],
        env: {},
        driver: "codex",
        context: { kind: "wsl", distro: "Ubuntu" },
      },
    ],
    Date.now(),
  );
  const id = "legacy-codex-wsl-session";
  db.createSession({
    id,
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: "codex-wsl-Ubuntu",
    title: "Legacy WSL Codex",
    useWorktree: false,
    driver: "codex",
    config: {},
    now: Date.now(),
  });

  const res = svc.restart(id);
  assert.ok(res.ok, res.error);
  const start = hub.sentOfType("start_session").at(-1)!;
  assert.equal(start.spec.agentId, "codex-wsl-Ubuntu");
  assert.equal(start.spec.driver, "codex");
  assert.deepEqual(start.spec.args, ["-d", "Ubuntu", "--", "codex", "exec"]);
});

test("restart follows a current non-Codex driver reconfiguration", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  const reconfigured = runnerMeta().agents.map((agent) =>
    agent.id === AGENT_ID ? { ...agent, command: "acp-agent", args: ["serve"], driver: "acp" as const } : agent,
  );
  db.updateRunnerAgents(RUNNER_ID, reconfigured, Date.now());

  const startsBefore = hub.sentOfType("start_session").length;
  const res = svc.restart(id);
  assert.ok(res.ok, res.error);
  const start = hub.sentOfType("start_session").at(-1)!;
  assert.equal(hub.sentOfType("start_session").length, startsBefore + 1);
  assert.equal(start.spec.command, "acp-agent");
  assert.deepEqual(start.spec.args, ["serve"]);
  assert.equal(start.spec.driver, "acp");
});

test("restart blocks an app-server session after the target becomes unavailable", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { agentId: CODEX_APP_AGENT_ID });
  const unavailable = runnerMeta().agents.map((agent) =>
    agent.id === CODEX_APP_AGENT_ID
      ? {
          ...agent,
          available: false,
          codexAppServer: {
            status: "unsupported" as const,
            installedVersion: "0.143.0",
            appServerAvailable: true,
            failure: {
              code: "version_unverified" as const,
              message: "Upgrade Codex to use app-server.",
              retryable: false,
            },
          },
        }
      : agent,
  );
  db.updateRunnerAgents(RUNNER_ID, unavailable, Date.now());

  const startsBefore = hub.sentOfType("start_session").length;
  const res = svc.restart(id);
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
  assert.equal(hub.sentOfType("start_session").length, startsBefore);
});

test("restart fails 409 when the runner is offline", () => {
  const { hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  hub.online = false;

  const before = hub.sentToRunner.length;
  const res = svc.restart(id);
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.equal(hub.sentToRunner.length, before);
});

/* -------------------------------------------------------------------------- */
/* onSessionStatus — terminal-regression guard                               */
/* -------------------------------------------------------------------------- */

test("onSessionStatus does NOT regress a terminal session back to running", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "completed", Date.now());

  svc.onSessionStatus(id, "running");

  // Status stays terminal; only a re-broadcast happens.
  assert.equal(db.getSession(id)!.status, "completed");
  assert.ok(hub.sessionChangedByIdCalls.includes(id));
});

test("onSessionStatus applies a status to a non-terminal session", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());

  svc.onSessionStatus(id, "idle");
  assert.equal(db.getSession(id)!.status, "idle");
});

test("onSessionStatus clears a pending approval when the session ends", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.setPendingApproval(id, { requestId: "req-1", title: "t", options: [] });
  db.updateSessionStatus(id, "input_required", Date.now());
  // Re-set pending (updateSessionStatus to input_required keeps it, others clear it).
  db.setPendingApproval(id, { requestId: "req-1", title: "t", options: [] });
  assert.ok(db.getSession(id)!.pendingApproval);

  svc.onSessionStatus(id, "completed");

  const stored = db.getSession(id)!;
  assert.equal(stored.status, "completed");
  assert.equal(stored.pendingApproval, null);
});

test("onSessionStatus appends an error event when failing with detail", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());

  svc.onSessionStatus(id, "failed", "boom");

  assert.equal(db.getSession(id)!.status, "failed");
  const ev = hub.sessionEventCalls.at(-1)!;
  assert.equal(ev.payload.kind, "error");
});

test("onSessionStatus is a no-op for an unknown session", () => {
  const { hub, svc } = makeHarness();
  const before = hub.calls.length;
  svc.onSessionStatus("nope", "running");
  assert.equal(hub.calls.length, before);
});

/* -------------------------------------------------------------------------- */
/* Phase 2 — hydrate the cache from the box's session snapshots               */
/* -------------------------------------------------------------------------- */

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "s_box1",
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    title: "boxed work",
    status: "idle",
    driver: "claude-code",
    useWorktree: true,
    worktreePath: "/repos/demo/.agent-worktrees/s_box1",
    config: { model: "opus", effort: "high", permissionMode: "default" },
    preview: "last agent line",
    pendingApproval: null,
    tokensIn: 10,
    tokensOut: 20,
    costUsd: 0.5,
    seq: 4,
    createdAt: 100,
    updatedAt: 200,
    ...over,
  };
}

test("hydrateRunnerSessions inserts a session the cache never had (box is source of truth)", () => {
  const { db, hub, svc } = makeHarness();

  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot()]);

  const s = db.getSession("s_box1");
  assert.ok(s, "the snapshot should have been materialized into the cache");
  assert.equal(s!.status, "idle");
  assert.equal(s!.title, "boxed work");
  assert.equal(s!.model, "opus");
  assert.equal(s!.tokensIn, 10);
  assert.equal(s!.tokensOut, 20);
  assert.equal(s!.preview, "last agent line");
  assert.equal(s!.worktreePath, "/repos/demo/.agent-worktrees/s_box1");
  assert.ok(hub.sessionChangedByIdCalls.includes("s_box1"));
});

test("hydrateRunnerSessions refuses an unissued conductor session from a runner snapshot", () => {
  const { db, svc } = makeHarness();
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({ id: "forged-conductor", agentId: CONDUCTOR_ID, status: "running" })]);
  assert.equal(db.getSession("forged-conductor"), null);
});

test("hydrateRunnerSessions updates an existing cached session without duplicating it", () => {
  const { db, svc } = makeHarness();
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot()]);

  svc.hydrateRunnerSessions(RUNNER_ID, [
    snapshot({ status: "running", preview: "newer line", tokensIn: 99, seq: 9 }),
  ]);

  assert.equal(db.listSessions({ includeArchived: true }).filter((s) => s.id === "s_box1").length, 1);
  const s = db.getSession("s_box1")!;
  assert.equal(s.status, "running");
  assert.equal(s.preview, "newer line");
  assert.equal(s.tokensIn, 99);
});

test("a known runner history epoch change atomically clears the cache and broadcasts its new CP epoch", () => {
  const { db, hub, svc } = makeHarness();
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({ seq: 0, historyEpoch: 10 })]);
  svc.onSessionEvent("s_box1", { kind: "command_output", text: "old-generation-".repeat(2_000) }, 1, 1_001);
  assert.equal(db.listEvents("s_box1").length, 1);
  const oldPayload = db.listEvents("s_box1")[0]!.payload;
  assert.equal(oldPayload.kind, "command_output");
  const artifactIds = oldPayload.kind === "command_output"
    ? (oldPayload.textRefs ?? []).map((ref) => ref.artifactId)
    : [];
  assert.ok(artifactIds.length);

  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({ seq: 1, historyEpoch: 11 })]);

  assert.deepEqual(db.listEvents("s_box1"), []);
  assert.equal(db.getSession("s_box1")?.eventEpoch, 1);
  assert.deepEqual(hub.sessionEventsResetCalls.at(-1), { sessionId: "s_box1", events: [], eventEpoch: 1 });
  assert.equal(db.getRunnerHistoryState("s_box1")?.historyEpoch, 11);
  assert.ok(artifactIds.every((artifactId) => db.getWorkflowArtifact(artifactId) === null));
});

test("a live session runtime snapshot updates only its owner and preserves session-scoped controls", () => {
  const { db, svc } = makeHarness();
  svc.hydrateRunnerSessions(RUNNER_ID, [
    snapshot({ id: "runtime-one", driver: "acp", agentId: "gemini", titleSource: "generated" }),
    snapshot({ id: "runtime-two", driver: "acp", agentId: "gemini" }),
  ]);
  db.setSessionTitle("runtime-one", "My explicit title", Date.now(), "user");
  const capabilities = {
    models: [{ id: "smart", displayName: "Smart", default: true }],
    effortLevels: ["high"],
    slashCommands: [{ name: "review", source: "builtin" as const }],
    supportsImages: true,
    supportsApprovals: true,
    permissionModes: ["default", "plan"],
  };
  svc.applySessionRuntimeUpdate(RUNNER_ID, snapshot({
    id: "runtime-one",
    driver: "acp",
    agentId: "gemini",
    config: { model: "smart", effort: "high", permissionMode: "plan" },
    agentCapabilities: capabilities,
    title: "Provider replacement",
    titleSource: "provider",
    contextTokensUsed: 12_345,
    contextWindow: 200_000,
  }));
  assert.deepEqual(db.getSession("runtime-one")!.agentCapabilities, capabilities);
  assert.equal(db.getSession("runtime-one")!.permissionMode, "plan");
  assert.equal(db.getSession("runtime-one")!.title, "My explicit title");
  assert.equal(db.getSession("runtime-one")!.titleSource, "user");
  assert.equal(db.getSession("runtime-one")!.contextTokensUsed, 12_345);
  assert.equal(db.getSession("runtime-one")!.contextWindow, 200_000);
  assert.equal(db.getSession("runtime-two")!.status, "idle", "single-snapshot update is not full reconciliation");
});

test("a terminal runner snapshot aborts a durable hook ask instead of preserving its card", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  svc.upsertGovernancePolicy({
    policyId: "ask-before-terminal",
    name: "Ask Before Terminal",
    effect: "ask",
    priority: 100,
    enabled: true,
    scope: { toolName: "Danger" },
  });
  const asked = svc.evaluatePolicyHook(id, {
    hookEventName: "PreToolUse",
    providerSessionId: "provider-terminal",
    permissionMode: "plan",
    toolUseId: "terminal-tool",
    context: { toolName: "Danger" },
  }, true).data!;

  svc.applySessionRuntimeUpdate(RUNNER_ID, snapshot({
    id,
    status: "completed",
    pendingApproval: null,
  }));

  assert.equal(db.getSession(id)?.status, "completed");
  assert.equal(db.getSession(id)?.pendingApproval, null);
  assert.equal(db.getPolicyHookApproval(id, asked.approvalRequestId!)?.status, "denied");
  assert.ok(svc.governanceAudit(id).some((entry) =>
    entry.requestId === asked.approvalRequestId &&
    entry.outcome === "aborted" &&
    entry.actor.id === "provider-session-ended"));
});

test("ACP cumulative runtime cost triggers the existing budget gate without token fabrication", () => {
  const { db, svc } = makeHarness();
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({
    id: "runtime-cost",
    driver: "acp",
    agentId: "gemini",
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
  })]);
  db.updateSessionCostBudget("runtime-cost", 5, Date.now());
  svc.applySessionRuntimeUpdate(RUNNER_ID, snapshot({
    id: "runtime-cost",
    driver: "acp",
    agentId: "gemini",
    tokensIn: 0,
    tokensOut: 0,
    contextTokensUsed: 80_000,
    contextWindow: 100_000,
    costUsd: 6,
  }));
  const session = db.getSession("runtime-cost")!;
  assert.equal(session.tokensIn, 0);
  assert.equal(session.tokensOut, 0);
  assert.equal(session.contextTokensUsed, 80_000);
  assert.equal(session.costUsd, 6);
  assert.equal(session.pendingApproval?.kind, "cost_budget");
  assert.equal(session.status, "input_required");
  svc.applySessionRuntimeUpdate(RUNNER_ID, snapshot({
    id: "runtime-cost", driver: "acp", agentId: "gemini", costUsd: 1,
  }));
  assert.equal(db.getSession("runtime-cost")!.costUsd, 6, "a stale runtime snapshot cannot roll cost back");
});

test("hydrateRunnerSessions stops a cached session the box no longer holds", () => {
  const { db, svc } = makeHarness();
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot()]);
  assert.equal(db.getSession("s_box1")!.status, "idle");

  // The box reports no sessions now → the cache copy is marked stopped (not deleted).
  svc.hydrateRunnerSessions(RUNNER_ID, []);

  assert.equal(db.getSession("s_box1")!.status, "stopped");
});

test("restart hydration aborts orphaned hook asks when the provider no longer reports the session", () => {
  for (const reconcile of ["snapshots", "legacy-live-list"] as const) {
    const { db, svc } = makeHarness();
    svc.hydrateRunnerSessions(RUNNER_ID, [snapshot()]);
    db.beginPolicyHookApproval({
      sessionId: "s_box1",
      requestId: `restart-absent-${reconcile}`,
      requestFingerprint: "a".repeat(64),
      governancePolicyId: "ask-before-restart",
      approval: {
        requestId: `restart-absent-${reconcile}`,
        title: "Approve Tool?",
        kind: "policy_hook",
        options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
        governancePolicyId: "ask-before-restart",
      },
      now: 1_000,
    });
    // ControlPlaneDb startup conservatively stops unconfirmed sessions and clears their card while
    // the durable hook row remains open until registration gives an authoritative live set.
    db.updateSessionStatus("s_box1", "stopped", 1_100);

    if (reconcile === "snapshots") svc.hydrateRunnerSessions(RUNNER_ID, []);
    else svc.reconcileRunnerSessions(RUNNER_ID, []);

    assert.equal(
      db.getPolicyHookApproval("s_box1", `restart-absent-${reconcile}`)?.status,
      "denied",
      reconcile,
    );
    assert.ok(svc.governanceAudit("s_box1").some((entry) =>
      entry.requestId === `restart-absent-${reconcile}` &&
      entry.outcome === "aborted" &&
      entry.actor.id === "provider-session-absent"), reconcile);
  }
});

test("simultaneous runner and control-plane restart aborts a hook ask from an authoritative idle snapshot", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  db.updateSessionStatus(id, "running", Date.now());
  svc.upsertGovernancePolicy({
    policyId: "ask-before-restart-idle",
    name: "Ask Before Restart Idle",
    effect: "ask",
    priority: 100,
    enabled: true,
    scope: { toolName: "Write" },
  });
  const asked = svc.evaluatePolicyHook(id, {
    hookEventName: "PreToolUse",
    providerSessionId: "provider-restart-idle",
    permissionMode: "plan",
    toolUseId: "restart-idle-tool",
    context: { toolName: "Write" },
  }, true).data!;
  assert.equal(db.getPolicyHookApproval(id, asked.approvalRequestId!)?.status, "pending");

  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({
    id,
    status: "idle",
    pendingApproval: null,
  })]);

  assert.equal(db.getPolicyHookApproval(id, asked.approvalRequestId!)?.status, "denied");
  assert.equal(db.getSession(id)!.status, "idle");
  assert.equal(db.getSession(id)!.pendingApproval, null);
  assert.ok(svc.governanceAudit(id).some((entry) =>
    entry.requestId === asked.approvalRequestId &&
    entry.outcome === "aborted" &&
    entry.actor.id === "provider-session-inactive"));
});

test("onSessionEvent advances the hydration high-water only contiguously (gap-safe)", () => {
  const { db, svc } = makeHarness();
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot()]);
  assert.equal(db.getHydratedSeq("s_box1"), 0);

  // Contiguous events advance the cursor 1 -> 2.
  svc.onSessionEvent("s_box1", { kind: "agent_message", text: "one" }, 1, 1000);
  svc.onSessionEvent("s_box1", { kind: "agent_message", text: "two" }, 2, 1001);
  assert.equal(db.getHydratedSeq("s_box1"), 2);

  // A gap (seq 5 while the cursor is at 2) must NOT advance — advancing would skip 3-4 forever.
  // The live event is dropped here; the ordered backfill (hydrateHistory) fills the gap on open.
  svc.onSessionEvent("s_box1", { kind: "agent_message", text: "five" }, 5, 1002);
  assert.equal(db.getHydratedSeq("s_box1"), 2);

  // A replayed/duplicate seq (<= cursor) is ignored — no rollback, no duplicate row.
  svc.onSessionEvent("s_box1", { kind: "agent_message", text: "dup" }, 1, 1003);
  assert.equal(db.getHydratedSeq("s_box1"), 2);
  assert.equal(db.listEvents("s_box1", 0).length, 2);
});

test("large live event payloads persist and broadcast only a bounded artifact-backed preview", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  const original = `head-${"x".repeat(7_000)} uniqueftstoken ${"x".repeat(13_000)} uniquemiddletoken ${"y".repeat(20_000)}-tail`;

  svc.onSessionEvent(id, { kind: "command_output", text: original });

  const event = db.listEvents(id)[0]!;
  assert.equal(event.payload.kind, "command_output");
  if (event.payload.kind !== "command_output") return;
  assert.notEqual(event.payload.text, original);
  assert.ok(Buffer.byteLength(event.payload.text, "utf8") <= EVENT_PAYLOAD_PREVIEW_BYTES);
  assert.ok(event.payload.textRefs?.length);
  assert.equal(JSON.stringify(event).includes(original), false);
  assert.deepEqual(hub.sessionEventCalls.at(-1)?.payload, event.payload);
  assert.equal(event.payload.text.includes("uniquemiddletoken"), false, "the marker sits outside the bounded preview");
  assert.equal(db.searchEvents("uniqueftstoken")[0]?.sessionId, id, "FTS retains its existing bounded search coverage");
  const reconstructed = Buffer.concat(event.payload.textRefs!.map((ref) => db.readWorkflowArtifactBytes(ref.artifactId)!))
    .toString("utf8");
  assert.equal(reconstructed, original);

  const artifactIds = event.payload.textRefs!.map((ref) => ref.artifactId);
  assert.equal(
    (db.raw().prepare("SELECT COUNT(*) AS n FROM session_event_artifacts WHERE event_id=?")
      .get(event.id) as { n: number }).n,
    artifactIds.length,
  );
  assert.equal(db.collectOrphanedEventPayloadArtifacts(), 0, "indexed reachability retains committed chunks");
  db.clearSessionEvents(id);
  assert.deepEqual(db.listEvents(id), []);
  assert.ok(artifactIds.every((artifactId) => db.getWorkflowArtifact(artifactId) === null));
});

test("artifact storage failure keeps the original large live event losslessly", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  const original = "lossless-".repeat(3_000);
  const create = db.createWorkflowArtifactBytes.bind(db);
  db.createWorkflowArtifactBytes = () => { throw new Error("storage unavailable"); };
  try {
    svc.onSessionEvent(id, { kind: "stderr", text: original });
  } finally {
    db.createWorkflowArtifactBytes = create;
  }
  const event = db.listEvents(id)[0]!;
  assert.deepEqual(event.payload, { kind: "stderr", text: original });
  assert.deepEqual(hub.sessionEventCalls.at(-1)?.payload, event.payload);
  assert.equal(db.listSessionWorkflowArtifacts(id).length, 0);
});

test("event append failure rolls back artifacts created for that uncommitted event", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  const append = db.appendEvent.bind(db);
  db.appendEvent = () => { throw new Error("event append failed"); };
  try {
    assert.throws(
      () => svc.onSessionEvent(id, { kind: "command_output", text: "append-rollback-".repeat(2_000) }),
      /event append failed/,
    );
  } finally {
    db.appendEvent = append;
  }
  assert.deepEqual(db.listEvents(id), []);
  assert.deepEqual(db.listSessionWorkflowArtifacts(id), []);
});

test("runner deletion removes session-only large-event artifacts and their blobs", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.onSessionEvent(id, { kind: "command_output", text: "runner-delete-".repeat(2_000) });
  const payload = db.listEvents(id)[0]!.payload;
  assert.equal(payload.kind, "command_output");
  const artifactIds = payload.kind === "command_output"
    ? (payload.textRefs ?? []).map((ref) => ref.artifactId)
    : [];
  assert.ok(artifactIds.length);

  assert.ok(db.deleteRunner(RUNNER_ID));
  assert.equal(db.getSession(id), null);
  assert.ok(artifactIds.every((artifactId) => db.getWorkflowArtifact(artifactId) === null));
});

test("indexed history pages externalize large payloads before cache persistence and broadcast", async () => {
  const { db, hub, svc } = makeHarness();
  const original = "indexed-history-".repeat(2_000);
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({ seq: 1, historyEpoch: 7 })]);
  hub.requestHandler = (msg) => {
    assert.equal(msg.type, "session_history_page");
    if (msg.type !== "session_history_page") throw new Error("unexpected request");
    return {
      type: "session_history_page_result",
      requestId: msg.requestId,
      sessionId: msg.sessionId,
      ok: true,
      events: [{ seq: 1, ts: 100, payload: { kind: "tool_call", toolCallId: "t1", title: "Run", status: "completed", text: original } }],
      page: { logEpoch: 7, throughSeq: 1, nextAfterSeq: 1, hasMore: false },
    };
  };

  await svc.hydrateHistory("s_box1");

  const event = db.listEvents("s_box1")[0]!;
  assert.equal(event.payload.kind, "tool_call");
  if (event.payload.kind !== "tool_call") return;
  assert.notEqual(event.payload.text, original);
  assert.ok(event.payload.textRefs?.length);
  assert.equal(JSON.stringify(hub.sessionEventCalls.at(-1)).includes(original), false);
  assert.equal(
    Buffer.concat(event.payload.textRefs!.map((ref) => db.readWorkflowArtifactBytes(ref.artifactId)!)).toString("utf8"),
    original,
  );
});

test("legacy history hydration externalizes large payloads before cache persistence", async () => {
  const { db, hub, svc } = makeHarness();
  db.registerRunner(runnerMeta(), Date.now(), 53);
  const original = "legacy-history-".repeat(2_000);
  hub.requestHandler = (msg) => {
    assert.equal(msg.type, "session_history");
    if (msg.type !== "session_history") throw new Error("unexpected request");
    return {
      type: "session_history_result",
      requestId: msg.requestId,
      sessionId: msg.sessionId,
      ok: true,
      events: [{ seq: 1, ts: 100, payload: { kind: "file_edit", path: "src/a.ts", diff: original } }],
    };
  };
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({ seq: 1, historyEpoch: undefined })]);

  await svc.hydrateHistory("s_box1");

  const event = db.listEvents("s_box1")[0]!;
  assert.equal(event.payload.kind, "file_edit");
  if (event.payload.kind !== "file_edit") return;
  assert.notEqual(event.payload.diff, original);
  assert.ok(event.payload.diffRefs?.length);
  assert.equal(JSON.stringify(event).includes(original), false);
});

test("delete tombstones the session so a later snapshot cannot resurrect it (H2)", () => {
  const { db, hub, svc } = makeHarness();
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot()]);
  assert.ok(db.getSession("s_box1"));

  const res = svc.delete("s_box1");
  assert.ok(res.ok);
  assert.equal(db.getSession("s_box1"), null);
  assert.equal(db.isTombstoned("s_box1"), true);
  // The runner was told to remove it from the box store.
  assert.equal(hub.sentOfType("delete_session").filter((m) => m.sessionId === "s_box1").length, 1);

  // A reconnect that still reports the snapshot must NOT recreate it — it re-issues the delete.
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot()]);
  assert.equal(db.getSession("s_box1"), null);
  assert.equal(hub.sentOfType("delete_session").filter((m) => m.sessionId === "s_box1").length, 2);

  // Once the box stops reporting it (delete took), the tombstone is pruned.
  svc.hydrateRunnerSessions(RUNNER_ID, []);
  assert.equal(db.isTombstoned("s_box1"), false);
});

test("fork cleanup tombstones survive absent reconnects and reject a later snapshot", () => {
  const { db, hub, svc } = makeHarness();
  const targetSessionId = "s_late_fork";
  db.addTombstone(targetSessionId, RUNNER_ID, Date.now(), "retain");
  hub.sendToRunner(RUNNER_ID, { type: "delete_session", sessionId: targetSessionId });

  // An empty reconnect is not proof that a timed-out fork can never be created later.
  svc.hydrateRunnerSessions(RUNNER_ID, []);
  assert.equal(db.isTombstoned(targetSessionId), true);
  assert.equal(hub.sentOfType("delete_session").filter((m) => m.sessionId === targetSessionId).length, 1);

  // If the delayed fork later appears, it remains rejected and deletion is re-issued.
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({ id: targetSessionId })]);
  assert.equal(db.getSession(targetSessionId), null);
  assert.equal(db.isTombstoned(targetSessionId), true);
  assert.equal(hub.sentOfType("delete_session").filter((m) => m.sessionId === targetSessionId).length, 2);

  svc.hydrateRunnerSessions(RUNNER_ID, []);
  assert.equal(db.isTombstoned(targetSessionId), true);
});

test("event/status frames from a non-owning runner are rejected (M7)", () => {
  const { db, svc } = makeHarness();
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot()]); // owned by RUNNER_ID

  svc.onSessionEvent("s_box1", { kind: "agent_message", text: "evil" }, undefined, undefined, "intruder");
  assert.equal(db.listEvents("s_box1", 0).length, 0); // not appended

  svc.onSessionStatus("s_box1", "failed", "evil", undefined, "intruder");
  assert.notEqual(db.getSession("s_box1")!.status, "failed"); // not mutated

  // The owning runner is honored.
  svc.onSessionStatus("s_box1", "running", undefined, undefined, RUNNER_ID);
  assert.equal(db.getSession("s_box1")!.status, "running");
});

test("hydrateRunnerSessions won't let one runner overwrite another runner's session (M7)", () => {
  const { db, svc } = makeHarness();
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot()]); // RUNNER_ID owns s_box1
  svc.hydrateRunnerSessions("other-runner", [snapshot({ title: "hijacked", status: "running" })]);
  const s = db.getSession("s_box1")!;
  assert.equal(s.runnerId, RUNNER_ID);
  assert.equal(s.title, "boxed work"); // unchanged by the non-owner
});

test("hydrateRunnerSessions persists a snapshot's pendingApproval so it survives hydration (H3)", () => {
  const { db, svc } = makeHarness();
  const approval = {
    requestId: "rq1",
    title: "Allow write to file?",
    options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
  };
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({ status: "input_required", pendingApproval: approval })]);
  assert.deepEqual(db.getSession("s_box1")!.pendingApproval, approval);

  // Clearing it on the box (next snapshot) clears the cache.
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({ pendingApproval: null })]);
  assert.equal(db.getSession("s_box1")!.pendingApproval, null);
});

test("a CP-only cost-budget pause survives a runner snapshot (not clobbered on hydrate)", () => {
  const { db, svc } = makeHarness();
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot()]); // s_box1, idle, no pending
  // The control plane parks it on a cost-budget approval (the runner knows nothing about this).
  db.setPendingApproval("s_box1", { requestId: "cost-budget:s_box1:1", kind: "cost_budget", title: "over budget", options: [] });
  db.updateSessionStatus("s_box1", "input_required", Date.now());

  // The runner's next snapshot reports idle + no pending — it must NOT wipe the budget pause.
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({ status: "idle", pendingApproval: null })]);
  let s = db.getSession("s_box1")!;
  assert.equal(s.status, "input_required");
  assert.equal(s.pendingApproval?.kind, "cost_budget");

  // Even a runner permission approval doesn't override a live budget pause.
  svc.hydrateRunnerSessions(RUNNER_ID, [
    snapshot({ status: "input_required", pendingApproval: { requestId: "p1", title: "allow tool?", options: [] } }),
  ]);
  s = db.getSession("s_box1")!;
  assert.equal(s.pendingApproval?.kind, "cost_budget");
});

test("adoptSession seeds a cache row from the descriptor and tells the runner to adopt it (Phase 3)", async () => {
  const { db, hub, svc } = makeHarness();
  const descriptor = {
    agentSessionId: "claude-uuid-1",
    driver: "claude-code" as const,
    cwd: "/home/me/repo",
    context: { kind: "native" as const },
    title: "Refactor the parser",
    createdAt: 1000,
    updatedAt: 2000,
    messageCount: 7,
  };

  const res = await svc.adoptSession(RUNNER_ID, descriptor, true);
  assert.ok(res.ok);
  assert.equal(res.status, 201);
  const id = res.data!.id;

  const s = db.getSession(id)!;
  assert.equal(s.title, "Refactor the parser");
  assert.equal(s.driver, "claude-code");
  assert.equal(s.status, "idle");
  assert.equal(s.runnerId, RUNNER_ID);
  assert.equal(s.adopted, true); // seeded as adopted so reprocess is available immediately

  const adopt = hub.sentOfType("adopt_session");
  assert.equal(adopt.length, 1);
  assert.equal(adopt[0].sessionId, id);
  assert.equal(adopt[0].backfill, true);
  assert.equal(adopt[0].descriptor.agentSessionId, "claude-uuid-1");
});

test("reprocessSession advances the event epoch before publishing the replacement timeline", async () => {
  const { db, hub, svc } = makeHarness();
  db.registerRunner(runnerMeta(), Date.now(), 53);
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({ adopted: true, seq: 1 })]);
  svc.onSessionEvent("s_box1", { kind: "command_output", text: "stale-parser-output-".repeat(2_000) });
  const stalePayload = db.listEvents("s_box1")[0]!.payload;
  assert.equal(stalePayload.kind, "command_output");
  const staleArtifactIds = stalePayload.kind === "command_output"
    ? (stalePayload.textRefs ?? []).map((ref) => ref.artifactId)
    : [];
  assert.ok(staleArtifactIds.length);
  assert.equal(db.getSession("s_box1")!.eventEpoch, 0);
  const freshText = "fresh-parser-output-".repeat(2_000);

  hub.requestHandler = (msg) => {
    assert.equal(msg.type, "reprocess_session");
    if (msg.type !== "reprocess_session") throw new Error("unexpected request");
    assert.equal(msg.deferHistory, undefined, "legacy peers retain the complete result array");
    return {
      type: "reprocess_session_result",
      requestId: msg.requestId,
      sessionId: msg.sessionId,
      ok: true,
      snapshot: snapshot({ adopted: true, seq: 1, preview: "fresh parser output" }),
      events: [{
        seq: 1,
        ts: 200,
        payload: { kind: "command_output", text: freshText },
      }],
    };
  };

  const result = await svc.reprocessSession("s_box1");
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data!.eventEpoch, 1);
  assert.equal(db.getSession("s_box1")!.eventEpoch, 1);
  const freshPayload = db.listEvents("s_box1")[0]!.payload;
  assert.equal(freshPayload.kind, "command_output");
  assert.ok(freshPayload.kind === "command_output" && freshPayload.textRefs?.length);
  assert.equal(JSON.stringify(freshPayload).includes(freshText), false);
  assert.ok(staleArtifactIds.every((artifactId) => db.getWorkflowArtifact(artifactId) === null));
  assert.equal(hub.sessionChangedCalls.at(-1)?.id, "s_box1");
  assert.deepEqual(hub.sessionEventsResetCalls, [{
    sessionId: "s_box1",
    events: db.listEvents("s_box1"),
    eventEpoch: 1,
  }]);
});

test("v54 reprocess defers its unbounded array and repopulates through bounded history pages", async () => {
  const { db, hub, svc } = makeHarness();
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({ adopted: true, seq: 0, historyEpoch: 1 })]);
  db.appendEvent("s_box1", { kind: "agent_message", text: "stale" }, 100);
  hub.requestHandler = (msg) => {
    if (msg.type === "reprocess_session") {
      assert.equal(msg.deferHistory, true);
      return {
        type: "reprocess_session_result",
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        ok: true,
        snapshot: snapshot({ adopted: true, seq: 1, historyEpoch: 2, preview: "fresh" }),
        // A malformed v54 peer cannot force this potentially unbounded compatibility array into CP.
        events: [{ seq: 99, ts: 99, payload: { kind: "agent_message", text: "must be ignored" } }],
      };
    }
    if (msg.type === "session_history_page") {
      return {
        type: "session_history_page_result",
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        ok: true,
        events: [{ seq: 1, ts: 200, payload: { kind: "agent_message", text: "fresh" } }],
        page: { logEpoch: 2, throughSeq: 1, nextAfterSeq: 1, hasMore: false },
      };
    }
    throw new Error("unexpected request");
  };

  const result = await svc.reprocessSession("s_box1");
  assert.equal(result.ok, true, result.error);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(db.listEvents("s_box1").map((event) => event.payload), [
    { kind: "agent_message", text: "fresh" },
  ]);
  assert.equal(db.getRunnerHistoryState("s_box1")?.complete, true);
  assert.deepEqual(hub.sessionEventsResetCalls.at(-1), { sessionId: "s_box1", events: [], eventEpoch: 1 });
});

test("v54 reprocess racing an old page continuation schedules one fresh-generation pass", async () => {
  const { db, hub, svc } = makeHarness();
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({ adopted: true, seq: 2, historyEpoch: 1 })]);
  let rejectOldContinuation!: () => void;
  let oldContinuationStarted!: () => void;
  const oldContinuationReady = new Promise<void>((resolvePromise) => { oldContinuationStarted = resolvePromise; });
  hub.requestHandler = (msg) => {
    if (msg.type === "reprocess_session") {
      return {
        type: "reprocess_session_result",
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        ok: true,
        snapshot: snapshot({ adopted: true, seq: 1, historyEpoch: 2, preview: "new generation" }),
      };
    }
    if (msg.type !== "session_history_page") throw new Error("unexpected request");
    if (msg.logEpoch === 1) {
      oldContinuationStarted();
      return new Promise<RunnerRequestResult>((resolvePromise) => {
        rejectOldContinuation = () => resolvePromise({
          type: "session_history_page_result",
          requestId: msg.requestId,
          sessionId: msg.sessionId,
          ok: false,
          code: "history_epoch_changed",
          error: "reset",
        });
      });
    }
    if (msg.logEpoch === undefined && msg.afterSeq === 0 && db.getRunnerHistoryState("s_box1")?.historyEpoch === 1) {
      return {
        type: "session_history_page_result",
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        ok: true,
        events: [{ seq: 1, ts: 101, payload: { kind: "agent_message", text: "old page" } }],
        page: { logEpoch: 1, throughSeq: 2, nextAfterSeq: 1, hasMore: true },
      };
    }
    return {
      type: "session_history_page_result",
      requestId: msg.requestId,
      sessionId: msg.sessionId,
      ok: true,
      events: [{ seq: 1, ts: 201, payload: { kind: "agent_message", text: "new page" } }],
      page: { logEpoch: 2, throughSeq: 1, nextAfterSeq: 1, hasMore: false },
    };
  };

  const oldChain = svc.hydrateHistory("s_box1");
  await oldContinuationReady;
  const reprocessed = await svc.reprocessSession("s_box1");
  assert.equal(reprocessed.ok, true, reprocessed.error);
  rejectOldContinuation();
  await oldChain;

  assert.deepEqual(db.listEvents("s_box1").map((event) => event.payload), [
    { kind: "agent_message", text: "new page" },
  ]);
  assert.equal(db.getRunnerHistoryState("s_box1")?.historyEpoch, 2);
  assert.equal(db.getRunnerHistoryState("s_box1")?.complete, true);
});

test("adoptSession refuses the reserved conductor identity before contacting the runner", async () => {
  const { hub, svc } = makeHarness();
  const res = await svc.adoptSession(RUNNER_ID, {
    ...extDescriptor("/external"),
    driver: "acp",
    agentId: CONDUCTOR_ID,
  }, true);
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(hub.sentOfType("adopt_session").length, 0);
});

test("ACP adoption caches only the exact runner-revalidated descriptor and snapshot", async () => {
  const { db, hub, svc } = makeHarness();
  const claimed = {
    agentSessionId: "shared-acp-session",
    agentId: "provider-b",
    driver: "acp" as const,
    cwd: "/client/claimed/path",
    context: { kind: "native" as const },
    title: "client claimed title",
    createdAt: 1,
    updatedAt: 2,
    messageCount: 0,
    resumable: true,
  };
  hub.requestHandler = (message) => {
    assert.equal(message.type, "adopt_session");
    if (message.type !== "adopt_session") throw new Error("unexpected request");
    const descriptor = {
      ...claimed,
      cwd: `${WORKSPACE_PATH}/from-provider`,
      title: "provider title",
      createdAt: 100,
      updatedAt: 200,
    };
    return {
      type: "adopt_session_result",
      requestId: message.requestId!,
      ok: true,
      descriptor,
      snapshot: snapshot({
        id: message.sessionId,
        workspaceId: null,
        agentId: "provider-b",
        title: "provider title",
        driver: "acp",
        useWorktree: false,
        worktreePath: null,
        workspacePath: descriptor.cwd,
        config: {},
        adopted: true,
        seq: 0,
      }),
    };
  };

  const res = await svc.adoptSession(RUNNER_ID, claimed, true);
  assert.ok(res.ok);
  const stored = db.getSession(res.data!.id)!;
  assert.equal(stored.title, "provider title");
  assert.equal(stored.agentId, "provider-b");
  assert.equal(stored.workspaceId, WORKSPACE_ID);
  assert.equal(hub.sentOfType("adopt_session").length, 1, "request/response adoption is sent once");
});

test("rejected ACP adoption leaves no control-plane cache row", async () => {
  const { db, hub, svc } = makeHarness();
  const before = db.listSessions().length;
  hub.requestHandler = (message) => {
    assert.equal(message.type, "adopt_session");
    if (message.type !== "adopt_session") throw new Error("unexpected request");
    return { type: "adopt_session_result", requestId: message.requestId!, ok: false, error: "not found" };
  };
  const res = await svc.adoptSession(RUNNER_ID, {
    ...extDescriptor("/claimed"),
    driver: "acp",
    agentId: "provider-a",
  }, true);
  assert.equal(res.ok, false);
  assert.equal(db.listSessions().length, before);
});

test("adoptSession fails 409 when the runner is offline", async () => {
  const { hub, svc } = makeHarness();
  hub.online = false;
  const res = await svc.adoptSession(RUNNER_ID, {
    agentSessionId: "x",
    driver: "codex",
    cwd: "/x",
    context: { kind: "native" },
    title: "",
    createdAt: 0,
    updatedAt: 0,
    messageCount: 0,
  }, true);
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
});

test("capability gates reject old/unknown runners before requests or cache mutations", async () => {
  const { db, hub, svc } = makeHarness();
  const sessionId = seedSession(svc, hub);

  db.registerRunner(runnerMeta(), Date.now(), 5);
  const before = db.listSessions().length;
  const adopt = await svc.adoptSession(RUNNER_ID, extDescriptor("/external"), true);
  assert.equal(adopt.ok, false);
  assert.equal(adopt.status, 409);
  assert.match(adopt.error ?? "", /requires protocol v6/i);
  assert.equal(db.listSessions().length, before, "unsupported adopt must not create an orphan cache row");
  assert.equal(hub.sentOfType("adopt_session").length, 0);

  db.registerRunner(runnerMeta(), Date.now(), 9);
  const directory = await svc.listDirectory(RUNNER_ID, "");
  assert.equal(directory.status, 409);
  assert.match(directory.error ?? "", /requires protocol v10/i);

  db.registerRunner(runnerMeta(), Date.now(), 15);
  const files = await svc.listSessionFiles(sessionId, "");
  const file = await svc.readSessionFile(sessionId, "README.md");
  assert.equal(files.status, 409);
  assert.equal(file.status, 409);
  assert.match(files.error ?? "", /requires protocol v16/i);
});

/* -------------------------------------------------------------------------- */
/* Adopted sessions → projects: auto-match by cwd + "Move to project"         */
/* -------------------------------------------------------------------------- */

function extDescriptor(cwd: string) {
  return {
    agentSessionId: "ext-1",
    driver: "claude-code" as const,
    cwd,
    context: { kind: "native" as const },
    title: "External work",
    createdAt: 1000,
    updatedAt: 2000,
    messageCount: 3,
  };
}

test("adoptSession files the session under the workspace containing its cwd", async () => {
  const { db, hub, svc } = makeHarness();
  const res = await svc.adoptSession(RUNNER_ID, extDescriptor(`${WORKSPACE_PATH}/packages/core`), true);
  assert.ok(res.ok);
  const s = db.getSession(res.data!.id)!;
  assert.equal(s.workspaceId, WORKSPACE_ID);
  assert.equal(s.workspaceName, "Demo");
  assert.equal(db.getAdHocWorkspacePath(s.id), `${WORKSPACE_PATH}/packages/core`);
  assert.equal(hub.sentOfType("adopt_session").length, 1, "correlated adoption is not sent twice");
  assert.ok(hub.sentOfType("adopt_session")[0]!.requestId);
});

test("native adoption assigns only from the runner-revalidated descriptor", async () => {
  const { db, hub, svc } = makeHarness();
  const claimed = {
    ...extDescriptor("/client/claimed/path"),
    driver: "codex" as const,
    title: "Client claimed title",
  };
  hub.requestHandler = (message) => {
    assert.equal(message.type, "adopt_session");
    if (message.type !== "adopt_session") throw new Error("unexpected request");
    const descriptor = {
      ...claimed,
      cwd: `${WORKSPACE_PATH}/runner-verified`,
      title: "Runner verified title",
    };
    return {
      type: "adopt_session_result",
      requestId: message.requestId!,
      ok: true,
      descriptor,
      snapshot: snapshot({
        id: message.sessionId,
        workspaceId: null,
        workspacePath: descriptor.cwd,
        agentId: null,
        title: descriptor.title,
        titleSource: "provider",
        driver: "codex",
        useWorktree: false,
        worktreePath: null,
        config: {},
        adopted: true,
        seq: 0,
      }),
    };
  };

  const result = await svc.adoptSession(RUNNER_ID, claimed, true);
  assert.ok(result.ok && result.data);
  assert.equal(result.data.title, "Runner verified title");
  assert.equal(result.data.workspaceId, WORKSPACE_ID);
  assert.equal(db.getAdHocWorkspacePath(result.data.id), `${WORKSPACE_PATH}/runner-verified`);
  assert.equal(JSON.stringify(result.data).includes("client/claimed"), false);
});

test("correlated adoption outlives full enumeration and ambiguous failures remain non-destructive", async () => {
  assert.ok(EXTERNAL_SESSION_ADOPTION_TIMEOUT_MS > EXTERNAL_SESSION_ENUMERATION_TIMEOUT_MS,
    "adoption includes enumeration plus a durable store write and acknowledgement");
  const { db, hub, svc } = makeHarness();
  hub.requestHandler = async (message) => {
    assert.equal(message.type, "adopt_session");
    throw new Error("simulated reply timeout after an ambiguous runner commit");
  };

  const result = await svc.adoptSession(RUNNER_ID, extDescriptor(`${WORKSPACE_PATH}/slow`), true);

  assert.equal(result.status, 504);
  const attemptedId = hub.sentOfType("adopt_session")[0]!.sessionId;
  assert.equal(db.isTombstoned(attemptedId), false,
    "an ambiguous timeout must allow a committed runner row to hydrate on reconnect");
  assert.equal(hub.sentOfType("delete_session").length, 0,
    "the control plane cannot know that compensation is safe after losing the reply");
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({
    id: attemptedId,
    workspaceId: null,
    workspacePath: `${WORKSPACE_PATH}/slow`,
    adopted: true,
    driver: "claude-code",
  })]);
  assert.ok(db.getSession(attemptedId),
    "a runner commit whose reply was lost must converge through its next authoritative snapshot");
});

test("an invalid successful adoption result is compensated and cannot hydrate later", async () => {
  const { db, hub, svc } = makeHarness();
  hub.requestHandler = async (message) => {
    assert.equal(message.type, "adopt_session");
    if (message.type !== "adopt_session") throw new Error("unexpected request");
    return {
      type: "adopt_session_result",
      requestId: message.requestId!,
      ok: true,
      descriptor: message.descriptor,
      snapshot: snapshot({
        id: "wrong-session-id",
        workspacePath: message.descriptor.cwd,
        adopted: true,
        driver: message.descriptor.driver,
      }),
    };
  };

  const result = await svc.adoptSession(RUNNER_ID, extDescriptor(`${WORKSPACE_PATH}/invalid`), true);

  assert.equal(result.status, 502);
  const attemptedId = hub.sentOfType("adopt_session")[0]!.sessionId;
  assert.equal(db.isTombstoned(attemptedId), true);
  assert.deepEqual(hub.sentOfType("delete_session").map((message) => message.sessionId), [attemptedId]);
});

test("a failed CP adoption commit compensates the runner so the external session can be retried", async () => {
  const { db, hub, svc } = makeHarness();
  const defaultHandler = hub.requestHandler!;
  const runnerSessions = new Set<string>();
  let firstRunnerSessionId = "";
  hub.deliveryHandler = (_runnerId, message) => {
    if (message.type === "delete_session") runnerSessions.delete(message.sessionId);
    return true;
  };
  hub.requestHandler = async (message) => {
    assert.equal(message.type, "adopt_session");
    if (message.type !== "adopt_session") throw new Error("unexpected request");
    assert.equal(runnerSessions.size, 0, "the prior compensated row must not hide the retry");
    runnerSessions.add(message.sessionId);
    firstRunnerSessionId ||= message.sessionId;
    return await defaultHandler(message);
  };
  const create = db.createSessionFromSnapshot.bind(db);
  let failCommit = true;
  db.createSessionFromSnapshot = (...args) => {
    if (failCommit) {
      failCommit = false;
      throw new Error("simulated SQLite commit failure");
    }
    return create(...args);
  };

  const first = await svc.adoptSession(RUNNER_ID, extDescriptor(`${WORKSPACE_PATH}/retry`), true);
  assert.equal(first.status, 500);
  assert.equal(runnerSessions.size, 0);
  assert.equal(db.isTombstoned(firstRunnerSessionId), true);
  assert.equal(hub.sentOfType("delete_session").length, 1);

  const retried = await svc.adoptSession(RUNNER_ID, extDescriptor(`${WORKSPACE_PATH}/retry`), true);
  assert.ok(retried.ok && retried.data);
  assert.equal(runnerSessions.size, 1);
});

test("pre-v35 native adoption keeps hostile client cwd unassigned until authoritative hydration", async () => {
  const { db, hub, svc } = makeHarness();
  db.registerRunner(runnerMeta(), Date.now(), 34);
  const descriptor = extDescriptor(`${WORKSPACE_PATH}/legacy`);

  const result = await svc.adoptSession(RUNNER_ID, descriptor, true);

  assert.ok(result.ok && result.data);
  const sent = hub.sentOfType("adopt_session");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.requestId, undefined);
  assert.equal(result.data.workspaceId, null);
  assert.equal(result.data.projectId, null);
  assert.equal(result.data.importLocationReady, false);
  assert.equal(db.getAdHocWorkspacePath(result.data.id), null);

  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({
    id: result.data.id,
    workspaceId: null,
    workspacePath: descriptor.cwd,
    adopted: true,
    driver: descriptor.driver,
  })]);
  const hydrated = db.getSession(result.data.id)!;
  assert.equal(hydrated.workspaceId, WORKSPACE_ID);
  assert.ok(hydrated.projectId);
  assert.equal(hydrated.importLocationReady, true);
  assert.equal(db.getAdHocWorkspacePath(hydrated.id), descriptor.cwd);
});

test("adoptSession with a cwd outside every workspace stays under Chats (null)", async () => {
  const { db, svc } = makeHarness();
  const res = await svc.adoptSession(RUNNER_ID, extDescriptor("/somewhere/else"), true);
  assert.ok(res.ok);
  assert.equal(db.getSession(res.data!.id)!.workspaceId, null);
});

test("setWorkspace re-files a session (runner offline is fine), broadcasts, and survives a later snapshot", () => {
  const { db, hub, svc } = makeHarness();
  // A box-owned session hydrated without a workspace; the runner never learns of the manual move.
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({ workspaceId: null })]);
  assert.equal(db.getSession("s_box1")!.workspaceId, null);

  hub.online = false; // the assignment is CP-owned view state — no runner round-trip needed
  const res = svc.setWorkspace("s_box1", WORKSPACE_ID);
  assert.ok(res.ok);
  assert.equal(res.data!.workspaceId, WORKSPACE_ID);
  assert.equal(hub.sessionChangedCalls.at(-1)!.workspaceId, WORKSPACE_ID);

  // The runner's next snapshot still says workspaceId null — updateSessionFromSnapshot must NOT
  // clear the manual assignment (workspace_id is create-time + CP-owned thereafter).
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({ workspaceId: null, status: "running" })]);
  const s = db.getSession("s_box1")!;
  assert.equal(s.status, "running"); // the snapshot applied…
  assert.equal(s.workspaceId, WORKSPACE_ID); // …but the project assignment stuck
});

test("setWorkspace rejects a workspace belonging to a DIFFERENT runner", () => {
  const { db, hub, svc } = makeHarness();
  db.registerRunner(
    {
      ...runnerMeta(),
      runnerId: "runner-2",
      workspaces: [{ id: "ws-other", name: "Other", path: "/repos/other" }],
    },
    Date.now(),
  );
  const id = seedSession(svc, hub); // owned by RUNNER_ID
  const res = svc.setWorkspace(id, "ws-other");
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
  assert.equal(db.getSession(id)!.workspaceId, WORKSPACE_ID, "assignment untouched");
});

test("setWorkspace(null) files the session back under Chats; unknown session is a 404", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub); // created under ws-1
  assert.equal(db.getSession(id)!.workspaceId, WORKSPACE_ID);
  const res = svc.setWorkspace(id, null);
  assert.ok(res.ok);
  assert.equal(db.getSession(id)!.workspaceId, null);
  assert.equal(svc.setWorkspace("nope", null).status, 404);
});

test("setProject moves a session between its exact Project and No Project while offline", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  const location = db.findProjectLocation(RUNNER_ID, WORKSPACE_ID)!;
  hub.online = false;

  const removed = svc.setProject(id, null);
  assert.ok(removed.ok);
  assert.equal(removed.data!.projectId, null);
  assert.equal(removed.data!.projectLocationId, null);

  const restored = svc.setProject(id, location.projectId);
  assert.ok(restored.ok);
  assert.equal(restored.data!.projectId, location.projectId);
  assert.equal(restored.data!.projectLocationId, location.id);
  assert.ok(hub.projectChangedByIdCalls.filter((projectId) => projectId === location.projectId).length >= 2);
});

test("setProject rejects a Project that does not own the session's exact Location", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  const unrelated = db.createProject({ name: "Unrelated" });

  const result = svc.setProject(id, unrelated.id);

  assert.equal(result.status, 409);
  assert.notEqual(db.getSession(id)!.projectId, unrelated.id);
});

test("an adopted session can explicitly link its Location and move while the runner is offline", async () => {
  const { db, hub, svc } = makeHarness();
  const target = db.createProject({ name: "Imported Work", scope: db.runnerScope(RUNNER_ID)! });
  const adopted = await svc.adoptSession(RUNNER_ID, extDescriptor(`${WORKSPACE_PATH}/packages/core`), true);
  assert.ok(adopted.ok && adopted.data);
  hub.online = false;

  const moved = svc.setProject(
    adopted.data.id,
    target.id,
    db.localIdentityContext().userId,
    { linkLocation: true },
  );

  assert.ok(moved.ok && moved.data);
  assert.equal(moved.data.projectId, target.id);
  assert.ok(moved.data.projectLocationId);
  assert.notEqual(moved.data.workspaceId, WORKSPACE_ID, "the reported parent must not become the imported Location");
  const location = db.findProjectLocationForProject(target.id, RUNNER_ID, moved.data.workspaceId!);
  assert.equal(location?.id, moved.data.projectLocationId);
  assert.equal(location?.path, `${WORKSPACE_PATH}/packages/core`);
  assert.equal(db.findProjectLocationForProject(target.id, RUNNER_ID, WORKSPACE_ID), null);
  assert.ok(hub.runnerChangedCalls.includes(RUNNER_ID));
  assert.ok(hub.projectChangedByIdCalls.includes(target.id));
});

test("a workspace-less adopted session creates a managed Location at its authoritative cwd", async () => {
  const { db, svc } = makeHarness();
  const target = db.createProject({ name: "Imported Linux Work", scope: db.runnerScope(RUNNER_ID)! });
  const descriptor = extDescriptor("/home/example/dev/imported-project");
  const adopted = await svc.adoptSession(RUNNER_ID, descriptor, true);
  assert.ok(adopted.ok && adopted.data);
  assert.equal(adopted.data.workspaceId, null);

  const moved = svc.setProject(
    adopted.data.id,
    target.id,
    db.localIdentityContext().userId,
    { linkLocation: true },
  );

  assert.ok(moved.ok && moved.data?.workspaceId);
  const location = db.findProjectLocationForProject(target.id, RUNNER_ID, moved.data.workspaceId);
  assert.ok(location);
  assert.equal(location.path, descriptor.cwd);
  assert.equal(moved.data.projectLocationId, location.id);

  const later = await svc.adoptSession(RUNNER_ID, {
    ...descriptor,
    agentSessionId: "ext-later-same-directory",
    title: "Later import",
  }, true);
  assert.ok(later.ok && later.data);
  assert.equal(later.data.workspaceId, moved.data.workspaceId);
  assert.equal(later.data.projectId, target.id,
    "the newly managed exact Location intentionally controls future import filing in this directory");
});

test("link-and-move is adopted-only and rolls back a Location when audience validation fails", async () => {
  const { db, hub, svc } = makeHarness();
  const ordinary = seedSession(svc, hub, { projectId: null, projectLocationId: null });
  const target = db.createProject({ name: "No Implicit Link", scope: db.runnerScope(RUNNER_ID)! });
  assert.equal(
    svc.setProject(ordinary, target.id, db.localIdentityContext().userId, { linkLocation: true }).status,
    409,
  );
  assert.equal(db.findProjectLocationForProject(target.id, RUNNER_ID, WORKSPACE_ID), null);

  const personal = db.createProject({
    name: "Private Target",
    scope: {
      organizationId: db.localIdentityContext().organizationId,
      owner: { kind: "user", userId: db.localIdentityContext().userId },
    },
  });
  const adopted = await svc.adoptSession(RUNNER_ID, extDescriptor(`${WORKSPACE_PATH}/adopted`), true);
  assert.ok(adopted.ok && adopted.data);
  const rejected = svc.setProject(adopted.data.id, personal.id, undefined, { linkLocation: true });
  assert.equal(rejected.status, 409);
  assert.equal(db.findProjectLocationForProject(personal.id, RUNNER_ID, WORKSPACE_ID), null,
    "the Location insert must roll back with the rejected audience change");
  assert.equal(
    db.listKnownRunnerWorkspaces(RUNNER_ID).some((workspace) => workspace.path === `${WORKSPACE_PATH}/adopted`),
    false,
    "the exact managed Workspace must roll back with the rejected audience change",
  );
});

test("setProject atomically adopts team Project ownership and No Project preserves it", () => {
  const { db, svc } = makeHarness();
  const { project, scope } = makeTeamOwnedProject(db);
  const local = db.localIdentityContext();
  const personalScope: ResourceScope = {
    organizationId: local.organizationId,
    owner: { kind: "user", userId: local.userId },
  };
  const created = svc.createSession({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    projectId: null,
    projectLocationId: null,
    agentId: AGENT_ID,
  }, undefined, personalScope);
  assert.ok(created.ok && created.data);
  assert.deepEqual(db.sessionScope(created.data!.id), personalScope);

  const assigned = svc.setProject(created.data!.id, project.id, local.userId);
  assert.ok(assigned.ok && assigned.data);
  assert.equal(assigned.data!.projectId, project.id);
  assert.deepEqual(db.sessionScope(created.data!.id), scope);

  const removed = svc.setProject(created.data!.id, null);
  assert.ok(removed.ok && removed.data);
  assert.equal(removed.data!.projectId, null);
  assert.deepEqual(db.sessionScope(created.data!.id), scope,
    "removing organization must not implicitly change the session audience");
});

test("setProject preserves a personal audience when filing into a shared organization Project", () => {
  const { db, svc } = makeHarness();
  const local = db.localIdentityContext();
  const project = db.listProjects(true)[0]!;
  const personalScope: ResourceScope = {
    organizationId: local.organizationId,
    owner: { kind: "user", userId: local.userId },
  };
  const created = svc.createSession({
    runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, projectId: null, projectLocationId: null,
    agentId: AGENT_ID,
  }, undefined, personalScope);
  assert.ok(created.ok && created.data);

  const assigned = svc.setProject(created.data!.id, project.id, local.userId);
  assert.ok(assigned.ok && assigned.data);
  assert.equal(assigned.data!.projectId, project.id);
  assert.deepEqual(db.sessionScope(created.data!.id), personalScope,
    "filing does not unnecessarily broaden a personal session to the organization");
});

test("setProject rejects narrowing an organization session into a personal Project", () => {
  const { db, svc } = makeHarness();
  const local = db.localIdentityContext();
  const migrated = db.listProjects(true)[0]!;
  const location = migrated.locations[0]!;
  const personalScope: ResourceScope = {
    organizationId: local.organizationId,
    owner: { kind: "user", userId: local.userId },
  };
  const personal = db.createProject({ name: "Personal", scope: personalScope, now: 10 });
  assert.ok(db.moveProjectLocation(location.id, personal.id, 11));
  const organizationScope = db.runnerScope(RUNNER_ID)!;
  const created = svc.createSession({
    runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, projectId: null, projectLocationId: null,
    agentId: AGENT_ID,
  }, undefined, organizationScope);
  assert.ok(created.ok && created.data);

  const assigned = svc.setProject(created.data!.id, personal.id, local.userId);
  assert.equal(assigned.ok, false);
  assert.equal(assigned.status, 409);
  assert.equal(db.getSession(created.data!.id)!.projectId, null);
  assert.deepEqual(db.sessionScope(created.data!.id), organizationScope);
});

test("setSessionProject validates execution scope even without a Project Location", () => {
  const { db, svc } = makeHarness();
  const local = db.localIdentityContext();
  const personalScope: ResourceScope = {
    organizationId: local.organizationId,
    owner: { kind: "user", userId: local.userId },
  };
  assert.equal(db.setResourceScope({
    resource: "workspace", runnerId: RUNNER_ID, resourceId: WORKSPACE_ID,
    scope: personalScope, now: 10,
  }), true);
  const organizationProject = db.createProject({
    name: "Organization Project",
    scope: { organizationId: local.organizationId, owner: {
      kind: "organization", organizationId: local.organizationId,
    } },
    now: 11,
  });
  const created = svc.createSession({
    runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, projectId: null, projectLocationId: null,
    agentId: AGENT_ID,
  }, undefined, personalScope);
  assert.ok(created.ok && created.data);

  assert.throws(() => db.setSessionProject(created.data!.id, organizationProject.id, null, 12),
    /project access would expose the execution Location/);
  assert.equal(db.getSession(created.data!.id)!.projectId, null);
});

test("setWorkspace never changes restart()'s launch directory (move is view state only)", () => {
  const { hub, svc, db } = makeHarness();
  // A second workspace on the SAME runner, so the move itself is legal.
  db.registerRunner(
    {
      ...runnerMeta(),
      workspaces: [
        { id: WORKSPACE_ID, name: "Demo", path: WORKSPACE_PATH },
        { id: "ws-2", name: "Two", path: "/repos/two" },
      ],
    },
    Date.now(),
  );
  // Created during the current runner connection: workspace_path is NULL in the cache, so
  // restart's resolution rides workspace_id — the exact state the pin exists for.
  const id = seedSession(svc, hub); // under ws-1
  assert.equal(db.getAdHocWorkspacePath(id), null);

  // Move to ws-2, then restart: the agent must relaunch in ws-1's directory, not ws-2's.
  assert.ok(svc.setWorkspace(id, "ws-2").ok);
  assert.ok(svc.restart(id).ok);
  assert.equal(hub.sentOfType("start_session").at(-1)!.spec.workspacePath, WORKSPACE_PATH);

  // Move to Chats (null): restart must not 400 on "no resolvable workspace" — the pinned
  // launch dir keeps it relaunching where it always ran.
  assert.ok(svc.setWorkspace(id, null).ok);
  const r = svc.restart(id);
  assert.ok(r.ok, r.error);
  assert.equal(hub.sentOfType("start_session").at(-1)!.spec.workspacePath, WORKSPACE_PATH);
});

test("createRun does not append the user_message locally and passes a title to the runner (M6)", () => {
  const { hub, svc } = makeHarness();
  const res = svc.createRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentIds: [AGENT_ID],
    task: "do the thing",
  });
  assert.ok(res.ok);
  // The runner owns the user_message now — the control plane must not emit a duplicate.
  assert.equal(hub.sessionEventCalls.filter((e) => e.payload.kind === "user_message").length, 0);
  const start = hub.sentOfType("start_session")[0];
  assert.ok(start.spec.title?.includes(AGENT_ID));
  assert.equal(start.initialPrompt, "do the thing");
});

test("createRun applies a run-level cost budget to every member session", () => {
  const { db, svc } = makeHarness();
  const res = svc.createRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentIds: [AGENT_ID],
    task: "do the thing",
    costBudgetUsd: 3,
  });
  assert.ok(res.ok && res.data);
  assert.ok(res.data!.sessions.length > 0);
  for (const s of res.data!.sessions) {
    assert.equal(db.getSession(s.id)!.costBudgetUsd, 3);
  }
});

/* -------------------------------------------------------------------------- */
/* Phase 8: max_tool_calls policy cards + v47 runner re-arm                   */
/* -------------------------------------------------------------------------- */

test("setConfig persists a tool-call limit in its own column and clears on 0", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { config: { model: "opus" } });
  svc.setConfig(id, { maxToolCalls: 4 });
  let s = db.getSession(id)!;
  assert.equal(s.maxToolCalls, 4);
  assert.equal(s.model, "opus");
  // Omitting it in a later config write must not clear it.
  svc.setConfig(id, { model: "sonnet" });
  s = db.getSession(id)!;
  assert.equal(s.maxToolCalls, 4);
  // Fractional input floors; 0 clears (unlimited).
  svc.setConfig(id, { maxToolCalls: 2.9 });
  assert.equal(db.getSession(id)!.maxToolCalls, 2);
  svc.setConfig(id, { maxToolCalls: 0 });
  assert.equal(db.getSession(id)!.maxToolCalls, null);
});

test("crossing the tool-call limit parks the session at turn settle", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { maxToolCalls: 2 });
  db.updateSessionStatus(id, "running", Date.now());

  svc.onSessionEvent(id, { kind: "tool_call", toolCallId: "t1", title: "Read", status: "completed" });
  svc.onSessionEvent(id, { kind: "tool_call", toolCallId: "t2", title: "Write", status: "completed" });
  svc.onSessionStatus(id, "idle"); // settle -> gate fires

  const s = db.getSession(id)!;
  assert.equal(s.status, "input_required");
  assert.equal(s.pendingApproval?.kind, "max_tool_calls");
  assert.match(s.pendingApproval!.title, /Tool-call limit reached — 2 of 2/);
  assert.equal(s.toolCallCount, 2);
});

test("tool-call counting dedupes repeated frames for the same toolCallId", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { maxToolCalls: 2 });
  db.updateSessionStatus(id, "running", Date.now());

  // claude-code emits a tool_call frame per status change of the SAME invocation.
  svc.onSessionEvent(id, { kind: "tool_call", toolCallId: "t1", title: "Read", status: "pending" });
  svc.onSessionEvent(id, { kind: "tool_call", toolCallId: "t1", title: "Read", status: "completed" });
  svc.onSessionStatus(id, "idle");
  assert.equal(db.getSession(id)!.pendingApproval, null, "one invocation, not two");

  svc.onSessionEvent(id, { kind: "tool_call", toolCallId: "t2", title: "Write", status: "completed" });
  svc.onSessionStatus(id, "idle");
  assert.equal(db.getSession(id)!.pendingApproval?.kind, "max_tool_calls");
});

test("a trailing idle keeps the same tool-call pause (no re-ask while parked)", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { maxToolCalls: 1 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "tool_call", toolCallId: "t1", title: "Read", status: "completed" });
  svc.onSessionStatus(id, "idle");
  const first = db.getSession(id)!.pendingApproval!.requestId;

  svc.onSessionStatus(id, "idle"); // another settle report
  const s = db.getSession(id)!;
  assert.equal(s.status, "input_required");
  assert.equal(s.pendingApproval!.requestId, first);
});

test("prompt() is blocked while parked on the tool-call limit", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { maxToolCalls: 1 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "tool_call", toolCallId: "t1", title: "Read", status: "completed" });
  svc.onSessionStatus(id, "idle");

  const res = svc.prompt(id, "keep going");
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.match(res.error ?? "", /tool-call limit/i);
});

test("approve(continue) re-arms the next tool-call window; approve(cancel) stops", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { maxToolCalls: 1 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "tool_call", toolCallId: "t1", title: "Read", status: "completed" });
  svc.onSessionStatus(id, "idle");
  const reqId = db.getSession(id)!.pendingApproval!.requestId;

  const before = hub.sentOfType("resolve_permission").length;
  const res = svc.approve(id, reqId, "continue");
  assert.ok(res.ok);
  let s = db.getSession(id)!;
  assert.equal(s.pendingApproval, null);
  assert.equal(s.maxToolCalls, 2); // one observed + the original one-call window
  assert.equal(s.maxToolCallsStep, 1);
  assert.equal(s.status, "idle");
  assert.deepEqual(hub.sentOfType("rearm_governance").at(-1)!.config, { maxToolCalls: 2 });
  assert.equal(hub.sentOfType("resolve_permission").length, before, "never route through provider permission");

  // Use the newly re-armed window, trip again at two calls, then cancel.
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "tool_call", toolCallId: "t2", title: "Edit", status: "completed" });
  svc.onSessionStatus(id, "idle");
  const reqId2 = db.getSession(id)!.pendingApproval!.requestId;
  svc.approve(id, reqId2, "cancel");
  s = db.getSession(id)!;
  assert.equal(s.status, "stopped");
  assert.equal(hub.sentOfType("stop_session").filter((m) => m.sessionId === id).length, 1);
});

test("serialized asks: cost card first, then the tool-call card right after Continue", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { costBudgetUsd: 5, maxToolCalls: 1 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "tool_call", toolCallId: "t1", title: "Read", status: "completed" });
  svc.onSessionEvent(id, { kind: "token_usage", costUsd: 6 }); // both rules now tripped

  let s = db.getSession(id)!;
  assert.equal(s.pendingApproval?.kind, "cost_budget", "cost wins the slot");

  svc.approve(id, s.pendingApproval!.requestId, "continue");
  s = db.getSession(id)!;
  // The budget re-armed, but the tool-call rule is still tripped — parked again immediately and
  // the runner is explicitly told to keep its queue held for that serialized rule.
  assert.equal(s.status, "input_required");
  assert.equal(s.pendingApproval?.kind, "max_tool_calls");
  assert.equal(hub.sentOfType("rearm_governance").at(-1)!.holdFor, "max_tool_calls");
});

test("a CP-only tool-call pause survives a runner snapshot (not clobbered on hydrate)", () => {
  const { db, svc } = makeHarness();
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot()]);
  db.setPendingApproval("s_box1", {
    requestId: "max-tool-calls:s_box1:1",
    kind: "max_tool_calls",
    title: "limit reached",
    options: [],
  });
  db.updateSessionStatus("s_box1", "input_required", Date.now());

  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({ status: "idle", pendingApproval: null })]);
  const s = db.getSession("s_box1")!;
  assert.equal(s.status, "input_required");
  assert.equal(s.pendingApproval?.kind, "max_tool_calls");
});

test("hydrated/backfilled tool_call events count toward the limit (derived counter)", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { maxToolCalls: 2 });
  // Backfill path: events appended straight to the DB (fetchHistoryOnce), bypassing onSessionEvent.
  db.appendEvent(id, { kind: "tool_call", toolCallId: "h1", title: "Bash", status: "completed" }, Date.now());
  db.appendEvent(id, { kind: "tool_call", toolCallId: "h2", title: "Edit", status: "completed" }, Date.now());

  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionStatus(id, "idle");
  assert.equal(db.getSession(id)!.pendingApproval?.kind, "max_tool_calls");
});

test("createRun applies a run-level tool-call limit to every member session", () => {
  const { db, svc } = makeHarness();
  const res = svc.createRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentIds: [AGENT_ID],
    task: "do the thing",
    maxToolCalls: 7,
  });
  assert.ok(res.ok && res.data);
  for (const s of res.data!.sessions) {
    assert.equal(db.getSession(s.id)!.maxToolCalls, 7);
  }
});


/* -------------------------------------------------------------------------- */
/* Phase 8 review regressions                                                 */
/* -------------------------------------------------------------------------- */

test("setConfig floors fractional maxToolCalls BEFORE the positivity check (0.5 clears, no phantom 0)", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { maxToolCalls: 0.5 });
  assert.equal(db.getSession(id)!.maxToolCalls, null, "0.5 floors to 0 and clears");
});

test("raising a guardrail while parked re-evaluates: stale card cleared, new limit preserved", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { maxToolCalls: 1 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "tool_call", toolCallId: "t1", title: "Read", status: "completed" });
  svc.onSessionStatus(id, "idle");
  assert.equal(db.getSession(id)!.pendingApproval?.kind, "max_tool_calls");
  const first = db.getSession(id)!.pendingApproval!.requestId;

  hub.sentToRunner.length = 0;
  svc.setConfig(id, { maxToolCalls: 20 }, { kind: "human", id: "device-settings" });
  const s = db.getSession(id)!;
  assert.equal(s.pendingApproval, null, "stale card dropped — rule no longer trips");
  assert.equal(s.status, "idle");
  assert.equal(s.maxToolCalls, 20, "the raised limit survives (no blind Continue clear)");
  assert.deepEqual(hub.sentOfType("rearm_governance").at(-1)!.config, { maxToolCalls: 20 });
  assert.equal(hub.sentOfType("rearm_governance").at(-1)!.holdFor, undefined);
  const resolution = svc.governanceAudit(id).find((entry) => entry.requestId === first && entry.stage === "resolution")!;
  assert.equal(resolution.outcome, "dismissed");
  assert.deepEqual(resolution.actor, { kind: "human", id: "device-settings" });
  assert.ok(svc.prompt(id, "go on").ok, "composer unlocked");
});

test("lowering a guardrail while parked swaps in a fresh card (still tripping)", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { costBudgetUsd: 5 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "token_usage", costUsd: 6 });
  const first = db.getSession(id)!.pendingApproval!.requestId;

  svc.setConfig(id, { costBudgetUsd: 4 }); // still over budget
  const s = db.getSession(id)!;
  assert.equal(s.status, "input_required");
  assert.equal(s.pendingApproval?.kind, "cost_budget");
  assert.equal(s.costBudgetUsd, 4, "the lowered budget persisted");
  assert.match(s.pendingApproval!.title, /\$4\.00/, "the card reflects the fresh evaluation");
  assert.equal(hub.sentOfType("rearm_governance").at(-1)!.holdFor, "cost_budget");
  assert.deepEqual(hub.sentOfType("rearm_governance").at(-1)!.config, { costBudgetUsd: 4 });
  assert.ok(svc.governanceAudit(id).some(
    (entry) => entry.requestId === first && entry.stage === "resolution" && entry.outcome === "dismissed",
  ));
  assert.ok(first, "was parked before the change too");
});

test("a parked settings re-arm rolls back config when the v47 runner cannot receive it", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub, { config: { model: "sonnet" } });
  svc.setConfig(id, { maxToolCalls: 1 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "tool_call", toolCallId: "t1", title: "Read", status: "completed" });
  svc.onSessionStatus(id, "idle");
  const pending = db.getSession(id)!.pendingApproval!;
  hub.deliver = false;

  const res = svc.setConfig(id, { model: "opus", maxToolCalls: 20 });
  assert.equal(res.ok, false);
  const session = db.getSession(id)!;
  assert.equal(session.model, "sonnet");
  assert.equal(session.maxToolCalls, 1);
  assert.equal(session.maxToolCallsStep, 1);
  assert.equal(session.pendingApproval?.requestId, pending.requestId);
  const failure = svc.governanceAudit(id).find(
    (entry) => entry.requestId === pending.requestId && entry.stage === "resolution",
  )!;
  assert.equal(failure.outcome, "delivery_failed");
});

test("a runner permission card displacing a policy pause re-parks the guardrail after resolution", () => {
  const { db, hub, svc } = makeHarness();
  const id = seedSession(svc, hub);
  svc.setConfig(id, { costBudgetUsd: 5 });
  db.updateSessionStatus(id, "running", Date.now());
  svc.onSessionEvent(id, { kind: "token_usage", costUsd: 6 }); // policy card parked mid-turn
  assert.equal(db.getSession(id)!.pendingApproval?.kind, "cost_budget");

  // The still-running agent asks for a tool permission — it takes the slot (the agent is blocked).
  svc.onSessionEvent(id, {
    kind: "permission_request",
    requestId: "perm1",
    title: "Allow Bash?",
    options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
  });
  assert.equal(db.getSession(id)!.pendingApproval?.kind, undefined, "runner card holds the slot");

  // Answering it must immediately re-park the guardrail, not leave the 409 guard skipped.
  svc.approve(id, "perm1", "yes");
  let s = db.getSession(id)!;
  assert.equal(s.status, "input_required");
  assert.equal(s.pendingApproval?.kind, "cost_budget");
  assert.equal(svc.prompt(id, "more").ok, false);

  // The runner's trailing permission_resolved must not wipe the re-parked policy card.
  svc.onSessionEvent(id, { kind: "permission_resolved", requestId: "perm1", optionId: "yes" });
  s = db.getSession(id)!;
  assert.equal(s.pendingApproval?.kind, "cost_budget");
});

test("a runner flap cannot dismiss a policy pause: hydration re-derives it", () => {
  const { db, svc } = makeHarness();
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot()]);
  db.updateSessionCostBudget("s_box1", 5, Date.now());
  db.addSessionUsage("s_box1", { inputTokens: 0, outputTokens: 0, costUsd: 6 }, Date.now());
  db.updateSessionStatus("s_box1", "running", Date.now());
  svc.onSessionStatus("s_box1", "idle"); // parks
  assert.equal(db.getSession("s_box1")!.pendingApproval?.kind, "cost_budget");

  svc.failRunnerSessions(RUNNER_ID); // disconnect wipes the card (status -> stopped)
  assert.equal(db.getSession("s_box1")!.pendingApproval, null);

  // Reconnect: the snapshot says idle/no pending — the gate must re-derive the pause. The box
  // owns usage, so the snapshot carries the real accumulated cost.
  svc.hydrateRunnerSessions(RUNNER_ID, [snapshot({ status: "idle", pendingApproval: null, costUsd: 6 })]);
  const s = db.getSession("s_box1")!;
  assert.equal(s.status, "input_required");
  assert.equal(s.pendingApproval?.kind, "cost_budget");
  assert.equal(svc.prompt("s_box1", "again").ok, false);
});

/* -------------------------------------------------------------------------- */
/* Push-to-wake: the notify hook fires on attention transitions               */
/* -------------------------------------------------------------------------- */

test("notify hook: fires with the ask on input_required, on settle, on failure — and never on non-transitions", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now());
  const hub = new FakeHub();
  // Compose exactly like index.ts: raw (prev, view) through the pure decision.
  const sent: { title: string; body: string; sessionId: string; urgency: string }[] = [];
  const svc = new SessionsService(db, hub as unknown as Hub, NOOP_LOG, (prev, view) => {
    const msg = pushDecision(prev, view);
    if (msg) sent.push(msg);
  });
  const id = svc.createSession({ runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID, prompt: "go" })
    .data!.id;

  svc.onSessionStatus(id, "running");
  assert.equal(sent.length, 0, "starting→running is not an attention moment");

  // A permission request notifies immediately, carrying the ask's title, at high urgency.
  svc.onSessionEvent(id, {
    kind: "permission_request",
    requestId: "req1",
    title: "Run npm install?",
    options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.title, /needs your input/);
  assert.match(sent[0]!.body, /Run npm install\?/);
  assert.equal(sent[0]!.urgency, "high");

  // The runner's trailing input_required status event is a NON-transition — no duplicate.
  svc.onSessionStatus(id, "input_required");
  assert.equal(sent.length, 1, "duplicate input_required must not re-notify");

  // Approve (→ running), then the turn settles: exactly one "ready".
  svc.approve(id, "req1", "yes");
  svc.onSessionEvent(id, { kind: "permission_resolved", requestId: "req1", optionId: "yes" });
  assert.equal(sent.length, 1, "approving is the user's own action — no notification");
  svc.onSessionStatus(id, "idle");
  assert.equal(sent.length, 2);
  assert.match(sent[1]!.title, /is ready/);

  // Failure notifies; a stale post-terminal status does not (early return preserves terminal).
  svc.onSessionStatus(id, "failed", "boom");
  assert.equal(sent.length, 3);
  assert.match(sent[2]!.title, /failed/);
  svc.onSessionStatus(id, "idle");
  assert.equal(sent.length, 3, "terminal sessions never notify again");
});

test("notify hook: a mid-turn guardrail park notifies with the policy ask", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now());
  const hub = new FakeHub();
  const sent: { title: string; urgency: string; body: string }[] = [];
  const svc = new SessionsService(db, hub as unknown as Hub, NOOP_LOG, (prev, view) => {
    const msg = pushDecision(prev, view);
    if (msg) sent.push(msg);
  });
  const id = svc.createSession({ runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID, prompt: "go" })
    .data!.id;
  db.updateSessionCostBudget(id, 1, Date.now());
  svc.onSessionStatus(id, "running");

  // Usage trips the budget mid-turn → the gate parks the session → one high-urgency push.
  svc.onSessionEvent(id, { kind: "token_usage", inputTokens: 10, outputTokens: 10, costUsd: 2 });
  assert.equal(db.getSession(id)!.status, "input_required");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.title, /needs your input/);
  assert.equal(sent[0]!.urgency, "high");

  // Further usage while parked: no transition, no spam.
  svc.onSessionEvent(id, { kind: "token_usage", inputTokens: 10, outputTokens: 10, costUsd: 1 });
  assert.equal(sent.length, 1);
});

test("notify hook: a permission ask that displaces a guardrail park re-notifies with the new ask", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now());
  const hub = new FakeHub();
  const sent: { body: string }[] = [];
  const svc = new SessionsService(db, hub as unknown as Hub, NOOP_LOG, (prev, view) => {
    const msg = pushDecision(prev, view);
    if (msg) sent.push(msg);
  });
  const id = svc.createSession({ runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID, prompt: "go" })
    .data!.id;
  db.updateSessionCostBudget(id, 1, Date.now());
  svc.onSessionStatus(id, "running");
  svc.onSessionEvent(id, { kind: "token_usage", inputTokens: 1, outputTokens: 1, costUsd: 2 });
  assert.equal(sent.length, 1, "guardrail park notifies");

  // The user continues past the budget; the still-running agent then asks a permission.
  const pol = db.getSession(id)!.pendingApproval!;
  svc.approve(id, pol.requestId, "continue");
  svc.onSessionStatus(id, "running");
  svc.onSessionEvent(id, {
    kind: "permission_request",
    requestId: "perm9",
    title: "Run the deploy script?",
    options: [{ optionId: "y", name: "Allow", kind: "allow_once" }],
  });
  assert.equal(sent.length, 2, "the new ask re-notifies even though status stayed input_required-adjacent");
  assert.match(sent[1]!.body, /deploy script/);
  // The runner's trailing status frame for the SAME ask stays silent.
  svc.onSessionStatus(id, "input_required");
  assert.equal(sent.length, 2);
});

test("restoring swallowed hook idle replays workflow settlement and notification", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const hub = new FakeHub();
  const sent: Array<{ body: string }> = [];
  const svc = new SessionsService(db, hub as unknown as Hub, NOOP_LOG, (previous, view) => {
    const message = pushDecision(previous, view);
    if (message) sent.push(message);
  });
  const runResult = svc.createRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    agentIds: [AGENT_ID, CODEX_APP_AGENT_ID],
    task: "Exercise restored settlement",
  });
  assert.ok(runResult.ok && runResult.data);
  const run = runResult.data!.run;
  for (const session of runResult.data!.sessions) db.updateSessionStatus(session.id, "idle", Date.now());
  const definition = svc.workflowDefinitions().data!
    .find((candidate) => candidate.workflowId === "builtin:build-review")!;
  const instance = svc.createWorkflowInstance({
    workflowId: definition.workflowId,
    runId: run.id,
  }).data!;
  const dispatched = svc.dispatchWorkflowNode(instance.instanceId, "build", {
    dispatchKey: "restored-settlement:1",
  }).data!.attempt;
  const buildSession = db.runMemberSessions(run.id, AGENT_ID)[0]!;
  assert.equal(db.getWorkflowAttempt(dispatched.attemptId)!.status, "running");
  assert.ok(svc.upsertGovernancePolicy({
    policyId: "ask-workflow-restored-idle",
    name: "Ask During Workflow Build",
    effect: "ask",
    priority: 100,
    enabled: true,
    scope: { toolName: "Write" },
  }).ok);
  const asked = svc.evaluatePolicyHook(buildSession.id, {
    hookEventName: "PreToolUse",
    providerSessionId: "provider-workflow-settlement",
    permissionMode: "plan",
    toolUseId: "workflow-settlement-write",
    context: { toolName: "Write" },
  }, true).data!;
  svc.onSessionStatus(buildSession.id, "idle");
  assert.equal(
    db.getWorkflowAttempt(dispatched.attemptId)!.status,
    "running",
    "the visible hook card swallows the runner idle until its decision",
  );
  const notificationCountBeforeResolution = sent.length;

  assert.ok(svc.approve(buildSession.id, asked.approvalRequestId!, "allow").ok);
  assert.equal(db.getSession(buildSession.id)!.status, "idle");
  assert.equal(db.getWorkflowAttempt(dispatched.attemptId)!.status, "awaiting_output");
  assert.equal(sent.length, notificationCountBeforeResolution + 1);
  assert.match(sent.at(-1)!.body, /ready|finished|complete/i);
  db.close();
});

test("workflow execution dispatches exactly once and advances the build-review artifact loop", () => {
  const { db, hub, svc } = makeHarness();
  const runResult = svc.createRun({ runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentIds: [AGENT_ID, CODEX_APP_AGENT_ID], task: "Implement the feature" });
  assert.equal(runResult.ok, true);
  const run = runResult.data!.run;
  for (const session of runResult.data!.sessions) db.updateSessionStatus(session.id, "idle", Date.now());
  const builtinResult = svc.workflowDefinitions();
  const definition = builtinResult.data!.find((candidate) => candidate.workflowId === "builtin:build-review")!;
  const instanceResult = svc.createWorkflowInstance({ workflowId: definition.workflowId, runId: run.id }, { kind: "human", id: "device-1" });
  const instance = instanceResult.data!;

  const beforeDispatch = hub.sentToRunner.length;
  const dispatched = svc.dispatchWorkflowNode(instance.instanceId, "build", { dispatchKey: "build:1" }, { kind: "human", id: "device-1" });
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.data!.attempt.status, "running");
  assert.equal(hub.sentToRunner.length, beforeDispatch + 1);
  const duplicate = svc.dispatchWorkflowNode(instance.instanceId, "build", { dispatchKey: "build:1" }, { kind: "human", id: "device-1" });
  assert.equal(duplicate.data!.idempotent, true);
  assert.equal(hub.sentToRunner.length, beforeDispatch + 1);

  const buildSession = db.runMemberSessions(run.id, AGENT_ID)[0]!;
  svc.onSessionStatus(buildSession.id, "idle");
  assert.equal(db.getWorkflowAttempt(dispatched.data!.attempt.attemptId)!.status, "awaiting_output");
  const patch = svc.createWorkflowArtifact({
    runId: run.id, sessionId: buildSession.id, kind: "patch", name: "implementation.diff",
    mimeType: "text/x-diff", encoding: "utf8", data: "diff --git a/a b/a\n+done\n",
  }, { kind: "agent", id: AGENT_ID });
  assert.equal(patch.ok, true);
  const buildComplete = svc.completeWorkflowAttempt(dispatched.data!.attempt.attemptId, {
    outcome: "success", outputs: { implementation_patch: patch.data!.artifactId },
  }, { kind: "agent", id: AGENT_ID });
  assert.equal(buildComplete.ok, true);
  assert.equal(buildComplete.data!.nodeStates.find((state) => state.nodeId === "review")!.status, "ready");

  const review = svc.dispatchWorkflowNode(instance.instanceId, "review", { dispatchKey: "review:1" }, { kind: "system", id: "scheduler" });
  assert.equal(review.ok, true);
  assert.match((hub.lastSent() as Extract<ControlPlaneToRunner, { type: "prompt_session" }>).text, /implementation\.diff|diff --git/);
  const reviewSession = db.runMemberSessions(run.id, CODEX_APP_AGENT_ID)[0]!;
  svc.onSessionStatus(reviewSession.id, "idle");
  const report = svc.createWorkflowArtifact({
    runId: run.id, sessionId: reviewSession.id, kind: "review_report", name: "review.md",
    mimeType: "text/markdown", encoding: "utf8", data: "Please fix the edge case.",
  }, { kind: "agent", id: CODEX_APP_AGENT_ID });
  const verdict = svc.createWorkflowArtifact({
    runId: run.id, sessionId: reviewSession.id, kind: "verdict", name: "verdict.json",
    mimeType: "application/json", encoding: "json", data: JSON.stringify({ outcome: "changes_requested" }),
  }, { kind: "agent", id: CODEX_APP_AGENT_ID });
  const reviewed = svc.completeWorkflowAttempt(review.data!.attempt.attemptId, {
    outcome: "changes_requested",
    outputs: { review_report: report.data!.artifactId, review_verdict: verdict.data!.artifactId },
  }, { kind: "agent", id: CODEX_APP_AGENT_ID });
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.data!.nodeStates.find((state) => state.nodeId === "address")!.status, "ready");
  assert.deepEqual(Object.keys(db.workflowAttemptOutputs(review.data!.attempt.attemptId)).sort(), ["review_report", "review_verdict"]);
  db.close();
});

test("workflow durable delivery stages every deterministic start before resource writes", () => {
  const { db, hub, svc } = makeHarness();
  const local = db.localIdentityContext();
  const userScope = {
    organizationId: local.organizationId,
    owner: { kind: "user" as const, userId: local.userId },
  };
  assert.equal(db.setResourceScope({
    resource: "workspace", runnerId: RUNNER_ID, resourceId: WORKSPACE_ID, scope: userScope, now: 1,
  }), true);
  const order: string[] = [];
  let staged: PreStagedDeliveryPlan | undefined;
  const request = {
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: "builtin:build-review",
    task: "Build and review durably",
    agentBindings: { claude: AGENT_ID, codex: CODEX_APP_AGENT_ID },
    orchestratorAgentId: CONDUCTOR_ID,
  };
  const delivery = {
    runId: "r_automation_exact",
    workflowInstanceId: "wfi_automation_exact",
    memberSessionId: (index: number) => `s_automation_member_${index}`,
    stage(plan: PreStagedDeliveryPlan) {
      order.push("stage");
      const firstMaterialization = staged === undefined;
      staged = plan;
      if (firstMaterialization) {
        assert.equal(db.getRun("r_automation_exact"), null);
        assert.equal(db.getWorkflowInstance("wfi_automation_exact"), null);
        for (let index = 0; index < 3; index++) {
          assert.equal(db.getSession(`s_automation_member_${index}`), null);
        }
      }
    },
    activate(plan: PreStagedDeliveryPlan) {
      order.push("activate");
      assert.strictEqual(plan, staged);
      assert.ok(db.getRun("r_automation_exact"));
      assert.ok(db.getWorkflowInstance("wfi_automation_exact"));
      for (const command of plan.commands) assert.ok(db.getSession(command.spec.sessionId));
    },
  };

  const created = svc.createWorkflowRun(request, { kind: "system", id: "automation:test" }, delivery);
  assert.equal(created.status, 201);
  assert.deepEqual(order, ["stage", "activate"]);
  assert.equal(created.data!.run.id, "r_automation_exact");
  assert.equal(created.data!.instance.instanceId, "wfi_automation_exact");
  assert.equal(staged!.commands.length, 3);
  assert.deepEqual(staged!.commands.map((command) => command.spec.sessionId), [
    "s_automation_member_0", "s_automation_member_1", "s_automation_member_2",
  ]);
  assert.equal(staged!.commands.filter((command) => command.initialPrompt !== undefined).length, 1);
  const orchestrator = staged!.commands.at(-1)!;
  assert.match(orchestrator.initialPrompt!, /wfi_automation_exact/);
  assert.match(orchestrator.initialPrompt!, /r_automation_exact/);
  assert.equal(orchestrator.spec.agentId, CONDUCTOR_ID);
  assert.deepEqual(db.sessionScope(orchestrator.spec.sessionId)?.owner, {
    kind: "organization", organizationId: local.organizationId,
  });
  for (const worker of staged!.commands.slice(0, -1)) {
    assert.deepEqual(db.sessionScope(worker.spec.sessionId), userScope);
  }
  assert.equal(hub.sentOfType("start_session").length, 0);

  order.length = 0;
  const recovered = svc.createWorkflowRun(request, { kind: "system", id: "automation:test" }, delivery);
  assert.equal(recovered.status, 201);
  assert.deepEqual(order, ["stage", "activate"]);
  assert.equal(db.listRuns().filter((run) => run.id === "r_automation_exact").length, 1);
  assert.equal(created.data!.sessions.length, recovered.data!.sessions.length);

  let conflictStaged = false;
  const conflict = svc.createWorkflowRun({ ...request, title: "conflict" }, { kind: "system", id: "automation:test" }, {
    ...delivery,
    stage() { conflictStaged = true; },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflictStaged, false);
  db.close();
});

test("workflow recovery cannot resurrect a conductor orchestrator removed from current discovery", () => {
  const { db, svc } = makeHarness();
  const request = {
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: "builtin:build-review",
    task: "Recover orchestration durably",
    agentBindings: { claude: AGENT_ID, codex: CODEX_APP_AGENT_ID },
    orchestratorAgentId: CONDUCTOR_ID,
  };
  const deliveryIds = {
    runId: "r_disabled_conductor",
    workflowInstanceId: "wfi_disabled_conductor",
    memberSessionId: (index: number) => `s_disabled_conductor_member_${index}`,
  };
  let staged: PreStagedDeliveryPlan | undefined;

  assert.throws(() => svc.createWorkflowRun(request, { kind: "system", id: "automation:test" }, {
    ...deliveryIds,
    stage(plan) {
      staged = plan;
      throw new Error("simulated crash after durable workflow staging");
    },
    activate() { assert.fail("must not activate before materialization"); },
  }), /simulated crash/);
  assert.equal(db.getRun(deliveryIds.runId), null);
  assert.equal(db.getWorkflowInstance(deliveryIds.workflowInstanceId), null);
  for (let index = 0; index < 3; index++) {
    assert.equal(db.getSession(deliveryIds.memberSessionId(index)), null);
  }

  const current = runnerMeta();
  current.agents = current.agents.filter((agent) => agent.id !== CONDUCTOR_ID);
  db.updateRunnerAgents(RUNNER_ID, current.agents, 500);

  let restaged = false;
  const recovered = svc.createWorkflowRun(request, { kind: "system", id: "automation:test" }, {
    ...deliveryIds,
    commandSnapshots: staged!.commands,
    stage() { restaged = true; },
    activate() { assert.fail("disabled conductor workflow recovery must not activate"); },
  });
  assert.equal(recovered.status, 404);
  assert.match(recovered.error ?? "", /unknown orchestrator agent 'conductor'/);
  assert.equal(restaged, false);
  assert.equal(db.getRun(deliveryIds.runId), null);
  assert.equal(db.getWorkflowInstance(deliveryIds.workflowInstanceId), null);
  for (let index = 0; index < 3; index++) {
    assert.equal(db.getSession(deliveryIds.memberSessionId(index)), null);
  }
  db.close();
});

test("workflow runs preserve an exact Project Location for every member", () => {
  const { db, svc } = makeHarness();
  const location = db.findProjectLocation(RUNNER_ID, WORKSPACE_ID)!;

  const created = svc.createWorkflowRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    projectId: location.projectId,
    projectLocationId: location.id,
    workflowId: "builtin:build-review",
    task: "Implement and review in one Project",
    agentBindings: { claude: AGENT_ID, codex: CODEX_APP_AGENT_ID },
    orchestratorAgentId: CONDUCTOR_ID,
  });

  assert.ok(created.ok && created.data);
  for (const session of created.data!.sessions) {
    assert.equal(session.projectId, location.projectId);
    assert.equal(session.projectLocationId, location.id);
  }
});

test("workflow workers adopt team Project scope while a trusted orchestrator stays organization-scoped", () => {
  const { db, svc } = makeHarness();
  const { project, location, scope } = makeTeamOwnedProject(db);
  const request = {
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    projectId: project.id,
    projectLocationId: location.id,
    workflowId: "builtin:build-review",
    task: "Implement and review for the Project team",
    agentBindings: { claude: AGENT_ID, codex: CODEX_APP_AGENT_ID },
  };

  const workerOnly = svc.createWorkflowRun(request);
  assert.ok(workerOnly.ok && workerOnly.data);
  for (const session of workerOnly.data!.sessions) {
    assert.equal(session.projectId, project.id);
    assert.deepEqual(db.sessionScope(session.id), scope);
  }

  const withOrchestrator = svc.createWorkflowRun({ ...request, orchestratorAgentId: CONDUCTOR_ID });
  assert.ok(withOrchestrator.ok && withOrchestrator.data);
  const orchestrator = withOrchestrator.data!.sessions.find((session) => session.agentId === CONDUCTOR_ID)!;
  const workers = withOrchestrator.data!.sessions.filter((session) => session.agentId !== CONDUCTOR_ID);
  assert.equal(orchestrator.projectId, null);
  assert.equal(db.sessionScope(orchestrator.id)?.owner.kind, "organization");
  for (const session of workers) {
    assert.equal(session.projectId, project.id);
    assert.deepEqual(db.sessionScope(session.id), scope);
  }
});

test("workflow runs reject a mismatched exact Project Location before persistence", () => {
  const { db, svc } = makeHarness();
  const location = db.findProjectLocation(RUNNER_ID, WORKSPACE_ID)!;
  const unrelated = db.createProject({ name: "Unrelated" });

  const result = svc.createWorkflowRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    projectId: unrelated.id,
    projectLocationId: location.id,
    workflowId: "builtin:build-review",
    task: "Do not misfile this workflow",
  });

  assert.equal(result.status, 409);
  assert.equal(db.listRuns().length, 0);
  assert.equal(db.listSessions({ includeArchived: true }).length, 0);
});

test("workflow run preset creates idle role-bound workers and prompts only its conductor", () => {
  const { db, hub, svc } = makeHarness();
  const local = db.localIdentityContext();
  const userScope = {
    organizationId: local.organizationId,
    owner: { kind: "user" as const, userId: local.userId },
  };
  assert.equal(db.setResourceScope({
    resource: "workspace", runnerId: RUNNER_ID, resourceId: WORKSPACE_ID, scope: userScope, now: 1,
  }), true);
  const created = svc.createWorkflowRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: "builtin:build-review",
    task: "Implement and independently review the change",
    agentBindings: { claude: AGENT_ID, codex: CODEX_APP_AGENT_ID },
    orchestratorAgentId: CONDUCTOR_ID,
  }, { kind: "human", id: "device-1" });
  assert.equal(created.status, 201);
  assert.equal(created.ok, true);
  const result = created.data!;
  assert.equal(result.sessions.length, 3);
  assert.equal(result.instance.runId, result.run.id);
  assert.equal(result.instance.nodeStates.find((state) => state.nodeId === "build")!.status, "ready");
  assert.equal(db.runMemberSessions(result.run.id, "claude").length, 1);
  assert.equal(db.runMemberSessions(result.run.id, "codex").length, 1);
  const conductorSession = db.runMemberSessions(result.run.id, "__orchestrator__")[0]!;
  assert.equal(conductorSession.agentId, CONDUCTOR_ID);
  const conductorScope = db.sessionScope(conductorSession.id)!;
  assert.deepEqual(conductorScope.owner, {
    kind: "organization", organizationId: local.organizationId,
  });
  for (const worker of result.sessions.filter((session) => session.agentId !== CONDUCTOR_ID)) {
    assert.deepEqual(db.sessionScope(worker.id), userScope);
  }
  const conductorPrincipal: AgentPrincipal = {
    kind: "agent", actorId: conductorSession.id, organizationId: local.organizationId,
    delegatedScope: conductorScope,
  };
  assert.equal(agentDelegationAuthorizationError("/api/runs", conductorPrincipal), null);
  assert.equal(agentDelegationAuthorizationError("/api/workflow-runs", conductorPrincipal), null);
  assert.equal(agentDelegationAuthorizationError("/api/workflows", conductorPrincipal), null);
  assert.equal(db.canAccessRunner(conductorPrincipal, RUNNER_ID), true);

  const starts = hub.sentOfType("start_session");
  assert.equal(starts.length, 3);
  assert.equal(starts.filter((message) => message.initialPrompt !== undefined).length, 1);
  const conductorStart = starts.find((message) => message.spec.agentId === CONDUCTOR_ID)!;
  assert.match(conductorStart.initialPrompt!, new RegExp(result.instance.instanceId));
  assert.equal(conductorStart.spec.useWorktree, false);
  for (const worker of starts.filter((message) => message.spec.agentId !== CONDUCTOR_ID)) {
    assert.equal(worker.initialPrompt, undefined, "workers wait for exact graph-node dispatch");
    assert.equal(worker.spec.useWorktree, true);
  }

  const before = db.listRuns().length;
  const bad = svc.createWorkflowRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: "builtin:build-review",
    task: "bad binding",
    agentBindings: { claude: "missing-agent", codex: CODEX_APP_AGENT_ID },
  });
  assert.equal(bad.status, 404);
  assert.equal(db.listRuns().length, before, "preflight failure does not persist a partial run");

  assert.ok(svc.upsertGovernancePolicy({
    policyId: "workflow:launch-check", name: "Workflow launch check", effect: "allow", priority: 50,
    enabled: true, scope: { runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID },
  }).ok);
  const policyOnly = svc.createWorkflowDefinition({
    name: "Policy-only launch", maxTransitions: 1,
    nodes: [{
      nodeId: "gate", kind: "policy_gate", role: "launch policy", policyId: "workflow:launch-check",
      inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000,
    }],
    edges: [],
  }).data!;
  const startsBeforeSettledRun = hub.sentOfType("start_session").length;
  const settled = svc.createWorkflowRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: policyOnly.workflowId,
    task: "evaluate without launching a worker",
  });
  assert.equal(settled.data!.instance.status, "succeeded");
  assert.equal(settled.data!.sessions.length, 0);
  assert.equal(hub.sentOfType("start_session").length, startsBeforeSettledRun);

  const existingRunIds = new Set(db.listRuns().map((run) => run.id));
  hub.deliver = false;
  const raced = svc.createWorkflowRun({
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: "builtin:build-review",
    task: "fail closed if the runner disconnects after preflight",
    agentBindings: { claude: AGENT_ID, codex: CODEX_APP_AGENT_ID },
    orchestratorAgentId: CONDUCTOR_ID,
  });
  assert.equal(raced.status, 409);
  const failedRun = db.listRuns().find((run) => !existingRunIds.has(run.id))!;
  const failedInstance = svc.workflowInstances(failedRun.id).data![0]!;
  assert.equal(db.getWorkflowInstance(failedInstance.instanceId)!.status, "failed");
  assert.ok(
    db.listSessions({ includeArchived: true })
      .filter((session) => session.runId === failedRun.id)
      .every((session) => session.status === "stopped"),
    "a post-preflight delivery race leaves no starting workflow members",
  );
  db.close();
});

test("workflow retries, timeouts, and human gates are durable and bounded", () => {
  const { db, svc } = makeHarness();
  const runResult = svc.createRun({ runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentIds: [AGENT_ID], task: "Try safely" });
  const run = runResult.data!.run;
  const session = runResult.data!.sessions[0]!;
  db.updateSessionStatus(session.id, "idle", Date.now());
  const retrySpec: WorkflowDefinitionSpec = {
    name: "Retry once", maxTransitions: 3,
    nodes: [{ nodeId: "work", kind: "agent", role: "worker", agentId: AGENT_ID, inputs: [], outputs: [], retry: { maxAttempts: 2, backoffMs: 0 }, timeoutMs: 1_000 }],
    edges: [],
  };
  const definition = svc.createWorkflowDefinition(retrySpec).data!;
  const instance = svc.createWorkflowInstance({ workflowId: definition.workflowId, runId: run.id }).data!;
  const first = svc.dispatchWorkflowNode(instance.instanceId, "work", { dispatchKey: "retry:1" }).data!.attempt;
  svc.onSessionStatus(session.id, "idle");
  const retry = svc.completeWorkflowAttempt(first.attemptId, { outcome: "failure", error: "transient" });
  assert.equal(retry.data!.nodeStates[0]!.status, "ready");
  db.updateSessionStatus(session.id, "idle", Date.now());
  const second = svc.dispatchWorkflowNode(instance.instanceId, "work", { dispatchKey: "retry:2" }).data!.attempt;
  svc.onSessionStatus(session.id, "idle");
  assert.equal(db.getWorkflowAttempt(second.attemptId)!.status, "awaiting_output");
  assert.equal(svc.recoverExpiredWorkflowAttempts(second.deadlineAt), 1);
  const timedOut = db.getWorkflowInstance(instance.instanceId)!;
  assert.equal(timedOut.status, "failed");
  assert.equal(timedOut.attempts[1]!.status, "timed_out");

  const gateSpec: WorkflowDefinitionSpec = {
    name: "Human gate", maxTransitions: 2,
    nodes: [{ nodeId: "approve", kind: "human_gate", role: "approver", inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 }],
    edges: [],
  };
  const gateDefinition = svc.createWorkflowDefinition(gateSpec).data!;
  const gate = svc.createWorkflowInstance({ workflowId: gateDefinition.workflowId, runId: run.id }).data!;
  assert.equal(gate.status, "waiting_gate");
  assert.equal(gate.nodeStates[0]!.status, "waiting_gate");
  const resolved = svc.resolveWorkflowGate(gate.instanceId, "approve", { outcome: "success" }, { kind: "human", id: "device-1" });
  assert.equal(resolved.data!.status, "succeeded");
  assert.equal(resolved.data!.events.at(-1)!.kind, "gate_resolved");
  db.close();
});

test("workflow delivery failures roll back sessions, transition caps terminate, and policy gates cannot be human-bypassed", () => {
  const { db, hub, svc } = makeHarness();
  const runResult = svc.createRun({ runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentIds: [AGENT_ID], task: "Bound the work" });
  const run = runResult.data!.run;
  const session = runResult.data!.sessions[0]!;
  db.updateSessionStatus(session.id, "idle", Date.now());
  const cappedSpec: WorkflowDefinitionSpec = {
    name: "One transition", maxTransitions: 1,
    nodes: [{ nodeId: "work", kind: "agent", role: "worker", agentId: AGENT_ID, inputs: [], outputs: [], retry: { maxAttempts: 2, backoffMs: 0 }, timeoutMs: 60_000 }],
    edges: [],
  };
  const definition = svc.createWorkflowDefinition(cappedSpec).data!;
  const deliveryInstance = svc.createWorkflowInstance({ workflowId: definition.workflowId, runId: run.id }).data!;
  hub.deliver = false;
  const delivery = svc.dispatchWorkflowNode(deliveryInstance.instanceId, "work", { dispatchKey: "delivery:1" });
  assert.equal(delivery.status, 409);
  assert.equal(db.getSession(session.id)!.status, "idle");
  assert.equal(db.getWorkflowInstance(deliveryInstance.instanceId)!.nodeStates[0]!.status, "ready");

  hub.deliver = true;
  const capped = svc.createWorkflowInstance({ workflowId: definition.workflowId, runId: run.id }).data!;
  const first = svc.dispatchWorkflowNode(capped.instanceId, "work", { dispatchKey: "cap:1" }).data!.attempt;
  svc.onSessionStatus(session.id, "idle");
  assert.equal(svc.completeWorkflowAttempt(first.attemptId, { outcome: "failure" }).ok, true);
  const overCap = svc.dispatchWorkflowNode(capped.instanceId, "work", { dispatchKey: "cap:2" });
  assert.equal(overCap.status, 409);
  assert.equal(db.getWorkflowInstance(capped.instanceId)!.status, "failed");

  const crashWindow = svc.createWorkflowInstance({ workflowId: definition.workflowId, runId: run.id }).data!;
  const crashClaim = db.claimWorkflowAttempt({
    attemptId: "crash-attempt", instanceId: crashWindow.instanceId, nodeId: "work",
    dispatchKey: "crash:1", sessionId: session.id, timeoutMs: 60_000,
    maxTransitions: crashWindow.definition.maxTransitions, actor: { kind: "system", id: "dispatcher" }, now: Date.now(),
  }).attempt;
  assert.equal(svc.recoverWorkflowRunner(RUNNER_ID), 1);
  assert.equal(db.getWorkflowAttempt(crashClaim.attemptId)!.status, "awaiting_output");
  assert.equal(svc.recoverExpiredWorkflowAttempts(crashClaim.deadlineAt), 1);
  assert.equal(db.getWorkflowInstance(crashWindow.instanceId)!.nodeStates[0]!.status, "ready");

  const policySpec: WorkflowDefinitionSpec = {
    name: "Policy gate", maxTransitions: 1,
    nodes: [{ nodeId: "policy", kind: "policy_gate", role: "release policy", policyId: "release:protected", inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 }],
    edges: [],
  };
  const policyDefinition = svc.createWorkflowDefinition(policySpec).data!;
  assert.equal(svc.upsertGovernancePolicy({
    policyId: "release:protected", name: "Protected release", effect: "allow", priority: 100,
    enabled: true, scope: { runnerId: RUNNER_ID },
  }).ok, true);
  const policy = svc.createWorkflowInstance({ workflowId: policyDefinition.workflowId, runId: run.id }).data!;
  assert.equal(policy.status, "succeeded");
  assert.equal(policy.events.at(-1)!.actor.kind, "policy");
  assert.equal(svc.resolveWorkflowGate(policy.instanceId, "policy", { outcome: "success" }, { kind: "human", id: "device-1" }).status, 409);
  svc.upsertGovernancePolicy({
    policyId: "release:protected", name: "Protected release", effect: "ask", priority: 100,
    enabled: true, scope: { runnerId: RUNNER_ID },
  });
  const askedPolicy = svc.createWorkflowInstance({ workflowId: policyDefinition.workflowId, runId: run.id }).data!;
  assert.equal(askedPolicy.status, "waiting_gate");
  assert.equal(svc.resolveWorkflowGate(askedPolicy.instanceId, "policy", { outcome: "success" }, { kind: "human", id: "device-1" }).data!.status, "succeeded");
  db.close();
});

test("workflow verdict stop conditions cancel active sibling attempts", () => {
  const { db, hub, svc } = makeHarness();
  const runResult = svc.createRun({ runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentIds: [AGENT_ID, CODEX_APP_AGENT_ID], task: "Compare in parallel" });
  const run = runResult.data!.run;
  for (const session of runResult.data!.sessions) db.updateSessionStatus(session.id, "idle", Date.now());
  const spec: WorkflowDefinitionSpec = {
    name: "Parallel stop", maxTransitions: 4,
    nodes: [
      { nodeId: "build", kind: "agent", role: "builder", agentId: AGENT_ID, inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 },
      { nodeId: "review", kind: "agent", role: "reviewer", agentId: CODEX_APP_AGENT_ID, inputs: [], outputs: [{ name: "verdict", kind: "verdict" }], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000, stopCondition: { kind: "verdict", artifact: "verdict", outcomes: ["accepted", "rejected"] } },
    ],
    edges: [],
  };
  const definition = svc.createWorkflowDefinition(spec).data!;
  const instance = svc.createWorkflowInstance({ workflowId: definition.workflowId, runId: run.id }).data!;
  const build = svc.dispatchWorkflowNode(instance.instanceId, "build", { dispatchKey: "parallel:build" }).data!.attempt;
  const review = svc.dispatchWorkflowNode(instance.instanceId, "review", { dispatchKey: "parallel:review" }).data!.attempt;
  const reviewSession = db.runMemberSessions(run.id, CODEX_APP_AGENT_ID)[0]!;
  svc.onSessionStatus(reviewSession.id, "idle");
  const verdict = svc.createWorkflowArtifact({
    runId: run.id, sessionId: reviewSession.id, kind: "verdict", name: "parallel-verdict.json",
    mimeType: "application/json", encoding: "json", data: JSON.stringify({ outcome: "accepted" }),
  }, { kind: "agent", id: CODEX_APP_AGENT_ID }).data!;
  const completed = svc.completeWorkflowAttempt(review.attemptId, { outcome: "accepted", outputs: { verdict: verdict.artifactId } }).data!;
  assert.equal(completed.status, "succeeded");
  assert.equal(db.getWorkflowAttempt(build.attemptId)!.status, "cancelled");
  assert.ok(hub.sentOfType("cancel_session").some((message) => message.sessionId === build.sessionId));
  assert.equal(hub.sentOfType("interrupt_turn").length, 0, "workflow lifecycle cancellation never uses the turn-only path");
  db.close();
});

test("workflow policy gates auto-advance after agent completion and terminal gates stop untaken branches", () => {
  const { db, svc } = makeHarness();
  const runResult = svc.createRun({ runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentIds: [AGENT_ID], task: "Gate the release" });
  const run = runResult.data!.run;
  const session = runResult.data!.sessions[0]!;
  db.updateSessionStatus(session.id, "idle", Date.now());
  svc.upsertGovernancePolicy({
    policyId: "workflow:release", name: "Release workflow", effect: "allow", priority: 100,
    enabled: true, scope: { runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID },
  });
  const spec: WorkflowDefinitionSpec = {
    name: "Build then policy", maxTransitions: 4,
    nodes: [
      { nodeId: "build", kind: "agent", role: "builder", agentId: AGENT_ID, inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 },
      { nodeId: "policy", kind: "policy_gate", role: "release policy", policyId: "workflow:release", inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 },
      { nodeId: "untaken", kind: "agent", role: "fallback", agentId: AGENT_ID, inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 },
    ],
    edges: [
      { edgeId: "build_policy", from: "build", to: "policy", on: "success" },
      { edgeId: "policy_untaken", from: "policy", to: "untaken", on: "failure" },
    ],
  };
  const definition = svc.createWorkflowDefinition(spec).data!;
  const instance = svc.createWorkflowInstance({ workflowId: definition.workflowId, runId: run.id }).data!;
  const build = svc.dispatchWorkflowNode(instance.instanceId, "build", { dispatchKey: "policy-build:1" }).data!.attempt;
  svc.onSessionStatus(session.id, "idle");
  const completed = svc.completeWorkflowAttempt(build.attemptId, { outcome: "success" }).data!;
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.nodeStates.find((state) => state.nodeId === "policy")!.status, "succeeded");
  assert.equal(completed.nodeStates.find((state) => state.nodeId === "untaken")!.status, "stopped");
  assert.equal(completed.events.at(-1)!.actor.kind, "policy");
  db.close();
});

test("policy-only cycles terminate at the transition cap and mixed fan-out remains running", () => {
  const { db, svc } = makeHarness();
  const run = svc.createRun({
    runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentIds: [AGENT_ID], task: "Exercise workflow states",
  }).data!.run;
  for (const policyId of ["cycle:one", "cycle:two"]) {
    assert.equal(svc.upsertGovernancePolicy({
      policyId, name: policyId, effect: "allow", priority: 100, enabled: true,
      scope: { runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID },
    }).ok, true);
  }
  const cycleSpec: WorkflowDefinitionSpec = {
    name: "Bounded policy cycle", maxTransitions: 5,
    nodes: [
      { nodeId: "start", kind: "human_gate", role: "start", inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 },
      { nodeId: "one", kind: "policy_gate", role: "one", policyId: "cycle:one", inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 },
      { nodeId: "two", kind: "policy_gate", role: "two", policyId: "cycle:two", inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 },
    ],
    edges: [
      { edgeId: "start_one", from: "start", to: "one", on: "success" },
      { edgeId: "one_two", from: "one", to: "two", on: "success" },
      { edgeId: "two_one", from: "two", to: "one", on: "success" },
    ],
  };
  const cycleDefinition = svc.createWorkflowDefinition(cycleSpec).data!;
  const cycle = svc.createWorkflowInstance({ workflowId: cycleDefinition.workflowId, runId: run.id }).data!;
  const capped = svc.resolveWorkflowGate(cycle.instanceId, "start", { outcome: "success" }, { kind: "human", id: "device-1" }).data!;
  assert.equal(capped.status, "failed");
  assert.equal(capped.transitionCount, cycleSpec.maxTransitions);
  assert.ok(capped.nodeStates.every((state) => !["ready", "running", "waiting_gate"].includes(state.status)));

  const fanoutSpec: WorkflowDefinitionSpec = {
    name: "Agent and gate fan-out", maxTransitions: 4,
    nodes: [
      { nodeId: "start", kind: "human_gate", role: "start", inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 },
      { nodeId: "work", kind: "agent", role: "worker", agentId: AGENT_ID, inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 },
      { nodeId: "approve", kind: "human_gate", role: "approver", inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000 },
    ],
    edges: [
      { edgeId: "start_work", from: "start", to: "work", on: "success" },
      { edgeId: "start_approve", from: "start", to: "approve", on: "success" },
    ],
  };
  const fanoutDefinition = svc.createWorkflowDefinition(fanoutSpec).data!;
  const fanout = svc.createWorkflowInstance({ workflowId: fanoutDefinition.workflowId, runId: run.id }).data!;
  const advanced = svc.resolveWorkflowGate(fanout.instanceId, "start", { outcome: "success" }, { kind: "human", id: "device-1" }).data!;
  assert.equal(advanced.status, "running");
  assert.equal(advanced.nodeStates.find((state) => state.nodeId === "work")!.status, "ready");
  assert.equal(advanced.nodeStates.find((state) => state.nodeId === "approve")!.status, "waiting_gate");
  db.close();
});
