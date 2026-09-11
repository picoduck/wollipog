/**
 * The Driver abstraction. SessionManager talks only to this interface, so the
 * runner can drive an agent over ACP (AcpDriver) or via a native CLI harness
 * (ClaudeCodeDriver, CodexDriver) interchangeably. Every driver emits the same
 * normalized SessionEventPayload stream the control plane + UI already consume.
 */

import type {
  AgentCapabilities,
  AcpRuntimeCapabilities,
  AgentContext,
  PromptImage,
  SessionConfig,
  SessionEventPayload,
  AcpSessionContextConfig,
} from "@wollipog/protocol";
import type { SpawnIsolation } from "../spawn.js";
import type { PoisonedProviderHistory } from "./poisoned-provider-history.js";
import type { ProviderRejectionShape } from "./provider-rejection-shape.js";

declare const preparedDriverCommandBrand: unique symbol;

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export interface DriverCommandInput {
  commandName: string;
  argumentText: string;
  executionMode: "passthrough" | "structured";
}

/** Opaque, single-use provider command prepared synchronously by the owning driver. The session
 * manager cannot fabricate one from client-controlled command text. */
export interface PreparedDriverCommand {
  readonly [preparedDriverCommandBrand]: true;
  readonly commandName: string;
  readonly argumentText: string;
  readonly executionMode: "passthrough" | "structured";
}

export interface DriverSteerInput {
  submissionId: string;
  text: string;
  images?: PromptImage[];
  /** Absolute deadline for the whole steering submission, computed once at admission. */
  deadlineAt: number;
}

/** Preserve the provider-delivery boundary: only a confirmed response is accepted, while a
 * transport failure after a possible write remains uncertain and must never be auto-replayed. */
export type DriverSteerResult =
  | { outcome: "accepted"; providerTurnId: string }
  | { outcome: "no_active_turn"; reason: string }
  | { outcome: "stale_turn"; reason: string }
  | { outcome: "rejected"; reason: string }
  | { outcome: "uncertain"; reason: string };

export type DriverBackgroundLaunchType = "agent" | "shell" | "monitor" | "workflow" | "unknown";

export interface DriverBackgroundJob {
  id: string;
  toolUseId?: string;
  launchType: DriverBackgroundLaunchType;
  startedAt: number;
  outputFile?: string;
}

export interface DriverBackgroundTerminalJob extends DriverBackgroundJob {
  status: "completed" | "failed" | "killed";
  terminalAt: number;
  /** True only when the terminal observation arrived outside a provider turn. */
  continuationRequired: boolean;
}

export interface DriverBackgroundWorkUpdate {
  state: "running" | "orphaned" | null;
  pendingTaskIds: string[];
  /** Complete runner-observed pending set, used to durably register work before detachment. */
  jobs?: DriverBackgroundJob[];
  /** Newly terminal jobs; an idle observation becomes an all-pending-work continuation barrier. */
  terminalJobs?: DriverBackgroundTerminalJob[];
  /** Pending ids re-observed from this live provider process, excluding restart seed state. */
  observedTaskIds?: string[];
  oldestPendingAt?: number;
  reason?: "ceiling" | "shutdown" | "process_exit";
}

/** Runner-local provider payload. It is normalized and stripped of account identity before any
 * control-plane transport; drivers intentionally do not know the source/runner wire identity. */
export interface DriverSubscriptionUsageUpdate {
  provider: "codex" | "claude";
  /** `response_observed` carries no payload. It only proves the provider answered, which is what
   * separates a source that has never run from one whose provider reports no allowances at all. */
  kind: "full" | "sparse" | "response_observed";
  payload?: unknown;
}

export interface DriverCallbacks {
  /** Negotiated control-plane capability; absence retains legacy request replacement. */
  supportsWorkerAttention?: () => boolean;
  onEvent: (payload: SessionEventPayload) => void;
  onStderr: (text: string) => void;
  onExit: (code: number | null) => void;
  /** Claude-only lifecycle signal. The session manager persists it before process teardown. */
  onBackgroundWork?: (update: DriverBackgroundWorkUpdate) => void;
  /** Exact provider input acknowledgement for the currently active prompt. */
  onPromptAccepted?: () => void;
  /** A persistent provider began or settled a turn without a runner prompt owning it. The session
   * manager uses this to keep status, approvals, and governance aligned with the live turn. */
  onProviderInitiatedTurn?: (state: "started" | "settled", turnId: string) => void;
  /** The provider proved that its resumable conversation coordinate exists. Drivers must not
   * emit this for a locally minted id until provider initialization confirms it. */
  onSessionEstablished?: (providerSessionId: string) => void;
  /** Provider-confirmed account readiness changes; credentials and identity never cross here. */
  onAuthStatus?: (status: "authenticated" | "unauthenticated") => void;
  /** A harness request proved that its provider credentials need user action. Raw provider text
   * stays inside the driver because it can contain secrets or authorization URLs. */
  onAuthenticationFailure?: () => void;
  /** The provider rejected an item already stored in its own conversation history, before
   * inference. That thread can never accept another turn, so the manager must quarantine it
   * instead of retrying, continuing, or compacting. Structure only: the offending value stays
   * inside the driver. */
  onProviderHistoryUnrecoverable?: (detail: PoisonedProviderHistory) => void;
  /** The provider rejected an indexed item in the request that the history classifier does not
   * recognize. Evidence only: it changes nothing about how the error is handled, and carries a
   * content-free structural shape rather than the provider's message. */
  onUnclassifiedProviderRejection?: (shape: ProviderRejectionShape) => void;
  onAcpCapabilities?: (capabilities: AcpRuntimeCapabilities) => void;
  /** Session-scoped ACP controls/config; never merge these onto the agent row because two live
   * sessions may advertise different modes or commands. */
  onAcpSessionState?: (state: { capabilities: AgentCapabilities; config: SessionConfig }) => void;
  /** Authoritative context gauge: the effective context window the provider is serving plus its
   * current occupancy when known (stable ACP usage; Claude's terminal `result.modelUsage` and last
   * request size), with optional cumulative USD cost. Omitted occupancy leaves the prior gauge. */
  onAcpUsage?: (usage: { contextTokensUsed?: number; contextWindow: number; costUsd?: number }) => void;
  /** Bounded stable provider metadata; null title is the protocol's explicit clear operation. */
  onAcpSessionInfo?: (info: { title?: string | null; providerUpdatedAt?: string }) => void;
  /** Exact provider model resolved from a selected alias for the active native session. */
  onModelResolved?: (model: string) => void;
  /** Provider-reconciled Codex thread service tier. Null clears an unsupported or inherited tier. */
  onServiceTierResolved?: (serviceTier: string | null) => void;
  /** Provider-owned account usage observed on an already-running process. */
  onSubscriptionUsage?: (update: DriverSubscriptionUsageUpdate) => void;
  /** Session-scoped steering availability changed after launch (for example, a persistent
   * transport circuit fell back to a one-shot provider process). */
  onSteeringAvailability?: (available: boolean) => void;
  /** The live provider turn coordinate changed; refresh queue admission immediately. */
  onSteeringTurnChanged?: () => void;
}

export interface DriverOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  config: SessionConfig;
  context: AgentContext;
  /** Optional discovery-verified flags/modes. Absent only for legacy runners/sessions. */
  capabilities?: AgentCapabilities;
  /** An agent-native session/thread id to resume (Claude UUID, Codex thread id, or ACP session id). */
  resumeId?: string;
  /** Runner-owned session directory used for bounded hold sentinels and lifecycle reconciliation. */
  sessionStateDir?: string;
  /** Durable Claude task ids that a resumed transport must reconcile before declaring quiescence. */
  initialBackgroundTaskIds?: string[];
  acpSessionContext?: AcpSessionContextConfig;
  isolation?: SpawnIsolation;
}

export interface Driver {
  /** PID of the underlying process (for process_status), if currently spawned. */
  readonly pid: number | undefined;

  /** Protocol handshake / auth check. Resolves when ready to accept newSession. */
  initialize(): Promise<void>;

  /** Begin a logical session at cwd; returns the agent-native session id. */
  newSession(cwd: string): Promise<string>;

  /** The agent-native resumable id (claude UUID / codex threadId / acp sessionId), or null if not
   * yet established, known, or resumable. Captured into the box session store once established. */
  agentSessionId(): string | null;

  /** Provider-native id of the most recently started turn, when the driver exposes one. */
  agentTurnId?(): string | null;

  /** Why the turn that just settled produced no output, in the provider's own words. Only set for
   * a turn the provider itself ended in error; the session manager attaches it to the durable
   * receipt so a scheduler sees the cause instead of a bare stop reason. */
  lastTurnError?(): string | null;
  /** Active steering coordinate, never a retained completed-turn checkpoint. */
  activeSteeringTurnId?(): string | null;

  /** Mint a provider-native conversation fork through the completed turn. */
  forkSession?(lastTurnId: string, cwd: string): Promise<string>;

  /** Best-effort provider cleanup for a fork that failed before becoming a manager session. */
  archiveSession?(threadId: string): Promise<void>;

  /** Run one user turn to completion; resolves with the stop reason. */
  prompt(text: string, images?: PromptImage[], slashCommand?: string): Promise<StopReason>;

  /** Validate and bind a runner-authorized provider command without suspending. Unsupported
   * transports omit both command methods, and structured execution must fail closed. */
  prepareCommand?(input: DriverCommandInput): PreparedDriverCommand;

  /** Begin an already-prepared provider command synchronously. The returned promise represents
   * turn completion; implementations must reject tokens not minted by this exact driver. */
  invokeCommand?(command: PreparedDriverCommand): Promise<StopReason>;

  /** Incorporate input into the currently active provider turn when the transport can receipt it. */
  steer?(input: DriverSteerInput): Promise<DriverSteerResult>;

  /** Update model/effort/permission for subsequent turns (applied on next turn). */
  setConfig(config: SessionConfig): void | Promise<void>;

  /** Interrupt the in-flight turn (best-effort). */
  cancel(): void;

  /** Answer a pending permission/approval request surfaced via onEvent. Returns true iff a
   * live ask was answered (the response reached the agent); false = nothing was waiting
   * (unknown id / process gone) — the caller must surface that instead of pretending the
   * decision landed. */
  resolvePermission(requestId: string, optionId: string | null): boolean;

  /** Answer a structured agent question (question_request event). Answers are keyed by
   * AgentQuestion.id verbatim. Explicit action distinguishes an accepted all-optional form from
   * dismissal; absent action retains the legacy empty-map convention. Same truthiness contract
   * as resolvePermission. Optional — only drivers with a question channel implement it. */
  answerQuestion?(
    requestId: string,
    answers: Record<string, string | string[]>,
    action?: "submit" | "dismiss",
  ): boolean;

  /** Sign out through a negotiated provider capability. Unsupported drivers omit this method. */
  logout?(): Promise<void>;

  /** Close the active provider session before process disposal when negotiated. */
  close?(): Promise<boolean>;

  /** Dispose the process tree and reject in-flight work. Explicit user lifecycle actions request
   * an immediate kill; runner shutdown may allow a provider-specific graceful interval. */
  dispose(options?: { forceImmediate?: boolean }): void;
}
