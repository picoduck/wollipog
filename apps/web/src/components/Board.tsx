import { BoardIcon } from "./Icons.js";
import { type DragEvent, type MouseEvent, useMemo, useRef, useState } from "react";
import { BOARD_COLUMNS, type BoardColumn, type BoxView, type SessionReminderView, type SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { relativeTime } from "../format.js";
import { machineOptionLabels, runnerDisplay } from "../runners.js";
import { SessionStatusIndicators, Empty } from "./common.js";
import { useLongPress } from "./interactions.js";
import { sessionAgentLabel } from "./agent-options.js";
import { MeasuredVirtualList } from "./MeasuredVirtualList.js";
import { useExperiments } from "../use-experiments.js";
import {
  reminderBadgeDescription,
  reminderBadgeLabel,
  snoozedSessionAttentionReason,
} from "../session-reminders.js";

const sessionCardKey = (session: SessionView) => session.id;
const estimateSessionCard = (session: SessionView) => session.pendingApproval ? 230 : session.preview ? 155 : 120;

/**
 * The Sessions view's board mode: the same scoped session list the list mode renders (project
 * split, search, and reminder filtering applied by the parent), grouped into status columns.
 * The Machine and Agent filters below are board-local refinements on top of that shared scope.
 */
export function Board({ sessions: scoped, reminders = new Map(), searchActive, onShowAll, onNewSession, onSessionMenu }: {
  /** Already scoped by the Sessions toolbar: unarchived, split, query, and reminder mode. */
  sessions: SessionView[];
  reminders?: ReadonlyMap<string, SessionReminderView>;
  /** True while the shared search or a non-All split narrows the scope (changes the empty state). */
  searchActive: boolean;
  /** Widen the shared scope back to every session: clear the search, the split, and reminder mode. */
  onShowAll: () => void;
  onNewSession: () => void;
  /** Right-click, long-press, or keyboard context menu on a card (#154). */
  onSessionMenu: (sessionId: string, anchor: { x: number; y: number }, restoreTarget: () => HTMLElement | null) => void;
}) {
  const api = useApi();
  const { setFilters, navigate } = useStoreActions();
  // The empty state's hint names Multi-Agent Run; with the experiment off that destination has
  // been removed everywhere else, and a hint pointing at a control that does not exist teaches
  // the reader the app is broken rather than configured.
  const multiAgentEnabled = useExperiments().flags.multiAgent;
  const allSessions = useStoreSelector((s) => s.sessions);
  const runners = useStoreSelector((s) => s.runners);
  const boxes = useStoreSelector((s) => s.boxes);
  const filters = useStoreSelector((s) => s.filters);

  const agentOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of runners.values()) for (const a of r.agents) map.set(a.id, a.name);
    return [...map.entries()];
  }, [runners]);

  const boxByRunner = useMemo(() => {
    const m = new Map<string, BoxView>();
    for (const b of boxes.values()) m.set(b.runnerId, b);
    return m;
  }, [boxes]);
  const machineName = (runnerId: string) =>
    runnerDisplay(runners.get(runnerId), boxByRunner.get(runnerId), runnerId).name;
  // Two Machines may share a name; filtering by the wrong one silently hides the sessions you want.
  const machineLabels = useMemo(
    () => machineOptionLabels([...runners.values()], (runnerId) => boxByRunner.get(runnerId)),
    [boxByRunner, runners],
  );

  const scopedCount = scoped.length;
  const filtered = Boolean(filters.runnerId || filters.agentId);
  const visible = useMemo(
    () =>
      scoped
        .filter((s) => !filters.runnerId || s.runnerId === filters.runnerId)
        .filter((s) => !filters.agentId || s.agentId === filters.agentId),
    [scoped, filters],
  );

  const byColumn = useMemo(() => {
    const cols = new Map<string, SessionView[]>();
    for (const c of BOARD_COLUMNS) cols.set(c.id, []);
    for (const s of visible) cols.get(s.column)?.push(s);
    for (const list of cols.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
    return cols;
  }, [visible]);

  // Drag a card onto a column to file the session there manually (server-side
  // setColumn override). Depth counter per column: dragleave fires when crossing
  // into child elements, so a plain boolean would flicker off mid-hover.
  const [dragOverCol, setDragOverCol] = useState<BoardColumn | null>(null);
  const dragDepth = useRef(new Map<BoardColumn, number>());
  // dragend fires on the SOURCE card for every outcome incl. Escape / drop-outside —
  // the only reliable place to clear highlight + depth state after an aborted drag.
  const clearDragState = () => {
    dragDepth.current.clear();
    setDragOverCol(null);
  };
  const colDragProps = (colId: BoardColumn) => ({
    onDragEnter: (e: DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.types.includes("text/wollipog-session")) return;
      const d = dragDepth.current.get(colId) ?? 0;
      dragDepth.current.set(colId, d + 1);
      setDragOverCol(colId);
    },
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.types.includes("text/wollipog-session")) return;
      e.preventDefault(); // required or the browser refuses the drop
      e.dataTransfer.dropEffect = "move";
    },
    onDragLeave: () => {
      const d = (dragDepth.current.get(colId) ?? 1) - 1;
      if (d <= 0) {
        dragDepth.current.delete(colId);
        setDragOverCol((cur) => (cur === colId ? null : cur));
      } else {
        dragDepth.current.set(colId, d);
      }
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragDepth.current.set(colId, 0);
      setDragOverCol(null);
      const id = e.dataTransfer.getData("text/wollipog-session");
      if (!id) return;
      if (allSessions.get(id)?.column === colId) return;
      void api.setColumn(id, colId).catch(() => {
        /* board re-syncs from the next session_upsert; a failed move just stays put */
      });
    },
  });

  return (
    <div className="board-wrap" tabIndex={-1}>
      <div className="board-toolbar">
        <div className="filters">
          <label className="filter">
            <span>Machine</span>
            <select
              value={filters.runnerId ?? ""}
              onChange={(e) => setFilters({ runnerId: e.target.value || null })}
            >
              <option value="">All Machines</option>
              {[...runners.values()].map((r) => (
                <option key={r.runnerId} value={r.runnerId}>
                  {machineLabels.get(r.runnerId) ?? machineName(r.runnerId)}
                </option>
              ))}
            </select>
          </label>
          <label className="filter">
            <span>Agent</span>
            <select
              value={filters.agentId ?? ""}
              onChange={(e) => setFilters({ agentId: e.target.value || null })}
            >
              <option value="">All Agents</option>
              {agentOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {(filters.runnerId || filters.agentId) && (
            <button
              className="btn ghost sm"
              onClick={() => setFilters({ runnerId: null, agentId: null })}
            >
              Clear
            </button>
          )}
        </div>
        <div className="board-count">
          {visible.length} Session{visible.length === 1 ? "" : "s"}
        </div>
      </div>


      {visible.length === 0 ? (
        // An empty board and a filtered-out board are different problems, and only one of them is
        // solved by starting a session. Offering "New Session" against an active filter created on
        // the dialog's default Machine leaves the filter in place and the board still empty — the
        // action looked like a way out and was not one.
        filtered && scopedCount > 0 ? (
          <Empty
            icon={<BoardIcon size={28} />}
            title="No Matching Sessions"
            action={
              <button type="button" className="btn primary sm" onClick={() => setFilters({ runnerId: null, agentId: null })}>
                Clear Filters
              </button>
            }
            hint={<>{scopedCount} session{scopedCount === 1 ? "" : "s"} {scopedCount === 1 ? "is" : "are"} hidden by the current Machine and Agent filters.</>}
          />
        ) : searchActive ? (
          // The shared split tabs or search emptied the scope before the board-local filters ran;
          // "New Session" cannot answer a query mismatch, so the way out is widening the scope.
          <Empty
            icon={<BoardIcon size={28} />}
            title="No Matching Sessions"
            action={
              <button type="button" className="btn primary sm" onClick={onShowAll}>
                Show All Sessions
              </button>
            }
            hint={<>No sessions match the current group or search.</>}
          />
        ) : (
          <Empty
            icon={<BoardIcon size={28} />}
            title="No Sessions Yet"
            // A filter can still be ACTIVE here — archive the last unarchived session and the count
            // is zero while Machine B stays selected. Creating a session on the dialog's own default
            // would then be hidden by that filter, and the board would come back empty. An action
            // that advertises a way out cannot leave a filter behind that undoes it.
            action={<button type="button" className="btn primary sm" onClick={() => {
              if (filtered) setFilters({ runnerId: null, agentId: null });
              onNewSession();
            }}>New Session</button>}
            hint={multiAgentEnabled
              ? <>Click “New Session” to start an agent, or “Multi-Agent Run” to compare several.</>
              : <>Click “New Session” to start an agent.</>}
          />
        )
      ) : (
        <div className="board">
          {BOARD_COLUMNS.map((col) => {
            const list = byColumn.get(col.id) ?? [];
            return (
              <div
                key={col.id}
                className={`column col-${col.id}${dragOverCol === col.id ? " drag-over" : ""}`}
                {...colDragProps(col.id)}
              >
                <div className="column-head">
                  <span>{col.title}</span>
                  <span className="column-count">{list.length}</span>
                </div>
                <BoardColumnBody
                  sessions={list}
                  reminders={reminders}
                  machineName={machineName}
                  runnerOnline={(runnerId) => runners.get(runnerId)?.status === "online"}
                  onOpen={(sessionId) => navigate({ name: "session", id: sessionId })}
                  onDragEnd={clearDragState}
                  onSessionMenu={onSessionMenu}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BoardColumnBody({
  sessions,
  reminders,
  machineName,
  runnerOnline,
  onOpen,
  onDragEnd,
  onSessionMenu,
}: {
  sessions: SessionView[];
  reminders: ReadonlyMap<string, SessionReminderView>;
  machineName: (runnerId: string) => string;
  runnerOnline: (runnerId: string) => boolean;
  onOpen: (sessionId: string) => void;
  onDragEnd: () => void;
  onSessionMenu: (sessionId: string, anchor: { x: number; y: number }, restoreTarget: () => HTMLElement | null) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div className="column-body measured-virtual-scroll" ref={scrollRef}>
      <MeasuredVirtualList
        items={sessions}
        getKey={sessionCardKey}
        estimateSize={estimateSessionCard}
        renderItem={(session) => (
          <SessionCard
            session={session}
            reminder={reminders.get(session.id)}
            machineName={machineName(session.runnerId)}
            runnerOnline={runnerOnline(session.runnerId)}
            onOpen={() => onOpen(session.id)}
            onDragEnd={onDragEnd}
            onSessionMenu={onSessionMenu}
          />
        )}
        scrollRef={scrollRef}
        overscan={3}
        rowGap={10}
        pinDraggedRow
        className="column-virtual-list"
        ariaLabel="Sessions in column"
        dataKind="board-column"
      />
    </div>
  );
}

function SessionCard({
  session,
  reminder,
  machineName,
  runnerOnline,
  onOpen,
  onDragEnd,
  onSessionMenu,
}: {
  session: SessionView;
  reminder?: SessionReminderView;
  machineName: string;
  runnerOnline: boolean;
  onOpen: () => void;
  onDragEnd: () => void;
  onSessionMenu: (sessionId: string, anchor: { x: number; y: number }, restoreTarget: () => HTMLElement | null) => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const snoozedAttention = reminder?.state === "pending" ? snoozedSessionAttentionReason(session) : null;
  const extraSnoozedAttention = snoozedAttention?.kind === "orphaned_background_work" ||
      snoozedAttention?.kind === "background_delivery_watchdog"
    ? snoozedAttention
    : null;
  // Resolved by session id AT RESTORE TIME, not by card instance: a live column move remounts
  // the virtualized card while its menu is open, and a ref to the old instance would strand
  // focus on <body>. The board canvas itself is the fallback (it is focusable for the F6 zone).
  const restoreTarget = () => {
    for (const card of document.querySelectorAll<HTMLElement>(".board .card")) {
      if (card.dataset["sessionId"] === session.id) return card.querySelector<HTMLElement>(".card-open");
    }
    return document.querySelector<HTMLElement>(".board-wrap");
  };
  const openMenu = (anchor: { x: number; y: number }) => onSessionMenu(session.id, anchor, restoreTarget);
  const longPress = useLongPress(openMenu);

  const approve = async (e: MouseEvent, optionId: string | null) => {
    e.stopPropagation();
    if (!session.pendingApproval) return;
    setBusy(true);
    try {
      await api.approve(session.id, { requestId: session.pendingApproval.requestId, optionId });
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      className="card"
      data-session-id={session.id}
      {...longPress.handlers}
      onClick={() => { if (!longPress.consumeSuppressedClick()) onOpen(); }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        // The platform context-menu interaction while focus is inside the card.
        if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
        e.preventDefault();
        const box = e.currentTarget.getBoundingClientRect();
        openMenu({ x: box.left + 24, y: box.top + 24 });
      }}
      draggable
      onDragStart={(e) => {
        // A drag that starts IS the gesture: the long-press must stand down.
        longPress.handlers.onDragStart();
        e.dataTransfer.setData("text/wollipog-session", session.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={onDragEnd}
    >
      <div className="card-top">
        <SessionStatusIndicators session={session} disconnected={!runnerOnline} />
        <span className="card-time">{relativeTime(session.lastEventAt ?? session.updatedAt)}</span>
      </div>
      <button
        type="button"
        className="card-title card-open"
        onClick={(event) => { event.stopPropagation(); onOpen(); }}
      >
        {session.title}
      </button>
      {session.preview && <div className="card-preview">{session.preview}</div>}

      {session.pendingApproval && session.pendingApproval.kind === "question" ? (
        // Structured questions have no inline options (options[] is empty by design) — the
        // card offers Open, which lands on the detail view's interactive question card.
        <div className="card-approval" onClick={(e) => e.stopPropagation()}>
          <div className="approval-title">❓ {session.pendingApproval.title}</div>
          <div className="approval-actions">
            <button className="btn sm primary" onClick={onOpen}>
              Answer…
            </button>
          </div>
        </div>
      ) : session.pendingApproval ? (
        <div className="card-approval" onClick={(e) => e.stopPropagation()}>
          <div className="approval-title">{session.pendingApproval.title}</div>
          <div className="approval-actions">
            {session.pendingApproval.options.map((o) => (
              <button
                key={o.optionId}
                className={`btn sm ${o.kind?.startsWith("allow") ? "primary" : "danger"}`}
                disabled={busy || !runnerOnline}
                onClick={(e) => approve(e, o.optionId)}
              >
                {o.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="card-meta">
        {extraSnoozedAttention && (
          <span
            className="inbox-status-pill blocked"
            title={extraSnoozedAttention.description}
            aria-label={`Attention: ${extraSnoozedAttention.label}`}
          >
            {extraSnoozedAttention.label}
          </span>
        )}
        {reminder && (
          <span
            className="inbox-status-pill reminder"
            title={reminderBadgeDescription(reminder)}
            aria-label={`Reminder: ${reminder.state === "fired"
              ? reminderBadgeDescription(reminder)
              : reminderBadgeLabel(reminder)}`}
          >
            {reminderBadgeLabel(reminder)}
          </span>
        )}
        <span className="tag tag-machine" title="Runner / machine">
          {machineName}
        </span>
        {session.agentName && (
          <span className="tag tag-agent">{sessionAgentLabel(session.agentName, session.driver, session.agentId)}</span>
        )}
        {session.useWorktree && <span className="tag tag-wt" title={session.worktreePath ?? "isolated worktree"}>Worktree</span>}
        {session.runId && <span className="tag tag-run">Run</span>}
      </div>
    </article>
  );
}
