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
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentDefinition, ElicitationTransport, SessionLaunchSpec } from "@wollipog/protocol";
import { protectedWrite as protectedFileWrite } from "./protected-file.js";
import {
  MANAGED_WORKTREE_GUARD_MATCHER,
  MANAGED_WORKTREE_GUARD_MODE,
  MANAGED_WORKTREE_GUARD_PROTECTIONS_SUFFIX,
  MANAGED_WORKTREE_GUARD_ABSTRACT_PREFIX,
  MANAGED_WORKTREE_GUARD_SOCKET_FLAG,
  managedWorktreeGuardProtectionsPath,
  managedWorktreeGuardStateMatches,
  readManagedWorktreeGuardProtections,
  sameGuardPath,
  verifyManagedWorktreeGuardLaunch,
  writeManagedWorktreeGuardProtections,
} from "./managed-worktree-guard.js";
import type { ManagedWorktreeProtection } from "./managed-worktree-protection.js";
import {
  codexGuardArgsActive,
  codexGuardCommandString,
  codexGuardConfigOverride,
  codexGuardLaunchArgs,
  codexGuardTrustOverride,
  codexHookTrustVerdict,
  codexHookInventoryProbe,
  codexHookInventoryVerdict,
  codexHookIsolationVerdict,
  codexHookStateDisableOverride,
  readCodexHookInventory,
  withoutCodexGuardArgs,
  withoutCodexHooksFeatureDisable,
  type CodexHookEntry,
} from "./codex-managed-worktree-guard.js";
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
import {
  POLICY_HOOK_RELAY_FLAG,
  POLICY_HOOK_RELAY_KEY_ENV,
  POLICY_HOOK_RELAY_SOCKET_FLAG,
} from "./policy-hook-relay.js";

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
  /**
   * This runner keeps the manager policy hook's credential, acknowledgement, and circuit in its own
   * memory and relays each hook event itself (#1472): a runner that does not sandbox its providers,
   * on Linux, where the session's abstract verdict socket carries the relay. Everywhere else the
   * hook keeps its files, which a runner-owned sandbox grants back to it (#1447).
   */
  managerHookRelay?: boolean;
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

/**
 * Where one session's circuit lives. The file form is shared between the runner and every hook
 * sidecar, hence the lock; the memory form belongs to the runner process alone (#1472), where the
 * event loop already serializes a read-modify-write.
 */
export interface HookCircuitStore {
  read(): HookCircuitState;
  write(state: HookCircuitState): void;
  update(update: (prior: HookCircuitState) => HookCircuitState): HookCircuitState;
}

export function fileHookCircuitStore(file: string): HookCircuitStore {
  return {
    read: () => readHookCircuitState(file),
    write: (state) => writeHookCircuitState(file, state),
    update: (update) => updateHookCircuitState(file, update),
  };
}

function memoryHookCircuitStore(): HookCircuitStore {
  let state: HookCircuitState = { consecutiveFailures: 0, open: false };
  return {
    read: () => ({ ...state }),
    write: (next) => { state = { ...next }; },
    update: (update) => {
      state = { ...update({ ...state }) };
      return { ...state };
    },
  };
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

/** The cross-process lock `updateHookCircuitState` takes around a circuit read-modify-write. */
export function claudeHookCircuitLockPath(circuitFile: string): string {
  return circuitFile.endsWith(CIRCUIT_SUFFIX)
    ? `${circuitFile.slice(0, -CIRCUIT_SUFFIX.length)}${CIRCUIT_LOCK_SUFFIX}`
    : `${circuitFile}${CIRCUIT_LOCK_SUFFIX}`;
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

function hookHandler(
  launch: { command: string; args: string[] },
  event: string,
  relay?: ClaudeManagerHookOptions["relay"],
) {
  const args = [
    ...launch.args,
    "--hook-event", event,
    ...(relay ? [POLICY_HOOK_RELAY_FLAG, ...(relay.socket ? [POLICY_HOOK_RELAY_SOCKET_FLAG, relay.socket] : [])] : []),
  ];
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
function guardHookEntry(
  launch: { command: string; args: string[] },
  protectionsFile: string,
  socketPath?: string,
) {
  // The protections path stays in the command even with a socket: it is what makes the document
  // self-describing (`describeManagedSettings`), and the sidecar never reads it in socket mode.
  const args = [
    ...launch.args,
    "--protections", protectionsFile,
    ...(socketPath ? [MANAGED_WORKTREE_GUARD_SOCKET_FLAG, socketPath] : []),
  ];
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
  /** The runner's verdict socket, for a launch whose sandbox hides the hook state dir (#1336). */
  socketPath?: string;
}

export interface ClaudeManagerHookOptions {
  sessionId: string;
  launch: { command: string; args: string[] };
  cpHttpUrl: string;
  tokenFile: string;
  askCapable?: boolean;
  /**
   * The runner relays this session's hook events (#1472). The sidecar then reads no file at all.
   * `socket` is the session's abstract verdict socket; like the guard's, it goes only into the
   * document the runner holds in memory, never into the one written to disk.
   */
  relay?: { socket?: string };
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
        ...(guard ? [guardHookEntry(guard.launch, guard.protectionsFile, guard.socketPath)] : []),
        ...(manager ? [{ hooks: [hookHandler(manager.launch, "PreToolUse", manager.relay)] }] : []),
      ],
      ...(manager
        ? {
          PostToolUse: [{ hooks: [hookHandler(manager.launch, "PostToolUse", manager.relay)] }],
          UserPromptSubmit: [{ hooks: [hookHandler(manager.launch, "UserPromptSubmit", manager.relay)] }],
        }
        : {}),
    },
  };
  return JSON.stringify(settings, null, 2);
}

/**
 * Write the live settings file, its heal template, and (when a guard is present) the guard-only
 * copy the driver falls back to while the manager hook circuit is open.
 *
 * `preserveGuardState` never touches the guard's protection list: a provisioning call that does
 * not know the live worktree set must neither retire the guard a running provider still consults
 * nor rewrite (and so launder) the list the tamper tripwire compares. With no guard given, the
 * guard-only copy is left alone too.
 */
export function writeClaudeSettingsSet(
  file: string,
  manager: ClaudeManagerHookOptions | null,
  guard: ClaudeGuardHookOptions | null,
  preserveGuardState = false,
): void {
  // A guard that answers from runner memory (#1336 slice 3) keeps its real documents in memory too.
  // What goes to disk is the same document WITHOUT the socket: it keeps every path-keyed mechanism
  // working (the persisted `--settings` argument, self-description, the manager hook's own files),
  // it never discloses the socket name, and if it were ever launched its guard would find no list
  // and refuse every matched call rather than pass one.
  const memoryGuard = guard !== null && guardAnswersFromMemory(guard.socketPath);
  const diskGuard = memoryGuard ? { ...guard, socketPath: undefined } : guard;
  // A relayed manager hook (#1472) follows the same rule: the socket it asks is in the memory-held
  // document only. Launched from disk it would reach no runner and deny every tool call.
  const relayedManager = manager?.relay?.socket !== undefined;
  const diskManager = manager?.relay ? { ...manager, relay: {} } : manager;
  if (guard && diskGuard) {
    if (!preserveGuardState && !memoryGuard) {
      writeManagedWorktreeGuardProtections(guard.protectionsFile, guard.protections);
    }
    protectedWrite(claudeHookGuardPath(file), claudeSettingsDocument(file, null, diskGuard));
  } else if (!preserveGuardState) {
    rmSync(claudeHookGuardPath(file), { force: true });
    rmSync(claudeHookProtectionsPath(file), { force: true });
  }
  // A guard that does not answer from memory is left out of a memory-held document rather than
  // carried into it: its list is a file, and the file form's tripwire and heal belong to the file
  // form. That combination does not arise from the runner's own provisioning, where one abstract
  // socket serves both.
  const documentGuard = memoryGuard ? guard : null;
  if (memoryGuard || relayedManager) {
    memorySettingsDocuments.set(resolve(file), {
      combined: claudeSettingsDocument(file, manager, documentGuard),
      guardOnly: documentGuard ? claudeSettingsDocument(file, null, documentGuard) : null,
    });
  } else if (guard || !preserveGuardState) {
    memorySettingsDocuments.delete(resolve(file));
  }
  const contents = claudeSettingsDocument(file, diskManager ?? null, diskGuard);
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
  guardSockets.delete(sessionId);
  guardMemoryLists.delete(sessionId);
  managerHookMemory.delete(sessionId);
  try {
    const settings = claudeHookSettingsPath(configDir, sessionId);
    memorySettingsDocuments.delete(resolve(settings));
    const circuit = claudeHookCircuitPath(settings);
    for (const file of [
      settings,
      claudeHookTemplatePath(settings),
      circuit,
      claudeHookCircuitLockPath(circuit),
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

/**
 * The runner-owned settings argument this session's launch carries, in the spelling the provider
 * will open, matched exactly as provisioning matches it (resolved, case-folded).
 */
export function runnerSettingsArgument(args: readonly string[], configDir: string, sessionId: string): string | null {
  const expected = resolve(claudeHookSettingsPath(configDir, sessionId)).toLowerCase();
  for (let index = args.length - 2; index >= 0; index--) {
    if (args[index] === "--settings" && resolve(args[index + 1]!).toLowerCase() === expected) return args[index + 1]!;
  }
  return null;
}

/**
 * The verdict socket the guard in this runner-owned settings document answers through, or `null`
 * when it has no guard or a file-mode one (#1336). Read from the heal template, like the rest of
 * the self-description.
 */
export function managedSettingsGuardSocket(file: string): string | null {
  if (describeManagedSettings(file)?.guard !== true) return null;
  try {
    const template = JSON.parse(readFileSync(claudeHookTemplatePath(file), "utf8")) as {
      hooks?: { PreToolUse?: Array<{ hooks?: Array<{ args?: unknown }> }> };
    };
    for (const entry of template.hooks?.PreToolUse ?? []) {
      for (const hook of entry.hooks ?? []) {
        const args = Array.isArray(hook.args) ? hook.args.map(String) : [];
        if (!args.includes(MANAGED_WORKTREE_GUARD_MODE)) continue;
        const index = args.indexOf(MANAGED_WORKTREE_GUARD_SOCKET_FLAG);
        if (index >= 0 && args[index + 1]) return args[index + 1]!;
      }
    }
  } catch {
    /* No readable template: no guard this launch could rely on either. */
  }
  return null;
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
    /**
     * Live runner-owned worktrees for this session. Supplying it — even empty — is what provisions
     * the guard; omitting it provisions none. Only the pre-spawn provisioning (after launch
     * authorization) knows the live set: the `start_session` handlers run BEFORE authorization,
     * which compares the argv against the runner-local catalog exactly, so a guard appended there
     * would reject every ordinary launch as a command mismatch.
     */
    managedWorktreeProtections?: readonly ManagedWorktreeProtection[];
    /**
     * This launch runs ALONGSIDE the session's existing provider instead of being the spawn that
     * provider's state is prepared for — a native TUI (#1337). It may write and refresh the
     * guard, never retire it: the running provider's already-loaded hook reads the protection
     * list on every matched tool call, so removing that list, or stripping the guard from the
     * document its next spawn heals from, is a live regression it cannot recover from on its own.
     */
    concurrentLaunch?: boolean;
    /** Seam for tests: prove the guard sidecar actually refuses before relying on it. */
    verifyGuardLaunch?: typeof verifyManagedWorktreeGuardLaunch;
    /**
     * How the guard sidecar gets its verdict (#1336). Absent: from the protections file, as in
     * provider mode. A path: the launch runs in a runner-owned sandbox that hides the hook state
     * directory, so the sidecar asks this session's verdict socket instead. `null`: the launch is
     * sandboxed but no socket could be established, so no guard is provisioned at all — a
     * file-mode guard there would refuse every matched tool call, and the driver mediates instead.
     * A launch that does not say (a native TUI, which the runner does not sandbox) keeps whatever
     * the session was last provisioned with, so it never downgrades the shared document.
     */
    managedWorktreeGuardSocket?: string | null;
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
  const guardRequested = config.managedWorktreeProtections !== undefined;
  const concurrentLaunch = config.concurrentLaunch === true;
  if (typeof config.managedWorktreeGuardSocket === "string") {
    guardSockets.set(spec.sessionId, config.managedWorktreeGuardSocket);
  } else if (config.managedWorktreeGuardSocket === null) {
    guardSockets.delete(spec.sessionId);
  }
  const socketPath = guardSockets.get(spec.sessionId);
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
  // The one exception: a launch that owns no worktree yet and carries a user-supplied
  // `--settings`. Claude applies only the LAST `--settings`, so a guard there would shadow the
  // user's own deny rules and hooks — newly allowing what their configuration blocks — whenever
  // the guard is the only runner-owned document in play: with manager hooks off, and also while
  // their circuit is open, when a spawn drops to the guard-only copy. That launch keeps the
  // pre-#1303 behaviour (no guard until its next spawn) until user settings can be merged under
  // the runner-owned file.
  const managerHooksBlocked = spec.config?.permissionMode === "orchestrator" ||
    !config.enabled ||
    config.controlPlaneProtocolVersion == null ||
    config.controlPlaneProtocolVersion < CLAUDE_HOOK_PROTOCOL_VERSION ||
    !native || !targetIsHost || !hookTransportSupported(spec);
  const userSettingsWouldBeShadowed = guardRequested && protections.length === 0 &&
    hasUserSettingsArg(spec.args, file);
  if (userSettingsWouldBeShadowed) {
    log(
      `Claude managed worktree guard ${spec.sessionId}: not provisioned while the session owns no ` +
      "managed worktree, because it would shadow the agent's own --settings; a worktree created " +
      "in this turn is protected from the next spawn",
    );
  }
  if (guardRequested && !userSettingsWouldBeShadowed) {
    if (compromisedGuardSessions.has(spec.sessionId)) {
      // The guard's own state was tampered with or could not be kept in step for this session.
      // Mediation (the pre-#1313 behaviour) is the honest fallback; it needs no trusted state.
      log(`Claude managed worktree guard ${spec.sessionId}: guard state was invalidated; this launch is mediated`);
    } else if (!native) {
      log(`Claude managed worktree guard ${spec.sessionId}: WSL/container hook path translation is not supported`);
    } else if (!targetIsHost) {
      log(`Claude managed worktree guard ${spec.sessionId}: container/cloud hook injection is not supported`);
    } else if (config.managedWorktreeGuardSocket === null) {
      log(
        `Claude managed worktree guard ${spec.sessionId}: the sandbox hides the guard's state and ` +
        "its verdict socket is unavailable; this launch is mediated",
      );
    } else {
      const protectionsFile = claudeHookProtectionsPath(file);
      try {
        validateInjectedArg(file);
        validateInjectedArg(protectionsFile);
        if (socketPath) validateInjectedArg(socketPath);
        const candidate: ClaudeGuardHookOptions = {
          launch: runnerReentryCommand(host, MANAGED_WORKTREE_GUARD_MODE),
          protectionsFile,
          protections,
          ...(socketPath ? { socketPath } : {}),
        };
        if (guardAnswersFromMemory(socketPath)) {
          // The list is the runner's own memory: there is no file to tripwire, and none is written.
          guardMemoryLists.set(spec.sessionId, protections.map((entry) => ({ ...entry })));
        } else {
          // Tripwire: compare what is on disk against the digest of what the runner last wrote,
          // BEFORE overwriting it, so tampering is evident rather than silently repaired.
          const baseline = guardStateDigests.get(spec.sessionId);
          if (baseline && existsSync(protectionsFile) &&
              !managedWorktreeGuardStateMatches(protectionsFile, baseline)) {
            poisonClaudeGuardState(spec.sessionId, protectionsFile);
            throw new Error("the protected worktree list was modified outside the runner");
          }
          guardStateDigests.set(
            spec.sessionId,
            writeManagedWorktreeGuardProtections(protectionsFile, protections),
          );
        }
        // The launch has to be PROVEN, not assumed: Claude blocks only on exit code 2, so a
        // sidecar that cannot start would silently wave every command through while the driver
        // stopped mediating on the strength of it.
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
      // A call that does not know the live worktree set (the pre-authorization start_session
      // provisioning) must not retire a guard a running provider still consults: if that restart
      // is rejected, the provider would fail closed on every matched tool. The post-authorization
      // pre-spawn provisioning decides the guard's fate. Neither may a concurrent launch (#1337),
      // which does not replace the running provider at all.
      if (guardRequested && !concurrentLaunch) {
        discardGuardArtifacts(file);
        guardStateDigests.delete(spec.sessionId);
        guardMemoryLists.delete(spec.sessionId);
      }
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
  // A call that does not know the live worktree set rewrites the manager documents below; it must
  // carry an already-declared, still-trusted guard into them (CR-4.1). Otherwise a restart that
  // authorization then rejects leaves the RUNNING driver's next spawn reading a guard-less
  // template, and a worktree created in that turn would go unprotected. Its list is not rewritten.
  // A concurrent launch that could not provision a guard of its own carries the declared one the
  // same way (#1337): it is not the spawn the running provider's state belongs to, so it may not
  // take that provider's guard away from it.
  const preserveGuardState = !guardRequested || (concurrentLaunch && !guard);
  const carriedGuard: ClaudeGuardHookOptions | null = preserveGuardState &&
      !compromisedGuardSessions.has(spec.sessionId) &&
      (guardAnswersFromMemory(socketPath)
        ? memorySettingsDocuments.get(resolve(file))?.guardOnly != null && guardMemoryLists.has(spec.sessionId)
        : describeManagedSettings(file)?.guard === true &&
          guardStatePresent(claudeHookProtectionsPath(file)))
    ? {
      launch: runnerReentryCommand(host, MANAGED_WORKTREE_GUARD_MODE),
      protectionsFile: claudeHookProtectionsPath(file),
      // Never written: `preserveGuardState` leaves the live list exactly as the runner last wrote it.
      protections: [],
      ...(socketPath ? { socketPath } : {}),
    }
    : null;
  // `managerHooksBlocked` already rejected a null/too-old control plane.
  const protocolVersion = config.controlPlaneProtocolVersion ?? 0;
  // Relayed (#1472) whenever this runner relays at all and the session's abstract socket is known.
  // A call that does not know the live worktree set does not know the socket either (the
  // pre-authorization `start_session` provisioning, which precedes the first socket): it keeps the
  // state in memory too, so that no credential is written to disk on the way to a relayed launch.
  // A launch whose socket could not be created or proven keeps the file form, as its guard does.
  const relaySocket = guardAnswersFromMemory(socketPath) ? socketPath : undefined;
  const relayed = host.managerHookRelay === true && (relaySocket !== undefined || !guardRequested)
    ? ensureManagerHookMemory(
      spec.sessionId,
      deriveCpHttpUrl(config.controlPlaneUrl, config.allowInsecureTransport),
      protocolVersion >= 66,
    )
    : undefined;
  if (relayed) {
    // Left by an earlier file-form provisioning: a superseded credential, and a circuit that is no
    // longer consulted. Anything planted there later is simply never read.
    discardManagerHookFiles(file);
  } else {
    managerHookMemory.delete(spec.sessionId);
  }
  const relayOption: Pick<ClaudeManagerHookOptions, "relay"> = relayed
    ? { relay: relaySocket ? { socket: relaySocket } : {} }
    : {};
  const circuit = (relayed?.circuit ?? fileHookCircuitStore(claudeHookCircuitPath(file))).read();
  if (circuit.open && !circuit.credentialRejected) {
    stripHookFromLaunchCapability(spec);
    const managedSettingsExist = relayed ? relayed.provisioned : describeManagedSettings(file)?.manager === true;
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
            ...relayOption,
          }
          : null,
        guard ?? carriedGuard,
        preserveGuardState,
      );
    }
    if (!hasCurrentSettings && (managedSettingsExist || guard)) {
      spec.args.push("--settings", file);
    }
    log(`Claude hooks ${spec.sessionId}: circuit is open; the driver will retry after cooldown`);
    return;
  }

  const tokenFile = claudeHookTokenPath(file);
  if (relayed) {
    // Registered at every provisioning, as the file form does; the acknowledgement arrives as
    // `markClaudeHookCredentialReady` and the relay waits for it before its first request.
    config.registerCredential?.(spec.sessionId, relayed.tokenHash);
    writeClaudeSettingsSet(file, {
      sessionId: spec.sessionId,
      launch: runnerReentryCommand(host, "--policy-hook"),
      cpHttpUrl: relayed.cpHttpUrl,
      tokenFile,
      askCapable: protocolVersion >= 66,
      ...relayOption,
    }, guard ?? carriedGuard, preserveGuardState);
    relayed.provisioned = true;
    if (!hasCurrentSettings) {
      spec.args.push("--settings", file);
      log(`Claude hooks ${spec.sessionId}: policy transport provisioned, relayed by the runner (${file})`);
    } else {
      log(`Claude hooks ${spec.sessionId}: settings refreshed ${file}`);
    }
    if (protocolVersion >= 66) advertiseHookForLaunchCapability(spec);
    else stripHookFromLaunchCapability(spec);
    return;
  }
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
  }, guard ?? carriedGuard, preserveGuardState);
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
  memorySettingsDocuments.delete(resolve(file));
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
/** Sessions whose guard answers through the runner's verdict socket (#1336), and its address. */
const guardSockets = new Map<string, string>();
/**
 * The protection list of every session whose guard answers from runner memory (#1336 slice 3): a
 * launch the runner does not sandbox, asking an abstract-namespace socket. No file holds this list,
 * so nothing a same-user process can reach decides a verdict. A session with no entry has no list,
 * and its socket refuses every call — which is what an invalidated guard means here.
 */
const guardMemoryLists = new Map<string, ManagedWorktreeProtection[]>();
/**
 * The real settings documents of those same launches, keyed by the resolved settings path the
 * persisted `--settings` argument names. `prepareClaudeHookArgs` hands Claude one of them INLINE, so
 * the hook command comes from runner memory as well, and the file at that path is never opened.
 */
const memorySettingsDocuments = new Map<string, { combined: string; guardOnly: string | null }>();

/** An abstract-namespace address: the list and the settings live in runner memory. */
/**
 * The manager policy hook's state for a session whose hook events the runner relays (#1472): what
 * the file form keeps in the token, ready, circuit, and circuit-lock files. Nothing here is ever
 * written to disk, and nothing on disk is read in its place. A runner restart forgets it; the next
 * provisioning mints and registers a fresh credential, exactly as it does after the startup sweep
 * removes the files.
 */
interface ManagerHookMemoryState {
  token: string;
  tokenHash: string;
  /** The control plane acknowledged `tokenHash`; the file form's ready file. */
  ready: boolean;
  circuit: HookCircuitStore;
  /** Authenticates a relay request as coming from this session's provider process tree. */
  relayKey: string;
  cpHttpUrl: string;
  askCapable: boolean;
  /** A settings document carrying the manager hooks was written for this state. */
  provisioned: boolean;
}
const managerHookMemory = new Map<string, ManagerHookMemoryState>();

function ensureManagerHookMemory(sessionId: string, cpHttpUrl: string, askCapable: boolean): ManagerHookMemoryState {
  let state = managerHookMemory.get(sessionId);
  if (!state) {
    const token = `${POLICY_HOOK_CREDENTIAL_PREFIX}${randomBytes(32).toString("base64url")}`;
    state = {
      token,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      ready: false,
      circuit: memoryHookCircuitStore(),
      relayKey: randomBytes(32).toString("base64url"),
      cpHttpUrl,
      askCapable,
      provisioned: false,
    };
    managerHookMemory.set(sessionId, state);
  }
  state.cpHttpUrl = cpHttpUrl;
  state.askCapable = askCapable;
  return state;
}

/** The file form's manager hook state, which a relayed session neither writes nor reads. */
function discardManagerHookFiles(settingsFile: string): void {
  const circuit = claudeHookCircuitPath(settingsFile);
  for (const file of [
    claudeHookTokenPath(settingsFile),
    claudeHookReadyPath(settingsFile),
    circuit,
    claudeHookCircuitLockPath(circuit),
  ]) {
    try {
      rmSync(file, { force: true });
    } catch {
      /* Not an authority either way; a directory planted at the path is left where it is. */
    }
  }
}

function guardAnswersFromMemory(socket: string | undefined): boolean {
  return socket?.startsWith(MANAGED_WORKTREE_GUARD_ABSTRACT_PREFIX) === true;
}

/** Give a memory-mode session its list before the verdict socket is first asked (its self-test). */
export function seedManagedWorktreeGuardMemory(
  sessionId: string,
  protections: readonly ManagedWorktreeProtection[],
): void {
  assertSafeSessionFileId(sessionId);
  guardMemoryLists.set(sessionId, protections.map((entry) => ({ ...entry })));
}

/** The verdict socket's list loader for a memory-mode session. Throwing is a refusal. */
export function managedWorktreeGuardMemoryProtections(sessionId: string): ManagedWorktreeProtection[] {
  const protections = guardMemoryLists.get(sessionId);
  if (!protections || compromisedGuardSessions.has(sessionId)) {
    throw new Error("the runner holds no protected worktree list for this session");
  }
  return protections;
}

/** Testing seam: forget every remembered guard-state digest and compromise marker. */
/** What a relayed hook evaluation runs against, for the request that presents this session's key. */
export interface ManagerHookRelayState {
  sessionId: string;
  cpHttpUrl: string;
  token: string;
  askCapable: boolean;
  circuit: HookCircuitStore;
  credentialReady: () => boolean;
}

/**
 * `null` for a session the runner does not relay for and for a wrong key alike. A request that gets
 * `null` must reach neither the control plane nor the circuit: the socket has no permission bits,
 * and an unauthenticated caller must not be able to open it.
 */
export function managerHookRelayState(sessionId: string, key: string): ManagerHookRelayState | null {
  const state = managerHookMemory.get(sessionId);
  if (!state) return null;
  const presented = createHash("sha256").update(key).digest();
  const expected = createHash("sha256").update(state.relayKey).digest();
  if (!timingSafeEqual(presented, expected)) return null;
  const { token, tokenHash } = state;
  return {
    sessionId,
    cpHttpUrl: state.cpHttpUrl,
    token,
    askCapable: state.askCapable,
    circuit: state.circuit,
    // Read live, and bound to the credential this evaluation presents: a rotation in between must
    // not let the acknowledgement of the new hash vouch for the old token.
    credentialReady: () => {
      const current = managerHookMemory.get(sessionId);
      return current !== undefined && current.ready && current.tokenHash === tokenHash;
    },
  };
}

export function resetClaudeGuardState(): void {
  managerHookMemory.clear();
  guardStateDigests.clear();
  compromisedGuardSessions.clear();
  verifiedGuardLaunches.clear();
  guardSockets.clear();
  guardMemoryLists.clear();
  memorySettingsDocuments.clear();
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
  guardMemoryLists.delete(sessionId);
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
  // Runner memory: nothing outside the runner can have changed it, and a Map write cannot fail. A
  // session can hold both forms for a while (a TUI opened under one, a later launch under the
  // other), and each running provider reads its own, so both are kept in step.
  const inMemory = guardMemoryLists.has(sessionId);
  if (inMemory) guardMemoryLists.set(sessionId, protections.map((entry) => ({ ...entry })));
  const file = claudeHookSessionProtectionsPath(configDir, sessionId);
  // lstat, not exists: a dangling symlink planted where the protection list belongs is a guard
  // that has already been interfered with, not a guard that was never provisioned.
  if (!guardStatePresent(file)) return inMemory ? { state: "refreshed" } : { state: "absent" };
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

export interface CodexGuardProvisioning {
  /** The argv this spawn must use: the override and trust bypass appended when the guard is active. */
  args: string[];
  /** Whether the guard really is in `args`, read back from the argv itself. */
  guardActive: boolean;
  /** Why the guard is not active, worded for the person opening the TUI. */
  reason?: string;
}

/**
 * Provision the managed-worktree guard for a Codex native TUI launch (#1377).
 *
 * Codex's structured protection lives in the driver (`buildCodexTurnParams` and its approval
 * decisions), which a TUI does not run, so this installs the SAME sidecar Claude uses as a Codex
 * `PreToolUse` hook through `-c`, over the SAME per-session protections file — which is why the
 * session store's live refresh (`refreshClaudeGuardProtections`) keeps it in step too, and why the
 * tripwire, the compromise marker, and the launch self-test are shared with Claude's.
 *
 * Called for every Codex TUI launch since #1438, including one whose session owns no runner-created
 * worktree yet: `config.protections` is then empty, the guard holds no opinion beyond its own
 * state, and the live refresh fills the list in when the first worktree appears. Every failure
 * returns an inactive guard with a reason. The caller refuses the TUI when there is a worktree to
 * protect, and otherwise opens it unguarded and remembers that; nothing here decides either.
 */
export async function provisionCodexGuard(
  spec: Pick<SessionLaunchSpec, "sessionId" | "command" | "args" | "env" | "context" | "executionTarget">,
  config: {
    protections: readonly ManagedWorktreeProtection[];
    /** The TUI's working directory, where Codex resolves project-scoped hooks. */
    cwd: string;
    platform?: NodeJS.Platform;
    /** Seam for tests: prove the guard sidecar actually refuses before relying on it. */
    verifyGuardLaunch?: typeof verifyManagedWorktreeGuardLaunch;
    /** Seam for tests: enumerate the launch's effective Codex hooks. */
    readHookInventory?: typeof readCodexHookInventory;
    /**
     * The runner's abstract verdict socket for this session (#1336 slice 3). With it the list lives
     * in runner memory and no protections file is written; without it the file decides, as before.
     */
    guardSocket?: string;
    /**
     * The Orchestrator preset (#1473). Its launch arrives with `--disable hooks`, which would keep
     * the guard out too. That flag is dropped for the guarded argv, every foreign hook the
     * inventory reports is disabled by key for the invocation, and the inventory is read again to
     * prove that the runner's hook is then the ONLY enabled one — trusted user hooks included,
     * which the ordinary rule admits and the preset's isolation does not. A launch that cannot
     * prove it is returned exactly as it arrived, `--disable hooks` and all.
     */
    isolateForeignHooks?: boolean;
  },
  log: (message: string) => void,
  host: ClaudeHookHost = defaultClaudeHookHost(),
): Promise<CodexGuardProvisioning> {
  assertSafeSessionFileId(spec.sessionId);
  // A runner-owned override left in the argv would claim a guard this spawn has not proved.
  const arrived = withoutCodexGuardArgs(spec.args);
  const isolate = config.isolateForeignHooks === true;
  const args = isolate ? withoutCodexHooksFeatureDisable(arrived) : arrived;
  const inactive = (reason: string): CodexGuardProvisioning => {
    log(`Codex managed worktree guard ${spec.sessionId}: ${reason}`);
    return { args: arrived, guardActive: false, reason };
  };
  if (compromisedGuardSessions.has(spec.sessionId)) {
    return inactive("its guard state was invalidated and has not been re-proved");
  }
  if ((spec.context?.kind ?? "native") !== "native") {
    return inactive("WSL/container hook path translation is not supported");
  }
  if (spec.executionTarget && spec.executionTarget.adapter !== "host") {
    return inactive("container/cloud hook injection is not supported");
  }
  // Codex runs a hook command through a POSIX shell's `-lc`; how it runs one on Windows was not
  // measured, and a guard whose quoting is a guess is not a guard.
  if ((config.platform ?? process.platform) === "win32") {
    return inactive("Codex hook injection is not supported on Windows");
  }
  const protectionsFile = claudeHookSessionProtectionsPath(host.configDir, spec.sessionId);
  let override: string;
  let guardCommand: string;
  try {
    const launch = runnerReentryCommand(host, MANAGED_WORKTREE_GUARD_MODE);
    const fromMemory = guardAnswersFromMemory(config.guardSocket);
    // The protections path stays in the command either way: it is what the guard-state veto takes
    // the hook state directory from, and a sidecar given a socket never opens it.
    const hookLaunch = {
      command: launch.command,
      args: [
        ...launch.args,
        "--protections", protectionsFile,
        ...(fromMemory ? [MANAGED_WORKTREE_GUARD_SOCKET_FLAG, config.guardSocket!] : []),
      ],
    };
    override = codexGuardConfigOverride(hookLaunch);
    guardCommand = codexGuardCommandString(hookLaunch);
    if (fromMemory) {
      // Codex's hook command is already argv-only, so with the list in runner memory nothing in
      // the hook state directory decides this launch's verdicts.
      guardMemoryLists.set(spec.sessionId, config.protections.map((entry) => ({ ...entry })));
    } else {
      // A TUI still open from a memory-mode launch keeps asking the socket, so its list stays.
      // Tripwire BEFORE overwriting, exactly as for Claude: tampering is made evident, not repaired.
      const baseline = guardStateDigests.get(spec.sessionId);
      if (baseline && existsSync(protectionsFile) &&
          !managedWorktreeGuardStateMatches(protectionsFile, baseline)) {
        poisonClaudeGuardState(spec.sessionId, protectionsFile);
        return inactive("the protected worktree list was modified outside the runner");
      }
      // Written even if this launch then refuses: a Codex TUI already open for this session loads
      // the same file on every matched tool call, so it is refreshed and never retired here.
      guardStateDigests.set(
        spec.sessionId,
        writeManagedWorktreeGuardProtections(protectionsFile, config.protections),
      );
    }
    // Codex, like Claude, treats a hook that fails to START as a failed hook and runs the call.
    const verdict = verifiedGuardLaunch(
      { launch, protectionsFile, protections: config.protections },
      config.verifyGuardLaunch,
    );
    if (!verdict.ok) return inactive(`the guard's launch self-test failed (${verdict.reason})`);
  } catch (error) {
    return inactive(`the guard could not be provisioned (${(error as Error).message})`);
  }
  // Enumerate with the same flags the TUI will carry. This proves Codex installs the runner's hook
  // in THIS build and decides whether the invocation-wide trust bypass is acceptable at all.
  const readInventory = config.readHookInventory ?? readCodexHookInventory;
  let entries: CodexHookEntry[];
  try {
    entries = await readInventory(codexHookInventoryProbe({ ...spec, args }, config.cwd, override));
  } catch (error) {
    return inactive(`its Codex hook inventory could not be enumerated (${(error as Error).message})`);
  }
  // Trust the runner's own hook by hash (#1499). `--dangerously-bypass-hook-trust` is what a TUI
  // and `codex exec` honour; measured on codex-cli 0.155.1 it does NOTHING on `codex app-server`,
  // where an enabled-but-untrusted hook is skipped without a word. The hash is Codex's own digest
  // of the hook's definition, so it can only come from this first enumeration.
  // A hook Codex never installed has no hash either, and "no content hash" would be the wrong
  // cause to report for it, so presence is judged on its own first and keeps its own message.
  if (!entries.some((entry) => entry.command === guardCommand)) {
    return inactive("Codex did not install the runner's PreToolUse hook");
  }
  const trustOverride = codexGuardTrustOverride(entries, guardCommand);
  if (!trustOverride) {
    return inactive("Codex reported no content hash for the runner's PreToolUse hook, so it cannot be trusted");
  }
  let launchArgs = args;
  if (isolate) {
    // Every enabled hook that is not the runner's is switched off for this invocation, and the
    // result is READ BACK rather than assumed: the override's spelling is what makes it work.
    const foreign = entries.filter((entry) => entry.enabled && entry.command !== guardCommand);
    // A key the override cannot spell (a control character) is a hook that cannot be switched
    // off from argv, so the launch keeps the preset's own flag rather than failing outright.
    if (foreign.length > 0) {
      try {
        launchArgs = [...args, "-c", codexHookStateDisableOverride(foreign.map((entry) => entry.key))];
      } catch (error) {
        return inactive(`its foreign Codex hooks could not be disabled for this launch (${(error as Error).message})`);
      }
    }
  }
  // ONE re-enumeration, carrying everything this launch will carry: the isolation override when
  // there is one, and the trust override always. Both verdicts are then read off the same
  // authoritative inventory, and the isolate path costs no more probes than it did before.
  try {
    entries = await readInventory(codexHookInventoryProbe(
      { ...spec, args: launchArgs }, config.cwd, override, undefined, trustOverride,
    ));
  } catch (error) {
    return inactive(`its Codex hook inventory could not be re-enumerated (${(error as Error).message})`);
  }
  const inventory = isolate
    ? codexHookIsolationVerdict(entries, guardCommand)
    : codexHookInventoryVerdict(entries, guardCommand);
  if (!inventory.ok) return inactive(inventory.reason);
  // The trust override is not taken on faith either: a stale or mistyped hash leaves the hook
  // untrusted, which Codex acts on silently, so the guard would otherwise be claimed and absent.
  const trusted = codexHookTrustVerdict(entries, guardCommand);
  if (!trusted.ok) return inactive(trusted.reason);
  const guarded = codexGuardLaunchArgs(launchArgs, override, trustOverride);
  if (!codexGuardArgsActive(guarded, override, trustOverride)) {
    return inactive("a later hooks.PreToolUse override in the launch arguments would replace the guard");
  }
  log(`Codex managed worktree guard ${spec.sessionId}: provisioned (${protectionsFile})`);
  return { args: guarded, guardActive: true };
}

/** Persist the CP acknowledgement that fences the first HTTP hook request after provisioning. */
export function markClaudeHookCredentialReady(
  configDir: string,
  sessionId: string,
  tokenHash: string,
): void {
  if (!/^[0-9a-f]{64}$/u.test(tokenHash)) throw new Error("invalid policy-hook credential hash");
  const relayed = managerHookMemory.get(sessionId);
  if (relayed) {
    // An acknowledgement of a hash the runner no longer holds (a rotation overtook it) readies
    // nothing; the file form gets the same effect from the sidecar comparing the ready file.
    if (relayed.tokenHash !== tokenHash) return;
    if (relayed.circuit.read().credentialRejected) relayed.circuit.write({ consecutiveFailures: 0, open: false });
    relayed.ready = true;
    return;
  }
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
  const state: HookCircuitState = {
    consecutiveFailures: 3,
    open: true,
    openedAt: now,
    credentialRejected: true,
  };
  const relayed = managerHookMemory.get(sessionId);
  if (relayed) {
    relayed.ready = false;
    relayed.circuit.write(state);
    return state;
  }
  const settings = claudeHookSettingsPath(configDir, sessionId);
  rmSync(claudeHookReadyPath(settings), { force: true });
  writeHookCircuitState(claudeHookCircuitPath(settings), state);
  return state;
}

/** Close an expired circuit for one bounded half-open re-probe. */
export function claimExpiredHookCircuitProbe(
  circuit: string | HookCircuitStore,
  now = Date.now(),
): { state: HookCircuitState; recoveredFrom?: number; probeInProgress: boolean } {
  const store = typeof circuit === "string" ? fileHookCircuitStore(circuit) : circuit;
  const snapshot = store.read();
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
  const state = store.update((prior) => {
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
  /**
   * What this spawn's environment must carry besides the launch's own: the relay key of a session
   * whose manager hook events the runner relays (#1472). It belongs in the environment and never
   * in the argv, which every local user can read.
   */
  env?: Record<string, string>;
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
  if (memorySettingsDocuments.has(resolve(settingsFile))) return guardMemoryLists.has(sessionId);
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
    // A memory-held document is recognised by the runner's own record, not by what is on disk.
    if (args[candidate] !== "--settings" ||
        !(memorySettingsDocuments.has(resolve(value)) || selfDescribingManagedSettings(value))) continue;
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
  const memory = memorySettingsDocuments.get(resolve(file));
  if (memory) return prepareMemorySettingsArgs(args, index, file, memory, now);
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

/**
 * A single argv string on Linux is capped at 128 KiB (`MAX_ARG_STRLEN`); the documents the runner
 * writes are a few KiB. One that would not fit is not launched at all, so the driver mediates.
 */
export const MAX_INLINE_SETTINGS_BYTES = 96 * 1024;

/**
 * The memory-held form of the pre-spawn step (#1336 slice 3).
 *
 * The persisted argv still names the settings PATH, which keeps every path-keyed mechanism intact.
 * For the spawn itself that path is replaced by the document the runner holds, passed inline
 * (`--settings <json>`, measured on claude 2.1.278), so Claude never opens a file in the hook state
 * directory and nothing written there can change the hook command it runs. Nothing is healed,
 * because nothing on disk is launched. The manager hook's circuit chooses between the combined
 * document and the guard-only one. Where the runner relays that hook (#1472) the circuit is in
 * memory as well; the file form's is still read from disk, and both documents carry the guard.
 */
function prepareMemorySettingsArgs(
  args: string[],
  index: number,
  file: string,
  memory: { combined: string; guardOnly: string | null },
  now: number,
): PreparedClaudeHookArgs {
  const guardStateDirectory = dirname(resolve(file));
  // A relayed manager hook (#1472) keeps its circuit in runner memory, so for that session nothing
  // at all is read from disk here, and a circuit file written there selects nothing.
  const relayed = managerHookMemory.get(basename(file).slice(0, -SETTINGS_SUFFIX.length));
  const circuit = (relayed?.circuit ?? fileHookCircuitStore(claudeHookCircuitPath(file))).read();
  const reprobePending = circuit.open && circuit.openedAt != null &&
    now - circuit.openedAt >= CLAUDE_HOOK_CIRCUIT_COOLDOWN_MS;
  const circuitHolds = (circuit.open && !reprobePending) || circuit.probeStartedAt != null;
  const hasGuard = memory.guardOnly !== null;
  const document = circuitHolds ? memory.guardOnly : memory.combined;
  if (document === null) {
    // The manager hooks are out for this spawn and the document carries nothing else.
    return {
      args: [...args.slice(0, index), ...args.slice(index + 2)],
      circuitOpen: true,
      circuitReprobePending: false,
      ...(circuit.openedAt != null ? { circuitOpenedAt: circuit.openedAt } : {}),
      hookAskCapable: false,
      healed: false,
      guardActive: false,
      guardStateDirectory,
    };
  }
  if ((hasGuard && !claudeGuardStateTrusted(file)) ||
      Buffer.byteLength(document, "utf8") > MAX_INLINE_SETTINGS_BYTES) {
    return {
      args: [...args.slice(0, index), ...args.slice(index + 2)],
      circuitOpen: circuit.open,
      circuitReprobePending: false,
      ...(circuit.open && circuit.openedAt != null ? { circuitOpenedAt: circuit.openedAt } : {}),
      hookAskCapable: false,
      healed: false,
      guardActive: false,
      guardStateDirectory,
    };
  }
  let hookAskCapable = false;
  try {
    const env = (JSON.parse(memory.combined) as { env?: Record<string, unknown> }).env ?? {};
    hookAskCapable = readCompatibleEnv(env, POLICY_HOOK_ENV.askCapable, LEGACY_POLICY_HOOK_ENV.askCapable) === "1";
  } catch {
    /* The runner serialized this document itself; an unreadable one simply claims no ask support. */
  }
  return {
    args: [...args.slice(0, index + 1), document, ...args.slice(index + 2)],
    circuitOpen: circuitHolds,
    circuitReprobePending: !circuitHolds && reprobePending,
    ...((circuitHolds || reprobePending) && circuit.openedAt != null ? { circuitOpenedAt: circuit.openedAt } : {}),
    hookAskCapable,
    healed: false,
    guardActive: hasGuard,
    guardStateDirectory,
    // Only a spawn that carries the relayed hooks is handed the key to use them. The state outlives
    // a launch for which the manager hooks were blocked, so the document itself is what is asked.
    ...(relayed && !circuitHolds && document.includes(`"${POLICY_HOOK_RELAY_FLAG}"`)
      ? { env: { [POLICY_HOOK_RELAY_KEY_ENV]: relayed.relayKey } }
      : {}),
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
  const lock = claudeHookCircuitLockPath(file);
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
