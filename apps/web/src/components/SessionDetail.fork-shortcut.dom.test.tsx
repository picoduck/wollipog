import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, RunnerView, SessionEvent, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { SessionDetail } from "./SessionDetail.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

/**
 * #2272: on the session page, bare F runs More Actions' Fork Conversation… — the latest-turn fork
 * and its confirmation — under the same guards as the page's other bare keys, and only while the
 * item is offered and enabled.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 72, width: 1200, height: 72, toJSON: () => ({}) }),
});
for (const [name, value] of [["clientHeight", 1_200], ["offsetHeight", 72]] as const) {
  Object.defineProperty(domWindow.HTMLElement.prototype, name, { configurable: true, get: () => value });
}
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
// A desktop browser: a fine pointer at a desktop width, where Session Reading is live.
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: query === "(pointer: fine)", media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }),
});

const runner = {
  runnerId: "runner-1", hostname: "runner-host", os: "linux", version: "1", status: "online",
  agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true }],
  workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 999,
} as unknown as RunnerView;

const FORKABLE: Partial<SessionView> = { useWorktree: true, worktreePath: "/tmp/fork-shortcut-worktree" };

/** One finished turn with a provider checkpoint, so turn 1 is the latest forkable turn. */
const FINISHED_TURN: SessionEvent["payload"][] = [
  { kind: "user_message", text: "Plan the change", images: [] },
  { kind: "agent_message", text: "Planned.", final: true },
  { kind: "conversation_checkpoint", turn: 1 },
];

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

function EventSeeder({ sessionId, payloads }: { sessionId: string; payloads: SessionEvent["payload"][] }) {
  const ready = useStoreSelector((state) => state.sessions.has(sessionId));
  const { dispatch } = useStoreActions();
  React.useEffect(() => {
    if (!ready) return;
    payloads.forEach((payload, index) => {
      dispatch({ type: "msg", msg: { type: "session_event", event: { id: index + 1, sessionId, seq: index + 1, ts: index + 1, payload } } });
    });
  }, [dispatch, payloads, ready, sessionId]);
  return null;
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

/** Menus and dialogs are portalled to <body>, so queries look there. */
function page(): HTMLElement {
  return domWindow.document.body as unknown as HTMLElement;
}

interface Confirmation { title: string; message: string }

let sequence = 0;

async function mountSession(patch: Partial<SessionView>, options: { accept?: boolean } = {}) {
  sequence += 1;
  const session = {
    id: `fork-shortcut-${sequence}`, runnerId: runner.runnerId, workspaceId: null, workspaceName: null, projectId: null,
    agentId: "codex", agentName: "Codex", title: "Fork Shortcut", status: "idle", column: "review", runId: null,
    useWorktree: false, worktreePath: null, archived: false, createdAt: 1, updatedAt: 1, lastEventAt: null,
    messageCount: 0, eventEpoch: 0, preview: null, pendingApproval: null, driver: "codex-app-server", model: null,
    effort: null, permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
    ...patch,
  } as SessionView;
  const socket = new FakeSocket();
  const confirmations: Confirmation[] = [];
  const forks: number[] = [];
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: () => new Promise<never>(() => {}),
    getSessionEventTailPage: () => new Promise<never>(() => {}),
    git: () => new Promise<never>(() => {}),
    gitSummary: () => new Promise<never>(() => {}),
    runnerSkills: async () => ({ desired: [], reported: null }),
    // The fork stays in flight, so the page stays busy with it.
    fork: (_sessionId: string, turn: number) => { forks.push(turn); return new Promise<never>(() => {}); },
  } as unknown as ApiClient;
  const connection: UiConnectionRuntime = {
    instanceId: `fork-shortcut-${sequence}`, runtimeKey: `fork-shortcut-${sequence}:1`, createSocket: () => socket, close() {},
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
    confirm: async ({ title, message }: Confirmation) => { confirmations.push({ title, message }); return options.accept ?? false; },
    showToast: () => 0,
    showUndo: () => 0,
    dismissToast: () => {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <ApiProvider client={client}>
      <FeedbackContext.Provider value={feedback as never}>
        <StoreProvider connection={connection} navigation={navigation}>
          <EventSeeder sessionId={session.id} payloads={FINISHED_TURN} />
          <SessionDetail sessionId={session.id} mode="expanded" rightPanel={rightPanel}
            onOpenTerminal={() => {}} composerDraftLoader={async () => null} />
        </StoreProvider>
      </FeedbackContext.Provider>
    </ApiProvider>,
  ));
  await act(async () => socket.push({
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [runner], boxes: [], projects: [], sessions: [session], runs: [], pods: [],
  } as ControlPlaneToUi));
  await settle();
  await settle();

  const transcript = container.querySelector<HTMLElement>(".detail-scroll");
  assert.ok(transcript, "the transcript reader is mounted");
  return {
    container,
    transcript,
    confirmations,
    forks,
    /** Presses F where focus is now, as a keyboard would. */
    press: async (key = "f") => {
      await act(async () => {
        const target = domWindow.document.activeElement ?? domWindow.document.body;
        target.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();
    },
    /** More Actions' Fork Conversation…, or undefined when the menu does not offer it. */
    openMoreActions: async () => {
      const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="More Actions"]');
      assert.ok(trigger, "the session bar renders More Actions");
      await act(async () => { trigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
      const menu = page().querySelector<HTMLElement>('[role="menu"][aria-label="More Actions"]');
      assert.ok(menu, "More Actions is open");
      const item = (label: string) => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((candidate) => candidate.querySelector(".menu-text")?.textContent === label);
      return { menu, item };
    },
    /** Escape from inside the menu, as a person would, so an open menu cannot mask what F does. */
    closeMoreActions: async () => {
      const menu = page().querySelector<HTMLElement>('[role="menu"][aria-label="More Actions"]');
      assert.ok(menu, "More Actions is open");
      const target = menu.contains(domWindow.document.activeElement as never)
        ? domWindow.document.activeElement!
        : menu.querySelector('[role="menuitem"]') ?? menu;
      await act(async () => {
        target.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as never);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();
      assertNoDomNode(page().querySelector('[role="menu"]'), "no menu remains open");
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
      domWindow.document.body.innerHTML = "";
    },
  };
}

test("F on the transcript opens the same fork confirmation as More Actions' Fork Conversation…", async () => {
  const view = await mountSession(FORKABLE);
  try {
    const { item } = await view.openMoreActions();
    const fork = item("Fork Conversation…");
    assert.ok(fork, "the session offers Fork Conversation…");
    assert.equal(fork.disabled, false);
    assert.equal(fork.querySelector(".menu-trail kbd")?.textContent, "F", "the item teaches its key");
    await act(async () => { fork.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await settle();
    assert.equal(view.confirmations.length, 1, "the menu item asks first");

    view.transcript.focus();
    await view.press();
    assert.equal(view.confirmations.length, 2, "F asks too");
    assert.deepEqual(view.confirmations[1], view.confirmations[0], "with the same confirmation");
    assert.equal(view.confirmations[1]!.title, "Fork Conversation");
    assert.match(view.confirmations[1]!.message, /from after Turn 1 in its own worktree/);
    assert.deepEqual(view.forks, [], "declining the confirmation forks nothing");
  } finally {
    await view.unmount();
  }
});

test("F does nothing from the composer, an open menu or an open dialog", async () => {
  const view = await mountSession(FORKABLE);
  try {
    const composer = view.container.querySelector<HTMLTextAreaElement>(".composer-input");
    assert.ok(composer, "the composer is mounted");
    composer.focus();
    await view.press();
    assert.deepEqual(view.confirmations, [], "the composer");

    view.transcript.focus();
    const { item } = await view.openMoreActions();
    await view.press();
    assert.deepEqual(view.confirmations, [], "an open menu");
    // The open menu owns the key even with the reader focused under it.
    view.transcript.focus();
    assert.ok(page().querySelector('[role="menu"][aria-label="More Actions"]'), "the menu is still open");
    await view.press();
    assert.deepEqual(view.confirmations, [], "an open menu over the focused reader");

    const rename = item("Rename…");
    assert.ok(rename, "Rename… opens a dialog");
    await act(async () => { rename.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await settle();
    assert.ok(page().querySelector('[role="dialog"][aria-modal="true"]'), "the Rename dialog is open");
    await view.press();
    view.transcript.focus();
    await view.press();
    assert.deepEqual(view.confirmations, [], "an open dialog");
  } finally {
    await view.unmount();
  }
});

test("F does nothing while Fork Conversation… is disabled: a fork in flight, or a turn still running", async () => {
  const busy = await mountSession(FORKABLE, { accept: true });
  try {
    busy.transcript.focus();
    await busy.press();
    assert.equal(busy.confirmations.length, 1);
    assert.deepEqual(busy.forks, [1], "accepting starts the fork, which stays in flight");
    const { item } = await busy.openMoreActions();
    assert.equal(item("Fork Conversation…")?.disabled, true, "the item is disabled while the fork runs");
    await busy.closeMoreActions();
    busy.transcript.focus();
    await busy.press();
    assert.equal(busy.confirmations.length, 1, "F does not ask again");
    assert.deepEqual(busy.forks, [1]);
  } finally {
    await busy.unmount();
  }

  const running = await mountSession({ ...FORKABLE, status: "running" });
  try {
    const { item } = await running.openMoreActions();
    const fork = item("Fork Conversation…");
    assert.equal(fork?.disabled, true);
    assert.match(fork?.textContent ?? "", /Wait for the current turn or approval before creating a fork\./);
    await running.closeMoreActions();
    running.transcript.focus();
    await running.press();
    assert.deepEqual(running.confirmations, []);
  } finally {
    await running.unmount();
  }
});

test("F does nothing for a session that can never fork, where More Actions offers no Fork Conversation…", async () => {
  const view = await mountSession({ useWorktree: false, worktreePath: null });
  try {
    const { item } = await view.openMoreActions();
    assert.equal(item("Fork Conversation…"), undefined);
    assert.ok(item("Rename…"), "the menu is otherwise populated");
    await view.closeMoreActions();
    view.transcript.focus();
    await view.press();
    assert.deepEqual(view.confirmations, []);
  } finally {
    await view.unmount();
  }
});
