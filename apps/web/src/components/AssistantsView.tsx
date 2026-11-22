import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useApi } from "../api-context.js";
import type { ApiClient } from "../api.js";
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
import { AssistantWaitingDock, type AssistantWaitingDockHandle } from "./AssistantWaitingDock.js";
import { AssistantSpendingNotice } from "./AssistantSpendingNotice.js";
import { AssistantThreadLimitsDialog } from "./AssistantThreadLimitsDialog.js";
import { AssistantDecisionDelegationDialog } from "./AssistantDecisionDelegationDialog.js";
import { useLaunchedWorkGroups } from "./AssistantWorkCards.js";
import type { LaunchedWork } from "../assistant-launched-work.js";
import { ConfirmationFailure, useFeedback } from "./FeedbackProvider.js";
import { AssistantsIcon, PlusIcon } from "./Icons.js";
import { Modal } from "./Modal.js";
import { NewAssistantThreadComposer, THREADS_UNAVAILABLE_MESSAGE, type NewAssistantThreadResult } from "./NewAssistantThreadComposer.js";
import { Notice } from "./Notice.js";
import { ActionsMenu, DetailBar, PageHeader, type ActionsMenuChoice, type PageMenuAction } from "./PageHeader.js";
import { SessionDetail } from "./SessionDetail.js";
import { SESSION_NOTICE_RANK, type SessionNoticeEntry } from "./SessionNoticeSlot.js";
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

/** Why New Thread can't start one here, when the list already knows. */
function newThreadBlock(list: ListState): { title: string; message: string } | undefined {
  if (list.kind === "unavailable") return { title: "Threads Aren't Available Yet", message: THREADS_UNAVAILABLE_MESSAGE };
  if (list.kind === "ownerOnly") return { title: "Threads Are for Owners", message: list.message };
  return undefined;
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
  const panel = useAssistantPanelState();
  const waitingDock = useRef<AssistantWaitingDockHandle>(null);
  const [list, setList] = useState<ListState>({ kind: "loading" });
  /** An open thread the list leaves out (archived), read on its own. */
  const [extra, setExtra] = useState<AssistantThread | null>(null);
  const [missing, setMissing] = useState(false);
  const [unsentFirstMessage, setUnsentFirstMessage] = useState<
    (NonNullable<NewAssistantThreadResult["firstMessageFailure"]> & { sessionId: string; dismissed?: true }) | null
  >(null);
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
  const rereadQueued = useRef(false);
  // The control plane publishes each thread change (`assistant_thread_upsert`); the store keeps the
  // newest of them, numbered. `appliedSeq` is the newest one the list reflects.
  const events = useStoreSelector((state) => state.assistantThreadEvents);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const appliedSeq = useRef(0);

  /** Reads the list, superseding any read still in flight: a mutation's reconciliation and Retry. */
  const load = useCallback(async () => {
    const mine = ++generation.current;
    reading.current = true;
    // Events that land while the read is in flight are newer than what it returns.
    const startSeq = eventsRef.current?.at(-1)?.seq ?? 0;
    try {
      const { threads } = await api.assistantThreads();
      if (mine === generation.current) {
        const kept = eventsRef.current ?? [];
        setList({ kind: "ready", threads: applyAssistantThreadEvents(threads, kept, startSeq) });
        appliedSeq.current = Math.max(appliedSeq.current, kept.at(-1)?.seq ?? 0);
        // More changed during the read than the store kept: what was dropped may be one this read
        // predates, so read again once this one has landed.
        if (!replayComplete(kept, startSeq)) rereadQueued.current = true;
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
          rereadQueued.current = false;
          void load();
        }
      }
    }
  }, [api]);
  /** A background refresh: behind a read in flight it waits its turn rather than discarding it, so a
   * session that streams faster than the list answers still sees each answer land. */
  const refresh = useCallback(() => {
    if (reading.current) rereadQueued.current = true;
    else void load();
  }, [load]);

  useEffect(() => { void load(); }, [load]);
  // A reconnect may have missed changes.
  useEffect(() => { if (conn === "online") refresh(); }, [conn, refresh]);

  const titleForDisplay = (thread: AssistantThread) => thread.sessionId === unsentFirstMessage?.sessionId &&
    assistantThreadTitle(thread) === "New Thread" ? { ...thread, title: "Untitled Thread" } : thread;
  const threads = list.kind === "ready" ? list.threads : [];
  const listed = threadId === undefined ? undefined : threads.find((thread) => thread.id === threadId);
  const selectedThread = listed ?? (extra?.id === threadId ? extra : undefined);
  const selected = selectedThread && titleForDisplay(selectedThread);
  const model = useStoreSelector((state) => {
    const backing = selected ? state.sessions.get(selected.sessionId) : undefined;
    return backing?.resolvedModel ?? backing?.model;
  });
  const effort = useStoreSelector((state) => selected ? state.sessions.get(selected.sessionId)?.effort : undefined);
  const firstMessageDelivered = useStoreSelector((state) => unsentFirstMessage !== null &&
    (state.sessions.get(unsentFirstMessage.sessionId)?.messageCount ?? 0) > 0);
  useEffect(() => {
    if (firstMessageDelivered) setUnsentFirstMessage(null);
  }, [firstMessageDelivered]);
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

  // A deep link to a thread the list doesn't carry (an archived one): read that thread alone, and
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
  // launches. Applied in order to the rows on screen, and to an archived thread open on its own.
  useEffect(() => {
    const kept = events ?? [];
    const from = appliedSeq.current;
    const newest = kept.at(-1)?.seq ?? 0;
    if (newest <= from) return;
    appliedSeq.current = newest;
    // More changed than the store kept since the last render: the list itself is the answer, and an
    // archived thread open on its own, which the list leaves out, is read again too.
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
    if (wasLaunchedWorkActive.current && !launchedWorkActive) refresh();
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
    const timer = setInterval(refresh, WORKING_POLL_MS);
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
      threads: sortAssistantThreads(thread.status === "archived"
        ? previous.threads.filter((candidate) => candidate.id !== thread.id)
        : [thread, ...previous.threads.filter((candidate) => candidate.id !== thread.id)]),
    });
    void load();
  };

  const openThread = (id: string) => navigate({ name: "assistants", threadId: id });
  const openThreadSettings = (id: string, section: true | "spending" = true) =>
    navigate({ name: "assistants", threadId: id, limits: section });
  const toList = () => navigate({ name: "assistants" });
  const cancelNewThread = () => navigate({ name: "assistants" }, { replace: true });
  const startThread = () => navigate({ name: "assistants", newThread: true });
  const finishNewThread = ({ thread, firstMessageFailure }: NewAssistantThreadResult) => {
    replace(thread);
    if (firstMessageFailure) setUnsentFirstMessage({ sessionId: thread.sessionId, ...firstMessageFailure });
    const view = currentView.read();
    if (view.name === "assistants" && view.newThread) {
      navigate({ name: "assistants", threadId: thread.id }, { replace: true });
    }
  };

  const archive = async (thread: AssistantThread, reopen: () => void) => {
    const accepted = await confirm({
      title: "Archive Thread",
      message: `“${assistantThreadTitle(thread)}” leaves the thread list. Its session and transcript are kept.`,
      confirmLabel: "Archive Thread",
      tone: "danger",
      back: { label: "Back to Thread Actions", run: reopen },
    });
    if (!accepted) return;
    setArchiving(true);
    try {
      const { thread: archived } = await api.archiveAssistantThread(thread.id);
      replace(archived);
      showToast("Thread archived.", { tone: "success" });
      if (threadId === thread.id) navigate({ name: "assistants" }, { replace: true });
    } catch (cause) {
      showToast("Couldn't archive the thread.", { tone: "error", detail: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setArchiving(false);
    }
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

  const phoneDetail = isMobile && (threadId !== undefined || newThread);
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
  const creationBlock = newThreadBlock(list);
  const firstMessageNoticeTitle = unsentFirstMessage?.deliveryUnconfirmed
    ? "First Message Delivery Unconfirmed" : "First Message Wasn't Sent";
  const firstMessageNotice: SessionNoticeEntry | null =
    unsentFirstMessage && !unsentFirstMessage.dismissed && !firstMessageDelivered &&
      selected?.sessionId === unsentFirstMessage.sessionId ? {
      key: "assistant-first-message-unsent",
      severity: "warning",
      rank: SESSION_NOTICE_RANK.composerError,
      title: firstMessageNoticeTitle,
      render: ({ trailing }) => (
        <Notice tone="warning" role="status" title={firstMessageNoticeTitle} trailing={trailing}
          onDismiss={() => setUnsentFirstMessage((current) => current && { ...current, dismissed: true })}>
          Your draft is kept. {unsentFirstMessage.reason}
          {unsentFirstMessage.deliveryUnconfirmed && " Check the transcript before sending again."}
        </Notice>
      ),
    } : null;

  return (
    <section className="page full fill">
      {phoneDetail ? (
        <DetailBar
          title={newThread ? "New Thread" : selected ? assistantThreadTitle(selected) : "Thread"}
          backLabel={backLabel("assistants")}
          onBack={newThread ? cancelNewThread : toList}
          status={selected ? threadBarStatus(selected) : undefined}
          menu={selected ? threadMenu(selected) : []}
          menuLabel="Thread Actions"
          menuSheetTitle={selected ? assistantThreadTitle(selected) : undefined}
          hideSearch={Boolean(selected || newThread)}
          controls={canTogglePanel && launchedWork
            ? <AssistantSidePanelToggle work={launchedWork} open={panel.open} onToggle={panel.toggle} />
            : undefined}
          renderTitle={selected ? (title) => <ThreadBarTitle title={title} phone /> : undefined}
        />
      ) : (
        // New Thread belongs to the assistant's Threads list, so the page header offers no second one.
        <PageHeader title={ASSISTANTS.name} description={ASSISTANTS.description} />
      )}
      <div className="master-detail assistants-md" data-detail-open={threadId !== undefined || newThread ? "" : undefined}>
        <aside className="master-detail-list" aria-label={ASSISTANTS.name} data-focus-zone="list" tabIndex={-1}>
          <div className="master-detail-list-body clip-focus">
            <ThreadList
              list={unsentFirstMessage && list.kind === "ready" ? { ...list, threads: threads.map(titleForDisplay) } : list}
              selectedId={threadId ?? null}
              unsentSessionId={unsentFirstMessage?.sessionId}
              onOpen={openThread}
              onNewThread={startThread}
              onRetry={() => void load()}
            />
          </div>
        </aside>
        <div className="assistant-thread-pane" data-focus-zone="main" tabIndex={-1}>
          {newThread ? creationBlock ? (
            <div className="assistant-thread-pane-state"><State compact icon={<AssistantsIcon />}
              title={creationBlock.title} headingLevel={2}>{creationBlock.message}</State></div>
          ) : <NewAssistantThreadComposer onCancel={isMobile ? undefined : cancelNewThread} onCreated={finishNewThread} />
          : threadId === undefined && (list.kind === "unavailable" || list.kind === "ownerOnly") ? (
            // The list already says why there are no threads here; an invitation to choose one would
            // contradict it, so the pane stays empty.
            null
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
            <SessionDetail
              key={selected.sessionId}
              sessionId={selected.sessionId}
              mode="expanded"
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
                  sidePanelOpen={panel.open}
                  onToggleSidePanel={panel.toggle}
                />
              )}
              assistantRequestDock={(focusComposer) => <AssistantWaitingDock
                ref={waitingDock}
                thread={selected}
                work={launchedWork!}
                onConfirmationAnswered={replace}
                focusComposer={focusComposer}
              />}
              assistantSpendingNotices={firstMessageNotice ? [firstMessageNotice, ...spendingNotices] : spendingNotices}
            />
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
      {limits && selected && (
        <AssistantThreadLimitsDialog
          key={selected.id}
          thread={selected}
          startAtSpending={limits === "spending"}
          model={model ? resolvedModelLabel(model) : undefined}
          effort={effort ? effortLabel(effort) : undefined}
          onClose={() => navigate({ name: "assistants", threadId: selected.id }, { replace: true })}
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
    </section>
  );
}

/** The list pane's threads and New Thread action. */
function ThreadList({ list, selectedId, unsentSessionId, onOpen, onNewThread, onRetry }: {
  list: ListState;
  selectedId: string | null;
  unsentSessionId?: string;
  onOpen: (threadId: string) => void;
  onNewThread: () => void;
  onRetry: () => void;
}) {
  const threads = list.kind === "ready" ? list.threads : [];
  // Re-renders each row's "5m ago" as time passes.
  useTimelineClock(threads.length > 0);
  return (
    <section className="assistant-group" aria-labelledby="assistant-threads-title">
      <div className="assistant-threads-head">
        <h2 id="assistant-threads-title" className="group-label">Threads{threads.length > 0 && <span className="count">{threads.length}</span>}</h2>
        {/* With no threads the empty state offers New Thread itself, so the head steps aside (§12.1). */}
        {threads.length > 0 && (
          <button type="button" className="btn sm ghost" onClick={onNewThread}><PlusIcon />New Thread</button>
        )}
      </div>
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
          actions={<button type="button" className="btn sm" onClick={onRetry}>Retry</button>}
          details={<code>{list.message}</code>}>
          Retry to load the threads again.
        </Notice>
      ) : list.kind === "ownerOnly" ? (
        // Not an empty list but a person who can't have one: no New Thread to offer.
        <State compact icon={<AssistantsIcon />} title="Threads Are for Owners">{list.message}</State>
      ) : list.kind === "unavailable" ? (
        <State compact icon={<AssistantsIcon />} title="Threads Aren't Available Yet">{THREADS_UNAVAILABLE_MESSAGE}</State>
      ) : threads.length === 0 ? (
        <State compact icon={<AssistantsIcon />} title="No Threads Yet"
          actions={<button type="button" className="btn" onClick={onNewThread}>New Thread</button>}>
          Start a thread to ask the assistant for help.
        </State>
      ) : (
        <ul className="assistant-thread-list">
          {threads.map((thread) => {
            const selected = thread.id === selectedId;
            return (
              <li key={thread.id}>
                <button
                  type="button"
                  className={`row row-2${selected ? " is-selected" : ""}`}
                  aria-current={selected ? "true" : undefined}
                  data-thread-id={thread.id}
                  onClick={() => onOpen(thread.id)}
                >
                  <span className="row-body">
                    <span className="row-line">
                      <span className="row-title" title={assistantThreadTitle(thread)}>{assistantThreadTitle(thread)}</span>
                      {threadStatusBadge(thread, thread.sessionId === unsentSessionId)}
                    </span>
                    <span className="row-sub">
                      {assistantThreadHarnessLabel(thread.harness)} · {relativeTime(thread.lastActivityAt)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The desktop thread bar spans the conversation and the side panel that opens beneath it. */
function ThreadBar({ thread, work, menu, sidePanelOpen, onToggleSidePanel }: {
  thread: AssistantThread;
  work: LaunchedWork;
  menu: PageMenuAction[];
  sidePanelOpen: boolean;
  onToggleSidePanel: () => void;
}) {
  return (
    <header className="detail-bar assistant-thread-bar">
      <div className="detail-bar-heading">
        <ThreadBarTitle title={assistantThreadTitle(thread)} />
        {threadBarStatus(thread)}
      </div>
      <div className="detail-bar-actions">
        <ActionsMenu label="Thread Actions" items={menu} />
        <span className="detail-actions-divider" aria-hidden="true" />
        <AssistantSidePanelToggle work={work} open={sidePanelOpen} onToggle={onToggleSidePanel} />
      </div>
    </header>
  );
}

/** Spending supersedes lifecycle on the row and both bars. The bars omit the at-rest badge. */
function threadBarStatus(thread: AssistantThread) {
  return threadStatusBadge(thread, true);
}

function threadStatusBadge(thread: AssistantThread, hideDone = false) {
  const spending = threadSpendingStates(thread)[0];
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
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
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
