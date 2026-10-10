import { fireDomEvent } from "./components/test-dom-events.js";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, afterEach, before, beforeEach, test } from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { FitAddon as FitAddonType } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import {
  PROTOCOL_VERSION,
  type ControlPlaneToUi,
  type RunnerView,
  type SessionView,
  type ShellView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "./api.js";
import { ApiProvider } from "./api-context.js";
import { StoreProvider } from "./store.js";
import type { ViewNavigation } from "./navigation.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "./ui-transport.js";
import { installDomTestCleanup } from "./dom-test-cleanup.js";
import { assertNoDomNode, assertSameDomNode } from "./dom-test-assertions.js";
import type { ShellTerminalInstance } from "./shell-terminal-instance.js";

// The terminal is loaded as the bundler loads it: xterm and its addons from their ES module builds
// (Node's `main` is a bundle it cannot read named exports from), and xterm's stylesheet, which only
// the bundler handles, as an empty module. Everything that reaches xterm is imported after this hook.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (!specifier.startsWith("@xterm/")) return resolved;
    return { ...resolved, url: resolved.url.replace(/\/lib\/([\w-]+)\.js$/, "/lib/$1.mjs"), format: "module" };
  },
  load(url, context, nextLoad) {
    return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context);
  },
});
const { FitAddon } = await import("@xterm/addon-fit");
const { SessionTerminals, SessionTerminalsProvider, useSessionTerminals } = await import("./session-terminals.js");
const { ShellDock } = await import("./components/ShellDock.js");
const { ShellTerminal } = await import("./components/ShellTerminal.js");
type SessionTerminals = import("./session-terminals.js").SessionTerminals;

/**
 * The session's terminals live above the hosts that show them (#2867): hiding and reopening the dock
 * keeps the tab, the search and each terminal, and a terminal moved between hosts is the same xterm,
 * refitted, with one host and one resize stream at a time.
 */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installDomTestCleanup(domWindow);

/**
 * happy-dom does no layout, so every ResizeObserver here is one the test fires by hand, and a host's
 * size is the one the test gives it.
 */
class TestResizeObserver {
  static readonly live = new Set<TestResizeObserver>();
  readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.live.add(this);
  }
  observe(target: Element): void { this.targets.add(target); }
  unobserve(target: Element): void { this.targets.delete(target); }
  disconnect(): void {
    this.targets.clear();
    TestResizeObserver.live.delete(this);
  }
  static observing(target: Element): TestResizeObserver[] {
    return [...TestResizeObserver.live].filter((observer) => observer.targets.has(target));
  }
  static resize(target: Element): void {
    for (const observer of TestResizeObserver.observing(target)) {
      observer.callback([], observer as unknown as ResizeObserver);
    }
  }
}

const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  localStorage: domWindow.localStorage,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver,
  ResizeObserver: TestResizeObserver,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(
  Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]),
);

/** Each place's size in cells, by the class of the element holding the host: what FitAddon would measure. */
const placeSizes = new Map<string, { cols: number; rows: number }>();
const originalProposeDimensions = FitAddon.prototype.proposeDimensions;
const clientWidth = Object.getOwnPropertyDescriptor(domWindow.HTMLElement.prototype, "clientWidth");

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  // A host with no width keeps its terminal's size (a collapsed host), so every host here has one.
  Object.defineProperty(domWindow.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
  FitAddon.prototype.proposeDimensions = function proposeDimensions(this: FitAddonType) {
    const surface = (this as unknown as { _terminal?: Terminal })._terminal?.element?.parentElement;
    const host = surface?.parentElement;
    return placeSizes.get(host?.parentElement?.className ?? "");
  };
});

after(() => {
  FitAddon.prototype.proposeDimensions = originalProposeDimensions;
  if (clientWidth) Object.defineProperty(domWindow.HTMLElement.prototype, "clientWidth", clientWidth);
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

/** Lets list, history and font loads, terminal writes and batched sends land. */
async function settle(ms = 0): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await settle(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

// DOM nodes are compared with the dom-test-assertions helpers and terminals with `assert.ok(a === b)`:
// a failing `assert.equal` would inspect both object graphs, which exhausts memory under happy-dom.

/** Every line the terminal holds, scrollback included. */
function bufferText(term: Terminal): string[] {
  const buffer = term.buffer.active;
  return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? "");
}

/**
 * Scroll back through the scrollback. xterm 6 scrolls through its viewport by the measured cell
 * height, which happy-dom has none of, so this moves the buffer's own scroll position, as the
 * viewport does once it has scrolled.
 */
function scrollBack(term: Terminal, lines: number): void {
  (term as unknown as { _core: { _bufferService: { scrollLines(amount: number): void } } })._core._bufferService.scrollLines(-lines);
}

/** Counts `dispose` calls on a terminal without changing what dispose does. */
function countDisposals(term: Terminal): { count: number } {
  const calls = { count: 0 };
  const dispose = term.dispose.bind(term);
  term.dispose = () => {
    calls.count += 1;
    dispose();
  };
  return calls;
}

// --- The dock over a mocked shell API ---

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "build-box",
  displayName: "Build Box",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{
    id: "claude", name: "Claude Code", command: "claude", args: [], env: {},
    driver: "claude-code", context: { kind: "native" }, available: true,
  }],
  workspaces: [{ id: "workspace-1", name: "Acme Storefront", path: "/home/dev/acme-storefront" }],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: PROTOCOL_VERSION,
};

const session: SessionView = {
  id: "terminals-session", runnerId: runner.runnerId, workspaceId: "workspace-1", workspaceName: "Acme Storefront",
  projectId: null, agentId: "claude", agentName: "Claude Code", title: "Fix the Checkout Total", status: "idle",
  column: "review", runId: null, useWorktree: true, worktreePath: "/home/dev/worktrees/acme-storefront",
  archived: false, createdAt: 1, updatedAt: 1, lastEventAt: 1, messageCount: 1, eventEpoch: 0,
  preview: null, pendingApproval: null, driver: "claude-code", model: null,
  effort: null, permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
};

const shell = (index: number): ShellView => ({
  shellId: `shell-${index}`, sessionId: session.id, name: `Shell ${index}`, createdAt: index, pty: true,
  kind: "shell", status: "running", outputStartSeq: 0, outputEndSeq: 1, outputTruncated: false,
});

const OUTPUT: Record<string, string> = {
  // Enough to scroll: the terminal is 24 rows.
  "shell-1": Array.from({ length: 120 }, (_, index) => `build step ${index + 1} of 120 done`).join("\r\n"),
  "shell-2": "dev@build-box:~$ pnpm dev\r\n  VITE ready in 412 ms\r\n",
};

const requests = { lists: 0, history: [] as string[], opens: 0, resizes: [] as Array<[string, number, number]> };

beforeEach(() => {
  requests.lists = 0;
  requests.history = [];
  requests.opens = 0;
  requests.resizes = [];
  placeSizes.clear();
});

afterEach(() => {
  TestResizeObserver.live.clear();
});

const client: ApiClient = {
  ...api,
  listShells: async () => {
    requests.lists += 1;
    return { shells: [shell(1), shell(2)] };
  },
  shellHistory: async (_sessionId, shellId) => {
    requests.history.push(shellId);
    return { shellId, chunks: [{ seq: 1, stream: "stdout" as const, data: OUTPUT[shellId] ?? "" }], nextAfter: 1, hasMore: false, truncatedBefore: false };
  },
  openShell: async () => {
    requests.opens += 1;
    throw new Error("the fixture has its shells");
  },
  closeShell: async () => undefined,
  resizeShell: async (_sessionId, shellId, cols, rows) => {
    requests.resizes.push([shellId, cols, rows]);
  },
  shellInput: async () => undefined,
};

/** The store only has to hold the machine and the session the dock reads. */
class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    setTimeout(() => {
      this.onopen?.();
      const snapshot: ControlPlaneToUi = {
        type: "snapshot",
        capabilities: {
          sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false,
          projects: true, createProjectLocations: true,
        },
        runners: [runner], boxes: [], projects: [], sessions: [session], runs: [], pods: [],
      };
      this.onmessage?.({ data: JSON.stringify(snapshot) });
    }, 0);
  }
  send() {}
  close() {}
}

const connection: UiConnectionRuntime = {
  instanceId: "session-terminals-test",
  runtimeKey: "session-terminals-test",
  createSocket: () => new FixtureSocket(),
  close() {},
};

/** The session is the routed view: the store keeps shell output only for the sessions on screen. */
const navigation: ViewNavigation = {
  current: () => ({ name: "session", id: session.id }),
  push() {},
  listen: () => () => {},
};

interface DockControls {
  setDockOpen(open: boolean): void;
  terminals: SessionTerminals | null;
}

function DockHarness({ controls }: { controls: DockControls }) {
  const [dockOpen, setDockOpen] = useState(false);
  controls.setDockOpen = setDockOpen;
  return (
    <ApiProvider client={client}>
      <StoreProvider connection={connection} navigation={navigation}>
        <SessionTerminalsProvider sessionId={session.id}>
          <TerminalsProbe controls={controls} />
          {dockOpen && <ShellDock sessionId={session.id} onClose={() => setDockOpen(false)} theme="dark" scheme="wollipog" />}
        </SessionTerminalsProvider>
      </StoreProvider>
    </ApiProvider>
  );
}

function TerminalsProbe({ controls }: { controls: DockControls }) {
  controls.terminals = useSessionTerminals(session.id)?.terminals ?? null;
  return null;
}

async function mountDock() {
  const container = domWindow.document.createElement("div") as unknown as HTMLElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const controls: DockControls = { setDockOpen: () => {}, terminals: null };
  await act(async () => root.render(<DockHarness controls={controls} />));
  // Connected before the dock opens, as a session is by the time someone opens its terminal: the first
  // connection would otherwise count as a reconnect and reload the history once more.
  await settle(20);
  await act(async () => controls.setDockOpen(true));
  return {
    container,
    controls,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const tab = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((candidate) => candidate.textContent?.includes(name));

test("hiding and reopening the dock keeps the tab, the search and each terminal without fetching history again", async () => {
  const view = await mountDock();
  try {
    await until(() => requests.history.length === 2 && tab(view.container, "Shell 2") !== undefined, "the shells and their history");
    const terminals = view.controls.terminals!;
    const shell1 = terminals.terminal("shell-1");
    const shell2 = terminals.terminal("shell-2");
    await until(() => shell1.terminal !== null && shell2.terminal !== null, "both terminals to open");
    const term1 = shell1.terminal!;
    const term2 = shell2.terminal!;
    await until(() => bufferText(term1).includes("build step 120 of 120 done"), "Shell 1's history");
    const disposals = [countDisposals(term1), countDisposals(term2)];

    // Shell 1 scrolled back some way, then Shell 2 selected and searched.
    scrollBack(term1, 30);
    const scrolledTo = term1.buffer.active.viewportY;
    assert.ok(scrolledTo < term1.buffer.active.baseY, "Shell 1 is scrolled back from the bottom");
    await act(async () => fireDomEvent.click(tab(view.container, "Shell 2")!));
    await act(async () => fireDomEvent.click(view.container.querySelector('button[aria-label="Search Output"]')!));
    await act(async () => fireDomEvent.change(view.container.querySelector('input[aria-label="Search Output"]')!, { target: { value: "VITE" } }));
    assert.equal(view.controls.terminals?.getSnapshot().searchTerm, "VITE", "the search has its term");
    const scrollback = [bufferText(term1), bufferText(term2)];

    await act(async () => view.controls.setDockOpen(false));
    assertNoDomNode(view.container.querySelector(".shell-dock"), "the dock is hidden");
    assertNoDomNode(shell1.attachedHost, "a hidden dock's terminals have no host");
    await act(async () => view.controls.setDockOpen(true));
    await settle(20);

    assert.deepEqual(requests.history, ["shell-1", "shell-2"], "reopening fetches no history");
    assert.equal(requests.lists, 2, "reopening lists the shells again, as opening the dock always has");
    assert.equal(tab(view.container, "Shell 2")?.getAttribute("aria-selected"), "true", "the same tab is selected");
    assert.equal(view.container.querySelector<HTMLInputElement>('input[aria-label="Search Output"]')?.value, "VITE", "the search is still open on its term");
    assert.ok(shell1.terminal === term1, "Shell 1 keeps its xterm");
    assert.ok(shell2.terminal === term2, "Shell 2 keeps its xterm");
    assert.deepEqual(disposals.map((calls) => calls.count), [0, 0], "neither terminal was disposed");
    assert.deepEqual([bufferText(term1), bufferText(term2)], scrollback, "each tab keeps its scrollback");
    assert.equal(term1.buffer.active.viewportY, scrolledTo, "Shell 1 keeps its scroll position");
    const hosts = [...view.container.querySelectorAll(".shell-dock .shell-term")];
    assert.equal(hosts.length, 2);
    assertSameDomNode(shell1.attachedHost, hosts[0], "Shell 1's terminal is back in the reopened dock");
    assertSameDomNode(shell2.attachedHost, hosts[1], "Shell 2's terminal is back in the reopened dock");
    assert.equal(requests.opens, 0, "a dock with shells opens none");
  } finally {
    await view.unmount();
  }
});

test("leaving the session disposes its terminals", async () => {
  const view = await mountDock();
  const terminals = await (async () => {
    await until(() => requests.history.length === 2, "the shells' history");
    return view.controls.terminals!;
  })();
  const shell1 = terminals.terminal("shell-1");
  await until(() => shell1.terminal !== null, "Shell 1's terminal to open");
  const disposals = countDisposals(shell1.terminal!);
  await view.unmount();
  await settle(10);
  assert.equal(disposals.count, 1, "the session's store ends its terminals when it goes");
});

// --- One terminal, moved between hosts ---

function MoveHarness({ instance, places, onResize }: {
  instance: ShellTerminalInstance;
  places: { a: boolean; b: boolean };
  onResize: (host: "a" | "b", cols: number, rows: number) => void;
}) {
  const props = {
    instance,
    text: OUTPUT["shell-1"]!,
    total: OUTPUT["shell-1"]!.length,
    interactive: true,
    searchTerm: "",
    theme: "dark" as const,
    scheme: "wollipog",
  };
  return (
    <>
      <div className="host-a">{places.a && <ShellTerminal {...props} onResize={(cols, rows) => onResize("a", cols, rows)} />}</div>
      <div className="host-b">{places.b && <ShellTerminal {...props} onResize={(cols, rows) => onResize("b", cols, rows)} />}</div>
    </>
  );
}

async function mountMove(instance: ShellTerminalInstance, places: { a: boolean; b: boolean }, onResize: (host: "a" | "b", cols: number, rows: number) => void) {
  const container = domWindow.document.createElement("div") as unknown as HTMLElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = (next: { a: boolean; b: boolean }) =>
    act(async () => root.render(<MoveHarness instance={instance} places={next} onResize={onResize} />));
  await render(places);
  return {
    container,
    render,
    host: (place: "a" | "b") => container.querySelector(`.host-${place} > .shell-term`),
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("moving a running shell's terminal to another host keeps the same xterm and refits it there", async () => {
  const terminals = new SessionTerminals(session.id, client, {
    reconcileShellOutputs() {}, loadShellHistory() {}, removeShellOutput() {},
  });
  const instance = terminals.terminal("shell-1");
  const reported: Array<[string, number, number]> = [];
  placeSizes.set("host-a", { cols: 60, rows: 12 });
  placeSizes.set("host-b", { cols: 100, rows: 30 });
  const view = await mountMove(instance, { a: true, b: false }, (host, cols, rows) => reported.push([host, cols, rows]));
  try {
    await until(() => instance.terminal !== null, "the terminal to open");
    const term = instance.terminal!;
    await until(() => bufferText(term).some((line) => line.includes("build step 120")), "the scrollback");
    assert.deepEqual([term.cols, term.rows], [60, 12], "fitted to the first host");
    const disposals = countDisposals(term);
    const scrollback = bufferText(term).join("\n");

    // The second host mounts as the first unmounts, as a move between places does.
    await view.render({ a: false, b: true });
    const hostB = view.host("b")!;

    assert.ok(instance.terminal === term, "the same xterm instance");
    assert.equal(disposals.count, 0, "moving disposes nothing");
    assertSameDomNode(instance.attachedHost, hostB, "the new host has the terminal");
    assertSameDomNode(instance.surface.parentElement, hostB, "the terminal's element moved into the new host");
    assert.deepEqual([term.cols, term.rows], [100, 30], "refitted to the new host's size");
    assert.deepEqual(reported.at(-1), ["b", 100, 30], "the new host reports the new size");
    assert.ok(bufferText(term).join("\n").includes(scrollback.split("\n").filter(Boolean).at(-1)!), "the scrollback moved with it");
  } finally {
    await view.unmount();
    terminals.dispose();
  }
});

test("a shell's terminal has one host at a time, so a resize sends one resize stream", async () => {
  const terminals = new SessionTerminals(session.id, client, {
    reconcileShellOutputs() {}, loadShellHistory() {}, removeShellOutput() {},
  });
  const instance = terminals.terminal("shell-1");
  placeSizes.set("host-a", { cols: 60, rows: 12 });
  placeSizes.set("host-b", { cols: 100, rows: 30 });
  const container = domWindow.document.createElement("div") as unknown as HTMLElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  // Both hosts send to the session's resize queue, as two hosts of one session do.
  const render = (places: { a: boolean; b: boolean }) => act(async () => root.render(
    <MoveHarness instance={instance} places={places} onResize={(_host, cols, rows) => terminals.sendResize("shell-1", cols, rows)} />,
  ));
  try {
    await render({ a: true, b: false });
    const hostA = container.querySelector(".host-a > .shell-term")!;
    await until(() => instance.terminal !== null, "the terminal to open");
    // A second host attaches while the first is still mounted: the terminal moves, it is not shared.
    await render({ a: true, b: true });
    const hostB = container.querySelector(".host-b > .shell-term")!;
    assert.deepEqual([instance.terminal!.cols, instance.terminal!.rows], [100, 30], "fitted to the later host");
    assertSameDomNode(instance.attachedHost, hostB, "the later host has the terminal");
    assert.equal(hostA.childElementCount, 0, "the earlier host shows nothing");
    assert.equal(TestResizeObserver.observing(hostA).length, 0, "the earlier host no longer drives the terminal's size");
    await settle(300);
    requests.resizes = [];

    // Both hosts change size; only the attached one sizes the shell.
    placeSizes.set("host-a", { cols: 70, rows: 14 });
    placeSizes.set("host-b", { cols: 120, rows: 40 });
    TestResizeObserver.resize(hostA);
    TestResizeObserver.resize(hostB);
    await settle(300);
    assert.deepEqual(requests.resizes, [["shell-1", 120, 40]], "one resize, from the attached host");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    terminals.dispose();
  }
});
