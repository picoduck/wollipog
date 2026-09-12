import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, ProjectView, SessionReminderView, SessionView, UiSnapshotMessage } from "@wollipog/protocol";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { filterInboxSplitsForReminderMode, InboxView } from "./InboxView.js";
import { INBOX_COLLAPSED_THREADS_KEY, type InboxSplit } from "../inbox.js";
import { loadKeySet, saveKeySet, SESSION_PIN_KEY } from "../pins.js";
import { loadSeen, saveSeen } from "../sessions-seen.js";
import type { RightPanelState } from "./RightPanel.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
// One mechanism, not two. Disposers registered through `cleanup` run BEFORE the window aborts its
// pending tasks, which is the order React unmounting needs; a second `afterEach` racing this one
// tore down the window first and made `act` reject during unmount (#690).
const { cleanup } = installDomTestCleanup(domWindow, { reset: () => { mobileViewport = true; } });
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

/**
 * Mounts a React root whose teardown is guaranteed to run.
 *
 * Every test here renders `InboxView` under a `StoreProvider`, and the store drives one shared
 * stall clock: a `setTimeout` that reschedules itself every `ACTIVITY_BUCKET_MS`, torn down only
 * by that effect's cleanup. Teardown used to be the closing statements of each test, so an
 * assertion that threw skipped it, the clock kept rescheduling a minute at a time, and the process
 * could not exit — a plain assertion failure surfaced as a multi-minute stall rather than a
 * failure in seconds, past `--test-timeout` (#680). Registering the root here and draining in
 * `afterEach` makes cleanup independent of whether the assertions hold.
 */
const mountedRoots: Array<{ root: ReturnType<typeof createRoot>; container: HTMLDivElement }> = [];

function mountTestRoot(): { container: HTMLDivElement; root: ReturnType<typeof createRoot> } {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const entry = { root, container };
  mountedRoots.push(entry);
  // The shared cleanup drains disposers newest-first and guards each one, so a teardown that throws
  // cannot strand the roots behind it — the property rounds 1 and 2 of #684 were about.
  cleanup(async () => {
    const at = mountedRoots.indexOf(entry);
    if (at >= 0) mountedRoots.splice(at, 1);
    await act(async () => { root.unmount(); });
    container.remove();
  });
  return { container, root };
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

function reminder(sessionId: string, revision = 1): SessionReminderView {
  return {
    reminderId: `reminder-${sessionId}`,
    sessionId,
    scheduledFor: 10_000,
    timeZone: "UTC",
    originalExpression: "tomorrow",
    wakePolicy: "until_activity",
    state: "pending",
    revision,
    createdAt: 1,
    updatedAt: revision,
  };
}

function rowTitles(container: HTMLDivElement): string[] {
  return [...container.querySelectorAll(".inbox-row-title")].map((row) => row.textContent ?? "");
}

test("reminder-filtered Project splits keep Active and Snoozed counts mutually exclusive", () => {
  const blocked = session("blocked", 3, { status: "input_required" });
  const snoozed = session("snoozed", 2);
  const ordinary = session("ordinary", 1);
  const reminders = new Map([
    [blocked.id, reminder(blocked.id)],
    [snoozed.id, reminder(snoozed.id)],
  ]);
  const baseSplit = {
    key: null,
    kind: "all",
    name: "All",
    project: null,
    sessions: [blocked, snoozed, ordinary],
    count: 3,
    blockedCount: 1,
    stalledCount: 2,
  } satisfies InboxSplit;
  const [activeSplit] = filterInboxSplitsForReminderMode(
    [baseSplit], reminders, "ordinary", new Set([snoozed.id, ordinary.id]),
  );
  const [snoozedSplit] = filterInboxSplitsForReminderMode(
    [baseSplit], reminders, "snoozed", new Set([snoozed.id, ordinary.id]),
  );

  assert.deepEqual(activeSplit?.sessions.map((candidate) => candidate.id), [ordinary.id]);
  assert.equal(activeSplit?.count, 1);
  assert.equal(activeSplit?.blockedCount, 0, "snoozed attention must not remain in Active aggregates");
  assert.equal(activeSplit?.stalledCount, 1, "a snoozed stalled row must not remain in Active aggregates");
  assert.deepEqual(snoozedSplit?.sessions.map((candidate) => candidate.id), [blocked.id, snoozed.id]);
  assert.equal(snoozedSplit?.count, 2);
  assert.equal(snoozedSplit?.blockedCount, 1);
  assert.equal(snoozedSplit?.stalledCount, 1);
});

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
      const { container, root } = mountTestRoot();
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

    });
  }
}

for (const viewport of ["mobile", "desktop"] as const) {
  test(`InboxView clears selection when its only row is deleted on ${viewport}`, async () => {
    mobileViewport = viewport === "mobile";
    const { container, root } = mountTestRoot();
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

  });
}

test("InboxView preserves the server-authoritative Project count when reminders hide no rows", async () => {
  const { container, root } = mountTestRoot();
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
  await act(async () => { projectTab!.click(); });
  assert.equal(container.querySelector('[title="Active"]')?.getAttribute("aria-label"), "Active, 7 Sessions");
  assert.equal(container.querySelector('[title="Snoozed"]')?.getAttribute("aria-label"), "Snoozed, 0 Sessions");

});

test("Active and Snoozed badges follow the selected Project split and live reminders", async () => {
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-reminder-scope-test",
    runtimeKey: "inbox-reminder-scope-test:1",
    createSocket: () => socket,
    close() {},
  };
  const project = (id: string, name: string, count: number): ProjectView => ({
    id,
    name,
    hidden: false,
    locations: [],
    activeSessionCount: count,
    unarchivedSessionCount: count,
    totalSessionCount: count,
    createdAt: 1,
    updatedAt: 1,
  });
  const alpha = project("alpha", "Alpha", 2);
  const beta = project("beta", "Beta", 3);
  const alphaActive = session("alpha-active", 50, { projectId: alpha.id });
  const alphaSnoozed = session("alpha-snoozed", 40, { projectId: alpha.id });
  const betaOne = session("beta-one", 30, { projectId: beta.id });
  const betaTwo = session("beta-two", 20, { projectId: beta.id });
  const betaSnoozed = session("beta-snoozed", 10, { projectId: beta.id });

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
      sessions: [alphaActive, alphaSnoozed, betaOne, betaTwo, betaSnoozed],
      projects: [alpha, beta],
      reminders: [reminder(alphaSnoozed.id), reminder(betaSnoozed.id)],
      runs: [],
      pods: [],
    });
  });
  const countLabel = (title: string) => container.querySelector(`[title="${title}"]`)?.getAttribute("aria-label");
  assert.equal(countLabel("Active"), "Active, 3 Sessions");
  assert.equal(countLabel("Snoozed"), "Snoozed, 2 Sessions");

  const alphaTab = [...container.querySelectorAll<HTMLButtonElement>(".inbox-tab")]
    .find((tab) => tab.textContent?.includes("Alpha"))!;
  await act(async () => { alphaTab.click(); });
  assert.equal(countLabel("Active"), "Active, 1 Session");
  assert.equal(countLabel("Snoozed"), "Snoozed, 1 Session");

  await act(async () => {
    socket.push({
      type: "session_reminder_upsert",
      userId: "user",
      reminder: reminder(alphaActive.id),
    });
  });
  assert.equal(countLabel("Active"), "Active, 0 Sessions");
  assert.equal(countLabel("Snoozed"), "Snoozed, 2 Sessions");

  const betaTab = [...container.querySelectorAll<HTMLButtonElement>(".inbox-tab")]
    .find((tab) => tab.textContent?.includes("Beta"))!;
  await act(async () => { betaTab.click(); });
  assert.equal(countLabel("Active"), "Active, 2 Sessions");
  assert.equal(countLabel("Snoozed"), "Snoozed, 1 Session");

});

test("reminder membership stays exclusive while scoped attention reconciles in Snoozed list and board", async () => {
  mobileViewport = true;
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-reminder-membership-test",
    runtimeKey: "inbox-reminder-membership-test:1",
    createSocket: () => socket,
    close() {},
  };
  const watchdog = session("watchdog", 80, {
    backgroundDeliveries: [{
      deliveryId: "delivery-watchdog",
      continuationId: "continuation-watchdog",
      watchdogState: "terminal_without_continuation",
    } as never],
  });
  const orphaned = session("orphaned", 75, { backgroundWorkState: "orphaned" });
  const omitted = session("omitted", 70, { pendingApproval: undefined as never });
  const ordinary = session("ordinary", 60);
  const failed = session("failed", 30, { status: "failed" });
  const input = session("input", 20, { status: "input_required" });
  const unsnoozed = session("unsnoozed", 10);
  const pending = [omitted, ordinary, orphaned, watchdog, failed, input].map((candidate) => reminder(candidate.id));

  const renderView = (viewMode: "list" | "board") => act(async () => {
    root.render(
      <StoreProvider connection={connection} navigation={navigation}>
        <InboxView
          viewMode={viewMode}
          rightPanel={rightPanel}
          onOpenTerminal={() => undefined}
          pinnedOpen={false}
        />
      </StoreProvider>,
    );
  });
  await renderView("list");
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
      sessions: [omitted, ordinary, orphaned, watchdog, failed, input, unsnoozed],
      reminders: pending,
      runs: [],
      pods: [],
    });
  });

  assert.deepEqual(rowTitles(container), ["Session unsnoozed"]);
  assert.equal(container.querySelector('[title="Active"]')?.getAttribute("aria-label"), "Active, 1 Session");
  assert.equal(container.querySelector('[title="Snoozed"]')?.getAttribute("aria-label"), "Snoozed, 6 Sessions");
  assert.doesNotMatch(container.textContent ?? "", /Background Work Orphaned|Result Pending/);

  await act(async () => { (container.querySelector('[title="Snoozed"]') as HTMLButtonElement).click(); });
  assert.deepEqual(rowTitles(container), [
    "Session input", "Session watchdog", "Session orphaned", "Session omitted", "Session ordinary", "Session failed",
  ]);
  assert.match(container.textContent ?? "", /Background Work Orphaned/);
  assert.match(container.textContent ?? "", /Result Pending/);
  assert.ok(container.querySelector('[aria-label="Attention: Background Work Orphaned"]'));
  const watchdogPill = container.querySelector('[aria-label^="Background Work: Result Pending."]');
  assert.ok(watchdogPill);
  assert.ok(watchdogPill.classList.contains("background-delivery-pending"));
  assert.equal(watchdogPill.classList.contains("blocked"), false);

  await act(async () => { (container.querySelector('[title="Active"]') as HTMLButtonElement).click(); });
  await renderView("board");
  assert.deepEqual([...container.querySelectorAll(".card")].map((card) => card.textContent?.includes("Session unsnoozed")), [true]);
  assert.equal(container.querySelector('.card [aria-label="Reminder: Snoozed"]'), null);

  await act(async () => { (container.querySelector('[title="Snoozed"]') as HTMLButtonElement).click(); });
  assert.ok([...container.querySelectorAll(".card")].some((card) => card.textContent?.includes("Session orphaned")));
  assert.ok(container.querySelector('.card [aria-label="Attention: Background Work Orphaned"]'));
  const boardWatchdogPill = container.querySelector('.card [aria-label^="Background Work: Result Pending."]');
  assert.ok(boardWatchdogPill);
  assert.ok(boardWatchdogPill.classList.contains("background-delivery-pending"));
  assert.equal(boardWatchdogPill.classList.contains("blocked"), false);
  assert.ok(container.querySelector('.card [aria-label="Reminder: Snoozed"]'));

  await act(async () => {
    socket.push({ type: "session_upsert", session: { ...orphaned, backgroundWorkState: "resumed", updatedAt: 80 } });
  });
  assert.ok([...container.querySelectorAll(".card")].some((card) => card.textContent?.includes("Session orphaned")),
    "clearing attention must leave the pending reminder in Snoozed");
  assert.equal(container.querySelector('.card [aria-label="Attention: Background Work Orphaned"]'), null);
  assert.equal(container.querySelector('[title="Active"]')?.getAttribute("aria-label"), "Active, 1 Session");

  await act(async () => {
    socket.push({ type: "session_reminder_removed", userId: "user", sessionId: ordinary.id });
  });
  assert.equal([...container.querySelectorAll(".card")].some((card) => card.textContent?.includes("Session ordinary")), false,
    "removing a reminder immediately removes the session from Snoozed");
  assert.equal(container.querySelector('[title="Active"]')?.getAttribute("aria-label"), "Active, 2 Sessions");
  assert.equal(container.querySelector('[title="Snoozed"]')?.getAttribute("aria-label"), "Snoozed, 5 Sessions");

  await act(async () => { (container.querySelector('[title="Active"]') as HTMLButtonElement).click(); });
  assert.ok([...container.querySelectorAll(".card")].some((card) => card.textContent?.includes("Session ordinary")),
    "removing the reminder returns the idle session without navigation");
  assert.equal([...container.querySelectorAll(".card")].some((card) => card.textContent?.includes("Session orphaned")), false,
    "an attention update must not leak a pending reminder back into Active");
  assert.equal(container.querySelector('[title="Active"]')?.getAttribute("aria-label"), "Active, 2 Sessions");
  assert.equal(container.querySelector('[title="Snoozed"]')?.getAttribute("aria-label"), "Snoozed, 5 Sessions");

});

test("InboxView keeps mobile browsing order stable before and through a touch", async () => {
  const { container, root } = mountTestRoot();
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
  // The upsert's own status carries the proof that it landed. #664 removed the preview from the
  // row, so the preview text below is store state the row deliberately no longer prints.
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

});

test("InboxView holds desktop browsing order until the user leaves the window", async () => {
  mobileViewport = false;
  setVisibility("visible");
  setWindowFocused(true);
  const { container, root } = mountTestRoot();
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
  // Same substitution as the mobile case: the row stopped printing the preview in #664, so the
  // status the same upsert carried is what shows it was applied while the order was held.
  assert.match(container.textContent ?? "", /Awaiting Input/);

  // Sustained concurrent activity, well past the interaction settle window.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  await act(async () => {
    socket.push({ type: "session_upsert", session: session("C", 60) });
    socket.push({ type: "session_upsert", session: session("B", 70, { preview: "Still running." }) });
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  assert.deepEqual(rowTitles(container), ["Session A", "Session B", "Session C"],
    "desktop stability must not expire while the user is still browsing the Inbox");
  // This upsert changes only the preview and the activity instant, and the row prints neither
  // distinctly since #664. The probe that survives is the APPLIED ORDER asserted below: B leads
  // it only because this batch set B to 70 and C to 60. Had the batch been dropped, the adopted
  // order would be C, B, A off the earlier 50 and 40. The pending-order indicator would NOT have
  // been enough — the first batch already raised it.
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

});

test("InboxView does not offer a reorder when only a removed selected id remains held", async () => {
  mobileViewport = false;
  setVisibility("visible");
  setWindowFocused(true);
  const { container, root } = mountTestRoot();
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

});

test("InboxView does not arm the order hold when it mounts in an unfocused window", async () => {
  mobileViewport = false;
  setVisibility("visible");
  setWindowFocused(false);
  const { container, root } = mountTestRoot();
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

});

test("a two-client reminder upsert preserves the open Inbox Snooze draft and focus", async () => {
  mobileViewport = false;
  const { container, root } = mountTestRoot();
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

  await act(async () => { container.querySelector<HTMLButtonElement>('[title="Snoozed"]')!.click(); });
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

});

test("desktop search Enter focuses the exact filtered result set without activating a session", async () => {
  mobileViewport = false;
  setVisibility("visible");
  setWindowFocused(true);
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-search-enter-test",
    runtimeKey: "inbox-search-enter-test:1",
    createSocket: () => socket,
    close() {},
  };
  const pushed: unknown[] = [];
  const spyNavigation: ViewNavigation = {
    current: () => ({ name: "inbox" }),
    push: (view) => void pushed.push(view),
    listen: () => () => {},
  };

  await act(async () => {
    root.render(
      <StoreProvider connection={connection} navigation={spyNavigation}>
        <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} pinnedOpen={false} />
      </StoreProvider>,
    );
  });
  await act(async () => {
    socket.push(snapshot([session("A", 30), session("B", 20), session("C", 10)]));
  });

  const search = container.querySelector<HTMLInputElement>(".inbox-search input")!;
  const filter = async (value: string) => {
    await act(async () => {
      search.value = value;
      fireDomEvent.change(search as never, { target: { value } as never });
    });
    await act(async () => { await Promise.resolve(); });
  };
  const pressSearchEnter = async (init: KeyboardEventInit = {}) => {
    await act(async () => {
      search.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
        key: "Enter", bubbles: true, cancelable: true, ...init,
      } as never) as never);
    });
  };

  // Enter in the same event batch as the final input change must wait for the deferred filter,
  // rather than focusing a row from the previous result set.
  const rowC = [...container.querySelectorAll<HTMLButtonElement>(".inbox-row")]
    .find((row) => row.textContent?.includes("Session C"))!;
  await act(async () => { rowC.click(); });
  search.focus();
  await act(async () => {
    search.value = "Session A";
    fireDomEvent.change(search as never, { target: { value: "Session A" } as never });
    search.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true,
    }) as never);
  });
  await act(async () => { await Promise.resolve(); });
  let grid = container.querySelector<HTMLElement>(".inbox-list")!;
  assert.equal(domWindow.document.activeElement, grid);
  assert.equal(selectedRowTitle(container), "Session A");
  assert.equal(grid.getAttribute("aria-rowcount"), "1");

  // A visible selection remains active across a multi-result handoff.
  await filter("Session");
  const rowB = [...container.querySelectorAll<HTMLButtonElement>(".inbox-row")]
    .find((row) => row.textContent?.includes("Session B"))!;
  await act(async () => { rowB.click(); });
  search.focus();
  await pressSearchEnter();
  grid = container.querySelector<HTMLElement>(".inbox-list")!;
  assert.equal(domWindow.document.activeElement, grid);
  assert.equal(search.value, "Session");
  assert.equal(selectedRowTitle(container), "Session B");
  let activeDescendant = grid.getAttribute("aria-activedescendant");
  assert.ok(activeDescendant);
  assert.ok(domWindow.document.getElementById(activeDescendant), "the active result is mounted");
  assert.deepEqual(pushed, [], "search Enter moves focus without opening the selected session");

  // Normal list commands now operate on the displayed results.
  await act(async () => {
    domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }));
  });
  assert.equal(selectedRowTitle(container), "Session C");

  // A hidden selection is repaired to the first (and only) displayed result.
  search.focus();
  await filter("Session A");
  await pressSearchEnter();
  grid = container.querySelector<HTMLElement>(".inbox-list")!;
  assert.equal(domWindow.document.activeElement, grid);
  assert.equal(selectedRowTitle(container), "Session A");
  assert.equal(grid.getAttribute("aria-rowcount"), "1");

  // An empty result set keeps focus and has no grid or stale active descendant.
  search.focus();
  await filter("does not exist");
  await pressSearchEnter();
  assert.equal(domWindow.document.activeElement, search);
  assert.equal(container.querySelector(".inbox-list"), null);
  assert.match(container.querySelector(".inbox-zero")?.textContent ?? "", /No Matching Sessions/);

  // Modified and composing Enter remain input-owned even when results exist.
  await filter("Session");
  for (const init of [
    { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { keyCode: 229 },
  ] satisfies KeyboardEventInit[]) {
    search.focus();
    await pressSearchEnter(init);
    assert.equal(domWindow.document.activeElement, search);
  }
  await act(async () => {
    search.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true, isComposing: true,
    } as never) as never);
  });
  assert.equal(domWindow.document.activeElement, search);
});

test("board mode shares the Sessions toolbar scope and toggles back to the list", async () => {
  mobileViewport = false;
  setWindowFocused(true);
  setVisibility("visible");
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "sessions-board-mode",
    runtimeKey: "sessions-board-mode:1",
    createSocket: () => socket,
    close() {},
  };
  const pushed: unknown[] = [];
  const spyNavigation: ViewNavigation = {
    current: () => ({ name: "board" }),
    push: (view) => void pushed.push(view),
    listen: () => () => {},
  };

  await act(async () => {
    root.render(
      <StoreProvider connection={connection} navigation={spyNavigation}>
        <InboxView viewMode="board" rightPanel={rightPanel} onOpenTerminal={() => undefined} pinnedOpen={false} />
      </StoreProvider>,
    );
  });
  await act(async () => {
    socket.push(snapshot([
      session("A", 30),
      session("B", 20, { column: "queued" }),
      session("C", 10, { archived: true }),
    ]));
  });

  assert.ok(container.querySelector(".board-wrap"), "board mode renders the kanban canvas");
  assert.equal(container.querySelector(".board-wrap")?.getAttribute("tabindex"), "-1",
    "the canvas is programmatically focusable so the F6 list zone still has a landing spot");
  assert.equal(container.querySelector(".inbox-list"), null, "and not the list");
  assert.equal(container.querySelector(".inbox-splitter"), null, "the preview split belongs to list mode");
  assert.ok(container.querySelector(".inbox-tabs"), "the shared split tabs stay above the board");
  assert.equal(container.querySelectorAll(".board .card").length, 2,
    "archived sessions never reach the board columns");

  // The shared search narrows the board columns just as it narrows the list.
  const search = container.querySelector(".inbox-search input") as unknown as HTMLInputElement;
  await act(async () => {
    search.value = "Session A";
    fireDomEvent.change(search as never, { target: { value: "Session A" } as never });
  });
  await act(async () => { await Promise.resolve(); });
  assert.equal(container.querySelectorAll(".board .card").length, 1,
    "the toolbar query scopes board mode");
  search.focus();
  await act(async () => {
    search.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true,
    }) as never);
  });
  assert.equal(domWindow.document.activeElement, search,
    "Enter does not invent a selected-row focus model for the board");

  const toggle = container.querySelector(".sessions-view-toggle");
  assert.ok(toggle, "the List / Board toggle lives in the shared toolbar");
  const listOption = [...toggle!.querySelectorAll("button")]
    .find((option) => option.textContent === "List") as unknown as HTMLButtonElement;
  await act(async () => { listOption.click(); });
  assert.deepEqual(pushed.at(-1), { name: "inbox" },
    "switching modes navigates: the route is the mode");

});

test("row and card context menus share one surface, act on their target, and never navigate", async () => {
  mobileViewport = false;
  setWindowFocused(true);
  setVisibility("visible");
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "session-context-menu",
    runtimeKey: "session-context-menu:1",
    createSocket: () => socket,
    close() {},
  };
  const pushed: unknown[] = [];
  const archived: Array<[string, boolean]> = [];
  const client = {
    ...api,
    setArchived: async (id: string, value: boolean) => {
      archived.push([id, value]);
      const updated = { ...session("A", 30), id, archived: value };
      return updated;
    },
  } as unknown as ApiClient;
  const spyNavigation: ViewNavigation = {
    current: () => ({ name: "inbox" }),
    push: (view) => void pushed.push(view),
    listen: () => () => {},
  };

  const mountView = (viewMode: "list" | "board") => act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={spyNavigation}>
          <InboxView viewMode={viewMode} rightPanel={rightPanel} onOpenTerminal={() => undefined} pinnedOpen={false} />
        </StoreProvider>
      </ApiProvider>,
    );
  });

  await mountView("list");
  await act(async () => { socket.push(snapshot([session("A", 30), session("B", 20)])); });

  // Right-click opens on the TARGETED row, not the selection.
  const rowB = [...container.querySelectorAll<HTMLElement>(".inbox-row-shell")]
    .find((row) => row.textContent?.includes("Session B"))!;
  await act(async () => {
    rowB.dispatchEvent(new domWindow.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }) as never);
  });
  let menu = domWindow.document.querySelector('[role="menu"]') as unknown as HTMLElement;
  assert.ok(menu, "right-clicking a row opens its menu");
  assert.equal(menu.getAttribute("aria-label"), "Session Actions for Session B");
  assert.deepEqual(pushed, [], "opening the menu never navigates");

  // Archive acts on the right-clicked session with the existing archive semantics.
  await act(async () => {
    (menu.querySelector(".menu-danger") as unknown as HTMLButtonElement).click();
  });
  await act(async () => { await Promise.resolve(); });
  assert.deepEqual(archived, [["B", true]]);
  assert.equal(domWindow.document.querySelector('[role="menu"]'), null, "acting closes the menu");
  assert.deepEqual(pushed, [], "and still never navigates");

  // The platform keyboard interaction opens for the ACTIVE row.
  const rowA = [...container.querySelectorAll<HTMLElement>(".inbox-row")]
    .find((row) => row.textContent?.includes("Session A"))!;
  await act(async () => { rowA.click(); });
  const grid = container.querySelector(".inbox-list") as unknown as HTMLElement;
  await act(async () => {
    grid.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }) as never);
  });
  menu = domWindow.document.querySelector('[role="menu"]') as unknown as HTMLElement;
  assert.equal(menu?.getAttribute("aria-label"), "Session Actions for Session A",
    "Shift+F10 opens the menu on the focused grid's active row");
  await act(async () => {
    menu.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
  });
  assert.equal(domWindow.document.querySelector('[role="menu"]'), null);

  // Board mode: the card wires through the same opener.
  await mountView("board");
  const card = ([...domWindow.document.querySelectorAll(".board .card")] as unknown as HTMLElement[])
    .find((candidate) => candidate.textContent?.includes("Session A"))!;
  await act(async () => {
    card.dispatchEvent(new domWindow.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 120 }) as never);
  });
  menu = domWindow.document.querySelector('[role="menu"]') as unknown as HTMLElement;
  assert.equal(menu?.getAttribute("aria-label"), "Session Actions for Session A",
    "a board card opens the same menu");
  assert.equal([...menu.querySelectorAll('[role="menuitem"]')].at(0)?.textContent, "Rename Session…");
  await act(async () => {
    (domWindow.document.querySelector(".menu-backdrop") as unknown as HTMLElement).click();
  });
  assert.equal(domWindow.document.querySelector('[role="menu"]'), null);
  assert.deepEqual(pushed, [], "board-card menus never navigate either");

});

test("row and card context menus pin their exact target, reorder immediately, persist, and restore keyboard focus", async () => {
  mobileViewport = false;
  setWindowFocused(true);
  setVisibility("visible");
  saveKeySet(SESSION_PIN_KEY, new Set());
  cleanup(() => saveKeySet(SESSION_PIN_KEY, new Set()));
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "session-context-pin",
    runtimeKey: "session-context-pin:1",
    createSocket: () => socket,
    close() {},
  };
  const pushed: unknown[] = [];
  const spyNavigation: ViewNavigation = {
    current: () => ({ name: "inbox" }),
    push: (view) => void pushed.push(view),
    listen: () => () => {},
  };
  const mountView = (viewMode: "list" | "board") => act(async () => {
    root.render(
      <StoreProvider connection={connection} navigation={spyNavigation}>
        <InboxView viewMode={viewMode} rightPanel={rightPanel} onOpenTerminal={() => undefined} pinnedOpen={false} />
      </StoreProvider>,
    );
  });

  await mountView("list");
  await act(async () => { socket.push(snapshot([session("A", 30), session("B", 20)])); });
  assert.deepEqual(rowTitles(container), ["Session A", "Session B"]);
  assert.equal(selectedRowTitle(container), "Session A");

  // The menu target, not the currently selected row, owns the action.
  let rowB = [...container.querySelectorAll<HTMLElement>(".inbox-row-shell")]
    .find((row) => row.textContent?.includes("Session B"))!;
  await act(async () => {
    rowB.dispatchEvent(new domWindow.MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: 50, clientY: 60,
    }) as never);
  });
  let menu = domWindow.document.querySelector('[role="menu"]') as unknown as HTMLElement;
  const pin = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((item) => item.textContent === "Pin Session")!;
  await act(async () => { pin.click(); });
  assert.equal(domWindow.document.querySelector('[role="menu"]'), null, "pinning dismisses the menu");
  assert.deepEqual(rowTitles(container), ["Session B", "Session A"], "the targeted session moves immediately");
  assert.equal(selectedRowTitle(container), "Session A", "right-click pinning never selects its target");
  assert.deepEqual([...loadKeySet(SESSION_PIN_KEY)], ["B"], "pinning uses the existing browser persistence");
  const grid = container.querySelector(".inbox-list") as unknown as HTMLElement;
  assert.equal(domWindow.document.activeElement, grid, "a non-dialog action restores the collection focus");
  assert.deepEqual(pushed, [], "pinning never navigates into the target");

  // The platform keyboard interaction exposes the state-aware inverse action on the active row.
  rowB = [...container.querySelectorAll<HTMLElement>(".inbox-row")]
    .find((row) => row.textContent?.includes("Session B"))!;
  await act(async () => { rowB.click(); });
  await act(async () => {
    grid.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
      key: "F10", shiftKey: true, bubbles: true, cancelable: true,
    }) as never);
  });
  menu = domWindow.document.querySelector('[role="menu"]') as unknown as HTMLElement;
  assert.equal(menu.getAttribute("aria-label"), "Session Actions for Session B");
  await act(async () => {
    menu.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as never);
  });
  const focusedPin = domWindow.document.activeElement as unknown as HTMLButtonElement | null;
  assert.equal(focusedPin?.textContent, "Unpin Session", "the pin action is arrow-key reachable");
  await act(async () => { focusedPin!.click(); });
  assert.deepEqual(rowTitles(container), ["Session A", "Session B"]);
  assert.equal(loadKeySet(SESSION_PIN_KEY).size, 0);
  assert.equal(domWindow.document.activeElement, grid);

  // Board cards use the same action and preserve the canonical pin-aware order within a column.
  await mountView("board");
  const cardB = ([...domWindow.document.querySelectorAll(".board .card")] as unknown as HTMLElement[])
    .find((card) => card.textContent?.includes("Session B"))!;
  await act(async () => {
    cardB.dispatchEvent(new domWindow.MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: 200, clientY: 120,
    }) as never);
  });
  menu = domWindow.document.querySelector('[role="menu"]') as unknown as HTMLElement;
  await act(async () => {
    [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent === "Pin Session")!.click();
  });
  assert.deepEqual(
    [...domWindow.document.querySelectorAll(".board .card-title")].map((title) => title.textContent),
    ["Session B", "Session A"],
  );
  assert.deepEqual([...loadKeySet(SESSION_PIN_KEY)], ["B"]);
  assert.equal(domWindow.document.querySelector('[role="menu"]'), null);
  assert.deepEqual(pushed, []);
});

test("a touch long-press opens the row menu and suppresses the tap it rode in on", async () => {
  mobileViewport = false;
  setWindowFocused(true);
  setVisibility("visible");
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "session-long-press",
    runtimeKey: "session-long-press:1",
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

  try {
    // Desktop auto-selects the first snapshot row, so the guard is that the PRESSED row's
    // synthetic click does not steal that selection — the gesture opened a menu, not a tap.
    const before = selectedRowTitle(container);
    const rowButton = [...container.querySelectorAll<HTMLElement>(".inbox-row")]
      .find((row) => row.textContent?.includes("Session B"))!;
    await act(async () => {
      rowButton.dispatchEvent(new domWindow.PointerEvent("pointerdown", {
        bubbles: true, pointerId: 7, pointerType: "touch", clientX: 40, clientY: 50,
      } as never) as never);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    const menu = domWindow.document.querySelector('[role="menu"]');
    assert.equal((menu as unknown as HTMLElement | null)?.getAttribute("aria-label"), "Session Actions for Session B",
      "holding a touch on a row opens its menu");
    await act(async () => {
      rowButton.dispatchEvent(new domWindow.PointerEvent("pointerup", { bubbles: true, pointerId: 7, pointerType: "touch" } as never) as never);
      rowButton.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, cancelable: true }) as never);
    });
    assert.equal(selectedRowTitle(container), before, "the long-press gesture is not also a tap");
    assert.notEqual(selectedRowTitle(container), "Session B");
  } finally {
    mobileViewport = true;
  }
});

test("a long-press over a card's approval button opens the menu without approving", async () => {
  // Round-1 review P1: the release's synthetic click lands on the NESTED control, whose own
  // handler would run before a bubble-phase guard — a held finger must never approve.
  mobileViewport = false;
  setWindowFocused(true);
  setVisibility("visible");
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "long-press-approval",
    runtimeKey: "long-press-approval:1",
    createSocket: () => socket,
    close() {},
  };
  const approvals: string[] = [];
  const client = {
    ...api,
    approve: async (id: string) => { approvals.push(id); return session(id, 1); },
  } as unknown as ApiClient;
  try {
    await act(async () => {
      root.render(
        <ApiProvider client={client}>
          <StoreProvider connection={connection} navigation={navigation}>
            <InboxView viewMode="board" rightPanel={rightPanel} onOpenTerminal={() => undefined} pinnedOpen={false} />
          </StoreProvider>
        </ApiProvider>,
      );
    });
    await act(async () => {
      socket.push(snapshot([session("A", 30, {
        pendingApproval: {
          requestId: "req-1",
          kind: "tool",
          title: "Run npm test",
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        } as never,
      })]));
    });
    const approveButton = ([...domWindow.document.querySelectorAll(".card-approval button")] as unknown as HTMLElement[])
      .find((button) => button.textContent === "Allow")!;
    await act(async () => {
      approveButton.dispatchEvent(new domWindow.PointerEvent("pointerdown", {
        bubbles: true, pointerId: 9, pointerType: "touch", clientX: 300, clientY: 200,
      } as never) as never);
    });
    // Held well past both the 500ms fire and the old fire-anchored 700ms window: suppression
    // must pivot on release, not on when the timer fired (round-1 P2).
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1400)); });
    assert.ok(domWindow.document.querySelector('[role="menu"]'), "the held press opened the menu");
    await act(async () => {
      approveButton.dispatchEvent(new domWindow.PointerEvent("pointerup", { bubbles: true, pointerId: 9, pointerType: "touch" } as never) as never);
      approveButton.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, cancelable: true }) as never);
    });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(approvals, [], "the gesture asked for a menu, not an approval");
    assert.ok(domWindow.document.querySelector('[role="menu"]'), "and the menu is still the surface in charge");
  } finally {
    mobileViewport = true;
  }
});

test("a quick tap after a dismissed long-press still selects, and an archived target closes its menu", async () => {
  // Round-2 review P2s: the release grace must not swallow the NEXT legitimate tap, and a menu
  // whose session another client archives must close with a focus handoff.
  mobileViewport = false;
  setWindowFocused(true);
  setVisibility("visible");
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "long-press-followup",
    runtimeKey: "long-press-followup:1",
    createSocket: () => socket,
    close() {},
  };
  try {
    await act(async () => {
      root.render(
        <StoreProvider connection={connection} navigation={navigation}>
          <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} pinnedOpen={false} />
        </StoreProvider>,
      );
    });
    await act(async () => { socket.push(snapshot([session("A", 30), session("B", 20)])); });

    const rowButton = [...container.querySelectorAll<HTMLElement>(".inbox-row")]
      .find((row) => row.textContent?.includes("Session B"))!;
    await act(async () => {
      rowButton.dispatchEvent(new domWindow.PointerEvent("pointerdown", {
        bubbles: true, pointerId: 3, pointerType: "touch", clientX: 40, clientY: 50,
      } as never) as never);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    let menu = domWindow.document.querySelector('[role="menu"]') as unknown as HTMLElement;
    assert.ok(menu, "the press opened the menu");
    await act(async () => {
      rowButton.dispatchEvent(new domWindow.PointerEvent("pointerup", { bubbles: true, pointerId: 3, pointerType: "touch" } as never) as never);
      menu.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
    });
    assert.equal(domWindow.document.querySelector('[role="menu"]'), null);

    // Immediately (inside the old 700ms grace): a fresh short tap must act normally.
    await act(async () => {
      rowButton.dispatchEvent(new domWindow.PointerEvent("pointerdown", {
        bubbles: true, pointerId: 4, pointerType: "touch", clientX: 41, clientY: 51,
      } as never) as never);
      rowButton.dispatchEvent(new domWindow.PointerEvent("pointerup", { bubbles: true, pointerId: 4, pointerType: "touch" } as never) as never);
      rowButton.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, cancelable: true }) as never);
    });
    assert.equal(selectedRowTitle(container), "Session B",
      "a new press is a new intent; the previous grace must not swallow it");

    // Reopen, then archive the target from "another client": the menu closes and hands focus off.
    await act(async () => {
      rowButton.dispatchEvent(new domWindow.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 44, clientY: 55 }) as never);
    });
    assert.ok(domWindow.document.querySelector('[role="menu"]'));
    await act(async () => {
      socket.push({ type: "session_upsert", session: { ...session("B", 20), archived: true } });
    });
    assert.equal(domWindow.document.querySelector('[role="menu"]'), null,
      "an archived target is off the surface, so its menu closes");
    assert.notEqual(domWindow.document.activeElement, domWindow.document.body,
      "and dismissal hands focus to a durable surface, not <body>");
  } finally {
    mobileViewport = true;
  }
});

test("a cancelled press and a source-landed release click both leave the next backdrop tap live", async () => {
  // #543 round-1 P2: pointercancel synthesizes no click, and a release click landing on the
  // pressed element is consumed there — in both cases the FIRST real backdrop dismissal must
  // close the menu instead of being swallowed by a stale grace.
  mobileViewport = false;
  setWindowFocused(true);
  setVisibility("visible");
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "long-press-consume",
    runtimeKey: "long-press-consume:1",
    createSocket: () => socket,
    close() {},
  };
  const backdrop = () => domWindow.document.querySelector(".menu-backdrop") as unknown as HTMLElement | null;
  const pressRow = async (row: HTMLElement, pointerId: number) => {
    await act(async () => {
      row.dispatchEvent(new domWindow.PointerEvent("pointerdown", {
        bubbles: true, pointerId, pointerType: "touch", clientX: 40, clientY: 50,
      } as never) as never);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    assert.ok(domWindow.document.querySelector('[role="menu"]'), "the press opened the menu");
  };
  try {
    await act(async () => {
      root.render(
        <StoreProvider connection={connection} navigation={navigation}>
          <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} pinnedOpen={false} />
        </StoreProvider>,
      );
    });
    await act(async () => { socket.push(snapshot([session("A", 30), session("B", 20)])); });
    const rowButton = [...container.querySelectorAll<HTMLElement>(".inbox-row")]
      .find((row) => row.textContent?.includes("Session B"))!;

    // Case 1: pointercancel — no click will ever arrive, so no grace may linger.
    await pressRow(rowButton, 11);
    await act(async () => {
      rowButton.dispatchEvent(new domWindow.PointerEvent("pointercancel", { bubbles: true, pointerId: 11, pointerType: "touch" } as never) as never);
    });
    await act(async () => { backdrop()!.click(); });
    assert.equal(domWindow.document.querySelector('[role="menu"]'), null,
      "the first dismissal tap after a cancelled press must close the menu");

    // Case 2: the release click lands on the pressed element and is consumed THERE.
    await pressRow(rowButton, 12);
    await act(async () => {
      rowButton.dispatchEvent(new domWindow.PointerEvent("pointerup", { bubbles: true, pointerId: 12, pointerType: "touch" } as never) as never);
      rowButton.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, cancelable: true }) as never);
    });
    assert.ok(domWindow.document.querySelector('[role="menu"]'), "the source-landed click did not act");
    await act(async () => { backdrop()!.click(); });
    assert.equal(domWindow.document.querySelector('[role="menu"]'), null,
      "the singleton was spent on the source click, so the backdrop tap closes");
  } finally {
    mobileViewport = true;
  }
});

/**
 * Guards the teardown contract itself (#680).
 *
 * `mountedRoots` is drained by `afterEach`, so by the time any later test starts it must be empty
 * and the body must hold no leftover roots. Reintroducing per-test teardown — or dropping the hook
 * — leaves entries behind here, and the store's one-minute stall clock leaks with them, which is
 * what turned an assertion failure into a multi-minute stall.
 */
test("InboxView threads a family under its parent and t, Shift+T, p, and the arrows drive it (#896)", async () => {
  mobileViewport = false;
  setVisibility("visible");
  setWindowFocused(true);
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-thread-test",
    runtimeKey: "inbox-thread-test:1",
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
  const approval = { requestId: "ask", title: "Delete the old file?", options: [] };
  await act(async () => {
    socket.push(snapshot([
      session("Lone", 40),
      session("Parent", 30, { status: "running" }),
      session("Waiting", 20, { status: "input_required", pendingApproval: approval, parentSessionId: "Parent" }),
      session("Done", 10, { status: "completed", parentSessionId: "Parent" }),
    ]));
  });
  // The family leads: its blocked child outranks the newer, settled lone session, and the parent
  // is first inside its thread with the children indented under it.
  assert.deepEqual(rowTitles(container), ["Session Parent", "Session Waiting", "Session Done", "Session Lone"]);
  const shells = () => [...container.querySelectorAll<HTMLElement>(".inbox-row-shell")];
  assert.deepEqual(shells().map((shell) => shell.className.includes("thread-child")), [false, true, true, false]);
  assert.equal(container.querySelector(".inbox-thread-family-text")?.textContent, "2 Children · 1 Awaiting Input");
  assert.match(container.querySelector(".inbox-thread-family")?.className ?? "", /waiting/);
  const selectedTitle = () =>
    container.querySelector<HTMLElement>('.inbox-row-shell[aria-selected="true"] .inbox-row-title')?.textContent ?? null;
  const press = async (key: string, shiftKey = false) => {
    await act(async () => {
      domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
    });
  };
  container.querySelector<HTMLElement>(".inbox-list")!.focus();
  assert.equal(selectedTitle(), "Session Parent");

  await press("t");
  assert.deepEqual(rowTitles(container), ["Session Parent", "Session Lone"], "a collapsed parent's children leave the list");
  assert.equal(container.querySelector(".inbox-thread-toggle")?.getAttribute("aria-expanded"), "false");
  assert.equal(container.querySelector(".inbox-thread-family-text")?.textContent, "2 Children · 1 Awaiting Input",
    "the rollup still says a child is waiting while the thread is collapsed");
  assert.equal(container.querySelector(".inbox-order-update"), null, "hidden children are not a pending reorder");
  await act(async () => { socket.push({ type: "session_upsert", session: session("Lone", 45) }); });
  assert.deepEqual(rowTitles(container), ["Session Parent", "Session Lone"], "collapse survives a live update");
  await press("t");
  assert.deepEqual(rowTitles(container), ["Session Parent", "Session Waiting", "Session Done", "Session Lone"]);

  await press("j");
  assert.equal(selectedTitle(), "Session Waiting");
  await press("p");
  assert.equal(selectedTitle(), "Session Parent", "p selects the parent without collapsing");
  assert.equal(rowTitles(container).length, 4);
  await press("j");
  await press("t");
  assert.equal(selectedTitle(), "Session Parent", "t from a child collapses its thread and lands on the parent");
  assert.deepEqual(rowTitles(container), ["Session Parent", "Session Lone"]);
  await press("T", true);
  assert.equal(rowTitles(container).length, 4, "Shift+T expands every thread while any is collapsed");
  await press("T", true);
  assert.equal(rowTitles(container).length, 2, "Shift+T collapses every thread once all are expanded");

  await press("ArrowRight");
  assert.equal(rowTitles(container).length, 4, "Right expands a collapsed parent");
  await press("ArrowRight");
  assert.equal(selectedTitle(), "Session Waiting", "Right on an expanded parent selects its first child");
  await press("ArrowLeft");
  assert.equal(selectedTitle(), "Session Parent", "Left on a child selects the parent");
  await press("ArrowLeft");
  assert.equal(rowTitles(container).length, 2, "Left on an expanded parent collapses it");

  // The chevron and the family chip are the pointer path and never select the row.
  await press("j");
  assert.equal(selectedTitle(), "Session Lone");
  await act(async () => { container.querySelector<HTMLButtonElement>(".inbox-thread-toggle")!.click(); });
  assert.equal(rowTitles(container).length, 4);
  assert.equal(selectedTitle(), "Session Lone");
  await act(async () => { container.querySelector<HTMLElement>(".inbox-thread-family")!.click(); });
  assert.equal(rowTitles(container).length, 2);
  assert.equal(selectedTitle(), "Session Lone");
});

test("InboxView keeps a hidden selection on its nearest visible ancestor and Shift+T reaches hidden parents (#896)", async () => {
  mobileViewport = false;
  setVisibility("visible");
  setWindowFocused(true);
  // Collapse state persists per instance, and the previous test left a thread collapsed.
  saveKeySet(INBOX_COLLAPSED_THREADS_KEY, new Set());
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-thread-repair-test",
    runtimeKey: "inbox-thread-repair-test:1",
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
    socket.push(snapshot([
      session("Parent", 30, { status: "running" }),
      session("Child", 20, { status: "running", parentSessionId: "Parent" }),
      session("Grandchild", 10, { status: "running", parentSessionId: "Child" }),
      session("Lone", 5),
    ]));
  });
  const selectedTitle = () =>
    container.querySelector<HTMLElement>('.inbox-row-shell[aria-selected="true"] .inbox-row-title')?.textContent ?? null;
  const press = async (key: string, shiftKey = false) => {
    await act(async () => {
      domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
    });
  };
  container.querySelector<HTMLElement>(".inbox-list")!.focus();
  assert.deepEqual(rowTitles(container), ["Session Parent", "Session Child", "Session Grandchild", "Session Lone"]);

  // Shift+T collapses the root AND the inner parent; the second press must reopen both.
  await press("T", true);
  assert.deepEqual(rowTitles(container), ["Session Parent", "Session Lone"]);
  await press("T", true);
  assert.deepEqual(rowTitles(container), ["Session Parent", "Session Child", "Session Grandchild", "Session Lone"]);

  // An outside change hides the selected row inside a collapsed thread: the selection lands on
  // the nearest visible ancestor instead of vanishing.
  await press("j"); await press("j"); await press("j");
  assert.equal(selectedTitle(), "Session Lone");
  // t on the inner parent would toggle ITS thread; climb to the root and collapse from there.
  await press("k"); await press("k"); await press("k"); await press("t");
  assert.equal(selectedTitle(), "Session Parent");
  assert.deepEqual(rowTitles(container), ["Session Parent", "Session Lone"]);
  await press("j");
  assert.equal(selectedTitle(), "Session Lone");
  const previewTitle = () => container.querySelector<HTMLElement>(".session-preview-title")?.textContent ?? null;
  assert.equal(previewTitle(), "Session Lone");
  await act(async () => { socket.push({ type: "session_upsert", session: session("Lone", 5, { parentSessionId: "Parent" }) }); });
  assert.deepEqual(rowTitles(container), ["Session Parent"]);
  assert.equal(selectedTitle(), "Session Parent", "the hidden selection surfaces on its collapsed parent");
  assert.equal(previewTitle(), "Session Parent", "the preview and its actions follow the same projected row");
  await press("t");
  assert.deepEqual(rowTitles(container), ["Session Parent", "Session Child", "Session Grandchild", "Session Lone"]);
  assert.equal(selectedTitle(), "Session Lone", "expanding restores the persisted selection");
  assert.equal(previewTitle(), "Session Lone");
});

test("an expanded child inside a collapsed thread is the session marked seen, not its projected parent (#896)", async () => {
  mobileViewport = false;
  setVisibility("visible");
  setWindowFocused(true);
  saveKeySet(INBOX_COLLAPSED_THREADS_KEY, new Set(["Parent"]));
  saveSeen({});
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-thread-seen-test",
    runtimeKey: "inbox-thread-seen-test:1",
    createSocket: () => socket,
    close() {},
  };
  // A deep link opened the child while its parent's thread is collapsed: the list projects the
  // selection onto the parent, but the reader is looking at the child.
  await act(async () => {
    root.render(
      <StoreProvider connection={connection} navigation={navigation}>
        <InboxView expandedSessionId="Lone" rightPanel={rightPanel} onOpenTerminal={() => undefined} pinnedOpen={false} />
      </StoreProvider>,
    );
  });
  await act(async () => {
    socket.push(snapshot([
      session("Parent", 30, { status: "running" }),
      session("Lone", 20, { status: "running", parentSessionId: "Parent" }),
    ]));
  });
  assert.equal(container.querySelector(".session-preview-title")?.textContent ?? container.textContent?.includes("Session Lone"), true);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_700)); });
  const seen = loadSeen();
  assert.ok("Lone" in seen, "the opened child is marked seen");
  assert.ok(!("Parent" in seen), "the projected parent is not marked seen in its place");
  saveKeySet(INBOX_COLLAPSED_THREADS_KEY, new Set());
});

test("every mounted root is torn down before the next test starts", () => {
  assert.deepEqual(mountedRoots, [], "a previous test left a React root mounted");
  assert.equal(
    domWindow.document.body.innerHTML,
    "",
    "a previous test left nodes in the body, so portalled menus and dialogs outlive their test",
  );
});
