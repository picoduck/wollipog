import "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, RunnerView, SessionEvent, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { animationFramePublishScheduler, setDefaultPublishScheduler, StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { SessionDetail } from "./SessionDetail.js";
import { observeRenderProbe, TIMELINE_ROW_PROBE } from "./render-probe.js";

/**
 * While an agent streams, only the transcript row whose data changed renders (#2763).
 *
 * Every transcript row reports to a render probe as `timeline-row:<item id>`. A reply streams into
 * the session one socket frame at a time; each frame is published on its animation frame, and the
 * rows before the reply (the earlier prompts, replies and a settled tool step) must not render.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
// This file exercises the batching, so it publishes on (hand-cranked) animation frames.
setDefaultPublishScheduler(animationFramePublishScheduler);
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value() {
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 72, width: 800, height: 72, toJSON: () => ({}) };
  },
});
for (const [name, value] of [["clientHeight", 1_200], ["offsetHeight", 72]] as const) {
  Object.defineProperty(domWindow.HTMLElement.prototype, name, { configurable: true, get: () => value });
}
const animationFrames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
domWindow.requestAnimationFrame = ((callback: FrameRequestCallback) => {
  const handle = nextFrame++;
  animationFrames.set(handle, callback);
  return handle;
}) as unknown as typeof domWindow.requestAnimationFrame;
domWindow.cancelAnimationFrame = ((handle: number) => { animationFrames.delete(handle); }) as unknown as typeof domWindow.cancelAnimationFrame;
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  File: domWindow.File,
  FileReader: domWindow.FileReader,
  MutationObserver: domWindow.MutationObserver,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const runner = {
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{
    id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true,
  }],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 106,
} as RunnerView;

function sessionView(id: string, patch: Partial<SessionView> = {}): SessionView {
  return {
    id,
    runnerId: runner.runnerId,
    workspaceId: null,
    workspaceName: null,
    projectId: null,
    agentId: "codex",
    agentName: "Codex",
    title: "Stream Render Fixture",
    status: "running",
    column: "running",
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
    ...patch,
  };
}

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

const history: SessionEvent["payload"][] = [
  { kind: "user_message", text: "Summarize the repository", images: [] },
  { kind: "agent_message", text: "It is a control plane, a runner and a **web** client." },
  { kind: "user_message", text: "Which one owns sessions?", images: [] },
  { kind: "tool_call", toolCallId: "tool-1", title: "Read sessions.ts", toolKind: "read", status: "completed" },
  { kind: "agent_message", text: "The control plane, in `sessions.ts`." },
  { kind: "user_message", text: "And the transcript?", images: [] },
];

async function mount() {
  const fixture = sessionView("stream-render");
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "stream-render",
    runtimeKey: "stream-render:1",
    createSocket: () => socket,
    close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: fixture.id }),
    push() {},
    listen: () => () => {},
  };
  const apiClient = {
    ...api,
    session: () => new Promise<never>(() => {}),
    searchWorkspaceReferences: async () => ({ results: [], truncated: false }),
  } as unknown as ApiClient;
  const rightPanel = {
    open: false, mode: "launcher", width: 360, dragging: false, subagentTarget: null,
    toggle() {}, openMode() {}, show() {}, setMode() {}, setWidth() {}, setDragging() {}, close() {},
    selectSubagent() {}, showSubagent() {}, consumeSubagentFocusRequest() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  let seq = 0;
  const frame = async () => {
    await act(async () => {
      for (let round = 0; round < 4 && animationFrames.size > 0; round += 1) {
        const due = [...animationFrames.values()];
        animationFrames.clear();
        for (const callback of due) callback(performance.now());
      }
    });
  };
  const push = async (message: ControlPlaneToUi) => {
    await act(async () => socket.push(message));
    await frame();
  };
  const append = async (payload: SessionEvent["payload"]) => {
    seq += 1;
    await push({ type: "session_event", event: { id: seq, sessionId: fixture.id, seq, ts: seq, payload } });
  };
  await act(async () => root.render(
    <ApiProvider client={apiClient}>
      <StoreProvider connection={connection} navigation={navigation}>
        <FeedbackProvider>
          <SessionDetail sessionId={fixture.id} mode="expanded" rightPanel={rightPanel as never} onOpenTerminal={() => {}} />
        </FeedbackProvider>
      </StoreProvider>
    </ApiProvider>,
  ));
  await push({
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [runner], boxes: [], projects: [], sessions: [fixture], runs: [], pods: [],
  });
  for (const payload of history) await append(payload);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
  await frame();
  return {
    fixture,
    container,
    push,
    append,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("streaming a reply renders only its own transcript row", async () => {
  const view = await mount();
  const rendered = new Map<string, number>();
  const stop = observeRenderProbe(TIMELINE_ROW_PROBE, (id) => rendered.set(id, (rendered.get(id) ?? 0) + 1));
  try {
    assert.ok(view.container.textContent?.includes("And the transcript?"), "the history is rendered");
    const words = "The transcript is folded from the session's events by the web client".split(" ");
    for (const word of words) await view.append({ kind: "agent_message", text: `${word} ` });
    assert.ok(view.container.textContent?.includes("folded from the session's events"), "the reply streamed in");
    // A paced upsert carrying the streamed counters, as the control plane sends four times a second.
    await view.push({
      type: "session_upsert",
      session: sessionView(view.fixture.id, { messageCount: history.length + words.length, preview: "folded" }),
    });

    const replyRow = `${TIMELINE_ROW_PROBE}:${history.length + 1}`;
    assert.ok((rendered.get(replyRow) ?? 0) > 0, `the streaming reply renders (${[...rendered.keys()].join(", ")})`);
    const others = [...rendered].filter(([id]) => id !== replyRow);
    assert.deepEqual(others, [], "no row whose data did not change renders while the reply streams");
    assert.ok((rendered.get(replyRow) ?? 0) <= words.length, "and the reply renders at most once per frame");
  } finally {
    stop();
    await view.unmount();
  }
});
