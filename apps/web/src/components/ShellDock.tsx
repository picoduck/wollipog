import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { isTerminal, type ShellKind, type ShellView } from "@wollipog/protocol";
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
  exitedShellsWithoutTabs,
  shellsRemovedAfterReconnect,
  shellsVisibleAfterClose,
  splitShellInput,
  supportsAgentTui,
  sessionHasHookGovernance,
} from "../shells-panel.js";
import { ShellTerminal } from "./ShellTerminal.js";
import { handleRovingChoiceKeyDown } from "./interactions.js";
import { shortcutDisplay } from "../shortcuts.js";
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
 * pipe-based with a line-input row. Hiding detaches the dock; explicit tab close kills/forgets.
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
  const runnerOnline = runner?.status === "online";
  const tuiSupported = supportsAgentTui(session?.driver, runner?.protocolVersion, runner?.os);

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
  const [searchTerm, setSearchTerm] = useState("");
  const keyQueue = useRef<{ shellId: string; data: string } | null>(null);
  const keyTimer = useRef<number | null>(null);
  const resizeQueue = useRef<{ shellId: string; cols: number; rows: number } | null>(null);
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
    if (resizeQueue.current && removed.has(resizeQueue.current.shellId)) {
      resizeQueue.current = null;
      if (resizeTimer.current != null) window.clearTimeout(resizeTimer.current);
      resizeTimer.current = null;
    }
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
              setError(`Could not restore ${shell.name} history: ${(e as Error).message}`);
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

  const activeShell = shells?.find((s) => s.shellId === active) ?? null;
  const hookGovernanceActive = sessionHasHookGovernance(session?.agentCapabilities);
  const scrollback = active ? shellOutput.get(active) : undefined;
  const isPty = activeShell?.pty === true;
  const interactive = isPty && activeShell?.status === "running" && runnerOnline && !scrollback?.exited;

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
        const nextTab = nextActive
          ? document.getElementById(`${tabsetId}-tab-${encodeURIComponent(nextActive)}`)
          : null;
        const newShellButton = document.getElementById(`${tabsetId}-new`) as HTMLButtonElement | null;
        const dockClose = document.getElementById(`${tabsetId}-close`);
        (nextTab ?? (newShellButton && !newShellButton.disabled ? newShellButton : dockClose))?.focus();
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
      setError(`shell input failed (some of it may not have been delivered): ${(e as Error).message}`);
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
    resizeQueue.current = { shellId, cols, rows };
    resizeTimer.current = window.setTimeout(() => {
      resizeTimer.current = null;
      const queued = resizeQueue.current;
      resizeQueue.current = null;
      if (!queued) return;
      api.resizeShell(sessionId, queued.shellId, queued.cols, queued.rows).catch(() => {
        /* best-effort — pipe shells / old runners ignore it */
      });
    }, 250);
  };

  useEffect(() => () => {
    loadSeq.current++;
    if (keyTimer.current != null) window.clearTimeout(keyTimer.current);
    if (resizeTimer.current != null) window.clearTimeout(resizeTimer.current);
    keyTimer.current = null;
    resizeTimer.current = null;
    keyQueue.current = null;
    resizeQueue.current = null;
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

  if (!session) return null;

  return (
    <div className={`shell-dock${dragging ? " is-dragging" : ""}`}>
      <div
        className="shell-dock-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize Shell Panel"
        aria-valuemin={DOCK_MIN_HEIGHT}
        aria-valuemax={clampDockHeight(Number.MAX_SAFE_INTEGER, viewportMax)}
        aria-valuenow={effectiveHeight}
        title="Drag to resize · double-click to reset"
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
          else return;
          e.preventDefault();
        }}
        onDoubleClick={() => setHeight(clampDockHeight(DOCK_DEFAULT_HEIGHT, viewportMax))}
      />
      <div className="shell-dock-head">
        <span className="shell-dock-label">❯_ Shells</span>
        <div className="shell-tabs" role="tablist" aria-label="Shells" onKeyDown={(event) => handleRovingChoiceKeyDown(event, "tab")}>
          {(shells ?? []).map((s) => {
            const dead = s.status === "exited" || shellOutput.get(s.shellId)?.exited;
            return (
              <span key={s.shellId} className={`shell-tab${active === s.shellId ? " is-active" : ""}`}>
                <button
                  id={`${tabsetId}-tab-${encodeURIComponent(s.shellId)}`}
                  role="tab"
                  aria-selected={active === s.shellId}
                  aria-controls={`${tabsetId}-panel`}
                  tabIndex={active === s.shellId ? 0 : -1}
                  onClick={() => setActive(s.shellId)}
                >
                  {s.kind === "agent_tui" ? "Agent TUI" : s.name}
                  {dead ? " (Exited)" : ""}
                </button>
                <button
                  className="shell-tab-close"
                  title="Close shell"
                  aria-label={`Close Shell ${s.name}`}
                  onClick={() => void closeShell(s.shellId)}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
        <input
          className="shell-search"
          type="search"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          placeholder="Search output"
          aria-label="Search Terminal Output"
        />
        <button id={`${tabsetId}-new`} className="btn ghost sm" onClick={() => void newShell()} disabled={!runnerOnline || busy}>
          {busy ? "Opening…" : "+ New Shell"}
        </button>
        {tuiSupported && (
          <button
            id={`${tabsetId}-new-tui`}
            className="btn ghost sm"
            onClick={() => void newShell("agent_tui")}
            disabled={!runnerOnline || busy || tuiRunning}
            title="Open the provider's interactive TUI as a separate process from structured agent control"
          >
            + Agent TUI
          </button>
        )}
        <button
          id={`${tabsetId}-close`}
          type="button"
          className="icon-btn shell-dock-close"
          onClick={onClose}
          title={`Detach Terminal Panel; Shells Keep Running (${shortcutDisplay("toggle-terminal")})`}
          aria-label="Detach Terminal Panel; Shells Keep Running"
        >
          ×
        </button>
      </div>

      <div
        className="shell-dock-body"
        id={`${tabsetId}-panel`}
        role="tabpanel"
        aria-labelledby={active ? `${tabsetId}-tab-${encodeURIComponent(active)}` : undefined}
        style={{ height: effectiveHeight }}
      >
          {!runnerOnline && <div className="hint warn">Runner is offline — shells are unavailable.</div>}
          {error && <div className="composer-error">{error}</div>}
          {activeShell?.kind === "agent_tui" && (
            <div className="hint" role="status">
              {hookGovernanceActive
                ? "No structured events or approval cards. Manager policy hooks remain active."
                : "No structured events, approval cards, or manager policy interception."}
            </div>
          )}
          {active ? (
            <>
              <ShellTerminal
                key={`${active}:${scrollback?.revision ?? 0}`}
                theme={theme}
                scheme={scheme}
                text={scrollback?.text ?? ""}
                total={scrollback?.total ?? 0}
                interactive={interactive}
                searchTerm={searchTerm}
                onData={(d) => sendKeys(active, d)}
                onResize={(cols, rows) => sendResize(active, cols, rows)}
              />
              {scrollback?.incomplete && (
                <div className="hint warn" role="status">
                  Some shell output may be missing after the dashboard reconnected to recover from a slow connection.
                </div>
              )}
              {scrollback?.exited && (
                <div className="hint">
                  Shell exited{scrollback.exitCode != null ? ` (code ${scrollback.exitCode})` : ""}.
                </div>
              )}
              {scrollback?.truncated && (
                <div className="hint" role="status">Older terminal output expired from bounded history.</div>
              )}
              {activeShell?.status === "reconnecting" && (
                <div className="hint warn" role="status">Reconnecting to the retained shell...</div>
              )}
              {!isPty && !scrollback?.exited && activeShell?.status === "running" && (
                <div className="shell-input-row">
                  <span className="shell-prompt">❯</span>
                  <input
                    className="shell-input"
                    value={input}
                    placeholder="Type a command and press Enter… (pipe mode: no TTY on Windows-native sessions)"
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
                </div>
              )}
            </>
          ) : (
            <div className="hint shell-dock-empty">
              No shell open — start one to run commands in this session's working directory.
            </div>
          )}
      </div>
    </div>
  );
}
