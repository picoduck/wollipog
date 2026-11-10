import type { SessionCommandInvocationView } from "@wollipog/protocol";
import React, { useCallback, useMemo, useState } from "react";
import { useInstanceScope } from "../instance-scope.js";
import { loadInstanceStorageValue, saveInstanceStorageValue } from "../instance-storage.js";
import { deliveryReason, type MessageReceiptStatus } from "../conversation-steering.js";
import type { TimelineItem } from "../timeline.js";
import { ReceiptLine, ReceiptRow, receiptRowId } from "./TranscriptReceipt.js";

/** Where a command went and what happened to it, as its receipt line says it (#2171). */
export function commandReceiptLine(
  invocation: Pick<SessionCommandInvocationView, "state" | "code">,
  agent: string,
): { status: MessageReceiptStatus; progress?: string; reason?: string } {
  switch (invocation.state) {
    case "pending":
    case "sent":
      return { status: "sending", progress: `Sending to ${agent}…` };
    case "accepted":
    case "queued":
      return { status: "queued", reason: `Waiting for ${agent}.` };
    case "started":
      return { status: "sending", progress: `Running in ${agent}…` };
    case "completed":
      return { status: "delivered", reason: `Ran in ${agent}.` };
    case "rejected":
      return { status: "rejected", reason: deliveryReason(invocation.code) };
    case "uncertain":
      return { status: "uncertain", reason: `${deliveryReason(undefined)} Check the transcript before running it again.` };
  }
}

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

const DISMISSALS_KEY = "wollipog.sessions.commandReceiptDismissals";
const DISMISSALS_CAP = 500;

function dismissalKey(invocation: SessionCommandInvocationView): string {
  // A definitive rejection still surfaces after an uncertain receipt was dismissed.
  return JSON.stringify([invocation.sessionId, invocation.invocationId, invocation.state]);
}

function readDismissals(scope: string): string[] {
  try {
    const value: unknown = JSON.parse(loadInstanceStorageValue(DISMISSALS_KEY, scope) ?? "[]");
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

/** Device-local presentation only: dismissal never changes the provider's delivery record. */
export function useCommandReceiptDismissals(): [ReadonlySet<string>, (invocation: SessionCommandInvocationView) => void] {
  const scope = useInstanceScope();
  // Dismiss also works when browser storage is unavailable.
  const [local, setLocal] = useState<{ scope: string; keys: string[] } | null>(null);
  const dismissed = useMemo(() => new Set([
    ...readDismissals(scope), ...(local?.scope === scope ? local.keys : []),
  ]), [scope, local]);
  const dismiss = useCallback((invocation: SessionCommandInvocationView) => {
    if (invocation.state !== "rejected" && invocation.state !== "uncertain") return;
    const key = dismissalKey(invocation);
    const keys = [...new Set([...readDismissals(scope), ...dismissed, key])].slice(-DISMISSALS_CAP);
    saveInstanceStorageValue(DISMISSALS_KEY, JSON.stringify(keys), scope);
    setLocal({ scope, keys });
  }, [scope, dismissed]);
  return [dismissed, dismiss];
}

export function visibleSessionCommandReceipts(
  invocations: readonly SessionCommandInvocationView[],
  timelineItems: readonly TimelineItem[],
  /** The timeline is a bounded window, so a canonical message may simply be below it. */
  historyPartial = false,
  dismissed: ReadonlySet<string> = new Set(),
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
      return terminalRecoveryIds.has(invocation.invocationId) && !dismissed.has(dismissalKey(invocation));
    }
    return true;
  });
}

/** Durable provider-command delivery state, as rows of the transcript under each command (#2171).
 * Completed rows retire into the canonical transcript; failures and ambiguity remain. */
export function SessionCommandReceipts({
  invocations,
  timelineItems,
  historyPartial = false,
  agentLabel,
  isSkillInvocation,
  onDismiss,
}: {
  onDismiss?: (invocation: SessionCommandInvocationView) => void;
  invocations: readonly SessionCommandInvocationView[];
  timelineItems: readonly TimelineItem[];
  /** The transcript is a bounded window, so a canonical message may sit in an unloaded turn. */
  historyPartial?: boolean;
  /** The agent the command went to, as the session names it. */
  agentLabel: string;
  /** True for a skill invocation, spelled `$name` like the canonical transcript. */
  isSkillInvocation?: (invocation: SessionCommandInvocationView) => boolean;
}) {
  const visible = visibleSessionCommandReceipts(invocations, timelineItems, historyPartial);
  if (!visible.length) return null;
  return (
    <>
      {visible.map((invocation) => {
        const line = commandReceiptLine(invocation, agentLabel);
        const failed = invocation.state === "rejected" || invocation.state === "uncertain";
        return (
          <ReceiptRow
            key={invocation.invocationId}
            receiptId={receiptRowId.command(invocation.invocationId)}
            testId={`provider-command-${invocation.submissionId}`}
            rowProps={{ "data-status": invocation.state }}
            commandBubble
            bubbleVariant={failed ? "failed" : invocation.state === "completed" ? undefined : "pending"}
            bubble={(
              <span className="bubble-text">
                {isSkillInvocation?.(invocation) ? "$" : "/"}{invocation.commandName}
                {invocation.argumentText ? ` ${invocation.argumentText}` : ""}
              </span>
            )}
          >
            <ReceiptLine
              status={line.status}
              progress={line.progress}
              reason={line.reason}
              role="status"
              actions={failed && onDismiss ? (
                <button type="button" className="btn ghost sm" aria-label="Dismiss Command Message"
                  onClick={() => onDismiss(invocation)}>Dismiss</button>
              ) : undefined}
              detailsId={`provider-command-details-${invocation.invocationId}`}
              details={invocation.error ? <p className="tl-receipt-raw">{invocation.error}</p> : undefined}
            />
          </ReceiptRow>
        );
      })}
    </>
  );
}
