import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { RunView, UiSnapshotMessage, WorkflowArtifactView, WorkflowInstanceDetail } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { RunDetail } from "./RunsView.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  localStorage: domWindow.localStorage, Element: domWindow.Element, HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent, React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const runA: RunView = {
  id: "run-a", title: "Run A", prompt: "First task", workspaceId: null, workspaceName: null,
  createdAt: 1, updatedAt: 1, sessionIds: [],
};
const runB: RunView = { ...runA, id: "run-b", title: "Run B", prompt: "Second task" };

const workflowA = {
  instanceId: "instance-a", workflowId: "builtin:build-review", workflowVersion: 1, runId: runA.id,
  status: "running", transitionCount: 0, createdBy: { kind: "system" }, createdAt: 1, updatedAt: 1,
  nodeStates: [{ nodeId: "build", status: "running", attemptCount: 1 }],
  definition: {
    workflowId: "builtin:build-review", version: 1, source: "builtin", name: "Run A Workflow",
    maxTransitions: 4, edges: [], createdBy: { kind: "system" }, createdAt: 1,
    nodes: [{ nodeId: "build", kind: "agent", role: "builder", agentId: "claude", inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1_000 }],
  },
  attempts: [], events: [],
} as WorkflowInstanceDetail;

const artifactA = {
  artifactId: "artifact-a", runId: runA.id, kind: "test_log", name: "run-a-notes.txt", mimeType: "text/plain",
  encoding: "utf8", sizeBytes: 12, sha256: "a".repeat(64), createdBy: { kind: "system" }, createdAt: 1,
} as WorkflowArtifactView;

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

const pending = () => new Promise<never>(() => {});

/** Renders the run route the way App does: one RunDetail at a fixed tree position. */
function RunRoute() {
  const view = useStoreSelector((state) => state.view);
  return view.name === "run" ? <RunDetail runId={view.id} /> : null;
}

interface Fixture {
  container: HTMLDivElement;
  root: Root;
  socket: FakeSocket;
  /** A browser-history jump straight to another run's detail. */
  jumpTo: (runId: string) => Promise<void>;
}

async function mountRunDetail(client: Partial<ApiClient>): Promise<Fixture> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "runs-view", runtimeKey: "runs-view:1",
    // Reconnect attempts after an offline transition get a socket that never opens.
    createSocket: (() => { let first = true; return () => { if (!first) return new FakeSocket(); first = false; return socket; }; })(),
    close() {},
  };
  const listeners = new Set<(view: View) => void>();
  const navigation: ViewNavigation = {
    current: () => ({ name: "run", id: runA.id }),
    push() {},
    listen: (onView) => { listeners.add(onView); return () => listeners.delete(onView); },
  };
  const apiClient = { ...api, getSessionEventPage: pending, artifactExport: pending, ...client } as unknown as ApiClient;
  await act(async () => root.render(
    <ApiProvider client={apiClient}>
      <StoreProvider connection={connection} navigation={navigation}>
        <RunRoute />
      </StoreProvider>
    </ApiProvider>,
  ));
  await act(async () => socket.push({
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [], boxes: [], projects: [], sessions: [], runs: [runA, runB], pods: [],
  }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const jumpTo = async (runId: string) => {
    await act(async () => { for (const onView of listeners) onView({ name: "run", id: runId }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  return { container, root, socket, jumpTo };
}

async function unmount(fixture: Fixture): Promise<void> {
  await act(async () => fixture.root.unmount());
  fixture.container.remove();
}

const section = (container: HTMLDivElement, label: string) => container.querySelector(`[aria-label="${label}"]`);
const title = (container: HTMLDivElement) => container.querySelector(".detail-title")?.textContent;

test("a direct run-to-run route change drops the previous run's error banners while the new run loads", async () => {
  const workflowRequests: string[] = [];
  const fixture = await mountRunDetail({
    workflowInstances: async (runId: string) => {
      workflowRequests.push(runId);
      if (runId === runA.id) throw new Error("Run A workflow failed");
      return pending();
    },
    runWorkflowArtifacts: async (runId: string) => {
      if (runId === runA.id) throw new Error("Run A artifacts failed");
      return pending();
    },
  } as Partial<ApiClient>);
  try {
    assert.equal(title(fixture.container), "Run A");
    assert.match(section(fixture.container, "Workflow Progress")?.textContent ?? "", /Run A workflow failed/u);
    assert.match(section(fixture.container, "Workflow Artifacts")?.textContent ?? "", /Run A artifacts failed/u);

    await fixture.jumpTo(runB.id);

    assert.equal(title(fixture.container), "Run B");
    assert.deepEqual(workflowRequests, [runA.id, runB.id], "run B's workflow request is still pending");
    assert.equal(Boolean(section(fixture.container, "Workflow Progress")), false, "Workflow Progress is not shown");
    assert.equal(Boolean(section(fixture.container, "Workflow Artifacts")), false, "Workflow Artifacts is not shown");
    assert.doesNotMatch(fixture.container.textContent ?? "", /Run A/u);
  } finally {
    await unmount(fixture);
  }
});

test("a direct run-to-run route change while offline drops the previous run's workflow, artifacts and preview", async () => {
  const workflowRequests: string[] = [];
  const fixture = await mountRunDetail({
    workflowInstances: async (runId: string) => {
      workflowRequests.push(runId);
      return runId === runA.id ? [workflowA] : pending();
    },
    workflowInstance: async () => workflowA,
    runWorkflowArtifacts: async (runId: string) => runId === runA.id ? { artifacts: [artifactA] } : pending(),
  } as Partial<ApiClient>);
  try {
    assert.match(section(fixture.container, "Workflow Progress")?.textContent ?? "", /Run A Workflow/u);
    const artifactCard = [...fixture.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(artifactA.name));
    assert.ok(artifactCard, "run A's artifact is listed");
    await act(async () => artifactCard.click());
    assert.ok(fixture.container.querySelector(".run-artifact-preview"), "run A's artifact preview is open");

    await act(async () => fixture.socket.onclose?.({ code: 1006 }));
    await fixture.jumpTo(runB.id);

    assert.equal(title(fixture.container), "Run B");
    assert.deepEqual(workflowRequests, [runA.id], "offline, run B's workflow is never requested");
    assert.equal(Boolean(section(fixture.container, "Workflow Progress")), false, "Workflow Progress is not shown");
    assert.equal(Boolean(section(fixture.container, "Workflow Artifacts")), false, "Workflow Artifacts is not shown");
    assert.equal(Boolean(fixture.container.querySelector(".run-artifact-preview")), false, "no artifact preview is open");
    assert.doesNotMatch(fixture.container.textContent ?? "", /Run A|run-a-notes/u);
  } finally {
    await unmount(fixture);
  }
});
