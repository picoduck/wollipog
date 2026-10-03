import { useState } from "react";
import type { SteeringAttemptView } from "@wollipog/protocol";
import {
  steeringReceiptPresentation,
  type SteeringReceiptPresentation as ReceiptPresentation,
} from "../conversation-steering.js";
import type { TimelineItem } from "../timeline.js";
import {
  RECEIPT_ROW_ATTRIBUTE,
  ReceiptAttachmentChip,
  ReceiptLine,
  ReceiptRow,
  receiptRowId,
  type ReceiptBubbleVariant,
} from "./TranscriptReceipt.js";

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
  /** Why the signed-in person may not resolve a steering attempt (#1857); its actions are then
   * disabled with this reason. */
  actionRefusal?: string | null;
  onQueueAgain: (submissionId: string) => void;
  onDismiss: (submissionId: string) => void | Promise<void>;
}

export type SteeringReceiptStatus =
  | "pending"
  | "accepted"
  | "converted"
  | "rejected"
  | "uncertain"
  | "queued_again"
  | "dismissed";

export interface SteeringReceiptPresentation extends Omit<ReceiptPresentation, "status"> {
  attempt: SteeringAttemptView;
  status: SteeringReceiptStatus;
  /** The receipt's place in the message-receipt vocabulary (§11.2). */
  receiptStatus: ReceiptPresentation["status"];
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
  const canonicalQueuedPrompts = new Set(timelineItems.flatMap((item) =>
    item.kind === "user_message" && item.deliveryIntent !== "steer" && item.turnId
      ? [item.turnId]
      : []
  ));
  // An accepted steer retires into the canonical transcript. Against a bounded window its absence
  // means only that its turn is unloaded, so it must not resurface as an unsettled receipt.
  const eligible = attempts.filter((attempt) =>
    !(attempt.resolution?.state === "applied" && attempt.resolution.action === "dismiss") &&
    !(attempt.resolution?.state === "applied" && attempt.resolution.action === "queue_again" &&
      canonicalQueuedPrompts.has(attempt.resolution.queuedPromptId ?? "")) &&
    (attempt.state !== "accepted" || (!historyPartial && !canonicalAccepted.has(attempt.submissionId))),
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
      const { status: receiptStatusValue, ...presentation } = steeringReceiptPresentation(attempt);
      return {
        attempt,
        status: receiptStatus(attempt),
        receiptStatus: receiptStatusValue,
        ...presentation,
      };
    });
}

/** A steer still on its way is dashed; one that failed or may not have landed has a red edge. */
function bubbleVariant(status: SteeringReceiptStatus): ReceiptBubbleVariant | undefined {
  switch (status) {
    case "pending":
    case "converted":
    case "queued_again":
      return "pending";
    case "rejected":
    case "uncertain":
      return "failed";
    default:
      return undefined;
  }
}

interface SteeringReceiptCardProps {
  receipt: SteeringReceiptPresentation;
  pendingActions?: ReadonlyMap<string, SteeringResolutionAction>;
  /** Why the signed-in person may not resolve a steering attempt (#1857); its actions are then
   * disabled with this reason, shown under the message. */
  actionRefusal?: string | null;
  onQueueAgain: (submissionId: string) => void;
  onDismiss: (submissionId: string) => void | Promise<void>;
  /** False inside a folded group, whose row is the one the floating control watches. */
  tracked?: boolean;
}

function SteeringReceiptCard({
  receipt: { attempt, status, receiptStatus: lineStatus, reason, detail },
  pendingActions,
  actionRefusal = null,
  onQueueAgain,
  onDismiss,
  tracked = true,
}: SteeringReceiptCardProps) {
  const refusalId = `steering-refusal-${attempt.submissionId}`;
  const refusalDescription = actionRefusal !== null ? refusalId : undefined;
  const pendingAction = pendingActions?.get(attempt.submissionId);
  const actionPending = attempt.resolution?.state === "pending" || pendingAction !== undefined;
  const recoverable = attempt.state === "uncertain" && attempt.resolution?.state !== "applied";
  const dismissibleRejection = status === "rejected";
  const dismissibleQueuedAgain = attempt.resolution?.state === "applied" &&
    attempt.resolution.action === "queue_again";
  const dismissible = recoverable || dismissibleRejection || dismissibleQueuedAgain;
  const localPendingDetail = pendingAction
    ? `${pendingAction === "queue_again" ? "Queue Again" : "Dismiss"} is pending.`
    : undefined;
  const reasonText = [reason, detail, localPendingDetail !== detail ? localPendingDetail : undefined]
    .filter(Boolean).join(" ") || undefined;
  const hasActions = recoverable || dismissible;
  return (
    <ReceiptRow
      receiptId={tracked ? receiptRowId.steering(attempt.submissionId) : undefined}
      testId={`steering-attempt-${attempt.submissionId}`}
      rowProps={{
        "data-submission-id": attempt.submissionId,
        "data-status": status,
        "aria-busy": actionPending || undefined,
      }}
      bubbleVariant={bubbleVariant(status)}
      bubble={(attempt.text || attempt.hasImages) ? (
        <>
          {attempt.hasImages && <ReceiptAttachmentChip />}
          {attempt.text && <div className="bubble-text">{attempt.text}</div>}
        </>
      ) : undefined}
    >
      <ReceiptLine
        status={lineStatus}
        reason={reasonText}
        detailsId={`steering-details-${attempt.submissionId}`}
        actions={hasActions ? (
          <span className="tl-receipt-buttons" aria-busy={actionPending || undefined}>
            {recoverable && (
              <button
                className="btn sm"
                type="button"
                disabled={actionPending || actionRefusal !== null}
                title={actionRefusal ?? undefined}
                aria-describedby={refusalDescription}
                onClick={() => onQueueAgain(attempt.submissionId)}
              >
                Queue Again
              </button>
            )}
            {dismissible && (
              <button
                className="btn sm"
                type="button"
                disabled={actionPending || actionRefusal !== null}
                title={actionRefusal ?? undefined}
                aria-describedby={refusalDescription}
                onClick={() => onDismiss(attempt.submissionId)}
              >
                Dismiss
              </button>
            )}
          </span>
        ) : undefined}
      />
      {actionRefusal !== null && hasActions && (
        <p className="tl-receipt-refusal" id={refusalId}>{actionRefusal}</p>
      )}
    </ReceiptRow>
  );
}

/** Several settled receipts of one kind fold into one row that says how many, with Clear All. */
function SteeringReceiptGroup({
  kind,
  receipts,
  clearable,
  actionRefusal,
  pendingActions,
  onQueueAgain,
  onDismiss,
}: {
  kind: "rejected" | "queued_again";
  receipts: readonly SteeringReceiptPresentation[];
  clearable: readonly SteeringReceiptPresentation[];
  actionRefusal: string | null;
  pendingActions?: ReadonlyMap<string, SteeringResolutionAction>;
  onQueueAgain: (submissionId: string) => void;
  onDismiss: (submissionId: string) => void | Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [clearing, setClearing] = useState(false);
  const listId = kind === "rejected" ? "rejected-steering-receipts" : "queued-again-steering-receipts";
  const refusalId = `${listId}-refusal`;
  return (
    <div className="steering-terminal-receipts" data-terminal-status={kind}>
      <div
        className="tl-row user tl-receipt-row"
        {...{ [RECEIPT_ROW_ATTRIBUTE]: receipts.map(({ attempt }) => receiptRowId.steering(attempt.submissionId)).join(" ") }}
      >
        <div className="tl-message-stack user">
          <ReceiptLine
            status={kind === "rejected" ? "not_accepted" : "queued"}
            reason={`${receipts.length} messages`}
            detailsId={`${listId}-details`}
            actions={(
              <span className="tl-receipt-buttons" aria-busy={clearing || undefined}>
                <button
                  className="btn ghost sm"
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={listId}
                  onClick={() => setExpanded((current) => !current)}
                >
                  {expanded ? "Hide All" : "Show All"}
                </button>
                <button
                  className="btn sm"
                  type="button"
                  disabled={clearing || clearable.length === 0 || actionRefusal !== null}
                  title={actionRefusal ?? undefined}
                  aria-describedby={actionRefusal !== null ? refusalId : undefined}
                  onClick={async () => {
                    setClearing(true);
                    try {
                      for (const { attempt } of clearable) {
                        await onDismiss(attempt.submissionId);
                      }
                    } finally {
                      setClearing(false);
                    }
                  }}
                >
                  Clear All
                </button>
              </span>
            )}
          />
          {actionRefusal !== null && <p className="tl-receipt-refusal" id={refusalId}>{actionRefusal}</p>}
        </div>
      </div>
      {expanded && (
        <div className="steering-terminal-list" id={listId}>
          {receipts.map((receipt) => (
            <SteeringReceiptCard
              key={receipt.attempt.submissionId}
              receipt={receipt}
              pendingActions={pendingActions}
              actionRefusal={actionRefusal}
              onQueueAgain={onQueueAgain}
              onDismiss={onDismiss}
              tracked={false}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Steering receipts as rows of the transcript, each under its message (#2171). */
export function SteeringReceipts({
  attempts,
  timelineItems,
  activeTurnId,
  historyPartial = false,
  pendingActions,
  actionRefusal = null,
  onQueueAgain,
  onDismiss,
}: SteeringReceiptsProps) {
  const receipts = deriveSteeringReceipts(attempts, timelineItems, activeTurnId, historyPartial);
  if (!receipts.length) return null;
  const rejected = receipts.filter(({ status }) => status === "rejected");
  const queuedAgain = receipts.filter(({ status }) => status === "queued_again");
  const ungrouped = receipts.filter(({ status }) =>
    !(rejected.length > 1 && status === "rejected") &&
    !(queuedAgain.length > 1 && status === "queued_again")
  );
  const clearableRejected = rejected.filter(({ attempt }) =>
    attempt.resolution?.state !== "pending" && !pendingActions?.has(attempt.submissionId)
  );
  const clearableQueuedAgain = queuedAgain.filter(({ attempt }) =>
    !pendingActions?.has(attempt.submissionId)
  );

  return (
    <>
      {ungrouped.map((receipt) => (
        <SteeringReceiptCard
          key={receipt.attempt.submissionId}
          receipt={receipt}
          pendingActions={pendingActions}
          actionRefusal={actionRefusal}
          onQueueAgain={onQueueAgain}
          onDismiss={onDismiss}
        />
      ))}
      {rejected.length > 1 && (
        <SteeringReceiptGroup
          kind="rejected"
          receipts={rejected}
          clearable={clearableRejected}
          actionRefusal={actionRefusal}
          pendingActions={pendingActions}
          onQueueAgain={onQueueAgain}
          onDismiss={onDismiss}
        />
      )}
      {queuedAgain.length > 1 && (
        <SteeringReceiptGroup
          kind="queued_again"
          receipts={queuedAgain}
          clearable={clearableQueuedAgain}
          actionRefusal={actionRefusal}
          pendingActions={pendingActions}
          onQueueAgain={onQueueAgain}
          onDismiss={onDismiss}
        />
      )}
    </>
  );
}
