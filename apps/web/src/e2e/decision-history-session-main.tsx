import React from "react";
import { createRoot } from "react-dom/client";
import {
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  type ControlPlaneToUi,
  type GovernanceAuditEntry,
  type RunnerView,
  type SessionEvent,
  type SessionView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { SessionDetail } from "../components/SessionDetail.js";
import type { RightPanelState } from "../components/RightPanel.js";
import type { RightPanelMode } from "../right-panel.js";
import "../styles.css";

/** Real-browser SessionDetail whose Decision History lists a permission the person allowed early in
 * a long transcript (#2213), so Show in Transcript has to scroll the transcript to its row.
 * `?theme=light|dark`, `?width=`, `?height=`. */
const params = new URLSearchParams(window.location.search);
const frameWidth = Number(params.get("width") ?? "1280");
const frameHeight = Number(params.get("height") ?? "760");
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

const SESSION_ID = "decision-history-session-e2e";
const STARTED = Date.now() - 60 * 60_000;
const REQUEST = "perm-early-deploy";

const runner = {
  runnerId: "runner-1",
  hostname: "studio-mac",
  os: "macos",
  version: "1",
  status: "online",
  agents: [{ id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", available: true }],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  canManage: true,
  protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.providerAuthenticationAccountRecovery,
  providerAccounts: [],
  providerLogins: [],
} as unknown as RunnerView;

const session = {
  id: SESSION_ID,
  runnerId: runner.runnerId,
  workspaceId: null,
  workspaceName: null,
  projectId: null,
  agentId: "claude",
  agentName: "Claude Code",
  title: "Ship the Billing Webhook Queue",
  status: "idle",
  column: "idle",
  runId: null,
  useWorktree: false,
  worktreePath: null,
  archived: false,
  createdAt: STARTED,
  updatedAt: STARTED + 50 * 60_000,
  lastEventAt: STARTED + 50 * 60_000,
  messageCount: 40,
  eventEpoch: 0,
  preview: null,
  pendingApproval: null,
  driver: "claude-code",
  model: "claude-opus",
  effort: null,
  permissionMode: null,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  adopted: false,
} as unknown as SessionView;

const payloads: SessionEvent["payload"][] = [
  { kind: "user_message", text: "Move the billing webhooks onto the new queue, then deploy.", images: [] },
  {
    kind: "permission_request", requestId: REQUEST, title: "Run ./scripts/deploy.sh staging",
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
    context: { toolName: "Bash", input: "./scripts/deploy.sh staging" },
  },
  { kind: "permission_resolved", requestId: REQUEST, optionId: "allow" },
  ...Array.from({ length: 30 }, (_, index): SessionEvent["payload"] => index % 2
    ? { kind: "user_message", text: `Follow-up ${index}: check the queue metrics again.`, images: [] }
    : { kind: "agent_message", text: `Step ${index}: the webhook queue drained ${index * 7} jobs.\n\nEverything is still healthy.` }),
] as SessionEvent["payload"][];

const events: SessionEvent[] = payloads.map((payload, index) => ({
  id: index + 1,
  sessionId: SESSION_ID,
  seq: index + 1,
  ts: STARTED + index * 60_000,
  payload,
}));

const audit: GovernanceAuditEntry[] = [{
  auditId: "audit-early-deploy",
  requestId: REQUEST,
  approvalKind: "permission",
  stage: "resolution",
  outcome: "allowed",
  actor: { kind: "human", id: "local" },
  scope: { sessionId: SESSION_ID, runnerId: runner.runnerId, toolName: "Bash" },
  optionId: "allow",
  timestamp: STARTED + 2 * 60_000,
}];

const snapshotMessage: ControlPlaneToUi = {
  type: "snapshot",
  capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
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
  instanceId: "decision-history-session-e2e",
  runtimeKey: "decision-history-session-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "session", id: SESSION_ID }),
  push() {},
  listen: () => () => {},
};

const client = {
  ...api,
  getSessionEventPage: () => new Promise<never>(() => {}),
  getSessionEventTailPage: (_id: string, _before: number | undefined, eventEpoch: number) =>
    Promise.resolve({ events, eventEpoch, nextBefore: 0, hasMoreOlder: false, cacheComplete: true }),
  governanceAudit: async () => ({ entries: audit, hasMore: false }),
} as unknown as ApiClient;

function Fixture() {
  const [open, setOpen] = React.useState(true);
  const [mode, setMode] = React.useState<RightPanelMode>("decisions");
  const [width, setWidth] = React.useState(420);
  const [expanded, setExpanded] = React.useState(params.get("expanded") === "1");
  const rightPanel: RightPanelState = {
    open,
    mode,
    width,
    dragging: false,
    subagentTarget: null,
    toggle: () => setOpen((value) => !value),
    openMode: (next) => {
      setMode(next);
      setOpen((value) => !(value && mode === next));
    },
    show: (next) => { setMode(next); setOpen(true); },
    setMode,
    setWidth: (update) => setWidth(update),
    expanded,
    setExpanded,
    setDragging: () => {},
    close: () => setOpen(false),
    selectSubagent: () => {},
    showSubagent: () => {},
    consumeSubagentFocusRequest: () => {},
  };
  return (
    <div
      id="frame"
      style={{ height: frameHeight, width: frameWidth, maxWidth: "100vw", display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      <SessionDetail
        sessionId={SESSION_ID}
        mode="expanded"
        rightPanel={rightPanel}
        onOpenTerminal={() => {}}
        composerDraftLoader={async () => null}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <StoreProvider connection={connection} navigation={navigation}>
      <Fixture />
    </StoreProvider>
  </ApiProvider>,
);
