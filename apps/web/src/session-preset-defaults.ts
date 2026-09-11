import { installationSupportsDefault, type AgentDefinition, type AgentHarnessDefaultsView } from "@wollipog/protocol";

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
 * Rendering it disabled instead needs a sentence per cause, so the causes are separated here rather
 * than collapsed into the single "requires a supported native host harness or verified Direct WSL
 * bridge and runner" message — which named four possibilities and confirmed none of them.
 *
 * Ordered most-actionable first. Where several apply the user has to clear them all, and the runner
 * and the agent are the two they can change without changing what they are launching.
 */
export function orchestratorUnavailableReason(input: {
  runnerSupportsOrchestration: boolean;
  agentOffersOrchestrator: boolean;
  /** The agent's execution context. `"wsl"` needs the verified safe launcher; `"native"` does not. */
  contextKind: string;
  directWslVerified: boolean;
  hostExecutionTarget: boolean;
}): string | undefined {
  if (!input.runnerSupportsOrchestration) return "This runner is too old to orchestrate child sessions.";
  if (!input.agentOffersOrchestrator) return "This agent does not offer the Orchestrator permission mode.";
  if (input.contextKind === "wsl" && !input.directWslVerified) {
    return "WSL agents need the verified Direct WSL bridge and a bubblewrap-isolated runner.";
  }
  // Neither native nor WSL: a context this dialog has no rule for is unavailable rather than
  // silently allowed, and it says which context it refused so a new one is reported rather than
  // merely broken.
  if (input.contextKind !== "native" && input.contextKind !== "wsl") {
    return `Orchestrator runs on a native host or a verified WSL bridge, not a ${input.contextKind} context.`;
  }
  if (!input.hostExecutionTarget) return "Orchestrator runs only on the host execution target.";
  return undefined;
}
