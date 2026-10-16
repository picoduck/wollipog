import { isRetiredCodexExec, type AgentDefinition, type WorkflowDefinition } from "@wollipog/protocol";

export type RunWorkMode = "parallel" | "workflow";

export function workflowAgentRoles(definition: WorkflowDefinition | undefined): string[] {
  if (!definition) return [];
  return [...new Set(definition.nodes
    .filter((node) => node.kind === "agent" && node.agentId)
    .map((node) => node.agentId!))];
}

/** Resolve graph-stable role ids to the best concrete agent advertised by this runner. A Codex
 * role binds only to App Server; without one it stays unbound rather than quietly using exec. */
export function defaultWorkflowBindings(
  definition: WorkflowDefinition | undefined,
  agents: AgentDefinition[],
): Record<string, string> {
  const available = agents.filter((agent) => agent.available === true && !isRetiredCodexExec(agent));
  const bindings: Record<string, string> = {};
  for (const role of workflowAgentRoles(definition)) {
    const codexRole = /codex/i.test(role);
    // Even an exact id match: a configured exec agent may carry the old stable `codex` id.
    const exact = available.find((agent) => agent.id === role && (!codexRole || agent.driver === "codex-app-server"));
    const family = /claude/i.test(role)
      ? available.find((agent) => agent.driver === "claude-code")
      : codexRole
        ? available.find((agent) => agent.driver === "codex-app-server")
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
