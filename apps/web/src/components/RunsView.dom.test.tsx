import assert from "node:assert/strict";
import test, { describe } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { RunView, SessionView, UiSnapshotMessage, WorkflowArtifactView, WorkflowInstanceDetail } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { viewTitle, type View, type ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { RunDetail, RunsView } from "./RunsView.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

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
// The run title is the detail bar's h1 (#1801).
const title = (container: HTMLDivElement) => container.querySelector(".detail-bar-title")?.textContent;

test("a loaded run titles its page by name and returns to Multi-Agent Runs", async () => {
  const fixture = await mountRunDetail({ workflowInstances: pending, runWorkflowArtifacts: pending } as Partial<ApiClient>);
  try {
    const heading = fixture.container.querySelector("h1#page-title")?.textContent;
    assert.equal(heading, "Run A");
    assert.equal(heading, viewTitle({ name: "run", id: runA.id }, runA.title), "the page h1 and viewTitle() name the same run");
    assert.equal(fixture.container.querySelector(".detail-bar-back")?.getAttribute("aria-label"), "Back to Multi-Agent Runs");

    // A run the snapshot does not have falls back to the generic noun.
    await fixture.jumpTo("run-missing");
    assert.equal(fixture.container.querySelector("h1#page-title")?.textContent, "Multi-Agent Run");
  } finally {
    await unmount(fixture);
  }
});

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
    assert.ok(domWindow.document.querySelector('[role="dialog"]'), "run A's artifact preview is open");

    await act(async () => fixture.socket.onclose?.({ code: 1006 }));
    await fixture.jumpTo(runB.id);

    assert.equal(title(fixture.container), "Run B");
    assert.deepEqual(workflowRequests, [runA.id], "offline, run B's workflow is never requested");
    assert.equal(Boolean(section(fixture.container, "Workflow Progress")), false, "Workflow Progress is not shown");
    assert.equal(Boolean(section(fixture.container, "Workflow Artifacts")), false, "Workflow Artifacts is not shown");
    assert.equal(Boolean(domWindow.document.querySelector('[role="dialog"]')), false, "no artifact preview is open");
    assert.doesNotMatch(fixture.container.textContent ?? "", /Run A|run-a-notes/u);
  } finally {
    await unmount(fixture);
  }
});

/** Renders the Runs list with a socket the test drives: nothing arrives until it says so. */
async function renderRunsList(
  drive: (socket: FakeSocket) => void,
): Promise<{ text: string; createButton: boolean; headerCreateButton: boolean }> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "runs-list", runtimeKey: "runs-list:1",
    createSocket: (() => { let first = true; return () => { if (!first) return new FakeSocket(); first = false; return socket; }; })(),
    close() {},
  };
  const navigation: ViewNavigation = { current: () => ({ name: "runs" }), push() {}, listen: () => () => {} };
  try {
    await act(async () => root.render(
      <ApiProvider client={api}>
        <StoreProvider connection={connection} navigation={navigation}>
          <RunsView onNewRun={() => {}} />
        </StoreProvider>
      </ApiProvider>,
    ));
    await act(async () => drive(socket));
    return {
      text: container.textContent ?? "",
      // The empty state's own action. The page header's primary is a separate control (#1801): it
      // is always offered, as the top bar's was, and only the empty state waits for a snapshot.
      createButton: [...container.querySelectorAll(".state .actions button")].some((button) => button.textContent === "New Multi-Agent Run"),
      headerCreateButton: [...container.querySelectorAll(".page-header button")]
        .some((button) => button.textContent === "New Multi-Agent Run"),
    };
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

const snapshotWithRuns = (runs: RunView[]): UiSnapshotMessage => ({
  type: "snapshot",
  capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
  runners: [], boxes: [], projects: [], sessions: [], runs, pods: [],
});

test("before the first snapshot the Runs list is loading, not empty", async () => {
  const list = await renderRunsList(() => {});
  assert.match(list.text, /Loading Multi-Agent Runs…/u);
  assert.doesNotMatch(list.text, /No Multi-Agent Runs Yet/u);
  assert.equal(list.createButton, false);
  assert.equal(list.headerCreateButton, true);
});

test("an offline or unpaired dashboard shows the Runs list as unavailable, not empty", async () => {
  const offline = await renderRunsList((socket) => socket.onclose?.({ code: 1006 }));
  assert.match(offline.text, /Multi-Agent Runs Unavailable/u);
  assert.doesNotMatch(offline.text, /No Multi-Agent Runs Yet/u);
  assert.equal(offline.createButton, false);

  const unauthorized = await renderRunsList((socket) => socket.onclose?.({ code: 1008 }));
  assert.match(unauthorized.text, /Pair to Load Multi-Agent Runs/u);
  assert.equal(unauthorized.createButton, false);
});

test("only a loaded snapshot with no runs shows the empty state and its create action", async () => {
  const empty = await renderRunsList((socket) => socket.push(snapshotWithRuns([])));
  assert.match(empty.text, /No Multi-Agent Runs Yet/u);
  assert.equal(empty.createButton, true);

  const listed = await renderRunsList((socket) => socket.push(snapshotWithRuns([runA])));
  assert.match(listed.text, /Run A/u);
  assert.doesNotMatch(listed.text, /No Multi-Agent Runs Yet|Loading/u);
});

test("a canceled workflow attempt reads Canceled, while its wire status stays cancelled", async () => {
  const workflow = {
    ...workflowA,
    attempts: [{
      attemptId: "attempt-1", instanceId: workflowA.instanceId, nodeId: "build", attempt: 1, status: "cancelled",
      dispatchKey: "dispatch-1", startedAt: 1, deadlineAt: 2, completedAt: 2,
    }],
  } as WorkflowInstanceDetail;
  const fixture = await mountRunDetail({
    workflowInstances: async () => [workflow],
    workflowInstance: async () => workflow,
    runWorkflowArtifacts: async () => ({ artifacts: [] }),
  } as Partial<ApiClient>);
  try {
    const progress = section(fixture.container, "Workflow Progress")?.textContent ?? "";
    assert.match(progress, /Latest Attempt: Canceled/u);
    assert.doesNotMatch(progress, /Cancelled/u);
  } finally {
    await unmount(fixture);
  }
});

describe("Run detail's artifacts (#2855)", () => {
  const member = {
    id: "s_member_7c1d", runnerId: "runner-1", agentId: "claude", agentName: "Claude", driver: "claude-code",
    title: "Builder", status: "idle", runId: runA.id,
  } as unknown as SessionView;
  const byAgent = {
    ...artifactA, artifactId: "artifact-agent", name: "Build log with a long name that the row truncates",
    mimeType: "text/plain", sha256: "b".repeat(64), createdBy: { kind: "agent", id: member.id }, createdAt: Date.now() - 120_000,
  } as WorkflowArtifactView;
  const byPerson = {
    ...artifactA, artifactId: "artifact-person", name: "review.md", kind: "review_report", mimeType: "text/markdown",
    sha256: "c".repeat(64), createdBy: { kind: "human", id: "usr_51e0a9" }, createdAt: Date.now() - 60_000,
  } as WorkflowArtifactView;
  const later = { ...artifactA, artifactId: "artifact-later", name: "later.txt", sha256: "d".repeat(64) } as WorkflowArtifactView;

  const rowsOf = (container: HTMLDivElement) => [...container.querySelectorAll<HTMLButtonElement>(".run-artifacts .surface .row.row-2")];

  test("artifacts are full-width two-line rows naming kind, agent, time and size, with no ids or hashes", async () => {
    const fixture = await mountRunDetail({
      workflowInstances: async () => [],
      runWorkflowArtifacts: async () => ({ artifacts: [byAgent, byPerson] }),
    } as Partial<ApiClient>);
    try {
      await act(async () => fixture.socket.push({
        type: "snapshot",
        capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
        runners: [], boxes: [], projects: [], sessions: [member], runs: [runA, runB], pods: [],
      }));
      const rows = rowsOf(fixture.container);
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.querySelector(".row-title")?.textContent, byAgent.name);
      assert.deepEqual([...rows[0]!.querySelectorAll(".art-row-meta > span")].map((span) => span.textContent), ["Test log", "Claude"]);
      assert.ok(rows[0]!.querySelector(".art-row-meta > time"), "when it was saved");
      assert.equal(rows[0]!.querySelector(".art-size")?.textContent, "12 B");
      assert.ok(rows[0]!.querySelector(".art-kind svg"), "the kind's icon leads the row");
      assert.equal(fixture.container.querySelector(".run-artifacts-head")?.textContent, "Artifacts 2");
      const text = fixture.container.querySelector(".run-artifacts")?.textContent ?? "";
      for (const forbidden of [member.id, "usr_", "text/plain", "text/markdown", "bbbbbbbbbbbb", "cccccccccccc"]) {
        assert.ok(!text.includes(forbidden), `the list never shows ${forbidden}`);
      }
      assertNoDomNode(fixture.container.querySelector(".run-artifact-card"), "no card grid");
    } finally {
      await unmount(fixture);
    }
  });

  test("choosing a row opens the preview in a large dialog with Done, and no × renders", async () => {
    const fixture = await mountRunDetail({
      workflowInstances: async () => [],
      runWorkflowArtifacts: async () => ({ artifacts: [byAgent] }),
    } as Partial<ApiClient>);
    try {
      await act(async () => rowsOf(fixture.container)[0]!.click());
      const dialog = document.querySelector('[role="dialog"]');
      assert.ok(dialog?.closest(".modal.lg"), "a large dialog (§7.1)");
      assert.equal(dialog!.querySelector(".modal-title")?.textContent, byAgent.name);
      assert.doesNotMatch(document.body.textContent ?? "", /×/u);
      const done = [...dialog!.querySelectorAll<HTMLButtonElement>(".modal-foot button")].find((button) => button.textContent === "Done")!;
      await act(async () => done.click());
      assertNoDomNode(document.querySelector('[role="dialog"]'), "Done closes the preview");
    } finally {
      await unmount(fixture);
    }
  });

  test("a list foot's Show More loads the next page", async () => {
    const cursors: Array<string | undefined> = [];
    const fixture = await mountRunDetail({
      workflowInstances: async () => [],
      runWorkflowArtifacts: async (_runId: string, cursor?: string) => {
        cursors.push(cursor);
        return cursor ? { artifacts: [later] } : { artifacts: [byAgent], nextCursor: "page-2" };
      },
    } as Partial<ApiClient>);
    try {
      assert.equal(fixture.container.querySelector(".run-artifacts-head")?.textContent, "Artifacts 1+");
      const more = fixture.container.querySelector<HTMLButtonElement>(".run-artifacts .list-foot button")!;
      assert.equal(more.textContent?.trim(), "Show More");
      await act(async () => { more.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
      assert.equal(cursors.at(-1), "page-2");
      assert.equal(rowsOf(fixture.container).length, 2);
      assertNoDomNode(fixture.container.querySelector(".run-artifacts .list-foot"), "the last page has no Show More");
    } finally {
      await unmount(fixture);
    }
  });
});
