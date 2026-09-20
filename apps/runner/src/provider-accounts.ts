import { existsSync } from "node:fs";
import { join } from "node:path";
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
  if (prior?.providerAccountId && prior.providerCredentialHome && prior.providerAccountProvider) {
    return {
      id: prior.providerAccountId,
      label: prior.providerAccountLabel ?? spec.providerAccountLabel ?? prior.providerAccountId,
      provider: prior.providerAccountProvider,
      credentialHome: prior.providerCredentialHome,
    };
  }
  return resolveAccount?.(spec);
}

export function providerForDriver(driver: AgentDriverKind): "claude" | "codex" | null {
  if (driver === "claude-code") return "claude";
  if (driver === "codex" || driver === "codex-app-server") return "codex";
  return null;
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
  agent: Pick<RunnerConfigAgent, "id" | "driver" | "defaultProviderAccountId"> | undefined,
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
  const selectedId = requestedId ?? agent?.defaultProviderAccountId ?? matching[0]?.id;
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
export function providerAccountDefinition(account: RunnerProviderAccount): ProviderAccountDefinition {
  const marker = account.provider === "claude" ? ".credentials.json" : "auth.json";
  return {
    id: account.id,
    label: account.label,
    provider: account.provider,
    authStatus: existsSync(join(account.directory, marker)) ? "authenticated" : "unauthenticated",
  };
}

export function agentWithDefaultProviderAccount(
  agent: AgentDefinition,
  configured: RunnerConfigAgent | undefined,
): AgentDefinition {
  return configured?.defaultProviderAccountId
    ? { ...agent, defaultProviderAccountId: configured.defaultProviderAccountId }
    : agent;
}
