import type {
  PendingPromptView,
  QueuedPromptView,
  SessionStatus,
} from "@wollipog/protocol";
import { statusMeta, type StatusMeta } from "../status-meta.js";
import { StatusBadge } from "./StatusBadge.js";
import { Markdown } from "./Markdown.js";

const RECOVERY_BLOCKS_RETRY_REASON = "Recover the selected worktree before retrying this message.";

/** A pending message's status on the shared queued-message vocabulary (§11.2). */
export function pendingPromptStatus(prompt: PendingPromptView): StatusMeta {
  if (prompt.state === "failed" && prompt.errorCode === "WORKTREE_RECOVERY_REQUIRED") {
    return statusMeta("queuedMessage", "not_sent");
  }
  return prompt.state === "failed" && prompt.errorCode === "COMMAND_CANCELLED"
    ? statusMeta("queuedMessage", "cancelled")
    : statusMeta("queuedMessage", prompt.state);
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
  return prompts.filter((prompt) =>
    prompt.userEventSeq === undefined && !deliveredCommandIds.has(prompt.commandId)
  ).map((prompt) => {
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
    const refused = actionRefusal !== null;
    const describedBy = refused ? `${detailsId} ${refusalId}` : detailsId;
    const retryDescribedBy = refused
      ? describedBy
      : recoveryBlocksRetry ? `${detailsId} ${recoveryReasonId}` : detailsId;
    return (
      <div
        className="tl-row user"
        data-testid={`pending-prompt-${prompt.commandId}`}
        key={prompt.commandId}
      >
        <div className={`bubble user-bubble pending-prompt-bubble state-${prompt.state}`}>
          <div className="pending-prompt-meta">
            <StatusBadge meta={pendingPromptStatus(prompt)} inline className="pending-prompt-state" />
            <span className="pending-prompt-attempts">
              {prompt.attemptCount > 1
                ? `${prompt.attemptCount} Delivery Attempts`
                : "Awaiting Delivery"}
            </span>
          </div>
          <div id={detailsId}>
            {prompt.hasImages && <div className="pending-prompt-attachment">Attachment</div>}
            {prompt.text && <div className="bubble-text"><Markdown profile="inline">{prompt.text}</Markdown></div>}
            {prompt.error && <div className="pending-prompt-error">{prompt.error}</div>}
          </div>
          {prompt.canRetry && recoveryBlocksRetry && !refused && (
            <p className="sr-only" id={recoveryReasonId}>{RECOVERY_BLOCKS_RETRY_REASON}</p>
          )}
          {refused && (cancelPending || cancelLive || prompt.canDismiss || prompt.canRetry) && (
            <p className="sr-only" id={refusalId}>{actionRefusal}</p>
          )}
          {(cancelPending || cancelLive || prompt.canDismiss || prompt.canRetry) && (
            <div className="pending-prompt-actions" aria-busy={busy || undefined}>
              {(cancelPending || cancelLive) && (
                <button
                  type="button"
                  className="btn ghost sm"
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
                  className="btn ghost sm"
                  disabled={actionPending || refused}
                  title={actionRefusal ?? undefined}
                  aria-label={busy && !prompt.canRetry ? "Dismissing Pending Message" : "Dismiss Pending Message"}
                  aria-describedby={describedBy}
                  onClick={() => onDismiss(prompt.commandId)}
                >
                  {busy && !prompt.canRetry ? "Dismissing…" : "Dismiss"}
                </button>
              )}
              {prompt.canRetry && (
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={actionPending || recoveryBlocksRetry || refused}
                  title={actionRefusal ?? (recoveryBlocksRetry ? RECOVERY_BLOCKS_RETRY_REASON : undefined)}
                  aria-label={busy && !prompt.canDismiss ? "Retrying Message" : "Retry Message"}
                  aria-describedby={retryDescribedBy}
                  onClick={() => onRetry(prompt.commandId)}
                >
                  {busy && !prompt.canDismiss ? "Retrying…" : "Retry"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  });
}
