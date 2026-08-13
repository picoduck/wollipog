import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { RunnerView, SessionView, UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { EditorSelect } from "./EditorSelect.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status: "online",
  agents: [],
  workspaces: [],
  editors: [
    { id: "code", name: "VS Code" },
    { id: "cursor", name: "Cursor" },
  ],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 75,
};

const session: SessionView = {
  id: "session-1",
  runnerId: runner.runnerId,
  workspaceId: null,
  workspaceName: null,
  projectId: null,
  agentId: "codex",
  agentName: "Codex",
  title: "Editor Selection Fixture",
  status: "idle",
  column: "review",
  runId: null,
  useWorktree: false,
  worktreePath: null,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  lastEventAt: null,
  messageCount: 0,
  eventEpoch: 0,
  preview: null,
  pendingApproval: null,
  driver: "codex-app-server",
  model: null,
  effort: null,
  permissionMode: null,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  adopted: false,
};

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const navigation: ViewNavigation = {
  current: () => ({ name: "inbox" }),
  push() {},
  listen: () => () => {},
};

function EditorWhenReady() {
  const ready = useStoreSelector((state) => state.snapshotLoaded);
  return ready ? <EditorSelect sessionId={session.id} /> : null;
}

function snapshot(): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: true,
    },
    runners: [runner],
    boxes: [],
    projects: [],
    sessions: [session],
    runs: [],
    pods: [],
  };
}

test("choosing an editor persists selection without launching and the main button launches once", async () => {
  domWindow.localStorage.clear();
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "editor-select",
    runtimeKey: "editor-select:1",
    createSocket: () => socket,
    close() {},
  };
  const calls: Array<{
    sessionId: string;
    action: Parameters<ApiClient["hostAction"]>[1];
  }> = [];
  let settleLaunch!: () => void;
  const launchSettlement = new Promise<void>((resolve) => { settleLaunch = resolve; });
  const client = {
    ...api,
    hostAction: async (sessionId: string, action: Parameters<ApiClient["hostAction"]>[1]) => {
      calls.push({ sessionId, action: structuredClone(action) });
      await launchSettlement;
      return { ok: true as const };
    },
  } as ApiClient;

  try {
    await act(async () => {
      root.render(
        <ApiProvider client={client}>
          <StoreProvider connection={connection} navigation={navigation}>
            <EditorWhenReady />
          </StoreProvider>
        </ApiProvider>,
      );
    });
    await act(async () => { socket.push(snapshot()); });

    const choose = container.querySelector<HTMLButtonElement>('button[aria-label="Choose Editor"]');
    const defaultMain = container.querySelector<HTMLButtonElement>('button[aria-label="Open in VS Code"]');
    assert.ok(choose);
    assert.ok(defaultMain);

    await act(async () => { choose.click(); });
    const cursor = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find((item) => item.textContent?.includes("Cursor"));
    assert.ok(cursor);

    await act(async () => { cursor.click(); });
    await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 0)); });

    assert.deepEqual(calls, [], "menu selection must never invoke a host action");
    assert.equal(domWindow.localStorage.getItem("wollipog.editor.lastUsed"), "cursor");
    assert.equal(container.querySelector('[role="menu"]'), null, "selection closes the menu");
    assert.equal(domWindow.document.activeElement, choose, "selection restores focus to the picker");

    act(() => { choose.click(); });
    const editorChoices = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    const selectedCursor = editorChoices.find((item) => item.textContent?.includes("Cursor"));
    const unselectedCode = editorChoices.find((item) => item.textContent?.includes("VS Code"));
    assert.ok(selectedCursor);
    assert.ok(unselectedCode);
    assert.equal(selectedCursor.getAttribute("aria-checked"), "true");
    assert.equal(unselectedCode.getAttribute("aria-checked"), "false");
    assert.equal(selectedCursor.getAttribute("aria-label"), null, "the hidden checkmark does not alter the name");
    assert.equal(domWindow.document.activeElement, selectedCursor, "reopening focuses the current editor");
    await act(async () => { selectedCursor.click(); });
    await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 0)); });

    const selectedMain = container.querySelector<HTMLButtonElement>('button[aria-label="Open in Cursor"]');
    assert.ok(selectedMain, "the primary action immediately reflects the selected editor");
    assert.equal(domWindow.document.activeElement, choose, "selection leaves focus on the picker");
    act(() => {
      selectedMain.click();
    });

    assert.deepEqual(calls, [{
      sessionId: session.id,
      action: { kind: "open_editor", editorId: "cursor" },
    }]);
    assert.equal(selectedMain.disabled, false, "the pending launch remains keyboard-focusable");
    assert.equal(selectedMain.getAttribute("aria-disabled"), "true");
    assert.equal(choose.disabled, false, "selection remains available during an unrelated launch");
    assert.equal(domWindow.document.activeElement, choose, "launch does not evict picker focus");
    act(() => { selectedMain.click(); });
    assert.equal(calls.length, 1, "repeat activation during launch remains a no-op");
    assert.equal(container.querySelector('[role="status"]')?.textContent, "An editor launch is already in progress.");

    await act(async () => {
      settleLaunch();
      await Promise.resolve();
    });

    assert.equal(selectedMain.getAttribute("aria-disabled"), "false");
    assert.equal(container.querySelector('[role="status"]'), null, "the suppression note clears when launch settles");
    assert.equal(domWindow.document.activeElement, choose, "explicit launch retains the existing focus owner");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
