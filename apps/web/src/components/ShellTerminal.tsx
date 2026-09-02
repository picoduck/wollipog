import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { terminalTheme, type ResolvedTheme } from "../theme.js";
import { TERMINAL_FONT_FAMILY, loadTerminalFont } from "../terminal-font.js";
import "@xterm/xterm/css/xterm.css";

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
}: {
  /** Capped raw scrollback from the store. */
  text: string;
  /** Monotonic count of chars ever received (uncapped). */
  total: number;
  /** PTY mode: capture keystrokes + report size. */
  interactive: boolean;
  /** Incremental bounded-history search, highlighted directly in xterm. */
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
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
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
      });
      const fit = new FitAddon();
      const search = new SearchAddon();
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
      fit.fit();
      // fit() only fires onResize when dims CHANGED — report the fitted size unconditionally, with
      // de-duplication when xterm already emitted it, so the PTY receives one settled update.
      reportSize(term.cols, term.rows);
      termRef.current = term;
      fitRef.current = fit;
      searchRef.current = search;

      // React may have committed output while the font was loading. Consume the current snapshot
      // once now; the ordinary delta effect takes over after the terminal reference exists.
      if (totalRef.current > 0) {
        term.write(textRef.current);
        consumedRef.current = totalRef.current;
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

  useEffect(() => {
    const search = searchRef.current;
    if (!search) return;
    if (!searchTerm) {
      termRef.current?.clearSelection();
      return;
    }
    search.findNext(searchTerm, { incremental: true });
  }, [searchTerm, text, total]);

  return <div className={`shell-term${interactive ? "" : " is-readonly"}`} ref={hostRef} />;
}
