import type { AgentDefinition, ProviderReadiness } from "@wollipog/protocol";
import { ProviderHomeLeaseError } from "./provider-home-lease-worker-protocol.js";

export function providerInstallationState(agent: AgentDefinition): ProviderReadiness["installation"] {
  const capability = agent.codexAppServer ?? agent.claudeCode;
  if (!capability) return "unknown";
  if (capability.failure?.retryable || ["probe_timeout", "probe_failed"].includes(capability.failure?.code ?? "")) return "unknown";
  // unsupported_mode can be a missing host prerequisite (notably Windows Git Bash). An update
  // is not proved to fix that; retain the runner's actionable detail without guessing from prose.
  if (agent.claudeCode?.failure?.code === "unsupported_mode") return "unknown";
  if (capability.status === "unavailable") return "missing";
  if (capability.status === "unsupported") return "incompatible";
  return "compatible";
}

export function providerReadinessObservation(agent: AgentDefinition, authentication: ProviderReadiness["authentication"],
  error?: unknown, checkedAt = Date.now()): ProviderReadiness {
  let reason: ProviderReadiness["reason"] = authentication === "authenticated" ? "ready"
    : authentication === "unauthenticated" ? "sign_in_required" : "unknown";
  if (error instanceof ProviderHomeLeaseError) {
    if (["holder_alive", "boundary_survivor", "process_survivor", "busy"].includes(error.code)) reason = "in_use";
    else if (["profile_not_granted", "profile_changed", "profile_unsupported_control_plane"].includes(error.code)) reason = "restricted";
  }
  return { checkedAt, installation: providerInstallationState(agent), authentication, reason };
}

export function mergeInstallationAndAccountReadiness(installation: ProviderReadiness, account?: ProviderReadiness): ProviderReadiness {
  return account ? { ...account, installation: installation.installation,
    installationAdmission: installation.installationAdmission } : installation;
}
