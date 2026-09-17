import type { AgentDefinition, AgentDriverKind, AgentHarnessIdentity, OrchestratorHarnessCapability } from "@wollipog/protocol";

export function driverKindLabel(driver: AgentDriverKind, registry = false): string {
  if (driver === "codex-app-server") return "Codex App Server";
  if (driver === "codex") return "Codex Non-Interactive";
  if (driver === "claude-code") return "Claude Code Native";
  if (driver === "pi") return "Pi RPC";
  return registry ? "ACP Registry Adapter" : "ACP Adapter";
}

export function agentHarnessDriverLabel(driver: AgentDriverKind): string {
  if (driver === "codex-app-server") return "Codex App Server";
  if (driver === "claude-code") return "Claude Code";
  if (driver === "acp") return "ACP";
  if (driver === "pi") return "Pi";
  return "Codex";
}

export function agentHarnessContextLabel(identity: Pick<AgentHarnessIdentity, "context">): string {
  return identity.context.kind === "wsl" ? `WSL ${identity.context.distro}` : "Native";
}

export function agentHarnessOptionLabel(
  harness: Pick<OrchestratorHarnessCapability, "name" | "driver" | "context">,
): string {
  return `${harness.name} · ${agentHarnessDriverLabel(harness.driver)} · ${agentHarnessContextLabel(harness)}`;
}

export function agentHarnessIdentityLabel(identity: AgentHarnessIdentity): string {
  return `${identity.agentId} · ${agentHarnessDriverLabel(identity.driver)} · ${agentHarnessContextLabel(identity)}`;
}

/** Normalize only names emitted by earlier Wollipog onboarding, preserving custom agent names. */
export function isGeneratedCodexAppServerName(name: string): boolean {
  return /^Codex(?: —)? Interactive$/u.test(name);
}

export function agentDisplayName(agent: AgentDefinition): string {
  if (agent.source === "discovered" && agent.driver === "codex") return "Codex (Non-Interactive)";
  if (agent.driver === "codex-app-server" &&
      (agent.source === "discovered" || isGeneratedCodexAppServerName(agent.name))) return "Codex App Server";
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
  if (agent.driver === "pi") {
    return "Uses Pi's persistent RPC mode for streaming, tools, steering, extension questions, and local session history.";
  }
  return "Uses the configured ACP adapter and its session capabilities.";
}

/** Friendly driver name for status surfaces. Raw protocol ids remain useful in logs and CSS only. */
export function agentDriverLabel(agent: AgentDefinition): string {
  return driverKindLabel(agent.driver ?? "acp", Boolean(agent.registry));
}
