import React from "react";
import { createRoot } from "react-dom/client";
import type {
  ControlPlaneToUi,
  RunView,
  SessionView,
  WorkflowDefinition,
  WorkflowInstanceView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { RunsView } from "../components/RunsView.js";
import "../styles.css";

/**
 * The Multi-Agent Runs list (#2974) in a real browser, for its phone geometry spec and screenshots.
 * `?state=loaded|loading|reconnecting|empty` picks what the socket does: Loaded and Reconnecting
 * share one snapshot of a workflow awaiting a decision, a running comparison, a comparison whose
 * member waits for approval and an idle one; Reconnecting then drops the socket. `?theme=light|dark`.
 */
const params = new URLSearchParams(window.location.search);
const state = params.get("state") ?? "loaded";
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

const NOW = Date.now();
const MINUTE = 60_000;

function member(id: string, agentId: string, agentName: string, driver: SessionView["driver"], status: SessionView["status"], runId: string): SessionView {
  return {
    id, runnerId: "runner-1", workspaceId: "ws-wollipog", workspaceName: "Wollipog", projectId: null, agentId, agentName,
    title: agentName, status, column: "review", runId, useWorktree: true, worktreePath: null, archived: false,
    createdAt: NOW - 10 * MINUTE, updatedAt: NOW, lastEventAt: null, messageCount: 0, eventEpoch: 0, preview: null,
    pendingApproval: null, driver, model: null, effort: null, permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0,
    adopted: false,
  } as SessionView;
}

const runs: RunView[] = [
  {
    id: "run-review", title: "Build and review the settings export screen", prompt: "Build the export screen.",
    workspaceId: "ws-wollipog", workspaceName: "Wollipog", createdAt: NOW - 2 * MINUTE, updatedAt: NOW,
    sessionIds: ["s-builder", "s-reviewer"],
  },
  {
    id: "run-search", title: "Compare three approaches to indexing session search across machines and projects",
    prompt: "Index session search.", workspaceId: "ws-wollipog", workspaceName: "Wollipog", createdAt: NOW - 6 * MINUTE,
    updatedAt: NOW, sessionIds: ["s-search-claude", "s-search-codex", "s-search-opencode"],
  },
  {
    id: "run-pairing", title: "Rename the pairing flow's buttons", prompt: "Rename the buttons.",
    workspaceId: "ws-site", workspaceName: "Marketing Site", createdAt: NOW - 125 * MINUTE, updatedAt: NOW,
    sessionIds: ["s-pair-claude", "s-pair-codex", "s-pair-opencode", "s-pair-gemini"],
  },
  {
    id: "run-dates", title: "Pick a date library for the scheduler", prompt: "Pick a library.",
    workspaceId: null, workspaceName: null, createdAt: NOW - 26 * 60 * MINUTE, updatedAt: NOW,
    sessionIds: ["s-dates-claude", "s-dates-codex"],
  },
];

const sessions: SessionView[] = [
  member("s-builder", "claude", "Claude Code", "claude-code", "idle", "run-review"),
  member("s-reviewer", "codex", "Codex", "codex-app-server", "idle", "run-review"),
  member("s-search-claude", "claude", "Claude Code", "claude-code", "running", "run-search"),
  member("s-search-codex", "codex", "Codex", "codex-app-server", "idle", "run-search"),
  member("s-search-opencode", "opencode", "OpenCode", "acp", "idle", "run-search"),
  member("s-pair-claude", "claude", "Claude Code", "claude-code", "input_required", "run-pairing"),
  member("s-pair-codex", "codex", "Codex", "codex-app-server", "idle", "run-pairing"),
  member("s-pair-opencode", "opencode", "OpenCode", "acp", "idle", "run-pairing"),
  member("s-pair-gemini", "gemini", "Gemini CLI", "acp", "idle", "run-pairing"),
  member("s-dates-claude", "claude", "Claude Code", "claude-code", "idle", "run-dates"),
  member("s-dates-codex", "codex", "Codex", "codex-app-server", "completed", "run-dates"),
];

const instances = [{
  instanceId: "instance-review", workflowId: "builtin:build-review", workflowVersion: 1, runId: "run-review",
  status: "waiting_gate", transitionCount: 2, createdBy: { kind: "human", id: "local" }, createdAt: NOW - 2 * MINUTE,
  updatedAt: NOW, nodeStates: [
    { nodeId: "build", status: "succeeded", attemptCount: 1, sessionId: "s-builder" },
    { nodeId: "review", status: "succeeded", attemptCount: 1, sessionId: "s-reviewer" },
    { nodeId: "approve", status: "waiting_gate", attemptCount: 0 },
  ],
}] as WorkflowInstanceView[];

const definitions = [{ workflowId: "builtin:build-review", name: "Build and Review" }] as WorkflowDefinition[];

const snapshot = {
  type: "snapshot",
  capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
  runners: [], boxes: [], projects: [],
  sessions: state === "empty" ? [] : sessions,
  runs: state === "empty" ? [] : runs,
  pods: [],
} as ControlPlaneToUi;

class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(live: boolean) {
    if (!live || state === "loading") return;
    setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify(snapshot) });
      if (state === "reconnecting") setTimeout(() => this.onclose?.({ code: 1006 }), 50);
    }, 0);
  }
  send() {}
  close() {}
}

let sockets = 0;
const connection: UiConnectionRuntime = {
  instanceId: "runs-list-e2e",
  runtimeKey: "runs-list-e2e:1",
  // Reconnect attempts get a socket that never opens, so Reconnecting holds.
  createSocket: () => new FixtureSocket(sockets++ === 0),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "runs" }),
  push: (view) => { document.body.dataset.opened = JSON.stringify(view); },
  listen: () => () => {},
};

const client = {
  ...api,
  workflowInstances: async () => instances,
  workflowDefinitions: async () => definitions,
} as unknown as ApiClient;

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <StoreProvider connection={connection} navigation={navigation}>
      <div className="app">
        <main className="main">
          <div className="main-body">
            <RunsView onNewRun={() => { document.body.dataset.newRun = "1"; }} />
          </div>
        </main>
      </div>
    </StoreProvider>
  </ApiProvider>,
);
