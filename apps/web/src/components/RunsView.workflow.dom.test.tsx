import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import React, { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import {
  PROTOCOL_VERSION,
  type RunView,
  type SessionView,
  type UiSnapshotMessage,
  type WorkflowArtifactView,
  type WorkflowAttemptView,
  type WorkflowInstanceDetail,
  type WorkflowNodeDefinition,
  type WorkflowNodeState,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { clearTimestampFormatterCache, formatClock } from "../format.js";
import { RunDetail } from "./RunsView.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

/**
 * A workflow run's page (#2977): numbered steps beside the selected agent step's activity, and one
 * panel for the selected step that names what a decision approves, when a retry opens and what a
 * waiting step waits for. Everything renders under StrictMode, so effects mount twice and async
 * completions are checked against the page that is current when they settle. Time is a fixed clock
 * in UTC, never the host's.
 */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  localStorage: domWindow.localStorage, Element: domWindow.Element, HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement, Node: domWindow.Node, Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent, React, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

// A fixed clock and zone: 2:31 AM UTC.
const NOW = Date.UTC(2026, 9, 20, 2, 31, 0);
let clock = NOW;
const realNow = Date.now;
const previousZone = process.env.TZ;
before(() => {
  process.env.TZ = "UTC";
  clearTimestampFormatterCache();
  Date.now = () => clock;
});
after(() => {
  Date.now = realNow;
  if (previousZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousZone;
  clearTimestampFormatterCache();
});

const member = (id: string, agentId: string, agentName: string, driver: string) => ({
  id, runnerId: "runner-1", agentId, agentName, driver, title: agentName, status: "idle",
  pendingApproval: null, archived: false, eventEpoch: 0, messageCount: 0, workspaceName: "Alpha",
}) as unknown as SessionView;
const claude = member("s_claude", "claude-code-agent", "Claude Code", "claude-code");
const codex = member("s_codex", "codex-app-server-agent", "Codex", "codex-app-server");

const agentNode = (nodeId: string, role: string, agentId: string, extra: Partial<WorkflowNodeDefinition> = {}): WorkflowNodeDefinition => ({
  nodeId, kind: "agent", role, agentId, inputs: [], outputs: [], retry: { maxAttempts: 3, backoffMs: 300_000 }, timeoutMs: 1_000, ...extra,
});
const BUILD = agentNode("build", "builder", "claude", { outputs: [{ name: "implementation_patch", kind: "patch" }] });
const APPROVE: WorkflowNodeDefinition = {
  nodeId: "approve", kind: "human_gate", role: "approver", inputs: [{ name: "implementation_patch", kind: "patch" }],
  outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1_000,
};
const REVIEW = agentNode("review", "reviewer", "codex", {
  inputs: [{ name: "implementation_patch", kind: "patch" }],
  outputs: [{ name: "review_report", kind: "review_report" }],
});

function workflow(
  states: Partial<Record<string, Partial<WorkflowNodeState>>>,
  { nodes = [BUILD, APPROVE, REVIEW], attempts = [], status = "running", updatedAt = NOW }: {
    nodes?: WorkflowNodeDefinition[]; attempts?: WorkflowAttemptView[]; status?: WorkflowInstanceDetail["status"]; updatedAt?: number;
  } = {},
): WorkflowInstanceDetail {
  return {
    instanceId: "wfi", workflowId: "wf", workflowVersion: 2, runId: "run-wf", status, transitionCount: 3,
    createdBy: { kind: "system", id: "test" }, createdAt: NOW, updatedAt, events: [], attempts,
    nodeStates: nodes.map((node) => ({ nodeId: node.nodeId, status: "pending", attemptCount: 0, ...states[node.nodeId] })),
    definition: {
      workflowId: "wf", version: 2, source: "custom", name: "Build and Review", maxTransitions: 24, nodes,
      edges: [
        { edgeId: "e1", from: "build", to: "approve", on: "success" },
        { edgeId: "e2", from: "approve", to: "review", on: "success" },
      ],
      createdBy: { kind: "system", id: "test" }, createdAt: NOW,
    },
  } as WorkflowInstanceDetail;
}

const PATCH = {
  artifactId: "art-patch", runId: "run-wf", sessionId: claude.id, kind: "patch", name: "implementation.patch",
  mimeType: "text/x-diff", encoding: "utf8", sizeBytes: 2_048, sha256: "a".repeat(64),
  createdBy: { kind: "agent", id: claude.id }, createdAt: NOW - 60_000,
} as WorkflowArtifactView;

const gated = (extra: Parameters<typeof workflow>[1] = {}) => workflow({
  build: { status: "succeeded", attemptCount: 1, sessionId: claude.id, outcome: "success" },
  approve: { status: "waiting_gate" },
}, { status: "waiting_gate", ...extra });

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

let showRunPage: (shown: boolean) => void = () => {};
function RunRoute() {
  const view = useStoreSelector((state) => state.view);
  const [shown, setShown] = React.useState(true);
  React.useEffect(() => { showRunPage = setShown; }, []);
  return shown && view.name === "run" ? <RunDetail runId={view.id} member={view.member} /> : null;
}

interface Fixture {
  container: HTMLDivElement;
  root: Root;
  socket: FakeSocket;
  run: RunView;
  opened: View[];
}

async function settle() {
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function setViewport(width: number, height: number) {
  await act(async () => {
    domWindow.happyDOM.setViewport({ width, height });
    domWindow.dispatchEvent(new domWindow.Event("resize"));
  });
}

async function mount(client: Partial<ApiClient>, sessions: SessionView[] = [claude, codex]): Promise<Fixture> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  let socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "runs-workflow", runtimeKey: "runs-workflow:1",
    createSocket: () => (socket = new FakeSocket()),
    close() {},
  };
  const run: RunView = {
    id: "run-wf", title: "Add Retry Backoff", prompt: "Add exponential backoff to the webhook retries.", workspaceId: "ws-alpha",
    workspaceName: "Alpha", createdAt: NOW, updatedAt: NOW, sessionIds: sessions.map((session) => session.id),
  };
  const opened: View[] = [];
  let current: View = { name: "run", id: run.id };
  const navigation: ViewNavigation = {
    current: () => current,
    push(view) { current = view; opened.push(view); },
    replace(view) { current = view; },
    listen: () => () => {},
  };
  const apiClient = {
    ...api, workflowInstances: async () => [{ instanceId: "wfi" }], runWorkflowArtifacts: async () => ({ artifacts: [PATCH] }),
    getSessionEventPage: () => new Promise<never>(() => {}), ...client,
  } as unknown as ApiClient;
  await act(async () => root.render(
    <StrictMode>
      <ApiProvider client={apiClient}>
        <StoreProvider connection={connection} navigation={navigation}>
          <FeedbackProvider>
            <RunRoute />
          </FeedbackProvider>
        </StoreProvider>
      </ApiProvider>
    </StrictMode>,
  ));
  await act(async () => socket.push({
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [{
      runnerId: "runner-1", hostname: "studio", displayName: "Studio", os: "macos", version: "1", status: "online",
      protocolVersion: PROTOCOL_VERSION, agents: [], workspaces: [], connectedAt: NOW, lastSeen: NOW,
    }],
    boxes: [], projects: [], sessions, runs: [run], pods: [],
  } as unknown as UiSnapshotMessage));
  await settle();
  return { container, root, socket, run, opened };
}

async function unmount(fixture: Fixture) {
  await act(async () => fixture.root.unmount());
  fixture.container.remove();
}

async function click(element: unknown) {
  assert.ok(element, "the element to click exists");
  await act(async () => { fireDomEvent.click(element as never); });
  await settle();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const doc = () => domWindow.document as unknown as Document;
const buttonNamed = (scope: ParentNode, name: string) => [...scope.querySelectorAll("button")]
  .find((button) => button.textContent === name || button.getAttribute("aria-label") === name) ?? null;
const dialogTitled = (title: string) => [...doc().querySelectorAll('[role="dialog"]')]
  .find((dialog) => dialog.querySelector(".modal-title, h2")?.textContent === title) ?? null;
const stepButton = (container: Element, role: string) => [...container.querySelectorAll(".wf-step-button")]
  .find((button) => button.querySelector(".wf-step-role")?.textContent?.endsWith(role)) ?? null;
const panel = (container: Element) => container.querySelector(".wf-panel");
const facts = (container: Element) => Object.fromEntries([...(panel(container)?.querySelectorAll(".facts > div") ?? [])]
  .map((pair) => [pair.querySelector("dt")?.textContent, pair.querySelector("dd")?.textContent]));

describe("a workflow run's steps and decision (#2977)", () => {
  test("a waiting gate opens selected in the warning tone, names the patch it approves and confirms Reject", async () => {
    const resolved: Array<[string, string, string]> = [];
    const fixture = await mount({
      workflowInstance: async () => gated(),
      resolveWorkflowGate: async (instanceId: string, nodeId: string, outcome: string) => {
        resolved.push([instanceId, nodeId, outcome]);
        return workflow({ build: { status: "succeeded", attemptCount: 1 }, approve: { status: "failed", outcome: "failure" } }, { status: "failed", updatedAt: NOW + 1 });
      },
    } as unknown as Partial<ApiClient>);
    try {
      const { container } = fixture;
      // Numbered steps in order, each its role, a sub-line and one badge; no grid of cards.
      assertNoDomNode(container.querySelector(".workflow-node, .workflow-node-grid, .workflow-inspector"));
      const steps = [...container.querySelectorAll(".wf-step")];
      assert.deepEqual(steps.map((step) => step.querySelector(".wf-step-marker")?.textContent), ["1", "2", "3"]);
      assert.deepEqual(steps.map((step) => step.querySelector(".wf-step-sub")?.textContent), [
        "Claude Code produces a patch", "You approve or reject the patch", "Codex App Server produces a review report",
      ]);
      assert.deepEqual(steps.map((step) => step.querySelectorAll(".status").length), [1, 1, 1]);
      // The gate is selected first, and amber is its alone: marker and badge.
      assert.equal(stepButton(container, "Approver")?.getAttribute("aria-current"), "true");
      assert.deepEqual(steps.filter((step) => step.classList.contains("t-warning")).map((step) => step.querySelector(".wf-step-role")?.textContent),
        ["Step 2: Approver"]);
      assert.equal(steps[1]!.querySelector(".status")?.classList.contains("t-warning"), true);
      assert.equal(steps[1]!.querySelector(".status")?.textContent, "Awaiting Decision");
      assert.equal(container.querySelector(".wf-summary")?.textContent, "Build and Review, version 2. 3 of 24 transitions used.");

      const notice = panel(container)?.querySelector(".notice.t-warning");
      assert.ok(notice, "the gate's panel has a warning notice");
      assert.match(notice.textContent ?? "", /Your Decision Is Needed[\s\S]*Continue approves the patch and starts Reviewer\./u);
      assert.equal(notice.querySelector(".row-title")?.textContent, "implementation.patch", "the consumed artifact is a row");
      assert.ok(buttonNamed(notice, "Continue"));
      assert.doesNotMatch(container.textContent ?? "", /Stop Branch|Dispatch Step/u);

      // The artifact row opens the shipped preview dialog.
      await click(notice.querySelector(".row"));
      assert.ok(dialogTitled("implementation.patch"), "the row opens the artifact preview");
      await click(buttonNamed(dialogTitled("implementation.patch")!, "Done"));

      await click(buttonNamed(notice, "Reject…"));
      const confirmation = dialogTitled("Reject Patch");
      assert.ok(confirmation, "Reject… asks first");
      assert.match(confirmation.textContent ?? "", /The run ends here and later steps don't start\. This can't be undone\./u);
      assert.deepEqual(resolved, [], "nothing is resolved before the confirmation");
      await click(buttonNamed(confirmation, "Reject"));
      assert.deepEqual(resolved, [["wfi", "approve", "failure"]]);
      assertNoDomNode(dialogTitled("Reject Patch"));
      assert.equal(facts(container).Decision, "Rejected");
    } finally {
      await unmount(fixture);
    }
  });

  test("Continue resolves the gate with success, and Cancel on Reject resolves nothing", async () => {
    const resolved: string[] = [];
    const fixture = await mount({
      workflowInstance: async () => gated(),
      resolveWorkflowGate: async (_instanceId: string, _nodeId: string, outcome: string) => {
        resolved.push(outcome);
        return workflow({ build: { status: "succeeded", attemptCount: 1 }, approve: { status: "succeeded", outcome: "success" }, review: { status: "ready" } }, { updatedAt: NOW + 1 });
      },
    } as unknown as Partial<ApiClient>);
    try {
      await click(buttonNamed(panel(fixture.container)!, "Reject…"));
      await click(buttonNamed(dialogTitled("Reject Patch")!, "Cancel"));
      assert.deepEqual(resolved, []);
      await click(buttonNamed(panel(fixture.container)!, "Continue"));
      assert.deepEqual(resolved, ["success"]);
      // With the gate decided, the ready step is the one that needs the person.
      assert.equal(stepButton(fixture.container, "Reviewer")?.getAttribute("aria-current"), "true");
      assert.ok(buttonNamed(panel(fixture.container)!, "Start Reviewer"));
    } finally {
      await unmount(fixture);
    }
  });

  test("a decision that answers after a newer load never brings the waiting gate back", async () => {
    const answer = deferred<WorkflowInstanceDetail>();
    let loads = 0;
    const fixture = await mount({
      workflowInstance: async () => (loads += 1) === 1 || loads === 2
        ? gated()
        : workflow({ build: { status: "succeeded", attemptCount: 1 }, approve: { status: "succeeded", outcome: "success" }, review: { status: "running", attemptCount: 1, sessionId: codex.id } }, { updatedAt: NOW + 5 }),
      resolveWorkflowGate: () => answer.promise,
    } as unknown as Partial<ApiClient>);
    try {
      await click(buttonNamed(panel(fixture.container)!, "Continue"));
      // The run moves on (another device decided) and the page loads the newer workflow.
      loads = 2;
      await act(async () => fixture.socket.push({ type: "run_upsert", run: { ...fixture.run, updatedAt: NOW + 5 } }));
      await settle();
      assert.equal(stepButton(fixture.container, "Reviewer")?.getAttribute("aria-current"), "true");
      // Then the slower answer to this page's Continue lands, older than what is shown.
      await act(async () => answer.resolve(gated({ updatedAt: NOW + 2 })));
      await settle();
      assertNoDomNode(fixture.container.querySelector(".wf-step.t-warning"), "the gate stays decided");
      assert.equal(stepButton(fixture.container, "Reviewer")?.getAttribute("aria-current"), "true");
    } finally {
      await unmount(fixture);
    }
  });

  test("a decision or Reject that settles after the page has gone reports nothing and throws nothing", async () => {
    const answers: Array<ReturnType<typeof deferred<WorkflowInstanceDetail>>> = [];
    const fixture = await mount({
      workflowInstance: async () => gated(),
      resolveWorkflowGate: () => { const next = deferred<WorkflowInstanceDetail>(); answers.push(next); return next.promise; },
    } as unknown as Partial<ApiClient>);
    try {
      await click(buttonNamed(panel(fixture.container)!, "Reject…"));
      await click(buttonNamed(dialogTitled("Reject Patch")!, "Reject"));
      assert.equal(answers.length, 1, "the confirmation waits on the decision");
      await act(async () => showRunPage(false));
      await settle();
      await act(async () => answers[0]!.resolve(gated({ updatedAt: NOW + 1 })));
      await settle();
      assert.equal(doc().querySelectorAll(".toast").length, 0);
    } finally {
      await unmount(fixture);
    }
  });

  test("a retry 5 minutes away is disabled with when it opens, and enables itself at readyAt", async () => {
    clock = NOW;
    const readyAt = NOW + 5 * 60_000;
    const dispatched: string[] = [];
    const fixture = await mount({
      workflowInstance: async () => workflow(
        { build: { status: "ready", attemptCount: 1, readyAt, sessionId: claude.id, error: "runner rejected the prompt" } },
        { attempts: [{ attemptId: "a1", instanceId: "wfi", nodeId: "build", attempt: 1, status: "failed", dispatchKey: "k1", sessionId: claude.id, startedAt: NOW - 60_000, deadlineAt: NOW, completedAt: NOW - 1_000, error: "runner rejected the prompt" }] },
      ),
      dispatchWorkflowNode: async (_instanceId: string, nodeId: string, key: string) => { dispatched.push(`${nodeId}:${key}`); return {}; },
    } as unknown as Partial<ApiClient>);
    try {
      const { container } = fixture;
      assert.equal(stepButton(container, "Builder")?.getAttribute("aria-current"), "true", "a ready step is selected first");
      const notice = panel(container)?.querySelector(".notice.t-danger");
      assert.ok(notice, "a delayed retry is a danger notice");
      assert.match(notice.textContent ?? "", /Last Attempt Failed[\s\S]*Attempt 1 of 3 failed\./u);
      const retry = buttonNamed(notice, "Retry Builder") as HTMLButtonElement | null;
      assert.ok(retry);
      assert.equal(retry.disabled, true);
      const reason = doc().getElementById(retry.getAttribute("aria-describedby") ?? "");
      assert.equal(reason?.textContent, `Available at ${formatClock(readyAt)}, in 5 minutes`);
      assert.equal(reason?.textContent, "Available at 2:36 AM, in 5 minutes", "in UTC, the fixed zone");
      assert.doesNotMatch(container.textContent ?? "", /just now/u);
      // The server's words stay behind Show Details.
      assert.doesNotMatch(notice.textContent ?? "", /runner rejected the prompt/u);
      await click(buttonNamed(notice, "Show Details"));
      assert.match(notice.textContent ?? "", /runner rejected the prompt/u);
      assert.equal(facts(container)["Last Attempt"], "Failed");
      assert.equal(facts(container).Outcome, undefined, "a failed attempt never reads Succeeded");

      // The clock reaches readyAt: the retry clock repaints and Retry enables, with no reason left.
      clock = readyAt + 50;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });
      await settle();
      const enabled = buttonNamed(panel(container)!, "Retry Builder") as HTMLButtonElement;
      assert.equal(enabled.disabled, false);
      assert.equal(enabled.hasAttribute("aria-describedby"), false);
      assert.doesNotMatch(panel(container)?.textContent ?? "", /Available at/u);
      await click(enabled);
      assert.deepEqual(dispatched, ["build:ui:wfi:build:2"]);
    } finally {
      clock = NOW;
      await unmount(fixture);
    }
  });

  test("a ready agent step offers Start <Role> at control size, and facts name agents, never ids", async () => {
    const fixture = await mount({
      workflowInstance: async () => workflow({ build: { status: "ready" } }),
      dispatchWorkflowNode: async () => ({}),
    } as unknown as Partial<ApiClient>);
    try {
      const { container } = fixture;
      const notice = panel(container)?.querySelector(".notice.t-info");
      assert.match(notice?.textContent ?? "", /Builder Is Ready[\s\S]*Claude Code produces a patch once you start it\./u);
      const start = buttonNamed(notice!, "Start Builder");
      assert.ok(start?.classList.contains("sm") && start.classList.contains("btn"), "a control-sized button");
      assert.equal(start?.closest(".notice-actions")?.parentElement?.classList.contains("notice-content"), true, "in the notice's action row");
      assert.deepEqual(facts(container), { Agent: "Claude Code", Attempts: "0 of 3" });
      assert.doesNotMatch(container.textContent ?? "", /claude-code-agent|codex-app-server-agent|\bclaude\b|\bcodex\b|s_claude|s_codex/u);
      // A waiting step says what it waits for.
      await click(stepButton(container, "Approver"));
      assert.equal(panel(container)?.querySelector(".wf-panel-line")?.textContent, "Starts when Builder succeeds");
    } finally {
      await unmount(fixture);
    }
  });

  test("selecting an agent step shows its session beside the steps; a gate shows the step before it", async () => {
    const fixture = await mount({ workflowInstance: async () => gated() } as unknown as Partial<ApiClient>);
    try {
      const { container } = fixture;
      const shown = () => container.querySelector(".wf-main .compare-member")?.getAttribute("aria-label");
      assert.equal(shown(), "Claude Code", "the gate's producer");
      await click(stepButton(container, "Reviewer"));
      assert.equal(shown(), "Codex App Server");
      // Its ⋯ has no Follow Up, and neither does the bar.
      assertNoDomNode(buttonNamed(container.querySelector(".detail-bar")!, "Follow Up…"));
    } finally {
      await unmount(fixture);
    }
  });

  test("a one-member workflow shows the steps and that member's transcript, and no empty column", async () => {
    const fixture = await mount({
      workflowInstance: async () => workflow({ build: { status: "running", attemptCount: 1, sessionId: claude.id } }, { nodes: [BUILD] }),
    } as unknown as Partial<ApiClient>, [claude]);
    try {
      const layout = fixture.container.querySelector(".wf-run");
      assert.ok(layout);
      assert.deepEqual([...layout.children].map((child) => child.className), ["wf-side", "wf-main"]);
      assert.equal(layout.querySelectorAll(".compare-member").length, 1);
      assert.equal(layout.querySelector(".wf-main .compare-member")?.getAttribute("aria-label"), "Claude Code");
      assertNoDomNode(fixture.container.querySelector(".compare"), "no comparison columns");
    } finally {
      await unmount(fixture);
    }
  });

  test("⋯ opens each agent step's session, and offers no Follow Up", async () => {
    const fixture = await mount({ workflowInstance: async () => gated() } as unknown as Partial<ApiClient>);
    try {
      await click(fixture.container.querySelector('.detail-bar [aria-haspopup="menu"]'));
      const items = [...doc().querySelectorAll('[role="menuitem"]')].map((item) => item.querySelector(".menu-item-label")?.textContent ?? item.textContent);
      assert.ok(items.some((item) => item?.startsWith("Open Builder Session")));
      assert.ok(items.some((item) => item?.startsWith("Open Reviewer Session")));
      assert.ok(!items.some((item) => item?.includes("Follow Up")));
      await click([...doc().querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.startsWith("Open Reviewer Session")));
      assert.deepEqual(fixture.opened.at(-1), { name: "session", id: codex.id });
    } finally {
      await unmount(fixture);
    }
  });

  test("at 390px the page shows Steps and one <Role> Activity tab per agent step", async () => {
    await setViewport(390, 844);
    const fixture = await mount({ workflowInstance: async () => gated() } as unknown as Partial<ApiClient>);
    try {
      const { container } = fixture;
      const tabs = [...container.querySelectorAll('[role="tab"]')];
      assert.deepEqual(tabs.map((tab) => tab.textContent), ["Steps", "Builder Activity", "Reviewer Activity"]);
      assert.equal(tabs[0]!.getAttribute("aria-selected"), "true");
      assert.ok(panel(container), "Steps holds the panel");
      await click(tabs[2]);
      assertNoDomNode(panel(container));
      assert.equal(container.querySelector('[role="tabpanel"] .compare-member-agent')?.textContent, "Codex App Server");
    } finally {
      await unmount(fixture);
      await setViewport(1440, 900);
    }
  });
});
