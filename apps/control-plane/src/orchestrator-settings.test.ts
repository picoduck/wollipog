import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS,
  PROTOCOL_VERSION,
  type OrchestratorDefaults,
  type RunnerMetadata,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import {
  OrchestratorSettings,
  parseOrchestratorDefaults,
  parseOrchestratorOverrides,
  resolveOrchestratorCampaignPolicy,
} from "./orchestrator-settings.js";
import { registerOrchestratorSettingsRoutes } from "./orchestrator-settings-route.js";

function runner(runnerId: string, model: string, efforts: string[]): RunnerMetadata {
  return {
    runnerId,
    hostname: runnerId,
    os: "linux",
    version: "1",
    workspaces: [{ id: "workspace", name: "Workspace", path: "/workspace" }],
    agents: [{
      id: "codex",
      name: "Codex App Server",
      command: "codex",
      driver: "codex-app-server",
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
    execution: { strictProjectIsolation: false },
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
    assert.match(drifted.capabilities.reason ?? "", /not supported together/);

    assert.throws(() => settings.update(firstDevice, {
      defaults: defaults({ childModel: "sol", childEffort: "high" }),
    }), /not supported together/,
    "aggregate choices from different installations are not treated as one supported combination");

    db.markOffline("runner-a", now + 21);
    db.markOffline("runner-b", now + 21);
    const disconnected = settings.view(firstDevice);
    assert.equal(disconnected.capabilities.installations, 0,
      "stale catalogs from disconnected runners are not presented as current discovery");
    assert.match(disconnected.capabilities.reason ?? "", /Connect or update a runner/);
  } finally {
    db.close();
  }
});

test("Orchestrator parsing is exact and campaign resolution tracks field-level precedence", () => {
  assert.equal(parseOrchestratorDefaults({ ...defaults(), extra: true }), null);
  assert.equal(parseOrchestratorDefaults({ ...defaults(), behavior: { ...defaults().behavior, childModel: " sol " } }), null);
  assert.equal(parseOrchestratorOverrides({ behavior: [] }), null);
  assert.equal(parseOrchestratorOverrides({ delegation: { decisions: "all" } }), null);
  assert.equal(parseOrchestratorOverrides({ delegation: { decisions: { unknown: "orchestrator" } } }), null);

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
