/**
 * Phase 2: the box's on-disk session store — the SOURCE OF TRUTH for sessions. Lives at
 * `<dataDir>/sessions/<sessionId>/` inside the runner-owned data root. Runner startup exclusively
 * leases that root, so another runner process cannot read or mutate this store concurrently.
 *
 *   <sessionId>/meta.json      session metadata incl. the resumable agent-session-id + seq high-water
 *   <sessionId>/events.ndjson  initial append-only event log (or legacy-writer directory fence)
 *   <sessionId>/events.manifest.json + events.{segment,active}.*.ndjson after lossless compaction
 *   <sessionId>/lock           per-session writer lock (owner; mtime = last refresh) so only one
 *                              process drives a turn at a time; <sessionId>/lock.guard serializes
 *                              changes to an existing lock across processes (see acquireLock)
 */

import {
  type Dirent,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  statSync,
  renameSync,
  rmSync,
  openSync,
  readSync,
  closeSync,
  fsyncSync,
  fstatSync,
  futimesSync,
  linkSync,
  lstatSync,
  truncateSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { open, rename, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { TextDecoder } from "node:util";
import {
  PROTOCOL_VERSION,
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  runnerSupportsProtocol,
  projectSessionEventPayloadForProtocol,
  sessionEventWireProjectionRequiredForProtocol,
  sessionEventWireProjectionVariant,
  SESSION_EVENT_WIRE_EPOCH_FORMAT_OFFSET,
  SESSION_EVENT_WIRE_PROJECTION_VARIANTS,
} from "@wollipog/protocol";
import type {
  AgentCapabilities,
  AgentSlashCommand,
  UnsupportedSlashCommand,
  AcpRuntimeCapabilities,
  AgentContext,
  BackgroundJobStopActor,
  AgentDriverKind,
  ManagedBackgroundJobEnd,
  ManagedBackgroundJobEndReason,
  BackgroundWorkState,
  ExecutionHandoffReceipt,
  ExecutionHandoffRequest,
  ExecutionTargetRef,
  PendingApproval,
  PromptImageInput,
  ProviderAccountSwitchFailureView,
  ProviderHistoryQuarantineView,
  ProviderHistoryRecoveryMode,
  RunnerCapacityBlocker,
  SessionConfig,
  AcpSessionContextConfig,
  SessionEventPayload,
  SessionHistoryPageErrorCode,
  SessionCapabilityOverlay,
  SessionSnapshot,
  SessionStatus,
  SessionTitleSource,
  SessionWorktreeView,
  WorktreeRecoveryView,
} from "@wollipog/protocol";
import type { WorktreeHookSnapshot } from "./worktree-setup.js";
import { SESSION_COMMAND_AUTHORITY_PROTOCOL_VERSION } from "./session-command-authority.js";

/** A session's persisted metadata (superset of the protocol SessionSnapshot with runner-only fields). */
export interface SessionMeta {
  /** A deliberate fresh handoff may have boundary events before its first provider launch. */
  handoffPending?: boolean;
  sessionId: string;
  /** Opaque control-plane identity of the start command that created or replaced this runtime. */
  controlPlaneLaunchId?: string;
  /** Human-correlated two-phase role change. Retiring/prepared fence every provider submission. */
  roleConversion?: {
    command: import("@wollipog/protocol").PrepareSessionRoleMessage;
    state: "retiring" | "prepared" | "applied";
    /** A restarted runner must not mistake an unconfirmed old provider for a retired one. */
    runnerPid?: number;
    /** Instance nonce: PIDs can be reused after runner replacement. */
    runnerOwner?: string;
    providerPid?: number | null;
  };
  agentId: string | null;
  /** Opaque account identity projected to the control plane. */
  providerAccountId?: string;
  providerAccountLabel?: string;
  /** Runner-private binding captured once so config edits cannot redirect a durable session. */
  providerAccountProvider?: "claude" | "codex";
  providerCredentialHome?: string;
  /** Runner-private source of provider history until a credential-home transfer completes. */
  providerConversationHome?: string;
  /** A freshly allocated Codex app-server id that has never accepted provider-visible activity.
   * Imported/forked history is never marked unused merely because its local event log is empty. */
  providerUnstartedThreadId?: string;
  /** Durable runner-private handoff target. The current binding remains authoritative until the
   * replacement provider has resumed successfully. */
  pendingProviderAccountId?: string;
  pendingProviderAccountLabel?: string;
  pendingProviderAccountProvider?: "claude" | "codex";
  pendingProviderCredentialHome?: string;
  pendingProviderAccountSwitchAutomatic?: boolean;
  providerAccountAutomaticallySelected?: boolean;
  /** Per-session backoff, keyed by opaque provider-account id. */
  automaticProviderAccountCooldowns?: Record<string, number>;
  automaticProviderAccountLastSwitchAt?: number;
  providerAccountSwitchFailure?: ProviderAccountSwitchFailureView;
  /** Discovered adapter/CLI version, refreshed before launch for capability gates and telemetry; never an auth source. */
  agentVersion?: string;
  claudeUsageCheckpoint?: import("./drivers/claude-usage-accounting.js").ClaudeUsageCheckpoint;
  /** Durable event coverage for the raw baseline; generic seq repair must not advance it. */
  claudeUsageCheckpointSeq?: number;
  costReconciliationRevision?: number;
  costReconciliationDeltaUsd?: number;
  costReconciliationIdentity?: string;
  costReconciliationRepairId?: string;
  /** Discovery-verified optional CLI flags/modes, retained for restart and runner-side defense. */
  capabilities?: AgentCapabilities;
  /** Session-root command catalog. Undefined preserves the live agent catalog; [] explicitly clears it. */
  sessionSlashCommands?: AgentSlashCommand[];
  /** Runner-local proof of the exact launch boundary that produced sessionSlashCommands. */
  sessionSlashCommandProvenance?: SessionSlashCommandProvenance;
  /** Claude Code commands the agent lists but Wollipog won't send (#1224), with their reasons. */
  sessionUnsupportedSlashCommands?: UnsupportedSlashCommand[];
  /** What a Claude Code session's catalog is merged from: its command files, skills and the last
   * init list for the same provenance (#1224). */
  claudeSlashCatalogInputs?: import("./discovery/claude-slash-catalog.js").ClaudeSessionCatalogInputs;
  codexExecFallbackReason?: "explicit_exec" | "compatibility_exec";
  workspaceId: string | null;
  /** The original repo path; worktrees live in the runner data directory, outside this repo. */
  repoPath: string;
  worktreePath: string | null;
  /** Exact active worktree branch. Absent on metadata created before requested worktrees. */
  worktreeBranch?: string;
  /** Every attributed worktree; worktreePath/worktreeBranch select the active member. */
  worktrees?: SessionWorktreeView[];
  /** Runner-private exact approved teardown/environment snapshots keyed by stable worktree id. */
  worktreeHooks?: Record<string, WorktreeHookSnapshot>;
  /** Runner-private durable POSIX descendant markers keyed by stable worktree id. */
  worktreeProcessMarkers?: Record<string, string>;
  /** Provider-neutral placement captured at launch. Optional for pre-v60 session metadata. */
  executionTarget?: ExecutionTargetRef;
  executionHandoffRequest?: ExecutionHandoffRequest;
  executionHandoff?: ExecutionHandoffReceipt;
  /** Opaque adapter reconnect id. Runner-local only; snapshots expose its SHA-256 digest. */
  cloudAdapterHandoffKey?: string;
  driver: AgentDriverKind;
  /** Launch params, persisted so any runner on the box can re-spawn the agent to RESUME the session. */
  command: string;
  args: string[];
  env: Record<string, string>;
  context: AgentContext;
  /** Agent-native resumable id (claude UUID / codex threadId / acp sessionId), or null if not resumable. */
  agentSessionId: string | null;
  /** Last live ACP handshake; determines whether the persisted id can resume after process loss. */
  acpCapabilities?: AcpRuntimeCapabilities;
  status: SessionStatus;
  /** Current durable admission wait explanation; cleared on every non-queued status. */
  capacityWait?: RunnerCapacityBlocker;
  title: string;
  titleSource?: SessionTitleSource;
  providerUpdatedAt?: string;
  artifactUploads?: import("@wollipog/protocol").ArtifactUploadPreference;
  projectMemory?: import("@wollipog/protocol").SessionProjectMemory;
  config: SessionConfig;
  /** Durable one-shot fence; never evicted, so old runner commands cannot replay mutations. */
  githubIssueClosureAttempts?: Record<string, string>;
  /** Effective Orchestrator restriction. Missing legacy metadata remains strict at launch, and a
   * missing `integrationIsolation` matches that: a strict launch never carried user integrations. */
  orchestrator?: { strictProjectIsolation: boolean; integrationIsolation?: boolean; issueNumbers?: number[]; issueScope?: import("@wollipog/protocol").CampaignIssueScope };
  /** Exact provider model resolved from the selected alias for the active session. */
  resolvedModel?: string | null;
  /** Secret references only; actual MCP credentials are never written to meta.json. */
  acpSessionContext?: AcpSessionContextConfig;
  /** Original session-scope overrides, kept separate so explicit CP restarts can re-merge current
   * runner/workspace/agent config without freezing or resurrecting operator definitions. */
  acpSessionOverrides?: AcpSessionContextConfig;
  tokensIn: number;
  tokensOut: number;
  contextTokensUsed?: number;
  contextWindow?: number;
  costUsd: number;
  preview: string | null;
  pendingApproval: PendingApproval | null;
  /** One-time upgrade scan repaired any question that an older startup path stranded in history. */
  questionRecoveryReconciled?: true;
  /** Runner-only structural identity for the provider installation + credential home/source. */
  providerCredentialScopeId?: string;
  /** Runner-only account/credential digest observed while provider-native status was authenticated. */
  providerCredentialIdentityId?: string;
  /** Per-field runner-keyed digests let the runner distinguish a changed account field from a
   * provider status observation that merely omitted a field. Raw account values never persist. */
  providerCredentialIdentityEvidence?: ProviderAuthIdentityEvidence;
  /** Durable authentication recovery state. Never projected into SessionSnapshot; the browser sees
   * only the bounded pendingApproval card and its random recovery request id. */
  providerAuthBlock?: {
    version: 1;
    recoveryId: string;
    credentialScopeId: string;
    detectedAt: number;
    phase: "launch" | "turn";
    delivery: "not_delivered" | "uncertain";
    canStartLogin: boolean;
    configuredCredential: boolean;
    expectedIdentityId?: string;
    expectedIdentityEvidence?: ProviderAuthIdentityEvidence;
    identityMismatch?: boolean;
    /** Redacted field names only; safe for runner logs and the authentication card. */
    reason?: string;
    /** Correlates one live login subprocess; stale cancels cannot target a later generation. */
    loginOperationId?: string;
    /** Durable prompt commands held before provider submission. The control plane retains the
     * authoritative payload and image leases; this runner-local copy preserves FIFO/configuration
     * coordinates and lets authentication recovery resume without a browser round trip. */
    durableRetries?: Array<{
      commandId: string;
      ordinal: number;
      text: string;
      images: PromptImageInput[];
      slashCommand?: string;
      config?: SessionConfig;
      /** Authenticated provenance of a retained automatic campaign prompt. */
      campaignContinuation?: true;
      /** Complete recovered-question continuation state. Authentication temporarily replaces the
       * visible question card, so replay cannot reconstruct this correlation from pendingApproval. */
      recoveredQuestion?: {
        requestId: string;
        recoveryId: string;
        answers: Record<string, string | string[]>;
        resolvedByParentSessionId?: string;
        pendingQuestion: PendingApproval;
      };
    }>;
    /** Recovery can settle before a restarted runner has reclaimed every durable command handle.
     * Keep the decision durable and content-free until the control plane replays those commands. */
    resolution?: "approved";
    retry?: {
      /** Original runner-local FIFO position reserved before asynchronous launch/preflight. */
      ordinal?: number;
      text: string;
      images: PromptImageInput[];
      slashCommand?: string;
      config?: SessionConfig;
    };
  };
  /** At-most-once tombstone written and flushed before an automatic recovery prompt is enqueued. */
  providerAuthRetryAttemptedRecoveryId?: string;
  /** Content-free command tombstones for auth recovery the user explicitly dismissed before a
   * restarted runner reclaimed the corresponding durable handles. */
  providerAuthDismissedCommandIds?: string[];
  /** Durable, content-free pre-launch worktree refusal. Prompt content remains solely in the
   * control-plane durable outbox and is correlated by its command identity there. */
  worktreeRecovery?: WorktreeRecoveryView;
  /** Durable quarantine of a provider-owned conversation whose stored history the provider rejects
   * before inference. Authoritative across process restart: while it is set, no prompt, automatic
   * continuation, or compaction may be submitted to this thread, because every submission resends
   * the same history and fails identically. Content-free by construction. */
  providerHistoryBlock?: {
    version: 1;
    reason: "oversized_tool_call";
    detectedAt: number;
    /** Structural provider evidence only; the offending value is never persisted. */
    detail: { itemIndex?: number; field: "arguments"; limit?: number; length?: number };
    /** Completed turn whose conversation checkpoint precedes the invalid item. Absent when the
     * session never recorded one, which leaves nothing to recover in place. */
    recoveryTurn?: number;
    recovery?: ProviderHistoryRecoveryMode;
    /** The prompt attempted after quarantine, retained unsent. Never submitted by the runner:
     * only a recovered session can carry it forward. */
    retry?: {
      text: string;
      images: PromptImageInput[];
      slashCommand?: string;
      config?: SessionConfig;
    };
  };
  /** This session was created to recover `fromSessionId`'s quarantined conversation. A provider
   * fork copies history through the checkpoint, so a fork that is quarantined again proves the
   * invalid item predates that checkpoint; its own recovery must escalate to a fresh thread. */
  providerHistoryRecoveryOf?: { fromSessionId: string; mode: ProviderHistoryRecoveryMode };
  /** Claude background work observed by the runner. Optional for older sessions and other drivers. */
  backgroundWorkState?: BackgroundWorkState;
  /** Runner-authoritative durable records for structured provider-managed background jobs. */
  backgroundJobs?: DurableBackgroundJob[];
  /** Provider task ids retained across runner restarts for automatic recovery. */
  pendingBackgroundTaskIds?: string[];
  /** Task ids whose latest orphan artifact already received one unattended recovery attempt.
   * They suppress replay of the same markerless artifact until a live provider re-observes it. */
  recoveredBackgroundTaskIds?: string[];
  /** Durable trigger written before pending work loses its owning Claude process. */
  orphanedWork?: {
    pendingTaskIds: string[];
    markedAt: number;
    reason: "ceiling" | "shutdown" | "process_exit";
    /** At-most-once boundary persisted before the runner submits an unattended recovery turn. */
    recoveryAttemptedAt?: number;
    /** Seeded ids that the recovery process subsequently re-observed as live work. */
    recoveryObservedTaskIds?: string[];
  };
  /** True for sessions adopted from an external CLI transcript (vs. manager-created). Gates reprocess
   * so a normal session's rich event log is never replaced by a best-effort transcript reparse. */
  adopted?: boolean;
  /** Runner-owned copy used to resume an adopted Pi conversation without loading, migrating, or
   * appending to the external CLI's original JSONL file. The path is runner-local and is never
   * projected in SessionSnapshot. */
  adoptedProviderState?: {
    driver: "pi";
    sessionDir: string;
    /** Present only after a different-driver transition has committed and until the abandoned
     * managed copy is removed. It preserves the copy's original execution context across crashes
     * and context changes so cleanup remains safe and retryable. */
    cleanupContext?: AgentContext;
  };
  /** External Claude adoption must not run an unattended recovery turn until a user explicitly
   * continues it; this durable bit records that the manager may own later automatic recovery. */
  adoptedBackgroundRecoveryAuthorized?: boolean;
  /** Isolated provider transcript layout. Absent identifies the legacy provider-wide root;
   * version 2 is a hashed per-manager-session partition. Runner-only, never sent as capability. */
  providerStateVersion?: 2 | 3;
  /** Checkpoint ref layout. Absent is the pre-attestation shared namespace; v2 is stable-owner scoped. */
  checkpointRefVersion?: 2;
  /** Tree sha snapshotting the worktree at the start of the most recent prompt turn (the last_turn
   * diff base). null = the snapshot attempt failed for that turn; absent = never captured. Box-local
   * (names an object in this repo's odb) — deliberately NOT part of SessionSnapshot. */
  lastTurnBaseTree?: string | null;
  /** Prompt turns run so far — numbers the per-turn checkpoint refs
   * (refs/{wollipog,mam}/owners/<owner>/<sid>/turn-<n> for checkpointRefVersion 2).
   * Box-local like lastTurnBaseTree. */
  turnCount?: number;
  /** Exact attributed worktree id for each anchored turn. New refs are nested under this identity;
   * absent entries identify pre-multi-worktree checkpoints and are usable only while provenance is
   * still unambiguous. Runner-local because it names repository ref layout. */
  checkpointWorktreeIds?: Record<string, string>;
  /** Completed provider turns that can be forked, keyed by manager turn number. Box-local because
   * both ids name provider/repository objects owned by this runner. */
  forkPoints?: Record<string, { agentTurnId: string; tree: string; baseCommit?: string; eventSeq?: number; worktreeId?: string }>;
  /** True once the one-shot index migration ran (or for sessions created on a post-PR-B build).
   * Absent = the worktree index may hold the old builds' add -A residue and needs a reset. */
  indexReset?: boolean;
  /** True while worktree isolation was REQUESTED but setup hasn't resolved yet (created, or
   * fell back to in-place). Files/shells must not resolve the session root in this window —
   * falling back to repoPath would open them in the shared base checkout while the agent ends
   * up in the worktree. Cleared by start()'s resolution paths and by reconcileStore. */
  worktreePending?: boolean;
  /** Last assigned per-session event seq (high-water). */
  seq: number;
  /** Bumped by resetEvents(): identifies which "generation" of the event log a seq belongs to.
   * Pending lazy deltas record the epoch they were created under; a flush (in ANY process)
   * drops deltas from an older epoch, so a stale pre-reset seq/preview can never resurrect
   * over a reset+re-backfilled log. Absent = 0 (pre-upgrade metas). */
  logEpoch?: number;
  createdAt: number;
  updatedAt: number;
}

export type ProviderAuthIdentityField = "email" | "orgId" | "authMethod" | "apiProvider";

export interface ProviderAuthIdentityEvidence {
  /** Version 1 evidence predates the runner-stable evidence key. Version 2 is generated only by
   * the production data-directory-keyed controller. A forward change is comparable only when an
   * equal digest or aggregate proves both observations used the same stable key; rollbacks and
   * changed-key evidence fail closed. */
  version: 1 | 2;
  /** Each value is a runner-keyed digest of the field name and value, never the provider value. */
  fields: Partial<Record<ProviderAuthIdentityField, string>>;
}

/** Who asked Wollipog to end background work: the runner on its own policy (#1778), or an
 * explicit stop request from outside the session (#1780) by the session owner or by the
 * controlling Orchestrator of its campaign. */
export type BackgroundJobEndActor = { kind: "runner" } | BackgroundJobStopActor;

/** Why Wollipog ended background work. `handoff_wait_bound`: a worktree or provider-account
 * handoff, and every prompt queued behind it, waited on the work past the configured bound.
 * `stop_request`: an authorized actor asked to stop this one job (#1780). `session_restart`: an
 * explicit Restart replaced the provider process, and the conversation, that ran the job (#1779). */
export type BackgroundJobEndReason = ManagedBackgroundJobEndReason;

export interface BackgroundJobEnd {
  actor: BackgroundJobEndActor;
  reason: BackgroundJobEndReason;
  endedAt: number;
}

/** The dashboard learns who ended a job by role only: a person's account never leaves the runner. */
function projectBackgroundJobEnd(end: BackgroundJobEnd): ManagedBackgroundJobEnd {
  const actor: ManagedBackgroundJobEnd["actor"] = end.actor.kind === "orchestrator"
    ? { kind: "orchestrator", sessionId: end.actor.sessionId }
    : { kind: end.actor.kind };
  return { actor, reason: end.reason, endedAt: end.endedAt };
}

export interface DurableBackgroundJob {
  /** Stable provider task identity after provisional tool-use promotion. */
  id: string;
  toolUseId?: string;
  parentTurnId: string;
  runnerId: string;
  workspaceId: string | null;
  context: AgentContext;
  executionTarget?: ExecutionTargetRef;
  launchType: "agent" | "shell" | "monitor" | "workflow" | "unknown";
  registeredAt: number;
  /** Bounded runner-local provider artifact reference; never projected to the dashboard. */
  outputReference?: string;
  terminalStatus?: "completed" | "failed" | "killed";
  terminalObservedAt?: number;
  /** Present only when Wollipog ended the job itself (#1778): who asked, why, and when. */
  endedBy?: BackgroundJobEnd;
  /** When an explicit Restart replaced the conversation that started this job (#1779). Its result
   * can no longer arrive as a provider task notification, so its continuation says so. */
  restartedAt?: number;
  continuationRequired?: boolean;
  /** Stable identity shared by every job in one parent-turn barrier continuation. */
  continuationId?: string;
  continuationQueuedAt?: number;
  continuationSubmittedAt?: number;
  continuationAcceptedAt?: number;
  /** Durable proof that the accepted provider turn ended without a complete assistant result. */
  continuationMissingResultAt?: number;
  assistantResultPersistedAt?: number;
  /** Runner-private proof that v82 structured delivery evidence was durably published. */
  structuredDeliveryPublishedAt?: number;
}

export interface SessionSlashCommandProvenance {
  driver: AgentDriverKind;
  context: string;
  root: string;
  targetAdapter: "host" | "container" | "cloud";
  targetId: string | null;
  includeUserCommands: boolean;
  handoffManifestDigest: string | null;
}

/** Whether a session was adopted from an external CLI transcript (so reprocess is safe). Uses the
 * explicit `adopted` flag, falling back to the adopt() signature for sessions stored before the flag
 * existed: no manager agent, a resumable id, and never given a worktree. A manager-created session
 * always has an `agentId`, so it never matches the fallback. */
export function isAdoptedSession(m: SessionMeta): boolean {
  return m.adopted ?? (m.agentId === null && m.agentSessionId != null && m.worktreePath === null);
}

export interface StoredEvent {
  seq: number;
  ts: number;
  payload: SessionEventPayload;
}

export const HISTORY_PAGE_MAX_EVENTS = 200;
export const HISTORY_PAGE_MAX_BYTES = 32 * 1024 * 1024;
/** Exact-id delete fences outlive normal reconnect/retry windows but do not grow forever. */
export const DELETED_SESSION_MARKER_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const HISTORY_PAGE_EVENT_BUDGET = HISTORY_PAGE_MAX_BYTES - 64 * 1024;

export type HistoryPageResult =
  | {
      ok: true;
      events: StoredEvent[];
      page: { logEpoch: number; throughSeq: number; nextAfterSeq: number; hasMore: boolean };
    }
  | { ok: false; code: SessionHistoryPageErrorCode; error: string };

const HISTORY_INDEX_MAGIC = Buffer.from("MAMHIDX1", "ascii");
const HISTORY_INDEX_VERSION = 1;
const HISTORY_INDEX_HEADER_BYTES = 24;
const HISTORY_INDEX_RECORD_BYTES = 16;
const HISTORY_INDEX_EVENT_STRIDE = 128;
const HISTORY_INDEX_BYTE_STRIDE = 1024 * 1024;
const HISTORY_SCAN_CHUNK_BYTES = 64 * 1024;
/** Compaction work per event-loop turn: parse at most one slice of the cut range, and move bulk
 * bytes through the libuv pool in chunks small enough to hash in about a millisecond. */
const HISTORY_COMPACTION_SCAN_SLICE_BYTES = 512 * 1024;
const HISTORY_COMPACTION_COPY_CHUNK_BYTES = 1024 * 1024;
/** Appends made during the copy are caught up off the lock until at most this much remains for the
 * synchronous publish step. */
const HISTORY_COMPACTION_LOCKED_CATCH_UP_BYTES = 256 * 1024;
const HISTORY_COMPACTION_CATCH_UP_ROUNDS = 8;
const HISTORY_COMPACTION_PUBLISH_ATTEMPTS = 4;
const HISTORY_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const HISTORY_RESET_VERSION = 1;
const HISTORY_MANIFEST_VERSION = 1;
const HISTORY_LEGACY_FENCE_VERSION = 1;

export interface HistoryCompactionPolicy {
  /** Compact only when the mutable active file grows beyond this many bytes. */
  triggerActiveBytes: number;
  /** Keep at least this many bytes in the mutable active file. */
  retainActiveBytes: number;
  /** Keep at least this many newest events in the mutable active file. */
  retainActiveEvents: number;
  /** Bound one immutable segment so a maintenance pass has predictable I/O. */
  maxSegmentBytes: number;
  /** Delay removal of superseded active generations so in-flight readers remain valid. */
  orphanGraceMs: number;
}

const DEFAULT_HISTORY_COMPACTION_POLICY: HistoryCompactionPolicy = {
  triggerActiveBytes: 64 * 1024 * 1024,
  retainActiveBytes: 16 * 1024 * 1024,
  retainActiveEvents: 1_024,
  maxSegmentBytes: 64 * 1024 * 1024,
  orphanGraceMs: 60 * 60 * 1_000,
};

interface HistorySegment {
  file: string;
  firstSeq: number;
  lastSeq: number;
  bytes: number;
  sha256: string;
}

interface HistoryManifest {
  version: number;
  logEpoch: number;
  activeFile: string;
  segments: HistorySegment[];
}

interface HistorySource {
  file: string;
  path: string;
  virtualStart: number;
  bytes: number;
  segment?: HistorySegment;
}

interface StagedHistoryFile {
  tmp: string;
  path: string;
  /** Identity of the staged inode, which the rename into `path` preserves. */
  key: string;
}

interface HistoryLayout {
  manifest: HistoryManifest | null;
  sources: HistorySource[];
  active: HistorySource;
  coldBytes: number;
  totalBytes: number;
}

export interface HistoryMaintenanceResult {
  inspected: number;
  compacted: number;
  bytesArchived: number;
  orphansRemoved: number;
  errors: number;
}

interface HistoryCheckpoint {
  seq: number;
  offset: number;
}

interface HistoryTail {
  seq: number;
  completeBytes: number;
  fileBytes: number;
  lineOffset: number;
}

interface HistoryIndexInfo {
  count: number;
  last: HistoryCheckpoint | null;
}

interface SessionEventProjectionIndex {
  protocolVersion: number | null;
  logEpoch: number;
  localTail: number;
  completeBytes: number;
  omittedSeqs: number[];
}

class HistoryStoreError extends Error {
  constructor(readonly code: SessionHistoryPageErrorCode, message: string) {
    super(message);
  }
}

/** A held lock is considered stale (reclaimable) after this long without a refresh. */
const LOCK_STALE_MS = 60_000;
/** How long a lock operation waits for another process's guard section (microseconds long) before
 * failing closed: acquire reports the lock busy, refresh skips one tick, release leaves it to go stale. */
const LOCK_GUARD_WAIT_MS = 25;
/** A guard this old whose holder pid is alive but started at another time belongs to a reused pid. */
const LOCK_GUARD_ABANDONED_MS = 10_000;
/** Claim numbers one breaking attempt walks up from the highest existing claim before giving up for
 * now. Numbers themselves are unbounded, so a later attempt continues from wherever this one stopped. */
const LOCK_GUARD_BREAK_STEPS = 64;
/** Guard and claim tokens this process holds right now. Sections are synchronous, so any other guard
 * naming this pid was left behind by an earlier failure. */
const activeLockGuards = new Set<string>();
const lockGuardSleepCell = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(lockGuardSleepCell, 0, 0, ms);
}

/** Kernel start time of a process, to tell a live lock-guard holder from a later process that
 * reused its pid. Only Linux exposes it cheaply; elsewhere this is null and a reused pid fails closed. */
function processStartTime(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22 (starttime); the fields after the parenthesized command name start at field 3.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}
const OWN_PROCESS_START = processStartTime(process.pid);

type LockGuardRecord = { pid?: unknown; start?: unknown; token?: unknown; released?: unknown };

function parseLockGuard(raw: string): LockGuardRecord | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as LockGuardRecord : null;
  } catch {
    return null;
  }
}

/** Meta keys whose churn is per-streamed-delta (noisy). Patches touching ONLY these flush to
 * disk debounced; anything else (status, config, agentSessionId, worktree flags, …) flushes
 * immediately. A crash can lose at most META_FLUSH_MS of preview/usage churn and a lagging
 * `seq` — which appendEvent self-heals from the ndjson tail (see reconcileSeq). */
const LAZY_META_KEYS = new Set<string>([
  "preview", "seq", "tokensIn", "tokensOut", "contextTokensUsed", "contextWindow", "costUsd", "updatedAt",
]);
const META_FLUSH_MS = 250;
/** A warm append layout skips cold-segment checks, so a streaming session still re-validates its
 * segments' presence and size at least this often, as the uncached path did. */
const HISTORY_LAYOUT_REVALIDATE_MS = META_FLUSH_MS;
/** Between those cheap checks the manifest is trusted by identity. A full read at least this often
 * bounds how long an in-place rewrite that preserved inode, mtime, and size could go unnoticed. It is
 * kept rare: at 30 events/s a 5 s bound put full reads on 1.4% of appends, which is the p99 tail. */
const HISTORY_LAYOUT_FULL_REVALIDATE_MS = 30_000;

export class SessionStore {
  /**
   * In-memory meta caching. The on-disk store is SHARED across runner processes on the box,
   * so this is structured as two layers that can never clobber another process's writes:
   *
   *  - `cache`: a clean mirror of meta.json, validated per read with one bigint stat
   *    (mtimeNs + size — plain mtimeMs is too coarse to catch two writes in one timestamp
   *    quantum) instead of a full read + parse.
   *  - `pending`: unflushed noisy-key DELTAS (preview/seq/usage). readMeta overlays them on
   *    the disk mirror; the debounced flush merges them into a FRESH disk read, so critical
   *    fields another runner wrote meanwhile (lock-steal recovery, adopt healing) survive.
   *    `seq` merges monotonically — a stale delta can never roll back a newer high-water.
   *
   * The write side is the real win: meta.json was previously re-serialized + atomically
   * renamed TWICE per streamed delta (appendEvent seq bump + preview accrual) — hundreds of
   * temp-file+rename pairs per second per streaming session, on NTFS. Noisy keys now batch.
   */
  private readonly cache = new Map<string, { meta: SessionMeta; key: string }>();
  /** Unflushed noisy-key deltas + the log epoch they were recorded under (stale-epoch deltas
   * are dropped at overlay/flush time — see SessionMeta.logEpoch). `batch` identifies one run of
   * merged deltas: it survives later merges and is replaced once a write consumes or drops them, so a
   * debounced flush can tell its snapshot is still covered by the newest deltas. */
  private readonly pending = new Map<string, { delta: Partial<SessionMeta>; epoch: number; batch: object }>();
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Debounced flushes whose fsyncs are running on the libuv pool, one per session. */
  private readonly backgroundFlushes = new Map<string, Promise<void>>();
  /** Reconcile once per lock-held append burst, not once per streamed delta. releaseLock clears it
   * so another process's completed turn is observed before this process writes again. */
  private readonly seqReconciled = new Set<string>();
  private readonly checkpointCache = new Map<string, { epoch: number; last: HistoryCheckpoint | null }>();
  /** A validated index stays safe while its exact inode contents are unchanged. This preserves
   * logarithmic checkpoint seeks without re-validating every sparse record on every page. */
  private readonly historyIndexInfoCache = new Map<
    string,
    { epoch: number; indexKey: string; info: HistoryIndexInfo }
  >();
  /** Exact append-stable newline boundary captured when a chain freezes its durable tail. */
  private readonly historyBoundaryCache = new Map<
    string,
    { epoch: number; throughSeq: number; completeBytes: number }
  >();
  /** Exact local sequence ids omitted by the current explicit older-peer event policy. */
  private readonly eventProjectionIndexes = new Map<string, SessionEventProjectionIndex>();
  /** Immutable segment hashes are expensive but only need revalidation when inode metadata changes. */
  private readonly verifiedHistorySegments = new Map<string, string>();
  /** Append-path layout per session and log epoch. Cold segments never change once a manifest
   * references them, so a hit needs only the manifest's identity and the active file's size. Every
   * path that changes the layout (compaction, reset, lock hand-off, removal, failed append) replaces
   * or drops the entry, a manifest identity mismatch refetches from disk, and an entry older than
   * HISTORY_LAYOUT_REVALIDATE_MS is re-validated so external segment damage still fails appends. */
  private readonly historyLayoutCache = new Map<
    string,
    { epoch: number; manifestKey: string | null; layout: HistoryLayout; validatedAt: number; fullyValidatedAt: number }
  >();
  private historyMaintenanceCursor: string | null = null;
  /** Tokens of compactions this process is preparing. Their files are unreferenced until publication,
   * so orphan collection must leave them alone even with a zero grace period. */
  private readonly compactionsInFlight = new Set<string>();
  constructor(
    private readonly root: string = join(homedir(), ".agent-manager", "sessions"),
    private readonly historyScanObserver?: (startOffset: number, endOffset: number) => void,
    private readonly historyCompactionPolicy: HistoryCompactionPolicy = DEFAULT_HISTORY_COMPACTION_POLICY,
  ) {
    const policyValues = [
      historyCompactionPolicy.triggerActiveBytes,
      historyCompactionPolicy.retainActiveBytes,
      historyCompactionPolicy.retainActiveEvents,
      historyCompactionPolicy.maxSegmentBytes,
      historyCompactionPolicy.orphanGraceMs,
    ];
    if (
      policyValues.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      historyCompactionPolicy.triggerActiveBytes < 1 ||
      historyCompactionPolicy.retainActiveEvents < 1 ||
      historyCompactionPolicy.maxSegmentBytes < 1
    ) throw new Error("invalid session history compaction policy");
    mkdirSync(this.root, { recursive: true });
    mkdirSync(this.deletedRoot(), { recursive: true });
  }

  rootPath(): string { return this.root; }
  /** Exact runner-owned directory for lifecycle sentinels such as hold.json. */
  sessionPath(id: string): string { return this.dir(id); }

  private dir(id: string): string {
    return join(this.root, id);
  }
  private deletedRoot(): string {
    return join(this.root, ".deleted");
  }
  private deletedPath(id: string): string {
    return join(this.deletedRoot(), createHash("sha256").update(id).digest("hex"));
  }
  private metaPath(id: string): string {
    return join(this.dir(id), "meta.json");
  }
  private eventsPath(id: string): string {
    return join(this.dir(id), "events.ndjson");
  }
  private historyManifestPath(id: string): string {
    return join(this.dir(id), "events.manifest.json");
  }
  private historyLegacyFencePath(id: string): string {
    return join(this.dir(id), "events.legacy-fence.json");
  }
  private historyIndexPath(id: string): string {
    return join(this.dir(id), "events.idx");
  }
  private historyResetPath(id: string): string {
    return join(this.dir(id), "events.reset.json");
  }
  private lockPath(id: string): string {
    return join(this.dir(id), "lock");
  }
  private worktreeLeasePath(id: string): string {
    return join(this.dir(id), "worktree-use.json");
  }

  private isHistoryFileName(file: string): boolean {
    return basename(file) === file && (
      file === "events.ndjson" ||
      /^events\.active\.[a-zA-Z0-9._-]+\.ndjson$/.test(file) ||
      /^events\.segment\.[a-zA-Z0-9._-]+\.ndjson$/.test(file)
    );
  }

  private hashFile(path: string): string {
    const hash = createHash("sha256");
    const fd = openSync(path, "r");
    try {
      const chunk = Buffer.alloc(HISTORY_SCAN_CHUNK_BYTES);
      let offset = 0;
      for (;;) {
        const read = readSync(fd, chunk, 0, chunk.length, offset);
        if (read === 0) break;
        hash.update(read === chunk.length ? chunk : chunk.subarray(0, read));
        offset += read;
      }
    } finally {
      closeSync(fd);
    }
    return hash.digest("hex");
  }

  private readHistoryManifest(id: string, epoch?: number): HistoryManifest | null {
    const path = this.historyManifestPath(id);
    if (!existsSync(path)) return null;
    let manifest: HistoryManifest;
    try {
      manifest = JSON.parse(readFileSync(path, "utf8")) as HistoryManifest;
    } catch {
      throw new HistoryStoreError("history_corrupt", "session history manifest is malformed");
    }
    if (
      manifest.version !== HISTORY_MANIFEST_VERSION ||
      !Number.isSafeInteger(manifest.logEpoch) || manifest.logEpoch < 0 ||
      (epoch !== undefined && manifest.logEpoch !== epoch) ||
      !this.isHistoryFileName(manifest.activeFile) ||
      (manifest.activeFile !== "events.ndjson" && !manifest.activeFile.startsWith("events.active.")) ||
      !Array.isArray(manifest.segments)
    ) {
      throw new HistoryStoreError("history_corrupt", "session history manifest is invalid");
    }
    let expectedSeq = 1;
    const files = new Set<string>([manifest.activeFile]);
    for (const segment of manifest.segments) {
      if (
        !this.isHistoryFileName(segment.file) ||
        !segment.file.startsWith("events.segment.") ||
        !Number.isSafeInteger(segment.firstSeq) || segment.firstSeq !== expectedSeq ||
        !Number.isSafeInteger(segment.lastSeq) || segment.lastSeq < segment.firstSeq ||
        !Number.isSafeInteger(segment.bytes) || segment.bytes <= 0 ||
        !/^[a-f0-9]{64}$/.test(segment.sha256) || files.has(segment.file)
      ) {
        throw new HistoryStoreError("history_corrupt", "session history manifest has an invalid segment");
      }
      files.add(segment.file);
      const segmentPath = join(this.dir(id), segment.file);
      const key = this.statKey(segmentPath);
      let segmentStat;
      try { segmentStat = lstatSync(segmentPath); } catch { segmentStat = null; }
      if (
        key == null || !segmentStat?.isFile() || segmentStat.isSymbolicLink() ||
        segmentStat.size !== segment.bytes
      ) {
        throw new HistoryStoreError("history_corrupt", `session history segment ${segment.file} is missing or truncated`);
      }
      expectedSeq = segment.lastSeq + 1;
    }
    return manifest;
  }

  private verifyHistorySource(source: HistorySource): void {
    if (!source.segment) return;
    const key = this.statKey(source.path);
    let sourceStat;
    try { sourceStat = lstatSync(source.path); } catch { sourceStat = null; }
    if (
      key == null || !sourceStat?.isFile() || sourceStat.isSymbolicLink() ||
      sourceStat.size !== source.segment.bytes
    ) {
      throw new HistoryStoreError("history_corrupt", `session history segment ${source.file} is missing or truncated`);
    }
    if (this.verifiedHistorySegments.get(source.path) === key) return;
    if (this.hashFile(source.path) !== source.segment.sha256) {
      throw new HistoryStoreError("history_corrupt", `session history segment ${source.file} failed integrity verification`);
    }
    this.verifiedHistorySegments.set(source.path, key);
  }

  private historyLayout(id: string, epoch?: number): HistoryLayout {
    const expectedEpoch = epoch ?? (this.readDiskMetaRaw(id)?.logEpoch ?? 0);
    const manifest = this.readHistoryManifest(id, expectedEpoch);
    this.recoverLegacyFence(id, manifest);
    return this.layoutFromManifest(id, manifest);
  }

  /** Lay out an already-validated manifest. Only the mutable active file is inspected. */
  private layoutFromManifest(id: string, manifest: HistoryManifest | null): HistoryLayout {
    const sources: HistorySource[] = [];
    let virtualStart = 0;
    for (const segment of manifest?.segments ?? []) {
      sources.push({
        file: segment.file,
        path: join(this.dir(id), segment.file),
        virtualStart,
        bytes: segment.bytes,
        segment,
      });
      virtualStart += segment.bytes;
    }
    const activeFile = manifest?.activeFile ?? "events.ndjson";
    const activePath = join(this.dir(id), activeFile);
    const active = { file: activeFile, path: activePath, virtualStart, bytes: this.activeHistoryBytes(activePath) };
    sources.push(active);
    return { manifest, sources, active, coldBytes: virtualStart, totalBytes: virtualStart + active.bytes };
  }

  private activeHistoryBytes(path: string): number {
    try {
      const activeStat = lstatSync(path);
      if (!activeStat.isFile() || activeStat.isSymbolicLink()) throw new Error("not a regular file");
      return activeStat.size;
    } catch {
      throw new HistoryStoreError("history_corrupt", "session history active file is missing");
    }
  }

  /** Identity of the published manifest. Compaction always publishes by renaming a fresh file over
   * it and reset removes it, so inode, nanosecond mtime, and size together change on every switch. */
  private historyManifestKey(id: string): string | null {
    // Most sessions never compact, so a missing manifest is the common case on every append. Report it
    // without an exception: inside the runner a thrown ENOENT costs tens of microseconds. lstat keeps a
    // symlinked manifest from resolving to "missing"; like segments and the active file, it is refused.
    const s = lstatSync(this.historyManifestPath(id), { bigint: true, throwIfNoEntry: false });
    if (!s) return null;
    if (!s.isFile()) throw new HistoryStoreError("history_corrupt", "session history manifest is not a regular file");
    return `${s.ino}:${s.mtimeNs}:${s.size}`;
  }

  private manifestKeyOf(path: string): string {
    const s = statSync(path, { bigint: true });
    return `${s.ino}:${s.mtimeNs}:${s.size}`;
  }

  /** Remember a layout for the append path. A pending legacy-fence intent keeps the session on the
   * uncached path so every append retries the fence exactly as before. */
  private cacheHistoryLayout(id: string, epoch: number, manifestKey: string | null, layout: HistoryLayout): void {
    if (existsSync(this.historyLegacyFencePath(id))) this.historyLayoutCache.delete(id);
    else {
      const now = performance.now();
      this.historyLayoutCache.set(id, { epoch, manifestKey, layout, validatedAt: now, fullyValidatedAt: now });
    }
  }

  /** The append target without re-reading the manifest or touching cold segments. The manifest is
   * stat'ed before any refetch, so a switch racing the read leaves an older key that misses next time. */
  private appendHistoryLayout(id: string, epoch: number): HistoryLayout {
    const manifestKey = this.historyManifestKey(id);
    const cached = this.historyLayoutCache.get(id);
    if (
      !cached || cached.epoch !== epoch || cached.manifestKey !== manifestKey ||
      !this.coldSegmentsStillValid(id, cached)
    ) {
      this.historyLayoutCache.delete(id);
      const layout = this.historyLayout(id, epoch);
      this.cacheHistoryLayout(id, epoch, manifestKey, layout);
      return layout;
    }
    const { layout } = cached;
    layout.active.bytes = this.activeHistoryBytes(layout.active.path);
    layout.totalBytes = layout.coldBytes + layout.active.bytes;
    return layout;
  }

  /** Periodic revalidation of a cached layout whose manifest identity is unchanged (#2831). That
   * manifest names the same immutable segments, so only their presence and size can have changed:
   * one lstat per segment replaces re-reading and re-parsing the manifest. A pending legacy-fence
   * intent, any segment that is damaged or cannot be inspected, or an overdue full read falls back to
   * the full read, which reports damage exactly as before. */
  private coldSegmentsStillValid(
    id: string,
    cached: { layout: HistoryLayout; validatedAt: number; fullyValidatedAt: number },
  ): boolean {
    const now = performance.now();
    if (now - cached.fullyValidatedAt >= HISTORY_LAYOUT_FULL_REVALIDATE_MS) return false;
    if (now - cached.validatedAt < HISTORY_LAYOUT_REVALIDATE_MS) return true;
    if (existsSync(this.historyLegacyFencePath(id))) return false;
    for (const source of cached.layout.sources) {
      if (!source.segment) continue;
      let stat;
      try {
        stat = lstatSync(source.path, { throwIfNoEntry: false });
      } catch {
        return false; // EACCES, EIO, ENOTDIR: the full read turns these into history_corrupt
      }
      if (!stat?.isFile() || stat.size !== source.segment.bytes) return false;
    }
    cached.validatedAt = now;
    return true;
  }

  has(id: string): boolean {
    return existsSync(this.metaPath(id));
  }

  /** Permanent exact-id deletion fence. Session ids are never reused, so a delayed/replayed
   * start command must remain rejected after process restart and after in-memory caches expire. */
  isDeleted(id: string): boolean {
    return existsSync(this.deletedPath(id));
  }

  markDeleted(id: string): void {
    const path = this.deletedPath(id);
    let created = false;
    try {
      writeFileSync(path, id, { flag: "wx" });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (created) {
      this.fsyncFile(path);
    } else {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`deleted-session marker for ${id} is not a regular file`);
      }
      const fd = openSync(path, "r+");
      try {
        const now = new Date();
        futimesSync(fd, now, now);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    this.fsyncDirectory(this.deletedRoot());
  }

  /** Reap old exact-id fences whose session row is already gone. Markers that still guard a
   * crash-window row remain authoritative regardless of age so startup reconciliation cannot
   * briefly advertise or recreate that session. */
  reapDeletedMarkers(
    retentionMs = DELETED_SESSION_MARKER_RETENTION_MS,
    now = Date.now(),
  ): number {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0 || !Number.isFinite(now)) {
      throw new Error("invalid deleted-session marker retention policy");
    }
    const protectedNames = new Set(
      this.listSessions().map((meta) => basename(this.deletedPath(meta.sessionId))),
    );
    let removed = 0;
    let entries: Dirent[];
    try {
      entries = readdirSync(this.deletedRoot(), { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isFile() || protectedNames.has(entry.name)) continue;
      const path = join(this.deletedRoot(), entry.name);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || now - stat.mtimeMs < retentionMs) continue;
        rmSync(path, { force: true });
        removed++;
      } catch {
        // A concurrent process may reap the same marker; inaccessible entries retry next startup.
      }
    }
    if (removed > 0) {
      try {
        this.fsyncDirectory(this.deletedRoot());
      } catch {
        // Reaping is bounded startup maintenance; deletion already succeeded and can be retried.
      }
    }
    return removed;
  }

  create(meta: SessionMeta): void {
    if (this.isDeleted(meta.sessionId)) {
      throw new Error(`session ${meta.sessionId} was permanently deleted`);
    }
    const directory = this.dir(meta.sessionId);
    const directoryExisted = existsSync(directory);
    mkdirSync(directory, { recursive: true });
    const createdEvents = !existsSync(this.eventsPath(meta.sessionId));
    if (createdEvents) {
      writeFileSync(this.eventsPath(meta.sessionId), "");
      this.fsyncFile(this.eventsPath(meta.sessionId));
    }
    this.writeMeta(meta);
    // Never stamp an empty index over a legacy non-empty log. Missing indexes rebuild lazily on the
    // first paged read or append; a newly-created empty log can start with a valid header immediately.
    if (createdEvents) {
      try { this.writeHistoryIndex(meta.sessionId, meta.logEpoch ?? 0, []); } catch { /* derived; rebuild later */ }
    }
    if (!directoryExisted) this.fsyncDirectory(this.root);
    // A concurrent delete may have installed its durable fence after the first check. Never leave
    // the newly written directory visible behind that fence.
    if (this.isDeleted(meta.sessionId)) {
      this.remove(meta.sessionId);
      throw new Error(`session ${meta.sessionId} was permanently deleted`);
    }
  }

  /** Validation key for the clean cache: bigint mtime (ns) + size. */
  private statKey(p: string): string | null {
    try {
      const s = statSync(p, { bigint: true });
      return `${s.mtimeNs}:${s.size}`;
    } catch {
      return null;
    }
  }

  /** The on-disk meta (via the validated clean cache), WITHOUT pending-delta overlay or reset repair. */
  private readDiskMetaRaw(id: string): SessionMeta | null {
    const p = this.metaPath(id);
    const key = this.statKey(p);
    if (key == null) {
      this.cache.delete(id);
      return null;
    }
    const cached = this.cache.get(id);
    if (cached && cached.key === key) return cached.meta;
    try {
      const meta = JSON.parse(readFileSync(p, "utf8")) as SessionMeta;
      this.cache.set(id, { meta, key });
      return meta;
    } catch {
      this.cache.delete(id);
      return null;
    }
  }

  /** Finish a reset whose durable intent was published before the log was truncated. The intent is
   * the commit point: every crash position deterministically converges to the next empty epoch. */
  private recoverHistoryReset(id: string): void {
    const marker = this.historyResetPath(id);
    if (!existsSync(marker)) return;
    let intent: { version: number; nextEpoch: number };
    try {
      intent = JSON.parse(readFileSync(marker, "utf8")) as { version: number; nextEpoch: number };
    } catch {
      throw new HistoryStoreError("history_corrupt", "session history reset intent is malformed");
    }
    if (
      intent.version !== HISTORY_RESET_VERSION ||
      !Number.isSafeInteger(intent.nextEpoch) || intent.nextEpoch <= 0
    ) {
      throw new HistoryStoreError("history_corrupt", "session history reset intent is invalid");
    }
    const disk = this.readDiskMetaRaw(id);
    if (!disk) throw new HistoryStoreError("history_corrupt", "session history reset lost its metadata");
    const diskEpoch = disk.logEpoch ?? 0;
    if (diskEpoch <= intent.nextEpoch) {
      this.pending.delete(id);
      this.historyLayoutCache.delete(id);
      // The reset intent fences every manifest-aware reader. Publish the canonical empty legacy
      // active file, then remove the manifest so a crash at any later point still reads epoch N+1
      // as empty. Immutable segments and superseded active generations are cleanup-only afterward.
      const legacyEvents = this.eventsPath(id);
      try {
        if (existsSync(legacyEvents) && statSync(legacyEvents).isDirectory()) {
          rmSync(legacyEvents, { recursive: true, force: true });
        }
      } catch { /* the following canonical write reports a durable reset failure */ }
      writeFileSync(legacyEvents, "");
      this.fsyncFile(this.eventsPath(id));
      rmSync(this.historyManifestPath(id), { force: true });
      rmSync(this.historyLegacyFencePath(id), { force: true });
      this.fsyncDirectory(this.dir(id));
      try {
        for (const entry of readdirSync(this.dir(id), { withFileTypes: true })) {
          if (!entry.isFile() || entry.name === "events.ndjson") continue;
          if (
            entry.name.startsWith("events.active.") ||
            entry.name.startsWith("events.segment.") ||
            entry.name.startsWith("events.retired.")
          ) {
            try { rmSync(join(this.dir(id), entry.name), { force: true }); } catch { /* retryable orphan */ }
          }
        }
      } catch { /* the canonical empty history is already committed */ }
      for (const path of [...this.verifiedHistorySegments.keys()]) {
        if (path.startsWith(`${this.dir(id)}\\`) || path.startsWith(`${this.dir(id)}/`)) {
          this.verifiedHistorySegments.delete(path);
        }
      }
      if (diskEpoch < intent.nextEpoch || disk.seq !== 0 || disk.preview !== null) {
        this.writeMeta({
          ...disk,
          seq: 0,
          preview: null,
          logEpoch: intent.nextEpoch,
          updatedAt: Date.now(),
        });
      }
      try { this.writeHistoryIndex(id, intent.nextEpoch, []); } catch { /* derived; rebuild later */ }
      this.seqReconciled.add(id);
      this.checkpointCache.set(id, { epoch: intent.nextEpoch, last: null });
    }
    rmSync(marker, { force: true });
    this.fsyncDirectory(this.dir(id));
  }

  /** The recovered on-disk meta, WITHOUT pending-delta overlay. */
  private readDiskMeta(id: string): SessionMeta | null {
    this.recoverHistoryReset(id);
    return this.readDiskMetaRaw(id);
  }

  private mergeDelta(disk: SessionMeta, delta: Partial<SessionMeta>): SessionMeta {
    const merged: SessionMeta = { ...disk, ...delta, sessionId: disk.sessionId };
    // seq is monotonic: a pending delta must never roll a newer on-disk high-water back,
    // and our unflushed appends must beat an older disk copy.
    merged.seq = Math.max(disk.seq, delta.seq ?? 0);
    return merged;
  }

  readMeta(id: string): SessionMeta | null {
    const disk = this.readDiskMeta(id);
    if (!disk) return null;
    const entry = this.pending.get(id);
    if (!entry) return disk;
    if (entry.epoch !== (disk.logEpoch ?? 0)) {
      // The log was reset (possibly by another process) after these deltas were recorded —
      // they describe a generation that no longer exists.
      this.pending.delete(id);
      return disk;
    }
    return this.mergeDelta(disk, entry.delta);
  }

  /** Immediate durable write. Callers must have FOLDED any pending deltas into `meta`
   * (readMeta does) — this clears them and any scheduled flush. */
  private writeMeta(meta: SessionMeta): void {
    // Write to a temp file then rename, so a reader never sees a half-written meta.json.
    const p = this.metaPath(meta.sessionId);
    const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(meta, null, 2));
      this.fsyncFile(tmp);
      renameSync(tmp, p);
    } finally {
      rmSync(tmp, { force: true });
    }
    this.fsyncDirectory(this.dir(meta.sessionId));
    const timer = this.flushTimers.get(meta.sessionId);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(meta.sessionId);
    }
    this.pending.delete(meta.sessionId);
    this.cache.set(meta.sessionId, { meta, key: this.statKey(p) ?? "" });
  }

  private fsyncFile(path: string): void {
    const fd = openSync(path, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  private async fsyncDirectoryAsync(path: string): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "r");
      await handle.sync();
    } catch (error) {
      if (process.platform !== "win32") throw error;
    } finally {
      await handle?.close();
    }
  }

  private fsyncDirectory(path: string): void {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      fsyncSync(fd);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private writeHistoryResetIntent(id: string, nextEpoch: number): void {
    const marker = this.historyResetPath(id);
    const tmp = `${marker}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: HISTORY_RESET_VERSION, nextEpoch }));
      this.fsyncFile(tmp);
      renameSync(tmp, marker);
    } finally {
      rmSync(tmp, { force: true });
    }
    this.fsyncDirectory(this.dir(id));
  }

  private historyIndexHeader(epoch: number): Buffer {
    const header = Buffer.alloc(HISTORY_INDEX_HEADER_BYTES);
    HISTORY_INDEX_MAGIC.copy(header, 0);
    header.writeUInt32LE(HISTORY_INDEX_VERSION, 8);
    header.writeUInt32LE(HISTORY_INDEX_EVENT_STRIDE, 12);
    header.writeBigUInt64LE(BigInt(epoch), 16);
    return header;
  }

  private historyIndexRecord(checkpoint: HistoryCheckpoint): Buffer {
    const record = Buffer.alloc(HISTORY_INDEX_RECORD_BYTES);
    record.writeBigUInt64LE(BigInt(checkpoint.seq), 0);
    record.writeBigUInt64LE(BigInt(checkpoint.offset), 8);
    return record;
  }

  private writeAll(fd: number, contents: Buffer): void {
    let offset = 0;
    while (offset < contents.length) {
      const written = writeSync(fd, contents, offset, contents.length - offset);
      if (written === 0) throw new Error("could not make progress writing session history index");
      offset += written;
    }
  }

  private publishHistoryIndex(id: string, tmp: string): void {
    const p = this.historyIndexPath(id);
    renameSync(tmp, p);
    this.checkpointCache.delete(id);
    this.historyIndexInfoCache.delete(id);
    this.fsyncDirectory(this.dir(id));
  }

  private writeHistoryIndex(id: string, epoch: number, checkpoints: Iterable<HistoryCheckpoint>): void {
    const p = this.historyIndexPath(id);
    const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmp, "wx");
      this.writeAll(fd, this.historyIndexHeader(epoch));
      for (const checkpoint of checkpoints) this.writeAll(fd, this.historyIndexRecord(checkpoint));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.publishHistoryIndex(id, tmp);
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(tmp, { force: true });
    }
  }

  private checkpointFromBuffer(record: Buffer): HistoryCheckpoint | null {
    const seq = record.readBigUInt64LE(0);
    const offset = record.readBigUInt64LE(8);
    if (seq > BigInt(Number.MAX_SAFE_INTEGER) || offset > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const checkpoint = { seq: Number(seq), offset: Number(offset) };
    return checkpoint.seq > 0 && checkpoint.offset >= 0 ? checkpoint : null;
  }

  private readCheckpoint(id: string, index: number): HistoryCheckpoint | null {
    const fd = openSync(this.historyIndexPath(id), "r");
    try {
      const record = Buffer.alloc(HISTORY_INDEX_RECORD_BYTES);
      const read = readSync(
        fd,
        record,
        0,
        record.length,
        HISTORY_INDEX_HEADER_BYTES + index * HISTORY_INDEX_RECORD_BYTES,
      );
      return read === record.length ? this.checkpointFromBuffer(record) : null;
    } finally {
      closeSync(fd);
    }
  }

  /** O(1) structural metadata read. Checkpoints relevant to a seek are validated locally against
   * authoritative NDJSON; whole-prefix validation is reserved for rebuilding an invalid index. */
  private readHistoryIndexInfo(id: string, epoch: number): HistoryIndexInfo | null {
    try {
      const p = this.historyIndexPath(id);
      const indexKey = this.statKey(p);
      if (indexKey == null) return null;
      const cached = this.historyIndexInfoCache.get(id);
      if (cached && cached.epoch === epoch && cached.indexKey === indexKey) return cached.info;
      const size = statSync(p).size;
      if (
        size < HISTORY_INDEX_HEADER_BYTES ||
        (size - HISTORY_INDEX_HEADER_BYTES) % HISTORY_INDEX_RECORD_BYTES !== 0
      ) return null;
      const indexFd = openSync(p, "r");
      try {
        const header = Buffer.alloc(HISTORY_INDEX_HEADER_BYTES);
        if (readSync(indexFd, header, 0, header.length, 0) !== header.length) return null;
        if (!header.subarray(0, HISTORY_INDEX_MAGIC.length).equals(HISTORY_INDEX_MAGIC)) return null;
        if (header.readUInt32LE(8) !== HISTORY_INDEX_VERSION) return null;
        if (header.readUInt32LE(12) !== HISTORY_INDEX_EVENT_STRIDE) return null;
        const headerEpoch = header.readBigUInt64LE(16);
        if (headerEpoch > BigInt(Number.MAX_SAFE_INTEGER) || Number(headerEpoch) !== epoch) return null;

        const count = (size - HISTORY_INDEX_HEADER_BYTES) / HISTORY_INDEX_RECORD_BYTES;
        const last = count ? this.readCheckpoint(id, count - 1) : null;
        if (count && !last) return null;
        if (this.statKey(p) !== indexKey) return null;
        const info = { count, last };
        this.historyIndexInfoCache.set(id, { epoch, indexKey, info });
        return info;
      } finally {
        closeSync(indexFd);
      }
    } catch {
      return null;
    }
  }

  private parseStoredEvent(line: Buffer): StoredEvent {
    let event: StoredEvent;
    try {
      event = JSON.parse(HISTORY_UTF8_DECODER.decode(line)) as StoredEvent;
    } catch {
      throw new HistoryStoreError("history_corrupt", "session history contains invalid UTF-8 or malformed JSON");
    }
    if (
      !Number.isSafeInteger(event.seq) || event.seq <= 0 ||
      !Number.isFinite(event.ts) || event.payload == null || typeof event.payload !== "object"
    ) {
      throw new HistoryStoreError("history_corrupt", "session history contains an invalid event record");
    }
    return event;
  }

  /** Stream complete NDJSON lines with a hard carry ceiling. At most one bounded record plus one
   * 64 KiB read chunk is retained; an attacker-controlled missing newline cannot grow memory with
   * file size. Returning false stops after the current complete line. A `pinned` layout is scanned as
   * captured instead of the current one, so a concurrent manifest switch cannot pull other sources in. */
  private scanHistoryLines(
    id: string,
    startOffset: number,
    endOffset: number,
    visit: (line: Buffer, offset: number) => boolean | void,
    pinned?: HistoryLayout,
  ): { completeBytes: number; trailingBytes: number; stopped: boolean } {
    this.historyScanObserver?.(startOffset, endOffset);
    const layout = pinned ?? this.historyLayout(id);
    if (
      !Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset) ||
      startOffset < 0 || endOffset < startOffset || endOffset > layout.totalBytes
    ) {
      throw new HistoryStoreError("history_corrupt", "session history scan range is invalid");
    }
    let lineOffset = startOffset;
    let lineBytes = 0;
    let parts: Buffer[] = [];
    let completeBytes = startOffset;
    for (const source of layout.sources) {
      const sourceEnd = source.virtualStart + source.bytes;
      const logicalStart = Math.max(startOffset, source.virtualStart);
      const logicalEnd = Math.min(endOffset, sourceEnd);
      if (logicalStart >= logicalEnd) continue;
      this.verifyHistorySource(source);
      const fd = openSync(source.path, "r");
      let logicalPosition = logicalStart;
      let filePosition = logicalStart - source.virtualStart;
      try {
        while (logicalPosition < logicalEnd) {
          const wanted = Math.min(HISTORY_SCAN_CHUNK_BYTES, logicalEnd - logicalPosition);
          const chunk = Buffer.alloc(wanted);
          const read = readSync(fd, chunk, 0, wanted, filePosition);
          if (read === 0) break;
          const actual = read === wanted ? chunk : chunk.subarray(0, read);
          let cursor = 0;
          while (cursor < actual.length) {
            const newline = actual.indexOf(0x0a, cursor);
            const segmentEnd = newline < 0 ? actual.length : newline;
            const segment = actual.subarray(cursor, segmentEnd);
            lineBytes += segment.length;
            if (lineBytes > HISTORY_PAGE_EVENT_BUDGET) {
              throw new HistoryStoreError(
                "history_event_too_large",
                `history record at byte ${lineOffset} exceeds the ${HISTORY_PAGE_MAX_BYTES} byte page budget`,
              );
            }
            if (segment.length) parts.push(Buffer.from(segment));
            if (newline < 0) break;
            if (lineBytes === 0) {
              throw new HistoryStoreError("history_corrupt", "session history contains an empty record");
            }
            const line = parts.length === 1 ? parts[0]! : Buffer.concat(parts, lineBytes);
            completeBytes = logicalPosition + newline + 1;
            if (visit(line, lineOffset) === false) {
              return { completeBytes, trailingBytes: 0, stopped: true };
            }
            parts = [];
            lineBytes = 0;
            lineOffset = completeBytes;
            cursor = newline + 1;
          }
          logicalPosition += read;
          filePosition += read;
        }
      } finally {
        closeSync(fd);
      }
    }
    return { completeBytes, trailingBytes: lineBytes, stopped: false };
  }

  /** Stream a captured prefix of the log, validating every complete record and its contiguous seq. */
  private scanHistoryPrefix(
    id: string,
    fileBytes: number,
    visit: (event: StoredEvent, offset: number, lineBytes: number) => void,
  ): { tailSeq: number; tailOffset: number; completeBytes: number } {
    let expectedSeq = 1;
    let tailOffset = 0;
    const scanned = this.scanHistoryLines(id, 0, fileBytes, (line, offset) => {
      const event = this.parseStoredEvent(line);
      if (event.seq !== expectedSeq) {
        throw new HistoryStoreError(
          "history_corrupt",
          `session history sequence is not contiguous at ${event.seq} (expected ${expectedSeq})`,
        );
      }
      tailOffset = offset;
      visit(event, offset, line.length);
      expectedSeq += 1;
    });
    return { tailSeq: expectedSeq - 1, tailOffset, completeBytes: scanned.completeBytes };
  }

  /** Find a frozen high-water's byte boundary without consulting any later record. Used when the
   * derived index is unavailable or invalid; authoritative corruption inside the prefix still
   * fails closed, while an append beyond `throughSeq` cannot poison an existing page chain. */
  private scanHistoryThrough(id: string, fileBytes: number, throughSeq: number): number {
    if (throughSeq === 0) return 0;
    let expectedSeq = 1;
    let reachedThrough = false;
    const scanned = this.scanHistoryLines(id, 0, fileBytes, (line) => {
      const event = this.parseStoredEvent(line);
      if (event.seq !== expectedSeq || event.seq > throughSeq) {
        throw new HistoryStoreError(
          "history_corrupt",
          `session history sequence is not contiguous at ${event.seq} (expected ${expectedSeq})`,
        );
      }
      expectedSeq += 1;
      if (event.seq === throughSeq) {
        reachedThrough = true;
        return false;
      }
    });
    if (!reachedThrough) {
      throw new HistoryStoreError("history_cursor_invalid", "history cursor is beyond the durable tail");
    }
    return scanned.completeBytes;
  }

  private rebuildHistoryIndex(id: string, epoch: number): HistoryTail {
    const initialSize = this.historyLayout(id, epoch).totalBytes;
    const p = this.historyIndexPath(id);
    const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    let prior: HistoryCheckpoint | null = null;
    try {
      fd = openSync(tmp, "wx");
      this.writeAll(fd, this.historyIndexHeader(epoch));
      const scanned = this.scanHistoryPrefix(id, initialSize, (event, offset) => {
        if (
          !prior ||
          event.seq - prior.seq >= HISTORY_INDEX_EVENT_STRIDE ||
          offset - prior.offset >= HISTORY_INDEX_BYTE_STRIDE
        ) {
          prior = { seq: event.seq, offset };
          this.writeAll(fd!, this.historyIndexRecord(prior));
        }
      });
      const current = this.readDiskMeta(id);
      if (!current || (current.logEpoch ?? 0) !== epoch) {
        throw new HistoryStoreError("history_epoch_changed", "session history was reset while rebuilding its index");
      }
      const finalSize = this.historyLayout(id, epoch).totalBytes;
      if (finalSize < initialSize) {
        throw new HistoryStoreError("history_epoch_changed", "session history changed while rebuilding its index");
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.publishHistoryIndex(id, tmp);
      return {
        seq: scanned.tailSeq,
        completeBytes: scanned.completeBytes,
        fileBytes: finalSize,
        lineOffset: scanned.tailOffset,
      };
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(tmp, { force: true });
    }
  }

  /** Locate the last complete event without reading the whole log. An incomplete non-newline suffix
   * is ignored by readers and truncated by the next append under the session lock. */
  private historyTail(id: string, allowOversizedTornRepair = false): HistoryTail {
    const layout = this.historyLayout(id);
    const fileBytes = layout.totalBytes;
    if (fileBytes === 0) return { seq: 0, completeBytes: 0, fileBytes: 0, lineOffset: 0 };
    const activeFd = openSync(layout.active.path, "r");
    let activeCompleteBytes = layout.active.bytes;
    try {
      if (layout.active.bytes > 0) {
        const one = Buffer.alloc(1);
        readSync(activeFd, one, 0, 1, layout.active.bytes - 1);
        if (one[0] !== 0x0a) {
          activeCompleteBytes = 0;
          let end = layout.active.bytes;
          while (end > 0 && activeCompleteBytes === 0) {
            const start = Math.max(0, end - HISTORY_SCAN_CHUNK_BYTES);
            const chunk = Buffer.alloc(end - start);
            readSync(activeFd, chunk, 0, chunk.length, start);
            const newline = chunk.lastIndexOf(0x0a);
            if (newline >= 0) activeCompleteBytes = start + newline + 1;
            end = start;
          }
        }
      }
    } finally {
      closeSync(activeFd);
    }
    const tornBytes = layout.active.bytes - activeCompleteBytes;
    if (tornBytes > HISTORY_PAGE_EVENT_BUDGET && !allowOversizedTornRepair) {
      throw new HistoryStoreError(
        "history_event_too_large",
        `torn history suffix exceeds the ${HISTORY_PAGE_MAX_BYTES} byte page budget`,
      );
    }

    let tailSource = layout.active;
    let tailCompleteLocal = activeCompleteBytes;
    if (tailCompleteLocal === 0 && layout.manifest?.segments.length) {
      const lastSegment = layout.sources[layout.sources.length - 2];
      if (!lastSegment?.segment) throw new HistoryStoreError("history_corrupt", "session history manifest tail is invalid");
      tailSource = lastSegment;
      tailCompleteLocal = lastSegment.bytes;
    }
    if (tailCompleteLocal === 0) {
      return { seq: 0, completeBytes: 0, fileBytes, lineOffset: 0 };
    }

    const fd = openSync(tailSource.path, "r");
    try {
      this.verifyHistorySource(tailSource);
      let lineStart = 0;
      let end = tailCompleteLocal - 1; // skip the terminating newline
      while (end > 0 && lineStart === 0) {
          const start = Math.max(0, end - HISTORY_SCAN_CHUNK_BYTES);
          const chunk = Buffer.alloc(end - start);
          readSync(fd, chunk, 0, chunk.length, start);
          const newline = chunk.lastIndexOf(0x0a);
          if (newline >= 0) lineStart = start + newline + 1;
          end = start;
        }
      const tailLineBytes = tailCompleteLocal - 1 - lineStart;
      if (tailLineBytes > HISTORY_PAGE_EVENT_BUDGET) {
        throw new HistoryStoreError(
          "history_event_too_large",
          `history tail event exceeds the ${HISTORY_PAGE_MAX_BYTES} byte page budget`,
        );
      }
      const line = Buffer.alloc(tailLineBytes);
      readSync(fd, line, 0, line.length, lineStart);
      if (line.length === 0) {
        throw new HistoryStoreError("history_corrupt", "session history contains an empty tail record");
      }
      const event = this.parseStoredEvent(line);
      if (tailSource.segment && event.seq !== tailSource.segment.lastSeq) {
        throw new HistoryStoreError("history_corrupt", "session history segment sequence metadata is invalid");
      }
      return {
        seq: event.seq,
        completeBytes: layout.coldBytes + activeCompleteBytes,
        fileBytes,
        lineOffset: tailSource.virtualStart + lineStart,
      };
    } finally {
      closeSync(fd);
    }
  }

  private ensureHistoryIndex(id: string, epoch: number, suppliedTail?: HistoryTail): HistoryTail {
    let tail = suppliedTail ?? this.historyTail(id);
    let info = this.readHistoryIndexInfo(id, epoch);
    const stale = !info ||
      (tail.seq === 0 ? info.count !== 0 : info.count === 0) ||
      Boolean(info?.last && (
        info.last.seq > tail.seq ||
        info.last.offset >= tail.completeBytes ||
        (tail.seq > info.last.seq && (
          tail.seq - info.last.seq >= HISTORY_INDEX_EVENT_STRIDE ||
          tail.lineOffset - info.last.offset >= HISTORY_INDEX_BYTE_STRIDE
        ))
      ));
    if (stale) {
      tail = this.rebuildHistoryIndex(id, epoch);
      info = this.readHistoryIndexInfo(id, epoch);
      if (!info) throw new HistoryStoreError("history_corrupt", "session history index could not be rebuilt");
    }
    return tail;
  }

  private appendHistoryCheckpoint(id: string, epoch: number, checkpoint: HistoryCheckpoint): void {
    let cached = this.checkpointCache.get(id);
    if (!cached || cached.epoch !== epoch) {
      let info = this.readHistoryIndexInfo(id, epoch);
      if (!info) {
        this.rebuildHistoryIndex(id, epoch);
        info = this.readHistoryIndexInfo(id, epoch);
      }
      if (!info) return;
      cached = { epoch, last: info.last };
      this.checkpointCache.set(id, cached);
    }
    const prior = cached.last;
    if (
      prior &&
      checkpoint.seq - prior.seq < HISTORY_INDEX_EVENT_STRIDE &&
      checkpoint.offset - prior.offset < HISTORY_INDEX_BYTE_STRIDE
    ) return;
    appendFileSync(this.historyIndexPath(id), this.historyIndexRecord(checkpoint));
    cached.last = checkpoint;
    this.historyIndexInfoCache.delete(id);
  }

  private findHistoryCheckpoint(
    id: string,
    afterSeq: number,
    count: number,
  ): { checkpoint: HistoryCheckpoint; index: number } | null {
    if (count === 0) return null;
    const target = afterSeq + 1;
    let low = 0;
    let high = count - 1;
    let found: { checkpoint: HistoryCheckpoint; index: number } | null = null;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const checkpoint = this.readCheckpoint(id, mid);
      if (!checkpoint) throw new HistoryStoreError("history_corrupt", "session history index is truncated");
      if (checkpoint.seq <= target) {
        found = { checkpoint, index: mid };
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  /** Validate only the checkpoint interval selected by a binary seek. */
  private validateHistoryCheckpoint(id: string, index: number, fileBytes: number): boolean {
    const checkpoint = this.readCheckpoint(id, index);
    if (!checkpoint) return false;
    if (index === 0) {
      if (checkpoint.seq !== 1 || checkpoint.offset !== 0) return false;
      try {
        let matched = false;
        this.scanHistoryLines(id, 0, fileBytes, (line, offset) => {
          matched = offset === 0 && this.parseStoredEvent(line).seq === 1;
          return false;
        });
        return matched;
      } catch {
        return false;
      }
    }
    const prior = this.readCheckpoint(id, index - 1);
    if (!prior || checkpoint.seq <= prior.seq || checkpoint.offset <= prior.offset) return false;
    if (checkpoint.seq - prior.seq > HISTORY_INDEX_EVENT_STRIDE) return false;
    if (checkpoint.offset - prior.offset < HISTORY_INDEX_BYTE_STRIDE) {
      try {
        let matched = false;
        this.scanHistoryLines(id, checkpoint.offset, fileBytes, (line, offset) => {
          matched = offset === checkpoint.offset && this.parseStoredEvent(line).seq === checkpoint.seq;
          return false;
        });
        return matched;
      } catch {
        return false;
      }
    }
    try {
      let expectedSeq = prior.seq;
      let matched = false;
      this.scanHistoryLines(id, prior.offset, fileBytes, (line, offset) => {
        const event = this.parseStoredEvent(line);
        if (event.seq !== expectedSeq) return false;
        if (event.seq === prior.seq && offset !== prior.offset) return false;
        if (event.seq === checkpoint.seq) {
          matched = offset === checkpoint.offset;
          return false;
        }
        if (
          event.seq > checkpoint.seq ||
          event.seq - prior.seq >= HISTORY_INDEX_EVENT_STRIDE ||
          offset - prior.offset >= HISTORY_INDEX_BYTE_STRIDE
        ) return false;
        expectedSeq += 1;
      });
      return matched;
    } catch {
      return false;
    }
  }

  /** Scan at most the selected checkpoint interval to an exact frozen/current high-water. */
  private scanCheckpointThrough(
    id: string,
    checkpoint: HistoryCheckpoint,
    throughSeq: number,
    fileBytes: number,
  ): { ok: true; completeBytes: number } | { ok: false; endedEarly: boolean } {
    let expectedSeq = checkpoint.seq;
    let reached = false;
    let invalidIndex = false;
    const scanned = this.scanHistoryLines(id, checkpoint.offset, fileBytes, (line, offset) => {
      const event = this.parseStoredEvent(line);
      if (event.seq !== expectedSeq) {
        throw new HistoryStoreError(
          "history_corrupt",
          `session history sequence is not contiguous at ${event.seq} (expected ${expectedSeq})`,
        );
      }
      if (event.seq === checkpoint.seq && offset !== checkpoint.offset) {
        invalidIndex = true;
        return false;
      }
      if (
        event.seq > checkpoint.seq &&
        (event.seq - checkpoint.seq >= HISTORY_INDEX_EVENT_STRIDE ||
          offset - checkpoint.offset >= HISTORY_INDEX_BYTE_STRIDE)
      ) {
        invalidIndex = true;
        return false;
      }
      expectedSeq += 1;
      if (event.seq === throughSeq) {
        reached = true;
        return false;
      }
    });
    if (invalidIndex) return { ok: false, endedEarly: false };
    if (!reached) return { ok: false, endedEarly: true };
    return { ok: true, completeBytes: scanned.completeBytes };
  }

  /** Record a noisy-key delta and schedule its coalesced flush. */
  private patchMetaLazy(id: string, delta: Partial<SessionMeta>): void {
    const epoch = this.readDiskMeta(id)?.logEpoch ?? 0;
    const prev = this.pending.get(id);
    const continued = prev && prev.epoch === epoch ? prev : undefined;
    const cur = continued?.delta ?? {};
    const merged: Partial<SessionMeta> = { ...cur, ...delta };
    if (cur.seq != null || delta.seq != null) merged.seq = Math.max(cur.seq ?? 0, delta.seq ?? 0);
    this.pending.set(id, { delta: merged, epoch, batch: continued?.batch ?? {} });
    this.armFlushTimer(id);
  }

  private armFlushTimer(id: string): void {
    if (this.flushTimers.has(id)) return;
    const t = setTimeout(() => {
      this.flushTimers.delete(id);
      this.startBackgroundFlush(id);
    }, META_FLUSH_MS);
    t.unref?.();
    this.flushTimers.set(id, t);
  }

  /** The debounced flush runs at most once at a time per session. A timer that fires while one is
   * in flight re-arms, so its deltas stay pending for the next pass. */
  private startBackgroundFlush(id: string): void {
    if (this.backgroundFlushes.has(id)) {
      this.armFlushTimer(id);
      return;
    }
    const run = this.flushInBackground(id).then(
      () => { this.backgroundFlushes.delete(id); },
      () => new Promise<void>((resolve) => {
        // Any I/O failure retries synchronously in its own task. A persistent one then throws out of
        // a timer-like task, exactly as the synchronous debounced flush did, rather than being
        // swallowed as a promise rejection.
        setImmediate(() => {
          try {
            this.flush(id);
          } finally {
            this.backgroundFlushes.delete(id);
            resolve();
          }
        });
      }),
    );
    this.backgroundFlushes.set(id, run);
  }

  /**
   * The debounced flush with every fsync and the temp write on the libuv pool (#2833). The deltas
   * are snapshotted before the event log's fsync starts, so the metadata never names a seq whose
   * event line the fsync did not cover, which is the ordering the synchronous flush gives. The
   * rename publishes only if meta.json is still the exact file the merge read and the snapshot's
   * batch is still the pending one, checked without yielding. An explicit flush(), a critical patch,
   * or a reset that lands meanwhile has already made the batch durable or dropped it. Later deltas
   * then start a new batch, and republishing the older snapshot over them would roll back fields such
   * as usage totals, so it is abandoned. A peer process's write is merged again.
   */
  private async flushInBackground(id: string): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) return;
    const events = this.flushTarget(id, entry.epoch);
    if (events) await this.fsyncFileInBackground(events);
    const p = this.metaPath(id);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.pending.get(id)?.batch !== entry.batch) return;
      let next: SessionMeta;
      let identity: string | null;
      try {
        // Taken before the read: a file replaced after it never matches at the rename.
        identity = this.metaFileIdentity(p);
        const disk = this.readDiskMeta(id);
        if (!disk || entry.epoch !== (disk.logEpoch ?? 0)) {
          this.pending.delete(id);
          return;
        }
        next = this.mergeDelta(disk, entry.delta);
      } catch {
        this.pending.delete(id); // removed or reset beyond repair by another process
        return;
      }
      const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
      let renamed = false;
      try {
        await this.writeSyncedFileInBackground(tmp, JSON.stringify(next, null, 2));
        if (this.pending.get(id)?.batch !== entry.batch) return; // consumed or dropped meanwhile
        if (this.metaFileIdentity(p) !== identity) continue;
        renameSync(tmp, p);
        renamed = true;
      } finally {
        if (!renamed) rmSync(tmp, { force: true });
      }
      // Deltas recorded during the write are a superset of this snapshot and stay pending.
      if (this.pending.get(id) === entry) this.pending.delete(id);
      this.cache.set(id, { meta: next, key: this.statKey(p) ?? "" });
      await this.fsyncDirectoryAsync(this.dir(id));
      return;
    }
    // meta.json kept changing under the merge; the deltas stay pending for the next pass.
    if (this.pending.has(id)) this.armFlushTimer(id);
  }

  /** The active file the debounced flush makes durable. The append path keeps its layout current
   * for every event it writes, so the cached path is the file those events went to. */
  private flushTarget(id: string, epoch: number): string | null {
    const cached = this.historyLayoutCache.get(id);
    if (cached && cached.epoch === epoch) return cached.layout.active.path;
    try { return this.historyLayout(id).active.path; } catch { return null; }
  }

  private async fsyncFileInBackground(path: string): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await open(path, "r+");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // removed: nothing to make durable
      throw error;
    }
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async writeSyncedFileInBackground(path: string, contents: string): Promise<void> {
    const handle = await open(path, "w");
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Exact identity of meta.json: every write renames a new inode over it. */
  private metaFileIdentity(p: string): string | null {
    const s = statSync(p, { bigint: true, throwIfNoEntry: false });
    return s ? `${s.ino}:${s.mtimeNs}:${s.size}` : null;
  }

  /** Flush a session's pending deltas by merging into a FRESH disk read — another runner may
   * have written newer critical fields meanwhile (lock-steal recovery, healing); overwriting
   * the whole meta with our stale copy would undo that. Session gone ⇒ deltas are dropped.
   * This stays synchronous: when it returns, the event log and pending metadata are durable, even
   * if a debounced flush is still in flight (that one then finds its deltas gone or meta.json
   * replaced, and does not publish). */
  flush(id: string): void {
    const timer = this.flushTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(id);
    }
    // appendFileSync only closes the descriptor; it does not establish a power-loss boundary.
    // Flush the event log before publishing a durable command's `started` receipt.
    let events: string | null = null;
    try { events = this.historyLayout(id).active.path; } catch { /* handled by append/read paths */ }
    if (events && existsSync(events)) {
      // Windows rejects fsync on a read-only handle; r+ supplies a flushable handle without
      // truncating or changing the append-only log.
      this.fsyncFile(events);
    }
    const entry = this.pending.get(id);
    if (!entry) {
      // A debounced flush may have renamed its meta.json and still be waiting on the directory fsync.
      if (this.backgroundFlushes.has(id) && existsSync(this.dir(id))) this.fsyncDirectory(this.dir(id));
      return;
    }
    try {
      const disk = this.readDiskMeta(id);
      if (!disk || entry.epoch !== (disk.logEpoch ?? 0)) {
        // Session gone, or its log was reset since these deltas were recorded (a stale
        // pre-reset seq/preview must never be written over the new generation).
        this.pending.delete(id);
        return;
      }
      this.writeMeta(this.mergeDelta(disk, entry.delta));
    } catch {
      this.pending.delete(id); // removed by another process mid-flush — nothing to persist to
    }
  }

  /** Flush every pending delta to disk now (shutdown path). */
  flushAll(): void {
    for (const id of new Set([...this.pending.keys(), ...this.backgroundFlushes.keys()])) this.flush(id);
  }

  patchMeta(id: string, patch: Partial<SessionMeta>): SessionMeta | null {
    const cur = this.readMeta(id);
    if (!cur) return null;
    const next: SessionMeta = { ...cur, ...patch, sessionId: cur.sessionId, updatedAt: Date.now() };
    if (Object.keys(patch).every((k) => LAZY_META_KEYS.has(k))) {
      this.patchMetaLazy(id, { ...patch, updatedAt: next.updatedAt });
    } else {
      this.writeMeta(next); // folds the pending deltas readMeta overlaid into `cur`
    }
    if (this.metaPatchObserver) {
      try {
        this.metaPatchObserver(next, patch, cur);
      } catch {
        /* A post-patch side effect must never fail the persisted state change. */
      }
    }
    return next;
  }

  private metaPatchObserver?: (meta: SessionMeta, patch: Partial<SessionMeta>, previous: SessionMeta) => void;

  /**
   * One runner-owned post-patch observer. SessionManager uses it to keep launch-local material
   * that mirrors meta (the managed-worktree guard's protections file) in step with every change,
   * including ones made deep inside a worktree operation. `previous` is the meta the patch was
   * applied to, for an observer that must tell a change from a field merely being carried.
   */
  observeMetaPatch(
    observer: (meta: SessionMeta, patch: Partial<SessionMeta>, previous: SessionMeta) => void,
  ): void {
    this.metaPatchObserver = observer;
  }

  /** Append an event (assigning the next seq) and bump meta's seq/updatedAt. Returns the stored
   * event. The seq bump rides the debounced meta flush; callers that need a power-loss boundary
   * must call flush(id) after appending. */
  appendEvent(id: string, payload: SessionEventPayload, ts: number = Date.now()): StoredEvent | null {
    const meta = this.readMeta(id);
    if (!meta) return null;
    const epoch = meta.logEpoch ?? 0;
    let seq: number;
    let offset: number | undefined;
    if (!this.seqReconciled.has(id)) {
      // Reconciliation re-derives the whole layout from disk; nothing cached may outlive it.
      this.historyLayoutCache.delete(id);
      let tail = this.historyTail(id, true);
      if (tail.completeBytes < tail.fileBytes) {
        // A crash can leave an incomplete JSON suffix. Appending onto it would corrupt the next
        // event; only bytes after the final newline are non-events, so remove them before continuing.
        const layout = this.historyLayout(id, epoch);
        if (tail.completeBytes < layout.coldBytes) {
          throw new HistoryStoreError("history_corrupt", "immutable session history has a torn suffix");
        }
        truncateSync(layout.active.path, tail.completeBytes - layout.coldBytes);
        this.fsyncFile(layout.active.path);
        tail = { ...tail, fileBytes: tail.completeBytes };
      }
      try {
        // A durable tail that disagrees with metadata means the previous writer did not publish a
        // complete append state. Rebuilding validates that exceptional authoritative prefix before
        // we mint another sequence. The normal indexed path stays bounded to its final checkpoint
        // interval rather than rescanning healthy history from byte zero on every lock burst.
        tail = tail.seq === meta.seq
          ? this.ensureHistoryIndex(id, epoch, tail)
          : this.rebuildHistoryIndex(id, epoch);
        let info = this.readHistoryIndexInfo(id, epoch);
        if (tail.seq > 0) {
          const lastIndex = (info?.count ?? 0) - 1;
          const checkpointValid = lastIndex >= 0 &&
            this.validateHistoryCheckpoint(id, lastIndex, tail.completeBytes);
          const suffixValid = checkpointValid && info?.last
            ? this.scanCheckpointThrough(id, info.last, tail.seq, tail.completeBytes).ok
            : false;
          if (!suffixValid) {
            tail = this.rebuildHistoryIndex(id, epoch);
            info = this.readHistoryIndexInfo(id, epoch);
          }
        }
        this.checkpointCache.set(id, { epoch, last: info?.last ?? null });
      } catch (error) {
        // The index is derived and must never make a valid authoritative append fail. Structural
        // log errors still fail closed; index I/O is retried by the next paged read.
        if (error instanceof HistoryStoreError) throw error;
        this.checkpointCache.delete(id);
      }
      this.seqReconciled.add(id);
      seq = Math.max(meta.seq, tail.seq) + 1;
      offset = tail.completeBytes;
    } else {
      seq = meta.seq + 1;
    }
    const layout = this.appendHistoryLayout(id, epoch);
    offset ??= layout.totalBytes;
    const ev: StoredEvent = { seq, ts, payload };
    try {
      appendFileSync(layout.active.path, `${JSON.stringify(ev)}\n`);
    } catch (error) {
      // A failed write can leave a torn suffix. Reconcile the tail and layout from disk next time
      // instead of appending after bytes no reader will accept.
      this.historyLayoutCache.delete(id);
      this.seqReconciled.delete(id);
      throw error;
    }
    try {
      this.appendHistoryCheckpoint(id, epoch, { seq, offset });
    } catch {
      this.checkpointCache.delete(id); // a torn/missing derived index rebuilds on demand
    }
    this.patchMetaLazy(id, { seq, updatedAt: ts });
    return ev;
  }

  /**
   * Next event seq. On the FIRST append for a session this process-lifetime, reconcile with the
   * ndjson tail: a crash between an append and its debounced meta flush leaves meta.seq lagging
   * the log, and blindly resuming from it would mint DUPLICATE seqs (which would corrupt the
   * control plane's gap-free hydration cursor). Reading the tail once per session is cheap.
   */
  /** Highest seq in the ndjson log — public so callers can consult the DURABLE tail (a
   * concurrent writer's appends are visible here before its debounced meta flush lands). */
  logTailSeq(id: string): number {
    const result = this.logTailSeqResult(id);
    return result.ok ? result.seq : 0;
  }

  /** Structured variant for callers that must distinguish an empty log from a failed read. */
  logTailSeqResult(id: string): { ok: true; seq: number } | { ok: false } {
    try {
      this.recoverHistoryReset(id);
      return { ok: true, seq: this.historyTail(id).seq };
    } catch {
      return { ok: false };
    }
  }

  private copyHistoryRange(source: string, start: number, bytes: number, target: string): string {
    const input = openSync(source, "r");
    let output: number | undefined;
    const hash = createHash("sha256");
    try {
      output = openSync(target, "wx");
      const chunk = Buffer.alloc(HISTORY_SCAN_CHUNK_BYTES);
      let copied = 0;
      while (copied < bytes) {
        const wanted = Math.min(chunk.length, bytes - copied);
        const read = readSync(input, chunk, 0, wanted, start + copied);
        if (read === 0) throw new HistoryStoreError("history_corrupt", "session history changed during compaction");
        const contents = read === chunk.length ? chunk : chunk.subarray(0, read);
        this.writeAll(output, contents);
        hash.update(contents);
        copied += read;
      }
      fsyncSync(output);
      closeSync(output);
      output = undefined;
      return hash.digest("hex");
    } finally {
      closeSync(input);
      if (output !== undefined) closeSync(output);
    }
  }

  /** Write and fsync a small control file beside its target without blocking the event loop. */
  private async stageHistoryFile(path: string, token: string, contents: string): Promise<StagedHistoryFile> {
    const tmp = `${path}.${process.pid}.${token}.tmp`;
    try {
      const handle = await open(tmp, "wx");
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { tmp, path, key: this.manifestKeyOf(tmp) };
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }

  /** Atomically publish a staged file and make the rename durable. Returns the identity of the exact
   * inode published: rename keeps inode, mtime, and size, so a later stat that differs means another
   * publication replaced this one. */
  private publishHistoryFile(id: string, staged: StagedHistoryFile): string {
    renameSync(staged.tmp, staged.path);
    this.fsyncDirectory(this.dir(id));
    return staged.key;
  }

  /** Once a manifest owns the real active generation, turn the legacy monolithic pathname into a
   * directory fence. A pre-compaction runner then fails its read/append closed instead of forking a
   * second writable history. The retired inode remains for grace-period readers and orphan GC. */
  private recoverLegacyFence(id: string, manifest: HistoryManifest | null): void {
    const marker = this.historyLegacyFencePath(id);
    if (!existsSync(marker)) return;
    let intent: { version: number; activeFile: string; retiredFile: string };
    try {
      intent = JSON.parse(readFileSync(marker, "utf8")) as typeof intent;
    } catch {
      throw new HistoryStoreError("history_corrupt", "session history legacy-fence intent is malformed");
    }
    if (
      intent.version !== HISTORY_LEGACY_FENCE_VERSION ||
      !this.isHistoryFileName(intent.activeFile) || !intent.activeFile.startsWith("events.active.") ||
      basename(intent.retiredFile) !== intent.retiredFile ||
      !/^events\.retired\.[a-zA-Z0-9._-]+\.ndjson$/.test(intent.retiredFile)
    ) throw new HistoryStoreError("history_corrupt", "session history legacy-fence intent is invalid");
    if (!manifest || manifest.activeFile !== intent.activeFile) {
      rmSync(marker, { force: true }); // uncommitted compaction; monolithic history remains authoritative
      this.fsyncDirectory(this.dir(id));
      return;
    }
    const legacy = this.eventsPath(id);
    try {
      const retired = join(this.dir(id), intent.retiredFile);
      if (existsSync(legacy) && !statSync(legacy).isDirectory()) {
        if (existsSync(retired)) rmSync(legacy, { force: true });
        else renameSync(legacy, retired);
      }
      if (!existsSync(legacy)) mkdirSync(legacy);
      if (!statSync(legacy).isDirectory()) return;
      rmSync(marker, { force: true });
      this.fsyncDirectory(this.dir(id));
    } catch {
      // Windows can refuse the rename while an earlier reader holds the file open. Leaving the
      // durable intent preserves that reader and makes the next layout/maintenance retry the fence.
    }
  }

  /** Move one bounded, newline-aligned prefix of the mutable active log into a content-addressed,
   * immutable segment. Logical bytes and seqs do not change, so sparse-index offsets and frozen
   * pagination chains remain valid across the atomic manifest switch. The caller must own the
   * per-session writer lock when it calls and still own it when the copy is ready to publish;
   * ordinary history reads remain lock-free.
   *
   * Only planning and publication run synchronously. The cut search parses bounded slices and the
   * bulk copy, hash, and fsync run on the libuv pool, so neither blocks the event loop for long.
   * Events appended while the copy runs land in the old active file after the copied prefix; they
   * are copied in order, complete lines only, and the remainder is copied under the lock
   * immediately before the manifest switch. */
  compactHistory(id: string, owner: string, force = false): Promise<{ compacted: boolean; bytesArchived: number }> {
    return this.runHistoryCompaction(id, owner, force, false);
  }

  /** `yieldLock` releases the writer lock for the copy and takes it back only to publish, so a turn
   * that starts meanwhile is never refused. A turn still holding the lock at publication wins; the
   * copy is discarded and a later maintenance pass retries. */
  private async runHistoryCompaction(
    id: string,
    owner: string,
    force: boolean,
    yieldLock: boolean,
  ): Promise<{ compacted: boolean; bytesArchived: number }> {
    const notCompacted = { compacted: false, bytesArchived: 0 };
    const plan = this.planHistoryCompaction(id, owner, force);
    if (!plan) return notCompacted;
    const { epoch, manifestKey, layout } = plan;
    if (yieldLock) this.releaseLock(id, owner);

    const activeStart = layout.active.virtualStart;
    let firstSeq = 0;
    let lastSeq = 0;
    let cutBytes = 0;
    let sliceStart = activeStart;
    let sliceBytes = HISTORY_COMPACTION_SCAN_SLICE_BYTES;
    const scanEnd = activeStart + plan.maxCutBytes;
    while (sliceStart < scanEnd) {
      const sliceEnd = Math.min(scanEnd, sliceStart + sliceBytes);
      // The cut lies inside the planned active file. Scanning the pinned layout keeps a peer's newly
      // published segment (which a fresh layout would verify by hashing it whole) out of the scan.
      const scanned = this.scanHistoryLines(id, sliceStart, sliceEnd, (line, offset) => {
        const event = this.parseStoredEvent(line);
        if (firstSeq === 0) firstSeq = event.seq;
        if (event.seq > plan.maxCutSeq) return false;
        lastSeq = event.seq;
        cutBytes = offset + line.length + 1 - activeStart;
      }, layout);
      if (scanned.stopped || sliceEnd === scanEnd) break;
      if (scanned.completeBytes === sliceStart) {
        sliceBytes *= 2; // one record wider than the slice; scanHistoryLines bounds its size
      } else {
        sliceStart = scanned.completeBytes;
        sliceBytes = HISTORY_COMPACTION_SCAN_SLICE_BYTES;
      }
      await yieldToEventLoop();
      if (this.historyManifestKey(id) !== manifestKey || (this.readDiskMetaRaw(id)?.logEpoch ?? 0) !== epoch) {
        throw new HistoryStoreError("history_epoch_changed", "session history changed during compaction");
      }
    }
    const expectedFirstSeq = (layout.manifest?.segments.at(-1)?.lastSeq ?? 0) + 1;
    if (cutBytes <= 0 || firstSeq !== expectedFirstSeq || lastSeq >= plan.tailSeq) return notCompacted;

    const token = `${epoch}.${firstSeq}-${lastSeq}.${randomUUID()}`;
    const segmentTmp = join(this.dir(id), `events.segment.${token}.ndjson.tmp`);
    // The new active generation is written under its final name. Until the manifest names it, it is
    // unreferenced debris that the finally block or orphan collection removes.
    const activeFile = `events.active.${token}.ndjson`;
    const activePath = join(this.dir(id), activeFile);
    const retiredFile = `events.retired.${token}.ndjson`;
    let segmentPath: string | null = null;
    let source: FileHandle | null = null;
    let activeOut: FileHandle | null = null;
    const staged: StagedHistoryFile[] = [];
    let committed = false;
    this.compactionsInFlight.add(token);
    try {
      source = await open(layout.active.path, "r");
      const sourceIdentity = await source.stat({ bigint: true });
      const sha256 = await this.copyHistoryRangeAsync(source, 0, cutBytes, segmentTmp);
      const segmentFile = `events.segment.${token}.${sha256.slice(0, 16)}.ndjson`;
      segmentPath = join(this.dir(id), segmentFile);
      await rename(segmentTmp, segmentPath);
      activeOut = await open(activePath, "wx");
      let copiedThrough = await this.appendCompleteHistoryLines(source, cutBytes, layout.active.bytes, activeOut);
      if (copiedThrough !== layout.active.bytes) {
        throw new HistoryStoreError("history_corrupt", "session history changed during compaction");
      }
      // Stage the control files too, so publication is only renames plus one directory fsync.
      const manifest: HistoryManifest = {
        version: HISTORY_MANIFEST_VERSION,
        logEpoch: epoch,
        activeFile,
        segments: [
          ...(layout.manifest?.segments ?? []),
          { file: segmentFile, firstSeq, lastSeq, bytes: cutBytes, sha256 },
        ],
      };
      const legacy = layout.active.file === "events.ndjson";
      if (legacy) {
        staged.push(await this.stageHistoryFile(this.historyLegacyFencePath(id), token, JSON.stringify({
          version: HISTORY_LEGACY_FENCE_VERSION,
          activeFile,
          retiredFile,
        })));
      }
      const stagedManifest = await this.stageHistoryFile(this.historyManifestPath(id), token, JSON.stringify(manifest));
      staged.push(stagedManifest);

      // Appends keep arriving while this awaits. Catch up off the lock until the remainder fits the
      // synchronous bound; a burst that lands just before the lock is taken sends it back for another
      // asynchronous round instead of being copied while every session waits.
      let remainder = 0;
      for (let attempt = 1; ; attempt++) {
        for (let round = 0; round < HISTORY_COMPACTION_CATCH_UP_ROUNDS; round++) {
          const size = Number((await source.stat({ bigint: true })).size);
          if (size - copiedThrough <= HISTORY_COMPACTION_LOCKED_CATCH_UP_BYTES) break;
          copiedThrough = await this.appendCompleteHistoryLines(source, copiedThrough, size, activeOut);
        }
        await activeOut.sync();
        if (attempt === 1) await this.fsyncDirectoryAsync(this.dir(id));

        if (!(yieldLock ? this.acquireFreeLock(id, owner) : this.ownsLock(id, owner))) return notCompacted;
        // Everything from here to the cache update runs without yielding: no append from this process
        // can interleave, and other processes are fenced by the writer lock. Handles close afterward.
        const beforePublish = this.readDiskMeta(id);
        let current;
        try { current = lstatSync(layout.active.path, { bigint: true }); } catch { current = null; }
        if (
          !beforePublish || (beforePublish.logEpoch ?? 0) !== epoch ||
          this.historyManifestKey(id) !== manifestKey ||
          !current?.isFile() || current.ino !== sourceIdentity.ino || current.dev !== sourceIdentity.dev ||
          Number(current.size) < copiedThrough
        ) {
          throw new HistoryStoreError("history_epoch_changed", "session history changed during compaction");
        }
        remainder = Number(current.size) - copiedThrough;
        if (remainder <= HISTORY_COMPACTION_LOCKED_CATCH_UP_BYTES) break;
        if (yieldLock) this.releaseLock(id, owner);
        if (attempt >= HISTORY_COMPACTION_PUBLISH_ATTEMPTS) return notCompacted;
      }
      if (remainder > 0) {
        const tail = Buffer.alloc(remainder);
        const read = readSync(source.fd, tail, 0, remainder, copiedThrough);
        // A torn suffix belongs to a writer that has not repaired it yet; let it, then retry.
        if (read !== remainder || tail[remainder - 1] !== 0x0a) return notCompacted;
        this.writeAll(activeOut.fd, tail);
        fsyncSync(activeOut.fd);
      }
      // While the lock was free, another store's orphan collection may have removed the prepared files.
      // Writes to an unlinked active file still succeed, so check the names before committing to them.
      let preparedSegment;
      let preparedActive;
      try {
        preparedSegment = lstatSync(segmentPath);
        preparedActive = lstatSync(activePath, { bigint: true });
      } catch {
        preparedSegment = preparedActive = null;
      }
      const written = fstatSync(activeOut.fd, { bigint: true });
      if (
        !preparedSegment?.isFile() || preparedSegment.size !== cutBytes ||
        !preparedActive?.isFile() || preparedActive.ino !== written.ino || preparedActive.dev !== written.dev ||
        staged.some((file) => !existsSync(file.tmp))
      ) {
        throw new HistoryStoreError("history_epoch_changed", "prepared compaction files were removed before publication");
      }
      // The session lock is best effort: another acquirer can overwrite it. Re-read it last.
      if (!this.ownsLock(id, owner)) return notCompacted;
      // The fence intent must be durable before the manifest that commits it.
      for (const file of staged) this.publishHistoryFile(id, file);
      committed = true;
      // Extend the append layout in place of a full refetch: the new segment was just written,
      // fsynced, and published, so only the new active file needs reading. Keying the entry by the
      // published inode, not a fresh stat, makes any later replacement miss.
      try {
        this.cacheHistoryLayout(id, epoch, stagedManifest.key, this.layoutFromManifest(id, manifest));
      } catch {
        this.historyLayoutCache.delete(id); // the next append refetches and reports any damage
      }
      if (legacy) {
        // Retiring the legacy file is its own durable step (rename, mkdir, directory fsync). The committed
        // intent makes any layout read finish it, even after a crash, so let other work run first. This
        // continuation resumed from I/O, so one immediate would still run in this loop iteration; the
        // second waits for the next one, after its timers and I/O.
        await yieldToEventLoop();
        await yieldToEventLoop();
        this.recoverLegacyFence(id, manifest);
      }
      // Logical history is byte-identical. Only source-file topology changed; keep the derived
      // index/checkpoint caches and frozen cursor boundaries intact.
      return { compacted: true, bytesArchived: cutBytes };
    } finally {
      this.compactionsInFlight.delete(token);
      await Promise.all([source?.close(), activeOut?.close()]).catch(() => undefined);
      rmSync(segmentTmp, { force: true });
      for (const file of staged) rmSync(file.tmp, { force: true });
      if (!committed) {
        if (segmentPath) rmSync(segmentPath, { force: true });
        rmSync(activePath, { force: true });
      }
    }
  }

  /** Validate the durable tail under the writer lock and bound the cut. Returns null when there is
   * nothing to archive. */
  private planHistoryCompaction(id: string, owner: string, force: boolean): {
    epoch: number;
    manifestKey: string | null;
    layout: HistoryLayout;
    tailSeq: number;
    maxCutBytes: number;
    maxCutSeq: number;
  } | null {
    if (!this.ownsLock(id, owner)) return null;
    // No flush(): the new segment and active generation are fsynced before the manifest names them,
    // so the old active file's durability is irrelevant, and pending metadata keeps its own flush.
    const meta = this.readDiskMeta(id);
    if (!meta) return null;
    const epoch = meta.logEpoch ?? 0;
    const manifestKey = this.historyManifestKey(id);
    const layout = this.historyLayout(id, epoch);
    const policy = this.historyCompactionPolicy;
    if (!force && layout.active.bytes <= policy.triggerActiveBytes) {
      if (!this.readHistoryIndexInfo(id, epoch)) {
        this.ensureHistoryIndex(id, epoch, this.historyTail(id));
      }
      return null;
    }
    const tail = this.ensureHistoryIndex(id, epoch, this.historyTail(id));
    if (tail.completeBytes !== tail.fileBytes) {
      throw new HistoryStoreError("history_corrupt", "session history has a torn suffix and cannot be compacted");
    }
    const maxCutBytes = Math.min(
      policy.maxSegmentBytes,
      Math.max(0, layout.active.bytes - policy.retainActiveBytes),
    );
    const maxCutSeq = tail.seq - policy.retainActiveEvents;
    if (maxCutBytes <= 0 || maxCutSeq < 1) return null;
    return { epoch, manifestKey, layout, tailSeq: tail.seq, maxCutBytes, maxCutSeq };
  }

  /** Copy `bytes` from `start` into a new fsynced file and return its SHA-256. */
  private async copyHistoryRangeAsync(source: FileHandle, start: number, bytes: number, target: string): Promise<string> {
    const output = await open(target, "wx");
    const hash = createHash("sha256");
    try {
      const chunk = Buffer.alloc(HISTORY_COMPACTION_COPY_CHUNK_BYTES);
      let copied = 0;
      while (copied < bytes) {
        const wanted = Math.min(chunk.length, bytes - copied);
        const { bytesRead } = await source.read(chunk, 0, wanted, start + copied);
        if (bytesRead === 0) throw new HistoryStoreError("history_corrupt", "session history changed during compaction");
        const contents = chunk.subarray(0, bytesRead);
        hash.update(contents);
        await this.writeAllAsync(output, contents);
        copied += bytesRead;
      }
      await output.sync();
    } finally {
      await output.close();
    }
    return hash.digest("hex");
  }

  /** Append source bytes `[start, end)` through their last newline and return the new copy cursor.
   * Torn-tail repair truncates only after a file's final newline, so bytes ending at an observed
   * newline never change again within one log epoch. */
  private async appendCompleteHistoryLines(source: FileHandle, start: number, end: number, target: FileHandle): Promise<number> {
    let completeEnd = end;
    const probe = Buffer.alloc(HISTORY_SCAN_CHUNK_BYTES);
    while (completeEnd > start) {
      const probeStart = Math.max(start, completeEnd - probe.length);
      const { bytesRead } = await source.read(probe, 0, completeEnd - probeStart, probeStart);
      const newline = probe.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline >= 0) {
        completeEnd = probeStart + newline + 1;
        break;
      }
      completeEnd = probeStart;
    }
    const chunk = Buffer.alloc(HISTORY_COMPACTION_COPY_CHUNK_BYTES);
    let position = start;
    while (position < completeEnd) {
      const wanted = Math.min(chunk.length, completeEnd - position);
      const { bytesRead } = await source.read(chunk, 0, wanted, position);
      if (bytesRead === 0) throw new HistoryStoreError("history_corrupt", "session history changed during compaction");
      await this.writeAllAsync(target, chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    return completeEnd;
  }

  private async writeAllAsync(target: FileHandle, contents: Buffer): Promise<void> {
    let written = 0;
    while (written < contents.length) {
      const result = await target.write(contents, written, contents.length - written);
      written += result.bytesWritten;
    }
  }

  private cleanupHistoryOrphans(id: string, now = Date.now(), limit = 32): number {
    let layout: HistoryLayout;
    try { layout = this.historyLayout(id); } catch { return 0; }
    const referenced = new Set(layout.sources.map((source) => source.file));
    let removed = 0;
    try {
      for (const entry of readdirSync(this.dir(id), { withFileTypes: true })) {
        if (removed >= limit || !entry.isFile() || referenced.has(entry.name)) continue;
        if ([...this.compactionsInFlight].some((token) => entry.name.includes(token))) continue;
        if (
          !this.isHistoryFileName(entry.name) &&
          !/^events\.(active|segment)\..+\.ndjson\.tmp$/.test(entry.name) &&
          !/^events\.(manifest|legacy-fence)\.json\..+\.tmp$/.test(entry.name) &&
          !/^events\.retired\..+\.ndjson$/.test(entry.name)
        ) continue;
        const path = join(this.dir(id), entry.name);
        try {
          if (now - statSync(path).mtimeMs < this.historyCompactionPolicy.orphanGraceMs) continue;
          if (entry.name === "events.ndjson") {
            // Retry the legacy-writer fence if the post-publish rename was blocked by an open file.
            this.recoverLegacyFence(id, layout.manifest);
            if (!statSync(path).isDirectory()) continue;
          } else {
            rmSync(path, { force: true });
          }
          this.verifiedHistorySegments.delete(path);
          removed += 1;
        } catch { /* open on Windows or concurrently replaced; retry next pass */ }
      }
    } catch { /* session removed concurrently */ }
    if (removed) this.fsyncDirectory(this.dir(id));
    return removed;
  }

  /** Bounded idle maintenance. It never steals a fresh writer lock and processes only `limit`
   * sessions per pass, keeping fleet startup and command completion independent of archive work.
   * The lock is released while a compaction copies, so a turn may start at any point. */
  async maintainHistories(owner: string, limit = 4): Promise<HistoryMaintenanceResult> {
    const result: HistoryMaintenanceResult = {
      inspected: 0,
      compacted: 0,
      bytesArchived: 0,
      orphansRemoved: 0,
      errors: 0,
    };
    const sessions = this.listSessions().sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    if (!sessions.length) return result;
    let start = 0;
    if (this.historyMaintenanceCursor) {
      const next = sessions.findIndex((meta) => meta.sessionId > this.historyMaintenanceCursor!);
      start = next >= 0 ? next : 0;
    }
    for (let visited = 0; visited < sessions.length; visited += 1) {
      if (result.inspected >= limit) break;
      const meta = sessions[(start + visited) % sessions.length]!;
      this.historyMaintenanceCursor = meta.sessionId;
      if (!this.acquireLock(meta.sessionId, owner)) continue;
      result.inspected += 1;
      try {
        const compacted = await this.runHistoryCompaction(meta.sessionId, owner, false, true);
        if (compacted.compacted) result.compacted += 1;
        result.bytesArchived += compacted.bytesArchived;
        if (this.ownsLock(meta.sessionId, owner)) {
          result.orphansRemoved += this.cleanupHistoryOrphans(meta.sessionId);
        }
      } catch {
        result.errors += 1;
      } finally {
        this.releaseLock(meta.sessionId, owner);
      }
    }
    return result;
  }

  /** Truncate the event log and reset the seq high-water + preview, so the caller can re-backfill
   * from scratch (used by reprocess to re-import an adopted transcript). Authoritative top-level
   * usage/cost are preserved: transcript parsers can recover display-only parented subagent usage,
   * but not the provider's terminal session total. Preview is rebuilt from agent messages.
   *
   * The reset is DURABLE and bypasses the delta layer entirely: `seq: 0` is a deliberate
   * ROLLBACK, which the monotonic delta merge would otherwise refuse, and a lazily-flushed
   * reset racing another process (or a crash) would pair the truncated log with the OLD
   * high-water and mint far-future seqs over the replaced history. */
  resetEvents(id: string): void {
    const disk = this.readDiskMeta(id);
    if (!disk) return;
    this.pending.delete(id); // stale preview/seq deltas from the pre-reset log must not resurface
    this.eventProjectionIndexes.delete(id);
    // Bump the log epoch: OTHER processes may hold pending deltas recorded against the old
    // log — their flushes see the mismatch and drop them instead of resurrecting the old
    // seq high-water over the reset (or over a shorter re-backfilled) log.
    const nextEpoch = (disk.logEpoch ?? 0) + 1;
    this.writeHistoryResetIntent(id, nextEpoch);
    this.recoverHistoryReset(id);
  }

  private eventProjectionRequired(protocolVersion: number | null | undefined): boolean {
    return sessionEventWireProjectionRequiredForProtocol(protocolVersion);
  }

  private upperBound(values: readonly number[], target: number): number {
    let low = 0;
    let high = values.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (values[middle]! <= target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** Build an append-incremental index containing only explicitly omittable local sequence ids.
   * The exact JSONL remains authoritative; this derived index can be discarded on reset/restart. */
  private refreshEventProjectionIndex(
    id: string,
    protocolVersion: number | null | undefined,
  ): SessionEventProjectionIndex {
    const meta = this.readDiskMeta(id);
    if (!meta) throw new HistoryStoreError("history_cursor_invalid", "session history does not exist");
    const peerProtocolVersion = Number.isInteger(protocolVersion) ? protocolVersion! : null;
    const logEpoch = meta.logEpoch ?? 0;
    const tail = this.historyTail(id);
    let index = this.eventProjectionIndexes.get(id);
    if (!index || index.protocolVersion !== peerProtocolVersion || index.logEpoch !== logEpoch ||
        index.localTail > tail.seq || index.completeBytes > tail.completeBytes) {
      index = {
        protocolVersion: peerProtocolVersion,
        logEpoch,
        localTail: 0,
        completeBytes: 0,
        omittedSeqs: [],
      };
    }
    if (index.localTail < tail.seq) {
      let expected = index.localTail + 1;
      // A scan can fail after visiting a valid prefix (for example when compaction replaces a
      // later segment). Keep the cached index immutable until the whole captured suffix validates,
      // otherwise a retry appends the same omissions again and shifts the dense wire sequence.
      const omittedSeqs = [...index.omittedSeqs];
      const scanned = this.scanHistoryLines(id, index.completeBytes, tail.completeBytes, (line) => {
        const event = this.parseStoredEvent(line);
        if (event.seq !== expected || event.seq > tail.seq) {
          throw new HistoryStoreError("history_corrupt", "session history is not contiguous during wire projection");
        }
        if (projectSessionEventPayloadForProtocol(event.payload, protocolVersion) === null) {
          omittedSeqs.push(event.seq);
        }
        expected += 1;
      });
      if (scanned.trailingBytes !== 0) {
        throw new HistoryStoreError("history_corrupt", "session history has an incomplete projected record");
      }
      if (expected - 1 !== tail.seq) {
        throw new HistoryStoreError("history_corrupt", "session history ended before its projected tail");
      }
      index = {
        ...index,
        localTail: tail.seq,
        completeBytes: scanned.completeBytes,
        omittedSeqs,
      };
    }
    this.eventProjectionIndexes.set(id, index);
    return index;
  }

  private projectedSeq(index: SessionEventProjectionIndex, localSeq: number): number {
    return localSeq - this.upperBound(index.omittedSeqs, localSeq);
  }

  private localSeqForProjected(index: SessionEventProjectionIndex, projectedSeq: number): number {
    const projectedTail = this.projectedSeq(index, index.localTail);
    if (!Number.isSafeInteger(projectedSeq) || projectedSeq < 0 || projectedSeq > projectedTail) {
      throw new HistoryStoreError("history_cursor_invalid", "projected history cursor is beyond the durable tail");
    }
    if (projectedSeq === 0) return 0;
    let localSeq = projectedSeq;
    for (const omittedSeq of index.omittedSeqs) {
      if (omittedSeq > localSeq) break;
      localSeq += 1;
    }
    return localSeq;
  }

  /** Peer-version fence for the projected sequence space. A version change that adds or removes
   * omitted events must present a new history generation so the control plane cannot retain rows
   * whose dense sequence ids now refer to different exact local events. */
  projectedHistoryEpoch(
    localEpoch: number,
    protocolVersion: number | null | undefined,
  ): number {
    // One dense sequence space per distinct projection, not per "projected or not": a peer that
    // omits two event kinds numbers the log differently from one that omits a single kind, so they
    // must never share an epoch or a reconnect would reuse cursors that now name different events.
    const variant = sessionEventWireProjectionVariant(protocolVersion);
    if (!Number.isSafeInteger(localEpoch) || localEpoch < 0 ||
        localEpoch > Math.floor(
          (Number.MAX_SAFE_INTEGER - SESSION_EVENT_WIRE_EPOCH_FORMAT_OFFSET - variant) /
            SESSION_EVENT_WIRE_PROJECTION_VARIANTS,
        )) {
      throw new HistoryStoreError("history_corrupt", "session history epoch cannot be projected safely");
    }
    return SESSION_EVENT_WIRE_EPOCH_FORMAT_OFFSET +
      localEpoch * SESSION_EVENT_WIRE_PROJECTION_VARIANTS + variant;
  }

  private projectEventsWithIndex(
    events: StoredEvent[],
    protocolVersion: number | null | undefined,
    index: SessionEventProjectionIndex,
  ): StoredEvent[] {
    return events.flatMap((event) => {
      const payload = projectSessionEventPayloadForProtocol(event.payload, protocolVersion);
      return payload === null ? [] : [{ ...event, seq: this.projectedSeq(index, event.seq), payload }];
    });
  }
  /** Dense peer-facing high-water for a local durable sequence. */
  projectedEventSeq(
    id: string,
    localSeq: number,
    protocolVersion: number | null | undefined,
  ): number {
    if (!this.eventProjectionRequired(protocolVersion)) return localSeq;
    return this.projectedSeq(this.refreshEventProjectionIndex(id, protocolVersion), localSeq);
  }

  /** Resolve one exact peer-facing history coordinate back into the runner's local append-only
   * sequence space. Both the encoded epoch and dense event sequence must still identify the
   * current local generation; a stale or differently projected coordinate fails closed. */
  resolveProjectedHistoryCoordinate(
    id: string,
    projectedEpoch: number,
    projectedSeq: number,
    protocolVersion: number | null | undefined,
  ): { logEpoch: number; seq: number } | null {
    const meta = this.readMeta(id);
    if (!meta) return null;
    const logEpoch = meta.logEpoch ?? 0;
    if (this.projectedHistoryEpoch(logEpoch, protocolVersion) !== projectedEpoch) return null;
    const index = this.refreshEventProjectionIndex(id, protocolVersion);
    if (index.logEpoch !== logEpoch) return null;
    const seq = this.localSeqForProjected(index, projectedSeq);
    return this.projectedSeq(index, seq) === projectedSeq ? { logEpoch, seq } : null;
  }

  /** Project an exact local snapshot at the negotiated socket boundary. */
  projectSnapshotForProtocol(
    snapshot: SessionSnapshot,
    protocolVersion: number | null | undefined,
  ): SessionSnapshot {
    const projected: SessionSnapshot = {
      ...snapshot,
      seq: this.projectedEventSeq(snapshot.id, snapshot.seq, protocolVersion),
      ...(snapshot.historyEpoch === undefined ? {} : {
        historyEpoch: this.projectedHistoryEpoch(snapshot.historyEpoch, protocolVersion),
      }),
    };
    if (!Number.isInteger(protocolVersion) || protocolVersion! < RUNNER_CAPABILITY_MIN_PROTOCOL.sessionWorktrees) {
      delete projected.worktrees;
    }
    return projected;
  }

  /** Project one exact local event for live delivery. An omitted event consumes no peer sequence. */
  projectEventForProtocol(
    id: string,
    event: StoredEvent,
    protocolVersion: number | null | undefined,
  ): StoredEvent | null {
    if (!this.eventProjectionRequired(protocolVersion)) return event;
    return this.projectEventsWithIndex(
      [event],
      protocolVersion,
      this.refreshEventProjectionIndex(id, protocolVersion),
    )[0] ?? null;
  }

  /** Project a batch against one exact derived index snapshot, avoiding repeated metadata/layout
   * and tail reads for every hydrated or correlated result event. */
  projectEventsForProtocol(
    id: string,
    events: StoredEvent[],
    protocolVersion: number | null | undefined,
  ): StoredEvent[] {
    if (!this.eventProjectionRequired(protocolVersion)) return events;
    return this.projectEventsWithIndex(
      events,
      protocolVersion,
      this.refreshEventProjectionIndex(id, protocolVersion),
    );
  }

  /** Legacy whole-history hydration projected into the peer's dense sequence space. */
  readEventsForProtocol(
    id: string,
    afterSeq: number,
    protocolVersion: number | null | undefined,
  ): StoredEvent[] {
    if (!this.eventProjectionRequired(protocolVersion)) return this.readEvents(id, afterSeq);
    const index = this.refreshEventProjectionIndex(id, protocolVersion);
    if (afterSeq >= this.projectedSeq(index, index.localTail)) return [];
    const localAfter = this.localSeqForProjected(index, afterSeq);
    return this.projectEventsWithIndex(this.readEvents(id, localAfter), protocolVersion, index);
  }

  /** Indexed history keeps its frozen page contract while omitting reviewed additive events. */
  readEventPageForProtocol(
    id: string,
    request: { afterSeq: number; limit: number; logEpoch?: number; throughSeq?: number },
    protocolVersion: number | null | undefined,
  ): HistoryPageResult {
    try {
      if (!this.eventProjectionRequired(protocolVersion)) {
        const wireEpoch = request.logEpoch;
        if (wireEpoch !== undefined && wireEpoch < SESSION_EVENT_WIRE_EPOCH_FORMAT_OFFSET) {
          throw new HistoryStoreError("history_epoch_changed", "session history projection format changed");
        }
        const localEpoch = wireEpoch === undefined ? undefined
          : Math.floor(
              (wireEpoch - SESSION_EVENT_WIRE_EPOCH_FORMAT_OFFSET) /
                SESSION_EVENT_WIRE_PROJECTION_VARIANTS,
            );
        if (localEpoch !== undefined && this.projectedHistoryEpoch(localEpoch, protocolVersion) !== wireEpoch) {
          throw new HistoryStoreError("history_epoch_changed", "session history projection changed during pagination");
        }
        const result = this.readEventPage(
          id,
          { ...request, ...(localEpoch === undefined ? {} : { logEpoch: localEpoch }) },
        );
        if (!result.ok) return result;
        return {
          ...result,
          page: { ...result.page, logEpoch: this.projectedHistoryEpoch(result.page.logEpoch, protocolVersion) },
        };
      }
      if (!Number.isSafeInteger(request.afterSeq) || request.afterSeq < 0) {
        throw new HistoryStoreError("history_cursor_invalid", "afterSeq must be a non-negative safe integer");
      }
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > HISTORY_PAGE_MAX_EVENTS) {
        throw new HistoryStoreError(
          "history_cursor_invalid",
          `limit must be an integer from 1 to ${HISTORY_PAGE_MAX_EVENTS}`,
        );
      }
      const hasEpoch = request.logEpoch !== undefined;
      const hasThrough = request.throughSeq !== undefined;
      if (hasEpoch !== hasThrough) {
        throw new HistoryStoreError(
          "history_cursor_invalid", "logEpoch and throughSeq must either both be omitted or both be supplied",
        );
      }
      if (hasEpoch && (!Number.isSafeInteger(request.logEpoch) || request.logEpoch! < 0 ||
          !Number.isSafeInteger(request.throughSeq) || request.throughSeq! < 0)) {
        throw new HistoryStoreError("history_cursor_invalid", "history continuation is not a safe integer cursor");
      }
      const index = this.refreshEventProjectionIndex(id, protocolVersion);
      const projectedEpoch = this.projectedHistoryEpoch(index.logEpoch, protocolVersion);
      if (request.logEpoch === undefined) {
        // The underlying page call is intentionally frozen below; prepare/repair its sparse index
        // here so legacy projection does not permanently bypass normal first-page maintenance.
        this.ensureHistoryIndex(id, index.logEpoch, this.historyTail(id));
      }

      if (request.logEpoch !== undefined && request.logEpoch !== projectedEpoch) {
        throw new HistoryStoreError("history_epoch_changed", "session history was reset during pagination");
      }
      const throughSeq = request.throughSeq ?? this.projectedSeq(index, index.localTail);
      if (request.afterSeq > throughSeq) {
        throw new HistoryStoreError("history_cursor_invalid", "history cursor is beyond the frozen durable tail");
      }
      if (request.afterSeq === throughSeq) {
        return {
          ok: true,
          events: [],
          page: { logEpoch: projectedEpoch, throughSeq, nextAfterSeq: request.afterSeq, hasMore: false },
        };
      }
      let localAfter = this.localSeqForProjected(index, request.afterSeq);
      const localThrough = this.localSeqForProjected(index, throughSeq);
      while (localAfter < localThrough) {
        const page = this.readEventPage(id, {
          afterSeq: localAfter,
          limit: request.limit,
          logEpoch: index.logEpoch,
          throughSeq: localThrough,
        });
        if (!page.ok) return page;
        const events = this.projectEventsWithIndex(page.events, protocolVersion, index);
        if (events.length) {
          const nextAfterSeq = events.at(-1)!.seq;
          return {
            ok: true,
            events,
            page: { logEpoch: projectedEpoch, throughSeq, nextAfterSeq, hasMore: nextAfterSeq < throughSeq },
          };
        }
        if (!page.page.hasMore) break;
        localAfter = page.page.nextAfterSeq;
      }
      return {
        ok: true,
        events: [],
        page: { logEpoch: projectedEpoch, throughSeq, nextAfterSeq: request.afterSeq, hasMore: false },
      };
    } catch (error) {
      if (error instanceof HistoryStoreError) return { ok: false, code: error.code, error: error.message };
      return { ok: false, code: "history_corrupt", error: (error as Error).message };
    }
  }

  /** Events with seq > afterSeq, in seq order. */
  readEvents(id: string, afterSeq = 0): StoredEvent[] {
    let sources: HistorySource[];
    try {
      this.recoverHistoryReset(id);
      sources = this.historyLayout(id).sources;
    } catch {
      return [];
    }
    const out: StoredEvent[] = [];
    for (const source of sources) {
      let raw: string;
      try {
        this.verifyHistorySource(source);
        raw = readFileSync(source.path, "utf8");
      } catch { return []; }
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as StoredEvent;
          if (ev.seq > afterSeq) out.push(ev);
        } catch {
          /* legacy whole-history RPC skips a corrupt/partial line exactly as before */
        }
      }
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  /** Protocol-v54 count/byte-bounded forward page. Legacy readEvents deliberately remains unchanged
   * for old control planes; only this path relies on the derived sparse index. */
  readEventPage(
    id: string,
    request: { afterSeq: number; limit: number; logEpoch?: number; throughSeq?: number },
  ): HistoryPageResult {
    let observedEpoch: number | undefined;
    try {
      if (!Number.isSafeInteger(request.afterSeq) || request.afterSeq < 0) {
        throw new HistoryStoreError("history_cursor_invalid", "afterSeq must be a non-negative safe integer");
      }
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > HISTORY_PAGE_MAX_EVENTS) {
        throw new HistoryStoreError(
          "history_cursor_invalid",
          `limit must be an integer from 1 to ${HISTORY_PAGE_MAX_EVENTS}`,
        );
      }
      const hasEpoch = request.logEpoch !== undefined;
      const hasThrough = request.throughSeq !== undefined;
      if (hasEpoch !== hasThrough) {
        throw new HistoryStoreError(
          "history_cursor_invalid",
          "logEpoch and throughSeq must either both be omitted or both be supplied",
        );
      }
      if (
        hasEpoch &&
        (!Number.isSafeInteger(request.logEpoch) || request.logEpoch! < 0 ||
          !Number.isSafeInteger(request.throughSeq) || request.throughSeq! < 0)
      ) {
        throw new HistoryStoreError("history_cursor_invalid", "history continuation is not a safe integer cursor");
      }

      const meta = this.readDiskMeta(id);
      if (!meta) throw new HistoryStoreError("history_cursor_invalid", "session history does not exist");
      const currentEpoch = meta.logEpoch ?? 0;
      observedEpoch = currentEpoch;
      if (hasEpoch && request.logEpoch !== currentEpoch) {
        throw new HistoryStoreError("history_epoch_changed", "session history was reset during pagination");
      }

      const throughSeq = hasThrough ? request.throughSeq! : undefined;
      if (throughSeq !== undefined && request.afterSeq > throughSeq) {
        throw new HistoryStoreError("history_cursor_invalid", "history cursor is beyond the frozen durable tail");
      }
      let tail: HistoryTail;
      let info: HistoryIndexInfo | null;
      let frozenThrough: number;
      if (throughSeq === undefined) {
        tail = this.ensureHistoryIndex(id, currentEpoch, this.historyTail(id));
        frozenThrough = tail.seq;
        info = this.readHistoryIndexInfo(id, currentEpoch);
        if (!info) throw new HistoryStoreError("history_corrupt", "session history index is unavailable");
        this.historyBoundaryCache.set(id, {
          epoch: currentEpoch,
          throughSeq: frozenThrough,
          completeBytes: tail.completeBytes,
        });
      } else {
        const fileBytes = this.historyLayout(id, currentEpoch).totalBytes;
        info = this.readHistoryIndexInfo(id, currentEpoch);
        tail = { seq: throughSeq, completeBytes: 0, fileBytes, lineOffset: 0 };
        frozenThrough = throughSeq;
      }
      if (request.afterSeq > frozenThrough) {
        throw new HistoryStoreError("history_cursor_invalid", "history cursor is beyond the frozen durable tail");
      }

      const cachedBoundary = this.historyBoundaryCache.get(id);
      if (frozenThrough === 0) {
        tail.completeBytes = 0;
      } else if (
        throughSeq !== undefined && cachedBoundary?.epoch === currentEpoch &&
        cachedBoundary.throughSeq === frozenThrough
      ) {
        tail.completeBytes = cachedBoundary.completeBytes;
      } else if (throughSeq !== undefined) {
        const throughEntry = this.findHistoryCheckpoint(id, frozenThrough - 1, info?.count ?? 0);
        const boundary = throughEntry
          ? this.scanCheckpointThrough(id, throughEntry.checkpoint, frozenThrough, tail.fileBytes)
          : { ok: false as const, endedEarly: false };
        if (boundary.ok) {
          tail.completeBytes = boundary.completeBytes;
          this.historyBoundaryCache.set(id, {
            epoch: currentEpoch,
            throughSeq: frozenThrough,
            completeBytes: boundary.completeBytes,
          });
        } else {
          // A frozen chain cannot rebuild through a later oversized/corrupt append. Recover by
          // validating only its authoritative prefix from byte zero.
          tail.completeBytes = this.scanHistoryThrough(id, tail.fileBytes, frozenThrough);
          info = null;
        }
      }

      // A terminal continuation is fast only after proving that its frozen high-water exists.
      if (request.afterSeq === frozenThrough) {
        return {
          ok: true,
          events: [],
          page: { logEpoch: currentEpoch, throughSeq: frozenThrough, nextAfterSeq: request.afterSeq, hasMore: false },
        };
      }

      let checkpointEntry = this.findHistoryCheckpoint(id, request.afterSeq, info?.count ?? 0);
      if (
        checkpointEntry &&
        !this.validateHistoryCheckpoint(id, checkpointEntry.index, tail.fileBytes)
      ) {
        if (throughSeq === undefined) {
          this.rebuildHistoryIndex(id, currentEpoch);
          return this.readEventPage(id, request);
        }
        checkpointEntry = null;
      }
      if (checkpointEntry) {
        const seekThrough = Math.min(
          frozenThrough,
          Math.max(checkpointEntry.checkpoint.seq, request.afterSeq + 1),
        );
        const interval = this.scanCheckpointThrough(
          id,
          checkpointEntry.checkpoint,
          seekThrough,
          tail.fileBytes,
        );
        if (!interval.ok) {
          if (throughSeq === undefined) {
            this.rebuildHistoryIndex(id, currentEpoch);
            return this.readEventPage(id, request);
          }
          checkpointEntry = null;
        }
      }
      const checkpoint = checkpointEntry?.checkpoint;
      const offset = checkpoint?.offset ?? 0;
      let expectedSeq = checkpoint?.seq ?? 1;
      let lastParsedSeq = expectedSeq - 1;
      let responseBytes = 0;
      let stoppedAtBound = false;
      const events: StoredEvent[] = [];
      this.scanHistoryLines(id, offset, tail.completeBytes, (line) => {
        const event = this.parseStoredEvent(line);
        if (event.seq !== expectedSeq) {
          throw new HistoryStoreError(
            "history_corrupt",
            `session history sequence is not contiguous at ${event.seq} (expected ${expectedSeq})`,
          );
        }
        expectedSeq += 1;
        lastParsedSeq = event.seq;
        if (event.seq > frozenThrough) {
          stoppedAtBound = true;
          return false;
        }
        if (event.seq <= request.afterSeq) return;
        if (
          events.length >= request.limit ||
          responseBytes + line.length + (events.length ? 1 : 0) > HISTORY_PAGE_EVENT_BUDGET
        ) {
          stoppedAtBound = true;
          return false;
        }
        const separatorBytes = events.length ? 1 : 0;
        events.push(event);
        responseBytes += line.length + separatorBytes;
        if (events.length >= request.limit) {
          stoppedAtBound = true;
          return false;
        }
      });

      const afterRead = this.readDiskMeta(id);
      if (!afterRead || (afterRead.logEpoch ?? 0) !== currentEpoch) {
        throw new HistoryStoreError("history_epoch_changed", "session history was reset during pagination");
      }
      if (!stoppedAtBound && lastParsedSeq < frozenThrough) {
        throw new HistoryStoreError("history_corrupt", "session history ended before its frozen durable tail");
      }
      const nextAfterSeq = events.at(-1)?.seq ?? request.afterSeq;
      return {
        ok: true,
        events,
        page: {
          logEpoch: currentEpoch,
          throughSeq: frozenThrough,
          nextAfterSeq,
          hasMore: nextAfterSeq < frozenThrough,
        },
      };
    } catch (error) {
      if (observedEpoch !== undefined) {
        const latest = this.readDiskMeta(id);
        if (!latest || (latest.logEpoch ?? 0) !== observedEpoch) {
          return { ok: false, code: "history_epoch_changed", error: "session history was reset during pagination" };
        }
      }
      if (error instanceof HistoryStoreError) return { ok: false, code: error.code, error: error.message };
      return { ok: false, code: "history_corrupt", error: (error as Error).message };
    }
  }

  listSessions(): SessionMeta[] {
    let names: string[];
    try {
      names = readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
    const out: SessionMeta[] = [];
    for (const id of names) {
      const m = this.readMeta(id);
      if (m) out.push(m);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Remove pre-v54 resolved agent environment from durable session metadata. Launch-time
   * resolution reconstructs it from current runner-local config. */
  scrubLegacyAgentEnv(): number {
    let scrubbed = 0;
    for (const meta of this.listSessions()) {
      if (!meta.env || Object.keys(meta.env).length === 0) continue;
      this.patchMeta(meta.sessionId, { env: {} });
      this.flush(meta.sessionId);
      scrubbed++;
    }
    return scrubbed;
  }

  /** Metadata-only snapshots for the pre-negotiation register frame. History stays neutral until
   * the ordered `registered` acknowledgement lets the socket publish one authoritative peer-facing
   * sequence space. This path deliberately performs no history tail or projection scan. */
  registrationSnapshots(): SessionSnapshot[] {
    const snapshots: SessionSnapshot[] = [];
    for (const listed of this.listSessions()) {
      if (this.isDeleted(listed.sessionId)) continue;
      this.recoverHistoryReset(listed.sessionId);
      const meta = this.readMeta(listed.sessionId);
      if (!meta) continue;
      const snapshot = metaToSnapshot(meta, null);
      snapshots.push({ ...snapshot, seq: 0, historyEpoch: undefined });
    }
    return snapshots;
  }

  /** Protocol snapshots for every stored session after the peer version is known. */
  snapshots(
    controlPlaneProtocolVersion: number | null = PROTOCOL_VERSION,
    exactEventSeq = false,
  ): SessionSnapshot[] {
    const snapshots: SessionSnapshot[] = [];
    for (const listed of this.listSessions()) {
      if (this.isDeleted(listed.sessionId)) continue;
      // A reset intent may be published after listSessions read this metadata. Recovery is the
      // commit point, so run it again and re-read the bumped epoch/cleared seq before registering.
      this.recoverHistoryReset(listed.sessionId);
      const meta = this.readMeta(listed.sessionId);
      if (!meta) continue;
      // A crash may lose the debounced metadata flush after events.ndjson was already appended.
      // Registration must advertise the authoritative durable tail or the CP can incorrectly mark
      // a stale cache complete and never open a page chain for those recovered events.
      let durableSeq = meta.seq;
      try {
        durableSeq = this.historyTail(meta.sessionId).seq;
        if (!exactEventSeq) {
          durableSeq = this.projectedEventSeq(meta.sessionId, durableSeq, controlPlaneProtocolVersion);
        }
      } catch {
        // An exact peer can safely retain the metadata high-water. A projected peer cannot: that
        // number belongs to the local sequence space and may exceed every dense cursor it can page.
        // Zero is a conservative same-generation tail; a later page attempt still fails closed.
        if (!exactEventSeq && this.eventProjectionRequired(controlPlaneProtocolVersion)) durableSeq = 0;
      }
      const snapshot = metaToSnapshot(meta, controlPlaneProtocolVersion);
      snapshots.push({
        ...snapshot,
        seq: durableSeq,
        ...(!exactEventSeq && snapshot.historyEpoch !== undefined
          ? { historyEpoch: this.projectedHistoryEpoch(snapshot.historyEpoch, controlPlaneProtocolVersion) }
          : {}),
      });
    }
    return snapshots;
  }

  remove(id: string): void {
    const timer = this.flushTimers.get(id);
    if (timer) clearTimeout(timer);
    this.flushTimers.delete(id);
    this.cache.delete(id);
    this.pending.delete(id);
    this.seqReconciled.delete(id);
    this.checkpointCache.delete(id);
    this.historyLayoutCache.delete(id);
    this.historyIndexInfoCache.delete(id);
    this.historyBoundaryCache.delete(id);
    this.eventProjectionIndexes.delete(id);
    for (const path of [...this.verifiedHistorySegments.keys()]) {
      if (path.startsWith(`${this.dir(id)}\\`) || path.startsWith(`${this.dir(id)}/`)) {
        this.verifiedHistorySegments.delete(path);
      }
    }
    try {
      rmSync(this.dir(id), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  /* ---- per-session writer lock: only the holder drives turns (appends events) ---- */
  /*
   * The lock file holds its owner, and its mtime is the last refresh (#2832). Taking a free lock is one
   * exclusive create, so of two acquirers exactly one wins; like the guard below it is published
   * complete, so a stalled creator's empty lock can never look stale and be taken over. Everything that changes an EXISTING lock
   * (stale takeover, refresh, release) runs inside a guard section: `lock.guard`, recording the
   * holder's pid, process start time and a token, and held only for a few synchronous file operations.
   * The guard is published complete, by hard-linking a fully written temp file into place, so it is
   * never seen empty; an empty or malformed guard is never broken automatically (see
   * lockGuardHolderGone). Inside a section the lock can change only by a free create, which needs it
   * absent, so a takeover that saw it stale replaces exactly that lock, in one rename, and a lock
   * refreshed or released meanwhile is never overwritten. A busy guard is waited on briefly and then
   * fails closed.
   *
   * A guard is broken only when its holder is gone: its pid no longer exists, its pid is this process
   * (sections never overlap here), or it is old and its pid now belongs to a process that started
   * later. A live holder's guard is never broken. Breaking is itself exclusive: a breaker first takes
   * a claim named after the abandoned guard's exact contents, then re-reads the guard and moves it only
   * if it is still that guard. While an abandoned guard is installed, only its claim holder can change
   * that path, so a breaker never moves a newer guard. A claim whose holder died is passed over.
   *
   * The data directory is host-local: pids and start times mean nothing to another machine, so a store
   * shared across hosts would treat a remote guard holder as dead. The runner's data-directory lease
   * keeps one runner per data directory; other processes on the same host are covered.
   */

  /** Try to take the lock for `owner` (e.g. the runner id). Succeeds if free, stale, or already ours. */
  acquireLock(id: string, owner: string): boolean {
    const p = this.lockPath(id);
    const created = this.publishExclusive(p, owner);
    if (created === "created") {
      this.forgetLockedHistoryState(id);
      return true;
    }
    if (created === "failed") return false;
    let outcome: "taken" | "mine" | "busy" | undefined;
    try {
      outcome = this.withLockGuard(id, () => this.takeExistingLock(p, owner));
    } catch {
      return false;
    }
    if (outcome === "taken") this.forgetLockedHistoryState(id);
    return outcome === "taken" || outcome === "mine";
  }

  /** Inside the guard: refresh our own lock, refuse a fresh foreign one, or replace a stale one. */
  private takeExistingLock(p: string, owner: string): "taken" | "mine" | "busy" {
    let mtimeMs: number;
    let holder: string;
    try {
      mtimeMs = statSync(p).mtimeMs;
      holder = readFileSync(p, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "busy";
      // Released since the create above failed: compete for it like any free acquirer.
      return this.publishExclusive(p, owner) === "created" ? "taken" : "busy";
    }
    if (holder === owner) {
      try {
        const now = new Date();
        utimesSync(p, now, now);
      } catch {
        return "busy";
      }
      return "mine";
    }
    if (Date.now() - mtimeMs < LOCK_STALE_MS) return "busy";
    return this.replaceLockFile(p, owner) ? "taken" : "busy";
  }

  /** A new holder must re-derive the append state another process may have changed. */
  private forgetLockedHistoryState(id: string): void {
    this.seqReconciled.delete(id);
    this.checkpointCache.delete(id);
    this.historyLayoutCache.delete(id);
  }

  /** Replace a stale lock in one rename, so it is never absent for a free acquirer to take meanwhile.
   * Windows refuses to replace a file another process has open; retry briefly, then fail closed. */
  private replaceLockFile(p: string, owner: string): boolean {
    const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, owner, { flag: "wx" });
      for (let attempt = 0; ; attempt++) {
        try {
          renameSync(tmp, p);
          return true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) return false;
          sleepSync(2);
        }
      }
    } catch {
      return false;
    } finally {
      try { rmSync(tmp, { force: true }); } catch { /* a stray temp file is inert */ }
    }
  }

  private lockGuardPath(id: string): string {
    return join(this.dir(id), "lock.guard");
  }

  /** Run `section` while holding the session's lock guard, or return undefined when it stays busy. */
  private withLockGuard<T>(id: string, section: () => T): T | undefined {
    const path = this.lockGuardPath(id);
    const token = randomUUID();
    const record = JSON.stringify({ pid: process.pid, start: OWN_PROCESS_START, token });
    const deadline = performance.now() + LOCK_GUARD_WAIT_MS;
    for (;;) {
      const created = this.publishExclusive(path, record);
      if (created === "created") break;
      if (created === "failed") return undefined;
      if (this.reclaimAbandonedLockGuard(path)) continue;
      if (performance.now() >= deadline) return undefined;
      sleepSync(1);
    }
    activeLockGuards.add(token);
    try {
      return section();
    } finally {
      activeLockGuards.delete(token);
      this.releaseLockGuard(path, record);
    }
  }

  /** Create `path` holding `record` only if nothing is there. The record is written to a private temp
   * file first and hard-linked into place, so no reader ever sees the file empty or partial. On a
   * filesystem without hard links this falls back to an exclusive create followed by the write. */
  private publishExclusive(path: string, record: string): "created" | "exists" | "failed" {
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, record, { flag: "wx" });
      linkSync(tmp, path);
      return "created";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return "exists";
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") return "failed";
    } finally {
      try { rmSync(tmp, { force: true }); } catch { /* a stray temp file is inert */ }
    }
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx");
      writeSync(fd, record);
      return "created";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "failed";
    } finally {
      try { if (fd !== undefined) closeSync(fd); } catch { /* the record is written */ }
    }
  }

  /** Remove our own guard; a guard someone else now holds is left alone. */
  private releaseLockGuard(path: string, record: string): void {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (readFileSync(path, "utf8") !== record) return;
        rmSync(path);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        // Windows can refuse while another process reads the guard. A guard left behind names this
        // live process, so other processes fail closed until this process's next section breaks it.
        sleepSync(1);
      }
    }
  }

  /** True when the guard is gone or was abandoned and has now been broken, so a create can retry. */
  private reclaimAbandonedLockGuard(path: string): boolean {
    let raw: string;
    let ageMs: number;
    try {
      raw = readFileSync(path, "utf8");
      ageMs = Date.now() - statSync(path).mtimeMs;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    if (!this.lockGuardHolderGone(parseLockGuard(raw), ageMs)) return false;
    return this.breakLockGuard(path, raw);
  }

  private lockGuardHolderGone(holder: LockGuardRecord | null, ageMs: number): boolean {
    if (holder?.released === true) return true; // a breaker's claim it gave up without moving the guard
    if (!holder || !Number.isSafeInteger(holder.pid) || (holder.pid as number) <= 0 || typeof holder.token !== "string") {
      // Never judged abandoned. Guards are published complete, so this is damage, or a creator on a
      // filesystem without hard links that is (or was) between its create and its write. Breaking it
      // could admit a second holder; leaving it fails closed until the file is deleted by hand.
      return false;
    }
    const pid = holder.pid as number;
    if (pid === process.pid) return !activeLockGuards.has(holder.token);
    try {
      process.kill(pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return true;
      // EPERM: the process exists but belongs to someone else. Anything unexpected: assume alive.
      if (code !== "EPERM") return false;
    }
    if (ageMs < LOCK_GUARD_ABANDONED_MS || typeof holder.start !== "string") return false;
    const start = processStartTime(pid);
    return start !== null && start !== holder.start;
  }

  /** Remove the abandoned guard `observed`, if it is still installed. Only the holder of the claim for
   * that exact guard may move it, and it re-reads the guard first: the abandoned guard's holder is gone
   * and creators cannot replace an existing file, so while it is installed nothing else changes the
   * path. A claim whose holder died, or that its holder released after failing to move the guard, is
   * passed over by the next number. Numbers are never reused while the guard is installed: claims are
   * deleted only once it is gone, and a later breaker then finds it gone on its re-read. */
  private breakLockGuard(path: string, observed: string): boolean {
    const key = createHash("sha256").update(observed).digest("hex").slice(0, 32);
    const claimPrefix = `${path}.break.${key}.`;
    const token = randomUUID();
    const record = JSON.stringify({ pid: process.pid, start: OWN_PROCESS_START, token });
    // Every claim below the highest existing one was already passed over as gone, so start there.
    const first = this.highestLockGuardClaim(path, claimPrefix);
    for (let attempt = first; attempt < first + LOCK_GUARD_BREAK_STEPS; attempt++) {
      const claim = `${claimPrefix}${attempt}`;
      const created = this.publishExclusive(claim, record);
      if (created === "failed") return false;
      if (created === "exists") {
        let raw: string;
        let ageMs: number;
        try {
          raw = readFileSync(claim, "utf8");
          ageMs = Date.now() - statSync(claim).mtimeMs;
        } catch {
          return false; // finished meanwhile; start over from the guard
        }
        if (!this.lockGuardHolderGone(parseLockGuard(raw), ageMs)) return false;
        continue;
      }
      activeLockGuards.add(token);
      let guardGone = false;
      try {
        let current: string;
        try {
          current = readFileSync(path, "utf8");
        } catch (error) {
          guardGone = (error as NodeJS.ErrnoException).code === "ENOENT";
          return false;
        }
        if (current !== observed) {
          guardGone = true; // moved by an earlier breaker; it can never come back
          return false;
        }
        const aside = `${path}.${process.pid}.${token}.broken`;
        renameSync(path, aside);
        guardGone = true;
        rmSync(aside, { force: true });
        return true;
      } catch {
        return false;
      } finally {
        activeLockGuards.delete(token);
        // Once the guard is gone, its claims and the temp files of breakers that died publishing one
        // can go. While it is still installed (a refused rename), only our claim is given up.
        if (guardGone) this.removeLockGuardClaims(path, claimPrefix);
        else this.releaseLockGuardClaim(claim, { pid: process.pid, start: OWN_PROCESS_START, token, released: true });
      }
    }
    return false;
  }

  /** Highest numbered claim for one abandoned guard, or 0 when there is none. */
  private highestLockGuardClaim(path: string, claimPrefix: string): number {
    const prefix = basename(claimPrefix);
    let highest = 0;
    try {
      for (const name of readdirSync(join(path, ".."))) {
        if (!name.startsWith(prefix)) continue;
        const number = name.slice(prefix.length);
        if (/^\d+$/.test(number)) highest = Math.max(highest, Number(number));
      }
    } catch { /* start from 0; existing claims are still checked one by one */ }
    return highest;
  }

  /** Mark our own claim given up, in one rename over it, so its number is never reused. */
  private releaseLockGuardClaim(claim: string, record: LockGuardRecord): void {
    const tmp = `${claim}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(record), { flag: "wx" });
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          renameSync(tmp, claim);
          return;
        } catch {
          // Windows refuses while another breaker reads it. A claim left live names this process, so
          // other processes wait until this process passes over it on its next attempt, or exits.
          sleepSync(1);
        }
      }
    } catch { /* see above */ } finally {
      try { rmSync(tmp, { force: true }); } catch { /* a stray temp file is inert */ }
    }
  }

  private removeLockGuardClaims(path: string, claimPrefix: string): void {
    const prefix = basename(claimPrefix);
    try {
      for (const name of readdirSync(join(path, ".."))) {
        if (name.startsWith(prefix)) rmSync(join(path, "..", name), { force: true });
      }
    } catch { /* best effort: the claims are inert once the guard they name is gone */ }
  }

  /** Take the lock only if no lock file exists, with an exclusive create. A compaction that let the
   * lock go for its copy must never take it back by overwriting or by stale takeover. */
  private acquireFreeLock(id: string, owner: string): boolean {
    if (this.publishExclusive(this.lockPath(id), owner) !== "created") return false;
    this.forgetLockedHistoryState(id);
    return this.ownsLock(id, owner);
  }

  ownsLock(id: string, owner: string): boolean {
    try {
      return readFileSync(this.lockPath(id), "utf8") === owner;
    } catch {
      return false;
    }
  }

  /** Refresh only while `owner` still holds the lock. A stale holder must not overwrite a lock
   * that another process legitimately stole after the stale window elapsed. Only the mtime moves. */
  refreshLock(id: string, owner: string): boolean {
    const p = this.lockPath(id);
    try {
      return this.withLockGuard(id, () => {
        try {
          if (readFileSync(p, "utf8") !== owner) return false;
          const now = new Date();
          utimesSync(p, now, now);
          return true;
        } catch {
          return false;
        }
      }) ?? false;
    } catch {
      return false;
    }
  }

  /** Release the lock ONLY if we still own it — a holder whose lock went stale and was stolen
   * (60s without refresh) must not delete the new owner's lock on its way out. */
  releaseLock(id: string, owner: string): void {
    const p = this.lockPath(id);
    let released: boolean | undefined;
    try {
      released = this.withLockGuard(id, () => {
        try {
          if (readFileSync(p, "utf8") !== owner) return false;
          rmSync(p, { force: true });
          return true;
        } catch {
          return false; // no lock file, or unreadable
        }
      });
    } catch {
      return; // the lock stays and goes stale
    }
    if (released) this.forgetLockedHistoryState(id);
  }

  /** Cross-process lease for a provider cwd or a cleanup operation. Unlike the turn lock, this is
   * held for the provider process lifetime. A crashed manager's lease is reclaimable only after its
   * exact host PID is conclusively absent; PID reuse therefore fails closed by retaining the tree. */
  acquireWorktreeLease(id: string, owner: string, pid = process.pid): boolean {
    const path = this.worktreeLeasePath(id);
    const record = JSON.stringify({ owner, pid });
    for (let attempt = 0; attempt < 2; attempt++) {
      let fd: number | undefined;
      try {
        fd = openSync(path, "wx", 0o600);
        writeFileSync(fd, record);
        closeSync(fd);
        return true;
      } catch (error) {
        if (fd !== undefined) closeSync(fd);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      }
      let existingRaw: string;
      let existing: { owner: string; pid: number };
      try {
        existingRaw = readFileSync(path, "utf8");
        existing = JSON.parse(existingRaw) as { owner: string; pid: number };
        if (existing.owner === owner) return true;
        if (typeof existing.owner !== "string" || !Number.isSafeInteger(existing.pid) || existing.pid <= 0) {
          return false;
        }
      } catch {
        return false;
      }
      try {
        process.kill(existing.pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      }
      try {
        // The dead owner cannot refresh its record. Re-read before removal so a concurrently
        // replaced lease is never unlinked by this stale observer.
        if (readFileSync(path, "utf8") !== existingRaw) return false;
        rmSync(path);
      } catch {
        return false;
      }
    }
    return false;
  }

  /** The current worktree lease record for a session, or null when none is held or it is unreadable. */
  readWorktreeLease(id: string): { owner: string; pid: number } | null {
    try {
      const record = JSON.parse(readFileSync(this.worktreeLeasePath(id), "utf8")) as { owner?: unknown; pid?: unknown };
      if (typeof record.owner !== "string" || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return null;
      return { owner: record.owner, pid: record.pid as number };
    } catch {
      return null;
    }
  }

  /**
   * Hand a lease held by this process from one owner to another without a gap: the file is
   * rewritten in place, so a sibling process never observes it absent. Returns false unless the
   * current record is exactly `{ fromOwner, pid: process.pid }`.
   */
  transferWorktreeLease(id: string, fromOwner: string, toOwner: string): boolean {
    const path = this.worktreeLeasePath(id);
    const current = this.readWorktreeLease(id);
    if (!current || current.owner !== fromOwner || current.pid !== process.pid) return false;
    const staged = `${path}.${process.pid}.${randomUUID()}`;
    try {
      writeFileSync(staged, JSON.stringify({ owner: toOwner, pid: process.pid }), { mode: 0o600 });
      if (readFileSync(path, "utf8") !== JSON.stringify({ owner: fromOwner, pid: process.pid })) {
        rmSync(staged, { force: true });
        return false;
      }
      renameSync(staged, path);
      return true;
    } catch {
      rmSync(staged, { force: true });
      return false;
    }
  }

  releaseWorktreeLease(id: string, owner: string): void {
    const path = this.worktreeLeasePath(id);
    try {
      const record = JSON.parse(readFileSync(path, "utf8")) as { owner?: unknown };
      if (record.owner !== owner) return;
      rmSync(path);
    } catch {
      /* absent, unreadable, or concurrently replaced leases remain fail-closed */
    }
  }
}

/** Map persisted metadata to the protocol snapshot the control plane hydrates from. */
const NATIVE_ELICITATION_OVERLAY_PROTOCOL_VERSION = 66;
const NATIVE_SLASH_COMMAND_OVERLAY_PROTOCOL_VERSION = 74;
const MANAGED_BACKGROUND_JOBS_PROTOCOL_VERSION = RUNNER_CAPABILITY_MIN_PROTOCOL.managedBackgroundDelivery;
const BACKGROUND_WORK_TRACKING_PROTOCOL_VERSION = RUNNER_CAPABILITY_MIN_PROTOCOL.backgroundWorkTracking;
const PROVIDER_HISTORY_QUARANTINE_PROTOCOL_VERSION = RUNNER_CAPABILITY_MIN_PROTOCOL.providerHistoryQuarantine;
const WORKTREE_RECOVERY_PROTOCOL_VERSION = RUNNER_CAPABILITY_MIN_PROTOCOL.worktreeRecovery;

/** Bounded projection of the durable quarantine. Sizes and the offending item's position are
 * structural provider evidence; the retained prompt is reported only as a boolean so its text
 * stays on the runner until a recovered session carries it into a composer draft. */
export function providerHistoryQuarantineView(m: SessionMeta): ProviderHistoryQuarantineView | undefined {
  const block = m.providerHistoryBlock;
  if (!block) return undefined;
  return {
    reason: block.reason,
    detectedAt: block.detectedAt,
    ...(block.recoveryTurn === undefined ? {} : { recoveryTurn: block.recoveryTurn }),
    ...(block.recovery === undefined ? {} : { recovery: block.recovery }),
    ...(block.retry ? { retainedPrompt: true } : {}),
  };
}

export function metaToSnapshot(
  m: SessionMeta,
  controlPlaneProtocolVersion: number | null = PROTOCOL_VERSION,
): SessionSnapshot {
  const nativeElicitation = controlPlaneProtocolVersion != null &&
    controlPlaneProtocolVersion >= NATIVE_ELICITATION_OVERLAY_PROTOCOL_VERSION
    ? m.capabilities?.elicitation
    : undefined;
  // A skill is unambiguous only through runner-minted command authority: a pre-authority peer
  // dispatches by bare name, which a same-named custom prompt would capture.
  const nativeSlashCommands = controlPlaneProtocolVersion != null &&
    controlPlaneProtocolVersion >= NATIVE_SLASH_COMMAND_OVERLAY_PROTOCOL_VERSION
    ? controlPlaneProtocolVersion < SESSION_COMMAND_AUTHORITY_PROTOCOL_VERSION
      ? m.sessionSlashCommands?.filter((command) => command.source !== "skill")
      : m.sessionSlashCommands
    : undefined;
  const config = controlPlaneProtocolVersion != null &&
    controlPlaneProtocolVersion >= RUNNER_CAPABILITY_MIN_PROTOCOL.codexServiceTiers
    ? m.config
    : (({ serviceTier: _serviceTier, ...legacyConfig }) => legacyConfig)(m.config);
  // Travels with the slash commands it qualifies; a client that ignores it sends the token as text.
  const nativeUnsupportedSlashCommands = nativeSlashCommands !== undefined
    ? m.sessionUnsupportedSlashCommands
    : undefined;
  const nativeCapabilities: SessionCapabilityOverlay | undefined =
    nativeElicitation !== undefined || nativeSlashCommands !== undefined
      ? {
          ...(nativeElicitation !== undefined ? { elicitation: nativeElicitation } : {}),
          ...(nativeSlashCommands !== undefined ? { slashCommands: nativeSlashCommands } : {}),
          ...(nativeUnsupportedSlashCommands?.length
            ? { unsupportedSlashCommands: nativeUnsupportedSlashCommands }
            : {}),
        }
      : undefined;
  return {
    id: m.sessionId,
    controlPlaneLaunchId: m.controlPlaneLaunchId,
    ...(runnerSupportsProtocol(controlPlaneProtocolVersion, "sessionRoleConversion") &&
      m.roleConversion && m.roleConversion.state !== "retiring" ? {
        roleConversionReceipt: { conversionId: m.roleConversion.command.conversionId, state: m.roleConversion.state },
      } : {}),
    workspaceId: m.workspaceId,
    agentId: m.agentId,
    providerAccountId: m.providerAccountId,
    providerAccountLabel: m.providerAccountLabel,
    providerAccountAutomaticallySelected: runnerSupportsProtocol(
      controlPlaneProtocolVersion,
      "automaticProviderAccountSwitch",
    ) ? m.providerAccountAutomaticallySelected : undefined,
    providerAccountSwitchFailure: controlPlaneProtocolVersion != null &&
      controlPlaneProtocolVersion >= RUNNER_CAPABILITY_MIN_PROTOCOL.sessionProviderAccountSwitch
      ? m.providerAccountSwitchFailure ?? null
      : undefined,
    title: m.title,
    titleSource: m.titleSource,
    providerUpdatedAt: m.providerUpdatedAt,
    status: m.status,
    capacityWait: runnerSupportsProtocol(controlPlaneProtocolVersion, "machineRunnerCapacity")
      ? m.capacityWait
      : undefined,
    driver: m.driver,
    useWorktree: m.worktreePath != null,
    worktreePath: m.worktreePath,
    worktrees: runnerSupportsProtocol(controlPlaneProtocolVersion, "worktreeTeardownPorts")
      ? m.worktrees
      : runnerSupportsProtocol(controlPlaneProtocolVersion, "worktreeSetup")
        ? m.worktrees?.map(({ teardown: _teardown, portBlock: _portBlock, ...worktree }) => worktree)
        : m.worktrees?.map(({ setup: _setup, teardown: _teardown, portBlock: _portBlock, ...worktree }) => worktree),
    executionTarget: m.executionTarget,
    executionHandoff: m.executionHandoff,
    workspacePath: m.repoPath, // the box's launch dir — lets the CP restart ad-hoc/box-owned sessions
    config,
    resolvedModel: m.resolvedModel,
    acpSessionContext: m.acpSessionOverrides,
    // ACP owns complete per-session controls. Native drivers publish only the elicitation overlay;
    // their model/effort/mode/modalities remain live runner-catalog truth after CLI upgrades.
    agentCapabilities: m.driver === "acp"
      ? m.capabilities
      : nativeCapabilities,
    preview: m.preview,
    pendingApproval: m.pendingApproval,
    // A supporting peer always hears the current truth, including its absence: `null` is how a
    // restart onto a fresh provider conversation clears the control plane's guard. `undefined` is
    // reserved for peers and registration snapshots that carry no information at all.
    historyQuarantine: controlPlaneProtocolVersion != null &&
      controlPlaneProtocolVersion >= PROVIDER_HISTORY_QUARANTINE_PROTOCOL_VERSION
      ? providerHistoryQuarantineView(m) ?? null
      : undefined,
    worktreeRecovery: controlPlaneProtocolVersion != null &&
      controlPlaneProtocolVersion >= WORKTREE_RECOVERY_PROTOCOL_VERSION
      ? m.worktreeRecovery ?? null
      : undefined,
    backgroundWorkState: m.backgroundWorkState,
    backgroundWorkTracking: controlPlaneProtocolVersion != null &&
      controlPlaneProtocolVersion >= BACKGROUND_WORK_TRACKING_PROTOCOL_VERSION
      ? (m.driver === "claude-code" ? "managed" : "untracked")
      : undefined,
    backgroundJobs: controlPlaneProtocolVersion != null &&
      controlPlaneProtocolVersion >= MANAGED_BACKGROUND_JOBS_PROTOCOL_VERSION &&
      m.backgroundJobs !== undefined
      ? m.backgroundJobs.map((job) => ({
          id: job.id,
          parentTurnId: job.parentTurnId,
          runnerId: job.runnerId,
          workspaceId: job.workspaceId,
          launchType: job.launchType,
          registeredAt: job.registeredAt,
          terminalStatus: job.terminalStatus,
          terminalObservedAt: job.terminalObservedAt,
          continuationRequired: job.continuationRequired,
          continuationId: job.continuationId,
          continuationQueuedAt: job.continuationQueuedAt,
          continuationSubmittedAt: job.continuationSubmittedAt,
          continuationAcceptedAt: job.continuationAcceptedAt,
          continuationMissingResultAt: runnerSupportsProtocol(
            controlPlaneProtocolVersion,
            "backgroundMissingResultRecovery",
          ) ? job.continuationMissingResultAt : undefined,
          assistantResultPersistedAt: job.assistantResultPersistedAt,
          endedBy: job.endedBy && runnerSupportsProtocol(controlPlaneProtocolVersion, "backgroundJobEndedBy")
            ? projectBackgroundJobEnd(job.endedBy)
            : undefined,
        }))
      : undefined,
    tokensIn: m.tokensIn,
    tokensOut: m.tokensOut,
    contextTokensUsed: m.contextTokensUsed,
    contextWindow: m.contextWindow,
    costUsd: m.costUsd,
    ...(m.costReconciliationRevision ? { costReconciliationRevision: m.costReconciliationRevision } : {}),
    ...(m.costReconciliationIdentity ? { costReconciliationIdentity: m.costReconciliationIdentity } : {}),
    ...(m.costReconciliationDeltaUsd !== undefined ? { costReconciliationDeltaUsd: m.costReconciliationDeltaUsd } : {}),
    ...(m.costReconciliationRepairId ? { costReconciliationRepairId: m.costReconciliationRepairId } : {}),
    ...(m.driver === "claude-code" && m.claudeUsageCheckpoint?.accountingScope ? { costIsEstimate: true as const } : {}),
    adopted: isAdoptedSession(m),
    seq: m.seq,
    historyEpoch: m.logEpoch ?? 0,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}
