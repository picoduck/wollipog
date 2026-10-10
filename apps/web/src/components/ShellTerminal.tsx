import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { TERMINAL_SEARCH_LIMIT, type TerminalSearchResults } from "../shells-panel.js";
import { terminalTheme, type ResolvedTheme } from "../theme.js";
import { TERMINAL_FONT_FAMILY, loadTerminalFont } from "../terminal-font.js";
import "@xterm/xterm/css/xterm.css";

/** What a host's search controls drive (#2864): Next and Previous Match, and focus on Escape. */
export interface ShellTerminalHandle {
  findNext(term: string): void;
  findPrevious(term: string): void;
  focus(): void;
}

/**
 * The search addon counts matches only while it decorates them, so every search passes decorations.
 * They carry no fill or border of their own: the selected match still shows as the terminal's
 * selection, and the overview ruler they name is not enabled.
 */
const SEARCH_DECORATIONS: NonNullable<ISearchOptions["decorations"]> = {
  matchOverviewRuler: "#808080",
  activeMatchColorOverviewRuler: "#808080",
};

/**
 * One xterm.js pane bound to one shell's scrollback. xterm is the ANSI parser/renderer — raw
 * bytes go in (it handles escape sequences split across chunks internally). The store keeps a
 * capped buffer + a monotonic `total` counter; this component tracks how much it has consumed
 * so each render writes only the delta (no string diffing).
 *
 * PTY shells: keystrokes flow out through onData (batched by the parent); the pane IS the
 * input. Pipe shells: read-only pane — the parent keeps its input row (no echo without a TTY).
 */
export function ShellTerminal({
  text,
  total,
  interactive,
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
  /** PTY mode: capture keystrokes + report size. */
  interactive: boolean;
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
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchTermRef = useRef(searchTerm);
  searchTermRef.current = searchTerm;
  const consumedRef = useRef(0);
  const textRef = useRef(text);
  textRef.current = text;
  const totalRef = useRef(total);
  totalRef.current = total;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  // Live callback refs so xterm's once-registered handlers never call a stale closure.
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onSearchResultsRef = useRef(onSearchResults);
  onSearchResultsRef.current = onSearchResults;
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;

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

      const interactiveAtMount = interactiveRef.current; // fixed per shell (a PTY never becomes a pipe)
      term = new Terminal({
        // Pipe-mode output (Windows cmd) mixes CRLF with LF-only writers (git/node/python on
        // pipes) — convert LF so it doesn't staircase. PTY streams are CRLF-correct already and
        // conversion is idempotent there, but keep it off to stay byte-faithful.
        convertEol: !interactiveAtMount,
        cursorBlink: interactiveAtMount,
        // Read-only pipe pane: the input row below owns the caret; an unfocused terminal shows
        // no cursor at all with inactive style "none" (disableStdin keeps it unfocusable-in-effect).
        cursorInactiveStyle: interactiveAtMount ? "outline" : "none",
        fontSize: 12.5,
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
      let reportedSize: string | null = null;
      const reportSize = (cols: number, rows: number) => {
        if (!interactiveRef.current) return;
        const size = `${cols}x${rows}`;
        if (reportedSize === size) return;
        reportedSize = size;
        onResizeRef.current?.(cols, rows);
      };
      // Handlers BEFORE the first fit — the fit resizes the terminal, and that first resize is
      // exactly the correction the runner needs (the shell was opened with placeholder dims).
      term.onData((d) => {
        if (interactiveRef.current) onDataRef.current?.(d);
      });
      term.onResize(({ cols, rows }) => reportSize(cols, rows));
      // The addon re-runs the search itself as output arrives (without scrolling), so the count
      // follows the stream.
      search.onDidChangeResults(({ resultIndex, resultCount }) => {
        if (searchTermRef.current) onSearchResultsRef.current?.({ index: resultIndex, count: resultCount });
      });
      fit.fit();
      // fit() only fires onResize when dims CHANGED — report the fitted size unconditionally, with
      // de-duplication when xterm already emitted it, so the PTY receives one settled update.
      reportSize(term.cols, term.rows);
      termRef.current = term;
      fitRef.current = fit;
      searchRef.current = search;

      // React may have committed output while the font was loading. Consume the current snapshot
      // once now; the ordinary delta effect takes over after the terminal reference exists. A term
      // entered before the terminal existed searches once the snapshot is parsed; with no output yet
      // it searches the empty buffer, which arms the addon to re-search as output arrives.
      const runPendingSearch = () => {
        const pendingSearch = searchTermRef.current;
        if (pendingSearch) search.findNext(pendingSearch, { incremental: true, decorations: SEARCH_DECORATIONS });
      };
      if (totalRef.current > 0) {
        term.write(textRef.current, runPendingSearch);
        consumedRef.current = totalRef.current;
      } else {
        runPendingSearch();
      }

      // Refit when the pane's box changes (dock resize, panel drag, window resize).
      ro = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* zero-size during collapse — ignore */
        }
      });
      ro.observe(host);
    })();

    return () => {
      cancelled = true;
      ro?.disconnect();
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      consumedRef.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // xterm's palette is mutable. Update the mounted instance in place so an appearance change
  // never recreates the shell, drops selection, or replays scrollback.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme(theme);
  }, [theme, scheme]);

  // Write the delta each time scrollback advances. `total` is monotonic and uncapped; the store
  // text holds the LAST `text.length` chars of the stream, so the unseen tail is the last
  // (total - consumed) chars — when the gap exceeds what the cap kept, replay what we have.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const unseen = total - consumedRef.current;
    if (unseen <= 0) return;
    term.write(unseen >= text.length ? text : text.slice(text.length - unseen));
    consumedRef.current = total;
  }, [text, total]);

  // Typing searches incrementally from the current match. Output arriving later is the addon's to
  // re-search: running findNext on every chunk here would move the match and scroll the terminal.
  useEffect(() => {
    const search = searchRef.current;
    if (!search) return;
    if (!searchTerm) {
      search.clearDecorations();
      termRef.current?.clearSelection();
      onSearchResultsRef.current?.(null);
      return;
    }
    search.findNext(searchTerm, { incremental: true, decorations: SEARCH_DECORATIONS });
  }, [searchTerm]);

  useImperativeHandle(handleRef, () => ({
    findNext: (term) => {
      if (term) searchRef.current?.findNext(term, { decorations: SEARCH_DECORATIONS });
    },
    findPrevious: (term) => {
      if (term) searchRef.current?.findPrevious(term, { decorations: SEARCH_DECORATIONS });
    },
    focus: () => termRef.current?.focus(),
  }), []);

  return <div className={`shell-term${interactive ? "" : " is-readonly"}`} ref={hostRef} />;
}
