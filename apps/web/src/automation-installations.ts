import type {
  AgentDefinition, AutomationSchedule, SavedHarnessInstallation, RunnerView, WorkflowDefinition,
} from "@wollipog/protocol";
import { isRetiredCodexExec, runnerSupportsProtocol } from "@wollipog/protocol";
import { agentOptions } from "./components/agent-options.js";

/**
 * How an automation's agents resolve against a Machine's discovered installations. The automation
 * page warns when a saved installation is gone (#2968), and the Automation editor (#2967) shows the
 * same fact beside the field it concerns, so both read these.
 */

type Runner = RunnerView | undefined;

/** The agent a new or re-targeted automation starts with: the first one that can run. */
export function defaultAgentId(agents: readonly AgentDefinition[] | undefined): string {
  return agentOptions([...(agents ?? [])]).find((option) => !option.disabled)?.agent.id ??
    agents?.find((agent) => !isRetiredCodexExec(agent))?.id ?? "";
}

/**
 * The agents an Agent field lists. An automation already bound to discovery's restart-only exec row
 * keeps it listed so editing renders truthfully; it is never offered to a new or rebound automation.
 */
export function offeredAgents(agents: readonly AgentDefinition[] | undefined, current: string): AgentDefinition[] {
  return (agents ?? []).filter((agent) => !isRetiredCodexExec(agent) || agent.id === current);
}

/** The agents a workflow role can be bound to on this Machine. */
export function bindableAgents(runner: Runner) {
  return agentOptions(runner?.agents ?? []).filter((option) => !option.disabled);
}

/** The exact installation an agent would be pinned to on this Machine, or null when none can be. */
export function installationFor(runner: Runner, agentId: string): SavedHarnessInstallation | null {
  const agent = runner?.agents.find((candidate) => candidate.id === agentId);
  return runnerSupportsProtocol(runner?.protocolVersion, "harnessInstallations") &&
    agent?.installation && agent.available === true &&
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

/**
 * Whether an automation cannot run because an agent installation it needs is unbound or gone, on
 * its primary Machine or on an alternate: the checks the Automations card made, which the
 * automation page's Agent Unavailable notice now makes (#2968). `workflows` resolves a workflow
 * action's roles; without its definition, no role is judged.
 */
export function automationInstallationUnavailable(
  item: AutomationSchedule,
  runners: ReadonlyMap<string, RunnerView>,
  workflows: readonly WorkflowDefinition[],
): boolean {
  const actionRunner = item.action.kind === "prompt_session" ? undefined : runners.get(item.action.request.runnerId);
  const savedBindings = item.action.kind === "prompt_session" ? undefined : item.action.installationBindings;
  const unavailableInstallation = savedBindings && Object.values(savedBindings)
    .some((binding) => !bindingAvailable(actionRunner, binding));
  const unboundInstallation = item.action.kind === "create_session" && !savedBindings?.agent &&
    unboundInstallationUnavailable(actionRunner, item.action.request.agentId, savedBindings === undefined);
  const workflowAction = item.action.kind === "workflow_run" ? item.action : null;
  const workflow = workflowAction && workflows.find((definition) =>
    definition.workflowId === workflowAction.request.workflowId &&
    (workflowAction.request.workflowVersion === undefined ||
      definition.version === workflowAction.request.workflowVersion));
  const unboundWorkflow = workflowAction !== null && (workflow?.nodes.some((node) => {
    if (node.kind !== "agent") return false;
    const role = node.agentId!;
    if (savedBindings?.[`role:${role}`]) return false;
    const id = workflowAction.request.agentBindings?.[role] ?? role;
    return !actionRunner?.agents.some((agent) => agent.id === id && !agent.installation);
  }) ?? false);
  const unboundOrchestrator = workflowAction?.request.orchestratorAgentId &&
    !savedBindings?.orchestrator && !actionRunner?.agents.some((agent) =>
      agent.id === workflowAction.request.orchestratorAgentId && !agent.installation);
  const unavailableAlternate = item.runnerPolicy.kind === "alternate" &&
    item.runnerPolicy.targets.some((target) => {
      const runner = runners.get(target.runnerId);
      const bindings = target.installationBindings;
      if (Object.values(bindings ?? {}).some((binding) => !bindingAvailable(runner, binding))) return true;
      if (item.action.kind === "create_session") {
        return !bindings?.agent &&
          unboundInstallationUnavailable(runner, target.agentId!, bindings === undefined);
      }
      if (!workflowAction) return false;
      const unboundRole = workflow?.nodes.some((node) => {
        if (node.kind !== "agent") return false;
        const role = node.agentId!;
        if (bindings?.[`role:${role}`]) return false;
        const id = target.agentBindings?.[role] ?? workflowAction.request.agentBindings?.[role] ?? role;
        return !runner?.agents.some((agent) => agent.id === id && !agent.installation);
      }) ?? false;
      const orchestrator = target.orchestratorAgentId ?? workflowAction.request.orchestratorAgentId;
      return unboundRole || Boolean(orchestrator && !bindings?.orchestrator &&
        !runner?.agents.some((agent) => agent.id === orchestrator && !agent.installation));
    });
  return Boolean(unavailableInstallation || unboundInstallation || unboundWorkflow || unboundOrchestrator || unavailableAlternate);
}
