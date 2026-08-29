import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
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

function setVisibility(value: "visible" | "hidden"): void {
  Object.defineProperty(domWindow.document, "visibilityState", { configurable: true, value });
}

function setWindowFocused(focused: boolean): void {
  Object.defineProperty(domWindow.document, "hasFocus", { configurable: true, value: () => focused });
}

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

function selectedRowTitle(container: HTMLDivElement): string | null {
  return container.querySelector<HTMLElement>('.inbox-row-shell[aria-selected="true"] .inbox-row-title')
    ?.textContent ?? null;
}

for (const viewport of ["mobile", "desktop"] as const) {
  for (const scenario of [
    { selected: "A", remaining: ["B", "C"], expected: "B" },
    { selected: "B", remaining: ["A", "C"], expected: "C" },
    { selected: "C", remaining: ["A", "B"], expected: "B" },
  ]) {
    test(`InboxView repairs a deleted ${scenario.selected} row to its slot on ${viewport}`, async () => {
      mobileViewport = viewport === "mobile";
      const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
      domWindow.document.body.append(container as never);
      const root = createRoot(container);
      const socket = new FakeSocket();
      const connection: UiConnectionRuntime = {
        instanceId: `inbox-delete-${viewport}-${scenario.selected}`,
        runtimeKey: `inbox-delete-${viewport}-${scenario.selected}:1`,
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
      await act(async () => {
        socket.push(snapshot([session("A", 30), session("B", 20), session("C", 10)]));
      });
      const selectedButton = [...container.querySelectorAll<HTMLButtonElement>(".inbox-row")]
        .find((row) => row.textContent?.includes(`Session ${scenario.selected}`));
      assert.ok(selectedButton);
      await act(async () => { selectedButton.click(); });
      assert.equal(selectedRowTitle(container), `Session ${scenario.selected}`);

      await act(async () => {
        socket.push({ type: "session_removed", sessionId: scenario.selected });
      });
      assert.deepEqual(rowTitles(container), scenario.remaining.map((id) => `Session ${id}`));
      assert.equal(selectedRowTitle(container), `Session ${scenario.expected}`);

      await act(async () => { root.unmount(); });
      container.remove();
      mobileViewport = true;
    });
  }
}

for (const viewport of ["mobile", "desktop"] as const) {
  test(`InboxView clears selection when its only row is deleted on ${viewport}`, async () => {
    mobileViewport = viewport === "mobile";
    const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
    domWindow.document.body.append(container as never);
    const root = createRoot(container);
    const socket = new FakeSocket();
    const connection: UiConnectionRuntime = {
      instanceId: `inbox-delete-only-${viewport}`,
      runtimeKey: `inbox-delete-only-${viewport}:1`,
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
    await act(async () => { socket.push(snapshot([session("only", 10)])); });
    assert.equal(selectedRowTitle(container), "Session only");
    await act(async () => { socket.push({ type: "session_removed", sessionId: "only" }); });
    assert.deepEqual(rowTitles(container), []);
    assert.equal(selectedRowTitle(container), null);
    assert.ok(container.querySelector(".inbox-zero"));

    await act(async () => { root.unmount(); });
    container.remove();
    mobileViewport = true;
  });
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
  assert.match(container.textContent ?? "", /Awaiting Prompt/);
  assert.doesNotMatch(container.textContent ?? "", /Diff Ready|Ready for Review/);

  const grid = container.querySelector<HTMLElement>(".inbox-list")!;
  const pointer = (type: string, pointerId: number, pointerType: string) =>
    grid.dispatchEvent(new domWindow.PointerEvent(type, { bubbles: true, pointerId, pointerType }) as unknown as Event);
  await act(async () => { pointer("pointerover", 1, "mouse"); });
  // Mobile browser chrome and OS surfaces can transiently blur the document without ending the
  // collapsed Inbox browsing interval. The lease must survive that unreliable signal.
  await act(async () => { domWindow.dispatchEvent(new domWindow.Event("blur")); });
  await act(async () => {
    socket.push({
      type: "session_upsert",
      session: session("B", 40, {
        preview: "Question arrived.",
        status: "input_required",
        column: "input_required",
        pendingApproval: { requestId: "question", title: "Which database?", options: [], kind: "question" },
      }),
    });
    socket.push({ type: "session_upsert", session: session("C", 50) });
  });
  assert.deepEqual(rowTitles(container), ["Session A", "Session B", "Session C"]);
  assert.match(container.textContent ?? "", /Question arrived/);
  assert.match(container.textContent ?? "", /Awaiting Input/);
  assert.match(container.textContent ?? "", /Answer Required/);
  assert.equal(container.querySelector(".inbox-order-update"), null,
    "the desktop manual-order affordance does not crowd the mobile Inbox toolbar");

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
  setVisibility("visible");
  setWindowFocused(true);
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
  const selectedBeforeApply = [...container.querySelectorAll<HTMLButtonElement>(".inbox-row")]
    .find((row) => row.textContent?.includes("Session B"));
  await act(async () => { selectedBeforeApply?.click(); });
  const applyOrder = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Apply New Order");
  assert.ok(applyOrder, "sustained desktop activity exposes a deliberate reorder boundary");
  assert.match(container.textContent ?? "", /A newer Inbox order is available/);
  await act(async () => { applyOrder.click(); });
  assert.deepEqual(rowTitles(container), ["Session B", "Session C", "Session A"]);
  assert.match(
    container.querySelector<HTMLElement>('.inbox-row-shell[aria-selected="true"]')?.textContent ?? "",
    /Session B/,
    "manual reordering preserves selection by session identity",
  );
  assert.equal(container.querySelector(".inbox-order-update"), null, "the indicator clears after adoption");
  assert.equal(domWindow.document.activeElement, container.querySelector(".inbox-list"),
    "keyboard activation returns focus to the list without scrolling it");

  await act(async () => { socket.push({ type: "session_removed", sessionId: "A" }); });
  assert.deepEqual(rowTitles(container), ["Session B", "Session C"]);
  assert.match(
    container.querySelector<HTMLElement>('.inbox-row-shell[aria-selected="true"]')?.textContent ?? "",
    /Session B/,
  );

  // Leaving the window is the safe boundary: canonical recency ordering is applied there.
  await act(async () => { domWindow.dispatchEvent(new domWindow.Event("blur")); });
  assert.deepEqual(rowTitles(container), ["Session B", "Session C"]);
  assert.equal(container.querySelector(".inbox-order-update"), null,
    "an automatic safe boundary clears the pending-order indicator");
  await act(async () => { socket.push({ type: "session_upsert", session: session("C", 80) }); });
  assert.deepEqual(rowTitles(container), ["Session C", "Session B"]);

  // Returning re-establishes the hold from the freshly adopted order.
  await act(async () => { domWindow.dispatchEvent(new domWindow.Event("focus")); });
  await act(async () => { socket.push({ type: "session_upsert", session: session("B", 90) }); });
  assert.deepEqual(rowTitles(container), ["Session C", "Session B"]);

  // A page can be backgrounded with no window blur, and a pointer resting over the list gets no
  // pointerout when that happens. The boundary has to hold anyway.
  const grid = container.querySelector<HTMLElement>(".inbox-list")!;
  await act(async () => {
    grid.dispatchEvent(new domWindow.PointerEvent("pointerover", {
      bubbles: true, pointerId: 3, pointerType: "mouse",
    }) as unknown as Event);
  });
  setVisibility("hidden");
  await act(async () => { domWindow.document.dispatchEvent(new domWindow.Event("visibilitychange")); });
  await act(async () => { socket.push({ type: "session_upsert", session: session("B", 100) }); });
  assert.deepEqual(rowTitles(container), ["Session B", "Session C"],
    "a hidden page is not a browsing interval, whatever the pointer was last seen doing");
  setVisibility("visible");
  await act(async () => { domWindow.document.dispatchEvent(new domWindow.Event("visibilitychange")); });
  await act(async () => { socket.push({ type: "session_upsert", session: session("C", 110) }); });
  assert.deepEqual(rowTitles(container), ["Session B", "Session C"]);

  // Becoming visible again inside a still-unfocused window is not a return: the lease must stay
  // down until focus comes back, or activity between the two events is frozen into a stale order.
  await act(async () => { domWindow.dispatchEvent(new domWindow.Event("blur")); });
  setVisibility("hidden");
  await act(async () => { domWindow.document.dispatchEvent(new domWindow.Event("visibilitychange")); });
  setVisibility("visible");
  await act(async () => { domWindow.document.dispatchEvent(new domWindow.Event("visibilitychange")); });
  await act(async () => { socket.push({ type: "session_upsert", session: session("B", 120) }); });
  assert.deepEqual(rowTitles(container), ["Session B", "Session C"],
    "an unfocused window is still away, whatever the page's visibility did in the meantime");

  // Focus is the return, and the hold re-arms from the order the user actually comes back to.
  await act(async () => { domWindow.dispatchEvent(new domWindow.Event("focus")); });
  await act(async () => { socket.push({ type: "session_upsert", session: session("C", 130) }); });
  assert.deepEqual(rowTitles(container), ["Session B", "Session C"]);

  // Archiving the selected middle row hands selection to the row that took its slot, without
  // disturbing the held positions around it.
  await act(async () => { socket.push({ type: "session_upsert", session: session("A", 140) }); });
  assert.deepEqual(rowTitles(container), ["Session B", "Session C", "Session A"]);
  const middleRow = [...container.querySelectorAll<HTMLButtonElement>(".inbox-row")]
    .find((row) => row.textContent?.includes("Session C"));
  await act(async () => { middleRow?.click(); });
  assert.match(
    container.querySelector<HTMLElement>('.inbox-row-shell[aria-selected="true"]')?.textContent ?? "",
    /Session C/,
  );
  await act(async () => {
    socket.push({ type: "session_upsert", session: session("C", 150, { archived: true }) });
  });
  assert.deepEqual(rowTitles(container), ["Session B", "Session A"]);
  assert.match(
    container.querySelector<HTMLElement>('.inbox-row-shell[aria-selected="true"]')?.textContent ?? "",
    /Session A/,
  );

  await act(async () => { root.unmount(); });
  container.remove();
  mobileViewport = true;
});

test("InboxView does not offer a reorder when only a removed selected id remains held", async () => {
  mobileViewport = false;
  setVisibility("visible");
  setWindowFocused(true);
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-removed-selection-order-test",
    runtimeKey: "inbox-removed-selection-order-test:1",
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
  assert.match(
    container.querySelector<HTMLElement>('.inbox-row-shell[aria-selected="true"]')?.textContent ?? "",
    /Session A/,
  );

  await act(async () => { socket.push({ type: "session_removed", sessionId: "A" }); });
  assert.deepEqual(rowTitles(container), ["Session B"]);
  assert.equal(container.querySelector(".inbox-order-update"), null,
    "a stale selected-id placeholder is not a visible order difference");
  assert.doesNotMatch(container.textContent ?? "", /A newer Inbox order is available/);

  await act(async () => { root.unmount(); });
  container.remove();
  mobileViewport = true;
});

test("InboxView does not arm the order hold when it mounts in an unfocused window", async () => {
  mobileViewport = false;
  setVisibility("visible");
  setWindowFocused(false);
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-unfocused-mount-test",
    runtimeKey: "inbox-unfocused-mount-test:1",
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
  // A secondary window reloaded in the background receives no blur to announce that it is away.
  await act(async () => { socket.push(snapshot([session("A", 30), session("B", 20)])); });
  await act(async () => { socket.push({ type: "session_upsert", session: session("B", 40) }); });
  await act(async () => { socket.push({ type: "session_upsert", session: session("C", 50) }); });
  assert.deepEqual(rowTitles(container), ["Session C", "Session B", "Session A"]);

  setWindowFocused(true);
  await act(async () => { domWindow.dispatchEvent(new domWindow.Event("focus")); });
  await act(async () => { socket.push({ type: "session_upsert", session: session("A", 60) }); });
  assert.deepEqual(rowTitles(container), ["Session C", "Session B", "Session A"]);

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
    fireDomEvent.change(expression);
    exact.value = "2099-04-05T06:30";
    fireDomEvent.change(exact);
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
