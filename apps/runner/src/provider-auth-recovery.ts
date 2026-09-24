import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentDriverKind } from "@wollipog/protocol";
import type { RunnerConfig } from "./config.js";
import { runContextCommand, type ContextCommandResult } from "./context-command.js";
import { supportsStructuredCodexDeviceLogin } from "./discovery/codex-app-server.js";
import {
  CLAUDE_PENDING_MAX_MS,
  CLAUDE_PERSISTENT_FLAG,
  CLAUDE_PERSISTENT_IDLE_MS,
  LEGACY_CLAUDE_PENDING_MAX_MS,
  LEGACY_CLAUDE_PERSISTENT_FLAG,
  LEGACY_CLAUDE_PERSISTENT_IDLE_MS,
} from "./drivers/claude-code.js";
import { killTree, spawnAgent, type AgentProcess } from "./spawn.js";
import type { ProviderLoginSupervisor } from "./provider-login.js";
import type {
  ProviderAuthIdentityEvidence,
  ProviderAuthIdentityField,
  SessionMeta,
} from "./session-store.js";

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
  /** Runner-keyed per-field digests. Values and hashes never enter logs, events, or snapshots. */
  identityEvidence?: ProviderAuthIdentityEvidence;
}

/** A fresh provider observation plus the provider-reported email, for one authorized viewer.
 * The email is transient: callers must return it directly and never persist or log it. */
export interface ProviderAuthIdentityInspection {
  observation: ProviderAuthObservation;
  emailSupported: boolean;
  email: string | null;
}

export interface ProviderAuthIdentityComparison {
  matches: boolean;
  evidenceAvailable: boolean;
  evidenceGenerationMismatch: boolean;
  differingFields: ProviderAuthIdentityField[];
  expectedMissingFields: ProviderAuthIdentityField[];
  observedMissingFields: ProviderAuthIdentityField[];
  sharedAccountFields: Array<Extract<ProviderAuthIdentityField, "email" | "orgId">>;
}

export interface ProviderAuthRecoveryController {
  describe(meta: SessionMeta): ProviderCredentialScope | null;
  revalidate(meta: SessionMeta): Promise<ProviderAuthObservation>;
  /** Optional so older test doubles remain valid; absent means identity cannot be displayed. */
  inspect?(meta: SessionMeta): Promise<ProviderAuthIdentityInspection>;
  startLogin(meta: SessionMeta): Promise<"completed" | "cancelled" | "failed">;
  cancel(scopeId: string): boolean;
}

type CommandRunner = typeof runContextCommand;
type DigestKey = string | Buffer;

const PROVIDER_AUTH_EVIDENCE_KEY_FILE = "provider-auth-evidence-hmac.key";
const PROVIDER_AUTH_EVIDENCE_KEY_BYTES = 32;

const CLAUDE_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
] as const;
const CODEX_CREDENTIAL_ENV = ["OPENAI_API_KEY"] as const;
const CLAUDE_ACCOUNT_FIELDS = ["email", "orgId", "authMethod", "apiProvider"] as const satisfies readonly ProviderAuthIdentityField[];
const CLAUDE_ACCOUNT_ANCHORS = ["email", "orgId"] as const;

function digest(value: unknown, key?: DigestKey): string {
  const payload = JSON.stringify(value);
  return key
    ? createHmac("sha256", key).update(payload).digest("hex")
    : createHash("sha256").update(payload).digest("hex");
}

function identityEvidence(
  account: Record<ProviderAuthIdentityField, string | null>,
  key?: DigestKey,
  version: ProviderAuthIdentityEvidence["version"] = 1,
): ProviderAuthIdentityEvidence {
  const fields: ProviderAuthIdentityEvidence["fields"] = {};
  for (const field of CLAUDE_ACCOUNT_FIELDS) {
    if (account[field] !== null) fields[field] = digest([field, account[field]], key);
  }
  return { version, fields };
}

export function compareProviderAuthIdentity(
  expectedIdentityId: string | undefined,
  expectedEvidence: ProviderAuthIdentityEvidence | undefined,
  observed: ProviderAuthObservation,
): ProviderAuthIdentityComparison {
  const observedEvidence = observed.identityEvidence;
  if (expectedEvidence && observedEvidence && expectedEvidence.version !== observedEvidence.version) {
    // Version 2 changes only the evidence-generation marker. Any equal field digest proves a
    // forward v1 -> v2 observation kept the same stable HMAC key, after which the ordinary
    // field-level comparison can distinguish partial observations from real account changes.
    // Rollbacks and changed-key migrations remain incomparable and fail closed.
    const sharedDigest = CLAUDE_ACCOUNT_FIELDS.some((field) =>
      expectedEvidence.fields[field] !== undefined &&
      expectedEvidence.fields[field] === observedEvidence.fields[field]);
    const sameAggregate = !!expectedIdentityId && observed.identityId === expectedIdentityId;
    if (expectedEvidence.version > observedEvidence.version || (!sharedDigest && !sameAggregate)) {
      return {
        matches: false,
        evidenceAvailable: false,
        evidenceGenerationMismatch: true,
        differingFields: [],
        expectedMissingFields: [],
        observedMissingFields: [],
        sharedAccountFields: [],
      };
    }
  }
  if (expectedIdentityId && observed.identityId === expectedIdentityId) {
    return {
      matches: true,
      evidenceAvailable: !!expectedEvidence && !!observed.identityEvidence,
      evidenceGenerationMismatch: false,
      differingFields: [],
      expectedMissingFields: [],
      observedMissingFields: [],
      sharedAccountFields: [],
    };
  }
  if (!expectedEvidence || !observedEvidence) {
    return {
      matches: false,
      evidenceAvailable: false,
      evidenceGenerationMismatch: false,
      differingFields: [],
      expectedMissingFields: [],
      observedMissingFields: [],
      sharedAccountFields: [],
    };
  }
  const expectedMissingFields = CLAUDE_ACCOUNT_FIELDS.filter((field) => expectedEvidence.fields[field] === undefined);
  const observedMissingFields = CLAUDE_ACCOUNT_FIELDS.filter((field) => observedEvidence.fields[field] === undefined);
  const differingFields = CLAUDE_ACCOUNT_FIELDS.filter((field) =>
    expectedEvidence.fields[field] !== undefined && observedEvidence.fields[field] !== undefined &&
    expectedEvidence.fields[field] !== observedEvidence.fields[field]);
  const sharedAccountFields = CLAUDE_ACCOUNT_ANCHORS.filter((field) =>
    expectedEvidence.fields[field] !== undefined && observedEvidence.fields[field] !== undefined &&
    expectedEvidence.fields[field] === observedEvidence.fields[field]);
  return {
    matches: differingFields.length === 0 && sharedAccountFields.length > 0,
    evidenceAvailable: true,
    evidenceGenerationMismatch: false,
    differingFields,
    expectedMissingFields,
    observedMissingFields,
    sharedAccountFields,
  };
}

export function mergeProviderAuthIdentityEvidence(
  expected: ProviderAuthIdentityEvidence | undefined,
  observed: ProviderAuthIdentityEvidence | undefined,
): ProviderAuthIdentityEvidence | undefined {
  if (!expected) return observed;
  if (!observed) return expected;
  if (expected.version !== observed.version) {
    const sharedDigest = expected.version < observed.version && CLAUDE_ACCOUNT_FIELDS.some((field) =>
      expected.fields[field] !== undefined && expected.fields[field] === observed.fields[field]);
    return sharedDigest
      ? { version: observed.version, fields: { ...expected.fields, ...observed.fields } }
      : observed;
  }
  return { version: observed.version, fields: { ...expected.fields, ...observed.fields } };
}

export function describeProviderAuthIdentityMismatch(comparison: ProviderAuthIdentityComparison): string {
  if (comparison.evidenceGenerationMismatch) {
    return "The recorded provider identity evidence uses a previous evidence-key generation and cannot be " +
      "compared with the current authenticated state. Wollipog cannot determine whether the account changed. " +
      "Choose Use Current Account to accept the current authenticated state for this session, or restore the " +
      "recorded authentication and choose Recheck Authentication. Credential and account values are redacted.";
  }
  if (!comparison.evidenceAvailable) {
    return "Wollipog cannot match the current authenticated state to the state recorded for this session " +
      "with the available evidence, so it cannot determine whether the account changed. Choose Use Current Account " +
      "to accept the current authenticated state for this session, or restore the recorded authentication and choose " +
      "Recheck Authentication. Credential and account values are redacted.";
  }
  const details: string[] = [];
  if (comparison.differingFields.length) {
    details.push(`${comparison.differingFields.join(", ")} differed`);
  }
  if (comparison.expectedMissingFields.length) {
    details.push(`${comparison.expectedMissingFields.join(", ")} ${comparison.expectedMissingFields.length === 1 ? "was" : "were"} missing from the recorded observation`);
  }
  if (comparison.observedMissingFields.length) {
    details.push(`${comparison.observedMissingFields.join(", ")} ${comparison.observedMissingFields.length === 1 ? "was" : "were"} missing from the current observation`);
  }
  if (!comparison.differingFields.length && !comparison.sharedAccountFields.length) {
    details.push("the observations share no comparable email or orgId field");
  }
  if (!details.length) details.push("no differing or missing field was identified");
  return `Provider account identity mismatch: ${details.join("; ")}. Account values are redacted.`;
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

export function describeProviderCredentialScope(
  meta: SessionMeta,
  digestKey?: DigestKey,
  loginAvailable = false,
): ProviderCredentialScope | null {
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
    canStartLogin: loginAvailable && !configuredCredential && meta.context.kind === "native",
  };
}

const MAX_DISPLAY_EMAIL_LENGTH = 254;

/** Accept only a plausible single address for display. Anything else is treated as not supplied
 * rather than shown, so provider diagnostics cannot reach the card through this field. */
export function displayableProviderEmail(value: string | null): string | null {
  if (value === null) return null;
  const email = value.trim();
  if (!email || email.length > MAX_DISPLAY_EMAIL_LENGTH) return null;
  return /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u.test(email) ? email : null;
}

function claudeInspection(
  result: ContextCommandResult,
  digestKey?: DigestKey,
  evidenceVersion: ProviderAuthIdentityEvidence["version"] = 1,
): { observation: ProviderAuthObservation; email: string | null } {
  let parsed: Record<string, unknown> | undefined;
  try {
    const value = JSON.parse(result.stdout);
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    return { observation: { status: "unknown" }, email: null };
  }
  if (parsed?.loggedIn === false) return { observation: { status: "unauthenticated" }, email: null };
  if (parsed?.loggedIn !== true) return { observation: { status: "unknown" }, email: null };
  const account = {
    email: typeof parsed.email === "string" ? parsed.email : null,
    orgId: typeof parsed.orgId === "string" ? parsed.orgId : null,
    authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
    apiProvider: typeof parsed.apiProvider === "string" ? parsed.apiProvider : null,
  };
  const hasAccountIdentity = account.email !== null || account.orgId !== null;
  return {
    observation: {
      status: "authenticated",
      ...(hasAccountIdentity ? {
        identityId: digest(account, digestKey),
        identityEvidence: identityEvidence(account, digestKey, evidenceVersion),
      } : {}),
    },
    email: displayableProviderEmail(account.email),
  };
}

function claudeObservation(
  result: ContextCommandResult,
  digestKey?: DigestKey,
  evidenceVersion: ProviderAuthIdentityEvidence["version"] = 1,
): ProviderAuthObservation {
  return claudeInspection(result, digestKey, evidenceVersion).observation;
}

function codexIdentity(meta: SessionMeta, digestKey?: DigestKey): string | undefined {
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

class NativeProviderAuthRecovery implements ProviderAuthRecoveryController {
  private readonly spawn: typeof spawnAgent;
  private readonly kill: typeof killTree;
  private readonly loginAccounts = new Map<string, { accountId: string; attempt: symbol }>();

  constructor(
    private readonly injectedRun?: CommandRunner,
    private readonly digestKey?: DigestKey,
    deps: Partial<{ spawn: typeof spawnAgent; kill: typeof killTree }> = {},
    private readonly evidenceVersion: ProviderAuthIdentityEvidence["version"] = 1,
    private readonly loginSupervisor?: ProviderLoginSupervisor,
    private readonly loginAvailable: () => boolean = () => true,
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
    return describeProviderCredentialScope(
      meta,
      this.digestKey,
      !!this.loginSupervisor && this.loginAvailable(),
    );
  }

  async revalidate(meta: SessionMeta): Promise<ProviderAuthObservation> {
    const scope = this.describe(meta);
    if (!scope) return { status: "unknown" };
    try {
      if (scope.provider === "claude") {
        const result = await this.runExact(meta, meta.command, providerArgs(meta, ["auth", "status"]), 15_000, 64 * 1024);
        return claudeObservation(result, this.digestKey, this.evidenceVersion);
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
        if (typeof stdout === "string") {
          return claudeObservation({ stdout, stderr: "" }, this.digestKey, this.evidenceVersion);
        }
      }
      return { status: "unknown" };
    }
  }

  async inspect(meta: SessionMeta): Promise<ProviderAuthIdentityInspection> {
    const scope = this.describe(meta);
    if (scope?.provider !== "claude") {
      return { observation: await this.revalidate(meta), emailSupported: false, email: null };
    }
    let stdout: string;
    try {
      stdout = (await this.runExact(meta, meta.command, providerArgs(meta, ["auth", "status"]), 15_000, 64 * 1024)).stdout;
    } catch (error) {
      // Same positive-evidence rule as revalidate(): a non-zero exit may still carry the payload.
      const partial = error && typeof error === "object" && "stdout" in error
        ? (error as { stdout?: unknown }).stdout
        : undefined;
      if (typeof partial !== "string") return { observation: { status: "unknown" }, emailSupported: true, email: null };
      stdout = partial;
    }
    const inspected = claudeInspection({ stdout, stderr: "" }, this.digestKey, this.evidenceVersion);
    return { ...inspected, emailSupported: true };
  }

  async startLogin(meta: SessionMeta): Promise<"completed" | "cancelled" | "failed"> {
    const scope = this.describe(meta);
    if (!scope?.canStartLogin || !this.loginSupervisor) return "failed";
    const directory = scope.provider === "claude"
      ? meta.env.CLAUDE_CONFIG_DIR ?? meta.env.HOME ?? homedir()
      : meta.env.CODEX_HOME ?? meta.env.HOME ?? homedir();
    const accountId = meta.providerAccountId ?? `default-${scope.provider}-${scope.id.slice(0, 12)}`;
    let entry: { accountId: string; attempt: symbol } | undefined;
    try {
      const operation = this.loginSupervisor.startResolved({
        accountId,
        label: meta.providerAccountLabel ?? `Default ${scope.provider === "claude" ? "Claude" : "Codex"} Account`,
        provider: scope.provider,
        directory,
        command: meta.command,
        args: providerArgs(meta, []),
        context: meta.context,
        env: meta.env,
        persistAccount: false,
        sessionId: meta.sessionId,
        structuredCodex: scope.provider === "codex" && meta.driver === "codex-app-server" &&
          supportsStructuredCodexDeviceLogin(meta.agentVersion),
      });
      entry = { accountId, attempt: Symbol("provider-login") };
      this.loginAccounts.set(scope.id, entry);
      return await operation.completion;
    } catch {
      return "failed";
    } finally {
      if (entry && this.loginAccounts.get(scope.id) === entry) this.loginAccounts.delete(scope.id);
    }
  }

  cancel(scopeId: string): boolean {
    const entry = this.loginAccounts.get(scopeId);
    return entry ? this.loginSupervisor?.cancelAccount(entry.accountId) ?? false : false;
  }
}

/** Construct the runner-owned recovery controller with evidence that survives transport token
 * rotation. Existing evidence produced with the legacy transport-token key intentionally fails
 * comparison once, requiring explicit acceptance before the stable baseline is recorded. */
export function createRunnerProviderAuthRecovery(
  config: Pick<RunnerConfig, "dataDir">,
  injectedRun?: CommandRunner,
  loginSupervisor?: ProviderLoginSupervisor,
  loginAvailable?: () => boolean,
): ProviderAuthRecoveryController {
  return new NativeProviderAuthRecovery(
    injectedRun,
    loadOrCreateProviderAuthEvidenceKey(config.dataDir),
    {},
    2,
    loginSupervisor,
    loginAvailable,
  );
}

/** Unit-test seam for exact provider observations. Production assembly cannot import the native
 * implementation directly and must use createRunnerProviderAuthRecovery with the runner config. */
export function createTestProviderAuthRecovery(
  injectedRun?: CommandRunner,
  digestKey?: DigestKey,
  deps: Partial<{ spawn: typeof spawnAgent; kill: typeof killTree }> = {},
  evidenceVersion: ProviderAuthIdentityEvidence["version"] = 1,
): ProviderAuthRecoveryController {
  return new NativeProviderAuthRecovery(injectedRun, digestKey, deps, evidenceVersion);
}

function loadOrCreateProviderAuthEvidenceKey(dataDir: string): Buffer {
  const directory = join(dataDir, "credentials");
  const file = join(directory, PROVIDER_AUTH_EVIDENCE_KEY_FILE);
  const directoryExisted = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!directoryExisted) fsyncDirectory(dirname(directory));
  if (existsSync(file)) return readProviderAuthEvidenceKey(file);

  const key = randomBytes(PROVIDER_AUTH_EVIDENCE_KEY_BYTES);
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, key);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    // Publish without replacement so even an unexpected concurrent constructor can observe only
    // one complete key. The runner data-directory lease normally provides exclusive ownership.
    linkSync(temp, file);
    fsyncDirectory(directory);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readProviderAuthEvidenceKey(file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function readProviderAuthEvidenceKey(file: string): Buffer {
  const key = readFileSync(file);
  if (key.length !== PROVIDER_AUTH_EVIDENCE_KEY_BYTES) {
    throw new Error("provider authentication evidence key is malformed");
  }
  try { chmodSync(file, 0o600); } catch { /* Windows ACLs are managed by the owning account. */ }
  return key;
}

function fsyncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
