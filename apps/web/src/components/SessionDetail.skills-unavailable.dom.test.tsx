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
  runnerId: "runner-skills", hostname: "runner-host", os: "linux", version: "1", status: "online",
  agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex", available: true }],
  workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 141,
} as RunnerView;

function targetSession(adapter: "host" | "container"): SessionView {
  return {
    id: `skills-${adapter}`, runnerId: runner.runnerId, workspaceId: null, workspaceName: null, projectId: null,
    agentId: "codex", agentName: "Codex", title: "Target Session", status: "idle", column: "review",
    runId: null, useWorktree: false, worktreePath: null, archived: false, createdAt: 1, updatedAt: 1,
    lastEventAt: null, messageCount: 0, eventEpoch: 0, preview: null, pendingApproval: null,
    driver: "codex", model: "gpt-5.6-sol", effort: "high", permissionMode: null,
    tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
    executionTarget: {
      id: adapter, runnerId: runner.runnerId, kind: adapter === "host" ? "local" : "container",
      workspaceStrategy: "worktree", adapter,
      boundaries: { filesystem: adapter === "host" ? "worktree" : "container", network: "deny", secrets: "none", billing: "none" },
    },
  } as SessionView;
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

async function renderedNotice(adapter: "host" | "container"): Promise<string | null> {
  const current = targetSession(adapter);
  const socket = new FakeSocket();
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: () => new Promise<never>(() => {}),
    getSessionEventTailPage: () => new Promise<never>(() => {}),
    runnerSkills: async () => ({
      desired: [{ name: "review", versionDigest: "a", targets: [{ agentId: "codex", invocation: "agent" }] }],
      reported: null,
    }),
  } as unknown as ApiClient;
  const connection: UiConnectionRuntime = {
    instanceId: "skills-test", runtimeKey: "skills-test:1", createSocket: () => socket, close() {},
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
    return container.querySelector('[aria-label="Skills Unavailable on This Target"]')?.textContent ?? null;
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

test("a container session shows its Machine's assigned skills as unavailable", async () => {
  assert.match(await renderedNotice("container") ?? "", /1 Assigned Skill: review/u);
});

test("a host session shows no skills notice", async () => {
  assert.equal(await renderedNotice("host"), null);
});
