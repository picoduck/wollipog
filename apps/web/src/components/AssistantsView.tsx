import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../api-context.js";
import {
  assistantThreadAccessLabel,
  assistantThreadHarnessLabel,
  assistantThreadsUnavailable,
  assistantThreadTitle,
  sortAssistantThreads,
  type AssistantThread,
} from "../assistant-threads.js";
import { useReportEntityTitle } from "../entity-title.js";
import { relativeTime } from "../format.js";
import { backLabel, destination } from "../navigation.js";
import { statusMeta } from "../status-meta.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { useTimelineClock } from "../timeline-clock.js";
import { AssistantWorkCards } from "./AssistantWorkCards.js";
import { useFeedback } from "./FeedbackProvider.js";
import { AssistantsIcon, BotIcon, PlusIcon } from "./Icons.js";
import { Modal } from "./Modal.js";
import { NewAssistantThreadDialog } from "./NewAssistantThreadDialog.js";
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
/** Session activity refetches the threads at most this often (#4663 adds a thread-updated event). */
const REFETCH_THROTTLE_MS = 1_500;
/** How often the list is read while a thread is working, whatever its sessions report. */
const WORKING_POLL_MS = 15_000;

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; threads: AssistantThread[] }
  | { kind: "unavailable" }
  | { kind: "failed"; message: string };

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
  const [archiving, setArchiving] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const { threads } = await api.assistantThreads();
      if (mine === generation.current) setList({ kind: "ready", threads: sortAssistantThreads(threads) });
    } catch (cause) {
      if (mine !== generation.current) return;
      if (assistantThreadsUnavailable(cause)) setList({ kind: "unavailable" });
      // A failed refresh keeps the rows it has; only a first read fails the list.
      else setList((previous) => previous.kind === "ready"
        ? previous
        : { kind: "failed", message: cause instanceof Error ? cause.message : String(cause) });
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);
  // A reconnect may have missed changes.
  useEffect(() => { if (conn === "online") void load(); }, [conn, load]);

  const threads = list.kind === "ready" ? list.threads : [];
  const listed = threadId === undefined ? undefined : threads.find((thread) => thread.id === threadId);
  const selected = listed ?? (extra?.id === threadId ? extra : undefined);
  // The window title names the open thread.
  useReportEntityTitle(
    threadId === undefined ? { name: "assistants" } : { name: "assistants", threadId },
    selected ? assistantThreadTitle(selected) : null,
  );

  // A deep link to a thread the list doesn't carry: look for it among archived threads once.
  useEffect(() => {
    setMissing(false);
    if (threadId === undefined || list.kind !== "ready" || listed) return;
    let current = true;
    void api.assistantThreads({ includeArchived: true }).then(({ threads: all }) => {
      if (!current) return;
      const found = all.find((thread) => thread.id === threadId) ?? null;
      setExtra(found);
      setMissing(found === null);
    }, () => { if (current) setMissing(true); });
    return () => { current = false; };
  }, [api, threadId, list.kind, listed]);

  // Until #4663's thread-updated event, a thread changes when its sessions do: refetch on their
  // stream. A backing session's activity counts too, since the assistant launches work in the middle
  // of a turn without changing its own status. Throttled rather than debounced, so a turn that
  // streams for minutes still refreshes its thread every few seconds instead of never.
  const backingIds = useMemo(() => new Set(threads.map((thread) => thread.sessionId)), [threads]);
  const watchedIds = useMemo(() => threads.flatMap((thread) => [thread.sessionId, ...thread.launchedSessionIds]), [threads]);
  const streamKey = useStoreSelector((state) => watchedIds.map((id) => {
    const session = state.sessions.get(id);
    if (!session) return id;
    const activity = backingIds.has(id) ? `:${session.messageCount}:${session.lastEventAt ?? session.updatedAt}` : "";
    return `${id}:${session.status}:${session.pendingApproval?.requestId ?? ""}:${session.archived ? 1 : 0}${activity}`;
  }).join("|"));
  const firstKey = useRef(true);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (firstKey.current) {
      firstKey.current = false;
      return;
    }
    if (refetchTimer.current !== null) return;
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      void load();
    }, REFETCH_THROTTLE_MS);
  }, [streamKey, load]);
  // While a thread works, read the list now and then even without session activity: a launch can
  // land between events.
  const working = threads.some((thread) => thread.status === "working");
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void load(), WORKING_POLL_MS);
    return () => clearInterval(timer);
  }, [working, load]);
  useEffect(() => () => {
    if (refetchTimer.current !== null) clearTimeout(refetchTimer.current);
  }, []);

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
    ...(thread.status === "archived" ? [] : [
      { label: "Rename", onClick: () => setRenaming(thread) },
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
          {threadId === undefined ? (
            <div className="assistant-thread-pane-state">
              <State icon={<AssistantsIcon />} title={WOLLIPOG_ASSISTANT} headingLevel={2}>
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
                {list.kind === "unavailable"
                  ? "Assistant threads aren't available on this control plane yet."
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
              header={<ThreadHeader thread={selected} compact={isMobile} menu={threadMenu(selected)} />}
            />
          )}
        </div>
      </div>
      {creating && (
        <NewAssistantThreadDialog
          unavailable={list.kind === "unavailable"}
          onClose={() => setCreating(false)}
          onCreated={(thread) => {
            setCreating(false);
            replace(thread);
            openThread(thread.id);
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
function ThreadHeader({ thread, compact, menu }: { thread: AssistantThread; compact: boolean; menu: PageMenuAction[] }) {
  const meta = statusMeta("assistantThread", thread.status);
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
        <li className="assistant-thread-access">{assistantThreadAccessLabel(thread.access)}</li>
      </ul>
      <AssistantWorkCards sessionIds={thread.launchedSessionIds} />
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
          <input value={title} maxLength={200} autoFocus onChange={(event) => setTitle(event.target.value)} />
        </label>
        {failure && <Notice tone="danger" role="alert" details={<code>{failure}</code>}>The thread wasn't renamed. Try again.</Notice>}
      </form>
    </Modal>
  );
}
