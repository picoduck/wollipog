import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, RunnerView, SessionEvent, SessionEventsResponse, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { SessionDetail } from "./SessionDetail.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

/** Retry Turn on a failed turn's notice, wired to the session (#2169). */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  localStorage: domWindow.localStorage, Element: domWindow.Element, HTMLElement: domWindow.HTMLElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement, Node: domWindow.Node, Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver, React, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

// happy-dom has no layout: give each virtual row a height and the reader a tall viewport, so the
// transcript mounts its rows.
const isRow = (element: Element) => element.hasAttribute("data-virtual-row");
const heightOf = (element: Element) => isRow(element) ? 120 : 4_000;
const elementPrototype = domWindow.HTMLElement.prototype as unknown as HTMLElement;
Object.defineProperty(elementPrototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) { return heightOf(this); },
});
Object.defineProperty(elementPrototype, "offsetWidth", { configurable: true, get: () => 800 });
Object.defineProperty(elementPrototype, "clientHeight", {
  configurable: true,
  get(this: HTMLElement) { return heightOf(this); },
});
elementPrototype.getBoundingClientRect = function (this: HTMLElement) {
  const height = heightOf(this);
  return { top: 0, left: 0, right: 800, bottom: height, width: 800, height, x: 0, y: 0, toJSON() {} } as DOMRect;
};

const runner = {
  runnerId: "runner-1", hostname: "build-box.local", displayName: "Build Box", os: "linux", version: "1",
  status: "online",
  agents: [{ id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", available: true }],
  workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 200,
} as RunnerView;

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: ControlPlaneToUi) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

async function flush(delay = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    await Promise.resolve();
  });
}

let sequence = 0;
async function withFailedTurn(
  { status, runnerStatus = "online" }: { status: SessionView["status"]; runnerStatus?: RunnerView["status"] },
  check: (view: { id: string; container: HTMLElement; calls: string[]; retry: () => HTMLButtonElement | undefined }) => Promise<void>,
) {
  sequence += 1;
  const id = `turn-failed-${sequence}`;
  const session = {
    id, runnerId: runner.runnerId, workspaceId: null, workspaceName: "wollipog", projectId: null,
    agentId: "claude", agentName: "Claude Code", title: "Failed Turn", status, column: "review", runId: null,
    useWorktree: false, worktreePath: null, archived: false, createdAt: 1, updatedAt: 1, lastEventAt: null,
    messageCount: 2, eventEpoch: 0, preview: null, pendingApproval: null, driver: "claude-code", model: null,
    effort: null, permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
  } as SessionView;
  const events: SessionEvent[] = ([
    { kind: "user_message", text: "Summarize the release notes", images: [] },
    { kind: "error", message: "prompt failed: Rate limit reached" },
    { kind: "error", message: "Rate limit reached" },
  ] as SessionEvent["payload"][]).map((payload, index) =>
    ({ id: index + 1, sessionId: id, seq: index + 1, ts: Date.UTC(2026, 9, 2, 0, 25, index), payload }));
  const calls: string[] = [];
  const tail: Array<(value: SessionEventsResponse) => void> = [];
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: () => new Promise<never>(() => {}),
    getSessionEventTailPage: () => new Promise<SessionEventsResponse>((resolve) => { tail.push(resolve); }),
    restart: async (sessionId: string) => {
      calls.push(`restart:${sessionId}`);
      return { ...session, status: "starting" as const };
    },
    prompt: async (sessionId: string, text: string, images: unknown[]) => {
      calls.push(`prompt:${sessionId}:${text}:${images.length}`);
      return { ...session, status: "queued" as const };
    },
  } as unknown as ApiClient;
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = { instanceId: id, runtimeKey: `${id}:1`, createSocket: () => socket, close() {} };
  const navigation: ViewNavigation = { current: () => ({ name: "session", id }), push() {}, listen: () => () => {} };
  const rightPanel = {
    open: false, mode: "launcher" as const, width: 360, dragging: false, subagentTarget: null,
    toggle() {}, openMode() {}, show() {}, setMode() {}, setWidth() {}, setDragging() {}, close() {},
    selectSubagent() {}, showSubagent() {}, consumeSubagentFocusRequest() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <SessionDetail sessionId={id} mode="expanded" rightPanel={rightPanel} onOpenTerminal={() => {}}
            composerDraftLoader={async () => null} />
        </StoreProvider>
      </ApiProvider>,
    ));
    await act(async () => socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
      runners: [{ ...runner, status: runnerStatus }], boxes: [], projects: [], sessions: [session], runs: [], pods: [],
    }));
    await flush();
    const resolve = tail.shift();
    assert.ok(resolve, "the transcript's tail is requested");
    await act(async () => resolve({ events, eventEpoch: 0, nextBefore: 0, hasMoreOlder: false, cacheComplete: true }));
    await flush();
    await check({
      id,
      container,
      calls,
      retry: () => [...container.querySelectorAll<HTMLButtonElement>(".notice button")]
        .find((button) => button.textContent === "Retry Turn"),
    });
  } finally {
    await flush(1);
    await act(async () => root.unmount());
    container.remove();
  }
}

test("a failed session's tail is one Turn Failed notice, and Retry Turn restarts it and submits the prompt", async () => {
  await withFailedTurn({ status: "failed" }, async ({ id, container, calls, retry }) => {
    const titles = [...container.querySelectorAll(".notice-title")].map((title) => title.textContent);
    assert.deepEqual(titles.filter((title) => title === "Turn Failed"), ["Turn Failed"]);
    const rows = [...container.querySelectorAll(".timeline [data-virtual-row], .timeline [role='listitem']")];
    assert.ok(rows.at(-1)?.querySelector(".notice-title")?.textContent === "Turn Failed",
      "the last transcript row is the notice");
    const button = retry();
    assert.ok(button);
    assert.equal(button.disabled, false);
    await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 5)); });
    assert.deepEqual(calls, [`restart:${id}`, `prompt:${id}:Summarize the release notes:0`]);
  });
});

test("an idle session's Retry Turn submits the prompt without restarting", async () => {
  await withFailedTurn({ status: "idle" }, async ({ id, calls, retry }) => {
    await act(async () => { retry()!.click(); await new Promise((resolve) => setTimeout(resolve, 5)); });
    assert.deepEqual(calls, [`prompt:${id}:Summarize the release notes:0`]);
  });
});

test("with the runner offline Retry Turn is disabled and names why in a visible line", async () => {
  await withFailedTurn({ status: "failed", runnerStatus: "offline" }, async ({ calls, retry }) => {
    const button = retry();
    assert.ok(button);
    assert.equal(button.disabled, true);
    const reason = domWindow.document.getElementById(button.getAttribute("aria-describedby") ?? "");
    assert.equal(reason?.textContent, "Runner is offline.");
    assert.ok(reason?.closest(".notice-body"));
    await act(async () => button.click());
    assert.deepEqual(calls, []);
  });
});
