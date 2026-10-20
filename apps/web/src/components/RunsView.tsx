import { BotIcon, CompareIcon, ProjectsIcon, RunsIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { State } from "./State.js";
import { StatusBadge, statusToneClass } from "./StatusBadge.js";
import { sessionStatusSummary, statusMeta } from "../status-meta.js";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { RunView, SessionView, WorkflowArtifactView, WorkflowInstanceDetail } from "@wollipog/protocol";
import { useStoreActions, useStoreSelector } from "../store.js";
import { formatClock, formatRecordedRelativeTime, localDayLabel, relativeTime, titleCaseLabel } from "../format.js";
import { useApi } from "../api-context.js";
import { CompareMemberBody, CompareMemberHead, CompareRow } from "./CompareColumns.js";
import { useTimeline } from "./useTimeline.js";
import { sessionAgentLabel } from "./agent-options.js";
import { nextWorkflowRetryAt, workflowRetryTimerDelay } from "../workflow-retry.js";
import { subscriptionRecoveryRevision } from "../ui-subscriptions.js";
import { recoverSessionHistories, sessionHistoryEpochKey } from "../history-recovery.js";
import { detailPlaceholder, listPlaceholder } from "../detail-placeholder.js";
import { selectComparisonEvents, selectComparisonHistory, selectComparisonSession } from "../comparison-selectors.js";
import { transcriptPresentation } from "../transcript-presentation.js";
import { ArtifactPreviewDialog, ArtifactRow } from "./ArtifactPreview.js";
import { ListFoot } from "./ListFoot.js";
import { BusyButton } from "./ui/BusyButton.js";
import { DetailBar, PageHeader, type PageMenuAction } from "./PageHeader.js";
import { StaleContent } from "./StaleContent.js";
import { indexRunWorkflows, runStatus, runType, runTypeLabel, type RunWorkflows } from "../run-status.js";
import { absoluteViewUrl, backLabel, destination, viewTitle } from "../navigation.js";
import { useTimelineClock } from "../timeline-clock.js";
import { memberActivity, memberActivityLine } from "../member-activity.js";
import { useIsMobile } from "./useIsMobile.js";
import { TabList } from "./Tabs.js";
import { Modal } from "./Modal.js";
import { useFeedback } from "./FeedbackProvider.js";
import { useDashboardPublicOrigin } from "../remote-access-context.js";
import { writeClipboardText } from "../clipboard.js";
import { DEVELOPMENT_BUILD } from "../config.js";

const EMPTY_SESSION_IDS: string[] = [];
const NO_RUN_LINK_REASON = "Open Wollipog in a browser to copy a link.";
const DEVELOPMENT_LINK_HINT = "Development builds can set VITE_DASHBOARD_ORIGIN.";
const sameSessionIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/** The member's ⋯ (#2975), the same in a desktop column's head and the phone's member bar. */
function memberMenu(openSession: () => void): PageMenuAction[] {
  return [{ label: "Open Session", onClick: openSession }];
}

/** One member's live column (§12.5's reading column, #2975). Its own component so each member
 * subscribes to ITS event slice and folds incrementally — a 4-agent compare no longer re-derives
 * four full timelines per streamed chunk of any one of them. */
function MemberColumn({ sessionId, onRetry, panel }: {
  sessionId: string;
  /** Loads the run's member histories again after a failure. */
  onRetry: () => void;
  /** On a phone, the one column is the member tabs' panel. */
  panel?: { id: string; labelledBy: string };
}) {
  const { navigate } = useStoreActions();
  const session = useStoreSelector((state) => selectComparisonSession(state, sessionId));
  const evs = useStoreSelector((state) => selectComparisonEvents(state, sessionId));
  const history = useStoreSelector((state) => selectComparisonHistory(state, sessionId));
  // Only a machine known to be offline is Disconnected, as in the member's tab (§4.3).
  const runnerOnline = useStoreSelector((state) => session
    ? state.runners.get(session.runnerId)?.status !== "offline"
    : true);
  const conn = useStoreSelector((state) => state.conn);
  const items = useTimeline(sessionId, evs, session?.eventEpoch ?? 0);
  const activity = useMemo(() => memberActivity(items), [items]);
  if (!session) return null;
  const presentation = transcriptPresentation({ itemCount: items.length, hasOptimistic: false, working: false, history, conn });
  const agentLabel = sessionAgentLabel(session.agentName, session.driver, session.agentId);
  const openSession = () => navigate({ name: "session", id: sessionId });
  // What it did, counted from its timeline once that is known.
  const known = presentation.body === "timeline" || presentation.body === "empty";
  const did = memberActivityLine(statusMeta("session", session.status).pulse, known ? activity : null);
  return (
    <section
      className="compare-member"
      aria-label={panel ? undefined : agentLabel}
      id={panel?.id}
      role={panel ? "tabpanel" : undefined}
      aria-labelledby={panel?.labelledBy}
    >
      <CompareMemberHead
        agent={agentLabel}
        session={session}
        runnerOnline={runnerOnline}
        onOpenSession={openSession}
        menu={memberMenu(openSession)}
      />
      <p className="compare-member-meta">{did}</p>
      <CompareMemberBody
        agent={agentLabel}
        session={session}
        items={items}
        presentation={presentation}
        conn={conn}
        loaded={evs?.length ?? 0}
        onRetry={onRetry}
      />
    </section>
  );
}

const memberTabId = (index: number) => `run-member-tab-${index}`;
const MEMBER_PANEL_ID = "run-member-panel";

/** A phone's member tab: the agent and its status as a dot, named in words. */
function MemberTab({ sessionId, index, selected, onSelect, onKeyDown }: {
  sessionId: string;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const session = useStoreSelector((state) => selectComparisonSession(state, sessionId));
  const runnerOnline = useStoreSelector((state) => session
    ? state.runners.get(session.runnerId)?.status !== "offline"
    : true);
  if (!session) return null;
  const agentLabel = sessionAgentLabel(session.agentName, session.driver, session.agentId);
  const status = sessionStatusSummary(session, { runnerOnline }).primary.meta;
  return (
    <button
      id={memberTabId(index)}
      type="button"
      role="tab"
      aria-selected={selected}
      aria-controls={MEMBER_PANEL_ID}
      tabIndex={selected ? 0 : -1}
      className="tab compare-tab"
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <span className={`compare-tab-dot ${statusToneClass(status.tone)}`} aria-hidden="true" />
      {agentLabel}
      <span className="sr-only">, {status.label}</span>
    </button>
  );
}

export function RunsView({ onNewRun }: { onNewRun: () => void }) {
  const runsDestination = destination("runs");
  const { navigate } = useStoreActions();
  const runs = useStoreSelector((s) => s.runs);
  const sessions = useStoreSelector((s) => s.sessions);
  const conn = useStoreSelector((s) => s.conn);
  const snapshotLoaded = useStoreSelector((s) => s.snapshotLoaded);
  const list = useMemo(
    () => [...runs.values()].sort((a, b) => b.createdAt - a.createdAt),
    [runs],
  );
  const workflows = useRunWorkflows(list, conn === "online");
  const now = useTimelineClock(list.length > 0);

  let body: ReactNode;
  const empty = list.length === 0 && snapshotLoaded && conn === "online";
  if (list.length === 0 && !empty) {
    // An empty map proves nothing before the first snapshot or while disconnected (§12.5).
    const placeholder = listPlaceholder("runs", conn);
    body = <State variant={placeholder.variant} icon={<RunsIcon />} title={placeholder.title}>{placeholder.hint}</State>;
  } else if (empty) {
    body = (
      <State
        icon={<RunsIcon />}
        title={`No ${runsDestination.name} Yet`}
        actions={<button type="button" className="btn primary" onClick={onNewRun}>New Run</button>}
      >
        Give one task to two or three agents, or run a Build and Review workflow, and compare what each one does.
      </State>
    );
  } else {
    // Disconnected with runs: the last-known rows stay, dimmed and still openable, under one line
    // that says why (§12.5). Never an empty state.
    const stale = conn !== "online";
    body = (
      <>
        {stale && <Notice compact tone="neutral" role="status" className="run-list-reconnecting">Reconnecting…</Notice>}
        <StaleContent stale={stale}>
          <div className="surface">
            {list.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                sessions={sessions}
                workflows={workflows}
                now={now}
                onOpen={() => navigate({ name: "run", id: run.id })}
              />
            ))}
          </div>
        </StaleContent>
      </>
    );
  }

  return (
    <div className="page">
      {/* The empty state owns the one create action, so the header offers none beside it (§12.1). */}
      <PageHeader
        title={runsDestination.name}
        description={runsDestination.description}
        primary={empty ? undefined : { label: "New Run", onClick: onNewRun }}
      />
      {body}
    </div>
  );
}

/**
 * Every run's workflow instance and each workflow's name, loaded once with the list and again when a
 * run's `updatedAt` changes or the connection returns. Only the load for the current runs applies: a
 * change cancels the one in flight, so an answer from before a workflow was attached can never land
 * after it, even when the newer load fails. A failed instance load keeps the last answer, so rows
 * fall back to no type and a status from their members alone; a failed definition load only costs
 * the workflows their names.
 */
function useRunWorkflows(runs: readonly RunView[], online: boolean): RunWorkflows | null {
  const api = useApi();
  const [workflows, setWorkflows] = useState<RunWorkflows | null>(null);
  const key = JSON.stringify(runs.map((run) => [run.id, run.updatedAt]));
  useEffect(() => {
    const ids = (JSON.parse(key) as Array<[string, number]>).map(([id]) => id);
    if (!online || !ids.length) return;
    let current = true;
    void Promise.all([api.workflowInstances(), api.workflowDefinitions().catch(() => [])])
      .then(([instances, definitions]) => {
        if (current) setWorkflows(indexRunWorkflows(instances, definitions, ids));
      })
      .catch(() => {});
    return () => { current = false; };
  }, [api, key, online]);
  return workflows;
}

const SHOWN_AGENTS = 3;

/** The members' agents by name, three at most and then "+N". */
function runAgentsLabel(run: RunView, sessions: ReadonlyMap<string, SessionView>): string | null {
  const names = run.sessionIds.flatMap((id) => {
    const session = sessions.get(id);
    return session ? [sessionAgentLabel(session.agentName, session.driver, session.agentId)] : [];
  });
  if (!names.length) return null;
  const more = names.length - SHOWN_AGENTS;
  return `${names.slice(0, SHOWN_AGENTS).join(", ")}${more > 0 ? ` +${more}` : ""}`;
}

/**
 * One run (§5.2): a two-line row that opens the run. Line 1 is the title and at most one badge
 * (`runStatus()`); line 2 is meta 12px apart: the type, the project and the agents by name. The
 * created time trails. On phones the badge leads line 2, so a long title keeps its width.
 */
export function RunRow({ run, sessions, workflows, now, onOpen }: {
  run: RunView;
  sessions: ReadonlyMap<string, SessionView>;
  workflows: RunWorkflows | null;
  /** The shared clock the created time reads against. */
  now: number;
  onOpen: () => void;
}) {
  const type = runType(run, workflows);
  const status = runStatus(run, sessions, type.kind === "workflow" ? type.instance : null);
  const typeLabel = runTypeLabel(type);
  const agents = runAgentsLabel(run, sessions);
  const created = new Date(run.createdAt);
  return (
    <button type="button" className="row row-2" onClick={onOpen}>
      <span className="row-icon" aria-hidden="true">
        {type.kind === "comparison" ? <CompareIcon size={16} /> : type.kind === "workflow" ? <RunsIcon size={16} /> : null}
      </span>
      <span className="row-body run-row-body">
        <span className="row-title" title={run.title}>{run.title}</span>
        {status && <StatusBadge meta={statusMeta("run", status)} className="run-row-status" />}
        <span className="row-sub run-row-meta">
          {typeLabel && <span className="run-row-type">{typeLabel}</span>}
          {run.workspaceName && (
            <span><ProjectsIcon size={14} aria-hidden="true" /><span>{run.workspaceName}</span></span>
          )}
          {agents && <span className="run-row-agents"><BotIcon size={14} aria-hidden="true" /><span>{agents}</span></span>}
        </span>
      </span>
      <span className="row-trail">
        <time dateTime={created.toISOString()} title={`Created ${created.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`}>
          {formatRecordedRelativeTime(run.createdAt, now)}
        </time>
      </span>
    </button>
  );
}

/** Keyed by run: the route renders this in place, so a direct run-to-run change would otherwise
 * reuse one instance and show the previous run's workflow, artifacts and errors. */
export function RunDetail({ runId, member }: {
  runId: string;
  /** The member the URL names (`?member=`), which a phone shows. */
  member?: string;
}) {
  return <RunDetailContent key={runId} runId={runId} member={member} />;
}

function RunDetailContent({ runId, member }: { runId: string; member?: string }) {
  const api = useApi();
  const phone = useIsMobile();
  const { showToast } = useFeedback();
  const dashboardOrigin = useDashboardPublicOrigin();
  const [taskOpen, setTaskOpen] = useState(false);
  // Retry on a member's failed history loads every member's history again.
  const [historyRetry, setHistoryRetry] = useState(0);
  const retryHistory = useCallback(() => setHistoryRetry((value) => value + 1), []);
  const { eventEpoch, loadEvents, navigate, recoveryAfter, beginEventHistoryLoad, failEventHistoryLoad } = useStoreActions();
  const run = useStoreSelector((s) => s.runs.get(runId));
  const conn = useStoreSelector((s) => s.conn);
  const snapshotLoaded = useStoreSelector((s) => s.snapshotLoaded);
  const recoverySessionIds = useStoreSelector(
    (state) => state.runs.get(runId)?.sessionIds ?? EMPTY_SESSION_IDS,
    sameSessionIds,
  );
  const recoveryRevision = useStoreSelector((state) =>
    subscriptionRecoveryRevision(state.streamSubscriptions, recoverySessionIds));
  const recoveryGeneration = useStoreSelector((state) => state.snapshotRevision);
  const recoveryEpochKey = useStoreSelector((state) => sessionHistoryEpochKey(
    recoverySessionIds,
    (sessionId) => state.sessions.get(sessionId)?.eventEpoch ?? 0,
  ));
  const [artifacts, setArtifacts] = useState<WorkflowArtifactView[]>([]);
  const [artifactCursor, setArtifactCursor] = useState<string | undefined>();
  const [artifactPageBusy, setArtifactPageBusy] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<WorkflowArtifactView | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowInstanceDetail | null>(null);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  // Whether a load has said if the run has a workflow, so a run with none reads as a Comparison.
  const [workflowKnown, setWorkflowKnown] = useState(false);
  const [workflowBusy, setWorkflowBusy] = useState<string | null>(null);
  // Retry delays are durable timestamps, not socket events. Keep a small local clock while a
  // delayed node exists so the button becomes actionable at readyAt even if nothing else renders.
  const [retryClock, setRetryClock] = useState(() => Date.now());
  const artifactListGeneration = useRef(0);

  const nextRetryAt = useMemo(
    () => nextWorkflowRetryAt(workflow?.nodeStates ?? [], retryClock),
    [workflow, retryClock],
  );

  useEffect(() => {
    if (nextRetryAt == null) return;
    const timer = window.setTimeout(
      () => setRetryClock(Date.now()),
      workflowRetryTimerDelay(nextRetryAt, Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [nextRetryAt, retryClock]);

  const refreshWorkflow = async (targetRunId: string) => {
    const instances = await api.workflowInstances(targetRunId);
    if (!instances.length) {
      setWorkflow(null);
      setWorkflowError(null);
      return;
    }
    const detail = await api.workflowInstance(instances[0]!.instanceId);
    setWorkflow(detail);
    setWorkflowError(null);
  };

  // Re-runs when the socket comes back online — outage-window events for run members never
  // arrived and nothing else refetches them (same gap-fetch contract as SessionDetail).
  useEffect(() => {
    if (!recoverySessionIds.length || conn !== "online" || recoveryRevision == null) return;
    let current = true;
    void recoverSessionHistories(
      recoverySessionIds.map((sessionId) => ({
        sessionId,
        after: recoveryAfter(sessionId),
        eventEpoch: eventEpoch(sessionId),
        recoveryRevision,
      })),
      {
        fetchPage: api.getSessionEventPage,
        applyPage: (id, events, pageEpoch, revision, complete) =>
          loadEvents(id, events, pageEpoch, revision, complete, recoveryGeneration),
        isCurrent: () => current,
        retryOnIdleTimeout: true,
        onRequestStart: (request) => beginEventHistoryLoad(request.sessionId, request.eventEpoch, request.recoveryRevision, recoveryGeneration),
        onRequestError: (request) => failEventHistoryLoad(request.sessionId, "Activity refresh failed.", request.eventEpoch, request.recoveryRevision, recoveryGeneration),
      },
    );
    return () => { current = false; };
  }, [api, recoverySessionIds, eventEpoch, loadEvents, recoveryAfter, conn, recoveryRevision, recoveryEpochKey, recoveryGeneration, beginEventHistoryLoad, failEventHistoryLoad, historyRetry]);

  useEffect(() => {
    if (!run || conn !== "online") return;
    let current = true;
    void api.workflowInstances(run.id)
      .then((instances) => instances[0] ? api.workflowInstance(instances[0].instanceId) : null)
      .then((detail) => {
        if (!current) return;
        setWorkflow(detail);
        setWorkflowKnown(true);
        setWorkflowError(null);
      })
      .catch((error: unknown) => { if (current) setWorkflowError((error as Error).message); });
    return () => { current = false; };
  }, [api, run?.id, run?.updatedAt, conn]);

  const dispatchNode = async (nodeId: string, attemptCount: number) => {
    if (!workflow || workflowBusy) return;
    setWorkflowBusy(nodeId);
    try {
      await api.dispatchWorkflowNode(workflow.instanceId, nodeId, `ui:${workflow.instanceId}:${nodeId}:${attemptCount + 1}`);
      await refreshWorkflow(workflow.runId);
    } catch (error) {
      setWorkflowError((error as Error).message);
    } finally {
      setWorkflowBusy(null);
    }
  };

  const resolveGate = async (nodeId: string, outcome: "success" | "failure") => {
    if (!workflow || workflowBusy) return;
    setWorkflowBusy(nodeId);
    try {
      setWorkflow(await api.resolveWorkflowGate(workflow.instanceId, nodeId, outcome));
      setWorkflowError(null);
    } catch (error) {
      setWorkflowError((error as Error).message);
    } finally {
      setWorkflowBusy(null);
    }
  };

  useEffect(() => {
    if (!run) return;
    let current = true;
    const generation = ++artifactListGeneration.current;
    setSelectedArtifact(null);
    setArtifactPageBusy(false);
    void api.runWorkflowArtifacts(run.id)
      .then(({ artifacts: next, nextCursor }) => {
        if (current && generation === artifactListGeneration.current) {
          setArtifacts(next);
          setArtifactCursor(nextCursor);
          setArtifactError(null);
        }
      })
      .catch((error: unknown) => { if (current) setArtifactError((error as Error).message); });
    return () => { current = false; };
  }, [api, run?.id, run?.updatedAt]);

  const loadMoreArtifacts = async () => {
    if (!run || !artifactCursor || artifactPageBusy) return;
    const generation = artifactListGeneration.current;
    setArtifactPageBusy(true);
    try {
      const page = await api.runWorkflowArtifacts(run.id, artifactCursor);
      if (generation === artifactListGeneration.current) {
        setArtifacts((prior) => {
          const merged = new Map(prior.map((artifact) => [artifact.artifactId, artifact]));
          for (const artifact of page.artifacts) merged.set(artifact.artifactId, artifact);
          return [...merged.values()];
        });
        setArtifactCursor(page.nextCursor);
        setArtifactError(null);
      }
    } catch (error) {
      if (generation === artifactListGeneration.current) setArtifactError((error as Error).message);
    } finally {
      if (generation === artifactListGeneration.current) setArtifactPageBusy(false);
    }
  };

  const status = useStoreSelector((state) => run ? runStatus(run, state.sessions, workflow) : null);

  const back = () => navigate({ name: "runs" });
  if (!run) {
    const placeholder = detailPlaceholder("Run", { authoritative: snapshotLoaded, conn });
    return (
      <div className="run-detail">
        <DetailBar title={viewTitle({ name: "run", id: runId })} backLabel={backLabel("runs")} onBack={back} />
        <State
          variant={placeholder.variant}
          title={placeholder.title}
          actions={placeholder.actions.includes("back") && (
            <button type="button" className="btn primary" onClick={back}>{backLabel("runs")}</button>
          )}
        >
          {placeholder.hint}
        </State>
      </div>
    );
  }

  const members = run.sessionIds;
  // A phone shows one member: the one the URL names while it is still a member, else the first.
  const shownMember = member !== undefined && members.includes(member) ? member : members[0];
  const selectMember = (sessionId: string) => {
    // The choice replaces the entry rather than adding one, so Back still leaves the run.
    navigate({ name: "run", id: runId, member: sessionId }, { replace: true });
  };
  const onMemberTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = members.length - 1;
    const next = event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
        : event.key === "Home" ? 0
          : event.key === "End" ? last
            : null;
    if (next === null) return;
    event.preventDefault();
    flushSync(() => selectMember(members[next]!));
    document.getElementById(memberTabId(next))?.focus();
  };

  const runLink = dashboardOrigin ? absoluteViewUrl(dashboardOrigin, { name: "run", id: runId, ...(member ? { member } : {}) }) : null;
  const copyLink = async () => {
    if (!runLink) return;
    const copied = await writeClipboardText(runLink, () => true);
    if (copied === null) return;
    showToast(copied ? "Link copied." : "Couldn't copy the link.", { tone: copied ? "success" : "error" });
  };
  const typeLabel = workflow ? workflow.definition.name : workflowKnown ? "Comparison" : null;
  const started = `Started ${localDayLabel(run.createdAt, Date.now())}, ${formatClock(run.createdAt)}`;

  return (
    <div className="run-detail">
      <DetailBar
        title={viewTitle({ name: "run", id: runId }, run.title)}
        backLabel={backLabel("runs")}
        onBack={back}
        status={status && <StatusBadge meta={statusMeta("run", status)} />}
        menu={[
          { label: "Show Full Task", onClick: () => setTaskOpen(true) },
          {
            label: "Copy Link",
            disabled: !runLink,
            description: runLink ? undefined : DEVELOPMENT_BUILD ? `${NO_RUN_LINK_REASON} ${DEVELOPMENT_LINK_HINT}` : NO_RUN_LINK_REASON,
            onClick: () => void copyLink(),
          },
        ]}
      />
      <div className="run-task">
        <p className="run-task-prompt">{run.prompt}</p>
        <p className="run-task-meta">
          {typeLabel && <span>{typeLabel}</span>}
          {run.workspaceName && <span><ProjectsIcon size={14} aria-hidden="true" /><span>{run.workspaceName}</span></span>}
          <span><time dateTime={new Date(run.createdAt).toISOString()}>{started}</time></span>
          {!workflow && workflowKnown && <span>Each agent works in its own worktree</span>}
        </p>
      </div>
      {taskOpen && (
        <Modal title="Task" onClose={() => setTaskOpen(false)} footer={<button type="button" className="btn" onClick={() => setTaskOpen(false)}>Done</button>}>
          <p className="run-task-full">{run.prompt}</p>
        </Modal>
      )}

      {(workflow || workflowError) && (
        <section className="workflow-inspector" aria-label="Workflow Progress">
          <div className="workflow-inspector-head">
            <div>
              <strong>{workflow?.definition.name ?? "Workflow"}</strong>
              {workflow && <span> v{workflow.workflowVersion} · {workflow.transitionCount}/{workflow.definition.maxTransitions} Transitions</span>}
            </div>
            {workflow && <StatusBadge meta={statusMeta("workflow", workflow.status)} />}
          </div>
          {workflowError && <Notice tone="danger" compact>{workflowError}</Notice>}
          {workflow && (
            <div className="workflow-node-grid">
              {workflow.nodeStates.map((state) => {
                const node = workflow.definition.nodes.find((candidate) => candidate.nodeId === state.nodeId)!;
                const attempts = workflow.attempts.filter((attempt) => attempt.nodeId === state.nodeId);
                const latest = attempts.at(-1);
                const retryDelayed = Boolean(state.readyAt && state.readyAt > retryClock);
                return (
                  <article key={state.nodeId} className={`workflow-node workflow-node-${state.status}`}>
                    <div className="workflow-node-head">
                      <strong>{node.role}</strong>
                      <span>{titleCaseLabel(state.status.replace("_", " "))}</span>
                    </div>
                    <div className="muted sm">
                      {node.kind === "agent" ? `${node.agentId} · ${state.attemptCount}/${node.retry.maxAttempts} Attempts` : titleCaseLabel(node.kind.replace("_", " "))}
                    </div>
                    {state.outcome && <div className="workflow-node-outcome">Outcome: {titleCaseLabel(state.outcome.replace("_", " "))}</div>}
                    {latest && <div className="muted sm">Latest Attempt: {latest.status === "cancelled" ? "Canceled" : titleCaseLabel(latest.status.replace("_", " "))}</div>}
                    {state.error && <Notice tone="danger" compact>{state.error}</Notice>}
                    {node.kind === "agent" && state.status === "ready" && (
                      <button className="btn primary sm" disabled={Boolean(workflowBusy) || retryDelayed} onClick={() => void dispatchNode(node.nodeId, state.attemptCount)}>
                        {workflowBusy === node.nodeId ? "Dispatching…" : retryDelayed ? `Retry ${relativeTime(state.readyAt!)}` : "Dispatch Step"}
                      </button>
                    )}
                    {node.kind !== "agent" && state.status === "waiting_gate" && (
                      <div className="workflow-gate-actions">
                        <button className="btn primary sm" disabled={Boolean(workflowBusy)} onClick={() => void resolveGate(node.nodeId, "success")}>Continue</button>
                        <button className="btn ghost sm" disabled={Boolean(workflowBusy)} onClick={() => void resolveGate(node.nodeId, "failure")}>Stop Branch</button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {(artifacts.length > 0 || artifactError) && (
        <RunArtifacts
          artifacts={artifacts}
          more={Boolean(artifactCursor)}
          error={artifactError}
          pageBusy={artifactPageBusy}
          onLoadMore={() => void loadMoreArtifacts()}
          onOpen={setSelectedArtifact}
        />
      )}
      {selectedArtifact && <ArtifactPreviewDialog artifact={selectedArtifact} onClose={() => setSelectedArtifact(null)} />}

      {phone ? (
        // One member at a time under its tabs (§15.1); the column's head is the member bar.
        members.length > 0 && (
          <div className="compare-phone">
            <TabList label="Agents" className="compare-tabs">
              {members.map((sessionId, index) => (
                <MemberTab
                  key={sessionId}
                  sessionId={sessionId}
                  index={index}
                  selected={sessionId === shownMember}
                  onSelect={() => selectMember(sessionId)}
                  onKeyDown={(event) => onMemberTabKeyDown(event, index)}
                />
              ))}
            </TabList>
            {shownMember && (
              <MemberColumn
                key={shownMember}
                sessionId={shownMember}
                onRetry={retryHistory}
                panel={{ id: MEMBER_PANEL_ID, labelledBy: memberTabId(members.indexOf(shownMember)) }}
              />
            )}
          </div>
        )
      ) : (
        <CompareRow label="Agents">
          {members.map((sessionId) => <MemberColumn key={sessionId} sessionId={sessionId} onRetry={retryHistory} />)}
        </CompareRow>
      )}
    </div>
  );
}

/**
 * The run's artifacts (#2855): full-width two-line rows in one surface, each naming its kind, who
 * saved it, when and its size, with Show More for the next page. A row opens the preview dialog.
 */
function RunArtifacts({ artifacts, more, error, pageBusy, onLoadMore, onOpen }: {
  artifacts: readonly WorkflowArtifactView[];
  more: boolean;
  error: string | null;
  pageBusy: boolean;
  onLoadMore: () => void;
  onOpen: (artifact: WorkflowArtifactView) => void;
}) {
  const now = useTimelineClock(artifacts.length > 0);
  return (
    <section className="run-artifacts" aria-label="Workflow Artifacts">
      <h2 className="run-artifacts-head">Artifacts <span className="count">{artifacts.length}{more ? "+" : ""}</span></h2>
      {error && <Notice tone="danger" compact>{error}</Notice>}
      {artifacts.length > 0 && (
        <ul className="surface run-artifact-list">
          {artifacts.map((artifact) => (
            <li key={artifact.artifactId}>
              <ArtifactRow artifact={artifact} now={now} showAuthor onOpen={() => onOpen(artifact)} />
            </li>
          ))}
        </ul>
      )}
      {more && (
        <ListFoot>
          <BusyButton className="btn ghost sm" busy={pageBusy} progress="Loading more artifacts…" onClick={onLoadMore}>
            Show More
          </BusyButton>
        </ListFoot>
      )}
    </section>
  );
}
