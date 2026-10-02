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
import type { SessionHoldView, SessionView } from "@wollipog/protocol";
import {
  CAMPAIGN_ORIGIN_FILTER_OPTIONS,
  CAMPAIGN_SORT_OPTIONS,
  CAMPAIGN_STATE_FILTER_OPTIONS,
  CAMPAIGN_WORK_STATE_LABELS,
  DEFAULT_CAMPAIGN_WORK_FILTERS,
  UNAVAILABLE,
  campaignCostView,
  campaignSummaryView,
  filtersAreDefault,
  issueRefHref,
  issueRefLabel,
  measuredDuration,
  workItemOriginLabel,
  workItemTimeView,
  workItemTitle,
  type CampaignStatusAvailability,
  type CampaignWorkFilters,
} from "../campaign-status.js";
import type {
  CampaignIssueRef,
  CampaignObservedFact,
  CampaignReportedStageKind,
  CampaignWorkItem,
  CampaignWorkItemDetail,
} from "../campaign-work-contract.js";
import { effortLabel, formatRecordedRelativeTime, formatRecordedTimestamp, resolvedModelLabel } from "../format.js";
import { viewPath } from "../navigation.js";
import { statusMeta } from "../status-meta.js";
import { useTimelineClock } from "../timeline-clock.js";
import { DetailSkeleton, Skeleton } from "./common.js";
import { ChevronLeftIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { StaleContent } from "./StaleContent.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { Select } from "./ui/ChoiceControls.js";
import { useCampaignStatus, type CampaignStatusData } from "./useCampaignStatus.js";

/**
 * What the list remembers while a work item's details replace it, per viewing session: the filters,
 * the scroll position, and the row that had focus. Module scope, like the Requests list's scroll
 * memory, so it survives the panel body remounting.
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

function initialMemory(sessionId: string, currentWorkItemId: string | null): CampaignListMemory {
  return listMemory.get(sessionId)
    ?? { filters: DEFAULT_CAMPAIGN_WORK_FILTERS, selectedItemId: null, scrollTop: 0, focusItemId: currentWorkItemId };
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
  const [memory, setMemoryState] = useState(() => initialMemory(session.id, availability.currentWorkItemId));
  const setMemory = useCallback((patch: Partial<CampaignListMemory>) => {
    setMemoryState((current) => {
      const next = { ...current, ...patch };
      listMemory.set(session.id, next);
      return next;
    });
  }, [session.id]);
  const data = useCampaignStatus({
    session,
    availability,
    filters: memory.filters,
    selectedItemId: memory.selectedItemId,
  });
  const now = useTimelineClock(true);
  const listRef = useRef<HTMLDivElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const pendingListRestore = useRef(false);

  const openItem = (item: CampaignWorkItem) => {
    // Captured on the way out, so Back puts the list exactly where it was.
    setMemory({ selectedItemId: item.id, focusItemId: item.id, scrollTop: listRef.current?.scrollTop ?? memory.scrollTop });
  };
  const closeItem = () => {
    pendingListRestore.current = true;
    setMemory({ selectedItemId: null });
  };

  useLayoutEffect(() => {
    if (memory.selectedItemId) {
      detailHeadingRef.current?.focus();
      return;
    }
    const list = listRef.current;
    if (list) list.scrollTop = memory.scrollTop;
    if (!pendingListRestore.current) return;
    pendingListRestore.current = false;
    const row = memory.focusItemId ? rowRefs.current.get(memory.focusItemId) : null;
    row?.focus({ preventScroll: true });
  // Runs on the list/detail swap only; scroll and focus are then the person's.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memory.selectedItemId]);

  if (memory.selectedItemId) {
    return (
      <div className="campaign-status">
        <CampaignWorkItemDetailView
          state={data.detail}
          offline={data.offline}
          headingRef={detailHeadingRef}
          now={now}
          heldChildren={availability.role === "campaign" ? session.orchestratorCampaign?.heldChildren ?? [] : []}
          isAssignment={availability.currentWorkItemId === memory.selectedItemId}
          onBack={closeItem}
          onRetry={data.retry}
          onOpenSession={onOpenSession}
          onOpenRequests={onOpenRequests}
        />
      </div>
    );
  }

  return (
    <div className="campaign-status" ref={listRef}>
      {availability.role === "member" && (
        <p className="campaign-status-context">
          This session works for the campaign run by{" "}
          <SessionLink sessionId={availability.campaignSessionId} onOpen={onOpenSession}>
            {data.summary.campaign?.title || "its Orchestrator"}
          </SessionLink>
          .{availability.currentWorkItemId ? " Its current assignment is highlighted." : " It has no current assignment."}
        </p>
      )}
      {data.offline && <p className="campaign-status-offline" role="status">Reconnecting… Showing the last loaded campaign status.</p>}
      <StaleContent stale={data.offline}>
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
      </StaleContent>
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
        <Notice tone="info" title={view.planNotice.title} compact>
          {view.planNotice.body}
        </Notice>
      )}
      <dl className="facts">
        <div><dt>State</dt><dd>{view.stateLabel}</dd></div>
        <div><dt>Progress</dt><dd>{view.progress.text}</dd></div>
        <div>
          <dt>Scope</dt>
          <dd>{view.scope.original} Original<span className="campaign-status-meta">{view.scope.followUp} Accepted Follow-Up{view.scope.followUp === 1 ? "" : "s"}</span></dd>
        </div>
        <div>
          <dt>Work</dt>
          <dd>
            <ul className="campaign-status-counts" aria-label="Work Items by State">
              {view.stateCounts.map((entry) => (
                <li key={entry.state} data-state={entry.state}><strong>{entry.count}</strong> {entry.label}</li>
              ))}
              {view.withdrawn > 0 && <li data-state="withdrawn"><strong>{view.withdrawn}</strong> Canceled or Removed</li>}
            </ul>
          </dd>
        </div>
        <div><dt>Capacity</dt><dd>{view.capacity}</dd></div>
        <div><dt>Elapsed</dt><dd>{view.elapsed}</dd></div>
        <div>
          <dt>Cost</dt>
          <dd>
            <CostText cost={view.cost} />
            {view.costBreakdown.length > 0 && (
              <span className="campaign-status-meta">
                {view.costBreakdown.map((row) => `${row.label} ${row.text}`).join(", ")}
              </span>
            )}
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

function CostText({ cost }: { cost: ReturnType<typeof campaignCostView> }) {
  return (
    <span className="campaign-cost" data-priced={cost.priced || undefined} title={cost.note ?? undefined}>
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
  onOpen: (item: CampaignWorkItem) => void;
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
        Every recorded work item is finished, or the Orchestrator has not recorded any yet.
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
          <button type="button" className="btn ghost sm campaign-work-more" disabled={list.loadingMore} onClick={data.loadMore}>
            {list.loadingMore ? "Loading…" : "Show More"}
          </button>
        )}
      </>
    );
  }

  return (
    <section className="campaign-work" aria-labelledby={headingId}>
      <h3 id={headingId} className="campaign-status-heading">Work Items</h3>
      <div className="campaign-work-filters">
        <Select
          label="Origin"
          value={filters.origin}
          options={CAMPAIGN_ORIGIN_FILTER_OPTIONS}
          onChange={(origin) => onFiltersChange({ ...filters, origin })}
          className="sm"
        />
        <Select
          label="State"
          value={filters.state}
          options={CAMPAIGN_STATE_FILTER_OPTIONS}
          onChange={(state) => onFiltersChange({ ...filters, state })}
          className="sm"
        />
        <Select
          label="Sort"
          value={filters.sort}
          options={CAMPAIGN_SORT_OPTIONS}
          onChange={(sort) => onFiltersChange({ ...filters, sort })}
          className="sm"
        />
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
  item: CampaignWorkItem;
  now: number;
  assignment: boolean;
  tabStop: boolean;
  rowRef: (node: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onOpen: () => void;
}) {
  const title = workItemTitle(item);
  const time = workItemTimeView(item, now);
  const cost = campaignCostView(item.cost);
  return (
    <button
      ref={rowRef}
      type="button"
      className={`campaign-work-row${assignment ? " is-assignment" : ""}`}
      data-state={item.state}
      tabIndex={tabStop ? 0 : -1}
      onFocus={onFocus}
      onClick={onOpen}
    >
      <span className="campaign-work-row-line">
        <span className="campaign-work-row-title">{title}</span>
        <StatusBadge meta={statusMeta("campaignWork", item.state)} inline />
      </span>
      <span className="campaign-work-row-line campaign-work-row-meta">
        <span>{workItemOriginLabel(item)}</span>
        {item.issue && item.title && <span>{issueRefLabel(item.issue)}</span>}
        {assignment && <StatusBadge label="Current Assignment" tone="info" noDot />}
        <span className="campaign-work-row-trail">
          <span aria-label={`${time.label} ${time.text}`}>{time.text}</span>
          {cost.priced && <span aria-label={`Cost ${cost.text}`}>{cost.text}</span>}
        </span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Details
 * ---------------------------------------------------------------------------------------------- */

const STAGE_LABELS: Record<CampaignReportedStageKind, string> = {
  implementing: "Implementing",
  in_review: "In Review",
  awaiting_checks: "Awaiting Checks",
  awaiting_approval: "Awaiting Approval",
  merge_queued: "Merge Queued",
  merged: "Merged",
  cleanup: "Cleanup",
};

const OBSERVED_LABELS: Record<CampaignObservedFact["kind"], string> = {
  session_status: "Session Status",
  pull_request: "Pull Request",
  review: "Review",
  checks: "Checks",
  merge_queue: "Merge Queue",
};

const END_REASON_LABELS = {
  delivered: "Delivered",
  reassigned: "Reassigned",
  superseded: "Superseded",
  abandoned: "Abandoned",
  failed: "Failed",
} as const;

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

function ObservedFactValue({ fact, now }: { fact: CampaignObservedFact; now: number }) {
  if (fact.freshness.state === "unavailable") {
    // Unavailable forge data never reads as passing: no value, just why it is missing.
    return <>{UNAVAILABLE}<span className="campaign-status-meta">{fact.freshness.reason}</span></>;
  }
  return (
    <>
      {fact.value}
      <span className="campaign-status-meta">
        {fact.freshness.state === "stale" ? "Stale, " : ""}
        <RecordedTime at={fact.observedAt} now={now} prefix="Observed" />
      </span>
    </>
  );
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
  const back = (
    <button type="button" className="btn ghost sm campaign-detail-back" onClick={onBack}>
      <ChevronLeftIcon size={14} aria-hidden="true" />
      Back to Work Items
    </button>
  );
  // One heading element for loading and loaded alike, at the same place in the tree, so the focus it
  // takes when details open survives the details arriving.
  const offlineLine = offline && <p className="campaign-status-offline" role="status">Reconnecting… Showing the last loaded details.</p>;
  const head = (
    <div className="campaign-detail-head">
      <h3 ref={headingRef} tabIndex={-1} className="campaign-detail-title">{detail ? workItemTitle(detail) : "Work Item"}</h3>
      {detail && <StatusBadge meta={statusMeta("campaignWork", detail.state)} />}
      {detail && isAssignment && <StatusBadge label="Current Assignment" tone="info" noDot />}
    </div>
  );
  if (!detail) {
    return (
      <>
        {back}
        {offlineLine}
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
  const previousAttempts = detail.attempts.filter((attempt) => attempt.sessionId !== detail.currentSessionId || attempt.endedAt !== null);
  const held = detail.currentSessionId ? heldChildren.find((child) => child.sessionId === detail.currentSessionId) : undefined;
  const needsAction = detail.state === "blocked" || detail.state === "waiting";

  return (
    <>
      {back}
      {offlineLine}
      {head}
      <StaleContent stale={offline}>
        {state?.status === "error" && (
          <Notice tone="danger" compact role="alert" title="Couldn't Refresh Work Item"
            actions={<button type="button" className="btn sm" onClick={onRetry}>Retry</button>}>
            {state.error}
          </Notice>
        )}
        {detail.commitment.state !== "committed" && (
          <Notice tone="neutral" compact title={detail.commitment.state === "cancelled" ? "Canceled" : "Scope Removed"}>
            {detail.commitment.reason ?? "No reason was recorded."} This work does not count as delivered.
          </Notice>
        )}

        <DetailSection title="Links">
          <div><dt>Issue</dt><dd>{detail.issue ? <IssueLink issue={detail.issue} kind="issues" /> : "Not Published"}</dd></div>
          <div>
            <dt>Pull Requests</dt>
            <dd>{detail.pullRequests.length === 0 ? "None Recorded" : detail.pullRequests.map((pr, index) => (
              <span key={`${pr.repository}#${pr.number}`}>{index > 0 ? ", " : ""}<IssueLink issue={pr} kind="pull" /></span>
            ))}</dd>
          </div>
          <div>
            <dt>Current Session</dt>
            <dd>{detail.currentSessionId ? (
              <SessionLink sessionId={detail.currentSessionId} onOpen={onOpenSession}>
                {latestAttempt?.sessionId === detail.currentSessionId ? latestAttempt.sessionTitle : "Open Session"}
              </SessionLink>
            ) : "None"}</dd>
          </div>
          <div>
            <dt>Previous Attempts</dt>
            <dd>{previousAttempts.length === 0 ? "None" : (
              <ul className="campaign-detail-attempts">
                {previousAttempts.map((attempt) => (
                  <li key={attempt.id}>
                    {attempt.sessionId ? (
                      <SessionLink sessionId={attempt.sessionId} onOpen={onOpenSession}>{attempt.sessionTitle}</SessionLink>
                    ) : <span>{attempt.sessionTitle}<span className="campaign-status-meta">Session Deleted</span></span>}
                    <span className="campaign-status-meta">
                      {attempt.endReason ? END_REASON_LABELS[attempt.endReason] : "Open"}, {campaignCostView(attempt.cost).text}
                    </span>
                  </li>
                ))}
              </ul>
            )}</dd>
          </div>
        </DetailSection>

        <DetailSection title="Lineage">
          <div><dt>Origin</dt><dd>{workItemOriginLabel(detail)}</dd></div>
          {detail.originWorkItems.length > 0 && (
            <div><dt>Recommended By</dt><dd>{detail.originWorkItems.map((origin) => workItemTitle({ ...origin, key: origin.id })).join(", ")}</dd></div>
          )}
          <div>
            <dt>Depends On</dt>
            <dd>{detail.dependsOn.length === 0 ? "None" : (
              <ul className="campaign-detail-dependencies">
                {detail.dependsOn.map((dependency) => (
                  <li key={dependency.id}>
                    {workItemTitle({ ...dependency, key: dependency.id })}
                    <span className="campaign-status-meta">{CAMPAIGN_WORK_STATE_LABELS[dependency.state]}</span>
                  </li>
                ))}
              </ul>
            )}</dd>
          </div>
        </DetailSection>

        <DetailSection title="Progress">
          <div><dt>Queue Position</dt><dd>{detail.queuePosition === null ? "Not Queued" : detail.queuePosition}</dd></div>
          <div><dt>Blocker</dt><dd>{detail.blocker ?? "None Recorded"}</dd></div>
          {held?.holds.map((hold) => (
            <div key={hold.holdId}>
              <dt>Held</dt>
              <dd>{hold.reason}{hold.recoveryAction && <span className="campaign-status-meta">{hold.recoveryAction}</span>}</dd>
            </div>
          ))}
          <div><dt>Responsible</dt><dd>{detail.responsibleActor ?? UNAVAILABLE}</dd></div>
          <div><dt>Next Action</dt><dd>{detail.nextAction ?? UNAVAILABLE}</dd></div>
        </DetailSection>
        {(needsAction || held) && (
          <div className="campaign-detail-actions">
            <button type="button" className="btn sm" onClick={onOpenRequests}>Open Requests</button>
            {detail.currentSessionId && (
              <button type="button" className="btn ghost sm" onClick={() => onOpenSession(detail.currentSessionId!)}>Open Child Session</button>
            )}
          </div>
        )}

        <DetailSection title="Delivery">
          <div>
            <dt>Reported Stage</dt>
            <dd>{detail.reportedStage ? (
              <>
                {STAGE_LABELS[detail.reportedStage.stage]}
                <span className="campaign-status-meta">
                  Reported by the Orchestrator <RecordedTime at={detail.reportedStage.reportedAt} now={now} />
                </span>
                {detail.reportedStage.note && <span className="campaign-status-note">{detail.reportedStage.note}</span>}
              </>
            ) : "None Reported"}</dd>
          </div>
          {detail.observed.map((fact) => (
            <div key={fact.kind}>
              <dt>{OBSERVED_LABELS[fact.kind]}</dt>
              <dd><ObservedFactValue fact={fact} now={now} /></dd>
            </div>
          ))}
          {!detail.observed.some((fact) => fact.kind === "checks") && (
            <div><dt>Checks</dt><dd>{UNAVAILABLE}<span className="campaign-status-meta">Not observed by this server.</span></dd></div>
          )}
          <div>
            <dt>Verification</dt>
            <dd>{detail.verification ? (
              <>
                {detail.verification.outcome === "delivered" ? "Verified Delivered" : "Verified Incomplete"}
                <span className="campaign-status-meta"><RecordedTime at={detail.verification.verifiedAt} now={now} /></span>
              </>
            ) : "Not Verified"}</dd>
          </div>
        </DetailSection>

        <DetailSection title="Time and Cost">
          <div><dt>Item {time.label}</dt><dd>{time.text}</dd></div>
          <div><dt>Queue Time</dt><dd>{measuredDuration(detail.time.queueMs)}</dd></div>
          <div><dt>Waiting Time</dt><dd>{measuredDuration(detail.time.waitingMs)}</dd></div>
          <div><dt>Active Time</dt><dd>{measuredDuration(detail.time.activeMs)}</dd></div>
          <div><dt>Recorded</dt><dd><RecordedTime at={detail.recordedAt} now={now} /></dd></div>
          <div><dt>Started</dt><dd>{detail.startedAt === null ? "Not Started" : <RecordedTime at={detail.startedAt} now={now} />}</dd></div>
          {detail.endedAt !== null && <div><dt>Finished</dt><dd><RecordedTime at={detail.endedAt} now={now} /></dd></div>}
          <div><dt>Cost</dt><dd><CostText cost={cost} />{cost.note && <span className="campaign-status-note">{cost.note}</span>}</dd></div>
        </DetailSection>

        <DetailSection title="Execution">
          <div><dt>Harness</dt><dd>{latestAttempt?.harness ?? UNAVAILABLE}</dd></div>
          <div><dt>Model</dt><dd>{latestAttempt?.model ? resolvedModelLabel(latestAttempt.model) : UNAVAILABLE}</dd></div>
          <div><dt>Effort</dt><dd>{latestAttempt?.effort ? effortLabel(latestAttempt.effort) : UNAVAILABLE}</dd></div>
        </DetailSection>
      </StaleContent>
    </>
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
