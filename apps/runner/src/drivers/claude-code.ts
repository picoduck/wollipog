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
 * "acceptEdits"/"plan"/"bypassPermissions" run non-interactively by a fixed rule.
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
import { killTree, spawnAgent, terminateDescendantBoundaries, trackPendingKill, type AgentProcess, type SpawnAgentOptions } from "../spawn.js";
import type {
  Driver,
  DriverBackgroundJob,
  DriverBackgroundLaunchType,
  DriverBackgroundTerminalJob,
  DriverCallbacks,
  DriverCommandInput,
  DriverOptions,
  DriverSteerInput,
  DriverSteerResult,
  PreparedDriverCommand,
  StopReason,
} from "./driver.js";
import { isProviderAuthenticationFailure } from "./provider-auth-failure.js";
import { readCompatibleEnv, type Environment } from "../env-compat.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export const CLAUDE_PERSISTENT_FLAG = "WOLLIPOG_CLAUDE_PERSISTENT";
export const CLAUDE_PERSISTENT_IDLE_MS = "WOLLIPOG_CLAUDE_PERSISTENT_IDLE_MS";
export const CLAUDE_PENDING_MAX_MS = "WOLLIPOG_CLAUDE_PENDING_MAX_MS";
export const LEGACY_CLAUDE_PERSISTENT_FLAG = "MAM_CLAUDE_PERSISTENT";
export const LEGACY_CLAUDE_PERSISTENT_IDLE_MS = "MAM_CLAUDE_PERSISTENT_IDLE_MS";
export const LEGACY_CLAUDE_PENDING_MAX_MS = "MAM_CLAUDE_PENDING_MAX_MS";
const DEFAULT_PERSISTENT_IDLE_MS = 60 * 60_000;
const MIN_PERSISTENT_IDLE_MS = 30_000;
const DEFAULT_PENDING_MAX_MS = 7 * 24 * 60 * 60_000;
const MAX_TIMER_MS = 0x7fffffff;
const GRACEFUL_STOP_MS = 5_000;
/** After killTree has had time to deliver its bounded native/WSL escalation, stop waiting for an
 * exit event from a wedged relay. This keeps the per-session retirement barrier finite. */
const FORCE_STOP_WAIT_MS = 6_500;
export const CLAUDE_GRACEFUL_STOP_BUDGET_MS = GRACEFUL_STOP_MS + FORCE_STOP_WAIT_MS;

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

interface PersistentTurn {
  id: number;
  promptText: string;
  images: PromptImage[];
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
  warnings: string[];
}

type CompatibleEnvironmentReader = (
  currentName: string,
  legacyName: string,
  warn: (warning: string) => void,
) => string | undefined;

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
    warnings,
  };
}

export function claudePersistentSettings(env: Environment): ClaudePersistentSettings {
  return persistentSettings((currentName, legacyName, warn) =>
    readCompatibleEnv(env, currentName, legacyName, warn));
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
    if (agentEnv[currentName] !== undefined || agentEnv[legacyName] !== undefined) {
      return readCompatibleEnv(agentEnv, currentName, legacyName, warn);
    }
    // Keep the raw process.env proxy: its name lookup is case-insensitive on Windows.
    return readCompatibleEnv(daemonEnv, currentName, legacyName, warn);
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

/**
 * Map a Claude permission mode to CLI flags. Exported for tests.
 * - "default": ask before every tool (stdio control protocol -> Allow/Reject UI).
 * - "auto": the classifier model reviews each action — it auto-approves safe ones and
 *   blocks risky ones inline (the agent is told and adapts). We keep the stdio control
 *   channel open so the headless turn streams and settles gracefully on a block rather
 *   than aborting.
 * - everything else: a fixed-rule mode passed straight through as --permission-mode.
 *
 * `interactive` modes stream the prompt over stdin (to answer approvals). `streamInput`
 * means the prompt is delivered as a stream-json user message rather than plain-text
 * stdin — required whenever there are images, since images ride as content blocks.
 */
export function claudePermissionArgs(
  mode: string,
  hasImages = false,
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
  // Fixed-rule modes normally use plain-text stdin; switch to stream-json input when images
  // are attached so they can be sent as content blocks.
  if (hasImages) {
    return { interactive: false, streamInput: true, args: ["--input-format", "stream-json", "--permission-mode", mode] };
  }
  return { interactive: false, streamInput: false, args: ["--permission-mode", mode] };
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
): string | null {
  if (!capabilities) return null;
  if (config.effort && !capabilities.effortLevels.includes(config.effort)) {
    return `Claude Code effort ${JSON.stringify(config.effort)} was not verified for this installation.`;
  }
  const mode = effectiveClaudePermissionMode(config);
  if (!(capabilities.permissionModes ?? []).includes(mode)) {
    return `Claude Code permission mode ${JSON.stringify(mode)} was not verified for this installation.`;
  }
  if (images.length && !capabilities.supportsImages) {
    return "Claude Code stream-json image input was not verified for this installation.";
  }
  return null;
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
  /** requestId -> the tool input to echo back on allow (stdio control protocol). */
  private readonly pendingApprovals = new Map<string, Json>();
  /** Claude's message_start id scoped by parent Task. Entries close on message_stop/result, so
   * provider block identity never becomes transcript-lifetime state. */
  private readonly streamingMessageIds = new Map<string, string>();
  /** Whether the active turn delivered assistant text as deltas. A successful result consumes this
   * flag into one content-free completion event; failures and interruptions never do. */
  private streamedAgentResponse = false;
  private hookCircuitReported = false;
  private hookCircuitOpenedAt: number | null = null;
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

  setConfig(config: SessionConfig): void {
    this.config = config;
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
        ],
        isolation: this.opts.isolation,
        containerAgentLaunch: true,
        cloudAgentLaunch: true,
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
    // Each turn names its own model: a turn that settles before any assistant record must not
    // inherit the previous turn's, which after a model switch would misattribute it.
    this.turnModel = null;
    const capabilityError = claudeCapabilityError(this.config, images ?? [], this.opts.capabilities);
    if (capabilityError) {
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
    return this.promptOneShot(text, images, slashCommand);
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
      const perm = claudePermissionArgs(effectiveClaudePermissionMode(cfg), imgs.length > 0);
      this.interactive = perm.interactive;
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
          ],
          isolation: this.opts.isolation,
          containerAgentLaunch: true,
          cloudAgentLaunch: true,
          descendantOwner: this.descendantOwner,
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
    if (this.activePersistentTurn) {
      this.cb.onEvent({ kind: "error", message: "Claude persistent transport received overlapping prompts." });
      return Promise.resolve("refusal");
    }
    this.clearIdleTimer();
    this.cancelled = false;
    this.pendingApprovals.clear();
    this.streamedAgentResponse = false;
    const promptText = slashCommand ? `/${slashCommand}${text ? " " + text : ""}`.trim() : text;
    return new Promise<StopReason>((resolve) => {
      const turn: PersistentTurn = {
        id: ++this.providerTurnSeq,
        promptText,
        images: images ?? [],
        resolve,
        settled: false,
        writeAcknowledged: false,
        launchAttempts: 0,
      };
      this.activePersistentTurn = turn;
      this.startPersistentTurn(turn);
    });
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
    const perm = claudePermissionArgs(effectiveClaudePermissionMode(cfg), true);
    const preparedArgs = this.preparedBaseArgs();
    this.interactive = perm.interactive;
    const fingerprint = JSON.stringify({
      cwd: this.cwd,
      model: cfg.model ?? null,
      effort: cfg.effort ?? null,
      permissionMode: effectiveClaudePermissionMode(cfg),
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
          ],
          isolation: this.opts.isolation,
          containerAgentLaunch: true,
          cloudAgentLaunch: true,
          descendantOwner: this.descendantOwner,
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
      this.persistentTransport = false;
      this.persistentFingerprint = null;
      if (this.disposed || this.intentionalPersistentStop) return;
      if (this.pendingBackgroundTasks.size > 0) this.markOrphaned("process_exit");
      const turn = this.activePersistentTurn;
      if (turn && !turn.settled) {
        this.handlePersistentFailure(`persistent claude exited${code == null ? "" : ` with code ${code}`}`, turn);
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

    const turn = this.activePersistentTurn;
    if (!turn) {
      this.observeBackgroundLifecycle(msg);
      if (msg.type === "rate_limit_event") {
        this.cb.onSubscriptionUsage?.({ provider: "claude", kind: "sparse", payload: msg });
      } else if (msg.type !== "system") {
        this.cb.onStderr(`ignored ${String(msg.type ?? "unknown")} outside an active Claude turn`);
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
    turn.settled = true;
    this.activePersistentTurn = null;
    this.pendingApprovals.clear();
    if (reason !== "cancelled") this.preparedBaseArgs();
    if (reason !== "refusal" && reason !== "cancelled") this.markSessionEstablished();
    if (reason !== "refusal" && reason !== "cancelled") this.settleUnverifiedBackgroundTasks();
    turn.resolve(reason);
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
      } else if (msg.subtype === "task_notification" && taskId) {
        const status = typeof msg.status === "string" ? msg.status.toLowerCase() : "";
        if (status === "completed" || status === "failed" || status === "killed") {
          this.completePendingTask(taskId, toolUseId, status);
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
      if (!this.pendingBackgroundTasks.has(artifact.id)) {
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

  private handlePersistentFailure(message: string, turn: PersistentTurn): void {
    if (turn.settled || this.activePersistentTurn !== turn) return;
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
      if (!turn.settled && this.activePersistentTurn === turn) {
        turn.settled = true;
        this.activePersistentTurn = null;
        turn.resolve("refusal");
      }
      return;
    }
    this.openPersistentCircuit(`${message}; persistent mode disabled for this session`, turn);
  }

  private openPersistentCircuit(message: string, turn: PersistentTurn): void {
    this.persistentCircuitOpen = true;
    if (this.opts.capabilities?.supportsSteering === true) this.cb.onSteeringAvailability?.(false);
    this.cb.onEvent({ kind: "error", message });
    this.stopPersistentTransport(false, "process_exit");
    if (!turn.settled && this.activePersistentTurn === turn) {
      turn.settled = true;
      this.activePersistentTurn = null;
      turn.resolve("refusal");
    }
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
    this.settleAllClaudeSteers("Claude steering transport closed before acknowledgement");
    this.unacknowledgedSteerMessages.clear();
    this.persistentGeneration += 1;
    if (cancelActive && this.activePersistentTurn && !this.activePersistentTurn.settled) {
      const turn = this.activePersistentTurn;
      turn.settled = true;
      this.activePersistentTurn = null;
      turn.resolve("cancelled");
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
    const env = { ...this.opts.env };
    delete env[CLAUDE_PERSISTENT_FLAG];
    delete env[CLAUDE_PERSISTENT_IDLE_MS];
    delete env[CLAUDE_PENDING_MAX_MS];
    delete env[LEGACY_CLAUDE_PERSISTENT_FLAG];
    delete env[LEGACY_CLAUDE_PERSISTENT_IDLE_MS];
    delete env[LEGACY_CLAUDE_PENDING_MAX_MS];
    if (env.CLAUDE_CODE_OAUTH_TOKEN) delete env.ANTHROPIC_API_KEY;
    return env;
  }

  /** Heal the exact managed settings path before every process and remove it after the session's
   * transport circuit opens. The persisted base args remain intact for restart diagnostics. */
  private preparedBaseArgs(): string[] {
    const prepared = prepareClaudeHookArgs(this.opts.args);
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
    return prepared.args;
  }

  cancel(): void {
    this.streamingMessageIds.clear();
    if (this.activePersistentTurn) {
      const turn = this.activePersistentTurn;
      this.activePersistentTurn = null;
      turn.settled = true;
      turn.resolve("cancelled");
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
      this.activePersistentTurn.settled = true;
      this.activePersistentTurn.resolve("cancelled");
      this.activePersistentTurn = null;
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
          this.pendingApprovals.set(msg.request_id, req.input ?? {});
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
              requestId: msg.request_id,
              questions,
            });
            return null;
          }
          // MCP tools (e.g. the conductor's mcp__manager__*) often arrive with no description;
          // fall back to the input JSON so the Allow/Reject card states WHAT will be applied,
          // not just which tool — a blind Allow button defeats confirm-before-apply.
          const detail = req.description ? String(req.description) : JSON.stringify(req.input ?? {});
          const title = req.tool_name ? `${req.tool_name}: ${truncate(detail, 80)}` : "Permission requested";
          this.cb.onEvent({
            kind: "permission_request",
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
            if (!parentId) this.streamedAgentResponse = true;
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
        const blocks: Json[] = msg.message?.content ?? [];
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
          if (!parentId) this.streamedAgentResponse = false;
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
  if (input) {
    if (typeof input.file_path === "string") return `${name}: ${input.file_path}`;
    if (typeof input.command === "string") return `${name}: ${String(input.command).slice(0, 60)}`;
    if (typeof input.path === "string") return `${name}: ${input.path}`;
    if (typeof input.pattern === "string") return `${name}: ${input.pattern}`;
  }
  return name;
}

function toolKind(name: string): string {
  if (name === "Read" || name === "Glob" || name === "Grep") return "read";
  if (name === "Edit" || name === "Write" || name === "MultiEdit") return "edit";
  if (name === "Bash") return "execute";
  if (name === "WebFetch" || name === "WebSearch") return "fetch";
  if (name === "Task" || name === "Agent") return "agent";
  return "other";
}
