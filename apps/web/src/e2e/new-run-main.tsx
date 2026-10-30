import React from "react";
import { createRoot } from "react-dom/client";
import type { AgentDefinition, ControlPlaneToUi, ProjectLocationView, ProjectView, RunnerView, WorkflowDefinition } from "@wollipog/protocol";
import { ApiError, api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { NewRunDialog } from "../components/NewRunDialog.js";
import "../styles.css";

/**
 * New Multi-Agent Run (#2978) in a real browser, for its geometry spec and screenshots.
 * `?scenario=default` has Build Server online with five agents across three drivers and one signed
 * out, and two projects: Wollipog (seen by the organization; a folder on Build Server and one on an
 * offline Studio Mac) and Docs Site. `error` refuses the create request; `offline` has no Machine
 * online. `?theme=light|dark`. Opening a view or closing is recorded on `document.body.dataset`.
 */
const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "default";
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

const NOW = Date.now();

const agent = (id: string, name: string, driver: AgentDefinition["driver"], overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id, name, command: id, args: [], env: {}, driver, available: true, authStatus: "authenticated", ...overrides,
});

const agents: AgentDefinition[] = [
  agent("claude", "Claude", "claude-code"),
  agent("claude-wsl", "Claude", "claude-code", { context: { kind: "wsl", distro: "Ubuntu" } }),
  agent("codex", "Codex", "codex-app-server"),
  agent("codex-wsl", "Codex", "codex-app-server", { context: { kind: "wsl", distro: "Ubuntu" } }),
  agent("gemini", "Gemini", "acp", { authStatus: undefined }),
  agent("opencode", "OpenCode", "acp", { authStatus: "unauthenticated" }),
];

const runners = [
  {
    runnerId: "runner-build-91c2", hostname: "build-box", displayName: "Build Server", status: "online", agents,
    workspaces: [
      { id: "ws-wollipog", name: "wollipog", path: "/home/dev/src/wollipog" },
      { id: "ws-docs", name: "docs-site", path: "/home/dev/src/docs-site" },
    ],
  },
  {
    runnerId: "runner-studio-7f3a", hostname: "studio.local", displayName: "Studio Mac", status: "offline", agents: [],
    workspaces: [{ id: "ws-studio", name: "wollipog", path: "/Users/dev/code/wollipog" }],
  },
].map((runner) => ({
  ...runner, os: "linux", version: "1", connectedAt: NOW, lastSeen: NOW, protocolVersion: 141,
})) as unknown as RunnerView[];

const location = (projectId: string, id: string, runnerId: string, workspaceId: string, path: string, isDefault: boolean): ProjectLocationView => ({
  id, projectId, runnerId, workspaceId, name: path.split("/").at(-1)!, path, source: "managed",
  availability: "available", isDefault, createdAt: 1, updatedAt: 1,
});

const projects: ProjectView[] = [
  {
    id: "project-wollipog", name: "Wollipog", hidden: false, audience: "organization",
    locations: [
      location("project-wollipog", "loc-build", "runner-build-91c2", "ws-wollipog", "/home/dev/src/wollipog", true),
      location("project-wollipog", "loc-studio", "runner-studio-7f3a", "ws-studio", "/Users/dev/code/wollipog", false),
    ],
    activeSessionCount: 0, unarchivedSessionCount: 0, totalSessionCount: 0, createdAt: 1, updatedAt: 1,
  },
  {
    id: "project-docs", name: "Docs Site", hidden: false, audience: "team",
    locations: [location("project-docs", "loc-docs", "runner-build-91c2", "ws-docs", "/home/dev/src/docs-site", true)],
    activeSessionCount: 0, unarchivedSessionCount: 0, totalSessionCount: 0, createdAt: 1, updatedAt: 1,
  },
];

const workflow: WorkflowDefinition = {
  workflowId: "builtin:build-review", version: 1, source: "builtin", name: "Build and independent review",
  description: "Claude builds, Codex reviews, and Claude addresses findings until accepted or capped.",
  maxTransitions: 24, createdBy: { kind: "system" }, createdAt: 1, edges: [],
  nodes: [
    { nodeId: "build", kind: "agent", role: "builder", agentId: "claude", inputs: [], outputs: [], retry: { maxAttempts: 2, backoffMs: 1_000 }, timeoutMs: 1 },
    { nodeId: "review", kind: "agent", role: "reviewer", agentId: "codex", inputs: [], outputs: [], retry: { maxAttempts: 2, backoffMs: 1_000 }, timeoutMs: 1 },
    { nodeId: "approve", kind: "human_gate", role: "approver", inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1 },
    { nodeId: "address", kind: "agent", role: "remediator", agentId: "claude", inputs: [], outputs: [], retry: { maxAttempts: 2, backoffMs: 1_000 }, timeoutMs: 1 },
  ],
};

const snapshot: ControlPlaneToUi = {
  type: "snapshot",
  capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
  runners: scenario === "offline" ? runners.map((runner) => ({ ...runner, status: "offline" })) : runners,
  boxes: [], projects, sessions: [], runs: [], pods: [],
};

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
  instanceId: "new-run-e2e",
  runtimeKey: "new-run-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "runs" }),
  push: (view) => { document.body.dataset.opened = JSON.stringify(view); },
  listen: () => () => {},
};

const refuse = () => {
  throw new ApiError("run create rejected: worktree for ws-wollipog is locked by another git process (409 Conflict)", 409);
};

const client = {
  ...api,
  workflowDefinitions: async () => [workflow],
  createRun: async () => {
    if (scenario === "error") refuse();
    return { run: { id: "run-new" }, sessions: [] };
  },
  createWorkflowRun: async () => {
    if (scenario === "error") refuse();
    return { run: { id: "run-new" }, sessions: [], instance: {} };
  },
} as unknown as ApiClient;

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <StoreProvider connection={connection} navigation={navigation}>
      <NewRunDialog onClose={() => { document.body.dataset.closed = "1"; }} />
    </StoreProvider>
  </ApiProvider>,
);
