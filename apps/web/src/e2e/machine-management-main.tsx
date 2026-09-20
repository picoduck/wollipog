import React from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type AddBoxRequest,
  type ControlPlaneToUi,
  type RunnerView,
  type UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { RunnersView } from "../components/RunnersView.js";
import { InstanceScopeProvider } from "../instance-scope.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

const requestedRole = new URLSearchParams(window.location.search).get("role");
const identityRole = requestedRole === "viewer"
  ? "viewer" as const
  : requestedRole === "machine-owner" ? "operator" as const : "owner" as const;

let runner: RunnerView | null = {
  runnerId: "native-t14s",
  displayName: "Design Workstation",
  hostname: "Misko-T14s-G6",
  os: "windows",
  version: "1",
  status: "online",
  agents: [
    {
      id: "custom-acp",
      name: "Custom ACP",
      command: "custom-acp",
      args: [],
      env: {},
      driver: "acp",
      context: { kind: "native" },
      source: "config",
      available: true,
      authStatus: "authenticated",
      acp: {
        logout: false,
        loadSession: false,
        sessionList: false,
        sessionDelete: false,
        sessionResume: false,
        sessionClose: false,
      },
    },
    {
      id: "missing-acp",
      name: "Missing ACP",
      command: "missing-acp",
      args: [],
      env: {},
      driver: "acp",
      context: { kind: "native" },
      source: "config",
      available: false,
      unavailableReason: "The configured command was not found or could not be started in this execution context.",
    },
    {
      id: "legacy-acp",
      name: "Legacy Unverified ACP",
      command: "legacy-acp",
      args: [],
      env: {},
      driver: "acp",
      context: { kind: "native" },
      source: "config",
    },
  ],
  providerAccounts: [
    {
      id: "claude-work",
      label: "Work",
      provider: "claude",
      authStatus: "authenticated",
    },
    {
      id: "claude-personal",
      label: "Personal",
      provider: "claude",
      authStatus: "unauthenticated",
    },
  ],
  workspaces: [{ id: "home", name: "Home", path: "C:\\Users\\misko" }],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: PROTOCOL_VERSION,
  agentsRefreshed: true,
  canManage: identityRole !== "viewer",
  capacity: {
    configuredUnits: 16,
    revision: 2,
    authority: "control_plane",
    usedUnits: 12,
    availableUnits: 4,
    queuedSessions: 3,
    dimensions: {
      activeTurns: { used: 4, limit: 4, available: 0 },
      residentProcessUnits: { used: 12, limit: 16, available: 4 },
      retainedSessions: { used: 9, limit: null, available: null },
      parkedSessions: 2,
      idleProcessPolicy: "park_when_needed",
    },
    blockers: [{
      kind: "agent_quota",
      description: "claude is using 4 of 4 provider slots",
      usedUnits: 4,
      limitUnits: 4,
      requiredUnits: 1,
      waitingSessions: 3,
      agentId: "claude",
    }],
  },
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
      role: identityRole,
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
  updateMachineCapacity: async (_runnerId: string, body: { configuredUnits: number; expectedRevision: number }) => {
    if (!runner?.capacity) throw new Error("runner not found");
    if (body.expectedRevision !== runner.capacity.revision) throw new Error("Runner Capacity changed in another client");
    runner.capacity = {
      ...runner.capacity,
      configuredUnits: body.configuredUnits,
      revision: body.expectedRevision + 1,
      availableUnits: Math.max(0, body.configuredUnits - (runner.capacity.usedUnits ?? 0)),
      ...(runner.capacity.dimensions ? {
        dimensions: {
          ...runner.capacity.dimensions,
          residentProcessUnits: {
            used: runner.capacity.dimensions.residentProcessUnits.used,
            limit: body.configuredUnits,
            available: Math.max(0,
              body.configuredUnits - runner.capacity.dimensions.residentProcessUnits.used),
          },
        },
      } : {}),
    };
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { capacity: { configuredUnits: runner.capacity.configuredUnits, revision: runner.capacity.revision } };
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
  startProviderLogin: async (
    _runnerId: string,
    body: { provider: "claude" | "codex"; label: string } | { accountId: string },
  ) => {
    if (!runner) throw new Error("runner not found");
    const existing = "accountId" in body
      ? runner.providerAccounts?.find((account) => account.id === body.accountId)
      : undefined;
    const provider = existing?.provider ?? ("provider" in body ? body.provider : "claude");
    const label = existing?.label ?? ("label" in body ? body.label : "Account");
    const accountId = existing?.id ?? `fixture-${provider}`;
    const login = {
      operationId: `login_fixture_${provider}`,
      accountId,
      label,
      provider,
      status: provider === "claude" ? "awaiting_code" as const : "waiting_for_provider" as const,
      expectsCode: provider === "claude",
      verificationUrl: provider === "claude"
        ? "https://claude.ai/oauth/authorize?fixture=machine"
        : "https://auth.openai.com/device",
      ...(provider === "codex" ? { userCode: "WOLL-IPOG" } : {}),
      startedAt: Date.now(),
    };
    runner.providerLogins = [login];
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { login };
  },
  submitProviderLoginCode: async (_runnerId: string, operationId: string) => {
    if (!runner) throw new Error("runner not found");
    const login = runner.providerLogins?.find((candidate) => candidate.operationId === operationId);
    if (!login) throw new Error("login not found");
    const completed = { ...login, status: "succeeded" as const, expectsCode: false };
    runner.providerLogins = [completed];
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { login: completed };
  },
  cancelProviderLogin: async (_runnerId: string, operationId: string) => {
    if (!runner) throw new Error("runner not found");
    const login = runner.providerLogins?.find((candidate) => candidate.operationId === operationId);
    if (!login) throw new Error("login not found");
    const cancelled = { ...login, status: "cancelled" as const, expectsCode: false };
    runner.providerLogins = [cancelled];
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { login: cancelled };
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
      setAgentAvailabilityScenario(scenario: "legacy-unverified" | "verified-unavailable"): void;
      setRunnerStatus(status: RunnerView["status"]): void;
    };
  }
}

window.__WOLLIPOG_MACHINE_E2E__ = {
  lastRegisteredWorkspace: () => structuredClone(lastRegisteredWorkspace),
  lastAddBoxRequest: () => structuredClone(lastAddBoxRequest),
  setAgentAvailabilityScenario: (scenario) => {
    if (!runner) return;
    if (scenario === "legacy-unverified") {
      runner.protocolVersion = 153;
      runner.agents = [{
        id: "legacy-acp",
        name: "Legacy Unverified ACP",
        command: "legacy-acp",
        args: [],
        env: {},
        driver: "acp",
        context: { kind: "native" },
        source: "config",
      }];
    } else {
      runner.protocolVersion = 154;
      runner.agents = [{
        id: "missing-acp",
        name: "Missing ACP",
        command: "missing-acp",
        args: [],
        env: {},
        driver: "acp",
        context: { kind: "native" },
        source: "config",
        available: false,
        unavailableReason: "The configured command was not found or could not be started in this execution context.",
      }];
    }
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
  },
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
