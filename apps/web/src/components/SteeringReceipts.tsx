import type { SteeringAttemptView } from "@wollipog/protocol";
import { steeringReceiptPresentation, type SteeringReceiptTone } from "../conversation-steering.js";
import type { TimelineItem } from "../timeline.js";

export const MAX_VISIBLE_STEERING_RECEIPTS = 50;
export const MAX_RECENT_PREVIOUS_TURN_RECEIPTS = 5;

export type SteeringResolutionAction = "queue_again" | "dismiss";

export interface SteeringReceiptsProps {
  attempts: readonly SteeringAttemptView[];
  timelineItems: readonly TimelineItem[];
  activeTurnId?: string;
  /** The transcript is a bounded window, so an accepted steer's message may be in an unloaded turn. */
  historyPartial?: boolean;
  pendingActions?: ReadonlyMap<string, SteeringResolutionAction>;
  onQueueAgain: (submissionId: string) => void;
  onDismiss: (submissionId: string) => void;
}

export type SteeringReceiptStatus =
  | "pending"
  | "accepted"
  | "converted"
  | "rejected"
  | "uncertain"
  | "queued_again"
  | "dismissed";

export interface SteeringReceiptPresentation {
  attempt: SteeringAttemptView;
  status: SteeringReceiptStatus;
  label: string;
  tone: SteeringReceiptTone;
  actionRequired: boolean;
  detail?: string;
}

function receiptStatus(attempt: SteeringAttemptView): SteeringReceiptStatus {
  if (attempt.resolution?.state === "applied") {
    return attempt.resolution.action === "queue_again" ? "queued_again" : "dismissed";
  }
  switch (attempt.state) {
    case "pending": return "pending";
    case "accepted": return "accepted";
    case "converted_to_queue": return "converted";
    case "rejected": return "rejected";
    case "uncertain": return "uncertain";
  }
}

function receiptNeedsRecovery(attempt: SteeringAttemptView): boolean {
  return attempt.state === "pending" ||
    (attempt.state === "uncertain" && attempt.resolution?.state !== "applied");
}

/** Keep unresolved recovery work and terminal receipts for the active turn. Previous-turn terminal
 * history is a short recency tail, while accepted receipts retire as soon as their canonical
 * steered user-message is present in this exact timeline generation. */
export function deriveSteeringReceipts(
  attempts: readonly SteeringAttemptView[],
  timelineItems: readonly TimelineItem[],
  activeTurnId?: string,
  /** The timeline is a bounded window, so an accepted steer's canonical message may be below it. */
  historyPartial = false,
): SteeringReceiptPresentation[] {
  const canonicalAccepted = new Set(timelineItems.flatMap((item) =>
    item.kind === "user_message" && item.deliveryIntent === "steer" && item.submissionId
      ? [item.submissionId]
      : []
  ));
  // An accepted steer retires into the canonical transcript. Against a bounded window its absence
  // means only that its turn is unloaded, so it must not resurface as an unsettled receipt.
  const eligible = attempts.filter((attempt) =>
    attempt.state !== "accepted" || (!historyPartial && !canonicalAccepted.has(attempt.submissionId)),
  );
  const recentPreviousTurn = new Set(
    eligible
      .filter((attempt) => !receiptNeedsRecovery(attempt) && attempt.turnId !== activeTurnId)
      .map((attempt, index) => ({ attempt, index }))
      .sort((left, right) =>
        right.attempt.createdAt - left.attempt.createdAt || left.index - right.index
      )
      .slice(0, MAX_RECENT_PREVIOUS_TURN_RECEIPTS)
      .map(({ attempt }) => attempt.submissionId),
  );
  return eligible
    .filter((attempt) =>
      receiptNeedsRecovery(attempt) || attempt.turnId === activeTurnId ||
      recentPreviousTurn.has(attempt.submissionId)
    )
    .slice(0, MAX_VISIBLE_STEERING_RECEIPTS)
    .map((attempt) => {
      const status = receiptStatus(attempt);
      return {
        attempt,
        status,
        ...steeringReceiptPresentation(attempt),
      };
    });
}

function humanReason(reason: SteeringAttemptView["reason"]): string | undefined {
  if (!reason) return undefined;
  const normalized = reason.replaceAll("_", " ");
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}.`;
}

export function SteeringReceipts({
  attempts,
  timelineItems,
  activeTurnId,
  historyPartial = false,
  pendingActions,
  onQueueAgain,
  onDismiss,
}: SteeringReceiptsProps) {
  const receipts = deriveSteeringReceipts(attempts, timelineItems, activeTurnId, historyPartial);
  if (!receipts.length) return null;

  return (
    <section className="steering-receipts" aria-label="Steering Receipts">
      {receipts.map(({ attempt, status, label, detail }) => {
        const pendingAction = pendingActions?.get(attempt.submissionId);
        const actionPending = attempt.resolution?.state === "pending" ||
          pendingAction !== undefined;
        const recoverable = attempt.state === "uncertain" && attempt.resolution?.state !== "applied";
        const durableDetail = detail ?? (
          attempt.state === "rejected" || attempt.state === "converted_to_queue" || attempt.state === "uncertain"
            ? humanReason(attempt.reason)
            : undefined
        );
        const localPendingDetail = pendingAction
          ? `${pendingAction === "queue_again" ? "Queue Again" : "Dismiss"} is pending.`
          : undefined;
        return (
          <article
            className="steering-receipt"
            data-submission-id={attempt.submissionId}
            data-status={status}
            data-testid={`steering-attempt-${attempt.submissionId}`}
            key={attempt.submissionId}
          >
            <div className="steering-receipt-head">
              <span className="steering-receipt-status" data-status={status}>{label}</span>
              <span className="steering-receipt-source">
                {attempt.source === "queued" ? "Queued Prompt" : "Direct Steering"}
              </span>
            </div>
            {(attempt.text || attempt.hasImages) && (
              <div className="steering-receipt-content">
                {attempt.text && <span className="steering-receipt-text">{attempt.text}</span>}
                {attempt.hasImages && <span className="steering-receipt-image">Image Attached</span>}
              </div>
            )}
            {(durableDetail || (localPendingDetail && localPendingDetail !== durableDetail)) && (
              <div className="steering-receipt-details">
                {durableDetail && <span>{durableDetail}</span>}
                {localPendingDetail && localPendingDetail !== durableDetail && <span>{localPendingDetail}</span>}
              </div>
            )}
            {recoverable && (
              <div className="steering-receipt-actions" aria-busy={actionPending || undefined}>
                <button
                  className="btn ghost sm steering-receipt-action"
                  type="button"
                  disabled={actionPending}
                  onClick={() => onQueueAgain(attempt.submissionId)}
                >
                  Queue Again
                </button>
                <button
                  className="btn ghost sm steering-receipt-action"
                  type="button"
                  disabled={actionPending}
                  onClick={() => onDismiss(attempt.submissionId)}
                >
                  Dismiss
                </button>
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}
