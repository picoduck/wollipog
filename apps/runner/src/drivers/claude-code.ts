/**
 * ClaudeCodeDriver — drives the native `claude` CLI in streaming print mode.
 * This is what makes a Pro/Max SUBSCRIPTION work (no Console API key): `claude -p`
 * uses the machine's logged-in Claude Code credentials.
 *
 * Default model: one persistent stream-json process per session, with quiescence-aware idle
 * eviction and a per-session circuit breaker back to one `claude -p --resume` process per turn.
 * Set WOLLIPOG_CLAUDE_PERSISTENT=0 only as an operational opt-out.
 * Permission modes: "default" (ask before every tool) streams the prompt over the CLI's
 * stdio control protocol — which the runner owns — so each request surfaces as Allow/Reject
 * in the UI. "auto" adds --permission-mode auto: a classifier model auto-approves safe
 * actions and blocks risky ones inline (the agent is told and adapts; it does not prompt).
 * "acceptEdits"/"plan"/"bypassPermissions" run non-interactively by a fixed rule — except for a
 * structured Orchestrator, which keeps the control channel in every mode so the routine-operation
 * contract stays reachable (see claudePermissionArgs).
 *
 * See docs/DRIVERS.md §2 for the stream-json → SessionEventPayload mapping.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentQuestion, PlanEntry, PromptImage, SessionConfig } from "@wollipog/protocol";
import { approvalScopeContext } from "../approval-scope.js";
import { BoundedNdjsonBuffer } from "../bounded-ndjson.js";
import { inspectClaudeBackgroundWork, inspectClaudeBackgroundWorkInContext, type ClaudeBackgroundWorkInspection } from "../claude-background-work.js";
import { effectiveClaudePermissionMode } from "../claude-permission.js";
import { prepareClaudeHookArgs } from "../hook-settings.js";
import {
  PLACELESS_CWD,
  commandTargetsGuardState,
  commandTargetsManagedWorktree,
  toolTargetsGuardState,
  type ManagedWorktreeProtection,
} from "../managed-worktree-protection.js";
import { classifyRoutineClaudeOrchestratorPermission } from "../orchestrator-provider-permissions.js";
import { killTree, spawnAgent, terminateDescendantBoundaries, trackPendingKill, type AgentProcess, type SpawnAgentOptions } from "../spawn.js";
import type {
  Driver,
  DriverBackgroundJob,
  DriverBackgroundLaunchType,
  DriverBackgroundJobStopResult,
  DriverBackgroundTerminalJob,
  DriverBackgroundWorkEndResult,
  DriverCallbacks,
  DriverCommandInput,
  DriverOptions,
  DriverSteerInput,
  DriverSteerResult,
  PreparedDriverCommand,
  StopReason,
} from "./driver.js";
import { isProviderAuthenticationFailure } from "./provider-auth-failure.js";
import { SKILL_TOOL_KIND, skillToolTitle } from "./skill-tool.js";
import { readCompatibleEnv, type Environment } from "../env-compat.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export const CLAUDE_PERSISTENT_FLAG = "WOLLIPOG_CLAUDE_PERSISTENT";
export const CLAUDE_PERSISTENT_IDLE_MS = "WOLLIPOG_CLAUDE_PERSISTENT_IDLE_MS";
export const CLAUDE_PENDING_MAX_MS = "WOLLIPOG_CLAUDE_PENDING_MAX_MS";
export const CLAUDE_HANDOFF_WAIT_MAX_MS = "WOLLIPOG_CLAUDE_HANDOFF_WAIT_MAX_MS";
export const LEGACY_CLAUDE_PERSISTENT_FLAG = "MAM_CLAUDE_PERSISTENT";
export const LEGACY_CLAUDE_PERSISTENT_IDLE_MS = "MAM_CLAUDE_PERSISTENT_IDLE_MS";
export const LEGACY_CLAUDE_PENDING_MAX_MS = "MAM_CLAUDE_PENDING_MAX_MS";
const DEFAULT_PERSISTENT_IDLE_MS = 60 * 60_000;
const MIN_PERSISTENT_IDLE_MS = 30_000;
const DEFAULT_PENDING_MAX_MS = 7 * 24 * 60 * 60_000;
/** How long a queued handoff waits on unfinished background work before the runner ends it
 * (#1778). An hour matches the control plane's Stalled mark (`BACKGROUND_JOB_STALL_MS`), is far
 * longer than a CI watch or a subagent normally runs, and is counted from when a prompt began to
 * wait, not from when the job started, so work nobody is waiting on is never ended by it. */
const DEFAULT_HANDOFF_WAIT_MAX_MS = 60 * 60_000;
const MAX_TIMER_MS = 0x7fffffff;
const GRACEFUL_STOP_MS = 5_000;
/** After killTree has had time to deliver its bounded native/WSL escalation, stop waiting for an
 * exit event from a wedged relay. This keeps the per-session retirement barrier finite. */
const FORCE_STOP_WAIT_MS = 6_500;
export const CLAUDE_GRACEFUL_STOP_BUDGET_MS = GRACEFUL_STOP_MS + FORCE_STOP_WAIT_MS;
/** How long a `stop_task` control request may wait for Claude's answer (#1780). Claude answers at
 * once; the bound only keeps a wedged process from holding the caller's request open. */
export const CLAUDE_STOP_TASK_RESPONSE_MS = 10_000;
/** Claude reports the ended task before it answers the control request. If its answer arrives
 * first, the report may still be in flight for this long; after it the job is left as it was. */
export const CLAUDE_STOP_TASK_CONFIRM_MS = 2_000;

interface ClaudeDriverDeps {
  spawn: (opts: SpawnAgentOptions) => AgentProcess;
  kill: (child: AgentProcess) => void;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  trackKill: typeof trackPendingKill;
  terminateDescendants: typeof terminateDescendantBoundaries;
  now: () => number;
  readFile: (path: string) => string;
  inspectBackgroundWork: typeof inspectClaudeBackgroundWorkInContext;
  emitPersistentSettingWarnings: PersistentSettingWarningEmitter;
}

interface PendingBackgroundTask {
  id: string;
  toolUseId?: string;
  startedAt: number;
  outputFile?: string;
  launchType: DriverBackgroundLaunchType;
  parentPersistentTurnId?: number;
  /** True when launch input proves a status-less acknowledgment cannot mean completion. */
  requiresTerminalEvidence?: boolean;
}

interface PendingBackgroundTaskStop {
  /** Set once the provider's own report proves the task ended, and how. */
  ended?: { stopped: boolean; job: DriverBackgroundTerminalJob };
  /** Wakes the waiting stop request when that report arrives. */
  wake?: () => void;
}

interface PersistentTurn {
  id: number;
  origin: "runner" | "provider";
  promptText: string;
  images: PromptImage[];
  done: Promise<StopReason>;
  resolve: (reason: StopReason) => void;
  settled: boolean;
  writeAcknowledged: boolean;
  launchAttempts: number;
  waitingForRetirement?: boolean;
}

interface PendingClaudeSteer {
  submissionId: string;
  providerMessageId: string;
  turnId: number;
  generation: number;
  resolve: (result: DriverSteerResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface UnacknowledgedClaudeSteer {
  turnId: number;
  generation: number;
}

export interface ClaudePersistentSettings {
  enabled: boolean;
  idleMs: number;
  pendingMaxMs: number;
  handoffWaitMaxMs: number;
  warnings: string[];
}

/** A setting introduced after the MAM rename has no legacy name. */
type CompatibleEnvironmentReader = (
  currentName: string,
  legacyName: string | undefined,
  warn: (warning: string) => void,
) => string | undefined;

function readSettingEnv(
  env: Environment,
  currentName: string,
  legacyName: string | undefined,
  warn: (warning: string) => void,
): string | undefined {
  if (legacyName) return readCompatibleEnv(env, currentName, legacyName, warn);
  const value = env[currentName];
  return typeof value === "string" ? value : undefined;
}

function parseLifetimeMs(
  rawValue: string | undefined,
  name: string,
  defaultValue: number,
  minimumPositive: number,
  warnings: string[],
): number {
  if (rawValue == null || rawValue.trim() === "") return defaultValue;
  const raw = Number(rawValue);
  if (raw === 0) return 0;
  if (!Number.isSafeInteger(raw) || raw < minimumPositive) {
    warnings.push(`${name}=${JSON.stringify(rawValue)} was rejected; using ${defaultValue}ms`);
    return defaultValue;
  }
  return raw;
}

function persistentSettings(readEnvironment: CompatibleEnvironmentReader): ClaudePersistentSettings {
  const warnings: string[] = [];
  const warn = (warning: string) => warnings.push(warning);
  const flag = readEnvironment(CLAUDE_PERSISTENT_FLAG, LEGACY_CLAUDE_PERSISTENT_FLAG, warn)?.trim();
  if (flag && flag !== "0" && flag !== "1") {
    warnings.push(`${CLAUDE_PERSISTENT_FLAG}=${JSON.stringify(flag)} is not 0 or 1; persistent mode remains enabled`);
  }
  return {
    enabled: flag !== "0",
    idleMs: parseLifetimeMs(
      readEnvironment(CLAUDE_PERSISTENT_IDLE_MS, LEGACY_CLAUDE_PERSISTENT_IDLE_MS, warn),
      CLAUDE_PERSISTENT_IDLE_MS,
      DEFAULT_PERSISTENT_IDLE_MS,
      MIN_PERSISTENT_IDLE_MS,
      warnings,
    ),
    pendingMaxMs: parseLifetimeMs(
      readEnvironment(CLAUDE_PENDING_MAX_MS, LEGACY_CLAUDE_PENDING_MAX_MS, warn),
      CLAUDE_PENDING_MAX_MS,
      DEFAULT_PENDING_MAX_MS,
      1,
      warnings,
    ),
    handoffWaitMaxMs: parseLifetimeMs(
      readEnvironment(CLAUDE_HANDOFF_WAIT_MAX_MS, undefined, warn),
      CLAUDE_HANDOFF_WAIT_MAX_MS,
      DEFAULT_HANDOFF_WAIT_MAX_MS,
      1,
      warnings,
    ),
    warnings,
  };
}

export function claudePersistentSettings(env: Environment): ClaudePersistentSettings {
  return persistentSettings((currentName, legacyName, warn) =>
    readSettingEnv(env, currentName, legacyName, warn));
}

/** Surface daemon-level legacy lifetime aliases before any session transcript exists. Values are
 * deliberately discarded so startup diagnostics disclose names only. */
export function warnLegacyClaudeLifetimeEnvironment(
  env: Environment,
  warn: (warning: string) => void,
): void {
  for (const [currentName, legacyName] of [
    [CLAUDE_PERSISTENT_FLAG, LEGACY_CLAUDE_PERSISTENT_FLAG],
    [CLAUDE_PERSISTENT_IDLE_MS, LEGACY_CLAUDE_PERSISTENT_IDLE_MS],
    [CLAUDE_PENDING_MAX_MS, LEGACY_CLAUDE_PENDING_MAX_MS],
  ] as const) {
    void readCompatibleEnv(env, currentName, legacyName, warn);
  }
}

/** Per-agent configuration stays authoritative over daemon defaults throughout the alias window. */
export function claudePersistentSettingsForAgent(
  agentEnv: Environment,
  daemonEnv: Environment = process.env,
): ClaudePersistentSettings {
  return persistentSettings((currentName, legacyName, warn) => {
    if (agentEnv[currentName] !== undefined || (legacyName && agentEnv[legacyName] !== undefined)) {
      return readSettingEnv(agentEnv, currentName, legacyName, warn);
    }
    // Keep the raw process.env proxy: its name lookup is case-insensitive on Windows.
    return readSettingEnv(daemonEnv, currentName, legacyName, warn);
  });
}

type PersistentSettingWarningEmitter = (cb: DriverCallbacks, warnings: string[]) => void;

/** A fresh emitter makes warning-cardinality tests independent of ambient process/module state. */
export function createPersistentSettingWarningEmitter(): PersistentSettingWarningEmitter {
  const emittedLegacyEnvironmentWarnings = new Set<string>();
  return (cb, warnings) => {
    for (const warning of warnings) {
      if (warning.includes(" is deprecated; use ")) {
        if (emittedLegacyEnvironmentWarnings.has(warning)) continue;
        emittedLegacyEnvironmentWarnings.add(warning);
      }
      cb.onStderr(warning);
    }
  };
}

const emitPersistentSettingWarnings = createPersistentSettingWarningEmitter();
const ORCHESTRATOR_REPOSITORY_OVERRIDE_ENV = ["GH_REPO", "GH_HOST"] as const;

/**
 * Map a Claude permission mode to CLI flags. Exported for tests.
 * - "default": ask before every tool (stdio control protocol -> Allow/Reject UI).
 * - "auto": the classifier model reviews each action — it auto-approves safe ones and
 *   blocks risky ones inline (the agent is told and adapts). We keep the stdio control
 *   channel open so the headless turn streams and settles gracefully on a block rather
 *   than aborting.
 * - everything else: a fixed-rule mode passed straight through as --permission-mode.
 * - `routineControlChannel` (a structured Orchestrator): the fixed rule is still passed, and the
 *   stdio control channel is added on top of it. The CLI keeps deciding everything its own rule
 *   covers — an `acceptEdits` file edit or a common file command is allowed without ever reaching
 *   the runner — and consults the channel only where a headless fixed-rule turn would otherwise
 *   refuse the call for want of a human ("This command requires approval"). That is the only way
 *   the routine-operation contract can run in those modes; without the channel the classifier is
 *   unreachable and routine coordination is blocked (#1305).
 *
 * `interactive` modes stream the prompt over stdin (to answer approvals). `streamInput`
 * means the prompt is delivered as a stream-json user message rather than plain-text
 * stdin — required whenever there are images, since images ride as content blocks.
 */
export function claudePermissionArgs(
  mode: string,
  hasImages = false,
  routineControlChannel = false,
): { interactive: boolean; streamInput: boolean; args: string[] } {
  if (mode === "default") {
    return { interactive: true, streamInput: true, args: ["--input-format", "stream-json", "--permission-prompt-tool", "stdio"] };
  }
  if (mode === "auto") {
    return {
      interactive: true,
      streamInput: true,
      args: ["--input-format", "stream-json", "--permission-prompt-tool", "stdio", "--permission-mode", "auto"],
    };
  }
  if (routineControlChannel) {
    return {
      interactive: true,
      streamInput: true,
      args: ["--input-format", "stream-json", "--permission-prompt-tool", "stdio", "--permission-mode", mode],
    };
  }
  // Fixed-rule modes normally use plain-text stdin; switch to stream-json input when images
  // are attached so they can be sent as content blocks.
  if (hasImages) {
    return { interactive: false, streamInput: true, args: ["--input-format", "stream-json", "--permission-mode", mode] };
  }
  return { interactive: false, streamInput: false, args: ["--permission-mode", mode] };
}

/** Structured Orchestrators route every Bash ask through the runner's semantic contract. Native
 * TUI launches keep the preset's static rules because no runner control channel exists there. */
export function claudeStructuredOrchestratorArgs(args: readonly string[], strictProjectIsolation: boolean): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    const flag = argument.split("=", 1)[0]!;
    const inlineValue = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : undefined;
    const value = args[index + 1];
    if (strictProjectIsolation && flag === "--permission-mode" && (inlineValue ?? value) === "dontAsk") {
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (flag === "--allowedTools") {
      const allowedTools = inlineValue ?? (value?.startsWith("-") === false ? value : undefined);
      if (typeof allowedTools === "string") {
        const tools = allowedTools.split(",").filter((tool) => !tool.startsWith("Bash("));
        if (tools.length > 0) {
          if (inlineValue === undefined) result.push(argument, tools.join(","));
          else result.push(`${flag}=${tools.join(",")}`);
        }
        if (inlineValue === undefined) index += 1;
      }
      continue;
    }
    result.push(argument);
  }
  return result;
}

/**
 * Two branches, and the guard decides which one applies (issue #1313).
 *
 * With the managed-worktree guard in this spawn's settings, Claude's own `PreToolUse` hook
 * enforces the runner-owned worktree veto for every Bash call in every mode — the classifier
 * cannot override a hook `deny` — so the user's selected mode is launched unchanged.
 *
 * Without it (non-native context, container/cloud target, unwritable settings) the veto can only
 * be seen where Claude consults the runner's stdio control channel, so every non-`plan` mode is
 * still mediated to interactive `default` and the fixed-rule modes are emulated in the driver.
 * That is the fail-safe: never an unprotected native launch.
 */
export function protectedClaudePermissionMode(
  mode: string,
  protectManagedWorktrees: boolean,
  managedWorktreeGuardActive = false,
): string {
  return protectManagedWorktrees && !managedWorktreeGuardActive && mode !== "plan" ? "default" : mode;
}

/**
 * The launched fixed rule a structured Orchestrator supplements with the runner's control channel,
 * or null when no supplement applies — an ordinary session (the mode alone governs it, exactly as
 * the user chose) or an Orchestrator already on a channel mode.
 *
 * Non-null is also the signal for how an unauthorized request must be answered: the CLI consults
 * the channel only for decisions its own rule cannot make, and a headless fixed-rule turn refuses
 * exactly those. So everything the routine-operation contract does not authorize is denied, never
 * turned into an approval card the mode would not have produced.
 */
export function claudeRoutineControlChannelMode(mode: string, orchestrator: boolean): string | null {
  return orchestrator && mode !== "default" && mode !== "auto" ? mode : null;
}

/**
 * Build a stream-json user message carrying text plus base64 image blocks (the
 * Anthropic Messages API content shape, which `claude -p` accepts). Exported for tests.
 */
export function buildClaudeUserMessage(promptText: string, images: PromptImage[], uuid?: string): Json {
  const content: Json[] = [];
  if (promptText) content.push({ type: "text", text: promptText });
  for (const img of images) {
    content.push({ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return { type: "user", message: { role: "user", content }, ...(uuid ? { uuid } : {}) };
}

export function claudeCapabilityError(
  config: SessionConfig,
  images: PromptImage[],
  capabilities: DriverOptions["capabilities"],
  strictProjectIsolation = true,
): string | null {
  if (!capabilities) return null;
  if (config.effort && !capabilities.effortLevels.includes(config.effort)) {
    return `Claude Code effort ${JSON.stringify(config.effort)} was not verified for this installation.`;
  }
  const mode = effectiveClaudePermissionMode(config, strictProjectIsolation);
  if (!(capabilities.permissionModes ?? []).includes(mode)) {
    return `Claude Code permission mode ${JSON.stringify(mode)} was not verified for this installation.`;
  }
  if (images.length && !capabilities.supportsImages) {
    return "Claude Code stream-json image input was not verified for this installation.";
  }
  return null;
}

/** Context occupancy Claude Code itself reports for a request: the prompt it just sent, counting
 * uncached, cache-written, and cache-read input alike. A `<synthetic>` record (an API error
 * rendered as an assistant turn) carries zeros and must not zero the gauge. */
export function claudeContextOccupancy(message: unknown): number | null {
  if (!message || typeof message !== "object") return null;
  const record = message as { model?: unknown; usage?: unknown };
  if (record.model === "<synthetic>") return null;
  const usage = record.usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const part = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const total = part(u.input_tokens) + part(u.cache_creation_input_tokens) + part(u.cache_read_input_tokens);
  return total > 0 ? total : null;
}

/** Strip a bracketed launch option (`[1m]`) so `claude-opus-5[1m]` and `claude-opus-5` compare. */
function withoutLaunchOption(modelId: string): string {
  return modelId.replace(/\[[^\]]+\]$/u, "");
}

/** The context window Claude actually served for the turn's model, from `result.modelUsage`. The
 * map is keyed by provider model id and also lists side models (the Haiku title generator), so
 * the entry is matched to the session's resolved model first, then to the top-level assistant
 * model ignoring its launch option. No match ⇒ unknown; nothing is inferred from a name. */
export function claudeEffectiveContextWindow(
  modelUsage: unknown,
  resolvedModel: string | null,
  turnModel: string | null,
): number | null {
  if (!modelUsage || typeof modelUsage !== "object") return null;
  const entries = Object.entries(modelUsage as Record<string, unknown>);
  const windowOf = (entry: unknown): number | null => {
    const value = entry && typeof entry === "object" ? (entry as { contextWindow?: unknown }).contextWindow : undefined;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  };
  const candidates = [resolvedModel, turnModel].filter((id): id is string => typeof id === "string" && id.length > 0);
  for (const id of candidates) {
    const exact = entries.find(([key]) => key === id);
    if (exact) return windowOf(exact[1]);
  }
  for (const id of candidates) {
    const base = withoutLaunchOption(id);
    const related = entries.filter(([key]) => withoutLaunchOption(key) === base);
    if (related.length === 1) return windowOf(related[0]![1]);
  }
  return null;
}

/** Claude Code accepts any `[1m]` launch option and only learns at the first request that the
 * account cannot use it; the turn then fails with an API 400 whose text names the long-context
 * beta. Only that provider text is evidence: a 400 for any other reason on a `[1m]` model must not
 * be blamed on the window. Name the cause and the way out instead of leaving a bare error. */
export function claudeContextWindowRejection(result: unknown, resolvedModel: string | null): string | null {
  if (!result || typeof result !== "object") return null;
  const record = result as { is_error?: unknown; api_error_status?: unknown; result?: unknown };
  if (record.is_error !== true || record.api_error_status !== 400) return null;
  const detail = typeof record.result === "string" ? record.result.trim() : "";
  if (!/long[- ]context/iu.test(detail)) return null;
  const model = resolvedModel ?? "the selected model";
  return `The provider rejected the 1M context window for ${model}; the turn did not run. ` +
    `Provider response: ${detail} Choose a different Context Window for this model in the composer's ` +
    `model menu, or select another model, before the next turn.`;
}

/** The provider's own account of a turn that ended in an error result. Claude reports a transport
 * or credential failure as a synthetic assistant message plus an error result and nothing else:
 * without this text the turn persists as a prompt with no reply and a zero-token usage record, and
 * the automation that scheduled it settles on a bare stop reason.
 *
 * `result` is the canonical field, and an assistant record the timeline never received is the
 * fallback for an error result carrying no text of its own. Neither may repeat what the reader can
 * already see: on a turn that streamed a partial answer before failing, Claude sets `result` to
 * that same partial answer. The two accumulators are kept apart rather than collapsed into one
 * "did anything stream" flag, so a turn that streams an answer and *then* fails synthetically
 * still surfaces the synthetic record — the only copy of why it failed.
 *
 * The text is returned whole. Truncating here would let a long authentication diagnostic lose the
 * phrase that identifies it while keeping a leading token, so the caller classifies the complete
 * text first and bounds only what it emits. */
/** Static stand-in for an authentication diagnostic whose own words cannot be shown. Sentence case
 * per AGENTS.md: this is a message, not a label. */
export const PROVIDER_AUTHENTICATION_ERROR =
  "The provider rejected this session's credentials and the turn did not run. Sign in again to continue.";

export function claudeErrorResultText(
  result: unknown,
  unshownText: string | null,
  shownText: string | null,
): string | null {
  const record = result && typeof result === "object"
    ? (result as { result?: unknown; subtype?: unknown })
    : null;
  const detail = typeof record?.result === "string" ? record.result.trim() : "";
  if (detail && detail !== (shownText?.trim() ?? "")) return detail;
  const unshown = unshownText?.trim();
  if (unshown) return unshown;
  const subtype = typeof record?.subtype === "string" ? record.subtype : "";
  return subtype ? `The provider ended the turn with '${subtype}' and produced no output.` : null;
}

export class ClaudeCodeDriver implements Driver {
  private readonly preparedCommands = new WeakSet<object>();
  private sessionId: string;
  private firstTurn: boolean;
  private child: AgentProcess | null = null;
  private cwd: string;
  private disposed = false;
  private cancelled = false;
  private config: SessionConfig;
  private readonly deps: ClaudeDriverDeps;
  private readonly descendantOwner = {};
  private readonly persistentRequested: boolean;
  private readonly persistentIdleMs: number;
  private readonly pendingMaxMs: number;
  readonly handoffWaitMaxMs: number;
  /** Tasks this driver ended (#1778). Their task files never get a completion marker, so a receipt
   * read would otherwise report them as unfinished again. */
  private readonly endedBackgroundTaskIds = new Set<string>();
  /** Tasks the runner asked Claude to stop (#1780), by task id. The provider's own `killed` or
   * `stopped` report for one of them is the proof that it ended. */
  private readonly stoppingBackgroundTasks = new Map<string, PendingBackgroundTaskStop>();
  /** Runner-originated control requests awaiting Claude's `control_response`, by request id. */
  private readonly pendingControlResponses = new Map<string, (response: Json | null) => void>();
  private persistentCircuitOpen = false;
  /** Lifetime budget by design: after one recovered acknowledged failure, a second failure in
   * this logical session falls back conservatively even if healthy turns occurred in between. */
  private persistentRecoveryFailures = 0;
  private persistentTransport = false;
  private persistentFingerprint: string | null = null;
  private persistentGeneration = 0;
  /** Claude's total_cost_usd is cumulative within one streaming-input process. */
  private persistentLastCostUsd = 0;
  /** The model on the most recent top-level assistant record; stamped on the turn's usage. Claude
   * records the model per message, and the terminal `result` carries none. */
  private turnModel: string | null = null;
  /** Provider model from the latest `init` (`claude-opus-5[1m]`); keys `result.modelUsage`. */
  private resolvedModel: string | null = null;
  /** Context occupancy after the latest top-level assistant record of the active turn. */
  private turnContextOccupancy: number | null = null;
  /** Text of top-level assistant records the active turn already delivered as `stream_event`
   * deltas. The terminal result repeats it, and re-emitting it would show the reader the same
   * words twice. */
  private turnShownText = "";
  /** Text of top-level assistant records with no deltas — a synthetic record is how Claude reports
   * a transport or credential failure, and this is its only copy. */
  private turnUnshownText = "";
  /** Provider message ids that produced text deltas this turn, so an assistant record can be told
   * apart from a synthetic one by whether its own text ever reached the timeline. */
  private readonly turnStreamedMessageIds = new Set<string>();
  /** Text this turn delivered as deltas that carried no usable provider message id. Such a record
   * cannot be matched by id, so it is matched by its own words instead: an id-less assistant record
   * whose text is part of this was shown, and one whose text is not — a synthetic failure that
   * happens to follow anonymous output — was not. Bounded; past the bound an id-less record is
   * treated as shown, which risks terseness rather than showing the reader the same text twice. */
  private turnAnonymousShownText = "";
  private turnAnonymousShownOverflow = false;
  /** Provider account of why the active turn produced no output, kept for the durable receipt the
   * session manager writes after `prompt()` resolves. */
  private turnErrorText: string | null = null;
  /** Error captured at a runner-owned settlement boundary. An unsolicited provider turn may begin
   * in the same stdout chunk before the runner promise resumes, so the next turn's accumulator
   * cannot be the durable receipt's only source. */
  private settledRunnerTurnErrorText: string | null = null;
  private persistentBuffer: BoundedNdjsonBuffer | null = null;
  /** Monotonic across persistent and one-shot transports so late lifecycle events cannot alias a
   * turn from the transport used before a circuit fallback. */
  private providerTurnSeq = 0;
  private activePersistentTurn: PersistentTurn | null = null;
  private activeOneShotTurnId: number | null = null;
  private readonly pendingSteersByMessage = new Map<string, PendingClaudeSteer>();
  private readonly pendingSteerSubmissions = new Set<string>();
  /** Independent of receipt-promise lifetime: a timeout must not forget that Claude may still
   * consume this written message as an unowned next turn. */
  private readonly unacknowledgedSteerMessages = new Map<string, UnacknowledgedClaudeSteer>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCeilingReached = false;
  private readonly pendingBackgroundTasks = new Map<string, PendingBackgroundTask>();
  /** Restart seeds remain untrusted until this live process re-observes them. */
  private readonly unverifiedBackgroundTaskIds = new Set<string>();
  private initialBackgroundStateEmitted = false;
  private holdWarning: string | null = null;
  private intentionalPersistentStop = false;
  private readonly gracefulStopTimers = new Map<AgentProcess, ReturnType<typeof setTimeout>>();
  private readonly gracefulStopPromises = new Map<AgentProcess, Promise<void>>();
  private readonly gracefulStopForcers = new Map<AgentProcess, () => void>();
  private retiringPersistentTransport: Promise<void> | null = null;
  private retiringPersistentChild: AgentProcess | null = null;
  /** Short-lived zero-cost fork bootstrap processes, reaped with the owning driver. */
  private readonly auxiliaryChildren = new Set<AgentProcess>();
  /** True for the turn when permissionMode === "default" (interactive ask). */
  private interactive = false;
  /** The fixed rule the RUNNING child's argv supplements with the runner's control channel, or null
   * when it carries no supplement. Bound at spawn because the configuration it came from is
   * mutable: a change deferred behind background work leaves this child on its original argv. */
  private launchedRoutineControlChannelMode: string | null = null;
  /** requestId -> the tool input to echo back on allow (stdio control protocol). */
  private readonly pendingApprovals = new Map<string, Json>();
  private readonly pendingAttentionOwners = new Map<string, { owner: string; question: boolean }>();
  /** Claude's message_start id scoped by parent Task. Entries close on message_stop/result, so
   * provider block identity never becomes transcript-lifetime state. */
  private readonly streamingMessageIds = new Map<string, string>();
  /** Whether the active turn delivered assistant text as deltas. A successful result consumes this
   * flag into one content-free completion event; failures and interruptions never do. */
  private streamedAgentResponse = false;
  private hookCircuitReported = false;
  private hookCircuitOpenedAt: number | null = null;
  private managedPermissionMediationReported = false;
  /** Established by the last `preparedBaseArgs()`: the managed-worktree guard hook is in the
   * settings file this spawn launches with, so the runner does NOT have to mediate the mode. */
  private managedWorktreeGuardActive = false;
  private managedWorktreeGuardReason: string | null = null;
  /** Runner-owned hook state directory for this spawn; the provider must not touch it. */
  private managedWorktreeGuardStateDirectory = "";
  /** Also from the last `preparedBaseArgs()`: what the spawn's environment carries for the runner's
   * own hooks (the relayed manager hook's key, #1472). Never part of the persisted launch env. */
  private preparedHookEnv: Record<string, string> = {};
  /** The permission mode the RUNNING child emulates on the worktree veto's behalf, or null when it
   * was launched unmediated. Bound at spawn for the same reason as
   * `launchedRoutineControlChannelMode`: the worktree inventory now changes mid-turn by design
   * (#1303) and the configuration can change behind a deferred child, while the child keeps the
   * argv — and the permission semantics — it was launched with. Recomputing it live would stop
   * emulating a fixed-rule mode the moment a mediated child's last worktree went away, or start
   * emulating one for a child that was launched in that mode natively. */
  private launchedManagedEmulationMode: string | null = null;
  /** A fresh UUID is only a proposed coordinate until Claude confirms it in system/init. */
  private sessionEstablished: boolean;

  constructor(
    private readonly opts: DriverOptions,
    private readonly cb: DriverCallbacks,
    deps: Partial<ClaudeDriverDeps> = {},
  ) {
    this.cwd = opts.cwd;
    this.config = opts.config;
    // Phase 2 resume: reuse the persisted claude session id (→ `--resume` from the first turn);
    // otherwise mint a fresh id (→ `--session-id` on turn 1, `--resume` after).
    this.sessionId = opts.resumeId ?? randomUUID();
    this.firstTurn = opts.resumeId == null;
    this.sessionEstablished = opts.resumeId != null;
    this.deps = {
      spawn: deps.spawn ?? spawnAgent,
      kill: deps.kill ?? killTree,
      setTimer: deps.setTimer ?? setTimeout,
      clearTimer: deps.clearTimer ?? clearTimeout,
      trackKill: deps.trackKill ?? trackPendingKill,
      terminateDescendants: deps.terminateDescendants ?? terminateDescendantBoundaries,
      now: deps.now ?? Date.now,
      readFile: deps.readFile ?? ((path) => readFileSync(path, "utf8")),
      inspectBackgroundWork: deps.inspectBackgroundWork ?? inspectClaudeBackgroundWorkInContext,
      emitPersistentSettingWarnings: deps.emitPersistentSettingWarnings ?? emitPersistentSettingWarnings,
    };
    const persistent = claudePersistentSettingsForAgent(opts.env, process.env);
    this.persistentRequested = persistent.enabled;
    this.persistentIdleMs = persistent.idleMs;
    this.pendingMaxMs = persistent.pendingMaxMs;
    this.handoffWaitMaxMs = persistent.handoffWaitMaxMs;
    for (const id of opts.initialBackgroundTaskIds ?? []) {
      if (id) {
        this.pendingBackgroundTasks.set(id, { id, startedAt: this.deps.now(), launchType: "unknown" });
        this.unverifiedBackgroundTaskIds.add(id);
      }
    }
    this.deps.emitPersistentSettingWarnings(this.cb, persistent.warnings);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  agentSessionId(): string | null {
    return this.sessionEstablished ? this.sessionId : null;
  }

  agentTurnId(): string | null {
    // Claude's CLI forks the current transcript, not an individual provider turn. SessionManager
    // therefore records this stable provider coordinate and exposes only the latest checkpoint.
    return this.firstTurn ? null : this.sessionId;
  }

  lastTurnError(): string | null {
    return this.settledRunnerTurnErrorText ?? this.turnErrorText;
  }

  setConfig(config: SessionConfig): void {
    this.config = config;
  }

  private managedProtections(): ManagedWorktreeProtection[] {
    return this.opts.managedWorktreeProtections?.() ?? [];
  }

  private effectivePermissionMode(): string {
    return effectiveClaudePermissionMode(this.config, this.opts.orchestrator?.strictProjectIsolation !== false);
  }

  /** The mode actually passed to the CLI: managed-worktree protection can replace it, unless the
   * guard hook verified for this spawn already refuses retirement in the selected mode. Read it only
   * after `preparedBaseArgs()`, which is what establishes `managedWorktreeGuardActive`. */
  private launchedPermissionMode(): string {
    return protectedClaudePermissionMode(
      this.effectivePermissionMode(),
      this.managedProtections().length > 0,
      this.managedWorktreeGuardActive,
    );
  }

  /** The supplement the CURRENT configuration would launch with — see
   * claudeRoutineControlChannelMode for what a supplement means for a denied request.
   *
   * A capability overlay that did not verify this installation's approval channel withholds the
   * supplement: the coupled preset is refused for the same reason, and a `--permission-prompt-tool`
   * the installation cannot honor would cost the session its whole fixed-rule launch to buy an
   * authorization it would never receive. Without an overlay there is no gate, as elsewhere.
   *
   * Answer a live request from `launchedRoutineControlChannelMode` instead: a configuration change
   * deferred behind background work, or a managed worktree linked mid-session, moves this value
   * while the running child keeps the argv — and the permission semantics — it was launched with. */
  private routineControlChannelMode(): string | null {
    if (this.opts.capabilities && this.opts.capabilities.supportsApprovals !== true) return null;
    return claudeRoutineControlChannelMode(this.launchedPermissionMode(), this.opts.orchestrator != null);
  }

  /**
   * The guard keeps its protection list in a runner-owned file, and the provider runs as the same
   * OS user, so any tool call that names that directory — read or write — is refused. This is
   * tamper-EVIDENT best effort of the same strength class as the command-text worktree matcher,
   * not an isolation boundary; that belongs at the sandbox (#1302).
   */
  private managedWorktreeGuardStateVeto(toolName: unknown, input: unknown): string | null {
    const directory = this.managedWorktreeGuardStateDirectory;
    if (!directory || typeof toolName !== "string") return null;
    const fileVerdict = toolTargetsGuardState(toolName, input, this.cwd, directory);
    if (fileVerdict === "malformed") {
      return "Wollipog could not read the target path of this tool call, so it was refused.";
    }
    if (fileVerdict) return fileVerdict;
    const command = input && typeof input === "object"
      ? (input as { command?: unknown }).command
      : undefined;
    return toolName === "Bash" && typeof command === "string"
      ? commandTargetsGuardState(command, this.cwd, directory)
      : null;
  }

  /** Whether this spawn still has to route permission decisions through the runner. */
  private mediatesManagedPermissions(protections: readonly ManagedWorktreeProtection[]): boolean {
    return protections.length > 0 && !this.managedWorktreeGuardActive;
  }

  private reportManagedPermissionMediation(mode: string, mediating: boolean): void {
    if (!mediating || this.managedPermissionMediationReported || mode !== "auto") return;
    this.managedPermissionMediationReported = true;
    this.cb.onStderr(
      "Claude automatic permission review is routed through Wollipog while runner-owned worktrees are linked so destructive retirement can be refused; use discard_worktree for cleanup.",
    );
  }

  async initialize(): Promise<void> {
    // Publish launch-time process truth even when discovery did not verify steering. Without an
    // explicit false overlay, a later catalog refresh can make this already-running driver appear
    // steerable even though its immutable launch capabilities still reject every submission.
    this.cb.onSteeringAvailability?.(
      this.opts.capabilities?.supportsSteering === true && this.persistentRequested,
    );
    // Reconcile restart seeds before the first recovery/user turn instead of pinning already
    // completed work until the pending ceiling. Unreadable or oversized ledgers retain the ids.
    if (this.pendingBackgroundTasks.size === 0) return;
    await this.reconcilePendingTaskFilesInContext();
  }

  async newSession(cwd: string): Promise<string> {
    this.cwd = cwd;
    return this.sessionId;
  }

  async forkSession(lastTurnId: string, cwd: string): Promise<string> {
    if (this.disposed) throw new Error("Claude driver is disposed");
    if (this.opts.capabilities?.supportsConversationFork !== true) {
      throw new Error("Claude conversation fork was not verified for this installation");
    }
    if (this.firstTurn || lastTurnId !== this.sessionId) {
      throw new Error("Claude fork source does not match the established session");
    }

    const targetSessionId = randomUUID();
    // /context is a local zero-cost command. It makes Claude persist the fork immediately so the
    // target app session can safely store a real resumable id without running a hidden model turn.
    const args = [
      ...this.preparedBaseArgs(),
      "-p",
      "--resume",
      this.sessionId,
      "--fork-session",
      "--session-id",
      targetSessionId,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "plan",
      "--tools",
      "",
    ];
    let child: AgentProcess;
    try {
      child = this.deps.spawn({
        command: this.opts.command,
        args,
        cwd,
        env: this.childEnv(),
        context: this.opts.context,
        scrubInheritedEnv: [
          "ANTHROPIC_API_KEY",
          CLAUDE_PERSISTENT_FLAG,
          CLAUDE_PERSISTENT_IDLE_MS,
          CLAUDE_PENDING_MAX_MS,
          LEGACY_CLAUDE_PERSISTENT_FLAG,
          LEGACY_CLAUDE_PERSISTENT_IDLE_MS,
          LEGACY_CLAUDE_PENDING_MAX_MS,
          ...(this.opts.orchestrator ? ORCHESTRATOR_REPOSITORY_OVERRIDE_ENV : []),
        ],
        isolation: this.opts.isolation,
        containerAgentLaunch: true,
        cloudAgentLaunch: true,
        descendantMarker: this.opts.descendantMarker,
      });
    } catch (err) {
      throw new Error(`Claude fork failed to spawn: ${(err as Error).message}`);
    }
    this.auxiliaryChildren.add(child);

    return new Promise<string>((resolve, reject) => {
      let initSeen = false;
      let resultSeen = false;
      let settled = false;
      const timer = this.deps.setTimer(() => fail(new Error("Claude fork timed out after 30 seconds")), 30_000);
      timer.unref?.();

      const cleanup = () => {
        this.deps.clearTimer(timer);
        this.auxiliaryChildren.delete(child);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.deps.kill(child);
        reject(err);
      };
      const processLine = (raw: string) => {
        const line = raw.trim();
        if (!line || settled) return;
        let msg: Json;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === "system" && msg.subtype === "init") {
          if (msg.session_id !== targetSessionId) {
            fail(new Error("Claude fork initialized the wrong session id"));
            return;
          }
          initSeen = true;
        } else if (msg.type === "result") {
          if (msg.session_id !== targetSessionId || msg.is_error || msg.subtype !== "success") {
            fail(new Error(`Claude fork failed (${String(msg.subtype ?? "unknown result")})`));
            return;
          }
          if (msg.total_cost_usd !== 0) {
            fail(new Error("Claude fork bootstrap did not confirm zero model cost"));
            return;
          }
          resultSeen = true;
          try {
            child.stdin.end();
          } catch {
            /* exit/error owns completion */
          }
        }
      };
      const stdout = new BoundedNdjsonBuffer(processLine, () => {
        fail(new Error("Claude fork emitted an oversized NDJSON record"));
      });

      child.stdin.on("error", () => {});
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (settled) return;
        stdout.push(chunk);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        const text = String(chunk).trim();
        if (text) this.cb.onStderr(`Claude fork: ${text}`);
      });
      child.on("error", (err: Error) => fail(new Error(`Claude fork spawn error: ${err.message}`)));
      child.on("close", (code) => {
        if (settled) return;
        const trailing = stdout.takeTrailing();
        if (trailing.trim()) processLine(trailing);
        if (settled) return;
        cleanup();
        settled = true;
        if (code === 0 && initSeen && resultSeen) resolve(targetSessionId);
        else reject(new Error(`Claude fork exited before persistence was confirmed (code ${String(code)})`));
      });

      try {
        child.stdin.write(JSON.stringify(buildClaudeUserMessage("/context", [])) + "\n");
      } catch (err) {
        fail(new Error(`Claude fork prompt failed: ${(err as Error).message}`));
      }
    });
  }

  prompt(text: string, images?: PromptImage[], slashCommand?: string): Promise<StopReason> {
    // A disposed driver must never spawn a fresh agent process (a caller racing stop()/restart
    // against an awaited pre-turn step would otherwise launch an invisible rogue turn).
    if (this.disposed) return Promise.resolve("cancelled");
    this.settledRunnerTurnErrorText = null;
    const capabilityError = claudeCapabilityError(
      this.config,
      images ?? [],
      this.opts.capabilities,
      this.opts.orchestrator?.strictProjectIsolation !== false,
    );
    if (capabilityError) {
      this.settledRunnerTurnErrorText = capabilityError;
      this.cb.onEvent({ kind: "error", message: capabilityError });
      return Promise.resolve("refusal");
    }
    if (!this.initialBackgroundStateEmitted && this.pendingBackgroundTasks.size > 0) {
      this.initialBackgroundStateEmitted = true;
      this.pendingWorkChanged();
    }
    if (this.persistentRequested && !this.persistentCircuitOpen) {
      return this.promptPersistent(text, images, slashCommand);
    }
    this.resetTurnEventState();
    return this.promptOneShot(text, images, slashCommand);
  }

  /** Reset fields whose values belong to exactly one provider turn. This happens when a turn
   * actually takes ownership of the stream, not when a runner prompt is queued behind an
   * unsolicited provider turn. Resetting at queue time would erase the provider turn's model,
   * completion, and duplicate-suppression state while its reply is still arriving. */
  private resetTurnEventState(): void {
    // Each turn names its own model: a turn that settles before any assistant record must not
    // inherit the previous turn's, which after a model switch would misattribute it.
    this.turnModel = null;
    this.turnContextOccupancy = null;
    this.turnShownText = "";
    this.turnUnshownText = "";
    this.turnStreamedMessageIds.clear();
    this.turnAnonymousShownText = "";
    this.turnAnonymousShownOverflow = false;
    this.turnErrorText = null;
  }

  async steer({ submissionId, text, images = [], deadlineAt }: DriverSteerInput): Promise<DriverSteerResult> {
    if (!text && images.length === 0) return { outcome: "rejected", reason: "steering input is empty" };
    if (this.opts.capabilities?.supportsSteering !== true) {
      return { outcome: "rejected", reason: "Claude steering was not verified for this installation" };
    }
    const turn = this.activePersistentTurn;
    const child = this.child;
    const generation = this.persistentGeneration;
    if (!turn || turn.settled || !this.persistentTransport || !child || this.disposed || this.cancelled) {
      return { outcome: "no_active_turn", reason: "Claude has no active persistent provider turn to steer" };
    }
    if (this.pendingSteerSubmissions.has(submissionId)) {
      return { outcome: "rejected", reason: "steering submission is already active" };
    }
    if (!Number.isFinite(deadlineAt) || this.deps.now() >= deadlineAt) {
      return { outcome: "rejected", reason: "Steering submission deadline expired before provider delivery" };
    }

    const providerMessageId = randomUUID();
    return new Promise<DriverSteerResult>((resolve) => {
      const timer = this.deps.setTimer(() => {
        const pending = this.pendingSteersByMessage.get(providerMessageId);
        if (!pending) return;
        this.settleClaudeSteer(pending, {
          outcome: "uncertain",
          reason: "Claude did not acknowledge steering before the submission deadline",
        });
      }, Math.min(MAX_TIMER_MS, Math.max(1, deadlineAt - this.deps.now())));
      timer.unref?.();
      const pending: PendingClaudeSteer = {
        submissionId,
        providerMessageId,
        turnId: turn.id,
        generation,
        resolve,
        timer,
      };
      this.pendingSteersByMessage.set(providerMessageId, pending);
      this.pendingSteerSubmissions.add(submissionId);
      this.unacknowledgedSteerMessages.set(providerMessageId, { turnId: turn.id, generation });

      try {
        child.stdin.write(JSON.stringify(buildClaudeUserMessage(text, images, providerMessageId)) + "\n", (error?: Error | null) => {
          if (!error) return;
          const current = this.pendingSteersByMessage.get(providerMessageId);
          if (!current) return;
          this.settleClaudeSteer(current, {
            outcome: "uncertain",
            reason: `Claude steering transport failed after a possible write: ${error.message}`,
          });
        });
      } catch (error) {
        this.unacknowledgedSteerMessages.delete(providerMessageId);
        this.settleClaudeSteer(pending, {
          outcome: "rejected",
          reason: `Claude steering could not be written: ${(error as Error).message}`,
        });
      }
    });
  }

  prepareCommand(input: DriverCommandInput): PreparedDriverCommand {
    if (input.executionMode !== "passthrough") {
      throw new Error(`Claude Code does not support ${input.executionMode} session commands`);
    }
    if (!input.commandName || /\s/u.test(input.commandName)) {
      throw new Error("invalid Claude Code command name");
    }
    const prepared = Object.freeze({
      commandName: input.commandName,
      argumentText: input.argumentText,
      executionMode: "passthrough" as const,
    }) as PreparedDriverCommand;
    this.preparedCommands.add(prepared);
    return prepared;
  }

  invokeCommand(command: PreparedDriverCommand): Promise<StopReason> {
    if (!this.preparedCommands.delete(command)) {
      throw new Error("session command was not prepared by this Claude Code driver");
    }
    return this.prompt(command.argumentText, [], command.commandName);
  }

  private promptOneShot(text: string, images?: PromptImage[], slashCommand?: string): Promise<StopReason> {
    return new Promise<StopReason>((resolve) => {
      this.cancelled = false;
      this.pendingApprovals.clear();
      this.streamedAgentResponse = false;
      const promptText = slashCommand ? `/${slashCommand}${text ? " " + text : ""}`.trim() : text;
      const imgs = images ?? [];

      const args = [
        ...this.preparedBaseArgs(),
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
      ];
      if (this.firstTurn) args.push("--session-id", this.sessionId);
      else args.push("--resume", this.sessionId);

      const cfg = this.config;
      // "default" is the catalog sentinel for "let the CLI pick" — not a real alias.
      if (cfg.model && cfg.model !== "default") args.push("--model", cfg.model);
      if (cfg.effort) args.push("--effort", cfg.effort);

      // Interactive modes ("default" = ask each tool, "auto" = classifier escalations)
      // stream the prompt in and route permission decisions through the CLI's own stdio
      // control protocol (which the runner already owns, so it works through the WSL bridge
      // — no MCP, no side channel). Non-interactive modes pass --permission-mode and pipe
      // the plain-text prompt over stdin so Windows cmd.exe never has to parse user content.
      const configuredPermissionMode = this.effectivePermissionMode();
      const mediatesManagedPermissions = this.mediatesManagedPermissions(this.managedProtections());
      this.reportManagedPermissionMediation(configuredPermissionMode, mediatesManagedPermissions);
      const routineChannelMode = this.routineControlChannelMode();
      const perm = claudePermissionArgs(
        this.launchedPermissionMode(),
        imgs.length > 0,
        routineChannelMode !== null,
      );
      this.interactive = perm.interactive;
      // A one-shot turn always spawns, so these bindings are always the running child's own.
      this.launchedRoutineControlChannelMode = routineChannelMode;
      this.launchedManagedEmulationMode = mediatesManagedPermissions ? configuredPermissionMode : null;
      args.push(...perm.args);

      // Auth precedence (DRIVERS.md §2.1 + README): an EXPLICITLY-configured ANTHROPIC_API_KEY
      // is a deliberate auth choice and is kept — unless the config also carries a subscription
      // CLAUDE_CODE_OAUTH_TOKEN, which a present API key would silently override (in `-p` the
      // key always wins). A key merely inherited from the daemon's own environment is always
      // scrubbed (scrubInheritedEnv below) — that one is a stray, and it flips billing to the API.
      const env = this.childEnv();

      let child: AgentProcess;
      try {
        child = this.deps.spawn({
          command: this.opts.command,
          args,
          cwd: this.cwd,
          env,
          context: this.opts.context,
          scrubInheritedEnv: [
            "ANTHROPIC_API_KEY",
            CLAUDE_PERSISTENT_FLAG,
            CLAUDE_PERSISTENT_IDLE_MS,
            CLAUDE_PENDING_MAX_MS,
            LEGACY_CLAUDE_PERSISTENT_FLAG,
            LEGACY_CLAUDE_PERSISTENT_IDLE_MS,
            LEGACY_CLAUDE_PENDING_MAX_MS,
            ...(this.opts.orchestrator ? ORCHESTRATOR_REPOSITORY_OVERRIDE_ENV : []),
          ],
          isolation: this.opts.isolation,
          containerAgentLaunch: true,
          cloudAgentLaunch: true,
          descendantOwner: this.descendantOwner,
          descendantMarker: this.opts.descendantMarker,
        });
      } catch (err) {
        this.cb.onEvent({ kind: "error", message: (err as Error).message });
        return resolve("refusal");
      }
      this.child = child;
      const turnId = ++this.providerTurnSeq;
      this.activeOneShotTurnId = turnId;

      let stopReason: StopReason = "end_turn";
      let settled = false;
      const finish = (r: StopReason) => {
        if (settled) return;
        settled = true;
        if (this.activeOneShotTurnId === turnId) this.activeOneShotTurnId = null;
        if (r !== "cancelled") this.preparedBaseArgs();
        // A clean terminal result is fallback establishment evidence for abbreviated streams
        // that omit system/init. Refused/cancelled turns rely on init alone.
        if (r !== "refusal" && r !== "cancelled") this.markSessionEstablished();
        if (r !== "refusal" && r !== "cancelled") this.settleUnverifiedBackgroundTasks();
        this.settledRunnerTurnErrorText = this.turnErrorText;
        resolve(r);
      };

      const processLine = (raw: string) => {
        const line = raw.trim();
        if (!line) return;
        let msg: Json;
        try {
          msg = JSON.parse(line);
        } catch {
          return; // non-JSON noise
        }
        const r = this.handleEvent(msg);
        if (r) {
          stopReason = r;
          if (this.activeOneShotTurnId === turnId) this.activeOneShotTurnId = null;
        }
      };
      const stdout = new BoundedNdjsonBuffer(processLine, () => {
        this.cb.onStderr("discarded oversized NDJSON record from Claude stdout");
      });

      // A write to a dying process (mid-turn control_response, prompt delivery) does NOT throw
      // synchronously — Node emits an async 'error' (EPIPE/ERR_STREAM_DESTROYED) on the stream,
      // which is FATAL to the whole runner process if unhandled. Swallow it; the child 'close'
      // handler owns the failure path. (Same guard jsonrpc.ts and git-ops.ts already carry.)
      child.stdin.on("error", () => {});

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (this.disposed || this.cancelled) return;
        stdout.push(chunk);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (t: string) => {
        if (this.disposed || this.cancelled) return;
        const s = String(t).trim();
        if (s) this.emitStderrOrAuthenticationFailure(s);
      });

      child.on("error", (err: Error) => {
        this.child = null;
        if (this.pendingBackgroundTasks.size > 0) this.markOrphaned("process_exit");
        this.cb.onStderr(`spawn error: ${err.message}`);
        finish("refusal");
      });

      // `close`, not `exit`: the final result frame may still be buffered in stdout
      // after process exit. Close is the boundary after every stdio stream drains.
      child.on("close", (code) => {
        this.child = null;
        // A naturally-exited process can no longer answer its asks — clear them so a stale
        // requestId is never "found" later and phantom-resolved into thin air.
        this.pendingApprovals.clear();
        if (this.disposed || this.cancelled) return finish("cancelled");
        // Flush a trailing partial line — the final `result` event (token_usage +
        // terminal stopReason) can arrive without a trailing newline.
        processLine(stdout.takeTrailing());
        // Successful one-shot recovery gets exactly one chance to re-observe restart seeds.
        // Settle unseen seeds before publishing the dead process's authoritative orphan set;
        // otherwise settleUnverifiedBackgroundTasks() can emit a later, false `running` state.
        if ((!code || code === 0) && stopReason !== "refusal" && stopReason !== "cancelled") {
          this.settleUnverifiedBackgroundTasks();
        }
        if (this.pendingBackgroundTasks.size > 0) this.markOrphaned("process_exit");
        if (code && code !== 0 && !settled) {
          this.cb.onEvent({ kind: "error", message: `claude exited with code ${code}` });
          return finish("refusal");
        }
        finish(stopReason);
      });

      try {
        const accepted = (error?: Error | null) => {
          if (!error) this.cb.onPromptAccepted?.();
        };
        if (perm.streamInput) {
          // Deliver the prompt (and any images) as a stream-json user message. Interactive
          // turns keep stdin OPEN to write control_responses (approvals), closing it on the
          // `result` event; a non-interactive stream-json turn (images only) has no approvals,
          // so close stdin now to start the turn.
          child.stdin.write(JSON.stringify(buildClaudeUserMessage(promptText, imgs)) + "\n", accepted);
          if (!this.interactive) child.stdin.end();
        } else {
          // `claude -p` accepts a plain-text prompt from stdin. This also keeps CR/LF and
          // cmd.exe metacharacters out of argv on Windows; EOF starts the turn immediately.
          child.stdin.end(promptText, accepted);
        }
      } catch {
        /* ignore */
      }
    });
  }

  private promptPersistent(text: string, images?: PromptImage[], slashCommand?: string): Promise<StopReason> {
    const activeTurn = this.activePersistentTurn;
    if (activeTurn?.origin === "provider") {
      // Claude can begin a turn itself after a background-task notification. Preserve FIFO at the
      // provider boundary: only write this real prompt once that turn's own result has arrived.
      return activeTurn.done.then(() => {
        if (this.disposed || this.cancelled) return "cancelled";
        return this.promptPersistent(text, images, slashCommand);
      });
    }
    if (activeTurn) {
      this.cb.onEvent({ kind: "error", message: "Claude persistent transport received overlapping prompts." });
      return Promise.resolve("refusal");
    }
    this.resetTurnEventState();
    this.clearIdleTimer();
    this.cancelled = false;
    this.pendingApprovals.clear();
    this.streamedAgentResponse = false;
    const promptText = slashCommand ? `/${slashCommand}${text ? " " + text : ""}`.trim() : text;
    let resolveTurn!: (reason: StopReason) => void;
    const done = new Promise<StopReason>((resolve) => { resolveTurn = resolve; });
    const turn: PersistentTurn = {
      id: ++this.providerTurnSeq,
      origin: "runner",
      promptText,
      images: images ?? [],
      done,
      resolve: resolveTurn,
      settled: false,
      writeAcknowledged: false,
      launchAttempts: 0,
    };
    this.activePersistentTurn = turn;
    this.startPersistentTurn(turn);
    return done;
  }

  /** Claim the first unsolicited turn-bearing frame and all following frames until its result. */
  private beginProviderInitiatedTurn(): PersistentTurn {
    this.resetTurnEventState();
    this.clearIdleTimer();
    this.pendingApprovals.clear();
    this.streamedAgentResponse = false;
    let resolveTurn!: (reason: StopReason) => void;
    const done = new Promise<StopReason>((resolve) => { resolveTurn = resolve; });
    const turn: PersistentTurn = {
      id: ++this.providerTurnSeq,
      origin: "provider",
      promptText: "",
      images: [],
      done,
      resolve: resolveTurn,
      settled: false,
      // The provider already owns this input. It must never enter the runner prompt retry path.
      writeAcknowledged: true,
      launchAttempts: 0,
    };
    this.activePersistentTurn = turn;
    this.cb.onProviderInitiatedTurn?.("started", `provider:${turn.id}`);
    return turn;
  }

  /** Launch (or reuse) the long-lived stream-json CLI and deliver exactly one queued turn. */
  private startPersistentTurn(turn: PersistentTurn): void {
    if (this.disposed || turn.settled || this.activePersistentTurn !== turn) return;
    if (this.retiringPersistentTransport) {
      if (!turn.waitingForRetirement) {
        turn.waitingForRetirement = true;
        const retirement = this.retiringPersistentTransport;
        void retirement.then(() => {
          turn.waitingForRetirement = false;
          this.startPersistentTurn(turn);
        });
      }
      return;
    }
    const cfg = this.config;
    // The prepared argv establishes whether the managed-worktree guard is active for this spawn,
    // so it must be resolved BEFORE the permission mode that depends on it.
    const preparedArgs = this.preparedBaseArgs();
    const configuredPermissionMode = this.effectivePermissionMode();
    const mediatesManagedPermissions = this.mediatesManagedPermissions(this.managedProtections());
    this.reportManagedPermissionMediation(configuredPermissionMode, mediatesManagedPermissions);
    const permissionMode = this.launchedPermissionMode();
    const routineChannelMode = this.routineControlChannelMode();
    const perm = claudePermissionArgs(
      permissionMode,
      true,
      routineChannelMode !== null,
    );
    this.interactive = perm.interactive;
    const fingerprint = JSON.stringify({
      cwd: this.cwd,
      model: cfg.model ?? null,
      effort: cfg.effort ?? null,
      permissionMode,
      args: preparedArgs,
    });

    if (this.child && this.persistentFingerprint !== fingerprint) {
      if (this.pendingBackgroundTasks.size > 0) {
        // Never drop the already-recorded user prompt. The current process keeps ownership of its
        // background work, so deliver this turn under its existing argv and apply the new config at
        // the next quiescent boundary.
        this.cb.onStderr("Claude configuration change deferred while background work is running; this turn uses the existing transport settings.");
      } else {
        this.stopPersistentTransport(false);
        this.startPersistentTurn(turn);
        return;
      }
    }

    if (!this.child) {
      // Only a spawn rebinds the permission semantics: the deferred branch above deliberately keeps
      // the running child's argv, so its supplement (or absence of one) must survive this turn.
      this.launchedRoutineControlChannelMode = routineChannelMode;
      this.launchedManagedEmulationMode = mediatesManagedPermissions ? configuredPermissionMode : null;
      const args = [
        ...preparedArgs,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
      ];
      if (this.firstTurn) args.push("--session-id", this.sessionId);
      else args.push("--resume", this.sessionId);
      if (cfg.model && cfg.model !== "default") args.push("--model", cfg.model);
      if (cfg.effort) args.push("--effort", cfg.effort);
      if (this.opts.capabilities?.supportsSteering === true) args.push("--replay-user-messages");
      args.push(...perm.args);

      let child: AgentProcess;
      try {
        child = this.deps.spawn({
          command: this.opts.command,
          args,
          cwd: this.cwd,
          env: this.childEnv(),
          context: this.opts.context,
          scrubInheritedEnv: [
            "ANTHROPIC_API_KEY",
            CLAUDE_PERSISTENT_FLAG,
            CLAUDE_PERSISTENT_IDLE_MS,
            CLAUDE_PENDING_MAX_MS,
            LEGACY_CLAUDE_PERSISTENT_FLAG,
            LEGACY_CLAUDE_PERSISTENT_IDLE_MS,
            LEGACY_CLAUDE_PENDING_MAX_MS,
            ...(this.opts.orchestrator ? ORCHESTRATOR_REPOSITORY_OVERRIDE_ENV : []),
          ],
          isolation: this.opts.isolation,
          containerAgentLaunch: true,
          cloudAgentLaunch: true,
          descendantOwner: this.descendantOwner,
          descendantMarker: this.opts.descendantMarker,
        });
      } catch (err) {
        this.openPersistentCircuit(`persistent claude spawn failed: ${(err as Error).message}`, turn);
        return;
      }
      this.child = child;
      this.persistentTransport = true;
      this.persistentFingerprint = fingerprint;
      this.persistentBuffer = new BoundedNdjsonBuffer(
        (line) => this.processPersistentLine(line),
        () => this.cb.onStderr("discarded oversized NDJSON record from persistent Claude stdout"),
      );
      this.persistentLastCostUsd = 0;
      this.intentionalPersistentStop = false;
      this.attachPersistentTransport(child, ++this.persistentGeneration);
    }

    const child = this.child;
    if (!child) {
      this.openPersistentCircuit("persistent claude transport was unavailable", turn);
      return;
    }
    turn.launchAttempts += 1;
    const payload = JSON.stringify(buildClaudeUserMessage(turn.promptText, turn.images)) + "\n";
    const attempt = turn.launchAttempts;
    const generation = this.persistentGeneration;
    try {
      child.stdin.write(payload, (err?: Error | null) => {
        if (
          turn.settled ||
          this.activePersistentTurn !== turn ||
          attempt !== turn.launchAttempts ||
          generation !== this.persistentGeneration
        ) return;
        if (err) {
          this.handlePersistentFailure(`prompt write failed: ${err.message}`, turn);
          return;
        }
        // This is the duplication boundary: after the stream acknowledges the write we never
        // automatically submit this user message again, even if the CLI terminates mid-turn.
        turn.writeAcknowledged = true;
        this.cb.onPromptAccepted?.();
      });
    } catch (err) {
      this.handlePersistentFailure(`prompt write failed: ${(err as Error).message}`, turn);
    }
  }

  private attachPersistentTransport(child: AgentProcess, generation: number): void {
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.disposed || generation !== this.persistentGeneration) return;
      this.persistentBuffer?.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (this.disposed || generation !== this.persistentGeneration) return;
      const text = String(chunk).trim();
      if (text) this.emitStderrOrAuthenticationFailure(text);
    });
    child.on("error", (err: Error) => {
      if (generation !== this.persistentGeneration) return;
      this.cb.onStderr(`persistent claude spawn error: ${err.message}`);
      if (this.child === child) this.child = null;
      const turn = this.activePersistentTurn;
      if (turn && !turn.settled) this.handlePersistentFailure(`persistent claude spawn error: ${err.message}`, turn);
    });
    child.on("close", (code) => {
      if (generation !== this.persistentGeneration) return;
      // Mirror the one-shot ordering: a trailing, unterminated control_request belongs to a
      // process that is already dead and must not mint an approval card nobody can answer.
      if (this.child === child) this.child = null;
      this.pendingApprovals.clear();
      const trailing = this.persistentBuffer?.takeTrailing() ?? "";
      if (trailing.trim()) this.processPersistentLine(trailing, true);
      this.persistentBuffer = null;
      this.settleControlResponses();
      this.persistentTransport = false;
      this.persistentFingerprint = null;
      if (this.disposed || this.intentionalPersistentStop) return;
      const lostPendingWork = this.pendingBackgroundTasks.size > 0;
      if (lostPendingWork) this.markOrphaned("process_exit");
      const turn = this.activePersistentTurn;
      if (turn && !turn.settled) {
        this.handlePersistentFailure(`persistent claude exited${code == null ? "" : ` with code ${code}`}`, turn);
      } else if (lostPendingWork) {
        // An idle persistent transport normally resumes lazily on the next prompt. Pending work is
        // different: the dead process owned its notifications, so surface the loss to the manager
        // as an unexpected exit and let durable orphan recovery relaunch immediately.
        this.cb.onExit(code);
      }
      // An idle process may exit on its own. The next queued turn transparently resumes.
    });
  }

  private processPersistentLine(raw: string, trailingAtExit = false): void {
    const line = raw.trim();
    if (!line) return;
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      if (!trailingAtExit) {
        // Match the one-shot parser: a complete newline-delimited banner/warning is noise,
        // not proof the transport is corrupt. Only a malformed unterminated tail at process
        // exit is a transport failure that consumes the bounded retry/circuit policy.
        this.cb.onStderr("ignored non-JSON stdout from persistent claude transport");
        return;
      }
      const turn = this.activePersistentTurn;
      this.cb.onStderr("malformed JSON from persistent claude transport; restarting at the next safe boundary");
      if (turn) this.handlePersistentFailure("malformed persistent claude stream", turn);
      else this.stopPersistentTransport(false, "process_exit");
      return;
    }

    if (this.acknowledgeClaudeSteer(msg)) return;
    if (this.settleControlResponse(msg)) return;
    if (this.disposed) return;

    let turn = this.activePersistentTurn;
    if (!turn && opensProviderInitiatedTurn(msg)) {
      turn = this.beginProviderInitiatedTurn();
    }
    if (!turn) {
      this.observeBackgroundLifecycle(msg);
      if (msg.type === "rate_limit_event") {
        this.cb.onSubscriptionUsage?.({ provider: "claude", kind: "sparse", payload: msg });
      } else if (msg.type !== "system") {
        const type = String(msg.type ?? "unknown");
        if (type === "assistant" || type === "result" || type === "control_request" || type === "stream_event") {
          this.cb.onEvent({ kind: "error", message: `Claude sent a ${type} frame outside an active Claude turn.` });
        } else {
          this.cb.onStderr(`ignored ${type} outside an active Claude turn`);
        }
      }
      return;
    }
    const reason = this.handleEvent(msg);
    if (reason) this.finishPersistentTurn(turn, reason);
  }

  private finishPersistentTurn(turn: PersistentTurn, reason: StopReason): void {
    if (turn.settled || this.activePersistentTurn !== turn) return;
    const hadUnacknowledgedSteering = [...this.unacknowledgedSteerMessages.values()]
      .some((pending) => pending.turnId === turn.id && pending.generation === this.persistentGeneration);
    this.settleClaudeSteersForTurn(
      turn.id,
      "Claude provider turn closed before steering acknowledgement",
    );
    this.pendingApprovals.clear();
    if (reason !== "cancelled") this.preparedBaseArgs();
    if (reason !== "refusal" && reason !== "cancelled") this.markSessionEstablished();
    if (reason !== "refusal" && reason !== "cancelled") this.settleUnverifiedBackgroundTasks();
    if (turn.origin === "runner") this.settledRunnerTurnErrorText = this.turnErrorText;
    this.settlePersistentTurn(turn, reason);
    // Claude may have committed this result just before consuming a concurrently written steer as
    // its next input turn. The absent replay receipt makes that unknowable. Retire this process so
    // a possible unowned turn can never alias the next Wollipog prompt's events or result.
    if (hadUnacknowledgedSteering) {
      void this.stopPersistentTransport(false, "process_exit");
      return;
    }
    if (this.pendingBackgroundTasks.size > 0) {
      if (this.pendingCeilingReached) this.evictPendingAtCeiling();
      else this.armPendingCeiling();
    } else {
      this.armIdleEviction();
    }
  }

  /** Retire one exact turn owner and wake its waiter. Provider-owned turns have no public prompt
   * promise, so their callback is the manager's only authoritative settlement boundary. */
  private settlePersistentTurn(turn: PersistentTurn, reason: StopReason): boolean {
    if (turn.settled || this.activePersistentTurn !== turn) return false;
    turn.settled = true;
    this.activePersistentTurn = null;
    if (turn.origin === "provider") this.cb.onProviderInitiatedTurn?.("settled", `provider:${turn.id}`);
    turn.resolve(reason);
    return true;
  }

  private acknowledgeClaudeSteer(msg: Json): boolean {
    if (msg?.type !== "user" || msg.isReplay !== true || typeof msg.uuid !== "string" ||
        msg.session_id !== this.sessionId) return false;
    const unacknowledged = this.unacknowledgedSteerMessages.get(msg.uuid);
    if (!unacknowledged) return false;
    const pending = this.pendingSteersByMessage.get(msg.uuid);
    const turn = this.activePersistentTurn;
    if (!turn || turn.id !== unacknowledged.turnId || this.persistentGeneration !== unacknowledged.generation) {
      if (pending) {
        this.settleClaudeSteer(pending, {
          outcome: "uncertain",
          reason: "Claude acknowledged steering after the active provider turn changed",
        });
      }
      void this.stopPersistentTransport(false, "process_exit");
      return true;
    }
    this.unacknowledgedSteerMessages.delete(msg.uuid);
    // A replay after Wollipog's deadline proves provider receipt but cannot retroactively replace
    // the already-published Uncertain result. It does make retaining this transport safe.
    if (!pending) return true;
    this.settleClaudeSteer(pending, {
      outcome: "accepted",
      providerTurnId: this.sessionId,
    });
    return true;
  }

  private settleClaudeSteer(pending: PendingClaudeSteer, result: DriverSteerResult): void {
    if (this.pendingSteersByMessage.get(pending.providerMessageId) !== pending) return;
    this.pendingSteersByMessage.delete(pending.providerMessageId);
    this.pendingSteerSubmissions.delete(pending.submissionId);
    this.deps.clearTimer(pending.timer);
    pending.resolve(result);
  }

  private settleClaudeSteersForTurn(turnId: number, reason: string): void {
    for (const pending of [...this.pendingSteersByMessage.values()]) {
      if (pending.turnId !== turnId) continue;
      this.settleClaudeSteer(pending, { outcome: "uncertain", reason });
    }
  }

  private settleAllClaudeSteers(reason: string): void {
    for (const pending of [...this.pendingSteersByMessage.values()]) {
      this.settleClaudeSteer(pending, { outcome: "uncertain", reason });
    }
  }

  private observeBackgroundLifecycle(msg: Json): void {
    if (msg?.type === "system") {
      const taskId = typeof msg.task_id === "string" ? msg.task_id : null;
      const toolUseId = typeof msg.tool_use_id === "string" ? msg.tool_use_id : undefined;
      if ((msg.subtype === "task_started" || msg.subtype === "task_progress") && taskId) {
        this.recordPendingTask(
          taskId,
          toolUseId,
          undefined,
          true,
          true,
          undefined,
          this.activeProviderTurnId(),
        );
      } else if (msg.subtype === "task_updated" && taskId) {
        // Read only for a stop the runner asked for: Claude patches the task to `killed` first.
        const patch = msg.patch as Record<string, Json> | undefined;
        const status = typeof patch?.status === "string" ? patch.status.toLowerCase() : "";
        if (status === "killed" && this.stoppingBackgroundTasks.has(taskId)) this.completeStoppedTask(taskId);
      } else if (msg.subtype === "task_notification" && taskId) {
        const status = typeof msg.status === "string" ? msg.status.toLowerCase() : "";
        if ((status === "stopped" || status === "killed") && this.stoppingBackgroundTasks.has(taskId)) {
          this.completeStoppedTask(taskId);
        } else if (status === "completed" || status === "failed" || status === "killed") {
          this.completePendingTask(taskId, toolUseId, status);
        } else if (this.endedBackgroundTaskIds.has(taskId)) {
          // The trailing report of a task the runner already recorded as ended.
        } else {
          // `stopped` has no durable completion record and an unknown future status is ambiguous.
          this.recordPendingTask(taskId, toolUseId, undefined, true);
        }
      }
      return;
    }
    if (msg?.type === "assistant") {
      const blocks: Json[] = msg.message?.content ?? [];
      for (const block of blocks) {
        if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
        const name = String(block.name ?? "");
        const input = block.input as Record<string, Json> | undefined;
        if (!isBackgroundCapableLaunch(name, input)) continue;
        // A tool_use is provisional. Only a provider task lifecycle event or a structured
        // async-launch result promotes it to a hold that requires separate terminal evidence.
        this.recordPendingTask(
          `tool:${block.id}`,
          block.id,
          undefined,
          false,
          true,
          backgroundLaunchType(name),
          this.activeProviderTurnId(),
        );
      }
      return;
    }
    if (msg?.type === "user") {
      const blocks: Json[] = msg.message?.content ?? [];
      for (const block of blocks) {
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        this.reconcileBackgroundToolResult(block.tool_use_id, block.content, block.is_error === true);
      }
    }
  }

  private recordPendingTask(
    id: string,
    toolUseId?: string,
    outputFile?: string,
    requiresTerminalEvidence?: boolean,
    observed = true,
    launchType?: DriverBackgroundLaunchType,
    parentPersistentTurnId?: number,
  ): void {
    const fallback = toolUseId
      ? [...this.pendingBackgroundTasks.values()].find((task) => task.toolUseId === toolUseId)
      : undefined;
    const existing = this.pendingBackgroundTasks.get(id);
    const task: PendingBackgroundTask = {
      id,
      startedAt: existing?.startedAt ?? fallback?.startedAt ?? this.deps.now(),
      ...(toolUseId ? { toolUseId } : existing?.toolUseId ? { toolUseId: existing.toolUseId } :
        fallback?.toolUseId ? { toolUseId: fallback.toolUseId } : {}),
      ...(outputFile ? { outputFile } : existing?.outputFile ? { outputFile: existing.outputFile } :
        fallback?.outputFile ? { outputFile: fallback.outputFile } : {}),
      launchType: launchType ?? existing?.launchType ?? fallback?.launchType ?? "unknown",
      ...((parentPersistentTurnId ?? existing?.parentPersistentTurnId ?? fallback?.parentPersistentTurnId) != null
        ? { parentPersistentTurnId: parentPersistentTurnId ?? existing?.parentPersistentTurnId ?? fallback?.parentPersistentTurnId }
        : {}),
      ...((requiresTerminalEvidence ?? existing?.requiresTerminalEvidence ?? fallback?.requiresTerminalEvidence) != null
        ? { requiresTerminalEvidence: requiresTerminalEvidence ?? existing?.requiresTerminalEvidence ?? fallback?.requiresTerminalEvidence }
        : {}),
    };
    const newlyObserved = observed && this.unverifiedBackgroundTaskIds.delete(id);
    if (fallback && fallback.id !== id) this.pendingBackgroundTasks.delete(fallback.id);
    const changed = newlyObserved || !existing || existing.toolUseId !== task.toolUseId || existing.outputFile !== task.outputFile;
    if (!observed) this.unverifiedBackgroundTaskIds.add(id);
    this.pendingBackgroundTasks.set(id, task);
    if (changed || (fallback != null && fallback.id !== id)) this.pendingWorkChanged();
  }

  private completePendingTask(
    id: string,
    toolUseId?: string,
    status: "completed" | "failed" | "killed" = "completed",
  ): void {
    const terminal = new Map<string, DriverBackgroundTerminalJob>();
    const activeTurnId = this.activeProviderTurnId();
    const capture = (task: PendingBackgroundTask) => terminal.set(task.id, {
      ...driverBackgroundJob(task),
      status,
      terminalAt: this.deps.now(),
      continuationRequired: activeTurnId == null ||
        (task.parentPersistentTurnId != null && task.parentPersistentTurnId !== activeTurnId),
    });
    this.unverifiedBackgroundTaskIds.delete(id);
    const direct = this.pendingBackgroundTasks.get(id);
    if (direct) capture(direct);
    let changed = this.pendingBackgroundTasks.delete(id);
    if (toolUseId) {
      for (const [key, task] of this.pendingBackgroundTasks) {
        if (task.toolUseId !== toolUseId) continue;
        capture(task);
        this.pendingBackgroundTasks.delete(key);
        changed = true;
      }
    }
    if (changed) this.pendingWorkChanged([...terminal.values()]);
    // A job that finished on its own while the runner was stopping it was not stopped.
    for (const job of terminal.values()) {
      const stop = this.stoppingBackgroundTasks.get(job.id);
      if (!stop || stop.ended) continue;
      stop.ended = { stopped: false, job };
      stop.wake?.();
    }
  }

  /** Claude reported that a task the runner asked it to stop has ended (#1780). It has no result to
   * deliver, and it is tombstoned so the provider's trailing report cannot revive it. */
  private completeStoppedTask(id: string): void {
    const stop = this.stoppingBackgroundTasks.get(id);
    const task = this.pendingBackgroundTasks.get(id);
    if (!stop || stop.ended || !task) return;
    for (const [key, pending] of this.pendingBackgroundTasks) {
      if (key !== id && !(task.toolUseId && pending.toolUseId === task.toolUseId)) continue;
      this.pendingBackgroundTasks.delete(key);
      this.unverifiedBackgroundTaskIds.delete(key);
      this.endedBackgroundTaskIds.add(key);
    }
    const job: DriverBackgroundTerminalJob = {
      ...driverBackgroundJob(task),
      status: "killed",
      terminalAt: this.deps.now(),
      // The stopped job has no result to deliver; a finished sibling still gets its continuation.
      continuationRequired: false,
      endedByRunner: true,
    };
    stop.ended = { stopped: true, job };
    this.pendingWorkChanged([job]);
    stop.wake?.();
  }

  private reconcileBackgroundToolResult(toolUseId: string, content: Json, isError: boolean): void {
    const result = structuredToolResult(content);
    const status = typeof result?.status === "string" ? result.status.toLowerCase() : null;
    const taskId = firstString(result, ["taskId", "task_id", "backgroundTaskId"]);
    const outputFile = firstString(result, ["outputFile", "output_file", "persistedOutputPath"]);
    const asyncLaunch = status === "async_launched" || status === "remote_launched";
    if (taskId && asyncLaunch) {
      this.recordPendingTask(taskId, toolUseId, outputFile, true);
      return;
    }
    const provisional = [...this.pendingBackgroundTasks.values()].find((task) => task.toolUseId === toolUseId);
    if (isError || status === "completed" || status === "failed" || status === "killed" ||
        provisional?.requiresTerminalEvidence !== true) {
      this.completePendingTask(
        `tool:${toolUseId}`,
        toolUseId,
        status === "failed" || isError ? "failed" : status === "killed" ? "killed" : "completed",
      );
    }
  }

  private activeProviderTurnId(): number | undefined {
    return this.activePersistentTurn?.id ?? this.activeOneShotTurnId ?? undefined;
  }

  /** A restart seed gets one recovery turn. If that live process did not re-observe the id, the
   * seed is handled rather than being carried into an automatic replay loop forever. */
  private settleUnverifiedBackgroundTasks(): void {
    let changed = false;
    for (const id of this.unverifiedBackgroundTaskIds) {
      if (this.pendingBackgroundTasks.delete(id)) changed = true;
    }
    this.unverifiedBackgroundTaskIds.clear();
    if (changed) this.pendingWorkChanged();
  }

  private pendingWorkChanged(terminalJobs: DriverBackgroundTerminalJob[] = []): void {
    this.clearIdleTimer();
    if (this.pendingBackgroundTasks.size === 0) {
      this.pendingCeilingReached = false;
      this.clearPendingTimer();
      this.cb.onBackgroundWork?.({
        state: null,
        pendingTaskIds: [],
        ...(terminalJobs.length ? { terminalJobs } : {}),
      });
      this.armIdleEviction();
      return;
    }
    const tasks = [...this.pendingBackgroundTasks.values()];
    this.cb.onBackgroundWork?.({
      state: "running",
      pendingTaskIds: tasks.map((task) => task.id).sort(),
      jobs: tasks.map(driverBackgroundJob).sort((left, right) => left.id.localeCompare(right.id)),
      ...(terminalJobs.length ? { terminalJobs } : {}),
      observedTaskIds: tasks.filter((task) => !this.unverifiedBackgroundTaskIds.has(task.id)).map((task) => task.id).sort(),
      oldestPendingAt: Math.min(...tasks.map((task) => task.startedAt)),
    });
    this.armPendingCeiling();
  }

  private activeHoldExpiry(): number | null {
    if (!this.opts.sessionStateDir) return null;
    const path = join(this.opts.sessionStateDir, "hold.json");
    try {
      const parsed = JSON.parse(this.deps.readFile(path)) as { expiresAt?: unknown };
      const expiresAt = parsed.expiresAt;
      const now = this.deps.now();
      if (!Number.isFinite(expiresAt) || !Number.isSafeInteger(expiresAt) || (expiresAt as number) <= now) {
        const warning = `expired or invalid Claude hold sentinel ignored: ${path}`;
        if (warning !== this.holdWarning) this.cb.onStderr(warning);
        this.holdWarning = warning;
        return null;
      }
      this.holdWarning = null;
      // The pending ceiling remains the leak backstop for agent-authored holds. Operators who
      // deliberately configure an unlimited pending lifetime (0) retain an unlimited hold TTL.
      return this.pendingMaxMs === 0
        ? expiresAt as number
        : Math.min(expiresAt as number, now + this.pendingMaxMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        const warning = `unreadable Claude hold sentinel ignored: ${path}`;
        if (warning !== this.holdWarning) this.cb.onStderr(warning);
        this.holdWarning = warning;
      }
      return null;
    }
  }

  private applyBackgroundInspection(
    inspection: ClaudeBackgroundWorkInspection,
    continuationRequired = false,
  ): void {
    for (const artifact of inspection.incompleteArtifacts) {
      if (!this.pendingBackgroundTasks.has(artifact.id) && !this.endedBackgroundTaskIds.has(artifact.id)) {
        this.recordPendingTask(artifact.id, undefined, artifact.outputFile, true, false);
      }
    }
    let changed = false;
    const terminalJobs: DriverBackgroundTerminalJob[] = [];
    for (const id of inspection.terminalTaskIds) {
      const task = this.pendingBackgroundTasks.get(id);
      if (task) {
        terminalJobs.push({
          ...driverBackgroundJob(task),
          status: "completed",
          terminalAt: this.deps.now(),
          continuationRequired,
        });
        this.pendingBackgroundTasks.delete(id);
        this.unverifiedBackgroundTaskIds.delete(id);
        changed = true;
      }
    }
    if (changed) this.pendingWorkChanged(terminalJobs);
  }

  private providerProjectsRoot(): string | undefined {
    const isolation = this.opts.isolation;
    const projectsBind = isolation?.backend === "bwrap"
      ? isolation.writableBinds?.find((bind) => bind.target.replace(/\\/g, "/").endsWith("/.claude/projects"))
      : undefined;
    return projectsBind?.source;
  }

  private nativeDiscoveryRoots() {
    return {
      tempRoot: this.opts.env.TMPDIR ?? this.opts.env.TEMP ?? this.opts.env.TMP,
      claudeHome: this.opts.env.HOME ? join(this.opts.env.HOME, ".claude") : undefined,
      projectsRoot: this.providerProjectsRoot(),
    };
  }

  private reconcilePendingTaskFiles(continuationRequired = false): void {
    this.applyBackgroundInspection(inspectClaudeBackgroundWork(
      this.cwd,
      this.sessionId,
      this.pendingBackgroundTasks.keys(),
      this.nativeDiscoveryRoots(),
    ), continuationRequired);
  }

  private async reconcilePendingTaskFilesInContext(continuationRequired = false): Promise<void> {
    this.applyBackgroundInspection(await this.deps.inspectBackgroundWork(
      this.opts.context,
      this.cwd,
      this.sessionId,
      this.pendingBackgroundTasks.keys(),
      { env: this.opts.env, projectsRoot: this.providerProjectsRoot() },
    ), continuationRequired);
  }

  private finishIdleEvictionAfterReconcile(): void {
    if (!this.persistentTransport || !this.child || this.activePersistentTurn || this.pendingBackgroundTasks.size > 0) return;
    const holdExpiry = this.activeHoldExpiry();
    if (holdExpiry != null) {
      this.armIdleEviction(Math.max(1, holdExpiry - this.deps.now()));
      return;
    }
    this.stopPersistentTransport(false, "process_exit");
  }

  private armIdleEviction(delay = this.persistentIdleMs): void {
    this.clearIdleTimer();
    if (!this.persistentTransport || !this.child || this.activePersistentTurn ||
        this.pendingBackgroundTasks.size > 0 || delay === 0) return;
    const chunk = Math.min(delay, MAX_TIMER_MS);
    this.idleTimer = this.deps.setTimer(() => {
      this.idleTimer = null;
      if (delay > chunk) {
        this.armIdleEviction(delay - chunk);
        return;
      }
      if (this.activePersistentTurn) return;
      if (this.opts.context.kind === "wsl") {
        void this.reconcilePendingTaskFilesInContext(true).then(() => this.finishIdleEvictionAfterReconcile());
      } else {
        this.reconcilePendingTaskFiles(true);
        this.finishIdleEvictionAfterReconcile();
      }
    }, chunk);
    this.idleTimer.unref?.();
  }

  private armPendingCeiling(delay?: number): void {
    this.clearPendingTimer();
    if (this.pendingBackgroundTasks.size === 0 || this.pendingMaxMs === 0) return;
    const oldest = Math.min(...[...this.pendingBackgroundTasks.values()].map((task) => task.startedAt));
    const remaining = delay ?? Math.max(0, this.pendingMaxMs - (this.deps.now() - oldest));
    const chunk = Math.min(Math.max(1, remaining), MAX_TIMER_MS);
    this.pendingTimer = this.deps.setTimer(() => {
      this.pendingTimer = null;
      if (remaining > chunk) {
        this.armPendingCeiling(remaining - chunk);
        return;
      }
      const finish = (recheckDeadline = false) => {
        if (this.pendingBackgroundTasks.size === 0) return;
        if (recheckDeadline) {
          const oldestNow = Math.min(...[...this.pendingBackgroundTasks.values()].map((task) => task.startedAt));
          const remainingNow = this.pendingMaxMs - (this.deps.now() - oldestNow);
          if (remainingNow > 0) { this.armPendingCeiling(remainingNow); return; }
        }
        const holdExpiry = this.activeHoldExpiry();
        if (holdExpiry != null) { this.armPendingCeiling(Math.max(1, holdExpiry - this.deps.now())); return; }
        if (this.activePersistentTurn) { this.pendingCeilingReached = true; return; }
        this.evictPendingAtCeiling();
      };
      if (this.opts.context.kind === "wsl") void this.reconcilePendingTaskFilesInContext(true).then(() => finish(true));
      else { this.reconcilePendingTaskFiles(true); finish(); }
    }, chunk);
    this.pendingTimer.unref?.();
  }

  private evictPendingAtCeiling(): void {
    this.pendingCeilingReached = false;
    if (this.pendingBackgroundTasks.size === 0) return;
    this.stopPersistentTransport(false, "ceiling");
  }

  /** Claude offers no way to end one detached task from outside, so the runner ends them by
   * retiring the process that owns them — the same boundary the pending ceiling uses. Unlike the
   * ceiling, nothing is left orphaned: the work was ended on purpose, so a recovery turn that
   * could relaunch it would undo the decision. Each job is reported as killed instead. */
  async endBackgroundWork(): Promise<DriverBackgroundWorkEndResult> {
    const turnActive = () => this.activePersistentTurn != null || this.activeOneShotTurnId != null;
    if (turnActive()) return { status: "refused", reason: "turn_active" };
    if (this.pendingBackgroundTasks.size === 0) return { status: "none" };
    if (this.disposed || !this.persistentTransport || !this.child) {
      return { status: "refused", reason: "no_live_process" };
    }
    // A job that finished without its lifecycle event reaching us is completed, not killed.
    if (this.opts.context.kind === "wsl") await this.reconcilePendingTaskFilesInContext(true);
    else this.reconcilePendingTaskFiles(true);
    if (turnActive()) return { status: "refused", reason: "turn_active" };
    if (this.pendingBackgroundTasks.size === 0) return { status: "none" };
    // The process exited while receipts were read: its exit already handed the work to orphan
    // recovery, which owns it now.
    if (this.disposed || !this.persistentTransport || !this.child) {
      return { status: "refused", reason: "no_live_process" };
    }
    const tasks = new Map<string, PendingBackgroundTask>();
    const takePending = () => {
      for (const task of this.pendingBackgroundTasks.values()) {
        tasks.set(task.id, task);
        this.endedBackgroundTaskIds.add(task.id);
      }
      this.pendingBackgroundTasks.clear();
      this.unverifiedBackgroundTaskIds.clear();
    };
    // Emptying the pending set first is what keeps retirement from writing an orphan marker.
    takePending();
    await this.stopPersistentTransport(false);
    // Anything recorded while the process retired (a WSL receipt read already in flight, say)
    // belonged to that process too, and ended with it.
    takePending();
    const terminalAt = this.deps.now();
    const jobs = [...tasks.values()].map((task): DriverBackgroundTerminalJob => ({
      ...driverBackgroundJob(task),
      status: "killed",
      terminalAt,
      // The killed job has no result to deliver; a finished sibling still gets its continuation.
      continuationRequired: false,
      endedByRunner: true,
    }));
    this.pendingWorkChanged(jobs);
    return { status: "ended", jobs };
  }

  /** Claude can end one detached task without retiring its process, through the same `stop_task`
   * control request its own task-stop tool uses (#1780). The conversation and every other job keep
   * running. Claude answers `stop_task` with success even for a task it does not know, so the
   * answer alone proves nothing: only Claude's own report that this task ended does. Without one
   * the job is left exactly as it was. */
  async stopBackgroundJob(jobId: string): Promise<DriverBackgroundJobStopResult> {
    if (!this.pendingBackgroundTasks.has(jobId)) return { status: "not_running" };
    const child = this.child;
    if (this.disposed || !this.persistentTransport || !child) return { status: "refused", reason: "no_live_process" };
    // A seed from before a restart that this process never re-observed, or a launch Claude has not
    // confirmed as a task, is not a task this process can stop.
    if (this.unverifiedBackgroundTaskIds.has(jobId) || jobId.startsWith("tool:")) {
      return { status: "refused", reason: "not_owned" };
    }
    if (this.stoppingBackgroundTasks.has(jobId)) return { status: "refused", reason: "in_progress" };
    const stop: PendingBackgroundTaskStop = {};
    this.stoppingBackgroundTasks.set(jobId, stop);
    try {
      const response = await this.sendControlRequest(
        child,
        `wollipog_stop_task_${randomUUID()}`,
        { subtype: "stop_task", task_id: jobId },
        CLAUDE_STOP_TASK_RESPONSE_MS,
      );
      const succeeded = response?.response?.subtype === "success";
      if (!stop.ended && succeeded && this.child === child) {
        await new Promise<void>((resolve) => {
          const timer = this.deps.setTimer(resolve, CLAUDE_STOP_TASK_CONFIRM_MS);
          stop.wake = () => {
            this.deps.clearTimer(timer);
            resolve();
          };
        });
      }
      if (stop.ended) return { status: stop.ended.stopped ? "stopped" : "finished", job: stop.ended.job };
      if (this.child !== child) return { status: "refused", reason: "no_live_process" };
      if (response && !succeeded) return { status: "refused", reason: "provider_rejected" };
      return { status: "refused", reason: "unconfirmed" };
    } finally {
      this.stoppingBackgroundTasks.delete(jobId);
    }
  }

  /** Write one runner-originated control request and wait for Claude's answer. Resolves `null`
   * when the write fails, the transport closes, or the bound passes without an answer. */
  private sendControlRequest(child: AgentProcess, requestId: string, request: Json, timeoutMs: number): Promise<Json | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (response: Json | null) => {
        if (settled) return;
        settled = true;
        this.deps.clearTimer(timer);
        this.pendingControlResponses.delete(requestId);
        resolve(response);
      };
      const timer = this.deps.setTimer(() => finish(null), timeoutMs);
      this.pendingControlResponses.set(requestId, finish);
      try {
        child.stdin.write(JSON.stringify({ type: "control_request", request_id: requestId, request }) + "\n",
          (error?: Error | null) => { if (error) finish(null); });
      } catch {
        finish(null);
      }
    });
  }

  /** Route Claude's answer to a runner-originated control request. Other frames are not consumed. */
  private settleControlResponse(msg: Json): boolean {
    if (msg?.type !== "control_response") return false;
    const requestId = msg.response?.request_id;
    const finish = typeof requestId === "string" ? this.pendingControlResponses.get(requestId) : undefined;
    if (!finish) return false;
    finish(msg);
    return true;
  }

  private settleControlResponses(): void {
    for (const finish of [...this.pendingControlResponses.values()]) finish(null);
  }

  private handlePersistentFailure(message: string, turn: PersistentTurn): void {
    if (turn.settled || this.activePersistentTurn !== turn) return;
    if (turn.origin === "provider") {
      this.cb.onEvent({
        kind: "error",
        message: `${message}; the provider-initiated turn ended before its terminal result`,
      });
      this.stopPersistentTransport(false, "process_exit");
      this.settlePersistentTurn(turn, "refusal");
      return;
    }
    // A failed write that was never acknowledged is the only safe automatic retry. Once
    // acknowledged, the CLI may already have persisted the message, so retrying could duplicate it.
    if (!turn.writeAcknowledged && turn.launchAttempts < 2) {
      this.cb.onStderr(`${message}; restarting and resuming once before prompt acceptance`);
      this.stopPersistentTransport(false, "process_exit");
      queueMicrotask(() => this.startPersistentTurn(turn));
      return;
    }
    if (turn.writeAcknowledged && this.persistentRecoveryFailures < 1) {
      this.persistentRecoveryFailures += 1;
      this.cb.onEvent({
        kind: "error",
        message: `${message}; the acknowledged prompt was not replayed, and the next distinct prompt will restart and resume once`,
      });
      this.stopPersistentTransport(false);
      this.settlePersistentTurn(turn, "refusal");
      return;
    }
    this.openPersistentCircuit(`${message}; persistent mode disabled for this session`, turn);
  }

  private openPersistentCircuit(message: string, turn: PersistentTurn): void {
    this.persistentCircuitOpen = true;
    if (this.opts.capabilities?.supportsSteering === true) this.cb.onSteeringAvailability?.(false);
    this.cb.onEvent({ kind: "error", message });
    this.stopPersistentTransport(false, "process_exit");
    this.settlePersistentTurn(turn, "refusal");
  }

  private stopPersistentTransport(
    cancelActive: boolean,
    orphanReason?: "ceiling" | "shutdown" | "process_exit",
    forceImmediate = false,
  ): Promise<void> {
    this.clearIdleTimer();
    this.clearPendingTimer();
    if (this.pendingBackgroundTasks.size > 0) this.markOrphaned(orphanReason ?? "process_exit");
    const child = this.child;
    // Fence handlers even when the exit path already nulled child before flushing a trailing
    // frame. Otherwise a malformed trailing frame can schedule a retry, fall through the same
    // close handler, and schedule the identical prompt a second time before either microtask runs.
    this.intentionalPersistentStop = true;
    this.child = null;
    this.persistentTransport = false;
    this.persistentFingerprint = null;
    this.pendingApprovals.clear();
    this.settleControlResponses();
    this.settleAllClaudeSteers("Claude steering transport closed before acknowledgement");
    this.unacknowledgedSteerMessages.clear();
    this.persistentGeneration += 1;
    if (cancelActive && this.activePersistentTurn && !this.activePersistentTurn.settled) {
      const turn = this.activePersistentTurn;
      this.settlePersistentTurn(turn, "cancelled");
    }
    if (child) {
      this.retiringPersistentChild = child;
      const retirement = this.gracefullyStop(child, forceImmediate);
      this.retiringPersistentTransport = retirement;
      void retirement.then(() => {
        if (this.retiringPersistentTransport === retirement) {
          this.retiringPersistentTransport = null;
          if (this.retiringPersistentChild === child) this.retiringPersistentChild = null;
        }
      });
      return retirement;
    }
    if (forceImmediate && this.retiringPersistentChild) {
      return this.gracefullyStop(this.retiringPersistentChild, true);
    }
    return this.retiringPersistentTransport ?? Promise.resolve();
  }

  private gracefullyStop(child: AgentProcess, forceImmediate = false): Promise<void> {
    const existing = this.gracefulStopPromises.get(child);
    if (existing) {
      if (forceImmediate) this.gracefulStopForcers.get(child)?.();
      return existing;
    }
    try { child.stdin.end(); } catch { /* already closed */ }
    let resolveStop!: () => void;
    const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
    let settled = false;
    let forced = false;
    const clear = () => {
      if (settled) return;
      settled = true;
      child.off("close", clear);
      const timer = this.gracefulStopTimers.get(child);
      if (timer) this.deps.clearTimer(timer);
      this.gracefulStopTimers.delete(child);
      this.gracefulStopPromises.delete(child);
      this.gracefulStopForcers.delete(child);
      if (this.retiringPersistentChild === child) this.retiringPersistentChild = null;
      resolveStop();
    };
    child.once("close", clear);
    const force = () => {
      if (settled || forced) return;
      forced = true;
      const graceTimer = this.gracefulStopTimers.get(child);
      if (graceTimer) this.deps.clearTimer(graceTimer);
      const forceTimer = this.deps.setTimer(clear, FORCE_STOP_WAIT_MS);
      forceTimer.unref?.();
      this.gracefulStopTimers.set(child, forceTimer);
      this.deps.kill(child);
    };
    this.gracefulStopPromises.set(child, stopped);
    this.gracefulStopForcers.set(child, force);
    if (forceImmediate) {
      force();
    } else {
      const timer = this.deps.setTimer(force, GRACEFUL_STOP_MS);
      timer.unref?.();
      this.gracefulStopTimers.set(child, timer);
    }
    // Runner shutdown waits through the grace interval and, if needed, the process-tree kill.
    this.deps.trackKill(stopped);
    return stopped;
  }

  private markOrphaned(reason: "ceiling" | "shutdown" | "process_exit"): void {
    const tasks = [...this.pendingBackgroundTasks.values()];
    if (tasks.length === 0) return;
    this.cb.onBackgroundWork?.({
      state: "orphaned",
      pendingTaskIds: tasks.map((task) => task.id).sort(),
      observedTaskIds: tasks.filter((task) => !this.unverifiedBackgroundTaskIds.has(task.id)).map((task) => task.id).sort(),
      oldestPendingAt: Math.min(...tasks.map((task) => task.startedAt)),
      reason,
    });
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    this.deps.clearTimer(this.idleTimer);
    this.idleTimer = null;
  }

  private clearPendingTimer(): void {
    if (!this.pendingTimer) return;
    this.deps.clearTimer(this.pendingTimer);
    this.pendingTimer = null;
  }

  private childEnv(): Record<string, string> {
    const env = { ...this.opts.env, ...this.preparedHookEnv };
    delete env[CLAUDE_PERSISTENT_FLAG];
    delete env[CLAUDE_PERSISTENT_IDLE_MS];
    delete env[CLAUDE_PENDING_MAX_MS];
    delete env[CLAUDE_HANDOFF_WAIT_MAX_MS];
    delete env[LEGACY_CLAUDE_PERSISTENT_FLAG];
    delete env[LEGACY_CLAUDE_PERSISTENT_IDLE_MS];
    delete env[LEGACY_CLAUDE_PENDING_MAX_MS];
    // Keep campaign-scoped `gh issue` writes bound to the selected repository. The semantic
    // classifier also rejects `--repo`/`-R`; removing GH_REPO closes the ambient override path.
    if (this.opts.orchestrator) {
      for (const name of ORCHESTRATOR_REPOSITORY_OVERRIDE_ENV) delete env[name];
    }
    if (env.CLAUDE_CODE_OAUTH_TOKEN) delete env.ANTHROPIC_API_KEY;
    return env;
  }

  /** Heal the exact managed settings path before every process and remove it after the session's
   * transport circuit opens. The persisted base args remain intact for restart diagnostics. */
  private preparedBaseArgs(): string[] {
    const prepared = prepareClaudeHookArgs(this.opts.args);
    this.preparedHookEnv = prepared.env ?? {};
    this.managedWorktreeGuardActive = prepared.guardActive;
    this.managedWorktreeGuardStateDirectory = prepared.guardStateDirectory ?? "";
    if (prepared.guardReason && prepared.guardReason !== this.managedWorktreeGuardReason) {
      this.cb.onStderr(`Claude managed-worktree guard inactive: ${prepared.guardReason}; using runner mediation.`);
    }
    this.managedWorktreeGuardReason = prepared.guardReason ?? null;
    if (prepared.circuitOpen && !this.hookCircuitReported) {
      this.hookCircuitReported = true;
      this.hookCircuitOpenedAt = prepared.circuitOpenedAt ?? null;
      this.cb.onStderr("Claude manager hook circuit opened; continuing with provider-native behavior.");
      if (prepared.circuitOpenedAt != null) {
        this.cb.onEvent({
          kind: "policy_transport",
          state: "open",
          openedAt: prepared.circuitOpenedAt,
        });
      }
    } else if (prepared.circuitReprobePending) {
      this.hookCircuitReported = true;
      this.hookCircuitOpenedAt ??= prepared.circuitOpenedAt ?? null;
      this.cb.onStderr("Claude manager hook circuit cooldown elapsed; policy transport will be re-probed.");
    } else if (!prepared.circuitOpen) {
      if (this.hookCircuitReported && this.hookCircuitOpenedAt != null) {
        this.cb.onEvent({
          kind: "policy_transport",
          state: "recovered",
          openedAt: this.hookCircuitOpenedAt,
          ...(prepared.hookAskCapable ? { restoresElicitation: true } : {}),
        });
      }
      this.hookCircuitReported = false;
      this.hookCircuitOpenedAt = null;
    }
    if (prepared.healed) this.cb.onStderr("Claude manager hook settings were restored before launch.");
    return this.opts.orchestrator
      ? claudeStructuredOrchestratorArgs(
        prepared.args,
        this.opts.orchestrator.strictProjectIsolation,
      )
      : prepared.args;
  }

  cancel(): void {
    this.cancelled = true;
    this.streamingMessageIds.clear();
    if (this.activePersistentTurn) {
      const turn = this.activePersistentTurn;
      this.settlePersistentTurn(turn, "cancelled");
      this.stopPersistentTransport(true, undefined, true);
      return;
    }
    if (this.persistentTransport && this.child) {
      this.stopPersistentTransport(
        false,
        this.pendingBackgroundTasks.size > 0 ? "process_exit" : undefined,
        true,
      );
      return;
    }
    this.cancelled = true;
    this.activeOneShotTurnId = null;
    this.pendingApprovals.clear();
    if (this.child) {
      if (this.pendingBackgroundTasks.size > 0) this.markOrphaned("process_exit");
      this.deps.kill(this.child);
    }
  }

  /** Answer a pending interactive approval by writing a control_response on the CLI's
   * stdin (the stdio permission-prompt-tool protocol). Returns true iff a live ask was
   * answered — false means nothing was waiting (unknown id / process gone) and the caller
   * must surface that instead of pretending the decision landed. */
  resolvePermission(requestId: string, optionId: string | null): boolean {
    const input = this.pendingApprovals.get(requestId);
    if (input === undefined) return false;
    this.pendingApprovals.delete(requestId);
    this.pendingAttentionOwners.delete(requestId);
    const allow = optionId === "allow";
    const response = allow
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "The user declined this tool call." };
    const msg = { type: "control_response", response: { subtype: "success", request_id: requestId, response } };
    if (!this.child) return false;
    try {
      this.child.stdin.write(JSON.stringify(msg) + "\n");
      return true;
    } catch {
      return false; // process died between the ask and the click
    }
  }

  /** Answer a pending AskUserQuestion: allow with `updatedInput = {questions, answers}` (the
   * T3-proven wire shape — answers keyed by question TEXT; multiSelect ⇒ label array). An
   * explicit dismiss, or a legacy empty answer map, denies the ask so the agent does not hang. */
  answerQuestion(requestId: string, answers: Record<string, string | string[]>, action?: "submit" | "dismiss"): boolean {
    const original = this.pendingApprovals.get(requestId);
    if (original === undefined) return false;
    this.pendingApprovals.delete(requestId);
    this.pendingAttentionOwners.delete(requestId);
    const response = action === "submit" || (action == null && Object.keys(answers).length > 0)
      ? { behavior: "allow", updatedInput: { ...(original as Json), answers } }
      : { behavior: "deny", message: "The user dismissed the question." };
    const msg = { type: "control_response", response: { subtype: "success", request_id: requestId, response } };
    if (!this.child) return false;
    try {
      this.child.stdin.write(JSON.stringify(msg) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  dispose(options?: { forceImmediate?: boolean }): void {
    const retirements: Promise<void>[] = [];
    if (this.pendingBackgroundTasks.size > 0) this.markOrphaned("shutdown");
    this.disposed = true;
    this.streamingMessageIds.clear();
    this.pendingApprovals.clear();
    this.settleAllClaudeSteers("Claude driver was disposed before steering acknowledgement");
    this.unacknowledgedSteerMessages.clear();
    this.activeOneShotTurnId = null;
    if (this.activePersistentTurn && !this.activePersistentTurn.settled) {
      this.settlePersistentTurn(this.activePersistentTurn, "cancelled");
    }
    this.clearIdleTimer();
    this.clearPendingTimer();
    if (options?.forceImmediate && this.retiringPersistentChild) {
      retirements.push(this.gracefullyStop(this.retiringPersistentChild, true));
    }
    if (this.child) {
      if (this.persistentTransport) {
        retirements.push(this.gracefullyStop(this.child, options?.forceImmediate === true));
      }
      else this.deps.kill(this.child);
    }
    this.child = null;
    for (const child of this.auxiliaryChildren) this.deps.kill(child);
    this.auxiliaryChildren.clear();
    // The owner drain must not preempt the persistent provider's five-second EOF window. The
    // pending-kill registry drains in waves, so cleanup registered by this continuation is still
    // included in runner shutdown.
    if (retirements.length > 0) {
      void Promise.allSettled(retirements).then(() => this.deps.terminateDescendants(this.descendantOwner));
    } else {
      this.deps.terminateDescendants(this.descendantOwner);
    }
  }

  private emitStderrOrAuthenticationFailure(text: string): void {
    if (isProviderAuthenticationFailure(text)) this.signalAuthenticationFailure();
    else this.cb.onStderr(text);
  }

  private signalAuthenticationFailure(): void {
    if (this.cb.onAuthenticationFailure) this.cb.onAuthenticationFailure();
    else this.cb.onStderr("provider authentication is required");
  }

  private markSessionEstablished(): void {
    this.firstTurn = false;
    if (this.sessionEstablished) return;
    this.sessionEstablished = true;
    this.cb.onSessionEstablished?.(this.sessionId);
  }

  /** Map one claude stream-json event; return a StopReason when the turn ends. */
  private handleEvent(msg: Json): StopReason | null {
    if (this.disposed) return null;
    this.observeBackgroundLifecycle(msg);
    // Claude tags every assistant/user/stream_event message that originated inside a subagent
    // with `parent_tool_use_id` = the id of the spawning Task tool call (top-level ⇒ null). We
    // carry it onto the emitted events so the UI can nest a subagent's work under its Task block.
    // Spread `pp` so top-level events carry NO parentToolUseId key at all (clean payload + the
    // existing exact-match tests stay green); a subagent event gets the key.
    const parentId = typeof msg.parent_tool_use_id === "string" && msg.parent_tool_use_id ? msg.parent_tool_use_id : null;
    const pp = parentId ? { parentToolUseId: parentId } : null;
    switch (msg.type) {
      case "rate_limit_event":
        this.cb.onSubscriptionUsage?.({ provider: "claude", kind: "sparse", payload: msg });
        return null;

      case "system":
        if (msg.subtype === "init" && msg.session_id === this.sessionId) {
          // The session now exists even if this first turn is cancelled before a terminal result.
          // Persisting the coordinate at this boundary makes every later recovery use --resume.
          this.markSessionEstablished();
        }
        if (msg.subtype === "init" && typeof msg.model === "string" && msg.model) {
          this.resolvedModel = msg.model;
          this.cb.onModelResolved?.(msg.model);
        }
        if (msg.subtype === "api_retry") {
          const error = String(msg.error ?? "");
          if (isProviderAuthenticationFailure(error)) this.signalAuthenticationFailure();
          else this.cb.onStderr(`retry ${msg.attempt}/${msg.max_retries}: ${error}`);
        }
        return null;

      case "control_request": {
        // Interactive permission ask (--permission-prompt-tool stdio). Surface it to the
        // UI as a permission_request; resolvePermission answers with a control_response.
        // A dead process can't receive a response, so an ask surfacing after exit (the
        // trailing-line flush runs AFTER the close handler cleared pendingApprovals) must
        // not mint a phantom card for a process that no longer exists.
        if (!this.child) return null;
        const req = msg.request;
        if (req?.subtype === "can_use_tool" && typeof msg.request_id === "string") {
          const protections = this.managedProtections();
          // Defense in depth for `default`/`auto`, mirroring the guard hook exactly: the runner's
          // own hook state is off limits to every tool, and only then does the worktree veto run.
          const guardStateRefusal = this.managedWorktreeGuardStateVeto(req.tool_name, req.input);
          const managedRefusal = guardStateRefusal ??
            (req.tool_name === "Bash" && typeof req.input?.command === "string"
              ? commandTargetsManagedWorktree(
                  req.input.command,
                  // The request carries no cwd and the Bash tool keeps its own directory between
                  // calls, so a relative operand cannot be placed from here (#1333). With the guard
                  // active the hook has already judged this command from Claude's real directory;
                  // the channel then adds only the refusals that hold wherever the shell is.
                  // Measured for #1361 on claude 2.1.270 and 2.1.277: the hook runs for a
                  // SUBAGENT's Bash calls too, and its `cwd` is the directory that subagent's
                  // command actually runs in — which is the top-level shell's current directory,
                  // not the session directory. So the session directory is the wrong place for a
                  // subagent's operand as well, and the guard is the authority for both. Only a
                  // mediated launch, which has no hook at all, keeps the session directory.
                  // Measured for #1397 on the same two versions, this time through the control
                  // channel itself: a subagent's Bash call DOES arrive here in `default` and
                  // `auto`, and its frame carries no cwd either — it is marked by
                  // `request.agent_id`, never by `parent_tool_use_id`. Real frames of both kinds
                  // are replayed against this line in claude-code-managed-worktree.test.ts.
                  this.managedWorktreeGuardActive ? PLACELESS_CWD : this.cwd,
                  protections,
                  // The environment this process gave Claude is the one its Bash tool starts
                  // from, so a worktree path held in a variable resolves here too (#1324).
                  // `spawnAgent` overlays it on the inherited environment, so both halves count.
                  { ...process.env, ...this.childEnv() },
                )
              : null);
          if (managedRefusal) {
            try {
              this.child.stdin.write(JSON.stringify({
                type: "control_response",
                response: {
                  subtype: "success",
                  request_id: msg.request_id,
                  response: { behavior: "deny", message: managedRefusal },
                },
              }) + "\n");
            } catch { /* the provider process ended before the refusal could be written */ }
            return null;
          }
          // Emulation exists only for the mediated launch, and the RUNNING child's launch decides
          // that — not the worktree inventory or configuration as they stand now. With the guard
          // active the process was launched in the user's own mode, so Claude's own rules decide.
          const emulatedMode = this.launchedManagedEmulationMode;
          if (emulatedMode !== null) {
            const editTool = ["Edit", "MultiEdit", "NotebookEdit", "Write"].includes(req.tool_name ?? "");
            const behavior = emulatedMode === "bypassPermissions" ||
                (emulatedMode === "acceptEdits" && editTool)
              ? "allow"
              : emulatedMode === "dontAsk" ? "deny" : null;
            if (behavior) {
              try {
                this.child.stdin.write(JSON.stringify({
                  type: "control_response",
                  response: {
                    subtype: "success",
                    request_id: msg.request_id,
                    response: behavior === "allow"
                      ? { behavior, updatedInput: req.input }
                      : { behavior, message: "Claude permission mode dontAsk does not authorize this tool." },
                  },
                }) + "\n");
                return null;
              } catch {
                // Fall through to the visible approval path if a bounded response cannot be sent.
              }
            }
          }
          // The launch policy is the role signal: it is present for every Orchestrator a v144+
          // control plane launches, whether the provider mode is the coupled preset or (v160) an
          // ordinary mode the user selected. Strict isolation only ever arrives with the preset.
          const orchestratorDisposition = this.opts.orchestrator
            ? classifyRoutineClaudeOrchestratorPermission(
                req.tool_name,
                req.input,
                this.opts.orchestrator.issueNumbers ?? [],
                this.opts.cwd,
              )
            : "interactive";
          if (orchestratorDisposition === "allow") {
            try {
              this.child.stdin.write(JSON.stringify({
                type: "control_response",
                response: {
                  subtype: "success",
                  request_id: msg.request_id,
                  response: { behavior: "allow", updatedInput: req.input },
                },
              }) + "\n");
              return null;
            } catch {
              // Provider mode retains the request on the visible approval path. Strict mode falls
              // through to its fail-closed denial path; neither silently parks the provider.
            }
          }
          if (orchestratorDisposition === "reformulate") {
            try {
              this.child.stdin.write(JSON.stringify({
                type: "control_response",
                response: {
                  subtype: "success",
                  request_id: msg.request_id,
                  response: {
                    behavior: "deny",
                    message: "Routine coordination must not require human approval. Retry with separate semantic Git/GitHub commands, use Read/Grep/Glob for local files, use @me and --body for campaign-scoped issue writes, and keep presentation-only filters on stdin.",
                  },
                },
              }) + "\n");
            } catch { /* the provider process ended before the reformulation response was written */ }
            return null;
          }
          if (this.opts.orchestrator?.strictProjectIsolation && req.tool_name !== "AskUserQuestion") {
            try {
              this.child.stdin.write(JSON.stringify({
                type: "control_response",
                response: {
                  subtype: "success",
                  request_id: msg.request_id,
                  response: {
                    behavior: "deny",
                    message: "Strict Project Isolation denied an operation outside the Orchestrator routine-operation contract.",
                  },
                },
              }) + "\n");
            } catch { /* the provider process ended before the denial could be written */ }
            return null;
          }
          // The runner's channel is a supplement in a fixed-rule mode, not a new ask: the CLI
          // consulted it only because its own rule would have refused this call headlessly. Reply
          // with that same refusal so the mode keeps its ordinary behavior and nothing beyond the
          // routine contract is newly allowed. A question is not a tool authorization, so
          // AskUserQuestion still reaches the human as it does in every other mode.
          const routineChannelMode = this.launchedRoutineControlChannelMode;
          if (routineChannelMode && req.tool_name !== "AskUserQuestion") {
            try {
              this.child.stdin.write(JSON.stringify({
                type: "control_response",
                response: {
                  subtype: "success",
                  request_id: msg.request_id,
                  response: {
                    behavior: "deny",
                    message: `Claude permission mode ${routineChannelMode} does not authorize this operation, and it is outside the Orchestrator routine-operation contract. Only that contract is added in a fixed-rule mode; a different provider permission mode is a human decision.`,
                  },
                },
              }) + "\n");
            } catch { /* the provider process ended before the denial could be written */ }
            return null;
          }
          if (!this.pendingApprovals.has(msg.request_id) && this.pendingApprovals.size >= 128) {
            try {
              this.child.stdin.write(JSON.stringify({
                type: "control_response", response: { subtype: "success", request_id: msg.request_id,
                  response: { behavior: "deny", message: "Too many concurrent pending requests." } },
              }) + "\n");
            } catch { /* the provider process ended before the denial could be written */ }
            return null;
          }
          if (this.pendingApprovals.size === 0) this.pendingAttentionOwners.clear();
          this.pendingApprovals.set(msg.request_id, req.input ?? {});
          this.pendingAttentionOwners.delete(msg.request_id);
          // Attention ownership needs the id of the Task call that spawned the asker. #1397
          // measured that a real `can_use_tool` frame carries no `parent_tool_use_id` at all
          // (claude 2.1.270 and 2.1.277, `default` and `auto`), so `parentId` is null here today
          // and a subagent's card is attributed to the session rather than to its Task block.
          // The frame does mark a subagent — `request.agent_id` — but that opaque id is NOT the
          // Task tool_use id this field needs, so routing it would take a correlation table this
          // driver does not keep. Kept as written: it costs nothing while the field is absent and
          // starts working unchanged if a CLI release begins parenting these frames.
          if (this.cb.supportsWorkerAttention?.() && parentId) {
            this.pendingAttentionOwners.set(msg.request_id, { owner: parentId, question: req.tool_name === "AskUserQuestion" });
          }
          // AskUserQuestion is not a permission ask — it's the agent asking the USER a
          // structured multiple-choice question (docs/askuserquestion-implementation-
          // recommendation.md). Surface it as a question card; answerQuestion() returns the
          // selections as updatedInput (echoing the input unanswered reads as "dismissed").
          if (req.tool_name === "AskUserQuestion") {
            const questions = normalizeQuestions(req.input);
            if (questions.length === 0) {
              // Malformed / empty / duplicate-text ask (CLI drift, hostile input): parking a
              // card the UI can't answer would strand the session in input_required with no
              // escape — deny immediately so the turn settles, and say why on stderr.
              this.pendingApprovals.delete(msg.request_id);
              this.pendingAttentionOwners.delete(msg.request_id);
              this.cb.onStderr(
                "AskUserQuestion arrived with no answerable questions (malformed or duplicate question text) — auto-dismissing so the turn doesn't stall",
              );
              try {
                this.child?.stdin.write(
                  JSON.stringify({
                    type: "control_response",
                    response: {
                      subtype: "success",
                      request_id: msg.request_id,
                      response: { behavior: "deny", message: "The question payload was malformed." },
                    },
                  }) + "\n",
                );
              } catch {
                /* process already gone */
              }
              return null;
            }
            this.cb.onEvent({
              kind: "question_request",
              ...(this.cb.supportsWorkerAttention?.() && parentId ? { ownerToolUseId: parentId } : {}),
              requestId: msg.request_id,
              questions,
            });
            return null;
          }
          // MCP tools (e.g. the session-scoped mcp__wollipog__*) often arrive with no description;
          // fall back to the input JSON so the Allow/Reject card states WHAT will be applied,
          // not just which tool — a blind Allow button defeats confirm-before-apply.
          const detail = req.description ? String(req.description) : JSON.stringify(req.input ?? {});
          const title = req.tool_name ? `${req.tool_name}: ${truncate(detail, 80)}` : "Permission requested";
          this.cb.onEvent({
            kind: "permission_request",
            ...(this.cb.supportsWorkerAttention?.() && parentId ? { ownerToolUseId: parentId } : {}),
            requestId: msg.request_id,
            title,
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Reject", kind: "reject_once" },
            ],
            // The trust surface: the card shows WHAT it authorizes, not just the tool name.
            context: {
              toolName: req.tool_name ? truncate(String(req.tool_name), 256) : undefined,
              input: renderApprovalInput(req.tool_name, req.input),
              ...approvalScopeContext(req.input),
            },
          });
        } else if (typeof msg.request_id === "string") {
          // Drift canary: the stdio control protocol is the undocumented Agent SDK channel —
          // a CLI release could add subtypes. A silent ignore would park claude forever with
          // zero diagnostics; decline loudly instead so the turn settles.
          this.cb.onStderr(
            `unrecognized control_request (subtype=${String(req?.subtype ?? "?")}) — auto-declining so the turn doesn't stall; the claude CLI control protocol may have changed`,
          );
          try {
            this.child?.stdin.write(
              JSON.stringify({
                type: "control_response",
                response: { subtype: "error", request_id: msg.request_id, error: "unsupported control request" },
              }) + "\n",
            );
          } catch {
            /* process already gone — nothing to unpark */
          }
        }
        return null;
      }

      case "stream_event": {
        const ev = msg.event;
        if (!ev) return null;
        const messageLane = parentId ?? "";
        if (ev.type === "message_start") {
          const id = ev.message?.id;
          if (typeof id === "string" && id) this.streamingMessageIds.set(messageLane, id);
        } else if (ev.type === "message_stop") {
          this.streamingMessageIds.delete(messageLane);
        } else if (ev.type === "content_block_delta") {
          const d = ev.delta;
          const providerMessageId = this.streamingMessageIds.get(messageLane);
          const messageId = providerMessageId && Number.isSafeInteger(ev.index)
            ? `${providerMessageId}:${ev.index}`
            : undefined;
          if (d?.type === "text_delta" && d.text) {
            this.cb.onEvent({ kind: "agent_message", text: d.text, ...(messageId ? { messageId } : {}), ...pp });
            if (!parentId) {
              this.streamedAgentResponse = true;
              if (providerMessageId) this.turnStreamedMessageIds.add(providerMessageId);
              else if (this.turnAnonymousShownText.length + d.text.length <= ANONYMOUS_SHOWN_MAX) {
                this.turnAnonymousShownText += d.text;
              } else this.turnAnonymousShownOverflow = true;
            }
          } else if (d?.type === "thinking_delta" && d.thinking) {
            this.cb.onEvent({ kind: "agent_thought", text: d.thinking, ...(messageId ? { messageId } : {}), ...pp });
          }
        } else if (ev.type === "content_block_start") {
          const b = ev.content_block;
          if (b?.type === "tool_use") {
            const name = b.name ?? "tool";
            this.cb.onEvent({ kind: "tool_call", toolCallId: b.id ?? "tool", title: name, toolKind: toolKind(name), status: "pending", ...pp });
          }
        }
        return null;
      }

      case "assistant": {
        if (!parentId && typeof msg.message?.model === "string" && msg.message.model) this.turnModel = msg.message.model;
        if (!parentId) {
          const occupancy = claudeContextOccupancy(msg.message);
          if (occupancy != null) this.turnContextOccupancy = occupancy;
        }
        const blocks: Json[] = msg.message?.content ?? [];
        if (!parentId) {
          const text = blocks.filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => String(b.text)).join("").trim();
          if (text) {
            const id = typeof msg.message?.id === "string" ? msg.message.id : "";
            const shown = id
              ? this.turnStreamedMessageIds.has(id)
              : this.turnAnonymousShownOverflow || this.turnAnonymousShownText.includes(text);
            if (shown) this.turnShownText = this.turnShownText ? `${this.turnShownText}\n${text}` : text;
            else this.turnUnshownText = this.turnUnshownText ? `${this.turnUnshownText}\n${text}` : text;
          }
        }
        for (const b of blocks) {
          if (b?.type !== "tool_use") continue;
          const name: string = b.name ?? "tool";
          const input = b.input as Record<string, Json> | undefined;
          if (name === "TodoWrite" && Array.isArray(input?.todos)) {
            const entries: PlanEntry[] = (input!.todos as Json[]).map((t) => ({
              content: String(t.content ?? t.activeForm ?? ""),
              status: t.status === "completed" ? "completed" : t.status === "in_progress" ? "in_progress" : "pending",
            }));
            this.cb.onEvent({ kind: "plan", entries, ...pp });
          }
          this.cb.onEvent({
            kind: "tool_call",
            toolCallId: b.id ?? "tool",
            title: toolTitle(name, input),
            toolKind: toolKind(name),
            status: "in_progress",
            text: input ? truncate(JSON.stringify(input), 400) : undefined,
            ...structuredSubagentIdentity(name, input),
            ...pp,
          });
          if ((name === "Edit" || name === "Write" || name === "MultiEdit") && typeof input?.file_path === "string") {
            this.cb.onEvent({ kind: "file_edit", path: input.file_path as string, ...pp });
          }
        }
        // Claude includes per-message usage on assistant records. Top-level usage is represented by
        // the terminal result event; parented records are the only source for subagent token rollups.
        const messageUsage = msg.message?.usage;
        if (parentId && messageUsage && typeof messageUsage === "object") {
          this.cb.onEvent({
            kind: "token_usage",
            inputTokens: messageUsage.input_tokens,
            outputTokens: messageUsage.output_tokens,
            cachedInputTokens: messageUsage.cache_read_input_tokens,
            ...(typeof messageUsage.cache_creation_input_tokens === "number"
              ? { cacheCreationInputTokens: messageUsage.cache_creation_input_tokens }
              : {}),
            ...(typeof msg.message?.model === "string" && msg.message.model ? { model: msg.message.model } : {}),
            parentToolUseId: parentId,
          });
        }
        return null;
      }

      case "user": {
        const blocks: Json[] = msg.message?.content ?? [];
        for (const b of blocks) {
          if (b?.type !== "tool_result") continue;
          for (const [requestId, owner] of this.pendingAttentionOwners) {
            if (owner.owner !== b.tool_use_id) continue;
            if (!this.pendingApprovals.has(requestId)) {
              this.pendingAttentionOwners.delete(requestId);
              continue;
            }
            // Completion ends this exact tool's callbacks, not its siblings' requests.
            if (owner.question) {
              this.answerQuestion(requestId, {}, "dismiss");
              this.cb.onEvent({ kind: "question_resolved", requestId, answered: false, resolutionReason: "provider_resolved" });
            } else {
              this.resolvePermission(requestId, null);
              this.cb.onEvent({ kind: "permission_resolved", requestId, optionId: null, resolutionReason: "provider_resolved" });
            }
            this.pendingAttentionOwners.delete(requestId);
          }
          this.cb.onEvent({
            kind: "tool_call_update",
            toolCallId: b.tool_use_id ?? "tool",
            status: b.is_error ? "failed" : "completed",
            text: truncate(contentToText(b.content), 400),
            ...pp,
          });
        }
        return null;
      }

      case "result": {
        this.streamingMessageIds.clear();
        const usage = msg.usage ?? {};
        let costUsd = msg.total_cost_usd;
        if (this.persistentTransport && typeof costUsd === "number" && Number.isFinite(costUsd)) {
          const cumulative = costUsd;
          costUsd = Math.max(0, cumulative - this.persistentLastCostUsd);
          this.persistentLastCostUsd = cumulative;
        }
        this.cb.onEvent({
          kind: "token_usage",
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cachedInputTokens: usage.cache_read_input_tokens,
          ...(typeof usage.cache_creation_input_tokens === "number"
            ? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
            : {}),
          ...(this.turnModel && !parentId ? { model: this.turnModel } : {}),
          costUsd,
          ...(typeof msg.duration_ms === "number" ? { durationMs: msg.duration_ms } : {}),
          ...pp,
        });
        // Token usage on a top-level result is proof the provider actually answered over the API,
        // which is what subscription usage needs to tell "never ran" apart from "reports nothing".
        // A subagent result or a turn that failed before any request proves neither.
        if (!parentId && (usage.input_tokens || usage.output_tokens)) {
          this.cb.onSubscriptionUsage?.({ provider: "claude", kind: "response_observed" });
        }
        // The terminal result is the only place Claude states the context window it actually
        // served this turn; together with the last top-level request size it is the authoritative
        // gauge behind the context meter (never the catalog's expectation or a name-derived size).
        if (!parentId) {
          const effectiveWindow = claudeEffectiveContextWindow(msg.modelUsage, this.resolvedModel, this.turnModel);
          if (effectiveWindow != null) {
            this.cb.onAcpUsage?.({
              ...(this.turnContextOccupancy != null ? { contextTokensUsed: this.turnContextOccupancy } : {}),
              contextWindow: effectiveWindow,
            });
          }
        }
        // In stream-json input mode the process stays open for more turns; close stdin
        // so it exits and this turn settles (multi-turn uses a fresh --resume process).
        if (this.interactive && !this.persistentTransport) {
          try {
            this.child?.stdin.end();
          } catch {
            /* ignore */
          }
        }
        if (msg.is_error || msg.subtype === "error_during_execution") {
          if (!parentId) {
            this.streamedAgentResponse = false;
            const rejection = claudeContextWindowRejection(msg, this.resolvedModel);
            const candidate = rejection ??
              claudeErrorResultText(msg, this.turnUnshownText, this.turnShownText);
            // An authentication diagnostic can carry a token or an authorization URL, so its raw
            // text must never cross this boundary — it is replaced with static guidance and routed
            // to the provider-auth recovery lane, exactly as every other driver call site does.
            // The complete text is classified before any bounding, because truncation can drop the
            // phrase that identifies it while keeping a credential near the front.
            const authentication = !rejection && isProviderAuthenticationFailure(candidate);
            const message = authentication ? PROVIDER_AUTHENTICATION_ERROR
              : candidate ? truncate(candidate, 2_000) : null;
            if (message) {
              this.turnErrorText = message;
              this.cb.onEvent({ kind: "error", message });
            }
            // Signal last: on the persistent transport this resolves the turn synchronously, and
            // the reader must already have the explanation by then.
            if (authentication) this.signalAuthenticationFailure();
          }
          return "refusal";
        }
        if (msg.subtype === "error_max_turns") {
          if (!parentId) this.streamedAgentResponse = false;
          return "max_turn_requests";
        }
        if (!parentId && this.streamedAgentResponse) {
          this.streamedAgentResponse = false;
          this.cb.onEvent({ kind: "agent_response_completed" });
        }
        return "end_turn";
      }

      default:
        return null;
    }
  }
}

/** A terminal task notification can arrive without a reply, so lifecycle-only system frames must
 * not strand the transport in an active turn. The first frame carrying actual turn traffic owns it. */
function opensProviderInitiatedTurn(msg: Json): boolean {
  return msg.type === "user" ||
    msg.type === "assistant" ||
    msg.type === "stream_event" ||
    msg.type === "result";
}

function structuredToolResult(content: Json): Record<string, Json> | null {
  let value = content;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, Json>;
}

function firstString(value: Record<string, Json> | null, keys: string[]): string | undefined {
  if (!value) return undefined;
  for (const key of keys) if (typeof value[key] === "string" && value[key]) return value[key] as string;
  return undefined;
}

/** Bound on retained anonymous streamed text; only a provider omitting message ids reaches it. */
const ANONYMOUS_SHOWN_MAX = 64 * 1024;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Normalize an AskUserQuestion input into protocol AgentQuestions. id = question TEXT — the
 * Claude SDK looks answers up by text (T3 #2388), so the UI keys answers by id verbatim.
 * Returns [] (⇒ the caller denies the whole ask) when nothing is answerable, INCLUDING when
 * two questions share the same text: the text-keyed answer map cannot represent both, so a
 * partial answer would silently satisfy/overwrite the twin. Exported for tests. */
function isBackgroundCapableLaunch(name: string, input?: Record<string, Json>): boolean {
  if (name === "Agent" || name === "Task") return input?.run_in_background !== false;
  if (name === "Bash" || name === "PowerShell") return input?.run_in_background === true;
  return name === "Monitor" || name === "Workflow";
}

function backgroundLaunchType(name: string): DriverBackgroundLaunchType {
  if (name === "Agent" || name === "Task") return "agent";
  if (name === "Bash" || name === "PowerShell") return "shell";
  if (name === "Monitor") return "monitor";
  if (name === "Workflow") return "workflow";
  return "unknown";
}

function driverBackgroundJob(task: PendingBackgroundTask): DriverBackgroundJob {
  return {
    id: task.id,
    ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
    launchType: task.launchType,
    startedAt: task.startedAt,
    ...(task.outputFile ? { outputFile: task.outputFile } : {}),
  };
}

export function normalizeQuestions(input: Json): AgentQuestion[] {
  const raw = Array.isArray(input?.questions) ? input.questions : [];
  if (raw.some((question: Json) => question?.multiSelect === true && question?.allowOther === true)) {
    return [];
  }
  const out: AgentQuestion[] = raw
    .filter((q: Json) => typeof q?.question === "string" && q.question)
    .map((q: Json) => ({
      id: q.question as string,
      header: typeof q.header === "string" ? q.header : undefined,
      question: q.question as string,
      multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o: Json) => typeof o?.label === "string" && o.label)
        .map((o: Json) => ({
          label: o.label as string,
          description: typeof o.description === "string" ? o.description : undefined,
        })),
    }));
  const ids = new Set(out.map((q) => q.id));
  if (ids.size !== out.length) return [];
  // A question with zero valid options is unanswerable under the multiple-choice contract —
  // the card could be dismissed but never submitted. One bad question poisons the whole ask.
  if (out.some((q) => q.options.length === 0)) return [];
  return out;
}

/** Bounded human-readable rendering of a tool's input for the approval card (the trust
 * surface). Known tools render their most meaningful field (the command, the file path +
 * content excerpt); everything else falls back to pretty JSON. Exported for tests. */
export function renderApprovalInput(toolName: unknown, input: Json): string | undefined {
  if (input == null || typeof input !== "object") return undefined;
  const cap = (s: string) => truncate(s, 2000);
  try {
    if (toolName === "Bash" && typeof input.command === "string") return cap(input.command);
    if ((toolName === "Write" || toolName === "Edit") && typeof input.file_path === "string") {
      const body =
        typeof input.content === "string"
          ? input.content
          : typeof input.new_string === "string"
            ? input.new_string
            : "";
      return cap(body ? `${input.file_path}\n---\n${body}` : String(input.file_path));
    }
    return cap(JSON.stringify(input, null, 2));
  } catch {
    return undefined;
  }
}

/** Content-bounded selectors that a scoped control-plane policy may match. Unknown shapes expose
 * no selector, so an allow rule cannot broaden itself from unparsed free-form input. */
export { approvalScopeContext } from "../approval-scope.js";

function contentToText(content: Json): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: Json) => (typeof c === "string" ? c : (c?.text ?? ""))).join("");
  return "";
}

function toolTitle(name: string, input?: Record<string, Json>): string {
  // Model-invoked skills and user `/name` skills both arrive as this one tool with the same input.
  if (name === "Skill") return skillToolTitle(input?.skill, input?.args);
  if (input) {
    if (typeof input.file_path === "string") return `${name}: ${input.file_path}`;
    if (typeof input.command === "string") return `${name}: ${String(input.command).slice(0, 60)}`;
    if (typeof input.path === "string") return `${name}: ${input.path}`;
    if (typeof input.pattern === "string") return `${name}: ${input.pattern}`;
  }
  return name;
}

function boundedSubagentLabel(value: Json, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  return truncate(normalized, max);
}

/** Only the provider's explicit child role becomes compact identity. Task `description` is
 * task-authored prose, so it is deliberately excluded along with prompts/output/private ids. */
function structuredSubagentIdentity(name: string, input?: Record<string, Json>): {
  subagentName?: string;
  subagentRole?: string;
} {
  if ((name !== "Task" && name !== "Agent") || !input) return {};
  const subagentRole = boundedSubagentLabel(input.subagent_type, 48);
  return {
    ...(subagentRole ? { subagentRole } : {}),
  };
}

function toolKind(name: string): string {
  if (name === "Read" || name === "Glob" || name === "Grep") return "read";
  if (name === "Edit" || name === "Write" || name === "MultiEdit") return "edit";
  if (name === "Bash") return "execute";
  if (name === "WebFetch" || name === "WebSearch") return "fetch";
  if (name === "Task" || name === "Agent") return "agent";
  if (name === "Skill") return SKILL_TOOL_KIND;
  return "other";
}
