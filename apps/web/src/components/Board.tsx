import { BoardIcon } from "./Icons.js";
import { type DragEvent, type MouseEvent, useMemo, useRef, useState } from "react";
import { BOARD_COLUMNS, type BoardColumn, type BoxView, type SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { relativeTime } from "../format.js";
import { machineOptionLabels, runnerDisplay } from "../runners.js";
import { StatusBadge, Empty } from "./common.js";
import { sessionAgentLabel } from "./agent-options.js";
import { ReviewQueue } from "./ReviewQueue.js";
import { MeasuredVirtualList } from "./MeasuredVirtualList.js";

const sessionCardKey = (session: SessionView) => session.id;
const estimateSessionCard = (session: SessionView) => session.pendingApproval ? 230 : session.preview ? 155 : 120;

export function Board({ onOpenReview, onNewSession }: {
  onOpenReview: (sessionId: string) => void;
  onNewSession: () => void;
}) {
  const api = useApi();
  const { setFilters, navigate } = useStoreActions();
  const sessions = useStoreSelector((s) => s.sessions);
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

  const unarchived = useMemo(() => [...sessions.values()].filter((s) => !s.archived), [sessions]);
  const unarchivedCount = unarchived.length;
  const filtered = Boolean(filters.runnerId || filters.agentId);
  const visible = useMemo(
    () =>
      unarchived
        .filter((s) => !filters.runnerId || s.runnerId === filters.runnerId)
        .filter((s) => !filters.agentId || s.agentId === filters.agentId),
    [unarchived, filters],
  );
  const reviewKey = useMemo(() => [
    ...[...sessions.values()]
      .filter((session) => !session.archived)
      .map((session) => JSON.stringify([
        session.id,
        session.status,
        session.worktreePath ?? null,
        session.pendingApproval?.requestId ?? null,
      ])),
    ...[...runners.values()].map((runner) => JSON.stringify([runner.runnerId, runner.status])),
  ].sort().join("|"), [sessions, runners]);

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
      if (sessions.get(id)?.column === colId) return;
      void api.setColumn(id, colId).catch(() => {
        /* board re-syncs from the next session_upsert; a failed move just stays put */
      });
    },
  });

  return (
    <div className="board-wrap">
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

      <ReviewQueue
        refreshKey={reviewKey}
        onOpen={(sessionId) => navigate({ name: "session", id: sessionId })}
        onOpenReview={onOpenReview}
      />

      {visible.length === 0 ? (
        // An empty board and a filtered-out board are different problems, and only one of them is
        // solved by starting a session. Offering "New Session" against an active filter created on
        // the dialog's default Machine leaves the filter in place and the board still empty — the
        // action looked like a way out and was not one.
        filtered && unarchivedCount > 0 ? (
          <Empty
            icon={<BoardIcon size={28} />}
            title="No Matching Sessions"
            action={
              <button type="button" className="btn primary sm" onClick={() => setFilters({ runnerId: null, agentId: null })}>
                Clear Filters
              </button>
            }
            hint={<>{unarchivedCount} session{unarchivedCount === 1 ? "" : "s"} {unarchivedCount === 1 ? "is" : "are"} hidden by the current Machine and Agent filters.</>}
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
            hint={<>Click “New Session” to start an agent, or “Multi-Agent Run” to compare several.</>}
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
                  machineName={machineName}
                  runnerOnline={(runnerId) => runners.get(runnerId)?.status === "online"}
                  onOpen={(sessionId) => navigate({ name: "session", id: sessionId })}
                  onDragEnd={clearDragState}
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
  machineName,
  runnerOnline,
  onOpen,
  onDragEnd,
}: {
  sessions: SessionView[];
  machineName: (runnerId: string) => string;
  runnerOnline: (runnerId: string) => boolean;
  onOpen: (sessionId: string) => void;
  onDragEnd: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div className="column-body" ref={scrollRef}>
      <MeasuredVirtualList
        items={sessions}
        getKey={sessionCardKey}
        estimateSize={estimateSessionCard}
        renderItem={(session) => (
          <SessionCard
            session={session}
            machineName={machineName(session.runnerId)}
            runnerOnline={runnerOnline(session.runnerId)}
            onOpen={() => onOpen(session.id)}
            onDragEnd={onDragEnd}
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
  machineName,
  runnerOnline,
  onOpen,
  onDragEnd,
}: {
  session: SessionView;
  machineName: string;
  runnerOnline: boolean;
  onOpen: () => void;
  onDragEnd: () => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);

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
      onClick={onOpen}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/wollipog-session", session.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={onDragEnd}
    >
      <div className="card-top">
        <StatusBadge status={session.status} />
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
