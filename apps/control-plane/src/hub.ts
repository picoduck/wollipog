/**
 * Connection hub. Two responsibilities:
 *  1. Track live runner websockets so the control plane can ROUTE commands
 *     (start_session, prompt, …) down to the runner that owns a session.
 *  2. Fan UI-relevant changes (runner/session/run upserts + events) out to every
 *     connected UI websocket, and serve an initial snapshot to new UI clients.
 *
 * The DB is the source of truth; the hub broadcasts deltas built from it.
 */

import type {
  ControlPlaneToRunner,
  ControlPlaneToUi,
  AdoptSessionResultMessage,
  GitActionResultMessage,
  GenerateSessionTitleResultMessage,
  EditQueuedPromptResultMessage,
  SessionNamingCustomModelResultMessage,
  SessionWorktreeResultMessage,
  ForkResultMessage,
  HostActionResultMessage,
  InterruptTurnResultMessage,
  ListDirectoryResultMessage,
  ListExternalSessionsResultMessage,
  ListSessionFilesResultMessage,
  LogoutAgentResultMessage,
  AcpRegistryApprovalResultMessage,
  QueuedPromptView,
  ReadQueuedPromptResultMessage,
  ReadSessionFileResultMessage,
  ReprocessSessionResultMessage,
  ResolveSteeringAttemptResultMessage,
  RewindResultMessage,
  ShellOpenResultMessage,
  SkillsStateMessage,
  PodContextEntry,
  RunView,
  PodView,
  ProjectView,
  SessionEvent,
  SessionEventPayload,
  SessionHistoryResultMessage,
  SessionHistoryPageResultMessage,
  SessionReminderView,
  SessionReminderWakeReason,
  SessionView,
  SubscriptionUsageRefreshResultMessage,
  SteerSessionResultMessage,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { AuthPrincipal } from "./identity.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID } from "./identity.js";

export function reminderWakeReasonForEvent(
  payload: SessionEventPayload,
): Exclude<SessionReminderWakeReason, "scheduled"> | null {
  if (payload.kind === "permission_request" ||
      (payload.kind === "status" && payload.status === "input_required")) return "approval";
  if (payload.kind === "question_request") return "question";
  if (payload.kind === "error" || (payload.kind === "status" && payload.status === "failed")) return "failure";
  if (payload.kind === "background_continuation_delivered") return "background_job";
  if (payload.kind === "agent_response_completed" ||
      (payload.kind === "agent_message" && payload.final === true)) return "agent_response";
  return null;
}

export class RunnerRequestTimeoutError extends Error {
  override readonly name = "RunnerRequestTimeoutError";

  constructor() {
    super("runner did not respond in time");
  }
}

export class RunnerRequestNotSentError extends Error {
  override readonly name = "RunnerRequestNotSentError";

  constructor() {
    super("runner is offline");
  }
}

export function isRunnerRequestTimeoutError(error: unknown): error is RunnerRequestTimeoutError {
  return error instanceof RunnerRequestTimeoutError;
}

export function isRunnerRequestNotSentError(error: unknown): error is RunnerRequestNotSentError {
  return error instanceof RunnerRequestNotSentError;
}

export interface Socket {
  send(data: string, onComplete?: (error?: Error) => void): void;
  /** Bytes already queued by the WebSocket implementation. Test doubles may omit this; production
   * UI and runner sockets expose the live ws.bufferedAmount value. */
  readonly bufferedAmount?: number;
  /** Production ws sends complete asynchronously. Synchronous test doubles omit this. */
  readonly asyncDelivery?: boolean;
  close?(code?: number, reason?: string): void;
  /** Force-drop the transport without a close handshake. Used to reap a half-open runner socket: a
   * graceful close() waits on a peer reply that a dead connection never sends (~30s ws timeout),
   * whereas terminate() emits 'close' at once so onGone marks the runner offline promptly. */
  terminate?(): void;
}

export const MAX_UI_BUFFERED_BYTES = 8 * 1024 * 1024;
export const MAX_UI_QUEUED_MESSAGES = 512;
export const MAX_UI_SUBSCRIPTION_UPDATES_PER_WINDOW = 32;
export const UI_SUBSCRIPTION_RATE_WINDOW_MS = 10_000;
export const MAX_UI_SUBSCRIPTION_ADMISSION_KEYS = 4_096;
export const UI_SUBSCRIPTION_ADMISSION_TTL_MS = 60_000;
export const MAX_UI_CLIENTS = 256;
export const MAX_UI_CLIENTS_PER_ADMISSION_KEY = 8;
export const MAX_UI_CONNECTION_STARTS_PER_WINDOW = 16;
export const MAX_UI_CONNECTION_STARTS_GLOBAL_PER_WINDOW = 256;
export const UI_CONNECTION_RATE_WINDOW_MS = 10_000;
export const MAX_UI_BACKGROUND_OBSERVATIONS_PER_CONNECTION = 1_024;
export const MAX_UI_BACKGROUND_OBSERVATIONS_PER_WINDOW = 128;
export const UI_BACKGROUND_OBSERVATION_RATE_WINDOW_MS = 10_000;

interface OutboundFrame {
  data: string;
  bytes: number;
  coalesceKey?: string;
}

/** Per-UI-client metadata: which paired device (if any) authenticated the socket, and how to
 * force-close it — so revoking a device immediately severs its live stream. */
interface UiClientInfo {
  deviceId: string | null;
  principal?: AuthPrincipal;
  visibleSessionIds?: Set<string>;
  visibleRunnerIds?: Set<string>;
  visibleProjectIds?: Set<string>;
  subscribedSessionIds?: Set<string>;
  subscribedPodIds?: Set<string>;
  close: (code?: number, reason?: string) => void;
  outbound?: OutboundFrame[];
  queuedBytes?: number;
  sending?: boolean;
  lastSubscriptionRevision?: number;
  observedBackgroundDeliveryKeys?: Set<string>;
  backgroundObservationWindowStartedAt?: number;
  backgroundObservationsInWindow?: number;
}

interface UiSubscriptionAdmission {
  windowStartedAt: number;
  updatesInWindow: number;
  lastSeenAt: number;
}

export interface HubOptions {
  /** Production uses the exported hard ceiling; a smaller value makes LRU behavior testable. */
  uiSubscriptionAdmissionMaxKeys?: number;
  /** Connection ceilings are configurable only so deterministic unit tests can use tiny bounds. */
  maxUiClients?: number;
  maxUiClientsPerAdmissionKey?: number;
  maxUiConnectionStartsPerWindow?: number;
  maxUiConnectionStartsGlobalPerWindow?: number;
}

export type UiSubscriptionApplyResult =
  | { ok: true; sessionIds: string[]; podIds: string[] }
  | { ok: false; reason: "client_missing" | "stale_revision" | "rate_limited" };

/** Correlated runner replies the hub awaits (all carry `requestId`). A skills_state is only
 * correlatable when it echoes a solicited sync's requestId; unsolicited ones never enter here. */
export type RunnerRequestResult =
  | (SkillsStateMessage & { requestId: string })
  | GitActionResultMessage
  | AdoptSessionResultMessage
  | ForkResultMessage
  | SessionHistoryResultMessage
  | SessionHistoryPageResultMessage
  | ReprocessSessionResultMessage
  | ListExternalSessionsResultMessage
  | ListDirectoryResultMessage
  | ListSessionFilesResultMessage
  | LogoutAgentResultMessage
  | AcpRegistryApprovalResultMessage
  | ReadSessionFileResultMessage
  | RewindResultMessage
  | ShellOpenResultMessage
  | HostActionResultMessage
  | InterruptTurnResultMessage
  | ResolveSteeringAttemptResultMessage
  | ReadQueuedPromptResultMessage
  | EditQueuedPromptResultMessage
  | SubscriptionUsageRefreshResultMessage
  | SteerSessionResultMessage
  | GenerateSessionTitleResultMessage
  | SessionNamingCustomModelResultMessage
  | SessionWorktreeResultMessage;

interface PendingRequest {
  runnerId: string;
  waiters: Array<{
    resolve: (result: RunnerRequestResult) => void;
    reject: (err: Error) => void;
  }>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class Hub {
  private readonly uiClients = new Map<Socket, UiClientInfo>();
  /** Process-lifetime admission state. Keeping it outside UiClientInfo prevents reconnects or
   * parallel sockets from replenishing one authenticated caller's authorization-query budget. */
  private readonly uiSubscriptionAdmissions = new Map<string, UiSubscriptionAdmission>();
  private readonly uiSubscriptionAdmissionMaxKeys: number;
  private readonly maxUiClients: number;
  private readonly maxUiClientsPerAdmissionKey: number;
  private readonly uiConnectionAdmissions = new Map<string, UiSubscriptionAdmission>();
  private uiConnectionGlobalAdmission: UiSubscriptionAdmission | undefined;
  private readonly maxUiConnectionStartsPerWindow: number;
  private readonly maxUiConnectionStartsGlobalPerWindow: number;
  private readonly runnerSockets = new Map<string, Socket>();
  /** In-flight runner request/response calls (git actions), keyed by requestId. */
  private readonly pendingRequests = new Map<string, PendingRequest>();
  /** Ephemeral per-session prompt queue state (runner-reported; never persisted). Overlaid onto the
   * DB-built SessionView so queued messages and an interruption hold survive unrelated upserts. */
  private readonly queuedBySession = new Map<string, {
    queue: QueuedPromptView[];
    held: boolean;
    activeTurnId?: string;
  }>();
  /** O(1) projection of the only Session fields that affect Project/Location counts or membership. */
  private readonly sessionProjectState = new Map<string, string>();

  constructor(private readonly db: ControlPlaneDb, options: HubOptions = {}) {
    this.uiSubscriptionAdmissionMaxKeys = Math.max(
      1,
      Math.floor(options.uiSubscriptionAdmissionMaxKeys ?? MAX_UI_SUBSCRIPTION_ADMISSION_KEYS),
    );
    this.maxUiClients = Math.max(1, Math.floor(options.maxUiClients ?? MAX_UI_CLIENTS));
    this.maxUiClientsPerAdmissionKey = Math.max(
      1,
      Math.floor(options.maxUiClientsPerAdmissionKey ?? MAX_UI_CLIENTS_PER_ADMISSION_KEY),
    );
    this.maxUiConnectionStartsPerWindow = Math.max(
      1,
      Math.floor(options.maxUiConnectionStartsPerWindow ?? MAX_UI_CONNECTION_STARTS_PER_WINDOW),
    );
    this.maxUiConnectionStartsGlobalPerWindow = Math.max(
      1,
      Math.floor(options.maxUiConnectionStartsGlobalPerWindow ?? MAX_UI_CONNECTION_STARTS_GLOBAL_PER_WINDOW),
    );
    try {
      for (const session of this.db.listSessions({ includeArchived: true })) {
        this.sessionProjectState.set(session.id, this.projectStateKey(session));
      }
    } catch {
      // Narrow test doubles that exercise runner-only behavior intentionally omit session reads.
    }
  }

  /* ----------------------------- Runners --------------------------------- */

  attachRunner(runnerId: string, socket: Socket): void {
    const previous = this.runnerSockets.get(runnerId);
    this.runnerSockets.set(runnerId, socket);
    if (previous && previous !== socket) previous.close?.(1008, "runner credential replaced");
  }

  /** Immediately sever the current connection — after credential revocation, or when a liveness
   * sweep judges the socket dead (`terminate`). Either way the WebSocket close event reaches onGone,
   * which does the offline/session/shell/box cleanup. */
  closeRunner(runnerId: string, reason = "runner credential revoked", options: { terminate?: boolean } = {}): boolean {
    const socket = this.runnerSockets.get(runnerId);
    if (!socket) return false;
    // Preserve the current-socket identity until the WebSocket close event reaches onGone.
    // That shared path must detach it and perform offline/session/shell/box cleanup. Pre-deleting
    // here makes the close look stale and silently skips every durable disconnect side effect.
    if (options.terminate && socket.terminate) socket.terminate();
    else socket.close?.(1008, reason);
    return true;
  }

  /**
   * Detach a runner's socket. Returns true only when `socket` was still the CURRENT one —
   * a stale close (the runner reconnected first; this is the OLD socket going away) returns
   * false, and the caller must skip every disconnect side effect (offline marking, queue
   * clearing, session failing): those would clobber the live replacement connection.
   * In-flight requests are only rejected on a current-socket detach for the same reason —
   * they ride the replacement socket after a reconnect.
   */
  detachRunner(runnerId: string, socket: Socket): boolean {
    if (this.runnerSockets.get(runnerId) !== socket) return false;
    this.runnerSockets.delete(runnerId);
    // Fail any in-flight requests waiting on this runner instead of letting them hang
    // until their timeout fires.
    for (const [requestId, p] of this.pendingRequests) {
      if (p.runnerId !== runnerId) continue;
      clearTimeout(p.timer);
      this.pendingRequests.delete(requestId);
      for (const waiter of p.waiters) {
        waiter.reject(new Error("runner disconnected before the request completed (it may or may not have run)"));
      }
    }
    return true;
  }

  /** True while `socket` is the runner's live connection — messages from a replaced (stale)
   * socket must be dropped even though it once authenticated as this runner. */
  isCurrentRunnerSocket(runnerId: string, socket: Socket): boolean {
    return this.runnerSockets.get(runnerId) === socket;
  }

  isRunnerOnline(runnerId: string): boolean {
    return this.runnerSockets.has(runnerId);
  }

  sendToRunner(runnerId: string, msg: ControlPlaneToRunner): boolean {
    const socket = this.runnerSockets.get(runnerId);
    if (!socket) return false;
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch {
      // Keep the current-socket identity until the ordinary close handler runs. Pre-deleting here
      // makes onGone treat the close as stale and skips every durable disconnect side effect.
      try {
        if (socket.close) socket.close(1011, "runner send failed");
        else socket.terminate?.();
      } catch {
        // A broken close implementation must not turn a best-effort send into a control-plane
        // exception. Force-drop when possible; its close event still follows the shared teardown.
        try {
          socket.terminate?.();
        } catch {
          // The send already failed; callers receive false while teardown remains best-effort for
          // malformed test doubles or nonstandard WebSocket implementations.
        }
      }
      return false;
    }
  }

  /** Send one bounded runner frame and wait until the WebSocket implementation has flushed it.
   * High-volume protocols use this instead of synchronously enqueueing an aggregate catalog. */
  sendToRunnerAndWait(
    runnerId: string,
    msg: ControlPlaneToRunner,
    maxBufferedBytes: number,
    timeoutMs = 30_000,
  ): Promise<boolean> {
    const socket = this.runnerSockets.get(runnerId);
    if (!socket) return Promise.resolve(false);
    const data = JSON.stringify(msg);
    const bytes = Buffer.byteLength(data, "utf8");
    if ((socket.bufferedAmount ?? 0) + bytes > maxBufferedBytes) return Promise.resolve(false);
    // Narrow synchronous test doubles have no delivery callback. Preserve their established
    // behavior while production runner sockets take the flow-controlled callback path below.
    if (!socket.asyncDelivery) return Promise.resolve(this.sendToRunner(runnerId, msg));
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try {
          if (socket.terminate) socket.terminate();
          else socket.close?.(1013, "runner send timed out");
        } catch { /* timeout still releases the caller's retained frame */ }
        finish(false);
      }, Math.max(1, timeoutMs));
      timer.unref?.();
      try {
        socket.send(data, (error) => {
          if (!error) {
            finish(this.runnerSockets.get(runnerId) === socket);
            return;
          }
          try {
            if (socket.close) socket.close(1011, "runner send failed");
            else socket.terminate?.();
          } catch {
            try { socket.terminate?.(); } catch { /* best-effort shared close path */ }
          }
          finish(false);
        });
      } catch {
        try {
          if (socket.close) socket.close(1011, "runner send failed");
          else socket.terminate?.();
        } catch {
          try { socket.terminate?.(); } catch { /* best-effort shared close path */ }
        }
        finish(false);
      }
    });
  }

  /**
   * Send a request that expects a correlated reply (e.g. a git action) and await
   * it. `msg.requestId` must match the id the runner echoes in its result.
   */
  requestFromRunner(
    runnerId: string,
    requestId: string,
    msg: ControlPlaneToRunner,
    timeoutMs = 30_000,
  ): Promise<RunnerRequestResult> {
    return new Promise((resolve, reject) => {
      const existing = this.pendingRequests.get(requestId);
      if (existing) {
        if (existing.runnerId !== runnerId) return reject(new Error("request id is already in use by another runner"));
        existing.waiters.push({ resolve, reject });
        return;
      }
      const pending: PendingRequest = { runnerId, waiters: [{ resolve, reject }], timer: undefined };
      this.pendingRequests.set(requestId, pending);
      this.armRunnerRequestTimeout(requestId, pending, timeoutMs);
      if (!this.sendToRunner(runnerId, msg)) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(requestId);
        reject(new RunnerRequestNotSentError());
      }
    });
  }

  /** Extend one exact request's inactivity deadline after verified protocol progress. */
  refreshRunnerRequestTimeout(runnerId: string, requestId: string, timeoutMs = 30_000): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending || pending.runnerId !== runnerId) return false;
    this.armRunnerRequestTimeout(requestId, pending, timeoutMs);
    return true;
  }

  private armRunnerRequestTimeout(requestId: string, pending: PendingRequest, timeoutMs: number): void {
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (this.pendingRequests.get(requestId) !== pending) return;
      this.pendingRequests.delete(requestId);
      for (const waiter of pending.waiters) waiter.reject(new RunnerRequestTimeoutError());
    }, Math.max(1, timeoutMs));
  }

  /** Join an already-dispatched durable request without sending it again. Steering duplicates use
   * this to share the original receipt while preserving exactly-once admission. */
  waitForRunnerRequest(runnerId: string, requestId: string): Promise<RunnerRequestResult> {
    return new Promise((resolve, reject) => {
      const pending = this.pendingRequests.get(requestId);
      if (!pending || pending.runnerId !== runnerId) {
        reject(new Error("runner request is no longer in flight"));
        return;
      }
      pending.waiters.push({ resolve, reject });
    });
  }

  /** Cancel one exact correlated request without waiting for its transport timeout. */
  cancelRunnerRequest(runnerId: string, requestId: string, error = new Error("runner request was cancelled")): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending || pending.runnerId !== runnerId) return false;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);
    for (const waiter of pending.waiters) waiter.reject(error);
    return true;
  }

  /** Resolve a pending runner request with its result (git_result / session_history_result). */
  resolveRunnerRequest(result: RunnerRequestResult, sourceRunnerId?: string): boolean {
    const pending = this.pendingRequests.get(result.requestId);
    if (!pending || (sourceRunnerId !== undefined && pending.runnerId !== sourceRunnerId)) return false;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(result.requestId);
    for (const waiter of pending.waiters) waiter.resolve(result);
    return true;
  }

  /* ------------------------------- UI ------------------------------------ */

  addUiClient(
    client: Socket,
    info: UiClientInfo = { deviceId: null, close: () => {} },
    now = Date.now(),
  ): boolean {
    // Enforce both bounds before any principal-scoped list is materialized. Otherwise one paired
    // device could retain unbounded snapshots/visibility sets and stay in legacy global fan-out by
    // opening sockets that never send a subscription frame.
    if (this.uiClients.size >= this.maxUiClients) return false;
    const admissionKey = this.uiSubscriptionAdmissionKey(info);
    let matchingClients = 0;
    for (const existing of this.uiClients.values()) {
      if (this.uiSubscriptionAdmissionKey(existing) === admissionKey) matchingClients++;
      if (matchingClients >= this.maxUiClientsPerAdmissionKey) return false;
    }
    if (!this.admitUiConnectionStart(info, now)) return false;
    const runners = info.principal ? this.db.listRunnersForPrincipal(info.principal) : this.db.listRunners();
    const sessions = info.principal ? this.db.listSessionsForPrincipal(info.principal) : this.db.listSessions();
    const projects = info.principal ? this.db.listProjectsForPrincipal(info.principal, true) : this.db.listProjects(true);
    const globalAdmin = info.principal === undefined || this.isGlobalAdmin(info.principal);
    const reminderUserId = info.principal === undefined ? LOCAL_OWNER_USER_ID
      : info.principal.kind === "human" ? info.principal.userId : null;
    const reminders = reminderUserId === null ? [] : this.db.listSessionReminders(reminderUserId)
      .filter((reminder) => info.principal === undefined || this.db.canAccessSession(info.principal, reminder.sessionId));
    info.visibleRunnerIds = new Set(runners.map((runner) => runner.runnerId));
    info.visibleSessionIds = new Set(sessions.map((session) => session.id));
    info.visibleProjectIds = new Set(projects.map((project) => project.id));
    this.uiClients.set(client, info);
    const snapshot: ControlPlaneToUi = {
      type: "snapshot",
      capabilities: {
        sessionSubscriptions: true,
        boundedDelivery: true,
        paginatedSessionHistory: true,
        projects: true,
        createProjectLocations: true,
        accessScopeManagement: true,
        nativeTuiLaunch: true,
        stopBeforeArchive: true,
        stopFailureRecovery: true,
        sessionReminders: true,
      },
      runners,
      boxes: globalAdmin ? this.db.listBoxes() : [],
      sessions: sessions.map((s) => this.withQueue(s)),
      projects,
      reminders,
      runs: globalAdmin ? this.db.listRuns() : [],
      pods: globalAdmin ? this.db.listPods() : [],
    };
    this.safeSend(client, snapshot);
    return true;
  }

  removeUiClient(client: Socket): void {
    const info = this.uiClients.get(client);
    if (!info) return;
    this.uiClients.delete(client);
    // A ws send callback closes over `info`. It may be delayed indefinitely (or never fire) after
    // a transport close, so release every queued payload here rather than waiting for that callback.
    info.outbound = [];
    info.queuedBytes = 0;
    info.sending = false;
    info.visibleSessionIds?.clear();
    info.visibleRunnerIds?.clear();
    info.visibleProjectIds?.clear();
    info.subscribedSessionIds?.clear();
    info.subscribedPodIds?.clear();
    info.observedBackgroundDeliveryKeys?.clear();
  }

  /** Replace the high-volume live stream selection. Undefined means a pre-subscription dashboard
   * and deliberately keeps legacy fan-out; an explicit empty set means metadata-only. Authorization
   * is still rechecked for every message, so a guessed id never grants future access. */
  setUiSessionSubscriptions(
    client: Socket,
    revision: number,
    sessionIds: readonly string[],
    podIds: readonly string[],
    now = Date.now(),
  ): UiSubscriptionApplyResult {
    const info = this.uiClients.get(client);
    if (!info) return { ok: false, reason: "client_missing" };
    if (info.lastSubscriptionRevision !== undefined && revision <= info.lastSubscriptionRevision) {
      return { ok: false, reason: "stale_revision" };
    }
    if (!this.admitUiSubscription(info, now)) {
      return { ok: false, reason: "rate_limited" };
    }

    const acceptedSessionIds = [...new Set(info.principal
      ? sessionIds.filter((sessionId) => this.db.canAccessSession(info.principal!, sessionId))
      : sessionIds)].sort();
    const acceptedPodIds = [...new Set(info.principal && !this.isGlobalAdmin(info.principal) ? [] : podIds)].sort();
    info.subscribedSessionIds = new Set(acceptedSessionIds);
    info.subscribedPodIds = new Set(acceptedPodIds);
    info.lastSubscriptionRevision = revision;
    this.safeSend(client, {
      type: "session_subscriptions_applied",
      revision,
      sessionIds: acceptedSessionIds,
      podIds: acceptedPodIds,
    });
    return { ok: true, sessionIds: acceptedSessionIds, podIds: acceptedPodIds };
  }

  /** Record receipt of a durable continuation projection by this authenticated dashboard. This
   * does not claim an OS notification was displayed or that a human opened it. */
  acknowledgeUiBackgroundDelivery(
    client: Socket,
    sessionId: string,
    continuationId: string,
    now = Date.now(),
  ): boolean {
    const info = this.uiClients.get(client);
    if (!info) return false;
    if (!Number.isSafeInteger(now) || now < 0) return false;
    if (info.backgroundObservationWindowStartedAt === undefined ||
        now < info.backgroundObservationWindowStartedAt ||
        now - info.backgroundObservationWindowStartedAt >= UI_BACKGROUND_OBSERVATION_RATE_WINDOW_MS) {
      info.backgroundObservationWindowStartedAt = now;
      info.backgroundObservationsInWindow = 0;
    }
    if ((info.backgroundObservationsInWindow ?? 0) >=
        MAX_UI_BACKGROUND_OBSERVATIONS_PER_WINDOW) return false;
    info.backgroundObservationsInWindow = (info.backgroundObservationsInWindow ?? 0) + 1;
    if (info.principal && !this.db.canAccessSession(info.principal, sessionId)) return false;
    const key = `${sessionId}\u0000${continuationId}`;
    const observed = info.observedBackgroundDeliveryKeys ??= new Set();
    if (observed.has(key)) return false;
    if (observed.size >= MAX_UI_BACKGROUND_OBSERVATIONS_PER_CONNECTION) {
      const oldest = observed.values().next().value;
      if (oldest !== undefined) observed.delete(oldest);
    }
    observed.add(key);
    const changed = this.db.acknowledgeBackgroundDelivery(sessionId, continuationId, now);
    if (changed) this.sessionChangedById(sessionId);
    return changed;
  }

  private uiSubscriptionAdmissionKey(info: UiClientInfo): string {
    const principal = info.principal;
    const deviceId = info.deviceId ?? (principal?.kind === "human" ? principal.deviceId : null);
    if (deviceId) return JSON.stringify(["device", deviceId]);
    if (principal?.kind === "human") {
      return JSON.stringify(["human", principal.organizationId, principal.userId]);
    }
    if (principal?.kind === "agent") {
      return JSON.stringify(["agent", principal.organizationId, principal.actorId]);
    }
    // Runtime loopback clients normally carry the local owner principal. Conservatively sharing one
    // bucket keeps legacy/test callers without identity from bypassing admission through reconnects.
    return '["fallback","local-legacy"]';
  }

  private refreshRateWindow(admission: UiSubscriptionAdmission, now: number): void {
    admission.lastSeenAt = now;
    if (now < admission.windowStartedAt || now - admission.windowStartedAt >= UI_CONNECTION_RATE_WINDOW_MS) {
      admission.windowStartedAt = now;
      admission.updatesInWindow = 0;
    }
  }

  private admitUiConnectionStart(info: UiClientInfo, now: number): boolean {
    let global = this.uiConnectionGlobalAdmission;
    if (!global) {
      global = { windowStartedAt: now, updatesInWindow: 0, lastSeenAt: now };
      this.uiConnectionGlobalAdmission = global;
    }
    this.refreshRateWindow(global, now);

    for (const [key, admission] of this.uiConnectionAdmissions) {
      if (now - admission.lastSeenAt < UI_SUBSCRIPTION_ADMISSION_TTL_MS) break;
      this.uiConnectionAdmissions.delete(key);
    }
    const key = this.uiSubscriptionAdmissionKey(info);
    let admission = this.uiConnectionAdmissions.get(key);
    if (admission) {
      this.uiConnectionAdmissions.delete(key);
      this.uiConnectionAdmissions.set(key, admission);
    } else {
      while (this.uiConnectionAdmissions.size >= this.uiSubscriptionAdmissionMaxKeys) {
        const oldest = this.uiConnectionAdmissions.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.uiConnectionAdmissions.delete(oldest);
      }
      admission = { windowStartedAt: now, updatesInWindow: 0, lastSeenAt: now };
      this.uiConnectionAdmissions.set(key, admission);
    }
    this.refreshRateWindow(admission, now);
    // Check both buckets before consuming either. A caller already over its own allowance must not
    // be able to exhaust the global bucket with requests that will never be admitted.
    if (global.updatesInWindow >= this.maxUiConnectionStartsGlobalPerWindow ||
        admission.updatesInWindow >= this.maxUiConnectionStartsPerWindow) return false;
    global.updatesInWindow++;
    admission.updatesInWindow++;
    return true;
  }

  private pruneUiSubscriptionAdmissions(now: number): void {
    // Map insertion order is LRU order because every access below moves its entry to the tail.
    for (const [key, admission] of this.uiSubscriptionAdmissions) {
      if (now - admission.lastSeenAt < UI_SUBSCRIPTION_ADMISSION_TTL_MS) break;
      this.uiSubscriptionAdmissions.delete(key);
    }
  }

  private admitUiSubscription(info: UiClientInfo, now: number): boolean {
    this.pruneUiSubscriptionAdmissions(now);
    const key = this.uiSubscriptionAdmissionKey(info);
    let admission = this.uiSubscriptionAdmissions.get(key);
    if (admission) {
      this.uiSubscriptionAdmissions.delete(key);
      admission.lastSeenAt = now;
      this.uiSubscriptionAdmissions.set(key, admission);
    } else {
      while (this.uiSubscriptionAdmissions.size >= this.uiSubscriptionAdmissionMaxKeys) {
        const oldest = this.uiSubscriptionAdmissions.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.uiSubscriptionAdmissions.delete(oldest);
      }
      admission = { windowStartedAt: now, updatesInWindow: 0, lastSeenAt: now };
      this.uiSubscriptionAdmissions.set(key, admission);
    }
    if (now < admission.windowStartedAt ||
        now - admission.windowStartedAt >= UI_SUBSCRIPTION_RATE_WINDOW_MS) {
      admission.windowStartedAt = now;
      admission.updatesInWindow = 0;
    }
    if (admission.updatesInWindow >= MAX_UI_SUBSCRIPTION_UPDATES_PER_WINDOW) return false;
    admission.updatesInWindow++;
    return true;
  }

  /** Sever every live /ui stream authenticated by a now-revoked device. Called right after the
   * device row is deleted, so a lost/stolen phone stops receiving events immediately rather than
   * riding its already-open socket until it happens to drop. */
  closeUiClientsForDevice(deviceId: string): void {
    for (const [client, info] of this.uiClients) {
      if (info.deviceId === deviceId) {
        try {
          info.close();
        } catch {
          /* already closing */
        }
        this.removeUiClient(client);
      }
    }
  }

  /** Scope changes invalidate the client's cached authorization snapshot. Reconnect creates a
   * fresh filtered snapshot, so a revoked team/membership grant cannot continue receiving data. */
  closeScopedUiClients(): void {
    for (const [client, info] of this.uiClients) {
      if (info.principal === undefined || this.isOrganizationAdmin(info.principal)) continue;
      try {
        info.close();
      } catch {
        /* already closing */
      }
      this.removeUiClient(client);
    }
  }

  /** Role changes can turn a socket that connected as admin into a scoped member. Close every
   * cached principal in the organization so no pre-change privilege survives until reconnect. */
  closeOrganizationUiClients(organizationId: string): void {
    for (const [client, info] of this.uiClients) {
      if (info.principal?.organizationId !== organizationId) continue;
      try {
        info.close();
      } catch {
        /* already closing */
      }
      this.removeUiClient(client);
    }
  }

  /* --------------------------- Broadcasts -------------------------------- */

  runnerChanged(runnerId: string): void {
    const runner = this.db.getRunner(runnerId);
    if (runner) this.broadcast({ type: "runner_upsert", runner });
  }

  runnerRemoved(runnerId: string): void {
    this.broadcast({ type: "runner_removed", runnerId }, (_principal, info) => {
      const visible = info.visibleRunnerIds?.has(runnerId) ?? true;
      info.visibleRunnerIds?.delete(runnerId);
      return visible;
    });
  }

  boxChanged(boxId: string): void {
    const box = this.db.getBox(boxId);
    if (box) this.broadcast({ type: "box_upsert", box });
  }

  boxRemoved(boxId: string): void {
    this.broadcast({ type: "box_removed", boxId });
  }

  sessionChanged(session: SessionView, refreshProject = true): void {
    const previousState = this.sessionProjectState.get(session.id);
    const nextState = this.projectStateKey(session);
    this.sessionProjectState.set(session.id, nextState);
    this.broadcast({ type: "session_upsert", session: this.withQueue(session) });
    if (!refreshProject || previousState === nextState) return;
    const previousProjectId = previousState?.split("\u0000", 1)[0] || null;
    if (previousProjectId && previousProjectId !== session.projectId) this.projectChangedById(previousProjectId);
    if (session.projectId) this.projectChangedById(session.projectId);
  }

  private projectStateKey(session: SessionView): string {
    const active = !session.archived && ["queued", "starting", "running", "input_required"].includes(session.status);
    return `${session.projectId ?? ""}\u0000${session.archived ? 1 : 0}\u0000${active ? 1 : 0}` +
      `\u0000${session.projectLocationId ?? ""}`;
  }

  projectChanged(project: ProjectView): void {
    this.broadcast({ type: "project_upsert", project });
  }

  projectChangedById(projectId: string): void {
    if (this.uiClients.size === 0) return;
    const project = this.db.getProject(projectId);
    if (project) this.projectChanged(project);
  }

  projectRemoved(projectId: string): void {
    this.broadcast({ type: "project_removed", projectId }, (_principal, info) => {
      const visible = info.visibleProjectIds?.has(projectId) ?? true;
      info.visibleProjectIds?.delete(projectId);
      return visible;
    });
  }

  sessionChangedById(sessionId: string, refreshProject = true): void {
    const session = this.db.getSession(sessionId);
    if (session) this.sessionChanged(session, refreshProject);
  }

  /** Reconcile the Project-count cache after a database mutation that can change Project
   * membership as a side effect (currently ownership-scope containment). Those mutations are
   * deliberately rare, so a bounded scan is preferable to duplicating the DB's cascade rules in
   * the transport layer. The state map is updated even with no connected dashboards. */
  synchronizeProjectSessionState(): void {
    const liveSessionIds = new Set<string>();
    for (const session of this.db.listSessions({ includeArchived: true })) {
      liveSessionIds.add(session.id);
      if (this.sessionProjectState.get(session.id) !== this.projectStateKey(session)) {
        this.sessionChanged(session);
      }
    }
    for (const sessionId of this.sessionProjectState.keys()) {
      if (!liveSessionIds.has(sessionId)) this.sessionProjectState.delete(sessionId);
    }
  }

  /** Overlay a session's ephemeral prompt queue onto its DB-built view. Suppressed when the runner
   * is offline — a queue left over from a since-disconnected runner is meaningless (its in-memory
   * turns are gone). */
  private withQueue(session: SessionView): SessionView {
    const state = this.queuedBySession.get(session.id);
    if (state && this.isRunnerOnline(session.runnerId)) {
      return {
        ...session,
        ...(state.queue.length ? { queued: state.queue } : {}),
        ...(state.held ? { queueHeld: true } : {}),
        ...(state.activeTurnId ? { activeTurnId: state.activeTurnId } : {}),
      };
    }
    return session;
  }

  /** Runner reported a session's not-yet-started prompt queue (ephemeral); relay to dashboards. */
  setSessionQueue(sessionId: string, queue: QueuedPromptView[], held = false, activeTurnId?: string): void {
    if (queue.length || held || activeTurnId) this.queuedBySession.set(sessionId, { queue, held, activeTurnId });
    else this.queuedBySession.delete(sessionId);
    const session = this.db.getSession(sessionId);
    if (session) this.broadcast({ type: "session_upsert", session: this.withQueue(session) });
  }

  /** Authoritative live turn coordinate. Missing means the runner has no interruptible turn. */
  activeTurnIdForSession(sessionId: string): string | undefined {
    const session = this.db.getSession(sessionId);
    if (!session || !this.isRunnerOnline(session.runnerId)) return undefined;
    return this.queuedBySession.get(sessionId)?.activeTurnId;
  }

  /** Forget queued state for a runner's sessions — its in-memory queues die with the connection, so
   * a fresh register (or a disconnect) must not leave a stale queue showing. Rebroadcasts each
   * affected session: dashboards hold the old queued list in their store, and a session that gets
   * no other upsert (e.g. already terminal) would otherwise show phantom cancelable prompts. */
  clearRunnerQueues(runnerId: string): void {
    for (const id of [...this.queuedBySession.keys()]) {
      const s = this.db.getSession(id);
      if (!s || s.runnerId === runnerId) {
        this.queuedBySession.delete(id);
        if (s) this.broadcast({ type: "session_upsert", session: this.withQueue(s) });
      }
    }
  }

  sessionRemoved(sessionId: string, refreshProject = true): void {
    const previousState = this.sessionProjectState.get(sessionId);
    this.sessionProjectState.delete(sessionId);
    this.queuedBySession.delete(sessionId);
    this.broadcast({ type: "session_removed", sessionId }, (_principal, info) => {
      // Archived rows are omitted from snapshots and enter a dashboard through exact REST lookup,
      // but their authorized stream subscription still proves that client knows the id. Deliver a
      // later deletion to either set so an open archived detail cannot remain stale indefinitely.
      const visible = (info.visibleSessionIds?.has(sessionId) ?? true) ||
        (info.subscribedSessionIds?.has(sessionId) ?? false);
      info.visibleSessionIds?.delete(sessionId);
      return visible;
    });
    if (refreshProject) {
      const previousProjectId = previousState?.split("\u0000", 1)[0] || null;
      if (previousProjectId) this.projectChangedById(previousProjectId);
    }
  }

  private reminderPrincipalMatches(userId: unknown, principal: AuthPrincipal | undefined): boolean {
    if (typeof userId !== "string" || !userId) return false;
    return principal === undefined ? userId === LOCAL_OWNER_USER_ID
      : principal.kind === "human" && principal.userId === userId;
  }

  sessionReminderChanged(userId: string, reminder: SessionReminderView): void {
    this.broadcast({ type: "session_reminder_upsert", userId, reminder });
  }

  sessionReminderRemoved(userId: string, sessionId: string): void {
    this.broadcast({ type: "session_reminder_removed", userId, sessionId });
  }

  fireDueSessionReminders(now = Date.now()): number {
    const fired = this.db.fireDueSessionReminders(now);
    for (const item of fired) this.sessionReminderChanged(item.userId, item.reminder);
    return fired.length;
  }

  /** Relay already-persisted live shell output/exit to subscribed dashboards. */
  shellOutput(sessionId: string, shellId: string, stream: "stdout" | "stderr", data: string, seq?: number): void {
    this.broadcast({ type: "shell_output", sessionId, shellId, stream, data, seq });
  }

  shellExit(sessionId: string, shellId: string, code: number | null, outputSeq?: number): void {
    this.broadcast({ type: "shell_exit", sessionId, shellId, code, outputSeq });
  }

  shellRegistryReconciled(runnerId: string, sessionIds: string[]): void {
    for (const sessionId of new Set(sessionIds)) {
      this.broadcast({ type: "shell_registry_reconciled", runnerId, sessionIds: [sessionId] });
    }
  }

  sessionEvent(event: SessionEvent): void {
    this.broadcast({ type: "session_event", event });
    const reason = reminderWakeReasonForEvent(event.payload);
    if (!reason) return;
    for (const item of this.db.fireSessionRemindersForActivity(event.sessionId, event.seq, reason, event.ts)) {
      this.sessionReminderChanged(item.userId, item.reminder);
    }
  }

  /** A session's whole event log was replaced (reprocess) — dashboards drop + adopt this set. */
  sessionEventsReset(sessionId: string, events: SessionEvent[], eventEpoch?: number): void {
    this.broadcast({ type: "session_events_reset", sessionId, events, eventEpoch });
  }

  runChanged(run: RunView): void {
    this.broadcast({ type: "run_upsert", run });
  }

  runRemoved(runId: string): void {
    this.broadcast({ type: "run_removed", runId });
  }

  podChanged(pod: PodView): void {
    this.broadcast({ type: "pod_upsert", pod });
  }

  podRemoved(podId: string): void {
    this.broadcast({ type: "pod_removed", podId });
  }

  podContextEntry(entry: PodContextEntry): void {
    this.broadcast({ type: "pod_context_entry", entry });
  }

  private isOrganizationAdmin(principal: AuthPrincipal): boolean {
    return principal.kind === "human" && (principal.role === "owner" || principal.role === "admin");
  }

  private isGlobalAdmin(principal: AuthPrincipal): boolean {
    return this.isOrganizationAdmin(principal) && principal.organizationId === PERSONAL_ORGANIZATION_ID;
  }

  private canReceive(principal: AuthPrincipal | undefined, msg: ControlPlaneToUi): boolean {
    if (msg.type === "session_reminder_upsert" || msg.type === "session_reminder_removed") {
      const sessionId = msg.type === "session_reminder_upsert" ? msg.reminder.sessionId : msg.sessionId;
      return this.reminderPrincipalMatches(msg.userId, principal) &&
        (principal === undefined || this.db.canAccessSession(principal, sessionId));
    }
    if (principal === undefined) return true;
    switch (msg.type) {
      case "runner_upsert":
        return this.db.canAccessRunner(principal, msg.runner.runnerId);
      case "runner_removed":
        return false;
      case "session_upsert":
        return this.db.canAccessSession(principal, msg.session.id);
      case "project_upsert":
        return this.db.canAccessProject(principal, msg.project.id);
      case "project_removed":
        return false;
      case "session_removed":
      case "session_event":
      case "session_events_reset":
      case "shell_output":
      case "shell_exit": {
        const sessionId = msg.type === "session_event" ? msg.event.sessionId : msg.sessionId;
        return this.db.canAccessSession(principal, sessionId);
      }
      case "shell_registry_reconciled":
        return msg.sessionIds.every((sessionId) => this.db.canAccessSession(principal, sessionId));
      case "box_upsert":
      case "box_removed":
      case "run_upsert":
      case "run_removed":
      case "pod_upsert":
      case "pod_removed":
      case "pod_context_entry":
        return this.isGlobalAdmin(principal);
      case "snapshot":
        return false;
      case "session_subscriptions_applied":
        return true;
    }
  }

  private isSubscribed(info: UiClientInfo, msg: ControlPlaneToUi): boolean {
    if (info.subscribedSessionIds === undefined) return true;
    switch (msg.type) {
      case "session_event":
        return info.subscribedSessionIds.has(msg.event.sessionId);
      case "session_events_reset":
      case "shell_output":
      case "shell_exit":
        return info.subscribedSessionIds.has(msg.sessionId);
      case "shell_registry_reconciled":
        return msg.sessionIds.some((sessionId) => info.subscribedSessionIds!.has(sessionId));
      case "pod_context_entry":
        return info.subscribedPodIds?.has(msg.entry.podId) ?? false;
      default:
        return true;
    }
  }

  private broadcast(
    msg: ControlPlaneToUi,
    predicate?: (principal: AuthPrincipal | undefined, info: UiClientInfo) => boolean,
  ): void {
    // Serialize ONCE per broadcast — stringifying per client made fan-out cost
    // O(clients × payload) on the streamed-delta hot path.
    if (this.uiClients.size === 0) return;
    const data = JSON.stringify(msg);
    for (const [client, info] of this.uiClients) {
      if (!this.isSubscribed(info, msg)) continue;
      if (!(predicate ? predicate(info.principal, info) : this.canReceive(info.principal, msg))) continue;
      let clientData = data;
      if (msg.type === "runner_upsert" && info.principal !== undefined) {
        const runner = this.db.listRunnersForPrincipal(info.principal)
          .find((item) => item.runnerId === msg.runner.runnerId);
        if (!runner) continue;
        clientData = JSON.stringify({ type: "runner_upsert", runner } satisfies ControlPlaneToUi);
      }
      if (msg.type === "project_upsert" && info.principal !== undefined) {
        const project = this.db.getProjectForPrincipal(info.principal, msg.project.id);
        if (!project) continue;
        clientData = JSON.stringify({ type: "project_upsert", project } satisfies ControlPlaneToUi);
      }
      if (msg.type === "session_upsert") info.visibleSessionIds?.add(msg.session.id);
      if (msg.type === "runner_upsert") info.visibleRunnerIds?.add(msg.runner.runnerId);
      if (msg.type === "project_upsert") info.visibleProjectIds?.add(msg.project.id);
      this.sendRaw(client, clientData, this.coalesceKey(msg));
    }
  }

  private safeSend(client: Socket, msg: ControlPlaneToUi): void {
    this.sendRaw(client, JSON.stringify(msg), this.coalesceKey(msg));
  }

  private coalesceKey(msg: ControlPlaneToUi): string | undefined {
    switch (msg.type) {
      case "runner_upsert": return `runner:${msg.runner.runnerId}`;
      case "box_upsert": return `box:${msg.box.boxId}`;
      case "session_upsert": return `session:${msg.session.id}`;
      case "session_reminder_upsert": return `reminder:${msg.reminder.sessionId}`;
      case "session_reminder_removed": return `reminder:${msg.sessionId}`;
      case "project_upsert": return `project:${msg.project.id}`;
      case "run_upsert": return `run:${msg.run.id}`;
      case "pod_upsert": return `pod:${msg.pod.id}`;
      default: return undefined;
    }
  }

  private evictUiClient(client: Socket, info: UiClientInfo, code: number, reason: string): void {
    this.removeUiClient(client);
    try {
      info.close(code, reason);
    } catch {
      /* already closing */
    }
  }

  private sendRaw(client: Socket, data: string, coalesceKey?: string): void {
    const info = this.uiClients.get(client);
    if (!info) return;
    const frame: OutboundFrame = { data, bytes: Buffer.byteLength(data, "utf8"), ...(coalesceKey ? { coalesceKey } : {}) };
    const outbound = info.outbound ??= [];
    const queuedBytes = info.queuedBytes ?? 0;
    const replaceIndex = coalesceKey === undefined
      ? -1
      : outbound.findIndex((pending) => pending.coalesceKey === coalesceKey);
    const replaced = replaceIndex === -1 ? undefined : outbound[replaceIndex];
    const nextQueuedBytes = queuedBytes - (replaced?.bytes ?? 0) + frame.bytes;
    const nextMessageCount = outbound.length - (replaced ? 1 : 0) + 1;
    const pendingBytes = (client.bufferedAmount ?? 0) + nextQueuedBytes;
    if (pendingBytes > MAX_UI_BUFFERED_BYTES || nextMessageCount > MAX_UI_QUEUED_MESSAGES) {
      this.evictUiClient(client, info, 1013, "client is too slow; reconnect for fresh state");
      return;
    }
    // Move the newest replacement after every intervening lossless frame. This keeps durable event
    // order exact and prevents a future-state upsert from jumping ahead of the event that caused it.
    if (replaceIndex !== -1) outbound.splice(replaceIndex, 1);
    outbound.push(frame);
    info.queuedBytes = nextQueuedBytes;
    this.pumpUiClient(client, info);
  }

  private pumpUiClient(client: Socket, info: UiClientInfo): void {
    if (info.sending || this.uiClients.get(client) !== info) return;
    const frame = info.outbound?.shift();
    if (!frame) return;
    info.queuedBytes = Math.max(0, (info.queuedBytes ?? 0) - frame.bytes);
    info.sending = true;
    const complete = (error?: Error) => {
      if (this.uiClients.get(client) !== info) return;
      info.sending = false;
      if (error) {
        this.evictUiClient(client, info, 1011, "UI stream send failed");
        return;
      }
      this.pumpUiClient(client, info);
    };
    try {
      if (client.asyncDelivery) client.send(frame.data, complete);
      else {
        client.send(frame.data);
        complete();
      }
    } catch {
      this.evictUiClient(client, info, 1011, "UI stream send failed");
    }
  }
}
