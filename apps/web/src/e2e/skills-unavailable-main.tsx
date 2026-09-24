import React from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type ControlPlaneToUi,
  type RunnerView,
  type SessionView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { SessionDetail } from "../components/SessionDetail.js";
import "../styles.css";

/** Real-browser SessionDetail harness for #1695: `?target=host|container|cloud` picks the session's
 * execution target, and the Machine always has two skills assigned to the session's agent. */
const params = new URLSearchParams(window.location.search);
const adapter = params.get("target") === "host" ? "host" as const
  : params.get("target") === "cloud" ? "cloud" as const : "container" as const;
const frameHeight = Number(params.get("height") ?? "600");
const frameWidth = Number(params.get("width") ?? "900");

const SESSION_ID = "skills-unavailable-e2e-session";

const runner = {
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{ id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", available: true }],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: PROTOCOL_VERSION,
} as RunnerView;

const session = {
  id: SESSION_ID,
  runnerId: runner.runnerId,
  workspaceId: null,
  workspaceName: null,
  projectId: null,
  agentId: "claude",
  agentName: "Claude Code",
  title: `Skills on a ${adapter === "host" ? "Host" : adapter === "cloud" ? "Cloud" : "Container"} Target`,
  status: "idle",
  column: "review",
  runId: null,
  useWorktree: true,
  worktreePath: "/tmp/skills-unavailable-e2e",
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  lastEventAt: null,
  messageCount: 0,
  eventEpoch: 0,
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
  executionTarget: {
    id: adapter,
    runnerId: runner.runnerId,
    kind: adapter === "host" ? "local" : adapter,
    workspaceStrategy: "worktree",
    adapter,
    boundaries: adapter === "host"
      ? { filesystem: "worktree", network: "inherit", secrets: "runner_local", billing: "agent_account" }
      : { filesystem: adapter, network: "deny", secrets: "none", billing: "none" },
  },
} as SessionView;

const snapshotMessage = {
  type: "snapshot",
  capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
  runners: [runner],
  boxes: [],
  projects: [],
  sessions: [session],
  runs: [],
  pods: [],
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
      this.onmessage?.({ data: JSON.stringify(snapshotMessage) });
    }, 0);
  }
  send() {}
  close() {}
}

const connection: UiConnectionRuntime = {
  instanceId: "skills-unavailable-e2e",
  runtimeKey: "skills-unavailable-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "session", id: SESSION_ID }),
  push() {},
  listen: () => () => {},
};

let runnerSkillsRequests = 0;
const client = {
  ...api,
  session: () => new Promise<never>(() => {}),
  getSessionEventPage: () => new Promise<never>(() => {}),
  getSessionEventTailPage: (_id: string, _before: number | undefined, eventEpoch: number) =>
    Promise.resolve({ events: [], eventEpoch, nextBefore: 0, hasMoreOlder: false, cacheComplete: true }),
  runnerSkills: async () => {
    runnerSkillsRequests += 1;
    document.body.dataset.runnerSkillsRequests = String(runnerSkillsRequests);
    return {
      desired: [
        { name: "review-pr", versionDigest: "a".repeat(64), targets: [{ agentId: "claude", invocation: "agent" }] },
        { name: "release-notes", versionDigest: "b".repeat(64), targets: [{ agentId: "claude", invocation: "manual" }] },
      ],
      reported: null,
    };
  },
} as unknown as ApiClient;

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
      <div
        id="frame"
        style={{ height: frameHeight, width: frameWidth, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <SessionDetail
          sessionId={SESSION_ID}
          mode="expanded"
          rightPanel={rightPanel}
          onOpenTerminal={() => {}}
          pinnedOpen={false}
          composerDraftLoader={async () => null}
        />
      </div>
    </StoreProvider>
  </ApiProvider>,
);
