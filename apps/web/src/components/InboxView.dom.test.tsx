import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  PROTOCOL_VERSION,
  type ControlPlaneToUi,
  type ProjectView,
  type SessionReminderView,
  type SessionView,
  type SetSessionReminderRequest,
  type UiSnapshotMessage,
} from "@wollipog/protocol";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { filterInboxSplitsForReminderMode, InboxView } from "./InboxView.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { INBOX_COLLAPSED_THREADS_KEY, type InboxSplit } from "../inbox.js";
import { loadKeySet, saveKeySet, SESSION_PIN_KEY } from "../pins.js";
import { loadSeen, saveSeen } from "../sessions-seen.js";
import type { RightPanelState } from "./RightPanel.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
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

function mountTestRoot(): { container: HTMLDivElement; mountPoint: HTMLDivElement; root: ReturnType<typeof createRoot> } {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  const entry = { root, container };
  mountedRoots.push(entry);
  // The shared cleanup drains disposers newest-first and guards each one, so a teardown that throws
  // cannot strand the roots behind it — the property rounds 1 and 2 of #684 were about.
  cleanup(async () => {
    const at = mountedRoots.indexOf(entry);
    if (at >= 0) mountedRoots.splice(at, 1);
    await act(async () => { root.unmount(); });
    mountPoint.remove();
  });
  return { container, mountPoint, root };
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
    // This fixture instant represents meaningful work, not a streamed delta. Tests for chatter
    // keep this summary unchanged while updating the event/activity fields separately.
    attention: { version: 1, meaningfulAt: lastEventAt, result: null, acknowledgedRevision: null,
      humanActions: overrides.status === "input_required" || overrides.pendingApproval
        ? [{ requestId: overrides.pendingApproval?.requestId ?? "input", rank: 3, requestedAt: lastEventAt }] : [] },
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

/** The page header's Snoozed toggle (#2159). */
function snoozedToggle(container: HTMLDivElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(".page-header .page-action[aria-pressed]")!;
}

/** The Snoozed toggle's plain count, or null when it shows none (at zero). */
function snoozedCount(container: HTMLDivElement): string | null {
  return snoozedToggle(container).querySelector(".count")?.textContent ?? null;
}

/** The selected tab's count: active sessions with Snoozed off, snoozed ones with it on. */
function selectedTabCount(container: HTMLDivElement): string | undefined {
  return container.querySelector('.tabs-bar .tab[aria-selected="true"] > .count')?.textContent ?? undefined;
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
            <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
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
          <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
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
        <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
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
  const projectTab = [...container.querySelectorAll<HTMLElement>(".tabs-bar .tab")]
    .find((tab) => tab.textContent?.includes("Project One"));
  assert.equal(projectTab?.querySelector(".count")?.textContent, "7");
  await act(async () => { projectTab!.click(); });
  assert.equal(selectedTabCount(container), "7");
  assert.equal(snoozedCount(container), null, "Snoozed shows no count at zero");

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
        <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
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
  assert.equal(selectedTabCount(container), "3");
  assert.equal(snoozedCount(container), "2");

  const alphaTab = [...container.querySelectorAll<HTMLButtonElement>(".tabs-bar .tab")]
    .find((tab) => tab.textContent?.includes("Alpha"))!;
  await act(async () => { alphaTab.click(); });
  assert.equal(selectedTabCount(container), "1");
  assert.equal(snoozedCount(container), "1");

  await act(async () => {
    socket.push({
      type: "session_reminder_upsert",
      userId: "user",
      reminder: reminder(alphaActive.id),
    });
  });
  assert.equal(selectedTabCount(container), "0");
  assert.equal(snoozedCount(container), "2");

  const betaTab = [...container.querySelectorAll<HTMLButtonElement>(".tabs-bar .tab")]
    .find((tab) => tab.textContent?.includes("Beta"))!;
  await act(async () => { betaTab.click(); });
  assert.equal(selectedTabCount(container), "2");
  assert.equal(snoozedCount(container), "1");
  // With Snoozed on, the tab counts are snoozed counts.
  await act(async () => { snoozedToggle(container).click(); });
  assert.equal(snoozedToggle(container).getAttribute("aria-pressed"), "true");
  assert.equal(selectedTabCount(container), "1");

});

/** A tab's accessible name as a screen reader builds it: its text, skipping aria-hidden subtrees. */
function accessibleText(node: Node): string {
  if (node.nodeType === domWindow.Node.TEXT_NODE) return node.textContent ?? "";
  if ((node as Element).getAttribute?.("aria-hidden") === "true") return "";
  return [...node.childNodes].map(accessibleText).join("");
}

test("the Sessions header's New Session uses the active tab's preset, and ⋯ explains an unavailable New Project…", async () => {
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-page-header-test",
    runtimeKey: "inbox-page-header-test:1",
    createSocket: () => socket,
    close() {},
  };
  const presets: unknown[] = [];
  let shortcutsOpened = 0;
  await act(async () => {
    root.render(
      <StoreProvider connection={connection} navigation={navigation}>
        <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined}
          onNewSession={(preset) => presets.push(preset)} onOpenShortcuts={() => { shortcutsOpened += 1; }} />
      </StoreProvider>,
    );
  });
  const project: ProjectView = {
    id: "project-1",
    name: "Project One",
    hidden: false,
    locations: [],
    activeSessionCount: 1,
    unarchivedSessionCount: 1,
    totalSessionCount: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  await act(async () => {
    socket.push({ ...snapshot([session("project-session", 10, { projectId: project.id })]), projects: [project],
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true } });
  });

  const header = container.querySelector(".page-header")!;
  assert.equal(header.querySelector("h1")?.textContent, "Sessions");
  assertNoDomNode(header.querySelector(".page-action[aria-pressed]"), "no Snoozed toggle without reminder support");
  const newSession = header.querySelector<HTMLButtonElement>(".page-primary")!;
  assert.equal(accessibleText(newSession), "New Session", "the keycap is not part of the name");
  await act(async () => { newSession.click(); });
  assert.deepEqual(presets, [undefined], "All has no preset");
  const projectTab = [...container.querySelectorAll<HTMLButtonElement>(".tabs-bar .tab")]
    .find((tab) => tab.textContent?.includes("Project One"))!;
  await act(async () => { projectTab.click(); });
  await act(async () => { newSession.click(); });
  assert.deepEqual(presets.at(-1), { projectId: "project-1" }, "a Project tab presets its Project");

  const openMenu = async () => {
    await act(async () => { header.querySelector<HTMLButtonElement>('[aria-label="More Actions"]')!.click(); });
    return container.querySelector('[role="menu"][aria-label="More Actions"]')!;
  };
  let menu = await openMenu();
  const items = () => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  assert.deepEqual(items().map((item) => item.querySelector(".menu-text")?.textContent), ["New Project…", "Keyboard Shortcuts"]);
  assert.equal(items()[0]!.disabled, false);
  await act(async () => { items()[1]!.click(); });
  assert.equal(shortcutsOpened, 1);

  // Projects unavailable: New Project… stays in the menu, disabled, with its reason as its second line.
  await act(async () => { socket.push(snapshot([session("project-session", 10)])); });
  menu = await openMenu();
  const newProject = items()[0]!;
  assert.equal(newProject.disabled, true);
  const reason = newProject.querySelector(".menu-desc")!;
  assert.equal(reason.textContent, "New Project is unavailable on this connection.");
  assert.equal(newProject.getAttribute("aria-describedby"), reason.id, "the reason describes the item");
  assert.equal(newProject.getAttribute("title"), null, "the reason is not a tooltip");
});

test("group tabs draw blocked and stalled counts as aria-hidden badges and name them in words (#2031)", async () => {
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-attention-tabs-test",
    runtimeKey: "inbox-attention-tabs-test:1",
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
  const alpha = project("alpha", "Alpha", 3);
  const beta = project("beta", "Beta", 1);
  const now = Date.now();

  await act(async () => {
    root.render(
      <StoreProvider connection={connection} navigation={navigation}>
        <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
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
      },
      runners: [],
      boxes: [],
      sessions: [
        // Blocked is heartbeat-busy too, so these are recent enough not to count as stalled.
        session("alpha-blocked-1", now, { projectId: alpha.id, status: "input_required" }),
        session("alpha-blocked-2", now - 1, { projectId: alpha.id, status: "input_required" }),
        // Running with nothing heard since the epoch: past the stall threshold at snapshot time.
        session("alpha-stalled", 1, { projectId: alpha.id, status: "running", updatedAt: 1 }),
        session("beta-idle", 10, { projectId: beta.id }),
      ],
      projects: [alpha, beta],
      runs: [],
      pods: [],
    });
  });
  const tab = (name: string) => [...container.querySelectorAll<HTMLElement>(".tabs-bar .tab")]
    .find((candidate) => candidate.textContent?.startsWith(name))!;

  const alphaTab = tab("Alpha");
  const badges = [...alphaTab.querySelectorAll(".count-badge")].map((badge) => ({
    classes: badge.className,
    text: badge.textContent,
    hidden: badge.getAttribute("aria-hidden"),
    label: badge.getAttribute("aria-label"),
  }));
  assert.deepEqual(badges, [
    { classes: "count-badge", text: "2", hidden: "true", label: null },
    { classes: "count-badge danger", text: "1", hidden: "true", label: null },
  ]);
  assert.equal(accessibleText(alphaTab), "Alpha3, 2 Blocked, 1 Stalled");

  const betaTab = tab("Beta");
  assertNoDomNode(betaTab.querySelector(".count-badge"), "a tab with nothing blocked or stalled draws no badge");
  assert.equal(accessibleText(betaTab), "Beta1");
  assert.doesNotMatch(accessibleText(betaTab), /Blocked|Stalled/);

  // #2180: the tablist names what it holds, and the tooltip gives the full name, the breakdown in
  // sentence case and the shortcut. The stalled session is also running.
  assert.equal(alphaTab.closest('[role="tablist"]')?.getAttribute("aria-label"), "Session Groups");
  assert.equal(alphaTab.title, "Alpha\n3 sessions: 2 need you, 1 stalled, 1 running\nSwitch group (Tab / Shift+Tab)");
  assert.equal(betaTab.title, "Beta\n1 session\nSwitch group (Tab / Shift+Tab)");
});

test("two groups with one name each name their machine in the tab, All Groups and their accessible names (#2180)", async () => {
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-duplicate-groups-test",
    runtimeKey: "inbox-duplicate-groups-test:1",
    createSocket: () => socket,
    close() {},
  };
  const project = (id: string, name: string, runnerId: string): ProjectView => ({
    id,
    name,
    hidden: false,
    locations: [{
      id: `${id}-location`, projectId: id, runnerId, workspaceId: `${id}-workspace`, name, path: `/src/${id}`,
      source: "reported", availability: "available", isDefault: true, createdAt: 1, updatedAt: 1,
    }],
    activeSessionCount: 1,
    unarchivedSessionCount: 1,
    totalSessionCount: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  const runner = (runnerId: string, displayName: string) => ({
    runnerId, displayName, hostname: `${runnerId}.local`, os: "linux" as const, version: "1", status: "online" as const,
    agents: [], workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: PROTOCOL_VERSION,
  });

  await act(async () => {
    root.render(
      <StoreProvider connection={connection} navigation={navigation}>
        <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
      </StoreProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
      runners: [runner("runner-a", "Studio Mac"), runner("runner-b", "Build Server 02")],
      boxes: [],
      sessions: [
        session("docs-a", 3, { projectId: "docs-a", runnerId: "runner-a" }),
        session("docs-b", 2, { projectId: "docs-b", runnerId: "runner-b" }),
        session("api", 1, { projectId: "api", runnerId: "runner-a" }),
      ],
      projects: [project("docs-a", "Docs Site", "runner-a"), project("docs-b", "Docs Site", "runner-b"), project("api", "API", "runner-a")],
      runs: [],
      pods: [],
    });
  });

  const tabs = [...container.querySelectorAll<HTMLElement>(".tabs-bar .tab")];
  assert.deepEqual(tabs.map(accessibleText), [
    "All3", "API1", "Docs Site on Studio Mac1", "Docs Site on Build Server 021", "No Project0",
  ]);
  const docsTab = tabs[3]!;
  assert.equal(docsTab.querySelector(".group-name-machine")?.textContent, " on Build Server 02",
    "the machine is quiet text inside the capped label");
  assert.match(docsTab.title, /^Docs Site on Build Server 02\n/);
  assertNoDomNode(tabs[1]!.querySelector(".group-name-machine"), "a unique name stays bare");

  const allGroups = container.querySelector<HTMLButtonElement>('.tabs-bar > button[aria-label="All Groups"]')!;
  assert.equal(allGroups.title, "All Groups");
  await act(async () => { allGroups.click(); });
  const menu = domWindow.document.querySelector('[role="menu"][aria-label="All Groups"]')!;
  const rows = [...menu.querySelectorAll('[role="menuitemradio"]')] as unknown as HTMLButtonElement[];
  assert.deepEqual(rows.map((row) => row.getAttribute("aria-label")), [
    "All, 3", "API, 1", "Docs Site on Studio Mac, 1", "Docs Site on Build Server 02, 1", "No Project, 0",
  ]);
  assert.deepEqual(rows.map((row) => row.getAttribute("aria-checked")), ["true", "false", "false", "false", "false"]);

  // Choosing a row selects its tab and returns focus to All Groups.
  await act(async () => { rows[3]!.click(); });
  assertNoDomNode(domWindow.document.querySelector('[role="menu"][aria-label="All Groups"]'), "choosing closes the menu");
  assert.equal(container.querySelector('.tabs-bar .tab[aria-selected="true"]'), docsTab);
  assert.equal(domWindow.document.activeElement, allGroups);
  assert.deepEqual(rowTitles(container), ["Session docs-b"]);
});

// #2051: a durable Project archive runs on the server over every unarchived session, so the
// confirmation counts and lists the snoozed ones hidden from Active, and the Active ones from Snoozed.
test("a Project's archive confirmation lists its sessions from Active and Snoozed alike", async () => {
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-project-archive-scope-test",
    runtimeKey: "inbox-project-archive-scope-test:1",
    createSocket: () => socket,
    close() {},
  };
  const alpha: ProjectView = {
    id: "alpha",
    name: "Alpha",
    hidden: false,
    locations: [],
    activeSessionCount: 2,
    unarchivedSessionCount: 2,
    totalSessionCount: 2,
    createdAt: 1,
    updatedAt: 1,
  };
  const active = session("alpha-active", 50, { projectId: alpha.id });
  const snoozed = session("alpha-snoozed", 40, { projectId: alpha.id });

  await act(async () => {
    root.render(
      <StoreProvider connection={connection} navigation={navigation}>
        <FeedbackProvider>
          <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
        </FeedbackProvider>
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
      sessions: [active, snoozed],
      projects: [alpha],
      reminders: [reminder(snoozed.id)],
      runs: [],
      pods: [],
    });
  });
  const alphaTab = [...container.querySelectorAll<HTMLButtonElement>(".tabs-bar .tab")]
    .find((tab) => tab.textContent?.includes("Alpha"))!;
  await act(async () => { alphaTab.click(); });
  const body = domWindow.document.body as unknown as HTMLElement;
  const confirmation = async () => {
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Alpha Actions"]')!;
    await act(async () => { trigger.click(); });
    const archive = [...body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => /^Archive/u.test(item.textContent ?? ""))!;
    await act(async () => { archive.click(); });
    const dialog = body.querySelector<HTMLElement>('[role="dialog"]')!;
    const shown = {
      message: dialog.querySelector(".confirmation-message")?.textContent ?? "",
      rows: [...dialog.querySelectorAll(".confirmation-rows .row-title")].map((row) => row.textContent),
    };
    const cancel = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!;
    await act(async () => { cancel.click(); });
    return shown;
  };

  const fromActive = await confirmation();
  assert.match(fromActive.message, /^All 2 sessions in “Alpha”/);
  assert.deepEqual(fromActive.rows, ["Session alpha-active", "Session alpha-snoozed"]);

  await act(async () => { snoozedToggle(container).click(); });
  const fromSnoozed = await confirmation();
  assert.match(fromSnoozed.message, /^All 2 sessions in “Alpha”/);
  assert.deepEqual(fromSnoozed.rows, ["Session alpha-active", "Session alpha-snoozed"]);
});

test("the tab the URL names survives widening from a phone to a desktop that remembered another", async () => {
  // Widening restores the desktop's remembered Inbox state, which can name another tab than the URL
  // does; the URL is what Back and reload return to, so the visible tab has to follow it (§10.1).
  mobileViewport = false;
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-route-resize-test",
    runtimeKey: "inbox-route-resize-test:1",
    createSocket: () => socket,
    close() {},
  };
  const pushed: Array<{ name: string; split?: string | null }> = [];
  const spyNavigation: ViewNavigation = {
    current: () => ({ name: "inbox" }),
    push: (view) => void pushed.push(view as { name: string; split?: string | null }),
    listen: () => () => {},
  };
  const project = (id: string, name: string): ProjectView => ({
    id, name, hidden: false, locations: [], activeSessionCount: 1, unarchivedSessionCount: 1,
    totalSessionCount: 1, createdAt: 1, updatedAt: 1,
  });
  const render = (routeSplit?: string | null) => root.render(
    <StoreProvider connection={connection} navigation={spyNavigation}>
      <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} routeSplit={routeSplit} />
    </StoreProvider>,
  );
  await act(async () => { render(); });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
      runners: [],
      boxes: [],
      sessions: [session("alpha-one", 20, { projectId: "alpha" }), session("beta-one", 10, { projectId: "beta" })],
      projects: [project("alpha", "Alpha"), project("beta", "Beta")],
      runs: [],
      pods: [],
    });
  });
  const tab = (name: string) => [...container.querySelectorAll<HTMLButtonElement>(".tabs-bar .tab")]
    .find((candidate) => candidate.textContent?.includes(name))!;
  const selected = () => container.querySelector('.tabs-bar .tab[aria-selected="true"]')?.textContent ?? "";

  // The desktop remembers Alpha.
  await act(async () => { tab("Alpha").click(); });
  assert.match(selected(), /Alpha/);

  // On a phone, Beta is chosen and the URL names it.
  await act(async () => {
    mobileViewport = true;
    domWindow.dispatchEvent(new domWindow.Event("resize"));
  });
  await act(async () => { tab("Beta").click(); });
  const betaKey = pushed.at(-1)?.split;
  assert.ok(typeof betaKey === "string", "choosing a tab writes it to the URL");
  await act(async () => { render(betaKey); });
  assert.match(selected(), /Beta/);

  // Widening restores the desktop's Alpha, and the URL's Beta wins.
  await act(async () => {
    mobileViewport = false;
    domWindow.dispatchEvent(new domWindow.Event("resize"));
  });
  assert.match(selected(), /Beta/, "the visible tab is the one the URL names");
  await act(async () => { root.unmount(); });
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
  assert.equal(selectedTabCount(container), "1");
  assert.equal(snoozedCount(container), "6");
  assert.doesNotMatch(container.textContent ?? "", /Background Work Lost|Result Pending/);

  await act(async () => { snoozedToggle(container).click(); });
  assert.deepEqual(rowTitles(container), [
    "Session input", "Session watchdog", "Session orphaned", "Session omitted", "Session ordinary", "Session failed",
  ]);
  assert.match(container.textContent ?? "", /Background Work Lost/);
  assert.match(container.textContent ?? "", /Result Pending/);
  assert.ok(container.querySelector('.inbox-row [aria-label="Status: Background Work Lost"]'));
  const watchdogPill = container.querySelector('.inbox-row [aria-label="Status: Result Pending"]');
  assert.ok(watchdogPill);
  // A result on its way back reads as working, not as something that needs the user.
  assert.ok(watchdogPill.classList.contains("t-info"));
  assert.equal(watchdogPill.classList.contains("t-warning"), false);

  await act(async () => { snoozedToggle(container).click(); });
  await renderView("board");
  assert.deepEqual([...container.querySelectorAll(".card")].map((card) => card.textContent?.includes("Session unsnoozed")), [true]);
  assertNoDomNode(container.querySelector('.card [aria-label="Reminder: Snoozed"]'));

  await act(async () => { snoozedToggle(container).click(); });
  assert.ok([...container.querySelectorAll(".card")].some((card) => card.textContent?.includes("Session orphaned")));
  assert.ok(container.querySelector('.card [aria-label="Attention: Background Work Lost"]'));
  const boardWatchdogPill = container.querySelector('.card [aria-label^="Background Work: Result Pending."]');
  assert.ok(boardWatchdogPill);
  assert.ok(boardWatchdogPill.classList.contains("t-info"));
  assert.equal(boardWatchdogPill.classList.contains("t-warning"), false);
  assert.ok(container.querySelector('.card [aria-label="Reminder: Snoozed"]'));

  await act(async () => {
    socket.push({ type: "session_upsert", session: { ...orphaned, backgroundWorkState: "resumed", updatedAt: 80 } });
  });
  assert.ok([...container.querySelectorAll(".card")].some((card) => card.textContent?.includes("Session orphaned")),
    "clearing attention must leave the pending reminder in Snoozed");
  assertNoDomNode(container.querySelector('.card [aria-label="Attention: Background Work Lost"]'));
  assert.equal(snoozedCount(container), "6");

  await act(async () => {
    socket.push({ type: "session_reminder_removed", userId: "user", sessionId: ordinary.id });
  });
  assert.equal([...container.querySelectorAll(".card")].some((card) => card.textContent?.includes("Session ordinary")), false,
    "removing a reminder immediately removes the session from Snoozed");
  assert.equal(selectedTabCount(container), "5");
  assert.equal(snoozedCount(container), "5");

  await act(async () => { snoozedToggle(container).click(); });
  assert.ok([...container.querySelectorAll(".card")].some((card) => card.textContent?.includes("Session ordinary")),
    "removing the reminder returns the idle session without navigation");
  assert.equal([...container.querySelectorAll(".card")].some((card) => card.textContent?.includes("Session orphaned")), false,
    "an attention update must not leak a pending reminder back into Active");
  assert.equal(selectedTabCount(container), "2");
  assert.equal(snoozedCount(container), "5");

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
        />
      </StoreProvider>,
    );
  });
  await act(async () => { socket.push(snapshot([session("A", 30), session("B", 20)])); });
  assert.deepEqual(rowTitles(container), ["Session A", "Session B"]);
  // An idle row shows no badge (#2209), and never the retired Diff Ready words.
  assert.doesNotMatch(container.textContent ?? "", /Awaiting Prompt/);
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
  // Attention outranks lifecycle (§11.1), so the question's pill is the whole proof.
  assert.match(container.textContent ?? "", /Answer Required/);
  assertNoDomNode(container.querySelector(".inbox-order-update"),
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
        <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
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
  // status the same upsert carried is what shows it was applied while the order was held. Attention
  // outranks lifecycle (§11.1), so it shows as the attention pill rather than "Awaiting Input".
  assert.match(container.textContent ?? "", /Input Required/);

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
  assert.equal(applyOrder.nextElementSibling, container.querySelector(".inbox-search"),
    "the conditional button leads Search so showing it cannot move the field (#1675)");
  assert.match(container.textContent ?? "", /A newer Sessions order is available/);
  await act(async () => { applyOrder.click(); });
  assert.deepEqual(rowTitles(container), ["Session B", "Session C", "Session A"]);
  assert.match(
    container.querySelector<HTMLElement>('.inbox-row-shell[aria-selected="true"]')?.textContent ?? "",
    /Session B/,
    "manual reordering preserves selection by session identity",
  );
  assertNoDomNode(container.querySelector(".inbox-order-update"), "the indicator clears after adoption");
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
  assertNoDomNode(container.querySelector(".inbox-order-update"),
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
        <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
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
  assertNoDomNode(container.querySelector(".inbox-order-update"),
    "a stale selected-id placeholder is not a visible order difference");
  assert.doesNotMatch(container.textContent ?? "", /A newer Sessions order is available/);

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
        <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
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
        <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
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

  await act(async () => { snoozedToggle(container).click(); });
  await act(async () => { container.querySelector<HTMLButtonElement>(".inbox-row")!.click(); });
  const snooze = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Snooze"]')]
    .at(0)!;
  assert.ok(snooze);
  await act(async () => { snooze.click(); });
  // A timed reminder opens on Custom…, its Snooze Until field holding the stored words (#2181).
  const expression = container.querySelector<HTMLInputElement>("#snooze-expression")!;
  const returnEarly = () => container.querySelector<HTMLInputElement>('.snooze-outcome .checkbox input[type="checkbox"]')!;
  await act(async () => {
    expression.value = "tomorrow 3pm";
    fireDomEvent.change(expression);
    returnEarly().click();
    expression.focus();
  });
  const draftSummary = container.querySelector(".snooze-summary")?.textContent;

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

  assert.equal(domWindow.document.activeElement, expression);
  assert.equal(expression.value, "tomorrow 3pm");
  assert.equal(returnEarly().checked, false);
  assert.equal(container.querySelector(".snooze-summary")?.textContent, draftSummary);
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /updated in another client/i);
  const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  assert.equal(submit.disabled, false);
  assert.equal(submit.getAttribute("aria-disabled"), "true");

  const cancel = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "Cancel")!;
  await act(async () => { cancel.click(); });
  await act(async () => { snooze.click(); });
  assert.equal(container.querySelector<HTMLInputElement>("#snooze-expression")?.value, "2099-05-06T07:45");
  assertNoDomNode(container.querySelector('[role="alert"]'), "closing still discards the local draft normally");

});

test("a 409 reconciles the open Snooze dialog without WebSocket delivery", async () => {
  mobileViewport = false;
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-reminder-read-reconciliation-test",
    runtimeKey: "inbox-reminder-read-reconciliation-test:1",
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
  const updated: SessionReminderView = {
    ...original,
    scheduledFor: Date.now() + 172_800_000,
    timeZone: "Asia/Tokyo",
    originalExpression: "2099-05-06T07:45",
    wakePolicy: "regardless",
    revision: 2,
    updatedAt: 2,
  };
  const writes: SetSessionReminderRequest[] = [];
  let reads = 0;
  const client = {
    ...api,
    setReminder: async (_sessionId: string, request: SetSessionReminderRequest) => {
      writes.push(request);
      if (writes.length === 1) throw new ApiError("reminder changed in another client", 409);
      return { ...updated, ...request, revision: 3, updatedAt: 3 };
    },
    sessionReminder: async () => { reads++; return { reminder: updated }; },
  } as ApiClient;

  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
        </StoreProvider>
      </ApiProvider>,
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
  await act(async () => { snoozedToggle(container).click(); });
  await act(async () => { container.querySelector<HTMLButtonElement>(".inbox-row")!.click(); });
  const snooze = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Snooze"]')].at(0)!;
  await act(async () => { snooze.click(); });
  const expression = container.querySelector<HTMLInputElement>("#snooze-expression")!;
  await act(async () => {
    expression.value = "tomorrow 3pm";
    fireDomEvent.change(expression);
    expression.focus();
    container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(writes.length, 1);
  assert.equal(reads, 1);
  assert.equal(expression.value, "tomorrow 3pm");
  assert.equal(domWindow.document.activeElement, expression);
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /updated in another client/i);

  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Reload Reminder")!.click();
  });
  assert.equal(expression.value, "2099-05-06T07:45");
  assert.equal(domWindow.document.activeElement, expression);
  await act(async () => { container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  assert.equal(writes.length, 2);
  assert.equal(writes[1]?.expectedRevision, 2);
  assert.equal(writes[1]?.expectedReminderId, "reminder-original");
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
        <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
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
  assertNoDomNode(container.querySelector(".inbox-list"));
  assert.equal(container.querySelector(".inbox-no-matches .state-title")?.textContent, "No Matches");

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
        <InboxView viewMode="board" rightPanel={rightPanel} onOpenTerminal={() => undefined} />
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
  assertNoDomNode(container.querySelector(".inbox-list"), "and not the list");
  assertNoDomNode(container.querySelector(".inbox-splitter"), "the preview split belongs to list mode");
  assert.ok(container.querySelector(".tabs-bar"), "the shared split tabs stay above the board");
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

  const toggle = container.querySelector('[role="radiogroup"][aria-label="Sessions View"]');
  assert.ok(toggle?.closest(".page-header .page-controls"), "the List / Board toggle lives in the page header's controls slot");
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
          <InboxView viewMode={viewMode} rightPanel={rightPanel} onOpenTerminal={() => undefined} />
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
    (menu.querySelector(".menu-item.danger") as unknown as HTMLButtonElement).click();
  });
  await act(async () => { await Promise.resolve(); });
  assert.deepEqual(archived, [["B", true]]);
  assertNoDomNode(domWindow.document.querySelector('[role="menu"]'), "acting closes the menu");
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
  assertNoDomNode(domWindow.document.querySelector('[role="menu"]'));

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
  assert.equal([...menu.querySelectorAll('[role="menuitem"]')].at(0)?.textContent, "Reply");
  await act(async () => {
    (domWindow.document.querySelector(".menu-backdrop") as unknown as HTMLElement).click();
  });
  assertNoDomNode(domWindow.document.querySelector('[role="menu"]'));
  assert.deepEqual(pushed, [], "board-card menus never navigate either");

});

for (const outcome of [
  { archiveStatus: undefined, message: "Session archived.", tone: "t-success", icon: "lucide-circle-check", undo: true },
  { archiveStatus: "stop_pending" as const, message: "Archiving. The session is still stopping.", tone: "t-info", icon: "lucide-info", undo: true },
  // The Sessions list has never offered Undo after a failed stop; Retry Stop is the recovery.
  { archiveStatus: "stop_failed" as const, message: "The stop failed, so the session may still be running.", tone: "t-warning", icon: "lucide-triangle-alert", undo: false },
]) {
  test(`archiving from the Sessions list shows a ${outcome.tone} toast for ${outcome.archiveStatus ?? "a finished archive"} (#2333)`, async () => {
    mobileViewport = false;
    setWindowFocused(true);
    setVisibility("visible");
    const { container, root } = mountTestRoot();
    const socket = new FakeSocket();
    const connection: UiConnectionRuntime = {
      instanceId: "inbox-archive-tone",
      runtimeKey: "inbox-archive-tone:1",
      createSocket: () => socket,
      close() {},
    };
    const archived: Array<[string, boolean]> = [];
    const client = {
      ...api,
      setArchived: async (id: string, value: boolean) => {
        archived.push([id, value]);
        return { ...session(id, 20), archived: value, ...(value && outcome.archiveStatus ? { archiveStatus: outcome.archiveStatus } : {}) };
      },
    } as unknown as ApiClient;
    await act(async () => {
      root.render(
        <ApiProvider client={client}>
          <StoreProvider connection={connection} navigation={navigation}>
            <FeedbackProvider>
              <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
            </FeedbackProvider>
          </StoreProvider>
        </ApiProvider>,
      );
    });
    await act(async () => { socket.push(snapshot([session("A", 30), session("B", 20)])); });
    const rowB = [...container.querySelectorAll<HTMLElement>(".inbox-row-shell")]
      .find((row) => row.textContent?.includes("Session B"))!;
    await act(async () => {
      rowB.dispatchEvent(new domWindow.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }) as never);
    });
    const menu = domWindow.document.querySelector('[role="menu"]') as unknown as HTMLElement;
    await act(async () => { (menu.querySelector(".menu-item.danger") as unknown as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(archived, [["B", true]]);

    const toasts = [...container.querySelectorAll<HTMLElement>(".toast")];
    assert.equal(toasts.length, 1);
    const toast = toasts[0]!;
    assert.equal(toast.querySelector(".toast-message")?.textContent, outcome.message);
    assert.ok(toast.classList.contains(outcome.tone), `${outcome.tone}, not ${toast.className}`);
    assert.ok(toast.querySelector(".toast-icon svg")?.classList.contains(outcome.icon), outcome.icon);
    const undo = [...toast.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Undo");
    assert.equal(Boolean(undo), outcome.undo, "Undo stays where it was offered, and is not added");
    if (undo) {
      await act(async () => { undo.click(); await Promise.resolve(); });
      assert.deepEqual(archived, [["B", true], ["B", false]]);
    }
  });
}

test("a Viewer's Inbox archive and decision shortcuts and row menu send nothing (#1857)", async () => {
  mobileViewport = false;
  setWindowFocused(true);
  setVisibility("visible");
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "viewer-inbox-actions",
    runtimeKey: "viewer-inbox-actions:1",
    createSocket: () => socket,
    close() {},
  };
  const calls: string[] = [];
  const client = {
    ...api,
    setArchived: async (id: string) => { calls.push(`archive:${id}`); return session(id, 30); },
    retryStop: async (id: string) => { calls.push(`retryStop:${id}`); return session(id, 30); },
    approve: async (id: string) => { calls.push(`approve:${id}`); return session(id, 30); },
    answerQuestion: async (id: string) => { calls.push(`answer:${id}`); return session(id, 30); },
    renameSession: async (id: string) => { calls.push(`rename:${id}`); return session(id, 30); },
  } as unknown as ApiClient;
  const navigation: ViewNavigation = { current: () => ({ name: "inbox" }), push: () => undefined, listen: () => () => {} };
  const reason = "Your Viewer role is read-only.";
  const refused = { allowed: false as const, reason };
  const viewerSession = session("A", 30, {
    status: "running",
    pendingApproval: {
      requestId: "approval-1",
      title: "Allow Command?",
      options: [
        { optionId: "approve", name: "Approve", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    } as SessionView["pendingApproval"],
    commandPermissions: {
      stop: refused, restart: refused, stopBackgroundJob: refused, archive: refused, unarchive: refused,
      prompt: refused, delete: refused, cancelTurn: refused, manageQueue: refused, rename: refused,
      configure: refused, respond: refused,
    },
  });
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <InboxView viewMode="list" rightPanel={rightPanel} onOpenTerminal={() => undefined} />
        </StoreProvider>
      </ApiProvider>,
    );
  });
  await act(async () => { socket.push(snapshot([viewerSession])); });
  const row = [...container.querySelectorAll<HTMLElement>(".inbox-row")]
    .find((candidate) => candidate.textContent?.includes("Session A"))!;
  await act(async () => { row.click(); });
  for (const key of ["e", "a", "d"]) {
    await act(async () => {
      domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    await act(async () => { await Promise.resolve(); });
  }
  assertNoDomNode(container.querySelector(".inbox-shortcut-rail"), "there is no shortcut rail (#2214)");
  // The row's own Archive stays, says why, and sends nothing.
  const rowArchive = row.parentElement!.querySelector<HTMLButtonElement>('.inbox-row-action[aria-label^="Archive"]')!;
  assert.equal(rowArchive.getAttribute("aria-disabled"), "true");
  assert.equal(rowArchive.title, reason);
  await act(async () => { rowArchive.click(); });
  await act(async () => { await Promise.resolve(); });

  const shell = [...container.querySelectorAll<HTMLElement>(".inbox-row-shell")]
    .find((candidate) => candidate.textContent?.includes("Session A"))!;
  await act(async () => {
    shell.dispatchEvent(new domWindow.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }) as never);
  });
  const menu = domWindow.document.querySelector('[role="menu"]') as unknown as HTMLElement;
  assert.ok(menu, "the row menu still opens");
  const item = (label: string) => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((candidate) => candidate.querySelector(".menu-text")?.textContent === label)!;
  assert.equal(item("Rename Session…").disabled, true);
  assert.equal(item("Archive").disabled, true);
  assert.equal(item("Pin Session").disabled, false, "Pin is per person and stays available");
  await act(async () => {
    item("Rename Session…").click();
    item("Archive").click();
  });
  await act(async () => { await Promise.resolve(); });
  assertNoDomNode(domWindow.document.querySelector('[role="dialog"]'), "no rename dialog or confirmation opens");
  assert.deepEqual(calls, [], "no archive, decision or rename request is sent");

  // Board mode: the card's inline approval options are refused the same way.
  await act(async () => {
    (domWindow.document.querySelector(".menu-backdrop") as unknown as HTMLElement | null)?.click();
  });
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <InboxView viewMode="board" rightPanel={rightPanel} onOpenTerminal={() => undefined} />
        </StoreProvider>
      </ApiProvider>,
    );
  });
  const options = [...container.querySelectorAll<HTMLButtonElement>(".card-approval .approval-actions button")];
  assert.deepEqual(options.map((option) => option.textContent), ["Approve", "Deny"]);
  for (const option of options) {
    assert.equal(option.disabled, true, `the card's ${option.textContent} is disabled`);
    const described = option.getAttribute("aria-describedby");
    assert.equal(described ? domWindow.document.getElementById(described)?.textContent : null, reason);
  }
  await act(async () => { for (const option of options) option.click(); });
  assert.deepEqual(calls, [], "no decision is sent from the board");
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
        <InboxView viewMode={viewMode} rightPanel={rightPanel} onOpenTerminal={() => undefined} />
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
  assert.equal(selectedRowTitle(container), "Session B",
    "opening a desktop row's menu selects the row, so the menu, preview and keys share one session (#2214)");
  assert.deepEqual(rowTitles(container), ["Session A", "Session B"], "selecting it moves no row");
  const pin = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((item) => item.querySelector(".menu-text")?.textContent === "Pin Session")!;
  await act(async () => { pin.click(); });
  assertNoDomNode(domWindow.document.querySelector('[role="menu"]'), "pinning dismisses the menu");
  assert.deepEqual(rowTitles(container), ["Session B", "Session A"], "the targeted session moves immediately");
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
  for (const _step of ["Rename Session…", "Unpin Session"]) {
    await act(async () => {
      menu.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as never);
    });
  }
  const focusedPin = domWindow.document.activeElement as unknown as HTMLButtonElement | null;
  assert.equal(focusedPin?.querySelector(".menu-text")?.textContent, "Unpin Session", "the pin action is arrow-key reachable");
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
      .find((item) => item.querySelector(".menu-text")?.textContent === "Pin Session")!.click();
  });
  assert.deepEqual(
    [...domWindow.document.querySelectorAll(".board .card-title")].map((title) => title.textContent),
    ["Session B", "Session A"],
  );
  assert.deepEqual([...loadKeySet(SESSION_PIN_KEY)], ["B"]);
  assertNoDomNode(domWindow.document.querySelector('[role="menu"]'));
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
        <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
      </StoreProvider>,
    );
  });
  await act(async () => { socket.push(snapshot([session("A", 30), session("B", 20)])); });

  try {
    // Opening a desktop row's menu selects the row (#2214), so the guard is what a tap would also
    // do: a row tap focuses the grid. The release's synthetic click must leave focus in the menu
    // the gesture opened.
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
    assert.equal(selectedRowTitle(container), "Session B", "the menu selected its row");
    assert.ok(domWindow.document.querySelector('[role="menu"]')?.contains(domWindow.document.activeElement),
      "the long-press gesture is not also a tap: focus stays in the menu");
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
            <InboxView viewMode="board" rightPanel={rightPanel} onOpenTerminal={() => undefined} />
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
          <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
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
    assertNoDomNode(domWindow.document.querySelector('[role="menu"]'));

    // Immediately (inside the old 700ms grace): a fresh short tap must act normally. The menu
    // selected Session B (#2214), so the tap goes to Session A.
    assert.equal(selectedRowTitle(container), "Session B");
    const rowA = [...container.querySelectorAll<HTMLElement>(".inbox-row")]
      .find((row) => row.textContent?.includes("Session A"))!;
    await act(async () => {
      rowA.dispatchEvent(new domWindow.PointerEvent("pointerdown", {
        bubbles: true, pointerId: 4, pointerType: "touch", clientX: 41, clientY: 51,
      } as never) as never);
      rowA.dispatchEvent(new domWindow.PointerEvent("pointerup", { bubbles: true, pointerId: 4, pointerType: "touch" } as never) as never);
      rowA.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, cancelable: true }) as never);
    });
    assert.equal(selectedRowTitle(container), "Session A",
      "a new press is a new intent; the previous grace must not swallow it");

    // Reopen, then archive the target from "another client": the menu closes and hands focus off.
    await act(async () => {
      rowButton.dispatchEvent(new domWindow.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 44, clientY: 55 }) as never);
    });
    assert.ok(domWindow.document.querySelector('[role="menu"]'));
    await act(async () => {
      socket.push({ type: "session_upsert", session: { ...session("B", 20), archived: true } });
    });
    assertNoDomNode(domWindow.document.querySelector('[role="menu"]'),
      "an archived target is off the surface, so its menu closes");
    assert.notEqual(domWindow.document.activeElement, domWindow.document.body,
      "and dismissal hands focus to a durable surface, not <body>");
  } finally {
    mobileViewport = true;
  }
});

test("the preview's More Actions menu hands focus to the empty list when its only session is archived elsewhere (#2210)", async () => {
  mobileViewport = false;
  setWindowFocused(true);
  setVisibility("visible");
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "preview-menu-archived",
    runtimeKey: "preview-menu-archived:1",
    createSocket: () => socket,
    close() {},
  };
  try {
    await act(async () => {
      root.render(
        <StoreProvider connection={connection} navigation={navigation}>
          <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
        </StoreProvider>,
      );
    });
    await act(async () => { socket.push(snapshot([session("Only", 30)])); });
    const row = [...container.querySelectorAll<HTMLElement>(".inbox-row")]
      .find((candidate) => candidate.textContent?.includes("Session Only"))!;
    await act(async () => { row.click(); });
    const more = container.querySelector<HTMLButtonElement>('.session-preview-bar [aria-label="More Actions"]');
    assert.ok(more, "the preview bar has ⋯");
    await act(async () => { more!.click(); });
    assert.ok(domWindow.document.querySelector('[role="menu"]'), "⋯ opens the session's menu");
    await act(async () => {
      socket.push({ type: "session_upsert", session: { ...session("Only", 30), archived: true } });
    });
    assertNoDomNode(domWindow.document.querySelector('[role="menu"]'), "the archived session's menu closes");
    assert.ok(container.querySelector(".inbox-zero"), "the list is empty");
    assert.notEqual(domWindow.document.activeElement, domWindow.document.body,
      "focus goes to a durable surface, not <body>, though ⋯ went with the preview");
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
          <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
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
    assertNoDomNode(domWindow.document.querySelector('[role="menu"]'),
      "the first dismissal tap after a cancelled press must close the menu");

    // Case 2: the release click lands on the pressed element and is consumed THERE.
    await pressRow(rowButton, 12);
    await act(async () => {
      rowButton.dispatchEvent(new domWindow.PointerEvent("pointerup", { bubbles: true, pointerId: 12, pointerType: "touch" } as never) as never);
      rowButton.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, cancelable: true }) as never);
    });
    assert.ok(domWindow.document.querySelector('[role="menu"]'), "the source-landed click did not act");
    await act(async () => { backdrop()!.click(); });
    assertNoDomNode(domWindow.document.querySelector('[role="menu"]'),
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
        <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
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
  assert.equal(container.querySelector(".inbox-thread-family-text")?.textContent, "2 Children · Needs Your Input");
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
  assert.equal(container.querySelector(".inbox-thread-family-text")?.textContent, "2 Children · Needs Your Input",
    "the rollup still says a child is waiting while the thread is collapsed");
  assertNoDomNode(container.querySelector(".inbox-order-update"), "hidden children are not a pending reorder");
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
        <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
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
  const previewTitle = () => container.querySelector<HTMLElement>(".session-preview-bar .detail-bar-title")?.textContent ?? null;
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
        <InboxView expandedSessionId="Lone" rightPanel={rightPanel} onOpenTerminal={() => undefined} />
      </StoreProvider>,
    );
  });
  await act(async () => {
    socket.push(snapshot([
      session("Parent", 30, { status: "running" }),
      session("Lone", 20, { status: "running", parentSessionId: "Parent" }),
    ]));
  });
  assert.equal(container.querySelector(".session-preview-bar .detail-bar-title")?.textContent ?? container.textContent?.includes("Session Lone"), true);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_700)); });
  const seen = loadSeen();
  assert.ok("Lone" in seen, "the opened child is marked seen");
  assert.ok(!("Parent" in seen), "the projected parent is not marked seen in its place");
  saveKeySet(INBOX_COLLAPSED_THREADS_KEY, new Set());
});

test("the Inbox lists recommended built-in skills above the sessions in list and board modes, and opens one in Skills", async () => {
  mobileViewport = false;
  setWindowFocused(true);
  setVisibility("visible");
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-recommended-skills",
    runtimeKey: "inbox-recommended-skills:1",
    createSocket: () => socket,
    close() {},
  };
  const pushed: unknown[] = [];
  const spyNavigation: ViewNavigation = {
    current: () => ({ name: "inbox" }),
    push: (view) => void pushed.push(view),
    listen: () => () => {},
  };
  const client = {
    ...api,
    listSkills: async () => ({ skills: [{
      id: "skill-using", name: "using-wollipog", builtIn: { release: "0.28.0", heldUpdate: null },
      recommendation: { dismissed: false }, assignmentCount: 0,
    }] }),
  } as unknown as ApiClient;
  const mountView = async (viewMode: "list" | "board") => {
    await act(async () => {
      root.render(
        <ApiProvider client={client}>
          <StoreProvider connection={connection} navigation={spyNavigation}>
            <InboxView key={viewMode} viewMode={viewMode} rightPanel={rightPanel} onOpenTerminal={() => undefined} />
          </StoreProvider>
        </ApiProvider>,
      );
    });
    await act(async () => { socket.push(snapshot([session("A", 30)])); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  };

  await mountView("board");
  assert.ok(container.querySelector('.board-wrap'));
  assert.equal(container.querySelector('[aria-label="Recommended Skills"]') !== null, true, "board mode shows the notice");

  await mountView("list");
  const notice = container.querySelector('[aria-label="Recommended Skills"]');
  assert.equal(notice !== null, true, "list mode shows the notice");
  assert.equal(Boolean(notice!.compareDocumentPosition(container.querySelector(".inbox-list")!) & 4), true,
    "the notice sits above the session list");
  const link = notice!.querySelector("a") as unknown as HTMLAnchorElement;
  assert.equal(link.textContent, "using-wollipog");
  await act(async () => { link.click(); });
  assert.deepEqual(pushed.at(-1), { name: "skills", id: "skill-using" });
});

test("the setup suggestion is one notice above an eligible Project's list, never in a row, and absent on All (#1977)", async () => {
  mobileViewport = false;
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-setup-suggestion",
    runtimeKey: "inbox-setup-suggestion:1",
    createSocket: () => socket,
    close() {},
  };
  const project = (id: string, name: string): ProjectView => ({
    id, name, hidden: false, locations: [], activeSessionCount: 0, unarchivedSessionCount: 2, totalSessionCount: 2,
    createdAt: 1, updatedAt: 1,
  });
  const withWorktree = (id: string, projectId: string, createdAt: number, setup: "absent" | "valid") => session(id, 100 - createdAt, {
    projectId, createdAt, useWorktree: true, worktreePath: `/worktrees/${id}`,
    worktrees: [{
      id: `worktree-${id}`, path: `/worktrees/${id}`, branch: `agent/${id}`, source: "created",
      setupConfig: setup === "absent" ? { status: "absent" } : { status: "valid", hash: "a" },
    }],
  });
  await act(async () => {
    root.render(
      <ApiProvider client={api}>
        <StoreProvider connection={connection} navigation={navigation}>
          <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
        </StoreProvider>
      </ApiProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: {
        sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true,
        worktreeSetupConfig: true,
      },
      runners: [{
        runnerId: "runner-1", hostname: "build-box", os: "linux", version: "1", status: "online", agents: [],
        workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: PROTOCOL_VERSION,
      }],
      boxes: [],
      sessions: [
        withWorktree("pay-1", "payments", 1, "absent"),
        withWorktree("pay-2", "payments", 2, "absent"),
        withWorktree("docs-1", "docs", 3, "valid"),
        withWorktree("docs-2", "docs", 4, "valid"),
      ],
      projects: [project("payments", "Payments Service"), project("docs", "Docs Site")],
      worktreeSetupNoticeDismissals: [],
      runs: [],
      pods: [],
    });
  });
  const setupNotices = () => [...container.querySelectorAll('[aria-label^="Set Up"]')];
  const openTab = async (name: string) => {
    const tab = [...container.querySelectorAll<HTMLElement>(".tabs-bar .tab")].find((candidate) => candidate.textContent?.includes(name));
    assert.ok(tab, `missing the ${name} tab`);
    await act(async () => { tab.click(); });
  };
  const assertNoRowHoldsANotice = () => {
    const rows = [...container.querySelectorAll('[role="row"]')];
    assert.ok(rows.length > 0, "rows are rendered");
    for (const row of rows) {
      assert.equal(row.querySelectorAll('[role="gridcell"]').length, 1, "a row is one cell, with no setup card under it");
      assertNoDomNode(row.querySelector(".notice"));
    }
  };

  assert.deepEqual(setupNotices(), [], "the All tab shows no setup suggestion");
  assertNoRowHoldsANotice();

  await openTab("Payments Service");
  const notices = setupNotices();
  assert.equal(notices.length, 1, "exactly one notice for the Project");
  assert.equal(notices[0]!.getAttribute("aria-label"), "Set Up Payments Service");
  assert.equal(notices[0]!.querySelector(".notice-title")?.textContent, "Set Up Payments Service");
  assert.equal(Boolean(notices[0]!.compareDocumentPosition(container.querySelector(".inbox-list")!) & 4), true,
    "the notice sits above the session list");
  assertNoRowHoldsANotice();

  await openTab("Docs Site");
  assert.deepEqual(setupNotices(), [], "a Project with a setup file shows none");

  await openTab("All");
  assert.deepEqual(setupNotices(), []);
});

test("A on the Sessions list acts on the preview dock's expanded request, not the session's top one (#2179)", async () => {
  const { root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "inbox-dock-intent",
    runtimeKey: "inbox-dock-intent:1",
    createSocket: () => socket,
    close() {},
  };
  const approvals: unknown[] = [];
  const client = {
    ...api,
    approve: async (id: string, body: unknown) => { approvals.push([id, body]); return session(id, 1); },
  } as unknown as ApiClient;
  // A desktop list with its preview, whose bare A key is the list's (#896).
  mobileViewport = false;
  try {
    await act(async () => {
      root.render(
        <ApiProvider client={client}>
          <StoreProvider connection={connection} navigation={navigation}>
            <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
          </StoreProvider>
        </ApiProvider>,
      );
    });
    // Two policy asks: the control plane decides them, so no runner needs to be connected.
    const ask = (requestId: string, title: string) => ({
      requestId, kind: "policy_hook" as const, title,
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }, { optionId: "deny", name: "Deny", kind: "reject_once" as const }],
    });
    await act(async () => {
      socket.push(snapshot([session("A", 30, {
        status: "input_required",
        pendingApproval: { ...ask("first", "Run npm test"), additionalRequests: [ask("second", "Run pnpm deploy")] },
      })]));
    });
    const row = [...domWindow.document.querySelectorAll(".inbox-row")][0] as unknown as HTMLElement;
    await act(async () => { row.click(); });
    const dock = () => domWindow.document.querySelector(".request-dock") as unknown as HTMLElement | null;
    assert.ok(dock(), "the preview shows the dock");
    await act(async () => { dock()!.querySelector<HTMLButtonElement>(".request-dock-more .disclosure-trigger")!.click(); });
    await act(async () => { dock()!.querySelector<HTMLButtonElement>(".request-dock-row")!.click(); });
    assert.equal(dock()!.querySelector(".request-card h3")?.textContent, "Run pnpm deploy");
    await act(async () => { row.click(); });
    await act(async () => {
      domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    assert.deepEqual(approvals, [["A", { requestId: "second", optionId: "allow" }]],
      "the expanded request is decided, not the top one");
  } finally {
    mobileViewport = true;
  }
});

function capabilitySnapshot(sessions: SessionView[]): UiSnapshotMessage {
  return {
    ...snapshot(sessions),
    capabilities: {
      sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: false,
      sessionReminders: true, stopBeforeArchive: true,
    },
    runners: [{
      runnerId: "runner-1", hostname: "build-box", os: "linux", version: "1", status: "online", agents: [],
      workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: PROTOCOL_VERSION,
    }],
  } as UiSnapshotMessage;
}

/** The open menu's item labels, without keycaps or second lines. */
function menuLabels(): string[] {
  return [...domWindow.document.querySelectorAll('[role="menu"] [role="menuitem"]')]
    .map((item) => item.querySelector(".menu-text")?.textContent ?? "");
}

function menuItem(label: string): HTMLButtonElement {
  return ([...domWindow.document.querySelectorAll('[role="menu"] [role="menuitem"]')] as unknown as HTMLButtonElement[])
    .find((item) => item.querySelector(".menu-text")?.textContent === label)!;
}

test("the Sessions list has no shortcut rail or activity footer, and each row carries Snooze, Archive and ⋯ (#2214)", async () => {
  mobileViewport = false;
  setWindowFocused(true);
  setVisibility("visible");
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "row-actions",
    runtimeKey: "row-actions:1",
    createSocket: () => socket,
    close() {},
  };
  const archived: string[] = [];
  const client = {
    ...api,
    setArchived: async (id: string, value: boolean) => {
      archived.push(id);
      return { ...session(id, 30, { status: "completed" }), archived: value };
    },
  } as unknown as ApiClient;
  try {
    await act(async () => {
      root.render(
        <ApiProvider client={client}>
          <StoreProvider connection={connection} navigation={navigation}>
            <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
          </StoreProvider>
        </ApiProvider>,
      );
    });
    await act(async () => {
      socket.push(capabilitySnapshot([session("A", 30, { status: "running" }), session("B", 20, { status: "completed" })]));
    });
    assertNoDomNode(container.querySelector(".inbox-shortcut-rail"));
    assertNoDomNode(container.querySelector(".inbox-activity-footer"));
    assert.doesNotMatch(container.textContent ?? "", /\b0 (Running|Queued|Starting|Blocked|Stalled)\b/,
      "no zero count is shown anywhere");

    const shellOf = (title: string) => [...container.querySelectorAll<HTMLElement>(".inbox-row-shell")]
      .find((row) => row.textContent?.includes(title))!;
    const actionsOf = (title: string) => [...shellOf(title).querySelectorAll<HTMLButtonElement>(".inbox-row-action")]
      .map((button) => [button.getAttribute("aria-label"), button.title]);
    // The same archive label as the menu, the preview bar and the confirmation; each tooltip names its key.
    assert.deepEqual(actionsOf("Session A"), [
      ["Snooze", "Snooze (H)"],
      ["Archive and Stop…", "Archive and Stop… (E)"],
      ["More Actions", "More Actions (Shift+F10)"],
    ]);
    assert.deepEqual(actionsOf("Session B")[1], ["Archive", "Archive (E)"]);
    for (const button of shellOf("Session A").querySelectorAll<HTMLButtonElement>(".inbox-row-action")) {
      assert.equal(button.tabIndex, -1, "the list owns the keyboard, so no row action is a tab stop");
    }

    // Archive acts on its own row, not on the selection.
    assert.equal(selectedRowTitle(container), "Session A");
    await act(async () => { shellOf("Session B").querySelector<HTMLButtonElement>('[aria-label="Archive"]')!.click(); });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(archived, ["B"]);

    // Snooze opens the Snooze dialog for its own row.
    await act(async () => { shellOf("Session A").querySelector<HTMLButtonElement>('[aria-label="Snooze"]')!.click(); });
    assert.ok(domWindow.document.querySelector('[role="dialog"]'), "Snooze opens its dialog");
  } finally {
    mobileViewport = true;
  }
});

test("a desktop row's ⋯ selects the row without moving any, so the menu, preview and keys share one session (#2214)", async () => {
  mobileViewport = false;
  setWindowFocused(true);
  setVisibility("visible");
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "row-more-selects",
    runtimeKey: "row-more-selects:1",
    createSocket: () => socket,
    close() {},
  };
  try {
    await act(async () => {
      root.render(
        <StoreProvider connection={connection} navigation={navigation}>
          <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
        </StoreProvider>,
      );
    });
    await act(async () => {
      socket.push(capabilitySnapshot([
        session("A", 30),
        session("B", 20, { status: "running", worktreePath: "/work/b" }),
        session("C", 10),
      ]));
    });
    // A running session sorts first, so Session B leads and Session A is selected.
    const order = rowTitles(container);
    assert.deepEqual(order, ["Session B", "Session A", "Session C"]);
    await act(async () => {
      [...container.querySelectorAll<HTMLElement>(".inbox-row")].find((row) => row.textContent?.includes("Session A"))!.click();
    });
    assert.equal(selectedRowTitle(container), "Session A");
    const shellB = [...container.querySelectorAll<HTMLElement>(".inbox-row-shell")]
      .find((row) => row.textContent?.includes("Session B"))!;
    await act(async () => { shellB.querySelector<HTMLButtonElement>(".inbox-row-more")!.click(); });
    assert.equal(selectedRowTitle(container), "Session B", "the row the menu belongs to is selected");
    assert.equal(container.querySelector(".session-preview-bar .detail-bar-title")?.textContent, "Session B",
      "and the preview follows it");
    assert.equal(domWindow.document.querySelector('[role="menu"]')?.getAttribute("aria-label"),
      "Session Actions for Session B");
    assert.deepEqual(menuLabels(), [
      "Reply", "Rename Session…", "Pin Session", "Mark Unread", "Fork Conversation…", "Snooze…", "Archive and Stop…",
    ]);
    // The menu reads the preview's own Fork availability: disabled, with its reason as a second line.
    const fork = menuItem("Fork Conversation…");
    assert.equal(fork.disabled, true);
    assert.ok(fork.querySelector(".menu-desc")?.textContent, "the reason is a visible second line");
    // The keys act on the selection, which is now this session, so the items show their keycaps.
    assert.equal(menuItem("Archive and Stop…").querySelector(".menu-trail kbd")?.textContent, "E");

    // A newer event while the menu is open moves no row: the displayed order is held.
    await act(async () => { socket.push({ type: "session_upsert", session: session("C", 99) }); });
    assert.deepEqual(rowTitles(container), order);
  } finally {
    mobileViewport = true;
  }
});

test("the phone sheet keeps Fork's reasons without a preview, and leaves it out where it can never fork (#2214)", async () => {
  mobileViewport = true;
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "phone-sheet-fork",
    runtimeKey: "phone-sheet-fork:1",
    createSocket: () => socket,
    close() {},
  };
  await act(async () => {
    root.render(
      <StoreProvider connection={connection} navigation={navigation}>
        <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
      </StoreProvider>,
    );
  });
  await act(async () => {
    socket.push(capabilitySnapshot([
      session("Running", 30, { status: "running", worktreePath: "/work/running" }),
      session("Waiting", 20, { status: "idle", worktreePath: "/work/waiting" }),
      session("Plain", 10, { status: "idle" }),
    ]));
  });
  const openMenu = async (title: string) => {
    const shell = [...container.querySelectorAll<HTMLElement>(".inbox-row-shell")]
      .find((row) => row.textContent?.includes(title))!;
    await act(async () => { shell.querySelector<HTMLButtonElement>(".inbox-row-more")!.click(); });
    const menu = domWindow.document.querySelector('[role="menu"]') as unknown as HTMLElement;
    assert.equal(menu.querySelector(".menu-head")?.textContent, title, "the sheet is titled with the session's title");
    return menu;
  };
  const close = async () => {
    await act(async () => { (domWindow.document.querySelector(".menu-backdrop") as unknown as HTMLElement).click(); });
  };

  await openMenu("Session Running");
  assert.equal(menuItem("Fork Conversation…").disabled, true);
  assert.equal(menuItem("Fork Conversation…").querySelector(".menu-desc")?.textContent,
    "Wait for the current turn or approval before creating a fork.");
  assert.equal(domWindow.document.querySelectorAll('[role="menu"] kbd').length, 0, "a phone shows no keycaps");
  await close();

  await openMenu("Session Waiting");
  assert.equal(menuItem("Fork Conversation…").querySelector(".menu-desc")?.textContent,
    "Open the session to fork its latest turn.");
  await close();

  await openMenu("Session Plain");
  assert.equal(menuLabels().includes("Fork Conversation…"), false, "a session without a worktree can never fork");
  await close();
});

test("U and the menu's Mark Unread and Mark Read toggle a session's unread dot (#2214)", async () => {
  mobileViewport = false;
  setWindowFocused(true);
  setVisibility("visible");
  const { container, root } = mountTestRoot();
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "toggle-unread",
    runtimeKey: "toggle-unread:1",
    createSocket: () => socket,
    close() {},
  };
  try {
    await act(async () => {
      root.render(
        <StoreProvider connection={connection} navigation={navigation}>
          <InboxView rightPanel={rightPanel} onOpenTerminal={() => undefined} />
        </StoreProvider>,
      );
    });
    await act(async () => { socket.push(capabilitySnapshot([session("A", 30), session("B", 20)])); });
    const unreadTitles = () => [...container.querySelectorAll(".inbox-row-shell.unread .inbox-row-title")]
      .map((title) => title.textContent);
    const shellB = () => [...container.querySelectorAll<HTMLElement>(".inbox-row-shell")]
      .find((row) => row.textContent?.includes("Session B"))!;
    await act(async () => {
      shellB().dispatchEvent(new domWindow.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }) as never);
    });
    await act(async () => { menuItem("Mark Unread").click(); });
    assert.deepEqual(unreadTitles(), ["Session B"]);
    await act(async () => {
      shellB().dispatchEvent(new domWindow.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }) as never);
    });
    await act(async () => { menuItem("Mark Read").click(); });
    assert.deepEqual(unreadTitles(), []);
    // U toggles the selected session the same way.
    for (const expected of [["Session B"], []]) {
      await act(async () => {
        domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "u", bubbles: true, cancelable: true }));
      });
      assert.deepEqual(unreadTitles(), expected);
    }

    // The menu selects its row, and the seen dwell then marks it read under the open menu. The item
    // keeps the label it opened with and does what that label says.
    await act(async () => {
      domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "u", bubbles: true, cancelable: true }));
    });
    assert.deepEqual(unreadTitles(), ["Session B"]);
    await act(async () => {
      [...container.querySelectorAll<HTMLElement>(".inbox-row")].find((row) => row.textContent?.includes("Session A"))!.click();
    });
    await act(async () => {
      shellB().dispatchEvent(new domWindow.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }) as never);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_700)); });
    assert.deepEqual(unreadTitles(), [], "the dwell marked the selected row read");
    assert.ok(menuItem("Mark Read"), "the item keeps the label it opened with");
    await act(async () => { menuItem("Mark Read").click(); });
    assert.deepEqual(unreadTitles(), [], "and Mark Read never marks it unread");
  } finally {
    mobileViewport = true;
  }
});

test("every mounted root is torn down before the next test starts", () => {
  assert.deepEqual(mountedRoots, [], "a previous test left a React root mounted");
  assert.equal(
    domWindow.document.body.innerHTML,
    "",
    "a previous test left nodes in the body, so portalled menus and dialogs outlive their test",
  );
});
