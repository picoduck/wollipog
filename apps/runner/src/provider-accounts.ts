import { providerForDriver } from "@wollipog/protocol";
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

export { providerForDriver };

export interface BoundProviderAccount {
  id: string;
  label: string;
  provider: "claude" | "codex";
  credentialHome: string;
  /** The configured account's provider profile identity (#3239), when it has been adopted. */
  profileId?: string;
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
    // The recorded binding is authoritative, including its profile id (#3239): a binding made
    // before the account was adopted keeps its homes and gains no profile id; the account's
    // current profile is never read here.
    return {
      id: prior.providerAccountId,
      label: prior.providerAccountLabel ?? spec.providerAccountLabel ?? prior.providerAccountId,
      provider: prior.providerAccountProvider,
      credentialHome: prior.providerCredentialHome,
      ...(prior.providerProfileId !== undefined ? { profileId: prior.providerProfileId } : {}),
    };
  }
  // A session created before provider accounts were configured belongs to the legacy provider
  // home. Do not silently move its transcript and credentials when that session restarts.
  if (prior) return undefined;
  return resolveAccount?.(spec);
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
    // Retired configured entries can precede a working installation after discovery. Prefer
    // positive availability within native execution without changing explicit/context choices.
    compatible.find((candidate) => (candidate.context?.kind ?? "native") === "native" && candidate.available === true) ??
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

export function skillReconciliationProviderAccountPlan(
  agents: AgentDefinition[],
  accounts: RunnerProviderAccount[],
  exposeAccountScope: boolean,
  /** Provider profiles (#3239): an account whose HOME this control plane may not use is skipped,
   * so one refused HOME does not fail the whole pass. Its provider still has no base scope. */
  usable: (account: RunnerProviderAccount) => boolean = () => true,
): {
  baseAgents: AgentDefinition[];
  accountScopes: Array<{ account: RunnerProviderAccount; providerAccountId?: string }>;
} {
  return {
    baseAgents: agentsWithoutConfiguredProviderAccounts(agents, accounts),
    accountScopes: accounts.filter((account) => usable(account)).map((account) => ({
      account,
      ...(exposeAccountScope ? { providerAccountId: account.id } : {}),
    })),
  };
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
  platform: NodeJS.Platform = process.platform,
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
  // its configured default), but must not inherit an account implicitly because a POSIX path does
  // not identify its owning distribution. Native implicit selection skips any WSL-local account.
  const selectedId = requestedId ?? agent?.defaultProviderAccountId;
  const selected = selectedId
    ? matching.find((candidate) => candidate.id === selectedId)
    : agent && (agent.context?.kind ?? "native") === "native"
      ? matching.find((candidate) => providerAccountAgentContextCompatible(candidate, agent, platform))
      : undefined;
  if (selectedId && !selected) {
    throw new Error(`provider account '${selectedId}' is not configured for ${provider}`);
  }
  if (!selected) {
    if (agent && (agent.context?.kind ?? "native") === "native" && matching[0]) {
      throw providerAccountContextMismatch(matching[0], agent);
    }
    return undefined;
  }
  if (agent && !providerAccountAgentContextCompatible(selected, agent, platform)) {
    throw providerAccountContextMismatch(selected, agent);
  }
  return {
    id: selected.id,
    label: selected.label,
    provider: selected.provider,
    credentialHome: selected.directory,
    ...(selected.profileId !== undefined ? { profileId: selected.profileId } : {}),
  };
}

/** Discovery may inspect only accounts granted here. A configured but inaccessible account is
 * not permission to fall back to the OS-user HOME or silently choose a different default. */
export function selectProviderAccountForDiscovery(
  accounts: RunnerProviderAccount[],
  agent: Pick<AgentDefinition, "id" | "driver" | "context" | "defaultProviderAccountId">,
  usable: (account: RunnerProviderAccount) => boolean,
  platform: NodeJS.Platform = process.platform,
): BoundProviderAccount | undefined {
  const selected = selectProviderAccount(accounts, agent, agent.driver ?? "acp", undefined, platform);
  const configured = selected ? accounts.find((account) => account.id === selected.id) : undefined;
  if ((configured && !usable(configured)) || (agent.defaultProviderAccountId && !configured)) {
    throw new Error("The selected discovery account is not granted to this control plane.");
  }
  return selected;
}

/** Account authentication is independent of the currently selected account's readiness. A
 * compatible installed CLI may probe another granted HOME even when its default is signed out. */
export function providerAccountProbeAvailable(agent: AgentDefinition): boolean {
  if (agent.driver === "codex-app-server" && agent.codexAppServer) return agent.codexAppServer.status === "supported";
  if (agent.driver === "claude-code" && agent.claudeCode) return agent.claudeCode.status === "ready" || agent.claudeCode.status === "unauthenticated";
  return agent.available === true && agent.driver !== "codex";
}

export async function probeProviderAccountsForDiscovery(input: {
  accounts: RunnerProviderAccount[];
  agents: AgentDefinition[];
  usable(account: RunnerProviderAccount): boolean;
  environment(agent: AgentDefinition): Record<string, string>;
  probe(agent: AgentDefinition, env: Record<string, string>): Promise<ProviderAccountDefinition["authStatus"]>;
  failed?(account: RunnerProviderAccount): void;
}): Promise<Map<string, ProviderAccountDefinition["authStatus"]>> {
  const statuses = new Map<string, ProviderAccountDefinition["authStatus"]>();
  const installed = input.agents.filter(providerAccountProbeAvailable);
  await Promise.all(input.accounts.map(async (account) => {
    if (!input.usable(account)) { statuses.set(account.id, "unknown"); return; }
    const agent = agentForProviderAccount(installed, account);
    if (!agent) { statuses.set(account.id, "unknown"); return; }
    try {
      const env = { ...input.environment(agent), ...providerAccountEnvironment({ provider: account.provider, credentialHome: account.directory }) };
      statuses.set(account.id, mergeProviderAccountAuthStatus(account, await input.probe(agent, env)));
    } catch {
      statuses.set(account.id, mergeProviderAccountAuthStatus(account, "unknown"));
      input.failed?.(account);
    }
  }));
  return statuses;
}

/** With configured accounts, harness selection answers whether any granted compatible account
 * is ready. Per-account observations remain authoritative and no saved default/binding changes. */
export function projectProviderAccountDiscoveryReadiness(
  agents: AgentDefinition[], accounts: RunnerProviderAccount[],
  statuses: ReadonlyMap<string, ProviderAccountDefinition["authStatus"]>,
  usable: (account: RunnerProviderAccount) => boolean,
  platform: NodeJS.Platform = process.platform,
): AgentDefinition[] {
  return agents.map((agent) => {
    // WSL never implicitly inherits a host account, even if its path happens to be POSIX.
    // Without an explicit default it retains the independently discovered in-distro HOME.
    if (agent.context?.kind === "wsl" && !agent.defaultProviderAccountId) return agent;
    // Configured keys/cloud/gateway auth already won credential precedence before this
    // projection. Account inventory must not undo that assertion or discard its billing data.
    const provider = providerForDriver(agent.driver ?? "acp");
    const claudeAuth = agent.claudeCode?.auth;
    const configuredAuth = provider === "codex" ? agent.codexBillingSource === "api" || agent.env.OPENAI_API_KEY
      : provider === "claude" && (agent.env.ANTHROPIC_API_KEY || agent.env.ANTHROPIC_AUTH_TOKEN || agent.env.CLAUDE_CODE_OAUTH_TOKEN ||
        (claudeAuth?.status === "authenticated" && (claudeAuth.method === "oauth_token" ||
          ["api", "gateway", "bedrock", "vertex"].includes(claudeAuth.billingSource))));
    const configured = provider ? accounts.filter((account) => account.provider === provider) : [];
    if (!configured.length || !providerAccountProbeAvailable(agent) || agent.harnessSelectionBlocked) return agent;
    const eligible = configured.filter((account) => usable(account) && providerAccountAgentContextCompatible(account, agent, platform));
    let selected: BoundProviderAccount | undefined;
    try { selected = selectProviderAccount(accounts, agent, agent.driver ?? "acp", undefined, platform); }
    catch { /* Invalid or incompatible defaults stay unknown; never choose another implicitly. */ }
    const readyAccountIds = eligible.filter((account) => configuredAuth || statuses.get(account.id) === "authenticated")
      .map((account) => account.id);
    const providerAccountReadiness: NonNullable<AgentDefinition["providerAccountReadiness"]> = {
      ...(selected ? { defaultAccountId: selected.id } : {}),
      defaultAuthStatus: selected && eligible.some((account) => account.id === selected.id)
        ? configuredAuth ? "authenticated" : statuses.get(selected.id) ?? "unknown" : "unknown",
      readyAccountIds,
    };
    // Keep configured authentication and billing precedence, while representing grants and
    // execution-context compatibility separately for automatic consumers.
    if (configuredAuth) return { ...agent, providerAccountReadiness };
    const observations = eligible.map((account) => statuses.get(account.id) ?? "unknown");
    const authStatus = observations.includes("authenticated") ? "authenticated" as const
      : observations.length && observations.every((status) => status === "unauthenticated") ? "unauthenticated" as const : "unknown" as const;
    return { ...agent, providerAccountReadiness, available: authStatus === "authenticated", authStatus,
      unavailableReason: authStatus === "authenticated" ? undefined : authStatus === "unauthenticated"
        ? "Sign in to a provider account before starting a session."
        : "Provider accounts could not be inspected. Review their setup and ownership details.",
      ...(agent.claudeCode ? { claudeCode: { ...agent.claudeCode,
        status: authStatus === "unauthenticated" ? "unauthenticated" as const : "ready" as const,
        auth: { status: authStatus, billingSource: "unknown" as const },
        failure: authStatus === "unauthenticated" ? { code: "unauthenticated" as const,
          message: "Sign in to a provider account before starting a session." } : undefined } } : {}),
    };
  });
}

function providerAccountContextMismatch(
  account: Pick<RunnerProviderAccount, "id">,
  agent: Pick<AgentDefinition, "context">,
): Error {
  const context = agent.context?.kind === "wsl" ? "WSL" : "native";
  return new Error(`provider account '${account.id}' is incompatible with the selected ${context} execution context`);
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
