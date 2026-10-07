import React from "react";
import { createRoot } from "react-dom/client";
import type {
  ControlPlaneToUi,
  ProjectLocationView,
  ProjectView,
  RunnerView,
  SessionView,
  UiSnapshotMessage,
} from "@wollipog/protocol";
import { Shell } from "../App.js";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { ThemeProvider } from "../components/ThemeProvider.js";
import { InstanceScopeProvider } from "../instance-scope.js";
import { viewFromPath, viewPath, type ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

/**
 * The Sessions page in the real Shell for each empty, loading and offline situation (#2220). The
 * view path rides in `?path=` (as in sessions-board-main.tsx) and `?state=` picks the fixture:
 *
 * - `first-run`: no sessions and no Projects.
 * - `project-empty`, `no-location`, `location-offline`: the Docs Site Project with an available
 *   Location, none, or one on the offline machine Studio; open it with `path=/?tab=project:project-docs`.
 * - `no-project`: sessions only in Docs Site; open `path=/?tab=%20no-project`.
 * - `sessions` (the default): five sessions in Docs Site, for Snoozed, No Matches and Reconnecting.
 * - `syncing`: Docs Site counts 8 sessions and none has arrived; `__deliverSessions()` sends them.
 *
 * `__dropConnection()` loses the connection and holds every retry silent; once the store has
 * opened a retry socket (`__retryPending()`), `__restoreConnection()` answers that one with a fresh
 * snapshot, as a control plane coming back would.
 */
const SCOPE = "sessions-states-e2e";
const STATE = new URLSearchParams(location.search).get("state") ?? "sessions";
const NOW = Date.now();

const studio: RunnerView = {
  runnerId: "runner-studio",
  hostname: "studio.local",
  displayName: "Studio",
  os: "linux",
  version: "1",
  status: STATE === "location-offline" ? "offline" : "online",
  agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true }],
  workspaces: [{ id: "workspace-docs", name: "docs", path: "/srv/docs" }],
  connectedAt: 1,
  lastSeen: 1,
};

function docsLocation(availability: ProjectLocationView["availability"]): ProjectLocationView {
  return {
    id: "location-docs", projectId: "project-docs", runnerId: studio.runnerId, workspaceId: "workspace-docs",
    name: "docs", path: "/srv/docs", source: "managed", availability, isDefault: true, createdAt: 1, updatedAt: 1,
  };
}

const SESSION_TITLES = [
  "Fix the broken link checker",
  "Draft the release notes",
  "Update the install guide",
  "Review the API reference",
  "Rename the search index",
  "Prune stale screenshots",
  "Check the sitemap",
  "Translate the quick start",
];

function session(index: number): SessionView {
  return {
    id: `session-${index + 1}`,
    runnerId: studio.runnerId,
    workspaceId: "workspace-docs",
    workspaceName: "docs",
    projectId: "project-docs",
    agentId: "codex",
    agentName: "Codex",
    title: SESSION_TITLES[index]!,
    status: index === 0 ? "running" : "idle",
    column: index === 0 ? "running" : "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: 1,
    updatedAt: NOW - index * 600_000,
    lastEventAt: NOW - index * 600_000,
    messageCount: 4,
    preview: "Updated the pages and ran the checks.",
    pendingApproval: null,
    driver: "codex-app-server",
    model: null,
    effort: null,
    permissionMode: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
  };
}

const projectCount = STATE === "syncing" ? 8 : STATE === "sessions" ? 5 : STATE === "no-project" ? 2 : 0;
const projects: ProjectView[] = STATE === "first-run" ? [] : [{
  id: "project-docs",
  name: "Docs Site",
  hidden: false,
  locations: STATE === "no-location" ? [] : [docsLocation(STATE === "location-offline" ? "runner_offline" : "available")],
  activeSessionCount: projectCount,
  unarchivedSessionCount: projectCount,
  totalSessionCount: projectCount,
  createdAt: 1,
  updatedAt: 1,
}];
let sessions: SessionView[] = STATE === "sessions" ? Array.from({ length: 5 }, (_, index) => session(index))
  : STATE === "no-project" ? [session(0), session(1)]
  : [];

function snapshot(): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: true,
      sessionReminders: true,
      indefiniteSessionReminders: true,
    },
    runners: [structuredClone(studio)],
    boxes: [],
    projects: structuredClone(projects),
    sessions: structuredClone(sessions),
    reminders: [],
    runs: [],
    pods: [],
  };
}

class FixtureSocket implements UiSocket {
  readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: ControlPlaneToUi) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

let socket: FixtureSocket | null = null;
let dropped = false;
/** The store's latest retry while the connection is dropped: the socket a restore answers. */
let retry: FixtureSocket | null = null;
const connection: UiConnectionRuntime = {
  instanceId: SCOPE,
  runtimeKey: `${SCOPE}:1`,
  createSocket: () => {
    const opened = new FixtureSocket();
    socket = opened;
    // A dropped connection's retries stay connecting, which the store reads as offline (§12.5).
    if (dropped) retry = opened;
    else window.setTimeout(() => opened.push(snapshot()), 0);
    return opened;
  },
  close() {},
};

declare global {
  interface Window {
    __dropConnection: () => void;
    __retryPending: () => boolean;
    __restoreConnection: () => void;
    __deliverSessions: () => void;
  }
}
window.__dropConnection = () => {
  dropped = true;
  retry = null;
  socket?.onclose?.({ code: 1006 });
};
window.__retryPending = () => retry !== null;
window.__restoreConnection = () => {
  if (!retry) throw new Error("the store has not retried yet");
  dropped = false;
  retry.push(snapshot());
  retry = null;
};
window.__deliverSessions = () => {
  sessions = Array.from({ length: 8 }, (_, index) => session(index));
  for (const value of sessions) socket?.push({ type: "session_upsert", session: structuredClone(value) });
};

const client = {
  ...api,
  listSkills: async () => ({ skills: [] }),
  session: async (id: string) => {
    const value = sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error("session not found");
    return { session: structuredClone(value) };
  },
  getSessionEventPage: async () => ({ events: [], hasOlder: false }) as never,
  getSessionEventTailPage: async () => ({ events: [], hasOlder: false }) as never,
  git: async () => ({}),
  gitSummary: async () => ({}),
  reviewFindings: async () => ({ findings: [], summary: {
    total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete",
  } }) as never,
} as unknown as ApiClient;

const navigation: ViewNavigation = {
  current: () => {
    const path = new URLSearchParams(window.location.search).get("path") ?? "/";
    const url = new URL(path, window.location.origin);
    return viewFromPath(url.pathname, url.search) ?? { name: "inbox" };
  },
  push: (view) => {
    const url = new URL(window.location.href);
    url.searchParams.set("path", viewPath(view));
    window.history.pushState(null, "", url);
  },
  listen: (onView) => {
    const onPop = () => onView(navigation.current());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  },
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <React.StrictMode>
    <InstanceScopeProvider instanceScope={SCOPE}>
      <ApiProvider client={client}>
        <FeedbackProvider>
          <StoreProvider connection={connection} navigation={navigation}>
            <ThemeProvider><Shell /></ThemeProvider>
          </StoreProvider>
        </FeedbackProvider>
      </ApiProvider>
    </InstanceScopeProvider>
  </React.StrictMode>,
);
