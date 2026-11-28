import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ANTIGRAVITY_AGENT_ID, DEFAULT_ORCHESTRATOR_DEFAULTS, DEFAULT_REVIEW_SETTINGS, HUMAN_ONLY_PARENT_CONTROL_POLICY,
  PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL, type AgentDefinition, type ControlPlaneToRunner, type RunnerMetadata, type SessionConfig,
} from "@wollipog/protocol";
import { AcpDriver } from "../../runner/src/drivers/acp-driver.js";
import { SessionManager } from "../../runner/src/session-manager.js";
import { SessionStore } from "../../runner/src/session-store.js";
import { waitForPendingKills } from "../../runner/src/spawn.js";
import { ControlPlaneDb } from "./db.js";
import { fakeScreenRuntime } from "./credential-screen-test-fixture.js";
import { Hub } from "./hub.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { SessionsService } from "./sessions.js";

const floor = RUNNER_CAPABILITY_MIN_PROTOCOL.antigravityFullControlChild;
const native = { kind: "native" } as const;
const implementer = { agentId: ANTIGRAVITY_AGENT_ID, driver: "acp", context: native } as const;
const fixture = fileURLToPath(new URL("../../runner/src/fixtures/antigravity/fake-agy.mjs", import.meta.url));
const sameFamilyModel = "claude-sonnet-4-6";

function harness() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "antigravity-full-control-")));
  const workspace = join(directory, "workspace");
  const state = join(directory, "fixture-state");
  mkdirSync(workspace);
  mkdirSync(state);
  writeFileSync(join(state, "signed-in"), "fixture");
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const human = { ...identity, kind: "human" as const, actorId: identity.userId };
  const scope = { organizationId: identity.organizationId, owner: { kind: "user" as const, userId: identity.userId } };
  const antigravity: AgentDefinition = {
    id: ANTIGRAVITY_AGENT_ID, name: "Google Antigravity", command: process.execPath, args: [fixture, "acp"],
    env: {}, driver: "acp", context: native, source: "discovered", available: true,
    capabilities: { models: [{ id: "gemini-fixture" }, { id: sameFamilyModel }], effortLevels: [],
      slashCommands: [], supportsImages: true, supportsApprovals: true,
      permissionModes: ["auto", "antigravity-full-permissions"] },
  };
  const runner: RunnerMetadata = {
    runnerId: "worker-machine", hostname: "worker", os: "linux", version: "fixture",
    workspaces: [{ id: "workspace", path: workspace, name: "Fixture" }],
    agents: [
      antigravity, { ...antigravity, id: "generic-acp", source: "config" },
      { id: "claude", name: "Claude Code", command: "never-started", args: [], env: {},
        driver: "claude-code", context: native, available: true, capabilities: {
          models: [{ id: "claude-opus-5-5", default: true }], effortLevels: ["high"], slashCommands: [],
          supportsImages: false, supportsApprovals: true,
        } },
    ],
    runtime: { dataDir: directory, worktreeRoot: join(directory, "worktrees"), maxConcurrentSessions: 4,
      reviewSession: { configuration: true, reviewers: [{ harness: "claude-code", agentId: "claude" }] } },
  };
  db.registerRunner(runner, Date.now(), PROTOCOL_VERSION);
  db.registerRunner({ ...runner, runnerId: "older-machine" }, Date.now(), floor - 1);
  const sent: ControlPlaneToRunner[] = [];
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  hub.sessionChangedById = () => {};
  hub.sendToRunner = (_, message) => { sent.push(message); return true; };
  hub.requestFromRunner = async (_, requestId, message) => {
    if (message.type === "campaign_issue_scope" && message.operation === "synchronize") {
      return { type: "campaign_issue_scope_result", requestId, sessionId: message.sessionId,
        ok: true, repository: message.scope.repository, revision: message.scope.revision, candidates: [] };
    }
    throw new Error("Unexpected fixture runner request: " + message.type);
  };
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  svc.setDecisionRuntime(fakeScreenRuntime(db, () => ({ verdict: "discusses" })).runtime);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: "fixture/antigravity", issueNumbers: [1], revision: 1,
    authorizedByUserId: identity.userId, authorizedAt: Date.now() };
  policy.issueNumbers = [1];
  for (const root of ["full", "custom"]) {
    db.createSession({ id: root, runnerId: runner.runnerId, workspaceId: "workspace", agentId: "claude", title: root,
      useWorktree: false, driver: "claude-code", role: "orchestrator", orchestratorPolicy: policy,
      parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } }, config: {}, scope, now: Date.now() });
    db.updateSessionStatus(root, "running", Date.now());
  }
  const enabled = svc.setCampaignControl("full", { mode: "full_control", objective: "Make the fixture edit",
    operations: ["tool_approval", "question"], delegatablePolicyIds: [] },
  1, human);
  assert.ok(enabled.ok, enabled.error ?? "Full Control authorization failed");
  return {
    directory, workspace, state, db, svc, hub, runner, sent, human,
    preflight() {
      return svc.antigravityChildPreflight(policy.behavior, db.getRunner(runner.runnerId)!, identity.userId, null);
    },
    reviewer(model: string | null = null, allowSameFamily = false) {
      db.reviewSettings.set(identity.userId, null, { ...DEFAULT_REVIEW_SETTINGS,
        reviewers: [{ implementer, harness: "claude-code", model, effort: "high", allowSameFamily }] });
    },
    launch(parentSessionId?: string, runnerId = runner.runnerId, agentId = ANTIGRAVITY_AGENT_ID, config?: SessionConfig) {
      return svc.createSession({ runnerId, workspaceId: "workspace", agentId, useWorktree: false, config },
        undefined, scope, false, false, false, parentSessionId ? { parentSessionId } : undefined);
    },
    startSpec() {
      return sent.filter(message => message.type === "start_session").at(-1)!.spec;
    },
    close() { db.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("Full Control Antigravity admission requires its own runner capability, native discovery and reviewer", () => {
  const h = harness();
  try {
    assert.equal(h.preflight()?.ready, false);
    assert.match(h.launch("full").error ?? "", /Settings → Reviews/u);
    h.reviewer("missing-reviewer-model");
    assert.equal(h.preflight()?.ready, false);
    assert.match(h.launch("full").error ?? "", /unavailable.*Settings → Reviews/u);
    h.reviewer(null, true);
    assert.equal(h.preflight()?.ready, true);
    assert.match(h.preflight()?.reason ?? "", /Claude Code \(claude-opus-5-5, high effort\)/u);
    assert.match(h.launch("full", "older-machine").error ?? "", /Update.*runner/i);
    assert.match(h.launch("full", h.runner.runnerId, "generic-acp").error ?? "", /Choose that worker or use Custom/u);
    assert.match(h.launch("full", undefined, undefined, { permissionMode: "antigravity-full-permissions" }).error ?? "",
      /Default or managed Worktree Auto/u);
    assert.match(h.launch("full", undefined, undefined, { model: sameFamilyModel }).error ?? "",
      /require a cross-family reviewer even when/u);
    const agent = h.runner.agents[0]!;
    agent.source = "config";
    h.db.registerRunner(h.runner, Date.now(), PROTOCOL_VERSION);
    assert.match(h.launch("full").error ?? "", /runner-discovered native Google Antigravity/u);
    agent.source = "discovered";
    h.db.registerRunner(h.runner, Date.now(), PROTOCOL_VERSION);
    assert.equal(h.sent.filter(message => message.type === "start_session").length, 0);

    const child = h.launch("full", undefined, undefined, { permissionMode: "default" });
    assert.ok(child.ok && child.data, child.error ?? "worker creation failed");
    const id = child.data.id;
    assert.equal(h.startSpec().antigravityFullControlChild, true);
    assert.equal(h.startSpec().config?.permissionMode, "default");
    assert.equal(h.svc.setConfig(id, { permissionMode: "antigravity-full-permissions" }).status, 409);
    assert.match(h.svc.setConfig(id, { model: sameFamilyModel }).error ?? "", /require a cross-family reviewer/u);
    assert.match(h.svc.prompt(id, "Update the fixture", [], undefined, { model: sameFamilyModel }).error ?? "",
      /require a cross-family reviewer/u);
    h.db.updateSessionConfig(id, { model: sameFamilyModel }, Date.now());
    assert.match(h.svc.requestReviewSession(id, { pullRequest: { repository: "fixture/antigravity", number: 1 },
      headSha: "a".repeat(40), brief: "Review the fixture edit." }).error ?? "", /require a cross-family reviewer/u);
    assert.ok(h.svc.setConfig(id, { model: "gemini-fixture" }).ok);
    assert.equal(h.db.antigravityFullControlRoot(id), "full");
    assert.equal(h.db.reviewSettings.sessionPolicy(id)?.reviewModel, "claude-opus-5-5");
    assert.match(h.svc.setCampaignControl("full", { mode: "custom" }, 2, h.human).error ?? "", /Stop the campaign's/u);
    h.db.registerRunner(h.runner, Date.now(), floor - 1);
    assert.match(h.svc.restart(id).error ?? "", /Update.*runner/i);
    h.db.registerRunner(h.runner, Date.now(), PROTOCOL_VERSION);
    assert.ok(h.svc.restart(id).ok);
    assert.equal(h.startSpec().antigravityFullControlChild, true);
    h.db.updateSessionStatus(id, "stopped", Date.now());
    assert.ok(h.svc.setCampaignControl("full", { mode: "custom" }, 2, h.human).ok);
    assert.match(h.svc.restart(id).error ?? "", /Restore Full Control or create a new Custom worker/u);

    for (const parent of [undefined, "custom"]) {
      assert.ok(h.launch(parent).ok);
      assert.equal(h.startSpec().antigravityFullControlChild, undefined);
      assert.equal(h.db.antigravityFullControlRoot(h.startSpec().sessionId), null);
    }
  } finally { h.close(); }
});

async function until<T>(read: () => T | undefined, description: string): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error("Timed out waiting for " + description);
}

test("the admitted fake Antigravity delegates attested permissions on launch, restart and resume", {
  skip: process.platform === "win32", timeout: 35_000,
}, async () => {
  const h = harness();
  const store = new SessionStore(join(h.directory, "runner-sessions"));
  const capabilities: Array<{ optedIn?: true; resumeId?: string }> = [];
  let controlPlaneProtocol = floor - 1;
  function runner() {
    return new SessionManager((message) => queueMicrotask(() => {
      if (message.type === "session_event") {
        h.svc.onSessionEvent(message.sessionId, message.payload, message.seq, message.ts, h.runner.runnerId);
      } else if (message.type === "session_status") {
        h.svc.onSessionStatus(message.sessionId, message.status, message.detail, message.worktreePath, h.runner.runnerId);
      }
    }), () => {}, store, h.runner.runnerId, undefined,
    (_driver, options, callbacks) => {
      capabilities.push({ optedIn: options.acpCompatibility?.campaignOperationAttestation, resumeId: options.resumeId });
      return new AcpDriver(options, callbacks);
    }, h.directory, 4, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [],
    meta => {
      meta.env = { FAKE_AGY_STATE: h.state };
      return { acpCompatibility: { profile: "antigravity", resumable: true } };
    }, undefined, undefined, undefined, () => controlPlaneProtocol);
  }
  let manager = runner();
  h.hub.sendToRunner = (_, message) => {
    h.sent.push(message);
    if (message.type === "resolve_permission") queueMicrotask(() =>
      manager.resolvePermission(message.sessionId, message.requestId, message.optionId,
        message.resolvedByParentSessionId, message.resolvedBy, message.automaticResponse));
    return true;
  };
  try {
    h.reviewer();
    // In place keeps the fixture portable. The real ACP process, SessionManager, service launch,
    // authority evaluator, and the runner's approval delivery participate.
    const created = h.launch("full");
    assert.ok(created.ok && created.data, created.error ?? "worker creation failed");
    const id = created.data.id;
    const file = join(h.workspace, "source.txt");
    writeFileSync(file, "test");
    const read = "Fixture permission " + JSON.stringify({
      name: "read_file", kind: "read", title: "Read Source", input: { path: file },
    });
    async function verifyPermission() {
      assert.equal(manager.prompt(id, read), true);
      await until(() => store.readMeta(id)?.pendingApproval ?? undefined, "the runner's provider permission");
      const pending = h.db.getSession(id)?.pendingApproval;
      assert.ok(pending, JSON.stringify(store.readEvents(id).map(event => event.payload)));
      assert.equal(pending.requestSource, "provider_tool");
      assert.equal(pending.context?.toolName, "read_file");
      assert.equal(pending.context?.operation?.filesystem?.containment?.sessionRoot, h.workspace);
      await until(() => h.db.getSession(id)?.pendingRequestOwners?.orchestrator === 1 ? true : undefined,
        "the Orchestrator-owned request after credential screening");
      assert.equal(h.db.campaignProjection("full")?.pendingRequests?.orchestrator, 1, "campaign projection");
      const approved = h.svc.resolveDescendantRequest("full", id, pending.occurrenceId ?? pending.requestId,
        { action: "approve", optionId: pending.options.find(option => option.kind === "allow_once")!.optionId }, () => true);
      assert.ok(approved.ok, approved.error ?? "worker permission could not be approved");
      await until(() => store.readMeta(id)?.status === "idle" ? true : undefined, "the settled turn");
      const responses = readFileSync(join(h.state, "calls.jsonl"), "utf8").trim().split("\n")
        .map(line => JSON.parse(line) as { method: string; outcome?: { outcome: string } })
        .filter(call => call.method === "permission_response");
      assert.equal(responses.at(-1)?.outcome?.outcome, "selected");
    }
    assert.equal(await manager.start(h.startSpec()), false);
    assert.equal(capabilities.length, 0, "the older control plane never reaches provider spawn");
    assert.ok(store.readEvents(id).some(({ payload }) =>
      payload.kind === "error" && payload.message.includes("require a current control plane")));
    controlPlaneProtocol = PROTOCOL_VERSION;
    assert.equal(await manager.start(h.startSpec()), true,
      JSON.stringify(store.readEvents(id).map(event => event.payload)));
    await verifyPermission();
    assert.ok(h.svc.restart(id).ok);
    assert.equal(await manager.start(h.startSpec()), true);
    await verifyPermission();

    const providerSession = store.readMeta(id)?.agentSessionId;
    assert.ok(providerSession);
    manager.shutdownAll();
    assert.equal(await waitForPendingKills(5_000), true);
    manager = runner();
    await verifyPermission();
    assert.deepEqual(capabilities, [
      { optedIn: true, resumeId: undefined }, { optedIn: true, resumeId: undefined }, { optedIn: true, resumeId: providerSession },
    ]);
  } finally {
    manager.shutdownAll();
    await waitForPendingKills(5_000);
    h.close();
  }
});
