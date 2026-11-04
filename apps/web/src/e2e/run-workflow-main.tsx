import React from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type ControlPlaneToUi,
  type RunView,
  type SessionEvent,
  type SessionEventsResponse,
  type SessionView,
  type WorkflowArtifactView,
  type WorkflowInstanceDetail,
  type WorkflowNodeDefinition,
  type WorkflowNodeState,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { RunDetail } from "../components/RunsView.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import "../styles.css";

/**
 * A workflow run's page (#2977) in a real browser, for its geometry spec and screenshots.
 * `?state=gate|ready|retry|one` picks the run: a gate awaiting your decision on the builder's patch,
 * the builder ready to start, the builder's retry delayed after a failed attempt, or a one-member
 * workflow whose builder is running. `?theme=light|dark`. A 64px spacer stands in for the desktop
 * rail. Gate decisions and dispatches answer after a beat, as a real round trip does.
 */
const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.setAttribute("data-theme", theme);
const state = params.get("state") ?? "gate";

const NOW = Date.now();
const MINUTE = 60_000;
const PROMPT = "Add exponential backoff to webhook retries, cap it at five minutes, and keep the delivery log readable. Explain how you tested the cap.";

function member(id: string, agentId: string, agentName: string, driver: SessionView["driver"], status: SessionView["status"]): SessionView {
  return {
    id, runnerId: "runner-1", workspaceId: "ws-wollipog", workspaceName: "Wollipog", projectId: null, agentId, agentName,
    // The title the control plane gives a workflow agent's member: "<run> · <agent>".
    title: `Add backoff to webhook retries · ${agentId}`, status, column: "review", runId: "run-workflow", useWorktree: true, worktreePath: null, archived: false,
    createdAt: NOW - 10 * MINUTE, updatedAt: NOW, lastEventAt: null, messageCount: 8, eventEpoch: 0, preview: null,
    pendingApproval: null, driver, model: null, effort: null, permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0,
    adopted: false, ...(status === "running" ? { activeTurnId: `${id}-turn` } : {}),
  } as SessionView;
}

const claude = member("s-claude", "claude", "Claude Code", "claude-code", state === "one" ? "running" : "idle");
const codex = member("s-codex", "codex", "Codex", "codex-app-server", "idle");
const members = state === "one" ? [claude] : [claude, codex];

const agentNode = (nodeId: string, role: string, agentId: string, extra: Partial<WorkflowNodeDefinition>): WorkflowNodeDefinition => ({
  nodeId, kind: "agent", role, agentId, inputs: [], outputs: [], retry: { maxAttempts: 3, backoffMs: 4 * MINUTE }, timeoutMs: 3_600_000, ...extra,
});
const BUILD = agentNode("build", "builder", "claude", { outputs: [{ name: "implementation_patch", kind: "patch" }] });
const NODES: WorkflowNodeDefinition[] = state === "one" ? [BUILD] : [
  BUILD,
  {
    nodeId: "approve", kind: "human_gate", role: "approver", inputs: [{ name: "implementation_patch", kind: "patch" }],
    outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 3_600_000,
  },
  agentNode("review", "reviewer", "codex", {
    inputs: [{ name: "implementation_patch", kind: "patch" }],
    outputs: [{ name: "review_report", kind: "review_report" }, { name: "review_verdict", kind: "verdict" }],
  }),
];

const STATES: Record<string, Partial<Record<string, Partial<WorkflowNodeState>>>> = {
  gate: {
    build: { status: "succeeded", attemptCount: 1, sessionId: claude.id, outcome: "success", completedAt: NOW - 2 * MINUTE },
    approve: { status: "waiting_gate" },
  },
  ready: { build: { status: "ready" } },
  retry: {
    build: { status: "ready", attemptCount: 1, sessionId: claude.id, readyAt: NOW + 4 * MINUTE, error: "The agent stopped before it published a patch artifact." },
  },
  one: { build: { status: "running", attemptCount: 1, sessionId: claude.id, startedAt: NOW - 3 * MINUTE } },
};

let detail: WorkflowInstanceDetail = {
  instanceId: "wfi-1", workflowId: "wf-build-approve-review", workflowVersion: 2, runId: "run-workflow",
  status: state === "gate" ? "waiting_gate" : "running", transitionCount: state === "gate" ? 2 : 1,
  createdBy: { kind: "human", id: "local" }, createdAt: NOW - 12 * MINUTE, updatedAt: NOW, events: [],
  attempts: state === "gate" || state === "one"
    ? [{ attemptId: "a1", instanceId: "wfi-1", nodeId: "build", attempt: 1, status: state === "one" ? "running" : "succeeded", dispatchKey: "k1", sessionId: claude.id, startedAt: NOW - 9 * MINUTE, deadlineAt: NOW + 50 * MINUTE }]
    : state === "retry"
      ? [{ attemptId: "a1", instanceId: "wfi-1", nodeId: "build", attempt: 1, status: "failed", dispatchKey: "k1", sessionId: claude.id, startedAt: NOW - 9 * MINUTE, deadlineAt: NOW + 50 * MINUTE, completedAt: NOW - 20_000, error: "The agent stopped before it published a patch artifact." }]
      : [],
  nodeStates: NODES.map((node) => ({ nodeId: node.nodeId, status: "pending", attemptCount: 0, ...STATES[state]?.[node.nodeId] })),
  definition: {
    workflowId: "wf-build-approve-review", version: 2, source: "custom", name: "Build, Approve and Review", maxTransitions: 24,
    nodes: NODES,
    edges: [
      { edgeId: "e1", from: "build", to: "approve", on: "success" },
      { edgeId: "e2", from: "approve", to: "review", on: "success" },
    ],
    createdBy: { kind: "human", id: "local" }, createdAt: NOW - 30 * MINUTE,
  },
};

const PATCH = [
  "diff --git a/apps/control-plane/src/webhooks.ts b/apps/control-plane/src/webhooks.ts",
  "--- a/apps/control-plane/src/webhooks.ts",
  "+++ b/apps/control-plane/src/webhooks.ts",
  "@@ -40,7 +40,9 @@ export function nextRetryDelay(attempt: number): number {",
  "-  return 30_000;",
  "+  const delay = 1_000 * 2 ** attempt;",
  "+  return Math.min(delay, 5 * 60_000);",
  " }",
].join("\n");
const artifacts: WorkflowArtifactView[] = state === "gate" ? [{
  artifactId: "art-patch", runId: "run-workflow", sessionId: claude.id, kind: "patch", name: "webhook-backoff.patch",
  mimeType: "text/x-diff", encoding: "utf8", sizeBytes: new TextEncoder().encode(PATCH).length, sha256: "0".repeat(64),
  createdBy: { kind: "agent", id: claude.id }, createdAt: NOW - 2 * MINUTE,
}] : [];

const run: RunView = {
  id: "run-workflow", title: "Add backoff to webhook retries", prompt: PROMPT, workspaceId: "ws-wollipog", workspaceName: "Wollipog",
  createdAt: NOW - 12 * MINUTE, updatedAt: NOW, sessionIds: members.map((session) => session.id),
};

function timeline(sessionId: string, working: boolean): SessionEvent[] {
  let seq = 0;
  const event = (payload: Record<string, unknown>) => ({ id: seq + 1, sessionId, seq: ++seq, ts: NOW - (30 - seq) * 1_000, payload }) as SessionEvent;
  return [
    event({ kind: "user_message", text: PROMPT }),
    event({ kind: "agent_message", text: "I'll start with how retries are scheduled today.", final: true }),
    event({ kind: "tool_call", toolCallId: `${sessionId}-read-1`, title: "Read: apps/control-plane/src/webhooks.ts", toolKind: "read", status: "completed" }),
    event({ kind: "tool_call", toolCallId: `${sessionId}-cmd-1`, title: "$ rg -n nextRetryDelay apps", toolKind: "execute", status: "completed" }),
    event({ kind: "tool_call", toolCallId: `${sessionId}-edit-1`, title: "Edit: apps/control-plane/src/webhooks.ts", toolKind: "edit", status: "completed" }),
    event({ kind: "file_edit", path: "apps/control-plane/src/webhooks.ts" }),
    ...(working
      ? [event({ kind: "tool_call", toolCallId: `${sessionId}-cmd-live`, title: "$ pnpm test -- webhooks", toolKind: "execute", status: "in_progress" })]
      : [event({ kind: "agent_message", text: "Retries now back off from one second, doubling each attempt, and never wait longer than five minutes. The new test walks ten attempts and checks the cap.", final: true })]),
  ];
}
const pages = new Map(members.map((session) => [session.id, session.id === claude.id && state !== "ready" ? timeline(session.id, state === "one") : []]));

const snapshot = {
  type: "snapshot",
  capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
  runners: [{
    runnerId: "runner-1", hostname: "studio-mac", displayName: "Studio Mac", os: "macos", version: "1", status: "online", protocolVersion: PROTOCOL_VERSION,
    agents: [], workspaces: [{ id: "ws-wollipog", name: "Wollipog", path: "/repo" }], connectedAt: NOW, lastSeen: NOW,
  }],
  boxes: [], projects: [], sessions: members, runs: [run], pods: [],
} as ControlPlaneToUi;

class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify(snapshot) });
    }, 0);
  }
  send() {}
  close() {}
}

const connection: UiConnectionRuntime = {
  instanceId: "run-workflow-e2e",
  runtimeKey: "run-workflow-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "run", id: run.id }),
  push: (view) => { document.body.dataset.opened = JSON.stringify(view); },
  replace: () => {},
  listen: () => () => {},
};

const beat = () => new Promise((resolve) => setTimeout(resolve, 150));
const client = {
  ...api,
  workflowInstances: async () => [detail],
  workflowInstance: async () => detail,
  workflowDefinitions: async () => [detail.definition],
  runWorkflowArtifacts: async () => ({ artifacts }),
  artifactExport: async () => new Blob([PATCH], { type: "text/x-diff" }),
  getSessionEventPage: async (id: string) => {
    const events = pages.get(id) ?? [];
    return { events, eventEpoch: 0, nextAfter: events.at(-1)?.seq ?? 0, cacheComplete: true } as SessionEventsResponse;
  },
  resolveWorkflowGate: async (_instanceId: string, nodeId: string, outcome: "success" | "failure") => {
    await beat();
    detail = {
      ...detail, updatedAt: detail.updatedAt + 1, status: outcome === "success" ? "running" : "failed",
      nodeStates: detail.nodeStates.map((node) => node.nodeId === nodeId
        ? { ...node, status: outcome === "success" ? "succeeded" : "failed", outcome }
        : node.nodeId === "review" && outcome === "success" ? { ...node, status: "ready" } : node),
    };
    document.body.dataset.resolved = `${nodeId}:${outcome}`;
    return detail;
  },
  dispatchWorkflowNode: async (_instanceId: string, nodeId: string) => {
    await beat();
    document.body.dataset.dispatched = nodeId;
    return {};
  },
} as unknown as ApiClient;

function RunRoute() {
  const view = useStoreSelector((current) => current.view);
  return view.name === "run" ? <RunDetail runId={view.id} /> : null;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ApiProvider client={client}>
      <StoreProvider connection={connection} navigation={navigation}>
        <FeedbackProvider>
          <div className="app">
            <div className="run-workflow-e2e-rail" aria-hidden="true" />
            <main className="main">
              <div className="main-body">
                <RunRoute />
              </div>
            </main>
          </div>
        </FeedbackProvider>
      </StoreProvider>
    </ApiProvider>
  </React.StrictMode>,
);
