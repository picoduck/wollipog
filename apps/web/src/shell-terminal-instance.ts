import { Terminal, type IDecoration } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { TERMINAL_SEARCH_LIMIT, type TerminalSearchResults } from "./shells-panel.js";
import { terminalSearchDecorations, terminalTheme, type ResolvedTheme } from "./theme.js";
import { TERMINAL_FONT_FAMILY, loadTerminalFont, terminalFontMetrics } from "./terminal-font.js";

/** What a host's search controls drive (#2864): Next and Previous Match, and focus on Escape. */
export interface ShellTerminalHandle {
  findNext(term: string): void;
  findPrevious(term: string): void;
  focus(): void;
}

/** What a terminal shows. A host passes the current values on every render; only changes apply. */
export interface ShellTerminalInputs {
  /** Capped raw scrollback from the store. */
  text: string;
  /** Monotonic count of chars ever received (uncapped). */
  total: number;
  /** The store's history revision. A change means the scrollback was rebuilt (a history load after
   * a reconnect), so the terminal resets and replays it rather than appending. */
  revision: number;
  /** Retention removed output before `text`: the replay starts with a faint "Older output expired." */
  historyExpired: boolean;
  /** PTY mode: capture keystrokes + report size. */
  interactive: boolean;
  /** A real PTY backs the shell, so its stream is written as is. A pipe's LF-only output is converted.
   * The registry can correct it after the terminal opens (a shell another dashboard is still opening
   * is listed as a pipe until its runner answers), and the terminal follows before it writes anything
   * more. */
  pty: boolean;
  /** Incremental bounded-history search, selected directly in xterm. */
  searchTerm: string;
  /** Resolved app palette; changes update the existing xterm without losing scrollback. */
  theme: ResolvedTheme;
  /** The colour scheme, a separate axis from light/dark: a change recolours the terminal too. */
  scheme: string;
}

/** What the attached host hears back. Only the attached host's callbacks are called. */
export interface ShellTerminalCallbacks {
  onData?(data: string): void;
  onResize?(cols: number, rows: number): void;
  /** The match count for the search term, refreshed as output arrives; null once the term is cleared. */
  onSearchResults?(results: TerminalSearchResults | null): void;
}

type SearchDecorations = NonNullable<ISearchOptions["decorations"]>;

/** The faint first line of a scrollback whose oldest output retention removed (#2865). */
const HISTORY_EXPIRED_LINE = "\u001b[2mOlder output expired.\u001b[22m\r\n";

/** CAN, then ESC c: end any escape sequence in progress, then reset the terminal fully. */
const FULL_RESET = "\u0018\u001bc";

/** A terminal's inputs before a host passes its own. */
const NO_INPUTS: ShellTerminalInputs = {
  text: "",
  total: 0,
  revision: 0,
  historyExpired: false,
  interactive: false,
  pty: false,
  searchTerm: "",
  theme: "dark",
  scheme: "",
};

const historyKeyOf =(inputs: Pick<ShellTerminalInputs, "revision" | "historyExpired">) =>
  `${inputs.revision}:${inputs.historyExpired ? "expired" : "whole"}`;

/**
 * One xterm.js terminal bound to one shell's scrollback, owned outside React so it can change hosts
 * (#2867). xterm is the ANSI parser/renderer — raw bytes go in (it handles escape sequences split
 * across chunks internally). The store keeps a capped buffer + a monotonic `total` counter; this
 * tracks how much it has consumed so each update writes only the delta (no string diffing).
 *
 * The terminal is created once and opened into its own surface element. A host attaches it: the
 * surface moves into the host's element and the terminal refits to it. Detaching takes the surface
 * out and nothing else, so attaching it elsewhere keeps the same instance, its scrollback and its
 * scroll position. Exactly one host is attached at a time: attaching to a second host detaches the
 * first, so a shell has one resize stream. A detached terminal reports nothing (no input, no size);
 * output that arrives meanwhile is written when a host attaches it again.
 *
 * PTY shells: keystrokes flow out through `onData` (batched by the host); the terminal IS the input.
 * Pipe shells: read-only — the host keeps its input row (no echo without a TTY).
 */
export class ShellTerminalInstance {
  /** What moves between hosts: xterm opens into it once. */
  readonly surface: HTMLDivElement;
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private search: SearchAddon | null = null;
  private host: HTMLElement | null = null;
  private callbacks: ShellTerminalCallbacks | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private opening = false;
  private disposed = false;
  /** The latest inputs a host passed. */
  private inputs: ShellTerminalInputs;
  /** The inputs the open terminal reflects. */
  private applied: ShellTerminalInputs | null = null;
  private consumed = 0;
  /** Which history the terminal holds: a different one is replayed, never appended. */
  private replayedHistory: string | null = null;
  private reportedSize: string | null = null;
  private decorationsCache: SearchDecorations | null = null;
  private activeWash: IDecoration[] = [];
  /** Where the scrollback was when the terminal was last detached. */
  private keptViewport: { line: number; atBottom: boolean } | null = null;

  constructor(inputs: ShellTerminalInputs = NO_INPUTS, doc: Document = document) {
    this.inputs = inputs;
    this.surface = doc.createElement("div");
    this.surface.className = "shell-term-surface";
  }

  /** The host element the terminal is attached to, if any. */
  get attachedHost(): HTMLElement | null {
    return this.host;
  }

  /** The xterm instance once opened (tests and diagnostics; hosts go through the handle). */
  get terminal(): Terminal | null {
    return this.term;
  }

  /**
   * Show the terminal in `host`. A terminal attached elsewhere moves here; the first attach opens it
   * once the terminal font has settled.
   */
  attach(host: HTMLElement, callbacks: ShellTerminalCallbacks): void {
    if (this.disposed) return;
    if (this.host && this.host !== host) this.detach(this.host);
    this.host = host;
    this.callbacks = callbacks;
    if (this.surface.parentElement !== host) host.appendChild(this.surface);
    const term = this.term;
    if (!term) {
      void this.open();
      return;
    }
    const cols = term.cols;
    this.connectHost(term);
    // Back where it was in the scrollback, unless the new host's width reflowed the lines.
    const kept = this.keptViewport;
    this.keptViewport = null;
    if (kept && term.cols === cols) {
      if (kept.atBottom) term.scrollToBottom();
      else if (term.buffer.active.viewportY !== kept.line) term.scrollToLine(kept.line);
    }
    term.refresh(0, term.rows - 1);
    // Output that arrived while no host showed it.
    this.sync(true);
  }

  /** Take the terminal out of `host`, if it is the attached one. The terminal keeps everything. */
  detach(host: HTMLElement): void {
    if (this.host !== host) return;
    const buffer = this.term?.buffer.active;
    this.keptViewport = buffer ? { line: buffer.viewportY, atBottom: buffer.viewportY >= buffer.baseY } : null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.surface.remove();
    this.host = null;
    this.callbacks = null;
    // The next host reports its own size, even an unchanged one: nothing was listening meanwhile.
    this.reportedSize = null;
  }

  /** Take the host's current inputs. Applied now when attached, otherwise when a host attaches. */
  update(next: ShellTerminalInputs): void {
    this.inputs = next;
    this.sync(false);
  }

  /**
   * Apply what changed since the terminal last caught up, in the order the terminal needs it.
   * `reattached`: catching up after time without a host, when more output than the store keeps may
   * have arrived; the retained scrollback is then replayed rather than appended after a gap.
   */
  private sync(reattached: boolean): void {
    const next = this.inputs;
    const term = this.term;
    const applied = this.applied;
    if (!term || !applied || this.disposed || !this.host) return;
    this.applied = next;
    // xterm's palette is mutable. Update it in place so an appearance change never recreates the
    // shell, drops selection, or replays scrollback. The search highlights come from the same tokens,
    // so an open search is drawn again in the new colours.
    if (next.theme !== applied.theme || next.scheme !== applied.scheme) {
      this.decorationsCache = null;
      term.options.theme = terminalTheme(next.theme);
      // The addon keeps the other matches' highlights while the term is unchanged, whatever their
      // colours, so drop them first. The selection stays, and the incremental search keeps the match.
      if (next.searchTerm) this.search?.clearDecorations();
      this.searchAgain();
    }
    // Ahead of the write below, so output and a replay that arrive with corrected metadata are parsed
    // in the right mode.
    if (next.pty !== applied.pty && term.options.convertEol !== !next.pty) term.options.convertEol = !next.pty;
    // A shell becomes interactive when it reconnects and read-only when it exits or its machine goes
    // offline. The same terminal follows, and reports its size once it can take input again, even an
    // unchanged one: a report sent while the shell was going away may never have reached it.
    if (next.interactive !== applied.interactive) {
      term.options.disableStdin = !next.interactive;
      term.options.cursorBlink = next.interactive;
      term.options.cursorInactiveStyle = next.interactive ? "outline" : "none";
      if (next.interactive) this.reportSize(term.cols, term.rows);
      else this.reportedSize = null;
    }
    if (reattached && next.total - this.consumed > next.text.length) {
      this.replay(term, true);
    } else if (next.text !== applied.text || next.total !== applied.total || historyKeyOf(next) !== historyKeyOf(applied)) {
      this.writeDelta(term);
    }
    // Typing searches incrementally from the current match. Output arriving later is the addon's to
    // re-search: running findNext on every chunk here would move the match and scroll the terminal.
    if (next.searchTerm !== applied.searchTerm) {
      const search = this.search;
      if (search) {
        if (!next.searchTerm) {
          search.clearDecorations();
          term.clearSelection();
          this.markActiveMatch();
          this.callbacks?.onSearchResults?.(null);
        } else {
          search.findNext(next.searchTerm, { incremental: true, decorations: this.decorations() });
          this.markActiveMatch();
        }
      }
    }
  }

  findNext(searchTerm: string): void {
    if (!searchTerm) return;
    this.search?.findNext(searchTerm, { decorations: this.decorations() });
    this.markActiveMatch();
  }

  findPrevious(searchTerm: string): void {
    if (!searchTerm) return;
    this.search?.findPrevious(searchTerm, { decorations: this.decorations() });
    this.markActiveMatch();
  }

  focus(): void {
    this.term?.focus();
  }

  /** End the terminal: its shell was closed, or its session left. */
  dispose(): void {
    if (this.disposed) return;
    if (this.host) this.detach(this.host);
    this.disposed = true;
    this.term?.dispose();
    this.term = null;
    this.fit = null;
    this.search = null;
    this.applied = null;
    this.activeWash = [];
  }

  private async open(): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    // xterm measures character cells while opening. Settle the locally bundled face first so a
    // later font swap cannot change wrapping, cursor placement, or the PTY's rows and columns.
    await loadTerminalFont(this.surface.ownerDocument.fonts);
    this.opening = false;
    const host = this.host;
    // Opened only into a host, so the first measurement is a real one; a later attach opens it.
    if (this.disposed || this.term || !host) return;

    const inputs = this.inputs;
    const term = new Terminal({
      // Pipe-mode output (Windows cmd) mixes CRLF with LF-only writers (git/node/python on
      // pipes) — convert LF so it doesn't staircase. PTY streams are CRLF-correct already, and a
      // PTY program can move down a line without returning, so a PTY's stream is never converted.
      convertEol: !inputs.pty,
      cursorBlink: inputs.interactive,
      // Read-only pipe pane: the input row below owns the caret; an unfocused terminal shows
      // no cursor at all with inactive style "none" (disableStdin keeps it unfocusable-in-effect).
      cursorInactiveStyle: inputs.interactive ? "outline" : "none",
      // The host's width picks the text size (a phone's is smaller); each fit reads it again.
      ...terminalFontMetrics(host.clientWidth),
      fontFamily: TERMINAL_FONT_FAMILY,
      scrollback: 5000,
      // Font loading is asynchronous; use the latest appearance in case it changed while the
      // face settled.
      theme: terminalTheme(inputs.theme),
      disableStdin: !inputs.interactive,
      // Search decorations (the only way the addon reports a match count) are proposed API.
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon({ highlightLimit: TERMINAL_SEARCH_LIMIT });
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(this.surface);
    // Handlers BEFORE the first fit — the fit resizes the terminal, and that first resize is
    // exactly the correction the runner needs (the shell was opened with placeholder dims).
    term.onData((data) => {
      if (this.inputs.interactive) this.callbacks?.onData?.(data);
    });
    term.onResize(({ cols, rows }) => this.reportSize(cols, rows));
    // The addon re-runs the search itself as output arrives (without scrolling), so the count
    // follows the stream.
    search.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (!this.inputs.searchTerm) return;
      this.markActiveMatch();
      this.callbacks?.onSearchResults?.({ index: resultIndex, count: resultCount });
    });
    // A selection the person makes over the match is theirs: the active wash goes with the match.
    term.onSelectionChange(() => this.markActiveMatch());
    this.term = term;
    this.fit = fit;
    this.search = search;
    this.applied = inputs;
    this.connectHost(term);
    // Output may have been committed while the font was loading. Consume the current snapshot once
    // now; updates take over from here. A term entered before the terminal existed searches once the
    // snapshot is parsed.
    this.replay(term);
  }

  /** Fit to the attached host, report the size, and refit whenever the host's box changes. */
  private connectHost(term: Terminal): void {
    const host = this.host;
    if (!host) return;
    this.fitToHost();
    // fit() only fires onResize when dims CHANGED — report the fitted size unconditionally, with
    // de-duplication when xterm already emitted it, so the PTY receives one settled update.
    this.reportSize(term.cols, term.rows);
    // Refit when the host's box changes (dock resize, panel drag, window resize).
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.fitToHost());
    this.resizeObserver.observe(host);
  }

  /** Fit the terminal to its host, at the text size the host's width calls for. A hidden or
   * collapsed host measures zero and keeps what it has. */
  private fitToHost(): void {
    const term = this.term;
    const host = this.host;
    if (!term || !host) return;
    const width = host.clientWidth;
    if (width === 0) return;
    const metrics = terminalFontMetrics(width);
    if (term.options.fontSize !== metrics.fontSize) term.options.fontSize = metrics.fontSize;
    if (term.options.lineHeight !== metrics.lineHeight) term.options.lineHeight = metrics.lineHeight;
    try {
      this.fit?.fit();
    } catch {
      /* zero-size during collapse — ignore */
    }
  }

  /** Report the terminal's size to an interactive shell, once per distinct size. */
  private reportSize(cols: number, rows: number): void {
    if (!this.inputs.interactive || !this.callbacks) return;
    const size = `${cols}x${rows}`;
    if (this.reportedSize === size) return;
    this.reportedSize = size;
    this.callbacks.onResize?.(cols, rows);
  }

  /** The decorations for the current tokens. Read at search time, so the first search after open
   * sees the theme the document has by then. */
  private decorations(): SearchDecorations {
    this.decorationsCache ??= terminalSearchDecorations(this.inputs.theme);
    return this.decorationsCache;
  }

  /**
   * The search addon selects the active match and draws its highlight beneath the selection, so the
   * selection's colour would cover the active wash and only the outline would set it apart. The
   * selection stays (copy, and where Next and Previous continue from); the active wash is drawn over
   * it, on the top layer, for as long as the selection is the match.
   */
  private markActiveMatch(): void {
    for (const decoration of this.activeWash) decoration.dispose();
    this.activeWash = [];
    const term = this.term;
    const pending = this.inputs.searchTerm;
    const position = term?.getSelectionPosition();
    const background = this.decorations().activeMatchBackground;
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
        this.activeWash.push(decoration);
      } else {
        marker?.dispose();
      }
    }
  }

  /** Search the term entered so far, keeping the selected match where it still matches. */
  private searchAgain(): void {
    const pending = this.inputs.searchTerm;
    if (!pending) return;
    this.search?.findNext(pending, { incremental: true, decorations: this.decorations() });
    this.markActiveMatch();
  }

  /**
   * Write the whole retained scrollback, then search it. `reset` clears what the terminal holds
   * first, as a full reset written through xterm's own input queue: `term.reset()` would run ahead of
   * writes still waiting to be parsed, which would then land on top of the replay, and would keep a
   * half-parsed escape sequence that eats the replay's first bytes. CAN ends any sequence in
   * progress and ESC c (RIS) resets the screen, the scrollback and the parser, in order.
   */
  private replay(term: Terminal, reset = false): void {
    const inputs = this.inputs;
    this.replayedHistory = historyKeyOf(inputs);
    const prefix = (reset ? FULL_RESET : "") + (inputs.historyExpired ? HISTORY_EXPIRED_LINE : "");
    if (inputs.total > 0 || prefix) {
      term.write(prefix + inputs.text, () => this.searchAgain());
    } else {
      // With no output yet this searches the empty buffer, which arms the addon to re-search as
      // output arrives.
      this.searchAgain();
    }
    this.consumed = inputs.total;
  }

  /**
   * Write the delta since the last write. `total` is monotonic and uncapped; the store text holds the
   * LAST `text.length` chars of the stream, so the unseen tail is the last (total - consumed) chars —
   * when the gap exceeds what the cap kept, replay what we have. A new history revision is a rebuilt
   * scrollback, so the terminal resets and replays it instead.
   */
  private writeDelta(term: Terminal): void {
    const { text, total } = this.inputs;
    if (this.replayedHistory !== historyKeyOf(this.inputs)) {
      this.replay(term, true);
      // History is reloaded after a reconnect, which may have restored the shell at its opening size;
      // the terminal reports its own again, as a remount used to.
      this.reportedSize = null;
      this.reportSize(term.cols, term.rows);
      return;
    }
    const unseen = total - this.consumed;
    if (unseen <= 0) return;
    term.write(unseen >= text.length ? text : text.slice(text.length - unseen));
    this.consumed = total;
  }
}
