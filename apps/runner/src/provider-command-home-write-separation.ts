import type { AgentDefinition, ProviderCommandHomeWriteSeparation, SessionSnapshot } from "@wollipog/protocol";

/** A disclosure of the runner's complete command mediation, not the configured isolation mode or
 * whether a provider's nested sandbox happens to work. Never probe credentials or run a provider. */
export function providerCommandHomeWriteSeparation(
  agent: Pick<AgentDefinition, "driver" | "context">,
  platform: NodeJS.Platform = process.platform,
): ProviderCommandHomeWriteSeparation {
  if (agent.context?.kind === "wsl" || (platform !== "linux" && platform !== "darwin")) {
    return { version: 1, status: "unavailable", reason: "unsupported_host" };
  }
  return {
    version: 1,
    status: "unprotected",
    reason: !agent.driver || agent.driver === "acp" ? "incomplete_adapter_coverage" : "unsupported_command_mediation",
  };
}

export function withProviderCommandHomeWriteSeparation(
  agents: readonly AgentDefinition[],
): AgentDefinition[] {
  return agents.map(agent => ({ ...agent,
    providerCommandHomeWriteSeparation: providerCommandHomeWriteSeparation(agent),
  }));
}

export function providerCommandHomeWriteSeparationDiagnostic(
  agent: Pick<AgentDefinition, "driver" | "context"> & Pick<Partial<SessionSnapshot>, "executionTarget">,
): string {
  return JSON.stringify({ event: "provider_command_home_write_separation",
    ...(agent.executionTarget && agent.executionTarget.adapter !== "host"
      ? { status: "unknown", reason: "report_unavailable" }
      : providerCommandHomeWriteSeparation(agent)) });
}
