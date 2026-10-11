import { fireDomEvent } from "./components/test-dom-events.js";
import assert from "node:assert/strict";
import { register } from "node:module";
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
// the bundler handles, as an empty module. Everything that reaches xterm is imported after these
// hooks. `register` rather than `registerHooks`, which Node 22.13 (the supported minimum) lacks.
const XTERM_LOADER = `
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (!specifier.startsWith("@xterm/") || !resolved.url.endsWith(".js")) return resolved;
  return { ...resolved, url: resolved.url.slice(0, -".js".length) + ".mjs", format: "module" };
}
export async function load(url, context, nextLoad) {
  return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(XTERM_LOADER)}`, import.meta.url);
const { FitAddon } = await import("@xterm/addon-fit");
const { SessionTerminals, SessionTerminalsProvider, useSessionTerminals } = await import("./session-terminals.js");
const { ShellDock, MOVE_TO_RIGHT_PANEL_DESCRIPTION } = await import("./components/ShellDock.js");
const { ShellTerminal } = await import("./components/ShellTerminal.js");
const { TerminalTool, MOVE_TO_BOTTOM_DOCK_DESCRIPTION } = await import("./components/TerminalTool.js");
const { PanelActionSlotContext } = await import("./components/RightPanel.js");
const { requestTerminalFocus, takeTerminalFocusRequest } = await import("./terminal-focus.js");
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
/** The fixture registry, and how New Shell is answered: refused unless a test holds the answer. */
let fixtureShells: ShellView[] = [];
let openShellAnswer: (() => Promise<ShellView>) | null = null;

beforeEach(() => {
  fixtureShells = [shell(1), shell(2)];
  openShellAnswer = null;
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
    return { shells: structuredClone(fixtureShells) };
  },
  shellHistory: async (_sessionId, shellId) => {
    requests.history.push(shellId);
    return { shellId, chunks: [{ seq: 1, stream: "stdout" as const, data: OUTPUT[shellId] ?? "" }], nextAfter: 1, hasMore: false, truncatedBefore: false };
  },
  openShell: async () => {
    requests.opens += 1;
    if (openShellAnswer) return { shell: await openShellAnswer() };
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
          {dockOpen && <ShellDock sessionId={session.id} onClose={() => setDockOpen(false)} onMoveToPanel={() => {}} theme="dark" scheme="wollipog" />}
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
  await until(() => requests.history.length === 2, "the shells' history");
  const terminals = view.controls.terminals!;
  const shell1 = terminals.terminal("shell-1");
  await until(() => shell1.terminal !== null, "Shell 1's terminal to open");
  const disposals = countDisposals(shell1.terminal!);
  // A move whose destination never mounted before the session was left (#2869).
  requestTerminalFocus(session.id, "panel");
  await view.unmount();
  await settle(10);
  assert.equal(disposals.count, 1, "the session's store ends its terminals when it goes");
  assert.equal(takeTerminalFocusRequest(session.id, "panel"), false, "its focus request goes with it");
});

test("a reopened empty dock offers a first shell once the last open's New Shell settles", async () => {
  fixtureShells = [];
  let refuse!: (error: Error) => void;
  openShellAnswer = () => new Promise<ShellView>((_resolve, reject) => { refuse = reject; });
  const view = await mountDock();
  try {
    // The empty dock offers a first shell, which is still being opened when the dock is hidden.
    await until(() => requests.opens === 1, "the first shell offer");
    await act(async () => view.controls.setDockOpen(false));
    await act(async () => view.controls.setDockOpen(true));
    await until(() => requests.lists === 2, "the reopened list");
    await settle(10);
    assert.equal(requests.opens, 1, "nothing more is offered while that shell is being opened");

    openShellAnswer = null;
    await act(async () => refuse(new Error("machine went away")));
    await until(() => requests.opens === 2, "the reopened dock's own offer");
  } finally {
    await view.unmount();
  }
});

// --- The store's loads, without a host rendering ---

/** A store over a shell API whose registry, history answers and shell creation the test controls. */
function storeOver(registry: ShellView[], options: {
  failHistory?: () => boolean;
  /** Awaited before a history answer or a list answer is given. */
  holdHistory?: () => Promise<void>;
  holdList?: () => Promise<void>;
  openShell?: () => Promise<ShellView>;
} = {}) {
  const history: string[] = [];
  const loaded: string[] = [];
  const opens = { count: 0 };
  const shellApi = {
    ...client,
    listShells: async () => {
      const shells = structuredClone(registry);
      await options.holdList?.();
      return { shells };
    },
    shellHistory: async (_sessionId: string, shellId: string) => {
      history.push(shellId);
      await options.holdHistory?.();
      if (options.failHistory?.()) throw new Error("history unavailable");
      return { shellId, chunks: [], nextAfter: 0, hasMore: false, truncatedBefore: false };
    },
    openShell: async () => {
      opens.count += 1;
      return { shell: await (options.openShell ?? (() => Promise.reject(new Error("no shell"))))() };
    },
  } as ApiClient;
  const terminals = new SessionTerminals(session.id, shellApi, {
    reconcileShellOutputs() {},
    loadShellHistory(_sessionId, shellId) { loaded.push(shellId); },
    removeShellOutput() {},
  });
  return { terminals, history, loaded, opens };
}

/** A promise the test resolves later. */
function gate(): { wait: () => Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { wait: () => opened, open };
}

test("history read before a reconnect does not count as loaded once it lands", async () => {
  let hold: ReturnType<typeof gate> | null = gate();
  const { terminals, history, loaded } = storeOver([shell(1)], { holdHistory: () => hold?.wait() ?? Promise.resolve() });
  try {
    let release = terminals.openHost();
    await until(() => history.length === 1, "the first history request");
    release();

    // The connection drops and returns while the first answer is still on its way, then it lands.
    terminals.reconnected();
    const late = hold;
    hold = null;
    late.open();
    await settle(10);
    assert.deepEqual(loaded, [], "the pre-reconnect answer is dropped");

    release = terminals.openHost();
    await until(() => loaded.length === 1, "the reload on the next open");
    release();
    assert.deepEqual(history, ["shell-1", "shell-1"]);
  } finally {
    terminals.dispose();
  }
});

test("history New Shell interrupts is loaded again while the terminal shows", async () => {
  let hold: ReturnType<typeof gate> | null = gate();
  const { terminals, history, loaded } = storeOver([shell(1)], {
    holdHistory: () => hold?.wait() ?? Promise.resolve(),
    openShell: async () => shell(2),
  });
  const release = terminals.openHost();
  try {
    await until(() => history.length === 1, "Shell 1's history request");
    // New Shell lands while that history is still on the way, which drops the answer.
    const held = hold;
    hold = null;
    await terminals.newShell();
    held.open();
    await until(() => loaded.includes("shell-1"), "Shell 1's history, loaded again");
    assert.deepEqual(history, ["shell-1", "shell-1"]);
  } finally {
    release();
    terminals.dispose();
  }
});

test("each open starts without the last open's failed-action notice", async () => {
  let failHistory = true;
  const { terminals, loaded } = storeOver([shell(1)], { failHistory: () => failHistory });
  try {
    let release = terminals.openHost();
    await until(() => terminals.getSnapshot().error !== null, "the failed history load");
    release();
    failHistory = false;
    release = terminals.openHost();
    assert.equal(terminals.getSnapshot().error, null, "the reopened terminal shows no stale notice");
    await until(() => loaded.length === 1, "the retried history");
    release();
  } finally {
    terminals.dispose();
  }
});

test("a shell created across a hidden reconnect has its history loaded on the next open", async () => {
  const registry: ShellView[] = [];
  let answer!: (created: ShellView) => void;
  const { terminals, history } = storeOver(registry, {
    openShell: () => new Promise<ShellView>((resolve) => { answer = resolve; }),
  });
  try {
    let release = terminals.openHost();
    await until(() => terminals.getSnapshot().shells !== null, "the first list");
    const creating = terminals.newShell();
    release();

    // The connection drops and returns before the runner answers: the shell's first output may be lost.
    terminals.reconnected();
    registry.push(shell(2));
    answer(shell(2));
    await creating;

    release = terminals.openHost();
    await until(() => history.includes("shell-2"), "the new shell's history");
    release();
  } finally {
    terminals.dispose();
  }
});

test("a shell created while an older list lands has its history loaded on the next open", async () => {
  const registry = [shell(1)];
  let hold: ReturnType<typeof gate> | null = null;
  let answer!: (created: ShellView) => void;
  const { terminals, history } = storeOver(registry, {
    holdList: () => hold?.wait() ?? Promise.resolve(),
    openShell: () => new Promise<ShellView>((resolve) => { answer = resolve; }),
  });
  try {
    let release = terminals.openHost();
    await until(() => history.includes("shell-1"), "the first load");
    release();

    // Reopened with its list read but not yet answered, New Shell starts, and the dock is hidden.
    hold = gate();
    release = terminals.openHost();
    const creating = terminals.newShell();
    release();
    registry.push(shell(2));
    // The older list lands first: it prunes the new shell's output, which it does not list.
    hold.open();
    await settle(10);
    answer(shell(2));
    await creating;

    hold = null;
    release = terminals.openHost();
    await until(() => history.includes("shell-2"), "the new shell's history");
    release();
  } finally {
    terminals.dispose();
  }
});

test("New Shell answering before a reopen's list reads the registry again", async () => {
  const registry = [shell(1)];
  let hold: ReturnType<typeof gate> | null = null;
  let answer!: (created: ShellView) => void;
  const { terminals } = storeOver(registry, {
    holdList: () => hold?.wait() ?? Promise.resolve(),
    openShell: () => new Promise<ShellView>((resolve) => { answer = resolve; }),
  });
  try {
    let release = terminals.openHost();
    await until(() => terminals.getSnapshot().shells?.length === 1, "the first list");
    const creating = terminals.newShell();
    release();

    // Another dashboard closes Shell 1; the terminal reopens; New Shell answers before the list does.
    registry.splice(0, registry.length, shell(2));
    hold = gate();
    release = terminals.openHost();
    answer(shell(2));
    await creating;
    hold.open();
    await until(() => terminals.getSnapshot().shells?.length === 1, "the registry read again");
    release();
    assert.deepEqual(terminals.getSnapshot().shells?.map((listed) => listed.shellId), ["shell-2"]);
  } finally {
    terminals.dispose();
  }
});

test("Close Tab during a reopen's list reads the registry again", async () => {
  const registry = [shell(1), shell(2)];
  let hold: ReturnType<typeof gate> | null = null;
  const { terminals } = storeOver(registry, { holdList: () => hold?.wait() ?? Promise.resolve() });
  try {
    let release = terminals.openHost();
    await until(() => terminals.getSnapshot().shells?.length === 2, "the first list");
    release();

    // Another dashboard opens Shell 3; the terminal reopens, and Shell 1 is closed before the list lands.
    registry.push(shell(3));
    hold = gate();
    release = terminals.openHost();
    terminals.closeShell("shell-1");
    hold.open();
    await until(() => terminals.getSnapshot().shells?.length === 2 &&
      terminals.getSnapshot().shells?.some((listed) => listed.shellId === "shell-3") === true, "the registry read again");
    release();
    assert.deepEqual(terminals.getSnapshot().shells?.map((listed) => listed.shellId), ["shell-2", "shell-3"]);
  } finally {
    terminals.dispose();
  }
});

test("closing the last tab before a reopen's list lands offers no first shell", async () => {
  const registry = [shell(1)];
  let hold: ReturnType<typeof gate> | null = null;
  const { terminals, opens } = storeOver(registry, {
    holdList: () => hold?.wait() ?? Promise.resolve(),
    openShell: async () => shell(9),
  });
  try {
    let release = terminals.openHost();
    await until(() => terminals.getSnapshot().shells?.length === 1, "the first list");
    release();

    hold = gate();
    release = terminals.openHost();
    terminals.closeShell("shell-1");
    registry.splice(0, registry.length);
    hold.open();
    await until(() => terminals.getSnapshot().shells?.length === 0, "the empty list");
    await settle(10);
    terminals.offerFirstShell(true, true);
    release();
    assert.equal(opens.count, 0, "the closed tab is not replaced");
  } finally {
    terminals.dispose();
  }
});

test("a reopened terminal offers a first shell only once its own list has arrived", async () => {
  const registry: ShellView[] = [];
  let hold: ReturnType<typeof gate> | null = null;
  const { terminals, opens } = storeOver(registry, { holdList: () => hold?.wait() ?? Promise.resolve() });
  try {
    let release = terminals.openHost();
    await until(() => terminals.getSnapshot().shells !== null, "the first, empty list");
    // The machine is offline, so nothing is offered; then the terminal is hidden.
    terminals.offerFirstShell(false, true);
    release();

    // Another dashboard opens a shell; the terminal reopens while its list is still on the way.
    registry.push(shell(7));
    hold = gate();
    release = terminals.openHost();
    terminals.offerFirstShell(true, true);
    assert.equal(opens.count, 0, "the last open's empty list is not this open's");

    hold.open();
    await until(() => terminals.getSnapshot().shells?.length === 1, "the reopened list");
    terminals.offerFirstShell(true, true);
    release();
    assert.equal(opens.count, 0, "a session with a shell is offered none");
    assert.deepEqual(terminals.getSnapshot().shells?.map((listed) => listed.shellId), ["shell-7"]);
  } finally {
    terminals.dispose();
  }
});

test("history a reconnect left stale is fetched on every open until it lands", async () => {
  let failHistory = false;
  const { terminals, history, loaded } = storeOver([shell(1)], { failHistory: () => failHistory });
  try {
    let release = terminals.openHost();
    await until(() => loaded.length === 1, "the first history");
    release();

    // The connection drops and returns while the terminal is hidden.
    terminals.reconnected();
    assert.deepEqual(history, ["shell-1"], "a hidden terminal reloads nothing yet");

    failHistory = true;
    release = terminals.openHost();
    await until(() => history.length === 2, "the reload on the next open");
    await settle(10);
    release();
    assert.deepEqual(loaded, ["shell-1"], "the failed reload committed nothing");

    failHistory = false;
    release = terminals.openHost();
    await until(() => loaded.length === 2, "the reload to be retried");
    release();
    assert.deepEqual(history, ["shell-1", "shell-1", "shell-1"]);

    release = terminals.openHost();
    await settle(20);
    release();
    assert.equal(history.length, 3, "once it has landed, an open fetches no history");
  } finally {
    terminals.dispose();
  }
});

test("a shell created while the terminal reopens keeps one tab", async () => {
  const registry = [shell(1)];
  let answer!: (created: ShellView) => void;
  const { terminals } = storeOver(registry, {
    openShell: () => new Promise<ShellView>((resolve) => { answer = resolve; }),
  });
  try {
    let release = terminals.openHost();
    await until(() => terminals.getSnapshot().shells?.length === 1, "the first list");
    const creating = terminals.newShell();
    release();

    // The registry lists the new shell before its runner answers, so the reopened list holds it.
    registry.push(shell(2));
    release = terminals.openHost();
    await until(() => terminals.getSnapshot().shells?.length === 2, "the reopened list");
    answer(shell(2));
    await creating;
    release();
    assert.deepEqual(terminals.getSnapshot().shells?.map((listed) => listed.shellId), ["shell-1", "shell-2"]);
    assert.equal(terminals.getSnapshot().active, "shell-2", "the created shell is selected");
  } finally {
    terminals.dispose();
  }
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

test("a match count that changes while no host is attached is shown when one attaches", async () => {
  const terminals = new SessionTerminals(session.id, client, {
    reconcileShellOutputs() {}, loadShellHistory() {}, removeShellOutput() {},
  });
  const instance = terminals.terminal("shell-1");
  const counts: Array<number | null> = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = (shown: boolean, text: string) => act(async () => root.render(
    <div className="host-a">
      {shown && (
        <ShellTerminal
          instance={instance}
          text={text}
          total={text.length}
          interactive
          searchTerm="needle"
          theme="dark"
          scheme="wollipog"
          onSearchResults={(results) => counts.push(results?.count ?? null)}
        />
      )}
    </div>,
  ));
  try {
    await render(true, "haystack\r\n");
    await until(() => counts.length > 0, "the first count");
    assert.equal(counts.at(-1), 0);

    // Matching output arrives just before the terminal is hidden: the addon recounts after it goes.
    const more = "haystack\r\nneedle\r\n";
    await render(true, more);
    await render(false, more);
    await settle(500);
    await render(true, more);
    await until(() => counts.at(-1) === 1, "the recount, shown on attach");
  } finally {
    await act(async () => root.unmount());
    container.remove();
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

// --- The side panel's Terminal tool (#2868) ---

test("watching the shell list reads it with no host open, loading no history and opening no shell", async () => {
  const registry = [shell(1), shell(2)];
  let failList = false;
  let lists = 0;
  const { terminals, history, opens } = storeOver(registry, {
    holdList: async () => {
      lists += 1;
      if (failList) throw new Error("registry unavailable");
    },
  });
  try {
    assert.equal(terminals.getSnapshot().shells, null, "nothing is read until something asks");
    const unwatch = terminals.watchShells();
    await until(() => terminals.getSnapshot().shells?.length === 2, "the watched list");
    assert.equal(terminals.getSnapshot().active, "shell-1");
    assert.deepEqual(history, [], "watching loads no history");
    assert.equal(opens.count, 0, "watching opens no shell");

    // A reconnect, or another dashboard's shell, reads the list again.
    registry.push(shell(3));
    terminals.registryChanged();
    await until(() => terminals.getSnapshot().shells?.length === 3, "the list after the registry changed");
    registry.pop();
    terminals.unknownShellSeen();
    await until(() => terminals.getSnapshot().shells?.length === 2, "the list after another dashboard's shell");

    failList = true;
    terminals.registryChanged();
    await until(() => terminals.getSnapshot().listUnreadable, "a list that could not be read");
    failList = false;

    // A host keeps the list current itself, and its load clears the failure.
    const release = terminals.openHost();
    await until(() => !terminals.getSnapshot().listUnreadable && history.length === 2, "the host's own load");
    const before = lists;
    terminals.registryChanged();
    await settle(10);
    assert.equal(lists, before + 1, "with a host open the host reloads the list, not a second read");
    release();

    // With the host gone again, a reconnect still refreshes the watched list (its own read is the newest).
    const rewatch = terminals.watchShells();
    registry.pop();
    terminals.reconnected();
    await until(() => terminals.getSnapshot().shells?.length === 1, "the list after a reconnect, once a host has been open");
    rewatch();

    unwatch();
    const unwatched = lists;
    terminals.registryChanged();
    await settle(10);
    assert.equal(lists, unwatched, "nothing reads the list once nothing watches it");
  } finally {
    terminals.dispose();
  }
});

test("a watched list that drops the selected shell drops its command draft too, so the draft never reaches another shell", async () => {
  const registry = [{ ...shell(1), pty: false }, { ...shell(2), pty: false }];
  const sent: Array<[string, string]> = [];
  const { terminals } = storeOver(registry);
  (terminals as unknown as { api: { shellInput: (s: string, id: string, data: string) => Promise<void> } }).api.shellInput =
    async (_sessionId, shellId, data) => { sent.push([shellId, data]); };
  try {
    const release = terminals.openHost();
    await until(() => terminals.getSnapshot().shells?.length === 2, "the shells");
    terminals.setInput("rm -rf build");
    release();

    const unwatch = terminals.watchShells();
    registry.splice(0, 1); // Another dashboard closes Shell 1.
    terminals.registryChanged();
    await until(() => terminals.getSnapshot().active === "shell-2", "Shell 2 selected in its place");
    assert.equal(terminals.getSnapshot().input, "", "Shell 1's draft went with it");
    unwatch();

    const reopen = terminals.openHost();
    await settle(10);
    await terminals.sendLine();
    assert.deepEqual(sent, [["shell-2", "\n"]], "Enter on the empty row is a blank line, never Shell 1's command");
    reopen();
  } finally {
    terminals.dispose();
  }
});

test("a host's list still on its way when the terminal is hidden never lands after the watched list", async () => {
  const answers: Array<(shells: ShellView[]) => void> = [];
  const shellApi = {
    ...client,
    listShells: () => new Promise<{ shells: ShellView[] }>((resolve) => { answers.push((shells) => resolve({ shells })); }),
    shellHistory: async (_sessionId: string, shellId: string) => ({ shellId, chunks: [], nextAfter: 0, hasMore: false, truncatedBefore: false }),
  } as ApiClient;
  const terminals = new SessionTerminals(session.id, shellApi, {
    reconcileShellOutputs() {}, loadShellHistory() {}, removeShellOutput() {},
  });
  try {
    // The tool opens and reads the list; the person switches to Session Tools before it answers.
    const release = terminals.openHost();
    release();
    const unwatch = terminals.watchShells();
    assert.equal(answers.length, 2, "the host's read and the watcher's");
    // The watcher's read answers first with the current registry, then the host's older one lands.
    answers[1]!([shell(2)]);
    await settle(10);
    assert.deepEqual(terminals.getSnapshot().shells?.map((listed) => listed.shellId), ["shell-2"]);
    answers[0]!([shell(1)]);
    await settle(10);
    assert.deepEqual(terminals.getSnapshot().shells?.map((listed) => listed.shellId), ["shell-2"], "the older read is dropped");
    assert.equal(terminals.getSnapshot().active, "shell-2");
    unwatch();
  } finally {
    terminals.dispose();
  }
});

interface ToolControls {
  setPlace(place: "none" | "panel" | "dock"): void;
  terminals: SessionTerminals | null;
  moves: number;
}

/** The panel's Terminal tool with its header slot, or the dock, over the session's terminals. */
function ToolHarness({ controls }: { controls: ToolControls }) {
  const [place, setPlace] = useState<"none" | "panel" | "dock">("none");
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  controls.setPlace = setPlace;
  return (
    <ApiProvider client={client}>
      <StoreProvider connection={connection} navigation={navigation}>
        <SessionTerminalsProvider sessionId={session.id}>
          <TerminalsProbe controls={controls as unknown as DockControls} />
          <div className="rpanel-actions" ref={setSlot} />
          {place === "panel" && (
            <PanelActionSlotContext.Provider value={slot}>
              <div className="rpanel-body term-host">
                <TerminalTool
                  sessionId={session.id}
                  onMoveToDock={() => {
                    // As the side panel does: the terminal's next host takes focus, then the dock opens.
                    controls.moves += 1;
                    requestTerminalFocus(session.id, "dock");
                    setPlace("dock");
                  }}
                />
              </div>
            </PanelActionSlotContext.Provider>
          )}
          {place === "dock" && (
            <ShellDock
              sessionId={session.id}
              onClose={() => setPlace("none")}
              onMoveToPanel={() => {
                // As the app does: the terminal's next host takes focus, then the panel opens on Terminal.
                controls.moves += 1;
                requestTerminalFocus(session.id, "panel");
                setPlace("panel");
              }}
              theme="dark"
              scheme="wollipog"
            />
          )}
        </SessionTerminalsProvider>
      </StoreProvider>
    </ApiProvider>
  );
}

async function mountTool(start: "panel" | "dock" = "panel") {
  const container = domWindow.document.createElement("div") as unknown as HTMLElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const controls: ToolControls = { setPlace: () => {}, terminals: null, moves: 0 };
  await act(async () => root.render(<ToolHarness controls={controls} />));
  await settle(20);
  await act(async () => controls.setPlace(start));
  return {
    container,
    controls,
    button: (name: string) => container.querySelector<HTMLButtonElement>(`.rpanel-actions button[aria-label="${name}"]`),
    dockButton: (name: string) => container.querySelector<HTMLButtonElement>(`.shell-dock-head button[aria-label="${name}"]`),
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("the Terminal tool's header has Search Output, New Tab and More Terminal Actions, and search opens on its own row", async () => {
  const view = await mountTool();
  try {
    await until(() => tab(view.container, "Shell 2") !== undefined, "the tabs");
    const actions = [...view.container.querySelectorAll<HTMLButtonElement>(".rpanel-actions button")].map((button) => button.getAttribute("aria-label"));
    assert.deepEqual(actions, ["Search Output", "New Tab", "More Terminal Actions"]);
    assert.equal(view.button("Search Output")?.className, "icon-btn", "the header's 32px buttons, not the dock's 28px ones");
    assert.equal(view.button("Search Output")?.getAttribute("aria-pressed"), "false");
    assertNoDomNode(view.container.querySelector(".term-search"), "no search row until Search Output");

    await act(async () => fireDomEvent.click(view.button("Search Output")!));
    assert.equal(view.button("Search Output")?.getAttribute("aria-pressed"), "true", "pressed while the row is open");
    const row = view.container.querySelector(".rpanel-body > .rpanel-toolbar.term-search");
    assert.ok(row, "the search row is the toolbar under the tabs");
    assertSameDomNode(row!.previousElementSibling, view.container.querySelector(".term-tabs"), "it follows the tab strip");
    const field = row!.querySelector<HTMLInputElement>('input[aria-label="Search Output"]')!;
    assert.ok((domWindow.document.activeElement as unknown) === field, "the field takes focus");
    await act(async () => fireDomEvent.change(field, { target: { value: "VITE" } }));
    assert.equal(view.controls.terminals?.getSnapshot().searchTerm, "VITE", "the session's one search has the term");

    // Pressing it again closes the row; the term goes with it, as Close Search does.
    await act(async () => fireDomEvent.click(view.button("Search Output")!));
    assertNoDomNode(view.container.querySelector(".term-search"), "the row closes");
    assert.equal(view.controls.terminals?.getSnapshot().searchTerm, "");

    await act(async () => fireDomEvent.click(view.button("More Terminal Actions")!));
    const item = (domWindow.document as unknown as Document).querySelector<HTMLButtonElement>('[role="menu"] [role="menuitem"]')!;
    assert.match(item.textContent ?? "", /^Move to Bottom Dock/);
    assert.ok(item.textContent?.includes(MOVE_TO_BOTTOM_DOCK_DESCRIPTION), "the item has its second line");
    assert.equal(MOVE_TO_BOTTOM_DOCK_DESCRIPTION, "Show the terminal in the dock below the conversation on this device. Running shells keep running.");
  } finally {
    await view.unmount();
  }
});

test("Move to Bottom Dock moves the panel's terminals into the dock: same tab, xterm, scrollback and search, nothing fetched again", async () => {
  const view = await mountTool();
  try {
    await until(() => requests.history.length === 2 && tab(view.container, "Shell 2") !== undefined, "the shells and their history");
    const terminals = view.controls.terminals!;
    const shell1 = terminals.terminal("shell-1");
    const shell2 = terminals.terminal("shell-2");
    await until(() => shell1.terminal !== null && shell2.terminal !== null, "both terminals to open");
    const [term1, term2] = [shell1.terminal!, shell2.terminal!];
    await until(() => bufferText(term1).includes("build step 120 of 120 done"), "Shell 1's history");
    const disposals = [countDisposals(term1), countDisposals(term2)];
    assert.ok(shell1.attachedHost?.closest(".term-host .term-body"), "the panel's body hosts the terminals");

    await act(async () => fireDomEvent.click(tab(view.container, "Shell 2")!));
    await act(async () => fireDomEvent.click(view.button("Search Output")!));
    await act(async () => fireDomEvent.change(view.container.querySelector('input[aria-label="Search Output"]')!, { target: { value: "VITE" } }));
    const scrollback = [bufferText(term1), bufferText(term2)];

    await act(async () => fireDomEvent.click(view.button("More Terminal Actions")!));
    await act(async () => fireDomEvent.click((domWindow.document as unknown as Document).querySelector('[role="menu"] [role="menuitem"]')!));
    await settle(30);

    assert.equal(view.controls.moves, 1);
    assertNoDomNode(view.container.querySelector(".term-host"), "the panel's tool is gone");
    const dock = view.container.querySelector(".shell-dock")!;
    assert.ok(dock, "the dock shows the terminal");
    assert.equal(tab(view.container, "Shell 2")?.getAttribute("aria-selected"), "true", "the same tab is selected");
    assert.equal(dock.querySelector<HTMLInputElement>('input[aria-label="Search Output"]')?.value, "VITE", "the search moved with it");
    assert.ok(shell1.terminal === term1 && shell2.terminal === term2, "each shell keeps its xterm");
    assert.deepEqual(disposals.map((calls) => calls.count), [0, 0], "no terminal was disposed");
    assert.deepEqual([bufferText(term1), bufferText(term2)], scrollback, "each keeps its scrollback");
    const hosts = [...dock.querySelectorAll(".shell-term")];
    assertSameDomNode(shell1.attachedHost, hosts[0], "Shell 1's terminal is in the dock");
    assertSameDomNode(shell2.attachedHost, hosts[1], "Shell 2's terminal is in the dock");
    assert.deepEqual(requests.history, ["shell-1", "shell-2"], "no history is fetched again");
    assert.equal(requests.opens, 0, "no shell is opened, so none restarts");
    await settle(30);
    assert.ok(domWindow.document.activeElement?.closest(".shell-dock .xterm"), "focus followed the terminal into the dock");
  } finally {
    await view.unmount();
  }
});

test("the dock's head has More Terminal Actions before Hide Terminal, whose one item is Move to Right Panel", async () => {
  const view = await mountTool("dock");
  try {
    await until(() => tab(view.container, "Shell 2") !== undefined, "the tabs");
    const tools = [...view.container.querySelectorAll<HTMLButtonElement>(".shell-dock-tools > button, .shell-dock-tools > [aria-label]")]
      .map((button) => button.getAttribute("aria-label"));
    assert.deepEqual(tools, ["Search Output", "New Tab", "More Terminal Actions", "Hide Terminal"]);
    const more = view.dockButton("More Terminal Actions")!;
    assert.equal(more.className, "icon-btn sm", "the dock's 28px buttons");
    assert.equal(more.title, "More Terminal Actions", "the tooltip matches the name");
    assert.equal(more.getAttribute("aria-haspopup"), "menu");

    await act(async () => fireDomEvent.click(more));
    const menu = (domWindow.document as unknown as Document).querySelector<HTMLElement>('[role="menu"]')!;
    assert.equal(menu.getAttribute("aria-label"), "More Terminal Actions", "the menu's name matches the button's");
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    assert.equal(items.length, 1);
    assert.equal(items[0]!.querySelector(".menu-text")?.textContent, "Move to Right Panel");
    assert.equal(items[0]!.querySelector(".menu-desc")?.textContent, MOVE_TO_RIGHT_PANEL_DESCRIPTION, "the item has its second line");
    assert.equal(MOVE_TO_RIGHT_PANEL_DESCRIPTION, "Show the terminal as a tool in the right panel on this device. Running shells keep running.");
    assert.ok(items[0]!.querySelector(".menu-icon svg"), "with its icon");
  } finally {
    await view.unmount();
  }
});

test("Move to Right Panel moves the dock's terminals into the panel's tool: same tab, xterm, scrollback and search, nothing fetched again", async () => {
  const view = await mountTool("dock");
  try {
    await until(() => requests.history.length === 2 && tab(view.container, "Shell 2") !== undefined, "the shells and their history");
    const terminals = view.controls.terminals!;
    const shell1 = terminals.terminal("shell-1");
    const shell2 = terminals.terminal("shell-2");
    await until(() => shell1.terminal !== null && shell2.terminal !== null, "both terminals to open");
    const [term1, term2] = [shell1.terminal!, shell2.terminal!];
    await until(() => bufferText(term1).includes("build step 120 of 120 done"), "Shell 1's history");
    const disposals = [countDisposals(term1), countDisposals(term2)];
    assert.ok(shell1.attachedHost?.closest(".shell-dock"), "the dock hosts the terminals");

    await act(async () => fireDomEvent.click(tab(view.container, "Shell 2")!));
    await act(async () => fireDomEvent.click(view.dockButton("Search Output")!));
    await act(async () => fireDomEvent.change(view.container.querySelector('input[aria-label="Search Output"]')!, { target: { value: "VITE" } }));
    const scrollback = [bufferText(term1), bufferText(term2)];

    await act(async () => fireDomEvent.click(view.dockButton("More Terminal Actions")!));
    await act(async () => fireDomEvent.click((domWindow.document as unknown as Document).querySelector('[role="menu"] [role="menuitem"]')!));
    await settle(30);

    assert.equal(view.controls.moves, 1);
    assertNoDomNode(view.container.querySelector(".shell-dock"), "the dock is gone");
    const body = view.container.querySelector(".term-host")!;
    assert.ok(body, "the panel's Terminal tool shows the terminal");
    assert.equal(tab(view.container, "Shell 2")?.getAttribute("aria-selected"), "true", "the same tab is selected");
    assert.equal(body.querySelector<HTMLInputElement>('input[aria-label="Search Output"]')?.value, "VITE", "the search moved with it");
    assert.ok(shell1.terminal === term1 && shell2.terminal === term2, "each shell keeps its xterm");
    assert.deepEqual(disposals.map((calls) => calls.count), [0, 0], "no terminal was disposed");
    assert.deepEqual([bufferText(term1), bufferText(term2)], scrollback, "each keeps its scrollback");
    const hosts = [...body.querySelectorAll(".shell-term")];
    assertSameDomNode(shell1.attachedHost, hosts[0], "Shell 1's terminal is in the panel");
    assertSameDomNode(shell2.attachedHost, hosts[1], "Shell 2's terminal is in the panel");
    assert.deepEqual(requests.history, ["shell-1", "shell-2"], "no history is fetched again");
    assert.equal(requests.opens, 0, "no shell is opened, so none restarts");
    await settle(30);
    assert.ok(domWindow.document.activeElement?.closest(".term-host .xterm"), "focus followed the terminal into the panel");
  } finally {
    await view.unmount();
  }
});

test("moving a pipe shell to the dock puts focus in its command field, which is what types into it", async () => {
  fixtureShells = [{ ...shell(1), pty: false }];
  const view = await mountTool();
  try {
    await until(() => view.container.querySelector(".term-host .pipe-row .shell-input") !== null, "the pipe shell's command row");
    await act(async () => fireDomEvent.click(view.button("More Terminal Actions")!));
    await act(async () => fireDomEvent.click((domWindow.document as unknown as Document).querySelector('[role="menu"] [role="menuitem"]')!));
    await settle(30);
    const field = view.container.querySelector(".shell-dock .pipe-row .shell-input");
    assert.ok(field, "the dock shows the command row");
    assert.ok((domWindow.document.activeElement as unknown) === field, "focus is in the command field, not the read-only output");
  } finally {
    await view.unmount();
  }
});

test("the Terminal tool with no shells shows the empty state with New Shell, and no tab strip", async () => {
  fixtureShells = [];
  openShellAnswer = () => new Promise<ShellView>(() => {});
  const view = await mountTool();
  try {
    await until(() => view.container.querySelector(".term-body .state") !== null, "the empty state");
    const state = view.container.querySelector(".term-body .state")!;
    assert.match(state.textContent ?? "", /No Shells Open/);
    assert.match(state.textContent ?? "", /Run commands in this session's worktree on Build Box\./);
    assert.ok([...state.querySelectorAll("button")].some((button) => button.textContent?.includes("New Shell")));
    assertNoDomNode(view.container.querySelector(".term-tabs"), "no strip without a tab");
    assert.equal(view.button("Search Output")?.disabled, true, "nothing to search");
  } finally {
    await view.unmount();
  }
});
