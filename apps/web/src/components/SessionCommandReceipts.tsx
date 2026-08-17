import type { SessionCommandInvocationView } from "@wollipog/protocol";
import React from "react";
import type { TimelineItem } from "../timeline.js";

const LABELS: Record<SessionCommandInvocationView["state"], string> = {
  pending: "Pending Delivery",
  sent: "Sent",
  accepted: "Accepted",
  queued: "Queued",
  started: "Running",
  completed: "Completed",
  rejected: "Rejected",
  uncertain: "Delivery Uncertain",
};

const TERMINAL_RECOVERY_RECEIPT_LIMIT = 5;

function commandInvocationIdentity(invocation: Pick<
  SessionCommandInvocationView,
  | "invocationId"
  | "submissionId"
  | "providerCommandId"
  | "catalogRevision"
  | "commandName"
  | "executionMode"
>): string {
  return JSON.stringify([
    invocation.invocationId,
    invocation.submissionId,
    invocation.providerCommandId,
    invocation.catalogRevision,
    invocation.commandName,
    invocation.executionMode,
  ]);
}

export function visibleSessionCommandReceipts(
  invocations: readonly SessionCommandInvocationView[],
  timelineItems: readonly TimelineItem[],
  /** The timeline is a bounded window, so a canonical message may simply be below it. */
  historyPartial = false,
): SessionCommandInvocationView[] {
  const canonical = new Set(timelineItems.flatMap((item) =>
    item.kind === "user_message" && item.commandInvocation
      ? [commandInvocationIdentity(item.commandInvocation)]
      : []));
  const terminalRecoveryIds = new Set(invocations
    .filter((invocation) =>
      invocation.state === "rejected" || invocation.state === "uncertain" ||
      // A completed invocation retires into the canonical transcript, so its absence normally means
      // the message never landed. Against a bounded window absence proves nothing: the message can
      // be in an unloaded turn, and inferring recovery from it resurrects receipts for commands
      // that completed cleanly turns ago.
      (invocation.state === "completed" && !historyPartial &&
        !canonical.has(commandInvocationIdentity(invocation))))
    .sort((left, right) =>
      right.updatedAt - left.updatedAt ||
      right.createdAt - left.createdAt ||
      right.invocationId.localeCompare(left.invocationId))
    .slice(0, TERMINAL_RECOVERY_RECEIPT_LIMIT)
    .map((invocation) => invocation.invocationId));

  return invocations.filter((invocation) => {
    if (invocation.state === "completed" || invocation.state === "rejected" || invocation.state === "uncertain") {
      return terminalRecoveryIds.has(invocation.invocationId);
    }
    return true;
  });
}

/** Durable provider-command delivery state. Completed rows retire into the canonical transcript;
 * failures and ambiguity remain visible beside the composer. */
export function SessionCommandReceipts({
  invocations,
  timelineItems,
  historyPartial = false,
}: {
  invocations: readonly SessionCommandInvocationView[];
  timelineItems: readonly TimelineItem[];
  /** The transcript is a bounded window, so a canonical message may sit in an unloaded turn. */
  historyPartial?: boolean;
}) {
  const visible = visibleSessionCommandReceipts(invocations, timelineItems, historyPartial);
  if (!visible.length) return null;
  return (
    <section className="steering-receipts" aria-label="Provider Command Receipts">
      {visible.map((invocation) => (
        <article
          className="steering-receipt"
          data-status={invocation.state}
          data-testid={`provider-command-${invocation.submissionId}`}
          key={invocation.invocationId}
        >
          <div className="steering-receipt-head">
            <span className="steering-receipt-status" data-status={invocation.state}>
              {LABELS[invocation.state]}
            </span>
            <span className="steering-receipt-source">Provider Command</span>
          </div>
          <div className="steering-receipt-content">
            <span className="steering-receipt-text">
              /{invocation.commandName}{invocation.argumentText ? ` ${invocation.argumentText}` : ""}
            </span>
          </div>
          {(invocation.error || invocation.state === "uncertain") && (
            <div className="steering-receipt-details" role={invocation.state === "rejected" ? "alert" : "status"}>
              {invocation.error ?? "Delivery may have reached the provider. Inspect the transcript before retrying."}
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
