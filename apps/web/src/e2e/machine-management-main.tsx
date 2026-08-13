import React from "react";
import { createRoot } from "react-dom/client";
import type { AddBoxRequest, ControlPlaneToUi, RunnerView, UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { RunnersView } from "../components/RunnersView.js";
import { InstanceScopeProvider } from "../instance-scope.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

let runner: RunnerView | null = {
  runnerId: "native-t14s",
  displayName: "Design Workstation",
  hostname: "Misko-T14s-G6",
  os: "windows",
  version: "1",
  status: "online",
  agents: [],
  workspaces: [{ id: "home", name: "Home", path: "C:\\Users\\misko" }],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 63,
  agentsRefreshed: true,
};
let socket: FixtureSocket | null = null;
let lastRegisteredWorkspace: { name: string; path: string } | null = null;
let lastAddBoxRequest: AddBoxRequest | null = null;

function snapshot(): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: true,
      createProjectLocations: true,
    },
    runners: runner ? [structuredClone(runner)] : [],
    boxes: [],
    projects: [],
    sessions: [],
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
  constructor() {
    window.setTimeout(() => {
      this.onopen?.();
      this.push(snapshot());
    }, 0);
  }
  send() {}
  close() {}
  push(message: ControlPlaneToUi): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const connection: UiConnectionRuntime = {
  instanceId: "machine-management-e2e",
  runtimeKey: "machine-management-e2e:1",
  createSocket() {
    socket = new FixtureSocket();
    return socket;
  },
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "runners", section: "machines" }),
  push() {},
  listen: () => () => {},
};

const client = {
  ...api,
  sshConfigHosts: async () => ({
    hosts: [
      { host: "golf-sim", hostName: "100.64.0.10", user: "misko", port: 2222 },
      { host: "build-box", hostName: "build.internal", user: "builder" },
    ],
  }),
  addBox: async (body: AddBoxRequest) => {
    lastAddBoxRequest = structuredClone(body);
    return {
      box: {
        boxId: "box-created",
        runnerId: "box-created",
        displayName: body.displayName,
        sshTarget: body.sshTarget,
        status: "bootstrapping" as const,
        lastError: null,
        createdAt: 1,
      },
    };
  },
  getIdentity: async () => ({
    context: {
      userId: "owner",
      userName: "Owner",
      organizationId: "org",
      organizationName: "Organization",
      role: "owner",
      deviceId: null,
      localBootstrap: true,
    },
    organizations: [{ organizationId: "org", name: "Organization", createdAt: 1 }],
    memberships: [],
    teams: [],
  }),
  updateMachine: async (_runnerId: string, body: { displayName: string }) => {
    if (!runner) throw new Error("runner not found");
    runner.displayName = body.displayName;
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { ok: true as const };
  },
  listDirectory: async (_runnerId: string, path: string) => {
    if (!path) {
      return {
        path: "C:\\Users\\misko",
        parent: "C:\\Users",
        entries: [{ name: "repo", path: "C:\\Users\\misko\\repo", isDir: true }],
      };
    }
    return { path, parent: "C:\\Users\\misko", entries: [] };
  },
  registerMachineWorkspace: async (_runnerId: string, body: { name: string; path: string }) => {
    if (!runner) throw new Error("runner not found");
    lastRegisteredWorkspace = structuredClone(body);
    const workspace = { id: "registered-workspace", ...body };
    runner.workspaces.push(workspace);
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { workspace };
  },
  removeRunner: async () => {
    if (!runner) throw new Error("runner not found");
    const runnerId = runner.runnerId;
    runner = null;
    socket?.push({ type: "runner_removed", runnerId });
  },
} as ApiClient;

declare global {
  interface Window {
    __WOLLIPOG_MACHINE_E2E__: {
      lastRegisteredWorkspace(): { name: string; path: string } | null;
      lastAddBoxRequest(): AddBoxRequest | null;
      setRunnerStatus(status: RunnerView["status"]): void;
    };
  }
}

window.__WOLLIPOG_MACHINE_E2E__ = {
  lastRegisteredWorkspace: () => structuredClone(lastRegisteredWorkspace),
  lastAddBoxRequest: () => structuredClone(lastAddBoxRequest),
  setRunnerStatus: (status) => {
    if (!runner) return;
    runner.status = status;
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
  },
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <React.StrictMode>
    <InstanceScopeProvider instanceScope="machine-management-e2e">
      <ApiProvider client={client}>
        <FeedbackProvider>
          <StoreProvider connection={connection} navigation={navigation}>
            <RunnersView />
          </StoreProvider>
        </FeedbackProvider>
      </ApiProvider>
    </InstanceScopeProvider>
  </React.StrictMode>,
);
