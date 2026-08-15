import type { PendingPromptState, PendingPromptView, SessionStatus } from "@wollipog/protocol";

const LABELS: Record<PendingPromptState, string> = {
  pending: "Pending",
  sent: "Sending",
  accepted: "Accepted",
  queued: "Queued",
  started: "Starting",
  failed: "Delivery Failed",
  uncertain: "Delivery Uncertain",
};

export function pendingPromptLabel(prompt: PendingPromptView): string {
  return prompt.state === "failed" && prompt.errorCode === "COMMAND_CANCELLED"
    ? "Cancelled"
    : LABELS[prompt.state];
}

export function shouldShowOptimisticPrompt(
  status: SessionStatus,
  durableProviderInvocation: boolean,
): boolean {
  return !durableProviderInvocation &&
    !["queued", "running", "starting", "input_required"].includes(status);
}

export function PendingPromptBubbles({
  prompts,
  deliveredCommandIds,
  liveQueueIds,
  canCancelLive,
  pendingAction,
  onCancelPending,
  onCancelLive,
  onDismiss,
}: {
  prompts: PendingPromptView[];
  deliveredCommandIds: ReadonlySet<string>;
  liveQueueIds: ReadonlySet<string>;
  canCancelLive: boolean;
  pendingAction?: string;
  onCancelPending: (commandId: string) => void;
  onCancelLive: (commandId: string) => void;
  onDismiss: (commandId: string) => void;
}) {
  return prompts.filter((prompt) => !deliveredCommandIds.has(prompt.commandId)).map((prompt) => {
    const busy = pendingAction === prompt.commandId;
    const cancelPending = prompt.canCancel === true;
    const cancelLive = !cancelPending && !prompt.canDismiss && canCancelLive &&
      liveQueueIds.has(prompt.commandId);
    const detailsId = `pending-prompt-details-${prompt.commandId}`;
    return (
      <div
        className="tl-row user"
        data-testid={`pending-prompt-${prompt.commandId}`}
        key={prompt.commandId}
      >
        <div className={`bubble user-bubble pending-prompt-bubble state-${prompt.state}`}>
          <div className="pending-prompt-meta">
            <span className="pending-prompt-state">{pendingPromptLabel(prompt)}</span>
            <span className="pending-prompt-attempts">
              {prompt.attemptCount > 1 ? `${prompt.attemptCount} Attempts` : "Awaiting Delivery"}
            </span>
          </div>
          <div id={detailsId}>
            {prompt.hasImages && <div className="pending-prompt-attachment">Image Attachment</div>}
            {prompt.text && <div className="bubble-text">{prompt.text}</div>}
            {prompt.error && <div className="pending-prompt-error">{prompt.error}</div>}
          </div>
          {(cancelPending || cancelLive || prompt.canDismiss) && (
            <div className="pending-prompt-actions">
              {(cancelPending || cancelLive) && (
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy}
                  aria-label="Cancel Pending Message"
                  aria-describedby={detailsId}
                  onClick={() => cancelPending
                    ? onCancelPending(prompt.commandId)
                    : onCancelLive(prompt.commandId)}
                >
                  {busy ? "Cancelling…" : "Cancel"}
                </button>
              )}
              {prompt.canDismiss && (
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy}
                  aria-label="Dismiss Pending Message"
                  aria-describedby={detailsId}
                  onClick={() => onDismiss(prompt.commandId)}
                >
                  {busy ? "Dismissing…" : "Dismiss"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  });
}
