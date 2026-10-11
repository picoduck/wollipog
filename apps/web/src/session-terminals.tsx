import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { isTerminal, type ShellKind, type ShellOutputChunk, type ShellView } from "@wollipog/protocol";
import type { ApiClient } from "./api.js";
import { useApi } from "./api-context.js";
import { useStoreActions, useStoreSelector } from "./store.js";
import {
  exitedShellsWithoutTabs,
  shellsRemovedAfterReconnect,
  shellsVisibleAfterClose,
  splitShellInput,
  type ShellScrollback,
  type TerminalSearchResults,
} from "./shells-panel.js";
import { ShellTerminalInstance } from "./shell-terminal-instance.js";

/**
 * A session's terminals, above the places that show them (#2867; docs/design-system.md §4.6).
 *
 * One store per open session owns what used to die with the dock: the shell list, the active tab,
 * the search (open, term and match count), each pipe shell's command draft and history, the batched
 * key and resize queues, and one xterm terminal per shell (`ShellTerminalInstance`). A host — the
 * bottom dock today, the side panel's Terminal tool next (#2868) — renders the head, notices and body
 * from `useSessionTerminals(sessionId)` and attaches each shell's terminal to its own element. Hiding
 * a host detaches the terminals and keeps everything else, so reopening it shows the same tab, the
 * same search and each tab's scrollback and scroll position, without fetching history again. Exactly
 * one host shows a shell's terminal at a time (attaching elsewhere moves it), so each shell has one
 * resize stream, and a terminal no host shows reports no size. Leaving the session disposes the store
 * and its terminals; the shells keep running on the machine.
 *
 * Nothing happens until a host first opens: a session whose terminal is never opened makes no shell
 * requests. Each open does what the dock's mount did: it lists the shells again (another dashboard may
 * have opened or closed some) and opens a first shell when none runs, but fetches history only for
 * shells whose history it does not hold: new to it, a load that failed or was superseded, or every
 * shell after a reconnect.
 */

export interface SessionTerminalsState {
  /** The session's shells in tab order; null until the first list arrives. */
  readonly shells: readonly ShellView[] | null;
  /** The selected tab's shell. */
  readonly active: string | null;
  /** The pipe shell's command row. */
  readonly input: string;
  /** A shell is being opened. */
  readonly busy: boolean;
  /** The last failed terminal action, shown as the terminal's notice until dismissed. */
  readonly error: string | null;
  readonly searchOpen: boolean;
  readonly searchTerm: string;
  /** The selected terminal's match count for `searchTerm`. */
  readonly searchResults: TerminalSearchResults | null;
}

export type SessionTerminalsApi = Pick<
  ApiClient,
  "listShells" | "shellHistory" | "openShell" | "closeShell" | "shellInput" | "resizeShell"
>;

/** The app store's shell-output actions: scrollback stays in the app store, keyed by shell. */
export interface SessionTerminalsOutput {
  reconcileShellOutputs(sessionId: string, shellIds: string[]): void;
  loadShellHistory(
    sessionId: string,
    shellId: string,
    chunks: ShellOutputChunk[],
    status: NonNullable<ShellView["status"]>,
    exitCode: number | null,
    truncated: boolean,
  ): void;
  removeShellOutput(shellId: string): void;
}

const INITIAL_STATE: SessionTerminalsState = {
  shells: null,
  active: null,
  input: "",
  busy: false,
  error: null,
  searchOpen: false,
  searchTerm: "",
  searchResults: null,
};

/** How long batched keystrokes and terminal sizes wait before they are sent. */
const KEY_BATCH_MS = 16;
const RESIZE_BATCH_MS = 250;

/** Pipe-shell command history kept per shell. */
const COMMAND_HISTORY_LIMIT = 100;

export class SessionTerminals {
  private state: SessionTerminalsState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly terminals = new Map<string, ShellTerminalInstance>();
  /** Hosts showing the terminal now. */
  private hosts = 0;
  private everOpened = false;
  /**
   * Shells whose current history this store has loaded (or opened itself, which needs none). Every
   * load fetches the history of the shells missing here; a mark is added only once its history has
   * landed, and a reconnect clears them all, so a failed or superseded reload is retried by the next.
   */
  private readonly historyLoaded = new Set<string>();
  // Monotonic load token: a list snapshot computed BEFORE a newShell() append must never land after it
  // and erase the just-opened tab. newShell bumps the token to invalidate in-flight loads; each load
  // applies only if it is still the newest.
  private loadSeq = 0;
  /** A load whose registry read has not answered yet. */
  private listPending = false;
  /**
   * Counts the events that can drop a shell's output from the app store: a reconnect, and a list
   * applied (it prunes the output of shells it does not hold). A shell created while one happened may
   * have lost its first output, so its history is loaded rather than assumed empty.
   */
  private outputDrops = 0;
  private readonly closingShellIds = new Set<string>();
  private initialShellLoadSettled = false;
  private autoOpened = false;
  private keyQueue: { shellId: string; data: string } | null = null;
  private keyTimer: number | null = null;
  // Every shell's terminal stays attached at its host's size, so each reports its own size: one
  // pending size per shell, sent together.
  private readonly resizeQueue = new Map<string, { cols: number; rows: number }>();
  private resizeTimer: number | null = null;
  private readonly commandHistory = new Map<string, { entries: string[]; cursor: number }>();
  private retained = 0;
  private disposeTimer: number | null = null;
  private disposed = false;

  constructor(
    readonly sessionId: string,
    private readonly api: SessionTerminalsApi,
    private readonly output: SessionTerminalsOutput,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionTerminalsState => this.state;

  /** The shell's terminal, created on first use and kept until the shell or the session goes. */
  terminal(shellId: string): ShellTerminalInstance {
    let terminal = this.terminals.get(shellId);
    if (!terminal) {
      terminal = new ShellTerminalInstance();
      // A store already left hands out an ended terminal, which no host can open.
      if (this.disposed) terminal.dispose();
      else this.terminals.set(shellId, terminal);
    }
    return terminal;
  }

  /**
   * A host opened: call on mount, and call the returned release on unmount. The first open loads the
   * shells; every open refreshes the list and offers a first shell when none runs, as the dock's
   * mount did.
   */
  openHost = (): (() => void) => {
    this.hosts += 1;
    if (this.hosts === 1) this.opened();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.hosts -= 1;
    };
  };

  /** Whether a closed shell's late output should be ignored rather than read as a new shell. */
  isClosing(shellId: string): boolean {
    return this.closingShellIds.has(shellId);
  }

  select = (shellId: string): void => this.setState({ active: shellId });

  setInput = (input: string): void => this.setState({ input });

  dismissError = (): void => this.setState({ error: null });

  openSearch = (): void => this.setState({ searchOpen: true });

  setSearchTerm = (searchTerm: string): void => this.setState({ searchTerm });

  setSearchResults = (searchResults: TerminalSearchResults | null): void => this.setState({ searchResults });

  /** Escape or Close Search: the term goes with it. The host returns focus to the shell. */
  closeSearch = (): void => this.setState({ searchOpen: false, searchTerm: "", searchResults: null });

  newShell = async (kind: ShellKind = "shell"): Promise<void> => {
    this.setState({ busy: true, error: null });
    const outputDrops = this.outputDrops;
    try {
      const { shell } = await this.api.openShell(this.sessionId, { cols: 120, rows: 30, kind });
      // An in-flight list snapshot predates this shell — don't let it land.
      const listDropped = this.supersedeLoads();
      // A new shell needs no history, unless its first output may have been dropped meanwhile.
      if (this.outputDrops === outputDrops) this.historyLoaded.add(shell.shellId);
      // The registry lists a shell before its runner answers, so a list read while this request was
      // out (the terminal reopened meanwhile) may already hold it: it keeps its tab.
      const shells = this.state.shells ?? [];
      this.setState({
        shells: shells.some((listed) => listed.shellId === shell.shellId)
          ? shells.map((listed) => listed.shellId === shell.shellId ? shell : listed)
          : [...shells, shell],
        active: shell.shellId,
      });
      // Dropping that load also dropped its registry read and any history still loading; a shown
      // terminal reads them again (a hidden one does on its next open).
      if (this.hosts > 0 && (listDropped || this.state.shells?.some((listed) => !this.historyLoaded.has(listed.shellId)))) {
        void this.loadShells({ reconcile: true });
      }
    } catch (e) {
      this.setState({ error: (e as Error).message });
    } finally {
      this.setState({ busy: false });
    }
  };

  /** Close a tab and kill its shell. Returns the tab selected next, for the host's focus. */
  closeShell = (shellId: string): string | null => {
    // Invalidate registry reads that started before this close and cancel local work immediately:
    // DELETE returns before the runner's exit echo, so waiting would leave a window for a stale
    // list response, key batch, or resize batch to resurrect/target the closing shell.
    const listDropped = this.supersedeLoads();
    this.closingShellIds.add(shellId);
    this.cancelRemovedShellWork(new Set([shellId]));
    const { active } = this.state;
    const remaining = (this.state.shells ?? []).filter((shell) => shell.shellId !== shellId);
    const nextActive = active === shellId ? remaining[0]?.shellId ?? null : active;
    this.setState({ shells: remaining, active: nextActive, ...(active === shellId ? { input: "" } : {}) });
    this.output.removeShellOutput(shellId);
    // The dropped registry read is read again, now that it leaves the closing shell out.
    if (listDropped && this.hosts > 0) void this.loadShells({ reconcile: true });
    void this.api.closeShell(this.sessionId, shellId).catch((e: unknown) => {
      this.closingShellIds.delete(shellId);
      this.setState({ error: (e as Error).message });
      void this.loadShells({ reconcile: true });
    });
    return nextActive;
  };

  /** PTY keystrokes: batch a typing burst into one input POST. */
  sendKeys = (shellId: string, data: string): void => {
    const queued = this.keyQueue;
    if (queued && queued.shellId !== shellId) {
      // Never drop a pending batch on a fast tab switch — flush it first.
      void this.postInput(queued.shellId, queued.data);
      this.keyQueue = null;
    }
    const current = this.keyQueue;
    this.keyQueue = current ? { shellId, data: current.data + data } : { shellId, data };
    if (this.keyTimer == null) {
      this.keyTimer = window.setTimeout(() => {
        this.keyTimer = null;
        const batch = this.keyQueue;
        this.keyQueue = null;
        if (batch && batch.data) void this.postInput(batch.shellId, batch.data);
      }, KEY_BATCH_MS);
    }
  };

  sendResize = (shellId: string, cols: number, rows: number): void => {
    if (this.disposed) return;
    if (this.resizeTimer != null) window.clearTimeout(this.resizeTimer);
    this.resizeQueue.set(shellId, { cols, rows });
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null;
      const queued = [...this.resizeQueue];
      this.resizeQueue.clear();
      for (const [queuedShellId, size] of queued) {
        this.api.resizeShell(this.sessionId, queuedShellId, size.cols, size.rows).catch(() => {
          /* best-effort — pipe shells / old runners ignore it */
        });
      }
    }, RESIZE_BATCH_MS);
  };

  /** Pipe-mode line input (Windows-native shells): a blank Enter is meaningful stdin. */
  sendLine = async (): Promise<void> => {
    const { active, input: line } = this.state;
    const shell = this.state.shells?.find((candidate) => candidate.shellId === active);
    if (!active || shell?.status !== "running") return;
    if (line.trim()) {
      const history = this.commandHistory.get(active) ?? { entries: [], cursor: 0 };
      if (history.entries.at(-1) !== line) history.entries.push(line);
      if (history.entries.length > COMMAND_HISTORY_LIMIT) history.entries.shift();
      history.cursor = history.entries.length;
      this.commandHistory.set(active, history);
    }
    this.setState({ input: "" });
    try {
      // Chunk giant pasted lines too (same 64 KiB route cap as PTY input).
      for (const chunk of splitShellInput(`${line}\n`)) {
        await this.api.shellInput(this.sessionId, active, chunk);
      }
    } catch (e) {
      this.setState({ error: (e as Error).message, input: line });
    }
  };

  /** ArrowUp or ArrowDown in the command row. Returns false when there is no history to walk. */
  stepCommandHistory = (direction: "previous" | "next"): boolean => {
    const { active } = this.state;
    if (!active) return false;
    const history = this.commandHistory.get(active) ?? { entries: [], cursor: 0 };
    if (history.entries.length === 0) return false;
    history.cursor = direction === "previous"
      ? Math.max(0, history.cursor - 1)
      : Math.min(history.entries.length, history.cursor + 1);
    this.commandHistory.set(active, history);
    this.setState({ input: history.cursor === history.entries.length ? "" : history.entries[history.cursor] ?? "" });
    return true;
  };

  // --- What the app store reports (SessionTerminalsDriver) ---

  /** The dashboard's connection came back: output may have been missed, so history is reloaded. */
  reconnected(): void {
    this.registryChanged();
  }

  /** The runner reconciled its shells after its own reconnect. */
  registryChanged(): void {
    if (!this.everOpened) return;
    // Every shell's history is reloaded: now if a host shows the terminal, otherwise on the next open.
    // A load still in flight read the registry before the reconnect, so it must not land and mark it.
    this.supersedeLoads();
    this.outputDrops++;
    this.historyLoaded.clear();
    if (this.hosts > 0) void this.loadShells({ reconcile: this.initialShellLoadSettled });
  }

  /** Output for a live shell with no tab: another dashboard opened it. */
  unknownShellSeen(): void {
    if (this.hosts > 0) void this.loadShells({ reconcile: true });
  }

  /**
   * Toggled on with nothing running: open a shell instead of showing an empty pane, once per open (a
   * shell the user then closes must not resurrect itself). Terminal-state sessions are excluded: their
   * runner-side session is often gone ("unknown session"), so auto-opening would greet the user with
   * an error; the manual New Shell button still lets them try. Only this open's own list counts: the
   * list kept from the last open may be empty while another dashboard has opened shells since.
   */
  offerFirstShell(runnerOnline: boolean, sessionLive: boolean): void {
    const { shells, busy } = this.state;
    if (this.hosts === 0 || !this.initialShellLoadSettled || shells === null || shells.length > 0) return;
    if (!runnerOnline || !sessionLive || busy || this.autoOpened) return;
    this.autoOpened = true;
    void this.newShell();
  }

  /**
   * DELETE returns after sending shell_close; the runner's shell_exit echo can arrive later. Keep
   * exited scrollback only while its tab is still listed, so that ordered late echo cannot recreate
   * an invisible per-shell cache entry after explicit close.
   */
  forgetExitedOutputs(shellOutput: ReadonlyMap<string, ShellScrollback>): void {
    for (const shellId of exitedShellsWithoutTabs(this.state.shells, shellOutput, this.sessionId)) {
      this.output.removeShellOutput(shellId);
    }
  }

  // --- Lifetime (SessionTerminalsProvider) ---

  retain(): void {
    this.retained += 1;
    if (this.disposeTimer != null) window.clearTimeout(this.disposeTimer);
    this.disposeTimer = null;
  }

  /** Disposes once nothing has retained the store again by the next task (StrictMode re-runs effects). */
  release(): void {
    this.retained -= 1;
    if (this.retained > 0) return;
    this.disposeTimer = window.setTimeout(() => {
      this.disposeTimer = null;
      if (this.retained <= 0) this.dispose();
    }, 0);
  }

  /** Leaving the session: in-flight work is dropped and every terminal ends. The shells keep running. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadSeq++;
    if (this.keyTimer != null) window.clearTimeout(this.keyTimer);
    if (this.resizeTimer != null) window.clearTimeout(this.resizeTimer);
    this.keyTimer = null;
    this.resizeTimer = null;
    this.keyQueue = null;
    this.resizeQueue.clear();
    for (const terminal of this.terminals.values()) terminal.dispose();
    this.terminals.clear();
  }

  private opened(): void {
    // Each open starts the first-shell offer and the failed-action notice afresh, as each mount of the
    // dock did.
    this.initialShellLoadSettled = false;
    this.autoOpened = false;
    this.setState({ error: null });
    this.everOpened = true;
    void this.loadShells({ reconcile: this.state.shells !== null });
  }

  private setState(patch: Partial<SessionTerminalsState>): void {
    if (this.disposed) return;
    const previous = this.state;
    let next: SessionTerminalsState = { ...previous, ...patch };
    if (next.active !== previous.active) {
      // The last tab's count is not the next one's: the next tab's terminal counts its own matches as
      // it takes the term. With no tab left there is nothing to search, so search closes.
      next = { ...next, searchResults: null, ...(next.active === null ? { searchOpen: false, searchTerm: "" } : {}) };
    }
    if (next.shells !== previous.shells) this.retireRemovedShells(next.shells ?? []);
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /** A shell that left the list takes its terminal, history mark and command history with it. */
  private retireRemovedShells(shells: readonly ShellView[]): void {
    const listed = new Set(shells.map((shell) => shell.shellId));
    for (const [shellId, terminal] of this.terminals) {
      if (listed.has(shellId)) continue;
      terminal.dispose();
      this.terminals.delete(shellId);
    }
    for (const shellId of this.historyLoaded) if (!listed.has(shellId)) this.historyLoaded.delete(shellId);
    for (const shellId of this.commandHistory.keys()) if (!listed.has(shellId)) this.commandHistory.delete(shellId);
  }

  private cancelRemovedShellWork(removed: ReadonlySet<string>): void {
    if (this.keyQueue && removed.has(this.keyQueue.shellId)) {
      this.keyQueue = null;
      if (this.keyTimer != null) window.clearTimeout(this.keyTimer);
      this.keyTimer = null;
    }
    for (const shellId of removed) this.resizeQueue.delete(shellId);
  }

  /**
   * List the shells, then load the history of each shell whose history has not landed since it was
   * listed or since the last reconnect. `reconcile` drops work queued for shells that are gone.
   */
  private async loadShells({ reconcile }: { reconcile: boolean }): Promise<void> {
    const seq = ++this.loadSeq;
    this.listPending = true;
    try {
      const { shells: registry } = await this.api.listShells(this.sessionId);
      if (this.loadSeq !== seq) return; // superseded by a newer load or a newShell()
      this.listPending = false;
      const list = shellsVisibleAfterClose(registry, this.closingShellIds);
      let removed = new Set<string>();
      if (reconcile) {
        removed = shellsRemovedAfterReconnect(this.state.shells, list);
        this.cancelRemovedShellWork(removed);
      }
      this.outputDrops++;
      this.output.reconcileShellOutputs(this.sessionId, list.map((shell) => shell.shellId));
      const previous = this.state.active;
      this.setState({
        shells: list,
        active: previous && list.some((shell) => shell.shellId === previous) ? previous : list[0]?.shellId ?? null,
        ...(reconcile && previous && removed.has(previous) ? { input: "" } : {}),
      });
      for (const shell of list) {
        if (this.historyLoaded.has(shell.shellId)) continue;
        void this.loadHistory(shell, seq);
      }
      if (!this.initialShellLoadSettled) {
        this.initialShellLoadSettled = true;
        // Auto-open is an initial-empty convenience, never a reconnect/close replacement policy.
        if (list.length > 0) this.autoOpened = true;
      }
    } catch (e) {
      if (this.loadSeq !== seq) return;
      this.listPending = false;
      this.setState({ error: (e as Error).message });
    }
  }

  /**
   * Stop every load in flight from landing (its registry read or history predates what the caller just
   * did). Returns whether a registry read was among them, which the caller then reads again.
   */
  private supersedeLoads(): boolean {
    const listDropped = this.listPending;
    this.loadSeq++;
    this.listPending = false;
    return listDropped;
  }

  private async loadHistory(shell: ShellView, seq: number): Promise<void> {
    try {
      let after = 0;
      let truncated = Boolean(shell.outputTruncated);
      const chunks: ShellOutputChunk[] = [];
      for (;;) {
        const page = await this.api.shellHistory(this.sessionId, shell.shellId, after);
        if (this.loadSeq !== seq) return;
        chunks.push(...page.chunks);
        truncated ||= page.truncatedBefore;
        if (!page.hasMore || page.nextAfter <= after) break;
        after = page.nextAfter;
      }
      if (this.loadSeq !== seq) return;
      this.historyLoaded.add(shell.shellId);
      this.output.loadShellHistory(
        this.sessionId,
        shell.shellId,
        chunks,
        shell.status ?? "running",
        shell.exitCode ?? null,
        truncated,
      );
    } catch (e) {
      if (this.loadSeq === seq) this.setState({ error: `Couldn't restore the history of ${shell.name}: ${(e as Error).message}` });
    }
  }

  /** Send input in order, split under the CP's 64 KiB request cap — a large paste must arrive
   * chunked, not bounce as one oversized 400 and vanish. */
  private async postInput(shellId: string, data: string): Promise<void> {
    try {
      for (const chunk of splitShellInput(data)) {
        await this.api.shellInput(this.sessionId, shellId, chunk); // sequential — order is the contract
      }
    } catch (e) {
      this.setState({ error: `Some input may not have reached the shell: ${(e as Error).message}` });
    }
  }
}

const SessionTerminalsContext = createContext<SessionTerminals | null>(null);

/**
 * Provides the open session's terminals to every host below it. Mounted above the app's main area
 * with the routed session (null elsewhere, or when the session's machine has no shells); a different
 * session gets a new store, and the previous one is disposed.
 */
export function SessionTerminalsProvider({ sessionId, children }: { sessionId: string | null; children: ReactNode }) {
  const api = useApi();
  const { reconcileShellOutputs, loadShellHistory, removeShellOutput } = useStoreActions();
  const terminals = useMemo(
    () => sessionId === null
      ? null
      : new SessionTerminals(sessionId, api, { reconcileShellOutputs, loadShellHistory, removeShellOutput }),
    [sessionId, api, reconcileShellOutputs, loadShellHistory, removeShellOutput],
  );
  useEffect(() => {
    if (!terminals) return;
    terminals.retain();
    return () => terminals.release();
  }, [terminals]);
  return (
    <SessionTerminalsContext.Provider value={terminals}>
      {terminals && <SessionTerminalsDriver terminals={terminals} />}
      {children}
    </SessionTerminalsContext.Provider>
  );
}

/** Feeds the app store's connection, shell registry and shell output into the session's terminals. */
function SessionTerminalsDriver({ terminals }: { terminals: SessionTerminals }) {
  const { sessionId } = terminals;
  const conn = useStoreSelector((s) => s.conn);
  const shellRegistryRevision = useStoreSelector((s) => s.shellRegistryRevision.get(sessionId) ?? 0);
  const shellOutput = useStoreSelector((s) => s.shellOutput);
  const session = useStoreSelector((s) => s.sessions.get(sessionId));
  const runnerOnline = useStoreSelector((s) => session ? s.runners.get(session.runnerId)?.status === "online" : false);
  const sessionLive = !!session && !isTerminal(session.status);
  const { shells, busy } = useSyncExternalStore(terminals.subscribe, terminals.getSnapshot);

  // Refresh durable metadata/history after a dashboard reconnect. Runner-only reconnects use the
  // shell_registry_reconciled generation below while this UI socket stays online.
  const previousConn = useRef(conn);
  useEffect(() => {
    const recovered = previousConn.current !== "online" && conn === "online";
    previousConn.current = conn;
    if (recovered) terminals.reconnected();
  }, [terminals, conn]);

  const previousRegistryRevision = useRef(shellRegistryRevision);
  useEffect(() => {
    if (shellRegistryRevision === previousRegistryRevision.current) return;
    previousRegistryRevision.current = shellRegistryRevision;
    terminals.registryChanged();
  }, [terminals, shellRegistryRevision]);

  // `busy` too: a shell still being opened from the last open holds the offer until it settles.
  useEffect(() => {
    terminals.offerFirstShell(runnerOnline, sessionLive);
  }, [terminals, shells, busy, runnerOnline, sessionLive]);

  // Output for an unknown live shell = another dashboard opened it — refresh the tab list.
  const unknownLiveShell = shells !== null && [...shellOutput.entries()].some(([shellId, scrollback]) =>
    scrollback.sessionId === sessionId && !scrollback.exited &&
    !terminals.isClosing(shellId) && !shells.some((shell) => shell.shellId === shellId));
  useEffect(() => {
    if (unknownLiveShell) terminals.unknownShellSeen();
  }, [terminals, unknownLiveShell]);

  useEffect(() => {
    terminals.forgetExitedOutputs(shellOutput);
  }, [terminals, shellOutput, shells]);

  return null;
}

/**
 * The session's terminal store and its current state, for a host showing that session's terminal.
 * Null outside a `SessionTerminalsProvider` for this session.
 */
export function useSessionTerminals(sessionId: string): { terminals: SessionTerminals; state: SessionTerminalsState } | null {
  const provided = useContext(SessionTerminalsContext);
  const terminals = provided?.sessionId === sessionId ? provided : null;
  const state = useSyncExternalStore(terminals?.subscribe ?? subscribeToNothing, terminals?.getSnapshot ?? noState);
  return terminals && state ? { terminals, state } : null;
}

const subscribeToNothing = () => () => {};
const noState = () => null;
