import React from "react";
import { createRoot } from "react-dom/client";
import { PROTOCOL_VERSION, type HostAction, type RunnerView, type SessionView, type UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { EditorSelect } from "../components/EditorSelect.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { CommandLineIcon, InfoIcon, PanelRightIcon } from "../components/Icons.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

declare global {
  interface Window {
    hostActions: HostAction[];
  }
}

const fixtureParams = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = fixtureParams.get("theme") === "light" ? "light" : "dark";

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "fixture-runner",
  displayName: "Build Machine",
  os: "linux",
  version: "1",
  status: fixtureParams.get("offline") === "1" ? "offline" : "online",
  agents: [],
  workspaces: [],
  // `?editors=none`: a machine with no editors, whose folder has the file manager alone.
  editors: fixtureParams.get("editors") === "none" ? [] : [
    { id: "code", name: "VS Code" },
    { id: "cursor", name: "Cursor" },
    { id: "windsurf", name: "Windsurf" },
    { id: "zed", name: "Zed" },
    { id: "future-editor", name: "future editor" },
  ],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: PROTOCOL_VERSION,
};

const session: SessionView = {
  id: "session-1",
  runnerId: runner.runnerId,
  workspaceId: null,
  workspaceName: null,
  projectId: null,
  agentId: "codex",
  agentName: "Codex",
  title: "Destination Fixture",
  status: "idle",
  column: "review",
  runId: null,
  useWorktree: false,
  worktreePath: null,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  lastEventAt: null,
  messageCount: 0,
  eventEpoch: 0,
  preview: null,
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

const snapshot: UiSnapshotMessage = {
  type: "snapshot",
  capabilities: {
    sessionSubscriptions: false,
    boundedDelivery: false,
    paginatedSessionHistory: false,
    projects: true,
  },
  runners: [runner],
  boxes: [],
  projects: [],
  sessions: [session],
  runs: [],
  pods: [],
};

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    window.setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify(snapshot) });
    }, 0);
  }
  send() {}
  close() {}
}

const connection: UiConnectionRuntime = {
  instanceId: "open-destination-e2e",
  runtimeKey: "open-destination-e2e:1",
  createSocket: () => new FakeSocket(),
  close() {},
};
const navigation: ViewNavigation = {
  current: () => ({ name: "session", id: session.id }),
  push() {},
  listen: () => () => {},
};
window.hostActions = [];
const client = {
  ...api,
  hostAction: async (_sessionId: string, action: HostAction) => {
    if (fixtureParams.get("fail") === "1") {
      throw new Error("VS Code is not installed or is not available on PATH on the runner host.");
    }
    window.hostActions.push(structuredClone(action));
    return { ok: true as const };
  },
} as ApiClient;

function SessionActions() {
  const ready = useStoreSelector((state) => state.snapshotLoaded);
  if (!ready) return null;
  return (
    <>
      <EditorSelect sessionId={session.id} />
      <span className="detail-actions-divider" aria-hidden="true" />
      <div className="panel-toggles" role="group" aria-label="Panels">
        <button type="button" className="icon-btn" aria-label="Pinned Summary" aria-pressed="false"><InfoIcon size={16} /></button>
        <button type="button" className="icon-btn" aria-label="Terminal" aria-pressed="false"><CommandLineIcon size={16} /></button>
        <button type="button" className="icon-btn" aria-label="Side Panel" aria-pressed="false"><PanelRightIcon size={16} /></button>
      </div>
    </>
  );
}

/**
 * The desktop session bar's right end inside the `app` size container, so the compact tier's rules
 * (§15.2) apply below 1100px as they do in the shell. Phones never render the Open control.
 */
function Harness() {
  return (
    <div className="app">
      <main className="main">
        <div className="session-detail">
          <header className="detail-bar session-bar">
            <div className="detail-actions">
              <div className="topbar-actions"><SessionActions /></div>
            </div>
          </header>
        </div>
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <ApiProvider client={client}>
    <FeedbackProvider>
      <StoreProvider connection={connection} navigation={navigation}>
        <Harness />
      </StoreProvider>
    </FeedbackProvider>
  </ApiProvider>,
);
