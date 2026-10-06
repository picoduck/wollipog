import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { sessionAttentionStatus, type AgentQuestion, type PendingApproval, type SessionView } from "@wollipog/protocol";
import { relativeTime } from "../../format.js";
import type { FollowTailState } from "../../useFollowTail.js";
import { ChevronRightIcon, ChevronUpIcon } from "../Icons.js";
import { SessionQuestionBanner } from "../SessionApproval.js";
import { useRemovedFocus } from "../useRemovedFocus.js";
import { registerRequestIntent, registerRequestRevealer } from "./request-reveal.js";
import { RequestCard, type RequestIntentHandler } from "./RequestCard.js";
import { PreviewQuestionCard } from "./PreviewQuestionCard.js";
import {
  REQUEST_CARD_COPY,
  RequestKindIcon,
  moreRequestsLabel,
  requestPositionLabel,
  waitingRequestKinds,
} from "./request-meta.js";

/** The requests the dock answers: the session's own, questions included (#2205), never a request a
 * worker owns (the Agents panel answers those until the session can). */
export function dockRequests(requests: readonly PendingApproval[]): PendingApproval[] {
  return requests.filter((request) => !request.ownerToolUseId);
}

/** Show Where Asked for the dock's questions (#2205), from the transcript that holds their markers. */
export interface DockWhereAsked {
  show: (requestId: string) => void;
  /** Why a question's marker can't be shown, or null. */
  unavailableReason: (requestId: string) => string | null;
  /** The question whose marker the transcript is loading back to. */
  loadingRequestId: string | null;
}

/**
 * The request dock (docs/design-system.md §13.2; #2179): the session's pending requests directly
 * above the composer, in attention priority order. A question is the question card (#2196, #2205),
 * whose Show Where Asked puts the dock in its strip as reading back does.
 *
 * Only the first is expanded. The rest wait behind one "+N More Requests" disclosure whose rows are
 * one-line buttons; choosing one expands it for this view without changing the order, and a decision
 * brings up the next. The cap that keeps the transcript at least half of the reading column is the
 * stylesheet's (`.request-dock`), measured against `.chat-reading`. The Sessions preview (#2210)
 * docks it above its reader instead, capped at half the preview, and its question card offers
 * Answer in Session rather than the answer form.
 *
 * While the reader scrolls back away from the live tail (`followTailState` is "paused"), the dock
 * shrinks to one 44px strip (#2195): the expanded request's icon, title and position, and Expand.
 * It waits until the reader is far enough above the tail that the height it gives back cannot move
 * the rows being read. The request never disappears, A and D do nothing until it is expanded again, and a request that
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
  readerRef,
  onConceal,
  questionsFor,
  whereAsked,
  onAnswerInSession,
  composerAnswer,
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
  /** The transcript's scroller, whose room below the reading position the strip waits for. Without
   * one the strip shows as soon as the reader is paused. */
  readerRef?: RefObject<HTMLElement | null>;
  /** Called as the strip takes the card's place: closes the menu behind `headTrailing` (the notice
   * slot's `concealTrailing`) and answers whether it was open. */
  onConceal?: () => boolean;
  /** A question's questions: by default the request's own. */
  questionsFor?: (request: PendingApproval) => AgentQuestion[];
  /** Absent where the dock has no transcript to show a question's place in. */
  whereAsked?: DockWhereAsked;
  /** The Sessions preview's dock (#2210): a question is not answered here but in its session, which
   * this opens with the question docked. */
  onAnswerInSession?: (requestId: string) => void;
  /** The question the composer answers in Composer Response, and how to open Answer Mode for it
   * (#2212): its card is then compact. While Answer Mode is open the caller leaves it out of
   * `requests`, so the question shows once. */
  composerAnswer?: { requestId: string; onAnswer: () => void };
}) {
  const [selectedId, setSelectedId] = useState<string | null>(() => revealRequestId ?? null);
  const [moreOpen, setMoreOpen] = useState(false);
  const listId = useId();
  const dockRef = useRef<HTMLElement>(null);
  // A question card's heading is a `div` with the heading role (its text may hold lists); the dock
  // only focuses it and scrolls it into view.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const focusHeading = useRef(revealRequestId !== undefined);
  const expanded = requests.find((request) => request.requestId === selectedId) ?? requests[0];
  const waiting = requests.filter((request) => request !== expanded);

  // Reading back shrinks the dock to its strip, unless the person expanded it since leaving the tail.
  const readingBack = followTailState === "paused";
  const [heldOpen, setHeldOpen] = useState(revealRequestId !== undefined);
  const [shrunk, setShrunk] = useState(false);
  if (!readingBack && (heldOpen || shrunk)) {
    setHeldOpen(false);
    setShrunk(false);
  }
  const collapsed = readingBack && !heldOpen && shrunk;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const shrinkableRef = useRef(false);
  shrinkableRef.current = readingBack && !heldOpen && !shrunk;
  const restore = () => {
    focusHeading.current = true;
    setHeldOpen(true);
  };
  // The strip waits until the reader is at least the height it gives back above the tail. Nearer, the
  // taller transcript would have nothing below its rows to fill, and the browser's clamp would move
  // them; there the reader is still about to read the request anyway.
  const shrinkIfRoom = useRef(() => {});
  shrinkIfRoom.current = () => {
    if (!shrinkableRef.current) return;
    const reader = readerRef?.current;
    const dock = dockRef.current;
    if (reader && dock) {
      const givenBack = dock.getBoundingClientRect().height - DOCK_STRIP_HEIGHT_PX;
      if (reader.scrollHeight - reader.scrollTop - reader.clientHeight < givenBack) return;
    }
    setShrunk(true);
  };
  useLayoutEffect(() => shrinkIfRoom.current());
  useEffect(() => {
    const reader = readerRef?.current;
    if (!reader) return;
    const onScroll = () => shrinkIfRoom.current();
    reader.addEventListener("scroll", onScroll, { passive: true });
    return () => reader.removeEventListener("scroll", onScroll);
  }, [readerRef]);

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
  // strip restored under focus hands it to the heading.
  const removedFocus = useRemovedFocus(dockRef, '[data-request-card-menu="dock"]');
  useLayoutEffect(() => {
    if (!removedFocus() || !expanded) return;
    if (collapsed) expandRef.current?.focus({ preventScroll: true });
    else headingRef.current?.focus();
  });
  // A card hidden behind its strip closes the menus opened from it, which are portalled and would
  // stay open over the strip: its own ⋯ (RequestCard's `concealed`) and the notice slot's "+N More"
  // in its head (`onConceal`). Focus in the card or one of those menus goes to Expand, rather than
  // staying on a control nobody can see.
  const wasCollapsed = useRef(collapsed);
  useLayoutEffect(() => {
    const hid = collapsed && !wasCollapsed.current;
    wasCollapsed.current = collapsed;
    if (!hid) return;
    const card = cardRef.current;
    const active = card?.ownerDocument.activeElement;
    const menu = active?.closest<HTMLElement>('[role="menu"]');
    const menuFromCard = menu?.id !== undefined && menu.id !== "" &&
      [...(card?.querySelectorAll("[aria-controls]") ?? [])].some((trigger) => trigger.getAttribute("aria-controls") === menu.id);
    // A menu that was open may already have lost its focused item in this same update, leaving focus
    // nowhere; it was the card's, so it goes to Expand too.
    const closedOpenMenu = onConceal?.() === true;
    const focusLost = !active || active === card?.ownerDocument.body;
    if ((closedOpenMenu && focusLost) ||
        (active && (card?.contains(active) || active.closest('[data-request-card-menu="dock"]') || menuFromCard))) {
      expandRef.current?.focus({ preventScroll: true });
    }
  });
  useEffect(() => {
    if (waiting.length === 0) setMoreOpen(false);
  }, [waiting.length]);

  // A request that arrives while the strip shows is announced once; the card speaks for itself. An
  // arrival is a new occurrence, since a provider may ask again under the same request id, and each
  // announcement is a new node, so one that repeats the last one's words is still spoken.
  const [announcement, setAnnouncement] = useState<{ text: string; serial: number } | null>(null);
  const seenRef = useRef<ReadonlySet<string>>(new Set(requests.map(occurrenceKey)));
  useEffect(() => {
    const arrived = requests.filter((request) => !seenRef.current.has(occurrenceKey(request)));
    seenRef.current = new Set(requests.map(occurrenceKey));
    if (!collapsed) setAnnouncement(null);
    else if (arrived.length > 0) {
      const text = arrived.map((request) => requestAnnouncement(session, request)).join(" ");
      setAnnouncement((previous) => ({ text, serial: (previous?.serial ?? 0) + 1 }));
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
      {collapsed && (
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
      )}
      {!collapsed && waiting.length > 0 && (
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
      {/* Hidden, not unmounted, behind the strip: work in progress on the card (a sign-in code, an
          evidence review) and what happens to it meanwhile are still there when it is expanded. The
          strip is then the request's region for the controls that look it up. */}
      <div
        ref={cardRef}
        className="request-dock-card"
        hidden={collapsed}
        data-session-request-id={collapsed ? undefined : expanded.requestId}
        data-session-request-session={collapsed ? undefined : session.id}
      >
        {expanded.kind === "question" && onAnswerInSession ? (
          <PreviewQuestionCard
            key={`${expanded.requestId}:${expanded.occurrenceId ?? ""}`}
            sessionId={session.id}
            request={expanded}
            runnerOnline={runnerOnline}
            questions={questionsFor?.(expanded) ?? expanded.questions ?? []}
            owner={owner}
            createdAt={createdAt?.(expanded)}
            headTrailing={headTrailing}
            headingRef={headingRef}
            showKeyHints={showKeyHints}
            intentRef={intentRef}
            onSessionUpdate={onSessionUpdate}
            onAnswerInSession={onAnswerInSession}
          />
        ) : expanded.kind === "question" ? (
          <SessionQuestionBanner
            key={`${expanded.requestId}:${expanded.occurrenceId ?? ""}`}
            sessionId={session.id}
            requestId={expanded.requestId}
            occurrenceId={expanded.occurrenceId}
            questions={questionsFor?.(expanded) ?? expanded.questions ?? []}
            isAsync={expanded.async}
            recoveryReason={expanded.recoveryReason}
            recoveryAction={expanded.recoveryAction}
            runnerOnline={runnerOnline}
            onSessionUpdate={onSessionUpdate}
            showKeyHints={showKeyHints}
            owner={owner}
            createdAt={createdAt?.(expanded)}
            headingRef={headingRef}
            headTrailing={headTrailing}
            keyboardOpen={keyboardOpen}
            intentRef={intentRef}
            topRequest={expanded === requests[0]}
            onAnswer={composerAnswer?.requestId === expanded.requestId ? composerAnswer.onAnswer : undefined}
            whereAsked={whereAsked && {
              // As reading back does: the dock shrinks to its strip once the reader is far enough
              // from the tail, even if the person expanded it since leaving.
              onShow: () => {
                setHeldOpen(false);
                whereAsked.show(expanded.requestId);
              },
              unavailableReason: whereAsked.unavailableReason(expanded.requestId),
              loading: whereAsked.loadingRequestId === expanded.requestId,
            }}
          />
        ) : (
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
            concealed={collapsed}
          />
        )}
      </div>
      <span className="sr-only" role="status" aria-live="polite" data-request-dock-announcement="">
        {announcement && <span key={announcement.serial}>{announcement.text}</span>}
      </span>
    </section>
  );
}

/** The strip's height (`.dock-strip`), which the dock keeps of the card's while reading back. */
const DOCK_STRIP_HEIGHT_PX = 44;

function occurrenceKey(request: PendingApproval): string {
  return JSON.stringify([request.requestId, request.occurrenceId ?? null]);
}

/** "Approval Required: Run a potentially destructive command": what the request needs, and its title. */
function requestAnnouncement(session: SessionView, request: PendingApproval): string {
  const attention = sessionAttentionStatus({ status: session.status, pendingApproval: request });
  return attention ? `${attention.label}: ${request.title}` : request.title;
}
