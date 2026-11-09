/** Decision Model setting and its routes (#4101). No test calls a real provider. */
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import type {
  AgentDefinition,
  DecisionModelSettingsView,
  DecisionModelTestResult,
  RunDecisionMessage,
  RunnerView,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { DECISION_PROBE_EXPECTED_VERDICT } from "./decision-kinds.js";
import { registerDecisionModelRoutes } from "./decision-model-route.js";
import { automaticDecisionModel, DecisionModelSettings, DecisionModelUnavailableError } from "./decision-model-settings.js";
import { DecisionRuntime } from "./decision-runtime.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";

const ORG = "org_personal";

function claude(overrides: Partial<AgentDefinition> = {}, decisionCalls = true): AgentDefinition {
  return {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    args: [],
    env: {},
    driver: "claude-code",
    context: { kind: "native" },
    source: "discovered",
    available: true,
    authStatus: "authenticated",
    capabilities: {
      models: [
        { id: "default", displayName: "Default" },
        { id: "opus", displayName: "Opus", efforts: ["low", "medium", "high"] },
        { id: "haiku", displayName: "Haiku", efforts: ["medium", "low"] },
      ],
      effortLevels: ["low", "medium", "high"],
      slashCommands: [],
      supportsImages: false,
      supportsApprovals: true,
    },
    claudeCode: {
      status: "ready",
      effortLevels: ["low", "medium", "high"],
      permissionModes: ["plan"],
      streamJsonInput: true,
      streamJsonImages: true,
      controlProtocol: true,
      forkSession: true,
      replayUserMessages: true,
      sessionNaming: true,
      decisionCalls,
      auth: { status: "authenticated", billingSource: "subscription" },
    },
    ...overrides,
  };
}

function codex(): AgentDefinition {
  return {
    id: "codex",
    name: "Codex",
    command: "codex",
    args: [],
    env: {},
    driver: "codex-app-server",
    context: { kind: "native" },
    source: "discovered",
    available: true,
    authStatus: "authenticated",
    codexBillingSource: "provider_account",
    codexAppServer: { status: "supported", appServerAvailable: true, sessionNaming: true, decisionCalls: true },
    capabilities: {
      models: [
        { id: "gpt-5.5", displayName: "GPT-5.5", efforts: ["low", "medium"] },
        { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", efforts: ["minimal", "medium"] },
      ],
      effortLevels: ["low", "medium"],
      slashCommands: [],
      supportsImages: false,
      supportsApprovals: true,
    },
  };
}

function human(role: HumanPrincipal["role"]): HumanPrincipal {
  return {
    kind: "human", actorId: `${role}-user`, userId: `${role}-user`, userName: role, organizationId: ORG,
    organizationName: "Personal", role, deviceId: null, localBootstrap: false,
  };
}

/** A real database whose runner reads come from a mutable fixture. */
function fixture() {
  const real = ControlPlaneDb.open(":memory:");
  const state = {
    agents: [claude(), codex()] as AgentDefinition[],
    status: "online" as RunnerView["status"],
    protocolVersion: 285,
    organizationId: ORG,
  };
  const runner = (): RunnerView => ({
    runnerId: "runner-1", displayName: "Machine One", hostname: "host", os: "linux", version: "test",
    status: state.status, connectedAt: 1, lastSeen: 1, protocolVersion: state.protocolVersion,
    workspaces: [], agents: state.agents,
  });
  const db = Object.assign(Object.create(real) as ControlPlaneDb, {
    listRunners: () => [runner()],
    getRunner: (id: string) => id === "runner-1" ? runner() : null,
    runnerScope: () => ({ organizationId: state.organizationId }),
  });
  return { db, state, settings: new DecisionModelSettings(db) };
}

test("Automatic picks the first preferred small model and effort a harness advertises", () => {
  assert.deepEqual(automaticDecisionModel(claude()) && {
    model: automaticDecisionModel(claude())!.model.id, effort: automaticDecisionModel(claude())!.effort,
  }, { model: "haiku", effort: "low" });
  const mini = automaticDecisionModel(codex())!;
  assert.equal(mini.model.id, "gpt-5.4-mini");
  assert.equal(mini.effort, "minimal");
  const large = claude({ capabilities: { ...claude().capabilities!, models: [{ id: "opus", efforts: ["low"] }] } });
  assert.equal(automaticDecisionModel(large), null, "no preferred family means no Automatic model");
});

test("a Claude alias that needs plan mode to mean its model is not offered, and a saved one is unavailable (#4367)", () => {
  const { settings, state } = fixture();
  const saved = settings.configure(ORG, {
    runnerId: "runner-1", agentId: "claude-code", driver: "claude-code", model: "opus", effort: "medium",
  });
  assert.equal(saved.target?.available, true);
  const planAlias = { id: "opusplan", displayName: "Opus Plan", efforts: ["low", "medium"] };
  const withPlanAlias = claude({ capabilities: { ...claude().capabilities!, models: [planAlias, ...claude().capabilities!.models] } });
  state.agents = [withPlanAlias, codex()];
  const offered = settings.view(ORG, true).machines[0]!.harnesses.find((harness) => harness.agentId === "claude-code")!.models;
  assert.deepEqual(offered.map((model) => model.id), ["opus", "haiku"]);
  // The alias's family can't win Automatic, and neither can one that names a preferred family.
  const haikuPlan = claude({ capabilities: { ...claude().capabilities!, models: [{ id: "haikuplan", efforts: ["low"] }] } });
  assert.equal(automaticDecisionModel(haikuPlan), null);
  // It can't be chosen. A target saved earlier meets the same filter, so it reads as unavailable.
  assert.throws(() => settings.configure(ORG, {
    runnerId: "runner-1", agentId: "claude-code", driver: "claude-code", model: "opusplan", effort: "medium",
  }), DecisionModelUnavailableError);
});

test("the setting lists only harnesses that can host Decision calls, on current runners", () => {
  const { settings, state } = fixture();
  const view = settings.view(ORG, false);
  assert.equal(view.source, "automatic");
  assert.equal(view.canManage, false);
  assert.deepEqual(view.machines[0]!.harnesses.map((harness) => harness.agentId), ["claude-code", "codex"]);
  assert.deepEqual(view.automaticPreference, ["haiku", "luna", "mini", "nano", "flash"]);
  state.agents = [claude({}, false), codex()];
  assert.deepEqual(settings.view(ORG, false).machines[0]!.harnesses.map((harness) => harness.agentId), ["codex"]);
  state.protocolVersion = 284;
  assert.deepEqual(settings.view(ORG, false).machines, [], "an older runner offers nothing");
});

test("Automatic uses the campaign runner's own harness and fails non-transiently when it cannot", () => {
  const { settings, state } = fixture();
  const own = settings.resolve(ORG, { runnerId: "runner-1", agentId: "codex", driver: "codex-app-server" });
  assert.ok(own.ok);
  assert.equal(own.target.source, "automatic");
  assert.equal(own.target.agentId, "codex");
  assert.equal(own.target.model, "gpt-5.4-mini");
  // Without a campaign (the Test) it uses the first capable harness with an Automatic model.
  const test = settings.resolve(ORG, null);
  assert.ok(test.ok);
  assert.equal(test.target.agentId, "claude-code");
  assert.equal(test.target.model, "haiku");
  state.agents = [claude({}, false), codex()];
  assert.deepEqual(settings.resolve(ORG, { runnerId: "runner-1", agentId: "claude-code", driver: "claude-code" }),
    { ok: false, errorClass: "harness_unavailable" }, "never another harness in its place");
  state.agents = [claude({ authStatus: "unauthenticated" }), codex()];
  assert.deepEqual(settings.resolve(ORG, { runnerId: "runner-1", agentId: "claude-code", driver: "claude-code" }),
    { ok: false, errorClass: "authentication" });
  state.protocolVersion = 284;
  assert.deepEqual(settings.resolve(ORG, { runnerId: "runner-1", agentId: "codex", driver: "codex-app-server" }),
    { ok: false, errorClass: "runner_incapable" });
  assert.deepEqual(settings.resolve(ORG, null), { ok: false, errorClass: "runner_incapable" });
});

test("an explicit target overrides Automatic and is never silently replaced when unavailable", () => {
  const { settings, state } = fixture();
  const saved = settings.configure(ORG, {
    runnerId: "runner-1", agentId: "claude-code", driver: "claude-code", model: "opus", effort: "medium",
  });
  assert.equal(saved.source, "organization");
  assert.equal(saved.target?.available, true);
  assert.equal(saved.target?.provider, "claude");
  const resolved = settings.resolve(ORG, { runnerId: "runner-1", agentId: "codex", driver: "codex-app-server" });
  assert.ok(resolved.ok);
  assert.equal(resolved.target.source, "organization");
  assert.equal(resolved.target.model, "opus");
  state.agents = [claude({ capabilities: { ...claude().capabilities!, models: [{ id: "haiku", efforts: ["low"] }] } }), codex()];
  const gone = settings.resolve(ORG, null);
  assert.equal(gone.ok, false);
  assert.equal(!gone.ok && gone.errorClass, "model_unavailable");
  assert.equal(settings.view(ORG, true).target?.reason, "The selected model is no longer advertised.");
  state.status = "offline";
  const offline = settings.resolve(ORG, null);
  assert.equal(!offline.ok && offline.errorClass, "runner_incapable");
  state.status = "online";
  state.agents = [claude({ claudeCode: { ...claude().claudeCode!, auth: { status: "authenticated", billingSource: "api" } } }), codex()];
  const drift = settings.resolve(ORG, null);
  assert.equal(!drift.ok && drift.errorClass, "configuration", "a billing change needs an administrator to confirm it");
  assert.equal(settings.useAutomatic(ORG).source, "automatic");
});

test("configuring a harness that cannot host Decision calls is refused", () => {
  const { settings, state } = fixture();
  state.agents = [claude({}, false), codex()];
  assert.throws(() => settings.configure(ORG, {
    runnerId: "runner-1", agentId: "claude-code", driver: "claude-code", model: "haiku", effort: "low",
  }), DecisionModelUnavailableError);
  assert.throws(() => settings.configure(ORG, {
    runnerId: "runner-1", agentId: "codex", driver: "codex-app-server", model: "gpt-5.5", effort: "max",
  }), DecisionModelUnavailableError);
});

test("administrators change and test the setting; other members only read it", async () => {
  const { db, settings } = fixture();
  const sent: RunDecisionMessage[] = [];
  const runtime = new DecisionRuntime({
    db,
    settings,
    transport: async (_runnerId, message) => {
      sent.push(message);
      return {
        type: "run_decision_result", requestId: message.requestId, ok: true, provider: "claude", model: "claude-haiku-4-5",
        outputText: JSON.stringify({ verdict: DECISION_PROBE_EXPECTED_VERDICT, reason: "picoduck/example is listed." }),
      };
    },
    sleep: async () => {},
  });
  const principals: Record<string, AuthPrincipal> = {
    viewer: human("viewer"),
    operator: human("operator"),
    admin: human("admin"),
    agent: {
      kind: "agent", actorId: "agent", organizationId: ORG,
      delegatedScope: { organizationId: ORG, owner: { kind: "organization", organizationId: ORG } },
    },
  };
  const app = Fastify();
  registerDecisionModelRoutes(app, {
    settings,
    runtime,
    requestPrincipal: (request) => principals[String(request.headers["x-test-principal"])] ?? null,
  });
  const call = (who: string, method: "GET" | "PUT" | "DELETE" | "POST", url: string, payload?: object) =>
    app.inject({ method, url, headers: { "x-test-principal": who }, ...(payload ? { payload } : {}) });

  assert.equal((await call("nobody", "GET", "/api/decision-model")).statusCode, 403);
  assert.equal((await call("agent", "GET", "/api/decision-model")).statusCode, 403);
  const read = await call("viewer", "GET", "/api/decision-model");
  assert.equal(read.statusCode, 200);
  assert.equal(read.json<DecisionModelSettingsView>().canManage, false);
  assert.equal((await call("admin", "GET", "/api/decision-model")).json<DecisionModelSettingsView>().canManage, true);

  const choice = { runnerId: "runner-1", agentId: "codex", driver: "codex-app-server", model: "gpt-5.5", effort: "low" };
  for (const who of ["viewer", "operator", "agent"]) {
    assert.equal((await call(who, "PUT", "/api/decision-model", choice)).statusCode, 403);
    assert.equal((await call(who, "DELETE", "/api/decision-model")).statusCode, 403);
    assert.equal((await call(who, "POST", "/api/decision-model/test")).statusCode, 403);
  }
  assert.equal(sent.length, 0);
  assert.equal((await call("admin", "PUT", "/api/decision-model", { runnerId: "runner-1" })).statusCode, 400);
  assert.equal((await call("admin", "PUT", "/api/decision-model", { ...choice, effort: "max" })).statusCode, 409);
  const saved = await call("admin", "PUT", "/api/decision-model", choice);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json<DecisionModelSettingsView>().target?.model, "gpt-5.5");
  assert.equal((await call("viewer", "GET", "/api/decision-model")).json<DecisionModelSettingsView>().target?.model, "gpt-5.5");

  const tested = await call("admin", "POST", "/api/decision-model/test");
  assert.equal(tested.statusCode, 200);
  const result = tested.json<DecisionModelTestResult>();
  assert.equal(result.occurrence.verdict, DECISION_PROBE_EXPECTED_VERDICT);
  assert.equal(result.occurrence.kind, "probe");
  assert.equal(result.occurrence.attempts.length, 1);
  assert.equal(result.occurrence.target?.model, "gpt-5.5");
  assert.equal(result.occurrence.target?.source, "organization");
  assert.equal(typeof result.latencyMs, "number");
  assert.deepEqual(sent[0]!.target, { agentId: "codex", driver: "codex-app-server", model: "gpt-5.5", effort: "low" });

  const automatic = await call("admin", "DELETE", "/api/decision-model");
  assert.equal(automatic.json<DecisionModelSettingsView>().source, "automatic");
  assert.equal(automatic.json<DecisionModelSettingsView>().target, undefined);
});
