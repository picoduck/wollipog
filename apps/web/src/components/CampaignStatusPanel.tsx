import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type {
  CampaignForgePullRequestObservation,
  CampaignIssueRef,
  CampaignObservedCleanup,
  CampaignObservedFact,
  CampaignObservedSessionStatus,
  CampaignWorkItemSummary,
  SessionHoldView,
  SessionView,
} from "@wollipog/protocol";
import {
  CAMPAIGN_ORIGIN_FILTER_OPTIONS,
  CAMPAIGN_SORT_OPTIONS,
  CAMPAIGN_STATE_FILTER_OPTIONS,
  CAMPAIGN_WORK_STATE_LABELS,
  DEFAULT_CAMPAIGN_WORK_FILTERS,
  REPORTED_STAGE_LABELS,
  RESPONSIBLE_ACTOR_LABELS,
  UNAVAILABLE,
  campaignCostView,
  campaignSummaryView,
  causeNeedsRequests,
  durationMetricView,
  filtersAreDefault,
  issueRefHref,
  issueRefLabel,
  observationUnavailableText,
  stateCauseText,
  workItemOriginLabel,
  workItemTimeView,
  workItemTitle,
  type CampaignCostView,
  type CampaignStatusAvailability,
  type CampaignWorkFilters,
} from "../campaign-status.js";
import { effortLabel, formatRecordedRelativeTime, formatRecordedTimestamp, resolvedModelLabel, titleCaseLabel } from "../format.js";
import { viewPath } from "../navigation.js";
import { statusMeta } from "../status-meta.js";
import { useTimelineClock } from "../timeline-clock.js";
import { sessionAgentLabel } from "./agent-options.js";
import { DetailSkeleton, Skeleton } from "./common.js";
import { ChevronLeftIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { StaleContent } from "./StaleContent.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Select } from "./ui/ChoiceControls.js";
import { useCampaignStatus, type CampaignStatusData } from "./useCampaignStatus.js";

/**
 * What the list remembers while a work item's details replace it, per viewing session: the filters,
 * the open item, the scroll position, and the row that had focus. Module scope, like the Requests
 * list's scroll memory, so it survives the panel body remounting.
 */
interface CampaignListMemory {
  filters: CampaignWorkFilters;
  selectedItemId: string | null;
  scrollTop: number;
  focusItemId: string | null;
}
const listMemory = new Map<string, CampaignListMemory>();

export function forgetCampaignStatusMemory(): void {
  listMemory.clear();
}

type AvailableCampaign = Extract<CampaignStatusAvailability, { kind: "available" }>;

export function CampaignStatusPanel({
  session,
  availability,
  onOpenSession,
  onOpenRequests,
}: {
  session: SessionView;
  availability: Exclude<CampaignStatusAvailability, { kind: "hidden" }>;
  onOpenSession: (sessionId: string) => void;
  onOpenRequests: () => void;
}) {
  if (availability.kind === "unavailable") {
    return (
      <div className="campaign-status">
        <Notice tone="neutral" title="Campaign Status Unavailable" role="status">
          {availability.reason}
        </Notice>
      </div>
    );
  }
  return (
    <AvailableCampaignStatus
      key={session.id}
      session={session}
      availability={availability}
      onOpenSession={onOpenSession}
      onOpenRequests={onOpenRequests}
    />
  );
}

function AvailableCampaignStatus({
  session,
  availability,
  onOpenSession,
  onOpenRequests,
}: {
  session: SessionView;
  availability: AvailableCampaign;
  onOpenSession: (sessionId: string) => void;
  onOpenRequests: () => void;
}) {
  const [memory, setMemoryState] = useState<CampaignListMemory>(() => listMemory.get(session.id) ?? {
    filters: DEFAULT_CAMPAIGN_WORK_FILTERS,
    selectedItemId: null,
    scrollTop: 0,
    // A member starts on its own assignment.
    focusItemId: availability.currentWorkItemId,
  });
  const setMemory = useCallback((patch: Partial<CampaignListMemory>) => {
    setMemoryState((current) => {
      const next = { ...current, ...patch };
      listMemory.set(session.id, next);
      return next;
    });
  }, [session.id]);
  const data = useCampaignStatus({ session, availability, filters: memory.filters, selectedItemId: memory.selectedItemId });
  const now = useTimelineClock(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const returningToList = useRef(false);

  const openItem = (item: CampaignWorkItemSummary) => {
    // Captured on the way out, so Back puts the list exactly where it was.
    setMemory({ selectedItemId: item.id, focusItemId: item.id, scrollTop: scrollRef.current?.scrollTop ?? memory.scrollTop });
  };
  const closeItem = () => {
    returningToList.current = true;
    setMemory({ selectedItemId: null });
  };

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (memory.selectedItemId) {
      if (scroller) scroller.scrollTop = 0;
      detailHeadingRef.current?.focus({ preventScroll: true });
      return;
    }
    if (scroller) scroller.scrollTop = memory.scrollTop;
    if (!returningToList.current) return;
    returningToList.current = false;
    if (memory.focusItemId) rowRefs.current.get(memory.focusItemId)?.focus({ preventScroll: true });
  // Runs on the list/detail swap only; scroll and focus are then the person's.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memory.selectedItemId]);

  const heldChildren = data.summary.campaign?.heldChildren ?? [];
  return (
    <div className="campaign-status" ref={scrollRef}>
      {memory.selectedItemId ? (
        <CampaignWorkItemDetailView
          state={data.detail}
          offline={data.offline}
          headingRef={detailHeadingRef}
          now={now}
          heldChildren={heldChildren}
          isAssignment={availability.currentWorkItemId === memory.selectedItemId}
          onBack={closeItem}
          onRetry={data.retry}
          onOpenSession={onOpenSession}
          onOpenRequests={onOpenRequests}
        />
      ) : (
        <>
          {availability.role === "member" && (
            <p className="campaign-status-context">
              This session works for the campaign run by{" "}
              <SessionLink sessionId={availability.campaignSessionId} onOpen={onOpenSession}>
                {data.summary.campaignTitle || "its Orchestrator"}
              </SessionLink>
              .{availability.currentWorkItemId ? " Its current assignment is highlighted." : " It has no current assignment."}
            </p>
          )}
          {data.offline && <p className="campaign-status-offline" role="status">Reconnecting… Showing the last loaded campaign status.</p>}
          <StaleContent stale={data.offline}>
            <div className="campaign-status-sections">
              <CampaignSummarySection data={data} now={now} />
              <CampaignWorkList
                data={data}
                filters={memory.filters}
                onFiltersChange={(filters) => setMemory({ filters, scrollTop: 0 })}
                focusItemId={memory.focusItemId}
                onFocusItem={(id) => setMemory({ focusItemId: id })}
                currentWorkItemId={availability.currentWorkItemId}
                rowRefs={rowRefs}
                now={now}
                onOpen={openItem}
              />
            </div>
          </StaleContent>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Summary
 * ---------------------------------------------------------------------------------------------- */

function CampaignSummarySection({ data, now }: { data: CampaignStatusData; now: number }) {
  const headingId = useId();
  const { summary } = data;
  if (!summary.summary) {
    if (summary.status === "error") {
      return (
        <State variant="error" title="Couldn't Load Campaign Summary" compact
          actions={<button type="button" className="btn sm" onClick={data.retry}>Retry</button>}>
          {summary.error ?? "The campaign summary could not be loaded."}
        </State>
      );
    }
    return <DetailSkeleton announce="Loading campaign summary…" />;
  }
  const view = campaignSummaryView(summary.summary, summary.campaign, now);
  return (
    <section className="campaign-status-summary" aria-labelledby={headingId}>
      <h3 id={headingId} className="campaign-status-heading">Summary</h3>
      {view.planNotice && (
        <Notice tone="info" title={view.planNotice.title}>
          {view.planNotice.body}
        </Notice>
      )}
      <dl className="facts">
        <div><dt>State</dt><dd>{view.stateLabel}</dd></div>
        <div><dt>Progress</dt><dd>{view.progressText}</dd></div>
        <div>
          <dt>Scope</dt>
          <dd>
            {view.scope.original} Original
            <span className="campaign-status-meta">{view.scope.followUp} Accepted Follow-Up{view.scope.followUp === 1 ? "" : "s"}</span>
          </dd>
        </div>
        <div>
          <dt>Work</dt>
          <dd>
            <ul className="campaign-status-counts" aria-label="Work Items by State">
              {view.stateCounts.map((entry) => (
                <li key={entry.state}><strong>{entry.count}</strong> {entry.label}</li>
              ))}
              {view.withdrawn > 0 && <li><strong>{view.withdrawn}</strong> Canceled or Removed</li>}
            </ul>
          </dd>
        </div>
        <div><dt>Capacity</dt><dd>{view.capacity}</dd></div>
        <div><dt>Elapsed</dt><dd>{view.elapsed}</dd></div>
        <div>
          <dt>Cost</dt>
          <dd>
            <CostText cost={view.cost} />
            {view.costBreakdown.length > 0
              ? <span className="campaign-status-meta">{view.costBreakdown.map((row) => `${row.label} ${row.text}`).join(", ")}</span>
              : view.cost.note && <span className="campaign-status-meta">{view.cost.note}</span>}
          </dd>
        </div>
        {view.budget && <div><dt>Budget</dt><dd>{view.budget}</dd></div>}
        <div>
          <dt>Outstanding</dt>
          <dd>{view.obligations.length === 0 ? "None" : view.obligations.map((entry) => `${entry.count} ${entry.label}`).join(", ")}</dd>
        </div>
        <div>
          <dt>Recommendations</dt>
          <dd>
            {view.recommendations.awaiting} Awaiting Adjudication
            <span className="campaign-status-meta">
              {view.recommendations.rejected} Rejected, {view.recommendations.deferred} Deferred, {view.recommendations.duplicate} Duplicate
            </span>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function CostText({ cost }: { cost: CampaignCostView }) {
  return (
    <span className="campaign-cost">
      {cost.text}
      {cost.provenance && <span className="campaign-status-meta">{cost.provenance}</span>}
    </span>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Work list
 * ---------------------------------------------------------------------------------------------- */

function CampaignWorkList({
  data,
  filters,
  onFiltersChange,
  focusItemId,
  onFocusItem,
  currentWorkItemId,
  rowRefs,
  now,
  onOpen,
}: {
  data: CampaignStatusData;
  filters: CampaignWorkFilters;
  onFiltersChange: (filters: CampaignWorkFilters) => void;
  focusItemId: string | null;
  onFocusItem: (id: string) => void;
  currentWorkItemId: string | null;
  rowRefs: React.RefObject<Map<string, HTMLButtonElement | null>>;
  now: number;
  onOpen: (item: CampaignWorkItemSummary) => void;
}) {
  const headingId = useId();
  const { list } = data;
  const items = list.items;
  // One tab stop for the list: the remembered row when it is still listed, otherwise the first.
  const stopId = items.some((item) => item.id === focusItemId) ? focusItemId : items[0]?.id ?? null;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || items.length === 0) return;
    const current = Math.max(0, items.findIndex((item) => item.id === stopId));
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? Math.min(items.length - 1, current + 1) : Math.max(0, current - 1);
    const next = items[nextIndex]!;
    event.preventDefault();
    onFocusItem(next.id);
    rowRefs.current.get(next.id)?.focus();
  };

  let body: ReactNode;
  if (list.status === "loading" && items.length === 0) {
    body = <Skeleton rows={4} announce="Loading work items…" />;
  } else if (list.status === "error" && items.length === 0) {
    body = (
      <State variant="error" title="Couldn't Load Work Items" compact
        actions={<button type="button" className="btn sm" onClick={data.retry}>Retry</button>}>
        {list.error ?? "The work list could not be loaded."}
      </State>
    );
  } else if (items.length === 0) {
    body = filtersAreDefault(filters) ? (
      <State variant="empty" title="No Unfinished Work" compact
        actions={<button type="button" className="btn sm" onClick={() => onFiltersChange({ ...filters, state: "all" })}>Show All Work</button>}>
        Every recorded work item is finished, or none has been recorded yet.
      </State>
    ) : (
      <State variant="no-results" title="No Matching Work Items" compact
        actions={<button type="button" className="btn sm" onClick={() => onFiltersChange({ ...DEFAULT_CAMPAIGN_WORK_FILTERS, sort: filters.sort })}>Clear Filters</button>}>
        No work items match these filters.
      </State>
    );
  } else {
    body = (
      <>
        {list.error && (
          <Notice tone="danger" compact role="alert" title="Couldn't Refresh Work Items"
            actions={<button type="button" className="btn sm" onClick={data.retry}>Retry</button>}>
            {list.error}
          </Notice>
        )}
        <ul className="campaign-work-list" aria-labelledby={headingId} onKeyDown={onKeyDown}>
          {items.map((item) => (
            <li key={item.id}>
              <CampaignWorkRow
                item={item}
                now={now}
                assignment={item.id === currentWorkItemId}
                tabStop={item.id === stopId}
                rowRef={(node) => { rowRefs.current.set(item.id, node); }}
                onFocus={() => { if (item.id !== stopId) onFocusItem(item.id); }}
                onOpen={() => onOpen(item)}
              />
            </li>
          ))}
        </ul>
        {list.hasMore && (
          <BusyButton className="btn ghost sm campaign-work-more" busy={list.loadingMore} progress="Loading more work items…"
            disabled={list.loadingMore} onClick={data.loadMore}>
            Show More
          </BusyButton>
        )}
      </>
    );
  }

  return (
    <section className="campaign-work" aria-labelledby={headingId}>
      <div className="campaign-work-head">
        <h3 id={headingId} className="campaign-status-heading">Work Items</h3>
        <Select label="Sort" value={filters.sort} options={CAMPAIGN_SORT_OPTIONS}
          onChange={(sort) => onFiltersChange({ ...filters, sort })} />
      </div>
      <div className="campaign-work-filters">
        <Select label="Origin" value={filters.origin} options={CAMPAIGN_ORIGIN_FILTER_OPTIONS}
          onChange={(origin) => onFiltersChange({ ...filters, origin })} />
        <Select label="State" value={filters.state} options={CAMPAIGN_STATE_FILTER_OPTIONS}
          onChange={(state) => onFiltersChange({ ...filters, state })} />
      </div>
      {body}
    </section>
  );
}

function CampaignWorkRow({
  item,
  now,
  assignment,
  tabStop,
  rowRef,
  onFocus,
  onOpen,
}: {
  item: CampaignWorkItemSummary;
  now: number;
  assignment: boolean;
  tabStop: boolean;
  rowRef: (node: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onOpen: () => void;
}) {
  const time = workItemTimeView(item, now);
  const cost = campaignCostView(item.cost);
  return (
    <button
      ref={rowRef}
      type="button"
      className={`campaign-work-row${assignment ? " is-assignment" : ""}`}
      data-state={item.primaryState}
      tabIndex={tabStop ? 0 : -1}
      onFocus={onFocus}
      onClick={onOpen}
    >
      <span className="campaign-work-row-line">
        <span className="campaign-work-row-title">{workItemTitle(item)}</span>
        {assignment && <StatusBadge label="Current Assignment" tone="info" noDot />}
        <StatusBadge meta={statusMeta("campaignWork", item.primaryState)} inline />
      </span>
      <span className="campaign-work-row-line campaign-work-row-meta">
        <span>{workItemOriginLabel(item)}</span>
        {item.issue && item.title && <span>{issueRefLabel(item.issue)}</span>}
        <span className="campaign-work-row-trail">
          <span title={time.label}>{time.text}</span>
          {cost.priced && <span title={cost.provenance ?? "Cost"}>{cost.text}</span>}
        </span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Details
 * ---------------------------------------------------------------------------------------------- */

const END_REASON_LABELS = {
  delivered: "Delivered",
  reassigned: "Reassigned",
  superseded: "Superseded",
  abandoned: "Abandoned",
  failed: "Failed",
} as const;

const PR_STATE_LABELS: Record<CampaignForgePullRequestObservation["state"], string> = { open: "Open", closed: "Closed", merged: "Merged" };
const REVIEW_LABELS: Record<CampaignForgePullRequestObservation["reviewDecision"], string> = {
  approved: "Review Approved",
  changes_requested: "Changes Requested",
  review_required: "Review Required",
  none: "No Review Decision",
};
const CHECK_LABELS: Record<CampaignForgePullRequestObservation["checks"], string> = {
  passing: "Checks Passing",
  failing: "Checks Failing",
  pending: "Checks Pending",
  none: "No Checks",
};

function SessionLink({ sessionId, onOpen, children }: { sessionId: string; onOpen: (sessionId: string) => void; children: ReactNode }) {
  return (
    <a
      href={viewPath({ name: "session", id: sessionId })}
      onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
        // Modified clicks stay ordinary links so a session can open in a new tab.
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onOpen(sessionId);
      }}
    >
      {children}
    </a>
  );
}

function RecordedTime({ at, now, prefix }: { at: number | null; now: number; prefix?: string }) {
  if (at === null) return <>{UNAVAILABLE}</>;
  const stamp = formatRecordedTimestamp(at);
  return (
    <time dateTime={stamp?.dateTime} title={stamp?.title}>
      {prefix ? `${prefix} ` : ""}{formatRecordedRelativeTime(at, now)}
    </time>
  );
}

function IssueLink({ issue, kind }: { issue: CampaignIssueRef; kind: "issues" | "pull" }) {
  const href = issueRefHref(issue, kind);
  const label = issueRefLabel(issue);
  return href ? <a href={href} target="_blank" rel="noreferrer">{label}</a> : <>{label}</>;
}

/** A server observation: its value with how old it is, or why it is missing. Never a guessed value. */
function ObservedValue<T>({ fact, now, render }: { fact: CampaignObservedFact<T> | undefined; now: number; render: (value: T) => ReactNode }) {
  if (!fact) return <>{UNAVAILABLE}<span className="campaign-status-meta">{observationUnavailableText("not_collected")}</span></>;
  if (fact.availability === "unavailable") {
    return <>{UNAVAILABLE}<span className="campaign-status-meta">{observationUnavailableText(fact.reason)}</span></>;
  }
  return (
    <>
      {render(fact.value)}
      <span className="campaign-status-meta">
        {fact.availability === "stale" ? "Stale, " : ""}<RecordedTime at={fact.observedAt} now={now} prefix="Observed" />
      </span>
    </>
  );
}

function sessionStatusText(value: CampaignObservedSessionStatus): string {
  const parts = [titleCaseLabel(value.status.replaceAll("_", " "))];
  if (value.archived) parts.push("Archived");
  if (value.held) parts.push("Held");
  if (value.pendingRequests > 0) parts.push(`${value.pendingRequests} Pending Request${value.pendingRequests === 1 ? "" : "s"}`);
  return parts.join(", ");
}

function cleanupText(value: CampaignObservedCleanup): string {
  if (value.worktrees.length === 0) return "No Worktrees";
  return value.worktrees.map((worktree) => titleCaseLabel(worktree.status)).join(", ");
}

function pullRequestText(value: CampaignForgePullRequestObservation): string {
  const parts = [PR_STATE_LABELS[value.state], CHECK_LABELS[value.checks], REVIEW_LABELS[value.reviewDecision]];
  if (value.mergeQueue) parts.push(value.mergeQueue.position === null ? "In Merge Queue" : `Merge Queue Position ${value.mergeQueue.position}`);
  return parts.join(", ");
}

function CampaignWorkItemDetailView({
  state,
  offline,
  headingRef,
  now,
  heldChildren,
  isAssignment,
  onBack,
  onRetry,
  onOpenSession,
  onOpenRequests,
}: {
  state: CampaignStatusData["detail"];
  offline: boolean;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  now: number;
  heldChildren: readonly { sessionId: string; holds: SessionHoldView[] }[];
  isAssignment: boolean;
  onBack: () => void;
  onRetry: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenRequests: () => void;
}) {
  const detail = state?.detail ?? null;
  // One heading element for loading and loaded alike, at the same place in the tree, so the focus it
  // takes when details open survives the details arriving.
  const head = (
    <>
      <button type="button" className="btn ghost sm campaign-detail-back" onClick={onBack}>
        <ChevronLeftIcon size={14} aria-hidden="true" />
        Back to Work Items
      </button>
      {offline && <p className="campaign-status-offline" role="status">Reconnecting… Showing the last loaded details.</p>}
      <div className="campaign-detail-head">
        <h3 ref={headingRef} tabIndex={-1} className="campaign-detail-title">{detail ? workItemTitle(detail) : "Work Item"}</h3>
        {detail && <StatusBadge meta={statusMeta("campaignWork", detail.primaryState)} />}
        {detail && isAssignment && <StatusBadge label="Current Assignment" tone="info" noDot />}
      </div>
    </>
  );
  if (!detail) {
    return (
      <>
        {head}
        {state?.status === "missing" ? (
          <State variant="empty" title="Work Item Not Found" compact
            actions={<button type="button" className="btn sm" onClick={onBack}>Back to Work Items</button>}>
            This work item is no longer recorded in the campaign.
          </State>
        ) : state?.status === "error" ? (
          <State variant="error" title="Couldn't Load Work Item" compact
            actions={<button type="button" className="btn sm" onClick={onRetry}>Retry</button>}>
            {state.error ?? "The work item could not be loaded."}
          </State>
        ) : (
          <DetailSkeleton announce="Loading work item…" />
        )}
      </>
    );
  }

  const time = workItemTimeView(detail, now);
  const cost = campaignCostView(detail.cost);
  const latestAttempt = detail.attempts.at(-1) ?? null;
  const currentSessionId = detail.currentAttempt?.sessionId ?? null;
  const previousAttempts = detail.attempts.filter((attempt) => attempt.id !== detail.currentAttempt?.id);
  const attemptCost = (attemptId: string) => campaignCostView(detail.attemptCosts?.find((entry) => entry.attemptId === attemptId)?.cost);
  const latestVerification = latestAttempt
    ? detail.verifications.filter((verification) => verification.attemptId === latestAttempt.id).at(-1) ?? null
    : null;
  const held = currentSessionId ? heldChildren.find((child) => child.sessionId === currentSessionId) : undefined;
  const pullRequests = [
    ...(detail.observed.pullRequests?.map((entry) => entry.ref) ?? []),
    ...(detail.stage?.pullRequests ?? []),
  ].filter((pr, index, all) => all.findIndex((other) => other.repository === pr.repository && other.number === pr.number) === index);
  const linksRequests = Boolean(detail.blocker?.requestOccurrenceId) || detail.stateCauses.some(causeNeedsRequests);
  const snapshot = latestAttempt?.session ?? null;

  return (
    <>
      {head}
      <StaleContent stale={offline}>
        <div className="campaign-status-sections">
          {state?.status === "error" && (
            <Notice tone="danger" compact role="alert" title="Couldn't Refresh Work Item"
              actions={<button type="button" className="btn sm" onClick={onRetry}>Retry</button>}>
              {state.error}
            </Notice>
          )}
          {detail.commitment !== "committed" && (
            <Notice tone="neutral" compact title={detail.commitment === "cancelled" ? "Canceled" : "Scope Removed"}>
              {detail.commitmentRecord.reason ?? "No reason was recorded."} This work does not count as delivered.
            </Notice>
          )}

          <DetailSection title="Links">
            <div>
              <dt>Issue</dt>
              <dd>{detail.issue ? <IssueLink issue={detail.issue} kind="issues" />
                : detail.sourceRecommendation?.publication === "awaiting_publication" ? "Awaiting Publication" : "Not Published"}</dd>
            </div>
            <div>
              <dt>Pull Requests</dt>
              <dd>{pullRequests.length === 0 ? "None Recorded" : pullRequests.map((pr, index) => (
                <span key={`${pr.repository}#${pr.number}`}>{index > 0 ? ", " : ""}<IssueLink issue={pr} kind="pull" /></span>
              ))}</dd>
            </div>
            <div>
              <dt>Current Session</dt>
              <dd>{currentSessionId ? (
                <SessionLink sessionId={currentSessionId} onOpen={onOpenSession}>
                  {detail.currentAttempt?.sessionTitle || "Open Session"}
                </SessionLink>
              ) : detail.currentAttempt
                ? <>{detail.currentAttempt.sessionTitle ?? "Session"}<span className="campaign-status-meta">Session Deleted</span></>
                : "None"}</dd>
            </div>
            <div>
              <dt>Previous Attempts</dt>
              <dd>{previousAttempts.length === 0 ? "None" : (
                <ul className="campaign-detail-list">
                  {previousAttempts.map((attempt) => (
                    <li key={attempt.id}>
                      {attempt.sessionId
                        ? <SessionLink sessionId={attempt.sessionId} onOpen={onOpenSession}>{attempt.session.title || `Attempt ${attempt.ordinal}`}</SessionLink>
                        : <>{attempt.session.title || `Attempt ${attempt.ordinal}`}</>}
                      <span className="campaign-status-meta">
                        {attempt.endReason ? END_REASON_LABELS[attempt.endReason] : "Open"}
                        {attempt.sessionId ? "" : ", Session Deleted"}, {attemptCost(attempt.id).text}
                      </span>
                    </li>
                  ))}
                </ul>
              )}</dd>
            </div>
          </DetailSection>

          <DetailSection title="Lineage">
            <div><dt>Origin</dt><dd>{workItemOriginLabel(detail)}</dd></div>
            {detail.sourceRecommendation && (
              <div><dt>Accepted From</dt><dd>{detail.sourceRecommendation.title}</dd></div>
            )}
            <div>
              <dt>Depends On</dt>
              <dd>{detail.dependsOn.length === 0 ? "None" : (
                <ul className="campaign-detail-list">
                  {detail.dependsOn.map((dependency) => (
                    <li key={dependency.id}>
                      {workItemTitle(dependency)}
                      <span className="campaign-status-meta">{CAMPAIGN_WORK_STATE_LABELS[dependency.primaryState]}</span>
                    </li>
                  ))}
                </ul>
              )}</dd>
            </div>
            {detail.recommendations.length > 0 && (
              <div><dt>Recommended Follow-Ups</dt><dd>{detail.recommendations.length}</dd></div>
            )}
          </DetailSection>

          <DetailSection title="Progress">
            <div><dt>Queue Position</dt><dd>{detail.queuePosition === null ? "Not Queued" : detail.queuePosition}</dd></div>
            {detail.stateCauses.length > 0 && (
              <div><dt>Reason</dt><dd>{detail.stateCauses.map(stateCauseText).join(" ")}</dd></div>
            )}
            <div>
              <dt>Blocker</dt>
              <dd>{detail.blocker ? (
                <>
                  {detail.blocker.reason}
                  <span className="campaign-status-meta">Recorded <RecordedTime at={detail.blocker.recordedAt} now={now} /></span>
                </>
              ) : "None Recorded"}</dd>
            </div>
            {held?.holds.map((hold) => (
              <div key={hold.holdId}>
                <dt>Hold</dt>
                <dd>{hold.reason}{hold.recoveryAction && <span className="campaign-status-meta">{hold.recoveryAction}</span>}</dd>
              </div>
            ))}
            <div><dt>Responsible</dt><dd>{detail.blocker ? RESPONSIBLE_ACTOR_LABELS[detail.blocker.responsibleActor] : "None Recorded"}</dd></div>
            <div><dt>Next Action</dt><dd>{detail.nextAction ?? "None Recorded"}</dd></div>
          </DetailSection>
          {(linksRequests || held || detail.primaryState === "blocked") && (
            <div className="campaign-detail-actions">
              {(linksRequests || held) && <button type="button" className="btn sm" onClick={onOpenRequests}>Open Requests</button>}
              {currentSessionId && (
                <button type="button" className="btn ghost sm" onClick={() => onOpenSession(currentSessionId)}>Open Child Session</button>
              )}
            </div>
          )}

          <DetailSection title="Delivery">
            <div>
              <dt>Reported Stage</dt>
              <dd>{detail.stage ? (
                <>
                  {REPORTED_STAGE_LABELS[detail.stage.stage]}
                  <span className="campaign-status-meta">
                    Reported by the Orchestrator <RecordedTime at={detail.stage.reportedAt} now={now} />
                  </span>
                  {detail.stage.note && <span className="campaign-status-note">{detail.stage.note}</span>}
                </>
              ) : "None Reported"}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd><ObservedValue fact={detail.observed.session} now={now} render={sessionStatusText} /></dd>
            </div>
            {detail.observed.pullRequests && detail.observed.pullRequests.length > 0
              ? detail.observed.pullRequests.map((entry) => (
                <div key={`${entry.ref.repository}#${entry.ref.number}`}>
                  <dt>PR #{entry.ref.number}</dt>
                  <dd><ObservedValue fact={entry.fact} now={now} render={pullRequestText} /></dd>
                </div>
              ))
              : (
                <div>
                  <dt>Review and Checks</dt>
                  <dd><ObservedValue fact={undefined} now={now} render={() => null} /></dd>
                </div>
              )}
            <div>
              <dt>Verification</dt>
              <dd>{latestVerification ? (
                <>
                  {latestVerification.outcome === "delivered" ? "Verified Delivered" : "Verified Incomplete"}
                  <span className="campaign-status-meta"><RecordedTime at={latestVerification.verifiedAt} now={now} /></span>
                </>
              ) : "Not Verified"}</dd>
            </div>
            <div>
              <dt>Cleanup</dt>
              <dd><ObservedValue fact={detail.observed.cleanup} now={now} render={cleanupText} /></dd>
            </div>
          </DetailSection>

          <DetailSection title="Time and Cost">
            <div><dt>Item {time.label}</dt><dd>{time.text}</dd></div>
            <MetricFact label="Queue Time" view={durationMetricView(detail.times?.queue)} />
            <MetricFact label="Waiting Time" view={durationMetricView(detail.times?.waiting)} />
            <MetricFact label="Active Time" view={durationMetricView(detail.times?.active)} />
            <div><dt>Recorded</dt><dd><RecordedTime at={detail.createdAt} now={now} /></dd></div>
            <div><dt>Started</dt><dd>{detail.elapsed.startedAt === null ? "Not Started" : <RecordedTime at={detail.elapsed.startedAt} now={now} />}</dd></div>
            {detail.elapsed.endedAt !== null && <div><dt>Finished</dt><dd><RecordedTime at={detail.elapsed.endedAt} now={now} /></dd></div>}
            <div><dt>Cost</dt><dd><CostText cost={cost} />{cost.note && <span className="campaign-status-note">{cost.note}</span>}</dd></div>
          </DetailSection>

          <DetailSection title="Execution">
            <div>
              <dt>Harness</dt>
              <dd>{snapshot?.harness
                ? sessionAgentLabel(snapshot.agentName, snapshot.harness.driver, snapshot.harness.agentId)
                : snapshot?.agentName ?? UNAVAILABLE}</dd>
            </div>
            <div><dt>Model</dt><dd>{snapshot?.model ? resolvedModelLabel(snapshot.model) : UNAVAILABLE}</dd></div>
            <div><dt>Effort</dt><dd>{snapshot?.effort ? effortLabel(snapshot.effort) : UNAVAILABLE}</dd></div>
          </DetailSection>
        </div>
      </StaleContent>
    </>
  );
}

function MetricFact({ label, view }: { label: string; view: { text: string; note: string | null } }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{view.text}{view.note && <span className="campaign-status-meta">{view.note}</span>}</dd>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="campaign-detail-section" aria-labelledby={headingId}>
      <h4 id={headingId} className="campaign-status-heading">{title}</h4>
      <dl className="facts">{children}</dl>
    </section>
  );
}
