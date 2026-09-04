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
  AgentDefinition,
  AgentDriverKind,
  AgentSlashCommand,
  AcpRuntimeCapabilities,
  DurableSessionCommandErrorCode,
  EditQueuedPromptMessage,
  EditQueuedPromptResultMessage,
  ExternalSessionDescriptor,
  InvokeSessionCommandMessage,
  InterruptTurnResultReason,
  PromptImage,
  PromptImageInput,
  PromptImageReference,
  QueuedPromptDraft,
  QueuedPromptEditFailureReason,
  ReadQueuedPromptMessage,
  ReadQueuedPromptResultMessage,
  RunnerToControlPlane,
  SessionConfig,
  SessionCommandInvocationErrorCode,
  SessionEventPayload,
  SessionLaunchSpec,
  SessionSnapshot,
  SessionStatus,
  SessionWorktreeView,
  ResolveSteeringAttemptMessage,
  ResolveSteeringAttemptResultMessage,
  SteerResultReason,
  SteerSessionMessage,
  SteerSessionResultMessage,
} from "@wollipog/protocol";
import {
  isPromptImageReference,
  PROTOCOL_VERSION,
  providerSupportsConversationFork,
  runnerSupportsProtocol,
  validatePromptImageInputs,
} from "@wollipog/protocol";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { makeDriver, type Driver } from "./drivers/factory.js";
import type {
  DriverBackgroundWorkUpdate,
  DriverSteerResult,
  DriverSubscriptionUsageUpdate,
  StopReason,
} from "./drivers/driver.js";
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
import type { SubscriptionUsageProbeAuthorization } from "./subscription-usage.js";
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
import {
  SessionStore,
  isAdoptedSession,
  metaToSnapshot,
  type DurableBackgroundJob,
  type SessionMeta,
  type StoredEvent,
} from "./session-store.js";
import { SessionCommandAuthorityRegistry } from "./session-command-authority.js";
import type {
  ProviderAuthObservation,
  ProviderAuthRecoveryController,
  ProviderCredentialScope,
} from "./provider-auth-recovery.js";
import {
  createWorktree,
  createRequestedWorktree,
  attachRequestedWorktree,
  fetchRemoteDefaultBase,
  createWorktreeFromTree,
  captureTurnDiff,
  discardWorktreeIfSafe,
  isGitRepo,
  nativeRepositoryPathIsUnavailable,
  removeRequestedWorktreeBoundary,
  removeWorktree,
  requestedWorktreeBoundary,
  sameWorktreePath,
  worktreeHead,
  worktreePullRequestState,
  worktreeDiff,
  WorktreeCleanupJournal,
  type WorktreeCleanupRecord,
  type WorktreeHandle,
} from "./worktree.js";

export interface SessionNamingExecutionAuthorization {
  isolation?: SpawnIsolation;
  cleanup(): Promise<void>;
}

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

/** Resolve the box's CURRENT launch params for an exact agent/driver/context (null = no such agent). Injected by
 * the daemon (closing over its live agent list) so a read-only adopt can heal once the box gains a
 * matching agent — discovery finishing after the adopt, or the user installing the CLI later. */
export type LaunchResolver = (
  driver: AgentDriverKind,
  context: AgentContext,
  agentId?: string | null,
) => { command: string; args: string[]; env: Record<string, string> } | null;

interface QueuedPrompt {
  /** Stable id so the dashboard can cancel this specific queued prompt before it starts. */
  id: string;
  /** Monotonic runner-local order. It survives reservation/restoration and app-server recovery. */
  ordinal?: number;
  text: string;
  images: PromptImageInput[];
  /** Optimistic-concurrency coordinate for in-place queue editing. */
  editRevision?: string;
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
  /** Durable managed jobs whose barrier terminal observation caused this continuation. */
  backgroundJobIds?: string[];
}

interface QueueEditReceipt {
  requestHash: string;
  result: EditQueuedPromptResultMessage;
}

interface PreparedCommandCheckpoint {
  turn: number;
  tree: string | null;
  priorTurnCount: number;
  priorLastTurnBaseTree: string | null | undefined;
  priorTurnRef: string | null;
  ownerHash?: string;
  worktreeId: string;
  priorWorktreeId?: string;
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
  /** Exact launch generation that owns this provider process; fences callbacks from retirees. */
  launchGeneration: number;
  client: Driver;
  repoPath: string;
  cwd: string;
  worktree: WorktreeHandle | null;
  /** Cross-process lease proving this provider may still use its worktree cwd. */
  worktreeLeaseOwner?: string;
  context: AgentContext;
  status: SessionStatus;
  /** True only after initialize + new/resume + driver-owned initial configuration restoration.
   * ACP may publish catalog notifications while session/new is still resolving; those remain
   * display-only until this fence opens. */
  providerReady: boolean;
  /** Process-generation truth that narrows the live catalog without mutating durable discovery
   * capabilities. Cleared automatically when this ActiveSession is replaced. */
  steeringAvailable?: boolean;
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
  /** Managed jobs owned by the currently dequeued runner continuation. */
  currentBackgroundJobIds?: string[];
  backgroundPromptAccepted?: boolean;
  backgroundAssistantMessagePersisted?: boolean;
  /** A successful turn-only interruption preserves the remaining FIFO but does not run it until
   * a later explicit prompt unambiguously asks the session to continue. */
  holdQueuedPromptsAfterInterrupt?: boolean;
  /** A control-plane card (checkpoint, unpriced, daily budget) is holding the queue. Its own flag,
   * because the interrupt hold above is cleared when a provider completes before the interrupt
   * takes effect, and that settle must not release work a card is still parking. */
  controlPlaneHold?: boolean;
  /** Distinct invocation ids are rebuilt once from the durable event log when a tool guardrail is
   * armed, then maintained in memory on normalized tool events. */
  toolCallIds?: Set<string>;
  /** A runner-side threshold cancelled this turn. Queued prompts remain held until CP re-arms. */
  governanceTripped?: "cost_budget" | "max_tool_calls";
  /** Request-scoped option semantics for live permission asks. The current approval card can be
   * cleared by a settled status or replaced while this driver still owns the original request, so
   * it cannot classify a later successful resolution. This retains only option ids/kinds in the
   * exact live process generation; disposing the entry discards them without durable provider
   * content or a cross-generation leak. */
  permissionOptionKinds?: Map<string, Map<string, string>>;
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
  /** A provider credential failure cancelled the current turn. Existing FIFO work stays held until
   * a new user prompt explicitly asks the runner to revalidate the exact installation. */
  authenticationBlocked?: boolean;
  /** A validated worktree selection made after this process launched. The current turn keeps its
   * original OS cwd, then the drain resumes the same conversation inside the selected worktree
   * before admitting another turn. */
  pendingWorktreeRebind?: string;
}

interface ProviderRetirement {
  client: Driver;
  entry: ActiveSession;
  promise: Promise<void>;
  /** A successful worktree handoff keeps the existing box slot and session lock for its replacement. */
  preserveAdmission: boolean;
  preserveLock: boolean;
  /** While a handoff is healthy, prompts may join the replacement generation's pre-launch FIFO. */
  acceptPromptsDuringHandoff: boolean;
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
const WORKTREE_PR_RECONCILIATION_MS = 5 * 60 * 1_000;

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
const BACKGROUND_CONTINUATION_PROMPT =
  "Managed background jobs reached their terminal barrier. Consume every queued task notification and deliver the parent workflow's final user-visible result without waiting for another user message.";
const MAX_RETAINED_DELIVERED_BACKGROUND_JOBS = 128;
const MAX_BACKGROUND_OUTPUT_REFERENCE_CHARS = 4_096;
const BACKGROUND_CONTINUATION_DELIVERED_PREFIX = "Managed background continuation delivered: ";

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
  /** A reconnect/restart can reconstruct the same queue id and content; tokens from the previous
   * process must still fail closed instead of matching the replacement generation. */
  private readonly queueEditGeneration = randomUUID();
  private readonly active = new Map<string, ActiveSession>();
  /** Stable ordering spans active queues, promotion reservations, and app-server recovery queues. */
  private readonly nextQueueOrdinalBySession = new Map<string, number>();
  /** Per-session single-consumer steering lane. Admission remains synchronous; provider work does not. */
  private readonly steeringLanes = new Map<string, SteeringOperation[]>();
  private readonly steeringLaneRunning = new Set<string>();
  /** Live-process idempotency. The control plane remains the durable lifetime authority. */
  private readonly steeringRegistry = new Map<string, Map<string, SteeringOperation>>();
  /** Process-local idempotency; durable accepted content is reconciled by the control plane. */
  private readonly queueEditReceipts = new Map<string, QueueEditReceipt>();
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
  /** Sessions whose control-plane hold outlived their process: recovery must not drain their
   * queue, and the replacement entry inherits the hold, until the control plane releases it. */
  private readonly recoveryHolds = new Set<string>();
  /** Prompts received after a session was materialized but before capacity admission. They must
   * join the original launch instead of starting a competing resume generation. Durable command
   * lifecycles make this in-memory FIFO recoverable after a runner restart. */
  private readonly preLaunchQueues = new Map<string, QueuedPrompt[]>();
  private readonly recoveryLaunching = new Set<string>();
  private readonly orphanRecoveryLaunching = new Set<string>();
  private readonly orphanRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly backgroundContinuationLaunching = new Set<string>();
  private readonly backgroundContinuationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly orphanDiscoveryLaunching = new Set<string>();
  private lastOrphanRecoveryScanAt = 0;
  private orphanRecoveryScanTimer: ReturnType<typeof setTimeout> | null = null;
  /** Provider logout is asynchronous; fence prompts and other provider/worktree operations. */
  private readonly loggingOut = new Set<string>();
  /** Explicit stop waits for ACP session/close before this session may launch again. */
  private readonly closing = new Map<string, ProviderRetirement>();
  /** A turn-boundary worktree move owns a retiring provider even after it leaves `active`.
   * Unlike an ordinary close, prompts may join its pre-launch FIFO while the conversation reopens. */
  private readonly worktreeRebindings = new Map<string, {
    entry: ActiveSession;
    promise: Promise<void>;
    /** Exact target captured once provider launch preparation begins. A later selection may move
     * durable metadata again, but cleanup must keep fencing the cwd already handed to launch(). */
    launchingWorktreePath?: string;
  }>();
  /** Deletions that installed their durable tombstone but remain fenced on exact-client exit. */
  private readonly pendingDeletions = new Set<string>();
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
  private readonly worktreePullRequestReconcileTimer: ReturnType<typeof setInterval>;
  private historyMaintenanceKickoff: ReturnType<typeof setTimeout> | null = null;
  private historyMaintenanceRunning = false;
  private providerStateReconciling = false;
  private worktreePullRequestReconciling = false;
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
  /** Test seams keep forge availability and destructive Git behavior deterministic. */
  private resolveWorktreePullRequestState: typeof worktreePullRequestState = worktreePullRequestState;
  private discardSessionWorktreeIfSafe: typeof discardWorktreeIfSafe = discardWorktreeIfSafe;
  /** Test seam keeps provider-home discovery deterministic without writing into a real Claude home. */
  private discoverClaudeTasks: typeof discoverIncompleteClaudeTasks = discoverIncompleteClaudeTasks;
  /** Async seam covers WSL markerless recovery without blocking runner startup. */
  private discoverClaudeTasksInContext: typeof discoverIncompleteClaudeTasksInContext = discoverIncompleteClaudeTasksInContext;
  private readonly sessionCommandAuthority = new SessionCommandAuthorityRegistry();
  private readonly providerHomeLeases?: ProviderHomeLeaseRegistry;
  private readonly providerAuthOperations = new Set<string>();
  /** Create/attach/select all merge durable session inventory, so serialize them per session. */
  private readonly worktreeOperations = new Map<string, Promise<unknown>>();

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
    private readonly providerAuthRecovery?: ProviderAuthRecoveryController,
    private readonly onSubscriptionUsageUpdate?: (
      agentId: string,
      driver: AgentDriverKind,
      context: AgentContext,
      update: DriverSubscriptionUsageUpdate,
    ) => void,
    /** Exact operator-configured Project Location roots eligible for existing-worktree attach. */
    private readonly configuredProjectPaths: string[] = [],
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
    this.worktreePullRequestReconcileTimer = setInterval(
      () => void this.reconcileWorktreePullRequests(),
      WORKTREE_PR_RECONCILIATION_MS,
    );
    this.worktreePullRequestReconcileTimer.unref?.();
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

  private attributedWorktrees(meta: SessionMeta): SessionWorktreeView[] {
    const worktrees = [...(meta.worktrees ?? [])];
    if (meta.worktreePath && !worktrees.some((worktree) => sameWorktreePath(meta.context, worktree.path, meta.worktreePath!))) {
      worktrees.push({
        id: "legacy",
        path: meta.worktreePath,
        branch: meta.worktreeBranch ?? `agent/${meta.sessionId}`,
        source: "legacy",
      });
    }
    return worktrees;
  }

  private attributedWorktreeForPath(meta: SessionMeta, path: string): SessionWorktreeView | undefined {
    return this.attributedWorktrees(meta)
      .find((worktree) => sameWorktreePath(meta.context, worktree.path, path));
  }

  private checkpointWorktreeId(meta: SessionMeta, path: string): string {
    const worktree = this.attributedWorktreeForPath(meta, path);
    if (!worktree) throw new Error("active worktree has no durable session identity");
    return worktree.id;
  }

  private runWorktreeOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.worktreeOperations.get(sessionId) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(operation);
    this.worktreeOperations.set(sessionId, current);
    return current.finally(() => {
      if (this.worktreeOperations.get(sessionId) === current) this.worktreeOperations.delete(sessionId);
    });
  }

  private async activateWorktree(meta: SessionMeta, worktree: SessionWorktreeView): Promise<SessionSnapshot> {
    // A request can arrive during the current provider turn. Anchor that turn's remaining diff at
    // the newly selected tree so capture/checkpoint logic never compares two different worktrees.
    const baseTree = await withGitExecutionContext(meta.context, () => captureWorktreeTree(worktree.path));
    const latest = this.store.readMeta(meta.sessionId);
    if (!latest || !this.sessionCanOpen(meta.sessionId)) {
      throw new Error("session disappeared while its requested worktree was activating");
    }
    const live = this.active.get(meta.sessionId);
    if (live && !sameWorktreePath(live.context, live.cwd, worktree.path)) {
      this.captureAgentSessionId(meta.sessionId, live.client);
      const resumable = this.store.readMeta(meta.sessionId);
      if (!resumable) {
        throw new Error("session disappeared while its requested worktree was activating");
      }
      if (!resumable.agentSessionId && resumable.seq > 0) {
        throw new Error("the running provider has not established a resumable conversation; retry worktree selection after this turn");
      }
      if (resumable.agentSessionId && !canResumeSession(resumable)) {
        throw new Error("the running provider does not support resuming this conversation in another worktree; stop it before selecting a different worktree");
      }
    }
    const priorActive = latest.worktreePath
      ? this.attributedWorktreeForPath(latest, latest.worktreePath)
      : undefined;
    let checkpointWorktreeIds = latest.checkpointWorktreeIds;
    if (priorActive && !sameWorktreePath(latest.context, priorActive.path, worktree.path) &&
        this.attributedWorktrees(latest).length === 1 && (latest.turnCount ?? 0) > 0) {
      checkpointWorktreeIds = { ...(checkpointWorktreeIds ?? {}) };
      for (let turn = 1; turn <= (latest.turnCount ?? 0); turn++) {
        checkpointWorktreeIds[String(turn)] ??= priorActive.id;
      }
    }
    const worktrees = this.attributedWorktrees(latest)
      .filter((item) => !sameWorktreePath(latest.context, item.path, worktree.path));
    worktrees.push(worktree);
    const updated = this.store.patchMeta(meta.sessionId, {
      worktreePath: worktree.path,
      worktreeBranch: worktree.branch,
      worktrees,
      checkpointWorktreeIds,
      lastTurnBaseTree: baseTree,
    });
    if (!updated) throw new Error("session disappeared while its requested worktree was activating");
    const active = this.active.get(meta.sessionId);
    if (active) {
      active.worktree = { path: worktree.path, branch: worktree.branch, created: false };
      active.pendingWorktreeRebind = sameWorktreePath(active.context, active.cwd, worktree.path)
        ? undefined
        : worktree.path;
      if (active.pendingWorktreeRebind && !active.running) {
        setImmediate(() => this.scheduleDrain(meta.sessionId));
      }
    }
    const snapshot = this.snapshot(updated);
    this.send({ type: "session_runtime_updated", snapshot });
    return snapshot;
  }

  /** Session-scoped operation seam consumed by the local CLI/MCP service. */
  async requestWorktree(
    sessionId: string,
    request: { baseRef?: string; branch: string },
  ): Promise<{ worktree: SessionWorktreeView; snapshot: SessionSnapshot }> {
    return this.runWorktreeOperation(sessionId, async () => {
      const meta = this.store.readMeta(sessionId);
      if (!meta || !this.sessionCanOpen(sessionId)) throw new Error("session is unavailable");
      if (meta.executionTarget && meta.executionTarget.adapter !== "host") {
        throw new Error("session worktrees are available only on host execution targets");
      }
      const options = {
        context: meta.context,
        dataDir: this.dataDir,
        ownerHash: this.runnerOwnerHash,
        allowedProjectPaths: this.configuredProjectPaths,
      };
      const baseRef = request.baseRef ?? await fetchRemoteDefaultBase(meta.repoPath, options);
      const created = await createRequestedWorktree(meta.repoPath, sessionId, {
        baseRef,
        branch: request.branch,
      }, options);
      if (!created.created) {
        const existing = this.attributedWorktrees(meta).find((item) =>
          item.source === "created" && sameWorktreePath(meta.context, item.path, created.path) &&
          item.branch === created.branch);
        if (!existing) {
          throw new Error("requested worktree already exists without ownership by this session");
        }
        const canonical = { ...existing, path: created.path };
        return { worktree: canonical, snapshot: await this.activateWorktree(meta, canonical) };
      }
      const worktree: SessionWorktreeView = {
        id: created.path.split(/[\\/]/u).at(-1)!,
        path: created.path,
        branch: created.branch,
        baseRef: created.baseRef,
        baseCommit: created.baseCommit,
        source: "created",
      };
      try {
        return { worktree, snapshot: await this.activateWorktree(meta, worktree) };
      } catch (error) {
        if (created.created) {
          try {
            await removeWorktree(meta.repoPath, created, options);
          } catch {
            this.log(`requested worktree cleanup for ${boundedSessionIdForLog(sessionId)} needs operator attention`);
          }
        }
        throw error;
      }
    });
  }

  /** Attach an operator-located, Git-registered worktree and make it the active Git target. */
  async attachWorktree(
    sessionId: string,
    path: string,
  ): Promise<{ worktree: SessionWorktreeView; snapshot: SessionSnapshot }> {
    return this.runWorktreeOperation(sessionId, async () => {
      const meta = this.store.readMeta(sessionId);
      if (!meta || !this.sessionCanOpen(sessionId)) throw new Error("session is unavailable");
      if (meta.executionTarget && meta.executionTarget.adapter !== "host") {
        throw new Error("session worktrees are available only on host execution targets");
      }
      const attached = await attachRequestedWorktree(meta.repoPath, sessionId, path, {
        context: meta.context,
        dataDir: this.dataDir,
        ownerHash: this.runnerOwnerHash,
        // A running platform sandbox cannot gain a new external mount. Its pre-bound session
        // directory remains attachable; provider isolation can use configured external Locations.
        allowedProjectPaths: this.executionIsolation.mode === "provider"
          ? this.configuredProjectPaths
          : [],
      });
      // Re-attaching an already-attributed runner-owned tree must never launder it into an
      // operator-owned record that session deletion would deliberately retain.
      const existing = this.attributedWorktrees(meta)
        .find((item) => sameWorktreePath(meta.context, item.path, attached.path));
      if (existing && existing.branch !== attached.branch) {
        throw new Error("worktree branch changed since it was linked to this session");
      }
      const worktree: SessionWorktreeView = existing ? { ...existing, path: attached.path } : {
        id: createHash("sha256").update(attached.path).digest("hex").slice(0, 16),
        path: attached.path,
        branch: attached.branch,
        baseCommit: attached.baseCommit,
        source: "attached",
      };
      return { worktree, snapshot: await this.activateWorktree(meta, worktree) };
    });
  }

  /** Select one already-attributed worktree as the target for every session Git action. */
  async selectWorktree(sessionId: string, path: string): Promise<SessionSnapshot> {
    return this.runWorktreeOperation(sessionId, async () => {
      const meta = this.store.readMeta(sessionId);
      if (!meta || !this.sessionCanOpen(sessionId)) throw new Error("session is unavailable");
      const worktree = this.attributedWorktrees(meta)
        .find((item) => sameWorktreePath(meta.context, item.path, path));
      if (!worktree) throw new Error("worktree is not linked to this session");
      const verified = await attachRequestedWorktree(meta.repoPath, sessionId, worktree.path, {
        context: meta.context,
        dataDir: this.dataDir,
        ownerHash: this.runnerOwnerHash,
        // The path was already attributed by a prior validated create/attach operation; Git
        // registration and health are still re-proved before changing the active target.
        allowedProjectPaths: [worktree.path],
      });
      if (verified.branch !== worktree.branch) {
        throw new Error("worktree branch changed since it was linked to this session");
      }
      return this.activateWorktree(meta, { ...worktree, path: verified.path });
    });
  }

  async linkWorktreePullRequest(sessionId: string, worktreePath: string, url: string): Promise<void> {
    await this.runWorktreeOperation(sessionId, async () => {
      const meta = this.store.readMeta(sessionId);
      if (!meta?.worktrees) return;
      const worktrees = meta.worktrees.map((worktree) => sameWorktreePath(meta.context, worktree.path, worktreePath)
        ? { ...worktree, pullRequest: { url, state: "open" as const } }
        : worktree);
      const updated = this.store.patchMeta(sessionId, { worktrees });
      if (updated) this.send({ type: "session_runtime_updated", snapshot: this.snapshot(updated) });
    });
  }

  private liveWorktreeUsesPath(sessionId: string, path: string): boolean {
    const active = this.active.get(sessionId);
    const rebind = this.worktreeRebindings.get(sessionId);
    const rebinding = rebind?.entry;
    const rebindingSelection = rebinding ? this.store.readMeta(sessionId)?.worktreePath : undefined;
    return (!!active && (sameWorktreePath(active.context, active.cwd, path) ||
      (!!active.worktree && sameWorktreePath(active.context, active.worktree.path, path)) ||
      (!!active.pendingWorktreeRebind &&
        sameWorktreePath(active.context, active.pendingWorktreeRebind, path)))) ||
      (!!rebinding && (sameWorktreePath(rebinding.context, rebinding.cwd, path) ||
        (!!rebinding.worktree && sameWorktreePath(rebinding.context, rebinding.worktree.path, path)))) ||
      (!!rebinding && !!rebindingSelection && sameWorktreePath(rebinding.context, rebindingSelection, path)) ||
      (!!rebinding && !!rebind?.launchingWorktreePath &&
        sameWorktreePath(rebinding.context, rebind.launchingWorktreePath, path)) ||
      this.closing.has(sessionId);
  }

  private releaseActiveWorktreeLease(entry: ActiveSession): void {
    if (!entry.worktreeLeaseOwner) return;
    this.store.releaseWorktreeLease(entry.sessionId, entry.worktreeLeaseOwner);
    entry.worktreeLeaseOwner = undefined;
  }

  private deleteActiveSession(sessionId: string, expected?: ActiveSession, releaseLease = true): boolean {
    const active = this.active.get(sessionId);
    if (!active || (expected && active !== expected)) return false;
    if (releaseLease) this.releaseActiveWorktreeLease(active);
    return this.active.delete(sessionId);
  }

  private async discardWorktreeLocked(
    sessionId: string,
    path: string,
  ): Promise<{ removed: boolean; reason?: string; snapshot?: SessionSnapshot }> {
    const meta = this.store.readMeta(sessionId);
    if (!meta || !this.sessionCanOpen(sessionId)) return { removed: false, reason: "session is unavailable" };
    const worktree = this.attributedWorktrees(meta)
      .find((item) => sameWorktreePath(meta.context, item.path, path));
    if (!worktree) return { removed: false, reason: "worktree is not linked to this session" };
    const source = worktree.source;
    if (source === "attached") {
      return { removed: false, reason: "attached operator-owned worktrees must be removed by their owner" };
    }
    const selectedIsLaunching = !!meta.worktreePath &&
      sameWorktreePath(meta.context, meta.worktreePath, worktree.path) &&
      (meta.status === "starting" || meta.status === "queued" || meta.worktreePending === true);
    if (selectedIsLaunching) {
      return { removed: false, reason: "the worktree is still being launched by a provider process" };
    }
    if (this.liveWorktreeUsesPath(sessionId, worktree.path)) {
      return { removed: false, reason: "the worktree is still active in a provider process" };
    }
    const cleanupLeaseOwner = `${this.lockOwner}:cleanup:${randomUUID()}`;
    if (!this.store.acquireWorktreeLease(sessionId, cleanupLeaseOwner)) {
      return { removed: false, reason: "the worktree is leased by another runner process" };
    }
    try {
      // Close the local race with a provider launch that acquired its durable lease while this
      // cleanup was waiting. The cross-process lease closes the equivalent race on sibling runners.
      if (this.liveWorktreeUsesPath(sessionId, worktree.path)) {
        return { removed: false, reason: "the worktree is still active in a provider process" };
      }
      const result = await this.discardSessionWorktreeIfSafe(
        meta.repoPath,
        sessionId,
        { ...worktree, source },
        {
          context: meta.context,
          dataDir: this.dataDir,
          ownerHash: this.runnerOwnerHash,
        },
      );
      if (!result.removed) {
        const reasons = {
          not_runner_owned: "runner ownership could not be proven",
          branch_changed: "the registered worktree branch changed",
          dirty: "the worktree has uncommitted changes",
          no_upstream: "the branch has no upstream",
          unpushed: "the branch has unpushed commits",
          unavailable: "Git state is unavailable or changed during cleanup",
        } as const;
        return { removed: false, reason: reasons[result.reason] };
      }

      // The session lane excludes create/attach/select/link/discard races. Re-read after Git I/O so
      // an out-of-process store removal cannot be accidentally recreated by this patch.
      const latest = this.store.readMeta(sessionId);
      if (!latest) return { removed: true };
      const worktrees = this.attributedWorktrees(latest)
        .filter((item) => !sameWorktreePath(latest.context, item.path, worktree.path));
      const removedActiveSelection = !!latest.worktreePath &&
        sameWorktreePath(latest.context, latest.worktreePath, worktree.path);
      const updated = this.store.patchMeta(sessionId, {
        worktrees,
        ...(removedActiveSelection
          ? { worktreePath: null, worktreeBranch: undefined, lastTurnBaseTree: undefined }
          : {}),
      });
      if (!updated) return { removed: true };
      await removeRequestedWorktreeBoundary(meta.repoPath, sessionId, {
        context: meta.context,
        dataDir: this.dataDir,
        ownerHash: this.runnerOwnerHash,
      }).catch(() => false);
      const snapshot = this.snapshot(updated);
      this.send({ type: "session_runtime_updated", snapshot });
      return { removed: true, snapshot };
    } finally {
      this.store.releaseWorktreeLease(sessionId, cleanupLeaseOwner);
    }
  }

  /** Destructive session-scoped operation. Safety checks are identical to automatic PR cleanup;
   * explicit intent bypasses only the requirement for a terminal forge state. */
  async discardWorktree(sessionId: string, path: string): Promise<SessionSnapshot> {
    return this.runWorktreeOperation(sessionId, async () => {
      const result = await this.discardWorktreeLocked(sessionId, path);
      if (!result.removed || !result.snapshot) {
        throw new Error(`worktree retained: ${result.reason ?? "cleanup did not complete"}`);
      }
      return result.snapshot;
    });
  }

  /** Conservative startup/periodic reconciliation. Forge failures retain state, while a durable
   * terminal state is remembered so dirty or active trees can be retried after they become safe. */
  async reconcileWorktreePullRequests(): Promise<void> {
    if (this.worktreePullRequestReconciling || this.shuttingDown) return;
    this.worktreePullRequestReconciling = true;
    try {
      for (const candidate of this.store.listSessions()) {
        try {
          await this.runWorktreeOperation(candidate.sessionId, async () => {
            let meta = this.store.readMeta(candidate.sessionId);
            if (!meta || !this.sessionCanOpen(candidate.sessionId)) return;
            const linkedPaths = this.attributedWorktrees(meta)
              .filter((worktree) => worktree.pullRequest)
              .map((worktree) => worktree.path);
            for (const path of linkedPaths) {
              meta = this.store.readMeta(candidate.sessionId);
              if (!meta) continue;
              const reconciliationContext = meta.context;
              const worktree = this.attributedWorktrees(meta)
                .find((item) => sameWorktreePath(reconciliationContext, item.path, path));
              if (!worktree?.pullRequest) continue;
              let state = worktree.pullRequest.state;
              if (state === "open") {
                const verified = await this.resolveWorktreePullRequestState(
                  worktree.path,
                  worktree.pullRequest.url,
                  { context: meta.context },
                );
                if (!verified || verified === "open") continue;
                state = verified;
                const worktrees = this.attributedWorktrees(meta).map((item) => sameWorktreePath(reconciliationContext, item.path, path)
                  ? { ...item, pullRequest: { ...worktree.pullRequest!, state } }
                  : item);
                const updated = this.store.patchMeta(candidate.sessionId, { worktrees });
                if (!updated) continue;
                this.send({ type: "session_runtime_updated", snapshot: this.snapshot(updated) });
              }
              if (state === "merged" || state === "closed") {
                await this.discardWorktreeLocked(candidate.sessionId, path);
              }
            }
          });
        } catch (error) {
          this.log(`pull request worktree reconciliation failed for ${boundedSessionIdForLog(candidate.sessionId)}: ${errText(error)}`);
        }
      }
    } catch (error) {
      this.log(`pull request worktree reconciliation could not enumerate sessions: ${errText(error)}`);
    } finally {
      this.worktreePullRequestReconciling = false;
    }
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

  /** Skill links mutate the same native provider HOME as Claude and Codex launches. Acquire the
   * registry's process-lifetime lease before reconciliation touches those shared directories. */
  acquireSkillReconciliationProviderHome(home: string): void {
    this.providerHomeLeases?.acquireHome(home);
  }

  /** Account probes are no-turn provider launches, but the provider may still mutate its effective
   * HOME while initializing. Bind them to the same attested owner lease as sessions and TUIs. */
  async prepareSubscriptionUsageProbe(
    agent: AgentDefinition,
    env: Record<string, string>,
    sourceId: string,
  ): Promise<SubscriptionUsageProbeAuthorization> {
    const context = agent.context ?? { kind: "native" as const };
    const cwd = context.kind === "wsl"
      ? "/tmp"
      : join(this.stateDir, "subscription-usage-probes", sourceId);
    if (context.kind === "native") {
      await mkdir(cwd, { recursive: true, mode: 0o700 });
    }
    const isolation = await this.resolveIsolation(this.executionIsolation, context, {}, {
      driver: agent.driver ?? "acp",
      dataDir: this.stateDir,
      env,
      sessionId: `subscription-usage:${sourceId}`,
      cwd,
      ...(this.runnerOwnerHash ? { ownerHash: this.runnerOwnerHash } : {}),
    });
    this.providerHomeLeases?.acquire({
      driver: agent.driver ?? "acp",
      command: agent.command,
      context,
      env,
      isolation,
    });
    return { cwd, ...(isolation ? { isolation } : {}) };
  }

  /** Put metadata-only naming helpers behind the same runner-owned process and provider-HOME
   * boundaries as ordinary sessions. Seatbelt's shared provider store also uses its existing
   * cross-process exclusive admission group; overload fails closed instead of queueing a title. */
  async prepareSessionNamingExecution(
    agent: AgentDefinition,
    env: Record<string, string>,
    cwd: string,
  ): Promise<SessionNamingExecutionAuthorization> {
    const context = agent.context ?? { kind: "native" as const };
    const driver = agent.driver ?? "acp";
    const taskId = `session-naming:${randomUUID()}`;
    const provider = driver === "claude-code"
      ? "claude"
      : driver === "codex" || driver === "codex-app-server"
        ? "codex"
        : null;
    let seatbeltAdmitted = false;
    const cleanup = async () => {
      try {
        await this.removeIsolationState(
          this.executionIsolation,
          context,
          driver,
          this.stateDir,
          taskId,
          {},
          this.runnerOwnerHash,
        );
      } finally {
        if (seatbeltAdmitted) this.boxAdmission.release(taskId);
      }
    };
    try {
      if (this.executionIsolation.mode === "seatbelt" && provider) {
        seatbeltAdmitted = this.boxAdmission.acquire({
          sessionId: taskId,
          agentId: agent.id,
          weight: this.admissionPolicy.agentWeights[agent.id] ?? 1,
          ...(this.admissionPolicy.agentLimits[agent.id] !== undefined
            ? { agentLimit: this.admissionPolicy.agentLimits[agent.id] }
            : {}),
          exclusiveGroup: `seatbelt:${provider}`,
        });
        if (!seatbeltAdmitted) throw new Error("provider isolation is currently busy");
      }
      const isolation = await this.resolveIsolation(this.executionIsolation, context, {}, {
        driver,
        dataDir: this.stateDir,
        env,
        sessionId: taskId,
        cwd,
        ...(this.runnerOwnerHash ? { ownerHash: this.runnerOwnerHash } : {}),
      });
      this.providerHomeLeases?.acquire({ driver, command: agent.command, context, env, isolation });
      return { ...(isolation ? { isolation } : {}), cleanup };
    } catch (error) {
      await cleanup().catch(() => {});
      throw error;
    }
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
      this.upgradeLegacyBackgroundDeliveryEvidence(stored);
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
  sessionSnapshots(exactEventSeq = false) {
    const protocolVersion = this.controlPlaneProtocolVersion();
    return this.store.snapshots(protocolVersion, exactEventSeq).map((snapshot) =>
      this.overlayRuntimeSteering(
        this.sessionCommandAuthority.overlaySnapshot(snapshot, protocolVersion),
        protocolVersion,
      ));
  }

  /** Pre-negotiation register metadata. History is published only after the peer version is known. */
  registrationSessionSnapshots() {
    return this.store.registrationSnapshots().map((snapshot) =>
      this.sessionCommandAuthority.overlaySnapshot(snapshot, null));
  }

  private snapshot(meta: SessionMeta) {
    const protocolVersion = this.controlPlaneProtocolVersion();
    return this.overlayRuntimeSteering(
      this.sessionCommandAuthority.overlaySnapshot(metaToSnapshot(meta, protocolVersion), protocolVersion),
      protocolVersion,
    );
  }

  private overlayRuntimeSteering(snapshot: SessionSnapshot, protocolVersion: number | null): SessionSnapshot {
    if (!runnerSupportsProtocol(protocolVersion, "nativeSteeringOverlay")) return snapshot;
    const available = this.active.get(snapshot.id)?.steeringAvailable;
    if (available === undefined) return snapshot;
    return {
      ...snapshot,
      agentCapabilities: { ...(snapshot.agentCapabilities ?? {}), supportsSteering: available },
    };
  }

  /** One negotiated snapshot for correlated result messages assembled by the socket layer. */
  snapshotForControlPlane(meta: SessionMeta) {
    return this.snapshot(meta);
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
    return this.store.readEventsForProtocol(sessionId, afterSeq, this.controlPlaneProtocolVersion());
  }

  historyPage(
    sessionId: string,
    request: { afterSeq: number; limit: number; logEpoch?: number; throughSeq?: number },
  ) {
    return this.store.readEventPageForProtocol(
      sessionId, request, this.controlPlaneProtocolVersion(),
    );
  }

  /** Recover the newest question that durable history still shows as unresolved. A later user turn
   * or permission request proves the old question is no longer the active interaction, even when
   * an older runner failed to append an explicit replacement resolution. */
  private unresolvedQuestionFromHistory(sessionId: string): {
    scanned: boolean;
    question: SessionMeta["pendingApproval"];
    resolvedQuestionIds: ReadonlySet<string>;
  } {
    const resolved = new Set<string>();
    const tail = this.store.logTailSeqResult(sessionId);
    if (!tail.ok) return { scanned: false, question: null, resolvedQuestionIds: resolved };
    const durableTail = tail.seq;
    if (durableTail === 0) return { scanned: true, question: null, resolvedQuestionIds: resolved };
    let cursor = durableTail;
    let logEpoch: number | undefined;
    let throughSeq: number | undefined;
    while (cursor > 0) {
      let span = Math.min(200, cursor);
      let events: StoredEvent[] | null = null;
      while (span > 0) {
        const page = this.store.readEventPage(sessionId, {
          afterSeq: cursor - span,
          limit: span,
          ...(logEpoch === undefined ? {} : { logEpoch, throughSeq: throughSeq! }),
        });
        if (!page.ok) return { scanned: false, question: null, resolvedQuestionIds: resolved };
        if (logEpoch === undefined) {
          logEpoch = page.page.logEpoch;
          throughSeq = page.page.throughSeq;
          if (throughSeq !== cursor) {
            cursor = throughSeq;
            break;
          }
        }
        if (page.events.at(-1)?.seq === cursor) {
          events = page.events;
          break;
        }
        if (span === 1) return { scanned: false, question: null, resolvedQuestionIds: resolved };
        span = Math.max(1, Math.floor(span / 2));
      }
      if (!events) continue;
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const payload = events[index]!.payload;
        if (payload.kind === "question_resolved") {
          resolved.add(payload.requestId);
          continue;
        }
        if (payload.kind === "question_request") {
          // A resolved newer question replaced every older pending question, so once its request
          // is reached there is nothing earlier that can still be actionable.
          if (resolved.has(payload.requestId)) {
            return { scanned: true, question: null, resolvedQuestionIds: resolved };
          }
          return {
            scanned: true,
            question: {
              requestId: payload.requestId,
              title: payload.questions[0]?.question ?? "The agent has a question",
              options: [],
              kind: "question",
              questions: payload.questions,
            },
            resolvedQuestionIds: resolved,
          };
        }
        if (
          payload.kind === "user_message" || payload.kind === "agent_message" ||
          payload.kind === "agent_thought" || payload.kind === "tool_call" ||
          payload.kind === "permission_request" || payload.kind === "conversation_checkpoint" ||
          payload.kind === "turn_interrupted"
        ) return { scanned: true, question: null, resolvedQuestionIds: resolved };
      }
      cursor = events[0]!.seq - 1;
    }
    return { scanned: true, question: null, resolvedQuestionIds: resolved };
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
          backgroundJobs: [],
          pendingBackgroundTaskIds: [],
          orphanedWork: undefined,
        }) ?? m;
      } else if (m.driver === "claude-code" &&
          (m.backgroundWorkState === "running" || (m.pendingBackgroundTaskIds?.length ?? 0) > 0)) {
        const recovered = new Set(m.recoveredBackgroundTaskIds ?? []);
        const pendingTaskIds = (m.pendingBackgroundTaskIds?.length ? m.pendingBackgroundTaskIds : ["unknown"])
          .filter((id) => !recovered.has(id));
        const marker = {
          ...(m.orphanedWork ?? { markedAt: Date.now(), reason: "process_exit" as const }),
          pendingTaskIds,
        };
        reconciled = this.store.patchMeta(m.sessionId, pendingTaskIds.length > 0
          ? { backgroundWorkState: "orphaned", pendingBackgroundTaskIds: pendingTaskIds, orphanedWork: marker }
          : { backgroundWorkState: undefined, pendingBackgroundTaskIds: [], orphanedWork: undefined }) ?? m;
      } else {
        reconciled = this.discoverOrphanedClaudeWork(m);
      }
      // A durable provider-auth block is authoritative across process restart. Read-only
      // background discovery may still run, but it must not submit an unattended recovery turn.
      reconciled = this.reconcileDeliveredBackgroundContinuations(reconciled);
      const automatic = !reconciled.providerAuthBlock && automaticClaudeRecoveryAllowed(reconciled);
      if (reconciled.status !== "stopped" && automatic && reconciled.orphanedWork && !reconciled.orphanedWork.recoveryAttemptedAt) {
        this.scheduleOrphanRecovery(m.sessionId);
      } else if (reconciled.status !== "stopped") {
        this.scheduleContextOrphanDiscovery(reconciled, automatic);
      }
      if (reconciled.status !== "stopped" && automatic && this.queuedBackgroundJobIds(reconciled).length) {
        this.scheduleBackgroundContinuation(m.sessionId);
      }
      const terminal = reconciled.status === "completed" || reconciled.status === "failed" ||
        reconciled.status === "stopped";
      let historicalQuestion: SessionMeta["pendingApproval"] = null;
      let pendingQuestionResolved = false;
      if (!terminal && !reconciled.providerAuthBlock && !reconciled.pendingApproval &&
          reconciled.questionRecoveryReconciled !== true) {
        const recovery = this.unresolvedQuestionFromHistory(m.sessionId);
        historicalQuestion = recovery.question;
        if (recovery.scanned) {
          reconciled = this.store.patchMeta(m.sessionId, { questionRecoveryReconciled: true }) ?? reconciled;
        }
      } else if (!terminal && !reconciled.providerAuthBlock &&
          reconciled.pendingApproval?.kind === "question") {
        // A crash can land after the resolution event is durable but before its metadata clear.
        // Prefer that exact durable resolution over the stale pending-card projection.
        const recovery = this.unresolvedQuestionFromHistory(m.sessionId);
        pendingQuestionResolved = recovery.resolvedQuestionIds.has(reconciled.pendingApproval.requestId);
      }
      const recoverableQuestion = terminal
        ? null
        : reconciled.pendingApproval?.kind === "question" && !pendingQuestionResolved
          ? reconciled.pendingApproval
          : historicalQuestion;
      if (reconciled.providerAuthBlock && reconciled.status === "stopped") {
        // Terminal operator intent dominates a stale/incomplete recovery generation.
        this.store.patchMeta(m.sessionId, {
          providerAuthBlock: undefined,
          pendingApproval: null,
        });
      } else if (reconciled.providerAuthBlock) {
        // A runner-owned sign-in subprocess cannot survive process restart. Clear only that stale
        // operation generation, then reconstruct the bounded browser projection from durable,
        // secret-free block metadata without appending a duplicate transcript event.
        const block = reconciled.providerAuthBlock.loginOperationId
          ? { ...reconciled.providerAuthBlock, loginOperationId: undefined }
          : reconciled.providerAuthBlock;
        const projection = this.providerAuthenticationProjection(reconciled, block);
        this.store.patchMeta(m.sessionId, {
          providerAuthBlock: block,
          status: "input_required",
          pendingApproval: projection,
        });
      } else if (terminal) {
        if (reconciled.pendingApproval) this.store.patchMeta(m.sessionId, { pendingApproval: null });
      } else if (recoverableQuestion) {
        // A provider response callback cannot survive process loss. Preserve the exact durable
        // question and request identity as an explicit recovery card instead of making the
        // transcript claim it is awaiting an answer while the session silently becomes idle.
        this.store.patchMeta(m.sessionId, {
          status: "input_required",
          pendingApproval: {
            ...recoverableQuestion,
            recoveryReason: "provider_restart",
          },
        });
      } else if (reconciled.status === "starting" || reconciled.status === "running" ||
          reconciled.status === "queued" || reconciled.status === "input_required") {
        // The process that owned any other pending approval is gone — clear the stale card too.
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
    void this.reconcileWorktreePullRequests();
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

  private authorizeHostLaunch(spec: SessionLaunchSpec): {
    spec: SessionLaunchSpec;
    error?: string;
  } {
    if ((spec.executionTarget && spec.executionTarget.adapter !== "host") || !this.resolveLaunch) {
      return { spec };
    }
    const context = spec.context ?? { kind: "native" as const };
    const localLaunch = this.resolveLaunch(spec.driver ?? "acp", context, spec.agentId);
    const mismatch = localLaunch && (localLaunch.command !== spec.command ||
      localLaunch.args.length !== spec.args.length ||
      localLaunch.args.some((arg, index) => arg !== spec.args[index]));
    const authorized = localLaunch
      ? { ...spec, command: localLaunch.command, args: [...localLaunch.args] }
      : { ...spec, command: "", args: [] };
    if (!localLaunch) {
      return {
        spec: authorized,
        error: `agent ${spec.agentId ?? "(missing)"} is not configured or available in the requested context`,
      };
    }
    return mismatch
      ? {
          spec: authorized,
          error: `launch command for agent ${spec.agentId ?? "(missing)"} does not match runner-local configuration`,
        }
      : { spec: authorized };
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
    const authorization = this.authorizeHostLaunch(spec);
    spec = authorization.spec;
    if (authorization.error && this.store.has(spec.sessionId)) {
      // Validate Restart before allocating a replacement generation: rejection cannot supersede
      // the live provider or overwrite its known-good launch metadata.
      this.emitEvent(spec.sessionId, { kind: "error", message: authorization.error });
      durable?.failed(authorization.error, "INVALID_COMMAND");
      reportMaterialized(false);
      return false;
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
        authorization.error,
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
    launchAssertionError?: string,
  ): Promise<boolean> {
    const targetError = executionTargetLaunchError(spec, this.runnerId, this.executionIsolation, this.containerTargets, this.cloudTargets);
    if (targetError) {
      this.emitEvent(spec.sessionId, { kind: "error", message: targetError });
      this.emitStatus(spec.sessionId, "failed", targetError);
      durable?.failed(targetError, "INVALID_COMMAND");
      return false;
    }
    const context = spec.context ?? { kind: "native" as const };
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
    if (closing) {
      await closing.promise;
      if (this.closing.get(spec.sessionId) === closing) {
        const message = "the previous provider process could not be confirmed stopped";
        this.emitEvent(spec.sessionId, { kind: "error", message });
        this.emitStatus(spec.sessionId, "stopped", message);
        durable?.failed(message, "COMMAND_CANCELLED");
        return false;
      }
    }
    const rebinding = this.worktreeRebindings.get(spec.sessionId);
    // Once launch() publishes the replacement entry, an explicit Restart owns cancellation and
    // retirement directly. Waiting for the encompassing rebind promise could deadlock forever on
    // a driver initialization promise that ignores disposal.
    if (rebinding && !this.active.has(spec.sessionId)) await rebinding.promise;
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
      this.rejectQueued(existing.queue, "session restart discarded the queued command");
      existing.queue.length = 0;
      this.emitQueue(spec.sessionId); // a restart discards any queued prompts
      existing.client.dispose({ forceImmediate: true });
      // Keep the durable worktree lease until the provider has been told to terminate. Releasing
      // it first would briefly let a sibling runner clean the provider's still-live cwd.
      this.deleteActiveSession(spec.sessionId, existing);
      this.clearLock(spec.sessionId);
      this.log(`restarting ${spec.sessionId} — replacing existing process`);
    }

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
    let prior = this.store.readMeta(spec.sessionId);
    const driver = spec.driver ?? "acp";
    const executionTarget = spec.executionTarget ?? prior?.executionTarget;
    const priorWorktreePath = prior?.worktreePath;
    const priorContext = prior?.context;
    let shouldUseWorktree = spec.useWorktree || !!priorWorktreePath &&
      !!priorContext && !!prior?.worktrees?.some((item) => sameWorktreePath(priorContext, item.path, priorWorktreePath));
    const carrySlashCommandCatalog = !shouldUseWorktree && canCarrySlashCommandCatalog(prior ?? undefined, {
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
      controlPlaneLaunchId: spec.controlPlaneLaunchId,
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
      worktreeBranch: prior?.worktreeBranch,
      worktrees: prior?.worktrees,
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
      checkpointWorktreeIds: prior?.checkpointWorktreeIds,
      // Sessions (re)started on this build never carry the old add -A residue forward — and the
      // flag stops the startup migration from ever clearing a user's deliberate staging.
      indexReset: true,
      // Worktree setup below is async — block Files/shells root resolution until it lands one
      // way or the other, so a shell can't open in the shared base checkout during the window.
      worktreePending: shouldUseWorktree,
    };
    // create() upserts meta.json (refreshing launch params) but preserves any existing event log,
    // so a restart keeps the timeline while re-spawning a fresh agent.
    await this.runWorktreeOperation(spec.sessionId, async () => {
      // A worktree request may have committed after the launch captured `prior` but before this
      // restart row is written. Merge that exact identity rather than recreating stale launch state.
      const latest = this.store.readMeta(spec.sessionId);
      if (latest) {
        prior = latest;
        shouldUseWorktree = spec.useWorktree || !!latest.worktreePath &&
          !!latest.worktrees?.some((item) => sameWorktreePath(latest.context, item.path, latest.worktreePath!));
        meta.worktreeBranch = latest.worktreeBranch;
        meta.worktrees = latest.worktrees;
        meta.lastTurnBaseTree = latest.lastTurnBaseTree;
        meta.turnCount = latest.turnCount ?? 0;
        meta.forkPoints = latest.forkPoints ?? {};
        meta.checkpointWorktreeIds = latest.checkpointWorktreeIds;
        meta.worktreePending = shouldUseWorktree;
      }
      this.store.create(meta);
    });
    durable?.queued();
    if (launchAssertionError) {
      this.emitEvent(spec.sessionId, { kind: "error", message: launchAssertionError });
      this.emitStatus(spec.sessionId, "failed", launchAssertionError);
      durable?.failed(launchAssertionError, "INVALID_COMMAND");
      return false;
    }
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
    let worktreeIdentity: SessionWorktreeView | undefined;
    let worktreeOwnedByLaunch = false;
    const launchWorktreeCleanup = (): WorktreeCleanupRecord => {
      if (!worktree) throw new Error("worktree cleanup requested before materialization");
      const checkpointOwnerHash = this.checkpointOwnerHash(meta);
      return {
        sessionId: spec.sessionId,
        worktreeId: worktreeIdentity?.id ?? "legacy",
        repoPath,
        worktreePath: worktree.path,
        context,
        branch: worktreeIdentity?.branch ?? worktree.branch,
        ...(checkpointOwnerHash ? { checkpointOwnerHash } : {}),
      };
    };
    if (shouldUseWorktree) {
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
          const activePrior = prior;
          const priorActiveWorktree = activePrior?.worktreePath
            ? activePrior.worktrees?.find((item) =>
              sameWorktreePath(activePrior.context, item.path, activePrior.worktreePath!))
            : undefined;
          if (priorActiveWorktree) {
            worktree = await attachRequestedWorktree(repoPath, spec.sessionId, priorActiveWorktree.path, {
              ...worktreeOptions,
              // This is a runner-persisted exact coordinate, not new caller input. Registration
              // with this repository is still re-proved before launch.
              allowedProjectPaths: [priorActiveWorktree.path],
            });
            if (worktree.branch !== priorActiveWorktree.branch) {
              throw new Error("selected worktree branch changed before the provider could launch");
            }
            worktreeIdentity = priorActiveWorktree;
          } else {
            worktree = await this.createSessionWorktree(repoPath, spec.sessionId, worktreeOptions);
            worktreeIdentity = {
              id: "legacy",
              path: worktree.path,
              branch: worktree.branch,
              source: "legacy",
            };
          }
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
              const cleanup = launchWorktreeCleanup();
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
            if (worktreeOwnedByLaunch || (deleted && worktreeIdentity?.source !== "attached")) {
              const cleanup = launchWorktreeCleanup();
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
      if (worktree && (worktreeOwnedByLaunch || (deleted && worktreeIdentity?.source !== "attached"))) {
        const cleanup = launchWorktreeCleanup();
        this.cleanupJournal.add(cleanup);
        await this.reapWorktree(cleanup, worktreeOwnedByLaunch && !superseded);
      }
      if (priorResumeId && !superseded) this.store.releaseLock(spec.sessionId, this.lockOwner);
      durable?.failed(
        superseded
          ? "session launch was superseded by a replacement"
          : "session launch was cancelled before provider startup",
        "COMMAND_CANCELLED",
      );
      return false;
    }
    // Worktree setup has RESOLVED (created, or one of the in-place fallbacks above) — unblock
    // Files/shells root resolution in the same patch that records the outcome.
    meta.worktreePending = false;
    let launchStateFinalized = false;
    await this.runWorktreeOperation(spec.sessionId, async () => {
      const latest = this.store.readMeta(spec.sessionId);
      if (!latest || !this.launchIsCurrent(spec.sessionId, launchGeneration)) {
        return;
      }
      const materializedWorktree = worktree;
      const materializedIdentity = worktreeIdentity;
      const latestSelection = latest.worktreePath
        ? this.attributedWorktreeForPath(latest, latest.worktreePath)
        : undefined;
      const selectionChanged = !!latestSelection && (!worktree ||
        !sameWorktreePath(latest.context, latestSelection.path, worktree.path));
      if (selectionChanged) {
        // request/attach/select completed while this launch was preparing its prior target. That
        // mutation is authoritative for the provider cwd; retain any separately materialized
        // legacy tree in inventory so session deletion can still reap it.
        worktree = {
          path: latestSelection.path,
          branch: latestSelection.branch,
          created: false,
        };
        worktreeIdentity = latestSelection;
      }

      let worktrees = [...(latest.worktrees ?? [])];
      const mergeIdentity = (identity: SessionWorktreeView | undefined) => {
        if (!identity) return;
        worktrees = worktrees.filter((item) => !sameWorktreePath(latest.context, item.path, identity.path));
        worktrees.push(identity);
      };
      if (selectionChanged && materializedWorktree && materializedIdentity) {
        mergeIdentity({ ...materializedIdentity, path: materializedWorktree.path });
      }
      if (worktreeIdentity?.source !== "legacy") mergeIdentity(worktreeIdentity);

      if (worktree) {
        meta.worktreePath = worktree.path;
        meta.worktreeBranch = worktree.branch;
        meta.worktrees = worktrees;
        this.store.patchMeta(spec.sessionId, {
          worktreePath: worktree.path,
          worktreeBranch: worktree.branch,
          worktrees,
          worktreePending: false,
        });
      } else {
        meta.worktreePath = null;
        meta.worktrees = worktrees;
        this.store.patchMeta(spec.sessionId, { worktrees, worktreePending: false });
      }
      launchStateFinalized = true;
    });
    if (!launchStateFinalized) {
      const superseded = this.launchWasSuperseded(spec.sessionId, launchGeneration);
      const deleted = this.deleted.has(spec.sessionId) || this.deleting.has(spec.sessionId) ||
        this.store.isDeleted(spec.sessionId);
      if (worktree && (worktreeOwnedByLaunch || (deleted && worktreeIdentity?.source !== "attached"))) {
        const cleanup = launchWorktreeCleanup();
        this.cleanupJournal.add(cleanup);
        await this.reapWorktree(cleanup, worktreeOwnedByLaunch && !superseded);
      }
      if (priorResumeId && !superseded) this.store.releaseLock(spec.sessionId, this.lockOwner);
      durable?.failed(
        superseded
          ? "session launch was superseded by a replacement"
          : "session launch was cancelled before provider startup",
        "COMMAND_CANCELLED",
      );
      return false;
    }
    if (worktree) this.emitStatus(spec.sessionId, "starting", undefined, worktree.path);

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
      const authenticationBlocked = this.store.readMeta(spec.sessionId)?.providerAuthBlock;
      if (authenticationBlocked) {
        // Authentication is a recoverable launch state, not failed session construction. Preserve
        // the materialized worktree and retain only ordinary, image-free work whose non-delivery
        // was proven before a provider process existed. Durable commands were already settled by
        // their receipt lane and must never execute later behind a terminal failure receipt.
        if (!durable && authenticationBlocked.delivery === "not_delivered" && initialPrompt &&
            (!initialImages || initialImages.length === 0) && !authenticationBlocked.retry) {
          this.store.patchMeta(spec.sessionId, {
            providerAuthBlock: {
              ...authenticationBlocked,
              retry: { text: initialPrompt, images: [] },
            },
          });
          this.store.flush(spec.sessionId);
        }
        durable?.failed("provider authentication is required", "PROVIDER_AUTHENTICATION_REQUIRED");
        return false;
      }
      // The session never started; if WE just created its worktree, it's garbage — reap it.
      if (worktree && worktreeOwnedByLaunch && !deleted) {
        const cleanup = launchWorktreeCleanup();
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
      ? { path: meta.worktreePath, branch: meta.worktreeBranch ?? `agent/${sessionId}` }
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
      if (!await this.preflightProviderAuthentication(meta, launchGeneration)) return false;
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

    const worktreeLeaseOwner = worktree
      ? `${this.lockOwner}:provider:${launchGeneration}:${randomUUID()}`
      : undefined;
    if (worktreeLeaseOwner && !this.store.acquireWorktreeLease(sessionId, worktreeLeaseOwner)) {
      await this.cancelNewCloudHandoff(meta, hadCloudHandoffBeforeLaunch, "session worktree is active on another runner", launchGeneration);
      this.emitEvent(sessionId, { kind: "error", message: "session worktree is active on another runner" });
      this.emitStatus(sessionId, "idle");
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
        onExit: (code) => this.onDriverExit(sessionId, code, client),
        onBackgroundWork: (update) => {
          // A retiring driver may emit an exit/null callback after a replacement owns the session.
          if (this.active.get(sessionId)?.client !== client) return;
          this.onDriverBackgroundWork(sessionId, update);
        },
        onPromptAccepted: () => {
          const live = this.active.get(sessionId);
          if (live?.client !== client || !live.currentBackgroundJobIds?.length) return;
          live.backgroundPromptAccepted = true;
          this.markBackgroundContinuationAccepted(sessionId, live.currentBackgroundJobIds);
        },
        onSessionEstablished: (providerSessionId) => {
          const live = this.active.get(sessionId);
          if (!live || live.client !== client || live.launchGeneration !== launchGeneration) return;
          if (client.agentSessionId() !== providerSessionId) return;
          this.captureAgentSessionId(sessionId, client);
        },
        onAuthStatus: (status) => {
          if (meta.agentId) this.onAgentAuthUpdate?.(meta.agentId, { status });
        },
        onAuthenticationFailure: () => {
          const live = this.active.get(sessionId);
          if (!live || live.client !== client || live.launchGeneration !== launchGeneration) return;
          this.onProviderAuthenticationFailure(sessionId, meta);
        },
        onSubscriptionUsage: (update) => {
          if (meta.agentId) {
            this.onSubscriptionUsageUpdate?.(meta.agentId, meta.driver, meta.context, update);
          }
        },
        onSteeringAvailability: (available) => {
          const live = this.active.get(sessionId);
          if (!live || live.client !== client || live.launchGeneration !== launchGeneration) return;
          if (live.steeringAvailable === available) return;
          live.steeringAvailable = available;
          const current = this.store.readMeta(sessionId);
          if (current) this.send({ type: "session_runtime_updated", snapshot: this.snapshot(current) });
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
      if (worktreeLeaseOwner) this.store.releaseWorktreeLease(sessionId, worktreeLeaseOwner);
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
      launchGeneration,
      client,
      repoPath: meta.repoPath,
      cwd,
      worktree,
      worktreeLeaseOwner,
      context: meta.context,
      status: "starting",
      providerReady: false,
      running: false,
      queue: [],
      permissionOptionKinds: new Map(),
      ...(meta.providerAuthBlock ? { authenticationBlocked: true } : {}),
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
    // A replacement process inherits the hold its predecessor was under. The marker itself stays
    // until the recovered queue is consumed or the control plane releases it, so a failed
    // initialization cannot strand a still-held recovery queue.
    if (this.recoveryHolds.has(sessionId)) entry.controlPlaneHold = true;
    this.active.set(sessionId, entry);
    this.send({ type: "process_status", sessionId, processStatus: "running", pid: client.pid });

    try {
      await client.initialize();
      if (this.active.get(sessionId) !== entry || !this.store.has(sessionId) ||
          !this.launchIsCurrent(sessionId, launchGeneration)) {
        const deleted = !this.store.has(sessionId);
        client.dispose();
        this.deleteActiveSession(sessionId, entry);
        if (deleted) await this.cancelNewCloudHandoff(meta, hadCloudHandoffBeforeLaunch, "session was deleted during driver initialization", launchGeneration);
        return false;
      }
      await client.newSession(cwd);
      if (this.active.get(sessionId) !== entry || !this.store.has(sessionId) ||
          !this.launchIsCurrent(sessionId, launchGeneration)) {
        const deleted = !this.store.has(sessionId);
        client.dispose();
        this.deleteActiveSession(sessionId, entry);
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
      // id. Claude reports establishment through onSessionEstablished when system/init arrives;
      // runPrompt retains the completed-turn fallback for older or abbreviated provider streams.
    } catch (err) {
      if (!this.launchIsCurrent(sessionId, launchGeneration)) {
        client.dispose();
        this.deleteActiveSession(sessionId, entry);
        await this.cancelNewCloudHandoff(meta, hadCloudHandoffBeforeLaunch, "session launch was cancelled during driver initialization", launchGeneration);
        return false;
      }
      if (entry.historyIntegrityFailure) {
        client.dispose();
        this.deleteActiveSession(sessionId, entry);
        await this.cancelNewCloudHandoff(
          meta,
          hadCloudHandoffBeforeLaunch,
          "session history integrity failed during provider initialization",
          launchGeneration,
        );
        return false;
      }
      if (entry.authenticationBlocked) {
        this.emitTelemetry(meta, {
          metric: "launch",
          outcome: "failure",
          durationMs: Date.now() - launchStarted,
          reason: resumeId ? "process_restart" : "fresh",
        });
        this.emitStatus(sessionId, "input_required", `${providerDisplayName(meta.driver)} authentication is required`);
        client.dispose();
        this.deleteActiveSession(sessionId, entry);
        await this.cancelNewCloudHandoff(meta, hadCloudHandoffBeforeLaunch, "provider authentication is required", launchGeneration);
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
        this.deleteActiveSession(sessionId, entry);
        if (deleted) await this.cancelNewCloudHandoff(meta, hadCloudHandoffBeforeLaunch, "session was deleted while driver initialization failed", launchGeneration);
        return false;
      }
      if (err instanceof CodexAppServerResumeError && err.retryable) {
        this.emitStatus(sessionId, "idle", `${errText(err)} — retry when the other app-server releases the thread`);
      } else {
        this.emitStatus(sessionId, "failed", errText(err));
      }
      client.dispose();
      this.deleteActiveSession(sessionId, entry);
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
    return this.requestedWorktreeIsolation(meta).then((additionalWritableRoots) => this.resolveIsolation(this.executionIsolation, meta.context, {}, {
      driver: meta.driver,
      dataDir: this.stateDir,
      env: meta.env,
      sessionId: meta.sessionId,
      cwd,
      ...(additionalWritableRoots.length ? { additionalWritableRoots } : {}),
      ...(this.runnerOwnerHash ? { ownerHash: this.runnerOwnerHash } : {}),
    }));
  }

  private async requestedWorktreeIsolation(meta: SessionMeta): Promise<string[]> {
    if (this.executionIsolation.mode !== "bwrap" && this.executionIsolation.mode !== "seatbelt") return [];
    return [await requestedWorktreeBoundary(meta.repoPath, meta.sessionId, {
      context: meta.context,
      dataDir: this.dataDir,
      ownerHash: this.runnerOwnerHash,
    }, false)];
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
      this.resumeDeferredWorktreeRebind(sessionId);
    }
  }

  private nextQueueOrdinal(sessionId: string): number {
    const ordinal = this.nextQueueOrdinalBySession.get(sessionId) ?? 1;
    this.nextQueueOrdinalBySession.set(sessionId, ordinal + 1);
    return ordinal;
  }

  private ensureQueueOrdinal(sessionId: string, prompt: Pick<QueuedPrompt, "ordinal">): number {
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
    reservedOrdinal?: number,
    queueBeforeLaunch = false,
    backgroundJobIds?: string[],
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
    const rebindGeneration = this.launchGenerations.get(sessionId);
    // A normal rebind exposes its generation-owned pre-launch FIFO so prompts remain accepted.
    // Stop/cancel deliberately invalidate that generation; until the retiring provider settles,
    // reject a raced prompt instead of resuming alongside it through the generic inactive path.
    const stoppedRebindInProgress = this.worktreeRebindings.has(sessionId) &&
      (rebindGeneration === undefined ||
        this.preLaunchAdmissionGenerations.get(sessionId) !== rebindGeneration);
    const closing = this.closing.get(sessionId);
    const providerCloseBlocksPrompt = !!closing && !closing.acceptPromptsDuringHandoff;
    // A prompt during a file rewind would snapshot (and run the agent over) a half-restored
    // tree — the reentrant store lock can't fence this same-process race, the set does.
    if (
      this.rewinding.has(sessionId) ||
      this.forking.has(sessionId) ||
      this.loggingOut.has(sessionId) ||
      providerCloseBlocksPrompt ||
      this.deleting.has(sessionId) ||
      stoppedRebindInProgress
    ) {
      const operation = this.rewinding.has(sessionId)
        ? "rewind"
        : this.forking.has(sessionId)
          ? "conversation fork"
          : this.loggingOut.has(sessionId)
            ? "agent sign-out"
            : providerCloseBlocksPrompt
              ? "provider session close"
              : this.deleting.has(sessionId)
                ? "session deletion"
                : "worktree rebind shutdown";
      this.emitEvent(sessionId, { kind: "error", message: `a ${operation} is in progress — retry in a moment` });
      if (providerCloseBlocksPrompt || this.deleting.has(sessionId) || stoppedRebindInProgress) {
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

    const persistedMeta = this.store.readMeta(sessionId);
    const durableAuthenticationBlock = !!persistedMeta?.providerAuthBlock;
    const projectedAuthenticationBlock = isProviderAuthenticationBlock(persistedMeta?.pendingApproval);
    if ((durableAuthenticationBlock || projectedAuthenticationBlock) && syntheticRecovery) return false;
    if (durableAuthenticationBlock && this.providerAuthRecovery && !syntheticRecovery) {
      this.emitEvent(sessionId, {
        kind: "stderr",
        text: "Authentication is still blocked. Use Recheck Authentication after signing in in the exact provider context.",
      });
      this.emitStatus(sessionId, "input_required", "Provider authentication is required");
      durable?.failed("provider authentication must be revalidated before retry", "PROVIDER_AUTHENTICATION_REQUIRED");
      return false;
    }
    // Adapters without an exact-context status probe receive the bounded legacy projection only.
    // A successfully admitted new user prompt clears that card at the queue insertion boundary;
    // it never replays the interrupted/uncertain provider turn. Capacity rejection leaves it parked.
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
      if (projectedAuthenticationBlock) this.store.patchMeta(sessionId, { pendingApproval: null });
      durable?.queued();
      this.insertQueuedPrompt(sessionId, recovering, {
        id: durable?.commandId ?? randomUUID(),
        ordinal: reservedOrdinal ?? this.nextQueueOrdinal(sessionId),
        text,
        images,
        slashCommand,
        config: effectiveConfig, durable, syntheticRecovery, backgroundJobIds,
      });
      if (!this.recoveryLaunching.has(sessionId)) {
        setImmediate(() => void this.recoverQueuedAppServer(sessionId).catch((error) =>
          this.log(`queued app-server recovery failed for ${sessionId}: ${errText(error)}`),
        ));
      }
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
        config: effectiveConfig, durable, syntheticRecovery, backgroundJobIds,
      });
      this.preLaunchQueues.set(sessionId, queue);
      this.emitQueue(sessionId);
      return true;
    }
    if (!entry) {
      // Not running in-process — try to RESUME it from the box store (Phase 2).
      const ordinal = reservedOrdinal ?? this.nextQueueOrdinal(sessionId);
      void this.resumeAndPrompt(
        sessionId,
        text,
        images,
        slashCommand,
        effectiveConfig,
        durable,
        syntheticRecovery,
        ordinal,
        queueBeforeLaunch,
        backgroundJobIds,
      ).catch((error) => {
        // resumeAndPrompt handles EXPECTED failures internally (durable.failed / error events). An
        // UNEXPECTED throw (e.g. a JSON.stringify RangeError writing a pathological config) escapes
        // as an unobserved rejection; prompt() has already returned. Surface it as a session error.
        // Reporting is itself wrapped: emitEvent can reach failHistoryIntegrity whose metadata write
        // can throw under the SAME fault, and that secondary throw must not escape this catch.
        try {
          this.log(`resume-and-prompt failed for ${sessionId}: ${errText(error)}`);
          this.emitEvent(sessionId, { kind: "error", message: `resume failed: ${errText(error)}` });
          durable?.failed(`resume failed: ${errText(error)}`, "INVALID_COMMAND");
        } catch (reportError) {
          this.log(`resume failure reporting also failed for ${sessionId}: ${errText(reportError)}`);
        }
      });
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
    if (entry.authenticationBlocked && !syntheticRecovery) entry.authenticationBlocked = false;
    if (projectedAuthenticationBlock) this.store.patchMeta(sessionId, { pendingApproval: null });
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
      id: durable?.commandId ?? randomUUID(),
      ordinal: reservedOrdinal ?? this.nextQueueOrdinal(sessionId),
      text,
      images,
      slashCommand,
      config: effectiveConfig, durable, syntheticRecovery, backgroundJobIds,
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
    if (entry.authenticationBlocked) {
      lifecycle.failed("provider authentication is required", "PROVIDER_AUTHENTICATION_REQUIRED");
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
          !this.queueHeld(entry) && !this.reservedPromotionPrecedesQueue(request.sessionId, entry)) {
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
    if (this.hasPendingAgentInput(entry.sessionId)) {
      return {
        eligible: false,
        reason: "policy_blocked",
        message: "Resolve the pending agent input before steering the active turn.",
      };
    }
    if (entry.cancelRequested || entry.interruptRequested) {
      return {
        eligible: false,
        reason: "policy_blocked",
        message: "Wait for the current stop request to settle before steering.",
      };
    }
    if (this.queueHeld(entry)) {
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
    if (this.hasPendingAgentInput(request.sessionId)) {
      return this.handleDefiniteSteeringFailure(
        operation,
        "policy_blocked",
        "Resolve the pending agent input before steering the active turn.",
      );
    }
    if (entry.currentDurable) return this.handleDefiniteSteeringFailure(operation, "policy_blocked", "automation-owned turns cannot be steered");
    if (entry.cancelRequested || entry.interruptRequested || this.queueHeld(entry)) {
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
    if (this.hasPendingAgentInput(request.sessionId)) {
      return this.handleDefiniteSteeringFailure(
        operation,
        "policy_blocked",
        "Resolve the pending agent input before steering the active turn.",
      );
    }
    if (entry.currentDurable) return this.handleDefiniteSteeringFailure(operation, "policy_blocked", "automation-owned turns cannot be steered");
    if (entry.cancelRequested || entry.interruptRequested || this.queueHeld(entry)) {
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
      if (!this.steerFences(entry).size && (entry.queue.length || entry.pendingWorktreeRebind) &&
          !entry.governanceTripped && !this.queueHeld(entry)) {
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

  private queuedPromptEditEligibility(prompt: QueuedPrompt): { eligible: true } | { eligible: false; message: string } {
    if (prompt.durable) {
      return { eligible: false, message: "Messages controlled by durable delivery cannot be edited until delivery resolves." };
    }
    if (prompt.sessionCommand) {
      return { eligible: false, message: "Provider commands cannot be edited after admission." };
    }
    if (prompt.syntheticRecovery || prompt.backgroundJobIds?.length) {
      return { eligible: false, message: "Runner-managed recovery messages cannot be edited." };
    }
    if (prompt.slashCommand) {
      return { eligible: false, message: "Queued slash commands cannot be edited safely." };
    }
    return { eligible: true };
  }

  private queuedPromptDraft(prompt: QueuedPrompt): QueuedPromptDraft {
    return {
      promptId: prompt.id,
      text: prompt.text,
      images: prompt.images.map((image) => ({ ...image })),
      editRevision: this.queuedPromptEditRevision(prompt),
    };
  }

  private queuedPromptEditRevision(prompt: QueuedPrompt): string {
    return prompt.editRevision ??= createHash("sha256").update(JSON.stringify({
      generation: this.queueEditGeneration,
      id: prompt.id,
      ordinal: prompt.ordinal,
      text: prompt.text,
      images: prompt.images,
    })).digest("hex");
  }

  private queueEditFailure(
    request: ReadQueuedPromptMessage | EditQueuedPromptMessage,
    reason: QueuedPromptEditFailureReason,
    error: string,
  ): ReadQueuedPromptResultMessage | EditQueuedPromptResultMessage {
    const base = {
      requestId: request.requestId,
      sessionId: request.sessionId,
      promptId: request.promptId,
      reason,
      error,
    };
    return request.type === "read_queued_prompt"
      ? { type: "read_queued_prompt_result", ok: false, ...base }
      : { type: "edit_queued_prompt_result", submissionId: request.submissionId, applied: false, ...base };
  }

  readQueuedPrompt(request: ReadQueuedPromptMessage): ReadQueuedPromptResultMessage {
    const entry = this.active.get(request.sessionId);
    if (!entry) {
      return this.queueEditFailure(request, "session_not_found", "The live runner session is unavailable.") as ReadQueuedPromptResultMessage;
    }
    const prompt = entry.queue.find((candidate) => candidate.id === request.promptId);
    if (!prompt) {
      const started = entry.activeTurnId === request.promptId;
      return this.queueEditFailure(
        request,
        started ? "queue_item_started" : "queue_item_absent",
        started ? "The queued message has already started." : "The queued message is no longer in the queue.",
      ) as ReadQueuedPromptResultMessage;
    }
    const eligibility = this.queuedPromptEditEligibility(prompt);
    if (!eligibility.eligible) {
      return this.queueEditFailure(request, "queue_item_immutable", eligibility.message) as ReadQueuedPromptResultMessage;
    }
    return {
      type: "read_queued_prompt_result",
      requestId: request.requestId,
      sessionId: request.sessionId,
      promptId: request.promptId,
      ok: true,
      prompt: this.queuedPromptDraft(prompt),
    };
  }

  editQueuedPrompt(request: EditQueuedPromptMessage): EditQueuedPromptResultMessage {
    const receiptKey = `${request.sessionId}\u0000${request.submissionId}`;
    const requestHash = createHash("sha256").update(JSON.stringify({
      promptId: request.promptId,
      expectedRevision: request.expectedRevision,
      text: request.text,
      // A control-plane retry can externalize identical inline bytes into a fresh artifact ID.
      // Hash immutable content identity so that storage allocation does not defeat idempotency.
      images: request.images.map((image) => isPromptImageReference(image) ? {
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        sha256: image.sha256,
      } : image),
    })).digest("hex");
    const existing = this.queueEditReceipts.get(receiptKey);
    if (existing) {
      if (existing.requestHash === requestHash) return existing.result;
      return this.queueEditFailure(
        request,
        "invalid_content",
        "The edit submission ID was already used for different content.",
      ) as EditQueuedPromptResultMessage;
    }
    const remember = (result: EditQueuedPromptResultMessage): EditQueuedPromptResultMessage => {
      this.queueEditReceipts.set(receiptKey, { requestHash, result });
      if (this.queueEditReceipts.size > 500) {
        const oldest = this.queueEditReceipts.keys().next().value;
        if (oldest !== undefined) this.queueEditReceipts.delete(oldest);
      }
      return result;
    };
    const entry = this.active.get(request.sessionId);
    if (!entry) {
      return this.queueEditFailure(
        request,
        "session_not_found",
        "The live runner session is unavailable.",
      ) as EditQueuedPromptResultMessage;
    }
    const prompt = entry.queue.find((candidate) => candidate.id === request.promptId);
    if (!prompt) {
      const started = entry.activeTurnId === request.promptId;
      return this.queueEditFailure(
        request,
        started ? "queue_item_started" : "queue_item_absent",
        started ? "The queued message has already started." : "The queued message is no longer in the queue.",
      ) as EditQueuedPromptResultMessage;
    }
    const eligibility = this.queuedPromptEditEligibility(prompt);
    if (!eligibility.eligible) {
      return this.queueEditFailure(
        request,
        "queue_item_immutable",
        eligibility.message,
      ) as EditQueuedPromptResultMessage;
    }
    if (!request.expectedRevision || request.expectedRevision !== this.queuedPromptEditRevision(prompt)) {
      return this.queueEditFailure(
        request,
        "queue_item_changed",
        "The queued message changed after editing began.",
      ) as EditQueuedPromptResultMessage;
    }
    const imageValidation = validatePromptImageInputs(request.images);
    if ((!request.text.trim() && request.images.length === 0) || !imageValidation.ok) {
      return this.queueEditFailure(
        request,
        "invalid_content",
        imageValidation.ok ? "A queued message cannot be empty." : (imageValidation.error ?? "Invalid image attachments."),
      ) as EditQueuedPromptResultMessage;
    }
    const otherBytes = entry.queue.reduce((total, candidate) =>
      candidate === prompt ? total : total + queuedPromptBytes(candidate.text, candidate.images), 0);
    if (otherBytes + queuedPromptBytes(request.text, request.images) > MAX_QUEUED_BYTES) {
      return this.queueEditFailure(
        request,
        "queue_capacity_exceeded",
        "The edited queued message exceeds the queue capacity.",
      ) as EditQueuedPromptResultMessage;
    }
    prompt.text = request.text;
    prompt.images = request.images.map((image) => ({ ...image }));
    prompt.editRevision = createHash("sha256").update(JSON.stringify({
      generation: this.queueEditGeneration,
      id: prompt.id,
      previous: request.expectedRevision,
      submissionId: request.submissionId,
      text: prompt.text,
      images: prompt.images,
    })).digest("hex");
    this.emitQueue(request.sessionId);
    return remember({
      type: "edit_queued_prompt_result",
      requestId: request.requestId,
      submissionId: request.submissionId,
      sessionId: request.sessionId,
      promptId: request.promptId,
      applied: true,
      prompt: this.queuedPromptDraft(prompt),
    });
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
        const editEligibility = steeringState
          ? { eligible: false as const, message: "Resolve steering before editing this queued message." }
          : entry
            ? this.queuedPromptEditEligibility(q)
            : { eligible: false as const, message: "Wait for live runner admission before editing." };
        return {
          id: q.id,
          text: q.text.length > 500 ? q.text.slice(0, 500) + "…" : q.text,
          hasImages: q.images.length > 0,
          steerable: eligibility.eligible,
          ...(!eligibility.eligible ? { steerDisabledReason: eligibility.message } : {}),
          ...(steeringState ? { steeringState } : {}),
          liveQueueObserved: true,
          editable: editEligibility.eligible,
          ...(!editEligibility.eligible ? { editDisabledReason: editEligibility.message } : {}),
          editRevision: this.queuedPromptEditRevision(q),
        };
      }),
      ...(entry && this.queueHeld(entry) ? { held: true } : {}),
      ...(entry?.running && entry.activeTurnId ? { activeTurnId: entry.activeTurnId } : {}),
    });
  }

  /** Publish both edges of the interruption hold so clients never infer it from queue contents. */
  /** Either hold keeps queued prompts waiting; they are cleared independently. */
  private queueHeld(entry: ActiveSession): boolean {
    return Boolean(entry.holdQueuedPromptsAfterInterrupt || entry.controlPlaneHold);
  }

  private setControlPlaneHold(sessionId: string, entry: ActiveSession, held: boolean): void {
    if (Boolean(entry.controlPlaneHold) === held) return;
    entry.controlPlaneHold = held;
    this.emitQueue(sessionId);
  }

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
          !entry.running && !entry.governanceTripped && !this.queueHeld(entry)) {
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
    const droppedContinuation = queue.some((prompt) => prompt.backgroundJobIds?.length);
    this.rejectQueued(queue, error);
    this.preLaunchQueues.delete(sessionId);
    this.emitQueue(sessionId);
    // A continuation merged into this admission was dropped with it; its durable jobs are still
    // queued, and dedup suppressed the retry timer while the prompt sat here — re-arm it.
    if (droppedContinuation &&
        this.queuedBackgroundJobIds(this.store.readMeta(sessionId)).length > 0) {
      this.scheduleBackgroundContinuation(sessionId, ORPHAN_RECOVERY_RETRY_MS);
    }
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
    const expectedEntry = this.active.get(sessionId);
    void this.drain(sessionId).catch((error) => {
      try {
        const entry = this.active.get(sessionId);
        const detail = `session queue drain failed: ${errText(error)}`;
        // drain() can finish a pending worktree handoff in its finally before this catch runs. A
        // replacement entry owns a different provider and preserved FIFO; never settle or cancel
        // that newer generation for an exception thrown by the retired entry's drain.
        if (!entry || entry !== expectedEntry || entry.historyIntegrityFailure) {
          this.log(`${detail} (${sessionId}; retired drain)`);
          return;
        }
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
    reservedOrdinal?: number,
    queueBeforeLaunch = false,
    backgroundJobIds?: string[],
  ): Promise<void> {
    const meta = this.store.readMeta(sessionId);
    if (!meta) {
      this.emitEvent(sessionId, { kind: "error", message: "session is not active on this runner" });
      this.emitStatus(sessionId, "failed");
      durable?.failed("session is not active on this runner", "SESSION_NOT_FOUND");
      return;
    }
    if (this.closing.has(sessionId)) {
      durable?.failed("the previous provider process could not be confirmed stopped", "COMMAND_CANCELLED");
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
    if (!established && meta.driver === "claude-code" && meta.seq > 0) {
      this.emitEvent(sessionId, {
        kind: "error",
        message: "this Claude history has no persisted provider conversation id and cannot be continued without risking a replacement conversation",
      });
      this.emitStatus(sessionId, "stopped");
      durable?.failed("Claude history has no resumable provider conversation id", "INVALID_COMMAND");
      return;
    }
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
    if (queueBeforeLaunch) {
      this.preLaunchAdmissionGenerations.set(sessionId, launchGeneration);
      const queue = this.preLaunchQueues.get(sessionId) ?? [];
      this.insertQueuedPrompt(sessionId, queue, {
        id: randomUUID(),
        ordinal: reservedOrdinal ?? this.nextQueueOrdinal(sessionId),
        text,
        images,
        slashCommand,
        config: fresh.config,
        durable,
        syntheticRecovery,
        backgroundJobIds,
      });
      this.preLaunchQueues.set(sessionId, queue);
    }
    const finishPreLaunch = (launched: boolean) => {
      const ownsPreLaunch = this.preLaunchAdmissionGenerations.get(sessionId) === launchGeneration;
      if (ownsPreLaunch) {
        this.preLaunchAdmissionGenerations.delete(sessionId);
      }
      if (!launched && queueBeforeLaunch && ownsPreLaunch) {
        this.rejectPreLaunchQueue(sessionId, "provider authentication retry failed before runner admission");
      }
    };
    if (!(await this.acquireAdmission(sessionId))) {
      const superseded = this.launchWasSuperseded(sessionId, launchGeneration);
      this.finishLaunchGeneration(sessionId, launchGeneration);
      if (superseded) {
        finishPreLaunch(false);
        durable?.failed("session resume was superseded by a replacement", "COMMAND_CANCELLED");
        return;
      }
      if (resumeId) this.store.releaseLock(sessionId, this.lockOwner);
      finishPreLaunch(false);
      durable?.failed("session resume was cancelled before runner admission", "COMMAND_CANCELLED");
      return;
    }
    if (!this.launchIsCurrent(sessionId, launchGeneration)) {
      const superseded = this.launchWasSuperseded(sessionId, launchGeneration);
      this.finishLaunchGeneration(sessionId, launchGeneration);
      if (resumeId && !superseded) this.store.releaseLock(sessionId, this.lockOwner);
      finishPreLaunch(false);
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
      finishPreLaunch(false);
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
      const blocked = this.store.readMeta(sessionId);
      if (blocked?.providerAuthBlock?.delivery === "not_delivered" &&
          blocked.providerAuthRetryAttemptedRecoveryId !== blocked.providerAuthBlock.recoveryId &&
          !blocked.providerAuthBlock.retry && !syntheticRecovery && !durable && images.length === 0) {
        this.store.patchMeta(sessionId, {
          providerAuthBlock: {
            ...blocked.providerAuthBlock,
            retry: {
              ...(reservedOrdinal ? { ordinal: reservedOrdinal } : {}),
              text,
              images: [],
              ...(slashCommand ? { slashCommand } : {}),
              ...(config ? { config } : {}),
            },
          },
        });
        // This payload is the proof that the turn was retained before provider submission.
        this.store.flush(sessionId);
      }
      if (isProviderAuthenticationBlock(blocked?.pendingApproval)) {
        durable?.failed("provider authentication is required", "PROVIDER_AUTHENTICATION_REQUIRED");
      } else {
        durable?.failed("provider session could not be resumed", "INVALID_COMMAND");
      }
      finishPreLaunch(false);
      return;
    }
    if (queueBeforeLaunch) {
      this.activatePreLaunchQueue(sessionId);
      finishPreLaunch(true);
    } else {
      this.prompt(
        sessionId,
        text,
        images,
        slashCommand,
        config,
        durable,
        syntheticRecovery,
        reservedOrdinal,
        false,
        backgroundJobIds,
      );
    }
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
    if (!entry || entry.running || entry.governanceTripped || this.queueHeld(entry) ||
        this.hasPendingApproval(sessionId) || this.steerFences(entry).size ||
        this.reservedPromotionPrecedesQueue(sessionId, entry)) return;
    if (entry.pendingWorktreeRebind) {
      await this.rebindSelectedWorktree(sessionId, entry);
      return;
    }
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
      while (this.active.has(sessionId) && entry.queue.length && !entry.authenticationBlocked &&
          !this.hasPendingApproval(sessionId)) {
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
          entry.currentBackgroundJobIds = undefined;
          entry.backgroundPromptAccepted = undefined;
          entry.backgroundAssistantMessagePersisted = undefined;
          entry.activeTurnId = undefined;
          entry.activeTurnConfig = undefined;
        }
        if (entry.pendingWorktreeRebind) break;
        if (entry.authenticationBlocked) break;
        if (this.steerFences(entry).size) {
          await this.waitForSteeringFences(entry);
          if (this.active.get(sessionId) !== entry) break;
        }
        if (entry.governanceTripped || this.queueHeld(entry)) break;
      }
    } finally {
      entry.running = false;
      entry.activeTurnId = undefined;
      this.emitQueue(sessionId);
      clearInterval(refresh);
      // Restart can install a replacement drain under the same process-wide lock owner before this
      // superseded drain settles. Only the drain whose timer is still current may tear down that
      // generation's refresh interval and lock.
      if (this.lockTimers.get(sessionId) === refresh) {
        this.lockTimers.delete(sessionId);
        this.store.releaseLock(sessionId, this.lockOwner);
      }
      if (
        !entry.historyIntegrityFailure &&
        entry.governanceRearmPending &&
        this.active.get(sessionId) === entry
      ) {
        const pending = entry.governanceRearmPending;
        entry.governanceRearmPending = undefined;
        entry.governanceTripped = pending === "resume" ? undefined : pending;
        this.emitStatus(sessionId, "idle");
        if (!entry.governanceTripped && (entry.queue.length || entry.pendingWorktreeRebind)) {
          setImmediate(() => this.scheduleDrain(sessionId));
        }
      }
      if (entry.pendingWorktreeRebind && this.worktreeRebindCanProceed(sessionId, entry)) {
        await this.rebindSelectedWorktree(sessionId, entry);
      }
    }
  }

  private worktreeRebindCanProceed(sessionId: string, entry: ActiveSession): boolean {
    return !entry.running &&
      this.active.get(sessionId) === entry &&
      !this.rewinding.has(sessionId) &&
      !this.forking.has(sessionId) &&
      !this.loggingOut.has(sessionId) &&
      !this.closing.has(sessionId) &&
      !this.deleting.has(sessionId) &&
      !entry.authenticationBlocked &&
      !entry.historyIntegrityFailure &&
      !entry.governanceTripped &&
      !this.queueHeld(entry) &&
      !this.hasPendingApproval(sessionId) &&
      !this.steerFences(entry).size &&
      !this.reservedPromotionPrecedesQueue(sessionId, entry);
  }

  private resumeDeferredWorktreeRebind(sessionId: string): void {
    const entry = this.active.get(sessionId);
    if (entry?.pendingWorktreeRebind && !entry.running) {
      setImmediate(() => this.scheduleDrain(sessionId));
    }
  }

  /** Retire an idle provider generation and resume its exact conversation in the newly selected
   * worktree. Prompts accepted during the turn or relaunch remain in the pre-launch FIFO. */
  private rebindSelectedWorktree(sessionId: string, entry: ActiveSession): Promise<void> {
    const current = this.worktreeRebindings.get(sessionId);
    if (current) return current.promise;
    let promise: Promise<void>;
    promise = this.performSelectedWorktreeRebind(sessionId, entry).finally(() => {
      if (this.worktreeRebindings.get(sessionId)?.promise === promise) {
        this.worktreeRebindings.delete(sessionId);
      }
    });
    this.worktreeRebindings.set(sessionId, { entry, promise });
    return promise;
  }

  private async performSelectedWorktreeRebind(sessionId: string, entry: ActiveSession): Promise<void> {
    const selectedPath = entry.pendingWorktreeRebind;
    if (!selectedPath || !this.worktreeRebindCanProceed(sessionId, entry)) return;
    const meta = this.store.readMeta(sessionId);
    if (!meta || !meta.worktreePath || !sameWorktreePath(meta.context, meta.worktreePath, selectedPath)) {
      entry.pendingWorktreeRebind = undefined;
      if (entry.queue.length) setImmediate(() => this.scheduleDrain(sessionId));
      return;
    }
    this.captureAgentSessionId(sessionId, entry.client);
    const resumable = this.store.readMeta(sessionId);
    const resumeId = resumable?.agentSessionId ?? undefined;
    // Root-cwd sessions do not create worktree checkpoints, so turnCount remains zero even after
    // provider-visible events. Event sequence is the established resume predicate used by the
    // normal stopped-session path and prevents a failed first conversation from becoming fresh.
    const hasConversation = (resumable?.seq ?? 0) > 0;
    if (!resumable || (!resumeId && hasConversation) || (resumeId && !canResumeSession(resumable))) {
      entry.pendingWorktreeRebind = undefined;
      this.emitEvent(sessionId, {
        kind: "error",
        message: "the selected worktree cannot resume this provider conversation",
      });
      if (entry.queue.length) setImmediate(() => this.scheduleDrain(sessionId));
      return;
    }

    let rebindLockHeld = false;
    if (resumeId) {
      if (!this.store.acquireLock(sessionId, this.lockOwner)) {
        if (!this.emitEvent(sessionId, {
          kind: "error",
          message: "this session is being driven by another dashboard",
        })) return;
        this.emitStatus(sessionId, "idle");
        this.rejectQueued(entry.queue, "session is being driven by another runner process");
        entry.queue.length = 0;
        this.emitQueue(sessionId);
        return;
      }
      rebindLockHeld = true;
    }

    const launchGeneration = this.beginLaunchGeneration(sessionId);
    this.preLaunchAdmissionGenerations.set(sessionId, launchGeneration);
    const queued = entry.queue.splice(0);
    if (queued.length) this.preLaunchQueues.set(sessionId, queued);
    this.deleteActiveSession(sessionId, entry, false);
    this.emitQueue(sessionId);
    let launched = false;
    let preserveRebindLockForQueue = false;
    try {
      try {
        const retirement = this.beginProviderRetirement(sessionId, entry, {
          preserveAdmission: true,
          preserveLock: true,
          acceptPromptsDuringHandoff: true,
        });
        await retirement.promise;
        if (this.closing.get(sessionId) === retirement) {
          throw new Error("provider process retirement is unconfirmed");
        }
      } catch (error) {
        const retirement = this.closing.get(sessionId);
        if (retirement?.client === entry.client) {
          // The handoff will not continue. Keep both fences until this exact client reports exit,
          // then let normal retirement completion release them for an explicit retry.
          retirement.preserveAdmission = false;
          retirement.preserveLock = false;
          retirement.acceptPromptsDuringHandoff = false;
        }
        this.log(`session ${sessionId} provider disposal failed during worktree rebind: ${errText(error)}`);
        this.emitEvent(sessionId, {
          kind: "error",
          message: `provider could not switch to the selected worktree: ${errText(error)}`,
        });
        if (this.launchIsCurrent(sessionId, launchGeneration) &&
            this.store.readMeta(sessionId)?.status !== "stopped") this.emitStatus(sessionId, "idle");
        return;
      }
      const fresh = this.store.readMeta(sessionId);
      if (!fresh || !this.launchIsCurrent(sessionId, launchGeneration)) return;
      const selectedWorktree = fresh.worktreePath
        ? this.attributedWorktreeForPath(fresh, fresh.worktreePath)
        : undefined;
      if (!selectedWorktree) {
        this.emitEvent(sessionId, {
          kind: "error",
          message: "the selected worktree no longer has a durable session identity",
        });
        if (this.launchIsCurrent(sessionId, launchGeneration) &&
            this.store.readMeta(sessionId)?.status !== "stopped") this.emitStatus(sessionId, "idle");
        return;
      }
      let verifiedWorktreePath: string;
      try {
        const verified = await attachRequestedWorktree(fresh.repoPath, sessionId, selectedWorktree.path, {
          context: fresh.context,
          dataDir: this.dataDir,
          ownerHash: this.runnerOwnerHash,
          // This is the exact coordinate persisted by the earlier create/attach operation. Re-prove
          // Git registration and branch identity after retiring the old provider and immediately
          // before the replacement process is allowed to launch.
          allowedProjectPaths: [selectedWorktree.path],
        });
        if (verified.branch !== selectedWorktree.branch) {
          throw new Error("selected worktree branch changed before the provider could launch");
        }
        verifiedWorktreePath = verified.path;
      } catch (error) {
        this.emitEvent(sessionId, {
          kind: "error",
          message: `selected worktree could not be verified before provider launch: ${errText(error)}`,
        });
        if (this.launchIsCurrent(sessionId, launchGeneration) &&
            this.store.readMeta(sessionId)?.status !== "stopped") this.emitStatus(sessionId, "idle");
        return;
      }
      if (!this.launchIsCurrent(sessionId, launchGeneration)) return;
      const rebinding = this.worktreeRebindings.get(sessionId);
      if (rebinding?.entry === entry) {
        rebinding.launchingWorktreePath = verifiedWorktreePath;
      }
      try {
        launched = await this.launch(
          { ...fresh, worktreePath: verifiedWorktreePath }, resumeId, launchGeneration,
        );
      } catch (error) {
        // launch() contains expected preparation/driver failures. This final boundary keeps an
        // unexpected cleanup/reporting exception from rejecting the rebind promise into callers
        // such as delete(), and retires any same-generation entry it published before throwing.
        this.log(`session ${sessionId} provider launch failed during worktree rebind: ${errText(error)}`);
        const failedEntry = this.active.get(sessionId);
        if (failedEntry?.launchGeneration === launchGeneration) {
          this.deleteActiveSession(sessionId, failedEntry, false);
          try {
            const retirement = this.beginProviderRetirement(sessionId, failedEntry);
            await retirement.promise;
            if (this.closing.get(sessionId) === retirement) {
              throw new Error("provider process retirement is unconfirmed");
            }
          } catch (disposeError) {
            this.log(`session ${sessionId} failed replacement disposal: ${errText(disposeError)}`);
          }
        }
        if (this.launchIsCurrent(sessionId, launchGeneration) &&
            this.store.readMeta(sessionId)?.status !== "stopped") {
          try {
            this.emitEvent(sessionId, {
              kind: "error",
              message: `provider could not resume in the selected worktree: ${errText(error)}`,
            });
            this.emitStatus(sessionId, "failed", errText(error));
          } catch (reportError) {
            this.log(`session ${sessionId} worktree rebind failure reporting failed: ${errText(reportError)}`);
          }
        }
        return;
      }
      if (launched) {
        const reboundEntry = this.active.get(sessionId);
        if (this.store.readMeta(sessionId)?.status === "stopped") {
          if (reboundEntry) {
            this.deleteActiveSession(sessionId, reboundEntry, false);
            try {
              const retirement = this.beginProviderRetirement(sessionId, reboundEntry);
              await retirement.promise;
              if (this.closing.get(sessionId) === retirement) {
                throw new Error("provider process retirement is unconfirmed");
              }
            } catch (disposeError) {
              this.log(`session ${sessionId} stopped replacement disposal failed: ${errText(disposeError)}`);
            }
          }
          launched = false;
          return;
        }
        const latestSelection = this.store.readMeta(sessionId)?.worktreePath;
        if (reboundEntry && latestSelection &&
            !sameWorktreePath(reboundEntry.context, reboundEntry.cwd, latestSelection)) {
          // Selection can advance while launch() is preparing the captured target and before the
          // replacement becomes active. Preserve that newest target as another fenced handoff;
          // otherwise durable Files/Git state would point at a different cwd indefinitely.
          reboundEntry.pendingWorktreeRebind = latestSelection;
        }
        const hasQueuedWork = (this.preLaunchQueues.get(sessionId)?.length ?? 0) > 0;
        this.activatePreLaunchQueue(sessionId);
        preserveRebindLockForQueue = hasQueuedWork;
        if (!hasQueuedWork) this.emitStatus(sessionId, "idle");
        if (reboundEntry?.pendingWorktreeRebind) {
          setImmediate(() => this.scheduleDrain(sessionId));
        }
      }
    } finally {
      const superseded = this.launchWasSuperseded(sessionId, launchGeneration);
      const ownsGeneration = this.launchGenerations.get(sessionId) === launchGeneration;
      const retirementPending = this.closing.has(sessionId);
      if (!launched && ownsGeneration && !superseded) {
        this.rejectPreLaunchQueue(
          sessionId,
          this.store.readMeta(sessionId)?.status === "stopped"
            ? "session stopped before the selected-worktree provider resumed"
            : "provider could not resume in the selected worktree",
        );
      }
      if (this.preLaunchAdmissionGenerations.get(sessionId) === launchGeneration) {
        this.preLaunchAdmissionGenerations.delete(sessionId);
      }
      this.finishLaunchGeneration(sessionId, launchGeneration);
      if (!launched && !superseded && !retirementPending) this.releaseAdmissionIfInactive(sessionId);
      else if (!launched && !retirementPending && this.store.readMeta(sessionId)?.status === "stopped") {
        this.releaseAdmissionIfInactive(sessionId);
      }
      if (rebindLockHeld && !preserveRebindLockForQueue && !retirementPending) this.clearLock(sessionId);
    }
  }

  private hasPendingAgentInput(sessionId: string): boolean {
    const meta = this.store.readMeta(sessionId);
    return meta?.status === "input_required" || meta?.pendingApproval != null;
  }

  private hasPendingApproval(sessionId: string): boolean {
    return this.store.readMeta(sessionId)?.pendingApproval != null;
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
      const worktreeId = this.checkpointWorktreeId(meta, entry.worktree.path);
      await withGitExecutionContext(
        entry.context,
        () => anchorForkRef(
          entry.worktree!.path,
          sessionId,
          turn,
          tree,
          this.checkpointOwnerHash(meta),
          worktreeId,
        ),
      );
      // Record the point BEFORE the visible event. A crash between the two leaves no button
      // (safe); event-first would leave a durable button whose required point was lost.
      const eventSeq = this.store.logTailSeq(sessionId) + 1;
      this.store.patchMeta(sessionId, {
        forkPoints: {
          ...(meta.forkPoints ?? {}),
          [String(turn)]: { agentTurnId, tree, baseCommit, eventSeq, worktreeId },
        },
      });
      const event = this.emitEvent(sessionId, { kind: "conversation_checkpoint", turn });
      if (event && event.seq !== eventSeq) {
        const latest = this.store.readMeta(sessionId);
        this.store.patchMeta(sessionId, {
          forkPoints: {
            ...(latest?.forkPoints ?? {}),
            [String(turn)]: { agentTurnId, tree, baseCommit, eventSeq: event.seq, worktreeId },
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
          const checkpointWorktreeIds = { ...(current.checkpointWorktreeIds ?? {}) };
          if (checkpoint.priorWorktreeId === undefined) delete checkpointWorktreeIds[String(checkpoint.turn)];
          else checkpointWorktreeIds[String(checkpoint.turn)] = checkpoint.priorWorktreeId;
          this.store.patchMeta(sessionId, {
            turnCount: checkpoint.priorTurnCount,
            lastTurnBaseTree: checkpoint.priorLastTurnBaseTree,
            checkpointWorktreeIds,
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
        ? anchorTurnRef(
          entry.worktree!.path,
          sessionId,
          checkpoint.turn,
          checkpoint.priorTurnRef!,
          checkpoint.ownerHash,
          checkpoint.worktreeId,
        )
        : deleteTurnRef(
          entry.worktree!.path,
          sessionId,
          checkpoint.turn,
          checkpoint.ownerHash,
          checkpoint.worktreeId,
        ));
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
    const { text, images: imageInputs, slashCommand, durable, syntheticRecovery, backgroundJobIds } = queued;
    // Reserve the continuation generation before the first await. Background lifecycle callbacks
    // can arrive while images/worktree checkpoints are materialized; they must not enqueue a
    // second prompt for the generation already owned by this dequeued turn.
    if (backgroundJobIds?.length) entry.currentBackgroundJobIds = [...backgroundJobIds];
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
          text: backgroundJobIds?.length
            ? "Runner continued after managed background work completed."
            : "Runner resumed orphaned background work automatically.",
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
      const worktreeId = this.checkpointWorktreeId(checkpointMeta, entry.worktree.path);
      this.store.patchMeta(sessionId, {
        lastTurnBaseTree: snap,
        turnCount: turn,
        checkpointWorktreeIds: {
          ...(checkpointMeta.checkpointWorktreeIds ?? {}),
          [String(turn)]: worktreeId,
        },
      });
      // Per-turn CHECKPOINT (T3-style rewind target): anchor the pre-turn tree under a real
      // ref (gc can't prune it, unlike the dangling lastTurnBaseTree) and record it on the
      // timeline so the UI can offer "rewind files to before this turn". Best-effort: a
      // failed anchor only loses the rewind target for this turn.
      if (snap) {
        try {
          await withGitExecutionContext(entry.context, () => anchorTurnRef(
            entry.worktree!.path, sessionId, turn, snap!, checkpointOwnerHash, worktreeId,
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
      const managedJobs = backgroundJobIds?.length
        ? (current?.backgroundJobs ?? []).filter((job) => backgroundJobIds.includes(job.id))
        : [];
      const managedContinuation = managedJobs.length === backgroundJobIds?.length &&
        managedJobs.every((job) => job.continuationQueuedAt && !job.continuationSubmittedAt &&
          !job.assistantResultPersistedAt);
      if ((!current?.orphanedWork && !managedContinuation) || current?.status === "stopped" ||
          (!managedContinuation && current?.orphanedWork?.recoveryAttemptedAt)) {
        this.emitStatus(sessionId, current?.status === "stopped" ? "stopped" : "idle");
        return;
      }
      const submittedAt = Date.now();
      if (managedContinuation) {
        const selected = new Set(backgroundJobIds);
        const attempted = this.store.patchMeta(sessionId, {
          backgroundWorkState: "continuation_pending",
          backgroundJobs: (current?.backgroundJobs ?? []).map((job) => selected.has(job.id)
            ? { ...job, continuationSubmittedAt: submittedAt }
            : job),
        });
        if (!(attempted?.backgroundJobs ?? []).some((job) =>
          selected.has(job.id) && job.continuationSubmittedAt === submittedAt)) {
          this.emitStatus(sessionId, "idle");
          return;
        }
        entry.currentBackgroundJobIds = [...selected];
        entry.backgroundPromptAccepted = false;
        entry.backgroundAssistantMessagePersisted = false;
      } else if (current?.orphanedWork) {
        const attempted = this.store.patchMeta(sessionId, {
          orphanedWork: { ...current.orphanedWork, recoveryAttemptedAt: submittedAt },
        });
        if (!attempted?.orphanedWork?.recoveryAttemptedAt) {
          this.emitStatus(sessionId, "idle");
          return;
        }
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
      if (backgroundJobIds?.length && stop === "refusal" && !entry.backgroundPromptAccepted) {
        this.resetBackgroundContinuationSubmission(sessionId, backgroundJobIds);
        this.scheduleBackgroundContinuation(sessionId, ORPHAN_RECOVERY_RETRY_MS);
      }
      if (syntheticRecovery && stop !== "cancelled" && stop !== "refusal") {
        if (backgroundJobIds?.length) {
          if (entry.backgroundPromptAccepted && entry.backgroundAssistantMessagePersisted) {
            this.finishBackgroundContinuation(sessionId, backgroundJobIds);
          }
        }
        else this.finishOrphanRecovery(sessionId);
      }
      if (stop !== "cancelled" && stop !== "refusal") {
        this.finishParentTurnBackgroundJobs(sessionId, queued.id);
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
      if (entry.authenticationBlocked) {
        this.emitStatus(sessionId, "input_required", "Provider authentication is required");
        const block = this.store.readMeta(sessionId)?.providerAuthBlock;
        if (stop !== "cancelled" && stop !== "refusal") durable?.completed();
        else if (block?.delivery !== "not_delivered") {
          durable?.uncertain("provider authentication failed after submission; delivery or completion is uncertain");
        } else {
          durable?.failed("provider authentication is required", "PROVIDER_AUTHENTICATION_REQUIRED");
        }
        return;
      }
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
      entry.currentBackgroundJobIds = undefined;
    } catch (err) {
      if (backgroundJobIds?.length && !entry.backgroundPromptAccepted) {
        this.resetBackgroundContinuationSubmission(sessionId, backgroundJobIds);
        this.scheduleBackgroundContinuation(sessionId, ORPHAN_RECOVERY_RETRY_MS);
      }
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
      if (entry.authenticationBlocked) {
        this.emitStatus(sessionId, "input_required", "Provider authentication is required");
        durable?.uncertain("provider authentication failed after submission; delivery or completion is uncertain");
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
      const worktreeId = this.checkpointWorktreeId(priorMeta, entry.worktree.path);
      let priorTurnRef: string | null;
      try {
        priorTurnRef = await withGitExecutionContext(
          entry.context,
          () => readTurnRef(
            entry.worktree!.path,
            sessionId,
            turn,
            this.checkpointOwnerHash(priorMeta),
            worktreeId,
          ),
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
        worktreeId,
        priorWorktreeId: priorMeta.checkpointWorktreeIds?.[String(turn)],
        anchored: false,
        accountingApplied: false,
      };
      if (snapshot) {
        try {
          await withGitExecutionContext(
            entry.context,
            () => anchorTurnRef(
              entry.worktree!.path,
              sessionId,
              turn,
              snapshot!,
              this.checkpointOwnerHash(priorMeta),
              worktreeId,
            ),
          );
          checkpoint.anchored = true;
        } catch (error) {
          this.log(`checkpoint anchor failed for ${sessionId} turn ${turn}: ${errText(error)}`);
          try {
            checkpoint.anchored = await withGitExecutionContext(
              entry.context,
              () => readTurnRef(
                entry.worktree!.path,
                sessionId,
                turn,
                checkpoint?.ownerHash,
                worktreeId,
              ),
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
          checkpointWorktreeIds: {
            ...(this.store.readMeta(sessionId)?.checkpointWorktreeIds ?? {}),
            [String(checkpoint.turn)]: checkpoint.worktreeId,
          },
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

      if (entry.authenticationBlocked) {
        this.emitStatus(sessionId, "input_required", "Provider authentication is required");
        const block = this.store.readMeta(sessionId)?.providerAuthBlock;
        if (stop !== "cancelled" && stop !== "refusal") lifecycle.completed();
        else if (block?.delivery !== "not_delivered") {
          lifecycle.uncertain("provider authentication failed after submission; delivery or completion is uncertain");
        } else {
          lifecycle.failed("provider authentication is required", "PROVIDER_AUTHENTICATION_REQUIRED");
        }
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
      if (entry.authenticationBlocked) {
        this.emitStatus(sessionId, "input_required", "Provider authentication is required");
        lifecycle.uncertain("provider authentication failed after submission; delivery or completion is uncertain");
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
    const sourceWorktree = this.attributedWorktreeForPath(source, source.worktreePath);
    if (!sourceWorktree) return { ok: false, error: "the active worktree has no durable session identity" };
    if (point.worktreeId) {
      if (point.worktreeId !== sourceWorktree.id) {
        return { ok: false, error: `turn ${turn} belongs to a different session worktree` };
      }
    } else if (this.attributedWorktrees(source).length !== 1) {
      return { ok: false, error: `turn ${turn} predates worktree identity and cannot be forked after a worktree switch` };
    }
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
        this.resumeDeferredWorktreeRebind(sourceSessionId);
        return { ok: false, error: "provider transcript store is busy on this macOS runner" };
      }
      seatbeltForkAdmission = true;
      if (!this.store.has(sourceSessionId)) {
        this.releaseAdmission(sourceSessionId);
        this.forking.delete(sourceSessionId);
        this.forkingTargets.delete(targetSessionId);
        this.resumeDeferredWorktreeRebind(sourceSessionId);
        return { ok: false, error: "source session was removed while waiting for provider isolation" };
      }
    }
    if (!this.store.acquireLock(sourceSessionId, this.lockOwner)) {
      if (seatbeltForkAdmission) this.releaseAdmission(sourceSessionId);
      this.forking.delete(sourceSessionId);
      this.forkingTargets.delete(targetSessionId);
      this.resumeDeferredWorktreeRebind(sourceSessionId);
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
        worktree!.path, targetSessionId, turn, point.tree, targetCheckpointOwner, "legacy",
      ));
      const now = Date.now();
      const target: SessionMeta = {
        ...source,
        sessionId: targetSessionId,
        title,
        worktreePath: worktree.path,
        worktreeBranch: worktree.branch,
        worktrees: undefined,
        agentSessionId: forkedThreadId,
        status: "idle",
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        preview: null,
        pendingApproval: null,
        providerCredentialScopeId: undefined,
        providerCredentialIdentityId: undefined,
        providerAuthBlock: undefined,
        providerAuthRetryAttemptedRecoveryId: undefined,
        sessionSlashCommands: undefined,
        sessionSlashCommandProvenance: undefined,
        env: {},
        adopted: false,
        providerStateVersion: source.context.kind === "wsl" ? 3 : 2,
        ...(targetCheckpointOwner ? { checkpointRefVersion: 2 as const } : {}),
        lastTurnBaseTree: point.tree,
        turnCount: turn,
        checkpointWorktreeIds: { [String(turn)]: "legacy" },
        // Inherited events are re-sequenced in the child, so the parent's eventSeq is not valid
        // here. The loop below records the child's own checkpoint coordinate.
        forkPoints: { [String(turn)]: { ...point, worktreeId: "legacy", eventSeq: undefined } },
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
        forkPoints: { [String(turn)]: { ...point, worktreeId: "legacy", eventSeq: targetCheckpointSeq } },
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
      this.resumeDeferredWorktreeRebind(sourceSessionId);
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

  /** Persist the control plane's cumulative priced cost and apply the existing hard budget to the
   * active turn. Codex reports token usage without USD, so this acknowledgement is the first
   * authoritative cost the runner can enforce. */
  syncPricedSessionCost(sessionId: string, costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd < 0) return;
    const updated = this.store.patchMeta(sessionId, { costUsd });
    if (!updated) return;
    this.send({ type: "session_runtime_updated", snapshot: this.snapshot(updated) });

    const entry = this.active.get(sessionId);
    const budgetUsd = updated.config.costBudgetUsd;
    if (!entry?.running || entry.governanceTripped || !budgetUsd || costUsd < budgetUsd) return;
    this.tripGovernance(sessionId, entry, updated, "cost_budget");
  }

  /** Apply the next absolute thresholds after a user continues. Held queued prompts resume only
   * after this message, so a mid-turn trip cannot leak work past the approval boundary. */
  rearmGovernance(
    sessionId: string,
    config: { costBudgetUsd?: number | null; maxToolCalls?: number | null },
    holdFor?: "cost_budget" | "max_tool_calls" | "control_plane",
  ): void {
    const meta = this.store.readMeta(sessionId);
    if (!meta) return;
    const costBudgetUsd = config.costBudgetUsd;
    const maxToolCalls = config.maxToolCalls;
    // No live process: whatever the re-arm carries, the hold change applies to what recovery
    // holds for this session, and a release re-enters recovery. Thresholds ride into the queued
    // prompts' configs when the replacement process picks them up.
    if (!this.active.get(sessionId)) {
      // Recovered prompts carry their own configs, so the new thresholds are written into them
      // here; the live-entry loop below never sees the recovery map.
      for (const queued of this.recoveryQueues.get(sessionId) ?? []) {
        const queuedConfig: SessionConfig = { ...(queued.config ?? this.store.readMeta(sessionId)?.config ?? {}) };
        if (costBudgetUsd === null) delete queuedConfig.costBudgetUsd;
        else if (costBudgetUsd !== undefined) queuedConfig.costBudgetUsd = costBudgetUsd;
        if (maxToolCalls === null) delete queuedConfig.maxToolCalls;
        else if (maxToolCalls !== undefined) queuedConfig.maxToolCalls = maxToolCalls;
        queued.config = queuedConfig;
      }
      if (holdFor === "control_plane") this.recoveryHolds.add(sessionId);
      else if (holdFor === undefined && this.recoveryHolds.delete(sessionId) && this.recoveryQueues.has(sessionId)) {
        setImmediate(() => void this.recoverQueuedAppServer(sessionId));
      }
      if (costBudgetUsd === undefined && maxToolCalls === undefined) return;
    }
    // A threshold-free re-arm is a hold change alone (v105 control-plane cards): it must neither
    // be ignored nor touch the per-prompt budgets queued prompts were queued with.
    if (costBudgetUsd === undefined && maxToolCalls === undefined) {
      const entry = this.active.get(sessionId);
      if (!entry) return;
      if (holdFor === "control_plane") {
        this.setControlPlaneHold(sessionId, entry, true);
        if (entry.running && entry.governanceTripped) entry.governanceRearmPending = "resume";
        else if (!entry.running) entry.governanceTripped = undefined;
        return;
      }
      if (holdFor === undefined && (entry.controlPlaneHold || this.recoveryHolds.has(sessionId))) {
        this.recoveryHolds.delete(sessionId);
        this.setControlPlaneHold(sessionId, entry, false);
        if (!entry.running && !entry.governanceTripped && !this.queueHeld(entry) &&
            (entry.queue.length || entry.pendingWorktreeRebind)) this.scheduleDrain(sessionId);
      }
      return;
    }
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
    // A control-plane card holds the queue and nothing else: the live turn keeps running, no
    // governance trip is recorded (a trip would make a later provider failure look like a
    // governance settle), and any earlier hard trip is cleared because the thresholds it
    // enforced have just been re-armed.
    if (holdFor === "control_plane") {
      this.setControlPlaneHold(sessionId, entry, true);
      if (entry.running) {
        if (entry.governanceTripped) entry.governanceRearmPending = "resume";
        return;
      }
      entry.governanceTripped = undefined;
      this.emitStatus(sessionId, "idle");
      return;
    }
    // A threshold re-arm without a hold releases a control-plane hold too: the card it carried
    // was answered by the same Continue that sent the new thresholds.
    if (!holdFor) {
      this.recoveryHolds.delete(sessionId);
      this.setControlPlaneHold(sessionId, entry, false);
    }
    if (entry.running) {
      if (entry.governanceTripped) entry.governanceRearmPending = holdFor ?? "resume";
      else if (holdFor) entry.governanceTripped = holdFor;
      return;
    }
    entry.governanceTripped = holdFor;
    this.emitStatus(sessionId, "idle");
    if (!holdFor && (entry.queue.length || entry.pendingWorktreeRebind)) this.scheduleDrain(sessionId);
  }

  stop(sessionId: string): void {
    this.revokeSessionCommandAuthority(sessionId);
    this.cancelBackgroundContinuationTimer(sessionId);
    this.discardRecovery(sessionId);
    this.cancelApprovalTelemetry(sessionId);
    this.clearSteeringState(sessionId, "session stopped before steering settled");
    const authenticationBlock = this.store.readMeta(sessionId)?.providerAuthBlock;
    if (authenticationBlock?.loginOperationId) {
      this.providerAuthRecovery?.cancel(authenticationBlock.credentialScopeId);
    }
    const entry = this.active.get(sessionId);
    if (!entry) {
      const rebinding = this.worktreeRebindings.get(sessionId);
      if (rebinding) {
        const stopGeneration = this.beginLaunchGeneration(sessionId);
        this.finishLaunchGeneration(sessionId, stopGeneration);
      }
      this.rejectPreLaunchQueue(sessionId, "session stopped before runner admission");
      // The rejection re-arm is for failed admissions; this stop is a lifecycle end, so drop it.
      this.cancelBackgroundContinuationTimer(sessionId);
      this.cancelAdmissionWait(sessionId);
      // Not in-process but may exist in the store — record the stop there too.
      if (this.store.has(sessionId)) {
        this.store.patchMeta(sessionId, {
          status: "stopped",
          backgroundWorkState: undefined,
          backgroundJobs: [],
          pendingBackgroundTaskIds: [],
          orphanedWork: undefined,
          providerAuthBlock: undefined,
          providerAuthRetryAttemptedRecoveryId: undefined,
        });
        this.emitStatus(sessionId, "stopped");
      }
      return;
    }
    this.store.patchMeta(sessionId, {
      status: "stopped",
      backgroundWorkState: undefined,
      backgroundJobs: [],
      pendingBackgroundTaskIds: [],
      orphanedWork: undefined,
      providerAuthBlock: undefined,
      providerAuthRetryAttemptedRecoveryId: undefined,
    });
    // Keep the cross-process cwd proof until the retiring provider has actually been disposed.
    // `closing` supplies the matching in-process fence while the graceful close is pending.
    this.deleteActiveSession(sessionId, entry, false);
    this.rejectQueued(entry.queue, "session stopped before queued command started");
    entry.queue.length = 0;
    this.emitQueue(sessionId); // clear any queued prompts from the dashboard
    this.beginProviderRetirement(sessionId, entry);
    // Worktree is intentionally kept so its diff remains reviewable.
    this.emitStatus(sessionId, "stopped");
  }

  private beginProviderRetirement(
    sessionId: string,
    entry: ActiveSession,
    options: {
      preserveAdmission?: boolean;
      preserveLock?: boolean;
      acceptPromptsDuringHandoff?: boolean;
    } = {},
  ): ProviderRetirement {
    const existing = this.closing.get(sessionId);
    if (existing) {
      if (existing.client !== entry.client) {
        throw new Error("cannot retire a different provider while an earlier retirement is pending");
      }
      return existing;
    }
    const retirement = {
      client: entry.client,
      entry,
      promise: Promise.resolve(),
      preserveAdmission: options.preserveAdmission ?? false,
      preserveLock: options.preserveLock ?? false,
      acceptPromptsDuringHandoff: options.acceptPromptsDuringHandoff ?? false,
    };
    this.closing.set(sessionId, retirement);
    if (!entry.client.close) {
      try {
        entry.client.dispose({ forceImmediate: true });
        this.completeProviderRetirement(sessionId, retirement);
      } catch (error) {
        this.log(`session ${sessionId} provider retirement remains unconfirmed: ${errText(error)}`);
        // Keep `closing` installed as the exact-client fence, but preserve the synchronous Stop
        // result contract so the control plane does not acknowledge an unconfirmed stop as success.
        throw error;
      }
      return retirement;
    }
    retirement.promise = this.closeAndDispose(sessionId, entry.client, true).then(
      () => this.completeProviderRetirement(sessionId, retirement),
      (error) => {
        // No exit proof exists. Retain every ownership boundary until this exact client later
        // reports exit or runner shutdown successfully disposes it.
        this.log(`session ${sessionId} provider retirement remains unconfirmed: ${errText(error)}`);
      },
    );
    return retirement;
  }

  private completeProviderRetirement(
    sessionId: string,
    retirement: ProviderRetirement,
  ): void {
    if (this.closing.get(sessionId) !== retirement) return;
    this.closing.delete(sessionId);
    this.releaseActiveWorktreeLease(retirement.entry);
    if (!retirement.preserveAdmission) this.releaseAdmission(sessionId);
    if (!retirement.preserveLock) this.clearLock(sessionId);
    if (!this.shuttingDown && this.pendingDeletions.delete(sessionId)) {
      setImmediate(() => {
        void this.delete(sessionId).catch((error) => {
          this.log(`deferred deletion retry failed for ${sessionId}: ${errText(error)}`);
        });
      });
    }
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
      const worktreeCleanups: WorktreeCleanupRecord[] = [];
      if (meta) {
        const checkpointOwnerHash = this.checkpointOwnerHash(meta);
        // Attached worktrees remain operator-owned: session deletion only forgets their
        // attribution. Runner-created/legacy worktrees carry destructive ownership proof.
        for (const worktree of this.attributedWorktrees(meta).filter((item) => item.source !== "attached")) {
          const cleanup: WorktreeCleanupRecord = {
            sessionId,
            worktreeId: worktree.id,
            repoPath: meta.repoPath,
            worktreePath: worktree.path,
            context: meta.context,
            branch: worktree.branch,
            ...(checkpointOwnerHash ? { checkpointOwnerHash } : {}),
          };
          this.cleanupJournal.add(cleanup);
          worktreeCleanups.push(cleanup);
        }
      }
      if (meta) {
        this.providerStateCleanupJournal.add({ sessionId, driver: meta.driver, context: meta.context });
      }

      this.beginLaunchGeneration(sessionId);
      this.rejectPreLaunchQueue(sessionId, "session deleted before runner admission");
      this.cancelBackgroundContinuationTimer(sessionId);
      // Deletion is terminal, not a replacement launch. Stale continuations may perform only
      // idempotent lock/admission release; the deletion journal exclusively owns destructive
      // worktree/provider cleanup.
      this.latestLaunchGenerations.delete(sessionId);
      this.cancelAdmissionWait(sessionId);
      const rebinding = this.worktreeRebindings.get(sessionId);
      this.discardRecovery(sessionId);
      this.cancelApprovalTelemetry(sessionId);
      let closing = this.closing.get(sessionId);
      const entry = this.active.get(sessionId);
      if (!closing && !rebinding) this.releaseAdmissionIfInactive(sessionId);
      this.clearSteeringState(sessionId, "session was deleted before steering settled");
      if (entry) {
        this.deleteActiveSession(sessionId, entry, false);
        this.rejectQueued(entry.queue, "session was deleted before queued command started");
        entry.queue.length = 0;
        if (!closing) {
          try {
            closing = this.beginProviderRetirement(sessionId, entry);
          } catch (error) {
            // A no-close driver disposes synchronously. If disposal throws, retain the same pending
            // deletion intent used by the asynchronous-close path before control returns to the
            // event loop, so an eventual exact-client exit automatically resumes cleanup.
            closing = this.closing.get(sessionId);
            if (closing?.client === entry.client) {
              this.pendingDeletions.add(sessionId);
              throw error;
            }
            // A pathological driver may synchronously emit exact exit and then throw from dispose.
            // Retirement is already proven in that case, so continue the journaled deletion.
            this.log(`session ${sessionId} disposal threw after exact exit proof: ${errText(error)}`);
          }
        }
      }
      if (closing) {
        await closing.promise;
        if (this.closing.get(sessionId) === closing) {
          this.pendingDeletions.add(sessionId);
          throw new Error("provider process retirement is unconfirmed; destructive cleanup remains fenced");
        }
      }
      // A replacement published by launch() is already in `entry`; deletion retires it directly
      // above. Do not also wait for the encompassing rebind promise, because a broken driver may
      // leave initialize()/newSession() pending even after its process has been disposed.
      if (rebinding && !entry) {
        await rebinding.promise;
        this.releaseAdmission(sessionId);
      }
      this.clearLock(sessionId);
      // The process-local deletion fence and durable tombstone make lookups fail closed while
      // provider retirement settles. Remove the row only after its exact client has retired so
      // a failed attempt remains retryable with complete cleanup provenance.
      this.store.remove(sessionId);
      // A replacement provider is published in `active` before initialization settles. Deletion
      // captured and retired that exact entry above, so the encompassing rebind promise must no
      // longer retain the session indefinitely when initialize()/newSession() never resolves.
      if (rebinding && entry) this.worktreeRebindings.delete(sessionId);
      this.pendingDeletions.delete(sessionId);
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
      for (const cleanup of worktreeCleanups) await this.reapWorktree(cleanup);
      if (meta) {
        await removeRequestedWorktreeBoundary(meta.repoPath, sessionId, {
          context: meta.context,
          dataDir: this.dataDir,
          ownerHash: this.runnerOwnerHash,
        }).catch((error) => {
          this.log(`requested worktree boundary cleanup for ${boundedSessionIdForLog(sessionId)} needs retry: ${errText(error)}`);
        });
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
      this.removeWorktreeCleanupRecord(record);
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
          branch: record.branch ?? (ownedWslPath
            ? `agent/${this.runnerOwnerHash.slice(0, 16)}/${record.sessionId}`
            : `agent/${record.sessionId}`),
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
      this.removeWorktreeCleanupRecord(record);
      return;
    }
    // Keep cleanup diagnostics bounded and free of repository paths, ref values, and provider
    // errors. The durable journal retains the complete operator-independent retry coordinates.
    const failedPhases = checkpointRefsCleaned
      ? "worktree removal"
      : worktreeRemoved ? "checkpoint ref cleanup" : "checkpoint ref cleanup and worktree removal";
    this.log(`worktree cleanup for ${boundedSessionIdForLog(record.sessionId)} needs retry after ${failedPhases}`);
  }

  private removeWorktreeCleanupRecord(record: Pick<WorktreeCleanupRecord, "sessionId" | "worktreeId">): boolean {
    try {
      this.cleanupJournal.remove(record.sessionId, record.worktreeId ?? "legacy");
      return true;
    } catch {
      // Journal persistence can fail after the external resources were successfully reclaimed.
      // Keep the record for an idempotent retry and contain the failure: startup invokes the
      // reaper fire-and-forget, so rejecting here would otherwise become an unhandled rejection.
      this.log(`worktree cleanup for ${boundedSessionIdForLog(record.sessionId)} needs retry after cleanup journal update`);
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
    if (
      this.rewinding.has(sessionId) ||
      this.loggingOut.has(sessionId) ||
      this.deleting.has(sessionId) ||
      this.closing.has(sessionId) ||
      this.worktreeRebindings.has(sessionId)
    ) return false;
    this.rewinding.add(sessionId);
    return true;
  }

  /** Release a fence taken by fenceRewind when the rewind will NOT run (expiry). */
  releaseRewindFence(sessionId: string): void {
    this.rewinding.delete(sessionId);
    this.resumeDeferredWorktreeRebind(sessionId);
  }

  async rewind(sessionId: string, turn: number, alreadyFenced = false): Promise<{ ok: boolean; error?: string }> {
    const refuseBeforeRewind = (error: string): { ok: false; error: string } => {
      if (alreadyFenced) this.releaseRewindFence(sessionId);
      return { ok: false, error };
    };
    if (this.loggingOut.has(sessionId)) return refuseBeforeRewind("agent sign-out is in progress");
    if (this.deleting.has(sessionId)) return refuseBeforeRewind("session deletion is in progress");
    if (this.closing.has(sessionId)) return refuseBeforeRewind("provider retirement is still in progress");
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
      const activeWorktree = this.attributedWorktreeForPath(meta, root);
      if (!activeWorktree) return { ok: false, error: "the active worktree has no durable session identity" };
      const checkpointWorktreeId = meta.checkpointWorktreeIds?.[String(turn)];
      if (checkpointWorktreeId) {
        if (checkpointWorktreeId !== activeWorktree.id) {
          return { ok: false, error: `turn ${turn} belongs to a different session worktree` };
        }
      } else if (this.attributedWorktrees(meta).length !== 1) {
        return {
          ok: false,
          error: `turn ${turn} predates worktree identity and cannot be restored after a worktree switch`,
        };
      }
      if (!this.store.acquireLock(sessionId, this.lockOwner)) {
        return { ok: false, error: "another runner is driving this session" };
      }
      try {
        const tree = await withGitExecutionContext(meta.context, () => readTurnRef(
          root, sessionId, turn, this.checkpointOwnerHash(meta), checkpointWorktreeId,
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
      this.resumeDeferredWorktreeRebind(sessionId);
    }
  }

  resolvePermission(sessionId: string, requestId: string, optionId: string | null): void {
    if (requestId.startsWith("provider-auth:")) {
      void this.resolveProviderAuthentication(sessionId, requestId, optionId).catch(() => {
        const meta = this.store.readMeta(sessionId);
        if (meta?.providerAuthBlock) {
          this.emitProviderAuthenticationCard(
            meta,
            meta.providerAuthBlock,
            "Authentication recovery failed safely on the runner. No prompt was retried.",
          );
        }
      });
      return;
    }
    const entry = this.active.get(sessionId);
    const delivered = entry ? entry.client.resolvePermission(requestId, optionId) : false;
    if (delivered) {
      const started = this.approvalStarted.get(`${sessionId}:${requestId}`);
      this.approvalStarted.delete(`${sessionId}:${requestId}`);
      const meta = this.store.readMeta(sessionId);
      const trackedOptionKind = this.takePermissionOptionKind(sessionId, requestId, optionId);
      const optionKind = trackedOptionKind ?? (
        meta?.pendingApproval?.requestId === requestId
          ? meta.pendingApproval.options.find((option) => option.optionId === optionId)?.kind
          : undefined
      );
      if (meta && started != null) {
        this.emitTelemetry(meta, {
          metric: "approval",
          outcome:
            optionId == null
              ? "cancelled"
              : optionKind != null
                ? optionKind === "cancel" ? "cancelled" : optionKind.startsWith("allow") ? "allowed" : "denied"
                : optionId === "allow" ? "allowed" : optionId === "deny" ? "denied" : "observed",
          durationMs: Date.now() - started,
        });
      }
      // Record the resolution in the box log (the runner owns the timeline now) and clear the card
      // via accrueMeta, so a hydrating dashboard sees both the decision and an empty approval slot.
      this.emitEvent(sessionId, {
        kind: "permission_resolved",
        requestId,
        optionId,
        resolutionReason: optionId == null || optionKind === "cancel" ? "dismissed" : "submitted",
      });
      return;
    }
    this.approvalStarted.delete(`${sessionId}:${requestId}`);
    this.forgetPermissionOptionKinds(sessionId, requestId);
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

  answerQuestion(sessionId: string, requestId: string, answers: Record<string, string | string[]>, action?: "submit" | "dismiss"): void {
    const entry = this.active.get(sessionId);
    const delivered = entry?.client.answerQuestion ? entry.client.answerQuestion(requestId, answers, action) : false;
    if (delivered) {
      const started = this.approvalStarted.get(`${sessionId}:${requestId}`);
      this.approvalStarted.delete(`${sessionId}:${requestId}`);
      const meta = this.store.readMeta(sessionId);
      if (meta && started != null) {
        this.emitTelemetry(meta, {
          metric: "approval",
          outcome: action === "dismiss" || (action == null && Object.keys(answers).length === 0) ? "cancelled" : "allowed",
          durationMs: Date.now() - started,
        });
      }
      const answered = action !== "dismiss" && (action === "submit" || Object.keys(answers).length > 0);
      this.emitEvent(sessionId, {
        kind: "question_resolved",
        requestId,
        answered,
        resolutionReason: answered ? "submitted" : "dismissed",
      });
      return;
    }
    const recoveredMeta = this.store.readMeta(sessionId);
    const recovered = recoveredMeta?.pendingApproval;
    const recoveredStatus = recoveredMeta?.status ?? "idle";
    if (recovered?.kind === "question" && recovered.requestId === requestId &&
        recovered.recoveryReason === "provider_restart" && action === "dismiss") {
      const statusAfterDismiss = recoveredStatus === "input_required"
        ? "idle"
        : recoveredStatus;
      this.emitEvent(sessionId, {
        kind: "question_resolved",
        requestId,
        answered: false,
        resolutionReason: "dismissed",
      });
      this.emitStatus(sessionId, statusAfterDismiss);
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

  private onExit(sessionId: string, code: number | null, expectedClient: Driver): void {
    const entry = this.active.get(sessionId);
    if (!entry || entry.client !== expectedClient) return;
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
      this.deleteActiveSession(sessionId, entry);
      this.rejectQueued(queued, entry.historyIntegrityFailure);
      return; // never append an exit event or overwrite the latched integrity failure
    }
    if (entry.authenticationBlocked) {
      this.restoreUnsubmittedPromotions(sessionId, entry);
      if (!this.emitEvent(sessionId, { kind: "stderr", text: `agent process exited (code ${code})` })) {
        this.deleteActiveSession(sessionId, entry);
        return;
      }
      const queued = entry.queue.splice(0);
      const hadQueueProjection = queued.length > 0 || this.reservedPromotions(entry).size > 0;
      this.deleteActiveSession(sessionId, entry);
      if (hadQueueProjection) this.emitQueue(sessionId);
      if (queued.length) {
        if (meta?.driver === "codex-app-server" && meta.agentSessionId) {
          this.stabilizeRecoveryQueue(sessionId, queued);
          this.recoveryQueues.set(sessionId, queued);
          if (entry.controlPlaneHold) this.recoveryHolds.add(sessionId);
        } else {
          this.rejectQueued(
            queued,
            "agent exited while authentication was blocked before queued work could start",
          );
        }
      }
      this.emitStatus(sessionId, "input_required", "Provider authentication is required");
      return;
    }
    if (entry.status !== "stopped") {
      this.restoreUnsubmittedPromotions(sessionId, entry);
      // Keep the entry installed until this append completes: if it is the first integrity
      // failure, failHistoryIntegrity must still own/cancel this session and its durable queue.
      if (!this.emitEvent(sessionId, { kind: "stderr", text: `agent process exited (code ${code})` })) {
        this.deleteActiveSession(sessionId, entry);
        return;
      }
      const queued = entry.queue.splice(0);
      // Queued prompts died with the entry — clear the dashboards' queue overlay, or they
      // keep offering cancel buttons for prompts that can never run (cancel would no-op).
      const hadQueueProjection = queued.length > 0 || this.reservedPromotions(entry).size > 0;
      this.deleteActiveSession(sessionId, entry);
      if (hadQueueProjection) this.emitQueue(sessionId);
      if (recoverableAppServer) {
        // A crashed turn may already have reached turn/start, so never replay it. The entries
        // still in queue are provably unsubmitted and can safely continue after a fresh process
        // resumes the same durable thread.
        this.emitStatus(sessionId, "idle", "Codex app-server exited; the next prompt will resume the thread");
        if (queued.length) {
          this.stabilizeRecoveryQueue(sessionId, queued);
          this.recoveryQueues.set(sessionId, queued);
          if (entry.controlPlaneHold) this.recoveryHolds.add(sessionId);
          setImmediate(() => void this.recoverQueuedAppServer(sessionId));
        }
      } else if (code && code !== 0) {
        this.rejectQueued(queued, "agent exited before queued command started");
        this.emitStatus(sessionId, "failed", `agent exited ${code}`);
      } else {
        this.rejectQueued(queued, "agent exited before queued command started");
      }
    } else {
      this.deleteActiveSession(sessionId, entry);
    }
  }

  /** Driver callbacks are third-party process boundaries and must never surface an exception into
   * the driver's event loop. Event-history failures are contained by emitEvent; this guard also
   * prevents an unrelated exit-cleanup failure from becoming a process-wide uncaught exception. */
  private onDriverExit(sessionId: string, code: number | null, expectedClient: Driver): void {
    const closing = this.closing.get(sessionId);
    if (closing?.client === expectedClient) {
      try {
        this.completeProviderRetirement(sessionId, closing);
      } catch (error) {
        this.log(`provider retirement cleanup failed for ${sessionId}: ${errText(error)}`);
      }
      return;
    }
    if (this.active.get(sessionId)?.client !== expectedClient) return;
    this.revokeSessionCommandAuthority(sessionId);
    try {
      this.onExit(sessionId, code, expectedClient);
    } catch (error) {
      this.log(`agent exit cleanup failed for ${sessionId}: ${errText(error)}`);
      const entry = this.active.get(sessionId);
      if (!entry || entry.client !== expectedClient) return;
      const detail = `agent exit cleanup failed: ${errText(error)}`;
      const queued = entry.queue.splice(0);
      this.rejectQueued(queued, detail);
      // runPrompt exclusively owns the dequeued lifecycle. Removing the active entry makes that
      // path terminalize it as uncertain after provider unwind; failing it here would double-settle.
      this.deleteActiveSession(sessionId, entry);
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
    // A control-plane card is still open: the prompts stay parked in the recovery map until the
    // control plane releases the hold, which re-enters here.
    if (this.recoveryHolds.has(sessionId) && !this.active.get(sessionId)) return;
    const alreadyActive = this.active.get(sessionId);
    if (alreadyActive) {
      // A non-recovery entrypoint won the race. Preserve the known-unsubmitted prompts ahead of
      // newer work instead of leaving a stale recovery map that would intercept every prompt.
      for (const prompt of queued) this.insertQueuedPrompt(sessionId, alreadyActive.queue, prompt);
      this.recoveryQueues.delete(sessionId);
      if (this.recoveryHolds.has(sessionId)) {
        this.recoveryHolds.delete(sessionId);
        this.setControlPlaneHold(sessionId, alreadyActive, true);
      }
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
          this.deleteActiveSession(sessionId, recoveryEntry);
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
    this.recoveryHolds.delete(sessionId);
  }

  /** Returns whether every provider driver was disposed cleanly. When false, some provider process
   * may still be alive without a registered pending kill, so the caller MUST retain the provider-home
   * lease (fail closed) — releasing it could let a replacement runner share the same HOME. */
  shutdownAll(): boolean {
    this.shuttingDown = true;
    this.sessionCommandAuthority.clearAll();
    this.launchGenerations.clear();
    this.preLaunchAdmissionGenerations.clear();
    clearInterval(this.providerStateReconcileTimer);
    clearInterval(this.historyMaintenanceTimer);
    clearInterval(this.worktreePullRequestReconcileTimer);
    if (this.historyMaintenanceKickoff) clearTimeout(this.historyMaintenanceKickoff);
    this.historyMaintenanceKickoff = null;
    // Dispose EVERY driver even if one throws: aborting here would leave later drivers' provider
    // processes alive AND unregistered for reaping, so waitForPendingKills would falsely report
    // "reaped" and the caller would release the lease over a live provider. Track clean completion.
    let clean = true;
    for (const entry of this.active.values()) {
      try {
        entry.client.dispose();
      } catch (error) {
        clean = false;
        this.log(`shutdown dispose failed for ${entry.sessionId}: ${errText(error)}`);
        // Its provider may still be alive; leave the session-store lock so no replacement runner
        // adopts the session and writes concurrently.
        continue;
      }
      try {
        this.clearLock(entry.sessionId);
      } catch (error) {
        this.log(`shutdown clearLock failed for ${entry.sessionId}: ${errText(error)}`);
      }
    }
    this.active.clear();
    const shutdownRetirementClients = new Set<Driver>();
    for (const retirement of [...this.closing.values()]) {
      shutdownRetirementClients.add(retirement.client);
      retirement.preserveAdmission = false;
      retirement.preserveLock = false;
      retirement.acceptPromptsDuringHandoff = false;
      try {
        retirement.client.dispose();
        this.completeProviderRetirement(retirement.entry.sessionId, retirement);
      } catch (error) {
        clean = false;
        this.log(`shutdown dispose failed for a closing session: ${errText(error)}`);
      }
    }
    for (const { entry } of this.worktreeRebindings.values()) {
      if (shutdownRetirementClients.has(entry.client)) continue;
      try {
        entry.client.dispose();
      } catch (error) {
        clean = false;
        this.log(`shutdown dispose failed for a rebinding session: ${errText(error)}`);
      }
    }
    this.worktreeRebindings.clear();
    this.pendingDeletions.clear();
    this.deleting.clear();
    this.recoveryQueues.clear();
    this.preLaunchQueues.clear();
    this.recoveryLaunching.clear();
    this.orphanRecoveryLaunching.clear();
    this.backgroundContinuationLaunching.clear();
    this.orphanDiscoveryLaunching.clear();
    if (this.orphanRecoveryScanTimer) clearTimeout(this.orphanRecoveryScanTimer);
    this.orphanRecoveryScanTimer = null;
    for (const timer of this.orphanRecoveryTimers.values()) clearTimeout(timer);
    this.orphanRecoveryTimers.clear();
    for (const timer of this.backgroundContinuationTimers.values()) clearTimeout(timer);
    this.backgroundContinuationTimers.clear();
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
    // seq flush would only self-heal on the next append, and usage totals would be dropped. A flush
    // fault must not abort the return: it does not by itself leave a provider alive, so it is logged
    // rather than folded into `clean` (which gates lease release on provider-liveness only).
    try {
      this.store.flushAll();
    } catch (error) {
      this.log(`shutdown flushAll failed: ${errText(error)}`);
    }
    return clean;
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
    this.send({
      type: "session_status",
      sessionId,
      status,
      detail,
      worktreePath,
      controlPlaneLaunchId: this.store.readMeta(sessionId)?.controlPlaneLaunchId,
    });
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
      this.store.patchMeta(sessionId, {
        status: "failed",
        pendingApproval: null,
        providerAuthBlock: undefined,
      });
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
    this.store.patchMeta(sessionId, { providerAuthBlock: undefined });
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
    const { jobs: backgroundJobs, queuedJobIds } = this.mergeDurableBackgroundJobs(
      current,
      update,
      this.active.get(sessionId)?.activeTurnId,
    );
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
        backgroundWorkState: queuedJobIds.length > 0 ? "continuation_pending" : undefined,
        backgroundJobs,
        pendingBackgroundTaskIds: [],
        recoveredBackgroundTaskIds: durableRecoveredTaskIds,
        orphanedWork: undefined,
      });
    } else if (update.state === "running") {
      updated = this.store.patchMeta(sessionId, {
        backgroundWorkState: queuedJobIds.length > 0 ? "continuation_pending" : "running",
        backgroundJobs,
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
        backgroundWorkState: queuedJobIds.length > 0 ? "continuation_pending" : "orphaned",
        backgroundJobs,
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
        backgroundWorkState: queuedJobIds.length > 0
          ? "continuation_pending"
          : undefined,
        backgroundJobs,
        pendingBackgroundTaskIds: [],
        recoveredBackgroundTaskIds: recovered,
        orphanedWork: undefined,
      });
    }
    if (updated) this.send({ type: "session_runtime_updated", snapshot: this.snapshot(updated) });
    if (queuedJobIds.length > 0) this.scheduleBackgroundContinuation(sessionId);
    if (updated?.orphanedWork && update.state === "orphaned" && automaticClaudeRecoveryAllowed(updated)) {
      this.scheduleOrphanRecovery(sessionId);
    }
  }

  private mergeDurableBackgroundJobs(
    current: SessionMeta,
    update: DriverBackgroundWorkUpdate,
    activeTurnId: string | undefined,
  ): { jobs: DurableBackgroundJob[]; queuedJobIds: string[] } {
    const byId = new Map((current.backgroundJobs ?? []).map((job) => [job.id, { ...job }]));
    const findAlias = (id: string, toolUseId?: string) => byId.get(id) ?? (toolUseId
      ? [...byId.values()].find((job) => job.toolUseId === toolUseId)
      : undefined);
    const register = (job: NonNullable<DriverBackgroundWorkUpdate["jobs"]>[number]) => {
      const prior = findAlias(job.id, job.toolUseId);
      if (prior && prior.id !== job.id) byId.delete(prior.id);
      const outputReference = job.outputFile?.slice(0, MAX_BACKGROUND_OUTPUT_REFERENCE_CHARS);
      byId.set(job.id, {
        ...(prior ?? {
          id: job.id,
          parentTurnId: activeTurnId ?? "unknown",
          runnerId: this.runnerId,
          workspaceId: current.workspaceId,
          context: current.context,
          ...(current.executionTarget ? { executionTarget: current.executionTarget } : {}),
          registeredAt: job.startedAt,
        }),
        id: job.id,
        ...(job.toolUseId ? { toolUseId: job.toolUseId } : {}),
        launchType: job.launchType,
        ...(outputReference ? { outputReference } : {}),
      });
    };
    for (const job of update.jobs ?? []) register(job);

    for (const terminal of update.terminalJobs ?? []) {
      register(terminal);
      const durable = findAlias(terminal.id, terminal.toolUseId);
      if (!durable) continue;
      durable.terminalStatus = terminal.status;
      durable.terminalObservedAt = terminal.terminalAt;
      durable.continuationRequired = terminal.continuationRequired;
    }

    const terminalCandidates = [...byId.values()].filter((job) => job.terminalObservedAt &&
      job.continuationRequired && !job.continuationSubmittedAt && !job.assistantResultPersistedAt);
    const readyParents = new Set(terminalCandidates.map((job) => job.parentTurnId).filter((parentTurnId) =>
      ![...byId.values()].some((job) => job.parentTurnId === parentTurnId &&
        !job.terminalObservedAt && !job.assistantResultPersistedAt)));
    const queuedJobIds = terminalCandidates
      .filter((job) => readyParents.has(job.parentTurnId))
      .map((job) => job.id);
    if (queuedJobIds.length > 0) {
      const queuedAt = Date.now();
      for (const parentTurnId of readyParents) {
        const barrierJobs = queuedJobIds.map((id) => byId.get(id)!)
          .filter((job) => job.parentTurnId === parentTurnId);
        const continuationId = barrierJobs.find((job) => job.continuationId)?.continuationId ??
          `bgcont_${randomUUID()}`;
        for (const job of barrierJobs) {
          job.continuationId = continuationId;
          job.continuationQueuedAt ??= queuedAt;
        }
      }
    }
    const all = [...byId.values()].sort((left, right) => left.registeredAt - right.registeredAt);
    const unresolved = all.filter((job) => !job.assistantResultPersistedAt);
    const deliveredLimit = Math.max(0, MAX_RETAINED_DELIVERED_BACKGROUND_JOBS - unresolved.length);
    const delivered = deliveredLimit === 0
      ? []
      : all.filter((job) => job.assistantResultPersistedAt).slice(-deliveredLimit);
    return { jobs: [...unresolved, ...delivered], queuedJobIds };
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
    if (hasPending && current.backgroundWorkState !== "running" &&
        current.backgroundWorkState !== "continuation_pending") return;
    const updated = this.store.patchMeta(sessionId, hasPending
      ? { pendingBackgroundTaskIds: pending, orphanedWork: undefined }
      : {
          backgroundWorkState: undefined,
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

  private queuedBackgroundJobIds(meta: SessionMeta | null): string[] {
    const queued = (meta?.backgroundJobs ?? [])
      .filter((job) => job.continuationQueuedAt && !job.continuationSubmittedAt &&
        !job.assistantResultPersistedAt)
      .sort((left, right) => left.continuationQueuedAt! - right.continuationQueuedAt!);
    const continuationId = queued[0]?.continuationId;
    if (!continuationId) return [];
    return queued.filter((job) => job.continuationId === continuationId).map((job) => job.id);
  }

  /** Lifecycle rejection (Stop/delete) must also drop any pending continuation timer: a stale
   * timer entry would suppress scheduling for a restarted session's fresh background work. */
  private cancelBackgroundContinuationTimer(sessionId: string): void {
    const timer = this.backgroundContinuationTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.backgroundContinuationTimers.delete(sessionId);
  }

  private scheduleBackgroundContinuation(sessionId: string, delay = 0): void {
    if (this.shuttingDown || this.backgroundContinuationTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.backgroundContinuationTimers.delete(sessionId);
      void this.runBackgroundContinuation(sessionId);
    }, delay);
    timer.unref?.();
    this.backgroundContinuationTimers.set(sessionId, timer);
  }

  private async runBackgroundContinuation(sessionId: string): Promise<void> {
    if (this.shuttingDown || this.backgroundContinuationLaunching.has(sessionId)) return;
    const meta = this.store.readMeta(sessionId);
    const jobIds = this.queuedBackgroundJobIds(meta);
    if (!meta || meta.status === "stopped" || !automaticClaudeRecoveryAllowed(meta) || jobIds.length === 0) return;
    const entry = this.active.get(sessionId);
    if (entry?.currentBackgroundJobIds?.some((id) => jobIds.includes(id)) ||
        entry?.queue.some((prompt) => prompt.backgroundJobIds?.some((id) => jobIds.includes(id))) ||
        this.preLaunchQueues.get(sessionId)?.some((prompt) =>
          prompt.backgroundJobIds?.some((id) => jobIds.includes(id)))) return;
    this.backgroundContinuationLaunching.add(sessionId);
    try {
      const selected = (meta.backgroundJobs ?? []).filter((job) => jobIds.includes(job.id));
      const resultSummary = selected.filter((job) => job.terminalStatus && job.terminalObservedAt).slice(0, 128).map((job) => ({
        id: job.id,
        launchType: job.launchType,
        status: job.terminalStatus!,
        terminalAt: job.terminalObservedAt!,
      }));
      const prompt = `${BACKGROUND_CONTINUATION_PROMPT}\n\nRunner-managed terminal results:\n${JSON.stringify(resultSummary)}`;
      const currentGeneration = this.launchGenerations.get(sessionId);
      const admissionInFlight = !entry && currentGeneration !== undefined &&
        this.preLaunchAdmissionGenerations.get(sessionId) === currentGeneration;
      if (entry || admissionInFlight) {
        // With a launch mid-admission (e.g. a retained authentication retry between clearing the
        // block and reaching the provider), prompt() merges into its pre-launch queue. Calling
        // resumeAndPrompt here instead would begin a competing generation and drop that retry.
        this.prompt(
          sessionId,
          prompt,
          [],
          undefined,
          undefined,
          undefined,
          true,
          undefined,
          false,
          jobIds,
        );
      } else {
        await this.resumeAndPrompt(
          sessionId,
          prompt,
          [],
          undefined,
          undefined,
          undefined,
          true,
          undefined,
          false,
          jobIds,
        );
      }
    } finally {
      this.backgroundContinuationLaunching.delete(sessionId);
      const remaining = this.queuedBackgroundJobIds(this.store.readMeta(sessionId));
      const alreadyQueued = (prompt: { backgroundJobIds?: string[] }) =>
        prompt.backgroundJobIds?.some((id) => remaining.includes(id));
      if (remaining.length > 0 && !this.active.get(sessionId)?.queue.some(alreadyQueued) &&
          !this.preLaunchQueues.get(sessionId)?.some(alreadyQueued)) {
        this.scheduleBackgroundContinuation(sessionId, ORPHAN_RECOVERY_RETRY_MS);
      }
    }
  }

  private markBackgroundContinuationAccepted(sessionId: string, jobIds: string[]): void {
    const current = this.store.readMeta(sessionId);
    if (!current?.backgroundJobs) return;
    const selected = new Set(jobIds);
    const acceptedAt = Date.now();
    let changed = false;
    const backgroundJobs = current.backgroundJobs.map((job) => {
      if (!selected.has(job.id) || job.continuationAcceptedAt || job.assistantResultPersistedAt) return job;
      changed = true;
      return { ...job, continuationAcceptedAt: acceptedAt };
    });
    if (!changed) return;
    const updated = this.store.patchMeta(sessionId, { backgroundJobs, backgroundWorkState: "continuation_pending" });
    if (updated) this.send({ type: "session_runtime_updated", snapshot: this.snapshot(updated) });
  }

  private resetBackgroundContinuationSubmission(sessionId: string, jobIds: string[]): void {
    const current = this.store.readMeta(sessionId);
    if (!current?.backgroundJobs) return;
    const selected = new Set(jobIds);
    const backgroundJobs = current.backgroundJobs.map((job) => selected.has(job.id) &&
      !job.continuationAcceptedAt && !job.assistantResultPersistedAt
      ? { ...job, continuationSubmittedAt: undefined }
      : job);
    const updated = this.store.patchMeta(sessionId, {
      backgroundJobs,
      backgroundWorkState: "continuation_pending",
    });
    if (updated) this.send({ type: "session_runtime_updated", snapshot: this.snapshot(updated) });
  }

  private finishBackgroundContinuation(sessionId: string, jobIds: string[]): void {
    const current = this.store.readMeta(sessionId);
    if (!current?.backgroundJobs) return;
    const selected = new Set(jobIds);
    const continuationId = current.backgroundJobs.find((job) => selected.has(job.id))?.continuationId;
    const parentTurnId = current.backgroundJobs.find((job) => selected.has(job.id))?.parentTurnId;
    if (!continuationId || !parentTurnId) return;
    const peerProtocol = this.controlPlaneProtocolVersion();
    const results = current.backgroundJobs.filter((job) => selected.has(job.id) &&
      job.terminalStatus && job.terminalObservedAt).slice(0, 128).map((job) => ({
        id: job.id,
        launchType: job.launchType,
        status: job.terminalStatus!,
        terminalAt: job.terminalObservedAt!,
      }));
    const deliveryEvent = runnerSupportsProtocol(peerProtocol, "managedBackgroundDelivery")
      ? this.emitEvent(sessionId, {
          kind: "background_continuation_delivered",
          continuationId,
          parentTurnId,
          ...(runnerSupportsProtocol(peerProtocol, "backgroundWorkTracking") ? { results } : {}),
        })
      : this.emitEvent(sessionId, {
          kind: "stderr",
          text: `${BACKGROUND_CONTINUATION_DELIVERED_PREFIX}${continuationId}`,
          runnerMarker: "background_continuation_delivery",
        });
    if (!deliveryEvent) return;
    const persistedAt = Date.now();
    const structuredDeliveryPublishedAt = deliveryEvent.payload.kind === "background_continuation_delivered"
      ? deliveryEvent.ts
      : undefined;
    const backgroundJobs = current.backgroundJobs.map((job) => selected.has(job.id)
      ? {
          ...job,
          continuationAcceptedAt: job.continuationAcceptedAt ?? persistedAt,
          assistantResultPersistedAt: persistedAt,
          ...(structuredDeliveryPublishedAt !== undefined ? { structuredDeliveryPublishedAt } : {}),
        }
      : job);
    const unresolved = backgroundJobs.some((job) => job.continuationRequired &&
      !job.assistantResultPersistedAt);
    const updated = this.store.patchMeta(sessionId, {
      backgroundJobs,
      backgroundWorkState: unresolved ? "continuation_pending" : undefined,
    });
    if (updated) this.send({ type: "session_runtime_updated", snapshot: this.snapshot(updated) });
    if (this.queuedBackgroundJobIds(updated).length > 0) this.scheduleBackgroundContinuation(sessionId);
  }

  /** A legacy peer or a disconnected socket can make the durable delivery proof use the
   * authenticated stderr fallback. Once a v82+ registration succeeds, publish one structured
   * proof per continuation before recording the runner-private publication marker. A crash
   * between those operations can duplicate the event, but control-plane projection is keyed and
   * idempotent; it can never lose the notification or leave a permanent projection watchdog. */
  private upgradeLegacyBackgroundDeliveryEvidence(meta: SessionMeta): void {
    if (!runnerSupportsProtocol(this.controlPlaneProtocolVersion(), "managedBackgroundDelivery") ||
        !meta.backgroundJobs?.some((job) =>
          job.continuationId && job.assistantResultPersistedAt !== undefined &&
          job.structuredDeliveryPublishedAt === undefined)) return;
    const publishedAt = new Map<string, number>();
    for (const job of meta.backgroundJobs) {
      if (!job.continuationId || job.assistantResultPersistedAt === undefined ||
          job.structuredDeliveryPublishedAt !== undefined ||
          publishedAt.has(job.continuationId)) continue;
      const event = this.emitEvent(meta.sessionId, {
        kind: "background_continuation_delivered",
        continuationId: job.continuationId,
        parentTurnId: job.parentTurnId,
      });
      if (event) publishedAt.set(job.continuationId, event.ts);
    }
    if (publishedAt.size === 0) return;
    const current = this.store.readMeta(meta.sessionId);
    if (!current?.backgroundJobs) return;
    const backgroundJobs = current.backgroundJobs.map((job) => {
      const published = job.continuationId ? publishedAt.get(job.continuationId) : undefined;
      return published !== undefined && job.structuredDeliveryPublishedAt === undefined
        ? { ...job, structuredDeliveryPublishedAt: published }
        : job;
    });
    this.store.patchMeta(meta.sessionId, { backgroundJobs });
  }

  private reconcileDeliveredBackgroundContinuations(meta: SessionMeta): SessionMeta {
    if (!meta.backgroundJobs?.some((job) => job.continuationId && !job.assistantResultPersistedAt)) return meta;
    const delivered = new Map<string, number | undefined>();
    for (const event of this.store.readEvents(meta.sessionId)) {
      if (event.payload.kind === "background_continuation_delivered") {
        const existing = delivered.get(event.payload.continuationId);
        delivered.set(
          event.payload.continuationId,
          existing === undefined ? event.ts : Math.min(existing, event.ts),
        );
      } else if (event.payload.kind === "stderr" &&
          event.payload.runnerMarker === "background_continuation_delivery" &&
          event.payload.text.startsWith(BACKGROUND_CONTINUATION_DELIVERED_PREFIX)) {
        const continuationId = event.payload.text.slice(BACKGROUND_CONTINUATION_DELIVERED_PREFIX.length);
        if (!delivered.has(continuationId)) delivered.set(continuationId, undefined);
      }
    }
    if (delivered.size === 0) return meta;
    const persistedAt = Date.now();
    let changed = false;
    const backgroundJobs = meta.backgroundJobs.map((job) => {
      if (!job.continuationId || !delivered.has(job.continuationId) || job.assistantResultPersistedAt) return job;
      const structuredDeliveryPublishedAt = delivered.get(job.continuationId);
      changed = true;
      return {
        ...job,
        continuationAcceptedAt: job.continuationAcceptedAt ?? persistedAt,
        assistantResultPersistedAt: persistedAt,
        ...(structuredDeliveryPublishedAt !== undefined && job.structuredDeliveryPublishedAt === undefined
          ? { structuredDeliveryPublishedAt }
          : {}),
      };
    });
    if (!changed) return meta;
    const unresolved = backgroundJobs.some((job) => job.continuationRequired &&
      !job.assistantResultPersistedAt);
    return this.store.patchMeta(meta.sessionId, {
      backgroundJobs,
      backgroundWorkState: unresolved ? "continuation_pending" : undefined,
    }) ?? meta;
  }

  private finishParentTurnBackgroundJobs(sessionId: string, parentTurnId: string): void {
    const current = this.store.readMeta(sessionId);
    if (!current?.backgroundJobs) return;
    const persistedAt = Date.now();
    let changed = false;
    const backgroundJobs = current.backgroundJobs.map((job) => {
      if ((job.parentTurnId !== parentTurnId && job.parentTurnId !== "unknown") || !job.terminalObservedAt ||
          job.continuationRequired || job.assistantResultPersistedAt) return job;
      changed = true;
      return { ...job, assistantResultPersistedAt: persistedAt };
    });
    if (changed) this.store.patchMeta(sessionId, { backgroundJobs });
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
    if ((entry && this.queueHeld(entry)) || entry?.running || entry?.queue.some((prompt) => prompt.syntheticRecovery)) {
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
    if (entry?.currentBackgroundJobIds?.length && payload.kind === "agent_message" &&
        !payload.parentToolUseId) {
      entry.backgroundAssistantMessagePersisted = true;
    }
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

    this.tripGovernance(sessionId, entry, meta, tripped);
  }

  private tripGovernance(
    sessionId: string,
    entry: ActiveSession,
    meta: SessionMeta,
    tripped: NonNullable<ActiveSession["governanceTripped"]>,
  ): void {
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

  private async preflightProviderAuthentication(meta: SessionMeta, launchGeneration: number): Promise<boolean> {
    const controller = this.providerAuthRecovery;
    const scope = controller?.describe(meta);
    if (!controller || !scope) return true;
    this.store.patchMeta(meta.sessionId, { providerCredentialScopeId: scope.id });
    const observation = await controller.revalidate(meta);
    if (!this.launchIsCurrent(meta.sessionId, launchGeneration)) return false;
    const current = this.store.readMeta(meta.sessionId);
    if (!current) return false;
    if (observation.status === "unauthenticated") {
      if (current.agentId) this.onAgentAuthUpdate?.(current.agentId, { status: "unauthenticated" });
      this.parkProviderAuthentication(current, scope, "launch", "not_delivered");
      return false;
    }
    if (observation.status !== "authenticated") return true;
    const expected = current.providerAuthBlock?.expectedIdentityId ?? current.providerCredentialIdentityId;
    if (expected && observation.identityId && expected !== observation.identityId) {
      this.parkProviderAuthentication(current, scope, "launch", "not_delivered", true);
      return false;
    }
    if (current.providerAuthBlock) {
      // A generic Restart or prompt must not resolve a durable block merely because a probe now
      // succeeds. Only the correlated recovery action can validate account identity, consume the
      // retry token, and clear matching sessions atomically.
      this.emitProviderAuthenticationCard(current, current.providerAuthBlock,
        "Authentication now responds, but this blocked generation still requires Recheck Authentication.");
      return false;
    }
    this.store.patchMeta(meta.sessionId, {
      providerCredentialScopeId: scope.id,
      ...(observation.identityId ? { providerCredentialIdentityId: observation.identityId } : {}),
    });
    if (current.agentId) this.onAgentAuthUpdate?.(current.agentId, { status: "authenticated" });
    return true;
  }

  private providerAuthenticationOptions(
    block: NonNullable<SessionMeta["providerAuthBlock"]>,
    inProgress = false,
  ): Array<{ optionId: string; name: string; description: string; kind: string }> {
    if (inProgress) {
      return [{
        optionId: "auth:cancel",
        name: "Cancel Sign-In",
        description: "Stop only this runner-owned provider sign-in attempt.",
        kind: "reject_once",
      }];
    }
    const options = block.identityMismatch ? [{
      optionId: "auth:accept-current",
      name: "Use Current Account",
      description: "Explicitly accept the newly authenticated account for this session only.",
      kind: "allow_once",
    }] : [];
    if (block.canStartLogin) {
      options.push({
        optionId: "auth:login",
        name: "Start Sign-In",
        description: "Run the provider's login flow in this exact runner context. Output stays on the runner.",
        kind: "allow_once",
      });
    }
    options.push({
      optionId: "auth:revalidate",
      name: "Recheck Authentication",
      description: "Ask the provider in this exact context whether authentication is now valid.",
      kind: "allow_once",
    });
    options.push({
      optionId: "auth:dismiss",
      name: "Dismiss Recovery",
      description: "Discard any retained prompt and make the session promptable without retrying provider work.",
      kind: "reject_once",
    });
    return options;
  }

  private emitProviderAuthenticationCard(
    meta: SessionMeta,
    block: NonNullable<SessionMeta["providerAuthBlock"]>,
    detail?: string,
    inProgress = false,
  ): void {
    const projection = this.providerAuthenticationProjection(meta, block, detail, inProgress);
    const emitted = this.emitEvent(meta.sessionId, {
      kind: "permission_request",
      requestId: projection.requestId,
      title: projection.title,
      options: projection.options,
      purpose: "authentication",
      context: projection.context,
    });
    if (emitted) this.emitStatus(
      meta.sessionId,
      "input_required",
      `${providerDisplayName(meta.driver)} authentication is required`,
    );
  }

  private providerAuthenticationProjection(
    meta: SessionMeta,
    block: NonNullable<SessionMeta["providerAuthBlock"]>,
    detail?: string,
    inProgress = false,
  ): NonNullable<SessionMeta["pendingApproval"]> {
    const provider = providerDisplayName(meta.driver);
    return {
      requestId: providerAuthenticationRequestId(block),
      title: inProgress ? `Signing In — ${provider}` : `Authentication Required — ${provider}`,
      options: this.providerAuthenticationOptions(block, inProgress),
      kind: "authentication",
      context: { toolName: provider, input: providerAuthenticationGuidance(meta, block, detail) },
    };
  }

  private parkProviderAuthentication(
    meta: SessionMeta,
    scope: ProviderCredentialScope,
    phase: "launch" | "turn",
    delivery: "not_delivered" | "uncertain",
    identityMismatch = false,
  ): void {
    const prior = meta.providerAuthBlock?.credentialScopeId === scope.id ? meta.providerAuthBlock : undefined;
    const block: NonNullable<SessionMeta["providerAuthBlock"]> = {
      version: 1,
      recoveryId: prior?.recoveryId ?? randomUUID(),
      credentialScopeId: scope.id,
      detectedAt: prior?.detectedAt ?? Date.now(),
      phase: prior?.phase === "turn" ? "turn" : phase,
      delivery: prior?.delivery === "uncertain" ? "uncertain" : delivery,
      canStartLogin: scope.canStartLogin,
      configuredCredential: scope.configuredCredential,
      ...(prior?.expectedIdentityId ?? meta.providerCredentialIdentityId
        ? { expectedIdentityId: prior?.expectedIdentityId ?? meta.providerCredentialIdentityId }
        : {}),
      ...(prior?.retry ? { retry: prior.retry } : {}),
      ...(identityMismatch || prior?.identityMismatch ? { identityMismatch: true } : {}),
    };
    this.store.patchMeta(meta.sessionId, {
      providerCredentialScopeId: scope.id,
      providerAuthBlock: block,
    });
    this.store.flush(meta.sessionId);
    this.emitProviderAuthenticationCard(meta, block);
  }

  private onProviderAuthenticationFailure(sessionId: string, launchMeta: SessionMeta): void {
    const entry = this.active.get(sessionId);
    const meta = this.store.readMeta(sessionId);
    if (!entry || !meta || entry.authenticationBlocked || entry.historyIntegrityFailure) return;
    entry.authenticationBlocked = true;
    if (meta.agentId) this.onAgentAuthUpdate?.(meta.agentId, { status: "unauthenticated" });
    const scope = this.providerAuthRecovery?.describe(launchMeta);
    if (scope) {
      this.parkProviderAuthentication(
        meta,
        scope,
        entry.providerReady ? "turn" : "launch",
        entry.providerReady ? "uncertain" : "not_delivered",
      );
    } else {
      const provider = providerDisplayName(meta.driver);
      const guidance = providerAuthenticationGuidance(meta);
      const emitted = this.emitEvent(sessionId, {
        kind: "permission_request",
        requestId: `provider-auth:${randomUUID()}`,
        title: `Authentication Required — ${provider}`,
        options: [{
          optionId: "auth:dismiss",
          name: "Dismiss Recovery",
          description: "Dismiss this unsupported recovery card without retrying provider work.",
          kind: "reject_once",
        }],
        purpose: "authentication",
        context: { toolName: provider, input: guidance },
      });
      if (emitted) this.emitStatus(sessionId, "input_required", `${provider} authentication is required`);
    }
    try {
      entry.client.cancel();
    } catch (error) {
      this.log(`provider authentication cancellation failed for ${sessionId}: ${errText(error)}`);
    }
  }

  private async waitForAuthenticationTurnSettlement(sessionId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!this.active.get(sessionId)?.running) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return !this.active.get(sessionId)?.running;
  }

  private async resolveProviderAuthentication(
    sessionId: string,
    requestId: string,
    optionId: string | null,
  ): Promise<void> {
    let meta = this.store.readMeta(sessionId);
    let block = meta?.providerAuthBlock;
    if (!meta || meta.pendingApproval?.requestId !== requestId ||
        meta.pendingApproval.kind !== "authentication") return;
    if (optionId === "auth:dismiss") {
      if (!await this.waitForAuthenticationTurnSettlement(sessionId)) {
        this.emitEvent(sessionId, {
          kind: "stderr",
          text: "The provider turn is still settling. Dismiss Recovery again in a moment.",
        });
        this.emitStatus(sessionId, "input_required", "Provider authentication recovery is still settling");
        return;
      }
      if (block?.loginOperationId) this.providerAuthRecovery?.cancel(block.credentialScopeId);
      const current = this.store.readMeta(sessionId);
      if (!current || current.pendingApproval?.requestId !== requestId) return;
      const retainedPrompt = !!current.providerAuthBlock?.retry;
      this.store.patchMeta(sessionId, {
        providerAuthBlock: undefined,
        pendingApproval: null,
        ...(current.status === "stopped" ? {} : { status: "idle" as const }),
      });
      this.store.flush(sessionId);
      const entry = this.active.get(sessionId);
      if (entry) entry.authenticationBlocked = false;
      this.emitEvent(sessionId, {
        kind: "permission_resolved",
        requestId,
        optionId: "auth:dismiss",
      });
      if (retainedPrompt) {
        this.emitEvent(sessionId, {
          kind: "stderr",
          text: "Authentication recovery was dismissed. The retained prompt was not retried; submit it again if needed.",
        });
      }
      this.emitStatus(sessionId, current.status === "stopped" ? "stopped" : "idle");
      return;
    }
    const controller = this.providerAuthRecovery;
    if (!controller || !block || requestId !== providerAuthenticationRequestId(block)) return;
    if (optionId === "auth:cancel" || optionId === null) {
      controller.cancel(block.credentialScopeId);
      this.emitProviderAuthenticationCard(meta, block, "The runner-owned sign-in was cancelled. No prompt was retried.");
      return;
    }
    if (!["auth:login", "auth:revalidate", "auth:accept-current"].includes(optionId) ||
        this.providerAuthOperations.has(block.credentialScopeId)) {
      this.emitProviderAuthenticationCard(meta, block, "An authentication operation is already in progress for this credential scope.");
      return;
    }
    this.providerAuthOperations.add(block.credentialScopeId);
    try {
      await this.prepareLaunch?.(meta);
      const currentScope = controller.describe(meta);
      if (!currentScope || currentScope.id !== block.credentialScopeId) {
        this.emitProviderAuthenticationCard(meta, block, "The provider installation or credential context changed. Start recovery from the current session card.");
        return;
      }
      if (optionId === "auth:login") {
        block = { ...block, loginOperationId: randomUUID() };
        this.store.patchMeta(sessionId, { providerAuthBlock: block });
        this.emitProviderAuthenticationCard(meta, block, "The provider owns this sign-in flow; authentication output remains on the runner.", true);
        const login = await controller.startLogin(meta);
        if (login !== "completed") {
          block = { ...block, loginOperationId: undefined };
          this.store.patchMeta(sessionId, { providerAuthBlock: block });
          this.emitProviderAuthenticationCard(meta, block, login === "cancelled"
            ? "The runner-owned sign-in was cancelled."
            : "The provider-native sign-in did not complete. Use the exact-context terminal command, then recheck.");
          return;
        }
      }
      const observation = await controller.revalidate(meta);
      if (observation.status !== "authenticated") {
        this.emitProviderAuthenticationCard(meta, block, observation.status === "unauthenticated"
          ? "The provider still reports that this credential scope is unauthenticated."
          : "The provider could not prove authentication in this credential scope.");
        return;
      }
      const expected = block.expectedIdentityId;
      const acceptingCurrent = optionId === "auth:accept-current";
      if (!acceptingCurrent && (!expected || !observation.identityId || expected !== observation.identityId)) {
        block = { ...block, identityMismatch: true };
        this.store.patchMeta(sessionId, { providerAuthBlock: block });
        this.emitProviderAuthenticationCard(meta, block, expected && observation.identityId
          ? "A different provider account is authenticated. Confirm it explicitly for this session or sign in to the original account."
          : "The provider could not prove the original account identity. Confirm the current account explicitly for this session.");
        return;
      }
      if (!await this.waitForAuthenticationTurnSettlement(sessionId)) {
        this.emitProviderAuthenticationCard(meta, block, "The cancelled provider turn is still settling. Recheck in a moment.");
        return;
      }
      await this.completeProviderAuthentication(
        sessionId,
        block,
        observation,
        acceptingCurrent,
      );
    } finally {
      this.providerAuthOperations.delete(block.credentialScopeId);
    }
  }

  private async completeProviderAuthentication(
    targetSessionId: string,
    targetBlock: NonNullable<SessionMeta["providerAuthBlock"]>,
    observation: ProviderAuthObservation,
    targetOnly: boolean,
  ): Promise<void> {
    const candidates = targetOnly
      ? this.store.listSessions().filter((meta) => meta.sessionId === targetSessionId)
      : this.store.listSessions().filter((meta) =>
          meta.providerAuthBlock?.credentialScopeId === targetBlock.credentialScopeId &&
          meta.providerAuthBlock.expectedIdentityId === observation.identityId);
    for (const candidate of candidates) {
      let meta = this.store.readMeta(candidate.sessionId);
      if (!meta) continue;
      let block = meta.providerAuthBlock;
      if (!block) continue;
      if (meta.status === "stopped") {
        this.store.patchMeta(meta.sessionId, {
          providerAuthBlock: undefined,
          pendingApproval: null,
        });
        continue;
      }
      if (meta.sessionId !== targetSessionId) {
        await this.prepareLaunch?.(meta);
        const currentScope = this.providerAuthRecovery?.describe(meta);
        if (!currentScope || currentScope.id !== block.credentialScopeId) continue;
        if (!await this.waitForAuthenticationTurnSettlement(meta.sessionId)) continue;
        const current = this.store.readMeta(meta.sessionId);
        if (!current || current.status === "stopped" ||
            current.providerAuthBlock?.recoveryId !== block.recoveryId) {
          if (current?.status === "stopped" && current.providerAuthBlock) {
            this.store.patchMeta(current.sessionId, {
              providerAuthBlock: undefined,
              pendingApproval: null,
            });
          }
          continue;
        }
        meta = current;
        block = current.providerAuthBlock;
      }
      const retry = block.delivery === "not_delivered" && block.retry &&
        meta.providerAuthRetryAttemptedRecoveryId !== block.recoveryId
        ? block.retry
        : undefined;
      // A persisted retry can carry an ordinal greater than this process's fresh in-memory
      // high-water. Observe it before clearing the durable block: once prompts are admitted again,
      // every newer prompt must sort after the retained pre-crash work even if it races this
      // recovery continuation.
      if (retry) this.ensureQueueOrdinal(meta.sessionId, retry);
      this.store.patchMeta(meta.sessionId, {
        providerCredentialScopeId: block.credentialScopeId,
        ...(observation.identityId ? { providerCredentialIdentityId: observation.identityId } : {}),
        providerAuthBlock: undefined,
        pendingApproval: null,
        status: "idle",
        ...(retry ? { providerAuthRetryAttemptedRecoveryId: block.recoveryId } : {}),
      });
      // Persist the one-shot tombstone before the recovered prompt can reach a provider.
      if (retry) this.store.flush(meta.sessionId);
      const entry = this.active.get(meta.sessionId);
      if (entry) entry.authenticationBlocked = false;
      if (meta.agentId) this.onAgentAuthUpdate?.(meta.agentId, { status: "authenticated" });
      this.emitEvent(meta.sessionId, {
        kind: "permission_resolved",
        requestId: providerAuthenticationRequestId(block),
        optionId: retry ? "auth:automatic-retry" : "auth:revalidated",
      });
      if (retry) {
        // Admit the retained prompt synchronously after its tombstone is durable. The provider
        // launch remains asynchronous, but no newer prompt can win the admission boundary between
        // clearing the block and restoring the older FIFO item.
        this.prompt(
          meta.sessionId,
          retry.text,
          retry.images,
          retry.slashCommand,
          retry.config,
          undefined,
          false,
          retry.ordinal,
          true,
        );
      } else {
        if (block.delivery === "uncertain") {
          this.emitEvent(meta.sessionId, {
            kind: "stderr",
            text: "Authentication was restored, but the interrupted prompt was not retried because provider delivery was uncertain.",
          });
        }
        this.emitStatus(meta.sessionId, "idle");
        if (this.recoveryQueues.has(meta.sessionId)) {
          setImmediate(() => void this.recoverQueuedAppServer(meta.sessionId));
        } else if (entry?.queue.length) {
          this.scheduleDrain(meta.sessionId);
        }
      }
    }
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

  private rememberPermissionOptionKinds(
    sessionId: string,
    requestId: string,
    options: Extract<SessionEventPayload, { kind: "permission_request" }>["options"],
  ): void {
    const entry = this.active.get(sessionId);
    if (!entry) return;
    entry.permissionOptionKinds ??= new Map();
    entry.permissionOptionKinds.set(requestId, new Map(
      options.flatMap((option) => option.kind == null ? [] : [[option.optionId, option.kind]]),
    ));
  }

  private takePermissionOptionKind(
    sessionId: string,
    requestId: string,
    optionId: string | null,
  ): string | undefined {
    const kind = optionId == null
      ? undefined
      : this.active.get(sessionId)?.permissionOptionKinds?.get(requestId)?.get(optionId);
    this.forgetPermissionOptionKinds(sessionId, requestId);
    return kind;
  }

  private forgetPermissionOptionKinds(sessionId: string, requestId: string): void {
    this.active.get(sessionId)?.permissionOptionKinds?.delete(requestId);
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
      if (trackApprovalLatency) {
        this.approvalStarted.set(`${sessionId}:${payload.requestId}`, Date.now());
        this.rememberPermissionOptionKinds(sessionId, payload.requestId, payload.options);
      }
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
      if (payload.kind === "permission_resolved") {
        this.forgetPermissionOptionKinds(sessionId, payload.requestId);
      }
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

function isProviderAuthenticationBlock(pending: SessionMeta["pendingApproval"] | undefined): boolean {
  return pending?.kind === "authentication" && pending.requestId.startsWith("provider-auth:");
}

function providerAuthenticationRequestId(block: NonNullable<SessionMeta["providerAuthBlock"]>): string {
  return `provider-auth:${block.recoveryId}${block.loginOperationId ? `:${block.loginOperationId}` : ""}`;
}

function providerDisplayName(driver: AgentDriverKind): string {
  if (driver === "claude-code") return "Claude Code";
  if (driver === "codex" || driver === "codex-app-server") return "Codex";
  return "Agent Provider";
}

function providerAuthenticationGuidance(
  meta: SessionMeta,
  block?: NonNullable<SessionMeta["providerAuthBlock"]>,
  detail?: string,
): string {
  const provider = providerDisplayName(meta.driver);
  const login = meta.driver === "claude-code"
    ? "claude auth login"
    : meta.driver === "codex" || meta.driver === "codex-app-server"
      ? "codex login"
      : "the provider-specific login command";
  const machine = meta.executionTarget
    ? `${meta.executionTarget.adapter} target ${meta.executionTarget.id}`
    : meta.context.kind === "wsl"
      ? `WSL distribution ${meta.context.distro}`
      : "this native runner";
  return [
    `Provider: ${provider}`,
    `Machine: ${machine}`,
    `Location: ${meta.context.kind === "wsl" ? "the provider credential home inside this WSL distribution" : "the provider credential home on this runner"}`,
    block?.configuredCredential
      ? "This session uses credentials from runner configuration. Update that configuration in this exact context, then recheck authentication."
      : block?.canStartLogin
        ? `Run \`${login}\` in that exact context, or use Start Sign-In, then recheck authentication.`
        : `Run \`${login}\` in that exact context, then recheck authentication. In-app sign-in remains disabled until the runner can acquire the shared provider-home ownership lease.`,
    block?.delivery === "uncertain"
      ? "The interrupted prompt will not be retried automatically because provider delivery was uncertain."
      : block?.retry
        ? "The retained prompt is eligible for one automatic retry after the original account is revalidated."
        : "No provider prompt will be sent until authentication is revalidated.",
    ...(detail ? [detail] : []),
  ].join("\n");
}

function boundedSessionIdForLog(sessionId: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId) ? sessionId : "<invalid-session>";
}
