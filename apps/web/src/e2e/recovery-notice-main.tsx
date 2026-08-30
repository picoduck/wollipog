import React from "react";
import { createRoot } from "react-dom/client";
import type { ControlPlaneToUi, RunnerView, SessionEvent, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { SessionDetail } from "../components/SessionDetail.js";
import "../styles.css";

/** Real-browser SessionDetail harness for recovery geometry and earlier-history pagination:
 * `?mode=preview|expanded`, `?height=<px>`, and `?pinned=1` configure the recovery fixture.
 * By default recovery stays active for the page life; `?settled=1` completes it, while
 * `?pagination=1` resolves a bounded opening window and then holds the automatic earlier-page
 * request in flight for inspection. `?pagination=resolve` serves multiple variable-height pages;
 * `?event-heavy=1` makes 200 raw opening events collapse into one partial rendered response, and
 * `?live=1` adds a live tail event during the first prepend. */
const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") === "preview" ? ("preview" as const) : ("expanded" as const);
const frameHeight = Number(params.get("height") ?? "600");
const frameWidth = Number(params.get("width") ?? "900");
const pinnedOpen = params.get("pinned") === "1";
const pagination = params.get("pagination") === "1";
const resolvedPagination = params.get("pagination") === "resolve";
const eventHeavyOpening = params.get("event-heavy") === "1";
const liveDuringPagination = params.get("live") === "1";
const paginationDelay = Number(params.get("pagination-delay") ?? "80");
const settled = params.get("settled") === "1";

const SESSION_ID = "recovery-e2e-session";

const runner = {
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{
    id: "codex",
    name: "Codex",
    command: "codex",
    args: [],
    env: {},
    driver: "codex-app-server",
    available: true,
  }],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 67,
} as RunnerView;

const session: SessionView = {
  id: SESSION_ID,
  runnerId: runner.runnerId,
  workspaceId: null,
  workspaceName: null,
  projectId: null,
  agentId: "codex",
  agentName: "Codex",
  title: "Recovery Notice Geometry Fixture",
  status: "idle",
  column: "review",
  runId: null,
  useWorktree: true,
  worktreePath: "/tmp/recovery-e2e-worktree",
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  lastEventAt: null,
  messageCount: 0,
  eventEpoch: 0,
  preview: null,
  pendingApproval: null,
  driver: "codex-app-server",
  model: "codex-large",
  effort: null,
  permissionMode: null,
  tokensIn: 4200,
  tokensOut: 1337,
  costUsd: 0.42,
  adopted: false,
  // A known context window makes the ContextWindowMeter render in the strip's leading cell,
  // so the specs can prove the active recovery echo wins that cell in compact mode.
  contextWindow: 200_000,
};

const snapshotMessage: ControlPlaneToUi = {
  type: "snapshot",
  capabilities: {
    sessionSubscriptions: false,
    boundedDelivery: false,
    paginatedSessionHistory: false,
    projects: true,
  },
  runners: [runner],
  boxes: [],
  projects: [],
  sessions: [session],
  runs: [],
  pods: [],
};

let fixtureSocket: FixtureSocket | null = null;
class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    fixtureSocket = this;
    setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify(snapshotMessage) });
    }, 0);
  }
  send() {}
  close() {}
}

const connection: UiConnectionRuntime = {
  instanceId: "recovery-e2e",
  runtimeKey: "recovery-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "session", id: SESSION_ID }),
  push() {},
  listen: () => () => {},
};

/** The default endpoints never answer, keeping recovery active for geometry tests. Pagination mode
 * resolves only the opening window; its next request stays pending so loading state is observable. */
let tailRequestCount = 0;
const client = {
  ...api,
  session: () => new Promise<never>(() => {}),
  getSessionEventPage: () => new Promise<never>(() => {}),
  getSessionEventTailPage: (_id: string, before: number | undefined, eventEpoch: number) => {
    tailRequestCount += 1;
    document.body.dataset.tailRequestCount = String(tailRequestCount);
    if (settled && before === undefined) {
      return Promise.resolve({
        events: activeFixtureEvents, eventEpoch, nextBefore: 0, hasMoreOlder: false, cacheComplete: true,
      });
    }
    if (resolvedPagination && before !== undefined) {
      const pageSize = eventHeavyOpening ? 200 : 8;
      const pageStart = Math.max(0, before - 1 - pageSize);
      const events = activeFixtureEvents.slice(pageStart, before - 1);
      if (liveDuringPagination && tailRequestCount === 2) {
        window.setTimeout(() => fixtureSocket?.onmessage?.({ data: JSON.stringify({
          type: "session_event",
          event: {
            id: 81,
            sessionId: SESSION_ID,
            seq: 81,
            ts: 81,
            payload: {
              kind: "agent_message",
              text: `live answer ${"arriving while older activity loads ".repeat(5)}`,
              final: true,
            },
          },
        } satisfies ControlPlaneToUi) }), 30);
      }
      return new Promise((resolve) => window.setTimeout(() => resolve({
        events,
        eventEpoch,
        nextBefore: events[0]?.seq ?? 0,
        hasMoreOlder: pageStart > 0,
        cacheComplete: true,
      }), paginationDelay));
    }
    if ((!pagination && !resolvedPagination) || before !== undefined) return new Promise<never>(() => {});
    const openingWindow = activeFixtureEvents.slice(-24);
    const boundedOpeningWindow = eventHeavyOpening ? activeFixtureEvents.slice(-200) : openingWindow;
    return Promise.resolve({
      events: boundedOpeningWindow, eventEpoch, nextBefore: boundedOpeningWindow[0]?.seq ?? 0,
      hasMoreOlder: true, turnAligned: eventHeavyOpening ? false : true, cacheComplete: true,
    });
  },
} as unknown as ApiClient;

const payloads: SessionEvent["payload"][] = [];
for (let turn = 0; turn < 20; turn += 1) {
  payloads.push({
    kind: "user_message",
    text: `cached question ${turn + 1} ${"with variable wrapping ".repeat((turn % 3) + 1)}`,
    images: [],
  });
  payloads.push({
    kind: "agent_thought",
    text: `cached reasoning ${turn + 1} ${"with measured details ".repeat((turn % 2) + 1)}`,
    final: true,
  });
  payloads.push({
    kind: "tool_call",
    toolCallId: `cached-tool-${turn + 1}`,
    title: `Cached Tool ${turn + 1}`,
    status: "completed",
    text: `cached output ${"with variable wrapping ".repeat((turn % 3) + 1)}`,
  });
  payloads.push({
    kind: "agent_message",
    text: `cached answer ${turn + 1} ${"and a differently sized response ".repeat((turn % 4) + 1)}`,
    final: true,
  });
}
const fixtureEvents: SessionEvent[] = payloads.map((payload, index) => ({
  id: index + 1,
  sessionId: SESSION_ID,
  seq: index + 1,
  ts: index + 1,
  payload,
}));

const eventHeavyPayloads: SessionEvent["payload"][] = [];
for (let turn = 0; turn < 110; turn += 1) {
  eventHeavyPayloads.push(
    { kind: "user_message", text: `earlier question ${turn + 1}`, images: [] },
    { kind: "agent_message", text: `earlier complete answer ${turn + 1}`, final: true },
  );
}
eventHeavyPayloads.push({
  kind: "user_message",
  text: "Explain the bounded opening-window behavior.",
  images: [],
});
for (let chunk = 0; chunk < 240; chunk += 1) {
  eventHeavyPayloads.push({
    kind: "agent_message",
    text: "x ",
    final: chunk === 239,
  });
}
const eventHeavyFixtureEvents: SessionEvent[] = eventHeavyPayloads.map((payload, index) => ({
  id: index + 1,
  sessionId: SESSION_ID,
  seq: index + 1,
  ts: index + 1,
  payload,
}));
const activeFixtureEvents = eventHeavyOpening ? eventHeavyFixtureEvents : fixtureEvents;

function EventSeeder() {
  const ready = useStoreSelector((state) => state.sessions.has(SESSION_ID));
  const { dispatch } = useStoreActions();
  React.useEffect(() => {
    if (!ready) return;
    for (const event of activeFixtureEvents) {
      dispatch({ type: "msg", msg: { type: "session_event", event } });
    }
  }, [dispatch, ready]);
  return null;
}

const rightPanel = {
  open: false,
  mode: "launcher" as const,
  width: 360,
  dragging: false,
  subagentTarget: null,
  toggle() {},
  openMode() {},
  show() {},
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
      {/* The frame stands in for the pane an inbox splitter produces: fixed height, clipped. */}
      <div
        id="frame"
        style={{ height: frameHeight, width: frameWidth, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <SessionDetail
          sessionId={SESSION_ID}
          mode={mode}
          rightPanel={rightPanel}
          onOpenTerminal={() => {}}
          pinnedOpen={pinnedOpen}
          composerDraftLoader={async () => null}
        />
      </div>
    </StoreProvider>
  </ApiProvider>,
);
