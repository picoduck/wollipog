import {
  installationSupportsDefault,
  orchestratorAdditiveCapability,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type AgentDefinition,
  type AgentDriverKind,
  type AgentHarnessDefaultsView,
} from "@wollipog/protocol";

/** Match the server's exact harness identity and whole-preference capability check. */
export function savedSessionPermissionMode(
  view: AgentHarnessDefaultsView | null,
  agent: AgentDefinition | undefined,
): string | undefined {
  if (!agent?.capabilities) return undefined;
  const context = agent.context ?? { kind: "native" };
  const preference = view?.defaults.find((option) =>
    option.agentId === agent.id && option.driver === (agent.driver ?? "acp") &&
    option.context.kind === context.kind &&
    (context.kind !== "wsl" || (option.context.kind === "wsl" && option.context.distro === context.distro))
  )?.preference;
  if (!preference || !installationSupportsDefault({
    models: agent.capabilities.models.filter((model) => model.id !== "default" && !model.hidden),
    effortLevels: agent.capabilities.effortLevels ?? [],
    permissionModes: agent.capabilities.permissionModes ?? [],
  }, preference)) return undefined;
  return preference.permissionMode;
}

/**
 * Why Orchestrator cannot be chosen here, or `undefined` when it can.
 *
 * The preset used to be OMITTED from the list whenever it was unsupported, which is the one thing
 * §11.3 forbids: a user who had read about Orchestrator met a control with a single option and no
 * way to learn whether the reason was their runner, their agent, or their execution target.
 *
 * Rendering it disabled instead needs a sentence per cause, so the causes are collected here rather
 * than collapsed into the single "requires a supported native host harness or verified Direct WSL
 * bridge and runner" message — which named four possibilities and confirmed none of them.
 *
 * Ordered most-actionable first. Where several apply they are all returned because the user has to
 * clear them all, and the runner and the agent are the two they can change without changing what
 * they are launching.
 */
export function orchestratorUnavailableReason(input: {
  runnerSupportsOrchestration: boolean;
  agentOffersOrchestrator: boolean;
  agentOrchestratorRequirement?: string;
  /** The agent's execution context. `"wsl"` needs the verified safe launcher; `"native"` does not. */
  contextKind: string;
  directWslVerified: boolean;
  hostExecutionTarget: boolean;
}): string | undefined {
  const reasons: string[] = [];
  if (!input.runnerSupportsOrchestration) reasons.push("This runner is too old to orchestrate child sessions.");
  // A pre-orchestration runner may omit the mode simply because its binary never advertised it.
  // A discovery-specific requirement remains trustworthy; the generic absence does not.
  if (!input.agentOffersOrchestrator &&
      (input.runnerSupportsOrchestration || input.agentOrchestratorRequirement)) {
    reasons.push(input.agentOrchestratorRequirement ?? "This agent does not offer the Orchestrator permission mode.");
  }
  if (input.contextKind === "wsl" && !input.directWslVerified) {
    reasons.push("WSL agents need the verified Direct WSL bridge and a bubblewrap-isolated runner.");
  }
  // Neither native nor WSL: a context this dialog has no rule for is unavailable rather than
  // silently allowed, and it says which context it refused so a new one is reported rather than
  // merely broken.
  if (input.contextKind !== "native" && input.contextKind !== "wsl") {
    reasons.push(`Orchestrator runs on a native host or a verified WSL bridge, not a ${input.contextKind} context.`);
  }
  if (!input.hostExecutionTarget) reasons.push("Orchestrator runs only on the host execution target.");
  return reasons.length > 0 ? reasons.join(" ") : undefined;
}

/**
 * Why an Orchestrator must launch with the harness-owned Orchestrator preset instead of the same
 * provider permission mode a normal session would use, or `undefined` when the role is additive.
 *
 * Only a non-strict native Claude Code (v160) or Codex (v162) Orchestrator on a supporting runner
 * and control plane keeps its ordinary permission mode, tool inventory, apps, plugins, hooks, and
 * configured MCP servers. Every other combination still uses the coupled preset, and the sentence
 * names which condition selects it so the user can change the one they control.
 */
export function orchestratorPresetPermissionsReason(input: {
  controlPlaneSupportsRole: boolean;
  runnerProtocolVersion: number | null | undefined;
  driver: AgentDriverKind | undefined;
  contextKind: string;
  hostExecutionTarget: boolean;
  nativeTui: boolean;
  strictProjectIsolation: boolean;
  savedOrchestratorDefault: boolean;
}): string | undefined {
  if (input.strictProjectIsolation) {
    return "Strict Project Isolation is enforced through the harness-owned Orchestrator preset.";
  }
  const additiveCapability = orchestratorAdditiveCapability(input.driver);
  if (!additiveCapability) {
    return "This harness still uses the harness-owned Orchestrator preset; independent provider permissions are available for native Claude Code and Codex.";
  }
  if (input.contextKind !== "native" || !input.hostExecutionTarget) {
    return "Independent provider permissions are available only for a native Claude Code or Codex harness on the host execution target.";
  }
  if (input.nativeTui) {
    return "Native TUI Orchestrators use the harness-owned Orchestrator preset.";
  }
  if (input.savedOrchestratorDefault) {
    return "Orchestrator is your saved Agent Harness default and selects the Orchestrator preset. Change it in Settings to use ordinary provider permissions.";
  }
  if (!input.controlPlaneSupportsRole) {
    return "Update the control plane to give an Orchestrator ordinary provider permissions.";
  }
  if (!runnerSupportsProtocol(input.runnerProtocolVersion, additiveCapability)) {
    return runnerCapabilityRequirement(
      input.runnerProtocolVersion,
      additiveCapability,
      "Independent Orchestrator provider permissions",
    );
  }
  return undefined;
}
