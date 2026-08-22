import {
  createContext,
  useContext,
  useEffect,
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
  SessionReminderView,
  SessionView,
  ShellOutputChunk,
  ShellStatus,
  UiToControlPlane,
} from "@wollipog/protocol";
import { CONTROL_PLANE_WS } from "./config.js";
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
import {
  INBOX_DEFAULT_RATIO,
  INBOX_SELECTION_STORAGE_KEY,
  INBOX_SPLIT_RATIO_MAX,
  INBOX_SPLIT_RATIO_MIN,
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
export const INBOX_DEFAULT_SPLIT_RATIO = INBOX_DEFAULT_RATIO;
export const INBOX_MIN_SPLIT_RATIO = INBOX_SPLIT_RATIO_MIN;
export const INBOX_MAX_SPLIT_RATIO = INBOX_SPLIT_RATIO_MAX;
export { clampInboxSplitRatio, parseInboxSplitRatio };

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
  hasOlder: boolean;
  /** The read that produced this window reached the runner's tail. A budget-expired window reports
   * no older rows while still being a prefix, so completeness is tracked separately. */
  complete: boolean;
  loadingOlder: boolean;
  error: string | null;
}

/** Whether the loaded events are known NOT to be the session's whole history. Consumers that treat
 * absence as evidence — receipts, whole-session inventories — must ask this, not `hasOlder`. */
export function isPartialHistory(window: EventWindowState | undefined): boolean {
  return window !== undefined && (window.hasOlder || !window.complete);
}

export interface State {
  conn: ConnState;
  /** Latched by a policy-closed (1008) /ui socket; cleared only by a successful connect. Keeps
   * the pairing card mounted (draft intact) across the background retries, whose transient
   * "connecting"/"offline" states would otherwise unmount it every cycle. */
  authRequired: boolean;
  /** True after an authoritative UI snapshot has populated the resource maps. */
  snapshotLoaded: boolean;
  /** Monotonic reconnect generation used to revalidate REST-only routed resources. */
  snapshotRevision: number;
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
  /** True when the control plane provides durable, user-scoped reminder snapshots and deltas. */
  sessionRemindersSupported: boolean;
  runners: Map<string, RunnerView>;
  boxes: Map<string, BoxView>;
  /** Authoritative when the snapshot advertises Project support; empty against legacy control
   * planes, whose exact workspace grouping remains a UI-level fallback. */
  projects: Map<string, ProjectView>;
  sessions: Map<string, SessionView>;
  reminders: Map<string, SessionReminderView>;
  runs: Map<string, RunView>;
  pods: Map<string, PodView>;
  podContext: Map<string, PodContextEntry[]>;
  events: Map<string, SessionEvent[]>;
  /** Fixed-size per-session heartbeat rings. Unlike full timelines, these survive view changes. */
  activity: Map<string, SessionActivity>;
  /** Shared minute clock and derived stall state; sets/maps are stable and revisioned explicitly. */
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
  | { type: "inbox_selection"; sessionId: string | null; splitKey: string | null; persist?: boolean }
  | { type: "inbox_split"; splitKey: string | null; persist?: boolean }
  | { type: "inbox_ratio"; ratio: number }
  | { type: "filters"; filters: Partial<Filters> };

/** Event arrays NOT produced by a pure append: merges can REPLACE elements anywhere in the
 * prefix while preserving length and tail identity, so useTimeline's cheap extension check
 * (tail identity) would wrongly keep its incrementally-folded prefix. Tagged here; the hook
 * rebuilds whenever it encounters a tagged array it hasn't folded from scratch. */
const rebuiltArrays = new WeakSet<SessionEvent[]>();
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

/** Mutates the stable derived set, publishing scalar revision/count changes only when membership moves. */
function updateSessionStall(state: State, sessionId: string, now = state.activityNow): State {
  const session = state.sessions.get(sessionId);
  const stalled = session !== undefined && !session.archived && sessionIsStalled(state, session, now);
  const wasStalled = state.stalledSessionIds.has(sessionId);
  if (stalled === wasStalled) return state;
  if (stalled) state.stalledSessionIds.add(sessionId);
  else state.stalledSessionIds.delete(sessionId);
  return {
    ...state,
    stalledRevision: state.stalledRevision + 1,
    stalledCount: state.stalledSessionIds.size,
  };
}

function clearSessionStall(state: State, sessionId: string): State {
  if (!state.stalledSessionIds.delete(sessionId)) return state;
  return {
    ...state,
    stalledRevision: state.stalledRevision + 1,
    stalledCount: state.stalledSessionIds.size,
  };
}

/** Rare lifecycle/minute-clock scan. The session-event hot path never calls this. */
function scanSessionStalls(state: State, now = state.activityNow): State {
  let changed = false;
  for (const sessionId of [...state.stalledSessionIds]) {
    if (!state.sessions.has(sessionId)) {
      state.stalledSessionIds.delete(sessionId);
      changed = true;
    }
  }
  for (const session of state.sessions.values()) {
    const stalled = !session.archived && sessionIsStalled(state, session, now);
    const wasStalled = state.stalledSessionIds.has(session.id);
    if (stalled === wasStalled) continue;
    if (stalled) state.stalledSessionIds.add(session.id);
    else state.stalledSessionIds.delete(session.id);
    changed = true;
  }
  return changed
    ? {
        ...state,
        stalledRevision: state.stalledRevision + 1,
        stalledCount: state.stalledSessionIds.size,
      }
    : state;
}

function captureRecoveryCursors(state: State, sessionIds: Iterable<string>): Map<string, number> {
  return new Map([...sessionIds].map((sessionId) => [sessionId, eventHighWater(state.events.get(sessionId))]));
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
  // reader-driven page has a window to attach to.
  if (pageBase === undefined) {
    // An empty retry that reached the tail still settles completeness for the epoch; otherwise a
    // session whose first read expired stays partial forever despite an authoritative answer.
    if (priorValid) {
      if (!action.recoveryComplete || priorValid.complete) return state.eventWindows;
      const promoted = new Map(state.eventWindows);
      promoted.set(action.sessionId, { ...priorValid, complete: true });
      return promoted;
    }
    const eventWindows = new Map(state.eventWindows);
    eventWindows.set(action.sessionId, {
      eventEpoch: action.eventEpoch,
      baseSeq: 0,
      hasOlder: action.windowHasOlder,
      complete: action.recoveryComplete,
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
    hasOlder: action.windowHasOlder,
    // Completeness is monotonic within an epoch: a re-read that reaches the tail settles it, and a
    // later partial read cannot unsettle what was already proven complete.
    complete: action.recoveryComplete || (priorValid?.complete ?? false),
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
        state.stalledSessionIds.clear();
        next = {
          ...next,
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
      // Drop event arrays (and shell scrollback) for sessions the new view doesn't display,
      // so memory stays bounded to what's on screen (re-fetched on open).
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
      const retained = windowBase === undefined
        ? events.get(action.sessionId)
        : events.get(action.sessionId)?.filter((entry) => entry.seq >= windowBase);
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
      // Reader-driven prepend. Unlike recovery it carries no completion or cursor meaning: the
      // window only grows downward, so neither history state nor the forward gap cursor moves.
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
          const sessions = new Map(msg.sessions.map((session) => [session.id, session]));
          // Live snapshots deliberately omit archived rows. Keep the currently rendered archived
          // detail mounted across reconnect; SessionDetail revalidates it against the exact REST
          // endpoint for this snapshot generation and removes it on an authoritative 404.
          const routedSession = state.view.name === "session" ? state.sessions.get(state.view.id) : undefined;
          if (routedSession?.archived && !sessions.has(routedSession.id)) {
            sessions.set(routedSession.id, routedSession);
          }
          const activity = state.activity;
          for (const sessionId of [...activity.keys()]) {
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
            snapshotLoaded: true,
            snapshotRevision: state.snapshotRevision + 1,
            projectsSupported: msg.capabilities?.projects === true || msg.projects !== undefined,
            projectLocationCreationSupported: msg.capabilities?.createProjectLocations === true,
            accessScopeManagementSupported: msg.capabilities?.accessScopeManagement === true,
            nativeTuiLaunchSupported: msg.capabilities?.nativeTuiLaunch === true,
            stopBeforeArchiveSupported: msg.capabilities?.stopBeforeArchive === true,
            sessionRemindersSupported: msg.capabilities?.sessionReminders === true,
            runners: new Map(msg.runners.map((r) => [r.runnerId, r])),
            // `boxes` may be absent from an older control plane's snapshot — tolerate it.
            boxes: new Map((msg.boxes ?? []).map((b) => [b.boxId, b])),
            // `projects` is additive: older control planes omit it and retain an empty inventory.
            projects: new Map((msg.projects ?? []).map((project) => [project.id, project])),
            sessions,
            reminders: new Map((msg.reminders ?? []).map((reminder) => [reminder.sessionId, reminder])),
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
        case "session_upsert": {
          const sessions = new Map(state.sessions);
          const previousSession = sessions.get(msg.session.id);
          sessions.set(msg.session.id, msg.session);
          state.activity.set(msg.session.id, reconcileSessionActivity(
            state.activity.get(msg.session.id),
            previousSession,
            msg.session,
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
                selectedSessionId: state.inbox.selectedSessionId === msg.sessionId ? null : state.inbox.selectedSessionId,
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

function initialState(view: View = { name: "inbox" }, inbox = loadInboxState()): State {
  return {
    conn: "connecting",
    authRequired: false,
    snapshotLoaded: false,
    snapshotRevision: 0,
    projectsSupported: false,
    projectLocationCreationSupported: false,
    accessScopeManagementSupported: false,
    nativeTuiLaunchSupported: false,
    stopBeforeArchiveSupported: false,
    sessionRemindersSupported: false,
    runners: new Map(),
    boxes: new Map(),
    projects: new Map(),
    sessions: new Map(),
    reminders: new Map(),
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
    filters: { runnerId: null, agentId: null },
  };
}

interface StoreValue extends State {
  dispatch: Dispatch<Action>;
  navigate: (view: View) => void;
  setInboxPersistenceEnabled: (enabled: boolean) => void;
  setInboxSelection: (sessionId: string | null, splitKey?: string | null, persist?: boolean) => void;
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
  ) => void;
  loadOlderEvents: (
    sessionId: string,
    events: SessionEvent[],
    hasOlder: boolean,
    requestedBase: number,
    eventEpoch?: number,
  ) => void;
  beginOlderEventsLoad: (sessionId: string, requestedBase: number, eventEpoch?: number) => void;
  failOlderEventsLoad: (sessionId: string, error: string, requestedBase: number, eventEpoch?: number) => void;
  eventWindowBase: (sessionId: string) => number;
  loadSession: (session: SessionView) => void;
  beginEventHistoryLoad: (
    sessionId: string,
    eventEpoch?: number,
    recoveryRevision?: number,
    recoveryGeneration?: number,
  ) => void;
  failEventHistoryLoad: (sessionId: string, error: string, eventEpoch?: number, recoveryRevision?: number, recoveryGeneration?: number) => void;
  loadPodContext: (podId: string, entries: PodContextEntry[]) => void;
  eventHighWater: (sessionId: string) => number;
  recoveryAfter: (sessionId: string) => number;
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
export class Store {
  private state: State;
  private readonly listeners = new Set<() => void>();
  private inboxPersistenceEnabled = true;

  constructor(
    initialView: View = { name: "inbox" },
    private readonly onNavigate?: (view: View) => void,
    private readonly instanceScope = LOCAL_INSTANCE_SCOPE,
    private readonly inboxStorage?: KeyValueStorage,
  ) {
    this.state = initialState(initialView, loadInboxState(instanceScope, inboxStorage));
  }

  getState = (): State => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  dispatch = (action: Action): void => {
    const next = reducer(this.state, action);
    if (next === this.state) return;
    const inboxChanged = next.inbox !== this.state.inbox;
    this.state = next;
    if (inboxChanged && this.inboxPersistenceEnabled && (!("persist" in action) || action.persist !== false)) {
      saveInboxState(next.inbox, this.instanceScope, this.inboxStorage);
    }
    for (const l of [...this.listeners]) l();
  };

  navigate = (view: View): void => {
    if (sameView(this.state.view, view)) return;
    this.dispatch({ type: "navigate", view });
    this.onNavigate?.(view);
  };
  navigateFromHistory = (view: View): void => {
    if (!sameView(this.state.view, view)) this.dispatch({ type: "navigate", view });
  };
  setInboxPersistenceEnabled = (enabled: boolean): void => {
    if (enabled === this.inboxPersistenceEnabled) return;
    this.inboxPersistenceEnabled = enabled;
    if (!enabled) return;

    // Phone-width selection is intentionally transient. When desktop persistence resumes,
    // restore its last durable state before any socket-driven reducer can serialize the phone
    // selection. Prune preview-only streams and notify subscription synchronization as usual.
    this.state = pruneViewStreams({
      ...this.state,
      inbox: loadInboxState(this.instanceScope, this.inboxStorage),
    });
    for (const listener of [...this.listeners]) listener();
  };
  setInboxSelection = (
    sessionId: string | null,
    splitKey = this.state.inbox.splitKey,
    persist = true,
  ): void => this.dispatch({ type: "inbox_selection", sessionId, splitKey, persist });
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
  ): void => this.dispatch({
    type: "events_loaded", sessionId, events, eventEpoch, recoveryRevision, recoveryComplete, recoveryGeneration,
    ...(windowHasOlder === undefined ? {} : { windowHasOlder }),
  });
  beginOlderEventsLoad = (
    sessionId: string,
    requestedBase: number,
    eventEpoch = sessionEventEpoch(this.state.sessions.get(sessionId)),
  ): void => this.dispatch({ type: "events_older_loading", sessionId, eventEpoch, requestedBase });
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
  ): void => this.dispatch({ type: "events_older_loaded", sessionId, events, hasOlder, requestedBase, eventEpoch });
  /** Oldest loaded seq for the session's current epoch, or 0 when no window is loaded. */
  eventWindowBase = (sessionId: string): number => {
    const window = this.state.eventWindows.get(sessionId);
    return window && window.eventEpoch === this.eventEpoch(sessionId) ? window.baseSeq : 0;
  };
  loadSession = (session: SessionView): void =>
    this.dispatch({ type: "msg", msg: { type: "session_upsert", session } });
  beginEventHistoryLoad = (
    sessionId: string,
    eventEpoch = sessionEventEpoch(this.state.sessions.get(sessionId)),
    recoveryRevision = -1,
    recoveryGeneration = this.state.snapshotRevision,
  ): void => this.dispatch({
    type: "event_history_loading", sessionId, eventEpoch, recoveryRevision, recoveryGeneration,
  });
  failEventHistoryLoad = (
    sessionId: string,
    error: string,
    eventEpoch = sessionEventEpoch(this.state.sessions.get(sessionId)),
    recoveryRevision = -1,
    recoveryGeneration = this.state.snapshotRevision,
  ): void => this.dispatch({ type: "event_history_failed", sessionId, eventEpoch, recoveryRevision, recoveryGeneration, error });
  loadPodContext = (podId: string, entries: PodContextEntry[]): void =>
    this.dispatch({ type: "pod_context_loaded", podId, entries });
  eventHighWater = (sessionId: string): number => eventHighWater(this.state.events.get(sessionId));
  recoveryAfter = (sessionId: string): number => this.state.streamRecoveryCursors.get(sessionId) ?? 0;
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
          dispatch({ type: "msg", msg, now: Date.now() });
          const sessions: readonly SessionView[] = msg.type === "snapshot"
            ? msg.sessions
            : msg.type === "session_upsert"
              ? [msg.session]
              : [];
          sendDueBackgroundObservations(sessions, msg.type === "snapshot");
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
        reconnectRef.current = window.setTimeout(open, unauthorized ? 10_000 : 1500);
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
    open();
    return () => {
      closed = true;
      unsubscribeCredentialChanges?.();
      unsubscribeSubscriptions();
      cancelBackgroundObservations();
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
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

  // Desktop notifications: clicking one jumps to the session. The transition diff runs as a
  // plain store subscription — no React re-render involved, and no full-map walk unless the
  // sessions map actually changed.
  useEffect(() => {
    let prev = store.getState().sessions;
    const unsub = store.subscribe(() => {
      const cur = store.getState().sessions;
      if (cur === prev) return;
      for (const [id, s] of cur) {
        const show = (payload: NotifyPayload) => notifier.show(payload, {
          instanceId: connection.instanceId,
          onClick: (id) => {
            const view = { name: "session" as const, id };
            if (navigationRef.current?.activate) navigationRef.current.activate(view);
            else store.navigate(view);
          },
        });
        const statusPayload = notifyDecision(prev.get(id), s);
        if (statusPayload) show(statusPayload);
        for (const payload of backgroundDeliveryNotifyDecisions(prev.get(id), s)) show(payload);
      }
      prev = cur;
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

/** Stable action handles (never cause re-renders). */
export function useStoreActions(): Pick<Store, "dispatch" | "navigate" | "setInboxPersistenceEnabled" | "setInboxSelection" | "setInboxSplit" | "setInboxRatio" | "setFilters" | "loadEvents" | "loadOlderEvents" | "beginOlderEventsLoad" | "failOlderEventsLoad" | "eventWindowBase" | "loadSession" | "beginEventHistoryLoad" | "failEventHistoryLoad" | "loadPodContext" | "eventHighWater" | "recoveryAfter" | "eventEpoch" | "reconcileShellOutputs" | "loadShellHistory" | "removeShellOutput"> {
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
    loadOlderEvents: store.loadOlderEvents,
    beginOlderEventsLoad: store.beginOlderEventsLoad,
    failOlderEventsLoad: store.failOlderEventsLoad,
    eventWindowBase: store.eventWindowBase,
    loadSession: store.loadSession,
    beginEventHistoryLoad: store.beginEventHistoryLoad,
    failEventHistoryLoad: store.failEventHistoryLoad,
    loadPodContext: store.loadPodContext,
    eventHighWater: store.eventHighWater,
    recoveryAfter: store.recoveryAfter,
    eventEpoch: store.eventEpoch,
    reconcileShellOutputs: store.reconcileShellOutputs,
    loadShellHistory: store.loadShellHistory,
    removeShellOutput: store.removeShellOutput,
  };
}
