import React from "react";
import { createRoot } from "react-dom/client";
import type { AutomationSchedule, RunnerView, UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { AutomationsView } from "../components/AutomationsView.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

/**
 * Two automation cards — collapsed by default, one enabled and one paused — for the responsive
 * disclosure spec. `mobile-viewport.spec.ts` and friends are the model: a real browser, a real
 * stylesheet, a fixture only where the control plane cannot be automated.
 */
const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "build-box",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{
    id: "agent-1", name: "Agent", command: "agent", args: [], env: {},
    driver: "claude-code", available: true,
  }],
  workspaces: [{ id: "workspace-1", name: "Home", path: "/home/misko/repo" }],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 90,
};

const items: AutomationSchedule[] = [
  {
    automationId: "automation-nightly-sweep",
    revision: 1,
    name: "Nightly Dependency Sweep and Long-Running Audit Report",
    cron: "0 2 * * *",
    timezone: "America/Chicago",
    enabled: true,
    action: {
      kind: "create_session",
      request: {
        runnerId: "runner-1", workspaceId: "workspace-1", agentId: "agent-1",
        prompt: "Sweep dependencies and file a report.", useWorktree: true,
      },
    },
    misfirePolicy: { kind: "skip" },
    runnerPolicy: { kind: "wait" },
    concurrencyPolicy: "wait",
    limits: { maxCostUsd: 5, maxToolCalls: 50 },
    notifications: { pushEvents: [] },
    createdBy: { kind: "human", id: "e2e" },
    createdAt: 1,
    updatedAt: 1,
  },
  {
    automationId: "automation-weekly-digest",
    revision: 1,
    name: "Weekly Digest",
    cron: "0 9 * * 1",
    timezone: "America/Chicago",
    enabled: false,
    action: {
      kind: "create_session",
      request: {
        runnerId: "runner-1", workspaceId: "workspace-1", agentId: "agent-1",
        prompt: "Summarize the week.", useWorktree: false,
      },
    },
    misfirePolicy: { kind: "skip" },
    runnerPolicy: { kind: "wait" },
    concurrencyPolicy: "wait",
    limits: { maxCostUsd: 2, maxToolCalls: 20 },
    notifications: { pushEvents: [] },
    createdBy: { kind: "human", id: "e2e" },
    createdAt: 1,
    updatedAt: 1,
  },
];

class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    window.setTimeout(() => {
      this.onopen?.();
      this.push({
        type: "snapshot",
        capabilities: {
          sessionSubscriptions: false,
          boundedDelivery: false,
          paginatedSessionHistory: false,
          projects: false,
        },
        runners: [runner],
        boxes: [],
        sessions: [],
        runs: [],
        pods: [],
      });
    }, 0);
  }
  send() {}
  close() {}
  push(message: UiSnapshotMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const connection: UiConnectionRuntime = {
  instanceId: "automations-e2e",
  runtimeKey: "automations-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "automations" }),
  push() {},
  listen: () => () => {},
};

const client = {
  ...api,
  automations: async () => ({ automations: items }),
  automation: async (id: string) => ({
    automation: items.find((item) => item.automationId === id)!,
    executions: [],
    events: [],
  }),
  automationTriggers: async () => ({ triggers: [] }),
  workflowDefinitions: async () => [],
} as unknown as ApiClient;

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <React.StrictMode>
    <ApiProvider client={client}>
      <FeedbackProvider>
        <StoreProvider connection={connection} navigation={navigation}>
          <main className="main-pane"><AutomationsView /></main>
        </StoreProvider>
      </FeedbackProvider>
    </ApiProvider>
  </React.StrictMode>,
);
