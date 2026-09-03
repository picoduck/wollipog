import type { QueuedPromptView } from "@wollipog/protocol";

export type QueuedEditRecoveryReconciliation =
  | { status: "retryable" }
  | { status: "checking"; reason: string }
  | { status: "stale"; reason: string };

/** Recovered edits are retryable only against the same live queue identity and revision. */
export function reconcileQueuedEditRecovery(
  promptId: string,
  editRevision: string,
  queued: readonly QueuedPromptView[] | undefined,
  authoritative: boolean,
): QueuedEditRecoveryReconciliation {
  if (!authoritative) {
    return {
      status: "checking",
      reason: "Waiting for the authoritative queue before this recovered edit can be retried.",
    };
  }

  const target = queued?.find((prompt) => prompt.id === promptId);
  if (!target) {
    return {
      status: "stale",
      reason: "This queued message is no longer waiting, so the recovered edit cannot be saved in place.",
    };
  }
  if (target.liveQueueObserved !== true || target.editable !== true || !target.editRevision) {
    return {
      status: "stale",
      reason: target.editDisabledReason ??
        "This queued message is no longer editable. The recovered content is still available.",
    };
  }
  if (target.editRevision !== editRevision) {
    return {
      status: "stale",
      reason: "This queued message changed elsewhere. The recovered edit cannot overwrite its newer revision.",
    };
  }
  return { status: "retryable" };
}
