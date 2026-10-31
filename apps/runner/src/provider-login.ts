import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentContextKey, type AgentContext, type AgentDefinition, type ProviderCredentialImportCode, type ProviderCredentialImportSource, type ProviderLoginView } from "@wollipog/protocol";
import type { CodexCredentialLayout } from "./provider-credential-import.js";
import { LEASE_WORKER_ERRORS, ProviderHomeLeaseError } from "./provider-home-lease-worker-protocol.js";
import type { RunnerProviderAccount } from "./config.js";
import { captureProviderAccountsConfigPreimage, writeProviderAccountsConfig } from "./config.js";
import { accountConfigPublicationErrorMessage, accountConfigPublicationMayHaveOccurred } from "./provider-account-config-publication.js";
import { codexLauncherBootstrap } from "./codex-plugins.js";
import { runContextCommand } from "./context-command.js";
import { supportsStructuredCodexDeviceLogin } from "./discovery/codex-app-server.js";
import { launchTargetStillMatches } from "./discovery/resolve.js";
import { JsonRpcPeer, type RpcError } from "./jsonrpc.js";
import { inheritProviderPlugins } from "./provider-plugins.js";
import {
  agentForProviderAccount,
  providerAccountAgentContextCompatible,
  providerAccountEnvironment,
} from "./provider-accounts.js";
import { killTreeAndWait, spawnAgent, trackPendingKill, type AgentProcess } from "./spawn.js";
import type { LeaseCancellation } from "./provider-home-lease-async.js";
import { isProviderProfileGrantId, readProviderProfileMarker } from "./provider-profile.js";
import { createManagedProviderProfileHome, isManagedProviderProfileHome, managedProviderProfileIdFor } from "./provider-profile-home.js";

const LOGIN_OUTPUT_LIMIT = 64 * 1024;
const LOGIN_CODE_LIMIT = 4_096;
const VERIFICATION_URL_LIMIT = 2_048;
const DEVICE_CODE_LIMIT = 128;
const RECENT_LOGIN_LIMIT = 32;
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CEREMONY_TIMEOUT_MS = 15_000;
const URL_PATTERN = /https:\/\/[^\s<>"'\u0000-\u001f\u007f]+/giu;
const LABELED_DEVICE_CODE_PATTERN = /one-time code:?\s*([A-Z0-9-]+)[ \t]*(?=\r?\n)/giu;
const HYPHENATED_DEVICE_CODE_LINE_PATTERN = /^[ \t]*([A-Z0-9]+(?:-[A-Z0-9]+)+)[ \t]*(?=\r?\n)/gmu;
const ANSI_ESCAPE_PATTERN = /\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])|\u009b[0-?]*[ -/]*[@-~]/gu;
const CODEX_LOGIN_CLIENT_INFO = { name: "wollipog-provider-login", version: "1.0.0" } as const;

export function agentsMatchingHarnessInstallationSelections(
  agents: AgentDefinition[],
  selections: Array<{ context: AgentContext; installationId: string }>,
): AgentDefinition[] {
  return agents.filter((candidate) => {
    const selected = selections.find((choice) =>
      agentContextKey(choice.context) === agentContextKey(candidate.context));
    return !selected || candidate.installation?.id === selected.installationId;
  });
}
interface ProviderLoginDescriptor {
  loginTail: readonly string[];
  statusTail: readonly string[];
  scrubEnv: readonly string[];
  expectsPasteCode: boolean;
  progress(output: string): Partial<ProviderLoginView> | null;
  authenticated(stdout: string): boolean;
}

const PROVIDER_LOGIN_DESCRIPTORS: Record<"claude" | "codex", ProviderLoginDescriptor> = {
  claude: {
    loginTail: ["auth", "login"],
    statusTail: ["auth", "status"],
    scrubEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
    expectsPasteCode: true,
    progress(output) {
      const verificationUrl = (output.match(URL_PATTERN) ?? [])
        .map((candidate) => safeVerificationUrl(candidate))
        .find((candidate): candidate is string => !!candidate);
      return verificationUrl
        ? { status: "awaiting_code", expectsCode: true, verificationUrl }
        : null;
    },
    authenticated(stdout) {
      const value = JSON.parse(stdout) as { loggedIn?: unknown };
      return value.loggedIn === true;
    },
  },
  codex: {
    loginTail: ["login", "--device-auth"],
    statusTail: ["login", "status"],
    scrubEnv: ["OPENAI_API_KEY"],
    expectsPasteCode: false,
    progress(output) {
      const { verificationUrl, userCode } = parseCodexDeviceLoginOutput(output);
      return verificationUrl && userCode
        ? {
            status: "waiting_for_provider",
            expectsCode: false,
            verificationUrl,
            userCode,
          }
        : null;
    },
    authenticated() { return true; },
  },
};

export interface ResolvedProviderLogin {
  accountId: string;
  label: string;
  provider: "claude" | "codex";
  directory: string;
  command: string;
  args: string[];
  context: AgentContext;
  env: Record<string, string>;
  persistAccount: boolean;
  sessionId?: string;
  /** Discovery-verified support for the structured Codex App Server contract. */
  structuredCodex?: boolean;
  /** #3239: the managed provider profile this new account's HOME was created as. */
  profile?: { id: string; grantId: string };
}

/** #3239: how Add Account creates managed provider profile HOMEs. */
export interface ProviderLoginProfileOptions {
  /** `~/.agent-manager/profiles`: new managed HOMEs are created here. Their location and profile
   * identity do not prove exclusive retirement authority, so cleanup retains them. */
  root: string;
  /** Write the new HOME's first marker, identity `profileId` with this control plane's grant, under
   * the HOME's lease, and make the grant usable for this sign-in. */
  create(home: string, provider: "claude" | "codex", profileId: string, grantId: string): Promise<void>;
  /** The sign-in settled. Unknown recording stops local grant use while retaining its marker;
   * definitely-unrecorded settlement also drops the marker's grant from a retained HOME. */
  settle(input: { home: string; provider: "claude" | "codex"; profileId: string; grantId: string; recorded: boolean | "unknown"; homeRemoved: boolean }): Promise<void>;
}

/** #3719: an import's source, resolved on the runner: the HOME whose lease it takes, where Codex's
 * credential directory sits under it, and the profile id its account recorded. */
export interface ProviderCredentialImportSourceHome {
  home: string;
  layout: CodexCredentialLayout;
  expectedProfileId?: string;
}

/** #3719: how Add Account imports an existing Codex API-key sign-in. */
export interface ProviderCredentialImportOptions {
  /** The runner user's own Codex HOME, or undefined when it cannot be named unambiguously. */
  defaultCodexHome(): ProviderCredentialImportSourceHome | undefined;
  /** Copy the source's API key into the new managed profile HOME `<root>/<profileId>` with this
   * control plane's grant, in one lease-worker operation, and make the grant usable. */
  copyCodex(input: { source: ProviderCredentialImportSourceHome; root: string; profileId: string; grantId: string }): Promise<void>;
}

interface ActiveLogin {
  view: ProviderLoginView;
  resolved: ResolvedProviderLogin;
  child: AgentProcess;
  output: string;
  timer: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  timedOut: boolean;
  settled: boolean;
  codeSubmitted: boolean;
  stdinFailed: boolean;
  ceremonyTimer?: ReturnType<typeof setTimeout>;
  peer?: JsonRpcPeer;
  loginId?: string;
  structuredSucceeded: boolean;
  structuredFailure?: string;
  structuredAccountUpdated: boolean;
  reap?: Promise<boolean>;
  resolve: (status: "completed" | "cancelled" | "failed") => void;
  completion: Promise<"completed" | "cancelled" | "failed">;
}

/** How `removeAccount` decides a runner-created HOME's fate when provider profiles apply (#3239). */
export interface ProviderAccountRemovalOptions {
  /** Keep the HOME without attempting deletion (an early decision that can only keep it). */
  retainCredentialHome?: boolean;
  /** Drop this control plane's grants under the HOME's lease. The legacy boolean is not deletion
   * authority: neither a released lease nor an unshared marker proves retirement is safe. */
  retireCredentialHome?: (account: RunnerProviderAccount) => Promise<boolean>;
  /** Legacy retention hint. Cleanup now retains every HOME regardless of this hint. */
  retainCredentialHomeIf?: (account: RunnerProviderAccount) => boolean;
}

export interface ProviderLoginSupervisorOptions {
  dataDir: string;
  configPath: string;
  accounts: RunnerProviderAccount[];
  agents: () => AgentDefinition[];
  resolveEnv: (agent: AgentDefinition) => Record<string, string>;
  acquireLease: (directory: string, provider: "claude" | "codex", cancellation?: LeaseCancellation) => boolean | Promise<boolean>;
  releaseLease: (directory: string) => boolean | Promise<boolean>;
  onUpdate: (logins: ProviderLoginView[]) => void;
  onAccountAdded: (account: RunnerProviderAccount) => void | Promise<void>;
  onAccountRemoved?: (account: RunnerProviderAccount) => void | Promise<void>;
  /** A reason the runner cannot forget this account, such as an agent default that names it. */
  removalBlocker?: (account: RunnerProviderAccount) => string | undefined;
  /** Whether any session on this Machine is bound to the account's credential home. */
  credentialHomeInUse?: (account: RunnerProviderAccount) => boolean;
  /** Settle a removed HOME's profile grants outside any skill transaction. Keep this ordering
   * even while physical cleanup is disabled pending an ownership-preserving retirement protocol. */
  serializeHomeRetirement?: <T>(work: () => Promise<T>) => Promise<T>;
  /** #3239: managed provider profiles for accounts created with a control-plane grant. Without it a
   * grant is ignored and every new account HOME is created under `dataDir` as before. */
  profiles?: ProviderLoginProfileOptions;
  /** #3719: importing an existing sign-in into a managed profile. Only a supported host sets it. */
  imports?: ProviderCredentialImportOptions;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  ceremonyTimeoutMs?: number;
  spawn?: typeof spawnAgent;
  kill?: typeof killTreeAndWait;
  writeAccounts?: typeof writeProviderAccountsConfig;
  probe?: (login: ResolvedProviderLogin) => Promise<boolean>;
  identify?: (login: ResolvedProviderLogin) => Promise<string | undefined>;
  now?: () => number;
}

function providerBootstrap(agent: Pick<AgentDefinition, "command" | "args">, provider: "claude" | "codex"): string[] {
  if (provider === "codex") {
    // A selected direct executable (including discovered codex.js targets) needs no prefix.
    return agent.args.length === 0 ? [] : codexLauncherBootstrap(agent.command, agent.args);
  }
  return agent.args.length && /(?:^|[\\/])node(?:\.exe)?$/iu.test(agent.command)
    ? [agent.args[0]!]
    : [];
}

function loginArgs(login: ResolvedProviderLogin): string[] {
  return [...login.args, ...PROVIDER_LOGIN_DESCRIPTORS[login.provider].loginTail];
}

function appServerArgs(login: ResolvedProviderLogin): string[] {
  return [...login.args, "app-server"];
}

function statusArgs(login: ResolvedProviderLogin): string[] {
  return [...login.args, ...PROVIDER_LOGIN_DESCRIPTORS[login.provider].statusTail];
}

function safeVerificationUrl(raw: string, trimPresentationPunctuation = true): string | undefined {
  const trimmed = trimPresentationPunctuation ? raw.replace(/[),.;]+$/u, "") : raw;
  if (trimmed.length > VERIFICATION_URL_LIMIT || /[\u0000-\u001f\u007f]/u.test(trimmed)) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return undefined;
    const serialized = parsed.toString();
    return serialized.length <= VERIFICATION_URL_LIMIT ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function stripAnsi(value: string): string {
  const stripped = value.replace(ANSI_ESCAPE_PATTERN, "");
  // An unfinished or malformed OSC must not expose its payload as ceremony text.
  const incompleteOsc = stripped.indexOf("\u001b]");
  return incompleteOsc < 0 ? stripped : stripped.slice(0, incompleteOsc);
}

function safeDeviceCode(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > DEVICE_CODE_LIMIT) return undefined;
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(raw) ? raw : undefined;
}

function safeFallbackDeviceCode(raw: string): string | undefined {
  return raw.length >= 4 && raw.length <= DEVICE_CODE_LIMIT &&
      /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/u.test(raw)
    ? raw
    : undefined;
}

function safeLoginId(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 256 &&
      !/[\u0000-\u001f\u007f]/u.test(raw)
    ? raw
    : undefined;
}

/** Parse only the bounded, presentation-free ceremony values used by the CLI compatibility path. */
export function parseCodexDeviceLoginOutput(output: string): { verificationUrl?: string; userCode?: string } {
  const normalized = stripAnsi(output);
  const verificationUrl = (normalized.match(URL_PATTERN) ?? [])
    .map((candidate) => safeVerificationUrl(candidate))
    .find((candidate): candidate is string => !!candidate);
  const labeledCode = [...normalized.matchAll(LABELED_DEVICE_CODE_PATTERN)]
    .map((match) => safeFallbackDeviceCode(match[1] ?? ""))
    .find((candidate): candidate is string => !!candidate);
  const userCode = labeledCode ?? [...normalized.matchAll(HYPHENATED_DEVICE_CODE_LINE_PATTERN)]
    .map((match) => safeFallbackDeviceCode(match[1] ?? ""))
    .find((candidate): candidate is string => !!candidate);
  return {
    ...(verificationUrl ? { verificationUrl } : {}),
    ...(userCode ? { userCode } : {}),
  };
}

function codexFailureMessage(error: unknown): string {
  const text = typeof error === "string"
    ? error
    : error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : "";
  if (/expir(?:e|ed|ation)/iu.test(text)) {
    return "The provider device code expired. Start sign-in again.";
  }
  if (/access[_ -]?denied|denied|reject(?:ed|ion)|declined/iu.test(text)) {
    return "The provider rejected the sign-in request. Start sign-in again if this was unexpected.";
  }
  return "The provider could not complete device-code authentication. Start sign-in again.";
}

function isMethodNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as RpcError).code === -32601;
}

function accountSlug(label: string): string {
  return label.toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48) || "account";
}

function providerName(provider: "claude" | "codex"): string {
  return provider === "claude" ? "Claude" : "Codex";
}

function comparableLabel(label: string): string {
  return label.trim().toLocaleLowerCase();
}

/** Account identity from `claude auth status`: the email and organization together, because one
 * email can belong to a personal and a team organization that are different subscriptions. */
export function claudeStatusIdentity(stdout: string): string | undefined {
  const value = JSON.parse(stdout) as Record<string, unknown>;
  if (value?.loggedIn !== true) return undefined;
  const email = typeof value.email === "string" && value.email.trim()
    ? value.email.trim().toLocaleLowerCase()
    : null;
  const orgId = typeof value.orgId === "string" && value.orgId ? value.orgId : null;
  return email || orgId ? JSON.stringify(["claude", email, orgId]) : undefined;
}

/** Account identity from Codex's ChatGPT credential file: the user and the workspace account.
 * Only these claims are read; tokens are never retained. API-key homes have no account identity. */
export function codexCredentialIdentity(authJson: string): string | undefined {
  const value = JSON.parse(authJson) as { tokens?: { id_token?: unknown; account_id?: unknown } };
  const idToken = value?.tokens?.id_token;
  if (typeof idToken !== "string") return undefined;
  const payload = idToken.split(".")[1];
  if (!payload) return undefined;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  const auth = claims["https://api.openai.com/auth"] && typeof claims["https://api.openai.com/auth"] === "object"
    ? claims["https://api.openai.com/auth"] as Record<string, unknown>
    : {};
  const user = [auth.chatgpt_user_id, auth.user_id, claims.sub]
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  const account = [auth.chatgpt_account_id, value.tokens?.account_id]
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  return user ? JSON.stringify(["codex", user, account ?? null]) : undefined;
}

/** The sign-in could not take its HOME's lease, so it never held the HOME. */
class ProviderLoginLeaseUnavailable extends Error {
  constructor() { super("The provider credential home is unavailable or already in use."); }
}

/** The sign-in was refused before it asked for its HOME's lease (a stopped supervisor or a duplicate). */
class ProviderLoginNotStarted extends Error {}

/** #3719: an import's refusal, with its wire code and a path-free sentence. */
export class ProviderCredentialImportError extends Error {
  constructor(readonly code: ProviderCredentialImportCode, message: string) { super(message); }
}

/** The lease worker's typed refusals, as the import's wire codes; the text is the worker's fixed,
 * path-free sentence. */
function importFailure(error: unknown): ProviderCredentialImportError {
  if (!(error instanceof ProviderHomeLeaseError)) {
    return new ProviderCredentialImportError("FAILED", "The sign-in could not be copied. Sign in to create the profile instead.");
  }
  const code: ProviderCredentialImportCode =
    error.code === "import_source_missing" ? "SOURCE_MISSING" :
    error.code === "import_source_unsafe" || error.code === "profile_changed" || error.code === "profile_unverifiable" ? "SOURCE_UNSAFE" :
    error.code === "import_source_foreign" ? "SOURCE_FOREIGN" :
    error.code === "import_source_unsupported" ? "SOURCE_UNSUPPORTED" :
    error.code === "import_source_changed" ? "SOURCE_CHANGED" :
    error.code === "profile_not_granted" || error.code === "profile_unsupported_control_plane" ? "SOURCE_NOT_GRANTED" :
    error.code === "import_source_held" || error.code === "busy" || error.code === "holder_alive" || error.code === "boundary_survivor" ||
      error.code === "process_survivor" || error.code === "foreign_owner" || error.code === "foreign_host" ? "SOURCE_IN_USE" : "FAILED";
  return new ProviderCredentialImportError(code, error.message);
}

export class ProviderLoginSupervisor {
  private readonly active = new Map<string, ActiveLogin>();
  private readonly pending = new Map<string, { resolved: ResolvedProviderLogin; controller: AbortController }>();
  /** #3239: a managed Add Account creates its HOME and first marker (awaited) before startResolved
   * records its pending entry, so its label is reserved here, by account id, from the duplicate-label
   * check until that entry replaces it or the start fails. */
  private readonly reserved = new Map<string, ResolvedProviderLogin>();
  /** #3719: running imports by new account id, reserving their label and source. */
  private readonly importing = new Map<string, { persistAccount: true; provider: "codex"; label: string; sourceKey: string }>();
  private stopped = false;
  private readonly recent = new Map<string, ProviderLoginView>();
  private readonly spawn: typeof spawnAgent;
  private readonly kill: typeof killTreeAndWait;
  private readonly writeAccounts: typeof writeProviderAccountsConfig;
  private readonly now: () => number;

  constructor(private readonly options: ProviderLoginSupervisorOptions) {
    this.spawn = options.spawn ?? spawnAgent;
    this.kill = options.kill ?? killTreeAndWait;
    this.writeAccounts = options.writeAccounts ?? writeProviderAccountsConfig;
    this.now = options.now ?? Date.now;
  }

  views(): ProviderLoginView[] {
    return [...this.recent.values()]
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(-32)
      .map((view) => ({ ...view }));
  }

  async startAccount(
    input: { provider: "claude" | "codex"; label: string; profileGrantId?: string } | { accountId: string },
    installationSelections: Array<{ context: AgentContext; installationId: string }> = [],
  ): Promise<ProviderLoginView> {
    let account: RunnerProviderAccount;
    let persistAccount: boolean;
    let profile: ResolvedProviderLogin["profile"];
    if ("accountId" in input) {
      const configured = this.options.accounts.find((candidate) => candidate.id === input.accountId);
      if (!configured) throw new Error("Provider account is not configured on this Machine.");
      account = configured;
      persistAccount = false;
    } else {
      const label = this.newAccountLabel(input.provider, input.label);
      if (input.profileGrantId !== undefined && !isProviderProfileGrantId(input.profileGrantId)) {
        throw new Error("The profile grant is invalid.");
      }
      const id = this.newAccountId(label);
      // #3239: with this control plane's grant the account becomes a managed profile at the
      // SSH-account-level root; markers cannot be verified on Windows, which keeps today's path.
      const profiles = (this.options.platform ?? process.platform) !== "win32" ? this.options.profiles : undefined;
      if (profiles && input.profileGrantId) profile = { id: randomUUID(), grantId: input.profileGrantId };
      account = {
        id,
        label,
        provider: input.provider,
        directory: profile && profiles ? join(profiles.root, profile.id) : join(this.options.dataDir, "provider-accounts", id),
        ...(profile ? { profileId: profile.id } : {}),
      };
      persistAccount = true;
    }
    const eligibleAgents = agentsMatchingHarnessInstallationSelections(this.options.agents(), installationSelections);
    const agent = agentForProviderAccount(eligibleAgents, account, [
      "claude-code", "codex", "codex-app-server",
    ]);
    if (!agent) throw new Error(`No ${account.provider === "claude" ? "Claude" : "Codex"} agent is available on this Machine.`);
    if (agent.installation?.targetIdentity && !launchTargetStillMatches(
      { command: agent.command, args: agent.args ?? [] }, agent.context ?? { kind: "native" },
      agent.installation.targetIdentity,
    )) throw new Error("The selected installation changed. Rediscover this Machine before signing in.");
    const env = {
      ...this.options.resolveEnv(agent),
      ...providerAccountEnvironment({ provider: account.provider, credentialHome: account.directory }),
    };
    for (const name of PROVIDER_LOGIN_DESCRIPTORS[account.provider].scrubEnv) {
      delete env[name];
    }
    const resolved: ResolvedProviderLogin = {
      accountId: account.id,
      label: account.label,
      provider: account.provider,
      directory: account.directory,
      command: agent.command,
      args: providerBootstrap(agent, account.provider),
      context: agent.context ?? { kind: "native" },
      env,
      persistAccount,
      structuredCodex: account.provider === "codex" && agent.codexAppServer?.status === "supported" &&
        supportsStructuredCodexDeviceLogin(agent.codexAppServer.installedVersion),
      ...(profile ? { profile } : {}),
    };
    // Nothing above awaits, so the label check and pending entry of a legacy start are atomic.
    if (!resolved.profile) return (await this.startResolved(resolved)).view;
    // A managed start awaits its HOME's creation first: reserve the label before that await, so an
    // overlapping Add Account with the same provider and label is refused before it creates anything.
    this.reserved.set(resolved.accountId, resolved);
    try {
      await this.createProfileHome(resolved, resolved.profile);
      try {
        return (await this.startResolved(resolved)).view;
      } catch (error) {
        // Even a fresh HOME may have a successor or an unproved consumer. Retain its payload and
        // canonical lease evidence; failed acquisition or successful release is not retirement.
        await this.settleProfile(resolved, false);
        throw error;
      }
    } finally {
      // Already replaced by the pending entry when startResolved got that far.
      if (this.reserved.get(resolved.accountId) === resolved) this.reserved.delete(resolved.accountId);
    }
  }

  /** A new account's trimmed label, refused when it is invalid or another account, running sign-in
   * or import of the provider already uses it (trimmed, case-insensitive). */
  private newAccountLabel(provider: "claude" | "codex", input: string): string {
    const label = input.trim();
    if (!label || label.length > 100 || /[\u0000-\u001f\u007f]/u.test(label)) {
      throw new Error("Account label must contain 1 to 100 characters.");
    }
    if (this.options.accounts.length >= 32) throw new Error("This Machine already has 32 provider accounts.");
    const comparable = comparableLabel(label);
    if (this.options.accounts.some((candidate) =>
      candidate.provider === provider && comparableLabel(candidate.label) === comparable)) {
      throw new Error(`A ${providerName(provider)} account with this label is already on this Machine. ` +
        "Use Sign In on that account to refresh its login.");
    }
    // Settled operations stay active until the account is recorded, which includes the identity check.
    if ([...[...this.active.values(), ...this.pending.values()].map((operation) => operation.resolved), ...this.reserved.values(), ...this.importing.values()]
      .some((running) => running.persistAccount && running.provider === provider && comparableLabel(running.label) === comparable)) {
      throw new Error("A sign-in for an account with this label is already running.");
    }
    return label;
  }

  private newAccountId(label: string): string {
    let id: string;
    do id = `${accountSlug(label)}-${randomUUID().slice(0, 8)}`;
    while (this.options.accounts.some((candidate) => candidate.id === id) || this.importing.has(id));
    return id;
  }

  /**
   * #3719: create a managed Codex profile from an existing API-key sign-in on this Machine instead
   * of a new sign-in: the runner user's own Codex HOME or a configured Codex account. The lease
   * worker copies only the API key, into a fresh record in the new profile's HOME, in one operation
   * that refuses a source it cannot verify and leaves both HOMEs unchanged. Nothing is run against
   * the provider: no sign-in, logout or revocation. The account is recorded as Add Account records
   * one, with this control plane's grant; a copied key is the same account as its source by
   * design, so the duplicate-identity check of a sign-in does not apply.
   */
  async importAccount(input: {
    provider: "claude" | "codex"; label: string; source: ProviderCredentialImportSource; profileGrantId: string;
    /** The id the control plane chose and bound the grant to; generated here when absent. */
    accountId?: string;
  }): Promise<{ accountId: string; profileId: string }> {
    const imports = this.options.imports;
    const profiles = this.options.profiles;
    if (this.stopped) throw new ProviderCredentialImportError("FAILED", "The provider sign-in supervisor has stopped.");
    if (input.provider !== "codex") {
      throw new ProviderCredentialImportError("UNSUPPORTED", "Only a Codex API-key sign-in can be copied. Sign in to create the profile instead.");
    }
    if (!imports || !profiles || (this.options.platform ?? process.platform) === "win32") {
      throw new ProviderCredentialImportError("UNSUPPORTED", "This Machine can't copy an existing sign-in. Sign in to create the profile instead.");
    }
    if (!isProviderProfileGrantId(input.profileGrantId)) throw new ProviderCredentialImportError("FAILED", "The profile grant is invalid.");
    let source: ProviderCredentialImportSourceHome;
    if (input.source.kind === "account") {
      const accountId = input.source.accountId;
      const account = this.options.accounts.find((candidate) => candidate.id === accountId);
      if (!account) throw new ProviderCredentialImportError("SOURCE_NOT_FOUND", "The provider account is not configured on this Machine.");
      if (account.provider !== "codex") {
        throw new ProviderCredentialImportError("SOURCE_FOREIGN", LEASE_WORKER_ERRORS.import_source_foreign);
      }
      if (!providerAccountAgentContextCompatible(account, { context: { kind: "native" } }, this.options.platform)) {
        throw new ProviderCredentialImportError("UNSUPPORTED", "This account belongs to another execution context, so its sign-in can't be copied.");
      }
      if ([...this.active.values(), ...this.pending.values()].some((operation) => operation.resolved.accountId === account.id)) {
        throw new ProviderCredentialImportError("SOURCE_IN_USE", LEASE_WORKER_ERRORS.import_source_held);
      }
      source = { home: account.directory, layout: "codex_home", ...(account.profileId ? { expectedProfileId: account.profileId } : {}) };
    } else {
      if (input.source.kind !== "default_home") throw new ProviderCredentialImportError("FAILED", "The import source is invalid.");
      const resolved = imports.defaultCodexHome();
      if (!resolved) throw new ProviderCredentialImportError("SOURCE_NOT_FOUND", "This Machine has no single Codex sign-in of its own to copy.");
      source = resolved;
    }
    const sourceKey = resolve(source.home);
    if ([...this.importing.values()].some((running) => running.sourceKey === sourceKey)) {
      throw new ProviderCredentialImportError("SOURCE_IN_USE", LEASE_WORKER_ERRORS.import_source_held);
    }
    let label: string;
    try { label = this.newAccountLabel("codex", input.label); } catch (error) {
      throw new ProviderCredentialImportError("LABEL_IN_USE", error instanceof Error ? error.message : "The account label is unavailable.");
    }
    if (input.accountId !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.accountId) ||
        this.options.accounts.some((candidate) => candidate.id === input.accountId) || this.importing.has(input.accountId))) {
      throw new ProviderCredentialImportError("FAILED", "The new account's id is unavailable on this Machine.");
    }
    const accountId = input.accountId ?? this.newAccountId(label);
    const profileId = randomUUID();
    const account: RunnerProviderAccount = { id: accountId, label, provider: "codex", directory: join(profiles.root, profileId), profileId };
    // Reserved with no await before it, so overlapping imports of one source or label are refused.
    this.importing.set(accountId, { persistAccount: true, provider: "codex", label, sourceKey });
    const settle = (recorded: boolean | "unknown") => profiles.settle({ home: account.directory, provider: "codex", profileId,
      grantId: input.profileGrantId, recorded, homeRemoved: false }).catch(() => {});
    try {
      try {
        await imports.copyCodex({ source, root: profiles.root, profileId, grantId: input.profileGrantId });
      } catch (error) {
        // A refusal created nothing. Any other failure may have created the new HOME: retain it
        // and drop this grant from its marker, as a failed sign-in does.
        await settle(false);
        throw importFailure(error);
      }
      if (this.stopped) {
        await settle(false);
        throw new ProviderCredentialImportError("FAILED", "The provider sign-in supervisor has stopped.");
      }
      // The account is recorded through the fenced publication (#3506), exactly as Add Account
      // records one. Only a confirmed publication is a success.
      try {
        const preimage = captureProviderAccountsConfigPreimage(this.options.configPath, this.options.accounts);
        this.writeAccounts(this.options.configPath, [...this.options.accounts, account], preimage);
      } catch (error) {
        const copied = "The sign-in was copied, but the runner configuration could not be updated.";
        if (accountConfigPublicationMayHaveOccurred(error)) {
          // The account may already be in the configuration: stop using the grant here without
          // revoking a marker grant the published account may reference, and say the outcome is
          // unknown rather than report a success or a clean refusal.
          await settle("unknown");
          throw new ProviderCredentialImportError("PUBLICATION_UNKNOWN", accountConfigPublicationErrorMessage(error, copied));
        }
        await settle(false);
        throw new ProviderCredentialImportError("FAILED", accountConfigPublicationErrorMessage(error, copied));
      }
      this.options.accounts.push(account);
      await settle(true);
      try { await this.options.onAccountAdded(account); } catch { /* The account is recorded; its next report carries it. */ }
      return { accountId, profileId };
    } finally {
      this.importing.delete(accountId);
    }
  }

  /** Create a new managed profile HOME and its first marker before the sign-in takes its lease. */
  private async createProfileHome(resolved: ResolvedProviderLogin, profile: { id: string; grantId: string }): Promise<void> {
    const profiles = this.options.profiles!;
    // Its refusals are path-free; the grant is not recorded yet, so the refused start is enough.
    createManagedProviderProfileHome(profiles.root, profile.id, this.options.platform);
    try {
      await profiles.create(resolved.directory, resolved.provider, profile.id, profile.grantId);
    } catch (error) {
      // A failed creation may have published ownership evidence. Preserve it with the payload.
      await this.settleProfile(resolved, false);
      throw new Error(`The provider profile could not be created: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  /** Report a created profile's settlement; never throws, since the sign-in already has a result. */
  private async settleProfile(resolved: ResolvedProviderLogin, recorded: boolean | "unknown"): Promise<void> {
    if (!resolved.profile || !this.options.profiles) return;
    try {
      await this.options.profiles.settle({ home: resolved.directory, provider: resolved.provider, profileId: resolved.profile.id,
        grantId: resolved.profile.grantId, recorded, homeRemoved: false });
    } catch {
      // The control plane's row is authoritative; the next registration removes a grant it no longer lists.
    }
  }

  async startResolved(resolved: ResolvedProviderLogin): Promise<{ view: ProviderLoginView; completion: Promise<"completed" | "cancelled" | "failed"> }> {
    if (this.stopped) throw new ProviderLoginNotStarted("The provider sign-in supervisor has stopped.");
    const duplicate = [...this.active.values()].find((operation) =>
      operation.resolved.accountId === resolved.accountId);
    if (duplicate || this.pending.has(resolved.accountId)) throw new ProviderLoginNotStarted("A sign-in is already running for this account.");

    const pending = { resolved, controller: new AbortController() };
    this.pending.set(resolved.accountId, pending);
    // A managed start's label reservation becomes this pending entry, with no await in between.
    if (this.reserved.get(resolved.accountId) === resolved) this.reserved.delete(resolved.accountId);
    try {
      await this.options.acquireLease(resolved.directory, resolved.provider, {
        signal: pending.controller.signal,
        isCurrent: () => !this.stopped && this.pending.get(resolved.accountId) === pending && !pending.controller.signal.aborted,
      });
    } catch {
      if (this.pending.get(resolved.accountId) === pending) this.pending.delete(resolved.accountId);
      throw new ProviderLoginLeaseUnavailable();
    }
    if (this.stopped || pending.controller.signal.aborted) {
      // Covers cancellation in the caller's continuation after an already accepted lease.
      await this.release(resolved.directory);
      this.pending.delete(resolved.accountId);
      throw new Error("The provider sign-in was canceled before launch.");
    }
    const operationId = `login_${randomUUID()}`;
    const view: ProviderLoginView = {
      operationId,
      accountId: resolved.accountId,
      label: resolved.label,
      provider: resolved.provider,
      status: "starting",
      expectsCode: PROVIDER_LOGIN_DESCRIPTORS[resolved.provider].expectsPasteCode,
      ...(resolved.sessionId ? { sessionId: resolved.sessionId } : {}),
      startedAt: this.now(),
    };
    let resolveCompletion!: ActiveLogin["resolve"];
    const completion = new Promise<"completed" | "cancelled" | "failed">((resolve) => {
      resolveCompletion = resolve;
    });
    const structuredCodex = resolved.provider === "codex" && resolved.structuredCodex === true;
    let child: AgentProcess;
    try {
      const args = structuredCodex ? appServerArgs(resolved) : loginArgs(resolved);
      child = this.spawn({
        command: resolved.command,
        args: inheritProviderPlugins({ ...resolved, args, providerCredentialHome: resolved.directory }, resolved.provider),
        cwd: resolved.directory,
        env: resolved.env,
        context: resolved.context,
        scrubInheritedEnv: [...PROVIDER_LOGIN_DESCRIPTORS[resolved.provider].scrubEnv],
        windowsShell: false,
      });
    } catch (error) {
      await this.release(resolved.directory);
      this.pending.delete(resolved.accountId);
      if (error instanceof Error && /^(?:Claude|Codex) plugin inheritance could not /u.test(error.message)) throw error;
      throw new Error("The provider sign-in command could not be started.");
    }
    const timer = setTimeout(() => {
      const current = this.active.get(operationId);
      if (!current || current.settled || current.cancelled || current.stdinFailed) return;
      current.timedOut = true;
      this.clearCeremonyTimer(current);
      this.update(current, {
        status: "timed_out",
        error: "Sign-in timed out before the provider confirmed authentication.",
        expectsCode: false,
        verificationUrl: undefined,
        userCode: undefined,
      });
      if (current.peer && current.loginId) void this.cancelStructured(current);
      else {
        current.peer?.dispose("provider sign-in timed out");
        void this.terminate(current);
      }
    }, this.options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
    timer.unref?.();
    const active: ActiveLogin = {
      view,
      resolved,
      child,
      output: "",
      timer,
      cancelled: false,
      timedOut: false,
      settled: false,
      codeSubmitted: false,
      stdinFailed: false,
      structuredSucceeded: false,
      structuredAccountUpdated: false,
      resolve: resolveCompletion,
      completion,
    };
    this.active.set(operationId, active);
    this.pending.delete(resolved.accountId);
    this.recent.set(operationId, view);
    this.publish();
    if (structuredCodex) {
      const peer = new JsonRpcPeer(child.stdin, child.stdout);
      active.peer = peer;
      child.stderr.resume();
      peer.onNotification("account/updated", (params) => this.handleStructuredAccountUpdated(active, params));
      peer.onNotification("account/login/completed", (params) => this.handleStructuredCompletion(active, params));
      void this.startStructuredCodex(active);
    } else {
      child.stdin.on("error", () => this.failInput(active));
      const capture = (chunk: Buffer) => this.capture(active, chunk);
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      if (resolved.provider === "codex") this.armCeremonyTimer(active);
    }
    child.once("error", () => {
      active.peer?.dispose("provider sign-in process failed");
      void this.finish(active, 1);
    });
    child.once("close", (code) => {
      active.peer?.dispose("provider sign-in process exited");
      void this.finish(active, code ?? 1);
    });
    return { view: { ...view }, completion };
  }

  submitCode(operationId: string, code: string): ProviderLoginView {
    const operation = this.active.get(operationId);
    const normalized = code.trim();
    if (!operation || operation.settled || operation.stdinFailed || operation.view.provider !== "claude" ||
        !operation.view.expectsCode) {
      throw new Error("This sign-in is not waiting for a pasted code.");
    }
    if (!normalized || normalized.length > LOGIN_CODE_LIMIT || /[\u0000\r\n]/u.test(normalized)) {
      throw new Error("The authorization code must be a single line of 1 to 4096 characters.");
    }
    if (operation.child.stdin.destroyed || operation.child.stdin.writableEnded) {
      this.failInput(operation);
      throw new Error("The provider sign-in command is no longer accepting an authorization code.");
    }
    try {
      operation.child.stdin.write(`${normalized}\n`);
    } catch {
      this.failInput(operation);
      throw new Error("The provider sign-in command is no longer accepting an authorization code.");
    }
    operation.codeSubmitted = true;
    this.update(operation, { status: "waiting_for_provider", expectsCode: false });
    return { ...operation.view };
  }

  cancel(operationId: string): ProviderLoginView {
    const operation = this.active.get(operationId);
    if (!operation || operation.settled) throw new Error("This sign-in is no longer running.");
    operation.cancelled = true;
    this.update(operation, {
      status: "cancelled",
      expectsCode: false,
      error: undefined,
      verificationUrl: undefined,
      userCode: undefined,
    });
    if (operation.peer) {
      if (operation.loginId) void this.cancelStructured(operation);
      // Before account/login/start returns there is no provider-issued id to cancel. The in-flight
      // request has a short deadline; startStructuredCodex cancels the exact id as soon as it arrives.
    } else {
      void this.terminate(operation);
    }
    return { ...operation.view };
  }

  /** Forget one configured account and settle its profile grants. Retain its credential HOME and
   * canonical lease evidence: neither a managed path nor a released lease proves exclusive
   * physical retirement authority (#3157, see `ProviderAccountRemovalOptions`). */
  async removeAccount(accountId: string, options: ProviderAccountRemovalOptions = {}): Promise<{ credentialsRetained: boolean }> {
    const account = this.options.accounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new Error("Provider account is not configured on this Machine.");
    if (this.pending.has(accountId) || [...this.active.values()].some((operation) => operation.resolved.accountId === accountId)) {
      throw new Error("A sign-in is running for this account. Cancel it before removing the account.");
    }
    const blocker = this.options.removalBlocker?.(account);
    if (blocker) throw new Error(blocker);
    try {
      const preimage = captureProviderAccountsConfigPreimage(this.options.configPath, this.options.accounts);
      this.writeAccounts(this.options.configPath, this.options.accounts.filter((candidate) => candidate !== account), preimage);
    } catch (error) {
      if (accountConfigPublicationMayHaveOccurred(error)) throw error;
      throw new Error(accountConfigPublicationErrorMessage(error, "The runner configuration could not be updated."));
    }
    this.options.accounts.splice(this.options.accounts.indexOf(account), 1);
    if (options.retainCredentialHome !== true) {
      const retire = () => this.retireRemovedCredentialHomeGrant(account, options);
      await (this.options.serializeHomeRetirement?.(retire) ?? retire());
    }
    await this.options.onAccountRemoved?.(account);
    // No implemented protocol yet proves exact management provenance, excludes paused old cleanup
    // and dormant bindings, and serializes physical retirement with successor admission (#3157).
    return { credentialsRetained: true };
  }

  cancelAccount(accountId: string): boolean {
    const pending = this.pending.get(accountId);
    if (pending) { pending.controller.abort(); return true; }
    const operation = [...this.active.values()].find((candidate) =>
      candidate.resolved.accountId === accountId && !candidate.settled);
    if (!operation) return false;
    this.cancel(operation.view.operationId);
    return true;
  }

  shutdown(): void {
    this.stopped = true;
    for (const pending of this.pending.values()) pending.controller.abort();
    for (const operation of this.active.values()) {
      if (operation.settled) continue;
      operation.cancelled = true;
      operation.peer?.dispose("provider sign-in supervisor stopped");
      void this.terminate(operation);
    }
  }

  private capture(operation: ActiveLogin, chunk: Buffer): void {
    if (operation.settled || operation.cancelled || operation.timedOut || operation.stdinFailed) return;
    operation.output = `${operation.output}${chunk.toString("utf8")}`.slice(-LOGIN_OUTPUT_LIMIT);
    const progress = operation.codeSubmitted && operation.resolved.provider === "claude"
      ? null
      : PROVIDER_LOGIN_DESCRIPTORS[operation.resolved.provider].progress(operation.output);
    if (progress) {
      this.clearCeremonyTimer(operation);
      this.update(operation, progress);
    }
  }

  private armCeremonyTimer(operation: ActiveLogin): void {
    operation.ceremonyTimer = setTimeout(() => {
      if (operation.settled || operation.cancelled || operation.timedOut || operation.structuredFailure) return;
      operation.structuredFailure = "Codex did not provide a complete verification URL and device code. Upgrade Codex or try again.";
      this.update(operation, {
        status: "failed",
        expectsCode: false,
        error: operation.structuredFailure,
        verificationUrl: undefined,
        userCode: undefined,
      });
      void this.terminate(operation);
    }, this.options.ceremonyTimeoutMs ?? DEFAULT_CEREMONY_TIMEOUT_MS);
    operation.ceremonyTimer.unref?.();
  }

  private clearCeremonyTimer(operation: ActiveLogin): void {
    if (operation.ceremonyTimer) clearTimeout(operation.ceremonyTimer);
    operation.ceremonyTimer = undefined;
  }

  private async startStructuredCodex(operation: ActiveLogin): Promise<void> {
    const peer = operation.peer;
    if (!peer) return;
    this.armCeremonyTimer(operation);
    const deadlineAt = Date.now() + (this.options.ceremonyTimeoutMs ?? DEFAULT_CEREMONY_TIMEOUT_MS);
    try {
      await peer.requestWithDeadline("initialize", { clientInfo: CODEX_LOGIN_CLIENT_INFO }, deadlineAt);
      if (operation.cancelled || operation.timedOut || operation.settled) {
        peer.dispose("provider sign-in stopped before login started");
        void this.terminate(operation);
        return;
      }
      peer.notify("initialized", {});
      const response = await peer.requestWithDeadline<unknown>(
        "account/login/start",
        { type: "chatgptDeviceCode" },
        deadlineAt,
      );
      if (!response || typeof response !== "object") throw new Error("invalid structured login response");
      const result = response as Record<string, unknown>;
      const loginId = safeLoginId(result.loginId);
      const verificationUrl = typeof result.verificationUrl === "string"
        ? safeVerificationUrl(result.verificationUrl, false)
        : undefined;
      const userCode = safeDeviceCode(result.userCode);
      if (result.type !== "chatgptDeviceCode" || !loginId || !verificationUrl || !userCode) {
        throw new Error("invalid structured login response");
      }
      operation.loginId = loginId;
      this.clearCeremonyTimer(operation);
      if (operation.cancelled) {
        await this.cancelStructured(operation);
        return;
      }
      if (operation.settled || operation.timedOut) return;
      this.update(operation, {
        status: "waiting_for_provider",
        expectsCode: false,
        verificationUrl,
        userCode,
      });
    } catch (error) {
      this.clearCeremonyTimer(operation);
      if (operation.cancelled || operation.timedOut || operation.settled) {
        void this.terminate(operation);
        return;
      }
      operation.structuredFailure = isMethodNotFound(error)
        ? "This Codex installation does not support structured device-code sign-in. Upgrade Codex and try again."
        : "Codex did not provide a valid structured device-code ceremony. Upgrade Codex or try again.";
      this.update(operation, {
        status: "failed",
        expectsCode: false,
        error: operation.structuredFailure,
        verificationUrl: undefined,
        userCode: undefined,
      });
      void this.terminate(operation);
    }
  }

  private handleStructuredAccountUpdated(operation: ActiveLogin, params: unknown): void {
    if (operation.settled || operation.cancelled || operation.timedOut ||
        !params || typeof params !== "object") return;
    operation.structuredAccountUpdated = (params as Record<string, unknown>).authMode === "chatgpt";
  }

  private handleStructuredCompletion(operation: ActiveLogin, params: unknown): void {
    if (operation.settled || operation.cancelled || operation.timedOut ||
        !params || typeof params !== "object") return;
    const result = params as Record<string, unknown>;
    if (!operation.loginId || result.loginId !== operation.loginId || typeof result.success !== "boolean") return;
    this.clearCeremonyTimer(operation);
    if (result.success) {
      operation.structuredSucceeded = true;
    } else {
      operation.structuredFailure = codexFailureMessage(result.error);
      this.update(operation, {
        status: "failed",
        expectsCode: false,
        error: operation.structuredFailure,
        verificationUrl: undefined,
        userCode: undefined,
      });
    }
    void this.terminate(operation);
  }

  private async cancelStructured(operation: ActiveLogin): Promise<void> {
    const peer = operation.peer;
    const loginId = operation.loginId;
    if (!peer || !loginId) {
      await this.terminate(operation);
      return;
    }
    try {
      await peer.requestWithDeadline(
        "account/login/cancel",
        { loginId },
        Date.now() + Math.min(5_000, this.options.ceremonyTimeoutMs ?? DEFAULT_CEREMONY_TIMEOUT_MS),
      );
    } catch {
      // Cancellation is already visible locally. Reaping the owned process is the fail-closed path.
    } finally {
      await this.terminate(operation);
    }
  }

  private update(operation: ActiveLogin, patch: Partial<ProviderLoginView>): void {
    operation.view = { ...operation.view, ...patch };
    this.recent.set(operation.view.operationId, operation.view);
    this.publish();
  }

  private async finish(operation: ActiveLogin, exitCode: number): Promise<void> {
    if (operation.settled) return;
    operation.settled = true;
    clearTimeout(operation.timer);
    this.clearCeremonyTimer(operation);
    const reaped = await this.terminate(operation);
    let result: "completed" | "cancelled" | "failed" = "failed";
    let duplicate: RunnerProviderAccount | undefined;
    let profileSettled = false;
    if (operation.cancelled) {
      result = "cancelled";
      this.update(operation, {
        status: "cancelled",
        expectsCode: false,
        error: undefined,
        verificationUrl: undefined,
        userCode: undefined,
      });
    } else if (operation.timedOut) {
      this.update(operation, {
        status: "timed_out",
        expectsCode: false,
        error: "Sign-in timed out before the provider confirmed authentication.",
        verificationUrl: undefined,
        userCode: undefined,
      });
    } else if (operation.stdinFailed) {
      this.update(operation, {
        status: "failed",
        expectsCode: false,
        error: "The provider sign-in command stopped accepting the authorization code.",
        verificationUrl: undefined,
        userCode: undefined,
      });
    } else if (operation.structuredFailure) {
      this.update(operation, {
        status: "failed",
        expectsCode: false,
        error: operation.structuredFailure,
        verificationUrl: undefined,
        userCode: undefined,
      });
    } else if (!await this.authenticationConfirmed(operation, exitCode)) {
      this.update(operation, {
        status: "failed",
        expectsCode: false,
        error: "The provider did not confirm authentication.",
        verificationUrl: undefined,
        userCode: undefined,
      });
    } else if (operation.resolved.persistAccount &&
        (duplicate = await this.existingAccountWithSameIdentity(operation.resolved))) {
      // The code decides the dashboard's Already on This Machine ending (#3519). Keep the sentence
      // exactly as it is: an older control plane drops the code, and older dashboards match the words.
      this.update(operation, {
        status: "failed",
        expectsCode: false,
        error: `This ${providerName(duplicate.provider)} account is already on this Machine. ` +
          "The duplicate sign-in was discarded.",
        failureCode: "account_already_on_machine",
        verificationUrl: undefined,
        userCode: undefined,
      });
    } else {
      try {
        if (operation.resolved.persistAccount) {
          const account: RunnerProviderAccount = {
            id: operation.resolved.accountId,
            label: operation.resolved.label,
            provider: operation.resolved.provider,
            directory: operation.resolved.directory,
            ...(operation.resolved.profile ? { profileId: operation.resolved.profile.id } : {}),
          };
          const next = [...this.options.accounts, account];
          const preimage = captureProviderAccountsConfigPreimage(this.options.configPath, this.options.accounts);
          this.writeAccounts(this.options.configPath, next, preimage);
          this.options.accounts.push(account);
          if (operation.resolved.profile) {
            profileSettled = true;
            await this.settleProfile(operation.resolved, true);
          }
          await this.options.onAccountAdded(account);
        } else {
          await this.options.onAccountAdded({
            id: operation.resolved.accountId,
            label: operation.resolved.label,
            provider: operation.resolved.provider,
            directory: operation.resolved.directory,
          });
        }
        result = "completed";
        this.update(operation, {
          status: "succeeded",
          expectsCode: false,
          error: undefined,
          verificationUrl: undefined,
          userCode: undefined,
        });
      } catch (error) {
        const publicationUncertain = accountConfigPublicationMayHaveOccurred(error);
        // Drop temporary local access without falsely revoking a possibly referenced marker.
        // Neither true settlement nor usable account admission is inferred.
        if (publicationUncertain) {
          profileSettled = true;
          await this.settleProfile(operation.resolved, "unknown");
        }
        this.update(operation, {
          status: "failed",
          expectsCode: false,
          error: accountConfigPublicationErrorMessage(error, "Authentication succeeded, but the runner configuration could not be updated."),
          verificationUrl: undefined,
          userCode: undefined,
        });
      }
    }
    if (reaped) await this.release(operation.resolved.directory);
    // A managed profile whose account was not recorded never uses its grant again (#3239).
    if (!profileSettled) await this.settleProfile(operation.resolved, false);
    // The async release and profile settlement are part of settlement. Keep the account reserved
    // until both finish, including when the HOME is retained.
    this.active.delete(operation.view.operationId);
    this.pruneRecent();
    operation.resolve(result);
  }

  private async authenticationConfirmed(operation: ActiveLogin, exitCode: number): Promise<boolean> {
    if (!operation.peer) return exitCode === 0 && await this.probe(operation.resolved);
    return operation.structuredSucceeded &&
      (operation.structuredAccountUpdated || await this.probe(operation.resolved));
  }

  /** Compare a new sign-in with the other accounts of the same provider. Identities stay in memory
   * for this comparison only; an account whose identity cannot be read never counts as a match. */
  private async existingAccountWithSameIdentity(
    login: ResolvedProviderLogin,
  ): Promise<RunnerProviderAccount | undefined> {
    const candidates = this.options.accounts.filter((account) =>
      account.provider === login.provider && account.id !== login.accountId &&
      providerAccountAgentContextCompatible(account, { context: login.context }));
    if (candidates.length === 0) return undefined;
    const identity = await this.identity(login);
    if (!identity) return undefined;
    const identities = await Promise.all(candidates.map((account) => this.identity({
      ...login,
      accountId: account.id,
      label: account.label,
      directory: account.directory,
      env: {
        ...login.env,
        ...providerAccountEnvironment({ provider: account.provider, credentialHome: account.directory }),
      },
      persistAccount: false,
    })));
    return candidates.find((_account, index) => identities[index] === identity);
  }

  private async identity(login: ResolvedProviderLogin): Promise<string | undefined> {
    try {
      if (this.options.identify) return await this.options.identify(login);
      if (login.provider === "codex") {
        return codexCredentialIdentity(readFileSync(join(login.directory, "auth.json"), "utf8"));
      }
      const stdout = await this.statusStdout(login);
      return stdout === undefined ? undefined : claudeStatusIdentity(stdout);
    } catch {
      return undefined;
    }
  }

  private pruneRecent(): void {
    for (const operationId of this.recent.keys()) {
      if (this.recent.size <= RECENT_LOGIN_LIMIT) return;
      if (!this.active.has(operationId)) this.recent.delete(operationId);
    }
  }

  private terminate(operation: ActiveLogin): Promise<boolean> {
    if (!operation.reap) {
      operation.reap = this.kill(operation.child).catch(() => false);
      trackPendingKill(operation.reap);
    }
    return operation.reap;
  }

  private failInput(operation: ActiveLogin): void {
    if (operation.settled || operation.cancelled || operation.timedOut || operation.stdinFailed) return;
    operation.stdinFailed = true;
    this.update(operation, {
      status: "failed",
      expectsCode: false,
      error: "The provider sign-in command stopped accepting the authorization code.",
      verificationUrl: undefined,
      userCode: undefined,
    });
    void this.terminate(operation);
  }

  private async probe(login: ResolvedProviderLogin): Promise<boolean> {
    if (this.options.probe) return this.options.probe(login);
    const stdout = await this.statusStdout(login);
    if (stdout === undefined) return false;
    try {
      return PROVIDER_LOGIN_DESCRIPTORS[login.provider].authenticated(stdout);
    } catch {
      return false;
    }
  }

  /** Output of the provider's status command. Claude may print its structured status before a
   * non-zero exit, so that payload is kept; any other failure yields no output. */
  private async statusStdout(login: ResolvedProviderLogin): Promise<string | undefined> {
    try {
      const result = await runContextCommand(login.context, login.command, statusArgs(login), {
        cwd: login.directory,
        env: login.env,
        timeoutMs: 15_000,
        maxBuffer: 64 * 1024,
      });
      return result.stdout;
    } catch (error) {
      if (login.provider === "claude" && error && typeof error === "object" && "stdout" in error) {
        const rawStdout = (error as { stdout?: unknown }).stdout;
        const stdout = Buffer.isBuffer(rawStdout) ? rawStdout.toString("utf8") : rawStdout;
        if (typeof stdout === "string") return stdout;
      }
      return undefined;
    }
  }

  /** Preserve the existing grant-retirement ordering, without treating its verdict as permission
   * to delete credentials or lease evidence. Every HOME is retained until #3157's proofs exist. */
  private async retireRemovedCredentialHomeGrant(account: RunnerProviderAccount, options: ProviderAccountRemovalOptions): Promise<void> {
    if (!options.retireCredentialHome) return;
    const managedRoot = resolve(this.options.dataDir, "provider-accounts");
    // Keep the existing marker-mutation boundary: a replacement runner may retire this instance's
    // grants only while the exact managed HOME still holds the account's recorded profile. This
    // path/marker check does not establish authority to delete its payload or canonical journal.
    const profileRoot = this.options.profiles?.root;
    const profileHome = managedProviderProfileIdFor(profileRoot, account) !== undefined;
    const verifiedProfileHome = () => {
      if (!isManagedProviderProfileHome(profileRoot!, account.directory, account.profileId)) return false;
      try {
        const marker = readProviderProfileMarker(account.directory, { provider: account.provider });
        return marker.state === "present" && marker.marker.profileId === account.profileId;
      } catch {
        return false;
      }
    };
    if (!profileHome && dirname(resolve(account.directory)) !== managedRoot) return;
    if (!existsSync(account.directory)) return;
    if (profileHome && !verifiedProfileHome()) return;
    if (this.options.credentialHomeInUse?.(account)) return;
    try {
      await options.retireCredentialHome(account);
    } catch {
      // The profile command retries revocation when a removed HOME is retained. Unproved marker
      // retirement must not prevent the configured-account removal or erase any evidence.
    }
  }

  private async release(directory: string): Promise<boolean> {
    try { return await this.options.releaseLease(directory); }
    catch { return false; }
  }

  private publish(): void {
    this.options.onUpdate(this.views());
  }
}
