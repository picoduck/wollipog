import { BoardIcon, ChevronDownIcon, ComputerIcon, MoreHorizontalIcon } from "./Icons.js";
import { State, useSnapshotState } from "./State.js";
import { type DragEvent, type KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  BOARD_COLUMNS,
  plainTextPreview,
  type BoardColumn,
  type BoxView,
  type PendingApproval,
  type PermissionOption,
  type SessionReminderView,
  type SessionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { destination } from "../navigation.js";
import { runnerDisplay } from "../runners.js";
import { SessionPinIndicator, ThreadDot } from "./common.js";
import { inboxProjectName, inboxThreadChildrenLabel, inboxThreadChildState, isInboxBlocked, type InboxThreadChildren } from "../inbox.js";
import { useAccessibleMenu, useLongPress } from "./interactions.js";
import { sessionCommandRefusal } from "../session-command-permissions.js";
import { sessionAgentLabel } from "./agent-options.js";
import { MeasuredVirtualList } from "./MeasuredVirtualList.js";
import { useExperiments } from "../use-experiments.js";
import { activeBoardFilterCount, filterBoardSessions } from "./BoardFilters.js";
import { showsActivityStrip } from "../activity.js";
import { boardCardDecisions, boardCardRequestCode, boardCardSignInItems, type BoardCardSignInItem } from "../board-card.js";
import { sessionRowStatus } from "../session-row-status.js";
import { sessionDisplayTitle } from "../session-title.js";
import { ActivityStrip } from "./ActivityStrip.js";
import { AgentIcon } from "./AgentIcon.js";
import { CountBadge } from "./CountBadge.js";
import { inboxRowReadsClock } from "./InboxList.js";
import { inboxRowTimestamp, sessionStalledForMs, SessionRowTime } from "./InboxRow.js";
import { MenuItem, MenuSeparator, MenuSurface } from "./Menu.js";
import { Notice } from "./Notice.js";
import { SessionRowStatusBadge } from "./SessionRowStatusBadge.js";
import { TabList } from "./Tabs.js";
import { useIsMobile } from "./useIsMobile.js";

const sessionCardKey = (session: SessionView) => session.id;
const estimateSessionCard = (session: SessionView) => session.pendingApproval ? 196 : 118;

/** A column header's status dot (§11.1): Running is info, Needs Input warning, the rest neutral. */
const COLUMN_TONE: Record<BoardColumn, "neutral" | "info" | "warning"> = {
  queued: "neutral",
  running: "info",
  input_required: "warning",
  review: "neutral",
  done: "neutral",
};

/** The phone Board's column order (#2216): what needs the person first, then what is moving, Queued last. */
export const PHONE_BOARD_COLUMNS: readonly BoardColumn[] = ["input_required", "running", "review", "done", "queued"];

const COLUMN_TITLE = new Map(BOARD_COLUMNS.map((column) => [column.id, column.title]));

/** The column a phone Board opens on (#2216): the first with a card, in `PHONE_BOARD_COLUMNS` order. */
export function openingBoardColumn(byColumn: ReadonlyMap<BoardColumn, readonly unknown[]>): BoardColumn {
  return PHONE_BOARD_COLUMNS.find((column) => (byColumn.get(column)?.length ?? 0) > 0) ?? PHONE_BOARD_COLUMNS[0]!;
}

/**
 * The Sessions view's board mode: the same scoped session list the list mode renders (project
 * split, search, and reminder filtering applied by the parent), grouped into status columns.
 * The Machine and Agent filters are board-local refinements on top of that shared scope; their
 * menu buttons live in the Sessions tab row (`BoardFilterTools`, #2201), and on a phone in the app
 * bar's Filters sheet (#2216). A phone shows one column at a time under a strip of column tabs.
 */
export function Board({ sessions: scoped, reminders = new Map(), stalledSessionIds = new Set(), pinnedSessionIds = new Set(), searchActive, onShowAll, onNewSession, onSessionMenu, column, onColumnChange }: {
  /** Already scoped by the Sessions toolbar: unarchived, split, query, and reminder mode. */
  sessions: SessionView[];
  stalledSessionIds?: ReadonlySet<string>;
  reminders?: ReadonlyMap<string, SessionReminderView>;
  pinnedSessionIds?: ReadonlySet<string>;
  /** True while the shared search or a non-All split narrows the scope (changes the empty state). */
  searchActive: boolean;
  /** Widen the shared scope back to every session: clear the search, the split, and reminder mode. */
  onShowAll: () => void;
  onNewSession: () => void;
  /** Right-click, long-press, or keyboard context menu on a card (#154). */
  onSessionMenu: (sessionId: string, anchor: { x: number; y: number }, restoreTarget: () => HTMLElement | null) => void;
  /**
   * The phone Board's column, held by an owner that outlives the Board (#2216): the Sessions page
   * swaps the Board for No Matches while a search finds nothing, and the column must survive that.
   * Null until the Board first has sessions. Without it the Board holds the column itself.
   */
  column?: BoardColumn | null;
  onColumnChange?: (column: BoardColumn) => void;
}) {
  const api = useApi();
  const { setFilters, navigate } = useStoreActions();
  // The empty state's hint names Multi-Agent Run; with the experiment off that destination has
  // been removed everywhere else, and a hint pointing at a control that does not exist teaches
  // the reader the app is broken rather than configured.
  const multiAgentEnabled = useExperiments().flags.multiAgent;
  const allSessions = useStoreSelector((s) => s.sessions);
  const snapshot = useSnapshotState();
  const runners = useStoreSelector((s) => s.runners);
  const boxes = useStoreSelector((s) => s.boxes);
  const filters = useStoreSelector((s) => s.filters);
  const projects = useStoreSelector((s) => s.projects);
  const projectsSupported = useStoreSelector((s) => s.projectsSupported);

  const boxByRunner = useMemo(() => {
    const m = new Map<string, BoxView>();
    for (const b of boxes.values()) m.set(b.runnerId, b);
    return m;
  }, [boxes]);
  // The machine is quiet meta after the project, and only where there is more than one (#2222).
  const multipleMachines = useMemo(
    () => new Set([...runners.keys(), ...scoped.map((session) => session.runnerId)]).size > 1,
    [runners, scoped],
  );
  const machineName = (runnerId: string) =>
    multipleMachines ? runnerDisplay(runners.get(runnerId), boxByRunner.get(runnerId), runnerId).name : null;
  const projectName = (session: SessionView) => inboxProjectName(session, projectsSupported ? projects : undefined);

  const scopedCount = scoped.length;
  const filtered = activeBoardFilterCount(filters) > 0;
  const visible = useMemo(() => filterBoardSessions(scoped, filters), [scoped, filters]);

  const byColumn = useMemo(() => {
    const cols = new Map<BoardColumn, SessionView[]>();
    for (const c of BOARD_COLUMNS) cols.set(c.id, []);
    for (const s of visible) cols.get(s.column)?.push(s);
    // `scoped` already carries the canonical, pin- and family-aware Inbox order. Preserve it
    // within each column so pinning from a card has the same immediate ordering effect as pinning
    // from a row; sorting again by `updatedAt` would erase that structural choice.
    return cols;
  }, [visible]);

  // A phone shows one column (#2216). The Board opens on the first column with a card and then keeps
  // its column, the opening one or the one chosen, while it stays open: a live update that empties
  // the column or fills an earlier one never moves the page under the person reading it.
  const phone = useIsMobile();
  const [ownColumn, setOwnColumn] = useState<BoardColumn | null>(null);
  const phoneColumn = column !== undefined ? column : ownColumn;
  const setPhoneColumn = onColumnChange ?? setOwnColumn;
  const shownColumn = phoneColumn ?? openingBoardColumn(byColumn);
  // The opening column is recorded before paint, so the first frame already shows it.
  const hasSessions = visible.length > 0;
  useLayoutEffect(() => {
    if (phoneColumn === null && hasSessions) setPhoneColumn(shownColumn);
  }, [phoneColumn, hasSessions, setPhoneColumn, shownColumn]);
  const tabIdPrefix = `board-column-${useId().replace(/:/g, "")}`;
  const columnTabId = (column: BoardColumn) => `${tabIdPrefix}-tab-${column}`;
  const columnPanelId = `${tabIdPrefix}-panel`;
  // Arrow keys, Home and End move between the column tabs and show the column they reach (§10.1).
  const onColumnTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, from: BoardColumn) => {
    const index = PHONE_BOARD_COLUMNS.indexOf(from);
    const last = PHONE_BOARD_COLUMNS.length - 1;
    const next = event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
        : event.key === "Home" ? 0
          : event.key === "End" ? last
            : null;
    if (next === null) return;
    event.preventDefault();
    const column = PHONE_BOARD_COLUMNS[next]!;
    flushSync(() => setPhoneColumn(column));
    document.getElementById(columnTabId(column))?.focus();
  };

  // The family chip on a parent's card (#896). The Board does not nest, and a parent's children
  // are usually in other columns, so the rollup is read off the whole scope rather than a column.
  const threadChildren = useMemo(() => {
    const present = new Set(scoped.map((session) => session.id));
    const map = new Map<string, InboxThreadChildren>();
    for (const session of scoped) {
      const parentId = session.parentSessionId;
      if (!parentId || !present.has(parentId) || parentId === session.id) continue;
      const entry = map.get(parentId) ?? { count: 0, waiting: 0, children: [] };
      entry.count += 1;
      if (isInboxBlocked(session)) entry.waiting += 1;
      entry.children.push({ id: session.id, title: session.title, state: inboxThreadChildState(session, stalledSessionIds.has(session.id)) });
      map.set(parentId, entry);
    }
    return map;
  }, [scoped, stalledSessionIds]);

  // Drag a card onto a column to file the session there manually (server-side
  // setColumn override). Depth counter per column: dragleave fires when crossing
  // into child elements, so a plain boolean would flicker off mid-hover.
  const [dragOverCol, setDragOverCol] = useState<BoardColumn | null>(null);
  const dragDepth = useRef(new Map<BoardColumn, number>());
  // While a card is dragged, empty columns open from their 40px strips to full width so they are
  // easy to aim at. The change waits a task: Chromium cancels a drag whose source reflows inside
  // its own dragstart.
  const [dragging, setDragging] = useState(false);
  const dragTimer = useRef<number | null>(null);
  const startDrag = () => {
    if (dragTimer.current !== null) window.clearTimeout(dragTimer.current);
    dragTimer.current = window.setTimeout(() => {
      dragTimer.current = null;
      setDragging(true);
    }, 0);
  };
  useEffect(() => () => {
    if (dragTimer.current !== null) window.clearTimeout(dragTimer.current);
  }, []);
  // A card that unmounts mid-drag (a live column move) never receives its dragend, so any drag that
  // ends anywhere closes the strips again.
  useEffect(() => {
    if (!dragging) return;
    const end = () => setDragging(false);
    window.addEventListener("dragend", end, true);
    window.addEventListener("drop", end, true);
    return () => {
      window.removeEventListener("dragend", end, true);
      window.removeEventListener("drop", end, true);
    };
  }, [dragging]);
  // dragend fires on the SOURCE card for every outcome incl. Escape / drop-outside —
  // the only reliable place to clear highlight + depth state after an aborted drag.
  const clearDragState = () => {
    if (dragTimer.current !== null) window.clearTimeout(dragTimer.current);
    dragTimer.current = null;
    dragDepth.current.clear();
    setDragOverCol(null);
    setDragging(false);
  };
  const colDragProps = (colId: BoardColumn) => ({
    onDragEnter: (e: DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes("text/wollipog-session")) return;
      const d = dragDepth.current.get(colId) ?? 0;
      dragDepth.current.set(colId, d + 1);
      setDragOverCol(colId);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
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
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      dragDepth.current.set(colId, 0);
      setDragOverCol(null);
      setDragging(false);
      const id = e.dataTransfer.getData("text/wollipog-session");
      if (!id) return;
      if (allSessions.get(id)?.column === colId) return;
      void api.setColumn(id, colId).catch(() => {
        /* board re-syncs from the next session_upsert; a failed move just stays put */
      });
    },
  });

  const columnBody = (list: SessionView[]) => (
    <BoardColumnBody
      sessions={list}
      pinnedSessionIds={pinnedSessionIds}
      reminders={reminders}
      stalledSessionIds={stalledSessionIds}
      projectName={projectName}
      machineName={machineName}
      runnerStatus={(runnerId) => runners.get(runnerId)?.status}
      onOpen={(sessionId) => navigate({ name: "session", id: sessionId })}
      threadChildren={threadChildren}
      onDragStart={startDrag}
      onDragEnd={clearDragState}
      onSessionMenu={onSessionMenu}
    />
  );

  return (
    <div className={`board-wrap${phone ? " is-phone" : ""}`} tabIndex={-1}>
      {visible.length === 0 && (snapshot.offline || snapshot.loading) ? (
        // No snapshot, or no connection: an empty map proves nothing yet (§12.5).
        <State variant={snapshot.offline ? "offline" : "loading"}>
          {snapshot.offline ? "Reconnecting…" : "Loading sessions…"}
        </State>
      ) : visible.length === 0 ? (
        // An empty board and a filtered-out board are different problems, and only one of them is
        // solved by starting a session. Offering "New Session" against an active filter created on
        // the dialog's default Machine leaves the filter in place and the board still empty — the
        // action looked like a way out and was not one.
        filtered && scopedCount > 0 ? (
          <State
            variant="no-results"
            compact
            icon={<BoardIcon />}
            title="No Matching Sessions"
            actions={
              <button type="button" className="btn sm" onClick={() => setFilters({ runnerId: null, agentId: null })}>
                Clear Filters
              </button>
            }
          >
            {scopedCount} session{scopedCount === 1 ? "" : "s"} {scopedCount === 1 ? "is" : "are"} hidden by the current Machine and Agent filters.
          </State>
        ) : searchActive ? (
          // The shared split tabs or search emptied the scope before the board-local filters ran;
          // "New Session" cannot answer a query mismatch, so the way out is widening the scope.
          <State
            variant="no-results"
            icon={<BoardIcon />}
            title="No Matching Sessions"
            actions={
              <button type="button" className="btn sm" onClick={onShowAll}>
                Show All Sessions
              </button>
            }
          >
            No sessions match the current group or search.
          </State>
        ) : (
          <State
            icon={<BoardIcon />}
            title={`No ${destination("inbox").name} Yet`}
            // A filter can still be ACTIVE here — archive the last unarchived session and the count
            // is zero while Machine B stays selected. Creating a session on the dialog's own default
            // would then be hidden by that filter, and the board would come back empty. An action
            // that advertises a way out cannot leave a filter behind that undoes it.
            actions={<button type="button" className="btn primary" onClick={() => {
              if (filtered) setFilters({ runnerId: null, agentId: null });
              onNewSession();
            }}>New Session</button>}
          >
            {multiAgentEnabled
              ? <>Click “New Session” to start an agent, or “Multi-Agent Run” to compare several.</>
              : <>Click “New Session” to start an agent.</>}
          </State>
        )
      ) : phone ? (
        // One column at a time (#2216, §15.1): the column tabs with their counts, Needs Input's as a
        // warning badge, then the chosen column's cards at full width. A tab is also a drop target,
        // for a narrow window with a mouse.
        <div className={`board board-phone${dragging ? " is-dragging" : ""}`}>
          <TabList label="Board Columns" className="board-column-tabs">
            {PHONE_BOARD_COLUMNS.map((id) => {
              const title = COLUMN_TITLE.get(id) ?? id;
              const count = byColumn.get(id)?.length ?? 0;
              const selected = id === shownColumn;
              return (
                <button
                  key={id}
                  id={columnTabId(id)}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={columnPanelId}
                  // The badge is aria-hidden, so the count joins the name.
                  aria-label={`${title}, ${count}`}
                  tabIndex={selected ? 0 : -1}
                  className={`tab board-column-tab col-${id}${dragOverCol === id ? " drag-over" : ""}`}
                  onClick={() => setPhoneColumn(id)}
                  onKeyDown={(event) => onColumnTabKeyDown(event, id)}
                  {...colDragProps(id)}
                >
                  {title}
                  {id === "input_required" && count > 0
                    ? <CountBadge count={count} />
                    : <span className="count">{count}</span>}
                </button>
              );
            })}
          </TabList>
          <div
            id={columnPanelId}
            role="tabpanel"
            aria-labelledby={columnTabId(shownColumn)}
            className={`column col-${shownColumn}${dragOverCol === shownColumn ? " drag-over" : ""}`}
            {...colDragProps(shownColumn)}
          >
            {(byColumn.get(shownColumn)?.length ?? 0) === 0 ? (
              <State compact>No sessions are in {COLUMN_TITLE.get(shownColumn) ?? shownColumn}.</State>
            ) : columnBody(byColumn.get(shownColumn) ?? [])}
          </div>
        </div>
      ) : (
        <div className={`board${dragging ? " is-dragging" : ""}`}>
          {BOARD_COLUMNS.map((col) => {
            const list = byColumn.get(col.id) ?? [];
            // An empty column folds to a 40px strip with its header turned on end (#2201); it stays a
            // drop target, and opens to full width while a card is dragged.
            const empty = list.length === 0;
            return (
              <div
                key={col.id}
                className={`column col-${col.id}${empty ? " is-empty" : ""}${dragOverCol === col.id ? " drag-over" : ""}`}
                {...colDragProps(col.id)}
              >
                <div className="column-head">
                  <span className={`column-dot t-${COLUMN_TONE[col.id]}`} aria-hidden="true" />
                  <span className="column-title">{col.title}</span>
                  <span className="count">{list.length}</span>
                </div>
                {columnBody(list)}
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
  pinnedSessionIds,
  reminders,
  stalledSessionIds,
  projectName,
  machineName,
  runnerStatus,
  onOpen,
  threadChildren,
  onDragStart,
  onDragEnd,
  onSessionMenu,
}: {
  sessions: SessionView[];
  pinnedSessionIds: ReadonlySet<string>;
  reminders: ReadonlyMap<string, SessionReminderView>;
  stalledSessionIds: ReadonlySet<string>;
  projectName: (session: SessionView) => string;
  machineName: (runnerId: string) => string | null;
  runnerStatus: (runnerId: string) => string | undefined;
  onOpen: (sessionId: string) => void;
  threadChildren: ReadonlyMap<string, InboxThreadChildren>;
  onDragStart: () => void;
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
            pinned={pinnedSessionIds.has(session.id)}
            reminder={reminders.get(session.id)}
            projectName={projectName(session)}
            machineName={machineName(session.runnerId)}
            runnerOnline={runnerStatus(session.runnerId) === "online"}
            runnerConnected={runnerStatus(session.runnerId) !== "offline"}
            stalled={stalledSessionIds.has(session.id)}
            onOpen={() => onOpen(session.id)}
            threadChildren={threadChildren.get(session.id) ?? null}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onSessionMenu={onSessionMenu}
          />
        )}
        scrollRef={scrollRef}
        overscan={3}
        rowGap={10}
        pinDraggedRow
        className="column-virtual-list"
        ariaLabel="Sessions in Column"
        dataKind="board-column"
      />
    </div>
  );
}

function SessionCard({
  session,
  pinned,
  reminder,
  projectName,
  machineName,
  runnerOnline,
  runnerConnected,
  stalled,
  onOpen,
  threadChildren,
  onDragStart,
  onDragEnd,
  onSessionMenu,
}: {
  session: SessionView;
  pinned: boolean;
  reminder?: SessionReminderView;
  projectName: string;
  /** The machine, as quiet meta after the project, only where there is more than one machine. */
  machineName: string | null;
  /** The machine is online: a decision can reach it. */
  runnerOnline: boolean;
  /** The machine is not known to be offline: the status reads as the row's does (#2209). */
  runnerConnected: boolean;
  stalled: boolean;
  onOpen: () => void;
  threadChildren: InboxThreadChildren | null;
  onDragStart: () => void;
  onDragEnd: () => void;
  onSessionMenu: (sessionId: string, anchor: { x: number; y: number }, restoreTarget: () => HTMLElement | null) => void;
}) {
  // The card reads its own activity, as a list row does, so one session's tool calls re-render one card.
  const activity = useStoreSelector((state) => state.activity.get(session.id));
  const activityNow = useStoreSelector((state) =>
    inboxRowReadsClock(session, state.activity.get(session.id), stalled, state.activityNow) ? state.activityNow : 0);
  const lastActivityAt = inboxRowTimestamp(session, activity);
  const status = sessionRowStatus(session, {
    runnerOnline: runnerConnected,
    reminder,
    stalledForMs: sessionStalledForMs(stalled, activityNow, lastActivityAt),
  });
  const strip = showsActivityStrip(session.status, activity, activityNow);
  const agent = sessionAgentLabel(session.agentName, session.driver, session.agentId);
  const request = session.pendingApproval;
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
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      {/* The card's one primary click (§5.3): its box is stretched over the whole card. Screen readers
          meet the title first. */}
      <button
        type="button"
        className="card-title card-open"
        onClick={(event) => { event.stopPropagation(); onOpen(); }}
      >
        {sessionDisplayTitle(session.title)}
      </button>
      {/* Line 1 (#2222), drawn first by `order`: who and where, which gives up width first, then the
          pin and the time. It is written after the stretched open button, as is the ⋯ that ends the
          line, so their tooltips and controls stack above it. */}
      <div className="card-head">
        <span className="card-sender">
          <AgentIcon driver={session.driver} agentName={session.agentName} size={16} />
          <span className="card-sender-text">{agent} · {projectName}</span>
        </span>
        {machineName && (
          <span className="card-machine">
            <ComputerIcon size={14} />
            <span className="sr-only">Machine: </span>
            <span className="card-machine-name">{machineName}</span>
          </span>
        )}
        <span className="card-head-trail">
          {pinned && <SessionPinIndicator />}
          <SessionRowTime className="card-time" lastActivityAt={lastActivityAt} reminder={reminder} />
        </span>
      </div>
      {/* ⋯ ends line 1 on screen and follows it in focus order, before the request's buttons. */}
      <button
        type="button"
        className="icon-btn sm card-more"
        aria-label="More Actions"
        title="More Actions (Shift+F10)"
        aria-haspopup="menu"
        onClick={(event) => {
          event.stopPropagation();
          const box = event.currentTarget.getBoundingClientRect();
          openMenu({ x: box.left, y: box.bottom });
        }}
      >
        <MoreHorizontalIcon />
      </button>
      <div className="card-status">
        <SessionRowStatusBadge status={status} />
        {/* A parent shows its family chip where another card shows the strip (#2222). */}
        {threadChildren
          ? <CardFamilyChip family={threadChildren} besideKey={[status.badge?.ariaLabel ?? "", ...status.others].join("\n")} />
          : strip && <ActivityStrip activity={activity} now={activityNow} compact />}
      </div>
      {request
        ? <CardRequest session={session} request={request} runnerOnline={runnerOnline} onOpen={onOpen} />
        : <div className="card-preview">{plainTextPreview(session.preview)}</div>}
    </article>
  );
}

/**
 * A parent card's family chip (#896, #2215, #2222): one dot per child, then the rollup ("4 Children ·
 * 1 Awaiting Input"). It is an image named by the whole rollup, with the same tooltip, and its visible
 * words stay out of the accessible tree. The words show only while the whole chip fits beside the
 * badge in this card; otherwise it keeps its dots. The card measures that itself, because a Board
 * column's width says nothing about the list pane's.
 */
function CardFamilyChip({ family, besideKey }: {
  family: InboxThreadChildren;
  /** What sits beside the chip (the badge and its "+N"), so a change to it measures again. */
  besideKey: string;
}) {
  const label = inboxThreadChildrenLabel(family);
  const chipRef = useRef<HTMLSpanElement>(null);
  const [dotsOnly, setDotsOnly] = useState(false);
  useLayoutEffect(() => {
    const chip = chipRef.current;
    const line = chip?.parentElement;
    if (!chip || !line) return;
    const measure = () => {
      // The chip's natural width with its words, read synchronously with the class and the line's
      // width cap lifted (a capped chip would ellipsize its words and still "fit"), so no frame shows it.
      const wasDotsOnly = chip.classList.contains("dots-only");
      const maxWidth = chip.style.maxWidth;
      chip.classList.remove("dots-only");
      chip.style.maxWidth = "none";
      const full = chip.getBoundingClientRect().width;
      chip.style.maxWidth = maxWidth;
      if (wasDotsOnly) chip.classList.add("dots-only");
      const gap = parseFloat(line.ownerDocument.defaultView?.getComputedStyle(line).columnGap ?? "") || 0;
      let room = line.clientWidth;
      for (const sibling of line.children) {
        if (sibling !== chip) room -= sibling.getBoundingClientRect().width + gap;
      }
      setDotsOnly(full > room + 0.5);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // The line keeps its size when what sits beside the chip grows (a "+1" joining the badge), so the
    // siblings are watched too; a sibling that appears or goes changes `besideKey` and re-runs this.
    const observer = new ResizeObserver(measure);
    observer.observe(line);
    for (const sibling of line.children) if (sibling !== chip) observer.observe(sibling, { box: "border-box" });
    return () => observer.disconnect();
  }, [label, besideKey]);
  return (
    <span
      ref={chipRef}
      className={`inbox-thread-family${family.waiting > 0 ? " waiting" : ""}${dotsOnly ? " dots-only" : ""}`}
      role="img"
      aria-label={label}
      title={label}
    >
      <span className="inbox-thread-dots" aria-hidden="true">
        {family.children.map((child) => <ThreadDot key={child.id} state={child.state} title={child.title} />)}
      </span>
      <span className="inbox-thread-family-text" aria-hidden="true">{label}</span>
    </span>
  );
}

/**
 * A card's request (#2222): a warning inset notice with the request in plain words, a code line when
 * the request has one, then Approve and Deny sharing the card's width (§3.1). A question offers Answer
 * in Session; a sign-in, one Sign In menu button. Viewer refusals keep their visible reason line.
 */
function CardRequest({ session, request, runnerOnline, onOpen }: {
  session: SessionView;
  request: PendingApproval;
  runnerOnline: boolean;
  onOpen: () => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  // A person the server refuses a decision (a Viewer) sees the options disabled with the reason (#1857).
  const respondRefusal = sessionCommandRefusal(session, "respond");
  const refusalId = `card-approval-refusal-${session.id}`;
  const unavailable = busy || !runnerOnline || respondRefusal !== null;
  const decide = async (optionId: string) => {
    if (unavailable) return;
    setBusy(true);
    try {
      await api.approve(session.id, { requestId: request.requestId, optionId });
    } finally {
      setBusy(false);
    }
  };
  const optionButton = (option: PermissionOption, label: string, primary: boolean) => (
    <button
      key={option.optionId}
      type="button"
      className={`btn sm${primary ? " primary" : ""}`}
      disabled={unavailable}
      aria-describedby={respondRefusal !== null ? refusalId : undefined}
      onClick={() => void decide(option.optionId)}
    >
      {label}
    </button>
  );

  const question = request.kind === "question";
  const signIn = request.kind === "authentication";
  const decisions = question || signIn ? null : boardCardDecisions(request.options);
  const code = question ? null : boardCardRequestCode(request);
  const actions = question ? (
    // Structured questions have no inline options (options[] is empty by design): the card opens the
    // session, whose question card is interactive.
    <button type="button" className="btn sm primary" onClick={onOpen}>Answer in Session</button>
  ) : signIn ? (
    <CardSignInMenu
      items={boardCardSignInItems(request.options)}
      unavailable={unavailable}
      describedBy={respondRefusal !== null ? refusalId : undefined}
      onChoose={(optionId) => void decide(optionId)}
    />
  ) : decisions && (decisions.approve || decisions.deny) ? (
    <>
      {decisions.approve && optionButton(decisions.approve, "Approve", true)}
      {decisions.deny && optionButton(decisions.deny, "Deny", false)}
    </>
  ) : null;

  return (
    // Decisions stay on the card: a click inside, or in a menu portalled from here, never opens it.
    <div className="card-request" onClick={(e) => e.stopPropagation()}>
      <Notice tone="warning" className={`card-request-notice${decisions ? " decision-pair" : ""}`} actions={actions}>
        <p className="card-request-text">{plainTextPreview(request.title)}</p>
        {code && <code className="card-request-code">{code}</code>}
        {respondRefusal !== null && !question && (
          <p className="approval-refusal" id={refusalId}>{respondRefusal}</p>
        )}
      </Notice>
    </div>
  );
}

/** A sign-in card's one primary: Sign In, a menu of the methods with their descriptions, then the
 * danger items, Cancel Sign-In last (#2222, §9.1). */
function CardSignInMenu({ items, unavailable, describedBy, onChoose }: {
  items: readonly BoardCardSignInItem[];
  unavailable: boolean;
  describedBy?: string;
  onChoose: (optionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "card-sign-in");
  const methods = items.filter((item) => !item.danger);
  const danger = items.filter((item) => item.danger);
  const item = ({ option, label, danger: destructive }: BoardCardSignInItem) => (
    <MenuItem
      key={option.optionId}
      danger={destructive}
      description={destructive ? undefined : option.description}
      onClick={() => {
        menu.close(true);
        onChoose(option.optionId);
      }}
    >
      {label}
    </MenuItem>
  );
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="btn sm primary"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
        aria-describedby={describedBy}
        disabled={unavailable || items.length === 0}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        Sign In
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="Sign In"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
          // The card's long-press must not read a press held inside its own menu.
          onPointerDown={(event) => event.stopPropagation()}
        >
          {methods.map(item)}
          {methods.length > 0 && danger.length > 0 && <MenuSeparator />}
          {danger.map(item)}
        </MenuSurface>
      )}
    </>
  );
}

