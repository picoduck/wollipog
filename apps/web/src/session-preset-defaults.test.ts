import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition, AgentHarnessDefaultsView } from "@wollipog/protocol";
import {
  orchestratorPresetPermissionsReason,
  orchestratorUnavailableReason,
  savedSessionPermissionMode,
} from "./session-preset-defaults.js";
import { PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL } from "@wollipog/protocol";

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

test("saved preset identity is the harness: driver, context, and WSL distro, plus the agent id for ACP", () => {
  assert.equal(savedSessionPermissionMode(view, agent), "orchestrator");
  assert.equal(savedSessionPermissionMode(view, { ...agent, id: "codex-app" }), "orchestrator",
    "another Machine's name for the same built-in harness receives the default (#3247)");
  const acp = structuredClone(view);
  acp.defaults[0]!.driver = "acp";
  assert.equal(savedSessionPermissionMode(acp, { ...agent, driver: "acp" }), "orchestrator");
  assert.equal(savedSessionPermissionMode(acp, { ...agent, driver: "acp", id: "other" }), undefined);
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

test("each individual cause names itself", () => {
  const reason = (overrides: Partial<typeof AVAILABLE>) =>
    orchestratorUnavailableReason({ ...AVAILABLE, ...overrides });

  assert.match(reason({ runnerSupportsOrchestration: false }) ?? "", /runner is too old/);
  assert.equal(reason({ agentOffersOrchestrator: false }), "This agent doesn't offer the Orchestrator role.");
  assert.equal(reason({ agentOffersOrchestrator: false, agentName: "Claude Code" }), "Claude Code doesn't offer the Orchestrator role.",
    "the reason names the agent the Agent field shows (#2954)");
  assert.match(reason({ agentOffersOrchestrator: false,
    agentOrchestratorRequirement: "Upgrade Codex to 0.154.0 or newer." }) ?? "", /0\.154\.0/);
  assert.match(reason({ contextKind: "wsl" }) ?? "", /verified Direct WSL bridge/);
  assert.match(reason({ hostExecutionTarget: false }) ?? "", /only on this machine's host, not in a container or the cloud/);
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

test("independent blockers are all reported in actionable order", () => {
  // Several causes can hold at once. Omitting any one can recommend a change that still leaves the
  // configuration unavailable, while stable ordering keeps the explanation predictable.
  assert.equal(orchestratorUnavailableReason({
    runnerSupportsOrchestration: false,
    agentOffersOrchestrator: false,
    agentOrchestratorRequirement: "Upgrade Codex to 0.154.0 or newer.",
    contextKind: "wsl",
    directWslVerified: false,
    hostExecutionTarget: false,
  }), "This runner is too old to orchestrate child sessions. " +
    "Upgrade Codex to 0.154.0 or newer. " +
    "WSL agents need the verified Direct WSL bridge and a bubblewrap-isolated runner. " +
    "Orchestrator runs only on this machine's host, not in a container or the cloud.");
});

test("an old runner suppresses only an unverified generic agent claim", () => {
  assert.equal(orchestratorUnavailableReason({
    ...AVAILABLE,
    runnerSupportsOrchestration: false,
    agentOffersOrchestrator: false,
  }), "This runner is too old to orchestrate child sessions.");
  assert.equal(orchestratorUnavailableReason({
    ...AVAILABLE,
    runnerSupportsOrchestration: false,
    agentOffersOrchestrator: false,
    agentOrchestratorRequirement: "Upgrade Codex to 0.154.0 or newer.",
  }), "This runner is too old to orchestrate child sessions. Upgrade Codex to 0.154.0 or newer.");
});

test("the Orchestrator preset applies only where independent provider permissions are unsupported", () => {
  const runnerRequirement = "This machine needs a newer runner for independent Orchestrator provider permissions. Update and restart the runner.";
  const additive = {
    controlPlaneSupportsRole: true, runnerProtocolVersion: PROTOCOL_VERSION, driver: "claude-code" as const,
    contextKind: "native", hostExecutionTarget: true, nativeTui: false, strictProjectIsolation: false,
    savedOrchestratorDefault: false,
  };
  assert.equal(orchestratorPresetPermissionsReason(additive), undefined);
  assert.match(orchestratorPresetPermissionsReason({ ...additive, strictProjectIsolation: true }) ?? "", /Strict Project Isolation/);
  for (const driver of ["codex", "codex-app-server"] as const) {
    assert.equal(orchestratorPresetPermissionsReason({ ...additive, driver }), undefined,
      "a non-strict Codex Orchestrator keeps ordinary provider permissions");
    // Each harness gates on its own floor: the reason appears just below it and not at it.
    assert.equal(
      orchestratorPresetPermissionsReason({
        ...additive, driver, runnerProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorAdditiveCodex - 1,
      }),
      runnerRequirement,
    );
    assert.equal(
      orchestratorPresetPermissionsReason({
        ...additive, driver, runnerProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorAdditiveCodex,
      }),
      undefined,
      "each harness names its own runner requirement",
    );
    assert.match(orchestratorPresetPermissionsReason({ ...additive, driver, contextKind: "wsl" }) ?? "",
      /Only Claude Code, Codex and Pi on this machine's host keep normal permissions/);
  }
  // Pi gained the additive shape in v163 (#1294); ACP still has no audited provider-mode contract.
  assert.equal(orchestratorPresetPermissionsReason({ ...additive, driver: "pi" }), undefined,
    "a non-strict Pi Orchestrator keeps ordinary provider permissions");
  assert.equal(
    orchestratorPresetPermissionsReason({
      ...additive, driver: "pi", runnerProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorAdditivePi - 1,
    }),
    runnerRequirement,
  );
  assert.equal(
    orchestratorPresetPermissionsReason({
      ...additive, driver: "pi", runnerProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorAdditivePi,
    }),
    undefined,
    "Pi names its own runner requirement",
  );
  assert.match(orchestratorPresetPermissionsReason({ ...additive, driver: "pi", contextKind: "wsl" }) ?? "",
    /Only Claude Code, Codex and Pi on this machine's host keep normal permissions/);
  assert.match(orchestratorPresetPermissionsReason({ ...additive, driver: "acp" }) ?? "",
    /^This agent's adapter can't run an Orchestrator with normal permissions, so the preset sets them\.$/);
  assert.match(orchestratorPresetPermissionsReason({ ...additive, contextKind: "wsl" }) ?? "", /Only Claude Code, Codex and Pi on this machine's host keep normal permissions/);
  assert.match(orchestratorPresetPermissionsReason({ ...additive, hostExecutionTarget: false }) ?? "", /on this machine's host/);
  assert.match(orchestratorPresetPermissionsReason({ ...additive, nativeTui: true }) ?? "", /Native TUI/);
  assert.match(orchestratorPresetPermissionsReason({ ...additive, savedOrchestratorDefault: true }) ?? "", /Your saved default is the Orchestrator preset/);
  const olderServer = orchestratorPresetPermissionsReason({ ...additive, controlPlaneSupportsRole: false }) ?? "";
  assert.equal(olderServer, "This version of Wollipog can't give an Orchestrator normal permissions, so the preset sets them. Update Wollipog to change that.");
  assert.doesNotMatch(olderServer, /control plane|durable/iu, "docs/design-system.md §17.2 retires both terms");
  assert.equal(
    orchestratorPresetPermissionsReason({ ...additive, runnerProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorAdditiveRole - 1 }),
    runnerRequirement,
  );
  assert.equal(
    orchestratorPresetPermissionsReason({ ...additive, runnerProtocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorAdditiveRole }),
    undefined,
  );
});
