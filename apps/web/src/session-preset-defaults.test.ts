import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition, AgentHarnessDefaultsView } from "@wollipog/protocol";
import { orchestratorUnavailableReason, savedSessionPermissionMode } from "./session-preset-defaults.js";

const agent: AgentDefinition = {
  id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server",
  capabilities: {
    models: [{ id: "model-a", displayName: "Model A", efforts: ["high"] }],
    effortLevels: ["low"], permissionModes: ["default", "orchestrator"],
    slashCommands: [], supportsImages: false, supportsApprovals: true,
  },
};
const view: AgentHarnessDefaultsView = { defaults: [{
  agentId: "codex", name: "Codex", driver: "codex-app-server", context: { kind: "native" },
  installations: [], compatibleInstallations: 1, preference: { permissionMode: "orchestrator" },
}] };

test("saved preset identity includes agent, driver, context, and WSL distro", () => {
  assert.equal(savedSessionPermissionMode(view, agent), "orchestrator");
  assert.equal(savedSessionPermissionMode(view, { ...agent, id: "other" }), undefined);
  assert.equal(savedSessionPermissionMode(view, { ...agent, driver: "codex" }), undefined);
  assert.equal(savedSessionPermissionMode(view, { ...agent, context: { kind: "wsl", distro: "Ubuntu" } }), undefined);
  const wsl = structuredClone(view);
  wsl.defaults[0]!.context = { kind: "wsl", distro: "Ubuntu" };
  assert.equal(savedSessionPermissionMode(wsl, { ...agent, context: { kind: "wsl", distro: "Ubuntu" } }), "orchestrator");
  assert.equal(savedSessionPermissionMode(wsl, { ...agent, context: { kind: "wsl", distro: "Debian" } }), undefined);
});

test("saved preset follows whole-combination capability drift, including model-specific effort", () => {
  for (const preference of [
    { permissionMode: "orchestrator", model: "missing" },
    { permissionMode: "orchestrator", effort: "high" },
    { permissionMode: "orchestrator", model: "model-a", effort: "low" },
    { permissionMode: "unknown" },
    {},
  ]) {
    assert.equal(savedSessionPermissionMode({ defaults: [{ ...view.defaults[0]!, preference }] }, agent), undefined);
  }
  assert.equal(savedSessionPermissionMode({ defaults: [{ ...view.defaults[0]!,
    preference: { permissionMode: "orchestrator", model: "model-a", effort: "high" },
  }] }, agent), "orchestrator");
  const hidden = structuredClone(agent);
  hidden.capabilities!.models[0]!.hidden = true;
  assert.equal(savedSessionPermissionMode({ defaults: [{ ...view.defaults[0]!,
    preference: { permissionMode: "orchestrator", model: "model-a" },
  }] }, hidden), undefined);
  assert.equal(savedSessionPermissionMode(null, agent), undefined);
  assert.equal(savedSessionPermissionMode(view, { ...agent, capabilities: undefined }), undefined);
});

/**
 * Each cause gets its own sentence, because the message it replaced named four possibilities and
 * confirmed none of them: "requires a supported native host harness or verified Direct WSL bridge
 * and runner" left a user guessing which of their runner, agent, context or target was the problem.
 */
const AVAILABLE = {
  runnerSupportsOrchestration: true,
  agentOffersOrchestrator: true,
  contextKind: "native",
  directWslVerified: false,
  hostExecutionTarget: true,
} as const;

test("a fully supported host says nothing, because there is nothing to explain", () => {
  assert.equal(orchestratorUnavailableReason(AVAILABLE), undefined);
});

test("each cause names ITSELF rather than the union of the four", () => {
  const reason = (overrides: Partial<typeof AVAILABLE>) =>
    orchestratorUnavailableReason({ ...AVAILABLE, ...overrides });

  assert.match(reason({ runnerSupportsOrchestration: false }) ?? "", /runner is too old/);
  assert.match(reason({ agentOffersOrchestrator: false }) ?? "", /agent does not offer/);
  assert.match(reason({ contextKind: "wsl" }) ?? "", /verified Direct WSL bridge/);
  assert.match(reason({ hostExecutionTarget: false }) ?? "", /host execution target/);
});

test("a verified WSL bridge is available, and an unverified one is not", () => {
  assert.equal(
    orchestratorUnavailableReason({ ...AVAILABLE, contextKind: "wsl", directWslVerified: true }),
    undefined,
  );
  assert.match(
    orchestratorUnavailableReason({ ...AVAILABLE, contextKind: "wsl", directWslVerified: false }) ?? "",
    /bubblewrap-isolated runner/,
  );
});

test("a context with no rule is refused BY NAME rather than allowed by omission", () => {
  // The condition this replaced was `kind === "native" || directWslVerified`, so a third context
  // fell through to unavailable with the WSL sentence — which named a bridge that had nothing to
  // do with it. A new context should read as unhandled, not as a WSL misconfiguration.
  const reason = orchestratorUnavailableReason({ ...AVAILABLE, contextKind: "container" }) ?? "";
  assert.match(reason, /container/);
  assert.doesNotMatch(reason, /WSL bridge and a bubblewrap/);
});

test("the runner is reported before the agent, and the agent before the target", () => {
  // Several causes can hold at once. The order is the order a user can act in, and asserting it
  // keeps a later edit from surfacing "host execution target" to someone whose runner cannot
  // orchestrate at all.
  assert.match(orchestratorUnavailableReason({
    runnerSupportsOrchestration: false,
    agentOffersOrchestrator: false,
    contextKind: "wsl",
    directWslVerified: false,
    hostExecutionTarget: false,
  }) ?? "", /runner is too old/);
  assert.match(orchestratorUnavailableReason({
    ...AVAILABLE,
    agentOffersOrchestrator: false,
    hostExecutionTarget: false,
  }) ?? "", /agent does not offer/);
});
