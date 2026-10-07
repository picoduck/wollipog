import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, SessionView, UiSnapshotMessage } from "@wollipog/protocol";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { InboxView } from "./InboxView.js";
import { SearchPaletteContext } from "./search-palette-context.js";
import type { RightPanelState } from "./RightPanel.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

/**
 * The Sessions search (#2200): match counts in the tabs, the preview following the results, and
 * No Matches with Clear Search and Search Transcripts. The field's geometry (no control moves on
 * focus, 240px and 200px) is the browser half, apps/web/e2e/sessions-search.spec.ts.
 */

const domWindow = new Window({ url: "http://localhost/" });
const { cleanup } = installDomTestCleanup(domWindow);
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  // A desktop with a fine pointer: no phone layout.
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

function session(id: string, lastEventAt: number, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id,
    runnerId: "runner-1",
    workspaceId: "workspace-infra",
    workspaceName: "Infra",
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
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: false },
    runners: [],
    boxes: [],
    sessions,
    runs: [],
    pods: [],
  };
}

/** Recent, so none of them reads as stalled. */
const NOW = Date.now();
/** Two Infra sessions about terraform (one waiting on the user) and a Docs Site session that is not. */
const SESSIONS = [
  session("Plan", NOW - 1_000, { title: "Plan terraform" }),
  session("Apply", NOW - 2_000, { title: "Apply terraform", status: "input_required" }),
  session("Docs", NOW - 3_000, { title: "Write the guide", workspaceId: "workspace-docs", workspaceName: "Docs Site" }),
];

async function mount(options: { openSearchPalette?: (query?: string) => void; viewMode?: "list" | "board"; feedback?: boolean } = {}) {
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
    instanceId: `sessions-search-${Math.random()}`,
    runtimeKey: "sessions-search:1",
    createSocket: () => socket,
    close() {},
  };
  const inbox = <InboxView viewMode={options.viewMode ?? "list"} rightPanel={rightPanel} onOpenTerminal={() => undefined} />;
  const view = options.feedback ? <FeedbackProvider>{inbox}</FeedbackProvider> : inbox;
  await act(async () => {
    root.render(
      <StoreProvider connection={connection} navigation={navigation}>
        {options.openSearchPalette
          ? <SearchPaletteContext.Provider value={options.openSearchPalette}>{view}</SearchPaletteContext.Provider>
          : view}
      </StoreProvider>,
    );
  });
  await act(async () => { socket.push(snapshot(SESSIONS)); });
  const search = container.querySelector<HTMLInputElement>(".inbox-search input")!;
  const type = async (value: string) => {
    await act(async () => {
      search.value = value;
      fireDomEvent.change(search as never, { target: { value } as never });
    });
    await act(async () => { await Promise.resolve(); });
  };
  const pressEscape = async () => {
    await act(async () => {
      search.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as never);
    });
    await act(async () => { await Promise.resolve(); });
  };
  return { container, search, type, pressEscape, socket };
}

/** Each tab as [name, count, badges]. */
function tabs(container: HTMLDivElement): Array<[string, string, string[]]> {
  return [...container.querySelectorAll<HTMLElement>(".tabs-bar .tab")].map((tab) => [
    tab.querySelector(".group-name")?.textContent ?? "",
    tab.querySelector(":scope > .count")?.textContent ?? "",
    [...tab.querySelectorAll(".count-badge")].map((badge) => badge.textContent ?? ""),
  ]);
}

const rowTitles = (container: HTMLDivElement) =>
  [...container.querySelectorAll(".inbox-row-title")].map((row) => row.textContent ?? "");
const selectedRowTitle = (container: HTMLDivElement) =>
  container.querySelector<HTMLElement>('.inbox-row-shell[aria-selected="true"] .inbox-row-title')?.textContent ?? null;
const previewTitle = (container: HTMLDivElement) =>
  container.querySelector<HTMLElement>(".session-preview-bar .detail-bar-title")?.textContent ?? null;

test("the field is a fixed input-affix field that says what it searches", async () => {
  const { container, search } = await mount();
  const field = search.closest("label")!;
  assert.ok(field.classList.contains("input-affix"), "the §8.4 affix field");
  assert.ok(field.closest(".tabs-bar > .tabs-tools"), "at the end of the tab row's tools");
  assert.equal(search.getAttribute("aria-label"), "Search Sessions");
  assert.equal(search.getAttribute("placeholder"), "Search sessions");
  assert.equal(search.getAttribute("title"), "Searches titles, agents, projects and the latest message.");
  assert.equal(field.querySelector("kbd")?.textContent, "/", "the / keycap that focuses it");
  assert.equal(container.querySelectorAll(".inbox-search").length, 1);
});

test("with a query each tab counts its matches, a tab with none reads 0 without a badge, and clearing restores the totals", async () => {
  const { container, type, pressEscape } = await mount();
  assert.deepEqual(tabs(container), [["All", "3", ["1"]], ["Docs Site", "1", []], ["Infra", "2", ["1"]]]);

  await type("terraform");
  assert.deepEqual(tabs(container), [["All", "2", ["1"]], ["Docs Site", "0", []], ["Infra", "2", ["1"]]],
    "every tab, the inactive ones included, counts its matches");
  assert.deepEqual(rowTitles(container), ["Apply terraform", "Plan terraform"], "the one waiting on you first");

  await type("apply");
  assert.deepEqual(tabs(container), [["All", "1", ["1"]], ["Docs Site", "0", []], ["Infra", "1", ["1"]]]);
  await type("plan");
  assert.deepEqual(tabs(container), [["All", "1", []], ["Docs Site", "0", []], ["Infra", "1", []]],
    "the badge counts only the matches that need the user");

  await pressEscape();
  assert.deepEqual(tabs(container), [["All", "3", ["1"]], ["Docs Site", "1", []], ["Infra", "2", ["1"]]]);
  assert.equal(rowTitles(container).length, 3);
});

test("when the selected session leaves the results, the first result is selected and previewed", async () => {
  const { container, type, pressEscape } = await mount();
  const docsRow = [...container.querySelectorAll<HTMLElement>(".inbox-row")]
    .find((row) => row.textContent?.includes("Write the guide"))!;
  await act(async () => { docsRow.click(); });
  assert.equal(previewTitle(container), "Write the guide");

  await type("terraform");
  assert.equal(selectedRowTitle(container), "Apply terraform");
  assert.equal(previewTitle(container), "Apply terraform", "the preview never shows a session the list excludes");

  // A selection that stays in the results stays selected.
  const planRow = [...container.querySelectorAll<HTMLElement>(".inbox-row")]
    .find((row) => row.textContent?.includes("Plan terraform"))!;
  await act(async () => { planRow.click(); });
  await type("terra");
  assert.equal(selectedRowTitle(container), "Plan terraform");
  assert.equal(previewTitle(container), "Plan terraform");

  // Like archiving the selection, the move sticks: clearing the search keeps the result selected.
  await type("apply");
  assert.equal(previewTitle(container), "Apply terraform");
  await pressEscape();
  assert.equal(selectedRowTitle(container), "Apply terraform");
  assert.equal(previewTitle(container), "Apply terraform");
});

test("a query with no matches replaces both panes with No Matches, and Clear Search restores the list", async () => {
  const { container, search, type } = await mount();
  await type("kubernetes");
  const state = container.querySelector<HTMLElement>(".inbox-state .state")!;
  assert.ok(state, "No Matches shows");
  assert.equal(state.querySelector(".state-title")?.textContent, "No Matches");
  assert.ok(state.querySelector(".state-icon svg"), "with the search-off icon");
  assert.equal(state.querySelector(".state-body")?.textContent, "No sessions match “kubernetes” in any group.");
  assertNoDomNode(container.querySelector(".inbox-list"), "no list");
  assertNoDomNode(container.querySelector(".inbox-preview-pane"), "no preview beside it");
  assertNoDomNode(container.querySelector(".master-detail-resize"), "and no divider");
  assert.deepEqual(tabs(container).map(([, count]) => count), ["0", "0", "0"]);

  const actions = [...state.querySelectorAll<HTMLButtonElement>(".actions button")];
  assert.deepEqual(actions.map((button) => [button.textContent, button.className]), [["Clear Search", "btn"]],
    "without the shell's palette, Search Transcripts is left out");
  await act(async () => { actions[0]!.click(); });
  await act(async () => { await Promise.resolve(); });
  assert.equal(search.value, "", "Clear Search empties the field");
  assertNoDomNode(container.querySelector(".inbox-state"));
  assert.equal(rowTitles(container).length, 3, "and restores the list");
  assert.ok(container.querySelector(".inbox-preview-pane"), "and the preview");
});

test("No Matches names the group, and Escape clears it like Clear Search", async () => {
  const { container, search, type, pressEscape } = await mount();
  const docsTab = [...container.querySelectorAll<HTMLButtonElement>(".tabs-bar .tab")]
    .find((tab) => tab.textContent?.includes("Docs Site"))!;
  await act(async () => { docsTab.click(); });
  await type("terraform");
  assert.equal(container.querySelector(".inbox-state .state-body")?.textContent,
    "No sessions match “terraform” in Docs Site.", "a match elsewhere still leaves this group empty");
  await pressEscape();
  assert.equal(search.value, "");
  assertNoDomNode(container.querySelector(".inbox-state"));
  assert.deepEqual(rowTitles(container), ["Write the guide"]);
});

test("Search Transcripts opens the command palette with the query", async () => {
  const opened: Array<string | undefined> = [];
  const { container, search, type } = await mount({ openSearchPalette: (query) => void opened.push(query) });
  await type("  kubernetes ");
  const transcripts = [...container.querySelectorAll<HTMLButtonElement>(".inbox-state .actions button")]
    .find((button) => button.textContent === "Search Transcripts")!;
  assert.equal(transcripts.className, "btn ghost");
  await act(async () => { transcripts.click(); });
  assert.deepEqual(opened, ["kubernetes"]);
  assert.equal(search.value, "  kubernetes ", "the field keeps its query behind the palette");
});

test("No Matches is the list zone's focus target while it replaces the list", async () => {
  const { container, type } = await mount();
  await type("kubernetes");
  const state = container.querySelector<HTMLElement>(".inbox-state")!;
  assert.equal(state.getAttribute("tabindex"), "-1", "programmatically focusable, out of the Tab order");
  assert.equal(state.closest('[data-focus-zone="list"]') !== null, true, "inside the list zone F6 enters");
});

test("on the board, Clear Search hands focus to the restored board instead of dropping it", async () => {
  const { container, search, type } = await mount({ viewMode: "board" });
  await type("kubernetes");
  assert.ok(container.querySelector(".inbox-state"), "the board shows No Matches too");
  assertNoDomNode(container.querySelector(".board-wrap"));
  const clear = [...container.querySelectorAll<HTMLButtonElement>(".inbox-state .actions button")]
    .find((button) => button.textContent === "Clear Search")!;
  clear.focus();
  await act(async () => { clear.click(); });
  await act(async () => { await Promise.resolve(); });
  assert.equal(search.value, "");
  const board = container.querySelector<HTMLElement>(".board-wrap")!;
  assert.ok(board, "the board is back");
  assert.equal(domWindow.document.activeElement, board, "focus lands on the board, not <body>");
});

test("a group's Archive All Sessions still covers the whole group during a search", async () => {
  const { container, type } = await mount({ feedback: true });
  const infraTab = [...container.querySelectorAll<HTMLButtonElement>(".tabs-bar .tab")]
    .find((tab) => tab.textContent?.includes("Infra"))!;
  await act(async () => { infraTab.click(); });
  await type("plan");
  assert.deepEqual(rowTitles(container), ["Plan terraform"]);
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Infra Actions"]')!;
  await act(async () => { trigger.click(); });
  const archiveAll = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((item) => /All Sessions…?$/.test(item.textContent ?? ""))!;
  await act(async () => { archiveAll.click(); });
  await act(async () => { await Promise.resolve(); });
  const dialog = container.querySelector<HTMLElement>('[role="alertdialog"], [role="dialog"]')!;
  assert.match(dialog.textContent ?? "", /All 2 sessions in “Infra”/, "both Infra sessions, not just the match");
});

test("when a live update takes the last match away, the state that replaces the list takes its focus", async () => {
  const { container, type, socket } = await mount();
  await type("apply");
  const grid = container.querySelector<HTMLElement>(".inbox-list")!;
  grid.focus();
  assert.equal(domWindow.document.activeElement, grid);
  await act(async () => {
    socket.push({ type: "session_upsert", session: { ...SESSIONS[1]!, title: "Ship it", preview: "Shipped" } });
  });
  const state = container.querySelector<HTMLElement>(".inbox-state")!;
  assert.ok(state, "No Matches replaced the list");
  assert.equal(domWindow.document.activeElement, state, "focus moved to No Matches, not <body>");
});

test("when a live update takes the previewed session out of the results, the next result's reader keeps focus", async () => {
  const { container, type, socket } = await mount();
  await type("terraform");
  assert.equal(previewTitle(container), "Apply terraform");
  const reader = container.querySelector<HTMLElement>(".inbox-preview-pane .detail-scroll")!;
  assert.ok(reader, "the preview has a reader to focus");
  reader.focus();
  assert.equal(domWindow.document.activeElement, reader);
  await act(async () => {
    socket.push({ type: "session_upsert", session: { ...SESSIONS[1]!, title: "Ship it", preview: "Shipped" } });
  });
  assert.equal(previewTitle(container), "Plan terraform", "the preview follows the remaining result");
  const replacement = container.querySelector<HTMLElement>(".inbox-preview-pane .detail-scroll")!;
  assert.equal(domWindow.document.activeElement, replacement, "focus stays in the reader, not <body>");
});

test("when No Matches holds focus and a live match brings the board back, the board takes it", async () => {
  const { container, type, socket } = await mount({ viewMode: "board" });
  await type("deploy");
  const state = container.querySelector<HTMLElement>(".inbox-state")!;
  state.focus();
  await act(async () => {
    socket.push({ type: "session_upsert", session: { ...SESSIONS[2]!, title: "Deploy the guide" } });
  });
  const board = container.querySelector<HTMLElement>(".board-wrap")!;
  assert.ok(board, "the board is back with the match");
  assert.equal(domWindow.document.activeElement, board);
});

test("when No Matches holds focus and the connection drops, the offline state takes it", async () => {
  const { container, type, socket } = await mount();
  await type("kubernetes");
  const state = container.querySelector<HTMLElement>(".inbox-state")!;
  state.focus();
  await act(async () => { socket.onclose?.({ code: 1006 }); });
  // One state holds the panes' place (#2220), so the same landing spot keeps focus while what it
  // says changes.
  assert.ok(state.querySelector(".state.offline"), "the page shows Reconnecting, which outranks No Matches (§12)");
  assertNoDomNode(state.querySelector(".state.no-results"));
  assert.equal(domWindow.document.activeElement, state);
});

test("Search Transcripts takes focus before it opens the palette, so the palette can return it there", async () => {
  let focusedAtOpen: unknown = null;
  const { container, type } = await mount({ openSearchPalette: () => { focusedAtOpen = domWindow.document.activeElement; } });
  await type("kubernetes");
  const transcripts = [...container.querySelectorAll<HTMLButtonElement>(".inbox-state .actions button")]
    .find((button) => button.textContent === "Search Transcripts")!;
  // A pointer click in Safari does not focus the button it lands on; .click() does not either.
  await act(async () => { transcripts.click(); });
  assert.equal(focusedAtOpen, transcripts);
});
