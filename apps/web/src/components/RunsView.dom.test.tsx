import assert from "node:assert/strict";
import test, { describe } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { RunView, SessionView, UiSnapshotMessage, WorkflowArtifactView, WorkflowDefinition, WorkflowInstanceDetail, WorkflowInstanceView } from "@wollipog/protocol";
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
    assert.match(fixture.container.querySelector(".run-workflow-error")?.textContent ?? "", /Run A workflow failed/u);
    assert.match(section(fixture.container, "Workflow Artifacts")?.textContent ?? "", /Run A artifacts failed/u);

    await fixture.jumpTo(runB.id);

    assert.equal(title(fixture.container), "Run B");
    assert.deepEqual(workflowRequests, [runA.id, runB.id], "run B's workflow request is still pending");
    assert.equal(Boolean(fixture.container.querySelector(".run-workflow-error")), false, "run A's workflow error is not shown");
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

interface ListFixture {
  container: HTMLDivElement;
  socket: FakeSocket;
  /** Every view the list asked to open. */
  opened: View[];
  unmount: () => Promise<void>;
}

/** Mounts the Runs list with a socket the test drives: nothing arrives until it says so. */
async function mountRunsList(drive: (socket: FakeSocket) => void, client: Partial<ApiClient> = {}): Promise<ListFixture> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "runs-list", runtimeKey: "runs-list:1",
    createSocket: (() => { let first = true; return () => { if (!first) return new FakeSocket(); first = false; return socket; }; })(),
    close() {},
  };
  const opened: View[] = [];
  const navigation: ViewNavigation = { current: () => ({ name: "runs" }), push: (view) => { opened.push(view); }, listen: () => () => {} };
  const apiClient = { ...api, workflowInstances: async () => [], workflowDefinitions: async () => [], ...client } as unknown as ApiClient;
  await act(async () => root.render(
    <ApiProvider client={apiClient}>
      <StoreProvider connection={connection} navigation={navigation}>
        <RunsView onNewRun={() => {}} />
      </StoreProvider>
    </ApiProvider>,
  ));
  await act(async () => drive(socket));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return {
    container, socket, opened,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Renders the Runs list once and reads what it offers. */
async function renderRunsList(
  drive: (socket: FakeSocket) => void,
): Promise<{ text: string; createButton: boolean; headerCreateButton: boolean; newRunButtons: number }> {
  const fixture = await mountRunsList(drive);
  try {
    const { container } = fixture;
    const buttons = [...container.querySelectorAll("button")];
    return {
      text: container.textContent ?? "",
      createButton: [...container.querySelectorAll(".state .actions button")].some((button) => button.textContent === "New Run"),
      headerCreateButton: [...container.querySelectorAll(".page-header button")].some((button) => button.textContent === "New Run"),
      newRunButtons: buttons.filter((button) => button.textContent === "New Run").length,
    };
  } finally {
    await fixture.unmount();
  }
}

const snapshotWithRuns = (runs: RunView[], sessions: SessionView[] = []): UiSnapshotMessage => ({
  type: "snapshot",
  capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
  runners: [], boxes: [], projects: [], sessions, runs, pods: [],
});

test("before the first snapshot the Runs list is loading, not empty", async () => {
  const list = await renderRunsList(() => {});
  assert.match(list.text, /Loading Multi-Agent Runs…/u);
  assert.doesNotMatch(list.text, /No Multi-Agent Runs Yet/u);
  assert.equal(list.createButton, false);
  // The header keeps New Run until the empty state can offer it.
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

test("with no runs after the snapshot, exactly one New Run renders, in the empty state", async () => {
  const empty = await renderRunsList((socket) => socket.push(snapshotWithRuns([])));
  assert.match(empty.text, /No Multi-Agent Runs Yet/u);
  assert.match(empty.text, /Give one task to two or three agents, or run a Build and Review workflow, and compare what each one does\./u);
  assert.equal(empty.createButton, true);
  assert.equal(empty.headerCreateButton, false, "the empty state owns the one create action");
  assert.equal(empty.newRunButtons, 1);

  const listed = await renderRunsList((socket) => socket.push(snapshotWithRuns([runA])));
  assert.match(listed.text, /Run A/u);
  assert.doesNotMatch(listed.text, /No Multi-Agent Runs Yet|Loading/u);
  assert.equal(listed.headerCreateButton, true);
  assert.equal(listed.newRunButtons, 1);
});

describe("Runs list rows (#2974)", () => {
  const agent = (id: string, agentName: string, driver: string, status = "idle", over: Record<string, unknown> = {}) => ({
    id, runnerId: `runner-${id}`, agentId: agentName.toLowerCase(), agentName, driver, title: agentName, status,
    pendingApproval: null, archived: false, ...over,
  }) as unknown as SessionView;
  const claude = agent("s_claude_51e0", "Claude Code", "claude-code");
  const codex = agent("s_codex_7c1d", "Codex", "codex-app-server", "running");
  const opencode = agent("s_opencode_93ab", "OpenCode", "opencode");
  const gemini = agent("s_gemini_02fe", "Gemini CLI", "gemini");
  const builder = agent("s_builder_6d2a", "Claude Code", "claude-code");

  const comparison: RunView = {
    id: "run_cmp_44a1", title: "Compare refactors of the scheduler with a title long enough to need an ellipsis",
    prompt: "Refactor the scheduler", workspaceId: "ws-alpha", workspaceName: "Alpha",
    createdAt: Date.now() - 5 * 60_000, updatedAt: 1, sessionIds: [claude.id, codex.id, opencode.id, gemini.id],
  };
  const finished: RunView = {
    id: "run_done_12bc", title: "Finished comparison", prompt: "Done", workspaceId: null, workspaceName: null,
    createdAt: Date.now() - 2 * 3_600_000, updatedAt: 1, sessionIds: [claude.id, opencode.id],
  };
  const gated: RunView = {
    id: "run_wf_88d0", title: "Build and review the parser", prompt: "Build it", workspaceId: "ws-alpha", workspaceName: "Alpha",
    createdAt: Date.now() - 60_000, updatedAt: 1, sessionIds: [builder.id],
  };
  const gatedInstance = {
    instanceId: "instance-gated", workflowId: "builtin:build-review", workflowVersion: 1, runId: gated.id, status: "waiting_gate",
    transitionCount: 1, createdBy: { kind: "system" }, createdAt: gated.createdAt, updatedAt: 1,
    nodeStates: [{ nodeId: "build", status: "succeeded", attemptCount: 1, sessionId: builder.id }, { nodeId: "gate", status: "waiting_gate", attemptCount: 0 }],
  } as WorkflowInstanceView;
  const definitions = [{ workflowId: "builtin:build-review", name: "Build and Review" }] as WorkflowDefinition[];

  const rowNamed = (container: HTMLDivElement, title: string) =>
    [...container.querySelectorAll<HTMLButtonElement>(".surface > .row.row-2")].find((row) => row.querySelector(".row-title")?.textContent === title)!;
  const meta = (row: Element) => [...row.querySelectorAll(".list-row-meta > span")].map((span) => span.textContent);

  const loaded = (client: Partial<ApiClient> = {}) => mountRunsList(
    (socket) => socket.push(snapshotWithRuns([comparison, finished, gated], [claude, codex, opencode, gemini, builder])),
    { workflowInstances: async () => [gatedInstance], workflowDefinitions: async () => definitions, ...client } as Partial<ApiClient>,
  );

  test("each row is one two-line row with an icon, the title, at most one badge, the type, project, agents and time, and no ids", async () => {
    const fixture = await loaded();
    try {
      const rows = [...fixture.container.querySelectorAll<HTMLButtonElement>(".surface > .row")];
      assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.ok(row.classList.contains("row-2"), "a 56px two-line row (§5.2)");
        assert.ok(row.querySelector(".row-icon svg"), "a leading 16px icon");
        assert.ok(row.querySelectorAll(".status").length <= 1, "at most one badge");
        assert.ok(row.querySelector(".row-trail > time[datetime]"), "the created time trails");
        assertNoDomNode(row.querySelector(".count"), "no agent count pill on line 1");
        for (const id of [claude.id, codex.id, opencode.id, gemini.id, builder.id, "runner-", comparison.id, gated.id, finished.id]) {
          assert.ok(!row.outerHTML.includes(id), `no row carries ${id}`);
        }
      }
      // Newest first.
      assert.deepEqual(rows.map((row) => row.querySelector(".row-title")?.textContent), [gated.title, comparison.title, finished.title]);

      const compare = rowNamed(fixture.container, comparison.title);
      assert.equal(compare.querySelector(".row-title")?.getAttribute("title"), comparison.title, "the full title is its tooltip");
      assert.deepEqual(meta(compare), ["Comparison", "Alpha", "Claude Code, Codex App Server, OpenCode +1"]);
      assert.equal(compare.querySelector(".row-trail time")?.textContent, "5m ago");
      assert.doesNotMatch(compare.querySelector(".list-row-meta")?.textContent ?? "", /·/u, "meta is spaced, not dotted");

      const workflow = rowNamed(fixture.container, gated.title);
      assert.deepEqual(meta(workflow), ["Build and Review", "Alpha", "Claude Code"]);
      assert.notEqual(workflow.querySelector(".row-icon")?.innerHTML, compare.querySelector(".row-icon")?.innerHTML,
        "a workflow and a comparison lead with different icons");
      assert.deepEqual(meta(rowNamed(fixture.container, finished.title)), ["Comparison", "Claude Code, OpenCode"]);
    } finally {
      await fixture.unmount();
    }
  });

  test("a gated workflow reads Awaiting Decision, a comparison with a running member Running, and an idle one no badge", async () => {
    const fixture = await loaded();
    try {
      const badge = (title: string) => rowNamed(fixture.container, title).querySelector(".status");
      assert.equal(badge(gated.title)?.textContent, "Awaiting Decision");
      assert.ok(badge(gated.title)?.classList.contains("t-warning"));
      assert.equal(badge(comparison.title)?.textContent, "Running");
      assert.ok(badge(comparison.title)?.classList.contains("t-info"));
      assert.ok(badge(comparison.title)?.classList.contains("pulse"));
      assertNoDomNode(badge(finished.title), "every member idle: no badge");

      // A member that needs the person outranks the running one.
      const asking = { ...claude, status: "input_required" } as SessionView;
      await act(async () => fixture.socket.push(snapshotWithRuns([comparison, finished, gated], [asking, codex, opencode, gemini, builder])));
      assert.equal(badge(comparison.title)?.textContent, "Approval Required");
      assert.equal(badge(finished.title)?.textContent, "Approval Required");
    } finally {
      await fixture.unmount();
    }
  });

  test("workflows load once with the list and again when a run's updatedAt changes", async () => {
    const requests: string[] = [];
    const fixture = await loaded({
      workflowInstances: async () => { requests.push("instances"); return [gatedInstance]; },
      workflowDefinitions: async () => { requests.push("definitions"); return definitions; },
    } as Partial<ApiClient>);
    try {
      assert.deepEqual(requests.sort(), ["definitions", "instances"]);
      await act(async () => fixture.socket.push(snapshotWithRuns([comparison, finished, gated], [claude, codex, opencode, gemini, builder])));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      assert.equal(requests.length, 2, "an unchanged run does not reload");
      await act(async () => fixture.socket.onmessage?.({ data: JSON.stringify({ type: "run_upsert", run: { ...gated, updatedAt: 2 } }) }));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      assert.deepEqual(requests.sort(), ["definitions", "definitions", "instances", "instances"]);
    } finally {
      await fixture.unmount();
    }
  });

  test("offline with runs loaded, the rows stay dimmed under Reconnecting… and still open their run", async () => {
    const fixture = await loaded();
    try {
      await act(async () => fixture.socket.onclose?.({ code: 1006 }));
      const page = fixture.container.querySelector(".page")!;
      const line = page.querySelector('[role="status"]');
      assert.equal(line?.textContent, "Reconnecting…");
      const stale = page.querySelector(".is-stale");
      assert.ok(stale, "the rows are wrapped in StaleContent");
      assert.equal(line!.compareDocumentPosition(stale!) & domWindow.Node.DOCUMENT_POSITION_FOLLOWING, domWindow.Node.DOCUMENT_POSITION_FOLLOWING,
        "the line sits above the rows");
      assert.ok(!stale!.contains(line), "the line is not dimmed with them");
      assert.equal(stale!.querySelectorAll(".row").length, 3);
      assert.doesNotMatch(page.textContent ?? "", /No Multi-Agent Runs Yet|Unavailable/u, "never an empty state");
      assert.equal(rowNamed(fixture.container, gated.title).querySelector(".status")?.textContent, "Awaiting Decision", "last-known status stays");
      await act(async () => rowNamed(fixture.container, comparison.title).click());
      assert.deepEqual(fixture.opened.at(-1), { name: "run", id: comparison.id });
    } finally {
      await fixture.unmount();
    }
  });

  test("a failed workflow load leaves the rows without a type rather than guessing one", async () => {
    const fixture = await loaded({ workflowInstances: async () => { throw new Error("offline"); } } as Partial<ApiClient>);
    try {
      const row = rowNamed(fixture.container, finished.title);
      assert.deepEqual(meta(row), ["Claude Code, OpenCode"]);
      assertNoDomNode(row.querySelector(".row-icon svg"), "no type icon either");
    } finally {
      await fixture.unmount();
    }
  });

  test("a load the list has moved past never applies, even after the newer one fails", async () => {
    const loads: Array<{ resolve: (value: WorkflowInstanceView[]) => void; reject: (error: Error) => void }> = [];
    const fixture = await loaded({
      workflowInstances: () => new Promise<WorkflowInstanceView[]>((resolve, reject) => { loads.push({ resolve, reject }); }),
    } as Partial<ApiClient>);
    try {
      assert.equal(loads.length, 1);
      // A workflow instance is attached to the run: its update starts a second load.
      await act(async () => fixture.socket.onmessage?.({ data: JSON.stringify({ type: "run_upsert", run: { ...gated, updatedAt: 2 } }) }));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      assert.equal(loads.length, 2);
      await act(async () => { loads[1]!.reject(new Error("offline")); await new Promise((resolve) => setTimeout(resolve, 0)); });
      // The first load answered from before the attachment: it must not label the run Comparison.
      await act(async () => { loads[0]!.resolve([]); await new Promise((resolve) => setTimeout(resolve, 0)); });
      assert.deepEqual(meta(rowNamed(fixture.container, gated.title)), ["Alpha", "Claude Code"]);
      assertNoDomNode(rowNamed(fixture.container, gated.title).querySelector(".row-icon svg"), "no type is guessed");
    } finally {
      await fixture.unmount();
    }
  });

  test("a failed definition load only costs a workflow its name", async () => {
    const fixture = await loaded({ workflowDefinitions: async () => { throw new Error("forbidden"); } } as Partial<ApiClient>);
    try {
      const workflow = rowNamed(fixture.container, gated.title);
      assert.deepEqual(meta(workflow), ["Workflow", "Alpha", "Claude Code"]);
      assert.equal(workflow.querySelector(".status")?.textContent, "Awaiting Decision");
      assert.deepEqual(meta(rowNamed(fixture.container, finished.title)), ["Comparison", "Claude Code, OpenCode"]);
    } finally {
      await fixture.unmount();
    }
  });
});

test("a pruned workflow explains missing events while retaining node outcomes", async () => {
  const workflow: WorkflowInstanceDetail = { ...workflowA, events: [],
    eventHistoryPruned: { prunedAt: 1, eventCount: 1200, retentionDays: 90 } };
  const fixture = await mountRunDetail({ workflowInstances: async () => [workflow], workflowInstance: async () => workflow,
    runWorkflowArtifacts: async () => ({ artifacts: [] }) } as Partial<ApiClient>);
  try {
    const progress = section(fixture.container, "Workflow Progress")?.textContent ?? "";
    assert.match(progress, /Event History Pruned[\s\S]*1,200 workflow events were removed[\s\S]*90-day/);
    assert.match(progress, /node outcomes, attempts, artifacts, decisions and action receipts are kept/);
    assert.equal(fixture.container.querySelectorAll(".wf-step").length, workflow.nodeStates.length);
  } finally { await unmount(fixture); }
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
    assert.match(progress, /Last Attempt\s*Canceled/u);
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
