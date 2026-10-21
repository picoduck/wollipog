import React from "react";
import { createRoot } from "react-dom/client";
import type {
  ControlPlaneToUi,
  PodContextEntry,
  PodReconciliation,
  PodView,
  RelayPodRequest,
  RelayPodResult,
  SessionEvent,
  SessionEventsResponse,
  SessionView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { viewFromPath, viewPath, type View, type ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { PodDetail } from "../components/PodsView.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { ViewerIdentityContext, type ViewerIdentity } from "../resolver-identity.js";
import "../styles.css";

/**
 * A pod's page (#2981) in a real browser, for its geometry spec and screenshots. The page's address
 * carries the app's own pod route query (`?tab=huddle` or `?member=<sessionId>`), so choosing a
 * phone tab rewrites it and a reload keeps it. `?scenario=manual|turns|error|closed` picks the pod:
 * idle and open, automatic turns running, a relay that misses one member, or closed with Recent
 * Merges. `?members=4` adds a second worker (#2983's one-line heads), and `?candidates=none` leaves
 * no session that Add Member… could offer. `?theme=light|dark`. A 64px spacer stands in for the
 * desktop rail.
 */
const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.setAttribute("data-theme", theme);
const scenario = params.get("scenario") ?? "manual";
const fourMembers = params.get("members") === "4";
const withCandidates = params.get("candidates") !== "none";

const NOW = Date.now();
const MINUTE = 60_000;

function member(id: string, agentId: string, agentName: string, driver: SessionView["driver"], title: string, status: SessionView["status"]): SessionView {
  return {
    id, runnerId: "runner-1", workspaceId: "ws-wollipog", workspaceName: "Wollipog", projectId: null, agentId, agentName,
    title, status, column: "review", runId: null, useWorktree: true, worktreePath: `/worktrees/${id}`, archived: false,
    createdAt: NOW - 40 * MINUTE, updatedAt: NOW, lastEventAt: null, messageCount: 12, eventEpoch: 0, preview: null,
    pendingApproval: null, driver, model: null, effort: null, permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0,
    adopted: false,
  } as SessionView;
}

const sessions = [
  member("s-lead", "claude", "Claude Code", "claude-code", "Lead: plan the retry migration", "idle"),
  member("s-worker", "codex", "Codex", "codex-app-server", "Worker: migrate the call sites", scenario === "turns" ? "running" : "idle"),
  member("s-reviewer", "opencode", "OpenCode", "acp", "Reviewer: check the migrated sites", "idle"),
  ...(fourMembers ? [member("s-worker-2", "gemini", "Gemini", "acp", "Worker: update the retry tests", "idle")] : []),
];

/** Sessions with their own worktree in no pod, which Add Member… offers. */
const candidates = withCandidates ? [
  { ...member("s-docs", "claude", "Claude Code", "claude-code", "Document the retry helper", "idle"), updatedAt: NOW - MINUTE },
  { ...member("s-flaky", "codex", "Codex", "codex-app-server", "Fix the flaky upload test", "idle"), updatedAt: NOW - 2 * MINUTE },
  { ...member("s-timeouts", "opencode", "OpenCode", "acp", "Audit the request timeouts", "running"), updatedAt: NOW - 3 * MINUTE },
] : [];

const reconciliations: PodReconciliation[] = scenario === "closed" ? [
  {
    reconciliationId: "merge-2", podId: "pod-1", sourceSessionId: "s-worker", targetSessionId: "s-lead", actorId: "local",
    status: "conflicted", sourceHead: "9f1c2a7b3d4e5f60", targetHead: "1a2b3c4d5e6f7081", mergeBase: "0f0e0d0c0b0a0908",
    conflictPaths: ["src/api/client.ts", "src/api/retry.ts"], createdAt: NOW - 50 * MINUTE, completedAt: NOW - 49 * MINUTE,
  },
  {
    reconciliationId: "merge-1", podId: "pod-1", sourceSessionId: "s-reviewer", targetSessionId: "s-lead", actorId: "local",
    status: "applied", sourceHead: "abcdefabcdef1234", targetHead: "1234abcdabcd5678", resultHead: "5eed5eed5eed5eed",
    mergeBase: "0f0e0d0c0b0a0908", createdAt: NOW - 90 * MINUTE, completedAt: NOW - 89 * MINUTE,
  },
] : [];

const pod: PodView = {
  id: "pod-1",
  title: "Retry Helper Migration",
  objective: "Move every API call site to the shared retry helper, keep the existing timeouts, and agree on one error message for exhausted retries before the reviewer signs off.",
  status: scenario === "closed" ? "closed" : "active",
  members: sessions.map((session, index) => ({
    sessionId: session.id, joinedAt: NOW - 40 * MINUTE, role: index === 0 ? "lead" : index === 2 ? "reviewer" : "worker",
    contextTokenBudget: null, lastContextSeq: 0,
  })),
  orchestration: {
    policy: { mode: scenario === "turns" ? "round_robin" : "manual", contextTokenBudget: 8_192, summaryTokenBudget: 512, maxTurns: 12, maxRepeatedOutputs: 2 },
    state: scenario === "turns"
      ? { status: "running", runId: "pod-run-1", turnsUsed: 3, currentSessionId: "s-worker", startedAt: NOW - 6 * MINUTE, updatedAt: NOW - MINUTE }
      : { status: "idle", turnsUsed: 0, updatedAt: NOW - 30 * MINUTE },
  },
  reconciliations,
  createdAt: NOW - 40 * MINUTE,
  updatedAt: NOW - MINUTE,
};

const human = { kind: "human" as const, actorId: "local" };
const fromMember = (sessionId: string) => {
  const session = sessions.find((candidate) => candidate.id === sessionId)!;
  return { kind: "session" as const, sessionId, sessionTitle: session.title, agentLabel: session.agentName ?? "", fromSeq: 1, toSeq: 9 };
};
const entry = (seq: number, minutesAgo: number, source: PodContextEntry["source"], content: string): PodContextEntry =>
  ({ id: `entry-${seq}`, podId: pod.id, seq, ts: NOW - minutesAgo * MINUTE, source, content });

const OLDER: PodContextEntry[] = [
  entry(1, 38, human, "Kickoff: one helper for every retry, no per-call backoff tables."),
  entry(2, 36, fromMember("s-lead"), "Plan: the worker migrates src/api, the reviewer checks each site keeps its timeout."),
  entry(3, 33, human, "Keep the 30 second ceiling on uploads."),
];
const NEWER: PodContextEntry[] = [
  entry(4, 26, fromMember("s-worker"), "Migrated 14 of 17 call sites to withRetry(). The three left in src/api/uploads.ts pass their own AbortController, so they need the helper's signal option first."),
  entry(5, 21, fromMember("s-reviewer"), [
    "Checked the 14 migrated sites. Two concerns:",
    "1. fetchProjects() lost its 10 second timeout; withRetry() defaults to 30 seconds.",
    "2. The exhausted-retry message differs between the client (\"Request failed after retries\") and the CLI (\"Gave up after 3 attempts\").",
    "Everything else matches the old behaviour, including the jitter.",
  ].join("\n")),
  entry(6, 14, human, "Use the client's wording for exhausted retries everywhere."),
  entry(7, 9, fromMember("s-lead"), "Agreed. Worker: add the signal option, restore the 10 second timeout on fetchProjects(), then finish uploads.ts."),
];

const ANSWER = [
  "Migrated the call sites to `withRetry()`.",
  "",
  "| Site | Timeout | Retries |",
  "| --- | ---: | ---: |",
  "| fetchProjects | 10 s | 3 |",
  "| uploadArtifact | 30 s | 5 |",
  "",
  "The exhausted-retry message now reads \"Request failed after retries\" everywhere.",
].join("\n");

function timeline(sessionId: string, index: number, working: boolean): SessionEvent[] {
  let seq = 0;
  const event = (payload: Record<string, unknown>) => ({ id: seq + 1, sessionId, seq: ++seq, ts: NOW - (30 - seq) * 1_000, payload }) as SessionEvent;
  const commands = ["pnpm test", "rg -n fetchWithRetry src", "pnpm typecheck"].slice(0, 1 + index);
  return [
    event({ kind: "user_message", text: "[Manual relay from pod \"Retry Helper Migration\"]" }),
    event({ kind: "agent_message", text: "I'll read the relayed notes and pick up my part.", final: true }),
    event({ kind: "tool_call", toolCallId: `${sessionId}-read-1`, title: "Read: src/api/retry.ts", toolKind: "read", status: "completed" }),
    ...commands.map((command, step) => event({ kind: "tool_call", toolCallId: `${sessionId}-cmd-${step}`, title: `$ ${command}`, toolKind: "execute", status: "completed" })),
    event({ kind: "tool_call", toolCallId: `${sessionId}-edit-1`, title: "Edit: src/api/client.ts", toolKind: "edit", status: "completed" }),
    event({ kind: "file_edit", path: "src/api/client.ts" }),
    ...(working
      ? [event({ kind: "tool_call", toolCallId: `${sessionId}-cmd-live`, title: "$ pnpm test -- retry", toolKind: "execute", status: "in_progress" })]
      : [event({ kind: "agent_message", text: ANSWER, final: true })]),
  ];
}

const pages = new Map(sessions.map((session, index) => [session.id, timeline(session.id, index, session.status === "running")]));

const snapshot = {
  type: "snapshot",
  capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
  runners: [{
    runnerId: "runner-1", hostname: "studio-mac", displayName: "Studio Mac", os: "macos", version: "1", status: "online",
    agents: [], workspaces: [{ id: "ws-wollipog", name: "Wollipog", path: "/repo" }], connectedAt: NOW, lastSeen: NOW,
  }],
  boxes: [], projects: [], sessions: [...sessions, ...candidates], runs: [], pods: [pod],
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
  instanceId: "pod-detail-e2e",
  runtimeKey: "pod-detail-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const ROUTE_KEYS = ["member", "tab"];

/** The fixture's own query (scenario, theme) rides along; the app's route owns `member` and `tab`. */
function fixtureUrl(view: View): string {
  const route = new URL(viewPath(view), window.location.origin);
  const query = new URLSearchParams(window.location.search);
  for (const key of ROUTE_KEYS) query.delete(key);
  for (const [key, value] of route.searchParams) query.set(key, value);
  return `${window.location.pathname}?${query.toString()}`;
}

const navigation: ViewNavigation = {
  current: () => {
    const query = new URLSearchParams(window.location.search);
    const routeQuery = new URLSearchParams(ROUTE_KEYS.flatMap((key) => query.has(key) ? [[key, query.get(key)!]] : []));
    // The app's own parser reads the tab, as it does from a real pod address.
    const route = new URL(viewPath({ name: "pod", id: pod.id }), window.location.origin);
    return viewFromPath(route.pathname, routeQuery.size ? `?${routeQuery.toString()}` : "") ?? { name: "pod", id: pod.id };
  },
  push: (view) => { document.body.dataset.opened = JSON.stringify(view); },
  replace: (view) => { window.history.replaceState(window.history.state, "", fixtureUrl(view)); },
  listen: () => () => {},
};

let relays = 0;
const client = {
  ...api,
  getSessionEventPage: async (id: string) => {
    const events = pages.get(id) ?? [];
    return { events, eventEpoch: 0, nextAfter: events.at(-1)?.seq ?? 0, cacheComplete: true } as SessionEventsResponse;
  },
  podContext: async (_id: string, before?: number) => before === undefined
    ? { entries: NEWER, beforeSeq: NEWER[0]!.seq }
    : { entries: OLDER },
  appendPodContext: async (_id: string, body: { kind: string; text?: string }) =>
    ({ entry: entry(100 + relays++, 0, human, body.text ?? "") }),
  // Member changes answer without changing the fixture, so a capture can open each dialog again.
  updatePodMember: async () => ({ pod, sessions }),
  removePodMember: async () => ({ pod, sessions }),
  addPodMember: async () => ({ pod, sessions }),
  relayPod: async (_id: string, request: RelayPodRequest): Promise<RelayPodResult> => {
    relays += 1;
    // A relay that misses the worker the first time, and reaches it on Retry Failed.
    const miss = scenario === "error" && request.text !== undefined;
    return {
      pod, sessions: [],
      receipts: (request.sessionIds ?? []).map((sessionId) => miss && sessionId === "s-worker"
        ? { sessionId, status: "failed", error: "Studio Mac lost its connection before the relay arrived." }
        : { sessionId, status: "delivered" }),
      ...(request.text ? { appendedEntry: entry(100 + relays, 0, human, request.text) } : {}),
    };
  },
} as unknown as ApiClient;

const viewer: ViewerIdentity = { userId: "local", shared: false, names: new Map() };

function PodRoute() {
  const view = useStoreSelector((state) => state.view);
  return view.name === "pod"
    ? <PodDetail podId={view.id} member={view.member} onNewSession={() => { document.body.dataset.opened = "new-session"; }} />
    : null;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ApiProvider client={client}>
      <ViewerIdentityContext.Provider value={viewer}>
        <StoreProvider connection={connection} navigation={navigation}>
          <FeedbackProvider>
            <div className="app">
              <div className="pod-detail-e2e-rail" aria-hidden="true" />
              <main className="main">
                <div className="main-body">
                  <PodRoute />
                </div>
              </main>
            </div>
          </FeedbackProvider>
        </StoreProvider>
      </ViewerIdentityContext.Provider>
    </ApiProvider>
  </React.StrictMode>,
);
