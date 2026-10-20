import React from "react";
import { createRoot } from "react-dom/client";
import type { ControlPlaneToUi, PodView, ProjectView, RunnerView, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { NewPodDialog } from "../components/NewPodDialog.js";
import "../styles.css";

/**
 * New Pod (#2982) in a real browser, for its geometry spec and screenshots. `?scenario=default`
 * lists twelve eligible sessions across two Machines and two projects, one still starting its
 * worktree; `error` lists the same and refuses Create Pod; `empty` has only sessions that cannot
 * join. `?theme=light|dark`. Opening a pod or New Session is recorded on `document.body.dataset`.
 */
const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "default";
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

const NOW = Date.now();
const MINUTE = 60_000;

const runners = [
  { runnerId: "runner-studio-7f3a", hostname: "studio.local", displayName: "Studio Mac" },
  { runnerId: "runner-build-91c2", hostname: "build-box", displayName: "Build Box" },
].map((runner) => ({
  ...runner, os: "linux", version: "1", status: "online", agents: [], workspaces: [], connectedAt: NOW, lastSeen: NOW,
  protocolVersion: 141,
})) as unknown as RunnerView[];

const projects = [
  { id: "project-wollipog", name: "Wollipog" },
  { id: "project-site", name: "Marketing Site" },
] as unknown as ProjectView[];

const AGENTS = {
  claude: ["claude", "Claude Code", "claude-code"],
  codex: ["codex", "Codex", "codex-app-server"],
  opencode: ["opencode", "OpenCode", "acp"],
} as const;

function session(
  id: string, title: string, agent: keyof typeof AGENTS, minutesAgo: number,
  overrides: Partial<SessionView> = {},
): SessionView {
  const [agentId, agentName, driver] = AGENTS[agent];
  return {
    id, runnerId: "runner-studio-7f3a", workspaceId: null, workspaceName: null, projectId: "project-wollipog", agentId,
    agentName, title, status: "idle", column: "review", runId: null, useWorktree: true, worktreePath: `/worktrees/${id}`,
    archived: false, createdAt: NOW - (minutesAgo + 30) * MINUTE, updatedAt: NOW - minutesAgo * MINUTE, lastEventAt: null,
    messageCount: 8, eventEpoch: 0, preview: null, pendingApproval: null, driver, model: null, effort: null,
    permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
    ...overrides,
  } as SessionView;
}

const build = { runnerId: "runner-build-91c2" };
const site = { projectId: "project-site" };
const eligible = [
  session("s-plan", "Plan the retry helper migration", "claude", 2),
  session("s-migrate", "Migrate the API call sites to withRetry()", "codex", 4),
  session("s-review", "Review the migrated call sites", "opencode", 6, { ...build, worktreePath: undefined }),
  session("s-migrate-2", "Migrate the API call sites to withRetry()", "claude", 9, build),
  session("s-uploads", "Add an abort signal to the uploads client", "codex", 13),
  session("s-timeouts", "Restore the fetchProjects timeout", "opencode", 18, build),
  session("s-hero", "Rewrite the pricing page hero", "claude", 25, site),
  session("s-faq", "Answer the top ten support questions in the FAQ", "codex", 31, site),
  session("s-errors", "Unify the exhausted-retry error message", "claude", 40),
  session("s-docs", "Document the retry helper in the API guide", "opencode", 52, site),
  session("s-flaky", "Find the flaky upload test", "codex", 66, build),
  session("s-bench", "Benchmark retry jitter against the old tables", "claude", 80, build),
];
const ineligible = [
  session("x-chat", "Chat about release notes", "claude", 3, { useWorktree: false, worktreePath: undefined }),
  session("x-done", "Ship the settings export", "codex", 7, { status: "completed" }),
  session("x-member-1", "Lead: plan the onboarding tour", "claude", 8),
  session("x-member-2", "Worker: build the tour steps", "codex", 8),
];
const pods: PodView[] = [{
  id: "pod-tour", title: "Onboarding Tour", objective: "", status: "active", createdAt: NOW - 60 * MINUTE, updatedAt: NOW,
  members: ["x-member-1", "x-member-2"].map((sessionId) => ({ sessionId, joinedAt: NOW, role: "worker", contextTokenBudget: null, lastContextSeq: 0 })),
}];

const snapshot: ControlPlaneToUi = {
  type: "snapshot",
  capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
  runners, boxes: [], projects, runs: [], pods,
  sessions: scenario === "empty" ? ineligible : [...eligible, ...ineligible],
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
  instanceId: "new-pod-e2e",
  runtimeKey: "new-pod-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "pods" }),
  push: (view) => { document.body.dataset.opened = JSON.stringify(view); },
  listen: () => () => {},
};

const client = {
  ...api,
  createPod: async () => {
    if (scenario === "error") {
      throw new Error("pod create rejected: session s-migrate is already a member of pod pod-tour (409 Conflict)");
    }
    return { pod: { ...pods[0]!, id: "pod-new" } };
  },
} as unknown as ApiClient;

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <StoreProvider connection={connection} navigation={navigation}>
      <NewPodDialog
        onClose={() => { document.body.dataset.closed = "1"; }}
        onNewSession={() => { document.body.dataset.newSession = "1"; }}
      />
    </StoreProvider>
  </ApiProvider>,
);
