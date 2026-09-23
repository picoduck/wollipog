import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  type DescendantRequestView,
  type PendingApproval,
  type SessionView,
  type WorkflowDecisionResourceSnapshot,
} from "@wollipog/protocol";
import { relativeTime } from "../format.js";
import {
  SessionApprovalBanner,
  SessionQuestionBanner,
  standaloneApprovalForReview,
} from "./SessionApproval.js";

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
  descendant: boolean;
};

export type DescendantRequestStatus = "idle" | "loading" | "ready" | "unavailable";

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
    if (category === "follow_up_issue_publication") return "Issue Publication";
    if (category === "implementation_question") return "Implementation Decision";
    return "Workflow Decision";
  }
  return "Approval";
}

function workflowSummary(snapshot: WorkflowDecisionResourceSnapshot) {
  switch (snapshot.category) {
    case "implementation_question":
      return <>
        <p>{snapshot.question}</p>
        <ul>{snapshot.options.map((option) => <li key={option.optionId}>{option.label}</li>)}</ul>
      </>;
    case "pr_merge":
      return <dl>
        <div><dt>Repository</dt><dd>{snapshot.repository}</dd></div>
        <div><dt>Pull Request</dt><dd>#{snapshot.pullRequest}</dd></div>
        <div><dt>Head Commit</dt><dd><code>{snapshot.headSha.slice(0, 12)}</code></dd></div>
      </dl>;
    case "merged_branch_deletion":
      return <dl>
        <div><dt>Repository</dt><dd>{snapshot.repository}</dd></div>
        <div><dt>Branch</dt><dd><code>{snapshot.branch}</code></dd></div>
        <div><dt>Merge Commit</dt><dd><code>{snapshot.mergeCommitSha.slice(0, 12)}</code></dd></div>
      </dl>;
    case "follow_up_issue_publication":
      return <dl>
        <div><dt>Repository</dt><dd>{snapshot.repository}</dd></div>
        <div><dt>Issue Title</dt><dd>{snapshot.sanitizedTitle}</dd></div>
        <div><dt>Labels</dt><dd>{snapshot.labels.join(", ") || "None"}</dd></div>
      </dl>;
    case "ui_evidence_approval":
      return <p>{snapshot.evidence.length} evidence {snapshot.evidence.length === 1 ? "item" : "items"} awaiting human review.</p>;
  }
}

export function SessionRequestPanel({
  session,
  runnerOnline,
  descendants,
  descendantStatus = "ready",
  selectedKey,
  onSelectedKeyChange,
  onSessionUpdate,
  onDescendantsUpdate,
  onOpenChild,
}: {
  session: SessionView;
  runnerOnline: boolean;
  descendants: readonly DescendantRequestView[];
  descendantStatus?: DescendantRequestStatus;
  selectedKey: string | null;
  onSelectedKeyChange: (key: string | null) => void;
  onSessionUpdate: (session: SessionView) => void;
  onDescendantsUpdate: () => void;
  onOpenChild: (request: DescendantRequestView) => void;
}) {
  const ownRequest = standaloneApprovalForReview(session.pendingApproval);
  const ownDecision = ownRequest?.kind === "workflow_decision" ? ownRequest.workflowDecision : null;
  const ownOccurrenceId = ownRequest?.occurrenceId ?? ownRequest?.requestId;
  const items = useMemo<RequestPanelItem[]>(() => [
    ...(ownRequest && ownOccurrenceId ? [{
      key: itemKey(session.id, ownOccurrenceId),
      sessionId: session.id,
      sessionTitle: session.title,
      runnerId: session.runnerId,
      runnerOnline,
      eventEpoch: session.eventEpoch ?? 0,
      createdAt: ownDecision?.createdAt ?? session.updatedAt,
      responseOwner: "human" as const,
      occurrenceId: ownOccurrenceId,
      request: ownRequest,
      descendant: false,
    }] : []),
    ...descendants.map((item) => ({
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
      descendant: true,
    })),
  ].sort((left, right) => left.responseOwner === right.responseOwner
    ? 0
    : left.responseOwner === "human" ? -1 : 1), [descendants, ownDecision?.createdAt, ownOccurrenceId,
      ownRequest, runnerOnline, session]);
  const activeKey = items.some((item) => item.key === selectedKey) ? selectedKey : items[0]?.key ?? null;
  const selected = items.find((item) => item.key === activeKey) ?? null;
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement | null>());

  useEffect(() => {
    if (activeKey !== selectedKey) onSelectedKeyChange(activeKey);
  }, [activeKey, onSelectedKeyChange, selectedKey]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = listScrollPositions.get(session.id) ?? 0;
    return () => { listScrollPositions.set(session.id, list.scrollTop); };
  }, [session.id]);

  const selectItem = (key: string, focusDetail = false) => {
    onSelectedKeyChange(key);
    if (focusDetail) window.requestAnimationFrame(() => detailHeadingRef.current?.focus());
  };
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const current = Math.max(0, items.findIndex((item) => item.key === activeKey));
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? Math.min(items.length - 1, current + 1) : Math.max(0, current - 1);
    const next = items[nextIndex];
    if (!next) return;
    event.preventDefault();
    onSelectedKeyChange(next.key);
    rowRefs.current.get(next.key)?.focus();
  };

  if (!selected) {
    if (descendantStatus === "loading") {
      return <div className="request-panel-empty" role="status">
        <h3>Loading Requests</h3>
        <p>Checking for pending requests from descendant sessions.</p>
      </div>;
    }
    if (descendantStatus === "unavailable") {
      return <div className="request-panel-empty" role="status">
        <h3>Requests Unavailable</h3>
        <p>Pending requests cannot be verified right now. Wollipog will retry automatically.</p>
      </div>;
    }
    return <div className="request-panel-empty">
      <h3>No Pending Requests</h3>
      <p>Resolved, replaced, expired, and revoked requests leave this inbox automatically.</p>
    </div>;
  }
  const selectedDescendant = selected.descendant
    ? descendants.find((item) => item.sessionId === selected.sessionId && item.occurrenceId === selected.occurrenceId)
    : null;
  const workflowDecision = selected.request.kind === "workflow_decision"
    ? selected.request.workflowDecision : null;
  const showList = items.length > 1 || descendants.length > 0;
  const counts = descendantRequestCounts(items);

  return (
    <div className={`request-panel${showList ? "" : " request-panel-single"}`}>
      {showList && <div
        className="request-panel-list"
        id={listId}
        ref={listRef}
        aria-label="Pending Requests"
        onKeyDown={onListKeyDown}
      >
        <div className="request-panel-count">
          <span>Needs Your Input <strong>{counts.human}</strong></span>
          <span>Orchestrator Action <strong>{counts.orchestrator}</strong></span>
        </div>
        {items.map((item, index) => (
          <Fragment key={item.key}>
            {(index === 0 || items[index - 1]?.responseOwner !== item.responseOwner) && (
              <div className="request-panel-owner-group" aria-hidden="true">
                {item.responseOwner === "human" ? "Needs Your Input" : "Orchestrator Action"}
              </div>
            )}
            <button
              ref={(node) => { rowRefs.current.set(item.key, node); }}
              type="button"
              className={`request-panel-row${item.key === activeKey ? " selected" : ""}`}
              aria-current={item.key === activeKey ? "true" : undefined}
              tabIndex={item.key === activeKey ? 0 : -1}
              onClick={() => selectItem(item.key)}
              onDoubleClick={() => selectItem(item.key, true)}
            >
              <span className="request-panel-row-title">{item.sessionTitle}</span>
              <span>{requestTypeLabel(item.request)} · Pending</span>
              <span>{relativeTime(item.createdAt)} · {item.responseOwner === "human" ? "Human" : "Orchestrator"}</span>
            </button>
          </Fragment>
        ))}
      </div>}
      <section className="request-panel-detail" aria-label="Selected Request">
        <div className="request-panel-detail-head">
          <div>
            <h3 ref={detailHeadingRef} tabIndex={-1}>{selected.sessionTitle}</h3>
            <p>{requestTypeLabel(selected.request)} · Pending · {relativeTime(selected.createdAt)}</p>
          </div>
          {selectedDescendant && (
            <button className="btn ghost sm" type="button" onClick={() => onOpenChild(selectedDescendant)}>
              Open Child Session
            </button>
          )}
        </div>
        <div className="request-owner" data-response-owner={selected.responseOwner}>
          {selected.responseOwner === "human"
            ? "Assigned to Human"
            : "Assigned to Orchestrator"}
        </div>
        {selected.responseOwner === "orchestrator" ? (
          <div className="request-readonly">
            <p>The Orchestrator owns this decision and must respond through its session-management tools.</p>
            {workflowDecision && (
              <div className="request-structured-summary">
                {workflowSummary(workflowDecision.resourceSnapshot)}
              </div>
            )}
          </div>
        ) : selected.request.kind === "question" ? (
          <SessionQuestionBanner
            key={selected.key}
            sessionId={selected.sessionId}
            requestId={selected.request.requestId}
            questions={selected.request.questions ?? []}
            isAsync={selected.request.async}
            recoveryReason={selected.request.recoveryReason}
            recoveryAction={selected.request.recoveryAction}
            runnerOnline={selected.runnerOnline}
            onSessionUpdate={selected.descendant ? onDescendantsUpdate : onSessionUpdate}
            showKeyHints={false}
          />
        ) : (
          <SessionApprovalBanner
            key={selected.key}
            session={{
              ...session,
              id: selected.sessionId,
              title: selected.sessionTitle,
              runnerId: selected.runnerId,
              pendingApproval: selected.request,
            }}
            runnerOnline={selected.runnerOnline}
            onSessionUpdate={selected.descendant ? onDescendantsUpdate : onSessionUpdate}
            showKeyHints={false}
            presentation="review"
          />
        )}
      </section>
    </div>
  );
}

export function sessionRequestPanelKey(sessionId: string, occurrenceId: string): string {
  return itemKey(sessionId, occurrenceId);
}
