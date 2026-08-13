import type { AgentDefinition, WorkflowDefinition } from "@wollipog/protocol";

export type SessionWorkMode = "agent" | "conductor";
export type RunWorkMode = "parallel" | "workflow";

export function conductorAgentId(agents: AgentDefinition[]): string | undefined {
  return agents.find((agent) => agent.id === "conductor" && agent.available !== false)?.id;
}

export function workflowAgentRoles(definition: WorkflowDefinition | undefined): string[] {
  if (!definition) return [];
  return [...new Set(definition.nodes
    .filter((node) => node.kind === "agent" && node.agentId)
    .map((node) => node.agentId!))];
}

/** Resolve graph-stable role ids to the best concrete agent advertised by this runner. */
export function defaultWorkflowBindings(
  definition: WorkflowDefinition | undefined,
  agents: AgentDefinition[],
): Record<string, string> {
  const available = agents.filter((agent) => agent.available !== false && agent.id !== "conductor");
  const bindings: Record<string, string> = {};
  for (const role of workflowAgentRoles(definition)) {
    const exact = available.find((agent) => agent.id === role);
    const family = /claude/i.test(role)
      ? available.find((agent) => agent.driver === "claude-code")
      : /codex/i.test(role)
        ? available.find((agent) => agent.driver === "codex-app-server") ??
          available.find((agent) => agent.driver === "codex")
        : undefined;
    const selected = exact ?? family;
    if (selected) bindings[role] = selected.id;
  }
  return bindings;
}

export function workflowBindingsComplete(
  definition: WorkflowDefinition | undefined,
  bindings: Record<string, string>,
): boolean {
  const roles = workflowAgentRoles(definition);
  return roles.every((role) => Boolean(bindings[role]));
}
