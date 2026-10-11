import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import type { TerminalSearchResults } from "../shells-panel.js";
import type { ResolvedTheme } from "../theme.js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import {
  ShellTerminalInstance,
  provideXterm,
  type ShellTerminalCallbacks,
  type ShellTerminalHandle,
  type ShellTerminalInputs,
} from "../shell-terminal-instance.js";
import "@xterm/xterm/css/xterm.css";

// xterm loads with this host, in the lazy terminal views, never with the session's terminal store.
provideXterm({ Terminal, FitAddon, SearchAddon });

export type { ShellTerminalHandle } from "../shell-terminal-instance.js";

/**
 * A host for one shell's xterm terminal (`ShellTerminalInstance`). The terminal is passed in by the
 * session's terminal store (`useSessionTerminals`, #2867), which keeps it across hosts: unmounting
 * this host only detaches it, so hiding the dock or moving the terminal to another host keeps its
 * scrollback and scroll position. Without one (a standalone terminal, such as the xterm fixture) the
 * host owns a terminal for its own lifetime.
 *
 * A host keeps one mounted per shell and hides the inactive ones (#2865), so a tab switch keeps each
 * terminal's scroll position. Nothing here recreates the terminal: a new history revision replays the
 * scrollback into the same terminal, and a shell that becomes interactive or read-only updates in place.
 */
export function ShellTerminal({
  instance,
  text,
  total,
  revision = 0,
  historyExpired = false,
  interactive,
  pty = interactive,
  hidden = false,
  searchTerm,
  theme,
  scheme,
  onData,
  onResize,
  onSearchResults,
  handleRef,
}: {
  /** The session store's terminal for this shell. Omitted, the host makes its own. */
  instance?: ShellTerminalInstance;
  /** Capped raw scrollback from the store. */
  text: string;
  /** Monotonic count of chars ever received (uncapped). */
  total: number;
  /** The store's history revision. A change means the scrollback was rebuilt (a history load after
   * a reconnect), so the terminal resets and replays it rather than appending. */
  revision?: number;
  /** Retention removed output before `text`: the replay starts with a faint "Older output expired." */
  historyExpired?: boolean;
  /** PTY mode: capture keystrokes + report size. */
  interactive: boolean;
  /** A real PTY backs the shell, so its stream is written as is. A pipe's LF-only output is converted.
   * Defaults to `interactive`. */
  pty?: boolean;
  /** Kept mounted but out of sight and out of the accessibility tree, at the same size. */
  hidden?: boolean;
  /** Incremental bounded-history search, selected directly in xterm. Next and Previous go through
   * `handleRef`. */
  searchTerm: string;
  /** Resolved app palette; changes update the existing xterm without losing scrollback. */
  theme: ResolvedTheme;
  /**
   * The colour scheme, which is a SEPARATE axis from light/dark: changing scheme within one theme —
   * GitHub light to Dracula light — must recolour a mounted terminal too. It is a dependency, not a
   * value: the colours still come from the document's computed tokens.
   */
  scheme: string;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  /** The match count for `searchTerm`, refreshed as output arrives; null once the term is cleared. */
  onSearchResults?: (results: TerminalSearchResults | null) => void;
  handleRef?: Ref<ShellTerminalHandle>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<ShellTerminalInstance | null>(null);
  const inputs: ShellTerminalInputs = { text, total, revision, historyExpired, interactive, pty, searchTerm, theme, scheme };
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  // Live callback refs so the terminal's once-registered handlers never call a stale closure.
  const callbacksRef = useRef<ShellTerminalCallbacks>({ onData, onResize, onSearchResults });
  callbacksRef.current = { onData, onResize, onSearchResults };

  // Attach the terminal to this host; detach on unmount. A host's own terminal ends with it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = instance ?? new ShellTerminalInstance(inputsRef.current, host.ownerDocument);
    instanceRef.current = terminal;
    terminal.update(inputsRef.current);
    terminal.attach(host, {
      onData: (data) => callbacksRef.current.onData?.(data),
      onResize: (cols, rows) => callbacksRef.current.onResize?.(cols, rows),
      onSearchResults: (results) => callbacksRef.current.onSearchResults?.(results),
    });
    return () => {
      terminal.detach(host);
      if (!instance) terminal.dispose();
      if (instanceRef.current === terminal) instanceRef.current = null;
    };
  }, [instance]);

  useEffect(() => {
    instanceRef.current?.update(inputsRef.current);
  }, [text, total, revision, historyExpired, interactive, pty, searchTerm, theme, scheme]);

  useImperativeHandle(handleRef, () => ({
    findNext: (term) => instanceRef.current?.findNext(term),
    findPrevious: (term) => instanceRef.current?.findPrevious(term),
    focus: () => instanceRef.current?.focus(),
  }), []);

  return (
    <div
      className={["shell-term", interactive ? "" : "is-readonly", hidden ? "is-hidden" : ""].filter(Boolean).join(" ")}
      ref={hostRef}
    />
  );
}
