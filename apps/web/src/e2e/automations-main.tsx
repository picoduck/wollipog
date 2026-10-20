import React from "react";
import { createRoot } from "react-dom/client";
import type {
  AutomationExecution,
  AutomationSchedule,
  AutomationSpec,
  AutomationTriggerView,
  CreateOutboundEventSubscriptionRequest,
  OutboundEventDeliveryView,
  OutboundEventSubscriptionView,
  ProjectView,
  RunnerView,
  SessionView,
  UiSnapshotMessage,
  WorkflowDefinition,
} from "@wollipog/protocol";
import { AUTOMATION_TARGET_INSTALLATION_UNAVAILABLE, AUTOMATION_TARGET_UNAVAILABLE } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { AutomationsView } from "../components/AutomationsView.js";
import { AutomationEditor } from "../components/AutomationEditor.js";
import { AutomationDetail } from "../components/AutomationDetail.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { setExperimentFlag } from "../experiments.js";
import { viewFromPath, viewPath, type ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

/**
 * Two automations — one enabled that has run, one paused that never ran — on the list, their
 * pages (`?route=/automations/~<id>`, #2968) and the editor. `mobile-viewport.spec.ts` and friends are the model: a real browser, a real
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

// `?capabilities` advertises a model, efforts and permission modes, so New Automation shows the
// Model, Reasoning Effort and Permission Mode pickers.
if (params.has("capabilities")) runner.agents[0]!.capabilities = {
  models: [{ id: "model-1", displayName: "Model One" }],
  effortLevels: ["low", "high"],
  permissionModes: ["default", "plan"],
  slashCommands: [],
  supportsImages: false,
  supportsApprovals: true,
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

// `waiting-target=installation` shows the control plane's other waiting reason.
const targetReason = params.get("waiting-target") === "installation"
  ? AUTOMATION_TARGET_INSTALLATION_UNAVAILABLE : AUTOMATION_TARGET_UNAVAILABLE;
if (params.has("waiting-target")) {
  items[0]!.targetHealth = {
    scheduledFor: Date.now() - 60_000,
    firstSeenAt: Date.now() - 59_000,
    error: targetReason,
  };
}

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
    ...(params.has("orchestrator-bound") || params.has("orchestrator-unbound")
      ? { orchestratorAgentId: "agent-1" } : {}),
  }, installationBindings: { "role:agent-1": {
    driver: "claude-code", context: { kind: "native" }, installationId: "system",
  }, ...(params.has("orchestrator-bound") ? { orchestrator: {
    driver: "claude-code" as const, context: { kind: "native" as const }, installationId: "system",
  } } : {}) } };
}

if (params.has("inherited-alternate-pins") && workflowSwitchRunner) {
  const oldAgent = runner.agents[0]!;
  const newAgent = { ...oldAgent, id: "new-agent", name: "New Agent", driver: "codex-app-server" as const,
    installation: { id: "new", path: "/usr/bin/codex", via: "path" as const, selection: "selected" as const } };
  runner.agents.push(newAgent);
  workflowSwitchRunner.agents = [oldAgent, newAgent];
  items[0]!.runnerPolicy = { kind: "alternate", targets: [{
    runnerId: "runner-2", workspaceId: "workspace-2",
    installationBindings: {
      "role:agent-1": { driver: "claude-code", context: { kind: "native" }, installationId: "system" },
      orchestrator: { driver: "claude-code", context: { kind: "native" }, installationId: "system" },
    },
  }] };
}

// Every saved workflow pin, primary and alternate, names an installation the Machines no longer have.
if (params.has("unavailable-pins")) {
  const first = items[0]!;
  const bindings = [
    ...(first.action.kind === "workflow_run" ? [first.action.installationBindings] : []),
    ...(first.runnerPolicy.kind === "alternate" ? first.runnerPolicy.targets.map((target) => target.installationBindings) : []),
  ];
  for (const binding of bindings.flatMap((entry) => Object.values(entry ?? {}))) binding.installationId = "missing";
}

// The Automation editor's scenarios (#2967).
// `other-machine-offline`: the first automation falls back to another machine, which is offline.
const offlineRunner: RunnerView | null = params.has("other-machine-offline") ? {
  ...runner,
  runnerId: "runner-offline",
  hostname: "backup-box",
  status: "offline",
  agents: [{ ...runner.agents[0]!, id: "agent-backup", name: "Backup Agent" }],
  workspaces: [{ id: "workspace-backup", name: "Backup", path: "/home/misko/backup" }],
} : null;
if (offlineRunner) items[0]!.runnerPolicy = { kind: "alternate", targets: [{
  runnerId: "runner-offline", workspaceId: "workspace-backup", agentId: "agent-backup",
}], expireAfterMinutes: 30 };

// `review-workflow`: the first automation runs a build-and-review workflow with a human approval.
if (params.has("review-workflow")) {
  runner.agents.push({ ...runner.agents[0]!, id: "agent-review", name: "Review Agent", driver: "codex-app-server" });
  const step = { inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 3_600_000 };
  workflowDefinitions.push({
    workflowId: "build-review", version: 2, name: "Build and Review", source: "custom", maxTransitions: 4,
    createdBy: { kind: "human", id: "e2e" }, createdAt: 1, edges: [],
    nodes: [
      { nodeId: "build", kind: "agent", role: "builder", agentId: "agent-1", ...step },
      { nodeId: "review", kind: "agent", role: "reviewer", agentId: "agent-review", ...step },
      { nodeId: "approve", kind: "human_gate", role: "approver", ...step },
    ],
  });
  items[0]!.action = { kind: "workflow_run", request: {
    runnerId: "runner-1", workspaceId: "workspace-1", workflowId: "build-review", workflowVersion: 2,
    task: "Implement the dependency updates, then review them before they merge.",
  } };
}

// `experiment-off`: Multi-Agent Runs is turned off in Settings › Experimental on this device.
setExperimentFlag("multiAgent", !params.has("experiment-off"));

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
// A run that expired while it waited keeps the waiting reason as its error.
if (params.has("expired-run")) executions.unshift({
  ...executions[0]!, executionId: "axe_expired", idempotencyKey: "schedule:automation-nightly-sweep:expired",
  scheduledFor: Date.UTC(2026, 8, 15, 2), status: "expired", error: targetReason,
  sessionId: undefined, triggerDelivery: undefined, startedAt: undefined,
  createdAt: Date.UTC(2026, 8, 15, 2), completedAt: Date.UTC(2026, 8, 15, 2, 30),
});
// `failed-run`: the latest run failed (#2968's Needs Attention, with `waiting-target`).
if (params.has("failed-run")) {
  const failedAt = new Date();
  failedAt.setHours(2, 0, 0, 0);
  executions.unshift({
    ...executions[0]!, executionId: "axe_failed", idempotencyKey: "schedule:automation-nightly-sweep:failed",
    scheduledFor: failedAt.getTime(), status: "failed", error: "The agent exited before it finished the report.",
    sessionId: "s_failed_run", triggerDelivery: undefined,
    createdAt: failedAt.getTime(), startedAt: failedAt.getTime(), completedAt: failedAt.getTime() + 4 * 60_000,
  });
}

// The Automations list's scenarios (#2969). `list` adds a fuller list: agents, a workflow and a
// session by name, scheduled and paused, each with its next run in this browser's own zone.
// `needs-attention` gives the first a failed last run and another an unavailable target.
const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** The next local minute matching `minute`, one of `hours` (every hour when empty) and a weekday or month day. */
function nextLocal(minute: number, hours: number[], days: { weekdays?: number[]; monthDay?: number } = {}): number {
  const now = Date.now();
  for (let offset = 0; offset < 62; offset++) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + offset);
    if (days.weekdays && !days.weekdays.includes(day.getDay())) continue;
    if (days.monthDay !== undefined && day.getDate() !== days.monthDay) continue;
    for (const hour of hours.length ? hours : Array.from({ length: 24 }, (_, index) => index)) {
      const at = new Date(day);
      at.setHours(hour, minute, 0, 0);
      if (at.getTime() > now) return at.getTime();
    }
  }
  return now + 86_400_000;
}
const listSessions: SessionView[] = [];
if (params.has("list")) {
  runner.agents.push(
    { ...runner.agents[0]!, id: "claude", name: "Claude Code", driver: "claude-code" },
    { ...runner.agents[0]!, id: "codex", name: "Codex", driver: "codex-app-server" },
  );
  if (!workflowDefinitions.some((workflow) => workflow.workflowId === "build-review")) workflowDefinitions.push({
    workflowId: "build-review", version: 1, name: "Build and Review", source: "custom", maxTransitions: 4,
    createdBy: { kind: "human", id: "e2e" }, createdAt: 1, edges: [], nodes: [],
  });
  listSessions.push({
    id: "s_release_notes", title: "Release notes for 4.2", preview: null, agentId: "claude", agentName: "Claude Code",
    driver: "claude-code", status: "idle", pendingApproval: null, runnerId: "runner-1",
  } as unknown as SessionView);
  const base = items[1]!;
  const local = (automationId: string, name: string, cron: string, enabled: boolean, action: AutomationSchedule["action"],
    nextFireAt?: number): AutomationSchedule => ({
    ...base, automationId, name, cron, timezone: viewerZone, enabled, action, ...(nextFireAt ? { nextFireAt } : {}),
  });
  const agent = (agentId: string, prompt: string): AutomationSchedule["action"] => ({
    kind: "create_session", request: { runnerId: "runner-1", workspaceId: "workspace-1", agentId, prompt, useWorktree: true },
  });
  items[0] = { ...items[0]!, timezone: viewerZone, nextFireAt: nextLocal(0, [2]) };
  items.push(
    local("automation-morning-triage", "Morning Issue Triage", "0 9 * * 1-5", true,
      agent("codex", "Triage new issues."), nextLocal(0, [9], { weekdays: [1, 2, 3, 4, 5] })),
    local("automation-health-check", "Hourly Health Check", "0 * * * *", true,
      agent("claude", "Check the build."), nextLocal(0, [])),
    local("automation-build-review", "Build and Review the Main Branch", "0 9 * * 1", true, { kind: "workflow_run", request: {
      runnerId: "runner-1", workspaceId: "workspace-1", workflowId: "build-review", task: "Build and review main.",
    } }, nextLocal(0, [9], { weekdays: [1] })),
    local("automation-release-notes", "Release Notes Follow-Up", "0 10 1 * *", false,
      { kind: "prompt_session", sessionId: "s_release_notes", request: { text: "Update the release notes." } }),
  );
  items[1] = { ...items[1]!, timezone: viewerZone };
  if (params.has("needs-attention")) {
    items[0]!.latestExecution = { status: "failed", at: Date.now() - 3_600_000 };
    items[2]!.targetHealth = { scheduledFor: Date.now() - 60_000, firstSeenAt: Date.now() - 59_000, error: targetReason };
  }
}
if (params.has("failed-run")) items[0]!.latestExecution = { status: "failed", at: executions[0]!.completedAt! };
if (params.has("list-empty")) items.length = 0;

// Run History (#2970). `run-history` gives the first automation a fuller history relative to now: a
// signed delivery, a scheduled success, a failure with runner receipts and a retry, a skip, an
// expiry, a workflow run, a legacy run and eight older successes, so Show More has five more to add.
// `no-runs` has none, with its next run tomorrow at 2:00 AM in this browser's zone.
if (params.has("run-history")) {
  /** 2:00 AM local, `days` before the last 2:00 AM that is at least an hour ago. */
  const lastTwo = new Date(Date.now() - 3_600_000);
  if (lastTwo.getHours() < 2) lastTwo.setDate(lastTwo.getDate() - 1);
  lastTwo.setHours(2, 0, 0, 0);
  const twoAm = (days: number) => lastTwo.getTime() - days * 86_400_000;
  const minutes = 60_000;
  const base = executions[0]!;
  const scheduled = (executionId: string, at: number, overrides: Partial<AutomationExecution> = {}): AutomationExecution => ({
    ...base, executionId, idempotencyKey: `schedule:automation-nightly-sweep:${new Date(at).toISOString()}`,
    actor: { kind: "system", id: "automation:automation-nightly-sweep" }, triggerDelivery: undefined,
    scheduledFor: at, createdAt: at, startedAt: at + 4_000, completedAt: at + 4 * minutes + 6_000,
    sessionId: `s_${executionId}`, runnerId: "runner-1", ...overrides,
  });
  const signedAt = Date.now() - 40 * minutes;
  executions.splice(0, executions.length,
    { ...base, executionId: "axe_signed", scheduledFor: signedAt, createdAt: signedAt, startedAt: signedAt + 2_000,
      completedAt: signedAt + 90_000, runnerId: "runner-1", actor: { kind: "policy", id: "webhook:atr_issue_intake" } },
    scheduled("axe_scheduled", twoAm(0)),
    scheduled("axe_failed", twoAm(1), {
      status: "failed", completedAt: twoAm(1) + 12 * minutes,
      error: "The agent exited before it finished the report. Exit status 1 from claude.\nTraceback: provider stream closed",
      commands: [
        { commandId: "cmd_start_1", executionId: "axe_failed", ordinal: 0, runnerId: "runner-1", sessionId: "s_axe_failed",
          kind: "start_session", state: "rejected", supersededBy: "cmd_start_2", revision: 3, attemptCount: 1,
          lastError: "provider exited: rate limited. Retrying with a new command.", createdAt: twoAm(1), updatedAt: twoAm(1) },
        { commandId: "cmd_start_2", executionId: "axe_failed", ordinal: 1, runnerId: "runner-1", sessionId: "s_axe_failed",
          kind: "start_session", state: "completed", revision: 4, attemptCount: 2, createdAt: twoAm(1), updatedAt: twoAm(1) },
        { commandId: "cmd_prompt_1", executionId: "axe_failed", ordinal: 2, runnerId: "runner-1", sessionId: "s_axe_failed",
          kind: "prompt_session", state: "rejected", revision: 2, attemptCount: 2,
          lastError: "the session refused the prompt. It was busy with another turn.", createdAt: twoAm(1), updatedAt: twoAm(1) },
      ],
    }),
    scheduled("axe_skipped", twoAm(2), { status: "skipped", startedAt: undefined, completedAt: undefined,
      sessionId: undefined, runnerId: undefined, error: "execution 'axe_failed' is still active" }),
    scheduled("axe_expired", twoAm(3), { status: "expired", startedAt: undefined, completedAt: twoAm(3) + 60 * minutes,
      sessionId: undefined, runnerId: undefined, error: AUTOMATION_TARGET_UNAVAILABLE }),
    scheduled("axe_workflow", twoAm(4), { actionKind: "workflow_run", sessionId: undefined, runId: "run_build_review",
      completedAt: twoAm(4) + 65 * minutes }),
    scheduled("axe_legacy", twoAm(5), { deliveryMode: "legacy_at_most_once" }),
    ...Array.from({ length: 8 }, (_, index) => scheduled(`axe_older_${index}`, twoAm(6 + index))),
  );
}
if (params.has("no-runs")) {
  executions.length = 0;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(2, 0, 0, 0);
  items[0] = { ...items[0]!, nextFireAt: tomorrow.getTime() };
}

// Outbound Events (#2973): a healthy subscription for a project and a failing one for an automation,
// paused after its bounded attempts, with deliveries relative to now so retries read in words.
// `outbound-empty` has none; `outbound-loading` never answers.
const outboundNow = Date.now();
const outboundProjects: ProjectView[] = [{
  id: "project-acme", name: "acme-storefront", hidden: false, locations: [],
  activeSessionCount: 0, unarchivedSessionCount: 0, totalSessionCount: 0, createdAt: outboundNow, updatedAt: outboundNow,
}];
const outboundSubscriptions: OutboundEventSubscriptionView[] = params.has("outbound-empty") ? [] : [{
  subscriptionId: "oes_storefront",
  callbackUrl: "https://hooks.acme.dev/wollipog/events?key=e2e",
  scope: { kind: "project", projectId: "project-acme" },
  eventKinds: ["session.completed", "session.failed", "pull_request.merged", "checks.failed"],
  includeSessionName: true,
  includeQuestionTitle: false,
  state: "active",
  generation: 1,
  createdBy: { kind: "human", id: "e2e" },
  createdAt: outboundNow - 3 * 86_400_000,
  updatedAt: outboundNow - 4 * 60_000,
  lastDeliveredAt: outboundNow - 4 * 60_000,
}, {
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
  createdAt: outboundNow - 86_400_000,
  updatedAt: outboundNow - 3 * 60_000,
}];

const outboundDeliveries: Record<string, OutboundEventDeliveryView[]> = {
  oes_storefront: [{
    deliveryId: "oed_storefront_merged",
    subscriptionId: "oes_storefront",
    eventId: "oev_storefront_merged",
    kind: "pull_request.merged",
    status: "delivered",
    attemptCount: 1,
    statusCode: 204,
    createdAt: outboundNow - 4 * 60_000,
    updatedAt: outboundNow - 4 * 60_000,
    lastAttemptAt: outboundNow - 4 * 60_000,
  }, {
    deliveryId: "oed_storefront_completed",
    subscriptionId: "oes_storefront",
    eventId: "oev_storefront_completed",
    kind: "session.completed",
    status: "delivered",
    attemptCount: 2,
    statusCode: 200,
    createdAt: outboundNow - 40 * 60_000,
    updatedAt: outboundNow - 39 * 60_000,
    lastAttemptAt: outboundNow - 39 * 60_000,
  }],
  oes_release_events: [{
    deliveryId: "oed_checks_failed",
    subscriptionId: "oes_release_events",
    eventId: "oev_checks_failed",
    kind: "checks.failed",
    status: "retrying",
    attemptCount: 2,
    statusCode: 500,
    error: "Callback returned 500",
    createdAt: outboundNow - 5 * 60_000,
    updatedAt: outboundNow - 3 * 60_000,
    lastAttemptAt: outboundNow - 3 * 60_000,
    nextRetryAt: outboundNow + 6 * 60_000 + 20_000,
  }, {
    deliveryId: "oed_release_created",
    subscriptionId: "oes_release_events",
    eventId: "oev_release_created",
    kind: "session.created",
    status: "failed",
    attemptCount: 6,
    error: "connect ECONNREFUSED 203.0.113.7:443",
    createdAt: outboundNow - 50 * 60_000,
    updatedAt: outboundNow - 8 * 60_000,
    lastAttemptAt: outboundNow - 8 * 60_000,
  }, {
    deliveryId: "oed_release_opened",
    subscriptionId: "oes_release_events",
    eventId: "oev_release_opened",
    kind: "pull_request.opened",
    status: "delivered",
    attemptCount: 1,
    statusCode: 202,
    createdAt: outboundNow - 2 * 3_600_000,
    updatedAt: outboundNow - 2 * 3_600_000,
    lastAttemptAt: outboundNow - 2 * 3_600_000,
  }],
};
const outboundSecret = `wollipogwhsec_${"e2eSigningSecret".repeat(3)}`;

const fixtureRunners = () => [runner, ...(alternateRunner ? [alternateRunner] : []),
  ...(workflowSwitchRunner ? [workflowSwitchRunner] : []), ...(offlineRunner ? [offlineRunner] : [])];
let liveSocket: FixtureSocket | null = null;
/** Set by `automationsDisconnect()`: the connection drops and stays down. */
let disconnected = false;

class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    liveSocket = this;
    window.setTimeout(() => {
      if (disconnected) {
        this.onclose?.({ code: 1006 });
        return;
      }
      this.onopen?.();
      this.pushRunners();
    }, 0);
  }
  pushRunners(): void {
    this.push({
      type: "snapshot",
      capabilities: {
        sessionSubscriptions: false,
        boundedDelivery: false,
        paginatedSessionHistory: false,
        projects: false,
      },
      runners: fixtureRunners(),
      boxes: [],
      sessions: listSessions,
      runs: [],
      pods: [],
      // A project for Outbound Events' project-scoped subscription to name; only on that tab.
      ...(params.get("route")?.startsWith("/automations/outbound") ? { projects: outboundProjects } : {}),
    });
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

// `?route=/automations/new` (or an edit route) opens the editor directly, as a reload does.
const navigation: ViewNavigation = {
  current: () => viewFromPath(params.get("route") ?? "/automations") ?? { name: "automations" },
  push() {},
  listen: () => () => {},
};

/** The list, an automation's page, or the editor, as App routes them. */
function AutomationsRoute() {
  const view = useStoreSelector((state) => state.view);
  if (view.name === "automation") return <AutomationDetail key={view.id} automationId={view.id} />;
  return view.name === "automations" && view.editor
    ? <AutomationEditor key={viewPath(view)} route={view.editor} />
    : <AutomationsView />;
}

// Reconnecting (#2969): the live connection drops after the list has loaded, and stays down.
Object.assign(window, { automationsDisconnect: () => {
  disconnected = true;
  liveSocket?.onclose?.({ code: 1006 });
} });

// Rediscovery while an editor is open: another installation becomes selected on every Machine.
if (params.has("rediscover")) Object.assign(window, { automationsRediscover: () => {
  for (const agent of fixtureRunners().flatMap((machine) => machine.agents)) {
    if (agent.installation) agent.installation = { ...agent.installation, selection: "other" };
  }
  liveSocket?.pushRunners();
} });

// Opt-in fault injection for recovery tests; ordinary fixture scenarios keep their API behavior.
const pollingFixture = params.has("polling-recovery") ? {
  failure: null as "list" | "detail" | "trigger" | "workflow" | null,
  failRefreshAfterMutation: false,
  mutationCalls: 0,
  mutationFailure: false,
  holdTriggers: false,
  pendingTriggers: [] as Array<() => void>,
  listCalls: 0,
  detailCalls: 0,
  release() { this.pendingTriggers.splice(0).forEach((resolve) => resolve()); },
} : null;
if (pollingFixture) Object.assign(window, { automationPollingFixture: pollingFixture });

const client = {
  ...api,
  automations: async () => {
    if (pollingFixture) pollingFixture.listCalls++;
    if (pollingFixture?.failure === "list") throw new Error("Synthetic polling failure");
    // `list-loading` never answers; `list-error` always fails (#2969).
    if (params.has("list-loading")) return new Promise<never>(() => {});
    if (params.has("list-error")) throw new ApiError("GET /api/automations failed: 503 Service Unavailable", 503);
    // A new array per read, as the control plane sends.
    return { automations: [...items] };
  },
  automation: async (id: string) => {
    if (pollingFixture) pollingFixture.detailCalls++;
    if (pollingFixture?.failure === "detail") throw new Error("Synthetic polling failure");
    const automation = items.find((item) => item.automationId === id);
    if (!automation) throw new ApiError("automation not found", 404);
    return { automation, executions: id === "automation-nightly-sweep" ? executions : [], events: [] };
  },
  deleteAutomation: async (id: string) => {
    items.splice(items.findIndex((item) => item.automationId === id), 1);
    return { deleted: true };
  },
  automationTriggers: async (id: string) => {
    if (pollingFixture?.holdTriggers) {
      await new Promise<void>((resolve) => { pollingFixture.pendingTriggers.push(resolve); });
    }
    if (pollingFixture?.failure === "trigger") throw new Error("Synthetic polling failure");
    return { triggers: id === "automation-nightly-sweep" ? triggerItems : [] };
  },
  ...(pollingFixture ? { updateAutomation: async (id: string, spec: AutomationSpec) => {
    pollingFixture.mutationCalls++;
    if (pollingFixture.mutationFailure) throw new Error("Synthetic Pause failure");
    const index = items.findIndex((item) => item.automationId === id);
    items[index] = { ...items[index]!, ...spec };
    if (pollingFixture.failRefreshAfterMutation) pollingFixture.failure = "detail";
    return items[index]!;
  } } : {}),
  // `list`: the Enabled switch saves, and a resumed automation is scheduled again.
  ...(params.has("list") && !pollingFixture ? { updateAutomation: async (id: string, spec: AutomationSpec) => {
    const index = items.findIndex((item) => item.automationId === id);
    items[index] = { ...items[index]!, ...spec, nextFireAt: spec.enabled ? Date.now() + 3_600_000 : undefined };
    return items[index]!;
  } } : {}),
  // `save-error`: the control plane refuses every save, with a reason no field owns.
  ...(params.has("save-error") ? Object.fromEntries((["createAutomation", "updateAutomation"] as const).map((name) => [name,
    async () => {
      throw new ApiError("automation target \"runner-1/workspace-1/agent-1\" cannot honor config: " +
        "permission mode plan is not advertised by this agent", 400);
    }])) : {}),
  outboundEventSubscriptions: async () => {
    if (params.has("outbound-loading")) return new Promise<never>(() => {});
    return [...outboundSubscriptions];
  },
  outboundEventDeliveries: async (subscriptionId: string) => outboundDeliveries[subscriptionId] ?? [],
  createOutboundEventSubscription: async (request: CreateOutboundEventSubscriptionRequest) => {
    const subscription: OutboundEventSubscriptionView = {
      subscriptionId: `oes_created_${outboundSubscriptions.length}`,
      callbackUrl: request.callbackUrl,
      scope: request.scope,
      eventKinds: request.eventKinds,
      includeSessionName: request.includeSessionName === true,
      includeQuestionTitle: request.includeQuestionTitle === true,
      state: "active",
      generation: 1,
      createdBy: { kind: "human", id: "e2e" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    outboundSubscriptions.unshift(subscription);
    return { subscription, secret: outboundSecret };
  },
  rotateOutboundEventSubscription: async (subscriptionId: string) => ({
    subscription: outboundSubscriptions.find((subscription) => subscription.subscriptionId === subscriptionId)!,
    secret: outboundSecret,
  }),
  resumeOutboundEventSubscription: async (subscriptionId: string) => {
    const index = outboundSubscriptions.findIndex((subscription) => subscription.subscriptionId === subscriptionId);
    const { pauseReason: _pauseReason, ...rest } = outboundSubscriptions[index]!;
    outboundSubscriptions[index] = { ...rest, state: "active" };
    return outboundSubscriptions[index]!;
  },
  deleteOutboundEventSubscription: async (subscriptionId: string) => {
    outboundSubscriptions.splice(outboundSubscriptions.findIndex((subscription) => subscription.subscriptionId === subscriptionId), 1);
    return { revoked: true };
  },
  workflowDefinitions: async () => {
    if (pollingFixture?.failure === "workflow") throw new Error("Synthetic post-mutation refresh failure");
    return workflowDefinitions;
  },
} as unknown as ApiClient;

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <React.StrictMode>
    <ApiProvider client={client}>
      <FeedbackProvider>
        <StoreProvider connection={connection} navigation={navigation}>
          <main className="main-pane"><AutomationsRoute /></main>
        </StoreProvider>
      </FeedbackProvider>
    </ApiProvider>
  </React.StrictMode>,
);
