import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { BoxView, ControlPlaneToUi, ProjectView, RunnerView, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { SessionDetail } from "./SessionDetail.js";
import { EditorSelect } from "./EditorSelect.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { staticPinnedSummary } from "./pinned-summary-state.js";

/**
 * #2277: one machine has one name on the session page. The Pinned Summary's Machine row, Sign Out
 * of Agent's body and the Open control's offline note all name it with runnerDisplay(); the
 * technical identity (hostname, or SSH target for a remote machine) stays in the row's tooltip.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 72, width: 1200, height: 72, toJSON: () => ({}) }),
});
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  localStorage: domWindow.localStorage, Element: domWindow.Element, HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement, HTMLTextAreaElement: domWindow.HTMLTextAreaElement, Node: domWindow.Node, Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver, React, IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }),
});

const RUNNER_ID = "runner-7f3a";

const baseRunner = {
  runnerId: RUNNER_ID, hostname: "mac-studio.local", os: "macos", version: "1", status: "online",
  agents: [{
    id: "gemini", name: "Gemini CLI", command: "gemini", args: [], env: {}, driver: "acp", available: true,
    acp: { logout: true },
  }],
  editors: [{ id: "vscode", name: "VS Code" }],
  workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 146,
} as unknown as RunnerView;

const project = {
  id: "payments", name: "Payments Service", hidden: false, locations: [], activeSessionCount: 0,
  unarchivedSessionCount: 1, totalSessionCount: 1, createdAt: 1, updatedAt: 1,
} as ProjectView;

const session = {
  id: "machine-name", runnerId: RUNNER_ID, workspaceId: null, workspaceName: null, projectId: project.id,
  projectName: project.name, agentId: "gemini", agentName: "Gemini CLI", title: "Machine Name", status: "idle",
  column: "review", runId: null, useWorktree: false, worktreePath: null, worktrees: [],
  backgroundWorkTracking: "untracked", archived: false, createdAt: 1, updatedAt: 1,
  lastEventAt: null, messageCount: 0, eventEpoch: 0, preview: null, pendingApproval: null,
  driver: "acp", model: null, effort: null, permissionMode: null,
  tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
} as unknown as SessionView;

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: ControlPlaneToUi) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

/** Menus and dialogs are portalled to <body>, so queries look there. */
function page(): HTMLElement {
  return domWindow.document.body as unknown as HTMLElement;
}

interface Observed {
  machineRow: string | null | undefined;
  machineTitle: string | null | undefined;
  /** The machine Sign Out of Agent's body names, or null when the item is not offered. */
  signOut: string | null;
  /** The machine the Open control's offline note names, or null when there is no note. */
  offlineNote: string | null;
  openControl: boolean;
}

async function observe(runner: RunnerView, boxes: BoxView[]): Promise<Observed> {
  const socket = new FakeSocket();
  const confirmations: string[] = [];
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: () => new Promise<never>(() => {}),
    getSessionEventTailPage: () => new Promise<never>(() => {}),
    git: () => new Promise<never>(() => {}),
    gitSummary: () => new Promise<never>(() => {}),
    runnerSkills: async () => ({ desired: [], reported: null }),
  } as unknown as ApiClient;
  const connection: UiConnectionRuntime = {
    instanceId: "machine-name-test", runtimeKey: "machine-name-test:1", createSocket: () => socket, close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: session.id }), push: () => {}, listen: () => () => {},
  };
  const rightPanel = {
    open: false, mode: "launcher" as const, width: 360, dragging: false, subagentTarget: null,
    toggle() {}, openMode() {}, show() {}, setMode() {}, setWidth() {}, expanded: false, setExpanded() {}, setDragging() {},
    close() {}, selectSubagent() {}, showSubagent() {}, consumeSubagentFocusRequest() {},
  };
  const feedback = {
    confirm: async ({ message }: { message: string }) => { confirmations.push(message); return false; },
    showToast: () => 0,
    dismissToast: () => {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={feedback as never}>
          <StoreProvider connection={connection} navigation={navigation}>
            <div className="topbar"><EditorSelect sessionId={session.id} /></div>
            <SessionDetail sessionId={session.id} mode="expanded" rightPanel={rightPanel}
              onOpenTerminal={() => {}} pinnedSummary={staticPinnedSummary(true)} composerDraftLoader={async () => null} />
          </StoreProvider>
        </FeedbackContext.Provider>
      </ApiProvider>,
    ));
    await act(async () => socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
      runners: [runner], boxes, projects: [project], sessions: [session], runs: [], pods: [],
    } as ControlPlaneToUi));
    await settle();
    await settle();

    const summaryAside = container.querySelector<HTMLElement>('aside.ps[aria-label="Pinned Summary"]');
    assert.ok(summaryAside, "the summary is docked open");
    const row = [...summaryAside.querySelectorAll<HTMLElement>(".ps-row")]
      .find((candidate) => candidate.querySelector(":scope > .k")?.textContent === "Machine");
    assert.ok(row, "a Machine row");

    const openControl = container.querySelector(".editor-select") !== null;
    const offlineNote = container.querySelector(".editor-select [id$='-offline']")?.textContent ?? null;

    let signOut: string | null = null;
    const moreActions = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.getAttribute("aria-label") === "More Actions");
    assert.ok(moreActions, "the session bar renders More Actions");
    await act(async () => { moreActions.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const item = [...page().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((candidate) => candidate.querySelector(".menu-text")?.textContent === "Sign Out of Agent…");
    if (item && !item.disabled) {
      await act(async () => { item.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
      assert.equal(confirmations.length, 1, "Sign Out of Agent asks first");
      signOut = /signs out on (.+), and new sessions/.exec(confirmations[0]!)?.[1] ?? null;
      assert.ok(signOut, `the body names a machine: ${confirmations[0]}`);
    }

    return {
      machineRow: row.querySelector(":scope > .v")?.textContent,
      machineTitle: row.getAttribute("title"),
      signOut,
      openControl,
      offlineNote: offlineNote ? /^(.+) is offline\./.exec(offlineNote)?.[1] ?? offlineNote : null,
    };
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

const box = (over: Partial<BoxView> = {}): BoxView => ({
  boxId: "box-1", sshTarget: "pat@build.example.com:2222", runnerId: RUNNER_ID, status: "online",
  lastError: null, createdAt: 1, ...over,
} as BoxView);

test("a named local machine reads the same in the Machine row, Sign Out of Agent and the offline note", async () => {
  const runner = { ...baseRunner, displayName: "Studio Mac" } as RunnerView;
  const online = await observe(runner, []);
  assert.equal(online.machineRow, "Studio Mac");
  assert.equal(online.signOut, "Studio Mac");
  assert.equal(online.openControl, true);
  assert.equal(online.machineTitle, "Local machine: mac-studio.local", "the hostname stays reachable in the tooltip");
  const offline = await observe({ ...runner, status: "offline" } as RunnerView, []);
  assert.equal(offline.offlineNote, "Studio Mac");
  assert.equal(offline.machineRow, "Studio Mac");
});

test("an unnamed local machine falls back to the same runner id everywhere", async () => {
  const online = await observe(baseRunner, []);
  assert.equal(online.machineRow, RUNNER_ID, "the runner id, not the hostname, as in the bar");
  assert.equal(online.signOut, RUNNER_ID);
  assert.equal(online.machineTitle, "Local machine: mac-studio.local");
  const offline = await observe({ ...baseRunner, status: "offline" } as RunnerView, []);
  assert.equal(offline.offlineNote, RUNNER_ID);
  assert.equal(offline.machineRow, RUNNER_ID);
});

test("a named remote machine reads its name in the Machine row and Sign Out of Agent, its SSH target in the tooltip", async () => {
  const observed = await observe(baseRunner, [box({ displayName: "Build Box" })]);
  assert.equal(observed.machineRow, "Build Box");
  assert.equal(observed.signOut, "Build Box");
  assert.equal(observed.machineTitle, "Remote machine: pat@build.example.com:2222");
  assert.equal(observed.openControl, false, "the Open control is local-only, so it has no note to compare");
});

test("an unnamed remote machine falls back to the same SSH host in the Machine row and Sign Out of Agent", async () => {
  const observed = await observe(baseRunner, [box()]);
  assert.equal(observed.machineRow, "build.example.com");
  assert.equal(observed.signOut, "build.example.com");
  assert.equal(observed.machineTitle, "Remote machine: pat@build.example.com:2222");
});
