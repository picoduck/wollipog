import { existsSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import type {
  AgentDefinition,
  AgentDriverKind,
  ProviderAccountDefinition,
  SessionLaunchSpec,
} from "@wollipog/protocol";
import type { RunnerConfigAgent, RunnerProviderAccount } from "./config.js";
import type { SessionMeta } from "./session-store.js";

export interface BoundProviderAccount {
  id: string;
  label: string;
  provider: "claude" | "codex";
  credentialHome: string;
}

export function bindSessionProviderAccount(
  prior: SessionMeta | null | undefined,
  spec: SessionLaunchSpec,
  resolveAccount?: (spec: SessionLaunchSpec) => BoundProviderAccount | undefined,
): BoundProviderAccount | undefined {
  // Runner-local credential directories are meaningful only for host execution. Container and
  // cloud targets authenticate inside their own boundary, so carrying a prior or requested
  // account would falsely label a credential scope that the provider process never uses.
  if (spec.executionTarget && spec.executionTarget.adapter !== "host") return undefined;
  if (prior?.providerAccountId && prior.providerCredentialHome && prior.providerAccountProvider) {
    return {
      id: prior.providerAccountId,
      label: prior.providerAccountLabel ?? spec.providerAccountLabel ?? prior.providerAccountId,
      provider: prior.providerAccountProvider,
      credentialHome: prior.providerCredentialHome,
    };
  }
  // A session created before provider accounts were configured belongs to the legacy provider
  // home. Do not silently move its transcript and credentials when that session restarts.
  if (prior) return undefined;
  return resolveAccount?.(spec);
}

export function providerForDriver(driver: AgentDriverKind): "claude" | "codex" | null {
  if (driver === "claude-code") return "claude";
  if (driver === "codex" || driver === "codex-app-server") return "codex";
  return null;
}

/** Whether one background provider process can address the configured credential home without
 * guessing a cross-context mapping. On Windows a POSIX root belongs to WSL; a native process uses
 * drive/UNC syntax. Other runner hosts have no WSL execution context and accept POSIX roots only. */
export function providerAccountAgentContextCompatible(
  account: Pick<RunnerProviderAccount, "directory">,
  agent: Pick<AgentDefinition, "context">,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const context = agent.context?.kind ?? "native";
  if (platform === "win32") {
    return context === "wsl"
      ? posix.isAbsolute(account.directory)
      : win32.isAbsolute(account.directory) && !posix.isAbsolute(account.directory);
  }
  return context === "native" && posix.isAbsolute(account.directory);
}

/** Background account work needs one provider CLI whose execution context can address the
 * credential home. Prefer an explicit compatible default, then native, then a sole compatible
 * target context. Multiple WSL contexts require an explicit default because a POSIX path alone
 * does not identify which distribution owns it. Accounts without a directory retain the legacy
 * selection contract for internal callers that only hold the secret-free wire definition. */
export function agentForProviderAccount(
  agents: AgentDefinition[],
  account: Pick<ProviderAccountDefinition, "id" | "provider"> & Partial<Pick<RunnerProviderAccount, "directory">>,
  supportedDrivers?: AgentDriverKind[],
  platform: NodeJS.Platform = process.platform,
): AgentDefinition | undefined {
  const providerAgents = agents.filter((candidate) =>
    providerForDriver(candidate.driver ?? "acp") === account.provider &&
    (!supportedDrivers || supportedDrivers.includes(candidate.driver ?? "acp")));
  const preferred = (compatible: AgentDefinition[], ambiguousTargetContexts: boolean) =>
    compatible.find((candidate) => candidate.defaultProviderAccountId === account.id) ??
    compatible.find((candidate) => (candidate.context?.kind ?? "native") === "native") ??
    (!ambiguousTargetContexts || compatible.length === 1 ? compatible[0] : undefined);
  if (account.directory === undefined) return preferred(providerAgents, false);
  return preferred(providerAgents.filter((candidate) => providerAccountAgentContextCompatible(
    { directory: account.directory! }, candidate, platform)), true);
}

export function agentsWithoutConfiguredProviderAccounts(
  agents: AgentDefinition[],
  accounts: Array<Pick<ProviderAccountDefinition, "provider">>,
): AgentDefinition[] {
  const configuredProviders = new Set(accounts.map((account) => account.provider));
  return agents.filter((agent) => {
    const provider = providerForDriver(agent.driver ?? "acp");
    return !provider || !configuredProviders.has(provider);
  });
}

export function providerAccountEnvironment(
  account: Pick<BoundProviderAccount, "provider" | "credentialHome">,
): Record<string, string> {
  return account.provider === "claude"
    ? { CLAUDE_CONFIG_DIR: account.credentialHome }
    : { CODEX_HOME: account.credentialHome };
}

export function selectProviderAccount(
  accounts: RunnerProviderAccount[],
  agent: Pick<AgentDefinition, "id" | "driver" | "context" | "defaultProviderAccountId"> | undefined,
  driver: AgentDriverKind,
  requestedId?: string,
): BoundProviderAccount | undefined {
  const provider = providerForDriver(driver);
  if (!provider) {
    if (requestedId) throw new Error(`agent '${agent?.id ?? "unknown"}' does not support provider accounts`);
    return undefined;
  }
  const matching = accounts.filter((candidate) => candidate.provider === provider);
  if (matching.length === 0) {
    if (requestedId) throw new Error(`provider account '${requestedId}' is not configured`);
    return undefined;
  }
  // Account directories use runner-host path syntax. A WSL agent may opt in explicitly (or via
  // its configured default), but must not inherit the first native account implicitly.
  const selectedId = requestedId ?? agent?.defaultProviderAccountId ??
    (agent && (agent.context?.kind ?? "native") === "native" ? matching[0]?.id : undefined);
  if (!selectedId) return undefined;
  const selected = matching.find((candidate) => candidate.id === selectedId);
  if (!selected) throw new Error(`provider account '${selectedId}' is not configured for ${provider}`);
  return {
    id: selected.id,
    label: selected.label,
    provider: selected.provider,
    credentialHome: selected.directory,
  };
}

/** Content-free, account-scoped login observation. Live launch/auth recovery performs the
 * authoritative provider check; this inventory probe deliberately reads only the provider's
 * standard credential marker inside the configured home. */
export function providerAccountDefinition(
  account: RunnerProviderAccount,
  platform: NodeJS.Platform = process.platform,
): ProviderAccountDefinition {
  const marker = account.provider === "claude" ? ".credentials.json" : "auth.json";
  return {
    id: account.id,
    label: account.label,
    provider: account.provider,
    // A POSIX account path on Windows belongs to WSL and is not host-inspectable. The selected
    // in-distro authentication probe supplies the authoritative state when one is available.
    authStatus: platform === "win32" && posix.isAbsolute(account.directory)
      ? "unknown"
      : existsSync(join(account.directory, marker)) ? "authenticated" : "unauthenticated",
  };
}

export function mergeProviderAccountAuthStatus(
  account: RunnerProviderAccount,
  observed: ProviderAccountDefinition["authStatus"],
): ProviderAccountDefinition["authStatus"] {
  const markerStatus = providerAccountDefinition(account).authStatus;
  return observed === "unknown" && markerStatus === "unauthenticated" ? markerStatus : observed;
}

export function agentWithDefaultProviderAccount(
  agent: AgentDefinition,
  configured: RunnerConfigAgent | undefined,
): AgentDefinition {
  return configured?.defaultProviderAccountId
    ? { ...agent, defaultProviderAccountId: configured.defaultProviderAccountId }
    : agent;
}
