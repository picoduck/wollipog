import React from "react";
import { createRoot } from "react-dom/client";
import type { ControlPlaneToUi, RunView, SessionEvent, SessionEventsResponse, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { viewFromPath, viewPath, type View, type ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { RunDetail } from "../components/RunsView.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import "../styles.css";

/**
 * A comparison run's page (#2975) in a real browser, for its geometry spec and screenshots. The
 * page's address is the app's own run route (`/runs/~<id>?member=<sessionId>` after the fixture's
 * file name), so choosing a phone member tab rewrites it and a reload keeps it.
 * `?run=three|four|running` picks the run: three finished agents, four finished agents, or three with
 * one still working. `?theme=light|dark`. A 64px spacer stands in for the desktop rail.
 */
const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.setAttribute("data-theme", theme);
const runKey = params.get("run") ?? "three";

const NOW = Date.now();
const MINUTE = 60_000;
const PROMPT = "Make session search find a session by any word in its transcript, across every machine and project, without slowing down the Sessions list. Keep the existing search box, rank exact title matches first, and explain the trade-offs you made in your final answer.";

function member(id: string, agentId: string, agentName: string, driver: SessionView["driver"], status: SessionView["status"]): SessionView {
  return {
    id, runnerId: "runner-1", workspaceId: "ws-wollipog", workspaceName: "Wollipog", projectId: null, agentId, agentName,
    title: agentName, status, column: "review", runId: `run-${runKey}`, useWorktree: true, worktreePath: null, archived: false,
    createdAt: NOW - 10 * MINUTE, updatedAt: NOW, lastEventAt: null, messageCount: 12, eventEpoch: 0, preview: null,
    pendingApproval: null, driver, model: null, effort: null, permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0,
    adopted: false,
  } as SessionView;
}

const RUNS: Record<string, { title: string; members: SessionView[] }> = {
  three: {
    title: "Index session search across machines",
    members: [
      member("s-claude", "claude", "Claude Code", "claude-code", "idle"),
      member("s-codex", "codex", "Codex", "codex-app-server", "idle"),
      member("s-opencode", "opencode", "OpenCode", "acp", "idle"),
    ],
  },
  four: {
    title: "Index session search across machines",
    members: [
      member("s-claude", "claude", "Claude Code", "claude-code", "idle"),
      member("s-codex", "codex", "Codex", "codex-app-server", "idle"),
      member("s-opencode", "opencode", "OpenCode", "acp", "input_required"),
      member("s-gemini", "gemini", "Gemini CLI", "acp", "idle"),
    ],
  },
  running: {
    title: "Index session search across machines",
    members: [
      member("s-claude", "claude", "Claude Code", "claude-code", "idle"),
      member("s-codex", "codex", "Codex", "codex-app-server", "running"),
      member("s-opencode", "opencode", "OpenCode", "acp", "idle"),
    ],
  },
};
const chosen = RUNS[runKey] ?? RUNS.three!;
const run: RunView = {
  id: `run-${runKey}`, title: chosen.title, prompt: PROMPT, workspaceId: "ws-wollipog", workspaceName: "Wollipog",
  createdAt: NOW - 12 * MINUTE, updatedAt: NOW, sessionIds: chosen.members.map((session) => session.id),
};

const ANSWER = [
  "Search now reads a per-machine index of transcript words, so the Sessions list never waits on it.",
  "",
  "| Approach | Index Size | First Result |",
  "| --- | ---: | ---: |",
  "| Trigram index per machine | 41 MB | 38 ms |",
  "| Full scan on demand | 0 MB | 1,920 ms |",
  "",
  "Exact title matches rank first; a transcript match follows by recency.",
].join("\n");

function timeline(sessionId: string, index: number, working: boolean): SessionEvent[] {
  let seq = 0;
  const event = (payload: Record<string, unknown>) => ({ id: seq + 1, sessionId, seq: ++seq, ts: NOW - (30 - seq) * 1_000, payload }) as SessionEvent;
  const commands = ["pnpm test", "rg -n searchSessions apps", "pnpm typecheck", "git diff --stat", "pnpm test -- search"].slice(0, 2 + index);
  return [
    event({ kind: "user_message", text: PROMPT }),
    event({ kind: "agent_message", text: "I'll look at how the Sessions search works today.", final: true }),
    event({ kind: "tool_call", toolCallId: `${sessionId}-read-1`, title: "Read: apps/web/src/session-search.ts", toolKind: "read", status: "completed" }),
    ...(index !== 1 ? [event({ kind: "tool_call", toolCallId: `${sessionId}-read-2`, title: "Read: apps/control-plane/src/db.ts", toolKind: "read", status: "completed" })] : []),
    ...commands.map((command, step) => event({ kind: "tool_call", toolCallId: `${sessionId}-cmd-${step}`, title: `$ ${command}`, toolKind: "execute", status: "completed" })),
    event({ kind: "tool_call", toolCallId: `${sessionId}-edit-1`, title: "Edit: apps/control-plane/src/search-index.ts", toolKind: "edit", status: "completed" }),
    event({ kind: "file_edit", path: "apps/control-plane/src/search-index.ts" }),
    ...(working
      ? [event({ kind: "tool_call", toolCallId: `${sessionId}-cmd-live`, title: "$ pnpm test -- search-index", toolKind: "execute", status: "in_progress" })]
      : [event({ kind: "agent_message", text: ANSWER, final: true })]),
  ];
}

const pages = new Map(chosen.members.map((session, index) => [session.id, timeline(session.id, index, session.status === "running")]));

const snapshot = {
  type: "snapshot",
  capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
  runners: [{
    runnerId: "runner-1", hostname: "studio-mac", displayName: "Studio Mac", os: "macos", version: "1", status: "online",
    agents: [], workspaces: [{ id: "ws-wollipog", name: "Wollipog", path: "/repo" }], connectedAt: NOW, lastSeen: NOW,
  }],
  boxes: [], projects: [], sessions: chosen.members, runs: [run], pods: [],
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
  instanceId: "run-compare-e2e",
  runtimeKey: "run-compare-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

/** The fixture's own query (run, theme) rides along; the app's route owns `member`. */
function fixtureUrl(view: View): string {
  const route = new URL(viewPath(view), window.location.origin);
  const query = new URLSearchParams(window.location.search);
  query.delete("member");
  for (const [key, value] of route.searchParams) query.set(key, value);
  return `${window.location.pathname}?${query.toString()}`;
}

const navigation: ViewNavigation = {
  current: () => {
    const member = new URLSearchParams(window.location.search).get("member");
    // The app's own parser reads the member, as it does from a real run address.
    const route = new URL(viewPath({ name: "run", id: run.id, ...(member ? { member } : {}) }), window.location.origin);
    return viewFromPath(route.pathname, route.search) ?? { name: "run", id: run.id };
  },
  push: (view) => { document.body.dataset.opened = JSON.stringify(view); },
  replace: (view) => { window.history.replaceState(window.history.state, "", fixtureUrl(view)); },
  listen: () => () => {},
};

const client = {
  ...api,
  workflowInstances: async () => [],
  workflowDefinitions: async () => [],
  runWorkflowArtifacts: async () => ({ artifacts: [] }),
  getSessionEventPage: async (id: string) => {
    const events = pages.get(id) ?? [];
    return { events, eventEpoch: 0, nextAfter: events.at(-1)?.seq ?? 0, cacheComplete: true } as SessionEventsResponse;
  },
} as unknown as ApiClient;

function RunRoute() {
  const view = useStoreSelector((state) => state.view);
  return view.name === "run" ? <RunDetail runId={view.id} member={view.member} /> : null;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ApiProvider client={client}>
      <StoreProvider connection={connection} navigation={navigation}>
        <FeedbackProvider>
          <div className="app">
            <div className="run-compare-e2e-rail" aria-hidden="true" />
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
