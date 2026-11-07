import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type {
  CampaignForgeChangeRequestObservation,
  CampaignIssueRef,
  CampaignObservedCleanup,
  CampaignObservedFact,
  CampaignObservedSessionStatus,
  CampaignPullRequestRef,
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
  campaignRecoveryAutomationNotice,
  campaignSummaryView,
  costWithProvenance,
  causeNeedsRequests,
  durationMetricView,
  filtersAreDefault,
  campaignRepositoryFilterOptions,
  groupCampaignWorkByRepository,
  heldOnPullRequest,
  mergeDependencyLine,
  repositoryCountsLabel,
  WAITING_FOR_PREREQUISITE_MERGE,
  type CampaignWorkRepositoryGroup,
  issueRefHref,
  forgePullRequestView,
  issueRefLabel,
  observationUnavailableText,
  pullRequestShortLabel,
  stateCauseText,
  timeAgo,
  workItemOriginLabel,
  workItemTimeView,
  workItemTitle,
  type CampaignCostView,
  type CampaignStatusAvailability,
  type CampaignWorkFilters,
} from "../campaign-status.js";
import { effortLabel, formatRecordedTimestamp, resolvedModelLabel, titleCaseLabel } from "../format.js";
import { viewPath } from "../navigation.js";
import { statusMeta, type StatusMeta } from "../status-meta.js";
import { useTimelineClock } from "../timeline-clock.js";
import { sessionAgentLabel } from "./agent-options.js";
import { DetailSkeleton, Skeleton } from "./common.js";
import { ChevronLeftIcon } from "./Icons.js";
import { CampaignIssueScopePanel } from "./CampaignIssueScopePanel.js";
import { CampaignAuthoritySummary } from "./CampaignAuthoritySummary.js";
import { CampaignFollowUpLimit } from "./CampaignFollowUpLimit.js";
import { CampaignCleanup, CampaignStuck } from "./CampaignCleanup.js";
import { useStoreSelector } from "../store.js";
import { CampaignDecisions } from "./CampaignDecisions.js";
import { CampaignDecisionModelChecks } from "./CampaignDecisionModelChecks.js";
import { OwnerRuleFactRows } from "./requests/WorkflowDecisionSummary.js";
import { CampaignRepositories } from "./CampaignRepositories.js";
import { CampaignRecoveryNotice } from "./CampaignRecoveryNotice.js";
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
  /** Rows the list had loaded, so a remounted panel reloads as deep before restoring position. */
  shownCount: number;
}
const listMemory = new Map<string, CampaignListMemory>();

export function forgetCampaignStatusMemory(): void {
  listMemory.clear();
}

type AvailableCampaign = Extract<CampaignStatusAvailability, { kind: "available" }>;

/** A work item's badge. An unfinished item handed to a person or an outside party reads Handed Off
 * (#4070) whatever its derived state: no agent in the campaign is meant to act on it, and calling
 * it Blocked would misstate whose turn it is. The derived state still filters and sorts it. */
function workItemStatusMeta(item: Pick<CampaignWorkItemSummary, "primaryState" | "handoff">): StatusMeta {
  const handedOff = (item.handoff?.responsibleActor === "human" || item.handoff?.responsibleActor === "external") &&
    !["delivered", "cancelled", "removed"].includes(item.primaryState);
  return handedOff ? { ...statusMeta("campaignWork", "planned"), label: "Handed Off" } : statusMeta("campaignWork", item.primaryState);
}

/** The request a work item waits on: the occurrence its blocker names, else its child session's. */
export interface CampaignRequestTarget {
  occurrenceId: string | null;
  sessionId: string | null;
}

export function CampaignStatusPanel({
  session,
  availability,
  onOpenSession,
  findRequest,
  onOpenRequest,
  onOpenSessionRequest,
}: {
  session: SessionView;
  availability: Exclude<CampaignStatusAvailability, { kind: "hidden" }>;
  onOpenSession: (sessionId: string) => void;
  /** The Requests key of the item's request when this session lists it, else null. */
  findRequest: (target: CampaignRequestTarget) => string | null;
  onOpenRequest: (requestKey: string) => void;
  /** Opens another session at one of its own requests (#4337), for a decision this session does not list. */
  onOpenSessionRequest?: (sessionId: string, requestId: string) => void;
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
      findRequest={findRequest}
      onOpenRequest={onOpenRequest}
      onOpenSessionRequest={onOpenSessionRequest}
    />
  );
}

function AvailableCampaignStatus({
  session,
  availability,
  onOpenSession,
  findRequest,
  onOpenRequest,
  onOpenSessionRequest,
}: {
  session: SessionView;
  availability: AvailableCampaign;
  onOpenSession: (sessionId: string) => void;
  findRequest: (target: CampaignRequestTarget) => string | null;
  onOpenRequest: (requestKey: string) => void;
  onOpenSessionRequest?: (sessionId: string, requestId: string) => void;
}) {
  const [memory, setMemoryState] = useState<CampaignListMemory>(() => listMemory.get(session.id) ?? {
    filters: DEFAULT_CAMPAIGN_WORK_FILTERS,
    selectedItemId: null,
    scrollTop: 0,
    // A member starts on its own assignment.
    focusItemId: availability.currentWorkItemId,
    shownCount: 0,
  });
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
    restoreCount: memory.shownCount,
  });
  const shownCount = data.list.status === "ready" ? data.list.items.length : null;
  useEffect(() => {
    if (shownCount !== null && shownCount !== memory.shownCount) setMemory({ shownCount });
  }, [memory.shownCount, setMemory, shownCount]);
  const now = useTimelineClock(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement | null>());
  // Putting the list back where it was waits for the rows that position needs: a remount restores
  // the remembered scroll position, and Back restores it with focus on the row that was opened.
  // It applies once that row renders, or once the list settles without it, and then lets go, so
  // later scrolling and focus are the person's.
  const pendingRestore = useRef<{ focus: boolean } | null>(memory.selectedItemId ? null : { focus: false });

  const openItem = (item: CampaignWorkItemSummary) => {
    // Captured on the way out, so Back puts the list exactly where it was.
    setMemory({ selectedItemId: item.id, focusItemId: item.id, scrollTop: scrollRef.current?.scrollTop ?? memory.scrollTop });
  };
  const closeItem = () => {
    pendingRestore.current = { focus: true };
    setMemory({ selectedItemId: null });
  };

  useLayoutEffect(() => {
    if (!memory.selectedItemId) return;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    detailHeadingRef.current?.focus({ preventScroll: true });
  }, [memory.selectedItemId]);

  const listSettled = data.list.status !== "loading" && !data.list.reloading;
  const shownRows = data.list.items.length;
  useLayoutEffect(() => {
    const pending = pendingRestore.current;
    if (!pending || memory.selectedItemId) return;
    const row = memory.focusItemId ? rowRefs.current.get(memory.focusItemId) ?? null : null;
    if (!row && !listSettled) return;
    pendingRestore.current = null;
    if (scrollRef.current) scrollRef.current.scrollTop = memory.scrollTop;
    if (pending.focus && row) row.focus({ preventScroll: true });
  // Reads the memory as it stood when the restore was requested; it reruns only as rows arrive.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memory.selectedItemId, shownRows, listSettled]);

  const heldChildren = data.summary.campaign?.heldChildren ?? [];
  // A child named by Cleanup or Campaign Stuck, as a link to its session.
  const sessionLink = (sessionId: string) => <CampaignChildLink sessionId={sessionId} onOpen={onOpenSession} />;
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
          findRequest={findRequest}
          onOpenRequest={onOpenRequest}
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
              {data.summary.campaign?.ownerDecisions && (
                <CampaignOwnerDecisions
                  sessionId={session.id}
                  ownerDecisions={data.summary.campaign.ownerDecisions}
                  now={now}
                  findRequest={findRequest}
                  onOpenRequest={onOpenRequest}
                  onOpenSessionRequest={onOpenSessionRequest}
                />
              )}
              <CampaignDecisionModelChecks
                sessionId={session.id}
                canClassify={availability.role === "campaign"}
                refreshKey={data.summary.campaign}
                onOpenSession={onOpenSession}
                findRequest={findRequest}
                onOpenRequest={onOpenRequest}
              />
              {data.summary.campaign?.status === "stuck" && data.summary.campaign.stuck && (
                <CampaignStuck
                  stuck={data.summary.campaign.stuck}
                  repair={data.summary.campaign.activity?.repair}
                  onOpenSession={sessionLink}
                />
              )}
              {data.summary.campaign?.cleanup && (
                <CampaignCleanup
                  campaignId={availability.campaignSessionId}
                  cleanup={data.summary.campaign.cleanup}
                  canAct={availability.role === "campaign"}
                  onOpenSession={sessionLink}
                />
              )}
              {data.summary.campaign?.handoffs && (
                <CampaignHandoffs
                  handoffs={data.summary.campaign.handoffs}
                  now={now}
                  onOpen={(workItemId) => setMemory({ selectedItemId: workItemId, focusItemId: workItemId,
                    scrollTop: scrollRef.current?.scrollTop ?? memory.scrollTop })}
                />
              )}
              <CampaignRecoveryAutomation campaign={data.summary.campaign} />
              {data.summary.campaign?.recovery?.records.map(record => (
                <CampaignRecoveryNotice key={record.id} record={record} />
              ))}
              {data.summary.campaign?.recovery?.truncated && <p>More recovery records are available through the campaign tools.</p>}
              {data.summary.campaign?.budget?.followUpApprovals && (
                <CampaignFollowUpLimit
                  campaignId={availability.campaignSessionId}
                  budget={data.summary.campaign.budget}
                  policyRevision={data.summary.campaign.policyRevision}
                  canEdit={availability.role === "campaign"}
                  findRequest={(occurrenceId) => findRequest({ occurrenceId, sessionId: availability.campaignSessionId })}
                  onOpenRequest={onOpenRequest}
                />
              )}
              {data.summary.campaign?.control?.mode === "full_control" && data.summary.campaign.decisionOwners &&
                data.summary.campaign.uiEvidenceReview && (
                <CampaignAuthoritySummary campaign={{ ...data.summary.campaign, control: data.summary.campaign.control,
                  decisionOwners: data.summary.campaign.decisionOwners, uiEvidenceReview: data.summary.campaign.uiEvidenceReview }} />
              )}
              {data.summary.campaign?.repositoryBoundary && (
                <CampaignRepositories
                  campaignId={availability.campaignSessionId}
                  boundary={data.summary.campaign.repositoryBoundary}
                  canInclude={availability.role === "campaign"}
                />
              )}
              <CampaignIssueScopePanel session={session} campaignId={availability.campaignSessionId}
                policyRevision={availability.role === "campaign" ? data.summary.campaign?.policyRevision : undefined}
                boundaryShown={data.summary.campaign?.control?.mode === "full_control"} />
              <CampaignDecisions campaignId={availability.campaignSessionId} />
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

/** The recovery automation's hold (#3361): nothing for a finished campaign, neutral when nothing is
 * left to recover, and a warning only for a hold that keeps work from continuing. */
function CampaignRecoveryAutomation({ campaign }: { campaign: CampaignStatusData["summary"]["campaign"] }) {
  const notice = campaignRecoveryAutomationNotice(campaign?.status, campaign?.recovery?.automation);
  if (!notice) return null;
  return (
    <Notice tone={notice.tone} title={notice.title} role={notice.tone === "neutral" ? "status" : undefined}>
      {notice.body}
    </Notice>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Handed Off (#4070)
 * ---------------------------------------------------------------------------------------------- */

/** Decisions the campaign's owner kept (#4064), which wait for that person while the campaign keeps
 * working: the Orchestrator's questions for them and the decisions it handed to them. */
function CampaignOwnerDecisions({ sessionId, ownerDecisions, now, findRequest, onOpenRequest, onOpenSessionRequest }: {
  sessionId: string;
  ownerDecisions: NonNullable<NonNullable<CampaignStatusData["summary"]["campaign"]>["ownerDecisions"]>;
  now: number;
  findRequest: (target: CampaignRequestTarget) => string | null;
  onOpenRequest: (requestKey: string) => void;
  onOpenSessionRequest?: (sessionId: string, requestId: string) => void;
}) {
  const headingId = useId();
  const hidden = ownerDecisions.total - ownerDecisions.items.length;
  // An Orchestrator's scope proposal without lineage waits for the owner without the owner keeping it (#4267).
  const scopeApproval = (item: (typeof ownerDecisions.items)[number]) => item.category === "campaign_issue_scope" && !item.ownerRule && !item.handedOff;
  // So does its request to add a repository (#4117): the owner never kept it, it is always theirs.
  const repositoryAddition = (item: (typeof ownerDecisions.items)[number]) => item.category === "campaign_repository_addition" && !item.ownerRule && !item.handedOff;
  const one = ownerDecisions.total === 1;
  return (
    <section className="campaign-status-handoffs" aria-labelledby={headingId}>
      <h3 id={headingId} className="section-title">Waiting for You</h3>
      <p className="section-note">
        {ownerDecisions.items.some((item) => scopeApproval(item) || repositoryAddition(item))
          ? `Only you can make ${one ? "this decision" : "these decisions"}.`
          : `You kept ${one ? "this decision" : "these decisions"}, so only you can make ${one ? "it" : "them"}.`}{" "}
        The Orchestrator keeps working on everything else meanwhile.
      </p>
      <ul className="campaign-detail-list">
        {ownerDecisions.items.map((item) => {
          // The exact occurrence wherever this session lists it. Another session's decision this
          // session does not list (a nested Orchestrator controls it, #4337) opens in its own
          // session at that request, never at another request of the same session.
          const requestKey = findRequest({ occurrenceId: item.occurrenceId, sessionId: item.sessionId === sessionId ? item.sessionId : null });
          const openElsewhere = !requestKey && item.sessionId !== sessionId && onOpenSessionRequest
            ? () => onOpenSessionRequest(item.sessionId, item.occurrenceId) : null;
          const open = requestKey ? () => onOpenRequest(requestKey) : openElsewhere;
          return (
            <li key={item.occurrenceId}>
              <dl className="facts">
                <div>
                  <dt>{item.ownerRule ? "Kept by Rule" : item.handedOff ? "Handed to You" : scopeApproval(item) ? "Scope Approval"
                    : repositoryAddition(item) ? "Add Repository" : "Owner Decision"}</dt>
                  <dd>
                    {item.summary}
                    <span className="campaign-status-meta">
                      {item.ownerRule ? "Requested under a rule" : item.handedOff ? "Handed over by the Orchestrator"
                        : scopeApproval(item) ? "Proposed by the Orchestrator" : "Asked by the Orchestrator"}{" "}
                      <RecordedTime at={item.createdAt} now={now} />
                    </span>
                  </dd>
                </div>
                {item.ownerRule && <OwnerRuleFactRows rule={item.ownerRule} />}
              </dl>
              {open && <button type="button" className="btn sm" aria-label={`Open Request: ${item.summary}`}
                onClick={open}>Open Request</button>}
            </li>
          );
        })}
      </ul>
      {hidden > 0 && <p className="section-note">{hidden} more decision{hidden === 1 ? " waits" : "s wait"} for you under Requests.</p>}
    </section>
  );
}

/** The owner's to-do list: unfinished items the campaign handed to a person or an outside party.
 * The server lists them whenever any exist, so none is dropped once the agents are done. */
function CampaignHandoffs({ handoffs, now, onOpen }: {
  handoffs: NonNullable<NonNullable<CampaignStatusData["summary"]["campaign"]>["handoffs"]>;
  now: number;
  onOpen: (workItemId: string) => void;
}) {
  const headingId = useId();
  const hidden = handoffs.total - handoffs.items.length;
  return (
    <section className="campaign-status-handoffs" aria-labelledby={headingId}>
      <h3 id={headingId} className="section-title">Handed Off</h3>
      <p className="section-note">
        The agent work on {handoffs.total === 1 ? "this item is" : "these items is"} done. What happens next is up to the
        person or outside party named.
      </p>
      <ul className="campaign-detail-list">
        {handoffs.items.map((item) => (
          <li key={item.workItemId}>
            <dl className="facts">
              <div>
                <dt>Work Item</dt>
                <dd>
                  {workItemTitle(item)}
                  {item.issue && item.title && <span className="campaign-status-meta">{issueRefLabel(item.issue)}</span>}
                </dd>
              </div>
              <div><dt>Responsible</dt><dd>{RESPONSIBLE_ACTOR_LABELS[item.handoff.responsibleActor]}</dd></div>
              <div><dt>Reason</dt><dd>{item.handoff.reason}</dd></div>
              <div>
                <dt>Next Action</dt>
                <dd>
                  {item.handoff.nextAction}
                  <span className="campaign-status-meta">Handed off <RecordedTime at={item.handoff.recordedAt} now={now} /></span>
                </dd>
              </div>
            </dl>
            <button type="button" className="btn ghost sm" aria-label={`Open Details for ${workItemTitle(item)}`}
              onClick={() => onOpen(item.workItemId)}>
              Open Details
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className="section-note">{hidden} more handed-off item{hidden === 1 ? " is" : "s are"} listed under Work Items.</p>}
    </section>
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
      <h3 id={headingId} className="section-title">Summary</h3>
      {summary.error && (
        <Notice tone="danger" compact role="alert" title="Couldn't Refresh Campaign Summary"
          actions={<button type="button" className="btn sm" onClick={data.retry}>Retry</button>}>
          {summary.error} Showing the last loaded summary.
        </Notice>
      )}
      {view.planNotice && (
        <Notice tone="info" title={view.planNotice.title}>
          {view.planNotice.body}
        </Notice>
      )}
      <StaleContent stale={summary.error !== null}>
        <dl className="facts">
          <div><dt>State</dt><dd>{view.stateLabel}</dd></div>
          <div><dt>Progress</dt><dd>{view.progressText}</dd></div>
          <div>
            <dt>Scope</dt>
            <dd>
              {view.scope.original} Original
              <span className="campaign-status-meta">{view.scope.followUp} accepted follow-up{view.scope.followUp === 1 ? "" : "s"}</span>
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
                ? <span className="campaign-status-meta">{view.costBreakdown.map((row) => `${row.phrase} ${row.text}`).join(", ")}</span>
                : view.cost.note && <span className="campaign-status-meta">{view.cost.note}</span>}
              {view.costUncertainty && <span className="campaign-status-meta">{view.costUncertainty}</span>}
            </dd>
          </div>
          {view.budget && !summary.campaign?.budget && <div><dt>Session Limits</dt><dd>{view.budget}</dd></div>}
          {summary.campaign?.budget && <CampaignBudgetFacts budget={summary.campaign.budget} />}
          <div>
            <dt>Outstanding</dt>
            <dd>{view.obligations.length === 0 ? "None" : view.obligations.map((entry) => `${entry.count} ${entry.phrase}`).join(", ")}</dd>
          </div>
          <div>
            <dt>Recommendations</dt>
            <dd>
              {view.recommendations.awaiting} Awaiting Adjudication
              <span className="campaign-status-meta">
                {view.recommendations.rejected} rejected, {view.recommendations.deferred} deferred, {view.recommendations.duplicate} duplicate
              </span>
            </dd>
          </div>
        </dl>
      </StaleContent>
    </section>
  );
}

export function CampaignBudgetFacts({ budget }: { budget: import("@wollipog/protocol").CampaignBudgetView }) {
  // A campaign authorized without a ceiling says so: it runs unbounded while usage is still metered.
  const limits = [budget.authority.costUsd === undefined && budget.authority.toolCalls === undefined ? "No limit" : null,
    budget.authority.costUsd === undefined ? null : `$${budget.authority.costUsd.toFixed(2)}`,
    budget.authority.toolCalls === undefined ? null : `${budget.authority.toolCalls} tool calls`,
    budget.authority.concurrency === undefined ? null : `${budget.authority.concurrency} concurrent workers`].filter(Boolean).join(", ");
  return <>
    <div><dt>Campaign Allowance</dt><dd>{limits}<span className="campaign-status-meta">{budget.reason ?? "Human authorized; allocations cannot enlarge this allowance."}</span></dd></div>
    <div><dt>Session Limits</dt><dd>{budget.sessionLimits?.costBudgetUsd == null ? "No session cost ceiling" : `$${budget.sessionLimits.costBudgetUsd.toFixed(2)}`}, {budget.sessionLimits?.maxToolCalls == null ? "no session tool ceiling" : `${budget.sessionLimits.maxToolCalls} tool calls`}</dd></div>
    {budget.rootAllocation && <div><dt>Root Allocation</dt><dd>{budget.rootAllocation.costUsd == null ? "No cost allocation" : `$${budget.rootAllocation.costUsd.toFixed(2)}`}, {budget.rootAllocation.toolCalls == null ? "no tool allocation" : `${budget.rootAllocation.toolCalls} tool calls`}</dd></div>}
    <div><dt>Recorded Campaign Spend</dt><dd>{budget.costAccounting === "unavailable" ? "Cost unavailable" : `$${budget.actual.costUsd.toFixed(2)}`}, {budget.actual.toolCalls} tool calls{budget.costAccounting !== "unavailable" && budget.actual.includesEstimate &&
      <span className="campaign-status-meta">Includes an estimate for running turns.</span>}</dd></div>
    <div><dt>Outstanding Allocations</dt><dd>${budget.outstanding.costUsd.toFixed(2)}, {budget.outstanding.toolCalls} tool calls</dd></div>
    <div><dt>Unallocated Allowance</dt><dd>{budget.remaining.costUsd === null ? "No campaign cost ceiling" : `$${budget.remaining.costUsd.toFixed(2)}`}, {budget.remaining.toolCalls === null ? "no campaign tool ceiling" : `${budget.remaining.toolCalls} tool calls`}</dd></div>
    <div><dt>Accounting Policy</dt><dd>Managed Sessions and approved native review jobs. {budget.authority.costUsd === undefined ? "Unpriced usage is counted without a cost." : "Unpriced usage stops protected admission."} Unmanaged reviewer invocations are unsupported.<span className="campaign-status-meta">Cancellation is asynchronous; in-flight work can overshoot the allowance. This is not a hard billing cap.</span></dd></div>
  </>;
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
  // #4120: grouped by repository when the campaign works in more than one; keyboard order follows
  // what is shown.
  const groups = groupCampaignWorkByRepository(list.items, list.repositories);
  const items = groups ? groups.flatMap((group) => group.items) : list.items;
  const repositoryOptions = campaignRepositoryFilterOptions(list.repositories, filters.repository ?? "all");
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

  const row = (item: CampaignWorkItemSummary) => (
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
  );

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
          {groups ? groups.map((group) => (
            <CampaignWorkGroup key={group.repository ?? ""} group={group}>
              {group.items.map(row)}
            </CampaignWorkGroup>
          )) : items.map(row)}
        </ul>
        {list.hasMore && (
          <BusyButton className="btn ghost sm campaign-work-more" busy={list.loadingMore} progress="Loading more work items…"
            disabled={list.loadingMore || list.reloading} onClick={data.loadMore}>
            Show More
          </BusyButton>
        )}
      </>
    );
  }

  return (
    <section className="campaign-work" aria-labelledby={headingId}>
      <div className="campaign-work-head">
        <h3 id={headingId} className="section-title">Work Items</h3>
        <Select label="Sort" value={filters.sort} options={CAMPAIGN_SORT_OPTIONS}
          onChange={(sort) => onFiltersChange({ ...filters, sort })} />
      </div>
      <div className="campaign-work-filters">
        <Select label="Origin" value={filters.origin} options={CAMPAIGN_ORIGIN_FILTER_OPTIONS}
          onChange={(origin) => onFiltersChange({ ...filters, origin })} />
        <Select label="State" value={filters.state} options={CAMPAIGN_STATE_FILTER_OPTIONS}
          onChange={(state) => onFiltersChange({ ...filters, state })} />
        {repositoryOptions.length > 0 && (
          <Select label="Repository" value={filters.repository ?? "all"} options={repositoryOptions}
            onChange={(repository) => onFiltersChange({ ...filters, repository })} />
        )}
      </div>
      {body}
    </section>
  );
}

/** #4120: one repository's rows under a header with that repository's counts. */
function CampaignWorkGroup({ group, children }: { group: CampaignWorkRepositoryGroup; children: ReactNode }) {
  const headingId = useId();
  return (
    <li className="campaign-work-group">
      <h4 id={headingId} className="campaign-work-group-head">
        <span className="campaign-work-group-name">{group.label}</span>
        <span className="campaign-work-group-counts">{repositoryCountsLabel(group.counts, group.items.length)}</span>
      </h4>
      <ul className="campaign-work-list" aria-labelledby={headingId}>{children}</ul>
    </li>
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
  const held = heldOnPullRequest(item);
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
        <StatusBadge meta={workItemStatusMeta(item)} inline />
      </span>
      <span className="campaign-work-row-line campaign-work-row-meta">
        <span>{workItemOriginLabel(item)}</span>
        {item.issue && item.title && <span>{issueRefLabel(item.issue)}</span>}
        <span className="campaign-work-row-trail">
          <span title={time.label}>{time.text}</span>
          {cost.priced && <span title={cost.provenance ?? "Cost"}>{cost.text}</span>}
        </span>
      </span>
      {/* #4120: prerequisites in other repositories, and the merge an item is held on. */}
      {item.mergeDependencies?.map((dependency) => {
        const line = mergeDependencyLine(dependency);
        return (
          <span key={dependency.id} className="campaign-work-row-line campaign-work-row-dependency">
            <span className="campaign-work-row-dependency-label">Depends On</span>
            <span>{line.label}</span>
            <span className="campaign-status-meta">{line.status}</span>
          </span>
        );
      })}
      {held && (
        <span className="campaign-work-row-line campaign-work-row-held">
          <span className="campaign-work-row-dependency-label">{WAITING_FOR_PREREQUISITE_MERGE}</span>
          <span>{held}</span>
        </span>
      )}
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

/** A campaign child by its title from the store, as a link to its session (#4146). */
function CampaignChildLink({ sessionId, onOpen }: { sessionId: string; onOpen: (sessionId: string) => void }) {
  const title = useStoreSelector((s) => s.sessions.get(sessionId)?.title ?? "");
  return <SessionLink sessionId={sessionId} onOpen={onOpen}>{title || "Open Child Session"}</SessionLink>;
}

function RecordedTime({ at, now, prefix }: { at: number | null; now: number; prefix?: string }) {
  if (at === null) return <>{UNAVAILABLE}</>;
  const stamp = formatRecordedTimestamp(at);
  return (
    <time dateTime={stamp?.dateTime} title={stamp?.title}>
      {prefix ? `${prefix} ` : ""}{timeAgo(at, now)}
    </time>
  );
}

function IssueLink({ issue, kind }: { issue: CampaignIssueRef; kind: "issues" | "pull" }) {
  const href = issueRefHref(issue, kind);
  const label = issueRefLabel(issue, kind);
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
        <RecordedTime at={fact.observedAt} now={now} prefix={fact.availability === "stale" ? "Stale, observed" : "Observed"} />
      </span>
    </>
  );
}

function sessionStatusText(value: CampaignObservedSessionStatus): string {
  const parts = [titleCaseLabel(value.status.replaceAll("_", " "))];
  if (value.archived) parts.push("archived");
  if (value.held) parts.push("held");
  if (value.pendingRequests > 0) parts.push(`${value.pendingRequests} pending request${value.pendingRequests === 1 ? "" : "s"}`);
  return parts.join(", ");
}

function cleanupText(value: CampaignObservedCleanup): string {
  if (value.worktrees.length === 0) return "No Worktrees";
  return value.worktrees.map((worktree) => `${titleCaseLabel(worktree.status)}: ${worktree.path}` +
    (worktree.reason ? ` — ${worktree.reason}` : "")).join("; ");
}

/** One pull request as GitHub was observed: its status line says when, and a stale observation's
 * values all read "Last Seen …". An unavailable one says why and shows no value at all. */
function ForgePullRequestFacts({
  entry,
  now,
}: {
  entry: { ref: CampaignPullRequestRef; fact: CampaignObservedFact<CampaignForgeChangeRequestObservation> };
  now: number;
}) {
  const view = forgePullRequestView(entry.fact, now, entry.ref);
  const label = pullRequestShortLabel(entry.ref);
  if (view.kind === "unavailable") {
    return (
      <div className="campaign-forge-pr">
        <dt>{label}</dt>
        <dd>
          {UNAVAILABLE}
          <span className="campaign-status-meta">
            {view.reason}
            {view.lastObservedAt !== null && <> Last observed on {view.forge} <RecordedTime at={view.lastObservedAt} now={now} />.</>}
          </span>
        </dd>
      </div>
    );
  }
  return (
    <>
      <div className="campaign-forge-pr">
        <dt>{label}</dt>
        <dd>
          {view.status}
          <span className="campaign-status-meta">
            {view.current
              ? <RecordedTime at={view.observedAt} now={now} prefix={`Observed on ${view.forge}`} />
              : <>Stale: <RecordedTime at={view.observedAt} now={now} prefix={`observed on ${view.forge}`} />. It may have changed since.</>}
          </span>
        </dd>
      </div>
      {view.rows.map((row) => (
        <div key={row.label} className="campaign-forge-fact">
          <dt>{row.label}</dt>
          <dd>{row.text}{row.note && <span className="campaign-status-meta">{row.note}</span>}</dd>
        </div>
      ))}
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
  findRequest,
  onOpenRequest,
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
  findRequest: (target: CampaignRequestTarget) => string | null;
  onOpenRequest: (requestKey: string) => void;
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
        {detail && <StatusBadge meta={workItemStatusMeta(detail)} />}
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
  // A recorded delivery (#4070) shows while it is what the item's delivered state rests on.
  const recordedDelivery = detail.primaryState === "delivered" ? detail.deliveries?.at(-1) ?? null : null;
  const held = currentSessionId ? heldChildren.find((child) => child.sessionId === currentSessionId) : undefined;
  const pullRequests = [
    ...(detail.observed.pullRequests?.map((entry) => entry.ref) ?? []),
    ...(detail.stage?.pullRequests ?? []),
  ].filter((pr, index, all) => all.findIndex((other) => other.repository === pr.repository && other.number === pr.number) === index);
  const linksRequests = Boolean(detail.blocker?.requestOccurrenceId) || detail.stateCauses.some(causeNeedsRequests);
  const requestKey = linksRequests
    ? findRequest({ occurrenceId: detail.blocker?.requestOccurrenceId ?? null, sessionId: currentSessionId })
    : null;
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
                ? <>{detail.currentAttempt.sessionTitle ?? "Session"}<span className="campaign-status-meta">Session deleted</span></>
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
                        {attempt.sessionId ? "" : ", session deleted"}, {costWithProvenance(attemptCost(attempt.id))}
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
                  {detail.dependsOn.map((dependency) => {
                    // #4120: a prerequisite in another repository names it, and whether it merged.
                    const merge = detail.mergeDependencies?.find((candidate) => candidate.id === dependency.id);
                    const line = merge ? mergeDependencyLine(merge) : null;
                    return (
                      <li key={dependency.id}>
                        {line ? line.label : workItemTitle(dependency)}
                        <span className="campaign-status-meta">{CAMPAIGN_WORK_STATE_LABELS[dependency.primaryState]}</span>
                        {line && <span className="campaign-status-meta">{line.status}</span>}
                      </li>
                    );
                  })}
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
              <div><dt>Reason</dt><dd>{detail.stateCauses.map(stateCauseText).join(" ")}
                {heldOnPullRequest(detail) && <> Waiting for {heldOnPullRequest(detail)}.</>}</dd></div>
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
            <div><dt>Responsible</dt><dd>{detail.blocker ? RESPONSIBLE_ACTOR_LABELS[detail.blocker.responsibleActor]
              : detail.handoff ? RESPONSIBLE_ACTOR_LABELS[detail.handoff.responsibleActor] : "None Recorded"}</dd></div>
            <div><dt>Next Action</dt><dd>{detail.nextAction ?? "None Recorded"}</dd></div>
            {detail.handoff && (
              <div>
                <dt>Handoff</dt>
                <dd>
                  Handed to {RESPONSIBLE_ACTOR_LABELS[detail.handoff.responsibleActor]}: {detail.handoff.reason}
                  <span className="campaign-status-note">Next action: {detail.handoff.nextAction}</span>
                  <span className="campaign-status-meta">Recorded <RecordedTime at={detail.handoff.recordedAt} now={now} /></span>
                </dd>
              </div>
            )}
          </DetailSection>
          {/* A request is answered in Requests when this session can reach it; a hold has nothing to
              answer, so a held child, like any request this session cannot see, is opened instead. */}
          {(linksRequests || held || detail.primaryState === "blocked") && (requestKey || currentSessionId) && (
            <div className="campaign-detail-actions">
              {requestKey && (
                <button type="button" className="btn sm" onClick={() => onOpenRequest(requestKey)}>
                  Open Requests
                </button>
              )}
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
                    {detail.stage.sourceSessionId ? "Reported by the Orchestrator" : "Reported by a deleted Orchestrator session"}{" "}
                    <RecordedTime at={detail.stage.reportedAt} now={now} />. Wollipog has not observed this stage.
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
                <ForgePullRequestFacts key={`${entry.ref.repository}#${entry.ref.number}`} entry={entry} now={now} />
              ))
              : (
                <div>
                  <dt>Review and Checks</dt>
                  <dd>{detail.observed.pullRequests
                    ? <>No Pull Request Reported<span className="campaign-status-meta">GitHub and GitLab status is observed for the pull requests and merge requests the Orchestrator reports.</span></>
                    : <ObservedValue fact={undefined} now={now} render={() => null} />}</dd>
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
            {recordedDelivery && (
              <div>
                <dt>Recorded Delivery</dt>
                <dd>
                  {[
                    ...recordedDelivery.pullRequests.map((pr) => `${pullRequestShortLabel(pr)} merged`),
                    ...(recordedDelivery.report ? [`report ${recordedDelivery.report.seq}`] : []),
                  ].join(", ")}
                  <span className="campaign-status-meta">
                    Checked by Wollipog when the Orchestrator recorded it <RecordedTime at={recordedDelivery.recordedAt} now={now} />
                  </span>
                  {recordedDelivery.note && <span className="campaign-status-note">{recordedDelivery.note}</span>}
                </dd>
              </div>
            )}
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
      <h4 id={headingId} className="section-title">{title}</h4>
      <dl className="facts">{children}</dl>
    </section>
  );
}
