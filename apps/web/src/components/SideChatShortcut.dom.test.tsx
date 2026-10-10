import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type GitStatusInfo, type SessionView, type SideChatView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime } from "../ui-transport.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import { matchesShortcut, shortcutDisplay } from "../shortcuts.js";
import { RightPanel, openSideChat, useRightPanelState, type RightPanelState } from "./RightPanel.js";
import type { GitStatus } from "./useGitStatus.js";

/**
 * Ctrl/⌘+; (#2862): the side panel on Side Chat with focus in its message field, from anywhere on the
 * session page. Driven through the real side panel, with the shortcut wired the way App.tsx wires it.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
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
  ResizeObserver: domWindow.ResizeObserver,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(
  Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]),
);

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

const connection: UiConnectionRuntime = {
  instanceId: "side-chat-shortcut-test", runtimeKey: "side-chat-shortcut-test",
  createSocket: () => ({ readyState: UI_SOCKET_OPEN, onopen: null, onmessage: null,
    onclose: null, onerror: null, send() {}, close() {} }),
  close() {},
};

const session = {
  id: "shortcut-session",
  runnerId: "runner-1",
  agentId: "claude",
  title: "Shortcut Fixture",
  status: "idle",
  driver: "claude-code",
  useWorktree: true,
  worktreePath: "/home/me/.agent-worktrees/wollipog-fix",
  workspaceName: "Wollipog",
  eventEpoch: 0,
  adopted: false,
} as SessionView;

const child = { ...session, id: "shortcut-side-chat", title: "Side chat: Shortcut Fixture" } as SessionView;

let related: SideChatView | null;

beforeEach(() => {
  domWindow.localStorage.clear();
  clearPanelScratch();
  related = { parentSessionId: session.id, session: child, createdAt: 1 };
});

const client = {
  ...api,
  sideChat: async () => ({ sideChat: related }),
  getSessionEventPage: async () => ({ events: [], eventEpoch: 0, nextAfter: 0, cacheComplete: true }),
  sessionWorkflowArtifacts: async () => ({ artifacts: [] }),
} as unknown as ApiClient;

function gitStatus(): GitStatus {
  return {
    status: { branch: "fix", files: [], hasChanges: false, ahead: 0, remoteUrl: null } as unknown as GitStatusInfo,
    observation: 1,
    observedAt: 1,
    settled: true,
    busy: false,
    error: null,
    errorCode: null,
    refresh: async () => {},
    refreshStatusOnly: async () => {},
    install: () => {},
    mutationRevision: 0,
  };
}

function Harness({ onState }: { onState: (state: RightPanelState) => void }) {
  const state = useRightPanelState();
  onState(state);
  // The shortcut as App.tsx registers it: on the window, for the session view.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchesShortcut(event, "open-side-chat")) return;
      event.preventDefault();
      openSideChat(state);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <ApiProvider client={client}><StoreProvider connection={connection}>
      {/* Something on the session page that is not the panel: the main composer stands in. */}
      <textarea aria-label="Message" />
      <RightPanel
        state={state}
        session={session}
        runnerOnline
        runnerProtocolVersion={PROTOCOL_VERSION}
        git={gitStatus()}
        items={[]}
        onOpenSourceLocation={() => {}}
        onClearSourceLocation={() => {}}
        onOpenTerminal={() => {}}
        onInsertSideChatDraft={() => {}}
      />
    </StoreProvider></ApiProvider>
  );
}

async function mount() {
  const host = domWindow.document.createElement("div");
  domWindow.document.body.append(host);
  const container = host as unknown as HTMLElement;
  const root = createRoot(container as unknown as Element);
  let state!: RightPanelState;
  await act(async () => root.render(<Harness onState={(next) => { state = next; }} />));
  return {
    container,
    get state() { return state; },
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Lets the side chat load and focus effects land. */
async function settle(ms = 25): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

/** Ctrl+;, from whatever has focus, as the browser delivers it. */
async function pressSideChat(): Promise<void> {
  const target = (document.activeElement ?? document.body) as unknown as Element;
  await act(async () => fireDomEvent.keyDown(target, { key: ";", ctrlKey: true }));
  await settle();
}

const focused = (element: Element | null) =>
  element !== null && (document.activeElement as unknown as Element | null) === element;

test("Ctrl+; opens the panel on Side Chat with focus in its message field, and pressing it again keeps both", async () => {
  const mounted = await mount();
  const message = () => mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Side Chat Message"]');
  try {
    assertNoDomNode(mounted.container.querySelector(".rpanel"), "the panel starts closed");
    // From the main composer: the shortcut is not blocked by a text field.
    await act(async () => mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!.focus());
    await pressSideChat();
    assert.equal(mounted.state.open, true);
    assert.equal(mounted.state.mode, "sidechat");
    assert.ok(focused(message()), "focus is in the side chat's message field");

    await pressSideChat();
    assert.equal(mounted.state.open, true, "a second press never closes the panel");
    assert.equal(mounted.state.mode, "sidechat");
    assert.ok(focused(message()));

    // From another tool it switches to Side Chat rather than closing.
    await act(async () => mounted.state.setMode("browser"));
    await settle();
    await pressSideChat();
    assert.equal(mounted.state.mode, "sidechat");
    assert.ok(focused(message()));
  } finally {
    await mounted.dispose();
  }
});

test("Ctrl+; with no side chat yet lands on Start Side Chat", async () => {
  related = null;
  const mounted = await mount();
  try {
    await pressSideChat();
    const start = [...mounted.container.querySelectorAll("button")].find((button) => button.textContent === "Start Side Chat");
    assert.ok(focused(start ?? null));
  } finally {
    await mounted.dispose();
  }
});

test("Session Tools shows Side Chat's keycap", async () => {
  const mounted = await mount();
  try {
    await act(async () => mounted.state.show("launcher"));
    await settle();
    const row = mounted.container.querySelector<HTMLElement>('.session-tools [data-tool="sidechat"]');
    assert.equal(row?.querySelector("kbd")?.textContent, shortcutDisplay("open-side-chat"));
  } finally {
    await mounted.dispose();
  }
});
