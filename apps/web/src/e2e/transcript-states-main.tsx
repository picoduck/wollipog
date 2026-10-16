import React from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type ControlPlaneToUi,
  type ProjectView,
  type RunnerView,
  type SessionEvent,
  type SessionEventsResponse,
  type SessionStatus,
  type SessionView,
  type UiToControlPlane,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { SessionDetail } from "../components/SessionDetail.js";
import "../styles.css";

/** Real-browser SessionDetail harness for the reading column's load, empty and history-error states
 * (#2172). `?state=` picks one:
 *
 * - `loading`: the opening read never answers. `?count=<n>` is the snapshot's event count (`messageCount`).
 * - `awaiting`, `starting`, `stopped`, `archived`: the history loads empty for a session in that
 *   status (`archived` is archived and stopped).
 * - `pruned`: archived-history retention kept only the prompts and the final response (#2777), so
 *   the history loads with gaps under the History Pruned notice. `prune-scheduled`: archived under a
 *   90-day policy that has not pruned it yet, so its full history loads under the Session Archived
 *   notice, which says when it will be pruned.
 * - `history-error`: the opening read fails with nothing cached; `history-partial` fails after
 *   cached rows were delivered.
 * - `earlier`: a bounded opening window with older activity above it. `?older=hold` keeps the
 *   earlier-page request in flight, `?older=fail` rejects it, `?older=unsupported` answers it as a
 *   server without backward reads does, and the default resolves it.
 *   `?opening=one-turn` opens just the complete latest turn, which fits without scrolling (#3156).
 *   A held older response can be released with `window.__releaseEarlierHistory()` (#3188).
 * - `unpaired`: the server refuses this device before anything is cached (#2579).
 * - `incomplete`: every read answers with a cache still filling from the machine, holding only a
 *   hidden Agent Log (#2773). `?runner=offline` shows that machine as offline.
 * - `agent-logs`: a stopped session whose complete history is one hidden Agent Log (#2773).
 * - `empty-opening-race`: a held complete empty current-turn opening and acknowledged live
 *   subscription; the browser controls delivery and response release to exercise recovery (#3042).
 *
 * `?theme=light|dark` picks the theme and `?mode=preview` renders the Inbox preview. The right
 * panel records the mode it was asked to show in `body[data-right-panel-mode]`. `?failed=1` adds a
 * message sign-in recovery left unsent, with Retry and Dismiss (#2500); each action it sends is
 * recorded in `body[data-pending-prompt-actions]`. */
const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
const state = params.get("state") ?? "awaiting";
const emptyOpeningRace = state === "empty-opening-race";
const older = params.get("older") ?? "resolve";
const oneTurnOpening = state === "earlier" && params.get("opening") === "one-turn";
const mode = params.get("mode") === "preview" ? ("preview" as const) : ("expanded" as const);
const count = Number(params.get("count") ?? "0");
const failedPrompt = params.get("failed") === "1";
const runnerStatus = params.get("runner") === "offline" ? "offline" : "online";

const SESSION_ID = "transcript-states-session";
const PROJECT_ID = "project-wollipog";

const statusByState: Record<string, SessionStatus> = {
  starting: "starting",
  stopped: "stopped",
  archived: "stopped",
  incomplete: "stopped",
  "agent-logs": "stopped",
  pruned: "stopped",
  "prune-scheduled": "stopped",
};
const status: SessionStatus = statusByState[state] ?? "idle";
/** `pruned`: archived-history retention kept only the prompts and the final response (#2777).
 * `prune-scheduled`: archived under a 90-day policy that has not reached it yet. */
const archivedState = state === "archived" || state === "pruned" || state === "prune-scheduled";
const ARCHIVED_AT = Date.UTC(2026, 8, 20, 12);

const runner = {
  runnerId: "runner-1",
  hostname: "build-box.local",
  displayName: "Build Box",
  os: "linux",
  version: "1",
  status: runnerStatus,
  agents: [{
    id: "claude",
    name: "Claude Code",
    command: "claude",
    args: [],
    env: {},
    driver: "claude-code",
    available: true,
  }],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: PROTOCOL_VERSION,
} as RunnerView;

const project = {
  id: PROJECT_ID,
  name: "Wollipog",
  hidden: false,
  locations: [],
  activeSessionCount: 1,
  unarchivedSessionCount: 1,
  totalSessionCount: 1,
  createdAt: 1,
  updatedAt: 1,
} as ProjectView;

// Pruned sessions are streamed ones, whose answers carry no `final` flag, as live claude-code and
// codex-app-server output does; an adopted transcript flags every answer final, and a prune keeps
// each of those.
const streamed = state === "pruned" || state === "prune-scheduled";
const payloads: SessionEvent["payload"][] = [];
for (let turn = 0; turn < 20; turn += 1) {
  payloads.push(
    { kind: "user_message", text: `Question ${turn + 1}: ${"what changed in the reading column ".repeat((turn % 3) + 1)}`, images: [] },
    { kind: "tool_call", toolCallId: `tool-${turn + 1}`, title: `Read File ${turn + 1}`, status: "completed", text: "file contents" },
    { kind: "agent_message", text: `Answer ${turn + 1}: ${"the reading column shows one state at a time. ".repeat((turn % 4) + 1)}`,
      ...(streamed ? { messageId: `answer-${turn + 1}` } : { final: true }) },
  );
}
const events: SessionEvent[] = payloads.map((payload, index) => ({
  id: index + 1, sessionId: SESSION_ID, seq: index + 1, ts: 1_760_000_000_000 + index * 1000, payload,
}));
const hasEvents = state === "earlier" || state === "history-partial" || state === "prune-scheduled";
// What a prune keeps of a streamed session: every prompt and the final response, the last answer.
const finalResponse = events.filter((event) => event.payload.kind === "agent_message").at(-1)!;
const keptEvents = events.filter((event) => event.payload.kind === "user_message" || event === finalResponse);
const agentLog: SessionEvent = {
  id: 1, sessionId: SESSION_ID, seq: 1, ts: 1_760_000_000_000, payload: { kind: "stderr", text: "[agent] ready\n" },
};

const session = {
  id: SESSION_ID,
  runnerId: runner.runnerId,
  workspaceId: null,
  workspaceName: "wollipog",
  projectId: PROJECT_ID,
  projectName: "Wollipog",
  agentId: "claude",
  agentName: "Claude Code",
  title: "Reading Column States",
  status,
  column: "review",
  runId: null,
  useWorktree: false,
  worktreePath: null,
  archived: archivedState,
  ...(archivedState ? { archivedAt: ARCHIVED_AT } : {}),
  ...(state === "pruned" ? { historyPruned: { prunedAt: Date.UTC(2026, 9, 2, 9), eventCount: 1_284, retentionDays: 90 } } : {}),
  createdAt: 1,
  updatedAt: 1,
  lastEventAt: null,
  messageCount: hasEvents ? events.length : state === "pruned" ? keptEvents.length : count,
  eventEpoch: 0,
  preview: null,
  pendingApproval: null,
  driver: "claude-code",
  model: "claude-opus-5-5",
  effort: null,
  permissionMode: null,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  adopted: false,
  pendingPrompts: failedPrompt ? [{
    commandId: "prompt-failed",
    text: "Also update the changelog before you open the pull request.",
    hasImages: false,
    state: "failed",
    errorCode: "PROVIDER_AUTHENTICATION_REQUIRED",
    error: "authentication recovery was dismissed; this message was not sent",
    canDismiss: true,
    canRetry: true,
    revision: 1,
    attemptCount: 1,
    createdAt: 1,
    updatedAt: 1,
  }] : undefined,
} as SessionView;

const snapshotMessage: ControlPlaneToUi = {
  type: "snapshot",
  capabilities: { sessionSubscriptions: emptyOpeningRace, boundedDelivery: emptyOpeningRace, paginatedSessionHistory: emptyOpeningRace, projects: true,
    currentTurnOpening: emptyOpeningRace || oneTurnOpening },
  runners: [runner],
  boxes: [],
  projects: [project],
  sessions: [session],
  runs: [],
  pods: [],
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
      this.onmessage?.({ data: JSON.stringify(snapshotMessage) });
    }, 0);
  }
  send(data: string) {
    if (!emptyOpeningRace) return;
    const message = JSON.parse(data) as UiToControlPlane;
    if (message.type !== "session_subscriptions") return;
    setTimeout(() => {
      this.onmessage?.({ data: JSON.stringify({ type: "session_subscriptions_applied", revision: message.revision,
        sessionIds: message.sessionIds, podIds: message.podIds }) });
      document.body.dataset.subscriptionApplied = "true";
    }, 0);
  }
  close() {}
}

const connection: UiConnectionRuntime = {
  instanceId: "transcript-states-e2e",
  runtimeKey: "transcript-states-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "session", id: SESSION_ID }),
  push() {},
  listen: () => () => {},
};

const never = () => new Promise<never>(() => {});
let releaseOpening!: () => void;
const openingHeld = new Promise<void>((resolve) => { releaseOpening = resolve; });
const racingPayloads: SessionEvent["payload"][] = [
  { kind: "user_message", text: "Current prompt: recover the empty opening.", images: [] },
  { kind: "agent_message", text: "The first live response follows the current prompt.", messageId: "race-2", final: true },
  { kind: "agent_message", text: "The second live response completes this synthetic turn.", messageId: "race-3", final: true },
  { kind: "agent_message", text: "Additional live activity remains visible after recovery.", messageId: "race-4", final: true },
];
const racingEvents: SessionEvent[] = racingPayloads.map((payload, index) => ({ id: index + 1, sessionId: SESSION_ID, seq: index + 1,
  ts: 1_760_000_000_000 + index * 1000, payload }));
declare global {
  interface Window {
    __releaseEarlierHistory?: () => void;
    __emptyOpeningRace: { emit: (seqs: number[]) => void; release: () => void; sequences: () => number[] };
  }
}
let tailRequestCount = 0;
let earlierRequestCount = 0;
const pendingPromptActions: string[] = [];
const client = {
  ...api,
  getSessionEventPage: emptyOpeningRace
    ? async () => ({ events: racingEvents.slice(0, 3), eventEpoch: 0, nextAfter: 3, hasMoreCached: false, cacheComplete: true })
    : never,
  getSessionTurnStartPage: async (): Promise<SessionEventsResponse> => {
    if (oneTurnOpening) {
      const turn = events.slice(-3);
      return { events: turn, eventEpoch: 0, turnStartSeq: turn[0]!.seq,
        nextAfter: turn.at(-1)!.seq, tailSeq: turn.at(-1)!.seq,
        hasMoreLater: false, hasMoreOlder: true, turnAligned: true, cacheComplete: true };
    }
    if (!emptyOpeningRace) return never();
    // Capture the complete empty log before live delivery, then hold only its response.
    const page = { events: [], eventEpoch: 0, turnStartSeq: 0, nextAfter: 0, tailSeq: 0,
      hasMoreLater: false, hasMoreOlder: false, cacheComplete: true };
    document.body.dataset.openingRequested = "true";
    await openingHeld;
    return page;
  },
  session: never,
  archivedHistoryRetention: async () => ({
    retentionDays: 90, source: "organization", environmentDays: null, canManage: true,
    prunesFrom: Date.UTC(2026, 6, 15, 9), nextRunAt: null, eligible: { sessions: 0, events: 0 }, lastRun: null,
    limits: { minDays: 7, maxDays: 3650, suggestedDays: 90 },
  }),
  resolvePendingPrompt: async (_id: string, commandId: string, action: string) => {
    pendingPromptActions.push(`${action}:${commandId}`);
    document.body.dataset.pendingPromptActions = pendingPromptActions.join(" ");
    return session;
  },
  getSessionEventTailPage: (_id: string, before: number | undefined, eventEpoch: number) => {
    tailRequestCount += 1;
    document.body.dataset.tailRequestCount = String(tailRequestCount);
    if (emptyOpeningRace) return Promise.resolve({ events: racingEvents.slice(0, 3), eventEpoch, nextBefore: 1,
      hasMoreOlder: false, turnAligned: true, cacheComplete: true });
    if (state === "loading" || state === "unpaired") return never();
    if (state === "incomplete" || state === "agent-logs") {
      return Promise.resolve({
        events: [agentLog], eventEpoch, nextBefore: 1, hasMoreOlder: false, cacheComplete: state === "agent-logs",
      });
    }
    if (state === "pruned") {
      const window = before === undefined ? keptEvents.slice(-16)
        : keptEvents.filter((event) => event.seq < before).slice(-16);
      return Promise.resolve({ events: window, eventEpoch, nextBefore: window[0]?.seq ?? 0,
        hasMoreOlder: (window[0]?.seq ?? 0) > keptEvents[0]!.seq, turnAligned: true, cacheComplete: true });
    }
    if (state === "history-error" || state === "history-partial") {
      return Promise.reject(new Error("GET /api/sessions/transcript-states-session/events/tail failed: 502 Bad Gateway"));
    }
    if (state === "prune-scheduled") {
      const window = events.slice(-24);
      return Promise.resolve({ events: window, eventEpoch, nextBefore: window[0]!.seq, hasMoreOlder: true, turnAligned: true, cacheComplete: true });
    }
    if (state === "earlier") {
      if (before === undefined) {
        const window = events.slice(-24);
        return Promise.resolve({ events: window, eventEpoch, nextBefore: window[0]!.seq, hasMoreOlder: true, turnAligned: true, cacheComplete: true });
      }
      document.body.dataset.earlierRequestCount = String(++earlierRequestCount);
      if (older === "fail") return new Promise((_, reject) => window.setTimeout(() => reject(new Error("fixture rejected")), 80));
      // No `hasMoreOlder`: an older server answers a backward read with a forward page.
      if (older === "unsupported") {
        return new Promise((resolve) => window.setTimeout(() => resolve({ events: [], eventEpoch, nextBefore: 0, cacheComplete: true }), 80));
      }
      const end = events.findIndex((event) => event.seq === before);
      const page = events.slice(Math.max(0, end - 12), end);
      if (older === "hold") return new Promise((resolve) => {
        window.__releaseEarlierHistory = () => resolve({
          events: page, eventEpoch, nextBefore: page[0]?.seq ?? 0,
          hasMoreOlder: end - 12 > 0, cacheComplete: true,
        });
      });
      return new Promise((resolve) => window.setTimeout(() => resolve({
        events: page, eventEpoch, nextBefore: page[0]?.seq ?? 0, hasMoreOlder: end - 12 > 0, cacheComplete: true,
      }), 80));
    }
    return Promise.resolve({ events: [], eventEpoch, nextBefore: 0, hasMoreOlder: false, cacheComplete: true });
  },
} as unknown as ApiClient;

/** A partial failure needs rows already cached: deliver them live before the read fails. An
 * unpaired device loses its connection once the session is known. */
function EventSeeder() {
  const ready = useStoreSelector((current) => current.sessions.has(SESSION_ID));
  const rendered = useStoreSelector((current) => current.events.get(SESSION_ID));
  const { dispatch } = useStoreActions();
  React.useEffect(() => {
    if (!ready || !emptyOpeningRace) return;
    window.__emptyOpeningRace = {
      emit: (seqs) => {
        for (const seq of seqs) dispatch({ type: "msg", msg: { type: "session_event", event: racingEvents[seq - 1]! } });
      },
      release: releaseOpening,
      sequences: () => (rendered ?? []).map((event) => event.seq),
    };
  }, [dispatch, ready, rendered]);
  React.useEffect(() => {
    if (!ready) return;
    if (state === "unpaired") dispatch({ type: "conn", conn: "unauthorized" });
    if (state !== "history-partial") return;
    for (const event of events.slice(-9)) dispatch({ type: "msg", msg: { type: "session_event", event } });
  }, [dispatch, ready]);
  return null;
}

const recordMode = (panelMode: string) => {
  document.body.dataset.rightPanelMode = panelMode;
};
const rightPanel = {
  open: false,
  mode: "launcher" as const,
  width: 360,
  dragging: false,
  subagentTarget: null,
  toggle() {},
  openMode: recordMode,
  show: recordMode,
  setMode() {},
  setWidth() {},
  expanded: false,
  setExpanded() {},
  setDragging() {},
  close() {},
  selectSubagent() {},
  showSubagent() {},
  consumeSubagentFocusRequest() {},
};

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <StoreProvider connection={connection} navigation={navigation}>
      <EventSeeder />
      <div id="frame" style={{ height: "100vh", width: "100vw", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <SessionDetail
          sessionId={SESSION_ID}
          mode={mode}
          rightPanel={rightPanel}
          onOpenTerminal={() => {}}
          composerDraftLoader={async () => null}
        />
      </div>
    </StoreProvider>
  </ApiProvider>,
);
