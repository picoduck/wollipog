import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Notice } from "./Notice.js";
import { nativeTuiHasTrackedGuardrails, type ShellKind, type ShellView } from "@wollipog/protocol";
import { useStoreSelector } from "../store.js";
import { useSessionTerminals } from "../session-terminals.js";
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
  shellExitedMessage,
  shellTabView,
  supportsSessionAgentTui,
  sessionHasHookGovernance,
  terminalNoticeConditions,
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
 * The dock is a host (#2867): the tabs, the active tab, search, the pipe rows' drafts and history and
 * each shell's xterm terminal belong to the session's terminal store (`useSessionTerminals`), so
 * hiding and reopening the dock keeps all of them, scrollback and scroll position included. The dock
 * owns only its height.
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
  const tabsetId = `shell-dock-${useId().replace(/:/g, "")}`;
  const sessionTerminals = useSessionTerminals(sessionId);
  const terminals = sessionTerminals?.terminals ?? null;
  const sessions = useStoreSelector((s) => s.sessions);
  const runners = useStoreSelector((s) => s.runners);
  const shellOutput = useStoreSelector((s) => s.shellOutput);
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

  const { shells, active, input, busy, error, searchOpen, searchTerm, searchResults } = sessionTerminals?.state ?? {
    shells: null, active: null, input: "", busy: false, error: null, searchOpen: false, searchTerm: "", searchResults: null,
  };
  const terminalRef = useRef<ShellTerminalHandle | null>(null);
  const pipeInputRef = useRef<HTMLInputElement | null>(null);

  // The dock is open while mounted: the store loads or refreshes the shells, and releases on hide.
  useEffect(() => terminals?.openHost(), [terminals]);

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

  const tuiRunning = shells?.some((shell) => shell.kind === "agent_tui" && shell.status !== "exited") ?? false;

  const newShell = (kind: ShellKind = "shell") => {
    void terminals?.newShell(kind);
  };

  const closeShell = (shellId: string) => {
    if (!terminals) return;
    // A tab's Close and the exited shell's Close Tab both leave with the shell they close.
    const restoreTabFocus = document.activeElement instanceof HTMLElement
      && document.activeElement.closest(".shell-tab, .term-status") != null;
    const nextActive = terminals.closeShell(shellId);
    if (restoreTabFocus) {
      window.setTimeout(() => {
        const nextTab = nextActive ? document.getElementById(terminalTabId(tabsetId, nextActive)) : null;
        const newTabButton = document.getElementById(`${tabsetId}-new`) as HTMLButtonElement | null;
        const hideButton = document.getElementById(`${tabsetId}-hide`);
        (nextTab ?? (newTabButton && !newTabButton.disabled ? newTabButton : hideButton))?.focus();
      }, 0);
    }
  };

  /** Pipe-mode line input (Windows-native shells): a blank Enter is meaningful stdin. */
  const sendLine = () => {
    if (scrollback?.exited) return;
    void terminals?.sendLine();
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
    terminals?.closeSearch();
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
        onDismiss={condition.key === "action-failed" ? () => terminals?.dismissError() : onDismiss}
        dismissLabel={condition.key === "action-failed" ? "Dismiss Error" : "Dismiss"}
      >
        {condition.message}
      </Notice>
    ),
  }));

  if (!session || !terminals) return null;

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
          onSelect={terminals.select}
          onClose={(shellId) => void closeShell(shellId)}
        />
        <div className="shell-dock-tools">
          <TerminalSearch
            open={searchOpen}
            term={searchTerm}
            results={searchResults}
            disabled={!active}
            onOpen={terminals.openSearch}
            onTermChange={terminals.setSearchTerm}
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
                  instance={terminals.terminal(shell.shellId)}
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
                  onSearchResults={selected ? terminals.setSearchResults : undefined}
                  handleRef={selected ? terminalRef : undefined}
                  onData={(d) => terminals.sendKeys(shell.shellId, d)}
                  onResize={(cols, rows) => terminals.sendResize(shell.shellId, cols, rows)}
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
              onChange={(e) => terminals.setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendLine();
                } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                  if (terminals.stepCommandHistory(e.key === "ArrowUp" ? "previous" : "next")) e.preventDefault();
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
