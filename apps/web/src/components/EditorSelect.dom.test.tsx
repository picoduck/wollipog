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
import {
  CHOOSE_DESTINATION_LABEL,
  EditorSelect,
  offlineDestinationNote,
  openDestinationLabel,
} from "./EditorSelect.js";
import { FeedbackContext, type ToastOptions } from "./FeedbackProvider.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
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
    { id: "windsurf", name: "Windsurf" },
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

type RecordedToast = { message: string; options?: ToastOptions };

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
  const toasts: RecordedToast[] = [];
  const feedback = {
    confirm: async () => false,
    showToast: (message: string, options?: ToastOptions) => toasts.push({ message, options }),
    showUndo: () => -1,
    dismissToast: () => undefined,
  };
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={feedback}>
          <StoreProvider connection={connection} navigation={navigation}>
            <EditorWhenReady />
          </StoreProvider>
        </FeedbackContext.Provider>
      </ApiProvider>,
    );
  });
  await act(async () => { socket.push(snapshot(runnerView, boxes)); });
  return {
    container,
    toasts,
    async pushRunner(nextRunner: RunnerView, nextBoxes: BoxView[] = []) {
      await act(async () => { socket.push(snapshot(nextRunner, nextBoxes)); });
    },
    async cleanup() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

const doc = () => domWindow.document as unknown as Document;
const menuRadios = () => [...doc().querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];

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
    const choose = container.querySelector<HTMLButtonElement>(`button[aria-label="${CHOOSE_DESTINATION_LABEL}"]`);
    const defaultMain = container.querySelector<HTMLButtonElement>('button[aria-label="Open in VS Code"]');
    assert.ok(choose);
    assert.ok(defaultMain);
    assert.equal(CHOOSE_DESTINATION_LABEL, "Choose Where to Open");
    assert.equal(defaultMain.textContent?.trim(), "Open", "the primary action has a visible label");
    assert.equal(defaultMain.title, "Open in VS Code", "the tooltip repeats the name");
    assert.equal(choose.title, "Choose Where to Open");
    assert.ok(defaultMain.classList.contains("ghost") && choose.classList.contains("ghost"), "both segments are quiet");
    assert.ok(container.querySelector(".editor-select.split"));

    await act(async () => { choose.click(); });
    const menu = doc().querySelector<HTMLElement>('[role="menu"]');
    assert.equal(menu?.getAttribute("aria-label"), "Open In");
    assert.equal(menu?.querySelector(".menu-label")?.textContent, "Open In", "the menu has a Title Case label");
    const choices = menuRadios();
    assert.deepEqual(choices.map((item) => item.textContent?.trim()), [
      "VS Code", "Cursor", "Devin Desktop", "Future Editor", "IntelliJ IDEA", "WebStorm", "File Manager",
    ]);
    const separator = menu?.querySelector('[role="separator"]');
    assert.ok(separator, "File Manager follows a separator");
    assert.equal(separator?.nextElementSibling, choices.at(-1));
    assert.equal(choices[0]?.getAttribute("aria-checked"), "true", "the remembered destination is checked");
    assert.ok(choices[0]?.querySelector(".menu-check"), "with a trailing check");
    assert.ok(choices[0]?.querySelector('[data-destination-icon="code"]'), "known editors receive their recognizable icon");
    assert.ok(choices[2]?.querySelector('[data-destination-icon="windsurf"]'),
      "legacy runner metadata is rebranded without changing the integration id");
    assert.ok(choices[3]?.querySelector('[data-destination-icon="generic-editor"]'), "unknown editors remain visible with a fallback icon");
    assert.ok(choices[6]?.querySelector('[data-destination-icon="file-manager"]'));
    assertNoDomNode(menu?.querySelector(".menu-note") ?? null, "an online machine needs no note");

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
    assertNoDomNode(doc().querySelector('[role="menu"]'), "selection closes the menu");
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
    const editorChoices = menuRadios();
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
    assertNoDomNode(doc().querySelector('[role="menu"]'));
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
    const choose = container.querySelector<HTMLButtonElement>(`button[aria-label="${CHOOSE_DESTINATION_LABEL}"]`);
    assert.ok(choose);
    await act(async () => { choose.click(); });
    const explorer = menuRadios().find((item) => item.textContent?.includes("Explorer"));
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

test("a busy launch stays focusable and suppresses duplicates, and a failure is an error toast", async () => {
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
    const choose = container.querySelector<HTMLButtonElement>(`button[aria-label="${CHOOSE_DESTINATION_LABEL}"]`);
    assert.ok(main);
    assert.ok(choose);
    act(() => { main.click(); });
    assert.equal(main.disabled, false, "the pending launch remains keyboard-focusable");
    assert.equal(main.getAttribute("aria-disabled"), "true");
    assert.equal(choose.disabled, false, "the pending trigger remains keyboard-focusable");
    assert.equal(choose.getAttribute("aria-disabled"), "true");
    act(() => { main.click(); });
    assert.equal(calls.length, 1);
    act(() => { choose.click(); });
    assertNoDomNode(doc().querySelector('[role="menu"]'), "the menu cannot start another launch while busy");

    await act(async () => {
      settleLaunch(new Error("Editor process failed to start."));
      await launchSettlement.catch(() => undefined);
    });
    assert.equal(main.getAttribute("aria-disabled"), "false");
    assert.deepEqual(mounted.toasts, [{
      message: "Couldn't open the folder in VS Code.",
      options: { tone: "error", detail: "Editor process failed to start." },
    }]);
    assertNoDomNode(container.querySelector('[role="status"]'), "no floating note under the button");
    assertNoDomNode(container.querySelector(".editor-note"));
  } finally {
    await mounted.cleanup();
  }
});

test("offline, Open is disabled and described by the menu's note, and the menu still opens on it (#2164)", async () => {
  const calls: Parameters<ApiClient["hostAction"]>[1][] = [];
  const client = {
    ...api,
    hostAction: async (_sessionId: string, action: Parameters<ApiClient["hostAction"]>[1]) => {
      calls.push(structuredClone(action));
      return { ok: true as const };
    },
  } as ApiClient;
  const offlineRunner: RunnerView = { ...runner, displayName: "Build Machine", status: "offline" };
  const note = "Build Machine is offline. You can open the folder again when it reconnects.";
  assert.equal(offlineDestinationNote("Build Machine"), note);
  const offline = await mountEditor(client, offlineRunner);
  try {
    const main = offline.container.querySelector<HTMLButtonElement>('button[aria-label="Open in VS Code"]');
    const choose = offline.container.querySelector<HTMLButtonElement>(`button[aria-label="${CHOOSE_DESTINATION_LABEL}"]`);
    assert.ok(main, "Open keeps its name offline");
    assert.ok(choose, "the caret keeps its name offline");
    assert.equal(main.textContent?.trim(), "Open");
    assert.equal(main.getAttribute("aria-disabled"), "true");
    assert.equal(choose.getAttribute("aria-disabled"), "false", "the caret still opens the menu");
    const describedBy = main.getAttribute("aria-describedby");
    assert.ok(describedBy);
    assert.equal(doc().getElementById(describedBy)?.textContent, note, "closed, the description is the note's text");
    assert.equal(main.title, "Open in VS Code", "the tooltip names the action, not a reason");
    assertNoDomNode(doc().querySelector('[title="Runner is offline."]'));
    await act(async () => { main.click(); });
    assert.deepEqual(calls, [], "a disabled Open launches nothing");
    assertNoDomNode(offline.container.querySelector('[role="status"]'));

    await act(async () => { choose.click(); });
    const menu = doc().querySelector<HTMLElement>('[role="menu"]');
    assert.ok(menu);
    const menuNote = menu.querySelector<HTMLElement>(".menu-note");
    assert.equal(menuNote?.textContent, note);
    assert.equal(menuNote?.id, describedBy, "Open points at the menu's note");
    assert.equal(doc().querySelectorAll(`[id="${describedBy}"]`).length, 1, "one note, never two with one id");
    const choices = menuRadios();
    assert.equal(choices.length, 7);
    assert.ok(choices.every((item) => item.getAttribute("aria-disabled") === "true"), "no enabled destination");
    assert.equal(domWindow.document.activeElement, menu, "with nothing to choose, the menu itself takes focus");
    await act(async () => { choices[1]!.click(); });
    assert.deepEqual(calls, []);
    assert.ok(doc().querySelector('[role="menu"]'), "a disabled destination leaves the menu open on its note");
    await act(async () => {
      menu.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
    });
    assertNoDomNode(doc().querySelector('[role="menu"]'), "Escape closes it");

    await offline.pushRunner({ ...offlineRunner, status: "online" });
    assert.equal(main.getAttribute("aria-disabled"), "false", "reconnecting enables Open");
    assert.equal(main.getAttribute("aria-describedby"), null);
    await act(async () => { choose.click(); });
    assert.ok(menuRadios().every((item) => item.getAttribute("aria-disabled") === null));
    assertNoDomNode(doc().querySelector(".menu-note"));

    // A destination that has focus when the machine drops keeps it, and the note appears.
    const focused = menuRadios()[0]!;
    focused.focus();
    await offline.pushRunner(offlineRunner);
    assert.equal(domWindow.document.activeElement, focused);
    assert.equal(focused.getAttribute("aria-disabled"), "true");
    assert.equal(doc().querySelector(".menu-note")?.textContent, note);
  } finally {
    await offline.cleanup();
  }
});

test("one destination is a single Open Folder button with no caret", async () => {
  const calls: Parameters<ApiClient["hostAction"]>[1][] = [];
  const client = {
    ...api,
    hostAction: async (_sessionId: string, action: Parameters<ApiClient["hostAction"]>[1]) => {
      calls.push(structuredClone(action));
      return { ok: true as const };
    },
  } as ApiClient;
  const revealOnly = await mountEditor(client, { ...runner, editors: [] });
  try {
    const buttons = [...revealOnly.container.querySelectorAll<HTMLButtonElement>("button")];
    assert.equal(buttons.length, 1);
    const [button] = buttons;
    assert.equal(button!.getAttribute("aria-label"), "Open Folder");
    assert.equal(button!.textContent?.trim(), "Open Folder");
    assert.equal(button!.title, "Open Folder");
    assert.ok(button!.classList.contains("btn") && button!.classList.contains("ghost"));
    assert.equal(button!.getAttribute("aria-haspopup"), null);
    assertNoDomNode(revealOnly.container.querySelector(".split"), "a single button is not a split");
    await act(async () => { button!.click(); });
    assert.deepEqual(calls, [{ kind: "reveal" }]);
  } finally {
    await revealOnly.cleanup();
  }
  assert.equal(openDestinationLabel({ kind: "editor", name: "Zed" }, true), "Open in Zed");
  assert.equal(openDestinationLabel({ kind: "reveal", name: "Finder" }, false), "Open in Finder");

  const offlineOnly = await mountEditor(client, { ...runner, editors: [], status: "offline" });
  try {
    const button = offlineOnly.container.querySelector<HTMLButtonElement>('button[aria-label="Open Folder"]');
    assert.ok(button);
    assert.equal(button.getAttribute("aria-disabled"), "true");
    const describedBy = button.getAttribute("aria-describedby");
    assert.equal(doc().getElementById(describedBy ?? "")?.textContent,
      "runner-1 is offline. You can open the folder again when it reconnects.",
      "an unnamed machine is named by its runner id");
  } finally {
    await offlineOnly.cleanup();
  }
});

test("losing the last editor while the menu is open closes it and hands focus to Open Folder", async () => {
  const client = { ...api, hostAction: async () => ({ ok: true as const }) } as ApiClient;
  const mounted = await mountEditor(client);
  try {
    const choose = mounted.container.querySelector<HTMLButtonElement>(`button[aria-label="${CHOOSE_DESTINATION_LABEL}"]`);
    assert.ok(choose);
    await act(async () => {
      choose.focus();
      choose.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event);
    });
    assert.equal(domWindow.document.activeElement, menuRadios()[0], "a destination has focus");
    await mounted.pushRunner({ ...runner, editors: [] });
    assertNoDomNode(doc().querySelector('[role="menu"]'), "the menu goes with its caret");
    const folder = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Open Folder"]');
    assert.ok(folder);
    assert.equal(domWindow.document.activeElement, folder, "focus lands on the control that remains");

    // Editors coming back restore the split, closed.
    await mounted.pushRunner(runner);
    assert.ok(mounted.container.querySelector(`button[aria-label="${CHOOSE_DESTINATION_LABEL}"]`));
    assertNoDomNode(doc().querySelector('[role="menu"]'));
  } finally {
    await mounted.cleanup();
  }
});

test("remote and unsupported runners expose no host action", async () => {
  const client = { ...api, hostAction: async () => ({ ok: true as const }) } as ApiClient;
  const unsupported = await mountEditor(client, { ...runner, protocolVersion: 21 });
  try {
    assertNoDomNode(unsupported.container.querySelector(".editor-select"));
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
    assertNoDomNode(remote.container.querySelector(".editor-select"));
  } finally {
    await remote.cleanup();
  }
});
