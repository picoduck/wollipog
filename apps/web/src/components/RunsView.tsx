import { BotIcon, CompareIcon, ProjectsIcon, ReplyIcon, RunsIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { State } from "./State.js";
import { StatusBadge, statusToneClass } from "./StatusBadge.js";
import { sessionStatusSummary, statusMeta } from "../status-meta.js";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { RunView, SessionView, WorkflowArtifactView, WorkflowInstanceDetail } from "@wollipog/protocol";
import { useStoreActions, useStoreSelector } from "../store.js";
import { formatClock, formatRecordedRelativeTime, localDayLabel, titleCaseLabel } from "../format.js";
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
import { DetailBar, PageHeader, type ActionsMenuChoice, type PageMenuAction } from "./PageHeader.js";
import { StaleContent } from "./StaleContent.js";
import { indexRunWorkflows, runStatus, runType, runTypeLabel, type RunWorkflows } from "../run-status.js";
import { absoluteViewUrl, backLabel, destination, viewTitle } from "../navigation.js";
import { useTimelineClock } from "../timeline-clock.js";
import { memberActivity, memberActivityLine } from "../member-activity.js";
import { useIsMobile } from "./useIsMobile.js";
import { TabList } from "./Tabs.js";
import { Modal } from "./Modal.js";
import { ConfirmationFailure, useFeedback } from "./FeedbackProvider.js";
import { followUpSentMessage, RunFollowUpDialog } from "./RunFollowUpDialog.js";
import {
  followUpAvailability,
  followUpSelectable,
  memberFinalAnswer,
  namesSentence,
  promptRunMembers,
  runMemberLabels,
  stopAgentUnavailableReason,
} from "../run-members.js";
import { useDashboardPublicOrigin } from "../remote-access-context.js";
import { writeClipboardText } from "../clipboard.js";
import { DEVELOPMENT_BUILD } from "../config.js";
import { artifactNoun, attentionStepId, gateInput, rolesSentence, stepsAfter, workflowSteps, type WorkflowStep } from "../workflow-steps.js";
import { WorkflowStepPanel, WorkflowSteps, workflowSummary } from "./WorkflowRun.js";

const EMPTY_SESSION_IDS: string[] = [];
const NO_RUN_LINK_REASON = "Open Wollipog in a browser to copy a link.";
const DEVELOPMENT_LINK_HINT = "Development builds can set VITE_DASHBOARD_ORIGIN.";
const sameSessionIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);
const BACK_TO_MORE_ACTIONS = "Back to More Actions";
const NO_ANSWER_REASON = "No answer yet";

/** What the run page does for one member from its ⋯ (#2976). */
interface MemberActions {
  /** Follow Up with This Agent…: the dialog with only this member checked. A workflow run has none,
   * since its steps prompt its agents (#2977). */
  followUp?: () => void;
  /** Stop Agent…: the confirmation, whose phone Back reopens the ⋯ it came from. */
  stop: (choice: ActionsMenuChoice) => void;
}

/** One member's live column (§12.5's reading column, #2975). Its own component so each member
 * subscribes to ITS event slice and folds incrementally — a 4-agent compare no longer re-derives
 * four full timelines per streamed chunk of any one of them. */
function MemberColumn({ sessionId, label, actions, onRetry, panel }: {
  sessionId: string;
  /** The member's name on this run's page, which tells two members of one agent apart. */
  label: string;
  actions: MemberActions;
  /** Loads the run's member histories again after a failure. */
  onRetry: () => void;
  /** On a phone, the one column is the member tabs' panel. */
  panel?: { id: string; labelledBy: string };
}) {
  const { navigate } = useStoreActions();
  const { showToast } = useFeedback();
  // Set in the effect body, so StrictMode's simulated unmount and remount leave it true.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const session = useStoreSelector((state) => selectComparisonSession(state, sessionId));
  const evs = useStoreSelector((state) => selectComparisonEvents(state, sessionId));
  const history = useStoreSelector((state) => selectComparisonHistory(state, sessionId));
  // Only a machine known to be offline is Disconnected, as in the member's tab (§4.3).
  const runnerOnline = useStoreSelector((state) => session
    ? state.runners.get(session.runnerId)?.status !== "offline"
    : true);
  const runnerProtocol = useStoreSelector((state) => session ? state.runners.get(session.runnerId)?.protocolVersion : undefined);
  const conn = useStoreSelector((state) => state.conn);
  const items = useTimeline(sessionId, evs, session?.eventEpoch ?? 0);
  const activity = useMemo(() => memberActivity(items), [items]);
  const answer = useMemo(() => memberFinalAnswer(items), [items]);
  if (!session) return null;
  const presentation = transcriptPresentation({ itemCount: items.length, hasOptimistic: false, working: false, history, conn });
  const agentLabel = label;
  const openSession = () => navigate({ name: "session", id: sessionId });
  const copyAnswer = async () => {
    if (!answer) return;
    // As Copy Link: ⋯ has handed focus back to its trigger, and a refused write falls back to a
    // selected field only while the column is mounted and focus is still there, or nowhere.
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unclaimed = () => document.activeElement === null || document.activeElement === document.body;
    const copied = await writeClipboardText(answer, () => mountedRef.current && (unclaimed() || document.activeElement === invoker));
    // A write that settles after the column has gone (the run left the page, or a phone moved to
    // another member's tab) reports nothing: a successful write never consults the currency check.
    if (copied === null || !mountedRef.current) return;
    if (unclaimed()) invoker?.focus();
    showToast(copied ? "Final answer copied as Markdown." : "Couldn't copy the final answer.", { tone: copied ? "success" : "error" });
  };
  const followUp = followUpAvailability(session);
  const stopReason = stopAgentUnavailableReason(session, { online: runnerOnline, protocolVersion: runnerProtocol });
  // The member's ⋯, the same in a desktop column's head and the phone's member bar.
  const menu: PageMenuAction[] = [
    { label: "Open Session", onClick: openSession },
    ...(actions.followUp ? [{
      label: "Follow Up with This Agent…",
      disabled: !followUpSelectable(followUp),
      description: "reason" in followUp ? followUp.reason : undefined,
      onClick: actions.followUp,
    }] : []),
    {
      label: "Copy Final Answer",
      disabled: !answer,
      description: answer ? undefined : NO_ANSWER_REASON,
      onClick: () => void copyAnswer(),
    },
    {
      label: "Stop Agent…",
      danger: true,
      disabled: stopReason !== null,
      description: stopReason ?? undefined,
      onClick: actions.stop,
    },
  ];
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
        menu={menu}
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
// A workflow run's phone tabs (#2977): Steps, then one per agent step.
const STEPS_TAB = "steps";
const activityTabKey = (nodeId: string) => `activity:${nodeId}`;
const workflowTabId = (index: number) => `run-workflow-tab-${index}`;
const WORKFLOW_PANEL_ID = "run-workflow-panel";

/** A phone's member tab: the agent and its status as a dot, named in words. */
function MemberTab({ sessionId, label, index, selected, onSelect, onKeyDown }: {
  sessionId: string;
  label: string;
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
      {label}
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
  const { showToast, confirm } = useFeedback();
  const dashboardOrigin = useDashboardPublicOrigin();
  const [taskOpen, setTaskOpen] = useState(false);
  // Follow Up…, from the bar (the members awaiting a prompt) or a member's ⋯ (only that member).
  const [followUp, setFollowUp] = useState<{ preselect?: string } | null>(null);
  // Set in the effect body, so StrictMode's simulated unmount and remount leave it true.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
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
  // Each member's agent in run order, then the names the page shows: two members of one agent are
  // numbered, the same on the tabs, the heads, Follow Up and the Stop confirmations (§10.1).
  const memberAgents = useStoreSelector(
    (state) => (state.runs.get(runId)?.sessionIds ?? EMPTY_SESSION_IDS).map((sessionId) => {
      const session = state.sessions.get(sessionId);
      return session ? sessionAgentLabel(session.agentName, session.driver, session.agentId) : "";
    }),
    sameSessionIds,
  );
  const memberLabels = useMemo(() => runMemberLabels(memberAgents), [memberAgents]);
  const sessions = useStoreSelector((state) => state.sessions);
  const runners = useStoreSelector((state) => state.runners);
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

  // A detail older than the one shown never replaces it: a load or a decision that answers after a
  // newer one has landed (the run's own refresh after a socket update) would bring a resolved gate back.
  const applyWorkflow = useCallback((detail: WorkflowInstanceDetail | null) => {
    setWorkflow((shown) => detail && shown && detail.instanceId === shown.instanceId && detail.updatedAt < shown.updatedAt ? shown : detail);
  }, []);

  const refreshWorkflow = async (targetRunId: string) => {
    const instances = await api.workflowInstances(targetRunId);
    if (!instances.length) {
      applyWorkflow(null);
      setWorkflowError(null);
      return;
    }
    const detail = await api.workflowInstance(instances[0]!.instanceId);
    applyWorkflow(detail);
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
        applyWorkflow(detail);
        setWorkflowKnown(true);
        setWorkflowError(null);
      })
      .catch((error: unknown) => { if (current) setWorkflowError((error as Error).message); });
    return () => { current = false; };
  }, [api, run?.id, run?.updatedAt, conn, applyWorkflow]);

  const steps = useMemo(
    () => workflow ? workflowSteps(workflow, run?.sessionIds ?? EMPTY_SESSION_IDS, (sessionId) => sessions.get(sessionId)?.title) : [],
    [workflow, run?.sessionIds, sessions],
  );
  // Until the person picks a step, the panel shows the one that needs them, and follows it.
  const [chosenStep, setChosenStep] = useState<string | null>(null);
  const selectedStep = steps.find((step) => step.nodeId === chosenStep) ?? steps.find((step) => step.nodeId === attentionStepId(steps)) ?? null;
  // A phone shows the steps or one agent step's activity under its tabs.
  const [phoneTab, setPhoneTab] = useState<string>(STEPS_TAB);

  // Start <Role> and Retry <Role>: one attempt per press, keyed so a repeated request is the same one.
  const dispatchNode = async (step: WorkflowStep) => {
    if (!workflow || workflowBusy) return;
    setWorkflowBusy(step.nodeId);
    try {
      await api.dispatchWorkflowNode(workflow.instanceId, step.nodeId, `ui:${workflow.instanceId}:${step.nodeId}:${step.state.attemptCount + 1}`);
      await refreshWorkflow(workflow.runId);
    } catch (error) {
      setWorkflowError((error as Error).message);
    } finally {
      setWorkflowBusy(null);
    }
  };

  const approveGate = async (step: WorkflowStep) => {
    if (!workflow || workflowBusy) return;
    setWorkflowBusy(step.nodeId);
    try {
      applyWorkflow(await api.resolveWorkflowGate(workflow.instanceId, step.nodeId, "success"));
      setWorkflowError(null);
    } catch (error) {
      setWorkflowError((error as Error).message);
    } finally {
      setWorkflowBusy(null);
    }
  };

  // Reject… asks first (§7.4). The confirmation waits on the decision and keeps a refusal in itself.
  const rejectGate = (step: WorkflowStep, artifact: WorkflowArtifactView | null) => {
    if (!workflow || workflowBusy) return;
    const instanceId = workflow.instanceId;
    const input = gateInput(step.node);
    const noun = input ? artifactNoun(input.kind) : null;
    const after = stepsAfter(step, steps, workflow.definition.edges, "failure");
    const what = artifact ? `“${artifact.name}”` : `The ${noun ?? "step"}`;
    void confirm({
      title: noun ? `Reject ${titleCaseLabel(noun)}` : `Reject ${step.role}`,
      message: after.length
        ? `${what} goes back to ${rolesSentence(after)}. This can't be undone.`
        : "The run ends here and later steps don't start. This can't be undone.",
      confirmLabel: "Reject",
      tone: "danger",
      progress: `Rejecting the ${noun ?? "step"}…`,
      onConfirm: async () => {
        applyWorkflow(await api.resolveWorkflowGate(instanceId, step.nodeId, "failure"));
        setWorkflowError(null);
      },
    });
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
  const labelOf = (sessionId: string) => memberLabels[members.indexOf(sessionId)] || "This agent";
  const memberStatus = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return null;
    const runner = runners.get(session.runnerId);
    return {
      session,
      meta: sessionStatusSummary(session, { runnerOnline: runner?.status !== "offline" }).primary.meta,
      stopReason: stopAgentUnavailableReason(session, { online: runner?.status !== "offline", protocolVersion: runner?.protocolVersion }),
    };
  };
  // The members whose current turn Stop All Agents can stop.
  const running = members.filter((sessionId) => memberStatus(sessionId)?.stopReason === null);
  const stopAgent = (sessionId: string, { reopen }: ActionsMenuChoice) => {
    void confirm({
      title: "Stop Agent",
      message: `${labelOf(sessionId)} stops its current turn in “${run.title}”. Its work so far is kept.`,
      confirmLabel: "Stop Agent",
      tone: "danger",
      // On a phone the confirmation replaces the member's ⋯ sheet, and Back brings it back (§7.5).
      back: { label: BACK_TO_MORE_ACTIONS, run: reopen },
      progress: "Stopping the agent…",
      onConfirm: async () => { await api.cancelTurn(sessionId); },
    });
  };
  const stopAll = ({ reopen }: ActionsMenuChoice) => {
    // Each attempt stops only the members not stopped yet, so Try Again after a partial failure
    // never stops a member twice.
    let remaining = running;
    void confirm({
      title: "Stop All Agents",
      message: `Each agent below stops its current turn in “${run.title}”. Their work so far is kept.`,
      detailRows: running.map((sessionId) => ({ label: labelOf(sessionId), status: memberStatus(sessionId)?.meta })),
      confirmLabel: "Stop All Agents",
      tone: "danger",
      back: { label: BACK_TO_MORE_ACTIONS, run: reopen },
      progress: "Stopping the agents…",
      onConfirm: async () => {
        const targets = remaining;
        const settled = await Promise.allSettled(targets.map((sessionId) => api.cancelTurn(sessionId)));
        const failures = targets.flatMap((sessionId, index) => {
          const outcome = settled[index]!;
          if (outcome.status === "fulfilled") return [];
          const reason = outcome.reason;
          return [{ sessionId, error: reason instanceof Error && reason.message ? reason.message : "The stop failed." }];
        });
        remaining = failures.map((failure) => failure.sessionId);
        if (!failures.length) return;
        throw new ConfirmationFailure(
          `Couldn't stop ${namesSentence(failures.map((failure) => labelOf(failure.sessionId)))}. Try again, or open ${failures.length === 1 ? "its session" : "their sessions"}.`,
          failures.map((failure) => `${labelOf(failure.sessionId)}: ${failure.error}`).join("\n"),
        );
      },
    });
  };
  const memberActions = (sessionId: string): MemberActions => ({
    // A workflow's steps prompt its agents, so its page offers no Follow Up (#2977).
    ...(workflow ? {} : { followUp: () => setFollowUp({ preselect: sessionId }) }),
    stop: (choice: ActionsMenuChoice) => stopAgent(sessionId, choice),
  });
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
    // ⋯ has closed and handed focus back to its trigger. A refused write falls back to a selected
    // field only while the copy still owns the interaction: the run is mounted and focus is still
    // on that trigger, or nowhere. A refusal can be synchronous (no Clipboard API on plain HTTP).
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unclaimed = () => document.activeElement === null || document.activeElement === document.body;
    const copyStillCurrent = () => mountedRef.current && (unclaimed() || document.activeElement === invoker);
    const copied = await writeClipboardText(runLink, copyStillCurrent);
    // Nothing is reported once the run has left the page, including a write that succeeded late.
    if (copied === null || !mountedRef.current) return;
    // The fallback's selection dropped focus; hand it back to ⋯.
    if (unclaimed()) invoker?.focus();
    showToast(copied ? "Link copied." : "Couldn't copy the link.", { tone: copied ? "success" : "error" });
  };
  const typeLabel = workflow ? workflow.definition.name : workflowKnown ? "Comparison" : null;
  const started = `Started ${localDayLabel(run.createdAt, Date.now())}, ${formatClock(run.createdAt)}`;

  const runArtifacts = (artifacts.length > 0 || artifactError) && (
    <RunArtifacts
      artifacts={artifacts}
      more={Boolean(artifactCursor)}
      error={artifactError}
      pageBusy={artifactPageBusy}
      onLoadMore={() => void loadMoreArtifacts()}
      onOpen={setSelectedArtifact}
    />
  );

  // A workflow run (#2977): its agent steps, each with its member's name on this page when known.
  const agentSteps = steps.filter((step) => step.node.kind === "agent");
  const agentOf = (step: WorkflowStep) => step.sessionId && members.includes(step.sessionId)
    ? memberLabels[members.indexOf(step.sessionId)] || null
    : null;
  // The main column shows the selected agent step's activity; with a gate selected, the agent step
  // before it, whose work the gate decides on.
  const activityStep = selectedStep?.node.kind === "agent" ? selectedStep
    : (selectedStep ? [...agentSteps].reverse().find((step) => step.number < selectedStep.number) : undefined) ?? agentSteps[0] ?? null;
  const workflowActivity = (step: WorkflowStep | null, panel?: { id: string; labelledBy: string }) => (
    <div className="wf-main">
      {step?.sessionId && sessions.has(step.sessionId) ? (
        <MemberColumn
          key={step.sessionId}
          sessionId={step.sessionId}
          label={labelOf(step.sessionId)}
          actions={memberActions(step.sessionId)}
          onRetry={retryHistory}
          panel={panel}
        />
      ) : (
        <div className="wf-main-empty" id={panel?.id} role={panel ? "tabpanel" : undefined} aria-labelledby={panel?.labelledBy}>
          <State compact title="No Activity Yet">
            {step ? "This step's session isn't known yet." : "This workflow has no agent steps."}
          </State>
        </div>
      )}
    </div>
  );
  const workflowSide = workflow && (
    <>
      {workflowError && <Notice tone="danger" compact>{workflowError}</Notice>}
      {workflow.eventHistoryPruned && (
        <Notice tone="neutral" compact title="Event History Pruned">
          {workflow.eventHistoryPruned.eventCount.toLocaleString()} workflow events were removed by the {workflow.eventHistoryPruned.retentionDays}-day retention policy. Instance summaries, node outcomes, attempts, artifacts, decisions and action receipts are kept.
        </Notice>
      )}
      <WorkflowSteps steps={steps} selectedId={selectedStep?.nodeId ?? null} agentOf={agentOf} onSelect={setChosenStep} />
      <p className="wf-summary">{workflowSummary(workflow)}</p>
      {selectedStep && (
        <WorkflowStepPanel
          step={selectedStep}
          steps={steps}
          workflow={workflow}
          agent={agentOf(selectedStep)}
          artifacts={artifacts}
          now={retryClock}
          busy={workflowBusy}
          actions={{
            dispatch: (step) => void dispatchNode(step),
            approve: (step) => void approveGate(step),
            reject: rejectGate,
            openArtifact: setSelectedArtifact,
          }}
        />
      )}
      {runArtifacts}
    </>
  );
  // Steps, then one tab per agent step. An activity tab's key is prefixed, so no node id (even
  // "steps") can share a key with the Steps tab.
  const phoneTabs: Array<{ id: string; label: string; step: WorkflowStep | null }> = [
    { id: STEPS_TAB, label: "Steps", step: null },
    ...agentSteps.map((step) => ({ id: activityTabKey(step.nodeId), label: `${step.role} Activity`, step })),
  ];
  const shownTab = phoneTabs.find((tab) => tab.id === phoneTab) ?? phoneTabs[0]!;
  const shownPhoneTab = shownTab.id;
  const onWorkflowTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = phoneTabs.length - 1;
    const next = event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
        : event.key === "Home" ? 0
          : event.key === "End" ? last
            : null;
    if (next === null) return;
    event.preventDefault();
    flushSync(() => setPhoneTab(phoneTabs[next]!.id));
    document.getElementById(workflowTabId(next))?.focus();
  };
  // Open <Role> Session for each agent step, in step order.
  const openStepItems: PageMenuAction[] = agentSteps.map((step) => ({
    label: `Open ${step.role} Session`,
    disabled: !step.sessionId,
    description: step.sessionId ? undefined : "Its agent isn't known yet",
    onClick: () => { if (step.sessionId) navigate({ name: "session", id: step.sessionId }); },
  }));

  return (
    <div className="run-detail">
      <DetailBar
        title={viewTitle({ name: "run", id: runId }, run.title)}
        backLabel={backLabel("runs")}
        onBack={back}
        status={status && <StatusBadge meta={statusMeta("run", status)} />}
        // In the compact tier and on a phone only its icon shows, so the run's title keeps its room.
        // A workflow's steps prompt its agents, so it has no Follow Up (#2977).
        primary={members.length > 0 && !workflow ? { label: "Follow Up…", icon: <ReplyIcon />, iconOnPhone: true, onClick: () => setFollowUp({}) } : undefined}
        menu={[
          { label: "Show Full Task", onClick: () => setTaskOpen(true) },
          ...openStepItems,
          {
            label: "Copy Link",
            disabled: !runLink,
            description: runLink ? undefined : DEVELOPMENT_BUILD ? `${NO_RUN_LINK_REASON} ${DEVELOPMENT_LINK_HINT}` : NO_RUN_LINK_REASON,
            onClick: () => void copyLink(),
          },
          // Only while a member's turn runs; it lists those members and stops only them.
          ...(running.length > 0 ? [{ label: "Stop All Agents…", danger: true, onClick: stopAll }] : []),
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
      {followUp && (
        <RunFollowUpDialog
          members={members.map((sessionId) => ({ sessionId, label: labelOf(sessionId) }))}
          preselect={followUp.preselect}
          send={(sessionIds, text) => promptRunMembers((sessionId, message) => api.prompt(sessionId, message), sessionIds, text)}
          onSent={(count) => showToast(followUpSentMessage(count), { tone: "success" })}
          onClose={() => setFollowUp(null)}
        />
      )}

      {!workflow && workflowError && <Notice tone="danger" compact className="run-workflow-error">{workflowError}</Notice>}
      {!workflow && runArtifacts}
      {selectedArtifact && <ArtifactPreviewDialog artifact={selectedArtifact} onClose={() => setSelectedArtifact(null)} />}

      {workflow ? (phone ? (
        // The steps, or one agent step's activity, under the tabs (§15.1).
        <div className="wf-phone">
          <TabList label="Workflow" className="compare-tabs">
            {phoneTabs.map((tab, index) => (
              <button
                key={tab.id}
                id={workflowTabId(index)}
                type="button"
                role="tab"
                aria-selected={tab.id === shownPhoneTab}
                aria-controls={WORKFLOW_PANEL_ID}
                tabIndex={tab.id === shownPhoneTab ? 0 : -1}
                className="tab compare-tab"
                onClick={() => setPhoneTab(tab.id)}
                onKeyDown={(event) => onWorkflowTabKeyDown(event, index)}
              >
                {tab.label}
              </button>
            ))}
          </TabList>
          {shownTab.step === null ? (
            <div className="wf-side" id={WORKFLOW_PANEL_ID} role="tabpanel" aria-labelledby={workflowTabId(0)}>{workflowSide}</div>
          ) : workflowActivity(
            shownTab.step,
            { id: WORKFLOW_PANEL_ID, labelledBy: workflowTabId(phoneTabs.indexOf(shownTab)) },
          )}
        </div>
      ) : (
        // The steps beside the agent step's activity, flush with the page's left edge.
        <div className="wf-run">
          <section className="wf-side" aria-label="Workflow Progress">{workflowSide}</section>
          {workflowActivity(activityStep)}
        </div>
      )) : phone ? (
        // One member at a time under its tabs (§15.1); the column's head is the member bar.
        members.length > 0 && (
          <div className="compare-phone">
            <TabList label="Agents" className="compare-tabs">
              {members.map((sessionId, index) => (
                <MemberTab
                  key={sessionId}
                  sessionId={sessionId}
                  label={labelOf(sessionId)}
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
                label={labelOf(shownMember)}
                actions={memberActions(shownMember)}
                onRetry={retryHistory}
                panel={{ id: MEMBER_PANEL_ID, labelledBy: memberTabId(members.indexOf(shownMember)) }}
              />
            )}
          </div>
        )
      ) : (
        <CompareRow label="Agents">
          {members.map((sessionId) => (
            <MemberColumn key={sessionId} sessionId={sessionId} label={labelOf(sessionId)} actions={memberActions(sessionId)} onRetry={retryHistory} />
          ))}
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
