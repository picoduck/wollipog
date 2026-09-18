/**
 * Per-session Claude Code hook settings.
 *
 * Settings are injected as a file (never inline JSON) and contain only protected credential-file
 * references. A template beside the live file lets every one-shot, persistent, resume, and fork
 * spawn heal an accidentally deleted settings file without needing a second copy of the token.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentDefinition, ElicitationTransport, SessionLaunchSpec } from "@wollipog/protocol";
import { protectedWrite as protectedFileWrite } from "./protected-file.js";
import {
  MANAGED_WORKTREE_GUARD_MATCHER,
  MANAGED_WORKTREE_GUARD_MODE,
  MANAGED_WORKTREE_GUARD_PROTECTIONS_SUFFIX,
  managedWorktreeGuardProtectionsPath,
  managedWorktreeGuardStateMatches,
  readManagedWorktreeGuardProtections,
  sameGuardPath,
  verifyManagedWorktreeGuardLaunch,
  writeManagedWorktreeGuardProtections,
} from "./managed-worktree-guard.js";
import type { ManagedWorktreeProtection } from "./managed-worktree-protection.js";
import { deriveCpHttpUrl } from "./runner-credential-file.js";
import { effectiveClaudePermissionMode } from "./claude-permission.js";
import {
  defaultRunnerReentryHost,
  runnerReentryCommand,
  type RunnerReentryHost,
} from "./runner-reentry.js";
import { winQuoteArg } from "./spawn.js";
import { readCompatibleEnv, type LegacyEnvironmentWarning } from "./env-compat.js";
import { assertSafeSessionFileId, isSafeSessionFileId } from "./session-file-id.js";

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
/** Guard-only copy of the settings, used whenever the manager hooks must not run (circuit open). */
const GUARD_SUFFIX = ".guard.json";
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

export function claudeHookSettingsPath(configDir: string, sessionId: string): string {
  assertSafeSessionFileId(sessionId);
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

/** Guard-only settings written beside the live file so a circuit-open spawn keeps the veto. */
export function claudeHookGuardPath(settingsFile: string): string {
  return settingsFile.endsWith(SETTINGS_SUFFIX)
    ? `${settingsFile.slice(0, -SETTINGS_SUFFIX.length)}${GUARD_SUFFIX}`
    : `${settingsFile}${GUARD_SUFFIX}`;
}

/** Live protected-worktree set consulted by the managed-worktree guard before every Bash call. */
export function claudeHookProtectionsPath(settingsFile: string): string {
  return managedWorktreeGuardProtectionsPath(settingsFile, SETTINGS_SUFFIX);
}

/** Per-session protections path from the runner's hook config dir (session-manager refreshes it). */
export function claudeHookSessionProtectionsPath(configDir: string, sessionId: string): string {
  return claudeHookProtectionsPath(claudeHookSettingsPath(configDir, sessionId));
}

function protectedWrite(file: string, contents: string): void {
  protectedFileWrite(file, contents, "Claude hook file");
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

/**
 * The managed-worktree guard entry. It carries no credential: the only state it needs is the
 * per-session protections file, passed as an explicit argument AND advertised in `env` (the
 * non-secret marker that makes a guard-only settings file self-describing).
 */
function guardHookEntry(launch: { command: string; args: string[] }, protectionsFile: string) {
  const args = [...launch.args, "--protections", protectionsFile];
  validateInjectedArg(launch.command);
  for (const arg of args) validateInjectedArg(arg);
  return {
    // Bash can retire a worktree behind the runner's back; the file tools can rewrite the guard's
    // own state. Every other tool is outside the veto's vocabulary.
    matcher: MANAGED_WORKTREE_GUARD_MATCHER,
    hooks: [{
      type: "command",
      command: launch.command,
      args,
      // Never parks for a human; a slow guard must not stall the turn but must not be skipped
      // either, so the budget is generous relative to a local file read.
      timeout: 60,
    }],
  };
}

export interface ClaudeGuardHookOptions {
  launch: { command: string; args: string[] };
  protectionsFile: string;
  protections: readonly ManagedWorktreeProtection[];
}

export interface ClaudeManagerHookOptions {
  sessionId: string;
  launch: { command: string; args: string[] };
  cpHttpUrl: string;
  tokenFile: string;
  askCapable?: boolean;
}

/**
 * Build one effective settings document. Claude applies only the LAST `--settings` argument, so
 * the manager policy hooks and the managed-worktree guard must share a single file.
 */
function claudeSettingsDocument(
  file: string,
  manager: ClaudeManagerHookOptions | null,
  guard: ClaudeGuardHookOptions | null,
): string {
  const circuitFile = claudeHookCircuitPath(file);
  const settings = {
    // The guard's protections path is deliberately absent here: `env` is exported into every tool
    // process, and the provider must not be handed the exact path to the guard's own state. The
    // hook command inside this 0600 file carries it instead.
    env: {
      ...(manager
        ? {
          MANAGER_TOKEN_FILE: manager.tokenFile,
          [POLICY_HOOK_ENV.cpUrl]: manager.cpHttpUrl,
          [LEGACY_POLICY_HOOK_ENV.cpUrl]: manager.cpHttpUrl,
          [POLICY_HOOK_ENV.sessionId]: manager.sessionId,
          [LEGACY_POLICY_HOOK_ENV.sessionId]: manager.sessionId,
          [POLICY_HOOK_ENV.settingsFile]: file,
          [LEGACY_POLICY_HOOK_ENV.settingsFile]: file,
          [POLICY_HOOK_ENV.circuitFile]: circuitFile,
          [LEGACY_POLICY_HOOK_ENV.circuitFile]: circuitFile,
          [POLICY_HOOK_ENV.readyFile]: claudeHookReadyPath(file),
          [LEGACY_POLICY_HOOK_ENV.readyFile]: claudeHookReadyPath(file),
          ...(manager.askCapable
            ? { [POLICY_HOOK_ENV.askCapable]: "1", [LEGACY_POLICY_HOOK_ENV.askCapable]: "1" }
            : {}),
        }
        : {}),
    },
    hooks: {
      PreToolUse: [
        // The guard runs first; its refusal is the security property and must not depend on the
        // manager hook being enabled, reachable, or healthy.
        ...(guard ? [guardHookEntry(guard.launch, guard.protectionsFile)] : []),
        ...(manager ? [{ hooks: [hookHandler(manager.launch, "PreToolUse")] }] : []),
      ],
      ...(manager
        ? {
          PostToolUse: [{ hooks: [hookHandler(manager.launch, "PostToolUse")] }],
          UserPromptSubmit: [{ hooks: [hookHandler(manager.launch, "UserPromptSubmit")] }],
        }
        : {}),
    },
  };
  return JSON.stringify(settings, null, 2);
}

/**
 * Write the live settings file, its heal template, and (when a guard is present) the guard-only
 * copy the driver falls back to while the manager hook circuit is open.
 */
export function writeClaudeSettingsSet(
  file: string,
  manager: ClaudeManagerHookOptions | null,
  guard: ClaudeGuardHookOptions | null,
): void {
  if (guard) {
    writeManagedWorktreeGuardProtections(guard.protectionsFile, guard.protections);
    protectedWrite(claudeHookGuardPath(file), claudeSettingsDocument(file, null, guard));
  } else {
    rmSync(claudeHookGuardPath(file), { force: true });
    rmSync(claudeHookProtectionsPath(file), { force: true });
  }
  const contents = claudeSettingsDocument(file, manager, guard);
  protectedWrite(claudeHookTemplatePath(file), contents);
  protectedWrite(file, contents);
}

/** Manager-hook-only settings (no managed-worktree guard). Retained for call sites and tests
 * that provision the policy transport on its own. */
export function writeClaudeHookSettings(
  file: string,
  options: ClaudeManagerHookOptions,
): void {
  writeClaudeSettingsSet(file, options, null);
}

/** Startup cleanup: persisted launch args heal settings on demand, so stale files need not linger. */
export function sweepClaudeHookFiles(configDir = defaultHookConfigDir()): number {
  if (!existsSync(configDir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(configDir, { withFileTypes: true })) {
    if (!entry.isFile() ||
        ![SETTINGS_SUFFIX, TEMPLATE_SUFFIX, CIRCUIT_SUFFIX, CIRCUIT_LOCK_SUFFIX, TOKEN_SUFFIX, READY_SUFFIX,
          GUARD_SUFFIX, MANAGED_WORKTREE_GUARD_PROTECTIONS_SUFFIX]
          .some((suffix) => entry.name.endsWith(suffix))) continue;
    rmSync(join(configDir, entry.name), { force: true });
    removed++;
  }
  return removed;
}

export function removeClaudeHookFiles(sessionId: string, configDir = defaultHookConfigDir()): void {
  guardStateDigests.delete(sessionId);
  compromisedGuardSessions.delete(sessionId);
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
      claudeHookGuardPath(settings),
      claudeHookProtectionsPath(settings),
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
        !isSafeSessionFileId(name.slice(0, -SETTINGS_SUFFIX.length))) continue;
    indices.push(index);
  }
  return indices;
}

/**
 * What a runner-owned settings file declares about itself, read from its heal template. A file
 * may carry the manager policy hooks, the managed-worktree guard, or both.
 */
export interface ManagedSettingsDescription {
  manager: boolean;
  guard: boolean;
}

export function describeManagedSettings(file: string): ManagedSettingsDescription | null {
  if (!file.endsWith(SETTINGS_SUFFIX)) return null;
  let template: { env?: Record<string, unknown>; hooks?: Record<string, unknown> };
  try {
    template = JSON.parse(readFileSync(claudeHookTemplatePath(file), "utf8")) as typeof template;
  } catch {
    return null;
  }
  const env = template.env ?? {};
  if (!template.hooks?.PreToolUse) return null;
  const manager = Boolean(
    sameGuardPath(String(readCompatibleEnv(env, POLICY_HOOK_ENV.settingsFile, LEGACY_POLICY_HOOK_ENV.settingsFile) ?? ""), file) &&
    sameGuardPath(String(readCompatibleEnv(env, POLICY_HOOK_ENV.circuitFile, LEGACY_POLICY_HOOK_ENV.circuitFile) ?? ""), claudeHookCircuitPath(file)) &&
    sameGuardPath(String(readCompatibleEnv(env, POLICY_HOOK_ENV.readyFile, LEGACY_POLICY_HOOK_ENV.readyFile) ?? ""), claudeHookReadyPath(file)) &&
    sameGuardPath(String(env.MANAGER_TOKEN_FILE ?? ""), claudeHookTokenPath(file)),
  );
  const guard = (template.hooks?.PreToolUse as Array<{ hooks?: Array<{ args?: unknown }> }> | undefined)
    ?.some((entry) => entry.hooks?.some((hook) => {
      const args = Array.isArray(hook.args) ? hook.args.map(String) : [];
      const index = args.indexOf("--protections");
      return args.includes(MANAGED_WORKTREE_GUARD_MODE) && index >= 0 &&
        args[index + 1] !== undefined &&
        sameGuardPath(args[index + 1]!, claudeHookProtectionsPath(file));
    })) === true;
  return manager || guard ? { manager, guard } : null;
}

function selfDescribingManagedSettings(file: string): boolean {
  return describeManagedSettings(file) != null;
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
    if (agent.driver !== "claude-code" || !agent.capabilities) return agent;
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
 * Whether a `--settings` other than the runner-owned `file` survives in the launch argv. Stale
 * runner-owned copies have already been removed, so anything left is the user's own.
 */
function hasUserSettingsArg(args: readonly string[], file: string): boolean {
  return args.some((arg, index) =>
    (arg === "--settings" && index + 1 < args.length && !sameGuardPath(args[index + 1]!, file)) ||
    (arg.startsWith("--settings=") && !sameGuardPath(arg.slice("--settings=".length), file)));
}

/**
 * Inject (or heal) the managed settings argument.
 *
 * ONE file carries every runner-owned hook for the spawn, because Claude applies only the LAST
 * `--settings` argument (a later one replaces an earlier one; they do not merge):
 *  - the manager policy hooks, when the feature is enabled and supported for this launch, and
 *  - the managed-worktree guard, whenever it can be provisioned — even while the session owns
 *    no runner-created worktree yet (#1303), and INCLUDING when the manager hooks are disabled,
 *    unsupported for the mode, the Orchestrator preset, or their circuit is open.
 *
 * Disabled, unsupported, WSL, and unguardable sessions remove only this runner-owned `--settings`
 * pair; any user-supplied settings remain. (A user `--settings` that survives is still shadowed
 * by the runner-owned one, exactly as it already was whenever manager hooks were provisioned —
 * see docs/adr/0012.)
 */
export function provisionClaudeHooks(
  spec: ClaudeHookLaunchSpec,
  config: {
    controlPlaneUrl: string;
    controlPlaneProtocolVersion: number | null;
    enabled: boolean;
    allowInsecureTransport?: boolean;
    registerCredential?: (sessionId: string, tokenHash: string) => void;
    /** Live runner-owned worktrees for this session; the guard is provisioned even when empty. */
    managedWorktreeProtections?: readonly ManagedWorktreeProtection[];
    /** Seam for tests: prove the guard sidecar actually refuses before relying on it. */
    verifyGuardLaunch?: typeof verifyManagedWorktreeGuardLaunch;
  },
  log: (message: string) => void,
  host: ClaudeHookHost = defaultClaudeHookHost(),
): void {
  if (spec.driver !== "claude-code") return;
  assertSafeSessionFileId(spec.sessionId);
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
  const native = (spec.context?.kind ?? "native") === "native";
  const file = persistedFile ?? expectedFile;
  const protections = config.managedWorktreeProtections ?? [];

  // "Guard active" is established here, at provisioning time, and is observable in the argv the
  // driver launches: a settings file whose template declares the guard. Anything that prevents
  // that (non-native context, container/cloud target, an unquotable path) leaves the guard off,
  // and the driver keeps mediating the permission mode instead.
  let guard: ClaudeGuardHookOptions | null = null;
  // Provisioned whether or not the session owns a worktree yet (#1303): a session can create its
  // first one part-way through a turn, and outside `default`/`auto` the running CLI offers no
  // other interception point — a guard absent from the process cannot be added until its next
  // spawn. An empty list costs one short-lived process per matched tool call and holds no opinion
  // beyond the guard's own state; the live refresh makes a new worktree protected from the
  // guard's very next invocation.
  //
  // The one exception: a launch that owns no worktree yet, carries a user-supplied `--settings`,
  // and would otherwise get no runner-owned settings at all. Claude applies only the LAST
  // `--settings`, so provisioning there would silently drop the user's own deny rules and hooks —
  // newly allowing what their configuration blocks. That launch keeps the pre-#1303 behaviour (no
  // guard until its next spawn) until user settings can be merged under the runner-owned file.
  const managerHooksBlocked = spec.config?.permissionMode === "orchestrator" ||
    !config.enabled ||
    config.controlPlaneProtocolVersion == null ||
    config.controlPlaneProtocolVersion < CLAUDE_HOOK_PROTOCOL_VERSION ||
    !native || !targetIsHost || !hookTransportSupported(spec);
  const userSettingsWouldBeShadowed = protections.length === 0 && managerHooksBlocked &&
    hasUserSettingsArg(spec.args, file);
  if (userSettingsWouldBeShadowed) {
    log(
      `Claude managed worktree guard ${spec.sessionId}: not provisioned while the session owns no ` +
      "managed worktree, because it would shadow the agent's own --settings; a worktree created " +
      "in this turn is protected from the next spawn",
    );
  }
  if (!userSettingsWouldBeShadowed) {
    if (compromisedGuardSessions.has(spec.sessionId)) {
      // The guard's own state was tampered with or could not be kept in step for this session.
      // Mediation (the pre-#1313 behaviour) is the honest fallback; it needs no trusted state.
      log(`Claude managed worktree guard ${spec.sessionId}: guard state was invalidated; this launch is mediated`);
    } else if (!native) {
      log(`Claude managed worktree guard ${spec.sessionId}: WSL/container hook path translation is not supported`);
    } else if (!targetIsHost) {
      log(`Claude managed worktree guard ${spec.sessionId}: container/cloud hook injection is not supported`);
    } else {
      const protectionsFile = claudeHookProtectionsPath(file);
      try {
        validateInjectedArg(file);
        validateInjectedArg(protectionsFile);
        const candidate: ClaudeGuardHookOptions = {
          launch: runnerReentryCommand(host, MANAGED_WORKTREE_GUARD_MODE),
          protectionsFile,
          protections,
        };
        // Tripwire: compare what is on disk against the digest of what the runner last wrote,
        // BEFORE overwriting it, so tampering is evident rather than silently repaired.
        const baseline = guardStateDigests.get(spec.sessionId);
        if (baseline && existsSync(protectionsFile) &&
            !managedWorktreeGuardStateMatches(protectionsFile, baseline)) {
          poisonClaudeGuardState(spec.sessionId, protectionsFile);
          throw new Error("the protected worktree list was modified outside the runner");
        }
        // The launch has to be PROVEN, not assumed: Claude blocks only on exit code 2, so a
        // sidecar that cannot start would silently wave every command through while the driver
        // stopped mediating on the strength of it.
        guardStateDigests.set(
          spec.sessionId,
          writeManagedWorktreeGuardProtections(protectionsFile, protections),
        );
        const verdict = verifiedGuardLaunch(candidate, config.verifyGuardLaunch);
        if (verdict.ok) guard = candidate;
        else log(`Claude managed worktree guard ${spec.sessionId}: launch self-test failed (${verdict.reason})`);
      } catch (error) {
        guard = null;
        log(`Claude managed worktree guard ${spec.sessionId}: not injectable (${(error as Error).message})`);
      }
    }
  }

  if (managerHooksBlocked) {
    stripHookFromLaunchCapability(spec);
    if (!guard) {
      if (removeManagedSettingsArgs(spec.args, host.configDir) > 0) {
        log(`Claude hooks ${spec.sessionId}: disabled for this launch`);
      }
      discardGuardArtifacts(file);
      guardStateDigests.delete(spec.sessionId);
    } else {
      try {
        writeClaudeSettingsSet(file, null, guard);
        if (!hasCurrentSettings) spec.args.push("--settings", file);
        log(`Claude managed worktree guard ${spec.sessionId}: provisioned without manager hooks (${file})`);
      } catch (error) {
        // A guard that cannot be written must not leave an unprotected native launch behind: drop
        // the runner-owned settings so the driver falls back to mediating the permission mode.
        guard = null;
        removeManagedSettingsArgs(spec.args, host.configDir);
        log(`Claude managed worktree guard ${spec.sessionId}: provisioning failed (${(error as Error).message})`);
      }
    }
    if (config.enabled && !native) {
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

  validateInjectedArg(file);
  // `managerHooksBlocked` already rejected a null/too-old control plane.
  const protocolVersion = config.controlPlaneProtocolVersion ?? 0;
  const circuit = readHookCircuitState(claudeHookCircuitPath(file));
  if (circuit.open && !circuit.credentialRejected) {
    stripHookFromLaunchCapability(spec);
    const managedSettingsExist = describeManagedSettings(file)?.manager === true;
    if (managedSettingsExist || guard) {
      // A rolling downgrade can happen while the circuit is open. Refresh the non-secret v66
      // marker before returning so a later Phase 3b recovery cannot resurrect Phase 4 elicitation.
      // The guard-only copy beside it is what `prepareClaudeHookArgs` launches this spawn with.
      writeClaudeSettingsSet(
        file,
        managedSettingsExist
          ? {
            sessionId: spec.sessionId,
            launch: runnerReentryCommand(host, "--policy-hook"),
            cpHttpUrl: deriveCpHttpUrl(config.controlPlaneUrl, config.allowInsecureTransport),
            tokenFile: claudeHookTokenPath(file),
            askCapable: protocolVersion >= 66,
          }
          : null,
        guard,
      );
    }
    if (!hasCurrentSettings && (managedSettingsExist || guard)) {
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
  writeClaudeSettingsSet(file, {
    sessionId: spec.sessionId,
    launch: runnerReentryCommand(host, "--policy-hook"),
    cpHttpUrl: deriveCpHttpUrl(config.controlPlaneUrl, config.allowInsecureTransport),
    tokenFile,
    askCapable: protocolVersion >= 66,
  }, guard);
  if (!hasCurrentSettings) {
    validateInjectedArg(file);
    spec.args.push("--settings", file);
    log(`Claude hooks ${spec.sessionId}: policy transport provisioned (${file})`);
  } else {
    log(`Claude hooks ${spec.sessionId}: settings refreshed ${file}`);
  }
  // The catalog remains conservative. Only the session-scoped snapshot claims hook elicitation,
  // and only after both provisioning and the Phase 4 ask protocol fence have succeeded.
  if (protocolVersion >= 66) advertiseHookForLaunchCapability(spec);
  else stripHookFromLaunchCapability(spec);
}

/**
 * One self-test per distinct sidecar launch per runner process. The command is identical for every
 * session, and the probe costs a process start.
 *
 * A success is final. A failure can be transient, so it is retried — but only after a cooldown:
 * since #1303 every guardable launch probes, and a sidecar that reliably cannot start would
 * otherwise put a failing process start (up to its whole timeout) in front of every Claude spawn.
 */
export const CLAUDE_GUARD_LAUNCH_RETRY_COOLDOWN_MS = 5 * 60_000;
const verifiedGuardLaunches = new Map<string, {
  verdict: { ok: true } | { ok: false; reason: string };
  at: number;
}>();

function verifiedGuardLaunch(
  guard: ClaudeGuardHookOptions,
  verify: typeof verifyManagedWorktreeGuardLaunch = verifyManagedWorktreeGuardLaunch,
  now: number = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  const key = [guard.launch.command, ...guard.launch.args].join("\u0000");
  const cached = verifiedGuardLaunches.get(key);
  if (cached && (cached.verdict.ok || now - cached.at < CLAUDE_GUARD_LAUNCH_RETRY_COOLDOWN_MS)) {
    return cached.verdict;
  }
  const verdict = verify(guard.launch);
  verifiedGuardLaunches.set(key, { verdict, at: now });
  return verdict;
}

/**
 * Drop a guard this launch does not carry (it cannot carry the hook, or it would shadow the
 * agent's own `--settings` while the session owns no worktree). A guard-only settings file goes
 * with it; a file that also carries the manager hooks is left for the manager path to rewrite.
 */
function discardGuardArtifacts(file: string): void {
  // A protections file can also be left behind by a failed launch self-test, which writes it
  // before the guard is committed to.
  rmSync(claudeHookProtectionsPath(file), { force: true });
  const described = describeManagedSettings(file);
  if (!described?.guard) return;
  rmSync(claudeHookGuardPath(file), { force: true });
  if (!described.manager) {
    rmSync(file, { force: true });
    rmSync(claudeHookTemplatePath(file), { force: true });
  }
}

/* ------------------------------------------------------------------------------------------
 * Guard state ledger.
 *
 * "Guard active" is a runner fact, so the runner remembers the digest of the exact protections
 * document it last wrote and the sessions whose guard it no longer trusts. Both live in memory:
 * a runner restart forgets them, and the next spawn re-provisions and re-proves the guard from
 * scratch, which is the same clean boundary a fresh session gets.
 * --------------------------------------------------------------------------------------- */

const guardStateDigests = new Map<string, string>();
const compromisedGuardSessions = new Set<string>();

/** Testing seam: forget every remembered guard-state digest and compromise marker. */
export function resetClaudeGuardState(): void {
  guardStateDigests.clear();
  compromisedGuardSessions.clear();
  verifiedGuardLaunches.clear();
}

export type ClaudeGuardRefreshOutcome =
  /** No guard is provisioned for this session; nothing to keep in step. */
  | { state: "absent" }
  /** The live protection set was rewritten and remains trusted. */
  | { state: "refreshed" }
  /**
   * The guard is no longer trusted. Its state was removed, so every later invocation fails closed
   * (the provider cannot proceed on stale data), and the next spawn must re-provision and
   * re-prove it — or fall back to mediation.
   */
  | { state: "invalidated"; reason: string }
  /**
   * The guard is no longer trusted AND its state could not be removed, so a running provider
   * would keep trusting a stale list. The caller must stop that provider.
   */
  | { state: "unprotected"; reason: string };

/** Best-effort removal of the live protection list; reports whether the guard is now disarmed. */
function guardStatePresent(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function poisonClaudeGuardState(sessionId: string, file: string): boolean {
  guardStateDigests.delete(sessionId);
  compromisedGuardSessions.add(sessionId);
  try {
    rmSync(file, { force: true });
    return !guardStatePresent(file);
  } catch {
    return false;
  }
}

/**
 * Refresh the live protection set for an ALREADY provisioned guard.
 *
 * The file exists only while a spawn was provisioned with the guard, so this never creates one:
 * a running process that carries no guard cannot be given one, and a file it does not read would
 * only claim a protection nobody enforces. Every guardable launch is provisioned with the guard
 * even while the session owns no worktree (#1303), so a worktree created part-way through a turn
 * is protected from the guard's next invocation. An unguardable launch keeps whatever the driver
 * bound at spawn until its next spawn.
 */
export function refreshClaudeGuardProtections(
  sessionId: string,
  protections: readonly ManagedWorktreeProtection[],
  configDir = defaultHookConfigDir(),
): ClaudeGuardRefreshOutcome {
  if (!isSafeSessionFileId(sessionId)) return { state: "absent" };
  const file = claudeHookSessionProtectionsPath(configDir, sessionId);
  // lstat, not exists: a dangling symlink planted where the protection list belongs is a guard
  // that has already been interfered with, not a guard that was never provisioned.
  if (!guardStatePresent(file)) return { state: "absent" };
  const reasonFor = (reason: string): ClaudeGuardRefreshOutcome =>
    poisonClaudeGuardState(sessionId, file)
      ? { state: "invalidated", reason }
      : { state: "unprotected", reason };
  // Tripwire first: a stale list that someone else wrote must never be re-trusted, and the
  // rewrite below would silently erase the evidence.
  const baseline = guardStateDigests.get(sessionId);
  if (baseline && !managedWorktreeGuardStateMatches(file, baseline)) {
    return reasonFor("the protected worktree list was modified outside the runner");
  }
  // An empty set (the last managed worktree is gone) is written like any other: the running
  // process keeps its guard, which keeps vetoing its own state and protects the next worktree
  // this session creates in the same turn. Retiring it here would fail every later tool call.
  try {
    guardStateDigests.set(sessionId, writeManagedWorktreeGuardProtections(file, protections));
    return { state: "refreshed" };
  } catch (error) {
    return reasonFor(`the protected worktree list could not be updated: ${(error as Error).message}`);
  }
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
  /**
   * The managed-worktree guard is in the settings file this spawn launches with. This is the
   * explicit, testable fact the driver uses to decide whether it still has to mediate the
   * permission mode — never an assumption about protections being present.
   */
  guardActive: boolean;
  /**
   * The runner-owned hook state directory for this spawn, when one is in the launch argv. The
   * driver mirrors the guard's own-state veto on the control channel with it.
   */
  guardStateDirectory?: string;
}

/**
 * Whether the guard behind this settings file may still be relied on for the spawn being prepared.
 *
 * Provisioning proves the guard once per launch spec, but the driver spawns again on its own
 * (every one-shot turn, resume, and persistent-transport restart) without re-provisioning. Each of
 * those spawns has to honor an invalidation that happened in between, and re-run the tripwire:
 * a list that is gone would make the hook block every matched tool, and a list someone else
 * rewrote must not be trusted.
 */
function claudeGuardStateTrusted(settingsFile: string): boolean {
  const sessionId = basename(settingsFile).slice(0, -SETTINGS_SUFFIX.length);
  if (compromisedGuardSessions.has(sessionId)) return false;
  const protectionsFile = claudeHookProtectionsPath(settingsFile);
  const baseline = guardStateDigests.get(sessionId);
  try {
    if (baseline && !managedWorktreeGuardStateMatches(protectionsFile, baseline)) {
      poisonClaudeGuardState(sessionId, protectionsFile);
      return false;
    }
    // Without a baseline (nothing provisioned in this process) the list still has to be a valid
    // document: that is exactly what the hook itself demands before it allows anything. An empty
    // one is valid — the session simply owns no managed worktree yet (#1303).
    readManagedWorktreeGuardProtections(protectionsFile);
    return true;
  } catch {
    return false;
  }
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
      guardActive: false,
    };
  }
  const described = describeManagedSettings(file);
  const hasGuard = described?.guard === true;
  const hookAskCapable = managedSettingsAskCapable(file);
  const circuit = readHookCircuitState(claudeHookCircuitPath(file));
  const reprobePending = circuit.open && circuit.openedAt != null &&
    now - circuit.openedAt >= CLAUDE_HOOK_CIRCUIT_COOLDOWN_MS;
  if (hasGuard && !claudeGuardStateTrusted(file)) {
    // The settings document carries a guard hook that can no longer be relied on. Launching with
    // it would either block every matched tool or trust a foreign list, so the whole document is
    // dropped for this spawn and the driver mediates, exactly as when no guard was provisionable.
    // The manager transport's own state is reported as it is: dropping the document must not read
    // as a recovered circuit, and no reprobe is started by a spawn that carries no hooks.
    return {
      args: [...args.slice(0, index), ...args.slice(index + 2)],
      circuitOpen: circuit.open,
      circuitReprobePending: false,
      ...(circuit.open && circuit.openedAt != null ? { circuitOpenedAt: circuit.openedAt } : {}),
      hookAskCapable: false,
      healed: false,
      guardActive: false,
      guardStateDirectory: dirname(resolve(file)),
    };
  }
  if ((circuit.open && !reprobePending) || circuit.probeStartedAt != null) {
    if (hasGuard) {
      // The manager policy transport is out for this spawn, but the managed-worktree veto is a
      // security property: swap the live file for the guard-only copy and KEEP the argument.
      try {
        protectedWrite(file, readFileSync(claudeHookGuardPath(file), "utf8"));
        return {
          args: [...args],
          circuitOpen: true,
          circuitReprobePending: false,
          ...(circuit.openedAt != null ? { circuitOpenedAt: circuit.openedAt } : {}),
          hookAskCapable,
          healed: false,
          guardActive: true,
          guardStateDirectory: dirname(resolve(file)),
        };
      } catch {
        /* Without a readable guard-only copy the launch drops to the mediated path below. */
      }
    }
    return {
      args: [...args.slice(0, index), ...args.slice(index + 2)],
      circuitOpen: true,
      circuitReprobePending: false,
      ...(circuit.openedAt != null ? { circuitOpenedAt: circuit.openedAt } : {}),
      hookAskCapable,
      healed: false,
      guardActive: false,
      guardStateDirectory: dirname(resolve(file)),
    };
  }
  let healed = false;
  let template: string;
  try {
    template = readFileSync(claudeHookTemplatePath(file), "utf8");
  } catch {
    // No heal template: the settings file cannot be trusted to still carry the guard.
    return {
      args: [...args.slice(0, index), ...args.slice(index + 2)],
      circuitOpen: false,
      circuitReprobePending: reprobePending,
      hookAskCapable,
      healed: false,
      guardActive: false,
      guardStateDirectory: dirname(resolve(file)),
    };
  }
  let live: string | null = null;
  try {
    live = existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch {
    live = null;
  }
  if (live === null) {
    protectedWrite(file, template);
    healed = true;
  } else if (live !== template) {
    // A previous circuit-open spawn downgraded the live file to the guard-only copy; the template
    // is the authority once the transport is eligible again.
    protectedWrite(file, template);
  }
  return {
    args: [...args],
    circuitOpen: false,
    circuitReprobePending: reprobePending,
    ...(reprobePending && circuit.openedAt != null ? { circuitOpenedAt: circuit.openedAt } : {}),
    hookAskCapable,
    healed,
    guardActive: hasGuard,
    guardStateDirectory: dirname(resolve(file)),
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
