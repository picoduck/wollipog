import type { AgentDefinition, HarnessUpdateAssessment } from "@wollipog/protocol";
import { launchTargetStillMatches } from "./resolve.js";

export const STALE_INSTALLATION_REASON =
  "The discovered harness executable changed. Rediscover this Machine before using this installation.";

export function nativeInstallationChanged(agent: AgentDefinition): boolean {
  const identity = agent.installation?.targetIdentity;
  if (!identity || agent.context?.kind === "wsl") return false;
  return !launchTargetStillMatches(
    { command: agent.command, args: agent.args ?? [] },
    { kind: "native" }, identity,
  );
}

/** Include the saved identity so a second replacement cannot hide behind the same agent id. */
export function staleNativeInstallationKey(agents: readonly AgentDefinition[]): string {
  return JSON.stringify(agents.filter(nativeInstallationChanged)
    .map((agent) => [agent.id, agent.installation!.targetIdentity!] as const)
    .sort((a, b) => a[0].localeCompare(b[0])));
}

/** An old version or release assessment cannot describe a replacement executable. */
export function invalidateStaleNativeInstallation(agent: AgentDefinition, checkedAt = Date.now()): AgentDefinition {
  if (!nativeInstallationChanged(agent)) return agent;
  const update: HarnessUpdateAssessment = {
    status: "version_unknown",
    checkedAt,
    channel: "unknown",
    evidenceSource: "Executable identity check",
    managedExternally: true,
    guidance: "The discovered executable changed, so its previous version and release check are stale. Rediscover this Machine before checking releases or following update instructions.",
  };
  return {
    ...agent,
    available: false,
    unavailableReason: STALE_INSTALLATION_REASON,
    version: undefined,
    update,
    authStatus: "unknown",
    codexAppServer: undefined,
    claudeCode: undefined,
    nativeTuiAccounting: undefined,
  };
}
