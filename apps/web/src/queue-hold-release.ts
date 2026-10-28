import { queueHoldReason, type SessionQueueHoldView, type SessionView } from "@wollipog/protocol";
import type { ApiClient } from "./api.js";
import { sessionCommandRefusal } from "./session-command-permissions.js";

/** Whether Proceed Now can run now, and if not, why. */
export type QueueHoldReleaseAvailability = { available: true } | { available: false; reason: string };

/** A worktree or account handoff hold as the queue tray shows it (#3752). */
export interface QueueHoldTrayView {
  /** The hold the tray shows; Proceed Now sends its `holdId` as it was when the person confirmed. */
  hold: SessionQueueHoldView;
  /** Why the queued messages have not started, in one sentence. */
  reason: string;
  /** Proceed Now… for this reader: `null` when it is not offered at all (the runner cannot release
   * the hold, or the reader may not stop the session's background jobs). */
  release: QueueHoldReleaseAvailability | null;
}

/**
 * The handoff hold the composer's queue tray explains (#3752), or `null` when the queued session is
 * not held behind one. The reason is the control plane's own sentence for the hold, or the protocol's
 * when it sent none. Proceed Now… is offered only where the runner reports it can release the hold
 * (`canRelease`) and the reader may stop the session's background jobs: releasing ends them, so it
 * takes the same authority as Stop Job. A Viewer still reads the reason.
 */
export function queueHoldTrayView(
  session: Pick<SessionView, "status" | "capacityWait" | "queueHold" | "holds" | "commandPermissions">,
  runnerOnline: boolean,
): QueueHoldTrayView | null {
  const hold = session.queueHold;
  if (session.status !== "queued" || session.capacityWait || !hold) return null;
  const reason = session.holds?.find((candidate) => candidate.holdId === hold.holdId)?.reason ?? queueHoldReason(hold);
  let release: QueueHoldReleaseAvailability | null = null;
  if (hold.canRelease && sessionCommandRefusal(session, "stopBackgroundJob") === null) {
    release = runnerOnline ? { available: true } : { available: false, reason: "The runner is offline." };
  }
  return { hold, reason, release };
}

/** What Proceed Now does, as its confirmation says it, in two sentences (§7.4). The account is not
 * named: a provider account label is a personal identifier the dialog would have to mask (§11.8). */
export function queueHoldReleaseOutcome(hold: Pick<SessionQueueHoldView, "kind" | "queuedPrompts">): string {
  const handoff = hold.kind === "worktree_rebind"
    ? "the session moves to the selected worktree"
    : "the session switches to the selected provider account";
  const messages = hold.queuedPrompts === 1
    ? "the queued message runs"
    : `the ${hold.queuedPrompts} queued messages run in order`;
  return "Every unfinished background job in this session ends and is recorded as killed, and the " +
    `conversation keeps running. Then ${handoff} and ${messages}.`;
}

/** Said under the tray's hold line once the runner has released the hold. */
export const QUEUE_HOLD_RELEASED = "Proceeding. The queued messages start once the handoff finishes.";

export type QueueHoldReleaseResult = { state: "released" } | { state: "error"; message: string };

/** Proceed Now's one request (#3752): the server refuses a hold that has changed, with a sentence. */
export function requestQueueHoldRelease(
  api: Pick<ApiClient, "releaseQueueHold">,
  sessionId: string,
  holdId: string,
): Promise<QueueHoldReleaseResult> {
  return api.releaseQueueHold(sessionId, holdId)
    .then((): QueueHoldReleaseResult => ({ state: "released" }))
    .catch((error: unknown): QueueHoldReleaseResult => ({
      state: "error",
      message: error instanceof Error ? error.message : "The hold could not be released.",
    }));
}
