import React from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type ControlPlaneToUi,
  type RunnerView,
  type SessionEvent,
  type SessionView,
  type UiSnapshotMessage,
} from "@wollipog/protocol";
import { Shell } from "../App.js";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { AssistantThread, AssistantThreadDefaults, CreateAssistantThreadRequest } from "../assistant-threads.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { ThemeProvider } from "../components/ThemeProvider.js";
import { InstanceScopeProvider } from "../instance-scope.js";
import { viewFromPath, viewPath, type ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

/**
 * The Assistants section (#4664) against a stub of the provisional Thread API shared with #4663.
 * This page is the only place the stub lives: the dashboard itself ships no fake threads.
 *
 * `?threads=unavailable` is a control plane without the Thread API (every route answers 404),
 * `?threads=empty` one with no threads yet, and the default three threads, the first of which
 * launched two sessions, one of them waiting on a tool approval. The SPA path rides in `?path=`.
 * `window.assistantsAdvance()` finishes the running launched session, as its stream would.
 */
const SCOPE = "assistants-e2e";
const params = new URLSearchParams(location.search);
const scenario = params.get("threads") ?? "some";
const NOW = Date.now();
const minute = 60_000;

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "build-box",
  displayName: "Build Box",
  os: "linux",
  version: "1",
  status: "online",
  agents: [
    { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", available: true },
    { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true },
  ],
  workspaces: [{ id: "workspace-1", name: "Wollipog", path: "/repos/wollipog" }],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: PROTOCOL_VERSION,
};

function session(id: string, title: string, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id,
    runnerId: runner.runnerId,
    workspaceId: "workspace-1",
    workspaceName: "Wollipog",
    projectId: null,
    agentId: "claude",
    agentName: "Claude Code",
    title,
    status: "idle",
    column: "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: NOW - 40 * minute,
    updatedAt: NOW - 2 * minute,
    lastEventAt: NOW - 2 * minute,
    eventEpoch: 0,
    messageCount: 2,
    preview: null,
    pendingApproval: null,
    driver: "claude-code",
    model: null,
    effort: null,
    permissionMode: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
    ...overrides,
  } as SessionView;
}

const sessions = new Map<string, SessionView>([
  ["sess-triage", session("sess-triage", "Triage Open Issues", { status: "idle" })],
  ["sess-release", session("sess-release", "Ship the Release Notes", { status: "running", agentId: "codex", agentName: "Codex", driver: "codex-app-server" })],
  ["sess-cleanup", session("sess-cleanup", "Weekly Cleanup", { status: "idle", updatedAt: NOW - 26 * 60 * minute })],
  ["sess-flaky", session("sess-flaky", "Fix the Flaky Upload Test", { status: "running", updatedAt: NOW - minute })],
  ["sess-deps", session("sess-deps", "Bump the Vite Group", {
    status: "input_required",
    pendingApproval: {
      requestId: "req-1",
      title: "Run pnpm install --frozen-lockfile",
      options: [
        { optionId: "allow", name: "Allow Once", kind: "allow_once" },
        { optionId: "reject", name: "Deny", kind: "reject_once" },
      ],
      kind: "permission",
    },
  })],
]);

const access = { level: "full_access", destructive: "ask" } as const;
function thread(id: string, sessionId: string, overrides: Partial<AssistantThread>): AssistantThread {
  const backing = sessions.get(sessionId)!;
  return {
    id, assistant: "wollipog", title: backing.title, harness: "claude-code", sessionId, status: "done", access,
    connectionId: `conn-${id}`, launchedSessionIds: [], lastActivityAt: backing.updatedAt, createdAt: backing.createdAt,
    archivedAt: null, ...overrides,
  };
}

let threads: AssistantThread[] = scenario === "some" ? [
  thread("thr_triage", "sess-triage", { status: "needs_you", launchedSessionIds: ["sess-flaky", "sess-deps"], lastActivityAt: NOW - minute }),
  thread("thr_release", "sess-release", { status: "working", harness: "codex", lastActivityAt: NOW - 3 * minute }),
  thread("thr_cleanup", "sess-cleanup", { status: "done" }),
] : [];

const defaults: AssistantThreadDefaults = {
  harness: "claude-code",
  harnesses: [
    { id: "claude-code", label: "Claude Code", available: true },
    { id: "codex", label: "Codex", available: true },
  ],
};

let seq = 0;
const event = (sessionId: string, ts: number, payload: SessionEvent["payload"]): SessionEvent =>
  ({ id: ++seq, sessionId, seq, ts, payload }) as SessionEvent;
const events: Record<string, SessionEvent[]> = {
  "sess-triage": [
    event("sess-triage", NOW - 30 * minute, { kind: "user_message", text: "Last night's CI had two failures. Find out why and fix what you can.", images: [] }),
    event("sess-triage", NOW - 29 * minute, {
      kind: "agent_message",
      text: "The upload test times out on slow runners, and the Vite group bump needs a fresh install. I started a session for each; the install is waiting for your approval.",
      final: true,
    }),
  ],
};

class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: ControlPlaneToUi) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

/** A session as the live list carries it: a summary, whose waiting requests have no options. Only
 * `api.session` returns the detail, as the control plane's summary projection does. */
function summary(full: SessionView): SessionView {
  const pending = full.pendingApproval;
  return { ...structuredClone(full), projection: "summary",
    pendingApproval: pending ? { ...structuredClone(pending), options: [] } : null } as SessionView;
}

function snapshot(): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: false },
    runners: [structuredClone(runner)],
    boxes: [],
    // The launched sessions arrive as summaries; the backing sessions in full.
    sessions: [...sessions.values()].map((entry) => launched(entry.id) ? summary(entry) : structuredClone(entry)),
    runs: [],
    pods: [],
  } as UiSnapshotMessage;
}

let socket: FixtureSocket | null = null;
const connection: UiConnectionRuntime = {
  instanceId: SCOPE,
  runtimeKey: `${SCOPE}:1`,
  createSocket: () => {
    socket = new FixtureSocket();
    window.setTimeout(() => {
      socket?.onopen?.();
      socket?.push(snapshot());
    }, 0);
    return socket;
  },
  close() {},
};

function launched(id: string): boolean {
  return threads.some((candidate) => candidate.launchedSessionIds.includes(id));
}

function upsert(next: SessionView) {
  sessions.set(next.id, next);
  socket?.push({ type: "session_upsert", session: launched(next.id) ? summary(next) : structuredClone(next) } as ControlPlaneToUi);
}

/** `assistantsHoldNextList()`: the next list read answers with the threads as they were when it
 * began, but only once `assistantsReleaseList()` lets it, as a slow read would. */
let holdNextList = false;
let releaseHeldList: (() => void) | null = null;
let slowListMs = 0;

const unavailable = () => Promise.reject(new ApiError("Not Found", 404));
const found = (threadId: string) => {
  const match = threads.find((candidate) => candidate.id === threadId);
  if (!match) throw new ApiError("Thread not found", 404);
  return match;
};

const client = {
  ...api,
  assistantThreads: (options: { includeArchived?: boolean } = {}) => {
    if (scenario === "unavailable") return unavailable();
    const read = { threads: structuredClone(threads.filter((candidate) => options.includeArchived || candidate.status !== "archived")) };
    // `assistantsSlowLists(ms)`: every later read answers after `ms`, with the threads as they were
    // when it began, as a slow control plane would.
    if (slowListMs > 0 && !holdNextList) return new Promise((resolve) => window.setTimeout(() => resolve(read), slowListMs));
    if (!holdNextList) return Promise.resolve(read);
    holdNextList = false;
    document.body.dataset.listHeld = "true";
    return new Promise((resolve) => { releaseHeldList = () => resolve(read); });
  },
  assistantThreadDefaults: () => scenario === "unavailable" ? unavailable() : Promise.resolve(structuredClone(defaults)),
  createAssistantThread: async (body: CreateAssistantThreadRequest) => {
    if (scenario === "unavailable") return unavailable();
    const id = `thr_new_${threads.length + 1}`;
    const sessionId = `sess-new-${threads.length + 1}`;
    upsert(session(sessionId, body.title ?? "New Thread", { createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0,
      ...(body.harness === "codex" ? { agentId: "codex", agentName: "Codex", driver: "codex-app-server" } : {}) }));
    const created: AssistantThread = {
      id, assistant: "wollipog", title: body.title ?? "", harness: body.harness ?? defaults.harness, sessionId, status: "done",
      access, connectionId: null, launchedSessionIds: [], lastActivityAt: Date.now(), createdAt: Date.now(), archivedAt: null,
    };
    threads = [created, ...threads];
    return { thread: structuredClone(created) };
  },
  renameAssistantThread: async (threadId: string, title: string) => {
    const renamed = { ...found(threadId), title };
    threads = threads.map((candidate) => candidate.id === threadId ? renamed : candidate);
    return { thread: structuredClone(renamed) };
  },
  archiveAssistantThread: async (threadId: string) => {
    const archived = { ...found(threadId), status: "archived" as const, archivedAt: Date.now() };
    threads = threads.map((candidate) => candidate.id === threadId ? archived : candidate);
    return { thread: structuredClone(archived) };
  },
  session: async (id: string) => ({ session: structuredClone(sessions.get(id)!) }),
  approve: async (id: string, body: { requestId: string; optionId: string | null }) => {
    const current = sessions.get(id)!;
    const next = { ...current, status: "running" as const, pendingApproval: null, updatedAt: Date.now() };
    document.body.dataset.approved = `${id}:${body.requestId}:${body.optionId}`;
    upsert(next);
    // The thread no longer waits on anyone once its only approval is answered.
    threads = threads.map((candidate) => candidate.launchedSessionIds.includes(id) ? { ...candidate, status: "working" } : candidate);
    return structuredClone(next);
  },
  getSessionEventPage: () => new Promise<never>(() => {}),
  getSessionEventTailPage: (id: string, _before: number | undefined, eventEpoch: number) => Promise.resolve({
    events: structuredClone(events[id] ?? []), eventEpoch, nextBefore: 0, hasMoreOlder: false, cacheComplete: true,
  }),
  descendantRequests: async () => ({ requests: [] }),
  git: async () => ({}),
  gitSummary: async () => ({}),
  reviewFindings: async () => ({ findings: [], summary: {
    total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete",
  } }),
  runnerSkills: async () => ({ desired: [], reported: null }),
} as unknown as ApiClient;

/** The triage thread's backing session reports activity without changing its status. */
function backingActivity() {
  const backing = sessions.get("sess-triage")!;
  upsert({ ...backing, messageCount: backing.messageCount + 1, lastEventAt: Date.now(), updatedAt: Date.now() });
}

Object.assign(window, {
  /** The running launched session finishes, as its stream would report it. */
  assistantsAdvance: () => upsert({ ...sessions.get("sess-flaky")!, status: "completed", updatedAt: Date.now() }),
  /** Mid-turn, the assistant launches another session: the thread's status stays as it was. */
  assistantsLaunch: () => {
    threads = threads.map((candidate) => candidate.id === "thr_triage"
      ? { ...candidate, launchedSessionIds: [...candidate.launchedSessionIds, "sess-changelog"] } : candidate);
    upsert(session("sess-changelog", "Write the Changelog", { status: "running", updatedAt: Date.now() }));
    backingActivity();
  },
  assistantsActivity: backingActivity,
  assistantsHoldNextList: () => { holdNextList = true; },
  assistantsSlowLists: (ms: number) => { slowListMs = ms; },
  assistantsReleaseList: () => {
    releaseHeldList?.();
    releaseHeldList = null;
  },
});

/** The harness page's own URL scheme: the SPA path rides in `?path=`. */
const navigation: ViewNavigation = {
  current: () => {
    const path = new URLSearchParams(window.location.search).get("path") ?? "/assistants";
    const url = new URL(path, window.location.origin);
    return viewFromPath(url.pathname, url.search) ?? { name: "assistants" };
  },
  push: (view) => {
    const url = new URL(window.location.href);
    url.searchParams.set("path", viewPath(view));
    window.history.pushState(null, "", url);
  },
  listen: (onView) => {
    const onPop = () => onView(navigation.current());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  },
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <InstanceScopeProvider instanceScope={SCOPE}>
    <ApiProvider client={client}>
      <FeedbackProvider>
        <StoreProvider connection={connection} navigation={navigation}>
          <ThemeProvider><Shell /></ThemeProvider>
        </StoreProvider>
      </FeedbackProvider>
    </ApiProvider>
  </InstanceScopeProvider>,
);
