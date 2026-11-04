import React from "react";
import { createRoot } from "react-dom/client";
import {
  PERSONAL_ORGANIZATION_ID,
  type ControlPlaneToUi,
  type RunnerView,
  type UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { RunnersView } from "../components/RunnersView.js";
import { InstanceScopeProvider } from "../instance-scope.js";
import type { LocalRunnerStatus } from "../local-runner.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

/**
 * Set Up This Machine (#2993) in the web build, with the desktop app's bridge mocked: the bundled
 * runner is available and not set up, and each `connect_local_runner` call waits until the test
 * settles it through `window.__WOLLIPOG_SET_UP_MACHINE_E2E__`; its reply is what
 * `local_runner_status` reports from then on. The runner's progress arrives as `runner_upsert`
 * messages, as the control plane sends them.
 */

const NOT_SET_UP: LocalRunnerStatus = { available: true, enabled: false, running: false, runnerId: null };
const STARTED: LocalRunnerStatus = { available: true, enabled: true, running: true, runnerId: "this-machine" };

let bridgeStatus: LocalRunnerStatus = NOT_SET_UP;
let pendingConnect: { resolve: (status: LocalRunnerStatus) => void; reject: (cause: Error) => void } | null = null;
Object.assign(globalThis, { isTauri: true });
Object.assign(window, {
  __TAURI_INTERNALS__: {
    invoke: async (command: string) => {
      if (command === "local_runner_status") return bridgeStatus;
      if (command === "connect_local_runner") {
        return new Promise<LocalRunnerStatus>((resolve, reject) => { pendingConnect = { resolve, reject }; });
      }
      throw new Error(`${command} is not part of this fixture`);
    },
  },
});

const AGENTS: RunnerView["agents"] = [
  {
    id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code",
    context: { kind: "native" }, source: "discovered", available: true, authStatus: "authenticated",
    claudeCode: { status: "ready", auth: { billingSource: "subscription" } } as never,
  },
  {
    id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server",
    context: { kind: "native" }, source: "discovered", available: true, authStatus: "authenticated",
    codexAppServer: { status: "supported", appServerAvailable: true },
  },
  {
    id: "codex-wsl", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server",
    context: { kind: "wsl", distro: "Ubuntu" }, source: "discovered", available: false, authStatus: "unauthenticated",
    codexAppServer: { status: "supported", appServerAvailable: true },
  },
];

function localRunner(scenario: RunnerScenario): RunnerView {
  const agents = scenario === "needs-attention" ? AGENTS.slice(2) : AGENTS;
  return {
    runnerId: "this-machine",
    displayName: "This Machine",
    hostname: "studio-desktop",
    os: "linux",
    version: "1",
    status: scenario === "offline" ? "offline" : "online",
    agents: scenario === "discovering" ? [] : agents,
    agentsRefreshed: scenario !== "discovering",
    workspaces: [],
    connectedAt: 1,
    lastSeen: 1,
    protocolVersion: 160,
  };
}

type RunnerScenario = "discovering" | "ready" | "needs-attention" | "offline";
let runner: RunnerView | null = null;
let socket: FixtureSocket | null = null;

function snapshot(): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
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
  instanceId: "set-up-this-machine-e2e",
  runtimeKey: "set-up-this-machine-e2e:1",
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
  getOnboarding: async () => ({
    runnerWsUrl: "ws://127.0.0.1:4417/runner",
    host: "127.0.0.1",
    port: 4417,
    lanIps: ["192.168.1.24"],
    existingRunnerIds: runner ? [runner.runnerId] : [],
  }),
  listSkills: async () => ({
    skills: [
      { id: "skill-using-wollipog", name: "using-wollipog", builtIn: true, recommendation: { dismissed: false }, assignmentCount: 0 },
      { id: "skill-orchestrate-issues", name: "orchestrate-issues", builtIn: true, recommendation: { dismissed: false }, assignmentCount: 0 },
    ],
  }),
  sshConfigHosts: async () => ({ hosts: [] }),
  rediscover: async () => ({ ok: true as const }),
  getIdentity: async () => ({
    context: {
      userId: "owner",
      userName: "Owner",
      organizationId: PERSONAL_ORGANIZATION_ID,
      organizationName: "Organization",
      role: "owner" as const,
      deviceId: null,
      localBootstrap: true,
    },
    organizations: [{ organizationId: PERSONAL_ORGANIZATION_ID, name: "Organization", createdAt: 1 }],
    memberships: [],
    teams: [],
  }),
} as unknown as ApiClient;

declare global {
  interface Window {
    __WOLLIPOG_SET_UP_MACHINE_E2E__: {
      /** Settle the pending `connect_local_runner`: the runner started, started but is not running, or failed. */
      finishConnect(outcome: "started" | "not-running" | { error: string }): void;
      /** The bundled runner as the control plane reports it. */
      setRunner(scenario: RunnerScenario): void;
      /** The bundled runner's process exits, as `local_runner_status` reports it next. */
      exitRunner(): void;
    };
  }
}

window.__WOLLIPOG_SET_UP_MACHINE_E2E__ = {
  finishConnect: (outcome) => {
    const pending = pendingConnect;
    if (!pending) throw new Error("no connect_local_runner call is pending");
    pendingConnect = null;
    if (outcome === "started") bridgeStatus = STARTED;
    else if (outcome === "not-running") bridgeStatus = { ...STARTED, running: false };
    else return pending.reject(new Error(outcome.error));
    pending.resolve(bridgeStatus);
  },
  setRunner: (scenario) => {
    runner = localRunner(scenario);
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
  },
  exitRunner: () => {
    bridgeStatus = { ...bridgeStatus, running: false };
  },
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <React.StrictMode>
    <InstanceScopeProvider instanceScope="set-up-this-machine-e2e">
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
