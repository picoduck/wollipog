import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, SessionView, UiSnapshotMessage } from "@wollipog/protocol";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { InboxView } from "./InboxView.js";
import type { RightPanelState } from "./RightPanel.js";

const domWindow = new Window({ url: "http://localhost/" });
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: () => ({
    matches: true,
    media: "(max-width: 760px)",
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  }),
});
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  PointerEvent: domWindow.PointerEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const VIEWPORT_HEIGHT = 2_000;
const ROW_HEIGHT = 68;
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value(this: Element) {
    const height = this.classList?.contains("inbox-list") ? VIEWPORT_HEIGHT : ROW_HEIGHT;
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: height, width: 800, height, toJSON: () => ({}) };
  },
});
for (const [name, value] of [["clientHeight", VIEWPORT_HEIGHT], ["offsetHeight", ROW_HEIGHT]] as const) {
  Object.defineProperty(domWindow.HTMLElement.prototype, name, { configurable: true, get: () => value });
}

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: ControlPlaneToUi) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const navigation: ViewNavigation = {
  current: () => ({ name: "inbox" }),
  push() {},
  listen: () => () => {},
};

const rightPanel = {
  open: false,
  mode: "launcher",
  width: 380,
  dragging: false,
  subagentTarget: null,
  toggle() {},
  openMode() {},
  show() {},
  setMode() {},
  setWidth() {},
  setDragging() {},
  close() {},
  selectSubagent() {},
  showSubagent() {},
  consumeSubagentFocusRequest() {},
} satisfies RightPanelState;

function session(id: string, lastEventAt: number, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    workspaceName: "Wollipog",
    agentId: "codex",
    agentName: "Codex",
    title: `Session ${id}`,
    status: "idle",
    column: "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: 1,
    updatedAt: lastEventAt,
    lastEventAt,
    messageCount: 1,
    preview: `Preview ${id}`,
    pendingApproval: null,
    driver: "codex-app-server",
    model: null,
    effort: null,
    permissionMode: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
    ...overrides,
  };
}

function snapshot(sessions: SessionView[]): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: false,
    },
    runners: [],
    boxes: [],
    sessions,
    runs: [],
    pods: [],
  };
}

function rowTitles(container: HTMLDivElement): string[] {
  return [...container.querySelectorAll(".inbox-row-title")].map((row) => row.textContent ?? "");
}

test("InboxView holds live activity order through mouse and touch, then reconciles canonically", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-order-test",
    runtimeKey: "inbox-order-test:1",
    createSocket: () => socket,
    close() {},
  };

  await act(async () => {
    root.render(
      <StoreProvider connection={connection} navigation={navigation}>
        <InboxView
          rightPanel={rightPanel}
          onOpenTerminal={() => undefined}
          pinnedOpen={false}
        />
      </StoreProvider>,
    );
  });
  await act(async () => { socket.push(snapshot([session("A", 30), session("B", 20)])); });
  assert.deepEqual(rowTitles(container), ["Session A", "Session B"]);

  const grid = container.querySelector<HTMLElement>(".inbox-list")!;
  const pointer = (type: string, pointerId: number, pointerType: string) =>
    grid.dispatchEvent(new domWindow.PointerEvent(type, { bubbles: true, pointerId, pointerType }) as unknown as Event);
  await act(async () => { pointer("pointerover", 1, "mouse"); });
  await act(async () => {
    socket.push({
      type: "session_upsert",
      session: session("B", 40, { preview: "Approval arrived.", status: "input_required" }),
    });
    socket.push({ type: "session_upsert", session: session("C", 50) });
  });
  assert.deepEqual(rowTitles(container), ["Session A", "Session B", "Session C"]);
  assert.match(container.textContent ?? "", /Approval arrived/);

  await act(async () => { socket.push({ type: "session_removed", sessionId: "A" }); });
  assert.deepEqual(rowTitles(container), ["Session B", "Session C"]);
  assert.equal(container.querySelector<HTMLElement>(".inbox-row-shell")?.getAttribute("aria-selected"), "true");

  await act(async () => { pointer("pointerout", 1, "mouse"); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  assert.deepEqual(rowTitles(container), ["Session C", "Session B"]);
  const selectedAfterReorder = [...container.querySelectorAll<HTMLElement>(".inbox-row-shell")]
    .find((row) => row.getAttribute("aria-selected") === "true");
  assert.match(selectedAfterReorder?.textContent ?? "", /Session B/);

  await act(async () => {
    pointer("pointerover", 7, "touch");
    pointer("pointerdown", 7, "touch");
    socket.push({ type: "session_upsert", session: session("B", 60, { preview: "Tap target updated." }) });
  });
  assert.deepEqual(rowTitles(container), ["Session C", "Session B"]);
  const visibleTarget = [...container.querySelectorAll<HTMLButtonElement>(".inbox-row")]
    .find((row) => row.textContent?.includes("Session B"));
  assert.ok(visibleTarget);
  await act(async () => {
    pointer("pointerup", 7, "touch");
    visibleTarget.click();
  });
  assert.match(container.querySelector<HTMLElement>('.inbox-row-shell[aria-selected="true"]')?.textContent ?? "", /Session B/);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  assert.deepEqual(rowTitles(container), ["Session B", "Session C"]);

  await act(async () => { root.unmount(); });
  container.remove();
});
