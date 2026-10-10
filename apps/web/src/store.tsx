import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
} from "react";
import type {
  BoxView,
  ControlPlaneToUi,
  PodContextEntry,
  PodView,
  ProjectView,
  RunnerView,
  RunView,
  SessionEvent,
  SessionEventsResponse,
  SessionReminderView,
  SessionView,
  ShellOutputChunk,
  ShellStatus,
  UiToControlPlane,
} from "@wollipog/protocol";
import { pendingRequests } from "@wollipog/protocol";
import { CONTROL_PLANE_WS } from "./config.js";
import { expireFollowTailAnchor } from "./useFollowTail.js";
import { DEVICE_TOKEN_CHANGED_EVENT, deviceToken } from "./device-token.js";
import {
  createBrowserUiConnection,
  UI_SOCKET_OPEN,
  type UiConnectionRuntime,
  type UiSocket,
} from "./ui-transport.js";
import { backgroundDeliveryNotifyDecisions, notifier, notifyDecision, type NotifyPayload } from "./notify.js";
import {
  ACTIVITY_BUCKET_MS,
  isSessionStalled,
  rebuildSessionActivity,
  reconcileSessionActivity,
  recordSessionActivity,
  type SessionActivity,
} from "./activity.js";
import { BrowserNavigation, sameView, viewFromNotificationMessage, type View, type ViewNavigation } from "./navigation.js";
import { defaultPublishScheduler, type StorePublishScheduler } from "./store-publish-scheduler.js";
export { animationFramePublishScheduler, setDefaultPublishScheduler, type StorePublishScheduler } from "./store-publish-scheduler.js";
import {
  INBOX_SELECTION_STORAGE_KEY,
  INBOX_SPLIT_RATIO_STORAGE_KEY,
  clampInboxSplitRatio,
  parseInboxSplitRatio,
} from "./inbox.js";
import {
  LOCAL_INSTANCE_SCOPE,
  loadInstanceStorageValue,
  saveInstanceStorageValue,
  type KeyValueStorage,
} from "./instance-storage.js";
import {
  appendOrderedShellChunk,
  markShellScrollbacksIncomplete,
  mergeShellChunks,
  shellStreamMayBeIncomplete,
  type ShellScrollback,
} from "./shells-panel.js";
import {
  EMPTY_UI_SUBSCRIPTION_DELIVERY,
  eventHighWater,
  UiSubscriptionSynchronizer,
  isSessionActivityObservable,
  type UiSubscriptionDeliveryState,
} from "./ui-subscriptions.js";

/** "unauthorized" = the /ui socket was policy-closed (1008): this device needs (re)pairing —
 * the UI offers a paste-a-token card instead of the reconnect banner. */
export type ConnState = "connecting" | "online" | "offline" | "unauthorized";

export type { View } from "./navigation.js";

export interface Filters {
  runnerId: string | null;
  agentId: string | null;
}

export const INBOX_SELECTION_KEY = INBOX_SELECTION_STORAGE_KEY;
export const INBOX_SPLIT_RATIO_KEY = INBOX_SPLIT_RATIO_STORAGE_KEY;
export { clampInboxSplitRatio, parseInboxSplitRatio };

/** The board mode's Machine and Agent filters, persisted per instance so a reload does not
 * silently widen the board back to every machine. */
export const SESSIONS_FILTERS_KEY = "wollipog.sessions.filters";

export function parseSessionFilters(raw: string | null): Filters {
  const fallback: Filters = { runnerId: null, agentId: null };
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as { runnerId?: unknown; agentId?: unknown };
    if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
    return {
      runnerId: typeof value.runnerId === "string" && value.runnerId.length > 0 ? value.runnerId : null,
      agentId: typeof value.agentId === "string" && value.agentId.length > 0 ? value.agentId : null,
    };
  } catch {
    return fallback;
  }
}

export function loadSessionFilters(instanceScope = LOCAL_INSTANCE_SCOPE, storage?: KeyValueStorage): Filters {
  return parseSessionFilters(loadInstanceStorageValue(SESSIONS_FILTERS_KEY, instanceScope, storage));
}

function saveSessionFilters(filters: Filters, instanceScope: string, storage?: KeyValueStorage): void {
  saveInstanceStorageValue(SESSIONS_FILTERS_KEY, JSON.stringify(filters), instanceScope, storage);
}

/** Slightly exceeds the control plane's fixed 10-second admission window. */
export const BACKGROUND_OBSERVATION_RETRY_MS = 10_500;

interface BackgroundObservationAttempt {
  sessionId: string;
  continuationId: string;
  attemptedAt: number;
}

/** Prevent each acknowledgement-triggered session upsert from replaying every still-pending
 * acknowledgement. Failed/rate-limited sends remain recoverable on one bounded retry clock. */
export class BackgroundDeliveryObservationTracker {
  private readonly attempts = new Map<string, BackgroundObservationAttempt>();

  due(sessions: readonly SessionView[], now: number, authoritative = false): UiToControlPlane[] {
    const providedSessionIds = new Set(sessions.map((session) => session.id));
    if (authoritative) {
      for (const [key, attempt] of this.attempts) {
        if (!providedSessionIds.has(attempt.sessionId)) this.attempts.delete(key);
      }
    }
    const messages: UiToControlPlane[] = [];
    for (const session of sessions) {
      const pending = new Map((session.backgroundDeliveries ?? []).flatMap((delivery) =>
        delivery.continuationId && delivery.notificationQueuedAt != null &&
          delivery.dashboardObservedAt == null
          ? [[JSON.stringify([session.id, delivery.continuationId]), delivery.continuationId] as const]
          : []));
      for (const [key, attempt] of this.attempts) {
        if (attempt.sessionId === session.id && !pending.has(key)) this.attempts.delete(key);
      }
      for (const [key, continuationId] of pending) {
        const prior = this.attempts.get(key);
        if (prior && now >= prior.attemptedAt &&
            now - prior.attemptedAt < BACKGROUND_OBSERVATION_RETRY_MS) continue;
        this.attempts.set(key, { sessionId: session.id, continuationId, attemptedAt: now });
        messages.push({ type: "background_delivery_observed", sessionId: session.id, continuationId });
      }
    }
    return messages;
  }

  nextRetryAt(): number | undefined {
    let next: number | undefined;
    for (const attempt of this.attempts.values()) {
      const candidate = attempt.attemptedAt + BACKGROUND_OBSERVATION_RETRY_MS;
      next = next === undefined ? candidate : Math.min(next, candidate);
    }
    return next;
  }

  clear(): void {
    this.attempts.clear();
  }
}

export interface InboxState {
  selectedSessionId: string | null;
  splitKey: string | null;
  splitRatio: number;
  /** The last selected session in each split; `null` is the merged All split. */
  selectedBySplit: Map<string | null, string>;
  /** Transient marker distinguishing an explicit clear from selection awaiting initial repair. */
  selectionCleared?: boolean;
}

function parseNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseInboxSelection(raw: string | null): Pick<InboxState, "selectedSessionId" | "splitKey" | "selectedBySplit"> {
  const fallback = { selectedSessionId: null, splitKey: null, selectedBySplit: new Map<string | null, string>() };
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as {
      selectedSessionId?: unknown;
      splitKey?: unknown;
      selectedBySplit?: unknown;
    };
    if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
    const splitKey = parseNullableString(value.splitKey);
    const selectedSessionId = parseNullableString(value.selectedSessionId);
    const selectedBySplit = new Map<string | null, string>();
    if (Array.isArray(value.selectedBySplit)) {
      for (const entry of value.selectedBySplit) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const key = entry[0] === null ? null : parseNullableString(entry[0]);
        const id = parseNullableString(entry[1]);
        if ((entry[0] === null || key !== null) && id !== null) selectedBySplit.set(key, id);
      }
    }
    // Older/partially-written state may have only the active selection. Repair its split map so
    // switching away and back still restores the same row.
    if (selectedSessionId !== null) selectedBySplit.set(splitKey, selectedSessionId);
    return { selectedSessionId, splitKey, selectedBySplit };
  } catch {
    return fallback;
  }
}

export function loadInboxState(instanceScope = LOCAL_INSTANCE_SCOPE, storage?: KeyValueStorage): InboxState {
  const selection = parseInboxSelection(loadInstanceStorageValue(INBOX_SELECTION_KEY, instanceScope, storage));
  return {
    ...selection,
    splitRatio: parseInboxSplitRatio(loadInstanceStorageValue(INBOX_SPLIT_RATIO_KEY, instanceScope, storage)),
  };
}

function saveInboxState(inbox: InboxState, instanceScope: string, storage?: KeyValueStorage): void {
  saveInstanceStorageValue(INBOX_SELECTION_KEY, JSON.stringify({
    selectedSessionId: inbox.selectedSessionId,
    splitKey: inbox.splitKey,
    selectedBySplit: [...inbox.selectedBySplit],
  }), instanceScope, storage);
  saveInstanceStorageValue(INBOX_SPLIT_RATIO_KEY, String(inbox.splitRatio), instanceScope, storage);
}

/** Identity belongs to one API/view operation, not just a reusable revision tuple. */
export interface EventGapFence {
  sessionId: string;
  eventEpoch: number;
  recoveryGeneration: number;
  recoveryRevision: number;
  operationId: number;
  baseSeq: number;
}

export interface LaterEventGap {
  /** Last contiguous reading seq. The interval after this and before beforeSeq is omitted. */
  afterSeq: number;
  beforeSeq: number;
  /** Latest observed seq is a navigation boundary, never proof of contiguous recovery. */
  tailSeq: number;
  loading: boolean;
  error: string | null;
  fence: EventGapFence;
}

export interface LaterEventsRequest {
  fence: EventGapFence;
  after: number;
  requestId: number;
}

const DEFERRED_TAIL_EVENT_LIMIT = 2_000;
const DEFERRED_TAIL_BYTE_LIMIT = 8 * 1024 * 1024;
interface DeferredLiveBuffer {
  fence: EventGapFence;
  /** Retained bytes may omit oversized frames; their observed seq still cannot become proof. */
  observedTailSeq: number;
  events: SessionEvent[];
  bytes: number;
  byteSizes: Map<number, { event: SessionEvent; bytes: number }>;
}
interface DeferredEventTail extends DeferredLiveBuffer {
  /** The HTTP response proved completeness through this seq, not any later gapped live frame. */
  httpTailSeq: number;
  hasOlder: boolean;
  turnAligned?: boolean;
  pageRequest?: LaterEventsRequest;
}

export interface EventHistoryState {
  eventEpoch: number;
  /** Snapshot/socket generation plus subscription revision fence stale async completions. */
  recoveryGeneration: number;
  recoveryRevision: number;
  /** At least one bounded recovery chain reached its authoritative final page for this epoch. */
  everComplete: boolean;
  /** A first load or reconnect gap recovery is currently in flight. */
  refreshing: boolean;
  error: string | null;
}

/** The loaded slice of a session's history. Opening a session reads a bounded window at the tail
 * rather than the whole log, so the transcript below `baseSeq` is deliberately absent until the
 * reader asks for it. Recovery cursors are contiguous within this window, never from seq 0. */
export interface EventWindowState {
  eventEpoch: number;
  /** Oldest seq loaded for this epoch. Older cached events exist below it when `hasOlder`. */
  baseSeq: number;
  /** A completed provisional REST window's contiguous tail, excluding later live delivery.
   * Kept while this slice stays visible; cache restoration clears its current-view attribution. */
  provisionalRestTail?: { seq: number; recoveryGeneration: number };
  /** Current activity is staged separately; visible events remain the contiguous reading slice. */
  laterGap?: LaterEventGap;
  hasOlder: boolean;
  /** The read that produced this window reached the runner's tail. A budget-expired window reports
   * no older rows while still being a prefix, so completeness is tracked separately. */
  complete: boolean;
  /** Opening-window alignment proves that the visible head is a semantic turn boundary. False
   * means the bounded safety cap was reached and a response at the head may begin above this
   * slice; newer complete turns can still follow it. */
  turnAligned?: boolean;
  loadingOlder: boolean;
  /** A bounded prefix opened at this turn start; unread activity remains an explicit laterGap. */
  openingStartSeq?: number;
  error: string | null;
}

/** Whether the loaded events are known NOT to be the session's whole history. Consumers that treat
 * absence as evidence — receipts, whole-session inventories — must ask this, not `hasOlder`. */
export function isPartialHistory(window: EventWindowState | undefined): boolean {
  return window !== undefined && (window.hasOlder || !window.complete || window.laterGap !== undefined);
}

export interface State {
  conn: ConnState;
  currentTurnOpeningSupported: boolean;
  /** Latched by a policy-closed (1008) /ui socket; cleared only by a successful connect. Keeps
   * the pairing card mounted (draft intact) across the background retries, whose transient
   * "connecting"/"offline" states would otherwise unmount it every cycle. */
  authRequired: boolean;
  /** True after an authoritative UI snapshot has populated the resource maps. */
  snapshotLoaded: boolean;
  /** Monotonic reconnect generation used to revalidate REST-only routed resources. */
  snapshotRevision: number;
  /** Session ids received in this connection's incomplete initial inventory. */
  pendingSnapshotSessionIds?: Set<string>;
  /** True only when the connected control plane advertises an authoritative Project inventory.
   * PR 2 uses false to retain exact runner/workspace grouping against older control planes. */
  projectsSupported: boolean;
  /** False against older control planes whose Project API cannot register a newly browsed folder. */
  projectLocationCreationSupported: boolean;
  /** False against older control planes without explicit, preflighted access-scope mutations. */
  accessScopeManagementSupported: boolean;
  /** True only when New Session can atomically open the separate Native TUI process. */
  nativeTuiLaunchSupported: boolean;
  /** False against older control planes that archive without first proving runtime Stop. */
  stopBeforeArchiveSupported: boolean;
  /** False against older control planes without the correlated Stop recovery route. */
  stopFailureRecoverySupported: boolean;
  /** The control plane restores and relaunches an archived session in one preflighted operation. */
  unarchiveAndRestartSupported: boolean;
  /** True when the control plane provides durable, user-scoped reminder snapshots and deltas. */
  sessionRemindersSupported: boolean;
  /** True when reminder writes may omit a timer and use the explicit Someday schedule kind. */
  indefiniteSessionRemindersSupported: boolean;
  worktreeSetupConfigSupported: boolean;
  /** True when session creation accepts a Session Role independent of the provider permission mode. */
  orchestratorRoleSupported: boolean;
  sessionRoleConversionSupported: boolean;
  runners: Map<string, RunnerView>;
  boxes: Map<string, BoxView>;
  /** Authoritative when the snapshot advertises Project support; empty against legacy control
   * planes, whose exact workspace grouping remains a UI-level fallback. */
  projects: Map<string, ProjectView>;
  sessions: Map<string, SessionView>;
  reminders: Map<string, SessionReminderView>;
  worktreeSetupNoticeDismissals: Set<string>;
  runs: Map<string, RunView>;
  pods: Map<string, PodView>;
  podContext: Map<string, PodContextEntry[]>;
  events: Map<string, SessionEvent[]>;
  /** Fixed-size per-session heartbeat rings. Unlike full timelines, these survive view changes.
   * Updated in place; a batch of socket frames waiting to be published works on its own copy. */
  activity: Map<string, SessionActivity>;
  /** Shared minute clock and derived stall state. The stalled set is replaced only when its
   * membership moves, together with `stalledRevision`. */
  activityNow: number;
  activityObservationStartedAt: Map<string, number>;
  stalledSessionIds: Set<string>;
  stalledRevision: number;
  stalledCount: number;
  /** Event-log epoch associated with each cached timeline. A reprocess increments the epoch and
   * invalidates seq cursors even when the replacement log reuses or exceeds the old sequence. */
  eventEpochs: Map<string, number>;
  /** Recovery presentation state is separate from `events`: an incomplete empty page is not an
   * authoritative empty transcript, and reconnect refresh must not replace cached content. */
  eventHistory: Map<string, EventHistoryState>;
  /** Which slice of each cached timeline is loaded, and whether older turns remain fetchable. */
  eventWindows: Map<string, EventWindowState>;
  /** Hydrated bounded shell scrollback keyed by shellId; kept only for on-screen sessions. */
  shellOutput: Map<string, ShellScrollback>;
  /** Per-session durable registry generation; docks reload metadata/history when it advances. */
  shellRegistryRevision: Map<string, number>;
  streamSubscriptions: UiSubscriptionDeliveryState;
  /** Frozen before a subscription replacement is sent, then published only when that exact
   * revision is acknowledged. Live post-ack events must never advance outage recovery past gaps. */
  streamRecoveryCursors: Map<string, number>;
  pendingStreamRecovery: { revision: number; cursors: Map<string, number> } | null;
  view: View;
  /** In-memory origin for Escape from Settings. Browser history remains an independent push stack. */
  settingsReturnView: View | null;
  inbox: InboxState;
  filters: Filters;
}

type Action =
  | { type: "event_gap_state"; fence: EventGapFence; events: SessionEvent[]; window: EventWindowState;
      settled: boolean; complete?: boolean; advanceCursor?: boolean }
  | { type: "conn"; conn: ConnState; authRequired?: boolean }
  | { type: "msg"; msg: ControlPlaneToUi; now?: number }
  | {
      type: "events_loaded";
      sessionId: string;
      events: SessionEvent[];
      eventEpoch: number;
      recoveryRevision?: number;
      recoveryGeneration: number;
      /** Bounded page chains consume the frozen reconnect cursor only after the final page. */
      recoveryComplete: boolean;
      /** Present only for a bounded opening-window read: whether older cached events remain below
       * this page. Absent marks a forward gap-fill, which never redefines the loaded window. */
      windowHasOlder?: boolean;
      /** Present only for an aligned opening-window read. False means the server kept its bounded
       * count boundary because the turn start was beyond the supported extension. */
      windowTurnAligned?: boolean;
      /** A turn-start prefix excludes distant live rows from its contiguous visible range. */
      windowThroughSeq?: number;
      /** The acknowledged owner may intentionally replace its own reading window. */
      gapWindowFence?: EventGapFence;
    }
  | { type: "events_older_loading"; sessionId: string; eventEpoch: number; requestedBase: number }
  | { type: "events_older_failed"; sessionId: string; eventEpoch: number; requestedBase: number; error: string }
  | {
      type: "events_older_loaded";
      sessionId: string;
      events: SessionEvent[];
      eventEpoch: number;
      hasOlder: boolean;
      /** The window base this page was requested below. A page that outlived its window would
       * otherwise land under a newer one and leave an unreachable hole between them. */
      requestedBase: number;
      /** Present when this older page explicitly requested a semantic turn boundary. */
      turnAligned?: boolean;
    }
  | { type: "subscription_requested"; revision: number; sessionIds: string[] }
  | {
      type: "event_history_loading";
      sessionId: string;
      eventEpoch: number;
      recoveryRevision: number;
      recoveryGeneration: number;
    }
  | { type: "event_history_failed"; sessionId: string; eventEpoch: number; recoveryRevision: number; recoveryGeneration: number; error: string }
  | { type: "shell_stream_incomplete" }
  | { type: "shells_reconciled"; sessionId: string; shellIds: string[] }
  | {
      type: "shell_history_loaded";
      sessionId: string;
      shellId: string;
      chunks: ShellOutputChunk[];
      status: ShellStatus;
      exitCode: number | null;
      truncated: boolean;
    }
  | { type: "shell_output_removed"; shellId: string }
  | { type: "activity_tick"; now: number }
  | { type: "pod_context_loaded"; podId: string; entries: PodContextEntry[] }
  | { type: "navigate"; view: View }
  | { type: "inbox_selection"; sessionId: string | null; splitKey: string | null; persist?: boolean; repair?: boolean }
  | { type: "inbox_split"; splitKey: string | null; persist?: boolean }
  | { type: "inbox_ratio"; ratio: number }
  | { type: "filters"; filters: Partial<Filters> };

/** Event arrays NOT produced by a pure append: merges can REPLACE elements anywhere in the
 * prefix while preserving length and tail identity, so useTimeline's cheap extension check
 * (tail identity) would wrongly keep its incrementally-folded prefix. Tagged here; the hook
 * rebuilds whenever it encounters a tagged array it hasn't folded from scratch. */
const rebuiltArrays = new WeakSet<SessionEvent[]>();
/** Session fields every streamed event moves: activity time, counters, the preview and live usage.
 * The control plane paces changes confined to these (#2760); kept in step with
 * `STREAMING_SESSION_FIELDS` in the control plane's hub. */
const STREAMING_SESSION_FIELDS: ReadonlySet<string> = new Set([
  "updatedAt", "lastEventAt", "messageCount", "preview", "tokensIn", "tokensOut", "contextTokensUsed",
  "costUsd", "toolCallCount",
]);

function sameSessionExceptStreaming(a: SessionView, b: SessionView): boolean {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (STREAMING_SESSION_FIELDS.has(key) || left[key] === right[key]) continue;
    // Each upsert is freshly parsed, so an unchanged nested record is equal but not identical.
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) return false;
  }
  return true;
}

/**
 * Whether two versions of one session differ only in streaming fields (#2872). The session view
 * selects its session with it, so a paced upsert renders only the parts that read those fields
 * through `useLiveSession`.
 */
export function sessionEqualIgnoringStreaming(a: SessionView | undefined, b: SessionView | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && sameSessionExceptStreaming(a, b));
}

/**
 * Whether two session maps differ only in streaming fields (#2763). A selector using it keeps the
 * previous map while an agent streams, so a component that never shows live counters or previews
 * (the app shell's rail counts and titles) does not re-render four times a second per streaming
 * session. Such a component must not read a streaming field from the map it selected.
 */
export function sessionsEqualIgnoringStreaming(
  a: ReadonlyMap<string, SessionView>,
  b: ReadonlyMap<string, SessionView>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [id, session] of a) {
    const other = b.get(id);
    if (other === session) continue;
    if (!other || !sameSessionExceptStreaming(session, other)) return false;
  }
  return true;
}

export function isRebuiltEventsArray(arr: SessionEvent[]): boolean {
  return rebuiltArrays.has(arr);
}
function tagRebuilt(arr: SessionEvent[]): SessionEvent[] {
  rebuiltArrays.add(arr);
  return arr;
}

function mergeEvents(existing: SessionEvent[] | undefined, incoming: SessionEvent[]): SessionEvent[] {
  // Within one CP event epoch, per-session seq is the durable event identity. REST rows can be
  // re-read after a crash/retry with a different SQLite id; id-based dedupe would render both.
  const bySeq = new Map<number, SessionEvent>();
  for (const e of existing ?? []) bySeq.set(e.seq, e);
  for (const e of incoming) bySeq.set(e.seq, e);
  return tagRebuilt([...bySeq.values()].sort((a, b) => a.seq - b.seq));
}

function contiguousEventHighWater(events: readonly SessionEvent[], afterSeq: number): number {
  let cursor = afterSeq;
  for (const event of events) {
    if (event.seq <= cursor) continue;
    if (event.seq !== cursor + 1) break;
    cursor = event.seq;
  }
  return cursor;
}

/** Fast path: live events arrive in seq order, so append in place; only reconcile
 * (dedupe + sort) when something arrives out of order or duplicated. */
function appendEvent(existing: SessionEvent[] | undefined, e: SessionEvent): SessionEvent[] {
  const arr = existing ?? [];
  const last = arr[arr.length - 1];
  if (!last || (e.seq > last.seq && e.id !== last.id)) return [...arr, e];
  return mergeEvents(arr, [e]);
}

function mergePodContext(existing: PodContextEntry[] | undefined, incoming: PodContextEntry[]): PodContextEntry[] {
  const byId = new Map<string, PodContextEntry>();
  for (const entry of existing ?? []) byId.set(entry.id, entry);
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

function emptyScrollback(sessionId: string): ShellScrollback {
  return { sessionId, text: "", total: 0, exited: false, exitCode: null, chunks: [], revision: 0 };
}

/** Which sessions' events the current view actually needs in memory. The board
 * and lists use SessionView.preview, not the raw event stream, so they need none. */
function relevantSessions(state: State): Set<string> {
  const keep = new Set<string>();
  if (state.view.name === "inbox" && state.inbox.selectedSessionId) keep.add(state.inbox.selectedSessionId);
  else if (state.view.name === "session") keep.add(state.view.id);
  else if (state.view.name === "run") {
    state.runs.get(state.view.id)?.sessionIds.forEach((id) => keep.add(id));
  } else if (state.view.name === "pod") {
    state.pods.get(state.view.id)?.members.forEach((member) => keep.add(member.sessionId));
  }
  return keep;
}

function sessionEventEpoch(session: SessionView | undefined): number {
  return session?.eventEpoch ?? 0;
}

function sessionIsStalled(state: State, session: SessionView, now = state.activityNow): boolean {
  const observable = state.conn === "online" &&
    isSessionActivityObservable(state.streamSubscriptions, session.id);
  return isSessionStalled(
    session,
    state.activity.get(session.id),
    now,
    observable,
    state.activityObservationStartedAt.get(session.id),
  );
}

/** Replaces the derived set only when membership moves, with scalar revision/count changes. A
 * published state keeps the set it was published with while later frames wait (#2763). */
function updateSessionStall(state: State, sessionId: string, now = state.activityNow): State {
  const session = state.sessions.get(sessionId);
  const stalled = session !== undefined && !session.archived && sessionIsStalled(state, session, now);
  const wasStalled = state.stalledSessionIds.has(sessionId);
  if (stalled === wasStalled) return state;
  const stalledSessionIds = new Set(state.stalledSessionIds);
  if (stalled) stalledSessionIds.add(sessionId);
  else stalledSessionIds.delete(sessionId);
  return {
    ...state,
    stalledSessionIds,
    stalledRevision: state.stalledRevision + 1,
    stalledCount: stalledSessionIds.size,
  };
}

function clearSessionStall(state: State, sessionId: string): State {
  if (!state.stalledSessionIds.has(sessionId)) return state;
  const stalledSessionIds = new Set(state.stalledSessionIds);
  stalledSessionIds.delete(sessionId);
  return {
    ...state,
    stalledSessionIds,
    stalledRevision: state.stalledRevision + 1,
    stalledCount: stalledSessionIds.size,
  };
}

/** Rare lifecycle/minute-clock scan. The session-event hot path never calls this. */
function scanSessionStalls(state: State, now = state.activityNow): State {
  let stalledSessionIds: Set<string> | null = null;
  const writable = () => (stalledSessionIds ??= new Set(state.stalledSessionIds));
  for (const sessionId of state.stalledSessionIds) {
    if (!state.sessions.has(sessionId)) writable().delete(sessionId);
  }
  for (const session of state.sessions.values()) {
    const stalled = !session.archived && sessionIsStalled(state, session, now);
    const wasStalled = (stalledSessionIds ?? state.stalledSessionIds).has(session.id);
    if (stalled === wasStalled) continue;
    if (stalled) writable().add(session.id);
    else writable().delete(session.id);
  }
  return stalledSessionIds
    ? {
        ...state,
        stalledSessionIds,
        stalledRevision: state.stalledRevision + 1,
        stalledCount: (stalledSessionIds as Set<string>).size,
      }
    : state;
}

function captureRecoveryCursors(state: State, sessionIds: Iterable<string>): Map<string, number> {
  return new Map([...sessionIds].map((sessionId) => {
    const events = state.events.get(sessionId);
    const base = state.eventWindows.get(sessionId)?.baseSeq ?? events?.[0]?.seq ?? 1;
    return [sessionId, events?.length ? contiguousEventHighWater(events, Math.max(0, base - 1)) : 0];
  }));
}

/** Drop a session's frozen recovery cursor when its event log is replaced under a new epoch. The
 * cursor is a seq from the OLD epoch's sequence space and is epoch-less, so carrying it into the
 * new epoch makes the next recovery page ABOVE a stale seq instead of reading the opening tail
 * window — silently truncating or emptying the replacement log. Also clears any not-yet-acked
 * pending cursor so an in-flight subscription cannot republish the stale value. */
function invalidateRecoveryCursor(
  state: State,
  sessionId: string,
): Pick<State, "streamRecoveryCursors" | "pendingStreamRecovery"> {
  const streamRecoveryCursors = new Map(state.streamRecoveryCursors);
  streamRecoveryCursors.delete(sessionId);
  let pendingStreamRecovery = state.pendingStreamRecovery;
  if (pendingStreamRecovery?.cursors.has(sessionId)) {
    const cursors = new Map(pendingStreamRecovery.cursors);
    cursors.delete(sessionId);
    pendingStreamRecovery = { ...pendingStreamRecovery, cursors };
  }
  return { streamRecoveryCursors, pendingStreamRecovery };
}

/** Record which slice a bounded opening-window page loaded. Forward gap-fill pages carry no window
 * meaning and leave the map untouched. */
function applyWindowBase(
  state: State,
  action: Extract<Action, { type: "events_loaded" }>,
): Map<string, EventWindowState> {
  if (action.windowHasOlder === undefined) return state.eventWindows;
  const prior = state.eventWindows.get(action.sessionId);
  const priorValid = prior?.eventEpoch === action.eventEpoch ? prior : undefined;
  const pageBase = action.events[0]?.seq;
  // An empty window (a session with no cached events yet) still records the epoch, so a later
  // older page has a window to attach to.
  if (pageBase === undefined) {
    // An empty retry that reached the tail still settles completeness for the epoch; otherwise a
    // session whose first read expired stays partial forever despite an authoritative answer.
    if (priorValid) {
      if ((!action.recoveryComplete || priorValid.complete) && !priorValid.provisionalRestTail) return state.eventWindows;
      const { provisionalRestTail: _receipt, ...retained } = priorValid;
      const promoted = new Map(state.eventWindows);
      promoted.set(action.sessionId, { ...retained, complete: priorValid.complete || action.recoveryComplete });
      return promoted;
    }
    const eventWindows = new Map(state.eventWindows);
    eventWindows.set(action.sessionId, {
      eventEpoch: action.eventEpoch,
      baseSeq: 0,
      hasOlder: action.windowHasOlder,
      complete: action.recoveryComplete,
      ...(action.windowTurnAligned === undefined ? {} : { turnAligned: action.windowTurnAligned }),
      loadingOlder: false,
      error: null,
    });
    return eventWindows;
  }
  const eventWindows = new Map(state.eventWindows);
  // A window page redefines the slice wholesale: the reducer drops stored rows below its base, so
  // the recorded base must be the page's own — keeping an older base would send the next
  // Load Earlier Activity below rows the store no longer holds and leave a gap between the two.
  eventWindows.set(action.sessionId, {
    eventEpoch: action.eventEpoch,
    baseSeq: pageBase,
    ...(action.recoveryRevision === -1 && action.recoveryComplete &&
      contiguousEventHighWater(action.events, pageBase - 1) === action.events.at(-1)!.seq
      ? { provisionalRestTail: { seq: action.events.at(-1)!.seq, recoveryGeneration: action.recoveryGeneration } }
      : {}),
    hasOlder: action.windowHasOlder,
    // Completeness is monotonic within an epoch: a re-read that reaches the tail settles it, and a
    // later partial read cannot unsettle what was already proven complete.
    complete: action.recoveryComplete || (priorValid?.complete ?? false),
    ...(action.windowTurnAligned === undefined
      ? (priorValid?.turnAligned === undefined ? {} : { turnAligned: priorValid.turnAligned })
      : { turnAligned: action.windowTurnAligned }),
    // An older load in flight against the SAME base is still valid — its page will pass the fence.
    // A base change means the fence will reject that page, and nothing else would ever clear the
    // flag, leaving Load Earlier Activity stuck disabled until remount.
    loadingOlder: priorValid?.baseSeq === pageBase ? priorValid.loadingOlder : false,
    error: priorValid?.error ?? null,
  });
  return eventWindows;
}

/** Where contiguity may start when publishing a recovery cursor. A bounded window deliberately
 * omits everything below its base, so contiguity is measured from the base rather than from the
 * frozen cursor — otherwise the published cursor collapses to 0 and the next recovery would
 * restart at the beginning of the log. Forward gap-fill keeps the frozen cursor exactly. */
function windowContiguityStart(
  eventWindows: Map<string, EventWindowState>,
  sessionId: string,
  eventEpoch: number,
  frozen: number,
): number {
  const window = eventWindows.get(sessionId);
  if (!window || window.eventEpoch !== eventEpoch || window.baseSeq <= 0) return frozen;
  return Math.max(frozen, window.baseSeq - 1);
}

function withLegacyRecovery(state: State): State {
  if (state.streamSubscriptions.mode !== "legacy") return state;
  return { ...state, streamRecoveryCursors: captureRecoveryCursors(state, relevantSessions(state)) };
}

/** Run and Pod comparison columns render whole histories and offer no reach-back control, so a
 * bounded window carried in from the session reader would silently truncate a member forever: fleet
 * recovery only pages ABOVE the cursor that window published. Entering those views drops the
 * partial caches so their own recovery refetches the full history, exactly as before windowing. */
function dropBoundedWindowsForView(state: State): State {
  if (state.view.name !== "run" && state.view.name !== "pod") return state;
  // Any window that is not the whole history, including a budget-expired prefix that reports no
  // older rows: a fleet column recovers only ABOVE the cursor it published.
  const partial = [...state.eventWindows]
    .filter(([, window]) => isPartialHistory(window))
    .map(([sessionId]) => sessionId);
  if (partial.length === 0) return state;
  const events = new Map(state.events);
  const eventHistory = new Map(state.eventHistory);
  const eventWindows = new Map(state.eventWindows);
  const streamRecoveryCursors = new Map(state.streamRecoveryCursors);
  for (const sessionId of partial) {
    events.delete(sessionId);
    eventHistory.delete(sessionId);
    eventWindows.delete(sessionId);
    streamRecoveryCursors.delete(sessionId);
    // The window these rows were held for is being discarded with the cache; keeping the hold would
    // withhold this member's live events from a fleet column that never applies a window.
  }
  return { ...state, events, eventHistory, eventWindows, streamRecoveryCursors };
}

function pruneViewStreams(state: State): State {
  const keep = relevantSessions(state);
  const events = new Map([...state.events].filter(([id]) => keep.has(id)));
  const eventEpochs = new Map([...state.eventEpochs].filter(([id]) => keep.has(id)));
  const eventHistory = new Map([...state.eventHistory].filter(([id]) => keep.has(id)));
  const eventWindows = new Map([...state.eventWindows].filter(([id]) => keep.has(id)));
  const shellOutput = new Map([...state.shellOutput].filter(([, scrollback]) => keep.has(scrollback.sessionId)));
  if (events.size === state.events.size && eventEpochs.size === state.eventEpochs.size &&
      eventHistory.size === state.eventHistory.size &&
      eventWindows.size === state.eventWindows.size &&
      shellOutput.size === state.shellOutput.size) return state;
  return {
    ...state,
    events,
    eventEpochs,
    eventHistory,
    eventWindows,
    shellOutput,
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "event_gap_state": {
      const fence = action.fence;
      const history = state.eventHistory.get(fence.sessionId);
      if (!relevantSessions(state).has(fence.sessionId) || state.snapshotRevision !== fence.recoveryGeneration ||
          sessionEventEpoch(state.sessions.get(fence.sessionId)) !== fence.eventEpoch ||
          history?.recoveryGeneration !== fence.recoveryGeneration || history.recoveryRevision !== fence.recoveryRevision) return state;
      const events = new Map(state.events).set(fence.sessionId, action.events);
      const eventWindows = new Map(state.eventWindows).set(fence.sessionId, action.window);
      const eventHistory = action.settled ? new Map(state.eventHistory).set(fence.sessionId, {
        ...history, refreshing: false, error: null, everComplete: history.everComplete || action.complete === true,
      }) : state.eventHistory;
      let streamRecoveryCursors = state.streamRecoveryCursors;
      if (action.advanceCursor && state.streamSubscriptions.mode === "targeted" &&
          state.streamSubscriptions.appliedRevision === fence.recoveryRevision &&
          state.streamSubscriptions.requestedRevision === fence.recoveryRevision &&
          streamRecoveryCursors.has(fence.sessionId)) {
        streamRecoveryCursors = new Map(streamRecoveryCursors).set(fence.sessionId,
          contiguousEventHighWater(action.events, Math.max(0, action.window.baseSeq - 1)));
      }
      return { ...state, events, eventWindows, eventHistory, streamRecoveryCursors };
    }
    case "conn": {
      let next: State = {
        ...state,
        conn: action.conn,
        ...(action.conn === "online" ? {} : {
          streamSubscriptions: EMPTY_UI_SUBSCRIPTION_DELIVERY,
          streamRecoveryCursors: new Map<string, number>(),
          pendingStreamRecovery: null,
          activityObservationStartedAt: new Map<string, number>(),
        }),
        // A successful connect proves the credential works; otherwise latch an explicit flag
        // and carry the previous one through the retry cycle's connecting/offline states.
        authRequired: action.conn === "online" ? false : (action.authRequired ?? state.authRequired),
      };
      if (action.conn !== "online" && state.stalledSessionIds.size > 0) {
        next = {
          ...next,
          stalledSessionIds: new Set<string>(),
          stalledRevision: state.stalledRevision + 1,
          stalledCount: 0,
        };
      }
      return next;
    }
    case "activity_tick": {
      if (!Number.isSafeInteger(action.now) || action.now < 0) return state;
      if (Math.floor(action.now / ACTIVITY_BUCKET_MS) === Math.floor(state.activityNow / ACTIVITY_BUCKET_MS)) {
        return state;
      }
      return scanSessionStalls({ ...state, activityNow: action.now }, action.now);
    }
    case "navigate": {
      // Drop off-screen streams from visible state. Store retains eligible reader windows in its
      // separately bounded cache, without extending this view's subscriptions or shell output.
      const enteringSettings = state.view.name !== "settings" && action.view.name === "settings";
      const stayingInSettings = state.view.name === "settings" && action.view.name === "settings";
      const settingsReturnView = enteringSettings
        ? state.view
        : stayingInSettings
        ? state.settingsReturnView
        : null;
      const next = dropBoundedWindowsForView({ ...state, view: action.view, settingsReturnView });
      const pruned = pruneViewStreams(next);
      next.events = pruned.events;
      next.eventEpochs = pruned.eventEpochs;
      next.eventHistory = pruned.eventHistory;
      next.eventWindows = pruned.eventWindows;
      next.shellOutput = pruned.shellOutput;
      if (action.view.name === "pod") {
        const podId = action.view.id;
        next.podContext = new Map([...state.podContext].filter(([id]) => id === podId));
      } else {
        next.podContext = new Map();
      }
      return withLegacyRecovery(next);
    }
    case "inbox_selection": {
      if (state.inbox.splitKey === action.splitKey &&
          state.inbox.selectedSessionId === action.sessionId &&
          state.inbox.selectionCleared === (action.sessionId === null && action.repair !== true) &&
          (action.sessionId === null
            ? !state.inbox.selectedBySplit.has(action.splitKey)
            : state.inbox.selectedBySplit.get(action.splitKey) === action.sessionId)) return state;
      const selectedBySplit = new Map(state.inbox.selectedBySplit);
      if (action.sessionId === null) selectedBySplit.delete(action.splitKey);
      else selectedBySplit.set(action.splitKey, action.sessionId);
      const next = {
        ...state,
        inbox: {
          ...state.inbox,
          selectedSessionId: action.sessionId,
          splitKey: action.splitKey,
          selectionCleared: action.sessionId === null && action.repair !== true,
          selectedBySplit,
        },
      };
      return withLegacyRecovery(pruneViewStreams(next));
    }
    case "inbox_split": {
      if (state.inbox.splitKey === action.splitKey) return state;
      const next = {
        ...state,
        inbox: {
          ...state.inbox,
          splitKey: action.splitKey,
          selectedSessionId: state.inbox.selectedBySplit.get(action.splitKey) ?? null,
        },
      };
      return withLegacyRecovery(pruneViewStreams(next));
    }
    case "inbox_ratio": {
      const splitRatio = clampInboxSplitRatio(action.ratio);
      return splitRatio === state.inbox.splitRatio
        ? state
        : { ...state, inbox: { ...state.inbox, splitRatio } };
    }
    case "filters":
      return { ...state, filters: { ...state.filters, ...action.filters } };
    case "events_loaded": {
      // A response started under an older view/ack must not repopulate a cache navigation dropped.
      if (!relevantSessions(state).has(action.sessionId)) return state;
      if (action.eventEpoch !== sessionEventEpoch(state.sessions.get(action.sessionId))) return state;
      if (action.recoveryGeneration !== state.snapshotRevision) return state;
      const recoveryRevision = action.recoveryRevision ?? -1;
      const activeHistory = state.eventHistory.get(action.sessionId);
      if (activeHistory?.recoveryGeneration === action.recoveryGeneration &&
          activeHistory.recoveryRevision !== recoveryRevision) return state;
      const events = new Map(state.events);
      // A window defines the slice that is loaded. While its read was in flight, a hydrating cache
      // republishes its forward rows exactly like live events, so anything that landed BELOW the
      // window's base is history the reader did not ask for — it stays in the cache, reachable
      // through Load Earlier Activity. Rows at or above the base are kept: they are either in the
      // window already or newer than the point-in-time read that produced it, which is exactly the
      // live event a coarser rule would lose.
      const windowBase = action.windowHasOlder !== undefined ? action.events[0]?.seq : undefined;
      const retained = windowBase === undefined && action.windowThroughSeq === undefined
        ? events.get(action.sessionId)
        : events.get(action.sessionId)?.filter((entry) => entry.seq >= (windowBase ?? 0) &&
          (action.windowThroughSeq === undefined || entry.seq <= action.windowThroughSeq));
      const merged = mergeEvents(retained, action.events);
      events.set(action.sessionId, merged);
      const session = state.sessions.get(action.sessionId);
      // A bounded window holds only the newest events, so folding a ring from it would erase
      // buckets this store already observed live from the turns below it. Only a load that speaks
      // for the whole history may rebuild; a windowed one leaves the ring to live observation.
      const priorActivity = state.activity.get(action.sessionId);
      // Partial means "these events are not the whole history": older rows remain, or the read
      // never reached the runner's tail. That is a property of the loaded WINDOW, not of the page
      // in hand — a forward gap-fill extending a partial window carries no window meaning of its
      // own, yet folding a ring from the still-partial array would erase buckets below the base.
      const partialHistory = action.windowHasOlder === true ||
        (action.windowHasOlder !== undefined && !action.recoveryComplete) ||
        isPartialHistory(
          state.eventWindows.get(action.sessionId)?.eventEpoch === action.eventEpoch
            ? state.eventWindows.get(action.sessionId)
            : undefined,
        );
      if (!partialHistory || !priorActivity) {
        const rebuiltActivity = rebuildSessionActivity(
          merged,
          action.eventEpoch,
          priorActivity?.busySince ?? null,
        );
        state.activity.set(action.sessionId, session
          ? reconcileSessionActivity(rebuiltActivity, session, session)
          : rebuiltActivity);
      } else if (session) {
        state.activity.set(action.sessionId, reconcileSessionActivity(priorActivity, session, session));
      }
      const eventEpochs = new Map(state.eventEpochs);
      eventEpochs.set(action.sessionId, action.eventEpoch);
      const eventHistory = new Map(state.eventHistory);
      const priorHistory = eventHistory.get(action.sessionId);
      const currentRecovery = priorHistory?.eventEpoch === action.eventEpoch &&
        priorHistory.recoveryGeneration === action.recoveryGeneration &&
        priorHistory.recoveryRevision === recoveryRevision;
      if (!priorHistory || currentRecovery) {
        eventHistory.set(action.sessionId, {
          eventEpoch: action.eventEpoch,
          recoveryGeneration: action.recoveryGeneration,
          recoveryRevision,
          everComplete: (currentRecovery && priorHistory?.everComplete) || action.recoveryComplete,
          refreshing: !action.recoveryComplete,
          error: null,
        });
      }
      const eventWindows = applyWindowBase(state, action);
      const targetedRecovery = state.streamSubscriptions.mode === "targeted" &&
        action.recoveryRevision === state.streamSubscriptions.appliedRevision &&
        state.streamSubscriptions.appliedRevision === state.streamSubscriptions.requestedRevision;
      const legacyRecovery = state.streamSubscriptions.mode === "legacy" && action.recoveryRevision === 0;
      if (action.recoveryComplete && (targetedRecovery || legacyRecovery) &&
          state.streamRecoveryCursors.has(action.sessionId)) {
        const streamRecoveryCursors = new Map(state.streamRecoveryCursors);
        const frozen = streamRecoveryCursors.get(action.sessionId) ?? 0;
        streamRecoveryCursors.set(
          action.sessionId,
          contiguousEventHighWater(merged, windowContiguityStart(eventWindows, action.sessionId, action.eventEpoch, frozen)),
        );
        return updateSessionStall({
          ...state, events, eventEpochs, eventHistory, eventWindows, streamRecoveryCursors,
        }, action.sessionId);
      }
      return updateSessionStall({
        ...state, events, eventEpochs, eventHistory, eventWindows,
      }, action.sessionId);
    }
    case "events_older_loading": {
      const window = state.eventWindows.get(action.sessionId);
      if (!window || window.eventEpoch !== action.eventEpoch || window.loadingOlder) return state;
      if (window.baseSeq !== action.requestedBase) return state;
      const eventWindows = new Map(state.eventWindows);
      eventWindows.set(action.sessionId, { ...window, loadingOlder: true, error: null });
      return { ...state, eventWindows };
    }
    case "events_older_failed": {
      const window = state.eventWindows.get(action.sessionId);
      if (!window || window.eventEpoch !== action.eventEpoch) return state;
      if (window.baseSeq !== action.requestedBase) return state;
      const eventWindows = new Map(state.eventWindows);
      eventWindows.set(action.sessionId, { ...window, loadingOlder: false, error: action.error });
      return { ...state, eventWindows };
    }
    case "events_older_loaded": {
      // Older-page prepend. Unlike recovery it carries no completion or cursor meaning: the window
      // only grows downward, so neither history state nor the forward gap cursor moves.
      if (!relevantSessions(state).has(action.sessionId)) return state;
      if (action.eventEpoch !== sessionEventEpoch(state.sessions.get(action.sessionId))) return state;
      const window = state.eventWindows.get(action.sessionId);
      if (!window || window.eventEpoch !== action.eventEpoch) return state;
      // The window this page was requested below is gone: a reopen re-read the tail, and the tail
      // may have advanced past it. Prepending here would leave a permanent hole between this page
      // and the current base that no cursor can ever ask for.
      if (window.baseSeq !== action.requestedBase) return state;
      const events = new Map(state.events);
      const merged = mergeEvents(events.get(action.sessionId), action.events);
      events.set(action.sessionId, merged);
      const eventWindows = new Map(state.eventWindows);
      eventWindows.set(action.sessionId, {
        ...window,
        baseSeq: Math.min(window.baseSeq, action.events[0]?.seq ?? window.baseSeq),
        hasOlder: action.hasOlder,
        ...(window.turnAligned === undefined && action.turnAligned === undefined ? {} : {
          turnAligned: action.turnAligned ?? (window.turnAligned === false &&
            (action.events.some((event) => event.payload.kind === "user_message") || !action.hasOlder)
            ? true
            : window.turnAligned),
        }),
        loadingOlder: false,
        error: null,
      });
      return { ...state, events, eventWindows };
    }
    case "event_history_loading": {
      if (!relevantSessions(state).has(action.sessionId) ||
          action.recoveryGeneration !== state.snapshotRevision ||
          action.eventEpoch !== sessionEventEpoch(state.sessions.get(action.sessionId))) return state;
      const eventHistory = new Map(state.eventHistory);
      const prior = eventHistory.get(action.sessionId);
      eventHistory.set(action.sessionId, {
        eventEpoch: action.eventEpoch,
        recoveryGeneration: action.recoveryGeneration,
        recoveryRevision: action.recoveryRevision,
        everComplete: prior?.eventEpoch === action.eventEpoch && prior.everComplete,
        refreshing: true,
        error: null,
      });
      return { ...state, eventHistory };
    }
    case "event_history_failed": {
      if (!relevantSessions(state).has(action.sessionId) ||
          action.recoveryGeneration !== state.snapshotRevision ||
          action.eventEpoch !== sessionEventEpoch(state.sessions.get(action.sessionId))) return state;
      const eventHistory = new Map(state.eventHistory);
      const prior = eventHistory.get(action.sessionId);
      if (!prior || prior.recoveryGeneration !== action.recoveryGeneration ||
          prior.recoveryRevision !== action.recoveryRevision) return state;
      eventHistory.set(action.sessionId, {
        eventEpoch: action.eventEpoch,
        recoveryGeneration: action.recoveryGeneration,
        recoveryRevision: action.recoveryRevision,
        everComplete: prior?.eventEpoch === action.eventEpoch && prior.everComplete,
        refreshing: false,
        error: action.error,
      });
      return { ...state, eventHistory };
    }
    case "subscription_requested": {
      const cursors = captureRecoveryCursors(state, action.sessionIds);
      return {
        ...state,
        streamSubscriptions: { ...state.streamSubscriptions, requestedRevision: action.revision },
        streamRecoveryCursors: new Map(),
        pendingStreamRecovery: { revision: action.revision, cursors },
      };
    }
    case "shell_stream_incomplete":
      return state.shellOutput.size === 0
        ? state
        : { ...state, shellOutput: markShellScrollbacksIncomplete(state.shellOutput) };
    case "shells_reconciled": {
      const live = new Set(action.shellIds);
      const shellOutput = new Map([...state.shellOutput].filter(([shellId, scrollback]) =>
        scrollback.sessionId !== action.sessionId || live.has(shellId)));
      return shellOutput.size === state.shellOutput.size ? state : { ...state, shellOutput };
    }
    case "shell_history_loaded": {
      if (!relevantSessions(state).has(action.sessionId)) return state;
      const prev = state.shellOutput.get(action.shellId) ?? emptyScrollback(action.sessionId);
      const chunks = mergeShellChunks(action.chunks, prev.chunks);
      const text = chunks.map((chunk) => chunk.data).join("");
      const shellOutput = new Map(state.shellOutput);
      shellOutput.set(action.shellId, {
        ...prev,
        text,
        total: text.length,
        chunks,
        revision: prev.revision + 1,
        exited: action.status === "exited",
        exitCode: action.exitCode,
        incomplete: false,
        truncated: action.truncated,
      });
      return { ...state, shellOutput };
    }
    case "shell_output_removed": {
      if (!state.shellOutput.has(action.shellId)) return state;
      const shellOutput = new Map(state.shellOutput);
      shellOutput.delete(action.shellId);
      return { ...state, shellOutput };
    }
    case "pod_context_loaded": {
      if (state.view.name !== "pod" || state.view.id !== action.podId) return state;
      const podContext = new Map(state.podContext);
      podContext.set(action.podId, mergePodContext(podContext.get(action.podId), action.entries));
      return { ...state, podContext };
    }
    case "msg": {
      const msg = action.msg;
      switch (msg.type) {
        case "snapshot": {
          const messageNow = Number.isSafeInteger(action.now) && action.now! >= 0 ? action.now! : state.activityNow;
          const targeted = msg.capabilities?.sessionSubscriptions === true;
          const pods = new Map((msg.pods ?? []).map((pod) => [pod.id, pod]));
          const sessions = msg.sessionsComplete === false ? new Map(state.sessions)
            : new Map<string, SessionView>();
          for (const session of msg.sessions) sessions.set(session.id,session);
          // Live snapshots deliberately omit archived rows. Keep the currently rendered archived
          // detail mounted across reconnect; SessionDetail revalidates it against the exact REST
          // endpoint for this snapshot generation and removes it on an authoritative 404.
          const routedSession = state.view.name === "session" ? state.sessions.get(state.view.id) : undefined;
          if ((routedSession?.archived || msg.sessionsComplete === false && routedSession) && !sessions.has(routedSession.id)) {
            sessions.set(routedSession.id, routedSession);
          }
          const activity = state.activity;
          for (const sessionId of msg.sessionsComplete === false ? [] : [...activity.keys()]) {
            if (!sessions.has(sessionId)) activity.delete(sessionId);
          }
          for (const session of sessions.values()) {
            activity.set(session.id, reconcileSessionActivity(
              state.activity.get(session.id),
              state.sessions.get(session.id),
              session,
            ));
          }
          // An older control plane has no replacement-generation marker. On reconnect, discard the
          // bounded visible cache and recover from zero so a missed reprocess cannot preserve stale
          // epoch-0 events. Current control planes retain same-generation caches incrementally.
          const events = targeted ? new Map(state.events) : new Map<string, SessionEvent[]>();
          const eventEpochs = targeted ? new Map(state.eventEpochs) : new Map<string, number>();
          const eventHistory = new Map(state.eventHistory);
          for (const sessionId of new Set([...events.keys(), ...eventEpochs.keys(), ...eventHistory.keys()])) {
            const session = sessions.get(sessionId);
            if (!session && msg.sessionsComplete === false) continue;
            if (!session) {
              events.delete(sessionId);
              eventEpochs.delete(sessionId);
              eventHistory.delete(sessionId);
              continue;
            }
            const nextEpoch = sessionEventEpoch(session);
            const priorEpoch = state.eventEpochs.get(sessionId) ?? eventHistory.get(sessionId)?.eventEpoch ?? 0;
            if (priorEpoch !== nextEpoch) {
              events.delete(sessionId);
              eventHistory.delete(sessionId);
            } else if (!targeted && (state.events.get(sessionId)?.length ?? 0) > 0) {
              // Legacy snapshots cannot signal a missed reprocess. Their populated event cache is
              // deliberately discarded, so its completion marker must go too or the now-empty UI
              // would falsely render authoritative Empty and enable export during rehydration.
              eventHistory.delete(sessionId);
            } else {
              const history = eventHistory.get(sessionId);
              if (history) eventHistory.set(sessionId, {
                ...history,
                recoveryGeneration: state.snapshotRevision + 1,
                recoveryRevision: -1,
                refreshing: true,
                error: null,
              });
            }
            eventEpochs.set(sessionId, nextEpoch);
          }
          // A window describes a slice of one exact cached timeline. Wherever this snapshot dropped
          // or re-epoched that cache, the slice it described no longer exists.
          const eventWindows = new Map([...state.eventWindows].filter(([sessionId, window]) =>
            events.has(sessionId) && window.eventEpoch === eventEpochs.get(sessionId)));
          const next = pruneViewStreams({
            ...state,
            streamSubscriptions: {
              mode: targeted ? "targeted" : "legacy",
              requestedRevision: 0,
              appliedRevision: 0,
              sessionIds: [],
              podIds: [],
            },
            activityNow: messageNow,
            // Legacy delivery is already global and the snapshot's lastEventAt is authoritative;
            // only newly acknowledged targeted streams need an observation barrier.
            activityObservationStartedAt: new Map<string, number>(),
            streamRecoveryCursors: new Map(),
            pendingStreamRecovery: null,
            snapshotLoaded: msg.sessionsComplete !== false,
            currentTurnOpeningSupported: msg.capabilities?.currentTurnOpening === true,
            snapshotRevision: state.snapshotRevision + 1,
            pendingSnapshotSessionIds: msg.sessionsComplete === false ? new Set(msg.sessions.map((session) => session.id)) : undefined,
            projectsSupported: msg.capabilities?.projects === true || msg.projects !== undefined,
            projectLocationCreationSupported: msg.capabilities?.createProjectLocations === true,
            accessScopeManagementSupported: msg.capabilities?.accessScopeManagement === true,
            nativeTuiLaunchSupported: msg.capabilities?.nativeTuiLaunch === true,
            stopBeforeArchiveSupported: msg.capabilities?.stopBeforeArchive === true,
            stopFailureRecoverySupported: msg.capabilities?.stopFailureRecovery === true,
            unarchiveAndRestartSupported: msg.capabilities?.unarchiveAndRestart === true,
            sessionRemindersSupported: msg.capabilities?.sessionReminders === true,
            indefiniteSessionRemindersSupported: msg.capabilities?.indefiniteSessionReminders === true,
            worktreeSetupConfigSupported: msg.capabilities?.worktreeSetupConfig === true,
            orchestratorRoleSupported: msg.capabilities?.orchestratorRole === true,
            sessionRoleConversionSupported: msg.capabilities?.sessionRoleConversion === true,
            runners: new Map(msg.runners.map((r) => [r.runnerId, r])),
            // `boxes` may be absent from an older control plane's snapshot — tolerate it.
            boxes: new Map((msg.boxes ?? []).map((b) => [b.boxId, b])),
            // `projects` is additive: older control planes omit it and retain an empty inventory.
            projects: new Map((msg.projects ?? []).map((project) => [project.id, project])),
            sessions,
            reminders: new Map((msg.reminders ?? []).map((reminder) => [reminder.sessionId, reminder])),
            worktreeSetupNoticeDismissals: new Set(msg.worktreeSetupNoticeDismissals ?? []),
            runs: new Map(msg.runs.map((r) => [r.id, r])),
            pods,
            events,
            activity,
            eventEpochs,
            eventHistory,
            eventWindows,
            // A missed pod_removed during an outage must not retain a potentially large context
            // cache after the reconnect snapshot proves that pod no longer exists.
            podContext: new Map([...state.podContext].filter(([podId]) => pods.has(podId))),
          });
          return scanSessionStalls(withLegacyRecovery(next), messageNow);
        }
        case "session_subscriptions_applied": {
          const pending = state.pendingStreamRecovery;
          if (!pending || pending.revision !== msg.revision) return state;
          const messageNow = Number.isSafeInteger(action.now) && action.now! >= 0 ? action.now! : state.activityNow;
          const accepted = new Set(msg.sessionIds);
          const activityObservationStartedAt = new Map<string, number>();
          for (const sessionId of msg.sessionIds) {
            const priorStart = isSessionActivityObservable(state.streamSubscriptions, sessionId)
              ? state.activityObservationStartedAt.get(sessionId)
              : undefined;
            activityObservationStartedAt.set(sessionId, priorStart ?? messageNow);
          }
          const next: State = {
            ...state,
            activityNow: messageNow,
            activityObservationStartedAt,
            streamSubscriptions: {
              mode: "targeted",
              requestedRevision: msg.revision,
              appliedRevision: msg.revision,
              sessionIds: msg.sessionIds,
              podIds: msg.podIds,
            },
            streamRecoveryCursors: new Map([...pending.cursors].filter(([sessionId]) => accepted.has(sessionId))),
            pendingStreamRecovery: null,
          };
          return scanSessionStalls(next, messageNow);
        }
        case "runner_upsert": {
          const runners = new Map(state.runners);
          runners.set(msg.runner.runnerId, msg.runner);
          return { ...state, runners };
        }
        case "runner_removed": {
          const runners = new Map(state.runners);
          runners.delete(msg.runnerId);
          return { ...state, runners };
        }
        case "box_upsert": {
          const boxes = new Map(state.boxes);
          boxes.set(msg.box.boxId, msg.box);
          return { ...state, boxes };
        }
        case "box_removed": {
          const boxes = new Map(state.boxes);
          boxes.delete(msg.boxId);
          return { ...state, boxes };
        }
        case "project_upsert": {
          const projects = new Map(state.projects);
          projects.set(msg.project.id, msg.project);
          return { ...state, projects };
        }
        case "project_removed": {
          if (!state.projects.has(msg.projectId)) return state;
          const projects = new Map(state.projects);
          projects.delete(msg.projectId);
          return { ...state, projects };
        }
        case "session_snapshot_page": {
          if (!state.pendingSnapshotSessionIds) return state;
          const received = new Set(state.pendingSnapshotSessionIds);
          const sessions = new Map(state.sessions);
          const events = new Map(state.events);
          const eventEpochs = new Map(state.eventEpochs);
          const eventHistory = new Map(state.eventHistory);
          const eventWindows = new Map(state.eventWindows);
          for (const session of msg.sessions) {
            received.add(session.id);
            const previous = sessions.get(session.id);
            // A paged reconnect must not unmount an open detail view or discard its request bodies.
            // Mounted detail views revalidate once per snapshot generation through authorized REST.
            const retainedDetail = session.projection === "summary" && previous && previous.projection !== "summary"
              && sessionEventEpoch(previous) === sessionEventEpoch(session)
              && JSON.stringify(pendingRequests(previous.pendingApproval).map((request) => [request.requestId,request.occurrenceId]))
                === JSON.stringify(pendingRequests(session.pendingApproval).map((request) => [request.requestId,request.occurrenceId]));
            sessions.set(session.id, retainedDetail
              ? { ...session,projection: undefined,pendingApproval: previous.pendingApproval,
                parentControlPolicy: previous.parentControlPolicy,
                orchestratorCampaign: previous.orchestratorCampaign,campaignMembership: previous.campaignMembership,
                providerAccountSwitchFailure: previous.providerAccountSwitchFailure,
                agentCapabilities: previous.agentCapabilities,
                executionTarget: previous.executionTarget,executionHandoff: previous.executionHandoff,
                backgroundJobs: previous.backgroundJobs,backgroundJobsTruncated: previous.backgroundJobsTruncated,
                queued: previous.queued,pendingPrompts: previous.pendingPrompts,queueHeld: previous.queueHeld,
                activeTurnId: previous.activeTurnId,steeringAttempts: previous.steeringAttempts,
                commandInvocations: previous.commandInvocations,threadType: previous.threadType }
              : session);
            state.activity.set(session.id,reconcileSessionActivity(state.activity.get(session.id),previous,session));
            const epoch = sessionEventEpoch(session);
            if ((eventEpochs.get(session.id) ?? eventHistory.get(session.id)?.eventEpoch ?? 0) !== epoch) {
              events.delete(session.id);
              eventHistory.delete(session.id);
              eventWindows.delete(session.id);
            }
            eventEpochs.set(session.id,epoch);
          }
          if (msg.complete) {
            for (const [id,session] of sessions) {
              const routedArchive = session.archived && state.view.name === "session" && state.view.id === id;
              if (!received.has(id) && !routedArchive) sessions.delete(id);
            }
            for (const id of new Set([...events.keys(),...eventHistory.keys(),...eventEpochs.keys(),...state.activity.keys()])) {
              if (sessions.has(id)) continue;
              events.delete(id);
              eventHistory.delete(id);
              eventEpochs.delete(id);
              eventWindows.delete(id);
              state.activity.delete(id);
            }
          }
          return pruneViewStreams({ ...state,sessions,events,eventEpochs,eventHistory,eventWindows,
            snapshotLoaded: msg.complete,pendingSnapshotSessionIds: msg.complete ? undefined : received });
        }
        case "session_upsert": {
          const sessions = new Map(state.sessions);
          const previousSession = sessions.get(msg.session.id);
          // Only reads carry this client's command permissions (#1843); a mutation's response
          // does not. They follow who is looking and who owns the session, not its state, so keep
          // the last verdict rather than re-offer a command the server refuses.
          let session = msg.session.commandPermissions === undefined && previousSession?.commandPermissions
            ? { ...msg.session, commandPermissions: previousSession.commandPermissions }
            : msg.session;
          // Mutation responses have shared attention facts but no viewer identity. Preserve this
          // viewer's exact acknowledgment; a new result revision still remains outstanding.
          if (session.attention && previousSession?.attention) {
            const incoming = session.attention;
            const previous = previousSession.attention;
            if (incoming.revision !== undefined && previous.revision !== undefined && incoming.revision < previous.revision) {
              session = { ...session, attention: previous };
            } else if (incoming.acknowledgedRevision === undefined || (incoming.acknowledgmentRevision !== undefined &&
                previous.acknowledgmentRevision !== undefined && incoming.acknowledgmentRevision < previous.acknowledgmentRevision)) {
              session = { ...session, attention: { ...incoming, acknowledgedRevision: previous.acknowledgedRevision,
                acknowledgmentRevision: previous.acknowledgmentRevision } };
            }
          }
          sessions.set(msg.session.id, session);
          state.activity.set(msg.session.id, reconcileSessionActivity(
            state.activity.get(msg.session.id),
            previousSession,
            session,
          ));
          const nextEpoch = sessionEventEpoch(msg.session);
          const cachedEpoch = state.eventEpochs.get(msg.session.id) ?? 0;
          const historyEpoch = state.eventHistory.get(msg.session.id)?.eventEpoch ?? cachedEpoch;
          if (cachedEpoch === nextEpoch && historyEpoch === nextEpoch) {
            return updateSessionStall({ ...state, sessions }, msg.session.id);
          }
          const events = new Map(state.events);
          events.delete(msg.session.id);
          const eventEpochs = new Map(state.eventEpochs);
          eventEpochs.set(msg.session.id, nextEpoch);
          const eventHistory = new Map(state.eventHistory);
          eventHistory.delete(msg.session.id);
          const eventWindows = new Map(state.eventWindows);
          eventWindows.delete(msg.session.id);
          return updateSessionStall({
            ...state,
            sessions,
            events,
            eventEpochs,
            eventHistory,
            eventWindows,
            ...invalidateRecoveryCursor(state, msg.session.id),
          }, msg.session.id);
        }
        case "session_reminder_upsert": {
          const current = state.reminders.get(msg.reminder.sessionId);
          if (current?.reminderId === msg.reminder.reminderId &&
              current.revision >= msg.reminder.revision) return state;
          const reminders = new Map(state.reminders);
          reminders.set(msg.reminder.sessionId, msg.reminder);
          return { ...state, reminders };
        }
        case "session_reminder_removed": {
          if (!state.reminders.has(msg.sessionId)) return state;
          const reminders = new Map(state.reminders);
          reminders.delete(msg.sessionId);
          return { ...state, reminders };
        }
        case "worktree_setup_notice_dismissed": {
          if (state.worktreeSetupNoticeDismissals.has(msg.projectId)) return state;
          const worktreeSetupNoticeDismissals = new Set(state.worktreeSetupNoticeDismissals);
          worktreeSetupNoticeDismissals.add(msg.projectId);
          return { ...state, worktreeSetupNoticeDismissals };
        }
        case "session_removed": {
          const sessions = new Map(state.sessions);
          sessions.delete(msg.sessionId);
          const reminders = new Map(state.reminders);
          reminders.delete(msg.sessionId);
          const events = new Map(state.events);
          events.delete(msg.sessionId);
          state.activity.delete(msg.sessionId);
          const activityObservationStartedAt = new Map(state.activityObservationStartedAt);
          activityObservationStartedAt.delete(msg.sessionId);
          const eventEpochs = new Map(state.eventEpochs);
          eventEpochs.delete(msg.sessionId);
          const eventHistory = new Map(state.eventHistory);
          eventHistory.delete(msg.sessionId);
          const eventWindows = new Map(state.eventWindows);
          eventWindows.delete(msg.sessionId);
          const shellOutput = new Map([...state.shellOutput].filter(([, scrollback]) =>
            scrollback.sessionId !== msg.sessionId));
          const selectedBySplit = new Map(state.inbox.selectedBySplit);
          for (const [splitKey, selectedId] of selectedBySplit) {
            if (selectedId === msg.sessionId) selectedBySplit.delete(splitKey);
          }
          const inbox = state.inbox.selectedSessionId === msg.sessionId || selectedBySplit.size !== state.inbox.selectedBySplit.size
            ? {
                ...state.inbox,
                // Keep the active selection as a short-lived tombstone. InboxView repairs a
                // vanished selection against its held visual order, which requires the removed
                // id to locate the vacated slot. The repair dispatch replaces it immediately.
                selectedSessionId: state.inbox.selectedSessionId,
                selectedBySplit,
              }
            : state.inbox;
          return clearSessionStall({
            ...state,
            sessions,
            reminders,
            events,
            activityObservationStartedAt,
            eventEpochs,
            eventHistory,
            eventWindows,
            shellOutput,
            inbox,
          }, msg.sessionId);
        }
        case "session_event": {
          const session = state.sessions.get(msg.event.sessionId);
          // Heartbeat aggregation is intentionally independent from transcript retention: busy
          // sessions are subscribed for their pulse, but only visible timelines keep raw payloads.
          const eventEpoch = sessionEventEpoch(session);
          const priorActivity = session ? state.activity.get(msg.event.sessionId) : undefined;
          const nextActivity = session
            ? recordSessionActivity(
                priorActivity,
                msg.event.ts,
                eventEpoch,
                priorActivity?.busySince ?? null,
              )
            : priorActivity;
          if (nextActivity !== undefined && nextActivity !== priorActivity) {
            state.activity.set(msg.event.sessionId, nextActivity);
          }
          // Publish a fresh state object even though the activity registry itself stays stable;
          // per-session selectors observe the new immutable value at this key.
          const heartbeatState = session
            ? updateSessionStall({ ...state }, msg.event.sessionId)
            : state;
          if (!relevantSessions(state).has(msg.event.sessionId)) {
            return heartbeatState;
          }
          // An opening window is in flight and the control-plane cache is still hydrating FORWARD
          // from the runner. Those hydration rows are broadcast exactly like live ones, so
          // appending them here would paint the start of a long log — the oldest-first open the
          // window exists to remove — behind the window's back. They are durable in the cache and
          // the window's own read supplies the tail, so holding them costs nothing.
          // The same rule the window's apply enforces, held on the live path: a frame below the
          // loaded window's base is hydration replay arriving late, not tail traffic — a runner's
          // live seqs are monotonic, so nothing genuinely new can sort below the base. Appending it
          // would rebuild the prefix above a silent gap the reader cannot see. It stays in the
          // control-plane cache, reachable through Load Earlier Activity.
          const window = state.eventWindows.get(msg.event.sessionId);
          if (window && window.eventEpoch === eventEpoch && window.baseSeq > 0 &&
              msg.event.seq < window.baseSeq) {
            return heartbeatState;
          }
          const events = new Map(state.events);
          const existing = (state.eventEpochs.get(msg.event.sessionId) ?? 0) === eventEpoch
            ? events.get(msg.event.sessionId)
            : undefined;
          events.set(msg.event.sessionId, appendEvent(existing, msg.event));
          const eventEpochs = new Map(state.eventEpochs);
          eventEpochs.set(msg.event.sessionId, eventEpoch);
          return { ...heartbeatState, events, eventEpochs };
        }
        case "session_events_reset": {
          // Reprocess replaced the whole log with new ids — drop the stale cache and adopt this set
          // wholesale (merging would duplicate, since none of the new ids match the cached ones).
          const currentSession = state.sessions.get(msg.sessionId);
          if (!currentSession) return state;
          const eventEpoch = msg.eventEpoch ?? sessionEventEpoch(currentSession);
          const rebuiltActivity = rebuildSessionActivity(
            msg.events,
            eventEpoch,
            state.activity.get(msg.sessionId)?.busySince ?? null,
          );
          // The metadata upsert for this epoch may be coalesced behind the reset. Preserve the
          // current busy period, but never seed the replacement ring from the old epoch's
          // lastEventAt; the matching upsert will reconcile authoritative metadata when it lands.
          state.activity.set(msg.sessionId, reconcileSessionActivity(
            rebuiltActivity,
            currentSession,
            { ...currentSession, eventEpoch, lastEventAt: null },
          ));
          if (!relevantSessions(state).has(msg.sessionId)) {
            if (sessionEventEpoch(currentSession) === eventEpoch) return updateSessionStall({ ...state }, msg.sessionId);
            // pruneViewStreams does NOT clear streamRecoveryCursors, so a session viewed earlier can
            // reach this non-relevant branch still holding a frozen cursor from the old epoch. Adopt
            // the new epoch AND drop that cursor, else reopening pages above a stale seq (issue #78).
            const sessions = new Map(state.sessions);
            sessions.set(msg.sessionId, { ...currentSession, eventEpoch });
            return updateSessionStall({ ...state, sessions, ...invalidateRecoveryCursor(state, msg.sessionId) }, msg.sessionId);
          }
          const events = new Map(state.events);
          events.set(msg.sessionId, tagRebuilt([...msg.events].sort((a, b) => a.seq - b.seq)));
          const eventEpochs = new Map(state.eventEpochs);
          eventEpochs.set(msg.sessionId, eventEpoch);
          const eventHistory = new Map(state.eventHistory);
          eventHistory.delete(msg.sessionId);
          // The replacement log has its own sequence space, so the previous window's base describes
          // a timeline that no longer exists. The next open reads a fresh window at the new tail.
          const eventWindows = new Map(state.eventWindows);
          eventWindows.delete(msg.sessionId);
          const recoveryReset = invalidateRecoveryCursor(state, msg.sessionId);
          if (sessionEventEpoch(currentSession) === eventEpoch) {
            return updateSessionStall({
              ...state, events, eventEpochs, eventHistory, eventWindows, ...recoveryReset,
            }, msg.sessionId);
          }
          // Writer coalescing may move the matching metadata upsert after this durable reset. Move
          // the local row to the reset generation now so stale in-flight history cannot land first.
          const sessions = new Map(state.sessions);
          sessions.set(msg.sessionId, { ...currentSession, eventEpoch });
          return updateSessionStall({
            ...state, sessions, events, eventEpochs, eventHistory, eventWindows, ...recoveryReset,
          }, msg.sessionId);
        }
        case "shell_output": {
          // Ephemeral console stream — only buffered for sessions the current view shows.
          // RAW bytes: xterm renders them (and handles split escape sequences internally).
          if (!relevantSessions(state).has(msg.sessionId)) return state;
          const shellOutput = new Map(state.shellOutput);
          const prev = shellOutput.get(msg.shellId) ?? emptyScrollback(msg.sessionId);
          const lastSeq = prev.chunks.at(-1)?.seq ?? 0;
          const seq = msg.seq ?? lastSeq + 1;
          const orderedAppend = seq === lastSeq + 1;
          if (!orderedAppend && prev.chunks.some((chunk) => chunk.seq === seq)) return state;
          const incoming = { seq, stream: msg.stream, data: msg.data };
          const appended = orderedAppend
            ? appendOrderedShellChunk(prev.chunks, prev.text, incoming)
            : null;
          const chunks = appended?.chunks ?? mergeShellChunks(prev.chunks, [incoming]);
          const text = appended?.text ?? chunks.map((chunk) => chunk.data).join("");
          shellOutput.set(msg.shellId, {
            ...prev,
            text,
            total: orderedAppend ? prev.total + msg.data.length : text.length,
            chunks,
            revision: orderedAppend ? prev.revision : prev.revision + 1,
            incomplete: Boolean(prev.incomplete || (lastSeq > 0 && seq > lastSeq + 1)),
          });
          return { ...state, shellOutput };
        }
        case "shell_exit": {
          // Create the entry if needed: a zero-output shell must still flip its tab to "(exited)".
          const prev = state.shellOutput.get(msg.shellId);
          if (!prev && !relevantSessions(state).has(msg.sessionId)) return state;
          const base = prev ?? emptyScrollback(msg.sessionId);
          const shellOutput = new Map(state.shellOutput);
          shellOutput.set(msg.shellId, { ...base, exited: true, exitCode: msg.code });
          return { ...state, shellOutput };
        }
        case "shell_registry_reconciled": {
          const shellRegistryRevision = new Map(state.shellRegistryRevision);
          for (const sessionId of msg.sessionIds) {
            shellRegistryRevision.set(sessionId, (shellRegistryRevision.get(sessionId) ?? 0) + 1);
          }
          return { ...state, shellRegistryRevision };
        }
        case "run_upsert": {
          const runs = new Map(state.runs);
          runs.set(msg.run.id, msg.run);
          const next = { ...state, runs };
          const pruned = state.view.name === "run" && state.view.id === msg.run.id ? pruneViewStreams(next) : next;
          return withLegacyRecovery(pruned);
        }
        case "run_removed": {
          const runs = new Map(state.runs);
          runs.delete(msg.runId);
          const next = { ...state, runs };
          return state.view.name === "run" && state.view.id === msg.runId ? pruneViewStreams(next) : next;
        }
        case "pod_upsert": {
          const pods = new Map(state.pods);
          pods.set(msg.pod.id, msg.pod);
          const next = { ...state, pods };
          const pruned = state.view.name === "pod" && state.view.id === msg.pod.id ? pruneViewStreams(next) : next;
          return withLegacyRecovery(pruned);
        }
        case "pod_removed": {
          const pods = new Map(state.pods);
          pods.delete(msg.podId);
          const podContext = new Map(state.podContext);
          podContext.delete(msg.podId);
          const next = { ...state, pods, podContext };
          return state.view.name === "pod" && state.view.id === msg.podId ? pruneViewStreams(next) : next;
        }
        case "pod_context_entry": {
          if (state.view.name !== "pod" || state.view.id !== msg.entry.podId) return state;
          const podContext = new Map(state.podContext);
          podContext.set(msg.entry.podId, mergePodContext(podContext.get(msg.entry.podId), [msg.entry]));
          return { ...state, podContext };
        }
      }
      return state;
    }
  }
}

function initialState(
  view: View = { name: "inbox" },
  inbox = loadInboxState(),
  filters: Filters = { runnerId: null, agentId: null },
): State {
  return {
    conn: "connecting",
    authRequired: false,
    snapshotLoaded: false,
    currentTurnOpeningSupported: false,
    snapshotRevision: 0,
    projectsSupported: false,
    projectLocationCreationSupported: false,
    accessScopeManagementSupported: false,
    nativeTuiLaunchSupported: false,
    stopBeforeArchiveSupported: false,
    stopFailureRecoverySupported: false,
    unarchiveAndRestartSupported: false,
    sessionRemindersSupported: false,
    indefiniteSessionRemindersSupported: false,
    worktreeSetupConfigSupported: false,
    orchestratorRoleSupported: false,
    sessionRoleConversionSupported: false,
    runners: new Map(),
    boxes: new Map(),
    projects: new Map(),
    sessions: new Map(),
    reminders: new Map(),
    worktreeSetupNoticeDismissals: new Set(),
    runs: new Map(),
    pods: new Map(),
    podContext: new Map(),
    events: new Map(),
    activity: new Map(),
    activityNow: Date.now(),
    activityObservationStartedAt: new Map(),
    stalledSessionIds: new Set(),
    stalledRevision: 0,
    stalledCount: 0,
    eventEpochs: new Map(),
    eventHistory: new Map(),
    eventWindows: new Map(),
    shellOutput: new Map(),
    shellRegistryRevision: new Map(),
    streamSubscriptions: EMPTY_UI_SUBSCRIPTION_DELIVERY,
    streamRecoveryCursors: new Map(),
    pendingStreamRecovery: null,
    view,
    // A direct/deep-link Settings entry has no trustworthy same-app predecessor.
    settingsReturnView: view.name === "settings" ? { name: "inbox" } : null,
    inbox,
    filters,
  };
}

interface StoreValue extends State {
  dispatch: Dispatch<Action>;
  navigate: (view: View) => void;
  setInboxPersistenceEnabled: (enabled: boolean) => void;
  setInboxSelection: (sessionId: string | null, splitKey?: string | null, persist?: boolean, repair?: boolean) => void;
  setInboxSplit: (splitKey: string | null, persist?: boolean) => void;
  setInboxRatio: (ratio: number) => void;
  setFilters: (filters: Partial<Filters>) => void;
  loadEvents: (
    sessionId: string,
    events: SessionEvent[],
    eventEpoch?: number,
    recoveryRevision?: number,
    recoveryComplete?: boolean,
    recoveryGeneration?: number,
    windowHasOlder?: boolean,
    windowTurnAligned?: boolean,
  ) => void;
  loadOlderEvents: (
    sessionId: string,
    events: SessionEvent[],
    hasOlder: boolean,
    requestedBase: number,
    eventEpoch?: number,
    turnAligned?: boolean,
  ) => void;
  beginOlderEventsLoad: (sessionId: string, requestedBase: number, eventEpoch?: number) => boolean;
  failOlderEventsLoad: (sessionId: string, error: string, requestedBase: number, eventEpoch?: number) => void;
  eventWindowBase: (sessionId: string) => number;
  loadSession: (session: SessionView) => void;
  getSession: (sessionId: string) => SessionView | undefined;
  beginEventHistoryLoad: (
    sessionId: string,
    eventEpoch?: number,
    recoveryRevision?: number,
    recoveryGeneration?: number,
  ) => void;
  failEventHistoryLoad: (sessionId: string, error: string, eventEpoch?: number, recoveryRevision?: number, recoveryGeneration?: number) => void;
  isEventGapRecoveryCurrent: Store["isEventGapRecoveryCurrent"];
  beginEventGapRecovery: Store["beginEventGapRecovery"];
  cancelEventGapRecovery: Store["cancelEventGapRecovery"];
  finishEventGapRecovery: Store["finishEventGapRecovery"];
  loadEventGapWindow: Store["loadEventGapWindow"];
  loadTurnStartWindow: Store["loadTurnStartWindow"];
  deferEventTail: Store["deferEventTail"];
  beginLaterEventsLoad: Store["beginLaterEventsLoad"];
  loadLaterEvents: Store["loadLaterEvents"];
  failLaterEventsLoad: Store["failLaterEventsLoad"];
  promoteDeferredEventTail: Store["promoteDeferredEventTail"];
  loadPodContext: (podId: string, entries: PodContextEntry[]) => void;
  eventHighWater: (sessionId: string) => number;
  recoveryAfter: (sessionId: string) => number;
  recoveryReadAfter: (sessionId: string, eventEpoch: number, recoveryGeneration: number) => number;
  eventEpoch: (sessionId: string) => number;
  reconcileShellOutputs: (sessionId: string, shellIds: string[]) => void;
  loadShellHistory: (
    sessionId: string,
    shellId: string,
    chunks: ShellOutputChunk[],
    status: ShellStatus,
    exitCode: number | null,
    truncated: boolean,
  ) => void;
  removeShellOutput: (shellId: string) => void;
}

/**
 * External store (subscribe/getState/dispatch) instead of context-held state: with a context
 * value rebuilt per dispatch, EVERY component re-rendered on EVERY WS message — a token-usage
 * upsert for one session re-rendered the whole app (board sort, inbox grouping, timeline).
 * Components now subscribe to exactly the slice they render via useStoreSelector; the context
 * carries only this stable handle.
 */
/** Socket frame types whose publication may wait for the next animation frame (#2763). Every other
 * frame (a snapshot, a history reset, removals, subscription acknowledgements) is published at once,
 * together with whatever earlier frames are still waiting. */
const STREAM_FRAME_TYPES: ReadonlySet<ControlPlaneToUi["type"]> = new Set([
  "session_event", "session_upsert", "shell_output", "pod_context_entry",
]);

/** Whether a frame, now reduced from `before` to `after`, may wait for the next animation frame. A
 * session upsert waits only when it moved nothing but streaming fields. A transition (status,
 * attention, requests, the history epoch, …) is published at once, as each frame was before, so a
 * component that reacts to each transition still sees every one of them. */
function deferrableFrame(msg: ControlPlaneToUi, before: State, after: State): boolean {
  if (!STREAM_FRAME_TYPES.has(msg.type)) return false;
  // A shell's first output is how a shell dock learns of a shell another dashboard opened, and its
  // exit may follow within the frame; only output for a shell already shown waits.
  if (msg.type === "shell_output") return before.shellOutput.has(msg.shellId);
  if (msg.type !== "session_upsert") return true;
  const previous = before.sessions.get(msg.session.id);
  const next = after.sessions.get(msg.session.id);
  return previous !== undefined && next !== undefined && sameSessionExceptStreaming(previous, next);
}

export class Store {
  /** The newest state. Every reducer step, Store method and transition observer works on it, so
   * socket frames are reduced one at a time, in arrival order, exactly as they arrive. */
  private state: State;
  /** What `getState` and subscribers see: `state` as of the last publication. Socket frames are
   * published at most once per animation frame (#2763); everything else publishes at once. */
  private published: State;
  private readonly listeners = new Set<() => void>();
  /** Told synchronously of every state change, before publication, so a transition that is
   * superseded within one animation frame (a notification, a backfill fence) is never skipped. */
  private readonly transitionObservers = new Set<(previous: State, next: State) => void>();
  private publishScheduler: StorePublishScheduler | null = null;
  private cancelScheduledPublish: (() => void) | null = null;
  private inboxPersistenceEnabled = true;
  private attentionActivation = 0;
  private reconnectHandler: (() => boolean) | null = null;
  /** Inactive readers retain one contiguous loaded slice, without remaining subscribed. Bounds
   * apply to the entire slice: keeping a head and tail would silently lose the middle. */
  private readonly readerCache = new Map<string, {
    events: SessionEvent[];
    eventEpoch: number;
    history: EventHistoryState;
    window?: EventWindowState;
    bytes: number;
  }>();
  private readerCacheBytes = 0;
  private gapRequestSequence = 0;
  private readonly gapOperations = new Map<string, EventGapFence>();
  /** The session ids each in-flight session backfill must leave alone (#2803). */
  private readonly backfillFences = new Set<Set<string>>();
  private readonly gapPauseChecks = new Map<string, () => boolean>();
  private readonly pendingGapLive = new Map<string, DeferredLiveBuffer>();
  /** These arrays never enter timeline derivation or the inactive-reader cache. */
  private readonly deferredTails = new Map<string, DeferredEventTail>();

  constructor(
    initialView: View = { name: "inbox" },
    private readonly onNavigate?: (view: View) => void,
    private readonly instanceScope = LOCAL_INSTANCE_SCOPE,
    private readonly inboxStorage?: KeyValueStorage,
  ) {
    this.state = initialState(
      initialView,
      loadInboxState(instanceScope, inboxStorage),
      loadSessionFilters(instanceScope, inboxStorage),
    );
    this.published = this.state;
    // A new Store owns no retained rows, even if a previous mount left a position in the shared
    // hook cache. Do not let that stale position force a cold first open through the full log.
    for (const sessionId of relevantSessions(this.state)) expireFollowTailAnchor(instanceScope, sessionId);
  }

  /** The published state. Between a deferred socket frame and its animation frame this is the
   * state before that frame, whole, so a render in between never sees half of a batch. */
  getState = (): State => this.published;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /** Observe every state change synchronously, including socket frames not yet published. */
  observeTransitions = (fn: (previous: State, next: State) => void): (() => void) => {
    this.transitionObservers.add(fn);
    return () => {
      this.transitionObservers.delete(fn);
    };
  };

  /** How socket frames wait for the next animation frame; null publishes each frame at once. */
  setPublishScheduler = (scheduler: StorePublishScheduler | null): void => {
    this.publishScheduler = scheduler;
    if (!scheduler) this.publish();
  };

  /** Apply an action and publish at once, together with any socket frames still waiting. */
  dispatch = (action: Action): void => {
    this.apply(action);
    this.publish();
  };

  /** Apply one socket frame now and publish it with the others received in this animation frame.
   * Frames are reduced in arrival order, so publication can only ever show a prefix of them. */
  receiveFrame = (msg: ControlPlaneToUi, now?: number): void => {
    // The reducer updates the activity registry in place. While frames wait, give them their own
    // copy, so the published state keeps the activity it was published with.
    if (STREAM_FRAME_TYPES.has(msg.type) && this.publishScheduler && this.state.activity === this.published.activity) {
      this.state = { ...this.state, activity: new Map(this.state.activity) };
    }
    const before = this.state;
    this.apply({ type: "msg", msg, now });
    if (!this.publishScheduler || !deferrableFrame(msg, before, this.state)) {
      this.publish();
      return;
    }
    if (this.cancelScheduledPublish || this.published === this.state) return;
    const cancel = this.publishScheduler(this.publish);
    if (cancel) this.cancelScheduledPublish = cancel;
    else this.publish();
  };

  /** Publish the newest state to subscribers. Safe to call at any time; does nothing when current. */
  publish = (): void => {
    const cancel = this.cancelScheduledPublish;
    this.cancelScheduledPublish = null;
    cancel?.();
    if (this.published === this.state) return;
    this.published = this.state;
    for (const l of [...this.listeners]) l();
  };

  private commit(next: State): void {
    const previous = this.state;
    this.state = next;
    for (const observer of [...this.transitionObservers]) observer(previous, next);
  }

  private apply(action: Action): void {
    // A removal speaks for a session even when this client never held it (#2803).
    if (action.type === "msg" && action.msg.type === "session_removed") {
      for (const spoken of this.backfillFences) spoken.add(action.msg.sessionId);
    }
    let next = reducer(this.state, action);
    if (next === this.state) return;
    // Explicit resets also cover rolling senders that omit the epoch. Their authoritative
    // replacement must invalidate an inactive slice even when metadata still names its old epoch.
    if (action.type === "msg" && action.msg.type === "session_events_reset" &&
        this.readerCache.has(action.msg.sessionId)) {
      this.dropReaderCache(action.msg.sessionId);
      expireFollowTailAnchor(this.instanceScope, action.msg.sessionId);
    }
    if (action.type === "msg" && action.msg.type === "session_event") {
      next = this.reconcileDeferredLive(this.state, next, action.msg.event);
    }
    // Any authoritative replacement invalidates the prior reading-window owner, even if its
    // numerical base happens to match. Ordinary older prepends extend that same window instead.
    if (action.type === "events_loaded" && action.windowHasOlder !== undefined) {
      const owner = this.gapOperations.get(action.sessionId);
      if (owner && action.gapWindowFence === owner) {
        // The same bounded operation still owns its completion/error after this replacement.
        // Its old staged arrays and page tickets are dropped below, not promoted implicitly.
        const base = next.eventWindows.get(action.sessionId)?.baseSeq ?? 0;
        owner.baseSeq = base > 0 ? base : next.events.get(action.sessionId)?.length ? 1 : 0;
      } else this.gapOperations.delete(action.sessionId);
      this.pendingGapLive.delete(action.sessionId);
    }
    next = this.reconcileReaderCache(this.state, next);
    next = this.pruneDeferredTails(next);
    const inboxChanged = next.inbox !== this.state.inbox;
    const filtersChanged = next.filters !== this.state.filters;
    this.commit(next);
    if (inboxChanged && this.inboxPersistenceEnabled && (!("persist" in action) || action.persist !== false)) {
      saveInboxState(next.inbox, this.instanceScope, this.inboxStorage);
    }
    if (filtersChanged) saveSessionFilters(next.filters, this.instanceScope, this.inboxStorage);
  }

  /** Prepending older history extends the same window and keeps its forward boundary valid.
   * Any authoritative window replacement explicitly revokes ownership, including equal bases. */
  private currentGapFence(fence: EventGapFence): boolean {
    const history = this.state.eventHistory.get(fence.sessionId);
    const window = this.state.eventWindows.get(fence.sessionId);
    return this.gapOperations.get(fence.sessionId) === fence && relevantSessions(this.state).has(fence.sessionId) &&
      this.state.snapshotRevision === fence.recoveryGeneration && this.eventEpoch(fence.sessionId) === fence.eventEpoch &&
      this.state.eventEpochs.get(fence.sessionId) === fence.eventEpoch &&
      (window?.baseSeq ?? this.state.events.get(fence.sessionId)?.[0]?.seq ?? Infinity) <= fence.baseSeq &&
      history?.recoveryGeneration === fence.recoveryGeneration && history.recoveryRevision === fence.recoveryRevision;
  }

  private boundedDeferredEvents(events: SessionEvent[], sessionId: string): {
    events: SessionEvent[]; bytes: number; truncated: boolean;
    byteSizes: Map<number, { event: SessionEvent; bytes: number }>;
  } | null {
    const otherBytes = [...this.deferredTails, ...this.pendingGapLive].reduce((bytes, [id, tail]) => bytes + (id === sessionId ? 0 : tail.bytes), 0);
    const byteLimit = DEFERRED_TAIL_BYTE_LIMIT - otherBytes;
    // Callers supply sorted, deduplicated arrays. Reuse byte counts for unchanged events so live
    // traffic does not serialize an entire megabyte-scale tail on every incoming frame.
    const ordered = events;
    const retained: SessionEvent[] = [];
    const cachedSizes = (this.deferredTails.get(sessionId) ?? this.pendingGapLive.get(sessionId))?.byteSizes;
    const byteSizes = new Map<number, { event: SessionEvent; bytes: number }>();
    const encoder = new TextEncoder();
    let bytes = 0;
    for (let i = ordered.length - 1; i >= 0 && retained.length < DEFERRED_TAIL_EVENT_LIMIT; i--) {
      const event = ordered[i]!;
      const cached = cachedSizes?.get(event.seq);
      const size = cached?.event === event ? cached.bytes : encoder.encode(JSON.stringify(event)).byteLength;
      if (bytes + size > byteLimit) break;
      bytes += size;
      byteSizes.set(event.seq, { event, bytes: size });
      retained.push(event);
    }
    if (!retained.length) return null;
    retained.reverse();
    return { events: retained, bytes, truncated: retained.length !== ordered.length, byteSizes };
  }

  private pruneDeferredTails(next: State): State {
    const relevant = relevantSessions(next);
    for (const [id, fence] of this.gapOperations) {
      const window = next.eventWindows.get(id);
      const history = next.eventHistory.get(id);
      if (!relevant.has(id) || next.snapshotRevision !== fence.recoveryGeneration ||
          sessionEventEpoch(next.sessions.get(id)) !== fence.eventEpoch || next.eventEpochs.get(id) !== fence.eventEpoch ||
          (window?.baseSeq ?? next.events.get(id)?.[0]?.seq ?? Infinity) > fence.baseSeq ||
          history?.recoveryGeneration !== fence.recoveryGeneration || history.recoveryRevision !== fence.recoveryRevision) {
        this.gapOperations.delete(id);
      }
    }
    for (const [id, buffer] of this.pendingGapLive) {
      if (this.gapOperations.get(id) !== buffer.fence) this.pendingGapLive.delete(id);
    }
    for (const id of this.gapPauseChecks.keys()) {
      if (!this.gapOperations.has(id)) this.gapPauseChecks.delete(id);
    }
    let eventWindows = next.eventWindows;
    for (const [id, tail] of this.deferredTails) {
      if (this.gapOperations.get(id) !== tail.fence || next.eventWindows.get(id)?.laterGap?.fence !== tail.fence) {
        this.deferredTails.delete(id);
        const window = eventWindows.get(id);
        if (window?.laterGap?.fence === tail.fence) {
          const { laterGap: _gap, ...reading } = window;
          if (eventWindows === next.eventWindows) eventWindows = new Map(eventWindows);
          eventWindows.set(id, reading);
        }
      }
    }
    return eventWindows === next.eventWindows ? next : { ...next, eventWindows };
  }

  private reconcileDeferredLive(previous: State, next: State, event: SessionEvent): State {
    const tail = this.deferredTails.get(event.sessionId);
    const window = previous.eventWindows.get(event.sessionId);
    const gap = window?.laterGap;
    if (!tail || !gap) {
      const fence = this.gapOperations.get(event.sessionId);
      if (!fence || !this.currentGapFence(fence) || next.eventEpochs.get(event.sessionId) !== fence.eventEpoch ||
          this.gapPauseChecks.get(event.sessionId)?.() !== true) return next;
      const reading = previous.events.get(event.sessionId) ?? [];
      const after = contiguousEventHighWater(reading, Math.max(0, (window?.baseSeq ?? fence.baseSeq) - 1));
      // Only future delivery is deferred. A row already visible before pause may itself be the
      // reader's anchor and must never be removed to manufacture a contiguous reading window.
      if (event.seq <= after || reading.some(row => row.seq === event.seq)) return next;
      const pending = this.pendingGapLive.get(event.sessionId);
      const bounded = this.boundedDeferredEvents(mergeEvents(pending?.events, [event]), event.sessionId);
      this.pendingGapLive.set(event.sessionId, {
        ...(bounded ?? pending ?? { events: [], bytes: 0, byteSizes: new Map() }),
        fence, observedTailSeq: Math.max(pending?.observedTailSeq ?? 0, event.seq),
      });
      return { ...next, events: new Map(next.events).set(event.sessionId, reading) };
    }
    if (!this.currentGapFence(tail.fence) || next.eventEpochs.get(event.sessionId) !== tail.fence.eventEpoch) return next;
    // Cache hydration below the staged tail is not a user request for the intervening rows.
    // Observe its heartbeat but keep it out of both the reading slice and the bounded tail.
    const events = event.seq > gap.afterSeq
      ? new Map(next.events).set(event.sessionId, previous.events.get(event.sessionId) ?? [])
      : next.events;
    if (event.seq < gap.beforeSeq) return events === next.events ? next : { ...next, events };
    tail.observedTailSeq = Math.max(tail.observedTailSeq, event.seq);
    const bounded = this.boundedDeferredEvents(mergeEvents(tail.events, [event]), event.sessionId);
    if (bounded) {
      tail.events = bounded.events;
      tail.bytes = bounded.bytes;
      tail.byteSizes = bounded.byteSizes;
      if (bounded.truncated) { tail.hasOlder = true; tail.turnAligned = false; }
    }
    const eventWindows = new Map(next.eventWindows).set(event.sessionId, {
      ...window!, laterGap: { ...gap, beforeSeq: tail.events[0]?.seq ?? gap.beforeSeq, tailSeq: Math.max(gap.tailSeq, event.seq) },
    });
    return { ...next, events, eventWindows };
  }

  private dropReaderCache(sessionId: string): void {
    const cached = this.readerCache.get(sessionId);
    if (cached) this.readerCacheBytes -= cached.bytes;
    this.readerCache.delete(sessionId);
  }

  private reconcileReaderCache(previous: State, next: State): State {
    const wasRelevant = relevantSessions(previous);
    const isRelevant = relevantSessions(next);
    const targeted = next.streamSubscriptions.mode === "targeted";
    const snapshotChanged = next.snapshotRevision !== previous.snapshotRevision;
    // An epoch is authoritative only on current servers. Legacy reconnects discard reader slices
    // just as they discard visible history, so a missed reprocess cannot resurrect old events.
    for (const [sessionId, cached] of this.readerCache) {
      const session = next.sessions.get(sessionId);
      if ((snapshotChanged && !targeted) || !session || sessionEventEpoch(session) !== cached.eventEpoch) {
        this.dropReaderCache(sessionId);
        expireFollowTailAnchor(this.instanceScope, sessionId);
      }
    }
    for (const sessionId of wasRelevant) {
      const previousEpoch = previous.eventEpochs.get(sessionId);
      if (previousEpoch !== undefined && ((snapshotChanged && !targeted) ||
          previousEpoch !== sessionEventEpoch(next.sessions.get(sessionId)))) {
        expireFollowTailAnchor(this.instanceScope, sessionId);
      }
      if (isRelevant.has(sessionId)) continue;
      this.dropReaderCache(sessionId);
      const events = previous.events.get(sessionId);
      const history = previous.eventHistory.get(sessionId);
      const window = previous.eventWindows.get(sessionId);
      const eventEpoch = previousEpoch ?? 0;
      const base = window?.baseSeq ?? 1;
      // In-flight recovery may already contain a distant live event. Its high-water mark cannot
      // become a reopen cursor unless every intervening event is present in this exact epoch.
      const retainable = targeted && next.sessions.has(sessionId) &&
        eventEpoch === sessionEventEpoch(next.sessions.get(sessionId)) &&
        events && events.length > 0 && events.length <= 2_000 && events[0]!.seq === base &&
        contiguousEventHighWater(events, base - 1) === events.at(-1)!.seq &&
        history?.eventEpoch === eventEpoch && history.everComplete &&
        (!window || (window.eventEpoch === eventEpoch && window.complete));
      if (!retainable) {
        expireFollowTailAnchor(this.instanceScope, sessionId);
        continue;
      }
      // UTF-8 accounting includes all event payloads (tool output, images and text), rather than
      // just row count. Encode individually so the bound never needs a whole-transcript string.
      let bytes = 0;
      const encoder = new TextEncoder();
      for (const event of events) {
        bytes += encoder.encode(JSON.stringify(event)).byteLength;
        if (bytes > 8 * 1024 * 1024) break;
      }
      if (bytes > 8 * 1024 * 1024) {
        expireFollowTailAnchor(this.instanceScope, sessionId);
        continue;
      }
      this.readerCache.set(sessionId, { events, history, window, eventEpoch, bytes });
      this.readerCacheBytes += bytes;
      while (this.readerCache.size > 8 || this.readerCacheBytes > 8 * 1024 * 1024) {
        const oldest = this.readerCache.keys().next().value;
        if (oldest === undefined) break;
        this.dropReaderCache(oldest);
        expireFollowTailAnchor(this.instanceScope, oldest);
      }
    }
    for (const sessionId of isRelevant) {
      if (wasRelevant.has(sessionId)) continue;
      const cached = this.readerCache.get(sessionId);
      this.dropReaderCache(sessionId);
      // Fleet columns have no Load Earlier Activity control and must recover whole histories.
      const fleet = next.view.name === "run" || next.view.name === "pod";
      if (!cached || (fleet && isPartialHistory(cached.window))) {
        expireFollowTailAnchor(this.instanceScope, sessionId);
        continue;
      }
      const events = new Map(next.events).set(sessionId, cached.events);
      const eventEpochs = new Map(next.eventEpochs).set(sessionId, cached.eventEpoch);
      const eventHistory = new Map(next.eventHistory).set(sessionId, {
        ...cached.history, recoveryGeneration: next.snapshotRevision, recoveryRevision: -1,
        refreshing: true, error: null,
      });
      const eventWindows = new Map(next.eventWindows);
      if (cached.window) {
        const { provisionalRestTail: _receipt, laterGap: _gap, ...retained } = cached.window;
        eventWindows.set(sessionId, { ...retained, loadingOlder: false, error: null });
      }
      next = { ...next, events, eventEpochs, eventHistory, eventWindows };
    }
    return next;
  }

  /** The provider's socket lifecycle owns the retry timer, so it registers how to bring it forward. */
  setReconnectHandler = (handler: (() => boolean) | null): void => {
    this.reconnectHandler = handler;
  };

  /**
   * Retry Now (docs/design-system.md §12.5): cancel the pending retry and connect immediately.
   * Returns whether an attempt started; while a connection is opening or online there is no pending
   * retry, so this does nothing.
   */
  reconnectNow = (): boolean => this.reconnectHandler?.() ?? false;

  navigate = (view: View): void => {
    const activated = view.name === "session" && view.attention
      ? { ...view, attention: { ...view.attention, activationId: ++this.attentionActivation } }
      : view;
    if (sameView(this.state.view, activated)) {
      if (activated.name === "session" && activated.attention) this.dispatch({ type: "navigate", view: activated });
      return;
    }
    this.dispatch({ type: "navigate", view: activated });
    this.onNavigate?.(activated);
  };
  navigateFromHistory = (view: View): void => {
    const activated = view.name === "session" && view.attention
      ? { ...view, attention: { ...view.attention, activationId: ++this.attentionActivation } }
      : view;
    if (!sameView(this.state.view, activated) || (activated.name === "session" && activated.attention)) {
      this.dispatch({ type: "navigate", view: activated });
    }
  };
  setInboxPersistenceEnabled = (enabled: boolean): void => {
    if (enabled === this.inboxPersistenceEnabled) return;
    this.inboxPersistenceEnabled = enabled;
    if (!enabled) return;

    // Phone-width selection is intentionally transient. When desktop persistence resumes,
    // restore its last durable state before any socket-driven reducer can serialize the phone
    // selection. Prune preview-only streams and notify subscription synchronization as usual.
    const next = pruneViewStreams({
      ...this.state,
      inbox: loadInboxState(this.instanceScope, this.inboxStorage),
    });
    this.commit(this.reconcileReaderCache(this.state, next));
    this.publish();
  };
  setInboxSelection = (
    sessionId: string | null,
    splitKey = this.state.inbox.splitKey,
    persist = true,
    repair = false,
  ): void => this.dispatch({ type: "inbox_selection", sessionId, splitKey, persist, repair });
  setInboxSplit = (splitKey: string | null, persist = true): void =>
    this.dispatch({ type: "inbox_split", splitKey, persist });
  setInboxRatio = (ratio: number): void => this.dispatch({ type: "inbox_ratio", ratio });
  setFilters = (filters: Partial<Filters>): void => this.dispatch({ type: "filters", filters });
  tickActivity = (now = Date.now()): void => this.dispatch({ type: "activity_tick", now });
  loadEvents = (
    sessionId: string,
    events: SessionEvent[],
    eventEpoch = sessionEventEpoch(this.state.sessions.get(sessionId)),
    recoveryRevision?: number,
    recoveryComplete = true,
    recoveryGeneration = this.state.snapshotRevision,
    windowHasOlder?: boolean,
    windowTurnAligned?: boolean,
  ): void => this.dispatch({
    type: "events_loaded", sessionId, events, eventEpoch, recoveryRevision, recoveryComplete, recoveryGeneration,
    ...(windowHasOlder === undefined ? {} : { windowHasOlder }),
    ...(windowTurnAligned === undefined ? {} : { windowTurnAligned }),
  });
  beginOlderEventsLoad = (
    sessionId: string,
    requestedBase: number,
    eventEpoch = sessionEventEpoch(this.state.sessions.get(sessionId)),
  ): boolean => {
    const before = this.state;
    this.dispatch({ type: "events_older_loading", sessionId, eventEpoch, requestedBase });
    return this.state !== before;
  };

  /** Install a bounded prefix and unread range. Tail metadata is never proof that its events were
   * read. Publish only after the prefix and gap exist together, including racing live frames. */
  loadTurnStartWindow = (
    sessionId: string, page: SessionEventsResponse, recoveryRevision: number,
    recoveryGeneration = this.state.snapshotRevision,
  ): boolean => {
    const epoch = page.eventEpoch;
    const start = page.turnStartSeq;
    let end = page.nextAfter;
    const knownTail = page.tailSeq;
    if (epoch === undefined || start === undefined || end === undefined || knownTail === undefined ||
        !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < 0 ||
        !Number.isSafeInteger(knownTail) || knownTail < end || page.events.length > 200 ||
        page.events.some(event => event.sessionId !== sessionId) ||
        (page.events.length ? page.events[0]!.seq !== start ||
          contiguousEventHighWater(page.events, start - 1) !== end || page.events.at(-1)!.seq !== end
          : start !== 0 || end !== 0) ||
        page.hasMoreLater !== (knownTail > end)) return false;
    const priorWindow = this.state.eventWindows.get(sessionId);
    const priorTail = this.deferredTails.get(sessionId);
    const reuse = priorWindow?.openingStartSeq === start && priorWindow.eventEpoch === epoch &&
      this.state.snapshotRevision === recoveryGeneration;
    // The acknowledgement can arrive after the reader explicitly loaded another page. Reusing
    // the same opening must preserve that contiguous range and the live frames staged beside it.
    let reading = page.events;
    if (reuse && start > 0) {
      const base = priorWindow.baseSeq;
      const retained = (this.state.events.get(sessionId) ?? []).filter(event => event.seq >= base);
      const through = contiguousEventHighWater(retained, base - 1);
      reading = mergeEvents(page.events, retained.filter(event => event.seq <= through));
      end = reading.at(-1)?.seq ?? end;
    }
    const live = mergeEvents((this.state.events.get(sessionId) ?? []).filter(event => event.seq > end),
      reuse && priorTail?.fence.eventEpoch === epoch && priorTail.fence.recoveryGeneration === recoveryGeneration
        ? priorTail.events.filter(event => event.seq > end) : []);
    const tailSeq = Math.max(knownTail, end, live.at(-1)?.seq ?? 0,
      reuse ? priorWindow.laterGap?.tailSeq ?? 0 : 0);
    const before = this.state;
    this.apply({ type: "events_loaded", sessionId, events: reading, eventEpoch: epoch,
      recoveryRevision, recoveryGeneration, recoveryComplete: page.cacheComplete === true && tailSeq <= end,
      windowHasOlder: reuse ? priorWindow.hasOlder : page.hasMoreOlder === true,
      windowTurnAligned: reuse ? priorWindow.turnAligned : page.turnAligned,
      windowThroughSeq: end });
    if (this.state === before) return false;
    const window = this.state.eventWindows.get(sessionId)!;
    const windows = new Map(this.state.eventWindows);
    windows.set(sessionId, { ...window, openingStartSeq: start,
      complete: page.cacheComplete === true && tailSeq <= end });
    this.commit({ ...this.state, eventWindows: windows });
    if (tailSeq > end) {
      const fence = this.beginEventGapRecovery(sessionId, epoch, recoveryRevision, recoveryGeneration, () => true);
      if (!fence) { this.publish(); return false; }
      const bounded = live.length ? this.boundedDeferredEvents(live, sessionId) : null;
      this.deferredTails.set(sessionId, { fence, observedTailSeq: tailSeq, events: bounded?.events ?? [],
        bytes: bounded?.bytes ?? 0, byteSizes: bounded?.byteSizes ?? new Map(),
        httpTailSeq: knownTail, hasOlder: true });
      this.dispatch({ type: "event_gap_state", fence, events: reading,
        window: { ...this.state.eventWindows.get(sessionId)!, laterGap: {
          afterSeq: end, beforeSeq: end + 1, tailSeq, loading: false, error: null, fence,
        } }, settled: true });
    } else this.publish();
    return true;
  };

  failOlderEventsLoad = (
    sessionId: string,
    error: string,
    requestedBase: number,
    eventEpoch = sessionEventEpoch(this.state.sessions.get(sessionId)),
  ): void => this.dispatch({ type: "events_older_failed", sessionId, eventEpoch, requestedBase, error });
  loadOlderEvents = (
    sessionId: string,
    events: SessionEvent[],
    hasOlder: boolean,
    requestedBase: number,
    eventEpoch = sessionEventEpoch(this.state.sessions.get(sessionId)),
    turnAligned?: boolean,
  ): void => this.dispatch({
    type: "events_older_loaded",
    sessionId,
    events,
    hasOlder,
    requestedBase,
    eventEpoch,
    ...(turnAligned === undefined ? {} : { turnAligned }),
  });
  /** Oldest loaded seq for the session's current epoch, or 0 when no window is loaded. */
  eventWindowBase = (sessionId: string): number => {
    const window = this.state.eventWindows.get(sessionId);
    return window && window.eventEpoch === this.eventEpoch(sessionId) ? window.baseSeq : 0;
  };
  getSession = (sessionId: string): SessionView | undefined => this.state.sessions.get(sessionId);
  loadSession = (session: SessionView): void =>
    this.dispatch({ type: "msg", msg: { type: "session_upsert", session } });
  /**
   * Fences a session list read outside the live stream (#2803). The returned `apply` adds only the
   * sessions the stream has not spoken for since the read began: none this client holds, none that
   * arrived, changed or was removed while the read was in flight (held here or not), and nothing at
   * all once a newer snapshot has replaced the list. `cancel` drops a read that failed.
   */
  beginSessionsBackfill = (): { apply: (sessions: readonly SessionView[]) => void; cancel: () => void } => {
    const revision = this.state.snapshotRevision;
    const spoken = new Set<string>();
    const unsubscribe = this.observeTransitions((before, after) => {
      const previous = before.sessions;
      const next = after.sessions;
      if (next === previous) return;
      for (const [sessionId, session] of previous) if (next.get(sessionId) !== session) spoken.add(sessionId);
      for (const sessionId of next.keys()) if (!previous.has(sessionId)) spoken.add(sessionId);
    });
    this.backfillFences.add(spoken);
    const cancel = () => {
      unsubscribe();
      this.backfillFences.delete(spoken);
    };
    return {
      apply: (sessions) => {
        cancel();
        if (this.state.snapshotRevision !== revision) return;
        for (const session of sessions) {
          if (!spoken.has(session.id) && !this.state.sessions.has(session.id)) this.loadSession(session);
        }
      },
      cancel,
    };
  };
  beginEventHistoryLoad = (
    sessionId: string,
    eventEpoch = sessionEventEpoch(this.state.sessions.get(sessionId)),
    recoveryRevision = -1,
    recoveryGeneration = this.state.snapshotRevision,
  ): void => {
    const priorWindow = this.state.eventWindows.get(sessionId);
    const priorTail = this.deferredTails.get(sessionId);
    const retainOpening = priorWindow?.openingStartSeq !== undefined && priorWindow.laterGap && priorTail &&
      priorTail.fence.eventEpoch === eventEpoch && priorTail.fence.recoveryGeneration === recoveryGeneration &&
      recoveryGeneration === this.state.snapshotRevision && this.eventEpoch(sessionId) === eventEpoch;
    this.apply({ type: "event_history_loading", sessionId, eventEpoch, recoveryRevision, recoveryGeneration });
    if (retainOpening) {
      // Transfer the bounded staged rows to the acknowledged owner. A fresh fence revokes old
      // page tickets while preserving live rows through the provisional-to-acknowledged handoff.
      const fence = this.beginEventGapRecovery(sessionId, eventEpoch, recoveryRevision, recoveryGeneration, () => true);
      if (fence) {
        const { pageRequest: _request, ...tail } = priorTail;
        this.deferredTails.set(sessionId, { ...tail, fence });
        const window = this.state.eventWindows.get(sessionId)!;
        this.dispatch({ type: "event_gap_state", fence, events: this.state.events.get(sessionId) ?? [],
          window: { ...window, laterGap: { ...priorWindow.laterGap!, fence, loading: false } }, settled: false });
        return;
      }
    }
    this.publish();
  };
  failEventHistoryLoad = (
    sessionId: string,
    error: string,
    eventEpoch = sessionEventEpoch(this.state.sessions.get(sessionId)),
    recoveryRevision = -1,
    recoveryGeneration = this.state.snapshotRevision,
  ): void => this.dispatch({ type: "event_history_failed", sessionId, eventEpoch, recoveryRevision, recoveryGeneration, error });
  isEventGapRecoveryCurrent = (fence: EventGapFence): boolean => this.currentGapFence(fence);

  beginEventGapRecovery = (
    sessionId: string, eventEpoch: number, recoveryRevision: number, recoveryGeneration: number,
    shouldDeferLive?: () => boolean,
  ): EventGapFence | null => {
    const window = this.state.eventWindows.get(sessionId);
    const reading = this.state.events.get(sessionId);
    // Empty authoritative logs have base0. Once live rows arrive they can own recovery from
    // seq1, while a missing initial prefix still fails contiguity rather than being skipped.
    const baseSeq = window?.baseSeq === 0 && (reading?.length || window.openingStartSeq === 0)
      ? 1 : window?.baseSeq ?? reading?.[0]?.seq ?? 0;
    const fence: EventGapFence = { sessionId, eventEpoch, recoveryRevision, recoveryGeneration,
      operationId: ++this.gapRequestSequence, baseSeq };
    const prior = this.gapOperations.get(sessionId);
    this.gapOperations.set(sessionId, fence);
    if (fence.baseSeq <= 0 || !this.currentGapFence(fence)) {
      if (prior) this.gapOperations.set(sessionId, prior); else this.gapOperations.delete(sessionId);
      return null;
    }
    this.deferredTails.delete(sessionId);
    this.pendingGapLive.delete(sessionId);
    if (shouldDeferLive) this.gapPauseChecks.set(sessionId, shouldDeferLive);
    else this.gapPauseChecks.delete(sessionId);
    if (window?.laterGap) {
      const { laterGap: _gap, ...reading } = window;
      this.dispatch({ type: "event_gap_state", fence, events: this.state.events.get(sessionId) ?? [], window: reading, settled: false });
    }
    return fence;
  };

  cancelEventGapRecovery = (fence: EventGapFence): void => {
    if (this.gapOperations.get(fence.sessionId) !== fence) return;
    const window = this.state.eventWindows.get(fence.sessionId);
    this.deferredTails.delete(fence.sessionId);
    this.pendingGapLive.delete(fence.sessionId);
    this.gapPauseChecks.delete(fence.sessionId);
    if (window?.laterGap?.fence === fence && this.currentGapFence(fence)) {
      const { laterGap: _gap, ...reading } = window;
      this.dispatch({ type: "event_gap_state", fence, events: this.state.events.get(fence.sessionId) ?? [], window: reading, settled: true });
    }
    this.gapOperations.delete(fence.sessionId);
  };

  /** A completed background operation keeps ownership only while it exposes a deferred gap.
   * Otherwise release buffered live rows without claiming any new contiguous recovery progress. */
  finishEventGapRecovery = (fence: EventGapFence): void => {
    if (!this.currentGapFence(fence)) return;
    const window = this.state.eventWindows.get(fence.sessionId);
    if (window?.laterGap?.fence === fence) return;
    const pending = this.pendingGapLive.get(fence.sessionId);
    if (window && pending?.fence === fence && pending.events.length) {
      this.dispatch({ type: "event_gap_state", fence,
        events: mergeEvents(this.state.events.get(fence.sessionId), pending.events), window, settled: false });
    }
    const reading = this.state.events.get(fence.sessionId) ?? [];
    const contiguousTail = contiguousEventHighWater(reading, Math.max(0, (window?.baseSeq ?? reading[0]?.seq ?? fence.baseSeq) - 1));
    if (pending?.fence === fence && pending.observedTailSeq > contiguousTail &&
        !this.state.eventHistory.get(fence.sessionId)?.error) {
      this.failEventHistoryLoad(fence.sessionId,
        "Newer activity could not be retained. Jump to latest to refresh.",
        fence.eventEpoch, fence.recoveryRevision, fence.recoveryGeneration);
    }
    this.pendingGapLive.delete(fence.sessionId);
    this.gapPauseChecks.delete(fence.sessionId);
    this.gapOperations.delete(fence.sessionId);
  };

  loadEventGapWindow = (
    fence: EventGapFence, events: SessionEvent[], complete: boolean, hasOlder: boolean, turnAligned?: boolean,
  ): boolean => {
    if (!this.currentGapFence(fence)) return false;
    const before = this.state;
    const pending = this.pendingGapLive.get(fence.sessionId);
    // A pause can end while this HTTP response is in flight. Preserve frames observed after its
    // point-in-time tail, just as events_loaded preserves newer visible live rows above the base.
    const base = events[0]?.seq ?? 0;
    const retainedLive = pending?.fence === fence ? pending.events.filter(event => event.seq >= base) : [];
    const merged = mergeEvents(events, retainedLive);
    const liveBase = merged[0]?.seq ?? 0;
    const priorWindow = before.eventWindows.get(fence.sessionId);
    // An empty incomplete HTTP answer says nothing about history below a live-only replacement.
    // Keep that history reachable when this epoch already observed it; authoritative HTTP tails
    // still define their own earlier availability, and a live seq alone is not proof.
    const retainKnownEarlier = events.length === 0 && !complete && liveBase > 1 && (
      (priorWindow?.eventEpoch === fence.eventEpoch && priorWindow.hasOlder) ||
      before.events.get(fence.sessionId)?.some(event => event.seq < liveBase) === true
    );
    this.dispatch({ type: "events_loaded", sessionId: fence.sessionId, events: merged,
      eventEpoch: fence.eventEpoch, recoveryRevision: fence.recoveryRevision,
      recoveryGeneration: fence.recoveryGeneration, recoveryComplete: complete,
      windowHasOlder: hasOlder || retainKnownEarlier, gapWindowFence: fence,
      ...(turnAligned === undefined ? {} : { windowTurnAligned: turnAligned }),
    });
    return this.state !== before;
  };

  deferEventTail = (
    fence: EventGapFence, incoming: SessionEvent[], complete: boolean, hasOlder: boolean, turnAligned?: boolean,
  ): boolean => {
    if (!complete || !this.currentGapFence(fence) || !incoming.length ||
        incoming.some(event => event.sessionId !== fence.sessionId)) return false;
    const reading = this.state.events.get(fence.sessionId) ?? [];
    const after = contiguousEventHighWater(reading, fence.baseSeq - 1);
    // A distant frame might already be the reader's chosen anchor. Without that anchor's identity
    // we cannot clip it safely, or describe the visible sparse array as one contiguous window.
    if (!reading.length || after !== reading.at(-1)!.seq) return false;
    const ordered = mergeEvents(undefined, incoming);
    if (contiguousEventHighWater(ordered, ordered[0]!.seq - 1) !== ordered.at(-1)!.seq) return false;
    const pending = this.pendingGapLive.get(fence.sessionId);
    const previous = this.deferredTails.get(fence.sessionId);
    const buffered = mergeEvents(pending?.fence === fence
      ? pending.events.filter(event => event.seq >= ordered[0]!.seq) : [],
      previous?.fence === fence ? previous.events.filter(event => event.seq >= ordered[0]!.seq) : []);
    const combined = mergeEvents(ordered, buffered);
    const observedTailSeq = Math.max(combined.at(-1)!.seq, pending?.fence === fence ? pending.observedTailSeq : 0,
      previous?.fence === fence ? previous.observedTailSeq : 0);
    const bounded = this.boundedDeferredEvents(combined, fence.sessionId);
    if (!bounded) return false;
    const window = this.state.eventWindows.get(fence.sessionId) ?? {
      eventEpoch: fence.eventEpoch, baseSeq: fence.baseSeq, hasOlder: fence.baseSeq > 1,
      complete: this.state.eventHistory.get(fence.sessionId)?.everComplete === true, loadingOlder: false, error: null,
    };
    let retainedReading = reading;
    let readingEnd = after;
    let retainedTail = bounded.events;
    if (retainedTail[0]!.seq <= after + 1) {
      const merged = mergeEvents(reading, retainedTail);
      readingEnd = contiguousEventHighWater(merged, Math.max(0, (window.baseSeq ?? fence.baseSeq) - 1));
      retainedReading = merged.filter(event => event.seq <= readingEnd);
      if (readingEnd >= observedTailSeq) {
        this.pendingGapLive.delete(fence.sessionId);
        this.deferredTails.delete(fence.sessionId);
        const { laterGap: _gap, ...completed } = window;
        this.dispatch({ type: "event_gap_state", fence, events: retainedReading, window: { ...completed, complete: true },
          settled: true, complete: true, advanceCursor: true });
        this.finishEventGapRecovery(fence);
        return true;
      }
      const remaining = retainedTail.filter(event => event.seq > readingEnd);
      // If an oversized live frame had to be dropped, keep bounded HTTP rows as the private
      // proof source. The gap watermark still blocks promotion until that omitted row is read.
      if (remaining.length) retainedTail = remaining;
    }
    this.pendingGapLive.delete(fence.sessionId);
    const tail: DeferredEventTail = { fence, observedTailSeq, events: retainedTail,
      bytes: retainedTail.reduce((bytes, event) => bytes + bounded.byteSizes.get(event.seq)!.bytes, 0),
      byteSizes: new Map(retainedTail.map(event => [event.seq, bounded.byteSizes.get(event.seq)!])),
      httpTailSeq: ordered.at(-1)!.seq, hasOlder: hasOlder || bounded.truncated,
      ...(turnAligned === undefined ? {} : { turnAligned: bounded.truncated ? false : turnAligned }) };
    this.deferredTails.set(fence.sessionId, tail);
    this.dispatch({ type: "event_gap_state", fence, events: retainedReading, window: {
      ...window, laterGap: { afterSeq: readingEnd, beforeSeq: retainedTail.at(-1)!.seq <= readingEnd
          ? observedTailSeq : Math.max(readingEnd + 1, retainedTail[0]!.seq),
        tailSeq: observedTailSeq, loading: false, error: null, fence },
    }, settled: true });
    return true;
  };

  beginLaterEventsLoad = (sessionId: string): LaterEventsRequest | null => {
    const tail = this.deferredTails.get(sessionId);
    const window = this.state.eventWindows.get(sessionId);
    const gap = window?.laterGap;
    if (!tail || !gap || gap.loading || !this.currentGapFence(tail.fence)) return null;
    const request: LaterEventsRequest = { fence: tail.fence, after: gap.afterSeq, requestId: ++this.gapRequestSequence };
    tail.pageRequest = request;
    this.dispatch({ type: "event_gap_state", fence: tail.fence, events: this.state.events.get(sessionId) ?? [],
      window: { ...window!, laterGap: { ...gap, loading: true, error: null } }, settled: false });
    return request;
  };

  failLaterEventsLoad = (request: LaterEventsRequest, error: string): void => {
    const tail = this.deferredTails.get(request.fence.sessionId);
    const window = this.state.eventWindows.get(request.fence.sessionId);
    const gap = window?.laterGap;
    if (!tail || tail.pageRequest !== request || !gap || gap.afterSeq !== request.after || !this.currentGapFence(request.fence)) return;
    delete tail.pageRequest;
    this.dispatch({ type: "event_gap_state", fence: request.fence, events: this.state.events.get(request.fence.sessionId) ?? [],
      window: { ...window!, laterGap: { ...gap, loading: false, error } }, settled: false });
  };

  loadLaterEvents = (request: LaterEventsRequest, page: SessionEventsResponse): boolean => {
    const id = request.fence.sessionId;
    const tail = this.deferredTails.get(id);
    const window = this.state.eventWindows.get(id);
    const gap = window?.laterGap;
    if (!tail || tail.pageRequest !== request || !gap || gap.afterSeq !== request.after ||
        !this.currentGapFence(request.fence) || (page.eventEpoch ?? request.fence.eventEpoch) !== request.fence.eventEpoch ||
        page.events.length > 200 || page.events.some(event => event.sessionId !== id)) return false;
    const ordered = mergeEvents(undefined, page.events);
    const after = contiguousEventHighWater(ordered, request.after);
    if ((ordered.length && (ordered[0]!.seq !== request.after + 1 || after !== ordered.at(-1)!.seq)) ||
        (!ordered.length && page.hasMoreCached === true) ||
        (page.nextAfter !== undefined && page.nextAfter !== after)) return false;
    delete tail.pageRequest;
    let reading = mergeEvents(this.state.events.get(id), ordered);
    let end = after;
    if (tail.events.length && tail.events[0]!.seq <= end + 1) {
      const connected = contiguousEventHighWater(tail.events, end);
      reading = mergeEvents(reading, tail.events.filter(event => event.seq <= connected));
      end = connected;
    }
    const done = page.cacheComplete === true && end >= gap.tailSeq && end >= tail.httpTailSeq;
    const { laterGap: _gap, ...baseWindow } = window!;
    if (done) this.deferredTails.delete(id);
    else {
      const remaining = tail.events.filter(event => event.seq > end);
      tail.events = remaining;
      tail.bytes = remaining.reduce((bytes, event) => bytes + (tail.byteSizes.get(event.seq)?.bytes ?? 0), 0);
      tail.byteSizes = new Map(remaining.map(event => [event.seq, tail.byteSizes.get(event.seq)!]));
    }
    this.dispatch({ type: "event_gap_state", fence: request.fence, events: reading,
      window: done ? { ...baseWindow, complete: page.cacheComplete === true } : { ...baseWindow, laterGap: { ...gap, afterSeq: end,
        beforeSeq: Math.max(end + 1, tail.events[0]?.seq ?? end + 1), loading: false, error: null } },
      settled: true, complete: done, advanceCursor: done });
    if (done) this.finishEventGapRecovery(request.fence);
    return true;
  };

  promoteDeferredEventTail = (fence: EventGapFence): boolean => {
    const tail = this.deferredTails.get(fence.sessionId);
    const gap = this.state.eventWindows.get(fence.sessionId)?.laterGap;
    if (!tail || !tail.events.length || tail.fence !== fence || !gap || !this.currentGapFence(fence) ||
        tail.events[0]!.seq > tail.httpTailSeq ||
        contiguousEventHighWater(tail.events, tail.events[0]!.seq - 1) < gap.tailSeq) return false;
    // This is an explicit change of reading window: the omitted prefix becomes ordinary older
    // history, and only this contiguous current slice supplies the acknowledged cursor.
    const { provisionalRestTail: _receipt, laterGap: _gap, ...priorWindow } = this.state.eventWindows.get(fence.sessionId)!;
    this.dispatch({ type: "event_gap_state", fence, events: tail.events,
      window: { ...priorWindow, baseSeq: tail.events[0]!.seq, hasOlder: tail.hasOlder || tail.events[0]!.seq > 1,
        complete: true, turnAligned: tail.turnAligned, loadingOlder: false, error: null },
      settled: true, complete: true, advanceCursor: true });
    return true;
  };

  loadPodContext = (podId: string, entries: PodContextEntry[]): void =>
    this.dispatch({ type: "pod_context_loaded", podId, entries });
  eventHighWater = (sessionId: string): number => eventHighWater(this.state.events.get(sessionId));
  recoveryAfter = (sessionId: string): number => this.state.streamRecoveryCursors.get(sessionId) ?? 0;
  /** A completed provisional REST window can precede its subscription acknowledgement. It already
   * replaced the visible slice while following, so the acknowledged read starts at that proven
   * tail instead of replaying its omitted prefix if the reader paused meanwhile. This is local to
   * the read: the frozen stream cursor stays unchanged, and distant live rows cannot raise it. */
  recoveryReadAfter = (sessionId: string, eventEpoch: number, recoveryGeneration: number): number => {
    const frozen = this.recoveryAfter(sessionId);
    const window = this.state.eventWindows.get(sessionId);
    const receipt = window?.provisionalRestTail;
    const events = this.state.events.get(sessionId);
    if (!events || this.state.snapshotRevision !== recoveryGeneration || this.eventEpoch(sessionId) !== eventEpoch ||
        this.state.eventEpochs.get(sessionId) !== eventEpoch || window?.eventEpoch !== eventEpoch ||
        !receipt || receipt.recoveryGeneration !== recoveryGeneration || window.baseSeq <= 0 ||
        receipt.seq < window.baseSeq) return frozen;
    const contiguous = contiguousEventHighWater(events, window.baseSeq - 1);
    return contiguous >= receipt.seq ? Math.max(frozen, receipt.seq) : frozen;
  };
  eventEpoch = (sessionId: string): number => sessionEventEpoch(this.state.sessions.get(sessionId));
  prepareSubscriptionRecovery = (revision: number, sessionIds: string[]): void =>
    this.dispatch({ type: "subscription_requested", revision, sessionIds });
  reconcileShellOutputs = (sessionId: string, shellIds: string[]): void =>
    this.dispatch({ type: "shells_reconciled", sessionId, shellIds });
  loadShellHistory = (
    sessionId: string,
    shellId: string,
    chunks: ShellOutputChunk[],
    status: ShellStatus,
    exitCode: number | null,
    truncated: boolean,
  ): void => this.dispatch({
    type: "shell_history_loaded", sessionId, shellId, chunks, status, exitCode, truncated,
  });
  removeShellOutput = (shellId: string): void => this.dispatch({ type: "shell_output_removed", shellId });
}

const StoreContext = createContext<Store | null>(null);

const defaultUiConnection = createBrowserUiConnection({
  instanceId: "local",
  runtimeKey: "local:0",
  websocketOrigin: CONTROL_PLANE_WS,
  token: deviceToken,
  onCredentialChange(listener) {
    window.addEventListener(DEVICE_TOKEN_CHANGED_EVENT, listener);
    return () => window.removeEventListener(DEVICE_TOKEN_CHANGED_EVENT, listener);
  },
});

export function StoreProvider({
  children,
  connection = defaultUiConnection,
  navigation: suppliedNavigation,
}: {
  children: ReactNode;
  connection?: UiConnectionRuntime;
  navigation?: ViewNavigation;
}) {
  const storeRef = useRef<Store | null>(null);
  const navigationRef = useRef<ViewNavigation | null>(null);
  const runtimeKeyRef = useRef<string | null>(null);
  if (runtimeKeyRef.current !== connection.runtimeKey) {
    runtimeKeyRef.current = connection.runtimeKey;
    storeRef.current = null;
    navigationRef.current = null;
  }
  if (!storeRef.current) {
    navigationRef.current = suppliedNavigation ?? (typeof window === "undefined" ? null : new BrowserNavigation());
    const navigation = navigationRef.current;
    storeRef.current = new Store(
      navigation?.current(),
      navigation ? (view) => navigation.push(view) : undefined,
      connection.instanceId,
    );
  }
  const store = storeRef.current;
  const reconnectRef = useRef<number | null>(null);
  const wsRef = useRef<UiSocket | null>(null);

  // Socket frames received within one animation frame publish as one store update (#2763). A
  // hidden tab gets no animation frames, so it publishes each frame at once, and anything still
  // waiting is published as the tab is hidden or the page is left.
  useEffect(() => {
    const scheduler = defaultPublishScheduler();
    if (!scheduler || typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return;
    store.setPublishScheduler(scheduler);
    const publishWhenHidden = () => {
      if (document.visibilityState === "hidden") store.publish();
    };
    document.addEventListener("visibilitychange", publishWhenHidden);
    window.addEventListener("pagehide", store.publish);
    return () => {
      document.removeEventListener("visibilitychange", publishWhenHidden);
      window.removeEventListener("pagehide", store.publish);
      store.setPublishScheduler(null);
    };
  }, [store]);

  useEffect(() => {
    const dispatch = store.dispatch;
    let closed = false;
    let cancelBackgroundObservations = () => {};
    const subscriptionSync = new UiSubscriptionSynchronizer();
    const syncSubscriptions = () => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== UI_SOCKET_OPEN) return;
      const state = store.getState();
      const msg: UiToControlPlane | null = subscriptionSync.nextMessage(
        state,
        state.streamSubscriptions.mode === "targeted",
      );
      if (!msg || msg.type !== "session_subscriptions") return;
      // Freeze the durable recovery cursor before the server can apply this replacement. A live
      // event delivered immediately after its acknowledgement must not advance us past older gaps.
      store.prepareSubscriptionRecovery(msg.revision, msg.sessionIds);
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        ws.close();
      }
    };
    const open = () => {
      cancelBackgroundObservations();
      dispatch({ type: "conn", conn: "connecting" });
      // Browsers can't set headers on WS — a paired device authenticates via query param.
      const ws = connection.createSocket();
      wsRef.current = ws;
      const backgroundObservations = new BackgroundDeliveryObservationTracker();
      let backgroundObservationRetryTimer: number | null = null;
      const cancelObservations = () => {
        if (backgroundObservationRetryTimer != null) {
          window.clearTimeout(backgroundObservationRetryTimer);
          backgroundObservationRetryTimer = null;
        }
        backgroundObservations.clear();
      };
      cancelBackgroundObservations = cancelObservations;
      const scheduleObservationRetry = () => {
        if (backgroundObservationRetryTimer != null) window.clearTimeout(backgroundObservationRetryTimer);
        const nextRetryAt = backgroundObservations.nextRetryAt();
        if (nextRetryAt === undefined) {
          backgroundObservationRetryTimer = null;
          return;
        }
        backgroundObservationRetryTimer = window.setTimeout(() => {
          backgroundObservationRetryTimer = null;
          if (closed || wsRef.current !== ws) return;
          sendDueBackgroundObservations([...store.getState().sessions.values()], true);
        }, Math.max(0, nextRetryAt - Date.now()));
      };
      const sendDueBackgroundObservations = (sessions: readonly SessionView[], authoritative = false) => {
        try {
          for (const observed of backgroundObservations.due(sessions, Date.now(), authoritative)) {
            ws.send(JSON.stringify(observed));
          }
          scheduleObservationRetry();
        } catch {
          ws.close();
        }
      };
      ws.onopen = () => {
        subscriptionSync.resetConnection();
        syncSubscriptions();
      };
      // "online" (which also clears the authRequired latch) is declared on the FIRST MESSAGE,
      // never on ws.onopen: the control plane completes the upgrade and only then auth-checks,
      // closing rejects with 1008 — so an unauthorized socket still fires `open`. Trusting it
      // flashed online, unmounted the pairing card (wiping the draft), then relatched on the
      // 1008. The CP sends the snapshot immediately on an accepted connect, so the first
      // frame is an equivalent, authenticated signal.
      let receivedFrame = false;
      ws.onmessage = (ev) => {
        if (closed) return;
        if (!receivedFrame) {
          receivedFrame = true;
          dispatch({ type: "conn", conn: "online" });
        }
        try {
          const msg = JSON.parse(ev.data as string) as ControlPlaneToUi;
          store.receiveFrame(msg, Date.now());
          const sessions: readonly SessionView[] = msg.type === "snapshot" || msg.type === "session_snapshot_page"
            ? msg.sessions
            : msg.type === "session_upsert"
              ? [msg.session]
              : [];
          const completeInventory = msg.type === "snapshot" && msg.sessionsComplete !== false ||
            msg.type === "session_snapshot_page" && msg.complete;
          sendDueBackgroundObservations(msg.type === "session_snapshot_page" && msg.complete
            ? [...store.getState().sessions.values()] : sessions, completeInventory);
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = (ev) => {
        if (closed) return;
        cancelObservations();
        subscriptionSync.resetConnection();
        if (shellStreamMayBeIncomplete(ev.code)) dispatch({ type: "shell_stream_incomplete" });
        // 1008 (policy violation) is what the CP sends for every auth rejection — no token,
        // revoked device, disallowed origin. Surface a pairing prompt and retry slowly: a
        // fast loop can't fix a missing credential, but a re-pair elsewhere should self-heal.
        const unauthorized = ev.code === 1008;
        dispatch({ type: "conn", conn: unauthorized ? "unauthorized" : "offline", authRequired: unauthorized || undefined });
        reconnectRef.current = window.setTimeout(() => {
          reconnectRef.current = null;
          open();
        }, unauthorized ? 10_000 : 1500);
      };
      ws.onerror = () => ws.close();
    };
    const unsubscribeSubscriptions = store.subscribe(syncSubscriptions);
    // A token stored by the pairing card must take effect IN-PROCESS: reloading would lose the
    // in-memory fallback that carries the token when localStorage is blocked (iOS private
    // mode / partitioned webview) — the review-caught infinite pairing loop.
    const onTokenChanged = () => {
      if (closed) return;
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
      cancelBackgroundObservations();
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        ws.close();
        wsRef.current = null;
      }
      open();
    };
    const unsubscribeCredentialChanges = connection.onCredentialChange?.(onTokenChanged);
    // Only a pending retry can be brought forward. While a socket is opening or online there is
    // none, so a second Retry Now never opens a second socket; the retry cadence is unchanged.
    store.setReconnectHandler(() => {
      const conn = store.getState().conn;
      if (closed || reconnectRef.current === null || conn === "connecting" || conn === "online") return false;
      window.clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
      open();
      return true;
    });
    open();
    return () => {
      closed = true;
      store.setReconnectHandler(null);
      unsubscribeCredentialChanges?.();
      unsubscribeSubscriptions();
      cancelBackgroundObservations();
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        ws.close();
        wsRef.current = null;
      }
    };
  }, [connection.runtimeKey, store]);

  // One shared clock drives every stall transition. Align to wall-clock minute boundaries so the
  // store scans the session map once per minute rather than once per card/component.
  useEffect(() => {
    let timer: number | null = null;
    let stopped = false;
    const schedule = () => {
      const now = Date.now();
      const delay = ACTIVITY_BUCKET_MS - (now % ACTIVITY_BUCKET_MS) + 5;
      timer = window.setTimeout(() => {
        if (stopped) return;
        store.tickActivity(Date.now());
        schedule();
      }, delay);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") store.tickActivity(Date.now());
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [store]);

  // Desktop notifications: clicking one jumps to the session. The transition diff observes every
  // state change, including socket frames still waiting for their animation frame, so a status
  // that lasts less than a frame is still notified — no React re-render involved, and no full-map
  // walk unless the sessions map actually changed.
  useEffect(() => {
    const unsub = store.observeTransitions((previous, next) => {
      const prev = previous.sessions;
      const cur = next.sessions;
      if (cur === prev) return;
      for (const [id, s] of cur) {
        const show = (payload: NotifyPayload) => notifier.show(payload, {
          instanceId: connection.instanceId,
          onClick: (id, attention) => {
            const view = { name: "session" as const, id, ...(attention ? { attention } : {}) };
            if (navigationRef.current?.activate) navigationRef.current.activate(view);
            else store.navigate(view);
          },
        });
        const statusPayload = notifyDecision(prev.get(id), s);
        if (statusPayload) show(statusPayload);
        for (const payload of backgroundDeliveryNotifyDecisions(prev.get(id), s)) show(payload);
      }
    });
    return () => {
      unsub();
    };
  }, [connection.instanceId, store]);

  // Browser history is an input as well as an output: popstate updates the same store action used
  // by in-app navigation, without pushing a duplicate entry while walking backward or forward.
  useEffect(() => navigationRef.current?.listen((view) => store.navigateFromHistory(view)), [store]);

  // An already-open dashboard receives a service-worker message. Fresh windows now open directly
  // on canonical paths; the boot shim still migrates links from older installed workers.
  useEffect(() => {
    const sw = "serviceWorker" in navigator ? navigator.serviceWorker : null;
    const onMessage = (e: MessageEvent) => {
      const view = viewFromNotificationMessage(e.data);
      if (view) store.navigate(view);
    };
    sw?.addEventListener("message", onMessage);
    return () => sw?.removeEventListener("message", onMessage);
  }, [store]);

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

function useStoreHandle(): Store {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}

/** Whether a store is mounted above. Views that also render standalone (tests, harness pages)
 * gate their store-backed children on this instead of throwing. */
export function useHasStore(): boolean {
  return useContext(StoreContext) !== null;
}

/** Stable action handles (never cause re-renders). */
export function useStoreActions(): Pick<Store, "dispatch" | "navigate" | "setInboxPersistenceEnabled" | "setInboxSelection" | "setInboxSplit" | "setInboxRatio" | "setFilters" | "loadEvents" | "loadTurnStartWindow" | "loadOlderEvents" | "beginOlderEventsLoad" | "failOlderEventsLoad" | "eventWindowBase" | "loadSession" | "getSession" | "beginSessionsBackfill" | "beginEventHistoryLoad" | "failEventHistoryLoad" | "isEventGapRecoveryCurrent" | "beginEventGapRecovery" | "cancelEventGapRecovery" | "finishEventGapRecovery" | "loadEventGapWindow" | "deferEventTail" | "beginLaterEventsLoad" | "loadLaterEvents" | "failLaterEventsLoad" | "promoteDeferredEventTail" | "loadPodContext" | "eventHighWater" | "recoveryAfter" | "recoveryReadAfter" | "eventEpoch" | "reconcileShellOutputs" | "loadShellHistory" | "removeShellOutput" | "reconnectNow"> {
  return useStoreHandle();
}

/**
 * Subscribe to a SLICE of the store. The component re-renders only when the selected value
 * changes (Object.is by default — select stable references like Map entries, not fresh
 * objects/arrays, or pass a custom isEqual).
 */
export function useStoreSelector<T>(selector: (s: State) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const store = useStoreHandle();
  const lastRef = useRef<{ v: T } | null>(null);
  const getSnapshot = () => {
    const next = selector(store.getState());
    const last = lastRef.current;
    if (last && isEqual(last.v, next)) return last.v;
    lastRef.current = { v: next };
    return next;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot);
}

/**
 * Like `useStoreSelector`, but a published change for which `quiet(previous, next)` holds does not
 * render the component (#2763). Whenever it renders for another reason, it reads the current value.
 * `quiet` must be transitive: a run of quiet changes is quiet as a whole.
 */
export function useStoreSelectorUnlessQuiet<T>(
  selector: (s: State) => T,
  quiet: (previous: T, next: T) => boolean,
): T {
  const store = useStoreHandle();
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const quietRef = useRef(quiet);
  quietRef.current = quiet;
  const subscribe = useCallback((onChange: () => void) => {
    let seen = selectorRef.current(store.getState());
    return store.subscribe(() => {
      const next = selectorRef.current(store.getState());
      if (Object.is(next, seen)) return;
      const silent = quietRef.current(seen, next);
      seen = next;
      if (!silent) onChange();
    });
  }, [store]);
  return useSyncExternalStore(subscribe, () => selectorRef.current(store.getState()));
}

/** The store's `navigate`, or undefined where no store is mounted (a shared page, a harness): for
 * a link that leads into the app only where the app is there to open it. */
export function useOptionalNavigate(): Store["navigate"] | undefined {
  return useContext(StoreContext)?.navigate;
}

/** Store-backed enhancement for components that also have intentional standalone renderers. */
export function useOptionalStoreSelector<T>(
  selector: (s: State) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T | undefined {
  const store = useContext(StoreContext);
  const lastRef = useRef<{ v: T } | null>(null);
  const getSnapshot = () => {
    if (!store) return undefined;
    const next = selector(store.getState());
    const last = lastRef.current;
    if (last && isEqual(last.v, next)) return last.v;
    lastRef.current = { v: next };
    return next;
  };
  return useSyncExternalStore(store?.subscribe ?? (() => () => {}), getSnapshot, getSnapshot);
}

/**
 * The store's current version of `session`, for a part of the session view that shows a streaming
 * field: live usage, cost, activity time or the message count (#2872). The view itself keeps the
 * version it last rendered while only those fields move, so it does not render four times a second
 * while an agent streams. Falls back to `session` where no store is mounted or it holds no such session.
 */
export function useLiveSession<T extends Pick<SessionView, "id">>(session: T): T {
  // `T` is a view of a `SessionView` (the whole one, or a Pick of it), which the stored one satisfies.
  return (useOptionalStoreSelector((s) => s.sessions.get(session.id)) as T | undefined) ?? session;
}

/**
 * Renders the caller whenever its session changes, streaming fields included, as the whole session
 * view used to (#2872): for a part that reads the clock as it renders, such as an age, and so moved
 * on with every paced upsert. Does nothing where no store is mounted.
 */
export function useSessionChanges(sessionId: string | undefined): void {
  useOptionalStoreSelector((s) => sessionId === undefined ? undefined : s.sessions.get(sessionId));
}

/** A store value read and watched without rendering. */
export interface StoreValueSource<T> {
  read(): T;
  subscribe(onChange: () => void): () => void;
}

/**
 * `selector`'s value as a source an effect can read and watch, for work that follows a change
 * without showing it, such as a refetch (#2872). The component does not render for it. `selector`
 * is read when the source is, so it may use values the component renders with: the one of the latest
 * committed render, taken before any effect runs.
 */
export function useStoreValueSource<T>(selector: (s: State) => T): StoreValueSource<T> {
  const store = useStoreHandle();
  const selectorRef = useRef(selector);
  useInsertionEffect(() => { selectorRef.current = selector; });
  return useMemo(() => ({ read: () => selectorRef.current(store.getState()), subscribe: store.subscribe }), [store]);
}

/** Back-compat full-state subscription: re-renders on EVERY store change. Fine for transient
 * mounts (dialogs, the Runners view); always-mounted components use useStoreSelector. */
export function useStore(): StoreValue {
  const store = useStoreHandle();
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return {
    ...state,
    dispatch: store.dispatch,
    navigate: store.navigate,
    setInboxPersistenceEnabled: store.setInboxPersistenceEnabled,
    setInboxSelection: store.setInboxSelection,
    setInboxSplit: store.setInboxSplit,
    setInboxRatio: store.setInboxRatio,
    setFilters: store.setFilters,
    loadEvents: store.loadEvents,
    loadTurnStartWindow: store.loadTurnStartWindow,
    loadOlderEvents: store.loadOlderEvents,
    beginOlderEventsLoad: store.beginOlderEventsLoad,
    failOlderEventsLoad: store.failOlderEventsLoad,
    eventWindowBase: store.eventWindowBase,
    loadSession: store.loadSession,
    getSession: store.getSession,
    beginEventHistoryLoad: store.beginEventHistoryLoad,
    failEventHistoryLoad: store.failEventHistoryLoad,
    isEventGapRecoveryCurrent: store.isEventGapRecoveryCurrent,
    beginEventGapRecovery: store.beginEventGapRecovery,
    cancelEventGapRecovery: store.cancelEventGapRecovery,
    finishEventGapRecovery: store.finishEventGapRecovery,
    loadEventGapWindow: store.loadEventGapWindow,
    deferEventTail: store.deferEventTail,
    beginLaterEventsLoad: store.beginLaterEventsLoad,
    loadLaterEvents: store.loadLaterEvents,
    failLaterEventsLoad: store.failLaterEventsLoad,
    promoteDeferredEventTail: store.promoteDeferredEventTail,
    loadPodContext: store.loadPodContext,
    eventHighWater: store.eventHighWater,
    recoveryAfter: store.recoveryAfter,
    recoveryReadAfter: store.recoveryReadAfter,
    eventEpoch: store.eventEpoch,
    reconcileShellOutputs: store.reconcileShellOutputs,
    loadShellHistory: store.loadShellHistory,
    removeShellOutput: store.removeShellOutput,
  };
}
