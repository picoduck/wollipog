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
  /** Either advertisement: the coupled preset's permission mode, or the additive role (#1294). */
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
  // "Offers" means either advertisement: the coupled preset's permission mode, or the runner's
  // separate attestation of the additive role (#1294). This sentence appears only when neither is
  // offered, so an installation that can run the role additively is never described as lacking it.
  if (!input.agentOffersOrchestrator &&
      (input.runnerSupportsOrchestration || input.agentOrchestratorRequirement)) {
    reasons.push(input.agentOrchestratorRequirement ?? "This agent does not offer the Orchestrator role.");
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
 * Only a non-strict native Claude Code (v160), Codex (v162), or Pi (v163) Orchestrator on a
 * supporting runner and control plane keeps its ordinary permission mode, tool inventory, apps,
 * plugins, hooks, extensions, skills, and configured MCP servers. Every other combination still
 * uses the coupled preset — notably ACP, whose provider-mode permission contract is unaudited — and
 * the sentence names which condition selects it so the user can change the one they control.
 */
/**
 * What Integration Isolation removes and keeps, per harness.
 *
 * The policy genuinely differs by harness, because each provider offers different levers, so a
 * single sentence would be wrong for at least one of them. Claude Code in particular isolates MCP
 * servers ONLY: it cannot drop hooks without also dropping either the user's permission rules or
 * Wollipog's own governance hooks, so it under-delivers and says so rather than over-reaching.
 */
export function integrationIsolationDisclosure(driver: AgentDriverKind | undefined): {
  removed: string;
  kept: string;
} {
  if (driver === "codex" || driver === "codex-app-server") {
    return {
      removed: "Removes configured MCP servers, apps, plugins, and hooks, leaving Wollipog's management tools as the only integration.",
      kept: "Built-in tools, including the multi-agent and multimodal tools, are kept, and so is anything named in the agent definition's own launch arguments.",
    };
  }
  if (driver === "pi") {
    return {
      removed: "Removes discovered extensions, skills, prompt templates, and ambient context files, leaving Wollipog's management extension as the only integration.",
      kept: "Built-in tools are kept, and so is anything named in the agent definition's own launch arguments.",
    };
  }
  return {
    removed: "Removes configured MCP servers, so Wollipog's management tools are the only MCP integration.",
    kept: "Hooks, plugins enabled in settings, skills, and your permission rules are all kept, because Claude Code cannot drop hooks without also dropping either your permission rules or Wollipog's own governance hooks.",
  };
}

/** The account-level settings panel has no selected harness, so it states the differences compactly
 * rather than picking one harness's wording and being wrong about the other two. */
export const INTEGRATION_ISOLATION_BY_HARNESS =
  "What is removed depends on the harness: Claude Code removes configured MCP servers only, because " +
  "it cannot drop hooks without also dropping your permission rules or Wollipog's own governance " +
  "hooks; Codex also removes apps, plugins, and hooks; Pi removes discovered extensions, skills, " +
  "prompt templates, and ambient context files.";

/** Companion sentence: what this policy deliberately does not touch, on every harness. */
export const INTEGRATION_ISOLATION_PRESERVED =
  "The provider permission mode, built-in tool inventory, sandbox and approval behavior, and the " +
  "project boundary are unchanged.";

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
    return input.driver === "acp"
      ? "The Claude ACP adapter's provider permission contract is unaudited, so an ACP Orchestrator uses the harness-owned Orchestrator preset."
      : "This harness still uses the harness-owned Orchestrator preset; independent provider permissions are available for native Claude Code, Codex, and Pi.";
  }
  if (input.contextKind !== "native" || !input.hostExecutionTarget) {
    return "Independent provider permissions are available only for a native Claude Code, Codex, or Pi harness on the host execution target.";
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
