import type { AgentDefinition, AgentDriverKind } from "@wollipog/protocol";

export const GENERATED_CONDUCTOR_DISPLAY_NAME = "Conductor (Wollipog)";

export function driverKindLabel(driver: AgentDriverKind, registry = false): string {
  if (driver === "codex-app-server") return "Codex App Server";
  if (driver === "codex") return "Codex Non-Interactive";
  if (driver === "claude-code") return "Claude Code Native";
  return registry ? "ACP Registry Adapter" : "ACP Adapter";
}

/** Normalize generated names across rolling runner upgrades without rewriting custom agent names. */
export function isGeneratedConductorName(name: string): boolean {
  return /^Conductor \((?:agent manager|wollipog)\)$/i.test(name);
}

export function agentDisplayName(agent: AgentDefinition): string {
  if (agent.id === "conductor" || isGeneratedConductorName(agent.name)) {
    return GENERATED_CONDUCTOR_DISPLAY_NAME;
  }
  if (agent.source === "discovered" && agent.driver === "codex") return "Codex (Non-Interactive)";
  if (agent.source === "discovered" && agent.driver === "codex-app-server") return "Codex";
  return agent.name;
}

export function agentDriverDescription(agent: AgentDefinition): string {
  if (agent.driver === "codex-app-server") {
    return "Keeps a live Codex connection for resumable conversations, streaming updates, and interactive approval requests.";
  }
  if (agent.driver === "codex") {
    return "Uses codex exec to run each turn non-interactively. Approval and sandbox settings are fixed before the turn starts.";
  }
  if (agent.driver === "claude-code") {
    return "Uses the native Claude Code integration and its local session history.";
  }
  return "Uses the configured ACP adapter and its session capabilities.";
}

/** Friendly driver name for status surfaces. Raw protocol ids remain useful in logs and CSS only. */
export function agentDriverLabel(agent: AgentDefinition): string {
  return driverKindLabel(agent.driver ?? "acp", Boolean(agent.registry));
}
