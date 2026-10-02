import React from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type ControlPlaneToUi,
  type ProjectView,
  type RunnerView,
  type SessionEvent,
  type SessionStatus,
  type SessionView,
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
 * - `history-error`: the opening read fails with nothing cached; `history-partial` fails after
 *   cached rows were delivered.
 * - `earlier`: a bounded opening window with older activity above it. `?older=hold` keeps the
 *   earlier-page request in flight, `?older=fail` rejects it, and the default resolves it.
 *
 * `?theme=light|dark` picks the theme and `?mode=preview` renders the Inbox preview. The right
 * panel records the mode it was asked to show in `body[data-right-panel-mode]`. */
const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
const state = params.get("state") ?? "awaiting";
const older = params.get("older") ?? "resolve";
const mode = params.get("mode") === "preview" ? ("preview" as const) : ("expanded" as const);
const count = Number(params.get("count") ?? "0");

const SESSION_ID = "transcript-states-session";
const PROJECT_ID = "project-wollipog";

const statusByState: Record<string, SessionStatus> = {
  starting: "starting",
  stopped: "stopped",
  archived: "stopped",
};
const status: SessionStatus = statusByState[state] ?? "idle";

const runner = {
  runnerId: "runner-1",
  hostname: "build-box.local",
  displayName: "Build Box",
  os: "linux",
  version: "1",
  status: "online",
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

const payloads: SessionEvent["payload"][] = [];
for (let turn = 0; turn < 20; turn += 1) {
  payloads.push(
    { kind: "user_message", text: `Question ${turn + 1}: ${"what changed in the reading column ".repeat((turn % 3) + 1)}`, images: [] },
    { kind: "tool_call", toolCallId: `tool-${turn + 1}`, title: `Read File ${turn + 1}`, status: "completed", text: "file contents" },
    { kind: "agent_message", text: `Answer ${turn + 1}: ${"the reading column shows one state at a time. ".repeat((turn % 4) + 1)}`, final: true },
  );
}
const events: SessionEvent[] = payloads.map((payload, index) => ({
  id: index + 1, sessionId: SESSION_ID, seq: index + 1, ts: 1_760_000_000_000 + index * 1000, payload,
}));
const hasEvents = state === "earlier" || state === "history-partial";

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
  archived: state === "archived",
  createdAt: 1,
  updatedAt: 1,
  lastEventAt: null,
  messageCount: hasEvents ? events.length : count,
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
} as SessionView;

const snapshotMessage: ControlPlaneToUi = {
  type: "snapshot",
  capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
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
  send() {}
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
let tailRequestCount = 0;
const client = {
  ...api,
  getSessionEventPage: never,
  session: never,
  getSessionEventTailPage: (_id: string, before: number | undefined, eventEpoch: number) => {
    tailRequestCount += 1;
    document.body.dataset.tailRequestCount = String(tailRequestCount);
    if (state === "loading") return never();
    if (state === "history-error" || state === "history-partial") {
      return Promise.reject(new Error("GET /api/sessions/transcript-states-session/events/tail failed: 502 Bad Gateway"));
    }
    if (state === "earlier") {
      if (before === undefined) {
        const window = events.slice(-24);
        return Promise.resolve({ events: window, eventEpoch, nextBefore: window[0]!.seq, hasMoreOlder: true, turnAligned: true, cacheComplete: true });
      }
      if (older === "hold") return never();
      if (older === "fail") return new Promise((_, reject) => window.setTimeout(() => reject(new Error("fixture rejected")), 80));
      const end = events.findIndex((event) => event.seq === before);
      const page = events.slice(Math.max(0, end - 12), end);
      return new Promise((resolve) => window.setTimeout(() => resolve({
        events: page, eventEpoch, nextBefore: page[0]?.seq ?? 0, hasMoreOlder: end - 12 > 0, cacheComplete: true,
      }), 80));
    }
    return Promise.resolve({ events: [], eventEpoch, nextBefore: 0, hasMoreOlder: false, cacheComplete: true });
  },
} as unknown as ApiClient;

/** A partial failure needs rows already cached: deliver them live before the read fails. */
function EventSeeder() {
  const ready = useStoreSelector((current) => current.sessions.has(SESSION_ID));
  const { dispatch } = useStoreActions();
  React.useEffect(() => {
    if (!ready || state !== "history-partial") return;
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
