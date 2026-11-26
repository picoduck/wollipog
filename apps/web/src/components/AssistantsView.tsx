import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useApi } from "../api-context.js";
import type { ApiClient } from "../api.js";
import { assistantThreadProblems } from "../assistant-thread-health.js";
import { threadSpendingCopy, threadSpendingStates } from "../assistant-thread-spending.js";
import {
  applyAssistantThreadEvents,
  ASSISTANT_THREAD_TITLE_MAX,
  assistantThreadHarnessLabel,
  assistantThreadsOwnerOnly,
  assistantThreadsUnavailable,
  assistantThreadTitle,
  sortAssistantThreads,
  type AssistantThread,
} from "../assistant-threads.js";
import { useReportEntityTitle } from "../entity-title.js";
import { effortLabel, relativeTime, resolvedModelLabel } from "../format.js";
import { backLabel, destination } from "../navigation.js";
import { statusMeta } from "../status-meta.js";
import { sessionDisplayTitle } from "../session-title.js";
import { useStoreActions, useStoreSelector, useStoreValueSource } from "../store.js";
import { useTimelineClock } from "../timeline-clock.js";
import { AssistantTranscriptContext } from "./AssistantTranscriptReceipts.js";
import { AssistantWaitingDock, type AssistantWaitingDockHandle } from "./AssistantWaitingDock.js";
import { AssistantSpendingNotice } from "./AssistantSpendingNotice.js";
import { AssistantThreadLimitsDialog } from "./AssistantThreadLimitsDialog.js";
import { AssistantDecisionDelegationDialog } from "./AssistantDecisionDelegationDialog.js";
import { useLaunchedWorkGroups } from "./AssistantWorkCards.js";
import type { LaunchedWork } from "../assistant-launched-work.js";
import { ConfirmationFailure, useFeedback } from "./FeedbackProvider.js";
import { AgentIcon } from "./AgentIcon.js";
import { AssistantsIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon, SearchIcon } from "./Icons.js";
import { ListFoot } from "./ListFoot.js";
import { Modal } from "./Modal.js";
import { NewAssistantThreadDialog, THREADS_UNAVAILABLE_MESSAGE, type NewAssistantThreadResult } from "./NewAssistantThreadDialog.js";
import { Notice } from "./Notice.js";
import { ActionsMenu, DetailBar, PageHeader, type ActionsMenuChoice, type PageMenuAction } from "./PageHeader.js";
import { SessionDetail } from "./SessionDetail.js";
import { compareSessionNotices, SESSION_NOTICE_RANK, type SessionNoticeEntry } from "./SessionNoticeSlot.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";
import { AssistantThreadPanel } from "./AssistantThreadPanel.js";
import { useAssistantPanelState } from "./assistant-panel-state.js";
import { matchesShortcut, shortcutLayerActive } from "../shortcuts.js";
import type { RightPanelMode } from "../right-panel.js";
import type { RightPanelState } from "./right-panel-state.js";
import { useIsMobile } from "./useIsMobile.js";
import { SidePanelToggle } from "./SessionPanelToggles.js";

const ASSISTANTS = destination("assistants");
/** How often the list is read while a thread is working, as a net under the thread events. */
const WORKING_POLL_MS = 15_000;
/** Keep a thread's warning dismissed while navigating elsewhere in this browser tab. */
const dismissedBudgetsByClient = new WeakMap<ApiClient, ReadonlyMap<string, number>>();
const NO_DISMISSED_BUDGETS: ReadonlyMap<string, number> = new Map();

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; threads: AssistantThread[] }
  | { kind: "unavailable" }
  /** The control plane refuses everyone but an organization owner (403), in its own words. */
  | { kind: "ownerOnly"; message: string }
  | { kind: "failed"; message: string };

/** Whether the store still holds every event after `afterSeq`: none was dropped from the front of
 * its capped log before this reader could apply it. */
function replayComplete(kept: readonly { seq: number }[], afterSeq: number): boolean {
  return kept.length === 0 || kept[0]!.seq <= afterSeq + 1;
}

/**
 * The Assistants section (#4664): threads listed newest activity first
 * with New Thread, and the open thread beside them. On a phone the list and the thread are two
 * routes. Every thread comes from the Thread API; a control plane without it (404) shows the empty
 * section and New Thread explains, never a failure.
 */
export function AssistantsView({ threadId, limits, delegation, newThread, rightPanel }: {
  threadId?: string;
  limits?: true | "spending";
  delegation?: true;
  newThread?: true;
  /** Opens a session tool if the conversation offers a link to one. */
  rightPanel: RightPanelState;
}) {
  const api = useApi();
  const { navigate, dispatch, getSession, loadSession } = useStoreActions();
  const currentView = useStoreValueSource((state) => state.view);
  const { confirm, showToast } = useFeedback();
  const isMobile = useIsMobile();
  const conn = useStoreSelector((state) => state.conn);
  const runners = useStoreSelector((state) => state.runners);
  const [accountSettingsFor, setAccountSettingsFor] = useState<string | null>(null);
  const panel = useAssistantPanelState();
  const waitingDock = useRef<AssistantWaitingDockHandle>(null);
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [showArchive, setShowArchive] = useState(false);
  /** A deep link that the list doesn't carry, read on its own. */
  const [extra, setExtra] = useState<AssistantThread | null>(null);
  const [missing, setMissing] = useState(false);
  const [renaming, setRenaming] = useState<AssistantThread | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [budgetDismissal, setBudgetDismissal] = useState(() => ({
    client: api,
    budgets: dismissedBudgetsByClient.get(api) ?? NO_DISMISSED_BUDGETS,
  }));
  const dismissedBudgets = budgetDismissal.client === api ? budgetDismissal.budgets
    : dismissedBudgetsByClient.get(api) ?? NO_DISMISSED_BUDGETS;
  const generation = useRef(0);
  /** A read is in flight, and whether another was asked for while it was. */
  const reading = useRef(false);
  const rereadQueued = useRef<"all" | "active" | null>(null);
  // The control plane publishes each thread change (`assistant_thread_upsert`); the store keeps the
  // newest of them, numbered. `appliedSeq` is the newest one the list reflects.
  const events = useStoreSelector((state) => state.assistantThreadEvents);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const appliedSeq = useRef(0);

  /** Reads the list, superseding any read still in flight: a mutation's reconciliation and Retry. */
  const load = useCallback(async (scope: "all" | "active" = "all") => {
    const mine = ++generation.current;
    reading.current = true;
    // Events that land while the read is in flight are newer than what it returns.
    const startSeq = eventsRef.current?.at(-1)?.seq ?? 0;
    try {
      const { threads } = await api.assistantThreads(scope === "all" ? { includeArchived: true } : undefined);
      if (mine === generation.current) {
        const kept = eventsRef.current ?? [];
        setList((previous) => {
          // A working-thread poll retains the archive from full reads and live upserts.
          const listed = new Set(threads.map((thread) => thread.id));
          const archives = scope === "active" && previous.kind === "ready"
            ? previous.threads.filter((thread) => thread.status === "archived" && !listed.has(thread.id))
            : [];
          return { kind: "ready", threads: applyAssistantThreadEvents([...threads, ...archives], kept, startSeq) };
        });
        appliedSeq.current = Math.max(appliedSeq.current, kept.at(-1)?.seq ?? 0);
        // More changed during the read than the store kept: what was dropped may be one this read
        // predates, so read again once this one has landed.
        if (!replayComplete(kept, startSeq)) rereadQueued.current = "all";
      }
    } catch (cause) {
      if (mine !== generation.current) return;
      const ownerOnly = assistantThreadsOwnerOnly(cause);
      if (assistantThreadsUnavailable(cause)) setList({ kind: "unavailable" });
      else if (ownerOnly !== null) setList({ kind: "ownerOnly", message: ownerOnly });
      // A failed refresh keeps the rows it has; only a first read fails the list.
      else setList((previous) => previous.kind === "ready"
        ? previous
        : { kind: "failed", message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      if (mine === generation.current) {
        reading.current = false;
        // Activity during the read asked for a newer list: read once more, now that this one landed.
        if (rereadQueued.current) {
          const scope = rereadQueued.current;
          rereadQueued.current = null;
          void load(scope);
        }
      }
    }
  }, [api]);
  /** A background refresh: behind a read in flight it waits its turn rather than discarding it, so a
   * session that streams faster than the list answers still sees each answer land. */
  const refresh = useCallback((scope: "all" | "active" = "all") => {
    if (reading.current) {
      if (scope === "all" || rereadQueued.current === null) rereadQueued.current = scope;
    } else void load(scope);
  }, [load]);

  useEffect(() => { void load(); }, [load]);
  // A reconnect may have missed changes.
  useEffect(() => { if (conn === "online") refresh(); }, [conn, refresh]);

  const threads = list.kind === "ready" ? list.threads : [];
  const listed = threadId === undefined ? undefined : threads.find((thread) => thread.id === threadId);
  const selectedThread = listed ?? (extra?.id === threadId ? extra : undefined);
  const selected = selectedThread;
  const problemsFor = (thread: AssistantThread) => assistantThreadProblems(thread, conn,
    thread.runnerId ? runners.get(thread.runnerId) : undefined);
  const badgeFor = (thread: AssistantThread, hideDone = false) => threadStatusBadge(thread, problemsFor(thread)[0], hideDone);
  const model = useStoreSelector((state) => {
    const backing = selected ? state.sessions.get(selected.sessionId) : undefined;
    return backing?.resolvedModel ?? backing?.model;
  });
  const effort = useStoreSelector((state) => selected ? state.sessions.get(selected.sessionId)?.effort : undefined);
  const canTogglePanel = useStoreSelector((state) => Boolean(selected && state.sessions.has(selected.sessionId)));
  const togglePanel = panel.toggle;
  useEffect(() => {
    // There is no key listener on the loading or missing view, even when a saved panel is open.
    if (!canTogglePanel) return;
    const onKey = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, "toggle-side-panel") || event.defaultPrevented ||
          shortcutLayerActive(document, false, event)) return;
      event.preventDefault();
      togglePanel();
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.assistant-thread-panel [aria-selected="true"]')?.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canTogglePanel, togglePanel]);
  // The window title names the open thread.
  useReportEntityTitle(
    threadId === undefined ? { name: "assistants", newThread } : { name: "assistants", threadId, limits, delegation },
    selected ? assistantThreadTitle(selected) : null,
  );

  // A deep link to a thread the list doesn't carry: read that thread alone, and
  // again whenever the event log can no longer say what changed it (`extraRevision`).
  const [extraRevision, setExtraRevision] = useState(0);
  useEffect(() => {
    setMissing(false);
    if (threadId === undefined || list.kind !== "ready" || listed) return;
    let current = true;
    const startSeq = eventsRef.current?.at(-1)?.seq ?? 0;
    void api.assistantThread(threadId).then(({ thread }) => {
      if (!current) return;
      // As for the list: a change published while the read was in flight is newer than the read.
      const kept = eventsRef.current ?? [];
      const newer = [...kept].reverse().find((event) => event.seq > startSeq && event.thread.id === thread.id);
      setExtra(newer ? newer.thread : thread);
      if (!replayComplete(kept, startSeq)) setExtraRevision((revision) => revision + 1);
    }, () => { if (current) setMissing(true); });
    return () => { current = false; };
  }, [api, threadId, list.kind, listed, extraRevision]);

  // Thread changes arrive as events: status, title, activity and each session the assistant
  // launches. Applied in order to the list and to a thread read on its own.
  useEffect(() => {
    const kept = events ?? [];
    const from = appliedSeq.current;
    const newest = kept.at(-1)?.seq ?? 0;
    if (newest <= from) return;
    appliedSeq.current = newest;
    // More changed than the store kept since the last render: read the list and any deep link it missed.
    if (!replayComplete(kept, from)) {
      refresh();
      setExtraRevision((revision) => revision + 1);
      return;
    }
    setList((previous) => previous.kind !== "ready" ? previous
      : { kind: "ready", threads: applyAssistantThreadEvents(previous.threads, kept, from) });
    setExtra((previous) => {
      if (!previous) return previous;
      const latest = [...kept].reverse().find((event) => event.seq > from && event.thread.id === previous.id);
      return latest ? latest.thread : previous;
    });
  }, [events, refresh]);
  // Launched work can outlive its Assistant's turn. Refresh accumulated usage while that work
  // is active, then read its final cost once without continuing to poll an idle thread.
  const launchedWorkActive = useStoreSelector((state) => Boolean(selected?.usage && selected.status !== "archived" &&
    selected.launchedSessionIds.some((id) => {
      const status = state.sessions.get(id)?.status;
      return status === "queued" || status === "starting" || status === "running";
    })));
  const wasLaunchedWorkActive = useRef(false);
  useEffect(() => {
    if (wasLaunchedWorkActive.current && !launchedWorkActive) refresh("active");
    wasLaunchedWorkActive.current = launchedWorkActive;
  }, [launchedWorkActive, refresh]);
  const refreshInBackground = launchedWorkActive || threads.some((thread) => thread.status === "working");
  useEffect(() => {
    if (!dismissedBudgets.size) return;
    // A fresh warning band (including one created by raising the budget) can warn again.
    const next = new Map(dismissedBudgets);
    for (const thread of threads) {
      if (next.has(thread.id) && !threadSpendingStates(thread).some(
        (state) => state.kind === "near_budget" && state.limit === next.get(thread.id),
      )) next.delete(thread.id);
    }
    if (next.size !== dismissedBudgets.size) {
      dismissedBudgetsByClient.set(api, next);
      setBudgetDismissal({ client: api, budgets: next });
    }
  }, [api, dismissedBudgets, threads]);
  useEffect(() => {
    if (!refreshInBackground) return;
    const timer = setInterval(() => refresh("active"), WORKING_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshInBackground, refresh]);

  // The open thread's backing session streams live while it is open.
  const backingSessionId = selected?.sessionId ?? null;
  useEffect(() => {
    dispatch({ type: "assistant_thread_session", sessionId: backingSessionId });
    return () => dispatch({ type: "assistant_thread_session", sessionId: null });
  }, [dispatch, backingSessionId]);

  /** Shows a mutation's result at once, then reads the list again. The read supersedes any read
   * still in flight, which began before the mutation and would otherwise put the old thread back. */
  const replace = (thread: AssistantThread) => {
    setList((previous) => previous.kind !== "ready" ? previous : {
      kind: "ready",
      threads: sortAssistantThreads([thread, ...previous.threads.filter((candidate) => candidate.id !== thread.id)]),
    });
    void load();
  };

  const openThread = (id: string) => navigate({ name: "assistants", threadId: id });
  const openThreadSettings = (id: string, section: true | "spending" = true) =>
    navigate({ name: "assistants", threadId: id, limits: section });
  const toList = () => navigate({ name: "assistants" });
  const cancelNewThread = () => navigate({ name: "assistants" }, { replace: true });
  const startThread = () => navigate({ name: "assistants", newThread: true });
  // The new thread opens ready for its first message, as a new session does.
  // Only while New Thread is still what the person is looking at: creation can finish after they
  // followed Assistant Settings or went Back, and the page they moved to stays theirs. The thread
  // is in the list either way.
  const finishNewThread = ({ thread, setupFailure }: NewAssistantThreadResult) => {
    replace(thread);
    const view = currentView.read();
    if (view.name === "assistants" && view.newThread) {
      setShowArchive(false);
      navigate({ name: "assistants", threadId: thread.id }, { replace: true });
    }
    if (setupFailure) showToast(setupFailure, { tone: "warning" });
  };

  const archive = async (thread: AssistantThread, reopen: () => void) => {
    let archived: AssistantThread | undefined;
    const accepted = await confirm({
      title: "Archive Thread",
      message: `“${assistantThreadTitle(thread)}” moves to Archived Threads, where you can still read it.`,
      confirmLabel: "Archive Thread",
      tone: "danger",
      back: { label: "Back to Thread Actions", run: reopen },
      progress: "Archiving the thread…",
      cancelWhileRunning: false,
      onConfirm: async () => {
        setArchiving(true);
        try {
          archived = (await api.archiveAssistantThread(thread.id)).thread;
        } catch (cause) {
          throw new ConfirmationFailure("Couldn't archive the thread.", cause instanceof Error ? cause.message : String(cause));
        } finally {
          setArchiving(false);
        }
      },
    });
    if (!accepted || !archived) return;
    replace(archived);
    showToast("Thread archived.", { tone: "success" });
    if (threadId === thread.id) navigate({ name: "assistants" }, { replace: true });
  };

  const threadMenu = (thread: AssistantThread): PageMenuAction[] => {
    const archived = thread.status === "archived";
    return [
      ...(archived ? [] : [{ label: "Rename…", onClick: () => setRenaming(thread) }]),
      {
        label: "Thread Settings…",
        description: "Account, harness, budget and delegation",
        onClick: () => openThreadSettings(thread.id),
      },
      {
        label: "Open as Session",
        description: "The full session view with Files and Terminal",
        separatorBefore: !archived,
        onClick: () => navigate({ name: "session", id: thread.sessionId }),
      },
      ...(archived ? [] : [{
        label: "Archive Thread…",
        danger: true,
        disabled: archiving,
        onClick: ({ reopen }: ActionsMenuChoice) => void archive(thread, reopen),
      }]),
    ];
  };

  const emptyInbox = list.kind === "ready" && threads.length === 0;
  const phoneDetail = isMobile && threadId !== undefined;
  // The open thread's launched work, for the header toggle and the Work tab. Kept
  // the same object while the thread's lists are, so their live counts don't recompute each render.
  const launchedSessionIds = selected?.launchedSessionIds;
  const canStopLaunched = useStoreSelector((state) => launchedSessionIds?.some((id) => {
    const session = state.sessions.get(id);
    return session?.status === "running" && !session.archived;
  }) ?? false);
  const stopLaunched = async (thread: AssistantThread) => {
    const targets = [...new Set(thread.launchedSessionIds)].flatMap((id) => {
      const session = getSession(id);
      return session?.status === "running" && !session.archived ? [{ id, label: sessionDisplayTitle(session.title) }] : [];
    });
    if (!targets.length) return;
    const remaining = new Set(targets.map(({ id }) => id));
    await confirm({
      title: "Stop Launched Sessions",
      message: "This stops the sessions below and cancels their queued prompts and background jobs. Their transcripts and worktrees are kept.",
      detailRows: targets,
      showAllDetailRows: true,
      confirmLabel: "Stop Sessions",
      tone: "danger",
      progress: "Stopping the sessions…",
      cancelWhileRunning: false,
      onConfirm: async () => {
        const results = await Promise.allSettled([...remaining].map(async (id) => {
          const session = getSession(id);
          if (session?.status === "running" && !session.archived) loadSession(await api.stop(id));
          remaining.delete(id);
        }));
        const failures = results.flatMap((result) => result.status === "rejected" ? [String(result.reason)] : []);
        if (failures.length) throw new ConfirmationFailure("Couldn't stop every listed session. Try again.", failures.join("\n"));
      },
    });
  };
  const spendingNotices: SessionNoticeEntry[] = selected ? threadSpendingStates(selected)
    .filter((state) => state.kind !== "near_budget" || dismissedBudgets.get(selected.id) !== state.limit)
    .map((state) => ({
      key: "assistant-spending:" + state.kind,
      severity: state.kind === "over_budget" ? "danger" : "warning",
      rank: state.kind === "near_budget" ? SESSION_NOTICE_RANK.assistantNearBudget
        : state.kind === "launch_limit" || state.kind === "launch_paused"
          ? SESSION_NOTICE_RANK.assistantLaunchLimit : SESSION_NOTICE_RANK.assistantBudget,
      title: threadSpendingCopy(state).title,
      render: ({ trailing }) => <AssistantSpendingNotice state={state} trailing={trailing}
        onRaise={() => openThreadSettings(selected.id, "spending")}
        onSettings={() => openThreadSettings(selected.id)}
        onStop={() => void stopLaunched(selected)}
        onBreakdown={() => panel.show("Details")}
        onDismiss={() => {
          if (state.kind !== "near_budget") return;
          const budgets = new Map(dismissedBudgets).set(selected.id, state.limit);
          dismissedBudgetsByClient.set(api, budgets);
          setBudgetDismissal({ client: api, budgets });
        }}
        canStop={canStopLaunched} />,
    })) : [];
  const launchedCampaignIds = selected?.launchedCampaignIds;
  const launchedWork = useMemo<LaunchedWork | undefined>(() => launchedSessionIds
    ? { sessionIds: launchedSessionIds, ...(launchedCampaignIds ? { campaignIds: launchedCampaignIds } : {}) }
    : undefined, [launchedSessionIds, launchedCampaignIds]);
  const showSessionTool = (mode: RightPanelMode) => {
    if (!selected) return;
    rightPanel.show(mode);
    navigate({ name: "session", id: selected.sessionId });
  };
  return (
    <section className="page full fill">
      {phoneDetail ? (
        <DetailBar
          title={selected ? assistantThreadTitle(selected) : "Thread"}
          backLabel={backLabel("assistants")}
          onBack={toList}
          status={selected ? badgeFor(selected, true) : undefined}
          menu={selected ? threadMenu(selected) : []}
          menuLabel="Thread Actions"
          menuSheetTitle={selected ? assistantThreadTitle(selected) : undefined}
          hideSearch={Boolean(selected)}
          controls={canTogglePanel && launchedWork
            ? <AssistantSidePanelToggle work={launchedWork} open={panel.open} onToggle={panel.toggle} />
            : undefined}
          renderTitle={selected ? (title) => <ThreadBarTitle title={title} phone /> : undefined}
        />
      ) : (
        // New Thread belongs to the assistant's Threads list, so the page header offers no second one.
        <PageHeader title={ASSISTANTS.name} description={ASSISTANTS.description} />
      )}
      <div className="master-detail assistants-md" data-detail-open={threadId !== undefined ? "" : undefined}>
        <aside className="master-detail-list" aria-label={ASSISTANTS.name} data-focus-zone="list" tabIndex={-1}>
          <ThreadList
            list={list}
            showArchive={showArchive}
            onShowArchive={setShowArchive}
            selectedId={threadId ?? null}
            onOpen={openThread}
            onNewThread={startThread}
            onRetry={() => void load()}
            badgeFor={(thread) => badgeFor(thread, true)}
          />
        </aside>
        <div className="assistant-thread-pane" data-focus-zone="main" tabIndex={-1}>
          {threadId === undefined && (list.kind === "unavailable" || list.kind === "ownerOnly") ? (
            // The list already says why there are no threads here; an invitation to choose one would
            // contradict it, so the pane stays empty.
            null
          ) : threadId === undefined && emptyInbox ? (
            <div className="assistant-thread-pane-state">
              <State icon={<AssistantsIcon />} title="No Threads Yet" headingLevel={2}
                actions={<button type="button" className="btn primary" onClick={startThread}>New Thread</button>}>
                An assistant thread is a conversation that can start sessions, check on your work and make the decisions you delegate.
              </State>
            </div>
          ) : threadId === undefined ? (
            <div className="assistant-thread-pane-state">
              {/* The detail pane's placeholder beside a list that offers New Thread itself (§21.4), not
                  an empty screen: its action is the list's, one step to the left. */}
              <State compact icon={<AssistantsIcon />} title="Choose a Thread" headingLevel={2}>
                Ask the assistant to start sessions, check on work and handle approvals. Use New Thread to start a conversation.
              </State>
            </div>
          ) : list.kind === "loading" || (!selected && !missing && list.kind === "ready") ? (
            <div className="assistant-thread-pane-state"><State variant="loading">Loading the thread…</State></div>
          ) : !selected ? (
            <div className="assistant-thread-pane-state">
              <State icon={<AssistantsIcon />} title="Thread Not Found" headingLevel={2}
                actions={<button type="button" className="btn" onClick={toList}>{backLabel("assistants")}</button>}>
                {list.kind === "unavailable" ? "Assistant threads aren't available on this control plane yet."
                  : list.kind === "ownerOnly" ? list.message
                  : "This thread may have been removed."}
              </State>
            </div>
          ) : (
            <AssistantTranscriptContext.Provider value={{
              thread: selected,
              onShowWork: () => panel.show("Work"),
              onFocusConfirmation: (id) => waitingDock.current?.focusConfirmation(id),
            }}>
            <SessionDetail
              key={selected.sessionId}
              sessionId={selected.sessionId}
              mode="expanded"
              archivedAssistantThread={selected.status === "archived"}
              rightPanel={{
                ...rightPanel,
                open: panel.open,
                expanded: panel.expanded,
                mode: "launcher",
                close: panel.close,
                setExpanded: panel.setExpanded,
                toggle: panel.toggle,
                show: showSessionTool,
                showSubagent: (...args) => {
                  rightPanel.showSubagent(...args);
                  navigate({ name: "session", id: selected.sessionId });
                },
              }}
              // The terminal dock belongs to the session page, so a thread opens its session there.
              onOpenTerminal={() => navigate({ name: "session", id: selected.sessionId })}
              onBack={toList}
              assistantPanel={(onOverlayChange) => <AssistantThreadPanel
                key={selected.id}
                state={panel}
                thread={selected}
                work={launchedWork!}
                model={model ? resolvedModelLabel(model) : undefined}
                effort={effort ? effortLabel(effort) : undefined}
                onSettings={() => openThreadSettings(selected.id)}
                onDelegation={() => navigate({ name: "assistants", threadId: selected.id, delegation: true })}
                onOverlayChange={onOverlayChange}
                onReview={(sessionId, request) => waitingDock.current?.focusAssistantWorkRequest(sessionId, request)}
              />}
              // A phone's detail bar is the thread's bar, so SessionDetail draws none of its own.
              header={isMobile ? null : (
                <ThreadBar
                  thread={selected}
                  work={launchedWork!}
                  menu={threadMenu(selected)}
                  status={badgeFor(selected, true)}
                  sidePanelOpen={panel.open}
                  onToggleSidePanel={panel.toggle}
                />
              )}
              assistantRequestDock={selected.status === "archived" ? undefined : (focusComposer) => <AssistantWaitingDock
                ref={waitingDock}
                thread={selected}
                work={launchedWork!}
                onConfirmationAnswered={replace}
                focusComposer={focusComposer}
              />}
              assistantSpendingNotices={spendingNotices}
              assistantThreadHealth={selected.health && selected.status !== "archived" ? {
                thread: selected,
                problems: problemsFor(selected),
                onSwitchAccount: () => setAccountSettingsFor(selected.id),
              } : undefined}
            />
            </AssistantTranscriptContext.Provider>
          )}
        </div>
      </div>
      {renaming && (
        <RenameThreadDialog
          thread={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={(thread) => {
            setRenaming(null);
            replace(thread);
            if (extra?.id === thread.id) setExtra(thread);
          }}
        />
      )}
      {selected && (limits || accountSettingsFor === selected.id) && (
        <AssistantThreadLimitsDialog
          key={selected.id}
          thread={selected}
          startAtSpending={limits === "spending"}
          startAtAccount={accountSettingsFor === selected.id}
          model={model ? resolvedModelLabel(model) : undefined}
          effort={effort ? effortLabel(effort) : undefined}
          onClose={() => {
            setAccountSettingsFor(null);
            if (limits) navigate({ name: "assistants", threadId: selected.id }, { replace: true });
          }}
          onChanged={replace}
        />
      )}
      {delegation && selected && (selected.decisionDelegation && selected.status !== "archived"
        ? <AssistantDecisionDelegationDialog key={selected.id}
            delegation={selected.decisionDelegation}
            evidenceReview={selected.evidenceReview}
            onClose={() => navigate({ name: "assistants", threadId: selected.id }, { replace: true })}
            onSave={async (next) => replace((await api.setAssistantThreadDelegation(selected.id, next)).thread)}
          />
        : <Modal title="Decision Delegation" onClose={() => navigate({ name: "assistants", threadId: selected.id }, { replace: true })}>
            <p>{selected.status === "archived" ? "Archived threads cannot hold delegation grants." : "This control plane does not support decision delegation."}</p>
          </Modal>)}
      {/* New Thread is a dialog over the list, as New Session is; its route keeps it linkable. */}
      {newThread && <NewAssistantThreadDialog onClose={cancelNewThread} onCreated={finishNewThread} />}
    </section>
  );
}

/** The list pane's threads and New Thread action. */
function ThreadList({ list, showArchive, onShowArchive, selectedId, onOpen, onNewThread, onRetry, badgeFor }: {
  list: ListState;
  showArchive: boolean;
  onShowArchive: (show: boolean) => void;
  selectedId: string | null;
  onOpen: (threadId: string) => void;
  onNewThread: () => void;
  onRetry: () => void;
  badgeFor: (thread: AssistantThread) => React.ReactNode;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchButton = useRef<HTMLButtonElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const archiveButton = useRef<HTMLButtonElement>(null);
  const archiveBack = useRef<HTMLButtonElement>(null);
  const threads = list.kind === "ready" ? list.threads : [];
  const archived = threads.filter((thread) => thread.status === "archived");
  const active = threads.filter((thread) => thread.status !== "archived");
  const visible = showArchive ? archived : active;
  const search = query.trim().toLowerCase();
  const matching = visible.filter((thread) => !search || [assistantThreadTitle(thread), thread.preview]
    .some((value) => value?.toLowerCase().includes(search)));
  const needsYou = matching.filter((thread) => thread.status === "needs_you");
  const recent = matching.filter((thread) => thread.status !== "needs_you");
  useTimelineClock(visible.length > 0);

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    searchButton.current?.focus();
  };
  const openArchive = (show: boolean) => {
    setSearchOpen(false);
    setQuery("");
    onShowArchive(show);
    requestAnimationFrame(() => (show ? archiveBack : archiveButton).current?.focus());
  };
  const renderRows = (rows: AssistantThread[]) => (
    <ul className="assistant-thread-list">
      {rows.map((thread) => {
        const selected = thread.id === selectedId;
        const title = assistantThreadTitle(thread);
        const badge = badgeFor(thread);
        return (
          <li key={thread.id}>
            <button
              type="button"
              className={`row assistant-inbox-row${selected ? " is-selected" : ""}`}
              aria-current={selected ? "true" : undefined}
              data-thread-id={thread.id}
              onClick={() => onOpen(thread.id)}
            >
              <span className="assistant-thread-glyph">
                <AgentIcon driver={thread.harness} size={20} />
              </span>
              <span className="row-body">
                <span className="row-line assistant-thread-title-line">
                  <span className="row-title assistant-thread-list-title" title={title}>{title}</span>
                  <span className="row-sub">{relativeTime(thread.lastActivityAt)}</span>
                </span>
                {(badge || thread.preview) && <span className="row-line assistant-thread-preview-line">
                  {badge}
                  {thread.preview && <span className="row-sub" title={thread.preview}>{thread.preview}</span>}
                </span>}
              </span>
              <span className="sr-only">{assistantThreadHarnessLabel(thread.harness)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
  return (
    <>
      <div className="master-detail-list-head assistant-threads-head">
        {showArchive && (
          <button ref={archiveBack} type="button" className="icon-btn" title="Back to Threads"
            aria-label="Back to Threads" onClick={() => openArchive(false)}><ChevronLeftIcon /></button>
        )}
        <h2 id="assistant-threads-title" className="group-label">{showArchive ? "Archived Threads" : "Threads"}</h2>
        {list.kind === "ready" && visible.length > 0 && (
          <button ref={searchButton} type="button" className="icon-btn" title="Search Threads" aria-label="Search Threads"
            aria-expanded={searchOpen} aria-controls={searchOpen ? "assistant-threads-search" : undefined}
            onClick={() => {
              if (searchOpen) closeSearch();
              else {
                setSearchOpen(true);
                requestAnimationFrame(() => searchField.current?.focus());
              }
            }}><SearchIcon /></button>
        )}
        {!showArchive && list.kind !== "unavailable" && list.kind !== "ownerOnly" && (
          <button type="button" className="btn primary" onClick={onNewThread}><PlusIcon />New Thread</button>
        )}
      </div>
      {searchOpen && (
        <div className="master-detail-list-head assistant-threads-search">
          <input id="assistant-threads-search" ref={searchField} type="search" value={query}
            aria-label="Search Threads" placeholder="Search threads…" onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              event.preventDefault();
              closeSearch();
            }} />
        </div>
      )}
      <section className="master-detail-list-body clip-focus assistant-group" aria-labelledby="assistant-threads-title">
        {list.kind === "loading" ? (
          <div className="skeleton" role="status">
            <span className="sr-only">Loading threads</span>
            <div aria-hidden="true">
              {Array.from({ length: 4 }, (_, index) => (
                <div className="row row-2" key={index}>
                  <span className="row-body"><span className="skeleton-bar title" /><span className="skeleton-bar" /></span>
                </div>
              ))}
            </div>
          </div>
        ) : list.kind === "failed" ? (
          <Notice tone="danger" role="alert" title="Couldn't Load Threads"
            actions={<button type="button" className="btn" onClick={onRetry}>Retry</button>}
            details={<code>{list.message}</code>}>
            Retry to load the threads again.
          </Notice>
        ) : list.kind === "ownerOnly" ? (
          // Not an empty list but a person who can't have one: no New Thread to offer.
          <State compact icon={<AssistantsIcon />} title="Threads Are for Owners">{list.message}</State>
        ) : matching.length === 0 && search && visible.length > 0 ? (
          <State compact icon={<SearchIcon />} title="No Matching Threads" headingLevel={3}
            actions={<button className="btn" type="button" onClick={() => {
              setQuery("");
              searchField.current?.focus();
            }}>Clear Search</button>}>
            No threads match “{query.trim()}”.
          </State>
        ) : showArchive ? (
          archived.length > 0 ? renderRows(matching) : (
            <State compact icon={<AssistantsIcon />} title="No Archived Threads">
              Archived threads will appear here.
            </State>
          )
        ) : list.kind === "unavailable" ? (
          <State compact icon={<AssistantsIcon />} title="Threads Aren't Available Yet">{THREADS_UNAVAILABLE_MESSAGE}</State>
        ) : active.length === 0 ? (
          <State compact title="No Threads Yet" />
        ) : (
          <>
            {needsYou.length > 0 && (
              <section aria-labelledby="assistant-threads-needs-you">
                <h3 className="group-label" id="assistant-threads-needs-you">
                  Needs You <span className="count">{needsYou.length}</span>
                </h3>
                {renderRows(needsYou)}
              </section>
            )}
            {recent.length > 0 && (
              <section aria-labelledby="assistant-threads-recent">
                <h3 className="group-label" id="assistant-threads-recent">Recent</h3>
                {renderRows(recent)}
              </section>
            )}
          </>
        )}
      </section>
      {list.kind === "ready" && threads.length > 0 && !showArchive && (
        <div className="assistant-threads-foot">
          <ListFoot>
            <button ref={archiveButton} type="button" className="row" onClick={() => openArchive(true)}>
              <span className="row-title">Archived Threads</span>
              <span className="row-trail count">{archived.length}</span>
              <ChevronRightIcon />
            </button>
          </ListFoot>
        </div>
      )}
    </>
  );
}

/** The desktop thread bar spans the conversation and the side panel that opens beneath it. */
function ThreadBar({ thread, work, menu, status, sidePanelOpen, onToggleSidePanel }: {
  thread: AssistantThread;
  work: LaunchedWork;
  menu: PageMenuAction[];
  status: React.ReactNode;
  sidePanelOpen: boolean;
  onToggleSidePanel: () => void;
}) {
  return (
    <header className="detail-bar assistant-thread-bar">
      <div className="detail-bar-heading">
        <ThreadBarTitle title={assistantThreadTitle(thread)} />
        {status}
      </div>
      <div className="detail-bar-actions">
        <ActionsMenu label="Thread Actions" items={menu} />
        <span className="detail-actions-divider" aria-hidden="true" />
        <AssistantSidePanelToggle work={work} open={sidePanelOpen} onToggle={onToggleSidePanel} />
      </div>
    </header>
  );
}

/** The row and both bars use the same order as the notice slot. */
function threadStatusBadge(
  thread: AssistantThread, problem: ReturnType<typeof assistantThreadProblems>[number] | undefined, hideDone: boolean,
) {
  const spending = threadSpendingStates(thread)[0];
  if (problem && (!spending || compareSessionNotices(problem, {
    key: spending.kind,
    rank: SESSION_NOTICE_RANK.assistantBudget,
    severity: spending.kind === "over_budget" ? "danger" : "warning",
  }) < 0)) return <StatusBadge meta={problem.badge} />;
  if (spending) return <StatusBadge meta={statusMeta("assistantThreadSpending", spending.kind)} />;
  return hideDone && thread.status === "done" ? null : <StatusBadge meta={statusMeta("assistantThread", thread.status)} />;
}

function AssistantSidePanelToggle({ work, open, onToggle }: {
  work: LaunchedWork;
  open: boolean;
  onToggle: () => void;
}) {
  const { groups } = useLaunchedWorkGroups(work);
  return <SidePanelToggle small={false} open={open} onToggle={onToggle} waitingSessions={groups.needsYou.length} />;
}

/** The full title is available on mouse hover and by pressing the title with a finger or keyboard. */
function ThreadBarTitle({ title, phone = false }: { title: string; phone?: boolean }) {
  const Heading = phone ? "h1" : "h2";
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (open || wrapper.current?.matches(":hover"))) {
        setOpen(false);
        setDismissed(true);
      }
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    // A tap need not focus the title button, so leaving the tooltip cannot depend on blur.
    const handleOutsidePress = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handleOutsidePress, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePress, true);
  }, [open]);
  return (
    <div className="assistant-bar-title" ref={wrapper} data-open={open || undefined} data-dismissed={dismissed || undefined}
      onPointerLeave={() => setDismissed(false)}>
      <Heading id={phone ? "page-title" : undefined} tabIndex={phone ? -1 : undefined}>
        <button type="button" className="detail-bar-title" aria-expanded={open} aria-controls={tooltipId}
          onBlur={() => setOpen(false)} onClick={() => { setDismissed(open); setOpen(!open); }}>
          {title}
        </button>
      </Heading>
      <span id={tooltipId} className="assistant-bar-title-tooltip" role="tooltip">{title}</span>
    </div>
  );
}

function RenameThreadDialog({ thread, onClose, onRenamed }: {
  thread: AssistantThread;
  onClose: () => void;
  onRenamed: (thread: AssistantThread) => void;
}) {
  const api = useApi();
  const [title, setTitle] = useState(thread.title);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const trimmed = title.trim();
  const save = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      onRenamed((await api.renameAssistantThread(thread.id, trimmed)).thread);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Rename Thread"
      size="sm"
      onClose={busy ? () => {} : onClose}
      footer={(
        <>
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <BusyButton className="btn primary" busy={busy} progress="Renaming…" disabled={!trimmed || trimmed === thread.title}
            onClick={() => void save()}>
            Rename
          </BusyButton>
        </>
      )}
    >
      <form className="form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="field">
          <span>Title</span>
          <input value={title} maxLength={ASSISTANT_THREAD_TITLE_MAX} autoFocus onChange={(event) => setTitle(event.target.value)} />
        </label>
        {failure && <Notice tone="danger" role="alert" details={<code>{failure}</code>}>The thread wasn't renamed. Try again.</Notice>}
      </form>
    </Modal>
  );
}
