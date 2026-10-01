import React from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type ControlPlaneToUi,
  type ProjectView,
  type RunnerView,
  type SessionView,
  type UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { InboxView } from "../components/InboxView.js";
import type { RightPanelState } from "../components/RightPanel.js";
import { SessionDetail } from "../components/SessionDetail.js";
import { ThemeProvider } from "../components/ThemeProvider.js";
import { InstanceScopeProvider } from "../instance-scope.js";
import { viewFromPath, viewPath, type ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";
import { staticPinnedSummary } from "../components/pinned-summary-state.js";

/**
 * #1977: the project setup suggestion and the skills-unavailable notice.
 *
 * `?surface=sessions` (the default) is the Sessions list; its tab rides in `?path=` as in the other
 * Sessions harnesses. Payments Service is eligible for the setup suggestion (its first session's
 * worktree has no setup file); Docs Site is not. `?surface=session` is the first Payments Service
 * session, which runs on `?adapter=container` (default), `cloud` or `host` with two skills assigned.
 * `?pinned=1` opens the Pinned Summary; `?generate=fail|hang` makes Generate fail or never settle.
 */
const SCOPE = "project-notices-e2e";
const params = new URLSearchParams(location.search);
const surface = params.get("surface") === "session" ? "session" : "sessions";
const adapter = params.get("adapter") === "host" ? "host" as const
  : params.get("adapter") === "cloud" ? "cloud" as const : "container" as const;
const pinned = params.get("pinned") === "1";
const generate = params.get("generate");

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "build-box",
  displayName: "Build Box",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{ id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", available: true }],
  workspaces: [
    { id: "payments-workspace", name: "Payments Service", path: "/repos/payments" },
    { id: "docs-workspace", name: "Docs Site", path: "/repos/docs" },
  ],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: PROTOCOL_VERSION,
};

function project(id: string, name: string, workspaceId: string, sessionCount: number): ProjectView {
  return {
    id,
    name,
    hidden: false,
    audience: "organization",
    locations: [{
      id: `location-${id}`,
      projectId: id,
      runnerId: runner.runnerId,
      workspaceId,
      name,
      path: `/repos/${id}`,
      source: "managed",
      availability: "available",
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
    }],
    activeSessionCount: 0,
    unarchivedSessionCount: sessionCount,
    totalSessionCount: sessionCount,
    createdAt: 1,
    updatedAt: 1,
  } as ProjectView;
}

function session(
  id: string,
  title: string,
  projectId: string,
  createdAt: number,
  setupConfig: "absent" | "valid",
  overrides: Partial<SessionView> = {},
): SessionView {
  const worktreePath = `/worktrees/${id}`;
  return {
    id,
    runnerId: runner.runnerId,
    workspaceId: `${projectId}-workspace`,
    workspaceName: projectId === "payments" ? "Payments Service" : "Docs Site",
    projectId,
    projectLocationId: `location-${projectId}`,
    audience: "organization",
    agentId: "claude",
    agentName: "Claude Code",
    title,
    status: "idle",
    column: "review",
    runId: null,
    useWorktree: true,
    worktreePath,
    worktrees: [{
      id: `worktree-${id}`,
      path: worktreePath,
      branch: `agent/${id}`,
      source: "created",
      setupConfig: setupConfig === "absent" ? { status: "absent" } : { status: "valid", hash: "a".repeat(64) },
    }],
    archived: false,
    createdAt,
    updatedAt: 100 - createdAt,
    lastEventAt: 100 - createdAt,
    eventEpoch: 0,
    messageCount: 1,
    preview: `${title} preview`,
    pendingApproval: null,
    driver: "claude-code",
    model: null,
    effort: null,
    permissionMode: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
    ...overrides,
  } as SessionView;
}

const FIRST_SESSION_ID = "payments-1";
const sessions = [
  session(FIRST_SESSION_ID, "Add Refund Webhooks", "payments", 1, "absent", {
    executionTarget: {
      id: adapter,
      runnerId: runner.runnerId,
      kind: adapter === "host" ? "local" : adapter,
      workspaceStrategy: "worktree",
      adapter,
      boundaries: adapter === "host"
        ? { filesystem: "worktree", network: "inherit", secrets: "runner_local", billing: "agent_account" }
        : { filesystem: adapter, network: "deny", secrets: "none", billing: "none" },
    },
  } as Partial<SessionView>),
  session("payments-2", "Retry Failed Payouts", "payments", 2, "absent"),
  session("payments-3", "Audit Currency Rounding", "payments", 3, "absent"),
  session("docs-1", "Rewrite the Quick Start", "docs", 4, "valid"),
  session("docs-2", "Fix Broken Anchors", "docs", 5, "valid"),
];
const projects = [project("payments", "Payments Service", "payments-workspace", 3), project("docs", "Docs Site", "docs-workspace", 2)];

function snapshot(): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: true,
      worktreeSetupConfig: true,
    },
    runners: [structuredClone(runner)],
    boxes: [],
    projects: structuredClone(projects),
    sessions: structuredClone(sessions),
    runs: [],
    pods: [],
    worktreeSetupNoticeDismissals: [],
  } as UiSnapshotMessage;
}

class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
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
const connection: UiConnectionRuntime = {
  instanceId: SCOPE,
  runtimeKey: `${SCOPE}:1`,
  createSocket: () => {
    socket = new FixtureSocket();
    window.setTimeout(() => {
      socket?.onopen?.();
      socket?.push(snapshot());
    }, 0);
    return socket;
  },
  close() {},
};

declare global {
  interface Window {
    __setupCalls: string[];
  }
}
window.__setupCalls = [];

const client = {
  ...api,
  session: async (id: string) => ({ session: structuredClone(sessions.find((candidate) => candidate.id === id)!) }),
  getSessionEventPage: () => new Promise<never>(() => {}),
  getSessionEventTailPage: (_id: string, _before: number | undefined, eventEpoch: number) =>
    Promise.resolve({ events: [], eventEpoch, nextBefore: 0, hasMoreOlder: false, cacheComplete: true }),
  git: async () => ({}),
  gitSummary: async () => ({}),
  reviewFindings: async () => ({ findings: [], summary: {
    total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete",
  } }),
  runnerSkills: async () => ({
    desired: [
      { name: "review-pr", versionDigest: "a".repeat(64), targets: [{ agentId: "claude", invocation: "agent" }] },
      { name: "release-notes", versionDigest: "b".repeat(64), targets: [{ agentId: "claude", invocation: "manual" }] },
    ],
    reported: null,
  }),
  generateWorktreeSetup: (sessionId: string) => {
    window.__setupCalls.push(`generate:${sessionId}`);
    if (generate === "hang") return new Promise<never>(() => {});
    if (generate === "fail") return Promise.reject(new Error("runner rpc timeout: git ls-files exited 128"));
    return Promise.resolve({ path: ".wollipog.json", detected: [] });
  },
  dismissWorktreeSetupNotice: async (projectId: string) => {
    window.__setupCalls.push(`dismiss:${projectId}`);
    window.setTimeout(() => socket?.push({ type: "worktree_setup_notice_dismissed", projectId } as ControlPlaneToUi), 0);
    return { dismissed: true as const };
  },
} as unknown as ApiClient;

/** The harness page's own URL scheme: the SPA path rides in `?path=`. */
const navigation: ViewNavigation = {
  current: () => {
    if (surface === "session") return { name: "session", id: FIRST_SESSION_ID };
    const path = new URLSearchParams(window.location.search).get("path") ?? "/";
    const url = new URL(path, window.location.origin);
    return viewFromPath(url.pathname, url.search) ?? { name: "inbox" };
  },
  push: (view) => {
    if (surface === "session") return;
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

const rightPanel = {
  open: false,
  mode: "launcher",
  width: 380,
  dragging: false,
  subagentTarget: null,
  toggle() {},
  openMode() {},
  show() {},
  setMode() {},
  setWidth() {},
  setDragging() {},
  close() {},
  selectSubagent() {},
  showSubagent() {},
  consumeSubagentFocusRequest() {},
} satisfies RightPanelState;

function SessionsSurface() {
  const view = useStoreSelector((state) => state.view);
  const { navigate } = useStoreActions();
  return (
    <div className="app">
      <main className="main">
        <div className="main-body inbox-main-body">
          <InboxView
            viewMode="list"
            expandedSessionId={view.name === "session" ? view.id : null}
            rightPanel={rightPanel}
            onOpenTerminal={() => {}}
            onCollapse={() => navigate({ name: "inbox" })}
            onNewSession={() => {}}
          />
        </div>
      </main>
    </div>
  );
}

function SessionSurface() {
  return (
    <div className="app">
      <main className="main">
        <div className="main-body">
          <SessionDetail
            sessionId={FIRST_SESSION_ID}
            mode="expanded"
            rightPanel={rightPanel}
            onOpenTerminal={() => {}}
            pinnedSummary={staticPinnedSummary(pinned)}
            composerDraftLoader={async () => null}
          />
        </div>
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <InstanceScopeProvider instanceScope={SCOPE}>
    <ApiProvider client={client}>
      <FeedbackProvider>
        <StoreProvider connection={connection} navigation={navigation}>
          <ThemeProvider>{surface === "session" ? <SessionSurface /> : <SessionsSurface />}</ThemeProvider>
        </StoreProvider>
      </FeedbackProvider>
    </ApiProvider>
  </InstanceScopeProvider>,
);
