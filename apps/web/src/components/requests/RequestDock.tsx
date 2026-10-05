import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { PendingApproval, SessionView } from "@wollipog/protocol";
import { relativeTime } from "../../format.js";
import { ChevronRightIcon } from "../Icons.js";
import { useRemovedFocus } from "../useRemovedFocus.js";
import { registerRequestRevealer } from "./request-reveal.js";
import { RequestCard, type RequestIntentHandler } from "./RequestCard.js";
import { REQUEST_CARD_COPY, RequestKindIcon, moreRequestsLabel, waitingRequestKinds } from "./request-meta.js";

/** The requests the dock answers: the session's own, never a question (#2205 docks those) or a
 * request a worker owns (the Agents panel answers those until the session can). */
export function dockRequests(requests: readonly PendingApproval[]): PendingApproval[] {
  return requests.filter((request) => request.kind !== "question" && !request.ownerToolUseId);
}

/**
 * The request dock (docs/design-system.md §13.2; #2179): the session's pending requests directly
 * above the composer, in attention priority order.
 *
 * Only the first is expanded. The rest wait behind one "+N More Requests" disclosure whose rows are
 * one-line buttons; choosing one expands it for this view without changing the order, and a decision
 * brings up the next. The cap that keeps the transcript at least half of the reading column is the
 * stylesheet's (`.request-dock`), measured against `.chat-reading`.
 */
export function RequestDock({
  session,
  requests,
  runnerOnline,
  owner,
  createdAt,
  headTrailing,
  onSessionUpdate,
  showKeyHints,
  intentRef,
  keyboardOpen = false,
}: {
  session: SessionView;
  /** In priority order (`prioritizedPendingRequests`), already limited by `dockRequests`. */
  requests: readonly PendingApproval[];
  runnerOnline: boolean;
  owner?: string;
  createdAt?: (request: PendingApproval) => number | undefined;
  headTrailing?: ReactNode;
  onSessionUpdate?: (session: SessionView) => void;
  showKeyHints?: boolean;
  intentRef?: MutableRefObject<RequestIntentHandler | null>;
  /** The software keyboard is open, so the dock gives the transcript more room (§13.2). */
  keyboardOpen?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const listId = useId();
  const dockRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);
  const expanded = requests.find((request) => request.requestId === selectedId) ?? requests[0];
  const waiting = requests.filter((request) => request !== expanded);

  const requestsRef = useRef(requests);
  requestsRef.current = requests;
  useEffect(() => registerRequestRevealer(session.id, (requestId) => {
    if (!requestsRef.current.some((request) => request.requestId === requestId)) return false;
    focusHeading.current = true;
    setSelectedId(requestId);
    setMoreOpen(false);
    // The same request again does not re-render, so focus it here as well.
    headingRef.current?.focus();
    headingRef.current?.scrollIntoView?.({ block: "nearest" });
    return true;
  }), [session.id]);

  useLayoutEffect(() => {
    if (!focusHeading.current) return;
    focusHeading.current = false;
    headingRef.current?.focus();
  });
  // A decision removes the button that had focus. The next request's heading takes it, so a keyboard
  // stays in the dock; with nothing left, the request coordinator returns focus to the composer.
  const removedFocus = useRemovedFocus(dockRef, ".menu-pop");
  useLayoutEffect(() => {
    if (removedFocus() && expanded) headingRef.current?.focus();
  });
  useEffect(() => {
    if (waiting.length === 0) setMoreOpen(false);
  }, [waiting.length]);

  if (!expanded) return null;
  return (
    <section
      ref={dockRef}
      className="request-dock"
      aria-label={REQUEST_CARD_COPY.pendingRequests}
      data-keyboard-open={keyboardOpen ? "" : undefined}
    >
      {waiting.length > 0 && (
        <div className="request-dock-more disclosure">
          <button
            type="button"
            className="disclosure-trigger"
            aria-expanded={moreOpen}
            aria-controls={moreOpen ? listId : undefined}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <ChevronRightIcon size={14} className="disclosure-chevron" />
            <span>{moreRequestsLabel(waiting.length)}</span>
            <span className="request-dock-more-kinds">{waitingRequestKinds(waiting)}</span>
          </button>
          {moreOpen && (
            <ul className="request-dock-rows" id={listId} aria-label={REQUEST_CARD_COPY.waitingRequests}>
              {waiting.map((request) => {
                const time = createdAt?.(request) ?? request.workflowDecision?.createdAt;
                return (
                  <li key={request.requestId}>
                    <button
                      type="button"
                      className="request-dock-row"
                      onClick={() => {
                        focusHeading.current = true;
                        setSelectedId(request.requestId);
                        setMoreOpen(false);
                      }}
                    >
                      <RequestKindIcon request={request} />
                      <span className="request-dock-row-title">{request.title}</span>
                      {owner && <span className="request-dock-row-owner">{owner}</span>}
                      {time ? <span className="request-dock-row-time">{relativeTime(time)}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      <div
        className="request-dock-card"
        data-session-request-id={expanded.requestId}
        data-session-request-session={session.id}
      >
        <RequestCard
          key={`${expanded.requestId}:${expanded.occurrenceId ?? ""}`}
          session={session}
          request={expanded}
          runnerOnline={runnerOnline}
          presentation="dock"
          owner={owner}
          createdAt={createdAt?.(expanded)}
          headTrailing={headTrailing}
          onSessionUpdate={onSessionUpdate}
          showKeyHints={showKeyHints}
          intentRef={intentRef}
          headingRef={headingRef}
        />
      </div>
    </section>
  );
}
