import React from "react";
import { createRoot } from "react-dom/client";
import type { ControlPlaneToUi, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { ArchivedSessionsView } from "../components/ArchivedSessionsView.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import "../styles.css";

/**
 * Real-browser Archived Sessions harness (#2777): archived sessions, two of them pruned by
 * archived-history retention, so the archive shows its History Pruned badge beside the lifecycle.
 * `?theme=light|dark` picks the theme.
 */
const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 16, 12);

function session(index: number, title: string, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: `archived-${index}`, runnerId: "runner-1", workspaceId: "workspace-1", workspaceName: "wollipog",
    projectId: "project-1", projectName: "Wollipog", projectLocationId: null, agentId: "claude", agentName: "Claude Code",
    title, status: "completed", column: "done", runId: null, useWorktree: false, worktreePath: null,
    archived: true, archivedAt: NOW - (200 - index * 30) * DAY, createdAt: NOW - (210 - index * 30) * DAY,
    updatedAt: NOW - (200 - index * 30) * DAY, lastEventAt: NOW - (200 - index * 30) * DAY, messageCount: 40, eventEpoch: 1,
    preview: null, pendingApproval: null, driver: "claude-code", model: "claude-opus-5-5", effort: null, permissionMode: null,
    tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false, ...overrides,
  } as SessionView;
}

const sessions = [
  session(1, "Migrate the Usage Dashboard to Daily Buckets",
    { historyPruned: { prunedAt: NOW - 20 * DAY, eventCount: 18_402, retentionDays: 90 } }),
  session(2, "Fix Flaky Checkpoint Restore Test",
    { status: "failed", historyPruned: { prunedAt: NOW - 2 * DAY, eventCount: 6_215, retentionDays: 90 } }),
  session(3, "Add Keyboard Shortcuts to the Board"),
  session(4, "Draft the Release Notes for v0.33", { status: "stopped" }),
];

class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    const snapshot: ControlPlaneToUi = {
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
      runners: [], boxes: [], projects: [], sessions: [], runs: [], pods: [],
    };
    setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify(snapshot) });
    }, 0);
  }
  send() {}
  close() {}
}

const connection: UiConnectionRuntime = {
  instanceId: "archived-sessions-e2e",
  runtimeKey: "archived-sessions-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "archived" }),
  push() {},
  listen: () => () => {},
};

const client = {
  ...api,
  listAllSessions: async () => ({ sessions }),
  search: async () => ({ results: [] }),
  archiveSessionPage: async () => ({
    sessions,
    snippets: {},
    metadata: Object.fromEntries(sessions.map((item) => [item.id, { project: "Wollipog", location: "wollipog", agent: "Claude Code" }])),
    nextCursor: null,
    hasMore: false,
    facets: { projects: ["Wollipog"], locations: ["wollipog"], agents: ["Claude Code"] },
  }),
} as unknown as ApiClient;

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <FeedbackProvider>
      <StoreProvider connection={connection} navigation={navigation}>
        <div className="app">
          <main className="main">
            <div className="main-body">
              <ArchivedSessionsView />
            </div>
          </main>
        </div>
      </StoreProvider>
    </FeedbackProvider>
  </ApiProvider>,
);
