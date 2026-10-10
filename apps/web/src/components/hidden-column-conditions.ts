import { useCallback, useEffect, useRef, useState } from "react";
import type { QueuedPromptView, SessionView } from "@wollipog/protocol";
import { isTerminalDeliveryReceipt } from "../session-actions.js";
import type { SessionNoticeEntry } from "./SessionNoticeSlot.js";

/**
 * Conditions that arrive with session data while the side panel hides the chat column (#2894):
 * desktop Expanded (#2845), whose hidden column silences its own live regions, and the phone sheet
 * (#2843), which makes the column inert. docs/design-system.md §4.9 states the rule: a failure
 * brings the column back, a request only shows its indicator, and both are announced.
 */
export type ColumnHiddenBy = "expanded" | "sheet";

export interface HiddenColumnFailure {
  /** One arrival. A key restores the column at most once while the session is shown. */
  key: string;
  /** The notice's Title Case title, which is also what is announced. */
  title: string;
  /** Where the failure shows once the column is back. */
  target: { kind: "notice"; noticeKey: string } | { kind: "campaign" };
}

type CampaignContinuation = NonNullable<NonNullable<SessionView["orchestratorCampaign"]>["continuation"]>;

const QUEUED_DELIVERY_NOTICE = "queued-delivery:";
/** An action's own failure, which restores an expanded panel where the action runs (#2845). */
const ACTION_FAILURE_NOTICE = "composer-error:";

/**
 * The failures a person must act on, keyed per occurrence: a queued message whose delivery ended
 * failed or uncertain (uncertain is warning-toned in the slot, but terminal for that message), a
 * campaign continuation whose automatic retries stopped, and every other danger entry of the notice
 * slot. Warning and info entries, and the continuation's still-retrying warning, are not failures,
 * nor is the failure of an action the person took, which already brings the column back.
 */
export function hiddenColumnFailures({
  queued,
  continuation,
  notices,
}: {
  queued: readonly QueuedPromptView[];
  continuation: CampaignContinuation | undefined;
  notices: readonly Pick<SessionNoticeEntry, "key" | "severity" | "title">[];
}): HiddenColumnFailure[] {
  const failures: HiddenColumnFailure[] = [];
  for (const prompt of queued) {
    if (!prompt.durableDeliveryError || !isTerminalDeliveryReceipt(prompt)) continue;
    const failed = prompt.durableDeliveryState === "failed";
    failures.push({
      key: `queued:${prompt.id}:${prompt.durableDeliveryState ?? ""}`,
      title: failed ? "Message Not Delivered" : "Delivery Uncertain",
      target: { kind: "notice", noticeKey: `${QUEUED_DELIVERY_NOTICE}${prompt.id}` },
    });
  }
  if (continuation?.state === "failed" && continuation.canRetry === true) {
    failures.push({
      key: `continuation:${continuation.continuationId ?? continuation.commandId ?? ""}:${continuation.attemptCount}`,
      title: "Couldn't Resume the Orchestrator",
      target: { kind: "campaign" },
    });
  }
  for (const notice of notices) {
    // The queued messages above, whatever their tone in the slot.
    if (notice.severity !== "danger" || notice.key.startsWith(QUEUED_DELIVERY_NOTICE) ||
        notice.key.startsWith(ACTION_FAILURE_NOTICE)) continue;
    failures.push({ key: `notice:${notice.key}`, title: notice.title, target: { kind: "notice", noticeKey: notice.key } });
  }
  return failures;
}

/** What is announced when requests arrive while the column is hidden. */
export function hiddenColumnRequestAnnouncement(count: number): string {
  return count === 1 ? "New request waiting." : `${count} new requests waiting.`;
}

/** Whether a modal dialog is open over the page, which a restore must wait for. */
function modalDialogOpen(targetDocument: Document): boolean {
  return targetDocument.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

/**
 * Watches the shown session's failures and requests while the side panel hides its chat column.
 * What the session already has when it is shown is seen, so only later arrivals count, and each
 * key counts once: a condition that clears and returns under the same key does nothing, so a
 * flapping one cannot loop. A failure calls `onFailure` on the next frame, or once a modal dialog
 * over the page closes, if it still holds and the column is still hidden; leaving the session
 * unmounts the hook and drops anything still waiting. Returns the polite announcement to render
 * outside the hidden column.
 */
export function useHiddenColumnConditions({
  sessionId,
  hiddenBy,
  failures,
  requestKeys,
  onFailure,
}: {
  sessionId: string;
  hiddenBy: ColumnHiddenBy | null;
  failures: readonly HiddenColumnFailure[];
  /** The docked requests' occurrence keys. */
  requestKeys: readonly string[];
  /** Brings the column back to show this failure; `hiddenBy` says how it was hidden. */
  onFailure: (failure: HiddenColumnFailure, hiddenBy: ColumnHiddenBy) => void;
}): string {
  const latest = useRef({ hiddenBy, failures, onFailure });
  latest.current = { hiddenBy, failures, onFailure };
  const seen = useRef<{ sessionId: string; failures: Set<string>; requests: Set<string> } | null>(null);
  const waiting = useRef<HiddenColumnFailure[]>([]);
  const frame = useRef<number | null>(null);
  const observer = useRef<MutationObserver | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const flush = useCallback(() => {
    frame.current = null;
    if (waiting.current.length === 0) return;
    if (modalDialogOpen(document)) {
      // Wait for the dialog to close rather than moving the layout under it.
      if (!observer.current) {
        observer.current = new MutationObserver(() => {
          if (modalDialogOpen(document)) return;
          observer.current?.disconnect();
          observer.current = null;
          frame.current ??= window.requestAnimationFrame(flush);
        });
        observer.current.observe(document.body, {
          childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal", "role"],
        });
      }
      return;
    }
    const arrived = waiting.current.splice(0);
    const { hiddenBy: hidden, failures: current, onFailure: show } = latest.current;
    const holding = arrived.find((failure) => current.some((candidate) => candidate.key === failure.key));
    // The person brought the column back already, or the failure cleared while it waited.
    if (!hidden || !holding) return;
    show(holding, hidden);
  }, []);

  useEffect(() => () => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    observer.current?.disconnect();
  }, []);

  const failureSignature = failures.map((failure) => failure.key).join("\n");
  const requestSignature = requestKeys.join("\n");
  useEffect(() => {
    const state = seen.current;
    const { failures: current, hiddenBy: hidden } = latest.current;
    if (!state || state.sessionId !== sessionId) {
      seen.current = {
        sessionId,
        failures: new Set(current.map((failure) => failure.key)),
        requests: new Set(requestKeys),
      };
      waiting.current = [];
      return;
    }
    const newFailures = current.filter((failure) => !state.failures.has(failure.key));
    const newRequests = requestKeys.filter((key) => !state.requests.has(key));
    for (const failure of newFailures) state.failures.add(failure.key);
    for (const key of newRequests) state.requests.add(key);
    // With the column in view its own notices and the dock announce themselves.
    if (!hidden) return;
    const messages = [
      ...newFailures.map((failure) => `${failure.title}.`),
      ...(newRequests.length > 0 ? [hiddenColumnRequestAnnouncement(newRequests.length)] : []),
    ];
    // A repeated message gains a no-break space, so the live region hears a change.
    if (messages.length > 0) {
      const message = messages.join(" ");
      setAnnouncement((previous) => previous === message ? `${message} ` : message);
    }
    if (newFailures.length === 0) return;
    waiting.current.push(...newFailures);
    frame.current ??= window.requestAnimationFrame(flush);
  // The signatures stand for the failures and request keys, which are rebuilt every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, failureSignature, requestSignature, flush]);

  return announcement;
}
