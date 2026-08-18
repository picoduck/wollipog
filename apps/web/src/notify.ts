import type { SessionView } from "@wollipog/protocol";
import { loadBrowserStorageValue, saveBrowserStorageValue } from "./instance-storage.js";

/** A notification to surface for a session transition. */
export interface NotifyPayload {
  title: string;
  body: string;
  sessionId: string;
  /** Distinguishes simultaneous durable events for one session in the Notification API tag. */
  notificationId?: string;
}

const BUSY = new Set<SessionView["status"]>(["queued", "starting", "running"]);

/**
 * Decide whether a session status TRANSITION deserves a desktop notification. Pure:
 * returns the payload, or null. Requires a known previous status (so the initial
 * snapshot doesn't fire a burst of notifications for already-finished sessions).
 */
export function notifyDecision(prev: SessionView | undefined, next: SessionView): NotifyPayload | null {
  if (!prev || prev.status === next.status) return null;
  const name = next.title?.trim() || "Session";
  switch (next.status) {
    case "input_required": {
      const what = next.pendingApproval?.title ? `: ${next.pendingApproval.title}` : "";
      const label = next.pendingApproval?.kind === "authentication" ? "Sign-in required" : "Approval requested";
      return { title: `${name} needs your input`, body: `${label}${what}`, sessionId: next.id };
    }
    case "completed":
      if (BUSY.has(prev.status)) return { title: `${name} completed`, body: "The agent finished its work.", sessionId: next.id };
      return null;
    case "failed":
      return { title: `${name} failed`, body: "The agent run failed — open it to see why.", sessionId: next.id };
    case "idle":
      // A turn finished and the agent is waiting for the next prompt / review.
      if (BUSY.has(prev.status)) return { title: `${name} is ready`, body: "The agent finished a turn and is ready for review.", sessionId: next.id };
      return null;
    default:
      return null;
  }
}

/** A durable background continuation can complete without changing the session status. Unlike
 * ordinary status notifications, an unobserved delivery from the initial snapshot is intentional:
 * reconnect/restart is how a dashboard recovers a notification that was never acknowledged. */
export function backgroundDeliveryNotifyDecision(
  prev: SessionView | undefined,
  next: SessionView,
): NotifyPayload | null {
  return backgroundDeliveryNotifyDecisions(prev, next)[0] ?? null;
}

/** Return one payload per newly visible durable delivery so a reconnect cannot collapse several
 * completed parent continuations into one notification while acknowledging all of them. */
export function backgroundDeliveryNotifyDecisions(
  prev: SessionView | undefined,
  next: SessionView,
): NotifyPayload[] {
  const previous = new Set((prev?.backgroundDeliveries ?? []).flatMap((delivery) =>
    delivery.continuationId && delivery.notificationQueuedAt != null ? [delivery.continuationId] : []));
  const deliveries = (next.backgroundDeliveries ?? []).filter((candidate) =>
    candidate.continuationId &&
    candidate.notificationQueuedAt != null &&
    candidate.dashboardObservedAt == null &&
    !previous.has(candidate.continuationId));
  const name = next.title?.trim() || "Session";
  return deliveries.map((delivery) => ({
    title: `${name} resumed background work`,
    body: "The parent workflow delivered its result.",
    sessionId: next.id,
    notificationId: delivery.continuationId,
  }));
}

export interface NotificationTarget {
  instanceId: string;
  onClick: (sessionId: string) => void;
}

/**
 * Thin wrapper over the browser Notification API with an opt-in enabled flag
 * persisted to localStorage. Side-effecting; the decision logic lives in
 * notifyDecision() above (which is what the unit tests cover).
 */
export class Notifier {
  enabled = false;

  constructor() {
    try {
      this.enabled = loadBrowserStorageValue("wollipog.notify") === "1";
    } catch {
      /* SSR / privacy mode */
    }
  }

  get supported(): boolean {
    return typeof Notification !== "undefined";
  }

  get permission(): NotificationPermission {
    return this.supported ? Notification.permission : "denied";
  }

  /** Turn on, requesting OS permission if needed. Returns whether it's now active. */
  async enable(): Promise<boolean> {
    if (!this.supported) return false;
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    this.enabled = perm === "granted";
    this.persist();
    return this.enabled;
  }

  disable(): void {
    this.enabled = false;
    this.persist();
  }

  /** Show a notification — but only when enabled, permitted, and the tab is hidden. */
  show(p: NotifyPayload, target: NotificationTarget): void {
    if (!this.enabled || !this.supported || this.permission !== "granted") return;
    if (typeof document !== "undefined" && document.visibilityState === "visible") return;
    const tag = `${target.instanceId}:${p.sessionId}${p.notificationId ? `:${p.notificationId}` : ""}`;
    const n = new Notification(p.title, { body: p.body, tag });
    n.onclick = () => {
      window.focus();
      target.onClick(p.sessionId);
      n.close();
    };
  }

  private persist(): void {
    try {
      saveBrowserStorageValue("wollipog.notify", this.enabled ? "1" : "0");
    } catch {
      /* ignore */
    }
  }
}

export const notifier = new Notifier();
