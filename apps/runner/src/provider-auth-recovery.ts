import { createHash, createHmac } from "node:crypto";
import { homedir } from "node:os";
import type { AgentDriverKind } from "@wollipog/protocol";
import { runContextCommand, type ContextCommandResult } from "./context-command.js";
import {
  CLAUDE_PENDING_MAX_MS,
  CLAUDE_PERSISTENT_FLAG,
  CLAUDE_PERSISTENT_IDLE_MS,
  LEGACY_CLAUDE_PENDING_MAX_MS,
  LEGACY_CLAUDE_PERSISTENT_FLAG,
  LEGACY_CLAUDE_PERSISTENT_IDLE_MS,
} from "./drivers/claude-code.js";
import { killTree, spawnAgent, type AgentProcess } from "./spawn.js";
import type { SessionMeta } from "./session-store.js";

export type ProviderAuthStatus = "authenticated" | "unauthenticated" | "unknown";

export interface ProviderCredentialScope {
  id: string;
  provider: "claude" | "codex";
  canStartLogin: boolean;
  configuredCredential: boolean;
}

export interface ProviderAuthObservation {
  status: ProviderAuthStatus;
  /** Opaque runner-local digest. It is persisted only in SessionMeta and never enters snapshots. */
  identityId?: string;
}

export interface ProviderAuthRecoveryController {
  describe(meta: SessionMeta): ProviderCredentialScope | null;
  revalidate(meta: SessionMeta): Promise<ProviderAuthObservation>;
  startLogin(meta: SessionMeta): Promise<"completed" | "cancelled" | "failed">;
  cancel(scopeId: string): boolean;
}

type CommandRunner = typeof runContextCommand;

const CLAUDE_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
] as const;
const CODEX_CREDENTIAL_ENV = ["OPENAI_API_KEY"] as const;

function digest(value: unknown, key?: string): string {
  const payload = JSON.stringify(value);
  return key
    ? createHmac("sha256", key).update(payload).digest("hex")
    : createHash("sha256").update(payload).digest("hex");
}

function providerFamily(driver: AgentDriverKind): "claude" | "codex" | null {
  if (driver === "claude-code") return "claude";
  if (driver === "codex" || driver === "codex-app-server") return "codex";
  return null;
}

function credentialEnvNames(meta: SessionMeta, provider: "claude" | "codex"): string[] {
  const names = provider === "claude" ? CLAUDE_CREDENTIAL_ENV : CODEX_CREDENTIAL_ENV;
  return names.filter((name) => !!meta.env[name]);
}

function launchFingerprint(meta: SessionMeta): { command: string; bootstrap: string[] } {
  // Version-manager launches use `node /absolute/provider-cli.js`; the script is part of the
  // installation identity. Provider turn/model flags are deliberately not credential selectors.
  const bootstrap = meta.args.length && /(?:^|[\\/])node(?:\.exe)?$/i.test(meta.command)
    ? [meta.args[0]!]
    : [];
  return { command: meta.command, bootstrap };
}

function providerArgs(meta: SessionMeta, tail: string[]): string[] {
  return [...launchFingerprint(meta).bootstrap, ...tail];
}

function contextIdentity(meta: SessionMeta): unknown {
  return {
    context: meta.context.kind === "wsl" ? { kind: "wsl", distro: meta.context.distro } : { kind: "native" },
    target: meta.executionTarget ? { adapter: meta.executionTarget.adapter, id: meta.executionTarget.id } : null,
  };
}

function credentialHome(meta: SessionMeta, provider: "claude" | "codex"): string {
  if (provider === "claude" && meta.env.CLAUDE_CONFIG_DIR) return meta.env.CLAUDE_CONFIG_DIR;
  if (provider === "codex" && meta.env.CODEX_HOME) return meta.env.CODEX_HOME;
  // The literal path remains runner-local inside the digest. The fallback is still exact within a
  // runner/context pair; WSL distro and native process identity are already part of the scope.
  return meta.env.HOME ?? "<context-default-home>";
}

export function describeProviderCredentialScope(meta: SessionMeta, digestKey?: string): ProviderCredentialScope | null {
  const provider = providerFamily(meta.driver);
  // Container/cloud adapters own their provider process and credential projection, but do not yet
  // expose a provider-native status probe. Persisting a runner-owned block for one would create a
  // durable state that Recheck can never prove or clear. Keep the pre-existing process-local
  // fail-closed behavior until an adapter supplies an exact-context probe.
  if (!provider || (meta.executionTarget && meta.executionTarget.adapter !== "host")) return null;
  const credentialNames = credentialEnvNames(meta, provider);
  const configuredCredential = credentialNames.length > 0;
  const id = digest({
    version: 1,
    provider,
    launch: launchFingerprint(meta),
    placement: contextIdentity(meta),
    credentialHome: credentialHome(meta, provider),
    credentialSource: configuredCredential ? { kind: "environment", names: credentialNames } : { kind: "provider-home" },
  }, digestKey);
  return {
    id,
    provider,
    configuredCredential,
    // The shared provider-home lease now exists, but login remains revalidation-only until this
    // path acquires that lease for the exact freshly resolved isolation, supervises a cancellable
    // provider child, and either leases or rejects credential roots overridden outside HOME.
    canStartLogin: false,
  };
}

function claudeObservation(result: ContextCommandResult, digestKey?: string): ProviderAuthObservation {
  let parsed: Record<string, unknown> | undefined;
  try {
    const value = JSON.parse(result.stdout);
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    return { status: "unknown" };
  }
  if (parsed?.loggedIn === false) return { status: "unauthenticated" };
  if (parsed?.loggedIn !== true) return { status: "unknown" };
  const account = {
    email: typeof parsed.email === "string" ? parsed.email : null,
    orgId: typeof parsed.orgId === "string" ? parsed.orgId : null,
    authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
    apiProvider: typeof parsed.apiProvider === "string" ? parsed.apiProvider : null,
  };
  const hasAccountIdentity = account.email !== null || account.orgId !== null;
  return { status: "authenticated", ...(hasAccountIdentity ? { identityId: digest(account, digestKey) } : {}) };
}

function codexIdentity(meta: SessionMeta, digestKey?: string): string | undefined {
  const credentialNames = credentialEnvNames(meta, "codex");
  if (credentialNames.length) {
    // Only the digest is persisted. Raw values never leave this function or enter logs/events.
    return digest(credentialNames.map((name) => [name, meta.env[name]]), digestKey);
  }
  // Codex's documented `login status` currently proves method/readiness but exposes no stable
  // account identifier. Hashing auth.json would identify a token rotation, not an account, so
  // provider-home recovery requires explicit per-session acceptance and never auto-fans out.
  return undefined;
}

export class NativeProviderAuthRecovery implements ProviderAuthRecoveryController {
  private readonly spawn: typeof spawnAgent;
  private readonly kill: typeof killTree;

  constructor(
    private readonly injectedRun?: CommandRunner,
    private readonly digestKey?: string,
    deps: Partial<{ spawn: typeof spawnAgent; kill: typeof killTree }> = {},
  ) {
    this.spawn = deps.spawn ?? spawnAgent;
    this.kill = deps.kill ?? killTree;
  }

  private scrubInheritedEnv(meta: SessionMeta): string[] {
    return providerFamily(meta.driver) === "claude"
      ? [
          "ANTHROPIC_API_KEY",
          CLAUDE_PERSISTENT_FLAG,
          CLAUDE_PERSISTENT_IDLE_MS,
          CLAUDE_PENDING_MAX_MS,
          LEGACY_CLAUDE_PERSISTENT_FLAG,
          LEGACY_CLAUDE_PERSISTENT_IDLE_MS,
          LEGACY_CLAUDE_PENDING_MAX_MS,
        ]
      : ["OPENAI_API_KEY"];
  }

  private stableCwd(meta: SessionMeta): string {
    if (meta.context.kind === "wsl") return meta.env.HOME ?? "/";
    return meta.env.HOME ?? homedir();
  }

  private runExact(meta: SessionMeta, command: string, args: string[], timeoutMs: number, maxBuffer: number): Promise<ContextCommandResult> {
    if (this.injectedRun) {
      return this.injectedRun(meta.context, command, args, {
        cwd: this.stableCwd(meta), env: meta.env, timeoutMs, maxBuffer,
      });
    }
    return new Promise((resolve, reject) => {
      let child: AgentProcess;
      try {
        child = this.spawn({
          command,
          args,
          cwd: this.stableCwd(meta),
          env: meta.env,
          context: meta.context,
          scrubInheritedEnv: this.scrubInheritedEnv(meta),
          windowsShell: false,
        });
      } catch (error) {
        reject(Object.assign(new Error("provider auth command unavailable"), { code: "SPAWN_FAILED", cause: error }));
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
        if (error) reject(Object.assign(new Error("provider auth command failed"), { code: error, ...result }));
        else resolve(result);
      };
      const capture = (target: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBuffer) {
          this.kill(child);
          finish("MAX_BUFFER");
          return;
        }
        target.push(Buffer.from(chunk));
      };
      child.stdout.on("data", capture(stdout));
      child.stderr.on("data", capture(stderr));
      child.once("error", () => finish("SPAWN_FAILED"));
      child.once("close", (code) => finish(code === 0 ? undefined : code ?? "NO_EXIT_CODE"));
      child.stdin.end();
      timer = setTimeout(() => {
        this.kill(child);
        finish("TIMEOUT");
      }, timeoutMs);
      timer.unref?.();
    });
  }

  describe(meta: SessionMeta): ProviderCredentialScope | null {
    return describeProviderCredentialScope(meta, this.digestKey);
  }

  async revalidate(meta: SessionMeta): Promise<ProviderAuthObservation> {
    const scope = this.describe(meta);
    if (!scope) return { status: "unknown" };
    try {
      if (scope.provider === "claude") {
        const result = await this.runExact(meta, meta.command, providerArgs(meta, ["auth", "status"]), 15_000, 64 * 1024);
        return claudeObservation(result, this.digestKey);
      }
      await this.runExact(meta, meta.command, providerArgs(meta, ["login", "status"]), 15_000, 64 * 1024);
      const identityId = codexIdentity(meta, this.digestKey);
      return { status: "authenticated", ...(identityId ? { identityId } : {}) };
    } catch (error) {
      // Exit status alone is not authentication evidence: old CLIs without the status subcommand,
      // transient provider failures, and a real sign-out can all be numeric non-zero exits. Claude
      // sometimes still emits its structured status payload before that exit, so accept only that
      // positive provider-native evidence and otherwise remain unknown/fail closed.
      if (scope.provider === "claude" && error && typeof error === "object" && "stdout" in error) {
        const stdout = (error as { stdout?: unknown }).stdout;
        if (typeof stdout === "string") return claudeObservation({ stdout, stderr: "" }, this.digestKey);
      }
      return { status: "unknown" };
    }
  }

  async startLogin(meta: SessionMeta): Promise<"completed" | "cancelled" | "failed"> {
    void meta;
    return "failed";
  }

  cancel(scopeId: string): boolean {
    void scopeId;
    return false;
  }
}
