import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { sessionAttentionStatus, type PendingApproval, type SessionView } from "@wollipog/protocol";
import { relativeTime } from "../../format.js";
import type { FollowTailState } from "../../useFollowTail.js";
import { ChevronRightIcon, ChevronUpIcon } from "../Icons.js";
import { useRemovedFocus } from "../useRemovedFocus.js";
import { registerRequestIntent, registerRequestRevealer } from "./request-reveal.js";
import { RequestCard, type RequestIntentHandler } from "./RequestCard.js";
import {
  REQUEST_CARD_COPY,
  RequestKindIcon,
  moreRequestsLabel,
  requestPositionLabel,
  waitingRequestKinds,
} from "./request-meta.js";

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
 *
 * While the reader scrolls back away from the live tail (`followTailState` is "paused"), the dock
 * shrinks to one 44px strip (#2195): the expanded request's icon, title and position, and Expand.
 * The request never disappears, A and D do nothing until it is expanded again, and a request that
 * arrives meanwhile is announced once. Returning to the tail restores the card and leaves focus where
 * it is; activating the strip restores it and moves focus to its heading, and it then stays expanded
 * until the reader is back at the tail.
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
  keyboardOpen = false,
  revealRequestId,
  followTailState,
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
  /** The software keyboard is open, so the dock gives the transcript more room (§13.2). */
  keyboardOpen?: boolean;
  /** A request to expand and focus as the dock mounts: it was asked for while a notice held its place. */
  revealRequestId?: string;
  /** The transcript's follow-tail state: while it is "paused" the dock shows its strip. */
  followTailState?: FollowTailState;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(() => revealRequestId ?? null);
  const [moreOpen, setMoreOpen] = useState(false);
  const listId = useId();
  const dockRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const focusHeading = useRef(revealRequestId !== undefined);
  const expanded = requests.find((request) => request.requestId === selectedId) ?? requests[0];
  const waiting = requests.filter((request) => request !== expanded);

  // Reading back shrinks the dock to its strip, unless the person expanded it since leaving the tail.
  const readingBack = followTailState === "paused";
  const [heldOpen, setHeldOpen] = useState(revealRequestId !== undefined);
  if (!readingBack && heldOpen) setHeldOpen(false);
  const collapsed = readingBack && !heldOpen;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const restore = () => {
    focusHeading.current = true;
    setHeldOpen(true);
  };

  // A and D reach the expanded card through the registry, from whichever keyboard owner reads them.
  // The strip takes them and does nothing, so no request is decided while it cannot be read.
  const intentRef = useRef<RequestIntentHandler | null>(null);
  useEffect(() => registerRequestIntent(session.id, (intent) =>
    collapsedRef.current || (intentRef.current?.(intent) ?? false)), [session.id]);

  const requestsRef = useRef(requests);
  requestsRef.current = requests;
  const expandedIdRef = useRef(expanded?.requestId);
  expandedIdRef.current = expanded?.requestId;
  useEffect(() => registerRequestRevealer(session.id, (requestId) => {
    if (!requestsRef.current.some((request) => request.requestId === requestId)) return false;
    setMoreOpen(false);
    if (expandedIdRef.current === requestId && !collapsedRef.current) {
      // Already expanded: nothing need render for it, so focus it now and leave no flag behind for
      // an unrelated later render to act on.
      headingRef.current?.focus();
      headingRef.current?.scrollIntoView?.({ block: "nearest" });
      return true;
    }
    focusHeading.current = true;
    setHeldOpen(true);
    setSelectedId(requestId);
    return true;
  }), [session.id]);

  useLayoutEffect(() => {
    if (!focusHeading.current) return;
    focusHeading.current = false;
    headingRef.current?.focus();
  });
  // A decision removes the button that had focus. The next request's heading takes it, so a keyboard
  // stays in the dock; with nothing left, the request coordinator returns focus to the composer. A
  // card that shrinks to its strip under focus hands it to Expand, and a strip restored under focus
  // hands it to the heading.
  const removedFocus = useRemovedFocus(dockRef, "[data-request-card-menu]");
  useLayoutEffect(() => {
    if (!removedFocus() || !expanded) return;
    if (collapsed) expandRef.current?.focus({ preventScroll: true });
    else headingRef.current?.focus();
  });
  useEffect(() => {
    if (waiting.length === 0) setMoreOpen(false);
  }, [waiting.length]);

  // A request that arrives while the strip shows is announced once; the card speaks for itself.
  const [announcement, setAnnouncement] = useState("");
  const seenRef = useRef<ReadonlySet<string>>(new Set(requests.map((request) => request.requestId)));
  useEffect(() => {
    const arrived = requests.filter((request) => !seenRef.current.has(request.requestId));
    seenRef.current = new Set(requests.map((request) => request.requestId));
    if (!collapsed) setAnnouncement("");
    else if (arrived.length > 0) {
      setAnnouncement(arrived.map((request) => requestAnnouncement(session, request)).join(" "));
    }
  }, [collapsed, requests, session]);

  if (!expanded) return null;
  return (
    <section
      ref={dockRef}
      className="request-dock"
      aria-label={REQUEST_CARD_COPY.pendingRequests}
      data-keyboard-open={keyboardOpen ? "" : undefined}
      data-collapsed={collapsed ? "" : undefined}
    >
      {collapsed ? (
        // The whole strip is the pointer target; Expand is its keyboard and assistive-technology
        // control, and its click reaches this handler too.
        <div
          className="dock-strip"
          data-session-request-id={expanded.requestId}
          data-session-request-session={session.id}
          onClick={restore}
        >
          <RequestKindIcon request={expanded} />
          <span className="dock-strip-title">{expanded.title}</span>
          <span className="dock-strip-position">
            {requestPositionLabel(requests.indexOf(expanded) + 1, requests.length)}
          </span>
          <button
            ref={expandRef}
            type="button"
            className="btn sm dock-strip-expand"
            aria-label={REQUEST_CARD_COPY.expandRequest}
          >
            <ChevronUpIcon size={14} />
            <span className="dock-strip-expand-label">{REQUEST_CARD_COPY.expand}</span>
          </button>
        </div>
      ) : (
        <>
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
        </>
      )}
      <span className="sr-only" role="status" aria-live="polite" data-request-dock-announcement="">
        {announcement}
      </span>
    </section>
  );
}

/** "Approval Required: Run a potentially destructive command": what the request needs, and its title. */
function requestAnnouncement(session: SessionView, request: PendingApproval): string {
  const attention = sessionAttentionStatus({ status: session.status, pendingApproval: request });
  return attention ? `${attention.label}: ${request.title}` : request.title;
}
