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

/** Real-browser geometry harness for the transcript recovery notice (issue #56):
 * `?mode=preview|expanded` picks the SessionDetail surface, `?height=<px>` fixes the harness
 * frame (standing in for an inbox splitter position), and `?pinned=1` opens the pinned summary.
 * Recovery stays ACTIVE for the whole page life: the history endpoint never resolves. */
const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") === "preview" ? ("preview" as const) : ("expanded" as const);
const frameHeight = Number(params.get("height") ?? "600");
const frameWidth = Number(params.get("width") ?? "900");
const pinnedOpen = params.get("pinned") === "1";

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

/** Recovery must stay visibly active: the cached transcript is seeded over the socket while the
 * history endpoint below never answers, holding `refreshing` for the whole page life. */
const client = {
  ...api,
  session: () => new Promise<never>(() => {}),
  getSessionEventPage: () => new Promise<never>(() => {}),
} as unknown as ApiClient;

const payloads: SessionEvent["payload"][] = [];
for (let turn = 0; turn < 12; turn += 1) {
  payloads.push({ kind: "user_message", text: `cached question ${turn + 1}`, images: [] });
  payloads.push({ kind: "agent_message", text: `cached answer ${turn + 1}`, final: true });
}

function EventSeeder() {
  const ready = useStoreSelector((state) => state.sessions.has(SESSION_ID));
  const { dispatch } = useStoreActions();
  React.useEffect(() => {
    if (!ready) return;
    payloads.forEach((payload, index) => {
      dispatch({
        type: "msg",
        msg: {
          type: "session_event",
          event: { id: index + 1, sessionId: SESSION_ID, seq: index + 1, ts: index + 1, payload },
        },
      });
    });
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
