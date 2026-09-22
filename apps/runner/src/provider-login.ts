import { randomUUID } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentContext, AgentDefinition, ProviderLoginView } from "@wollipog/protocol";
import type { RunnerProviderAccount } from "./config.js";
import { writeProviderAccountsConfig } from "./config.js";
import { runContextCommand } from "./context-command.js";
import { supportsStructuredCodexDeviceLogin } from "./discovery/codex-app-server.js";
import { JsonRpcPeer, type RpcError } from "./jsonrpc.js";
import { agentForProviderAccount, providerAccountEnvironment } from "./provider-accounts.js";
import { killTreeAndWait, spawnAgent, trackPendingKill, type AgentProcess } from "./spawn.js";

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
const ANSI_ESCAPE_PATTERN = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])|\u009b[0-?]*[ -/]*[@-~]/gu;
const CODEX_LOGIN_CLIENT_INFO = { name: "wollipog-provider-login", version: "1.0.0" } as const;
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

export interface ProviderLoginSupervisorOptions {
  dataDir: string;
  configPath: string;
  accounts: RunnerProviderAccount[];
  agents: () => AgentDefinition[];
  resolveEnv: (agent: AgentDefinition) => Record<string, string>;
  acquireLease: (directory: string, provider: "claude" | "codex") => boolean;
  releaseLease: (directory: string) => boolean;
  onUpdate: (logins: ProviderLoginView[]) => void;
  onAccountAdded: (account: RunnerProviderAccount) => void | Promise<void>;
  timeoutMs?: number;
  ceremonyTimeoutMs?: number;
  spawn?: typeof spawnAgent;
  kill?: typeof killTreeAndWait;
  writeAccounts?: typeof writeProviderAccountsConfig;
  probe?: (login: ResolvedProviderLogin) => Promise<boolean>;
  now?: () => number;
}

function providerBootstrap(agent: Pick<AgentDefinition, "command" | "args">): string[] {
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
  return value.replace(ANSI_ESCAPE_PATTERN, "");
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

export class ProviderLoginSupervisor {
  private readonly active = new Map<string, ActiveLogin>();
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

  async startAccount(input: { provider: "claude" | "codex"; label: string } | { accountId: string }): Promise<ProviderLoginView> {
    let account: RunnerProviderAccount;
    let persistAccount: boolean;
    if ("accountId" in input) {
      const configured = this.options.accounts.find((candidate) => candidate.id === input.accountId);
      if (!configured) throw new Error("Provider account is not configured on this Machine.");
      account = configured;
      persistAccount = false;
    } else {
      const label = input.label.trim();
      if (!label || label.length > 100 || /[\u0000-\u001f\u007f]/u.test(label)) {
        throw new Error("Account label must contain 1 to 100 characters.");
      }
      if (this.options.accounts.length >= 32) throw new Error("This Machine already has 32 provider accounts.");
      let id: string;
      do id = `${accountSlug(label)}-${randomUUID().slice(0, 8)}`;
      while (this.options.accounts.some((candidate) => candidate.id === id));
      account = {
        id,
        label,
        provider: input.provider,
        directory: join(this.options.dataDir, "provider-accounts", id),
      };
      persistAccount = true;
    }
    const agent = agentForProviderAccount(this.options.agents(), account, [
      "claude-code", "codex", "codex-app-server",
    ]);
    if (!agent) throw new Error(`No ${account.provider === "claude" ? "Claude" : "Codex"} agent is available on this Machine.`);
    const env = {
      ...this.options.resolveEnv(agent),
      ...providerAccountEnvironment({ provider: account.provider, credentialHome: account.directory }),
    };
    for (const name of PROVIDER_LOGIN_DESCRIPTORS[account.provider].scrubEnv) {
      delete env[name];
    }
    return this.startResolved({
      accountId: account.id,
      label: account.label,
      provider: account.provider,
      directory: account.directory,
      command: agent.command,
      args: providerBootstrap(agent),
      context: agent.context ?? { kind: "native" },
      env,
      persistAccount,
      structuredCodex: account.provider === "codex" && agent.codexAppServer?.status === "supported" &&
        supportsStructuredCodexDeviceLogin(agent.codexAppServer.installedVersion),
    }).view;
  }

  startResolved(resolved: ResolvedProviderLogin): { view: ProviderLoginView; completion: Promise<"completed" | "cancelled" | "failed"> } {
    const duplicate = [...this.active.values()].find((operation) =>
      operation.resolved.accountId === resolved.accountId);
    if (duplicate) throw new Error("A sign-in is already running for this account.");

    try {
      this.options.acquireLease(resolved.directory, resolved.provider);
    } catch {
      throw new Error("The provider credential home is unavailable or already in use.");
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
      child = this.spawn({
        command: resolved.command,
        args: structuredCodex ? appServerArgs(resolved) : loginArgs(resolved),
        cwd: resolved.directory,
        env: resolved.env,
        context: resolved.context,
        scrubInheritedEnv: [...PROVIDER_LOGIN_DESCRIPTORS[resolved.provider].scrubEnv],
        windowsShell: false,
      });
    } catch {
      const released = this.options.releaseLease(resolved.directory);
      if (released && resolved.persistAccount) this.cleanupUnusedDirectory(resolved.directory);
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

  cancelAccount(accountId: string): boolean {
    const operation = [...this.active.values()].find((candidate) =>
      candidate.resolved.accountId === accountId && !candidate.settled);
    if (!operation) return false;
    this.cancel(operation.view.operationId);
    return true;
  }

  shutdown(): void {
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
    } else if (await this.authenticationConfirmed(operation, exitCode)) {
      try {
        if (operation.resolved.persistAccount) {
          const account: RunnerProviderAccount = {
            id: operation.resolved.accountId,
            label: operation.resolved.label,
            provider: operation.resolved.provider,
            directory: operation.resolved.directory,
          };
          const next = [...this.options.accounts, account];
          this.writeAccounts(this.options.configPath, next);
          this.options.accounts.push(account);
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
      } catch {
        this.update(operation, {
          status: "failed",
          expectsCode: false,
          error: "Authentication succeeded, but the runner configuration could not be updated.",
          verificationUrl: undefined,
          userCode: undefined,
        });
      }
    } else {
      this.update(operation, {
        status: "failed",
        expectsCode: false,
        error: "The provider did not confirm authentication.",
        verificationUrl: undefined,
        userCode: undefined,
      });
    }
    this.active.delete(operation.view.operationId);
    this.pruneRecent();
    const released = reaped && this.options.releaseLease(operation.resolved.directory);
    if (released && result !== "completed" && operation.resolved.persistAccount) {
      this.cleanupUnusedDirectory(operation.resolved.directory);
    }
    operation.resolve(result);
  }

  private async authenticationConfirmed(operation: ActiveLogin, exitCode: number): Promise<boolean> {
    if (!operation.peer) return exitCode === 0 && await this.probe(operation.resolved);
    return operation.structuredSucceeded &&
      (operation.structuredAccountUpdated || await this.probe(operation.resolved));
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
    try {
      const result = await runContextCommand(login.context, login.command, statusArgs(login), {
        cwd: login.directory,
        env: login.env,
        timeoutMs: 15_000,
        maxBuffer: 64 * 1024,
      });
      return PROVIDER_LOGIN_DESCRIPTORS[login.provider].authenticated(result.stdout);
    } catch (error) {
      if (login.provider === "claude" && error && typeof error === "object" && "stdout" in error) {
        const rawStdout = (error as { stdout?: unknown }).stdout;
        const stdout = Buffer.isBuffer(rawStdout) ? rawStdout.toString("utf8") : rawStdout;
        if (typeof stdout === "string") {
          try {
            return PROVIDER_LOGIN_DESCRIPTORS.claude.authenticated(stdout);
          } catch {
            return false;
          }
        }
      }
      return false;
    }
  }

  private cleanupUnusedDirectory(directory: string): void {
    try {
      const providerEntries = readdirSync(directory).filter((entry) => entry !== ".agent-manager");
      if (providerEntries.length === 0) rmSync(directory, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort; partial provider state is retained for operator inspection.
    }
  }

  private publish(): void {
    this.options.onUpdate(this.views());
  }
}
