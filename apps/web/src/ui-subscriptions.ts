import {
  MAX_UI_POD_SUBSCRIPTIONS,
  MAX_UI_SESSION_SUBSCRIPTIONS,
  type PodView,
  type RunView,
  type SessionEvent,
  type SessionView,
  type UiToControlPlane,
} from "@wollipog/protocol";
import { isHeartbeatBusy } from "./activity.js";

export { MAX_UI_POD_SUBSCRIPTIONS, MAX_UI_SESSION_SUBSCRIPTIONS };

type SubscriptionView =
  | { name: "inbox" }
  | { name: "session"; id: string }
  | { name: "run"; id: string }
  | { name: "pod"; id: string }
  // Settings subscribes to nothing — it reads local preferences — but it is a View like any other,
  // and leaving it out made the whole View union unassignable here.
  | { name: "settings"; section?: string }
  | { name: "board" | "runners" | "runs" | "pods" | "automations" | "usage" | "projects"; id?: string };

export interface UiSubscriptionSource {
  view: SubscriptionView;
  inbox?: { selectedSessionId: string | null };
  sessions: Map<string, SessionView>;
  runs: Map<string, RunView>;
  pods: Map<string, PodView>;
}

export interface UiSubscriptionDeliveryState {
  mode: "unknown" | "legacy" | "targeted";
  /** Latest replacement sent on this socket. Recovery waits until this exact revision is applied. */
  requestedRevision: number;
  appliedRevision: number;
  sessionIds: string[];
  podIds: string[];
}

export const EMPTY_UI_SUBSCRIPTION_DELIVERY: UiSubscriptionDeliveryState = {
  mode: "unknown",
  requestedRevision: 0,
  appliedRevision: 0,
  sessionIds: [],
  podIds: [],
};

/** Derive the high-volume streams needed by the active view plus lightweight heartbeat inputs.
 * Required detail streams are ordered first so the bounded subscription can never evict the thing
 * the user is looking at; busy sessions follow deterministically for activity aggregation. */
export function uiStreamSubscriptions(state: UiSubscriptionSource): { sessionIds: string[]; podIds: string[] } {
  const required = new Set<string>();
  const podIds = new Set<string>();
  if (state.view.name === "inbox" && state.inbox?.selectedSessionId) required.add(state.inbox.selectedSessionId);
  else if (state.view.name === "session") required.add(state.view.id);
  else if (state.view.name === "run") state.runs.get(state.view.id)?.sessionIds.forEach((id) => required.add(id));
  else if (state.view.name === "pod") {
    podIds.add(state.view.id);
    state.pods.get(state.view.id)?.members.forEach((member) => required.add(member.sessionId));
  }
  const requiredIds = [...required].sort();
  const busyIds = [...state.sessions.values()]
    .filter((session) => !session.archived && isHeartbeatBusy(session.status) && !required.has(session.id))
    .map((session) => session.id)
    .sort();
  return {
    sessionIds: [...requiredIds, ...busyIds].slice(0, MAX_UI_SESSION_SUBSCRIPTIONS),
    podIds: [...podIds].sort().slice(0, MAX_UI_POD_SUBSCRIPTIONS),
  };
}

/** Whether the current delivery mode can observe live activity for this session. */
export function isSessionActivityObservable(
  delivery: UiSubscriptionDeliveryState,
  sessionId: string,
): boolean {
  if (delivery.mode === "legacy") return true;
  return delivery.mode === "targeted" &&
    delivery.appliedRevision > 0 &&
    delivery.sessionIds.includes(sessionId);
}

/** Cache subscription derivation on the references that can affect it. Event/shell/store
 * deltas leave those references unchanged, so the hot listener path is O(1). */
export class UiSubscriptionSynchronizer {
  private view: SubscriptionView | null = null;
  private inboxSessionId: string | null = null;
  private sessions: Map<string, SessionView> | null = null;
  private runs: Map<string, RunView> | null = null;
  private pods: Map<string, PodView> | null = null;
  private desired: { sessionIds: string[]; podIds: string[]; key: string } | null = null;
  private sentKey: string | null = null;
  private revision = 0;

  constructor(private readonly derive = uiStreamSubscriptions) {}

  resetConnection(): void {
    this.sentKey = null;
    this.revision = 0;
  }

  nextMessage(state: UiSubscriptionSource, enabled: boolean): UiToControlPlane | null {
    const inboxSessionId = state.view.name === "inbox" ? state.inbox?.selectedSessionId ?? null : null;
    if (state.view !== this.view || inboxSessionId !== this.inboxSessionId ||
        state.sessions !== this.sessions || state.runs !== this.runs || state.pods !== this.pods || !this.desired) {
      this.view = state.view;
      this.inboxSessionId = inboxSessionId;
      this.sessions = state.sessions;
      this.runs = state.runs;
      this.pods = state.pods;
      const subscriptions = this.derive(state);
      this.desired = {
        ...subscriptions,
        key: `${subscriptions.sessionIds.join("\u0000")}\u0001${subscriptions.podIds.join("\u0000")}`,
      };
    }
    if (!enabled || this.desired.key === this.sentKey) return null;
    const revision = ++this.revision;
    this.sentKey = this.desired.key;
    return {
      type: "session_subscriptions",
      revision,
      sessionIds: this.desired.sessionIds,
      podIds: this.desired.podIds,
    };
  }
}

/** Revision that is safe to use as a post-ack REST recovery epoch. `null` means the current view's
 * required streams have not been acknowledged yet. Legacy servers need no acknowledgement. */
export function subscriptionRecoveryRevision(
  delivery: UiSubscriptionDeliveryState,
  requiredSessionIds: readonly string[],
  requiredPodIds: readonly string[] = [],
): number | null {
  if (delivery.mode === "unknown") return null;
  if (delivery.mode === "legacy") return 0;
  if (delivery.requestedRevision === 0 || delivery.appliedRevision !== delivery.requestedRevision) return null;
  const sessions = new Set(delivery.sessionIds);
  const pods = new Set(delivery.podIds);
  if (!requiredSessionIds.every((id) => sessions.has(id)) || !requiredPodIds.every((id) => pods.has(id))) return null;
  return delivery.appliedRevision > 0 ? delivery.appliedRevision : null;
}

export function eventHighWater(events: readonly SessionEvent[] | undefined): number {
  let highWater = 0;
  for (const event of events ?? []) highWater = Math.max(highWater, event.seq);
  return highWater;
}
