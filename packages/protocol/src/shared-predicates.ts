import type { AgentDefinition, AgentDriverKind, ExecutionTargetRef, RunnerProviderAccountDefault } from "./index.js";

/** Return an absolute browser-safe external link, or null for untrusted schemes/invalid URLs. */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Map a session driver to its managed account provider, when supported. */
export function providerForDriver(driver: AgentDriverKind): "claude" | "codex" | null {
  if (driver === "claude-code") return "claude";
  if (driver === "codex" || driver === "codex-app-server") return "codex";
  return null;
}

/** Whether a target can see skills and commands in the Machine's host home. */
export function targetHasHostHome(adapter: ExecutionTargetRef["adapter"] | undefined): boolean {
  return adapter !== "container" && adapter !== "cloud";
}

/** Automatic launches inspect their actual effective default, not aggregate availability.
 * Callers that resolved a Machine default or recorded binding pass that account. */
export function agentAvailableForImplicitLaunch(
  agent: Pick<AgentDefinition, "available" | "providerAccountReadiness">,
  accountId?: string,
): boolean {
  if (agent.available !== true) return false;
  const readiness = agent.providerAccountReadiness;
  if (readiness === undefined) return true;
  if (!readiness || !Array.isArray(readiness.readyAccountIds)) return false;
  return accountId !== undefined
    ? readiness.readyAccountIds.includes(accountId)
    : readiness.defaultAuthStatus === "authenticated" && typeof readiness.defaultAccountId === "string" &&
      readiness.readyAccountIds.includes(readiness.defaultAccountId);
}

/** Machine choices take precedence over the runner's configured default. WSL keeps its
 * context-local default, matching session creation. */
export function agentAvailableForRunnerDefault(
  agent: Pick<AgentDefinition, "available" | "providerAccountReadiness" | "driver" | "context">,
  defaults?: readonly RunnerProviderAccountDefault[],
): boolean {
  const provider = providerForDriver(agent.driver ?? "acp");
  const accountId = (agent.context?.kind ?? "native") === "native" && provider
    ? defaults?.find((choice) => choice.provider === provider)?.accountId ?? undefined : undefined;
  return agentAvailableForImplicitLaunch(agent, accountId);
}

/** Older peers cannot distinguish aggregate availability from implicit readiness. */
export function projectProviderAccountReadinessForPeer(agent: AgentDefinition, supported: boolean): AgentDefinition {
  if (supported || !agent.providerAccountReadiness) return agent;
  const authStatus = agent.providerAccountReadiness.defaultAuthStatus;
  return { ...agent, providerAccountReadiness: undefined,
    available: agentAvailableForImplicitLaunch(agent), authStatus,
    unavailableReason: agentAvailableForImplicitLaunch(agent) ? agent.unavailableReason
      : "The default provider account is not ready. Review its sign-in and ownership details.",
    ...(agent.claudeCode ? { claudeCode: { ...agent.claudeCode,
      auth: { ...agent.claudeCode.auth, status: authStatus } } } : {}),
  };
}
