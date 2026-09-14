import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, RunnerView, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { SessionDetail } from "./SessionDetail.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 72, width: 800, height: 72, toJSON: () => ({}) }),
});
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

const runner = {
  runnerId: "runner-setup", hostname: "runner-host", os: "linux", version: "1", status: "online",
  agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex", available: true }],
  workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 141,
} as RunnerView;

function failedSession(): SessionView {
  const path = "/repos/demo/worktree";
  return {
    id: "setup-failed", runnerId: runner.runnerId, workspaceId: null, workspaceName: null, projectId: null,
    agentId: "codex", agentName: "Codex", title: "Setup Failure", status: "failed", column: "review",
    runId: null, useWorktree: true, worktreePath: path, archived: false, createdAt: 1, updatedAt: 1,
    lastEventAt: null, messageCount: 0, eventEpoch: 0, preview: null, pendingApproval: null,
    driver: "codex", model: "gpt-5.6-sol", effort: "high", permissionMode: null,
    tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
    worktrees: [{
      id: "worktree-one", path, branch: "agent/setup", source: "created", baseCommit: "a".repeat(40),
      setup: {
        status: "failed", configHash: "b".repeat(64), attemptId: "attempt-one",
        environmentKeys: ["WOLLIPOG_WORKTREE_PATH"], copies: [],
        steps: [{ name: "Install Dependencies", status: "failed", optional: false, startedAt: 1, durationMs: 902, error: "exited with 1" }],
        error: "Install Dependencies exited with 1",
      },
    }],
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

test("failed worktree setup is visible and Retry Setup resumes before restarting", async () => {
  const current = failedSession();
  const socket = new FakeSocket();
  const calls: string[] = [];
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: () => new Promise<never>(() => {}),
    getSessionEventTailPage: () => new Promise<never>(() => {}),
    retryWorktreeSetup: async (id: string, path: string) => {
      calls.push(`retry:${id}:${path}`);
      return { session: { ...current, worktrees: current.worktrees!.map((item) => ({ ...item, setup: { ...item.setup!, status: "completed" as const } })) } };
    },
    restart: async (id: string) => {
      calls.push(`restart:${id}`);
      return { ...current, status: "starting" as const };
    },
  } as unknown as ApiClient;
  const connection: UiConnectionRuntime = {
    instanceId: "setup-test", runtimeKey: "setup-test:1", createSocket: () => socket, close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: current.id }), push() {}, listen: () => () => {},
  };
  const rightPanel = {
    open: false, mode: "launcher" as const, width: 360, dragging: false, subagentTarget: null,
    toggle() {}, openMode() {}, show() {}, setMode() {}, setWidth() {}, setDragging() {},
    close() {}, selectSubagent() {}, showSubagent() {}, consumeSubagentFocusRequest() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={{ confirm: async () => true, showToast: () => 0, dismissToast: () => {} } as never}>
          <StoreProvider connection={connection} navigation={navigation}>
            <SessionDetail sessionId={current.id} mode="expanded" rightPanel={rightPanel}
              onOpenTerminal={() => {}} pinnedOpen={false} composerDraftLoader={async () => null} />
          </StoreProvider>
        </FeedbackContext.Provider>
      </ApiProvider>,
    ));
    await act(async () => socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
      runners: [runner], boxes: [], projects: [], sessions: [current], runs: [], pods: [],
    }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const banner = container.querySelector('[aria-label="Worktree Setup Failed"]') as HTMLElement | null;
    assert.ok(banner);
    assert.match(banner.textContent ?? "", /retained/u);
    assert.match(banner.textContent ?? "", /Install Dependencies exited with 1/u);
    const button = banner.querySelector("button") as HTMLButtonElement;
    assert.equal(button.textContent, "Retry Setup");
    await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 5)); });
    assert.deepEqual(calls, [
      "retry:setup-failed:/repos/demo/worktree",
      "restart:setup-failed",
    ]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
