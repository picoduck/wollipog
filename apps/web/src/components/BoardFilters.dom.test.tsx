import { fireDomEvent } from "./test-dom-events.js";
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
import { Board } from "./Board.js";
import { BoardFilterTools, boardFiltersButtonName, filterBoardSessions } from "./BoardFilters.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

/**
 * The Board's Machine and Agent filters as menu buttons in the Sessions tab row (#2201): agents
 * grouped by machine, unavailable agents disabled with their reason, the "1 of 3" note and Clear,
 * and one Filters button in the compact tier.
 */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const agent = (id: string, name: string, available: boolean, unavailableReason?: string): RunnerView["agents"][number] => ({
  id, name, command: id, args: [], env: {}, driver: "claude-code", available,
  ...(unavailableReason ? { unavailableReason } : {}),
});

const studio: RunnerView = {
  runnerId: "runner-1",
  hostname: "studio",
  displayName: "Studio Mac",
  os: "macos",
  version: "1",
  status: "online",
  agents: [
    agent("codex", "Codex", true),
    agent("claude", "Claude Code", true),
    agent("gemini", "Gemini CLI", false, "Gemini CLI is not installed."),
  ],
  workspaces: [{ id: "workspace-1", name: "Wollipog", path: "/repos/wollipog" }],
  connectedAt: 1,
  lastSeen: 1,
};
// No reason reported: the row still says why it cannot be chosen.
const build: RunnerView = {
  ...studio,
  runnerId: "runner-2",
  hostname: "build-02",
  displayName: "Build Server 02",
  agents: [agent("codex", "Codex", true), agent("aider", "Aider", false)],
};

const session = (id: string, runnerId: string, agentId: string): SessionView => ({
  id, runnerId, agentId, workspaceId: "workspace-1", title: id, status: "idle", column: "running",
  archived: false, createdAt: 1, updatedAt: 1,
} as unknown as SessionView);
const sessions = [session("s-1", "runner-1", "codex"), session("s-2", "runner-1", "claude"), session("s-3", "runner-2", "codex")];

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const navigation: ViewNavigation = { current: () => ({ name: "board" }), push() {}, listen: () => () => {} };

function Harness() {
  const all = useStoreSelector((s) => s.sessions);
  const scoped = React.useMemo(() => [...all.values()], [all]);
  return (
    <>
      <div className="tabs-tools"><BoardFilterTools sessions={scoped} /></div>
      <Board sessions={scoped} searchActive={false} onShowAll={() => {}} onNewSession={() => {}} onSessionMenu={() => {}} />
    </>
  );
}

let sequence = 0;
async function mount() {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  const socket = new FakeSocket();
  sequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `board-filters-${sequence}`,
    runtimeKey: `board-filters-${sequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  await act(async () => {
    root.render(
      <ApiProvider client={api as unknown as ApiClient}>
        <FeedbackProvider>
          <StoreProvider connection={connection} navigation={navigation}><Harness /></StoreProvider>
        </FeedbackProvider>
      </ApiProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false },
      runners: [studio, build], boxes: [], sessions, runs: [], pods: [],
    } as UiSnapshotMessage);
  });
  return { unmount: async () => { await act(async () => root.unmount()); mountPoint.remove(); } };
}

const body = () => domWindow.document.body as unknown as HTMLElement;
const tools = () => body().querySelector(".tabs-tools") as HTMLElement;
const trigger = (filter: string) => body().querySelector(`[data-board-filter="${filter}"]`) as HTMLButtonElement | null;
const menu = () => body().querySelector('[role="menu"]') as HTMLElement | null;
const rowNamed = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]')]
    .find((row) => row.querySelector(".menu-text")?.textContent === text);

async function click(element: Element | null | undefined) {
  assert.ok(element);
  await act(async () => { fireDomEvent.click(element as never); });
}

async function setViewport(width: number, height: number) {
  await act(async () => {
    domWindow.happyDOM.setViewport({ width, height });
    domWindow.dispatchEvent(new domWindow.Event("resize"));
  });
}

test("the Board's sessions narrow by both filters at once", () => {
  assert.deepEqual(filterBoardSessions(sessions, { runnerId: null, agentId: null }).map((s) => s.id), ["s-1", "s-2", "s-3"]);
  assert.deepEqual(filterBoardSessions(sessions, { runnerId: null, agentId: "codex" }).map((s) => s.id), ["s-1", "s-3"]);
  assert.deepEqual(filterBoardSessions(sessions, { runnerId: "runner-2", agentId: "codex" }).map((s) => s.id), ["s-3"]);
  assert.equal(boardFiltersButtonName(0), "Filters");
  assert.equal(boardFiltersButtonName(1), "Filters, 1 Active");
});

test("the Agent menu groups agents by machine and disables an unavailable one with its reason", async () => {
  await setViewport(1440, 900);
  const { unmount } = await mount();
  // No native select anywhere, and no toolbar above the columns.
  assert.equal(body().querySelector("select"), null);
  assert.equal(body().querySelector(".board-wrap > .toolbar"), null);
  assert.equal(trigger("machine")?.textContent, "All Machines");
  assert.equal(trigger("agent")?.textContent, "All Agents");
  assert.equal(trigger("agent")?.getAttribute("aria-pressed"), "false");

  await click(trigger("agent"));
  const open = menu();
  assert.ok(open, "the Agent menu opens");
  assert.equal(open.getAttribute("aria-label"), "Agent");
  const groups = [...open.querySelectorAll<HTMLElement>('[role="group"]')];
  assert.deepEqual(groups.map((group) => group.getAttribute("aria-label")), ["Studio Mac", "Build Server 02"]);
  assert.deepEqual(groups.map((group) => group.querySelector(".menu-label")?.textContent), ["Studio Mac", "Build Server 02"]);
  assert.deepEqual(
    [...groups[0]!.querySelectorAll(".menu-text")].map((text) => text.textContent),
    ["Codex", "Claude Code", "Gemini CLI"],
  );
  const gemini = rowNamed(groups[0]!, "Gemini CLI")!;
  assert.equal(gemini.getAttribute("aria-disabled"), "true");
  assert.equal(gemini.querySelector(".menu-desc")?.textContent, "Gemini CLI is not installed.");
  const aider = rowNamed(groups[1]!, "Aider")!;
  assert.equal(aider.getAttribute("aria-disabled"), "true");
  assert.equal(aider.querySelector(".menu-desc")?.textContent, "Not available on Build Server 02.");
  assert.equal(rowNamed(groups[0]!, "Codex")?.getAttribute("aria-disabled"), null);

  // An unavailable row cannot be chosen.
  await click(gemini);
  assert.ok(menu(), "the menu stays open");
  assert.equal(trigger("agent")?.getAttribute("aria-pressed"), "false");
  await unmount();
});

test("a set Agent names itself on its button, shows the count and Clear, and Clear resets both", async () => {
  await setViewport(1440, 900);
  const { unmount } = await mount();
  assert.equal(tools().querySelector(".board-filter-note"), null, "no note while nothing is filtered");
  assert.equal(rowNamed(tools(), "Clear"), undefined);

  await click(trigger("agent"));
  await click(rowNamed(menu()!, "Claude Code"));
  assert.equal(menu(), null, "choosing closes the menu");
  assert.equal(trigger("agent")?.textContent, "Claude Code");
  assert.equal(trigger("agent")?.getAttribute("aria-pressed"), "true");
  assert.equal(tools().querySelector(".board-filter-note")?.textContent, "1 of 3");
  // Cards are virtualized and happy-dom has no layout, so the column count says what is shown.
  assert.equal(body().querySelector(".column.col-running .count")?.textContent, "1");

  await click(trigger("machine"));
  await click(rowNamed(menu()!, "Build Server 02"));
  assert.equal(trigger("machine")?.textContent, "Build Server 02");
  assert.equal(trigger("machine")?.getAttribute("aria-pressed"), "true");
  assert.equal(tools().querySelector(".board-filter-note")?.textContent, "0 of 3");
  // No matches: a compact State with Clear Filters, the existing copy kept.
  const state = body().querySelector(".state");
  assert.equal(state?.querySelector(".state-title")?.textContent, "No Matching Sessions");
  assert.match(state?.textContent ?? "", /3 sessions are hidden by the current Machine and Agent filters\./);

  const clear = [...tools().querySelectorAll("button")].find((button) => button.textContent === "Clear");
  await click(clear);
  assert.equal(trigger("machine")?.getAttribute("aria-pressed"), "false");
  assert.equal(trigger("agent")?.getAttribute("aria-pressed"), "false");
  assert.equal(trigger("agent")?.textContent, "All Agents");
  assert.equal(tools().querySelector(".board-filter-note"), null);
  assert.equal(body().querySelector(".column.col-running .count")?.textContent, "3");
  await unmount();
});

test("the compact tier folds both filters into one Filters menu named by its count", async () => {
  await setViewport(940, 700);
  const { unmount } = await mount();
  assert.equal(trigger("machine"), null);
  assert.equal(trigger("agent"), null);
  const filters = trigger("both")!;
  assert.equal(filters.getAttribute("aria-label"), "Filters");
  assert.equal(filters.getAttribute("aria-pressed"), "false");

  await click(filters);
  const open = menu()!;
  assert.equal(open.getAttribute("aria-label"), "Filters");
  const sections = [...open.querySelectorAll<HTMLElement>(':scope > [role="group"]')];
  assert.deepEqual(sections.map((group) => group.getAttribute("aria-label")), ["Machine", "Agent"]);
  assert.equal(rowNamed(open, "Clear Filters"), undefined, "nothing to clear yet");
  await click(rowNamed(sections[1]!, "Claude Code"));

  assert.equal(trigger("both")?.getAttribute("aria-label"), "Filters, 1 Active");
  assert.equal(trigger("both")?.getAttribute("aria-pressed"), "true");
  assert.equal(tools().querySelector(".board-filter-note")?.textContent, "1 of 3");

  await click(trigger("both"));
  await click(rowNamed(menu()!, "Clear Filters"));
  assert.equal(trigger("both")?.getAttribute("aria-label"), "Filters");
  assert.equal(trigger("both")?.getAttribute("aria-pressed"), "false");

  // At 1100px and wider the two buttons return.
  await setViewport(1100, 800);
  assert.ok(trigger("machine"));
  assert.ok(trigger("agent"));
  assert.equal(trigger("both"), null);
  await unmount();
});

test("an empty column is a strip that keeps its title and count", async () => {
  await setViewport(1440, 900);
  const { unmount } = await mount();
  const queued = body().querySelector(".column.col-queued")!;
  assert.ok(queued.classList.contains("is-empty"));
  assert.equal(queued.querySelector(".column-title")?.textContent, "Queued");
  assert.equal(queued.querySelector(".count")?.textContent, "0");
  const running = body().querySelector(".column.col-running")!;
  assert.equal(running.classList.contains("is-empty"), false);
  assert.ok(running.querySelector(".column-dot.t-info"), "Running's dot is info");
  assert.ok(body().querySelector(".column.col-input_required .column-dot.t-warning"), "Needs Input's dot is warning");
  for (const id of ["queued", "review", "done"]) {
    assert.ok(body().querySelector(`.column.col-${id} .column-dot.t-neutral`), `${id}'s dot is neutral`);
  }
  await unmount();
});
