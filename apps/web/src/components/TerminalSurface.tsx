import { useEffect, useRef, type RefObject } from "react";
import { Notice } from "./Notice.js";
import { nativeTuiHasTrackedGuardrails, type ShellKind, type ShellView } from "@wollipog/protocol";
import { useStoreSelector } from "../store.js";
import { useSessionTerminals, type SessionTerminals, type SessionTerminalsState } from "../session-terminals.js";
import {
  PIPE_MODE_REASON,
  READ_ONLY_SHELL_MESSAGE,
  agentTuiUnavailableReason,
  shellExitedMessage,
  shellTabView,
  supportsSessionAgentTui,
  sessionHasHookGovernance,
  terminalNoticeConditions,
  type ShellTabView,
} from "../shells-panel.js";
import { runnerDisplay } from "../runners.js";
import { ShellTerminal, type ShellTerminalHandle } from "./ShellTerminal.js";
import { terminalTabId, useSearchFocus, type TerminalTabKind } from "./TerminalHead.js";
import { TerminalNoticeSlot } from "./TerminalNoticeSlot.js";
import type { SessionNoticeEntry } from "./SessionNoticeSlot.js";
import { State } from "./State.js";
import { BusyButton } from "./ui/BusyButton.js";
import { TerminalIcon } from "./Icons.js";
import type { ResolvedTheme } from "../theme.js";
import { takeTerminalFocusRequest } from "../terminal-focus.js";
import type { TerminalPlacement } from "../terminal-placement.js";

/** Focus the first of these controls that is there and enabled. */
function focusFirst(ids: readonly string[]): void {
  ids.map((id) => document.getElementById(id))
    .find((element) => element && !(element instanceof HTMLButtonElement && element.disabled))
    ?.focus();
}

/**
 * What every terminal host shows of a session's terminals (#2868; docs/design-system.md §4.6): the
 * bottom dock and the side panel's Terminal tool each lay out their own head and frame, and render
 * the same tabs, search and terminal surface from one host model, so neither builds terminal logic of
 * its own.
 */

/** A host's view of the session's terminals: the store, its state, and what the head and body need. */
export interface TerminalHostModel extends SessionTerminalsState {
  readonly sessionId: string;
  readonly terminals: SessionTerminals;
  /** The tab ids, which the tabs, their panel and the focus after a close share. */
  readonly tabsetId: string;
  readonly tabs: readonly ShellTabView[];
  readonly newTabKinds: readonly TerminalTabKind[];
  readonly runnerOnline: boolean;
  /** Why nothing can open while the machine is offline; null while it is online. */
  readonly offlineReason: string | null;
  readonly machineName: string;
  /** Whether the session works in a worktree, for the empty state's sentence. */
  readonly worktree: boolean;
  readonly activeShell: ShellView | null;
  /** The Agent TUI is offered, and a tracked guardrail blocks it. */
  readonly agentTuiBlocked: boolean;
  readonly hookGovernance: boolean;
  readonly terminalRef: RefObject<ShellTerminalHandle | null>;
  readonly pipeInputRef: RefObject<HTMLInputElement | null>;
  /** The search controls' props, ready to spread (`TerminalSearchControls`). */
  readonly searchControls: {
    autoFocus: boolean;
    onFieldFocus: (focused: boolean) => void;
    term: string;
    results: SessionTerminalsState["searchResults"];
    onTermChange: (term: string) => void;
    onNext: () => void;
    onPrevious: () => void;
    onClose: () => void;
  };
  readonly newShell: (kind?: ShellKind) => void;
  /** Close a tab and kill its shell, keeping focus with the tabs when it was there. */
  readonly closeShell: (shellId: string) => void;
  /** Escape or Close Search: the term goes, and focus returns to what types into the shell. */
  readonly closeSearch: () => void;
}

/**
 * The host model for `sessionId`'s terminals, or null outside its `SessionTerminalsProvider` or before
 * the session loads. The host is open while this is mounted: the store loads or refreshes the shells,
 * and releases on unmount.
 *
 * `searchPlacement` is where the open search sits (`useSearchFocus`): "head" in place of Search Output,
 * or "row" on a row of its own. `fallbackFocusIds` are the controls, in order, that take focus when a
 * closed tab leaves no tab to focus: New Tab while it can open one, else the host's own. `place` is
 * where this host shows the terminal, which a move's focus request names (`requestTerminalFocus`).
 */
export function useTerminalHost(sessionId: string, tabsetId: string, {
  place,
  searchPlacement,
  fallbackFocusIds,
}: {
  place: TerminalPlacement;
  searchPlacement: "head" | "row";
  fallbackFocusIds: readonly string[];
}): TerminalHostModel | null {
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

  const state = sessionTerminals?.state ?? null;
  const terminalRef = useRef<ShellTerminalHandle | null>(null);
  const pipeInputRef = useRef<HTMLInputElement | null>(null);

  // The host is open while mounted: the store loads or refreshes the shells, and releases on hide.
  useEffect(() => terminals?.openHost(), [terminals]);

  const searchFocus = useSearchFocus(state?.searchOpen ?? false, searchPlacement);

  // The terminal moved here from its other place: focus follows it (`requestTerminalFocus`), to what
  // types into the selected shell (a pipe shell's command field, else its terminal), else to the
  // host's first control that can act. A frame later, once the shells' terminals are attached here for
  // good (an effect run again detaches and attaches them), unless the person typed or clicked since.
  const ready = Boolean(session && terminals && state);
  useEffect(() => {
    const claim = ready ? takeTerminalFocusRequest(sessionId, place) : null;
    if (!claim) return;
    window.requestAnimationFrame(() => {
      if (!claim()) return;
      if (pipeInputRef.current) pipeInputRef.current.focus();
      else if (terminalRef.current) terminalRef.current.focus();
      else focusFirst(fallbackFocusIds);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, sessionId]);

  if (!session || !terminals || !state) return null;

  const { shells, active, searchTerm } = state;
  const activeShell = shells?.find((s) => s.shellId === active) ?? null;
  const tuiRunning = shells?.some((shell) => shell.kind === "agent_tui" && shell.status !== "exited") ?? false;

  const newShell = (kind: ShellKind = "shell") => {
    void terminals.newShell(kind);
  };

  const closeShell = (shellId: string) => {
    // A tab's Close and the exited shell's Close Tab both leave with the shell they close.
    const restoreTabFocus = document.activeElement instanceof HTMLElement
      && document.activeElement.closest(".shell-tab, .term-status") != null;
    const nextActive = terminals.closeShell(shellId);
    if (restoreTabFocus) {
      window.setTimeout(() => {
        const nextTab = nextActive ? document.getElementById(terminalTabId(tabsetId, nextActive)) : null;
        if (nextTab) nextTab.focus();
        else focusFirst(fallbackFocusIds);
      }, 0);
    }
  };

  const closeSearch = () => {
    terminals.closeSearch();
    if (pipeInputRef.current) pipeInputRef.current.focus();
    else terminalRef.current?.focus();
  };

  const folderPath = session.worktreePath ??
    runner?.workspaces?.find((workspace) => workspace.id === session.workspaceId)?.path ??
    null;
  const tabs = (shells ?? []).map((shell) => shellTabView(shell, {
    exited: Boolean(shellOutput.get(shell.shellId)?.exited),
    folderPath,
  }));
  const machineName = runnerDisplay(runner, box, session.runnerId).name || "This machine";
  const offlineReason = runnerOnline ? null : `${machineName} is offline.`;
  const agentName = sessionAgent?.name || session.agentName || "The agent";
  const newTabKinds: TerminalTabKind[] = [
    { label: "New Shell", unavailableReason: offlineReason, open: () => void newShell() },
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

  return {
    ...state,
    sessionId,
    terminals,
    tabsetId,
    tabs,
    newTabKinds,
    runnerOnline,
    offlineReason,
    machineName,
    worktree: Boolean(session.worktreePath),
    activeShell,
    agentTuiBlocked: tuiSupported && tuiGuardrailBlocked,
    hookGovernance: sessionHasHookGovernance(session.agentCapabilities),
    terminalRef,
    pipeInputRef,
    searchControls: {
      autoFocus: searchFocus.autoFocus,
      onFieldFocus: searchFocus.onFieldFocus,
      term: searchTerm,
      results: state.searchResults,
      onTermChange: terminals.setSearchTerm,
      onNext: () => terminalRef.current?.findNext(searchTerm),
      onPrevious: () => terminalRef.current?.findPrevious(searchTerm),
      onClose: closeSearch,
    },
    newShell,
    closeShell,
    closeSearch,
  };
}

/**
 * The terminal's body (#2865; §4.6), whichever host shows it: the terminal's one notice
 * (`TerminalNoticeSlot`), one mounted `ShellTerminal` per shell with the others hidden, then an
 * exited shell's status row, a read-only shell's sentence or a pipe shell's command row; with no
 * shell, an empty state. The host draws the frame around it.
 */
export function TerminalSurface({ host, theme, scheme }: {
  host: TerminalHostModel;
  theme: ResolvedTheme;
  /** Passed through so a mounted terminal recolours when the SCHEME changes, not only the theme. */
  scheme: string;
}) {
  const shellOutput = useStoreSelector((s) => s.shellOutput);
  const { terminals, tabsetId, shells, active, input, busy, error, searchOpen, searchTerm, activeShell, runnerOnline } = host;

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

  /** Pipe-mode line input (Windows-native shells): a blank Enter is meaningful stdin. */
  const sendLine = () => {
    if (scrollback?.exited) return;
    void terminals.sendLine();
  };

  // One notice above the terminal (§13.2): the most severe condition, the rest behind "+N More".
  const noticeEntries: SessionNoticeEntry[] = terminalNoticeConditions({
    machineOnline: runnerOnline,
    machineName: host.machineName,
    activeShell,
    outputIncomplete: Boolean(scrollback?.incomplete),
    agentTuiBlocked: host.agentTuiBlocked,
    hookGovernance: host.hookGovernance,
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
        onDismiss={condition.key === "action-failed" ? () => terminals.dismissError() : onDismiss}
        dismissLabel={condition.key === "action-failed" ? "Dismiss Error" : "Dismiss"}
      >
        {condition.message}
      </Notice>
    ),
  }));

  return (
    <>
      <TerminalNoticeSlot sessionId={host.sessionId} entries={noticeEntries} onFocusLost={() => host.terminalRef.current?.focus()} />
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
                handleRef={selected ? host.terminalRef : undefined}
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
            onClick={() => host.newShell()}
          >
            Start New Shell
          </BusyButton>
          <button type="button" className="btn sm ghost" onClick={() => host.closeShell(activeShell.shellId)}>
            Close Tab
          </button>
        </div>
      )}
      {readOnly && <div className="term-status"><span className="term-status-text">{READ_ONLY_SHELL_MESSAGE}</span></div>}
      {active && pipeInput && (
        <div className="pipe-row">
          <span className="shell-prompt" aria-hidden="true">$</span>
          <input
            ref={host.pipeInputRef}
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
              onClick={() => host.newShell()}
            >
              New Shell
            </BusyButton>
          )}
        >
          {`Run commands in this session's ${host.worktree ? "worktree" : "folder"} on ${host.machineName}.`}
        </State>
      )}
    </>
  );
}
