import React, { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ShellTerminal } from "../components/ShellTerminal.js";
import { installTerminalExitBoundary } from "../terminal-focus.js";
import { useNewSessionShortcut } from "../useNewSessionShortcut.js";
import "../styles.css";
import "./xterm-smoke.css";

interface StreamState {
  text: string;
  total: number;
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

const interactiveTransport = new InMemoryShellTransport();
const readonlyTransport = new InMemoryShellTransport();
const INITIAL_INTERACTIVE_OUTPUT = "Initial terminal output\r\n";
const INITIAL_READONLY_OUTPUT = "Read-only terminal\n";
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
      setSearchTerm(value: string): void;
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
  const [size, setSize] = useState({ width: 640, height: 180 });

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
      setSearchTerm,
    };
  }, []);

  return (
    <main className="main-body" style={{ display: "grid", gap: 16, padding: 20 }}>
      <section className="xterm-e2e-sized" aria-label="Interactive Terminal Fixture" style={size}>
        <ShellTerminal
          text={interactive.text}
          total={interactive.total}
          interactive
          searchTerm={searchTerm}
          theme="dark"
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
          theme="dark"
          scheme="wollipog"
          onData={(data) => readonlyTransport.receiveInput(data)}
          onResize={(cols, rows) => readonlyTransport.reportResize(cols, rows)}
        />
      </section>
      <div className="detail-scroll" tabIndex={-1}>Terminal Exit Target</div>
    </main>
  );
}

document.documentElement.dataset.theme = "dark";
const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<Fixture />);
