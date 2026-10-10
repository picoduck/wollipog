import React, { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ShellTerminal, type ShellTerminalHandle } from "../components/ShellTerminal.js";
import { TerminalSearch } from "../components/TerminalHead.js";
import type { TerminalSearchResults } from "../shells-panel.js";
import { installTerminalExitBoundary } from "../terminal-focus.js";
import { useNewSessionShortcut } from "../useNewSessionShortcut.js";
import "../styles.css";
import "./xterm-smoke.css";

interface StreamState {
  text: string;
  total: number;
  /** A history load rebuilds the scrollback under a new revision, as the store does (#2865). */
  revision?: number;
}

interface TerminalTransportSnapshot {
  input: string[];
  resizes: Array<{ cols: number; rows: number }>;
}

class InMemoryShellTransport {
  private readonly input: string[] = [];
  private readonly resizes: Array<{ cols: number; rows: number }> = [];

  receiveInput(data: string): void {
    this.input.push(data);
  }

  reportResize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  clear(): void {
    this.input.length = 0;
    this.resizes.length = 0;
  }

  snapshot(): TerminalTransportSnapshot {
    return structuredClone({ input: this.input, resizes: this.resizes });
  }
}

/** `?theme=light` starts every terminal on the light palette; dark otherwise. `setTheme` switches. */
const initialTheme = new URLSearchParams(window.location.search).get("theme") === "light" ? "light" : "dark";

/** Two shells' output for the tabbed fixture (#2865): Tab A has enough to scroll, Tab B a little. */
const TAB_A_OUTPUT = Array.from({ length: 200 }, (_, index) => `tab-a-line-${index}\r\n`).join("");
const TAB_B_OUTPUT = "tab-b-ready\r\n";

const interactiveTransport = new InMemoryShellTransport();
const readonlyTransport = new InMemoryShellTransport();
const INITIAL_INTERACTIVE_OUTPUT = "Initial terminal output\r\nGlyphs:   󰊢 │ ─ é Ж 日本語\r\n";
const INITIAL_READONLY_OUTPUT = "Read-only terminal\nGlyphs:   󰊢 │ ─ é Ж 日本語\n";
let appShortcutCount = 0;

declare global {
  interface Window {
    __WOLLIPOG_XTERM_E2E__: {
      appendInteractive(chunk: string): void;
      clearLogs(): void;
      logs(): {
        interactive: TerminalTransportSnapshot;
        readonly: TerminalTransportSnapshot;
        appShortcutCount: number;
      };
      resizeInteractive(width: number, height: number): void;
      /** A history load: the interactive terminal's scrollback becomes `text` under a new revision. */
      replaceInteractive(text: string): void;
      /** The interactive terminal's shell stops or starts taking input (a disconnect and back). */
      setInteractiveMode(on: boolean): void;
      setSearchTerm(value: string): void;
      setTheme(theme: "dark" | "light"): void;
    };
  }
}

function appendStream(setStream: React.Dispatch<React.SetStateAction<StreamState>>, chunk: string): void {
  // Keep each fake transport delivery as one distinct React commit. The production component's
  // delta effect can then prove that xterm accepts escape sequences split across separate writes.
  flushSync(() => {
    setStream((current) => ({ text: current.text + chunk, total: current.total + chunk.length }));
  });
}

function Fixture() {
  const [interactive, setInteractive] = useState<StreamState>({
    text: INITIAL_INTERACTIVE_OUTPUT,
    total: INITIAL_INTERACTIVE_OUTPUT.length,
  });
  const [readonly] = useState<StreamState>({
    text: INITIAL_READONLY_OUTPUT,
    total: INITIAL_READONLY_OUTPUT.length,
  });
  const [searchTerm, setSearchTerm] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<TerminalSearchResults | null>(null);
  const terminalRef = useRef<ShellTerminalHandle | null>(null);
  const [size, setSize] = useState({ width: 640, height: 180 });
  const [tab, setTab] = useState<"a" | "b">("a");
  const [theme, setTheme] = useState<"dark" | "light">(initialTheme);
  const [takesInput, setTakesInput] = useState(true);

  const openNewSession = useCallback(() => {
    appShortcutCount += 1;
  }, []);
  useNewSessionShortcut(true, openNewSession);

  useEffect(() => installTerminalExitBoundary(window, document), []);

  useEffect(() => {
    window.__WOLLIPOG_XTERM_E2E__ = {
      appendInteractive: (chunk) => appendStream(setInteractive, chunk),
      clearLogs() {
        interactiveTransport.clear();
        readonlyTransport.clear();
        appShortcutCount = 0;
      },
      logs: () => ({
        interactive: interactiveTransport.snapshot(),
        readonly: readonlyTransport.snapshot(),
        appShortcutCount,
      }),
      resizeInteractive: (width, height) => setSize({ width, height }),
      replaceInteractive: (text) => flushSync(() => {
        setInteractive((current) => ({ text, total: text.length, revision: (current.revision ?? 0) + 1 }));
      }),
      setInteractiveMode: (on) => flushSync(() => setTakesInput(on)),
      setSearchTerm,
      setTheme: (next) => {
        document.documentElement.dataset.theme = next;
        setTheme(next);
      },
    };
  }, []);

  return (
    <main className="main-body" style={{ display: "grid", gap: 16, padding: 20 }}>
      {/* The dock head's search controls, driving the interactive terminal as the dock does (#2864). */}
      <div className="shell-dock-head">
        <div className="shell-dock-tools">
          <TerminalSearch
            open={searchOpen}
            term={searchTerm}
            results={searchResults}
            onOpen={() => setSearchOpen(true)}
            onTermChange={setSearchTerm}
            onNext={() => terminalRef.current?.findNext(searchTerm)}
            onPrevious={() => terminalRef.current?.findPrevious(searchTerm)}
            onClose={() => {
              setSearchOpen(false);
              setSearchTerm("");
              terminalRef.current?.focus();
            }}
          />
        </div>
      </div>
      <section className="xterm-e2e-sized" aria-label="Interactive Terminal Fixture" style={size}>
        <ShellTerminal
          text={interactive.text}
          total={interactive.total}
          revision={interactive.revision}
          interactive={takesInput}
          pty
          searchTerm={searchTerm}
          onSearchResults={setSearchResults}
          handleRef={terminalRef}
          theme={theme}
          scheme="wollipog"
          onData={(data) => interactiveTransport.receiveInput(data)}
          onResize={(cols, rows) => interactiveTransport.reportResize(cols, rows)}
        />
      </section>
      <section aria-label="Read-Only Terminal Fixture" style={{ width: 420 }}>
        <ShellTerminal
          text={readonly.text}
          total={readonly.total}
          interactive={false}
          searchTerm=""
          theme={theme}
          scheme="wollipog"
          onData={(data) => readonlyTransport.receiveInput(data)}
          onResize={(cols, rows) => readonlyTransport.reportResize(cols, rows)}
        />
      </section>
      <div className="pipe-row">
        <span className="shell-prompt" aria-hidden="true">$</span>
        <input className="shell-input" aria-label="Adjacent Shell Input Fixture" readOnly />
      </div>
      {/* A terminal host's tabs (#2865): one mounted terminal per shell in one cell, the other hidden,
          as the dock keeps them, so switching away and back keeps a scrolled-up tab where it was. */}
      <section aria-label="Tabbed Terminal Fixture" style={{ width: 640 }}>
        <div role="group" aria-label="Fixture Tabs">
          <button type="button" aria-pressed={tab === "a"} onClick={() => setTab("a")}>Tab A</button>
          <button type="button" aria-pressed={tab === "b"} onClick={() => setTab("b")}>Tab B</button>
        </div>
        <div className="shell-term-stack" style={{ height: 180 }}>
          {(["a", "b"] as const).map((id) => (
            <ShellTerminal
              key={id}
              hidden={tab !== id}
              text={id === "a" ? TAB_A_OUTPUT : TAB_B_OUTPUT}
              total={(id === "a" ? TAB_A_OUTPUT : TAB_B_OUTPUT).length}
              interactive
              searchTerm=""
              theme={theme}
              scheme="wollipog"
            />
          ))}
        </div>
      </section>
      <div className="detail-scroll" tabIndex={-1}>Terminal Exit Target</div>
    </main>
  );
}

document.documentElement.dataset.theme = initialTheme;
const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<Fixture />);
