import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  type DescendantRequestView,
  type PendingApproval,
  type SessionView,
} from "@wollipog/protocol";
import { relativeTime } from "../format.js";
import { viewPath } from "../navigation.js";
import { sessionCommandRefusal } from "../session-command-permissions.js";
import { CountBadge } from "./CountBadge.js";
import { ChevronLeftIcon, ChevronRightIcon, InboxIcon } from "./Icons.js";
import { SessionQuestionBanner, useSessionResponseRefusal } from "./SessionApproval.js";
import { State } from "./State.js";
import { useRemovedFocus } from "./useRemovedFocus.js";
import { RequestCard } from "./requests/RequestCard.js";
import { RequestKindIcon } from "./requests/request-meta.js";

type RequestPanelItem = {
  key: string;
  sessionId: string;
  sessionTitle: string;
  runnerId: string;
  runnerOnline: boolean;
  eventEpoch: number;
  createdAt: number;
  responseOwner: "human" | "orchestrator";
  occurrenceId: string;
  request: PendingApproval;
  descendant: DescendantRequestView;
};

export type DescendantRequestStatus = "idle" | "loading" | "ready" | "unavailable";

/**
 * The panel's own words (§17; #2206), in one table the copy test classifies: labels and names are
 * Title Case, and the state's body and the Orchestrator's notice are sentences.
 */
export const REQUEST_PANEL_COPY = {
  waitingForYou: "Waiting for You",
  orchestratorHandling: "Orchestrator Is Handling",
  pendingRequests: "Pending Requests",
  allRequests: "All Requests",
  previousRequest: "Previous Request",
  nextRequest: "Next Request",
  childSession: "Child Session",
  nothingWaiting: "Nothing Waiting",
  decisionHistory: "Decision History",
  unavailable: "Couldn't Load Requests",
  retry: "Retry",
  orchestratorNotice: "The Orchestrator is handling this request.",
  nothingWaitingBody: "Requests from this session and its child sessions appear here.",
  unavailableBody: "Requests from child sessions can't be checked right now.",
  loading: "Loading requests…",
} as const;

/** Nothing new renders for a load that settles this quickly (§12.3). */
export const REQUEST_PANEL_SKELETON_DELAY_MS = 300;

/** The detail head's position within the request's group: "Request 2 of 8". */
export function requestPanelPositionLabel(position: number, count: number): string {
  return `Request ${position} of ${count}`;
}

/** Where the list was scrolled for each session, so returning from a detail keeps the place (§6.2). */
const listScrollPositions = new Map<string, number>();

export function descendantRequestCounts(requests: readonly Pick<DescendantRequestView, "responseOwner">[]) {
  let human = 0;
  let orchestrator = 0;
  for (const request of requests) {
    if (request.responseOwner === "human") human += 1;
    else orchestrator += 1;
  }
  return { human, orchestrator };
}

function itemKey(sessionId: string, occurrenceId: string): string {
  return JSON.stringify([sessionId, occurrenceId]);
}

export function requestTypeLabel(request: PendingApproval): string {
  if (request.kind === "question") return "Question";
  if (request.kind === "authentication") return "Authentication";
  if (request.kind === "workflow_decision") {
    const category = request.workflowDecision?.category;
    if (category === "ui_evidence_approval") return "UI Evidence";
    if (category === "pr_merge") return "PR Merge";
    if (category === "merged_branch_deletion") return "Branch Deletion";
    if (category === "issue_closure") return "Issue Closure";
    if (category === "campaign_issue_scope") return "Campaign Issue Scope";
    if (category === "follow_up_issue_publication") return "Issue Publication";
    if (category === "implementation_question") return "Implementation Decision";
    return "Workflow Decision";
  }
  return "Approval";
}

/** A row's first line: the request's own title, or a question's words where its title is generic. */
function rowTitle(request: PendingApproval): string {
  return request.kind === "question" ? request.questions?.[0]?.question.trim() || request.title : request.title;
}

/** The row's trailing time, short: "now", "45s", "3m", "2h", "1d". */
function shortRelativeTime(at: number): string {
  const long = relativeTime(at);
  return long === "just now" ? "now" : long.replace(/ ago$/, "");
}

function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return active && shown;
}

type PendingFocus = { kind: "row"; key: string } | { kind: "heading" } | null;

/**
 * The Requests panel (#2206; docs/design-system.md §6, §6.2): the requests of this session's child
 * sessions, as a list that opens each request in a detail in its place, at every width.
 *
 * The list has two groups, "Waiting for You" and "Orchestrator Is Handling", each a header with its
 * count over two-line rows. Choosing a row replaces the list with that request on the Request Card
 * in its panel presentation; "‹ All Requests" brings the list back with focus on the row, and ‹ ›
 * step through the request's group in list order. A request the Orchestrator owns is the same card,
 * read-only. `selectedKey` is the open request (`sessionRequestPanelKey`), or null for the list.
 *
 * The session's own requests are answered on the request dock above its composer (#2179), so this
 * panel lists only its descendants'.
 */
export function SessionRequestPanel({
  session,
  descendants,
  descendantStatus = "ready",
  selectedKey,
  onSelectedKeyChange,
  onDescendantsUpdate,
  onOpenChild,
  onRetry,
  onOpenDecisionHistory,
}: {
  session: SessionView;
  descendants: readonly DescendantRequestView[];
  descendantStatus?: DescendantRequestStatus;
  selectedKey: string | null;
  onSelectedKeyChange: (key: string | null) => void;
  /** Called once a child request is answered here, to read the list again. */
  onDescendantsUpdate: () => void;
  onOpenChild: (request: DescendantRequestView) => void;
  /** Checks the child requests again after they could not be loaded. */
  onRetry?: () => void;
  /** The empty state's next step: the decisions already made in this session (#2213). */
  onOpenDecisionHistory?: () => void;
}) {
  // Waiting for You first, then what the Orchestrator is handling, each in the order it arrived.
  const items = useMemo<RequestPanelItem[]>(() => descendants.map((item) => ({
    key: itemKey(item.sessionId, item.occurrenceId),
    sessionId: item.sessionId,
    sessionTitle: item.sessionTitle,
    runnerId: item.runnerId,
    runnerOnline: item.runnerOnline,
    eventEpoch: item.eventEpoch,
    createdAt: item.createdAt,
    responseOwner: item.responseOwner,
    occurrenceId: item.occurrenceId,
    request: item.request,
    descendant: item,
  })).sort((left, right) => left.responseOwner === right.responseOwner
    ? 0
    : left.responseOwner === "human" ? -1 : 1), [descendants]);
  const settled = descendantStatus === "ready" || descendantStatus === "idle";

  // The open request. One that was answered, here or elsewhere, gives way to the next in its group
  // after the same place, so a run of requests is answered one after another; with none left in the
  // group the list comes back.
  const lastShown = useRef<{ key: string; index: number; owner: RequestPanelItem["responseOwner"] } | null>(null);
  const selectedIndex = selectedKey === null ? -1 : items.findIndex((item) => item.key === selectedKey);
  let detail = selectedIndex >= 0 ? items[selectedIndex]! : null;
  let replaced = false;
  if (!detail && selectedKey !== null && settled && lastShown.current?.key === selectedKey) {
    const { index, owner } = lastShown.current;
    detail = items.slice(index).find((item) => item.responseOwner === owner) ?? null;
    replaced = detail !== null;
  }
  const detailKey = detail?.key ?? null;
  useEffect(() => {
    // Wait for a settled list: a request may be on its way, or the list may be briefly unavailable.
    if (settled && detailKey !== selectedKey) onSelectedKeyChange(detailKey);
  }, [detailKey, onSelectedKeyChange, selectedKey, settled]);
  useLayoutEffect(() => {
    // A replacement keeps the answered request's place until the selection follows it.
    if (!detail || replaced) return;
    lastShown.current = { key: detail.key, index: items.indexOf(detail), owner: detail.responseOwner };
  });

  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const pendingFocus = useRef<PendingFocus>(null);
  // The row that takes Tab into the list: the last one opened, else the first.
  const [rovingKey, setRovingKey] = useState<string | null>(null);
  const tabStop = items.some((item) => item.key === rovingKey) ? rovingKey : items[0]?.key ?? null;

  // Focus moves with the view: into a request's heading as it opens, back to its row on the list.
  // An answered request's buttons leave with it, and focus that was on them goes to the next
  // request's heading, or to the list.
  const removedFocus = useRemovedFocus(panelRef, "[data-request-card-menu]");
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target?.kind === "heading") headingRef.current?.focus();
    else if (target?.kind === "row") rowRefs.current.get(target.key)?.focus();
    else if (removedFocus()) {
      if (detail) headingRef.current?.focus();
      else if (tabStop) rowRefs.current.get(tabStop)?.focus();
    }
  });

  // The list keeps its place across a visit to a request (§6.2); a detail starts at its top (§6).
  const listShown = settled && !detail && items.length > 0;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!listShown || !list) return;
    list.scrollTop = listScrollPositions.get(session.id) ?? 0;
    return () => { listScrollPositions.set(session.id, list.scrollTop); };
  }, [listShown, session.id]);
  useLayoutEffect(() => {
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [detailKey]);

  // A descendant's view may not have reached the store yet. For a person the answer route applies
  // only the organization role gate, so this session's own verdict stands in for it (#1857).
  const responseRefusal = useSessionResponseRefusal(
    detail?.sessionId ?? session.id,
    sessionCommandRefusal(session, "respond"),
  );
  const groupHeadingId = useId();
  const showSkeleton = useDelayedFlag(descendantStatus === "loading" && items.length === 0, REQUEST_PANEL_SKELETON_DELAY_MS);

  const open = (key: string) => {
    setRovingKey(key);
    pendingFocus.current = { kind: "heading" };
    onSelectedKeyChange(key);
  };
  const backToList = () => {
    if (!detail) return;
    setRovingKey(detail.key);
    pendingFocus.current = { kind: "row", key: detail.key };
    onSelectedKeyChange(null);
  };

  if (descendantStatus === "loading" && items.length === 0) {
    return showSkeleton ? (
      <div ref={panelRef} className="request-panel request-panel-skeleton" role="status" aria-live="polite">
        <span className="sr-only">{REQUEST_PANEL_COPY.loading}</span>
        {Array.from({ length: 4 }, (_, index) => (
          <div className="row row-2" aria-hidden="true" key={index}>
            <span className="row-icon" />
            <span className="row-body">
              <span className="skeleton-bar title" />
              <span className="skeleton-bar" />
            </span>
          </div>
        ))}
      </div>
    ) : null;
  }
  if (descendantStatus === "unavailable" && items.length === 0) {
    return (
      <div ref={panelRef} className="request-panel request-panel-state">
        <State
          variant="error"
          compact
          title={REQUEST_PANEL_COPY.unavailable}
          actions={onRetry && <button type="button" className="btn sm" onClick={onRetry}>{REQUEST_PANEL_COPY.retry}</button>}
        >
          {REQUEST_PANEL_COPY.unavailableBody}
        </State>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div ref={panelRef} className="request-panel request-panel-state">
        <State
          compact
          icon={<InboxIcon size={24} />}
          title={REQUEST_PANEL_COPY.nothingWaiting}
          actions={onOpenDecisionHistory && (
            <button type="button" className="btn sm" onClick={onOpenDecisionHistory}>
              {REQUEST_PANEL_COPY.decisionHistory}
            </button>
          )}
        >
          {REQUEST_PANEL_COPY.nothingWaitingBody}
        </State>
      </div>
    );
  }

  if (detail) {
    const group = items.filter((item) => item.responseOwner === detail.responseOwner);
    const position = group.indexOf(detail);
    const previous = group[position - 1];
    const next = group[position + 1];
    const readOnly = detail.responseOwner === "orchestrator";
    const childHref = viewPath({ name: "session", id: detail.sessionId });
    const openChild = (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onOpenChild(detail.descendant);
    };
    return (
      <div ref={panelRef} className="request-panel" data-view="detail">
        <div className="request-panel-detail-head">
          <div className="request-panel-nav">
            <button type="button" className="btn sm ghost request-panel-back" onClick={backToList}>
              <ChevronLeftIcon size={14} />
              {REQUEST_PANEL_COPY.allRequests}
            </button>
            <span className="request-panel-position" role="status" aria-atomic="true">
              {requestPanelPositionLabel(position + 1, group.length)}
            </span>
            <button
              type="button"
              className="icon-btn sm"
              aria-label={REQUEST_PANEL_COPY.previousRequest}
              title={REQUEST_PANEL_COPY.previousRequest}
              // Still focusable at either end, so a keyboard stepping through keeps its place.
              aria-disabled={!previous || undefined}
              onClick={() => previous && onSelectedKeyChange(previous.key)}
            >
              <ChevronLeftIcon size={14} />
            </button>
            <button
              type="button"
              className="icon-btn sm"
              aria-label={REQUEST_PANEL_COPY.nextRequest}
              title={REQUEST_PANEL_COPY.nextRequest}
              aria-disabled={!next || undefined}
              onClick={() => next && onSelectedKeyChange(next.key)}
            >
              <ChevronRightIcon size={14} />
            </button>
          </div>
          <a className="request-panel-child" href={childHref} onClick={openChild}>{detail.sessionTitle}</a>
        </div>
        <div ref={detailRef} className="request-panel-detail" role="region" aria-label={requestTypeLabel(detail.request)}>
          {!readOnly && detail.request.kind === "question" ? (
            <SessionQuestionBanner
              key={detail.key}
              sessionId={detail.sessionId}
              requestId={detail.request.requestId}
              occurrenceId={detail.request.occurrenceId}
              questions={detail.request.questions ?? []}
              isAsync={detail.request.async}
              recoveryReason={detail.request.recoveryReason}
              recoveryAction={detail.request.recoveryAction}
              runnerOnline={detail.runnerOnline}
              responseRefusal={responseRefusal}
              onSessionUpdate={onDescendantsUpdate}
              showKeyHints={false}
              createdAt={detail.createdAt}
              headingRef={headingRef}
              presentation="panel"
            />
          ) : (
            <RequestCard
              key={detail.key}
              session={{
                ...session,
                id: detail.sessionId,
                title: detail.sessionTitle,
                runnerId: detail.runnerId,
                pendingApproval: detail.request,
              }}
              request={detail.request}
              runnerOnline={detail.runnerOnline}
              presentation="panel"
              createdAt={detail.createdAt}
              headingRef={(node) => { headingRef.current = node; }}
              onSessionUpdate={onDescendantsUpdate}
              readOnlyNotice={readOnly ? REQUEST_PANEL_COPY.orchestratorNotice : undefined}
            />
          )}
        </div>
      </div>
    );
  }

  const groups = (["human", "orchestrator"] as const)
    .map((owner) => ({ owner, items: items.filter((item) => item.responseOwner === owner) }))
    .filter((group) => group.items.length > 0);
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const current = items.findIndex((item) => rowRefs.current.get(item.key) === event.target);
    if (current < 0) return;
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? Math.min(items.length - 1, current + 1) : Math.max(0, current - 1);
    const target = items[nextIndex]!;
    event.preventDefault();
    setRovingKey(target.key);
    rowRefs.current.get(target.key)?.focus();
  };

  return (
    <div ref={panelRef} className="request-panel" data-view="list">
      <div
        ref={listRef}
        className="request-panel-list"
        role="region"
        aria-label={REQUEST_PANEL_COPY.pendingRequests}
        onKeyDown={onListKeyDown}
      >
        {groups.map((group) => {
          const headingId = `${groupHeadingId}-${group.owner}`;
          return (
            <section key={group.owner} className="request-panel-group" aria-labelledby={headingId}>
              <h3 className="request-panel-group-head" id={headingId}>
                {group.owner === "human" ? REQUEST_PANEL_COPY.waitingForYou : REQUEST_PANEL_COPY.orchestratorHandling}
                {group.owner === "human"
                  ? <CountBadge count={group.items.length} />
                  : <span className="request-panel-group-count" aria-hidden="true">{group.items.length}</span>}
              </h3>
              <ul className="request-panel-rows" aria-labelledby={headingId}>
                {group.items.map((item) => (
                  <li key={item.key}>
                    <button
                      ref={(node) => { rowRefs.current.set(item.key, node); }}
                      type="button"
                      className="row row-2 request-panel-row"
                      data-response-owner={item.responseOwner}
                      tabIndex={item.key === tabStop ? 0 : -1}
                      onClick={() => open(item.key)}
                    >
                      <span className="row-icon"><RequestKindIcon request={item.request} /></span>
                      <span className="row-body">
                        <span className="row-line">
                          <span className="row-title">{rowTitle(item.request)}</span>
                          <span className="row-trail" title={relativeTime(item.createdAt)}>
                            {shortRelativeTime(item.createdAt)}
                          </span>
                        </span>
                        <span className="row-sub">{requestTypeLabel(item.request)} in {item.sessionTitle}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function sessionRequestPanelKey(sessionId: string, occurrenceId: string): string {
  return itemKey(sessionId, occurrenceId);
}
