import React from "react";
import {
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type ControlPlaneToUi,
  type RunnerView,
  type SessionEvent,
  type SessionView,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { SessionDetail } from "../components/SessionDetail.js";

/**
 * The checkpoint-rewind harness's whole-session surface (`?surface=session`): a real SessionDetail
 * whose turns offer Edit as a New Turn, Edit in a Fork, Rewind Files and Fork Conversation, so the
 * composer and the confirmations they open can be driven and captured (#2185).
 *
 * `?driver=claude-code` makes it a Claude Code session, whose fork is only after the latest turn;
 * `?draft=<text>` puts a draft in the composer; `?fork=ambiguous` makes a fork's outcome uncertain
 * (a 504) and `?fork=hold` keeps it running; `?quarantine=fork|handoff` quarantines the
 * conversation with a recovery from Turn 2. Requests land in `document.body.dataset`
 * (`navigated`, `rewound`, `forked`, `prompted`).
 */
const params = new URLSearchParams(window.location.search);
const driver = params.get("driver") === "claude-code" ? "claude-code" as const : "codex-app-server" as const;
const quarantine = params.get("quarantine");
const forkMode = params.get("fork");
const draftText = params.get("draft");

const SESSION_ID = "checkpoint-rewind-session";

/** A small picture for the second prompt's attachment, drawn rather than shipped as bytes. */
function attachmentPng(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 64;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#2f6fdf";
  context.fillRect(0, 0, 96, 64);
  context.fillStyle = "#f5c542";
  context.fillRect(12, 12, 40, 24);
  context.fillStyle = "#ffffff";
  context.fillRect(12, 44, 72, 8);
  return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
}
const ATTACHMENT = { mimeType: "image/png", data: attachmentPng() };

const MODEL = driver === "claude-code" ? "opus" : "codex-large";
const capabilities = {
  models: [{ id: MODEL, displayName: driver === "claude-code" ? "Opus" : "Codex Large", default: true, inputModalities: ["text", "image"] }],
  effortLevels: [],
  slashCommands: [],
  supportsImages: true,
  supportsConversationFork: true,
} as unknown as AgentCapabilities;

const runner = {
  runnerId: "runner-1",
  hostname: "studio",
  displayName: "Studio",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{
    id: driver,
    name: driver === "claude-code" ? "Claude Code" : "Codex",
    command: driver === "claude-code" ? "claude" : "codex",
    args: [],
    env: {},
    driver,
    available: true,
    capabilities,
  }],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: PROTOCOL_VERSION,
} as RunnerView;

const session: SessionView = {
  id: SESSION_ID,
  runnerId: runner.runnerId,
  workspaceId: null,
  workspaceName: null,
  projectId: null,
  agentId: driver,
  agentName: driver === "claude-code" ? "Claude Code" : "Codex",
  agentCapabilities: capabilities,
  title: "Tidy the Session Notice Slot",
  status: "idle",
  column: "review",
  runId: null,
  useWorktree: true,
  worktreePath: "/repos/wollipog/worktrees/notice-slot",
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  lastEventAt: null,
  messageCount: 0,
  eventEpoch: 0,
  preview: null,
  pendingApproval: null,
  driver,
  model: MODEL,
  effort: null,
  permissionMode: null,
  tokensIn: 4200,
  tokensOut: 1337,
  costUsd: 0.42,
  adopted: false,
  ...(quarantine === "fork" || quarantine === "handoff"
    ? { historyQuarantine: { reason: "oversized_tool_call", detectedAt: 9, recoveryTurn: 2, recovery: quarantine } }
    : {}),
} as SessionView;

const payloads: SessionEvent["payload"][] = [
  { kind: "user_message", text: "Add a Retry Turn button to the failed turn notice.", images: [] },
  { kind: "checkpoint", turn: 1 },
  { kind: "agent_message", text: "Added **Retry Turn** to the Turn Failed notice, with a test for its focus.", final: true },
  { kind: "conversation_checkpoint", turn: 1 },
  {
    kind: "user_message",
    text: "Refactor the session notice slot so that every composer error becomes one entry, ranked after the session's own conditions.",
    images: [ATTACHMENT],
  },
  { kind: "checkpoint", turn: 2 },
  { kind: "agent_message", text: "Composer errors are now slot entries, ranked after the session's conditions of the same severity.", final: true },
  { kind: "conversation_checkpoint", turn: 2 },
] as SessionEvent["payload"][];
const events: SessionEvent[] = payloads.map((payload, index) => ({
  id: index + 1, sessionId: SESSION_ID, seq: index + 1, ts: Date.UTC(2026, 9, 3, 9, 0, index * 20), payload,
}));

class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify({
        type: "snapshot",
        capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
        runners: [runner],
        boxes: [],
        projects: [],
        sessions: [session],
        runs: [],
        pods: [],
      } satisfies ControlPlaneToUi) });
    }, 0);
  }
  send() {}
  close() {}
}

const connection: UiConnectionRuntime = {
  instanceId: "checkpoint-rewind-session",
  runtimeKey: "checkpoint-rewind-session:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "session", id: SESSION_ID }),
  push(view) {
    if (view.name === "session") document.body.dataset.navigated = view.id;
  },
  listen: () => () => {},
};

const client = {
  ...api,
  session: () => new Promise<never>(() => {}),
  getSessionEventPage: () => new Promise<never>(() => {}),
  getSessionEventTailPage: (_id: string, _before: number | undefined, eventEpoch: number) =>
    Promise.resolve({ events, eventEpoch, nextBefore: 0, hasMoreOlder: false, cacheComplete: true }),
  prompt: async (_id: string, text: string) => {
    document.body.dataset.prompted = text;
    return undefined as never;
  },
  rewind: async (_id: string, turn: number) => {
    document.body.dataset.rewound = String(turn);
  },
  fork: async (_id: string, turn: number) => {
    document.body.dataset.forked = String(turn);
    if (forkMode === "hold") return new Promise<never>(() => {});
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (forkMode === "ambiguous") throw new ApiError("The control plane did not answer in time.", 504);
    return { ...session, id: "checkpoint-rewind-fork", title: "Tidy the Session Notice Slot (Fork)" };
  },
  recoverQuarantinedConversation: async () => new Promise<never>(() => {}),
} as unknown as ApiClient;

function EventSeeder() {
  const ready = useStoreSelector((state) => state.sessions.has(SESSION_ID));
  const { dispatch } = useStoreActions();
  React.useEffect(() => {
    if (!ready) return;
    for (const event of events) dispatch({ type: "msg", msg: { type: "session_event", event } });
  }, [dispatch, ready]);
  return null;
}

const rightPanel = {
  open: false,
  mode: "launcher" as const,
  width: 360,
  dragging: false,
  subagentTarget: null,
  toggle() {}, openMode() {}, show() {}, setMode() {}, setWidth() {},
  setDragging() {}, close() {}, selectSubagent() {}, showSubagent() {},
  consumeSubagentFocusRequest() {},
};

export function CheckpointRewindSession() {
  return (
    <ApiProvider client={client}>
      <StoreProvider connection={connection} navigation={navigation}>
        <FeedbackProvider>
          <EventSeeder />
          <div id="frame" style={{ height: "100vh", width: "100vw", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <SessionDetail
              sessionId={SESSION_ID}
              mode="expanded"
              rightPanel={rightPanel}
              onOpenTerminal={() => {}}
              composerDraftLoader={async () => draftText ? { text: draftText, images: [], updatedAt: 1 } : null}
            />
          </div>
        </FeedbackProvider>
      </StoreProvider>
    </ApiProvider>
  );
}
