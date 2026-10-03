import type {
  PendingPromptView,
  QueuedPromptView,
  SessionStatus,
} from "@wollipog/protocol";
import { deliveryReason, type MessageReceiptStatus } from "../conversation-steering.js";
import { statusMeta, type StatusMeta } from "../status-meta.js";
import { Markdown } from "./Markdown.js";
import { ReceiptAttachmentChip, ReceiptLine, ReceiptRow, receiptRowId } from "./TranscriptReceipt.js";

const RECOVERY_BLOCKS_RETRY_REASON = "Recover the selected worktree before retrying this message.";

/** A pending message's place in the message-receipt vocabulary (§11.2). */
export function pendingPromptReceiptStatus(prompt: PendingPromptView): MessageReceiptStatus {
  switch (prompt.state) {
    case "pending":
    case "sent":
      return "sending";
    case "accepted":
    case "queued":
      return "queued";
    case "started":
      return "delivered";
    case "uncertain":
      return "uncertain";
    case "failed":
      return prompt.errorCode === "WORKTREE_RECOVERY_REQUIRED"
        ? "not_sent"
        : prompt.errorCode === "COMMAND_CANCELLED" ? "cancelled" : "failed";
  }
}

/** A pending message's status label and tone. */
export function pendingPromptStatus(prompt: PendingPromptView): StatusMeta {
  return statusMeta("messageReceipt", pendingPromptReceiptStatus(prompt));
}

/** A message the person sent that did not reach the agent (Delivery Failed or Not Sent, not Canceled). */
export function isUndeliveredPrompt(prompt: PendingPromptView): boolean {
  return prompt.state === "failed" && prompt.errorCode !== "COMMAND_CANCELLED";
}

/** The rows PendingPromptBubbles renders: delivery is proven by the runner's flushed user event. */
export function isPendingPromptShown(prompt: PendingPromptView, deliveredCommandIds: ReadonlySet<string>): boolean {
  return prompt.userEventSeq === undefined && !deliveredCommandIds.has(prompt.commandId);
}

export function shouldShowOptimisticPrompt(
  status: SessionStatus,
  durableProviderInvocation: boolean,
): boolean {
  return !durableProviderInvocation &&
    !["queued", "running", "starting", "input_required"].includes(status);
}

export function hasNewPendingPrompt(
  knownCommandIds: ReadonlySet<string>,
  prompts: readonly PendingPromptView[] | undefined,
): boolean {
  return prompts?.some((prompt) => !knownCommandIds.has(prompt.commandId)) ?? false;
}

/** Transcript projection must not remove the separate live queue's steering controls. */
export function queuedPromptsWithControls(
  queued: readonly QueuedPromptView[] | undefined,
): readonly QueuedPromptView[] {
  return queued ?? [];
}

export function PendingPromptBubbles({
  prompts,
  deliveredCommandIds,
  liveQueueIds,
  canCancelLive,
  pendingAction,
  worktreeRecoveryPending = false,
  actionRefusal = null,
  onCancelPending,
  onCancelLive,
  onDismiss,
  onRetry,
}: {
  prompts: PendingPromptView[];
  deliveredCommandIds: ReadonlySet<string>;
  liveQueueIds: ReadonlySet<string>;
  canCancelLive: boolean;
  pendingAction?: string;
  worktreeRecoveryPending?: boolean;
  /** Why the signed-in person may not act on a delivery (#1857); every action is then disabled. */
  actionRefusal?: string | null;
  onCancelPending: (commandId: string) => void;
  onCancelLive: (commandId: string) => void;
  onDismiss: (commandId: string) => void;
  onRetry: (commandId: string) => void;
}) {
  // userEventSeq comes from the runner only after the command-tagged user event is flushed. It is
  // therefore stronger delivery evidence than the currently loaded (possibly partial) timeline.
  return prompts.filter((prompt) => isPendingPromptShown(prompt, deliveredCommandIds)).map((prompt) => {
    const busy = pendingAction === prompt.commandId;
    const actionPending = pendingAction !== undefined;
    const cancelPending = prompt.canCancel === true;
    const cancelLive = !cancelPending && !prompt.canDismiss && canCancelLive &&
      liveQueueIds.has(prompt.commandId);
    const detailsId = `pending-prompt-details-${prompt.commandId}`;
    // The service rejects every retry while the session's selected worktree is in recovery,
    // whatever the retained receipt records. A prompt retained by an earlier authentication
    // failure is blocked just the same, so enablement follows the live recovery state alone —
    // keying it off the receipt's code offers an action the server answers with HTTP 409.
    const recoveryBlocksRetry = worktreeRecoveryPending;
    // A disabled control's tooltip is announced by nothing, so the blocking reason is carried as a
    // programmatic description alongside the retained message itself.
    const recoveryReasonId = `pending-prompt-recovery-${prompt.commandId}`;
    const refusalId = `pending-prompt-refusal-${prompt.commandId}`;
    const receiptStatus = pendingPromptReceiptStatus(prompt);
    const failed = receiptStatus === "failed" || receiptStatus === "not_sent";
    const reason = failed || receiptStatus === "uncertain" ? deliveryReason(prompt.errorCode) : undefined;
    const reasonId = `pending-prompt-reason-${prompt.commandId}`;
    // An action is described by the message it acts on and, when there is one, why it ended there.
    const messageDescription = reason ? `${detailsId} ${reasonId}` : detailsId;
    const refused = actionRefusal !== null;
    const describedBy = refused ? `${messageDescription} ${refusalId}` : messageDescription;
    const retryDescribedBy = refused
      ? describedBy
      : recoveryBlocksRetry ? `${messageDescription} ${recoveryReasonId}` : messageDescription;
    const hasActions = cancelPending || cancelLive || prompt.canDismiss || prompt.canRetry;
    const details = prompt.attemptCount > 1 || prompt.error ? (
      <>
        {prompt.attemptCount > 1 && <p>Wollipog tried to deliver this message {prompt.attemptCount} times.</p>}
        {prompt.error && <p className="tl-receipt-raw">{prompt.error}</p>}
      </>
    ) : undefined;
    return (
      <ReceiptRow
        key={prompt.commandId}
        receiptId={receiptRowId.prompt(prompt.commandId)}
        testId={`pending-prompt-${prompt.commandId}`}
        rowProps={{ "data-pending-prompt-id": prompt.commandId }}
        bubbleId={detailsId}
        bubbleVariant={failed ? "failed" : "pending"}
        bubble={(
          <>
            {prompt.hasImages && <ReceiptAttachmentChip />}
            {prompt.text && <div className="bubble-text"><Markdown profile="inline">{prompt.text}</Markdown></div>}
          </>
        )}
      >
        {prompt.canRetry && recoveryBlocksRetry && !refused && (
          <p className="sr-only" id={recoveryReasonId}>{RECOVERY_BLOCKS_RETRY_REASON}</p>
        )}
        <ReceiptLine
          status={receiptStatus}
          reason={reason}
          reasonId={reasonId}
          detailsId={`pending-prompt-more-${prompt.commandId}`}
          details={details}
          actions={hasActions ? (
            <span className="tl-receipt-buttons" aria-busy={busy || undefined}>
              {prompt.canRetry && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={actionPending || recoveryBlocksRetry || refused}
                  title={actionRefusal ?? (recoveryBlocksRetry ? RECOVERY_BLOCKS_RETRY_REASON : undefined)}
                  aria-label={busy && !prompt.canDismiss ? "Retrying Message" : "Retry Message"}
                  aria-describedby={retryDescribedBy}
                  onClick={() => onRetry(prompt.commandId)}
                >
                  {busy && !prompt.canDismiss ? "Retrying…" : "Retry"}
                </button>
              )}
              {(cancelPending || cancelLive) && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={actionPending || refused}
                  title={actionRefusal ?? undefined}
                  aria-label={busy ? "Canceling Pending Message" : "Cancel Pending Message"}
                  aria-describedby={describedBy}
                  onClick={() => cancelPending
                    ? onCancelPending(prompt.commandId)
                    : onCancelLive(prompt.commandId)}
                >
                  {busy ? "Canceling…" : "Cancel"}
                </button>
              )}
              {prompt.canDismiss && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={actionPending || refused}
                  title={actionRefusal ?? undefined}
                  aria-label={busy && !prompt.canRetry ? "Dismissing Pending Message" : "Dismiss Pending Message"}
                  aria-describedby={describedBy}
                  onClick={() => onDismiss(prompt.commandId)}
                >
                  {busy && !prompt.canRetry ? "Dismissing…" : "Dismiss"}
                </button>
              )}
            </span>
          ) : undefined}
        />
        {refused && hasActions && <p className="tl-receipt-refusal" id={refusalId}>{actionRefusal}</p>}
      </ReceiptRow>
    );
  });
}
