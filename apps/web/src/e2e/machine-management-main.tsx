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
  automaticAccountSwitching: { enabled: false, revision: 0 },
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
  selectHarnessInstallation: async (_runnerId: string, agentId: string, installationId: string) => {
    if (!runner) throw new Error("runner not found");
    const agent = runner.agents.find((candidate) => candidate.id === agentId);
    if (!agent?.installation || agent.installation.id !== installationId) throw new Error("installation not found");
    const selection = {
      family: "codex" as const,
      context: agent.context ?? { kind: "native" as const },
      installationId: agent.installation.id,
      path: agent.installation.path,
      via: agent.installation.via,
      version: agent.version,
      agentId,
    };
    runner.harnessSelections = [selection];
    runner.agents = runner.agents.map((candidate) => ({ ...candidate,
      installation: candidate.installation ? { ...candidate.installation,
        selection: candidate.installation.id === selection.installationId ? "selected" as const : "other" as const } : undefined,
    }));
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { selection };
  },
  selectTargetHarnessInstallation: async (_runnerId: string, targetId: string, agentId: string, installationId: string) => {
    if (!runner) throw new Error("runner not found");
    const target = runner.executionTargets?.find((candidate) => candidate.id === targetId);
    const installation = target?.harnessInstallations?.find((candidate) =>
      candidate.agentId === agentId && candidate.id === installationId && candidate.available);
    if (!target || !installation) throw new Error("target installation not found");
    const selection = { targetId, targetName: target.name, agentId, installationId,
      path: installation.path, version: installation.version, available: true };
    runner.targetHarnessSelections = [...(runner.targetHarnessSelections ?? []).filter((item) =>
      !(item.targetId === targetId && item.agentId === agentId)), selection];
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { selection };
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
  updateMachineAutomaticAccountSwitching: async (
    _runnerId: string,
    body: { enabled: boolean; expectedRevision: number },
  ) => {
    if (!runner?.automaticAccountSwitching) throw new Error("runner not found");
    if (body.expectedRevision !== runner.automaticAccountSwitching.revision) {
      throw new Error("Automatic Account Switching changed in another client");
    }
    runner.automaticAccountSwitching = {
      enabled: body.enabled,
      revision: body.expectedRevision + 1,
    };
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { automaticAccountSwitching: structuredClone(runner.automaticAccountSwitching) };
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
      ...(provider === "codex" ? { userCode: "WOLL-IPOGS" } : {}),
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
      setAgentAvailabilityScenario(scenario: "legacy-unverified" | "verified-unavailable" |
        "multiple-installations" | "harness-states" | "target-installations" | "batch-wrapper"): void;
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
    } else if (scenario === "target-installations") {
      runner.protocolVersion = PROTOCOL_VERSION;
      runner.agents = [{ id: "codex", name: "Codex", command: "codex", args: [], env: {},
        driver: "codex-app-server", context: { kind: "native" }, available: true }];
      const image = `example/agent@sha256:${"a".repeat(64)}`;
      const target = (id: string, name: string, installationId: string, path: string) => ({
        id: `runner:${runner!.runnerId}:container:${id}`, runnerId: runner!.runnerId, name,
        kind: "container" as const, adapter: "container" as const, workspaceStrategy: "worktree" as const,
        boundaries: { filesystem: "container" as const, network: "deny" as const,
          secrets: "none" as const, billing: "none" as const },
        environment: { id, revision: 1, image, setupCheckDigest: "b".repeat(64) },
        compatibleAgentIds: ["codex"], available: true,
        harnessInstallations: [{ agentId: "codex", id: installationId, path, version: "1.2.3",
          provenance: "container-image" as const,
          authentication: id === "alpha" ? "authenticated" as const : "unknown" as const,
          ...(id === "alpha" ? { authenticationEvidence: "codex-login-status" as const } : {}),
          capability: id === "alpha" ? "verified" as const : "unknown" as const,
          ...(id === "alpha" ? { capabilityEvidence: "codex-app-server-help" as const } : {}),
          available: true }],
      });
      runner.executionTargets = [target("alpha", "Alpha Image", "a".repeat(24), "/usr/bin/codex"),
        target("beta", "Beta Image", "b".repeat(24), "/usr/bin/codex")];
      runner.targetHarnessSelections = [{ targetId: runner.executionTargets[0]!.id, targetName: "Alpha Image",
        agentId: "codex", installationId: "a".repeat(24), path: "/usr/bin/codex",
        version: "1.2.3", available: true }];
    } else if (scenario === "multiple-installations") {
      runner.protocolVersion = PROTOCOL_VERSION;
      runner.agents = [
        {
          id: "codex",
          name: "Codex",
          command: "/usr/bin/codex",
          args: [], env: {}, driver: "codex-app-server", context: { kind: "native" },
          source: "discovered", available: true, authStatus: "authenticated", version: "0.199.0",
          installation: { id: "system", path: "/usr/bin/codex", via: "path", selection: "selected" },
          update: { status: "update_available", installedVersion: "0.199.0",
            latestKnownCompatibleVersion: "0.199.0", latestPublishedVersion: "0.210.0",
            checkedAt: Date.UTC(2026, 8, 22), channel: "stable",
            evidenceSource: "npm dist-tags for @openai/codex", managedExternally: true,
            guidance: "A newer release is published, but compatibility with this Machine has not been verified. This launch target is inside the @openai/codex package tree. Use the package or version manager that installed this exact copy in the same execution context. Stop sessions using this executable before upgrading. Restart and Rediscover before treating the new version as ready." },
        },
        {
          id: "codex-installation-local", name: "Codex",
          command: "/home/example/.local/bin/codex",
          args: [], env: {}, driver: "codex-app-server", context: { kind: "native" },
          source: "discovered", available: true, authStatus: "authenticated", version: "0.210.0",
          installation: { id: "local", path: "/home/example/.local/bin/codex", via: "common-dir", selection: "other" },
          update: { status: "managed_externally", installedVersion: "0.210.0",
            latestKnownCompatibleVersion: "0.210.0",
            checkedAt: Date.UTC(2026, 8, 22), channel: "stable",
            evidenceSource: "Executable installation provenance", managedExternally: true,
            guidance: "This installation advertises its built-in `codex update` command. Run `'/home/example/.local/bin/codex' 'update'` in a POSIX shell on this Machine after stopping sessions using this executable. A bare `codex` on PATH may be another installation. Restart and Rediscover before treating the new version as ready." },
        },
      ];
      runner.harnessSelections = [{ family: "codex", context: { kind: "native" },
        installationId: "system", path: "/usr/bin/codex", via: "path", version: "0.199.0", agentId: "codex" }];
    } else if (scenario === "batch-wrapper") {
      runner.protocolVersion = PROTOCOL_VERSION;
      runner.agents = [{
        id: "batch-codex", name: "Batch Codex", command: "C:\\Program Files\\Codex Tools\\codex.cmd",
        args: ["--profile", 'Team "Research"', "%PATH%"], env: {}, driver: "codex-app-server",
        context: { kind: "native" }, source: "discovered", available: true,
        installation: { id: "batch", path: "C:\\Program Files\\Codex Tools\\codex.cmd", via: "path" },
        update: { status: "managed_externally", checkedAt: Date.UTC(2026, 8, 22),
          channel: "unknown", evidenceSource: "Executable installation provenance", managedExternally: true,
          guidance: "This installation uses a Windows batch wrapper. Use the package or version manager that installed this exact copy." },
      }];
      runner.harnessSelections = [];
    } else if (scenario === "harness-states") {
      runner.protocolVersion = PROTOCOL_VERSION;
      runner.hostname = "demo-workstation";
      runner.workspaces = [{ id: "demo", name: "Demo", path: "C:\\Users\\example" }];
      const legacyCodex: RunnerView["agents"][number] = {
        id: "legacy-codex", name: "Legacy Codex", command: "C:\\Legacy Tools\\codex.exe",
        args: [], env: {}, driver: "codex-app-server", context: { kind: "native" }, source: "discovered",
        available: false, authStatus: "authenticated", version: "0.140.0",
        installation: { id: "legacy", path: "C:\\Legacy Tools\\codex.exe", via: "path" },
        codexAppServer: { status: "unsupported", installedVersion: "0.140.0", appServerAvailable: true,
          failure: { code: "version_unverified", message: "Codex 0.140.0 is older than the verified app-server floor 0.147.0.", retryable: false } },
        update: { status: "update_available", installedVersion: "0.140.0", latestPublishedVersion: "0.210.0",
          checkedAt: Date.UTC(2026, 8, 22), channel: "stable", evidenceSource: "npm dist-tags for @openai/codex",
          managedExternally: true,
          guidance: "A newer release is published, but compatibility with this Machine has not been verified. Use the package or version manager that installed this exact copy in the same execution context. Stop sessions using this executable before upgrading. Restart and Rediscover before treating the new version as ready." },
      };
      runner.agents = [
        {
          id: "pinned-codex", name: "Pinned Codex", command: "C:\\Program Files\\Codex Tools\\codex.exe",
          args: ["--profile", "Team's Profile"], env: {}, driver: "codex-app-server",
          context: { kind: "native" }, source: "discovered", available: true, version: "0.155.1",
          installation: { id: "pinned", path: "C:\\Program Files\\Codex Tools\\codex.exe", via: "path" },
          update: { status: "managed_externally", installedVersion: "0.155.1", latestKnownCompatibleVersion: "0.155.1",
            checkedAt: Date.UTC(2026, 8, 22), channel: "stable", evidenceSource: "Machine pinned-version policy",
            managedExternally: true, guidance: "This harness installation is pinned by Machine policy. Release checks are suppressed, so no current release status was established. Ask the Machine operator to change the pin before planning an upgrade." },
        },
        {
          id: "policy-claude", name: "Policy Claude", command: "C:\\Tools\\Claude\\claude.exe",
          args: [], env: {}, driver: "claude-code", context: { kind: "native" }, source: "discovered",
          available: true, version: "1.2.3", installation: { id: "policy", path: "C:\\Tools\\Claude\\claude.exe", via: "path" },
          update: { status: "managed_externally", installedVersion: "1.2.3", checkedAt: Date.UTC(2026, 8, 22),
            channel: "stable", evidenceSource: "Machine update-check policy", managedExternally: true,
            guidance: "Release checks are disabled by this Machine's policy. Ask the Machine operator whether manual upgrades are permitted." },
        },
        {
          id: "failed-pi", name: "Failed Pi", command: "C:\\Tools\\Pi\\pi.exe",
          args: [], env: {}, driver: "pi", context: { kind: "native" }, source: "discovered",
          available: true, version: "0.8.0", installation: { id: "failed", path: "C:\\Tools\\Pi\\pi.exe", via: "path" },
          update: { status: "check_failed", installedVersion: "0.8.0", checkedAt: Date.UTC(2026, 8, 22),
            channel: "stable", evidenceSource: "npm dist-tags for @earendil-works/pi-coding-agent", managedExternally: true,
            guidance: "The release check could not complete, so no current release status was established. The Machine may be offline, behind a proxy, or rate limited; retry the check after connectivity returns." },
        },
        legacyCodex,
        { ...legacyCodex, id: "legacy-codex-exec", name: "Legacy Codex (Non-Interactive)", driver: "codex", available: true },
      ];
      runner.harnessSelections = [];
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
