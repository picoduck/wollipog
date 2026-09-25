import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  ControlPlaneToUi,
  DescendantRequestsView,
  OrchestratorCampaignProjection,
  RunnerView,
  SessionView,
} from "@wollipog/protocol";
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
  runnerId: "runner-campaign", hostname: "runner-host", os: "linux", version: "1", status: "online",
  agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude", available: true }],
  workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 170,
} as unknown as RunnerView;

function session(id: string, title: string, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id, runnerId: runner.runnerId, workspaceId: null, workspaceName: null, projectId: null,
    agentId: "claude", agentName: "Claude", title, status: "idle", column: "review",
    runId: null, useWorktree: false, worktreePath: null, archived: false, createdAt: 1, updatedAt: 1,
    lastEventAt: null, messageCount: 0, eventEpoch: 0, preview: null, pendingApproval: null,
    driver: "claude", model: null, effort: null, permissionMode: null,
    tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
    ...overrides,
  } as SessionView;
}

function campaign(heldChildren: OrchestratorCampaignProjection["heldChildren"], blocked: number): OrchestratorCampaignProjection {
  return {
    status: heldChildren?.length ? "blocked" : "active",
    policyRevision: 1,
    decisionOwners: {
      implementation_question: "orchestrator", pr_merge: "orchestrator", merged_branch_deletion: "orchestrator",
      follow_up_issue_publication: "orchestrator", ui_evidence_approval: "human",
    },
    limits: { maximumConcurrentChildren: 4, occupied: 2, remaining: 2, costBudgetUsd: null, maxToolCalls: null },
    uiEvidenceReview: { status: "available", effectiveOwner: "human" },
    children: { total: 3, active: 3 - blocked, waitingHuman: 0, blocked, verified: 0, cleanupPending: 0 },
    ...(heldChildren ? { heldChildren } : {}),
    pendingDecisions: { human: 0, orchestrator: 0 },
    followUps: { unique: 0, duplicates: 0 },
  } as OrchestratorCampaignProjection;
}

const hold = (holdId: string) => ({
  kind: "worktree_recovery" as const,
  holdId,
  since: Date.now() - 60_000,
  reason: `Worktree for ${holdId} is on the wrong branch.`,
  recoveryAction: "Restore the branch (for example `git -C /w switch feat/x`) and select that worktree again.",
});

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

test("a campaign parent's session detail lists held children from its projection and drops them when the hold clears", async () => {
  // The first child's title contains the separator a joined-string selector would split on.
  const storedChild = session("child-stored", "Stored\u0000Title");
  const parent = session("campaign-parent", "Issue Campaign", {
    status: "running",
    orchestratorCampaign: campaign([
      { sessionId: storedChild.id, holds: [hold("hold-stored")] },
      // Not in the session store: its title comes from the descendant poll's held descendants.
      { sessionId: "child-polled", holds: [hold("hold-polled")] },
    ], 3),
  });
  const socket = new FakeSocket();
  const descendantResponse: DescendantRequestsView = {
    requests: [],
    blockedChildren: [{
      sessionId: "child-polled", sessionTitle: "Polled Title", runnerId: runner.runnerId, runnerOnline: true,
      eventEpoch: 0, status: "input_required", holds: [hold("hold-polled")],
    }],
  };
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: () => new Promise<never>(() => {}),
    getSessionEventTailPage: () => new Promise<never>(() => {}),
    runnerSkills: async () => ({ desired: [], reported: null }),
    descendantRequests: async () => descendantResponse,
  } as unknown as ApiClient;
  const connection: UiConnectionRuntime = {
    instanceId: "held-test", runtimeKey: "held-test:1", createSocket: () => socket, close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: parent.id }), push() {}, listen: () => () => {},
  };
  const rightPanel = {
    open: false, mode: "launcher" as const, width: 360, dragging: false, subagentTarget: null,
    toggle() {}, openMode() {}, show() {}, setMode() {}, setWidth() {}, setDragging() {},
    close() {}, selectSubagent() {}, showSubagent() {}, consumeSubagentFocusRequest() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={{ confirm: async () => true, showToast: () => 0, dismissToast: () => {} } as never}>
          <StoreProvider connection={connection} navigation={navigation}>
            <SessionDetail sessionId={parent.id} mode="expanded" rightPanel={rightPanel}
              onOpenTerminal={() => {}} pinnedOpen={false} composerDraftLoader={async () => null} />
          </StoreProvider>
        </FeedbackContext.Provider>
      </ApiProvider>,
    ));
    await act(async () => socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
      runners: [runner], boxes: [], projects: [], sessions: [parent, storedChild], runs: [], pods: [],
    }));
    await settle();
    await settle();

    const section = () => container.querySelector<HTMLElement>("section.campaign-held-children");
    assert.ok(section(), "the held-children list renders in the campaign parent's detail");
    const links = () => [...section()!.querySelectorAll("a.campaign-held-child-link")].map((link) => link.textContent);
    assert.deepEqual(links(), ["Stored\u0000Title", "Polled Title"],
      "store titles map to their own child, and a child missing from the store takes the polled title");
    assert.match(section()!.textContent ?? "", /1 other blocked child is not listed here/);
    assert.equal(section()!.querySelectorAll("button").length, 0);

    // One hold clears: the projection drops that child and lowers Blocked in the same update.
    await act(async () => socket.push({
      type: "session_upsert",
      session: { ...parent, orchestratorCampaign: campaign([{ sessionId: "child-polled", holds: [hold("hold-polled")] }], 2) },
    }));
    await settle();
    assert.deepEqual(links(), ["Polled Title"]);

    await act(async () => socket.push({
      type: "session_upsert",
      session: { ...parent, orchestratorCampaign: campaign(undefined, 0) },
    }));
    await settle();
    assert.equal(section(), null, "no held children renders nothing, as an older control plane would");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
