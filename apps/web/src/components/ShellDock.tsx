import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Notice } from "./Notice.js";
import { isTerminal, nativeTuiHasTrackedGuardrails, type ShellKind, type ShellView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import {
  DOCK_DEFAULT_HEIGHT,
  DOCK_MIN_HEIGHT,
  clampDockHeight,
  parseStoredHeight,
  resolveDockDrag,
} from "../dock.js";
import {
  PIPE_MODE_REASON,
  READ_ONLY_SHELL_MESSAGE,
  agentTuiUnavailableReason,
  exitedShellsWithoutTabs,
  shellExitedMessage,
  shellTabView,
  shellsRemovedAfterReconnect,
  shellsVisibleAfterClose,
  splitShellInput,
  supportsSessionAgentTui,
  sessionHasHookGovernance,
  terminalNoticeConditions,
  type TerminalSearchResults,
} from "../shells-panel.js";
import { runnerDisplay } from "../runners.js";
import { ShellTerminal, type ShellTerminalHandle } from "./ShellTerminal.js";
import { TerminalNewTab, TerminalSearch, TerminalTabs, terminalTabId, type TerminalTabKind } from "./TerminalHead.js";
import { TerminalNoticeSlot } from "./TerminalNoticeSlot.js";
import type { SessionNoticeEntry } from "./SessionNoticeSlot.js";
import { State } from "./State.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChevronDownIcon, TerminalIcon } from "./Icons.js";
import { useIsCoarsePointer } from "./useIsMobile.js";
import { shortcutAriaKeys, shortcutDisplay } from "../shortcuts.js";
import type { ResolvedTheme } from "../theme.js";
import { loadBrowserStorageValue, saveBrowserStorageValue } from "../instance-storage.js";

/** Viewport-aware height ceiling: every height write (stored, drag, keyboard) goes through
 * this so the dock can never crush the transcript + composer, even after the window shrinks. */
function viewportDockMax(): number {
  return Math.floor(window.innerHeight * 0.6);
}

/**
 * Bottom shell dock (a compact terminal panel): spans the main pane under the
 * session view, drag-resizable on its top edge. Mounted ONLY while toggled on (topbar button /
 * Ctrl+` / the right panel's Terminal row) — there is no always-visible bar. Hosts the
 * session's shell tabs — each a shell running in the session's working directory (worktree or
 * repo, runner-resolved), so it still means "a shell where the agent works", including remote
 * boxes.
 *
 * POSIX/WSL shells are real PTYs (xterm pane IS the input); Windows-native shells are
 * pipe-based with a line-input row. Hide Terminal unmounts the dock and the shells keep running;
 * explicit tab close kills/forgets.
 *
 * Its one 40px head (#2864; docs/design-system.md §4.6) is the tabs, then Search Output, New Tab and
 * Hide Terminal. The tabs, search and New Tab are TerminalHead's, which any terminal host renders.
 *
 * Its body (#2865; §4.6) is the flush terminal on --terminal-bg: the terminal's one notice
 * (`TerminalNoticeSlot`), one mounted `ShellTerminal` per shell with the others hidden, then an
 * exited shell's status row or a pipe shell's command row; with no shell, an empty state.
 */
export function ShellDock({
  sessionId,
  onClose,
  theme,
  scheme,
}: {
  sessionId: string;
  onClose: () => void;
  theme: ResolvedTheme;
  /** Passed through so a mounted terminal recolours when the SCHEME changes, not only the theme. */
  scheme: string;
}) {
  const api = useApi();
  const tabsetId = `shell-dock-${useId().replace(/:/g, "")}`;
  const { reconcileShellOutputs, loadShellHistory, removeShellOutput } = useStoreActions();
  const sessions = useStoreSelector((s) => s.sessions);
  const runners = useStoreSelector((s) => s.runners);
  const shellOutput = useStoreSelector((s) => s.shellOutput);
  const conn = useStoreSelector((s) => s.conn);
  const shellRegistryRevision = useStoreSelector((s) => s.shellRegistryRevision.get(sessionId) ?? 0);
  const session = sessions.get(sessionId);
  const runner = session ? runners.get(session.runnerId) : undefined;
  const box = useStoreSelector((s) => session
    ? [...s.boxes.values()].find((candidate) => candidate.runnerId === session.runnerId)
    : undefined);
  const coarsePointer = useIsCoarsePointer();
  const runnerOnline = runner?.status === "online";
  const sessionAgent = runner?.agents.find((agent) => agent.id === session?.agentId);
  const sessionAgentContextKind = sessionAgent
    ? (sessionAgent.context?.kind ?? "native")
    : undefined;
  const tuiSupported = supportsSessionAgentTui(
    session?.driver,
    runner?.protocolVersion,
    runner?.os,
    session?.permissionMode,
    sessionAgentContextKind,
    session?.role,
  );
  const tuiGuardrailBlocked = nativeTuiHasTrackedGuardrails(session ?? {});

  // `height` is the user's PREFERENCE — only explicit gestures (drag, keyboard, double-click)
  // change it, so a temporary viewport shrink while the dock is collapsed can never clobber
  // the size the user left it at. What actually renders is `effectiveHeight` below: the
  // preference clamped to `viewportMax` state, which the window-resize listener keeps fresh
  // (state, not a render-time window read, so the ARIA range re-renders too).
  const [height, setHeight] = useState(() => {
    try {
      return parseStoredHeight(loadBrowserStorageValue("wollipog.shelldock.height"));
    } catch {
      return DOCK_DEFAULT_HEIGHT;
    }
  });
  const [viewportMax, setViewportMax] = useState(() => viewportDockMax());
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const [shells, setShells] = useState<ShellView[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<TerminalSearchResults | null>(null);
  const terminalRef = useRef<ShellTerminalHandle | null>(null);
  const pipeInputRef = useRef<HTMLInputElement | null>(null);
  const keyQueue = useRef<{ shellId: string; data: string } | null>(null);
  const keyTimer = useRef<number | null>(null);
  // Every shell's terminal stays mounted at the dock's size, so each reports its own size: one
  // pending size per shell, sent together.
  const resizeQueue = useRef(new Map<string, { cols: number; rows: number }>());
  const resizeTimer = useRef<number | null>(null);
  const shellsRef = useRef<ShellView[] | null>(null);
  shellsRef.current = shells;
  const closingShellIds = useRef(new Set<string>());
  const initialShellLoadSettled = useRef(false);
  const autoOpened = useRef(false);
  const commandHistory = useRef(new Map<string, { entries: string[]; cursor: number }>());

  // Persist prefs once values settle (not per pointermove). Visibility is persisted by the
  // app shell (which owns the mount); only the height pref lives here.
  useEffect(() => {
    if (dragging) return;
    try {
      saveBrowserStorageValue("wollipog.shelldock.height", String(height));
    } catch {
      /* best-effort */
    }
  }, [height, dragging]);

  // Track the viewport-aware ceiling as STATE: the rendered height and the separator's ARIA
  // range both re-derive from it, and the height PREFERENCE is left untouched (a shrink while
  // collapsed must not overwrite the user's restore size).
  useEffect(() => {
    const onWinResize = () => setViewportMax(viewportDockMax());
    window.addEventListener("resize", onWinResize);
    return () => window.removeEventListener("resize", onWinResize);
  }, []);

  // Pointer capture lets a drag travel over the transcript/composer — suppress text selection
  // and keep the resize cursor across the whole app through the shared drag state.
  useEffect(() => {
    document.body.classList.toggle("shell-dock-dragging", dragging);
    return () => document.body.classList.remove("shell-dock-dragging");
  }, [dragging]);

  // Monotonic load token: a list snapshot computed BEFORE a newShell() append must never land
  // after it and erase the just-opened tab. newShell bumps the token to invalidate in-flight
  // loads; each load applies only if it is still the newest.
  const loadSeq = useRef(0);
  const cancelRemovedShellWork = (removed: ReadonlySet<string>) => {
    if (keyQueue.current && removed.has(keyQueue.current.shellId)) {
      keyQueue.current = null;
      if (keyTimer.current != null) window.clearTimeout(keyTimer.current);
      keyTimer.current = null;
    }
    for (const shellId of removed) resizeQueue.current.delete(shellId);
  };

  const loadShells = async (activate?: string, reconcile = false) => {
    const seq = ++loadSeq.current;
    try {
      const { shells: registry } = await api.listShells(sessionId);
      if (loadSeq.current !== seq) return; // superseded by a newer load or a newShell()
      const list = shellsVisibleAfterClose(registry, closingShellIds.current);
      let removed = new Set<string>();
      if (reconcile) {
        removed = shellsRemovedAfterReconnect(shellsRef.current, list);
        cancelRemovedShellWork(removed);
      }
      reconcileShellOutputs(sessionId, list.map((shell) => shell.shellId));
      setShells(list);
      for (const shell of list) {
        void (async () => {
          try {
            let after = 0;
            let truncated = Boolean(shell.outputTruncated);
            const chunks = [] as import("@wollipog/protocol").ShellOutputChunk[];
            for (;;) {
              const page = await api.shellHistory(sessionId, shell.shellId, after);
              if (loadSeq.current !== seq) return;
              chunks.push(...page.chunks);
              truncated ||= page.truncatedBefore;
              if (!page.hasMore || page.nextAfter <= after) break;
              after = page.nextAfter;
            }
            if (loadSeq.current !== seq) return;
            loadShellHistory(
              sessionId,
              shell.shellId,
              chunks,
              shell.status ?? "running",
              shell.exitCode ?? null,
              truncated,
            );
          } catch (e) {
            if (loadSeq.current === seq) {
              setError(`Couldn't restore the history of ${shell.name}: ${(e as Error).message}`);
            }
          }
        })();
      }
      setActive((prev) => {
        if (reconcile && prev && removed.has(prev)) setInput("");
        return activate ?? (prev && list.some((s) => s.shellId === prev) ? prev : list[0]?.shellId ?? null);
      });
      if (!initialShellLoadSettled.current) {
        initialShellLoadSettled.current = true;
        // Auto-open is an initial-empty convenience, never a reconnect/close replacement policy.
        if (list.length > 0) autoOpened.current = true;
      }
    } catch (e) {
      if (loadSeq.current === seq) setError((e as Error).message);
    }
  };

  // Fetch on mount — the dock mounts fresh on every toggle-on, so this doubles as the
  // "reload on open" (another dashboard may have opened/closed shells since last time).
  useEffect(() => {
    void loadShells();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // Refresh durable metadata/history after a dashboard reconnect. Runner-only reconnects use the
  // shell_registry_reconciled generation below while this UI socket stays online.
  const previousConn = useRef(conn);
  useEffect(() => {
    const recovered = previousConn.current !== "online" && conn === "online";
    previousConn.current = conn;
    if (recovered) void loadShells(undefined, initialShellLoadSettled.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, conn]);

  const previousRegistryRevision = useRef(shellRegistryRevision);
  useEffect(() => {
    if (shellRegistryRevision !== previousRegistryRevision.current) {
      previousRegistryRevision.current = shellRegistryRevision;
      void loadShells(undefined, initialShellLoadSettled.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, shellRegistryRevision]);

  // Toggled on with nothing running: open a shell instead of showing an empty pane (once per
  // mount — a shell the user then closes must not resurrect itself). Terminal-state sessions
  // are excluded: their runner-side session is often gone ("unknown session"), so auto-opening
  // would greet the user with an error; the manual "+ New shell" button still lets them try.
  const sessionLive = !!session && !isTerminal(session.status);
  useEffect(() => {
    if (shells !== null && shells.length === 0 && runnerOnline && sessionLive && !busy && !autoOpened.current) {
      autoOpened.current = true;
      void newShell();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shells, runnerOnline, sessionLive]);

  // Output for an unknown live shell = another dashboard opened it — refresh the tab list.
  const unknownLiveShell =
    shells !== null &&
    [...shellOutput.entries()].some(
      ([id, s]) => s.sessionId === sessionId && !s.exited &&
        !closingShellIds.current.has(id) && !shells.some((sh) => sh.shellId === id),
    );
  useEffect(() => {
    if (unknownLiveShell) void loadShells(undefined, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unknownLiveShell]);

  // DELETE returns after sending shell_close; the runner's shell_exit echo can arrive later.
  // Keep exited scrollback only while its tab is still visible, so that ordered late echo cannot
  // recreate an invisible per-shell cache entry after explicit close.
  useEffect(() => {
    for (const shellId of exitedShellsWithoutTabs(shells, shellOutput, sessionId)) {
      removeShellOutput(shellId);
    }
  }, [shellOutput, shells, sessionId, removeShellOutput]);

  // The last tab's count is not the next one's: the next tab's terminal counts its own matches as it
  // takes the term. That happens in its effect, so the stale count goes first, in a layout effect.
  // With no tab left there is nothing to search, so search closes.
  useLayoutEffect(() => {
    setSearchResults(null);
    if (active === null) {
      setSearchOpen(false);
      setSearchTerm("");
    }
  }, [active]);

  const activeShell = shells?.find((s) => s.shellId === active) ?? null;
  const hookGovernanceActive = sessionHasHookGovernance(session?.agentCapabilities);
  const scrollback = active ? shellOutput.get(active) : undefined;
  const isPty = activeShell?.pty === true;
  /** A shell's terminal takes keystrokes: a running PTY on an online machine. */
  const shellInteractive = (shell: ShellView) =>
    shell.pty === true && shell.status === "running" && runnerOnline && !shellOutput.get(shell.shellId)?.exited;
  const interactive = activeShell !== null && shellInteractive(activeShell);
  const exited = Boolean(scrollback?.exited) || activeShell?.status === "exited";
  const pipeInput = activeShell !== null && !isPty && !exited && activeShell.status === "running";
  // A shell that is neither exited nor waiting on its machine, but takes no input here.
  const readOnly = activeShell !== null && !interactive && !pipeInput && !exited && runnerOnline &&
    activeShell.status !== "reconnecting";

  const newShell = async (kind: ShellKind = "shell") => {
    setBusy(true);
    setError(null);
    try {
      const { shell } = await api.openShell(sessionId, { cols: 120, rows: 30, kind });
      loadSeq.current++; // an in-flight list snapshot predates this shell — don't let it land
      setShells((prev) => [...(prev ?? []), shell]);
      setActive(shell.shellId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tuiRunning = shells?.some((shell) => shell.kind === "agent_tui" && shell.status !== "exited") ?? false;

  const closeShell = async (shellId: string) => {
    // Invalidate registry reads that started before this close and cancel local work immediately:
    // DELETE returns before the runner's exit echo, so waiting would leave a window for a stale
    // list response, key batch, or resize batch to resurrect/target the closing shell.
    loadSeq.current++;
    closingShellIds.current.add(shellId);
    cancelRemovedShellWork(new Set([shellId]));
    const restoreTabFocus = document.activeElement instanceof HTMLElement
      && document.activeElement.closest(".shell-tab") != null;
    const remaining = (shellsRef.current ?? []).filter((shell) => shell.shellId !== shellId);
    const nextActive = active === shellId ? remaining[0]?.shellId ?? null : active;
    setShells(remaining);
    setActive(nextActive);
    if (active === shellId) setInput("");
    if (restoreTabFocus) {
      window.setTimeout(() => {
        const nextTab = nextActive ? document.getElementById(terminalTabId(tabsetId, nextActive)) : null;
        const newTabButton = document.getElementById(`${tabsetId}-new`) as HTMLButtonElement | null;
        const hideButton = document.getElementById(`${tabsetId}-hide`);
        (nextTab ?? (newTabButton && !newTabButton.disabled ? newTabButton : hideButton))?.focus();
      }, 0);
    }
    removeShellOutput(shellId);
    try {
      await api.closeShell(sessionId, shellId);
    } catch (e) {
      closingShellIds.current.delete(shellId);
      setError((e as Error).message);
      void loadShells(undefined, true);
    }
  };

  /** Send input in order, split under the CP's 64 KiB request cap — a large paste must arrive
   * chunked, not bounce as one oversized 400 and vanish. */
  const postInput = async (shellId: string, data: string) => {
    try {
      for (const chunk of splitShellInput(data)) {
        await api.shellInput(sessionId, shellId, chunk); // sequential — order is the contract
      }
    } catch (e) {
      setError(`Some input may not have reached the shell: ${(e as Error).message}`);
    }
  };

  /** PTY keystrokes: batch a typing burst into one input POST. */
  const sendKeys = (shellId: string, data: string) => {
    const q = keyQueue.current;
    if (q && q.shellId !== shellId) {
      // Never drop a pending batch on a fast tab switch — flush it first.
      void postInput(q.shellId, q.data);
      keyQueue.current = null;
    }
    const cur = keyQueue.current;
    keyQueue.current = cur ? { shellId, data: cur.data + data } : { shellId, data };
    if (keyTimer.current == null) {
      keyTimer.current = window.setTimeout(() => {
        keyTimer.current = null;
        const batch = keyQueue.current;
        keyQueue.current = null;
        if (batch && batch.data) void postInput(batch.shellId, batch.data);
      }, 16);
    }
  };

  const sendResize = (shellId: string, cols: number, rows: number) => {
    if (resizeTimer.current != null) window.clearTimeout(resizeTimer.current);
    resizeQueue.current.set(shellId, { cols, rows });
    resizeTimer.current = window.setTimeout(() => {
      resizeTimer.current = null;
      const queued = [...resizeQueue.current];
      resizeQueue.current.clear();
      for (const [queuedShellId, size] of queued) {
        api.resizeShell(sessionId, queuedShellId, size.cols, size.rows).catch(() => {
          /* best-effort — pipe shells / old runners ignore it */
        });
      }
    }, 250);
  };

  useEffect(() => () => {
    loadSeq.current++;
    if (keyTimer.current != null) window.clearTimeout(keyTimer.current);
    if (resizeTimer.current != null) window.clearTimeout(resizeTimer.current);
    keyTimer.current = null;
    resizeTimer.current = null;
    keyQueue.current = null;
    resizeQueue.current.clear();
  }, []);

  /** Pipe-mode line input (Windows-native shells): a blank Enter is meaningful stdin. */
  const sendLine = async () => {
    if (!active || scrollback?.exited || activeShell?.status !== "running") return;
    const line = input;
    if (line.trim()) {
      const history = commandHistory.current.get(active) ?? { entries: [], cursor: 0 };
      if (history.entries.at(-1) !== line) history.entries.push(line);
      if (history.entries.length > 100) history.entries.shift();
      history.cursor = history.entries.length;
      commandHistory.current.set(active, history);
    }
    setInput("");
    try {
      // Chunk giant pasted lines too (same 64 KiB route cap as PTY input).
      for (const chunk of splitShellInput(`${line}\n`)) {
        await api.shellInput(sessionId, active, chunk);
      }
    } catch (e) {
      setError((e as Error).message);
      setInput(line);
    }
  };

  // What actually renders: the preference clamped to the live viewport ceiling. Gestures start
  // from THIS (what the user sees), and only gestures write the preference back.
  const effectiveHeight = clampDockHeight(height, viewportMax);

  const onGripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { startY: e.clientY, startHeight: effectiveHeight };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable — drag still works while over the handle */
    }
    setDragging(true);
  };
  const onGripMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (e.buttons === 0) {
      dragRef.current = null;
      setDragging(false);
      return;
    }
    setHeight(resolveDockDrag(d.startHeight, e.clientY - d.startY, viewportMax).height);
  };
  const onGripUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    setDragging(false);
    const r = resolveDockDrag(d.startHeight, e.clientY - d.startY, viewportMax);
    if (r.collapse) {
      onClose(); // snap-hide the dock; reopening restores the pre-drag size
      setHeight(d.startHeight);
    } else {
      setHeight(r.height);
    }
  };
  const onGripLostCapture = () => {
    dragRef.current = null;
    setDragging(false);
  };

  const folderPath = session?.worktreePath ??
    runner?.workspaces?.find((workspace) => workspace.id === session?.workspaceId)?.path ??
    null;
  const tabs = (shells ?? []).map((shell) => shellTabView(shell, {
    exited: Boolean(shellOutput.get(shell.shellId)?.exited),
    folderPath,
  }));
  const machineName = runnerDisplay(runner, box, session?.runnerId).name || "This machine";
  const machineOffline = `${machineName} is offline.`;
  const agentName = sessionAgent?.name || session?.agentName || "The agent";
  const newTabKinds: TerminalTabKind[] = [
    { label: "New Shell", unavailableReason: runnerOnline ? null : machineOffline, open: () => void newShell() },
    ...(tuiSupported ? [{
      label: "New Agent TUI",
      description: `${agentName}'s own terminal interface, outside Wollipog's tracking.`,
      unavailableReason: agentTuiUnavailableReason({
        machineOnline: runnerOnline,
        machineName,
        tuiOpen: tuiRunning,
        guardrailBlocked: tuiGuardrailBlocked,
      }),
      open: () => void newShell("agent_tui"),
    }] : []),
  ];

  /** Escape or Close Search: the term goes, and focus returns to what types into the shell. */
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchTerm("");
    setSearchResults(null);
    if (pipeInputRef.current) pipeInputRef.current.focus();
    else terminalRef.current?.focus();
  };

  // One notice above the terminal (§13.2): the most severe condition, the rest behind "+N More".
  const noticeEntries: SessionNoticeEntry[] = terminalNoticeConditions({
    machineOnline: runnerOnline,
    machineName,
    activeShell,
    outputIncomplete: Boolean(scrollback?.incomplete),
    agentTuiBlocked: tuiSupported && tuiGuardrailBlocked,
    hookGovernance: hookGovernanceActive,
    error,
  }).map((condition) => ({
    key: condition.key,
    severity: condition.severity,
    rank: condition.rank,
    title: condition.title,
    render: ({ trailing, onDismiss }) => (
      <Notice
        key={condition.key}
        tone={condition.severity}
        compact
        role={condition.severity === "danger" ? "alert" : "status"}
        trailing={trailing}
        onDismiss={condition.key === "action-failed" ? () => setError(null) : onDismiss}
        dismissLabel={condition.key === "action-failed" ? "Dismiss Error" : "Dismiss"}
      >
        {condition.message}
      </Notice>
    ),
  }));

  if (!session) return null;

  return (
    <div className={`shell-dock${dragging ? " is-dragging" : ""}`} role="region" aria-label="Terminal">
      <div
        className="shell-dock-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize Terminal"
        aria-valuemin={DOCK_MIN_HEIGHT}
        aria-valuemax={clampDockHeight(Number.MAX_SAFE_INTEGER, viewportMax)}
        aria-valuenow={effectiveHeight}
        title="Drag to resize. Double-click or press Home to reset."
        tabIndex={0}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onLostPointerCapture={onGripLostCapture}
        onKeyDown={(e) => {
          // Step from the VISIBLE height — stepping from a taller off-screen preference
          // would make the first ArrowUp jump instead of grow by one step.
          if (e.key === "ArrowUp") setHeight(clampDockHeight(effectiveHeight + 16, viewportMax));
          else if (e.key === "ArrowDown") setHeight(clampDockHeight(effectiveHeight - 16, viewportMax));
          else if (e.key === "Home") setHeight(clampDockHeight(DOCK_DEFAULT_HEIGHT, viewportMax));
          else return;
          e.preventDefault();
        }}
        onDoubleClick={() => setHeight(clampDockHeight(DOCK_DEFAULT_HEIGHT, viewportMax))}
      />
      <div className="shell-dock-head">
        <TerminalTabs
          tabsetId={tabsetId}
          panelId={`${tabsetId}-panel`}
          tabs={tabs}
          activeId={active}
          onSelect={setActive}
          onClose={(shellId) => void closeShell(shellId)}
        />
        <div className="shell-dock-tools">
          <TerminalSearch
            open={searchOpen}
            term={searchTerm}
            results={searchResults}
            disabled={!active}
            onOpen={() => setSearchOpen(true)}
            onTermChange={setSearchTerm}
            onNext={() => terminalRef.current?.findNext(searchTerm)}
            onPrevious={() => terminalRef.current?.findPrevious(searchTerm)}
            onClose={closeSearch}
          />
          <TerminalNewTab
            id={`${tabsetId}-new`}
            kinds={newTabKinds}
            busy={busy}
            disabledReason={runnerOnline ? null : machineOffline}
          />
          <button
            id={`${tabsetId}-hide`}
            type="button"
            className="icon-btn sm"
            onClick={onClose}
            title={`${coarsePointer ? "Hide Terminal" : `Hide Terminal (${shortcutDisplay("toggle-terminal")})`}\nShells keep running.`}
            aria-label="Hide Terminal"
            aria-keyshortcuts={shortcutAriaKeys("toggle-terminal")}
          >
            <ChevronDownIcon size={14} />
          </button>
        </div>
      </div>

      <div
        className="shell-dock-body"
        id={`${tabsetId}-panel`}
        role="tabpanel"
        aria-labelledby={active ? `${tabsetId}-tab-${encodeURIComponent(active)}` : undefined}
        style={{ height: effectiveHeight }}
      >
        <TerminalNoticeSlot sessionId={sessionId} entries={noticeEntries} onFocusLost={() => terminalRef.current?.focus()} />
        {shells !== null && shells.length > 0 && (
          // One mounted terminal per shell, the inactive ones hidden at the same size, so a tab
          // switch keeps each terminal's scroll position and no shell is resized by it.
          <div className="shell-term-stack">
            {shells.map((shell) => {
              const selected = shell.shellId === active;
              const output = shellOutput.get(shell.shellId);
              return (
                <ShellTerminal
                  key={shell.shellId}
                  hidden={!selected}
                  theme={theme}
                  scheme={scheme}
                  text={output?.text ?? ""}
                  total={output?.total ?? 0}
                  revision={output?.revision ?? 0}
                  historyExpired={Boolean(output?.truncated)}
                  pty={shell.pty === true}
                  interactive={shellInteractive(shell)}
                  searchTerm={selected && searchOpen ? searchTerm : ""}
                  onSearchResults={selected ? setSearchResults : undefined}
                  handleRef={selected ? terminalRef : undefined}
                  onData={(d) => sendKeys(shell.shellId, d)}
                  onResize={(cols, rows) => sendResize(shell.shellId, cols, rows)}
                />
              );
            })}
          </div>
        )}
        {activeShell && exited && (
          <div className="term-status">
            <span className="term-status-text" role="status">{shellExitedMessage(activeShell.kind, scrollback?.exitCode ?? activeShell.exitCode)}</span>
            <BusyButton
              className="btn sm"
              busy={busy}
              progress="Starting a new shell…"
              disabled={!runnerOnline}
              onClick={() => void newShell()}
            >
              Start New Shell
            </BusyButton>
            <button type="button" className="btn sm ghost" onClick={() => void closeShell(activeShell.shellId)}>
              Close Tab
            </button>
          </div>
        )}
        {readOnly && <div className="term-status"><span className="term-status-text">{READ_ONLY_SHELL_MESSAGE}</span></div>}
        {active && pipeInput && (
          <div className="pipe-row">
            <span className="shell-prompt" aria-hidden="true">$</span>
            <input
              ref={pipeInputRef}
              className="shell-input"
              value={input}
              aria-label="Command"
              aria-describedby={`${tabsetId}-tty`}
              placeholder="Type a command"
              disabled={!runnerOnline}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendLine();
                } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                  const history = commandHistory.current.get(active) ?? { entries: [], cursor: 0 };
                  if (history.entries.length === 0) return;
                  e.preventDefault();
                  history.cursor = e.key === "ArrowUp"
                    ? Math.max(0, history.cursor - 1)
                    : Math.min(history.entries.length, history.cursor + 1);
                  commandHistory.current.set(active, history);
                  setInput(history.cursor === history.entries.length ? "" : history.entries[history.cursor] ?? "");
                }
              }}
            />
            {/* A meta item (§11.3) with the reason as its tooltip; the field reads both as its description. */}
            <span className="pipe-row-meta" title={PIPE_MODE_REASON}>
              <span aria-hidden="true">No TTY</span>
              <span className="sr-only" id={`${tabsetId}-tty`}>{`No TTY. ${PIPE_MODE_REASON}`}</span>
            </span>
          </div>
        )}
        {shells !== null && shells.length === 0 && (
          <State
            compact
            icon={<TerminalIcon />}
            title="No Shells Open"
            actions={(
              <BusyButton
                className="btn"
                busy={busy}
                progress="Starting a new shell…"
                disabled={!runnerOnline}
                onClick={() => void newShell()}
              >
                New Shell
              </BusyButton>
            )}
          >
            {`Run commands in this session's ${session.worktreePath ? "worktree" : "folder"} on ${machineName}.`}
          </State>
        )}
      </div>
    </div>
  );
}
