import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../api-context.js";
import {
  applyAssistantThreadEvents,
  ASSISTANT_THREAD_TITLE_MAX,
  assistantThreadAccessLabel,
  assistantThreadHarnessLabel,
  assistantThreadsOwnerOnly,
  assistantThreadsUnavailable,
  assistantThreadTitle,
  sortAssistantThreads,
  type AssistantThread,
} from "../assistant-threads.js";
import { useReportEntityTitle } from "../entity-title.js";
import { relativeTime } from "../format.js";
import { formatUsd } from "../guardrail-values.js";
import { backLabel, destination } from "../navigation.js";
import { statusMeta } from "../status-meta.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { useTimelineClock } from "../timeline-clock.js";
import { pendingAssistantConfirmations } from "../assistant-confirmations.js";
import { AccountIdentifier } from "./AccountIdentifier.js";
import { AssistantConfirmationCard } from "./AssistantConfirmationCard.js";
import { AssistantThreadLimitsDialog } from "./AssistantThreadLimitsDialog.js";
import { AssistantDecisionDelegationDialog } from "./AssistantDecisionDelegationDialog.js";
import { AssistantDecisionHistoryDialog } from "./AssistantDecisionHistory.js";
import { AssistantWorkCards } from "./AssistantWorkCards.js";
import { ChangeAssistantThreadAccountDialog } from "./ChangeAssistantThreadAccountDialog.js";
import { useFeedback } from "./FeedbackProvider.js";
import { AssistantsIcon, BotIcon, PlusIcon } from "./Icons.js";
import { Modal } from "./Modal.js";
import { NewAssistantThreadDialog, THREADS_UNAVAILABLE_MESSAGE } from "./NewAssistantThreadDialog.js";
import { Notice } from "./Notice.js";
import { ActionsMenu, DetailBar, PageHeader, type PageMenuAction } from "./PageHeader.js";
import { SessionDetail } from "./SessionDetail.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";
import type { RightPanelState } from "./right-panel-state.js";
import { useIsMobile } from "./useIsMobile.js";

/** The one assistant today; the section lists it first and names its threads under it. */
const WOLLIPOG_ASSISTANT = "Wollipog Assistant";
const ASSISTANTS = destination("assistants");
/** How often the list is read while a thread is working, as a net under the thread events. */
const WORKING_POLL_MS = 15_000;

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
 * The Assistants section (#4664): the Wollipog Assistant first, its threads newest activity first
 * with New Thread, and the open thread beside them. On a phone the list and the thread are two
 * routes. Every thread comes from the Thread API; a control plane without it (404) shows the empty
 * section and New Thread explains, never a failure.
 */
export function AssistantsView({ threadId, rightPanel }: {
  threadId?: string;
  /** The shell's session panel (Files, Changes, Subagents), shared with the session page. */
  rightPanel: RightPanelState;
}) {
  const api = useApi();
  const { navigate, dispatch } = useStoreActions();
  const { confirm, showToast } = useFeedback();
  const isMobile = useIsMobile();
  const conn = useStoreSelector((state) => state.conn);
  const [list, setList] = useState<ListState>({ kind: "loading" });
  /** An open thread the list leaves out (archived), read on its own. */
  const [extra, setExtra] = useState<AssistantThread | null>(null);
  const [missing, setMissing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<AssistantThread | null>(null);
  const [editingLimits, setEditingLimits] = useState<AssistantThread | null>(null);
  const [editingDelegation, setEditingDelegation] = useState<AssistantThread | null>(null);
  const [viewingDelegationHistory, setViewingDelegationHistory] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [changingAccount, setChangingAccount] = useState<AssistantThread | null>(null);
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

  const threads = list.kind === "ready" ? list.threads : [];
  const listed = threadId === undefined ? undefined : threads.find((thread) => thread.id === threadId);
  const selected = listed ?? (extra?.id === threadId ? extra : undefined);
  // The window title names the open thread.
  useReportEntityTitle(
    threadId === undefined ? { name: "assistants" } : { name: "assistants", threadId },
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
  const toList = () => navigate({ name: "assistants" });

  const archive = async (thread: AssistantThread) => {
    const accepted = await confirm({
      title: "Archive Thread",
      message: `“${assistantThreadTitle(thread)}” leaves the thread list. Its session and transcript are kept.`,
      confirmLabel: "Archive Thread",
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

  const threadMenu = (thread: AssistantThread): PageMenuAction[] => [
    { label: "Open Session", onClick: () => navigate({ name: "session", id: thread.sessionId }) },
    ...(thread.decisionDelegation ? [{ label: "Delegated Decisions", onClick: () => setViewingDelegationHistory(thread.id) }] : []),
    ...(thread.status === "archived" ? [] : [
      ...(thread.accountChangeSupported ? [{ label: "Change Account", onClick: () => setChangingAccount(thread) }] : []),
      { label: "Rename", onClick: () => setRenaming(thread) },
      ...(thread.limitsEditable && thread.usage ? [{ label: "Thread Limits", onClick: () => setEditingLimits(thread) }] : []),
      ...(thread.decisionDelegation ? [{ label: "Decision Delegation", onClick: () => setEditingDelegation(thread) }] : []),
      { label: "Archive", disabled: archiving, onClick: () => void archive(thread) },
    ]),
  ];

  const phoneDetail = isMobile && threadId !== undefined;

  return (
    <section className="page full fill">
      {phoneDetail ? (
        <DetailBar
          title={selected ? assistantThreadTitle(selected) : "Thread"}
          backLabel={backLabel("assistants")}
          onBack={toList}
          status={selected ? <StatusBadge meta={statusMeta("assistantThread", selected.status)} /> : undefined}
          menu={selected ? threadMenu(selected) : []}
          menuLabel="Thread Actions"
        />
      ) : (
        // New Thread belongs to the assistant's Threads list, so the page header offers no second one.
        <PageHeader title={ASSISTANTS.name} description={ASSISTANTS.description} />
      )}
      <div className="master-detail assistants-md" data-detail-open={threadId !== undefined ? "" : undefined}>
        <aside className="master-detail-list" aria-label={ASSISTANTS.name} data-focus-zone="list" tabIndex={-1}>
          <div className="master-detail-list-body clip-focus">
            <ThreadList
              list={list}
              selectedId={threadId ?? null}
              onOpen={openThread}
              onNewThread={() => setCreating(true)}
              onRetry={() => void load()}
            />
          </div>
        </aside>
        <div className="assistant-thread-pane" data-focus-zone="main" tabIndex={-1}>
          {threadId === undefined && (list.kind === "unavailable" || list.kind === "ownerOnly") ? (
            // The list already says why there are no threads here; an invitation to choose one would
            // contradict it, so the pane stays empty.
            null
          ) : threadId === undefined ? (
            <div className="assistant-thread-pane-state">
              {/* The detail pane's placeholder beside a list that offers New Thread itself (§21.4), not
                  an empty screen: its action is the list's, one step to the left. */}
              <State compact icon={<AssistantsIcon />} title={WOLLIPOG_ASSISTANT} headingLevel={2}>
                Ask the assistant to start sessions, check on work and handle approvals. Choose a thread, or start one
                with New Thread.
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
              rightPanel={rightPanel}
              // The terminal dock belongs to the session page, so a thread opens its session there.
              onOpenTerminal={() => navigate({ name: "session", id: selected.sessionId })}
              onBack={toList}
              header={<ThreadHeader thread={selected} compact={isMobile} menu={threadMenu(selected)} onConfirmationAnswered={refresh} />}
            />
          )}
        </div>
      </div>
      {creating && (
        <NewAssistantThreadDialog
          blocked={newThreadBlock(list)}
          onClose={() => setCreating(false)}
          onCreated={(thread) => {
            setCreating(false);
            replace(thread);
            openThread(thread.id);
          }}
        />
      )}
      {changingAccount && (
        <ChangeAssistantThreadAccountDialog
          thread={changingAccount}
          onClose={() => setChangingAccount(null)}
          onChanged={(thread) => {
            setChangingAccount(null);
            replace(thread);
            showToast("Thread account changed.", { tone: "success" });
          }}
        />
      )}
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
      {editingLimits?.usage && (
        <AssistantThreadLimitsDialog
          limits={{ costUsd: editingLimits.usage.costUsd.limit, launchedSessions: editingLimits.usage.launchedSessions.limit }}
          onClose={() => setEditingLimits(null)}
          onSave={async (limits) => replace((await api.setAssistantThreadLimits(editingLimits.id, limits)).thread)}
        />
      )}
      {editingDelegation?.decisionDelegation && <AssistantDecisionDelegationDialog
        delegation={editingDelegation.decisionDelegation}
        onClose={() => setEditingDelegation(null)}
        onSave={async (delegation) => replace((await api.setAssistantThreadDelegation(editingDelegation.id, delegation)).thread)}
      />}
      {viewingDelegationHistory && <AssistantDecisionHistoryDialog threadId={viewingDelegationHistory} onClose={() => setViewingDelegationHistory(null)} />}
    </section>
  );
}

/** The list pane: the Wollipog Assistant, then its threads. */
function ThreadList({ list, selectedId, onOpen, onNewThread, onRetry }: {
  list: ListState;
  selectedId: string | null;
  onOpen: (threadId: string) => void;
  onNewThread: () => void;
  onRetry: () => void;
}) {
  const threads = list.kind === "ready" ? list.threads : [];
  // Re-renders each row's "5m ago" as time passes.
  useTimelineClock(threads.length > 0);
  return (
    <section className="assistant-group" aria-labelledby="assistant-wollipog-title">
      <div className="assistant-group-head">
        <span className="assistant-group-icon" aria-hidden="true"><BotIcon size={16} /></span>
        <h2 id="assistant-wollipog-title" className="assistant-group-title">{WOLLIPOG_ASSISTANT}</h2>
      </div>
      <div className="assistant-threads-head">
        <h3 className="group-label">Threads{threads.length > 0 && <span className="count">{threads.length}</span>}</h3>
        {/* With no threads the empty state offers New Thread itself, so the head steps aside (§12.1). */}
        {!(list.kind !== "loading" && list.kind !== "failed" && threads.length === 0) && (
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
      ) : threads.length === 0 ? (
        <State compact icon={<AssistantsIcon />} title="No Threads Yet"
          actions={<button type="button" className="btn" onClick={onNewThread}>New Thread</button>}>
          {list.kind === "unavailable"
            ? "Assistant threads aren't available on this control plane yet."
            : "Start a thread to ask the assistant for help."}
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
                      <StatusBadge meta={statusMeta("assistantThread", thread.status)} />
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

/**
 * The open thread's header, in the session bar's place: its title, status, harness and access level,
 * and the sessions it launched as work cards. On a phone the detail bar carries the title and
 * actions, so this keeps only the facts.
 */
function ThreadHeader({ thread, compact, menu, onConfirmationAnswered }: {
  thread: AssistantThread;
  compact: boolean;
  menu: PageMenuAction[];
  onConfirmationAnswered?: () => void;
}) {
  const meta = statusMeta("assistantThread", thread.status);
  // Destructive commands this thread's assistant is waiting on the owner for (#4665), drawn ahead
  // of the work they would unblock.
  const pending = pendingAssistantConfirmations([thread]);
  const usage = thread.usage;
  const launches = usage?.launchedSessions;
  const launchSummary = launches?.limit === 0 ? `${launches.used} launched · Launches Paused`
    : launches?.limit === null ? `${launches.used} launched · No Launch Limit`
    : launches ? `${launches.used} of ${launches.limit} sessions launched` : null;
  return (
    <div className="assistant-thread-head">
      {!compact && (
        <div className="assistant-thread-title-row">
          <h2 className="assistant-thread-title" title={assistantThreadTitle(thread)}>{assistantThreadTitle(thread)}</h2>
          <StatusBadge meta={meta} />
          <ActionsMenu label="Thread Actions" items={menu} />
        </div>
      )}
      <ul className="assistant-thread-meta" aria-label="Thread Details">
        <li>{WOLLIPOG_ASSISTANT}</li>
        <li>{assistantThreadHarnessLabel(thread.harness)}</li>
        {thread.accountChangeSupported && (
          <li className="assistant-thread-account">
            Account · {thread.providerAccountLabel
              ? <AccountIdentifier value={thread.providerAccountLabel} label="Account Email" identity={thread.id} />
              : "Machine Sign-In"}
          </li>
        )}
        <li className="assistant-thread-access">{assistantThreadAccessLabel(thread.access)}</li>
        {thread.decisionDelegation && <li>{thread.decisionDelegation.grant ? "Decision Delegation Set" : "Decision Delegation Off"}</li>}
        {usage && <>
          <li>{usage.costUsd.limit === null
            ? `${formatUsd(usage.costUsd.used)} spent · No Budget`
            : `${formatUsd(usage.costUsd.used)} of ${formatUsd(usage.costUsd.limit)} spent`}</li>
          <li>{launchSummary}</li>
        </>}
      </ul>
      <AssistantWorkCards
        sessionIds={thread.launchedSessionIds}
        campaignIds={thread.launchedCampaignIds}
        confirmations={pending.length > 0 ? pending.map(({ confirmation }) => (
          <AssistantConfirmationCard key={confirmation.id} confirmation={confirmation} onAnswered={onConfirmationAnswered} />
        )) : undefined}
      />
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
