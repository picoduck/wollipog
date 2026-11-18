import type {
  AgentDefinition, AutomationSchedule, SavedHarnessInstallation, RunnerView,
} from "@wollipog/protocol";
import { agentAvailableForRunnerDefault, isRetiredCodexExec, runnerSupportsProtocol } from "@wollipog/protocol";
import { agentOptions } from "./components/agent-options.js";

/**
 * How an automation's agents resolve against a Machine's discovered installations. The automation
 * page warns when a saved installation is gone (#2968), and the Automation editor (#2967) shows the
 * same fact beside the field it concerns, so both read these.
 */

type Runner = RunnerView | undefined;

/** The agent a new or re-targeted automation starts with: the first one that can run. */
export function defaultAgentId(agents: readonly AgentDefinition[] | undefined, defaults?: RunnerView["providerAccountDefaults"]): string {
  return agentOptions([...(agents ?? [])]).find((option) => !option.disabled &&
    agentAvailableForRunnerDefault(option.agent, defaults))?.agent.id ?? "";
}

/**
 * The agents an Agent field lists. An automation already bound to discovery's restart-only exec row
 * keeps it listed so editing renders truthfully; it is never offered to a new or rebound automation.
 */
export function offeredAgents(agents: readonly AgentDefinition[] | undefined, current: string): AgentDefinition[] {
  return (agents ?? []).filter((agent) => !isRetiredCodexExec(agent) || agent.id === current);
}

/** The exact installation an agent would be pinned to on this Machine, or null when none can be. */
export function installationFor(runner: Runner, agentId: string): SavedHarnessInstallation | null {
  const agent = runner?.agents.find((candidate) => candidate.id === agentId);
  return runnerSupportsProtocol(runner?.protocolVersion, "harnessInstallations") &&
    agent?.installation && agentAvailableForRunnerDefault(agent, runner?.providerAccountDefaults) &&
    agent.installation.selection !== "other" && !agent.harnessSelectionBlocked
    ? { driver: agent.driver ?? "acp", context: agent.context ?? { kind: "native" as const },
        installationId: agent.installation.id } : null;
}

/** An unpinned agent that can neither run as configured nor be pinned to its one installation. */
export function unboundInstallationUnavailable(runner: Runner, agentId: string, mayAutoPin: boolean): boolean {
  const installed = runner?.agents.filter((agent) => agent.id === agentId && agent.installation) ?? [];
  return !runner?.agents.some((agent) => agent.id === agentId && !agent.installation) &&
    !(mayAutoPin && installed.length === 1 && installationFor(runner, agentId) !== null);
}

/** The agent on this Machine whose current installation is the saved one, if any still is. */
export function resolvedInstallationAgentId(runner: Runner, saved: SavedHarnessInstallation): string | undefined {
  return runner?.agents.find((agent) => {
    const current = installationFor(runner, agent.id);
    return current?.installationId === saved.installationId && current.driver === saved.driver &&
      current.context.kind === saved.context.kind &&
      // The kinds are equal here, so both are WSL or neither is.
      (current.context.kind !== "wsl" || saved.context.kind !== "wsl" || current.context.distro === saved.context.distro);
  })?.id;
}

/** Whether the saved installation is still on this Machine. */
export function bindingAvailable(runner: Runner, saved: SavedHarnessInstallation): boolean {
  return Boolean(resolvedInstallationAgentId(runner, saved));
}

/** Whether the saved agent on the primary or an alternate Machine is unavailable. */
export function automationInstallationUnavailable(
  item: AutomationSchedule,
  runners: ReadonlyMap<string, RunnerView>,
): boolean {
  if (item.action.kind !== "create_session") return false;
  const unavailable = (runnerId: string, agentId: string, bindings: import("@wollipog/protocol").AutomationInstallationBindings | undefined) =>
    bindings?.agent ? !bindingAvailable(runners.get(runnerId), bindings.agent)
      : unboundInstallationUnavailable(runners.get(runnerId), agentId, bindings === undefined);
  return unavailable(item.action.request.runnerId, item.action.request.agentId, item.action.installationBindings) ||
    (item.runnerPolicy.kind === "alternate" && item.runnerPolicy.targets.some((target) =>
      unavailable(target.runnerId, target.agentId!, target.installationBindings)));
}
