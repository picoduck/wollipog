import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import { afterEach, beforeEach, describe, mock } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  ControlPlaneToUi,
  ProjectLocationView,
  ProjectView,
  RunnerView,
  SessionReminderView,
  SessionView,
  UiSnapshotMessage,
} from "@wollipog/protocol";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { durableInboxProjectKey, INBOX_NO_PROJECT_SPLIT_KEY } from "../inbox.js";
import { focusZone } from "../focus-zones.js";
import type { NewSessionPreset } from "./NewSessionDialog.js";
import { InboxView } from "./InboxView.js";
import type { RightPanelState } from "./RightPanel.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { ApiProvider } from "../api-context.js";
import { api as realApi, type ApiClient } from "../api.js";
import { SESSIONS_ARRIVAL_WAIT_MS } from "../sessions-states.js";

/**
 * One Sessions state per situation (#2220): an empty group replaces both panes with one state and
 * its next step, a group whose sessions are arriving shows skeleton rows, and a lost connection
 * keeps the last list, dimmed under Reconnecting. The geometry and the reconnect are the browser
 * half, apps/web/e2e/sessions-states.spec.ts.
 */

const domWindow = new Window({ url: "http://localhost/" });
const { cleanup } = installDomTestCleanup(domWindow);
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  // A desktop with a fine pointer: the stacked list and preview.
  value: (media: string) => ({
    matches: false,
    media,
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
Object.defineProperty(domWindow.document, "visibilityState", { configurable: true, value: "visible" });
Object.defineProperty(domWindow.document, "hasFocus", { configurable: true, value: () => true });

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

const NOW = Date.now();

function session(id: string, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id,
    runnerId: "runner-studio",
    workspaceId: "workspace-docs",
    workspaceName: "Docs Site",
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
    updatedAt: NOW,
    lastEventAt: NOW,
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

function location(availability: ProjectLocationView["availability"]): ProjectLocationView {
  return {
    id: `location-${availability}`, projectId: "project-docs", runnerId: "runner-studio", workspaceId: "workspace-docs",
    name: "docs", path: "/srv/docs", source: "managed", availability, isDefault: true, createdAt: 1, updatedAt: 1,
  };
}

function project(locations: ProjectLocationView[], count = 0): ProjectView {
  return {
    id: "project-docs", name: "Docs Site", hidden: false, locations,
    activeSessionCount: count, unarchivedSessionCount: count, totalSessionCount: count, createdAt: 1, updatedAt: 1,
  };
}

const studio: RunnerView = {
  runnerId: "runner-studio",
  hostname: "studio.local",
  displayName: "Studio",
  os: "linux",
  version: "1",
  status: "offline",
  agents: [],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
};

function snapshot(options: { sessions?: SessionView[]; projects?: ProjectView[]; reminders?: SessionReminderView[] } = {}): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: {
      sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false,
      projects: true, sessionReminders: true,
    },
    runners: [studio],
    boxes: [],
    sessions: options.sessions ?? [],
    projects: options.projects ?? [],
    reminders: options.reminders ?? [],
    runs: [],
    pods: [],
  };
}

async function mount(options: { routeSplit?: string | null; api?: ApiClient } = {}) {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  cleanup(async () => {
    await act(async () => { root.unmount(); });
    mountPoint.remove();
  });
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: `sessions-states-${Math.random()}`,
    runtimeKey: "sessions-states:1",
    createSocket: () => socket,
    close() {},
  };
  const created: Array<NewSessionPreset | undefined> = [];
  await act(async () => {
    root.render(
      <ApiProvider {...(options.api ? { client: options.api } : {})}>
        <StoreProvider connection={connection} navigation={navigation}>
          <InboxView
            rightPanel={rightPanel}
            onOpenTerminal={() => undefined}
            onNewSession={(preset) => created.push(preset)}
            {...(options.routeSplit === undefined ? {} : { routeSplit: options.routeSplit })}
          />
        </StoreProvider>
      </ApiProvider>,
    );
  });
  return { container, socket, created };
}

const pageState = (container: HTMLElement) => container.querySelector<HTMLElement>(".inbox-view .master-detail-state.inbox-state");
const actionLabels = (state: HTMLElement) => [...state.querySelectorAll<HTMLButtonElement>(".actions button")]
  .map((button) => button.textContent?.trim());
const headerNewSession = (container: HTMLElement) => container.querySelector(".page-header .page-primary");
/** The focused element, typed as the DOM the components render into. */
const focused = () => domWindow.document.activeElement as unknown as Element | null;

/** One state in both panes' place: no list, no divider, no preview, nothing to select (§6.1). */
function assertOneState(container: HTMLElement, title: string): HTMLElement {
  const states = container.querySelectorAll(".inbox-state");
  assert.equal(states.length, 1, "one state");
  const state = states[0] as HTMLElement;
  assert.equal(state.querySelector(".state-title")?.textContent, title);
  assert.equal(state.querySelector(".state-title")?.tagName, "H2");
  assert.ok(state.querySelector(".state-icon svg"), `${title} has its icon`);
  assertNoDomNode(container.querySelector(".inbox-list"));
  assertNoDomNode(container.querySelector(".inbox-preview-pane"));
  assertNoDomNode(container.querySelector(".master-detail-resize"));
  assert.ok(!container.querySelector(".inbox-view")!.classList.contains("sessions-md"), "the panes' grid is gone");
  const text = container.textContent ?? "";
  assert.doesNotMatch(text, /Select a Session|All Agents Unblocked|Running: \d|✓/);
  return state;
}

test("with zero sessions the page shows one first-run state, and the header no New Session", async () => {
  const { container, socket, created } = await mount();
  await act(async () => { socket.push(snapshot()); });
  const state = assertOneState(container, "No Sessions Yet");
  assert.equal(state.querySelector(".state-body")?.textContent,
    "Pick a project and describe the task. An agent starts on one of your machines and tells you when it needs a decision.");
  assert.deepEqual(actionLabels(state), ["New Session", "New Project…"]);
  const newSession = state.querySelector<HTMLButtonElement>(".actions .btn.primary.lg")!;
  assert.equal(newSession.textContent?.trim(), "New Session", "New Session is the state's one primary");
  assert.ok(state.querySelector(".actions .btn.lg:not(.primary)"), "New Project… is a large secondary");
  assertNoDomNode(headerNewSession(container), "the header hides the New Session the state offers");
  await act(async () => { newSession.click(); });
  assert.equal(created.length, 1);
  await act(async () => { state.querySelector<HTMLButtonElement>(".actions .btn.lg:not(.primary)")!.click(); });
  assert.ok(domWindow.document.querySelector('[role="dialog"]'), "New Project… opens Create Project");
});

test("a Project with no sessions offers New Session Here in that Project", async () => {
  const { container, socket, created } = await mount({ routeSplit: durableInboxProjectKey("project-docs") });
  await act(async () => { socket.push(snapshot({ projects: [project([{ ...location("available") }])] })); });
  const state = assertOneState(container, "No Sessions Yet");
  assert.equal(state.querySelector(".state-body")?.textContent, "Start a session to put an agent to work in Docs Site.");
  assert.deepEqual(actionLabels(state), ["New Session Here"]);
  assertNoDomNode(headerNewSession(container));
  await act(async () => { state.querySelector<HTMLButtonElement>(".actions button")!.click(); });
  assert.equal(created[0]?.projectId, "project-docs", "the session starts in the Project");
});

test("a Project without a Location says what a Location is, and offers Add Location", async () => {
  const { container, socket } = await mount({ routeSplit: durableInboxProjectKey("project-docs") });
  await act(async () => { socket.push(snapshot({ projects: [project([])] })); });
  const state = assertOneState(container, "No Location Yet");
  assert.equal(state.querySelector(".state-body")?.textContent,
    "Sessions run in a folder on one of your machines. Add one to Docs Site to start sessions here.");
  assert.deepEqual(actionLabels(state), ["Add Location"]);
  assert.ok(headerNewSession(container), "the header keeps New Session when the state does not offer it");
});

test("a Project whose only Location is offline names the machine", async () => {
  const { container, socket } = await mount({ routeSplit: durableInboxProjectKey("project-docs") });
  await act(async () => { socket.push(snapshot({ projects: [project([location("runner_offline")])] })); });
  const state = assertOneState(container, "Location Offline");
  assert.equal(state.querySelector(".state-body")?.textContent,
    "This project's only location is on Studio, which is offline. Sessions can start here when it reconnects.");
  assert.deepEqual(actionLabels(state), ["Manage Locations"]);
  assert.ok(headerNewSession(container));
});

test("the No Project group says what collects there and offers New Session", async () => {
  const { container, socket, created } = await mount({ routeSplit: INBOX_NO_PROJECT_SPLIT_KEY });
  await act(async () => {
    socket.push(snapshot({ projects: [project([location("available")])], sessions: [session("in-project", { projectId: "project-docs" })] }));
  });
  const state = assertOneState(container, "No Sessions Without a Project");
  assert.equal(state.querySelector(".state-body")?.textContent, "Sessions you start without choosing a project collect here.");
  assert.deepEqual(actionLabels(state), ["New Session"]);
  assertNoDomNode(headerNewSession(container));
  await act(async () => { state.querySelector<HTMLButtonElement>(".actions button")!.click(); });
  assert.deepEqual(created[0], { projectId: null }, "the session starts without a Project");
});

test("Snoozed with none explains snoozing and returns to the active sessions", async () => {
  const { container, socket } = await mount();
  await act(async () => { socket.push(snapshot({ sessions: [session("active")] })); });
  assert.ok(container.querySelector(".inbox-list"));
  const snoozed = [...container.querySelectorAll<HTMLButtonElement>(".page-header button[aria-pressed]")]
    .find((button) => button.textContent?.startsWith("Snoozed"))!;
  await act(async () => { snoozed.click(); });
  const state = assertOneState(container, "No Snoozed Sessions");
  assert.equal(state.querySelector(".state-body")?.textContent,
    "Snooze a session to hide it from Sessions until a time you choose. Its work keeps running while it's away.");
  assert.deepEqual(actionLabels(state), ["Show Active Sessions"]);
  assert.ok(headerNewSession(container));
  await act(async () => { state.querySelector<HTMLButtonElement>(".actions button")!.click(); });
  assertNoDomNode(container.querySelector(".inbox-state"));
  assert.ok(container.querySelector(".inbox-list"), "the active list is back");
});

test("a group whose every session is snoozed says so instead of No Sessions Yet", async () => {
  const { container, socket } = await mount();
  await act(async () => {
    socket.push(snapshot({
      sessions: [session("asleep")],
      reminders: [{
        reminderId: "reminder-asleep", sessionId: "asleep", scheduledFor: NOW + 86_400_000, timeZone: "UTC",
        originalExpression: "tomorrow", wakePolicy: "until_activity", state: "pending", revision: 1, createdAt: 1, updatedAt: 1,
      }],
    }));
  });
  const state = assertOneState(container, "No Active Sessions");
  assert.deepEqual(actionLabels(state), ["Show Snoozed Sessions"]);
  await act(async () => { state.querySelector<HTMLButtonElement>(".actions button")!.click(); });
  assert.ok(container.querySelector(".inbox-list"), "Show Snoozed Sessions shows the snoozed one");
});

test("a Project whose sessions are still syncing shows skeleton rows, then rows, and no state between", async () => {
  const { container, socket } = await mount({ routeSplit: durableInboxProjectKey("project-docs") });
  await act(async () => { socket.push(snapshot({ projects: [project([location("available")], 8)] })); });
  const skeleton = container.querySelector<HTMLElement>(".inbox-list-pane .inbox-skeleton")!;
  assert.ok(skeleton, "the list shows skeleton rows");
  assert.equal(skeleton.querySelector('[role="status"]')?.textContent, "Loading 8 sessions…");
  const rows = skeleton.querySelectorAll(".inbox-skeleton-row");
  assert.equal(rows.length, 6, "3 to 6 rows at the real row's height");
  assert.ok([...rows].every((row) => row.classList.contains("row-2") && row.querySelectorAll(".skeleton-bar").length === 2));
  assertNoDomNode(container.querySelector(".inbox-state"), "never a state card while syncing");
  assert.ok(container.querySelector(".inbox-view.sessions-md"), "the panes keep their grid");
  assert.ok(container.querySelector(".inbox-preview-pane .inbox-preview-skeleton .skeleton-bar"), "the preview shows a skeleton bar");
  assert.doesNotMatch(container.textContent ?? "", /Loading Sessions|still syncing|No Sessions Yet/);

  await act(async () => {
    socket.push({ type: "session_upsert", session: session("arrived", { projectId: "project-docs" }) });
  });
  assertNoDomNode(container.querySelector(".inbox-skeleton"));
  assertNoDomNode(container.querySelector(".inbox-state"));
  assert.ok(container.querySelector(".inbox-list .inbox-row"), "rows replace the skeleton");
});

test("before the first snapshot the list is skeleton rows, never an empty state", async () => {
  const { container } = await mount();
  const skeleton = container.querySelector<HTMLElement>(".inbox-skeleton")!;
  assert.ok(skeleton);
  assert.equal(skeleton.querySelector('[role="status"]')?.textContent, "Loading sessions…");
  assertNoDomNode(container.querySelector(".inbox-state"));
});

test("disconnecting keeps the last-known rows, dimmed under Reconnecting, and never an empty state", async () => {
  const { container, socket } = await mount();
  await act(async () => { socket.push(snapshot({ sessions: [session("one"), session("two")] })); });
  const grid = container.querySelector<HTMLElement>(".inbox-list")!;
  assert.ok(!grid.closest(".is-stale"), "a live list is not dimmed");
  assertNoDomNode(container.querySelector(".inbox-list-status"));
  await act(async () => { socket.onclose?.({ code: 1006 }); });
  assert.ok(container.querySelector(".inbox-list") === grid, "the same grid stays, with its scroll and focus");
  assert.ok(grid.closest(".inbox-list-stale.is-stale"), "the rows are dimmed");
  assert.equal(container.querySelectorAll(".inbox-row").length, 2, "the rows stay");
  const line = container.querySelector<HTMLElement>(".inbox-list-pane > .inbox-list-head > .inbox-list-status")!;
  assert.equal(line.textContent, "Reconnecting…");
  assert.ok(!line.closest(".is-stale"), "the Reconnecting line is not dimmed");
  assertNoDomNode(container.querySelector(".inbox-state"));
  assert.doesNotMatch(container.textContent ?? "", /No Sessions Yet|All Agents Unblocked/);
  assert.ok(headerNewSession(container));
});

test("disconnecting with nothing loaded says Reconnecting in the panes' place", async () => {
  const { container, socket } = await mount();
  await act(async () => { socket.push(snapshot()); });
  await act(async () => { socket.onclose?.({ code: 1006 }); });
  const state = container.querySelector<HTMLElement>(".inbox-state")!;
  assert.equal(state.querySelector(".state.offline")?.textContent, "Reconnecting…");
  assertNoDomNode(state.querySelector(".state-title"), "not No Sessions Yet: an empty map proves nothing offline");
  assert.ok(headerNewSession(container));
});

// Focus never falls to <body> when what holds it gives way (§16.1): the grid, the state in the
// panes' place and the skeleton replace one another, with or without a search.
test("removing the focused list's last session hands focus to the state that replaces it", async () => {
  const { container, socket } = await mount();
  await act(async () => { socket.push(snapshot({ sessions: [session("only")] })); });
  const grid = container.querySelector<HTMLElement>(".inbox-list")!;
  grid.focus();
  assert.ok(focused() === grid);
  await act(async () => { socket.push({ type: "session_removed", sessionId: "only" }); });
  const state = container.querySelector<HTMLElement>(".inbox-state")!;
  assert.ok(state, "No Sessions Yet replaces the list");
  assert.ok(focused() === state, "the state takes focus, not <body>");
});

test("a focused skeleton hands focus to the grid when the sessions arrive", async () => {
  const { container, socket } = await mount({ routeSplit: durableInboxProjectKey("project-docs") });
  await act(async () => { socket.push(snapshot({ projects: [project([location("available")], 2)] })); });
  const skeleton = container.querySelector<HTMLElement>(".inbox-skeleton")!;
  skeleton.focus();
  assert.ok(focused() === skeleton);
  await act(async () => {
    socket.push({ type: "session_upsert", session: session("arrived", { projectId: "project-docs" }) });
  });
  assert.ok(focused() === container.querySelector(".inbox-list"), "the grid takes focus, not <body>");
});

test("clearing a search over a syncing group hands focus to the skeleton", async () => {
  const { container, socket } = await mount({ routeSplit: durableInboxProjectKey("project-docs") });
  await act(async () => { socket.push(snapshot({ projects: [project([location("available")], 2)] })); });
  const search = container.querySelector<HTMLInputElement>(".inbox-search input")!;
  await act(async () => {
    search.focus();
    search.value = "docs";
    fireDomEvent.change(search as never, { target: { value: "docs" } as never });
  });
  const state = container.querySelector<HTMLElement>(".inbox-state")!;
  assert.ok(state.querySelector(".state.no-results"), "a search over nothing loaded is No Matches");
  await act(async () => {
    fireDomEvent.keyDown(search as never, { key: "Escape" });
  });
  await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 0)); });
  assert.ok(focused() === container.querySelector(".inbox-skeleton"), "the skeleton takes focus, not <body>");
});

test("F6 into a loading preview lands on a target the accessibility tree can see", async () => {
  const { container } = await mount();
  assert.ok(container.querySelector(".inbox-preview-skeleton"), "the preview shows its skeleton before the first snapshot");
  assert.equal(focusZone(domWindow.document as unknown as Document, "main"), "main");
  const active = domWindow.document.activeElement as unknown as HTMLElement;
  assert.ok(active.classList.contains("inbox-preview-skeleton"));
  assertNoDomNode(active.closest('[aria-hidden="true"]'), "the focused target is not hidden from assistive technology");
  assert.ok(active.getAttribute("aria-label"), "and it has a name");
});

// A group's sessions that never arrive end in Couldn't Load Sessions with Retry, not an endless
// skeleton (#2803, §12.3). The wait runs on fake timers; the store's own timers stay real.
describe("sessions that never arrive", () => {
  beforeEach(() => { mock.timers.enable({ apis: ["setTimeout"] }); });
  afterEach(() => { mock.timers.reset(); });

  const docsSplit = durableInboxProjectKey("project-docs");
  const tick = async (ms: number) => { await act(async () => { mock.timers.tick(ms); }); };
  const skeleton = (container: HTMLElement) => container.querySelector<HTMLElement>(".inbox-list-pane .inbox-skeleton");
  const failure = (container: HTMLElement) => container.querySelector<HTMLElement>(".inbox-state .notice.t-danger");
  const retryButton = (container: HTMLElement) => [...failure(container)!.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Retry")!;
  /** The real client with only the list Retry asks for replaced. */
  function client(listSessions: () => Promise<{ sessions: SessionView[] }>): ApiClient & { calls: number } {
    const stub = { ...realApi, calls: 0 };
    stub.listSessions = () => { stub.calls += 1; return listSessions(); };
    return stub;
  }
  async function waitingGroup(api?: ApiClient) {
    const view = await mount({ routeSplit: docsSplit, ...(api ? { api } : {}) });
    await act(async () => { view.socket.push(snapshot({ projects: [project([location("available")], 8)] })); });
    assert.ok(skeleton(view.container), "the group starts on its skeleton");
    return view;
  }

  test("the skeleton holds until the wait elapses, then Couldn't Load Sessions with Retry replaces both panes", async () => {
    const { container } = await waitingGroup();
    await tick(SESSIONS_ARRIVAL_WAIT_MS - 1);
    assert.ok(skeleton(container), "still the skeleton just before the wait ends");
    assertNoDomNode(container.querySelector(".inbox-state"));

    await tick(1);
    const state = failure(container)!;
    assert.ok(state, "a danger notice in the panes' place (§12.4)");
    assert.ok(state.closest(".master-detail-state.inbox-state"));
    assert.equal(state.getAttribute("role"), "alert");
    assert.equal(state.querySelector(".notice-title")?.textContent, "Couldn't Load Sessions");
    assert.equal(state.querySelector(".notice-title")?.tagName, "H2");
    assert.equal(state.querySelector(".notice-body")?.textContent,
      "Docs Site has 8 sessions, but they didn't arrive. Retry to ask for them again.");
    assert.deepEqual([...state.querySelectorAll("button")].map((button) => button.textContent?.trim()), ["Retry"],
      "no Show Details: a wait that ran out has no raw detail");
    assertNoDomNode(skeleton(container));
    assertNoDomNode(container.querySelector(".inbox-list"));
    assertNoDomNode(container.querySelector(".inbox-preview-pane"));
    assert.doesNotMatch(container.textContent ?? "", /No Sessions Yet|Loading 8 sessions/);
    assert.ok(headerNewSession(container), "the header keeps New Session");
  });

  test("Retry asks for the sessions again and shows the skeleton; sessions arriving afterwards replace it", async () => {
    const api = client(async () => ({ sessions: [] }));
    const { container, socket } = await waitingGroup(api);
    await tick(SESSIONS_ARRIVAL_WAIT_MS);
    const retry = retryButton(container);
    retry.focus();
    await act(async () => { retry.click(); });
    assert.equal(api.calls, 1, "Retry asks for the sessions again");
    assert.ok(skeleton(container), "Retry returns to the skeleton");
    assertNoDomNode(container.querySelector(".inbox-state"));
    assert.ok(focused() === skeleton(container), "focus moves to the skeleton, not <body>");

    await tick(SESSIONS_ARRIVAL_WAIT_MS - 1);
    assert.ok(skeleton(container), "Retry starts a whole new wait");
    await act(async () => {
      socket.push({ type: "session_upsert", session: session("late", { projectId: "project-docs" }) });
    });
    assertNoDomNode(skeleton(container));
    assertNoDomNode(container.querySelector(".inbox-state"));
    assert.ok(container.querySelector(".inbox-list .inbox-row"), "rows replace the skeleton");
    await tick(SESSIONS_ARRIVAL_WAIT_MS);
    assertNoDomNode(container.querySelector(".inbox-state"), "an elapsed old wait never brings the state back");
  });

  test("the sessions Retry fetches fill the group, without touching other groups or newer live rows", async () => {
    const live = session("live", { projectId: "project-docs", title: "Live Title" });
    const api = client(async () => ({
      sessions: [
        session("fetched", { projectId: "project-docs" }),
        session("elsewhere", { projectId: "project-other" }),
        session("archived", { projectId: "project-docs", archived: true }),
        { ...live, title: "Stale Title" },
      ],
    }));
    const { container, socket } = await waitingGroup(api);
    await tick(SESSIONS_ARRIVAL_WAIT_MS);
    let resolveList!: () => void;
    const listed = new Promise<void>((resolve) => { resolveList = resolve; });
    const fetchSessions = api.listSessions;
    api.listSessions = async () => { await listed; return fetchSessions(); };
    await act(async () => { retryButton(container).click(); });
    // A live update lands while the request is in flight; the older response must not overwrite it.
    await act(async () => { socket.push({ type: "session_upsert", session: live }); });
    await act(async () => { resolveList(); await listed; });
    const titles = [...container.querySelectorAll(".inbox-list .inbox-row")].map((row) => row.textContent ?? "");
    assert.equal(titles.length, 2, "the group's own missing session joins the live one");
    assert.ok(titles.some((text) => text.includes("Session fetched")));
    assert.ok(titles.some((text) => text.includes("Live Title")) && !titles.some((text) => text.includes("Stale Title")));
  });

  test("a Retry whose request fails shows the state again at once, with the reason behind Show Details", async () => {
    const api = client(async () => { throw new Error("HTTP 503: control plane unavailable"); });
    const { container } = await waitingGroup(api);
    await tick(SESSIONS_ARRIVAL_WAIT_MS);
    await act(async () => { retryButton(container).click(); });
    const state = failure(container)!;
    assert.ok(state, "the failed request ends the wait early");
    const toggle = [...state.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Show Details")!;
    assert.ok(toggle);
    await act(async () => { toggle.click(); });
    assert.equal(state.querySelector(".notice-details-body code")?.textContent, "HTTP 503: control plane unavailable");
  });

  test("sessions that arrive before the wait elapses never show the state", async () => {
    const { container, socket } = await waitingGroup();
    await tick(SESSIONS_ARRIVAL_WAIT_MS - 1);
    await act(async () => {
      socket.push({ type: "session_upsert", session: session("arrived", { projectId: "project-docs" }) });
    });
    await tick(SESSIONS_ARRIVAL_WAIT_MS * 3);
    assertNoDomNode(container.querySelector(".inbox-state"));
    assert.ok(container.querySelector(".inbox-list .inbox-row"));
  });

  test("disconnecting while waiting shows Reconnecting, never the state", async () => {
    const { container, socket } = await waitingGroup();
    await tick(SESSIONS_ARRIVAL_WAIT_MS - 1);
    await act(async () => { socket.onclose?.({ code: 1006 }); });
    await tick(SESSIONS_ARRIVAL_WAIT_MS * 3);
    assertNoDomNode(failure(container), "the wait applies only to a connected client");
    assert.equal(container.querySelector(".inbox-state .state.offline")?.textContent, "Reconnecting…");
  });

  test("disconnecting after the state appeared shows Reconnecting in its place", async () => {
    const { container, socket } = await waitingGroup();
    await tick(SESSIONS_ARRIVAL_WAIT_MS);
    assert.ok(failure(container));
    await act(async () => { socket.onclose?.({ code: 1006 }); });
    assertNoDomNode(failure(container));
    assert.equal(container.querySelector(".inbox-state .state.offline")?.textContent, "Reconnecting…");
  });

  test("leaving the group and coming back starts a fresh wait", async () => {
    const { container } = await waitingGroup();
    await tick(SESSIONS_ARRIVAL_WAIT_MS);
    assert.ok(failure(container));
    const search = container.querySelector<HTMLInputElement>(".inbox-search input")!;
    await act(async () => {
      search.focus();
      search.value = "docs";
      fireDomEvent.change(search as never, { target: { value: "docs" } as never });
    });
    assertNoDomNode(failure(container), "a search does not wait, so it shows No Matches");
    await act(async () => { fireDomEvent.keyDown(search as never, { key: "Escape" }); });
    await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 0)); });
    assert.ok(skeleton(container), "clearing the search waits again from the start");
    await tick(SESSIONS_ARRIVAL_WAIT_MS - 1);
    assertNoDomNode(failure(container));
  });
});
