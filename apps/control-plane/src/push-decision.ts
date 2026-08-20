/**
 * Which session transitions deserve a push notification — the control-plane twin of the web
 * app's notifyDecision (apps/web/src/notify.ts): keep the two lists in agreement so a phone
 * and an open dashboard alert on the same moments. Pure; unit-tested.
 *
 * `prev` is the view from BEFORE the mutation. input_required compares the pending ask's
 * IDENTITY, not just the status: a permission/question that displaces a guardrail card (or
 * vice versa) is a NEW ask the phone must hear about, while the runner's trailing
 * input_required status frame for the same request must stay silent.
 */

import type { SessionStatus, SessionView } from "@wollipog/protocol";
import type { PushMessage } from "./web-push.js";

const BUSY: SessionStatus[] = ["queued", "starting", "running"];

/** Notification fields are clamped so no ask/title can push the encrypted payload past the
 * sender's size guard (which would drop the message entirely). */
function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}
const TITLE_MAX = 120;
const BODY_MAX = 400;

export type PushDecisionPrev = Pick<SessionView, "status" | "pendingApproval" | "backgroundDeliveries">;

function newlySettledBackgroundDelivery(prev: PushDecisionPrev, next: SessionView): boolean {
  const settled = new Set((prev.backgroundDeliveries ?? []).flatMap((delivery) =>
    delivery.statusSettledAt != null ? [delivery.continuationId] : []));
  return (next.backgroundDeliveries ?? []).some((delivery) =>
    delivery.statusSettledAt != null && !settled.has(delivery.continuationId));
}

export function pushDecision(prev: PushDecisionPrev, next: SessionView): PushMessage | null {
  const name = clamp(next.title?.trim() || "Session", 60);
  if (next.status === "input_required") {
    // Same status AND same ask → the trailing duplicate; anything else is a fresh ask.
    if (prev.status === "input_required" && prev.pendingApproval?.requestId === next.pendingApproval?.requestId) {
      return null;
    }
    const what = next.pendingApproval?.title ? `: ${next.pendingApproval.title}` : "";
    return {
      title: `${name} needs your input`,
      body: clamp(`${next.pendingApproval?.kind === "question" ? "Question" : next.pendingApproval?.kind === "authentication" ? "Sign-in required" : "Approval requested"}${what}`, BODY_MAX),
      sessionId: next.id,
      urgency: "high",
    };
  }
  if (prev.status === next.status) return null;
  switch (next.status) {
    case "completed":
      if (BUSY.includes(prev.status)) {
        return { title: clamp(`${name} completed`, TITLE_MAX), body: "The agent finished its work.", sessionId: next.id, urgency: "normal" };
      }
      return null;
    case "failed":
      return { title: clamp(`${name} failed`, TITLE_MAX), body: "The agent run failed — open it to see why.", sessionId: next.id, urgency: "normal" };
    case "idle":
      // Turn settled: the agent is waiting on the next prompt / review.
      if (BUSY.includes(prev.status)) {
        if (newlySettledBackgroundDelivery(prev, next)) return null;
        return { title: clamp(`${name} is ready`, TITLE_MAX), body: "The agent finished a turn and is ready for review.", sessionId: next.id, urgency: "normal" };
      }
      return null;
    default:
      return null;
  }
}
