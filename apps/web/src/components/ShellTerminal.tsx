import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { Terminal, type IDecoration } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { TERMINAL_SEARCH_LIMIT, type TerminalSearchResults } from "../shells-panel.js";
import { terminalSearchDecorations, terminalTheme, type ResolvedTheme } from "../theme.js";
import { TERMINAL_FONT_FAMILY, loadTerminalFont, terminalFontMetrics } from "../terminal-font.js";
import "@xterm/xterm/css/xterm.css";

/** What a host's search controls drive (#2864): Next and Previous Match, and focus on Escape. */
export interface ShellTerminalHandle {
  findNext(term: string): void;
  findPrevious(term: string): void;
  focus(): void;
}

type SearchDecorations = NonNullable<ISearchOptions["decorations"]>;

/** The faint first line of a scrollback whose oldest output retention removed (#2865). */
const HISTORY_EXPIRED_LINE = "\u001b[2mOlder output expired.\u001b[22m\r\n";

/** CAN, then ESC c: end any escape sequence in progress, then reset the terminal fully. */
const FULL_RESET = "\u0018\u001bc";

/**
 * One xterm.js pane bound to one shell's scrollback. xterm is the ANSI parser/renderer — raw
 * bytes go in (it handles escape sequences split across chunks internally). The store keeps a
 * capped buffer + a monotonic `total` counter; this component tracks how much it has consumed
 * so each render writes only the delta (no string diffing).
 *
 * PTY shells: keystrokes flow out through onData (batched by the parent); the pane IS the
 * input. Pipe shells: read-only pane — the parent keeps its input row (no echo without a TTY).
 *
 * A host keeps one mounted per shell and hides the inactive ones (#2865), so a tab switch keeps each
 * terminal's scroll position. Nothing here remounts: a new history revision replays the scrollback
 * into the same terminal, and a shell that becomes interactive or read-only updates in place.
 */
export function ShellTerminal({
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
   * Fixed for the terminal's life; defaults to `interactive` at mount. */
  pty?: boolean;
  /** Kept mounted but out of sight and out of the accessibility tree, at the same size. */
  hidden?: boolean;
  /** Incremental bounded-history search, selected directly in xterm. Next and Previous go through
   * `handleRef`. */
  searchTerm: string;
  /** Resolved app palette; changes update the existing xterm without losing scrollback. */
  theme: ResolvedTheme;
  /**
   * The colour scheme, which is a SEPARATE axis from light/dark.
   *
   * The recolour effect depended on `theme` alone, so changing scheme within one theme — GitHub
   * light to Dracula light — re-rendered React and left the mounted terminal on the old palette
   * while a newly opened one read the new tokens. It is a dependency here, not a value: the colours
   * still come from the document's computed tokens.
   */
  scheme: string;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  /** The match count for `searchTerm`, refreshed as output arrives; null once the term is cleared. */
  onSearchResults?: (results: TerminalSearchResults | null) => void;
  handleRef?: Ref<ShellTerminalHandle>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchTermRef = useRef(searchTerm);
  searchTermRef.current = searchTerm;
  const consumedRef = useRef(0);
  const textRef = useRef(text);
  textRef.current = text;
  const totalRef = useRef(total);
  totalRef.current = total;
  // Which history the terminal holds: a different one is replayed, never appended.
  const historyKey = `${revision}:${historyExpired ? "expired" : "whole"}`;
  const historyKeyRef = useRef(historyKey);
  historyKeyRef.current = historyKey;
  const replayedHistoryRef = useRef<string | null>(null);
  const historyExpiredRef = useRef(historyExpired);
  historyExpiredRef.current = historyExpired;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const decorationsRef = useRef<SearchDecorations | null>(null);
  // Live callback refs so xterm's once-registered handlers never call a stale closure.
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onSearchResultsRef = useRef(onSearchResults);
  onSearchResultsRef.current = onSearchResults;
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const ptyRef = useRef(pty);
  const reportedSizeRef = useRef<string | null>(null);

  /** Report the terminal's size to an interactive shell, once per distinct size. */
  const reportSize = (cols: number, rows: number) => {
    if (!interactiveRef.current) return;
    const size = `${cols}x${rows}`;
    if (reportedSizeRef.current === size) return;
    reportedSizeRef.current = size;
    onResizeRef.current?.(cols, rows);
  };

  /** The decorations for the current tokens. Read at search time, so the first search after mount
   * sees the theme the document has by then. */
  const decorations = (): SearchDecorations => {
    decorationsRef.current ??= terminalSearchDecorations(themeRef.current);
    return decorationsRef.current;
  };

  /**
   * The search addon selects the active match and draws its highlight beneath the selection, so the
   * selection's colour would cover the active wash and only the outline would set it apart. The
   * selection stays (copy, and where Next and Previous continue from); the active wash is drawn over
   * it, on the top layer, for as long as the selection is the match.
   */
  const activeWashRef = useRef<IDecoration[]>([]);
  const markActiveMatch = () => {
    for (const decoration of activeWashRef.current) decoration.dispose();
    activeWashRef.current = [];
    const term = termRef.current;
    const pending = searchTermRef.current;
    const position = term?.getSelectionPosition();
    const background = decorations().activeMatchBackground;
    if (!term || !pending || !position || !background) return;
    // A selection the person made themselves is not the match.
    if (term.getSelection().toLowerCase() !== pending.toLowerCase()) return;
    const buffer = term.buffer.active;
    for (let row = position.start.y; row <= position.end.y; row++) {
      const from = row === position.start.y ? position.start.x : 0;
      const to = row === position.end.y ? position.end.x : term.cols;
      if (to <= from) continue;
      const marker = term.registerMarker(row - buffer.baseY - buffer.cursorY);
      const decoration = marker && term.registerDecoration({ marker, x: from, width: to - from, backgroundColor: background, layer: "top" });
      if (decoration) {
        decoration.onDispose(() => marker.dispose());
        activeWashRef.current.push(decoration);
      } else {
        marker?.dispose();
      }
    }
  };

  /** Search the term entered so far, keeping the selected match where it still matches. */
  const searchAgain = () => {
    const pending = searchTermRef.current;
    if (!pending) return;
    searchRef.current?.findNext(pending, { incremental: true, decorations: decorations() });
    markActiveMatch();
  };

  /**
   * Write the whole retained scrollback, then search it. `reset` clears what the terminal holds
   * first, as a full reset written through xterm's own input queue: `term.reset()` would run ahead of
   * writes still waiting to be parsed, which would then land on top of the replay, and would keep a
   * half-parsed escape sequence that eats the replay's first bytes. CAN ends any sequence in
   * progress and ESC c (RIS) resets the screen, the scrollback and the parser, in order.
   */
  const replay = (term: Terminal, reset = false) => {
    replayedHistoryRef.current = historyKeyRef.current;
    const prefix = (reset ? FULL_RESET : "") + (historyExpiredRef.current ? HISTORY_EXPIRED_LINE : "");
    if (totalRef.current > 0 || prefix) {
      term.write(prefix + textRef.current, searchAgain);
    } else {
      // With no output yet this searches the empty buffer, which arms the addon to re-search as
      // output arrives.
      searchAgain();
    }
    consumedRef.current = totalRef.current;
  };

  // Mount/unmount the terminal.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let term: Terminal | null = null;
    let ro: ResizeObserver | null = null;

    void (async () => {
      // xterm measures character cells while opening. Settle the locally bundled face first so a
      // later font swap cannot change wrapping, cursor placement, or the PTY's rows and columns.
      await loadTerminalFont(document.fonts);
      if (cancelled) return;

      const interactiveAtMount = interactiveRef.current;
      term = new Terminal({
        // Pipe-mode output (Windows cmd) mixes CRLF with LF-only writers (git/node/python on
        // pipes) — convert LF so it doesn't staircase. PTY streams are CRLF-correct already, and a
        // PTY program can move down a line without returning, so a PTY's stream is never converted.
        convertEol: !ptyRef.current,
        cursorBlink: interactiveAtMount,
        // Read-only pipe pane: the input row below owns the caret; an unfocused terminal shows
        // no cursor at all with inactive style "none" (disableStdin keeps it unfocusable-in-effect).
        cursorInactiveStyle: interactiveAtMount ? "outline" : "none",
        // The host's width picks the text size (a phone's is smaller); each fit reads it again.
        ...terminalFontMetrics(host.clientWidth),
        fontFamily: TERMINAL_FONT_FAMILY,
        scrollback: 5000,
        // Font loading is asynchronous; use the latest appearance in case it changed while the
        // face settled and the ordinary theme effect ran before xterm existed.
        theme: terminalTheme(themeRef.current),
        disableStdin: !interactiveAtMount,
        // Search decorations (the only way the addon reports a match count) are proposed API.
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      const search = new SearchAddon({ highlightLimit: TERMINAL_SEARCH_LIMIT });
      term.loadAddon(fit);
      term.loadAddon(search);
      term.open(host);
      const mounted = term;
      // Handlers BEFORE the first fit — the fit resizes the terminal, and that first resize is
      // exactly the correction the runner needs (the shell was opened with placeholder dims).
      term.onData((d) => {
        if (interactiveRef.current) onDataRef.current?.(d);
      });
      term.onResize(({ cols, rows }) => reportSize(cols, rows));
      // The addon re-runs the search itself as output arrives (without scrolling), so the count
      // follows the stream.
      search.onDidChangeResults(({ resultIndex, resultCount }) => {
        if (!searchTermRef.current) return;
        markActiveMatch();
        onSearchResultsRef.current?.({ index: resultIndex, count: resultCount });
      });
      // A selection the person makes over the match is theirs: the active wash goes with the match.
      term.onSelectionChange(markActiveMatch);
      /** Fit the terminal to its host, at the text size the host's width calls for. A hidden or
       * collapsed host measures zero and keeps what it has. */
      const fitToHost = () => {
        const width = host.clientWidth;
        if (width === 0) return;
        const metrics = terminalFontMetrics(width);
        if (mounted.options.fontSize !== metrics.fontSize) mounted.options.fontSize = metrics.fontSize;
        if (mounted.options.lineHeight !== metrics.lineHeight) mounted.options.lineHeight = metrics.lineHeight;
        try {
          fit.fit();
        } catch {
          /* zero-size during collapse — ignore */
        }
      };
      fitToHost();
      // fit() only fires onResize when dims CHANGED — report the fitted size unconditionally, with
      // de-duplication when xterm already emitted it, so the PTY receives one settled update.
      reportSize(term.cols, term.rows);
      termRef.current = term;
      searchRef.current = search;

      // React may have committed output while the font was loading. Consume the current snapshot
      // once now; the ordinary delta effect takes over after the terminal reference exists. A term
      // entered before the terminal existed searches once the snapshot is parsed.
      replay(term);

      // Refit when the pane's box changes (dock resize, panel drag, window resize).
      ro = new ResizeObserver(fitToHost);
      ro.observe(host);
    })();

    return () => {
      cancelled = true;
      ro?.disconnect();
      term?.dispose();
      termRef.current = null;
      searchRef.current = null;
      consumedRef.current = 0;
      replayedHistoryRef.current = null;
      activeWashRef.current = [];
      reportedSizeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // xterm's palette is mutable. Update the mounted instance in place so an appearance change
  // never recreates the shell, drops selection, or replays scrollback. The search highlights come
  // from the same tokens, so an open search is drawn again in the new colours.
  useEffect(() => {
    decorationsRef.current = null;
    const term = termRef.current;
    if (!term) return;
    term.options.theme = terminalTheme(theme);
    // The addon keeps the other matches' highlights while the term is unchanged, whatever their
    // colours, so drop them first. The selection stays, and the incremental search keeps the match.
    if (searchTermRef.current) searchRef.current?.clearDecorations();
    searchAgain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, scheme]);

  // A shell becomes interactive when it reconnects and read-only when it exits or its machine goes
  // offline. The same terminal follows, and reports its size once it can take input again, even an
  // unchanged one: a report sent while the shell was going away may never have reached it.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = !interactive;
    term.options.cursorBlink = interactive;
    term.options.cursorInactiveStyle = interactive ? "outline" : "none";
    if (interactive) reportSize(term.cols, term.rows);
    else reportedSizeRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive]);

  // Write the delta each time scrollback advances. `total` is monotonic and uncapped; the store
  // text holds the LAST `text.length` chars of the stream, so the unseen tail is the last
  // (total - consumed) chars — when the gap exceeds what the cap kept, replay what we have. A new
  // history revision is a rebuilt scrollback, so the terminal resets and replays it instead.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (replayedHistoryRef.current !== historyKey) {
      replay(term, true);
      // History is reloaded after a reconnect, which may have restored the shell at its opening size;
      // the terminal reports its own again, as a remount used to.
      reportedSizeRef.current = null;
      reportSize(term.cols, term.rows);
      return;
    }
    const unseen = total - consumedRef.current;
    if (unseen <= 0) return;
    term.write(unseen >= text.length ? text : text.slice(text.length - unseen));
    consumedRef.current = total;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, total, historyKey]);

  // Typing searches incrementally from the current match. Output arriving later is the addon's to
  // re-search: running findNext on every chunk here would move the match and scroll the terminal.
  useEffect(() => {
    const search = searchRef.current;
    if (!search) return;
    if (!searchTerm) {
      search.clearDecorations();
      termRef.current?.clearSelection();
      markActiveMatch();
      onSearchResultsRef.current?.(null);
      return;
    }
    search.findNext(searchTerm, { incremental: true, decorations: decorations() });
    markActiveMatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm]);

  useImperativeHandle(handleRef, () => ({
    findNext: (term) => {
      if (!term) return;
      searchRef.current?.findNext(term, { decorations: decorations() });
      markActiveMatch();
    },
    findPrevious: (term) => {
      if (!term) return;
      searchRef.current?.findPrevious(term, { decorations: decorations() });
      markActiveMatch();
    },
    focus: () => termRef.current?.focus(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  return (
    <div
      className={["shell-term", interactive ? "" : "is-readonly", hidden ? "is-hidden" : ""].filter(Boolean).join(" ")}
      ref={hostRef}
    />
  );
}
