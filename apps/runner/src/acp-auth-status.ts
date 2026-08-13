import type { AcpRuntimeCapabilities, AgentDefinition } from "@wollipog/protocol";

export type AcpAuthStatus = "authenticated" | "unauthenticated";
export interface AcpAuthRuntime {
  status?: AcpAuthStatus;
  capabilities?: AcpRuntimeCapabilities;
}

/** Reapply runtime-confirmed ACP readiness after static discovery rebuilds the agent catalog. */
export function overlayAcpAuthStatus(
  agents: AgentDefinition[],
  states: ReadonlyMap<string, AcpAuthRuntime>,
): AgentDefinition[] {
  return agents.map((agent) => {
    const state = states.get(agent.id);
    if (!state || (agent.driver ?? "acp") !== "acp") return agent;
    return {
      ...agent,
      ...(state.status ? { authStatus: state.status } : {}),
      ...(state.capabilities ? { acp: state.capabilities } : {}),
    };
  });
}
