import React from "react";
import { createRoot } from "react-dom/client";
import {
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  type ControlPlaneToUi,
  type ProviderAuthenticationAccountOption,
  type RunnerView,
  type SessionEvent,
  type SessionView,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { SessionDetail } from "../components/SessionDetail.js";
import type { RightPanelState } from "../components/RightPanel.js";
import type { RightPanelMode } from "../right-panel.js";
import "../styles.css";

/** Real-browser SessionDetail with a Claude Code Authentication Required card (#1649).
 * `?scenario=email` (default) reports a provider email, `no-email` reports none, `older` is a
 * pre-v180 runner, `readonly` is a viewer who cannot manage the Machine, and `refused` makes the
 * runner refuse the chosen account as signed out. `?theme=light|dark`, `?width=`, `?height=`. */
const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "email";
const frameWidth = Number(params.get("width") ?? "1100");
const frameHeight = Number(params.get("height") ?? "760");
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

declare global {
  interface Window {
    __WOLLIPOG_AUTH_RECOVERY_E2E__: { selections(): unknown[]; identityRequests(): number };
  }
}

const SESSION_ID = "auth-recovery-e2e-session";
const STARTED = Date.now() - 4 * 60_000;
const CARD = "provider-auth:recovery-e2e";
const selections: unknown[] = [];
let identityRequests = 0;
window.__WOLLIPOG_AUTH_RECOVERY_E2E__ = {
  selections: () => [...selections],
  identityRequests: () => identityRequests,
};

const runner = {
  runnerId: "runner-1",
  hostname: "studio-mac",
  os: "macos",
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
  canManage: scenario !== "readonly",
  protocolVersion: scenario === "older"
    ? RUNNER_CAPABILITY_MIN_PROTOCOL.providerAuthenticationAccountRecovery - 1
    : RUNNER_CAPABILITY_MIN_PROTOCOL.providerAuthenticationAccountRecovery,
  providerAccounts: [
    { id: "claude-work", label: "Work Subscription", provider: "claude", authStatus: "authenticated" },
    { id: "claude-personal", label: "Personal Max", provider: "claude", authStatus: "authenticated" },
    { id: "claude-team", label: "Team Pilot", provider: "claude", authStatus: "unauthenticated" },
    { id: "claude-lab", label: "Lab Sandbox", provider: "claude", authStatus: "unknown" },
  ],
  providerLogins: [],
} as unknown as RunnerView;

const reason = "Provider account identity mismatch: email differed. Account values are redacted.";
const pendingApproval = {
  kind: "authentication" as const,
  requestId: CARD,
  title: "Authentication Required — Claude Code",
  options: [
    {
      optionId: "auth:accept-current",
      name: "Use Current Account",
      description: "Explicitly accept the current authenticated state for this session only.",
      kind: "allow_once",
    },
    {
      optionId: "auth:revalidate",
      name: "Recheck Authentication",
      description: "Ask the provider in this exact context whether authentication is now valid.",
      kind: "allow_once",
    },
    {
      optionId: "auth:dismiss",
      name: "Dismiss Recovery",
      description: "Discard any retained prompt and make the session promptable without retrying provider work.",
      kind: "reject_once",
    },
  ],
  context: { toolName: "Claude Code", input: `Provider: Claude Code\n${reason}` },
};

const session = {
  id: SESSION_ID,
  runnerId: runner.runnerId,
  workspaceId: null,
  workspaceName: null,
  projectId: null,
  agentId: "claude",
  agentName: "Claude Code",
  title: "Refactor Billing Webhooks",
  status: "input_required",
  column: "input_required",
  runId: null,
  useWorktree: false,
  worktreePath: null,
  archived: false,
  createdAt: STARTED,
  updatedAt: STARTED + 60_000,
  lastEventAt: STARTED + 60_000,
  messageCount: 2,
  eventEpoch: 0,
  preview: null,
  pendingApproval,
  driver: "claude-code",
  model: "claude-opus",
  effort: null,
  permissionMode: null,
  tokensIn: 4200,
  tokensOut: 1337,
  costUsd: 0.42,
  adopted: false,
  providerAccountId: "claude-work",
  providerAccountLabel: "Work Subscription",
} as unknown as SessionView;

const events: SessionEvent[] = [
  { kind: "user_message", text: "Move the billing webhooks onto the new queue.", images: [] },
  { kind: "permission_request", requestId: CARD, title: pendingApproval.title, options: pendingApproval.options,
    purpose: "authentication", context: pendingApproval.context },
].map((payload, index) => ({
  id: index + 1,
  sessionId: SESSION_ID,
  seq: index + 1,
  ts: STARTED + index * 60_000,
  payload: payload as SessionEvent["payload"],
}));

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
  instanceId: "auth-recovery-e2e",
  runtimeKey: "auth-recovery-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "session", id: SESSION_ID }),
  push() {},
  listen: () => () => {},
};

const accountOptions: ProviderAuthenticationAccountOption[] = runner.providerAccounts!.map((account) => ({
  id: account.id,
  label: account.label,
  authStatus: account.authStatus,
  availability: account.id === session.providerAccountId
    ? "current"
    : account.authStatus === "authenticated"
    ? "available"
    : account.authStatus === "unauthenticated" ? "sign_in_required" : "status_unknown",
}));

const client = {
  ...api,
  getSessionEventPage: () => new Promise<never>(() => {}),
  getSessionEventTailPage: (_id: string, _before: number | undefined, eventEpoch: number) =>
    Promise.resolve({ events, eventEpoch, nextBefore: 0, hasMoreOlder: false, cacheComplete: true }),
  authenticationCurrentIdentity: async (_id: string, requestId: string) => {
    if (requestId !== CARD) throw new ApiError("this Authentication Required card is no longer current", 409);
    identityRequests += 1;
    return {
      identity: {
        status: "authenticated" as const,
        emailSupported: true,
        email: scenario === "no-email" ? null : "morgan.lee@example.com",
        observedAt: new Date(2026, 8, 23, 16, 42).getTime(),
      },
    };
  },
  authenticationAccounts: async () => ({ accounts: accountOptions }),
  selectAuthenticationAccount: async (
    _id: string,
    input: { requestId: string; providerAccountId: string; expectedProviderAccountId: string },
  ) => {
    selections.push(input);
    if (scenario === "refused") {
      throw new ApiError(
        "The provider reports that this account is signed out. Sign in to it, then choose it again.",
        409,
        "sign_in_required",
      );
    }
    return { accepted: true as const };
  },
  startProviderLogin: async () => ({}) as never,
} as unknown as ApiClient;

function Fixture() {
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<RightPanelMode>("launcher");
  const [width, setWidth] = React.useState(440);
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
        pinnedOpen={false}
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
