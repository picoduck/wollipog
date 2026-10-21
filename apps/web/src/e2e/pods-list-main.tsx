import React from "react";
import { createRoot } from "react-dom/client";
import type {
  ControlPlaneToUi,
  PodArbitrationMode,
  PodOrchestrationStatus,
  PodReconciliation,
  PodView,
  SessionView,
} from "@wollipog/protocol";
import { api } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { PodsView } from "../components/PodsView.js";
import "../styles.css";

/**
 * The Pods list (#2979) in a real browser, for its phone geometry spec and screenshots.
 * `?state=loaded|loading|reconnecting|empty` picks what the socket does: Loaded and Reconnecting
 * share one snapshot of a pod whose automatic turns run, a pod whose newest merge conflicted, two
 * idle pods (one without an objective) and a closed pod; Reconnecting then drops the socket.
 * `?theme=light|dark`.
 */
const params = new URLSearchParams(window.location.search);
const state = params.get("state") ?? "loaded";
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

const NOW = Date.now();
const MINUTE = 60_000;

function member(id: string, agentId: string, agentName: string, driver: SessionView["driver"], status: SessionView["status"]): SessionView {
  return {
    id, runnerId: "runner-1", workspaceId: "ws-wollipog", workspaceName: "Wollipog", projectId: null, agentId, agentName,
    title: agentName, status, column: "review", runId: null, useWorktree: true, worktreePath: null, archived: false,
    createdAt: NOW - 10 * MINUTE, updatedAt: NOW, lastEventAt: null, messageCount: 0, eventEpoch: 0, preview: null,
    pendingApproval: null, driver, model: null, effort: null, permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0,
    adopted: false,
  } as SessionView;
}

function orchestration(mode: PodArbitrationMode, status: PodOrchestrationStatus, turnsUsed = 0): PodView["orchestration"] {
  return {
    policy: { mode, contextTokenBudget: 8_192, summaryTokenBudget: 1_024, maxTurns: 12, maxRepeatedOutputs: 2 },
    state: { status, turnsUsed, updatedAt: NOW },
  };
}

const members = (...ids: string[]) => ids.map((sessionId, index) => ({
  sessionId, joinedAt: NOW - 60 * MINUTE, role: index === 0 ? "lead" as const : "worker" as const, contextTokenBudget: null, lastContextSeq: 0,
}));

const conflicted: PodReconciliation = {
  reconciliationId: "merge-dates", podId: "pod-dates", sourceSessionId: "s-dates-codex", targetSessionId: "s-dates-claude",
  actorId: "local", status: "conflicted", conflictPaths: ["src/scheduler.ts"], createdAt: NOW - 20 * MINUTE,
};

const pods: PodView[] = [
  {
    id: "pod-retry", title: "Migrate the retry helper across the runner, the control plane and the dashboard",
    objective: "Move every call site to the shared retry helper and delete the old one", status: "active",
    members: members("s-retry-claude", "s-retry-codex", "s-retry-opencode"),
    orchestration: orchestration("round_robin", "running", 3), createdAt: NOW - 90 * MINUTE, updatedAt: NOW - 2 * MINUTE,
  },
  {
    id: "pod-dates", title: "Pick a date library for the scheduler", objective: "Agree on one date library and port the scheduler to it",
    status: "active", members: members("s-dates-claude", "s-dates-codex"), orchestration: orchestration("lead_driven", "stopped", 5),
    reconciliations: [conflicted], createdAt: NOW - 3 * 60 * MINUTE, updatedAt: NOW - 20 * MINUTE,
  },
  {
    id: "pod-export", title: "Review the settings export screen", objective: "Review the export screen for copy and keyboard access",
    status: "active", members: members("s-export-claude", "s-export-codex"), orchestration: orchestration("event_triggered", "idle"),
    createdAt: NOW - 5 * 60 * MINUTE, updatedAt: NOW - 2 * 60 * MINUTE,
  },
  {
    id: "pod-pairing", title: "Pairing copy pass", objective: "", status: "active",
    members: members("s-pair-claude", "s-pair-codex", "s-pair-gemini", "s-pair-opencode"), orchestration: orchestration("manual", "idle"),
    createdAt: NOW - 26 * 60 * MINUTE, updatedAt: NOW - 25 * 60 * MINUTE,
  },
  {
    id: "pod-parser", title: "Ship the parser", objective: "Land the new parser behind its flag", status: "closed",
    members: members("s-parser-claude", "s-parser-codex"), orchestration: orchestration("round_robin", "stopped", 12),
    createdAt: NOW - 3 * 24 * 60 * MINUTE, updatedAt: NOW - 10 * MINUTE,
  },
];

const sessions: SessionView[] = [
  member("s-retry-claude", "claude", "Claude Code", "claude-code", "running"),
  member("s-retry-codex", "codex", "Codex", "codex-app-server", "idle"),
  member("s-retry-opencode", "opencode", "OpenCode", "acp", "idle"),
  member("s-dates-claude", "claude", "Claude Code", "claude-code", "idle"),
  member("s-dates-codex", "codex", "Codex", "codex-app-server", "idle"),
  member("s-export-claude", "claude", "Claude Code", "claude-code", "idle"),
  member("s-export-codex", "codex", "Codex", "codex-app-server", "idle"),
  member("s-pair-claude", "claude", "Claude Code", "claude-code", "idle"),
  member("s-pair-codex", "codex", "Codex", "codex-app-server", "idle"),
  member("s-pair-gemini", "gemini", "Gemini CLI", "acp", "idle"),
  member("s-pair-opencode", "opencode", "OpenCode", "acp", "idle"),
  member("s-parser-claude", "claude", "Claude Code", "claude-code", "completed"),
  member("s-parser-codex", "codex", "Codex", "codex-app-server", "completed"),
];

const snapshot = {
  type: "snapshot",
  capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
  runners: [], boxes: [], projects: [], runs: [],
  sessions: state === "empty" ? [] : sessions,
  pods: state === "empty" ? [] : pods,
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
  instanceId: "pods-list-e2e",
  runtimeKey: "pods-list-e2e:1",
  // Reconnect attempts get a socket that never opens, so Reconnecting holds.
  createSocket: () => new FixtureSocket(sockets++ === 0),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "pods" }),
  push: (view) => { document.body.dataset.opened = JSON.stringify(view); },
  listen: () => () => {},
};

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={api}>
    <StoreProvider connection={connection} navigation={navigation}>
      <div className="app">
        <main className="main">
          <div className="main-body">
            <PodsView onNewPod={() => { document.body.dataset.newPod = "1"; }} />
          </div>
        </main>
      </div>
    </StoreProvider>
  </ApiProvider>,
);
