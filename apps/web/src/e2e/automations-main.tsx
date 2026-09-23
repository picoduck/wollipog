import React from "react";
import { createRoot } from "react-dom/client";
import type {
  AutomationExecution,
  AutomationSchedule,
  AutomationTriggerView,
  OutboundEventDeliveryView,
  OutboundEventSubscriptionView,
  RunnerView,
  UiSnapshotMessage,
  WorkflowDefinition,
} from "@wollipog/protocol";
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

if (params.has("saved-installation")) {
  runner.protocolVersion = 175;
  runner.agents[0]!.installation = {
    id: "local", path: "/home/misko/.local/bin/agent", via: "common-dir", selection: "selected",
  };
  const first = items[0]!.action;
  if (first.kind === "create_session") first.installationBindings = { agent: {
    driver: "claude-code", context: { kind: "native" }, installationId: "system",
  } };
}

const alternateRunner: RunnerView | null = params.has("alternate-installation") ? {
  ...runner,
  runnerId: "runner-2",
  hostname: "backup-box",
  protocolVersion: 175,
  agents: [{ ...runner.agents[0]!, id: "agent-2", installation: {
    id: params.get("alternate-installation") === "unavailable" ? "local" : "system",
    path: "/usr/bin/agent", via: "path", selection: "selected",
  } }],
  workspaces: [{ id: "workspace-2", name: "Backup", path: "/home/misko/backup" }],
} : null;
if (alternateRunner) items[0]!.runnerPolicy = { kind: "alternate", targets: [{
  runnerId: "runner-2", workspaceId: "workspace-2", agentId: "agent-2",
  installationBindings: { agent: {
    driver: "claude-code", context: { kind: "native" }, installationId: "system",
  } },
}] };

const workflowSwitchRunner: RunnerView | null = params.has("workflow-machine-switch") ? {
  ...runner,
  runnerId: "runner-2",
  hostname: "second-box",
  protocolVersion: 175,
  agents: [
    { ...runner.agents[0]!, name: "Configured Agent", driver: "acp", installation: undefined },
    { ...runner.agents[0]!, id: "new-agent", name: "Discovered Agent", installation: {
      id: "system", path: "/usr/bin/agent", via: "path", selection: "selected",
    } },
  ],
  workspaces: [{ id: "workspace-2", name: "Second", path: "/home/misko/second" }],
} : null;
const workflowDefinitions: WorkflowDefinition[] = workflowSwitchRunner ? [{
  workflowId: "workflow-1", version: 1, name: "Audit Workflow", source: "custom",
  maxTransitions: 1, createdBy: { kind: "human", id: "e2e" }, createdAt: 1, edges: [],
  nodes: [{ nodeId: "audit", kind: "agent", role: "auditor", agentId: "agent-1",
    inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1_000 }],
}] : [];
if (workflowSwitchRunner) {
  runner.protocolVersion = 175;
  runner.agents[0]!.installation = {
    id: "system", path: "/usr/bin/agent", via: "path", selection: "selected",
  };
  items[0]!.action = { kind: "workflow_run", request: {
    runnerId: "runner-1", workspaceId: "workspace-1", workflowId: "workflow-1", task: "Audit",
    agentBindings: { "agent-1": "agent-1" },
  }, installationBindings: { "role:agent-1": {
    driver: "claude-code", context: { kind: "native" }, installationId: "system",
  } } };
}

const triggerItems: AutomationTriggerView[] = [{
  triggerId: "atr_issue_intake",
  automationId: "automation-nightly-sweep",
  kind: "webhook",
  name: "Issue Intake",
  generation: 1,
  invocationCount: 12,
  createdBy: { kind: "human", id: "e2e" },
  createdAt: 1,
  updatedAt: 1,
  deliveryPolicy: {
    allowPrompt: true,
    parameterNames: ["issue", "priority"],
    missingReferences: "reject",
  },
}];

const executions: AutomationExecution[] = [{
  executionId: "axe_issue_1099",
  automationId: "automation-nightly-sweep",
  idempotencyKey: "trigger:atr_issue_intake:github-1099",
  scheduledFor: Date.UTC(2026, 8, 14, 12),
  automationRevision: 1,
  deliveryMode: "receipted_v53",
  actionKind: "create_session",
  status: "succeeded",
  actor: { kind: "system", id: "automation:automation-nightly-sweep" },
  sessionId: "s_issue_1099",
  triggerDelivery: {
    fields: ["prompt", "parameters"],
    promptSha256: "95a911a82fc5ad618ed97d4b8a9daf884872ac8f0f21d98cc900dce04977749b",
    parameterNames: ["issue", "priority"],
  },
  createdAt: Date.UTC(2026, 8, 14, 12),
  startedAt: Date.UTC(2026, 8, 14, 12, 0, 1),
  completedAt: Date.UTC(2026, 8, 14, 12, 4),
}];

const outboundSubscriptions: OutboundEventSubscriptionView[] = [{
  subscriptionId: "oes_release_events",
  callbackUrl: "https://events.example.com/wollipog",
  scope: { kind: "automation", automationId: "automation-nightly-sweep" },
  eventKinds: ["session.created", "session.input_required", "pull_request.opened", "checks.failed"],
  includeSessionName: false,
  includeQuestionTitle: false,
  state: "paused",
  pauseReason: "Paused after 6 bounded delivery attempts",
  generation: 2,
  createdBy: { kind: "human", id: "e2e" },
  createdAt: Date.UTC(2026, 8, 14, 12),
  updatedAt: Date.UTC(2026, 8, 14, 12, 31),
}];

const outboundDeliveries: OutboundEventDeliveryView[] = [{
  deliveryId: "oed_release_created",
  subscriptionId: "oes_release_events",
  eventId: "oev_release_created",
  kind: "session.created",
  status: "failed",
  attemptCount: 6,
  statusCode: 503,
  error: "Callback returned 503",
  createdAt: Date.UTC(2026, 8, 14, 12),
  updatedAt: Date.UTC(2026, 8, 14, 12, 31),
  lastAttemptAt: Date.UTC(2026, 8, 14, 12, 31),
}, {
  deliveryId: "oed_checks_failed",
  subscriptionId: "oes_release_events",
  eventId: "oev_checks_failed",
  kind: "checks.failed",
  status: "retrying",
  attemptCount: 2,
  statusCode: 503,
  error: "Callback returned 503",
  createdAt: Date.UTC(2026, 8, 14, 12, 30),
  updatedAt: Date.UTC(2026, 8, 14, 12, 31),
  lastAttemptAt: Date.UTC(2026, 8, 14, 12, 31),
  nextRetryAt: Date.UTC(2026, 8, 14, 12, 33),
}];

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
        runners: [runner, ...(alternateRunner ? [alternateRunner] : []),
          ...(workflowSwitchRunner ? [workflowSwitchRunner] : [])],
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
    executions: id === "automation-nightly-sweep" ? executions : [],
    events: [],
  }),
  automationTriggers: async (id: string) => ({
    triggers: id === "automation-nightly-sweep" ? triggerItems : [],
  }),
  outboundEventSubscriptions: async () => outboundSubscriptions,
  outboundEventDeliveries: async () => outboundDeliveries,
  workflowDefinitions: async () => workflowDefinitions,
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
