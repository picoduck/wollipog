/**
 * Runner-side session orchestration. For each control-plane `start_session`:
 *  - optionally create an isolated git worktree,
 *  - spawn the agent and run the init -> session/new handshake,
 *  - drive prompt turns (serialized per session) and stream normalized events,
 *  - capture a worktree diff after each turn,
 *  - service prompt/cancel/stop/resolve_permission commands.
 *
 * Phase 2: every session is written through to the box's on-disk SessionStore (the source of
 * truth). On a prompt for a session not running in-process, the runner RESUMES it from the store
 * (re-spawns the agent with the persisted resumable id), so any dashboard can pick it up. A
 * best-effort per-session lock (held only while a turn is draining) keeps two runners from driving
 * the same session at once.
 */

import type {
  AgentCapabilities,
  AgentContext,
  AgentDriverKind,
  AgentSlashCommand,
  AcpRuntimeCapabilities,
  DurableSessionCommandErrorCode,
  ExternalSessionDescriptor,
  InvokeSessionCommandMessage,
  InterruptTurnResultReason,
  PromptImage,
  PromptImageInput,
  PromptImageReference,
  RunnerToControlPlane,
  SessionConfig,
  SessionCommandInvocationErrorCode,
  SessionEventPayload,
  SessionLaunchSpec,
  SessionStatus,
  ResolveSteeringAttemptMessage,
  ResolveSteeringAttemptResultMessage,
  SteerResultReason,
  SteerSessionMessage,
  SteerSessionResultMessage,
} from "@wollipog/protocol";
import { isPromptImageReference, PROTOCOL_VERSION, providerSupportsConversationFork } from "@wollipog/protocol";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { makeDriver, type Driver } from "./drivers/factory.js";
import type { DriverBackgroundWorkUpdate, DriverSteerResult, StopReason } from "./drivers/driver.js";
import { CodexAppServerResumeError } from "./drivers/codex-app-server.js";
import { BoxAdmission, type AdmissionRequest } from "./box-admission.js";
import { discoverIncompleteClaudeTasks, discoverIncompleteClaudeTasksInContext } from "./claude-background-work.js";
import { DEFAULT_MAX_CONCURRENT_SESSIONS } from "./config.js";
import type { RunnerAdmissionPolicy, RunnerExecutionIsolation } from "./config.js";
import { executionTargetLaunchError } from "./execution-target.js";
import type { ContainerTargetRegistry } from "./container-target.js";
import type { CloudTargetRegistry } from "./cloud-target.js";
import {
  cloneExecutionIsolationState,
  migrateExecutionIsolationState,
  providerStateKey,
  removeExecutionIsolationState,
  resolveExecutionIsolation,
  verifyExecutionIsolationForkState,
} from "./execution-isolation.js";
import type { SpawnIsolation } from "./spawn.js";
import { ProviderHomeLeaseRegistry } from "./provider-home-lease.js";
import {
  ProviderStateCleanupJournal,
  reconcileProviderState,
  retryProviderStateCleanup,
} from "./provider-state-reconciliation.js";
import {
  checkpointRefOwnershipKey,
  CheckpointRefOwnershipLedger,
  type CheckpointRefOwnershipClaim,
  type CheckpointRefOwnershipRecord,
} from "./checkpoint-ref-ownership.js";
import { anchorForkRef, anchorTurnRef, captureWorktreeTree, deleteTurnRef, deleteTurnRefs, isMissingGitRepositoryError, readTurnRef, resetWorktreeIndex, restoreWorktreeToTree, synchronizeCheckpointRefs, withGitExecutionContext } from "./git-ops.js";
import { SessionStore, isAdoptedSession, metaToSnapshot, type SessionMeta } from "./session-store.js";
import { SessionCommandAuthorityRegistry } from "./session-command-authority.js";
import {
  createWorktree,
  createWorktreeFromTree,
  captureTurnDiff,
  isGitRepo,
  nativeRepositoryPathIsUnavailable,
  removeWorktree,
  worktreeHead,
  worktreeDiff,
  WorktreeCleanupJournal,
  type WorktreeCleanupRecord,
  type WorktreeHandle,
} from "./worktree.js";

type Send = (msg: RunnerToControlPlane) => void;
type Logger = (msg: string) => void;
export type AcpContextResolver = (spec: SessionLaunchSpec) => SessionLaunchSpec["acpSessionContext"];
export type PromptImageResolver = (sessionId: string, references: PromptImageReference[]) => Promise<PromptImage[]>;

export interface SessionLaunchPreparation {
  /** True only when this launch performed a fresh, authoritative provider catalog read. */
  sessionCommandCatalogFresh?: boolean;
  /** Exact runner-local discovery boundary used to decide whether a live catalog may reuse IDs. */
  sessionCommandCatalogProvenance?: string;
}

function sameSlashCommandCatalog(
  left: readonly AgentSlashCommand[] | undefined,
  right: readonly AgentSlashCommand[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((command, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      command.name === candidate.name &&
      command.source === candidate.source &&
      command.description === candidate.description &&
      command.argumentHint === candidate.argumentHint;
  });
}

function agentContextKey(context: AgentContext): string {
  return context.kind === "native" ? "native" : `wsl:${context.distro}`;
}

function targetIdentity(target: SessionMeta["executionTarget"]): string {
  return target ? `${target.adapter}:${target.id}` : "host:";
}

function canCarrySlashCommandCatalog(
  prior: SessionMeta | undefined,
  next: {
    driver: AgentDriverKind;
    context: AgentContext;
    repoPath: string;
    root: string;
    target: SessionMeta["executionTarget"];
  },
): boolean {
  const provenance = prior?.sessionSlashCommandProvenance;
  if (!prior || !provenance || prior.driver !== next.driver || prior.repoPath !== next.repoPath ||
      agentContextKey(prior.context) !== agentContextKey(next.context) ||
      targetIdentity(prior.executionTarget) !== targetIdentity(next.target)) return false;
  const priorAdapter = prior.executionTarget?.adapter ?? "host";
  return provenance.driver === prior.driver &&
    provenance.context === agentContextKey(prior.context) &&
    provenance.root === (prior.worktreePath ?? prior.repoPath) &&
    provenance.root === next.root &&
    provenance.targetAdapter === priorAdapter &&
    provenance.targetId === (prior.executionTarget?.id ?? null) &&
    provenance.includeUserCommands === (priorAdapter === "host") &&
    provenance.handoffManifestDigest === (prior.executionHandoff?.manifestDigest ?? null);
}

/** Optional lifecycle attached only to protocol-v53 durable automation commands. Ordinary UI
 * starts/prompts keep the existing fire-and-forget path. Implementations persist every transition
 * before emitting the corresponding runner receipt. */
export interface DurableCommandLifecycle {
  readonly commandId: string;
  queued(): void;
  started(userEventSeq?: number): void;
  completed(): void;
  failed(error: string, code?: DurableSessionCommandErrorCode): void;
  uncertain(error: string): void;
}

/** Dedicated receipt lifecycle for one manual provider command. It deliberately has no automation
 * commandId and cannot be stored in the automation lifecycle slot. */
export interface SessionCommandInvocationLifecycle {
  readonly invocationId: string;
  queued(): void;
  started(userEventSeq?: number): void;
  completed(): void;
  failed(error: string, code?: SessionCommandInvocationErrorCode): void;
  uncertain(error: string): void;
}

/** Resolve the box's CURRENT launch params for a driver/context (null = no such agent). Injected by
 * the daemon (closing over its live agent list) so a read-only adopt can heal once the box gains a
 * matching agent — discovery finishing after the adopt, or the user installing the CLI later. */
export type LaunchResolver = (
  driver: AgentDriverKind,
  context: AgentContext,
) => { command: string; args: string[]; env: Record<string, string> } | null;

interface QueuedPrompt {
  /** Stable id so the dashboard can cancel this specific queued prompt before it starts. */
  id: string;
  /** Monotonic runner-local order. It survives reservation/restoration and app-server recovery. */
  ordinal?: number;
  text: string;
  images: PromptImageInput[];
  slashCommand?: string;
  /** The model/effort/permission config this prompt was SENT with — applied when it dequeues,
   * not at enqueue time. Two queued sends with different configs must each run under their own
   * (an earlier prompt must never inherit a later prompt's looser permission mode), and a
   * canceled queued prompt's config never applies at all. */
  config?: SessionConfig;
  durable?: DurableCommandLifecycle;
  /** Runner-authorized manual command metadata. Name and mode came from live authority, never the
   * API body, and are re-resolved immediately before provider invocation. */
  sessionCommand?: {
    invocationId: string;
    submissionId: string;
    providerCommandId: string;
    catalogRevision: string;
    expectedExecutionMode: "passthrough" | "structured";
    lifecycle: SessionCommandInvocationLifecycle;
  };
  /** Runner-owned continuation used only to consume orphaned Claude task notifications. */
  syntheticRecovery?: boolean;
}

interface PreparedCommandCheckpoint {
  turn: number;
  tree: string | null;
  priorTurnCount: number;
  priorLastTurnBaseTree: string | null | undefined;
  priorTurnRef: string | null;
  ownerHash?: string;
  anchored: boolean;
  accountingApplied: boolean;
}

interface CheckpointRefMaintenanceEntry {
  ownership: CheckpointRefOwnershipClaim;
  promise: Promise<void>;
}

type SteeringRequest = Omit<SteerSessionMessage, "type" | "requestId">;
type SteeringResult = Omit<SteerSessionResultMessage, "type" | "requestId">;
type ResolveSteeringRequest = Omit<ResolveSteeringAttemptMessage, "type" | "requestId">;
type ResolveSteeringResult = Omit<ResolveSteeringAttemptResultMessage, "type" | "requestId">;
type SteeringEligibility =
  | { eligible: true }
  | { eligible: false; reason: SteerResultReason; message: string };

interface SteeringOperation {
  request: SteeringRequest;
  requestHash: string;
  ordinal: number;
  effectiveConfig: SessionConfig;
  deadlineAt: number;
  source?: QueuedPrompt;
  sourceRestored?: boolean;
  cancelRequested: boolean;
  lifecycleCancelled?: boolean;
  providerStarted: boolean;
  fenceInstalled: boolean;
  fenceEntry?: ActiveSession;
  settled: boolean;
  references: number;
  promise: Promise<SteeringResult>;
  resolve: (result: SteeringResult) => void;
  lifecyclePromise: Promise<void>;
  resolveLifecycle: () => void;
  result?: SteeringResult;
  resolved?: boolean;
  resolution?: ResolveSteeringResult;
  lastAccessOrdinal: number;
}

interface ActiveSession {
  sessionId: string;
  client: Driver;
  repoPath: string;
  cwd: string;
  worktree: WorktreeHandle | null;
  context: AgentContext;
  status: SessionStatus;
  /** True only after initialize + new/resume + driver-owned initial configuration restoration.
   * ACP may publish catalog notifications while session/new is still resolving; those remain
   * display-only until this fence opens. */
  providerReady: boolean;
  /** A prompt turn is in flight (the agent session can only run one at a time). */
  running: boolean;
  /** A cancel arrived before the agent process existed (during the pre-prompt turn snapshot) —
   * the driver-level cancel has nothing to kill there, so the next turn start honors this flag. */
  cancelRequested?: boolean;
  /** A v71 turn-only interruption arrived after this turn was dequeued. This is intentionally
   * separate from legacy cancelRequested so old control planes retain their stopped semantics. */
  interruptRequested?: boolean;
  /** Runner-assigned id of the dequeued turn. A coordinated interrupt must match this exact id. */
  activeTurnId?: string;
  /** A successful turn-only interruption preserves the remaining FIFO but does not run it until
   * a later explicit prompt unambiguously asks the session to continue. */
  holdQueuedPromptsAfterInterrupt?: boolean;
  /** Distinct invocation ids are rebuilt once from the durable event log when a tool guardrail is
   * armed, then maintained in memory on normalized tool events. */
  toolCallIds?: Set<string>;
  /** A runner-side threshold cancelled this turn. Queued prompts remain held until CP re-arms. */
  governanceTripped?: "cost_budget" | "max_tool_calls";
  /** Continue can arrive while driver cancellation is still unwinding (especially for live usage
   * events). Defer release until drain() has observed the trip and released the session lock. */
  governanceRearmPending?: "resume" | "cost_budget" | "max_tool_calls";
  /** FIFO of prompts awaiting their turn. */
  queue: QueuedPrompt[];
  /** Applied config of the dequeued provider turn; steering cannot alter it. */
  activeTurnConfig?: SessionConfig;
  /** A turn may finish while steering delivery is unresolved. These ids fence the next dequeue. */
  steerFenceIds: Set<string>;
  /** Promoted queue items are absent from `queue` but remain cancelable while reserved. */
  reservedPromotions: Map<string, SteeringOperation>;
  /** Drain keeps the cross-process store lock while waiting for every steering fence to settle. */
  steerFenceWaiters: Set<() => void>;
  /** Latched when authoritative history rejects a complete append. No later callback may attempt
   * another history write or overwrite the explicit failed state. */
  historyIntegrityFailure?: string;
  /** Durable owner of the currently dequeued turn, used when a driver callback trips the latch. */
  currentDurable?: DurableCommandLifecycle;
  /** Manual provider commands are also non-steerable, but never alias automation ownership. */
  currentSessionCommand?: SessionCommandInvocationLifecycle;
  /** The current manual command crossed its durable started boundary and may have reached the
   * provider. History-integrity containment must settle this lane as uncertain, never rejected. */
  sessionCommandProviderStarted?: boolean;
}

/** Capability-derived resume gate. ACP must have proven stable resume or load in its last live
 * handshake; driver identity alone is never enough. */
function canResumeSession(meta: SessionMeta): boolean {
  if (meta.driver === "acp") {
    return meta.acpCapabilities?.sessionResume === true || meta.acpCapabilities?.loadSession === true;
  }
  return meta.driver === "claude-code" || meta.driver === "codex" || meta.driver === "codex-app-server";
}

function mergeRecoveredBackgroundTaskIds(current: string[] | undefined, additions: Iterable<string>): string[] {
  // These ids are a billing-safety boundary, not a cache: dropping an old tombstone while its
  // provider artifact remains would make the same unattended recovery eligible again.
  return [...new Set([...(current ?? []), ...additions])];
}

function withoutRecoveredBackgroundTaskIds(current: string[] | undefined, observed: Iterable<string>): string[] {
  const remove = new Set(observed);
  return (current ?? []).filter((id) => !remove.has(id));
}

function automaticClaudeRecoveryAllowed(meta: SessionMeta): boolean {
  return !isAdoptedSession(meta) || meta.adoptedBackgroundRecoveryAuthorized === true;
}

/** A transport circuit opening invalidates the session-scoped human-elicitation claim immediately.
 * Discovery remains unchanged; successful launch provisioning can add `hook` back on a later turn. */
function withoutHookElicitation(capabilities?: AgentCapabilities): AgentCapabilities | undefined {
  if (!capabilities?.elicitation) return capabilities;
  let changed = false;
  const elicitation = Object.fromEntries(
    Object.entries(capabilities.elicitation).map(([mode, transports]) => {
      const remaining = (transports ?? []).filter((transport) => transport !== "hook");
      if (remaining.length !== (transports ?? []).length) changed = true;
      return [mode, remaining.length > 0 ? remaining : ["none"]];
    }),
  ) as NonNullable<AgentCapabilities["elicitation"]>;
  return changed ? { ...capabilities, elicitation } : capabilities;
}

function withHookElicitation(capabilities?: AgentCapabilities): AgentCapabilities | undefined {
  if (!capabilities?.elicitation) return capabilities;
  let changed = false;
  const permissionModes = new Set(capabilities.permissionModes ?? []);
  const elicitation = Object.fromEntries(
    Object.entries(capabilities.elicitation).map(([mode, transports]) => {
      const remaining = (transports ?? []).filter((transport) => transport !== "none");
      if (permissionModes.has(mode) && !remaining.includes("stdio-control") &&
          !remaining.includes("hook")) {
        remaining.push("hook");
        changed = true;
      }
      return [mode, remaining.length > 0 ? remaining : ["none"]];
    }),
  ) as NonNullable<AgentCapabilities["elicitation"]>;
  return changed ? { ...capabilities, elicitation } : capabilities;
}

/** Derive a short session title from a prompt: first non-empty line, whitespace-collapsed, truncated. */
function titleFromPrompt(text: string): string {
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
  const clean = firstLine.replace(/\s+/g, " ").trim();
  return clean.length > 80 ? clean.slice(0, 79).trimEnd() + "…" : clean;
}

/** Refresh a held lock well within its stale window so a long turn never looks abandoned. */
const LOCK_REFRESH_MS = 20_000;
const HISTORY_MAINTENANCE_MS = 5 * 60 * 1_000;

/** Hard cap on not-yet-started prompts per session (each holds full text + image payloads). */
const MAX_QUEUED_PROMPTS = 100;

/** Byte budget for a session's queue — a count cap alone lets 100 × 32MB pasted-screenshot
 * prompts sit in runner memory. Text chars + base64 image chars, both ~1 byte each. */
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const PROVIDER_CLOSE_TIMEOUT_MS = 5_000;
const CHECKPOINT_REF_MAINTENANCE_CONCURRENCY = 4;
const ORPHAN_RECOVERY_RETRY_MS = 30_000;
const ORPHAN_RECOVERY_SCAN_DEBOUNCE_MS = 30_000;
const ORPHAN_RECOVERY_PROMPT =
  "Continue after runner restart: consume queued background-task notifications, reconcile every orphaned task, and resume or report unfinished work without waiting for another user message.";

function queuedPromptBytes(text: string, images: PromptImageInput[]): number {
  return text.length + images.reduce((n, image) => n + (
    isPromptImageReference(image)
      ? image.sizeBytes + image.artifactId.length + image.mimeType.length + image.sha256.length
      : image.data.length
  ), 0);
}

function decodedBase64Bytes(data: string): number {
  if (!data.length) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}

function retainedSteeringPayloadBytes(text: string, images: PromptImageInput[]): number {
  return Buffer.byteLength(text, "utf8") + images.reduce((total, image) => total + (
    isPromptImageReference(image) ? image.sizeBytes : decodedBase64Bytes(image.data)
  ), 0);
}

const STEERING_SUBMISSION_TIMEOUT_MS = 10_000;
const MAX_STEERING_TERMINALS_PER_SESSION = 1_024;
const MAX_UNRESOLVED_STEERING_ATTEMPTS_PER_SESSION = 50;
const MAX_STEERING_RESULT_MESSAGE_CHARS = 4_096;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalize(item)]));
}

function steeringRequestHash(request: SteeringRequest): string {
  return createHash("sha256").update(JSON.stringify(canonicalize({
    sessionId: request.sessionId,
    turnId: request.turnId,
    text: request.text ?? null,
    images: request.images ?? [],
    promotePromptId: request.promotePromptId ?? null,
  }))).digest("hex");
}

function normalizedConfig(config: SessionConfig | undefined): SessionConfig {
  return {
    ...(config?.model ? { model: config.model } : {}),
    ...(config?.effort ? { effort: config.effort } : {}),
    ...(config?.permissionMode ? { permissionMode: config.permissionMode } : {}),
    ...(config?.costBudgetUsd != null ? { costBudgetUsd: config.costBudgetUsd } : {}),
    ...(config?.maxToolCalls != null ? { maxToolCalls: config.maxToolCalls } : {}),
  };
}

function sessionCommandAuthorizationError(
  code: "COMMAND_CATALOG_STALE" | "COMMAND_UNAVAILABLE" | "COMMAND_MODE_UNSUPPORTED",
): string {
  if (code === "COMMAND_CATALOG_STALE") return "the provider command catalog changed; choose the command again";
  if (code === "COMMAND_MODE_UNSUPPORTED") return "the provider command execution mode is not supported";
  return "the provider command is no longer available";
}

function configsEqual(left: SessionConfig | undefined, right: SessionConfig | undefined): boolean {
  return JSON.stringify(normalizedConfig(left)) === JSON.stringify(normalizedConfig(right));
}

export class SessionManager {
  private readonly active = new Map<string, ActiveSession>();
  /** Stable ordering spans active queues, promotion reservations, and app-server recovery queues. */
  private readonly nextQueueOrdinalBySession = new Map<string, number>();
  /** Per-session single-consumer steering lane. Admission remains synchronous; provider work does not. */
  private readonly steeringLanes = new Map<string, SteeringOperation[]>();
  private readonly steeringLaneRunning = new Set<string>();
  /** Live-process idempotency. The control plane remains the durable lifetime authority. */
  private readonly steeringRegistry = new Map<string, Map<string, SteeringOperation>>();
  private steeringAccessOrdinal = 0;
  /** Test seam; production always uses the mandatory whole-submission ten-second deadline. */
  private steeringSubmissionTimeoutMs = STEERING_SUBMISSION_TIMEOUT_MS;
  /** Sessions with a file rewind in flight. The shared store lock is REENTRANT for this
   * process, so it cannot serialize a same-runner prompt against a rewind — a prompt landing
   * mid-restore would snapshot a half-restored tree and run the agent over it. */
  private readonly rewinding = new Set<string>();
  /** Provider fork setup reads source history/HEAD and must not race a same-process prompt. */
  private readonly forking = new Set<string>();
  /** Lock owner unique to THIS process — two runner processes that share a runnerId must not be
   * treated as the same lock holder (else they'd re-enter each other's locks). */
  private readonly lockOwner: string;
  /** Lock-refresh timers, keyed by session, running while a turn is draining. */
  private readonly lockTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Prompts known not to have reached turn/start when app-server crashed. A recovery launch
   * consumes these; the in-flight prompt is deliberately absent because delivery is ambiguous. */
  private readonly recoveryQueues = new Map<string, QueuedPrompt[]>();
  /** Prompts received after a session was materialized but before capacity admission. They must
   * join the original launch instead of starting a competing resume generation. Durable command
   * lifecycles make this in-memory FIFO recoverable after a runner restart. */
  private readonly preLaunchQueues = new Map<string, QueuedPrompt[]>();
  private readonly recoveryLaunching = new Set<string>();
  private readonly orphanRecoveryLaunching = new Set<string>();
  private readonly orphanRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly orphanDiscoveryLaunching = new Set<string>();
  private lastOrphanRecoveryScanAt = 0;
  private orphanRecoveryScanTimer: ReturnType<typeof setTimeout> | null = null;
  /** Provider logout is asynchronous; fence prompts and other provider/worktree operations. */
  private readonly loggingOut = new Set<string>();
  /** Explicit stop waits for ACP session/close before this session may launch again. */
  private readonly closing = new Map<string, { client: Driver; promise: Promise<void> }>();
  private readonly deleting = new Set<string>();
  /** Process-lifetime tombstone: a late start command/continuation may never recreate a deleted id. */
  private readonly deleted = new Set<string>();
  private readonly deletedExpiry = new Map<string, ReturnType<typeof setTimeout>>();
  /** Every start captures one generation; delete/restart invalidates all older async continuations. */
  private readonly launchGenerations = new Map<string, number>();
  /** Only start() generations own the admission queue. Resume/recovery generations use their
   * existing dedicated queues and must never strand a prompt in preLaunchQueues. */
  private readonly preLaunchAdmissionGenerations = new Map<string, number>();
  /** Last generation ever begun for this live session id. Unlike launchGenerations, this survives
   * a fast replacement finishing so an older continuation can still identify that replacement. */
  private readonly latestLaunchGenerations = new Map<string, number>();
  private nextLaunchGeneration = 0;
  /** Ephemeral approval timers. Only durations leave the runner; request/session ids never do. */
  private readonly approvalStarted = new Map<string, number>();
  private readonly cleanupJournal: WorktreeCleanupJournal;
  private readonly providerStateCleanupJournal: ProviderStateCleanupJournal;
  private readonly providerStateMigrations = new Map<string, Promise<void>>();
  private readonly checkpointRefOwnership: CheckpointRefOwnershipLedger;
  /** Startup checkpoint migration may touch the same shared refs as deletion. Keep its promise
   * until it settles so cleanup cannot enumerate refs before migration creates a counterpart. */
  private readonly checkpointRefSyncs = new Map<string, CheckpointRefMaintenanceEntry>();
  /** Exact-session deletions from cleanup and rollback-orphan recovery share one lane. */
  private readonly checkpointRefDeletions = new Map<string, CheckpointRefMaintenanceEntry>();
  /** Keep session-id reuse fenced through durable ownership removal, not only Git deletion. */
  private readonly checkpointRefReclaims = new Map<string, CheckpointRefMaintenanceEntry>();
  /** Startup migration and rollback reclaim share one small process-admission lane so a large
   * durable store cannot fan out an unbounded number of native Git or WSL subprocesses. */
  private checkpointRefMaintenanceActive = 0;
  private readonly checkpointRefMaintenanceQueue: Array<() => Promise<void>> = [];
  private readonly cloudHandoffOwners = new Map<
    string,
    { targetId: string; handoffKey: string; launchGeneration: number }
  >();
  /** Fork targets are journaled before their session row exists. Keep both exact cleanup and
   * age-based reconciliation away from those partitions until the fork publishes or rolls back. */
  private readonly forkingTargets = new Set<string>();
  private readonly boxAdmission: BoxAdmission;
  private readonly stateDir: string;
  private readonly providerStateReconcileTimer: ReturnType<typeof setInterval>;
  private readonly historyMaintenanceTimer: ReturnType<typeof setInterval>;
  private historyMaintenanceKickoff: ReturnType<typeof setTimeout> | null = null;
  private historyMaintenanceRunning = false;
  private providerStateReconciling = false;
  private admissionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Box-wide process admission. A reservation starts immediately before driver launch and is
   * released on stop/exit/failure. Oldest-eligible selection plus bounded bypass prevents both
   * head-of-line capacity waste and starvation. */
  private readonly admitted = new Set<string>();
  private readonly admissionQueue: Array<{
    request: AdmissionRequest;
    bypasses: number;
    resolve: (admitted: boolean) => void;
  }> = [];
  /** Worktree preparation intentionally precedes process admission so an initial Native TUI can
   * materialize while the provider is capacity-queued. Bound those git subprocesses separately. */
  private readonly worktreePreparationLimit: number;
  private readonly worktreePreparationAdmission: BoxAdmission;
  private readonly worktreePreparations = new Set<number>();
  private readonly worktreePreparationKeys = new Map<number, string>();
  private readonly worktreePreparationSessions = new Map<number, string>();
  private readonly worktreePreparationQueue: Array<{
    sessionId: string;
    launchGeneration: number;
    resolve: (acquired: boolean) => void;
  }> = [];
  private worktreePreparationRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  /** Test seam for the expensive subprocess; production always uses createWorktree. */
  private createSessionWorktree: typeof createWorktree = createWorktree;
  /** Test seam keeps provider-home discovery deterministic without writing into a real Claude home. */
  private discoverClaudeTasks: typeof discoverIncompleteClaudeTasks = discoverIncompleteClaudeTasks;
  /** Async seam covers WSL markerless recovery without blocking runner startup. */
  private discoverClaudeTasksInContext: typeof discoverIncompleteClaudeTasksInContext = discoverIncompleteClaudeTasksInContext;
  private readonly sessionCommandAuthority = new SessionCommandAuthorityRegistry();
  private readonly providerHomeLeases?: ProviderHomeLeaseRegistry;

  constructor(
    private send: Send,
    private readonly log: Logger,
    private readonly store: SessionStore,
    private readonly runnerId: string,
    private readonly resolveLaunch?: LaunchResolver,
    private readonly createDriver: typeof makeDriver = makeDriver,
    private readonly dataDir?: string,
    private readonly maxConcurrentSessions = DEFAULT_MAX_CONCURRENT_SESSIONS,
    private readonly onAgentAuthUpdate?: (
      agentId: string,
      update: { status?: "authenticated" | "unauthenticated"; capabilities?: AcpRuntimeCapabilities },
    ) => void,
    private readonly resolveAcpContext?: AcpContextResolver,
    private readonly admissionPolicy: RunnerAdmissionPolicy = { agentLimits: {}, agentWeights: {} },
    private readonly executionIsolation: RunnerExecutionIsolation = { mode: "provider", network: "inherit" },
    private readonly resolveIsolation: typeof resolveExecutionIsolation = resolveExecutionIsolation,
    private readonly cloneIsolationState: typeof cloneExecutionIsolationState = cloneExecutionIsolationState,
    private readonly removeIsolationState: typeof removeExecutionIsolationState = removeExecutionIsolationState,
    private readonly migrateIsolationState: typeof migrateExecutionIsolationState = migrateExecutionIsolationState,
    private readonly verifyIsolationForkState: typeof verifyExecutionIsolationForkState = verifyExecutionIsolationForkState,
    private readonly isolationContexts: AgentContext[] = [],
    /** Refresh runner-local launch material immediately before every provider process spawn. */
    private readonly prepareLaunch?: (
      meta: SessionMeta,
    ) => void | SessionLaunchPreparation | Promise<void | SessionLaunchPreparation>,
    /** Materialize verified references only at the provider edge. */
    private readonly resolvePromptImages?: PromptImageResolver,
    private readonly containerTargets?: ContainerTargetRegistry,
    private readonly cloudTargets?: CloudTargetRegistry,
    private readonly controlPlaneProtocolVersion: () => number | null = () => PROTOCOL_VERSION,
    private readonly runnerOwnerHash?: string,
  ) {
    this.lockOwner = `${runnerId}#${randomUUID()}`;
    this.providerHomeLeases = runnerOwnerHash ? new ProviderHomeLeaseRegistry(runnerOwnerHash) : undefined;
    this.stateDir = dataDir ?? join(store.rootPath(), ".runner-data");
    this.cleanupJournal = new WorktreeCleanupJournal(this.stateDir);
    this.providerStateCleanupJournal = new ProviderStateCleanupJournal(this.stateDir);
    this.checkpointRefOwnership = new CheckpointRefOwnershipLedger(this.stateDir);
    this.boxAdmission = new BoxAdmission(this.stateDir, maxConcurrentSessions);
    this.worktreePreparationLimit = Math.max(1, maxConcurrentSessions);
    this.worktreePreparationAdmission = new BoxAdmission(
      join(this.stateDir, "worktree-preparation"),
      this.worktreePreparationLimit,
    );
    this.providerStateReconcileTimer = setInterval(() => void this.reconcileProviderStateStorage(), 60 * 60 * 1000);
    this.providerStateReconcileTimer.unref?.();
    this.historyMaintenanceTimer = setInterval(() => this.runHistoryMaintenance(), HISTORY_MAINTENANCE_MS);
    this.historyMaintenanceTimer.unref?.();
  }

  private checkpointOwnerHash(meta: Pick<SessionMeta, "checkpointRefVersion">): string | undefined {
    if (meta.checkpointRefVersion === undefined) return undefined;
    if (meta.checkpointRefVersion !== 2) throw new Error("unsupported checkpoint ref layout");
    if (!this.runnerOwnerHash) throw new Error("owned checkpoint layout requires an attested runner owner");
    return this.runnerOwnerHash;
  }

  private checkpointOwnership(meta: Pick<SessionMeta, "sessionId" | "repoPath" | "context" | "checkpointRefVersion">): CheckpointRefOwnershipClaim {
    const ownerHash = this.checkpointOwnerHash(meta);
    return { sessionId: meta.sessionId, repoPath: meta.repoPath, context: meta.context, ...(ownerHash ? { ownerHash } : {}) };
  }

  /** Swap the upstream send fn when the control-plane socket reconnects. */
  setSend(send: Send): void {
    this.send = send;
  }

  /** A standalone Agent TUI bypasses structured-driver isolation but shares provider HOME. */
  acquireAgentTuiProviderHome(meta: SessionMeta): void {
    this.providerHomeLeases?.acquire({
      driver: meta.driver,
      command: meta.command,
      context: meta.context,
      env: meta.env,
    });
  }

  /** Re-scan durable Claude work after each successful control-plane registration/reconnect. */
  recoverAllOrphanedWork(): void {
    if (this.shuttingDown) return;
    const now = Date.now();
    const remaining = ORPHAN_RECOVERY_SCAN_DEBOUNCE_MS - (now - this.lastOrphanRecoveryScanAt);
    if (remaining > 0) {
      if (!this.orphanRecoveryScanTimer) {
        this.orphanRecoveryScanTimer = setTimeout(() => {
          this.orphanRecoveryScanTimer = null;
          this.recoverAllOrphanedWork();
        }, remaining);
        this.orphanRecoveryScanTimer.unref?.();
      }
      return;
    }
    this.lastOrphanRecoveryScanAt = now;
    for (const stored of this.store.listSessions()) {
      if (stored.status === "stopped") continue;
      const meta = this.discoverOrphanedClaudeWork(stored);
      const automatic = automaticClaudeRecoveryAllowed(meta);
      if (automatic && meta.orphanedWork && !meta.orphanedWork.recoveryAttemptedAt) {
        this.scheduleOrphanRecovery(meta.sessionId);
      } else {
        this.scheduleContextOrphanDiscovery(meta, automatic);
      }
    }
  }

  /** Session ids with a live agent process (reported on reconnect for resync). */
  liveSessionIds(): string[] {
    return [...this.active.keys()];
  }

  /** Phase 2: full metadata for every session the box holds (sent on register for hydration). */
  sessionSnapshots() {
    const protocolVersion = this.controlPlaneProtocolVersion();
    return this.store.snapshots(protocolVersion).map((snapshot) =>
      this.sessionCommandAuthority.overlaySnapshot(snapshot, protocolVersion));
  }

  private snapshot(meta: SessionMeta) {
    const protocolVersion = this.controlPlaneProtocolVersion();
    return this.sessionCommandAuthority.overlaySnapshot(metaToSnapshot(meta, protocolVersion), protocolVersion);
  }

  /** Revoke process-local command authority and immediately replace any executable coordinates at
   * the control plane with the persisted display-only catalog. */
  private revokeSessionCommandAuthority(sessionId: string): boolean {
    const revoked = this.sessionCommandAuthority.clear(sessionId);
    if (!revoked) return false;
    const displayOnly = this.store.readMeta(sessionId);
    if (displayOnly) {
      try {
        this.send({ type: "session_runtime_updated", snapshot: this.snapshot(displayOnly) });
      } catch (error) {
        this.log(`session command authority revocation publish failed for ${sessionId}: ${errText(error)}`);
      }
    }
    return true;
  }

  /** Phase 2: a session's event history from the store (control plane lazy-hydrates the timeline). */
  history(sessionId: string, afterSeq: number) {
    return this.store.readEvents(sessionId, afterSeq);
  }

  historyPage(
    sessionId: string,
    request: { afterSeq: number; limit: number; logEpoch?: number; throughSeq?: number },
  ) {
    return this.store.readEventPage(sessionId, request);
  }

  /** On startup, demote sessions left mid-flight (their agent process is gone) to `idle` so the
   * snapshots we report are honest — they remain resumable. */
  reconcileStore(): void {
    const pendingWorktreeCleanup = this.cleanupJournal.list();
    const currentCheckpointOwnershipKeys = new Set<string>();
    void this.reconcileProviderStateStorage();
    for (const m of this.store.listSessions()) {
      if (this.store.isDeleted(m.sessionId)) {
        void this.delete(m.sessionId).catch((error) => {
          this.log(`startup deletion reconciliation failed for ${m.sessionId}: ${errText(error)}`);
        });
        continue;
      }
      // The durable row's repository/context binding owns its checkpoint refs even while a live
      // session is between worktrees (for example, after interrupted or failed materialization).
      // Worktree presence gates mirroring, not ownership. Otherwise startup reclaim can silently
      // delete the still-live row's rewind and fork refs during that ordinary transient state.
      try {
        const expectedOwnership = this.checkpointOwnership(m);
        currentCheckpointOwnershipKeys.add(checkpointRefOwnershipKey(expectedOwnership));
        if (m.worktreePath) {
          const ownership = this.checkpointRefOwnership.claim(expectedOwnership);
          currentCheckpointOwnershipKeys.add(checkpointRefOwnershipKey(ownership));
          this.scheduleCheckpointRefSync(m, ownership);
        }
      } catch (error) {
        // One malformed/forward-version row must fail closed for its own refs without preventing
        // cleanup-journal replay and tombstone reconciliation for every other stored session.
        this.log(`checkpoint ref ownership claim failed for ${m.sessionId}: ${errText(error)}`);
      }
      let reconciled = m;
      if (m.driver === "claude-code" && m.status === "stopped") {
        reconciled = this.store.patchMeta(m.sessionId, {
          backgroundWorkState: undefined,
          pendingBackgroundTaskIds: [],
          orphanedWork: undefined,
        }) ?? m;
      } else if (m.driver === "claude-code" && m.backgroundWorkState === "running") {
        const recovered = new Set(m.recoveredBackgroundTaskIds ?? []);
        const pendingTaskIds = (m.pendingBackgroundTaskIds?.length ? m.pendingBackgroundTaskIds : ["unknown"])
          .filter((id) => !recovered.has(id));
        const marker = {
          ...(m.orphanedWork ?? { markedAt: Date.now(), reason: "process_exit" as const }),
          pendingTaskIds,
        };
        reconciled = this.store.patchMeta(m.sessionId, pendingTaskIds.length > 0
          ? { backgroundWorkState: "orphaned", pendingBackgroundTaskIds: pendingTaskIds, orphanedWork: marker }
          : { backgroundWorkState: "resumed", pendingBackgroundTaskIds: [], orphanedWork: undefined }) ?? m;
      } else {
        reconciled = this.discoverOrphanedClaudeWork(m);
      }
      const automatic = automaticClaudeRecoveryAllowed(reconciled);
      if (reconciled.status !== "stopped" && automatic && reconciled.orphanedWork && !reconciled.orphanedWork.recoveryAttemptedAt) {
        this.scheduleOrphanRecovery(m.sessionId);
      } else if (reconciled.status !== "stopped") {
        this.scheduleContextOrphanDiscovery(reconciled, automatic);
      }
      if (m.status === "starting" || m.status === "running" || m.status === "queued" || m.status === "input_required") {
        // The process that owned any pending approval is gone — clear the stale card too.
        this.store.patchMeta(m.sessionId, { status: "idle", pendingApproval: null });
      }
      // A crash mid-worktree-setup leaves the pending flag stranded; nothing will resolve it
      // until a restart re-runs start(), so clear it rather than blocking Files/shells forever.
      if (m.worktreePending) this.store.patchMeta(m.sessionId, { worktreePending: false });
      // One-shot index migration: pre-PR-B builds ran `git add -A` on the REAL index after every
      // turn, leaving each worktree fully staged. The new build treats the index as user-owned
      // (per-hunk staging + staged-only commits), so that residue would read as a deliberate
      // selection frozen at the last old-build turn. Reset index -> HEAD once (worktree files
      // untouched); the flag guarantees genuine stages made on the new build are never cleared.
      if (m.worktreePath && !m.indexReset) {
        void withGitExecutionContext(m.context, () => resetWorktreeIndex(m.worktreePath!)).then(() => {
          this.store.patchMeta(m.sessionId, { indexReset: true });
        });
      }
    }
    // Register every known-session namespace synchronization before replaying cleanup records.
    // Otherwise a reaper invoked at the top of this method could capture an empty promise slot,
    // then race a synchronization scheduled later in the same startup pass.
    for (const record of pendingWorktreeCleanup) void this.reapWorktree(record);
    try {
      for (const ownership of this.checkpointRefOwnership.list()) {
        if (currentCheckpointOwnershipKeys.has(checkpointRefOwnershipKey(ownership))) continue;
        void this.reclaimCheckpointRefOwnership(ownership).catch((error) => {
          this.log(`checkpoint ref ownership reclaim failed for ${ownership.sessionId}: ${errText(error)}`);
        });
      }
    } catch (error) {
      this.log(`checkpoint ref ownership reconciliation failed: ${errText(error)}`);
    }
    this.store.reapDeletedMarkers();
    // Keep archive/index work out of synchronous startup and provider command paths. One bounded
    // pass shortly after startup plus the periodic timer gradually drains legacy oversized logs.
    if (!this.historyMaintenanceKickoff) {
      this.historyMaintenanceKickoff = setTimeout(() => {
        this.historyMaintenanceKickoff = null;
        this.runHistoryMaintenance();
      }, 10_000);
      this.historyMaintenanceKickoff.unref?.();
    }
  }

  private queueCheckpointRefMaintenance(
    registry: Map<string, CheckpointRefMaintenanceEntry>,
    ownership: CheckpointRefOwnershipClaim,
    work: () => Promise<void>,
  ): Promise<void> {
    const key = checkpointRefOwnershipKey(ownership);
    const existing = registry.get(key);
    if (existing) return existing.promise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    const entry = { ownership, promise };
    registry.set(key, entry);
    this.checkpointRefMaintenanceQueue.push(async () => {
      try {
        await work();
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        if (registry.get(key) === entry) registry.delete(key);
      }
    });
    this.pumpCheckpointRefMaintenance();
    return promise;
  }

  private pumpCheckpointRefMaintenance(): void {
    while (this.checkpointRefMaintenanceActive < CHECKPOINT_REF_MAINTENANCE_CONCURRENCY &&
           this.checkpointRefMaintenanceQueue.length > 0) {
      const work = this.checkpointRefMaintenanceQueue.shift()!;
      this.checkpointRefMaintenanceActive++;
      void work().finally(() => {
        this.checkpointRefMaintenanceActive--;
        this.pumpCheckpointRefMaintenance();
      });
    }
  }

  private scheduleCheckpointRefSync(meta: SessionMeta, ownership: CheckpointRefOwnershipRecord): void {
    if (!meta.worktreePath || this.deleting.has(meta.sessionId)) return;
    void this.queueCheckpointRefMaintenance(this.checkpointRefSyncs, ownership, async () => {
      try {
        const result = await withGitExecutionContext(
          meta.context,
          () => synchronizeCheckpointRefs(meta.repoPath, meta.sessionId, ownership.ownerHash),
        );
        if (result.conflicts.length) {
          this.log(
            `checkpoint ref synchronization found divergent refs for ${meta.sessionId}: ${result.conflicts.join(", ")}`,
          );
        }
        if (result.mirroredToCurrent || result.mirroredToLegacy) {
          this.log(
            `checkpoint ref synchronization mirrored ${result.mirroredToCurrent} current and ${result.mirroredToLegacy} legacy refs for ${meta.sessionId}`,
          );
        }
      } catch (error) {
        this.log(`checkpoint ref synchronization failed for ${meta.sessionId}: ${errText(error)}`);
      }
    });
  }

  private deleteCheckpointRefsSerialized(ownership: CheckpointRefOwnershipClaim): Promise<void> {
    const key = checkpointRefOwnershipKey(ownership);
    const existing = this.checkpointRefDeletions.get(key);
    if (existing) return existing.promise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    const entry = { ownership, promise };
    this.checkpointRefDeletions.set(key, entry);
    void (async () => {
      try {
        // A startup synchronization may have enumerated a legacy-only namespace before deletion.
        // Let the exact tuple finish creating its counterpart, then delete the complete union.
        const pendingSync = this.checkpointRefSyncs.get(key);
        if (pendingSync) await pendingSync.promise;
        try {
          await withGitExecutionContext(
            ownership.context,
            () => deleteTurnRefs(ownership.repoPath, ownership.sessionId, ownership.ownerHash),
          );
        } catch (error) {
          const permanentlyUnavailable = nativeRepositoryPathIsUnavailable(
            ownership.context,
            ownership.repoPath,
          ) || isMissingGitRepositoryError(error);
          if (!permanentlyUnavailable) throw error;
        }
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        if (this.checkpointRefDeletions.get(key) === entry) this.checkpointRefDeletions.delete(key);
      }
    })();
    return promise;
  }

  private currentCheckpointOwnershipKey(sessionId: string): string | null {
    const current = this.store.readMeta(sessionId);
    if (!current || this.store.isDeleted(sessionId)) return null;
    return checkpointRefOwnershipKey(this.checkpointOwnership(current));
  }

  private reclaimCheckpointRefOwnership(ownership: CheckpointRefOwnershipRecord): Promise<void> {
    const key = checkpointRefOwnershipKey(ownership);
    const existing = this.checkpointRefReclaims.get(key);
    if (existing) return existing.promise;
    return this.queueCheckpointRefMaintenance(this.checkpointRefReclaims, ownership, async () => {
      if (this.currentCheckpointOwnershipKey(ownership.sessionId) === key) return;
      await this.deleteCheckpointRefsSerialized(ownership);
      if (this.currentCheckpointOwnershipKey(ownership.sessionId) === key) {
        throw new Error("a matching durable session appeared during checkpoint ref ownership reclaim");
      }
      this.checkpointRefOwnership.remove(ownership);
    });
  }

  /** Claim callers use this before publishing a newly materialized tuple. It fences every stale
   * same-session tuple through ref deletion and durable proof removal. */
  private async reclaimStaleCheckpointRefOwnership(current: CheckpointRefOwnershipClaim): Promise<void> {
    const currentKey = checkpointRefOwnershipKey(current);
    const stale = this.checkpointRefOwnership.listSession(current.sessionId)
      .filter((ownership) => checkpointRefOwnershipKey(ownership) !== currentKey);
    await Promise.all(stale.map((ownership) => this.reclaimCheckpointRefOwnership(ownership)));
  }

  /** Start/fork hot paths call this only when pending work exists, preserving their no-await path. */
  private async awaitCheckpointRefCleanupForSession(sessionId: string): Promise<void> {
    while (true) {
      const pending = [...this.checkpointRefDeletions.values(), ...this.checkpointRefReclaims.values()]
        .filter((entry) => entry.ownership.sessionId === sessionId)
        .map((entry) => entry.promise);
      if (!pending.length) return;
      await Promise.all(pending);
    }
  }

  private hasCheckpointRefCleanupForSession(sessionId: string): boolean {
    return [...this.checkpointRefDeletions.values(), ...this.checkpointRefReclaims.values()]
      .some((entry) => entry.ownership.sessionId === sessionId);
  }

  private runHistoryMaintenance(): void {
    if (this.historyMaintenanceRunning) return;
    this.historyMaintenanceRunning = true;
    try {
      const result = this.store.maintainHistories(`${this.lockOwner}:history`, 4);
      if (result.compacted || result.orphansRemoved) {
        this.log(
          `history maintenance archived ${result.bytesArchived} byte(s) across ${result.compacted} session(s)` +
          ` and removed ${result.orphansRemoved} orphan(s)`,
        );
      }
      if (result.errors) this.log(`history maintenance deferred ${result.errors} session(s) after validation errors`);
    } catch (error) {
      this.log(`history maintenance skipped: ${errText(error)}`);
    } finally {
      this.historyMaintenanceRunning = false;
    }
  }

  private async reconcileProviderStateStorage(): Promise<void> {
    if (this.providerStateReconciling) return;
    this.providerStateReconciling = true;
    try {
      const stored = this.store.listSessions();
      const protectedSessionIds = new Set([
        ...stored.map((session) => session.sessionId),
        ...this.forkingTargets,
      ]);
      await retryProviderStateCleanup(
        this.executionIsolation,
        this.stateDir,
        this.providerStateCleanupJournal,
        protectedSessionIds,
        this.log,
        Date.now(),
        this.runnerOwnerHash,
      );
      const pendingCleanup = this.providerStateCleanupJournal.list();
      const result = await reconcileProviderState(
        this.executionIsolation,
        this.stateDir,
        stored,
        this.runnerOwnerHash ?? providerStateKey(this.runnerId),
        pendingCleanup,
        this.forkingTargets,
        [...this.isolationContexts, ...pendingCleanup.map((record) => record.context)],
        Date.now(),
        undefined,
        providerStateKey(this.runnerId),
      );
      if (result.removed.length) this.log(`reconciled ${result.removed.length} isolated provider-state path(s)`);
      for (const error of result.errors) this.log(`provider-state reconciliation skipped ${error}`);
    } catch (error) {
      this.log(`provider-state reconciliation skipped: ${errText(error)}`);
    } finally {
      this.providerStateReconciling = false;
    }
  }

  private async cleanupProviderState(
    sessionId: string,
    driver: AgentDriverKind,
    context: AgentContext,
    journaled = false,
  ): Promise<void> {
    if (!journaled) this.providerStateCleanupJournal.add({ sessionId, driver, context });
    try {
      await this.removeIsolationState(
        { ...this.executionIsolation, mode: "bwrap" }, context, driver, this.stateDir, sessionId, {}, this.runnerOwnerHash,
      );
      this.providerStateCleanupJournal.remove(sessionId);
    } catch (error) {
      this.log(`isolated provider state cleanup for ${sessionId} needs reconciliation: ${errText(error)}`);
    }
  }

  /**
   * Phase 3: adopt an external CLI session into the box store under `sessionId`. It becomes a normal
   * box-owned session — established + resumable by `descriptor.agentSessionId` — that hydrates to
   * every dashboard and continues through the existing resume path. `launch` is the box's agent for
   * this driver/context (so resume can re-spawn it); an empty `launch.command` is the READ-ONLY
   * sentinel (no such agent on the box) that resumeAndPrompt refuses with the reason. Returns false
   * (no-op) if a session for the same agent-native conversation already exists, so two box sessions
   * can't drive one CLI conversation.
   *
   * The row is created with NO events so it's immediately promptable; the transcript is appended
   * afterward via backfillTranscript() (slow reads must not delay the row's existence). ACP
   * ownership is scoped to the exact `(agentId, agentSessionId)` pair because provider-local ids
   * may collide; native transcript ids retain their historical global uniqueness.
   */
  adopt(
    sessionId: string,
    descriptor: ExternalSessionDescriptor,
    launch: { command: string; args: string[]; env: Record<string, string> },
    acpCapabilities?: AcpRuntimeCapabilities,
  ): boolean {
    if (this.store.listSessions().some((m) =>
      m.agentSessionId === descriptor.agentSessionId &&
      (descriptor.agentId ? m.agentId === descriptor.agentId : m.driver !== "acp")
    )) {
      this.log(`refusing to re-adopt ${descriptor.agentSessionId} — already owned by a box session`);
      return false;
    }
    const now = Date.now();
    const meta: SessionMeta = {
      sessionId,
      agentId: descriptor.agentId ?? null,
      workspaceId: null,
      repoPath: descriptor.cwd, // external sessions ran in-place (no worktree)
      worktreePath: null,
      driver: descriptor.driver,
      command: launch.command,
      args: launch.args,
      env: {},
      context: descriptor.context,
      agentSessionId: descriptor.agentSessionId, // established → the resume path picks it up
      ...(acpCapabilities ? { acpCapabilities } : {}),
      status: "idle",
      title: descriptor.title || "(adopted session)",
      titleSource: "provider",
      config: {},
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      preview: null,
      pendingApproval: null,
      adopted: true,
      providerStateVersion: descriptor.context.kind === "wsl" ? 3 : 2,
      ...(this.runnerOwnerHash ? { checkpointRefVersion: 2 as const } : {}),
      seq: 0,
      createdAt: descriptor.createdAt,
      updatedAt: now,
    };
    this.store.create(meta);
    this.log(`adopted external session ${sessionId} (${descriptor.driver} ${descriptor.agentSessionId})`);
    this.recoverOrphanedWork(sessionId, false);
    return true;
  }

  /** True while a live agent process is driving this session on this runner. */
  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** Re-import: replace an *adopted* session's event log with a freshly parsed transcript, so parser /
   * formatting improvements apply to an already-adopted session. Refuses non-adopted sessions (a
   * manager-created log must never be clobbered by a best-effort transcript reparse) and any session
   * with a live turn, and holds the session lock across the swap so a concurrent prompt on another
   * runner can't append events that resetEvents would then truncate. Returns the refreshed meta, or
   * null if it isn't reprocessable / is busy. */
  reprocess(sessionId: string, events: SessionEventPayload[]): SessionMeta | null {
    const meta = this.store.readMeta(sessionId);
    if (!meta || !isAdoptedSession(meta)) return null;
    if (this.active.has(sessionId)) return null; // a live turn here would race the reset
    if (!this.store.acquireLock(sessionId, this.lockOwner)) return null; // a turn elsewhere holds it
    try {
      this.store.resetEvents(sessionId); // durable seq → 0 so backfillTranscript runs
      this.backfillTranscript(sessionId, events, /* callerHoldsLock */ true);
      return this.store.readMeta(sessionId);
    } finally {
      this.store.releaseLock(sessionId, this.lockOwner);
    }
  }

  /** Append a backfilled transcript to a freshly adopted session. Skips if the session already has
   * events (a prompt won the race) so we never interleave old history after a new turn. The
   * per-session lock serializes against a concurrent prompt — on THIS runner or another — and the
   * "already has events" check consults the DURABLE log tail, not (possibly lazily-flushed) meta:
   * a prompt's appended events are visible in the log before its meta flush lands. Reentrant under
   * reprocess() (acquireLock succeeds when the lock is already ours). */
  backfillTranscript(sessionId: string, events: SessionEventPayload[], callerHoldsLock = false): void {
    const meta = this.store.readMeta(sessionId);
    if (!meta || meta.seq !== 0) return;
    if (!callerHoldsLock && !this.store.acquireLock(sessionId, this.lockOwner)) {
      this.log(`skipping backfill for ${sessionId} — another runner holds its turn lock`);
      return;
    }
    try {
      if (this.store.logTailSeq(sessionId) > 0) return; // a prompt landed durable events first
      let lastRefresh = Date.now();
      for (const ev of events) {
        this.store.appendEvent(sessionId, ev); // assigns seq; CP lazy-hydrates these on open
        this.accrueMeta(sessionId, ev, false); // historical replay: metadata yes, live timers no
        // A huge transcript can hold this synchronous loop past the 60s stale window — refresh
        // in-loop (turns use a timer, but timers can't fire while we're blocking the loop).
        if (Date.now() - lastRefresh > LOCK_REFRESH_MS) {
          this.store.refreshLock(sessionId, this.lockOwner);
          lastRefresh = Date.now();
        }
      }
      // Make the backfilled high-water durable BEFORE the lock releases — a prompt that takes
      // the lock next must see the real seq, not a 250ms-stale meta over a full log.
      this.store.flush(sessionId);
      if (events.length) this.log(`backfilled ${events.length} event(s) into ${sessionId}`);
    } finally {
      // reprocess() holds the lock across the whole reset+backfill swap — releasing here
      // would open a window inside its critical section.
      if (!callerHoldsLock) this.store.releaseLock(sessionId, this.lockOwner);
    }
  }

  async start(
    spec: SessionLaunchSpec,
    initialPrompt?: string,
    initialImages?: PromptImageInput[],
    durable?: DurableCommandLifecycle,
    onMaterialized?: (ready: boolean) => void,
  ): Promise<boolean> {
    let materializationReported = false;
    const reportMaterialized = (ready: boolean) => {
      if (materializationReported) return;
      materializationReported = true;
      onMaterialized?.(ready);
    };
    if (this.shuttingDown) {
      durable?.failed("runner shutdown is in progress", "COMMAND_CANCELLED");
      reportMaterialized(false);
      return false;
    }
    if (this.deleted.has(spec.sessionId) || this.deleting.has(spec.sessionId) ||
        this.store.isDeleted(spec.sessionId)) {
      durable?.failed("session deletion is in progress", "COMMAND_CANCELLED");
      reportMaterialized(false);
      return false;
    }
    if (this.hasCheckpointRefCleanupForSession(spec.sessionId)) {
      try {
        await this.awaitCheckpointRefCleanupForSession(spec.sessionId);
      } catch (error) {
        durable?.failed(`checkpoint cleanup did not settle: ${errText(error)}`, "INVALID_COMMAND");
        reportMaterialized(false);
        return false;
      }
    }
    const launchGeneration = this.beginLaunchGeneration(spec.sessionId);
    this.preLaunchAdmissionGenerations.set(spec.sessionId, launchGeneration);
    try {
      return await this.startGeneration(
        spec,
        initialPrompt,
        initialImages,
        durable,
        launchGeneration,
        reportMaterialized,
      );
    } finally {
      reportMaterialized(false);
      if (this.launchGenerations.get(spec.sessionId) === launchGeneration) {
        this.rejectPreLaunchQueue(spec.sessionId, "session launch failed before runner admission");
      }
      if (this.preLaunchAdmissionGenerations.get(spec.sessionId) === launchGeneration) {
        this.preLaunchAdmissionGenerations.delete(spec.sessionId);
      }
      this.finishLaunchGeneration(spec.sessionId, launchGeneration);
    }
  }

  private async startGeneration(
    spec: SessionLaunchSpec,
    initialPrompt: string | undefined,
    initialImages: PromptImageInput[] | undefined,
    durable: DurableCommandLifecycle | undefined,
    launchGeneration: number,
    reportMaterialized: (ready: boolean) => void,
  ): Promise<boolean> {
    const targetError = executionTargetLaunchError(spec, this.runnerId, this.executionIsolation, this.containerTargets, this.cloudTargets);
    if (targetError) {
      this.emitEvent(spec.sessionId, { kind: "error", message: targetError });
      this.emitStatus(spec.sessionId, "failed", targetError);
      durable?.failed(targetError, "INVALID_COMMAND");
      return false;
    }
    if (this.forking.has(spec.sessionId)) {
      this.emitEvent(spec.sessionId, { kind: "error", message: "conversation fork is in progress — wait before restarting" });
      this.emitStatus(spec.sessionId, "idle");
      durable?.failed("conversation fork is in progress", "COMMAND_CANCELLED");
      return false;
    }
    if (!this.launchIsCurrent(spec.sessionId, launchGeneration)) {
      this.emitEvent(spec.sessionId, { kind: "error", message: "session deletion is in progress" });
      this.emitStatus(spec.sessionId, "stopped");
      durable?.failed("session deletion is in progress", "COMMAND_CANCELLED");
      return false;
    }
    const closing = this.closing.get(spec.sessionId);
    if (closing) await closing.promise;
    if (!this.launchIsCurrent(spec.sessionId, launchGeneration)) {
      this.emitEvent(spec.sessionId, { kind: "error", message: "session deletion is in progress" });
      this.emitStatus(spec.sessionId, "stopped");
      durable?.failed("session deletion is in progress", "COMMAND_CANCELLED");
      return false;
    }
    // Explicit Restart is authoritative and keeps its historical behavior of discarding queued
    // work. Clear crash-recovery state before replacing/launching so it cannot intercept the
    // restart's initial prompt or later prompts.
    this.discardRecovery(spec.sessionId);
    // Restart: a start for a session we already run replaces the old process.
    const existing = this.active.get(spec.sessionId);
    if (existing) {
      this.clearSteeringState(spec.sessionId, "session restart discarded steering state");
      this.active.delete(spec.sessionId);
      this.rejectQueued(existing.queue, "session restart discarded the queued command");
      existing.queue.length = 0;
      this.emitQueue(spec.sessionId); // a restart discards any queued prompts
      existing.client.dispose({ forceImmediate: true });
      this.clearLock(spec.sessionId);
      this.log(`restarting ${spec.sessionId} — replacing existing process`);
    }

    const context = spec.context ?? { kind: "native" as const };
    const isWsl = context.kind === "wsl";
    const repoPath = isWsl ? spec.workspacePath : resolve(spec.workspacePath);

    // Persist the session to the box store BEFORE anything else, so it is the source of truth, is
    // visible to other dashboards even if init fails, and so setup warnings below land in the log
    // (worktreePath is filled in once we know it).
    const now = Date.now();
    const acpSessionOverrides = spec.acpSessionContext;
    let acpSessionContext = acpSessionOverrides;
    if ((spec.driver ?? "acp") === "acp" && this.resolveAcpContext) {
      try {
        acpSessionContext = this.resolveAcpContext(spec);
      } catch (err) {
        this.emitEvent(spec.sessionId, { kind: "error", message: `ACP session context rejected: ${errText(err)}` });
        this.emitStatus(spec.sessionId, "failed", "ACP session context was rejected by runner policy");
        durable?.failed("ACP session context was rejected by runner policy", "INVALID_COMMAND");
        return false;
      }
    }
    if (spec.executionTarget?.adapter === "container" || spec.executionTarget?.adapter === "cloud") {
      // Runner/workspace defaults may add MCP servers after the wire-level validation above.
      // Container targets claim one worktree mount and no secret injection, so omit that host
      // context even when the ordinary host ACP policy would have supplied it.
      acpSessionContext = undefined;
    }
    const prior = this.store.readMeta(spec.sessionId);
    const driver = spec.driver ?? "acp";
    const executionTarget = spec.executionTarget ?? prior?.executionTarget;
    const carrySlashCommandCatalog = !spec.useWorktree && canCarrySlashCommandCatalog(prior ?? undefined, {
      driver,
      context,
      repoPath,
      root: repoPath,
      target: executionTarget,
    });
    // This roadmap slice changes explicit Restart semantics only for app-server: its durable
    // thread must survive desktop/runner restarts. Preserve the existing fresh-start behavior
    // for Claude and exec Codex; their ordinary prompt-after-process-loss resume path is unchanged.
    const priorResumeId = prior?.driver === driver && driver === "codex-app-server" ? prior.agentSessionId : null;
    if (priorResumeId && !this.store.acquireLock(spec.sessionId, this.lockOwner)) {
      this.emitEvent(spec.sessionId, { kind: "error", message: "this session is being restarted by another runner — retry shortly" });
      this.emitStatus(spec.sessionId, "idle");
      durable?.failed("session is owned by another runner process", "COMMAND_CANCELLED");
      return false;
    }
    const meta: SessionMeta = {
      sessionId: spec.sessionId,
      agentId: spec.agentId,
      agentVersion: spec.agentVersion ?? prior?.agentVersion,
      capabilities: spec.capabilities ?? prior?.capabilities,
      sessionSlashCommands: carrySlashCommandCatalog ? prior?.sessionSlashCommands : undefined,
      sessionSlashCommandProvenance: carrySlashCommandCatalog
        ? prior?.sessionSlashCommandProvenance
        : undefined,
      codexExecFallbackReason: spec.codexExecFallbackReason ?? prior?.codexExecFallbackReason,
      workspaceId: spec.workspaceId,
      repoPath,
      worktreePath: null,
      executionTarget,
      executionHandoffRequest: spec.executionHandoff ?? prior?.executionHandoffRequest,
      executionHandoff: spec.executionTarget?.id === prior?.executionTarget?.id ? prior?.executionHandoff : undefined,
      cloudAdapterHandoffKey: spec.executionTarget?.id === prior?.executionTarget?.id ? prior?.cloudAdapterHandoffKey : undefined,
      driver,
      command: spec.command,
      args: spec.args,
      // Protocol v54: launch env is resolved from runner-local agent config immediately before
      // spawn and is never written to session metadata, even if an older CP sends values.
      env: {},
      context,
      agentSessionId: priorResumeId,
      status: "starting",
      title: spec.title ?? "",
      titleSource: spec.titleSource ?? "generated",
      config: spec.config ?? {},
      acpSessionContext,
      acpSessionOverrides,
      tokensIn: priorResumeId ? (prior?.tokensIn ?? 0) : 0,
      tokensOut: priorResumeId ? (prior?.tokensOut ?? 0) : 0,
      contextTokensUsed: priorResumeId ? prior?.contextTokensUsed : undefined,
      contextWindow: priorResumeId ? prior?.contextWindow : undefined,
      costUsd: priorResumeId ? (prior?.costUsd ?? 0) : 0,
      preview: priorResumeId ? (prior?.preview ?? null) : null,
      pendingApproval: null,
      // Manager-driven: a continued session is no longer a pristine transcript, so it isn't
      // reprocessable (re-reading the original transcript would drop the continuation).
      adopted: false,
      providerStateVersion: prior ? prior.providerStateVersion : (context.kind === "wsl" ? 3 : 2),
      checkpointRefVersion: prior
        ? prior.checkpointRefVersion
        : (this.runnerOwnerHash ? 2 : undefined),
      seq: prior?.seq ?? 0,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      // Carry the last-turn snapshot + turn counter across restarts (like seq/createdAt) —
      // start() rebuilds the meta from scratch; losing lastTurnBaseTree breaks the last_turn
      // diff scope, and a reset turnCount would re-anchor refs/<namespace>/<sid>/turn-1 so old
      // checkpoint rows restored the WRONG tree.
      lastTurnBaseTree: prior?.lastTurnBaseTree,
      turnCount: prior?.turnCount ?? 0,
      forkPoints: prior?.forkPoints ?? {},
      // Sessions (re)started on this build never carry the old add -A residue forward — and the
      // flag stops the startup migration from ever clearing a user's deliberate staging.
      indexReset: true,
      // Worktree setup below is async — block Files/shells root resolution until it lands one
      // way or the other, so a shell can't open in the shared base checkout during the window.
      worktreePending: !!spec.useWorktree,
    };
    // create() upserts meta.json (refreshing launch params) but preserves any existing event log,
    // so a restart keeps the timeline while re-spawning a fresh agent.
    this.store.create(meta);
    durable?.queued();
    if (meta.driver === "codex") {
      this.emitTelemetry(meta, {
        metric: "fallback",
        outcome: "observed",
        reason: meta.codexExecFallbackReason ?? "compatibility_exec",
      });
    }

    // Worktree setup is part of durable session materialization. It must finish before the initial
    // Agent TUI can resolve its root, but capacity admission/provider initialization must not hold
    // the control plane's bounded shell-open RPC.
    let worktree: WorktreeHandle | null = null;
    let worktreeOwnedByLaunch = false;
    if (spec.useWorktree) {
      const preparationAcquired = await this.acquireWorktreePreparation(
        spec.sessionId,
        launchGeneration,
      );
      if (!preparationAcquired) {
        if (!this.launchGenerations.has(spec.sessionId) && this.store.has(spec.sessionId)) {
          this.store.patchMeta(spec.sessionId, { worktreePending: false });
        }
        durable?.failed("session launch was cancelled before worktree preparation", "COMMAND_CANCELLED");
        return false;
      }
      try {
        const worktreeOptions = {
          context,
          dataDir: this.dataDir,
          ownerHash: this.runnerOwnerHash,
          ...(context.kind === "wsl" && prior?.context.kind === "wsl" &&
            prior.context.distro === context.distro && prior.worktreePath &&
            prior.worktreePath.includes("/.agent-manager/worktrees/")
            ? { legacyWslWorktreePath: prior.worktreePath }
            : {}),
        };
        const gitRepo = await isGitRepo(repoPath, worktreeOptions);
        if (!this.launchIsCurrent(spec.sessionId, launchGeneration)) return false;
        if (gitRepo) {
          worktree = await this.createSessionWorktree(repoPath, spec.sessionId, worktreeOptions);
          // createWorktree deliberately returns an already-registered healthy session worktree.
          // Preserve that durable root and its uncommitted diffs if this launch later loses.
          // Legacy/test materializers omit the marker and historically represented a newly
          // created tree. Only an explicit false proves that this call reused durable state.
          worktreeOwnedByLaunch = worktree.created !== false;
          try {
            const ownership = this.checkpointRefOwnership.claim(this.checkpointOwnership(meta));
            await this.reclaimStaleCheckpointRefOwnership(ownership);
          } catch (claimError) {
            // A worktree without durable ref ownership proof must never be published or reach its
            // first checkpoint. Unwind only a worktree this launch actually materialized.
            if (worktreeOwnedByLaunch) {
              const checkpointOwnerHash = this.checkpointOwnerHash(meta);
              const cleanup = { sessionId: spec.sessionId, repoPath, worktreePath: worktree.path, context,
                ...(checkpointOwnerHash ? { checkpointOwnerHash } : {}) };
              this.cleanupJournal.add(cleanup);
              await this.reapWorktree(cleanup, true);
            }
            worktree = null;
            throw claimError;
          }
          if (!this.launchIsCurrent(spec.sessionId, launchGeneration)) {
            // Delete may win while createWorktree is resolving, after the new start row already
            // cleared worktreePath. In that case delete could not journal the returned reused
            // handle, so this continuation must finish the explicit deletion. Replacement and
            // ordinary cancellation still preserve a reused root and its user changes.
            const deleted = this.deleted.has(spec.sessionId) || this.deleting.has(spec.sessionId) ||
              this.store.isDeleted(spec.sessionId);
            const superseded = this.launchWasSuperseded(spec.sessionId, launchGeneration);
            if (worktreeOwnedByLaunch || deleted) {
              const checkpointOwnerHash = this.checkpointOwnerHash(meta);
              const cleanup = { sessionId: spec.sessionId, repoPath, worktreePath: worktree.path, context,
                ...(checkpointOwnerHash ? { checkpointOwnerHash } : {}) };
              this.cleanupJournal.add(cleanup);
              await this.reapWorktree(cleanup, worktreeOwnedByLaunch && !superseded);
            }
            return false;
          }
        } else {
          if (!this.emitEvent(spec.sessionId, {
            kind: "stderr",
            text: "useWorktree requested but workspace is not a git repo — running in place",
          }, durable)) {
            meta.worktreePending = false;
            this.store.patchMeta(spec.sessionId, { worktreePending: false });
            this.releaseAdmissionIfInactive(spec.sessionId);
            return false;
          }
        }
      } catch (err) {
        if (!this.launchIsCurrent(spec.sessionId, launchGeneration)) return false;
        this.emitEvent(spec.sessionId, {
          kind: "error",
          message: `worktree isolation failed: ${errText(err)}`,
        });
        meta.worktreePending = false;
        this.store.patchMeta(spec.sessionId, { worktreePending: false });
        if (priorResumeId) this.store.releaseLock(spec.sessionId, this.lockOwner);
        this.releaseAdmissionIfInactive(spec.sessionId);
        this.emitStatus(spec.sessionId, "failed", "Worktree isolation could not be established");
        durable?.failed("worktree isolation could not be established", "INVALID_COMMAND");
        return false;
      } finally {
        this.releaseWorktreePreparation(launchGeneration);
        // Cancel without replacement leaves the old row behind; clear its transient root fence.
        // A newer generation owns its freshly-written row and must never be patched by this stale
        // continuation.
        if (!this.launchGenerations.has(spec.sessionId) && this.store.has(spec.sessionId)) {
          this.store.patchMeta(spec.sessionId, { worktreePending: false });
        }
      }
    }
    if (!this.launchIsCurrent(spec.sessionId, launchGeneration)) {
      const deleted = this.deleted.has(spec.sessionId) || this.deleting.has(spec.sessionId) ||
        this.store.isDeleted(spec.sessionId);
      const superseded = this.launchWasSuperseded(spec.sessionId, launchGeneration);
      if (worktree && (worktreeOwnedByLaunch || deleted)) {
        const checkpointOwnerHash = this.checkpointOwnerHash(meta);
        const cleanup = { sessionId: spec.sessionId, repoPath, worktreePath: worktree.path, context,
          ...(checkpointOwnerHash ? { checkpointOwnerHash } : {}) };
        this.cleanupJournal.add(cleanup);
        await this.reapWorktree(cleanup, worktreeOwnedByLaunch && !superseded);
      }
      return false;
    }
    // Worktree setup has RESOLVED (created, or one of the in-place fallbacks above) — unblock
    // Files/shells root resolution in the same patch that records the outcome.
    meta.worktreePending = false;
    if (worktree) {
      meta.worktreePath = worktree.path;
      this.store.patchMeta(spec.sessionId, { worktreePath: worktree.path, worktreePending: false });
      this.emitStatus(spec.sessionId, "starting", undefined, worktree.path);
    } else {
      this.store.patchMeta(spec.sessionId, { worktreePending: false });
    }

    // acquireAdmission makes the immediate admit-or-queue decision synchronously. Publish
    // materialization after that durable decision but before waiting for capacity or constructing
    // a provider, so an initial Native TUI can open even while the structured driver is queued.
    const admission = this.acquireAdmission(spec.sessionId);
    reportMaterialized(true);
    if (!(await admission)) {
      const superseded = this.launchWasSuperseded(spec.sessionId, launchGeneration);
      // App-server Restart takes the resumable-thread lock before capacity admission. A newer
      // same-session generation reuses that same-owner lock, while cancellation with no replacement
      // must release it after its waiter settles.
      if (priorResumeId && !superseded) this.store.releaseLock(spec.sessionId, this.lockOwner);
      durable?.failed(
        superseded
          ? "session launch was superseded by a replacement"
          : "session launch was cancelled before runner admission",
        "COMMAND_CANCELLED",
      );
      return false;
    }
    if (!this.launchIsCurrent(spec.sessionId, launchGeneration)) {
      const superseded = this.launchWasSuperseded(spec.sessionId, launchGeneration);
      if (priorResumeId && !superseded) this.store.releaseLock(spec.sessionId, this.lockOwner);
      durable?.failed(
        superseded
          ? "session launch was superseded by a replacement"
          : "session launch was cancelled before provider startup",
        "COMMAND_CANCELLED",
      );
      return false;
    }

    const ok = await this.launch(meta, priorResumeId ?? undefined, launchGeneration);
    if (!ok) {
      // launch() can lose generation ownership while awaiting launch preparation. A replacement
      // may deliberately reuse the same durable row, admission claim, and worktree, so the stale
      // continuation must not release or reap any of those replacement-owned resources.
      const superseded = this.launchWasSuperseded(spec.sessionId, launchGeneration);
      const cancelled = !this.launchIsCurrent(spec.sessionId, launchGeneration);
      const deleted = this.deleted.has(spec.sessionId) || this.deleting.has(spec.sessionId) ||
        this.store.isDeleted(spec.sessionId);
      if (superseded) {
        durable?.failed("session launch was superseded by a replacement", "COMMAND_CANCELLED");
        return false;
      }
      this.releaseAdmissionIfInactive(spec.sessionId);
      if (priorResumeId) this.store.releaseLock(spec.sessionId, this.lockOwner);
      // The session never started; if WE just created its worktree, it's garbage — reap it.
      if (worktree && worktreeOwnedByLaunch && !deleted) {
        const checkpointOwnerHash = this.checkpointOwnerHash(meta);
        const cleanup = { sessionId: spec.sessionId, repoPath, worktreePath: worktree.path, context,
          ...(checkpointOwnerHash ? { checkpointOwnerHash } : {}) };
        this.cleanupJournal.add(cleanup);
        this.store.patchMeta(spec.sessionId, { worktreePath: null });
        await this.reapWorktree(cleanup, true);
      }
      durable?.failed(
        cancelled ? "session launch was cancelled before provider startup" : "agent session could not be launched",
        cancelled ? "COMMAND_CANCELLED" : "INVALID_COMMAND",
      );
      return false;
    }
    if (!this.launchIsCurrent(spec.sessionId, launchGeneration)) return false;
    if (initialPrompt || (initialImages && initialImages.length)) {
      if (!this.prompt(spec.sessionId, initialPrompt ?? "", initialImages ?? [], undefined, undefined, durable)) {
        return false;
      }
    } else {
      if (priorResumeId) this.store.releaseLock(spec.sessionId, this.lockOwner);
      this.emitStatus(spec.sessionId, "idle");
      durable?.completed();
    }
    this.activatePreLaunchQueue(spec.sessionId);
    return true;
  }

  private launchIsCurrent(sessionId: string, generation: number): boolean {
    return !this.shuttingDown &&
      !this.deleted.has(sessionId) &&
      !this.deleting.has(sessionId) &&
      !this.store.isDeleted(sessionId) &&
      this.launchGenerations.get(sessionId) === generation;
  }

  private launchWasSuperseded(sessionId: string, generation: number): boolean {
    const replacementGeneration = this.latestLaunchGenerations.get(sessionId);
    return replacementGeneration !== undefined && replacementGeneration !== generation;
  }

  private beginLaunchGeneration(sessionId: string): number {
    this.cancelWorktreePreparationWait(sessionId);
    const generation = ++this.nextLaunchGeneration;
    this.launchGenerations.set(sessionId, generation);
    this.latestLaunchGenerations.set(sessionId, generation);
    return generation;
  }

  private finishLaunchGeneration(sessionId: string, generation: number): void {
    if (this.launchGenerations.get(sessionId) === generation) this.launchGenerations.delete(sessionId);
  }

  private invalidateLaunchGeneration(sessionId: string): boolean {
    const generation = this.launchGenerations.get(sessionId);
    const activePreparation = generation !== undefined &&
      this.worktreePreparations.has(generation);
    const queuedPreparation = this.cancelWorktreePreparationWait(sessionId);
    this.launchGenerations.delete(sessionId);
    return activePreparation || queuedPreparation;
  }

  private acquireWorktreePreparation(
    sessionId: string,
    launchGeneration: number,
  ): Promise<boolean> {
    if (!this.launchIsCurrent(sessionId, launchGeneration)) return Promise.resolve(false);
    const key = `${this.runnerId}:${process.pid}:${sessionId}:${launchGeneration}`;
    if (
      this.worktreePreparations.size < this.worktreePreparationLimit &&
      ![...this.worktreePreparationSessions.values()].includes(sessionId) &&
      this.worktreePreparationAdmission.acquire({
        sessionId: key,
        agentId: "worktree-preparation",
        weight: 1,
        exclusiveGroup: `worktree-preparation:${sessionId}`,
      })
    ) {
      this.worktreePreparations.add(launchGeneration);
      this.worktreePreparationKeys.set(launchGeneration, key);
      this.worktreePreparationSessions.set(launchGeneration, sessionId);
      return Promise.resolve(true);
    }
    const waiting = new Promise<boolean>((resolve) => {
      this.worktreePreparationQueue.push({ sessionId, launchGeneration, resolve });
    });
    this.scheduleWorktreePreparationRetry();
    return waiting;
  }

  private cancelWorktreePreparationWait(sessionId: string): boolean {
    let cancelled = false;
    for (let index = this.worktreePreparationQueue.length - 1; index >= 0; index--) {
      const queued = this.worktreePreparationQueue[index]!;
      if (queued.sessionId !== sessionId) continue;
      this.worktreePreparationQueue.splice(index, 1);
      queued.resolve(false);
      cancelled = true;
    }
    if (this.worktreePreparationQueue.length === 0 && this.worktreePreparationRetryTimer) {
      clearTimeout(this.worktreePreparationRetryTimer);
      this.worktreePreparationRetryTimer = null;
    }
    return cancelled;
  }

  private releaseWorktreePreparation(launchGeneration: number): void {
    if (!this.worktreePreparations.delete(launchGeneration)) return;
    const key = this.worktreePreparationKeys.get(launchGeneration);
    if (key) this.worktreePreparationAdmission.release(key);
    this.worktreePreparationKeys.delete(launchGeneration);
    this.worktreePreparationSessions.delete(launchGeneration);
    this.drainWorktreePreparationQueue();
  }

  private drainWorktreePreparationQueue(): void {
    if (this.shuttingDown) {
      for (const queued of this.worktreePreparationQueue.splice(0)) queued.resolve(false);
      return;
    }
    for (
      let index = 0;
      this.worktreePreparations.size < this.worktreePreparationLimit &&
      index < this.worktreePreparationQueue.length;
    ) {
      const queued = this.worktreePreparationQueue[index]!;
      if (!this.launchIsCurrent(queued.sessionId, queued.launchGeneration)) {
        this.worktreePreparationQueue.splice(index, 1);
        queued.resolve(false);
        continue;
      }
      if ([...this.worktreePreparationSessions.values()].includes(queued.sessionId)) {
        index++;
        continue;
      }
      const key = `${this.runnerId}:${process.pid}:${queued.sessionId}:${queued.launchGeneration}`;
      if (!this.worktreePreparationAdmission.acquire({
        sessionId: key,
        agentId: "worktree-preparation",
        weight: 1,
        exclusiveGroup: `worktree-preparation:${queued.sessionId}`,
      })) {
        index++;
        continue;
      }
      this.worktreePreparationQueue.splice(index, 1);
      this.worktreePreparations.add(queued.launchGeneration);
      this.worktreePreparationKeys.set(queued.launchGeneration, key);
      this.worktreePreparationSessions.set(queued.launchGeneration, queued.sessionId);
      queued.resolve(true);
    }
    if (this.worktreePreparationQueue.length > 0) this.scheduleWorktreePreparationRetry();
  }

  private scheduleWorktreePreparationRetry(): void {
    if (this.shuttingDown || this.worktreePreparationRetryTimer ||
        this.worktreePreparationQueue.length === 0) return;
    this.worktreePreparationRetryTimer = setTimeout(() => {
      this.worktreePreparationRetryTimer = null;
      this.drainWorktreePreparationQueue();
    }, 250);
    this.worktreePreparationRetryTimer.unref?.();
  }

  private retainDeletedTombstone(sessionId: string): void {
    this.deleted.add(sessionId);
    const existing = this.deletedExpiry.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => this.expireDeletedTombstone(sessionId), 60_000);
    timer.unref?.();
    this.deletedExpiry.set(sessionId, timer);
    while (this.deleted.size > 10_000) {
      const oldest = this.deleted.values().next().value as string | undefined;
      if (!oldest) break;
      this.expireDeletedTombstone(oldest);
    }
  }

  private expireDeletedTombstone(sessionId: string): void {
    this.deleted.delete(sessionId);
    const timer = this.deletedExpiry.get(sessionId);
    if (timer) clearTimeout(timer);
    this.deletedExpiry.delete(sessionId);
    if (!this.deleting.has(sessionId)) this.launchGenerations.delete(sessionId);
  }

  sessionCanOpen(sessionId: string): boolean {
    return !this.deleted.has(sessionId) && !this.deleting.has(sessionId) &&
      !this.store.isDeleted(sessionId) && this.store.has(sessionId);
  }

  private acquireAdmission(sessionId: string): Promise<boolean> {
    if (this.admitted.has(sessionId)) return Promise.resolve(true);
    // A restarted start command supersedes an older not-yet-admitted request for this session.
    this.cancelAdmissionWait(sessionId);
    const request = this.admissionRequest(sessionId);
    if (this.admissionQueue.length === 0 && this.boxAdmission.acquire(request)) {
      this.admitted.add(sessionId);
      return Promise.resolve(true);
    }
    const used = this.boxAdmission.usedCapacity();
    const quota = request.agentLimit ? `; ${request.agentId} limit ${request.agentLimit}` : "";
    const targetQuota = request.targetLimit ? `; target limit ${request.targetLimit}` : "";
    this.emitStatus(
      sessionId,
      "queued",
      `Waiting for runner capacity (${used}/${this.maxConcurrentSessions} units active; weight ${request.weight}${quota}${targetQuota})`,
    );
    const waiting = new Promise<boolean>((resolve) => this.admissionQueue.push({ request, bypasses: 0, resolve }));
    this.drainAdmissionQueue();
    return waiting;
  }

  private cancelAdmissionWait(sessionId: string): boolean {
    const index = this.admissionQueue.findIndex((entry) => entry.request.sessionId === sessionId);
    if (index < 0) return false;
    const [entry] = this.admissionQueue.splice(index, 1);
    entry?.resolve(false);
    if (this.admissionQueue.length === 0 && this.admissionRetryTimer) {
      clearTimeout(this.admissionRetryTimer);
      this.admissionRetryTimer = null;
    }
    return true;
  }

  private releaseAdmission(sessionId: string): void {
    if (!this.admitted.delete(sessionId)) return;
    this.boxAdmission.release(sessionId);
    this.drainAdmissionQueue();
  }

  private drainAdmissionQueue(): void {
    let admitted = true;
    while (this.admissionQueue.length > 0 && admitted) {
      admitted = false;
      // Oldest eligible wins. A provider-quota or heavy-weight head entry cannot leave usable
      // capacity idle, while entries within the same eligibility class remain FIFO.
      for (let index = 0; index < this.admissionQueue.length;) {
        const next = this.admissionQueue[index]!;
        if (index > 0 && this.admissionQueue[0]!.bypasses >= 8) break;
        const sessionId = next.request.sessionId;
        const meta = this.store.readMeta(sessionId);
        if (!meta || meta.status === "stopped") {
          this.admissionQueue.splice(index, 1);
          next.resolve(false);
          continue;
        }
        if (!this.boxAdmission.acquire(next.request)) {
          index++;
          continue;
        }
        this.admissionQueue.splice(index, 1);
        for (let prior = 0; prior < index; prior++) this.admissionQueue[prior]!.bypasses++;
        this.admitted.add(sessionId);
        next.resolve(true);
        admitted = true;
        break;
      }
    }
    if (this.admissionQueue.length > 0) this.scheduleAdmissionRetry();
  }

  private admissionRequest(sessionId: string): AdmissionRequest {
    const meta = this.store.readMeta(sessionId);
    const agentId = meta?.agentId ?? meta?.driver ?? "unknown";
    const seatbeltProvider = meta?.driver === "claude-code"
      ? "claude"
      : meta?.driver === "codex" || meta?.driver === "codex-app-server"
        ? "codex"
        : null;
    return {
      sessionId,
      agentId,
      weight: this.admissionPolicy.agentWeights[agentId] ?? 1,
      ...(this.executionIsolation.mode === "seatbelt" && seatbeltProvider
        ? { exclusiveGroup: `seatbelt:${seatbeltProvider}` }
        : {}),
      ...(this.admissionPolicy.agentLimits[agentId] !== undefined
        ? { agentLimit: this.admissionPolicy.agentLimits[agentId] }
        : {}),
      ...(meta?.executionTarget?.adapter === "cloud" && meta.executionTarget.policy
        ? {
            targetId: meta.executionTarget.id,
            targetLimit: meta.executionTarget.policy.admission.maxConcurrentSessions,
          }
        : {}),
    };
  }

  private scheduleAdmissionRetry(): void {
    if (this.admissionRetryTimer || this.admissionQueue.length === 0) return;
    this.admissionRetryTimer = setTimeout(() => {
      this.admissionRetryTimer = null;
      this.drainAdmissionQueue();
    }, 250);
    this.admissionRetryTimer.unref?.();
  }

  /** A stale duplicate launch must never release the slot owned by its winning replacement. */
  private releaseAdmissionIfInactive(sessionId: string): void {
    if (!this.active.has(sessionId)) this.releaseAdmission(sessionId);
  }

  /** Spawn the agent for `meta` (resuming via `resumeId` if given), establish the session, and add
   * it to the in-memory active set. Returns false (and emits failed) if init fails. */
  private async ensureProviderStateLayout(
    meta: SessionMeta,
    launchGeneration?: number,
  ): Promise<void> {
    if (this.executionIsolation.mode !== "bwrap") return;
    const expectedVersion = meta.context.kind === "wsl" ? 3 : 2;
    if (meta.providerStateVersion === expectedVersion) return;
    // Native v2 already uses the session-owned provider HOME layout. Never stamp it with the WSL
    // v3 marker: an origin/main rollback treats every non-v2 row as legacy and would copy retained
    // shared bytes back over the session partition. A native v3 row may exist from an interrupted
    // pre-fix build; safely restore only its compatibility marker because its layout never changed.
    if (meta.context.kind === "native" && meta.providerStateVersion === 3) {
      this.store.patchMeta(meta.sessionId, { providerStateVersion: 2 });
      return;
    }
    const inFlight = this.providerStateMigrations.get(meta.sessionId);
    if (inFlight) {
      await inFlight;
      const current = this.store.readMeta(meta.sessionId);
      if (!current) return;
      if (launchGeneration !== undefined &&
          !this.launchIsCurrent(meta.sessionId, launchGeneration)) return;
      if (current.providerStateVersion !== expectedVersion) {
        this.store.patchMeta(meta.sessionId, { providerStateVersion: expectedVersion });
      }
      return;
    }
    const alreadyOwned = this.store.ownsLock(meta.sessionId, this.lockOwner);
    if (!alreadyOwned && !this.store.acquireLock(meta.sessionId, this.lockOwner)) {
      throw new Error("another runner is migrating this session's isolated provider state");
    }
    const refresh = setInterval(() => this.store.refreshLock(meta.sessionId, this.lockOwner), LOCK_REFRESH_MS);
    try {
      // Double-check after acquiring the cross-process lock: another runner may have completed the
      // copy while this caller waited. Never rm/copy a partition that is already published as v3.
      const current = this.store.readMeta(meta.sessionId);
      if (!current || current.providerStateVersion === expectedVersion) return;
      const migration = this.migrateIsolationState(
        this.executionIsolation,
        current.context,
        current.driver,
        this.stateDir,
        current.sessionId,
        {},
        this.runnerOwnerHash,
      );
      this.providerStateMigrations.set(current.sessionId, migration);
      try {
        await migration;
      } finally {
        if (this.providerStateMigrations.get(current.sessionId) === migration) {
          this.providerStateMigrations.delete(current.sessionId);
        }
      }
      if (launchGeneration !== undefined &&
          !this.launchIsCurrent(current.sessionId, launchGeneration)) return;
      this.store.patchMeta(current.sessionId, { providerStateVersion: expectedVersion });
    } finally {
      clearInterval(refresh);
      if (!alreadyOwned) this.store.releaseLock(meta.sessionId, this.lockOwner);
    }
  }

  private async launch(meta: SessionMeta, resumeId: string | undefined, launchGeneration: number): Promise<boolean> {
    const launchStarted = Date.now();
    const sessionId = meta.sessionId;
    if (!this.launchIsCurrent(sessionId, launchGeneration)) return false;
    this.revokeSessionCommandAuthority(sessionId);
    const hadCloudHandoffBeforeLaunch = !!meta.cloudAdapterHandoffKey;
    this.emitStatus(sessionId, "starting");
    const cwd = meta.worktreePath ?? meta.repoPath;
    const worktree: WorktreeHandle | null = meta.worktreePath
      ? { path: meta.worktreePath, branch: `agent/${sessionId}` }
      : null;

    let isolation: SpawnIsolation | undefined;
    let launchPreparation: void | SessionLaunchPreparation;
    try {
      const priorCapabilities = meta.capabilities;
      const priorSessionSlashCommands = meta.sessionSlashCommands;
      launchPreparation = await this.prepareLaunch?.(meta);
      // Launch preparation may await filesystem/provider discovery. A restart can replace this
      // session with a new generation (and even a different provider) during that window; the old
      // continuation must not patch or publish its stale launch-local metadata.
      if (!this.launchIsCurrent(sessionId, launchGeneration)) return false;
      if (sameSlashCommandCatalog(priorSessionSlashCommands, meta.sessionSlashCommands)) {
        meta.sessionSlashCommands = priorSessionSlashCommands;
      }
      const updated = this.store.patchMeta(sessionId, {
        args: meta.args,
        config: meta.config,
        capabilities: meta.capabilities,
        sessionSlashCommands: meta.sessionSlashCommands,
        sessionSlashCommandProvenance: meta.sessionSlashCommandProvenance,
      });
      if (updated && (priorCapabilities !== meta.capabilities ||
          priorSessionSlashCommands !== meta.sessionSlashCommands)) {
        this.send({ type: "session_runtime_updated", snapshot: this.snapshot(updated) });
      }
      if (meta.executionTarget?.adapter !== "container" && meta.executionTarget?.adapter !== "cloud" &&
          this.executionIsolation.mode === "bwrap" &&
          meta.providerStateVersion !== (meta.context.kind === "wsl" ? 3 : 2)) {
        await this.ensureProviderStateLayout(meta, launchGeneration);
      }
      isolation = await this.resolveLaunchIsolation(meta, cwd, launchGeneration);
      if (!this.launchIsCurrent(sessionId, launchGeneration)) {
        await this.cancelNewCloudHandoff(meta, hadCloudHandoffBeforeLaunch, "session launch was cancelled during isolation setup", launchGeneration);
        return false;
      }
      this.claimCloudHandoff(meta, launchGeneration);
    } catch (error) {
      if (!this.launchIsCurrent(sessionId, launchGeneration)) {
        await this.cancelNewCloudHandoff(meta, hadCloudHandoffBeforeLaunch, "session launch was cancelled while isolation setup failed", launchGeneration);
        return false;
      }
      await this.cancelNewCloudHandoff(meta, hadCloudHandoffBeforeLaunch, "isolation setup failed", launchGeneration);
      this.emitEvent(sessionId, { kind: "error", message: `execution isolation unavailable: ${errText(error)}` });
      this.emitStatus(sessionId, "failed", "Runner-owned execution isolation could not be established");
      return false;
    }

    let client: Driver;
    try {
      this.providerHomeLeases?.acquire({
        driver: meta.driver,
        command: meta.command,
        context: meta.context,
        env: meta.env,
        isolation,
      });
      client = this.createDriver(
        meta.driver,
        { command: meta.command, args: meta.args, cwd, env: meta.env, config: meta.config, context: meta.context, capabilities: meta.capabilities, resumeId, acpSessionContext: meta.acpSessionContext, isolation, sessionStateDir: this.store.sessionPath(sessionId), initialBackgroundTaskIds: meta.orphanedWork?.pendingTaskIds ?? meta.pendingBackgroundTaskIds },
        {
        onEvent: (p) => this.onDriverEvent(sessionId, p),
        onStderr: (t) => this.onDriverStderr(sessionId, t),
        onExit: (code) => this.onDriverExit(sessionId, code),
        onBackgroundWork: (update) => {
          // A retiring driver may emit an exit/null callback after a replacement owns the session.
          if (this.active.get(sessionId)?.client !== client) return;
          this.onDriverBackgroundWork(sessionId, update);
        },
        onAuthStatus: (status) => {
          if (meta.agentId) this.onAgentAuthUpdate?.(meta.agentId, { status });
        },
        onAcpCapabilities: (capabilities) => {
          meta.acpCapabilities = capabilities;
          this.store.patchMeta(sessionId, { acpCapabilities: capabilities });
          if (meta.agentId) this.onAgentAuthUpdate?.(meta.agentId, { capabilities });
        },
        onAcpSessionState: (state) => {
          // An ACP client being retired during Restart may still flush a late capability update.
          // Persist it only while this exact process remains the live owner of the session.
          if (this.active.get(sessionId)?.client !== client) return;
          const current = this.store.readMeta(sessionId);
          if (!current) return;
          const capabilities = {
            ...state.capabilities,
            slashCommands: state.capabilities.slashCommands.map((command) => ({
              name: command.name,
              source: command.source,
              ...(command.description === undefined ? {} : { description: command.description }),
              ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
            })),
          };
          const liveEntry = this.active.get(sessionId);
          if (current.driver === "acp" && liveEntry?.client === client && liveEntry.providerReady &&
              client.prepareCommand && client.invokeCommand) {
            this.sessionCommandAuthority.refresh(
              sessionId,
              capabilities.slashCommands,
              `${this.runnerId}:${process.pid}:acp:${launchGeneration}`,
              "structured",
            );
          }
          this.store.patchMeta(sessionId, {
            capabilities,
            config: {
              ...current.config,
              model: state.config.model,
              effort: state.config.effort,
              permissionMode: state.config.permissionMode,
            },
          });
          const updated = this.store.readMeta(sessionId);
          if (updated) this.send({ type: "session_runtime_updated", snapshot: this.snapshot(updated) });
        },
        onAcpUsage: (usage) => {
          const current = this.store.readMeta(sessionId);
          if (!current) return;
          this.store.patchMeta(sessionId, {
            contextTokensUsed: usage.contextTokensUsed,
            contextWindow: usage.contextWindow,
            ...(usage.costUsd != null ? { costUsd: Math.max(current.costUsd, usage.costUsd) } : {}),
          });
          const updated = this.store.readMeta(sessionId);
          if (updated) this.send({ type: "session_runtime_updated", snapshot: this.snapshot(updated) });
        },
        onAcpSessionInfo: (info) => {
          const current = this.store.readMeta(sessionId);
          if (!current) return;
          const titleUpdate = "title" in info && current.titleSource !== "user"
            ? { title: info.title ?? "Untitled session", titleSource: "provider" as const }
            : {};
          this.store.patchMeta(sessionId, {
            ...titleUpdate,
            ...(info.providerUpdatedAt ? { providerUpdatedAt: info.providerUpdatedAt } : {}),
          });
          const updated = this.store.readMeta(sessionId);
          if (updated) this.send({ type: "session_runtime_updated", snapshot: this.snapshot(updated) });
        },
        onModelResolved: (model) => {
          const current = this.store.readMeta(sessionId);
          if (!current || current.resolvedModel === model) return;
          this.store.patchMeta(sessionId, { resolvedModel: model });
          const updated = this.store.readMeta(sessionId);
          if (updated) this.send({ type: "session_runtime_updated", snapshot: this.snapshot(updated) });
        },
      },
      );
    } catch (error) {
      await this.cancelNewCloudHandoff(meta, hadCloudHandoffBeforeLaunch, "driver construction failed", launchGeneration);
      this.emitEvent(sessionId, { kind: "error", message: `agent process could not be created: ${errText(error)}` });
      this.emitStatus(sessionId, "failed", errText(error));
      return false;
    }

    const retainedPromotions = new Map<string, SteeringOperation>();
    for (const operation of this.steeringRegistry.get(sessionId)?.values() ?? []) {
      if (operation.source && (
        (operation.providerStarted && !operation.settled) ||
        operation.result?.disposition === "uncertain"
      )) {
        retainedPromotions.set(operation.source.id, operation);
      }
    }
    const entry: ActiveSession = {
      sessionId,
      client,
      repoPath: meta.repoPath,
      cwd,
      worktree,
      context: meta.context,
      status: "starting",
      providerReady: false,
      running: false,
      queue: [],
      steerFenceIds: new Set(
        [...retainedPromotions.values()]
          .filter((operation) => !operation.settled)
          .map((operation) => operation.request.submissionId),
      ),
      reservedPromotions: retainedPromotions,
      steerFenceWaiters: new Set(),
      ...(meta.config.maxToolCalls
        ? {
            toolCallIds: new Set(
              this.store.readEvents(sessionId)
                .filter((event) => event.payload.kind === "tool_call")
                .map((event) => (event.payload as Extract<SessionEventPayload, { kind: "tool_call" }>).toolCallId),
            ),
          }
        : {}),
    };
    for (const operation of retainedPromotions.values()) {
      if (operation.settled) continue;
      const priorFenceEntry = operation.fenceEntry;
      if (priorFenceEntry && priorFenceEntry !== entry) {
        this.steerFences(priorFenceEntry).delete(operation.request.submissionId);
        if (!this.steerFences(priorFenceEntry).size) {
          for (const resolve of this.steerFenceWaiters(priorFenceEntry)) resolve();
          this.steerFenceWaiters(priorFenceEntry).clear();
        }
      }
      operation.fenceEntry = entry;
      operation.fenceInstalled = true;
    }
    this.active.set(sessionId, entry);
    this.send({ type: "process_status", sessionId, processStatus: "running", pid: client.pid });

    try {
      await client.initialize();
      if (this.active.get(sessionId) !== entry || !this.store.has(sessionId) ||
          !this.launchIsCurrent(sessionId, launchGeneration)) {
        const deleted = !this.store.has(sessionId);
        client.dispose();
        if (this.active.get(sessionId) === entry) this.active.delete(sessionId);
        if (deleted) await this.cancelNewCloudHandoff(meta, hadCloudHandoffBeforeLaunch, "session was deleted during driver initialization", launchGeneration);
        return false;
      }
      await client.newSession(cwd);
      if (this.active.get(sessionId) !== entry || !this.store.has(sessionId) ||
          !this.launchIsCurrent(sessionId, launchGeneration)) {
        const deleted = !this.store.has(sessionId);
        client.dispose();
        if (this.active.get(sessionId) === entry) this.active.delete(sessionId);
        if (deleted) await this.cancelNewCloudHandoff(meta, hadCloudHandoffBeforeLaunch, "session was deleted during provider session creation", launchGeneration);
        return false;
      }
      entry.providerReady = true;
      // App-server and ACP establish a real provider session during new/resume/load. Persist it
      // immediately so a crash before the first completed turn does not lose the coordinate. ACP
      // resumability remains capability-derived from the handshake stored above.
      if (meta.driver === "codex-app-server" || meta.driver === "acp") {
        this.captureAgentSessionId(sessionId, client);
      }
      if (meta.driver === "acp" && client.prepareCommand && client.invokeCommand) {
        const current = this.store.readMeta(sessionId);
        if (current) {
          this.sessionCommandAuthority.refresh(
            sessionId,
            current.capabilities?.slashCommands ?? [],
            `${this.runnerId}:${process.pid}:acp:${launchGeneration}`,
            "structured",
          );
          this.send({ type: "session_runtime_updated", snapshot: this.snapshot(current) });
        }
      }
      if (launchPreparation?.sessionCommandCatalogFresh && meta.driver === "claude-code" &&
          client.prepareCommand && client.invokeCommand) {
        this.sessionCommandAuthority.refresh(
          sessionId,
          meta.sessionSlashCommands ?? [],
          launchPreparation.sessionCommandCatalogProvenance ?? "claude-code:fresh",
        );
        const authorized = this.store.readMeta(sessionId);
        if (authorized) this.send({ type: "session_runtime_updated", snapshot: this.snapshot(authorized) });
      }
      this.emitTelemetry(meta, {
        metric: "launch",
        outcome: "success",
        durationMs: Date.now() - launchStarted,
        reason: resumeId ? "process_restart" : "fresh",
      });
      if (resumeId) {
        this.emitTelemetry(meta, { metric: "resume", outcome: "success", durationMs: Date.now() - launchStarted });
      }
      // NOTE: do NOT capture agentSessionId here. Claude mints a session id at newSession() time
      // before any `--session-id` turn has actually established it; persisting it now would make an
      // empty/never-run session look resumable and a later restart would `--resume` a nonexistent
      // id. We capture only after a turn succeeds (runPrompt).
    } catch (err) {
      if (!this.launchIsCurrent(sessionId, launchGeneration)) {
        client.dispose();
        if (this.active.get(sessionId) === entry) this.active.delete(sessionId);
        await this.cancelNewCloudHandoff(meta, hadCloudHandoffBeforeLaunch, "session launch was cancelled during driver initialization", launchGeneration);
        return false;
      }
      this.emitTelemetry(meta, {
        metric: "launch",
        outcome: "failure",
        durationMs: Date.now() - launchStarted,
        reason: resumeId ? "process_restart" : "fresh",
      });
      if (resumeId) {
        this.emitTelemetry(meta, { metric: "resume", outcome: "failure", durationMs: Date.now() - launchStarted });
      }
      if (!this.emitEvent(sessionId, { kind: "error", message: `agent init failed: ${errText(err)}` })) {
        const deleted = !this.store.has(sessionId);
        client.dispose();
        if (this.active.get(sessionId) === entry) this.active.delete(sessionId);
        if (deleted) await this.cancelNewCloudHandoff(meta, hadCloudHandoffBeforeLaunch, "session was deleted while driver initialization failed", launchGeneration);
        return false;
      }
      if (err instanceof CodexAppServerResumeError && err.retryable) {
        this.emitStatus(sessionId, "idle", `${errText(err)} — retry when the other app-server releases the thread`);
      } else {
        this.emitStatus(sessionId, "failed", errText(err));
      }
      client.dispose();
      if (this.active.get(sessionId) === entry) this.active.delete(sessionId);
      await this.cancelNewCloudHandoff(meta, hadCloudHandoffBeforeLaunch, "driver initialization failed", launchGeneration);
      return false;
    }
    this.log(`session ${sessionId} ready (cwd=${cwd}${resumeId ? ", resumed" : ""})`);
    return true;
  }

  private resolveLaunchIsolation(
    meta: SessionMeta,
    cwd: string,
    launchGeneration?: number,
  ): SpawnIsolation | undefined | Promise<SpawnIsolation | undefined> {
    if (meta.executionTarget?.adapter === "container") {
      if (!this.containerTargets || !meta.agentId) throw new Error("container execution target is not configured for this agent");
      return this.containerTargets.isolation(meta.executionTarget, meta.agentId, meta.command, meta.args, meta.sessionId);
    }
    if (meta.executionTarget?.adapter === "cloud") {
      return this.prepareCloudIsolation(meta, cwd, launchGeneration);
    }
    return this.resolveIsolation(this.executionIsolation, meta.context, {}, {
      driver: meta.driver,
      dataDir: this.stateDir,
      env: meta.env,
      sessionId: meta.sessionId,
      cwd,
      ...(this.runnerOwnerHash ? { ownerHash: this.runnerOwnerHash } : {}),
    });
  }

  private async prepareCloudIsolation(
    meta: SessionMeta,
    cwd: string,
    launchGeneration?: number,
  ): Promise<SpawnIsolation> {
    if (!this.cloudTargets || !meta.executionTarget || !meta.agentId) {
      throw new Error("cloud execution target is not configured for this agent");
    }
    if (meta.cloudAdapterHandoffKey && meta.executionHandoff?.targetId === meta.executionTarget.id) {
      return this.cloudTargets.isolation(
        meta.executionTarget,
        meta.agentId,
        meta.command,
        meta.args,
        meta.sessionId,
        meta.cloudAdapterHandoffKey,
      );
    }
    const request = meta.executionHandoffRequest ?? { artifacts: [] };
    let sourcePath = cwd;
    if (request.sourceSessionId) {
      if (request.sourceSessionId === meta.sessionId) throw new Error("cloud handoff source cannot be the destination session");
      const source = this.store.readMeta(request.sourceSessionId);
      if (!source || source.workspaceId !== meta.workspaceId || source.repoPath !== meta.repoPath) {
        throw new Error("cloud handoff source does not belong to the destination workspace");
      }
      if (["queued", "starting", "running", "input_required"].includes(source.status) || source.worktreePending) {
        throw new Error("cloud handoff source must be idle and have a settled worktree");
      }
      sourcePath = source.worktreePath ?? source.repoPath;
    }
    if (!meta.worktreePath) throw new Error("cloud targets require an isolated destination worktree");
    const budgetUsd = meta.config.costBudgetUsd;
    if (typeof budgetUsd !== "number") throw new Error("cloud target requires a cost budget");
    const prepared = await this.cloudTargets.prepareLaunch({
      target: meta.executionTarget,
      agentId: meta.agentId,
      hostAgentCommand: meta.command,
      hostAgentArgs: meta.args,
      sessionId: meta.sessionId,
      sourceSessionId: request.sourceSessionId,
      sourcePath,
      artifacts: request.artifacts,
      budgetUsd,
    });
    if (launchGeneration !== undefined &&
        !this.launchIsCurrent(meta.sessionId, launchGeneration)) {
      try {
        await this.cloudTargets.cancel(meta.executionTarget, prepared.adapterHandoffKey);
      } catch (error) {
        this.log(
          `stale cloud handoff cancellation failed for ${meta.sessionId}: ${errText(error)}`,
        );
      }
      throw new Error("cloud launch was superseded before its handoff could be published");
    }
    meta.executionHandoff = prepared.receipt;
    meta.cloudAdapterHandoffKey = prepared.adapterHandoffKey;
    if (meta.sessionSlashCommandProvenance?.targetAdapter === "cloud") {
      meta.sessionSlashCommandProvenance = {
        ...meta.sessionSlashCommandProvenance,
        handoffManifestDigest: prepared.receipt.manifestDigest,
      };
    }
    this.store.patchMeta(meta.sessionId, {
      executionHandoff: prepared.receipt,
      cloudAdapterHandoffKey: prepared.adapterHandoffKey,
      sessionSlashCommandProvenance: meta.sessionSlashCommandProvenance,
    });
    const snapshot = this.store.readMeta(meta.sessionId);
    if (snapshot) this.send({ type: "session_runtime_updated", snapshot: this.snapshot(snapshot) });
    return prepared.isolation;
  }

  private async cancelNewCloudHandoff(
    meta: SessionMeta,
    existedBeforeLaunch: boolean,
    reason: string,
    launchGeneration: number,
  ): Promise<void> {
    const target = meta.executionTarget;
    const handoffKey = meta.cloudAdapterHandoffKey;
    if (existedBeforeLaunch || !this.cloudTargets || target?.adapter !== "cloud" || !handoffKey) return;
    const owner = this.cloudHandoffOwners.get(meta.sessionId);
    const current = this.store.readMeta(meta.sessionId);
    // A replacement generation may deliberately reuse the exact handoff. Never let its stale
    // predecessor cancel that winning allocation. If the winner references another key, the stale
    // key is unowned and must be reaped.
    if (owner &&
        owner.launchGeneration !== launchGeneration &&
        owner.targetId === target.id &&
        owner.handoffKey === handoffKey &&
        current?.executionTarget?.adapter === "cloud" &&
        current.executionTarget.id === target.id &&
        current.cloudAdapterHandoffKey === handoffKey) {
      return;
    }
    try {
      await this.cloudTargets.cancel(target, handoffKey);
      meta.cloudAdapterHandoffKey = undefined;
      const afterCancel = this.store.readMeta(meta.sessionId);
      if (afterCancel?.executionTarget?.adapter === "cloud" &&
          afterCancel.executionTarget.id === target.id &&
          afterCancel.cloudAdapterHandoffKey === handoffKey) {
        this.store.patchMeta(meta.sessionId, { cloudAdapterHandoffKey: undefined });
      }
      if (owner?.launchGeneration === launchGeneration &&
          owner.targetId === target.id &&
          owner.handoffKey === handoffKey) {
        this.cloudHandoffOwners.delete(meta.sessionId);
      }
      this.log(`cancelled newly prepared cloud handoff for ${meta.sessionId} after ${reason}`);
    } catch (error) {
      this.log(`cloud handoff cancellation failed for ${meta.sessionId} after ${reason}: ${errText(error)}`);
    }
  }

  private claimCloudHandoff(meta: SessionMeta, launchGeneration: number): void {
    if (meta.executionTarget?.adapter !== "cloud" || !meta.cloudAdapterHandoffKey) return;
    this.cloudHandoffOwners.set(meta.sessionId, {
      targetId: meta.executionTarget.id,
      handoffKey: meta.cloudAdapterHandoffKey,
      launchGeneration,
    });
  }

  async logoutAgent(
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const meta = this.store.readMeta(sessionId);
    if (!meta) return { ok: false, error: "session not found" };
    const entry = this.active.get(sessionId);
    if (!entry) return { ok: false, error: "session agent is not active on this runner" };
    if (
      meta.status !== "idle" ||
      entry.running ||
      entry.queue.length ||
      this.rewinding.has(sessionId) ||
      this.forking.has(sessionId)
    ) {
      return { ok: false, error: "wait for the running and queued turns to finish before signing out" };
    }
    if (this.loggingOut.has(sessionId)) return { ok: false, error: "agent sign-out is already in progress" };
    if (!entry.client.logout) return { ok: false, error: "this agent does not support in-app logout" };
    this.loggingOut.add(sessionId);
    try {
      await entry.client.logout();
      entry.providerReady = false;
      this.revokeSessionCommandAuthority(sessionId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errText(error) };
    } finally {
      this.loggingOut.delete(sessionId);
    }
  }

  private nextQueueOrdinal(sessionId: string): number {
    const ordinal = this.nextQueueOrdinalBySession.get(sessionId) ?? 1;
    this.nextQueueOrdinalBySession.set(sessionId, ordinal + 1);
    return ordinal;
  }

  private ensureQueueOrdinal(sessionId: string, prompt: QueuedPrompt): number {
    if (typeof prompt.ordinal === "number" && Number.isSafeInteger(prompt.ordinal) && prompt.ordinal > 0) {
      const next = this.nextQueueOrdinalBySession.get(sessionId) ?? 1;
      if (prompt.ordinal >= next) this.nextQueueOrdinalBySession.set(sessionId, prompt.ordinal + 1);
      return prompt.ordinal;
    }
    prompt.ordinal = this.nextQueueOrdinal(sessionId);
    return prompt.ordinal!;
  }

  private snapshotQueuedConfig(sessionId: string, config?: SessionConfig): SessionConfig {
    return normalizedConfig({
      ...normalizedConfig(this.store.readMeta(sessionId)?.config),
      ...normalizedConfig(config),
    });
  }

  private stabilizeRecoveryQueue(sessionId: string, queue: QueuedPrompt[]): void {
    // The queue array is the authoritative pre-crash FIFO. Assign any legacy/mocked entries their
    // ordinals before exposing this array to new admissions; otherwise the newcomer can allocate
    // ordinal 1 and `insertQueuedPrompt` will place it ahead of the retained work. Existing
    // ordinals (including promotion reservations restored after a pre-provider exit) are observed
    // but never rewritten.
    for (const prompt of queue) this.ensureQueueOrdinal(sessionId, prompt);
    queue.sort((left, right) =>
      this.ensureQueueOrdinal(sessionId, left) - this.ensureQueueOrdinal(sessionId, right));
  }

  private insertQueuedPrompt(sessionId: string, queue: QueuedPrompt[], prompt: QueuedPrompt): void {
    const ordinal = this.ensureQueueOrdinal(sessionId, prompt);
    const index = queue.findIndex((candidate) => this.ensureQueueOrdinal(sessionId, candidate) > ordinal);
    if (index < 0) queue.push(prompt);
    else queue.splice(index, 0, prompt);
  }

  private queueCanAccept(queue: QueuedPrompt[], text: string, images: PromptImageInput[]): boolean {
    const heldBytes = queue.reduce((n, prompt) => n + queuedPromptBytes(prompt.text, prompt.images), 0);
    return queue.length < MAX_QUEUED_PROMPTS && heldBytes + queuedPromptBytes(text, images) <= MAX_QUEUED_BYTES;
  }

  private queueWithinCapacity(queue: QueuedPrompt[]): boolean {
    return queue.length <= MAX_QUEUED_PROMPTS &&
      queue.reduce((n, prompt) => n + queuedPromptBytes(prompt.text, prompt.images), 0) <= MAX_QUEUED_BYTES;
  }

  private steerFences(entry: ActiveSession): Set<string> {
    return entry.steerFenceIds ??= new Set();
  }

  private reservedPromotions(entry: ActiveSession): Map<string, SteeringOperation> {
    return entry.reservedPromotions ??= new Map();
  }

  private steerFenceWaiters(entry: ActiveSession): Set<() => void> {
    return entry.steerFenceWaiters ??= new Set();
  }

  private waitForSteeringFences(entry: ActiveSession): Promise<void> {
    if (!this.steerFences(entry).size) return Promise.resolve();
    return new Promise((resolve) => this.steerFenceWaiters(entry).add(resolve));
  }

  private queueCapacityView(entry: ActiveSession): QueuedPrompt[] {
    return [
      ...entry.queue,
      ...[...this.reservedPromotions(entry).values()]
        .map((operation) => operation.source)
        .filter((prompt): prompt is QueuedPrompt => !!prompt),
    ];
  }

  private recoveryQueueCapacityView(sessionId: string, queue: QueuedPrompt[]): QueuedPrompt[] {
    const queuedIds = new Set(queue.map((prompt) => prompt.id));
    return [
      ...queue,
      ...[...(this.steeringRegistry.get(sessionId)?.values() ?? [])]
        .map((operation) => operation.source)
        .filter((prompt): prompt is QueuedPrompt => !!prompt && !queuedIds.has(prompt.id)),
    ];
  }

  private reservedPromotionPrecedesQueue(sessionId: string, entry: ActiveSession): boolean {
    const next = entry.queue[0];
    if (!next) return false;
    const nextOrdinal = this.ensureQueueOrdinal(sessionId, next);
    return [...this.reservedPromotions(entry).values()].some((operation) =>
      !!operation.source && this.ensureQueueOrdinal(sessionId, operation.source) < nextOrdinal);
  }

  private cancelSteeringOperations(sessionId: string): void {
    for (const operation of this.steeringRegistry.get(sessionId)?.values() ?? []) {
      if (operation.settled) continue;
      operation.lifecycleCancelled = true;
      // A reserved queue item belongs to the discarded lifecycle. If the provider has not
      // accepted it, never restore it into a replacement session or a stopped/deleted queue.
      if (operation.source) operation.cancelRequested = true;
    }
  }

  private clearSteeringState(sessionId: string, message: string): void {
    this.cancelSteeringOperations(sessionId);
    for (const operation of this.steeringRegistry.get(sessionId)?.values() ?? []) {
      operation.resolveLifecycle();
      if (!operation.settled) {
        this.settleSteering(operation, this.makeSteeringResult(
          operation.request,
          "rejected",
          "policy_blocked",
          { message },
        ));
      }
      operation.source = undefined;
      operation.effectiveConfig = {};
    }
    this.steeringRegistry.delete(sessionId);
    // A running lane owns its async finally and clears steeringLaneRunning after the lifecycle
    // signal wakes it. Removing the old array is safe and prevents it from consuming new work;
    // a replacement lane will be pumped by that finally without concurrent consumers.
    this.steeringLanes.delete(sessionId);
    if (!this.steeringLaneRunning.has(sessionId)) this.steeringLaneRunning.delete(sessionId);
    this.nextQueueOrdinalBySession.delete(sessionId);
  }

  prompt(
    sessionId: string,
    text: string,
    images: PromptImageInput[] = [],
    slashCommand?: string,
    config?: SessionConfig,
    durable?: DurableCommandLifecycle,
    syntheticRecovery = false,
  ): boolean {
    if (durable && this.store.readEvents(sessionId).some((event) =>
      event.payload.kind === "user_message" && event.payload.commandId === durable.commandId)) {
      // The correlated turn marker is written and fsynced before `started`. If a journal write
      // failed at that boundary, replaying could submit the provider turn twice. Fail visibly into
      // uncertainty; an operator can inspect the exact command-tagged event before deciding.
      durable.uncertain("the durable user event already exists but provider submission state is unknown");
      return false;
    }
    const effectiveConfig = this.snapshotQueuedConfig(sessionId, config);
    // A prompt during a file rewind would snapshot (and run the agent over) a half-restored
    // tree — the reentrant store lock can't fence this same-process race, the set does.
    if (
      this.rewinding.has(sessionId) ||
      this.forking.has(sessionId) ||
      this.loggingOut.has(sessionId) ||
      this.closing.has(sessionId) ||
      this.deleting.has(sessionId)
    ) {
      const operation = this.rewinding.has(sessionId)
        ? "rewind"
        : this.forking.has(sessionId)
          ? "conversation fork"
          : this.loggingOut.has(sessionId)
            ? "agent sign-out"
            : this.closing.has(sessionId)
              ? "provider session close"
              : "session deletion";
      this.emitEvent(sessionId, { kind: "error", message: `a ${operation} is in progress — retry in a moment` });
      if (this.closing.has(sessionId) || this.deleting.has(sessionId)) {
        this.emitStatus(sessionId, this.store.readMeta(sessionId)?.status ?? "stopped");
      }
      durable?.failed(`a ${operation} is in progress`, "COMMAND_CANCELLED");
      return false;
    }
    if (!syntheticRecovery) {
      const meta = this.store.readMeta(sessionId);
      if (meta && isAdoptedSession(meta) && meta.adoptedBackgroundRecoveryAuthorized !== true) {
        this.store.patchMeta(sessionId, { adoptedBackgroundRecoveryAuthorized: true });
      }
    }
    // The first real message names an untitled session (Codex-style). meta.title is the source of
    // truth (snapshots carry it to the control plane), so set it here; the CP also derives the same
    // title live from the user_message event for immediacy.
    if (!syntheticRecovery && !slashCommand && text.trim()) {
      const meta = this.store.readMeta(sessionId);
      if (
        meta &&
        meta.titleSource !== "provider" &&
        meta.titleSource !== "user" &&
        (!meta.title || meta.title === "Untitled session")
      ) {
        this.store.patchMeta(sessionId, { title: titleFromPrompt(text), titleSource: "generated" });
      }
    }

    const recovering = this.recoveryQueues.get(sessionId);
    if (recovering) {
      if (!this.queueCanAccept(this.recoveryQueueCapacityView(sessionId, recovering), text, images)) {
        if (!this.emitEvent(
          sessionId,
          { kind: "error", message: "prompt queue is full while the agent is recovering" },
          durable,
        )) return false;
        durable?.failed("prompt queue is full while the agent is recovering", "QUEUE_FULL");
        return false;
      }
      durable?.queued();
      this.insertQueuedPrompt(sessionId, recovering, {
        id: durable?.commandId ?? randomUUID(), ordinal: this.nextQueueOrdinal(sessionId), text, images, slashCommand,
        config: effectiveConfig, durable, syntheticRecovery,
      });
      if (!this.recoveryLaunching.has(sessionId)) setImmediate(() => void this.recoverQueuedAppServer(sessionId));
      return true;
    }
    const entry = this.active.get(sessionId);
    const currentGeneration = this.launchGenerations.get(sessionId);
    if (!entry && currentGeneration !== undefined &&
        this.preLaunchAdmissionGenerations.get(sessionId) === currentGeneration) {
      const queue = this.preLaunchQueues.get(sessionId) ?? [];
      if (!this.queueCanAccept(queue, text, images)) {
        durable?.failed("prompt queue is full while the session waits for runner admission", "QUEUE_FULL");
        return false;
      }
      durable?.queued();
      this.insertQueuedPrompt(sessionId, queue, {
        id: durable?.commandId ?? randomUUID(), ordinal: this.nextQueueOrdinal(sessionId), text, images, slashCommand,
        config: effectiveConfig, durable, syntheticRecovery,
      });
      this.preLaunchQueues.set(sessionId, queue);
      this.emitQueue(sessionId);
      return true;
    }
    if (!entry) {
      // Not running in-process — try to RESUME it from the box store (Phase 2).
      void this.resumeAndPrompt(sessionId, text, images, slashCommand, effectiveConfig, durable, syntheticRecovery);
      return true;
    }
    if (entry.historyIntegrityFailure) {
      durable?.failed(entry.historyIntegrityFailure, "INVALID_COMMAND");
      return false;
    }
    // Bound the queue by count AND bytes: entries hold full prompt text + image payloads in
    // memory, so a runaway sender (a looping automation, a stuck retry, a burst of pasted
    // screenshots) must fail loudly, not OOM the box.
    if (!this.queueCanAccept(this.queueCapacityView(entry), text, images)) {
      if (!this.emitEvent(sessionId, {
        kind: "error",
        message: `prompt queue is full (max ${MAX_QUEUED_PROMPTS} prompts / ${Math.round(MAX_QUEUED_BYTES / 1024 / 1024)}MB); wait for the running turn or cancel queued prompts`,
      }, durable)) return false;
      durable?.failed("prompt queue is full", "QUEUE_FULL");
      return false;
    }
    // Only a user-originated prompt is the explicit resume signal. It may arrive while the
    // cancelled provider turn is still settling; clearing the hold now lets the current drain
    // continue into the preserved FIFO as soon as that turn returns.
    if (entry.holdQueuedPromptsAfterInterrupt && !syntheticRecovery) {
      this.setInterruptQueueHold(sessionId, entry, false);
    }
    // Config rides the queue ENTRY (applied when it dequeues in drain()) rather than being
    // applied now: with prompts B(config X) and C(config Y) queued, B must run under X, not Y.
    durable?.queued();
    this.insertQueuedPrompt(sessionId, entry.queue, {
      id: durable?.commandId ?? randomUUID(), ordinal: this.nextQueueOrdinal(sessionId), text, images, slashCommand,
      config: effectiveConfig, durable, syntheticRecovery,
    });
    this.emitQueue(sessionId);
    this.scheduleDrain(sessionId);
    return true;
  }

  private activatePreLaunchQueue(sessionId: string): void {
    const queue = this.preLaunchQueues.get(sessionId);
    if (!queue?.length) {
      if (queue) this.preLaunchQueues.delete(sessionId);
      return;
    }
    const entry = this.active.get(sessionId);
    if (!entry) {
      this.rejectPreLaunchQueue(sessionId, "session launch ended before runner admission");
      return;
    }
    for (const prompt of queue) {
      if (!this.queueCanAccept(this.queueCapacityView(entry), prompt.text, prompt.images)) {
        this.failQueuedPrompt(prompt, "prompt queue is full after runner admission", "QUEUE_FULL");
        continue;
      }
      this.insertQueuedPrompt(sessionId, entry.queue, prompt);
    }
    this.preLaunchQueues.delete(sessionId);
    this.emitQueue(sessionId);
    this.scheduleDrain(sessionId);
  }

  /** Admit a manual provider command only against authority minted by this live runner process.
   * Unlike legacy slash prompts, a missing process is never auto-resumed from persisted metadata:
   * persisted catalogs are display-only and cannot authorize execution. */
  invokeSessionCommand(
    message: InvokeSessionCommandMessage,
    lifecycle: SessionCommandInvocationLifecycle,
  ): boolean {
    const entry = this.active.get(message.sessionId);
    if (!entry || !this.store.has(message.sessionId)) {
      lifecycle.failed(
        this.store.has(message.sessionId)
          ? "the provider command is unavailable until the session has a fresh live catalog"
          : "session not found on this runner",
        this.store.has(message.sessionId) ? "COMMAND_UNAVAILABLE" : "SESSION_NOT_FOUND",
      );
      return false;
    }
    if (!entry.providerReady) {
      lifecycle.failed("the provider command is unavailable until session launch completes", "COMMAND_UNAVAILABLE");
      return false;
    }
    if (entry.historyIntegrityFailure) {
      lifecycle.failed(entry.historyIntegrityFailure, "INVALID_COMMAND");
      return false;
    }
    if (this.rewinding.has(message.sessionId) || this.forking.has(message.sessionId) ||
        this.loggingOut.has(message.sessionId) || this.closing.has(message.sessionId) ||
        this.deleting.has(message.sessionId)) {
      lifecycle.failed("a conflicting session lifecycle operation is in progress", "COMMAND_CANCELLED");
      return false;
    }

    const authorized = this.sessionCommandAuthority.resolve(message);
    if (!authorized.ok) {
      lifecycle.failed(sessionCommandAuthorizationError(authorized.code), authorized.code);
      return false;
    }
    if (!entry.client.prepareCommand || !entry.client.invokeCommand) {
      lifecycle.failed("the active provider transport does not support command invocation", "COMMAND_MODE_UNSUPPORTED");
      return false;
    }
    if (!this.queueCanAccept(this.queueCapacityView(entry), message.argumentText, [])) {
      lifecycle.failed("session command queue is full", "QUEUE_FULL");
      return false;
    }
    if (entry.holdQueuedPromptsAfterInterrupt) {
      this.setInterruptQueueHold(message.sessionId, entry, false);
    }

    lifecycle.queued();
    this.insertQueuedPrompt(message.sessionId, entry.queue, {
      id: randomUUID(),
      ordinal: this.nextQueueOrdinal(message.sessionId),
      text: message.argumentText,
      images: [],
      slashCommand: authorized.commandName,
      config: this.snapshotQueuedConfig(message.sessionId),
      sessionCommand: {
        invocationId: message.invocationId,
        submissionId: message.submissionId,
        providerCommandId: message.providerCommandId,
        catalogRevision: message.catalogRevision,
        expectedExecutionMode: message.expectedExecutionMode,
        lifecycle,
      },
    });
    this.emitQueue(message.sessionId);
    this.scheduleDrain(message.sessionId);
    return true;
  }

  /** Recovery preflight for an accepted/queued receipt from a prior runner process. This is
   * deliberately read-only. Once the live session is ready and has capacity, stale authority or
   * transport support is claimed too so invokeSessionCommand can produce an explicit rejection. */
  canRecoverSessionCommand(message: InvokeSessionCommandMessage): boolean {
    const entry = this.active.get(message.sessionId);
    if (!this.store.has(message.sessionId)) return true;
    if (!entry) return true;
    if (!entry.providerReady) return false;
    if (this.rewinding.has(message.sessionId) || this.forking.has(message.sessionId) ||
        this.loggingOut.has(message.sessionId) || this.closing.has(message.sessionId) ||
        this.deleting.has(message.sessionId)) return false;
    return this.queueCanAccept(this.queueCapacityView(entry), message.argumentText, []);
  }

  /** Submit one correlated steering attempt. Admission and promotion reservation are synchronous;
   * every provider-facing continuation runs through the per-session lane below. */
  private retainedSteeringOperationBytes(operation: SteeringOperation): number {
    const source = operation.source;
    return retainedSteeringPayloadBytes(
      source?.text ?? operation.request.text ?? "",
      source?.images ?? operation.request.images ?? [],
    );
  }

  private retainedSteeringRequestBytes(request: SteeringRequest): number {
    const promoted = request.promotePromptId
      ? this.active.get(request.sessionId)?.queue.find((prompt) => prompt.id === request.promotePromptId)
      : undefined;
    return retainedSteeringPayloadBytes(
      promoted?.text ?? request.text ?? "",
      promoted?.images ?? request.images ?? [],
    );
  }

  private recordTerminalSteeringRejection(
    registry: Map<string, SteeringOperation>,
    request: SteeringRequest,
    requestHash: string,
    result: SteeringResult,
  ): Promise<SteeringResult> {
    const compactRequest: SteeringRequest = {
      submissionId: request.submissionId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      ...(request.promotePromptId ? { promotePromptId: request.promotePromptId } : {}),
    };
    const promise = Promise.resolve(result);
    registry.set(request.submissionId, {
      request: compactRequest,
      requestHash,
      ordinal: 0,
      effectiveConfig: {},
      deadlineAt: Date.now(),
      cancelRequested: false,
      providerStarted: false,
      fenceInstalled: false,
      settled: true,
      references: 0,
      promise,
      resolve: () => {},
      lifecyclePromise: Promise.resolve(),
      resolveLifecycle: () => {},
      result,
      lastAccessOrdinal: ++this.steeringAccessOrdinal,
    });
    this.pruneSteeringRegistry(request.sessionId);
    return promise;
  }

  steerSession(request: SteeringRequest): Promise<SteeringResult> {
    let registry = this.steeringRegistry.get(request.sessionId);
    if (!registry) {
      registry = new Map();
      this.steeringRegistry.set(request.sessionId, registry);
    }
    const requestHash = steeringRequestHash(request);
    const prior = registry.get(request.submissionId);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        return Promise.resolve(this.makeSteeringResult(
          request,
          "rejected",
          "provider_rejected",
          { message: "submissionId was already used for different steering content" },
        ));
      }
      prior.lastAccessOrdinal = ++this.steeringAccessOrdinal;
      return prior.promise;
    }
    const unresolved = [...registry.values()].filter((operation) =>
      !operation.settled || (operation.result?.disposition === "uncertain" && !operation.resolved));
    const retainedBytes = unresolved.reduce(
      (total, operation) => total + this.retainedSteeringOperationBytes(operation),
      0,
    );
    if (unresolved.length >= MAX_UNRESOLVED_STEERING_ATTEMPTS_PER_SESSION ||
        retainedBytes + this.retainedSteeringRequestBytes(request) > MAX_QUEUED_BYTES) {
      const result = this.makeSteeringResult(request, "rejected", "queue_capacity_exceeded", {
        message: "too many unresolved steering attempts require operator resolution",
      });
      return this.recordTerminalSteeringRejection(registry, request, requestHash, result);
    }

    let resolveOperation!: (result: SteeringResult) => void;
    let resolveLifecycle!: () => void;
    const operation: SteeringOperation = {
      request,
      requestHash,
      ordinal: this.nextQueueOrdinal(request.sessionId),
      effectiveConfig: normalizedConfig(
        this.active.get(request.sessionId)?.activeTurnConfig ?? this.store.readMeta(request.sessionId)?.config,
      ),
      deadlineAt: Date.now() + this.steeringSubmissionTimeoutMs,
      cancelRequested: false,
      providerStarted: false,
      fenceInstalled: false,
      settled: false,
      references: 1,
      lastAccessOrdinal: ++this.steeringAccessOrdinal,
      promise: new Promise<SteeringResult>((resolve) => { resolveOperation = resolve; }),
      resolve: (result) => resolveOperation(result),
      lifecyclePromise: new Promise<void>((resolve) => { resolveLifecycle = resolve; }),
      resolveLifecycle: () => resolveLifecycle(),
    };
    registry.set(request.submissionId, operation);

    const rejected = this.admitSteering(operation);
    if (rejected) {
      this.settleSteering(operation, rejected);
    } else {
      const lane = this.steeringLanes.get(request.sessionId) ?? [];
      lane.push(operation);
      this.steeringLanes.set(request.sessionId, lane);
      this.pumpSteeringLane(request.sessionId);
    }
    return operation.promise;
  }

  resolveSteeringAttempt(request: ResolveSteeringRequest): ResolveSteeringResult {
    const base = {
      sessionId: request.sessionId,
      submissionId: request.submissionId,
      action: request.action,
    };
    const operation = this.steeringRegistry.get(request.sessionId)?.get(request.submissionId);
    if (!operation) return { ...base, applied: false, reason: "attempt_not_found" };
    operation.lastAccessOrdinal = ++this.steeringAccessOrdinal;
    if (operation.resolution) {
      return operation.resolution.action === request.action
        ? operation.resolution
        : { ...base, applied: false, reason: "resolution_action_conflict" };
    }
    if (!operation.settled || operation.result?.disposition !== "uncertain") {
      return { ...base, applied: false, reason: "attempt_not_uncertain" };
    }

    let queuedPromptId: string | undefined;
    const entry = this.active.get(request.sessionId);
    if (request.action === "queue_again") {
      if (operation.source) {
        const queue = entry?.queue ?? this.recoveryQueues.get(request.sessionId);
        if (!queue) return { ...base, applied: false, reason: "queue_unavailable" };
        const source = operation.source;
        const capacity = entry
          ? this.queueCapacityView(entry)
          : this.recoveryQueueCapacityView(request.sessionId, queue);
        if (!this.queueWithinCapacity(capacity)) {
          return { ...base, applied: false, reason: "queue_capacity_exceeded" };
        }
        if (entry) this.reservedPromotions(entry).delete(source.id);
        this.insertQueuedPrompt(request.sessionId, queue, source);
        queuedPromptId = source.id;
        operation.source = undefined;
      } else {
        const queue = entry?.queue ?? this.recoveryQueues.get(request.sessionId);
        const capacity = entry
          ? this.queueCapacityView(entry)
          : queue
            ? this.recoveryQueueCapacityView(request.sessionId, queue)
            : undefined;
        if (!queue || !capacity) return { ...base, applied: false, reason: "queue_unavailable" };
        if (!this.queueCanAccept(capacity, operation.request.text ?? "", operation.request.images ?? [])) {
          return { ...base, applied: false, reason: "queue_capacity_exceeded" };
        }
        queuedPromptId = this.convertDirectSteeringToQueue(operation) ?? undefined;
        if (!queuedPromptId) return { ...base, applied: false, reason: "queue_capacity_exceeded" };
      }
    } else if (operation.source) {
      if (entry) this.reservedPromotions(entry).delete(operation.source.id);
      operation.source = undefined;
    }

    operation.resolved = true;
    operation.request = {
      submissionId: operation.request.submissionId,
      sessionId: operation.request.sessionId,
      turnId: operation.request.turnId,
      ...(operation.request.promotePromptId ? { promotePromptId: operation.request.promotePromptId } : {}),
    };
    operation.effectiveConfig = {};
    if (entry) {
      this.emitQueue(request.sessionId);
      if (entry.queue.length && !entry.running && !entry.governanceTripped &&
          !entry.holdQueuedPromptsAfterInterrupt && !this.reservedPromotionPrecedesQueue(request.sessionId, entry)) {
        this.scheduleDrain(request.sessionId);
      }
    }
    const resolution: ResolveSteeringResult = {
      ...base,
      applied: true,
      ...(queuedPromptId ? { queuedPromptId } : {}),
    };
    operation.resolution = resolution;
    this.pruneSteeringRegistry(request.sessionId);
    return resolution;
  }

  private admitSteering(operation: SteeringOperation): SteeringResult | null {
    const { request } = operation;
    const hasDirect = !!request.text?.trim() || !!request.images?.length;
    if (hasDirect === !!request.promotePromptId) {
      return this.makeSteeringResult(request, "rejected", "provider_rejected", {
        message: "provide direct steering content or one queued prompt, but not both",
      });
    }
    if (hasDirect) {
      const pendingDirect = [...(this.steeringRegistry.get(request.sessionId)?.values() ?? [])]
        .filter((candidate) => !candidate.settled && !candidate.request.promotePromptId);
      const pendingBytes = pendingDirect.reduce((total, candidate) => total + queuedPromptBytes(
        candidate.request.text ?? "",
        candidate.request.images ?? [],
      ), 0);
      if (pendingDirect.length > MAX_QUEUED_PROMPTS || pendingBytes > MAX_QUEUED_BYTES) {
        return this.makeSteeringResult(request, "rejected", "queue_capacity_exceeded", {
          message: "too many steering submissions are awaiting delivery",
        });
      }
    }
    const entry = this.active.get(request.sessionId);
    if (!entry) return this.makeSteeringResult(request, "rejected", "no_active_provider_turn");
    const activeEligibility = this.steeringEligibility(entry);
    if (!activeEligibility.eligible) {
      return hasDirect && activeEligibility.reason === "no_active_provider_turn"
        ? this.handleDefiniteSteeringFailure(operation, activeEligibility.reason, activeEligibility.message)
        : this.makeSteeringResult(request, "rejected", activeEligibility.reason, {
            message: activeEligibility.message,
          });
    }
    if (entry.activeTurnId !== request.turnId) {
      return hasDirect
        ? this.handleDefiniteSteeringFailure(operation, "stale_turn")
        : this.makeSteeringResult(request, "rejected", "stale_turn");
    }

    if (request.promotePromptId) {
      const index = entry.queue.findIndex((prompt) => prompt.id === request.promotePromptId);
      if (index < 0) {
        return this.makeSteeringResult(
          request,
          "rejected",
          entry.activeTurnId === request.promotePromptId ? "queue_item_started" : "queue_item_absent",
        );
      }
      const source = entry.queue[index];
      if (!source) return this.makeSteeringResult(request, "rejected", "queue_item_absent");
      const sourceEligibility = this.steeringEligibility(entry, source);
      if (!sourceEligibility.eligible) {
        return this.makeSteeringResult(request, "rejected", sourceEligibility.reason, {
          message: sourceEligibility.message,
        });
      }
      entry.queue.splice(index, 1);
      operation.source = source;
      operation.ordinal = this.ensureQueueOrdinal(request.sessionId, source);
      this.reservedPromotions(entry).set(source.id, operation);
      this.emitQueue(request.sessionId);
    }
    this.steerFences(entry).add(request.submissionId);
    operation.fenceInstalled = true;
    operation.fenceEntry = entry;
    return null;
  }

  /** Authoritative runner-known steering admission gates. Protocol negotiation is owned by the
   * control plane, so callers must additionally require the steering protocol before presenting
   * this projection as actionable. */
  private steeringEligibility(entry: ActiveSession, prompt?: QueuedPrompt): SteeringEligibility {
    if (entry.historyIntegrityFailure) {
      return { eligible: false, reason: "history_integrity_failure", message: entry.historyIntegrityFailure };
    }
    if (entry.currentDurable || entry.currentSessionCommand) {
      return {
        eligible: false,
        reason: "policy_blocked",
        message: entry.currentDurable
          ? "Automation-owned turns cannot be steered."
          : "Provider command turns cannot be steered.",
      };
    }
    if (!entry.client.steer) {
      return {
        eligible: false,
        reason: "unsupported_driver",
        message: "This provider does not support steering.",
      };
    }
    if (entry.governanceTripped) {
      return {
        eligible: false,
        reason: "governance_blocked",
        message: "Resolve the governance limit before steering.",
      };
    }
    if (entry.cancelRequested || entry.interruptRequested) {
      return {
        eligible: false,
        reason: "policy_blocked",
        message: "Wait for the current stop request to settle before steering.",
      };
    }
    if (entry.holdQueuedPromptsAfterInterrupt) {
      return {
        eligible: false,
        reason: "policy_blocked",
        message: "Send a normal prompt to resume the held queue before steering.",
      };
    }
    if (!entry.running || !entry.activeTurnId) {
      return {
        eligible: false,
        reason: "no_active_provider_turn",
        message: "Wait for an active provider turn before steering.",
      };
    }
    if (!prompt) return { eligible: true };
    if (prompt.durable || prompt.sessionCommand || prompt.syntheticRecovery) {
      return {
        eligible: false,
        reason: "configuration_mismatch",
        message: "Workflow, automation, provider-command, and recovery prompts cannot be steered.",
      };
    }
    if (!configsEqual(prompt.config ?? entry.activeTurnConfig, entry.activeTurnConfig)) {
      return {
        eligible: false,
        reason: "configuration_mismatch",
        message: "The queued configuration differs from the active turn.",
      };
    }
    return { eligible: true };
  }

  private pumpSteeringLane(sessionId: string): void {
    if (this.steeringLaneRunning.has(sessionId)) return;
    this.steeringLaneRunning.add(sessionId);
    void (async () => {
      try {
        const lane = this.steeringLanes.get(sessionId);
        while (lane?.length) {
          const operation = lane.shift()!;
          if (operation.settled) continue;
          let result: SteeringResult;
          try {
            result = await this.executeSteering(operation);
          } catch (error) {
            result = this.makeSteeringResult(operation.request, "uncertain", "transport_uncertain", {
              message: `steering failed unexpectedly: ${errText(error)}`,
            });
          }
          this.settleSteering(operation, result);
        }
        if (!lane?.length) this.steeringLanes.delete(sessionId);
      } finally {
        this.steeringLaneRunning.delete(sessionId);
        if (this.steeringLanes.get(sessionId)?.length) this.pumpSteeringLane(sessionId);
      }
    })();
  }

  private async executeSteering(operation: SteeringOperation): Promise<SteeringResult> {
    const { request } = operation;
    if (operation.lifecycleCancelled && !operation.providerStarted) {
      return this.handleDefiniteSteeringFailure(operation, "policy_blocked", "session lifecycle discarded the promotion");
    }
    if (Date.now() >= operation.deadlineAt) return this.handleDefiniteSteeringFailure(operation, "provider_rejected", "steering expired before provider submission");
    let entry = this.active.get(request.sessionId);
    if (!entry || !entry.running || !entry.activeTurnId) {
      return this.handleDefiniteSteeringFailure(operation, "no_active_provider_turn");
    }
    if (entry.activeTurnId !== request.turnId) return this.handleDefiniteSteeringFailure(operation, "stale_turn");
    if (entry.currentDurable) return this.handleDefiniteSteeringFailure(operation, "policy_blocked", "automation-owned turns cannot be steered");
    if (entry.cancelRequested || entry.interruptRequested || entry.holdQueuedPromptsAfterInterrupt) {
      return this.handleDefiniteSteeringFailure(operation, "policy_blocked");
    }
    if (entry.governanceTripped) return this.handleDefiniteSteeringFailure(operation, "governance_blocked");
    if (!entry.client.steer) return this.handleDefiniteSteeringFailure(operation, "unsupported_driver");
    if (operation.source && !configsEqual(operation.source.config ?? entry.activeTurnConfig, entry.activeTurnConfig)) {
      return this.handleDefiniteSteeringFailure(operation, "configuration_mismatch");
    }

    const source = operation.source;
    const displayText = source?.slashCommand
      ? `/${source.slashCommand}${source.text ? ` ${source.text}` : ""}`.trim()
      : source?.text ?? request.text ?? "";
    const imageInputs = source?.images ?? request.images ?? [];
    const materialized = await this.awaitSteeringDeadline(
      this.materializeSteeringImages(request.sessionId, imageInputs),
      operation.deadlineAt,
      operation.lifecyclePromise,
    );
    if (materialized.cancelled) {
      return this.handleDefiniteSteeringFailure(operation, "policy_blocked", "session lifecycle discarded steering");
    }
    if (materialized.timedOut) {
      return this.handleDefiniteSteeringFailure(operation, "provider_rejected", "steering expired while preparing attachments");
    }
    if (materialized.error) {
      return this.handleDefiniteSteeringFailure(operation, "provider_rejected", `steering attachments failed: ${materialized.error}`);
    }

    entry = this.active.get(request.sessionId);
    if (!entry || !entry.running || !entry.activeTurnId) {
      return this.handleDefiniteSteeringFailure(operation, "no_active_provider_turn");
    }
    if (entry.activeTurnId !== request.turnId) return this.handleDefiniteSteeringFailure(operation, "stale_turn");
    if (entry.currentDurable) return this.handleDefiniteSteeringFailure(operation, "policy_blocked", "automation-owned turns cannot be steered");
    if (entry.cancelRequested || entry.interruptRequested || entry.holdQueuedPromptsAfterInterrupt) {
      return this.handleDefiniteSteeringFailure(operation, "policy_blocked");
    }
    if (entry.governanceTripped) return this.handleDefiniteSteeringFailure(operation, "governance_blocked");
    if (!entry.client.steer) return this.handleDefiniteSteeringFailure(operation, "unsupported_driver");
    if (Date.now() >= operation.deadlineAt) {
      return this.handleDefiniteSteeringFailure(operation, "provider_rejected", "steering expired before provider submission");
    }
    if (operation.lifecycleCancelled) {
      return this.handleDefiniteSteeringFailure(operation, "policy_blocked", "session lifecycle discarded the promotion");
    }

    operation.providerStarted = true;
    const providerPromise = entry.client.steer({
      submissionId: request.submissionId,
      deadlineAt: operation.deadlineAt,
      text: displayText,
      images: materialized.value,
    });
    const provider = await this.awaitSteeringDeadline(providerPromise, operation.deadlineAt, operation.lifecyclePromise);
    if (provider.cancelled) {
      return this.handleDefiniteSteeringFailure(operation, "policy_blocked", "session lifecycle discarded steering");
    }
    if (provider.timedOut) {
      void providerPromise.then(
        (late) => this.log(`ignored late steering result for ${request.sessionId}/${request.submissionId}: ${late.outcome}`),
        () => {},
      );
      return this.makeSteeringResult(request, "uncertain", "transport_uncertain", {
        message: "provider steering acknowledgement exceeded the submission deadline",
      });
    }
    if (provider.error) {
      return this.makeSteeringResult(request, "uncertain", "transport_uncertain", { message: provider.error });
    }
    const outcome = provider.value as DriverSteerResult;
    if (outcome.outcome === "uncertain") {
      return this.makeSteeringResult(request, "uncertain", "transport_uncertain", { message: outcome.reason });
    }
    if (outcome.outcome === "no_active_turn") {
      return this.handleDefiniteSteeringFailure(operation, "no_active_provider_turn", outcome.reason);
    }
    if (outcome.outcome === "stale_turn") {
      return this.handleDefiniteSteeringFailure(operation, "stale_turn", outcome.reason);
    }
    if (outcome.outcome === "rejected") {
      return this.handleDefiniteSteeringFailure(operation, "provider_rejected", outcome.reason);
    }

    const persisted = this.appendAcceptedSteeringEvent(
      request.sessionId,
      request.turnId,
      request.submissionId,
      displayText,
      imageInputs,
    );
    if (!persisted) {
      return this.makeSteeringResult(request, "uncertain", "history_integrity_failure", {
        message: "provider accepted steering but its user message could not be durably recorded",
      });
    }
    return this.makeSteeringResult(request, "accepted", "accepted", {
      providerTurnId: outcome.providerTurnId,
      ...(operation.cancelRequested ? { message: "steering was accepted before queued cancellation could take effect" } : {}),
    });
  }

  private async materializeSteeringImages(sessionId: string, inputs: PromptImageInput[]): Promise<PromptImage[]> {
    const references = inputs.filter(isPromptImageReference);
    const resolved = references.length
      ? await (this.resolvePromptImages?.(sessionId, references) ?? Promise.reject(new Error("prompt image references are unsupported by this runner")))
      : [];
    if (resolved.length !== references.length) throw new Error("prompt image resolver returned an unexpected result count");
    let referenceIndex = 0;
    const images = inputs.map((image) => isPromptImageReference(image) ? resolved[referenceIndex++]! : image);
    if (images.some((image) => !image || typeof image.data !== "string")) {
      throw new Error("prompt image resolver returned an incomplete result");
    }
    return images;
  }

  private awaitSteeringDeadline<T>(
    promise: Promise<T>,
    deadlineAt: number,
    lifecyclePromise?: Promise<void>,
  ): Promise<
    { cancelled: true; timedOut: false } |
    { cancelled?: false; timedOut: true } |
    { cancelled?: false; timedOut: false; value: T; error?: undefined } |
    { cancelled?: false; timedOut: false; error: string; value?: undefined }
  > {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return Promise.resolve({ timedOut: true });
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ timedOut: true });
      }, remaining);
      promise.then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      }, (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, error: errText(error) });
      });
      lifecyclePromise?.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ cancelled: true, timedOut: false });
      });
    });
  }

  private handleDefiniteSteeringFailure(
    operation: SteeringOperation,
    reason: SteerResultReason,
    message?: string,
  ): SteeringResult {
    if (operation.source) {
      this.restorePromotedPrompt(operation);
      return this.makeSteeringResult(operation.request, "rejected", reason, { message });
    }
    if (reason === "stale_turn" || reason === "no_active_provider_turn" ||
        (reason === "provider_rejected" && Date.now() >= operation.deadlineAt)) {
      const queuedPromptId = this.convertDirectSteeringToQueue(operation);
      if (queuedPromptId) {
        return this.makeSteeringResult(operation.request, "converted_to_queue", reason, { queuedPromptId, message });
      }
      return this.makeSteeringResult(operation.request, "rejected", "queue_capacity_exceeded", { message });
    }
    return this.makeSteeringResult(operation.request, "rejected", reason, { message });
  }

  private convertDirectSteeringToQueue(operation: SteeringOperation): string | null {
    const { request } = operation;
    const entry = this.active.get(request.sessionId);
    const queue = entry?.queue ?? this.recoveryQueues.get(request.sessionId);
    const capacity = entry
      ? this.queueCapacityView(entry)
      : queue
        ? this.recoveryQueueCapacityView(request.sessionId, queue)
        : undefined;
    if (!queue || !capacity || !this.queueCanAccept(capacity, request.text ?? "", request.images ?? [])) return null;
    const id = randomUUID();
    this.insertQueuedPrompt(request.sessionId, queue, {
      id,
      ordinal: operation.ordinal,
      text: request.text ?? "",
      images: request.images ?? [],
      config: operation.effectiveConfig,
    });
    if (entry) this.emitQueue(request.sessionId);
    return id;
  }

  private restorePromotedPrompt(operation: SteeringOperation): void {
    const source = operation.source;
    if (!source) return;
    const entry = this.active.get(operation.request.sessionId);
    if (entry) this.reservedPromotions(entry).delete(source.id);
    if (operation.sourceRestored) {
      operation.source = undefined;
      return;
    }
    if (operation.cancelRequested) {
      source.durable?.failed("queued command was cancelled during steering promotion", "COMMAND_CANCELLED");
      operation.source = undefined;
      if (entry) this.emitQueue(operation.request.sessionId);
      return;
    }
    const queue = entry?.queue ?? this.recoveryQueues.get(operation.request.sessionId);
    if (queue) {
      this.insertQueuedPrompt(operation.request.sessionId, queue, source);
      if (entry) this.emitQueue(operation.request.sessionId);
    }
    operation.source = undefined;
  }

  /** A driver can exit while attachments are still materializing, before provider delivery is
   * possible. Put those reservations back into the provably-unsubmitted recovery FIFO. */
  private restoreUnsubmittedPromotions(sessionId: string, entry: ActiveSession): void {
    for (const [promptId, operation] of this.reservedPromotions(entry)) {
      if (operation.providerStarted || !operation.source) continue;
      this.reservedPromotions(entry).delete(promptId);
      if (operation.cancelRequested) {
        operation.source = undefined;
        continue;
      }
      this.insertQueuedPrompt(sessionId, entry.queue, operation.source);
      operation.sourceRestored = true;
    }
  }

  private appendAcceptedSteeringEvent(
    sessionId: string,
    turnId: string,
    submissionId: string,
    text: string,
    images: PromptImageInput[],
  ): boolean {
    if (this.active.get(sessionId)?.historyIntegrityFailure) return false;
    try {
      const payload: SessionEventPayload = {
        kind: "user_message",
        text,
        images: images.length ? images : undefined,
        turnId,
        submissionId,
        deliveryIntent: "steer",
      };
      const stored = this.store.appendEvent(sessionId, payload);
      if (!stored) throw new Error("session metadata disappeared before steering history append");
      // Acceptance is not observable until the source-of-truth event crosses its durability fence.
      this.store.flush(sessionId);
      try {
        this.accrueMeta(sessionId, payload);
        this.send({ type: "session_event", sessionId, payload, seq: stored.seq, ts: stored.ts });
      } catch (relayError) {
        this.log(`persisted steering event relay failed for ${sessionId}: ${errText(relayError)}`);
      }
      return true;
    } catch (error) {
      this.failHistoryIntegrity(sessionId, error);
      return false;
    }
  }

  private makeSteeringResult(
    request: SteeringRequest,
    disposition: SteeringResult["disposition"],
    reason: SteerResultReason,
    extra: Partial<Pick<SteeringResult, "queuedPromptId" | "providerTurnId" | "message">> = {},
  ): SteeringResult {
    const boundedMessage = extra.message === undefined
      ? undefined
      : extra.message.slice(0, MAX_STEERING_RESULT_MESSAGE_CHARS);
    return {
      submissionId: request.submissionId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      disposition,
      reason,
      ...extra,
      ...(boundedMessage !== undefined ? { message: boundedMessage } : {}),
    };
  }

  private settleSteering(operation: SteeringOperation, result: SteeringResult): void {
    if (operation.settled) return;
    operation.settled = true;
    operation.result = result;
    operation.references = 0;
    if (result.disposition !== "uncertain") {
      operation.request = {
        submissionId: operation.request.submissionId,
        sessionId: operation.request.sessionId,
        turnId: operation.request.turnId,
        ...(operation.request.promotePromptId ? { promotePromptId: operation.request.promotePromptId } : {}),
      };
    }
    if (result.disposition === "accepted") {
      const source = operation.source;
      const entry = this.active.get(operation.request.sessionId);
      if (source && entry) this.reservedPromotions(entry).delete(source.id);
      operation.source = undefined;
    }
    operation.resolve(result);
    // Promise continuations (the index handler emits the correlated result) run before this queued
    // release, preserving result-before-drain ordering without coupling SessionManager to sockets.
    queueMicrotask(() => this.releaseSteering(operation));
  }

  private releaseSteering(operation: SteeringOperation): void {
    const sessionId = operation.request.sessionId;
    const entry = this.active.get(sessionId);
    const fenceEntry = operation.fenceEntry;
    if (fenceEntry && operation.fenceInstalled) {
      this.steerFences(fenceEntry).delete(operation.request.submissionId);
      if (!this.steerFences(fenceEntry).size) {
        for (const resolve of this.steerFenceWaiters(fenceEntry)) resolve();
        this.steerFenceWaiters(fenceEntry).clear();
      }
    }
    if (entry) {
      const sourceId = operation.source?.id ?? operation.request.promotePromptId;
      if (sourceId && operation.result?.disposition !== "uncertain") {
        this.reservedPromotions(entry).delete(sourceId);
      }
      this.emitQueue(sessionId);
      if (!this.steerFences(entry).size && entry.queue.length &&
          !entry.governanceTripped && !entry.holdQueuedPromptsAfterInterrupt) {
        setImmediate(() => this.scheduleDrain(sessionId));
      }
    }
    operation.fenceInstalled = false;
    operation.fenceEntry = undefined;
    this.pruneSteeringRegistry(sessionId);
  }

  private pruneSteeringRegistry(sessionId: string): void {
    const registry = this.steeringRegistry.get(sessionId);
    if (!registry) return;
    const terminal = [...registry.values()].filter((operation) =>
      operation.settled && operation.references === 0 &&
      (operation.result?.disposition !== "uncertain" || operation.resolved))
      .sort((left, right) => left.lastAccessOrdinal - right.lastAccessOrdinal);
    while (terminal.length > MAX_STEERING_TERMINALS_PER_SESSION) {
      const evicted = terminal.shift()!;
      registry.delete(evicted.request.submissionId);
    }
    if (!registry.size) this.steeringRegistry.delete(sessionId);
  }

  /** Report a session's current not-yet-started queue to the control plane (ephemeral relay).
   * Text is a bounded PREVIEW — dashboards only render/cancel queue entries, and relaying a
   * multi-hundred-KB prompt per queue change would amplify through every reconnect flush and
   * every connected dashboard. The full text stays in the runner's queue for the actual turn. */
  private emitQueue(sessionId: string): void {
    const entry = this.active.get(sessionId);
    const waitingForAdmission = !entry ? this.preLaunchQueues.get(sessionId) : undefined;
    const visible = entry || waitingForAdmission
      ? [
          ...(entry?.queue ?? waitingForAdmission ?? []).map((prompt) => ({
            prompt,
            steeringState: undefined as "promoting" | "uncertain" | undefined,
          })),
          ...[...(entry ? this.reservedPromotions(entry).values() : [])]
            .filter((operation) => operation.source)
            .map((operation) => ({
              prompt: operation.source!,
              steeringState: operation.result?.disposition === "uncertain" ? "uncertain" as const : "promoting" as const,
            })),
        ].sort((left, right) =>
          this.ensureQueueOrdinal(sessionId, left.prompt) - this.ensureQueueOrdinal(sessionId, right.prompt))
      : [];
    this.send({
      type: "session_queue",
      sessionId,
      queue: visible.map(({ prompt: q, steeringState }) => {
        const eligibility = steeringState
          ? {
              eligible: false as const,
              message: steeringState === "uncertain"
                ? "Resolve uncertain delivery before steering this queued prompt."
                : "Steering is already in progress for this queued prompt.",
            }
          : entry
            ? this.steeringEligibility(entry, q)
            : { eligible: false as const, message: "Wait for an active provider turn before steering." };
        return {
          id: q.id,
          text: q.text.length > 500 ? q.text.slice(0, 500) + "…" : q.text,
          hasImages: q.images.length > 0,
          steerable: eligibility.eligible,
          ...(!eligibility.eligible ? { steerDisabledReason: eligibility.message } : {}),
          ...(steeringState ? { steeringState } : {}),
          liveQueueObserved: true,
        };
      }),
      ...(entry?.holdQueuedPromptsAfterInterrupt ? { held: true } : {}),
      ...(entry?.running && entry.activeTurnId ? { activeTurnId: entry.activeTurnId } : {}),
    });
  }

  /** Publish both edges of the interruption hold so clients never infer it from queue contents. */
  private setInterruptQueueHold(sessionId: string, entry: ActiveSession, held: boolean): void {
    if (entry.holdQueuedPromptsAfterInterrupt === held) return;
    entry.holdQueuedPromptsAfterInterrupt = held;
    this.emitQueue(sessionId);
  }

  /** Publish exactly one authoritative queue projection for every stored, non-deleted session
   * after registration. Empty frames clear stale control-plane overlays; non-empty active queues
   * preserve in-memory work across a transport-only reconnect. */
  reportQueues(): void {
    const reported = new Set<string>();
    for (const stored of this.store.listSessions()) {
      const sessionId = stored.sessionId;
      if (reported.has(sessionId) || this.store.isDeleted(sessionId)) continue;
      reported.add(sessionId);
      // emitQueue reads the live entry when present (including an empty active queue); otherwise
      // it emits the explicit empty inactive projection needed to clear stale reconnect state.
      this.emitQueue(sessionId);
    }
  }

  /** Drop ONE not-yet-started prompt from a session's queue (the running turn was already dequeued,
   * so it can't be cancelled this way). No-op if the id already ran or the session isn't active. */
  removeQueuedPrompt(sessionId: string, promptId: string): void {
    const entry = this.active.get(sessionId);
    const preLaunch = !entry ? this.preLaunchQueues.get(sessionId) : undefined;
    if (!entry && !preLaunch) return;
    const reserved = entry ? this.reservedPromotions(entry).get(promptId) : undefined;
    if (reserved && entry) {
      if (reserved.result?.disposition === "uncertain") {
        // Queue cancellation is the dashboard's legacy spelling of Dismiss. Route it through the
        // same terminal transition so the retained payload is scrubbed and a later Queue Again
        // cannot resurrect an empty or already-dismissed attempt.
        this.resolveSteeringAttempt({
          sessionId,
          submissionId: reserved.request.submissionId,
          action: "dismiss",
        });
        return;
      }
      reserved.cancelRequested = true;
      this.emitQueue(sessionId);
      if (!this.reservedPromotionPrecedesQueue(sessionId, entry) && entry.queue.length &&
          !entry.running && !entry.governanceTripped && !entry.holdQueuedPromptsAfterInterrupt) {
        this.scheduleDrain(sessionId);
      }
      return;
    }
    const queue = entry?.queue ?? preLaunch!;
    const before = queue.length;
    const removed = queue.filter((q) => q.id === promptId);
    const retained = queue.filter((q) => q.id !== promptId);
    if (entry) entry.queue = retained;
    else if (retained.length) this.preLaunchQueues.set(sessionId, retained);
    else this.preLaunchQueues.delete(sessionId);
    this.rejectQueued(removed, "queued command was cancelled");
    if (retained.length !== before) this.emitQueue(sessionId);
  }

  private rejectQueued(queue: QueuedPrompt[], error: string): void {
    for (const prompt of queue) this.failQueuedPrompt(prompt, error, "COMMAND_CANCELLED");
  }

  /** Terminalize and remove a pre-admission queue, then clear its live dashboard projection. */
  private rejectPreLaunchQueue(sessionId: string, error: string): boolean {
    const queue = this.preLaunchQueues.get(sessionId);
    if (!queue) return false;
    this.rejectQueued(queue, error);
    this.preLaunchQueues.delete(sessionId);
    this.emitQueue(sessionId);
    return true;
  }

  private failQueuedPrompt(
    prompt: QueuedPrompt,
    error: string,
    code: "COMMAND_CANCELLED" | "INVALID_COMMAND" | "QUEUE_FULL",
  ): void {
    prompt.durable?.failed(error, code);
    prompt.sessionCommand?.lifecycle.failed(error, code === "QUEUE_FULL" ? "INVALID_COMMAND" : code);
  }

  /** Fire-and-forget drains are always observed. Event-history errors are contained at emitEvent;
   * this is a final guard for unexpected driver/config failures so none become unhandled promises. */
  private scheduleDrain(sessionId: string): void {
    void this.drain(sessionId).catch((error) => {
      try {
        const entry = this.active.get(sessionId);
        if (!entry || entry.historyIntegrityFailure) return;
        const detail = `session queue drain failed: ${errText(error)}`;
        this.log(`${detail} (${sessionId})`);
        const queued = entry.queue.splice(0);
        this.rejectQueued(queued, detail);
        this.emitStatus(sessionId, "failed", detail);
        try {
          entry.client.cancel();
        } catch (cancelError) {
          this.log(`session drain cancel failed for ${sessionId}: ${errText(cancelError)}`);
        }
      } catch (containmentError) {
        this.log(`session drain containment failed for ${sessionId}: ${errText(containmentError)}`);
      }
    });
  }

  /** Re-spawn a stored (not-in-process) session and run `text`. Continues the prior agent
   * conversation when it was actually established (resume by id); otherwise re-launches fresh. */
  private async resumeAndPrompt(
    sessionId: string,
    text: string,
    images: PromptImageInput[],
    slashCommand?: string,
    config?: SessionConfig,
    durable?: DurableCommandLifecycle,
    syntheticRecovery = false,
  ): Promise<void> {
    const meta = this.store.readMeta(sessionId);
    if (!meta) {
      this.emitEvent(sessionId, { kind: "error", message: "session is not active on this runner" });
      this.emitStatus(sessionId, "failed");
      durable?.failed("session is not active on this runner", "SESSION_NOT_FOUND");
      return;
    }
    if (syntheticRecovery && (meta.status === "stopped" || !automaticClaudeRecoveryAllowed(meta))) {
      this.log(`orphan recovery skipped for session without automatic recovery authority ${sessionId}`);
      return;
    }
    // Adopted with the read-only sentinel (empty command): the box had no agent for the session's
    // driver+context at ADOPT time. That condition can be transient — the adopt may have raced the
    // async discovery pass, or the user installed the CLI afterwards — so re-resolve against the
    // box's live agent list before refusing, and heal the stored launch params in place.
    if (!meta.command) {
      const launch = this.resolveLaunch?.(meta.driver, meta.context) ?? null;
      if (launch) {
        // The box gained a matching agent since adopt time — the session stops being read-only.
        // The fresh readMeta below picks the patched params up and the normal resume path runs.
        this.log(`read-only session ${sessionId} healed — a ${meta.driver} agent is now available`);
        this.store.patchMeta(sessionId, { command: launch.command, args: launch.args, env: {} });
      } else {
        const ctx = meta.context.kind === "wsl" ? `wsl:${meta.context.distro}` : "native";
        // SEND-ONLY refusal — deliberately NOT emitEvent/appendEvent: the adopt creates the row
        // before the (slow, up to ~8s on WSL) transcript read, and backfillTranscript only fills a
        // seq-0 log. Persisting this error would bump seq and silently discard the pending history.
        this.send({
          type: "session_event",
          sessionId,
          payload: {
            kind: "error",
            message:
              `this session has no agent on this box that can resume it ` +
              `(driver ${meta.driver}, context ${ctx}) — read-only history`,
          },
        });
        this.emitStatus(sessionId, "stopped"); // meta-only patch — appends nothing
        durable?.failed("session has no compatible agent to resume", "INVALID_COMMAND");
        return;
      }
    }
    const established = meta.agentSessionId != null;
    if (!established && meta.driver === "codex-app-server" && meta.seq > 0) {
      this.emitEvent(sessionId, {
        kind: "error",
        message: "this app-server history has no persisted Codex thread id and cannot be continued without risking a replacement conversation",
      });
      this.emitStatus(sessionId, "stopped");
      durable?.failed("app-server history has no resumable thread id", "INVALID_COMMAND");
      return;
    }
    if (!established && meta.driver === "acp" && meta.seq > 0) {
      this.emitEvent(sessionId, {
        kind: "error",
        message: "this ACP history has no persisted provider session id and cannot be continued without risking a replacement conversation",
      });
      this.emitStatus(sessionId, "stopped");
      durable?.failed("ACP history has no resumable provider session id", "INVALID_COMMAND");
      return;
    }
    // An agent whose conversation was established but did not negotiate resume/load
    // is read-only once its process is gone — re-launching fresh would silently start a NEW agent
    // conversation under the same session, which is more confusing than refusing.
    if (established && !canResumeSession(meta)) {
      this.emitEvent(sessionId, {
        kind: "error",
        message: "this session can't be continued here — its agent has no resume-by-id, so it's read-only history",
      });
      this.emitStatus(sessionId, "stopped");
      durable?.failed("provider session cannot resume by id", "INVALID_COMMAND");
      return;
    }
    if (config) this.patchSessionConfig(sessionId, config);
    const fresh = this.store.readMeta(sessionId)!;
    // Resume only when established AND the driver supports it; a never-established session (e.g. the
    // runner restarted before its first turn finished) re-launches fresh so it stays promptable.
    const resumeId = established && canResumeSession(fresh) ? (fresh.agentSessionId ?? undefined) : undefined;
    if (resumeId && !this.store.acquireLock(sessionId, this.lockOwner)) {
      this.emitEvent(sessionId, { kind: "error", message: "this session is being resumed by another runner — retry shortly" });
      this.emitStatus(sessionId, "idle");
      durable?.failed("session is owned by another runner process", "COMMAND_CANCELLED");
      return;
    }
    const launchGeneration = this.beginLaunchGeneration(sessionId);
    if (!(await this.acquireAdmission(sessionId))) {
      const superseded = this.launchWasSuperseded(sessionId, launchGeneration);
      this.finishLaunchGeneration(sessionId, launchGeneration);
      if (superseded) {
        durable?.failed("session resume was superseded by a replacement", "COMMAND_CANCELLED");
        return;
      }
      if (resumeId) this.store.releaseLock(sessionId, this.lockOwner);
      durable?.failed("session resume was cancelled before runner admission", "COMMAND_CANCELLED");
      return;
    }
    if (!this.launchIsCurrent(sessionId, launchGeneration)) {
      const superseded = this.launchWasSuperseded(sessionId, launchGeneration);
      this.finishLaunchGeneration(sessionId, launchGeneration);
      if (resumeId && !superseded) this.store.releaseLock(sessionId, this.lockOwner);
      durable?.failed(
        superseded
          ? "session resume was superseded by a replacement"
          : "session resume was cancelled before provider startup",
        "COMMAND_CANCELLED",
      );
      return;
    }
    let ok: boolean;
    let stillOwnsLaunch = false;
    let superseded = false;
    try {
      ok = await this.launch(fresh, resumeId, launchGeneration);
      stillOwnsLaunch = this.launchIsCurrent(sessionId, launchGeneration);
      superseded = this.launchWasSuperseded(sessionId, launchGeneration);
    } finally {
      this.finishLaunchGeneration(sessionId, launchGeneration);
    }
    // launch() may return false after an async preparation was superseded. Capture ownership
    // before finishLaunchGeneration removes our marker: the replacement can be waiting in its own
    // preparation with no active entry yet, while already owning this same admission and lock.
    if (!stillOwnsLaunch) {
      if (resumeId && !superseded) this.store.releaseLock(sessionId, this.lockOwner);
      durable?.failed(
        superseded
          ? "session resume was superseded by a replacement"
          : "session resume was cancelled before provider startup",
        "COMMAND_CANCELLED",
      );
      return;
    }
    if (!ok) {
      this.releaseAdmissionIfInactive(sessionId);
      if (resumeId) this.store.releaseLock(sessionId, this.lockOwner);
      durable?.failed("provider session could not be resumed", "INVALID_COMMAND");
      return;
    }
    this.prompt(sessionId, text, images, slashCommand, config, durable, syntheticRecovery);
  }

  /** Persist turn configuration without presenting a model resolved under an older alias. */
  private patchSessionConfig(sessionId: string, config: SessionConfig): void {
    const current = this.store.readMeta(sessionId);
    const modelChanged = current?.config.model !== config.model;
    this.store.patchMeta(sessionId, {
      config,
      ...(modelChanged ? { resolvedModel: null } : {}),
    });
  }

  /** Run queued prompts one at a time, holding the box lock only while turns are draining. */
  private async drain(sessionId: string): Promise<void> {
    const entry = this.active.get(sessionId);
    if (!entry || entry.running || entry.governanceTripped || entry.holdQueuedPromptsAfterInterrupt ||
        this.steerFences(entry).size || this.reservedPromotionPrecedesQueue(sessionId, entry)) return;
    if (!this.store.acquireLock(sessionId, this.lockOwner)) {
      if (!this.emitEvent(sessionId, { kind: "error", message: "this session is being driven by another dashboard" })) {
        return;
      }
      this.emitStatus(sessionId, "idle");
      this.rejectQueued(entry.queue, "session is being driven by another runner process");
      entry.queue.length = 0;
      this.emitQueue(sessionId);
      return;
    }
    // Refresh the lock while we drive so a long turn (minutes) never ages past the stale window and
    // gets stolen by another runner mid-turn.
    const refresh = setInterval(() => this.store.refreshLock(sessionId, this.lockOwner), LOCK_REFRESH_MS);
    this.lockTimers.set(sessionId, refresh);
    entry.running = true;
    try {
      while (this.active.has(sessionId) && entry.queue.length) {
        if (this.steerFences(entry).size || this.reservedPromotionPrecedesQueue(sessionId, entry)) break;
        const next = entry.queue.shift()!;
        this.ensureQueueOrdinal(sessionId, next);
        entry.activeTurnId = next.id;
        this.emitQueue(sessionId); // it just left the queue and is about to run
        // This is the exact per-turn boundary. Reset before the first awaited configuration/image
        // step so an interrupt received anywhere in pre-provider preparation cannot be erased.
        entry.cancelRequested = false;
        entry.interruptRequested = false;
        if (next.config && !configsEqual(next.config, this.store.readMeta(sessionId)?.config)) {
          // Apply the config THIS prompt was sent with (see QueuedPrompt.config). Drivers pick
          // config up at turn start, so setting it here is exactly "this turn runs under it".
          try {
            await entry.client.setConfig(next.config);
            this.patchSessionConfig(sessionId, next.config);
            if (next.config.maxToolCalls && !entry.toolCallIds) {
              entry.toolCallIds = new Set(
                this.store.readEvents(sessionId)
                  .filter((event) => event.payload.kind === "tool_call")
                  .map((event) => (event.payload as Extract<SessionEventPayload, { kind: "tool_call" }>).toolCallId),
              );
            }
          } catch (error) {
            if (entry.interruptRequested && entry.holdQueuedPromptsAfterInterrupt) {
              this.emitEvent(sessionId, { kind: "turn_interrupted" });
              this.emitStatus(sessionId, "idle");
              this.failQueuedPrompt(next, "provider cancelled", "COMMAND_CANCELLED");
              entry.activeTurnId = undefined;
              break;
            }
            if (!this.emitEvent(sessionId, { kind: "error", message: errText(error) }, next.durable)) {
              // Configuration runs before the dequeued provider-command lifecycle becomes the
              // entry's current owner. If recording this error trips history-integrity containment,
              // the remaining FIFO is rejected by failHistoryIntegrity, but this already-shifted
              // command is no longer in that FIFO. Settle its distinct lane here exactly once.
              next.sessionCommand?.lifecycle.failed(
                entry.historyIntegrityFailure ?? "session history integrity failure",
                "INVALID_COMMAND",
              );
              break;
            }
            this.emitStatus(sessionId, "idle", "agent rejected the requested session configuration");
            this.failQueuedPrompt(next, "agent rejected the requested session configuration", "INVALID_COMMAND");
            entry.activeTurnId = undefined;
            continue;
          }
        }
        entry.activeTurnConfig = normalizedConfig(next.config ?? this.store.readMeta(sessionId)?.config);
        entry.currentDurable = next.durable;
        entry.currentSessionCommand = next.sessionCommand?.lifecycle;
        entry.sessionCommandProviderStarted = false;
        try {
          await this.runPrompt(sessionId, next);
        } catch (error) {
          // The scheduled-drain guard no longer has this dequeued owner after finally clears it.
          // Settle here so an unexpected pre-provider failure cannot strand a durable receipt.
          this.failQueuedPrompt(next, `session queue drain failed: ${errText(error)}`, "INVALID_COMMAND");
          throw error;
        } finally {
          entry.currentDurable = undefined;
          entry.currentSessionCommand = undefined;
          entry.sessionCommandProviderStarted = false;
          entry.activeTurnId = undefined;
          entry.activeTurnConfig = undefined;
        }
        if (this.steerFences(entry).size) {
          await this.waitForSteeringFences(entry);
          if (this.active.get(sessionId) !== entry) break;
        }
        if (entry.governanceTripped || entry.holdQueuedPromptsAfterInterrupt) break;
      }
    } finally {
      entry.running = false;
      entry.activeTurnId = undefined;
      this.emitQueue(sessionId);
      clearInterval(refresh);
      this.lockTimers.delete(sessionId);
      this.store.releaseLock(sessionId, this.lockOwner);
      if (
        !entry.historyIntegrityFailure &&
        entry.governanceRearmPending &&
        this.active.get(sessionId) === entry
      ) {
        const pending = entry.governanceRearmPending;
        entry.governanceRearmPending = undefined;
        entry.governanceTripped = pending === "resume" ? undefined : pending;
        this.emitStatus(sessionId, "idle");
        if (!entry.governanceTripped && entry.queue.length) setImmediate(() => this.scheduleDrain(sessionId));
      }
    }
  }

  private async recordConversationForkPoint(
    sessionId: string,
    entry: ActiveSession,
    stop: StopReason,
    postTurnTree: string | null,
  ): Promise<void> {
    const meta = this.store.readMeta(sessionId);
    const turn = meta?.turnCount ?? 0;
    const agentTurnId = entry.client.agentTurnId?.();
    if (!entry.worktree || !meta || !providerSupportsConversationFork(meta.driver, meta.capabilities) ||
        turn <= 0 || !agentTurnId || stop === "cancelled" || stop === "refusal") return;
    try {
      const tree = postTurnTree ?? (await withGitExecutionContext(
        entry.context,
        () => captureWorktreeTree(entry.worktree!.path),
      ));
      const baseCommit = await worktreeHead(entry.worktree.path, {
        context: entry.context,
        dataDir: this.dataDir,
        ownerHash: this.runnerOwnerHash,
      });
      await withGitExecutionContext(
        entry.context,
        () => anchorForkRef(entry.worktree!.path, sessionId, turn, tree, this.checkpointOwnerHash(meta)),
      );
      // Record the point BEFORE the visible event. A crash between the two leaves no button
      // (safe); event-first would leave a durable button whose required point was lost.
      const eventSeq = this.store.logTailSeq(sessionId) + 1;
      this.store.patchMeta(sessionId, {
        forkPoints: {
          ...(meta.forkPoints ?? {}),
          [String(turn)]: { agentTurnId, tree, baseCommit, eventSeq },
        },
      });
      const event = this.emitEvent(sessionId, { kind: "conversation_checkpoint", turn });
      if (event && event.seq !== eventSeq) {
        const latest = this.store.readMeta(sessionId);
        this.store.patchMeta(sessionId, {
          forkPoints: {
            ...(latest?.forkPoints ?? {}),
            [String(turn)]: { agentTurnId, tree, baseCommit, eventSeq: event.seq },
          },
        });
      }
    } catch (error) {
      this.log(`conversation checkpoint failed for ${sessionId} turn ${turn}: ${errText(error)}`);
    }
  }

  private async rollbackPreparedCommandCheckpoint(
    sessionId: string,
    entry: ActiveSession,
    checkpoint: PreparedCommandCheckpoint | undefined,
  ): Promise<void> {
    if (!checkpoint) return;
    if (checkpoint.accountingApplied) {
      const current = this.store.readMeta(sessionId);
      if (current?.turnCount === checkpoint.turn && current.lastTurnBaseTree === checkpoint.tree) {
        try {
          this.store.patchMeta(sessionId, {
            turnCount: checkpoint.priorTurnCount,
            lastTurnBaseTree: checkpoint.priorLastTurnBaseTree,
          });
        } catch (error) {
          this.log(`command checkpoint accounting rollback failed for ${sessionId}: ${errText(error)}`);
        }
      }
      checkpoint.accountingApplied = false;
    }
    if (!checkpoint.anchored || !entry.worktree) return;
    try {
      await withGitExecutionContext(entry.context, () => checkpoint.priorTurnRef
        ? anchorTurnRef(entry.worktree!.path, sessionId, checkpoint.turn, checkpoint.priorTurnRef!, checkpoint.ownerHash)
        : deleteTurnRef(entry.worktree!.path, sessionId, checkpoint.turn, checkpoint.ownerHash));
      checkpoint.anchored = false;
    } catch (error) {
      this.log(`command checkpoint ref rollback failed for ${sessionId} turn ${checkpoint.turn}: ${errText(error)}`);
    }
  }

  private async runPrompt(
    sessionId: string,
    prompt: QueuedPrompt | string,
    legacyImages: PromptImage[] = [],
  ): Promise<void> {
    // Keep the narrow direct-call shape used by the governance harness while production always
    // supplies the queue entry (which carries config and durable receipt ownership).
    const queued: QueuedPrompt = typeof prompt === "string"
      ? { id: "direct", text: prompt, images: legacyImages }
      : prompt;
    if (queued.sessionCommand) {
      await this.runSessionCommand(sessionId, queued);
      return;
    }
    const entry = this.active.get(sessionId);
    if (!entry) {
      queued.durable?.failed("session is not active on this runner", "SESSION_NOT_FOUND");
      return;
    }
    const { text, images: imageInputs, slashCommand, durable, syntheticRecovery } = queued;
    let images: PromptImage[];
    try {
      const references = imageInputs.filter(isPromptImageReference);
      const resolved = references.length
        ? await (this.resolvePromptImages?.(sessionId, references) ?? Promise.reject(new Error("prompt image references are unsupported by this runner")))
        : [];
      if (resolved.length !== references.length) {
        throw new Error("prompt image resolver returned an unexpected result count");
      }
      let referenceIndex = 0;
      images = imageInputs.map((image) => isPromptImageReference(image) ? resolved[referenceIndex++]! : image);
      if (images.some((image) => !image || typeof image.data !== "string")) {
        throw new Error("prompt image resolver returned an incomplete result");
      }
    } catch (error) {
      const detail = `prompt image materialization failed: ${errText(error)}`;
      this.emitEvent(sessionId, { kind: "error", message: detail });
      this.emitStatus(sessionId, "idle");
      durable?.failed(detail, "INVALID_COMMAND");
      return;
    }
    if (this.active.get(sessionId) !== entry) {
      durable?.failed("session stopped while prompt images were materialized", "SESSION_NOT_FOUND");
      return;
    }
    // The runner (the box) is the source of truth for ALL events including the user's prompt, so it
    // lands in the store + every dashboard's timeline. The control plane no longer appends it.
    const displayText = slashCommand ? `/${slashCommand}${text ? ` ${text}` : ""}`.trim() : text;
    const userEvent = syntheticRecovery
      ? this.emitEvent(sessionId, {
          kind: "stderr",
          text: "Runner resumed orphaned background work automatically.",
        })
      : this.emitEvent(sessionId, {
          kind: "user_message",
          text: displayText,
          images: imageInputs.length ? imageInputs : undefined,
          ...(durable ? { commandId: durable.commandId } : {}),
          turnId: queued.id,
        }, durable);
    if (!userEvent) return;
    // This event is the durable no-replay boundary for an automated prompt. Force the session log
    // to disk before the command journal says `started`, so sudden power loss cannot retain the
    // receipt while losing the correlated turn marker.
    if (durable) {
      this.store.flush(sessionId);
      durable.started(userEvent?.seq);
    }
    entry.status = "running";
    this.emitStatus(sessionId, "running");
    // Snapshot the worktree BEFORE the agent can write — the last_turn diff base. Awaited (a
    // fire-and-forget would race the agent's first edits into the snapshot) but best-effort:
    // a failure stores null (overwriting any stale prior sha so multi-turn changes are never
    // mislabeled as one turn) and must never fail the prompt turn. A mid-turn diff read against
    // this snapshot shows "changes so far this turn" — intended.
    if (entry.worktree) {
      let snap: string | null = null;
      try {
        snap = await withGitExecutionContext(entry.context, () => captureWorktreeTree(entry.worktree!.path));
      } catch (err) {
        this.log(`turn snapshot failed for ${sessionId}: ${errText(err)} — last_turn diff unavailable for this turn`);
        // Surface it on the timeline too — otherwise the user only learns when the Last-turn
        // tab errors, with no hint why.
        this.emitEvent(sessionId, {
          kind: "stderr",
          text: `turn snapshot failed (${errText(err)}) — the Last turn diff won't be available for this turn`,
        });
      }
      // Deleted/replaced mid-snapshot? Anchoring now would mint an ORPHAN ref after delete()
      // already ran its ref cleanup, pinning objects forever — bail before touching anything.
      if (this.active.get(sessionId) !== entry || !this.store.has(sessionId)) {
        durable?.uncertain("session disappeared after the durable user event was recorded");
        return;
      }
      const checkpointMeta = this.store.readMeta(sessionId);
      if (!checkpointMeta) {
        durable?.uncertain("session disappeared after the durable user event was recorded");
        return;
      }
      const checkpointOwnerHash = this.checkpointOwnerHash(checkpointMeta);
      const turn = (checkpointMeta.turnCount ?? 0) + 1;
      this.store.patchMeta(sessionId, { lastTurnBaseTree: snap, turnCount: turn });
      // Per-turn CHECKPOINT (T3-style rewind target): anchor the pre-turn tree under a real
      // ref (gc can't prune it, unlike the dangling lastTurnBaseTree) and record it on the
      // timeline so the UI can offer "rewind files to before this turn". Best-effort: a
      // failed anchor only loses the rewind target for this turn.
      if (snap) {
        try {
          await withGitExecutionContext(entry.context, () => anchorTurnRef(
            entry.worktree!.path, sessionId, turn, snap!, checkpointOwnerHash,
          ));
          this.emitEvent(sessionId, { kind: "checkpoint", turn, tree: snap });
        } catch (err) {
          this.log(`checkpoint anchor failed for ${sessionId} turn ${turn}: ${errText(err)}`);
        }
      }
    }
    // The snapshot awaited above is the first suspension point between the active-entry lookup
    // and the agent spawn — stop()/delete()/restart or a cancel may have landed meanwhile. A
    // disposed driver would happily spawn a fresh process, running a full invisible turn that
    // mutates the worktree after the user saw the session stop.
    if (this.active.get(sessionId) !== entry) {
      durable?.uncertain("session stopped after the durable user event was recorded");
      return;
    }
    if (entry.historyIntegrityFailure) return;
    if (entry.cancelRequested) {
      entry.cancelRequested = false;
      this.emitStatus(sessionId, "stopped");
      durable?.failed("command was cancelled before provider submission", "COMMAND_CANCELLED");
      return;
    }
    if (entry.interruptRequested) {
      this.emitEvent(sessionId, { kind: "turn_interrupted" });
      this.emitStatus(sessionId, "idle");
      durable?.failed("command was interrupted before provider submission", "COMMAND_CANCELLED");
      return;
    }
    if (syntheticRecovery) {
      const current = this.store.readMeta(sessionId);
      if (!current?.orphanedWork || current.status === "stopped" ||
          current.orphanedWork.recoveryAttemptedAt) {
        this.emitStatus(sessionId, current?.status === "stopped" ? "stopped" : "idle");
        return;
      }
      const attempted = this.store.patchMeta(sessionId, {
        orphanedWork: { ...current.orphanedWork, recoveryAttemptedAt: Date.now() },
      });
      if (!attempted?.orphanedWork?.recoveryAttemptedAt) {
        this.emitStatus(sessionId, "idle");
        return;
      }
      // At-most-once safety boundary: this is the last synchronous point before handing the
      // billable synthetic turn to the provider. Pre-launch failures remain safely retryable.
      this.store.flush(sessionId);
    }
    try {
      let stop: Awaited<ReturnType<Driver["prompt"]>>;
      stop = await entry.client.prompt(text, images, slashCommand);
      if (entry.historyIntegrityFailure) return;
      this.captureAgentSessionId(sessionId, entry.client); // codex threadId becomes known after turn 1
      if (syntheticRecovery && stop !== "cancelled" && stop !== "refusal") {
        this.finishOrphanRecovery(sessionId);
      }
      if (!this.active.has(sessionId)) {
        durable?.uncertain("session stopped while provider execution was in progress");
        return;
      }
      const postTurnTree = await this.captureDiff(sessionId);
      if (entry.historyIntegrityFailure) return;
      if (!this.active.has(sessionId)) {
        durable?.uncertain("session stopped while command completion was being recorded");
        return;
      }
      await this.recordConversationForkPoint(sessionId, entry, stop, postTurnTree);
      if (entry.historyIntegrityFailure) return;
      const interrupted = !entry.governanceTripped && entry.interruptRequested && stop === "cancelled";
      if (interrupted) {
        this.emitEvent(sessionId, { kind: "turn_interrupted" });
        this.emitStatus(sessionId, "idle");
      } else if (entry.governanceTripped) {
        this.emitStatus(sessionId, "idle");
      } else if (stop === "cancelled") {
        // Legacy cancel_session behavior is deliberately unchanged for old control planes.
        this.emitStatus(sessionId, "stopped");
      } else {
        // The provider completed before the interrupt took effect. Do not fabricate Interrupted
        // or strand the existing FIFO: this was a normal completed turn, not a cancelled one.
        if (entry.interruptRequested) {
          entry.interruptRequested = false;
          this.setInterruptQueueHold(sessionId, entry, false);
        }
        this.emitStatus(sessionId, "idle");
      }
      if (interrupted || stop === "cancelled" || stop === "refusal") {
        durable?.failed(`provider ${stop}`, "COMMAND_CANCELLED");
      } else {
        durable?.completed();
      }
    } catch (err) {
      if (entry.historyIntegrityFailure) return;
      if (!this.active.has(sessionId)) {
        durable?.uncertain("session stopped while provider execution was in progress");
        return;
      }
      if (entry.governanceTripped) {
        this.emitStatus(sessionId, "idle");
        durable?.completed();
        return;
      }
      this.emitEvent(sessionId, { kind: "error", message: `prompt failed: ${errText(err)}` }, durable);
      if (entry.historyIntegrityFailure) return;
      this.emitStatus(sessionId, "failed", errText(err));
      durable?.failed(`prompt failed: ${errText(err)}`);
    }
  }

  /** Execute one manual provider command on a distinct lane. Every suspension (configuration and
   * worktree preparation) occurs before the final live-authority check. From that check through
   * durable event flush, `started`, and the synchronous provider call there is no await. */
  private async runSessionCommand(sessionId: string, queued: QueuedPrompt): Promise<void> {
    const command = queued.sessionCommand;
    if (!command) return;
    const lifecycle = command.lifecycle;
    const entry = this.active.get(sessionId);
    if (!entry) {
      lifecycle.failed("session is not active on this runner", "SESSION_NOT_FOUND");
      return;
    }

    let checkpoint: PreparedCommandCheckpoint | undefined;
    if (entry.worktree) {
      let snapshot: string | null = null;
      try {
        snapshot = await withGitExecutionContext(
          entry.context,
          () => captureWorktreeTree(entry.worktree!.path),
        );
      } catch (error) {
        this.log(`turn snapshot failed for ${sessionId}: ${errText(error)} â€” last_turn diff unavailable for this command`);
        this.emitEvent(sessionId, {
          kind: "stderr",
          text: `turn snapshot failed (${errText(error)}) â€” the Last turn diff won't be available for this command`,
        });
      }
      if (this.active.get(sessionId) !== entry || !this.store.has(sessionId)) {
        lifecycle.failed("session stopped while the command turn was prepared", "SESSION_NOT_FOUND");
        return;
      }
      const priorMeta = this.store.readMeta(sessionId);
      if (!priorMeta) {
        lifecycle.failed("session stopped while the command turn was prepared", "SESSION_NOT_FOUND");
        return;
      }
      const turn = (priorMeta.turnCount ?? 0) + 1;
      let priorTurnRef: string | null;
      try {
        priorTurnRef = await withGitExecutionContext(
          entry.context,
          () => readTurnRef(entry.worktree!.path, sessionId, turn, this.checkpointOwnerHash(priorMeta)),
        );
      } catch (error) {
        const detail = `checkpoint refs could not be verified: ${errText(error)}`;
        this.log(`command checkpoint preparation failed for ${sessionId} turn ${turn}: ${errText(error)}`);
        if (!this.emitEvent(sessionId, { kind: "error", message: detail })) return;
        this.emitStatus(sessionId, "idle");
        lifecycle.failed(detail, "INVALID_COMMAND");
        return;
      }
      checkpoint = {
        turn,
        tree: snapshot,
        priorTurnCount: priorMeta.turnCount ?? 0,
        priorLastTurnBaseTree: priorMeta.lastTurnBaseTree,
        priorTurnRef,
        ownerHash: this.checkpointOwnerHash(priorMeta),
        anchored: false,
        accountingApplied: false,
      };
      if (snapshot) {
        try {
          await withGitExecutionContext(
            entry.context,
            () => anchorTurnRef(entry.worktree!.path, sessionId, turn, snapshot!, this.checkpointOwnerHash(priorMeta)),
          );
          checkpoint.anchored = true;
        } catch (error) {
          this.log(`checkpoint anchor failed for ${sessionId} turn ${turn}: ${errText(error)}`);
          try {
            checkpoint.anchored = await withGitExecutionContext(
              entry.context,
              () => readTurnRef(entry.worktree!.path, sessionId, turn, checkpoint?.ownerHash),
            ) === snapshot;
          } catch (error) {
            // git transport failures are soft reads, so a thrown read here is a durable namespace
            // divergence. Contain it to this command instead of rejecting the remaining FIFO and
            // failing the otherwise healthy provider session.
            const detail = `checkpoint refs could not be verified: ${errText(error)}`;
            this.log(`command checkpoint verification failed for ${sessionId} turn ${turn}: ${errText(error)}`);
            if (!this.emitEvent(sessionId, { kind: "error", message: detail })) return;
            this.emitStatus(sessionId, "idle");
            lifecycle.failed(detail, "INVALID_COMMAND");
            return;
          }
        }
      }
    }

    if (this.active.get(sessionId) !== entry || !this.store.has(sessionId)) {
      await this.rollbackPreparedCommandCheckpoint(sessionId, entry, checkpoint);
      lifecycle.failed("session stopped while the command turn was prepared", "SESSION_NOT_FOUND");
      return;
    }
    if (entry.historyIntegrityFailure) {
      await this.rollbackPreparedCommandCheckpoint(sessionId, entry, checkpoint);
      lifecycle.failed(entry.historyIntegrityFailure, "INVALID_COMMAND");
      return;
    }
    if (entry.cancelRequested) {
      entry.cancelRequested = false;
      await this.rollbackPreparedCommandCheckpoint(sessionId, entry, checkpoint);
      lifecycle.failed("command was cancelled before provider submission", "COMMAND_CANCELLED");
      this.emitStatus(sessionId, "stopped");
      return;
    }
    if (entry.interruptRequested) {
      this.emitEvent(sessionId, { kind: "turn_interrupted" });
      await this.rollbackPreparedCommandCheckpoint(sessionId, entry, checkpoint);
      lifecycle.failed("command was interrupted before provider submission", "COMMAND_CANCELLED");
      this.emitStatus(sessionId, "idle");
      return;
    }

    const authorized = this.sessionCommandAuthority.resolve({
      sessionId,
      providerCommandId: command.providerCommandId,
      catalogRevision: command.catalogRevision,
      expectedExecutionMode: command.expectedExecutionMode,
    });
    if (!authorized.ok) {
      await this.rollbackPreparedCommandCheckpoint(sessionId, entry, checkpoint);
      lifecycle.failed(sessionCommandAuthorizationError(authorized.code), authorized.code);
      return;
    }
    if (!entry.client.prepareCommand || !entry.client.invokeCommand) {
      await this.rollbackPreparedCommandCheckpoint(sessionId, entry, checkpoint);
      lifecycle.failed("the active provider transport does not support command invocation", "COMMAND_MODE_UNSUPPORTED");
      return;
    }

    let prepared: ReturnType<NonNullable<Driver["prepareCommand"]>>;
    try {
      prepared = entry.client.prepareCommand({
        commandName: authorized.commandName,
        argumentText: queued.text,
        executionMode: authorized.executionMode,
      });
    } catch (error) {
      await this.rollbackPreparedCommandCheckpoint(sessionId, entry, checkpoint);
      lifecycle.failed(`provider command preparation failed: ${errText(error)}`, "COMMAND_MODE_UNSUPPORTED");
      return;
    }

    // No suspension is permitted from this boundary until invokeCommand has returned its promise.
    const displayText = `/${authorized.commandName}${queued.text ? ` ${queued.text}` : ""}`;
    const userEvent = this.emitEvent(sessionId, {
      kind: "user_message",
      text: displayText,
      turnId: queued.id,
      commandInvocation: {
        invocationId: command.invocationId,
        submissionId: command.submissionId,
        providerCommandId: command.providerCommandId,
        catalogRevision: command.catalogRevision,
        commandName: authorized.commandName,
        executionMode: authorized.executionMode,
      },
    });
    if (!userEvent) {
      await this.rollbackPreparedCommandCheckpoint(sessionId, entry, checkpoint);
      lifecycle.failed("the durable command event could not be recorded", "INVALID_COMMAND");
      return;
    }
    if (checkpoint) {
      try {
        // Set before the write: patchMeta can surface a post-rename fsync error after durable bytes
        // changed, and rollback must inspect/restore that ambiguous outcome too.
        checkpoint.accountingApplied = true;
        this.store.patchMeta(sessionId, {
          lastTurnBaseTree: checkpoint.tree,
          turnCount: checkpoint.turn,
        });
      } catch (error) {
        await this.rollbackPreparedCommandCheckpoint(sessionId, entry, checkpoint);
        lifecycle.failed(`command checkpoint accounting failed: ${errText(error)}`, "INVALID_COMMAND");
        return;
      }
    }
    if (checkpoint?.anchored && checkpoint.tree) {
      if (!this.emitEvent(sessionId, { kind: "checkpoint", turn: checkpoint.turn, tree: checkpoint.tree })) {
        await this.rollbackPreparedCommandCheckpoint(sessionId, entry, checkpoint);
        lifecycle.failed(
          entry.historyIntegrityFailure ?? "the durable command checkpoint could not be recorded",
          "INVALID_COMMAND",
        );
        return;
      }
    }
    try {
      this.store.flush(sessionId);
      lifecycle.started(userEvent.seq);
      entry.sessionCommandProviderStarted = true;
      entry.status = "running";
      this.emitStatus(sessionId, "running");
    } catch (error) {
      await this.rollbackPreparedCommandCheckpoint(sessionId, entry, checkpoint);
      lifecycle.failed(`session command could not cross the durable submission boundary: ${errText(error)}`, "INVALID_COMMAND");
      return;
    }

    let providerPromise: Promise<StopReason>;
    try {
      providerPromise = entry.client.invokeCommand(prepared);
    } catch (error) {
      await this.rollbackPreparedCommandCheckpoint(sessionId, entry, checkpoint);
      this.emitEvent(sessionId, { kind: "error", message: `session command failed: ${errText(error)}` });
      this.emitStatus(sessionId, "failed", errText(error));
      lifecycle.failed(`session command failed before provider submission: ${errText(error)}`, "INVALID_COMMAND");
      return;
    }

    try {
      const stop = await providerPromise;
      if (entry.historyIntegrityFailure) return;
      this.captureAgentSessionId(sessionId, entry.client);
      if (this.active.get(sessionId) !== entry) {
        lifecycle.uncertain("session stopped while provider command execution was in progress");
        return;
      }
      const postTurnTree = await this.captureDiff(sessionId);
      if (entry.historyIntegrityFailure) return;
      if (this.active.get(sessionId) !== entry) {
        lifecycle.uncertain("session stopped while command completion was being recorded");
        return;
      }
      await this.recordConversationForkPoint(sessionId, entry, stop, postTurnTree);
      if (entry.historyIntegrityFailure) return;
      if (this.active.get(sessionId) !== entry) {
        lifecycle.uncertain("session stopped while command fork point was being recorded");
        return;
      }

      const interrupted = !entry.governanceTripped && entry.interruptRequested && stop === "cancelled";
      if (interrupted) {
        this.emitEvent(sessionId, { kind: "turn_interrupted" });
        this.emitStatus(sessionId, "idle");
      } else if (entry.governanceTripped) {
        this.emitStatus(sessionId, "idle");
      } else if (stop === "cancelled") {
        this.emitStatus(sessionId, "stopped");
      } else {
        if (entry.interruptRequested) {
          entry.interruptRequested = false;
          this.setInterruptQueueHold(sessionId, entry, false);
        }
        this.emitStatus(sessionId, "idle");
      }
      if (interrupted || stop === "cancelled" || stop === "refusal") {
        lifecycle.failed(`provider ${stop}`, "COMMAND_CANCELLED");
      } else {
        lifecycle.completed();
      }
    } catch (error) {
      if (entry.historyIntegrityFailure) return;
      if (this.active.get(sessionId) !== entry) {
        lifecycle.uncertain("session stopped while provider command execution was in progress");
        return;
      }
      // Governance cancellation commonly rejects the provider promise. Match ordinary prompt
      // semantics: the policy turn is parked successfully at idle, not reported as a transport
      // failure whose retry could duplicate already-observed provider work.
      if (entry.governanceTripped) {
        this.emitStatus(sessionId, "idle");
        lifecycle.completed();
        return;
      }
      this.emitEvent(sessionId, { kind: "error", message: `session command failed: ${errText(error)}` });
      this.emitStatus(sessionId, "failed", errText(error));
      lifecycle.uncertain(`provider command delivery or completion is uncertain: ${errText(error)}`);
    }
  }

  /** Fork a provider conversation without changing the source session. */
  async forkConversation(
    sourceSessionId: string,
    targetSessionId: string,
    turn: number,
    title: string,
    deferHistory = false,
  ): Promise<{ ok: boolean; error?: string; snapshot?: ReturnType<typeof metaToSnapshot>; events?: ReturnType<SessionStore["readEvents"]> }> {
    const source = this.store.readMeta(sourceSessionId);
    if (!source) return { ok: false, error: "source session not found on this box" };
    const supportsFork = providerSupportsConversationFork(source.driver, source.capabilities);
    if (!supportsFork) return { ok: false, error: "this provider session does not support conversation fork" };
    if (!source.worktreePath) return { ok: false, error: "conversation fork requires a worktree session" };
    if (this.hasCheckpointRefCleanupForSession(targetSessionId)) {
      try {
        await this.awaitCheckpointRefCleanupForSession(targetSessionId);
      } catch (error) {
        return { ok: false, error: `target checkpoint cleanup did not settle: ${errText(error)}` };
      }
    }
    if (this.store.has(targetSessionId) || this.forkingTargets.has(targetSessionId)) {
      return { ok: false, error: "target session already exists or is being created" };
    }
    const point = source.forkPoints?.[String(turn)];
    if (!point) return { ok: false, error: `turn ${turn} has no provider fork checkpoint` };
    if (source.driver === "claude-code" && turn !== source.turnCount) {
      return { ok: false, error: "Claude CLI can only fork its current transcript at the matching turn checkpoint" };
    }
    const live = this.active.get(sourceSessionId);
    if (live && (live.running || live.queue.length)) return { ok: false, error: "a turn is running or queued — wait before forking" };
    if (this.loggingOut.has(sourceSessionId)) return { ok: false, error: "agent sign-out is in progress" };
    if (this.deleting.has(sourceSessionId)) return { ok: false, error: "session deletion is in progress" };
    if (this.forking.has(sourceSessionId)) return { ok: false, error: "a conversation fork is already in progress" };
    this.forking.add(sourceSessionId);
    this.forkingTargets.add(targetSessionId);
    let seatbeltForkAdmission = false;
    if (this.executionIsolation.mode === "seatbelt" && !this.admitted.has(sourceSessionId)) {
      if (!(await this.acquireAdmission(sourceSessionId))) {
        this.forking.delete(sourceSessionId);
        this.forkingTargets.delete(targetSessionId);
        return { ok: false, error: "provider transcript store is busy on this macOS runner" };
      }
      seatbeltForkAdmission = true;
      if (!this.store.has(sourceSessionId)) {
        this.releaseAdmission(sourceSessionId);
        this.forking.delete(sourceSessionId);
        this.forkingTargets.delete(targetSessionId);
        return { ok: false, error: "source session was removed while waiting for provider isolation" };
      }
    }
    if (!this.store.acquireLock(sourceSessionId, this.lockOwner)) {
      if (seatbeltForkAdmission) this.releaseAdmission(sourceSessionId);
      this.forking.delete(sourceSessionId);
      this.forkingTargets.delete(targetSessionId);
      return { ok: false, error: "another runner is driving the source session" };
    }
    const forkLockRefresh = setInterval(
      () => this.store.refreshLock(sourceSessionId, this.lockOwner),
      LOCK_REFRESH_MS,
    );

    let temporary: Driver | null = null;
    let client: Driver | undefined;
    let worktree: WorktreeHandle | null = null;
    let forkedThreadId: string | null = null;
    let providerStateJournaled = false;
    try {
      if (this.executionIsolation.mode === "bwrap" &&
          source.providerStateVersion !== (source.context.kind === "wsl" ? 3 : 2)) {
        await this.ensureProviderStateLayout(source);
      }
      client = live?.client;
      if (!client) {
        if (!source.agentSessionId) return { ok: false, error: "source session has no provider conversation id" };
        const priorCapabilities = source.capabilities;
        const priorSessionSlashCommands = source.sessionSlashCommands;
        const launchPreparation = this.prepareLaunch?.(source);
        if (launchPreparation) await launchPreparation;
        if (sameSlashCommandCatalog(priorSessionSlashCommands, source.sessionSlashCommands)) {
          source.sessionSlashCommands = priorSessionSlashCommands;
        }
        const updated = this.store.patchMeta(sourceSessionId, {
          args: source.args,
          config: source.config,
          capabilities: source.capabilities,
          sessionSlashCommands: source.sessionSlashCommands,
          sessionSlashCommandProvenance: source.sessionSlashCommandProvenance,
        });
        if (updated && (priorCapabilities !== source.capabilities ||
            priorSessionSlashCommands !== source.sessionSlashCommands)) {
          this.send({ type: "session_runtime_updated", snapshot: this.snapshot(updated) });
        }
        const isolation = await this.resolveLaunchIsolation(source, source.worktreePath);
        this.providerHomeLeases?.acquire({
          driver: source.driver,
          command: source.command,
          context: source.context,
          env: source.env,
          isolation,
        });
        temporary = this.createDriver(
          source.driver,
          {
            command: source.command,
            args: source.args,
            cwd: source.worktreePath,
            env: source.env,
            config: source.config,
            context: source.context,
            capabilities: source.capabilities,
            resumeId: source.agentSessionId,
            isolation,
          },
          { onEvent: () => {}, onStderr: (text) => this.log(`provider fork: ${text}`), onExit: () => {} },
        );
        await temporary.initialize();
        await temporary.newSession(source.worktreePath);
        client = temporary;
      }
      if (!client.forkSession) return { ok: false, error: "this driver build does not support provider forks" };
      // Preserve the source worktree's commit base as well as its exact post-turn files. The new
      // thread gets the target cwd at fork time so it never resumes against the source worktree.
      const worktreeOptions = { context: source.context, dataDir: this.dataDir, ownerHash: this.runnerOwnerHash };
      const baseRef = point.baseCommit ?? (await worktreeHead(source.worktreePath, worktreeOptions));
      worktree = await createWorktreeFromTree(source.repoPath, targetSessionId, point.tree, baseRef, worktreeOptions);
      // Fork refs are anchored before the target session row exists, so their immutable ownership
      // proof must land immediately after worktree creation and before anchorForkRef.
      const targetCheckpointOwner = this.runnerOwnerHash;
      const ownership = this.checkpointRefOwnership.claim({
        sessionId: targetSessionId,
        repoPath: source.repoPath,
        context: source.context,
        ...(targetCheckpointOwner ? { ownerHash: targetCheckpointOwner } : {}),
      });
      await this.reclaimStaleCheckpointRefOwnership(ownership);
      if (this.executionIsolation.mode === "bwrap") {
        this.providerStateCleanupJournal.add({
          sessionId: targetSessionId,
          driver: source.driver,
          context: source.context,
        });
        providerStateJournaled = true;
      }
      forkedThreadId = await client.forkSession(point.agentTurnId, worktree.path);
      await this.verifyIsolationForkState(
        this.executionIsolation,
        source.context,
        source.driver,
        this.stateDir,
        sourceSessionId,
        forkedThreadId,
        {},
        this.runnerOwnerHash,
      );
      await this.cloneIsolationState(
        this.executionIsolation,
        source.context,
        source.driver,
        this.stateDir,
        sourceSessionId,
        targetSessionId,
        {},
        this.runnerOwnerHash,
      );
      await withGitExecutionContext(source.context, () => anchorForkRef(
        worktree!.path, targetSessionId, turn, point.tree, targetCheckpointOwner,
      ));
      const now = Date.now();
      const target: SessionMeta = {
        ...source,
        sessionId: targetSessionId,
        title,
        worktreePath: worktree.path,
        agentSessionId: forkedThreadId,
        status: "idle",
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        preview: null,
        pendingApproval: null,
        sessionSlashCommands: undefined,
        sessionSlashCommandProvenance: undefined,
        env: {},
        adopted: false,
        providerStateVersion: source.context.kind === "wsl" ? 3 : 2,
        ...(targetCheckpointOwner ? { checkpointRefVersion: 2 as const } : {}),
        lastTurnBaseTree: point.tree,
        turnCount: turn,
        // Inherited events are re-sequenced in the child, so the parent's eventSeq is not valid
        // here. The loop below records the child's own checkpoint coordinate.
        forkPoints: { [String(turn)]: { ...point, eventSeq: undefined } },
        seq: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.store.create(target);
      const sourceEvents = this.store.readEvents(sourceSessionId);
      const cutoffSeq = point.eventSeq ?? sourceEvents.find(
        (event) => event.payload.kind === "conversation_checkpoint" && event.payload.turn === turn,
      )?.seq;
      if (!cutoffSeq) throw new Error(`turn ${turn} has no durable conversation checkpoint event`);
      const inherited = sourceEvents.filter((event) => {
        if (event.seq > cutoffSeq || event.payload.kind === "token_usage") return false;
        if (event.payload.kind === "checkpoint" || event.payload.kind === "checkpoint_restored") return false;
        return event.payload.kind !== "conversation_checkpoint" || event.payload.turn === turn;
      });
      let targetCheckpointSeq: number | undefined;
      for (const event of inherited) {
        const appended = this.store.appendEvent(targetSessionId, event.payload, event.ts);
        if (event.payload.kind === "conversation_checkpoint" && event.payload.turn === turn) {
          targetCheckpointSeq = appended?.seq;
        }
      }
      if (!targetCheckpointSeq) throw new Error(`turn ${turn} checkpoint could not be copied into the fork`);
      this.store.patchMeta(targetSessionId, {
        forkPoints: { [String(turn)]: { ...point, eventSeq: targetCheckpointSeq } },
      });
      this.store.appendEvent(targetSessionId, { kind: "conversation_forked", sourceSessionId, turn }, now);
      this.store.flush(targetSessionId);
      if (providerStateJournaled) this.providerStateCleanupJournal.remove(targetSessionId);
      const snapshot = this.snapshot(this.store.readMeta(targetSessionId)!);
      return {
        ok: true,
        snapshot,
        ...(deferHistory ? {} : { events: this.store.readEvents(targetSessionId) }),
      };
    } catch (err) {
      if (forkedThreadId && client?.archiveSession) {
        try {
          await client.archiveSession(forkedThreadId);
        } catch (cleanupErr) {
          this.log(`failed to archive orphaned provider fork ${forkedThreadId}: ${errText(cleanupErr)}`);
        }
      }
      if (worktree) {
        const cleanup = {
          sessionId: targetSessionId,
          repoPath: source.repoPath,
          worktreePath: worktree.path,
          context: source.context,
          ...(this.runnerOwnerHash ? { checkpointOwnerHash: this.runnerOwnerHash } : {}),
        };
        try {
          this.cleanupJournal.add(cleanup);
        } catch (cleanupErr) {
          this.log(`failed to journal orphaned worktree cleanup for ${targetSessionId}: ${errText(cleanupErr)}`);
        }
        await this.reapWorktree(cleanup, true);
      }
      if (this.store.has(targetSessionId)) this.store.remove(targetSessionId);
      await this.cleanupProviderState(targetSessionId, source.driver, source.context, providerStateJournaled);
      return { ok: false, error: errText(err) };
    } finally {
      temporary?.dispose();
      clearInterval(forkLockRefresh);
      this.store.releaseLock(sourceSessionId, this.lockOwner);
      this.forking.delete(sourceSessionId);
      this.forkingTargets.delete(targetSessionId);
      if (seatbeltForkAdmission) this.releaseAdmissionIfInactive(sourceSessionId);
    }
  }

  cancel(sessionId: string): void {
    // Cancellation of an initial start is a generation boundary just like deletion, but it is not
    // a permanent tombstone: a later explicit Restart may allocate a fresh generation.
    const cancelledPreparation = this.invalidateLaunchGeneration(sessionId);
    const cancelledWait = this.cancelAdmissionWait(sessionId);
    const cancelledAdmittedStart = this.admitted.has(sessionId) && !this.active.has(sessionId);
    this.releaseAdmissionIfInactive(sessionId);
    const entry = this.active.get(sessionId);
    if (!entry) {
      this.rejectPreLaunchQueue(sessionId, "session cancelled before runner admission");
      if (cancelledPreparation || cancelledWait || cancelledAdmittedStart) {
        this.emitStatus(
          sessionId,
          "stopped",
          cancelledWait
            ? "Cancelled while waiting for a runner process slot"
            : "Cancelled while preparing the session launch",
        );
      }
      return;
    }
    this.cancelApprovalTelemetry(sessionId);
    // A legacy lifecycle cancellation is stronger than a pending turn-only interruption. Preserve
    // the old auto-drain/stopped contract rather than letting the v71 hold leak into old callers.
    entry.interruptRequested = false;
    this.setInterruptQueueHold(sessionId, entry, false);
    // Driver-level cancel only reaches a live agent process; during the pre-prompt turn snapshot
    // there is none yet, so also flag the entry — runPrompt honors it before spawning.
    entry.cancelRequested = true;
    entry.client.cancel();
  }

  /** Interrupt only the active turn. The session remains promptable and its not-yet-started FIFO
   * is held until a later explicit prompt resumes it. The disposition lets correlated callers
   * distinguish an applied interrupt from a raced, stale, or otherwise inapplicable request. */
  interruptTurn(sessionId: string, turnId?: string): InterruptTurnResultReason {
    const entry = this.active.get(sessionId);
    // Launch/admission cancellation is a lifecycle operation and can discard the initial prompt.
    // The control plane rejects queued/starting sessions; a skewed or raced direct message is a
    // safe no-op until an in-process turn actually exists.
    if (!entry) return "session_not_found";
    if (!entry.running || entry.cancelRequested || entry.governanceTripped) return "turn_not_running";
    if (entry.interruptRequested) return "already_requested";
    // A delayed request for the previous turn must never cancel a newly dequeued prompt. Missing
    // coordinates preserve the pre-marker v71 behavior for rolling control-plane upgrades.
    if (turnId !== undefined && entry.activeTurnId !== turnId) return "stale_turn";
    this.cancelApprovalTelemetry(sessionId);
    entry.interruptRequested = true;
    this.setInterruptQueueHold(sessionId, entry, true);
    try {
      entry.client.cancel();
    } catch {
      entry.interruptRequested = false;
      this.setInterruptQueueHold(sessionId, entry, false);
      return "cancel_failed";
    }
    return "applied";
  }

  /** Apply the next absolute thresholds after a user continues. Held queued prompts resume only
   * after this message, so a mid-turn trip cannot leak work past the approval boundary. */
  rearmGovernance(
    sessionId: string,
    config: { costBudgetUsd?: number | null; maxToolCalls?: number | null },
    holdFor?: "cost_budget" | "max_tool_calls",
  ): void {
    const meta = this.store.readMeta(sessionId);
    if (!meta) return;
    const costBudgetUsd = config.costBudgetUsd;
    const maxToolCalls = config.maxToolCalls;
    if (costBudgetUsd === undefined && maxToolCalls === undefined) return;
    if (costBudgetUsd !== undefined && costBudgetUsd !== null && (!Number.isFinite(costBudgetUsd) || costBudgetUsd <= 0)) return;
    if (maxToolCalls !== undefined && maxToolCalls !== null && (!Number.isInteger(maxToolCalls) || maxToolCalls <= 0)) return;
    const merged: SessionConfig = { ...meta.config };
    if (costBudgetUsd === null) delete merged.costBudgetUsd;
    else if (costBudgetUsd !== undefined) merged.costBudgetUsd = costBudgetUsd;
    if (maxToolCalls === null) delete merged.maxToolCalls;
    else if (maxToolCalls !== undefined) merged.maxToolCalls = maxToolCalls;
    this.store.patchMeta(sessionId, { config: merged });
    const entry = this.active.get(sessionId);
    if (!entry) return;
    if (!holdFor) {
      entry.interruptRequested = false;
      this.setInterruptQueueHold(sessionId, entry, false);
    }
    for (const queued of entry.queue) {
      const queuedConfig: SessionConfig = { ...(queued.config ?? meta.config) };
      if (costBudgetUsd === null) delete queuedConfig.costBudgetUsd;
      else if (costBudgetUsd !== undefined) queuedConfig.costBudgetUsd = costBudgetUsd;
      if (maxToolCalls === null) delete queuedConfig.maxToolCalls;
      else if (maxToolCalls !== undefined) queuedConfig.maxToolCalls = maxToolCalls;
      queued.config = queuedConfig;
    }
    if (maxToolCalls != null && !entry.toolCallIds) {
      entry.toolCallIds = new Set(
        this.store.readEvents(sessionId)
          .filter((event) => event.payload.kind === "tool_call")
          .map((event) => (event.payload as Extract<SessionEventPayload, { kind: "tool_call" }>).toolCallId),
      );
    }
    if (entry.running) {
      if (entry.governanceTripped) entry.governanceRearmPending = holdFor ?? "resume";
      else if (holdFor) entry.governanceTripped = holdFor;
      return;
    }
    entry.governanceTripped = holdFor;
    this.emitStatus(sessionId, "idle");
    if (!holdFor && entry.queue.length) this.scheduleDrain(sessionId);
  }

  stop(sessionId: string): void {
    this.revokeSessionCommandAuthority(sessionId);
    this.discardRecovery(sessionId);
    this.cancelApprovalTelemetry(sessionId);
    this.clearSteeringState(sessionId, "session stopped before steering settled");
    const entry = this.active.get(sessionId);
    if (!entry) {
      this.rejectPreLaunchQueue(sessionId, "session stopped before runner admission");
      this.cancelAdmissionWait(sessionId);
      // Not in-process but may exist in the store — record the stop there too.
      if (this.store.has(sessionId)) {
        this.store.patchMeta(sessionId, {
          status: "stopped",
          backgroundWorkState: undefined,
          pendingBackgroundTaskIds: [],
          orphanedWork: undefined,
        });
        this.emitStatus(sessionId, "stopped");
      }
      return;
    }
    this.store.patchMeta(sessionId, {
      status: "stopped",
      backgroundWorkState: undefined,
      pendingBackgroundTaskIds: [],
      orphanedWork: undefined,
    });
    this.active.delete(sessionId);
    this.rejectQueued(entry.queue, "session stopped before queued command started");
    entry.queue.length = 0;
    this.emitQueue(sessionId); // clear any queued prompts from the dashboard
    if (entry.client.close) {
      let promise: Promise<void>;
      promise = this.closeAndDispose(sessionId, entry.client, true).finally(() => {
        if (this.closing.get(sessionId)?.promise === promise) this.closing.delete(sessionId);
        this.releaseAdmission(sessionId);
        this.clearLock(sessionId);
      });
      this.closing.set(sessionId, { client: entry.client, promise });
    } else {
      entry.client.dispose({ forceImmediate: true });
      this.releaseAdmission(sessionId);
      this.clearLock(sessionId);
    }
    // Worktree is intentionally kept so its diff remains reviewable.
    this.emitStatus(sessionId, "stopped");
  }

  /** Permanently delete a session from the box store (the source of truth) so it cannot be
   * resurrected by a later register. Disposes the live process if any. */
  async delete(sessionId: string): Promise<void> {
    this.revokeSessionCommandAuthority(sessionId);
    if (this.deleting.has(sessionId)) return;
    if ((this.deleted.has(sessionId) || this.store.isDeleted(sessionId)) &&
        !this.store.has(sessionId)) return;
    this.deleting.add(sessionId);
    let deletionFenced = false;
    try {
      // This prefix is deliberately synchronous: any already-running start/open continuation sees
      // cancellation before delete() reaches its first await. All throwing filesystem operations
      // are inside this try so a failed durable mutation cannot permanently pin `deleting`.
      this.retainDeletedTombstone(sessionId);
      this.store.markDeleted(sessionId);
      deletionFenced = true;
      const meta = this.store.readMeta(sessionId);
      const providerStateMigration = this.providerStateMigrations.get(sessionId);
      // Install every cleanup record before discarding the live entry or the only durable row. If
      // either journal write fails, a retry still has the complete session state to converge from.
      let worktreeCleanup: WorktreeCleanupRecord | undefined;
      if (meta?.worktreePath) {
        const checkpointOwnerHash = this.checkpointOwnerHash(meta);
        worktreeCleanup = {
          sessionId,
          repoPath: meta.repoPath,
          worktreePath: meta.worktreePath,
          context: meta.context,
          ...(checkpointOwnerHash ? { checkpointOwnerHash } : {}),
        };
        this.cleanupJournal.add(worktreeCleanup);
      }
      if (meta) {
        this.providerStateCleanupJournal.add({ sessionId, driver: meta.driver, context: meta.context });
      }

      this.beginLaunchGeneration(sessionId);
      this.rejectPreLaunchQueue(sessionId, "session deleted before runner admission");
      // Deletion is terminal, not a replacement launch. Stale continuations may perform only
      // idempotent lock/admission release; the deletion journal exclusively owns destructive
      // worktree/provider cleanup.
      this.latestLaunchGenerations.delete(sessionId);
      this.cancelAdmissionWait(sessionId);
      this.releaseAdmissionIfInactive(sessionId);
      this.discardRecovery(sessionId);
      this.cancelApprovalTelemetry(sessionId);
      const closing = this.closing.get(sessionId);
      const entry = this.active.get(sessionId);
      this.clearSteeringState(sessionId, "session was deleted before steering settled");
      if (entry) {
        this.active.delete(sessionId);
        this.rejectQueued(entry.queue, "session was deleted before queued command started");
        entry.queue.length = 0;
      }
      this.clearLock(sessionId);
      // The row disappears before the first await below. This makes every lookup/open fail closed
      // while slow provider, cloud, provider-state, and worktree cleanup continues asynchronously.
      this.store.remove(sessionId);

      if (closing) await closing.promise;
      if (entry) {
        await this.closeAndDispose(sessionId, entry.client, true);
        this.releaseAdmission(sessionId);
      }
      this.cancelAdmissionWait(sessionId);
      // Checkpoint refs live in the SHARED repo odb (not the worktree dir) — drop them or the
      // anchored trees for a deleted session pin objects forever. Best-effort: the repo may be
      // gone entirely.
      if (meta?.executionTarget?.adapter === "cloud" && meta.cloudAdapterHandoffKey && this.cloudTargets) {
        try {
          await this.cloudTargets.cancel(meta.executionTarget, meta.cloudAdapterHandoffKey);
        } catch (error) {
          this.log(`cloud handoff cancellation failed while deleting ${sessionId}: ${errText(error)}`);
        }
      }
      this.cloudHandoffOwners.delete(sessionId);
      if (!meta?.worktreePath && meta?.repoPath) {
        await withGitExecutionContext(meta.context, () => deleteTurnRefs(
          meta.repoPath, sessionId, this.checkpointOwnerHash(meta),
        )).catch(() => {});
        // A prior worktree generation may have used this same session id in another repository or
        // execution context. The current in-place row has no cleanup journal, so independently
        // drive every durable exact tuple now; failures retain their proof for startup retry.
        let ownerships: CheckpointRefOwnershipRecord[] = [];
        try {
          ownerships = this.checkpointRefOwnership.listSession(sessionId);
        } catch (error) {
          this.log(`checkpoint ref ownership enumeration failed for ${boundedSessionIdForLog(sessionId)}: ${errText(error)}`);
        }
        const results = await Promise.allSettled(
          ownerships.map((ownership) => this.reclaimCheckpointRefOwnership(ownership)),
        );
        if (results.some((result) => result.status === "rejected")) {
          this.log(`checkpoint ref ownership cleanup for ${boundedSessionIdForLog(sessionId)} needs retry`);
        }
      }
      // The durable cleanup journal was installed in the synchronous prefix above. Keep it in
      // place while an earlier migration settles, then perform the final cleanup exactly once.
      if (providerStateMigration) await providerStateMigration.catch(() => {});
      if (meta) {
        await this.cleanupProviderState(sessionId, meta.driver, meta.context, true);
      }
      if (worktreeCleanup) {
        await this.reapWorktree(worktreeCleanup);
      }
      this.log(`deleted session ${sessionId} from the box store`);
    } finally {
      this.deleting.delete(sessionId);
      if (!deletionFenced && !this.store.isDeleted(sessionId)) {
        this.expireDeletedTombstone(sessionId);
      }
      if (!this.deleted.has(sessionId)) this.launchGenerations.delete(sessionId);
    }
  }

  private async closeAndDispose(sessionId: string, client: Driver, forceImmediate = false): Promise<void> {
    if (!client.close) {
      client.dispose({ forceImmediate });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("provider close timed out")), PROVIDER_CLOSE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      this.log(`session ${sessionId} provider close incomplete; disposing process`);
    } finally {
      if (timer) clearTimeout(timer);
      client.dispose({ forceImmediate });
    }
  }

  private async reapWorktree(record: WorktreeCleanupRecord, cleanupCurrentGeneration = false): Promise<void> {
    let checkpointRefsCleaned = true;
    let worktreeRemoved = true;
    const cleanupOwnership: CheckpointRefOwnershipClaim = {
      sessionId: record.sessionId,
      repoPath: record.repoPath,
      context: record.context,
      ...(record.checkpointOwnerHash ? { ownerHash: record.checkpointOwnerHash } : {}),
    };
    const cleanupOwnershipKey = checkpointRefOwnershipKey(cleanupOwnership);
    // A failed fork can publish its temporary row before inherited-history copying fails. Its
    // catch path still owns that exact generation and explicitly marks it disposable; ordinary
    // journal replay must preserve any independently recreated current session.
    let currentOwnershipKey: string | null;
    try {
      currentOwnershipKey = cleanupCurrentGeneration
        ? null
        : this.currentCheckpointOwnershipKey(record.sessionId);
    } catch {
      // A forward-version or malformed live row is not permission to reclaim its refs or
      // worktree. Startup runs this method fire-and-forget, so contain the validation failure and
      // retain the durable cleanup record for a compatible build or operator repair.
      this.log(`worktree cleanup for ${boundedSessionIdForLog(record.sessionId)} needs retry after checkpoint ownership validation`);
      return;
    }
    if (currentOwnershipKey === cleanupOwnershipKey) {
      // A replacement generation reused this exact durable tuple. The older cleanup record is
      // superseded; touching either its refs or worktree would destroy the live replacement.
      this.removeWorktreeCleanupRecord(record.sessionId);
      return;
    }
    const ownerships = new Map<string, CheckpointRefOwnershipClaim>([
      [cleanupOwnershipKey, cleanupOwnership],
    ]);
    if (!currentOwnershipKey) {
      try {
        for (const ownership of this.checkpointRefOwnership.listSession(record.sessionId)) {
          ownerships.set(checkpointRefOwnershipKey(ownership), ownership);
        }
      } catch {
        checkpointRefsCleaned = false;
      }
    }
    for (const ownership of ownerships.values()) {
      try {
        await this.deleteCheckpointRefsSerialized(ownership);
        const durable = this.checkpointRefOwnership.get(ownership);
        if (durable) this.checkpointRefOwnership.remove(durable);
      } catch {
        // Every exact tuple remains independent: one inaccessible old repository cannot prevent
        // other owned tuples or the cleanup-record tuple from converging.
        checkpointRefsCleaned = false;
      }
    }
    try {
      const ownedWslPath = record.context.kind === "wsl" && this.runnerOwnerHash &&
        record.worktreePath.includes(`/runner-instances/${this.runnerOwnerHash}/worktrees/`);
      await removeWorktree(
        record.repoPath,
        {
          path: record.worktreePath,
          branch: ownedWslPath
            ? `agent/${this.runnerOwnerHash.slice(0, 16)}/${record.sessionId}`
            : `agent/${record.sessionId}`,
        },
        {
          context: record.context,
          dataDir: this.dataDir,
          ownerHash: this.runnerOwnerHash,
          legacyWslRoot: record.context.kind === "wsl" && !ownedWslPath,
        },
      );
    } catch {
      worktreeRemoved = false;
    }
    if (checkpointRefsCleaned && worktreeRemoved) {
      this.removeWorktreeCleanupRecord(record.sessionId);
      return;
    }
    // Keep cleanup diagnostics bounded and free of repository paths, ref values, and provider
    // errors. The durable journal retains the complete operator-independent retry coordinates.
    const failedPhases = checkpointRefsCleaned
      ? "worktree removal"
      : worktreeRemoved ? "checkpoint ref cleanup" : "checkpoint ref cleanup and worktree removal";
    this.log(`worktree cleanup for ${boundedSessionIdForLog(record.sessionId)} needs retry after ${failedPhases}`);
  }

  private removeWorktreeCleanupRecord(sessionId: string): boolean {
    try {
      this.cleanupJournal.remove(sessionId);
      return true;
    } catch {
      // Journal persistence can fail after the external resources were successfully reclaimed.
      // Keep the record for an idempotent retry and contain the failure: startup invokes the
      // reaper fire-and-forget, so rejecting here would otherwise become an unhandled rejection.
      this.log(`worktree cleanup for ${boundedSessionIdForLog(sessionId)} needs retry after cleanup journal update`);
      return false;
    }
  }

  /**
   * Rewind a worktree session's FILES to the checkpoint taken before `turn`. The conversation
   * is not rewound (v1) — the next prompt continues the same thread against the restored tree.
   * Refused while a turn is running or queued: restoring under an active agent would corrupt
   * its in-flight edits.
   */
  /** Fence a session for an upcoming rewind BEFORE it waits in the worktree-mutation queue —
   * prompts arriving during the wait must be rejected too, or their edits would be silently
   * overwritten when the queued rewind finally runs. Returns false if already fenced. */
  fenceRewind(sessionId: string): boolean {
    if (this.rewinding.has(sessionId) || this.loggingOut.has(sessionId) || this.deleting.has(sessionId)) return false;
    this.rewinding.add(sessionId);
    return true;
  }

  /** Release a fence taken by fenceRewind when the rewind will NOT run (expiry). */
  releaseRewindFence(sessionId: string): void {
    this.rewinding.delete(sessionId);
  }

  async rewind(sessionId: string, turn: number, alreadyFenced = false): Promise<{ ok: boolean; error?: string }> {
    if (this.loggingOut.has(sessionId)) return { ok: false, error: "agent sign-out is in progress" };
    if (this.deleting.has(sessionId)) return { ok: false, error: "session deletion is in progress" };
    // Mark FIRST (synchronously): prompt() consults the set, and the shared lock is reentrant
    // for this process so it can't fence a same-runner prompt out of the restore window.
    if (!alreadyFenced && !this.fenceRewind(sessionId)) {
      return { ok: false, error: "a rewind is already in progress" };
    }
    try {
      const entry = this.active.get(sessionId);
      if (entry && (entry.running || entry.queue.length > 0)) {
        return { ok: false, error: "a turn is running or queued — stop or wait before rewinding" };
      }
      const meta = this.store.readMeta(sessionId);
      if (!meta) return { ok: false, error: "session not found on this box" };
      const root = meta.worktreePath;
      if (!root) return { ok: false, error: "rewind requires a worktree session (in-place sessions have no checkpoints)" };
      if (!this.store.acquireLock(sessionId, this.lockOwner)) {
        return { ok: false, error: "another runner is driving this session" };
      }
      try {
        const tree = await withGitExecutionContext(meta.context, () => readTurnRef(
          root, sessionId, turn, this.checkpointOwnerHash(meta),
        ));
        if (!tree) return { ok: false, error: `no checkpoint exists for turn ${turn}` };
        await withGitExecutionContext(meta.context, () => restoreWorktreeToTree(root, tree));
        this.emitEvent(sessionId, { kind: "checkpoint_restored", turn });
        // A TERMINAL session's status must survive the rewind — emitting idle would let the
        // next snapshot hydration resurrect a stopped/failed session as promptable.
        const status = this.store.readMeta(sessionId)?.status ?? "idle";
        this.emitStatus(sessionId, status === "running" || status === "starting" ? "idle" : status);
        return { ok: true };
      } finally {
        this.store.releaseLock(sessionId, this.lockOwner);
      }
    } catch (err) {
      return { ok: false, error: errText(err) };
    } finally {
      this.rewinding.delete(sessionId);
    }
  }

  resolvePermission(sessionId: string, requestId: string, optionId: string | null): void {
    const entry = this.active.get(sessionId);
    const delivered = entry ? entry.client.resolvePermission(requestId, optionId) : false;
    if (delivered) {
      const started = this.approvalStarted.get(`${sessionId}:${requestId}`);
      this.approvalStarted.delete(`${sessionId}:${requestId}`);
      const meta = this.store.readMeta(sessionId);
      if (meta && started != null) {
        const optionKind = meta.pendingApproval?.options.find((option) => option.optionId === optionId)?.kind;
        this.emitTelemetry(meta, {
          metric: "approval",
          outcome:
            optionId == null
              ? "cancelled"
              : optionKind != null
                ? optionKind.startsWith("allow") ? "allowed" : "denied"
                : optionId === "allow" ? "allowed" : optionId === "deny" ? "denied" : "observed",
          durationMs: Date.now() - started,
        });
      }
      // Record the resolution in the box log (the runner owns the timeline now) and clear the card
      // via accrueMeta, so a hydrating dashboard sees both the decision and an empty approval slot.
      this.emitEvent(sessionId, { kind: "permission_resolved", requestId, optionId });
      return;
    }
    this.approvalStarted.delete(`${sessionId}:${requestId}`);
    if (!this.store.has(sessionId)) return;
    // The ask is gone (process exited / turn settled / runner restarted between card render and
    // click). Emitting permission_resolved here would phantom-flip the session to "running" with
    // no turn in flight — instead tell the user and re-emit the store's REAL status, which also
    // clears the stale card everywhere through the existing settled-status path.
    this.emitEvent(sessionId, {
      kind: "stderr",
      text: `approval ${requestId} could not be delivered — the agent is no longer waiting on it`,
    });
    const status = this.store.readMeta(sessionId)?.status ?? "idle";
    this.emitStatus(sessionId, status);
  }

  answerQuestion(sessionId: string, requestId: string, answers: Record<string, string | string[]>): void {
    const entry = this.active.get(sessionId);
    const delivered = entry?.client.answerQuestion ? entry.client.answerQuestion(requestId, answers) : false;
    if (delivered) {
      const started = this.approvalStarted.get(`${sessionId}:${requestId}`);
      this.approvalStarted.delete(`${sessionId}:${requestId}`);
      const meta = this.store.readMeta(sessionId);
      if (meta && started != null) {
        this.emitTelemetry(meta, {
          metric: "approval",
          outcome: Object.keys(answers).length ? "allowed" : "cancelled",
          durationMs: Date.now() - started,
        });
      }
      this.emitEvent(sessionId, { kind: "question_resolved", requestId, answered: Object.keys(answers).length > 0 });
      return;
    }
    this.approvalStarted.delete(`${sessionId}:${requestId}`);
    if (!this.store.has(sessionId)) return;
    // Same dead-target contract as resolvePermission: never fake a resolution for a process
    // that is no longer waiting — surface it and re-emit the store's real status.
    this.emitEvent(sessionId, {
      kind: "stderr",
      text: `answer for ${requestId} could not be delivered — the agent is no longer waiting on it`,
    });
    const status = this.store.readMeta(sessionId)?.status ?? "idle";
    this.emitStatus(sessionId, status);
  }

  /** Stop refreshing and release a session's lock (idempotent). */
  private clearLock(sessionId: string): void {
    const timer = this.lockTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.lockTimers.delete(sessionId);
    }
    this.store.releaseLock(sessionId, this.lockOwner);
  }

  /** Persist the agent-native resumable id once it's known (claude immediately, codex after turn 1). */
  private captureAgentSessionId(sessionId: string, client: Driver): void {
    const aid = client.agentSessionId();
    if (aid && this.store.readMeta(sessionId)?.agentSessionId !== aid) {
      this.store.patchMeta(sessionId, { agentSessionId: aid });
    }
  }

  private async captureDiff(sessionId: string): Promise<string | null> {
    const entry = this.active.get(sessionId);
    if (!entry?.worktree) return null;
    // Per-turn DELTA (turn-start snapshot vs the worktree now), not the cumulative
    // HEAD-vs-worktree diff: appending the full uncommitted set after EVERY turn grew the
    // event log quadratically with a long-lived working set (a 5k-line set re-logged 5k
    // lines per turn, forever). Full cumulative diffs stay available on demand via the Git
    // panel's git_action. Falls back to cumulative when the snapshot is missing/pruned.
    const base = this.store.readMeta(sessionId)?.lastTurnBaseTree;
    const worktreeOptions = { context: entry.context, dataDir: this.dataDir, ownerHash: this.runnerOwnerHash };
    const captured = base ? await captureTurnDiff(entry.worktree.path, base, worktreeOptions) : null;
    const diff = captured?.diff ?? (await worktreeDiff(entry.worktree.path, worktreeOptions));
    if (diff.trim()) this.emitEvent(sessionId, { kind: "file_edit", path: "worktree", diff });
    return captured?.tree ?? null;
  }

  private onExit(sessionId: string, code: number | null): void {
    const entry = this.active.get(sessionId);
    if (!entry) return;
    this.releaseAdmission(sessionId);
    this.clearLock(sessionId);
    const meta = this.store.readMeta(sessionId);
    this.cancelApprovalTelemetry(sessionId);
    if (meta && entry.status !== "stopped") {
      this.emitTelemetry(meta, {
        metric: "crash",
        outcome: "failure",
        reason: meta.driver === "codex-app-server" ? "app_server_exit" : "agent_exit",
      });
    }
    const recoverableAppServer =
      meta?.driver === "codex-app-server" && !!meta.agentSessionId && entry.status !== "stopped";
    if (entry.historyIntegrityFailure) {
      const queued = entry.queue.splice(0);
      this.active.delete(sessionId);
      this.rejectQueued(queued, entry.historyIntegrityFailure);
      return; // never append an exit event or overwrite the latched integrity failure
    }
    if (entry.status !== "stopped") {
      this.restoreUnsubmittedPromotions(sessionId, entry);
      // Keep the entry installed until this append completes: if it is the first integrity
      // failure, failHistoryIntegrity must still own/cancel this session and its durable queue.
      if (!this.emitEvent(sessionId, { kind: "stderr", text: `agent process exited (code ${code})` })) {
        this.active.delete(sessionId);
        return;
      }
      const queued = entry.queue.splice(0);
      // Queued prompts died with the entry — clear the dashboards' queue overlay, or they
      // keep offering cancel buttons for prompts that can never run (cancel would no-op).
      const hadQueueProjection = queued.length > 0 || this.reservedPromotions(entry).size > 0;
      this.active.delete(sessionId);
      if (hadQueueProjection) this.emitQueue(sessionId);
      if (recoverableAppServer) {
        // A crashed turn may already have reached turn/start, so never replay it. The entries
        // still in queue are provably unsubmitted and can safely continue after a fresh process
        // resumes the same durable thread.
        this.emitStatus(sessionId, "idle", "Codex app-server exited; the next prompt will resume the thread");
        if (queued.length) {
          this.stabilizeRecoveryQueue(sessionId, queued);
          this.recoveryQueues.set(sessionId, queued);
          setImmediate(() => void this.recoverQueuedAppServer(sessionId));
        }
      } else if (code && code !== 0) {
        this.rejectQueued(queued, "agent exited before queued command started");
        this.emitStatus(sessionId, "failed", `agent exited ${code}`);
      } else {
        this.rejectQueued(queued, "agent exited before queued command started");
      }
    } else {
      this.active.delete(sessionId);
    }
  }

  /** Driver callbacks are third-party process boundaries and must never surface an exception into
   * the driver's event loop. Event-history failures are contained by emitEvent; this guard also
   * prevents an unrelated exit-cleanup failure from becoming a process-wide uncaught exception. */
  private onDriverExit(sessionId: string, code: number | null): void {
    this.revokeSessionCommandAuthority(sessionId);
    try {
      this.onExit(sessionId, code);
    } catch (error) {
      this.log(`agent exit cleanup failed for ${sessionId}: ${errText(error)}`);
      const entry = this.active.get(sessionId);
      if (!entry) return;
      const detail = `agent exit cleanup failed: ${errText(error)}`;
      const queued = entry.queue.splice(0);
      this.rejectQueued(queued, detail);
      // runPrompt exclusively owns the dequeued lifecycle. Removing the active entry makes that
      // path terminalize it as uncertain after provider unwind; failing it here would double-settle.
      this.active.delete(sessionId);
      try {
        this.store.patchMeta(sessionId, { status: "failed", pendingApproval: null });
        this.send({ type: "session_status", sessionId, status: "failed", detail });
      } catch (statusError) {
        this.log(`agent exit failure status could not be persisted for ${sessionId}: ${errText(statusError)}`);
      }
    }
  }

  private async recoverQueuedAppServer(sessionId: string): Promise<void> {
    if (this.recoveryLaunching.has(sessionId)) return;
    const queued = this.recoveryQueues.get(sessionId);
    if (!queued) return;
    const alreadyActive = this.active.get(sessionId);
    if (alreadyActive) {
      // A non-recovery entrypoint won the race. Preserve the known-unsubmitted prompts ahead of
      // newer work instead of leaving a stale recovery map that would intercept every prompt.
      for (const prompt of queued) this.insertQueuedPrompt(sessionId, alreadyActive.queue, prompt);
      this.recoveryQueues.delete(sessionId);
      this.emitQueue(sessionId);
      this.scheduleDrain(sessionId);
      return;
    }
    this.recoveryLaunching.add(sessionId);
    try {
      const meta = this.store.readMeta(sessionId);
      const resumeId = meta?.driver === "codex-app-server" ? meta.agentSessionId : null;
      if (!meta || !resumeId) {
        this.rejectQueued(queued, "queued prompts could not recover because the Codex thread id is unavailable");
        this.recoveryQueues.delete(sessionId);
        this.emitEvent(sessionId, { kind: "error", message: "queued prompts could not recover because the Codex thread id is unavailable" });
        return;
      }
      if (!this.store.acquireLock(sessionId, this.lockOwner)) {
        this.emitEvent(sessionId, { kind: "error", message: `${queued.length} queued prompt(s) are still held because another runner owns the session; send another prompt to retry` });
        this.emitStatus(sessionId, "idle");
        return;
      }
      const launchGeneration = this.beginLaunchGeneration(sessionId);
      if (!(await this.acquireAdmission(sessionId))) {
        const superseded = this.launchWasSuperseded(sessionId, launchGeneration);
        this.finishLaunchGeneration(sessionId, launchGeneration);
        if (!superseded) this.store.releaseLock(sessionId, this.lockOwner);
        return;
      }
      if (!this.launchIsCurrent(sessionId, launchGeneration)) {
        const superseded = this.launchWasSuperseded(sessionId, launchGeneration);
        this.finishLaunchGeneration(sessionId, launchGeneration);
        if (!superseded) this.store.releaseLock(sessionId, this.lockOwner);
        return;
      }
      let ok: boolean;
      let stillOwnsLaunch = false;
      let superseded = false;
      try {
        ok = await this.launch(meta, resumeId, launchGeneration);
        stillOwnsLaunch = this.launchIsCurrent(sessionId, launchGeneration);
        superseded = this.launchWasSuperseded(sessionId, launchGeneration);
      } finally {
        this.finishLaunchGeneration(sessionId, launchGeneration);
      }
      // A superseding launch can be awaiting preparation before it installs an active entry. It
      // already owns the session's admission and same-owner lock, so this stale continuation must
      // not release either or publish a recovery error.
      if (!stillOwnsLaunch) {
        if (!superseded) this.store.releaseLock(sessionId, this.lockOwner);
        return;
      }
      if (!ok) {
        this.releaseAdmissionIfInactive(sessionId);
        if (!this.active.has(sessionId)) this.store.releaseLock(sessionId, this.lockOwner);
        if (this.recoveryQueues.get(sessionId) !== queued || this.store.readMeta(sessionId)?.status === "stopped") return;
        this.emitEvent(sessionId, { kind: "error", message: `${queued.length} queued prompt(s) remain held; send another prompt after the resume error is resolved` });
        return;
      }
      // launch() awaits runner-owned preparation before constructing and installing its entry.
      // Capture the successfully launched identity now so later queue/state invalidation can only
      // dispose the process created by this recovery generation, never a replacement.
      const recoveryEntry = this.active.get(sessionId);
      if (this.recoveryQueues.get(sessionId) !== queued || this.store.readMeta(sessionId)?.status === "stopped") {
        if (this.recoveryQueues.get(sessionId) === queued) {
          this.rejectQueued(queued, "session stopped before the recovered command queue was restored");
          this.recoveryQueues.delete(sessionId);
        }
        if (recoveryEntry && this.active.get(sessionId) === recoveryEntry) {
          recoveryEntry.client.dispose({ forceImmediate: true });
          this.active.delete(sessionId);
          this.releaseAdmission(sessionId);
          this.store.releaseLock(sessionId, this.lockOwner);
        }
        return;
      }
      const entry = this.active.get(sessionId);
      if (!entry) {
        this.rejectQueued(queued, "session recovery completed without an active agent process");
        this.recoveryQueues.delete(sessionId);
        this.store.releaseLock(sessionId, this.lockOwner);
        return;
      }
      for (const prompt of queued) this.insertQueuedPrompt(sessionId, entry.queue, prompt);
      this.recoveryQueues.delete(sessionId);
      this.emitQueue(sessionId);
      this.scheduleDrain(sessionId);
    } finally {
      this.recoveryLaunching.delete(sessionId);
    }
  }

  private discardRecovery(sessionId: string): void {
    const queued = this.recoveryQueues.get(sessionId);
    if (queued) this.rejectQueued(queued, "session lifecycle discarded the recovered command queue");
    this.recoveryQueues.delete(sessionId);
    this.recoveryLaunching.delete(sessionId);
  }

  shutdownAll(): void {
    this.shuttingDown = true;
    this.sessionCommandAuthority.clearAll();
    this.launchGenerations.clear();
    this.preLaunchAdmissionGenerations.clear();
    clearInterval(this.providerStateReconcileTimer);
    clearInterval(this.historyMaintenanceTimer);
    if (this.historyMaintenanceKickoff) clearTimeout(this.historyMaintenanceKickoff);
    this.historyMaintenanceKickoff = null;
    for (const entry of this.active.values()) {
      entry.client.dispose();
      this.clearLock(entry.sessionId);
    }
    this.active.clear();
    for (const { client } of this.closing.values()) client.dispose();
    this.closing.clear();
    this.deleting.clear();
    this.recoveryQueues.clear();
    this.preLaunchQueues.clear();
    this.recoveryLaunching.clear();
    this.orphanRecoveryLaunching.clear();
    this.orphanDiscoveryLaunching.clear();
    if (this.orphanRecoveryScanTimer) clearTimeout(this.orphanRecoveryScanTimer);
    this.orphanRecoveryScanTimer = null;
    for (const timer of this.orphanRecoveryTimers.values()) clearTimeout(timer);
    this.orphanRecoveryTimers.clear();
    this.approvalStarted.clear();
    if (this.admissionRetryTimer) clearTimeout(this.admissionRetryTimer);
    this.admissionRetryTimer = null;
    for (const waiter of this.admissionQueue.splice(0)) waiter.resolve(false);
    for (const waiter of this.worktreePreparationQueue.splice(0)) waiter.resolve(false);
    if (this.worktreePreparationRetryTimer) clearTimeout(this.worktreePreparationRetryTimer);
    this.worktreePreparationRetryTimer = null;
    // Active git subprocesses cannot be synchronously cancelled. Retain their box-wide leases and
    // generation ownership until each start continuation reaches its finally block; process death
    // remains the crash-recovery boundary for leases that never settle.
    this.admitted.clear();
    this.boxAdmission.releaseAll();
    // Debounced meta writes (seq/preview/usage) must land before the process exits — a lost
    // seq flush would only self-heal on the next append, and usage totals would be dropped.
    this.store.flushAll();
  }

  /** Release mutable provider HOME ownership only after every spawned provider/TUI process tree
   * has been reaped. shutdownAll() merely initiates that asynchronous drain. */
  releaseProviderHomeLeasesAfterShutdown(processTreesReaped: boolean): boolean {
    if (!this.shuttingDown) {
      throw new Error("provider-home leases may only be released after shutdown begins");
    }
    if (!processTreesReaped) return false;
    this.providerHomeLeases?.releaseAll();
    return true;
  }

  private emitStatus(
    sessionId: string,
    status: SessionStatus,
    detail?: string,
    worktreePath?: string | null,
  ): void {
    const entry = this.active.get(sessionId);
    if (entry) entry.status = status;
    // When a turn settles (idle/stopped/failed/etc.) any pending approval is moot — clear it so the
    // box snapshot doesn't carry a stale card. The runner stays "running" through an approval, and
    // "input_required" IS the parked-on-a-card state — wiping the card while keeping that status
    // would strand a live ask (e.g. the dead-target corrective re-emit racing a parked session in
    // a shared box store). Mirrors the CP rule: LEAVING input_required clears the card.
    const settled = status !== "running" && status !== "starting" && status !== "input_required";
    this.store.patchMeta(sessionId, settled ? { status, pendingApproval: null } : { status });
    this.send({ type: "session_status", sessionId, status, detail, worktreePath });
  }

  /** Contain authoritative history failures to one session. History itself remains strict: this
   * latch only prevents provider work and callback exceptions after the store has rejected a
   * complete append. Recovery stays explicit through restart+valid history, reprocess, or delete. */
  private failHistoryIntegrity(
    sessionId: string,
    error: unknown,
    durable?: DurableCommandLifecycle,
  ): void {
    const entry = this.active.get(sessionId);
    const detail = entry?.historyIntegrityFailure ??
      `session history integrity failure: ${errText(error)}`;
    if (!entry) {
      durable?.failed(detail, "INVALID_COMMAND");
      this.store.patchMeta(sessionId, { status: "failed", pendingApproval: null });
      this.send({ type: "session_status", sessionId, status: "failed", detail });
      return;
    }
    if (entry.historyIntegrityFailure) {
      durable?.failed(detail, "INVALID_COMMAND");
      return;
    }
    entry.historyIntegrityFailure = detail;
    entry.cancelRequested = true;
    this.cancelSteeringOperations(sessionId);
    entry.governanceRearmPending = undefined;
    const queued = entry.queue.splice(0);
    if (queued.length) {
      this.rejectQueued(queued, detail);
      this.emitQueue(sessionId);
    }
    (durable ?? entry.currentDurable)?.failed(detail, "INVALID_COMMAND");
    if (entry.sessionCommandProviderStarted) {
      entry.currentSessionCommand?.uncertain(
        `${detail}; provider command delivery or completion is uncertain`,
      );
    }
    this.emitStatus(sessionId, "failed", detail);
    try {
      entry.client.cancel();
    } catch (cancelError) {
      this.log(`history integrity cancel failed for ${sessionId}: ${errText(cancelError)}`);
    }
  }

  private emitEvent(
    sessionId: string,
    payload: SessionEventPayload,
    durable?: DurableCommandLifecycle,
  ): ReturnType<SessionStore["appendEvent"]> | undefined {
    const entry = this.active.get(sessionId);
    if (entry?.historyIntegrityFailure) {
      durable?.failed(entry.historyIntegrityFailure, "INVALID_COMMAND");
      return undefined;
    }
    try {
      // Persist to the box store (the source of truth) and stamp the runner-owned seq/ts onto the
      // live message so every dashboard's cache agrees. No lifecycle caller may observe a rejected
      // append: a complete-history failure is latched and contained to this session here.
      const stored = this.store.appendEvent(sessionId, payload);
      if (!stored) throw new Error("session metadata disappeared before history append");
      try {
        this.accrueMeta(sessionId, payload);
        this.send({ type: "session_event", sessionId, payload, seq: stored.seq, ts: stored.ts });
      } catch (relayError) {
        // The authoritative append already committed. Do not misclassify a best-effort metadata or
        // transport failure as corrupt history, and never throw it through a driver callback; the
        // next snapshot/page hydration recovers the durable event.
        this.log(`persisted event relay failed for ${sessionId}: ${errText(relayError)}`);
      }
      return stored;
    } catch (error) {
      this.failHistoryIntegrity(sessionId, error, durable);
      return undefined;
    }
  }

  private onDriverBackgroundWork(sessionId: string, update: DriverBackgroundWorkUpdate): void {
    const current = this.store.readMeta(sessionId);
    if (!current || current.driver !== "claude-code") return;
    const observedTaskIds = update.observedTaskIds ?? [];
    const recoveredBackgroundTaskIds = withoutRecoveredBackgroundTaskIds(
      current.recoveredBackgroundTaskIds,
      observedTaskIds,
    );
    const recovered = new Set(recoveredBackgroundTaskIds);
    const eligiblePendingTaskIds = update.pendingTaskIds.filter((id) => !recovered.has(id));
    const durableRecoveredTaskIds = current.orphanedWork?.recoveryAttemptedAt && update.state !== null
      ? mergeRecoveredBackgroundTaskIds(
          recoveredBackgroundTaskIds,
          current.orphanedWork.pendingTaskIds.filter((id) =>
            !eligiblePendingTaskIds.includes(id) &&
            !(current.orphanedWork?.recoveryObservedTaskIds ?? []).includes(id)),
        )
      : recoveredBackgroundTaskIds;
    let updated: SessionMeta | null;
    if (update.state !== null && eligiblePendingTaskIds.length === 0) {
      // Artifact-only evidence cannot revive a task whose unattended recovery was already handled.
      // A real provider stream event appears in observedTaskIds and removes its tombstone above.
      updated = this.store.patchMeta(sessionId, {
        backgroundWorkState: "resumed",
        pendingBackgroundTaskIds: [],
        recoveredBackgroundTaskIds: durableRecoveredTaskIds,
        orphanedWork: undefined,
      });
    } else if (update.state === "running") {
      updated = this.store.patchMeta(sessionId, {
        backgroundWorkState: "running",
        pendingBackgroundTaskIds: eligiblePendingTaskIds,
        recoveredBackgroundTaskIds: durableRecoveredTaskIds,
        ...(current.orphanedWork && observedTaskIds.length > 0
          ? {
              orphanedWork: {
                ...current.orphanedWork,
                recoveryObservedTaskIds: [...new Set([
                  ...(current.orphanedWork.recoveryObservedTaskIds ?? []),
                  ...observedTaskIds,
                ])],
              },
            }
          : {}),
      });
    } else if (update.state === "orphaned") {
      const previousOrphan = current.orphanedWork;
      const sameRecovery = previousOrphan &&
        previousOrphan.pendingTaskIds.some((id) => eligiblePendingTaskIds.includes(id));
      updated = this.store.patchMeta(sessionId, {
        backgroundWorkState: "orphaned",
        pendingBackgroundTaskIds: eligiblePendingTaskIds,
        recoveredBackgroundTaskIds: durableRecoveredTaskIds,
        orphanedWork: {
          pendingTaskIds: eligiblePendingTaskIds,
          markedAt: Date.now(),
          reason: update.reason ?? "process_exit",
          ...(sameRecovery && current.orphanedWork?.recoveryAttemptedAt
            ? { recoveryAttemptedAt: current.orphanedWork.recoveryAttemptedAt }
            : {}),
          ...((sameRecovery ? current.orphanedWork?.recoveryObservedTaskIds : observedTaskIds)?.length
            ? {
                recoveryObservedTaskIds: [...new Set([
                  ...((sameRecovery ? current.orphanedWork?.recoveryObservedTaskIds : []) ?? []),
                  ...observedTaskIds,
                ])],
              }
            : {}),
        },
      });
    } else {
      const recovered = current.orphanedWork?.recoveryAttemptedAt
        ? mergeRecoveredBackgroundTaskIds(
            durableRecoveredTaskIds,
            current.orphanedWork.pendingTaskIds.filter((id) =>
              !(current.orphanedWork?.recoveryObservedTaskIds ?? []).includes(id)),
          )
        : durableRecoveredTaskIds;
      updated = this.store.patchMeta(sessionId, {
        backgroundWorkState: current.orphanedWork ? "resumed" : undefined,
        pendingBackgroundTaskIds: [],
        recoveredBackgroundTaskIds: recovered,
        orphanedWork: undefined,
      });
    }
    if (updated) this.send({ type: "session_runtime_updated", snapshot: this.snapshot(updated) });
    if (updated?.orphanedWork && update.state === "orphaned" && automaticClaudeRecoveryAllowed(updated)) {
      this.scheduleOrphanRecovery(sessionId);
    }
  }

  private finishOrphanRecovery(sessionId: string): void {
    const current = this.store.readMeta(sessionId);
    if (!current?.orphanedWork) return;
    const observed = new Set(current.orphanedWork.recoveryObservedTaskIds ?? []);
    const pending = (current.pendingBackgroundTaskIds ?? []).filter((id) => observed.has(id));
    const recovered = current.orphanedWork.pendingTaskIds.filter((id) => !observed.has(id));
    const hasPending = pending.length > 0;
    // A persistent transport that is still running now owns the remaining work. A one-shot
    // transport exits after every turn, so its attempted orphan remains visible but is never
    // submitted automatically a second time.
    if (hasPending && current.backgroundWorkState !== "running") return;
    const updated = this.store.patchMeta(sessionId, hasPending
      ? { pendingBackgroundTaskIds: pending, orphanedWork: undefined }
      : {
          backgroundWorkState: "resumed",
          pendingBackgroundTaskIds: [],
          recoveredBackgroundTaskIds: mergeRecoveredBackgroundTaskIds(
            current.recoveredBackgroundTaskIds,
            recovered,
          ),
          orphanedWork: undefined,
        });
    if (updated) this.send({ type: "session_runtime_updated", snapshot: this.snapshot(updated) });
  }

  /** Discover durable work and, when authorized, schedule its idempotent recovery trigger. */
  recoverOrphanedWork(sessionId: string, automatic = true): void {
    const meta = this.store.readMeta(sessionId);
    if (!meta) return;
    const discovered = this.discoverOrphanedClaudeWork(meta);
    const allowed = automatic && automaticClaudeRecoveryAllowed(discovered);
    if (allowed && discovered.orphanedWork && !discovered.orphanedWork.recoveryAttemptedAt) {
      this.scheduleOrphanRecovery(sessionId);
    }
    else this.scheduleContextOrphanDiscovery(discovered, allowed);
  }

  private discoverOrphanedClaudeWork(meta: SessionMeta): SessionMeta {
    if (meta.driver !== "claude-code" || meta.context.kind !== "native" || !meta.agentSessionId ||
        meta.status === "stopped" || meta.orphanedWork || this.active.has(meta.sessionId)) return meta;
    const cwd = meta.worktreePath ?? meta.repoPath;
    const recovered = new Set(meta.recoveredBackgroundTaskIds ?? []);
    const tasks = this.discoverClaudeTasks(cwd, meta.agentSessionId, {
      tempRoot: meta.env.TMPDIR ?? meta.env.TEMP ?? meta.env.TMP,
      claudeHome: meta.env.HOME ? join(meta.env.HOME, ".claude") : undefined,
      ...(this.executionIsolation.mode === "bwrap"
        ? {
            projectsRoot: join(
              this.stateDir,
              "provider-state",
              "claude",
              providerStateKey(meta.sessionId),
              "projects",
            ),
          }
        : {}),
    }).filter((task) => !recovered.has(task.id));
    if (tasks.length === 0) return meta;
    return this.store.patchMeta(meta.sessionId, {
      backgroundWorkState: "orphaned",
      pendingBackgroundTaskIds: tasks.map((task) => task.id).sort(),
      orphanedWork: {
        pendingTaskIds: tasks.map((task) => task.id).sort(),
        markedAt: Date.now(),
        reason: "process_exit",
      },
    }) ?? meta;
  }

  private scheduleContextOrphanDiscovery(
    meta: SessionMeta,
    automatic = automaticClaudeRecoveryAllowed(meta),
  ): void {
    if (this.shuttingDown || meta.driver !== "claude-code" || meta.context.kind !== "wsl" ||
        meta.status === "stopped" || !meta.agentSessionId || meta.orphanedWork || this.active.has(meta.sessionId) ||
        this.orphanDiscoveryLaunching.has(meta.sessionId)) return;
    this.orphanDiscoveryLaunching.add(meta.sessionId);
    void this.discoverClaudeTasksInContext(
      meta.context,
      meta.worktreePath ?? meta.repoPath,
      meta.agentSessionId,
      { env: meta.env },
    )
      .then((tasks) => {
        if (this.shuttingDown || tasks.length === 0) return;
        const current = this.store.readMeta(meta.sessionId);
        if (!current || current.driver !== "claude-code" || current.agentSessionId !== meta.agentSessionId ||
            current.orphanedWork || this.active.has(meta.sessionId)) return;
        const recovered = new Set(current.recoveredBackgroundTaskIds ?? []);
        const pendingTaskIds = tasks.map((task) => task.id).filter((id) => !recovered.has(id)).sort();
        if (pendingTaskIds.length === 0) return;
        const updated = this.store.patchMeta(meta.sessionId, {
          backgroundWorkState: "orphaned",
          pendingBackgroundTaskIds: pendingTaskIds,
          orphanedWork: { pendingTaskIds, markedAt: Date.now(), reason: "process_exit" },
        });
        if (updated) {
          this.send({ type: "session_runtime_updated", snapshot: this.snapshot(updated) });
          if (automatic && automaticClaudeRecoveryAllowed(updated)) {
            this.scheduleOrphanRecovery(meta.sessionId);
          }
        }
      })
      .catch((error) => this.log(`Claude task discovery failed for ${meta.sessionId}: ${errText(error)}`))
      .finally(() => this.orphanDiscoveryLaunching.delete(meta.sessionId));
  }

  private scheduleOrphanRecovery(sessionId: string, delay = 0): void {
    if (this.shuttingDown || this.orphanRecoveryTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.orphanRecoveryTimers.delete(sessionId);
      void this.runOrphanRecovery(sessionId);
    }, delay);
    timer.unref?.();
    this.orphanRecoveryTimers.set(sessionId, timer);
  }

  private async runOrphanRecovery(sessionId: string): Promise<void> {
    if (this.shuttingDown || this.orphanRecoveryLaunching.has(sessionId)) return;
    let meta = this.store.readMeta(sessionId);
    if (!meta?.orphanedWork || meta.driver !== "claude-code") return;
    if (meta.status === "stopped" || !automaticClaudeRecoveryAllowed(meta)) return;
    if (meta.orphanedWork.recoveryAttemptedAt) return;
    if (!meta.command) {
      const launch = this.resolveLaunch?.(meta.driver, meta.context) ?? null;
      if (launch) {
        meta = this.store.patchMeta(sessionId, { command: launch.command, args: launch.args, env: {} }) ?? meta;
        this.log(`read-only session ${sessionId} healed for orphan recovery`);
      } else {
        // Keep the orphan visible, but do not install a 30-second timer forever. A later register,
        // discovery refresh, or explicit recovery trigger will retry the live launch lookup.
        this.log(`orphan recovery deferred for ${sessionId}: no resumable Claude launch is available`);
        return;
      }
    }
    if (!meta.agentSessionId) {
      this.log(`orphan recovery deferred for ${sessionId}: no resumable Claude launch is available`);
      return;
    }
    const entry = this.active.get(sessionId);
    if (entry?.holdQueuedPromptsAfterInterrupt || entry?.running || entry?.queue.some((prompt) => prompt.syntheticRecovery)) {
      this.scheduleOrphanRecovery(sessionId, ORPHAN_RECOVERY_RETRY_MS);
      return;
    }
    this.orphanRecoveryLaunching.add(sessionId);
    try {
      if (entry) {
        this.prompt(sessionId, ORPHAN_RECOVERY_PROMPT, [], undefined, undefined, undefined, true);
      } else {
        await this.resumeAndPrompt(
          sessionId,
          ORPHAN_RECOVERY_PROMPT,
          [],
          undefined,
          undefined,
          undefined,
          true,
        );
      }
    } finally {
      this.orphanRecoveryLaunching.delete(sessionId);
      const remaining = this.store.readMeta(sessionId)?.orphanedWork;
      if (remaining && !remaining.recoveryAttemptedAt) {
        this.scheduleOrphanRecovery(sessionId, ORPHAN_RECOVERY_RETRY_MS);
      }
    }
  }

  /** Persist/relay first, then enforce against the same normalized event stream every dashboard
   * sees. Cancellation is best-effort at the first observable threshold event; the tripped flag
   * keeps the session idle and holds its queue until an explicit v47 re-arm arrives. */
  private onDriverEvent(sessionId: string, payload: SessionEventPayload): void {
    const entry = this.active.get(sessionId);
    if (entry?.historyIntegrityFailure) return;
    if (!this.emitEvent(sessionId, payload)) return;
    if (payload.kind === "policy_transport") {
      const current = this.store.readMeta(sessionId);
      const capabilities = payload.state === "open"
        ? withoutHookElicitation(current?.capabilities)
        : payload.restoresElicitation
          ? withHookElicitation(current?.capabilities)
          : current?.capabilities;
      if (current && capabilities !== current.capabilities) {
        const updated = this.store.patchMeta(sessionId, { capabilities });
        if (updated) this.send({ type: "session_runtime_updated", snapshot: this.snapshot(updated) });
      }
    }
    if (!entry || !entry.running || entry.governanceTripped) return;
    const meta = this.store.readMeta(sessionId);
    if (!meta) return;

    let tripped: ActiveSession["governanceTripped"];
    if (payload.kind === "tool_call" && meta.config.maxToolCalls) {
      if (!entry.toolCallIds) {
        entry.toolCallIds = new Set(
          this.store.readEvents(sessionId)
            .filter((event) => event.payload.kind === "tool_call")
            .map((event) => (event.payload as Extract<SessionEventPayload, { kind: "tool_call" }>).toolCallId),
        );
      } else {
        entry.toolCallIds.add(payload.toolCallId);
      }
      if (entry.toolCallIds.size >= meta.config.maxToolCalls) tripped = "max_tool_calls";
    } else if (
      payload.kind === "token_usage" &&
      !payload.parentToolUseId &&
      meta.config.costBudgetUsd &&
      meta.costUsd >= meta.config.costBudgetUsd
    ) {
      tripped = "cost_budget";
    }
    if (!tripped) return;

    entry.governanceTripped = tripped;
    const detail = tripped === "cost_budget"
      ? `Runner governance paused this turn at the $${meta.config.costBudgetUsd!.toFixed(2)} cost threshold.`
      : `Runner governance paused this turn at ${meta.config.maxToolCalls} distinct tool calls.`;
    if (!this.emitEvent(sessionId, { kind: "stderr", text: `${detail} Continue or stop from the approval card.` })) {
      return;
    }
    try {
      entry.client.cancel();
    } catch (error) {
      this.log(`governance cancel failed for ${sessionId}: ${errText(error)}`);
    }
  }

  private onDriverStderr(sessionId: string, text: string): void {
    if (this.active.get(sessionId)?.historyIntegrityFailure) return;
    this.emitEvent(sessionId, { kind: "stderr", text });
  }

  private emitTelemetry(
    meta: SessionMeta,
    event: Pick<Extract<RunnerToControlPlane, { type: "driver_telemetry" }>, "metric" | "outcome" | "durationMs" | "reason">,
  ): void {
    this.send({
      type: "driver_telemetry",
      driver: meta.driver,
      version: meta.agentVersion,
      context: meta.context.kind === "wsl" ? "wsl" : "native",
      ...event,
    });
  }

  private cancelApprovalTelemetry(sessionId: string): void {
    const meta = this.store.readMeta(sessionId);
    const requestId = meta?.pendingApproval?.requestId;
    if (!meta || !requestId) return;
    const key = `${sessionId}:${requestId}`;
    const started = this.approvalStarted.get(key);
    this.approvalStarted.delete(key);
    if (started != null) {
      this.emitTelemetry(meta, {
        metric: "approval",
        outcome: "cancelled",
        durationMs: Date.now() - started,
      });
    }
  }

  /** Keep the cheap snapshot fields (preview, token/cost totals, pending approval) current so the
   * register snapshot — and therefore any hydrating dashboard — stays accurate. */
  private accrueMeta(sessionId: string, payload: SessionEventPayload, trackApprovalLatency = true): void {
    if (payload.kind === "agent_message" && payload.text) {
      this.store.patchMeta(sessionId, { preview: payload.text.slice(0, 240) });
    } else if (payload.kind === "user_message") {
      this.store.patchMeta(sessionId, { preview: null });
    } else if (payload.kind === "permission_request") {
      const prior = this.store.readMeta(sessionId)?.pendingApproval?.requestId;
      if (prior && prior !== payload.requestId) this.approvalStarted.delete(`${sessionId}:${prior}`);
      if (trackApprovalLatency) this.approvalStarted.set(`${sessionId}:${payload.requestId}`, Date.now());
      // Persist the pending approval AND the input_required status so a hydrating dashboard files
      // the card under Needs Input (not Running) and fires its notification.
      this.store.patchMeta(sessionId, {
        pendingApproval: {
          requestId: payload.requestId,
          title: payload.title,
          options: payload.options,
          ...(payload.purpose === "authentication" ? { kind: "authentication" as const } : {}),
          ...(payload.context ? { context: payload.context } : {}),
        },
        status: "input_required",
      });
    } else if (payload.kind === "question_request") {
      const prior = this.store.readMeta(sessionId)?.pendingApproval?.requestId;
      if (prior && prior !== payload.requestId) this.approvalStarted.delete(`${sessionId}:${prior}`);
      if (trackApprovalLatency) this.approvalStarted.set(`${sessionId}:${payload.requestId}`, Date.now());
      // Structured agent question — same approval slot, kind "question" (the web renders a
      // question card; answers ride answer_question, not resolve_permission).
      this.store.patchMeta(sessionId, {
        pendingApproval: {
          requestId: payload.requestId,
          title: payload.questions[0]?.question ?? "The agent has a question",
          options: [],
          kind: "question",
          questions: payload.questions,
        },
        status: "input_required",
      });
    } else if (payload.kind === "permission_resolved" || payload.kind === "question_resolved") {
      this.approvalStarted.delete(`${sessionId}:${payload.requestId}`);
      // Card answered — the turn resumes, so clear the approval and restore the running status.
      this.store.patchMeta(sessionId, { pendingApproval: null, status: "running" });
    } else if (payload.kind === "token_usage" && !payload.parentToolUseId) {
      // Subagent usage is retained in the event log for UI rollups; the parentless provider result
      // is the authoritative total and already includes delegated work.
      const m = this.store.readMeta(sessionId);
      if (!m) return;
      this.store.patchMeta(sessionId, {
        tokensIn: m.tokensIn + (payload.inputTokens ?? 0),
        tokensOut: m.tokensOut + (payload.outputTokens ?? 0),
        costUsd: m.costUsd + (payload.costUsd ?? 0),
      });
    }
  }
}

function errText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

function boundedSessionIdForLog(sessionId: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId) ? sessionId : "<invalid-session>";
}
