import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { BoxView, RunnerView, SessionView, UiSnapshotMessage } from "@wollipog/protocol";
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
    { id: "constructor", name: "future editor" },
    { id: "idea", name: "IntelliJ IDEA" },
    { id: "webstorm", name: "WebStorm" },
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

function snapshot(runnerView: RunnerView = runner, boxes: BoxView[] = []): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: true,
    },
    runners: [runnerView],
    boxes,
    projects: [],
    sessions: [session],
    runs: [],
    pods: [],
  };
}

async function mountEditor(client: ApiClient, runnerView: RunnerView = runner, boxes: BoxView[] = []) {
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
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <EditorWhenReady />
        </StoreProvider>
      </ApiProvider>,
    );
  });
  await act(async () => { socket.push(snapshot(runnerView, boxes)); });
  return {
    container,
    async pushRunner(nextRunner: RunnerView, nextBoxes: BoxView[] = []) {
      await act(async () => { socket.push(snapshot(nextRunner, nextBoxes)); });
    },
    async cleanup() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("destination menu launches immediately, persists the primary action, and restores keyboard focus", async () => {
  const calls: Array<{ sessionId: string; action: Parameters<ApiClient["hostAction"]>[1] }> = [];
  const client = {
    ...api,
    hostAction: async (sessionId: string, action: Parameters<ApiClient["hostAction"]>[1]) => {
      calls.push({ sessionId, action: structuredClone(action) });
      return { ok: true as const };
    },
  } as ApiClient;
  const mounted = await mountEditor(client);
  const { container } = mounted;
  try {
    const choose = container.querySelector<HTMLButtonElement>('button[aria-label="Choose Destination"]');
    const defaultMain = container.querySelector<HTMLButtonElement>('button[aria-label="Open in VS Code"]');
    assert.ok(choose);
    assert.ok(defaultMain);
    assert.equal(defaultMain.textContent?.trim(), "Open", "the primary action has a visible label");

    await act(async () => { choose.click(); });
    const choices = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    assert.deepEqual(choices.map((item) => item.textContent?.replace("✓", "").trim()), [
      "VS Code", "Cursor", "Future Editor", "IntelliJ IDEA", "WebStorm", "File Manager",
    ]);
    assert.ok(choices[0]?.querySelector('[data-destination-icon="code"]'), "known editors receive their recognizable icon");
    assert.ok(choices[2]?.querySelector('[data-destination-icon="generic-editor"]'), "unknown editors remain visible with a fallback icon");
    assert.ok(choices[5]?.querySelector('[data-destination-icon="file-manager"]'));

    const cursor = choices.find((item) => item.textContent?.includes("Cursor"));
    assert.ok(cursor);
    await act(async () => { cursor.click(); });
    await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 0)); });

    assert.deepEqual(calls, [{
      sessionId: session.id,
      action: { kind: "open_editor", editorId: "cursor" },
    }], "choosing a destination launches it immediately");
    assert.equal(domWindow.localStorage.getItem("wollipog.editor.lastUsed"), "cursor");
    assert.equal(domWindow.localStorage.getItem("wollipog.openDestination.lastUsed"), "editor:cursor");
    assert.equal(container.querySelector('[role="menu"]'), null, "selection closes the menu");
    assert.equal(domWindow.document.activeElement, choose, "selection restores focus to the picker");

    const selectedMain = container.querySelector<HTMLButtonElement>('button[aria-label="Open in Cursor"]');
    assert.ok(selectedMain, "the primary action immediately reflects the launched editor");
    await act(async () => { selectedMain.click(); });
    assert.deepEqual(calls.at(-1), {
      sessionId: session.id,
      action: { kind: "open_editor", editorId: "cursor" },
    });

    await act(async () => {
      choose.focus();
      choose.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event);
    });
    const editorChoices = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    const selectedCursor = editorChoices.find((item) => item.textContent?.includes("Cursor"));
    const unselectedCode = editorChoices.find((item) => item.textContent?.includes("VS Code"));
    assert.ok(selectedCursor);
    assert.ok(unselectedCode);
    assert.equal(selectedCursor.getAttribute("aria-checked"), "true");
    assert.equal(unselectedCode.getAttribute("aria-checked"), "false");
    assert.equal(selectedCursor.getAttribute("aria-label"), null, "the hidden checkmark does not alter the name");
    assert.equal(domWindow.document.activeElement, selectedCursor, "reopening focuses the current editor");
    await act(async () => {
      selectedCursor.dispatchEvent(
        new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event,
      );
    });
    await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 0)); });
    assert.equal(container.querySelector('[role="menu"]'), null);
    assert.equal(domWindow.document.activeElement, choose, "Escape restores focus to the chevron");
  } finally {
    await mounted.cleanup();
  }
});

test("file-manager choices use the fixed session-scoped reveal action and OS-appropriate names", async () => {
  const calls: Parameters<ApiClient["hostAction"]>[1][] = [];
  const client = {
    ...api,
    hostAction: async (_sessionId: string, action: Parameters<ApiClient["hostAction"]>[1]) => {
      calls.push(structuredClone(action));
      return { ok: true as const };
    },
  } as ApiClient;
  const mounted = await mountEditor(client, { ...runner, os: "windows" });
  const { container } = mounted;
  try {
    const choose = container.querySelector<HTMLButtonElement>('button[aria-label="Choose Destination"]');
    assert.ok(choose);
    await act(async () => { choose.click(); });
    const explorer = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find((item) => item.textContent?.includes("Explorer"));
    assert.ok(explorer);
    await act(async () => { explorer.click(); });
    assert.deepEqual(calls, [{ kind: "reveal" }]);
    assert.equal(domWindow.localStorage.getItem("wollipog.openDestination.lastUsed"), "reveal");
    const main = container.querySelector<HTMLButtonElement>('button[aria-label="Open in Explorer"]');
    assert.ok(main);
    await act(async () => { main.click(); });
    assert.deepEqual(calls, [{ kind: "reveal" }, { kind: "reveal" }]);
  } finally {
    await mounted.cleanup();
  }
});

test("busy launches stay focusable, suppress duplicates, and expose failure feedback", async () => {
  const calls: Parameters<ApiClient["hostAction"]>[1][] = [];
  let settleLaunch!: (reason?: Error) => void;
  const launchSettlement = new Promise<void>((resolve, reject) => {
    settleLaunch = (reason) => reason ? reject(reason) : resolve();
  });
  const client = {
    ...api,
    hostAction: async (_sessionId: string, action: Parameters<ApiClient["hostAction"]>[1]) => {
      calls.push(structuredClone(action));
      await launchSettlement;
      return { ok: true as const };
    },
  } as ApiClient;
  const mounted = await mountEditor(client);
  const { container } = mounted;
  try {
    const main = container.querySelector<HTMLButtonElement>('button[aria-label="Open in VS Code"]');
    const choose = container.querySelector<HTMLButtonElement>('button[aria-label="Choose Destination"]');
    assert.ok(main);
    assert.ok(choose);
    act(() => { main.click(); });
    assert.equal(main.disabled, false, "the pending launch remains keyboard-focusable");
    assert.equal(main.getAttribute("aria-disabled"), "true");
    assert.equal(choose.disabled, false, "the pending trigger remains keyboard-focusable");
    assert.equal(choose.getAttribute("aria-disabled"), "true");
    act(() => { main.click(); });
    assert.equal(calls.length, 1);
    assert.equal(container.querySelector('[role="status"]')?.textContent, "A destination launch is already in progress.");
    act(() => { choose.click(); });
    assert.equal(container.querySelector('[role="menu"]'), null, "the menu cannot start another launch while busy");

    await act(async () => {
      settleLaunch(new Error("Editor process failed to start."));
      await launchSettlement.catch(() => undefined);
    });
    assert.equal(main.getAttribute("aria-disabled"), "false");
    assert.equal(container.querySelector('[role="status"]')?.textContent, "Editor process failed to start.");
  } finally {
    await mounted.cleanup();
  }
});

test("offline runners remain understandable while remote and unsupported runners expose no host action", async () => {
  const client = { ...api, hostAction: async () => ({ ok: true as const }) } as ApiClient;

  const offline = await mountEditor(client, { ...runner, status: "offline" });
  try {
    const main = offline.container.querySelector<HTMLButtonElement>('button[aria-label="Open Unavailable: Runner Offline"]');
    const choose = offline.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Choose Destination Unavailable: Runner Offline"]',
    );
    assert.ok(main);
    assert.ok(choose);
    assert.equal(main.textContent?.trim(), "Open");
    assert.equal(main.getAttribute("aria-disabled"), "true");
    await act(async () => { main.click(); });
    assert.equal(offline.container.querySelector('[role="status"]')?.textContent, "Runner is offline.");
    await offline.pushRunner({ ...runner, status: "online" });
    assert.equal(offline.container.querySelector('[role="status"]'), null, "reconnecting clears stale offline feedback");

    const reopenedChoose = offline.container.querySelector<HTMLButtonElement>('button[aria-label="Choose Destination"]');
    assert.ok(reopenedChoose);
    await act(async () => { reopenedChoose.click(); });
    await offline.pushRunner({ ...runner, status: "offline" });
    const cursor = [...offline.container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find((item) => item.textContent?.includes("Cursor"));
    assert.ok(cursor);
    await act(async () => { cursor.click(); });
    assert.equal(offline.container.querySelector('[role="menu"]'), null, "an offline transition closes the stale menu");
    assert.equal(offline.container.querySelector('[role="status"]')?.textContent, "Runner is offline.");
  } finally {
    await offline.cleanup();
  }

  const unsupported = await mountEditor(client, { ...runner, protocolVersion: 21 });
  try {
    assert.equal(unsupported.container.querySelector(".editor-select"), null);
  } finally {
    await unsupported.cleanup();
  }

  const remote = await mountEditor(client, runner, [{
    boxId: "box-1",
    sshTarget: "user@example.test",
    runnerId: runner.runnerId,
    status: "online",
    lastError: null,
    createdAt: 1,
  }]);
  try {
    assert.equal(remote.container.querySelector(".editor-select"), null);
  } finally {
    await remote.cleanup();
  }

  const revealOnly = await mountEditor(client, { ...runner, editors: [] });
  try {
    assert.ok(revealOnly.container.querySelector('button[aria-label="Open in File Manager"]'));
  } finally {
    await revealOnly.cleanup();
  }
});
