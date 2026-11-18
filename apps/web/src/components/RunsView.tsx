import { BotIcon, CompareIcon, ProjectsIcon, ReplyIcon, RunsIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { State } from "./State.js";
import { StatusBadge, statusToneClass } from "./StatusBadge.js";
import { sessionStatusSignal, statusMeta } from "../status-meta.js";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { RunView, SessionView } from "@wollipog/protocol";
import { useStoreActions, useStoreSelector } from "../store.js";
import { formatClock, formatRecordedRelativeTime, localDayLabel } from "../format.js";
import { useApi } from "../api-context.js";
import { CompareMemberBody, CompareMemberHead, CompareRow } from "./CompareColumns.js";
import { useTimeline } from "./useTimeline.js";
import { sessionAgentLabel } from "./agent-options.js";
import { subscriptionRecoveryRevision } from "../ui-subscriptions.js";
import { recoverSessionHistories, sessionHistoryEpochKey } from "../history-recovery.js";
import { detailPlaceholder, listPlaceholder } from "../detail-placeholder.js";
import { selectComparisonEvents, selectComparisonHistory, selectComparisonSession } from "../comparison-selectors.js";
import { transcriptPresentation } from "../transcript-presentation.js";
import { DetailBar, PageHeader, type ActionsMenuChoice, type PageMenuAction } from "./PageHeader.js";
import { StaleContent } from "./StaleContent.js";
import { runStatus } from "../run-status.js";
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

const EMPTY_SESSION_IDS: string[] = [];
const NO_RUN_LINK_REASON = "Open Wollipog in a browser to copy a link.";
const DEVELOPMENT_LINK_HINT = "Development builds can set VITE_DASHBOARD_ORIGIN.";
const sameSessionIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);
const BACK_TO_MORE_ACTIONS = "Back to More Actions";
const NO_ANSWER_REASON = "No answer yet";

/** What the run page does for one member from its ⋯ (#2976). */
interface MemberActions {
  /** Follow Up with This Agent…: the dialog with only this member checked.  */
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
    // another member's tab) resolves null and reports nothing, a late success included.
    if (copied === null) return;
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
  const signal = sessionStatusSignal(session, { runnerOnline });
  const status = signal.meta;
  return (
    <button
      id={memberTabId(index)}
      title={signal.description}
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
  const now = useTimelineClock(list.length > 0);

  let body: ReactNode;
  const empty = list.length === 0 && snapshotLoaded && conn === "online";
  if (list.length === 0 && !empty) {
    // An empty map proves nothing before the first snapshot or while disconnected (§12.5).
    const placeholder = listPlaceholder("runs", conn);
    body = <State variant={placeholder.variant} pageLevel icon={<RunsIcon />} title={placeholder.title}>{placeholder.hint}</State>;
  } else if (empty) {
    body = (
      <State
        pageLevel
        icon={<RunsIcon />}
        title={`No ${runsDestination.name} Yet`}
        actions={<button type="button" className="btn primary" onClick={onNewRun}>New Run</button>}
      >
        Give the same task to multiple agents and compare what each one does.
      </State>
    );
  } else {
    // Disconnected with runs: the last-known rows stay, dimmed and still openable, under one line
    // that says why (§12.5). Never an empty state.
    const stale = conn !== "online";
    body = (
      <>
        {stale && <Notice compact tone="neutral" role="status" className="list-reconnecting">Reconnecting…</Notice>}
        <StaleContent stale={stale}>
          <div className="surface">
            {list.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                sessions={sessions}
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

const SHOWN_AGENTS = 3;

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
export function RunRow({ run, sessions, now, onOpen }: {
  run: RunView;
  sessions: ReadonlyMap<string, SessionView>;
  /** The shared clock the created time reads against. */
  now: number;
  onOpen: () => void;
}) {
  const status = runStatus(run, sessions);
  const agents = runAgentsLabel(run, sessions);
  const created = new Date(run.createdAt);
  return (
    <button type="button" className="row row-2" onClick={onOpen}>
      <span className="row-icon" aria-hidden="true">
        <CompareIcon size={16} />
      </span>
      <span className="row-body list-row-body">
        <span className="row-title" title={run.title}>{run.title}</span>
        {status && <StatusBadge meta={statusMeta("run", status)} className="list-row-status" />}
        <span className="row-sub list-row-meta">
          <span className="list-row-lead">Comparison</span>
          {run.workspaceName && (
            <span><ProjectsIcon size={14} aria-hidden="true" /><span>{run.workspaceName}</span></span>
          )}
          {agents && <span className="list-row-fill"><BotIcon size={14} aria-hidden="true" /><span>{agents}</span></span>}
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
 * reuse one instance and show the previous run's state. */
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

  const status = useStoreSelector((state) => run ? runStatus(run, state.sessions) : null);

  const back = () => navigate({ name: "runs" });
  if (!run) {
    const placeholder = detailPlaceholder("Run", { authoritative: snapshotLoaded, conn });
    return (
      <div className="run-detail">
        <DetailBar title={viewTitle({ name: "run", id: runId })} backLabel={backLabel("runs")} onBack={back} />
        <State
          variant={placeholder.variant}
          pageLevel
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
      meta: sessionStatusSignal(session, { runnerOnline: runner?.status !== "offline" }).meta,
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
    followUp: () => setFollowUp({ preselect: sessionId }),
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
    if (copied === null) return;
    // The fallback's selection dropped focus; hand it back to ⋯.
    if (unclaimed()) invoker?.focus();
    showToast(copied ? "Link copied." : "Couldn't copy the link.", { tone: copied ? "success" : "error" });
  };
  const started = `Started ${localDayLabel(run.createdAt, Date.now())}, ${formatClock(run.createdAt)}`;

  return (
    <div className="run-detail">
      <DetailBar
        title={viewTitle({ name: "run", id: runId }, run.title)}
        backLabel={backLabel("runs")}
        onBack={back}
        status={status && <StatusBadge meta={statusMeta("run", status)} />}
        // In the compact tier and on a phone only its icon shows, so the run's title keeps its room.
        primary={members.length > 0 ? { label: "Follow Up…", icon: <ReplyIcon />, iconOnPhone: true, onClick: () => setFollowUp({}) } : undefined}
        menu={[
          { label: "Show Full Task", onClick: () => setTaskOpen(true) },
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
          <span>Comparison</span>
          {run.workspaceName && <span><ProjectsIcon size={14} aria-hidden="true" /><span>{run.workspaceName}</span></span>}
          <span><time dateTime={new Date(run.createdAt).toISOString()}>{started}</time></span>
          <span>Each agent works in its own worktree</span>
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

      {phone ? (
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
