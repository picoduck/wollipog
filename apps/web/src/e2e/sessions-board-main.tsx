import React from "react";
import { createRoot } from "react-dom/client";
import {
  type BoardColumn,
  type ControlPlaneToUi,
  type RunnerView,
  type SessionReminderView,
  type SessionView,
  type UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { InboxView } from "../components/InboxView.js";
import { Rail } from "../components/Rail.js";
import type { RightPanelState } from "../components/RightPanel.js";
import { InstanceScopeProvider } from "../instance-scope.js";
import { viewFromPath, viewPath, type View, type ViewNavigation } from "../navigation.js";
import { sessionsDestination } from "../sessions-view-mode.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { useSessionsViewModeMemory } from "../use-sessions-view-mode-memory.js";
import { useSessionsViewToggleKey } from "../useSessionsViewToggleKey.js";
import "../styles.css";

/**
 * The Sessions list/board surface with the app's own mode glue (#527): the REAL toggle-key hook,
 * the REAL mode-memory hook, and a URL-reflecting navigation, so the spec exercises the same code
 * paths the shell runs. The view path rides in `?path=` because the harness page is not the SPA:
 * pushing a bare `/board` would make a reload fetch the production app instead of this fixture.
 */
const SCOPE = "sessions-board-e2e";

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "board-host",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true }],
  workspaces: [{ id: "workspace-1", name: "Wollipog", path: "/repo" }],
  connectedAt: 1,
  lastSeen: 1,
};

function session(id: string, title: string, column: BoardColumn, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id,
    runnerId: runner.runnerId,
    workspaceId: "workspace-1",
    workspaceName: "Wollipog",
    agentId: "codex",
    agentName: "Codex",
    title,
    status: "idle",
    column,
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: 1,
    updatedAt: 10,
    lastEventAt: 10,
    messageCount: 1,
    preview: `Preview for ${title}`,
    pendingApproval: null,
    driver: "codex-app-server",
    model: null,
    effort: null,
    permissionMode: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
    ...overrides,
  };
}

const sessions = [
  session("s-running", "Running Session", "running"),
  session("s-queued", "Queued Session", "queued"),
  session("s-review", "Review Session", "review"),
  session("s-archived", "Archived Session", "review", { archived: true }),
  // A pending approval renders inline card actions — the nested controls the long-press spec
  // must prove a held finger cannot trigger (#540).
  session("s-approval", "Approval Session", "input_required", {
    pendingApproval: {
      requestId: "req-approve-1",
      kind: "tool",
      title: "Run npm test",
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "deny" },
      ],
    } as never,
  }),
  session("s-snoozed", "Snoozed Session", "review"),
];

const reminders: SessionReminderView[] = [{
  reminderId: "reminder-s-snoozed",
  sessionId: "s-snoozed",
  scheduledFor: Date.now() + 86_400_000,
  timeZone: "UTC",
  originalExpression: "tomorrow",
  wakePolicy: "until_activity",
  state: "pending",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
}];

function snapshot(): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: false,
      sessionReminders: true,
    },
    runners: [structuredClone(runner)],
    boxes: [],
    sessions: structuredClone(sessions),
    reminders: structuredClone(reminders),
    runs: [],
    pods: [],
  };
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
    window.setTimeout(() => socket?.push(snapshot()), 0);
    return socket;
  },
  close() {},
};

declare global {
  interface Window {
    __setColumnCalls: Array<{ sessionId: string; column: BoardColumn }>;
    __approveCalls: string[];
  }
}
window.__setColumnCalls = [];
window.__approveCalls = [];

const client = {
  ...api,
  setColumn: async (sessionId: string, column: BoardColumn) => {
    window.__setColumnCalls.push({ sessionId, column });
    const moved = sessions.find((candidate) => candidate.id === sessionId);
    if (moved) {
      moved.column = column;
      window.setTimeout(() => socket?.push({ type: "session_upsert", session: structuredClone(moved) }), 0);
    }
  },
  approve: async (sessionId: string) => {
    window.__approveCalls.push(sessionId);
    const approved = sessions.find((candidate) => candidate.id === sessionId);
    if (!approved) throw new Error("session not found");
    approved.pendingApproval = null;
    window.setTimeout(() => socket?.push({ type: "session_upsert", session: structuredClone(approved) }), 0);
    return structuredClone(approved);
  },
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

/** The harness page's own URL scheme: the SPA path rides in `?path=` (see the module note). */
const navigation: ViewNavigation = {
  current: () => {
    const path = new URLSearchParams(window.location.search).get("path") ?? "/";
    return viewFromPath(path) ?? { name: "inbox" };
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

function HarnessShell() {
  const view = useStoreSelector((state) => state.view);
  const { navigate } = useStoreActions();
  // The same hooks the app shell mounts — the point of this harness is that these are not copies.
  useSessionsViewToggleKey(true, view, navigate);
  useSessionsViewModeMemory(view, SCOPE);
  return (
    <div className="app">
      <Rail
        view={view}
        blockedCount={0}
        stalledCount={0}
        onlineConnections={1}
        onNavigate={navigate}
      />
      <main className="main">
        <div className={`main-body${view.name !== "projects" ? " inbox-main-body" : ""}`}>
          {(view.name === "inbox" || view.name === "session" || view.name === "board") && (
            <InboxView
              viewMode={view.name === "board" ? "board" : "list"}
              expandedSessionId={view.name === "session" ? view.id : null}
              rightPanel={rightPanel}
              onOpenTerminal={() => {}}
              pinnedOpen={false}
              onCollapse={() => navigate(sessionsDestination(SCOPE))}
              onNewSession={() => {}}
            />
          )}
          {view.name === "projects" && <div className="fixture-projects">Projects Fixture</div>}
        </div>
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <React.StrictMode>
    <InstanceScopeProvider instanceScope={SCOPE}>
      <ApiProvider client={client}>
        <FeedbackProvider>
          <StoreProvider connection={connection} navigation={navigation}>
            <HarnessShell />
          </StoreProvider>
        </FeedbackProvider>
      </ApiProvider>
    </InstanceScopeProvider>
  </React.StrictMode>,
);
