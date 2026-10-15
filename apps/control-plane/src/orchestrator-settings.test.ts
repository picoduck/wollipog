import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS,
  PROTOCOL_VERSION,
  modelResolutionDrift,
  resolveAgentHarnessRow,
  type AgentDefinition,
  type OrchestratorDefaults,
  type RunnerMetadata,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import {
  OrchestratorSettings,
  childHarnessAdmits,
  childHarnessAgents,
  childModelMachines,
  parseOrchestratorDefaults,
  parseOrchestratorOverrides,
  resolveOrchestratorCampaignPolicy,
} from "./orchestrator-settings.js";
import { registerOrchestratorSettingsRoutes } from "./orchestrator-settings-route.js";

function runner(
  runnerId: string,
  model: string,
  efforts: string[],
  harness: { id: string; name: string; driver: "codex-app-server" | "pi" } = {
    id: "codex", name: "Codex App Server", driver: "codex-app-server",
  },
): RunnerMetadata {
  return {
    runnerId,
    hostname: runnerId,
    os: "linux",
    version: "1",
    workspaces: [{ id: "workspace", name: "Workspace", path: "/workspace" }],
    agents: [{
      id: harness.id,
      name: harness.name,
      command: "codex",
      driver: harness.driver,
      available: true,
      context: { kind: "native" },
      capabilities: {
        models: [{ id: model, displayName: model.toUpperCase(), efforts }],
        effortLevels: efforts,
        permissionModes: ["orchestrator"],
        slashCommands: [],
        supportsImages: true,
        supportsApprovals: true,
      },
    }],
  };
}

function human(db: ControlPlaneDb, deviceId = "device-a"): HumanPrincipal {
  const local = db.localIdentityContext();
  return {
    kind: "human",
    actorId: local.userId,
    userId: local.userId,
    userName: local.userName,
    organizationId: local.organizationId,
    organizationName: local.organizationName,
    role: "viewer",
    deviceId,
    localBootstrap: false,
  };
}

function defaults(overrides: Partial<OrchestratorDefaults["behavior"]> = {}): OrchestratorDefaults {
  return {
    behavior: { ...DEFAULT_ORCHESTRATOR_DEFAULTS.behavior, ...overrides },
    delegation: {
      parentControl: "questions",
      decisions: {
        implementation_question: "orchestrator",
        pr_merge: "human",
        merged_branch_deletion: "human",
        follow_up_issue_publication: "human",
        ui_evidence_approval: "orchestrator",
      },
    },
    execution: { strictProjectIsolation: false, integrationIsolation: false },
  };
}

test("Orchestrator defaults persist per authenticated user and preserve capability drift", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const now = Date.now();
    db.registerRunner(runner("runner-a", "sol", ["low"]), now, PROTOCOL_VERSION);
    db.registerRunner(runner("runner-b", "luna", ["high"]), now + 1, PROTOCOL_VERSION);
    const settings = new OrchestratorSettings(db);
    const firstDevice = human(db, "laptop");
    assert.equal(settings.view(firstDevice).source, "system_default");

    const saved = defaults({ childModel: "sol", childEffort: "low", maximumConcurrentChildren: 7 });
    assert.deepEqual(settings.update(firstDevice, { defaults: saved }, now + 10).defaults, saved);
    assert.deepEqual(settings.view({ ...firstDevice, deviceId: "phone" }).defaults, saved,
      "the same signed-in user sees persisted defaults on another device");

    const local = db.localIdentityContext();
    db.raw().prepare("INSERT INTO identity_users VALUES (?, ?, 'active', ?, ?)")
      .run("other-user", "Other User", 3, 3);
    db.raw().prepare("INSERT INTO identity_memberships VALUES (?, ?, 'viewer', ?, ?)")
      .run(local.organizationId, "other-user", 3, 3);
    const other = { ...firstDevice, actorId: "other-user", userId: "other-user", userName: "Other User" };
    assert.equal(settings.view(other).source, "system_default", "defaults never leak between users");

    db.updateRunnerAgents("runner-a", runner("runner-a", "other", ["medium"]).agents, now + 20);
    const drifted = settings.view(firstDevice);
    assert.equal(drifted.capabilities.status, "unavailable");
    assert.equal(drifted.capabilities.supportedPairs?.some((pair) => pair.modelId === "luna" && pair.effortLevels.includes("high")), true);
    assert.deepEqual(drifted.defaults, saved, "discovery drift must not silently rewrite saved values");
    assert.match(drifted.capabilities.reason ?? "", /supports this Child Harness, Child Model and Child Effort together/);

    assert.throws(() => settings.update(firstDevice, {
      defaults: defaults({ childModel: "sol", childEffort: "high" }),
    }), /supports this Child Harness, Child Model and Child Effort together/,
    "aggregate choices from different installations are not treated as one supported combination");

    db.markOffline("runner-a", now + 21);
    db.markOffline("runner-b", now + 21);
    const disconnected = settings.view(firstDevice);
    assert.equal(disconnected.capabilities.installations, 0,
      "stale catalogs from disconnected runners are not presented as current discovery");
    assert.match(disconnected.capabilities.reason ?? "", /Connect a machine or update Wollipog on it in Connections/);
  } finally {
    db.close();
  }
});

test("Orchestrator capabilities keep identical model ids scoped to stable harness identities", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const now = Date.now();
    db.registerRunner(runner("runner-codex", "shared-model", ["high"]), now, PROTOCOL_VERSION);
    db.registerRunner(runner("runner-pi", "shared-model", ["low"], {
      id: "pi", name: "Pi", driver: "pi",
    }), now + 1, PROTOCOL_VERSION);
    const settings = new OrchestratorSettings(db);
    const principal = human(db);
    const initial = settings.view(principal);
    assert.equal(initial.capabilities.harnesses?.length, 2);
    const codex = initial.capabilities.harnesses?.find((harness) => harness.driver === "codex-app-server")!;
    const pi = initial.capabilities.harnesses?.find((harness) => harness.driver === "pi")!;
    assert.deepEqual(codex.supportedPairs, [{ modelId: "shared-model", effortLevels: ["high"] }]);
    assert.deepEqual(pi.supportedPairs, [{ modelId: "shared-model", effortLevels: ["low"] }]);

    const fixedPi = defaults({
      childHarness: { agentId: "pi", driver: "pi", context: { kind: "native" } },
      childModel: "shared-model",
      childEffort: "low",
    });
    assert.deepEqual(settings.update(principal, { defaults: fixedPi }, now + 2).defaults, fixedPi);
    assert.throws(() => settings.update(principal, { defaults: defaults({
      childHarness: fixedPi.behavior.childHarness,
      childModel: "shared-model",
      childEffort: "high",
    }) }), /supports this Child Harness, Child Model and Child Effort together/,
    "Codex effort metadata must not leak into Pi merely because the model id matches");

    db.markOffline("runner-pi", now + 3);
    const drifted = settings.view(principal);
    assert.deepEqual(drifted.defaults.behavior.childHarness, fixedPi.behavior.childHarness);
    assert.equal(drifted.capabilities.status, "unavailable");
    assert.equal(drifted.capabilities.harnesses?.find((harness) => harness.driver === "pi")?.installations, 0,
      "a saved unavailable harness remains visible for repair");
    assert.match(drifted.capabilities.reason ?? "", /Child Harness/);
  } finally {
    db.close();
  }
});

function claudeAgent(id: string, driver: "claude-code" | "acp"): AgentDefinition {
  return {
    id,
    name: driver === "acp" ? "Claude Code (ACP)" : `Claude ${id}`,
    command: "claude",
    args: [],
    env: {},
    driver,
    available: true,
    context: { kind: "native" },
    capabilities: {
      models: [{ id: "opus", displayName: "Opus", efforts: ["high"] }],
      effortLevels: ["high"],
      permissionModes: ["orchestrator"],
      slashCommands: [],
      supportsImages: true,
      supportsApprovals: true,
    },
  };
}

test("a Child Harness is one harness across Machines whatever each names its row (#3247)", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const now = Date.now();
    const machineA = runner("machine-a", "opus", ["high"]);
    machineA.agents = [claudeAgent("claude-code", "claude-code")];
    const machineB = runner("machine-b", "opus", ["high"]);
    machineB.agents = [claudeAgent("claude-native", "claude-code"), claudeAgent("claude-code", "acp")];
    db.registerRunner(machineA, now, PROTOCOL_VERSION);
    db.registerRunner(machineB, now + 1, PROTOCOL_VERSION);
    const settings = new OrchestratorSettings(db);
    const principal = human(db);

    const harnesses = settings.view(principal).capabilities.harnesses!;
    const native = harnesses.filter((harness) => harness.driver === "claude-code");
    assert.equal(native.length, 1, "both Machines' native rows are one option");
    assert.equal(native[0]!.name, "Claude Code");
    assert.equal(native[0]!.agentId, "claude-code");
    assert.equal(native[0]!.machines, 2);
    assert.equal(native[0]!.installations, 2);
    assert.deepEqual(harnesses.filter((harness) => harness.driver === "acp").map((harness) => [harness.agentId, harness.machines]),
      [["claude-code", 1]], "an ACP row stays its own harness");

    const saved = settings.update(principal, { defaults: defaults({
      childHarness: { agentId: "claude-native", driver: "claude-code", context: { kind: "native" } },
    }) }, now + 2);
    assert.deepEqual(saved.defaults.behavior.childHarness, { agentId: "claude-code", driver: "claude-code", context: { kind: "native" } },
      "a saved Child Harness names the harness, not the row it was picked from");

    const policy = resolveOrchestratorCampaignPolicy(saved.defaults, "user_default");
    assert.equal(policy.childHarnessMatch, "harness");
    for (const agentId of ["claude-code", "claude-native"]) {
      assert.equal(childHarnessAdmits(policy, { agentId, driver: "claude-code", context: { kind: "native" } }), true);
    }
    assert.equal(childHarnessAdmits(policy, { agentId: "claude-code", driver: "acp", context: { kind: "native" } }), false);
    const runners = db.listRunnersForPrincipal(principal);
    assert.deepEqual(childHarnessAgents(policy, runners), [
      { runnerId: "machine-a", machineName: "machine-a", agentId: "claude-code" },
      { runnerId: "machine-b", machineName: "machine-b", agentId: "claude-native" },
    ]);

    // A campaign created before #3247 still admits only its exact agent id.
    const legacy = { ...policy, behavior: { ...policy.behavior,
      childHarness: { agentId: "claude-native", driver: "claude-code" as const, context: { kind: "native" as const } } } };
    delete legacy.childHarnessMatch;
    assert.equal(childHarnessAdmits(legacy, { agentId: "claude-code", driver: "claude-code", context: { kind: "native" } }), false);
    assert.deepEqual(childHarnessAgents(legacy, runners)?.map((entry) => entry.agentId), [null, "claude-native"]);
    assert.equal(childHarnessAgents(resolveOrchestratorCampaignPolicy(defaults(), "user_default"), runners), undefined,
      "an Automatic harness lists no agents");
  } finally {
    db.close();
  }
});

test("a Machine with several rows of one harness resolves them deterministically (#3247)", () => {
  const identity = { agentId: "claude-code", driver: "claude-code" as const, context: { kind: "native" as const } };
  const rows = [claudeAgent("zeta", "claude-code"), claudeAgent("alpha", "claude-code"), claudeAgent("acp", "acp")];
  assert.equal(resolveAgentHarnessRow(rows, identity)?.id, "alpha", "the lowest agent id without a selection");
  assert.equal(resolveAgentHarnessRow([...rows].reverse(), identity)?.id, "alpha", "independent of row order");
  rows[0]!.installation = { id: "user-local", path: "/opt/claude", via: "path", selection: "selected" };
  assert.equal(resolveAgentHarnessRow(rows, identity)?.id, "zeta", "the Machine's selected installation wins");
  rows[1]!.installation = { id: "system", path: "/usr/bin/claude", via: "path", selection: "other" };
  assert.equal(resolveAgentHarnessRow(rows, identity)?.id, "zeta");
  rows[0]!.available = false;
  assert.equal(resolveAgentHarnessRow(rows, identity), undefined,
    "a row the Machine's installation choice excludes cannot launch, so it is never chosen");
  delete rows[1]!.installation;
  rows[1]!.harnessSelectionBlocked = true;
  assert.equal(resolveAgentHarnessRow(rows, identity), undefined, "nor is a configured row an explicit choice blocks");
  rows[1]!.harnessSelectionBlocked = false;
  assert.equal(resolveAgentHarnessRow(rows, identity)?.id, "alpha", "an unavailable row is never chosen");
  assert.equal(resolveAgentHarnessRow(rows, { ...identity, context: { kind: "wsl", distro: "Ubuntu" } }), undefined);
});

function claudeMachine(runnerId: string, models: Array<{ id: string; displayName: string }>): RunnerMetadata {
  const metadata = runner(runnerId, "unused", ["high"]);
  const agent = claudeAgent("claude-code", "claude-code");
  agent.capabilities!.models = models.map((model) => ({ ...model, efforts: ["high"] }));
  metadata.agents = [agent];
  return metadata;
}

test("Settings name the Machines that can't run the saved Child Model, and only those (#3248)", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const now = Date.now();
    db.registerRunner(claudeMachine("laptop", [{ id: "opus", displayName: "Opus 5.5" }, { id: "fable", displayName: "Fable" }]), now, PROTOCOL_VERSION);
    db.registerRunner(claudeMachine("desktop", [{ id: "opus", displayName: "Opus 5.5" }]), now + 1, PROTOCOL_VERSION);
    const settings = new OrchestratorSettings(db);
    const principal = human(db);
    const harness = { agentId: "claude-code", driver: "claude-code" as const, context: { kind: "native" as const } };

    const fable = settings.update(principal, { defaults: defaults({ childHarness: harness, childModel: "fable" }) }, now + 2);
    assert.deepEqual(fable.capabilities.machineSupport, { supported: 1, total: 2, unsupportedMachines: ["desktop"] });
    assert.equal(fable.capabilities.status, "available", "one Machine is enough to save");

    const opus = settings.update(principal, { defaults: defaults({ childHarness: harness, childModel: "opus" }) }, now + 3);
    assert.deepEqual(opus.capabilities.machineSupport, { supported: 2, total: 2, unsupportedMachines: [] });
    assert.equal(opus.capabilities.childModelDrift, undefined, "identical catalogs report no drift");

    const automatic = settings.update(principal, { defaults: defaults() }, now + 4);
    assert.equal(automatic.capabilities.machineSupport, undefined, "nothing to report while everything is Automatic");

    const policy = resolveOrchestratorCampaignPolicy(fable.defaults, "user_default");
    assert.deepEqual(childModelMachines(policy, db.listRunnersForPrincipal(principal)), [
      { runnerId: "desktop", machineName: "desktop", supported: false },
      { runnerId: "laptop", machineName: "laptop", supported: true },
    ]);
    const laptop = db.listRunnersForPrincipal(principal).filter((machine) => machine.runnerId === "laptop");
    laptop[0]!.agents[0]!.installation = { id: "system", path: "/usr/bin/claude", via: "path", selection: "other" };
    assert.deepEqual(childModelMachines(policy, laptop)?.map((machine) => machine.supported), [false],
      "a row the Machine's installation choice excludes cannot run children");
    assert.equal(childModelMachines(resolveOrchestratorCampaignPolicy(defaults({ childHarness: harness }), "user_default"),
      db.listRunnersForPrincipal(principal)), undefined, "an Automatic model and effort list no Machines");
  } finally {
    db.close();
  }
});

test("a row the Machine's installation choice excludes never counts toward Machine support (#3248)", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const now = Date.now();
    const laptop = claudeMachine("laptop", [{ id: "fable", displayName: "Fable" }]);
    const other = claudeAgent("claude-local", "claude-code");
    agentWithInstallation(laptop.agents[0]!, "system");
    agentWithInstallation(other, "user-local");
    laptop.agents.push(other);
    db.registerRunner(laptop, now, PROTOCOL_VERSION);
    db.registerRunner(claudeMachine("desktop", [{ id: "fable", displayName: "Fable" }]), now + 1, PROTOCOL_VERSION);
    const settings = new OrchestratorSettings(db);
    const principal = human(db);
    const fixed = defaults({ childModel: "fable" });
    assert.deepEqual(settings.update(principal, { defaults: fixed }, now + 2).capabilities.machineSupport?.unsupportedMachines, []);
    // Choosing the user-local installation, whose catalog lacks Fable, excludes the system row.
    assert.ok(db.selectHarnessInstallation("laptop", "claude-local", "user-local"));
    assert.deepEqual(settings.view(principal).capabilities.machineSupport, { supported: 1, total: 2, unsupportedMachines: ["laptop"] });
  } finally {
    db.close();
  }
});

function agentWithInstallation(agent: AgentDefinition, id: string): void {
  agent.installation = { id, path: `/opt/${id}/claude`, via: "path" };
  if (id === "user-local") agent.capabilities!.models = [{ id: "opus", displayName: "Opus", efforts: ["high"] }];
}

test("Settings warn when the saved Child Model resolves to different models on different Machines (#3248)", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const now = Date.now();
    db.registerRunner(claudeMachine("laptop", [
      { id: "opus", displayName: "Opus 5.5" }, { id: "claude-opus-5-5", displayName: "Opus 5.5" },
      { id: "claude-opus-5", displayName: "Opus 5" },
    ]), now, PROTOCOL_VERSION);
    db.registerRunner(claudeMachine("desktop", [
      { id: "opus", displayName: "Opus 5" }, { id: "claude-opus-5", displayName: "Opus 5" },
    ]), now + 1, PROTOCOL_VERSION);
    const settings = new OrchestratorSettings(db);
    const view = settings.update(human(db), { defaults: defaults({
      childHarness: { agentId: "claude-code", driver: "claude-code", context: { kind: "native" } }, childModel: "opus",
    }) }, now + 2);
    assert.deepEqual(view.capabilities.childModelDrift, {
      modelId: "opus",
      machines: [{ machineName: "desktop", displayName: "Opus 5" }, { machineName: "laptop", displayName: "Opus 5.5" }],
      pinned: [{ modelId: "claude-opus-5", displayName: "Opus 5" }, { modelId: "claude-opus-5-5", displayName: "Opus 5.5" }],
    });
  } finally {
    db.close();
  }
});

test("model drift needs two resolutions of one id and offers only visible ids naming one of them", () => {
  const laptop = { machineName: "laptop", models: [{ id: "opus", displayName: "Opus 5.5" }, { id: "x", displayName: "Opus 5.5", hidden: true }] };
  assert.equal(modelResolutionDrift([laptop, { ...laptop, machineName: "desktop" }], "opus"), null);
  assert.equal(modelResolutionDrift([laptop], "missing"), null);
  const drift = modelResolutionDrift([laptop, { machineName: "desktop", models: [{ id: "opus" }] }], "opus");
  assert.deepEqual(drift?.machines.map((entry) => entry.displayName), ["opus", "Opus 5.5"],
    "a Machine without a display name reports the id itself");
  assert.deepEqual(drift?.pinned, [], "a hidden model is never offered");
});

test("Orchestrator child harnesses exclude discovery's restart-only Codex exec row (#3224)", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const now = Date.now();
    const metadata = runner("runner-codex", "gpt", ["high"]);
    const appServer = { ...metadata.agents[0]!, source: "discovered" as const };
    metadata.agents = [appServer, { ...appServer, id: "codex-exec", name: "Codex (Non-Interactive)", driver: "codex" }];
    db.registerRunner(metadata, now, PROTOCOL_VERSION);
    const settings = new OrchestratorSettings(db);
    const principal = human(db);
    assert.deepEqual(settings.view(principal).capabilities.harnesses?.map((harness) => harness.driver), ["codex-app-server"]);
    assert.throws(() => settings.update(principal, { defaults: defaults({
      childHarness: { agentId: "codex-exec", driver: "codex", context: { kind: "native" } },
    }) }), /supports this Child Harness, Child Model and Child Effort together/);
  } finally {
    db.close();
  }
});

test("Orchestrator parsing is exact and campaign resolution tracks field-level precedence", () => {
  assert.equal(parseOrchestratorDefaults({ ...defaults(), extra: true }), null);
  assert.equal(parseOrchestratorDefaults({ ...defaults(), behavior: { ...defaults().behavior, childModel: " sol " } }), null);
  const { childHarness: _legacyChildHarness, ...preV157Behavior } = defaults().behavior;
  assert.equal(parseOrchestratorDefaults({ ...defaults(), behavior: preV157Behavior }), null,
    "a stale pre-v157 defaults document cannot silently clear a fixed Child Harness");
  assert.equal(parseOrchestratorOverrides({ behavior: [] }), null);
  assert.equal(parseOrchestratorOverrides({ delegation: { decisions: "all" } }), null);
  assert.equal(parseOrchestratorOverrides({ delegation: { decisions: { unknown: "orchestrator" } } }), null);
  assert.deepEqual(parseOrchestratorOverrides({ behavior: { childHarness: {
    agentId: "pi", driver: "pi", context: { kind: "native" }, name: "not durable",
  } } })?.behavior?.childHarness, {
    agentId: "pi", driver: "pi", context: { kind: "native" },
  }, "campaign policy retains only the stable secret-free harness identity");

  const policy = resolveOrchestratorCampaignPolicy(defaults(), "user_default", {
    behavior: { childModel: null, completion: "stop_and_archive" },
    delegation: { decisions: { pr_merge: "orchestrator" } },
  });
  assert.equal(policy.behavior.childModel, null);
  assert.equal(policy.sources.behavior.childModel, "session_override");
  assert.equal(policy.sources.behavior.maximumConcurrentChildren, "user_default");
  assert.equal(policy.delegation.decisions.pr_merge, "orchestrator");
  assert.equal(policy.sources.delegation.decisions.pr_merge, "session_override");
  assert.equal(policy.sources.delegation.decisions.ui_evidence_approval, "user_default");
  assert.equal(policy.execution.strictProjectIsolation, false);
  assert.equal(policy.sources.execution.strictProjectIsolation, "user_default");
  const strict = resolveOrchestratorCampaignPolicy(defaults(), "user_default", {
    execution: { strictProjectIsolation: true },
  });
  assert.equal(strict.execution.strictProjectIsolation, true);
  assert.equal(strict.sources.execution.strictProjectIsolation, "session_override");
});

test("Orchestrator settings routes reject agents and persist human updates", async () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner("runner-a", "sol", ["high"]), Date.now(), PROTOCOL_VERSION);
  const owner = human(db);
  const principals = new Map<string, AuthPrincipal>([
    ["human", owner],
    ["agent", {
      kind: "agent",
      actorId: "agent",
      organizationId: owner.organizationId,
      delegatedScope: { organizationId: owner.organizationId, owner: { kind: "organization", organizationId: owner.organizationId } },
    }],
  ]);
  const app = Fastify();
  registerOrchestratorSettingsRoutes(app, new OrchestratorSettings(db), (request) =>
    principals.get(request.headers.authorization?.replace(/^Bearer /, "") ?? "") ?? null);
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/orchestrator-settings" })).statusCode, 403);
    assert.equal((await app.inject({
      method: "PUT", url: "/api/orchestrator-settings", headers: { authorization: "Bearer agent" }, payload: { defaults: defaults() },
    })).statusCode, 403);
    const response = await app.inject({
      method: "PUT",
      url: "/api/orchestrator-settings",
      headers: { authorization: "Bearer human" },
      payload: { defaults: defaults({ childModel: "sol", childEffort: "high" }) },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(response.json().source, "user_default");
    assert.equal(db.getOrchestratorDefaults(owner.userId)?.defaults.behavior.childModel, "sol");
    assert.equal((await app.inject({
      method: "PUT", url: "/api/orchestrator-settings", headers: { authorization: "Bearer human" }, payload: { defaults: {} },
    })).statusCode, 400);
  } finally {
    await app.close();
    db.close();
  }
});

test("Orchestrator settings reasons name machines and Connections, never installations or runners", async () => {
  const db = ControlPlaneDb.open(":memory:");
  const owner = human(db);
  const settings = new OrchestratorSettings(db);
  const app = Fastify();
  registerOrchestratorSettingsRoutes(app, settings, () => owner);
  const systemWords = /runner|installation|advertise/i;
  const reasons: string[] = [];
  const read = async () => {
    const response = await app.inject({ method: "GET", url: "/api/orchestrator-settings" });
    assert.equal(response.statusCode, 200);
    return response.json().capabilities.reason as string | undefined;
  };
  const write = async (behavior: Partial<OrchestratorDefaults["behavior"]>) => {
    const response = await app.inject({
      method: "PUT", url: "/api/orchestrator-settings", payload: { defaults: defaults(behavior) },
    });
    assert.equal(response.statusCode, 409);
    return response.json().error as string;
  };
  try {
    const none = await read();
    assert.equal(none, "No connected machine reports which models and efforts child agents can use. " +
      "Connect a machine or update Wollipog on it in Connections, then try again.");
    reasons.push(none, await write({ childModel: "sol" }));
    reasons.push(settings.compatibilityError(owner, defaults({ childModel: "sol" }))!);

    const now = Date.now();
    db.registerRunner(runner("runner-a", "sol", ["low"]), now, PROTOCOL_VERSION);
    const unsupported = await write({ childModel: "sol", childEffort: "high" });
    assert.equal(unsupported, "No connected machine supports this Child Harness, Child Model and Child Effort " +
      "together. Choose Automatic or another combination.");
    reasons.push(unsupported, settings.compatibilityError(owner, defaults({ childModel: "luna" }))!);

    db.setOrchestratorDefaults(owner.userId, defaults({ childModel: "sol", childEffort: "low" }), now + 1);
    db.updateRunnerAgents("runner-a", runner("runner-a", "luna", ["low"]).agents, now + 2);
    const drifted = await read();
    assert.equal(drifted, unsupported, "a saved combination that drifted out of support reads the same");
    reasons.push(drifted!);

    for (const reason of reasons) assert.doesNotMatch(reason, systemWords);
  } finally {
    await app.close();
    db.close();
  }
});
