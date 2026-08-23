import React from "react";
import { createRoot } from "react-dom/client";
import { PROTOCOL_VERSION, type HostAction, type RunnerView, type SessionView, type UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { EditorSelect } from "../components/EditorSelect.js";
import { PanelRightIcon, PinnedPanelIcon, TerminalIcon } from "../components/Icons.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

declare global {
  interface Window {
    hostActions: HostAction[];
  }
}

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "fixture-runner",
  os: "linux",
  version: "1",
  status: "online",
  agents: [],
  workspaces: [],
  editors: [
    { id: "code", name: "VS Code" },
    { id: "cursor", name: "Cursor" },
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
  send() {}
  close() {}
  push(message: UiSnapshotMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const socket = new FakeSocket();
const connection: UiConnectionRuntime = {
  instanceId: "open-destination-e2e",
  runtimeKey: "open-destination-e2e:1",
  createSocket: () => socket,
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
      <button type="button" className="icon-btn" aria-label="Toggle Pinned Summary"><PinnedPanelIcon /></button>
      <button type="button" className="icon-btn" aria-label="Show Terminal"><TerminalIcon /></button>
      <button type="button" className="icon-btn" aria-label="Show Side Panel"><PanelRightIcon /></button>
    </>
  );
}

function Harness() {
  const mobile = new URLSearchParams(window.location.search).get("mobile") === "1";
  return (
    <header className="topbar">
      <h1>Destination Fixture</h1>
      {mobile && (
        <div className="topbar-actions topbar-mobile-controls">
          <button type="button" className="instance-selector-trigger" aria-label="Instance">I</button>
          <button type="button" className="settings-trigger" aria-label="Settings">S</button>
        </div>
      )}
      <div className="topbar-actions"><SessionActions /></div>
    </header>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <ApiProvider client={client}>
    <StoreProvider connection={connection} navigation={navigation}>
      <Harness />
    </StoreProvider>
  </ApiProvider>,
);
window.setTimeout(() => socket.push(snapshot), 0);
