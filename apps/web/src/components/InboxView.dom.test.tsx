import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, ProjectView, SessionReminderView, SessionView, UiSnapshotMessage } from "@wollipog/protocol";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { InboxView } from "./InboxView.js";
import type { RightPanelState } from "./RightPanel.js";

const domWindow = new Window({ url: "http://localhost/" });
let mobileViewport = true;
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: () => ({
    get matches() { return mobileViewport; },
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

test("InboxView preserves the server-authoritative Project count when reminders hide no rows", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-project-count-test",
    runtimeKey: "inbox-project-count-test:1",
    createSocket: () => socket,
    close() {},
  };
  const project: ProjectView = {
    id: "project-1",
    name: "Project One",
    hidden: false,
    locations: [],
    activeSessionCount: 1,
    unarchivedSessionCount: 7,
    totalSessionCount: 7,
    createdAt: 1,
    updatedAt: 1,
  };

  await act(async () => {
    root.render(
      <StoreProvider connection={connection} navigation={navigation}>
        <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} pinnedOpen={false} />
      </StoreProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: {
        sessionSubscriptions: false,
        boundedDelivery: false,
        paginatedSessionHistory: false,
        projects: true,
        sessionReminders: true,
      },
      runners: [],
      boxes: [],
      sessions: [session("project-session", 10, { projectId: project.id })],
      projects: [project],
      reminders: [],
      runs: [],
      pods: [],
    });
  });
  const projectTab = [...container.querySelectorAll<HTMLElement>(".inbox-tab")]
    .find((tab) => tab.textContent?.includes("Project One"));
  assert.equal(projectTab?.querySelector(".inbox-tab-count")?.textContent, "7");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("InboxView keeps mobile browsing order stable before and through a touch", async () => {
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
  assert.deepEqual(rowTitles(container), ["Session B", "Session C"],
    "a phone has no pre-contact hover signal, so visual targeting must remain safe between taps");
  const selectedAfterReorder = [...container.querySelectorAll<HTMLElement>(".inbox-row-shell")]
    .find((row) => row.getAttribute("aria-selected") === "true");
  assert.match(selectedAfterReorder?.textContent ?? "", /Session B/);

  await act(async () => {
    pointer("pointerover", 7, "touch");
    pointer("pointerdown", 7, "touch");
    socket.push({ type: "session_upsert", session: session("B", 60, { preview: "Tap target updated." }) });
  });
  assert.deepEqual(rowTitles(container), ["Session B", "Session C"]);
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
  await act(async () => {
    socket.push({ type: "session_upsert", session: session("C", 70) });
  });
  assert.deepEqual(rowTitles(container), ["Session B", "Session C"]);
  await act(async () => {
    mobileViewport = false;
    domWindow.dispatchEvent(new domWindow.Event("resize"));
  });
  assert.deepEqual(rowTitles(container), ["Session C", "Session B"]);

  await act(async () => { root.unmount(); });
  container.remove();
  mobileViewport = true;
});

test("InboxView holds desktop browsing order until the user leaves the window", async () => {
  mobileViewport = false;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-desktop-order-test",
    runtimeKey: "inbox-desktop-order-test:1",
    createSocket: () => socket,
    close() {},
  };

  await act(async () => {
    root.render(
      <StoreProvider connection={connection} navigation={navigation}>
        <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} pinnedOpen={false} />
      </StoreProvider>,
    );
  });
  await act(async () => { socket.push(snapshot([session("A", 30), session("B", 20)])); });
  assert.deepEqual(rowTitles(container), ["Session A", "Session B"]);

  // No pointer and no keystroke: a desktop user reading the list must not have rows move under
  // them merely because they are not currently touching an input device.
  await act(async () => {
    socket.push({
      type: "session_upsert",
      session: session("B", 40, { preview: "Approval arrived.", status: "input_required" }),
    });
    socket.push({ type: "session_upsert", session: session("C", 50) });
  });
  assert.deepEqual(rowTitles(container), ["Session A", "Session B", "Session C"]);
  assert.match(container.textContent ?? "", /Approval arrived/);

  // Sustained concurrent activity, well past the interaction settle window.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  await act(async () => {
    socket.push({ type: "session_upsert", session: session("C", 60) });
    socket.push({ type: "session_upsert", session: session("B", 70, { preview: "Still running." }) });
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  assert.deepEqual(rowTitles(container), ["Session A", "Session B", "Session C"],
    "desktop stability must not expire while the user is still browsing the Inbox");
  assert.match(container.textContent ?? "", /Still running/);

  await act(async () => { socket.push({ type: "session_removed", sessionId: "A" }); });
  assert.deepEqual(rowTitles(container), ["Session B", "Session C"]);
  assert.match(
    container.querySelector<HTMLElement>('.inbox-row-shell[aria-selected="true"]')?.textContent ?? "",
    /Session B/,
  );

  // Leaving the window is the safe boundary: canonical recency ordering is applied there.
  await act(async () => { domWindow.dispatchEvent(new domWindow.Event("blur")); });
  assert.deepEqual(rowTitles(container), ["Session B", "Session C"]);
  await act(async () => { socket.push({ type: "session_upsert", session: session("C", 80) }); });
  assert.deepEqual(rowTitles(container), ["Session C", "Session B"]);

  // Returning re-establishes the hold from the freshly adopted order.
  await act(async () => { domWindow.dispatchEvent(new domWindow.Event("focus")); });
  await act(async () => { socket.push({ type: "session_upsert", session: session("B", 90) }); });
  assert.deepEqual(rowTitles(container), ["Session C", "Session B"]);

  await act(async () => { root.unmount(); });
  container.remove();
  mobileViewport = true;
});

test("a two-client reminder upsert preserves the open Inbox Snooze draft and focus", async () => {
  mobileViewport = false;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-reminder-conflict-test",
    runtimeKey: "inbox-reminder-conflict-test:1",
    createSocket: () => socket,
    close() {},
  };
  const original: SessionReminderView = {
    reminderId: "reminder-original",
    sessionId: "session-reminder",
    scheduledFor: Date.now() + 86_400_000,
    timeZone: "America/Chicago",
    originalExpression: "tomorrow morning",
    wakePolicy: "until_activity",
    state: "pending",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  await act(async () => {
    root.render(
      <StoreProvider connection={connection} navigation={navigation}>
        <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} pinnedOpen={false} />
      </StoreProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: {
        sessionSubscriptions: false,
        boundedDelivery: false,
        paginatedSessionHistory: false,
        projects: false,
        sessionReminders: true,
      },
      runners: [],
      boxes: [],
      sessions: [session("session-reminder", 10, { status: "input_required" })],
      reminders: [original],
      runs: [],
      pods: [],
    });
  });

  await act(async () => { container.querySelector<HTMLButtonElement>(".inbox-row")!.click(); });
  const snooze = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Snooze"]')]
    .at(0)!;
  assert.ok(snooze);
  await act(async () => { snooze.click(); });
  const expression = container.querySelector<HTMLInputElement>("#snooze-expression")!;
  const exact = container.querySelector<HTMLInputElement>("#snooze-exact")!;
  await act(async () => {
    expression.value = "today at 3:30 pm";
    Simulate.change(expression);
    exact.value = "2099-04-05T06:30";
    Simulate.change(exact);
    [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((button) => button.textContent?.includes("Regardless"))!.click();
    exact.focus();
  });
  const draftTimeZone = [...container.querySelectorAll(".snooze-preview span")].at(-1)?.textContent;

  await act(async () => {
    socket.push({
      type: "session_reminder_upsert",
      userId: "usr_local_owner",
      reminder: {
        ...original,
        scheduledFor: Date.now() + 172_800_000,
        timeZone: "Asia/Tokyo",
        originalExpression: "2099-05-06T07:45",
        revision: 2,
        updatedAt: 2,
      },
    });
  });

  assert.equal(domWindow.document.activeElement, exact);
  assert.equal(expression.value, "today at 3:30 pm");
  assert.equal(exact.value, "2099-04-05T06:30");
  assert.equal(container.querySelector<HTMLButtonElement>('.snooze-policy [role="radio"][aria-checked="true"]')?.textContent?.includes("Regardless"), true);
  assert.equal([...container.querySelectorAll(".snooze-preview span")].at(-1)?.textContent, draftTimeZone);
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /updated in another client/i);
  const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  assert.equal(submit.disabled, false);
  assert.equal(submit.getAttribute("aria-disabled"), "true");

  const cancel = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "Cancel")!;
  await act(async () => { cancel.click(); });
  await act(async () => { snooze.click(); });
  assert.equal(container.querySelector<HTMLInputElement>("#snooze-expression")?.value, "");
  assert.equal(container.querySelector<HTMLInputElement>("#snooze-exact")?.value, "2099-05-06T07:45");
  assert.equal(container.querySelector('[role="alert"]'), null, "closing still discards the local draft normally");

  await act(async () => { root.unmount(); });
  container.remove();
  mobileViewport = true;
});
