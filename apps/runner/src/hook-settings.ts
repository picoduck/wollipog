/**
 * Per-session Claude Code hook settings.
 *
 * Settings are injected as a file (never inline JSON) and contain only protected credential-file
 * references. A template beside the live file lets every one-shot, persistent, resume, and fork
 * spawn heal an accidentally deleted settings file without needing a second copy of the token.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentDefinition, ElicitationTransport, SessionLaunchSpec } from "@wollipog/protocol";
import { deriveCpHttpUrl } from "./conductor.js";
import { effectiveClaudePermissionMode } from "./claude-permission.js";
import {
  defaultRunnerReentryHost,
  runnerReentryCommand,
  type RunnerReentryHost,
} from "./runner-reentry.js";
import { winQuoteArg } from "./spawn.js";
import { readCompatibleEnv, type LegacyEnvironmentWarning } from "./env-compat.js";

export const CLAUDE_HOOKS_FLAG = "WOLLIPOG_CLAUDE_HOOKS";
export const LEGACY_CLAUDE_HOOKS_FLAG = "MAM_CLAUDE_HOOKS";
export const POLICY_HOOK_ENV = {
  cpUrl: "WOLLIPOG_POLICY_HOOK_CP_URL",
  sessionId: "WOLLIPOG_POLICY_HOOK_SESSION_ID",
  settingsFile: "WOLLIPOG_POLICY_HOOK_SETTINGS_FILE",
  circuitFile: "WOLLIPOG_POLICY_HOOK_CIRCUIT_FILE",
  readyFile: "WOLLIPOG_POLICY_HOOK_READY_FILE",
  askCapable: "WOLLIPOG_POLICY_HOOK_ASK_CAPABLE",
} as const;
export const LEGACY_POLICY_HOOK_ENV = {
  cpUrl: "MAM_POLICY_HOOK_CP_URL",
  sessionId: "MAM_POLICY_HOOK_SESSION_ID",
  settingsFile: "MAM_POLICY_HOOK_SETTINGS_FILE",
  circuitFile: "MAM_POLICY_HOOK_CIRCUIT_FILE",
  readyFile: "MAM_POLICY_HOOK_READY_FILE",
  askCapable: "MAM_POLICY_HOOK_ASK_CAPABLE",
} as const;

const SETTINGS_SUFFIX = ".settings.json";
const TEMPLATE_SUFFIX = ".template.json";
const CIRCUIT_SUFFIX = ".circuit.json";
const CIRCUIT_LOCK_SUFFIX = ".circuit.lock";
const TOKEN_SUFFIX = ".token";
const READY_SUFFIX = ".ready";
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const WINDOWS_RESERVED_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const POLICY_HOOK_CREDENTIAL_PREFIX = "wollipogh_";
const POLICY_HOOK_CREDENTIAL = /^(?:wollipogh_|mamh_)[A-Za-z0-9_-]{43}$/u;
export const CLAUDE_HOOK_CIRCUIT_COOLDOWN_MS = 30_000;
export const CLAUDE_HOOK_PROTOCOL_VERSION = 65;
const CLAUDE_HOOK_CIRCUIT_LOCK_STALE_MS = 5_000;

export interface ClaudeHookHost extends RunnerReentryHost {
  configDir: string;
}

type ClaudeHookLaunchSpec = Omit<Pick<
  SessionLaunchSpec,
  "sessionId" | "agentId" | "driver" | "context" | "capabilities" | "args" | "config" | "executionTarget"
>, "agentId"> & { agentId: string | null };

export interface HookCircuitState {
  consecutiveFailures: number;
  open: boolean;
  lastDurationMs?: number;
  openedAt?: number;
  /** One sidecar owns the half-open re-probe; concurrent hook processes continue to defer. */
  probeStartedAt?: number;
  /** Explicit CP rejection defers until re-registration succeeds; it is not a transport failure. */
  credentialRejected?: boolean;
}

export function claudeHooksEnabled(
  env: NodeJS.ProcessEnv = process.env,
  warn?: LegacyEnvironmentWarning,
): boolean {
  return readCompatibleEnv(env, CLAUDE_HOOKS_FLAG, LEGACY_CLAUDE_HOOKS_FLAG, warn) === "1";
}

function defaultHookConfigDir(): string {
  return join(homedir(), ".agent-manager", "hooks");
}

export function defaultClaudeHookHost(): ClaudeHookHost {
  return { ...defaultRunnerReentryHost(), configDir: defaultHookConfigDir() };
}

/** Isolate lifecycle files for concurrent runner identities sharing one OS account/data root. */
export function claudeHookRunnerConfigDir(dataDir: string, runnerId: string): string {
  const runnerKey = createHash("sha256").update(runnerId).digest("hex").slice(0, 24);
  return join(dataDir, "hooks", runnerKey);
}

function assertSafeSessionId(sessionId: string): void {
  if (!SAFE_SESSION_ID.test(sessionId) || sessionId.endsWith(".") ||
      WINDOWS_RESERVED_BASENAME.test(sessionId)) {
    throw new Error("Claude hook session id contains unsupported path characters");
  }
}

export function claudeHookSettingsPath(configDir: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  return join(configDir, `${sessionId}${SETTINGS_SUFFIX}`);
}

export function claudeHookTemplatePath(settingsFile: string): string {
  return settingsFile.endsWith(SETTINGS_SUFFIX)
    ? `${settingsFile.slice(0, -SETTINGS_SUFFIX.length)}${TEMPLATE_SUFFIX}`
    : `${settingsFile}${TEMPLATE_SUFFIX}`;
}

export function claudeHookCircuitPath(settingsFile: string): string {
  return settingsFile.endsWith(SETTINGS_SUFFIX)
    ? `${settingsFile.slice(0, -SETTINGS_SUFFIX.length)}${CIRCUIT_SUFFIX}`
    : `${settingsFile}${CIRCUIT_SUFFIX}`;
}

export function claudeHookTokenPath(settingsFile: string): string {
  return settingsFile.endsWith(SETTINGS_SUFFIX)
    ? `${settingsFile.slice(0, -SETTINGS_SUFFIX.length)}${TOKEN_SUFFIX}`
    : `${settingsFile}${TOKEN_SUFFIX}`;
}

export function claudeHookReadyPath(settingsFile: string): string {
  return settingsFile.endsWith(SETTINGS_SUFFIX)
    ? `${settingsFile.slice(0, -SETTINGS_SUFFIX.length)}${READY_SUFFIX}`
    : `${settingsFile}${READY_SUFFIX}`;
}

function protectedWrite(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
    throw new Error("refusing to replace a symlinked Claude hook file");
  }
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, contents, "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
  try { chmodSync(file, 0o600); } catch { /* Windows ACLs are owned by the runner account */ }
}

function validateInjectedArg(arg: string): void {
  winQuoteArg(arg);
  if (arg.includes("%")) {
    throw new Error(`Claude hook arg contains '%', which cmd.exe expands even inside quotes: ${arg.slice(0, 60)}`);
  }
}

function hookHandler(launch: { command: string; args: string[] }, event: string) {
  const args = [...launch.args, "--hook-event", event];
  validateInjectedArg(launch.command);
  for (const arg of args) validateInjectedArg(arg);
  // PreToolUse may park indefinitely while the SAME hook process waits for a human. Claude's
  // schema requires a numeric timeout. Keep seconds*1000 below Node's signed-32-bit timer ceiling;
  // 2,000,000 seconds is effectively unbounded relative to a live provider-process lifetime.
  return {
    type: "command",
    command: launch.command,
    args,
    timeout: event === "PreToolUse" ? 2_000_000 : 3,
  };
}

export function writeClaudeHookSettings(
  file: string,
  options: {
    sessionId: string;
    launch: { command: string; args: string[] };
    cpHttpUrl: string;
    tokenFile: string;
    askCapable?: boolean;
  },
): void {
  const circuitFile = claudeHookCircuitPath(file);
  const settings = {
    env: {
      MANAGER_TOKEN_FILE: options.tokenFile,
      [POLICY_HOOK_ENV.cpUrl]: options.cpHttpUrl,
      [LEGACY_POLICY_HOOK_ENV.cpUrl]: options.cpHttpUrl,
      [POLICY_HOOK_ENV.sessionId]: options.sessionId,
      [LEGACY_POLICY_HOOK_ENV.sessionId]: options.sessionId,
      [POLICY_HOOK_ENV.settingsFile]: file,
      [LEGACY_POLICY_HOOK_ENV.settingsFile]: file,
      [POLICY_HOOK_ENV.circuitFile]: circuitFile,
      [LEGACY_POLICY_HOOK_ENV.circuitFile]: circuitFile,
      [POLICY_HOOK_ENV.readyFile]: claudeHookReadyPath(file),
      [LEGACY_POLICY_HOOK_ENV.readyFile]: claudeHookReadyPath(file),
      ...(options.askCapable
        ? { [POLICY_HOOK_ENV.askCapable]: "1", [LEGACY_POLICY_HOOK_ENV.askCapable]: "1" }
        : {}),
    },
    hooks: {
      PreToolUse: [{ hooks: [hookHandler(options.launch, "PreToolUse")] }],
      PostToolUse: [{ hooks: [hookHandler(options.launch, "PostToolUse")] }],
      UserPromptSubmit: [{ hooks: [hookHandler(options.launch, "UserPromptSubmit")] }],
    },
  };
  const contents = JSON.stringify(settings, null, 2);
  protectedWrite(claudeHookTemplatePath(file), contents);
  protectedWrite(file, contents);
}

/** Startup cleanup: persisted launch args heal settings on demand, so stale files need not linger. */
export function sweepClaudeHookFiles(configDir = defaultHookConfigDir()): number {
  if (!existsSync(configDir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(configDir, { withFileTypes: true })) {
    if (!entry.isFile() ||
        ![SETTINGS_SUFFIX, TEMPLATE_SUFFIX, CIRCUIT_SUFFIX, CIRCUIT_LOCK_SUFFIX, TOKEN_SUFFIX, READY_SUFFIX]
          .some((suffix) => entry.name.endsWith(suffix))) continue;
    rmSync(join(configDir, entry.name), { force: true });
    removed++;
  }
  return removed;
}

export function removeClaudeHookFiles(sessionId: string, configDir = defaultHookConfigDir()): void {
  try {
    const settings = claudeHookSettingsPath(configDir, sessionId);
    const circuit = claudeHookCircuitPath(settings);
    for (const file of [
      settings,
      claudeHookTemplatePath(settings),
      circuit,
      circuit.replace(CIRCUIT_SUFFIX, CIRCUIT_LOCK_SUFFIX),
      claudeHookTokenPath(settings),
      claudeHookReadyPath(settings),
    ]) {
      rmSync(file, { force: true });
    }
  } catch {
    /* Invalid legacy id or locked file: cleanup is best effort. */
  }
}

function hookTransportSupported(spec: ClaudeHookLaunchSpec): boolean {
  const mode = effectiveClaudePermissionMode(spec.config ?? {});
  const transports = spec.capabilities?.elicitation?.[mode];
  return spec.capabilities?.permissionModes?.includes(mode) === true &&
    transports !== undefined &&
    !transports.includes("stdio-control");
}

function stripHookFromLaunchCapability(spec: ClaudeHookLaunchSpec): void {
  if (!spec.capabilities?.elicitation) return;
  const elicitation = Object.fromEntries(
    Object.entries(spec.capabilities.elicitation).map(([mode, transports]) => {
      const remaining = (transports ?? []).filter((transport) => transport !== "hook");
      return [mode, remaining.length > 0 ? remaining : ["none"]];
    }),
  ) as Record<string, ElicitationTransport[]>;
  spec.capabilities = { ...spec.capabilities, elicitation };
}

function advertiseHookForLaunchCapability(spec: ClaudeHookLaunchSpec): void {
  if (!spec.capabilities?.elicitation) return;
  const permissionModes = new Set(spec.capabilities.permissionModes ?? []);
  const elicitation = Object.fromEntries(
    Object.entries(spec.capabilities.elicitation).map(([mode, transports]) => {
      const remaining: ElicitationTransport[] = (transports ?? [])
        .filter((transport) => transport !== "hook" && transport !== "none");
      if (permissionModes.has(mode) && !remaining.includes("stdio-control")) remaining.push("hook");
      return [mode, remaining.length > 0 ? remaining : ["none"]];
    }),
  ) as Record<string, ElicitationTransport[]>;
  spec.capabilities = { ...spec.capabilities, elicitation };
}

function managedSettingsIndices(args: string[], configDir: string): number[] {
  const expectedDir = resolve(configDir).toLowerCase();
  const indices: number[] = [];
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] !== "--settings") continue;
    const value = args[index + 1]!;
    const name = basename(value);
    if (resolve(dirname(value)).toLowerCase() !== expectedDir ||
        !name.endsWith(SETTINGS_SUFFIX) ||
        !SAFE_SESSION_ID.test(name.slice(0, -SETTINGS_SUFFIX.length))) continue;
    indices.push(index);
  }
  return indices;
}

function selfDescribingManagedSettings(file: string): boolean {
  if (!file.endsWith(SETTINGS_SUFFIX)) return false;
  try {
    const template = JSON.parse(readFileSync(claudeHookTemplatePath(file), "utf8")) as {
      env?: Record<string, unknown>;
      hooks?: Record<string, unknown>;
    };
    const env = template.env;
    return Boolean(
      env &&
      resolve(String(readCompatibleEnv(env, POLICY_HOOK_ENV.settingsFile, LEGACY_POLICY_HOOK_ENV.settingsFile) ?? "")).toLowerCase() === resolve(file).toLowerCase() &&
      resolve(String(readCompatibleEnv(env, POLICY_HOOK_ENV.circuitFile, LEGACY_POLICY_HOOK_ENV.circuitFile) ?? "")).toLowerCase() ===
        resolve(claudeHookCircuitPath(file)).toLowerCase() &&
      resolve(String(readCompatibleEnv(env, POLICY_HOOK_ENV.readyFile, LEGACY_POLICY_HOOK_ENV.readyFile) ?? "")).toLowerCase() ===
        resolve(claudeHookReadyPath(file)).toLowerCase() &&
      resolve(String(env.MANAGER_TOKEN_FILE ?? "")).toLowerCase() ===
        resolve(claudeHookTokenPath(file)).toLowerCase() &&
      template.hooks?.PreToolUse,
    );
  } catch {
    return false;
  }
}

function managedSettingsAskCapable(file: string): boolean {
  try {
    const template = JSON.parse(readFileSync(claudeHookTemplatePath(file), "utf8")) as {
      env?: Record<string, unknown>;
    };
    return readCompatibleEnv(template.env ?? {}, POLICY_HOOK_ENV.askCapable, LEGACY_POLICY_HOOK_ENV.askCapable) === "1";
  } catch {
    return false;
  }
}

function selfDescribingManagedSettingsIndices(args: string[]): number[] {
  const indices: number[] = [];
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] === "--settings" && selfDescribingManagedSettings(args[index + 1]!)) {
      indices.push(index);
    }
  }
  return indices;
}

function removeManagedSettingsArgs(args: string[], configDir: string): number {
  const indices = [...new Set([
    ...managedSettingsIndices(args, configDir),
    ...selfDescribingManagedSettingsIndices(args),
  ])].sort((a, b) => a - b);
  for (const index of indices.reverse()) args.splice(index, 2);
  return indices.length;
}

/**
 * Remove stale managed hook elicitation claims. Phase 3b transports policy decisions but cannot
 * deliver an asynchronous `ask`; Phase 4 will advertise `hook` only when it can truly reach a user.
 */
export function applyClaudeHookCapability(
  agents: AgentDefinition[],
  enabled: boolean,
  log?: (message: string) => void,
): AgentDefinition[] {
  return agents.map((agent) => {
    if (agent.id === "conductor" || agent.driver !== "claude-code" || !agent.capabilities) return agent;
    const native = (agent.context?.kind ?? "native") === "native";
    const withoutManagedHook = Object.fromEntries(
      (agent.capabilities.permissionModes ?? []).map((mode) => {
        const remaining = (agent.capabilities!.elicitation?.[mode] ?? [])
          .filter((transport) => transport !== "hook");
        return [mode, remaining.length > 0 ? remaining : ["none"]];
      }),
    ) as Record<string, ElicitationTransport[]>;
    if (enabled && !native) log?.(`Claude hooks are unavailable for ${agent.id}: only native contexts are supported`);
    return {
      ...agent,
      capabilities: { ...agent.capabilities, elicitation: withoutManagedHook },
    };
  });
}

/**
 * Inject (or heal) the managed settings argument. Disabled, unsupported, WSL, and circuit-open
 * sessions remove only this runner-owned `--settings` pair; any user-supplied settings remain.
 */
export function provisionClaudeHooks(
  spec: ClaudeHookLaunchSpec,
  config: {
    controlPlaneUrl: string;
    controlPlaneProtocolVersion: number | null;
    enabled: boolean;
    allowInsecureTransport?: boolean;
    registerCredential?: (sessionId: string, tokenHash: string) => void;
  },
  log: (message: string) => void,
  host: ClaudeHookHost = defaultClaudeHookHost(),
): void {
  if (spec.agentId === "conductor" || spec.driver !== "claude-code") return;
  assertSafeSessionId(spec.sessionId);
  const expectedFile = claudeHookSettingsPath(host.configDir, spec.sessionId);
  const existingIndex = spec.args.findIndex(
    (arg, index) => arg === "--settings" &&
      resolve(spec.args[index + 1] ?? "").toLowerCase() === resolve(expectedFile).toLowerCase(),
  );
  const persistedFile = existingIndex >= 0 ? spec.args[existingIndex + 1]! : null;
  const staleIndices = [...new Set([
    ...managedSettingsIndices(spec.args, host.configDir),
    ...selfDescribingManagedSettingsIndices(spec.args),
  ])]
    .sort((a, b) => a - b)
    .filter((index) => index !== existingIndex);
  for (const index of staleIndices.reverse()) spec.args.splice(index, 2);
  const hasCurrentSettings = existingIndex >= 0;
  const targetIsHost = !spec.executionTarget || spec.executionTarget.adapter === "host";
  if (!config.enabled ||
      config.controlPlaneProtocolVersion == null ||
      config.controlPlaneProtocolVersion < CLAUDE_HOOK_PROTOCOL_VERSION ||
      (spec.context?.kind ?? "native") !== "native" ||
      !targetIsHost || !hookTransportSupported(spec)) {
    stripHookFromLaunchCapability(spec);
    if (removeManagedSettingsArgs(spec.args, host.configDir) > 0) {
      log(`Claude hooks ${spec.sessionId}: disabled for this launch`);
    }
    if (config.enabled && (spec.context?.kind ?? "native") !== "native") {
      log(`Claude hooks ${spec.sessionId}: WSL/container hook path translation is not supported`);
    } else if (config.enabled && !targetIsHost) {
      log(`Claude hooks ${spec.sessionId}: container/cloud hook injection is not supported`);
    } else if (config.enabled &&
        (config.controlPlaneProtocolVersion == null ||
          config.controlPlaneProtocolVersion < CLAUDE_HOOK_PROTOCOL_VERSION)) {
      log(`Claude hooks ${spec.sessionId}: control plane does not acknowledge protocol ${CLAUDE_HOOK_PROTOCOL_VERSION}`);
    } else if (config.enabled) {
      log(
        `Claude hooks ${spec.sessionId}: permission mode ` +
        `${effectiveClaudePermissionMode(spec.config ?? {})} keeps its existing elicitation transport`,
      );
    }
    return;
  }

  const file = persistedFile ?? claudeHookSettingsPath(host.configDir, spec.sessionId);
  validateInjectedArg(file);
  const circuit = readHookCircuitState(claudeHookCircuitPath(file));
  if (circuit.open && !circuit.credentialRejected) {
    stripHookFromLaunchCapability(spec);
    const managedSettingsExist = selfDescribingManagedSettings(file);
    if (managedSettingsExist) {
      // A rolling downgrade can happen while the circuit is open. Refresh the non-secret v66
      // marker before returning so a later Phase 3b recovery cannot resurrect Phase 4 elicitation.
      writeClaudeHookSettings(file, {
        sessionId: spec.sessionId,
        launch: runnerReentryCommand(host, "--policy-hook"),
        cpHttpUrl: deriveCpHttpUrl(config.controlPlaneUrl, config.allowInsecureTransport),
        tokenFile: claudeHookTokenPath(file),
        askCapable: config.controlPlaneProtocolVersion >= 66,
      });
    }
    if (!hasCurrentSettings && managedSettingsExist) {
      spec.args.push("--settings", file);
    }
    log(`Claude hooks ${spec.sessionId}: circuit is open; the driver will retry after cooldown`);
    return;
  }

  const tokenFile = claudeHookTokenPath(file);
  let token = "";
  try {
    if (existsSync(tokenFile) && !lstatSync(tokenFile).isSymbolicLink()) {
      const existing = readFileSync(tokenFile, "utf8");
      if (POLICY_HOOK_CREDENTIAL.test(existing)) token = existing;
    }
  } catch {
    /* A fresh independently scoped credential replaces an unreadable/corrupt prior file. */
  }
  if (!token) {
    token = `${POLICY_HOOK_CREDENTIAL_PREFIX}${randomBytes(32).toString("base64url")}`;
    protectedWrite(tokenFile, token);
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");
  let credentialReady = false;
  try {
    credentialReady = readFileSync(claudeHookReadyPath(file), "utf8").trim() === tokenHash;
  } catch {
    /* A new or rotated credential remains fenced until the control plane acknowledges it. */
  }
  if (!credentialReady) rmSync(claudeHookReadyPath(file), { force: true });
  config.registerCredential?.(spec.sessionId, tokenHash);
  writeClaudeHookSettings(file, {
    sessionId: spec.sessionId,
    launch: runnerReentryCommand(host, "--policy-hook"),
    cpHttpUrl: deriveCpHttpUrl(config.controlPlaneUrl, config.allowInsecureTransport),
    tokenFile,
    askCapable: config.controlPlaneProtocolVersion >= 66,
  });
  if (!hasCurrentSettings) {
    validateInjectedArg(file);
    spec.args.push("--settings", file);
    log(`Claude hooks ${spec.sessionId}: policy transport provisioned (${file})`);
  } else {
    log(`Claude hooks ${spec.sessionId}: settings refreshed ${file}`);
  }
  // The catalog remains conservative. Only the session-scoped snapshot claims hook elicitation,
  // and only after both provisioning and the Phase 4 ask protocol fence have succeeded.
  if (config.controlPlaneProtocolVersion >= 66) advertiseHookForLaunchCapability(spec);
  else stripHookFromLaunchCapability(spec);
}

/** Persist the CP acknowledgement that fences the first HTTP hook request after provisioning. */
export function markClaudeHookCredentialReady(
  configDir: string,
  sessionId: string,
  tokenHash: string,
): void {
  if (!/^[0-9a-f]{64}$/u.test(tokenHash)) throw new Error("invalid policy-hook credential hash");
  const settings = claudeHookSettingsPath(configDir, sessionId);
  const circuitFile = claudeHookCircuitPath(settings);
  const circuit = readHookCircuitState(circuitFile);
  if (circuit.credentialRejected) {
    writeHookCircuitState(circuitFile, { consecutiveFailures: 0, open: false });
  }
  protectedWrite(claudeHookReadyPath(settings), tokenHash);
}

/** Explicit rejection disables the managed hook before Claude can issue an unauthenticated call. */
export function markClaudeHookCredentialRejected(
  configDir: string,
  sessionId: string,
  now = Date.now(),
): HookCircuitState {
  const settings = claudeHookSettingsPath(configDir, sessionId);
  rmSync(claudeHookReadyPath(settings), { force: true });
  const state: HookCircuitState = {
    consecutiveFailures: 3,
    open: true,
    openedAt: now,
    credentialRejected: true,
  };
  writeHookCircuitState(claudeHookCircuitPath(settings), state);
  return state;
}

/** Close an expired circuit for one bounded half-open re-probe. */
export function claimExpiredHookCircuitProbe(
  file: string,
  now = Date.now(),
): { state: HookCircuitState; recoveredFrom?: number; probeInProgress: boolean } {
  const snapshot = readHookCircuitState(file);
  if (snapshot.credentialRejected) {
    return { state: snapshot, probeInProgress: false };
  }
  if (!snapshot.open && snapshot.probeStartedAt == null) {
    return { state: snapshot, probeInProgress: false };
  }
  if (snapshot.open && (snapshot.openedAt == null ||
      now - snapshot.openedAt < CLAUDE_HOOK_CIRCUIT_COOLDOWN_MS)) {
    return { state: snapshot, probeInProgress: false };
  }
  let recoveredFrom: number | undefined;
  let probeInProgress = false;
  const state = updateHookCircuitState(file, (prior) => {
    if (prior.probeStartedAt != null) {
      if (now - prior.probeStartedAt < CLAUDE_HOOK_CIRCUIT_COOLDOWN_MS) {
        probeInProgress = true;
        return prior;
      }
      recoveredFrom = prior.openedAt ?? prior.probeStartedAt;
      return {
        consecutiveFailures: 0,
        open: false,
        openedAt: recoveredFrom,
        probeStartedAt: now,
      };
    }
    if (!prior.open || prior.openedAt == null ||
        now - prior.openedAt < CLAUDE_HOOK_CIRCUIT_COOLDOWN_MS) {
      return prior;
    }
    recoveredFrom = prior.openedAt;
    return {
      consecutiveFailures: 0,
      open: false,
      openedAt: prior.openedAt,
      probeStartedAt: now,
    };
  });
  return { state, recoveredFrom, probeInProgress };
}

export interface PreparedClaudeHookArgs {
  args: string[];
  circuitOpen: boolean;
  circuitReprobePending: boolean;
  circuitOpenedAt?: number;
  hookAskCapable: boolean;
  healed: boolean;
}

/** Driver-side exact-path heal and recoverable circuit check before every Claude process spawn. */
export function prepareClaudeHookArgs(args: string[], now = Date.now()): PreparedClaudeHookArgs {
  let index = -1;
  let file = "";
  for (let candidate = 0; candidate < args.length - 1; candidate++) {
    const value = args[candidate + 1]!;
    if (args[candidate] !== "--settings" || !selfDescribingManagedSettings(value)) continue;
    index = candidate;
    file = value;
  }
  if (index < 0) {
    return {
      args: [...args],
      circuitOpen: false,
      circuitReprobePending: false,
      hookAskCapable: false,
      healed: false,
    };
  }
  const hookAskCapable = managedSettingsAskCapable(file);
  const circuit = readHookCircuitState(claudeHookCircuitPath(file));
  const reprobePending = circuit.open && circuit.openedAt != null &&
    now - circuit.openedAt >= CLAUDE_HOOK_CIRCUIT_COOLDOWN_MS;
  if ((circuit.open && !reprobePending) || circuit.probeStartedAt != null) {
    return {
      args: [...args.slice(0, index), ...args.slice(index + 2)],
      circuitOpen: true,
      circuitReprobePending: false,
      ...(circuit.openedAt != null ? { circuitOpenedAt: circuit.openedAt } : {}),
      hookAskCapable,
      healed: false,
    };
  }
  let healed = false;
  if (!existsSync(file)) {
    protectedWrite(file, readFileSync(claudeHookTemplatePath(file), "utf8"));
    healed = true;
  }
  return {
    args: [...args],
    circuitOpen: false,
    circuitReprobePending: reprobePending,
    ...(reprobePending && circuit.openedAt != null ? { circuitOpenedAt: circuit.openedAt } : {}),
    hookAskCapable,
    healed,
  };
}

export function readHookCircuitState(file: string): HookCircuitState {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<HookCircuitState>;
    if (!Number.isInteger(value.consecutiveFailures) || (value.consecutiveFailures ?? -1) < 0 ||
        typeof value.open !== "boolean") {
      return { consecutiveFailures: 0, open: false };
    }
    return {
      consecutiveFailures: value.consecutiveFailures!,
      open: value.open,
      ...(Number.isFinite(value.lastDurationMs) ? { lastDurationMs: value.lastDurationMs } : {}),
      ...(Number.isFinite(value.openedAt) ? { openedAt: value.openedAt } : {}),
      ...(Number.isFinite(value.probeStartedAt) ? { probeStartedAt: value.probeStartedAt } : {}),
      ...(value.credentialRejected === true ? { credentialRejected: true } : {}),
    };
  } catch {
    return { consecutiveFailures: 0, open: false };
  }
}

export function writeHookCircuitState(file: string, state: HookCircuitState): void {
  protectedWrite(file, JSON.stringify(state));
}

/** Serialize the short cross-process circuit read/modify/write performed by per-tool sidecars. */
export function updateHookCircuitState(
  file: string,
  update: (prior: HookCircuitState) => HookCircuitState,
): HookCircuitState {
  const lock = file.endsWith(CIRCUIT_SUFFIX)
    ? `${file.slice(0, -CIRCUIT_SUFFIX.length)}${CIRCUIT_LOCK_SUFFIX}`
    : `${file}${CIRCUIT_LOCK_SUFFIX}`;
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + 250;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lock, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > CLAUDE_HOOK_CIRCUIT_LOCK_STALE_MS) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    const next = update(readHookCircuitState(file));
    writeHookCircuitState(file, next);
    return next;
  } finally {
    closeSync(fd!);
    rmSync(lock, { force: true });
  }
}

export function hookFileMode(file: string): number {
  return statSync(file).mode & 0o777;
}
